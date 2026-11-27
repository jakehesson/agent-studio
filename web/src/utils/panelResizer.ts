/**
 * Resizable split-panel controller and pure layout/clamping helpers.
 * Supports 2-pane splits (Board, Mockups, Reader TOC, Studio) and
 * coordinated 3-pane mutual clamping (Live Studio with Behind drawer).
 */

export type PanelSplitId =
  | "studio-main"
  | "studio-behind"
  | "board-split"
  | "mockups-sidebar"
  | "reader-toc";

export type PanelPersistMode = "ratio" | "px";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TwoPaneBoundsInput {
  containerWidth: number;
  minLeft: number;
  maxLeft?: number;
  minRight: number;
  handleWidth?: number;
  relaxBelowWidth?: number;
}

export interface TwoPaneBounds {
  min: number;
  max: number;
  effectiveMinRight: number;
  usableWidth: number;
  hasRoom: boolean;
}

export interface StudioThreePaneInput {
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
}

export interface StudioThreePaneResult {
  leftPx: number;
  behindPx: number;
  streamPx: number;
  minLeft: number;
  maxLeft: number;
  minBehind: number;
  maxBehind: number;
}

export interface KeyboardStepInput {
  key: string;
  shiftKey?: boolean;
  currentPx: number;
  minPx: number;
  maxPx: number;
  invertDelta?: boolean;
  stepPx?: number;
  shiftStepPx?: number;
}

export type KeyboardStepResult =
  | { action: "step"; nextPx: number }
  | { action: "reset" }
  | null;

export interface SeparatorAriaInput {
  currentPx: number;
  minPx: number;
  maxPx: number;
  containerWidth: number;
  paneLabel?: string;
}

export interface SeparatorAriaState {
  valuemin: number;
  valuemax: number;
  valuenow: number;
  valuetext: string;
}

export interface PanelResizerHandle {
  sync(): void;
  destroy(): void;
}

export interface TwoPaneResizerOptions {
  id: PanelSplitId;
  container: HTMLElement;
  handle: HTMLElement;
  primaryPane: HTMLElement;
  cssVar: string;
  persistMode: PanelPersistMode;
  minLeft: number;
  maxLeft?: number;
  minRight: number;
  handleWidth?: number;
  relaxBelowWidth?: number;
  hideWhenNoRoom?: boolean;
  invertDelta?: boolean;
  ariaLabel: string;
  paneLabel?: string;
  storage?: StorageLike;
}

export interface StudioWorkspaceResizerOptions {
  workspace: HTMLElement;
  mainHandle: HTMLElement;
  behindHandle: HTMLElement;
  topologyPane: HTMLElement;
  streamPane: HTMLElement;
  behindPane: HTMLElement;
  handleWidth?: number;
  storage?: StorageLike;
}

const DEFAULT_HANDLE_WIDTH = 12;
const KEY_STEP_PX = 24;
const KEY_SHIFT_STEP_PX = 72;

// In-memory fallback for sandboxed iframes/webviews where localStorage throws.
const memorySplitStore = new Map<string, string>();

export function getPanelSplitStorageKey(id: PanelSplitId): string {
  return `agentStudio.panelSplit.${id}.v1`;
}

function resolveDefaultStorage(): StorageLike | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Sandboxed iframe/webview
  }
  return null;
}

export function safeStorageGet(key: string, storage?: StorageLike | null): string | null {
  const target = storage === undefined ? resolveDefaultStorage() : storage;
  if (target) {
    try {
      return target.getItem(key);
    } catch {
      // Fall back to in-memory store
    }
  }
  return memorySplitStore.get(key) ?? null;
}

export function safeStorageSet(
  key: string,
  value: string,
  storage?: StorageLike | null
): void {
  const target = storage === undefined ? resolveDefaultStorage() : storage;
  if (target) {
    try {
      target.setItem(key, value);
      return;
    } catch {
      // Fall back to in-memory store
    }
  }
  memorySplitStore.set(key, value);
}

export function safeStorageDelete(key: string, storage?: StorageLike | null): void {
  memorySplitStore.delete(key);
  const target = storage === undefined ? resolveDefaultStorage() : storage;
  if (target) {
    try {
      target.removeItem(key);
    } catch {
      // Ignore storage errors
    }
  }
}

export function loadPersistedSplit(
  id: PanelSplitId,
  mode: PanelPersistMode,
  storage?: StorageLike | null
): number | null {
  const raw = safeStorageGet(getPanelSplitStorageKey(id), storage);
  if (raw === null || raw.trim() === "") return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (mode === "ratio" && num >= 1) return null;
  return num;
}

export function savePersistedSplit(
  id: PanelSplitId,
  mode: PanelPersistMode,
  value: number,
  storage?: StorageLike | null
): void {
  if (!Number.isFinite(value) || value <= 0) return;
  const serialized =
    mode === "ratio"
      ? clampNumber(value, 0.05, 0.95).toFixed(4)
      : String(Math.round(value));
  safeStorageSet(getPanelSplitStorageKey(id), serialized, storage);
}

export function clearPersistedSplit(
  id: PanelSplitId,
  storage?: StorageLike | null
): void {
  safeStorageDelete(getPanelSplitStorageKey(id), storage);
}

export function clampNumber(val: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, val));
}

export function pxToRatio(px: number, usableWidth: number): number {
  if (!Number.isFinite(usableWidth) || usableWidth <= 0) return 0.5;
  return clampNumber(px / usableWidth, 0.05, 0.95);
}

export function ratioToPx(ratio: number, usableWidth: number): number {
  if (!Number.isFinite(usableWidth) || usableWidth <= 0) return 0;
  return Math.round(clampNumber(ratio, 0.05, 0.95) * usableWidth);
}

export function computeTwoPaneBounds(input: TwoPaneBoundsInput): TwoPaneBounds {
  const handleWidth = input.handleWidth ?? DEFAULT_HANDLE_WIDTH;
  const usableWidth = Math.max(0, Math.floor(input.containerWidth - handleWidth));
  let effMinLeft = Math.max(0, Math.floor(input.minLeft));
  let effMinRight = Math.max(0, Math.floor(input.minRight));

  const strictFits = effMinLeft + effMinRight <= usableWidth;

  if (input.relaxBelowWidth && input.containerWidth < input.relaxBelowWidth) {
    // Relax gracefully on narrower unfolded screens so left + right + handle <= containerWidth.
    effMinLeft = Math.min(effMinLeft, Math.floor(usableWidth * 0.52));
    effMinRight = Math.min(effMinRight, Math.floor(usableWidth * 0.42));
  }

  if (effMinLeft + effMinRight > usableWidth && effMinLeft + effMinRight > 0) {
    const total = effMinLeft + effMinRight;
    effMinLeft = Math.floor((effMinLeft / total) * usableWidth);
    effMinRight = Math.max(0, usableWidth - effMinLeft);
  }

  const rawMax =
    input.maxLeft !== undefined
      ? Math.min(input.maxLeft, usableWidth - effMinRight)
      : usableWidth - effMinRight;
  const max = Math.max(effMinLeft, Math.floor(rawMax));
  const min = Math.min(effMinLeft, max);
  const hasRoom = input.containerWidth > 0 && strictFits;

  return {
    min,
    max,
    effectiveMinRight: effMinRight,
    usableWidth,
    hasRoom,
  };
}

export function clampTwoPanePx(desiredPx: number, bounds: TwoPaneBounds): number {
  return clampNumber(Math.round(desiredPx), bounds.min, bounds.max);
}

export function clampStudioThreePane(input: StudioThreePaneInput): StudioThreePaneResult {
  const handleWidth = input.handleWidth ?? DEFAULT_HANDLE_WIDTH;
  const usable = Math.max(0, Math.floor(input.containerWidth - handleWidth * 2));

  let minLeft = Math.max(0, Math.floor(input.minLeft ?? 200));
  let minStream = Math.max(0, Math.floor(input.minStream ?? 260));
  let minBehind = Math.max(0, Math.floor(input.minBehind ?? 260));

  const minSum = minLeft + minStream + minBehind;
  if (minSum > usable && minSum > 0) {
    const scale = usable / minSum;
    minLeft = Math.floor(minLeft * scale);
    minStream = Math.floor(minStream * scale);
    minBehind = Math.max(0, usable - minLeft - minStream);
  }

  const maxBehindPx = input.maxBehindPx ?? 520;
  const maxBehindRatio = input.maxBehindRatio ?? 0.44;
  const behindCap = Math.min(maxBehindPx, Math.floor(input.containerWidth * maxBehindRatio));
  const maxBehind = Math.max(minBehind, Math.min(behindCap, usable - minLeft - minStream));

  let behindPx = clampNumber(Math.round(input.desiredBehindPx), minBehind, maxBehind);
  let leftPx = Math.round(input.desiredLeftPx);

  if (input.priority === "left") {
    const maxLeftForBehind = Math.max(minLeft, usable - behindPx - minStream);
    leftPx = clampNumber(leftPx, minLeft, maxLeftForBehind);
  } else {
    // "behind" or "balanced": yield topology down toward minLeft so behind drawer fits while protecting minStream.
    const maxLeftForBehind = Math.max(minLeft, usable - behindPx - minStream);
    leftPx = clampNumber(leftPx, minLeft, maxLeftForBehind);
    const maxBehindForLeft = Math.max(minBehind, Math.min(maxBehind, usable - leftPx - minStream));
    behindPx = clampNumber(behindPx, minBehind, maxBehindForLeft);
  }

  const maxLeft = Math.max(minLeft, usable - behindPx - minStream);
  const streamPx = Math.max(0, usable - leftPx - behindPx);

  return {
    leftPx,
    behindPx,
    streamPx,
    minLeft,
    maxLeft,
    minBehind,
    maxBehind,
  };
}

export function computeKeyboardStepPx(input: KeyboardStepInput): KeyboardStepResult {
  if (input.key === "Enter") {
    return { action: "reset" };
  }
  if (input.key === "Home") {
    return { action: "step", nextPx: input.minPx };
  }
  if (input.key === "End") {
    return { action: "step", nextPx: input.maxPx };
  }
  if (input.key === "ArrowLeft" || input.key === "ArrowRight") {
    const step = input.shiftKey
      ? (input.shiftStepPx ?? KEY_SHIFT_STEP_PX)
      : (input.stepPx ?? KEY_STEP_PX);
    const visualDir = input.key === "ArrowLeft" ? -1 : 1;
    const delta = (input.invertDelta ? -visualDir : visualDir) * step;
    return {
      action: "step",
      nextPx: clampNumber(Math.round(input.currentPx + delta), input.minPx, input.maxPx),
    };
  }
  return null;
}

export function computeSeparatorAria(input: SeparatorAriaInput): SeparatorAriaState {
  if (!Number.isFinite(input.containerWidth) || input.containerWidth <= 0) {
    return {
      valuemin: 0,
      valuemax: 100,
      valuenow: 50,
      valuetext: input.paneLabel ? `${input.paneLabel}: 0px (50%)` : "0px (50%)",
    };
  }
  const valuemin = clampNumber(Math.round((input.minPx / input.containerWidth) * 100), 0, 100);
  const valuemax = clampNumber(
    Math.round((input.maxPx / input.containerWidth) * 100),
    valuemin,
    100
  );
  const valuenow = clampNumber(
    Math.round((input.currentPx / input.containerWidth) * 100),
    valuemin,
    valuemax
  );
  const pxRounded = Math.round(input.currentPx);
  const valuetext = input.paneLabel
    ? `${input.paneLabel}: ${pxRounded}px (${valuenow}%)`
    : `${pxRounded}px (${valuenow}%)`;
  return { valuemin, valuemax, valuenow, valuetext };
}

function ensureHandleDom(handle: HTMLElement, ariaLabel: string): void {
  handle.setAttribute("role", "separator");
  if (!handle.hasAttribute("tabindex")) {
    handle.setAttribute("tabindex", "0");
  }
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", ariaLabel);
  if (!handle.querySelector(".panel-resizer-pill")) {
    const pill = document.createElement("span");
    pill.className = "panel-resizer-pill";
    pill.setAttribute("aria-hidden", "true");
    handle.appendChild(pill);
  }
}

function applyAriaToHandle(handle: HTMLElement, aria: SeparatorAriaState): void {
  handle.setAttribute("aria-valuemin", String(aria.valuemin));
  handle.setAttribute("aria-valuemax", String(aria.valuemax));
  handle.setAttribute("aria-valuenow", String(aria.valuenow));
  handle.setAttribute("aria-valuetext", aria.valuetext);
}

function isDualSegmentActive(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(horizontal-viewport-segments: 2)").matches
    );
  } catch {
    return false;
  }
}

function isHandleHiddenByCss(handle: HTMLElement): boolean {
  if (handle.hidden) return true;
  if (isDualSegmentActive()) return true;
  try {
    return window.getComputedStyle(handle).display === "none";
  } catch {
    return false;
  }
}

export function attachPanelResizer(options: TwoPaneResizerOptions): PanelResizerHandle {
  const {
    id,
    container,
    handle,
    primaryPane,
    cssVar,
    persistMode,
    minLeft,
    maxLeft,
    minRight,
    handleWidth = DEFAULT_HANDLE_WIDTH,
    relaxBelowWidth,
    hideWhenNoRoom = false,
    invertDelta = false,
    ariaLabel,
    paneLabel,
    storage,
  } = options;

  ensureHandleDom(handle, ariaLabel);

  let destroyed = false;
  let dragging = false;
  let activePointerId: number | null = null;
  let startX = 0;
  let startSizePx = 0;
  let latestClientX = 0;
  let latestAppliedPx: number | null = null;
  let rafId: number | null = null;

  const getBoundsForWidth = (containerWidth: number): TwoPaneBounds =>
    computeTwoPaneBounds({
      containerWidth,
      minLeft,
      maxLeft,
      minRight,
      handleWidth,
      relaxBelowWidth,
    });

  const measureCurrentPx = (bounds: TwoPaneBounds): number => {
    const rectWidth = primaryPane.getBoundingClientRect().width;
    if (rectWidth > 0) {
      return clampTwoPanePx(rectWidth, bounds);
    }
    return Math.round((bounds.min + bounds.max) / 2);
  };

  const applyPxAndAria = (
    px: number | null,
    containerWidth: number,
    bounds: TwoPaneBounds
  ): void => {
    if (px === null) {
      container.style.removeProperty(cssVar);
    } else {
      container.style.setProperty(cssVar, `${px}px`);
    }
    const currentPx = px ?? measureCurrentPx(bounds);
    applyAriaToHandle(
      handle,
      computeSeparatorAria({
        currentPx,
        minPx: bounds.min,
        maxPx: bounds.max,
        containerWidth,
        paneLabel,
      })
    );
  };

  const sync = (): void => {
    if (destroyed) return;
    const containerWidth = container.getBoundingClientRect().width;
    if (containerWidth <= 0) return;

    if (isHandleHiddenByCss(handle)) {
      container.style.removeProperty(cssVar);
      return;
    }

    const bounds = getBoundsForWidth(containerWidth);
    if (hideWhenNoRoom) {
      const noRoom = !bounds.hasRoom;
      handle.classList.toggle("is-no-room", noRoom);
      if (noRoom) {
        container.style.removeProperty(cssVar);
        return;
      }
    }

    const persisted = loadPersistedSplit(id, persistMode, storage);
    if (persisted === null) {
      applyPxAndAria(null, containerWidth, bounds);
      return;
    }

    const desiredPx =
      persistMode === "ratio" ? ratioToPx(persisted, bounds.usableWidth) : persisted;
    const clampedPx = clampTwoPanePx(desiredPx, bounds);
    applyPxAndAria(clampedPx, containerWidth, bounds);
  };

  const commitPersistedPx = (px: number, bounds: TwoPaneBounds): void => {
    if (persistMode === "ratio") {
      savePersistedSplit(id, "ratio", pxToRatio(px, bounds.usableWidth), storage);
    } else {
      savePersistedSplit(id, "px", px, storage);
    }
  };

  const applyDragFrame = (): void => {
    rafId = null;
    if (!dragging || destroyed) return;
    const containerWidth = container.getBoundingClientRect().width;
    if (containerWidth <= 0) return;
    const bounds = getBoundsForWidth(containerWidth);
    const deltaX = latestClientX - startX;
    const desired = invertDelta ? startSizePx - deltaX : startSizePx + deltaX;
    const nextPx = clampTwoPanePx(desired, bounds);
    latestAppliedPx = nextPx;
    applyPxAndAria(nextPx, containerWidth, bounds);
  };

  const cleanupDragDom = (): void => {
    delete handle.dataset.dragging;
    if (document.body.dataset.resizing === "panels") {
      delete document.body.dataset.resizing;
    }
  };

  const finishDrag = (persist: boolean): void => {
    if (!dragging) return;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
      if (persist && !destroyed) {
        applyDragFrame();
      }
    }
    const pointerId = activePointerId;
    dragging = false;
    activePointerId = null;
    cleanupDragDom();

    if (pointerId !== null) {
      try {
        if (handle.hasPointerCapture?.(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore release errors
      }
    }

    if (persist && latestAppliedPx !== null && !destroyed) {
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth > 0) {
        const bounds = getBoundsForWidth(containerWidth);
        commitPersistedPx(latestAppliedPx, bounds);
      }
    }
    latestAppliedPx = null;
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (destroyed || e.button !== 0 || isHandleHiddenByCss(handle)) return;
    const containerWidth = container.getBoundingClientRect().width;
    if (containerWidth <= 0) return;
    const bounds = getBoundsForWidth(containerWidth);
    if (hideWhenNoRoom && !bounds.hasRoom) return;

    e.preventDefault();
    handle.focus({ preventScroll: true });

    dragging = true;
    activePointerId = e.pointerId;
    startX = e.clientX;
    latestClientX = e.clientX;
    startSizePx = measureCurrentPx(bounds);
    latestAppliedPx = startSizePx;

    document.body.dataset.resizing = "panels";
    handle.dataset.dragging = "true";

    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // Fallback window listeners remain active
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging || destroyed || e.pointerId !== activePointerId) return;
    latestClientX = e.clientX;
    if (rafId === null) {
      rafId = requestAnimationFrame(applyDragFrame);
    }
  };

  const onPointerUpOrCancel = (e: PointerEvent): void => {
    if (!dragging || e.pointerId !== activePointerId) return;
    finishDrag(true);
  };

  const onWindowBlur = (): void => {
    if (dragging) finishDrag(true);
  };

  const resetToDefault = (): void => {
    clearPersistedSplit(id, storage);
    container.style.removeProperty(cssVar);
    const containerWidth = container.getBoundingClientRect().width;
    if (containerWidth > 0 && !isHandleHiddenByCss(handle)) {
      const bounds = getBoundsForWidth(containerWidth);
      applyPxAndAria(null, containerWidth, bounds);
    }
  };

  const onDblClick = (): void => {
    if (destroyed || isHandleHiddenByCss(handle)) return;
    resetToDefault();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (destroyed || isHandleHiddenByCss(handle)) return;
    const containerWidth = container.getBoundingClientRect().width;
    if (containerWidth <= 0) return;
    const bounds = getBoundsForWidth(containerWidth);
    if (hideWhenNoRoom && !bounds.hasRoom) return;

    const currentPx = measureCurrentPx(bounds);
    const step = computeKeyboardStepPx({
      key: e.key,
      shiftKey: e.shiftKey,
      currentPx,
      minPx: bounds.min,
      maxPx: bounds.max,
      invertDelta,
    });
    if (!step) return;

    e.preventDefault();
    if (step.action === "reset") {
      resetToDefault();
      return;
    }
    applyPxAndAria(step.nextPx, containerWidth, bounds);
    commitPersistedPx(step.nextPx, bounds);
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUpOrCancel);
  handle.addEventListener("pointercancel", onPointerUpOrCancel);
  handle.addEventListener("dblclick", onDblClick);
  handle.addEventListener("keydown", onKeyDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUpOrCancel);
  window.addEventListener("pointercancel", onPointerUpOrCancel);
  window.addEventListener("blur", onWindowBlur);

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => {
      if (!dragging) sync();
    });
    ro.observe(container);
  }

  sync();

  return {
    sync,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      finishDrag(false);
      cleanupDragDom();
      ro?.disconnect();
      ro = null;
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUpOrCancel);
      handle.removeEventListener("pointercancel", onPointerUpOrCancel);
      handle.removeEventListener("dblclick", onDblClick);
      handle.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUpOrCancel);
      window.removeEventListener("pointercancel", onPointerUpOrCancel);
      window.removeEventListener("blur", onWindowBlur);
    },
  };
}

export function attachStudioWorkspaceResizers(
  options: StudioWorkspaceResizerOptions
): PanelResizerHandle {
  const {
    workspace,
    mainHandle,
    behindHandle,
    topologyPane,
    behindPane,
    handleWidth = DEFAULT_HANDLE_WIDTH,
    storage,
  } = options;

  ensureHandleDom(mainHandle, "Resize topology and activity stream panels");
  ensureHandleDom(behindHandle, "Resize activity stream and response inspector drawer");

  let destroyed = false;
  let activeKind: "main" | "behind" | null = null;
  let activePointerId: number | null = null;
  let startX = 0;
  let startMainPx = 0;
  let startBehindPx = 0;
  let latestClientX = 0;
  let lastAppliedMainPx: number | null = null;
  let lastAppliedBehindPx: number | null = null;
  let rafId: number | null = null;

  const isThreePaneActive = (): boolean => {
    if (!workspace.classList.contains("has-behind-drawer")) return false;
    behindHandle.hidden = false;
    return !isHandleHiddenByCss(behindHandle);
  };

  const measureTopologyPx = (fallback: number): number => {
    const w = topologyPane.getBoundingClientRect().width;
    return w > 0 ? Math.round(w) : fallback;
  };

  const measureBehindPx = (containerWidth: number): number => {
    const w = behindPane.getBoundingClientRect().width;
    if (w > 0) return Math.round(w);
    return Math.min(420, Math.round(containerWidth * 0.36));
  };

  const sync = (): void => {
    if (destroyed) return;
    const hasDrawer = workspace.classList.contains("has-behind-drawer");
    behindHandle.hidden = !hasDrawer;

    const containerWidth = workspace.getBoundingClientRect().width;
    if (containerWidth <= 0) return;

    if (isHandleHiddenByCss(mainHandle)) {
      workspace.style.removeProperty("--studio-left");
      workspace.style.removeProperty("--studio-behind");
      return;
    }

    const threePane = isThreePaneActive();
    const persistedLeftRatio = loadPersistedSplit("studio-main", "ratio", storage);
    const persistedBehindPx = loadPersistedSplit("studio-behind", "px", storage);

    if (!threePane) {
      workspace.style.removeProperty("--studio-behind");
      const bounds = computeTwoPaneBounds({
        containerWidth,
        minLeft: 240,
        minRight: 280,
        handleWidth,
        relaxBelowWidth: 680,
      });

      let appliedLeft: number | null = null;
      if (persistedLeftRatio !== null) {
        appliedLeft = clampTwoPanePx(ratioToPx(persistedLeftRatio, bounds.usableWidth), bounds);
        workspace.style.setProperty("--studio-left", `${appliedLeft}px`);
      } else {
        workspace.style.removeProperty("--studio-left");
      }

      const currentLeft = appliedLeft ?? measureTopologyPx(Math.round(bounds.usableWidth * 0.59));
      applyAriaToHandle(
        mainHandle,
        computeSeparatorAria({
          currentPx: currentLeft,
          minPx: bounds.min,
          maxPx: bounds.max,
          containerWidth,
          paneLabel: "Topology panel",
        })
      );
      return;
    }

    // Desktop 3-pane mode: mutually clamp left + behind + 24 + 260 <= containerWidth.
    const defaultBehind = Math.min(420, Math.round(containerWidth * 0.36));
    const desiredBehind = persistedBehindPx ?? measureBehindPx(containerWidth);
    const usable2Col = Math.max(0, containerWidth - handleWidth);
    const defaultLeft = Math.round((containerWidth - handleWidth * 2 - desiredBehind) / 2.15);
    const desiredLeft =
      persistedLeftRatio !== null
        ? ratioToPx(persistedLeftRatio, usable2Col)
        : measureTopologyPx(defaultLeft);

    const solved = clampStudioThreePane({
      containerWidth,
      desiredLeftPx: desiredLeft,
      desiredBehindPx: desiredBehind,
      handleWidth,
      priority: "balanced",
    });

    const leftWasClamped = solved.leftPx < desiredLeft;
    if (persistedLeftRatio !== null || leftWasClamped) {
      workspace.style.setProperty("--studio-left", `${solved.leftPx}px`);
    } else {
      workspace.style.removeProperty("--studio-left");
    }

    const behindWasClamped = solved.behindPx < (persistedBehindPx ?? defaultBehind);
    if (persistedBehindPx !== null || behindWasClamped) {
      workspace.style.setProperty("--studio-behind", `${solved.behindPx}px`);
    } else {
      workspace.style.removeProperty("--studio-behind");
    }

    applyAriaToHandle(
      mainHandle,
      computeSeparatorAria({
        currentPx: solved.leftPx,
        minPx: solved.minLeft,
        maxPx: solved.maxLeft,
        containerWidth,
        paneLabel: "Topology panel",
      })
    );
    applyAriaToHandle(
      behindHandle,
      computeSeparatorAria({
        currentPx: solved.behindPx,
        minPx: solved.minBehind,
        maxPx: solved.maxBehind,
        containerWidth,
        paneLabel: "Inspector drawer",
      })
    );
  };

  const applyDragFrame = (): void => {
    rafId = null;
    if (!activeKind || destroyed) return;
    const containerWidth = workspace.getBoundingClientRect().width;
    if (containerWidth <= 0) return;

    const deltaX = latestClientX - startX;
    if (activeKind === "main") {
      if (!isThreePaneActive()) {
        const bounds = computeTwoPaneBounds({
          containerWidth,
          minLeft: 240,
          minRight: 280,
          handleWidth,
          relaxBelowWidth: 680,
        });
        const nextLeft = clampTwoPanePx(startMainPx + deltaX, bounds);
        lastAppliedMainPx = nextLeft;
        workspace.style.setProperty("--studio-left", `${nextLeft}px`);
        applyAriaToHandle(
          mainHandle,
          computeSeparatorAria({
            currentPx: nextLeft,
            minPx: bounds.min,
            maxPx: bounds.max,
            containerWidth,
            paneLabel: "Topology panel",
          })
        );
      } else {
        const solved = clampStudioThreePane({
          containerWidth,
          desiredLeftPx: startMainPx + deltaX,
          desiredBehindPx: startBehindPx,
          handleWidth,
          priority: "left",
        });
        lastAppliedMainPx = solved.leftPx;
        workspace.style.setProperty("--studio-left", `${solved.leftPx}px`);
        applyAriaToHandle(
          mainHandle,
          computeSeparatorAria({
            currentPx: solved.leftPx,
            minPx: solved.minLeft,
            maxPx: solved.maxLeft,
            containerWidth,
            paneLabel: "Topology panel",
          })
        );
      }
      return;
    }

    // activeKind === "behind" (right-anchored: dragging left increases drawer width)
    const persistedLeftRatio = loadPersistedSplit("studio-main", "ratio", storage);
    const usable2Col = Math.max(0, containerWidth - handleWidth);
    const preferredLeft =
      persistedLeftRatio !== null
        ? ratioToPx(persistedLeftRatio, usable2Col)
        : startMainPx;
    const solved = clampStudioThreePane({
      containerWidth,
      desiredLeftPx: preferredLeft,
      desiredBehindPx: startBehindPx - deltaX,
      handleWidth,
      priority: "behind",
    });
    lastAppliedBehindPx = solved.behindPx;
    workspace.style.setProperty("--studio-behind", `${solved.behindPx}px`);
    if (persistedLeftRatio !== null || solved.leftPx < startMainPx) {
      workspace.style.setProperty("--studio-left", `${solved.leftPx}px`);
    }
    applyAriaToHandle(
      mainHandle,
      computeSeparatorAria({
        currentPx: solved.leftPx,
        minPx: solved.minLeft,
        maxPx: solved.maxLeft,
        containerWidth,
        paneLabel: "Topology panel",
      })
    );
    applyAriaToHandle(
      behindHandle,
      computeSeparatorAria({
        currentPx: solved.behindPx,
        minPx: solved.minBehind,
        maxPx: solved.maxBehind,
        containerWidth,
        paneLabel: "Inspector drawer",
      })
    );
  };

  const cleanupDragDom = (): void => {
    delete mainHandle.dataset.dragging;
    delete behindHandle.dataset.dragging;
    if (document.body.dataset.resizing === "panels") {
      delete document.body.dataset.resizing;
    }
  };

  const finishDrag = (persist: boolean): void => {
    if (!activeKind) return;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
      if (persist && !destroyed) {
        applyDragFrame();
      }
    }
    const kind = activeKind;
    const pointerId = activePointerId;
    const handle = kind === "main" ? mainHandle : behindHandle;
    activeKind = null;
    activePointerId = null;
    cleanupDragDom();

    if (pointerId !== null) {
      try {
        if (handle.hasPointerCapture?.(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore
      }
    }

    if (persist && !destroyed) {
      const containerWidth = workspace.getBoundingClientRect().width;
      if (kind === "main" && lastAppliedMainPx !== null && containerWidth > 0) {
        savePersistedSplit(
          "studio-main",
          "ratio",
          pxToRatio(lastAppliedMainPx, Math.max(1, containerWidth - handleWidth)),
          storage
        );
      } else if (kind === "behind" && lastAppliedBehindPx !== null) {
        savePersistedSplit("studio-behind", "px", lastAppliedBehindPx, storage);
      }
    }
    lastAppliedMainPx = null;
    lastAppliedBehindPx = null;
  };

  const startDrag = (kind: "main" | "behind", e: PointerEvent): void => {
    const handle = kind === "main" ? mainHandle : behindHandle;
    if (destroyed || e.button !== 0 || isHandleHiddenByCss(handle)) return;
    if (kind === "behind" && !isThreePaneActive()) return;
    const containerWidth = workspace.getBoundingClientRect().width;
    if (containerWidth <= 0) return;

    e.preventDefault();
    handle.focus({ preventScroll: true });

    activeKind = kind;
    activePointerId = e.pointerId;
    startX = e.clientX;
    latestClientX = e.clientX;
    startMainPx = measureTopologyPx(Math.round(containerWidth * 0.5));
    startBehindPx = isThreePaneActive() ? measureBehindPx(containerWidth) : 0;
    lastAppliedMainPx = startMainPx;
    lastAppliedBehindPx = startBehindPx;

    document.body.dataset.resizing = "panels";
    handle.dataset.dragging = "true";

    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // Window listeners cover fallback
    }
  };

  const onMainPointerDown = (e: PointerEvent): void => startDrag("main", e);
  const onBehindPointerDown = (e: PointerEvent): void => startDrag("behind", e);

  const onPointerMove = (e: PointerEvent): void => {
    if (!activeKind || destroyed || e.pointerId !== activePointerId) return;
    latestClientX = e.clientX;
    if (rafId === null) {
      rafId = requestAnimationFrame(applyDragFrame);
    }
  };

  const onPointerUpOrCancel = (e: PointerEvent): void => {
    if (!activeKind || e.pointerId !== activePointerId) return;
    finishDrag(true);
  };

  const onWindowBlur = (): void => {
    if (activeKind) finishDrag(true);
  };

  const resetKind = (kind: "main" | "behind"): void => {
    if (kind === "main") {
      clearPersistedSplit("studio-main", storage);
      workspace.style.removeProperty("--studio-left");
    } else {
      clearPersistedSplit("studio-behind", storage);
      workspace.style.removeProperty("--studio-behind");
    }
    sync();
  };

  const onMainDblClick = (): void => {
    if (!destroyed && !isHandleHiddenByCss(mainHandle)) resetKind("main");
  };

  const onBehindDblClick = (): void => {
    if (!destroyed && isThreePaneActive()) resetKind("behind");
  };

  const onMainKeyDown = (e: KeyboardEvent): void => {
    if (destroyed || isHandleHiddenByCss(mainHandle)) return;
    const containerWidth = workspace.getBoundingClientRect().width;
    if (containerWidth <= 0) return;

    if (!isThreePaneActive()) {
      const bounds = computeTwoPaneBounds({
        containerWidth,
        minLeft: 240,
        minRight: 280,
        handleWidth,
        relaxBelowWidth: 680,
      });
      const currentPx = measureTopologyPx(Math.round(bounds.usableWidth * 0.59));
      const step = computeKeyboardStepPx({
        key: e.key,
        shiftKey: e.shiftKey,
        currentPx,
        minPx: bounds.min,
        maxPx: bounds.max,
      });
      if (!step) return;
      e.preventDefault();
      if (step.action === "reset") {
        resetKind("main");
        return;
      }
      savePersistedSplit("studio-main", "ratio", pxToRatio(step.nextPx, bounds.usableWidth), storage);
      sync();
      return;
    }

    const curBehind = measureBehindPx(containerWidth);
    const curLeft = measureTopologyPx(Math.round(containerWidth * 0.35));
    const solvedBounds = clampStudioThreePane({
      containerWidth,
      desiredLeftPx: curLeft,
      desiredBehindPx: curBehind,
      handleWidth,
      priority: "left",
    });
    const step = computeKeyboardStepPx({
      key: e.key,
      shiftKey: e.shiftKey,
      currentPx: solvedBounds.leftPx,
      minPx: solvedBounds.minLeft,
      maxPx: solvedBounds.maxLeft,
    });
    if (!step) return;
    e.preventDefault();
    if (step.action === "reset") {
      resetKind("main");
      return;
    }
    savePersistedSplit(
      "studio-main",
      "ratio",
      pxToRatio(step.nextPx, Math.max(1, containerWidth - handleWidth)),
      storage
    );
    sync();
  };

  const onBehindKeyDown = (e: KeyboardEvent): void => {
    if (destroyed || !isThreePaneActive()) return;
    const containerWidth = workspace.getBoundingClientRect().width;
    if (containerWidth <= 0) return;

    const curBehind = measureBehindPx(containerWidth);
    const curLeft = measureTopologyPx(Math.round(containerWidth * 0.35));
    const solvedBounds = clampStudioThreePane({
      containerWidth,
      desiredLeftPx: curLeft,
      desiredBehindPx: curBehind,
      handleWidth,
      priority: "behind",
    });
    const step = computeKeyboardStepPx({
      key: e.key,
      shiftKey: e.shiftKey,
      currentPx: solvedBounds.behindPx,
      minPx: solvedBounds.minBehind,
      maxPx: solvedBounds.maxBehind,
      invertDelta: true,
    });
    if (!step) return;
    e.preventDefault();
    if (step.action === "reset") {
      resetKind("behind");
      return;
    }
    savePersistedSplit("studio-behind", "px", step.nextPx, storage);
    sync();
  };

  mainHandle.addEventListener("pointerdown", onMainPointerDown);
  mainHandle.addEventListener("pointermove", onPointerMove);
  mainHandle.addEventListener("pointerup", onPointerUpOrCancel);
  mainHandle.addEventListener("pointercancel", onPointerUpOrCancel);
  mainHandle.addEventListener("dblclick", onMainDblClick);
  mainHandle.addEventListener("keydown", onMainKeyDown);

  behindHandle.addEventListener("pointerdown", onBehindPointerDown);
  behindHandle.addEventListener("pointermove", onPointerMove);
  behindHandle.addEventListener("pointerup", onPointerUpOrCancel);
  behindHandle.addEventListener("pointercancel", onPointerUpOrCancel);
  behindHandle.addEventListener("dblclick", onBehindDblClick);
  behindHandle.addEventListener("keydown", onBehindKeyDown);

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUpOrCancel);
  window.addEventListener("pointercancel", onPointerUpOrCancel);
  window.addEventListener("blur", onWindowBlur);

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => {
      if (!activeKind) sync();
    });
    ro.observe(workspace);
  }

  sync();

  return {
    sync,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      finishDrag(false);
      cleanupDragDom();
      ro?.disconnect();
      ro = null;
      mainHandle.removeEventListener("pointerdown", onMainPointerDown);
      mainHandle.removeEventListener("pointermove", onPointerMove);
      mainHandle.removeEventListener("pointerup", onPointerUpOrCancel);
      mainHandle.removeEventListener("pointercancel", onPointerUpOrCancel);
      mainHandle.removeEventListener("dblclick", onMainDblClick);
      mainHandle.removeEventListener("keydown", onMainKeyDown);
      behindHandle.removeEventListener("pointerdown", onBehindPointerDown);
      behindHandle.removeEventListener("pointermove", onPointerMove);
      behindHandle.removeEventListener("pointerup", onPointerUpOrCancel);
      behindHandle.removeEventListener("pointercancel", onPointerUpOrCancel);
      behindHandle.removeEventListener("dblclick", onBehindDblClick);
      behindHandle.removeEventListener("keydown", onBehindKeyDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUpOrCancel);
      window.removeEventListener("pointercancel", onPointerUpOrCancel);
      window.removeEventListener("blur", onWindowBlur);
    },
  };
}
