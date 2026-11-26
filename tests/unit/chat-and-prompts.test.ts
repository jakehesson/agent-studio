import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { initBoardFile, registerProject } from "../../src/board/index.js";
import { runHookEmit } from "../../src/cli/commands/hook-emit.js";
import { dispatchToolCall } from "../../src/mcp/server.js";
import {
  AgentChatResponseSchema,
  PendingHumanPromptSchema,
} from "../../src/schema/telemetry.js";
import { createStudioServer } from "../../src/server/index.js";
import {
  AntigravityAdapter,
  CHAT_FIELD_MAX_BYTES,
  ClaudeCodeAdapter,
  CopilotVSCodeAdapter,
  TelemetryAggregator,
  buildSessionSnapshot,
  type EnrichedEvent,
} from "../../src/telemetry/index.js";

describe("S1-66: Pending Human Prompts, Per-Agent Chat Transcripts, /api/chat & app_get_chat", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "av-chat-prompts-"));
    origHome = process.env.AGENT_STUDIO_HOME;
    process.env.AGENT_STUDIO_HOME = path.join(tmpDir, "studio-home");
  });

  afterEach(async () => {
    if (origHome === undefined) {
      delete process.env.AGENT_STUDIO_HOME;
    } else {
      process.env.AGENT_STUDIO_HOME = origHome;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("Antigravity: parses ask_question (single + multi-select + Recommended), notify_user BlockedOnUser, and full chat incl. pre-tool content & subagent chat", async () => {
    const brainDir = path.join(tmpDir, "brain");
    const rootCid = "11111111-aaaa-bbbb-cccc-111111111111";
    const childCid = "22222222-aaaa-bbbb-cccc-222222222222";

    const mkLog = async (cid: string, rows: unknown[]): Promise<void> => {
      const p = path.join(
        brainDir,
        cid,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(
        p,
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf8",
      );
    };

    const bigOutput = "L".repeat(2000);
    await mkLog(rootCid, [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-26T10:00:00Z",
        content: "Active Workspaces:\n- c:/Projects/ChatApp\nImplement chat drawer",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-26T10:00:02Z",
        thinking: "I should read the schema first and delegate backend work.",
        content: "Reading schema and delegating backend tasks.",
        tool_calls: [
          {
            name: "view_file",
            args: { AbsolutePath: '"c:/Projects/ChatApp/src/schema.ts"' },
          },
          {
            name: "invoke_subagent",
            args: {
              TypeName: '"backend-engineer"',
              Role: '"Backend Engineer"',
              Prompt: '"Build /api/chat endpoint"',
            },
          },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-26T10:00:03Z",
        content: bigOutput,
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-26T10:00:04Z",
        content: `Created the following subagent: {"conversationId": "${childCid}"}`,
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-26T10:00:10Z",
        content: "I have two questions before continuing.",
        tool_calls: [
          {
            name: "ask_question",
            args: {
              questions: JSON.stringify([
                {
                  question: "Which transport should we prefer?",
                  options: ["SSE (Recommended)", "WebSocket", "Long polling"],
                  is_multi_select: false,
                },
                {
                  question: "Which IDEs should be enabled?",
                  options: ["Antigravity", "Claude Code", "VS Code Copilot"],
                  is_multi_select: true,
                },
              ]),
            },
          },
        ],
      },
    ]);

    await mkLog(childCid, [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-26T10:00:05Z",
        content: `[Message] sender=${rootCid} content=Build /api/chat endpoint`,
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-26T10:00:07Z",
        thinking: "Checking http-server.ts routes.",
        content: "Adding /api/chat handler.",
        tool_calls: [
          {
            name: "send_message",
            args: {
              Recipient: `"${rootCid}"`,
              Message: '"API route implemented."',
            },
          },
        ],
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-26T10:00:08Z",
        content: "Backend complete.",
      },
    ]);

    const adapter = new AntigravityAdapter({ brainDir });
    const discovered = await adapter.discoverSessions();
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.waitingOn, "user");
    assert.equal(discovered[0]?.pendingQuestionCount, 2);
    assert.ok(discovered[0]?.waitingSummary?.includes("Which transport"));

    const events = await adapter.parseSession(discovered[0]!);
    const snap = buildSessionSnapshot(events, {
      sessionId: rootCid,
      ide: "antigravity",
      nowEpochSec: Date.parse("2026-11-26T10:00:15Z") / 1000,
    });

    assert.equal(snap.status, "WAITING");
    assert.equal(snap.waitingOn, "user");
    assert.equal(snap.pendingPrompts?.length, 1);
    const rootNode = snap.agents.find((a) => a.id === "root");
    const prompt = rootNode?.pendingPrompt;
    assert.ok(prompt);
    PendingHumanPromptSchema.parse(prompt);
    assert.equal(prompt.kind, "question");
    assert.equal(prompt.blockingToolCall, true);
    assert.equal(prompt.questions.length, 2);
    assert.equal(prompt.questions[0]?.type, "single_select");
    assert.equal(prompt.questions[0]?.allowCustomInput, true);
    assert.deepEqual(prompt.questions[0]?.options, [
      { label: "SSE", recommended: true },
      { label: "WebSocket" },
      { label: "Long polling" },
    ]);
    assert.equal(prompt.questions[1]?.type, "multi_select");
    assert.deepEqual(prompt.options, [
      { label: "SSE", recommended: true },
      { label: "WebSocket" },
      { label: "Long polling" },
    ]);

    // Verify full chat extraction for root without inflating snapshot.events
    const rootChat = await adapter.parseChat(discovered[0]!, { agentId: "root" });
    assert.equal(rootChat.some((m) => m.role === "user"), true);
    const preToolAst = rootChat.find(
      (m) =>
        m.role === "assistant" &&
        m.text.includes("Reading schema and delegating backend tasks."),
    );
    assert.ok(preToolAst, "captures PLANNER_RESPONSE.content even when tool_calls.length > 0");
    assert.ok(preToolAst.thinking?.includes("read the schema first"));
    assert.equal(preToolAst.tools?.length, 1);
    assert.equal(preToolAst.tools?.[0]?.toolName, "view_file");
    assert.equal(preToolAst.tools?.[0]?.status, "ok");
    assert.equal(preToolAst.tools?.[0]?.output, bigOutput);
    assert.ok(
      rootChat.some(
        (m) => m.role === "subagent" && m.subagentId === "backend-engineer",
      ),
    );
    const qMsg = rootChat.find((m) => m.role === "question");
    assert.ok(qMsg);
    assert.equal(qMsg.pendingPromptId, prompt.id);

    // Subagent chat
    const subChat = await adapter.parseChat(discovered[0]!, {
      agentId: "backend-engineer",
    });
    assert.ok(subChat.some((m) => m.text.includes("Build /api/chat endpoint")));
    assert.ok(
      subChat.some(
        (m) =>
          m.role === "assistant" &&
          m.text.includes("Adding /api/chat handler.") &&
          m.thinking?.includes("http-server.ts"),
      ),
    );
    assert.ok(subChat.some((m) => m.role === "subagent" && m.text.includes("API route implemented")));

    // notify_user with BlockedOnUser: "true" -> waitingReason: "user" + single text question
    const notifyCid = "33333333-aaaa-bbbb-cccc-333333333333";
    await mkLog(notifyCid, [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-26T10:05:00Z",
        content: "Review plan",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-26T10:05:02Z",
        tool_calls: [
          {
            name: "notify_user",
            args: {
              Message: '"Please approve the implementation plan in plan.md."',
              BlockedOnUser: '"true"',
            },
          },
        ],
      },
    ]);
    const notifySessions = await adapter.discoverSessions();
    const notifyDisc = notifySessions.find((s) => s.sessionId === notifyCid)!;
    assert.equal(notifyDisc.waitingOn, "user");
    assert.equal(notifyDisc.pendingQuestionCount, 1);
    const notifySnap = buildSessionSnapshot(await adapter.parseSession(notifyDisc), {
      sessionId: notifyCid,
      ide: "antigravity",
      nowEpochSec: Date.parse("2026-11-26T10:05:05Z") / 1000,
    });
    assert.equal(notifySnap.status, "WAITING");
    assert.equal(notifySnap.waitingOn, "user");
    const nPrompt = notifySnap.agents.find((a) => a.id === "root")?.pendingPrompt;
    assert.ok(nPrompt);
    assert.equal(nPrompt.kind, "question");
    assert.equal(nPrompt.blockingToolCall, true);
    assert.equal(nPrompt.questions[0]?.type, "text");
    assert.match(nPrompt.questions[0]?.question ?? "", /approve the implementation plan/i);
  });

  it("Claude Code: AskUserQuestion normalization, hook-emit PreToolUse fix, and full chat extraction", async () => {
    const claudeDir = path.join(tmpDir, "claude-projects");
    const projFolder = path.join(claudeDir, "C--Projects-DemoApp");
    const sessId = "cccc1111-2222-3333-4444-555566667777";
    await fs.mkdir(path.join(projFolder, sessId, "subagents"), { recursive: true });

    const mainRows = [
      {
        type: "user",
        uuid: "u1",
        sessionId: sessId,
        cwd: "C:\\Projects\\DemoApp",
        timestamp: "2026-11-26T11:00:00Z",
        message: { role: "user", content: "Inspect auth and ask about token TTL" },
      },
      {
        type: "assistant",
        uuid: "a1",
        sessionId: sessId,
        timestamp: "2026-11-26T11:00:01Z",
        message: {
          id: "msg_1",
          role: "assistant",
          stop_reason: null,
          content: [{ type: "thinking", thinking: "Need to inspect auth.ts first" }],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        sessionId: sessId,
        timestamp: "2026-11-26T11:00:02Z",
        message: {
          id: "msg_1",
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "Checking auth.ts and spawning reviewer." },
            {
              type: "tool_use",
              id: "tu_read",
              name: "Read",
              input: { file_path: "src/auth.ts" },
            },
            {
              type: "tool_use",
              id: "tu_agent",
              name: "Agent",
              input: {
                subagent_type: "reviewer",
                name: "Code Reviewer",
                prompt: "Audit token TTL",
              },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u2",
        sessionId: sessId,
        timestamp: "2026-11-26T11:00:05Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_read",
              content: [{ type: "text", text: "export const TTL = 3600;" }],
            },
            {
              type: "tool_result",
              tool_use_id: "tu_agent",
              content: "Verified TTL usage.",
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a3",
        sessionId: sessId,
        timestamp: "2026-11-26T11:00:06Z",
        message: {
          id: "msg_2",
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "tu_ask",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    header: "Token TTL",
                    question: "Which session TTL should we configure?",
                    multiSelect: false,
                    options: [
                      { label: "1 hour", description: "Default security posture" },
                      { label: "24 hours", description: "Longer convenience" },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    ];
    await fs.writeFile(
      path.join(projFolder, `${sessId}.jsonl`),
      mainRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const subRows = [
      {
        type: "user",
        uuid: "su0",
        sessionId: sessId,
        timestamp: "2026-11-26T11:00:03Z",
        message: { role: "user", content: "Audit token TTL" },
      },
      {
        type: "assistant",
        uuid: "sa1",
        sessionId: sessId,
        timestamp: "2026-11-26T11:00:04Z",
        message: {
          id: "smsg_1",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "TTL is currently 3600s." }],
        },
      },
    ];
    await fs.writeFile(
      path.join(projFolder, sessId, "subagents", "agent-rev1.jsonl"),
      subRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const adapter = new ClaudeCodeAdapter({ projectsDir: claudeDir });
    const discovered = await adapter.discoverSessions();
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.waitingOn, "user");
    assert.equal(discovered[0]?.pendingQuestionCount, 1);
    assert.equal(discovered[0]?.waitingSummary, "Token TTL");

    const snap = buildSessionSnapshot(await adapter.parseSession(discovered[0]!), {
      sessionId: sessId,
      ide: "claude-code",
      nowEpochSec: Date.parse("2026-11-26T11:00:08Z") / 1000,
    });
    const prompt = snap.agents.find((a) => a.id === "root")?.pendingPrompt;
    assert.ok(prompt);
    assert.equal(prompt.title, "Token TTL");
    assert.equal(prompt.questions[0]?.type, "single_select");
    assert.equal(prompt.questions[0]?.allowCustomInput, true);
    assert.equal(prompt.questions[0]?.options[0]?.description, "Default security posture");

    const rootChat = await adapter.parseChat(discovered[0]!, { agentId: "root" });
    const astMsg = rootChat.find(
      (m) =>
        m.role === "assistant" &&
        m.text.includes("Checking auth.ts and spawning reviewer."),
    );
    assert.ok(astMsg, "captures pre-tool assistant text blocks");
    assert.ok(astMsg.thinking?.includes("inspect auth.ts first"));
    assert.equal(astMsg.tools?.[0]?.toolName, "Read");
    assert.equal(astMsg.tools?.[0]?.status, "ok");
    assert.equal(astMsg.tools?.[0]?.output, "export const TTL = 3600;");
    assert.ok(rootChat.some((m) => m.role === "subagent" && m.subagentId === "agent-rev1"));
    assert.ok(rootChat.some((m) => m.role === "question" && m.pendingPromptId === prompt.id));

    const subChat = await adapter.parseChat(discovered[0]!, { agentId: "agent-rev1" });
    assert.ok(subChat.some((m) => m.role === "user" && m.text.includes("Audit token TTL")));
    assert.ok(subChat.some((m) => m.role === "assistant" && m.text.includes("3600s")));

    // hook-emit PreToolUse fix for AskUserQuestion / ask_question / vscode_askQuestions / ask_questions
    const hookDir = path.join(tmpDir, "hook-proj");
    await fs.mkdir(hookDir, { recursive: true });
    for (const toolName of [
      "AskUserQuestion",
      "ask_question",
      "vscode_askQuestions",
      "ask_questions",
    ]) {
      const hookRes = await runHookEmit(
        ["--ide", "claude-code", "--event", "PreToolUse", "--cwd", hookDir],
        {
          stdinText: JSON.stringify({
            session_id: `hook-${toolName}`,
            tool_name: toolName,
            tool_use_id: `call-${toolName}`,
            tool_input: {
              questions: [
                {
                  question: `Confirm ${toolName}?`,
                  options: [{ label: "Yes" }, { label: "No" }],
                },
              ],
            },
          }),
          fetchImpl: (async () => {
            throw new Error("offline");
          }) as typeof fetch,
        },
      );
      assert.equal(hookRes.event?.kind, "tool_start");
      assert.equal(hookRes.event?.waitingReason, "user");
      const hookSnap = buildSessionSnapshot([hookRes.event!], {
        sessionId: `hook-${toolName}`,
        ide: "claude-code",
      });
      assert.equal(hookSnap.status, "WAITING");
      assert.equal(hookSnap.waitingOn, "user");
      assert.equal(
        hookSnap.pendingPrompts?.[0]?.questions[0]?.question,
        `Confirm ${toolName}?`,
      );
    }
  });

  it("VS Code Copilot: questionCarousel open vs suppressed, vscode_askQuestions merge, approval kind, events.jsonl ask_questions, and chat extraction", async () => {
    const storageDir = path.join(tmpDir, "vscode-storage");
    const wsHash = path.join(storageDir, "ws1");
    const chatDir = path.join(wsHash, "chatSessions");
    const transcriptsDir = path.join(wsHash, "GitHub.copilot-chat", "transcripts");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.writeFile(
      path.join(wsHash, "workspace.json"),
      JSON.stringify({ folder: "file:///c%3A/Projects/VscChat" }),
      "utf8",
    );

    const baseMs = Date.parse("2026-11-26T12:00:00Z");

    // 1. Open vscode_askQuestions + merged questionCarousel
    const mergedSession = {
      sessionId: "vsc-merged-open",
      creationDate: baseMs,
      requests: [
        {
          requestId: "r1",
          timestamp: baseMs,
          message: { text: "Configure database in [](file:///c%3A/Projects/VscChat/db.ts)" },
          response: [
            { kind: "thinking", value: "Checking DB options" },
            { kind: "markdownContent", value: "Please pick a database engine." },
            {
              kind: "toolInvocationSerialized",
              toolId: "vscode_askQuestions",
              toolCallId: "ask-1",
              isComplete: false,
              invocationMessage: "Ask DB choice",
            },
            {
              kind: "questionCarousel",
              toolCallId: "ask-1",
              questions: [
                {
                  id: "q-db",
                  title: "Database",
                  message: "Which DB engine?",
                  type: "singleSelect",
                  allowFreeformInput: true,
                  options: [
                    { id: "pg", label: "Postgres (Recommended)", value: "postgres" },
                    { id: "sq", label: "SQLite", value: "sqlite" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    await fs.writeFile(
      path.join(chatDir, "vsc-merged-open.json"),
      JSON.stringify(mergedSession),
      "utf8",
    );

    // 2. Answered/suppressed questionCarousel variants (isUsed, data, preceded by complete ask, followed by response/completedAt)
    const suppressedSession = {
      sessionId: "vsc-suppressed",
      creationDate: baseMs + 10_000,
      requests: [
        {
          requestId: "rs1",
          timestamp: baseMs + 10_000,
          message: { text: "Run migration" },
          response: [
            {
              kind: "toolInvocationSerialized",
              toolId: "vscode_askQuestions",
              toolCallId: "ask-done",
              isComplete: true,
              pastTenseMessage: "Answered",
            },
            {
              kind: "questionCarousel",
              isUsed: true,
              data: { q1: "yes" },
              questions: [{ message: "Proceed?", type: "singleSelect", options: [{ label: "Yes" }] }],
            },
            {
              kind: "questionCarousel",
              questions: [{ message: "Trailing response follows", type: "text" }],
            },
            {
              kind: "markdownContent",
              value: "Migration completed.",
            },
          ],
          modelState: { value: 1, completedAt: baseMs + 15_000 },
        },
      ],
    };
    await fs.writeFile(
      path.join(chatDir, "vsc-suppressed.json"),
      JSON.stringify(suppressedSession),
      "utf8",
    );

    // 3. Approval pending (toolInvocationSerialized isComplete:false && isConfirmed:false)
    const approvalSession = {
      sessionId: "vsc-approval",
      creationDate: baseMs + 20_000,
      requests: [
        {
          requestId: "ra1",
          timestamp: baseMs + 20_000,
          message: { text: "Deploy build" },
          response: [
            {
              kind: "toolInvocationSerialized",
              toolId: "run_in_terminal",
              toolCallId: "term-approve-1",
              isComplete: false,
              isConfirmed: false,
              invocationMessage: "Run npm run deploy?",
            },
          ],
        },
      ],
    };
    await fs.writeFile(
      path.join(chatDir, "vsc-approval.json"),
      JSON.stringify(approvalSession),
      "utf8",
    );

    // 4. transcripts/events.jsonl with ask_questions + tool.execution_complete
    const trEventsPath = path.join(transcriptsDir, "tr-ask.jsonl");
    const trRows = [
      {
        type: "session.start",
        timestamp: "2026-11-26T12:01:00Z",
        data: { sessionId: "vsc-tr-ask" },
      },
      {
        type: "user.message",
        timestamp: "2026-11-26T12:01:01Z",
        data: { content: "Check [](file:///c%3A/Projects/VscChat/index.ts)" },
      },
      {
        type: "assistant.message",
        timestamp: "2026-11-26T12:01:02Z",
        data: {
          reasoningText: "Need user confirmation",
          content: "Asking confirmation now.",
          toolRequests: [
            {
              toolCallId: "tr-ask-1",
              name: "ask_questions",
              arguments: {
                questions: [
                  {
                    question: "Overwrite config.json?",
                    type: "singleSelect",
                    options: [{ label: "Overwrite" }, { label: "Keep" }],
                  },
                ],
              },
            },
          ],
        },
      },
    ];
    await fs.writeFile(
      trEventsPath,
      trRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir });
    const discovered = await adapter.discoverSessions();

    const dMerged = discovered.find((s) => s.sessionId === "vsc-merged-open")!;
    assert.equal(dMerged.waitingOn, "user");
    assert.equal(dMerged.pendingQuestionCount, 1);

    const dSuppressed = discovered.find((s) => s.sessionId === "vsc-suppressed")!;
    assert.equal(dSuppressed.waitingOn, null);
    assert.equal(dSuppressed.pendingQuestionCount, 0);

    const dApproval = discovered.find((s) => s.sessionId === "vsc-approval")!;
    assert.equal(dApproval.waitingOn, "tool_approval");
    assert.equal(dApproval.pendingQuestionCount, 1);

    const dTrAsk = discovered.find((s) => s.sessionId === "vsc-tr-ask")!;
    assert.equal(dTrAsk.waitingOn, "user");

    // Verify merged prompt
    const mergedSnap = buildSessionSnapshot(await adapter.parseSession(dMerged), {
      sessionId: "vsc-merged-open",
      ide: "copilot-vscode",
      nowEpochSec: (baseMs + 3000) / 1000,
    });
    assert.equal(mergedSnap.status, "WAITING");
    assert.equal(mergedSnap.pendingPrompts?.length, 1);
    const mergedPrompt = mergedSnap.pendingPrompts![0]!;
    assert.equal(mergedPrompt.toolCallId, "ask-1");
    assert.equal(mergedPrompt.questions[0]?.question, "Which DB engine?");
    assert.equal(mergedPrompt.questions[0]?.type, "single_select");
    assert.equal(mergedPrompt.questions[0]?.allowCustomInput, true);
    assert.deepEqual(mergedPrompt.questions[0]?.options[0], {
      id: "pg",
      label: "Postgres",
      recommended: true,
    });

    // Verify suppressed snapshot stays DONE with 0 pendingPrompts
    const supSnap = buildSessionSnapshot(await adapter.parseSession(dSuppressed), {
      sessionId: "vsc-suppressed",
      ide: "copilot-vscode",
      nowEpochSec: (baseMs + 16_000) / 1000,
    });
    assert.equal(supSnap.status, "DONE");
    assert.equal(supSnap.waitingOn, null);
    assert.equal(supSnap.pendingPrompts?.length ?? 0, 0);

    // Verify approval snapshot
    const appSnap = buildSessionSnapshot(await adapter.parseSession(dApproval), {
      sessionId: "vsc-approval",
      ide: "copilot-vscode",
      nowEpochSec: (baseMs + 22_000) / 1000,
    });
    assert.equal(appSnap.status, "WAITING");
    assert.equal(appSnap.waitingOn, "tool_approval");
    assert.equal(appSnap.pendingPrompts?.[0]?.kind, "approval");

    // Verify chat extraction on merged session ([](file:///...) basename extraction)
    const mergedChat = await adapter.parseChat(dMerged, { agentId: "root" });
    assert.ok(mergedChat[0]?.text.includes("[db.ts]("));
    assert.equal(mergedChat.filter((m) => m.role === "question").length, 1);
    assert.equal(
      mergedChat.find((m) => m.role === "question")?.pendingPromptId,
      mergedPrompt.id,
    );

    // Verify events.jsonl ask_questions clears on tool.execution_complete
    const trOpenSnap = buildSessionSnapshot(await adapter.parseSession(dTrAsk), {
      sessionId: "vsc-tr-ask",
      ide: "copilot-vscode",
      nowEpochSec: Date.parse("2026-11-26T12:01:05Z") / 1000,
    });
    assert.equal(trOpenSnap.status, "WAITING");
    assert.equal(trOpenSnap.pendingPrompts?.[0]?.questions[0]?.question, "Overwrite config.json?");

    await fs.appendFile(
      trEventsPath,
      JSON.stringify({
        type: "tool.execution_complete",
        timestamp: "2026-11-26T12:01:10Z",
        data: { toolCallId: "tr-ask-1", toolName: "ask_questions", success: true },
      }) + "\n",
      "utf8",
    );
    const trClosedSnap = buildSessionSnapshot(await adapter.parseSession(dTrAsk), {
      sessionId: "vsc-tr-ask",
      ide: "copilot-vscode",
      nowEpochSec: Date.parse("2026-11-26T12:01:11Z") / 1000,
    });
    assert.equal(trClosedSnap.waitingOn, null);
    assert.equal(trClosedSnap.pendingPrompts?.length ?? 0, 0);

    // Root guard on parseTranscriptChat
    const outsidePath = path.join(tmpDir, "outside-secret.jsonl");
    await fs.writeFile(outsidePath, JSON.stringify({ type: "user.message", data: { content: "secret" } }) + "\n", "utf8");
    const blocked = await adapter.parseTranscriptChat(outsidePath, "vsc-tr-ask");
    assert.deepEqual(blocked, []);
  });

  it("Normalizer: pendingPrompt open/clear lifecycle across root & subagents and mismatch tool_end safety", () => {
    const t0 = 1_795_100_000;
    const mk = (partial: Partial<EnrichedEvent> & Pick<EnrichedEvent, "id" | "agentId" | "kind" | "epoch" | "summary">): EnrichedEvent => ({
      ts: new Date(partial.epoch * 1000).toISOString(),
      ide: "antigravity",
      channel: "passive",
      sessionId: "norm-sess",
      ...partial,
    });

    // Root opens prompt ask-r, unrelated tool_end tool-other must NOT clear ask-r; subagent opens ask-s
    const snap1 = buildSessionSnapshot(
      [
        mk({ id: "e1", agentId: "root", kind: "tool_start", toolName: "read_file", toolCallId: "t-other", epoch: t0, summary: "Read a.ts" }),
        mk({
          id: "e2",
          agentId: "root",
          kind: "tool_start",
          toolName: "ask_question",
          toolCallId: "ask-r",
          epoch: t0 + 1,
          summary: "Root question",
          waitingReason: "user",
          payload: {
            questions: [{ question: "Root Q?", type: "single_select", options: [{ label: "A", recommended: true }] }],
          },
        }),
        mk({ id: "e3", agentId: "root", kind: "tool_end", toolName: "read_file", toolCallId: "t-other", epoch: t0 + 2, summary: "Done read" }),
        mk({
          id: "e4",
          agentId: "backend",
          parentAgentId: "root",
          kind: "tool_start",
          toolName: "ask_question",
          toolCallId: "ask-s",
          epoch: t0 + 3,
          summary: "Sub question",
          waitingReason: "user",
          payload: { args: { question: "Sub Q?" } },
        }),
      ],
      { sessionId: "norm-sess", ide: "antigravity", nowEpochSec: t0 + 5 },
    );
    assert.equal(snap1.pendingPrompts?.length, 2);
    assert.equal(snap1.agents.find((a) => a.id === "root")?.pendingPrompt?.toolCallId, "ask-r");
    assert.deepEqual(snap1.agents.find((a) => a.id === "root")?.pendingPrompt?.options, [
      { label: "A", recommended: true },
    ]);
    assert.equal(snap1.agents.find((a) => a.id === "backend")?.pendingPrompt?.toolCallId, "ask-s");

    // Self-daemon tool_start must NOT clear root pendingPrompt; matching tool_end clears root; subagent_done clears backend
    const snap2 = buildSessionSnapshot(
      [
        mk({
          id: "e2",
          agentId: "root",
          kind: "tool_start",
          toolName: "ask_question",
          toolCallId: "ask-r",
          epoch: t0 + 1,
          summary: "Root question",
          waitingReason: "user",
        }),
        mk({
          id: "e2b",
          agentId: "root",
          kind: "tool_start",
          toolName: "run_command",
          toolCallId: "daemon-1",
          epoch: t0 + 2,
          summary: "agent-studio serve",
          isSelfDaemon: true,
        }),
        mk({
          id: "e4",
          agentId: "backend",
          parentAgentId: "root",
          kind: "tool_start",
          toolName: "ask_question",
          toolCallId: "ask-s",
          epoch: t0 + 3,
          summary: "Sub question",
          waitingReason: "user",
        }),
        mk({ id: "e5", agentId: "root", kind: "tool_end", toolName: "ask_question", toolCallId: "ask-r", epoch: t0 + 4, summary: "Answered" }),
        mk({ id: "e6", agentId: "backend", parentAgentId: "root", kind: "subagent_done", targetAgentId: "backend", epoch: t0 + 5, summary: "Done" }),
      ],
      { sessionId: "norm-sess", ide: "antigravity", nowEpochSec: t0 + 6 },
    );
    assert.equal(snap2.pendingPrompts?.length, 0);
    assert.equal(snap2.agents.find((a) => a.id === "root")?.pendingPrompt, null);
    assert.equal(snap2.agents.find((a) => a.id === "backend")?.pendingPrompt, null);
  });

  it("HTTP /api/chat, /api/sessions/:id/chat pagination, scoping security, 128 KB cap, PushBus synthesis, and MCP app_get_chat", async () => {
    const projDir = path.join(tmpDir, "demo-proj");
    const otherProjDir = path.join(tmpDir, "other-proj");
    await initBoardFile(path.join(projDir, "pipeline", "board.json"), {
      projectId: "demo-proj",
    });
    await initBoardFile(path.join(otherProjDir, "pipeline", "board.json"), {
      projectId: "other-proj",
    });
    registerProject({ root: projDir, id: "demo-proj", title: "Demo Proj", setDefault: true });
    registerProject({ root: otherProjDir, id: "other-proj", title: "Other Proj" });

    const claudeDir = path.join(tmpDir, "claude-http");
    const folder = path.join(claudeDir, "demo-proj-enc");
    await fs.mkdir(folder, { recursive: true });
    const sessId = "eeee1111-2222-3333-4444-555566667777";
    const hugeText = "Z".repeat(200 * 1024); // > 128 KB
    const rows = [
      {
        type: "user",
        uuid: "u1",
        cwd: projDir,
        timestamp: "2026-11-26T13:00:00Z",
        message: { role: "user", content: "Message 1" },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-11-26T13:00:01Z",
        message: { id: "m1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Message 2" }] },
      },
      {
        type: "user",
        uuid: "u2",
        timestamp: "2026-11-26T13:00:02Z",
        message: { role: "user", content: "Message 3" },
      },
      {
        type: "assistant",
        uuid: "a2",
        timestamp: "2026-11-26T13:00:03Z",
        message: { id: "m2", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: hugeText }] },
      },
      {
        type: "assistant",
        uuid: "a3",
        timestamp: "2026-11-26T13:00:04Z",
        message: {
          id: "m3",
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "tu_ask_http",
              name: "AskUserQuestion",
              input: { question: "Ship now?" },
            },
          ],
        },
      },
    ];
    await fs.writeFile(
      path.join(folder, `${sessId}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const aggregator = new TelemetryAggregator({
      brainDir: path.join(tmpDir, "empty-brain"),
      claudeDir,
      vscodeDir: path.join(tmpDir, "empty-vsc"),
      extraWorkspaces: [projDir, otherProjDir],
      includeGlobalTelemetryFile: false,
    });

    // Also ingest a PushBus-only session
    aggregator.ingest([
      {
        sessionId: "push-only-1",
        ide: "mcp",
        workspacePath: projDir,
        projectId: "demo-proj",
        agentId: "root",
        kind: "user_input",
        summary: "Human: Push question",
        payload: { body: "Push question full body" },
        epoch: 1_795_200_000,
      },
      {
        sessionId: "push-only-1",
        ide: "mcp",
        workspacePath: projDir,
        projectId: "demo-proj",
        agentId: "root",
        kind: "assistant_turn_end",
        summary: "Push answer",
        payload: { body: "Push answer full body" },
        epoch: 1_795_200_005,
      },
    ]);

    const srv = createStudioServer({
      aggregator,
      webDir: path.join(tmpDir, "empty-web"),
      extraWorkspaces: [projDir, otherProjDir],
      includeGlobalTelemetryFile: false,
    });
    const { port } = await srv.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;

    try {
      // /api/sessions carries waitingOn & pendingQuestionCount & waitingSummary
      const listResp = await fetch(`${base}/api/sessions?workspace=${encodeURIComponent(projDir)}`);
      assert.equal(listResp.status, 200);
      const listData = (await listResp.json()) as {
        sessions: Array<{
          sessionId: string;
          waitingOn?: string | null;
          pendingQuestionCount?: number;
          waitingSummary?: string;
        }>;
      };
      const claudeEntry = listData.sessions.find((s) => s.sessionId === sessId);
      assert.equal(claudeEntry?.waitingOn, "user");
      assert.equal(claudeEntry?.pendingQuestionCount, 1);
      assert.equal(claudeEntry?.waitingSummary, "Ship now?");

      // Paginated GET /api/chat (limit=2)
      const p1Resp = await fetch(
        `${base}/api/chat?session=${sessId}&workspace=${encodeURIComponent(projDir)}&limit=2`,
      );
      assert.equal(p1Resp.status, 200);
      const p1 = AgentChatResponseSchema.parse(await p1Resp.json());
      assert.equal(p1.totalMessages, 5);
      assert.equal(p1.messages.length, 2);
      assert.equal(p1.hasMore, true);
      assert.ok(p1.nextCursor);
      assert.equal(p1.pendingPrompt?.questions[0]?.question, "Ship now?");
      // Verify 128 KB field cap on message 4 (index 3, first item of page 1)
      assert.ok(Buffer.byteLength(p1.messages[0]!.text, "utf8") <= CHAT_FIELD_MAX_BYTES);

      // Next page using before=nextCursor
      const p2Resp = await fetch(
        `${base}/api/sessions/${sessId}/chat?workspace=${encodeURIComponent(projDir)}&limit=2&before=${encodeURIComponent(p1.nextCursor!)}`,
      );
      assert.equal(p2Resp.status, 200);
      const p2 = AgentChatResponseSchema.parse(await p2Resp.json());
      assert.equal(p2.messages.length, 2);
      assert.equal(p2.messages[0]?.text, "Message 2");
      assert.equal(p2.hasMore, true);

      // Scoping enforcement: requesting demo-proj session under otherProjDir must 404
      const outOfScopeResp = await fetch(
        `${base}/api/chat?session=${sessId}&workspace=${encodeURIComponent(otherProjDir)}`,
      );
      assert.equal(outOfScopeResp.status, 404);
      const outJson = (await outOfScopeResp.json()) as { ok: boolean; error: string };
      assert.equal(outJson.ok, false);
      assert.equal(outJson.error, "Session not found");

      // Path traversal attempt on /api/sessions/:id/chat
      const travResp = await fetch(`${base}/api/sessions/..%2F..%2Fetc%2Fpasswd/chat`);
      assert.equal(travResp.status, 404);

      // PushBus fallback synthesis via HTTP
      const pushResp = await fetch(
        `${base}/api/chat?session=push-only-1&workspace=${encodeURIComponent(projDir)}`,
      );
      assert.equal(pushResp.status, 200);
      const pushChat = AgentChatResponseSchema.parse(await pushResp.json());
      assert.equal(pushChat.messages.length, 2);
      assert.equal(pushChat.messages[0]?.role, "user");
      assert.equal(pushChat.messages[0]?.text, "Push question full body");
      assert.equal(pushChat.messages[1]?.role, "assistant");
      assert.equal(pushChat.messages[1]?.text, "Push answer full body");

      // MCP app_get_chat tool
      const mcpRes = await dispatchToolCall(
        "app_get_chat",
        { session: sessId, agent: "root", workspace: projDir, limit: 3 },
        { aggregator, cwd: projDir },
      );
      assert.notEqual(mcpRes.isError, true);
      const mcpStructured = AgentChatResponseSchema.parse(mcpRes.structuredContent);
      assert.equal(mcpStructured.messages.length, 3);
      assert.equal(mcpStructured.pendingPrompt?.questions[0]?.question, "Ship now?");

      const mcpOutOfScope = await dispatchToolCall(
        "app_get_chat",
        { session: sessId, workspace: otherProjDir },
        { aggregator, cwd: otherProjDir },
      );
      assert.equal(mcpOutOfScope.isError, true);
      assert.equal(mcpOutOfScope.structuredContent?.error, "Session not found");
    } finally {
      await srv.close();
    }
  });

  it("Review fixes: per-agent PushBus waiting & status clear, canceled Copilot approval, Copilot child transcript aliases & ask_questions dedup, Antigravity ask_question prune, Claude streaming dedup & tool_result tailStatus", async () => {
    // 1. PushBus per-agent waiting isolation + clearing stale status: "WAITING" on passive session
    const claudeDir = path.join(tmpDir, "claude-rev");
    const claudeProj = path.join(claudeDir, "rev-proj");
    await fs.mkdir(claudeProj, { recursive: true });
    const claudeSid = "rev-claude-1";
    const claudeFile = path.join(claudeProj, `${claudeSid}.jsonl`);
    await fs.writeFile(
      claudeFile,
      [
        {
          type: "user",
          uuid: "u1",
          cwd: tmpDir,
          timestamp: "2026-11-26T14:00:00Z",
          message: { role: "user", content: "Deploy?" },
        },
        {
          type: "assistant",
          uuid: "a1",
          timestamp: "2026-11-26T14:00:01Z",
          message: {
            id: "m1",
            role: "assistant",
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "ask-cc-1",
                name: "AskUserQuestion",
                input: { question: "Proceed with deploy?" },
              },
            ],
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    const agg = new TelemetryAggregator({
      brainDir: path.join(tmpDir, "no-brain"),
      claudeDir,
      vscodeDir: path.join(tmpDir, "no-vsc"),
      includeGlobalTelemetryFile: false,
    });

    // Subagent emits tool_start and subagent_done while root is waiting via PushBus
    const baseSec = Date.now() / 1000 + 10;
    agg.ingest([
      {
        sessionId: claudeSid,
        ide: "claude-code",
        agentId: "root",
        kind: "tool_start",
        toolName: "AskUserQuestion",
        toolCallId: "ask-cc-1",
        summary: "Asked user",
        waitingReason: "user",
        epoch: baseSec,
      },
      {
        sessionId: claudeSid,
        ide: "claude-code",
        agentId: "sub-worker",
        parentAgentId: "root",
        kind: "tool_start",
        toolName: "Read",
        toolCallId: "sub-read-1",
        summary: "Read file",
        epoch: baseSec + 1,
      },
      {
        sessionId: claudeSid,
        ide: "claude-code",
        agentId: "sub-worker",
        parentAgentId: "root",
        kind: "subagent_done",
        targetAgentId: "sub-worker",
        summary: "Worker done",
        epoch: baseSec + 2,
      },
    ]);

    let sessions = await agg.discoverSessions();
    let cs = sessions.find((s) => s.sessionId === claudeSid)!;
    assert.equal(cs.waitingOn, "user", "subagent activity must NOT clear root waitingOn");
    assert.equal(cs.status, "WAITING");

    // Now root's matching tool_end arrives -> clears waitingOn AND stale status: "WAITING"
    agg.ingest([
      {
        sessionId: claudeSid,
        ide: "claude-code",
        agentId: "root",
        kind: "tool_end",
        toolName: "AskUserQuestion",
        toolCallId: "ask-cc-1",
        summary: "Answered",
        epoch: baseSec + 3,
      },
    ]);
    sessions = await agg.discoverSessions();
    cs = sessions.find((s) => s.sessionId === claudeSid)!;
    assert.equal(cs.waitingOn, null);
    assert.equal(cs.isWaiting, false);
    assert.notEqual(cs.status, "WAITING", "clearing waiting via PushBus must also clear status=WAITING");

    // 2. Claude Code: streaming chunk dedup & tool_result clearing discovery tailStatus
    await fs.writeFile(
      claudeFile,
      [
        {
          type: "user",
          uuid: "u1",
          cwd: tmpDir,
          timestamp: "2026-11-26T14:00:00Z",
          message: { role: "user", content: "Check files" },
        },
        {
          type: "assistant",
          uuid: "a1a",
          timestamp: "2026-11-26T14:00:01Z",
          message: {
            id: "stream_msg",
            role: "assistant",
            stop_reason: null,
            content: [
              { type: "thinking", thinking: "Step 1" },
              { type: "text", text: "Checking" },
            ],
          },
        },
        {
          type: "assistant",
          uuid: "a1b",
          timestamp: "2026-11-26T14:00:02Z",
          message: {
            id: "stream_msg",
            role: "assistant",
            stop_reason: "tool_use",
            content: [
              { type: "thinking", thinking: "Step 1" },
              { type: "text", text: "Checking config.ts now." },
              { type: "tool_use", id: "ask-cc-2", name: "AskUserQuestion", input: { question: "Keep?" } },
            ],
          },
        },
        {
          type: "user",
          uuid: "u2",
          timestamp: "2026-11-26T14:00:04Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "ask-cc-2", content: "Yes" }],
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );
    const claudeAdapter = new ClaudeCodeAdapter({ projectsDir: claudeDir });
    const ccDisc = await claudeAdapter.discoverSessions();
    assert.equal(ccDisc[0]?.waitingOn, null);
    assert.notEqual(ccDisc[0]?.status, "WAITING", "tool_result answering AskUserQuestion clears tailStatus");
    const ccChat = await claudeAdapter.parseChat(ccDisc[0]!, { agentId: "root" });
    const streamAst = ccChat.find((m) => m.role === "assistant");
    assert.equal(streamAst?.thinking, "Step 1", "identical streaming thinking chunks deduplicated");
    assert.equal(streamAst?.text, "Checking config.ts now.", "prefix snapshot streaming text deduplicated");

    // 3. Copilot: canceled toolInvocationSerialized approval + child transcript slug/alias matching + ask_questions dedup + completed ask/carousel merge
    const storageDir = path.join(tmpDir, "vsc-rev");
    const wsHash = path.join(storageDir, "ws-rev");
    const chatDir = path.join(wsHash, "chatSessions");
    const transcriptsDir = path.join(wsHash, "GitHub.copilot-chat", "transcripts");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.writeFile(
      path.join(wsHash, "workspace.json"),
      JSON.stringify({ folder: "file:///c%3A/Projects/RevApp" }),
      "utf8",
    );
    const nowMs = Date.now();
    await fs.writeFile(
      path.join(chatDir, "vsc-canceled.json"),
      JSON.stringify({
        sessionId: "vsc-canceled",
        creationDate: nowMs,
        requests: [
          {
            requestId: "rc1",
            timestamp: nowMs,
            isCanceled: true,
            message: { text: "Run build" },
            response: [
              {
                kind: "toolInvocationSerialized",
                toolId: "run_in_terminal",
                toolCallId: "tc-canceled",
                isComplete: false,
                isConfirmed: false,
                invocationMessage: "Run build?",
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(chatDir, "vsc-child-chat.json"),
      JSON.stringify({
        sessionId: "vsc-child-chat",
        creationDate: nowMs + 1000,
        requests: [
          {
            requestId: "rcc1",
            timestamp: nowMs + 1000,
            message: { text: "Delegate to QA" },
            response: [
              {
                kind: "toolInvocationSerialized",
                toolId: "agent/runSubagent",
                toolCallId: "sub-call-1",
                isComplete: true,
                toolSpecificData: { agentName: "QA Reviewer" },
              },
              {
                kind: "toolInvocationSerialized",
                toolId: "vscode_askQuestions",
                toolCallId: "ask-complete-1",
                isComplete: true,
                pastTenseMessage: "Answered",
              },
              {
                kind: "questionCarousel",
                toolCallId: "ask-complete-1",
                isUsed: true,
                questions: [{ message: "Ship?", type: "singleSelect", options: [{ label: "Yes" }] }],
              },
            ],
            modelState: { value: 1, completedAt: nowMs + 5000 },
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(transcriptsDir, "child-uuid-99.jsonl"),
      [
        {
          type: "session.start",
          timestamp: "2026-11-26T14:05:00Z",
          data: {
            sessionId: "child-uuid-99",
            parentSessionId: "vsc-child-chat",
            agentName: "QA Reviewer",
          },
        },
        {
          type: "user.message",
          timestamp: "2026-11-26T14:05:01Z",
          data: { content: "Verify endpoints" },
        },
        {
          type: "assistant.message",
          timestamp: "2026-11-26T14:05:02Z",
          data: {
            content: "Asking confirmation.",
            toolRequests: [
              {
                toolCallId: "ask-tr-dup",
                name: "ask_questions",
                arguments: { questions: [{ question: "Proceed?" }] },
              },
            ],
          },
        },
        {
          type: "tool.execution_start",
          timestamp: "2026-11-26T14:05:03Z",
          data: {
            toolCallId: "ask-tr-dup",
            toolName: "ask_questions",
            arguments: { questions: [{ question: "Proceed?" }] },
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    const vscAgg = new TelemetryAggregator({
      brainDir: path.join(tmpDir, "no-brain"),
      claudeDir: path.join(tmpDir, "no-claude"),
      vscodeDir: storageDir,
      includeGlobalTelemetryFile: false,
    });
    // Simulate hook subagent reconciliation onto UUID hId = "hook-sub-uuid-1"
    vscAgg.ingest([
      {
        sessionId: "vsc-child-chat",
        ide: "copilot-vscode",
        agentId: "root",
        targetAgentId: "hook-sub-uuid-1",
        kind: "subagent_spawn",
        toolName: "Agent",
        epoch: (nowMs + 1500) / 1000,
        summary: "Spawned QA Reviewer",
        payload: { agentLabel: "QA Reviewer" },
      },
      {
        sessionId: "vsc-child-chat",
        ide: "copilot-vscode",
        agentId: "hook-sub-uuid-1",
        parentAgentId: "root",
        kind: "subagent_done",
        targetAgentId: "hook-sub-uuid-1",
        summary: "Done",
        epoch: (nowMs + 4000) / 1000,
        payload: { agentLabel: "QA Reviewer" },
      },
    ]);

    const vscCanceledSnap = (await vscAgg.getSessionSnapshot("vsc-canceled")).snapshot;
    assert.notEqual(vscCanceledSnap.status, "WAITING", "canceled approval request must NOT stay WAITING");
    assert.equal(vscCanceledSnap.pendingPrompts?.length ?? 0, 0);

    const vscRootChat = await vscAgg.getAgentChat({
      sessionId: "vsc-child-chat",
      agentId: "root",
    });
    assert.equal(
      vscRootChat?.messages.filter((m) => m.role === "question").length,
      1,
      "completed vscode_askQuestions + questionCarousel should merge without duplicate question messages",
    );

    const vscSubChat = await vscAgg.getAgentChat({
      sessionId: "vsc-child-chat",
      agentId: "hook-sub-uuid-1",
    });
    assert.ok(vscSubChat);
    assert.ok(
      vscSubChat.messages.some((m) => m.text.includes("Verify endpoints")),
      "reconciled hook subagent ID must resolve slugified Copilot child transcript via aliases",
    );
    assert.equal(
      vscSubChat.messages.filter((m) => m.role === "question").length,
      1,
      "assistant.message + tool.execution_start for same ask_questions toolCallId must not duplicate",
    );

    // 4. Antigravity: pruneStaleNotify prunes ask_question symmetrically so later run_command's GENERIC closes run_command, not ask_question
    const agyBrain = path.join(tmpDir, "agy-prune-brain");
    const agyCid = "44444444-aaaa-bbbb-cccc-444444444444";
    const agyPath = path.join(agyBrain, agyCid, ".system_generated", "logs", "transcript.jsonl");
    await fs.mkdir(path.dirname(agyPath), { recursive: true });
    await fs.writeFile(
      agyPath,
      [
        {
          step_index: 0,
          type: "USER_INPUT",
          created_at: "2026-11-26T14:10:00Z",
          content: "Start",
        },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-26T14:10:01Z",
          tool_calls: [
            {
              name: "ask_question",
              args: { questions: [{ question: "Continue?", options: ["Yes"] }] },
            },
          ],
        },
        // No GENERIC row for ask_question; user replied directly with USER_INPUT
        {
          step_index: 2,
          type: "USER_INPUT",
          created_at: "2026-11-26T14:10:05Z",
          content: "Yes, run tests",
        },
        {
          step_index: 3,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-26T14:10:06Z",
          content: "Running tests.",
          tool_calls: [
            { name: "run_command", args: { CommandLine: '"npm test"' } },
          ],
        },
        {
          step_index: 4,
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-26T14:10:08Z",
          content: "All 110 tests passed",
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );
    const agyAdapter = new AntigravityAdapter({ brainDir: agyBrain });
    const [agyDisc] = await agyAdapter.discoverSessions();
    assert.ok(agyDisc);
    const agyEvents = await agyAdapter.parseSession(agyDisc);
    const toolEnd = agyEvents.find((e) => e.kind === "tool_end");
    assert.equal(toolEnd?.toolName, "run_command", "GENERIC must close run_command rather than stale ask_question");
    const agyChat = await agyAdapter.parseChat(agyDisc, { agentId: "root" });
    const cmdAst = agyChat.find((m) => m.role === "assistant" && m.tools?.[0]?.toolName === "run_command");
    assert.equal(cmdAst?.tools?.[0]?.output, "All 110 tests passed");
  });
});
