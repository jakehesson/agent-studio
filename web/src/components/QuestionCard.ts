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

export interface QuestionCardOptions {
  prompt: PendingHumanPrompt;
  sessionId?: string;
  compact?: boolean;
  showHeader?: boolean;
  getCapabilities: () => ReplyCapabilities;
  onReply: (req: ReplyToHostRequest) => Promise<ReplyToHostResult>;
  onOpenChat?: (agentId: string) => void;
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
  questions: PendingQuestionItem[]
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
    promptDraftStore.set(prompt.id, state);
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

export function getPrimaryActionMeta(
  caps: ReplyCapabilities,
  blockingToolCall: boolean
): { label: string; showSecondaryCopy: boolean } {
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
  private statusTimer: number | null = null;

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

  private render(force: boolean): void {
    const prompt = this.opts.prompt;
    const caps = this.opts.getCapabilities();
    const nextStructFp = computePromptStructureFingerprint(prompt, caps);
    const nextMetaFp = computePromptMetaFingerprint(prompt);

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
      if (summaryEl) summaryEl.textContent = cleanSummaryText(prompt.summary ?? "");
      return;
    }

    const activeEl = document.activeElement;
    const isInteractingInside =
      Boolean(activeEl) && this.container.contains(activeEl);
    if (
      !force &&
      isInteractingInside &&
      activeEl instanceof HTMLTextAreaElement &&
      this.structureFingerprint !== ""
    ) {
      return;
    }

    this.structureFingerprint = nextStructFp;
    this.metaFingerprint = nextMetaFp;
    this.renderInner(false);
  }

  private renderInner(restoreFocusSelector: string | false): void {
    const prompt = this.opts.prompt;
    const caps = this.opts.getCapabilities();
    const questions = getEffectiveQuestions(prompt);
    const draft = ensureDraft(prompt, questions);
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
    const actionMeta = getPrimaryActionMeta(caps, prompt.blockingToolCall);
    const showHeader = this.opts.showHeader !== false;

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
            >${escHtml(activeAns.customText)}</textarea>
          </div>
        `
        : "";

    const previewText = formatPromptAnswerText(questions, draft);

    this.container.innerHTML = `
      <form class="qc-card ${prompt.kind === "approval" ? "is-approval" : ""} ${this.opts.compact ? "is-compact" : ""}" data-qc-form>
        ${
          showHeader
            ? `
              <div class="qc-head">
                <div class="qc-head-left">
                  <span class="qc-waiting-badge">
                    <span aria-hidden="true">?</span>
                    <span>${prompt.kind === "approval" ? "Approval Needed" : "Needs Input"}</span>
                  </span>
                  <span class="qc-agent-name">${escHtml(prompt.agentLabel || prompt.agentId)}</span>
                </div>
                ${
                  this.opts.onOpenChat
                    ? `<button type="button" class="btn-ghost qc-chat-link" data-qc-open-chat>Open Chat</button>`
                    : ""
                }
              </div>
            `
            : ""
        }
        ${
          prompt.title && (showHeader || cleanSummaryText(prompt.title) !== cleanSummaryText(activeQ.question))
            ? `<div class="qc-title">${escHtml(cleanSummaryText(prompt.title))}</div>`
            : ""
        }
        ${prompt.summary ? `<div class="qc-summary">${escHtml(cleanSummaryText(prompt.summary))}</div>` : ""}

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
                <button type="button" class="btn-ghost btn-sm" data-qc-prev ${activeIdx <= 0 ? "disabled" : ""}>← Prev</button>
                <button type="button" class="btn-ghost btn-sm" data-qc-next ${activeIdx >= questions.length - 1 ? "disabled" : ""}>Next →</button>
              </div>
            `
            : ""
        }

        ${
          prompt.blockingToolCall
            ? `<div class="qc-blocking-note" role="note">Active tool prompt requires confirming in your IDE chat</div>`
            : ""
        }

        <div class="qc-actions">
          <button
            type="submit"
            class="btn-primary btn-sm qc-primary-btn"
            ${this.sending ? "disabled aria-busy=\"true\"" : ""}
          >${this.sending ? "Sending…" : escHtml(actionMeta.label)}</button>
          ${
            actionMeta.showSecondaryCopy
              ? `<button type="button" class="btn-secondary btn-sm qc-copy-btn" data-qc-copy>Copy</button>`
              : ""
          }
          <span class="qc-ready-chip" data-qc-ready ${previewText ? "" : "hidden"} title="${escHtml(previewText)}">Ready</span>
        </div>

        <div class="qc-status ${this.statusText ? `is-${this.statusTone}` : ""}" role="status" aria-live="polite" ${this.statusText ? "" : "hidden"}>${escHtml(this.statusText)}</div>
      </form>
    `;

    this.bindDomEvents(questions, draft);

    if (restoreFocusSelector) {
      this.container.querySelector<HTMLElement>(restoreFocusSelector)?.focus({ preventScroll: true });
    }
  }

  private bindDomEvents(
    questions: PendingQuestionItem[],
    draft: PromptDraftState
  ): void {
    const prompt = this.opts.prompt;
    const activeIdx = draft.activeIdx;
    const activeQ = questions[activeIdx] ?? questions[0]!;
    const ans = draft.answers[activeIdx] ?? {
      selected: [],
      customOpen: false,
      customText: "",
    };
    draft.answers[activeIdx] = ans;

    this.container.querySelector("[data-qc-open-chat]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.onOpenChat?.(prompt.agentId);
    });

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
      if (ans.customOpen && activeQ.type === "single_select") {
        // Keep radio selection unless user clears or types; focusing custom textarea helps immediately
      }
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

  private showStatus(msg: string, tone: "ok" | "warn" | "err"): void {
    this.statusText = msg;
    this.statusTone = tone;
    const statusEl = this.container.querySelector<HTMLElement>(".qc-status");
    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.className = `qc-status is-${tone}`;
      statusEl.hidden = !msg;
    }
    if (this.statusTimer != null) {
      window.clearTimeout(this.statusTimer);
    }
    if (msg) {
      this.statusTimer = window.setTimeout(() => {
        this.statusText = "";
        const el = this.container.querySelector<HTMLElement>(".qc-status");
        if (el) {
          el.textContent = "";
          el.hidden = true;
        }
      }, 4500);
    }
  }

  private async handleCopyOnly(
    questions: PendingQuestionItem[],
    draft: PromptDraftState
  ): Promise<void> {
    const text = formatPromptAnswerText(questions, draft);
    if (!text) {
      this.showStatus("Select an option or enter a reply first.", "warn");
      this.focusPrimaryControl();
      return;
    }
    const ok = await copyTextSafe(text);
    this.showStatus(
      ok ? "Copied answer to clipboard." : "Could not copy automatically — please copy manually.",
      ok ? "ok" : "err"
    );
  }

  private async handleSubmit(
    questions: PendingQuestionItem[],
    draft: PromptDraftState
  ): Promise<void> {
    if (this.sending) return;
    const text = formatPromptAnswerText(questions, draft);
    if (!text) {
      this.showStatus("Select an option or enter a reply first.", "warn");
      this.focusPrimaryControl();
      return;
    }

    this.sending = true;
    const btn = this.container.querySelector<HTMLButtonElement>(".qc-primary-btn");
    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.textContent = "Sending…";
    }

    try {
      const res = await this.opts.onReply({
        sessionId: this.opts.sessionId,
        agentId: this.opts.prompt.agentId,
        promptId: this.opts.prompt.id,
        text,
        blockingToolCall: this.opts.prompt.blockingToolCall,
      });
      this.showStatus(
        res.message || (res.ok ? "Answer ready." : "Unable to send answer."),
        res.ok ? "ok" : "err"
      );
    } catch (err) {
      const copied = await copyTextSafe(text);
      this.showStatus(
        copied
          ? "Direct send failed — answer copied to clipboard."
          : err instanceof Error
            ? err.message
            : "Failed to deliver answer.",
        copied ? "warn" : "err"
      );
    } finally {
      this.sending = false;
      const caps = this.opts.getCapabilities();
      const actionMeta = getPrimaryActionMeta(caps, this.opts.prompt.blockingToolCall);
      const b = this.container.querySelector<HTMLButtonElement>(".qc-primary-btn");
      if (b) {
        b.disabled = false;
        b.removeAttribute("aria-busy");
        b.textContent = actionMeta.label;
      }
    }
  }
}
