import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerProject } from "../../src/board/registry.js";
import { runHookEmit } from "../../src/cli/commands/hook-emit.js";
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
  cleanHumanSummary,
  deduplicateEvents,
  inferContextWindow,
  isBoardMutationToolCall,
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
    assert.equal(rootNode?.usage?.inputTokens, 58_000);
    assert.equal(rootNode?.usage?.outputTokens, 1500);
    assert.equal(rootNode?.usage?.cachedTokens, 12_000);
    // Latest turn occupancy (8000 + 2000 + 500 = 10500), NOT latched at 61000
    assert.equal(rootNode?.usage?.contextTokens, 10_500);
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
    assert.equal(subBg.usage?.inputTokens, 4000);
    assert.equal(subBg.usage?.outputTokens, 300);

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
});

function toIsoTest(epochSec: number): string {
  return new Date(Math.round(epochSec * 1000)).toISOString();
}
