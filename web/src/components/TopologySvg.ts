import type {
  AgentEdgeSnapshot,
  AgentNodeSnapshot,
  NormalizedEvent,
} from "../types.js";
import {
  colorForAgent,
  colorForEventKind,
  fmtDuration,
  getIdeMeta,
  getStatusStyle,
  trunc,
} from "../utils.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const CARD_W = 196;
const CARD_H = 82;
const HUMAN_W = 170;
const HUMAN_H = 74;
const EXT_W = 148;
const EXT_H = 46;

interface PositionedNode extends AgentNodeSnapshot {
  x: number;
  y: number;
  mutedRail?: boolean;
}

interface LayoutResult {
  map: Map<string, PositionedNode>;
  worldW: number;
  worldH: number;
  completedY: number | null;
  extY: number | null;
}

export interface TopologyCallbacks {
  onSelectAgent: (agentId: string | null) => void;
}

export class TopologySvg {
  private container: HTMLElement;
  private svg: SVGSVGElement;
  private wrap: HTMLElement;
  private cb: TopologyCallbacks;

  private layoutMap = new Map<string, PositionedNode>();
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private lastAgents: AgentNodeSnapshot[] = [];
  private lastEdges: AgentEdgeSnapshot[] = [];

  private viewState = {
    x: 0,
    y: 0,
    w: 880,
    h: 480,
    baseW: 880,
    baseH: 480,
    userModified: false,
  };

  private isPanning = false;
  private panStart = { x: 0, y: 0, vx: 0, vy: 0 };
  private tickTimer: number | null = null;

  constructor(container: HTMLElement, cb: TopologyCallbacks) {
    this.container = container;
    this.cb = cb;

    this.container.innerHTML = `
      <div class="card-head topo-head">
        <div class="topo-head-left">
          <span class="card-title">Agent Topology Mesh</span>
          <div class="legend" aria-label="Status legend">
            <span><i class="sw" style="background:#c084fc"></i>Thinking</span>
            <span><i class="sw" style="background:#f59e0b"></i>Working</span>
            <span><i class="sw" style="background:#06b6d4"></i>Waiting</span>
            <span><i class="sw" style="background:#f43f5e"></i>Blocked</span>
            <span><i class="sw" style="background:#10b981"></i>Done</span>
          </div>
        </div>
        <div class="topo-head-right">
          <div class="zoom-bar" role="group" aria-label="Canvas zoom controls">
            <button type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>
            <button type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
            <button type="button" data-zoom="fit" title="Reset view to fit">Fit</button>
          </div>
          <button type="button" class="fs-btn" data-clear-agent hidden>Clear Filter</button>
        </div>
      </div>
      <div
        class="graph-wrap"
        data-graph-wrap
        role="region"
        tabindex="0"
        aria-label="Interactive multi-agent topology diagram"
      >
        <svg
          class="topo-svg"
          data-topo-svg
          viewBox="0 0 880 480"
          preserveAspectRatio="xMidYMid meet"
        ></svg>
        <div class="topo-empty-overlay" data-topo-empty hidden>
          Waiting for agent activity… Send a prompt or click <strong>Doctor → Send Test Event</strong>.
        </div>
      </div>
      <div class="summary-strip" data-summary-strip>
        <div><span>Agents</span><b data-kpi-agents>0</b></div>
        <div><span>Active</span><b data-kpi-active>0</b></div>
        <div><span>Tool Calls</span><b data-kpi-tools>0</b></div>
        <div><span>Messages</span><b data-kpi-msgs>0</b></div>
      </div>
    `;

    this.wrap = this.container.querySelector("[data-graph-wrap]") as HTMLElement;
    this.svg = this.container.querySelector("[data-topo-svg]") as SVGSVGElement;

    this.bindInteractions();

    // Refresh THINKING live elapsed timers once per second
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
  }

  public setSelectedAgent(agentId: string | null): void {
    this.selectedId = agentId;
    const clearBtn = this.container.querySelector("[data-clear-agent]") as HTMLButtonElement | null;
    if (clearBtn) clearBtn.hidden = !agentId;
    this.render(this.lastAgents, this.lastEdges);
  }

  public render(
    agents: AgentNodeSnapshot[],
    edges: AgentEdgeSnapshot[],
    counters?: { toolCalls: number; messages: number; activeAgents: number }
  ): void {
    this.lastAgents = agents;
    this.lastEdges = edges;

    const laid = this.layoutNodes(agents);
    this.layoutMap = laid.map;

    const baseChanged =
      this.viewState.baseW !== laid.worldW || this.viewState.baseH !== laid.worldH;
    this.viewState.baseW = laid.worldW;
    this.viewState.baseH = laid.worldH;
    if (!this.viewState.userModified || baseChanged) {
      this.viewState.x = 0;
      this.viewState.y = 0;
      this.viewState.w = laid.worldW;
      this.viewState.h = laid.worldH;
      if (baseChanged && !this.viewState.userModified) {
        this.viewState.userModified = false;
      }
    }
    this.applyViewBox();

    // Update KPI strip
    const realAgents = agents.filter(
      (a) => (a.nodeType ?? "agent") === "agent"
    );
    const activeCount =
      counters?.activeAgents ??
      realAgents.filter((a) => a.status === "THINKING" || a.status === "WORKING").length;
    const toolCount =
      counters?.toolCalls ??
      realAgents.reduce((sum, a) => sum + (a.toolCalls || 0), 0);
    const msgCount =
      counters?.messages ??
      realAgents.reduce((sum, a) => sum + (a.messagesSent || 0), 0);

    const setTxt = (sel: string, val: string) => {
      const el = this.container.querySelector(sel);
      if (el) el.textContent = val;
    };
    setTxt("[data-kpi-agents]", String(realAgents.length));
    setTxt("[data-kpi-active]", String(activeCount));
    setTxt("[data-kpi-tools]", String(toolCount));
    setTxt("[data-kpi-msgs]", String(msgCount));

    let packetLayer = this.svg.querySelector<SVGGElement>("#topoPackets");
    this.svg.innerHTML = "";

    const emptyOverlay = this.container.querySelector<HTMLElement>("[data-topo-empty]");
    if (agents.length === 0) {
      if (emptyOverlay) emptyOverlay.hidden = false;
      return;
    }
    if (emptyOverlay) emptyOverlay.hidden = true;

    const drawDivider = (yPos: number, label: string) => {
      const g = document.createElementNS(SVG_NS, "g");
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", "26");
      line.setAttribute("y1", String(yPos));
      line.setAttribute("x2", String(laid.worldW - 26));
      line.setAttribute("y2", String(yPos));
      line.setAttribute("stroke", "#1e2942");
      line.setAttribute("stroke-dasharray", "4 5");

      const lbl = document.createElementNS(SVG_NS, "text");
      lbl.setAttribute("x", "34");
      lbl.setAttribute("y", String(yPos - 6));
      lbl.setAttribute("fill", "#64748b");
      lbl.setAttribute("font-size", "9.5");
      lbl.setAttribute("font-weight", "700");
      lbl.setAttribute("letter-spacing", "0.08em");
      lbl.textContent = label;

      g.append(line, lbl);
      this.svg.appendChild(g);
    };

    if (laid.completedY != null) drawDivider(laid.completedY, "COMPLETED / STANDBY");
    if (laid.extY != null) drawDivider(laid.extY, "EXTERNAL SYSTEMS & MCP TOOLS");

    const rootNode =
      realAgents.find((a) => a.id === "root" || !a.parentAgentId) ?? realAgents[0];
    const rootId = rootNode?.id;

    // Build edge pairs (structural hierarchy + observed message/tool edges)
    const edgeLookup = new Map<string, AgentEdgeSnapshot>();
    for (const e of edges) {
      const key = [e.from, e.to].sort().join("|");
      const prev = edgeLookup.get(key);
      if (prev) {
        edgeLookup.set(key, { ...prev, count: prev.count + e.count });
      } else {
        edgeLookup.set(key, { ...e });
      }
    }

    const pairSet = new Set<string>(edgeLookup.keys());
    const humanNode = agents.find((a) => a.nodeType === "human" || a.id === "ext:human");
    if (humanNode && rootId) {
      pairSet.add([humanNode.id, rootId].sort().join("|"));
    }
    for (const a of realAgents) {
      const parent = a.parentAgentId || (a.id !== rootId ? rootId : undefined);
      if (parent && parent !== a.id && this.layoutMap.has(parent)) {
        pairSet.add([parent, a.id].sort().join("|"));
      }
    }

    const activeKey = this.hoveredId || this.selectedId;
    const edgeLayer = document.createElementNS(SVG_NS, "g");

    Array.from(pairSet).forEach((pairKey, idx) => {
      const [aId, bId] = pairKey.split("|");
      if (!aId || !bId) return;
      const na = this.layoutMap.get(aId);
      const nb = this.layoutMap.get(bId);
      if (!na || !nb) return;

      const isHumanEdge = na.nodeType === "human" || nb.nodeType === "human";
      const isExtEdge = na.nodeType === "external" || nb.nodeType === "external";
      const isPeer = !isHumanEdge && !isExtEdge && aId !== rootId && bId !== rootId;
      const c = this.curveBetween(
        na,
        nb,
        isExtEdge ? 0.2 : isPeer ? 0.45 : idx % 2 === 0 ? -0.7 : 0.7
      );
      const edgeRec = edgeLookup.get(pairKey);
      const count = edgeRec?.count ?? 0;
      const isActiveEnd = (n: PositionedNode) =>
        n.status === "WORKING" || n.status === "THINKING";
      const isHot = (isActiveEnd(na) || isActiveEnd(nb)) && count > 0;

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M ${c.x1} ${c.y1} Q ${c.cx} ${c.cy} ${c.x2} ${c.y2}`);
      path.setAttribute("fill", "none");

      let strokeCol =
        count > 0
          ? isPeer
            ? "#06b6d4"
            : "#a855f7"
          : isPeer
            ? "rgba(6,182,212,0.22)"
            : "rgba(168,85,247,0.18)";
      if (isHumanEdge) strokeCol = count > 0 ? "#f59e0b" : "rgba(245,158,11,0.24)";
      else if (isExtEdge) strokeCol = "#38bdf8";

      path.setAttribute("stroke", strokeCol);
      if (isExtEdge) {
        path.classList.add("ext-edge");
        path.dataset.a = aId;
        path.dataset.b = bId;
        if (activeKey && (aId === activeKey || bId === activeKey)) {
          path.classList.add("ext-lit");
        }
        path.setAttribute("stroke-opacity", "0.2");
        path.setAttribute("stroke-width", "1.3");
        path.setAttribute("stroke-dasharray", "4 4");
      } else {
        path.setAttribute("stroke-opacity", isHot ? "0.95" : count > 0 ? "0.74" : "1");
        path.setAttribute("stroke-width", isHot ? "2.6" : count > 0 ? "2.1" : "1.25");
        if (isPeer || isHot) {
          path.setAttribute("stroke-dasharray", count > 0 ? "7 5" : "4 6");
        }
        if (isHot) path.classList.add("flow-edge");
      }
      edgeLayer.appendChild(path);

      if (count > 0 && !isExtEdge) {
        const mx = 0.25 * c.x1 + 0.5 * c.cx + 0.25 * c.x2;
        const my = 0.25 * c.y1 + 0.5 * c.cy + 0.25 * c.y2;
        const lblText = `${count} msg`;
        const pillW = Math.max(40, lblText.length * 6.2 + 10);
        const bg = document.createElementNS(SVG_NS, "rect");
        bg.setAttribute("x", String(mx - pillW / 2));
        bg.setAttribute("y", String(my - 10));
        bg.setAttribute("width", String(pillW));
        bg.setAttribute("height", "19");
        bg.setAttribute("rx", "9");
        bg.setAttribute("fill", "#0b1220");
        bg.setAttribute("stroke", isHumanEdge ? "#f59e0b" : isPeer ? "#06b6d4" : "#a855f7");
        bg.setAttribute("stroke-width", "1.2");

        const tx = document.createElementNS(SVG_NS, "text");
        tx.setAttribute("x", String(mx));
        tx.setAttribute("y", String(my + 3));
        tx.setAttribute("text-anchor", "middle");
        tx.setAttribute("fill", "#e2e8f0");
        tx.setAttribute("font-size", "10");
        tx.setAttribute("font-weight", "650");
        tx.textContent = lblText;

        edgeLayer.append(bg, tx);
      }
    });
    this.svg.appendChild(edgeLayer);

    if (!packetLayer) {
      packetLayer = document.createElementNS(SVG_NS, "g");
      packetLayer.id = "topoPackets";
    }
    this.svg.appendChild(packetLayer);

    const nodeLayer = document.createElementNS(SVG_NS, "g");
    for (const node of this.layoutMap.values()) {
      nodeLayer.appendChild(this.buildNodeGroup(node, node.id === rootId));
    }
    this.svg.appendChild(nodeLayer);
  }

  public animatePacket(ev: NormalizedEvent): void {
    const fromId = ev.kind === "user_input" ? "ext:human" : ev.agentId;
    const toId = ev.kind === "user_input" ? ev.agentId : ev.targetAgentId;
    if (!fromId || !toId || fromId === toId) return;

    const na = this.layoutMap.get(fromId);
    const nb = this.layoutMap.get(toId);
    const pg = this.svg.querySelector("#topoPackets");
    if (!na || !nb || !pg) return;

    const c = this.curveBetween(na, nb, 0.5);
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("r", "6");
    dot.setAttribute("fill", colorForEventKind(ev.kind, ev.payload));
    dot.setAttribute("stroke", "#ffffff");
    dot.setAttribute("stroke-width", "1.5");
    pg.appendChild(dot);

    const t0 = performance.now();
    const dur = 760;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      const omt = 1 - e;
      const cx = omt * omt * c.x1 + 2 * omt * e * c.cx + e * e * c.x2;
      const cy = omt * omt * c.y1 + 2 * omt * e * c.cy + e * e * c.y2;
      dot.setAttribute("cx", cx.toFixed(1));
      dot.setAttribute("cy", cy.toFixed(1));
      dot.setAttribute("opacity", t > 0.85 ? String((1 - t) / 0.15) : "1");
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        dot.remove();
      }
    };
    requestAnimationFrame(step);
  }

  private buildNodeGroup(node: PositionedNode, isRoot: boolean): SVGGElement {
    const g = document.createElementNS(SVG_NS, "g");
    g.classList.add("agent-card");
    g.setAttribute("role", "button");
    g.setAttribute("tabindex", "0");
    g.setAttribute("aria-label", `${node.label} (${node.status})`);

    const isSelected = this.selectedId === node.id;
    if (node.mutedRail && !isSelected) g.setAttribute("opacity", "0.84");

    g.addEventListener("mouseenter", () => {
      this.hoveredId = node.id;
      this.updateExternalHighlight();
    });
    g.addEventListener("mouseleave", () => {
      if (this.hoveredId === node.id) this.hoveredId = null;
      this.updateExternalHighlight();
    });
    const activate = () => {
      const next = this.selectedId === node.id ? null : node.id;
      this.selectedId = next;
      const clearBtn = this.container.querySelector("[data-clear-agent]") as HTMLButtonElement | null;
      if (clearBtn) clearBtn.hidden = !next;
      this.cb.onSelectAgent(next);
      this.render(this.lastAgents, this.lastEdges);
    };
    g.addEventListener("click", activate);
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });

    const ntype = node.nodeType ?? "agent";
    const accent = colorForAgent(node.id, isRoot);

    if (ntype === "external") {
      const ex = node.x - EXT_W / 2;
      const ey = node.y - EXT_H / 2;
      const icon = node.id.startsWith("ext:mcp:")
        ? "🔌"
        : node.id === "ext:board"
          ? "📋"
          : node.id === "ext:web"
            ? "🌐"
            : node.id === "ext:shell"
              ? "⚡"
              : "📁";

      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(ex));
      rect.setAttribute("y", String(ey));
      rect.setAttribute("width", String(EXT_W));
      rect.setAttribute("height", String(EXT_H));
      rect.setAttribute("rx", "9");
      rect.setAttribute("fill", "#0b1322");
      rect.setAttribute("stroke", isSelected ? "#ffffff" : "#38bdf8");
      rect.setAttribute("stroke-width", isSelected ? "2.2" : "1.4");
      rect.setAttribute("stroke-dasharray", "5 3");

      const lbl = document.createElementNS(SVG_NS, "text");
      lbl.setAttribute("x", String(ex + 10));
      lbl.setAttribute("y", String(ey + 19));
      lbl.setAttribute("fill", "#e2e8f0");
      lbl.setAttribute("font-size", "11");
      lbl.setAttribute("font-weight", "700");
      lbl.textContent = `${icon} ${trunc(node.label, 15)}`;

      const sub = document.createElementNS(SVG_NS, "text");
      sub.setAttribute("x", String(ex + 10));
      sub.setAttribute("y", String(ey + 35));
      sub.setAttribute("fill", "#94a3b8");
      sub.setAttribute("font-size", "9.5");
      sub.setAttribute("font-family", "ui-monospace, Consolas, monospace");
      sub.textContent = `${node.toolCalls} calls · ${trunc(node.summary || "ready", 13)}`;

      g.append(rect, lbl, sub);
      return g;
    }

    const w = ntype === "human" ? HUMAN_W : CARD_W;
    const h = ntype === "human" ? HUMAN_H : CARD_H;
    const x = node.x - w / 2;
    const y = node.y - h / 2;
    const st = getStatusStyle(node.status);
    const isThinking = ntype === "agent" && node.status === "THINKING";
    const isWorking = ntype === "agent" && node.status === "WORKING";
    const isBlocked = ntype === "agent" && node.status === "BLOCKED";
    const isDone = ntype === "agent" && node.status === "DONE";
    const isBusy = isThinking || isWorking;

    // Pulsing halo for THINKING (violet), WORKING (amber), BLOCKED (rose)
    if (isBusy || isBlocked) {
      const halo = document.createElementNS(SVG_NS, "rect");
      halo.setAttribute("x", String(x - 5));
      halo.setAttribute("y", String(y - 5));
      halo.setAttribute("width", String(w + 10));
      halo.setAttribute("height", String(h + 10));
      halo.setAttribute("rx", "14");
      halo.setAttribute("fill", "none");
      halo.setAttribute("stroke", st.stroke);
      halo.setAttribute("stroke-width", "3");
      halo.classList.add("work-halo");
      g.appendChild(halo);
    }

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", ntype === "human" ? "16" : "11");
    rect.setAttribute(
      "fill",
      ntype === "human"
        ? "#1d1609"
        : isThinking
          ? "#1a1433"
          : isWorking
            ? "#1e1a12"
            : isBlocked
              ? "#24111a"
              : node.status === "IDLE"
                ? "#0d121e"
                : "#111a2c"
    );
    rect.setAttribute(
      "stroke",
      isSelected
        ? "#ffffff"
        : ntype === "human"
          ? "#f59e0b"
          : isThinking || isWorking || isBlocked
            ? st.stroke
            : isDone
              ? "#10b981"
              : node.status === "IDLE"
                ? "#24314c"
                : accent
    );
    rect.setAttribute("stroke-width", isSelected ? "2.5" : isBusy || isBlocked ? "2.1" : "1.6");

    // Left accent rail
    const bar = document.createElementNS(SVG_NS, "rect");
    bar.setAttribute("x", String(x + 1));
    bar.setAttribute("y", String(y + 1));
    bar.setAttribute("width", "5");
    bar.setAttribute("height", String(h - 2));
    bar.setAttribute("rx", "3");
    bar.setAttribute("fill", isThinking ? "#c084fc" : isWorking ? "#f59e0b" : isBlocked ? "#f43f5e" : accent);
    bar.setAttribute("opacity", node.status === "IDLE" && ntype !== "human" ? "0.4" : "1");

    // Agent Name
    const nameTx = document.createElementNS(SVG_NS, "text");
    nameTx.setAttribute("x", String(x + 13));
    nameTx.setAttribute("y", String(y + 21));
    nameTx.setAttribute("fill", ntype === "human" ? "#fde68a" : "#f8fafc");
    nameTx.setAttribute("font-size", "12");
    nameTx.setAttribute("font-weight", "700");
    nameTx.textContent = ntype === "human" ? "👤 User" : trunc(node.label, 14);

    // Status Pill
    const statusLabel = ntype === "human" ? "HUMAN" : isDone ? "✓ DONE" : st.label;
    const pillW = ntype === "human" ? 54 : isBusy ? 72 : 60;
    const pillX = x + w - pillW - 8;
    const pillBg = document.createElementNS(SVG_NS, "rect");
    pillBg.setAttribute("x", String(pillX));
    pillBg.setAttribute("y", String(y + 8));
    pillBg.setAttribute("width", String(pillW));
    pillBg.setAttribute("height", "17");
    pillBg.setAttribute("rx", "8.5");
    pillBg.setAttribute("fill", ntype === "human" ? "rgba(245,158,11,0.18)" : st.fill);
    pillBg.setAttribute("stroke", ntype === "human" ? "#f59e0b" : st.stroke);
    pillBg.setAttribute("stroke-width", "1.1");

    const pillTx = document.createElementNS(SVG_NS, "text");
    pillTx.setAttribute("x", String(pillX + (isBusy ? pillW / 2 + 4 : pillW / 2)));
    pillTx.setAttribute("y", String(y + 20));
    pillTx.setAttribute("text-anchor", "middle");
    pillTx.setAttribute("fill", ntype === "human" ? "#fcd34d" : st.text);
    pillTx.setAttribute("font-size", "8.7");
    pillTx.setAttribute("font-weight", "750");
    pillTx.textContent = statusLabel;

    // Action summary line
    const actTx = document.createElementNS(SVG_NS, "text");
    actTx.setAttribute("x", String(x + 13));
    actTx.setAttribute("y", String(y + 42));
    actTx.setAttribute("fill", isThinking ? "#e9d5ff" : isWorking ? "#fde68a" : "#cbd5e1");
    actTx.setAttribute("font-size", "10.5");
    actTx.textContent = trunc(
      node.activeTool ? `⚙ ${node.activeTool}` : node.summary || node.role || "Standby",
      ntype === "human" ? 21 : 25
    );

    // Bottom metadata line (with IDE badge on agent cards + live THINKING timer)
    const metaTx = document.createElementNS(SVG_NS, "text");
    metaTx.setAttribute("x", String(x + 13));
    metaTx.setAttribute("y", String(y + (ntype === "human" ? 60 : 65)));
    metaTx.setAttribute("fill", isThinking ? "#d8b4fe" : "#8b9bb8");
    metaTx.setAttribute("font-size", "9.6");
    metaTx.setAttribute("font-family", "ui-monospace, Consolas, monospace");
    if (isThinking) {
      metaTx.dataset.thinkingTimer = node.id;
      metaTx.dataset.thinkingStart = String(
        node.thinkingEpoch ?? (node.thinkingSince ? Date.parse(node.thinkingSince) / 1000 : Date.now() / 1000)
      );
      const elapsed = Math.max(
        0,
        Date.now() / 1000 - Number(metaTx.dataset.thinkingStart)
      );
      metaTx.textContent = `thinking ${fmtDuration(elapsed)} · ${node.toolCalls}t`;
    } else if (ntype === "human") {
      metaTx.textContent = `${node.messagesSent} prompts · ${node.messagesReceived} replies`;
    } else {
      metaTx.textContent = `${node.toolCalls} tools · ${node.messagesSent}↑ ${node.messagesReceived}↓`;
    }

    g.append(rect, bar, nameTx, pillBg, pillTx, actTx, metaTx);

    // IDE Badge in bottom-right of every agent card
    if (ntype === "agent") {
      const ideMeta = getIdeMeta(node.ide);
      const badgeW = Math.max(30, ideMeta.short.length * 6.2 + 10);
      const bx = x + w - badgeW - 8;
      const by = y + h - 24;
      const badgeBg = document.createElementNS(SVG_NS, "rect");
      badgeBg.setAttribute("x", String(bx));
      badgeBg.setAttribute("y", String(by));
      badgeBg.setAttribute("width", String(badgeW));
      badgeBg.setAttribute("height", "15");
      badgeBg.setAttribute("rx", "4");
      badgeBg.setAttribute("fill", ideMeta.bg);
      badgeBg.setAttribute("stroke", ideMeta.border);
      badgeBg.setAttribute("stroke-width", "1");

      const badgeTx = document.createElementNS(SVG_NS, "text");
      badgeTx.setAttribute("x", String(bx + badgeW / 2));
      badgeTx.setAttribute("y", String(by + 10.5));
      badgeTx.setAttribute("text-anchor", "middle");
      badgeTx.setAttribute("fill", ideMeta.color);
      badgeTx.setAttribute("font-size", "8.2");
      badgeTx.setAttribute("font-weight", "750");
      badgeTx.textContent = ideMeta.short;
      g.append(badgeBg, badgeTx);
    }

    // Live blinking dot + animated shimmer scan bar for THINKING / WORKING
    if (isBusy) {
      const pDot = document.createElementNS(SVG_NS, "circle");
      pDot.setAttribute("cx", String(pillX + 9));
      pDot.setAttribute("cy", String(y + 16.5));
      pDot.setAttribute("r", "3");
      pDot.setAttribute("fill", st.stroke);
      pDot.classList.add("live-dot");
      g.appendChild(pDot);

      const clipId = `clip-${node.id.replace(/[^a-z0-9]/gi, "_")}`;
      const defs = document.createElementNS(SVG_NS, "defs");
      const cp = document.createElementNS(SVG_NS, "clipPath");
      cp.setAttribute("id", clipId);
      const cRect = document.createElementNS(SVG_NS, "rect");
      cRect.setAttribute("x", String(x + 6));
      cRect.setAttribute("y", String(y + h - 5));
      cRect.setAttribute("width", String(w - 10));
      cRect.setAttribute("height", "4");
      cRect.setAttribute("rx", "2");
      cp.appendChild(cRect);
      defs.appendChild(cp);

      const trackBg = document.createElementNS(SVG_NS, "rect");
      trackBg.setAttribute("x", String(x + 6));
      trackBg.setAttribute("y", String(y + h - 5));
      trackBg.setAttribute("width", String(w - 10));
      trackBg.setAttribute("height", "3.5");
      trackBg.setAttribute("rx", "2");
      trackBg.setAttribute("fill", "rgba(255,255,255,0.08)");

      const scanWrap = document.createElementNS(SVG_NS, "g");
      scanWrap.setAttribute("clip-path", `url(#${clipId})`);
      const scan = document.createElementNS(SVG_NS, "rect");
      scan.setAttribute("x", String(x + 6));
      scan.setAttribute("y", String(y + h - 5));
      scan.setAttribute("width", "58");
      scan.setAttribute("height", "3.5");
      scan.setAttribute("rx", "2");
      scan.setAttribute("fill", st.stroke);
      scan.classList.add("scan-bar");
      scanWrap.appendChild(scan);

      g.append(defs, trackBg, scanWrap);
    }

    return g;
  }

  private updateThinkingTimers(): void {
    const nowSec = Date.now() / 1000;
    this.svg.querySelectorAll<SVGTextElement>("[data-thinking-timer]").forEach((el) => {
      const start = Number(el.dataset.thinkingStart || nowSec);
      const elapsed = Math.max(0, nowSec - start);
      const id = el.dataset.thinkingTimer;
      const agent = this.lastAgents.find((a) => a.id === id);
      el.textContent = `thinking ${fmtDuration(elapsed)} · ${agent?.toolCalls ?? 0}t`;
    });
  }

  private layoutNodes(nodes: AgentNodeSnapshot[]): LayoutResult {
    const map = new Map<string, PositionedNode>();
    if (nodes.length === 0) {
      return { map, worldW: 880, worldH: 480, completedY: null, extY: null };
    }

    const GAP_X = 28;
    const GAP_Y = 36;
    const PAD_X = 40;
    const PAD_TOP = 26;
    const PAD_BOT = 28;
    const STEP_X = CARD_W + GAP_X;
    const STEP_Y = CARD_H + GAP_Y;
    const MAX_COLS = 5;

    const human = nodes.find((n) => n.nodeType === "human" || n.id === "ext:human");
    const externals = nodes.filter((n) => n.nodeType === "external");
    const agents = nodes.filter(
      (n) => n.nodeType !== "human" && n.nodeType !== "external" && n.id !== "ext:human"
    );
    const root = agents.find((a) => a.id === "root" || !a.parentAgentId) ?? agents[0];
    const others = root ? agents.filter((a) => a.id !== root.id) : [];

    const splitActiveDone = others.length > 4;
    const isCompleted = (a: AgentNodeSnapshot) => a.status === "DONE" || a.status === "IDLE";
    const activeTier = splitActiveDone ? others.filter((a) => !isCompleted(a)) : others;
    const doneTier = splitActiveDone ? others.filter((a) => isCompleted(a)) : [];

    const maxAgentCols = Math.max(
      human && root ? 2 : 1,
      Math.min(MAX_COLS, Math.max(activeTier.length, doneTier.length, 1))
    );
    const extCols = Math.min(6, externals.length);
    const contentW = Math.max(
      880 - PAD_X * 2,
      maxAgentCols * CARD_W + Math.max(0, maxAgentCols - 1) * GAP_X,
      extCols * EXT_W + Math.max(0, extCols - 1) * 18
    );
    const worldW = Math.round(contentW + PAD_X * 2);
    const centerX = worldW / 2;

    const topY = PAD_TOP + CARD_H / 2;
    if (human && root) {
      map.set(human.id, { ...human, x: Math.round(centerX - STEP_X * 0.8), y: topY });
      map.set(root.id, { ...root, x: Math.round(centerX + STEP_X * 0.35), y: topY });
    } else if (human) {
      map.set(human.id, { ...human, x: Math.round(centerX), y: topY });
    } else if (root) {
      map.set(root.id, { ...root, x: Math.round(centerX), y: topY });
    }

    let cursorY = topY + CARD_H / 2 + 44;

    const placeRows = (arr: AgentNodeSnapshot[], mutedRail: boolean) => {
      if (arr.length === 0) return;
      const cols = Math.min(MAX_COLS, arr.length);
      for (let i = 0; i < arr.length; i += cols) {
        const row = arr.slice(i, i + cols);
        const rowW = row.length * CARD_W + (row.length - 1) * GAP_X;
        const startX = centerX - rowW / 2 + CARD_W / 2;
        const cy = Math.round(cursorY + CARD_H / 2);
        row.forEach((a, idx) => {
          map.set(a.id, {
            ...a,
            x: Math.round(startX + idx * STEP_X),
            y: cy,
            mutedRail,
          });
        });
        cursorY += STEP_Y;
      }
    };

    placeRows(activeTier, false);

    let completedY: number | null = null;
    if (doneTier.length > 0) {
      if (activeTier.length > 0) {
        completedY = Math.round(cursorY - GAP_Y / 2 + 6);
        cursorY += 26;
      }
      placeRows(doneTier, true);
    }

    let extY: number | null = null;
    if (externals.length > 0) {
      extY = Math.round(cursorY + 6);
      cursorY = extY + 24;
      const eCols = Math.min(6, externals.length);
      const eGap = 18;
      for (let i = 0; i < externals.length; i += eCols) {
        const row = externals.slice(i, i + eCols);
        const rowW = row.length * EXT_W + (row.length - 1) * eGap;
        const startX = centerX - rowW / 2 + EXT_W / 2;
        const cy = Math.round(cursorY + EXT_H / 2);
        row.forEach((e, idx) => {
          map.set(e.id, {
            ...e,
            x: Math.round(startX + idx * (EXT_W + eGap)),
            y: cy,
          });
        });
        cursorY += EXT_H + 18;
      }
    }

    const worldH = Math.max(480, Math.round(cursorY + PAD_BOT));
    return { map, worldW, worldH, completedY, extY };
  }

  private curveBetween(na: PositionedNode, nb: PositionedNode, seed: number) {
    const mx = (na.x + nb.x) / 2;
    const my = (na.y + nb.y) / 2;
    const dx = nb.x - na.x;
    const dy = nb.y - na.y;
    const len = Math.hypot(dx, dy) || 1;
    const off = seed * 22;
    return {
      x1: na.x,
      y1: na.y,
      cx: mx - (dy / len) * off,
      cy: my + (dx / len) * off,
      x2: nb.x,
      y2: nb.y,
    };
  }

  private applyViewBox(): void {
    this.svg.setAttribute(
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

  private updateExternalHighlight(): void {
    const activeKey = this.hoveredId || this.selectedId;
    this.svg.querySelectorAll<SVGPathElement>(".ext-edge").forEach((el) => {
      const hit = Boolean(activeKey && (el.dataset.a === activeKey || el.dataset.b === activeKey));
      el.classList.toggle("ext-lit", hit);
    });
  }

  private bindInteractions(): void {
    this.container.querySelectorAll<HTMLButtonElement>("[data-zoom]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.zoom;
        if (action === "in") this.zoomBy(0.8);
        else if (action === "out") this.zoomBy(1.25);
        else this.fitGraph();
      });
    });

    this.container.querySelector("[data-clear-agent]")?.addEventListener("click", () => {
      this.setSelectedAgent(null);
      this.cb.onSelectAgent(null);
    });

    this.wrap.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = this.wrap.getBoundingClientRect();
        const fx = (e.clientX - rect.left) / Math.max(1, rect.width);
        const fy = (e.clientY - rect.top) / Math.max(1, rect.height);
        this.zoomBy(e.deltaY > 0 ? 1.12 : 0.89, fx, fy);
      },
      { passive: false }
    );

    this.wrap.addEventListener("pointerdown", (e) => {
      if ((e.target as Element)?.closest(".agent-card")) return;
      this.isPanning = true;
      this.wrap.classList.add("panning");
      this.panStart = {
        x: e.clientX,
        y: e.clientY,
        vx: this.viewState.x,
        vy: this.viewState.y,
      };
      this.wrap.setPointerCapture(e.pointerId);
    });

    this.wrap.addEventListener("pointermove", (e) => {
      if (!this.isPanning) return;
      const rect = this.wrap.getBoundingClientRect();
      const dx = ((e.clientX - this.panStart.x) / Math.max(1, rect.width)) * this.viewState.w;
      const dy = ((e.clientY - this.panStart.y) / Math.max(1, rect.height)) * this.viewState.h;
      this.viewState.x = this.panStart.vx - dx;
      this.viewState.y = this.panStart.vy - dy;
      this.viewState.userModified = true;
      this.applyViewBox();
    });

    const endPan = () => {
      this.isPanning = false;
      this.wrap.classList.remove("panning");
    };
    this.wrap.addEventListener("pointerup", endPan);
    this.wrap.addEventListener("pointercancel", endPan);
  }
}
