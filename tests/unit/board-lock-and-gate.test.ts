import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  QaGateError,
  boardAdd,
  boardGate,
  boardHandoff,
  boardMove,
  boardNext,
  boardNote,
  boardOwner,
  boardPlan,
  boardReport,
  boardShow,
  boardSplit,
  boardStatus,
  getBoardLockPath,
  initBoardFile,
  listProjects,
  readBoard,
  registerProject,
  resolveProject,
  testrunClose,
  testrunList,
  testrunRecord,
  testrunStart,
  testrunStep,
  withBoardLock,
} from "../../src/board/index.js";

const LEGACY_BOARD_PATH = path.resolve(
  process.cwd(),
  "tests",
  "fixtures",
  "legacy-board.json",
);

describe("Board registry, atomic locking, and QA Gate engine", () => {
  let tmpRoot: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "av-board-test-"));
    origHome = process.env.AGENT_STUDIO_HOME;
    process.env.AGENT_STUDIO_HOME = path.join(tmpRoot, "studio-home");
  });

  afterEach(async () => {
    if (origHome === undefined) {
      delete process.env.AGENT_STUDIO_HOME;
    } else {
      process.env.AGENT_STUDIO_HOME = origHome;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("registers, lists, and resolves multi-project workspaces", async () => {
    const projDir = path.join(tmpRoot, "demo-app");
    const boardPath = path.join(projDir, "pipeline", "board.json");
    await initBoardFile(boardPath, { projectId: "demo-app" });

    const reg = registerProject({
      root: projDir,
      title: "Demo App",
      setDefault: true,
    });
    assert.equal(reg.id, "demo-app");

    const listed = listProjects();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "demo-app");

    // Resolve by ID
    const byId = resolveProject("demo-app");
    assert.equal(byId.boardPath, boardPath);
    assert.equal(byId.qaGateRequired, true);

    // Resolve by nested cwd walk-up
    const nestedDir = path.join(projDir, "src", "nested");
    await fs.mkdir(nestedDir, { recursive: true });
    const byCwd = resolveProject(undefined, nestedDir);
    assert.equal(byCwd.id, "demo-app");
    assert.equal(byCwd.root, projDir);

    // Resolve by explicit directory path
    const byPath = resolveProject(projDir);
    assert.equal(byPath.id, "demo-app");
  });

  it("serializes concurrent board mutations via board.json.lock without data loss", async () => {
    const projDir = path.join(tmpRoot, "concurrent-proj");
    const boardPath = path.join(projDir, "pipeline", "board.json");
    await initBoardFile(boardPath, { projectId: "concurrent-proj" });
    registerProject({ root: projDir, id: "concurrent-proj" });
    const ctx = { project: resolveProject("concurrent-proj") };

    const added = await boardAdd(ctx, {
      type: "task",
      title: "Concurrent target item",
      role: "backend",
    });
    const itemId = added.data.id;

    // Fire 12 parallel note mutations + 4 parallel item additions concurrently
    await Promise.all([
      ...Array.from({ length: 12 }, (_, idx) =>
        boardNote(ctx, {
          itemId,
          actor: `agent-${idx}`,
          text: `concurrent-note-${idx}`,
        }),
      ),
      ...Array.from({ length: 4 }, (_, idx) =>
        boardAdd(ctx, {
          type: "task",
          title: `Parallel task ${idx}`,
          role: "backend",
        }),
      ),
    ]);

    const finalBoard = await readBoard(boardPath);
    assert.equal(finalBoard.items.length, 5, "all 5 items should exist");
    const target = finalBoard.items.find((i) => i.id === itemId);
    assert.ok(target);
    // 1 created note + 12 concurrent notes = 13 notes
    assert.equal(target.notes?.length, 13);
    for (let idx = 0; idx < 12; idx++) {
      assert.ok(
        target.notes?.some((n) => n.includes(`concurrent-note-${idx}`)),
        `missing concurrent-note-${idx}`,
      );
    }

    // Lockfile must be cleaned up
    await assert.rejects(() => fs.stat(getBoardLockPath(boardPath)));
  });

  it("recovers automatically from a stale board.json.lock file", async () => {
    const projDir = path.join(tmpRoot, "stale-lock-proj");
    const boardPath = path.join(projDir, "pipeline", "board.json");
    await initBoardFile(boardPath, { projectId: "stale-lock-proj" });

    const lockPath = getBoardLockPath(boardPath);
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999 }), "utf8");
    const pastDate = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, pastDate, pastDate);

    const recovered = await withBoardLock(
      boardPath,
      (board) => {
        board.kv = { recovered: true };
        return "ok";
      },
      { staleMs: 1_000, timeoutMs: 2_000 },
    );
    assert.equal(recovered, "ok");

    const updated = await readBoard(boardPath);
    assert.deepEqual(updated.kv, { recovered: true });
  });

  it("enforces strict QA Gate on test -> done, passes after closed testrun, and audits overrideReason", async () => {
    const projDir = path.join(tmpRoot, "gate-proj");
    const boardPath = path.join(projDir, "pipeline", "board.json");
    await initBoardFile(boardPath, {
      projectId: "gate-proj",
      suites: { smoke: ["CP0", "CP1"], full: ["CP0", "CP1", "CP2"] },
    });
    registerProject({ root: projDir, id: "gate-proj" });
    const ctx = { project: resolveProject("gate-proj") };

    const story = await boardAdd(ctx, {
      type: "story",
      title: "Implement feature A",
      role: "backend",
      ac: ["Works cleanly"],
    });
    const storyId = story.data.id;

    // Move ready -> dev -> test
    await boardMove(ctx, { itemId: storyId, state: "dev", actor: "backend" });
    await boardMove(ctx, {
      itemId: storyId,
      state: "test",
      actor: "backend",
      note: "Ready for QA",
    });

    // 1. Reject test -> done when no testrun exists
    await assert.rejects(
      () =>
        boardMove(ctx, {
          itemId: storyId,
          state: "done",
          actor: "qa",
          note: "Trying to skip QA",
        }),
      (err: unknown) => err instanceof QaGateError && err.code === "QA_GATE_REJECTED",
    );

    // 2. Reject test -> done while testrun is still running (unclosed)
    const tr1 = await testrunStart(ctx, {
      suite: "smoke",
      build: "build-001",
      actor: "qa",
    });
    await testrunRecord(ctx, {
      runId: tr1.data.id,
      checkpoint: "CP0",
      result: "pass",
      note: "tsc ok",
    });
    await assert.rejects(
      () =>
        boardMove(ctx, {
          itemId: storyId,
          state: "done",
          actor: "qa",
        }),
      QaGateError,
    );

    // 3. Reject test -> done when testrun closed as FAILED
    await testrunRecord(ctx, {
      runId: tr1.data.id,
      checkpoint: "CP1",
      result: "fail",
      note: "regression found",
    });
    const closedFail = await testrunClose(ctx, { runId: tr1.data.id });
    assert.equal(closedFail.data.testrun.status, "failed");

    await assert.rejects(
      () =>
        boardMove(ctx, {
          itemId: storyId,
          state: "done",
          actor: "qa",
        }),
      QaGateError,
    );

    // 4. Pass testrun (all smoke checkpoints pass + closed) -> ACCEPT test -> done
    const tr2 = await testrunStart(ctx, {
      suite: "smoke",
      build: "build-002",
      actor: "qa",
    });
    await testrunStep(ctx, {
      runId: tr2.data.id,
      checkpoint: "CP0",
      stepIndex: 0,
      result: "pass",
      note: "step 0 green",
    });
    await testrunRecord(ctx, {
      runId: tr2.data.id,
      checkpoint: "CP0",
      result: "pass",
      note: "unit tests green",
    });
    await testrunRecord(ctx, {
      runId: tr2.data.id,
      checkpoint: "CP1",
      result: "pass",
      note: "integration green",
    });
    const closedPass = await testrunClose(ctx, { runId: tr2.data.id });
    assert.equal(closedPass.data.testrun.status, "passed");

    const movedDone = await boardMove(ctx, {
      itemId: storyId,
      state: "done",
      actor: "qa",
      note: "Verified",
    });
    assert.equal(movedDone.data.item.state, "done");
    assert.equal(movedDone.data.qaGate, "passed");
    assert.equal(movedDone.data.coveringTestrun, tr2.data.id);

    // 5. Audited override path on a brand-new item with no newer passing testrun
    // Wait 5ms so new item creation timestamp is strictly after tr2.closed
    await new Promise((r) => setTimeout(r, 15));
    const task2 = await boardAdd(ctx, {
      type: "task",
      title: "Docs-only hotfix",
      role: "backend",
    });
    // Ensure created_at is after tr2.closed (seconds resolution in nowIso -> set explicit future created_at via test)
    await withBoardLock(boardPath, (b) => {
      const it = b.items.find((i) => i.id === task2.data.id);
      if (it) {
        it.created_at = new Date(Date.now() + 5_000).toISOString();
      }
    });

    await boardMove(ctx, { itemId: task2.data.id, state: "dev", actor: "backend" });
    await boardMove(ctx, {
      itemId: task2.data.id,
      state: "test",
      actor: "backend",
      note: "docs updated",
    });

    // Without overrideReason -> rejected because tr2 predates task2
    await assert.rejects(
      () =>
        boardMove(ctx, {
          itemId: task2.data.id,
          state: "done",
          actor: "orchestrator",
        }),
      QaGateError,
    );

    // With explicit overrideReason -> accepted and audit-logged
    const overridden = await boardMove(ctx, {
      itemId: task2.data.id,
      state: "done",
      actor: "orchestrator",
      overrideReason: "Emergency typo fix approved by user",
    });
    assert.equal(overridden.data.item.state, "done");
    assert.equal(overridden.data.qaGate, "overridden");
    assert.ok(
      overridden.data.item.notes?.some((n) =>
        n.includes("[QA_GATE_OVERRIDE] Emergency typo fix approved by user"),
      ),
    );

    // Verify helper ops (status, next, show, owner, plan, gate, report, testrunList)
    await boardOwner(ctx, { itemId: storyId, owner: "av-backend-engineer" });
    const shown = await boardShow(ctx, { itemId: storyId });
    assert.match(shown.text, /owner: av-backend-engineer/);

    const status = await boardStatus(ctx, { showDone: true });
    assert.equal(status.data.counts["done"], 2);

    const next = await boardNext(ctx);
    assert.equal(next.data.length, 0);

    const runs = await testrunList(ctx);
    assert.equal(runs.data.length, 2);

    const planRes = await boardPlan(ctx, { sprint: "S2", goal: "Sprint 2" });
    assert.equal(planRes.data.sprint, "S2");

    const gateRes = await boardGate(ctx);
    assert.equal(gateRes.data.passed, false); // no full testrun yet

    const reportRes = await boardReport(ctx, { sprint: "S1", writeFile: true });
    assert.ok(reportRes.data.path);
    const reportMd = await fs.readFile(reportRes.data.path, "utf8");
    assert.match(reportMd, /# Sprint S1 review/);
  });

  it("operates cleanly on a temp copy of sanitized tests/fixtures/legacy-board.json and blocks stale TR-008 from closing a newly created item", async () => {
    const projDir = path.join(tmpRoot, "real-copy");
    const boardPath = path.join(projDir, "pipeline", "board.json");
    await fs.mkdir(path.dirname(boardPath), { recursive: true });
    await fs.copyFile(LEGACY_BOARD_PATH, boardPath);

    registerProject({ root: projDir, id: "real-copy" });
    const ctx = { project: resolveProject("real-copy") };

    const status = await boardStatus(ctx, { showDone: true });
    assert.equal(status.data.project, "agent-visualizer");
    assert.ok(status.data.items.some((i) => i.id === "S1-17"));

    // Create a fresh item on the temp copy so this test is 100% deterministic regardless of S1-17's live state
    const created = await boardAdd(ctx, {
      type: "task",
      title: "Verify stale historical TR-008 cannot bypass QA Gate",
      role: "tools",
      actor: "av-backend-engineer",
    });
    const freshId = created.data.id;

    // Ensure created_at is strictly after any historical closed/started testrun on the real board
    // (immune to naive-local vs UTC timezone offset skew from legacy Python board timestamps)
    await withBoardLock(boardPath, (b) => {
      let maxTsMs = Date.now();
      for (const tr of b.testruns) {
        for (const raw of [tr.closed, tr.started]) {
          if (!raw) continue;
          const parsed = Date.parse(raw);
          if (!Number.isNaN(parsed) && parsed > maxTsMs) {
            maxTsMs = parsed;
          }
        }
      }
      const it = b.items.find((i) => i.id === freshId);
      if (it) {
        it.created_at = new Date(maxTsMs + 60_000).toISOString();
      }
    });

    await boardMove(ctx, {
      itemId: freshId,
      state: "dev",
      actor: "av-backend-engineer",
    });
    await boardMove(ctx, {
      itemId: freshId,
      state: "test",
      actor: "av-backend-engineer",
      note: "Ready for QA verification",
    });

    // Historical TR-008 predates freshId -> QA Gate MUST reject test -> done
    await assert.rejects(
      () =>
        boardMove(ctx, {
          itemId: freshId,
          state: "done",
          actor: "qa",
        }),
      QaGateError,
    );
  });

  it("supports S1-65 context handoff, task splitting, structured show output, and auto-resume", async () => {
    const projDir = path.join(tmpRoot, "handoff-app");
    const boardPath = path.join(projDir, "pipeline", "board.json");
    await initBoardFile(boardPath, {
      projectId: "handoff-app",
      sprintId: "S1",
      suites: { smoke: ["CP0"] },
    });
    registerProject({ root: projDir, id: "handoff-app" });
    const ctx = { project: resolveProject("handoff-app") };

    const added = await boardAdd(ctx, {
      type: "story",
      title: "Large feature requiring fresh-context handoff and split",
      role: "backend",
      actor: "orchestrator",
    });
    const parentId = added.data.id;
    await boardOwner(ctx, { itemId: parentId, owner: "backend-engineer" });
    await boardMove(ctx, { itemId: parentId, state: "dev", actor: "backend-engineer" });

    // 1. Fresh-context handoff clears owner, sets pending_handoff, and appears in status & show
    const ho1 = await boardHandoff(ctx, {
      itemId: parentId,
      kind: "fresh_context",
      actor: "backend-engineer",
      summary: "Schema & model layer complete; server routes remain",
      modifiedFiles: ["src/schema/board.ts"],
      verifiedChecks: ["npm run check PASS"],
      remainingWork: ["Implement HTTP ingest advisory"],
      continuationBrief: "Pick up at src/server/http-server.ts",
      contextPercent: 58.4,
      contextTokens: 584_000,
      contextWindow: 1_000_000,
    });
    assert.equal(ho1.data.handoff?.status, "pending_handoff");
    assert.equal(ho1.data.owner, null);

    const st1 = await boardStatus(ctx);
    assert.match(st1.text, /\[HANDOFF_PENDING\]/);

    const shown1 = await boardShow(ctx, { itemId: parentId });
    assert.match(shown1.text, /handoff:/);
    assert.match(shown1.text, /status: pending_handoff/);
    assert.match(shown1.text, /continuation_brief: Pick up at src\/server\/http-server\.ts/);

    // Assigning new owner auto-transitions pending_handoff -> resumed
    const reowned = await boardOwner(ctx, { itemId: parentId, owner: "backend-engineer-2" });
    assert.equal(reowned.data.handoff?.status, "resumed");

    // 2. Task-split handoff + atomic boardSplit
    const ho2 = await boardHandoff(ctx, {
      itemId: parentId,
      kind: "task_split",
      actor: "backend-engineer-2",
      summary: "Work spans backend and frontend modules",
      modifiedFiles: ["src/server/http-server.ts"],
      remainingWork: ["Wire UI cards", "Add unit tests"],
      continuationBrief: "Split into frontend + QA tasks",
      splitProposals: [
        {
          title: "Wire UI handoff pill",
          role: "frontend",
          ac: ["Render HANDOFF pill"],
          rationale: "Exclusive web/ scope",
        },
        {
          title: "Add unit tests for handoff",
          role: "qa",
          ac: ["Tests pass"],
        },
      ],
      contextPercent: 61,
    });
    assert.equal(ho2.data.handoff?.status, "pending_split");
    assert.match((await boardStatus(ctx)).text, /\[SPLIT_PENDING\]/);

    const splitRes = await boardSplit(ctx, {
      itemId: parentId,
      actor: "orchestrator",
    });
    assert.equal(splitRes.data.children.length, 2);
    const [c1, c2] = splitRes.data.children;
    assert.equal(c1?.split_from, parentId);
    assert.equal(c2?.split_from, parentId);
    assert.equal(c1?.sprint, "S1");
    assert.ok(splitRes.data.parent.deps?.includes(c1!.id));
    assert.ok(splitRes.data.parent.deps?.includes(c2!.id));
    assert.equal(splitRes.data.parent.handoff?.status, "resumed");

    // Parent cannot move dev -> test while split child tasks are unfinished
    await assert.rejects(
      () =>
        boardMove(ctx, {
          itemId: parentId,
          state: "test",
          actor: "orchestrator",
          note: "Attempt premature test transition",
        }),
      /unfinished deps/,
    );

    // 3. S1-67 additive ContextHandoff fields round-trip cleanly via boardHandoff & boardShow
    const hoFull = await boardHandoff(ctx, {
      itemId: parentId,
      kind: "fresh_context",
      actor: "backend-engineer",
      objective: "Complete S1-67 handoff fields",
      summary: "All schema fields wired",
      evidence: ["unit test verified"],
      decisions: ["Use optional arrays"],
      assumptions: ["Backwards-compatible board.json"],
      unresolvedIssues: ["Verify Web Studio view"],
      modifiedFiles: ["src/schema/board.ts"],
      remainingWork: ["Finish QA"],
      continuationBrief: "Run CP0",
    });
    assert.equal(hoFull.data.handoff?.objective, "Complete S1-67 handoff fields");
    assert.deepEqual(hoFull.data.handoff?.decisions, ["Use optional arrays"]);
    const shownFull = await boardShow(ctx, { itemId: parentId });
    assert.match(shownFull.text, /objective: Complete S1-67 handoff fields/);
    assert.match(shownFull.text, /unresolved_issues:\s*\n\s*- Verify Web Studio view/);

    // 4. boardSplit deduplicates deps, rejects circular parent.id dep when blockParent=true, and allows blockParent=false
    await assert.rejects(
      () =>
        boardSplit(ctx, {
          itemId: parentId,
          actor: "orchestrator",
          subtasks: [
            {
              title: "Circular child",
              role: "backend",
              ac: ["Should fail"],
              deps: [parentId],
            },
          ],
        }),
      /Circular dependency/,
    );

    const noBlockSplit = await boardSplit(ctx, {
      itemId: parentId,
      actor: "orchestrator",
      blockParent: false,
      subtasks: [
        {
          title: "Deduped follow-up",
          role: "backend",
          ac: ["Works"],
          deps: [c1!.id, c1!.id, parentId],
        },
      ],
    });
    const followUp = noBlockSplit.data.children[0]!;
    assert.deepEqual(followUp.deps, [c1!.id, parentId]);
    assert.ok(!noBlockSplit.data.parent.deps?.includes(followUp.id));
  });
});
