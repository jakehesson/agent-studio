import { ActivityFeed } from "../components/ActivityFeed.js";
import { CommReaderModal } from "../components/CommReaderModal.js";
import { PayloadInspector } from "../components/PayloadInspector.js";
import { TimelineScrubber } from "../components/TimelineScrubber.js";
import { buildSnapshot } from "../state/snapshot.js";
import { TopologySvg } from "../components/TopologySvg.js";
import type {
  AgentNodeSnapshot,
  NormalizedEvent,
  SessionSnapshot,
  TeamDefinitionEntry,
} from "../types.js";

export class LiveStudioView {
  private root: HTMLElement;
  private topology: TopologySvg;
  private feed: ActivityFeed;
  private inspector: PayloadInspector;
  private scrubber: TimelineScrubber;
  private readerModal: CommReaderModal;

  private snapshot: SessionSnapshot | null = null;
  private agentLabelMap: Map<string, string> = new Map();
  private selectedAgentId: string | null = null;
  private selectedEventId: string | null = null;
  private lastAnimatedEventId: string | null = null;
  private coverSubPane: "topology" | "feed" = "topology";

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="studio-workspace" data-studio-workspace data-cover-pane="topology">
        <section class="card pane-topology" data-pane-topology aria-label="Topology mesh"></section>
        <section class="card pane-stream" data-pane-stream aria-label="Activity stream and payload inspector">
          <div class="stream-feed-slot" data-feed-slot></div>
          <div class="stream-inspector-slot" data-inspector-slot></div>
        </section>
      </div>
      <div class="timeline-bar" data-timeline-bar role="region" aria-label="Session timeline scrubber"></div>
    `;

    const topoEl = this.root.querySelector("[data-pane-topology]") as HTMLElement;
    const feedEl = this.root.querySelector("[data-feed-slot]") as HTMLElement;
    const inspEl = this.root.querySelector("[data-inspector-slot]") as HTMLElement;
    const tlEl = this.root.querySelector("[data-timeline-bar]") as HTMLElement;

    this.topology = new TopologySvg(topoEl, {
      onSelectAgent: (agentId) => {
        this.selectedAgentId = agentId;
        this.feed.setAgentFilter(agentId);
        if (agentId) {
          this.selectedEventId = null;
          this.feed.setSelectedEvent(null);
          this.inspectCurrentAgent(agentId, this.isCoverScreen());
        } else {
          this.inspector.renderEmpty();
        }
      },
    });

    const embedMode = (() => {
      try {
        const v = new URLSearchParams(window.location.search).get("embed");
        return v === "1" || v === "true";
      } catch {
        return false;
      }
    })();

    this.readerModal = new CommReaderModal({
      embedMode,
      getSessionContext: () => {
        let sp: URLSearchParams | null = null;
        try {
          sp = new URLSearchParams(window.location.search);
        } catch {
          sp = null;
        }
        return {
          sessionId: this.snapshot?.sessionId || sp?.get("session") || undefined,
          ide: this.snapshot?.ide || sp?.get("ide") || undefined,
          project: this.snapshot?.projectId || sp?.get("project") || undefined,
          workspace: this.snapshot?.workspacePath || sp?.get("workspace") || undefined,
        };
      },
    });

    this.feed = new ActivityFeed(feedEl, {
      onSelectEvent: (ev) => {
        this.selectedEventId = ev.id;
        this.inspector.renderEvent(ev, {
          openSheet: this.isCoverScreen(),
          labelMap: this.agentLabelMap,
        });
      },
      onSelectAgent: (agentId) => {
        this.selectedAgentId = agentId;
        this.selectedEventId = null;
        this.topology.setSelectedAgent(agentId);
        this.feed.setAgentFilter(agentId);
        this.feed.setSelectedEvent(null);
        this.inspectCurrentAgent(agentId, this.isCoverScreen());
      },
      onOpenReader: (ev) => {
        this.selectedEventId = ev.id;
        this.feed.setSelectedEvent(ev.id);
        this.readerModal.open(ev, { labelMap: this.agentLabelMap });
      },
    });

    this.inspector = new PayloadInspector(inspEl, {
      onClose: () => {
        this.selectedEventId = null;
        this.feed.setSelectedEvent(null);
        if (this.selectedAgentId) {
          this.selectedAgentId = null;
          this.topology.setSelectedAgent(null);
          this.feed.setAgentFilter(null);
        }
      },
      onOpenReader: (ev) => {
        this.readerModal.open(ev, { labelMap: this.agentLabelMap });
      },
    });

    this.scrubber = new TimelineScrubber(tlEl, {
      onCursorChange: () => {
        this.renderFromCursor(true);
      },
    });
  }

  public dispose(): void {
    this.readerModal.dispose();
    this.topology.dispose();
    this.inspector.dispose();
    this.scrubber.dispose();
  }

  private isCoverScreen(): boolean {
    return window.matchMedia("(max-width: 639px)").matches;
  }

  public setCoverSubPane(pane: "topology" | "feed"): void {
    this.coverSubPane = pane;
    const ws = this.root.querySelector("[data-studio-workspace]");
    ws?.setAttribute("data-cover-pane", pane);
  }

  public getCoverSubPane(): "topology" | "feed" {
    return this.coverSubPane;
  }

  public setSnapshot(next: SessionSnapshot): void {
    const prevSessionId = this.snapshot?.sessionId;
    const prevLastId = this.snapshot?.events[this.snapshot.events.length - 1]?.id;
    this.snapshot = next;

    if (prevSessionId && prevSessionId !== next.sessionId) {
      this.selectedAgentId = null;
      this.selectedEventId = null;
      this.lastAnimatedEventId = null;
      this.topology.setSelectedAgent(null);
      this.feed.setAgentFilter(null);
      this.feed.setSelectedEvent(null);
      this.inspector.renderEmpty();
      this.scrubber.snapLive();
    }

    this.scrubber.updateEvents(next.events);
    this.renderFromCursor(false);

    // Animate newly arrived live event packet
    const { liveTail } = this.scrubber.getState();
    const newest = next.events[next.events.length - 1];
    if (liveTail && newest && newest.id !== prevLastId && newest.id !== this.lastAnimatedEventId) {
      this.lastAnimatedEventId = newest.id;
      this.topology.animatePacket(newest);
    }
  }

  private renderFromCursor(animateHead: boolean): void {
    const snap = this.snapshot;
    if (!snap) {
      this.topology.render([], []);
      this.feed.update([], []);
      return;
    }

    const events = snap.events;
    const { cursor, liveTail } = this.scrubber.getState();
    const isHistory = events.length > 0 && (!liveTail || cursor < events.length - 1);

    if (!isHistory && snap.agents.length > 0) {
      // Live tail: merge server live states with reconstructed recent actions / externals
      const reconstructed = buildSnapshot(events, events.length - 1, snap);
      const serverById = new Map(snap.agents.map((a) => [a.id, a]));
      const mergedAgents = reconstructed.agents.map((ra) => {
        const sa = serverById.get(ra.id);
        return sa
          ? {
              ...ra,
              ...sa,
              recentActions: ra.recentActions,
              thinkingEpoch: ra.thinkingEpoch,
            }
          : ra;
      });
      this.agentLabelMap = this.buildLabelMap(mergedAgents, snap.agents);
      const edges = snap.edges.length > 0 ? snap.edges : reconstructed.edges;
      this.topology.render(mergedAgents, edges, snap.counters);
      this.feed.update(
        events,
        snap.pendingPrompts ?? [],
        this.agentLabelMap,
        mergedAgents,
        snap.usage ?? reconstructed.usage
      );
    } else {
      const idx = events.length > 0 ? Math.max(0, Math.min(cursor, events.length - 1)) : -1;
      const reconstructed = buildSnapshot(events, idx, snap);
      this.agentLabelMap = this.buildLabelMap(reconstructed.agents, snap.agents);
      this.topology.render(reconstructed.agents, reconstructed.edges, reconstructed.counters);
      const slicedEvents: NormalizedEvent[] = idx >= 0 ? events.slice(0, idx + 1) : [];
      this.feed.update(
        slicedEvents,
        [],
        this.agentLabelMap,
        reconstructed.agents,
        reconstructed.usage
      );
      if (animateHead && reconstructed.activeEvent) {
        this.topology.animatePacket(reconstructed.activeEvent);
      }
    }

    if (this.selectedAgentId) {
      this.inspectCurrentAgent(this.selectedAgentId, false);
    } else if (this.selectedEventId) {
      const selEv = snap.events.find((e) => e.id === this.selectedEventId);
      if (selEv) {
        this.inspector.renderEvent(selEv, {
          openSheet: false,
          labelMap: this.agentLabelMap,
        });
      }
    }
  }

  private buildLabelMap(
    primary: AgentNodeSnapshot[],
    fallback: AgentNodeSnapshot[]
  ): Map<string, string> {
    const map = new Map<string, string>();
    for (const a of fallback) {
      if (a.id && a.label) map.set(a.id, a.label);
    }
    for (const a of primary) {
      if (a.id && a.label) map.set(a.id, a.label);
    }
    return map;
  }

  private inspectCurrentAgent(agentId: string, openSheet = false): void {
    const snap = this.snapshot;
    if (!snap) return;
    const { cursor, liveTail } = this.scrubber.getState();
    const isHistory = snap.events.length > 0 && (!liveTail || cursor < snap.events.length - 1);
    const reconstructed = buildSnapshot(snap.events, cursor, snap);
    const recAgent = reconstructed.agents.find((a) => a.id === agentId);
    const srvAgent = snap.agents.find((a) => a.id === agentId);
    const found =
      !isHistory && srvAgent && recAgent
        ? {
            ...recAgent,
            ...srvAgent,
            recentActions: recAgent.recentActions,
            thinkingEpoch: recAgent.thinkingEpoch,
          }
        : recAgent ?? srvAgent;
    if (found) {
      const definition = this.findMatchingDefinition(found, snap.definitions);
      this.inspector.renderAgent(found, {
        openSheet,
        definition,
        labelMap: this.agentLabelMap,
      });
    }
  }

  private findMatchingDefinition(
    agent: AgentNodeSnapshot,
    defs?: TeamDefinitionEntry[]
  ): TeamDefinitionEntry | undefined {
    if (!defs || defs.length === 0) return undefined;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const stripPrefix = (s: string) => s.replace(/^[a-z]{2,4}-/, "");

    const targets = [
      norm(agent.id),
      stripPrefix(norm(agent.id)),
      norm(agent.label),
      stripPrefix(norm(agent.label)),
    ].filter(Boolean);

    if (agent.id === "root") targets.push("orchestrator");

    // Prefer definition matching the agent's IDE, then canonical, then any match
    const scored = defs
      .map((d) => {
        const dId = norm(d.id);
        const dStripped = stripPrefix(dId);
        const dName = norm(d.name);
        const exact = targets.some((t) => t === dId || t === dStripped || t === dName);
        if (!exact) return null;
        const ideBonus = d.source_ide === agent.ide ? 3 : d.source_ide === "canonical" ? 2 : 1;
        return { d, score: ideBonus };
      })
      .filter((x): x is { d: TeamDefinitionEntry; score: number } => x !== null)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.d;
  }
}
