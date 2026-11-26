import {
  extractSmsStream,
  type SmsStreamEntry,
  type TeamAgentCluster,
  type ThreadSelection,
} from "../state/topologyGrouping.js";
import type {
  AgentNodeSnapshot,
  NormalizedEvent,
  PendingHumanPrompt,
  SessionUsageSummary,
} from "../types.js";
import {
  classifyEventReadable,
  cleanSummaryText,
  escHtml,
  fmtClock,
  fmtTokens,
  formatActorName,
  getIdeMeta,
  isErrorEvent,
  isRoutineToolEnd,
  truncateWords,
} from "../utils.js";
import { renderInlineMarkdown } from "../utils/markdown.js";
import { UsageDashboard } from "./UsageDashboard.js";

export type FeedFilter = "all" | "messages" | "board" | "errors" | "usage";
export type FeedMode = "summary" | "detailed";

const FEED_MODE_STORAGE_KEY = "agent-studio:feed-mode";
const FEED_FILTER_STORAGE_KEY = "agent-studio:feed-filter";

const ALL_THREAD: ThreadSelection = {
  key: "all",
  kind: "all",
  label: "All Session Messages",
  route: "All Session Messages",
};

export interface ActivityFeedCallbacks {
  onSelectEvent: (event: NormalizedEvent) => void;
  onSelectAgent?: (agentId: string) => void;
  onOpenReader?: (event: NormalizedEvent) => void;
  onThreadChange?: (threadKey: string | null) => void;
  onCoverBackToTopology?: () => void;
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

export class ActivityFeed {
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
  private usageDashboard: UsageDashboard | null = null;

  private activeThread: ThreadSelection = ALL_THREAD;
  private selectedRunId = "all";
  private expandedBursts = new Set<string>();
  private expandedBubbleTools = new Set<string>();
  private drawerScrollTops = new Map<string, number>();
  private isNearBottom = true;
  private unseenCount = 0;
  private lastSmsCount = 0;
  private lastSmsContextKey = "";
  private lastSmsHtml = "";

  private lastPendingHtml = "";
  private lastListHtml = "";
  private lastListContextKey = "";

  private smsPillBarEl: HTMLElement;
  private runFilterBarEl: HTMLElement;
  private feedListEl: HTMLElement;
  private smsBodyWrapEl: HTMLElement;
  private smsBodyEl: HTMLElement;
  private jumpLatestBtn: HTMLButtonElement;

  constructor(container: HTMLElement, cb: ActivityFeedCallbacks) {
    this.container = container;
    this.cb = cb;

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
        <div class="run-top-right">
          <button type="button" class="btn-ghost" data-clear-pill hidden>✕ Show All Messages</button>
        </div>
      </div>
      <div class="run-filter-bar" data-run-filter-bar role="group" aria-label="Filter messages by agent run" hidden></div>
      <div class="feed-list" data-feed-list></div>
      <div class="sms-body-wrap" data-sms-body-wrap hidden>
        <div class="sms-body" data-sms-body aria-live="polite"></div>
        <button type="button" class="jump-latest-btn" data-jump-latest hidden>↓ Jump to latest</button>
      </div>
    `;

    this.smsPillBarEl = this.container.querySelector("[data-sms-pill-bar]") as HTMLElement;
    this.runFilterBarEl = this.container.querySelector("[data-run-filter-bar]") as HTMLElement;
    this.feedListEl = this.container.querySelector("[data-feed-list]") as HTMLElement;
    this.smsBodyWrapEl = this.container.querySelector("[data-sms-body-wrap]") as HTMLElement;
    this.smsBodyEl = this.container.querySelector("[data-sms-body]") as HTMLElement;
    this.jumpLatestBtn = this.container.querySelector("[data-jump-latest]") as HTMLButtonElement;

    this.bindEvents();
  }

  private bindEvents(): void {
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

    this.jumpLatestBtn.addEventListener("click", () => {
      this.smsBodyEl.scrollTo({
        top: this.smsBodyEl.scrollHeight,
        behavior: "smooth",
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

      const readBtn = target.closest<HTMLButtonElement>("[data-sms-read]");
      if (!readBtn) return;
      const evId = readBtn.dataset.smsRead;
      if (!evId) return;
      const ev = this.events.find((x) => x.id === evId);
      if (ev) {
        this.selectedEventId = ev.id;
        this.cb.onOpenReader?.(ev);
      }
    });
  }

  private syncFilterTabs(): void {
    this.container.querySelectorAll<HTMLButtonElement>("[data-feed-filter]").forEach((b) => {
      b.setAttribute("aria-selected", b.dataset.feedFilter === this.filter ? "true" : "false");
    });
  }

  public openThread(selection: ThreadSelection): boolean {
    const requestedRun = selection.kind === "cluster" ? selection.runId || "all" : "all";
    // Re-clicking the exact active pill clears the filter cleanly
    if (
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
    this.syncFilterTabs();
    this.cb.onThreadChange?.(selection.key);
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
      this.renderPending();
    }
    this.renderList();
  }

  public setSelectedEvent(eventId: string | null): void {
    this.selectedEventId = eventId;
    this.syncSelectedHighlight();
  }

  public resetScroll(): void {
    this.lastListContextKey = "";
    this.lastSmsContextKey = "";
    this.lastSmsHtml = "";
    this.activeThread = ALL_THREAD;
    this.selectedRunId = "all";
    this.expandedBursts.clear();
    this.expandedBubbleTools.clear();
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

  public update(
    events: NormalizedEvent[],
    pendingPrompts: PendingHumanPrompt[] = [],
    labelMap?: Map<string, string>,
    agents?: AgentNodeSnapshot[],
    sessionUsage?: SessionUsageSummary,
    clusters?: TeamAgentCluster[]
  ): void {
    this.events = events;
    this.pendingPrompts = pendingPrompts;
    if (labelMap) this.labelMap = labelMap;
    if (agents) this.agents = agents;
    if (clusters) this.clusters = clusters;
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
              <span class="pending-badge">${p.kind === "approval" ? "APPROVAL NEEDED" : "WAITING ON USER"}</span>
              <span class="pending-agent">${escHtml(formatActorName(p.agentId, this.labelMap, p.agentLabel))}</span>
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
    const openGroups = m.toolGroups.filter((g) =>
      this.expandedBubbleTools.has(`${m.event.id}|${g.extId}`)
    );
    const drawerKey = `msg:${m.event.id}`;

    return `
      <article class="bubble ${m.dir}" data-sms-ev-id="${escHtml(m.event.id)}" style="--bubble-accent:${escHtml(m.accentColor)}">
        ${showRouteBadge ? `<span class="bubble-route">${escHtml(m.routeLabel)}</span>` : ""}
        <div class="bubble-head">
          <span class="bubble-sender">${escHtml(m.fromLabel)} <span class="bubble-role">${escHtml(m.roleBadge)}</span></span>
          <span>${escHtml(m.timeLabel)}</span>
        </div>
        <div class="bubble-text">${renderInlineMarkdown(m.text)}</div>
        ${
          m.toolGroups.length > 0 || m.hasFullBody
            ? `<div class="bubble-foot">
                <div class="bubble-tools">${m.toolGroups
                  .map((g) => {
                    const chipKey = `${m.event.id}|${g.extId}`;
                    const isChipOpen = this.expandedBubbleTools.has(chipKey);
                    const catHasErr = g.events.some(isErrorEvent);
                    return `<button type="button" class="tool-badge tool-badge-btn ${catHasErr ? "has-error" : ""} ${isChipOpen ? "is-expanded" : ""}" data-bubble-tools-toggle="${escHtml(chipKey)}" aria-expanded="${isChipOpen ? "true" : "false"}">${escHtml(g.label)} · ${g.count} <span aria-hidden="true">${isChipOpen ? "▾" : "▸"}</span></button>`;
                  })
                  .join("")}</div>
                ${
                  m.hasFullBody
                    ? `<button type="button" class="read-full-btn" data-sms-read="${escHtml(m.event.id)}">Read full →</button>`
                    : ""
                }
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
    const pendingBar = this.container.querySelector<HTMLElement>("[data-pending-bar]");
    if (pendingBar && !pendingBar.hidden) {
      pendingBar.hidden = true;
    }

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

    const streamEntries = extractSmsStream({
      events: this.events,
      agents: this.agents,
      thread: effectiveThread,
      labelMap: this.labelMap,
      clusters: this.clusters,
    });
    const msgCount = streamEntries.filter((e) => e.kind === "message").length;
    const burstCount = streamEntries.filter((e) => e.kind === "tool_burst").length;
    const burstSuffix =
      burstCount > 0 ? ` · ${burstCount} tool ${burstCount === 1 ? "burst" : "bursts"}` : "";

    if (hintEl) {
      hintEl.textContent = hasSpecificPill
        ? `${msgCount} ${msgCount === 1 ? "msg" : "msgs"} in thread${burstSuffix}`
        : `${msgCount} total msgs${burstSuffix} · chronological`;
    }
    if (countEl) {
      countEl.textContent = `${msgCount} ${msgCount === 1 ? "msg" : "msgs"}${burstCount > 0 ? ` · ${burstCount} ${burstCount === 1 ? "burst" : "bursts"}` : ""}`;
      countEl.title = `Showing ${msgCount} SMS messages and ${burstCount} grouped tool bursts`;
    }

    const contextKey = `${effectiveThread.key}|${this.selectedRunId}`;
    const dividerLabel =
      effectiveThread.kind === "all"
        ? "All Session Messages · Chronological Stream"
        : `${effectiveThread.route} · Conversation Thread`;

    const html = `
      <div class="sms-day-divider">${escHtml(dividerLabel)}</div>
      ${
        streamEntries.length === 0
          ? `<div class="sms-day-divider">No messages recorded for this selection yet.</div>`
          : streamEntries
              .map((entry) =>
                this.renderSmsStreamEntryHtml(entry, effectiveThread.kind === "all")
              )
              .join("")
      }
    `;

    const sameContext = contextKey === this.lastSmsContextKey;
    if (sameContext && html === this.lastSmsHtml) {
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
      this.smsBodyEl
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

    this.smsBodyEl.innerHTML = html;
    this.lastSmsHtml = html;
    this.lastSmsContextKey = contextKey;
    this.lastSmsCount = msgCount;

    const activeDrawerKeys = new Set<string>();
    this.smsBodyEl
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
}
