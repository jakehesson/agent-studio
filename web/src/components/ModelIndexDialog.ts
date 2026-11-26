import { patchModelIndex, putModelIndex } from "../api.js";
import type {
  EmbedScope,
  HostIde,
  IdeTierBinding,
  ModelCapabilityTag,
  ModelCatalogEntry,
  ModelIndex,
  ModelIndexView,
  ModelSelectionCriterion,
  ModelSourceTag,
  ModelTier,
  RoleRecommendation,
} from "../types.js";
import { escHtml, fmtContextWindow, getIdeMeta } from "../utils.js";

type DialogTab = HostIde | "roles" | "raw-json";
type TierFilter = "all" | ModelTier;
type SourceFilter = "all" | ModelSourceTag;

const ALL_IDES: HostIde[] = ["antigravity", "claude-code", "copilot-vscode"];
const ALL_TIERS: ModelTier[] = ["fast", "balanced", "reasoning"];
const ALL_CAPABILITIES: ModelCapabilityTag[] = [
  "coding",
  "reasoning",
  "multimodal",
  "fast",
  "orchestration",
  "search",
  "long-context",
];
const ALL_SOURCES: ModelSourceTag[] = ["built-in", "vscode-lm", "agent", "user"];

const IDE_HOST_HINTS: Record<HostIde, string> = {
  antigravity:
    "Uses portable tier enums (flash_lite, flash, pro, inherit). Respects Antigravity /swarm & UI model picker.",
  "claude-code":
    "Uses family aliases (haiku, sonnet, opus, inherit). Yields to CLAUDE_CODE_SUBAGENT_MODEL & /model.",
  "copilot-vscode":
    "Uses ordered Copilot runtime model IDs + model-policy: preferred (or omits model on defer-to-host for Fusion / Auto).",
};

const IDE_ENTRY_EXAMPLES: Record<HostIde, { desc: string; example: string }> = {
  antigravity: {
    desc: "Exact tier enum or model ID",
    example: "gemini-4-argon",
  },
  "claude-code": {
    desc: "Exact family alias or model ID",
    example: "sonnet",
  },
  "copilot-vscode": {
    desc: "Runtime Copilot model ID",
    example: "claude-sonnet-4.6",
  },
};

function formatSelectionPriority(priority?: readonly ModelSelectionCriterion[]): string {
  const list = priority && priority.length > 0 ? priority : ["accuracy", "cost", "speed"];
  return list
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : ""))
    .filter(Boolean)
    .join(" → ");
}

function shellQuote(arg: string): string {
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
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

function cloneTiers(
  tiers: Record<ModelTier, IdeTierBinding>
): Record<ModelTier, IdeTierBinding> {
  return {
    fast: { ...tiers.fast, fallback: [...tiers.fast.fallback] },
    balanced: { ...tiers.balanced, fallback: [...tiers.balanced.fallback] },
    reasoning: { ...tiers.reasoning, fallback: [...tiers.reasoning.fallback] },
  };
}

export interface ModelIndexDialogCallbacks {
  onUpdated: (view: ModelIndexView) => void;
}

export class ModelIndexDialog {
  private dialog: HTMLDialogElement;
  private callbacks: ModelIndexDialogCallbacks;

  private projectId = "";
  private workspace = "";
  private embedScope: EmbedScope = {
    embedMode: false,
    lockedIde: null,
    lockedWorkspace: "",
  };
  private view: ModelIndexView | null = null;
  private activeTab: DialogTab = "antigravity";
  private targetScope: "workspace" | "global" = "workspace";
  private syncOnSave = true;
  private tierFilter: TierFilter = "all";
  private sourceFilter: SourceFilter = "all";
  private draftTiers: Record<HostIde, Record<ModelTier, IdeTierBinding>> | null = null;
  private draftRoles: Record<string, RoleRecommendation> = {};

  private editingEntry: {
    id: string;
    label: string;
    tier: ModelTier;
    vendor: string;
    family: string;
    capabilities: Set<ModelCapabilityTag>;
    available: boolean;
    notes: string;
  } = {
    id: "",
    label: "",
    tier: "balanced",
    vendor: "",
    family: "",
    capabilities: new Set(["coding"]),
    available: true,
    notes: "",
  };

  private busy = false;
  private confirmResetPending = false;
  private statusMessage: { kind: "ok" | "error" | "info"; text: string } | null = null;

  constructor(callbacks: ModelIndexDialogCallbacks) {
    this.callbacks = callbacks;

    const dlg = document.createElement("dialog");
    dlg.className = "model-index-dialog";
    dlg.setAttribute("closedby", "any");
    dlg.setAttribute("aria-labelledby", "modelIndexDialogTitle");
    dlg.innerHTML = `
      <div class="insp-sheet-shell mi-shell">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="insp-sheet-head">
          <div class="insp-title-row">
            <h1 class="insp-title mi-dialog-h1" id="modelIndexDialogTitle">Model Index Inspector &amp; Editor</h1>
            <span class="pill dispatch" data-mi-header-badge>Layer Merge</span>
          </div>
          <div class="insp-head-actions">
            <button type="button" class="insp-icon-btn" data-mi-close aria-label="Close Model Index dialog">✕</button>
          </div>
        </div>
        <div class="insp-sheet-body mi-body" data-mi-body></div>
      </div>
    `;
    document.body.appendChild(dlg);
    this.dialog = dlg;

    // Safari light-dismiss fallback requiring both press and release outside dialog box
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
      this.confirmResetPending = false;
    });

    dlg.querySelector("[data-mi-close]")?.addEventListener("click", () => dlg.close());
  }

  public dispose(): void {
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
  }

  public open(opts: {
    view: ModelIndexView;
    projectId: string;
    workspace: string;
    embedScope: EmbedScope;
    initialTab?: DialogTab;
  }): void {
    this.projectId = opts.projectId;
    this.workspace = opts.workspace;
    this.embedScope = { ...opts.embedScope };
    this.statusMessage = null;
    this.confirmResetPending = false;
    this.setViewData(opts.view);

    const allowedIdes = this.getVisibleIdes();
    if (opts.initialTab && this.isTabAllowed(opts.initialTab)) {
      this.activeTab = opts.initialTab;
    } else if (!this.isTabAllowed(this.activeTab)) {
      this.activeTab = allowedIdes[0] ?? "roles";
    }

    this.render();
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
  }

  public updateContext(opts: {
    view?: ModelIndexView;
    projectId?: string;
    workspace?: string;
    embedScope?: EmbedScope;
  }): void {
    if (opts.projectId !== undefined) this.projectId = opts.projectId;
    if (opts.workspace !== undefined) this.workspace = opts.workspace;
    if (opts.embedScope) this.embedScope = { ...opts.embedScope };
    if (opts.view) this.setViewData(opts.view);
    if (!this.isTabAllowed(this.activeTab)) {
      this.activeTab = this.getVisibleIdes()[0] ?? "roles";
    }
    if (this.dialog.open) {
      this.render();
    }
  }

  private setViewData(view: ModelIndexView): void {
    this.view = view;
    this.draftTiers = {
      antigravity: cloneTiers(view.effective.ides.antigravity.tiers),
      "claude-code": cloneTiers(view.effective.ides["claude-code"].tiers),
      "copilot-vscode": cloneTiers(view.effective.ides["copilot-vscode"].tiers),
    };
    this.draftRoles = {};
    for (const [k, v] of Object.entries(view.effective.roleRecommendations)) {
      this.draftRoles[k] = { ...v };
    }
  }

  private getVisibleIdes(): HostIde[] {
    return this.embedScope.lockedIde ? [this.embedScope.lockedIde] : ALL_IDES;
  }

  private isTabAllowed(tab: DialogTab): boolean {
    if (tab === "roles" || tab === "raw-json") return true;
    return this.getVisibleIdes().includes(tab);
  }

  private getScopedRawJson(): string {
    if (!this.view) return "{}";
    const eff = this.view.effective;
    if (!this.embedScope.lockedIde) {
      return JSON.stringify(eff, null, 2);
    }
    const ide = this.embedScope.lockedIde;
    const scoped: Partial<ModelIndex> = {
      schemaVersion: eff.schemaVersion,
      updatedAt: eff.updatedAt,
      updatedBy: eff.updatedBy,
      notes: eff.notes,
      roleRecommendations: eff.roleRecommendations,
      ides: { [ide]: eff.ides[ide] } as ModelIndex["ides"],
    };
    return JSON.stringify(scoped, null, 2);
  }

  private render(restoreFocusSelector?: string): void {
    const body = this.dialog.querySelector<HTMLElement>("[data-mi-body]");
    if (!body || !this.view || !this.draftTiers) return;

    body.setAttribute("aria-busy", this.busy ? "true" : "false");

    const badge = this.dialog.querySelector<HTMLElement>("[data-mi-header-badge]");
    if (badge) {
      const layers = this.view.layers;
      badge.textContent = layers.workspaceExists
        ? "Workspace Overlay"
        : layers.globalExists
          ? "Global Overlay"
          : "Built-in Seed";
    }

    const visibleIdes = this.getVisibleIdes();
    const isMcp = Boolean(this.embedScope.mcpAppMode);

    const tabs: Array<{ id: DialogTab; label: string }> = [
      ...visibleIdes.map((ide) => ({ id: ide as DialogTab, label: getIdeMeta(ide).label })),
      { id: "roles", label: "Role Defaults" },
      { id: "raw-json", label: "Raw JSON" },
    ];

    const cliScopeFlag = this.targetScope === "global" ? "--scope global" : "--scope workspace";
    const cliTargetIde = visibleIdes[0] ?? "antigravity";
    const cliCmd =
      this.activeTab === "roles"
        ? `agent-studio models set-role architect --tier reasoning --sync`
        : this.activeTab === "raw-json"
          ? `agent-studio models show --ide ${cliTargetIde} --json`
          : `agent-studio models set-tier ${this.activeTab} balanced ${shellQuote(this.draftTiers[this.activeTab].balanced.primary)} ${cliScopeFlag} --sync`;

    body.innerHTML = `
      <div class="mi-toolbar">
        <div class="guide-tabs mi-tabs" role="tablist" aria-label="Model Index sections">
          ${tabs
            .map(
              (t) => `
                <button
                  type="button"
                  role="tab"
                  id="mi-tab-${escHtml(t.id)}"
                  class="guide-tab"
                  data-mi-tab="${escHtml(t.id)}"
                  aria-controls="mi-tabpanel"
                  aria-selected="${this.activeTab === t.id ? "true" : "false"}"
                  tabindex="${this.activeTab === t.id ? "0" : "-1"}"
                >${escHtml(t.label)}</button>
              `
            )
            .join("")}
        </div>
      </div>

      ${
        isMcp
          ? `
            <div class="mi-mcp-banner" role="note">
              <div class="mi-mcp-copy">
                <strong>Read-Only MCP App Mode</strong>
                <span class="muted">Use the Agent Studio CLI to persist Model Index edits from your terminal:</span>
              </div>
              <div class="mi-cli-row">
                <div class="code-scroll cp-cmd-scroll" role="region" tabindex="0" aria-label="CLI model command"><code>${escHtml(cliCmd)}</code></div>
                <button type="button" class="guide-copy-btn" data-mi-copy-cli="${escHtml(cliCmd)}">Copy CLI</button>
              </div>
            </div>
          `
          : `
            <div class="mi-scope-bar">
              <fieldset class="mi-scope-fieldset">
                <legend class="sr-only">Target overlay layer</legend>
                <label class="mi-radio-label">
                  <input type="radio" name="miScope" value="workspace" ${this.targetScope === "workspace" ? "checked" : ""} />
                  <span>Workspace <code>.agent-team/model-index.json</code></span>
                </label>
                <label class="mi-radio-label">
                  <input type="radio" name="miScope" value="global" ${this.targetScope === "global" ? "checked" : ""} />
                  <span>Global <code>~/.agent-studio/model-index.json</code></span>
                </label>
              </fieldset>
              <div class="mi-scope-actions">
                ${
                  this.targetScope === "workspace"
                    ? `
                      <label class="mi-check-label">
                        <input type="checkbox" data-mi-sync-toggle ${this.syncOnSave ? "checked" : ""} />
                        <span>Sync IDEs on save</span>
                      </label>
                    `
                    : ""
                }
                ${
                  this.confirmResetPending
                    ? `
                      <div class="mi-reset-confirm" role="group" aria-label="Confirm overlay reset">
                        <button type="button" class="btn-secondary btn-sm" data-mi-reset-cancel ${this.busy ? "disabled" : ""}>Cancel</button>
                        <button type="button" class="btn-danger btn-sm" data-mi-reset-confirm ${this.busy ? "disabled" : ""}>Confirm Reset</button>
                      </div>
                    `
                    : `
                      <button type="button" class="btn-secondary btn-sm" data-mi-reset-ask ${this.busy ? "disabled" : ""}>Reset to Defaults</button>
                    `
                }
              </div>
            </div>
          `
      }

      <div class="mi-status-slot" role="status" aria-live="polite" data-mi-status>
        ${this.renderStatusHtml()}
      </div>

      <div
        class="mi-tab-panel"
        id="mi-tabpanel"
        role="tabpanel"
        tabindex="0"
        aria-labelledby="mi-tab-${escHtml(this.activeTab)}"
        data-mi-panel
      >
        ${
          this.activeTab === "roles"
            ? this.renderRolesTab(isMcp)
            : this.activeTab === "raw-json"
              ? this.renderRawJsonTab()
              : this.renderIdeTab(this.activeTab, isMcp)
        }
      </div>
    `;

    this.bindEvents(body);
    if (restoreFocusSelector) {
      this.dialog.querySelector<HTMLElement>(restoreFocusSelector)?.focus();
    }
  }

  private renderStatusHtml(): string {
    if (!this.statusMessage) return "";
    const cls =
      this.statusMessage.kind === "ok"
        ? "ok"
        : this.statusMessage.kind === "error"
          ? "error"
          : "";
    const ico =
      this.statusMessage.kind === "ok"
        ? "✓"
        : this.statusMessage.kind === "error"
          ? "✕"
          : "•";
    return `<div class="issue-row ${cls}">
      <span>${ico}</span>
      <span>${escHtml(this.statusMessage.text)}</span>
    </div>`;
  }

  private setStatusInPlace(kind: "ok" | "error" | "info", text: string): void {
    this.statusMessage = { kind, text };
    const slot = this.dialog.querySelector<HTMLElement>("[data-mi-status]");
    if (slot) {
      slot.innerHTML = this.renderStatusHtml();
    }
  }

  private renderIdeTab(ide: HostIde, isMcp: boolean): string {
    if (!this.view || !this.draftTiers) return "";
    const ideCfg = this.view.effective.ides[ide];
    const tiers = this.draftTiers[ide];
    const catalogIds = Array.from(
      new Set([
        ...ideCfg.catalog.map((c) => c.id),
        ...ALL_TIERS.flatMap((t) => [tiers[t].primary, ...tiers[t].fallback]),
      ])
    ).filter(Boolean);

    const filteredCatalog = ideCfg.catalog.filter((entry) => {
      if (this.tierFilter !== "all" && entry.tier !== this.tierFilter) return false;
      if (this.sourceFilter !== "all" && entry.source !== this.sourceFilter) return false;
      return true;
    });

    const priorityLabel = formatSelectionPriority(
      this.view.effective.selectionPriority ?? this.view.routing.selectionPriority
    );

    return `
      <div class="mi-ide-section">
        <div class="mi-ide-meta-banner">
          <span class="pill dispatch">Mode: ${escHtml(ideCfg.mode)}</span>
          <span class="pill tool" title="Deterministic candidate ranking order">Priority: ${escHtml(priorityLabel)}</span>
          ${
            ideCfg.syncSource
              ? `<span class="pill tool">Source: ${escHtml(ideCfg.syncSource)}</span>`
              : ""
          }
          ${
            ideCfg.lastSyncedAt
              ? `<span class="muted">Last synced: <code>${escHtml(ideCfg.lastSyncedAt)}</code></span>`
              : ""
          }
          <span class="mi-host-hint muted">${escHtml(IDE_HOST_HINTS[ide])}</span>
        </div>

        <section class="mi-subsec" aria-labelledby="miTiersHeading">
          <div class="mi-subsec-head">
            <h2 id="miTiersHeading">Tier Bindings (${escHtml(getIdeMeta(ide).label)})</h2>
            ${
              !isMcp
                ? `<button type="button" class="btn-primary btn-sm" data-mi-save-tiers="${escHtml(ide)}" ${this.busy ? "disabled" : ""}>${this.busy ? "Saving…" : "Save Tier Bindings"}</button>`
                : ""
            }
          </div>
          <div class="model-tiers-grid">
            ${ALL_TIERS.map((tier) =>
              this.renderTierCard(ide, tier, tiers[tier], catalogIds, isMcp)
            ).join("")}
          </div>
        </section>

        <section class="mi-subsec" aria-labelledby="miCatalogHeading">
          <div class="mi-subsec-head">
            <h2 id="miCatalogHeading">Merged Model Catalog (${filteredCatalog.length} / ${ideCfg.catalog.length})</h2>
          </div>

          <div class="mi-filter-bars">
            <div class="source-filter-bar" role="group" aria-label="Filter catalog by tier">
              ${(["all", ...ALL_TIERS] as TierFilter[])
                .map(
                  (tf) => `
                    <button
                      type="button"
                      class="filter-chip"
                      data-mi-tier-filter="${tf}"
                      aria-pressed="${this.tierFilter === tf ? "true" : "false"}"
                    >${tf === "all" ? "All Tiers" : tf.toUpperCase()}</button>
                  `
                )
                .join("")}
            </div>
            <div class="source-filter-bar" role="group" aria-label="Filter catalog by source">
              ${(["all", ...ALL_SOURCES] as SourceFilter[])
                .map(
                  (sf) => `
                    <button
                      type="button"
                      class="filter-chip"
                      data-mi-src-filter="${sf}"
                      aria-pressed="${this.sourceFilter === sf ? "true" : "false"}"
                    >${sf === "all" ? "All Sources" : escHtml(sf)}</button>
                  `
                )
                .join("")}
            </div>
          </div>

          ${
            filteredCatalog.length === 0
              ? `<div class="empty-state">
                  <span>No catalog entries match the current filters.</span>
                  <button type="button" class="btn-secondary btn-sm" data-mi-reset-filters>Reset Filters</button>
                </div>`
              : `<div class="model-catalog-grid">
                  ${filteredCatalog
                    .map((entry) => this.renderCatalogCard(entry, isMcp))
                    .join("")}
                </div>`
          }
        </section>

        ${isMcp ? "" : this.renderCatalogForm(ide)}
      </div>
    `;
  }

  private renderTierCard(
    ide: HostIde,
    tier: ModelTier,
    binding: IdeTierBinding,
    catalogIds: string[],
    isMcp: boolean
  ): string {
    const primaryId = `mi-primary-${ide}-${tier}`;
    const addFbId = `mi-addfb-${ide}-${tier}`;
    const remainingIds = catalogIds.filter((id) => !binding.fallback.includes(id));

    return `
      <article class="model-tier-card">
        <div class="model-tier-head">
          <span class="tier-pill tier-${tier}">${escHtml(tier.toUpperCase())}</span>
          ${
            binding.omitOnDefer
              ? `<span class="pill ok">Omit on Defer</span>`
              : ""
          }
        </div>

        <div class="mi-field">
          <label for="${primaryId}">Primary Model</label>
          <select
            id="${primaryId}"
            class="ctx-select mi-select"
            data-mi-primary="${escHtml(tier)}"
            ${isMcp ? "disabled" : ""}
          >
            ${catalogIds
              .map(
                (id) =>
                  `<option value="${escHtml(id)}" ${binding.primary === id ? "selected" : ""}>${escHtml(id)}</option>`
              )
              .join("")}
          </select>
        </div>

        <div class="mi-field">
          <span class="mi-field-lbl">Ordered Fallback Chain</span>
          ${
            binding.fallback.length === 0
              ? `<div class="muted mi-empty-fb">No fallbacks configured</div>`
              : `<ol class="mi-fallback-list">
                  ${binding.fallback
                    .map(
                      (fbId, idx) => `
                        <li class="mi-fallback-item">
                          <span class="mi-fb-rank">${idx + 1}.</span>
                          <code class="mi-fb-id">${escHtml(fbId)}</code>
                          ${
                            isMcp
                              ? ""
                              : `<span class="mi-fb-actions">
                                  <button type="button" class="mi-mini-btn" data-mi-fb-up="${escHtml(tier)}:${idx}" aria-label="Move ${escHtml(fbId)} up" ${idx === 0 ? "disabled" : ""}>↑</button>
                                  <button type="button" class="mi-mini-btn" data-mi-fb-down="${escHtml(tier)}:${idx}" aria-label="Move ${escHtml(fbId)} down" ${idx === binding.fallback.length - 1 ? "disabled" : ""}>↓</button>
                                  <button type="button" class="mi-mini-btn" data-mi-fb-del="${escHtml(tier)}:${idx}" aria-label="Remove ${escHtml(fbId)}">✕</button>
                                </span>`
                          }
                        </li>
                      `
                    )
                    .join("")}
                </ol>`
          }
        </div>

        ${
          isMcp
            ? ""
            : `
              <div class="mi-add-fb-row">
                <label class="sr-only" for="${addFbId}">Add fallback model for ${escHtml(tier)}</label>
                <select id="${addFbId}" class="ctx-select mi-select" data-mi-fb-select="${escHtml(tier)}">
                  ${
                    remainingIds.length === 0
                      ? `<option value="">All catalog models added</option>`
                      : remainingIds
                          .map((id) => `<option value="${escHtml(id)}">${escHtml(id)}</option>`)
                          .join("")
                  }
                </select>
                <button
                  type="button"
                  class="btn-secondary btn-sm"
                  data-mi-fb-add="${escHtml(tier)}"
                  ${remainingIds.length === 0 ? "disabled" : ""}
                >Add</button>
              </div>
              <label class="mi-check-label">
                <input type="checkbox" data-mi-omit-defer="${escHtml(tier)}" ${binding.omitOnDefer ? "checked" : ""} />
                <span>Omit frontmatter on <code>defer-to-host</code></span>
              </label>
            `
        }
      </article>
    `;
  }

  private renderCatalogCard(entry: ModelCatalogEntry, isMcp: boolean): string {
    const availClass = entry.available ? "ok" : "blocker";
    const availText = entry.available ? "✓ Available" : "○ Unavailable";
    const ctxText = entry.contextWindow ? `${fmtContextWindow(entry.contextWindow)} ctx` : "";
    const multText =
      entry.premiumMultiplier !== undefined ? `${entry.premiumMultiplier}x` : "";
    const accText =
      typeof entry.accuracyRank === "number" && Number.isFinite(entry.accuracyRank)
        ? `Acc ${entry.accuracyRank}`
        : "";

    return `
      <article class="model-catalog-card ${entry.deprecated ? "is-deprecated" : ""}">
        <div class="mi-cat-head">
          <div class="mi-cat-title">
            <strong>${escHtml(entry.label)}</strong>
            <code class="mi-cat-id">${escHtml(entry.id)}</code>
          </div>
          <div class="mi-cat-badges">
            <span class="tier-pill tier-${entry.tier}">${escHtml(entry.tier)}</span>
            ${
              entry.deprecated
                ? `<span class="pill human mi-deprecated-pill" title="Legacy superseded model — ranked below modern models">Deprecated</span>`
                : ""
            }
            <span class="pill ${availClass}">${availText}</span>
          </div>
        </div>
        <div class="mi-cat-meta">
          <span class="pill tool">${escHtml(entry.source)}</span>
          ${entry.vendor ? `<span>Vendor: <b>${escHtml(entry.vendor)}</b></span>` : ""}
          ${entry.family ? `<span>Family: <code>${escHtml(entry.family)}</code></span>` : ""}
          ${ctxText ? `<span>${escHtml(ctxText)}</span>` : ""}
          ${multText ? `<span>Multiplier: <b>${escHtml(multText)}</b></span>` : ""}
          ${accText ? `<span>${escHtml(accText)}</span>` : ""}
        </div>
        ${
          entry.capabilities.length > 0
            ? `<div class="chip-wrap">${entry.capabilities
                .map((c) => `<span class="cap-chip">${escHtml(c)}</span>`)
                .join("")}</div>`
            : ""
        }
        ${entry.notes ? `<p class="mi-cat-notes muted">${escHtml(entry.notes)}</p>` : ""}
        ${
          !isMcp
            ? `<div class="mi-cat-foot">
                <button type="button" class="btn-secondary btn-sm" data-mi-edit-entry="${escHtml(entry.id)}">Edit Entry</button>
              </div>`
            : ""
        }
      </article>
    `;
  }

  private renderCatalogForm(ide: HostIde): string {
    const e = this.editingEntry;
    const hintMeta = IDE_ENTRY_EXAMPLES[ide];
    return `
      <section class="mi-subsec mi-form-card" aria-labelledby="miCatalogFormHeading">
        <h2 id="miCatalogFormHeading">Add / Update Catalog Entry (${escHtml(getIdeMeta(ide).label)})</h2>
        <form class="mi-catalog-form" data-mi-catalog-form novalidate>
          <div class="model-add-grid">
            <div class="mi-field">
              <label for="miEntryId">Model ID <span aria-hidden="true">*</span></label>
              <input
                type="text"
                id="miEntryId"
                name="id"
                class="feedback-input"
                value="${escHtml(e.id)}"
                required
                autocorrect="off"
                autocapitalize="none"
                spellcheck="false"
                enterkeyhint="next"
                aria-describedby="miEntryIdHelp"
              />
              <span id="miEntryIdHelp" class="mi-help muted">${escHtml(hintMeta.desc)} (e.g. <code>${escHtml(hintMeta.example)}</code>)</span>
            </div>

            <div class="mi-field">
              <label for="miEntryLabel">Display Label <span aria-hidden="true">*</span></label>
              <input
                type="text"
                id="miEntryLabel"
                name="label"
                class="feedback-input"
                value="${escHtml(e.label)}"
                required
                enterkeyhint="next"
              />
            </div>

            <div class="mi-field">
              <label for="miEntryTier">Tier</label>
              <select id="miEntryTier" name="tier" class="ctx-select mi-select">
                ${ALL_TIERS.map(
                  (t) =>
                    `<option value="${t}" ${e.tier === t ? "selected" : ""}>${t.toUpperCase()}</option>`
                ).join("")}
              </select>
            </div>

            <div class="mi-field">
              <label for="miEntryVendor">Vendor</label>
              <input
                type="text"
                id="miEntryVendor"
                name="vendor"
                class="feedback-input"
                value="${escHtml(e.vendor)}"
                autocorrect="off"
                autocapitalize="none"
                spellcheck="false"
              />
            </div>

            <div class="mi-field">
              <label for="miEntryFamily">Family</label>
              <input
                type="text"
                id="miEntryFamily"
                name="family"
                class="feedback-input"
                value="${escHtml(e.family)}"
                autocorrect="off"
                autocapitalize="none"
                spellcheck="false"
              />
            </div>

            <div class="mi-field">
              <label for="miEntryNotes">Notes</label>
              <input
                type="text"
                id="miEntryNotes"
                name="notes"
                class="feedback-input"
                value="${escHtml(e.notes)}"
              />
            </div>
          </div>

          <fieldset class="mi-cap-fieldset">
            <legend>Capabilities</legend>
            <div class="mi-cap-grid">
              ${ALL_CAPABILITIES.map(
                (cap) => `
                  <label class="mi-check-label">
                    <input type="checkbox" name="capabilities" value="${cap}" ${e.capabilities.has(cap) ? "checked" : ""} />
                    <span>${escHtml(cap)}</span>
                  </label>
                `
              ).join("")}
            </div>
          </fieldset>

          <div class="mi-form-actions">
            <label class="mi-check-label">
              <input type="checkbox" name="available" ${e.available ? "checked" : ""} />
              <span>Available on this machine</span>
            </label>
            <div class="mi-form-btns">
              <button type="button" class="btn-secondary btn-sm" data-mi-clear-form>Clear</button>
              <button type="submit" class="btn-primary btn-sm" ${this.busy ? "disabled" : ""}>Save Catalog Entry</button>
            </div>
          </div>
        </form>
      </section>
    `;
  }

  private renderRolesTab(isMcp: boolean): string {
    if (!this.view) return "";
    const entries = Object.entries(this.draftRoles);
    const lockedIde = this.embedScope.lockedIde;
    const visibleIdes = this.getVisibleIdes();

    return `
      <section class="mi-subsec" aria-labelledby="miRolesHeading">
        <div class="mi-subsec-head">
          <h2 id="miRolesHeading">Canonical Role Tier Recommendations (${entries.length})</h2>
          ${
            !isMcp
              ? `<button type="button" class="btn-primary btn-sm" data-mi-save-roles ${this.busy ? "disabled" : ""}>${this.busy ? "Saving…" : "Save Role Defaults"}</button>`
              : ""
          }
        </div>
        <div class="mi-roles-list">
          ${entries
            .map(([roleId, rec]) => {
              const roleResolved = this.view?.routing.resolvedRoles[roleId]?.resolved;
              const selectId = `mi-role-tier-${roleId}`;
              return `
                <article class="mi-role-row">
                  <div class="mi-role-copy">
                    <div class="mi-role-top">
                      <strong>${escHtml(roleId)}</strong>
                      ${
                        rec.deferToHostOrchestrator
                          ? `<span class="pill dispatch">Host Orchestrator Deferral</span>`
                          : ""
                      }
                      ${
                        rec.multimodalPreferred
                          ? `<span class="pill peer">Multimodal Preferred</span>`
                          : ""
                      }
                    </div>
                    <p class="muted">${escHtml(rec.rationale)}</p>
                    ${
                      roleResolved
                        ? `<div class="chip-wrap">
                            ${visibleIdes
                              .map((ide) => {
                                const res = roleResolved[ide];
                                if (!res) return "";
                                const m = getIdeMeta(ide);
                                const modelTxt = res.omitted
                                  ? "Omitted (Host Auto)"
                                  : Array.isArray(res.model)
                                    ? `${res.model[0] ?? "auto"} (+${Math.max(0, res.model.length - 1)})`
                                    : res.model;
                                return `<span class="ide-chip" style="color:${m.color};border-color:${m.border};background:${m.bg}">${escHtml(lockedIde ? `${m.label}: ${modelTxt}` : `${m.short}: ${modelTxt}`)}</span>`;
                              })
                              .join("")}
                          </div>`
                        : ""
                    }
                  </div>
                  <div class="mi-role-ctrl">
                    <label for="${selectId}">Default Tier</label>
                    <select
                      id="${selectId}"
                      class="ctx-select mi-select"
                      data-mi-role-tier="${escHtml(roleId)}"
                      ${isMcp ? "disabled" : ""}
                    >
                      ${ALL_TIERS.map(
                        (t) =>
                          `<option value="${t}" ${rec.tier === t ? "selected" : ""}>${t.toUpperCase()}</option>`
                      ).join("")}
                    </select>
                  </div>
                </article>
              `;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  private renderRawJsonTab(): string {
    const jsonText = this.getScopedRawJson();
    const scopeNote = this.embedScope.lockedIde
      ? `Scoped to ${getIdeMeta(this.embedScope.lockedIde).label} in embedded extension mode.`
      : "Merged effective Layer 0 (built-in) + Layer 1 (global) + Layer 2 (workspace).";

    return `
      <section class="mi-subsec" aria-labelledby="miRawJsonHeading">
        <div class="mi-subsec-head">
          <div>
            <h2 id="miRawJsonHeading">Agent-Readable Effective Model Index</h2>
            <p class="muted mi-raw-note">${escHtml(scopeNote)}</p>
          </div>
          <button type="button" class="copy-btn" data-mi-copy-json>Copy JSON</button>
        </div>
        <div class="insp-pre-wrap mi-json-wrap" role="region" tabindex="0" aria-label="Agent-readable Model Index JSON">
          <pre class="insp-pre"><code>${escHtml(jsonText)}</code></pre>
        </div>
      </section>
    `;
  }

  private bindEvents(body: HTMLElement): void {
    const tabBtns = Array.from(body.querySelectorAll<HTMLButtonElement>("[data-mi-tab]"));
    tabBtns.forEach((btn, idx) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.miTab as DialogTab | undefined;
        if (next && this.isTabAllowed(next) && next !== this.activeTab) {
          this.activeTab = next;
          this.render();
        }
      });
      btn.addEventListener("keydown", (e) => {
        let targetIdx = -1;
        if (e.key === "ArrowRight") targetIdx = (idx + 1) % tabBtns.length;
        else if (e.key === "ArrowLeft") targetIdx = (idx - 1 + tabBtns.length) % tabBtns.length;
        else if (e.key === "Home") targetIdx = 0;
        else if (e.key === "End") targetIdx = tabBtns.length - 1;
        if (targetIdx >= 0) {
          e.preventDefault();
          const targetBtn = tabBtns[targetIdx];
          const next = targetBtn?.dataset.miTab as DialogTab | undefined;
          if (targetBtn && next && this.isTabAllowed(next)) {
            this.activeTab = next;
            this.render();
            this.dialog
              .querySelector<HTMLButtonElement>(`[data-mi-tab="${next}"]`)
              ?.focus();
          }
        }
      });
    });

    body.querySelectorAll<HTMLInputElement>('input[name="miScope"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (radio.checked && (radio.value === "workspace" || radio.value === "global")) {
          this.targetScope = radio.value;
          this.confirmResetPending = false;
          this.render(`input[name="miScope"][value="${radio.value}"]`);
        }
      });
    });

    body
      .querySelector<HTMLInputElement>("[data-mi-sync-toggle]")
      ?.addEventListener("change", (ev) => {
        this.syncOnSave = (ev.target as HTMLInputElement).checked;
      });

    body.querySelector("[data-mi-reset-ask]")?.addEventListener("click", () => {
      this.confirmResetPending = true;
      this.render("[data-mi-reset-cancel]");
    });
    body.querySelector("[data-mi-reset-cancel]")?.addEventListener("click", () => {
      this.confirmResetPending = false;
      this.render("[data-mi-reset-ask]");
    });
    body.querySelector("[data-mi-reset-confirm]")?.addEventListener("click", () => {
      void this.handleReset();
    });

    body.querySelector<HTMLButtonElement>("[data-mi-copy-cli]")?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      const cmd = btn.dataset.miCopyCli ?? "";
      const ok = await copyText(cmd);
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      btn.classList.toggle("copied", ok);
      window.setTimeout(() => {
        btn.textContent = "Copy CLI";
        btn.classList.remove("copied");
      }, 1500);
    });

    body.querySelector<HTMLButtonElement>("[data-mi-copy-json]")?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      const ok = await copyText(this.getScopedRawJson());
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      btn.classList.toggle("copied", ok);
      window.setTimeout(() => {
        btn.textContent = "Copy JSON";
        btn.classList.remove("copied");
      }, 1500);
    });

    if (
      this.activeTab === "antigravity" ||
      this.activeTab === "claude-code" ||
      this.activeTab === "copilot-vscode"
    ) {
      const ide = this.activeTab;

      body.querySelectorAll<HTMLSelectElement>("[data-mi-primary]").forEach((sel) => {
        sel.addEventListener("change", () => {
          const tier = sel.dataset.miPrimary as ModelTier;
          if (this.draftTiers && tier) {
            this.draftTiers[ide][tier].primary = sel.value;
          }
        });
      });

      body.querySelectorAll<HTMLInputElement>("[data-mi-omit-defer]").forEach((chk) => {
        chk.addEventListener("change", () => {
          const tier = chk.dataset.miOmitDefer as ModelTier;
          if (this.draftTiers && tier) {
            this.draftTiers[ide][tier].omitOnDefer = chk.checked;
          }
        });
      });

      body.querySelectorAll<HTMLButtonElement>("[data-mi-fb-up]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const [tier, rawIdx] = (btn.dataset.miFbUp ?? "").split(":");
          const idx = Number(rawIdx);
          if (!this.draftTiers || !tier || idx <= 0) return;
          const arr = this.draftTiers[ide][tier as ModelTier].fallback;
          const prev = arr[idx - 1];
          const cur = arr[idx];
          if (prev !== undefined && cur !== undefined) {
            arr[idx - 1] = cur;
            arr[idx] = prev;
            const nextIdx = idx - 1;
            this.render(
              nextIdx > 0
                ? `[data-mi-fb-up="${tier}:${nextIdx}"]`
                : `[data-mi-fb-down="${tier}:${nextIdx}"]`
            );
          }
        });
      });

      body.querySelectorAll<HTMLButtonElement>("[data-mi-fb-down]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const [tier, rawIdx] = (btn.dataset.miFbDown ?? "").split(":");
          const idx = Number(rawIdx);
          if (!this.draftTiers || !tier) return;
          const arr = this.draftTiers[ide][tier as ModelTier].fallback;
          if (idx >= arr.length - 1) return;
          const next = arr[idx + 1];
          const cur = arr[idx];
          if (next !== undefined && cur !== undefined) {
            arr[idx + 1] = cur;
            arr[idx] = next;
            const nextIdx = idx + 1;
            this.render(
              nextIdx < arr.length - 1
                ? `[data-mi-fb-down="${tier}:${nextIdx}"]`
                : `[data-mi-fb-up="${tier}:${nextIdx}"]`
            );
          }
        });
      });

      body.querySelectorAll<HTMLButtonElement>("[data-mi-fb-del]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const [tier, rawIdx] = (btn.dataset.miFbDel ?? "").split(":");
          const idx = Number(rawIdx);
          if (!this.draftTiers || !tier) return;
          this.draftTiers[ide][tier as ModelTier].fallback.splice(idx, 1);
          this.render(`[data-mi-fb-select="${tier}"]`);
        });
      });

      body.querySelectorAll<HTMLButtonElement>("[data-mi-fb-add]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const tier = btn.dataset.miFbAdd as ModelTier;
          const sel = body.querySelector<HTMLSelectElement>(
            `[data-mi-fb-select="${tier}"]`
          );
          const val = sel?.value?.trim();
          if (!this.draftTiers || !tier || !val) return;
          const arr = this.draftTiers[ide][tier].fallback;
          if (!arr.includes(val)) arr.push(val);
          this.render(`[data-mi-fb-add="${tier}"]`);
        });
      });

      body.querySelector("[data-mi-save-tiers]")?.addEventListener("click", () => {
        void this.handleSaveTiers(ide);
      });

      body.querySelectorAll<HTMLButtonElement>("[data-mi-tier-filter]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const tf = btn.dataset.miTierFilter as TierFilter | undefined;
          if (tf && tf !== this.tierFilter) {
            this.tierFilter = tf;
            this.render(`[data-mi-tier-filter="${tf}"]`);
          }
        });
      });

      body.querySelectorAll<HTMLButtonElement>("[data-mi-src-filter]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const sf = btn.dataset.miSrcFilter as SourceFilter | undefined;
          if (sf && sf !== this.sourceFilter) {
            this.sourceFilter = sf;
            this.render(`[data-mi-src-filter="${sf}"]`);
          }
        });
      });

      body.querySelectorAll<HTMLButtonElement>("[data-mi-edit-entry]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.miEditEntry;
          const entry = this.view?.effective.ides[ide].catalog.find((c) => c.id === id);
          if (!entry) return;
          this.editingEntry = {
            id: entry.id,
            label: entry.label,
            tier: entry.tier,
            vendor: entry.vendor ?? "",
            family: entry.family ?? "",
            capabilities: new Set(entry.capabilities),
            available: entry.available,
            notes: entry.notes ?? "",
          };
          this.render();
          const labelInput = this.dialog.querySelector<HTMLInputElement>("#miEntryLabel");
          labelInput?.focus();
        });
      });

      body.querySelector("[data-mi-reset-filters]")?.addEventListener("click", () => {
        this.tierFilter = "all";
        this.sourceFilter = "all";
        this.render('[data-mi-tier-filter="all"]');
      });

      body.querySelector("[data-mi-clear-form]")?.addEventListener("click", () => {
        this.editingEntry = {
          id: "",
          label: "",
          tier: "balanced",
          vendor: "",
          family: "",
          capabilities: new Set(["coding"]),
          available: true,
          notes: "",
        };
        this.statusMessage = null;
        this.render("#miEntryId");
      });

      const form = body.querySelector<HTMLFormElement>("[data-mi-catalog-form]");
      if (form) {
        const validateRequired = (input: HTMLInputElement): boolean => {
          const ok = input.value.trim().length > 0;
          input.setAttribute("aria-invalid", ok ? "false" : "true");
          return ok;
        };
        const idInput = form.querySelector<HTMLInputElement>("#miEntryId");
        const labelInput = form.querySelector<HTMLInputElement>("#miEntryLabel");
        [idInput, labelInput].forEach((inp) => {
          if (!inp) return;
          inp.addEventListener("blur", () => {
            if (inp.value.length > 0) validateRequired(inp);
          });
          inp.addEventListener("input", () => {
            if (inp.getAttribute("aria-invalid") === "true" && inp.value.trim()) {
              inp.setAttribute("aria-invalid", "false");
            }
          });
        });

        form.addEventListener("submit", (ev) => {
          ev.preventDefault();
          const fd = new FormData(form);
          const idVal = String(fd.get("id") ?? "").trim();
          const labelVal = String(fd.get("label") ?? "").trim();
          const idOk = idInput ? validateRequired(idInput) : Boolean(idVal);
          const lblOk = labelInput ? validateRequired(labelInput) : Boolean(labelVal);
          if (!idOk) {
            this.setStatusInPlace("error", "Model ID is required.");
            idInput?.focus();
            return;
          }
          if (!lblOk) {
            this.setStatusInPlace("error", "Display Label is required.");
            labelInput?.focus();
            return;
          }
          const caps = fd
            .getAll("capabilities")
            .map(String)
            .filter((c): c is ModelCapabilityTag =>
              ALL_CAPABILITIES.includes(c as ModelCapabilityTag)
            );
          const existing = this.view?.effective.ides[ide].catalog.find(
            (c) => c.id === idVal
          );
          const entry: ModelCatalogEntry = {
            id: idVal,
            label: labelVal,
            tier: (String(fd.get("tier") ?? "balanced") as ModelTier) || "balanced",
            vendor: String(fd.get("vendor") ?? "").trim() || undefined,
            family: String(fd.get("family") ?? "").trim() || undefined,
            capabilities: caps,
            ...(existing?.contextWindow !== undefined
              ? { contextWindow: existing.contextWindow }
              : {}),
            ...(existing?.premiumMultiplier !== undefined
              ? { premiumMultiplier: existing.premiumMultiplier }
              : {}),
            ...(existing?.accuracyRank !== undefined
              ? { accuracyRank: existing.accuracyRank }
              : {}),
            ...(existing?.speedRank !== undefined
              ? { speedRank: existing.speedRank }
              : {}),
            ...(existing?.deprecated !== undefined
              ? { deprecated: existing.deprecated }
              : {}),
            available: fd.get("available") !== null,
            source: "user",
            notes: String(fd.get("notes") ?? "").trim() || undefined,
          };
          void this.handleSaveCatalogEntry(ide, entry);
        });
      }
    }

    if (this.activeTab === "roles") {
      body.querySelectorAll<HTMLSelectElement>("[data-mi-role-tier]").forEach((sel) => {
        sel.addEventListener("change", () => {
          const roleId = sel.dataset.miRoleTier;
          if (roleId && this.draftRoles[roleId]) {
            this.draftRoles[roleId].tier = sel.value as ModelTier;
          }
        });
      });
      body.querySelector("[data-mi-save-roles]")?.addEventListener("click", () => {
        void this.handleSaveRoles();
      });
    }
  }

  private async handleSaveTiers(ide: HostIde): Promise<void> {
    if (!this.draftTiers || this.busy) return;
    this.busy = true;
    this.statusMessage = { kind: "info", text: `Saving ${getIdeMeta(ide).label} tier bindings…` };
    this.render();
    try {
      const updated = await patchModelIndex({
        scope: this.targetScope,
        project: this.projectId || undefined,
        workspace: this.workspace || undefined,
        sync: this.targetScope === "workspace" ? this.syncOnSave : false,
        create: true,
        patch: {
          schemaVersion: 1,
          updatedBy: "user",
          ides: {
            [ide]: {
              tiers: this.draftTiers[ide],
            },
          },
        },
      });
      this.setViewData(updated);
      this.statusMessage = {
        kind: "ok",
        text:
          this.targetScope === "workspace" && this.syncOnSave
            ? `Saved ${getIdeMeta(ide).label} tier bindings & synced IDE files.`
            : `Saved ${getIdeMeta(ide).label} tier bindings to ${this.targetScope} overlay.`,
      };
      this.callbacks.onUpdated(updated);
    } catch (err) {
      this.statusMessage = {
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.busy = false;
      this.render(`[data-mi-save-tiers="${ide}"]`);
    }
  }

  private async handleSaveCatalogEntry(
    ide: HostIde,
    entry: ModelCatalogEntry
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.statusMessage = { kind: "info", text: `Saving catalog entry ${entry.id}…` };
    this.render();
    try {
      const updated = await patchModelIndex({
        scope: this.targetScope,
        project: this.projectId || undefined,
        workspace: this.workspace || undefined,
        sync: this.targetScope === "workspace" ? this.syncOnSave : false,
        create: true,
        patch: {
          schemaVersion: 1,
          updatedBy: "user",
          ides: {
            [ide]: {
              catalog: [entry],
            },
          },
        },
      });
      this.setViewData(updated);
      this.editingEntry = {
        id: "",
        label: "",
        tier: "balanced",
        vendor: "",
        family: "",
        capabilities: new Set(["coding"]),
        available: true,
        notes: "",
      };
      this.statusMessage = {
        kind: "ok",
        text: `Upserted "${entry.label}" in ${this.targetScope} catalog.`,
      };
      this.callbacks.onUpdated(updated);
    } catch (err) {
      this.statusMessage = {
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.busy = false;
      this.render("#miEntryId");
    }
  }

  private async handleSaveRoles(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.statusMessage = { kind: "info", text: "Saving role tier recommendations…" };
    this.render();
    try {
      const updated = await patchModelIndex({
        scope: this.targetScope,
        project: this.projectId || undefined,
        workspace: this.workspace || undefined,
        sync: this.targetScope === "workspace" ? this.syncOnSave : false,
        create: true,
        patch: {
          schemaVersion: 1,
          updatedBy: "user",
          roleRecommendations: this.draftRoles,
        },
      });
      this.setViewData(updated);
      this.statusMessage = {
        kind: "ok",
        text: `Saved role tier recommendations to ${this.targetScope} overlay.`,
      };
      this.callbacks.onUpdated(updated);
    } catch (err) {
      this.statusMessage = {
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.busy = false;
      this.render("[data-mi-save-roles]");
    }
  }

  private async handleReset(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.confirmResetPending = false;
    this.statusMessage = {
      kind: "info",
      text: `Resetting ${this.targetScope} overlay to built-in defaults…`,
    };
    this.render();
    try {
      const updated = await putModelIndex({
        scope: this.targetScope,
        project: this.projectId || undefined,
        workspace: this.workspace || undefined,
        sync: this.targetScope === "workspace" ? this.syncOnSave : false,
        create: true,
        patch: {
          schemaVersion: 1,
          updatedBy: "user",
          roleRecommendations: {},
          ides: {},
        },
      });
      this.setViewData(updated);
      this.statusMessage = {
        kind: "ok",
        text: `Reset ${this.targetScope} Model Index overlay to built-in defaults.`,
      };
      this.callbacks.onUpdated(updated);
    } catch (err) {
      this.statusMessage = {
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.busy = false;
      this.render("[data-mi-reset-ask]");
    }
  }
}
