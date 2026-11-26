import {
  fetchFeedbackStatus,
  openFeedbackExternalUrl,
  submitFeedbackIssue,
} from "../api.js";
import type {
  FeedbackCategory,
  FeedbackDiagnostics,
  FeedbackStatusResponse,
} from "../types.js";
import { copyTextSafe, escHtml } from "../utils.js";
import {
  buildPrefilledIssueUrl,
  FEEDBACK_CATEGORY_META,
  FEEDBACK_GITHUB_OWNER,
  FEEDBACK_GITHUB_REPO,
  formatFeedbackMarkdown,
  formatFeedbackTitle,
  sanitizeClientDiagnostics,
} from "../utils/feedbackUrl.js";

export interface FeedbackDialogOptions {
  embedMode: boolean;
  mcpAppMode?: boolean;
}

const CATEGORY_OPTIONS: Array<{
  id: Extract<FeedbackCategory, "bug" | "feature" | "telemetry">;
  label: string;
  githubLabel: string;
}> = [
  { id: "bug", label: "Bug", githubLabel: "bug" },
  { id: "feature", label: "Feature", githubLabel: "enhancement" },
  { id: "telemetry", label: "Telemetry", githubLabel: "telemetry" },
];

export class FeedbackDialog {
  private dialog: HTMLDialogElement;
  private form: HTMLFormElement;
  private titleInput: HTMLInputElement;
  private bodyInput: HTMLTextAreaElement;
  private diagCheckbox: HTMLInputElement;
  private bodyCountEl: HTMLElement;
  private diagSummaryEl: HTMLElement;
  private previewMetaEl: HTMLElement;
  private previewPreEl: HTMLElement;
  private errorBoxEl: HTMLElement;
  private formPanelEl: HTMLElement;
  private successPanelEl: HTMLElement;
  private footEl: HTMLElement;
  private announcerEl: HTMLElement;

  private embedMode: boolean;
  private mcpAppMode: boolean;
  private diagnostics: FeedbackDiagnostics = {};
  private status: FeedbackStatusResponse = {
    ok: true,
    repo: `${FEEDBACK_GITHUB_OWNER}/${FEEDBACK_GITHUB_REPO}`,
    directAvailable: false,
    method: "none",
    newIssueUrl: `https://github.com/${FEEDBACK_GITHUB_OWNER}/${FEEDBACK_GITHUB_REPO}/issues/new`,
  };
  private statusLoading = false;
  private submitting = false;
  private submittedResult: {
    issueUrl: string;
    issueNumber?: number;
  } | null = null;
  private fallbackError: {
    reason: string;
    prefillUrl: string;
    truncated: boolean;
  } | null = null;
  private interactedFields = new WeakSet<HTMLElement>();
  private openSeq = 0;
  private announceTimer: number | null = null;

  constructor(opts: FeedbackDialogOptions) {
    this.embedMode = opts.embedMode;
    this.mcpAppMode = Boolean(opts.mcpAppMode);

    const dlg = document.createElement("dialog");
    dlg.className = "feedback-dialog";
    dlg.setAttribute("closedby", "any");
    dlg.setAttribute("aria-labelledby", "fbDialogTitle");
    dlg.innerHTML = `
      <div class="insp-sheet-shell fb-shell">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="insp-sheet-head fb-sheet-head">
          <div class="insp-title-row">
            <h1 class="insp-title fb-dialog-h1" id="fbDialogTitle">Send Feedback</h1>
            <span class="pill dispatch">${escHtml(FEEDBACK_GITHUB_OWNER)}/${escHtml(FEEDBACK_GITHUB_REPO)}</span>
          </div>
          <div class="insp-head-actions">
            <button type="button" class="insp-icon-btn" data-fb-close aria-label="Close feedback dialog">✕</button>
          </div>
        </div>

        <form class="fb-form" novalidate data-fb-form>
          <div class="insp-sheet-body fb-sheet-body">
            <div class="fb-banner" role="note">
              Posts <strong>exclusively</strong> to <code>jakehesson/agent-studio</code> GitHub Issues (no other repo or action). Sends your title, description, category label, and — only if checked — sanitized diagnostics (version, host IDE/mode, active model, token/context summary, agent/event counts, OS platform). <strong>No source code, file paths, prompts, tool outputs, or credentials are ever included.</strong>
            </div>

            <div class="fb-form-panel" data-fb-form-panel>
              <fieldset class="fb-fieldset">
                <legend class="fb-legend">Category</legend>
                <div class="fb-cat-group">
                  ${CATEGORY_OPTIONS.map(
                    (c, idx) => `
                      <label class="fb-cat-pill">
                        <input
                          type="radio"
                          class="sr-only"
                          name="fbCategory"
                          value="${c.id}"
                          ${idx === 0 ? "checked" : ""}
                        />
                        <span>${escHtml(c.label)}</span>
                      </label>
                    `
                  ).join("")}
                </div>
              </fieldset>

              <div class="fb-field">
                <label class="fb-label" for="fbTitle">Title</label>
                <input
                  type="text"
                  id="fbTitle"
                  name="title"
                  class="fb-input"
                  autofocus
                  required
                  maxlength="200"
                  aria-invalid="false"
                  data-error="fbTitleError"
                  placeholder="Concise summary of the bug, feature, or telemetry note"
                />
                <div id="fbTitleError" class="fb-field-error">
                  <span aria-hidden="true">⚠</span> Error: Please enter a title (1–200 characters).
                </div>
              </div>

              <div class="fb-field">
                <div class="fb-label-row">
                  <label class="fb-label" for="fbBody">Description</label>
                  <span class="fb-char-count" data-fb-body-count>0 / 4000</span>
                </div>
                <textarea
                  id="fbBody"
                  name="description"
                  class="fb-textarea"
                  required
                  rows="5"
                  maxlength="4000"
                  aria-invalid="false"
                  data-error="fbBodyError"
                  placeholder="Steps to reproduce, expected vs. actual behavior, or details…"
                ></textarea>
                <div id="fbBodyError" class="fb-field-error">
                  <span aria-hidden="true">⚠</span> Error: Please enter a description (1–4000 characters).
                </div>
              </div>

              <div class="fb-diag-box">
                <label class="fb-diag-toggle" for="fbIncludeDiag">
                  <input type="checkbox" id="fbIncludeDiag" checked />
                  <span>Include sanitized environment diagnostics</span>
                </label>
                <div class="fb-diag-summary" data-fb-diag-summary></div>
                <details class="fb-preview-details" data-fb-preview-details>
                  <summary class="fb-preview-summary">Preview exact payload</summary>
                  <div class="fb-preview-wrap">
                    <div class="fb-preview-meta" data-fb-preview-meta></div>
                    <pre class="fb-preview-pre" role="region" tabindex="0" aria-label="Payload preview" data-fb-preview></pre>
                  </div>
                </details>
              </div>

              <div class="fb-error-box" role="alert" data-fb-error-box hidden></div>
            </div>

            <div class="fb-success-panel" role="status" data-fb-success-panel hidden></div>
            <div class="sr-only" aria-live="polite" data-fb-announcer></div>
          </div>

          <div class="fb-sheet-foot" data-fb-foot></div>
        </form>
      </div>
    `;

    document.body.appendChild(dlg);
    this.dialog = dlg;
    this.form = dlg.querySelector("[data-fb-form]") as HTMLFormElement;
    this.titleInput = dlg.querySelector("#fbTitle") as HTMLInputElement;
    this.bodyInput = dlg.querySelector("#fbBody") as HTMLTextAreaElement;
    this.diagCheckbox = dlg.querySelector("#fbIncludeDiag") as HTMLInputElement;
    this.bodyCountEl = dlg.querySelector("[data-fb-body-count]") as HTMLElement;
    this.diagSummaryEl = dlg.querySelector("[data-fb-diag-summary]") as HTMLElement;
    this.previewMetaEl = dlg.querySelector("[data-fb-preview-meta]") as HTMLElement;
    this.previewPreEl = dlg.querySelector("[data-fb-preview]") as HTMLElement;
    this.errorBoxEl = dlg.querySelector("[data-fb-error-box]") as HTMLElement;
    this.formPanelEl = dlg.querySelector("[data-fb-form-panel]") as HTMLElement;
    this.successPanelEl = dlg.querySelector("[data-fb-success-panel]") as HTMLElement;
    this.footEl = dlg.querySelector("[data-fb-foot]") as HTMLElement;
    this.announcerEl = dlg.querySelector("[data-fb-announcer]") as HTMLElement;

    // Light-dismiss fallback for browsers without HTMLDialogElement.prototype.closedBy (Safari)
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const isOutside = (e: PointerEvent): boolean => {
        const r = dlg.getBoundingClientRect();
        return (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        );
      };
      dlg.addEventListener("pointerdown", (e) => {
        pressedOutside = isOutside(e);
      });
      dlg.addEventListener("pointerup", (e) => {
        if (pressedOutside && isOutside(e)) {
          dlg.close();
        }
        pressedOutside = false;
      });
    }

    dlg.addEventListener("close", () => {
      dlg.returnValue = "";
      this.openSeq += 1;
      this.submitting = false;
      if (this.submittedResult) {
        this.resetForm();
      }
    });

    dlg.querySelector("[data-fb-close]")?.addEventListener("click", () => dlg.close());

    this.bindFormEvents();
  }

  public setRuntimeScope(opts: FeedbackDialogOptions): void {
    this.embedMode = opts.embedMode;
    this.mcpAppMode = Boolean(opts.mcpAppMode);
  }

  public dispose(): void {
    if (this.announceTimer != null) {
      window.clearTimeout(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
  }

  public open(diagnostics: FeedbackDiagnostics): void {
    this.diagnostics = sanitizeClientDiagnostics({
      ...diagnostics,
      embedMode: this.embedMode,
    });

    if (this.submittedResult) {
      this.resetForm();
    } else {
      this.fallbackError = null;
      this.renderErrorBox();
    }

    this.renderDiagnosticsSummary();
    this.updatePreview();
    this.renderStatePanels();
    this.renderFooter();

    if (!this.dialog.open) {
      this.dialog.showModal();
    }

    window.requestAnimationFrame(() => {
      if (this.dialog.open && !this.submittedResult) {
        this.titleInput.focus({ preventScroll: true });
      }
    });

    const seq = ++this.openSeq;
    this.statusLoading = true;
    this.renderFooter();
    void fetchFeedbackStatus(this.embedMode).then((res) => {
      if (seq !== this.openSeq) return;
      this.status = res;
      this.statusLoading = false;
      if (res.appVersion && !this.diagnostics.appVersion) {
        this.diagnostics = sanitizeClientDiagnostics({
          ...this.diagnostics,
          appVersion: res.appVersion,
        });
        this.renderDiagnosticsSummary();
        this.updatePreview();
      }
      this.renderFooter();
    });
  }

  private bindFormEvents(): void {
    this.form.querySelectorAll<HTMLInputElement>('input[name="fbCategory"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        this.updatePreview();
      });
    });

    const handleFieldInput = (el: HTMLInputElement | HTMLTextAreaElement) => {
      this.interactedFields.add(el);
      el.setCustomValidity("");
      this.clearFieldInvalid(el);
      if (el === this.bodyInput) {
        this.bodyCountEl.textContent = `${this.bodyInput.value.length} / 4000`;
      }
      this.updatePreview();
    };

    this.titleInput.addEventListener("input", () => handleFieldInput(this.titleInput));
    this.bodyInput.addEventListener("input", () => handleFieldInput(this.bodyInput));

    this.titleInput.addEventListener("blur", () => {
      if (this.interactedFields.has(this.titleInput)) {
        this.validateField(this.titleInput, true);
      }
    });
    this.bodyInput.addEventListener("blur", () => {
      if (this.interactedFields.has(this.bodyInput)) {
        this.validateField(this.bodyInput, true);
      }
    });

    this.diagCheckbox.addEventListener("change", () => {
      this.renderDiagnosticsSummary();
      this.updatePreview();
    });

    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.submitting || this.submittedResult) return;
      if (this.status.directAvailable) {
        void this.handleDirectSubmit();
      } else {
        void this.handleOpenPrefillSubmit();
      }
    });

    this.footEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-fb-open-prefill]")) {
        void this.handleOpenPrefillSubmit();
      } else if (target.closest("[data-fb-done]")) {
        this.dialog.close();
      } else if (target.closest("[data-fb-reset]")) {
        this.resetForm();
        this.renderStatePanels();
        this.renderFooter();
        this.titleInput.focus();
      }
    });

    this.errorBoxEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const openBtn = target.closest<HTMLButtonElement>("[data-fb-fallback-open]");
      if (openBtn && this.fallbackError) {
        void openFeedbackExternalUrl(this.fallbackError.prefillUrl, this.embedMode);
        return;
      }
      const copyBtn = target.closest<HTMLButtonElement>("[data-fb-copy-md]");
      if (copyBtn) {
        void this.handleCopyMarkdown(copyBtn);
      }
    });

    this.successPanelEl.addEventListener("click", (e) => {
      const link = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
        "[data-fb-issue-link]"
      );
      if (!link) return;
      if (this.mcpAppMode || this.embedMode) {
        e.preventDefault();
        void openFeedbackExternalUrl(link.href, this.embedMode);
      }
    });
  }

  private getSelectedCategory(): FeedbackCategory {
    const checked = this.form.querySelector<HTMLInputElement>(
      'input[name="fbCategory"]:checked'
    );
    const val = checked?.value;
    if (val === "feature" || val === "telemetry" || val === "question") return val;
    return "bug";
  }

  private linkErrorDescribedBy(el: HTMLElement, shown: boolean): void {
    const errorId = el.dataset.error;
    if (!errorId) return;
    const ids = (el.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((id) => id && id !== errorId);
    if (shown) ids.push(errorId);
    if (ids.length > 0) el.setAttribute("aria-describedby", ids.join(" "));
    else el.removeAttribute("aria-describedby");
  }

  private clearFieldInvalid(el: HTMLInputElement | HTMLTextAreaElement): void {
    el.classList.remove("fb-invalid");
    el.setAttribute("aria-invalid", "false");
    this.linkErrorDescribedBy(el, false);
  }

  private validateField(
    el: HTMLInputElement | HTMLTextAreaElement,
    announce: boolean
  ): boolean {
    const trimmed = el.value.trim();
    if (trimmed.length === 0) {
      el.setCustomValidity("Please enter non-whitespace text.");
    } else {
      el.setCustomValidity("");
    }
    const valid = el.validity.valid;
    if (!valid) {
      el.classList.add("fb-invalid");
      el.setAttribute("aria-invalid", "true");
      this.linkErrorDescribedBy(el, true);
      if (announce) {
        const errorId = el.dataset.error;
        const msg = errorId ? this.form.querySelector(`#${errorId}`)?.textContent?.trim() : "";
        if (msg) this.announcePolite(msg);
      }
    } else {
      this.clearFieldInvalid(el);
    }
    return valid;
  }

  private validateAll(): boolean {
    const titleValid = this.validateField(this.titleInput, false);
    const bodyValid = this.validateField(this.bodyInput, false);
    if (!titleValid) {
      this.titleInput.focus();
      return false;
    }
    if (!bodyValid) {
      this.bodyInput.focus();
      return false;
    }
    return true;
  }

  private announcePolite(msg: string): void {
    if (this.announceTimer != null) window.clearTimeout(this.announceTimer);
    this.announcerEl.textContent = "";
    this.announceTimer = window.setTimeout(() => {
      this.announcerEl.textContent = msg;
    }, 250);
  }

  private getCurrentPayload() {
    const category = this.getSelectedCategory();
    const includeDiagnostics = this.diagCheckbox.checked;
    return {
      category,
      title: this.titleInput.value.trim().slice(0, 200),
      description: this.bodyInput.value.trim().slice(0, 4000),
      includeDiagnostics,
      diagnostics: includeDiagnostics ? this.diagnostics : undefined,
    };
  }

  private renderDiagnosticsSummary(): void {
    if (!this.diagCheckbox.checked) {
      this.diagSummaryEl.textContent = "Diagnostics excluded — only title, category, and description will be sent.";
      return;
    }
    const d = this.diagnostics;
    const chips: string[] = [];
    if (d.appVersion) chips.push(`v${d.appVersion}`);
    if (d.ide) chips.push(`IDE: ${d.ide}`);
    if (d.embedMode !== undefined) chips.push(d.embedMode ? "embed=1" : this.mcpAppMode ? "mcp-app" : "standalone");
    if (d.model) chips.push(`model: ${d.model}`);
    if (d.contextPercent !== undefined) chips.push(`ctx: ${d.contextPercent}%`);
    if (d.agentCount !== undefined) chips.push(`${d.agentCount} agents`);
    if (d.eventCount !== undefined) chips.push(`${d.eventCount} events`);
    this.diagSummaryEl.textContent =
      chips.length > 0 ? chips.join(" · ") : "No active session telemetry captured.";
  }

  private updatePreview(): void {
    const payload = this.getCurrentPayload();
    const meta = FEEDBACK_CATEGORY_META[payload.category] ?? FEEDBACK_CATEGORY_META.bug;
    const formattedTitle = formatFeedbackTitle(payload.category, payload.title || "(title)");
    const markdown = formatFeedbackMarkdown({
      description: payload.description,
      includeDiagnostics: payload.includeDiagnostics,
      diagnostics: payload.diagnostics,
    });
    const built = buildPrefilledIssueUrl(payload);

    this.previewMetaEl.innerHTML = `
      <span>Target: <code>${escHtml(FEEDBACK_GITHUB_OWNER)}/${escHtml(FEEDBACK_GITHUB_REPO)}</code></span>
      <span>Title: <code>${escHtml(formattedTitle)}</code></span>
      <span>Label: <code>${escHtml(meta.githubLabel)}</code></span>
      ${built.truncated ? `<span class="fb-trunc-tag">URL pre-fill truncated &gt;6000 chars</span>` : ""}
    `;
    this.previewPreEl.textContent = markdown;
  }

  private async handleDirectSubmit(): Promise<void> {
    if (!this.validateAll()) return;
    const reqSeq = this.openSeq;
    const payload = this.getCurrentPayload();
    this.submitting = true;
    this.fallbackError = null;
    this.renderErrorBox();
    this.renderFooter();

    const res = await submitFeedbackIssue(payload, {
      embedMode: this.embedMode,
      preferredMethod: this.status.method,
    });
    if (reqSeq !== this.openSeq) return;

    this.submitting = false;

    if (res.ok && res.mode === "created" && res.issueUrl) {
      this.submittedResult = {
        issueUrl: res.issueUrl,
        issueNumber: res.issueNumber,
      };
      this.renderStatePanels();
      this.renderFooter();
      return;
    }

    const built = buildPrefilledIssueUrl(payload);
    this.fallbackError = {
      reason:
        res.reason ||
        "Direct GitHub issue submission failed. You can open the pre-filled issue on GitHub or copy the Markdown below.",
      prefillUrl: res.prefillUrl || built.url,
      truncated: built.truncated,
    };
    this.renderErrorBox();
    this.renderFooter();
  }

  private async handleOpenPrefillSubmit(): Promise<void> {
    if (!this.validateAll()) return;
    const payload = this.getCurrentPayload();
    const built = buildPrefilledIssueUrl(payload);
    const opened = await openFeedbackExternalUrl(built.url, this.embedMode);
    if (!opened || built.truncated) {
      this.fallbackError = {
        reason: !opened
          ? "Your browser or host blocked opening a new tab. Use the link or Copy Markdown below."
          : "Your feedback exceeded GitHub's URL length limit, so the browser pre-fill was truncated. Use Copy Markdown to paste full details.",
        prefillUrl: built.url,
        truncated: built.truncated,
      };
      this.renderErrorBox();
    }
  }

  private async handleCopyMarkdown(btn: HTMLButtonElement): Promise<void> {
    const payload = this.getCurrentPayload();
    const title = formatFeedbackTitle(payload.category, payload.title);
    const md = formatFeedbackMarkdown({
      description: payload.description,
      includeDiagnostics: payload.includeDiagnostics,
      diagnostics: payload.diagnostics,
    });
    const fullText = `# ${title}\n\n${md}`;
    const ok = await copyTextSafe(fullText);
    btn.textContent = ok ? "Copied ✓" : "Copy failed";
    btn.classList.toggle("copied", ok);
    if (ok) this.announcePolite("Copied feedback Markdown to clipboard.");
    window.setTimeout(() => {
      btn.textContent = "Copy Markdown";
      btn.classList.remove("copied");
    }, 1800);
  }

  private resetForm(): void {
    this.form.reset();
    this.interactedFields = new WeakSet<HTMLElement>();
    this.clearFieldInvalid(this.titleInput);
    this.clearFieldInvalid(this.bodyInput);
    this.titleInput.setCustomValidity("");
    this.bodyInput.setCustomValidity("");
    this.diagCheckbox.checked = true;
    this.bodyCountEl.textContent = "0 / 4000";
    this.submittedResult = null;
    this.fallbackError = null;
    this.submitting = false;
    this.renderErrorBox();
    this.renderDiagnosticsSummary();
    this.updatePreview();
  }

  private renderStatePanels(): void {
    if (this.submittedResult) {
      this.formPanelEl.hidden = true;
      this.successPanelEl.hidden = false;
      const numLabel = this.submittedResult.issueNumber
        ? `Issue #${this.submittedResult.issueNumber}`
        : "GitHub Issue";
      this.successPanelEl.innerHTML = `
        <div class="fb-success-badge" aria-hidden="true">✓</div>
        <h2 class="fb-success-title">${escHtml(numLabel)} Created</h2>
        <p class="fb-success-copy">
          Your feedback has been posted to <code>${escHtml(FEEDBACK_GITHUB_OWNER)}/${escHtml(FEEDBACK_GITHUB_REPO)}</code>.
        </p>
        <a
          class="btn-secondary fb-issue-link"
          href="${escHtml(this.submittedResult.issueUrl)}"
          target="_blank"
          rel="noopener noreferrer"
          data-fb-issue-link
        >View ${escHtml(numLabel)} on GitHub ↗</a>
      `;
    } else {
      this.formPanelEl.hidden = false;
      this.successPanelEl.hidden = true;
      this.successPanelEl.innerHTML = "";
    }
  }

  private renderErrorBox(): void {
    if (!this.fallbackError) {
      this.errorBoxEl.hidden = true;
      this.errorBoxEl.innerHTML = "";
      return;
    }
    this.errorBoxEl.hidden = false;
    this.errorBoxEl.innerHTML = `
      <div class="fb-error-title">Fallback Required</div>
      <p class="fb-error-msg">${escHtml(this.fallbackError.reason)}</p>
      ${
        this.fallbackError.truncated
          ? `<p class="fb-error-warn">Note: Pre-filled URL was truncated at 6000 characters. Click <strong>Copy Markdown</strong> to paste the complete diagnostics.</p>`
          : ""
      }
      <div class="fb-error-actions">
        <button type="button" class="btn-primary btn-sm" data-fb-fallback-open>Open Pre-filled Issue on GitHub</button>
        <button type="button" class="btn-secondary btn-sm" data-fb-copy-md>Copy Markdown</button>
      </div>
    `;
  }

  private renderFooter(): void {
    if (this.submittedResult) {
      this.footEl.innerHTML = `
        <div class="fb-foot-hint">Posted to ${escHtml(FEEDBACK_GITHUB_OWNER)}/${escHtml(FEEDBACK_GITHUB_REPO)}</div>
        <div class="fb-foot-actions">
          <button type="button" class="btn-secondary" data-fb-reset>Submit Another</button>
          <button type="button" class="btn-primary" data-fb-done>Done</button>
        </div>
      `;
      return;
    }

    const methodHint = this.statusLoading
      ? "Checking GitHub connection…"
      : this.status.directAvailable
        ? this.status.method === "vscode-github"
          ? `Direct via VS Code GitHub${this.status.accountLabel ? ` (@${this.status.accountLabel})` : ""}`
          : this.status.method === "github-token"
            ? "Direct via GitHub token"
            : "Direct via gh CLI"
        : "Opens pre-filled issue in GitHub";

    const disabledAttr = this.submitting ? "disabled" : "";
    const busyAttr = this.submitting ? 'aria-busy="true"' : "";

    if (this.status.directAvailable) {
      this.footEl.innerHTML = `
        <div class="fb-foot-hint">${escHtml(methodHint)}</div>
        <div class="fb-foot-actions">
          <button type="button" class="btn-secondary" data-fb-open-prefill ${disabledAttr}>Open on GitHub instead</button>
          <button type="submit" class="btn-primary" data-fb-submit ${disabledAttr} ${busyAttr}>
            ${this.submitting ? "Submitting…" : "Submit GitHub Issue"}
          </button>
        </div>
      `;
    } else {
      this.footEl.innerHTML = `
        <div class="fb-foot-hint">${escHtml(methodHint)}</div>
        <div class="fb-foot-actions">
          <button type="submit" class="btn-primary" data-fb-submit ${disabledAttr} ${busyAttr}>
            Open Pre-filled Issue on GitHub
          </button>
        </div>
      `;
    }
  }
}
