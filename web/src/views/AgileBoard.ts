import { fetchBoard } from "../api.js";
import type {
  BoardApiResponse,
  BoardItem,
  BoardState,
  RegisteredProject,
  TestrunRecord,
} from "../types.js";
import { escHtml, trunc } from "../utils.js";

const KANBAN_COLUMNS: Array<{ state: BoardState; label: string; accent: string }> = [
  { state: "ready", label: "Ready", accent: "#64748b" },
  { state: "design", label: "Design", accent: "#a855f7" },
  { state: "dev", label: "In Dev", accent: "#38bdf8" },
  { state: "test", label: "In QA / Test", accent: "#f59e0b" },
  { state: "done", label: "Done", accent: "#10b981" },
];

const SEVERITY_ORDER: Record<string, number> = { S1: 0, S2: 1, S3: 2, S4: 3 };

export interface AgileBoardCallbacks {
  onJumpToLiveStudio: (projectId: string) => void;
  onProjectsDiscovered: (projects: RegisteredProject[]) => void;
}

export class AgileBoardView {
  private root: HTMLElement;
  private cb: AgileBoardCallbacks;
  private currentProject = "";
  private currentWorkspace = "";
  private showDone = true;
  private selectedItemId: string | null = null;
  private data: BoardApiResponse | null = null;
  private loading = false;
  private errorMsg: string | null = null;

  constructor(root: HTMLElement, cb: AgileBoardCallbacks) {
    this.root = root;
    this.cb = cb;
    this.render();
  }

  public async load(projectId: string, workspace?: string): Promise<void> {
    this.currentProject = projectId;
    if (workspace !== undefined) this.currentWorkspace = workspace;
    this.loading = true;
    this.errorMsg = null;
    this.render();
    try {
      const res = await fetchBoard({
        project: projectId || undefined,
        workspace: this.currentWorkspace || undefined,
        showDone: this.showDone,
      });
      this.data = res;
      if (Array.isArray(res.projects) && res.projects.length > 0) {
        this.cb.onProjectsDiscovered(res.projects);
      }
    } catch (err) {
      this.errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const prevScrollTop = this.root.querySelector<HTMLElement>(".board-view")?.scrollTop ?? 0;
    const prevKanbanLeft = this.root.querySelector<HTMLElement>(".kanban-scroll")?.scrollLeft ?? 0;

    if (this.loading && !this.data) {
      this.root.innerHTML = `<div class="view-placeholder">Loading Agile Board…</div>`;
      return;
    }

    if (this.errorMsg && !this.data?.board) {
      this.root.innerHTML = `
        <div class="view-empty-wrap">
          <div class="view-empty-card">
            <h2>Agile Board Unavailable</h2>
            <p>${escHtml(this.errorMsg)}</p>
            <p class="muted">Run <code>npx agent-studio init</code> in your repository to initialize <code>pipeline/board.json</code>, or select another project.</p>
            <button type="button" class="btn-primary" data-board-retry>Retry</button>
          </div>
        </div>
      `;
      this.root
        .querySelector("[data-board-retry]")
        ?.addEventListener("click", () => void this.load(this.currentProject));
      return;
    }

    const board = this.data?.board;
    if (!board) {
      this.root.innerHTML = `
        <div class="view-empty-wrap">
          <div class="view-empty-card">
            <h2>No Agile Board Initialized</h2>
            <p class="muted">No <code>pipeline/board.json</code> was found for this project yet. Initialize one with <code>npx agent-studio init</code> to track sprints, bugs, and QA checkpoints.</p>
            <button type="button" class="btn-primary" data-board-retry>Refresh</button>
          </div>
        </div>
      `;
      this.root
        .querySelector("[data-board-retry]")
        ?.addEventListener("click", () => void this.load(this.currentProject));
      return;
    }

    const activeSprint = board.active_sprint || "All Sprints";
    const sprintMeta = board.active_sprint ? board.sprints?.[board.active_sprint] : undefined;
    const items = board.items ?? [];
    const sprintItems = board.active_sprint
      ? items.filter((it) => !it.sprint || it.sprint === board.active_sprint)
      : items;

    const counts: Record<string, number> = {
      ready: 0,
      design: 0,
      dev: 0,
      test: 0,
      done: 0,
      blocked: 0,
    };
    for (const it of sprintItems) {
      counts[it.state] = (counts[it.state] ?? 0) + 1;
    }

    const openBugs = (
      this.data?.openBugs ??
      items.filter((it) => it.type === "bug" && it.state !== "done")
    ).slice().sort((a, b) => {
      const sa = SEVERITY_ORDER[a.severity ?? "S4"] ?? 9;
      const sb = SEVERITY_ORDER[b.severity ?? "S4"] ?? 9;
      return sa - sb;
    });

    const testruns = (board.testruns ?? []).slice().reverse();
    const checkpoints = this.collectCheckpoints(board.suites, testruns);
    const projectId = this.data?.project || board.project || this.currentProject;

    const selectedItem =
      sprintItems.find((i) => i.id === this.selectedItemId) ??
      items.find((i) => i.id === this.selectedItemId) ??
      null;

    this.root.innerHTML = `
      <div class="board-view">
        <div class="board-header card">
          <div class="board-head-top">
            <div>
              <h2>${escHtml(board.milestone?.name || projectId || "Agile Sprint Board")}</h2>
              <p class="board-goal">
                <span class="pill dispatch">${escHtml(activeSprint)}</span>
                ${sprintMeta?.goal ? escHtml(sprintMeta.goal) : "Multi-agent Kanban workflow with server-enforced QA gates"}
              </p>
            </div>
            <div class="board-head-actions">
              <button
                type="button"
                class="btn-secondary"
                data-board-refresh
                ${this.loading ? "disabled" : ""}
              >${this.loading ? "Refreshing…" : "↻ Refresh"}</button>
              <button type="button" class="btn-primary" data-jump-studio>● Live Studio</button>
            </div>
          </div>

          <div class="kpi-strip" aria-label="Sprint metrics">
            <div class="kpi-card"><span>In Progress</span><b>${(counts.design ?? 0) + (counts.dev ?? 0)}</b></div>
            <div class="kpi-card"><span>In QA / Test</span><b>${counts.test ?? 0}</b></div>
            <div class="kpi-card"><span>Done</span><b class="kpi-ok">${counts.done ?? 0}</b></div>
            <div class="kpi-card"><span>Open Bugs</span><b class="${openBugs.length > 0 ? "kpi-err" : "kpi-ok"}">${openBugs.length}</b></div>
          </div>
        </div>

        <div class="board-split">
          <div class="board-main-col">
            <div class="kanban-stage-jumps" role="group" aria-label="Jump to Kanban column">
              ${KANBAN_COLUMNS.map(
                (col) => `
                  <button type="button" class="stage-jump-btn" data-jump-col="${col.state}">
                    <i class="sw" style="background:${col.accent}" aria-hidden="true"></i>
                    <span>${escHtml(col.label)}</span>
                    <span>(${counts[col.state] ?? 0})</span>
                  </button>
                `
              ).join("")}
            </div>
            <div
              class="kanban-scroll"
              role="region"
              tabindex="0"
              aria-label="5-column sprint Kanban board"
            >
              <div class="kanban-grid">
                ${KANBAN_COLUMNS.map((col) => {
                  const colItems = sprintItems.filter((it) => it.state === col.state);
                  return `
                    <section class="kanban-col" data-kanban-col="${col.state}" aria-label="${escHtml(col.label)} column">
                      <header class="kanban-col-head">
                        <span class="kanban-col-title">
                          <i class="sw" style="background:${col.accent}"></i>
                          ${escHtml(col.label)}
                        </span>
                        <span class="kanban-col-cnt">${colItems.length}</span>
                      </header>
                      <div class="kanban-col-body">
                        ${
                          colItems.length === 0
                            ? `<div class="kanban-empty">No items</div>`
                            : colItems
                                .map((it) => this.renderKanbanCard(it, it.id === this.selectedItemId))
                                .join("")
                        }
                      </div>
                    </section>
                  `;
                }).join("")}
              </div>
            </div>
          </div>

          <aside class="board-side-col">
            ${
              selectedItem
                ? this.renderItemDetail(selectedItem)
                : `<section class="card board-panel">
                    <div class="card-head"><span class="card-title">Item Inspector</span></div>
                    <div class="board-panel-body muted">Click any Kanban card or bug to view acceptance criteria, dependencies, and notes.</div>
                   </section>`
            }

            <section class="card board-panel">
              <div class="card-head">
                <span class="card-title">Open Bugs (${openBugs.length})</span>
                <span class="muted">Sorted by severity</span>
              </div>
              <div class="board-panel-body">
                ${
                  openBugs.length === 0
                    ? `<div class="issue-row ok">✓ Zero open bugs on board</div>`
                    : openBugs
                        .map(
                          (b) => `
                            <button type="button" class="bug-row" data-item-id="${escHtml(b.id)}">
                              <span class="sev-badge sev-${escHtml((b.severity || "S4").toLowerCase())}">${escHtml(b.severity || "BUG")}</span>
                              <span class="bug-id">${escHtml(b.id)}</span>
                              <span class="bug-title">${escHtml(trunc(b.title, 62))}</span>
                              <span class="pill tool">${escHtml(b.state)}</span>
                            </button>
                          `
                        )
                        .join("")
                }
              </div>
            </section>

            <section class="card board-panel">
              <div class="card-head">
                <span class="card-title">Testrun Checkpoint Matrix</span>
                <span class="muted">${testruns.length} runs</span>
              </div>
              <div class="board-panel-body">
                ${this.renderTestrunMatrix(testruns, checkpoints)}
              </div>
            </section>
          </aside>
        </div>
      </div>
    `;

    this.root.querySelector("[data-board-refresh]")?.addEventListener("click", () => {
      void this.load(this.currentProject);
    });
    this.root.querySelector("[data-jump-studio]")?.addEventListener("click", () => {
      this.cb.onJumpToLiveStudio(projectId || "");
    });
    this.root.querySelectorAll<HTMLButtonElement>("[data-jump-col]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const st = btn.dataset.jumpCol;
        const col = st
          ? this.root.querySelector<HTMLElement>(`[data-kanban-col="${st}"]`)
          : null;
        col?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>("[data-item-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.itemId ?? null;
        this.selectedItemId = this.selectedItemId === id ? null : id;
        this.render();
      });
    });

    const boardViewEl = this.root.querySelector<HTMLElement>(".board-view");
    if (boardViewEl && prevScrollTop > 0) boardViewEl.scrollTop = prevScrollTop;
    const kanbanScrollEl = this.root.querySelector<HTMLElement>(".kanban-scroll");
    if (kanbanScrollEl && prevKanbanLeft > 0) kanbanScrollEl.scrollLeft = prevKanbanLeft;
  }

  private renderKanbanCard(item: BoardItem, selected: boolean): string {
    const deps = item.deps ?? [];
    return `
      <button
        type="button"
        class="k-card ${selected ? "selected" : ""} type-${escHtml(item.type)}"
        data-item-id="${escHtml(item.id)}"
      >
        <div class="k-card-top">
          <span class="k-id">${escHtml(item.id)}</span>
          ${item.severity ? `<span class="sev-badge sev-${escHtml(item.severity.toLowerCase())}">${escHtml(item.severity)}</span>` : ""}
          <span class="k-role">${escHtml(item.role)}</span>
        </div>
        <div class="k-title">${escHtml(item.title)}</div>
        ${
          deps.length > 0 || item.owner
            ? `<div class="k-meta">
                ${item.owner ? `<span class="k-owner">@${escHtml(item.owner)}</span>` : ""}
                ${deps.map((d) => `<span class="dep-tag">↳ ${escHtml(d)}</span>`).join("")}
              </div>`
            : ""
        }
      </button>
    `;
  }

  private renderItemDetail(item: BoardItem): string {
    const ac = item.ac ?? [];
    const deps = item.deps ?? [];
    const notes = item.notes ?? [];
    return `
      <section class="card board-panel">
        <div class="card-head">
          <span class="card-title">${escHtml(item.id)} · ${escHtml(item.type.toUpperCase())}</span>
          <span class="pill dispatch">${escHtml(item.state)}</span>
        </div>
        <div class="board-panel-body item-detail-body">
          <div class="item-detail-title">${escHtml(item.title)}</div>
          <div class="item-detail-meta">
            <span>Role: <b>${escHtml(item.role)}</b></span>
            ${item.owner ? `<span>Owner: <b>${escHtml(item.owner)}</b></span>` : ""}
            ${item.suite ? `<span>Suite: <b>${escHtml(item.suite)}</b></span>` : ""}
          </div>
          ${
            deps.length > 0
              ? `<div class="dep-row">${deps.map((d) => `<span class="dep-tag">Depends on ${escHtml(d)}</span>`).join("")}</div>`
              : ""
          }
          ${
            ac.length > 0
              ? `<div class="item-sub-hdr">Acceptance Criteria</div>
                 <ul class="item-list">${ac.map((a) => `<li>${escHtml(a)}</li>`).join("")}</ul>`
              : ""
          }
          ${
            notes.length > 0
              ? `<div class="item-sub-hdr">Notes</div>
                 <ul class="item-list">${notes.slice(-5).map((n) => `<li>${escHtml(n)}</li>`).join("")}</ul>`
              : ""
          }
        </div>
      </section>
    `;
  }

  private collectCheckpoints(
    suites: Record<string, string[]> | undefined,
    runs: TestrunRecord[]
  ): string[] {
    const set = new Set<string>(["CP0", "CP1", "CP2"]);
    if (suites) {
      for (const list of Object.values(suites)) {
        for (const cp of list) set.add(cp);
      }
    }
    for (const r of runs) {
      for (const cp of Object.keys(r.results ?? {})) set.add(cp);
    }
    return Array.from(set).sort();
  }

  private renderTestrunMatrix(runs: TestrunRecord[], checkpoints: string[]): string {
    if (runs.length === 0) {
      return `<div class="empty-state">No testruns recorded yet.</div>`;
    }
    const recent = runs.slice(0, 8);
    return `
      <div class="table-scroll" role="region" tabindex="0" aria-label="Testrun checkpoint matrix">
        <table class="cp-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Suite</th>
              <th>Status</th>
              ${checkpoints.map((cp) => `<th>${escHtml(cp)}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${recent
              .map(
                (r) => `
                  <tr>
                    <td><code>${escHtml(r.id)}</code></td>
                    <td>${escHtml(r.suite)}</td>
                    <td><span class="cp-badge cp-${escHtml(r.status)}">${escHtml(r.status.toUpperCase())}</span></td>
                    ${checkpoints
                      .map((cp) => {
                        const val = r.results?.[cp];
                        if (!val) return `<td class="cp-empty">—</td>`;
                        const cls = val.toLowerCase().startsWith("pass")
                          ? "passed"
                          : val.toLowerCase().startsWith("fail")
                            ? "failed"
                            : "running";
                        return `<td><span class="cp-badge cp-${cls}">${escHtml(val.toUpperCase())}</span></td>`;
                      })
                      .join("")}
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }
}
