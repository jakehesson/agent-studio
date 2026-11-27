import type {
  ConnectionState,
  DiscoveredSessionSummary,
  HostIde,
  IdeFilter,
  PendingHumanPrompt,
  PrimaryView,
  RegisteredProject,
} from "../types.js";
import { escHtml, fmtAge, getIdeMeta, getStatusStyle, trunc } from "../utils.js";

export interface ContextBarState {
  projects: RegisteredProject[];
  selectedProject: string;
  ideFilter: IdeFilter;
  sessions: DiscoveredSessionSummary[];
  selectedSessionId: string;
  connection: ConnectionState;
  activeView: PrimaryView;
  multiOnly: boolean;
  embedMode: boolean;
  mcpAppMode?: boolean;
  hideMockups?: boolean;
  lockedIde: HostIde | null;
  lockedWorkspace: string;
  pendingPrompts?: PendingHumanPrompt[];
}

export interface ContextBarCallbacks {
  onSelectProject: (projectId: string) => void;
  onSelectIde: (ide: IdeFilter) => void;
  onSelectSession: (sessionId: string) => void;
  onToggleMultiOnly: () => void;
  onResetFilters: () => void;
  onSelectView: (view: PrimaryView) => void;
  onReconnect: () => void;
  onOpenFeedback: () => void;
  onOpenWaitingAgent?: (agentId: string) => void;
}

const IDE_PILLS: Array<{ id: IdeFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "antigravity", label: "Antigravity" },
  { id: "claude-code", label: "Claude Code" },
  { id: "copilot-vscode", label: "VS Code" },
];

const PRIMARY_TABS: Array<{ id: PrimaryView; label: string }> = [
  { id: "studio", label: "Live Studio" },
  { id: "team", label: "Team" },
  { id: "board", label: "Agile Board" },
  { id: "mockups", label: "Mockups" },
  { id: "doctor", label: "Doctor" },
];

export class ContextBar {
  private root: HTMLElement;
  private cb: ContextBarCallbacks;
  private state: ContextBarState;
  private popoverOpen = false;
  private searchQuery = "";
  private sheetDialog: HTMLDialogElement | null = null;
  private onDocClick: (e: MouseEvent) => void;
  private lastScopeChipHtml = "";
  private lastPopListHtml = "";
  private lastSheetListHtml = "";
  private seenPromptIds = new Set<string>();

  constructor(root: HTMLElement, initial: ContextBarState, cb: ContextBarCallbacks) {
    this.root = root;
    this.state = initial;
    this.cb = cb;

    this.onDocClick = (e: MouseEvent) => {
      if (!this.popoverOpen) return;
      const target = e.target as Node | null;
      const picker = this.root.querySelector(".session-picker");
      if (picker && target && !picker.contains(target)) {
        this.popoverOpen = false;
        this.updateSessionMenu();
      }
    };
    document.addEventListener("click", this.onDocClick);

    this.mount();
    this.update(initial);
  }

  public dispose(): void {
    document.removeEventListener("click", this.onDocClick);
    this.sheetDialog?.remove();
    this.sheetDialog = null;
  }

  private isCoverScreen(): boolean {
    return window.matchMedia("(max-width: 639px)").matches;
  }

  private mount(): void {
    this.root.innerHTML = `
      <div class="ctx-top-row">
        <div class="ctx-brand">
          <span class="brand-mark" aria-hidden="true">AS</span>
          <div class="brand-copy">
            <h1>Agent Studio</h1>
            <span class="brand-sub">IDE-Agnostic Multi-Agent Monitor &amp; Board</span>
          </div>
        </div>

        <nav class="primary-tabs" role="tablist" aria-label="Studio views">
          ${PRIMARY_TABS.map(
            (t) => `
              <button
                type="button"
                role="tab"
                class="primary-tab"
                data-view="${t.id}"
                aria-selected="false"
              >${escHtml(t.label)}</button>
            `
          ).join("")}
        </nav>

        <div class="ctx-status-wrap">
          <button
            type="button"
            class="waiting-alert-pill"
            data-waiting-pill
            hidden
            aria-label="Waiting for user input"
          >
            <span class="waiting-q-ico" aria-hidden="true">?</span>
            <span data-waiting-label>0 waiting</span>
          </button>
          <span class="sr-only" aria-live="polite" data-waiting-announcer></span>
          <button
            type="button"
            class="feedback-trigger"
            data-feedback-open
            aria-label="Send Feedback"
            title="Send Feedback to jakehesson/agent-studio"
          >
            <svg class="feedback-btn-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2.5 3.5h11a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H6.2l-3.2 2.4v-2.4H2.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
              <path d="M5 7h6M5 9.4h4" />
            </svg>
            <span class="feedback-btn-label">Feedback</span>
          </button>
          <button
            type="button"
            class="sse-pill"
            data-sse-pill
            title="Live telemetry SSE connection (click to reconnect)"
            aria-label="Live telemetry status"
          >
            <span class="sse-dot" aria-hidden="true"></span>
            <span data-sse-label>CONNECTING</span>
          </button>
        </div>
      </div>

      <div class="ctx-controls-row" role="toolbar" aria-label="Workspace and session filters">
        <div class="embed-scope-chip" data-embed-scope hidden></div>

        <div class="ctx-group">
          <label class="sr-only" for="ctxProjectSelect">Project</label>
          <select id="ctxProjectSelect" class="ctx-select" aria-label="Select project"></select>
        </div>

        <div class="ide-pills" role="group" aria-label="IDE source filter">
          ${IDE_PILLS.map(
            (p) => `
              <button
                type="button"
                class="ide-pill"
                data-ide="${p.id}"
                aria-pressed="false"
              >${escHtml(p.label)}</button>
            `
          ).join("")}
        </div>

        <div class="session-picker">
          <button
            type="button"
            class="session-trigger"
            data-session-trigger
            aria-haspopup="listbox"
            aria-expanded="false"
          >
            <span class="st-dot" data-st-dot aria-hidden="true"></span>
            <span class="st-proj-pill" data-st-proj hidden></span>
            <span class="st-ide" data-st-ide></span>
            <span class="st-label" data-st-label>Loading sessions…</span>
            <span class="st-caret" aria-hidden="true">▾</span>
          </button>

          <div class="session-popover" data-session-popover role="region" aria-label="Sessions">
            <div class="session-pop-head">
              <input
                type="search"
                class="session-search"
                data-pop-search
                placeholder="Filter sessions by title, project, or ID…"
                aria-label="Filter sessions"
              />
              <button type="button" class="chip-toggle" data-pop-multi>Multi-agent</button>
            </div>
            <div class="session-list" data-pop-list role="listbox" aria-label="Discovered sessions"></div>
          </div>
        </div>
      </div>
    `;

    // Create native <dialog closedby="any"> bottom sheet for cover screens (< 640px)
    const dlg = document.createElement("dialog");
    dlg.className = "bottom-sheet-dialog";
    dlg.setAttribute("closedby", "any");
    dlg.setAttribute("aria-labelledby", "sheetSessionTitle");
    dlg.innerHTML = `
      <div class="sheet-shell">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-head">
          <h2 id="sheetSessionTitle">Switch Session &amp; Project</h2>
          <button type="button" class="sheet-close" data-sheet-close aria-label="Close session picker">✕</button>
        </div>
        <div class="sheet-body">
          <div data-sheet-project-wrap>
            <label class="sheet-label" for="sheetProjectSelect">Project</label>
            <select id="sheetProjectSelect" class="ctx-select sheet-select"></select>
          </div>
          <div class="sheet-search-row">
            <input
              type="search"
              class="session-search"
              data-sheet-search
              placeholder="Search sessions…"
              aria-label="Search sessions"
            />
            <button type="button" class="chip-toggle" data-sheet-multi>Multi-agent</button>
          </div>
          <div class="session-list sheet-list" data-sheet-list role="listbox" aria-label="Discovered sessions"></div>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    this.sheetDialog = dlg;

    // Mandatory light-dismiss fallback for browsers without HTMLDialogElement.prototype.closedBy (Safari)
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      dlg.addEventListener("click", (event) => {
        if (event.target !== dlg) return;
        const rect = dlg.getBoundingClientRect();
        const inside =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (!inside) {
          dlg.close();
        }
      });
    }

    dlg.querySelector("[data-sheet-close]")?.addEventListener("click", () => dlg.close());

    const sheetProj = dlg.querySelector("#sheetProjectSelect") as HTMLSelectElement | null;
    sheetProj?.addEventListener("change", () => {
      this.cb.onSelectProject(sheetProj.value);
    });

    const sheetSearch = dlg.querySelector("[data-sheet-search]") as HTMLInputElement | null;
    sheetSearch?.addEventListener("input", () => {
      this.searchQuery = sheetSearch.value;
      this.renderSessionLists();
    });

    dlg.querySelector("[data-sheet-multi]")?.addEventListener("click", () => {
      this.cb.onToggleMultiOnly();
    });

    // Primary view tab clicks
    this.root.querySelectorAll<HTMLButtonElement>(".primary-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view as PrimaryView | undefined;
        if (view) {
          this.cb.onSelectView(view);
          btn.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      });
    });

    // Project dropdown
    const projSel = this.root.querySelector("#ctxProjectSelect") as HTMLSelectElement | null;
    projSel?.addEventListener("change", () => {
      this.cb.onSelectProject(projSel.value);
    });

    // IDE filter pills
    this.root.querySelectorAll<HTMLButtonElement>(".ide-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ide = btn.dataset.ide as IdeFilter | undefined;
        if (ide) this.cb.onSelectIde(ide);
      });
    });

    // Feedback modal trigger
    this.root.querySelector("[data-feedback-open]")?.addEventListener("click", () => {
      this.cb.onOpenFeedback();
    });

    // Waiting prompt pill trigger
    this.root.querySelector("[data-waiting-pill]")?.addEventListener("click", () => {
      const first = this.state.pendingPrompts?.[0];
      if (first?.agentId) {
        this.cb.onOpenWaitingAgent?.(first.agentId);
      }
    });

    // SSE reconnect pill
    this.root.querySelector("[data-sse-pill]")?.addEventListener("click", () => {
      this.cb.onReconnect();
    });

    // Session trigger
    const trigger = this.root.querySelector("[data-session-trigger]") as HTMLButtonElement | null;
    trigger?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.isCoverScreen() && this.sheetDialog) {
        this.renderSessionLists();
        if (!this.sheetDialog.open) this.sheetDialog.showModal();
      } else {
        this.popoverOpen = !this.popoverOpen;
        this.updateSessionMenu();
      }
    });

    // Popover search & multi-only toggle
    const popSearch = this.root.querySelector("[data-pop-search]") as HTMLInputElement | null;
    popSearch?.addEventListener("input", () => {
      this.searchQuery = popSearch.value;
      this.renderSessionLists();
    });

    this.root.querySelector("[data-pop-multi]")?.addEventListener("click", () => {
      this.cb.onToggleMultiOnly();
    });
  }

  public update(next: ContextBarState): void {
    this.state = next;

    // Update Primary View Tabs
    this.root.querySelectorAll<HTMLButtonElement>(".primary-tab").forEach((btn) => {
      const active = btn.dataset.view === next.activeView;
      btn.setAttribute("aria-selected", active ? "true" : "false");
      if (btn.dataset.view === "mockups") {
        btn.hidden = Boolean(next.hideMockups);
      }
    });

    // Update Embedded Scope Chip & bottom-sheet project visibility
    const scopeChip = this.root.querySelector<HTMLElement>("[data-embed-scope]");
    const sheetProjWrap = this.sheetDialog?.querySelector<HTMLElement>(
      "[data-sheet-project-wrap]"
    );
    const sheetTitle = this.sheetDialog?.querySelector("#sheetSessionTitle");
    if (next.embedMode) {
      const ideMeta = getIdeMeta(next.lockedIde ?? next.ideFilter);
      const projObj = next.projects.find((p) => p.id === next.selectedProject);
      const wsBase = next.lockedWorkspace
        ? next.lockedWorkspace.replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
          next.lockedWorkspace
        : "";
      const scopeLabel =
        projObj?.title || projObj?.name || next.selectedProject || wsBase || "Current Workspace";
      if (scopeChip) {
        scopeChip.hidden = false;
        scopeChip.title = next.lockedWorkspace || scopeLabel;
        const chipHtml = `
          <span class="ide-chip" style="color:${ideMeta.color};border-color:${ideMeta.border};background:${ideMeta.bg}">${escHtml(ideMeta.short)}</span>
          <span class="embed-scope-sep" aria-hidden="true">·</span>
          <span class="embed-scope-name">${escHtml(trunc(scopeLabel, 32))}</span>
        `;
        if (this.lastScopeChipHtml !== chipHtml) {
          scopeChip.innerHTML = chipHtml;
          this.lastScopeChipHtml = chipHtml;
        }
      }
      if (sheetProjWrap) sheetProjWrap.hidden = true;
      if (sheetTitle) sheetTitle.textContent = `${ideMeta.label} Sessions`;
    } else if (next.mcpAppMode && next.lockedIde) {
      const ideMeta = getIdeMeta(next.lockedIde);
      if (scopeChip) {
        scopeChip.hidden = false;
        scopeChip.title = `Scoped to ${ideMeta.label}`;
        const chipHtml = `
          <span class="ide-chip" style="color:${ideMeta.color};border-color:${ideMeta.border};background:${ideMeta.bg}">${escHtml(ideMeta.short)}</span>
          <span class="embed-scope-name">${escHtml(ideMeta.label)}</span>
        `;
        if (this.lastScopeChipHtml !== chipHtml) {
          scopeChip.innerHTML = chipHtml;
          this.lastScopeChipHtml = chipHtml;
        }
      }
      if (sheetProjWrap) sheetProjWrap.hidden = false;
      if (sheetTitle) sheetTitle.textContent = `${ideMeta.label} Sessions & Projects`;
    } else {
      if (scopeChip) scopeChip.hidden = true;
      if (sheetProjWrap) sheetProjWrap.hidden = false;
      if (sheetTitle) sheetTitle.textContent = "Switch Session & Project";
    }

    // Update Project Selects (header + sheet)
    const projOptionsHtml = [
      `<option value="">All Projects</option>`,
      ...next.projects.map(
        (p) =>
          `<option value="${escHtml(p.id)}" ${
            p.id === next.selectedProject ? "selected" : ""
          }>${escHtml(p.title || p.name || p.id)}</option>`
      ),
    ].join("");

    const projSel = this.root.querySelector("#ctxProjectSelect") as HTMLSelectElement | null;
    if (projSel && projSel.innerHTML !== projOptionsHtml) {
      projSel.innerHTML = projOptionsHtml;
    }
    if (projSel) projSel.value = next.selectedProject;

    const sheetProj = this.sheetDialog?.querySelector(
      "#sheetProjectSelect"
    ) as HTMLSelectElement | null;
    if (sheetProj && sheetProj.innerHTML !== projOptionsHtml) {
      sheetProj.innerHTML = projOptionsHtml;
    }
    if (sheetProj) sheetProj.value = next.selectedProject;

    // Update IDE Filter Pills
    this.root.querySelectorAll<HTMLButtonElement>(".ide-pill").forEach((btn) => {
      const pressed = btn.dataset.ide === next.ideFilter;
      btn.setAttribute("aria-pressed", pressed ? "true" : "false");
      btn.classList.toggle("active", pressed);
    });

    // Update Waiting Alert Pill & polite announcement
    const waitingPill = this.root.querySelector<HTMLButtonElement>("[data-waiting-pill]");
    const waitingLabel = this.root.querySelector<HTMLElement>("[data-waiting-label]");
    const waitingAnnouncer = this.root.querySelector<HTMLElement>("[data-waiting-announcer]");
    const pendingList = next.pendingPrompts ?? [];
    if (waitingPill && waitingLabel) {
      if (pendingList.length > 0) {
        waitingPill.hidden = false;
        waitingLabel.textContent = `${pendingList.length} waiting`;
        const first = pendingList[0]!;
        waitingPill.setAttribute(
          "aria-label",
          `${pendingList.length} ${pendingList.length === 1 ? "agent" : "agents"} waiting for input — open messages for ${first.agentLabel || first.agentId}`
        );
        waitingPill.title = `${first.agentLabel || first.agentId}: ${first.title}`;
      } else {
        waitingPill.hidden = true;
      }
    }
    if (waitingAnnouncer) {
      const newlyAdded = pendingList.filter((p) => p.id && !this.seenPromptIds.has(p.id));
      for (const p of pendingList) {
        if (p.id) this.seenPromptIds.add(p.id);
      }
      if (pendingList.length === 0) {
        this.seenPromptIds.clear();
      } else if (newlyAdded.length > 0) {
        const firstNew = newlyAdded[0]!;
        waitingAnnouncer.textContent = `${firstNew.agentLabel || firstNew.agentId} needs input: ${firstNew.title}`;
      }
    }

    // Update SSE Pill
    const ssePill = this.root.querySelector("[data-sse-pill]");
    const sseLabel = this.root.querySelector("[data-sse-label]");
    if (ssePill && sseLabel) {
      ssePill.classList.remove("is-live", "is-reconnecting", "is-offline");
      if (next.connection === "live") {
        ssePill.classList.add("is-live");
        sseLabel.textContent = "LIVE";
      } else if (next.connection === "reconnecting") {
        ssePill.classList.add("is-reconnecting");
        sseLabel.textContent = "RECONNECTING";
      } else if (next.connection === "offline") {
        ssePill.classList.add("is-offline");
        sseLabel.textContent = "OFFLINE";
      } else {
        sseLabel.textContent = "CONNECTING";
      }
    }

    // Update Multi-Agent buttons
    const updateMultiBtn = (el: Element | null) => {
      if (!el) return;
      el.classList.toggle("active", next.multiOnly);
      el.setAttribute("aria-pressed", next.multiOnly ? "true" : "false");
    };
    updateMultiBtn(this.root.querySelector("[data-pop-multi]"));
    updateMultiBtn(this.sheetDialog?.querySelector("[data-sheet-multi]") ?? null);

    // Update Session Trigger display
    const activeSession = next.sessions.find((s) => s.sessionId === next.selectedSessionId) ?? next.sessions[0];
    const stDot = this.root.querySelector("[data-st-dot]") as HTMLElement | null;
    const stProj = this.root.querySelector("[data-st-proj]") as HTMLElement | null;
    const stIde = this.root.querySelector("[data-st-ide]") as HTMLElement | null;
    const stLabel = this.root.querySelector("[data-st-label]") as HTMLElement | null;

    if (stProj) {
      if (!next.embedMode && next.selectedProject) {
        const projMeta = next.projects.find((p) => p.id === next.selectedProject);
        stProj.textContent = projMeta?.title || projMeta?.name || next.selectedProject;
        stProj.hidden = false;
      } else {
        stProj.hidden = true;
      }
    }

    if (activeSession) {
      const ideMeta = getIdeMeta(activeSession.ide);
      const st = getStatusStyle(activeSession.status);
      if (stDot) stDot.style.background = st.dot;
      if (stIde) {
        stIde.textContent = ideMeta.short;
        stIde.style.color = ideMeta.color;
        stIde.style.borderColor = ideMeta.border;
        stIde.style.background = ideMeta.bg;
        stIde.hidden = false;
      }
      if (stLabel) {
        const title = activeSession.title || activeSession.projectId || activeSession.sessionId.slice(0, 12);
        stLabel.textContent = trunc(title, 44);
      }
    } else {
      if (stDot) stDot.style.background = "#64748b";
      if (stIde) stIde.hidden = true;
      if (stLabel) stLabel.textContent = "No sessions found";
    }

    this.renderSessionLists();
  }

  private updateSessionMenu(): void {
    const pop = this.root.querySelector("[data-session-popover]");
    const trigger = this.root.querySelector("[data-session-trigger]");
    pop?.classList.toggle("open", this.popoverOpen);
    trigger?.setAttribute("aria-expanded", this.popoverOpen ? "true" : "false");
    if (this.popoverOpen) {
      this.renderSessionLists();
    }
  }

  private renderSessionLists(): void {
    const q = this.searchQuery.trim().toLowerCase();
    const filtered = this.state.sessions.filter((s) => {
      if (this.state.multiOnly && !s.isMultiAgent) return false;
      if (!q) return true;
      return (
        s.sessionId.toLowerCase().includes(q) ||
        (s.title ?? "").toLowerCase().includes(q) ||
        (s.projectId ?? "").toLowerCase().includes(q) ||
        s.ide.toLowerCase().includes(q)
      );
    });

    // Group by IDE source
    const grouped = new Map<string, DiscoveredSessionSummary[]>();
    for (const s of filtered) {
      const list = grouped.get(s.ide) ?? [];
      list.push(s);
      grouped.set(s.ide, list);
    }

    const activeFilterLabels: string[] = [];
    if (!this.state.embedMode) {
      if (this.state.selectedProject) activeFilterLabels.push(`Project: ${this.state.selectedProject}`);
      if (this.state.ideFilter !== "all") activeFilterLabels.push(`IDE: ${getIdeMeta(this.state.ideFilter).label}`);
    }
    if (this.state.multiOnly) activeFilterLabels.push("Multi-agent only");
    if (q) activeFilterLabels.push(`Search: "${this.searchQuery.trim()}"`);

    const hostIdeLabel = getIdeMeta(this.state.lockedIde ?? this.state.ideFilter).label;
    const emptyMsg = this.state.embedMode
      ? `No ${hostIdeLabel} sessions found for this workspace yet.`
      : "No sessions match current filters.";

    const html =
      filtered.length === 0
        ? `<div class="session-empty">
            <div>${escHtml(emptyMsg)}</div>
            ${
              activeFilterLabels.length > 0
                ? `<div class="session-empty-filters">Active: ${escHtml(activeFilterLabels.join(" · "))}</div>
                   <button type="button" class="btn-secondary" data-reset-filters>${
                     this.state.embedMode ? "Clear Search & Filter" : "Reset Filters"
                   }</button>`
                : ""
            }
          </div>`
        : Array.from(grouped.entries())
            .map(([ide, list]) => {
              const meta = getIdeMeta(ide);
              return `
                <div class="session-group-hdr">
                  <span class="ide-chip" style="color:${meta.color};border-color:${meta.border};background:${meta.bg}">${escHtml(meta.label)}</span>
                  <span class="session-group-count">${list.length}</span>
                </div>
                ${list
                  .map((s) => {
                    const st = getStatusStyle(s.status);
                    const isSelected = s.sessionId === this.state.selectedSessionId;
                    const ageSec = s.mtimeMs
                      ? Math.max(0, (Date.now() - s.mtimeMs) / 1000)
                      : s.updatedAt
                        ? Math.max(0, (Date.now() - Date.parse(s.updatedAt)) / 1000)
                        : null;
                    const statusBadge =
                      s.status === "THINKING" || s.status === "WORKING"
                        ? `<span class="s-status ${st.cssClass}">${st.label}</span>`
                        : s.isWaiting || s.status === "WAITING"
                          ? `<span class="s-status waiting">WAITING</span>`
                          : s.isCompleted || s.status === "DONE"
                            ? `<span class="s-status done">DONE</span>`
                            : `<span class="s-status idle">${st.label}</span>`;
                    return `
                      <button
                        type="button"
                        role="option"
                        aria-selected="${isSelected ? "true" : "false"}"
                        class="session-item ${isSelected ? "active" : ""}"
                        data-session-id="${escHtml(s.sessionId)}"
                      >
                        <div class="session-item-top">
                          <span class="s-dot" style="background:${st.dot}" aria-hidden="true"></span>
                          ${statusBadge}
                          ${s.projectId ? `<span class="s-proj">${escHtml(s.projectId)}</span>` : ""}
                          ${s.isMultiAgent ? `<span class="s-multi">MULTI</span>` : ""}
                          <span class="session-item-time">${escHtml(fmtAge(ageSec))}</span>
                        </div>
                        <div class="session-item-title">${escHtml(
                          s.title || s.workspacePath || s.sessionId
                        )}</div>
                      </button>
                    `;
                  })
                  .join("")}
              `;
            })
            .join("");

    const bindList = (
      container: HTMLElement | null,
      prevHtml: string,
      closeAfter: () => void
    ): string => {
      if (!container) return prevHtml;
      if (html === prevHtml) return prevHtml;
      const prevScrollTop = container.scrollTop;
      container.innerHTML = html;
      container.querySelectorAll<HTMLButtonElement>("[data-session-id]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const sid = btn.dataset.sessionId;
          if (sid) {
            this.cb.onSelectSession(sid);
            closeAfter();
          }
        });
      });
      container.querySelector("[data-reset-filters]")?.addEventListener("click", () => {
        this.searchQuery = "";
        const popSearch = this.root.querySelector<HTMLInputElement>("[data-pop-search]");
        if (popSearch) popSearch.value = "";
        const sheetSearch = this.sheetDialog?.querySelector<HTMLInputElement>("[data-sheet-search]");
        if (sheetSearch) sheetSearch.value = "";
        this.cb.onResetFilters();
        closeAfter();
      });
      if (prevScrollTop > 0) {
        container.scrollTop = prevScrollTop;
      }
      return html;
    };

    this.lastPopListHtml = bindList(
      this.root.querySelector<HTMLElement>("[data-pop-list]"),
      this.lastPopListHtml,
      () => {
        this.popoverOpen = false;
        this.updateSessionMenu();
      }
    );
    this.lastSheetListHtml = bindList(
      this.sheetDialog?.querySelector<HTMLElement>("[data-sheet-list]") ?? null,
      this.lastSheetListHtml,
      () => {
        this.sheetDialog?.close();
      }
    );
  }
}
