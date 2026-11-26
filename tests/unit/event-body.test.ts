import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import ts from "typescript";
import type * as FileLinkBridgeModule from "../../extension/src/fileLinkBridge.js";
import { dispatchToolCall } from "../../src/mcp/server.js";

function loadFileLinkBridge(): typeof FileLinkBridgeModule {
  const srcPath = path.resolve(
    process.cwd(),
    "extension",
    "src",
    "fileLinkBridge.ts",
  );
  const source = fsSync.readFileSync(srcPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const req = createRequire(import.meta.url);
  const mod = { exports: {} as Partial<typeof FileLinkBridgeModule> };
  const fn = new Function("exports", "require", "module", outputText);
  fn(mod.exports, req, mod);
  return mod.exports as typeof FileLinkBridgeModule;
}

const { getDefaultAllowedRoots, resolveAllowedFileUri } = loadFileLinkBridge();
import { createStudioServer } from "../../src/server/index.js";
import {
  AntigravityAdapter,
  ClaudeCodeAdapter,
  CopilotVSCodeAdapter,
  EventBodyStore,
  MAX_BODY_BYTES,
  MAX_ENTRIES,
  MAX_TOTAL_BYTES,
  TelemetryAggregator,
  buildSessionSnapshot,
  normalizeWsPath,
} from "../../src/telemetry/index.js";
import { pathMatchesRoot } from "../../src/telemetry/adapters/project-match.js";

describe("S1-45: EventBodyStore, Adapter Full-Body Capture, /api/event-body & file:// Bridge", () => {
  let tmpDir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-studio-s1-45-"));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("EventBodyStore enforces 512 KB UTF-8 clean truncation, LRU entry eviction, and 32 MB total byte bound", () => {
    assert.equal(MAX_BODY_BYTES, 512 * 1024);
    assert.equal(MAX_ENTRIES, 500);
    assert.equal(MAX_TOTAL_BYTES, 32 * 1024 * 1024);

    // 1. Single-entry 512 KB truncation on multi-byte UTF-8 boundary (no U+FFFD)
    const store = new EventBodyStore();
    const emoji = "🚀"; // 4 UTF-8 bytes each
    const huge = emoji.repeat(140_000); // 560,000 bytes > 512 KB
    const stored = store.set("s1", "e1", huge);
    assert.equal(stored.truncated, true);
    assert.ok(stored.byteLength <= MAX_BODY_BYTES);
    assert.equal(stored.byteLength % 4, 0);
    assert.ok(!stored.body.includes("\uFFFD"));
    assert.equal(store.get("s1", "e1")?.body, stored.body);
    store.clear();
    assert.equal(store.size, 0);
    assert.equal(store.totalBytes, 0);

    // 2. LRU eviction on MAX_ENTRIES (custom small bound + get() refresh)
    const lruStore = new EventBodyStore({ maxEntries: 3, maxTotalBytes: 1024 * 1024 });
    lruStore.set("s", "e1", "one");
    lruStore.set("s", "e2", "two");
    lruStore.set("s", "e3", "three");
    // Touch e1 so e2 becomes oldest
    assert.equal(lruStore.get("s", "e1")?.body, "one");
    lruStore.set("s", "e4", "four");
    assert.equal(lruStore.size, 3);
    assert.equal(lruStore.has("s", "e2"), false);
    assert.equal(lruStore.has("s", "e1"), true);
    assert.equal(lruStore.has("s", "e3"), true);
    assert.equal(lruStore.has("s", "e4"), true);

    // 3. 32 MB total byte cap with default EventBodyStore
    const chunk512k = "a".repeat(MAX_BODY_BYTES);
    for (let i = 0; i < 66; i++) {
      store.set("cap", `ev-${i}`, chunk512k);
    }
    assert.ok(store.totalBytes <= MAX_TOTAL_BYTES);
    assert.equal(store.size, 64);
    assert.equal(store.has("cap", "ev-0"), false);
    assert.equal(store.has("cap", "ev-1"), false);
    assert.equal(store.has("cap", "ev-65"), true);
  });

  it("Adapters capture untruncated full bodies via onFullBody while keeping inline payloads compact", async () => {
    const longUser = "USER_PROMPT_START " + "U".repeat(2500) + " USER_PROMPT_END";
    const longSpawn = "SPAWN_PROMPT_START " + "P".repeat(2200) + " SPAWN_PROMPT_END";
    const longMsg = "PEER_MSG_START " + "M".repeat(2400) + " PEER_MSG_END";
    const longTurn = "FINAL_TURN_START " + "T".repeat(2100) + " FINAL_TURN_END";

    // A. Antigravity adapter (including subagent_spawn ID update after CREATED_SUBAGENT_RE)
    const brainDir = path.join(tmpDir, "brain");
    const rootCid = "11111111-1111-4111-8111-111111111111";
    const childCid = "22222222-2222-4222-8222-222222222222";
    await fs.mkdir(path.join(brainDir, rootCid, ".system_generated", "logs"), {
      recursive: true,
    });
    await fs.mkdir(path.join(brainDir, childCid, ".system_generated", "logs"), {
      recursive: true,
    });
    const agyRows = [
      {
        type: "USER_INPUT",
        created_at: "2026-11-24T20:00:00Z",
        content: longUser,
      },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T20:00:01Z",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: { TypeName: "backend-engineer", Prompt: longSpawn },
          },
          {
            name: "send_message",
            args: { Recipient: "qa-validator", Message: longMsg },
          },
        ],
      },
      {
        type: "GENERIC",
        created_at: "2026-11-24T20:00:02Z",
        content: `Created the following subagent: {"conversationId":"${childCid}"}`,
      },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T20:00:05Z",
        content: longTurn,
      },
    ];
    await fs.writeFile(
      path.join(brainDir, rootCid, ".system_generated", "logs", "transcript.jsonl"),
      agyRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const agy = new AntigravityAdapter({ brainDir });
    const agySessions = await agy.discoverSessions();
    assert.equal(agySessions.length, 1);

    const agyWithoutCb = await agy.parseSession(agySessions[0]!);
    const agyBodies = new Map<string, string>();
    const agyWithCb = await agy.parseSession(agySessions[0]!, {
      onFullBody: (id, body) => agyBodies.set(id, body),
    });

    assert.deepEqual(
      agyWithCb.map((e) => e.id),
      agyWithoutCb.map((e) => e.id),
      "onFullBody must not alter deterministic event IDs",
    );

    const agyUserEv = agyWithCb.find((e) => e.kind === "user_input")!;
    const agySpawnEv = agyWithCb.find((e) => e.kind === "subagent_spawn")!;
    const agyMsgEv = agyWithCb.find((e) => e.kind === "message")!;
    const agyTurnEv = agyWithCb.find((e) => e.kind === "assistant_turn_end")!;

    assert.equal(String(agyUserEv.payload?.body).length, 1400);
    assert.equal(agyUserEv.bodyLength, longUser.length);
    assert.equal(agyUserEv.bodyTruncated, true);
    assert.equal(agyBodies.get(agyUserEv.id), longUser);

    assert.equal(String(agySpawnEv.payload?.prompt).length, 1000);
    assert.equal(agySpawnEv.bodyLength, longSpawn.length);
    assert.equal(agySpawnEv.bodyTruncated, true);
    assert.equal(agyBodies.get(agySpawnEv.id), longSpawn);

    assert.equal(String(agyMsgEv.payload?.body).length, 1400);
    assert.equal(agyMsgEv.bodyLength, longMsg.length);
    assert.equal(agyMsgEv.bodyTruncated, true);
    assert.equal(agyBodies.get(agyMsgEv.id), longMsg);

    assert.equal(String(agyTurnEv.payload?.body).length, 1000);
    assert.equal(agyTurnEv.bodyLength, longTurn.length);
    assert.equal(agyTurnEv.bodyTruncated, true);
    assert.equal(agyBodies.get(agyTurnEv.id), longTurn);

    const agySnap = buildSessionSnapshot(agyWithCb, {
      sessionId: rootCid,
      ide: "antigravity",
    });
    const userAct = agySnap.activity.find((a) => a.id === agyUserEv.id)!;
    assert.equal(userAct.body.length, 1400);
    assert.equal(userAct.bodyLength, longUser.length);
    assert.equal(userAct.bodyTruncated, true);

    // B. Claude Code adapter
    const claudeDir = path.join(tmpDir, "claude-projects");
    const cFolder = path.join(claudeDir, "c--Demo");
    await fs.mkdir(cFolder, { recursive: true });
    const cRows = [
      {
        type: "user",
        uuid: "cu1",
        sessionId: "c-long-1",
        timestamp: "2026-11-24T20:10:00Z",
        message: { role: "user", content: longUser },
      },
      {
        type: "assistant",
        uuid: "ca1",
        sessionId: "c-long-1",
        timestamp: "2026-11-24T20:10:01Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_agent",
              name: "Agent",
              input: { subagent_type: "qa", prompt: longSpawn },
            },
            {
              type: "tool_use",
              id: "tu_msg",
              name: "SendMessage",
              input: { recipient: "orchestrator", message: longMsg },
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "ca2",
        sessionId: "c-long-1",
        timestamp: "2026-11-24T20:10:02Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: longTurn }],
        },
      },
    ];
    await fs.writeFile(
      path.join(cFolder, "c-long-1.jsonl"),
      cRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );
    const claude = new ClaudeCodeAdapter({ projectsDir: claudeDir });
    const cSessions = await claude.discoverSessions();
    const cBodies = new Map<string, string>();
    const cEvents = await claude.parseSession(cSessions[0]!, {
      onFullBody: (id, body) => cBodies.set(id, body),
    });
    const cTurn = cEvents.find((e) => e.kind === "assistant_turn_end")!;
    const cSpawn = cEvents.find((e) => e.kind === "subagent_spawn")!;
    assert.equal(cBodies.get(cTurn.id), longTurn);
    assert.equal(cTurn.bodyTruncated, true);
    assert.equal(String(cTurn.payload?.body).length, 1000);
    assert.equal(cBodies.get(cSpawn.id), longSpawn);
    assert.equal(String(cSpawn.payload?.prompt).length, 1000);

    // C. Copilot VS Code adapter
    const vscDir = path.join(tmpDir, "vsc-storage");
    const chatDir = path.join(vscDir, "ws1", "chatSessions");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.writeFile(
      path.join(chatDir, "vsc-long-1.json"),
      JSON.stringify({
        sessionId: "vsc-long-1",
        creationDate: Date.parse("2026-11-24T20:20:00Z"),
        requests: [
          {
            requestId: "vr0",
            timestamp: Date.parse("2026-11-24T20:20:00Z"),
            message: { text: longUser },
            response: [
              {
                kind: "toolInvocationSerialized",
                toolId: "agent/runSubagent",
                toolCallId: "vs-sub-1",
                isComplete: true,
                toolSpecificData: { agentName: "qa", prompt: longSpawn },
              },
              { kind: "markdownContent", content: { value: longTurn } },
            ],
            modelState: { completedAt: Date.parse("2026-11-24T20:20:05Z") },
          },
        ],
      }),
      "utf8",
    );
    const vsc = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const vSessions = await vsc.discoverSessions();
    const vBodies = new Map<string, string>();
    const vEvents = await vsc.parseSession(vSessions[0]!, {
      onFullBody: (id, body) => vBodies.set(id, body),
    });
    const vUser = vEvents.find((e) => e.kind === "user_input")!;
    const vTurn = vEvents.find((e) => e.kind === "assistant_turn_end")!;
    assert.equal(vBodies.get(vUser.id), longUser);
    assert.equal(vUser.bodyTruncated, true);
    assert.equal(vBodies.get(vTurn.id), longTurn);
    assert.equal(vTurn.bodyTruncated, true);
  });

  it("GET /api/event-body serves 200 on cache miss hydration, 400 on missing params, 404 on unknown, and handles 100KB POST /api/ingest", async () => {
    const brainDir = path.join(tmpDir, "http-brain");
    const cid = "33333333-3333-4333-8333-333333333333";
    await fs.mkdir(path.join(brainDir, cid, ".system_generated", "logs"), {
      recursive: true,
    });
    const fullPrompt = "HTTP_FULL_BODY_" + "Z".repeat(3000) + "_END";
    await fs.writeFile(
      path.join(brainDir, cid, ".system_generated", "logs", "transcript.jsonl"),
      JSON.stringify({
        type: "USER_INPUT",
        created_at: "2026-11-24T21:00:00Z",
        content: fullPrompt,
      }) + "\n",
      "utf8",
    );

    const aggregator = new TelemetryAggregator({
      brainDir,
      claudeDir: path.join(tmpDir, "no-claude"),
      vscodeDir: path.join(tmpDir, "no-vsc"),
      includeGlobalTelemetryFile: false,
      bodyStore: new EventBodyStore(),
    });

    // Determine expected event ID without touching aggregator.bodyStore first
    const agy = new AntigravityAdapter({ brainDir });
    const discovered = await agy.discoverSessions();
    const parsed = await agy.parseSession(discovered[0]!);
    const targetEventId = parsed[0]!.id;
    assert.equal(aggregator.bodyStore.has(cid, targetEventId), false);

    const handle = createStudioServer({
      host: "127.0.0.1",
      port: 0,
      aggregator,
    });
    const { port } = await handle.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. 400 missing params
      const badResp = await fetch(`${base}/api/event-body?session=${cid}`);
      assert.equal(badResp.status, 400);
      const badJson = (await badResp.json()) as { ok: boolean; error: string };
      assert.equal(badJson.ok, false);
      assert.match(badJson.error, /Missing session or event/);

      // 2. 404 unknown event
      const missResp = await fetch(
        `${base}/api/event-body?session=${cid}&event=nope-123`,
      );
      assert.equal(missResp.status, 404);
      const missJson = (await missResp.json()) as { ok: boolean; error: string };
      assert.equal(missJson.ok, false);
      assert.equal(missJson.error, "Event body not found");

      // 3. 200 cache miss -> hydrates bodyStore via discoverSessions + parseSession
      const hitResp = await fetch(
        `${base}/api/event-body?session=${cid}&event=${targetEventId}`,
      );
      assert.equal(hitResp.status, 200);
      const hitJson = (await hitResp.json()) as {
        ok: boolean;
        sessionId: string;
        eventId: string;
        body: string;
        truncated: boolean;
        byteLength: number;
      };
      assert.equal(hitJson.ok, true);
      assert.equal(hitJson.sessionId, cid);
      assert.equal(hitJson.eventId, targetEventId);
      assert.equal(hitJson.body, fullPrompt);
      assert.equal(hitJson.truncated, false);
      assert.equal(hitJson.byteLength, Buffer.byteLength(fullPrompt, "utf8"));
      assert.equal(aggregator.bodyStore.has(cid, targetEventId), true);

      // 4. POST /api/ingest with 100 KB payload (>64KB old cap, <512KB new cap)
      const largeBody = "PUSH_BODY_" + "Q".repeat(100_000) + "_END";
      const ingestResp = await fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "push-big-1",
          sessionId: "push-sess-1",
          ide: "claude-code",
          agentId: "root",
          kind: "message",
          summary: "Large pushed message",
          payload: { body: largeBody },
        }),
      });
      assert.equal(ingestResp.status, 202);

      // /api/state remains compact
      const stateResp = await fetch(`${base}/api/state?session=push-sess-1`);
      assert.equal(stateResp.status, 200);
      const stateJson = (await stateResp.json()) as {
        events: Array<{
          id: string;
          bodyLength?: number;
          bodyTruncated?: boolean;
          payload?: { body?: string };
        }>;
      };
      const pushedEv = stateJson.events.find((e) => e.id === "push-big-1")!;
      assert.equal(pushedEv.payload?.body?.length, 1400);
      assert.equal(pushedEv.bodyLength, largeBody.length);
      assert.equal(pushedEv.bodyTruncated, true);

      // /api/event-body returns the full 100 KB body
      const pushedBodyResp = await fetch(
        `${base}/api/event-body?session=push-sess-1&event=push-big-1`,
      );
      assert.equal(pushedBodyResp.status, 200);
      const pushedBodyJson = (await pushedBodyResp.json()) as {
        ok: boolean;
        body: string;
      };
      assert.equal(pushedBodyJson.body, largeBody);
    } finally {
      await handle.close();
    }
  });

  it("fileLinkBridge parses Windows, percent-encoded, POSIX, localhost URIs, extracts #L anchors, and enforces root containment", () => {
    const winRoot = "d:/Work/Personal/AgentVisualizer";
    const posixRoot = "/Users/alice/workspace/demo";
    const fakeHome = "/Users/alice";
    const allowed = getDefaultAllowedRoots([winRoot, posixRoot], fakeHome);

    // 1. Windows drive path + #L10-L20
    const winRes = resolveAllowedFileUri(
      "file:///d:/Work/Personal/AgentVisualizer/src/mcp/server.ts#L10-L20",
      allowed,
    );
    assert.equal(winRes.ok, true);
    if (winRes.ok) {
      assert.equal(winRes.startLine, 10);
      assert.equal(winRes.endLine, 20);
      assert.match(winRes.fsPath.replace(/\\/g, "/"), /AgentVisualizer\/src\/mcp\/server\.ts$/i);
    }

    // 2. Percent-encoded uppercase drive letter D%3A + single line #L42
    const encRes = resolveAllowedFileUri(
      "file:///D%3A/Work/Personal/AgentVisualizer/README.md#L42",
      allowed,
    );
    assert.equal(encRes.ok, true);
    if (encRes.ok) {
      assert.equal(encRes.startLine, 42);
      assert.equal(encRes.endLine, undefined);
    }

    // 3. POSIX & file://localhost/ URIs + ~/.gemini & ~/.claude
    const posixRes = resolveAllowedFileUri(
      "file:///Users/alice/workspace/demo/src/app.ts#L5-12",
      allowed,
    );
    assert.equal(posixRes.ok, true);
    if (posixRes.ok) {
      assert.equal(posixRes.startLine, 5);
      assert.equal(posixRes.endLine, 12);
    }

    const geminiRes = resolveAllowedFileUri(
      "file://localhost/Users/alice/.gemini/antigravity/brain/123/plan.md",
      allowed,
    );
    assert.equal(geminiRes.ok, true);

    const claudeRes = resolveAllowedFileUri(
      "file:///Users/alice/.claude/projects/demo/notes.md",
      allowed,
    );
    assert.equal(claudeRes.ok, true);

    // 4. Reject non-file schemes and remote UNC hosts
    assert.equal(resolveAllowedFileUri("javascript:alert(1)", allowed).ok, false);
    assert.equal(resolveAllowedFileUri("https://example.com/a.ts", allowed).ok, false);
    assert.equal(
      resolveAllowedFileUri("file://remote-server/share/secret.txt", allowed).ok,
      false,
    );
    assert.equal(
      resolveAllowedFileUri("file://///remote-server/share/secret.txt", allowed).ok,
      false,
    );

    // 5. Reject traversal and sibling-prefix escapes outside allowed roots
    assert.equal(
      resolveAllowedFileUri(
        "file:///Users/alice/workspace/demo-evil/secret.ts",
        allowed,
      ).ok,
      false,
    );
    assert.equal(
      resolveAllowedFileUri("file:///etc/passwd", allowed).ok,
      false,
    );
    assert.equal(
      resolveAllowedFileUri(
        "file:///d:/Work/Personal/AgentVisualizer/../OtherRepo/secret.ts",
        allowed,
      ).ok,
      false,
    );
  });

  it("S1-61 (1): Copilot isMsgTool calls hydrate onFullBody with accurate bodyLength/bodyTruncated across chatSessions & transcripts", async () => {
    const longMsg = "COPILOT_MSG_LONG_" + "M".repeat(2200) + "_END";
    const shortMsg = "Short peer ping";

    // A. chatSessions JSON (toolInvocationSerialized -> write_agent & send_message)
    const vscDir = path.join(tmpDir, "vsc-msg-storage");
    const chatDir = path.join(vscDir, "ws-msg", "chatSessions");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.writeFile(
      path.join(chatDir, "vsc-msg-1.json"),
      JSON.stringify({
        sessionId: "vsc-msg-1",
        creationDate: Date.parse("2026-11-26T01:00:00Z"),
        requests: [
          {
            requestId: "mr0",
            timestamp: Date.parse("2026-11-26T01:00:00Z"),
            message: { text: "Coordinate team" },
            response: [
              {
                kind: "toolInvocationSerialized",
                toolId: "write_agent",
                toolCallId: "msg-call-long",
                isComplete: true,
                toolSpecificData: {
                  agent_id: "backend-engineer",
                  message: longMsg,
                },
              },
              {
                kind: "toolInvocationSerialized",
                toolId: "send_message",
                toolCallId: "msg-call-short",
                isComplete: true,
                toolSpecificData: {
                  recipient: "qa-validator",
                  message: shortMsg,
                },
              },
            ],
            modelState: { completedAt: Date.parse("2026-11-26T01:00:05Z") },
          },
        ],
      }),
      "utf8",
    );

    const vsc = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const sessions = await vsc.discoverSessions();
    assert.equal(sessions.length, 1);

    const chatBodies = new Map<string, string>();
    const chatEvents = await vsc.parseSession(sessions[0]!, {
      onFullBody: (id, body) => chatBodies.set(id, body),
    });
    const chatLongEv = chatEvents.find((e) => e.toolCallId === "msg-call-long")!;
    const chatShortEv = chatEvents.find((e) => e.toolCallId === "msg-call-short")!;
    assert.equal(chatLongEv.kind, "message");
    assert.equal(chatLongEv.targetAgentId, "backend-engineer");
    assert.equal(String(chatLongEv.payload?.body).length, 1400);
    assert.equal(
      String((chatLongEv.payload?.toolSpecificData as Record<string, unknown>)?.message).length,
      1400,
    );
    assert.equal(chatLongEv.bodyLength, longMsg.length);
    assert.equal(chatLongEv.bodyTruncated, true);
    assert.equal(chatBodies.get(chatLongEv.id), longMsg);

    assert.equal(chatShortEv.kind, "message");
    assert.equal(chatShortEv.targetAgentId, "qa-validator");
    assert.equal(chatShortEv.payload?.body, shortMsg);
    assert.equal(chatShortEv.bodyLength, shortMsg.length);
    assert.equal(chatShortEv.bodyTruncated, false);
    assert.equal(chatBodies.get(chatShortEv.id), shortMsg);

    // B. Copilot JSONL transcript (both assistant.message toolRequests and tool.execution_start)
    const transcriptDir = path.join(tmpDir, ".copilot", "session-state", "tr-msg-1");
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, "events.jsonl");
    const trRows = [
      {
        type: "assistant.message",
        timestamp: "2026-11-26T01:05:00Z",
        data: {
          toolRequests: [
            {
              name: "write_agent",
              toolCallId: "tr-req-long",
              arguments: { agent_id: "frontend-engineer", message: longMsg },
            },
          ],
        },
      },
      {
        type: "tool.execution_start",
        timestamp: "2026-11-26T01:05:01Z",
        data: {
          toolName: "send_message",
          toolCallId: "tr-exec-long",
          arguments: { recipient: "qa-validator", content: longMsg },
        },
      },
    ];
    await fs.writeFile(
      transcriptFile,
      trRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const trBodies = new Map<string, string>();
    const trEvents = await vsc.parseTranscriptFile(transcriptFile, "tr-msg-1", {
      onFullBody: (id, body) => trBodies.set(id, body),
    });
    const reqEv = trEvents.find((e) => e.toolCallId === "tr-req-long")!;
    const execEv = trEvents.find((e) => e.toolCallId === "tr-exec-long")!;

    for (const ev of [reqEv, execEv]) {
      assert.equal(ev.kind, "message");
      assert.equal(String(ev.payload?.body).length, 1400);
      assert.equal(ev.bodyLength, longMsg.length);
      assert.equal(ev.bodyTruncated, true);
      assert.equal(trBodies.get(ev.id), longMsg);
    }
    assert.equal(
      String((reqEv.payload?.args as Record<string, unknown>)?.message).length,
      1400,
    );
    assert.equal(
      String((execEv.payload?.args as Record<string, unknown>)?.content).length,
      1400,
    );
  });

  it("S1-61 (2): TelemetryAggregator.getEventBody and GET /api/event-body hydrate full bodies from push-linked subagent transcripts", async () => {
    const vscDir = path.join(tmpDir, "vsc-push-tr");
    const chatDir = path.join(vscDir, "ws-tr", "chatSessions");
    await fs.mkdir(chatDir, { recursive: true });
    await fs.writeFile(
      path.join(chatDir, "sess-parent-1.json"),
      JSON.stringify({
        sessionId: "sess-parent-1",
        creationDate: Date.parse("2026-11-26T02:00:00Z"),
        requests: [
          {
            requestId: "r0",
            timestamp: Date.parse("2026-11-26T02:00:00Z"),
            message: { text: "Run subagent" },
            response: [{ kind: "markdownContent", content: { value: "Spawned" } }],
            modelState: { completedAt: Date.parse("2026-11-26T02:00:01Z") },
          },
        ],
      }),
      "utf8",
    );

    const subTranscriptDir = path.join(tmpDir, ".copilot", "session-state", "sub-tr-1");
    await fs.mkdir(subTranscriptDir, { recursive: true });
    const subTranscriptPath = path.join(subTranscriptDir, "subagent.jsonl");
    const subFullMsg = "SUBAGENT_PUSH_LINKED_MSG_" + "S".repeat(2300) + "_END";
    await fs.writeFile(
      subTranscriptPath,
      JSON.stringify({
        type: "assistant.message",
        timestamp: "2026-11-26T02:00:03Z",
        data: {
          toolRequests: [
            {
              name: "send_message",
              toolCallId: "sub-msg-1",
              arguments: { recipient: "orchestrator", message: subFullMsg },
            },
          ],
        },
      }) + "\n",
      "utf8",
    );

    const aggregator = new TelemetryAggregator({
      brainDir: path.join(tmpDir, "no-brain"),
      claudeDir: path.join(tmpDir, "no-claude"),
      vscodeDir: vscDir,
      includeGlobalTelemetryFile: false,
      bodyStore: new EventBodyStore(),
    });

    // Link subagent transcript via PushBus subagent_spawn event
    aggregator.ingest([
      {
        id: "spawn-link-1",
        sessionId: "sess-parent-1",
        ide: "copilot-vscode",
        agentId: "root",
        kind: "subagent_spawn",
        targetAgentId: "backend-sub-1",
        summary: "Spawned backend",
        payload: {
          agentLabel: "Backend Engineer",
          agentTranscriptPath: subTranscriptPath,
        },
      },
    ]);

    // Populate snapshot to discover the exact event ID in the subagent transcript
    const { snapshot } = await aggregator.getSessionSnapshot("sess-parent-1");
    const subMsgEv = snapshot.events.find((e) => e.toolCallId === "sub-msg-1")!;
    assert.ok(subMsgEv, "subagent message event should appear in snapshot");
    assert.equal(subMsgEv.bodyLength, subFullMsg.length);
    assert.equal(subMsgEv.bodyTruncated, true);

    // Clear bodyStore to simulate cold cache / LRU eviction
    aggregator.bodyStore.clear();
    assert.equal(aggregator.bodyStore.has("sess-parent-1", subMsgEv.id), false);

    // Direct aggregator.getEventBody() must re-parse the push-linked subagent transcript
    const hydrated = await aggregator.getEventBody({
      sessionId: "sess-parent-1",
      eventId: subMsgEv.id,
    });
    assert.ok(hydrated);
    assert.equal(hydrated.body, subFullMsg);

    // Clear again and verify GET /api/event-body end-to-end
    aggregator.bodyStore.clear();
    const handle = createStudioServer({
      host: "127.0.0.1",
      port: 0,
      aggregator,
    });
    const { port } = await handle.listen(0, "127.0.0.1");
    try {
      const resp = await fetch(
        `http://127.0.0.1:${port}/api/event-body?session=sess-parent-1&event=${subMsgEv.id}`,
      );
      assert.equal(resp.status, 200);
      const json = (await resp.json()) as { ok: boolean; body: string };
      assert.equal(json.ok, true);
      assert.equal(json.body, subFullMsg);
    } finally {
      await handle.close();
    }
  });

  it("S1-61 (3): RichSessionSnapshot includes teamRoster from workspace .agent-team/team.yaml and omits safely when absent", async () => {
    const wsWithTeam = path.join(tmpDir, "ws-with-team");
    const wsWithoutTeam = path.join(tmpDir, "ws-without-team");
    await fs.mkdir(path.join(wsWithTeam, ".agent-team", "agents"), {
      recursive: true,
    });
    await fs.mkdir(wsWithoutTeam, { recursive: true });
    await fs.writeFile(
      path.join(wsWithTeam, ".agent-team", "agents", "backend-engineer.md"),
      "---\nname: Backend Engineer\ndescription: Builds backend\n---\nPrompt\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(wsWithTeam, ".agent-team", "team.yaml"),
      [
        "schemaVersion: 1",
        "project:",
        "  id: demo-team",
        "  title: Demo Team",
        "targets:",
        "  - copilot-vscode",
        "roster:",
        "  - id: backend-engineer",
        "    name: Backend Engineer",
        "    roleType: specialist",
        "    boardRole: backend",
        "    promptFile: agents/backend-engineer.md",
      ].join("\n") + "\n",
      "utf8",
    );

    const aggregator = new TelemetryAggregator({
      brainDir: path.join(tmpDir, "no-brain"),
      claudeDir: path.join(tmpDir, "no-claude"),
      vscodeDir: path.join(tmpDir, "no-vsc"),
      includeGlobalTelemetryFile: false,
      bodyStore: new EventBodyStore(),
    });

    aggregator.ingest([
      {
        id: "ev-with-team",
        sessionId: "sess-team-yes",
        ide: "copilot-vscode",
        workspacePath: wsWithTeam,
        agentId: "root",
        kind: "user_input",
        summary: "Hello team",
      },
      {
        id: "ev-no-team",
        sessionId: "sess-team-no",
        ide: "copilot-vscode",
        workspacePath: wsWithoutTeam,
        agentId: "root",
        kind: "user_input",
        summary: "Hello solo",
      },
    ]);

    const { snapshot: withSnap } = await aggregator.getSessionSnapshot("sess-team-yes", {
      workspace: wsWithTeam,
    });
    assert.deepEqual(withSnap.teamRoster, [
      {
        id: "backend-engineer",
        name: "Backend Engineer",
        role: "backend",
      },
    ]);

    const { snapshot: withoutSnap } = await aggregator.getSessionSnapshot("sess-team-no", {
      workspace: wsWithoutTeam,
    });
    assert.equal(withoutSnap.teamRoster, undefined);
  });

  it("BUG-25: Antigravity passive session delivers teamRoster via ancestor discovery, file:// URI workspace, MCP app_get_state, HTTP /api/state & SSE /api/stream", async () => {
    const repoRoot = path.join(tmpDir, "ag-team-repo");
    const subDir = path.join(repoRoot, "docs", "mockups");
    const brainDir = path.join(tmpDir, "ag-brain");
    const rootCid = "11111111-2222-3333-4444-555555555555";
    const childCid = "66666666-7777-8888-9999-aaaaaaaaaaaa";

    await fs.mkdir(path.join(repoRoot, ".agent-team", "agents"), {
      recursive: true,
    });
    await fs.mkdir(subDir, { recursive: true });
    await fs.mkdir(path.join(brainDir, rootCid, ".system_generated", "logs"), {
      recursive: true,
    });
    await fs.mkdir(path.join(brainDir, childCid, ".system_generated", "logs"), {
      recursive: true,
    });

    await fs.writeFile(
      path.join(repoRoot, ".agent-team", "agents", "backend-engineer.md"),
      "---\nname: Backend Engineer\ndescription: Builds backend\n---\nPrompt\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, ".agent-team", "agents", "frontend-engineer.md"),
      "---\nname: Frontend Engineer\ndescription: Builds UI\n---\nPrompt\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, ".agent-team", "team.yaml"),
      [
        "schemaVersion: 1",
        "project:",
        "  id: ag-demo-team",
        "  title: AG Demo Team",
        "targets:",
        "  - antigravity",
        "roster:",
        "  - id: backend-engineer",
        "    name: Backend Engineer",
        "    roleType: specialist",
        "    boardRole: backend",
        "    promptFile: agents/backend-engineer.md",
        "  - id: frontend-engineer",
        "    name: Frontend Engineer",
        "    roleType: specialist",
        "    boardRole: frontend",
        "    promptFile: agents/frontend-engineer.md",
      ].join("\n") + "\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(brainDir, rootCid, ".system_generated", "logs", "transcript.jsonl"),
      [
        JSON.stringify({
          type: "USER_INPUT",
          created_at: "2026-11-26T05:00:00.000Z",
          content: `Active Workspaces:\n- ${subDir}\nImplement BUG-25`,
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-26T05:00:02.000Z",
          tool_calls: [
            {
              name: "invoke_subagent",
              args: {
                Role: "Backend Engineer",
                Name: "backend-engineer",
                Prompt: "Fix backend roster",
              },
            },
          ],
        }),
        JSON.stringify({
          type: "GENERIC",
          created_at: "2026-11-26T05:00:03.000Z",
          content: `Created the following subagent: {"conversationId":"${childCid}"}`,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(brainDir, childCid, ".system_generated", "logs", "transcript.jsonl"),
      [
        JSON.stringify({
          type: "SYSTEM_MESSAGE",
          created_at: "2026-11-26T05:00:03.500Z",
          content: `sender=${rootCid} content=Fix backend roster`,
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-26T05:00:05.000Z",
          content: "Done fixing roster.",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    // Verify Windows drive casing & file:/// URI normalization in pathMatchesRoot
    assert.equal(
      pathMatchesRoot("D:\\Work\\Personal\\AgentVisualizer\\docs", "d:/Work/Personal/AgentVisualizer"),
      true,
    );
    assert.equal(
      pathMatchesRoot("file:///d%3A/Work/Personal/AgentVisualizer", "D:\\Work\\Personal\\AgentVisualizer"),
      true,
    );
    assert.equal(
      normalizeWsPath("file://localhost/D%3A/Work/Personal/AgentVisualizer/"),
      "d:/Work/Personal/AgentVisualizer",
    );

    const aggregator = new TelemetryAggregator({
      brainDir,
      claudeDir: path.join(tmpDir, "no-claude"),
      vscodeDir: path.join(tmpDir, "no-vsc"),
      includeGlobalTelemetryFile: false,
      bodyStore: new EventBodyStore(),
    });

    const expectedRoster = [
      { id: "backend-engineer", name: "Backend Engineer", role: "backend" },
      { id: "frontend-engineer", name: "Frontend Engineer", role: "frontend" },
    ];

    // 1. Direct aggregator snapshot (without explicit project/workspace filter; subdir workspace walks up to repoRoot)
    const { snapshot: directSnap } = await aggregator.getSessionSnapshot(rootCid, {
      ide: "antigravity",
    });
    assert.deepEqual(directSnap.teamRoster, expectedRoster);

    // 2. Aggregator snapshot with file:// URI workspace filter
    const fileUriWs = pathToFileURL(repoRoot).href;
    const { snapshot: uriSnap } = await aggregator.getSessionSnapshot(rootCid, {
      ide: "antigravity",
      workspace: fileUriWs,
    });
    assert.deepEqual(uriSnap.teamRoster, expectedRoster);

    // 3. MCP app_get_state preserves teamRoster
    const mcpRes = await dispatchToolCall(
      "app_get_state",
      { ide: "antigravity", session: rootCid },
      { aggregator },
    );
    assert.notEqual(mcpRes.isError, true);
    assert.deepEqual(
      (mcpRes.structuredContent as { teamRoster?: unknown }).teamRoster,
      expectedRoster,
    );

    // 4. HTTP /api/state and SSE /api/stream preserve teamRoster
    const handle = createStudioServer({
      host: "127.0.0.1",
      port: 0,
      aggregator,
    });
    const { port } = await handle.listen(0, "127.0.0.1");
    try {
      const stateResp = await fetch(
        `http://127.0.0.1:${port}/api/state?ide=antigravity&session=${rootCid}`,
      );
      assert.equal(stateResp.status, 200);
      const stateJson = (await stateResp.json()) as { teamRoster?: unknown };
      assert.deepEqual(stateJson.teamRoster, expectedRoster);

      const ac = new AbortController();
      const sseResp = await fetch(
        `http://127.0.0.1:${port}/api/stream?ide=antigravity&session=${rootCid}`,
        { signal: ac.signal },
      );
      assert.equal(sseResp.status, 200);
      const reader = sseResp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (!buf.includes("event: state\n") || !buf.includes("\n\n")) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const idx = buf.indexOf("data: ");
          if (idx >= 0 && buf.indexOf("\n\n", idx) > idx) break;
        }
      } finally {
        ac.abort();
      }
      const dataLine = buf
        .split(/\r?\n/)
        .find((l) => l.startsWith("data: "));
      assert.ok(dataLine, "expected SSE data line");
      const sseJson = JSON.parse(dataLine.slice("data: ".length)) as {
        teamRoster?: unknown;
      };
      assert.deepEqual(sseJson.teamRoster, expectedRoster);
    } finally {
      await handle.close();
    }
  });
});
