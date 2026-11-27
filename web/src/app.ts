import {
  answerPendingPrompt,
  cancelPendingPrompt,
  fetchBoard,
  fetchSessions,
  fetchState,
  fetchTeam,
  StudioStreamClient,
} from "./api.js";
import {
  AgentChatPane,
  buildOpenChatTabPayload,
  parseChatViewRouteParams,
  shouldAcceptChatSnapshot,
  shouldRouteChatToHostTab,
} from "./components/AgentChatPane.js";
import { ContextBar } from "./components/ContextBar.js";
import { FeedbackDialog } from "./components/FeedbackDialog.js";
import { normalizeServerSnapshot } from "./state/snapshot.js";
import type {
  AgentNodeSnapshot,
  ConnectionState,
  CoverPane,
  DiscoveredSessionSummary,
  EmbedScope,
  FeedbackDiagnostics,
  HostIde,
  IdeFilter,
  IdeSource,
  PrimaryView,
  RegisteredProject,
  ReplyCapabilities,
  ReplyToHostRequest,
  ReplyToHostResult,
  SessionSnapshot,
  TeamDefinitionEntry,
  TeamRosterEntry,
  TeamRosterRef,
} from "./types.js";
import { copyTextSafe, formatActorName } from "./utils.js";
import { AgileBoardView } from "./views/AgileBoard.js";
import { DoctorView } from "./views/Doctor.js";
import { LiveStudioView } from "./views/LiveStudio.js";
import { MockupsView } from "./views/Mockups.js";
import { TeamView } from "./views/Team.js";

const COVER_TABS: Array<{ id: CoverPane; label: string; icon: string }> = [
  { id: "studio", label: "Studio", icon: "◈" },
  { id: "feed", label: "Feed", icon: "☰" },
  { id: "team", label: "Team", icon: "◎" },
  { id: "board", label: "Board", icon: "▦" },
  { id: "mockups", label: "Mockups", icon: "◫" },
  { id: "doctor", label: "Doctor", icon: "✚" },
];

export interface AgentStudioBootOptions {
  mcpAppMode?: boolean;
  lockedIde?: HostIde | null;
  hideMockups?: boolean;
  initialProject?: string;
  initialWorkspace?: string;
  initialSession?: string;
  initialView?: PrimaryView;
  getReplyCapabilities?: () => ReplyCapabilities;
  onReplyToHost?: (req: ReplyToHostRequest) => Promise<ReplyToHostResult>;
}

export interface StudioExternalDirective {
  view?: string;
  project?: string;
  workspace?: string;
  session?: string;
  snapshot?: unknown;
}

export class AgentStudioApp {
  private projects: RegisteredProject[] = [];
  private selectedProject = "";
  private ideFilter: IdeFilter = "all";
  private sessions: DiscoveredSessionSummary[] = [];
  private selectedSessionId = "";
  private multiOnly = false;
  private embedMode = false;
  private mcpAppMode = false;
  private hideMockups = false;
  private lockedIde: HostIde | null = null;
  private lockedWorkspace = "";
  private connection: ConnectionState = "connecting";
  private activeView: PrimaryView = "studio";
  private coverPane: CoverPane = "studio";

  private contextBar: ContextBar;
  private feedbackDialog: FeedbackDialog;
  private lastSnapshot: SessionSnapshot | null = null;
  private cachedTeamFallback = new Map<
    string,
    { roster: TeamRosterRef[]; definitions: TeamDefinitionEntry[] }
  >();
  private inflightTeamFallback = new Map<string, Promise<void>>();
  private studioView: LiveStudioView;
  private teamView: TeamView;
  private boardView: AgileBoardView;
  private mockupsView: MockupsView;
  private doctorView: DoctorView;
  private chatPane: AgentChatPane;
  private stream: StudioStreamClient;

  private panels: Record<PrimaryView, HTMLElement>;
  private bottomNav: HTMLElement;
  private shellEl: HTMLElement;
  private pendingOpenChatAgentId: string | null = null;
  private pendingOpenWaiting = false;
  private pinnedChatSessionId = "";
  private pinnedChatAgentId = "";
  private pinnedChatAgentLabel = "";
  private pinnedChatFocusQuestion = false;
  private chatStreamStarted = false;
  private pendingReplyResolvers = new Map<
    string,
    (res: { ok?: boolean; mode?: string; message?: string } | null) => void
  >();
  private mcpReplyCapabilitiesGetter?: () => ReplyCapabilities;
  private mcpReplyHandler?: (req: ReplyToHostRequest) => Promise<ReplyToHostResult>;

  constructor(mountEl: HTMLElement, opts: AgentStudioBootOptions = {}) {
    this.mcpAppMode = Boolean(opts.mcpAppMode);
    this.hideMockups = Boolean(opts.hideMockups || opts.mcpAppMode);
    this.mcpReplyCapabilitiesGetter = opts.getReplyCapabilities;
    this.mcpReplyHandler = opts.onReplyToHost;
    if (opts.lockedIde) {
      this.lockedIde = opts.lockedIde;
      this.ideFilter = opts.lockedIde;
    }
    if (opts.initialProject?.trim()) this.selectedProject = opts.initialProject.trim();
    if (opts.initialWorkspace?.trim()) this.lockedWorkspace = opts.initialWorkspace.trim();
    if (opts.initialSession?.trim()) this.selectedSessionId = opts.initialSession.trim();
    if (this.mcpAppMode && (this.selectedProject || this.lockedWorkspace)) {
      this.embedMode = true;
    }

    mountEl.innerHTML = `
      <div class="app-shell" data-app-shell data-active-view="studio">
        <header class="context-bar" data-context-bar></header>

        <main class="view-host">
          <div class="view-panel" data-panel="studio" role="tabpanel" aria-label="Live Studio"></div>
          <div class="view-panel" data-panel="team" role="tabpanel" aria-label="Agent Team" hidden></div>
          <div class="view-panel" data-panel="board" role="tabpanel" aria-label="Agile Board" hidden></div>
          <div class="view-panel" data-panel="mockups" role="tabpanel" aria-label="Mockups" hidden></div>
          <div class="view-panel" data-panel="doctor" role="tabpanel" aria-label="Doctor" hidden></div>
          <section class="view-panel" data-panel="chat" aria-label="Agent Chat" hidden></section>
        </main>

        <nav class="cover-bottom-nav" data-cover-nav aria-label="Mobile navigation">
          ${COVER_TABS.map(
            (t) => `
              <button
                type="button"
                class="cover-nav-btn ${t.id === "studio" ? "active" : ""}"
                data-cover-target="${t.id}"
                aria-current="${t.id === "studio" ? "page" : "false"}"
              >
                <span class="cover-nav-ico" aria-hidden="true">${t.icon}</span>
                <span>${t.label}</span>
              </button>
            `
          ).join("")}
        </nav>
      </div>
    `;

    this.shellEl = mountEl.querySelector("[data-app-shell]") as HTMLElement;
    const ctxEl = mountEl.querySelector("[data-context-bar]") as HTMLElement;
    this.bottomNav = mountEl.querySelector("[data-cover-nav]") as HTMLElement;
    this.panels = {
      studio: mountEl.querySelector('[data-panel="studio"]') as HTMLElement,
      team: mountEl.querySelector('[data-panel="team"]') as HTMLElement,
      board: mountEl.querySelector('[data-panel="board"]') as HTMLElement,
      mockups: mountEl.querySelector('[data-panel="mockups"]') as HTMLElement,
      doctor: mountEl.querySelector('[data-panel="doctor"]') as HTMLElement,
      chat: mountEl.querySelector('[data-panel="chat"]') as HTMLElement,
    };

    this.contextBar = new ContextBar(ctxEl, this.getContextState(), {
      onSelectProject: (projectId) => {
        if (this.embedMode) return;
        this.selectedProject = projectId;
        this.selectedSessionId = "";
        this.syncUrlState();
        this.refreshContextBar();
        void this.refreshSessionsAndState();
        this.refreshActiveSecondaryView();
      },
      onSelectIde: (ide) => {
        if (this.lockedIde) return;
        this.ideFilter = ide;
        this.selectedSessionId = "";
        this.syncUrlState();
        this.refreshContextBar();
        void this.refreshSessionsAndState();
      },
      onSelectSession: (sessionId) => {
        this.selectedSessionId = sessionId;
        this.syncUrlState();
        this.refreshContextBar();
        this.stream.updateParams({
          session: this.selectedSessionId,
          ide: this.ideFilter,
          project: this.selectedProject,
          workspace: this.lockedWorkspace || undefined,
        });
        void this.loadCurrentSnapshot();
      },
      onToggleMultiOnly: () => {
        this.multiOnly = !this.multiOnly;
        this.refreshContextBar();
        void this.refreshSessions();
      },
      onResetFilters: () => {
        if (this.embedMode || this.lockedIde) {
          if (!this.embedMode) this.selectedProject = "";
          this.multiOnly = false;
          this.syncUrlState();
          this.refreshContextBar();
          void this.refreshSessionsAndState();
          return;
        }
        this.selectedProject = "";
        this.ideFilter = "all";
        this.multiOnly = false;
        this.selectedSessionId = "";
        this.syncUrlState();
        this.refreshContextBar();
        void this.refreshSessionsAndState();
        this.refreshActiveSecondaryView();
      },
      onSelectView: (view) => this.setView(view),
      onReconnect: () => this.stream.reconnectNow(),
      onOpenFeedback: () => this.openFeedbackDialog(),
      onOpenWaitingAgent: (agentId) => {
        if (this.activeView !== "studio") {
          this.setView("studio");
        }
        this.studioView.openChat(agentId, true);
      },
    });

    this.feedbackDialog = new FeedbackDialog({
      embedMode: this.embedMode,
      mcpAppMode: this.mcpAppMode,
    });

    this.studioView = new LiveStudioView(this.panels.studio, {
      onCoverSubPaneChange: (pane) => {
        const coverTarget: CoverPane = pane === "feed" ? "feed" : "studio";
        this.coverPane = coverTarget;
        this.bottomNav
          .querySelectorAll<HTMLButtonElement>("[data-cover-target]")
          .forEach((btn) => {
            const active = btn.dataset.coverTarget === coverTarget;
            btn.classList.toggle("active", active);
            btn.setAttribute("aria-current", active ? "page" : "false");
          });
      },
      getReplyCapabilities: () => this.getReplyCapabilities(),
      onReplyToHost: (req) => this.sendReplyToHost(req),
      onCancelPrompt: (promptId, reason) =>
        this.cancelPendingPromptFromUi(promptId, reason),
      onOpenChat: (agentId, focusQuestion, meta) => {
        this.openHostChatTab(agentId, focusQuestion, meta);
      },
    });
    this.teamView = new TeamView(this.panels.team);

    this.boardView = new AgileBoardView(this.panels.board, {
      onJumpToLiveStudio: (projectId) => {
        if (!this.embedMode && projectId && projectId !== this.selectedProject) {
          this.selectedProject = projectId;
          this.selectedSessionId = "";
          void this.refreshSessionsAndState();
        }
        this.setView("studio");
      },
      onProjectsDiscovered: (projs) => this.mergeProjects(projs),
    });

    this.mockupsView = new MockupsView(this.panels.mockups);
    this.doctorView = new DoctorView(this.panels.doctor, {
      onOpenTeam: () => this.setView("team"),
    });

    this.chatPane = new AgentChatPane(this.panels.chat, {
      mode: "panel",
      headingId: "chatPanelTitle",
      embedMode: this.embedMode,
      mcpAppMode: this.mcpAppMode,
      getSessionContext: () => ({
        sessionId: this.pinnedChatSessionId || this.selectedSessionId || undefined,
        ide: this.resolveChatIde(this.pinnedChatAgentId),
        project: this.selectedProject || undefined,
        workspace: this.lockedWorkspace || undefined,
      }),
      getReplyCapabilities: () => this.getReplyCapabilities(),
      onReplyToHost: (req) => this.sendReplyToHost(req),
      onCancelPrompt: (promptId, reason) =>
        this.cancelPendingPromptFromUi(promptId, reason),
      onReconnect: () => this.stream.reconnectNow(),
      onSwitchAgent: (subId, subLabel) => {
        const sessionId = this.pinnedChatSessionId || this.selectedSessionId || "";
        if (
          shouldRouteChatToHostTab({
            embedMode: this.embedMode,
            mcpAppMode: this.mcpAppMode,
            hasParent: typeof window !== "undefined" && window.parent !== window,
          })
        ) {
          window.parent.postMessage(
            buildOpenChatTabPayload({
              sessionId,
              agentId: subId,
              agentLabel: subLabel || this.resolveAgentLabel(subId),
              ide: this.resolveChatIde(subId),
              focusQuestion: false,
            }),
            "*"
          );
          return;
        }
        this.pinnedChatAgentId = subId;
        this.pinnedChatAgentLabel = subLabel ?? "";
        this.pinnedChatFocusQuestion = false;
        this.openChatPanelAgent(sessionId, subId, subLabel, false);
        this.syncUrlState();
      },
    });

    this.stream = new StudioStreamClient({
      onState: (snap) => this.handleIncomingSnapshot(snap),
      onStatus: (status) => {
        this.connection = status;
        this.refreshContextBar();
        this.chatPane.setConnectionState(status);
        this.studioView.setConnectionState(status);
      },
    });

    this.bindCoverNav();
    this.bindHostFocusMessages();
    if (!this.mcpAppMode) {
      this.restoreFromUrl();
    } else {
      this.applyShellAttributes();
      const scope = this.getEmbedScope();
      this.teamView.setEmbedScope(scope);
      this.doctorView.setEmbedScope(scope);
      if (opts.initialView) {
        this.setView(this.normalizeAllowedView(opts.initialView));
      } else {
        this.refreshContextBar();
      }
    }
    if (this.activeView === "chat") {
      if (this.pinnedChatSessionId && this.pinnedChatAgentId) {
        this.openChatPanelAgent(
          this.pinnedChatSessionId,
          this.pinnedChatAgentId,
          this.pinnedChatAgentLabel || undefined,
          this.pinnedChatFocusQuestion
        );
      } else {
        this.chatPane.renderEmptyContext(
          "No agent conversation selected",
          "Click Chat on any agent in Live Studio to inspect its conversation here."
        );
      }
      if (typeof window !== "undefined" && window.parent !== window) {
        window.parent.postMessage({ type: "agentStudio:chatTabReady" }, "*");
      }
    }
    void this.bootstrap();
  }

  public applyExternalDirective(directive: StudioExternalDirective): void {
    let scopeChanged = false;

    if (typeof directive.workspace === "string") {
      const nextWs = directive.workspace.trim();
      if (nextWs !== this.lockedWorkspace) {
        this.lockedWorkspace = nextWs;
        scopeChanged = true;
      }
    }

    if (typeof directive.project === "string") {
      const nextProj = directive.project.trim();
      if (nextProj !== this.selectedProject) {
        this.selectedProject = nextProj;
        scopeChanged = true;
      }
    }

    if (this.mcpAppMode) {
      // Global launch (`{}`): keep Project Switcher visible; workspace/project launch: lock cleanly
      const nextEmbed = Boolean(this.selectedProject || this.lockedWorkspace);
      if (nextEmbed !== this.embedMode) {
        this.embedMode = nextEmbed;
        scopeChanged = true;
      }
    }

    if (typeof directive.session === "string" && directive.session.trim()) {
      const nextSession = directive.session.trim();
      if (nextSession !== this.selectedSessionId) {
        this.selectedSessionId = nextSession;
        scopeChanged = true;
      }
    }

    if (scopeChanged) {
      this.applyShellAttributes();
      const scope = this.getEmbedScope();
      this.feedbackDialog.setRuntimeScope({
        embedMode: this.embedMode,
        mcpAppMode: this.mcpAppMode,
      });
      this.teamView.setEmbedScope(scope);
      this.doctorView.setEmbedScope(scope);
      this.chatPane.setRuntimeScope({ embedMode: this.embedMode, mcpAppMode: this.mcpAppMode });
      this.studioView.setChatRuntimeScope({ embedMode: this.embedMode, mcpAppMode: this.mcpAppMode });
      this.refreshContextBar();
      this.stream.updateParams({
        session: this.selectedSessionId,
        ide: this.ideFilter,
        project: this.selectedProject,
        workspace: this.lockedWorkspace || undefined,
      });
    }

    if (directive.snapshot && typeof directive.snapshot === "object") {
      this.handleIncomingSnapshot(normalizeServerSnapshot(directive.snapshot));
    }

    if (typeof directive.view === "string" && directive.view.trim()) {
      const nextView = this.normalizeAllowedView(directive.view.trim());
      if (nextView !== this.activeView) {
        this.setView(nextView);
      } else if (scopeChanged) {
        this.refreshActiveSecondaryView();
      }
    } else if (scopeChanged) {
      this.refreshActiveSecondaryView();
    }

    if (scopeChanged && !directive.snapshot) {
      void this.refreshSessionsAndState();
    }
  }

  public setConnectionNotice(status: ConnectionState): void {
    this.connection = status;
    this.refreshContextBar();
    this.chatPane.setConnectionState(status);
    this.studioView.setConnectionState(status);
  }

  private normalizeAllowedView(raw: string): PrimaryView {
    const low = raw.toLowerCase();
    if (low === "chat") return "chat";
    if (low === "team") return "team";
    if (low === "board") return "board";
    if (low === "doctor") return "doctor";
    if (low === "mockups" && !this.hideMockups) return "mockups";
    return "studio";
  }

  private applyShellAttributes(): void {
    if (this.embedMode) this.shellEl.setAttribute("data-embed", "1");
    else this.shellEl.removeAttribute("data-embed");

    if (this.lockedIde) this.shellEl.setAttribute("data-locked-ide", this.lockedIde);
    else this.shellEl.removeAttribute("data-locked-ide");

    if (this.hideMockups) this.shellEl.setAttribute("data-hide-mockups", "1");
    else this.shellEl.removeAttribute("data-hide-mockups");

    if (this.mcpAppMode) this.shellEl.setAttribute("data-mcp-app", "1");
    else this.shellEl.removeAttribute("data-mcp-app");
  }

  private bindCoverNav(): void {
    this.bottomNav.querySelectorAll<HTMLButtonElement>("[data-cover-target]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.coverTarget as CoverPane | undefined;
        if (!target) return;
        if (target === "mockups" && this.hideMockups) return;
        this.coverPane = target;
        if (target === "studio") {
          this.studioView.setCoverSubPane("topology");
          this.setView("studio", "studio");
        } else if (target === "feed") {
          this.studioView.setCoverSubPane("feed");
          this.setView("studio", "feed");
        } else {
          this.setView(target, target);
        }
      });
    });
  }

  private setView(view: PrimaryView, explicitCover?: CoverPane): void {
    const allowedView = this.normalizeAllowedView(view);
    this.activeView = allowedView;
    this.coverPane =
      explicitCover ??
      (allowedView === "studio"
        ? this.studioView.getCoverSubPane() === "feed"
          ? "feed"
          : "studio"
        : allowedView === "chat"
          ? "studio"
          : allowedView);

    this.shellEl.setAttribute("data-active-view", allowedView);

    (Object.keys(this.panels) as PrimaryView[]).forEach((k) => {
      this.panels[k].hidden = k !== allowedView;
    });

    this.bottomNav.querySelectorAll<HTMLButtonElement>("[data-cover-target]").forEach((btn) => {
      const active = btn.dataset.coverTarget === this.coverPane;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-current", active ? "page" : "false");
    });

    this.syncUrlState();
    this.refreshContextBar();
    this.refreshActiveSecondaryView();
  }

  private refreshActiveSecondaryView(): void {
    const ws = this.lockedWorkspace || undefined;
    if (this.activeView === "team") {
      void this.teamView.load(this.selectedProject, ws);
    } else if (this.activeView === "board") {
      void this.boardView.load(this.selectedProject, ws);
    } else if (this.activeView === "mockups" && !this.hideMockups) {
      void this.mockupsView.load(this.selectedProject, undefined, ws);
    } else if (this.activeView === "doctor") {
      void this.doctorView.load(this.selectedProject, ws);
    }
  }

  private getEmbedScope(): EmbedScope {
    return {
      embedMode: this.embedMode,
      lockedIde: this.lockedIde,
      lockedWorkspace: this.lockedWorkspace,
      mcpAppMode: this.mcpAppMode,
    };
  }

  private getContextState() {
    return {
      projects: this.projects,
      selectedProject: this.selectedProject,
      ideFilter: this.ideFilter,
      sessions: this.sessions,
      selectedSessionId: this.selectedSessionId,
      connection: this.connection,
      activeView: this.activeView,
      multiOnly: this.multiOnly,
      embedMode: this.embedMode,
      mcpAppMode: this.mcpAppMode,
      hideMockups: this.hideMockups,
      lockedIde: this.lockedIde,
      lockedWorkspace: this.lockedWorkspace,
      pendingPrompts: this.lastSnapshot?.pendingPrompts,
    };
  }

  private refreshContextBar(): void {
    this.contextBar.update(this.getContextState());
  }

  private mergeProjects(incoming?: RegisteredProject[]): void {
    if (!incoming || incoming.length === 0) return;
    const map = new Map<string, RegisteredProject>(this.projects.map((p) => [p.id, p]));
    for (const p of incoming) {
      if (p?.id) map.set(p.id, { ...map.get(p.id), ...p });
    }
    this.projects = Array.from(map.values());
    this.refreshContextBar();
  }

  private pickPreferredSession(sessions: DiscoveredSessionSummary[]): string {
    const preferred =
      sessions.find((s) => s.ide !== "mcp" && !s.sessionId.startsWith("mcp-")) ??
      sessions[0];
    return preferred?.sessionId ?? "";
  }

  private getTeamScopeKey(project?: string, workspace?: string): string {
    const proj = (project ?? this.selectedProject ?? "").trim();
    const ws = (workspace ?? this.lockedWorkspace ?? "").trim();
    return `${proj}::${ws}`;
  }

  private toTeamRosterRefs(entries: TeamRosterEntry[]): TeamRosterRef[] {
    return entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      role:
        entry.roleType &&
        entry.boardRole &&
        entry.roleType.toLowerCase() !== entry.boardRole.toLowerCase()
          ? `${entry.roleType} · ${entry.boardRole}`
          : entry.roleType || entry.boardRole || entry.description || "",
    }));
  }

  private ensureTeamRosterFallback(project?: string, workspace?: string): void {
    const key = this.getTeamScopeKey(project, workspace);
    if (this.cachedTeamFallback.has(key) || this.inflightTeamFallback.has(key)) {
      return;
    }
    const task = (async () => {
      try {
        const team = await fetchTeam({
          project: project || undefined,
          workspace: workspace || undefined,
        });
        const roster = this.toTeamRosterRefs(team.roster);
        const definitions = team.definitions ?? [];
        this.cachedTeamFallback.set(key, { roster, definitions });
        const curSnap = this.lastSnapshot;
        if (curSnap) {
          const curKey = this.getTeamScopeKey(
            curSnap.projectId || this.selectedProject,
            curSnap.workspacePath || this.lockedWorkspace
          );
          if (curKey === key && (!curSnap.teamRoster || curSnap.teamRoster.length === 0)) {
            this.studioView.setFallbackTeamRoster(roster, definitions);
          }
        }
      } catch {
        // Non-fatal: topology still groups by readable subagent slug
      } finally {
        this.inflightTeamFallback.delete(key);
      }
    })();
    this.inflightTeamFallback.set(key, task);
  }

  private handleIncomingSnapshot(snap: SessionSnapshot): void {
    if (this.activeView === "chat") {
      if (
        !shouldAcceptChatSnapshot({
          pinnedSessionId: this.pinnedChatSessionId,
          snapshotSessionId: snap.sessionId,
        })
      ) {
        return;
      }
      this.lastSnapshot = snap;
      const labelMap = new Map<string, string>();
      for (const a of snap.agents) {
        if (a.id && a.label) labelMap.set(a.id, a.label);
      }
      this.chatPane.notifySnapshot(snap, snap.agents, labelMap, snap.definitions);
      return;
    }

    if (snap.boardProjects) this.mergeProjects(snap.boardProjects);
    if (Array.isArray(snap.sessions)) {
      const prevSelected = this.selectedSessionId
        ? this.sessions.find((s) => s.sessionId === this.selectedSessionId)
        : undefined;
      this.sessions = snap.sessions;
      if (
        this.multiOnly &&
        prevSelected &&
        !this.sessions.some((s) => s.sessionId === prevSelected.sessionId)
      ) {
        this.sessions = [prevSelected, ...this.sessions];
      }
    }
    if (!this.selectedSessionId && snap.sessionId) {
      this.selectedSessionId = snap.sessionId;
      this.syncUrlState();
      if (this.stream.getSession() !== this.selectedSessionId) {
        this.stream.updateParams({
          session: this.selectedSessionId,
          ide: this.ideFilter,
          project: this.selectedProject,
          workspace: this.lockedWorkspace || undefined,
        });
      }
    } else if (
      this.selectedSessionId &&
      snap.sessionId &&
      snap.sessionId !== this.selectedSessionId
    ) {
      this.refreshContextBar();
      return;
    }
    this.lastSnapshot = snap;

    const scopeProject = snap.projectId || this.selectedProject || undefined;
    const scopeWorkspace = snap.workspacePath || this.lockedWorkspace || undefined;
    const scopeKey = this.getTeamScopeKey(scopeProject, scopeWorkspace);
    if (snap.teamRoster && snap.teamRoster.length > 0) {
      this.cachedTeamFallback.set(scopeKey, {
        roster: snap.teamRoster,
        definitions: snap.definitions ?? [],
      });
      this.studioView.setFallbackTeamRoster(snap.teamRoster, snap.definitions);
    } else {
      const cached = this.cachedTeamFallback.get(scopeKey);
      this.studioView.setFallbackTeamRoster(cached?.roster, cached?.definitions);
      if (!cached) {
        this.ensureTeamRosterFallback(scopeProject, scopeWorkspace);
      }
    }

    this.studioView.setSnapshot(snap);
    this.doctorView.notifyLiveSnapshot(snap);
    this.refreshContextBar();
    this.processPendingOpenActions(snap);
  }

  private resolveChatIde(agentId?: string): IdeSource {
    if (agentId && this.lastSnapshot) {
      const found = this.lastSnapshot.agents.find((a) => a.id === agentId);
      if (found?.ide && found.ide !== "unknown") return found.ide;
    }
    if (this.lastSnapshot?.ide && this.lastSnapshot.ide !== "unknown") {
      return this.lastSnapshot.ide;
    }
    if (this.lockedIde) return this.lockedIde;
    if (this.ideFilter !== "all") return this.ideFilter;
    return "unknown";
  }

  private resolveAgentLabel(agentId: string): string {
    const labelMap = new Map<string, string>();
    if (this.lastSnapshot) {
      for (const a of this.lastSnapshot.agents) {
        if (a.id && a.label) labelMap.set(a.id, a.label);
      }
    }
    const found = this.lastSnapshot?.agents.find((a) => a.id === agentId);
    return formatActorName(agentId, labelMap, found?.label);
  }

  private openHostChatTab(
    agentId: string,
    focusQuestion = false,
    meta?: { agentLabel?: string; sessionId?: string; ide?: string }
  ): void {
    if (
      !shouldRouteChatToHostTab({
        embedMode: this.embedMode,
        mcpAppMode: this.mcpAppMode,
        hasParent: typeof window !== "undefined" && window.parent !== window,
      })
    ) {
      return;
    }
    const payload = buildOpenChatTabPayload({
      sessionId: meta?.sessionId || this.selectedSessionId || this.lastSnapshot?.sessionId || "",
      agentId,
      agentLabel: meta?.agentLabel || this.resolveAgentLabel(agentId),
      ide: meta?.ide || this.resolveChatIde(agentId),
      focusQuestion,
    });
    window.parent.postMessage(payload, "*");
  }

  private openChatPanelAgent(
    sessionId: string,
    agentId: string,
    agentLabel?: string,
    focusQuestion = false
  ): void {
    if (!sessionId || !agentId) {
      this.chatPane.renderEmptyContext(
        "No agent conversation selected",
        "Click Chat on any agent in Live Studio to inspect its conversation here."
      );
      return;
    }
    const snap =
      this.lastSnapshot && this.lastSnapshot.sessionId === sessionId
        ? this.lastSnapshot
        : null;
    const labelMap = new Map<string, string>();
    if (snap) {
      for (const a of snap.agents) {
        if (a.id && a.label) labelMap.set(a.id, a.label);
      }
    }
    if (agentLabel) {
      labelMap.set(agentId, agentLabel);
    }
    const liveAgent: AgentNodeSnapshot = snap?.agents.find((a) => a.id === agentId) ?? {
      id: agentId,
      label: agentLabel || agentId,
      ide: this.resolveChatIde(agentId),
      status: "IDLE",
      toolCalls: 0,
      messagesSent: 0,
      messagesReceived: 0,
    };
    const definition = snap?.definitions?.find(
      (d) => d.id === liveAgent.id || d.name === liveAgent.label
    );
    this.chatPane.openAgent({
      sessionId,
      agent: liveAgent,
      labelMap,
      definition,
      focusQuestion,
    });
  }

  private bindHostFocusMessages(): void {
    if (typeof window === "undefined") return;
    window.addEventListener("message", (event: MessageEvent) => {
      if (window.parent === window || event.source !== window.parent) {
        return;
      }
      const data = event.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      const rec = data as Record<string, unknown>;

      if (rec.type === "agentStudio:replyResult") {
        const reqId = typeof rec.requestId === "string" ? rec.requestId : "";
        const resolver = reqId ? this.pendingReplyResolvers.get(reqId) : undefined;
        if (resolver) {
          this.pendingReplyResolvers.delete(reqId);
          resolver({
            ok: Boolean(rec.ok),
            mode: typeof rec.mode === "string" ? rec.mode : undefined,
            message: typeof rec.message === "string" ? rec.message : undefined,
          });
        }
        return;
      }

      if (rec.type === "agentStudio:showAgentChat") {
        if (!this.embedMode || this.mcpAppMode) return;
        const nextSession =
          typeof rec.sessionId === "string" ? rec.sessionId.trim() : "";
        const nextAgent =
          typeof rec.agentId === "string" ? rec.agentId.trim() : "";
        const nextLabel =
          typeof rec.agentLabel === "string" ? rec.agentLabel.trim() : undefined;
        const focusQuestion = Boolean(rec.focusQuestion);

        if (this.activeView !== "chat") {
          this.setView("chat");
        }

        if (!nextSession || !nextAgent) {
          this.pinnedChatSessionId = nextSession;
          this.pinnedChatAgentId = nextAgent;
          this.pinnedChatAgentLabel = nextLabel ?? "";
          this.pinnedChatFocusQuestion = focusQuestion;
          this.chatPane.renderEmptyContext(
            "No agent conversation selected",
            "Click Chat on any agent in Live Studio to inspect its conversation here."
          );
          this.syncUrlState();
          return;
        }

        const sessionChanged = nextSession !== this.pinnedChatSessionId;
        this.pinnedChatSessionId = nextSession;
        this.selectedSessionId = nextSession;
        this.pinnedChatAgentId = nextAgent;
        this.pinnedChatAgentLabel = nextLabel ?? "";
        this.pinnedChatFocusQuestion = focusQuestion;
        this.syncUrlState();

        if (sessionChanged) {
          this.lastSnapshot = null;
          this.stream.updateParams({
            session: nextSession,
            ide: this.ideFilter,
            project: this.selectedProject,
            workspace: this.lockedWorkspace || undefined,
          });
          if (!this.chatStreamStarted) {
            this.chatStreamStarted = true;
            this.stream.connect();
          }
          void this.loadCurrentSnapshot();
        }

        this.openChatPanelAgent(nextSession, nextAgent, nextLabel, focusQuestion);
        return;
      }

      if (!this.embedMode || this.activeView === "chat") return;
      if (rec.type !== "agentStudio:focusSession") return;

      const nextSession =
        typeof rec.sessionId === "string" ? rec.sessionId.trim() : "";
      const nextChatAgent =
        typeof rec.openChatAgentId === "string"
          ? rec.openChatAgentId.trim()
          : "";
      const openWaiting = Boolean(rec.openWaiting);

      if (nextChatAgent) {
        this.pendingOpenChatAgentId = nextChatAgent;
        this.pendingOpenWaiting = false;
      } else if (openWaiting) {
        this.pendingOpenWaiting = true;
      }

      if (this.activeView !== "studio") {
        this.setView("studio");
      }

      const sessionChanged = Boolean(nextSession && nextSession !== this.selectedSessionId);
      if (sessionChanged) {
        this.selectedSessionId = nextSession;
        this.syncUrlState();
        this.refreshContextBar();
        this.stream.updateParams({
          session: this.selectedSessionId,
          ide: this.ideFilter,
          project: this.selectedProject,
          workspace: this.lockedWorkspace || undefined,
        });
        void this.loadCurrentSnapshot();
        return;
      }

      if (this.lastSnapshot) {
        this.processPendingOpenActions(this.lastSnapshot);
      } else {
        void this.loadCurrentSnapshot();
      }
    });
  }

  private processPendingOpenActions(snap: SessionSnapshot): void {
    if (this.pendingOpenChatAgentId) {
      const targetId = this.pendingOpenChatAgentId;
      this.pendingOpenChatAgentId = null;
      this.pendingOpenWaiting = false;
      if (this.activeView !== "studio") {
        this.setView("studio");
      }
      this.studioView.openChat(targetId, true);
      return;
    }

    if (this.pendingOpenWaiting) {
      const hasWaiting =
        (snap.pendingPrompts?.length ?? 0) > 0 ||
        snap.agents.some((a) => Boolean(a.pendingPrompt));
      if (hasWaiting) {
        this.pendingOpenWaiting = false;
        if (this.activeView !== "studio") {
          this.setView("studio");
        }
        this.studioView.openFirstWaitingChat();
      } else if (snap.sessionId && snap.agents.length > 0) {
        this.pendingOpenWaiting = false;
      }
    }
  }

  public getReplyCapabilities(): ReplyCapabilities {
    if (this.mcpAppMode && this.mcpReplyCapabilitiesGetter) {
      return this.mcpReplyCapabilitiesGetter();
    }
    return {
      canSendMessage: false,
      isMcpApp: this.mcpAppMode,
      isEmbed: this.embedMode,
    };
  }

  public async cancelPendingPromptFromUi(
    promptId: string,
    reason?: string
  ): Promise<ReplyToHostResult> {
    const cleanId = promptId.trim();
    if (!cleanId) {
      return {
        ok: false,
        mode: "error",
        message: "Missing prompt ID.",
      };
    }
    const res = await cancelPendingPrompt(cleanId, reason);
    if (res.ok) {
      if (this.mcpAppMode) {
        void this.loadCurrentSnapshot();
      }
      return {
        ok: true,
        mode: "canceled",
        status: res.status ?? "canceled",
        message: "Canceled — agent unblocked",
      };
    }
    if (res.conflict) {
      if (this.mcpAppMode) {
        void this.loadCurrentSnapshot();
      }
      return {
        ok: false,
        mode: "error",
        conflict: true,
        status: res.status,
        message: res.error || "Already resolved",
      };
    }
    return {
      ok: false,
      mode: "error",
      status: res.status,
      message: res.error || "Failed to cancel prompt.",
    };
  }

  public async sendReplyToHost(
    req: ReplyToHostRequest
  ): Promise<ReplyToHostResult> {
    const text = req.text.trim();
    if (!text) {
      return {
        ok: false,
        mode: "error",
        message: "Please select an option or enter a reply first.",
      };
    }

    if (req.directReply === true) {
      const promptId = (req.promptId ?? "").trim();
      if (!promptId) {
        return {
          ok: false,
          mode: "error",
          message: "Missing prompt ID for direct reply.",
        };
      }
      const res = await answerPendingPrompt(promptId, {
        answerText: text,
        answers: req.answers,
      });
      if (res.ok) {
        if (this.mcpAppMode) {
          void this.loadCurrentSnapshot();
        }
        return {
          ok: true,
          mode: "answered",
          status: res.status ?? "answered",
          message: "Answer sent.",
        };
      }
      if (res.conflict) {
        if (this.mcpAppMode) {
          void this.loadCurrentSnapshot();
        }
        return {
          ok: false,
          mode: "error",
          conflict: true,
          status: res.status,
          message: res.error || "Already resolved",
        };
      }
      return {
        ok: false,
        mode: "error",
        status: res.status,
        message: res.error || "Failed to send answer.",
      };
    }

    if (this.mcpAppMode && this.mcpReplyHandler) {
      return this.mcpReplyHandler({
        ...req,
        sessionId: req.sessionId || this.selectedSessionId || undefined,
        text,
      });
    }

    if (
      this.embedMode &&
      typeof window !== "undefined" &&
      window.parent !== window
    ) {
      const requestId = `reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const bridgeRes = await new Promise<{
        ok?: boolean;
        mode?: string;
        message?: string;
      } | null>((resolve) => {
        let settled = false;
        const settle = (res: { ok?: boolean; mode?: string; message?: string } | null) => {
          if (settled) return;
          settled = true;
          this.pendingReplyResolvers.delete(requestId);
          window.clearTimeout(timer);
          resolve(res);
        };
        const timer = window.setTimeout(() => {
          settle(null);
        }, 4000);

        this.pendingReplyResolvers.set(requestId, settle);
        window.parent.postMessage(
          {
            type: "agentStudio:replyToAgent",
            requestId,
            sessionId: req.sessionId || this.pinnedChatSessionId || this.selectedSessionId || "",
            agentId: req.agentId,
            promptId: req.promptId,
            text,
            blockingToolCall: req.blockingToolCall,
          },
          "*"
        );
      });

      if (bridgeRes && bridgeRes.ok) {
        const mode: ReplyToHostResult["mode"] =
          bridgeRes.mode === "sent" ||
          bridgeRes.mode === "prefilled" ||
          bridgeRes.mode === "copied" ||
          bridgeRes.mode === "focused_copied"
            ? bridgeRes.mode
            : req.blockingToolCall
              ? "focused_copied"
              : "prefilled";
        return {
          ok: true,
          mode,
          message:
            bridgeRes.message ||
            (req.blockingToolCall
              ? "Copied & focused IDE — paste to confirm prompt."
              : "Prefilled in IDE chat."),
        };
      }
    }

    const copied = await copyTextSafe(text);
    return {
      ok: copied,
      mode: "copied",
      message: copied
        ? "Copied answer — paste into your IDE prompt to respond."
        : "Copy failed — please select and copy your answer manually.",
    };
  }

  private collectFeedbackDiagnostics(): FeedbackDiagnostics {
    const snap = this.lastSnapshot;
    const aiAgents = snap?.agents.filter((a) => (a.nodeType ?? "agent") === "agent") ?? [];
    const peakAgent =
      (snap?.usage?.peakContextAgentId
        ? aiAgents.find((a) => a.id === snap.usage?.peakContextAgentId)
        : undefined) ??
      aiAgents.find((a) => a.usage?.model || a.model) ??
      aiAgents[0];

    const ide =
      snap?.ide ??
      this.lockedIde ??
      (this.ideFilter !== "all" ? this.ideFilter : "unknown");

    const model =
      peakAgent?.usage?.model ??
      peakAgent?.model ??
      snap?.usage?.models?.[0]?.model;

    return {
      appVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0",
      ide,
      model: model && model !== "unknown" ? model : undefined,
      contextTokens: peakAgent?.usage?.contextTokens,
      contextWindow: peakAgent?.usage?.contextWindow,
      contextPercent: snap?.usage?.peakContextPercent ?? peakAgent?.usage?.contextPercent,
      agentCount: aiAgents.length > 0 ? aiAgents.length : undefined,
      eventCount: snap?.counters?.totalEvents ?? snap?.events.length,
      embedMode: this.embedMode,
    };
  }

  private openFeedbackDialog(): void {
    this.feedbackDialog.setRuntimeScope({
      embedMode: this.embedMode,
      mcpAppMode: this.mcpAppMode,
    });
    this.feedbackDialog.open(this.collectFeedbackDiagnostics());
  }

  private async refreshSessions(): Promise<void> {
    try {
      const prevSelected = this.selectedSessionId
        ? this.sessions.find((s) => s.sessionId === this.selectedSessionId)
        : undefined;
      const res = await fetchSessions({
        ide: this.ideFilter,
        project: this.selectedProject,
        workspace: this.lockedWorkspace || undefined,
        multiOnly: this.multiOnly,
      });
      this.sessions = res.sessions;
      if (
        this.multiOnly &&
        prevSelected &&
        !this.sessions.some((s) => s.sessionId === prevSelected.sessionId)
      ) {
        this.sessions = [prevSelected, ...this.sessions];
      }
      this.mergeProjects(res.projects);
      if (
        !this.selectedSessionId ||
        (!this.multiOnly &&
          this.sessions.length > 0 &&
          !this.sessions.some((s) => s.sessionId === this.selectedSessionId))
      ) {
        this.selectedSessionId = this.pickPreferredSession(this.sessions);
        if (this.selectedSessionId) {
          this.syncUrlState();
        }
      }
      this.refreshContextBar();
    } catch {
      // Server/host may be temporarily busy; stream/poller handles reconnect status
    }
  }

  private async loadCurrentSnapshot(): Promise<void> {
    try {
      const snap = await fetchState({
        session: this.selectedSessionId,
        ide: this.ideFilter,
        project: this.selectedProject,
        workspace: this.lockedWorkspace || undefined,
      });
      this.handleIncomingSnapshot(snap);
    } catch {
      // Handled by connection pill
    }
  }

  private async refreshSessionsAndState(): Promise<void> {
    await this.refreshSessions();
    this.stream.updateParams({
      session: this.selectedSessionId,
      ide: this.ideFilter,
      project: this.selectedProject,
      workspace: this.lockedWorkspace || undefined,
    });
    await this.loadCurrentSnapshot();
  }

  private async bootstrap(): Promise<void> {
    if (this.activeView === "chat") {
      if (this.pinnedChatSessionId) {
        this.stream.updateParams({
          session: this.pinnedChatSessionId,
          ide: this.ideFilter,
          project: this.selectedProject,
          workspace: this.lockedWorkspace || undefined,
        });
        await this.loadCurrentSnapshot();
        this.chatStreamStarted = true;
        this.stream.connect();
      } else {
        this.connection = "offline";
        this.chatPane.setConnectionState("idle", "No session");
      }
      return;
    }

    // In MCP App mode, keep initial calls lean (max 2 concurrent) — loadCurrentSnapshot already returns sessions & boardProjects
    if (this.mcpAppMode) {
      await this.loadCurrentSnapshot();
      this.stream.updateParams({
        session: this.selectedSessionId,
        ide: this.ideFilter,
        project: this.selectedProject,
        workspace: this.lockedWorkspace || undefined,
      });
      this.stream.connect();
      this.refreshActiveSecondaryView();
      return;
    }

    const [, boardRes] = await Promise.allSettled([
      this.refreshSessions(),
      fetchBoard({
        project: this.selectedProject || undefined,
        workspace: this.lockedWorkspace || undefined,
      }),
    ]);

    if (boardRes.status === "fulfilled") {
      if (boardRes.value.projects) this.mergeProjects(boardRes.value.projects);
      else if (boardRes.value.project) {
        this.mergeProjects([{ id: boardRes.value.project, title: boardRes.value.project }]);
      }
    }

    await this.loadCurrentSnapshot();
    this.stream.updateParams({
      session: this.selectedSessionId,
      ide: this.ideFilter,
      project: this.selectedProject,
      workspace: this.lockedWorkspace || undefined,
    });
    this.stream.connect();
    this.refreshActiveSecondaryView();
  }

  private restoreFromUrl(): void {
    let sp: URLSearchParams;
    let search = "";
    try {
      search = window.location.search;
      sp = new URLSearchParams(search);
    } catch {
      return;
    }
    const route = parseChatViewRouteParams(search);
    this.embedMode = route.embed;

    const v = sp.get("view") as PrimaryView | null;
    const p = route.project;
    const ws = route.workspace;
    const ide = route.ide as IdeFilter;
    const sess = route.session;
    const openChat = sp.get("openChat");
    const openWaiting = sp.get("openWaiting");

    if (p) this.selectedProject = p;
    if (ws) this.lockedWorkspace = ws;
    if (openChat && openChat.trim()) {
      this.pendingOpenChatAgentId = openChat.trim();
    }
    if (openWaiting === "1" || openWaiting === "true") {
      this.pendingOpenWaiting = true;
    }

    if (ide === "antigravity" || ide === "claude-code" || ide === "copilot-vscode") {
      this.ideFilter = ide;
      if (this.embedMode) this.lockedIde = ide;
    } else if (ide === "all" && !this.embedMode) {
      this.ideFilter = "all";
    }

    if (sess) this.selectedSessionId = sess;

    this.applyShellAttributes();

    const scope = this.getEmbedScope();
    this.feedbackDialog.setRuntimeScope({
      embedMode: this.embedMode,
      mcpAppMode: this.mcpAppMode,
    });
    this.teamView.setEmbedScope(scope);
    this.doctorView.setEmbedScope(scope);
    this.chatPane.setRuntimeScope({
      embedMode: this.embedMode,
      mcpAppMode: this.mcpAppMode,
    });
    this.studioView.setChatRuntimeScope({
      embedMode: this.embedMode,
      mcpAppMode: this.mcpAppMode,
    });
    this.refreshContextBar();

    if (route.isChatView) {
      this.pinnedChatSessionId = route.session;
      this.pinnedChatAgentId = route.agent;
      this.pinnedChatFocusQuestion = route.focusQuestion;
      this.setView("chat");
      return;
    }

    if (
      v === "studio" ||
      v === "team" ||
      v === "board" ||
      v === "mockups" ||
      v === "doctor"
    ) {
      this.setView(v);
    }
  }

  private syncUrlState(): void {
    if (this.mcpAppMode) return;
    try {
      const sp = new URLSearchParams();
      if (this.embedMode) sp.set("embed", "1");
      if (this.activeView !== "studio") sp.set("view", this.activeView);
      if (this.selectedProject) sp.set("project", this.selectedProject);
      if (this.lockedWorkspace) sp.set("workspace", this.lockedWorkspace);
      const effectiveIde = this.lockedIde ?? this.ideFilter;
      if (effectiveIde !== "all") sp.set("ide", effectiveIde);
      const effectiveSession =
        this.activeView === "chat"
          ? this.pinnedChatSessionId || this.selectedSessionId
          : this.selectedSessionId;
      if (effectiveSession) sp.set("session", effectiveSession);
      if (this.activeView === "chat") {
        if (this.pinnedChatAgentId) sp.set("agent", this.pinnedChatAgentId);
        if (this.pinnedChatFocusQuestion) sp.set("focusQuestion", "1");
      }
      const qs = sp.toString();
      const nextUrl = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
      window.history.replaceState(null, "", nextUrl);
    } catch {
      // Ignore SecurityError in sandboxed/opaque-origin iframes
    }
  }
}
