import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

interface PanelResizerModule {
  getPanelSplitStorageKey(id: string): string;
  loadPersistedSplit(id: string, mode: "ratio" | "px", storage?: unknown): number | null;
  savePersistedSplit(id: string, mode: "ratio" | "px", value: number, storage?: unknown): void;
  clearPersistedSplit(id: string, storage?: unknown): void;
  pxToRatio(px: number, usableWidth: number): number;
  ratioToPx(ratio: number, usableWidth: number): number;
  computeTwoPaneBounds(input: {
    containerWidth: number;
    minLeft: number;
    maxLeft?: number;
    minRight: number;
    handleWidth?: number;
    relaxBelowWidth?: number;
  }): {
    min: number;
    max: number;
    effectiveMinRight: number;
    usableWidth: number;
    hasRoom: boolean;
  };
  clampTwoPanePx(desiredPx: number, bounds: { min: number; max: number }): number;
  clampStudioThreePane(input: {
    containerWidth: number;
    desiredLeftPx: number;
    desiredBehindPx: number;
    minLeft?: number;
    minStream?: number;
    minBehind?: number;
    maxBehindPx?: number;
    maxBehindRatio?: number;
    handleWidth?: number;
    priority?: "left" | "behind" | "balanced";
  }): {
    leftPx: number;
    behindPx: number;
    streamPx: number;
    minLeft: number;
    maxLeft: number;
    minBehind: number;
    maxBehind: number;
  };
  computeKeyboardStepPx(input: {
    key: string;
    shiftKey?: boolean;
    currentPx: number;
    minPx: number;
    maxPx: number;
    invertDelta?: boolean;
  }): { action: "step"; nextPx: number } | { action: "reset" } | null;
  computeSeparatorAria(input: {
    currentPx: number;
    minPx: number;
    maxPx: number;
    containerWidth: number;
    paneLabel?: string;
  }): {
    valuemin: number;
    valuemax: number;
    valuenow: number;
    valuetext: string;
  };
}

const REPO_ROOT = path.resolve(process.cwd());

function loadPanelResizer(): PanelResizerModule {
  const absPath = path.join(REPO_ROOT, "web/src/utils/panelResizer.ts");
  const source = fs.readFileSync(absPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const mod = { exports: {} as Partial<PanelResizerModule> };
  const fn = new Function("exports", "module", "require", outputText);
  fn(mod.exports, mod, () => {
    throw new Error("Unexpected import in panelResizer.ts");
  });
  return mod.exports as PanelResizerModule;
}

const resizer = loadPanelResizer();

describe("PanelResizer Pure Layout, Keyboard & Persistence Helpers", () => {
  it("computes two-pane bounds and relaxes gracefully below 680px for board-split", () => {
    const desktop = resizer.computeTwoPaneBounds({
      containerWidth: 1200,
      minLeft: 320,
      minRight: 260,
      relaxBelowWidth: 680,
    });
    assert.equal(desktop.min, 320);
    assert.equal(desktop.max, 1200 - 12 - 260);
    assert.equal(desktop.hasRoom, true);
    assert.equal(resizer.clampTwoPanePx(100, desktop), 320);
    assert.equal(resizer.clampTwoPanePx(1100, desktop), desktop.max);

    // At 640px and 560px container width, minLeft + effectiveMinRight + 12 <= containerWidth
    for (const width of [640, 600, 560]) {
      const narrow = resizer.computeTwoPaneBounds({
        containerWidth: width,
        minLeft: 320,
        minRight: 260,
        relaxBelowWidth: 680,
      });
      assert.ok(
        narrow.min + narrow.effectiveMinRight + 12 <= width,
        `Expected no overflow at ${width}px, got min=${narrow.min}, right=${narrow.effectiveMinRight}`
      );
      assert.ok(narrow.max >= narrow.min);
    }
  });

  it("enforces mockups-sidebar and reader-toc max/min bounds and hasRoom flag", () => {
    const mockupsOpen = resizer.computeTwoPaneBounds({
      containerWidth: 616,
      minLeft: 180,
      maxLeft: 460,
      minRight: 300,
    });
    assert.equal(mockupsOpen.hasRoom, true);
    assert.equal(mockupsOpen.min, 180);
    assert.equal(mockupsOpen.max, 616 - 12 - 300);

    const mockupsNoRoom = resizer.computeTwoPaneBounds({
      containerWidth: 460,
      minLeft: 180,
      maxLeft: 460,
      minRight: 300,
    });
    assert.equal(mockupsNoRoom.hasRoom, false);
    assert.ok(mockupsNoRoom.min + mockupsNoRoom.effectiveMinRight + 12 <= 460);

    const tocBounds = resizer.computeTwoPaneBounds({
      containerWidth: 960,
      minLeft: 180,
      maxLeft: 380,
      minRight: 340,
    });
    assert.equal(tocBounds.min, 180);
    assert.equal(tocBounds.max, 380);
  });

  it("converts ratio <-> px accurately within [0.05, 0.95]", () => {
    const usable = 1000;
    const ratio = resizer.pxToRatio(620, usable);
    assert.equal(ratio, 0.62);
    assert.equal(resizer.ratioToPx(ratio, usable), 620);

    assert.equal(resizer.pxToRatio(10, usable), 0.05);
    assert.equal(resizer.pxToRatio(990, usable), 0.95);
  });

  it("mutually clamps 3-pane LiveStudio so left + behind + 24 + minStream <= containerWidth ALWAYS holds", () => {
    // Opening behind drawer when left was wide on 1100px desktop
    const balanced = resizer.clampStudioThreePane({
      containerWidth: 1100,
      desiredLeftPx: 750,
      desiredBehindPx: 400,
      priority: "balanced",
    });
    assert.ok(balanced.leftPx >= 200);
    assert.ok(balanced.behindPx >= 260);
    assert.ok(balanced.streamPx >= 260);
    assert.ok(balanced.leftPx + balanced.behindPx + 24 + 260 <= 1100);

    // Dragging behind drawer wider yields topology down toward 200px while respecting 44% / 520px cap
    const behindDrag = resizer.clampStudioThreePane({
      containerWidth: 1050,
      desiredLeftPx: 500,
      desiredBehindPx: 500,
      priority: "behind",
    });
    assert.ok(behindDrag.behindPx <= Math.floor(1050 * 0.44));
    assert.ok(behindDrag.leftPx >= 200);
    assert.ok(behindDrag.leftPx + behindDrag.behindPx + 24 + 260 <= 1050);

    // Dragging main handle keeps behind drawer fixed and clamps left
    const leftDrag = resizer.clampStudioThreePane({
      containerWidth: 1200,
      desiredLeftPx: 900,
      desiredBehindPx: 380,
      priority: "left",
    });
    assert.equal(leftDrag.behindPx, 380);
    assert.equal(leftDrag.leftPx, 1200 - 24 - 380 - 260);
    assert.ok(leftDrag.leftPx + leftDrag.behindPx + 24 + 260 <= 1200);
  });

  it("computes keyboard steps including right-anchored delta inversion for studio-behind", () => {
    // Left-anchored handle
    assert.deepEqual(
      resizer.computeKeyboardStepPx({
        key: "ArrowRight",
        currentPx: 300,
        minPx: 200,
        maxPx: 600,
      }),
      { action: "step", nextPx: 324 }
    );
    assert.deepEqual(
      resizer.computeKeyboardStepPx({
        key: "ArrowLeft",
        shiftKey: true,
        currentPx: 300,
        minPx: 200,
        maxPx: 600,
      }),
      { action: "step", nextPx: 228 }
    );

    // Right-anchored studio-behind handle: moving handle LEFT increases drawer width
    assert.deepEqual(
      resizer.computeKeyboardStepPx({
        key: "ArrowLeft",
        currentPx: 320,
        minPx: 260,
        maxPx: 480,
        invertDelta: true,
      }),
      { action: "step", nextPx: 344 }
    );
    assert.deepEqual(
      resizer.computeKeyboardStepPx({
        key: "ArrowRight",
        shiftKey: true,
        currentPx: 320,
        minPx: 260,
        maxPx: 480,
        invertDelta: true,
      }),
      { action: "step", nextPx: 260 }
    );

    assert.deepEqual(
      resizer.computeKeyboardStepPx({
        key: "Home",
        currentPx: 320,
        minPx: 260,
        maxPx: 480,
        invertDelta: true,
      }),
      { action: "step", nextPx: 260 }
    );
    assert.deepEqual(
      resizer.computeKeyboardStepPx({
        key: "End",
        currentPx: 320,
        minPx: 260,
        maxPx: 480,
        invertDelta: true,
      }),
      { action: "step", nextPx: 480 }
    );
    assert.deepEqual(
      resizer.computeKeyboardStepPx({
        key: "Enter",
        currentPx: 320,
        minPx: 260,
        maxPx: 480,
      }),
      { action: "reset" }
    );
    assert.equal(
      resizer.computeKeyboardStepPx({
        key: "Tab",
        currentPx: 320,
        minPx: 260,
        maxPx: 480,
      }),
      null
    );
  });

  it("computes bounded integer ARIA percentages and valuetext", () => {
    const aria = resizer.computeSeparatorAria({
      currentPx: 360,
      minPx: 240,
      maxPx: 900,
      containerWidth: 1200,
      paneLabel: "Topology panel",
    });
    assert.equal(aria.valuemin, 20);
    assert.equal(aria.valuemax, 75);
    assert.equal(aria.valuenow, 30);
    assert.equal(aria.valuetext, "Topology panel: 360px (30%)");
  });

  it("persists to storage with exact key format and falls back to memory when storage throws", () => {
    assert.equal(
      resizer.getPanelSplitStorageKey("board-split"),
      "agentStudio.panelSplit.board-split.v1"
    );

    const backing = new Map<string, string>();
    const normalStorage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        backing.set(k, v);
      },
      removeItem: (k: string) => {
        backing.delete(k);
      },
    };

    resizer.savePersistedSplit("board-split", "ratio", 0.615, normalStorage);
    assert.equal(resizer.loadPersistedSplit("board-split", "ratio", normalStorage), 0.615);
    resizer.clearPersistedSplit("board-split", normalStorage);
    assert.equal(resizer.loadPersistedSplit("board-split", "ratio", normalStorage), null);

    // Invalid persisted ratio >= 1 or <= 0 is ignored
    backing.set("agentStudio.panelSplit.studio-main.v1", "1.4");
    assert.equal(resizer.loadPersistedSplit("studio-main", "ratio", normalStorage), null);

    // Sandboxed iframe storage that throws SecurityError falls back cleanly to in-memory store
    const throwingStorage = {
      getItem: () => {
        throw new Error("SecurityError: localStorage blocked");
      },
      setItem: () => {
        throw new Error("SecurityError: localStorage blocked");
      },
      removeItem: () => {
        throw new Error("SecurityError: localStorage blocked");
      },
    };

    resizer.savePersistedSplit("mockups-sidebar", "px", 342, throwingStorage);
    assert.equal(resizer.loadPersistedSplit("mockups-sidebar", "px", throwingStorage), 342);
    resizer.clearPersistedSplit("mockups-sidebar", throwingStorage);
    assert.equal(resizer.loadPersistedSplit("mockups-sidebar", "px", throwingStorage), null);
  });
});
