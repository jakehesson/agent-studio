import { fetchEventBody } from "../api.js";
import {
  extractSmsStreamWithMeta,
  type SmsMessageItem,
  type SmsStreamEntry,
  type TeamAgentCluster,
  type ThreadSelection,
} from "../state/topologyGrouping.js";
import type {
  AgentNodeSnapshot,
  NormalizedEvent,
  PendingHumanPrompt,
  ReplyCapabilities,
  ReplyToHostRequest,
  ReplyToHostResult,
  SessionUsageSummary,
} from "../types.js";
import {
  classifyEventReadable,
  cleanSummaryText,
  copyTextSafe,
  escHtml,
  fmtClock,
  fmtTokens,
  formatActorName,
  getIdeMeta,
  isErrorEvent,
  isRoutineToolEnd,
  truncateWords,
} from "../utils.js";
import { renderMarkdown } from "../utils/markdown.js";
import { QuestionCard } from "./QuestionCard.js";
import { UsageDashboard } from "./UsageDashboard.js";

export type FeedFilter = "all" | "messages" | "board" | "errors" | "usage";
export type FeedMode = "summary" | "detailed";

const FEED_MODE_STORAGE_KEY = "agent-studio:feed-mode";
const FEED_FILTER_STORAGE_KEY = "agent-studio:feed-filter";
const SMS_RAW_TOOLS_STORAGE_KEY = "agent-studio:sms-raw-tools";

const ALL_THREAD: ThreadSelection = {
  key: "all",
  kind: "all",
  label: "All Session Messages",
  route: "All Session Messages",
};

export interface FeedSessionContext {
  sessionId?: string;
  ide?: string;
  project?: string;
  workspace?: string;
}

export interface ActivityFeedCallbacks {
  onSelectEvent: (event: NormalizedEvent) => void;
  onSelectAgent?: (agentId: string) => void;
  onOpenReader?: (event: NormalizedEvent) => void;
  onOpenBehind?: (
    entry: SmsMessageItem,
    allWithBehind: SmsMessageItem[],
    triggerEl: HTMLElement
  ) => void;
  onThreadChange?: (threadKey: string | null) => void;
  onFilterChange?: (filter: FeedFilter) => void;
  onCoverBackToTopology?: () => void;
  embedMode?: boolean;
  mcpAppMode?: boolean;
  getSessionContext?: () => FeedSessionContext;
  getReplyCapabilities?: () => ReplyCapabilities;
  onReplyToHost?: (req: ReplyToHostRequest) => Promise<ReplyToHostResult>;
  onCancelPrompt?: (promptId: string, reason?: string) => Promise<ReplyToHostResult>;
}

const FILTER_TABS: Array<{ id: FeedFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "messages", label: "Messages" },
  { id: "board", label: "Board" },
  { id: "errors", label: "Errors" },
  { id: "usage", label: "Usage" },
];

function loadSavedFilter(): FeedFilter {
  try {
    const v = window.sessionStorage.getItem(FEED_FILTER_STORAGE_KEY);
    if (v === "tools") {
      window.sessionStorage.setItem(FEED_FILTER_STORAGE_KEY, "messages");
      return "messages";
    }
    if (v === "all" || v === "messages" || v === "board" || v === "errors" || v === "usage") {
      return v;
    }
  } catch {
    // Ignore storage restrictions
  }
  return "all";
}

function saveFilter(filter: FeedFilter): void {
  try {
    window.sessionStorage.setItem(FEED_FILTER_STORAGE_KEY, filter);
  } catch {
    // Ignore storage restrictions
  }
}

interface DisplayFeedRow {
  primaryEvent: NormalizedEvent;
  badge: string;
  cssClass: string;
  isLowSignal: boolean;
  summaryText: string;
  protoTag?: string;
}

function loadSavedMode(): FeedMode {
  try {
    const v = window.sessionStorage.getItem(FEED_MODE_STORAGE_KEY);
    if (v === "detailed" || v === "summary") return v;
  } catch {
    // Ignore storage restrictions
  }
  return "summary";
}

function saveMode(mode: FeedMode): void {
  try {
    window.sessionStorage.setItem(FEED_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage restrictions
  }
}

function loadSavedRawTools(): boolean {
  try {
    return window.sessionStorage.getItem(SMS_RAW_TOOLS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveRawTools(show: boolean): void {
  try {
    window.sessionStorage.setItem(SMS_RAW_TOOLS_STORAGE_KEY, show ? "true" : "false");
  } catch {
    // Ignore storage restrictions
  }
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

function isOptionChosenByAnswer(optionLabel: string, chosenAnswerText?: string): boolean {
  if (!chosenAnswerText) return false;
  const optNorm = optionLabel.trim().toLowerCase();
  const ansNorm = chosenAnswerText.trim().toLowerCase();
  if (!optNorm || !ansNorm) return false;
  if (ansNorm === optNorm) return true;
  if (
    ansNorm.startsWith(`${optNorm} `) ||
    ansNorm.startsWith(`${optNorm}:`) ||
    ansNorm.startsWith(`${optNorm}\n`) ||
    ansNorm.startsWith(`${optNorm}—`) ||
    ansNorm.startsWith(`${optNorm}-`)
  ) {
    return true;
  }
  const strippedAns = ansNorm.replace(/^\*\*|\*\*$/g, "").trim();
  if (strippedAns === optNorm || strippedAns.startsWith(`${optNorm} `) || strippedAns.startsWith(`${optNorm}:`)) {
    return true;
  }
  if (optNorm.length >= 4 && ansNorm.includes(optNorm)) {
    return true;
  }
  return false;
}

function formatBehindSummaryChip(m: SmsMessageItem): string {
  const { thoughtCount, toolCount, durationLabel } = m.behindSummary;
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

function isPlaceholderThinking(ev: NormalizedEvent): boolean {
  if (ev.kind !== "thinking_start") return false;
  const s = cleanSummaryText(ev.summary).toLowerCase();
  return (
    !s ||
    s === "thinking…" ||
    s === "thinking..." ||
    s === "reasoning…" ||
    s === "reasoning..." ||
    s === "thinking"
  );
}

function extractShortTargetLabel(ev: NormalizedEvent): string {
  const p = ev.payload;
  const candidates = [
    p?.path,
    p?.Path,
    p?.file_path,
    p?.filePath,
    p?.Pattern,
    p?.pattern,
    p?.Query,
    p?.query,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      const clean = c.trim().replace(/\\/g, "/");
      const base = clean.split("/").filter(Boolean).pop();
      if (base) return base;
    }
  }
  const summary = cleanSummaryText(ev.summary)
    .replace(
      /^(read|inspect|inspected|reading|search|searched|glob|grep|list|listed)\s+(file\s+)?/i,
      ""
    )
    .trim();
  const pathMatch = /([A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6})/.exec(summary);
  if (pathMatch?.[1]) return pathMatch[1];
  return truncateWords(summary || ev.toolName || "file", 28);
}

function smsPromptDomSuffix(promptId: string): string {
  return promptId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function smsPromptTabDomId(promptId: string): string {
  return `sms-prompt-tab-${smsPromptDomSuffix(promptId)}`;
}

export function smsPromptPanelDomId(promptId: string): string {
  return `sms-prompt-panel-${smsPromptDomSuffix(promptId)}`;
}

export class ActivityFeed {
  private static readonly MAX_CACHED_BODIES = 64;
  private container: HTMLElement;
  private cb: ActivityFeedCallbacks;
  private filter: FeedFilter = loadSavedFilter();
  private mode: FeedMode = loadSavedMode();
  private selectedEventId: string | null = null;
  private agentFilter: string | null = null;
  private events: NormalizedEvent[] = [];
  private pendingPrompts: PendingHumanPrompt[] = [];
  private labelMap: Map<string, string> = new Map();
  private agents: AgentNodeSnapshot[] = [];
  private clusters: TeamAgentCluster[] = [];
  private sessionUsage: SessionUsageSummary | undefined = undefined;
  private sessionId: string | undefined = undefined;
  private usageDashboard: UsageDashboard | null = null;
  private inlineQuestionCards = new Map<string, { wrap: HTMLElement; card: QuestionCard }>();

  private activeThread: ThreadSelection = ALL_THREAD;
  private selectedRunId = "all";
  private showRawTools: boolean = loadSavedRawTools();
  private inspectedEventId: string | null = null;
  private embedMode = false;
  private mcpAppMode = false;
  private expandedBursts = new Set<string>();
  private expandedBubbleTools = new Set<string>();
  private expandedMessageIds = new Set<string>();
  private fetchedBodiesByEventId = new Map<string, string>();
  private loadingBodyEventIds = new Set<string>();
  private sessionResetSeq = 0;
  private latestSmsMessages: SmsMessageItem[] = [];
  private drawerScrollTops = new Map<string, number>();
  private isNearBottom = true;
  private unseenCount = 0;
  private lastSmsCount = 0;
  private lastSmsContextKey = "";
  private lastSmsHtml = "";

  private lastPendingHtml = "";
  private lastListHtml = "";
  private lastListContextKey = "";
  private smsPromptDockCollapsed = false;
  private activeSmsPromptId: string | null = null;
  private lastSmsTabsKey = "";

  private smsPillBarEl: HTMLElement;
  private rawToolsToggleBtn: HTMLButtonElement;
  private runFilterBarEl: HTMLElement;
  private feedListEl: HTMLElement;
  private smsBodyWrapEl: HTMLElement;
  private smsBodyEl: HTMLElement;
  private smsStreamItemsEl: HTMLElement;
  private smsPromptDockEl: HTMLElement;
  private smsPromptToggleBtn: HTMLButtonElement;
  private smsPromptBadgeTextEl: HTMLElement;
  private smsPromptTitleEl: HTMLElement;
  private smsPromptTabsEl: HTMLElement;
  private smsInlinePromptsEl: HTMLElement;
  private jumpLatestBtn: HTMLButtonElement;

  constructor(container: HTMLElement, cb: ActivityFeedCallbacks) {
    this.container = container;
    this.cb = cb;
    this.embedMode = Boolean(cb.embedMode);
    this.mcpAppMode = Boolean(cb.mcpAppMode);

    this.container.innerHTML = `
      <div class="card-head">
        <div class="topo-head-left">
          <button type="button" class="btn-ghost cover-back-btn" data-cover-back>← Topology</button>
          <span class="card-title">Live Activity Stream</span>
        </div>
        <div class="feed-head-right">
          <div class="feed-mode-toggle" role="group" aria-label="Stream verbosity">
            <button
              type="button"
              class="feed-mode-btn"
              data-feed-mode="summary"
              aria-pressed="${this.mode === "summary" ? "true" : "false"}"
            >Summary</button>
            <button
              type="button"
              class="feed-mode-btn"
              data-feed-mode="detailed"
              aria-pressed="${this.mode === "detailed" ? "true" : "false"}"
            >Detailed</button>
          </div>
          <span class="feed-tap-hint">Tap for details</span>
          <span class="feed-count" data-feed-count>0 key events</span>
        </div>
      </div>
      <div class="pending-bar" data-pending-bar hidden></div>
      <div class="feed-filters" role="tablist" aria-label="Activity stream filters">
        ${FILTER_TABS.map(
          (f) => `
            <button
              type="button"
              role="tab"
              class="filter-chip"
              data-feed-filter="${f.id}"
              aria-selected="${f.id === this.filter ? "true" : "false"}"
            >${escHtml(f.label)}</button>
          `
        ).join("")}
      </div>
      <div class="sms-thread-bar" data-sms-pill-bar hidden>
        <div class="sms-pill-meta">
          <span class="pill status" data-active-pill-route>All Session Messages</span>
          <span class="role-meta sms-pill-hint" data-active-pill-hint>SMS view in Messages tab</span>
        </div>
        <div class="run-top-right sms-bar-actions">
          <button
            type="button"
            class="subtle-toggle-pill"
            data-raw-tools-toggle
            aria-pressed="${this.showRawTools ? "true" : "false"}"
            title="Show or hide raw background tool steps in the Messages stream"
          >Raw tool steps: ${this.showRawTools ? "Shown" : "Hidden"}</button>
          <button type="button" class="btn-ghost" data-clear-pill hidden>✕ Show All Messages</button>
        </div>
      </div>
      <div class="run-filter-bar" data-run-filter-bar role="group" aria-label="Filter messages by agent run" hidden></div>
      <div class="feed-list" data-feed-list></div>
      <div class="sms-body-wrap" data-sms-body-wrap hidden>
        <div class="sms-body" data-sms-body aria-live="polite">
          <div class="sms-stream-items" data-sms-stream-items></div>
        </div>
        <button type="button" class="jump-latest-btn" data-jump-latest hidden>↓ Jump to latest</button>
      </div>
      <section class="sms-prompt-dock" data-sms-prompt-dock aria-label="Waiting agent prompts" hidden>
        <div class="sms-prompt-dock-header">
          <button
            type="button"
            class="sms-prompt-dock-toggle"
            data-sms-prompt-toggle
            aria-expanded="true"
          >
            <span class="sms-prompt-pill"><span aria-hidden="true">?</span> <span data-sms-prompt-badge-text>Waiting on you</span></span>
            <span class="sms-prompt-dock-title" data-sms-prompt-title></span>
            <span class="sms-prompt-chevron" aria-hidden="true">▾</span>
          </button>
        </div>
        <div class="sms-prompt-tabs" data-sms-prompt-tabs role="tablist" aria-label="Waiting agent prompts" hidden></div>
        <div class="sms-inline-prompts" data-sms-inline-prompts></div>
      </section>
    `;

    this.smsPillBarEl = this.container.querySelector("[data-sms-pill-bar]") as HTMLElement;
    this.rawToolsToggleBtn = this.container.querySelector(
      "[data-raw-tools-toggle]"
    ) as HTMLButtonElement;
    this.runFilterBarEl = this.container.querySelector("[data-run-filter-bar]") as HTMLElement;
    this.feedListEl = this.container.querySelector("[data-feed-list]") as HTMLElement;
    this.smsBodyWrapEl = this.container.querySelector("[data-sms-body-wrap]") as HTMLElement;
    this.smsBodyEl = this.container.querySelector("[data-sms-body]") as HTMLElement;
    this.smsStreamItemsEl = this.container.querySelector("[data-sms-stream-items]") as HTMLElement;
    this.smsPromptDockEl = this.container.querySelector("[data-sms-prompt-dock]") as HTMLElement;
    this.smsPromptToggleBtn = this.container.querySelector("[data-sms-prompt-toggle]") as HTMLButtonElement;
    this.smsPromptBadgeTextEl = this.container.querySelector("[data-sms-prompt-badge-text]") as HTMLElement;
    this.smsPromptTitleEl = this.container.querySelector("[data-sms-prompt-title]") as HTMLElement;
    this.smsPromptTabsEl = this.container.querySelector("[data-sms-prompt-tabs]") as HTMLElement;
    this.smsInlinePromptsEl = this.container.querySelector("[data-sms-inline-prompts]") as HTMLElement;
    this.jumpLatestBtn = this.container.querySelector("[data-jump-latest]") as HTMLButtonElement;

    this.bindEvents();
  }

  private bindEvents(): void {
    this.container.querySelector("[data-pending-bar]")?.addEventListener("click", (e) => {
      const btn = (e.target as Element | null)?.closest<HTMLButtonElement>("[data-pending-open-messages]");
      if (!btn) return;
      const aid = btn.dataset.pendingOpenMessages;
      const pid = btn.dataset.pendingPromptId;
      this.openMessagesForAgent(aid, pid);
    });

    this.feedListEl.addEventListener("click", (e) => {
      const btn = (e.target as Element | null)?.closest<HTMLButtonElement>("[data-usage-open-messages]");
      if (!btn) return;
      e.stopPropagation();
      const aid = btn.dataset.usageOpenMessages;
      this.openMessagesForAgent(aid);
    });

    this.container
      .querySelector("[data-cover-back]")
      ?.addEventListener("click", () => {
        this.cb.onCoverBackToTopology?.();
      });

    this.container.querySelectorAll<HTMLButtonElement>("[data-feed-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.feedFilter as FeedFilter | undefined;
        if (!next) return;
        this.filter = next;
        saveFilter(next);
        if (next !== "messages") {
          this.activeThread = ALL_THREAD;
          this.selectedRunId = "all";
          this.cb.onThreadChange?.(null);
        } else {
          this.isNearBottom = true;
          this.unseenCount = 0;
          this.cb.onThreadChange?.(this.activeThread.key);
        }
        this.syncFilterTabs();
        this.cb.onFilterChange?.(next);
        this.renderPending();
        this.renderList();
      });
    });

    this.container.querySelectorAll<HTMLButtonElement>("[data-feed-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.feedMode as FeedMode | undefined;
        if (!next || next === this.mode) return;
        this.mode = next;
        saveMode(next);
        this.container
          .querySelectorAll<HTMLButtonElement>("[data-feed-mode]")
          .forEach((b) => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
        this.renderList();
      });
    });

    this.rawToolsToggleBtn.addEventListener("click", () => {
      this.showRawTools = !this.showRawTools;
      saveRawTools(this.showRawTools);
      this.rawToolsToggleBtn.setAttribute("aria-pressed", this.showRawTools ? "true" : "false");
      this.renderSmsStream(false, true);
    });

    this.container.querySelector("[data-clear-pill]")?.addEventListener("click", () => {
      this.activeThread = ALL_THREAD;
      this.selectedRunId = "all";
      this.isNearBottom = true;
      this.unseenCount = 0;
      this.lastSmsCount = 0;
      this.cb.onThreadChange?.("all");
      this.renderList(true);
    });

    this.runFilterBarEl.addEventListener("click", (e) => {
      const btn = (e.target as Element | null)?.closest<HTMLButtonElement>("[data-run-filter]");
      if (!btn) return;
      this.selectedRunId = btn.dataset.runFilter || "all";
      this.isNearBottom = true;
      this.unseenCount = 0;
      this.renderList(true);
    });

    this.smsBodyEl.addEventListener("scroll", () => {
      const el = this.smsBodyEl;
      this.isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      if (this.isNearBottom) {
        this.unseenCount = 0;
      }
      this.syncJumpLatestBtn();
    });

    this.smsPromptToggleBtn.addEventListener("click", () => {
      this.smsPromptDockCollapsed = !this.smsPromptDockCollapsed;
      const hasMulti = this.smsPromptTabsEl.childElementCount > 1;
      this.syncSmsPromptDockVisibility(hasMulti);
    });

    this.smsPromptTabsEl.addEventListener("click", (e) => {
      const btn = (e.target as Element | null)?.closest<HTMLButtonElement>("[data-sms-prompt-tab]");
      if (!btn) return;
      const promptId = btn.dataset.smsPromptTab;
      if (!promptId || promptId === this.activeSmsPromptId) return;
      this.activeSmsPromptId = promptId;
      this.reconcileInlineSmsPrompts(this.activeThread);
      const nextBtn = this.smsPromptTabsEl.querySelector<HTMLButtonElement>(
        `[data-sms-prompt-tab="${CSS.escape(promptId)}"]`
      );
      nextBtn?.focus({ preventScroll: true });
      nextBtn?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });

    this.smsPromptTabsEl.addEventListener("keydown", (e) => {
      const tabs = Array.from(
        this.smsPromptTabsEl.querySelectorAll<HTMLButtonElement>("[data-sms-prompt-tab]")
      );
      if (tabs.length <= 1) return;
      const curIdx = tabs.findIndex((t) => t.dataset.smsPromptTab === this.activeSmsPromptId);
      let nextIdx: number | null = null;
      if (e.key === "ArrowRight") {
        nextIdx = ((curIdx >= 0 ? curIdx : 0) + 1) % tabs.length;
      } else if (e.key === "ArrowLeft") {
        nextIdx = ((curIdx >= 0 ? curIdx : 0) - 1 + tabs.length) % tabs.length;
      } else if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = tabs.length - 1;
      }
      if (nextIdx !== null) {
        e.preventDefault();
        const targetTab = tabs[nextIdx];
        const nextId = targetTab?.dataset.smsPromptTab;
        if (nextId) {
          this.activeSmsPromptId = nextId;
          this.reconcileInlineSmsPrompts(this.activeThread);
          const refreshed = this.smsPromptTabsEl.querySelector<HTMLButtonElement>(
            `[data-sms-prompt-tab="${CSS.escape(nextId)}"]`
          );
          refreshed?.focus({ preventScroll: true });
          refreshed?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }
    });

    this.jumpLatestBtn.addEventListener("click", () => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.smsBodyEl.scrollTo({
        top: this.smsBodyEl.scrollHeight,
        behavior: reduced ? "auto" : "smooth",
      });
      this.isNearBottom = true;
      this.unseenCount = 0;
      this.syncJumpLatestBtn();
    });

    this.smsBodyEl.addEventListener("click", (e) => {
      const target = e.target as Element | null;
      if (!target) return;

      const burstChipBtn = target.closest<HTMLButtonElement>("[data-burst-chip-toggle]");
      if (burstChipBtn) {
        const key = burstChipBtn.dataset.burstChipToggle;
        if (key) {
          if (this.expandedBursts.has(key)) this.expandedBursts.delete(key);
          else this.expandedBursts.add(key);
          this.renderSmsStream(false, true);
          const nextBtn = Array.from(
            this.smsBodyEl.querySelectorAll<HTMLButtonElement>("[data-burst-chip-toggle]")
          ).find((b) => b.dataset.burstChipToggle === key);
          nextBtn?.focus({ preventScroll: true });
        }
        return;
      }

      const chipBtn = target.closest<HTMLButtonElement>("[data-bubble-tools-toggle]");
      if (chipBtn) {
        const chipKey = chipBtn.dataset.bubbleToolsToggle;
        if (chipKey) {
          if (this.expandedBubbleTools.has(chipKey)) this.expandedBubbleTools.delete(chipKey);
          else this.expandedBubbleTools.add(chipKey);
          this.renderSmsStream(false, true);
          const nextBtn = Array.from(
            this.smsBodyEl.querySelectorAll<HTMLButtonElement>("[data-bubble-tools-toggle]")
          ).find((b) => b.dataset.bubbleToolsToggle === chipKey);
          nextBtn?.focus({ preventScroll: true });
        }
        return;
      }

      const toolRow = target.closest<HTMLButtonElement>("[data-tool-ev-id]");
      if (toolRow) {
        const evId = toolRow.dataset.toolEvId;
        const ev = evId ? this.events.find((x) => x.id === evId) : undefined;
        if (ev) {
          this.selectedEventId = ev.id;
          this.syncSelectedHighlight();
          this.cb.onSelectEvent(ev);
        }
        return;
      }

      const jumpBtn = target.closest<HTMLButtonElement>("[data-jump-msg]");
      if (jumpBtn) {
        const targetId = jumpBtn.dataset.jumpMsg;
        if (targetId) {
          const targetBubble = this.smsStreamItemsEl.querySelector<HTMLElement>(
            `[data-sms-ev-id="${CSS.escape(targetId)}"]`
          );
          if (targetBubble) {
            const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            targetBubble.scrollIntoView({
              behavior: reduced ? "auto" : "smooth",
              block: "center",
            });
            targetBubble.setAttribute("tabindex", "-1");
            targetBubble.focus({ preventScroll: true });
            targetBubble.classList.remove("is-jump-flash");
            void targetBubble.offsetWidth;
            targetBubble.classList.add("is-jump-flash");
          }
        }
        return;
      }

      const toggleBodyBtn = target.closest<HTMLButtonElement>("[data-toggle-body]");
      if (toggleBodyBtn) {
        const evId = toggleBodyBtn.dataset.toggleBody;
        if (evId) {
          const nextExpanded = !this.expandedMessageIds.has(evId);
          if (nextExpanded) {
            this.expandedMessageIds.add(evId);
            const msgItem = this.latestSmsMessages.find((m) => m.event.id === evId);
            if (
              msgItem?.event.bodyTruncated === true &&
              !this.fetchedBodiesByEventId.has(evId) &&
              !this.loadingBodyEventIds.has(evId)
            ) {
              void this.lazyFetchFullMessageBody(msgItem.event);
            }
          } else {
            this.expandedMessageIds.delete(evId);
          }
          this.renderSmsStream(false, true);
          const nextBtn = this.smsStreamItemsEl.querySelector<HTMLButtonElement>(
            `[data-toggle-body="${CSS.escape(evId)}"]`
          );
          nextBtn?.focus({ preventScroll: true });
        }
        return;
      }

      const behindBtn = target.closest<HTMLButtonElement>("[data-open-behind]");
      if (behindBtn) {
        const evId = behindBtn.dataset.openBehind;
        if (evId) {
          const entry = this.latestSmsMessages.find((m) => m.event.id === evId);
          if (entry && entry.behindSteps.length > 0) {
            const allWithBehind = this.latestSmsMessages.filter(
              (m) => m.behindSteps.length > 0
            );
            this.cb.onOpenBehind?.(entry, allWithBehind, behindBtn);
          }
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
  }

  public setRuntimeScope(scope: { embedMode?: boolean; mcpAppMode?: boolean }): void {
    if (typeof scope.embedMode === "boolean") {
      this.embedMode = scope.embedMode;
    }
    if (typeof scope.mcpAppMode === "boolean") {
      this.mcpAppMode = scope.mcpAppMode;
    }
  }

  public setInspectedEventId(evId: string | null): void {
    if (this.inspectedEventId === evId) return;
    this.inspectedEventId = evId;
    this.syncInspectedHighlight();
  }

  private syncInspectedHighlight(): void {
    this.smsStreamItemsEl
      .querySelectorAll<HTMLElement>(".bubble[data-sms-ev-id]")
      .forEach((bubble) => {
        const id = bubble.dataset.smsEvId ?? "";
        const isInsp = Boolean(this.inspectedEventId && id === this.inspectedEventId);
        bubble.classList.toggle("is-inspected", isInsp);
        const btn = bubble.querySelector<HTMLButtonElement>("[data-open-behind]");
        if (btn) {
          btn.setAttribute("aria-expanded", isInsp ? "true" : "false");
          const cta = btn.querySelector(".behind-cta");
          if (cta) cta.textContent = isInsp ? "Inspecting →" : "Trace →";
        }
      });
  }

  private cacheFetchedBody(evId: string, body: string): void {
    if (this.fetchedBodiesByEventId.has(evId)) {
      this.fetchedBodiesByEventId.delete(evId);
    }
    this.fetchedBodiesByEventId.set(evId, body);
    if (this.fetchedBodiesByEventId.size > ActivityFeed.MAX_CACHED_BODIES) {
      const oldestKey = this.fetchedBodiesByEventId.keys().next().value;
      if (oldestKey !== undefined) {
        this.fetchedBodiesByEventId.delete(oldestKey);
      }
    }
  }

  private async lazyFetchFullMessageBody(ev: NormalizedEvent): Promise<void> {
    const evId = ev.id;
    const ctx = this.cb.getSessionContext?.() ?? {};
    const sessionId = ev.sessionId || this.sessionId || ctx.sessionId || "";
    if (!evId || !sessionId) return;

    const reqSeq = this.sessionResetSeq;
    const reqSessionId = sessionId;
    this.loadingBodyEventIds.add(evId);
    try {
      const res = await fetchEventBody({
        sessionId,
        eventId: evId,
        ide: ev.ide || ctx.ide,
        project: ev.projectId || ctx.project,
        workspace: ev.workspacePath || ctx.workspace,
      });
      if (reqSeq !== this.sessionResetSeq) return;
      const activeSession = this.sessionId || this.cb.getSessionContext?.()?.sessionId || "";
      if (activeSession && reqSessionId !== activeSession) return;
      if (res.ok && typeof res.body === "string" && res.body.trim()) {
        this.cacheFetchedBody(evId, res.body.trim());
      }
    } catch {
      // Graceful fallback when body fetch is unavailable (e.g. offline/MCP App)
    } finally {
      this.loadingBodyEventIds.delete(evId);
      if (reqSeq === this.sessionResetSeq && this.filter === "messages") {
        this.renderSmsStream(false, true);
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

  private syncFilterTabs(): void {
    this.container.querySelectorAll<HTMLButtonElement>("[data-feed-filter]").forEach((b) => {
      b.setAttribute("aria-selected", b.dataset.feedFilter === this.filter ? "true" : "false");
    });
  }

  public getFilter(): FeedFilter {
    return this.filter;
  }

  public openMessagesForAgent(agentId?: string, promptId?: string): void {
    this.filter = "messages";
    saveFilter("messages");
    this.agentFilter = null;
    this.activeThread = ALL_THREAD;
    this.selectedRunId = "all";
    this.isNearBottom = true;
    this.unseenCount = 0;
    this.lastSmsCount = 0;
    this.smsPromptDockCollapsed = false;
    if (promptId) {
      const byPrompt = this.pendingPrompts.find((p) => p.id === promptId);
      if (byPrompt) this.activeSmsPromptId = byPrompt.id;
    } else if (agentId) {
      const byAgent = this.pendingPrompts.find((p) => p.agentId === agentId);
      if (byAgent) this.activeSmsPromptId = byAgent.id;
    }
    this.syncFilterTabs();
    this.cb.onThreadChange?.("all");
    this.cb.onFilterChange?.("messages");
    this.renderPending();
    this.renderList(true);
  }

  public openThread(
    selection: ThreadSelection,
    opts?: { forceOpen?: boolean; promptAgentId?: string }
  ): boolean {
    const requestedRun = selection.kind === "cluster" ? selection.runId || "all" : "all";
    // Re-clicking the exact active pill clears the filter cleanly
    if (
      !opts?.forceOpen &&
      this.filter === "messages" &&
      this.activeThread.key === selection.key &&
      this.selectedRunId === requestedRun
    ) {
      this.filter = "all";
      saveFilter("all");
      this.activeThread = ALL_THREAD;
      this.selectedRunId = "all";
      this.syncFilterTabs();
      this.cb.onThreadChange?.(null);
      this.cb.onFilterChange?.("all");
      this.renderPending();
      this.renderList();
      return false;
    }

    this.filter = "messages";
    saveFilter("messages");
    this.agentFilter = null;
    this.activeThread = selection;
    this.selectedRunId = requestedRun;
    this.isNearBottom = true;
    this.unseenCount = 0;
    this.lastSmsCount = 0;
    if (opts?.promptAgentId) {
      const byAgent = this.pendingPrompts.find((p) => p.agentId === opts.promptAgentId);
      if (byAgent) {
        this.activeSmsPromptId = byAgent.id;
        this.smsPromptDockCollapsed = false;
      }
    }
    this.syncFilterTabs();
    this.cb.onThreadChange?.(selection.key);
    this.cb.onFilterChange?.("messages");
    this.renderPending();
    this.renderList(true);
    return true;
  }

  public setAgentFilter(agentId: string | null): void {
    this.agentFilter = agentId;
    if (agentId !== null && this.filter === "messages") {
      this.filter = "all";
      saveFilter("all");
      this.activeThread = ALL_THREAD;
      this.selectedRunId = "all";
      this.syncFilterTabs();
      this.cb.onThreadChange?.(null);
      this.cb.onFilterChange?.("all");
      this.renderPending();
    }
    this.renderList();
  }

  public setSelectedEvent(eventId: string | null): void {
    this.selectedEventId = eventId;
    this.syncSelectedHighlight();
  }

  public getBehindInspectableMessages(): SmsMessageItem[] {
    return this.latestSmsMessages.filter((m) => m.behindSteps.length > 0);
  }

  public resetScroll(): void {
    this.sessionResetSeq += 1;
    this.lastListContextKey = "";
    this.lastSmsContextKey = "";
    this.lastSmsHtml = "";
    this.activeThread = ALL_THREAD;
    this.selectedRunId = "all";
    this.inspectedEventId = null;
    this.expandedBursts.clear();
    this.expandedBubbleTools.clear();
    this.expandedMessageIds.clear();
    this.fetchedBodiesByEventId.clear();
    this.loadingBodyEventIds.clear();
    this.latestSmsMessages = [];
    this.drawerScrollTops.clear();
    this.isNearBottom = true;
    this.unseenCount = 0;
    this.lastSmsCount = 0;
    this.feedListEl.scrollTop = 0;
    this.smsBodyEl.scrollTop = 0;
    this.cb.onThreadChange?.(this.filter === "messages" ? "all" : null);
  }

  private syncSelectedHighlight(): void {
    this.container
      .querySelectorAll<HTMLElement>(".ev-item[data-ev-id]")
      .forEach((item) => {
        const isSel = item.dataset.evId === this.selectedEventId;
        item.classList.toggle("selected", isSel);
        const rowBtn = item.querySelector<HTMLButtonElement>(".ev-row-btn");
        rowBtn?.setAttribute("aria-pressed", isSel ? "true" : "false");
      });
    this.smsBodyEl
      .querySelectorAll<HTMLButtonElement>(".tool-burst-row[data-tool-ev-id]")
      .forEach((row) => {
        const isSel = row.dataset.toolEvId === this.selectedEventId;
        row.classList.toggle("selected", isSel);
        row.setAttribute("aria-pressed", isSel ? "true" : "false");
      });
  }

  public dispose(): void {
    for (const entry of this.inlineQuestionCards.values()) {
      entry.card.dispose();
    }
    this.inlineQuestionCards.clear();
  }

  public update(
    events: NormalizedEvent[],
    pendingPrompts: PendingHumanPrompt[] = [],
    labelMap?: Map<string, string>,
    agents?: AgentNodeSnapshot[],
    sessionUsage?: SessionUsageSummary,
    clusters?: TeamAgentCluster[],
    sessionId?: string
  ): void {
    this.events = events;
    this.pendingPrompts = pendingPrompts;
    if (labelMap) this.labelMap = labelMap;
    if (agents) this.agents = agents;
    if (clusters) this.clusters = clusters;
    if (sessionId !== undefined) {
      if (this.sessionId && sessionId !== this.sessionId) {
        this.sessionResetSeq += 1;
        this.fetchedBodiesByEventId.clear();
        this.loadingBodyEventIds.clear();
      }
      this.sessionId = sessionId;
    }
    this.sessionUsage = sessionUsage;
    this.renderPending();
    this.renderList();
  }

  private renderPending(): void {
    const bar = this.container.querySelector<HTMLElement>("[data-pending-bar]");
    if (!bar) return;
    if (this.filter === "messages" || this.pendingPrompts.length === 0) {
      if (!bar.hidden || this.lastPendingHtml !== "") {
        bar.hidden = true;
        bar.innerHTML = "";
        this.lastPendingHtml = "";
      }
      return;
    }
    const nextHtml = this.pendingPrompts
      .map(
        (p) => `
          <div class="pending-card ${p.kind === "approval" ? "approval" : ""}">
            <div class="pending-head">
              <div class="pending-head-left">
                <span class="pending-badge"><span aria-hidden="true">?</span> ${p.kind === "approval" ? "APPROVAL NEEDED" : "WAITING ON USER"}</span>
                <span class="pending-agent">${escHtml(formatActorName(p.agentId, this.labelMap, p.agentLabel))}</span>
              </div>
              <button type="button" class="btn-primary btn-sm pending-messages-btn" data-pending-open-messages="${escHtml(p.agentId)}" data-pending-prompt-id="${escHtml(p.id)}">View in Messages</button>
            </div>
            <div class="pending-q-text">${escHtml(cleanSummaryText(p.title))}</div>
            ${p.summary ? `<div class="pending-summary">${escHtml(cleanSummaryText(p.summary))}</div>` : ""}
          </div>
        `
      )
      .join("");
    if (bar.hidden || nextHtml !== this.lastPendingHtml) {
      bar.hidden = false;
      bar.innerHTML = nextHtml;
      this.lastPendingHtml = nextHtml;
    }
  }

  private matchesCategoryFilter(ev: NormalizedEvent): boolean {
    if (this.agentFilter) {
      const matches =
        ev.agentId === this.agentFilter || ev.targetAgentId === this.agentFilter;
      if (!matches) return false;
    }
    switch (this.filter) {
      case "messages":
        return (
          ev.kind === "message" ||
          ev.kind === "user_input" ||
          ev.kind === "subagent_spawn" ||
          ev.kind === "subagent_done" ||
          ev.kind === "assistant_turn_end"
        );
      case "board": {
        const cls = classifyEventReadable(ev);
        return ev.kind === "board_mutation" || cls.category === "board";
      }
      case "errors":
        return isErrorEvent(ev);
      default:
        return true;
    }
  }

  private buildDisplayRows(filteredRaw: NormalizedEvent[]): DisplayFeedRow[] {
    if (this.mode === "detailed") {
      return filteredRaw.map((ev) => {
        const cls = classifyEventReadable(ev);
        const protoTag = ev.toolName ? `${ev.kind} · ${ev.toolName}` : ev.kind;
        return {
          primaryEvent: ev,
          badge: cls.badge,
          cssClass: cls.cssClass,
          isLowSignal: cls.isLowSignal,
          summaryText: truncateWords(cleanSummaryText(ev.summary) || cls.humanTitle, 200),
          protoTag,
        };
      });
    }

    const keyEvents = filteredRaw.filter(
      (ev) => !isRoutineToolEnd(ev) && !isPlaceholderThinking(ev)
    );

    const rows: DisplayFeedRow[] = [];
    let i = 0;
    while (i < keyEvents.length) {
      const ev = keyEvents[i]!;
      const cls = classifyEventReadable(ev);

      if (this.filter === "all" && cls.category === "read") {
        let j = i + 1;
        while (j < keyEvents.length) {
          const nextEv = keyEvents[j]!;
          const nextCls = classifyEventReadable(nextEv);
          if (nextEv.agentId === ev.agentId && nextCls.category === "read") {
            j += 1;
          } else {
            break;
          }
        }
        const burstLen = j - i;
        if (burstLen >= 2) {
          const burst = keyEvents.slice(i, j);
          const uniqueTargets: string[] = [];
          for (const b of burst) {
            const label = extractShortTargetLabel(b);
            if (label && !uniqueTargets.includes(label)) {
              uniqueTargets.push(label);
            }
          }
          const shown = uniqueTargets.slice(0, 3);
          const extra = Math.max(0, uniqueTargets.length - shown.length);
          const listStr =
            shown.length > 0
              ? `: ${shown.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`
              : "";
          rows.push({
            primaryEvent: burst[burst.length - 1]!,
            badge: `Read ×${burstLen}`,
            cssClass: "tool",
            isLowSignal: true,
            summaryText: `Inspected ${burstLen} files${listStr}`,
          });
          i = j;
          continue;
        }
      }

      rows.push({
        primaryEvent: ev,
        badge: cls.badge,
        cssClass: cls.cssClass,
        isLowSignal: cls.isLowSignal,
        summaryText: truncateWords(cleanSummaryText(ev.summary) || cls.humanTitle, 200),
      });
      i += 1;
    }

    return rows;
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

  private renderToolRowsHtml(events: NormalizedEvent[]): string {
    return events
      .map((ev) => {
        const cls = classifyEventReadable(ev);
        const isSel = ev.id === this.selectedEventId;
        const text = truncateWords(cleanSummaryText(ev.summary) || cls.humanTitle, 180);
        return `
          <button
            type="button"
            class="tool-burst-row ${cls.cssClass} ${isSel ? "selected" : ""}"
            data-tool-ev-id="${escHtml(ev.id)}"
            aria-pressed="${isSel ? "true" : "false"}"
          >
            <span class="tool-burst-row-time">${escHtml(fmtClock(ev.ts || ev.epoch))}</span>
            <span class="pill ${cls.cssClass}">${escHtml(cls.badge)}</span>
            <span class="tool-burst-row-text">${escHtml(text)}</span>
            <span class="ev-chevron" aria-hidden="true">›</span>
          </button>
        `;
      })
      .join("");
  }

  private renderSmsStreamEntryHtml(
    entry: SmsStreamEntry,
    showRouteBadge: boolean
  ): string {
    if (entry.kind === "tool_burst") {
      const openGroups = entry.categories.filter((g) =>
        this.expandedBursts.has(`${entry.groupKey}|${g.extId}`)
      );
      const isAnyOpen = openGroups.length > 0;
      const drawerKey = `burst:${entry.groupKey}`;
      return `
        <div class="tool-burst-strip ${entry.dir} ${isAnyOpen ? "is-expanded" : ""} ${entry.hasError ? "has-error" : ""}" data-burst-key="${escHtml(entry.groupKey)}" style="--bubble-accent:${escHtml(entry.accentColor)}">
          <div class="tool-strip-header">
            <div class="tool-strip-meta">
              <span class="tool-strip-dot" aria-hidden="true"></span>
              <span class="tool-strip-agent">${escHtml(entry.agentLabel)}</span>
              <span class="tool-strip-time">${escHtml(entry.timeRange)}</span>
              ${entry.hasError ? `<span class="tool-strip-err" title="Contains tool errors">Error</span>` : ""}
            </div>
            <div class="bubble-tools tool-strip-chips">
              ${entry.categories
                .map((g) => {
                  const chipKey = `${entry.groupKey}|${g.extId}`;
                  const isChipOpen = this.expandedBursts.has(chipKey);
                  const catHasErr = g.events.some(isErrorEvent);
                  return `<button type="button" class="tool-badge tool-badge-btn ${catHasErr ? "has-error" : ""} ${isChipOpen ? "is-expanded" : ""}" data-burst-chip-toggle="${escHtml(chipKey)}" aria-expanded="${isChipOpen ? "true" : "false"}">${escHtml(g.label)} · ${g.count} <span aria-hidden="true">${isChipOpen ? "▾" : "▸"}</span></button>`;
                })
                .join("")}
            </div>
          </div>
          ${
            openGroups.length > 0
              ? `<div class="bubble-tool-drawer tool-strip-drawer" data-drawer-key="${escHtml(drawerKey)}">
                  ${openGroups
                    .map(
                      (g) => `
                        <div class="bubble-tool-drawer-section">
                          <div class="bubble-tool-drawer-head">${escHtml(g.label)} (${g.count})</div>
                          ${this.renderToolRowsHtml(g.events)}
                        </div>
                      `
                    )
                    .join("")}
                </div>`
              : ""
          }
        </div>
      `;
    }

    const m = entry;
    const isInspected = Boolean(this.inspectedEventId && m.event.id === this.inspectedEventId);
    const cachedBody = this.fetchedBodiesByEventId.get(m.event.id);
    const displayMd =
      cachedBody && cachedBody.length > m.fullMarkdownText.length
        ? cachedBody
        : m.fullMarkdownText;
    const lineCount = displayMd.split(/\r?\n/).length;
    const isLong = lineCount > 6 || displayMd.length > 360 || m.event.bodyTruncated === true;
    const isExpanded = this.expandedMessageIds.has(m.event.id);
    const isClamped = isLong && !isExpanded;
    const isFetchingBody = this.loadingBodyEventIds.has(m.event.id);
    const renderedMd = renderMarkdown(displayMd, { enableFileLinks: true });

    const replyQuoteHtml = m.replyToEntryId
      ? `<button
          type="button"
          class="reply-quote-ref"
          data-jump-msg="${escHtml(m.replyToEntryId)}"
          title="Jump to question bubble"
        >
          <strong>↳ Re: ${escHtml(m.replyToActorLabel || "Agent")}:</strong>
          <span class="reply-quote-text">&ldquo;${escHtml(m.replyToQuote || "")}&rdquo;</span>
        </button>`
      : "";

    const optionItems = (m.questions ?? []).flatMap((q) => q.options ?? []);
    const optionsHtml =
      optionItems.length > 0
        ? `<div class="question-options-list" aria-label="Question options">
            ${optionItems
              .map((opt) => {
                const chosen = isOptionChosenByAnswer(opt.label, m.chosenAnswerText);
                return `<div class="q-option-pill ${chosen ? "is-chosen" : ""}">
                  <span class="q-check" aria-hidden="true">${chosen ? "✓" : ""}</span>
                  <span>${escHtml(opt.label)}</span>
                  ${chosen ? `<span class="q-chosen-tag">Selected by user</span>` : ""}
                </div>`;
              })
              .join("")}
          </div>`
        : "";

    const behindSummaryText = formatBehindSummaryChip(m);
    const behindBarHtml =
      m.behindSteps.length > 0
        ? `<button
            type="button"
            class="behind-bar"
            data-open-behind="${escHtml(m.event.id)}"
            aria-expanded="${isInspected ? "true" : "false"}"
          >
            <span class="behind-summary">
              <span class="behind-spark" aria-hidden="true">✦</span>
              <span>Behind this response</span>
              ${behindSummaryText ? `<span class="behind-meta-chip">· ${escHtml(behindSummaryText)}</span>` : ""}
            </span>
            <span class="behind-cta">${isInspected ? "Inspecting →" : "Trace →"}</span>
          </button>`
        : "";

    const openGroups =
      this.showRawTools && m.behindSteps.length === 0
        ? m.toolGroups.filter((g) =>
            this.expandedBubbleTools.has(`${m.event.id}|${g.extId}`)
          )
        : [];
    const drawerKey = `msg:${m.event.id}`;

    return `
      <article
        class="bubble ${m.dir}${m.isHumanAnswer ? " is-human" : ""}${isInspected ? " is-inspected" : ""}"
        data-sms-ev-id="${escHtml(m.event.id)}"
        style="--bubble-accent:${escHtml(m.accentColor)}"
      >
        ${showRouteBadge ? `<span class="bubble-route">${escHtml(m.routeLabel)}</span>` : ""}
        <div class="bubble-head">
          <span class="bubble-sender">${escHtml(m.fromLabel)} <span class="bubble-role">${escHtml(m.roleBadge)}</span></span>
          <span>${escHtml(m.timeLabel)}</span>
        </div>
        ${replyQuoteHtml}
        <div class="bubble-body-container">
          <div class="bubble-text reader-md ${isClamped ? "is-clamped" : ""}">${renderedMd.html}</div>
          ${
            isLong
              ? `<button
                  type="button"
                  class="show-more-btn"
                  data-toggle-body="${escHtml(m.event.id)}"
                  aria-expanded="${isExpanded ? "true" : "false"}"
                >${isFetchingBody ? "Loading full message…" : isExpanded ? "Show less ▴" : "Show more ▾"}</button>`
              : ""
          }
        </div>
        ${optionsHtml}
        ${behindBarHtml}
        ${
          this.showRawTools && m.behindSteps.length === 0 && m.toolGroups.length > 0
            ? `<div class="bubble-foot">
                <div class="bubble-tools">${m.toolGroups
                  .map((g) => {
                    const chipKey = `${m.event.id}|${g.extId}`;
                    const isChipOpen = this.expandedBubbleTools.has(chipKey);
                    const catHasErr = g.events.some(isErrorEvent);
                    return `<button type="button" class="tool-badge tool-badge-btn ${catHasErr ? "has-error" : ""} ${isChipOpen ? "is-expanded" : ""}" data-bubble-tools-toggle="${escHtml(chipKey)}" aria-expanded="${isChipOpen ? "true" : "false"}">${escHtml(g.label)} · ${g.count} <span aria-hidden="true">${isChipOpen ? "▾" : "▸"}</span></button>`;
                  })
                  .join("")}</div>
              </div>`
            : ""
        }
        ${
          openGroups.length > 0
            ? `<div class="bubble-tool-drawer" data-drawer-key="${escHtml(drawerKey)}">
                ${openGroups
                  .map(
                    (g) => `
                      <div class="bubble-tool-drawer-section">
                        <div class="bubble-tool-drawer-head">${escHtml(g.label)} (${g.count})</div>
                        ${this.renderToolRowsHtml(g.events)}
                      </div>
                    `
                  )
                  .join("")}
              </div>`
            : ""
        }
      </article>
    `;
  }

  private renderSmsStream(forceScrollBottom = false, preserveScroll = false): void {
    const countEl = this.container.querySelector<HTMLElement>("[data-feed-count]");
    const modeToggle = this.container.querySelector<HTMLElement>(".feed-mode-toggle");
    if (modeToggle) modeToggle.hidden = true;

    this.feedListEl.hidden = true;
    if (this.lastListHtml !== "") {
      this.feedListEl.innerHTML = "";
      this.lastListHtml = "";
      this.lastListContextKey = "";
    }
    this.smsPillBarEl.hidden = false;
    this.smsBodyWrapEl.hidden = false;

    // Refresh cluster runs if live snapshot updated
    let thread = this.activeThread;
    if (thread.kind === "cluster") {
      const targetClusterId = thread.clusterId;
      const baseClusterId = targetClusterId.replace(/::(?:active|done)$/, "");
      const latestCluster =
        this.clusters.find((c) => c.id === targetClusterId) ??
        this.clusters.find((c) => c.id === baseClusterId);
      if (latestCluster) {
        thread = {
          ...thread,
          clusterId: latestCluster.id,
          key: latestCluster.threadKey,
          agentIds: latestCluster.agentIds,
          runs: latestCluster.runs,
          runId: this.selectedRunId !== "all" ? this.selectedRunId : undefined,
        };
        this.activeThread = thread;
      }
    }

    const effectiveThread: ThreadSelection =
      thread.kind === "cluster"
        ? { ...thread, runId: this.selectedRunId !== "all" ? this.selectedRunId : undefined }
        : thread;

    const hasSpecificPill = effectiveThread.kind !== "all";
    const routeEl = this.smsPillBarEl.querySelector("[data-active-pill-route]");
    const hintEl = this.smsPillBarEl.querySelector("[data-active-pill-hint]");
    const clearBtn = this.smsPillBarEl.querySelector<HTMLButtonElement>("[data-clear-pill]");
    if (routeEl) routeEl.textContent = effectiveThread.route;
    if (clearBtn) clearBtn.hidden = !hasSpecificPill;

    // Sticky Run-Filter bar for multi-run Team Agent clusters
    if (thread.kind === "cluster" && (thread.runs?.length ?? 0) > 1) {
      const runs = thread.runs!;
      this.runFilterBarEl.hidden = false;
      const pills = [
        `<button type="button" class="run-pill" data-run-filter="all" aria-pressed="${this.selectedRunId === "all"}">All (${runs.length})</button>`,
        ...runs.slice(0, 8).map((r, i) => {
          const shortLabel = r.displayId.includes("#")
            ? `#${r.displayId.split("#")[1]}`
            : `Run #${i + 1}`;
          return `<button type="button" class="run-pill" data-run-filter="${escHtml(r.id)}" aria-pressed="${this.selectedRunId === r.id}">${escHtml(shortLabel)} · ${escHtml(r.state)}</button>`;
        }),
        ...(runs.length > 8
          ? [`<span class="role-meta">+${runs.length - 8} older</span>`]
          : []),
      ];
      this.runFilterBarEl.innerHTML =
        `<span class="run-filter-label">Runs</span>` + pills.join("");
    } else {
      this.runFilterBarEl.hidden = true;
      this.runFilterBarEl.innerHTML = "";
    }

    const streamResult = extractSmsStreamWithMeta(
      {
        events: this.events,
        agents: this.agents,
        thread: effectiveThread,
        labelMap: this.labelMap,
        clusters: this.clusters,
      },
      { showRawTools: this.showRawTools }
    );
    const streamEntries = streamResult.entries;
    this.latestSmsMessages = streamEntries.filter(
      (e): e is SmsMessageItem => e.kind === "message"
    );

    const msgCount = this.latestSmsMessages.length;
    const burstCount = streamEntries.filter((e) => e.kind === "tool_burst").length;
    const hiddenSuffix =
      !this.showRawTools && streamResult.hiddenToolCount > 0
        ? ` (${streamResult.hiddenToolCount})`
        : "";
    this.rawToolsToggleBtn.setAttribute("aria-pressed", this.showRawTools ? "true" : "false");
    this.rawToolsToggleBtn.textContent = this.showRawTools
      ? "Raw tool steps: Shown"
      : `Raw tool steps: Hidden${hiddenSuffix}`;
    this.rawToolsToggleBtn.title = this.showRawTools
      ? "Hide raw background tool strips from Messages stream"
      : `${streamResult.hiddenToolCount} background tool events folded behind responses — click to show raw steps`;

    const burstSuffix =
      burstCount > 0 ? ` · ${burstCount} tool ${burstCount === 1 ? "burst" : "bursts"}` : "";

    if (hintEl) {
      hintEl.textContent = this.showRawTools
        ? `${msgCount} ${msgCount === 1 ? "msg" : "msgs"}${burstSuffix} · raw audit`
        : hasSpecificPill
          ? `${msgCount} ${msgCount === 1 ? "msg" : "msgs"} in thread · trace behind responses`
          : `${msgCount} total msgs · conversation only`;
    }
    if (countEl) {
      countEl.textContent = `${msgCount} ${msgCount === 1 ? "msg" : "msgs"}${burstCount > 0 ? ` · ${burstCount} ${burstCount === 1 ? "burst" : "bursts"}` : ""}`;
      countEl.title = this.showRawTools
        ? `Showing ${msgCount} SMS messages and ${burstCount} grouped tool bursts`
        : `Showing ${msgCount} SMS messages (${streamResult.hiddenToolCount} raw tool steps folded behind responses)`;
    }

    const contextKey = `${effectiveThread.key}|${this.selectedRunId}|${this.showRawTools ? "raw" : "clean"}`;
    const dividerLabel =
      effectiveThread.kind === "all"
        ? "All Session Messages · Chronological Stream"
        : `${effectiveThread.route} · Conversation Thread`;

    const emptyNotice =
      !this.showRawTools && streamResult.hiddenToolCount > 0
        ? `No conversation messages for this selection (${streamResult.hiddenToolCount} background tool steps hidden — toggle "Raw tool steps" above to inspect).`
        : "No messages recorded for this selection yet.";

    const html = `
      <div class="sms-day-divider">${escHtml(dividerLabel)}</div>
      ${
        streamEntries.length === 0
          ? `<div class="sms-day-divider">${escHtml(emptyNotice)}</div>`
          : streamEntries
              .map((entry) =>
                this.renderSmsStreamEntryHtml(entry, effectiveThread.kind === "all")
              )
              .join("")
      }
    `;

    const sameContext = contextKey === this.lastSmsContextKey;
    const streamDirty = !sameContext || html !== this.lastSmsHtml;

    if (!streamDirty) {
      this.reconcileInlineSmsPrompts(effectiveThread);
      if (forceScrollBottom && !preserveScroll) {
        window.requestAnimationFrame(() => {
          this.smsBodyEl.scrollTop = this.smsBodyEl.scrollHeight;
          this.isNearBottom = true;
          this.unseenCount = 0;
          this.syncJumpLatestBtn();
        });
      }
      return;
    }

    const prevScrollTop = sameContext ? this.smsBodyEl.scrollTop : 0;
    const prevWasNearBottom = sameContext ? this.isNearBottom : true;

    if (sameContext) {
      this.smsStreamItemsEl
        .querySelectorAll<HTMLElement>(".bubble-tool-drawer[data-drawer-key]")
        .forEach((drawer) => {
          const key = drawer.dataset.drawerKey;
          if (key) {
            this.drawerScrollTops.set(key, drawer.scrollTop);
          }
        });
    } else {
      this.drawerScrollTops.clear();
    }

    if (sameContext && !prevWasNearBottom && msgCount > this.lastSmsCount) {
      this.unseenCount += msgCount - this.lastSmsCount;
    } else if (!sameContext || forceScrollBottom || prevWasNearBottom) {
      this.unseenCount = 0;
    }

    this.smsStreamItemsEl.innerHTML = html;
    this.lastSmsHtml = html;
    this.lastSmsContextKey = contextKey;
    this.lastSmsCount = msgCount;
    this.reconcileInlineSmsPrompts(effectiveThread);

    const activeDrawerKeys = new Set<string>();
    this.smsStreamItemsEl
      .querySelectorAll<HTMLElement>(".bubble-tool-drawer[data-drawer-key]")
      .forEach((drawer) => {
        const key = drawer.dataset.drawerKey;
        if (!key) return;
        activeDrawerKeys.add(key);
        const savedTop = this.drawerScrollTops.get(key);
        if (typeof savedTop === "number" && savedTop > 0) {
          drawer.scrollTop = savedTop;
        }
      });
    for (const k of Array.from(this.drawerScrollTops.keys())) {
      if (!activeDrawerKeys.has(k)) {
        this.drawerScrollTops.delete(k);
      }
    }

    if (preserveScroll) {
      this.smsBodyEl.scrollTop = prevScrollTop;
      this.syncJumpLatestBtn();
    } else if (forceScrollBottom || prevWasNearBottom) {
      window.requestAnimationFrame(() => {
        this.smsBodyEl.scrollTop = this.smsBodyEl.scrollHeight;
        this.isNearBottom = true;
        this.unseenCount = 0;
        this.syncJumpLatestBtn();
      });
    } else {
      this.smsBodyEl.scrollTop = prevScrollTop;
      this.syncJumpLatestBtn();
    }
  }

  private renderList(forceScrollBottom = false): void {
    const listEl = this.feedListEl;
    const countEl = this.container.querySelector<HTMLElement>("[data-feed-count]");
    const modeToggle = this.container.querySelector<HTMLElement>(".feed-mode-toggle");

    if (this.filter === "messages") {
      this.renderSmsStream(forceScrollBottom);
      return;
    }

    this.smsPillBarEl.hidden = true;
    this.runFilterBarEl.hidden = true;
    this.smsBodyWrapEl.hidden = true;
    this.smsPromptDockEl.hidden = true;
    listEl.hidden = false;

    if (this.filter === "usage") {
      this.lastListHtml = "";
      this.lastListContextKey = "usage";
      if (modeToggle) modeToggle.hidden = true;
      const aiCount = this.agents.filter((a) => (a.nodeType ?? "agent") === "agent").length;
      const totalTok =
        this.sessionUsage?.totalTokens ??
        this.agents.reduce((sum, a) => sum + (a.usage?.totalTokens ?? 0), 0);
      if (countEl) {
        countEl.textContent = `${aiCount} ${aiCount === 1 ? "agent" : "agents"} · ${fmtTokens(totalTok)} tok`;
        countEl.title = `Session token, model & context usage across ${aiCount} agents`;
      }
      if (!this.usageDashboard) {
        this.usageDashboard = new UsageDashboard(listEl);
      }
      this.usageDashboard.render({
        agents: this.agents,
        sessionUsage: this.sessionUsage,
        labelMap: this.labelMap,
        selectedAgentId: this.agentFilter,
        onSelectAgent: (aid) => this.cb.onSelectAgent?.(aid),
      });
      this.decorateUsageCards();
      return;
    }

    if (modeToggle) modeToggle.hidden = false;
    const filteredRaw = this.events.filter((ev) => this.matchesCategoryFilter(ev));
    const displayRows = this.buildDisplayRows(filteredRaw);

    if (countEl) {
      if (this.mode === "summary") {
        countEl.textContent = `${displayRows.length} key ${displayRows.length === 1 ? "event" : "events"}`;
        countEl.title = `Showing ${displayRows.length} key events out of ${filteredRaw.length} total`;
      } else {
        countEl.textContent = `${displayRows.length} raw ${displayRows.length === 1 ? "event" : "events"}`;
        countEl.title = `Showing all ${displayRows.length} raw telemetry events`;
      }
    }

    const contextKey = `${this.filter}|${this.mode}|${this.agentFilter ?? ""}`;
    const visible = displayRows.length === 0 ? [] : displayRows.slice(-200).reverse();
    const html =
      visible.length === 0
        ? `<div class="empty-state">No events match this filter yet.</div>`
        : visible
            .map((row) => {
              const ev = row.primaryEvent;
              const ide = getIdeMeta(ev.ide);
              const actorName = formatActorName(ev.agentId, this.labelMap, ev.agentLabel);
              const route =
                ev.targetAgentId && ev.targetAgentId !== ev.agentId
                  ? `${actorName} → ${formatActorName(ev.targetAgentId, this.labelMap)}`
                  : actorName;
              const isCommEvent =
                ev.kind === "message" ||
                ev.kind === "user_input" ||
                ev.kind === "subagent_spawn";
              return `
                <div
                  class="ev-item ${row.cssClass} ${row.isLowSignal ? "ev-low-signal" : ""}"
                  data-ev-id="${escHtml(ev.id)}"
                >
                  <button
                    type="button"
                    class="ev-row-btn"
                    aria-pressed="false"
                  >
                    <div class="ev-top">
                      <span class="ev-route">${escHtml(route)}</span>
                      <span class="ev-badges">
                        <span class="ide-mini" style="color:${ide.color}">${escHtml(ide.short)}</span>
                        <span class="pill ${row.cssClass}">${escHtml(row.badge)}</span>
                        <span class="ev-time">${escHtml(fmtClock(ev.ts || ev.epoch))}</span>
                      </span>
                    </div>
                    <div class="ev-title-row">
                      <span class="ev-title">${escHtml(row.summaryText)}</span>
                      <span class="ev-chevron" aria-hidden="true">›</span>
                    </div>
                    ${row.protoTag ? `<div class="ev-proto-tag">${escHtml(row.protoTag)}</div>` : ""}
                  </button>
                  ${
                    isCommEvent
                      ? `<button type="button" class="ev-read-btn" data-read-ev="${escHtml(ev.id)}" aria-label="Read formatted ${escHtml(row.badge)} from ${escHtml(actorName)}">Read</button>`
                      : ""
                  }
                </div>
              `;
            })
            .join("");

    if (contextKey === this.lastListContextKey && html === this.lastListHtml) {
      return;
    }

    const sameContext = contextKey === this.lastListContextKey;
    const prevScrollTop = sameContext ? listEl.scrollTop : 0;

    listEl.innerHTML = html;
    this.lastListHtml = html;
    this.lastListContextKey = contextKey;

    if (visible.length > 0) {
      if (this.selectedEventId) {
        this.syncSelectedHighlight();
      }
      const byId = new Map(visible.map((r) => [r.primaryEvent.id, r.primaryEvent]));
      listEl.querySelectorAll<HTMLElement>(".ev-item[data-ev-id]").forEach((item) => {
        const rowBtn = item.querySelector<HTMLButtonElement>(".ev-row-btn");
        rowBtn?.addEventListener("click", () => {
          const ev = item.dataset.evId ? byId.get(item.dataset.evId) : undefined;
          if (ev) {
            this.selectedEventId = ev.id;
            this.syncSelectedHighlight();
            this.cb.onSelectEvent(ev);
          }
        });
      });

      listEl.querySelectorAll<HTMLButtonElement>("[data-read-ev]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const ev = btn.dataset.readEv ? byId.get(btn.dataset.readEv) : undefined;
          if (ev) {
            this.selectedEventId = ev.id;
            this.syncSelectedHighlight();
            this.cb.onOpenReader?.(ev);
          }
        });
      });
    }

    if (prevScrollTop > 0) {
      listEl.scrollTop = prevScrollTop;
    }
  }

  private matchesThreadPrompt(
    prompt: PendingHumanPrompt,
    thread: ThreadSelection
  ): boolean {
    if (thread.kind === "all") return true;
    if (thread.kind === "agent") return prompt.agentId === thread.agentId;
    if (thread.kind === "cluster") {
      return thread.runId
        ? prompt.agentId === thread.runId
        : thread.agentIds.includes(prompt.agentId);
    }
    if (thread.kind === "pair") {
      return (
        prompt.agentId === thread.a ||
        prompt.agentId === thread.b ||
        Boolean(thread.aIds?.includes(prompt.agentId)) ||
        Boolean(thread.bIds?.includes(prompt.agentId))
      );
    }
    return true;
  }

  private syncSmsPromptDockVisibility(hasMultiple: boolean): void {
    this.smsPromptToggleBtn.setAttribute(
      "aria-expanded",
      this.smsPromptDockCollapsed ? "false" : "true"
    );
    const chev = this.smsPromptToggleBtn.querySelector(".sms-prompt-chevron");
    if (chev) chev.textContent = this.smsPromptDockCollapsed ? "▸" : "▾";
    this.smsPromptTabsEl.hidden = this.smsPromptDockCollapsed || !hasMultiple;
    this.smsInlinePromptsEl.hidden = this.smsPromptDockCollapsed;
  }

  private reconcileInlineSmsPrompts(thread: ThreadSelection): void {
    const matching = this.pendingPrompts.filter((p) =>
      this.matchesThreadPrompt(p, thread)
    );
    const activeIds = new Set(matching.map((p) => p.id));

    for (const [id, entry] of this.inlineQuestionCards.entries()) {
      if (!activeIds.has(id)) {
        entry.card.dispose();
        entry.wrap.remove();
        this.inlineQuestionCards.delete(id);
      }
    }

    if (matching.length === 0) {
      this.smsPromptDockEl.hidden = true;
      this.activeSmsPromptId = null;
      this.lastSmsTabsKey = "";
      this.smsPromptTabsEl.hidden = true;
      this.smsPromptTabsEl.innerHTML = "";
      return;
    }

    if (!this.activeSmsPromptId || !activeIds.has(this.activeSmsPromptId)) {
      this.activeSmsPromptId = matching[0]!.id;
    }
    const activePrompt =
      matching.find((p) => p.id === this.activeSmsPromptId) ?? matching[0]!;

    const hasMultiple = matching.length > 1;
    this.smsPromptDockEl.hidden = false;
    this.smsPromptBadgeTextEl.textContent = hasMultiple
      ? `Waiting (${matching.length})`
      : "Waiting on you";
    this.smsPromptTitleEl.textContent = cleanSummaryText(activePrompt.title);

    if (hasMultiple) {
      const nextTabsKey =
        matching
          .map(
            (p) =>
              `${p.id}:${formatActorName(p.agentId, this.labelMap, p.agentLabel)}:${Boolean(p.directReply)}`
          )
          .join("|") + `|${activePrompt.id}`;
      if (nextTabsKey !== this.lastSmsTabsKey) {
        this.lastSmsTabsKey = nextTabsKey;
        this.smsPromptTabsEl.innerHTML = matching
          .map((p) => {
            const isSel = p.id === activePrompt.id;
            const label = formatActorName(p.agentId, this.labelMap, p.agentLabel);
            return `
              <button
                type="button"
                role="tab"
                class="sms-prompt-tab ${p.directReply ? "is-direct-reply" : ""}"
                data-sms-prompt-tab="${escHtml(p.id)}"
                id="${smsPromptTabDomId(p.id)}"
                aria-controls="${smsPromptPanelDomId(p.id)}"
                aria-selected="${isSel ? "true" : "false"}"
                tabindex="${isSel ? "0" : "-1"}"
                title="${escHtml(cleanSummaryText(p.title))}"
              >
                <span>${escHtml(label)}</span>
              </button>
            `;
          })
          .join("");
      }
    } else if (this.lastSmsTabsKey !== "") {
      this.lastSmsTabsKey = "";
      this.smsPromptTabsEl.innerHTML = "";
    }

    this.syncSmsPromptDockVisibility(hasMultiple);

    const getCaps =
      this.cb.getReplyCapabilities ??
      (() => ({ canSendMessage: false, isMcpApp: false, isEmbed: false }));
    const onReply =
      this.cb.onReplyToHost ??
      (async (req: ReplyToHostRequest): Promise<ReplyToHostResult> => ({
        ok: false,
        mode: "error",
        message: `Reply handler unavailable for ${req.agentId}`,
      }));

    for (const prompt of matching) {
      const isVisible = prompt.id === activePrompt.id;
      const existing = this.inlineQuestionCards.get(prompt.id);
      if (existing) {
        existing.wrap.hidden = !isVisible;
        existing.card.update({
          prompt,
          sessionId: this.sessionId,
          compact: false,
          showHeader: true,
          getCapabilities: getCaps,
          onReply,
          onCancel: this.cb.onCancelPrompt,
        });
      } else {
        const wrap = document.createElement("div");
        wrap.className = "sms-inline-prompt-item";
        wrap.id = smsPromptPanelDomId(prompt.id);
        wrap.setAttribute("role", "tabpanel");
        wrap.setAttribute("aria-labelledby", smsPromptTabDomId(prompt.id));
        wrap.hidden = !isVisible;
        this.smsInlinePromptsEl.appendChild(wrap);
        const card = new QuestionCard(wrap, {
          prompt,
          sessionId: this.sessionId,
          compact: false,
          showHeader: true,
          getCapabilities: getCaps,
          onReply,
          onCancel: this.cb.onCancelPrompt,
        });
        this.inlineQuestionCards.set(prompt.id, { wrap, card });
      }
    }
  }

  private decorateUsageCards(): void {
    const agentById = new Map(this.agents.map((a) => [a.id, a]));
    const cards = Array.from(
      this.feedListEl.querySelectorAll<HTMLElement>(".usage-agent-card[data-usage-agent-id]")
    );
    for (const card of cards) {
      const aid = card.dataset.usageAgentId;
      if (!aid || card.parentElement?.classList.contains("usage-agent-shell")) continue;
      const agent = agentById.get(aid);
      const hasPending = Boolean(agent?.pendingPrompt);
      if (!hasPending) continue;

      const shell = document.createElement("div");
      shell.className = "usage-agent-shell has-pending-prompt";
      card.parentNode?.insertBefore(shell, card);
      shell.appendChild(card);

      const actions = document.createElement("div");
      actions.className = "usage-agent-actions";
      actions.innerHTML = `
        <button type="button" class="needs-input-badge" data-usage-open-messages="${escHtml(aid)}" aria-label="Needs input — view in messages for ${escHtml(formatActorName(aid, this.labelMap, agent?.label))}"><span aria-hidden="true">?</span> Needs Input</button>
      `;
      shell.appendChild(actions);
    }
  }
}
