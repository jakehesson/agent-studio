import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerProject } from "../../src/board/registry.js";
import {
  normalizeHookEventName,
  runHookEmit,
} from "../../src/cli/commands/hook-emit.js";
import { resolveCopilotHomeDir } from "../../src/telemetry/adapters/copilot-vscode.js";
import { MAX_CORRELATION_ENTRIES } from "../../src/telemetry/push-bus.js";
import {
  ACTIVE_DECAY_SEC,
  AntigravityAdapter,
  ClaudeCodeAdapter,
  CopilotVSCodeAdapter,
  MAX_TRANSCRIPT_BYTES,
  PushBus,
  STALE_SESSION_SEC,
  TelemetryAggregator,
  buildSessionSnapshot,
  canonicalDedupToolName,
  classifyExternalTool,
  cleanHumanSummary,
  deduplicateEvents,
  inferContextWindow,
  isBoardMutationToolCall,
  isOpaqueAgentId,
  normalizePendingQuestions,
  prettifyAgentLabel,
  prettifyModelName,
  reconstructVSCodeDeltaJsonl,
  summarizeToolCall,
  validateTranscriptPath,
  type EnrichedEvent,
} from "../../src/telemetry/index.js";

describe("Hybrid Telemetry Adapters, Deduplication, State Machine & hook-emit", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "av-telemetry-test-"));
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

  it("Antigravity fixture: discovers root + multi-instance subagents, unquotes args, excludes self-daemon, resets reportedDone", async () => {
    const brainDir = path.join(tmpDir, "brain");
    const rootCid = "11111111-1111-1111-1111-111111111111";
    const child1Cid = "22222222-2222-2222-2222-222222222222";
    const child2Cid = "33333333-3333-3333-3333-333333333333";

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

    const baseTs = "2026-11-24T20:00:";
    await mkLog(rootCid, [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: `${baseTs}00Z`,
        content: "Active Workspaces:\n- c:/Projects/DemoApp\nBuild feature X",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: `${baseTs}02Z`,
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              TypeName: '"backend-engineer"',
              Role: '"Backend Engineer"',
              Prompt: '"Implement API"',
            },
          },
          {
            name: "invoke_subagent",
            args: {
              TypeName: '"backend-engineer"',
              Role: '"Backend Engineer"',
              Prompt: '"Implement Worker"',
            },
          },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: `${baseTs}03Z`,
        content: `Created the following subagent: {"conversationId": "${child1Cid}"}`,
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: `${baseTs}04Z`,
        content: `Created the following subagent: {"conversationId": "${child2Cid}"}`,
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        created_at: `${baseTs}06Z`,
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: '"node dist/cli/index.js serve --port 8767"',
              IsDaemon: "true",
            },
          },
        ],
      },
      {
        step_index: 5,
        type: "PLANNER_RESPONSE",
        created_at: `${baseTs}10Z`,
        content: "Turn 1 complete.",
      },
      {
        step_index: 6,
        type: "USER_INPUT",
        created_at: `${baseTs}20Z`,
        content: "Now run Turn 2!",
      },
    ]);

    await mkLog(child1Cid, [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        created_at: `${baseTs}05Z`,
        content: "[Message] sender=11111111 content=Implement API",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: `${baseTs}08Z`,
        tool_calls: [
          {
            name: "send_message",
            args: {
              Recipient: `"${rootCid}"`,
              Message: '"Completed API implementation, all checks passed"',
            },
          },
        ],
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: `${baseTs}09Z`,
        content: "Done.",
      },
    ]);

    await mkLog(child2Cid, [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        created_at: `${baseTs}05Z`,
        content: "[Message] sender=11111111 content=Implement Worker",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: `${baseTs}09Z`,
        content: "Worker done.",
      },
    ]);

    const adapter = new AntigravityAdapter({ brainDir });
    const discovered = await adapter.discoverSessions();
    assert.equal(discovered.length, 1, "only top-level root session should be discovered");
    assert.equal(discovered[0]?.sessionId, rootCid);
    assert.equal(discovered[0]?.isMultiAgent, true);

    const events = await adapter.parseSession(discovered[0]!);
    const snap = buildSessionSnapshot(events, {
      sessionId: rootCid,
      ide: "antigravity",
      nowEpochSec: Date.parse(`${baseTs}25Z`) / 1000,
    });

    const agentIds = snap.agents.filter((a) => a.nodeType === "agent").map((a) => a.id);
    assert.ok(agentIds.includes("root"));
    assert.ok(agentIds.includes("backend-engineer"));
    assert.ok(agentIds.includes("backend-engineer-2"), "second same-TypeName instance disambiguated");

    // Self-daemon run_command must NOT hold root in WORKING; Turn 2 USER_INPUT resets reportedDone -> THINKING!
    const rootNode = snap.agents.find((a) => a.id === "root");
    assert.equal(rootNode?.status, "THINKING");
    assert.equal(rootNode?.state, "thinking");

    // Both children finished cleanly -> DONE
    const child1 = snap.agents.find((a) => a.id === "backend-engineer");
    assert.equal(child1?.status, "DONE");
    const child2 = snap.agents.find((a) => a.id === "backend-engineer-2");
    assert.equal(child2?.status, "DONE");

    // Monotonic numeric epoch on all activity items
    for (let i = 1; i < snap.activity.length; i++) {
      assert.ok(
        snap.activity[i]!.epoch > snap.activity[i - 1]!.epoch,
        "activity epochs must be strictly monotonic",
      );
    }
  });

  it("Claude Code fixture: skips auxiliary rows, maps tools/Agent/AskUserQuestion/subagents, and completes turn", async () => {
    const claudeDir = path.join(tmpDir, "claude-projects");
    const projFolder = path.join(claudeDir, "C--Projects-DemoApp");
    const sessId = "aaaa1111-2222-3333-4444-555566667777";
    await fs.mkdir(path.join(projFolder, sessId, "subagents"), { recursive: true });

    const mainRows = [
      { type: "cost-state", timestamp: "2026-11-24T20:10:00Z", totalCostUSD: 0.01 },
      { type: "api-request-blob", timestamp: "2026-11-24T20:10:00Z" },
      {
        type: "user",
        uuid: "u1",
        sessionId: sessId,
        cwd: "C:\\Projects\\DemoApp",
        timestamp: "2026-11-24T20:10:01Z",
        message: { role: "user", content: "Refactor auth service" },
      },
      {
        type: "assistant",
        uuid: "a1",
        sessionId: sessId,
        timestamp: "2026-11-24T20:10:02Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me delegate to backend" },
            {
              type: "tool_use",
              id: "tu_agent_1",
              name: "Agent",
              input: { subagent_type: "backend", description: "Update auth" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u2",
        sessionId: sessId,
        timestamp: "2026-11-24T20:10:06Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_agent_1", content: "Done!" },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        sessionId: sessId,
        timestamp: "2026-11-24T20:10:07Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_ask_1",
              name: "AskUserQuestion",
              input: { question: "Deploy now?" },
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
        type: "assistant",
        uuid: "sa1",
        sessionId: sessId,
        timestamp: "2026-11-24T20:10:03Z",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_read_1", name: "Read", input: { file_path: "src/auth.ts" } },
          ],
        },
      },
      {
        type: "user",
        uuid: "su1",
        sessionId: sessId,
        timestamp: "2026-11-24T20:10:04Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_read_1", content: "ok" }],
        },
      },
      {
        type: "assistant",
        uuid: "sa2",
        sessionId: sessId,
        timestamp: "2026-11-24T20:10:05Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Auth refactored." }],
        },
      },
    ];
    await fs.writeFile(
      path.join(projFolder, sessId, "subagents", "agent-1.jsonl"),
      subRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const adapter = new ClaudeCodeAdapter({ projectsDir: claudeDir });
    const discovered = await adapter.discoverSessions();
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.workspacePath, "c:/Projects/DemoApp");
    assert.equal(discovered[0]?.isMultiAgent, true);

    const events = await adapter.parseSession(discovered[0]!);
    assert.ok(!events.some((e) => e.summary.includes("cost-state")));
    assert.ok(events.some((e) => e.kind === "subagent_spawn" && e.targetAgentId === "agent-1"));
    assert.ok(events.some((e) => e.kind === "subagent_done"));

    const snap = buildSessionSnapshot(events, {
      sessionId: sessId,
      ide: "claude-code",
      nowEpochSec: Date.parse("2026-11-24T20:10:12Z") / 1000,
    });
    const rootNode = snap.agents.find((a) => a.id === "root");
    assert.equal(rootNode?.status, "WAITING", "unanswered AskUserQuestion puts root in WAITING");
    assert.equal(snap.waitingOn, "user");
    assert.ok(!snap.agents.some((a) => a.id === "backend"), "no orphan backend node");
    const subNode = snap.agents.find((a) => a.id === "agent-1");
    assert.equal(subNode?.status, "DONE");
    assert.equal(subNode?.label, "Update auth");
  });

  it("VS Code Copilot fixtures: parses legacy .json, modern delta .jsonl (kind 0/1/2), questionCarousel, and degraded health", async () => {
    // 1. Degraded health when storage dir does not exist
    const missingAdapter = new CopilotVSCodeAdapter({
      storageDir: path.join(tmpDir, "does-not-exist"),
    });
    const missingHealth = await missingAdapter.getHealth();
    assert.equal(missingHealth.status, "degraded");
    assert.deepEqual(await missingAdapter.discoverSessions(), []);

    // 2. Populated workspaceStorage with both legacy .json and delta .jsonl
    const storageDir = path.join(tmpDir, "vscode-storage");
    const wsHash = path.join(storageDir, "abc123hash");
    const chatDir = path.join(wsHash, "chatSessions");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.writeFile(
      path.join(wsHash, "workspace.json"),
      JSON.stringify({ folder: "file:///c%3A/Projects/DemoApp" }),
      "utf8",
    );

    const baseMs = Date.parse("2026-11-24T20:20:00Z");
    const legacySession = {
      sessionId: "vsc-legacy-1",
      customTitle: "Legacy Copilot Session",
      creationDate: baseMs,
      requests: [
        {
          requestId: "r0",
          timestamp: baseMs,
          message: { text: "Check tests" },
          modeInfo: { modeName: "orchestrator" },
          response: [
            {
              kind: "toolInvocationSerialized",
              toolId: "copilot_readFile",
              toolCallId: "vc-tc-1",
              isComplete: true,
              isConfirmed: true,
              pastTenseMessage: { value: "Read package.json" },
            },
          ],
          modelState: { value: 1, completedAt: baseMs + 4000 },
        },
      ],
    };
    await fs.writeFile(
      path.join(chatDir, "vsc-legacy-1.json"),
      JSON.stringify(legacySession),
      "utf8",
    );

    const deltaLines = [
      {
        kind: 0,
        v: {
          sessionId: "vsc-delta-2",
          creationDate: baseMs + 10_000,
          requests: [
            {
              requestId: "dr0",
              timestamp: baseMs + 10_000,
              message: { text: "Spawn QA & ask user" },
              response: [],
            },
          ],
        },
      },
      { kind: 1, k: ["customTitle"], v: "Delta Copilot Session" },
      {
        kind: 2,
        k: ["requests", 0, "response"],
        v: [
          { kind: "thinking", value: "Planning verification" },
          {
            kind: "toolInvocationSerialized",
            toolId: "agent/runSubagent",
            toolCallId: "vc-sub-1",
            isComplete: true,
            toolSpecificData: { agentName: "qa-validator" },
          },
        ],
      },
      {
        kind: 2,
        k: ["requests", 0, "response"],
        v: [{ kind: "questionCarousel" }],
      },
    ];
    const deltaRaw = deltaLines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const reconstructed = reconstructVSCodeDeltaJsonl(deltaRaw);
    assert.equal(reconstructed.customTitle, "Delta Copilot Session");
    assert.equal(reconstructed.requests?.[0]?.response?.length, 3);

    await fs.writeFile(path.join(chatDir, "vsc-delta-2.jsonl"), deltaRaw, "utf8");

    const adapter = new CopilotVSCodeAdapter({ storageDir });
    const health = await adapter.getHealth();
    assert.equal(health.status, "ok");
    assert.equal(health.sessionsFound, 2);

    const sessions = await adapter.discoverSessions();
    const legacy = sessions.find((s) => s.sessionId === "vsc-legacy-1");
    const delta = sessions.find((s) => s.sessionId === "vsc-delta-2");
    assert.ok(legacy);
    assert.ok(delta);
    assert.equal(legacy.workspacePath, "c:/Projects/DemoApp");
    assert.equal(delta.isMultiAgent, true);

    const legacySnap = buildSessionSnapshot(await adapter.parseSession(legacy), {
      sessionId: legacy.sessionId,
      ide: "copilot-vscode",
      nowEpochSec: (baseMs + 6000) / 1000,
    });
    assert.equal(legacySnap.status, "DONE");

    const deltaSnap = buildSessionSnapshot(await adapter.parseSession(delta), {
      sessionId: delta.sessionId,
      ide: "copilot-vscode",
      nowEpochSec: (baseMs + 12_000) / 1000,
    });
    assert.equal(deltaSnap.status, "WAITING", "questionCarousel transitions session to WAITING");
    assert.equal(deltaSnap.waitingOn, "user");
  });

  it("Tier-1 & Tier-2 cross-channel deduplication + 6-state timer decay (12s/900s/1800s)", () => {
    const baseEpoch = 1_795_000_000;
    const hookEv: EnrichedEvent = {
      id: "aaaa111122223333",
      mergeKey: "t1:sess-d:root:tool_start:call-99",
      ts: new Date(baseEpoch * 1000).toISOString(),
      epoch: baseEpoch,
      ide: "claude-code",
      channel: "hook",
      sessionId: "sess-d",
      agentId: "root",
      kind: "tool_start",
      toolName: "Read",
      toolCallId: "call-99",
      summary: "PreToolUse: Read",
      payload: { hookOnly: true },
    };
    const passiveEv: EnrichedEvent = {
      id: "bbbb444455556666",
      mergeKey: "t1:sess-d:root:tool_start:call-99",
      ts: new Date((baseEpoch + 1.2) * 1000).toISOString(),
      epoch: baseEpoch + 1.2,
      ide: "claude-code",
      channel: "passive",
      sessionId: "sess-d",
      agentId: "root",
      kind: "tool_start",
      toolName: "Read",
      toolCallId: "call-99",
      summary: "Read: src/server/http-server.ts (full passive summary)",
      payload: { passiveRich: true, file: "src/server/http-server.ts" },
    };
    // Tier-2 pair (within 2s bucket, no toolCallId)
    const hookTurnEnd: EnrichedEvent = {
      id: "cccc111122223333",
      ts: new Date((baseEpoch + 5) * 1000).toISOString(),
      epoch: baseEpoch + 5,
      ide: "claude-code",
      channel: "hook",
      sessionId: "sess-d",
      agentId: "root",
      kind: "assistant_turn_end",
      summary: "Stop",
    };
    const passiveTurnEnd: EnrichedEvent = {
      id: "dddd444455556666",
      ts: new Date((baseEpoch + 6) * 1000).toISOString(),
      epoch: baseEpoch + 6,
      ide: "claude-code",
      channel: "passive",
      sessionId: "sess-d",
      agentId: "root",
      kind: "assistant_turn_end",
      summary: "Completed refactoring with zero errors",
    };

    const merged = deduplicateEvents([hookEv, passiveEv, hookTurnEnd, passiveTurnEnd]);
    assert.equal(merged.length, 2, "Tier-1 and Tier-2 pairs should each collapse to 1 event");
    assert.equal(merged[0]?.epoch, baseEpoch, "earliest hook epoch preserved");
    assert.equal(merged[0]?.channel, "passive", "channel upgraded to passive");
    assert.equal(merged[0]?.payload?.hookOnly, true);
    assert.equal(merged[0]?.payload?.passiveRich, true);
    assert.deepEqual(
      [...((merged[0]?.payload?._channels as string[]) ?? [])].sort(),
      ["hook", "passive"],
    );
    assert.equal(merged[1]?.summary, "Completed refactoring with zero errors");

    // Verify ACTIVE_DECAY_SEC (900s) and STALE_SESSION_SEC (1800s) decay on open tool / thinking
    const activeSnap = buildSessionSnapshot([hookEv], {
      sessionId: "sess-d",
      ide: "claude-code",
      nowEpochSec: baseEpoch + 10,
    });
    assert.equal(activeSnap.status, "WORKING");

    const decayedSnap = buildSessionSnapshot([hookEv], {
      sessionId: "sess-d",
      ide: "claude-code",
      nowEpochSec: baseEpoch + ACTIVE_DECAY_SEC + 5,
    });
    assert.equal(decayedSnap.status, "IDLE");

    const staleThinkingSnap = buildSessionSnapshot(
      [
        {
          ...hookEv,
          kind: "thinking_start",
          toolCallId: undefined,
          mergeKey: undefined,
        },
      ],
      {
        sessionId: "sess-d",
        ide: "claude-code",
        nowEpochSec: baseEpoch + STALE_SESSION_SEC + 10,
      },
    );
    assert.equal(staleThinkingSnap.status, "DONE");
  });

  it("hook-emit: falls back to telemetry.jsonl in <200ms offline, and enforces PreToolUse exit-2 guardrails", async () => {
    const wsDir = path.join(tmpDir, "hook-ws");
    await fs.mkdir(path.join(wsDir, ".agent-team"), { recursive: true });
    await fs.writeFile(
      path.join(wsDir, ".agent-team", "team.yaml"),
      [
        "schemaVersion: 1",
        "project:",
        "  id: hook-demo",
        "  title: Hook Demo",
        "targets: [claude-code, copilot-vscode]",
        "workflow:",
        "  boardPath: pipeline/board.json",
        "  enforcement:",
        "    orchestratorReadOnly: true",
        "    qaGateRequired: true",
        "    blockDirectBoardEdits: true",
        "roster:",
        "  - id: orchestrator",
        "    name: Orchestrator",
        "    roleType: orchestrator",
        "    boardRole: orchestrator",
        "    promptFile: agents/orchestrator.md",
      ].join("\n"),
      "utf8",
    );

    const offlineFetch: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED"));

    // 1. Allowed tool event offline -> <200ms, exit 0, writes telemetry.jsonl
    const t0 = performance.now();
    const okRes = await runHookEmit(
      ["--ide", "claude-code", "--event", "PreToolUse", "--port", "59999"],
      {
        stdinText: JSON.stringify({
          session_id: "hook-s1",
          cwd: wsDir,
          tool_name: "Read",
          tool_use_id: "tu-1",
          tool_input: { file_path: "src/index.ts" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const elapsedMs = performance.now() - t0;
    assert.equal(okRes.exitCode, 0);
    assert.equal(okRes.denied, false);
    assert.equal(okRes.deliveredVia, "file");
    assert.ok(elapsedMs < 200, `offline hook-emit took ${elapsedMs.toFixed(1)}ms (>200ms)`);

    // 2. Direct edit to pipeline/board.json -> exit 2 + structured deny JSON
    let denyStdout = "";
    let denyStderr = "";
    const denyBoardRes = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PreToolUse"],
      {
        stdinText: JSON.stringify({
          sessionId: "hook-s1",
          cwd: wsDir,
          toolName: "edit/editFiles",
          toolCallId: "tc-2",
          toolInput: { filePath: path.join(wsDir, "pipeline", "board.json") },
        }),
        stdout: (s) => {
          denyStdout += s;
        },
        stderr: (s) => {
          denyStderr += s;
        },
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(denyBoardRes.exitCode, 2);
    assert.equal(denyBoardRes.denied, true);
    const parsedDeny = JSON.parse(denyStdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    assert.equal(parsedDeny.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(parsedDeny.hookSpecificOutput.permissionDecision, "deny");
    assert.match(parsedDeny.hookSpecificOutput.permissionDecisionReason, /pipeline\/board\.json/);
    assert.match(denyStderr, /guardrail/i);

    // 3. Orchestrator read-only guardrail blocking Bash for claude-code -> exit 0 + permissionDecision: deny JSON
    let ccDenyStdout = "";
    const denyOrchRes = await runHookEmit(
      ["--ide", "claude-code", "--event", "PreToolUse", "--role", "orchestrator"],
      {
        stdinText: JSON.stringify({
          session_id: "hook-s1",
          cwd: wsDir,
          tool_name: "Bash",
          tool_input: { command: "rm -rf build" },
        }),
        stdout: (s) => {
          ccDenyStdout += s;
        },
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(denyOrchRes.exitCode, 0);
    assert.equal(denyOrchRes.denied, true);
    const ccParsedDeny = JSON.parse(ccDenyStdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    assert.equal(ccParsedDeny.hookSpecificOutput.permissionDecision, "deny");

    // 3b. NotebookEdit targeting boardPath or orchestrator is blocked too
    const denyNotebookRes = await runHookEmit(
      ["--ide", "claude-code", "--event", "PreToolUse", "--role", "orchestrator"],
      {
        stdinText: JSON.stringify({
          session_id: "hook-s1",
          cwd: wsDir,
          tool_name: "NotebookEdit",
          tool_input: { file_path: "notebook.ipynb" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(denyNotebookRes.exitCode, 0);
    assert.equal(denyNotebookRes.denied, true);

    // 4. PushBus byte-offset tailer picks up all 4 events from telemetry.jsonl
    const bus = new PushBus({
      extraWorkspaces: [wsDir],
      includeGlobalTelemetryFile: false,
    });
    const polled = await bus.pollFiles();
    assert.equal(polled.accepted, 4);
    const evs = bus.getSessionEvents("hook-s1");
    assert.ok(evs.some((e) => e.status === "denied"));
  });

  it("S1-27 regression: project filter matches Antigravity sessions by registered root, alias, or basename (AgentVisualizer <-> agent-studio)", async () => {
    const projRoot = path.join(tmpDir, "AgentVisualizer");
    const otherRoot = path.join(tmpDir, "OtherRepo");
    await fs.mkdir(projRoot, { recursive: true });
    await fs.mkdir(otherRoot, { recursive: true });

    registerProject({
      id: "agent-studio",
      title: "Agent Studio",
      root: projRoot,
      setDefault: true,
    });

    const brainDir = path.join(tmpDir, "brain-s127");
    const matchCid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const otherCid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const writeTranscript = async (cid: string, rows: unknown[]): Promise<void> => {
      const tpath = path.join(
        brainDir,
        cid,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      await fs.mkdir(path.dirname(tpath), { recursive: true });
      await fs.writeFile(
        tpath,
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf8",
      );
    };

    // Session inside .../AgentVisualizer with JSON-escaped Windows backslashes
    await writeTranscript(matchCid, [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-24T21:00:00Z",
        content: `Active Workspaces:\n- ${projRoot}\nCommand Working Directory: ${projRoot}\nRun tests`,
      },
    ]);
    await writeTranscript(otherCid, [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-24T21:00:00Z",
        content: `Active Workspaces:\n- ${otherRoot}\nOther project work`,
      },
    ]);

    const agg = new TelemetryAggregator({
      brainDir,
      claudeDir: path.join(tmpDir, "no-claude"),
      vscodeDir: path.join(tmpDir, "no-vscode"),
      includeGlobalTelemetryFile: false,
    });

    // Filtering by registered ID ("agent-studio"), title ("Agent Studio"), or basename ("AgentVisualizer")
    for (const projQuery of ["agent-studio", "Agent Studio", "AgentVisualizer", "agent-visualizer"]) {
      const found = await agg.discoverSessions({
        ide: "antigravity",
        project: projQuery,
      });
      assert.equal(
        found.length,
        1,
        `expected 1 session for project=${projQuery}, got ${found.length}`,
      );
      assert.equal(found[0]?.sessionId, matchCid);
      assert.equal(found[0]?.projectId, "agent-studio");
    }

    // Also verify PushBus-only session whose raw projectId is "AgentVisualizer" matches filter "agent-studio"
    agg.ingest([
      {
        id: "push-s127-1",
        ts: "2026-11-24T21:05:00Z",
        ide: "antigravity",
        sessionId: "push-only-av",
        projectId: "AgentVisualizer",
        workspacePath: projRoot,
        agentId: "root",
        kind: "user_input",
        summary: "Push event in AgentVisualizer",
      },
    ]);
    const withPush = await agg.discoverSessions({
      ide: "antigravity",
      project: "agent-studio",
    });
    assert.equal(withPush.length, 2);
    assert.ok(withPush.some((s) => s.sessionId === "push-only-av"));
    assert.ok(!withPush.some((s) => s.sessionId === otherCid));
  });

  it("S1-28: human-readable summaries, MCP board_mutation promotion, routineEnd tagging, and canceled subagent state transition", async () => {
    // 1. cleanHumanSummary strips surrounding quotes, Markdown (** / ` / links), and truncates cleanly on word boundaries
    const cleaned = cleanHumanSummary(
      '"## QA **PASSED** (`TR-016`): [ActivityFeed.ts](file:///d:/ActivityFeed.ts) verified ready for test -> done transition smoothly"',
      60,
    );
    assert.ok(!cleaned.startsWith('"'), "no leading quote");
    assert.ok(!cleaned.includes("**") && !cleaned.includes("`"), "no raw markdown markers");
    assert.ok(!cleaned.includes("file:///"), "markdown link reduced to label");
    assert.ok(cleaned.endsWith("…"), "truncated cleanly with ellipsis");
    assert.ok(!cleaned.endsWith("transi…"), "never mid-word truncation");

    // 2. summarizeToolCall & isBoardMutationToolCall on call_mcp_tool board & testrun calls
    const moveArgs = {
      ToolName: '"board"',
      Arguments: JSON.stringify({
        op: "move",
        id: "S1-26",
        state: "done",
        note: "**QA** passed (`TR-016`)",
      }),
    };
    assert.equal(isBoardMutationToolCall("call_mcp_tool", moveArgs), true);
    assert.equal(
      summarizeToolCall("call_mcp_tool", moveArgs),
      "Moved S1-26 → done — QA passed (TR-016)",
    );

    assert.equal(
      summarizeToolCall("call_mcp_tool", {
        ToolName: '"board"',
        Arguments: JSON.stringify({ op: "add", type: "story", title: "Add UX Engineer role" }),
      }),
      "Added story: Add UX Engineer role",
    );
    assert.equal(
      summarizeToolCall("call_mcp_tool", {
        ToolName: '"board"',
        Arguments: JSON.stringify({ op: "status" }),
      }),
      "Checked sprint board status",
    );
    assert.equal(
      isBoardMutationToolCall("call_mcp_tool", {
        ToolName: '"board"',
        Arguments: JSON.stringify({ op: "status" }),
      }),
      false,
    );
    assert.equal(
      summarizeToolCall("call_mcp_tool", {
        ToolName: '"testrun"',
        Arguments: JSON.stringify({
          op: "record",
          run_id: "TR-016",
          checkpoint: "CP0",
          result: "pass",
        }),
      }),
      "Recorded CP0 PASS on TR-016",
    );
    assert.equal(
      summarizeToolCall("edit_file", { Path: '"/workspace/demo-app/web/src/components/ActivityFeed.ts"' }),
      "Edited ActivityFeed.ts",
    );

    // 3. Antigravity fixture with MCP board_mutation + routineEnd tool_end + canceled browser subagent
    const brainDir = path.join(tmpDir, "brain-s128");
    const rootCid = "44444444-4444-4444-4444-444444444444";
    const browserCid = "55555555-5555-5555-5555-555555555555";

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

    await mkLog(rootCid, [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-24T22:00:00Z",
        content: "Verify board move and cancel browser subagent",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T22:00:02Z",
        tool_calls: [
          {
            name: "call_mcp_tool",
            args: {
              ServerName: '"agent-studio"',
              ToolName: '"board"',
              Arguments: JSON.stringify({ op: "move", id: "S1-26", state: "done" }),
            },
          },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T22:00:03Z",
        content: "S1-26 [done]",
      },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T22:00:04Z",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              TypeName: '"browser-auditor"',
              Role: '"Browser Auditor"',
              Prompt: '"Inspect UI"',
            },
          },
        ],
      },
      {
        step_index: 4,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T22:00:05Z",
        content: `Created the following subagent: {"conversationId": "${browserCid}"}`,
      },
      {
        step_index: 5,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-24T22:00:12Z",
        content: `Subagent "${browserCid}" has been explicitly canceled by the user.`,
      },
    ]);

    // Child subagent has an unclosed running tool call when user cancels it
    await mkLog(browserCid, [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-24T22:00:06Z",
        content: `[Message] sender=${rootCid} content=Inspect UI`,
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T22:00:08Z",
        tool_calls: [
          {
            name: "run_command",
            args: { CommandLine: '"playwright open http://127.0.0.1:8767"' },
          },
        ],
      },
    ]);

    const adapter = new AntigravityAdapter({ brainDir });
    const [sess] = await adapter.discoverSessions();
    assert.ok(sess);
    const events = await adapter.parseSession(sess);

    const boardMut = events.find((e) => e.kind === "board_mutation");
    assert.ok(boardMut, "mutating board MCP call promoted to kind=board_mutation");
    assert.equal(boardMut.summary, "Moved S1-26 → done");

    const boardEnd = events.find(
      (e) => e.kind === "tool_end" && e.toolName === "call_mcp_tool",
    );
    assert.ok(boardEnd);
    assert.equal(boardEnd.summary, "Completed: Moved S1-26 → done");
    assert.equal(boardEnd.payload?.routineEnd, true);
    assert.ok(!events.some((e) => e.summary === "Done: call_mcp_tool"));

    const snap = buildSessionSnapshot(events, {
      sessionId: rootCid,
      ide: "antigravity",
      nowEpochSec: Date.parse("2026-11-24T22:00:15Z") / 1000,
    });
    assert.ok(snap.counters.boardMutations >= 1);

    const browserNode = snap.agents.find((a) => a.id === "browser-auditor");
    assert.ok(browserNode);
    assert.equal(
      browserNode.status,
      "DONE",
      "canceled subagent must transition out of WORKING/THINKING to DONE",
    );
    assert.equal(browserNode.action, "Canceled by user");
  });

  it("BUG-09 regression: spawning 2nd instance of an already-DONE subagent role targets disambiguated slug (browser-2) and keeps 1st instance DONE", async () => {
    const brainDir = path.join(tmpDir, "brain-bug09");
    const rootCid = "66666666-6666-6666-6666-666666666666";
    const firstCid = "77777777-7777-7777-7777-777777777777";
    const secondCid = "88888888-8888-8888-8888-888888888888";

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

    await mkLog(rootCid, [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-24T22:10:00Z",
        content: "Spawn browser audit 1 then browser audit 2",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T22:10:01Z",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              TypeName: '"browser"',
              Role: '"Live UX Visual Verifier"',
              Prompt: '"Audit pass 1"',
            },
          },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T22:10:02Z",
        content: `Created the following subagent: {"conversationId": "${firstCid}"}`,
      },
      // Later (after first browser finished cleanly at 22:10:10), spawn a 2nd browser instance
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T22:10:20Z",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              TypeName: '"browser"',
              Role: '"Live UX Visual Verifier 2"',
              Prompt: '"Audit pass 2"',
            },
          },
        ],
      },
      {
        step_index: 4,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T22:10:21Z",
        content: `Created the following subagent: {"conversationId": "${secondCid}"}`,
      },
      {
        step_index: 5,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-24T22:10:25Z",
        content: `Subagent "${secondCid}" has been explicitly canceled by the user.`,
      },
    ]);

    await mkLog(firstCid, [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-24T22:10:03Z",
        content: `[Message] sender=${rootCid} content=Audit pass 1`,
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T22:10:10Z",
        content: "Audit pass 1 complete.",
      },
    ]);

    await mkLog(secondCid, [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-24T22:10:22Z",
        content: `[Message] sender=${rootCid} content=Audit pass 2`,
      },
    ]);

    const adapter = new AntigravityAdapter({ brainDir });
    const [sess] = await adapter.discoverSessions();
    assert.ok(sess);
    const events = await adapter.parseSession(sess);

    const spawns = events.filter((e) => e.kind === "subagent_spawn");
    assert.equal(spawns.length, 2);
    assert.equal(spawns[0]?.targetAgentId, "browser");
    assert.equal(
      spawns[1]?.targetAgentId,
      "browser-2",
      "2nd spawn event must target disambiguated browser-2 slug",
    );

    const snap = buildSessionSnapshot(events, {
      sessionId: rootCid,
      ide: "antigravity",
      nowEpochSec: Date.parse("2026-11-24T22:10:30Z") / 1000,
    });
    const b1 = snap.agents.find((a) => a.id === "browser");
    const b2 = snap.agents.find((a) => a.id === "browser-2");
    assert.equal(b1?.status, "DONE", "1st browser instance must stay DONE");
    assert.equal(b2?.status, "DONE", "2nd canceled browser instance must be DONE");
  });

  it("S1-34: per-agent token, context window, and model usage telemetry across Antigravity, Claude Code, and VS Code Copilot", async () => {
    // 1. Model prettifier & context window heuristics
    assert.equal(prettifyModelName("flash"), "Gemini Flash");
    assert.equal(prettifyModelName("flash_lite"), "Gemini Flash Lite");
    assert.equal(prettifyModelName("pro"), "Gemini Pro");
    assert.equal(prettifyModelName("copilot/claude-sonnet-4"), "Claude Sonnet 4");
    assert.equal(prettifyModelName("Gemini 4 Neon (High)"), "Gemini 4 Neon (High)");
    assert.equal(prettifyModelName("gemini-4-neon-high"), "Gemini 4 Neon (High)");

    assert.equal(inferContextWindow("Gemini 4 Neon (High)"), 1_000_000);
    assert.equal(inferContextWindow("Claude Sonnet 4.5"), 200_000);
    assert.equal(inferContextWindow("GPT-4.1"), 1_000_000);
    assert.equal(inferContextWindow("GPT-4o"), 128_000);
    assert.equal(inferContextWindow("o3-mini"), 128_000);
    assert.equal(inferContextWindow("Unknown"), 200_000);

    // 2. Antigravity: Model Selection, inherit child, explicit flash child, and estimated token/context accounting
    const brainDir = path.join(tmpDir, "brain-s134");
    const rootCid = "91111111-1111-1111-1111-111111111111";
    const inheritCid = "92222222-2222-2222-2222-222222222222";
    const flashCid = "93333333-3333-3333-3333-333333333333";

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

    await mkLog(rootCid, [
      {
        step_index: 0,
        type: "USER_SETTINGS_CHANGE",
        created_at: "2026-11-24T23:00:00Z",
        content: "User changed Model Selection to Gemini 4 Neon (High).",
      },
      {
        step_index: 1,
        type: "USER_INPUT",
        created_at: "2026-11-24T23:00:01Z",
        content: "A".repeat(400),
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T23:00:02Z",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              TypeName: '"backend-engineer"',
              Role: '"Backend Engineer"',
              Model: '"inherit"',
              Prompt: '"Build usage API"',
            },
          },
          {
            name: "invoke_subagent",
            args: {
              TypeName: '"research"',
              Role: '"Researcher"',
              Model: '"flash"',
              Prompt: '"Scan logs"',
            },
          },
        ],
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T23:00:03Z",
        content: `Created the following subagent: {"conversationId": "${inheritCid}"}`,
      },
      {
        step_index: 4,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-24T23:00:04Z",
        content: `Created the following subagent: {"conversationId": "${flashCid}"}`,
      },
    ]);

    await mkLog(inheritCid, [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-24T23:00:05Z",
        content: "B".repeat(800),
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T23:00:06Z",
        content: "C".repeat(400),
      },
    ]);

    await mkLog(flashCid, [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-24T23:00:05Z",
        content: "D".repeat(200),
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T23:00:06Z",
        content: "E".repeat(200),
      },
    ]);

    const agyAdapter = new AntigravityAdapter({ brainDir });
    const [agySess] = await agyAdapter.discoverSessions();
    assert.ok(agySess);
    const agyEvents = await agyAdapter.parseSession(agySess);
    const agySnap = buildSessionSnapshot(agyEvents, {
      sessionId: rootCid,
      ide: "antigravity",
      nowEpochSec: Date.parse("2026-11-24T23:00:10Z") / 1000,
    });

    const agyRoot = agySnap.agents.find((a) => a.id === "root");
    const agyInherit = agySnap.agents.find((a) => a.id === "backend-engineer");
    const agyFlash = agySnap.agents.find((a) => a.id === "research");

    assert.equal(agyRoot?.model, "Gemini 4 Neon (High)");
    assert.equal(agyRoot?.usage?.modelSource, "exact");
    assert.equal(agyRoot?.usage?.usageSource, "estimated");
    assert.equal(agyRoot?.usage?.contextWindow, 1_000_000);
    assert.ok((agyRoot?.usage?.inputTokens ?? 0) >= 100);
    assert.ok((agyRoot?.usage?.outputTokens ?? 0) > 0);

    assert.equal(agyInherit?.model, "Gemini 4 Neon (High)");
    assert.equal(agyInherit?.usage?.modelSource, "inherited");
    assert.equal(agyInherit?.usage?.inputTokens, 200);
    assert.equal(agyInherit?.usage?.outputTokens, 100);
    assert.equal(agyInherit?.usage?.contextTokens, 300);

    assert.equal(agyFlash?.model, "Gemini Flash");
    assert.equal(agyFlash?.usage?.modelSource, "exact");
    assert.equal(agyFlash?.usage?.inputTokens, 50);
    assert.equal(agyFlash?.usage?.outputTokens, 50);

    assert.ok(agySnap.usage);
    assert.equal(agySnap.usage.usageSource, "estimated");
    assert.equal(agySnap.usage.models.length, 2);
    assert.equal(agySnap.usage.models[0]?.model, "Gemini 4 Neon (High)");
    assert.equal(agySnap.usage.models[0]?.agentCount, 2);
    assert.equal(agySnap.usage.models[1]?.model, "Gemini Flash");
    assert.equal(agySnap.usage.models[1]?.agentCount, 1);

    // 3. Claude Code: exact message.model, message.usage, cache_read_input_tokens, and cost-state
    const claudeDir = path.join(tmpDir, "claude-s134");
    const cFolder = path.join(claudeDir, "C--Projects-Demo");
    const cSessId = "cc111111-2222-3333-4444-555566667777";
    await fs.mkdir(cFolder, { recursive: true });
    await fs.writeFile(
      path.join(cFolder, `${cSessId}.jsonl`),
      [
        {
          type: "user",
          uuid: "cu1",
          sessionId: cSessId,
          cwd: "C:\\Projects\\Demo",
          timestamp: "2026-11-24T23:05:00Z",
          message: { role: "user", content: "Explain usage metrics" },
        },
        {
          type: "assistant",
          uuid: "ca1",
          sessionId: cSessId,
          timestamp: "2026-11-24T23:05:02Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-5",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Done explaining." }],
            usage: {
              input_tokens: 1200,
              output_tokens: 450,
              cache_read_input_tokens: 18000,
              cache_creation_input_tokens: 350,
            },
          },
        },
        {
          type: "cost-state",
          timestamp: "2026-11-24T23:05:03Z",
          totalCostUSD: 0.0425,
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    const claudeAdapter = new ClaudeCodeAdapter({ projectsDir: claudeDir });
    const [cSess] = await claudeAdapter.discoverSessions();
    assert.ok(cSess);
    const cSnap = buildSessionSnapshot(await claudeAdapter.parseSession(cSess), {
      sessionId: cSessId,
      ide: "claude-code",
      nowEpochSec: Date.parse("2026-11-24T23:05:10Z") / 1000,
    });
    const cRoot = cSnap.agents.find((a) => a.id === "root");
    assert.equal(cRoot?.model, "Claude Sonnet 4.5");
    assert.equal(cRoot?.usage?.modelSource, "exact");
    assert.equal(cRoot?.usage?.usageSource, "exact");
    assert.equal(cRoot?.usage?.inputTokens, 1200);
    assert.equal(cRoot?.usage?.outputTokens, 450);
    assert.equal(cRoot?.usage?.cachedTokens, 18350);
    assert.equal(cRoot?.usage?.totalTokens, 20000);
    assert.equal(cRoot?.usage?.contextTokens, 20000);
    assert.equal(cRoot?.usage?.contextWindow, 200_000);
    assert.equal(cRoot?.usage?.contextPercent, 10);
    assert.equal(cRoot?.usage?.costUsd, 0.0425);
    assert.equal(cSnap.usage?.usageSource, "exact");
    assert.equal(cSnap.usage?.peakContextPercent, 10);
    assert.equal(cSnap.usage?.peakContextAgentId, "root");
    assert.equal(cSnap.usage?.costUsd, 0.0425);

    // 4. VS Code Copilot: modelId prettification + exact result.metadata.usage extraction
    const vscDir = path.join(tmpDir, "vscode-s134");
    const wsHash = path.join(vscDir, "ws1");
    await fs.mkdir(path.join(wsHash, "chatSessions"), { recursive: true });
    await fs.writeFile(
      path.join(wsHash, "workspace.json"),
      JSON.stringify({ folder: "file:///c%3A/Projects/Demo" }),
      "utf8",
    );
    const vscMs = Date.parse("2026-11-24T23:10:00Z");
    await fs.writeFile(
      path.join(wsHash, "chatSessions", "vsc-usage-1.json"),
      JSON.stringify({
        sessionId: "vsc-usage-1",
        creationDate: vscMs,
        requests: [
          {
            requestId: "vr1",
            timestamp: vscMs,
            modelId: "copilot/claude-sonnet-4",
            message: { text: "Audit responsive CSS" },
            response: [{ kind: "thinking", value: "Checking styles" }],
            modelState: { value: 1, completedAt: vscMs + 3000 },
            result: {
              metadata: {
                usage: {
                  promptTokens: 6000,
                  completionTokens: 2000,
                },
              },
            },
          },
        ],
      }),
      "utf8",
    );

    const vscAdapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const [vSess] = await vscAdapter.discoverSessions();
    assert.ok(vSess);
    const vSnap = buildSessionSnapshot(await vscAdapter.parseSession(vSess), {
      sessionId: "vsc-usage-1",
      ide: "copilot-vscode",
      nowEpochSec: (vscMs + 5000) / 1000,
    });
    const vRoot = vSnap.agents.find((a) => a.id === "root");
    assert.equal(vRoot?.model, "Claude Sonnet 4");
    assert.equal(vRoot?.usage?.modelSource, "exact");
    assert.equal(vRoot?.usage?.usageSource, "exact");
    assert.equal(vRoot?.usage?.inputTokens, 6000);
    assert.equal(vRoot?.usage?.outputTokens, 2000);
    assert.equal(vRoot?.usage?.contextTokens, 8000);
    assert.equal(vRoot?.usage?.contextPercent, 4);
    assert.equal(vSnap.usage?.totalTokens, 8000);
    assert.equal(vSnap.usage?.models[0]?.model, "Claude Sonnet 4");
    assert.equal(vSnap.usage?.models[0]?.sharePercent, 100);
  });

  it("BUG-16/17 & S1-53: hook-emit actor/target, tool classification, PushBus out-of-order re-homing & transcript paths", async () => {
    const wsDir = path.join(tmpDir, "rehome-ws");
    await fs.mkdir(wsDir, { recursive: true });
    const offlineFetch: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED"));

    // 1. Subagent tool hook arrives BEFORE SubagentStart (out-of-order orphan session)
    const subPre = await runHookEmit(
      ["--ide", "claude-code", "--event", "PreToolUse"],
      {
        stdinText: JSON.stringify({
          session_id: "abc123",
          agent_id: "abc123",
          agent_type: "backend-engineer",
          cwd: wsDir,
          tool_name: "Edit",
          tool_use_id: "tu-sub-1",
          tool_args: { file_path: "src/api.ts" },
          transcript_path: path.join(wsDir, "sub-transcript.jsonl"),
          model: "claude-sonnet-4-5[1m]",
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(subPre.event?.agentId, "agent-abc123");
    assert.equal(subPre.event?.parentAgentId, "root");
    assert.equal(subPre.event?.status, "running");
    assert.equal(subPre.event?.usageDelta?.model, "Claude Sonnet 4.5 [1m]");

    // 2. PostToolUse with tool_response.is_error = true + PostToolUseFailure
    const postErr = await runHookEmit(
      ["--ide", "claude-code", "--event", "PostToolUse"],
      {
        stdinText: JSON.stringify({
          session_id: "parent-s1",
          cwd: wsDir,
          tool_name: "Bash",
          tool_use_id: "tu-p-1",
          tool_response: { is_error: true, content: "exit 1" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(postErr.event?.kind, "tool_end");
    assert.equal(postErr.event?.status, "error");
    assert.equal(postErr.event?.isError, true);

    const postFail = await runHookEmit(
      ["--ide", "claude-code", "--event", "PostToolUseFailure"],
      {
        stdinText: JSON.stringify({
          session_id: "parent-s1",
          cwd: wsDir,
          tool_name: "Bash",
          tool_use_id: "tu-p-2",
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(postFail.event?.kind, "tool_end");
    assert.equal(postFail.event?.status, "error");

    // 3. SessionStart, UserPromptSubmit, PreCompact, and Tier-1 tool classifications
    const sStart = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "SessionStart"],
      {
        stdinText: JSON.stringify({ sessionId: "parent-s1", cwd: wsDir }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(sStart.event?.kind, "session_start");

    const uPrompt = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "UserPromptSubmit"],
      {
        stdinText: JSON.stringify({
          sessionId: "parent-s1",
          cwd: wsDir,
          prompt: "Fix VS Code session jumping",
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(uPrompt.event?.kind, "user_input");
    assert.match(uPrompt.event?.summary ?? "", /Fix VS Code session jumping/);

    const preCompact = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PreCompact"],
      {
        stdinText: JSON.stringify({ sessionId: "parent-s1", cwd: wsDir }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(preCompact.event?.kind, "message");

    const boardPre = await runHookEmit(
      ["--ide", "claude-code", "--event", "PreToolUse"],
      {
        stdinText: JSON.stringify({
          session_id: "parent-s1",
          cwd: wsDir,
          tool_name: "mcp__agent-studio__board",
          tool_use_id: "tu-board-1",
          tool_input: { op: "move", id: "BUG-16", state: "test" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(boardPre.event?.kind, "board_mutation");

    // 4. PushBus ingests orphan first, then SubagentStart re-homes it into parent-s1
    const bus = new PushBus({ includeGlobalTelemetryFile: false });
    bus.ingest([preCompact.event!, uPrompt.event!, subPre.event!]);
    assert.ok(bus.getAllSessionIds().includes("abc123"));

    const subStart = await runHookEmit(
      ["--ide", "claude-code", "--event", "SubagentStart"],
      {
        stdinText: JSON.stringify({
          session_id: "parent-s1",
          agent_id: "abc123",
          agent_type: "Backend Engineer",
          cwd: wsDir,
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(subStart.event?.agentId, "root");
    assert.equal(subStart.event?.targetAgentId, "agent-abc123");
    assert.equal(subStart.event?.kind, "subagent_spawn");

    bus.ingest([subStart.event!]);
    assert.ok(!bus.getAllSessionIds().includes("abc123"), "orphan session must be deleted after re-homing");
    const parentEvs = bus.getSessionEvents("parent-s1");
    assert.ok(
      parentEvs.some((e) => e.agentId === "agent-abc123" && e.parentAgentId === "root"),
      "migrated events must belong to agent-abc123 under parent-s1",
    );
    assert.equal(
      bus.getAgentTranscriptPaths("parent-s1").get("agent-abc123"),
      path.join(wsDir, "sub-transcript.jsonl"),
    );

    // Push-only session title prefers first user_input prompt over PreToolUse
    const discoveredPush = bus.discoverPushSessions();
    assert.equal(discoveredPush[0]?.title, "Fix VS Code session jumping");

    // Subsequent subagent event arrives under subagent session ID -> re-homed immediately
    const subStop = await runHookEmit(
      ["--ide", "claude-code", "--event", "PreToolUse"],
      {
        stdinText: JSON.stringify({
          session_id: "abc123",
          cwd: wsDir,
          tool_name: "Read",
          tool_use_id: "tu-sub-2",
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    bus.ingest([subStop.event!]);
    assert.ok(!bus.getAllSessionIds().includes("abc123"));
    assert.ok(bus.getSessionEvents("parent-s1").some((e) => e.toolCallId === "tu-sub-2" && e.agentId === "agent-abc123"));
  });

  it("Copilot transcripts/*.jsonl, PushBus transcriptPath snapshot enrichment, expanded chatSessions usage & non-monotonic compaction", async () => {
    const vscDir = path.join(tmpDir, "vscode-transcripts");
    const wsHash = path.join(vscDir, "ws1");
    const transcriptsDir = path.join(wsHash, "GitHub.copilot-chat", "transcripts");
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.writeFile(
      path.join(wsHash, "workspace.json"),
      JSON.stringify({ folder: "file:///c%3A/Projects/VscApp" }),
      "utf8",
    );

    const tFile = path.join(transcriptsDir, "vsc-tr-1.jsonl");
    const tRows = [
      {
        type: "session.start",
        timestamp: "2026-11-25T10:00:00Z",
        data: { sessionId: "vsc-tr-1", selectedModel: "GPT-5.2 Astra" },
      },
      {
        type: "user.message",
        timestamp: "2026-11-25T10:00:01Z",
        data: { content: "Investigate BreakGlass subagent" },
      },
      {
        type: "subagent.started",
        timestamp: "2026-11-25T10:00:02Z",
        data: {
          toolCallId: "tc-bg-1",
          agentName: "BreakGlass",
          model: "GPT-5.2 Astra",
          prompt: "Inspect emergency path",
        },
      },
      {
        type: "assistant.message",
        timestamp: "2026-11-25T10:00:05Z",
        data: {
          content: "Turn 1 complete",
          usage: { promptTokens: 50_000, completionTokens: 1000, cachedTokens: 10_000 },
        },
      },
      {
        type: "assistant.message",
        timestamp: "2026-11-25T10:00:10Z",
        data: {
          content: "Compacted turn 2",
          usage: { promptTokens: 8000, completionTokens: 500, cachedTokens: 2000 },
        },
      },
    ];
    await fs.writeFile(
      tFile,
      tRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const discovered = await adapter.discoverSessions();
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.sessionId, "vsc-tr-1");
    assert.equal(discovered[0]?.title, "Investigate BreakGlass subagent");
    assert.equal(discovered[0]?.isMultiAgent, true);

    const snap = buildSessionSnapshot(await adapter.parseSession(discovered[0]!), {
      sessionId: "vsc-tr-1",
      ide: "copilot-vscode",
      nowEpochSec: Date.parse("2026-11-25T10:00:12Z") / 1000,
    });
    const rootNode = snap.agents.find((a) => a.id === "root");
    assert.equal(rootNode?.model, "GPT-5.2 Astra");
    assert.equal(rootNode?.usage?.inputTokens, 46_000);
    assert.equal(rootNode?.usage?.outputTokens, 1500);
    assert.equal(rootNode?.usage?.cachedTokens, 12_000);
    assert.equal(rootNode?.usage?.totalTokens, 59_500);
    // Latest turn occupancy (8000 inclusive prompt + 500 output = 8500), NOT double-counted or latched at 61000
    assert.equal(rootNode?.usage?.contextTokens, 8500);
    assert.equal(rootNode?.usage?.contextWindow, 400_000);
    const bgNode = snap.agents.find((a) => a.id === "breakglass");
    assert.ok(bgNode);
    assert.equal(bgNode.status, "THINKING", "spawned subagent enters THINKING, not IDLE");
    assert.equal(bgNode.label, "BreakGlass");
    assert.equal(bgNode.model, "GPT-5.2 Astra");

    // PushBus transcript_path enrichment on an external transcript not in workspaceStorage
    const extTranscript = path.join(tmpDir, "external-subagent-tr.jsonl");
    await fs.writeFile(
      extTranscript,
      [
        {
          type: "session.start",
          timestamp: "2026-11-25T10:05:00Z",
          data: { selectedModel: "GPT-5.2 Astra", agentName: "BreakGlass" },
        },
        {
          type: "assistant.message",
          timestamp: "2026-11-25T10:05:03Z",
          data: {
            content: "External subagent finished",
            usage: { input_tokens: 4000, output_tokens: 300, cachedTokens: 1000 },
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    const agg = new TelemetryAggregator({
      brainDir: path.join(tmpDir, "empty-brain"),
      claudeDir: path.join(tmpDir, "empty-claude"),
      vscodeDir: vscDir,
      extraWorkspaces: [tmpDir],
      includeGlobalTelemetryFile: false,
    });
    agg.ingest([
      {
        id: "push-vsc-spawn",
        ts: "2026-11-25T10:05:00Z",
        ide: "copilot-vscode",
        sessionId: "push-vsc-root",
        agentId: "root",
        targetAgentId: "sub-bg",
        kind: "subagent_spawn",
        summary: "Spawned BreakGlass",
        payload: { agentLabel: "BreakGlass" },
      },
      {
        id: "push-vsc-sub-ev",
        ts: "2026-11-25T10:05:01Z",
        ide: "copilot-vscode",
        sessionId: "sub-bg",
        agentId: "root",
        kind: "tool_start",
        toolName: "read_file",
        summary: "Read config",
        payload: { transcriptPath: extTranscript },
      },
    ]);
    const extSnap = await agg.getSessionSnapshot("push-vsc-root");
    const subBg = extSnap.snapshot.agents.find((a) => a.id === "sub-bg");
    assert.ok(subBg);
    assert.equal(subBg.model, "GPT-5.2 Astra");
    assert.equal(subBg.usage?.usageSource, "exact");
    assert.equal(subBg.usage?.inputTokens, 3000);
    assert.equal(subBg.usage?.cachedTokens, 1000);
    assert.equal(subBg.usage?.outputTokens, 300);
    assert.equal(subBg.usage?.totalTokens, 4300);

    // Synthetic mcp-* sessions must sort below real IDE sessions
    agg.ingest([
      {
        id: "mcp-hijack-1",
        ts: "2099-01-01T00:00:00Z",
        ide: "mcp",
        sessionId: "mcp-demo",
        agentId: "orchestrator",
        kind: "board_mutation",
        summary: "board.move S1-01",
      },
    ]);
    const ordered = await agg.discoverSessions();
    assert.notEqual(ordered[0]?.sessionId, "mcp-demo", "synthetic mcp-* must not hijack sessions[0]");
    assert.equal(ordered[ordered.length - 1]?.sessionId, "mcp-demo");
  });

  it("Claude streaming usage deduplication, /compact drop, hyphenated encodeCwd, Antigravity >32KB/file:///decimal/manage_subagents, and normalizer fallback/peakContext", async () => {
    // 1. Claude Code: streaming message.id dedupe + /compact + hyphenated workspace
    const claudeDir = path.join(tmpDir, "claude-adv");
    const hyphenWs = path.join(tmpDir, "my-hyphen-app");
    await fs.mkdir(hyphenWs, { recursive: true });
    const normWs = hyphenWs.replace(/\\/g, "/");
    const encodedFolder = normWs
      .replace(/^([A-Za-z]):\//, "$1--")
      .replace(/\//g, "-");
    const projFolder = path.join(claudeDir, encodedFolder);
    await fs.mkdir(projFolder, { recursive: true });
    const cSid = "dddd1111-2222-3333-4444-555566667777";
    // Pad head > 32KB without cwd so encodeCwd fallback is exercised
    const padding = "x".repeat(400);
    const padRows = Array.from({ length: 90 }, (_, idx) => ({
      type: "queue-operation",
      timestamp: `2026-11-25T11:00:${String(idx % 60).padStart(2, "0")}Z`,
      note: padding,
    }));
    const cRows = [
      ...padRows,
      {
        type: "assistant",
        uuid: "stream-1",
        timestamp: "2026-11-25T11:02:00Z",
        message: {
          id: "msg_001",
          role: "assistant",
          model: "opus",
          stop_reason: null,
          content: [{ type: "thinking", thinking: "..." }],
          usage: { input_tokens: 10000, output_tokens: 50, cache_read_input_tokens: 50000 },
        },
      },
      {
        type: "assistant",
        uuid: "stream-2",
        timestamp: "2026-11-25T11:02:02Z",
        message: {
          id: "msg_001",
          role: "assistant",
          model: "opus",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Turn 1 done" }],
          usage: { input_tokens: 10000, output_tokens: 400, cache_read_input_tokens: 50000 },
        },
      },
      {
        type: "assistant",
        uuid: "turn-2",
        timestamp: "2026-11-25T11:03:00Z",
        message: {
          id: "msg_002",
          role: "assistant",
          model: "claude-opus-4-5[1m]",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "After /compact" }],
          usage: { input_tokens: 2000, output_tokens: 150, cache_read_input_tokens: 3000 },
        },
      },
    ];
    await fs.writeFile(
      path.join(projFolder, `${cSid}.jsonl`),
      cRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const claudeAdapter = new ClaudeCodeAdapter({ projectsDir: claudeDir });
    const [cDisc] = await claudeAdapter.discoverSessions({
      workspaceRoots: [hyphenWs],
    });
    assert.ok(cDisc);
    assert.equal(cDisc.workspacePath?.toLowerCase(), normWs.toLowerCase());

    const cSnap = buildSessionSnapshot(await claudeAdapter.parseSession(cDisc), {
      sessionId: cSid,
      ide: "claude-code",
      nowEpochSec: Date.parse("2026-11-25T11:03:10Z") / 1000,
    });
    const cRoot = cSnap.agents.find((a) => a.id === "root");
    assert.equal(cRoot?.usage?.inputTokens, 12_000, "streamed msg_001 must not double-count");
    assert.equal(cRoot?.usage?.outputTokens, 550);
    assert.equal(cRoot?.usage?.cachedTokens, 53_000);
    assert.equal(cRoot?.usage?.contextTokens, 5150, "/compact drops lastTurnContext");
    assert.equal(cRoot?.usage?.contextWindow, 1_000_000, "[1m] model gets 1M window");
    assert.equal(prettifyModelName("haiku"), "Claude Haiku");
    assert.equal(prettifyModelName("sonnet"), "Claude Sonnet");
    assert.equal(prettifyModelName("opus"), "Claude Opus");
    assert.equal(inferContextWindow("Unknown", "antigravity"), 1_000_000);

    // 2. Antigravity: >32KB child discovery, file:/// workspaceUris, decimal MODEL_SELECTION_RE, manage_subagents cancel
    const brainDir = path.join(tmpDir, "brain-adv");
    const rootCid = "12121212-1212-1212-1212-121212121212";
    const childCid = "34343434-3434-3434-3434-343434343434";
    const mkAg = async (cid: string, rows: unknown[]): Promise<void> => {
      const p = path.join(brainDir, cid, ".system_generated", "logs", "transcript.jsonl");
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    };
    const bigPad = Array.from({ length: 90 }, (_, idx) => ({
      step_index: idx + 1,
      type: "THINKING",
      created_at: "2026-11-25T12:00:01Z",
      content: "P".repeat(400),
    }));
    await mkAg(rootCid, [
      {
        step_index: 0,
        type: "USER_SETTINGS_CHANGE",
        created_at: "2026-11-25T12:00:00Z",
        content: "User changed Model Selection to Gemini 3.5 Pro (High).",
      },
      ...bigPad,
      {
        step_index: 95,
        type: "USER_INPUT",
        created_at: "2026-11-25T12:00:10Z",
        content: `{"workspaceUris":["file:///c%3A/Projects/AgyRepo"]}\nLaunch subagent`,
      },
      {
        step_index: 96,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T12:00:11Z",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: { TypeName: '"qa"', Role: '"QA"', Prompt: '"Verify"' },
          },
        ],
      },
      {
        step_index: 97,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-25T12:00:12Z",
        content: `Created the following subagent: {"conversationId": "${childCid}"}`,
      },
      {
        step_index: 98,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T12:00:15Z",
        tool_calls: [
          {
            name: "manage_subagents",
            args: { Action: '"cancel"', ConversationId: `"${childCid}"` },
          },
        ],
      },
    ]);
    await mkAg(childCid, [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-25T12:00:13Z",
        content: `[Message] sender=${rootCid} content=Verify`,
      },
    ]);

    const agyAdapter = new AntigravityAdapter({ brainDir });
    const agySessions = await agyAdapter.discoverSessions();
    assert.equal(agySessions.length, 1, "child beyond 32KB must be excluded from top-level");
    assert.equal(agySessions[0]?.isMultiAgent, true);
    assert.ok(agySessions[0]?.workspaces.includes("c:/Projects/AgyRepo"));

    const agySnap = buildSessionSnapshot(await agyAdapter.parseSession(agySessions[0]!), {
      sessionId: rootCid,
      ide: "antigravity",
      nowEpochSec: Date.parse("2026-11-25T12:00:20Z") / 1000,
    });
    const agyRoot = agySnap.agents.find((a) => a.id === "root");
    assert.equal(agyRoot?.model, "Gemini 3.5 Pro (High)", "decimal version preserved");
    const agyChild = agySnap.agents.find((a) => a.id === "qa");
    assert.equal(agyChild?.status, "DONE", "manage_subagents cancel marks subagent DONE");

    // 3. Normalizer: fallback input/output split, root->orchestrator defModel, and <0.1% peakContextAgentId
    const fallbackSnap = buildSessionSnapshot(
      [
        {
          id: "fb-1",
          ts: "2026-11-25T12:10:00Z",
          epoch: 1_795_000_000,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "fb-s1",
          agentId: "root",
          kind: "user_input",
          summary: "Human: check",
          payload: { body: "A".repeat(400) },
        },
        {
          id: "fb-2",
          ts: "2026-11-25T12:10:01Z",
          epoch: 1_795_000_001,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "fb-s1",
          agentId: "root",
          targetAgentId: "sub-x",
          kind: "subagent_spawn",
          summary: "Spawned Sub X",
        },
      ],
      {
        sessionId: "fb-s1",
        ide: "copilot-vscode",
        nowEpochSec: 1_795_000_005,
        definitions: [{ id: "orchestrator", model: "Claude Sonnet 4.5 (copilot)" }],
      },
    );
    const fbRoot = fallbackSnap.agents.find((a) => a.id === "root");
    const fbSub = fallbackSnap.agents.find((a) => a.id === "sub-x");
    assert.equal(fbRoot?.model, "Claude Sonnet 4.5 (copilot)");
    assert.equal(fbSub?.model, "Claude Sonnet 4.5 (copilot)", "subagent inherits root model on copilot-vscode");
    assert.ok((fbRoot?.usage?.outputTokens ?? 0) > 0, "fallback estimation splits outputTokens > 0");
    assert.ok((fallbackSnap.usage?.peakContextPercent ?? 0) > 0);
    assert.equal(fallbackSnap.usage?.peakContextAgentId, "root");
  });

  it("BUG-18 security: validateTranscriptPath, PushBus & CopilotVSCodeAdapter reject traversal, UNC, non-.jsonl, symlink escape, and oversized files", async () => {
    const secRoot = path.join(tmpDir, "sec-check");
    const allowedRoot = path.join(secRoot, "allowed");
    const siblingRoot = path.join(secRoot, "allowed-sibling");
    const outsideRoot = path.join(secRoot, "outside");
    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.mkdir(siblingRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });

    const validFile = path.join(allowedRoot, "sub.jsonl");
    const siblingFile = path.join(siblingRoot, "sib.jsonl");
    const outsideFile = path.join(outsideRoot, "secret.jsonl");
    const nonJsonlFile = path.join(allowedRoot, "notes.txt");
    const telemetryFile = path.join(allowedRoot, "telemetry.jsonl");
    const bigFile = path.join(allowedRoot, "huge.jsonl");

    const sampleRow = JSON.stringify({
      type: "assistant.message",
      timestamp: "2026-11-25T10:00:00Z",
      data: { content: "ok", usage: { input_tokens: 10, output_tokens: 5 } },
    });
    await fs.writeFile(validFile, `${sampleRow}\n`, "utf8");
    await fs.writeFile(siblingFile, `${sampleRow}\n`, "utf8");
    await fs.writeFile(outsideFile, `${sampleRow}\n`, "utf8");
    await fs.writeFile(nonJsonlFile, `${sampleRow}\n`, "utf8");
    await fs.writeFile(telemetryFile, `${sampleRow}\n`, "utf8");
    await fs.writeFile(bigFile, "x".repeat(256), "utf8");

    // Positive containment
    const okReal = await validateTranscriptPath(validFile, [allowedRoot]);
    assert.ok(okReal);

    // Negative syntactic & containment checks
    assert.equal(
      await validateTranscriptPath(`${allowedRoot}${path.sep}..${path.sep}outside${path.sep}secret.jsonl`, [allowedRoot]),
      null,
      "must reject explicit .. traversal",
    );
    assert.equal(
      await validateTranscriptPath(outsideFile, [allowedRoot]),
      null,
      "must reject file outside allowedRoots",
    );
    assert.equal(
      await validateTranscriptPath(siblingFile, [allowedRoot]),
      null,
      "must reject sibling prefix escape (/allowed-sibling vs /allowed)",
    );
    assert.equal(
      await validateTranscriptPath("\\\\evil\\share\\x.jsonl", [allowedRoot]),
      null,
      "must reject UNC backslash path",
    );
    assert.equal(
      await validateTranscriptPath("//evil/share/x.jsonl", [allowedRoot]),
      null,
      "must reject UNC slash path",
    );
    assert.equal(
      await validateTranscriptPath("\\\\?\\C:\\temp\\x.jsonl", [allowedRoot]),
      null,
      "must reject Windows device prefix path",
    );
    assert.equal(
      await validateTranscriptPath(nonJsonlFile, [allowedRoot]),
      null,
      "must reject non-.jsonl file",
    );
    assert.equal(
      await validateTranscriptPath(telemetryFile, [allowedRoot]),
      null,
      "must reject telemetry.jsonl",
    );
    assert.equal(
      await validateTranscriptPath("relative/sub.jsonl", [allowedRoot]),
      null,
      "must reject relative path",
    );
    assert.equal(
      await validateTranscriptPath(`${validFile}\0.jsonl`, [allowedRoot]),
      null,
      "must reject null byte",
    );
    assert.equal(
      await validateTranscriptPath(allowedRoot, [allowedRoot]),
      null,
      "must reject directory",
    );

    // Oversized file cap (using small explicit maxBytes + checking MAX_TRANSCRIPT_BYTES constant)
    assert.ok(MAX_TRANSCRIPT_BYTES >= 20 * 1024 * 1024);
    assert.equal(
      await validateTranscriptPath(bigFile, [allowedRoot], { maxBytes: 128 }),
      null,
      "must reject oversized transcript before reading",
    );

    // Symlink escape outside allowedRoots (try file symlink, fallback to directory junction on restricted Windows)
    const symlinkPath = path.join(allowedRoot, "escape-link.jsonl");
    let createdLink = false;
    try {
      await fs.symlink(outsideFile, symlinkPath);
      createdLink = true;
    } catch {
      const junctionDir = path.join(allowedRoot, "escape-dir");
      try {
        await fs.symlink(outsideRoot, junctionDir, "junction");
        assert.equal(
          await validateTranscriptPath(path.join(junctionDir, "secret.jsonl"), [allowedRoot]),
          null,
          "must reject directory junction escape outside allowedRoots",
        );
        createdLink = true;
      } catch {
        // Symlinks unavailable in this environment
      }
    }
    if (createdLink) {
      try {
        const st = await fs.lstat(symlinkPath);
        if (st.isSymbolicLink()) {
          assert.equal(
            await validateTranscriptPath(symlinkPath, [allowedRoot]),
            null,
            "must reject file symlink escape outside allowedRoots",
          );
        }
      } catch {
        // Junction path already asserted above
      }
    }

    // PushBus early syntactic rejection + 64-entry cap
    const bus = new PushBus({ includeGlobalTelemetryFile: false });
    const batch: unknown[] = [
      {
        id: "sec-bad-1",
        ts: "2026-11-25T10:00:00Z",
        ide: "copilot-vscode",
        sessionId: "sec-s1",
        agentId: "root",
        kind: "tool_start",
        summary: "bad unc",
        payload: { transcriptPath: "\\\\evil\\share\\x.jsonl" },
      },
      {
        id: "sec-bad-2",
        ts: "2026-11-25T10:00:01Z",
        ide: "copilot-vscode",
        sessionId: "sec-s1",
        agentId: "root",
        kind: "tool_start",
        summary: "bad txt",
        payload: { transcriptPath: nonJsonlFile },
      },
    ];
    for (let i = 0; i < 80; i++) {
      batch.push({
        id: `sec-cap-${i}`,
        ts: "2026-11-25T10:00:02Z",
        ide: "copilot-vscode",
        sessionId: "sec-cap-s1",
        agentId: `ag-${i}`,
        kind: "tool_start",
        summary: `cap ${i}`,
        payload: { transcriptPath: path.join(allowedRoot, `t-${i}.jsonl`) },
      });
    }
    bus.ingest(batch);
    assert.equal(bus.getTranscriptPaths("sec-s1").length, 0);
    assert.equal(bus.getTranscriptPaths("sec-cap-s1").length, 64);

    // TelemetryAggregator refuses uncontained transcriptPath outside allowed roots
    const agg = new TelemetryAggregator({
      brainDir: path.join(secRoot, "empty-brain"),
      claudeDir: path.join(secRoot, "empty-claude"),
      vscodeDir: path.join(secRoot, "empty-vsc"),
      extraWorkspaces: [allowedRoot],
      includeGlobalTelemetryFile: false,
    });
    agg.ingest([
      {
        id: "agg-sec-1",
        ts: "2026-11-25T10:00:00Z",
        ide: "copilot-vscode",
        sessionId: "agg-sec-s1",
        agentId: "root",
        kind: "tool_start",
        summary: "uncontained",
        payload: { transcriptPath: outsideFile },
      },
    ]);
    const snap = await agg.getSessionSnapshot("agg-sec-s1");
    assert.equal(snap.snapshot.agents.find((a) => a.id === "root")?.usage?.usageSource ?? "estimated", "estimated");
  });

  it("P1-1: hook-emit PreToolUse/PostToolUse on Agent/Task without agent_id keeps tool_start/tool_end and normalizer never marks root DONE without targetAgentId", async () => {
    const wsDir = path.join(tmpDir, "p1-1-ws");
    await fs.mkdir(wsDir, { recursive: true });
    const offlineFetch: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED"));

    const preAgent = await runHookEmit(
      ["--ide", "claude-code", "--event", "PreToolUse"],
      {
        stdinText: JSON.stringify({
          session_id: "p1-1-s1",
          cwd: wsDir,
          tool_name: "Agent",
          tool_use_id: "tu-agent-1",
          tool_input: { description: "Run backend" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(preAgent.event?.kind, "tool_start");
    assert.equal(preAgent.event?.agentId, "root");
    assert.equal(preAgent.event?.targetAgentId, undefined);

    const postTask = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PostToolUse"],
      {
        stdinText: JSON.stringify({
          sessionId: "p1-1-s1",
          cwd: wsDir,
          toolName: "Task",
          toolCallId: "tu-task-1",
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(postTask.event?.kind, "tool_end");
    assert.equal(postTask.event?.agentId, "root");
    assert.equal(postTask.event?.targetAgentId, undefined);

    const snap = buildSessionSnapshot([preAgent.event!, postTask.event!], {
      sessionId: "p1-1-s1",
      ide: "claude-code",
      nowEpochSec: (postTask.event!.epoch ?? Date.now() / 1000) + 1,
    });
    assert.equal(snap.agents.find((a) => a.id === "subagent"), undefined, "must not spawn ghost subagent");
    assert.notEqual(snap.agents.find((a) => a.id === "root")?.status, "DONE");

    // Direct normalizer guard: subagent_done on root without targetAgentId must not mark root DONE
    const directSnap = buildSessionSnapshot(
      [
        {
          id: "d-root-start",
          ts: "2026-11-25T10:00:00Z",
          epoch: 1_795_100_000,
          ide: "claude-code",
          channel: "hook",
          sessionId: "p1-1-s2",
          agentId: "root",
          kind: "user_input",
          summary: "Human: check",
        },
        {
          id: "d-root-subdone",
          ts: "2026-11-25T10:00:01Z",
          epoch: 1_795_100_001,
          ide: "claude-code",
          channel: "hook",
          sessionId: "p1-1-s2",
          agentId: "root",
          kind: "subagent_done",
          summary: "Task done",
        },
      ],
      {
        sessionId: "p1-1-s2",
        ide: "claude-code",
        nowEpochSec: 1_795_100_002,
      },
    );
    assert.notEqual(directSnap.agents.find((a) => a.id === "root")?.status, "DONE");
  });

  it("P1-2 & P2-4: PushBus SubagentStop records agentTranscriptPath, explicitParentSid memoizes, and generic 'subagent' is never registered", async () => {
    const wsDir = path.join(tmpDir, "p1-2-ws");
    const subTrPath = path.join(wsDir, "agent-xyz.jsonl");
    const bus = new PushBus({ includeGlobalTelemetryFile: false });

    // 1. SubagentStop (subagent_done) records agentTranscriptPath for targetAgentId
    bus.ingest([
      {
        id: "stop-1",
        ts: "2026-11-25T10:00:05Z",
        ide: "claude-code",
        sessionId: "parent-p12",
        agentId: "root",
        targetAgentId: "agent-xyz",
        kind: "subagent_done",
        summary: "Completed backend",
        payload: { agentTranscriptPath: subTrPath },
      },
    ]);
    assert.equal(
      bus.getAgentTranscriptPaths("parent-p12").get("agent-xyz"),
      subTrPath,
    );

    // 2. explicitParentSid memoizes subagent sessionId -> parentSessionId for follow-up events missing parentSessionId
    bus.ingest([
      {
        id: "exp-1",
        ts: "2026-11-25T10:01:00Z",
        ide: "copilot-vscode",
        sessionId: "sub-sess-42",
        agentId: "root",
        kind: "tool_start",
        toolName: "read_file",
        summary: "Read file",
        payload: {
          parentSessionId: "parent-p12",
          agentId: "bg-42",
          agentLabel: "Research",
        },
      },
      {
        id: "exp-2",
        ts: "2026-11-25T10:01:01Z",
        ide: "copilot-vscode",
        sessionId: "sub-sess-42",
        agentId: "root",
        kind: "tool_end",
        toolName: "read_file",
        summary: "Read done",
      },
    ]);
    assert.ok(!bus.getAllSessionIds().includes("sub-sess-42"));
    const parentEvs = bus.getSessionEvents("parent-p12");
    assert.ok(parentEvs.some((e) => e.id === "exp-1" && e.agentId === "bg-42"));
    assert.ok(parentEvs.some((e) => e.id === "exp-2" && e.agentId === "bg-42"));

    // 3. Generic "subagent" must NEVER be registered in subagentToParent
    bus.ingest([
      {
        id: "gen-spawn",
        ts: "2026-11-25T10:02:00Z",
        ide: "claude-code",
        sessionId: "parent-a",
        agentId: "root",
        targetAgentId: "subagent",
        kind: "subagent_spawn",
        summary: "Spawned generic",
        payload: { agentId: "subagent" },
      },
      {
        id: "gen-other",
        ts: "2026-11-25T10:02:01Z",
        ide: "claude-code",
        sessionId: "subagent",
        agentId: "root",
        kind: "tool_start",
        summary: "Unrelated session literally named subagent",
      },
    ]);
    assert.ok(
      bus.getAllSessionIds().includes("subagent"),
      "generic 'subagent' key must not be registered in subagentToParent",
    );
  });

  it("P1-3 & P1-4: CopilotVSCodeAdapter avoids subagent self-loop, prefers subAgentInvocationId, and caches transcripts/*.jsonl discovery", async () => {
    const vscDir = path.join(tmpDir, "vsc-p13-p14");
    const wsHash = path.join(vscDir, "ws-hash-1");
    const transcriptsDir = path.join(wsHash, "GitHub.copilot-chat", "transcripts");
    const chatDir = path.join(wsHash, "chatSessions");
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.mkdir(chatDir, { recursive: true });

    // 1. Transcript with subagent.started / subagent.completed carrying d.agentId = "bg-1"
    const trFile = path.join(transcriptsDir, "tr-selfloop.jsonl");
    await fs.writeFile(
      trFile,
      [
        {
          type: "session.start",
          timestamp: "2026-11-25T10:00:00Z",
          data: { sessionId: "tr-selfloop" },
        },
        {
          type: "user.message",
          timestamp: "2026-11-25T10:00:01Z",
          data: { content: "Check self-loop" },
        },
        {
          type: "subagent.started",
          timestamp: "2026-11-25T10:00:02Z",
          data: {
            toolCallId: "tc-bg-99",
            agentId: "bg-1",
            agentName: "Code Reviewer",
            prompt: "Audit diff",
          },
        },
        {
          type: "subagent.completed",
          timestamp: "2026-11-25T10:00:05Z",
          data: {
            toolCallId: "tc-bg-99",
            agentId: "bg-1",
            agentName: "Code Reviewer",
            result: "Clean",
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    // 2. chatSession with subAgentInvocationId
    const chatFile = path.join(chatDir, "chat-inv.json");
    await fs.writeFile(
      chatFile,
      JSON.stringify({
        sessionId: "chat-inv-1",
        creationDate: Date.parse("2026-11-25T10:10:00Z"),
        requests: [
          {
            requestId: "r1",
            timestamp: Date.parse("2026-11-25T10:10:00Z"),
            message: { text: "Delegate to specialist" },
            response: [
              {
                kind: "toolInvocationSerialized",
                toolId: "runSubagent",
                toolCallId: "tc-inv-1",
                isComplete: true,
                toolSpecificData: {
                  subAgentInvocationId: "uuid-sub-777",
                  subAgentName: "Backend Engineer",
                  prompt: "Implement fix",
                },
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const parsedTr = await adapter.parseTranscriptFile(trFile, "tr-selfloop");
    const spawnEv = parsedTr.find((e) => e.kind === "subagent_spawn");
    const doneEv = parsedTr.find((e) => e.kind === "subagent_done");
    assert.equal(spawnEv?.agentId, "root");
    assert.equal(spawnEv?.targetAgentId, "bg-1");
    assert.equal(doneEv?.agentId, "root");
    assert.equal(doneEv?.targetAgentId, "bg-1");

    const discovered1 = await adapter.discoverSessions();
    assert.equal(discovered1.length, 2);
    // Second discoverSessions call hits transcriptDiscoveryCache when (mtimeMs, sizeBytes) unchanged
    const discovered2 = await adapter.discoverSessions();
    assert.equal(discovered2.length, 2);
    assert.equal(
      discovered2.find((s) => s.sessionId === "tr-selfloop")?.title,
      "Check self-loop",
    );

    const chatSession = discovered1.find((s) => s.sessionId === "chat-inv-1")!;
    const chatEvs = await adapter.parseSession(chatSession);
    const chatSpawn = chatEvs.find((e) => e.kind === "subagent_spawn");
    assert.equal(chatSpawn?.targetAgentId, "uuid-sub-777");
    assert.equal(chatSpawn?.payload?.agentLabel, "Backend Engineer");
  });

  it("ClaudeCodeAdapter.discoverSessions bumps mtimeMs when subagents/agent-*.jsonl is newer than main .jsonl", async () => {
    const claudeDir = path.join(tmpDir, "claude-sub-mtime");
    const projDir = path.join(claudeDir, "demo-proj");
    const sid = "eeee1111-2222-3333-4444-555566667777";
    const subDir = path.join(projDir, sid, "subagents");
    await fs.mkdir(subDir, { recursive: true });

    const mainFile = path.join(projDir, `${sid}.jsonl`);
    const subFile = path.join(subDir, "agent-sub1.jsonl");
    await fs.writeFile(
      mainFile,
      JSON.stringify({
        type: "user",
        timestamp: "2026-11-25T10:00:00Z",
        message: { role: "user", content: "Start task" },
      }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      subFile,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-25T10:05:00Z",
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
      }) + "\n",
      "utf8",
    );

    const oldDate = new Date("2026-11-25T10:00:00Z");
    const newerDate = new Date("2026-11-25T10:05:00Z");
    await fs.utimes(mainFile, oldDate, oldDate);
    await fs.utimes(subFile, newerDate, newerDate);

    const adapter = new ClaudeCodeAdapter({ projectsDir: claudeDir });
    const [disc] = await adapter.discoverSessions();
    assert.ok(disc);
    assert.ok(
      disc.mtimeMs >= newerDate.getTime() - 10,
      `expected mtimeMs >= ${newerDate.getTime()}, got ${disc.mtimeMs}`,
    );
    assert.equal(disc.isMultiAgent, true);
  });

  it("BUG-19 (1): hook-emit Copilot subagent UserPromptSubmit -> thinking_start + parentAgentId='root' and Stop -> 'Stop (<agentLabel>)'", async () => {
    const wsDir = path.join(tmpDir, "bug19-1-ws");
    await fs.mkdir(wsDir, { recursive: true });
    const offlineFetch: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED"));

    const subPrompt = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "UserPromptSubmit"],
      {
        stdinText: JSON.stringify({
          sessionId: "b19-s1",
          cwd: wsDir,
          agent_id: "uuid-sub-1111",
          agent_type: "qa-specialist",
          prompt: "Verify telemetry fixes and run unit tests",
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(subPrompt.event?.kind, "thinking_start");
    assert.equal(subPrompt.event?.agentId, "uuid-sub-1111");
    assert.equal(subPrompt.event?.parentAgentId, "root");
    assert.ok(!subPrompt.event?.summary.startsWith("Human:"));
    assert.match(subPrompt.event?.summary ?? "", /Verify telemetry fixes/);

    const subPre = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PreToolUse"],
      {
        stdinText: JSON.stringify({
          sessionId: "b19-s1",
          cwd: wsDir,
          agent_id: "uuid-sub-1111",
          agent_type: "qa-specialist",
          tool_name: "read_file",
          tool_call_id: "call_read_1",
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(subPre.event?.parentAgentId, "root");

    const subStop = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "Stop"],
      {
        stdinText: JSON.stringify({
          sessionId: "b19-s1",
          cwd: wsDir,
          agent_id: "uuid-sub-1111",
          agent_type: "qa-specialist",
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(subStop.event?.kind, "assistant_turn_end");
    assert.equal(subStop.event?.parentAgentId, "root");
    assert.equal(subStop.event?.summary, "Stop (qa-specialist)");

    const rootStop = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "Stop"],
      {
        stdinText: JSON.stringify({
          sessionId: "b19-s1",
          cwd: wsDir,
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(rootStop.event?.agentId, "root");
    assert.equal(rootStop.event?.summary, "Stop (Coordinator)");
  });

  it("BUG-19 (2): subagent transcript user.message -> thinking_start, normalizer user_input guard, PushBus agentId re-homing, and root transcriptPath ordering", async () => {
    const vscDir = path.join(tmpDir, "bug19-2-vsc");
    const wsHash = path.join(vscDir, "ws-hash");
    const transcriptsDir = path.join(wsHash, "GitHub.copilot-chat", "transcripts");
    await fs.mkdir(transcriptsDir, { recursive: true });

    const subTr = path.join(transcriptsDir, "sub-tr.jsonl");
    await fs.writeFile(
      subTr,
      [
        {
          type: "user.message",
          timestamp: "2026-11-25T13:00:00Z",
          data: { content: "Audit backend telemetry changes" },
        },
        {
          type: "assistant.message",
          timestamp: "2026-11-25T13:00:02Z",
          data: { content: "Audited changes." },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const subEvents = await adapter.parseTranscriptFile(subTr, "b19-s2", {
      agentIdOverride: "sub-agent-2",
      parentAgentIdOverride: "root",
      allowedRoots: [vscDir],
    });
    assert.equal(subEvents[0]?.kind, "thinking_start");
    assert.ok(!subEvents[0]?.summary.startsWith("Human:"));

    // Direct normalizer guard: rogue user_input targeting a subagent must NOT increment human.messagesSent or add human -> subagent edge
    const snap = buildSessionSnapshot(
      [
        {
          id: "root-init",
          ts: "2026-11-25T13:00:00Z",
          epoch: 1_795_200_000,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "b19-s2",
          agentId: "root",
          kind: "user_input",
          summary: "Human: Run QA",
          payload: { prompt: "Run QA" },
        },
        {
          id: "sub-rogue-ui",
          ts: "2026-11-25T13:00:01Z",
          epoch: 1_795_200_001,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "b19-s2",
          agentId: "sub-agent-2",
          parentAgentId: "root",
          kind: "user_input",
          summary: "Human: Subagent task prompt",
        },
      ],
      {
        sessionId: "b19-s2",
        ide: "copilot-vscode",
        nowEpochSec: 1_795_200_005,
      },
    );
    const humanNode = snap.agents.find((a) => a.id === "human");
    assert.equal(humanNode?.messagesSent, 1, "human.messagesSent must count only root prompt");
    assert.equal(
      snap.edges.some((e) => e.from === "human" && e.to === "sub-agent-2"),
      false,
      "must not create human -> subagent edge",
    );
    const subNode = snap.agents.find((a) => a.id === "sub-agent-2");
    assert.equal(subNode?.status, "THINKING");

    // PushBus fallback re-homing by ev.agentId when sessionId !== parentSessionId, coercing user_input -> thinking_start
    const bus = new PushBus({ includeGlobalTelemetryFile: false });
    bus.ingest([
      {
        id: "b19-spawn",
        ts: "2026-11-25T13:01:00Z",
        ide: "copilot-vscode",
        sessionId: "parent-b19",
        agentId: "root",
        targetAgentId: "sub-uuid-99",
        kind: "subagent_spawn",
        summary: "Spawned qa-specialist",
        payload: { agentLabel: "qa-specialist" },
      },
      {
        id: "b19-orphan-ui",
        ts: "2026-11-25T13:01:01Z",
        ide: "copilot-vscode",
        sessionId: "different-child-sid",
        agentId: "sub-uuid-99",
        kind: "user_input",
        summary: "Human: Subagent prompt",
      },
    ]);
    assert.ok(!bus.getAllSessionIds().includes("different-child-sid"));
    const migratedEv = bus.getSessionEvents("parent-b19").find((e) => e.id === "b19-orphan-ui");
    assert.equal(migratedEv?.kind, "thinking_start");
    assert.equal(migratedEv?.parentAgentId, "root");

    // TelemetryAggregator parses root's shared transcriptPath before subagent's entry even if subagent was registered first
    const sharedMainTr = path.join(transcriptsDir, "shared-main.jsonl");
    await fs.writeFile(
      sharedMainTr,
      [
        {
          type: "user.message",
          timestamp: "2026-11-25T13:02:00Z",
          data: { content: "Main coordinator prompt" },
        },
        {
          type: "tool.execution_start",
          timestamp: "2026-11-25T13:02:01Z",
          data: { toolName: "read_file", toolCallId: "tc-main-1" },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );
    const agg = new TelemetryAggregator({
      brainDir: path.join(tmpDir, "empty-brain-b19"),
      claudeDir: path.join(tmpDir, "empty-claude-b19"),
      vscodeDir: vscDir,
      extraWorkspaces: [vscDir],
      includeGlobalTelemetryFile: false,
    });
    agg.ingest([
      {
        id: "sub-first",
        ts: "2026-11-25T13:02:00Z",
        ide: "copilot-vscode",
        sessionId: "shared-tr-sess",
        agentId: "sub-first-id",
        parentAgentId: "root",
        kind: "tool_start",
        toolName: "grep_search",
        summary: "Search",
        payload: { transcriptPath: sharedMainTr },
      },
      {
        id: "root-second",
        ts: "2026-11-25T13:02:01Z",
        ide: "copilot-vscode",
        sessionId: "shared-tr-sess",
        agentId: "root",
        kind: "session_start",
        summary: "Start",
        payload: { transcriptPath: sharedMainTr },
      },
    ]);
    const aggSnap = await agg.getSessionSnapshot("shared-tr-sess");
    const rootAg = aggSnap.snapshot.agents.find((a) => a.id === "root");
    assert.ok((rootAg?.toolCalls ?? 0) >= 1, "shared transcript tool_start must attribute to root");
    assert.equal(
      aggSnap.snapshot.events.some((e) => e.agentId === "sub-first-id" && e.toolCallId === "tc-main-1"),
      false,
    );
  });

  it("BUG-19 (3): chatSessions UUID modeInfo & custom mode collapse to 'root', isMultiAgent=false, and user_input dedups across hook + chatSessions + transcript.jsonl", async () => {
    const vscDir = path.join(tmpDir, "bug19-3-vsc");
    const wsHash = path.join(vscDir, "ws-hash");
    const chatDir = path.join(wsHash, "chatSessions");
    const trDir = path.join(wsHash, "GitHub.copilot-chat", "transcripts");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.mkdir(trDir, { recursive: true });

    const baseMs = Date.parse("2026-11-25T14:00:00Z");
    const chatFile = path.join(chatDir, "b19-root-collapse.json");
    await fs.writeFile(
      chatFile,
      JSON.stringify({
        sessionId: "b19-root-collapse",
        creationDate: baseMs,
        requests: [
          {
            requestId: "req-1",
            timestamp: baseMs,
            modeInfo: { modeName: "cfccd03f-1111-2222-3333-444455556666" },
            message: { text: "Explain the telemetry normalizer architecture" },
            response: [
              {
                kind: "toolInvocationSerialized",
                toolId: "copilot_readFile",
                toolCallId: "rc-1",
                isComplete: true,
                pastTenseMessage: { value: "Read normalizer.ts" },
              },
            ],
            modelState: { completedAt: baseMs + 4000 },
          },
          {
            requestId: "req-2",
            timestamp: baseMs + 20_000,
            modeInfo: { modeName: "Architect" },
            agent: { name: "custom-mode", id: "custom.id" },
            message: { text: "Now review edge cases" },
            response: [],
            modelState: { completedAt: baseMs + 22_000 },
          },
        ],
      }),
      "utf8",
    );

    const trFile = path.join(trDir, "b19-root-collapse.jsonl");
    await fs.writeFile(
      trFile,
      [
        {
          type: "session.start",
          timestamp: "2026-11-25T14:00:00Z",
          data: { sessionId: "b19-root-collapse" },
        },
        {
          type: "user.message",
          timestamp: "2026-11-25T14:00:06Z", // 6s drift from chatSessions req-1
          data: { content: "Explain the telemetry normalizer architecture" },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const sessions = await adapter.discoverSessions();
    const sess = sessions.find((s) => s.sessionId === "b19-root-collapse");
    assert.ok(sess);
    assert.equal(sess.isMultiAgent, false, "UUID/custom modeInfo must NOT mark session multi-agent");

    const chatEvents = await adapter.parseSession(sess);
    const trEvents = await adapter.parseTranscriptFile(trFile, "b19-root-collapse", {
      allowedRoots: [vscDir],
    });
    const hookPrompt: EnrichedEvent = {
      id: "hook-ui-1",
      ts: "2026-11-25T14:00:09Z", // 9s drift from chatSessions req-1, 3s from transcript
      epoch: baseMs / 1000 + 9,
      ide: "copilot-vscode",
      channel: "hook",
      sessionId: "b19-root-collapse",
      agentId: "root",
      kind: "user_input",
      summary: "Human: Explain the telemetry normalizer architecture",
      payload: { prompt: "Explain the telemetry normalizer architecture" },
    };

    const snap = buildSessionSnapshot([...chatEvents, ...trEvents, hookPrompt], {
      sessionId: "b19-root-collapse",
      ide: "copilot-vscode",
      nowEpochSec: baseMs / 1000 + 30,
    });

    const agentNodes = snap.agents.filter((a) => a.nodeType === "agent");
    assert.equal(agentNodes.length, 1, "only single root agent node must exist");
    assert.equal(agentNodes[0]?.id, "root");
    assert.equal(agentNodes[0]?.label, "Copilot Agent");
    assert.equal(
      snap.agents.find((a) => a.id === "human")?.messagesSent,
      2,
      "3-source duplicate prompt for req-1 must dedup to 1, plus req-2 = 2 total human turns",
    );
  });

  it("BUG-19 (4): mixed chatSessions (isComplete:false + repeated qa-specialist) + live hooks (SubagentStart UUID + orphan hook without SubagentStart) reconcile to 1 node per invocation", async () => {
    const vscDir = path.join(tmpDir, "bug19-4-vsc");
    const wsHash = path.join(vscDir, "ws-hash");
    const chatDir = path.join(wsHash, "chatSessions");
    await fs.mkdir(chatDir, { recursive: true });

    const baseMs = Date.parse("2026-11-25T15:00:00Z");
    const chatFile = path.join(chatDir, "b19-reconcile.json");
    await fs.writeFile(
      chatFile,
      JSON.stringify({
        sessionId: "b19-reconcile",
        creationDate: baseMs,
        requests: [
          {
            requestId: "r-rec-1",
            timestamp: baseMs,
            message: { text: "Run two QA passes" },
            response: [
              {
                kind: "toolInvocationSerialized",
                toolId: "runSubagent",
                toolCallId: "tc-run-1",
                isComplete: false,
                toolSpecificData: {
                  agentName: "qa-specialist",
                  model: "claude-sonnet-4-5",
                  prompt: "Run pass 1",
                },
              },
              {
                kind: "toolInvocationSerialized",
                toolId: "runSubagent",
                toolCallId: "tc-run-2",
                isComplete: false,
                toolSpecificData: {
                  agentName: "qa-specialist",
                  model: "claude-haiku-4-5",
                  prompt: "Run pass 2",
                },
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const [sess] = await adapter.discoverSessions();
    assert.ok(sess);
    assert.equal(sess.isMultiAgent, true);

    const passiveEvents = await adapter.parseSession(sess);
    const passiveSpawns = passiveEvents.filter((e) => e.kind === "subagent_spawn");
    assert.equal(passiveSpawns[0]?.targetAgentId, "qa-specialist");
    assert.equal(passiveSpawns[1]?.targetAgentId, "qa-specialist-2");
    assert.equal(passiveSpawns[0]?.payload?.agentType, "qa-specialist");

    const baseSec = baseMs / 1000;
    const subTr1 = path.join(vscDir, "sub-1.jsonl");
    const hookEvents: EnrichedEvent[] = [
      // Run 1: SubagentStart with UUID + tool + SubagentStop
      {
        id: "h-start-1",
        ts: new Date((baseSec + 0.2) * 1000).toISOString(),
        epoch: baseSec + 0.2,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-reconcile",
        agentId: "root",
        targetAgentId: "uuid-qa-1",
        kind: "subagent_spawn",
        summary: "Spawned qa-specialist",
        payload: {
          agentType: "qa-specialist",
          agentLabel: "qa-specialist",
          agentTranscriptPath: subTr1,
        },
      },
      {
        id: "h-tool-1",
        ts: new Date((baseSec + 1.0) * 1000).toISOString(),
        epoch: baseSec + 1.0,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-reconcile",
        agentId: "uuid-qa-1",
        parentAgentId: "root",
        agentLabel: "qa-specialist",
        kind: "tool_start",
        toolName: "run_in_terminal",
        toolCallId: "h-tc-1",
        summary: "PreToolUse: run_in_terminal",
      },
      {
        id: "h-stop-1",
        ts: new Date((baseSec + 2.0) * 1000).toISOString(),
        epoch: baseSec + 2.0,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-reconcile",
        agentId: "root",
        targetAgentId: "uuid-qa-1",
        kind: "subagent_done",
        summary: "Completed qa-specialist",
      },
      // Run 2: Orphan hook subagent (NO SubagentStart, only PreToolUse + Stop)
      {
        id: "h-orphan-tool-2",
        ts: new Date((baseSec + 5.0) * 1000).toISOString(),
        epoch: baseSec + 5.0,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-reconcile",
        agentId: "uuid-qa-2",
        agentLabel: "qa-specialist",
        kind: "tool_start",
        toolName: "read_file",
        toolCallId: "h-tc-2",
        summary: "PreToolUse: read_file",
        payload: { agentType: "qa-specialist", agentLabel: "qa-specialist" },
      },
    ];

    const snap = buildSessionSnapshot([...passiveEvents, ...hookEvents], {
      sessionId: "b19-reconcile",
      ide: "copilot-vscode",
      nowEpochSec: baseSec + 6,
    });

    const subAgents = snap.agents.filter((a) => a.nodeType === "agent" && !a.isRoot);
    assert.equal(subAgents.length, 2, "must reconcile to exactly 1 node per invocation (no 0t Spawned ghosts)");
    const ag1 = subAgents.find((a) => a.id === "uuid-qa-1");
    const ag2 = subAgents.find((a) => a.id === "uuid-qa-2");
    assert.ok(ag1, "run 1 reconciled onto hook UUID");
    assert.ok(ag2, "run 2 reconciled onto orphan hook UUID");
    assert.equal(ag1.model, "Claude Sonnet 4.5");
    assert.equal(ag1.toolCalls, 1);
    assert.equal(ag1.status, "DONE");
    assert.equal(ag2.model, "Claude Haiku 4.5");
    assert.equal(ag2.parentAgentId, "root");
    assert.equal(ag2.status, "WORKING");

    const spawnEv1 = snap.events.find(
      (e) => e.kind === "subagent_spawn" && e.targetAgentId === "uuid-qa-1",
    );
    assert.equal(spawnEv1?.payload?.agentTranscriptPath, subTr1);
    assert.equal(spawnEv1?.payload?.prompt, "Run pass 1");
  });

  it("BUG-19 (5): openTools Map exports readable toolName as activeTool across overlapping concurrent tool calls and out-of-order completion", () => {
    const baseEpoch = 1_795_300_000;
    const events: EnrichedEvent[] = [
      {
        id: "ot-1",
        ts: toIsoTest(baseEpoch),
        epoch: baseEpoch,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-opentools",
        agentId: "root",
        kind: "tool_start",
        toolName: "read_file",
        toolCallId: "call_1111aaaa",
        summary: "Read A",
      },
      {
        id: "ot-2",
        ts: toIsoTest(baseEpoch + 1),
        epoch: baseEpoch + 1,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-opentools",
        agentId: "root",
        kind: "tool_start",
        toolName: "grep_search",
        toolCallId: "call_2222bbbb",
        summary: "Search B",
      },
      // Complete call_1111aaaa out-of-order; grep_search must remain activeTool!
      {
        id: "ot-3",
        ts: toIsoTest(baseEpoch + 2),
        epoch: baseEpoch + 2,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-opentools",
        agentId: "root",
        kind: "tool_end",
        toolName: "read_file",
        toolCallId: "call_1111aaaa",
        summary: "Completed A",
      },
    ];

    const snap1 = buildSessionSnapshot(events, {
      sessionId: "b19-opentools",
      ide: "copilot-vscode",
      nowEpochSec: baseEpoch + 3,
    });
    const root1 = snap1.agents.find((a) => a.id === "root");
    assert.equal(root1?.status, "WORKING");
    assert.equal(root1?.activeTool, "grep_search", "activeTool must be readable toolName, never call_...");

    // Now complete remaining tool without toolCallId (falls back to matching toolName)
    const snap2 = buildSessionSnapshot(
      [
        ...events,
        {
          id: "ot-4",
          ts: toIsoTest(baseEpoch + 3),
          epoch: baseEpoch + 3,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "b19-opentools",
          agentId: "root",
          kind: "tool_end",
          toolName: "grep_search",
          summary: "Completed B",
        },
      ],
      {
        sessionId: "b19-opentools",
        ide: "copilot-vscode",
        nowEpochSec: baseEpoch + 4,
      },
    );
    const root2 = snap2.agents.find((a) => a.id === "root");
    assert.equal(root2?.activeTool, undefined);
    assert.equal(root2?.status, "THINKING");
  });

  it("BUG-19 P1-1 & P1-3: isComplete:true chatSessions (pDone at turn start) + later hook tools/SubagentStop stay DONE and clear root.openTools even when merged agentId===doneAgent.id", async () => {
    const vscDir = path.join(tmpDir, "bug19-p1-13-vsc");
    const wsHash = path.join(vscDir, "ws-hash");
    const chatDir = path.join(wsHash, "chatSessions");
    await fs.mkdir(chatDir, { recursive: true });

    const baseMs = Date.parse("2026-11-25T16:00:00Z");
    const baseSec = baseMs / 1000;
    const chatFile = path.join(chatDir, "b19-complete-late-hook.json");
    await fs.writeFile(
      chatFile,
      JSON.stringify({
        sessionId: "b19-complete-late-hook",
        creationDate: baseMs,
        requests: [
          {
            requestId: "r-done-1",
            timestamp: baseMs,
            message: { text: "Run backend check" },
            response: [
              {
                kind: "prepareToolInvocation",
                toolName: "runSubagent",
                toolCallId: "tc-sub-complete-1",
              },
              {
                kind: "toolInvocationSerialized",
                toolId: "runSubagent",
                toolCallId: "tc-sub-complete-1",
                isComplete: true,
                pastTenseMessage: { value: "Finished backend check" },
                toolSpecificData: {
                  agentName: "backend-engineer",
                  prompt: "Verify API",
                },
              },
            ],
            modelState: { completedAt: baseMs + 60_000 },
          },
        ],
      }),
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const [sess] = await adapter.discoverSessions();
    assert.ok(sess);
    const passiveEvents = await adapter.parseSession(sess);

    // Live hooks arrive 10-40s later than synthetic chatSessions pDone (baseSec + 0.025)
    const hookEvents: EnrichedEvent[] = [
      {
        id: "h-late-start",
        ts: toIsoTest(baseSec + 1),
        epoch: baseSec + 1,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-complete-late-hook",
        agentId: "root",
        targetAgentId: "uuid-be-1",
        kind: "subagent_spawn",
        summary: "Spawned backend-engineer",
        payload: { agentType: "backend-engineer", agentLabel: "backend-engineer" },
      },
      {
        id: "h-late-tool-start",
        ts: toIsoTest(baseSec + 15),
        epoch: baseSec + 15,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-complete-late-hook",
        agentId: "uuid-be-1",
        parentAgentId: "root",
        agentLabel: "backend-engineer",
        kind: "tool_start",
        toolName: "read_file",
        toolCallId: "be-tc-1",
        summary: "Read file",
      },
      {
        id: "h-late-tool-end",
        ts: toIsoTest(baseSec + 20),
        epoch: baseSec + 20,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-complete-late-hook",
        agentId: "uuid-be-1",
        parentAgentId: "root",
        agentLabel: "backend-engineer",
        kind: "tool_end",
        toolName: "read_file",
        toolCallId: "be-tc-1",
        summary: "Completed Read file",
      },
      {
        id: "h-late-stop",
        ts: toIsoTest(baseSec + 40),
        epoch: baseSec + 40,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-complete-late-hook",
        agentId: "root",
        targetAgentId: "uuid-be-1",
        kind: "subagent_done",
        summary: "Completed backend-engineer",
      },
    ];

    const snap = buildSessionSnapshot([...passiveEvents, ...hookEvents], {
      sessionId: "b19-complete-late-hook",
      ide: "copilot-vscode",
      nowEpochSec: baseSec + 65,
    });
    const subAg = snap.agents.find((a) => a.id === "uuid-be-1");
    assert.ok(subAg);
    assert.equal(subAg.status, "DONE", "pDone must not rewind before hook tool calls");
    const rootAg = snap.agents.find((a) => a.id === "root");
    assert.equal(rootAg?.status, "DONE", "root must not stay stuck WORKING or WAITING");
    assert.equal(rootAg?.activeTool, undefined, "root.openTools must be cleared when subagent finishes");

    // Also verify P1-3 directly when merged subagent_done has ev.agentId === doneAgent.id (no targetAgentId) while parent holds open toolCallId
    const directSnap = buildSessionSnapshot(
      [
        {
          id: "p13-root-prep",
          ts: toIsoTest(baseSec),
          epoch: baseSec,
          ide: "copilot-vscode",
          channel: "passive",
          sessionId: "p13-direct",
          agentId: "root",
          kind: "tool_start",
          toolName: "runSubagent",
          toolCallId: "tc-parent-open",
          summary: "Preparing: runSubagent",
        },
        {
          id: "p13-spawn",
          ts: toIsoTest(baseSec + 1),
          epoch: baseSec + 1,
          ide: "copilot-vscode",
          channel: "passive",
          sessionId: "p13-direct",
          agentId: "root",
          targetAgentId: "uuid-child-1",
          kind: "subagent_spawn",
          toolName: "runSubagent",
          toolCallId: "tc-parent-open",
          summary: "Spawned child",
        },
        {
          id: "p13-done-self",
          ts: toIsoTest(baseSec + 5),
          epoch: baseSec + 5,
          ide: "copilot-vscode",
          channel: "passive",
          sessionId: "p13-direct",
          agentId: "uuid-child-1",
          parentAgentId: "root",
          kind: "subagent_done",
          toolName: "runSubagent",
          toolCallId: "tc-parent-open",
          summary: "Subagent finished",
        },
      ],
      {
        sessionId: "p13-direct",
        ide: "copilot-vscode",
        nowEpochSec: baseSec + 6,
      },
    );
    const dRoot = directSnap.agents.find((a) => a.id === "root");
    assert.equal(dRoot?.activeTool, undefined, "parent openTools cleared even when ev.agentId === doneAgent.id");
    assert.equal(directSnap.agents.find((a) => a.id === "uuid-child-1")?.status, "DONE");
  });

  it("BUG-19 P1-2: orphan hook subagent with UUID agent_id and NO agent_type/SubagentStart reconciles with passive runSubagent under readable label", async () => {
    const baseEpoch = 1_795_400_000;
    const orphanUuid = "cfccd03f-1111-4222-8333-444455556666";
    const passiveSpawn: EnrichedEvent = {
      id: "p-orphan-uuid-spawn",
      ts: toIsoTest(baseEpoch),
      epoch: baseEpoch,
      ide: "copilot-vscode",
      channel: "passive",
      sessionId: "b19-uuid-orphan",
      agentId: "root",
      targetAgentId: "qa-specialist",
      kind: "subagent_spawn",
      toolName: "runSubagent",
      toolCallId: "tc-uo-1",
      summary: "Spawned qa-specialist",
      payload: {
        agentLabel: "qa-specialist",
        agentType: "qa-specialist",
        _passiveSource: "chatSessions",
      },
    };
    const orphanTool: EnrichedEvent = {
      id: "h-orphan-uuid-tool",
      ts: toIsoTest(baseEpoch + 1),
      epoch: baseEpoch + 1,
      ide: "copilot-vscode",
      channel: "hook",
      sessionId: "b19-uuid-orphan",
      agentId: orphanUuid,
      parentAgentId: "root",
      kind: "tool_start",
      toolName: "grep_search",
      toolCallId: "h-uo-tc-1",
      summary: "PreToolUse: grep_search",
    };
    const orphanStop: EnrichedEvent = {
      id: "h-orphan-uuid-stop",
      ts: toIsoTest(baseEpoch + 3),
      epoch: baseEpoch + 3,
      ide: "copilot-vscode",
      channel: "hook",
      sessionId: "b19-uuid-orphan",
      agentId: orphanUuid,
      parentAgentId: "root",
      kind: "assistant_turn_end",
      summary: `Stop (${orphanUuid})`,
    };

    const snap = buildSessionSnapshot([passiveSpawn, orphanTool, orphanStop], {
      sessionId: "b19-uuid-orphan",
      ide: "copilot-vscode",
      nowEpochSec: baseEpoch + 5,
    });

    const subAgents = snap.agents.filter((a) => a.nodeType === "agent" && !a.isRoot);
    assert.equal(subAgents.length, 1, "UUID-only orphan must reconcile to single subagent node");
    assert.equal(subAgents[0]?.id, orphanUuid);
    assert.equal(subAgents[0]?.label, "qa-specialist");
    assert.equal(subAgents[0]?.status, "DONE");
    assert.equal(subAgents[0]?.action, "Stop (qa-specialist)");
    assert.ok(!subAgents[0]?.action.includes(orphanUuid), "must rewrite Stop (<uuid>) to Stop (<readableLabel>)");
  });

  it("BUG-19 P2-6: dual passive sources (chatSessions + transcripts/*.jsonl) + hook subagent reconcile to 1 node", async () => {
    const vscDir = path.join(tmpDir, "bug19-dual-passive-vsc");
    const wsHash = path.join(vscDir, "ws-hash");
    const chatDir = path.join(wsHash, "chatSessions");
    const trDir = path.join(wsHash, "GitHub.copilot-chat", "transcripts");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.mkdir(trDir, { recursive: true });

    const baseMs = Date.parse("2026-11-25T17:00:00Z");
    const baseSec = baseMs / 1000;

    const chatFile = path.join(chatDir, "b19-dual.json");
    await fs.writeFile(
      chatFile,
      JSON.stringify({
        sessionId: "b19-dual",
        creationDate: baseMs,
        requests: [
          {
            requestId: "r-dual-1",
            timestamp: baseMs,
            message: { text: "Verify dual passive" },
            response: [
              {
                kind: "toolInvocationSerialized",
                toolId: "runSubagent",
                toolCallId: "tc-chat-dual-1",
                isComplete: true,
                toolSpecificData: {
                  subAgentInvocationId: "chat-inv-uuid-1",
                  subAgentName: "qa-specialist",
                  model: "claude-sonnet-4-5",
                  prompt: "Run checks",
                },
              },
            ],
          },
        ],
      }),
      "utf8",
    );

    const trFile = path.join(trDir, "b19-dual.jsonl");
    await fs.writeFile(
      trFile,
      [
        {
          type: "session.start",
          timestamp: toIsoTest(baseSec),
          data: { sessionId: "b19-dual" },
        },
        {
          type: "subagent.started",
          timestamp: toIsoTest(baseSec + 1),
          data: {
            toolCallId: "tc-tr-dual-1",
            agentName: "qa-specialist",
            prompt: "Run checks",
          },
        },
        {
          type: "subagent.completed",
          timestamp: toIsoTest(baseSec + 3),
          data: {
            toolCallId: "tc-tr-dual-1",
            agentName: "qa-specialist",
            result: "All green",
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const [sess] = await adapter.discoverSessions();
    assert.ok(sess);
    const chatEvs = await adapter.parseSession(sess);
    const trEvs = await adapter.parseTranscriptFile(trFile, "b19-dual", {
      allowedRoots: [vscDir],
    });
    const hookEvents: EnrichedEvent[] = [
      {
        id: "h-dual-start",
        ts: toIsoTest(baseSec + 0.5),
        epoch: baseSec + 0.5,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-dual",
        agentId: "root",
        targetAgentId: "hook-uuid-dual-1",
        kind: "subagent_spawn",
        summary: "Spawned qa-specialist",
        payload: { agentType: "qa-specialist", agentLabel: "qa-specialist" },
      },
      {
        id: "h-dual-stop",
        ts: toIsoTest(baseSec + 4),
        epoch: baseSec + 4,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "b19-dual",
        agentId: "root",
        targetAgentId: "hook-uuid-dual-1",
        kind: "subagent_done",
        summary: "Completed qa-specialist",
      },
    ];

    const snap = buildSessionSnapshot([...chatEvs, ...trEvs, ...hookEvents], {
      sessionId: "b19-dual",
      ide: "copilot-vscode",
      nowEpochSec: baseSec + 10,
    });
    const subAgents = snap.agents.filter((a) => a.nodeType === "agent" && !a.isRoot);
    assert.equal(subAgents.length, 1, "dual passive sources + hook must reconcile to 1 node");
    assert.equal(subAgents[0]?.id, "hook-uuid-dual-1");
    assert.equal(subAgents[0]?.model, "Claude Sonnet 4.5");
    assert.equal(subAgents[0]?.status, "DONE");
  });

  it("S1-56 & BUG-20 (1): hook-emit root UUID guard, summarizeToolCall, write_agent/read_agent message edges, and Copilot inclusive usage", async () => {
    const wsDir = path.join(tmpDir, "s156-hook-ws");
    await fs.mkdir(wsDir, { recursive: true });
    const offlineFetch: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED"));

    // 1. Root UUID guard: agent_id === sessionId on copilot-vscode stays "root" (never phantom UUID)
    const rootUuidStop = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "Stop"],
      {
        stdinText: JSON.stringify({
          sessionId: "11111111-2222-3333-4444-555555555555",
          agent_id: "11111111-2222-3333-4444-555555555555",
          cwd: wsDir,
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(rootUuidStop.event?.agentId, "root");
    assert.equal(rootUuidStop.event?.parentAgentId, undefined);
    assert.equal(rootUuidStop.event?.kind, "assistant_turn_end");
    assert.equal(rootUuidStop.event?.summary, "Stop (Coordinator)");

    // parent_agent_id === sessionId resolves parentAgentId to "root"
    const subWithParentUuid = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PreToolUse"],
      {
        stdinText: JSON.stringify({
          sessionId: "11111111-2222-3333-4444-555555555555",
          agent_id: "sub-worker-99",
          parent_agent_id: "11111111-2222-3333-4444-555555555555",
          agent_type: "qa-validator",
          cwd: wsDir,
          tool_name: "view",
          tool_input: { path: "src/app.ts" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(subWithParentUuid.event?.agentId, "sub-worker-99");
    assert.equal(subWithParentUuid.event?.parentAgentId, "root");
    assert.equal(subWithParentUuid.event?.summary, "Read app.ts");

    // 2. PreToolUse / PostToolUse / PostToolUseFailure use summarizeToolCall with Completed:/Failed: prefix
    const preRead = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PreToolUse"],
      {
        stdinText: JSON.stringify({
          sessionId: "s156-h1",
          cwd: wsDir,
          tool_name: "Read",
          tool_use_id: "tc-r-1",
          tool_input: { file_path: "src/telemetry/types.ts" },
          usage: { promptTokens: 10_000, cachedTokens: 8000, completionTokens: 250 },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(preRead.event?.summary, "Read types.ts");
    assert.ok(!preRead.event?.summary.startsWith("PreToolUse:"));
    assert.equal(preRead.event?.usageDelta?.inputTokens, 2000);
    assert.equal(preRead.event?.usageDelta?.cachedTokens, 8000);
    assert.equal(preRead.event?.usageDelta?.outputTokens, 250);
    assert.equal(preRead.event?.usageDelta?.contextTokens, 10_250);

    const postOk = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PostToolUse"],
      {
        stdinText: JSON.stringify({
          sessionId: "s156-h1",
          cwd: wsDir,
          tool_name: "powershell",
          tool_use_id: "tc-ps-1",
          tool_input: { command: "npm test" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(postOk.event?.summary, "Completed: Ran unit tests");

    const postFail = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PostToolUseFailure"],
      {
        stdinText: JSON.stringify({
          sessionId: "s156-h1",
          cwd: wsDir,
          tool_name: "copilot_replaceString",
          tool_use_id: "tc-rep-1",
          tool_input: { filePath: "src/index.ts" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(postFail.event?.summary, "Failed: Edited index.ts");

    // 3. write_agent & read_agent promote to kind="message" with targetAgentId edge
    const writeAg = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PreToolUse"],
      {
        stdinText: JSON.stringify({
          sessionId: "s156-h1",
          cwd: wsDir,
          tool_name: "write_agent",
          tool_use_id: "tc-wa-1",
          tool_input: { agent_id: "backend-engineer", message: "Implement API" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(writeAg.event?.kind, "message");
    assert.equal(writeAg.event?.targetAgentId, "backend-engineer");
    assert.match(writeAg.event?.summary ?? "", /Message backend-engineer: Implement API/);

    const readAg = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PreToolUse"],
      {
        stdinText: JSON.stringify({
          sessionId: "s156-h1",
          cwd: wsDir,
          tool_name: "read_agent",
          tool_use_id: "tc-ra-1",
          tool_input: { agent_id: "backend-engineer" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(readAg.event?.kind, "message");
    assert.equal(readAg.event?.targetAgentId, "backend-engineer");

    const msgSnap = buildSessionSnapshot([writeAg.event!, readAg.event!], {
      sessionId: "s156-h1",
      ide: "copilot-vscode",
      nowEpochSec: Date.now() / 1000 + 2,
    });
    assert.ok(
      msgSnap.edges.some((e) => e.from === "root" && e.to === "backend-engineer" && e.lastKind === "message"),
      "write_agent/read_agent must create root -> target message edge",
    );
    assert.equal(
      msgSnap.agents.some((a) => a.id.startsWith("ext:")),
      false,
      "write_agent/read_agent must return null external target",
    );
  });

  it("S1-56 (2): cleanHumanSummary empty-label file:// links, expanded Copilot tools & classification, and inferContextWindow alignment", () => {
    assert.equal(
      cleanHumanSummary("Check [](file:///d:/repo/src/app.ts#L10-L20) and [types.ts](file:///d:/repo/types.ts)", 140),
      "Check app.ts and types.ts",
    );
    assert.equal(
      cleanHumanSummary("[](file:///c%3A/My%20Repo/my%20file.ts)", 140),
      "my file.ts",
    );
    assert.ok(!cleanHumanSummary("[](file:///d:/repo/app.ts)", 140).includes("file://"));

    // Expanded VS Code / Copilot tools: classification & summaries
    const fsTools: Array<[string, Record<string, unknown>, string]> = [
      ["view", { path: "src/view.ts" }, "Read view.ts"],
      ["rg", { query: "normalizeCopilotUsage" }, "Search: normalizeCopilotUsage"],
      ["glob", { pattern: "**/*.ts" }, "Find files: **/*.ts"],
      ["apply_patch", { filePath: "src/patch.ts" }, "Edited patch.ts"],
      ["copilot_replaceString", { filePath: "src/rep.ts" }, "Edited rep.ts"],
      ["copilot_multiReplaceString", { filePath: "src/mrep.ts" }, "Edited mrep.ts"],
      ["copilot_findFiles", { query: "*.md" }, "Find files: *.md"],
      ["copilot_findTextInFiles", { query: "TODO" }, "Search: TODO"],
      ["copilot_listDirectory", { path: "src/telemetry" }, "Listed telemetry"],
      ["copilot_searchCodebase", { query: "auth flow" }, "Codebase search: auth flow"],
      ["copilot_getErrors", { filePath: "src/bad.ts" }, "Checked errors: bad.ts"],
      ["edit/editFiles", { filePath: "src/e.ts" }, "Edited e.ts"],
    ];
    for (const [tname, args, expectedSum] of fsTools) {
      assert.equal(classifyExternalTool(tname, args)?.id, "ext:fs", `${tname} -> ext:fs`);
      assert.equal(summarizeToolCall(tname, args), expectedSum);
    }

    assert.equal(classifyExternalTool("powershell")?.id, "ext:shell");
    assert.equal(classifyExternalTool("execute/runInTerminal")?.id, "ext:shell");
    assert.equal(summarizeToolCall("powershell", { command: "git status" }), "Checked git status");
    assert.equal(summarizeToolCall("execute/runInTerminal", { command: "npm run check" }), "Ran TypeScript typecheck");

    for (const internalTool of ["sql", "skill", "tool_search_tool", "rename_chat", "manage_todo_list", "write_agent", "read_agent"]) {
      assert.equal(classifyExternalTool(internalTool), null, `${internalTool} -> null`);
    }
    assert.equal(summarizeToolCall("sql", { description: "List tasks" }), "SQL: List tasks");
    assert.equal(summarizeToolCall("skill", { name: "qa-validation" }), "Loaded skill: qa-validation");
    assert.equal(summarizeToolCall("tool_search_tool", { query: "board" }), "Search tools: board");
    assert.equal(summarizeToolCall("rename_chat", { title: "Usage Fix" }), "Renamed chat: Usage Fix");
    assert.equal(summarizeToolCall("manage_todo_list", {}), "Updated todo list");

    // inferContextWindow alignment
    assert.equal(inferContextWindow("GPT-5.2 Astra"), 400_000);
    assert.equal(inferContextWindow("gpt 5 mini"), 400_000);
    assert.equal(inferContextWindow("gpt-6-preview"), 400_000);
    assert.equal(inferContextWindow("gpt-4.1"), 1_000_000);
    assert.equal(inferContextWindow("gpt-4o"), 128_000);
    assert.equal(inferContextWindow("o4-mini"), 128_000);
    assert.equal(inferContextWindow("claude-opus-4-6[1m]"), 1_000_000);
  });

  it("BUG-20 & S1-56 (3): events.jsonl mixed incremental + cumulative (session.usage_checkpoint/session.shutdown), Anthropic vs OpenAI format, and rich assistant.message prose", async () => {
    const vscDir = path.join(tmpDir, "vsc-events-jsonl");
    const trDir = path.join(vscDir, "ws1", "GitHub.copilot-chat", "transcripts");
    await fs.mkdir(trDir, { recursive: true });

    // 1. Mixed incremental + session.usage_checkpoint + session.shutdown (must NOT double-count)
    const mixedFile = path.join(trDir, "mixed-usage.jsonl");
    await fs.writeFile(
      mixedFile,
      [
        {
          type: "session.start",
          timestamp: "2026-11-25T18:00:00Z",
          data: { sessionId: "mixed-u1", selectedModel: "claude-sonnet-4.5" },
        },
        {
          type: "user.message",
          timestamp: "2026-11-25T18:00:01Z",
          data: { content: "Inspect [](file:///d:/repo/server.ts)" },
        },
        {
          type: "assistant.message",
          timestamp: "2026-11-25T18:00:02Z",
          data: {
            content: "Reading server implementation now.",
            toolRequests: [
              { name: "view", toolCallId: "tr-v-1", arguments: { path: "src/server.ts" } },
            ],
            usage: { promptTokens: 20_000, cachedTokens: 15_000, completionTokens: 400 },
          },
        },
        {
          type: "tool.execution_complete",
          timestamp: "2026-11-25T18:00:03Z",
          data: { toolCallId: "tr-v-1", toolName: "view", success: true },
        },
        {
          type: "assistant.usage",
          timestamp: "2026-11-25T18:00:04Z",
          data: { inputTokens: 25_000, cacheReadTokens: 18_000, outputTokens: 600 },
        },
        {
          type: "assistant.message",
          timestamp: "2026-11-25T18:00:05Z",
          data: { content: "Server looks healthy." },
        },
        {
          // Same turn already emitted prose completion -> duplicate Turn completed must be suppressed
          type: "assistant.turn_end",
          timestamp: "2026-11-25T18:00:06Z",
          data: {},
        },
        {
          type: "session.usage_checkpoint",
          timestamp: "2026-11-25T18:00:07Z",
          data: {
            currentTokens: 23_400,
            tokenLimit: 271_805,
            inputTokens: 45_000,
            cachedTokens: 33_000,
            outputTokens: 1000,
          },
        },
        {
          type: "session.shutdown",
          timestamp: "2026-11-25T18:00:08Z",
          data: {
            modelMetrics: {
              "claude-sonnet-4.5": {
                usage: {
                  inputTokens: 45_000,
                  outputTokens: 1000,
                  cacheReadTokens: 33_000,
                },
              },
            },
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const mixedEvs = await adapter.parseTranscriptFile(mixedFile, "mixed-u1", {
      allowedRoots: [vscDir],
    });
    // assistant.message with content + toolRequests emits thinking_start before tool_start
    const thinkEv = mixedEvs.find((e) => e.kind === "thinking_start");
    assert.ok(thinkEv, "assistant.message with content + toolRequests must emit thinking_start");
    assert.equal(thinkEv.summary, "Reading server implementation now.");
    // Duplicate assistant.turn_end suppressed
    const turnEnds = mixedEvs.filter((e) => e.kind === "assistant_turn_end");
    assert.equal(turnEnds.length, 1);
    assert.equal(turnEnds[0]?.summary, "Server looks healthy.");

    const mixedSnap = buildSessionSnapshot(mixedEvs, {
      sessionId: "mixed-u1",
      ide: "copilot-vscode",
      nowEpochSec: Date.parse("2026-11-25T18:00:10Z") / 1000,
    });
    const mRoot = mixedSnap.agents.find((a) => a.id === "root");
    // Incremental sum: Turn1 fresh (20k-15k=5k) + Turn2 fresh (25k-18k=7k) = 12k; cached = 33k; out = 1000
    assert.equal(mRoot?.usage?.inputTokens, 12_000);
    assert.equal(mRoot?.usage?.cachedTokens, 33_000);
    assert.equal(mRoot?.usage?.outputTokens, 1000);
    assert.equal(mRoot?.usage?.totalTokens, 46_000);
    // contextTokens uses checkpoint currentTokens (23_400), NOT shutdown cumulative totals
    assert.equal(mRoot?.usage?.contextTokens, 23_400);
    assert.equal(mRoot?.usage?.contextWindow, 271_805);

    // 2. Cumulative-only fallback (0 incremental rows) + Anthropic raw format (inTok < cachedTok)
    const cumOnlyFile = path.join(trDir, "cum-only.jsonl");
    await fs.writeFile(
      cumOnlyFile,
      [
        {
          type: "session.start",
          timestamp: "2026-11-25T18:05:00Z",
          data: { sessionId: "cum-u2" },
        },
        {
          type: "user.message",
          timestamp: "2026-11-25T18:05:01Z",
          data: { content: "Summarize" },
        },
        {
          type: "session.usage_checkpoint",
          timestamp: "2026-11-25T18:05:02Z",
          data: { currentTokens: 19_500, tokenLimit: 921_805 },
        },
        {
          type: "session.shutdown",
          timestamp: "2026-11-25T18:05:03Z",
          data: {
            modelMetrics: {
              "claude-opus-4.5": {
                usage: {
                  inputTokens: 1500,
                  outputTokens: 500,
                  cacheReadTokens: 18_000,
                },
              },
            },
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );
    const cumEvs = await adapter.parseTranscriptFile(cumOnlyFile, "cum-u2", {
      allowedRoots: [vscDir],
    });
    const cumSnap = buildSessionSnapshot(cumEvs, {
      sessionId: "cum-u2",
      ide: "copilot-vscode",
      nowEpochSec: Date.parse("2026-11-25T18:05:10Z") / 1000,
    });
    const cRoot = cumSnap.agents.find((a) => a.id === "root");
    assert.equal(cRoot?.model, "Claude Opus 4.5");
    assert.equal(cRoot?.usage?.inputTokens, 1500, "inTok < cachedTok preserves raw fresh input");
    assert.equal(cRoot?.usage?.cachedTokens, 18_000);
    assert.equal(cRoot?.usage?.outputTokens, 500);
    assert.equal(cRoot?.usage?.totalTokens, 20_000);
    assert.equal(cRoot?.usage?.contextTokens, 19_500);
    assert.equal(cRoot?.usage?.contextWindow, 921_805);
  });

  it("BUG-20 & S1-56 (4): chatSessions maxInputTokens, completionTokens-only turn preserves toolCallRounds, rich items, and non-cumulative fallback", async () => {
    const vscDir = path.join(tmpDir, "vsc-chat-b20");
    const chatDir = path.join(vscDir, "ws1", "chatSessions");
    await fs.mkdir(chatDir, { recursive: true });
    const baseMs = Date.parse("2026-11-25T19:00:00Z");

    // 1. Exact usage + maxInputTokens (135805) + completionTokens-only turn + rich items
    await fs.writeFile(
      path.join(chatDir, "chat-rich-1.json"),
      JSON.stringify({
        sessionId: "chat-rich-1",
        creationDate: baseMs,
        inputState: {
          selectedModel: {
            id: "copilot/gpt-5",
            metadata: { id: "gpt-5", maxInputTokens: 135_805 },
          },
        },
        requests: [
          {
            requestId: "cr-1",
            timestamp: baseMs,
            message: { text: "Check [](file:///d:/repo/src/widget.ts)" },
            completionTokens: 422,
            response: [
              {
                kind: "thinking",
                generatedTitle: "Analyzing widget layout",
                value: "Detailed internal reasoning about widget padding and grid alignment.",
              },
              {
                kind: "textEditGroup",
                uri: { fsPath: "d:\\repo\\src\\widget.ts" },
              },
              {
                kind: "markdownContent",
                value: "Updated widget layout in [widget.ts](file:///d:/repo/src/widget.ts).",
              },
            ],
            modelState: { completedAt: baseMs + 2000 },
            result: {
              metadata: {
                toolCallRounds: [
                  {
                    usage: {
                      promptTokens: 30_000,
                      cachedTokens: 20_000,
                      completionTokens: 422,
                    },
                  },
                ],
              },
            },
          },
          {
            // Turn 2 has bare completionTokens ONLY (no promptTokens/roundUsages) -> must preserve Turn 1 contextTokens!
            requestId: "cr-2",
            timestamp: baseMs + 5000,
            message: { text: "Looks good?" },
            completionTokens: 150,
            response: [{ kind: "markdownContent", value: "All verified." }],
            modelState: { completedAt: baseMs + 6000 },
          },
        ],
      }),
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const sessions = await adapter.discoverSessions();
    const s1 = sessions.find((s) => s.sessionId === "chat-rich-1");
    assert.ok(s1);
    const evs1 = await adapter.parseSession(s1);
    assert.ok(evs1.some((e) => e.kind === "user_input" && e.summary === "Human: Check widget.ts"));
    const thinkEv = evs1.find((e) => e.kind === "thinking_start");
    assert.equal(thinkEv?.summary, "Analyzing widget layout");
    assert.ok((thinkEv?.bodyLength ?? 0) > 20);
    assert.ok(evs1.some((e) => e.kind === "tool_start" && e.summary === "Edit widget.ts"));
    assert.ok(evs1.some((e) => e.kind === "assistant_turn_end" && e.summary === "Updated widget layout in widget.ts."));

    const snap1 = buildSessionSnapshot(evs1, {
      sessionId: "chat-rich-1",
      ide: "copilot-vscode",
      nowEpochSec: (baseMs + 10_000) / 1000,
    });
    const r1 = snap1.agents.find((a) => a.id === "root");
    assert.equal(r1?.usage?.contextWindow, 135_805);
    assert.equal(r1?.usage?.inputTokens, 10_000, "roundUsages promptTokens minus cachedTokens");
    assert.equal(r1?.usage?.cachedTokens, 20_000);
    assert.equal(r1?.usage?.outputTokens, 572, "422 + 150");
    assert.equal(r1?.usage?.contextTokens, 30_422, "completionTokens-only Turn 2 must NOT overwrite Turn 1 contextTokens with 150");

    // 2. Fallback estimation without exact usage: never JSON.stringify(req.response), non-cumulative across turns
    const hugeToolPayload = "X".repeat(20_000);
    await fs.writeFile(
      path.join(chatDir, "chat-est-2.json"),
      JSON.stringify({
        sessionId: "chat-est-2",
        creationDate: baseMs + 20_000,
        requests: [
          {
            requestId: "er-1",
            timestamp: baseMs + 20_000,
            message: { text: "First question" },
            response: [
              {
                kind: "toolInvocationSerialized",
                toolId: "copilot_readFile",
                toolCallId: "e-tc-1",
                isComplete: true,
                pastTenseMessage: { value: "Read big.ts" },
                toolSpecificData: { hugeBlob: hugeToolPayload },
                resultDetails: hugeToolPayload,
              },
            ],
            modelState: { completedAt: baseMs + 21_000 },
          },
          {
            requestId: "er-2",
            timestamp: baseMs + 25_000,
            message: { text: "Second short turn" },
            response: [{ kind: "markdownContent", value: "Short answer." }],
            modelState: { completedAt: baseMs + 26_000 },
          },
        ],
      }),
      "utf8",
    );
    const sessions2 = await adapter.discoverSessions();
    const s2 = sessions2.find((s) => s.sessionId === "chat-est-2");
    assert.ok(s2);
    const snap2 = buildSessionSnapshot(await adapter.parseSession(s2), {
      sessionId: "chat-est-2",
      ide: "copilot-vscode",
      nowEpochSec: (baseMs + 30_000) / 1000,
    });
    const r2 = snap2.agents.find((a) => a.id === "root");
    assert.equal(r2?.usage?.usageSource, "estimated");
    assert.ok(
      (r2?.usage?.totalTokens ?? 9999) < 100,
      `huge toolSpecificData/resultDetails must not inflate estimated tokens (got ${r2?.usage?.totalTokens})`,
    );
  });

  it("S1-56 & BUG-20 (5): normalizer canonicalDedupToolName Tier-2 dedup, VS Code Synced Data subagent reconciliation, and non-cumulative fallback cap", () => {
    // 1. canonicalDedupToolName mapping
    assert.equal(canonicalDedupToolName("Read"), "fs_read");
    assert.equal(canonicalDedupToolName("view"), "fs_read");
    assert.equal(canonicalDedupToolName("copilot_readFile"), "fs_read");
    assert.equal(canonicalDedupToolName("Bash"), "shell");
    assert.equal(canonicalDedupToolName("powershell"), "shell");
    assert.equal(canonicalDedupToolName("run_in_terminal"), "shell");
    assert.equal(canonicalDedupToolName("Edit"), "fs_edit");
    assert.equal(canonicalDedupToolName("apply_patch"), "fs_edit");
    assert.equal(canonicalDedupToolName("copilot_replaceString"), "fs_edit");
    assert.equal(canonicalDedupToolName("Grep"), "fs_search");
    assert.equal(canonicalDedupToolName("rg"), "fs_search");
    assert.equal(canonicalDedupToolName("copilot_findTextInFiles"), "fs_search");
    assert.equal(canonicalDedupToolName("Glob"), "fs_glob");
    assert.equal(canonicalDedupToolName("glob"), "fs_glob");
    assert.equal(canonicalDedupToolName("copilot_findFiles"), "fs_glob");
    assert.equal(canonicalDedupToolName("Agent"), "subagent");
    assert.equal(canonicalDedupToolName("runSubagent"), "subagent");

    // Cross-channel Tier-2 dedup across tool aliases without toolCallId
    const ep = 1_796_000_000;
    const deduped = deduplicateEvents([
      {
        id: "h-view-1",
        ts: toIsoTest(ep),
        epoch: ep,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "alias-s1",
        agentId: "root",
        kind: "tool_start",
        toolName: "view",
        summary: "Read app.ts",
      },
      {
        id: "p-copilot-read-1",
        ts: toIsoTest(ep + 0.8),
        epoch: ep + 0.8,
        ide: "copilot-vscode",
        channel: "passive",
        sessionId: "alias-s1",
        agentId: "root",
        kind: "tool_start",
        toolName: "copilot_readFile",
        summary: "Read src/app.ts",
      },
    ]);
    assert.equal(deduped.length, 1, "Tier-2 alias pair (view vs copilot_readFile) must merge");

    // 2. "VS Code Synced Data:break-glass" vs "BreakGlass" reconciliation
    const recSnap = buildSessionSnapshot(
      [
        {
          id: "p-bg-spawn",
          ts: toIsoTest(ep),
          epoch: ep,
          ide: "copilot-vscode",
          channel: "passive",
          sessionId: "ns-s1",
          agentId: "root",
          targetAgentId: "vs-code-synced-data-break-glass",
          kind: "subagent_spawn",
          toolName: "runSubagent",
          summary: "Spawned VS Code Synced Data:break-glass",
          payload: {
            agentLabel: "VS Code Synced Data:break-glass",
            _passiveSource: "chatSessions",
          },
        },
        {
          id: "h-bg-spawn",
          ts: toIsoTest(ep + 0.5),
          epoch: ep + 0.5,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "ns-s1",
          agentId: "root",
          targetAgentId: "uuid-breakglass-1",
          kind: "subagent_spawn",
          summary: "Spawned BreakGlass",
          payload: { agentLabel: "BreakGlass", agentType: "BreakGlass" },
        },
      ],
      { sessionId: "ns-s1", ide: "copilot-vscode", nowEpochSec: ep + 3 },
    );
    const recSubs = recSnap.agents.filter((a) => a.nodeType === "agent" && !a.isRoot);
    assert.equal(recSubs.length, 1, "VS Code Synced Data:break-glass and BreakGlass must reconcile to 1 node");
    assert.equal(recSubs[0]?.id, "uuid-breakglass-1");
    assert.equal(recSubs[0]?.label, "BreakGlass");

    // 3. Normalizer non-cumulative fallback cap (2000/event + latest user_input turn + bounded prior prose)
    const fbNormSnap = buildSessionSnapshot(
      [
        {
          id: "nf-u1",
          ts: toIsoTest(ep),
          epoch: ep,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "nf-s1",
          agentId: "root",
          kind: "user_input",
          summary: "Human: Turn 1",
          payload: { body: "P".repeat(8000) },
        },
        {
          id: "nf-t1",
          ts: toIsoTest(ep + 1),
          epoch: ep + 1,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "nf-s1",
          agentId: "root",
          kind: "tool_end",
          toolName: "read_file",
          summary: "Completed: Read huge.ts",
          payload: { toolResult: "R".repeat(30_000) },
        },
        {
          id: "nf-u2",
          ts: toIsoTest(ep + 10),
          epoch: ep + 10,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "nf-s1",
          agentId: "root",
          kind: "user_input",
          summary: "Human: Turn 2",
          payload: { body: "Q".repeat(400) },
        },
      ],
      { sessionId: "nf-s1", ide: "copilot-vscode", nowEpochSec: ep + 12 },
    );
    const nfRoot = fbNormSnap.agents.find((a) => a.id === "root");
    // Turn 1 prose capped at 2000/event, Turn 1 tool_end excluded from prior prose, Turn 2 = 400 -> (2000 + 400)/4 = 600
    assert.equal(nfRoot?.usage?.contextTokens, 600);
  });

  it("BUG-20 P1 & P2: incremental hook-emit deltas never inflate contextTokens cumulatively, completionTokens-only preserves prior context, [](file:///) -> link, and standalone checkpoint currentTokens", async () => {
    // 1. P2: [](file:///) returns "link" instead of "file:"
    assert.equal(cleanHumanSummary("See [](file:///)", 140), "See link");

    // 2. P1: incremental hook-emit deltas (isTotal omitted) in buildSessionSnapshot
    const wsDir = path.join(tmpDir, "b20-p1-ws");
    await fs.mkdir(wsDir, { recursive: true });
    const offlineFetch: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED"));

    const hTurn1 = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PostToolUse"],
      {
        stdinText: JSON.stringify({
          sessionId: "b20-inc-s1",
          cwd: wsDir,
          tool_name: "view",
          tool_call_id: "inc-tc-1",
          tool_input: { path: "src/a.ts" },
          usage: { promptTokens: 20_000, cachedTokens: 15_000, completionTokens: 500 },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const hTurn2 = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PostToolUse"],
      {
        stdinText: JSON.stringify({
          sessionId: "b20-inc-s1",
          cwd: wsDir,
          tool_name: "view",
          tool_call_id: "inc-tc-2",
          tool_input: { path: "src/b.ts" },
          usage: { promptTokens: 12_000, cachedTokens: 8000, completionTokens: 300 },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const hCompOnly = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "Stop"],
      {
        stdinText: JSON.stringify({
          sessionId: "b20-inc-s1",
          cwd: wsDir,
          usage: { completionTokens: 422 },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    // Synthetic incremental delta without explicit contextTokens (tests normalizer else-if branch)
    const rawIncDeltaEv: EnrichedEvent = {
      id: "raw-inc-no-ctx",
      ts: toIsoTest(1_797_000_000),
      epoch: 1_797_000_000,
      ide: "copilot-vscode",
      channel: "hook",
      sessionId: "b20-inc-noctx",
      agentId: "root",
      kind: "tool_end",
      toolName: "view",
      summary: "Completed: Read c.ts",
      usageDelta: {
        usageSource: "exact",
        inputTokens: 4000,
        cachedTokens: 6000,
        outputTokens: 200,
      },
    };
    const rawCompOnlyEv: EnrichedEvent = {
      id: "raw-comp-only",
      ts: toIsoTest(1_797_000_005),
      epoch: 1_797_000_005,
      ide: "copilot-vscode",
      channel: "hook",
      sessionId: "b20-inc-noctx",
      agentId: "root",
      kind: "assistant_turn_end",
      summary: "Turn completed",
      usageDelta: {
        usageSource: "exact",
        outputTokens: 422,
      },
    };

    const hookSnap = buildSessionSnapshot(
      [hTurn1.event!, hTurn2.event!, hCompOnly.event!],
      {
        sessionId: "b20-inc-s1",
        ide: "copilot-vscode",
        nowEpochSec: Date.now() / 1000 + 5,
      },
    );
    const hRoot = hookSnap.agents.find((a) => a.id === "root");
    // Fresh input = (20k-15k) + (12k-8k) = 9000; cached = 23000; output = 500+300+422 = 1222
    assert.equal(hRoot?.usage?.inputTokens, 9000);
    assert.equal(hRoot?.usage?.cachedTokens, 23_000);
    assert.equal(hRoot?.usage?.outputTokens, 1222);
    // Turn 2 active context = 12300 (smaller than Turn 1's 20500, and NOT overwritten by 422 or summed to 32800)
    assert.equal(hRoot?.usage?.contextTokens, 12_300);

    const noCtxSnap = buildSessionSnapshot(
      [
        { ...rawIncDeltaEv, id: "raw-inc-prev", epoch: 1_796_999_990, ts: toIsoTest(1_796_999_990), usageDelta: { usageSource: "exact", inputTokens: 8000, cachedTokens: 10_000, outputTokens: 100 } },
        rawIncDeltaEv,
        rawCompOnlyEv,
      ],
      {
        sessionId: "b20-inc-noctx",
        ide: "copilot-vscode",
        nowEpochSec: 1_797_000_010,
      },
    );
    const ncRoot = noCtxSnap.agents.find((a) => a.id === "root");
    assert.equal(ncRoot?.usage?.inputTokens, 12_000);
    assert.equal(ncRoot?.usage?.cachedTokens, 16_000);
    assert.equal(ncRoot?.usage?.outputTokens, 722);
    assert.equal(ncRoot?.usage?.contextTokens, 10_200, "else-if active turn = 4000 + 6000 + 200, preserved across completionTokens-only turn");

    // 3. P2: extractUriBasename strips ?query#hash and standalone session.usage_checkpoint currentTokens sets hasExact
    const vscDir = path.join(tmpDir, "b20-p2-vsc");
    const chatDir = path.join(vscDir, "ws1", "chatSessions");
    const trDir = path.join(vscDir, "ws1", "GitHub.copilot-chat", "transcripts");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.mkdir(trDir, { recursive: true });

    const baseMs = Date.parse("2026-11-25T20:00:00Z");
    await fs.writeFile(
      path.join(chatDir, "uri-q.json"),
      JSON.stringify({
        sessionId: "uri-q",
        creationDate: baseMs,
        requests: [
          {
            requestId: "uq-1",
            timestamp: baseMs,
            message: { text: "Edit file" },
            response: [
              {
                kind: "textEditGroup",
                uri: { external: "file:///d%3A/repo/src/clean.ts?v=1#L12" },
              },
            ],
            modelState: { completedAt: baseMs + 1000 },
          },
        ],
      }),
      "utf8",
    );
    const trOnlyCk = path.join(trDir, "ck-only.jsonl");
    await fs.writeFile(
      trOnlyCk,
      [
        { type: "session.start", timestamp: "2026-11-25T20:05:00Z", data: { sessionId: "ck-only" } },
        { type: "user.message", timestamp: "2026-11-25T20:05:01Z", data: { content: "Check" } },
        {
          type: "session.usage_checkpoint",
          timestamp: "2026-11-25T20:05:02Z",
          data: { currentTokens: 15_000, tokenLimit: 200_000 },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const chatEvs = await adapter.parseSession({
      ide: "copilot-vscode",
      sessionId: "uri-q",
      filePath: path.join(chatDir, "uri-q.json"),
      workspaces: [],
      mtimeMs: baseMs,
      sizeBytes: 100,
      isMultiAgent: false,
    });
    assert.ok(chatEvs.some((e) => e.summary === "Edit clean.ts"));

    const ckEvs = await adapter.parseTranscriptFile(trOnlyCk, "ck-only", {
      allowedRoots: [vscDir],
    });
    const ckSnap = buildSessionSnapshot(ckEvs, {
      sessionId: "ck-only",
      ide: "copilot-vscode",
      nowEpochSec: Date.parse("2026-11-25T20:05:10Z") / 1000,
    });
    const ckRoot = ckSnap.agents.find((a) => a.id === "root");
    assert.equal(ckRoot?.usage?.contextTokens, 15_000);
    assert.equal(ckRoot?.usage?.contextWindow, 200_000);
  });

  it("BUG-21: guards UUID/spaced-hex labels, propagates SubagentStart labels across PushBus + child transcripts, expands hook-emit keys, and reconciles parallel/non-spawn Copilot subagents", async () => {
    // 1. isOpaqueAgentId + prettifyAgentLabel UUID & spaced-hex guard
    const rawUuid = "08b84ac1-a4b4-4b2c-9abc-1234567890ef";
    assert.equal(isOpaqueAgentId(rawUuid), true);
    assert.equal(isOpaqueAgentId("08b84ac1 A4b4 4b2c 9abc "), true);
    assert.equal(isOpaqueAgentId("agent-08b84ac1a4b4"), true);
    assert.equal(isOpaqueAgentId("qa-specialist"), false);
    assert.equal(isOpaqueAgentId("agent-1"), false);
    assert.equal(prettifyAgentLabel(rawUuid), "Subagent");
    assert.equal(prettifyAgentLabel("08b84ac1 A4b4 4b2c 9abc "), "Subagent");
    assert.equal(prettifyAgentLabel("qa-specialist"), "QA Specialist");
    assert.equal(prettifyAgentLabel("agent-1"), "Agent 1");

    // 2. CopilotVSCodeAdapter.parseTranscriptFile omits opaque agentLabel when rows lack agentName/agentType
    const wsDir = path.join(tmpDir, "bug21-ws");
    await fs.mkdir(wsDir, { recursive: true });
    const subTrPath = path.join(wsDir, "sub-08b84ac1.jsonl");
    await fs.writeFile(
      subTrPath,
      [
        {
          type: "user.message",
          timestamp: "2026-11-25T21:00:01Z",
          data: { content: "Investigate telemetry" },
        },
        {
          type: "assistant.message",
          timestamp: "2026-11-25T21:00:02Z",
          data: { content: "Found root cause." },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );
    const adapter = new CopilotVSCodeAdapter({ storageDir: path.join(tmpDir, "bug21-vsc") });
    const rawSubEvs = await adapter.parseTranscriptFile(subTrPath, "b21-s1", {
      agentIdOverride: rawUuid,
      allowedRoots: [wsDir],
    });
    assert.ok(rawSubEvs.length >= 2);
    assert.equal(rawSubEvs[0]?.agentLabel, undefined);

    // 3. PushBus shares parentSessionId -> child hooks inherit agentLabel, out-of-order backfills, and loadPushTranscriptEvents passes agentLabelOverride
    const bus = new PushBus({ includeGlobalTelemetryFile: false });
    const childUuid2 = "11223344-5566-4777-8888-99aabbccdde0";
    // Out-of-order child hook before SubagentStart
    bus.ingest([
      {
        id: "b21-child-pre",
        ts: "2026-11-25T21:00:00.500Z",
        ide: "copilot-vscode",
        sessionId: "b21-parent",
        agentId: childUuid2,
        kind: "tool_start",
        toolName: "read_file",
        summary: "Read src/index.ts",
      },
      {
        id: "b21-spawn-1",
        ts: "2026-11-25T21:00:00.000Z",
        ide: "copilot-vscode",
        sessionId: "b21-parent",
        agentId: "root",
        targetAgentId: rawUuid,
        kind: "subagent_spawn",
        summary: "Spawned Researcher",
        payload: {
          agentType: "Researcher",
          agentLabel: "Researcher",
          agentTranscriptPath: subTrPath,
        },
      },
      {
        id: "b21-spawn-2",
        ts: "2026-11-25T21:00:00.800Z",
        ide: "copilot-vscode",
        sessionId: "b21-parent",
        agentId: "root",
        targetAgentId: childUuid2,
        kind: "subagent_spawn",
        summary: "Spawned Code Reviewer",
        payload: {
          agentType: "Code Reviewer",
          agentLabel: "Code Reviewer",
        },
      },
      {
        id: "b21-child-same-sid",
        ts: "2026-11-25T21:00:01.000Z",
        ide: "copilot-vscode",
        sessionId: "b21-parent",
        agentId: childUuid2,
        agentLabel: "08b84ac1 A4b4 4b2c 9abc ",
        kind: "tool_start",
        toolName: "grep_search",
        summary: "Search refs",
      },
    ]);
    assert.equal(bus.getAgentLabel("b21-parent", rawUuid), "Researcher");
    const parentEvs = bus.getSessionEvents("b21-parent");
    assert.equal(
      parentEvs.find((e) => e.id === "b21-child-pre")?.agentLabel,
      "Code Reviewer",
    );
    const sameSidEv = parentEvs.find((e) => e.id === "b21-child-same-sid");
    assert.equal(sameSidEv?.agentLabel, "Code Reviewer");
    assert.equal(sameSidEv?.parentAgentId, "root");

    const agg = new TelemetryAggregator({
      brainDir: path.join(tmpDir, "empty-brain"),
      claudeDir: path.join(tmpDir, "empty-claude"),
      vscodeDir: path.join(tmpDir, "bug21-vsc"),
      includeGlobalTelemetryFile: false,
    });
    agg.pushBus.ingest([
      {
        id: "agg-b21-spawn",
        ts: "2026-11-25T21:00:00.000Z",
        ide: "copilot-vscode",
        sessionId: "b21-agg-s",
        workspacePath: wsDir,
        agentId: "root",
        targetAgentId: rawUuid,
        kind: "subagent_spawn",
        summary: "Spawned Researcher",
        payload: {
          agentType: "Researcher",
          agentLabel: "Researcher",
          agentTranscriptPath: subTrPath,
        },
      },
    ]);
    const aggRes = await agg.getSessionSnapshot("b21-agg-s", { ide: "copilot-vscode" });
    const aggChild = aggRes.snapshot.agents.find((a) => a.id === rawUuid);
    assert.equal(aggChild?.label, "Researcher");

    // 4. hook-emit expands subagent_name / subagent_type / role and guards opaque UUIDs
    const offlineFetch: typeof fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const emitSubName = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "SubagentStart"],
      {
        stdinText: JSON.stringify({
          session_id: "b21-hook-s",
          agent_id: rawUuid,
          agent_name: rawUuid,
          subagent_name: "Security Auditor",
          cwd: wsDir,
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(emitSubName.event?.payload?.agentLabel, "Security Auditor");
    assert.equal(emitSubName.event?.summary, "Spawned Security Auditor");

    const emitUuidOnly = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "SubagentStart"],
      {
        stdinText: JSON.stringify({
          session_id: "b21-hook-s",
          agent_id: rawUuid,
          cwd: wsDir,
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(emitUuidOnly.event?.payload?.agentLabel, undefined);
    assert.equal(emitUuidOnly.event?.summary, "Spawned Subagent");

    // 5. Normalizer: spaced-hex label cleanup + passive non-spawn reconciliation + parallel spawn reconciliation
    const baseEp = 1_795_600_000;
    const parallelSnap = buildSessionSnapshot(
      [
        {
          id: "p-par-1",
          ts: toIsoTest(baseEp),
          epoch: baseEp,
          ide: "copilot-vscode",
          channel: "passive",
          sessionId: "b21-par",
          agentId: "root",
          targetAgentId: "qa-specialist",
          kind: "subagent_spawn",
          toolName: "runSubagent",
          summary: "Spawned qa-specialist",
          payload: { agentLabel: "qa-specialist", _passiveSource: "chatSessions" },
        },
        {
          id: "p-par-2",
          ts: toIsoTest(baseEp + 0.2),
          epoch: baseEp + 0.2,
          ide: "copilot-vscode",
          channel: "passive",
          sessionId: "b21-par",
          agentId: "root",
          targetAgentId: "backend-engineer",
          kind: "subagent_spawn",
          toolName: "runSubagent",
          summary: "Spawned backend-engineer",
          payload: { agentLabel: "backend-engineer", _passiveSource: "chatSessions" },
        },
        {
          id: "h-par-1",
          ts: toIsoTest(baseEp + 0.1),
          epoch: baseEp + 0.1,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "b21-par",
          agentId: "root",
          targetAgentId: rawUuid,
          kind: "subagent_spawn",
          summary: "Spawned Subagent",
        },
        {
          id: "h-par-1-tool",
          ts: toIsoTest(baseEp + 1.0),
          epoch: baseEp + 1.0,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "b21-par",
          agentId: rawUuid,
          agentLabel: "08b84ac1 A4b4 4b2c 9abc ",
          kind: "tool_start",
          toolName: "read_file",
          summary: "Read test.ts",
        },
        {
          id: "h-par-2",
          ts: toIsoTest(baseEp + 0.3),
          epoch: baseEp + 0.3,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "b21-par",
          agentId: "root",
          targetAgentId: childUuid2,
          kind: "subagent_spawn",
          summary: "Spawned Subagent",
        },
      ],
      { sessionId: "b21-par", ide: "copilot-vscode", nowEpochSec: baseEp + 5 },
    );
    const parSubs = parallelSnap.agents.filter((a) => a.nodeType === "agent" && !a.isRoot);
    assert.equal(parSubs.length, 2, "parallel spawns must reconcile without ghost nodes");
    assert.equal(parSubs.find((a) => a.id === rawUuid)?.label, "qa-specialist");
    assert.equal(parSubs.find((a) => a.id === childUuid2)?.label, "backend-engineer");

    // Passive non-spawn events reconcile onto UUID hook event
    const nonSpawnSnap = buildSessionSnapshot(
      [
        {
          id: "p-ns-1",
          ts: toIsoTest(baseEp),
          epoch: baseEp,
          ide: "copilot-vscode",
          channel: "passive",
          sessionId: "b21-ns",
          agentId: "docs-writer",
          parentAgentId: "root",
          agentLabel: "Docs Writer",
          kind: "thinking_start",
          summary: "Drafting guide",
        },
        {
          id: "h-ns-1",
          ts: toIsoTest(baseEp + 0.5),
          epoch: baseEp + 0.5,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "b21-ns",
          agentId: rawUuid,
          agentLabel: "08b84ac1 A4b4 4b2c 9abc ",
          kind: "tool_start",
          toolName: "read_file",
          summary: "Read README.md",
        },
      ],
      { sessionId: "b21-ns", ide: "copilot-vscode", nowEpochSec: baseEp + 5 },
    );
    const nsSubs = nonSpawnSnap.agents.filter((a) => a.nodeType === "agent" && !a.isRoot);
    assert.equal(nsSubs.length, 1);
    assert.equal(nsSubs[0]?.id, rawUuid);
    assert.equal(nsSubs[0]?.label, "Docs Writer");
  });

  it("BUG-26: resolves Copilot Auto version metadata, 1M MAI / 921805 effective window, nominalContextWindow, subagent propagation, and modelContextWindows", async () => {
    const vscDir = path.join(tmpDir, "vscode-ws-b26");
    const wsHashDir = path.join(vscDir, "ws-mai");
    const chatDir = path.join(wsHashDir, "chatSessions");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.writeFile(
      path.join(wsHashDir, "workspace.json"),
      JSON.stringify({ folder: "file:///d:/Work/MaiDemo" }),
      "utf8",
    );
    const baseMs = Date.now() - 20_000;
    await fs.writeFile(
      path.join(chatDir, "mai-auto-session.json"),
      JSON.stringify({
        sessionId: "mai-auto-1",
        creationDate: baseMs,
        inputState: {
          selectedModel: {
            id: "auto",
            family: "vscModelF",
            version: "mai-code-2-flash",
            metadata: {
              id: "auto",
              family: "vscModelF",
              version: "mai-code-2-flash",
              maxInputTokens: 921_805,
            },
          },
        },
        requests: [
          {
            requestId: "r-mai-1",
            timestamp: baseMs + 1000,
            modelId: "copilot/auto",
            message: { text: "Inspect repo" },
            response: [
              {
                kind: "toolInvocationSerialized",
                toolId: "runSubagent",
                toolCallId: "sub-tc-mai-1",
                isComplete: true,
                toolSpecificData: {
                  subAgentName: "researcher",
                  subAgentInvocationId: "sub-mai-1",
                  prompt: "Survey files",
                },
              },
              { kind: "markdownContent", value: "Done." },
            ],
            result: {
              metadata: {
                toolCallRounds: [
                  {
                    usage: {
                      promptTokens: 108_000,
                      cachedTokens: 0,
                      completionTokens: 500,
                    },
                  },
                ],
              },
            },
            modelState: { completedAt: baseMs + 2000 },
          },
        ],
      }),
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const sessions = await adapter.discoverSessions();
    const s = sessions.find((x) => x.sessionId === "mai-auto-1");
    assert.ok(s);
    const evs = await adapter.parseSession(s);
    const snap = buildSessionSnapshot(evs, {
      sessionId: "mai-auto-1",
      ide: "copilot-vscode",
      nowEpochSec: (baseMs + 5000) / 1000,
    });

    const root = snap.agents.find((a) => a.id === "root");
    const sub = snap.agents.find((a) => a.id === "sub-mai-1");
    assert.equal(root?.usage?.model, "Mai Code 2 Flash");
    assert.equal(root?.usage?.contextWindow, 921_805);
    assert.equal(root?.usage?.nominalContextWindow, 1_000_000);
    assert.equal(sub?.usage?.model, "Mai Code 2 Flash");
    assert.equal(sub?.usage?.contextWindow, 921_805);
    assert.equal(sub?.usage?.nominalContextWindow, 1_000_000);

    // Tier 3 modelContextWindows lookup when live usageDelta omits contextWindow
    const baseEp = baseMs / 1000;
    const tier3Snap = buildSessionSnapshot(
      [
        {
          id: "t3-1",
          ts: toIsoTest(baseEp),
          epoch: baseEp,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "t3-sess",
          agentId: "root",
          kind: "tool_end",
          toolName: "read_file",
          summary: "Read file",
          usageDelta: {
            model: "Custom Org Model",
            modelSource: "exact",
            usageSource: "exact",
            inputTokens: 100_000,
            outputTokens: 1_000,
            cachedTokens: 0,
            contextTokens: 101_000,
          },
        },
      ],
      {
        sessionId: "t3-sess",
        ide: "copilot-vscode",
        nowEpochSec: baseEp + 5,
        modelContextWindows: { "custom org model": 512_000 },
      },
    );
    const t3Root = tier3Snap.agents.find((a) => a.id === "root");
    assert.equal(t3Root?.usage?.contextWindow, 512_000);
    assert.equal(tier3Snap.modelContextWindows?.["custom org model"], 512_000);
  });

  it("S1-65: emits debounced context advisories across aggregator+PushBus, hook-emit PreCompact/advisory, and preserves PreToolUse deny priority", async () => {
    // 1. TelemetryAggregator combines cached passive snapshot tokens with tokenless Copilot hook event
    const agg = new TelemetryAggregator({
      brainDir: path.join(tmpDir, "no-brain"),
      claudeDir: path.join(tmpDir, "no-claude"),
      vscodeDir: path.join(tmpDir, "no-vscode"),
      includeGlobalTelemetryFile: false,
    });
    agg.ingest([
      {
        id: "s65-seed",
        ts: new Date().toISOString(),
        ide: "copilot-vscode",
        sessionId: "s65-sess",
        agentId: "root",
        kind: "tool_end",
        toolName: "read_file",
        summary: "Read large file",
        usageDelta: {
          model: "Mai Code 2",
          modelSource: "exact",
          usageSource: "exact",
          inputTokens: 560_000,
          outputTokens: 2_000,
          cachedTokens: 0,
          contextTokens: 562_000,
          contextWindow: 1_000_000,
        },
      },
    ]);
    await agg.getSessionSnapshot("s65-sess");

    // Tokenless hook arrives -> evaluates 56.2% >= 55% handoff threshold
    const ingest1 = agg.ingest([
      {
        id: "s65-hook-1",
        ts: new Date(Date.now() + 500).toISOString(),
        ide: "copilot-vscode",
        sessionId: "s65-sess",
        agentId: "root",
        kind: "tool_start",
        toolName: "edit_file",
        summary: "Edit file",
      },
    ]);
    const adv1 = agg.evaluateIngestAdvisory(ingest1.events);
    assert.equal(adv1?.band, "handoff");
    assert.match(adv1?.message ?? "", /Drift\/Handoff threshold reached/);

    // Same band on next hook is debounced (returns null)
    const ingest2 = agg.ingest([
      {
        id: "s65-hook-2",
        ts: new Date(Date.now() + 1000).toISOString(),
        ide: "copilot-vscode",
        sessionId: "s65-sess",
        agentId: "root",
        kind: "tool_end",
        toolName: "edit_file",
        summary: "Edited file",
      },
    ]);
    assert.equal(agg.evaluateIngestAdvisory(ingest2.events), null);

    // PreCompact always emits compact advisory
    const ingestPre = agg.ingest([
      {
        id: "s65-precompact",
        ts: new Date(Date.now() + 1500).toISOString(),
        ide: "copilot-vscode",
        sessionId: "s65-sess",
        agentId: "root",
        kind: "message",
        summary: "PreCompact",
        payload: { hookEvent: "PreCompact", isPreCompact: true },
      },
    ]);
    const advPre = agg.evaluateIngestAdvisory(ingestPre.events);
    assert.equal(advPre?.band, "compact");
    assert.equal(advPre?.isPreCompact, true);

    // 2. runHookEmit: PreCompact offline emits hookSpecificOutput.additionalContext, while PreToolUse denyReason keeps top priority
    const ws = path.join(tmpDir, "hook-ws");
    await fs.mkdir(path.join(ws, ".agent-team"), { recursive: true });
    let stdoutText = "";
    const preCompactRes = await runHookEmit(
      ["--ide", "claude-code", "--event", "PreCompact", "--cwd", ws, "--port", "59999"],
      {
        stdinText: JSON.stringify({
          session_id: "cc-s65",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 115_000, output_tokens: 500 },
        }),
        stdout: (c) => {
          stdoutText += c;
        },
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(preCompactRes.exitCode, 0);
    assert.equal(preCompactRes.advisory?.band, "compact");
    const parsedOut = JSON.parse(stdoutText.trim()) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    assert.equal(parsedOut.hookSpecificOutput?.hookEventName, "PreCompact");
    assert.match(parsedOut.hookSpecificOutput?.additionalContext ?? "", /Compact threshold reached/);

    // PreToolUse guardrail deny takes strict priority over high context advisory
    let denyStdout = "";
    const denyRes = await runHookEmit(
      ["--ide", "claude-code", "--event", "PreToolUse", "--cwd", ws, "--port", "59999"],
      {
        stdinText: JSON.stringify({
          session_id: "cc-s65-deny",
          tool_name: "Edit",
          tool_input: { file_path: path.join(ws, "pipeline", "board.json") },
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 150_000, output_tokens: 500 },
        }),
        stdout: (c) => {
          denyStdout += c;
        },
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(denyRes.denied, true);
    const denyJson = JSON.parse(denyStdout.trim()) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    assert.equal(denyJson.hookSpecificOutput?.permissionDecision, "deny");

    // 3. Cross-agent context bleed guard: fresh subagent absent from snapshot does NOT inherit root's >=55% usage
    assert.equal(agg.getCachedAgentUsage("s65-sess", "root")?.contextTokens, 562_000);
    const freshSubCached = agg.getCachedAgentUsage("s65-sess", "fresh-subagent-1");
    assert.equal(freshSubCached?.contextTokens, undefined);
    assert.equal(freshSubCached?.contextWindow, undefined);
    const subIngest = agg.ingest([
      {
        id: "s65-fresh-sub-1",
        ts: new Date(Date.now() + 2000).toISOString(),
        ide: "copilot-vscode",
        sessionId: "s65-sess",
        agentId: "fresh-subagent-1",
        parentAgentId: "root",
        kind: "tool_start",
        toolName: "read_file",
        summary: "Read small file",
      },
    ]);
    assert.equal(agg.evaluateIngestAdvisory(subIngest.events), null);

    // 4. PushBus.migrateOrphanSession transfers & deletes orphan contextTrackers keys cleanly
    const pb = agg.pushBus;
    pb.ingest([
      {
        id: "orp-1",
        ts: new Date().toISOString(),
        ide: "copilot-vscode",
        sessionId: "orphan-sub-sess",
        agentId: "root",
        kind: "tool_end",
        toolName: "read_file",
        summary: "Read file",
        usageDelta: {
          model: "Mai Code 2",
          modelSource: "exact",
          usageSource: "exact",
          inputTokens: 120_000,
          outputTokens: 500,
          cachedTokens: 0,
          contextTokens: 120_500,
          contextWindow: 1_000_000,
        },
      },
    ]);
    assert.equal(pb.getAgentContextState("orphan-sub-sess", "root")?.contextTokens, 120_500);
    pb.ingest([
      {
        id: "spawn-1",
        ts: new Date(Date.now() + 100).toISOString(),
        ide: "copilot-vscode",
        sessionId: "parent-sess",
        agentId: "root",
        targetAgentId: "orphan-sub-sess",
        kind: "subagent_spawn",
        summary: "Spawned researcher",
        payload: { agentLabel: "researcher", agentId: "orphan-sub-sess" },
      },
    ]);
    assert.equal(pb.getAgentContextState("orphan-sub-sess", "root"), undefined);
    assert.equal(pb.getAgentContextState("parent-sess", "orphan-sub-sess")?.contextTokens, 120_500);

    // 5. Offline hook-emit falls back to inputTokens + cachedTokens + outputTokens when contextTokens is omitted
    let fallbackStdout = "";
    const sumFallbackRes = await runHookEmit(
      ["--ide", "claude-code", "--event", "PostToolUse", "--cwd", ws, "--port", "59999"],
      {
        stdinText: JSON.stringify({
          session_id: "cc-sum-fallback",
          tool_name: "Read",
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 40_000,
            cache_read_input_tokens: 75_000,
            output_tokens: 1_000,
          },
        }),
        stdout: (c) => {
          fallbackStdout += c;
        },
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(sumFallbackRes.advisory?.band, "handoff");
    assert.equal(sumFallbackRes.advisory?.contextTokens, 116_000);
    assert.match(fallbackStdout, /Drift\/Handoff threshold reached/);
  });

  it("S1-70 (1): hook-emit top-level JSON on camelCase Copilot events, dual 14 camelCase + 9 PascalCase parsing, response extraction, and guardrails", async () => {
    const ws = path.join(tmpDir, "s170-hook-ws");
    await fs.mkdir(path.join(ws, ".agent-team"), { recursive: true });
    const offlineFetch: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED"));

    // 1. normalizeHookEventName covers all 14 camelCase + 9 PascalCase aliases
    const camelCases = [
      "sessionStart",
      "sessionEnd",
      "userPromptSubmitted",
      "userPromptTransformed",
      "preToolUse",
      "postToolUse",
      "postToolUseFailure",
      "preCompact",
      "subagentStart",
      "subagentStop",
      "agentStop",
      "permissionRequest",
      "notification",
      "errorOccurred",
    ];
    for (const ev of camelCases) {
      assert.equal(normalizeHookEventName(ev), ev);
    }
    const pascalMap: Array<[string, string]> = [
      ["SessionStart", "sessionStart"],
      ["UserPromptSubmit", "userPromptSubmitted"],
      ["PreToolUse", "preToolUse"],
      ["PostToolUse", "postToolUse"],
      ["PostToolUseFailure", "postToolUseFailure"],
      ["PreCompact", "preCompact"],
      ["SubagentStart", "subagentStart"],
      ["SubagentStop", "subagentStop"],
      ["Stop", "agentStop"],
    ];
    for (const [pascal, canon] of pascalMap) {
      assert.equal(normalizeHookEventName(pascal), canon);
    }

    // 2. preToolUse (camelCase) deny emits top-level JSON + exitCode 0 on create, str_replace, str_replace_editor (edit)
    for (const [tname, tinput] of [
      ["create", { path: path.join(ws, "pipeline", "board.json") }],
      ["str_replace", { target_file: "pipeline/board.json" }],
      ["str_replace_editor", { command: "str_replace", path: "pipeline/board.json" }],
      ["str_replace_editor", { path: "pipeline/board.json" }],
    ] as Array<[string, Record<string, unknown>]>) {
      let out = "";
      let err = "";
      const res = await runHookEmit(
        ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", ws],
        {
          stdinText: JSON.stringify({
            sessionId: "s170-deny",
            toolName: tname,
            toolArgs: JSON.stringify(tinput),
          }),
          stdout: (c) => {
            out += c;
          },
          stderr: (c) => {
            err += c;
          },
          fetchImpl: offlineFetch,
        },
      );
      assert.equal(res.denied, true, `${tname} targeting board.json must be denied`);
      assert.equal(res.exitCode, 0, "camelCase copilot preToolUse deny must exit 0");
      const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
      assert.equal(parsed.permissionDecision, "deny");
      assert.match(String(parsed.permissionDecisionReason ?? ""), /pipeline\/board\.json/);
      assert.equal(parsed.hookSpecificOutput, undefined, "camelCase deny must be top-level JSON");
      assert.match(err, /agent-studio guardrail/);
    }

    // Orchestrator read-only guardrail blocks create/str_replace/str_replace_editor (non-view) and allows command="view"
    let orchDenyOut = "";
    const orchDeny = await runHookEmit(
      ["--ide", "copilot-vscode", "--role", "orchestrator", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          hookEventName: "preToolUse",
          sessionId: "s170-orch",
          toolName: "create",
          toolArgs: { path: "src/app.ts" },
        }),
        stdout: (c) => {
          orchDenyOut += c;
        },
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(orchDeny.denied, true);
    assert.equal(orchDeny.exitCode, 0);
    assert.equal((JSON.parse(orchDenyOut.trim()) as { permissionDecision?: string }).permissionDecision, "deny");

    let viewOut = "";
    const orchView = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "preToolUse", "--role", "orchestrator", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-orch",
          toolName: "str_replace_editor",
          toolArgs: { command: "view", path: "pipeline/board.json" },
        }),
        stdout: (c) => {
          viewOut += c;
        },
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(orchView.denied, false, "str_replace_editor command=view must NOT be blocked");
    assert.equal(orchView.exitCode, 0);
    assert.equal(orchView.event?.summary, "Read board.json");
    assert.equal(viewOut, "");

    // Legacy PascalCase PreToolUse on copilot-vscode preserves hookSpecificOutput + exitCode 2
    let legacyDenyOut = "";
    const legacyDeny = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PreToolUse", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-legacy",
          toolName: "create",
          toolArgs: { path: "pipeline/board.json" },
        }),
        stdout: (c) => {
          legacyDenyOut += c;
        },
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(legacyDeny.denied, true);
    assert.equal(legacyDeny.exitCode, 2);
    const legacyParsed = JSON.parse(legacyDenyOut.trim()) as {
      hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string };
    };
    assert.equal(legacyParsed.hookSpecificOutput?.hookEventName, "PreToolUse");
    assert.equal(legacyParsed.hookSpecificOutput?.permissionDecision, "deny");

    // 3. Stdout advisory formatting in camelCase Copilot vs silent events + online deferred preCompact
    const advisoryFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          advisory: {
            band: "compact",
            sessionId: "s170-adv",
            agentId: "root",
            contextTokens: 150_000,
            contextWindow: 200_000,
            contextPercent: 75,
            message: "[agent-studio context-budget: 75% of 200k] Compact threshold reached.",
          },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    for (const advEvent of [
      "sessionStart",
      "postToolUse",
      "postToolUseFailure",
      "subagentStart",
      "notification",
    ]) {
      let stdoutText = "";
      const res = await runHookEmit(
        ["--ide", "copilot-vscode", "--event", advEvent, "--cwd", ws],
        {
          stdinText: JSON.stringify({
            sessionId: "s170-adv",
            ...(advEvent.includes("Tool") ? { toolName: "view", toolArgs: { path: "a.ts" } } : {}),
            ...(advEvent === "subagentStart" ? { agentName: "explore" } : {}),
            ...(advEvent === "notification" ? { message: "Heads up" } : {}),
          }),
          stdout: (c) => {
            stdoutText += c;
          },
          fetchImpl: advisoryFetch,
        },
      );
      assert.equal(res.exitCode, 0);
      const outJson = JSON.parse(stdoutText.trim()) as Record<string, unknown>;
      assert.match(String(outJson.additionalContext ?? ""), /Compact threshold reached/, `${advEvent} must emit top-level additionalContext`);
      assert.equal(outJson.hookSpecificOutput, undefined);
    }

    for (const silentEvent of [
      "preCompact",
      "userPromptSubmitted",
      "userPromptTransformed",
      "sessionEnd",
      "errorOccurred",
      "permissionRequest",
      "preToolUse",
      "agentStop",
      "subagentStop",
    ]) {
      let stdoutText = "";
      const res = await runHookEmit(
        ["--ide", "copilot-vscode", "--event", silentEvent, "--cwd", ws],
        {
          stdinText: JSON.stringify({
            sessionId: "s170-silent",
            ...(silentEvent === "preToolUse" ? { toolName: "view", toolArgs: { path: "src/a.ts" } } : {}),
            ...(silentEvent === "userPromptSubmitted" ? { prompt: "Go" } : {}),
            ...(silentEvent === "userPromptTransformed" ? { transformedPrompt: "Go now" } : {}),
            ...(silentEvent === "errorOccurred" ? { error: "Rate limited" } : {}),
            ...(silentEvent === "permissionRequest" ? { toolName: "bash", toolArgs: { command: "rm -rf tmp" } } : {}),
          }),
          stdout: (c) => {
            stdoutText += c;
          },
          fetchImpl: advisoryFetch,
        },
      );
      assert.equal(res.exitCode, 0);
      assert.equal(stdoutText, "", `${silentEvent} in camelCase copilot-vscode must emit zero stdout`);
    }

    // End-to-end TelemetryAggregator deferred preCompact -> next postToolUse surfaces advisory
    const agg = new TelemetryAggregator({
      brainDir: path.join(tmpDir, "no-brain"),
      claudeDir: path.join(tmpDir, "no-claude"),
      vscodeDir: path.join(tmpDir, "no-vsc"),
      includeGlobalTelemetryFile: false,
    });
    const aggFetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
      const ingested = agg.ingest([body]);
      const adv = agg.evaluateIngestAdvisory(ingested.events);
      return new Response(
        JSON.stringify({ ok: true, ...(adv ? { advisory: adv } : {}) }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    let preCompactOut = "";
    const pcRes = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "preCompact", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-defer",
          model: "claude-sonnet-4.6",
          usage: { promptTokens: 110_000, completionTokens: 1_000 },
        }),
        stdout: (c) => {
          preCompactOut += c;
        },
        fetchImpl: aggFetch,
      },
    );
    assert.equal(preCompactOut, "");
    assert.equal(pcRes.advisory?.isPreCompact, true);

    let followPostOut = "";
    await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "postToolUse", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-defer",
          toolName: "view",
          toolArgs: { path: "src/app.ts" },
        }),
        stdout: (c) => {
          followPostOut += c;
        },
        fetchImpl: aggFetch,
      },
    );
    const deferredJson = JSON.parse(followPostOut.trim()) as { additionalContext?: string };
    assert.match(deferredJson.additionalContext ?? "", /Compact threshold reached \(PreCompact\)/);

    // 4. subagentStop & agentStop extract response / last_assistant_message into payload.body + bodyLength
    const subStopRes = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "subagentStop", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-stop",
          agentId: "11111111-2222-4333-8444-555555555555",
          agentName: "explore",
          agentType: "Explore",
          response: "Found 4 matching handlers.",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(subStopRes.event?.kind, "subagent_done");
    assert.equal(subStopRes.event?.payload?.body, "Found 4 matching handlers.");
    assert.equal(subStopRes.event?.bodyLength, "Found 4 matching handlers.".length);
    assert.equal(subStopRes.event?.payload?.agentLabel, "Explore");

    const agentStopRes = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "agentStop", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-stop",
          last_assistant_message: "All tasks completed cleanly.",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(agentStopRes.event?.kind, "assistant_turn_end");
    assert.equal(agentStopRes.event?.payload?.body, "All tasks completed cleanly.");
    assert.equal(agentStopRes.event?.bodyLength, "All tasks completed cleanly.".length);

    // 5. ask_user (WAITING + choices + allow_freeform), task, permissionRequest, errorOccurred, sessionEnd
    const askRes = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-tools",
          toolName: "ask_user",
          toolCallId: "tc-ask-1",
          toolArgs: {
            question: "Pick storage backend",
            choices: ["SQLite", "JSONL"],
            allow_freeform: false,
          },
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(askRes.event?.kind, "tool_start");
    assert.equal(askRes.event?.waitingReason, "user");
    assert.equal(askRes.event?.targetAgentId, "human");
    const askQs = askRes.event?.payload?.questions as Array<{
      type: string;
      options: Array<{ label: string }>;
      allowCustomInput?: boolean;
    }>;
    assert.equal(askQs[0]?.type, "single_select");
    assert.deepEqual(askQs[0]?.options.map((o) => o.label), ["SQLite", "JSONL"]);
    assert.equal(askQs[0]?.allowCustomInput, false);

    const permRes = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "permissionRequest", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-tools",
          toolName: "powershell",
          toolArgs: { command: "npm test" },
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(permRes.event?.kind, "message");
    assert.equal(permRes.event?.waitingReason, "tool_approval");
    assert.equal(permRes.event?.targetAgentId, "human");

    const errRes = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "errorOccurred", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-tools",
          error: { message: "Model quota exceeded" },
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(errRes.event?.isError, true);
    assert.equal(errRes.event?.status, "error");
    assert.match(errRes.event?.summary ?? "", /Error: Model quota exceeded/);

    const endRes = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "sessionEnd", "--cwd", ws],
      {
        stdinText: JSON.stringify({ sessionId: "s170-tools" }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(endRes.event?.kind, "assistant_turn_end");
  });

  it("S1-70 (2): Copilot native tool classification (create, str_replace, str_replace_editor, ask_user, task, web_fetch, etc.) & normalizer dedup", () => {
    // External tool classification
    for (const fsTool of ["create", "str_replace", "str_replace_editor", "view", "grep", "glob"]) {
      assert.equal(classifyExternalTool(fsTool)?.id, "ext:fs", `${fsTool} -> ext:fs`);
    }
    assert.equal(classifyExternalTool("bash")?.id, "ext:shell");
    assert.equal(classifyExternalTool("powershell")?.id, "ext:shell");
    assert.equal(classifyExternalTool("web_fetch")?.id, "ext:web");
    assert.equal(classifyExternalTool("ask_user")?.id, "ext:human");
    assert.equal(classifyExternalTool("task"), null);

    // Summaries (including str_replace_editor command=view awareness)
    assert.equal(summarizeToolCall("create", { path: "src/new.ts" }), "Wrote new.ts");
    assert.equal(summarizeToolCall("str_replace", { path: "src/app.ts" }), "Edited app.ts");
    assert.equal(
      summarizeToolCall("str_replace_editor", { command: "view", path: "src/app.ts" }),
      "Read app.ts",
    );
    assert.equal(
      summarizeToolCall("str_replace_editor", { command: "create", path: "src/created.ts" }),
      "Wrote created.ts",
    );
    assert.equal(
      summarizeToolCall("str_replace_editor", { command: "str_replace", path: "src/app.ts" }),
      "Edited app.ts",
    );
    assert.equal(
      summarizeToolCall("ask_user", { question: "Which DB?" }),
      "Ask user: Which DB?",
    );
    assert.equal(
      summarizeToolCall("task", { agent_type: "explore", description: "Search" }),
      "Spawned explore",
    );
    assert.equal(
      summarizeToolCall("web_fetch", { url: "https://example.com/docs" }),
      "Fetch https://example.com/docs",
    );
    assert.equal(summarizeToolCall("view", { path: "README.md" }), "Read README.md");
    assert.equal(summarizeToolCall("bash", { command: "npm test" }), "Ran unit tests");
    assert.equal(summarizeToolCall("powershell", { command: "git status" }), "Checked git status");
    assert.equal(summarizeToolCall("grep", { pattern: "hookEvent" }), "Search: hookEvent");
    assert.equal(summarizeToolCall("glob", { pattern: "src/**/*.ts" }), "Find files: src/**/*.ts");

    // normalizePendingQuestions choices + allow_freeform
    const nq = normalizePendingQuestions({
      question: "Select mode",
      choices: ["Fast", { label: "Thorough (Recommended)" }],
      allow_freeform: true,
    });
    assert.equal(nq.length, 1);
    assert.equal(nq[0]?.type, "single_select");
    assert.equal(nq[0]?.allowCustomInput, true);
    assert.equal(nq[0]?.options[1]?.recommended, true);

    // canonicalDedupToolName + Tier-2 dedup
    assert.equal(canonicalDedupToolName("create"), "fs_edit");
    assert.equal(canonicalDedupToolName("str_replace"), "fs_edit");
    assert.equal(canonicalDedupToolName("str_replace_editor"), "fs_edit");
    assert.equal(canonicalDedupToolName("web_fetch"), "web_fetch");
    assert.equal(canonicalDedupToolName("webfetch"), "web_fetch");
    assert.equal(canonicalDedupToolName("task"), "subagent");

    const ep = 1_796_200_000;
    const deduped = deduplicateEvents([
      {
        id: "hk-edit",
        ts: toIsoTest(ep),
        epoch: ep,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: "s-dedup",
        agentId: "root",
        kind: "tool_start",
        toolName: "str_replace",
        summary: "Edited app.ts",
      },
      {
        id: "ps-edit",
        ts: toIsoTest(ep + 0.4),
        epoch: ep + 0.4,
        ide: "copilot-vscode",
        channel: "passive",
        sessionId: "s-dedup",
        agentId: "root",
        kind: "tool_start",
        toolName: "edit_file",
        summary: "Edited app.ts",
      },
    ]);
    assert.equal(deduped.length, 1, "str_replace (hook) and edit_file (passive) must Tier-2 dedup");
  });

  it("S1-70 (3): correlates label-only subagentStart with UUID subagentStop, child hooks, and passive task/subagent.started in PushBus & normalizer", async () => {
    const ws = path.join(tmpDir, "s170-sub-ws");
    await fs.mkdir(ws, { recursive: true });
    const offlineFetch: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED"));

    // A. PushBus FIFO in-order correlation (2 concurrent "explore" spawns + child hook + 2 UUID stops)
    const bus = new PushBus({ includeGlobalTelemetryFile: false });
    const sStart1 = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "subagentStart", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-fifo",
          agentName: "explore",
          agentDisplayName: "Explore",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const sStart2 = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "subagentStart", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-fifo",
          agentName: "explore",
          agentDisplayName: "Explore",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const childHook1 = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-fifo",
          agentId: "aaaaaaaa-1111-4111-8111-111111111111",
          agentType: "Explore",
          toolName: "grep",
          toolCallId: "tc-child-1",
          toolArgs: { pattern: "runHookEmit" },
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const sStop1 = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "subagentStop", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-fifo",
          agentId: "aaaaaaaa-1111-4111-8111-111111111111",
          agentName: "explore",
          agentType: "Explore",
          response: "First explore complete",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const sStop2 = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "subagentStop", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-fifo",
          agentId: "bbbbbbbb-2222-4222-8222-222222222222",
          agentName: "explore",
          response: "Second explore complete",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );

    bus.ingest([
      sStart1.event!,
      sStart2.event!,
      childHook1.event!,
      sStop1.event!,
      sStop2.event!,
    ]);
    const fifoSnap = buildSessionSnapshot(bus.getSessionEvents("s170-fifo"), {
      sessionId: "s170-fifo",
      ide: "copilot-vscode",
      nowEpochSec: Date.now() / 1000 + 2,
    });
    const fifoSubagents = fifoSnap.agents.filter(
      (a) => a.nodeType === "agent" && !a.isRoot,
    );
    assert.equal(fifoSubagents.length, 2, "must have exactly 2 correlated subagent nodes (no UUID splits)");
    assert.ok(fifoSubagents.every((a) => a.status === "DONE"), "both subagents must reach DONE");
    assert.ok(fifoSubagents.every((a) => !isOpaqueAgentId(a.id)), "PushBus mapped UUIDs onto slug IDs");

    // B. PushBus out-of-order: UUID child + subagentStop arrive BEFORE label-only subagentStart
    const oooBus = new PushBus({ includeGlobalTelemetryFile: false });
    const oooUuid = "cccccccc-3333-4333-8333-333333333333";
    const oooStart = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "subagentStart", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-ooo",
          agentName: "backend-engineer",
          agentDisplayName: "Backend Engineer",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const oooChild = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-ooo",
          agentId: oooUuid,
          agentType: "Backend Engineer",
          toolName: "view",
          toolCallId: "tc-ooo-1",
          toolArgs: { path: "src/index.ts" },
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const oooStop = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "subagentStop", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s170-ooo",
          agentId: oooUuid,
          agentName: "backend-engineer",
          response: "Backend done",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    // Ensure distinct monotonic timestamps while delivering out of order
    oooStart.event!.epoch -= 0.2;
    oooChild.event!.epoch -= 0.1;
    oooBus.ingest([oooChild.event!, oooStop.event!, oooStart.event!]);
    const oooSnap = buildSessionSnapshot(oooBus.getSessionEvents("s170-ooo"), {
      sessionId: "s170-ooo",
      ide: "copilot-vscode",
      nowEpochSec: Date.now() / 1000 + 2,
    });
    const oooSubagents = oooSnap.agents.filter(
      (a) => a.nodeType === "agent" && !a.isRoot,
    );
    assert.equal(oooSubagents.length, 1);
    assert.equal(oooSubagents[0]?.status, "DONE");
    assert.equal(oooSubagents[0]?.label, "Backend Engineer");

    // C. Direct normalizer reconcileCopilotSubagents (without PushBus) collapses label-only subagentStart
    //    + UUID subagentStop + passive task/subagent.started onto 1 canonical DONE node
    const ep = 1_796_300_000;
    const directSnap = buildSessionSnapshot(
      [
        {
          id: "d-hk-start",
          ts: toIsoTest(ep),
          epoch: ep,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "s170-direct",
          agentId: "root",
          targetAgentId: "explore",
          kind: "subagent_spawn",
          summary: "Spawned Explore",
          payload: { hookEvent: "subagentStart", agentType: "Explore", agentLabel: "Explore" },
        },
        {
          id: "d-ps-start",
          ts: toIsoTest(ep + 0.2),
          epoch: ep + 0.2,
          ide: "copilot-vscode",
          channel: "passive",
          sessionId: "s170-direct",
          agentId: "root",
          targetAgentId: "explore",
          kind: "subagent_spawn",
          toolName: "task",
          toolCallId: "tc-pass-1",
          summary: "Spawned Explore",
          payload: { agentType: "Explore", agentLabel: "Explore", _passiveSource: "transcript" },
        },
        {
          id: "d-hk-tool",
          ts: toIsoTest(ep + 1),
          epoch: ep + 1,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "s170-direct",
          agentId: "dddddddd-4444-4444-8444-444444444444",
          parentAgentId: "root",
          agentLabel: "Explore",
          kind: "tool_start",
          toolName: "grep",
          toolCallId: "tc-d-1",
          summary: "Search: foo",
        },
        {
          id: "d-hk-stop",
          ts: toIsoTest(ep + 2),
          epoch: ep + 2,
          ide: "copilot-vscode",
          channel: "hook",
          sessionId: "s170-direct",
          agentId: "root",
          targetAgentId: "dddddddd-4444-4444-8444-444444444444",
          kind: "subagent_done",
          summary: "Completed Explore",
          payload: {
            hookEvent: "subagentStop",
            agentId: "dddddddd-4444-4444-8444-444444444444",
            agentName: "explore",
            body: "Done!",
          },
        },
        {
          id: "d-ps-done",
          ts: toIsoTest(ep + 2.1),
          epoch: ep + 2.1,
          ide: "copilot-vscode",
          channel: "passive",
          sessionId: "s170-direct",
          agentId: "root",
          targetAgentId: "explore",
          kind: "subagent_done",
          toolName: "task",
          toolCallId: "tc-pass-1",
          summary: "Subagent finished: Explore",
        },
      ],
      {
        sessionId: "s170-direct",
        ide: "copilot-vscode",
        nowEpochSec: ep + 3,
      },
    );
    const directSubs = directSnap.agents.filter(
      (a) => a.nodeType === "agent" && !a.isRoot,
    );
    assert.equal(directSubs.length, 1, "must collapse to 1 canonical subagent node");
    assert.equal(directSubs[0]?.label, "Explore");
    assert.equal(directSubs[0]?.status, "DONE");
  });

  it("S1-70 (4): $COPILOT_HOME/session-state/*/events.jsonl workspace-scoped passive discovery, allowed roots, inclusive usage dedup & workspaceStorage merge", async () => {
    const vscDir = path.join(tmpDir, "s170-vsc-storage");
    const copilotHome = path.join(tmpDir, "s170-copilot-home");
    const wsA = path.join(tmpDir, "repos", "proj-a");
    const wsB = path.join(tmpDir, "repos", "proj-b");
    await fs.mkdir(wsA, { recursive: true });
    await fs.mkdir(wsB, { recursive: true });

    // Session A: workspace.yaml cwd + rich events (ask_user, task, str_replace_editor, web_fetch, assistant.usage + session.shutdown)
    const dirA = path.join(copilotHome, "session-state", "11111111-aaaa-4aaa-8aaa-111111111111");
    await fs.mkdir(dirA, { recursive: true });
    await fs.writeFile(
      path.join(dirA, "workspace.yaml"),
      `id: 11111111-aaaa-4aaa-8aaa-111111111111\ncwd: ${JSON.stringify(wsA)}\ngit_root: ${JSON.stringify(wsA)}\nsummary: Build Copilot Harness\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(dirA, "events.jsonl"),
      [
        {
          type: "session.start",
          timestamp: "2026-11-26T10:00:00Z",
          data: {
            sessionId: "11111111-aaaa-4aaa-8aaa-111111111111",
            selectedModel: "claude-sonnet-4.6",
          },
        },
        {
          type: "user.message",
          timestamp: "2026-11-26T10:00:01Z",
          data: { content: "Implement harness updates" },
        },
        {
          type: "assistant.message",
          timestamp: "2026-11-26T10:00:02Z",
          data: {
            content: "Checking docs and asking question.",
            toolRequests: [
              {
                toolCallId: "tc-web-1",
                name: "web_fetch",
                arguments: { url: "https://code.visualstudio.com/docs" },
              },
              {
                toolCallId: "tc-edit-1",
                name: "str_replace_editor",
                arguments: { command: "str_replace", path: "src/app.ts" },
              },
              {
                toolCallId: "tc-task-1",
                name: "task",
                arguments: { agent_type: "explore", description: "Search repo" },
              },
            ],
            usage: { promptTokens: 20_000, cachedTokens: 15_000, completionTokens: 400 },
          },
        },
        {
          type: "subagent.started",
          timestamp: "2026-11-26T10:00:03Z",
          data: { toolCallId: "tc-task-1", agentName: "explore", agentDisplayName: "Explore" },
        },
        {
          type: "subagent.completed",
          timestamp: "2026-11-26T10:00:04Z",
          data: { toolCallId: "tc-task-1", agentName: "explore", result: "Found 2 files" },
        },
        {
          type: "tool.execution_start",
          timestamp: "2026-11-26T10:00:05Z",
          data: {
            toolCallId: "tc-ask-ss",
            toolName: "ask_user",
            arguments: { question: "Proceed?", choices: ["Yes", "No"], allow_freeform: false },
          },
        },
        {
          type: "session.shutdown",
          timestamp: "2026-11-26T10:00:06Z",
          data: {
            modelMetrics: {
              "claude-sonnet-4.6": {
                usage: { inputTokens: 99_000, outputTokens: 9_000, cacheReadTokens: 80_000 },
              },
            },
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    // Session B: NO workspace.yaml, workspace extracted from session.start data.context.cwd
    const dirB = path.join(copilotHome, "session-state", "22222222-bbbb-4bbb-8bbb-222222222222");
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(
      path.join(dirB, "events.jsonl"),
      [
        {
          type: "session.start",
          timestamp: "2026-11-26T10:01:00Z",
          data: {
            sessionId: "22222222-bbbb-4bbb-8bbb-222222222222",
            context: { cwd: wsB },
          },
        },
        {
          type: "user.message",
          timestamp: "2026-11-26T10:01:01Z",
          data: { content: "Check proj-b" },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    // Session C: No workspace at all (must be excluded when workspaceRoots scoping is active)
    const dirC = path.join(copilotHome, "session-state", "33333333-cccc-4ccc-8ccc-333333333333");
    await fs.mkdir(dirC, { recursive: true });
    await fs.writeFile(
      path.join(dirC, "events.jsonl"),
      JSON.stringify({
        type: "session.start",
        timestamp: "2026-11-26T10:02:00Z",
        data: { sessionId: "33333333-cccc-4ccc-8ccc-333333333333" },
      }) + "\n",
      "utf8",
    );

    // Duplicate sessionId in workspaceStorage/ws1/chatSessions matching Session A
    const wsHash = path.join(vscDir, "ws1");
    const chatDir = path.join(wsHash, "chatSessions");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.writeFile(
      path.join(wsHash, "workspace.json"),
      JSON.stringify({ folder: wsA }),
      "utf8",
    );
    await fs.writeFile(
      path.join(chatDir, "11111111-aaaa-4aaa-8aaa-111111111111.json"),
      JSON.stringify({
        sessionId: "11111111-aaaa-4aaa-8aaa-111111111111",
        creationDate: Date.parse("2026-11-26T09:59:50Z"),
        requests: [
          {
            requestId: "r0",
            timestamp: Date.parse("2026-11-26T09:59:50Z"),
            message: { text: "Implement harness updates" },
          },
        ],
      }),
      "utf8",
    );

    // Verify COPILOT_HOME env discovery + workspaceRoots scoping + workspaceStorage dedup
    const origCopilotHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = copilotHome;
    try {
      const adapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
      const allDiscovered = await adapter.discoverSessions();
      assert.equal(
        allDiscovered.filter((s) => s.sessionId === "11111111-aaaa-4aaa-8aaa-111111111111").length,
        1,
        "duplicate sessionId across workspaceStorage and session-state must merge into 1 DiscoveredSession",
      );
      assert.equal(allDiscovered.length, 3);

      const scopedA = await adapter.discoverSessions({ workspaceRoots: [wsA] });
      assert.deepEqual(
        scopedA.map((s) => s.sessionId),
        ["11111111-aaaa-4aaa-8aaa-111111111111"],
      );
      const scopedB = await adapter.discoverSessions({ workspaceRoots: [wsB] });
      assert.deepEqual(
        scopedB.map((s) => s.sessionId),
        ["22222222-bbbb-4bbb-8bbb-222222222222"],
      );
    } finally {
      if (origCopilotHome === undefined) {
        delete process.env.COPILOT_HOME;
      } else {
        process.env.COPILOT_HOME = origCopilotHome;
      }
    }

    // Verify copilotHomeDir option on TelemetryAggregator (without workspaceStorage clash for Session A)
    const agg = new TelemetryAggregator({
      brainDir: path.join(tmpDir, "no-brain"),
      claudeDir: path.join(tmpDir, "no-claude"),
      vscodeDir: path.join(tmpDir, "no-vsc"),
      copilotHomeDir: copilotHome,
      includeGlobalTelemetryFile: false,
    });
    const aggSessionsA = await agg.discoverSessions({ workspace: wsA });
    assert.equal(aggSessionsA.length, 1);
    assert.equal(aggSessionsA[0]?.title, "Build Copilot Harness");
    assert.equal(aggSessionsA[0]?.isWaiting, true);
    assert.equal(aggSessionsA[0]?.waitingOn, "user");
    assert.equal(aggSessionsA[0]?.isMultiAgent, true);

    const { snapshot: snapA } = await agg.getSessionSnapshot(
      "11111111-aaaa-4aaa-8aaa-111111111111",
      { workspace: wsA },
    );
    const rootA = snapA.agents.find((a) => a.id === "root");
    // Inclusive prompt-token normalization (20_000 - 15_000 = 5_000 freshIn, 15_000 cached, 400 out, 20_400 ctx)
    // AND incremental assistant.message wins over cumulative session.shutdown (no 99_000 double-count)
    assert.equal(rootA?.usage?.inputTokens, 5_000);
    assert.equal(rootA?.usage?.cachedTokens, 15_000);
    assert.equal(rootA?.usage?.outputTokens, 400);
    assert.equal(rootA?.usage?.contextTokens, 20_400);
    assert.equal(rootA?.status, "WAITING");
    assert.equal(snapA.pendingPrompts?.[0]?.options?.length, 2);
    assert.ok(snapA.agents.some((a) => a.id === "ext:web"));
    assert.ok(snapA.agents.some((a) => a.id === "ext:fs"));
    assert.ok(snapA.agents.some((a) => a.id === "explore" && a.status === "DONE"));

    // Verify parseChat + validateTranscriptPath accept $COPILOT_HOME/session-state/*/events.jsonl
    const chatRes = await agg.getAgentChat({
      sessionId: "11111111-aaaa-4aaa-8aaa-111111111111",
      workspace: wsA,
    });
    assert.ok(chatRes && chatRes.messages.length > 0);
    assert.ok(chatRes.messages.some((m) => m.role === "question"));
  });

  it("BUG-29 security: hook-emit blocks apply_patch/multiedit/TargetFile/path-traversal, shell bypasses, malformed/truncated stdin (fail-closed), and roster-named orchestrator", async () => {
    const ws = path.join(tmpDir, "bug29-ws");
    await fs.mkdir(path.join(ws, ".agent-team"), { recursive: true });
    await fs.writeFile(
      path.join(ws, ".agent-team", "team.yaml"),
      [
        "schemaVersion: 1",
        "project:",
        "  id: bug29-demo",
        "  title: BUG-29 Demo",
        "targets: [claude-code, copilot-vscode]",
        "workflow:",
        "  boardPath: pipeline/board.json",
        "  enforcement:",
        "    orchestratorReadOnly: true",
        "    qaGateRequired: true",
        "    blockDirectBoardEdits: true",
        "roster:",
        "  - id: lead-orch",
        "    name: Team Orchestrator",
        "    roleType: orchestrator",
        "    boardRole: orchestrator",
        "    promptFile: agents/orchestrator.md",
      ].join("\n"),
      "utf8",
    );

    const offlineFetch: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED"));

    // 1. apply_patch (Codex format & unified diff), multiedit (nested edits[]/files[]), and PascalCase TargetFile + traversal
    const boardEditCases: Array<{ name: string; toolName: string; toolInput: Record<string, unknown> }> = [
      {
        name: "PascalCase TargetFile with dot-dot traversal",
        toolName: "multi_replace_file_content",
        toolInput: { TargetFile: "./pipeline/../pipeline/board.json", ReplacementChunks: [] },
      },
      {
        name: "multiedit nested edits[]",
        toolName: "MultiEdit",
        toolInput: {
          edits: [
            { file_path: "src/ok.ts", old_string: "a", new_string: "b" },
            { filePath: "./pipeline/../pipeline/board.json", old_string: "x", new_string: "y" },
          ],
        },
      },
      {
        name: "multiedit nested files[]",
        toolName: "MultiEdit",
        toolInput: { files: [{ path: "pipeline/board.json" }] },
      },
      {
        name: "apply_patch Codex *** Update File:",
        toolName: "apply_patch",
        toolInput: {
          patch: "*** Begin Patch\n*** Update File: ./pipeline/../pipeline/board.json\n@@\n-ready\n+done\n*** End Patch\n",
        },
      },
      {
        name: "copilot_applypatch unified diff +++ b/",
        toolName: "copilot_applypatch",
        toolInput: {
          diff: "--- a/pipeline/board.json\n+++ b/pipeline/board.json\n@@ -1 +1 @@\n-a\n+b\n",
        },
      },
    ];

    for (const tc of boardEditCases) {
      let out = "";
      const res = await runHookEmit(
        ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", ws],
        {
          stdinText: JSON.stringify({
            sessionId: "s-bug29-edit",
            toolName: tc.toolName,
            toolInput: tc.toolInput,
          }),
          stdout: (c) => {
            out += c;
          },
          stderr: () => undefined,
          fetchImpl: offlineFetch,
        },
      );
      assert.equal(res.denied, true, `${tc.name} must be denied`);
      assert.equal(res.exitCode, 0);
      assert.equal((JSON.parse(out.trim()) as { permissionDecision?: string }).permissionDecision, "deny");
    }

    // Benign edit to src/board.json must NOT be falsely blocked
    const safeEditRes = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s-bug29-edit",
          toolName: "multi_replace_file_content",
          toolInput: { TargetFile: "src/board.json" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(safeEditRes.denied, false, "src/board.json is not pipeline/board.json");

    // 2. Fail-closed on >256KB truncated & malformed JSON preToolUse stdin across all envelopes
    const oversizedPayload = JSON.stringify({
      sessionId: "s-bug29-big",
      toolName: "view",
      pad: "x".repeat(260 * 1024),
    });

    let camelTruncOut = "";
    const camelTrunc = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", ws],
      {
        stdinText: oversizedPayload,
        stdout: (c) => {
          camelTruncOut += c;
        },
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(camelTrunc.denied, true);
    assert.equal(camelTrunc.exitCode, 0);
    const camelTruncJson = JSON.parse(camelTruncOut.trim()) as Record<string, unknown>;
    assert.equal(camelTruncJson.permissionDecision, "deny");
    assert.match(String(camelTruncJson.permissionDecisionReason ?? ""), /256KB|malformed/i);

    let ccMalformedOut = "";
    const ccMalformed = await runHookEmit(
      ["--ide", "claude-code", "--event", "PreToolUse", "--cwd", ws],
      {
        stdinText: "{bad-json",
        stdout: (c) => {
          ccMalformedOut += c;
        },
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(ccMalformed.denied, true);
    assert.equal(ccMalformed.exitCode, 0);
    const ccMalformedJson = JSON.parse(ccMalformedOut.trim()) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    assert.equal(ccMalformedJson.hookSpecificOutput?.permissionDecision, "deny");

    let pascalMalformedOut = "";
    const pascalMalformed = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "PreToolUse", "--cwd", ws],
      {
        stdinText: "{bad-json",
        stdout: (c) => {
          pascalMalformedOut += c;
        },
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(pascalMalformed.denied, true);
    assert.equal(pascalMalformed.exitCode, 2);
    const pascalMalformedJson = JSON.parse(pascalMalformedOut.trim()) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    assert.equal(pascalMalformedJson.hookSpecificOutput?.permissionDecision, "deny");

    // Non-preToolUse malformed JSON must NOT fail closed
    const postMalformed = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "postToolUse", "--cwd", ws],
      {
        stdinText: "{bad-json",
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(postMalformed.denied, false);
    assert.equal(postMalformed.exitCode, 0);

    // 3. SHELL_TOOLS (`execute`) board-write detection vs benign read-only commands
    const shellDenyCmds = [
      "cd pipeline && echo '{}' > board.json",
      `node -e "require('fs').writeFileSync('pipeline/board.json', '{}')"`,
      `python -c "open('board.json','w').write('{}')"`,
      "mv tmp.json pipeline/board.json",
      "Set-Content pipeline/board.json '{}'",
    ];
    for (const cmd of shellDenyCmds) {
      const res = await runHookEmit(
        ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", ws],
        {
          stdinText: JSON.stringify({
            sessionId: "s-bug29-shell",
            toolName: "execute",
            toolArgs: { command: cmd },
          }),
          stdout: () => undefined,
          stderr: () => undefined,
          fetchImpl: offlineFetch,
        },
      );
      assert.equal(res.denied, true, `shell command "${cmd}" must be denied`);
    }

    for (const safeCmd of [
      "cat pipeline/board.json",
      "npx agent-studio board show --id BUG-29",
    ]) {
      const res = await runHookEmit(
        ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", ws],
        {
          stdinText: JSON.stringify({
            sessionId: "s-bug29-shell",
            toolName: "execute",
            toolArgs: { command: safeCmd },
          }),
          stdout: () => undefined,
          stderr: () => undefined,
          fetchImpl: offlineFetch,
        },
      );
      assert.equal(res.denied, false, `read-only/CLI command "${safeCmd}" must be allowed`);
    }

    // 4. Roster-matched orchestrator (`name: "Team Orchestrator"`) without `--role` flag
    for (const [toolName, toolInput] of [
      ["edit", { filePath: "src/app.ts" }],
      ["create", { path: "src/new.ts" }],
      ["execute", { command: "npm test" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const res = await runHookEmit(
        ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", ws],
        {
          stdinText: JSON.stringify({
            sessionId: "s-bug29-orch",
            agentName: "Team Orchestrator",
            toolName,
            toolInput,
          }),
          stdout: () => undefined,
          stderr: () => undefined,
          fetchImpl: offlineFetch,
        },
      );
      assert.equal(res.denied, true, `Team Orchestrator calling ${toolName} must be denied`);
    }

    const orchViewOk = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", ws],
      {
        stdinText: JSON.stringify({
          sessionId: "s-bug29-orch",
          agentName: "Team Orchestrator",
          toolName: "str_replace_editor",
          toolInput: { command: "view", path: "src/app.ts" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(orchViewOk.denied, false);
  });

  it("BUG-30 (Part B): CopilotVSCodeAdapter normalizes resolveCopilotHomeDir, rejects symlink escapes & oversized workspace.yaml, and PushBus backfills out-of-order labels + bounds correlation maps", async () => {
    // 1. resolveCopilotHomeDir normalizes relative / unnormalized paths via path.resolve
    assert.equal(
      resolveCopilotHomeDir(tmpDir, path.join(tmpDir, "a", "..", "copilot-home")),
      path.resolve(path.join(tmpDir, "copilot-home")),
    );

    // 2. CopilotVSCodeAdapter rejects symlink escapes in session-state and oversized/symlinked workspace.yaml
    const copilotHome = path.join(tmpDir, "bug30-copilot-home");
    const sessionState = path.join(copilotHome, "session-state");
    const outsideDir = path.join(tmpDir, "bug30-outside");
    await fs.mkdir(sessionState, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(
      path.join(outsideDir, "events.jsonl"),
      JSON.stringify({
        type: "session.start",
        timestamp: "2026-11-26T12:00:00Z",
        data: { sessionId: "escaped-session" },
      }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(outsideDir, "workspace.yaml"),
      `id: escaped-ws\ncwd: ${JSON.stringify(outsideDir)}\n`,
      "utf8",
    );

    const escapedSessionDir = path.join(sessionState, "escaped-session");
    let createdSessionEscape = false;
    try {
      await fs.symlink(
        outsideDir,
        escapedSessionDir,
        process.platform === "win32" ? "junction" : "dir",
      );
      createdSessionEscape = true;
    } catch {
      // Symlinks/junctions unavailable
    }

    // Valid session with oversized workspace.yaml (>64KB) -> workspace.yaml ignored safely, session still discovered
    const validSessDir = path.join(sessionState, "valid-big-yaml-session");
    await fs.mkdir(validSessDir, { recursive: true });
    await fs.writeFile(
      path.join(validSessDir, "workspace.yaml"),
      `id: yaml-id-should-be-ignored\ncwd: ${JSON.stringify(tmpDir)}\n# ${"z".repeat(70 * 1024)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(validSessDir, "events.jsonl"),
      JSON.stringify({
        type: "session.start",
        timestamp: "2026-11-26T12:01:00Z",
        data: { sessionId: "valid-big-yaml-session" },
      }) + "\n",
      "utf8",
    );

    const adapter = new CopilotVSCodeAdapter({
      storageDir: path.join(tmpDir, "no-vsc-storage"),
      copilotHomeDir: copilotHome,
    });
    const discovered = await adapter.discoverSessions();
    if (createdSessionEscape) {
      assert.ok(
        !discovered.some((s) => s.sessionId === "escaped-session"),
        "symlink/junction escaping $COPILOT_HOME/session-state must be rejected",
      );
    }
    const bigYamlSess = discovered.find((s) => s.sessionId === "valid-big-yaml-session");
    assert.ok(bigYamlSess, "valid events.jsonl with oversized workspace.yaml still discovers session");
    assert.equal(
      bigYamlSess?.workspacePath,
      undefined,
      "oversized (>64KB) workspace.yaml must not be read",
    );

    // 3. PushBus out-of-order: opaque subagentStop (no label) -> labeled child hook -> label-only subagentStart
    //    (plus concurrent second subagent to verify disambiguation via backfilled label!)
    const offlineFetch: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED"));
    const bus = new PushBus({ includeGlobalTelemetryFile: false });
    const uuid1 = "11111111-aaaa-4aaa-8aaa-111111111111";
    const uuid2 = "22222222-bbbb-4bbb-8bbb-222222222222";

    const stop1NoLabel = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "subagentStop", "--cwd", tmpDir],
      {
        stdinText: JSON.stringify({
          sessionId: "s-bug30-ooo",
          agentId: uuid1,
          response: "Backend finished",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const stop2NoLabel = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "subagentStop", "--cwd", tmpDir],
      {
        stdinText: JSON.stringify({
          sessionId: "s-bug30-ooo",
          agentId: uuid2,
          response: "Explore finished",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const child1Labeled = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", tmpDir],
      {
        stdinText: JSON.stringify({
          sessionId: "s-bug30-ooo",
          agentId: uuid1,
          agentType: "Backend Engineer",
          toolName: "view",
          toolCallId: "tc-ooo-b1",
          toolArgs: { path: "src/index.ts" },
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const child2Labeled = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "preToolUse", "--cwd", tmpDir],
      {
        stdinText: JSON.stringify({
          sessionId: "s-bug30-ooo",
          agentId: uuid2,
          agentType: "Explore",
          toolName: "grep",
          toolCallId: "tc-ooo-e1",
          toolArgs: { pattern: "PushBus" },
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const start1 = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "subagentStart", "--cwd", tmpDir],
      {
        stdinText: JSON.stringify({
          sessionId: "s-bug30-ooo",
          agentName: "backend-engineer",
          agentDisplayName: "Backend Engineer",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    const start2 = await runHookEmit(
      ["--ide", "copilot-vscode", "--event", "subagentStart", "--cwd", tmpDir],
      {
        stdinText: JSON.stringify({
          sessionId: "s-bug30-ooo",
          agentName: "explore",
          agentDisplayName: "Explore",
        }),
        stdout: () => undefined,
        fetchImpl: offlineFetch,
      },
    );

    const baseEp = Date.now() / 1000;
    start1.event!.epoch = baseEp;
    child1Labeled.event!.epoch = baseEp + 0.1;
    stop1NoLabel.event!.epoch = baseEp + 0.2;
    start2.event!.epoch = baseEp + 0.05;
    child2Labeled.event!.epoch = baseEp + 0.15;
    stop2NoLabel.event!.epoch = baseEp + 0.25;

    // Deliver opaque subagentStops FIRST, then labeled child hooks, then label-only subagentStarts
    bus.ingest([
      stop1NoLabel.event!,
      stop2NoLabel.event!,
      child1Labeled.event!,
      child2Labeled.event!,
      start1.event!,
      start2.event!,
    ]);

    const snap = buildSessionSnapshot(bus.getSessionEvents("s-bug30-ooo"), {
      sessionId: "s-bug30-ooo",
      ide: "copilot-vscode",
      nowEpochSec: baseEp + 2,
    });
    const subs = snap.agents.filter((a) => a.nodeType === "agent" && !a.isRoot);
    assert.equal(subs.length, 2, "both concurrent out-of-order subagents must correlate cleanly");
    assert.ok(subs.every((a) => !isOpaqueAgentId(a.id) && a.status === "DONE"));
    assert.ok(subs.some((a) => a.label === "Backend Engineer"));
    assert.ok(subs.some((a) => a.label === "Explore"));

    // 4. PushBus bounded correlation maps cap at MAX_CORRELATION_ENTRIES (500)
    const capBus = new PushBus({ includeGlobalTelemetryFile: false });
    const bulkEvents: EnrichedEvent[] = [];
    for (let i = 0; i < MAX_CORRELATION_ENTRIES + 25; i++) {
      bulkEvents.push({
        id: `cap-ev-${i}`,
        ts: toIsoTest(baseEp + i * 0.001),
        epoch: baseEp + i * 0.001,
        ide: "copilot-vscode",
        channel: "hook",
        sessionId: `cap-sess-${i}`,
        agentId: "root",
        targetAgentId: "explore",
        kind: "subagent_spawn",
        summary: "Spawned Explore",
        payload: { hookEvent: "subagentStart", agentType: "Explore", agentLabel: "Explore" },
      });
    }
    capBus.ingest(bulkEvents);
    const openSpawns = (capBus as unknown as { openUnlinkedSpawns: Map<string, unknown> }).openUnlinkedSpawns;
    const subParents = (capBus as unknown as { subagentToParent: Map<string, unknown> }).subagentToParent;
    assert.ok(openSpawns.size <= MAX_CORRELATION_ENTRIES, `openUnlinkedSpawns (${openSpawns.size}) must be <= ${MAX_CORRELATION_ENTRIES}`);
    assert.ok(subParents.size <= MAX_CORRELATION_ENTRIES, `subagentToParent (${subParents.size}) must be <= ${MAX_CORRELATION_ENTRIES}`);
  });
});

function toIsoTest(epochSec: number): string {
  return new Date(Math.round(epochSec * 1000)).toISOString();
}
