import { fetchEventBody } from "../api.js";
import type {
  BehindStep,
  BehindThoughtStep,
  BehindToolStep,
  SmsMessageItem,
} from "../state/topologyGrouping.js";
import { copyTextSafe, escHtml } from "../utils.js";
import { renderMarkdown } from "../utils/markdown.js";

export interface BehindSessionContext {
  sessionId?: string;
  ide?: string;
  project?: string;
  workspace?: string;
}

export interface BehindResponseDrawerOptions {
  drawerEl: HTMLElement;
  backdropEl: HTMLElement;
  embedMode?: boolean;
  mcpAppMode?: boolean;
  getSessionContext?: () => BehindSessionContext;
  onOpenChat?: (agentId: string) => void;
  onStepChange?: (entry: SmsMessageItem) => void;
  onClose?: (restoreFocus: boolean, lastEventId: string | null) => void;
}

function decodeFileUriToPath(uri: string): string {
  const raw = uri.trim();
  if (!/^file:/i.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    let pathname = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    if (parsed.host && parsed.host !== "localhost") {
      return `//${parsed.host}${pathname}`;
    }
    return pathname || raw;
  } catch {
    return raw.replace(/^file:\/\//i, "");
  }
}

function formatBehindCountSummary(entry: SmsMessageItem): string {
  const { thoughtCount, toolCount, durationLabel } = entry.behindSummary;
  const parts: string[] = [];
  if (thoughtCount > 0) {
    parts.push(`${thoughtCount} ${thoughtCount === 1 ? "thought" : "thoughts"}`);
  }
  if (toolCount > 0) {
    parts.push(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
  }
  if (durationLabel) {
    parts.push(durationLabel);
  }
  return parts.join(" · ");
}

function resolveSpeakerAgentId(entry: SmsMessageItem): string | null {
  const ev = entry.event;
  const raw =
    ev.kind === "subagent_done" && ev.targetAgentId && ev.targetAgentId !== ev.agentId
      ? ev.targetAgentId
      : ev.agentId;
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "human" || trimmed === "ext:human" || trimmed.startsWith("ext:")) {
    return null;
  }
  return trimmed;
}

export class BehindResponseDrawer {
  private static readonly MAX_CACHED_THOUGHTS = 64;
  private drawerEl: HTMLElement;
  private backdropEl: HTMLElement;
  private opts: BehindResponseDrawerOptions;
  private embedMode: boolean;
  private mcpAppMode: boolean;
  private getSessionContext: () => BehindSessionContext;

  private currentEventId: string | null = null;
  private entries: SmsMessageItem[] = [];
  private triggerEl: HTMLElement | null = null;
  private toolDetailsOpen = new Map<string, boolean>();
  private initializedEntryDefaults = new Set<string>();
  private fetchedThoughtBodies = new Map<string, string>();
  private loadingThoughtIds = new Set<string>();
  private sessionResetSeq = 0;
  private lastSignature = "";

  private onKeyDownBound: (e: KeyboardEvent) => void;
  private onBackdropClickBound: () => void;

  constructor(opts: BehindResponseDrawerOptions) {
    this.opts = opts;
    this.drawerEl = opts.drawerEl;
    this.backdropEl = opts.backdropEl;
    this.embedMode = Boolean(opts.embedMode);
    this.mcpAppMode = Boolean(opts.mcpAppMode);
    this.getSessionContext = opts.getSessionContext ?? (() => ({}));

    this.drawerEl.setAttribute("role", "region");
    this.drawerEl.setAttribute("aria-label", "Behind this response");

    this.onKeyDownBound = (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.isOpen()) {
        if (document.querySelector("dialog[open]")) return;
        e.preventDefault();
        this.close(true);
      }
    };
    this.onBackdropClickBound = () => {
      if (this.isOpen()) {
        this.close(true);
      }
    };

    document.addEventListener("keydown", this.onKeyDownBound);
    this.backdropEl.addEventListener("click", this.onBackdropClickBound);

    this.drawerEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (target.closest("[data-behind-close]")) {
        this.close(true);
        return;
      }

      const stepBtn = target.closest<HTMLButtonElement>("[data-behind-step]");
      if (stepBtn && !stepBtn.disabled) {
        const targetId = stepBtn.dataset.behindStep;
        if (targetId) {
          const next = this.entries.find((item) => item.event.id === targetId);
          if (next) {
            this.currentEventId = next.event.id;
            this.lastSignature = "";
            this.render();
            this.opts.onStepChange?.(next);
          }
        }
        return;
      }

      const chatBtn = target.closest<HTMLButtonElement>("[data-behind-open-chat]");
      if (chatBtn) {
        const aid = chatBtn.dataset.behindOpenChat;
        if (aid) {
          this.opts.onOpenChat?.(aid);
        }
        return;
      }

      const expandThoughtBtn = target.closest<HTMLButtonElement>("[data-behind-expand-thought]");
      if (expandThoughtBtn) {
        const evId = expandThoughtBtn.dataset.behindExpandThought;
        if (evId) {
          void this.loadFullThoughtBody(evId);
        }
        return;
      }

      const codeCopyBtn = target.closest<HTMLButtonElement>("[data-code-copy]");
      if (codeCopyBtn) {
        const block = codeCopyBtn.closest(".reader-code-block");
        const codeEl = block?.querySelector("code");
        const codeText = codeEl?.textContent ?? "";
        if (codeText) {
          void this.handleCopyButton(codeCopyBtn, codeText, "Copy");
        }
        return;
      }

      const fileChip = target.closest<HTMLButtonElement>(".reader-file-chip");
      if (fileChip) {
        void this.handleFileChipClick(fileChip);
      }
    });

    this.drawerEl.addEventListener(
      "toggle",
      (e) => {
        const det = e.target as HTMLDetailsElement | null;
        if (det && det.tagName === "DETAILS" && det.dataset.behindToolKey) {
          this.toolDetailsOpen.set(det.dataset.behindToolKey, det.open);
        }
      },
      true
    );
  }

  public setRuntimeScope(scope: { embedMode?: boolean; mcpAppMode?: boolean }): void {
    if (typeof scope.embedMode === "boolean") {
      this.embedMode = scope.embedMode;
    }
    if (typeof scope.mcpAppMode === "boolean") {
      this.mcpAppMode = scope.mcpAppMode;
    }
  }

  public resetSession(): void {
    this.sessionResetSeq += 1;
    this.fetchedThoughtBodies.clear();
    this.loadingThoughtIds.clear();
    this.toolDetailsOpen.clear();
    this.initializedEntryDefaults.clear();
    this.entries = [];
    this.close(false);
  }

  public isOpen(): boolean {
    return this.currentEventId !== null && !this.drawerEl.hidden;
  }

  public getCurrentEventId(): string | null {
    return this.currentEventId;
  }

  public open(
    entry: SmsMessageItem,
    allWithBehind: SmsMessageItem[],
    triggerEl?: HTMLElement | null
  ): void {
    this.entries = allWithBehind;
    this.currentEventId = entry.event.id;
    if (triggerEl) {
      this.triggerEl = triggerEl;
    }
    this.lastSignature = "";
    this.render();
    if (window.matchMedia("(max-width: 639px)").matches) {
      this.drawerEl.querySelector<HTMLButtonElement>("[data-behind-close]")?.focus({
        preventScroll: true,
      });
    }
  }

  public refreshEntries(allWithBehind: SmsMessageItem[]): void {
    this.entries = allWithBehind;
    if (!this.currentEventId) return;
    const stillExists = this.entries.some((e) => e.event.id === this.currentEventId);
    if (!stillExists) {
      this.close(false);
      return;
    }
    this.render();
  }

  public close(restoreFocus = false): void {
    const prevId = this.currentEventId;
    const opener = this.triggerEl;
    this.currentEventId = null;
    this.lastSignature = "";
    this.drawerEl.hidden = true;
    this.drawerEl.innerHTML = "";
    this.backdropEl.hidden = true;
    this.opts.onClose?.(restoreFocus, prevId);
    if (restoreFocus) {
      const target =
        opener && document.contains(opener)
          ? opener
          : prevId
            ? document.querySelector<HTMLElement>(`[data-open-behind="${CSS.escape(prevId)}"]`)
            : null;
      target?.focus({ preventScroll: true });
    }
    this.triggerEl = null;
  }

  public dispose(): void {
    this.sessionResetSeq += 1;
    document.removeEventListener("keydown", this.onKeyDownBound);
    this.backdropEl.removeEventListener("click", this.onBackdropClickBound);
    this.currentEventId = null;
    this.drawerEl.hidden = true;
    this.drawerEl.innerHTML = "";
    this.backdropEl.hidden = true;
  }

  private cacheThoughtBody(thoughtEventId: string, body: string): void {
    if (this.fetchedThoughtBodies.has(thoughtEventId)) {
      this.fetchedThoughtBodies.delete(thoughtEventId);
    }
    this.fetchedThoughtBodies.set(thoughtEventId, body);
    if (this.fetchedThoughtBodies.size > BehindResponseDrawer.MAX_CACHED_THOUGHTS) {
      const oldestKey = this.fetchedThoughtBodies.keys().next().value;
      if (oldestKey !== undefined) {
        this.fetchedThoughtBodies.delete(oldestKey);
      }
    }
  }

  private async loadFullThoughtBody(thoughtEventId: string): Promise<void> {
    if (
      this.fetchedThoughtBodies.has(thoughtEventId) ||
      this.loadingThoughtIds.has(thoughtEventId)
    ) {
      return;
    }
    const entry = this.entries.find((e) => e.event.id === this.currentEventId);
    const thoughtStep = entry?.behindSteps.find(
      (s): s is BehindThoughtStep => s.kind === "thought" && s.event.id === thoughtEventId
    );
    const ctx = this.getSessionContext();
    const sessionId = thoughtStep?.event.sessionId || entry?.event.sessionId || ctx.sessionId || "";
    if (!sessionId) return;

    const reqSeq = this.sessionResetSeq;
    const reqSessionId = sessionId;
    this.loadingThoughtIds.add(thoughtEventId);
    this.lastSignature = "";
    this.render();
    try {
      const res = await fetchEventBody({
        sessionId,
        eventId: thoughtEventId,
        ide: thoughtStep?.event.ide || ctx.ide,
        project: thoughtStep?.event.projectId || ctx.project,
        workspace: thoughtStep?.event.workspacePath || ctx.workspace,
      });
      if (reqSeq !== this.sessionResetSeq) return;
      const activeSession =
        this.entries.find((e) => e.event.id === this.currentEventId)?.event.sessionId ||
        this.getSessionContext().sessionId ||
        "";
      if (activeSession && reqSessionId !== activeSession) return;
      if (res.ok && typeof res.body === "string" && res.body.trim()) {
        this.cacheThoughtBody(thoughtEventId, res.body.trim());
      }
    } catch {
      // Graceful fallback to existing truncated summary
    } finally {
      this.loadingThoughtIds.delete(thoughtEventId);
      if (reqSeq === this.sessionResetSeq && this.isOpen()) {
        this.lastSignature = "";
        this.render();
      }
    }
  }

  private async handleCopyButton(
    btn: HTMLButtonElement,
    text: string,
    defaultLabel: string
  ): Promise<void> {
    const ok = await copyTextSafe(text);
    btn.textContent = ok ? "Copied ✓" : "Copy failed";
    btn.classList.toggle("copied", ok);
    window.setTimeout(() => {
      if (document.contains(btn)) {
        btn.textContent = defaultLabel;
        btn.classList.remove("copied");
      }
    }, 1500);
  }

  private async handleFileChipClick(chip: HTMLButtonElement): Promise<void> {
    const uri = chip.dataset.fileUri ?? "";
    if (!uri) return;
    const startLineRaw = chip.dataset.startLine;
    const endLineRaw = chip.dataset.endLine;
    const startLine = startLineRaw ? Number.parseInt(startLineRaw, 10) : undefined;
    const endLine = endLineRaw ? Number.parseInt(endLineRaw, 10) : undefined;
    const origHtml = chip.dataset.origHtml ?? chip.innerHTML;
    chip.dataset.origHtml = origHtml;

    if (this.embedMode && !this.mcpAppMode && window.parent !== window) {
      window.parent.postMessage(
        {
          type: "agentStudio.openFile",
          uri,
          ...(Number.isFinite(startLine) ? { startLine } : {}),
          ...(Number.isFinite(endLine) ? { endLine } : {}),
        },
        "*"
      );
      chip.classList.add("is-feedback");
      chip.textContent = "Opened beside ✓";
      window.setTimeout(() => {
        if (document.contains(chip)) {
          chip.classList.remove("is-feedback");
          chip.innerHTML = origHtml;
        }
      }, 1500);
      return;
    }

    const decoded = decodeFileUriToPath(uri);
    const ok = await copyTextSafe(decoded);
    chip.classList.toggle("is-feedback", ok);
    chip.textContent = ok ? "Copied path ✓" : "Copy failed";
    window.setTimeout(() => {
      if (document.contains(chip)) {
        chip.classList.remove("is-feedback");
        chip.innerHTML = origHtml;
      }
    }, 1500);
  }

  private computeSignature(
    entry: SmsMessageItem,
    prevId: string | null,
    nextId: string | null
  ): string {
    const stepSig = entry.behindSteps
      .map((s) =>
        s.kind === "thought"
          ? `t:${s.event.id}:${s.text.length}:${this.fetchedThoughtBodies.get(s.event.id)?.length ?? 0}:${this.loadingThoughtIds.has(s.event.id) ? 1 : 0}`
          : `c:${s.event.id}:${s.status}:${s.durationLabel ?? ""}:${s.outputPreview?.length ?? 0}`
      )
      .join("|");
    return `${entry.event.id}|${prevId ?? ""}|${nextId ?? ""}|${entry.behindSteps.length}|${stepSig}`;
  }

  private renderThoughtStep(step: BehindThoughtStep, idx: number, totalThoughts: number): string {
    const fetched = this.fetchedThoughtBodies.get(step.event.id);
    const bodyText = fetched && fetched.length > step.text.length ? fetched : step.text;
    const isTruncated = step.event.bodyTruncated === true && !fetched;
    const isLoading = this.loadingThoughtIds.has(step.event.id);
    const rendered = renderMarkdown(bodyText, { enableFileLinks: true });

    return `
      <div class="thought-card">
        <div class="thought-card-head">
          <span>✦ Self-Thought ${totalThoughts > 1 ? `#${idx + 1}` : ""} · Private Reasoning</span>
          <span>${escHtml(step.timeLabel)}${step.durationLabel ? ` · ${escHtml(step.durationLabel)}` : ""}</span>
        </div>
        <div class="thought-card-body reader-md">${rendered.html}</div>
        ${
          isTruncated
            ? `<button type="button" class="show-more-btn" data-behind-expand-thought="${escHtml(step.event.id)}" ${isLoading ? "disabled" : ""}>${isLoading ? "Loading full thought…" : "Load full thought ▾"}</button>`
            : ""
        }
      </div>
    `;
  }

  private renderToolStep(entryId: string, step: BehindToolStep, toolIdx: number): string {
    const fullKey = `${entryId}|${step.event.id || `tool-${toolIdx}`}`;
    const isOpen = this.toolDetailsOpen.get(fullKey) ?? false;
    const statusPill =
      step.status === "error"
        ? `<span class="tool-err-pill">✕ Error</span>`
        : step.status === "denied"
          ? `<span class="tool-err-pill">⊘ Denied</span>`
          : step.status === "running"
            ? `<span class="tool-run-pill">… Running</span>`
            : `<span class="tool-ok-pill">✓ OK</span>`;

    const hasIo = Boolean(step.inputPreview || step.outputPreview);
    return `
      <details class="tool-step-details" data-behind-tool-key="${escHtml(fullKey)}" ${isOpen ? "open" : ""}>
        <summary>
          <span class="tool-name-pill">${escHtml(step.toolName)}</span>
          ${statusPill}
          ${step.durationLabel ? `<span class="tool-latency">${escHtml(step.durationLabel)}</span>` : ""}
          <div class="tool-step-summary-txt">${escHtml(step.summary)}</div>
        </summary>
        <div class="tool-io-block">
          ${
            step.inputPreview
              ? `<div>
                  <div class="trace-section-label">Input</div>
                  <pre class="tool-io-pre">${escHtml(step.inputPreview)}</pre>
                </div>`
              : ""
          }
          ${
            step.outputPreview
              ? `<div>
                  <div class="trace-section-label">Result</div>
                  <pre class="tool-io-pre">${escHtml(step.outputPreview)}</pre>
                </div>`
              : ""
          }
          ${!hasIo ? `<div class="muted" style="font-size:11px;">No structured input/output captured.</div>` : ""}
        </div>
      </details>
    `;
  }

  private renderStepList(entry: SmsMessageItem): string {
    const totalThoughts = entry.behindSteps.filter((s) => s.kind === "thought").length;
    let thoughtIdx = 0;
    let toolIdx = 0;

    if (!this.initializedEntryDefaults.has(entry.event.id)) {
      this.initializedEntryDefaults.add(entry.event.id);
      const firstTool = entry.behindSteps.find((s): s is BehindToolStep => s.kind === "tool");
      if (firstTool) {
        const key = `${entry.event.id}|${firstTool.event.id || "tool-0"}`;
        if (!this.toolDetailsOpen.has(key)) {
          this.toolDetailsOpen.set(key, true);
        }
      }
    }

    return entry.behindSteps
      .map((step: BehindStep) => {
        if (step.kind === "thought") {
          const html = this.renderThoughtStep(step, thoughtIdx, totalThoughts);
          thoughtIdx += 1;
          return html;
        }
        const html = this.renderToolStep(entry.event.id, step, toolIdx);
        toolIdx += 1;
        return html;
      })
      .join("");
  }

  private render(): void {
    const entry = this.entries.find((e) => e.event.id === this.currentEventId);
    if (!entry) {
      this.close(false);
      return;
    }

    const curIdx = this.entries.findIndex((e) => e.event.id === entry.event.id);
    const prevEntry = curIdx > 0 ? this.entries[curIdx - 1]! : null;
    const nextEntry =
      curIdx >= 0 && curIdx < this.entries.length - 1 ? this.entries[curIdx + 1]! : null;

    const sig = this.computeSignature(
      entry,
      prevEntry?.event.id ?? null,
      nextEntry?.event.id ?? null
    );
    if (!this.drawerEl.hidden && sig === this.lastSignature) {
      return;
    }

    const prevBody = this.drawerEl.querySelector<HTMLElement>(".inspector-body");
    const prevScrollTop =
      !this.drawerEl.hidden && prevBody && this.lastSignature.startsWith(`${entry.event.id}|`)
        ? prevBody.scrollTop
        : 0;

    this.lastSignature = sig;
    this.drawerEl.hidden = false;
    this.backdropEl.hidden = false;

    const speakerAgentId = resolveSpeakerAgentId(entry);
    const countSummary = formatBehindCountSummary(entry);

    this.drawerEl.innerHTML = `
      <div class="inspector-head">
        <div class="inspector-head-top">
          <div class="inspector-head-title-wrap">
            <div class="inspector-kicker">✦ Behind This Response</div>
            <h2 class="inspector-title">
              <span>${escHtml(entry.fromLabel)}</span>
              <span class="bubble-role">${escHtml(entry.roleBadge)}</span>
              <span class="bubble-role">${escHtml(entry.timeLabel)}</span>
            </h2>
          </div>
          <button
            type="button"
            class="btn-ghost-sm"
            data-behind-close
            aria-label="Close behind this response drawer"
          >✕ Close</button>
        </div>
        <div class="inspector-nav-row">
          <span class="inspector-route-label">${escHtml(entry.routeLabel)}</span>
          <div class="nav-step-group">
            <button
              type="button"
              class="btn-ghost-sm"
              data-behind-step="${prevEntry ? escHtml(prevEntry.event.id) : ""}"
              ${prevEntry ? "" : "disabled"}
            >← Prev</button>
            <button
              type="button"
              class="btn-ghost-sm"
              data-behind-step="${nextEntry ? escHtml(nextEntry.event.id) : ""}"
              ${nextEntry ? "" : "disabled"}
            >Next →</button>
          </div>
        </div>
      </div>
      <div class="inspector-body">
        <div class="trace-section-label">
          <span>Reasoning &amp; Preceding Work</span>
          ${countSummary ? `<span>${escHtml(countSummary)}</span>` : ""}
        </div>
        <div class="trace-timeline">
          ${this.renderStepList(entry)}
        </div>
        <div class="response-sent-divider" aria-label="Response sent at ${escHtml(entry.timeLabel)}">
          <span>response sent · ${escHtml(entry.timeLabel)}</span>
        </div>
      </div>
      ${
        speakerAgentId
          ? `<div class="inspector-foot">
              <button
                type="button"
                class="btn-primary-sm"
                data-behind-open-chat="${escHtml(speakerAgentId)}"
              >Open ${escHtml(entry.fromLabel)} Chat ↗</button>
            </div>`
          : ""
      }
    `;

    if (prevScrollTop > 0) {
      const nextBody = this.drawerEl.querySelector<HTMLElement>(".inspector-body");
      if (nextBody) nextBody.scrollTop = prevScrollTop;
    }
  }
}
