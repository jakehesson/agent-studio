import { fetchAgentChat } from "../api.js";
import type {
  AgentChatMessage,
  AgentChatResponse,
  AgentNodeSnapshot,
  ChatToolCallRef,
  PendingHumanPrompt,
  ReplyCapabilities,
  ReplyToHostRequest,
  ReplyToHostResult,
  SessionSnapshot,
  TeamDefinitionEntry,
} from "../types.js";
import {
  cleanSummaryText,
  colorForAgent,
  escHtml,
  fmtClock,
  fmtContextWindow,
  formatActorName,
  getContextZone,
  getIdeMeta,
  getStatusStyle,
  trunc,
} from "../utils.js";
import { renderMarkdown } from "../utils/markdown.js";
import { QuestionCard } from "./QuestionCard.js";

export interface ChatDrawerSessionContext {
  sessionId?: string;
  ide?: string;
  project?: string;
  workspace?: string;
}

export interface AgentChatDrawerOptions {
  getSessionContext: () => ChatDrawerSessionContext;
  getReplyCapabilities: () => ReplyCapabilities;
  onReplyToHost: (req: ReplyToHostRequest) => Promise<ReplyToHostResult>;
  onOpenInspector?: (agentId: string) => void;
  onSwitchAgent?: (agentId: string) => void;
}

export interface OpenAgentChatParams {
  agent: AgentNodeSnapshot;
  labelMap?: Map<string, string>;
  definition?: TeamDefinitionEntry;
  focusQuestion?: boolean;
}

const LIVE_REFRESH_DEBOUNCE_MS = 350;
const INITIAL_LIMIT = 60;

export class AgentChatDrawer {
  private opts: AgentChatDrawerOptions;
  private dialog: HTMLDialogElement;

  private accentBarEl: HTMLElement;
  private titleEl: HTMLElement;
  private metaRowEl: HTMLElement;
  private headerBadgesEl: HTMLElement;
  private jumpQuestionBtn: HTMLButtonElement;
  private wideToggleBtn: HTMLButtonElement;
  private bodyEl: HTMLElement;
  private jumpLatestBtn: HTMLButtonElement;
  private promptDockEl: HTMLElement;
  private promptToggleBtn: HTMLButtonElement;
  private promptTitleSummaryEl: HTMLElement;
  private promptCardMountEl: HTMLElement;
  private liveAnnouncerEl: HTMLElement;

  private isOpen = false;
  private isWide = false;
  private promptCollapsed = false;
  private currentAgentId: string | null = null;
  private currentAgent: AgentNodeSnapshot | null = null;
  private currentDefinition: TeamDefinitionEntry | undefined = undefined;
  private labelMap: Map<string, string> = new Map();
  private lastInvokerEl: HTMLElement | null = null;

  private loading = false;
  private loadingMore = false;
  private loadError = "";
  private messages: AgentChatMessage[] = [];
  private totalMessages = 0;
  private hasMore = false;
  private nextCursor: string | undefined = undefined;
  private fetchedPendingPrompt: PendingHumanPrompt | null = null;

  private isNearBottom = true;
  private unseenCount = 0;
  private openSeq = 0;
  private refreshTimer: number | null = null;
  private lastAgentSignature = "";
  private lastRenderedMsgsKey = "";
  private detailsOpenMap = new Map<string, boolean>();
  private questionCard: QuestionCard | null = null;

  constructor(opts: AgentChatDrawerOptions) {
    this.opts = opts;

    const dlg = document.createElement("dialog");
    dlg.className = "chat-drawer-dialog";
    dlg.setAttribute("closedby", "any");
    dlg.setAttribute("aria-labelledby", "chatDrawerTitle");
    dlg.innerHTML = `
      <div class="chat-drawer-shell">
        <div class="chat-drawer-accent" data-chat-accent aria-hidden="true"></div>
        <header class="chat-drawer-head">
          <div class="chat-head-main">
            <div class="chat-title-row">
              <h1 id="chatDrawerTitle" class="chat-drawer-title" data-chat-title>Agent Chat</h1>
              <div class="chat-head-badges" data-chat-badges></div>
            </div>
            <div class="chat-head-meta" data-chat-meta></div>
          </div>
          <div class="chat-head-actions">
            <button
              type="button"
              class="chat-jump-q-btn"
              data-chat-jump-q
              hidden
            ><span aria-hidden="true">?</span> Jump to Question</button>
            <button
              type="button"
              class="copy-btn chat-wide-btn"
              data-chat-wide
              aria-pressed="false"
              title="Toggle wide chat drawer"
            >Wide</button>
            <button
              type="button"
              class="insp-icon-btn chat-close-btn"
              data-chat-close
              aria-label="Close agent chat"
            >✕</button>
          </div>
        </header>

        <div class="chat-body-wrap">
          <div class="chat-body" data-chat-body role="region" tabindex="0" aria-label="Agent conversation"></div>
          <button type="button" class="jump-latest-btn chat-jump-latest" data-chat-jump-latest hidden>↓ Jump to latest</button>
        </div>

        <section class="chat-prompt-dock" data-chat-prompt-dock aria-label="Pending human prompt" hidden>
          <div class="chat-prompt-dock-bar">
            <button
              type="button"
              class="chat-prompt-toggle"
              data-chat-prompt-toggle
              aria-expanded="true"
            >
              <span class="chat-prompt-pill"><span aria-hidden="true">?</span> Waiting on you</span>
              <span class="chat-prompt-dock-title" data-chat-prompt-title></span>
              <span class="chat-prompt-chevron" aria-hidden="true">▾</span>
            </button>
          </div>
          <div class="chat-prompt-card-mount" data-chat-prompt-mount></div>
        </section>

        <div class="sr-only" aria-live="polite" data-chat-live></div>
      </div>
    `;
    document.body.appendChild(dlg);
    this.dialog = dlg;

    this.accentBarEl = dlg.querySelector("[data-chat-accent]") as HTMLElement;
    this.titleEl = dlg.querySelector("[data-chat-title]") as HTMLElement;
    this.headerBadgesEl = dlg.querySelector("[data-chat-badges]") as HTMLElement;
    this.metaRowEl = dlg.querySelector("[data-chat-meta]") as HTMLElement;
    this.jumpQuestionBtn = dlg.querySelector("[data-chat-jump-q]") as HTMLButtonElement;
    this.wideToggleBtn = dlg.querySelector("[data-chat-wide]") as HTMLButtonElement;
    this.bodyEl = dlg.querySelector("[data-chat-body]") as HTMLElement;
    this.jumpLatestBtn = dlg.querySelector("[data-chat-jump-latest]") as HTMLButtonElement;
    this.promptDockEl = dlg.querySelector("[data-chat-prompt-dock]") as HTMLElement;
    this.promptToggleBtn = dlg.querySelector("[data-chat-prompt-toggle]") as HTMLButtonElement;
    this.promptTitleSummaryEl = dlg.querySelector("[data-chat-prompt-title]") as HTMLElement;
    this.promptCardMountEl = dlg.querySelector("[data-chat-prompt-mount]") as HTMLElement;
    this.liveAnnouncerEl = dlg.querySelector("[data-chat-live]") as HTMLElement;

    this.bindEvents();
  }

  private bindEvents(): void {
    const dlg = this.dialog;

    // Safari fallback for <dialog closedby="any"> using pointerdown/pointerup outside bounding box
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const isOutside = (e: PointerEvent): boolean => {
        const r = dlg.getBoundingClientRect();
        return (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        );
      };
      dlg.addEventListener("pointerdown", (e) => {
        pressedOutside = isOutside(e);
      });
      dlg.addEventListener("pointerup", (e) => {
        if (pressedOutside && isOutside(e)) {
          dlg.close();
        }
        pressedOutside = false;
      });
    }

    dlg.addEventListener("close", () => {
      dlg.returnValue = "";
      this.isOpen = false;
      this.loadingMore = false;
      this.openSeq += 1;
      if (this.refreshTimer != null) {
        window.clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
      const invoker = this.lastInvokerEl;
      const closedAgentId = this.currentAgentId;
      this.lastInvokerEl = null;
      window.requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) {
          return;
        }
        if (invoker && invoker.isConnected) {
          invoker.focus({ preventScroll: true });
          return;
        }
        if (closedAgentId) {
          const escaped =
            typeof CSS !== "undefined" && typeof CSS.escape === "function"
              ? CSS.escape(closedAgentId)
              : closedAgentId.replace(/["\\]/g, "\\$&");
          const fallbackEl = document.querySelector<HTMLElement>(
            `[data-chat-agent-id="${escaped}"], [data-open-chat="${escaped}"]`
          );
          fallbackEl?.focus({ preventScroll: true });
        }
      });
    });

    dlg.querySelector("[data-chat-close]")?.addEventListener("click", () => {
      dlg.close();
    });

    this.wideToggleBtn.addEventListener("click", () => {
      this.isWide = !this.isWide;
      this.dialog.classList.toggle("is-wide", this.isWide);
      this.wideToggleBtn.setAttribute("aria-pressed", this.isWide ? "true" : "false");
    });

    this.jumpQuestionBtn.addEventListener("click", () => {
      this.expandAndFocusQuestion();
    });

    this.promptToggleBtn.addEventListener("click", () => {
      this.promptCollapsed = !this.promptCollapsed;
      this.syncPromptDockVisibility();
    });

    this.bodyEl.addEventListener("scroll", () => {
      const el = this.bodyEl;
      this.isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 56;
      if (this.isNearBottom) {
        this.unseenCount = 0;
      }
      this.syncJumpLatestBtn();
    });

    this.jumpLatestBtn.addEventListener("click", () => {
      this.bodyEl.scrollTo({
        top: this.bodyEl.scrollHeight,
        behavior: "smooth",
      });
      this.isNearBottom = true;
      this.unseenCount = 0;
      this.syncJumpLatestBtn();
    });

    this.bodyEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (target.closest("[data-chat-load-more]")) {
        void this.loadEarlier();
        return;
      }
      if (target.closest("[data-chat-retry]")) {
        if (this.currentAgent) {
          void this.fetchAndRender(true, false);
        }
        return;
      }
      if (target.closest("[data-chat-open-inspector]")) {
        const aid = this.currentAgentId;
        this.close();
        if (aid) this.opts.onOpenInspector?.(aid);
        return;
      }

      const subBtn = target.closest<HTMLButtonElement>("[data-chat-subagent]");
      if (subBtn) {
        const subId = subBtn.dataset.chatSubagent;
        if (subId) {
          this.opts.onSwitchAgent?.(subId);
        }
        return;
      }
    });

    this.bodyEl.addEventListener(
      "toggle",
      (e) => {
        const det = e.target as HTMLDetailsElement | null;
        if (det && det.tagName === "DETAILS" && det.dataset.chatDetKey) {
          this.detailsOpenMap.set(det.dataset.chatDetKey, det.open);
        }
      },
      true
    );
  }

  public dispose(): void {
    if (this.refreshTimer != null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.questionCard?.dispose();
    this.questionCard = null;
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
  }

  public getOpenAgentId(): string | null {
    return this.isOpen ? this.currentAgentId : null;
  }

  public open(params: OpenAgentChatParams): void {
    const activeBeforeOpen = document.activeElement;
    if (!this.isOpen && activeBeforeOpen instanceof HTMLElement && activeBeforeOpen !== document.body) {
      this.lastInvokerEl = activeBeforeOpen;
    }

    const switchingAgent = this.currentAgentId !== params.agent.id;
    this.currentAgent = params.agent;
    this.currentAgentId = params.agent.id;
    this.currentDefinition = params.definition;
    if (params.labelMap) this.labelMap = params.labelMap;

    if (switchingAgent) {
      this.messages = [];
      this.totalMessages = 0;
      this.hasMore = false;
      this.nextCursor = undefined;
      this.fetchedPendingPrompt = params.agent.pendingPrompt ?? null;
      this.loadError = "";
      this.loadingMore = false;
      this.isNearBottom = true;
      this.unseenCount = 0;
      this.promptCollapsed = false;
      this.detailsOpenMap.clear();
      this.lastRenderedMsgsKey = "";
      this.syncJumpLatestBtn();
    } else {
      this.loadingMore = false;
    }

    const sessionId = this.opts.getSessionContext().sessionId ?? "";
    this.lastAgentSignature = this.computeAgentSignature(params.agent, sessionId);
    this.renderHeader();
    this.renderPendingPromptDock();

    if (!this.dialog.open) {
      this.isOpen = true;
      this.dialog.showModal();
    } else {
      this.isOpen = true;
    }

    void this.fetchAndRender(true, Boolean(params.focusQuestion));
  }

  public close(): void {
    this.loadingMore = false;
    if (this.dialog.open) {
      this.dialog.close();
    }
  }

  public notifySnapshot(
    snapshot: SessionSnapshot,
    mergedAgents: AgentNodeSnapshot[],
    labelMap?: Map<string, string>
  ): void {
    if (!this.isOpen || !this.currentAgentId) return;
    if (labelMap) this.labelMap = labelMap;

    const latest =
      mergedAgents.find((a) => a.id === this.currentAgentId) ??
      snapshot.agents.find((a) => a.id === this.currentAgentId);
    if (!latest) return;

    const prevSig = this.lastAgentSignature;
    const nextSig = this.computeAgentSignature(latest, snapshot.sessionId);
    this.currentAgent = latest;
    if (latest.pendingPrompt === null) {
      this.fetchedPendingPrompt = null;
    }
    this.renderHeader();
    this.renderPendingPromptDock();

    if (nextSig !== prevSig) {
      this.lastAgentSignature = nextSig;
      if (this.refreshTimer != null) {
        window.clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null;
        if (this.isOpen && this.currentAgentId) {
          void this.fetchAndRender(false, false);
        }
      }, LIVE_REFRESH_DEBOUNCE_MS);
    }
  }

  private computeAgentSignature(agent: AgentNodeSnapshot, sessionId = ""): string {
    return `${sessionId}|${agent.steps ?? 0}|${agent.lastEventAt ?? ""}|${agent.status}|${agent.pendingPrompt?.id ?? ""}`;
  }

  private getEffectivePendingPrompt(): PendingHumanPrompt | null {
    if (this.currentAgent && this.currentAgent.pendingPrompt !== undefined) {
      return this.currentAgent.pendingPrompt;
    }
    return this.fetchedPendingPrompt ?? null;
  }

  private renderHeader(): void {
    const agent = this.currentAgent;
    if (!agent) return;

    const accent = colorForAgent(agent.id, agent.id === "root");
    this.accentBarEl.style.background = accent;
    this.dialog.style.setProperty("--chat-accent", accent);

    const displayName = formatActorName(agent.id, this.labelMap, agent.label);
    const roleLabel =
      this.currentDefinition?.roleType ||
      this.currentDefinition?.boardRole ||
      agent.role ||
      (agent.id === "root" ? "Coordinator" : "Agent");

    this.titleEl.textContent = displayName;

    const st = getStatusStyle(agent.status);
    const prompt = this.getEffectivePendingPrompt();
    const modelLabel = agent.usage?.model || agent.model || "";
    const usage = agent.usage;
    const zone = usage ? getContextZone(usage.contextPercent) : null;
    const ide = getIdeMeta(agent.ide);

    this.headerBadgesEl.innerHTML = `
      <span class="pill dispatch">${escHtml(trunc(cleanSummaryText(roleLabel), 24))}</span>
      ${
        prompt
          ? `<span class="needs-input-pill"><span aria-hidden="true">?</span> Needs Input</span>`
          : `<span class="s-status ${st.cssClass}">${escHtml(st.label)}</span>`
      }
      ${
        modelLabel && modelLabel !== "Unknown"
          ? `<span class="usage-model-pill">${escHtml(trunc(modelLabel, 24))}</span>`
          : ""
      }
      ${
        usage && zone
          ? `<span class="zone-pill zone-${zone.cssClass}" title="Context ${usage.contextPercent.toFixed(1)}% / ${fmtContextWindow(usage.contextWindow)}">${usage.contextPercent.toFixed(0)}% ctx</span>`
          : ""
      }
    `;

    this.metaRowEl.innerHTML = `
      <span class="ide-chip" style="color:${ide.color};border-color:${ide.border};background:${ide.bg}">${escHtml(ide.label)}</span>
      <span><code>${escHtml(agent.id)}</code></span>
      <span>${agent.toolCalls} tools</span>
      ${this.totalMessages > 0 ? `<span>${this.totalMessages} turns</span>` : ""}
    `;

    this.jumpQuestionBtn.hidden = !prompt;
  }

  private renderPendingPromptDock(): void {
    const prompt = this.getEffectivePendingPrompt();
    if (!prompt) {
      this.promptDockEl.hidden = true;
      this.questionCard?.dispose();
      this.questionCard = null;
      this.promptCardMountEl.innerHTML = "";
      this.jumpQuestionBtn.hidden = true;
      return;
    }

    this.jumpQuestionBtn.hidden = false;
    this.promptDockEl.hidden = false;
    this.promptTitleSummaryEl.textContent = cleanSummaryText(prompt.title);
    this.syncPromptDockVisibility();

    const ctx = this.opts.getSessionContext();
    if (this.questionCard && this.questionCard.getPromptId() === prompt.id) {
      this.questionCard.update({
        prompt,
        sessionId: ctx.sessionId,
        compact: true,
        showHeader: false,
      });
    } else {
      this.questionCard?.dispose();
      this.questionCard = new QuestionCard(this.promptCardMountEl, {
        prompt,
        sessionId: ctx.sessionId,
        compact: true,
        showHeader: false,
        getCapabilities: this.opts.getReplyCapabilities,
        onReply: this.opts.onReplyToHost,
      });
    }
  }

  private syncPromptDockVisibility(): void {
    this.promptToggleBtn.setAttribute(
      "aria-expanded",
      this.promptCollapsed ? "false" : "true"
    );
    const chev = this.promptToggleBtn.querySelector(".chat-prompt-chevron");
    if (chev) chev.textContent = this.promptCollapsed ? "▸" : "▾";
    this.promptCardMountEl.hidden = this.promptCollapsed;
  }

  private expandAndFocusQuestion(): void {
    if (!this.getEffectivePendingPrompt()) return;
    this.promptCollapsed = false;
    this.syncPromptDockVisibility();
    this.questionCard?.focusPrimaryControl();
  }

  private async fetchAndRender(
    showSkeleton: boolean,
    focusQuestionAfter: boolean
  ): Promise<void> {
    if (!this.currentAgentId) return;
    const seq = ++this.openSeq;
    const ctx = this.opts.getSessionContext();

    if (showSkeleton && this.messages.length === 0) {
      this.loading = true;
      this.loadError = "";
      this.syncJumpLatestBtn();
      this.renderBody();
    }

    try {
      const res: AgentChatResponse = await fetchAgentChat({
        session: ctx.sessionId,
        agent: this.currentAgentId,
        ide: this.currentAgent?.ide || ctx.ide,
        project: ctx.project,
        workspace: ctx.workspace,
        limit: INITIAL_LIMIT,
      });
      if (seq !== this.openSeq) return;

      const prevTotal = this.totalMessages;
      this.loading = false;
      this.loadError = "";
      this.messages = res.messages;
      this.totalMessages = res.totalMessages;
      this.hasMore = res.hasMore;
      this.nextCursor = res.nextCursor;
      this.fetchedPendingPrompt = res.pendingPrompt;

      if (!this.isNearBottom && res.totalMessages > prevTotal) {
        this.unseenCount += res.totalMessages - prevTotal;
      } else if (this.isNearBottom) {
        this.unseenCount = 0;
      }

      this.renderHeader();
      this.renderPendingPromptDock();
      this.renderBody();

      if (focusQuestionAfter && this.getEffectivePendingPrompt()) {
        window.requestAnimationFrame(() => this.expandAndFocusQuestion());
      }
    } catch (err) {
      if (seq !== this.openSeq) return;
      this.loading = false;
      this.loadError =
        err instanceof Error ? err.message : "Unable to load agent conversation";
      this.renderBody();
    }
  }

  private async loadEarlier(): Promise<void> {
    if (this.loadingMore || !this.hasMore || !this.nextCursor || !this.currentAgentId) {
      return;
    }
    const seq = this.openSeq;
    const ctx = this.opts.getSessionContext();
    this.loadingMore = true;
    const btn = this.bodyEl.querySelector<HTMLButtonElement>("[data-chat-load-more]");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Loading earlier…";
    }

    try {
      const res = await fetchAgentChat({
        session: ctx.sessionId,
        agent: this.currentAgentId,
        ide: this.currentAgent?.ide || ctx.ide,
        project: ctx.project,
        workspace: ctx.workspace,
        limit: INITIAL_LIMIT,
        before: this.nextCursor,
      });
      if (seq !== this.openSeq) return;

      const prevScrollHeight = this.bodyEl.scrollHeight;
      const prevScrollTop = this.bodyEl.scrollTop;

      const existingIds = new Set(this.messages.map((m) => m.id));
      const older = res.messages.filter((m) => !existingIds.has(m.id));
      this.messages = [...older, ...this.messages];
      this.totalMessages = Math.max(this.totalMessages, res.totalMessages);
      this.hasMore = res.hasMore;
      this.nextCursor = res.nextCursor;

      this.lastRenderedMsgsKey = "";
      this.renderBody(true);

      const deltaHeight = this.bodyEl.scrollHeight - prevScrollHeight;
      this.bodyEl.scrollTop = prevScrollTop + Math.max(0, deltaHeight);
    } catch {
      if (seq !== this.openSeq) return;
      const b = this.bodyEl.querySelector<HTMLButtonElement>("[data-chat-load-more]");
      if (b) {
        b.disabled = false;
        b.textContent = "Load earlier messages";
      }
    } finally {
      if (seq === this.openSeq) {
        this.loadingMore = false;
      }
    }
  }

  private syncJumpLatestBtn(): void {
    if (this.isNearBottom) {
      this.jumpLatestBtn.hidden = true;
      this.unseenCount = 0;
    } else {
      this.jumpLatestBtn.hidden = false;
      this.jumpLatestBtn.textContent =
        this.unseenCount > 0
          ? `↓ Jump to latest (${this.unseenCount} new)`
          : "↓ Jump to latest";
    }
  }

  private renderToolChipHtml(tool: ChatToolCallRef, msgId: string, idx: number): string {
    const status = tool.status ?? "ok";
    const statusLabel =
      status === "running"
        ? "Running"
        : status === "error"
          ? "Error"
          : status === "denied"
            ? "Denied"
            : "OK";
    const detKey = `${msgId}:tool:${tool.toolCallId ?? idx}`;
    const isOpen = this.detailsOpenMap.get(detKey) === true;

    return `
      <details class="chat-tool-chip status-${status}" data-chat-det-key="${escHtml(detKey)}" ${isOpen ? "open" : ""}>
        <summary class="chat-tool-summary">
          <span class="chat-tool-name"><code>${escHtml(tool.toolName)}</code></span>
          <span class="pill ${status === "error" || status === "denied" ? "blocker" : status === "running" ? "human" : "ok"}">${statusLabel}</span>
          <span class="chat-tool-sum-text">${escHtml(cleanSummaryText(tool.summary))}</span>
        </summary>
        <div class="chat-tool-body">
          ${
            tool.inputPreview
              ? `<div class="chat-tool-io">
                  <div class="chat-tool-io-lbl">Input</div>
                  <pre class="chat-tool-pre" role="region" tabindex="0" aria-label="Tool input"><code>${escHtml(tool.inputPreview)}</code></pre>
                </div>`
              : ""
          }
          ${
            tool.output
              ? `<div class="chat-tool-io">
                  <div class="chat-tool-io-lbl">Output</div>
                  <pre class="chat-tool-pre" role="region" tabindex="0" aria-label="Tool output"><code>${escHtml(tool.output)}</code></pre>
                </div>`
              : ""
          }
        </div>
      </details>
    `;
  }

  private renderTurnHtml(msg: AgentChatMessage): string {
    const timeLabel = msg.ts || msg.epoch ? fmtClock(msg.ts || msg.epoch) : "";
    const toolsHtml =
      msg.tools && msg.tools.length > 0
        ? `<div class="chat-tools-list">${msg.tools
            .map((t, idx) => this.renderToolChipHtml(t, msg.id, idx))
            .join("")}</div>`
        : "";

    if (msg.role === "user") {
      return `
        <article class="chat-turn role-user" data-chat-msg-id="${escHtml(msg.id)}">
          <div class="chat-turn-head">
            <span class="chat-turn-who">User</span>
            ${timeLabel ? `<span class="chat-turn-time">${escHtml(timeLabel)}</span>` : ""}
          </div>
          <div class="chat-turn-prose">${renderMarkdown(msg.text, { enableFileLinks: false }).html}</div>
          ${toolsHtml}
        </article>
      `;
    }

    if (msg.role === "thinking") {
      const detKey = `${msg.id}:thinking`;
      const isOpen = this.detailsOpenMap.get(detKey) === true;
      return `
        <article class="chat-turn role-thinking" data-chat-msg-id="${escHtml(msg.id)}">
          <details class="chat-thinking-details" data-chat-det-key="${escHtml(detKey)}" ${isOpen ? "open" : ""}>
            <summary class="chat-thinking-summary">
              <span>Thinking…</span>
              ${timeLabel ? `<span class="chat-turn-time">${escHtml(timeLabel)}</span>` : ""}
            </summary>
            <div class="chat-thinking-body">${renderMarkdown(msg.text || msg.thinking || "", { enableFileLinks: false }).html}</div>
          </details>
        </article>
      `;
    }

    if (msg.role === "tool") {
      const detKey = `${msg.id}:toolgrp`;
      const isOpen = this.detailsOpenMap.get(detKey) === true;
      const summaryLine =
        cleanSummaryText(msg.text) ||
        (msg.tools && msg.tools.length > 0
          ? `${msg.tools.length} tool call${msg.tools.length === 1 ? "" : "s"}`
          : "Tool execution");
      return `
        <article class="chat-turn role-tool" data-chat-msg-id="${escHtml(msg.id)}">
          <details class="chat-tools-group" data-chat-det-key="${escHtml(detKey)}" ${isOpen ? "open" : ""}>
            <summary class="chat-tools-group-summary">
              <span class="pill tool">Tools</span>
              <span class="chat-tools-group-text">${escHtml(summaryLine)}</span>
              ${timeLabel ? `<span class="chat-turn-time">${escHtml(timeLabel)}</span>` : ""}
            </summary>
            <div class="chat-tools-group-body">
              ${toolsHtml || `<div class="chat-turn-prose">${escHtml(msg.text)}</div>`}
            </div>
          </details>
        </article>
      `;
    }

    if (msg.role === "question") {
      return `
        <article class="chat-turn role-question" data-chat-msg-id="${escHtml(msg.id)}">
          <div class="chat-turn-head">
            <span class="chat-question-badge"><span aria-hidden="true">?</span> Question</span>
            ${timeLabel ? `<span class="chat-turn-time">${escHtml(timeLabel)}</span>` : ""}
          </div>
          <div class="chat-turn-prose">${renderMarkdown(msg.text, { enableFileLinks: false }).html}</div>
          ${toolsHtml}
        </article>
      `;
    }

    if (msg.role === "subagent") {
      const subId = msg.subagentId || msg.agentId;
      const subLabel =
        msg.subagentLabel || formatActorName(subId, this.labelMap);
      return `
        <article class="chat-turn role-subagent" data-chat-msg-id="${escHtml(msg.id)}">
          <div class="chat-turn-head">
            <span class="pill dispatch">Subagent Handoff</span>
            ${timeLabel ? `<span class="chat-turn-time">${escHtml(timeLabel)}</span>` : ""}
          </div>
          ${msg.text ? `<div class="chat-turn-prose">${renderMarkdown(msg.text, { enableFileLinks: false }).html}</div>` : ""}
          ${
            subId && subId !== this.currentAgentId
              ? `<button type="button" class="chat-subagent-chip" data-chat-subagent="${escHtml(subId)}">
                  <span>Open ${escHtml(subLabel)} Chat →</span>
                </button>`
              : ""
          }
          ${toolsHtml}
        </article>
      `;
    }

    // Assistant turn
    const thinkingDetKey = `${msg.id}:asst-thinking`;
    const thinkingOpen = this.detailsOpenMap.get(thinkingDetKey) === true;
    const thinkingHtml = msg.thinking
      ? `
        <details class="chat-thinking-details" data-chat-det-key="${escHtml(thinkingDetKey)}" ${thinkingOpen ? "open" : ""}>
          <summary class="chat-thinking-summary">Thinking…</summary>
          <div class="chat-thinking-body">${renderMarkdown(msg.thinking, { enableFileLinks: false }).html}</div>
        </details>
      `
      : "";

    return `
      <article class="chat-turn role-assistant" data-chat-msg-id="${escHtml(msg.id)}">
        <div class="chat-turn-head">
          <span class="chat-turn-who">${escHtml(formatActorName(msg.agentId, this.labelMap, this.currentAgent?.label))}</span>
          ${timeLabel ? `<span class="chat-turn-time">${escHtml(timeLabel)}</span>` : ""}
        </div>
        ${thinkingHtml}
        ${msg.text ? `<div class="chat-turn-prose">${renderMarkdown(msg.text, { enableFileLinks: false }).html}</div>` : ""}
        ${toolsHtml}
      </article>
    `;
  }

  private renderBody(preserveScrollExplicit = false): void {
    if (this.loading) {
      this.bodyEl.innerHTML = `
        <div class="chat-skeleton-list" aria-busy="true" aria-label="Loading conversation">
          <div class="chat-skeleton-card is-right"></div>
          <div class="chat-skeleton-card"></div>
          <div class="chat-skeleton-card is-short"></div>
        </div>
      `;
      this.liveAnnouncerEl.textContent = "Loading agent conversation.";
      return;
    }

    if (this.loadError && this.messages.length === 0) {
      this.bodyEl.innerHTML = `
        <div class="chat-empty-state">
          <div class="chat-empty-title">Could not load conversation</div>
          <p class="muted">${escHtml(this.loadError)}</p>
          <div class="chat-empty-actions">
            <button type="button" class="btn-primary btn-sm" data-chat-retry>Retry</button>
            <button type="button" class="btn-secondary btn-sm" data-chat-open-inspector>Open Raw Inspector</button>
          </div>
        </div>
      `;
      return;
    }

    if (this.messages.length === 0) {
      this.bodyEl.innerHTML = `
        <div class="chat-empty-state">
          <div class="chat-empty-title">No conversation turns recorded for this agent yet</div>
          <p class="muted">Tool calls or transcript messages will appear here as telemetry updates.</p>
          <button type="button" class="btn-secondary btn-sm" data-chat-open-inspector>Open Raw Inspector</button>
        </div>
      `;
      return;
    }

    const renderKey = JSON.stringify({
      id: this.currentAgentId,
      hasMore: this.hasMore,
      nextCursor: this.nextCursor,
      msgs: this.messages.map((m) => `${m.id}:${m.text.length}:${m.tools?.length ?? 0}:${m.thinking?.length ?? 0}`),
    });

    if (renderKey === this.lastRenderedMsgsKey) {
      return;
    }
    this.lastRenderedMsgsKey = renderKey;

    const prevScrollTop = this.bodyEl.scrollTop;
    const wasNearBottom = this.isNearBottom;

    const html = `
      ${
        this.hasMore
          ? `<div class="chat-load-more-wrap">
              <button type="button" class="btn-secondary btn-sm" data-chat-load-more>Load earlier messages</button>
            </div>`
          : ""
      }
      <div class="chat-turns-list">
        ${this.messages.map((m) => this.renderTurnHtml(m)).join("")}
      </div>
    `;

    this.bodyEl.innerHTML = html;

    if (preserveScrollExplicit) {
      return;
    }

    if (wasNearBottom) {
      window.requestAnimationFrame(() => {
        this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
        this.isNearBottom = true;
        this.unseenCount = 0;
        this.syncJumpLatestBtn();
      });
    } else {
      this.bodyEl.scrollTop = prevScrollTop;
      this.syncJumpLatestBtn();
    }
  }
}
