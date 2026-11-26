import {
  buildTopologyModel,
  type ClusterRunItem,
  type TeamAgentCluster,
  type ThreadSelection,
  type TopologyModel,
} from "../state/topologyGrouping.js";
import type {
  AgentEdgeSnapshot,
  AgentNodeSnapshot,
  NormalizedEvent,
  TeamDefinitionEntry,
  TeamRosterRef,
} from "../types.js";
import {
  cleanSummaryText,
  colorForEventKind,
  escHtml,
  fmtDuration,
  getIdeMeta,
  trunc,
} from "../utils.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW_MODE_KEY = "agentStudio.topologyViewMode";
const CARD_STYLE_KEY = "agentStudio.groupedCardStyle.v2";

function safeStoreGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStoreSet(key: string, val: string): void {
  try {
    window.localStorage.setItem(key, val);
  } catch {
    // Ignore storage restrictions in sandboxed webviews/iframes
  }
}

function safeStoreDel(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage restrictions
  }
}

export interface TopologyRenderMeta {
  events?: NormalizedEvent[];
  definitions?: TeamDefinitionEntry[];
  teamRoster?: TeamRosterRef[];
  labelMap?: Map<string, string>;
}

export interface TopologyCallbacks {
  onSelectAgent: (agentId: string | null) => void;
  onSelectThread?: (selection: ThreadSelection) => void;
  onOpenChat?: (agentId: string) => void;
}

interface MeshPositionedNode {
  id: string;
  agentId: string;
  label: string;
  x: number;
  y: number;
  color: string;
  isCore?: boolean;
  isHuman?: boolean;
  isBusy?: boolean;
  isDone?: boolean;
  hasPendingPrompt?: boolean;
  msgs: number;
  threadSelection: ThreadSelection;
}

export class TopologySvg {
  private container: HTMLElement;
  private cb: TopologyCallbacks;

  private stageEl: HTMLElement;
  private groupedTreeEl: HTMLElement;
  private busSvg: SVGSVGElement;
  private busPillsLayer: HTMLElement;
  private meshViewEl: HTMLElement;
  private meshWrapEl: HTMLElement;
  private meshSvg: SVGSVGElement;
  private filterStripEl: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;
  private busRafId: number | null = null;

  private manualMode: "grouped" | "mesh" | null = null;
  private viewMode: "grouped" | "mesh" = "mesh";
  private cardStyle: "basic" | "detailed" = "basic";
  private statusFilter: "all" | "active" | "done" = "all";
  private extFilter: string | null = null;
  private expandedDone = new Set<string>();

  private selectedId: string | null = null;
  private activeThreadKey: string | null = null;
  private lastAgents: AgentNodeSnapshot[] = [];
  private lastEdges: AgentEdgeSnapshot[] = [];
  private lastCounters:
    | { toolCalls: number; messages: number; activeAgents: number }
    | undefined;
  private lastMeta: TopologyRenderMeta = {};
  private threadLookup = new Map<string, ThreadSelection>();
  private meshNodePos = new Map<string, { x: number; y: number }>();
  private lastFilterHtml = "";
  private lastRootHtml = "";
  private lastActiveGridHtml = "";
  private lastDoneGridHtml = "";
  private lastExtHtml = "";
  private lastMeshHtml = "";
  private lastRenderedStyle: "basic" | "detailed" = "basic";
  private lastRenderedMode: "grouped" | "mesh" = "mesh";

  private viewState = {
    x: 0,
    y: 0,
    w: 880,
    h: 540,
    baseW: 880,
    baseH: 540,
    userModified: false,
  };

  private isPanning = false;
  private panStart = { x: 0, y: 0, vx: 0, vy: 0 };
  private tickTimer: number | null = null;

  constructor(container: HTMLElement, cb: TopologyCallbacks) {
    this.container = container;
    this.cb = cb;

    const savedMode = safeStoreGet(VIEW_MODE_KEY);
    if (savedMode === "grouped" || savedMode === "mesh") {
      this.manualMode = savedMode;
    }
    const savedStyle = safeStoreGet(CARD_STYLE_KEY);
    if (savedStyle === "basic" || savedStyle === "detailed") {
      this.cardStyle = savedStyle;
    }

    this.container.innerHTML = `
      <div class="card-head topo-head">
        <div class="topo-head-left">
          <span class="card-title">Agent Topology</span>
          <div class="legend" aria-label="Status legend">
            <span><i class="sw" style="background:#c084fc"></i>Thinking</span>
            <span><i class="sw" style="background:#f59e0b"></i>Working</span>
            <span><i class="sw" style="background:#06b6d4"></i>Waiting</span>
            <span><i class="sw" style="background:#f43f5e"></i>Blocked</span>
            <span><i class="sw" style="background:#10b981"></i>Done</span>
          </div>
        </div>
        <div class="topo-head-right">
          <span class="auto-pill" data-mode-badge hidden>Auto</span>
          <button type="button" class="btn-ghost" data-reset-auto hidden title="Return to Auto-Smart topology mode">Reset Auto</button>
          <div class="seg-group" data-style-switch role="group" aria-label="Grouped card detail style">
            <button type="button" class="seg-btn" data-card-style="basic" aria-pressed="true">Basic</button>
            <button type="button" class="seg-btn" data-card-style="detailed" aria-pressed="false">Detailed</button>
          </div>
          <div class="seg-group" role="group" aria-label="Topology view mode">
            <button type="button" class="seg-btn" data-view-mode="grouped" aria-pressed="false">Grouped</button>
            <button type="button" class="seg-btn" data-view-mode="mesh" aria-pressed="true">Mesh</button>
          </div>
          <div class="zoom-bar" data-zoom-bar role="group" aria-label="Canvas zoom controls">
            <button type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>
            <button type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
            <button type="button" data-zoom="fit" title="Reset view to fit">Fit</button>
          </div>
          <button type="button" class="fs-btn" data-clear-agent hidden>Clear Filter</button>
        </div>
      </div>

      <div class="filter-strip" data-topo-filter-strip role="group" aria-label="Filter topology roles and systems"></div>

      <div
        class="topo-stage"
        data-topo-stage
        role="region"
        tabindex="0"
        aria-label="Interactive multi-agent topology"
      >
        <div class="grouped-tree is-basic" data-grouped-tree hidden>
          <svg class="bus-svg" data-bus-svg aria-hidden="true"></svg>
          <div class="bus-pills-layer" data-bus-pills></div>
          <div class="root-row" data-root-row></div>
          <section class="swimlane" data-lane-active aria-label="Active and waiting clusters" hidden>
            <div class="swimlane-head" data-lane-active-head>Active / Working</div>
            <div class="cluster-grid" data-active-cluster-grid></div>
          </section>
          <section class="swimlane" data-lane-completed aria-label="Completed and standby clusters" hidden>
            <div class="swimlane-head" data-lane-done-head>Completed / Standby</div>
            <div class="cluster-grid" data-done-cluster-grid></div>
          </section>
          <section class="swimlane" data-lane-external aria-label="External systems and MCP tools" hidden>
            <div class="swimlane-head">External Systems &amp; MCP Tools</div>
            <div class="ext-lane-cards" data-ext-lane-cards></div>
          </section>
        </div>

        <div class="mesh-view" data-mesh-view hidden>
          <div class="mesh-banner">
            <span><strong>Radial Ring Mesh:</strong> Core, Active &amp; Standby rings with <strong>cross-agent peer arcs</strong> &amp; clickable <code>[N msg]</code> pills.</span>
            <button type="button" class="btn-ghost" data-switch-grouped>Switch to Grouped</button>
          </div>
          <div
            class="graph-wrap mesh-canvas-wrap"
            data-graph-wrap
            role="region"
            tabindex="0"
            aria-label="Radial ring multi-agent mesh diagram"
          >
            <svg
              class="topo-svg mesh-svg"
              data-topo-svg
              viewBox="0 0 880 540"
              preserveAspectRatio="xMidYMid meet"
            ></svg>
          </div>
        </div>

        <div class="topo-empty-overlay" data-topo-empty hidden>
          Waiting for agent activity… Send a prompt or click <strong>Doctor → Send Test Event</strong>.
        </div>
      </div>

      <div class="summary-strip" data-summary-strip>
        <div><span>Agents</span><b data-kpi-agents>0</b></div>
        <div><span>Active</span><b data-kpi-active>0</b></div>
        <div><span>Tool Calls</span><b data-kpi-tools>0</b></div>
        <button
          type="button"
          class="kpi-btn"
          data-kpi-msgs-btn
          aria-label="Open all session messages in Messages tab"
        >
          <span>Messages ↗</span>
          <b data-kpi-msgs>0</b>
        </button>
      </div>
    `;

    this.stageEl = this.container.querySelector("[data-topo-stage]") as HTMLElement;
    this.groupedTreeEl = this.container.querySelector("[data-grouped-tree]") as HTMLElement;
    this.busSvg = this.container.querySelector("[data-bus-svg]") as SVGSVGElement;
    this.busPillsLayer = this.container.querySelector("[data-bus-pills]") as HTMLElement;
    this.meshViewEl = this.container.querySelector("[data-mesh-view]") as HTMLElement;
    this.meshWrapEl = this.container.querySelector("[data-graph-wrap]") as HTMLElement;
    this.meshSvg = this.container.querySelector("[data-topo-svg]") as SVGSVGElement;
    this.filterStripEl = this.container.querySelector("[data-topo-filter-strip]") as HTMLElement;

    this.bindInteractions();

    if ("ResizeObserver" in window) {
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.groupedTreeEl.hidden) {
          this.scheduleBusDraw();
        }
      });
      this.resizeObserver.observe(this.groupedTreeEl);
    }

    this.tickTimer = window.setInterval(() => {
      if (this.lastAgents.some((a) => a.status === "THINKING")) {
        this.updateThinkingTimers();
      }
    }, 1000);
  }

  public dispose(): void {
    if (this.tickTimer != null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.busRafId != null) {
      window.cancelAnimationFrame(this.busRafId);
      this.busRafId = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  public setSelectedAgent(agentId: string | null): void {
    this.selectedId = agentId;
    const clearBtn = this.container.querySelector<HTMLButtonElement>("[data-clear-agent]");
    if (clearBtn) clearBtn.hidden = !agentId;
    this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
  }

  public setActiveThreadKey(threadKey: string | null): void {
    if (this.activeThreadKey === threadKey) return;
    this.activeThreadKey = threadKey;
    if (this.viewMode === "mesh" && this.lastAgents.length > 0) {
      this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
    } else {
      this.syncActiveThreadHighlights();
    }
  }

  public resetSessionState(): void {
    this.selectedId = null;
    this.activeThreadKey = null;
    this.statusFilter = "all";
    this.extFilter = null;
    this.expandedDone.clear();
    this.lastFilterHtml = "";
    this.lastRootHtml = "";
    this.lastActiveGridHtml = "";
    this.lastDoneGridHtml = "";
    this.lastExtHtml = "";
    this.lastMeshHtml = "";
    this.fitGraph();
    const clearBtn = this.container.querySelector<HTMLButtonElement>("[data-clear-agent]");
    if (clearBtn) clearBtn.hidden = true;
  }

  public resetView(): void {
    this.fitGraph();
  }

  public refreshLayout(): void {
    if (!this.groupedTreeEl.hidden) {
      this.scheduleBusDraw();
    }
  }

  public render(
    agents: AgentNodeSnapshot[],
    edges: AgentEdgeSnapshot[],
    counters?: { toolCalls: number; messages: number; activeAgents: number },
    meta?: TopologyRenderMeta
  ): void {
    this.lastAgents = agents;
    this.lastEdges = edges;
    this.lastCounters = counters;
    if (meta) this.lastMeta = meta;

    const prevScrollTop = this.stageEl.scrollTop;
    const prevScrollLeft = this.stageEl.scrollLeft;

    const model = buildTopologyModel({
      agents,
      edges,
      events: this.lastMeta.events ?? [],
      teamRoster: this.lastMeta.teamRoster,
      definitions: this.lastMeta.definitions,
      labelMap: this.lastMeta.labelMap,
    });

    // Auto-Smart view mode unless user set manual preference
    this.viewMode = this.manualMode ?? model.autoMode;
    this.syncHeaderControls(model);

    // Update KPI strip
    const activeCount =
      counters?.activeAgents ??
      agents.filter(
        (a) =>
          (a.nodeType ?? "agent") === "agent" &&
          (a.status === "THINKING" || a.status === "WORKING" || a.status === "WAITING")
      ).length;
    const toolCount =
      counters?.toolCalls ??
      agents
        .filter((a) => (a.nodeType ?? "agent") === "agent")
        .reduce((sum, a) => sum + (a.toolCalls || 0), 0);
    const msgCount =
      counters?.messages ??
      agents
        .filter((a) => (a.nodeType ?? "agent") === "agent")
        .reduce((sum, a) => sum + (a.messagesSent || 0), 0);

    const setTxt = (sel: string, val: string) => {
      const el = this.container.querySelector(sel);
      if (el) el.textContent = val;
    };
    setTxt("[data-kpi-agents]", String(model.totalAiAgents));
    setTxt("[data-kpi-active]", String(activeCount));
    setTxt("[data-kpi-tools]", String(toolCount));
    setTxt("[data-kpi-msgs]", String(msgCount));

    const kpiBtn = this.container.querySelector<HTMLButtonElement>("[data-kpi-msgs-btn]");
    if (kpiBtn) {
      kpiBtn.setAttribute("aria-label", `Open all ${msgCount} session messages in Messages tab`);
    }

    const emptyOverlay = this.container.querySelector<HTMLElement>("[data-topo-empty]");
    if (agents.length === 0) {
      this.groupedTreeEl.hidden = true;
      this.meshViewEl.hidden = true;
      if (emptyOverlay) emptyOverlay.hidden = false;
      this.renderFilterStrip(model);
      return;
    }
    if (emptyOverlay) emptyOverlay.hidden = true;

    this.rebuildThreadLookup(model);
    this.renderFilterStrip(model);

    if (this.viewMode === "grouped") {
      this.groupedTreeEl.hidden = false;
      this.meshViewEl.hidden = true;
      this.renderGrouped(model);
    } else {
      this.groupedTreeEl.hidden = true;
      this.meshViewEl.hidden = false;
      this.renderMesh(model);
    }

    this.syncActiveThreadHighlights();

    if (prevScrollTop > 0) this.stageEl.scrollTop = prevScrollTop;
    if (prevScrollLeft > 0) this.stageEl.scrollLeft = prevScrollLeft;
  }

  public animatePacket(ev: NormalizedEvent): void {
    if (this.viewMode !== "mesh") return;
    const fromId = ev.kind === "user_input" ? "ext:human" : ev.agentId;
    const toId = ev.kind === "user_input" ? ev.agentId : ev.targetAgentId;
    if (!fromId || !toId || fromId === toId) return;

    const na = this.meshNodePos.get(fromId);
    const nb = this.meshNodePos.get(toId);
    const pg = this.meshSvg.querySelector("#topoPackets");
    if (!na || !nb || !pg) return;

    const mx = (na.x + nb.x) / 2;
    const my = (na.y + nb.y) / 2;
    const dx = nb.x - na.x;
    const dy = nb.y - na.y;
    const len = Math.hypot(dx, dy) || 1;
    const cx = mx - (dy / len) * 16;
    const cy = my + (dx / len) * 16;

    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("r", "5.5");
    dot.setAttribute("fill", colorForEventKind(ev.kind, ev.payload));
    dot.setAttribute("stroke", "#ffffff");
    dot.setAttribute("stroke-width", "1.4");
    pg.appendChild(dot);

    const t0 = performance.now();
    const dur = 740;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      const omt = 1 - e;
      const px = omt * omt * na.x + 2 * omt * e * cx + e * e * nb.x;
      const py = omt * omt * na.y + 2 * omt * e * cy + e * e * nb.y;
      dot.setAttribute("cx", px.toFixed(1));
      dot.setAttribute("cy", py.toFixed(1));
      dot.setAttribute("opacity", t > 0.85 ? String((1 - t) / 0.15) : "1");
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        dot.remove();
      }
    };
    requestAnimationFrame(step);
  }

  private syncHeaderControls(model: TopologyModel): void {
    const isGrouped = this.viewMode === "grouped";
    const isBasic = this.cardStyle === "basic";

    this.groupedTreeEl.classList.toggle("is-basic", isBasic);
    this.groupedTreeEl.classList.toggle("is-detailed", !isBasic);

    const styleSwitch = this.container.querySelector<HTMLElement>("[data-style-switch]");
    const zoomBar = this.container.querySelector<HTMLElement>("[data-zoom-bar]");
    const modeBadge = this.container.querySelector<HTMLElement>("[data-mode-badge]");
    const resetBtn = this.container.querySelector<HTMLButtonElement>("[data-reset-auto]");

    if (styleSwitch) styleSwitch.hidden = !isGrouped;
    if (zoomBar) zoomBar.hidden = isGrouped;

    this.container
      .querySelectorAll<HTMLButtonElement>("[data-view-mode]")
      .forEach((btn) => {
        btn.setAttribute("aria-pressed", String(btn.dataset.viewMode === this.viewMode));
      });
    this.container
      .querySelectorAll<HTMLButtonElement>("[data-card-style]")
      .forEach((btn) => {
        btn.setAttribute("aria-pressed", String(btn.dataset.cardStyle === this.cardStyle));
      });

    if (modeBadge) {
      if (model.totalAiAgents === 0) {
        modeBadge.hidden = true;
      } else {
        modeBadge.hidden = false;
        if (this.manualMode) {
          modeBadge.textContent = `Manual: ${isGrouped ? "Grouped" : "Mesh"}`;
        } else {
          modeBadge.textContent =
            model.autoMode === "grouped"
              ? `Auto: Grouped (${model.totalActors} actors)`
              : `Auto: Mesh (${model.totalActors})`;
        }
      }
    }

    if (resetBtn) {
      resetBtn.hidden = this.manualMode === null;
    }
  }

  private rebuildThreadLookup(model: TopologyModel): void {
    this.threadLookup.clear();
    this.threadLookup.set("all", {
      key: "all",
      kind: "all",
      label: "All Session Messages",
      route: "All Session Messages",
    });

    const rootLabel = model.rootAgent
      ? trunc(model.rootAgent.label || "Coordinator", 24)
      : "Coordinator";

    if (model.humanNode && model.rootAgent) {
      const key = `pair:${model.humanNode.id}|${model.rootAgent.id}`;
      this.threadLookup.set(key, {
        key,
        kind: "pair",
        a: model.humanNode.id,
        b: model.rootAgent.id,
        aIds: ["ext:human", "human", model.humanNode.id],
        bIds: [model.rootAgent.id],
        label: `User ↔ ${rootLabel}`,
        route: `User ↔ ${rootLabel}`,
      });
    }

    for (const c of model.clusters) {
      this.threadLookup.set(c.threadKey, {
        key: c.threadKey,
        kind: "cluster",
        clusterId: c.id,
        agentIds: c.agentIds,
        label: `${rootLabel} ↔ ${c.teamRole}`,
        route: `${rootLabel} ↔ ${c.teamRole}`,
        runs: c.runs,
      });
      for (const r of c.runs) {
        const runKey = `${c.threadKey}:${r.id}`;
        this.threadLookup.set(runKey, {
          key: runKey,
          kind: "cluster",
          clusterId: c.id,
          agentIds: c.agentIds,
          runId: r.id,
          label: `${rootLabel} ↔ ${r.displayId}`,
          route: `${rootLabel} ↔ ${r.displayId}`,
          runs: c.runs,
        });
      }
    }

    for (const p of model.peerLinks) {
      this.threadLookup.set(p.threadKey, {
        key: p.threadKey,
        kind: "pair",
        a: p.from,
        b: p.to,
        aIds: [p.from],
        bIds: [p.to],
        label: p.label,
        route: p.label,
      });
    }

    for (const a of this.lastAgents) {
      if ((a.nodeType ?? "agent") !== "agent") continue;
      const key = `agent:${a.id}`;
      const label = a.label || a.id;
      this.threadLookup.set(key, {
        key,
        kind: "agent",
        agentId: a.id,
        label: `${label} Messages`,
        route: label,
      });
    }
  }

  private renderFilterStrip(model: TopologyModel): void {
    const activeClusterCount = model.clusters.filter((c) => c.state !== "done").length;
    const doneClusterCount = model.clusters.filter((c) => c.state === "done").length;

    const chips: string[] = [
      `<button type="button" class="filter-chip" data-topo-filter="all" aria-pressed="${this.statusFilter === "all" && !this.extFilter}">All Roles (${model.totalActors})</button>`,
      `<button type="button" class="filter-chip" data-topo-filter="active" aria-pressed="${this.statusFilter === "active" && !this.extFilter}">Active &amp; Waiting (${activeClusterCount})</button>`,
      `<button type="button" class="filter-chip" data-topo-filter="done" aria-pressed="${this.statusFilter === "done" && !this.extFilter}">Completed (${doneClusterCount})</button>`,
      ...model.externalNodes.map((ext) => {
        const icon = ext.id.startsWith("ext:mcp:")
          ? "🔌"
          : ext.id === "ext:board"
            ? "📋"
            : ext.id === "ext:web"
              ? "🌐"
              : ext.id === "ext:shell"
                ? "⚡"
                : "📁";
        return `<button type="button" class="filter-chip" data-topo-filter="${escHtml(ext.id)}" aria-pressed="${this.extFilter === ext.id}">${icon} ${escHtml(ext.label)} · ${ext.toolCalls}</button>`;
      }),
    ];

    const nextFilterHtml = chips.join("");
    if (nextFilterHtml !== this.lastFilterHtml) {
      this.filterStripEl.innerHTML = nextFilterHtml;
      this.lastFilterHtml = nextFilterHtml;
    }
  }

  private clusterPassesFilter(c: TeamAgentCluster): boolean {
    if (this.extFilter && !c.extTools.includes(this.extFilter)) return false;
    if (this.statusFilter === "active") return c.state !== "done";
    if (this.statusFilter === "done") return c.state === "done";
    return true;
  }

  private renderGrouped(model: TopologyModel): void {
    const rootRowEl = this.groupedTreeEl.querySelector("[data-root-row]") as HTMLElement;
    const laneActive = this.groupedTreeEl.querySelector("[data-lane-active]") as HTMLElement;
    const laneCompleted = this.groupedTreeEl.querySelector("[data-lane-completed]") as HTMLElement;
    const laneExternal = this.groupedTreeEl.querySelector("[data-lane-external]") as HTMLElement;
    const activeGrid = this.groupedTreeEl.querySelector("[data-active-cluster-grid]") as HTMLElement;
    const doneGrid = this.groupedTreeEl.querySelector("[data-done-cluster-grid]") as HTMLElement;
    const extCardsEl = this.groupedTreeEl.querySelector("[data-ext-lane-cards]") as HTMLElement;

    const root = model.rootAgent;
    const human = model.humanNode;
    const rootId = root?.id ?? "root";
    const humanRootKey = human && root ? `pair:${human.id}|${root.id}` : "all";
    const totalMsgs =
      this.lastCounters?.messages ??
      this.lastAgents
        .filter((a) => (a.nodeType ?? "agent") === "agent")
        .reduce((s, a) => s + (a.messagesSent || 0), 0);

    // Root Row: User -> [N msg] -> Root Agent
    const rootParts: string[] = [];
    if (human) {
      const hSelected = this.selectedId === human.id;
      const hSummary = cleanSummaryText(human.summary) || "Session prompt root";
      rootParts.push(`
        <div class="node-card user-node ${hSelected ? "is-selected" : ""}" data-agent-id="${escHtml(human.id)}">
          <div class="cluster-head">
            <div class="cluster-title-wrap">
              <div class="cluster-name">
                <button type="button" class="card-select-btn" data-select-agent="${escHtml(human.id)}" aria-label="Inspect User details" aria-pressed="${hSelected ? "true" : "false"}">
                  <span class="status-dot done detail-only" aria-hidden="true"></span>
                  <span>User</span>
                </button>
              </div>
              <div class="role-meta detail-only">Session Root · ${human.messagesSent} prompts</div>
            </div>
            <div class="run-top-right">
              ${
                model.humanRootMsgCount > 0
                  ? `<button type="button" class="card-msg-badge detail-only" data-thread-key="${escHtml(humanRootKey)}" aria-label="Open ${model.humanRootMsgCount} messages for User">
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v7A1.5 1.5 0 0 1 12.5 11H6.6l-3.2 2.8A.5.5 0 0 1 2.5 13.4V11A1.5 1.5 0 0 1 2 9.5v-7z"/></svg>
                      ${model.humanRootMsgCount}
                    </button>`
                  : ""
              }
              <span class="state-tag basic-only human">HUMAN</span>
            </div>
          </div>
          <div class="basic-summary-line">${escHtml(hSummary)}</div>
          <div class="cluster-foot-row">
            <span class="tele-mono">${human.messagesSent} prompts · ${human.messagesReceived} replies</span>
          </div>
        </div>
      `);
    }

    if (human && root) {
      rootParts.push(`
        <div class="edge-link">
          <span class="edge-line" aria-hidden="true"></span>
          ${
            model.humanRootMsgCount > 0
              ? `<button type="button" class="msg-pill" data-thread-key="${escHtml(humanRootKey)}" aria-label="Open ${model.humanRootMsgCount} messages between User and ${escHtml(root.label)}">${model.humanRootMsgCount} msg</button>`
              : `<span class="edge-line" aria-hidden="true"></span>`
          }
          <span class="edge-line" aria-hidden="true"></span>
          <span aria-hidden="true" style="color:#f59e0b;">▶</span>
        </div>
      `);
    }

    if (root) {
      const rSelected = this.selectedId === root.id;
      const rState =
        root.status === "THINKING" || root.status === "WORKING"
          ? "working"
          : root.status === "WAITING"
            ? "waiting"
            : root.status === "BLOCKED"
              ? "blocked"
              : "done";
      const isThinking = root.status === "THINKING";
      const isBusy = isThinking || root.status === "WORKING";
      const ideMeta = getIdeMeta(root.ide);
      const subCount = Math.max(0, model.totalAiAgents - 1);
      const rSummary = cleanSummaryText(
        root.activeTool ? `⚙ ${root.activeTool}` : root.summary || root.role || "Orchestrator"
      );
      const thinkingStart =
        root.thinkingEpoch ??
        (root.thinkingSince ? Date.parse(root.thinkingSince) / 1000 : Date.now() / 1000);
      const elapsed = isThinking ? Math.max(0, Date.now() / 1000 - thinkingStart) : 0;
      const teleHtml = isThinking
        ? `<span class="tele-mono" data-thinking-timer="${escHtml(root.id)}" data-thinking-start="${thinkingStart}">thinking ${fmtDuration(elapsed)} · ${root.toolCalls}t</span>`
        : `<span class="tele-mono">${root.toolCalls}t · ${root.messagesSent}↑ ${root.messagesReceived}↓</span>`;

      const rootHasPending = Boolean(root.pendingPrompt);

      rootParts.push(`
        <div class="node-card root-agent ${rSelected ? "is-selected" : ""} ${rootHasPending ? "has-pending-prompt" : ""}" id="avRootOrchestrator" data-root-orchestrator data-agent-id="${escHtml(root.id)}" data-state="${rState}">
          <div class="cluster-head">
            <div class="cluster-title-wrap">
              <div class="cluster-name">
                <button type="button" class="card-select-btn" data-select-agent="${escHtml(root.id)}" aria-label="Inspect ${escHtml(root.label || "Orchestrator")} details" aria-pressed="${rSelected ? "true" : "false"}">
                  <span class="status-dot ${rState} detail-only" aria-hidden="true"></span>
                  <span>${escHtml(root.label || "Coordinator")}</span>
                </button>
              </div>
              <div class="role-meta detail-only">Orchestrator · ${subCount} subagents · ${root.toolCalls} tools</div>
            </div>
            <div class="run-top-right">
              ${
                rootHasPending
                  ? `<button type="button" class="needs-input-badge" data-open-chat="${escHtml(root.id)}" aria-label="Needs input — open chat with ${escHtml(root.label || "Coordinator")}"><span aria-hidden="true">?</span> Needs Input</button>`
                  : ""
              }
              <button type="button" class="card-chat-btn" data-open-chat="${escHtml(root.id)}" aria-label="Open chat for ${escHtml(root.label || "Coordinator")}">Chat</button>
              ${
                totalMsgs > 0
                  ? `<button type="button" class="card-msg-badge detail-only" data-thread-key="all" aria-label="Open all ${totalMsgs} session messages">
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v7A1.5 1.5 0 0 1 12.5 11H6.6l-3.2 2.8A.5.5 0 0 1 2.5 13.4V11A1.5 1.5 0 0 1 2 9.5v-7z"/></svg>
                      ${totalMsgs}
                    </button>`
                  : ""
              }
              <span class="state-tag ${rState}">${isBusy ? `● ${root.status}` : root.status === "DONE" ? "✓ DONE" : root.status}</span>
            </div>
          </div>
          <div class="basic-summary-line">${escHtml(rSummary)}</div>
          <div class="cluster-foot-row">
            ${teleHtml}
            <span class="ide-chip" style="color:${ideMeta.color};border-color:${ideMeta.border};background:${ideMeta.bg}">${escHtml(ideMeta.short)}</span>
          </div>
          ${isBusy ? `<div class="scan-track" aria-hidden="true"></div>` : ""}
        </div>
      `);
    } else {
      rootParts.push(`<div class="role-meta">Root ID: ${escHtml(rootId)}</div>`);
    }

    const nextRootHtml = rootParts.join("");
    let layoutChanged =
      this.lastRenderedStyle !== this.cardStyle ||
      this.lastRenderedMode !== this.viewMode;
    this.lastRenderedStyle = this.cardStyle;
    this.lastRenderedMode = this.viewMode;
    if (nextRootHtml !== this.lastRootHtml) {
      rootRowEl.innerHTML = nextRootHtml;
      this.lastRootHtml = nextRootHtml;
      layoutChanged = true;
    }

    // Swimlanes 1 & 2
    const filteredClusters = model.clusters.filter((c) => this.clusterPassesFilter(c));
    const activeClusters = filteredClusters.filter((c) => c.state !== "done");
    const doneClusters = filteredClusters.filter((c) => c.state === "done");

    laneActive.hidden = activeClusters.length === 0;
    laneCompleted.hidden = doneClusters.length === 0;

    const activeHead = this.groupedTreeEl.querySelector("[data-lane-active-head]");
    const doneHead = this.groupedTreeEl.querySelector("[data-lane-done-head]");
    if (activeHead) activeHead.textContent = `Active / Working (${activeClusters.length})`;
    if (doneHead) doneHead.textContent = `Completed / Standby (${doneClusters.length})`;

    const nextActiveHtml = activeClusters.map((c) => this.buildClusterCardHtml(c)).join("");
    if (nextActiveHtml !== this.lastActiveGridHtml) {
      activeGrid.innerHTML = nextActiveHtml;
      this.lastActiveGridHtml = nextActiveHtml;
      layoutChanged = true;
    }

    const nextDoneHtml = doneClusters.map((c) => this.buildClusterCardHtml(c)).join("");
    if (nextDoneHtml !== this.lastDoneGridHtml) {
      doneGrid.innerHTML = nextDoneHtml;
      this.lastDoneGridHtml = nextDoneHtml;
      layoutChanged = true;
    }

    // Swimlane 3: External Systems & MCP Tools
    if (model.externalNodes.length === 0) {
      laneExternal.hidden = true;
      if (this.lastExtHtml !== "") {
        extCardsEl.innerHTML = "";
        this.lastExtHtml = "";
        layoutChanged = true;
      }
    } else {
      laneExternal.hidden = false;
      const nextExtHtml = model.externalNodes
        .map((ext) => {
          const icon = ext.id.startsWith("ext:mcp:")
            ? "🔌"
            : ext.id === "ext:board"
              ? "📋"
              : ext.id === "ext:web"
                ? "🌐"
                : ext.id === "ext:shell"
                  ? "⚡"
                  : "📁";
          const sub = `${ext.toolCalls} calls · ${trunc(cleanSummaryText(ext.summary) || "ready", 28)}`;
          return `
            <button
              type="button"
              class="ext-lane-card"
              data-ext-filter="${escHtml(ext.id)}"
              aria-pressed="${this.extFilter === ext.id}"
            >
              <span class="ext-lane-title">${icon} ${escHtml(ext.label)}</span>
              <span class="ext-lane-sub">${escHtml(sub)}</span>
            </button>
          `;
        })
        .join("");
      if (nextExtHtml !== this.lastExtHtml) {
        extCardsEl.innerHTML = nextExtHtml;
        this.lastExtHtml = nextExtHtml;
        layoutChanged = true;
      }
    }

    if (layoutChanged) {
      this.scheduleBusDraw();
    }
  }

  private buildClusterCardHtml(c: TeamAgentCluster): string {
    const activeRuns = c.runs.filter((r) => r.state !== "done");
    const doneRuns = c.runs.filter((r) => r.state === "done");
    const isExpanded = this.expandedDone.has(c.id);

    const countLabels: string[] = [];
    const wCount = c.runs.filter((r) => r.state === "working").length;
    const waitCount = c.runs.filter((r) => r.state === "waiting").length;
    const blkCount = c.runs.filter((r) => r.state === "blocked").length;
    if (wCount) countLabels.push(`${wCount} working`);
    if (waitCount) countLabels.push(`${waitCount} waiting`);
    if (blkCount) countLabels.push(`${blkCount} blocked`);
    if (doneRuns.length) countLabels.push(`${doneRuns.length} done`);

    const visibleRuns: ClusterRunItem[] = isExpanded ? c.runs : activeRuns;
    const basicPill =
      c.state === "working"
        ? "● WORKING"
        : c.state === "waiting"
          ? "WAITING"
          : c.state === "blocked"
            ? "● BLOCKED"
            : "✓ DONE";
    const isSelected =
      this.selectedId !== null && c.agentIds.includes(this.selectedId);
    const ideMeta = getIdeMeta(c.ide);
    const pendingRun = c.runs.find((r) => Boolean(r.agent.pendingPrompt));
    const hasPending = Boolean(pendingRun);
    const chatTargetId = pendingRun?.id ?? c.leadAgentId;

    return `
      <article
        class="cluster-card ${isSelected ? "is-selected" : ""} ${hasPending ? "has-pending-prompt" : ""}"
        data-cluster-id="${escHtml(c.id)}"
        data-agent-id="${escHtml(c.leadAgentId)}"
        data-cluster-thread-key="${escHtml(c.threadKey)}"
        data-msg-count="${c.msgCount}"
        data-role-label="${escHtml(c.teamRole)}"
        data-state="${c.state}"
        style="--rail-color:${c.railColor}"
      >
        <div class="cluster-head">
          <div class="cluster-title-wrap">
            <div class="cluster-name">
              <button type="button" class="card-select-btn" data-select-agent="${escHtml(c.leadAgentId)}" aria-label="Inspect ${escHtml(c.teamRole)} details" aria-pressed="${isSelected ? "true" : "false"}">
                <span class="status-dot ${c.state} detail-only" aria-hidden="true"></span>
                <span>${escHtml(c.teamRole)}</span>
              </button>
              ${c.runs.length > 1 ? `<span class="count-badge">×${c.runs.length}</span>` : ""}
            </div>
            <div class="role-meta detail-only">${escHtml(c.subtitle)}${countLabels.length ? ` · ${countLabels.join(", ")}` : ""} · ${c.totalTools} tools</div>
          </div>
          <div class="run-top-right">
            ${
              pendingRun
                ? `<button type="button" class="needs-input-badge" data-open-chat="${escHtml(pendingRun.id)}" aria-label="Needs input — open chat with ${escHtml(pendingRun.displayId)}"><span aria-hidden="true">?</span> Needs Input</button>`
                : ""
            }
            <button type="button" class="card-chat-btn" data-open-chat="${escHtml(chatTargetId)}" aria-label="Open chat for ${escHtml(c.teamRole)}">Chat</button>
            ${
              c.msgCount > 0 && c.runs.length <= 1
                ? `<button type="button" class="card-msg-badge detail-only" data-thread-key="${escHtml(c.threadKey)}" aria-label="Open ${c.msgCount} messages for ${escHtml(c.teamRole)}">
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v7A1.5 1.5 0 0 1 12.5 11H6.6l-3.2 2.8A.5.5 0 0 1 2.5 13.4V11A1.5 1.5 0 0 1 2 9.5v-7z"/></svg>
                    ${c.msgCount}
                  </button>`
                : ""
            }
            <span class="state-tag ${c.state} basic-only">${basicPill}</span>
          </div>
        </div>

        <div class="basic-summary-line">${escHtml(c.leadTask)}</div>

        ${
          visibleRuns.length
            ? `<div class="run-list">
                ${visibleRuns
                  .map((r) => {
                    const rSelected = this.selectedId === r.id;
                    const rHasPending = Boolean(r.agent.pendingPrompt);
                    return `
                      <div class="run-item ${r.state === "done" ? "is-done" : ""} ${rSelected ? "is-selected" : ""} ${rHasPending ? "has-pending-prompt" : ""}" data-run-agent-id="${escHtml(r.id)}" data-run-state="${r.state}">
                        <div class="run-top">
                          <button type="button" class="run-id card-select-btn" data-select-agent="${escHtml(r.id)}" aria-label="Inspect ${escHtml(r.displayId)} details" aria-pressed="${rSelected ? "true" : "false"}">${escHtml(r.displayId)}</button>
                          <div class="run-top-right">
                            ${
                              rHasPending
                                ? `<button type="button" class="needs-input-badge" data-open-chat="${escHtml(r.id)}" aria-label="Needs input — open chat with ${escHtml(r.displayId)}"><span aria-hidden="true">?</span> Needs Input</button>`
                                : ""
                            }
                            <button type="button" class="card-chat-btn" data-open-chat="${escHtml(r.id)}" aria-label="Open chat for ${escHtml(r.displayId)}">Chat</button>
                            ${
                              r.msgs > 0
                                ? `<button type="button" class="card-msg-badge" data-thread-key="${escHtml(c.threadKey)}" data-run-id="${escHtml(r.id)}" aria-label="Open ${r.msgs} messages for ${escHtml(r.displayId)}">
                                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v7A1.5 1.5 0 0 1 12.5 11H6.6l-3.2 2.8A.5.5 0 0 1 2.5 13.4V11A1.5 1.5 0 0 1 2 9.5v-7z"/></svg>
                                    ${r.msgs}
                                  </button>`
                                : ""
                            }
                            <span class="state-tag ${r.state}">${r.state === "done" ? "✓ done" : r.state} · ${r.tools}t</span>
                          </div>
                        </div>
                        <div class="run-task" title="${escHtml(r.task)}">${escHtml(r.task)}</div>
                      </div>
                    `;
                  })
                  .join("")}
              </div>`
            : ""
        }

        <div class="cluster-foot-row">
          ${
            doneRuns.length > 0
              ? `<button type="button" class="collapse-btn" data-toggle-done="${escHtml(c.id)}" aria-expanded="${isExpanded}">
                  ${isExpanded ? `− Hide ${doneRuns.length} done` : `+${doneRuns.length} done ▾`}
                </button>`
              : `<span></span>`
          }
          <div class="run-top-right">
            <span class="tele-mono">${c.totalTools} tools · ${c.msgsSent}↑ ${c.msgsRecv}↓</span>
            <span class="ide-chip" style="color:${ideMeta.color};border-color:${ideMeta.border};background:${ideMeta.bg}">${escHtml(ideMeta.short)}</span>
          </div>
        </div>

        ${c.state === "working" ? `<div class="scan-track" aria-hidden="true"></div>` : ""}
      </article>
    `;
  }

  private scheduleBusDraw(): void {
    if (this.busRafId != null) {
      window.cancelAnimationFrame(this.busRafId);
    }
    this.busRafId = window.requestAnimationFrame(() => {
      this.busRafId = null;
      this.drawGroupedBus();
    });
  }

  private drawGroupedBus(): void {
    if (this.groupedTreeEl.hidden) return;
    const rootEl = this.groupedTreeEl.querySelector<HTMLElement>("[data-root-orchestrator]");
    const cards = Array.from(this.groupedTreeEl.querySelectorAll<HTMLElement>(".cluster-card"));
    const treeRect = this.groupedTreeEl.getBoundingClientRect();

    if (!rootEl || cards.length === 0 || treeRect.width === 0) {
      this.busSvg.innerHTML = "";
      this.busPillsLayer.innerHTML = "";
      return;
    }

    const rRect = rootEl.getBoundingClientRect();
    const startX = rRect.left - treeRect.left + rRect.width / 2;
    const startY = rRect.bottom - treeRect.top;

    const paths: string[] = [];
    const pills: string[] = [];
    const isBasic = this.cardStyle === "basic";

    if (isBasic) {
      for (const card of cards) {
        const cRect = card.getBoundingClientRect();
        const endX = cRect.left - treeRect.left + cRect.width / 2;
        const endY = cRect.top - treeRect.top;
        const st = card.dataset.state || "done";
        const color =
          st === "working"
            ? "#f59e0b"
            : st === "blocked"
              ? "#f43f5e"
              : "#a855f7";
        const pillBorder =
          st === "working"
            ? "#f59e0b"
            : st === "waiting"
              ? "#06b6d4"
              : st === "blocked"
                ? "#f43f5e"
                : "#c084fc";
        const op = st === "done" ? "0.66" : "0.92";
        const dash = st === "working" || st === "blocked" ? `stroke-dasharray="6 4"` : "";
        const cls = st === "working" ? "bus-path is-work" : "";
        const cx = (startX + endX) / 2;
        const cy = startY + (endY - startY) * 0.42;

        paths.push(
          `<path class="${cls}" d="M ${startX.toFixed(1)} ${startY.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${st === "working" ? "2" : "1.5"}" stroke-opacity="${op}" ${dash} />`
        );

        const tid = card.dataset.clusterThreadKey || "";
        const msgCount = Number(card.dataset.msgCount || "0");
        const roleLabel = card.dataset.roleLabel || "Cluster";
        if (tid && msgCount > 0) {
          const t =
            endY - startY < 155
              ? 0.56
              : Math.max(0.56, 1 - 22 / Math.max(40, endY - startY));
          const mt = 1 - t;
          const px = mt * mt * startX + 2 * mt * t * cx + t * t * endX;
          const py = mt * mt * startY + 2 * mt * t * cy + t * t * endY;
          const isActive =
            this.activeThreadKey === tid ||
            (Boolean(this.activeThreadKey) && this.activeThreadKey!.startsWith(`${tid}:`));
          pills.push(
            `<button type="button" class="line-msg-pill ${isActive ? "is-active" : ""}" data-thread-key="${escHtml(tid)}" style="left:${px.toFixed(1)}px;top:${py.toFixed(1)}px;--pill-color:${pillBorder}" aria-label="Open ${msgCount} SMS messages for ${escHtml(roleLabel)}">${msgCount} msg</button>`
          );
        }
      }

      const extCards = Array.from(
        this.groupedTreeEl.querySelectorAll<HTMLElement>("[data-ext-lane-cards] .ext-lane-card")
      );
      if (extCards.length > 0) {
        cards.forEach((card, idx) => {
          const ext = extCards[idx % extCards.length];
          if (!ext) return;
          const cRect = card.getBoundingClientRect();
          const eRect = ext.getBoundingClientRect();
          const sx = cRect.left - treeRect.left + cRect.width / 2;
          const sy = cRect.bottom - treeRect.top;
          const ex = eRect.left - treeRect.left + eRect.width / 2;
          const ey = eRect.top - treeRect.top;
          paths.push(
            `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#38bdf8" stroke-opacity="0.16" stroke-dasharray="3 4" stroke-width="1" />`
          );
        });
      }
    } else {
      const busY = startY + 14;
      for (const card of cards) {
        const cRect = card.getBoundingClientRect();
        const endX = cRect.left - treeRect.left + cRect.width / 2;
        const endY = cRect.top - treeRect.top;
        const st = card.dataset.state || "done";
        const color =
          st === "working"
            ? "#f59e0b"
            : st === "waiting"
              ? "#06b6d4"
              : st === "blocked"
                ? "#f43f5e"
                : "#10b981";
        const cls =
          st === "working"
            ? "bus-path is-work"
            : st === "waiting"
              ? "bus-path is-live"
              : "bus-path";
        const op = st === "done" ? "0.52" : "1";

        paths.push(
          `<path class="${cls}" opacity="${op}" stroke="${color}" d="M ${startX.toFixed(1)} ${startY.toFixed(1)} V ${busY.toFixed(1)} H ${endX.toFixed(1)} V ${endY.toFixed(1)}" />` +
            `<circle cx="${endX.toFixed(1)}" cy="${endY.toFixed(1)}" r="3" opacity="${op}" fill="${color}" />`
        );

        const tid = card.dataset.clusterThreadKey || "";
        const msgCount = Number(card.dataset.msgCount || "0");
        const roleLabel = card.dataset.roleLabel || "Cluster";
        if (tid && msgCount > 0) {
          const isActive =
            this.activeThreadKey === tid ||
            (Boolean(this.activeThreadKey) && this.activeThreadKey!.startsWith(`${tid}:`));
          pills.push(
            `<button type="button" class="line-msg-pill ${isActive ? "is-active" : ""}" data-thread-key="${escHtml(tid)}" style="left:${endX.toFixed(1)}px;top:${(endY - 15).toFixed(1)}px;--pill-color:${color}" aria-label="Open ${msgCount} SMS messages for ${escHtml(roleLabel)}">${msgCount} msg</button>`
          );
        }
      }
    }

    this.busSvg.innerHTML = paths.join("");
    this.busPillsLayer.innerHTML = pills.join("");
  }

  private renderMesh(model: TopologyModel): void {
    const W = 880;
    const H = 540;
    const CX = 440;
    const CY = 266;
    const R_INNER = 138;
    const R_OUTER = 216;

    this.viewState.baseW = W;
    this.viewState.baseH = H;
    if (!this.viewState.userModified) {
      this.viewState.x = 0;
      this.viewState.y = 0;
      this.viewState.w = W;
      this.viewState.h = H;
    }
    this.applyViewBox();

    const filteredClusters = model.clusters.filter((c) => this.clusterPassesFilter(c));
    const flatRuns = filteredClusters.flatMap((c) =>
      c.runs.map((r) => ({ run: r, cluster: c }))
    );
    const activeRuns = flatRuns.filter((x) => x.run.state !== "done");
    const doneRuns = flatRuns.filter((x) => x.run.state === "done");

    const positioned: MeshPositionedNode[] = [];
    this.meshNodePos.clear();

    const root = model.rootAgent;
    const human = model.humanNode;
    const humanRootKey = human && root ? `pair:${human.id}|${root.id}` : "all";

    if (human && root) {
      const hx = CX - 48;
      const rx = CX + 48;
      positioned.push({
        id: human.id,
        agentId: human.id,
        label: "User",
        x: hx,
        y: CY,
        color: "#f59e0b",
        isCore: true,
        isHuman: true,
        msgs: model.humanRootMsgCount,
        threadSelection: this.threadLookup.get(humanRootKey) ?? {
          key: "all",
          kind: "all",
          label: "All Session Messages",
          route: "All Session Messages",
        },
      });
      this.meshNodePos.set(human.id, { x: hx, y: CY });

      const rootBusy = root.status === "THINKING" || root.status === "WORKING";
      positioned.push({
        id: root.id,
        agentId: root.id,
        label: trunc(root.label || "Coordinator", 14),
        x: rx,
        y: CY,
        color: "#c084fc",
        isCore: true,
        isBusy: rootBusy,
        hasPendingPrompt: Boolean(root.pendingPrompt),
        msgs: this.lastCounters?.messages ?? 0,
        threadSelection: this.threadLookup.get("all")!,
      });
      this.meshNodePos.set(root.id, { x: rx, y: CY });
    } else if (root) {
      const rootBusy = root.status === "THINKING" || root.status === "WORKING";
      positioned.push({
        id: root.id,
        agentId: root.id,
        label: trunc(root.label || "Coordinator", 14),
        x: CX,
        y: CY,
        color: "#c084fc",
        isCore: true,
        isBusy: rootBusy,
        hasPendingPrompt: Boolean(root.pendingPrompt),
        msgs: this.lastCounters?.messages ?? 0,
        threadSelection: this.threadLookup.get("all")!,
      });
      this.meshNodePos.set(root.id, { x: CX, y: CY });
    }

    activeRuns.forEach(({ run, cluster }, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, activeRuns.length);
      const x = CX + Math.cos(angle) * R_INNER;
      const y = CY + Math.sin(angle) * R_INNER;
      const color =
        run.state === "blocked"
          ? "#f43f5e"
          : run.state === "working"
            ? "#f59e0b"
            : "#06b6d4";
      const sel: ThreadSelection = {
        key: cluster.runs.length > 1 ? `${cluster.threadKey}:${run.id}` : cluster.threadKey,
        kind: "cluster",
        clusterId: cluster.id,
        agentIds: cluster.agentIds,
        runId: cluster.runs.length > 1 ? run.id : undefined,
        label: `${root?.label || "Coordinator"} ↔ ${run.displayId}`,
        route: `${root?.label || "Coordinator"} ↔ ${cluster.teamRole}`,
        runs: cluster.runs,
      };
      this.threadLookup.set(sel.key, sel);
      positioned.push({
        id: run.id,
        agentId: run.id,
        label: trunc(run.displayId, 16),
        x,
        y,
        color,
        isBusy: run.state === "working",
        hasPendingPrompt: Boolean(run.agent.pendingPrompt),
        msgs: run.msgs,
        threadSelection: sel,
      });
      this.meshNodePos.set(run.id, { x, y });
    });

    doneRuns.forEach(({ run, cluster }, i) => {
      const angle = -Math.PI / 2 + 0.14 + (i * 2 * Math.PI) / Math.max(1, doneRuns.length);
      const x = CX + Math.cos(angle) * R_OUTER;
      const y = CY + Math.sin(angle) * R_OUTER;
      const sel: ThreadSelection = {
        key: cluster.runs.length > 1 ? `${cluster.threadKey}:${run.id}` : cluster.threadKey,
        kind: "cluster",
        clusterId: cluster.id,
        agentIds: cluster.agentIds,
        runId: cluster.runs.length > 1 ? run.id : undefined,
        label: `${root?.label || "Coordinator"} ↔ ${run.displayId}`,
        route: `${root?.label || "Coordinator"} ↔ ${cluster.teamRole}`,
        runs: cluster.runs,
      };
      this.threadLookup.set(sel.key, sel);
      positioned.push({
        id: run.id,
        agentId: run.id,
        label: trunc(run.displayId, 15),
        x,
        y,
        color: "#10b981",
        isDone: true,
        hasPendingPrompt: Boolean(run.agent.pendingPrompt),
        msgs: run.msgs,
        threadSelection: sel,
      });
      this.meshNodePos.set(run.id, { x, y });
    });

    const extNodes = model.externalNodes.slice(0, 6).map((ext, idx, arr) => {
      const count = arr.length;
      const x =
        count === 1
          ? CX
          : count === 2
            ? idx === 0
              ? 124
              : W - 124
            : 96 + (idx * (W - 192)) / Math.max(1, count - 1);
      const y = H - 30;
      const icon = ext.id.startsWith("ext:mcp:")
        ? "🔌"
        : ext.id === "ext:board"
          ? "📋"
          : ext.id === "ext:web"
            ? "🌐"
            : ext.id === "ext:shell"
              ? "⚡"
              : "📁";
      this.meshNodePos.set(ext.id, { x, y });
      return {
        id: ext.id,
        label: `${icon} ${trunc(ext.label, 14)} · ${ext.toolCalls}`,
        x,
        y,
      };
    });

    const orbitGuides = `
      <circle cx="${CX}" cy="${CY}" r="76" fill="rgba(192,132,252,0.03)" stroke="#233252" stroke-dasharray="3 4" />
      <circle cx="${CX}" cy="${CY}" r="${R_INNER}" fill="none" stroke="#1e2942" stroke-dasharray="5 5" />
      ${doneRuns.length > 0 ? `<circle cx="${CX}" cy="${CY}" r="${R_OUTER}" fill="none" stroke="#192338" stroke-dasharray="4 5" />` : ""}
      <text x="${CX}" y="${CY - R_INNER - 10}" fill="#64748b" font-size="8.8" font-weight="750" letter-spacing="1" text-anchor="middle">ACTIVE RING (${activeRuns.length})</text>
      ${doneRuns.length > 0 ? `<text x="${CX}" y="${CY + R_OUTER + 18}" fill="#64748b" font-size="8.8" font-weight="750" letter-spacing="1" text-anchor="middle">STANDBY / DONE RING (${doneRuns.length})</text>` : ""}
      <g transform="translate(18, 16)">
        <rect width="206" height="44" rx="8" fill="#0b1120" stroke="#1e2942" />
        <line x1="10" y1="15" x2="34" y2="15" stroke="#06b6d4" stroke-dasharray="4 3" stroke-width="1.4" />
        <text x="42" y="18" fill="#94a3b8" font-size="9">Orchestrator ↔ Agent</text>
        <line x1="10" y1="31" x2="34" y2="31" stroke="#c084fc" stroke-dasharray="5 3" stroke-width="2" />
        <text x="42" y="34" fill="#e9d5ff" font-size="9" font-weight="650">Cross-Agent Peer Comms</text>
      </g>
    `;

    const hubEdges: string[] = [];
    const rootPos = root ? this.meshNodePos.get(root.id) : null;
    const humanPos = human ? this.meshNodePos.get(human.id) : null;

    if (humanPos && rootPos) {
      hubEdges.push(
        `<line x1="${humanPos.x}" y1="${humanPos.y}" x2="${rootPos.x}" y2="${rootPos.y}" stroke="#f59e0b" stroke-dasharray="5 3" stroke-width="2.2" />`
      );
    }

    const subPosNodes = positioned.filter((n) => !n.isCore);
    if (rootPos) {
      for (const n of subPosNodes) {
        hubEdges.push(
          `<line x1="${rootPos.x}" y1="${rootPos.y}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}" stroke="${n.color}" stroke-dasharray="4 4" stroke-opacity="${n.isDone ? "0.22" : "0.54"}" stroke-width="${n.isDone ? "1" : "1.5"}" />`
        );
      }
    }

    // External tool lines
    for (const n of subPosNodes) {
      const exts = model.extByAgent.get(n.agentId);
      if (!exts) continue;
      for (const extId of exts) {
        const ep = extNodes.find((e) => e.id === extId);
        if (!ep) continue;
        const lit = this.selectedId === n.agentId || this.extFilter === extId;
        hubEdges.push(
          `<line class="ext-edge ${lit ? "ext-lit" : ""}" x1="${n.x.toFixed(1)}" y1="${n.y.toFixed(1)}" x2="${ep.x.toFixed(1)}" y2="${ep.y.toFixed(1)}" stroke="#38bdf8" stroke-opacity="${lit ? "0.8" : "0.12"}" stroke-dasharray="2 4" stroke-width="1" />`
        );
      }
    }

    const peerArcs: string[] = [];
    const edgePills: Array<{
      x: number;
      y: number;
      label: string;
      threadKey: string;
      color: string;
    }> = [];

    if (humanPos && rootPos && model.humanRootMsgCount > 0) {
      edgePills.push({
        x: (humanPos.x + rootPos.x) / 2,
        y: CY - 24,
        label: `${model.humanRootMsgCount} msg`,
        threadKey: humanRootKey,
        color: "#f59e0b",
      });
    }

    // Cross-Agent Peer Comms curved chords bowing outward from center
    for (const peer of model.peerLinks) {
      const na = this.meshNodePos.get(peer.from);
      const nb = this.meshNodePos.get(peer.to);
      if (!na || !nb) continue;
      const mx = (na.x + nb.x) / 2;
      const my = (na.y + nb.y) / 2;
      const dx = mx - CX;
      const dy = my - CY;
      const dist = Math.hypot(dx, dy) || 1;
      const bow = 38;
      const qx = mx + (dx / dist) * bow;
      const qy = my + (dy / dist) * bow;
      peerArcs.push(
        `<path d="M ${na.x.toFixed(1)} ${na.y.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${nb.x.toFixed(1)} ${nb.y.toFixed(1)}" fill="none" stroke="#c084fc" stroke-width="2" stroke-dasharray="6 3" class="flow-edge" />`
      );
      const px = 0.25 * na.x + 0.5 * qx + 0.25 * nb.x;
      const py = 0.25 * na.y + 0.5 * qy + 0.25 * nb.y;
      edgePills.push({
        x: px,
        y: py,
        label: `${peer.count} msg`,
        threadKey: peer.threadKey,
        color: "#c084fc",
      });
    }

    // Spoke [N msg] pills for subagents (active first, then completed with messages, up to 6)
    if (rootPos) {
      const spokePillNodes = [
        ...subPosNodes.filter((n) => !n.isDone && n.msgs > 0),
        ...subPosNodes.filter((n) => n.isDone && n.msgs > 0),
      ].slice(0, 6);
      for (const n of spokePillNodes) {
        edgePills.push({
          x: rootPos.x * 0.42 + n.x * 0.58,
          y: rootPos.y * 0.42 + n.y * 0.58,
          label: `${n.msgs} msg`,
          threadKey: n.threadSelection.key,
          color: n.color,
        });
      }
    }

    const pillSvg = edgePills.map((p) => {
      const active = this.activeThreadKey === p.threadKey;
      const w = Math.max(42, p.label.length * 5.8 + 14);
      return `
        <g class="mesh-edge-pill ${active ? "is-active" : ""}" style="cursor:pointer" data-thread-key="${escHtml(p.threadKey)}" role="button" tabindex="0" aria-label="Open ${escHtml(p.label)} thread">
          <rect x="${(p.x - w / 2).toFixed(1)}" y="${(p.y - 8.5).toFixed(1)}" width="${w.toFixed(1)}" height="17" rx="8.5" fill="${active ? p.color : "#0d1424"}" stroke="${p.color}" stroke-width="1.4" />
          <text x="${p.x.toFixed(1)}" y="${(p.y + 3).toFixed(1)}" fill="${active ? "#06101d" : "#f8fafc"}" font-size="8.8" font-weight="750" text-anchor="middle">${escHtml(p.label)}</text>
        </g>
      `;
    });

    const nodeSvg = positioned.map((n) => {
      const sel = this.selectedId === n.agentId;
      const r = n.isCore ? 15 : n.isDone ? 9.5 : 12.5;
      const lblY = n.isCore ? n.y + 26 : n.y >= CY ? n.y + 20 : n.y - 17;
      const chatPillY = n.isCore ? n.y + 39 : n.y >= CY ? n.y + 33 : n.y - 31;
      const waitingPillTop =
        !n.isCore && n.y < CY
          ? Math.min(chatPillY - 26, n.y - r - 24)
          : n.y - r - 21;
      const waitingPillHtml = n.hasPendingPrompt
        ? `
          <g class="mesh-needs-input-badge" style="cursor:pointer" data-open-chat="${escHtml(n.agentId)}" role="button" tabindex="0" aria-label="Needs input — open chat with ${escHtml(n.label)}">
            <rect x="${(n.x - 40).toFixed(1)}" y="${waitingPillTop.toFixed(1)}" width="80" height="16" rx="8" fill="#f59e0b" stroke="#0b1120" stroke-width="1.2" />
            <text x="${n.x.toFixed(1)}" y="${(waitingPillTop + 11).toFixed(1)}" fill="#06101d" font-size="8.2" font-weight="800" text-anchor="middle">? Needs Input</text>
          </g>
        `
        : "";
      const chatPillHtml = !n.isHuman
        ? `
          <g class="mesh-chat-btn" style="cursor:pointer" data-open-chat="${escHtml(n.agentId)}" role="button" tabindex="0" aria-label="Open chat for ${escHtml(n.label)}">
            <rect x="${(n.x - 18).toFixed(1)}" y="${(chatPillY - 7).toFixed(1)}" width="36" height="13" rx="6.5" fill="#0d1424" stroke="#38bdf8" stroke-width="1" />
            <text x="${n.x.toFixed(1)}" y="${(chatPillY + 2.5).toFixed(1)}" fill="#7dd3fc" font-size="7.8" font-weight="700" text-anchor="middle">Chat</text>
          </g>
        `
        : "";
      return `
        <g class="agent-card mesh-node">
          <g class="mesh-node-hit" style="cursor:pointer" data-agent-id="${escHtml(n.agentId)}" role="button" tabindex="0" aria-label="Inspect ${escHtml(n.label)}">
            ${n.hasPendingPrompt ? `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${r + 7}" fill="none" stroke="#f59e0b" stroke-width="2" class="needs-input-ring" />` : ""}
            ${n.isCore || n.isBusy ? `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${r + 4}" fill="none" stroke="${n.color}" stroke-opacity="0.34" stroke-width="2" class="work-halo" />` : ""}
            <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${r}" fill="#141c2e" stroke="${sel ? "#ffffff" : n.hasPendingPrompt ? "#f59e0b" : n.color}" stroke-width="${sel ? 2.8 : 2}" />
            <text x="${n.x.toFixed(1)}" y="${lblY.toFixed(1)}" fill="${sel ? "#f8fafc" : n.isCore ? "#e2e8f0" : "#94a3b8"}" font-size="${n.isCore ? "10.5" : "8.8"}" font-weight="${n.isCore ? "700" : "600"}" text-anchor="middle">${escHtml(n.label)}</text>
          </g>
          ${waitingPillHtml}
          ${chatPillHtml}
        </g>
      `;
    });

    const extSvg = extNodes.map((ext) => {
      const lit = this.extFilter === ext.id;
      const w = Math.min(184, Math.max(132, Math.floor((W - 60) / Math.max(1, extNodes.length)) - 10));
      return `
        <g class="mesh-ext-node" style="cursor:pointer" data-ext-filter="${escHtml(ext.id)}" role="button" tabindex="0" aria-label="Filter by ${escHtml(ext.label)}">
          <rect x="${(ext.x - w / 2).toFixed(1)}" y="${(ext.y - 15).toFixed(1)}" width="${w}" height="30" rx="8" fill="${lit ? "rgba(56,189,248,0.16)" : "#0b1322"}" stroke="${lit ? "#f8fafc" : "#38bdf8"}" stroke-width="${lit ? "1.8" : "1.2"}" ${lit ? "" : `stroke-dasharray="5 3"`} />
          <text x="${ext.x.toFixed(1)}" y="${(ext.y + 3.5).toFixed(1)}" fill="#e2e8f0" font-size="9.5" font-weight="700" text-anchor="middle">${escHtml(ext.label)}</text>
        </g>
      `;
    });

    const nextMeshHtml =
      orbitGuides +
      hubEdges.join("") +
      peerArcs.join("") +
      `<g id="topoPackets"></g>` +
      pillSvg.join("") +
      nodeSvg.join("") +
      extSvg.join("");
    if (nextMeshHtml !== this.lastMeshHtml) {
      this.meshSvg.innerHTML = nextMeshHtml;
      this.lastMeshHtml = nextMeshHtml;
    }
    this.lastRenderedMode = this.viewMode;
  }

  private syncActiveThreadHighlights(): void {
    this.container
      .querySelectorAll<Element>("[data-thread-key]")
      .forEach((el) => {
        const key = el.getAttribute("data-thread-key") || "";
        const runId = el.getAttribute("data-run-id");
        const active = this.activeThreadKey;
        const match = Boolean(
          active &&
            key &&
            (key === active ||
              (!runId &&
                key.startsWith("cluster:") &&
                active.startsWith(`${key}:`)))
        );
        el.classList.toggle("is-active", match);
      });
    const kpiBtn = this.container.querySelector<HTMLElement>("[data-kpi-msgs-btn]");
    if (kpiBtn) {
      kpiBtn.classList.toggle("is-active", this.activeThreadKey === "all");
    }
  }

  private updateThinkingTimers(): void {
    const nowSec = Date.now() / 1000;
    this.container.querySelectorAll<HTMLElement>("[data-thinking-timer]").forEach((el) => {
      const id = el.dataset.thinkingTimer;
      const start = Number(el.dataset.thinkingStart || nowSec);
      const elapsed = Math.max(0, nowSec - start);
      const agent = this.lastAgents.find((a) => a.id === id);
      el.textContent = `thinking ${fmtDuration(elapsed)} · ${agent?.toolCalls ?? 0}t`;
    });
  }

  private applyViewBox(): void {
    this.meshSvg.setAttribute(
      "viewBox",
      `${this.viewState.x.toFixed(1)} ${this.viewState.y.toFixed(1)} ${this.viewState.w.toFixed(1)} ${this.viewState.h.toFixed(1)}`
    );
  }

  private fitGraph(): void {
    this.viewState.x = 0;
    this.viewState.y = 0;
    this.viewState.w = this.viewState.baseW;
    this.viewState.h = this.viewState.baseH;
    this.viewState.userModified = false;
    this.applyViewBox();
  }

  private zoomBy(factor: number, cxFrac = 0.5, cyFrac = 0.5): void {
    const minW = this.viewState.baseW * 0.3;
    const maxW = this.viewState.baseW * 2.8;
    const nextW = Math.max(minW, Math.min(maxW, this.viewState.w * factor));
    const actualFactor = nextW / this.viewState.w;
    const nextH = this.viewState.h * actualFactor;
    this.viewState.x += (this.viewState.w - nextW) * cxFrac;
    this.viewState.y += (this.viewState.h - nextH) * cyFrac;
    this.viewState.w = nextW;
    this.viewState.h = nextH;
    this.viewState.userModified = true;
    this.applyViewBox();
  }

  private activateThreadByKey(key: string, runId?: string): void {
    const trimmed = key.trim();
    if (!trimmed) return;
    const lastColon = trimmed.lastIndexOf(":");
    const parentClusterKey =
      trimmed.startsWith("cluster:") && lastColon > "cluster:".length
        ? trimmed.slice(0, lastColon)
        : null;
    const base =
      this.threadLookup.get(trimmed) ??
      (parentClusterKey ? this.threadLookup.get(parentClusterKey) : undefined) ??
      (trimmed === "all" ? this.threadLookup.get("all") : undefined);
    if (!base) return;
    if (base.kind === "cluster" && runId) {
      this.cb.onSelectThread?.({ ...base, runId });
      return;
    }
    this.cb.onSelectThread?.(base);
  }

  private toggleAgentSelection(agentId: string): void {
    const next = this.selectedId === agentId ? null : agentId;
    this.selectedId = next;
    const clearBtn = this.container.querySelector<HTMLButtonElement>("[data-clear-agent]");
    if (clearBtn) clearBtn.hidden = !next;
    this.cb.onSelectAgent(next);
    this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
  }

  private bindInteractions(): void {
    this.container.addEventListener("click", (e) => {
      const target = e.target as Element | null;
      if (!target) return;

      // 1. View mode toggle [Grouped | Mesh]
      const viewBtn = target.closest<HTMLButtonElement>("[data-view-mode]");
      if (viewBtn) {
        const mode = viewBtn.dataset.viewMode as "grouped" | "mesh" | undefined;
        if (mode) {
          this.manualMode = mode;
          safeStoreSet(VIEW_MODE_KEY, mode);
          this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
        }
        return;
      }

      if (target.closest("[data-switch-grouped]")) {
        this.manualMode = "grouped";
        safeStoreSet(VIEW_MODE_KEY, "grouped");
        this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
        return;
      }

      if (target.closest("[data-reset-auto]")) {
        this.manualMode = null;
        safeStoreDel(VIEW_MODE_KEY);
        this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
        return;
      }

      // 2. Card detail style toggle [Basic | Detailed]
      const styleBtn = target.closest<HTMLButtonElement>("[data-card-style]");
      if (styleBtn) {
        const style = styleBtn.dataset.cardStyle as "basic" | "detailed" | undefined;
        if (style) {
          this.cardStyle = style;
          safeStoreSet(CARD_STYLE_KEY, style);
          this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
        }
        return;
      }

      // 3. Zoom bar
      const zoomBtn = target.closest<HTMLButtonElement>("[data-zoom]");
      if (zoomBtn) {
        const action = zoomBtn.dataset.zoom;
        if (action === "in") this.zoomBy(0.8);
        else if (action === "out") this.zoomBy(1.25);
        else this.fitGraph();
        return;
      }

      // 4. Clear agent filter
      if (target.closest("[data-clear-agent]")) {
        this.selectedId = null;
        const clearBtn = this.container.querySelector<HTMLButtonElement>("[data-clear-agent]");
        if (clearBtn) clearBtn.hidden = true;
        this.cb.onSelectAgent(null);
        this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
        return;
      }

      // 5. Filter strip chips
      const filterChip = target.closest<HTMLButtonElement>("[data-topo-filter]");
      if (filterChip) {
        const f = filterChip.dataset.topoFilter || "all";
        if (f.startsWith("ext:")) {
          this.extFilter = this.extFilter === f ? null : f;
        } else {
          this.statusFilter = f === "active" || f === "done" ? f : "all";
          this.extFilter = null;
        }
        this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
        return;
      }

      // 6. External lane cards or mesh external nodes
      const extBtn = target.closest<Element>("[data-ext-filter]");
      if (extBtn) {
        const ext = extBtn.getAttribute("data-ext-filter");
        if (ext) {
          this.extFilter = this.extFilter === ext ? null : ext;
          this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
        }
        return;
      }

      // 7. Collapsible [+N done ▾] chips
      const toggleDoneBtn = target.closest<HTMLButtonElement>("[data-toggle-done]");
      if (toggleDoneBtn) {
        e.stopPropagation();
        const cid = toggleDoneBtn.dataset.toggleDone;
        if (cid) {
          if (this.expandedDone.has(cid)) this.expandedDone.delete(cid);
          else this.expandedDone.add(cid);
          this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
        }
        return;
      }

      // 8. Footer Messages KPI button
      if (target.closest("[data-kpi-msgs-btn]")) {
        this.activateThreadByKey("all");
        return;
      }

      // 9. Clickable [N msg] pills & card message badges
      const threadEl = target.closest<Element>("[data-thread-key]");
      if (threadEl) {
        e.stopPropagation();
        const tkey = threadEl.getAttribute("data-thread-key");
        const runId = threadEl.getAttribute("data-run-id") || undefined;
        if (tkey) this.activateThreadByKey(tkey, runId);
        return;
      }

      // 9.5 Open Agent Chat trigger (card button, Needs Input badge, or mesh pill)
      const openChatEl = target.closest<Element>("[data-open-chat]");
      if (openChatEl) {
        e.stopPropagation();
        const aid = openChatEl.getAttribute("data-open-chat");
        if (aid) this.cb.onOpenChat?.(aid);
        return;
      }

      // 9.6 Explicit card/run title select button
      const selectAgentBtn = target.closest<HTMLButtonElement>("[data-select-agent]");
      if (selectAgentBtn) {
        e.stopPropagation();
        const aid = selectAgentBtn.dataset.selectAgent;
        if (aid) this.toggleAgentSelection(aid);
        return;
      }

      // 10. Specific run item inside a cluster card
      const runEl = target.closest<HTMLElement>("[data-run-agent-id]");
      if (runEl) {
        e.stopPropagation();
        const aid = runEl.dataset.runAgentId;
        if (aid) this.toggleAgentSelection(aid);
        return;
      }

      // 11. Agent / Cluster card selection
      const agentEl = target.closest<Element>("[data-agent-id]");
      if (agentEl) {
        const aid = agentEl.getAttribute("data-agent-id");
        if (aid) this.toggleAgentSelection(aid);
      }
    });

    const activateKeyTarget = (target: Element) => {
      const openChatEl = target.closest<Element>("[data-open-chat]");
      if (openChatEl && openChatEl.tagName !== "BUTTON") {
        const aid = openChatEl.getAttribute("data-open-chat");
        if (aid) this.cb.onOpenChat?.(aid);
        return;
      }

      const threadEl = target.closest<Element>("[data-thread-key]");
      if (threadEl && threadEl.tagName !== "BUTTON") {
        const tkey = threadEl.getAttribute("data-thread-key");
        const runId = threadEl.getAttribute("data-run-id") || undefined;
        if (tkey) this.activateThreadByKey(tkey, runId);
        return;
      }

      const extEl = target.closest<Element>("[data-ext-filter]");
      if (extEl && extEl.tagName !== "BUTTON") {
        const ext = extEl.getAttribute("data-ext-filter");
        if (ext) {
          this.extFilter = this.extFilter === ext ? null : ext;
          this.render(this.lastAgents, this.lastEdges, this.lastCounters, this.lastMeta);
        }
        return;
      }

      const agentEl = target.closest<Element>("[data-agent-id]");
      if (agentEl && agentEl.tagName !== "BUTTON") {
        const aid = agentEl.getAttribute("data-agent-id");
        if (aid) this.toggleAgentSelection(aid);
      }
    };

    this.container.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const target = e.target as Element | null;
      if (!target || target.tagName === "BUTTON") return;
      if (e.key === " ") {
        e.preventDefault();
        return;
      }
      activateKeyTarget(target);
    });

    this.container.addEventListener("keyup", (e) => {
      if (e.key !== " ") return;
      const target = e.target as Element | null;
      if (!target || target.tagName === "BUTTON") return;
      activateKeyTarget(target);
    });

    // Mesh zoom & pan interactions
    this.meshWrapEl.addEventListener(
      "wheel",
      (e) => {
        if (this.viewMode !== "mesh") return;
        e.preventDefault();
        const rect = this.meshWrapEl.getBoundingClientRect();
        const fx = (e.clientX - rect.left) / Math.max(1, rect.width);
        const fy = (e.clientY - rect.top) / Math.max(1, rect.height);
        this.zoomBy(e.deltaY > 0 ? 1.12 : 0.89, fx, fy);
      },
      { passive: false }
    );

    this.meshWrapEl.addEventListener("pointerdown", (e) => {
      if (this.viewMode !== "mesh") return;
      if ((e.target as Element)?.closest(".agent-card, .mesh-edge-pill, .mesh-ext-node")) return;
      this.isPanning = true;
      this.meshWrapEl.classList.add("panning");
      this.panStart = {
        x: e.clientX,
        y: e.clientY,
        vx: this.viewState.x,
        vy: this.viewState.y,
      };
      this.meshWrapEl.setPointerCapture(e.pointerId);
    });

    this.meshWrapEl.addEventListener("pointermove", (e) => {
      if (!this.isPanning) return;
      const rect = this.meshWrapEl.getBoundingClientRect();
      const dx = ((e.clientX - this.panStart.x) / Math.max(1, rect.width)) * this.viewState.w;
      const dy = ((e.clientY - this.panStart.y) / Math.max(1, rect.height)) * this.viewState.h;
      this.viewState.x = this.panStart.vx - dx;
      this.viewState.y = this.panStart.vy - dy;
      this.viewState.userModified = true;
      this.applyViewBox();
    });

    const endPan = () => {
      this.isPanning = false;
      this.meshWrapEl.classList.remove("panning");
    };
    this.meshWrapEl.addEventListener("pointerup", endPan);
    this.meshWrapEl.addEventListener("pointercancel", endPan);
  }
}
