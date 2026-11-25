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
    assert.ok(events.some((e) => e.kind === "subagent_spawn" && e.targetAgentId === "backend"));
    assert.ok(events.some((e) => e.kind === "subagent_done"));

    const snap = buildSessionSnapshot(events, {
      sessionId: sessId,
      ide: "claude-code",
      nowEpochSec: Date.parse("2026-11-24T20:10:12Z") / 1000,
    });
    const rootNode = snap.agents.find((a) => a.id === "root");
    assert.equal(rootNode?.status, "WAITING", "unanswered AskUserQuestion puts root in WAITING");
    assert.equal(snap.waitingOn, "user");
    const subNode = snap.agents.find((a) => a.id === "agent-1");
    assert.equal(subNode?.status, "DONE");
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

    // 3. Orchestrator read-only guardrail blocking Bash -> exit 2
    const denyOrchRes = await runHookEmit(
      ["--ide", "claude-code", "--event", "PreToolUse", "--role", "orchestrator"],
      {
        stdinText: JSON.stringify({
          session_id: "hook-s1",
          cwd: wsDir,
          tool_name: "Bash",
          tool_input: { command: "rm -rf build" },
        }),
        stdout: () => undefined,
        stderr: () => undefined,
        fetchImpl: offlineFetch,
      },
    );
    assert.equal(denyOrchRes.exitCode, 2);
    assert.equal(denyOrchRes.denied, true);

    // 4. PushBus byte-offset tailer picks up all 3 events from telemetry.jsonl
    const bus = new PushBus({
      extraWorkspaces: [wsDir],
      includeGlobalTelemetryFile: false,
    });
    const polled = await bus.pollFiles();
    assert.equal(polled.accepted, 3);
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
});
