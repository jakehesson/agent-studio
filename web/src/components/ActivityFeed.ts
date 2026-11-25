import type {
  AgentNodeSnapshot,
  NormalizedEvent,
  PendingHumanPrompt,
  SessionUsageSummary,
} from "../types.js";
import { UsageDashboard } from "./UsageDashboard.js";
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

export type FeedFilter = "all" | "messages" | "tools" | "board" | "errors" | "usage";
export type FeedMode = "summary" | "detailed";

const FEED_MODE_STORAGE_KEY = "agent-studio:feed-mode";

export interface ActivityFeedCallbacks {
  onSelectEvent: (event: NormalizedEvent) => void;
  onSelectAgent?: (agentId: string) => void;
  onOpenReader?: (event: NormalizedEvent) => void;
}

const FILTER_TABS: Array<{ id: FeedFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "messages", label: "Messages" },
  { id: "tools", label: "Tools" },
  { id: "board", label: "Board" },
  { id: "errors", label: "Errors" },
  { id: "usage", label: "Usage" },
];

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
  return !s || s === "thinking…" || s === "thinking..." || s === "reasoning…" || s === "reasoning..." || s === "thinking";
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
    .replace(/^(read|inspect|inspected|reading|search|searched|glob|grep|list|listed)\s+(file\s+)?/i, "")
    .trim();
  const pathMatch = /([A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6})/.exec(summary);
  if (pathMatch?.[1]) return pathMatch[1];
  return truncateWords(summary || ev.toolName || "file", 28);
}

export class ActivityFeed {
  private container: HTMLElement;
  private cb: ActivityFeedCallbacks;
  private filter: FeedFilter = "all";
  private mode: FeedMode = loadSavedMode();
  private selectedEventId: string | null = null;
  private agentFilter: string | null = null;
  private events: NormalizedEvent[] = [];
  private pendingPrompts: PendingHumanPrompt[] = [];
  private labelMap: Map<string, string> = new Map();
  private agents: AgentNodeSnapshot[] = [];
  private sessionUsage: SessionUsageSummary | undefined = undefined;
  private usageDashboard: UsageDashboard | null = null;

  constructor(container: HTMLElement, cb: ActivityFeedCallbacks) {
    this.container = container;
    this.cb = cb;

    this.container.innerHTML = `
      <div class="card-head">
        <span class="card-title">Live Activity Stream</span>
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
              aria-selected="${f.id === "all" ? "true" : "false"}"
            >${escHtml(f.label)}</button>
          `
        ).join("")}
      </div>
      <div class="feed-list" data-feed-list></div>
    `;

    this.container.querySelectorAll<HTMLButtonElement>("[data-feed-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.feedFilter as FeedFilter | undefined;
        if (!next) return;
        this.filter = next;
        this.container
          .querySelectorAll<HTMLButtonElement>("[data-feed-filter]")
          .forEach((b) => b.setAttribute("aria-selected", b === btn ? "true" : "false"));
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
  }

  public setAgentFilter(agentId: string | null): void {
    this.agentFilter = agentId;
    this.renderList();
  }

  public setSelectedEvent(eventId: string | null): void {
    this.selectedEventId = eventId;
    this.syncSelectedHighlight();
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
  }

  public update(
    events: NormalizedEvent[],
    pendingPrompts: PendingHumanPrompt[] = [],
    labelMap?: Map<string, string>,
    agents?: AgentNodeSnapshot[],
    sessionUsage?: SessionUsageSummary
  ): void {
    this.events = events;
    this.pendingPrompts = pendingPrompts;
    if (labelMap) this.labelMap = labelMap;
    if (agents) this.agents = agents;
    this.sessionUsage = sessionUsage;
    this.renderPending();
    this.renderList();
  }

  private renderPending(): void {
    const bar = this.container.querySelector("[data-pending-bar]") as HTMLElement | null;
    if (!bar) return;
    if (this.pendingPrompts.length === 0) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    bar.innerHTML = this.pendingPrompts
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
      case "tools":
        return ev.kind === "tool_start" || ev.kind === "tool_end";
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

    // Summary mode: suppress routine successful tool_end duplicates & placeholder thinking_start
    const keyEvents = filteredRaw.filter(
      (ev) => !isRoutineToolEnd(ev) && !isPlaceholderThinking(ev)
    );

    const rows: DisplayFeedRow[] = [];
    let i = 0;
    while (i < keyEvents.length) {
      const ev = keyEvents[i]!;
      const cls = classifyEventReadable(ev);

      // Collapse >= 2 consecutive read events from the same agentId when viewing "All"
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

  private renderList(): void {
    const listEl = this.container.querySelector("[data-feed-list]") as HTMLElement | null;
    const countEl = this.container.querySelector<HTMLElement>("[data-feed-count]");
    const modeToggle = this.container.querySelector<HTMLElement>(".feed-mode-toggle");
    if (!listEl) return;

    if (this.filter === "usage") {
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

    if (displayRows.length === 0) {
      listEl.innerHTML = `<div class="empty-state">No events match this filter yet.</div>`;
      return;
    }

    // Show newest first (capped to last 200 for fast DOM updates)
    const visible = displayRows.slice(-200).reverse();
    listEl.innerHTML = visible
      .map((row) => {
        const ev = row.primaryEvent;
        const ide = getIdeMeta(ev.ide);
        const isSel = ev.id === this.selectedEventId;
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
            class="ev-item ${row.cssClass} ${row.isLowSignal ? "ev-low-signal" : ""} ${isSel ? "selected" : ""}"
            data-ev-id="${escHtml(ev.id)}"
          >
            <button
              type="button"
              class="ev-row-btn"
              aria-pressed="${isSel ? "true" : "false"}"
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
}
