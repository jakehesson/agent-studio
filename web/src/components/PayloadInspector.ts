import type {
  AgentNodeSnapshot,
  NormalizedEvent,
  TeamDefinitionEntry,
} from "../types.js";
import {
  classifyEventReadable,
  cleanSummaryText,
  escHtml,
  fmtClock,
  fmtContextWindow,
  fmtTokens,
  formatActorName,
  getContextZone,
  getIdeMeta,
  getStatusStyle,
  trunc,
  truncateWords,
} from "../utils.js";

export interface PayloadInspectorCallbacks {
  onClose?: () => void;
}

export interface InspectRenderOptions {
  openSheet?: boolean;
  definition?: TeamDefinitionEntry;
  labelMap?: Map<string, string>;
}

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy copy
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function extractFullNarrative(ev: NormalizedEvent): string {
  const p = ev.payload;
  const candidate =
    (typeof p?.body === "string" && p.body.trim()) ||
    (typeof p?.message === "string" && p.message.trim()) ||
    (typeof p?.Message === "string" && p.Message.trim()) ||
    (typeof p?.prompt === "string" && p.prompt.trim()) ||
    "";
  const cleanedSummary = cleanSummaryText(ev.summary);
  if (candidate && candidate.length > cleanedSummary.length + 12) {
    return candidate.trim();
  }
  return cleanedSummary || "No summary recorded.";
}

export class PayloadInspector {
  private container: HTMLElement;
  private cb: PayloadInspectorCallbacks;
  private dialog: HTMLDialogElement;
  private lastCopyText = "";
  private lastMarkup: {
    headerTitleHtml: string;
    inlineBodyHtml: string;
    modalBodyHtml: string;
  } | null = null;

  constructor(container: HTMLElement, cb: PayloadInspectorCallbacks = {}) {
    this.container = container;
    this.cb = cb;

    const dlg = document.createElement("dialog");
    dlg.className = "inspector-dialog";
    dlg.setAttribute("closedby", "any");
    dlg.setAttribute("aria-labelledby", "inspectorDialogTitle");
    dlg.innerHTML = `
      <div class="insp-sheet-shell">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="insp-sheet-head">
          <div class="insp-title-row" id="inspectorDialogTitle" data-dlg-title>Details</div>
          <div class="insp-head-actions">
            <button type="button" class="copy-btn" data-dlg-copy>Copy JSON</button>
            <button type="button" class="insp-icon-btn" data-dlg-close aria-label="Close details">✕</button>
          </div>
        </div>
        <div class="insp-sheet-body" data-dlg-body></div>
      </div>
    `;
    document.body.appendChild(dlg);
    this.dialog = dlg;

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

    dlg.querySelector("[data-dlg-close]")?.addEventListener("click", () => dlg.close());
    const dlgCopy = dlg.querySelector<HTMLButtonElement>("[data-dlg-copy]");
    dlgCopy?.addEventListener("click", () => {
      if (dlgCopy) void this.handleCopyClick(dlgCopy);
    });

    this.renderEmpty();
  }

  public dispose(): void {
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
  }

  public openModal(): void {
    if (!this.lastMarkup) return;
    this.syncDialogContent();
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
  }

  public closeModal(): void {
    if (this.dialog.open) {
      this.dialog.close();
    }
  }

  public renderEmpty(): void {
    this.lastCopyText = "";
    this.lastMarkup = null;
    this.container.setAttribute("data-inspector-state", "empty");
    this.container.innerHTML = `
      <div class="insp-empty-bar">
        <span class="insp-title">Payload Inspector</span>
        <span class="insp-sub">Select an event or agent to inspect payload</span>
      </div>
    `;
    if (this.dialog.open) this.dialog.close();
  }

  public renderEvent(ev: NormalizedEvent, opts: InspectRenderOptions = {}): void {
    const ide = getIdeMeta(ev.ide);
    const cls = classifyEventReadable(ev);
    const labelMap = opts.labelMap;
    const payloadJson = ev.payload
      ? JSON.stringify(ev.payload, null, 2)
      : "(no structured payload)";
    this.lastCopyText = JSON.stringify(ev, null, 2);

    const headerTitleHtml = `
      <span class="pill ${cls.cssClass}">${escHtml(cls.badge)}</span>
      <span class="insp-title">${escHtml(cls.humanTitle)}</span>
      <span class="ide-chip" style="color:${ide.color};border-color:${ide.border};background:${ide.bg}">${escHtml(ide.label)}</span>
    `;

    const actorDisplay = formatActorName(ev.agentId, labelMap, ev.agentLabel);
    const targetDisplay =
      ev.targetAgentId && ev.targetAgentId !== ev.agentId
        ? formatActorName(ev.targetAgentId, labelMap)
        : "";
    const showToolMeta =
      Boolean(ev.toolName) && ev.toolName?.toLowerCase() !== "call_mcp_tool";
    const narrative = extractFullNarrative(ev);

    const buildBody = (jsonOpenByDefault: boolean) => `
      <div class="insp-meta">
        <span><b>Actor:</b> ${escHtml(actorDisplay)}</span>
        ${targetDisplay ? `<span><b>Target:</b> ${escHtml(targetDisplay)}</span>` : ""}
        ${showToolMeta ? `<span><b>Tool:</b> <code>${escHtml(ev.toolName)}</code></span>` : ""}
        <span><b>Time:</b> ${escHtml(fmtClock(ev.ts || ev.epoch))}</span>
      </div>
      <div class="insp-summary insp-narrative">${escHtml(narrative)}</div>
      <details class="insp-def-details" ${jsonOpenByDefault ? "open" : ""}>
        <summary>Raw Telemetry Payload (JSON)</summary>
        <div class="insp-pre-wrap" role="region" tabindex="0" aria-label="Event JSON payload">
          <pre class="insp-pre"><code>${escHtml(payloadJson)}</code></pre>
        </div>
      </details>
    `;

    const inlineBodyHtml = buildBody(false);
    const modalBodyHtml = buildBody(true);

    this.lastMarkup = { headerTitleHtml, inlineBodyHtml, modalBodyHtml };
    this.renderInline(headerTitleHtml, inlineBodyHtml);
    if (opts.openSheet) {
      this.openModal();
    } else if (this.dialog.open) {
      this.syncDialogContent();
    }
  }

  public renderAgent(agent: AgentNodeSnapshot, opts: InspectRenderOptions = {}): void {
    const ide = getIdeMeta(agent.ide);
    const st = getStatusStyle(agent.status);
    const def = opts.definition;
    const displayName = formatActorName(agent.id, opts.labelMap, agent.label);

    const meaningfulRecent = (agent.recentActions ?? [])
      .filter((r) => !r.routineEnd)
      .slice(-8)
      .reverse();

    this.lastCopyText = JSON.stringify(
      def ? { agent, definition: def } : agent,
      null,
      2
    );

    const modelLabel = agent.usage?.model || agent.model || "";
    const usage = agent.usage;
    const zone = usage ? getContextZone(usage.contextPercent) : null;

    const headerTitleHtml = `
      <span class="insp-title">${escHtml(displayName)}</span>
      <span class="s-status ${st.cssClass}">${st.label}</span>
      <span class="ide-chip" style="color:${ide.color};border-color:${ide.border};background:${ide.bg}">${escHtml(ide.label)}</span>
      ${modelLabel && modelLabel !== "Unknown" ? `<span class="usage-model-pill">${escHtml(trunc(modelLabel, 26))}</span>` : ""}
    `;

    // Deduplicate roleType vs boardRole (e.g. prevent `qa` + `qa`)
    const roleTypeLabel = (def?.roleType ?? "").trim();
    const boardRoleLabel = (def?.boardRole ?? "").trim();
    const showBoardRole =
      Boolean(boardRoleLabel) &&
      boardRoleLabel.toLowerCase() !== roleTypeLabel.toLowerCase();

    const defTools = def?.tools ?? def?.capabilities ?? [];
    const defBlockHtml = def
      ? `
        <div class="insp-def-box">
          <div class="insp-def-head">
            <span class="pill board">${escHtml(roleTypeLabel || "agent")}</span>
            ${showBoardRole ? `<span class="pill dispatch">${escHtml(boardRoleLabel)}</span>` : ""}
            <span class="pill tool">${escHtml(def.source_ide)}</span>
            <span class="muted">~${def.est_tokens} tokens</span>
          </div>
          ${def.description ? `<div class="insp-def-desc">${escHtml(cleanSummaryText(def.description))}</div>` : ""}
          ${
            defTools.length > 0
              ? `<div class="chip-wrap">${defTools
                  .map((t) => `<span class="cap-chip">${escHtml(t)}</span>`)
                  .join("")}</div>`
              : ""
          }
          ${
            def.preview
              ? `<details class="insp-def-details">
                  <summary>Prompt Preview (<code>${escHtml(def.source_path)}</code>)</summary>
                  <div class="insp-pre-wrap" role="region" tabindex="0" aria-label="Agent prompt preview">
                    <pre class="insp-pre"><code>${escHtml(def.preview)}</code></pre>
                  </div>
                </details>`
              : ""
          }
        </div>
      `
      : "";

    const recentHtml =
      meaningfulRecent.length > 0
        ? `
          <div class="insp-activity-section">
            <div class="insp-activity-hdr">Recent Activity</div>
            <div class="insp-activity-list" role="list">
              ${meaningfulRecent
                .map((r) => {
                  const rCls = classifyEventReadable({
                    kind: r.kind,
                    toolName: r.toolName,
                    summary: r.text,
                    payload: r.isError ? { isError: true } : undefined,
                  });
                  const cleanText = truncateWords(
                    cleanSummaryText(r.text) || rCls.humanTitle,
                    160
                  );
                  return `
                    <div class="insp-act-row" role="listitem">
                      <span class="insp-act-time">${escHtml(fmtClock(r.ts))}</span>
                      <span class="pill ${rCls.cssClass}">${escHtml(rCls.badge)}</span>
                      <span class="insp-act-text">${escHtml(cleanText)}</span>
                    </div>
                  `;
                })
                .join("")}
            </div>
          </div>
        `
        : "";

    const bodyHtml = `
      <div class="insp-meta">
        <span><b>ID:</b> <code>${escHtml(agent.id)}</code></span>
        <span><b>Tools:</b> ${agent.toolCalls}</span>
        <span><b>Msgs:</b> ${agent.messagesSent}↑ / ${agent.messagesReceived}↓</span>
        ${
          usage && zone
            ? `<span><b>Tokens:</b> <code>${fmtTokens(usage.totalTokens)}</code> · <span class="zone-pill zone-${zone.cssClass}">${usage.contextPercent.toFixed(1)}% / ${fmtContextWindow(usage.contextWindow)} (${escHtml(zone.label)})</span></span>`
            : ""
        }
        ${agent.activeTool ? `<span><b>Active:</b> <code>${escHtml(agent.activeTool)}</code></span>` : ""}
      </div>
      <div class="insp-summary">${escHtml(cleanSummaryText(agent.summary || agent.role || "Standby"))}</div>
      ${defBlockHtml}
      ${recentHtml}
    `;

    this.lastMarkup = {
      headerTitleHtml,
      inlineBodyHtml: bodyHtml,
      modalBodyHtml: bodyHtml,
    };
    this.renderInline(headerTitleHtml, bodyHtml);
    if (opts.openSheet) {
      this.openModal();
    } else if (this.dialog.open) {
      this.syncDialogContent();
    }
  }

  private renderInline(headerTitleHtml: string, bodyHtml: string): void {
    this.container.setAttribute("data-inspector-state", "open");
    this.container.innerHTML = `
      <div class="insp-head">
        <div class="insp-title-row">${headerTitleHtml}</div>
        <div class="insp-head-actions">
          <button type="button" class="copy-btn" data-copy-payload>Copy JSON</button>
          <button type="button" class="insp-icon-btn" data-expand-payload title="Expand full payload viewer" aria-label="Expand payload viewer">⤢</button>
          <button type="button" class="insp-icon-btn" data-close-payload title="Collapse inspector" aria-label="Close inspector">✕</button>
        </div>
      </div>
      <div class="insp-inline-body">${bodyHtml}</div>
    `;

    const copyBtn = this.container.querySelector<HTMLButtonElement>("[data-copy-payload]");
    copyBtn?.addEventListener("click", () => {
      if (copyBtn) void this.handleCopyClick(copyBtn);
    });
    this.container
      .querySelector("[data-expand-payload]")
      ?.addEventListener("click", () => this.openModal());
    this.container.querySelector("[data-close-payload]")?.addEventListener("click", () => {
      this.renderEmpty();
      this.cb.onClose?.();
    });
  }

  private syncDialogContent(): void {
    if (!this.lastMarkup) return;
    const titleEl = this.dialog.querySelector("[data-dlg-title]");
    const bodyEl = this.dialog.querySelector("[data-dlg-body]");
    if (titleEl) titleEl.innerHTML = this.lastMarkup.headerTitleHtml;
    if (bodyEl) bodyEl.innerHTML = this.lastMarkup.modalBodyHtml;
  }

  private async handleCopyClick(btn: HTMLButtonElement): Promise<void> {
    if (!this.lastCopyText) return;
    const ok = await copyTextSafe(this.lastCopyText);
    btn.textContent = ok ? "Copied ✓" : "Copy failed";
    btn.classList.toggle("copied", ok);
    window.setTimeout(() => {
      btn.textContent = "Copy JSON";
      btn.classList.remove("copied");
    }, 1600);
  }
}
