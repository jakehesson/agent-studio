import { ActivityFeed } from "../components/ActivityFeed.js";
import { BehindResponseDrawer } from "../components/BehindResponseDrawer.js";
import { CommReaderModal } from "../components/CommReaderModal.js";
import { PayloadInspector } from "../components/PayloadInspector.js";
import { TimelineScrubber } from "../components/TimelineScrubber.js";
import { TopologySvg } from "../components/TopologySvg.js";
import { buildSnapshot } from "../state/snapshot.js";
import { buildTopologyModel } from "../state/topologyGrouping.js";
import {
  attachStudioWorkspaceResizers,
  type PanelResizerHandle,
} from "../utils/panelResizer.js";
import type {
  AgentNodeSnapshot,
  NormalizedEvent,
  ReplyCapabilities,
  ReplyToHostRequest,
  ReplyToHostResult,
  SessionSnapshot,
  TeamDefinitionEntry,
  TeamRosterRef,
} from "../types.js";

export interface LiveStudioCallbacks {
  onCoverSubPaneChange?: (pane: "topology" | "feed") => void;
  getReplyCapabilities?: () => ReplyCapabilities;
  onReplyToHost?: (req: ReplyToHostRequest) => Promise<ReplyToHostResult>;
  onCancelPrompt?: (promptId: string, reason?: string) => Promise<ReplyToHostResult>;
}

export class LiveStudioView {
  private root: HTMLElement;
  private cb: LiveStudioCallbacks;
  private topology: TopologySvg;
  private feed: ActivityFeed;
  private inspector: PayloadInspector;
  private scrubber: TimelineScrubber;
  private readerModal: CommReaderModal;
  private behindDrawer: BehindResponseDrawer;
  private studioResizers: PanelResizerHandle;
  private workspaceEl: HTMLElement;
  private inspectorSlotEl: HTMLElement;

  private snapshot: SessionSnapshot | null = null;
  private fallbackTeamRoster: TeamRosterRef[] | undefined = undefined;
  private fallbackDefinitions: TeamDefinitionEntry[] | undefined = undefined;
  private agentLabelMap: Map<string, string> = new Map();
  private selectedAgentId: string | null = null;
  private selectedEventId: string | null = null;
  private lastAnimatedEventId: string | null = null;
  private coverSubPane: "topology" | "feed" = "topology";

  constructor(root: HTMLElement, cb: LiveStudioCallbacks = {}) {
    this.root = root;
    this.cb = cb;
    this.root.innerHTML = `
      <div class="studio-workspace" data-studio-workspace data-cover-pane="topology">
        <section class="card pane-topology" data-pane-topology aria-label="Topology mesh"></section>
        <div class="panel-resizer" data-resizer="studio-main"><span class="panel-resizer-pill" aria-hidden="true"></span></div>
        <section class="card pane-stream" data-pane-stream aria-label="Activity stream and payload inspector">
          <div class="stream-feed-slot" data-feed-slot></div>
          <div class="stream-inspector-slot" data-inspector-slot></div>
        </section>
        <div class="panel-resizer" data-resizer="studio-behind" hidden><span class="panel-resizer-pill" aria-hidden="true"></span></div>
        <div class="behind-drawer-backdrop" data-behind-backdrop hidden></div>
        <aside class="inspector-pane" data-behind-drawer hidden></aside>
      </div>
      <div class="timeline-bar" data-timeline-bar role="region" aria-label="Session timeline scrubber"></div>
    `;

    this.workspaceEl = this.root.querySelector("[data-studio-workspace]") as HTMLElement;
    const topoEl = this.root.querySelector("[data-pane-topology]") as HTMLElement;
    const streamEl = this.root.querySelector("[data-pane-stream]") as HTMLElement;
    const mainResizerEl = this.root.querySelector('[data-resizer="studio-main"]') as HTMLElement;
    const behindResizerEl = this.root.querySelector('[data-resizer="studio-behind"]') as HTMLElement;
    const feedEl = this.root.querySelector("[data-feed-slot]") as HTMLElement;
    const inspEl = this.root.querySelector("[data-inspector-slot]") as HTMLElement;
    this.inspectorSlotEl = inspEl;
    const behindDrawerEl = this.root.querySelector("[data-behind-drawer]") as HTMLElement;
    const behindBackdropEl = this.root.querySelector("[data-behind-backdrop]") as HTMLElement;
    const tlEl = this.root.querySelector("[data-timeline-bar]") as HTMLElement;

    this.topology = new TopologySvg(topoEl, {
      onSelectAgent: (agentId) => {
        if (this.behindDrawer.isOpen()) {
          this.behindDrawer.close(false);
        }
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
      onSelectThread: (selection, opts) => {
        const opened = this.feed.openThread(selection, opts);
        if (opened && this.isCoverScreen()) {
          this.setCoverSubPane("feed");
          this.cb.onCoverSubPaneChange?.("feed");
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

    const getSessionContext = () => {
      let sp: URLSearchParams | null = null;
      try {
        sp = new URLSearchParams(window.location.search);
      } catch {
        sp = null;
      }
      const snapIde =
        this.snapshot?.ide && this.snapshot.ide !== "unknown"
          ? this.snapshot.ide
          : undefined;
      return {
        sessionId: this.snapshot?.sessionId || sp?.get("session") || undefined,
        ide: snapIde || sp?.get("ide") || undefined,
        project: this.snapshot?.projectId || sp?.get("project") || undefined,
        workspace: this.snapshot?.workspacePath || sp?.get("workspace") || undefined,
      };
    };

    this.readerModal = new CommReaderModal({
      embedMode,
      getSessionContext,
    });

    const getReplyCapabilities =
      this.cb.getReplyCapabilities ??
      (() => ({
        canSendMessage: false,
        isMcpApp: false,
        isEmbed: embedMode,
      }));
    const onReplyToHost =
      this.cb.onReplyToHost ??
      (async (req: ReplyToHostRequest): Promise<ReplyToHostResult> => ({
        ok: false,
        mode: "error",
        message: `Reply handler unavailable for ${req.agentId}`,
      }));

    this.behindDrawer = new BehindResponseDrawer({
      drawerEl: behindDrawerEl,
      backdropEl: behindBackdropEl,
      embedMode,
      mcpAppMode: getReplyCapabilities().isMcpApp,
      getSessionContext,
      onStepChange: (entry) => {
        this.feed.setInspectedEventId(entry.event.id);
      },
      onClose: () => {
        this.workspaceEl.classList.remove("has-behind-drawer");
        this.syncInspectorVisibility();
        this.feed.setInspectedEventId(null);
        this.studioResizers.sync();
      },
    });

    this.feed = new ActivityFeed(feedEl, {
      embedMode,
      mcpAppMode: getReplyCapabilities().isMcpApp,
      getSessionContext,
      onSelectEvent: (ev) => {
        if (this.behindDrawer.isOpen()) {
          this.behindDrawer.close(false);
        }
        this.selectedEventId = ev.id;
        if (this.feed.getFilter() === "messages") {
          this.inspector.closeModal();
          return;
        }
        this.inspector.renderEvent(ev, {
          openSheet: this.isCoverScreen(),
          labelMap: this.agentLabelMap,
        });
      },
      onSelectAgent: (agentId) => {
        if (this.behindDrawer.isOpen()) {
          this.behindDrawer.close(false);
        }
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
      onOpenBehind: (entry, allWithBehind, triggerEl) => {
        if (
          this.behindDrawer.isOpen() &&
          this.behindDrawer.getCurrentEventId() === entry.event.id
        ) {
          this.behindDrawer.close(true);
          return;
        }
        this.selectedEventId = null;
        this.feed.setSelectedEvent(null);
        if (this.selectedAgentId) {
          this.selectedAgentId = null;
          this.topology.setSelectedAgent(null);
          this.feed.setAgentFilter(null);
        }
        this.inspector.renderEmpty();
        this.workspaceEl.classList.add("has-behind-drawer");
        this.feed.setInspectedEventId(entry.event.id);
        this.behindDrawer.open(entry, allWithBehind, triggerEl);
        this.syncInspectorVisibility();
        this.studioResizers.sync();
      },
      onThreadChange: (threadKey) => {
        this.topology.setActiveThreadKey(threadKey);
        if (threadKey === null && this.behindDrawer.isOpen()) {
          this.behindDrawer.close(false);
        }
      },
      onFilterChange: (filter) => {
        if (filter === "messages") {
          this.inspector.closeModal();
        } else {
          if (this.selectedAgentId) {
            this.inspectCurrentAgent(this.selectedAgentId, false);
          } else if (this.selectedEventId && this.snapshot) {
            const selEv = this.snapshot.events.find((e) => e.id === this.selectedEventId);
            if (selEv) {
              this.inspector.renderEvent(selEv, {
                openSheet: false,
                labelMap: this.agentLabelMap,
              });
            }
          }
        }
        this.syncInspectorVisibility();
      },
      onCoverBackToTopology: () => {
        this.setCoverSubPane("topology");
        this.cb.onCoverSubPaneChange?.("topology");
      },
      getReplyCapabilities,
      onReplyToHost,
      onCancelPrompt: this.cb.onCancelPrompt,
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
      onOpenWaiting: (agentId) => {
        this.openWaitingMessages(agentId);
      },
    });

    this.scrubber = new TimelineScrubber(tlEl, {
      onCursorChange: () => {
        this.renderFromCursor(true);
      },
    });

    this.studioResizers = attachStudioWorkspaceResizers({
      workspace: this.workspaceEl,
      mainHandle: mainResizerEl,
      behindHandle: behindResizerEl,
      topologyPane: topoEl,
      streamPane: streamEl,
      behindPane: behindDrawerEl,
    });

    this.syncInspectorVisibility();
  }

  public syncInspectorVisibility(): void {
    const hide = this.feed.getFilter() === "messages" || this.behindDrawer.isOpen();
    this.inspectorSlotEl.hidden = hide;
  }

  public dispose(): void {
    this.studioResizers.destroy();
    this.behindDrawer.dispose();
    this.feed.dispose();
    this.readerModal.dispose();
    this.topology.dispose();
    this.inspector.dispose();
    this.scrubber.dispose();
  }

  public setRuntimeScope(scope: { embedMode?: boolean; mcpAppMode?: boolean }): void {
    this.behindDrawer.setRuntimeScope(scope);
    this.feed.setRuntimeScope(scope);
  }

  public openWaitingMessages(agentId?: string): boolean {
    if (this.behindDrawer.isOpen()) {
      this.behindDrawer.close(false);
    }
    const snap = this.snapshot;
    const targetAgentId =
      agentId ||
      snap?.pendingPrompts?.[0]?.agentId ||
      snap?.agents.find((a) => Boolean(a.pendingPrompt))?.id;
    this.feed.openMessagesForAgent(targetAgentId);
    if (this.isCoverScreen()) {
      this.setCoverSubPane("feed");
      this.cb.onCoverSubPaneChange?.("feed");
    }
    this.syncInspectorVisibility();
    return true;
  }

  private isCoverScreen(): boolean {
    return window.matchMedia("(max-width: 639px)").matches;
  }

  public setCoverSubPane(pane: "topology" | "feed"): void {
    this.coverSubPane = pane;
    const ws = this.root.querySelector("[data-studio-workspace]");
    ws?.setAttribute("data-cover-pane", pane);
    if (pane === "topology") {
      if (
        this.behindDrawer.isOpen() &&
        window.matchMedia("(max-width: 1020px) and (min-width: 640px)").matches
      ) {
        this.behindDrawer.close(false);
      }
      window.requestAnimationFrame(() => this.topology.refreshLayout());
    }
  }

  public getCoverSubPane(): "topology" | "feed" {
    return this.coverSubPane;
  }

  public setFallbackTeamRoster(
    roster?: TeamRosterRef[],
    definitions?: TeamDefinitionEntry[]
  ): void {
    this.fallbackTeamRoster = roster && roster.length > 0 ? roster : undefined;
    this.fallbackDefinitions =
      definitions && definitions.length > 0 ? definitions : undefined;
    if (
      this.snapshot &&
      (!this.snapshot.teamRoster || this.snapshot.teamRoster.length === 0)
    ) {
      this.renderFromCursor(false);
    }
  }

  public setSnapshot(next: SessionSnapshot): void {
    const prevSessionId = this.snapshot?.sessionId;
    const prevLastId = this.snapshot?.events[this.snapshot.events.length - 1]?.id;
    this.snapshot = next;

    if (prevSessionId && prevSessionId !== next.sessionId) {
      this.selectedAgentId = null;
      this.selectedEventId = null;
      this.lastAnimatedEventId = null;
      this.behindDrawer.resetSession();
      this.topology.resetSessionState();
      this.feed.setAgentFilter(null);
      this.feed.setSelectedEvent(null);
      this.feed.resetScroll();
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
    const effectiveTeamRoster =
      snap.teamRoster && snap.teamRoster.length > 0
        ? snap.teamRoster
        : this.fallbackTeamRoster;
    const effectiveDefinitions =
      snap.definitions && snap.definitions.length > 0
        ? snap.definitions
        : this.fallbackDefinitions;

    if (!isHistory && snap.agents.length > 0) {
      // Live tail: treat server roster (snap.agents) as authoritative; hydrate recentActions/thinkingEpoch from replay
      const reconstructed = buildSnapshot(events, events.length - 1, snap);
      const serverById = new Map(snap.agents.map((a) => [a.id, a]));
      const recById = new Map(reconstructed.agents.map((ra) => [ra.id, ra]));
      const mergedAgents = snap.agents.map((sa) => {
        const ra = recById.get(sa.id);
        return ra
          ? {
              ...ra,
              ...sa,
              recentActions: ra.recentActions?.length ? ra.recentActions : sa.recentActions,
              thinkingEpoch: ra.thinkingEpoch,
            }
          : sa;
      });
      this.agentLabelMap = this.buildLabelMap(mergedAgents, snap.agents);
      const edges =
        snap.edges.length > 0
          ? snap.edges
          : reconstructed.edges.filter(
              (e) => serverById.has(e.from) && serverById.has(e.to)
            );
      const topoMeta = {
        events,
        definitions: effectiveDefinitions,
        teamRoster: effectiveTeamRoster,
        labelMap: this.agentLabelMap,
      };
      const model = buildTopologyModel({
        agents: mergedAgents,
        edges,
        ...topoMeta,
      });
      this.topology.render(mergedAgents, edges, snap.counters, topoMeta);
      this.feed.update(
        events,
        snap.pendingPrompts ?? [],
        this.agentLabelMap,
        mergedAgents,
        snap.usage ?? reconstructed.usage,
        model.clusters,
        snap.sessionId
      );
    } else {
      const idx = events.length > 0 ? Math.max(0, Math.min(cursor, events.length - 1)) : -1;
      const reconstructed = buildSnapshot(events, idx, snap);
      this.agentLabelMap = this.buildLabelMap(reconstructed.agents, snap.agents);
      const slicedEvents: NormalizedEvent[] = idx >= 0 ? events.slice(0, idx + 1) : [];
      const topoMeta = {
        events: slicedEvents,
        definitions: effectiveDefinitions,
        teamRoster: effectiveTeamRoster,
        labelMap: this.agentLabelMap,
      };
      const model = buildTopologyModel({
        agents: reconstructed.agents,
        edges: reconstructed.edges,
        ...topoMeta,
      });
      this.topology.render(
        reconstructed.agents,
        reconstructed.edges,
        reconstructed.counters,
        topoMeta
      );
      this.feed.update(
        slicedEvents,
        // Live with an empty roster must still surface pending prompts (history scrubbing stays empty).
        isHistory ? [] : snap.pendingPrompts ?? [],
        this.agentLabelMap,
        reconstructed.agents,
        reconstructed.usage,
        model.clusters,
        snap.sessionId
      );
      if (animateHead && reconstructed.activeEvent) {
        this.topology.animatePacket(reconstructed.activeEvent);
      }
    }

    if (this.behindDrawer.isOpen()) {
      this.behindDrawer.refreshEntries(this.feed.getBehindInspectableMessages());
    }

    if (this.feed.getFilter() === "messages") {
      this.inspector.closeModal();
    } else if (this.selectedAgentId) {
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

  private resolveLiveAgent(agentId: string): AgentNodeSnapshot | undefined {
    const snap = this.snapshot;
    if (!snap) return undefined;
    const { cursor, liveTail } = this.scrubber.getState();
    const isHistory = snap.events.length > 0 && (!liveTail || cursor < snap.events.length - 1);
    const reconstructed = buildSnapshot(snap.events, cursor, snap);
    const recAgent = reconstructed.agents.find((a) => a.id === agentId);
    const srvAgent = snap.agents.find((a) => a.id === agentId);
    return !isHistory && snap.agents.length > 0
      ? srvAgent && recAgent
        ? {
            ...recAgent,
            ...srvAgent,
            recentActions: recAgent.recentActions?.length
              ? recAgent.recentActions
              : srvAgent.recentActions,
            thinkingEpoch: recAgent.thinkingEpoch,
          }
        : srvAgent
      : recAgent ?? srvAgent;
  }

  private inspectCurrentAgent(agentId: string, openSheet = false): void {
    if (this.feed.getFilter() === "messages") {
      this.inspector.closeModal();
      return;
    }
    const snap = this.snapshot;
    if (!snap) return;
    const found = this.resolveLiveAgent(agentId);
    if (found) {
      const effectiveDefinitions =
        snap.definitions && snap.definitions.length > 0
          ? snap.definitions
          : this.fallbackDefinitions;
      const definition = this.findMatchingDefinition(found, effectiveDefinitions);
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
