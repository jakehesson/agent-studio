import { fetchMockups, postMockupFeedback } from "../api.js";
import type { MockupEntry } from "../types.js";
import { escHtml } from "../utils.js";
import { attachPanelResizer, type PanelResizerHandle } from "../utils/panelResizer.js";

type ViewportPreset = "cover" | "open" | "desktop";

const PRESETS: Array<{ id: ViewportPreset; label: string; width: string }> = [
  { id: "cover", label: "Fold Cover (390px)", width: "390px" },
  { id: "open", label: "Fold Open (780px)", width: "780px" },
  { id: "desktop", label: "Desktop (100%)", width: "100%" },
];

export class MockupsView {
  private root: HTMLElement;
  private currentProject = "";
  private currentWorkspace = "";
  private mockups: MockupEntry[] = [];
  private selectedId: string | null = null;
  private preset: ViewportPreset = "desktop";
  private loading = false;
  private errorMsg: string | null = null;
  private feedbackStatus: string | null = null;
  private mockupsResizer: PanelResizerHandle | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.render();
  }

  public dispose(): void {
    this.mockupsResizer?.destroy();
    this.mockupsResizer = null;
  }

  public async load(
    projectId: string,
    selectedId?: string,
    workspace?: string
  ): Promise<void> {
    this.currentProject = projectId;
    if (workspace !== undefined) this.currentWorkspace = workspace;
    if (selectedId !== undefined) this.selectedId = selectedId;
    this.loading = true;
    this.errorMsg = null;
    this.render();
    try {
      const res = await fetchMockups(
        projectId || undefined,
        this.selectedId || undefined,
        this.currentWorkspace || undefined
      );
      this.mockups = res.mockups;
      if (!this.mockups.some((m) => m.id === this.selectedId)) {
        this.selectedId = this.mockups[0]?.id ?? null;
        if (this.selectedId) {
          const hydrated = await fetchMockups(
            projectId || undefined,
            this.selectedId,
            this.currentWorkspace || undefined
          );
          this.mockups = hydrated.mockups;
        }
      }
    } catch (err) {
      this.errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    this.mockupsResizer?.destroy();
    this.mockupsResizer = null;
    if (this.loading && this.mockups.length === 0) {
      this.root.innerHTML = `<div class="view-placeholder">Discovering project HTML mockups…</div>`;
      return;
    }

    if (this.errorMsg && this.mockups.length === 0) {
      this.root.innerHTML = `
        <div class="view-empty-wrap">
          <div class="view-empty-card">
            <h2>Mockups Gallery Unavailable</h2>
            <p>${escHtml(this.errorMsg)}</p>
            <button type="button" class="btn-primary" data-mockups-retry>Retry</button>
          </div>
        </div>
      `;
      this.root
        .querySelector("[data-mockups-retry]")
        ?.addEventListener("click", () => void this.load(this.currentProject));
      return;
    }

    if (this.mockups.length === 0) {
      this.root.innerHTML = `
        <div class="view-empty-wrap">
          <div class="view-empty-card">
            <h2>No HTML Mockups Found</h2>
            <p class="muted">Add interactive HTML prototypes under your project's <code>docs/mockups/</code> directory (configured in <code>.agent-team/team.yaml</code>) and click refresh.</p>
            <button type="button" class="btn-primary" data-mockups-retry>↻ Refresh Gallery</button>
          </div>
        </div>
      `;
      this.root
        .querySelector("[data-mockups-retry]")
        ?.addEventListener("click", () => void this.load(this.currentProject));
      return;
    }

    const active = this.mockups.find((m) => m.id === this.selectedId) ?? this.mockups[0];
    const presetMeta = PRESETS.find((p) => p.id === this.preset) ?? PRESETS[2]!;
    const iframeUrl = active
      ? active.url || `/api/mockup?id=${encodeURIComponent(active.id)}&t=${active.mtimeMs ?? Date.now()}`
      : "";

    this.root.innerHTML = `
      <div class="mockups-view">
        <aside class="card mockups-sidebar">
          <div class="card-head">
            <span class="card-title">Mockup Gallery (${this.mockups.length})</span>
            <button
              type="button"
              class="btn-secondary btn-sm"
              data-mockups-retry
              ${this.loading ? "disabled" : ""}
              aria-label="Refresh mockups gallery"
            >${this.loading ? "…" : "↻"}</button>
          </div>
          <div class="mockup-list" role="listbox" aria-label="Project mockups">
            ${this.mockups
              .map(
                (m) => `
                  <button
                    type="button"
                    role="option"
                    aria-selected="${m.id === active?.id ? "true" : "false"}"
                    class="mockup-item ${m.id === active?.id ? "active" : ""}"
                    data-mockup-id="${escHtml(m.id)}"
                  >
                    <div class="mockup-item-title">${escHtml(m.title || m.fileName)}</div>
                    <div class="mockup-item-meta">
                      ${m.projectId ? `<span class="s-proj">${escHtml(m.projectId)}</span>` : ""}
                      <span class="muted">${escHtml(m.relPath || m.fileName)}</span>
                    </div>
                  </button>
                `
              )
              .join("")}
          </div>
        </aside>

        <div class="panel-resizer" data-resizer="mockups-sidebar"><span class="panel-resizer-pill" aria-hidden="true"></span></div>

        <section class="card mockups-stage">
          <div class="card-head mockups-stage-head">
            <div>
              <span class="card-title">${escHtml(active?.title || active?.fileName || "Preview")}</span>
            </div>
            <div class="preset-bar" role="group" aria-label="Viewport size presets">
              ${PRESETS.map(
                (p) => `
                  <button
                    type="button"
                    class="preset-btn ${p.id === this.preset ? "active" : ""}"
                    data-preset="${p.id}"
                    aria-pressed="${p.id === this.preset ? "true" : "false"}"
                  >${escHtml(p.label)}</button>
                `
              ).join("")}
            </div>
          </div>

          <div
            class="iframe-stage"
            role="region"
            tabindex="0"
            aria-label="Sandboxed HTML mockup preview"
          >
            ${
              active
                ? `<iframe
                    class="mockup-frame"
                    style="width:${presetMeta.width}"
                    sandbox="allow-scripts allow-same-origin"
                    title="${escHtml(active.title || active.fileName)}"
                    src="${escHtml(iframeUrl)}"
                  ></iframe>`
                : ""
            }
          </div>

          <div class="feedback-dock">
            <div class="feedback-head">
              <span class="card-title">FEEDBACK.md Notes</span>
              <span class="feedback-status" data-feedback-status>${escHtml(this.feedbackStatus ?? "")}</span>
            </div>
            <div data-feedback-log-slot>
              ${
                active?.feedback
                  ? `<pre class="feedback-log">${escHtml(active.feedback)}</pre>`
                  : `<div class="muted feedback-empty">No saved feedback notes for this mockup yet.</div>`
              }
            </div>
            <form class="feedback-form" data-feedback-form>
              <label class="sr-only" for="mockupFeedbackInput">Add design feedback note</label>
              <input
                id="mockupFeedbackInput"
                type="text"
                class="feedback-input"
                data-feedback-input
                placeholder="Append critique to sibling FEEDBACK.md…"
                required
              />
              <button type="submit" class="btn-primary" data-feedback-submit>Save Note</button>
            </form>
          </div>
        </section>
      </div>
    `;

    this.root
      .querySelector("[data-mockups-retry]")
      ?.addEventListener("click", () => void this.load(this.currentProject));

    this.root.querySelectorAll<HTMLButtonElement>("[data-mockup-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextId = btn.dataset.mockupId ?? null;
        if (nextId && nextId !== this.selectedId) {
          this.feedbackStatus = null;
          void this.load(this.currentProject, nextId);
        }
      });
    });

    // Update viewport width & preset button states in place without reloading iframe
    this.root.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = btn.dataset.preset as ViewportPreset | undefined;
        if (!p) return;
        this.preset = p;
        const meta = PRESETS.find((x) => x.id === p) ?? PRESETS[2]!;
        const frame = this.root.querySelector<HTMLIFrameElement>(".mockup-frame");
        if (frame) frame.style.width = meta.width;
        this.root.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => {
          const isAct = b.dataset.preset === p;
          b.classList.toggle("active", isAct);
          b.setAttribute("aria-pressed", isAct ? "true" : "false");
        });
      });
    });

    const updateFeedbackDock = () => {
      const stEl = this.root.querySelector("[data-feedback-status]");
      if (stEl) stEl.textContent = this.feedbackStatus ?? "";
      const logSlot = this.root.querySelector("[data-feedback-log-slot]");
      if (logSlot && active) {
        logSlot.innerHTML = active.feedback
          ? `<pre class="feedback-log">${escHtml(active.feedback)}</pre>`
          : `<div class="muted feedback-empty">No saved feedback notes for this mockup yet.</div>`;
      }
    };

    const form = this.root.querySelector("[data-feedback-form]") as HTMLFormElement | null;
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!active) return;
      const input = this.root.querySelector<HTMLInputElement>("[data-feedback-input]");
      const submitBtn = this.root.querySelector<HTMLButtonElement>("[data-feedback-submit]");
      const note = input?.value.trim() ?? "";
      if (!note) return;
      this.feedbackStatus = "Saving…";
      if (submitBtn) submitBtn.disabled = true;
      updateFeedbackDock();
      try {
        const res = await postMockupFeedback({
          id: active.id,
          note,
          view: this.preset,
        });
        if (res.feedback) active.feedback = res.feedback;
        else {
          active.feedback = `${active.feedback ? `${active.feedback}\n` : ""}- [${this.preset}] ${note}`;
        }
        if (input) input.value = "";
        this.feedbackStatus = "Saved to FEEDBACK.md";
      } catch (err) {
        this.feedbackStatus = `Error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
      updateFeedbackDock();
    });

    const mockupsViewEl = this.root.querySelector<HTMLElement>(".mockups-view");
    const mockupsResizerEl = this.root.querySelector<HTMLElement>(
      '[data-resizer="mockups-sidebar"]'
    );
    const sidebarEl = this.root.querySelector<HTMLElement>(".mockups-sidebar");
    if (mockupsViewEl && mockupsResizerEl && sidebarEl) {
      this.mockupsResizer = attachPanelResizer({
        id: "mockups-sidebar",
        container: mockupsViewEl,
        handle: mockupsResizerEl,
        primaryPane: sidebarEl,
        cssVar: "--mockups-sidebar",
        persistMode: "px",
        minLeft: 180,
        maxLeft: 460,
        minRight: 300,
        hideWhenNoRoom: true,
        ariaLabel: "Resize mockups gallery sidebar and preview stage",
        paneLabel: "Mockups sidebar",
      });
    }
  }
}
