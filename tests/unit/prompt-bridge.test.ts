import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  PromptBridgeCreateSchema,
  PendingHumanPromptSchema,
  PromptSourceSchema,
  PromptStatusSchema,
} from "../../src/schema/telemetry.js";
import {
  CopilotVSCodeAdapter,
  MAX_ACTIVE_PROMPTS,
  MAX_TERMINAL_PROMPTS,
  PromptBridge,
  PushBus,
  TERMINAL_RETENTION_MS,
  TelemetryAggregator,
  buildSessionSnapshot,
  classifyExternalTool,
} from "../../src/telemetry/index.js";

let tmpDir = "";
let prevHome: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "as-pb-"));
  prevHome = process.env.AGENT_STUDIO_HOME;
  process.env.AGENT_STUDIO_HOME = path.join(tmpDir, "home");
});

afterEach(async () => {
  if (prevHome === undefined) {
    delete process.env.AGENT_STUDIO_HOME;
  } else {
    process.env.AGENT_STUDIO_HOME = prevHome;
  }
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("S1-77: PromptBridge, Schemas, Attribution & embed=1 Isolation", () => {
  it("validates schemas and classifies ask_human / agent_studio_ask_human across HUMAN_TOOL_SET and Copilot adapter", async () => {
    assert.equal(PromptSourceSchema.parse("studio-mcp"), "studio-mcp");
    assert.equal(PromptSourceSchema.parse("studio-vscode-lm"), "studio-vscode-lm");
    assert.equal(PromptStatusSchema.parse("pending"), "pending");
    assert.equal(PromptStatusSchema.parse("expired"), "expired");

    const parsed = PromptBridgeCreateSchema.parse({
      questions: [{ question: "Which target environment?" }],
    });
    assert.equal(parsed.timeoutMs, 600_000);

    for (const tool of [
      "ask_human",
      "agent_studio_ask_human",
      "mcp__agent-studio__ask_human",
      "agent-studio/ask_human",
    ]) {
      const cls = classifyExternalTool(tool);
      assert.equal(cls?.id, "ext:human", `${tool} must classify to ext:human`);
      assert.equal(cls?.nodeType, "human");
    }

    // Verify Copilot adapter recognizes ask_human / agent_studio_ask_human in events.jsonl
    const copilotHome = path.join(tmpDir, "copilot-home");
    const sessDir = path.join(copilotHome, "session-state", "cop-ask-human");
    await fs.mkdir(sessDir, { recursive: true });
    await fs.writeFile(
      path.join(sessDir, "workspace.yaml"),
      `cwd: ${tmpDir}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(sessDir, "events.jsonl"),
      JSON.stringify({
        type: "tool.execution_start",
        timestamp: "2026-11-26T10:00:00Z",
        data: {
          toolCallId: "tc-ah-1",
          toolName: "agent_studio_ask_human",
          arguments: {
            questions: [{ question: "Ship S1-77?" }],
          },
        },
      }) + "\n",
      "utf8",
    );
    const adapter = new CopilotVSCodeAdapter({
      storageDir: path.join(tmpDir, "vscode-storage"),
      copilotHomeDir: copilotHome,
    });
    const disc = await adapter.discoverSessions();
    const matched = disc.find((s) => s.sessionId === "cop-ask-human");
    assert.ok(matched);
    // Studio's own direct ask tools are answered via the Prompt Bridge, so the
    // adapter must not synthesize a passive blocking prompt for them.
    assert.equal(matched.pendingQuestionCount ?? 0, 0);
  });

  it("handles atomic pending -> answered/canceled/expired transitions, 409 conflicts, long bodyStore, and MAX_ACTIVE_PROMPTS cap", async () => {
    const pushBus = new PushBus({ includeGlobalTelemetryFile: false });
    const bridge = new PromptBridge({ pushBus });
    try {
      const longAnswer = "A".repeat(1600);
      const created = await bridge.createPrompt({
        title: "Deploy target",
        questions: [
          {
            question: "Choose region",
            type: "single_select",
            options: [{ label: "us-east-1", recommended: true }, { label: "eu-west-1" }],
            allowCustomInput: true,
          },
        ],
        sessionId: "sess-1",
        workspacePath: tmpDir,
        ide: "antigravity",
        promptSource: "studio-mcp",
        timeoutMs: 600_000,
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;

      assert.equal(created.prompt.directReply, true);
      assert.equal(created.prompt.blockingToolCall, false);
      assert.equal(created.prompt.status, "pending");
      assert.equal(created.prompt.promptSource, "studio-mcp");
      assert.ok(PendingHumanPromptSchema.safeParse(created.prompt).success);

      // Verify synthetic tool_start was ingested and clears on answer
      let snap = buildSessionSnapshot(pushBus.getSessionEvents("sess-1"), {
        sessionId: "sess-1",
        ide: "antigravity",
        workspacePath: tmpDir,
      });
      assert.equal(snap.status, "WAITING");
      assert.equal(snap.waitingOn, "user");
      assert.equal(snap.pendingPrompts?.[0]?.id, created.prompt.id);
      assert.equal(snap.pendingPrompts?.[0]?.directReply, true);
      assert.equal(snap.pendingPrompts?.[0]?.blockingToolCall, false);

      const waitPromise = bridge.waitForResolution(created.prompt.id, 5000);
      const ansRes = bridge.answerPrompt(created.prompt.id, {
        answerText: longAnswer,
        answers: { q0: longAnswer },
        responder: "web-ui",
      });
      assert.equal(ansRes.ok, true);
      if (!ansRes.ok) return;
      assert.equal(ansRes.prompt.status, "answered");
      assert.equal(ansRes.prompt.answerText, longAnswer);

      const waited = await waitPromise;
      assert.equal(waited?.status, "answered");

      // Repeat answer or cancel yields conflict (409 semantics)
      const secondAns = bridge.answerPrompt(created.prompt.id, {
        answerText: "duplicate",
      });
      assert.equal(secondAns.ok, false);
      if (!secondAns.ok && !secondAns.notFound) {
        assert.equal(secondAns.conflict, true);
        assert.equal(secondAns.status, "answered");
      }
      const secondCancel = bridge.cancelPrompt(created.prompt.id, "too late");
      assert.equal(secondCancel.ok, false);
      if (!secondCancel.ok && !secondCancel.notFound) {
        assert.equal(secondCancel.conflict, true);
        assert.equal(secondCancel.status, "answered");
      }

      // Snapshot after answer clears WAITING and includes human answer activity
      snap = buildSessionSnapshot(pushBus.getSessionEvents("sess-1"), {
        sessionId: "sess-1",
        ide: "antigravity",
        workspacePath: tmpDir,
      });
      assert.notEqual(snap.status, "WAITING");
      assert.equal(snap.pendingPrompts?.length ?? 0, 0);
      const humanAct = snap.activity.find((a) => a.kind === "human");
      assert.ok(humanAct, "user_input answer event should produce human activity item");
      assert.equal(humanAct.bodyLength, longAnswer.length);
      assert.equal(humanAct.bodyTruncated, true);

      // Cancel flow emits tool_end isError and prevents subsequent answer
      const c2 = await bridge.createPrompt({
        questions: [{ question: "Confirm?" }],
        sessionId: "sess-2",
        timeoutMs: 600_000,
      });
      assert.equal(c2.ok, true);
      if (!c2.ok) return;
      const cancelRes = bridge.cancelPrompt(c2.prompt.id, "User dismissed");
      assert.equal(cancelRes.ok, true);
      const sess2Events = pushBus.getSessionEvents("sess-2");
      const cancelEnd = sess2Events.find(
        (e) => e.kind === "tool_end" && e.isError === true,
      );
      assert.ok(cancelEnd);

      // TTL expiration transitions pending -> expired via sweep
      const c3 = await bridge.createPrompt({
        questions: [{ question: "Expire soon?" }],
        sessionId: "sess-3",
        timeoutMs: 5000,
      });
      assert.equal(c3.ok, true);
      if (!c3.ok) return;
      const rec3 = bridge.getRecord(c3.prompt.id)!;
      bridge.sweep(rec3.expiresAtMs + 1);
      assert.equal(bridge.getPrompt(c3.prompt.id)?.status, "expired");

      // Enforce MAX_ACTIVE_PROMPTS = 64
      for (let i = 0; i < MAX_ACTIVE_PROMPTS; i++) {
        const res = await bridge.createPrompt({
          questions: [{ question: `Q${i}` }],
          sessionId: `cap-${i}`,
          timeoutMs: 600_000,
        });
        assert.equal(res.ok, true, `prompt ${i} should succeed`);
      }
      const overflow = await bridge.createPrompt({
        questions: [{ question: "Overflow" }],
        sessionId: "cap-overflow",
        timeoutMs: 600_000,
      });
      assert.equal(overflow.ok, false);
      if (!overflow.ok) {
        assert.equal(overflow.statusCode, 429);
      }

      // AbortSignal stops waitForResolution cleanly
      const activeList = bridge.listPending();
      const targetId = activeList[0]!.id;
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 30);
      const abortedWait = await bridge.waitForResolution(targetId, 5000, ac.signal);
      assert.equal(abortedWait?.status, "pending");
    } finally {
      bridge.dispose();
    }
  });

  it("attributes omitted sessionId to newest active matching session or synthesizes prompt-<id> while isolating embed=1 workspaces & IDEs", async () => {
    const ws1 = path.join(tmpDir, "ws-one");
    const ws2 = path.join(tmpDir, "ws-two");
    await fs.mkdir(ws1, { recursive: true });
    await fs.mkdir(ws2, { recursive: true });

    const agyDir = path.join(tmpDir, "brain");
    const claudeDir = path.join(tmpDir, "claude");
    const vscDir = path.join(tmpDir, "vscode");
    const copHome = path.join(tmpDir, "cop-home");
    await fs.mkdir(agyDir, { recursive: true });

    const agg = new TelemetryAggregator({
      brainDir: agyDir,
      claudeDir,
      vscodeDir: vscDir,
      copilotHomeDir: copHome,
      includeGlobalTelemetryFile: false,
      extraWorkspaces: [ws1, ws2],
    });

    try {
      const nowSec = Date.now() / 1000;
      // Active Antigravity session in ws1 and Copilot session in ws2
      agg.ingest([
        {
          id: "ev-ws1-1",
          ts: new Date((nowSec - 10) * 1000).toISOString(),
          epoch: nowSec - 10,
          ide: "antigravity",
          sessionId: "agy-ws1-active",
          workspacePath: ws1,
          agentId: "root",
          kind: "user_input",
          summary: "Work in ws1",
        },
        {
          id: "ev-ws2-1",
          ts: new Date((nowSec - 5) * 1000).toISOString(),
          epoch: nowSec - 5,
          ide: "copilot-vscode",
          sessionId: "cop-ws2-active",
          workspacePath: ws2,
          agentId: "root",
          kind: "user_input",
          summary: "Work in ws2",
        },
      ]);

      // 1. Omitted sessionId with workspacePath=ws1 binds to agy-ws1-active
      const boundPrompt = await agg.promptBridge.createPrompt({
        questions: [{ question: "Confirm ws1 action?" }],
        workspacePath: ws1,
        promptSource: "studio-mcp",
      });
      assert.equal(boundPrompt.ok, true);
      if (!boundPrompt.ok) return;
      assert.equal(boundPrompt.prompt.sessionId, "agy-ws1-active");
      assert.equal(boundPrompt.prompt.ide, "antigravity");

      // 2. Spun-off / unmatched workspace synthesizes "prompt-" + id with autoAttributed=true
      const ws3 = path.join(tmpDir, "ws-three");
      await fs.mkdir(ws3, { recursive: true });
      const autoPrompt = await agg.promptBridge.createPrompt({
        questions: [{ question: "Confirm ws3 spun-off?" }],
        workspacePath: ws3,
        promptSource: "studio-mcp",
      });
      assert.equal(autoPrompt.ok, true);
      if (!autoPrompt.ok) return;
      assert.ok(autoPrompt.prompt.sessionId?.startsWith("prompt-"));
      assert.equal(autoPrompt.record.autoAttributed, true);
      assert.equal(autoPrompt.prompt.ide, "mcp");

      // 3. embed=1 isolation: copilot-vscode on ws2 MUST NOT see agy-ws1-active or ws3 prompt
      const ws2Snap = await agg.getSessionSnapshot("cop-ws2-active", {
        ide: "copilot-vscode",
        workspace: ws2,
      });
      assert.equal(ws2Snap.snapshot.pendingPrompts?.length ?? 0, 0);

      // 4. embed=1 antigravity on ws1 sees boundPrompt
      const ws1Snap = await agg.getSessionSnapshot("agy-ws1-active", {
        ide: "antigravity",
        workspace: ws1,
      });
      assert.equal(ws1Snap.snapshot.pendingPrompts?.length, 1);
      assert.equal(ws1Snap.snapshot.pendingPrompts?.[0]?.id, boundPrompt.prompt.id);

      // 5. embed=1 antigravity on ws3 discovers the auto-attributed MCP prompt
      const ws3Disc = await agg.discoverSessions({
        ide: "antigravity",
        workspace: ws3,
      });
      assert.equal(ws3Disc.length, 1);
      assert.equal(ws3Disc[0]?.sessionId, autoPrompt.prompt.sessionId);
      assert.equal(ws3Disc[0]?.waitingOn, "user");

      // 6. studio-vscode-lm prompt in ws1 does NOT leak into embed=1 antigravity on ws1
      const vscLmPrompt = await agg.promptBridge.createPrompt({
        questions: [{ question: "VS Code LM question?" }],
        workspacePath: ws1,
        promptSource: "studio-vscode-lm",
      });
      assert.equal(vscLmPrompt.ok, true);
      if (!vscLmPrompt.ok) return;
      assert.equal(vscLmPrompt.prompt.ide, "copilot-vscode");

      const ws1AgyOnly = await agg.getSessionSnapshot("agy-ws1-active", {
        ide: "antigravity",
        workspace: ws1,
      });
      assert.ok(
        !ws1AgyOnly.snapshot.pendingPrompts?.some(
          (p) => p.id === vscLmPrompt.prompt.id,
        ),
        "copilot-vscode LM prompt must not leak into antigravity embed=1",
      );
    } finally {
      agg.dispose();
    }
  });

  it("fix pass: terminal eviction cap, retention window, dispose() wakes waiters & refuses creates, expired -> conflict, concurrent burst capped at MAX_ACTIVE_PROMPTS", async () => {
    // 1. Terminal eviction: never retain more than MAX_TERMINAL_PROMPTS
    {
      const pushBus = new PushBus({ includeGlobalTelemetryFile: false });
      const bridge = new PromptBridge({ pushBus });
      try {
        const ids: string[] = [];
        const total = MAX_TERMINAL_PROMPTS + 10;
        for (let i = 0; i < total; i++) {
          const c = await bridge.createPrompt({
            questions: [{ question: `Evict ${i}` }],
            sessionId: `evict-${i}`,
            timeoutMs: 600_000,
          });
          assert.equal(c.ok, true);
          if (!c.ok) return;
          ids.push(c.prompt.id);
          assert.equal(bridge.cancelPrompt(c.prompt.id, "done").ok, true);
        }
        bridge.sweep();
        let retained = 0;
        for (const id of ids) {
          if (bridge.getRecord(id)) retained++;
        }
        assert.equal(retained, MAX_TERMINAL_PROMPTS);
        assert.equal(bridge.getRecord(ids[0]!), null, "oldest terminal evicted");
        assert.ok(bridge.getRecord(ids[ids.length - 1]!), "newest terminal kept");
      } finally {
        bridge.dispose();
      }
    }

    // 2. Retention window, expired -> conflict, dispose wakes waiters
    const pushBus = new PushBus({ includeGlobalTelemetryFile: false });
    const bridge = new PromptBridge({ pushBus });
    try {
      const r1 = await bridge.createPrompt({
        questions: [{ question: "Retain?" }],
        sessionId: "ret-1",
        timeoutMs: 600_000,
      });
      assert.equal(r1.ok, true);
      if (!r1.ok) return;
      bridge.cancelPrompt(r1.prompt.id, "bye");
      const resolvedAt = bridge.getRecord(r1.prompt.id)!.resolvedAtMs!;
      bridge.sweep(resolvedAt + TERMINAL_RETENTION_MS - 1000);
      assert.ok(bridge.getRecord(r1.prompt.id), "kept inside retention window");
      bridge.sweep(resolvedAt + TERMINAL_RETENTION_MS + 1);
      assert.equal(bridge.getRecord(r1.prompt.id), null, "dropped after retention");

      const ex = await bridge.createPrompt({
        questions: [{ question: "Expire?" }],
        sessionId: "exp-1",
        timeoutMs: 5000,
      });
      assert.equal(ex.ok, true);
      if (!ex.ok) return;
      bridge.sweep(bridge.getRecord(ex.prompt.id)!.expiresAtMs + 1);
      const late = bridge.answerPrompt(ex.prompt.id, { answerText: "late" });
      assert.equal(late.ok, false);
      if (!late.ok) {
        assert.equal(late.conflict, true);
        if (late.conflict) assert.equal(late.status, "expired");
      }

      const w = await bridge.createPrompt({
        questions: [{ question: "Wait?" }],
        sessionId: "wait-1",
        timeoutMs: 600_000,
      });
      assert.equal(w.ok, true);
      if (!w.ok) return;
      const started = Date.now();
      const waiting = bridge.waitForResolution(w.prompt.id, 20_000);
      await new Promise((r) => setTimeout(r, 20));
      bridge.dispose();
      const woke = await waiting;
      assert.ok(Date.now() - started < 2000, "dispose() must wake waiters promptly");
      assert.equal(woke?.id, w.prompt.id);

      const afterDispose = await bridge.createPrompt({
        questions: [{ question: "After dispose?" }],
        sessionId: "post-dispose",
      });
      assert.equal(afterDispose.ok, false);
      if (!afterDispose.ok) assert.equal(afterDispose.statusCode, 503);
    } finally {
      bridge.dispose();
    }

    // 3. Concurrent burst with async attribution never exceeds the cap
    {
      const burstBus = new PushBus({ includeGlobalTelemetryFile: false });
      const burst = new PromptBridge({
        pushBus: burstBus,
        findActiveSession: async () => {
          await new Promise((r) => setTimeout(r, 15));
          return null;
        },
      });
      try {
        const results = await Promise.all(
          Array.from({ length: MAX_ACTIVE_PROMPTS + 16 }, (_, i) =>
            burst.createPrompt({
              questions: [{ question: `Burst ${i}` }],
              timeoutMs: 600_000,
            }),
          ),
        );
        const okCount = results.filter((r) => r.ok).length;
        const rejected = results.filter((r) => !r.ok && r.statusCode === 429).length;
        assert.equal(okCount, MAX_ACTIVE_PROMPTS);
        assert.equal(rejected, 16);
        assert.equal(burst.getActiveCount(), MAX_ACTIVE_PROMPTS);
      } finally {
        burst.dispose();
      }
    }
  });
});
