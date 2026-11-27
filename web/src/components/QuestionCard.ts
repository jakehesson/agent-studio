import type {
  PendingHumanPrompt,
  PendingQuestionItem,
  ReplyCapabilities,
  ReplyToHostRequest,
  ReplyToHostResult,
} from "../types.js";
import { cleanSummaryText, copyTextSafe, escHtml } from "../utils.js";

export interface QuestionAnswerDraft {
  selected: string[];
  customOpen: boolean;
  customText: string;
}

export interface PromptDraftState {
  activeIdx: number;
  answers: Record<number, QuestionAnswerDraft>;
}

// Preserved across live SSE refreshes keyed by prompt.id
const promptDraftStore = new Map<string, PromptDraftState>();
let cardInstanceSeq = 0;

export function clearPromptDraft(promptId: string): void {
  promptDraftStore.delete(promptId);
}

export interface QuestionCardOptions {
  prompt: PendingHumanPrompt;
  sessionId?: string;
  compact?: boolean;
  showHeader?: boolean;
  getCapabilities: () => ReplyCapabilities;
  onReply: (req: ReplyToHostRequest) => Promise<ReplyToHostResult>;
  onCancel?: (promptId: string, reason?: string) => Promise<ReplyToHostResult>;
}

export function getEffectiveQuestions(
  prompt: PendingHumanPrompt
): PendingQuestionItem[] {
  if (prompt.questions && prompt.questions.length > 0) {
    return prompt.questions;
  }
  if (prompt.options && prompt.options.length > 0) {
    return [
      {
        question: prompt.title || "Choose an option",
        type: "single_select",
        options: prompt.options.map((o) => ({
          label: o.label,
          recommended: o.recommended,
        })),
        allowCustomInput: true,
      },
    ];
  }
  return [
    {
      question: prompt.title || "Provide your response",
      type: "text",
      options: [],
      allowCustomInput: true,
    },
  ];
}

function ensureDraft(
  prompt: PendingHumanPrompt,
  questions: PendingQuestionItem[],
  persist = true
): PromptDraftState {
  let state = promptDraftStore.get(prompt.id);
  if (!state) {
    state = { activeIdx: 0, answers: {} };
    questions.forEach((q, idx) => {
      const def = (q.defaultValue ?? "").trim();
      if (q.type === "text") {
        state!.answers[idx] = {
          selected: [],
          customOpen: true,
          customText: def,
        };
      } else if (def) {
        const matched = q.options.find(
          (o) => o.label === def || o.id === def
        );
        state!.answers[idx] = matched
          ? { selected: [matched.label], customOpen: false, customText: "" }
          : { selected: [], customOpen: true, customText: def };
      } else {
        state!.answers[idx] = {
          selected: [],
          customOpen: q.options.length === 0,
          customText: "",
        };
      }
    });
    if (persist) promptDraftStore.set(prompt.id, state);
  }
  if (state.activeIdx >= questions.length) {
    state.activeIdx = Math.max(0, questions.length - 1);
  }
  return state;
}

export function getQuestionAnswerText(
  q: PendingQuestionItem,
  draft: QuestionAnswerDraft | undefined
): string {
  if (!draft) return "";
  const custom = draft.customText.trim();
  if (q.type === "text" || q.options.length === 0) {
    return custom;
  }
  if (q.type === "single_select") {
    if (draft.customOpen && custom && draft.selected.length === 0) {
      return custom;
    }
    if (draft.selected.length > 0) {
      return custom && draft.customOpen
        ? `${draft.selected[0]} — ${custom}`
        : draft.selected[0] ?? "";
    }
    return draft.customOpen ? custom : "";
  }
  // multi_select
  const parts = [...draft.selected];
  if (draft.customOpen && custom) parts.push(custom);
  return parts.join(", ");
}

export function isQuestionAnswered(
  q: PendingQuestionItem,
  draft: QuestionAnswerDraft | undefined
): boolean {
  return getQuestionAnswerText(q, draft).length > 0;
}

export function resolveReadyCount(
  questions: PendingQuestionItem[],
  state: PromptDraftState
): number {
  return questions.filter((q, idx) => isQuestionAnswered(q, state.answers[idx])).length;
}

export function formatPromptAnswerText(
  questions: PendingQuestionItem[],
  state: PromptDraftState
): string {
  if (questions.length <= 1) {
    const q = questions[0];
    if (!q) return "";
    return getQuestionAnswerText(q, state.answers[0]);
  }
  const lines: string[] = [];
  questions.forEach((q, idx) => {
    const ans = getQuestionAnswerText(q, state.answers[idx]);
    if (ans) {
      const label = cleanSummaryText(q.question || q.header || `Question ${idx + 1}`);
      lines.push(`${idx + 1}. ${label}: ${ans}`);
    }
  });
  return lines.join("\n");
}

export function buildStructuredAnswers(
  questions: PendingQuestionItem[],
  state: PromptDraftState
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  questions.forEach((q, idx) => {
    const draft = state.answers[idx];
    if (!draft) return;
    const baseKey = (q.id || q.header || q.question || `q_${idx + 1}`).trim() || `q_${idx + 1}`;
    const key = Object.prototype.hasOwnProperty.call(out, baseKey)
      ? `${baseKey}_${idx + 1}`
      : baseKey;
    if (q.type === "multi_select") {
      const items = [...draft.selected];
      const custom = draft.customText.trim();
      if (draft.customOpen && custom) items.push(custom);
      if (items.length > 0) {
        out[key] = items;
      }
      return;
    }
    const textVal = getQuestionAnswerText(q, draft);
    if (textVal) {
      out[key] = textVal;
    }
  });
  return out;
}

export function getPrimaryActionMeta(
  caps: ReplyCapabilities,
  blockingToolCall: boolean,
  directReply = false
): { label: string; showSecondaryCopy: boolean } {
  if (directReply) {
    return { label: "Send Answer", showSecondaryCopy: false };
  }
  if (caps.isMcpApp && caps.canSendMessage && !blockingToolCall) {
    return { label: "Send Answer to Chat", showSecondaryCopy: true };
  }
  if (caps.isEmbed && !blockingToolCall) {
    return { label: "Prefill IDE Chat", showSecondaryCopy: true };
  }
  if (caps.isEmbed && blockingToolCall) {
    return { label: "Copy & Focus IDE", showSecondaryCopy: false };
  }
  return { label: "Copy Answer", showSecondaryCopy: false };
}

export function computePromptStructureFingerprint(
  prompt: PendingHumanPrompt,
  caps: ReplyCapabilities
): string {
  return JSON.stringify({
    id: prompt.id,
    kind: prompt.kind,
    blocking: prompt.blockingToolCall,
    directReply: Boolean(prompt.directReply),
    status: prompt.status ?? "pending",
    questions: prompt.questions,
    options: prompt.options,
    caps,
  });
}

export function computePromptMetaFingerprint(prompt: PendingHumanPrompt): string {
  return JSON.stringify({
    title: prompt.title,
    summary: prompt.summary,
    agentLabel: prompt.agentLabel,
  });
}

export function computePromptFingerprint(
  prompt: PendingHumanPrompt,
  caps: ReplyCapabilities
): string {
  return `${computePromptStructureFingerprint(prompt, caps)}|${computePromptMetaFingerprint(prompt)}`;
}

export class QuestionCard {
  private container: HTMLElement;
  private opts: QuestionCardOptions;
  private instanceId: number;
  private structureFingerprint = "";
  private metaFingerprint = "";
  private statusText = "";
  private statusTone: "ok" | "warn" | "err" = "ok";
  private sending = false;
  private canceling = false;
  private cancelConfirmOpen = false;
  private resolvedState: "answered" | "canceled" | null = null;
  private showErrorActions = false;
  private errorAllowRetry = false;
  private lastFailedAction: "reply" | "cancel" | null = null;
  private lastFailedAnswerText = "";
  private statusTimer: number | null = null;
  private renderedResolved = false;

  constructor(container: HTMLElement, opts: QuestionCardOptions) {
    this.container = container;
    this.opts = opts;
    this.instanceId = ++cardInstanceSeq;
    this.render(true);
  }

  public dispose(): void {
    if (this.statusTimer != null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.isResolved()) {
      clearPromptDraft(this.opts.prompt.id);
    }
  }

  public update(opts: Partial<QuestionCardOptions> & { prompt: PendingHumanPrompt }): void {
    this.opts = { ...this.opts, ...opts };
    this.render(false);
  }

  public getPromptId(): string {
    return this.opts.prompt.id;
  }

  public focusPrimaryControl(): void {
    const first = this.container.querySelector<HTMLElement>(
      "input[type='radio'], input[type='checkbox'], textarea, button.qc-primary-btn"
    );
    first?.focus({ preventScroll: false });
  }

  private isResolved(): boolean {
    const st = this.opts.prompt.status;
    return (
      this.resolvedState !== null ||
      st === "answered" ||
      st === "canceled" ||
      st === "expired"
    );
  }

  private captureActiveControl(): {
    selector: string;
    selStart: number | null;
    selEnd: number | null;
  } | null {
    const activeEl = typeof document !== "undefined" ? document.activeElement : null;
    if (
      !activeEl ||
      !this.container.contains(activeEl) ||
      !(activeEl instanceof HTMLElement)
    ) {
      return null;
    }
    if (
      activeEl instanceof HTMLTextAreaElement ||
      activeEl.hasAttribute("data-qc-custom-input")
    ) {
      const ta = activeEl as HTMLTextAreaElement;
      return {
        selector: "[data-qc-custom-input]",
        selStart: typeof ta.selectionStart === "number" ? ta.selectionStart : null,
        selEnd: typeof ta.selectionEnd === "number" ? ta.selectionEnd : null,
      };
    }
    if (
      activeEl instanceof HTMLInputElement &&
      activeEl.dataset.qcOption !== undefined
    ) {
      return {
        selector: `[data-qc-option="${activeEl.dataset.qcOption}"]`,
        selStart: null,
        selEnd: null,
      };
    }
    if (activeEl.dataset.qcStep !== undefined) {
      return {
        selector: `[data-qc-step="${activeEl.dataset.qcStep}"]`,
        selStart: null,
        selEnd: null,
      };
    }
    const attrs = [
      "data-qc-custom-toggle",
      "data-qc-prev",
      "data-qc-next",
      "data-qc-copy",
      "data-qc-cancel",
      "data-qc-cancel-confirm-yes",
      "data-qc-cancel-keep",
      "data-qc-retry",
      "data-qc-error-copy",
    ];
    for (const attr of attrs) {
      if (activeEl.hasAttribute(attr)) {
        return { selector: `[${attr}]`, selStart: null, selEnd: null };
      }
    }
    if (activeEl.classList.contains("qc-primary-btn")) {
      return { selector: ".qc-primary-btn", selStart: null, selEnd: null };
    }
    return null;
  }

  private focusErrorCopy(): void {
    const btn = this.container.querySelector<HTMLElement>("[data-qc-error-copy]");
    btn?.focus({ preventScroll: false });
  }

  private render(force: boolean): void {
    if (!force && (this.sending || this.canceling)) {
      return;
    }
    const prompt = this.opts.prompt;
    const caps = this.opts.getCapabilities();
    const nextStructFp = computePromptStructureFingerprint(prompt, caps);
    const nextMetaFp = computePromptMetaFingerprint(prompt);

    if (!force && this.isResolved()) {
      // Already rendered into the locked/resolved state: freeze the card.
      if (this.renderedResolved) return;
      // Remote pending -> answered/canceled/expired transition: render once into the locked state.
      this.structureFingerprint = nextStructFp;
      this.metaFingerprint = nextMetaFp;
      this.renderInner(false);
      return;
    }

    if (!force && nextStructFp === this.structureFingerprint) {
      if (nextMetaFp === this.metaFingerprint) {
        return;
      }
      // Non-structural SSE update: patch lightweight metadata text in-place so focus is never lost
      this.metaFingerprint = nextMetaFp;
      const agentEl = this.container.querySelector<HTMLElement>(".qc-agent-name");
      if (agentEl) agentEl.textContent = prompt.agentLabel || prompt.agentId;
      const titleEl = this.container.querySelector<HTMLElement>(".qc-title");
      if (titleEl && prompt.title) titleEl.textContent = cleanSummaryText(prompt.title);
      const summaryEl = this.container.querySelector<HTMLElement>(".qc-summary");
      if (summaryEl) {
        const cleanSum = cleanSummaryText(prompt.summary ?? "");
        summaryEl.textContent = cleanSum;
        summaryEl.hidden = !cleanSum;
      }
      return;
    }

    this.structureFingerprint = nextStructFp;
    this.metaFingerprint = nextMetaFp;
    this.renderInner(false);
  }

  private renderInner(restoreFocusSelector: string | false): void {
    const captured =
      restoreFocusSelector === false ? this.captureActiveControl() : null;
    const prompt = this.opts.prompt;
    const caps = this.opts.getCapabilities();
    const questions = getEffectiveQuestions(prompt);
    const resolvedNow = this.isResolved();
    this.renderedResolved = resolvedNow;
    const draft = ensureDraft(prompt, questions, !resolvedNow);
    const activeIdx = draft.activeIdx;
    const activeQ = questions[activeIdx] ?? questions[0]!;
    const activeAns = draft.answers[activeIdx] ?? {
      selected: [],
      customOpen: false,
      customText: "",
    };

    const answeredCount = questions.filter((q, idx) =>
      isQuestionAnswered(q, draft.answers[idx])
    ).length;
    const isDirectReply = prompt.directReply === true;
    const actionMeta = getPrimaryActionMeta(
      caps,
      prompt.blockingToolCall,
      isDirectReply
    );
    const showHeader = this.opts.showHeader !== false;
    const isLocked = this.sending || this.canceling || this.isResolved();
    const showCancel = isDirectReply && Boolean(this.opts.onCancel);
    const cleanSummary = cleanSummaryText(prompt.summary ?? "");

    const tabsHtml =
      questions.length > 1
        ? `
          <div class="qc-step-bar" role="tablist" aria-label="Questions">
            ${questions
              .map((q, idx) => {
                const answered = isQuestionAnswered(q, draft.answers[idx]);
                const active = idx === activeIdx;
                const shortLabel = q.header
                  ? `${idx + 1}. ${cleanSummaryText(q.header)}`
                  : `Q${idx + 1}`;
                return `
                  <button
                    type="button"
                    role="tab"
                    class="qc-step-pill ${active ? "is-active" : ""} ${answered ? "is-answered" : ""}"
                    data-qc-step="${idx}"
                    tabindex="${active ? "0" : "-1"}"
                    aria-selected="${active ? "true" : "false"}"
                    title="${escHtml(cleanSummaryText(q.question))}"
                  >
                    <span>${escHtml(shortLabel)}</span>
                    ${answered ? `<span class="qc-step-check" aria-label="answered">✓</span>` : ""}
                  </button>
                `;
              })
              .join("")}
            <span class="qc-progress-txt">${answeredCount}/${questions.length} answered</span>
          </div>
        `
        : "";

    const allowCustom = activeQ.allowCustomInput !== false;
    const isTextOnly = activeQ.type === "text" || activeQ.options.length === 0;
    const inputType = activeQ.type === "multi_select" ? "checkbox" : "radio";
    const groupName = `qc-${this.instanceId}-q-${activeIdx}`;
    const customId = `qc-custom-${this.instanceId}-${activeIdx}`;

    const optionsHtml = !isTextOnly
      ? `
        <div class="qc-options">
          ${activeQ.options
            .map((opt, oIdx) => {
              const checked = activeAns.selected.includes(opt.label);
              const optId = `qc-opt-${this.instanceId}-${activeIdx}-${oIdx}`;
              return `
                <label class="qc-option ${checked ? "is-checked" : ""}" for="${escHtml(optId)}">
                  <input
                    type="${inputType}"
                    id="${escHtml(optId)}"
                    name="${escHtml(groupName)}"
                    value="${escHtml(opt.label)}"
                    data-qc-option="${oIdx}"
                    ${checked ? "checked" : ""}
                    ${isLocked ? "disabled" : ""}
                  />
                  <span class="qc-option-body">
                    <span class="qc-option-top">
                      <span class="qc-option-label">${escHtml(opt.label)}</span>
                      ${opt.recommended ? `<span class="qc-rec-pill">★ Recommended</span>` : ""}
                    </span>
                    ${opt.description ? `<span class="qc-option-desc">${escHtml(opt.description)}</span>` : ""}
                  </span>
                </label>
              `;
            })
            .join("")}
          ${
            allowCustom
              ? `
                <div class="qc-custom-toggle-row">
                  <button
                    type="button"
                    class="qc-custom-toggle ${activeAns.customOpen ? "is-open" : ""}"
                    data-qc-custom-toggle
                    aria-expanded="${activeAns.customOpen ? "true" : "false"}"
                    aria-controls="${escHtml(customId)}"
                    ${isLocked ? "disabled" : ""}
                  >
                    ${activeAns.customOpen ? "▾ Hide custom reply" : "+ Other / Custom reply"}
                  </button>
                </div>
              `
              : ""
          }
        </div>
      `
      : "";

    const customAreaHtml =
      isTextOnly || (allowCustom && activeAns.customOpen)
        ? `
          <div class="qc-custom-wrap">
            <label class="qc-custom-label" for="${escHtml(customId)}">
              ${isTextOnly ? "Your reply" : "Custom reply"}
            </label>
            <textarea
              id="${escHtml(customId)}"
              class="qc-textarea"
              rows="${this.opts.compact ? 2 : 3}"
              placeholder="Type your response…"
              data-qc-custom-input
              ${isLocked ? "disabled" : ""}
            >${escHtml(activeAns.customText)}</textarea>
          </div>
        `
        : "";

    const previewText = formatPromptAnswerText(questions, draft);
    const statusRole = this.statusTone === "err" ? "alert" : "status";
    const statusLive = this.statusTone === "err" ? "assertive" : "polite";
    const copyFallbackText = this.lastFailedAnswerText || previewText;

    this.container.innerHTML = `
      <form class="qc-card ${prompt.kind === "approval" ? "is-approval" : ""} ${isDirectReply ? "is-direct-reply" : ""} ${this.opts.compact ? "is-compact" : ""} ${this.isResolved() ? "is-resolved" : ""}" data-qc-form>
        ${
          showHeader
            ? `
              <div class="qc-head">
                <div class="qc-head-left">
                  <span class="qc-waiting-badge">
                    <span aria-hidden="true">?</span>
                    <span>${prompt.kind === "approval" ? "Approval Needed" : "Needs Input"}</span>
                  </span>
                  ${isDirectReply ? `<span class="qc-direct-pill">Direct Reply</span>` : ""}
                  <span class="qc-agent-name">${escHtml(prompt.agentLabel || prompt.agentId)}</span>
                </div>
              </div>
            `
            : ""
        }
        ${
          prompt.title && (showHeader || cleanSummaryText(prompt.title) !== cleanSummaryText(activeQ.question))
            ? `<div class="qc-title">${escHtml(cleanSummaryText(prompt.title))}</div>`
            : ""
        }
        <div class="qc-summary" ${cleanSummary ? "" : "hidden"}>${escHtml(cleanSummary)}</div>

        ${tabsHtml}

        <fieldset class="qc-fieldset">
          <legend class="qc-legend">
            ${questions.length > 1 ? `<span class="qc-q-num">Q${activeIdx + 1}.</span> ` : ""}${escHtml(cleanSummaryText(activeQ.question))}
            ${activeQ.type === "multi_select" ? `<span class="qc-multi-hint">(Select one or more)</span>` : ""}
          </legend>
          ${optionsHtml}
          ${customAreaHtml}
        </fieldset>

        ${
          questions.length > 1
            ? `
              <div class="qc-nav-row">
                <button type="button" class="btn-ghost btn-sm" data-qc-prev ${activeIdx <= 0 || isLocked ? "disabled" : ""}>← Prev</button>
                <button type="button" class="btn-ghost btn-sm" data-qc-next ${activeIdx >= questions.length - 1 || isLocked ? "disabled" : ""}>Next →</button>
              </div>
            `
            : ""
        }

        ${
          prompt.blockingToolCall && !isDirectReply
            ? `<div class="qc-blocking-note" role="note">Active tool prompt requires confirming in your IDE chat</div>`
            : ""
        }

        <div class="qc-actions">
          <button
            type="submit"
            class="btn-primary btn-sm qc-primary-btn"
            ${isLocked ? "disabled" : ""}
            ${this.sending ? 'aria-busy="true"' : ""}
          >${this.sending ? "Sending…" : escHtml(actionMeta.label)}</button>
          ${
            actionMeta.showSecondaryCopy
              ? `<button type="button" class="btn-secondary btn-sm qc-copy-btn" data-qc-copy ${isLocked ? "disabled" : ""}>Copy</button>`
              : ""
          }
          <span class="qc-ready-chip" data-qc-ready ${previewText ? "" : "hidden"} title="${escHtml(previewText)}">Ready</span>
          ${
            showCancel
              ? `<button type="button" class="btn-ghost btn-sm qc-cancel-btn" data-qc-cancel ${isLocked ? "disabled" : ""}>Cancel</button>`
              : ""
          }
        </div>

        ${
          showCancel
            ? `
              <div class="qc-cancel-confirm" data-qc-cancel-confirm role="group" aria-label="Confirm cancel prompt" ${this.cancelConfirmOpen && !this.isResolved() ? "" : "hidden"}>
                <span class="qc-cancel-prompt">Cancel prompt?</span>
                <button type="button" class="btn-secondary btn-sm qc-cancel-confirm-btn" data-qc-cancel-confirm-yes ${isLocked ? "disabled" : ""} ${this.canceling ? 'aria-busy="true"' : ""}>${this.canceling ? "Canceling…" : "Confirm"}</button>
                <button type="button" class="btn-ghost btn-sm qc-cancel-keep-btn" data-qc-cancel-keep ${isLocked ? "disabled" : ""}>Keep</button>
              </div>
            `
            : ""
        }

        <div class="qc-status ${this.statusText ? `is-${this.statusTone}` : ""}" role="${statusRole}" aria-live="${statusLive}" ${this.statusText ? "" : "hidden"}>
          <span class="qc-status-msg" data-qc-status-msg>${escHtml(this.statusText)}</span>
          <div class="qc-error-actions" data-qc-error-actions ${this.showErrorActions ? "" : "hidden"}>
            ${
              this.errorAllowRetry
                ? `<button type="button" class="btn-secondary btn-sm qc-retry-btn" data-qc-retry ${this.sending || this.canceling ? "disabled" : ""}>Retry</button>`
                : ""
            }
            ${
              copyFallbackText
                ? `<button type="button" class="btn-ghost btn-sm qc-error-copy-btn" data-qc-error-copy>Copy Answer</button>`
                : ""
            }
          </div>
        </div>
      </form>
    `;

    this.bindDomEvents(questions, draft);

    const targetSelector =
      restoreFocusSelector !== false ? restoreFocusSelector : captured?.selector || "";
    if (targetSelector) {
      const targetEl = this.container.querySelector<HTMLElement>(targetSelector);
      targetEl?.focus({ preventScroll: true });
      if (
        restoreFocusSelector === false &&
        captured &&
        targetEl instanceof HTMLTextAreaElement &&
        captured.selStart !== null &&
        captured.selEnd !== null
      ) {
        try {
          targetEl.setSelectionRange(captured.selStart, captured.selEnd);
        } catch {
          // Ignore selection errors on unsupported elements
        }
      }
    }
  }

  private bindDomEvents(
    questions: PendingQuestionItem[],
    draft: PromptDraftState
  ): void {
    const activeIdx = draft.activeIdx;
    const activeQ = questions[activeIdx] ?? questions[0]!;
    const ans = draft.answers[activeIdx] ?? {
      selected: [],
      customOpen: false,
      customText: "",
    };
    draft.answers[activeIdx] = ans;

    this.container.querySelectorAll<HTMLButtonElement>("[data-qc-step]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextIdx = Number(btn.dataset.qcStep);
        if (Number.isFinite(nextIdx) && nextIdx >= 0 && nextIdx < questions.length) {
          draft.activeIdx = nextIdx;
          this.renderInner(`[data-qc-step="${nextIdx}"]`);
        }
      });
    });

    this.container.querySelector<HTMLElement>(".qc-step-bar")?.addEventListener("keydown", (e) => {
      if (questions.length <= 1) return;
      let nextIdx: number | null = null;
      if (e.key === "ArrowRight") {
        nextIdx = (draft.activeIdx + 1) % questions.length;
      } else if (e.key === "ArrowLeft") {
        nextIdx = (draft.activeIdx - 1 + questions.length) % questions.length;
      } else if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = questions.length - 1;
      }
      if (nextIdx !== null) {
        e.preventDefault();
        draft.activeIdx = nextIdx;
        this.renderInner(`[data-qc-step="${nextIdx}"]`);
      }
    });

    this.container.querySelector("[data-qc-prev]")?.addEventListener("click", () => {
      if (draft.activeIdx > 0) {
        draft.activeIdx -= 1;
        this.renderInner("fieldset.qc-fieldset input, fieldset.qc-fieldset textarea");
      }
    });

    this.container.querySelector("[data-qc-next]")?.addEventListener("click", () => {
      if (draft.activeIdx < questions.length - 1) {
        draft.activeIdx += 1;
        this.renderInner("fieldset.qc-fieldset input, fieldset.qc-fieldset textarea");
      }
    });

    this.container.querySelectorAll<HTMLInputElement>("[data-qc-option]").forEach((input) => {
      input.addEventListener("change", () => {
        if (activeQ.type === "multi_select") {
          const selected: string[] = [];
          this.container
            .querySelectorAll<HTMLInputElement>("[data-qc-option]:checked")
            .forEach((chk) => selected.push(chk.value));
          ans.selected = selected;
        } else {
          ans.selected = input.checked ? [input.value] : [];
        }
        this.updateOptionStyles();
        this.updateReadyState(questions, draft);
      });
    });

    this.container.querySelector("[data-qc-custom-toggle]")?.addEventListener("click", () => {
      ans.customOpen = !ans.customOpen;
      this.renderInner(ans.customOpen ? "[data-qc-custom-input]" : "[data-qc-custom-toggle]");
    });

    const textarea = this.container.querySelector<HTMLTextAreaElement>("[data-qc-custom-input]");
    textarea?.addEventListener("input", () => {
      ans.customText = textarea.value;
      if (
        activeQ.type === "single_select" &&
        textarea.value.trim().length > 0 &&
        ans.selected.length > 0
      ) {
        ans.selected = [];
        this.container
          .querySelectorAll<HTMLInputElement>("[data-qc-option]")
          .forEach((r) => {
            r.checked = false;
          });
        this.updateOptionStyles();
      }
      this.updateReadyState(questions, draft);
    });

    this.container.querySelector("[data-qc-copy]")?.addEventListener("click", () => {
      void this.handleCopyOnly(questions, draft);
    });

    this.container.querySelector("[data-qc-cancel]")?.addEventListener("click", () => {
      if (this.sending || this.canceling || this.isResolved()) return;
      this.cancelConfirmOpen = true;
      this.renderInner("[data-qc-cancel-keep]");
    });

    this.container.querySelector("[data-qc-cancel-keep]")?.addEventListener("click", () => {
      if (this.canceling || this.isResolved()) return;
      this.cancelConfirmOpen = false;
      this.renderInner("[data-qc-cancel]");
    });

    this.container.querySelector("[data-qc-cancel-confirm-yes]")?.addEventListener("click", () => {
      void this.handleCancel(questions, draft);
    });

    this.container.querySelector("[data-qc-retry]")?.addEventListener("click", () => {
      if (this.lastFailedAction === "cancel") {
        void this.handleCancel(questions, draft);
      } else {
        void this.handleSubmit(questions, draft);
      }
    });

    const errorCopyBtn = this.container.querySelector<HTMLButtonElement>("[data-qc-error-copy]");
    errorCopyBtn?.addEventListener("click", () => {
      const text = this.lastFailedAnswerText || formatPromptAnswerText(questions, draft);
      if (!text) return;
      void copyTextSafe(text).then((ok) => {
        if (!document.contains(errorCopyBtn)) return;
        errorCopyBtn.textContent = ok ? "Copied ✓" : "Copy failed";
        window.setTimeout(() => {
          if (document.contains(errorCopyBtn)) {
            errorCopyBtn.textContent = "Copy Answer";
          }
        }, 1600);
      });
    });

    const form = this.container.querySelector<HTMLFormElement>("[data-qc-form]");
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.handleSubmit(questions, draft);
    });
  }

  private updateOptionStyles(): void {
    this.container.querySelectorAll<HTMLLabelElement>(".qc-option").forEach((lbl) => {
      const inp = lbl.querySelector<HTMLInputElement>("input");
      lbl.classList.toggle("is-checked", Boolean(inp?.checked));
    });
  }

  private updateReadyState(
    questions: PendingQuestionItem[],
    draft: PromptDraftState
  ): void {
    const answeredCount = resolveReadyCount(questions, draft);
    const progressEl = this.container.querySelector(".qc-progress-txt");
    if (progressEl) {
      progressEl.textContent = `${answeredCount}/${questions.length} answered`;
    }
    const readyChip = this.container.querySelector<HTMLElement>("[data-qc-ready]");
    if (readyChip) {
      const previewText = formatPromptAnswerText(questions, draft);
      readyChip.hidden = !previewText;
      readyChip.title = previewText;
    }
    this.container.querySelectorAll<HTMLButtonElement>("[data-qc-step]").forEach((pill) => {
      const idx = Number(pill.dataset.qcStep);
      const q = questions[idx];
      if (!q) return;
      const answered = isQuestionAnswered(q, draft.answers[idx]);
      pill.classList.toggle("is-answered", answered);
      let chk = pill.querySelector(".qc-step-check");
      if (answered && !chk) {
        chk = document.createElement("span");
        chk.className = "qc-step-check";
        chk.setAttribute("aria-label", "answered");
        chk.textContent = "✓";
        pill.appendChild(chk);
      } else if (!answered && chk) {
        chk.remove();
      }
    });
  }

  private setStatus(
    msg: string,
    tone: "ok" | "warn" | "err",
    opts?: { persist?: boolean; showActions?: boolean; allowRetry?: boolean }
  ): void {
    this.statusText = msg;
    this.statusTone = tone;
    this.showErrorActions = Boolean(opts?.showActions);
    this.errorAllowRetry = Boolean(opts?.allowRetry);

    if (this.statusTimer != null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }

    const statusEl = this.container.querySelector<HTMLElement>(".qc-status");
    const msgEl = this.container.querySelector<HTMLElement>("[data-qc-status-msg]");
    const actionsEl = this.container.querySelector<HTMLElement>("[data-qc-error-actions]");
    if (statusEl) {
      statusEl.className = `qc-status ${msg ? `is-${tone}` : ""}`.trim();
      statusEl.setAttribute("role", tone === "err" ? "alert" : "status");
      statusEl.setAttribute("aria-live", tone === "err" ? "assertive" : "polite");
      statusEl.hidden = !msg;
    }
    if (msgEl) {
      msgEl.textContent = msg;
    }
    if (actionsEl) {
      actionsEl.hidden = !this.showErrorActions;
    }

    if (msg && !opts?.persist) {
      this.statusTimer = window.setTimeout(() => {
        if (this.isResolved() || this.showErrorActions) return;
        this.statusText = "";
        const el = this.container.querySelector<HTMLElement>(".qc-status");
        const mEl = this.container.querySelector<HTMLElement>("[data-qc-status-msg]");
        if (mEl) mEl.textContent = "";
        if (el) el.hidden = true;
      }, 4500);
    }
  }

  private async handleCopyOnly(
    questions: PendingQuestionItem[],
    draft: PromptDraftState
  ): Promise<void> {
    const text = formatPromptAnswerText(questions, draft);
    if (!text) {
      this.setStatus("Select an option or enter a reply first.", "warn");
      this.focusPrimaryControl();
      return;
    }
    const ok = await copyTextSafe(text);
    this.setStatus(
      ok ? "Copied answer to clipboard." : "Could not copy automatically — please copy manually.",
      ok ? "ok" : "err"
    );
  }

  private async handleCancel(
    questions: PendingQuestionItem[],
    draft: PromptDraftState
  ): Promise<void> {
    if (this.sending || this.canceling || this.isResolved() || !this.opts.onCancel) return;
    this.canceling = true;
    this.lastFailedAction = null;
    this.lastFailedAnswerText = formatPromptAnswerText(questions, draft);
    this.renderInner(false);

    try {
      const res = await this.opts.onCancel(this.opts.prompt.id);
      this.canceling = false;
      if (res.ok) {
        this.cancelConfirmOpen = false;
        this.resolvedState = "canceled";
        clearPromptDraft(this.opts.prompt.id);
        this.setStatus(
          res.message || "Canceled — agent unblocked",
          "ok",
          { persist: true }
        );
        this.renderInner(false);
        return;
      }

      if (res.conflict) {
        this.cancelConfirmOpen = false;
        this.resolvedState = res.status === "canceled" ? "canceled" : "answered";
        this.setStatus(res.message || "Already resolved", "err", {
          persist: true,
          showActions: Boolean(this.lastFailedAnswerText),
          allowRetry: false,
        });
        this.renderInner(false);
        this.focusErrorCopy();
        return;
      }

      this.lastFailedAction = "cancel";
      this.setStatus(res.message || "Failed to cancel prompt.", "err", {
        persist: true,
        showActions: true,
        allowRetry: true,
      });
      this.renderInner("[data-qc-retry]");
    } catch (err) {
      this.canceling = false;
      this.lastFailedAction = "cancel";
      this.setStatus(
        err instanceof Error ? err.message : "Failed to cancel prompt.",
        "err",
        {
          persist: true,
          showActions: true,
          allowRetry: true,
        }
      );
      this.renderInner("[data-qc-retry]");
    }
  }

  private async handleSubmit(
    questions: PendingQuestionItem[],
    draft: PromptDraftState
  ): Promise<void> {
    if (this.sending || this.canceling || this.isResolved()) return;
    const text = formatPromptAnswerText(questions, draft);
    if (!text) {
      this.setStatus("Select an option or enter a reply first.", "warn");
      this.focusPrimaryControl();
      return;
    }

    const isDirectReply = this.opts.prompt.directReply === true;
    const structuredAnswers = buildStructuredAnswers(questions, draft);

    this.sending = true;
    this.cancelConfirmOpen = false;
    this.lastFailedAction = null;
    this.lastFailedAnswerText = text;
    this.setStatus("", "ok");
    this.renderInner(false);

    try {
      const res = await this.opts.onReply({
        sessionId: this.opts.sessionId,
        agentId: this.opts.prompt.agentId,
        promptId: this.opts.prompt.id,
        text,
        blockingToolCall: this.opts.prompt.blockingToolCall,
        directReply: isDirectReply,
        promptSource: this.opts.prompt.promptSource,
        answers: structuredAnswers,
      });
      this.sending = false;

      if (res.ok) {
        if (isDirectReply || res.mode === "answered") {
          this.resolvedState = "answered";
          clearPromptDraft(this.opts.prompt.id);
          const agentName = this.opts.prompt.agentLabel || this.opts.prompt.agentId || "Agent";
          this.setStatus(`Sent to ${agentName} ✓`, "ok", { persist: true });
          this.renderInner(false);
        } else {
          this.setStatus(res.message || "Answer ready.", "ok");
          this.renderInner(false);
        }
        return;
      }

      if (res.conflict) {
        this.resolvedState = res.status === "canceled" ? "canceled" : "answered";
        this.setStatus(res.message || "Already resolved", "err", {
          persist: true,
          showActions: true,
          allowRetry: false,
        });
        this.renderInner(false);
        this.focusErrorCopy();
        return;
      }

      this.lastFailedAction = "reply";
      this.setStatus(res.message || "Unable to send answer.", "err", {
        persist: true,
        showActions: true,
        allowRetry: true,
      });
      this.renderInner("[data-qc-retry]");
    } catch (err) {
      this.sending = false;
      this.lastFailedAction = "reply";
      this.setStatus(
        err instanceof Error ? err.message : "Failed to deliver answer.",
        "err",
        {
          persist: true,
          showActions: true,
          allowRetry: true,
        }
      );
      this.renderInner("[data-qc-retry]");
    }
  }
}
