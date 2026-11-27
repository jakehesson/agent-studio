import { fetchAgentChat } from "../api.js";
import type {
  AgentChatMessage,
  AgentChatResponse,
  AgentNodeSnapshot,
  ChatToolCallRef,
  ConnectionState,
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
  copyTextSafe,
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

export type AgentChatPaneMode = "drawer" | "panel";

export interface ChatSessionContext {
  sessionId?: string;
  ide?: string;
  project?: string;
  workspace?: string;
}

export interface AgentChatPaneOptions {
  mode: AgentChatPaneMode;
  headingId?: string;
  embedMode?: boolean;
  mcpAppMode?: boolean;
  getSessionContext: () => ChatSessionContext;
  getReplyCapabilities: () => ReplyCapabilities;
  onReplyToHost: (req: ReplyToHostRequest) => Promise<ReplyToHostResult>;
  onCancelPrompt?: (promptId: string, reason?: string) => Promise<ReplyToHostResult>;
  onOpenInspector?: (agentId: string) => void;
  onSwitchAgent?: (agentId: string, label?: string) => void;
  onClose?: () => void;
  onToggleWide?: () => boolean;
  onReconnect?: () => void;
}

export interface OpenAgentChatPaneParams {
  sessionId?: string;
  agent: AgentNodeSnapshot;
  labelMap?: Map<string, string>;
  definition?: TeamDefinitionEntry;
  focusQuestion?: boolean;
}

export interface OpenChatTabPayload {
  type: "agentStudio:openChatTab";
  sessionId: string;
  agentId: string;
  agentLabel: string;
  ide: string;
  focusQuestion: boolean;
}

export interface ChatViewRouteParams {
  view: string;
  isChatView: boolean;
  session: string;
  agent: string;
  focusQuestion: boolean;
  embed: boolean;
  ide: string;
  workspace: string;
  project: string;
}

export function shouldRouteChatToHostTab(opts: {
  embedMode: boolean;
  mcpAppMode?: boolean;
  hasParent: boolean;
}): boolean {
  return Boolean(opts.embedMode && !opts.mcpAppMode && opts.hasParent);
}

export function buildOpenChatTabPayload(opts: {
  sessionId: string;
  agentId: string;
  agentLabel?: string;
  ide?: string;
  focusQuestion?: boolean;
}): OpenChatTabPayload {
  return {
    type: "agentStudio:openChatTab",
    sessionId: (opts.sessionId ?? "").trim(),
    agentId: (opts.agentId ?? "").trim(),
    agentLabel: (opts.agentLabel ?? "").trim() || (opts.agentId ?? "").trim() || "Agent",
    ide: (opts.ide ?? "").trim() || "unknown",
    focusQuestion: opts.focusQuestion === true,
  };
}

export function parseChatViewRouteParams(search: string): ChatViewRouteParams {
  const raw = (search ?? "").trim();
  const normalized = raw.startsWith("?") ? raw.slice(1) : raw;
  const sp = new URLSearchParams(normalized);
  const view = (sp.get("view") ?? "").trim();
  const focusRaw = (sp.get("focusQuestion") ?? "").trim().toLowerCase();
  const embedRaw = (sp.get("embed") ?? "").trim().toLowerCase();
  return {
    view,
    isChatView: view.toLowerCase() === "chat",
    session: (sp.get("session") ?? "").trim(),
    agent: (sp.get("agent") ?? "").trim(),
    focusQuestion: focusRaw === "1" || focusRaw === "true",
    embed: embedRaw === "1" || embedRaw === "true",
    ide: (sp.get("ide") ?? "").trim(),
    workspace: (sp.get("workspace") ?? "").trim(),
    project: (sp.get("project") ?? "").trim(),
  };
}

export function filterChatMessages(
  messages: AgentChatMessage[],
  query: string
): AgentChatMessage[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return messages;
  return messages.filter((msg) => {
    if (msg.text && msg.text.toLowerCase().includes(q)) return true;
    if (msg.thinking && msg.thinking.toLowerCase().includes(q)) return true;
    if (msg.subagentLabel && msg.subagentLabel.toLowerCase().includes(q)) return true;
    if (msg.subagentId && msg.subagentId.toLowerCase().includes(q)) return true;
    if (msg.tools && msg.tools.length > 0) {
      return msg.tools.some(
        (t) =>
          t.toolName.toLowerCase().includes(q) ||
          t.summary.toLowerCase().includes(q) ||
          (t.inputPreview ? t.inputPreview.toLowerCase().includes(q) : false) ||
          (t.output ? t.output.toLowerCase().includes(q) : false)
      );
    }
    return false;
  });
}

export function decodeFileUriToPath(uri: string): string {
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

export interface OpenFileMessage {
  type: "agentStudio.openFile";
  uri: string;
  startLine?: number;
  endLine?: number;
}

export function buildOpenFileMessage(opts: {
  uri: string;
  startLine?: number;
  endLine?: number;
}): OpenFileMessage {
  return {
    type: "agentStudio.openFile",
    uri: opts.uri,
    ...(typeof opts.startLine === "number" && Number.isFinite(opts.startLine)
      ? { startLine: opts.startLine }
      : {}),
    ...(typeof opts.endLine === "number" && Number.isFinite(opts.endLine)
      ? { endLine: opts.endLine }
      : {}),
  };
}

export function shouldAcceptChatSnapshot(opts: {
  pinnedSessionId: string;
  snapshotSessionId?: string | null;
}): boolean {
  const pinned = (opts.pinnedSessionId ?? "").trim();
  const snapId = (opts.snapshotSessionId ?? "").trim();
  return Boolean(pinned && snapId && snapId === pinned);
}

export function isChatFetchCurrent(opts: {
  seq: number;
  currentSeq: number;
  active: boolean;
}): boolean {
  return opts.active && opts.seq === opts.currentSeq;
}

const LIVE_REFRESH_DEBOUNCE_MS = 350;
const INITIAL_LIMIT = 60;

export class AgentChatPane {
  private container: HTMLElement;
  private opts: AgentChatPaneOptions;
  private shellEl: HTMLElement;
  private accentBarEl: HTMLElement;
  private titleEl: HTMLElement;
  private metaRowEl: HTMLElement;
  private headerBadgesEl: HTMLElement;
  private jumpQuestionBtn: HTMLButtonElement;
  private focusIdeBtn: HTMLButtonElement;
  private wideToggleBtn: HTMLButtonElement | null;
  private closeBtn: HTMLButtonElement | null;
  private searchInput: HTMLInputElement;
  private searchClearBtn: HTMLButtonElement;
  private filterCountEl: HTMLElement;
  private focusFeedbackEl: HTMLElement;
  private connPillEl: HTMLButtonElement;
  private connLabelEl: HTMLElement;
  private bodyEl: HTMLElement;
  private jumpLatestBtn: HTMLButtonElement;
  private promptDockEl: HTMLElement;
  private promptToggleBtn: HTMLButtonElement;
  private promptTitleSummaryEl: HTMLElement;
  private promptCardMountEl: HTMLElement;
  private liveAnnouncerEl: HTMLElement;

  private embedMode: boolean;
  private mcpAppMode: boolean;
  private connectionState: ConnectionState | "idle" = "live";
  private active = false;
  private isWide = false;
  private promptCollapsed = false;
  private currentSessionId = "";
  private currentAgentId: string | null = null;
  private currentAgent: AgentNodeSnapshot | null = null;
  private currentDefinition: TeamDefinitionEntry | undefined = undefined;
  private labelMap: Map<string, string> = new Map();

  private loading = false;
  private loadingMore = false;
  private loadError = "";
  private emptyContextTitle = "";
  private emptyContextBody = "";
  private searchQuery = "";
  private messages: AgentChatMessage[] = [];
  private totalMessages = 0;
  private hasMore = false;
  private nextCursor: string | undefined = undefined;
  private fetchedPendingPrompt: PendingHumanPrompt | null = null;

  private isNearBottom = true;
  private unseenCount = 0;
  private openSeq = 0;
  private refreshTimer: number | null = null;
  private focusFeedbackTimer: number | null = null;
  private pendingFocusRequestId: string | null = null;
  private pendingFocusTimer: number | null = null;
  private onWindowMessage: (e: MessageEvent) => void;
  private lastAgentSignature = "";
  private lastRenderedMsgsKey = "";
  private detailsOpenMap = new Map<string, boolean>();
  private questionCard: QuestionCard | null = null;

  constructor(container: HTMLElement, opts: AgentChatPaneOptions) {
    this.container = container;
    this.opts = opts;
    this.embedMode = Boolean(opts.embedMode);
    this.mcpAppMode = Boolean(opts.mcpAppMode);
    const headingId =
      opts.headingId ?? (opts.mode === "panel" ? "chatPanelTitle" : "chatDrawerTitle");

    const isDrawer = opts.mode === "drawer";
    const shell = document.createElement("div");
    shell.className = isDrawer
      ? "chat-drawer-shell chat-pane-shell"
      : "chat-drawer-shell chat-pane-shell chat-tab-shell";
    shell.setAttribute("data-chat-mode", opts.mode);
    shell.innerHTML = `
      <div class="chat-drawer-accent" data-chat-accent aria-hidden="true"></div>
      <header class="chat-drawer-head">
        <div class="chat-head-main">
          <div class="chat-title-row">
            <h1 id="${escHtml(headingId)}" class="chat-drawer-title" data-chat-title>Agent Chat</h1>
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
            class="copy-btn chat-focus-ide-btn"
            data-chat-focus-ide
            hidden
            title="Focus IDE chat panel"
          >Focus IDE Chat</button>
          ${
            isDrawer
              ? `<button
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
                >✕</button>`
              : ""
          }
        </div>
      </header>

      <div class="chat-controls-bar" role="toolbar" aria-label="Conversation filters and status">
        <div class="chat-search-wrap">
          <input
            type="search"
            class="chat-search-input"
            data-chat-search
            placeholder="Filter turns, tools…"
            aria-label="Filter conversation turns"
          />
          <button
            type="button"
            class="chat-search-clear"
            data-chat-search-clear
            aria-label="Clear filter"
            hidden
          >✕</button>
        </div>
        <span class="chat-filter-count muted" data-chat-filter-count hidden></span>
        <span class="chat-focus-feedback" data-chat-focus-feedback hidden></span>
        <button
          type="button"
          class="sse-pill chat-conn-pill is-live"
          data-chat-conn-pill
          aria-live="polite"
          aria-label="Connection status: Live"
          title="Live conversation updates"
        >
          <span class="sse-dot" aria-hidden="true"></span>
          <span data-chat-conn-label>Live</span>
        </button>
      </div>

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
    `;

    this.container.appendChild(shell);
    this.shellEl = shell;

    this.accentBarEl = shell.querySelector("[data-chat-accent]") as HTMLElement;
    this.titleEl = shell.querySelector("[data-chat-title]") as HTMLElement;
    this.headerBadgesEl = shell.querySelector("[data-chat-badges]") as HTMLElement;
    this.metaRowEl = shell.querySelector("[data-chat-meta]") as HTMLElement;
    this.jumpQuestionBtn = shell.querySelector("[data-chat-jump-q]") as HTMLButtonElement;
    this.focusIdeBtn = shell.querySelector("[data-chat-focus-ide]") as HTMLButtonElement;
    this.wideToggleBtn = shell.querySelector("[data-chat-wide]");
    this.closeBtn = shell.querySelector("[data-chat-close]");
    this.searchInput = shell.querySelector("[data-chat-search]") as HTMLInputElement;
    this.searchClearBtn = shell.querySelector("[data-chat-search-clear]") as HTMLButtonElement;
    this.filterCountEl = shell.querySelector("[data-chat-filter-count]") as HTMLElement;
    this.focusFeedbackEl = shell.querySelector("[data-chat-focus-feedback]") as HTMLElement;
    this.connPillEl = shell.querySelector("[data-chat-conn-pill]") as HTMLButtonElement;
    this.connLabelEl = shell.querySelector("[data-chat-conn-label]") as HTMLElement;
    this.bodyEl = shell.querySelector("[data-chat-body]") as HTMLElement;
    this.jumpLatestBtn = shell.querySelector("[data-chat-jump-latest]") as HTMLButtonElement;
    this.promptDockEl = shell.querySelector("[data-chat-prompt-dock]") as HTMLElement;
    this.promptToggleBtn = shell.querySelector("[data-chat-prompt-toggle]") as HTMLButtonElement;
    this.promptTitleSummaryEl = shell.querySelector("[data-chat-prompt-title]") as HTMLElement;
    this.promptCardMountEl = shell.querySelector("[data-chat-prompt-mount]") as HTMLElement;
    this.liveAnnouncerEl = shell.querySelector("[data-chat-live]") as HTMLElement;

    this.onWindowMessage = (event: MessageEvent) => {
      if (typeof window === "undefined" || window.parent === window || event.source !== window.parent) {
        return;
      }
      const data = event.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      const rec = data as Record<string, unknown>;
      if (rec.type === "agentStudio:focusIdeChatResult") {
        this.handleFocusIdeChatResult(rec);
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("message", this.onWindowMessage);
    }

    this.bindEvents();
    this.syncFocusIdeButtonVisibility();
    this.setConnectionState(this.connectionState);
  }

  private canPostToHostParent(): boolean {
    return shouldRouteChatToHostTab({
      embedMode: this.embedMode,
      mcpAppMode: this.mcpAppMode,
      hasParent: typeof window !== "undefined" && window.parent !== window,
    });
  }

  private syncFocusIdeButtonVisibility(): void {
    this.focusIdeBtn.hidden = !this.canPostToHostParent();
  }

  private bindEvents(): void {
    this.closeBtn?.addEventListener("click", () => {
      this.opts.onClose?.();
    });

    this.wideToggleBtn?.addEventListener("click", () => {
      this.isWide = this.opts.onToggleWide ? this.opts.onToggleWide() : !this.isWide;
      this.wideToggleBtn?.setAttribute("aria-pressed", this.isWide ? "true" : "false");
    });

    this.jumpQuestionBtn.addEventListener("click", () => {
      this.expandAndFocusQuestion();
    });

    this.focusIdeBtn.addEventListener("click", () => {
      this.requestFocusIdeChat();
    });

    this.connPillEl.addEventListener("click", () => {
      if (this.connectionState !== "live") {
        this.opts.onReconnect?.();
      }
    });

    this.promptToggleBtn.addEventListener("click", () => {
      this.promptCollapsed = !this.promptCollapsed;
      this.syncPromptDockVisibility();
    });

    this.searchInput.addEventListener("input", () => {
      this.searchQuery = this.searchInput.value;
      this.searchClearBtn.hidden = this.searchQuery.trim().length === 0;
      this.lastRenderedMsgsKey = "";
      this.renderBody(true);
    });

    this.searchClearBtn.addEventListener("click", () => {
      this.clearSearchFilter();
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

      const codeCopyBtn = target.closest<HTMLButtonElement>("[data-code-copy]");
      if (codeCopyBtn) {
        const block = codeCopyBtn.closest(".reader-code-block");
        const codeEl = block?.querySelector("code");
        const codeText = codeEl?.textContent ?? "";
        void this.handleCopyButton(
          codeCopyBtn,
          codeText,
          "Copy",
          "Copied code snippet to clipboard"
        );
        return;
      }

      const fileChip = target.closest<HTMLButtonElement>(".reader-file-chip");
      if (fileChip) {
        void this.handleFileChipClick(fileChip);
        return;
      }

      if (target.closest("[data-chat-clear-filter]")) {
        this.clearSearchFilter();
        return;
      }

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
        this.opts.onClose?.();
        if (aid) this.opts.onOpenInspector?.(aid);
        return;
      }

      const subBtn = target.closest<HTMLButtonElement>("[data-chat-subagent]");
      if (subBtn) {
        const subId = subBtn.dataset.chatSubagent;
        const subLabel = subBtn.dataset.chatSubagentLabel;
        if (subId) {
          this.opts.onSwitchAgent?.(subId, subLabel);
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

  private clearSearchFilter(): void {
    this.searchQuery = "";
    this.searchInput.value = "";
    this.searchClearBtn.hidden = true;
    this.lastRenderedMsgsKey = "";
    this.renderBody(true);
    this.searchInput.focus();
  }

  private requestFocusIdeChat(): void {
    if (!this.canPostToHostParent()) return;
    const requestId = `focus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pendingFocusRequestId = requestId;
    if (this.pendingFocusTimer != null) {
      window.clearTimeout(this.pendingFocusTimer);
    }
    this.pendingFocusTimer = window.setTimeout(() => {
      if (this.pendingFocusRequestId === requestId) {
        this.pendingFocusRequestId = null;
        this.pendingFocusTimer = null;
        this.showFocusFeedback("IDE chat did not respond.", false);
      }
    }, 4000);

    this.showFocusFeedback("Focusing IDE Chat…", true, 0);
    window.parent.postMessage(
      {
        type: "agentStudio:focusIdeChat",
        requestId,
      },
      "*"
    );
  }

  public handleFocusIdeChatResult(rec: Record<string, unknown>): void {
    const reqId = typeof rec.requestId === "string" ? rec.requestId : "";
    if (!this.pendingFocusRequestId || (reqId && reqId !== this.pendingFocusRequestId)) {
      return;
    }
    this.pendingFocusRequestId = null;
    if (this.pendingFocusTimer != null) {
      window.clearTimeout(this.pendingFocusTimer);
      this.pendingFocusTimer = null;
    }
    const ok = Boolean(rec.ok);
    const msg =
      typeof rec.message === "string" && rec.message.trim()
        ? rec.message.trim()
        : ok
          ? "Focused IDE Chat"
          : "Could not focus IDE Chat";
    this.showFocusFeedback(msg, ok);
  }

  private showFocusFeedback(message: string, ok: boolean, autoHideMs = 2600): void {
    if (this.focusFeedbackTimer != null) {
      window.clearTimeout(this.focusFeedbackTimer);
      this.focusFeedbackTimer = null;
    }
    this.focusFeedbackEl.textContent = message;
    this.focusFeedbackEl.classList.toggle("is-err", !ok);
    this.focusFeedbackEl.hidden = false;
    this.announce(message);
    if (autoHideMs > 0) {
      this.focusFeedbackTimer = window.setTimeout(() => {
        this.focusFeedbackTimer = null;
        this.focusFeedbackEl.hidden = true;
        this.focusFeedbackEl.textContent = "";
      }, autoHideMs);
    }
  }

  private announce(msg: string): void {
    this.liveAnnouncerEl.textContent = "";
    window.setTimeout(() => {
      this.liveAnnouncerEl.textContent = msg;
    }, 20);
  }

  private async handleCopyButton(
    btn: HTMLButtonElement,
    text: string,
    defaultLabel: string,
    srAnnouncement: string
  ): Promise<void> {
    if (!text) return;
    const ok = await copyTextSafe(text);
    btn.textContent = ok ? "Copied ✓" : "Copy failed";
    btn.classList.toggle("copied", ok);
    if (ok) this.announce(srAnnouncement);
    window.setTimeout(() => {
      btn.textContent = defaultLabel;
      btn.classList.remove("copied");
    }, 1600);
  }

  private async handleFileChipClick(chip: HTMLButtonElement): Promise<void> {
    const uri = chip.dataset.fileUri ?? "";
    if (!uri) return;
    const startLineRaw = chip.dataset.startLine;
    const endLineRaw = chip.dataset.endLine;
    const startLine = startLineRaw ? Number.parseInt(startLineRaw, 10) : undefined;
    const endLine = endLineRaw ? Number.parseInt(endLineRaw, 10) : undefined;

    const originalHtml = chip.dataset.origHtml ?? chip.innerHTML;
    chip.dataset.origHtml = originalHtml;

    if (this.canPostToHostParent()) {
      window.parent.postMessage(
        buildOpenFileMessage({
          uri,
          startLine,
          endLine,
        }),
        "*"
      );
      chip.classList.add("is-feedback");
      chip.textContent = "Opened beside ✓";
      this.announce("Opened file beside in editor");
      window.setTimeout(() => {
        chip.classList.remove("is-feedback");
        chip.innerHTML = originalHtml;
      }, 1600);
      return;
    }

    const decodedPath = decodeFileUriToPath(uri);
    const ok = await copyTextSafe(decodedPath);
    chip.classList.toggle("is-feedback", ok);
    chip.textContent = ok ? "Copied path ✓" : "Copy failed";
    if (ok) this.announce("Copied file path to clipboard");
    window.setTimeout(() => {
      chip.classList.remove("is-feedback");
      chip.innerHTML = originalHtml;
    }, 1600);
  }

  public setRuntimeScope(scope: { embedMode?: boolean; mcpAppMode?: boolean }): void {
    if (typeof scope.embedMode === "boolean") this.embedMode = scope.embedMode;
    if (typeof scope.mcpAppMode === "boolean") this.mcpAppMode = scope.mcpAppMode;
    this.syncFocusIdeButtonVisibility();
  }

  public setConnectionState(
    status: ConnectionState | "idle",
    labelOverride?: string
  ): void {
    this.connectionState = status;
    this.connPillEl.classList.remove("is-live", "is-reconnecting", "is-offline", "is-idle");
    let label = labelOverride || "Live";
    if (status === "live") {
      this.connPillEl.classList.add("is-live");
      label = labelOverride || "Live";
    } else if (status === "reconnecting" || status === "connecting") {
      this.connPillEl.classList.add("is-reconnecting");
      label = labelOverride || (status === "connecting" ? "Connecting" : "Reconnecting");
    } else if (status === "idle") {
      this.connPillEl.classList.add("is-idle");
      label = labelOverride || "No session";
    } else {
      this.connPillEl.classList.add("is-offline");
      label = labelOverride || "Offline";
    }
    this.connLabelEl.textContent = label;
    this.connPillEl.setAttribute("aria-label", `Connection status: ${label}`);
  }

  public destroy(): void {
    this.dispose();
  }

  public dispose(): void {
    this.reset();
    if (typeof window !== "undefined") {
      window.removeEventListener("message", this.onWindowMessage);
    }
    if (this.focusFeedbackTimer != null) {
      window.clearTimeout(this.focusFeedbackTimer);
      this.focusFeedbackTimer = null;
    }
    if (this.pendingFocusTimer != null) {
      window.clearTimeout(this.pendingFocusTimer);
      this.pendingFocusTimer = null;
    }
    this.questionCard?.dispose();
    this.questionCard = null;
    this.shellEl.remove();
  }

  public reset(): void {
    this.active = false;
    this.loadingMore = false;
    this.openSeq += 1;
    if (this.refreshTimer != null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  public getCurrentAgentId(): string | null {
    return this.active ? this.currentAgentId : null;
  }

  public getCurrentSessionId(): string {
    return this.currentSessionId;
  }

  public renderEmptyContext(
    title = "No agent conversation selected",
    subtitle = "Select an agent from Live Studio to open its conversation here."
  ): void {
    this.active = false;
    this.openSeq += 1;
    this.currentSessionId = "";
    this.currentAgentId = null;
    this.currentAgent = null;
    this.currentDefinition = undefined;
    this.loading = false;
    this.loadingMore = false;
    this.loadError = "";
    this.emptyContextTitle = title;
    this.emptyContextBody = subtitle;
    this.messages = [];
    this.totalMessages = 0;
    this.hasMore = false;
    this.nextCursor = undefined;
    this.fetchedPendingPrompt = null;
    this.lastRenderedMsgsKey = "";

    this.titleEl.textContent = "Agent Chat";
    this.headerBadgesEl.innerHTML = "";
    this.metaRowEl.innerHTML = "";
    this.accentBarEl.style.background = "";
    this.shellEl.style.removeProperty("--chat-accent");
    this.jumpQuestionBtn.hidden = true;
    this.searchInput.value = "";
    this.searchQuery = "";
    this.searchInput.disabled = true;
    this.searchClearBtn.hidden = true;
    this.renderPendingPromptDock();
    this.renderBody();
  }

  public openAgent(params: OpenAgentChatPaneParams): void {
    const ctxSession = (params.sessionId ?? this.opts.getSessionContext().sessionId ?? "").trim();
    const switchingTarget =
      this.currentAgentId !== params.agent.id ||
      this.currentSessionId !== ctxSession ||
      !this.active;

    this.active = true;
    this.searchInput.disabled = false;
    this.emptyContextTitle = "";
    this.emptyContextBody = "";
    this.currentSessionId = ctxSession;
    this.currentAgent = params.agent;
    this.currentAgentId = params.agent.id;
    this.currentDefinition = params.definition;
    if (params.labelMap) this.labelMap = params.labelMap;

    if (switchingTarget) {
      this.openSeq += 1;
      if (this.refreshTimer != null) {
        window.clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
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
      this.searchQuery = "";
      this.searchInput.value = "";
      this.searchClearBtn.hidden = true;
      this.filterCountEl.hidden = true;
      this.syncJumpLatestBtn();
    } else {
      this.loadingMore = false;
    }

    this.lastAgentSignature = this.computeAgentSignature(params.agent, this.currentSessionId);
    this.renderHeader();
    this.renderPendingPromptDock();

    void this.fetchAndRender(switchingTarget, Boolean(params.focusQuestion));
  }

  public notifySnapshot(
    snapshot: SessionSnapshot,
    mergedAgents: AgentNodeSnapshot[],
    labelMap?: Map<string, string>,
    definitions?: TeamDefinitionEntry[]
  ): void {
    if (!this.active || !this.currentAgentId) return;
    if (this.currentSessionId && snapshot.sessionId && snapshot.sessionId !== this.currentSessionId) {
      return;
    }
    if (labelMap) this.labelMap = labelMap;

    const latest =
      mergedAgents.find((a) => a.id === this.currentAgentId) ??
      snapshot.agents.find((a) => a.id === this.currentAgentId);
    if (!latest) return;

    if (definitions && definitions.length > 0 && !this.currentDefinition) {
      const def = definitions.find((d) => d.id === latest.id || d.name === latest.label);
      if (def) this.currentDefinition = def;
    }

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
        if (this.active && this.currentAgentId) {
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
    this.shellEl.style.setProperty("--chat-accent", accent);

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
    const sessionId = this.currentSessionId || ctx.sessionId;
    if (this.questionCard && this.questionCard.getPromptId() === prompt.id) {
      this.questionCard.update({
        prompt,
        sessionId,
        compact: true,
        showHeader: false,
        onCancel: this.opts.onCancelPrompt,
      });
    } else {
      this.questionCard?.dispose();
      this.questionCard = new QuestionCard(this.promptCardMountEl, {
        prompt,
        sessionId,
        compact: true,
        showHeader: false,
        getCapabilities: this.opts.getReplyCapabilities,
        onReply: this.opts.onReplyToHost,
        onCancel: this.opts.onCancelPrompt,
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
    const sessionId = this.currentSessionId || ctx.sessionId;

    if (showSkeleton && this.messages.length === 0) {
      this.loading = true;
      this.loadError = "";
      this.syncJumpLatestBtn();
      this.renderBody();
    }

    try {
      const res: AgentChatResponse = await fetchAgentChat({
        session: sessionId,
        agent: this.currentAgentId,
        ide: this.currentAgent?.ide || ctx.ide,
        project: ctx.project,
        workspace: ctx.workspace,
        limit: INITIAL_LIMIT,
      });
      if (!isChatFetchCurrent({ seq, currentSeq: this.openSeq, active: this.active })) return;

      const prevTotal = this.totalMessages;
      this.loading = false;
      this.loadError = "";
      this.messages = res.messages;
      this.totalMessages = res.totalMessages;
      this.hasMore = res.hasMore;
      this.nextCursor = res.nextCursor;
      this.fetchedPendingPrompt = res.pendingPrompt;

      if (res.agentLabel && this.currentAgent && this.currentAgent.label === this.currentAgent.id) {
        this.currentAgent = { ...this.currentAgent, label: res.agentLabel };
      }

      if (!this.isNearBottom && res.totalMessages > prevTotal) {
        this.unseenCount += res.totalMessages - prevTotal;
      } else if (this.isNearBottom) {
        this.unseenCount = 0;
      }

      this.renderHeader();
      this.renderPendingPromptDock();
      this.renderBody();

      if (focusQuestionAfter && this.getEffectivePendingPrompt()) {
        window.requestAnimationFrame(() => {
          if (isChatFetchCurrent({ seq, currentSeq: this.openSeq, active: this.active })) {
            this.expandAndFocusQuestion();
          }
        });
      }
    } catch (err) {
      if (!isChatFetchCurrent({ seq, currentSeq: this.openSeq, active: this.active })) return;
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
    const sessionId = this.currentSessionId || ctx.sessionId;
    this.loadingMore = true;
    const btn = this.bodyEl.querySelector<HTMLButtonElement>("[data-chat-load-more]");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Loading earlier…";
    }

    try {
      const res = await fetchAgentChat({
        session: sessionId,
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
          <div class="chat-turn-prose">${renderMarkdown(msg.text, { enableFileLinks: true }).html}</div>
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
            <div class="chat-thinking-body">${renderMarkdown(msg.text || msg.thinking || "", { enableFileLinks: true }).html}</div>
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
          <div class="chat-turn-prose">${renderMarkdown(msg.text, { enableFileLinks: true }).html}</div>
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
          ${msg.text ? `<div class="chat-turn-prose">${renderMarkdown(msg.text, { enableFileLinks: true }).html}</div>` : ""}
          ${
            subId && subId !== this.currentAgentId
              ? `<button type="button" class="chat-subagent-chip" data-chat-subagent="${escHtml(subId)}" data-chat-subagent-label="${escHtml(subLabel)}">
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
          <div class="chat-thinking-body">${renderMarkdown(msg.thinking, { enableFileLinks: true }).html}</div>
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
        ${msg.text ? `<div class="chat-turn-prose">${renderMarkdown(msg.text, { enableFileLinks: true }).html}</div>` : ""}
        ${toolsHtml}
      </article>
    `;
  }

  private renderBody(preserveScrollExplicit = false): void {
    if (!this.currentAgentId && this.emptyContextTitle) {
      this.filterCountEl.hidden = true;
      this.bodyEl.innerHTML = `
        <div class="chat-empty-state">
          <div class="chat-empty-title">${escHtml(this.emptyContextTitle)}</div>
          <p class="muted">${escHtml(this.emptyContextBody)}</p>
        </div>
      `;
      return;
    }

    if (this.loading) {
      this.filterCountEl.hidden = true;
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
      this.filterCountEl.hidden = true;
      this.bodyEl.innerHTML = `
        <div class="chat-empty-state">
          <div class="chat-empty-title">Could not load conversation</div>
          <p class="muted">${escHtml(this.loadError)}</p>
          <div class="chat-empty-actions">
            <button type="button" class="btn-primary btn-sm" data-chat-retry>Retry</button>
            ${
              this.opts.onOpenInspector
                ? `<button type="button" class="btn-secondary btn-sm" data-chat-open-inspector>Open Raw Inspector</button>`
                : ""
            }
          </div>
        </div>
      `;
      return;
    }

    if (this.messages.length === 0) {
      this.filterCountEl.hidden = true;
      this.bodyEl.innerHTML = `
        <div class="chat-empty-state">
          <div class="chat-empty-title">No conversation turns recorded for this agent yet</div>
          <p class="muted">Tool calls or transcript messages will appear here as telemetry updates.</p>
          ${
            this.opts.onOpenInspector
              ? `<button type="button" class="btn-secondary btn-sm" data-chat-open-inspector>Open Raw Inspector</button>`
              : ""
          }
        </div>
      `;
      return;
    }

    const query = this.searchQuery.trim();
    const visibleMessages = filterChatMessages(this.messages, query);

    if (query) {
      this.filterCountEl.hidden = false;
      this.filterCountEl.textContent = `${visibleMessages.length} / ${this.messages.length}`;
    } else {
      this.filterCountEl.hidden = true;
    }

    const renderKey = JSON.stringify({
      session: this.currentSessionId,
      id: this.currentAgentId,
      query,
      hasMore: this.hasMore,
      nextCursor: this.nextCursor,
      msgs: visibleMessages.map(
        (m) => `${m.id}:${m.text.length}:${m.tools?.length ?? 0}:${m.thinking?.length ?? 0}`
      ),
    });

    if (renderKey === this.lastRenderedMsgsKey) {
      return;
    }
    this.lastRenderedMsgsKey = renderKey;

    if (query && visibleMessages.length === 0) {
      this.bodyEl.innerHTML = `
        <div class="chat-empty-state">
          <div class="chat-empty-title">No matching turns</div>
          <p class="muted">No conversation turns matched “${escHtml(query)}”.</p>
          <button type="button" class="btn-secondary btn-sm" data-chat-clear-filter>Clear filter</button>
        </div>
      `;
      return;
    }

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
        ${visibleMessages.map((m) => this.renderTurnHtml(m)).join("")}
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
