import {
  fetchModelIndex,
  fetchTeam,
  patchModelIndex,
  patchTeamRouting,
} from "../api.js";
import { ModelIndexDialog } from "../components/ModelIndexDialog.js";
import {
  buildDefaultModelIndex,
  synthesizeModelIndexViewFromTeam,
} from "../state/modelIndex.js";
import type {
  EmbedScope,
  HostIde,
  IdeModelOverride,
  ModelIndexView,
  ModelRoutingPolicy,
  ModelTier,
  ResolvedIdeModel,
  TeamDefinitionEntry,
  TeamDetailsResponse,
  TeamRosterEntry,
  TeamSkillEntry,
  TeamSourceIde,
  WorkflowModelRouting,
} from "../types.js";
import { escHtml, getIdeMeta, trunc } from "../utils.js";

type SourceFilter = "all" | "project-custom" | "global" | TeamSourceIde;
type CatalogTab = "skills" | "definitions";
type DefinitionScope = "project" | "global";

interface DefinitionClassification {
  isRoster: boolean;
  scope: DefinitionScope;
  isProjectCustom: boolean;
}

const ALL_HOST_IDES: HostIde[] = ["antigravity", "claude-code", "copilot-vscode"];

const IDE_SOURCE_FILTERS: Array<{ id: TeamSourceIde; label: string }> = [
  { id: "canonical", label: "Canonical" },
  { id: "antigravity", label: "Antigravity" },
  { id: "claude-code", label: "Claude Code" },
  { id: "copilot-vscode", label: "VS Code" },
];

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function getDefinitionScope(
  def: TeamDefinitionEntry,
  team: TeamDetailsResponse
): DefinitionScope {
  if (def.source_ide === "canonical") return "project";
  const normPath = normalizePosixPath(def.source_path || "");
  if (!normPath) return "project";

  // Global IDE directories outside any workspace root
  if (
    normPath.includes("/.gemini/antigravity/agents/") ||
    normPath.includes("/.gemini/config/plugins/") ||
    normPath.includes("/.copilot/")
  ) {
    return "global";
  }

  const normRoot = team.project.root ? normalizePosixPath(team.project.root) : "";
  if (normRoot) {
    if (normPath === normRoot || normPath.startsWith(`${normRoot}/`)) {
      return "project";
    }
    if (
      normPath.includes("/.agents/agents/") ||
      normPath.includes("/.agents/plugins/") ||
      normPath.includes("/.github/agents/") ||
      normPath.includes("/.agent-team/agents/")
    ) {
      return "project";
    }
    return "global";
  }

  if (
    /^([a-z]:)?\/(users|home)\/[^/]+\/\.claude\/agents\//.test(normPath) ||
    normPath.startsWith("/root/.claude/agents/") ||
    /^([a-z]:)?\/(users|home)\/[^/]+\/\.copilot\//.test(normPath) ||
    normPath.startsWith("/root/.copilot/")
  ) {
    return "global";
  }
  return "project";
}

function classifyDefinition(
  def: TeamDefinitionEntry,
  team: TeamDetailsResponse,
  rosterIds: Set<string>
): DefinitionClassification {
  const projectId = team.project.id?.toLowerCase() ?? "";
  let isRoster = Boolean(def.roleType || def.boardRole) || rosterIds.has(def.id);
  if (!isRoster && projectId) {
    for (const rid of rosterIds) {
      if (def.id === `${projectId}-${rid}`) {
        isRoster = true;
        break;
      }
    }
  }
  const scope = getDefinitionScope(def, team);
  return {
    isRoster,
    scope,
    isProjectCustom: !isRoster && scope === "project",
  };
}

function renderDefinitionScopeBadges(info: DefinitionClassification): string {
  const badges: string[] = [];
  if (info.isProjectCustom) {
    badges.push(`<span class="def-scope-badge is-project">Project Agent</span>`);
  } else if (info.isRoster) {
    badges.push(`<span class="def-scope-badge is-roster">Team Roster</span>`);
  }
  if (info.scope === "global") {
    badges.push(`<span class="def-scope-badge is-global">Global</span>`);
  }
  return badges.join("");
}

function describeDefinitionScope(info: DefinitionClassification): string {
  if (info.isProjectCustom) return "Project-local (Custom / non-roster)";
  if (info.scope === "global") {
    return info.isRoster
      ? "Global plugin (Team Roster)"
      : "Global (~/.gemini, ~/.claude, or ~/.copilot / $COPILOT_HOME)";
  }
  return "Project-local (Team Roster)";
}

function getPolicyOptionLabel(
  policy: ModelRoutingPolicy,
  lockedIde: HostIde | null
): string {
  if (policy === "prefer-fallback") return "Prefer Fallback (Recommended)";
  if (policy === "pinned") return "Pinned Exact Models";
  if (lockedIde === "antigravity") return "Defer to Host Picker (/swarm · UI picker)";
  if (lockedIde === "copilot-vscode") return "Defer to Host Picker (Copilot Fusion / Auto)";
  if (lockedIde === "claude-code") return "Defer to Host Picker (/model · env)";
  return "Defer to Host Picker (/swarm · Fusion · /model)";
}

function getPolicyDescription(
  policy: ModelRoutingPolicy,
  lockedIde: HostIde | null
): string {
  if (lockedIde === "antigravity") {
    if (policy === "prefer-fallback") {
      return "Emits portable Antigravity tier enums (flash_lite/flash/pro) — compatible with /swarm and the UI model picker.";
    }
    if (policy === "defer-to-host") {
      return "Emits model: inherit so Antigravity /swarm and user UI model selection govern every role.";
    }
    return "Emits pinned Antigravity model IDs directly into compiled agent frontmatter.";
  }
  if (lockedIde === "copilot-vscode") {
    if (policy === "prefer-fallback") {
      return "Emits ordered Copilot runtime model ID fallback arrays with model-policy: preferred — preserves Copilot Fusion / Auto overrides.";
    }
    if (policy === "defer-to-host") {
      return "Omits model and model-policy completely so Copilot Fusion / Auto (and Auto discounts) govern selection.";
    }
    return "Emits explicit Copilot runtime model IDs with model-policy: required (bypasses Copilot Fusion / Auto overrides).";
  }
  if (lockedIde === "claude-code") {
    if (policy === "prefer-fallback") {
      return "Emits portable Claude Code family aliases (haiku/sonnet/opus) — yields to CLAUDE_CODE_SUBAGENT_MODEL and /model.";
    }
    if (policy === "defer-to-host") {
      return "Emits model: inherit so CLAUDE_CODE_SUBAGENT_MODEL and session /model govern every role.";
    }
    return "Emits pinned concrete Claude model IDs into .claude/agents/<role>.md frontmatter.";
  }
  if (policy === "prefer-fallback") {
    return "Emits portable tier enums (flash_lite/flash/pro), family aliases (haiku/sonnet/opus), and Copilot model-policy: preferred runtime ID arrays — compatible with /swarm, Copilot Fusion, and /model.";
  }
  if (policy === "defer-to-host") {
    return "Emits model: inherit for Antigravity & Claude Code and omits model/model-policy in VS Code Copilot so /swarm, Copilot Fusion/Auto (10% Auto discount), and /model always govern selection.";
  }
  return "Emits explicit concrete model IDs and sets Copilot model-policy: required (bypasses Copilot Fusion / Auto overrides).";
}

function getRespectOrchestratorLabel(lockedIde: HostIde | null): string {
  if (lockedIde === "antigravity") return "Respect Built-in Orchestrators (/swarm)";
  if (lockedIde === "copilot-vscode") return "Respect Built-in Orchestrators (Copilot Fusion)";
  if (lockedIde === "claude-code") return "Respect Built-in Orchestrators (/model)";
  return "Respect Built-in Orchestrators (/swarm · Fusion)";
}

function getHostCueBadgeText(lockedIde: HostIde | null): string {
  if (lockedIde === "antigravity") return "Host /swarm";
  if (lockedIde === "copilot-vscode") return "Host Fusion / Auto";
  if (lockedIde === "claude-code") return "Host /model";
  return "Host /swarm · Auto";
}

function defaultTierForRole(roleType: string, roleId: string): ModelTier {
  const id = roleId.toLowerCase();
  const rt = roleType.toLowerCase();
  if (rt === "orchestrator" || id === "orchestrator") return "balanced";
  if (rt === "qa" || id === "qa-validator") return "balanced";
  if (
    id === "architect" ||
    id === "ux-designer" ||
    id === "code-reviewer" ||
    rt === "design" ||
    rt === "ux" ||
    rt === "review"
  ) {
    return "reasoning";
  }
  return "balanced";
}

function formatSelectionPriority(priority?: readonly string[]): string {
  const list = priority && priority.length > 0 ? priority : ["accuracy", "cost", "speed"];
  return list
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : ""))
    .filter(Boolean)
    .join(" → ");
}

function sourceBadgeMeta(source: TeamSourceIde): {
  label: string;
  color: string;
  bg: string;
  border: string;
} {
  if (source === "canonical") {
    return {
      label: "CANONICAL",
      color: "#a5b4fc",
      bg: "rgba(129, 140, 248, 0.16)",
      border: "rgba(129, 140, 248, 0.45)",
    };
  }
  const m = getIdeMeta(source);
  return { label: m.label, color: m.color, bg: m.bg, border: m.border };
}

function roleBadgeClass(roleType: string): string {
  const r = roleType.toLowerCase();
  if (r === "orchestrator") return "role-orch";
  if (r === "qa") return "role-qa";
  if (r === "setup" || r === "ops") return "role-setup";
  return "role-spec";
}

async function copyTextSafe(text: string): Promise<boolean> {
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

function parseOverrideObject(raw: IdeModelOverride | undefined): {
  mode: "tier" | "custom" | "omit";
  primary: string;
  fallbackText: string;
  copilotPolicy: "" | "preferred" | "required";
} {
  if (!raw) {
    return { mode: "tier", primary: "", fallbackText: "", copilotPolicy: "" };
  }
  if (typeof raw === "string") {
    return { mode: "custom", primary: raw, fallbackText: "", copilotPolicy: "" };
  }
  if (Array.isArray(raw)) {
    return {
      mode: "custom",
      primary: raw[0] ?? "",
      fallbackText: raw.join(", "),
      copilotPolicy: "",
    };
  }
  if (raw.omit) {
    return {
      mode: "omit",
      primary: raw.primary ?? "",
      fallbackText: (raw.fallback ?? []).join(", "),
      copilotPolicy: raw.copilotPolicy ?? "",
    };
  }
  return {
    mode: "custom",
    primary: raw.primary ?? "",
    fallbackText: (raw.fallback ?? []).join(", "),
    copilotPolicy: raw.copilotPolicy ?? "",
  };
}

export class TeamView {
  private root: HTMLElement;
  private currentProject = "";
  private currentWorkspace = "";
  private embedScope: EmbedScope = {
    embedMode: false,
    lockedIde: null,
    lockedWorkspace: "",
  };
  private data: TeamDetailsResponse | null = null;
  private modelIndex: ModelIndexView | null = null;
  private loading = false;
  private savingRouting = false;
  private syncOnSave = true;
  private routingStatus: {
    kind: "ok" | "error" | "info";
    text: string;
    retryFn?: () => void;
  } | null = null;
  private errorMsg: string | null = null;
  private sourceFilter: SourceFilter = "all";
  private catalogTab: CatalogTab = "definitions";

  private dialog: HTMLDialogElement;
  private modelIndexDialog: ModelIndexDialog;
  private modalCopyText = "";

  constructor(root: HTMLElement) {
    this.root = root;

    const dlg = document.createElement("dialog");
    dlg.className = "team-detail-dialog";
    dlg.setAttribute("closedby", "any");
    dlg.setAttribute("aria-labelledby", "teamDialogTitle");
    dlg.innerHTML = `
      <div class="insp-sheet-shell">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="insp-sheet-head">
          <h1 class="insp-title-row mi-dialog-h1" id="teamDialogTitle" data-td-title>Agent Details</h1>
          <div class="insp-head-actions">
            <button type="button" class="copy-btn" data-td-copy>Copy Prompt</button>
            <button type="button" class="insp-icon-btn" data-td-close aria-label="Close details">✕</button>
          </div>
        </div>
        <div class="insp-sheet-body" data-td-body></div>
      </div>
    `;
    document.body.appendChild(dlg);
    this.dialog = dlg;

    // Safari light-dismiss fallback requiring pointerdown + pointerup outside dialog box
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
        if (pressedOutside && isOutside(e)) dlg.close();
        pressedOutside = false;
      });
    }

    dlg.addEventListener("close", () => {
      dlg.returnValue = "";
    });

    dlg.querySelector("[data-td-close]")?.addEventListener("click", () => dlg.close());
    const copyBtn = dlg.querySelector<HTMLButtonElement>("[data-td-copy]");
    copyBtn?.addEventListener("click", async () => {
      if (!this.modalCopyText || !copyBtn) return;
      const ok = await copyTextSafe(this.modalCopyText);
      copyBtn.textContent = ok ? "Copied ✓" : "Copy failed";
      copyBtn.classList.toggle("copied", ok);
      window.setTimeout(() => {
        copyBtn.textContent = "Copy Prompt";
        copyBtn.classList.remove("copied");
      }, 1600);
    });

    this.modelIndexDialog = new ModelIndexDialog({
      onUpdated: (updatedView) => {
        this.modelIndex = updatedView;
        void this.load(this.currentProject, this.currentWorkspace || undefined);
      },
    });

    this.render();
  }

  public dispose(): void {
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
    this.modelIndexDialog.dispose();
  }

  public setEmbedScope(scope: EmbedScope): void {
    this.embedScope = { ...scope };
    if (
      scope.lockedIde &&
      this.sourceFilter !== "all" &&
      this.sourceFilter !== "project-custom" &&
      this.sourceFilter !== "global" &&
      this.sourceFilter !== "canonical" &&
      this.sourceFilter !== scope.lockedIde
    ) {
      this.sourceFilter = "all";
    }
    this.modelIndexDialog.updateContext({
      embedScope: this.embedScope,
    });
    this.render();
  }

  public async load(
    projectId: string,
    workspace?: string,
    restoreFocusSelector?: string
  ): Promise<void> {
    this.currentProject = projectId;
    if (workspace !== undefined) this.currentWorkspace = workspace;
    const effectiveWorkspace =
      this.currentWorkspace || this.embedScope.lockedWorkspace || undefined;
    this.loading = true;
    this.errorMsg = null;
    this.render();

    try {
      const [teamRes, miRes] = await Promise.allSettled([
        fetchTeam({
          project: projectId || undefined,
          workspace: effectiveWorkspace,
        }),
        fetchModelIndex({
          project: projectId || undefined,
          workspace: effectiveWorkspace,
          ide: this.embedScope.lockedIde,
        }),
      ]);

      if (teamRes.status === "fulfilled") {
        this.data = teamRes.value;
        if (miRes.status === "fulfilled") {
          this.modelIndex = miRes.value;
        } else {
          this.modelIndex = synthesizeModelIndexViewFromTeam(teamRes.value);
        }
        this.modelIndexDialog.updateContext({
          view: this.modelIndex,
          projectId: this.currentProject,
          workspace: effectiveWorkspace ?? "",
          embedScope: this.embedScope,
        });
      } else {
        throw teamRes.reason;
      }
    } catch (err) {
      this.errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.render(restoreFocusSelector);
    }
  }

  private getEffectiveWorkflowRouting(team: TeamDetailsResponse): WorkflowModelRouting {
    if (this.modelIndex?.routing) {
      return {
        policy: this.modelIndex.routing.policy,
        respectBuiltInOrchestrators: this.modelIndex.routing.respectBuiltInOrchestrators,
        allowSubagentModelHints: this.modelIndex.routing.allowSubagentModelHints,
        copilotHandoffModels: this.modelIndex.routing.copilotHandoffModels,
        selectionPriority:
          this.modelIndex.routing.selectionPriority ??
          this.modelIndex.effective.selectionPriority ??
          ["accuracy", "cost", "speed"],
        idePolicies: this.modelIndex.routing.idePolicies,
      };
    }
    return (
      team.modelRouting ?? {
        policy: "prefer-fallback",
        respectBuiltInOrchestrators: true,
        allowSubagentModelHints: true,
        copilotHandoffModels: false,
        selectionPriority: ["accuracy", "cost", "speed"],
      }
    );
  }

  private getVisibleHostIdes(team: TeamDetailsResponse): HostIde[] {
    if (this.embedScope.lockedIde) {
      return [this.embedScope.lockedIde];
    }
    const enabled = team.targets.filter((t): t is HostIde =>
      ALL_HOST_IDES.includes(t as HostIde)
    );
    return enabled.length > 0 ? enabled : ALL_HOST_IDES;
  }

  private resolvePreviewForRoleIde(
    role: TeamRosterEntry,
    ide: HostIde,
    team: TeamDetailsResponse
  ): ResolvedIdeModel {
    const fromModelIndex =
      this.modelIndex?.routing.resolvedRoles[role.id]?.resolved?.[ide];
    if (fromModelIndex) return fromModelIndex;
    const fromRoster = role.resolvedModels?.[ide];
    if (fromRoster) return fromRoster;

    const wf = this.getEffectiveWorkflowRouting(team);
    const effIndex = this.modelIndex?.effective ?? buildDefaultModelIndex();
    const rec = effIndex.roleRecommendations[role.id];
    const tier =
      role.modelTier ?? rec?.tier ?? defaultTierForRole(role.roleType, role.id);
    const policy =
      role.modelPolicy ?? wf.idePolicies?.[ide] ?? wf.policy ?? "prefer-fallback";
    const binding = effIndex.ides[ide].tiers[tier];
    const override = role.models?.[ide];

    if (override && typeof override === "object" && !Array.isArray(override) && override.omit) {
      return {
        model: "",
        fallback: [],
        omitted: true,
        tier,
        policy,
        source: "override",
      };
    }

    if (policy === "defer-to-host") {
      if (ide === "copilot-vscode" && binding.omitOnDefer !== false) {
        return {
          model: "",
          fallback: [],
          omitted: true,
          tier,
          policy,
          source: "defer",
        };
      }
      return {
        model: "inherit",
        fallback: ["inherit"],
        tier,
        policy,
        source: "defer",
      };
    }

    if (override) {
      if (typeof override === "string") {
        return {
          model: override,
          fallback: [override],
          copilotPolicy:
            ide === "copilot-vscode"
              ? policy === "pinned"
                ? "required"
                : "preferred"
              : undefined,
          tier,
          policy,
          source: "override",
        };
      }
      if (Array.isArray(override)) {
        return {
          model: override,
          fallback: override,
          copilotPolicy:
            ide === "copilot-vscode"
              ? policy === "pinned"
                ? "required"
                : "preferred"
              : undefined,
          tier,
          policy,
          source: "override",
        };
      }
      const primary = override.primary ?? binding.primary;
      const fb = override.fallback?.length ? override.fallback : [primary];
      return {
        model: ide === "copilot-vscode" && fb.length > 1 ? fb : primary,
        fallback: fb,
        copilotPolicy:
          ide === "copilot-vscode"
            ? override.copilotPolicy ?? (policy === "pinned" ? "required" : "preferred")
            : undefined,
        tier,
        policy,
        source: "override",
      };
    }

    if (ide === "copilot-vscode") {
      const fb = binding.fallback.length > 0 ? binding.fallback : [binding.primary];
      return {
        model: policy === "pinned" ? binding.primary : fb,
        fallback: fb,
        copilotPolicy: policy === "pinned" ? "required" : "preferred",
        tier,
        policy,
        source: "index",
      };
    }

    return {
      model: binding.primary,
      fallback: binding.fallback,
      tier,
      policy,
      source: "index",
    };
  }

  private formatResolvedPillText(
    ide: HostIde,
    res: ResolvedIdeModel,
    respectHost: boolean,
    isSingleLockedIde: boolean
  ): { text: string; cue: string } {
    const meta = getIdeMeta(ide);
    const prefix = isSingleLockedIde ? meta.label : meta.short;
    if (res.omitted) {
      return {
        text: `${prefix}: Omitted — Host Auto / Fusion`,
        cue: ide === "copilot-vscode" ? "Copilot Fusion / Auto" : "Host Picker",
      };
    }
    const primary = Array.isArray(res.model) ? res.model[0] ?? "auto" : res.model;
    const extraCount = Array.isArray(res.model) ? Math.max(0, res.model.length - 1) : 0;
    const modelLabel = extraCount > 0 ? `${primary} (+${extraCount})` : primary;

    let cue = "";
    if (ide === "copilot-vscode") {
      cue = res.copilotPolicy === "required" ? "required (bypasses Fusion)" : "preferred · Fusion OK";
    } else if (ide === "antigravity") {
      cue = respectHost ? "/swarm OK" : "subagent hint";
    } else if (ide === "claude-code") {
      cue = "/model overrideable";
    }

    return {
      text: `${prefix}: ${modelLabel}`,
      cue,
    };
  }

  private openDetailModal(
    titleHtml: string,
    bodyHtml: string,
    copyText: string,
    showCopy = true
  ): void {
    this.modalCopyText = copyText;
    const titleEl = this.dialog.querySelector("[data-td-title]");
    const bodyEl = this.dialog.querySelector("[data-td-body]");
    const copyBtn = this.dialog.querySelector<HTMLButtonElement>("[data-td-copy]");
    if (titleEl) titleEl.innerHTML = titleHtml;
    if (bodyEl) bodyEl.innerHTML = bodyHtml;
    if (copyBtn) copyBtn.hidden = !showCopy;
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
  }

  private openRoleOverrideModal(entry: TeamRosterEntry, team: TeamDetailsResponse): void {
    const visibleIdes = this.getVisibleHostIdes(team);
    const isMcp = Boolean(this.embedScope.mcpAppMode);
    const effIndex = this.modelIndex?.effective ?? buildDefaultModelIndex();
    const rec = effIndex.roleRecommendations[entry.id];
    const resolvedRole = this.modelIndex?.routing.resolvedRoles[entry.id];
    const currentTier =
      entry.modelTier ?? resolvedRole?.modelTier ?? rec?.tier ?? defaultTierForRole(entry.roleType, entry.id);

    const titleHtml = `
      <span class="insp-title">Model Overrides: ${escHtml(entry.name)}</span>
      <span class="tier-pill tier-${currentTier}">${escHtml(currentTier.toUpperCase())}</span>
    `;

    const cliCmd = `agent-studio models set-role ${entry.id} --tier ${currentTier} --ide ${visibleIdes[0] ?? "antigravity"} --model inherit --sync`;

    const ideSectionsHtml = visibleIdes
      .map((ide) => {
        const meta = getIdeMeta(ide);
        const existingOverride =
          resolvedRole?.models?.[ide] ?? entry.models?.[ide];
        const parsed = parseOverrideObject(existingOverride);
        const catalog = effIndex.ides[ide].catalog;
        const datalistId = `role-dl-${entry.id}-${ide}`;
        const modeName = `overrideMode-${ide}`;

        return `
          <fieldset class="ro-ide-fieldset" data-ro-ide="${escHtml(ide)}">
            <legend>
              <span class="ide-chip" style="color:${meta.color};border-color:${meta.border};background:${meta.bg}">${escHtml(meta.label)}</span>
              <span class="muted">(${escHtml(effIndex.ides[ide].mode)})</span>
            </legend>

            <div class="ro-mode-row">
              <label class="mi-radio-label">
                <input type="radio" name="${escHtml(modeName)}" value="tier" ${parsed.mode === "tier" ? "checked" : ""} ${isMcp ? "disabled" : ""} />
                <span>Use Tier Default</span>
              </label>
              <label class="mi-radio-label">
                <input type="radio" name="${escHtml(modeName)}" value="custom" ${parsed.mode === "custom" ? "checked" : ""} ${isMcp ? "disabled" : ""} />
                <span>Custom Model / Fallbacks</span>
              </label>
              <label class="mi-radio-label">
                <input type="radio" name="${escHtml(modeName)}" value="omit" ${parsed.mode === "omit" ? "checked" : ""} ${isMcp ? "disabled" : ""} />
                <span>Omit Frontmatter</span>
              </label>
            </div>

            <div class="ro-custom-fields" ${parsed.mode !== "custom" ? "hidden" : ""}>
              <div class="mi-field">
                <label for="ro-primary-${escHtml(ide)}">Primary Model ID</label>
                <input
                  type="text"
                  id="ro-primary-${escHtml(ide)}"
                  list="${escHtml(datalistId)}"
                  class="feedback-input"
                  data-ro-primary="${escHtml(ide)}"
                  value="${escHtml(parsed.primary)}"
                  autocorrect="off"
                  autocapitalize="none"
                  spellcheck="false"
                  ${isMcp ? "disabled" : ""}
                />
                <datalist id="${escHtml(datalistId)}">
                  ${catalog.map((c) => `<option value="${escHtml(c.id)}">${escHtml(c.label)}</option>`).join("")}
                </datalist>
              </div>
              <div class="mi-field">
                <label for="ro-fb-${escHtml(ide)}">Fallback Array (comma-separated, optional)</label>
                <input
                  type="text"
                  id="ro-fb-${escHtml(ide)}"
                  class="feedback-input"
                  data-ro-fallback="${escHtml(ide)}"
                  value="${escHtml(parsed.fallbackText)}"
                  autocorrect="off"
                  autocapitalize="none"
                  spellcheck="false"
                  ${isMcp ? "disabled" : ""}
                />
              </div>
              ${
                ide === "copilot-vscode"
                  ? `
                    <div class="mi-field">
                      <label for="ro-copol-${escHtml(ide)}">Copilot model-policy</label>
                      <select id="ro-copol-${escHtml(ide)}" class="ctx-select mi-select" data-ro-copilot-policy ${isMcp ? "disabled" : ""}>
                        <option value="" ${parsed.copilotPolicy === "" ? "selected" : ""}>Inherit from role/workflow policy</option>
                        <option value="preferred" ${parsed.copilotPolicy === "preferred" ? "selected" : ""}>preferred (Fusion / Auto compatible)</option>
                        <option value="required" ${parsed.copilotPolicy === "required" ? "selected" : ""}>required (strict pin, bypasses Fusion)</option>
                      </select>
                    </div>
                  `
                  : ""
              }
            </div>
          </fieldset>
        `;
      })
      .join("");

    const bodyHtml = `
      <div class="insp-meta">
        <span><b>Role ID:</b> <code>${escHtml(entry.id)}</code></span>
        ${rec?.rationale ? `<span><b>Recommendation:</b> ${escHtml(rec.rationale)}</span>` : ""}
      </div>

      ${
        isMcp
          ? `
            <div class="mi-mcp-banner" role="note">
              <div class="mi-mcp-copy">
                <strong>Read-Only MCP App Mode</strong>
                <span class="muted">Apply per-role overrides via CLI:</span>
              </div>
              <div class="mi-cli-row">
                <div class="code-scroll cp-cmd-scroll" role="region" tabindex="0" aria-label="Role override CLI command"><code>${escHtml(cliCmd)}</code></div>
                <button type="button" class="guide-copy-btn" data-ro-copy-cli="${escHtml(cliCmd)}">Copy CLI</button>
              </div>
            </div>
          `
          : ""
      }

      <form class="ro-form" data-ro-form>
        ${ideSectionsHtml}
        <div class="ro-status" role="status" aria-live="polite" data-ro-status></div>
        ${
          !isMcp
            ? `<div class="ro-actions">
                <button type="button" class="btn-secondary" data-ro-cancel>Cancel</button>
                <button type="submit" class="btn-primary" data-ro-save>Save Role Overrides</button>
              </div>`
            : ""
        }
      </form>
    `;

    this.openDetailModal(titleHtml, bodyHtml, cliCmd, false);

    const bodyEl = this.dialog.querySelector<HTMLElement>("[data-td-body]");
    if (!bodyEl) return;

    bodyEl.querySelector<HTMLButtonElement>("[data-ro-cancel]")?.addEventListener("click", () => {
      this.dialog.close();
    });

    bodyEl.querySelector<HTMLButtonElement>("[data-ro-copy-cli]")?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      const ok = await copyTextSafe(cliCmd);
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      btn.classList.toggle("copied", ok);
      window.setTimeout(() => {
        btn.textContent = "Copy CLI";
        btn.classList.remove("copied");
      }, 1500);
    });

    visibleIdes.forEach((ide) => {
      const fs = bodyEl.querySelector<HTMLElement>(`[data-ro-ide="${ide}"]`);
      const customWrap = fs?.querySelector<HTMLElement>(".ro-custom-fields");
      fs?.querySelectorAll<HTMLInputElement>(`input[name="overrideMode-${ide}"]`).forEach((radio) => {
        radio.addEventListener("change", () => {
          if (customWrap) {
            customWrap.hidden = radio.value !== "custom";
          }
        });
      });
    });

    bodyEl.querySelector<HTMLFormElement>("[data-ro-form]")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const saveBtn = bodyEl.querySelector<HTMLButtonElement>("[data-ro-save]");
      const statusSlot = bodyEl.querySelector<HTMLElement>("[data-ro-status]");
      const modelsPatch: Partial<Record<HostIde, IdeModelOverride | null>> = {};

      for (const ide of visibleIdes) {
        const fs = bodyEl.querySelector<HTMLElement>(`[data-ro-ide="${ide}"]`);
        const checked = fs?.querySelector<HTMLInputElement>(
          `input[name="overrideMode-${ide}"]:checked`
        )?.value;
        if (checked === "tier") {
          modelsPatch[ide] = null;
        } else if (checked === "omit") {
          modelsPatch[ide] = { omit: true };
        } else if (checked === "custom") {
          const primary =
            fs?.querySelector<HTMLInputElement>(`[data-ro-primary="${ide}"]`)?.value.trim() ??
            "";
          const fbRaw =
            fs?.querySelector<HTMLInputElement>(`[data-ro-fallback="${ide}"]`)?.value ?? "";
          const fbList = fbRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const copol =
            ide === "copilot-vscode"
              ? (fs?.querySelector<HTMLSelectElement>("[data-ro-copilot-policy]")?.value as
                  | ""
                  | "preferred"
                  | "required")
              : "";

          if (!primary && fbList.length === 0) {
            if (statusSlot) {
              statusSlot.innerHTML = `<div class="issue-row error">✕ Enter a primary model ID or fallback list for ${escHtml(getIdeMeta(ide).label)}.</div>`;
            }
            fs?.querySelector<HTMLInputElement>(`[data-ro-primary="${ide}"]`)?.focus();
            return;
          }

          if (copol) {
            modelsPatch[ide] = {
              primary: primary || fbList[0],
              ...(fbList.length > 0 ? { fallback: fbList } : {}),
              copilotPolicy: copol,
            };
          } else if (fbList.length > 1) {
            modelsPatch[ide] = fbList;
          } else {
            modelsPatch[ide] = primary || fbList[0];
          }
        }
      }

      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
      }
      if (statusSlot) {
        statusSlot.innerHTML = `<div class="issue-row">⋯ Saving role overrides…</div>`;
      }
      try {
        await patchTeamRouting({
          project: this.currentProject || undefined,
          workspace: this.currentWorkspace || this.embedScope.lockedWorkspace || undefined,
          sync: this.syncOnSave,
          role: {
            id: entry.id,
            models: modelsPatch,
          },
        });
        this.routingStatus = {
          kind: "ok",
          text: this.syncOnSave
            ? `Saved ${entry.name} model overrides & synced IDE files.`
            : `Saved ${entry.name} model overrides to team.yaml.`,
        };
        this.dialog.close();
        await this.load(this.currentProject, this.currentWorkspace || undefined);
      } catch (err) {
        if (statusSlot) {
          statusSlot.innerHTML = `<div class="issue-row error">✕ ${escHtml(err instanceof Error ? err.message : String(err))}</div>`;
        }
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save Role Overrides";
        }
      }
    });
  }

  private openRosterDetail(entry: TeamRosterEntry): void {
    const lockedIde = this.embedScope.lockedIde;
    const compiled = (this.data?.definitions ?? []).filter(
      (d) =>
        d.source_ide !== "canonical" &&
        (!lockedIde || d.source_ide === lockedIde) &&
        (d.id === entry.id || d.id.endsWith(`-${entry.id}`))
    );

    const titleHtml = `
      <span class="insp-title">${escHtml(entry.name)}</span>
      <span class="team-role-badge ${roleBadgeClass(entry.roleType)}">${escHtml(entry.roleType)}</span>
      <span class="pill dispatch">${escHtml(entry.boardRole)}</span>
    `;

    const compiledHtml =
      compiled.length > 0
        ? `
          <div class="td-section">
            <div class="td-section-hdr">${
              lockedIde
                ? `Compiled Tool Allowlist (${escHtml(getIdeMeta(lockedIde).label)})`
                : "Compiled Tool Allowlists Across IDEs"
            }</div>
            <div class="td-compiled-grid">
              ${compiled
                .map((c) => {
                  const m = sourceBadgeMeta(c.source_ide);
                  const tools = c.tools ?? [];
                  return `
                    <div class="td-compiled-card">
                      <div class="td-compiled-top">
                        <span class="ide-chip" style="color:${m.color};border-color:${m.border};background:${m.bg}">${escHtml(m.label)}</span>
                        <code class="td-path-sm">${escHtml(c.source_path)}</code>
                      </div>
                      <div class="chip-wrap">
                        ${
                          tools.length > 0
                            ? tools.map((t) => `<span class="cap-chip">${escHtml(t)}</span>`).join("")
                            : `<span class="muted">Inherited / default tools</span>`
                        }
                      </div>
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
        <span><b>ID:</b> <code>${escHtml(entry.id)}</code></span>
        <span><b>Source:</b> <code>${escHtml(entry.source_path || entry.promptFile)}</code></span>
        <span><b>Size:</b> ~${entry.est_tokens} tokens (${entry.chars} chars)</span>
      </div>
      ${entry.description ? `<div class="insp-summary">${escHtml(entry.description)}</div>` : ""}
      ${
        entry.capabilities.length > 0
          ? `<div class="td-section">
              <div class="td-section-hdr">Canonical Capabilities</div>
              <div class="chip-wrap">${entry.capabilities.map((c) => `<span class="cap-chip">${escHtml(c)}</span>`).join("")}</div>
            </div>`
          : ""
      }
      ${
        entry.handoffs.length > 0
          ? `<div class="td-section">
              <div class="td-section-hdr">Handoffs</div>
              <div class="chip-wrap">${entry.handoffs.map((h) => `<span class="handoff-pill">→ ${escHtml(h)}</span>`).join("")}</div>
            </div>`
          : ""
      }
      ${compiledHtml}
      <div class="td-section">
        <div class="td-section-hdr">Prompt Preview</div>
        <div class="insp-pre-wrap" role="region" tabindex="0" aria-label="Agent prompt preview">
          <pre class="insp-pre"><code>${escHtml(entry.preview || "(empty prompt)")}</code></pre>
        </div>
      </div>
    `;

    this.openDetailModal(titleHtml, bodyHtml, entry.preview || "", true);
  }

  private openSkillDetail(skill: TeamSkillEntry): void {
    const m = sourceBadgeMeta(skill.source_ide);
    const titleHtml = `
      <span class="insp-title">${escHtml(skill.name || skill.id)}</span>
      <span class="ide-chip" style="color:${m.color};border-color:${m.border};background:${m.bg}">${escHtml(m.label)}</span>
    `;
    const bodyHtml = `
      <div class="insp-meta">
        <span><b>ID:</b> <code>${escHtml(skill.id)}</code></span>
        <span><b>Source:</b> <code>${escHtml(skill.source_path)}</code></span>
        <span><b>Size:</b> ~${skill.est_tokens} tokens (${skill.chars} chars)</span>
      </div>
      ${skill.description ? `<div class="insp-summary">${escHtml(skill.description)}</div>` : ""}
      <div class="td-section">
        <div class="td-section-hdr">SKILL.md Preview</div>
        <div class="insp-pre-wrap" role="region" tabindex="0" aria-label="Skill instructions preview">
          <pre class="insp-pre"><code>${escHtml(skill.preview || "(empty skill)")}</code></pre>
        </div>
      </div>
    `;
    this.openDetailModal(titleHtml, bodyHtml, skill.preview || "", true);
  }

  private openDefinitionDetail(def: TeamDefinitionEntry): void {
    const m = sourceBadgeMeta(def.source_ide);
    const rosterIds = new Set((this.data?.roster ?? []).map((r) => r.id));
    const info = this.data ? classifyDefinition(def, this.data, rosterIds) : null;
    const titleHtml = `
      <span class="insp-title">${escHtml(def.name || def.id)}</span>
      ${info ? renderDefinitionScopeBadges(info) : ""}
      <span class="ide-chip" style="color:${m.color};border-color:${m.border};background:${m.bg}">${escHtml(m.label)}</span>
      ${def.roleType ? `<span class="team-role-badge ${roleBadgeClass(def.roleType)}">${escHtml(def.roleType)}</span>` : ""}
    `;
    const tools = def.tools ?? [];
    const caps = def.capabilities ?? [];
    const handoffs = def.handoffs ?? [];

    const bodyHtml = `
      <div class="insp-meta">
        <span><b>ID:</b> <code>${escHtml(def.id)}</code></span>
        ${info ? `<span><b>Scope:</b> ${escHtml(describeDefinitionScope(info))}</span>` : ""}
        ${def.boardRole ? `<span><b>Board Role:</b> ${escHtml(def.boardRole)}</span>` : ""}
        ${def.model ? `<span><b>Model:</b> <code>${escHtml(def.model)}</code></span>` : ""}
        <span><b>Size:</b> ~${def.est_tokens} tokens (${def.chars} chars)</span>
        <span><b>Source:</b> <code>${escHtml(def.source_path)}</code></span>
      </div>
      ${def.description ? `<div class="insp-summary">${escHtml(def.description)}</div>` : ""}
      ${
        tools.length > 0
          ? `<div class="td-section">
              <div class="td-section-hdr">Compiled Tool Allowlist</div>
              <div class="chip-wrap">${tools.map((t) => `<span class="cap-chip">${escHtml(t)}</span>`).join("")}</div>
            </div>`
          : ""
      }
      ${
        caps.length > 0
          ? `<div class="td-section">
              <div class="td-section-hdr">Capabilities</div>
              <div class="chip-wrap">${caps.map((c) => `<span class="cap-chip">${escHtml(c)}</span>`).join("")}</div>
            </div>`
          : ""
      }
      ${
        handoffs.length > 0
          ? `<div class="td-section">
              <div class="td-section-hdr">Handoffs</div>
              <div class="chip-wrap">${handoffs.map((h) => `<span class="handoff-pill">→ ${escHtml(h)}</span>`).join("")}</div>
            </div>`
          : ""
      }
      <div class="td-section">
        <div class="td-section-hdr">Definition Preview</div>
        <div class="insp-pre-wrap" role="region" tabindex="0" aria-label="Agent definition preview">
          <pre class="insp-pre"><code>${escHtml(def.preview || "(empty definition)")}</code></pre>
        </div>
      </div>
    `;
    this.openDetailModal(titleHtml, bodyHtml, def.preview || "", true);
  }

  private async mutateRouting(
    payload: Parameters<typeof patchTeamRouting>[0],
    successText: string,
    restoreFocusSelector?: string
  ): Promise<void> {
    if (this.savingRouting) return;
    this.savingRouting = true;
    this.routingStatus = { kind: "info", text: "Saving model routing & syncing adapters…" };
    this.render(restoreFocusSelector);
    try {
      await patchTeamRouting({
        project: this.currentProject || undefined,
        workspace: this.currentWorkspace || this.embedScope.lockedWorkspace || undefined,
        sync: this.syncOnSave,
        ...payload,
      });
      this.routingStatus = { kind: "ok", text: successText };
      await this.load(
        this.currentProject,
        this.currentWorkspace || undefined,
        restoreFocusSelector
      );
    } catch (err) {
      this.routingStatus = {
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
        retryFn: () => void this.mutateRouting(payload, successText, restoreFocusSelector),
      };
    } finally {
      this.savingRouting = false;
      this.render(restoreFocusSelector);
    }
  }

  private async adoptGlobalCatalog(team: TeamDetailsResponse): Promise<void> {
    if (this.savingRouting || !this.modelIndex) return;
    this.savingRouting = true;
    this.routingStatus = { kind: "info", text: "Adopting global catalog into .agent-team/model-index.json…" };
    this.render();
    try {
      const visibleIdes = this.getVisibleHostIdes(team);
      const idesPatch: Record<string, unknown> = {};
      for (const ide of visibleIdes) {
        const cfg = this.modelIndex.effective.ides[ide];
        idesPatch[ide] = {
          tiers: cfg.tiers,
          catalog: cfg.catalog.filter((c) => c.source !== "built-in"),
        };
      }
      await patchModelIndex({
        scope: "workspace",
        project: this.currentProject || undefined,
        workspace: this.currentWorkspace || this.embedScope.lockedWorkspace || undefined,
        sync: this.syncOnSave,
        create: true,
        patch: {
          schemaVersion: 1,
          updatedBy: "user",
          ides: idesPatch,
        },
      });
      this.routingStatus = {
        kind: "ok",
        text: this.syncOnSave
          ? "Adopted global catalog into .agent-team/model-index.json & synced IDEs."
          : "Adopted global catalog into .agent-team/model-index.json.",
      };
      await this.load(this.currentProject, this.currentWorkspace || undefined);
    } catch (err) {
      this.routingStatus = {
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
        retryFn: () => void this.adoptGlobalCatalog(team),
      };
    } finally {
      this.savingRouting = false;
      this.render();
    }
  }

  private renderModelRoutingBar(team: TeamDetailsResponse): string {
    const wf = this.getEffectiveWorkflowRouting(team);
    const isMcp = Boolean(this.embedScope.mcpAppMode);
    const layers = this.modelIndex?.layers;
    const summary = team.modelIndexSummary;

    const hasWorkspace = Boolean(layers?.workspaceExists ?? summary?.hasWorkspaceOverlay);
    const hasGlobal = Boolean(layers?.globalExists ?? summary?.hasGlobalOverlay);
    const globalDiffers = Boolean(
      layers?.globalDiffersFromWorkspace ?? summary?.globalDiffersFromWorkspace
    );

    const sourceBadgeText = hasWorkspace
      ? "Workspace .agent-team/model-index.json"
      : hasGlobal
        ? "Global Overlay"
        : "Built-in Defaults";
    const sourceBadgeClass = hasWorkspace ? "ok" : hasGlobal ? "dispatch" : "tool";

    const lockedIde = this.embedScope.lockedIde;
    const policyDesc = getPolicyDescription(wf.policy, lockedIde);
    const respectLabel = getRespectOrchestratorLabel(lockedIde);
    const priorityLabel = formatSelectionPriority(
      wf.selectionPriority ?? this.modelIndex?.effective.selectionPriority
    );
    const cliPolicyCmd = `agent-studio models set-policy ${wf.policy} --respect-host ${wf.respectBuiltInOrchestrators ? "true" : "false"} --sync`;

    return `
      <section
        class="card model-routing-bar"
        aria-labelledby="modelRoutingHeading"
        aria-busy="${this.savingRouting ? "true" : "false"}"
      >
        <div class="mr-bar-top">
          <div class="mr-title-group">
            <h3 id="modelRoutingHeading">Model Routing &amp; Host Compatibility</h3>
            <span class="pill ${sourceBadgeClass}">${escHtml(sourceBadgeText)}</span>
            <span class="pill tool" title="Deterministic candidate ranking order">${escHtml(priorityLabel)}</span>
          </div>
          <div class="mr-bar-actions">
            ${
              globalDiffers && !isMcp
                ? `<button type="button" class="btn-secondary btn-sm" data-mr-adopt ${this.savingRouting ? "disabled" : ""}>Adopt Global Catalog</button>`
                : ""
            }
            <button type="button" class="btn-secondary btn-sm" data-mr-open-index>
              ${isMcp ? "Inspect Model Index" : "Inspect / Edit Model Index"}
            </button>
          </div>
        </div>

        <div class="mr-controls-row">
          ${
            isMcp
              ? `
                <div class="mr-mcp-summary">
                  <span class="pill dispatch">Policy: ${escHtml(wf.policy)}</span>
                  <span class="pill ${wf.respectBuiltInOrchestrators ? "ok" : "tool"}">
                    ${wf.respectBuiltInOrchestrators ? "✓" : "○"} ${escHtml(respectLabel)}
                  </span>
                </div>
                <div class="mi-cli-row">
                  <div class="code-scroll cp-cmd-scroll" role="region" tabindex="0" aria-label="Set model routing policy CLI command"><code>${escHtml(cliPolicyCmd)}</code></div>
                  <button type="button" class="guide-copy-btn" data-mr-copy-cli="${escHtml(cliPolicyCmd)}">Copy CLI</button>
                </div>
              `
              : `
                <div class="mr-field">
                  <label for="mrPolicySelect">Default Routing Policy</label>
                  <select id="mrPolicySelect" class="ctx-select mr-select" data-mr-policy ${this.savingRouting ? "disabled" : ""}>
                    <option value="prefer-fallback" ${wf.policy === "prefer-fallback" ? "selected" : ""}>${escHtml(getPolicyOptionLabel("prefer-fallback", lockedIde))}</option>
                    <option value="defer-to-host" ${wf.policy === "defer-to-host" ? "selected" : ""}>${escHtml(getPolicyOptionLabel("defer-to-host", lockedIde))}</option>
                    <option value="pinned" ${wf.policy === "pinned" ? "selected" : ""}>${escHtml(getPolicyOptionLabel("pinned", lockedIde))}</option>
                  </select>
                </div>

                <div class="mr-toggles">
                  <label class="mi-check-label">
                    <input type="checkbox" data-mr-respect-host ${wf.respectBuiltInOrchestrators ? "checked" : ""} ${this.savingRouting ? "disabled" : ""} />
                    <span>${escHtml(respectLabel)}</span>
                  </label>
                  <label class="mi-check-label">
                    <input type="checkbox" data-mr-sync-toggle ${this.syncOnSave ? "checked" : ""} ${this.savingRouting ? "disabled" : ""} />
                    <span>Sync IDEs on Save</span>
                  </label>
                </div>
              `
          }
        </div>

        <p class="mr-policy-desc muted">${escHtml(policyDesc)}</p>

        <div class="mr-status-slot" role="status" aria-live="polite" data-mr-status>
          ${
            this.routingStatus
              ? `<div class="issue-row ${this.routingStatus.kind === "ok" ? "ok" : this.routingStatus.kind === "error" ? "error" : ""}">
                  <span>${this.routingStatus.kind === "ok" ? "✓" : this.routingStatus.kind === "error" ? "✕" : "⋯"}</span>
                  <span class="mr-status-text">${escHtml(this.routingStatus.text)}</span>
                  ${
                    this.routingStatus.retryFn
                      ? `<button type="button" class="btn-secondary btn-sm" data-mr-retry>Retry</button>`
                      : ""
                  }
                </div>`
              : ""
          }
        </div>
      </section>
    `;
  }

  private renderRosterModelSection(
    r: TeamRosterEntry,
    team: TeamDetailsResponse
  ): string {
    const wf = this.getEffectiveWorkflowRouting(team);
    const effIndex = this.modelIndex?.effective ?? buildDefaultModelIndex();
    const rec = effIndex.roleRecommendations[r.id];
    const resolvedRole = this.modelIndex?.routing.resolvedRoles[r.id];
    const recTier = rec?.tier ?? defaultTierForRole(r.roleType, r.id);
    const activeTier = r.modelTier ?? resolvedRole?.modelTier ?? recTier;
    const rolePolicyOverride = r.modelPolicy ?? resolvedRole?.modelPolicy;
    const isMcp = Boolean(this.embedScope.mcpAppMode);
    const lockedIde = this.embedScope.lockedIde;
    const visibleIdes = this.getVisibleHostIdes(team);
    const tierSelectId = `role-tier-${r.id}`;
    const policySelectId = `role-policy-${r.id}`;

    const hostCueBadges: string[] = [];
    if (r.roleType.toLowerCase() === "orchestrator" || rec?.deferToHostOrchestrator) {
      hostCueBadges.push(getHostCueBadgeText(lockedIde));
    }
    if (rec?.multimodalPreferred) {
      hostCueBadges.push("Multimodal");
    }

    const pillsHtml = visibleIdes
      .map((ide) => {
        const res = this.resolvePreviewForRoleIde(r, ide, team);
        const m = getIdeMeta(ide);
        const formatted = this.formatResolvedPillText(
          ide,
          res,
          wf.respectBuiltInOrchestrators,
          Boolean(lockedIde)
        );
        return `
          <span
            class="resolved-model-pill ${res.omitted ? "is-omitted" : ""}"
            style="border-color:${m.border};background:${m.bg}"
            title="${escHtml(formatted.cue)}"
          >
            <strong style="color:${m.color}">${escHtml(formatted.text)}</strong>
            ${
              lockedIde && formatted.cue
                ? `<span class="rm-cue muted">· ${escHtml(formatted.cue)}</span>`
                : ""
            }
          </span>
        `;
      })
      .join("");

    return `
      <div class="roster-model-box">
        <div class="roster-model-head">
          <div class="roster-model-badges">
            <span class="tier-pill tier-${activeTier}">${escHtml(activeTier.toUpperCase())}</span>
            ${hostCueBadges
              .map((c) => `<span class="pill dispatch">${escHtml(c)}</span>`)
              .join("")}
          </div>
          ${
            isMcp
              ? `<span class="pill tool">${escHtml(rolePolicyOverride ?? `inherit (${wf.policy})`)}</span>`
              : ""
          }
        </div>

        ${
          isMcp
            ? `<div class="ro-mcp-cli"><code>agent-studio models set-role ${escHtml(r.id)} --tier ${escHtml(activeTier)}</code></div>`
            : `
              <div class="roster-model-controls">
                <div class="rm-ctrl">
                  <label for="${escHtml(tierSelectId)}">Model Tier</label>
                  <select
                    id="${escHtml(tierSelectId)}"
                    class="ctx-select rm-select"
                    data-role-tier="${escHtml(r.id)}"
                    ${this.savingRouting ? "disabled" : ""}
                  >
                    <option value="" ${!r.modelTier && !resolvedRole?.modelTier ? "selected" : ""}>Index Default (${escHtml(recTier)})</option>
                    <option value="fast" ${(r.modelTier ?? resolvedRole?.modelTier) === "fast" ? "selected" : ""}>Fast</option>
                    <option value="balanced" ${(r.modelTier ?? resolvedRole?.modelTier) === "balanced" ? "selected" : ""}>Balanced</option>
                    <option value="reasoning" ${(r.modelTier ?? resolvedRole?.modelTier) === "reasoning" ? "selected" : ""}>Reasoning</option>
                  </select>
                </div>

                <div class="rm-ctrl">
                  <label for="${escHtml(policySelectId)}">Role Policy</label>
                  <select
                    id="${escHtml(policySelectId)}"
                    class="ctx-select rm-select"
                    data-role-policy="${escHtml(r.id)}"
                    ${this.savingRouting ? "disabled" : ""}
                  >
                    <option value="" ${!rolePolicyOverride ? "selected" : ""}>Inherit (${escHtml(wf.policy)})</option>
                    <option value="prefer-fallback" ${rolePolicyOverride === "prefer-fallback" ? "selected" : ""}>Prefer Fallback</option>
                    <option value="defer-to-host" ${rolePolicyOverride === "defer-to-host" ? "selected" : ""}>Defer to Host</option>
                    <option value="pinned" ${rolePolicyOverride === "pinned" ? "selected" : ""}>Pinned</option>
                  </select>
                </div>
              </div>
            `
        }

        <div class="resolved-model-strip" aria-label="Resolved host models">
          ${pillsHtml}
        </div>
      </div>
    `;
  }

  private render(restoreFocusSelector?: string): void {
    const prevScrollTop = this.root.querySelector<HTMLElement>(".team-view")?.scrollTop ?? 0;

    if (this.loading && !this.data) {
      this.root.innerHTML = `<div class="view-placeholder">Loading Agent Team manifest &amp; IDE definitions…</div>`;
      return;
    }

    if (this.errorMsg && !this.data) {
      this.root.innerHTML = `
        <div class="view-empty-wrap">
          <div class="view-empty-card">
            <h2>Agent Team Details Unavailable</h2>
            <p>${escHtml(this.errorMsg)}</p>
            <p class="muted">Run <code>agent-studio init</code> to create <code>.agent-team/team.yaml</code> and compile native IDE adapters.</p>
            <button type="button" class="btn-primary" data-team-refresh>Retry</button>
          </div>
        </div>
      `;
      this.root
        .querySelector("[data-team-refresh]")
        ?.addEventListener("click", () => void this.load(this.currentProject));
      return;
    }

    const team = this.data;
    if (!team) {
      this.root.innerHTML = `<div class="view-placeholder">No team data loaded.</div>`;
      return;
    }

    const enf = team.workflow.enforcement;
    const checkpoints = Object.entries(team.workflow.checkpoints ?? {});
    const lockedIde = this.embedScope.lockedIde;

    const visibleTargets = lockedIde
      ? [lockedIde]
      : team.targets;

    const visibleIdeFilters = lockedIde
      ? IDE_SOURCE_FILTERS.filter(
          (f) => f.id === "canonical" || f.id === lockedIde
        )
      : IDE_SOURCE_FILTERS;

    const scopedSkills = lockedIde
      ? team.skills.filter(
          (s) => s.source_ide === "canonical" || s.source_ide === lockedIde
        )
      : team.skills;
    const scopedDefs = lockedIde
      ? team.definitions.filter(
          (d) => d.source_ide === "canonical" || d.source_ide === lockedIde
        )
      : team.definitions;

    const rosterIds = new Set(team.roster.map((r) => r.id));
    const defClassifications = new Map<TeamDefinitionEntry, DefinitionClassification>();
    let projectCustomCount = 0;
    let globalCount = 0;
    for (const d of scopedDefs) {
      const info = classifyDefinition(d, team, rosterIds);
      defClassifications.set(d, info);
      if (info.isProjectCustom) projectCustomCount += 1;
      if (info.scope === "global") globalCount += 1;
    }

    const activeSourceFilter: SourceFilter =
      this.catalogTab === "skills" &&
      (this.sourceFilter === "project-custom" || this.sourceFilter === "global")
        ? "all"
        : this.sourceFilter === "global" && globalCount === 0
          ? "all"
          : this.sourceFilter;

    const filteredSkills =
      activeSourceFilter === "all"
        ? scopedSkills
        : scopedSkills.filter((s) => s.source_ide === activeSourceFilter);
    const filteredDefs =
      activeSourceFilter === "all"
        ? scopedDefs
        : activeSourceFilter === "project-custom"
          ? scopedDefs.filter((d) => defClassifications.get(d)?.isProjectCustom)
          : activeSourceFilter === "global"
            ? scopedDefs.filter((d) => defClassifications.get(d)?.scope === "global")
            : scopedDefs.filter((d) => d.source_ide === activeSourceFilter);

    const catalogFilterChips: Array<{ id: SourceFilter; label: string; isCustom?: boolean }> = [
      {
        id: "all",
        label: `All (${this.catalogTab === "skills" ? scopedSkills.length : scopedDefs.length})`,
      },
    ];
    if (this.catalogTab === "definitions") {
      catalogFilterChips.push({
        id: "project-custom",
        label: `Project / Custom (${projectCustomCount})`,
        isCustom: true,
      });
      if (globalCount > 0) {
        catalogFilterChips.push({
          id: "global",
          label: `Global (${globalCount})`,
        });
      }
    }
    for (const f of visibleIdeFilters) {
      catalogFilterChips.push({ id: f.id, label: f.label });
    }

    this.root.innerHTML = `
      <div class="team-view">
        <section class="card team-hero">
          <div class="team-hero-top">
            <div class="team-hero-copy">
              <div class="team-title-row">
                <h2>${escHtml(team.project.title || team.project.id)}</h2>
                <span class="cp-badge cp-${team.hasManifest ? "passed" : "running"}">
                  ${team.hasManifest ? "✓ .agent-team/team.yaml" : "DISCOVERED ONLY"}
                </span>
              </div>
              ${
                team.project.description
                  ? `<p class="muted">${escHtml(team.project.description)}</p>`
                  : ""
              }
              <div class="team-targets-row">
                ${visibleTargets
                  .map((t) => {
                    const m = getIdeMeta(t);
                    return `<span class="ide-chip" style="color:${m.color};border-color:${m.border};background:${m.bg}">${escHtml(m.label)}</span>`;
                  })
                  .join("")}
                ${
                  team.project.root
                    ? `<code class="team-root-path">${escHtml(team.project.root)}</code>`
                    : ""
                }
              </div>
            </div>
            <div class="team-hero-actions">
              <button
                type="button"
                class="btn-secondary"
                data-team-refresh
                ${this.loading ? "disabled" : ""}
              >${this.loading ? "Refreshing…" : "↻ Refresh"}</button>
            </div>
          </div>

          <div class="team-workflow-bar">
            <div class="stage-pipeline" aria-label="Workflow lifecycle stages">
              ${team.workflow.stages
                .map(
                  (st, i) =>
                    `${i > 0 ? `<span class="stage-arrow" aria-hidden="true">→</span>` : ""}<span class="stage-pill">${escHtml(st)}</span>`
                )
                .join("")}
            </div>
            <div class="enforcement-pills" aria-label="Active guardrails">
              <span class="pill ${enf.orchestratorReadOnly ? "ok" : "tool"}">
                ${enf.orchestratorReadOnly ? "✓" : "○"} Read-Only Orchestrator
              </span>
              <span class="pill ${enf.qaGateRequired ? "ok" : "tool"}">
                ${enf.qaGateRequired ? "✓" : "○"} QA Gate Required
              </span>
              <span class="pill ${enf.blockDirectBoardEdits ? "ok" : "tool"}">
                ${enf.blockDirectBoardEdits ? "✓" : "○"} Board Edits Blocked
              </span>
            </div>
          </div>

          ${
            checkpoints.length > 0
              ? `<div class="team-cp-grid" aria-label="Verification checkpoints">
                  ${checkpoints
                    .map(
                      ([cpId, cp]) => `
                        <article class="cp-card">
                          <div class="cp-card-head">
                            <div>
                              <span class="pill dispatch">${escHtml(cpId)}</span>
                              <strong>${escHtml(cp.title)}</strong>
                            </div>
                            ${
                              cp.command
                                ? `<button type="button" class="guide-copy-btn" data-copy-cp="${escHtml(cpId)}">Copy</button>`
                                : ""
                            }
                          </div>
                          ${
                            cp.command
                              ? `<div class="code-scroll cp-cmd-scroll" role="region" tabindex="0" aria-label="${escHtml(cpId)} command"><code>${escHtml(cp.command)}</code></div>`
                              : ""
                          }
                        </article>
                      `
                    )
                    .join("")}
                </div>`
              : ""
          }
        </section>

        ${this.renderModelRoutingBar(team)}

        <section class="team-section" aria-labelledby="teamRosterHeading">
          <div class="team-section-head">
            <div class="team-section-title-row">
              <h3 id="teamRosterHeading">Canonical Team Roster (${team.roster.length})</h3>
              ${
                projectCustomCount > 0
                  ? `<button
                      type="button"
                      class="team-custom-jump-pill"
                      data-jump-project-custom
                      title="Jump to project-specific non-roster agents"
                    >+ ${projectCustomCount} Project Agent${projectCustomCount === 1 ? "" : "s"} ↓</button>`
                  : ""
              }
            </div>
            <span class="muted">Single source of truth in <code>.agent-team/</code></span>
          </div>
          ${
            team.roster.length === 0
              ? `<div class="card"><div class="board-panel-body muted">No canonical roster entries found in <code>.agent-team/team.yaml</code>. Run <code>agent-studio init</code> to scaffold the blueprint.</div></div>`
              : `<div class="team-roster-grid">
                  ${team.roster
                    .map(
                      (r) => `
                        <article class="card roster-card">
                          <div class="roster-card-head">
                            <div class="roster-title-wrap">
                              <strong>${escHtml(r.name)}</strong>
                              <code class="roster-id">${escHtml(r.id)}</code>
                            </div>
                            <div class="roster-badges">
                              <span class="team-role-badge ${roleBadgeClass(r.roleType)}">${escHtml(r.roleType)}</span>
                              <span class="pill tool">${escHtml(r.boardRole)}</span>
                            </div>
                          </div>
                          <div class="roster-card-body">
                            <p class="roster-desc">${escHtml(r.description || "Specialist role")}</p>
                            ${this.renderRosterModelSection(r, team)}
                            ${
                              r.capabilities.length > 0
                                ? `<div class="chip-wrap">${r.capabilities
                                    .map((c) => `<span class="cap-chip">${escHtml(c)}</span>`)
                                    .join("")}</div>`
                                : ""
                            }
                            ${
                              r.handoffs.length > 0
                                ? `<div class="chip-wrap">${r.handoffs
                                    .map((h) => `<span class="handoff-pill">→ ${escHtml(h)}</span>`)
                                    .join("")}</div>`
                                : ""
                            }
                          </div>
                          <div class="roster-card-foot">
                            <span class="muted token-est">~${r.est_tokens} tokens</span>
                            <div class="roster-foot-actions">
                              <button
                                type="button"
                                class="btn-secondary btn-sm"
                                data-roster-override="${escHtml(r.id)}"
                              >${this.embedScope.mcpAppMode ? "Inspect Overrides…" : "Customize Model…"}</button>
                              <button
                                type="button"
                                class="ide-guide-jump roster-prompt-btn"
                                data-roster-id="${escHtml(r.id)}"
                              >View Prompt →</button>
                            </div>
                          </div>
                        </article>
                      `
                    )
                    .join("")}
                </div>`
          }
        </section>

        <section class="card team-catalog" aria-labelledby="teamCatalogHeading">
          <div class="team-catalog-head">
            <div class="team-catalog-top">
              <div class="team-catalog-title-wrap">
                <h3 id="teamCatalogHeading">Skills &amp; Discovered IDE Definitions</h3>
                ${
                  projectCustomCount > 0
                    ? `<button
                        type="button"
                        class="team-catalog-hint-btn"
                        data-jump-project-custom
                      >${projectCustomCount} project-specific non-roster agent${projectCustomCount === 1 ? "" : "s"}</button>`
                    : ""
                }
              </div>
              <div class="guide-tabs" role="tablist" aria-label="Catalog view">
                <button
                  type="button"
                  role="tab"
                  class="guide-tab"
                  data-catalog-tab="definitions"
                  aria-selected="${this.catalogTab === "definitions" ? "true" : "false"}"
                >Agents &amp; Definitions (${filteredDefs.length})</button>
                <button
                  type="button"
                  role="tab"
                  class="guide-tab"
                  data-catalog-tab="skills"
                  aria-selected="${this.catalogTab === "skills" ? "true" : "false"}"
                >Skills (${filteredSkills.length})</button>
              </div>
            </div>
            <div class="source-filter-bar" role="group" aria-label="Filter by source IDE or agent scope">
              ${catalogFilterChips
                .map(
                  (f) => `
                    <button
                      type="button"
                      class="filter-chip ${f.isCustom ? "filter-chip-custom" : ""}"
                      data-source-filter="${f.id}"
                      aria-pressed="${activeSourceFilter === f.id ? "true" : "false"}"
                    >${escHtml(f.label)}</button>
                  `
                )
                .join("")}
            </div>
          </div>

          <div class="team-catalog-body">
            ${
              this.catalogTab === "skills"
                ? this.renderSkillsGrid(filteredSkills)
                : this.renderDefinitionsGrid(filteredDefs, defClassifications, activeSourceFilter)
            }
          </div>
        </section>
      </div>
    `;

    this.bindInteractions(team, filteredSkills, filteredDefs);
    const teamViewEl = this.root.querySelector<HTMLElement>(".team-view");
    if (teamViewEl && prevScrollTop > 0) teamViewEl.scrollTop = prevScrollTop;
    if (restoreFocusSelector) {
      this.root.querySelector<HTMLElement>(restoreFocusSelector)?.focus();
    }
  }

  private renderSkillsGrid(skills: TeamSkillEntry[]): string {
    if (skills.length === 0) {
      return `<div class="empty-state">No skills match the selected IDE filter.</div>`;
    }
    return `
      <div class="team-defs-grid">
        ${skills
          .map((s, idx) => {
            const m = sourceBadgeMeta(s.source_ide);
            return `
              <button type="button" class="def-tile" data-skill-idx="${idx}">
                <div class="def-tile-top">
                  <strong>${escHtml(s.name || s.id)}</strong>
                  <span class="ide-chip" style="color:${m.color};border-color:${m.border};background:${m.bg}">${escHtml(m.label)}</span>
                </div>
                <p class="def-tile-desc">${escHtml(trunc(s.description || s.source_path, 120))}</p>
                <div class="def-tile-foot">
                  <code>${escHtml(trunc(s.source_path, 42))}</code>
                  <span class="token-est">~${s.est_tokens}t</span>
                </div>
              </button>
            `;
          })
          .join("")}
      </div>
    `;
  }

  private renderDefinitionsGrid(
    defs: TeamDefinitionEntry[],
    classifications: Map<TeamDefinitionEntry, DefinitionClassification>,
    activeFilter: SourceFilter
  ): string {
    if (defs.length === 0) {
      const msg =
        activeFilter === "project-custom"
          ? "No project-specific custom (non-roster) agents found in .agents/agents/, .claude/agents/, or .github/agents/."
          : activeFilter === "global"
            ? "No global agent definitions found in ~/.gemini/, ~/.claude/agents/, or ~/.copilot/ ($COPILOT_HOME)."
            : "No agent definitions match the selected filter.";
      return `<div class="empty-state">${escHtml(msg)}</div>`;
    }
    return `
      <div class="team-defs-grid">
        ${defs
          .map((d, idx) => {
            const m = sourceBadgeMeta(d.source_ide);
            const info = classifications.get(d);
            const tools = (d.tools ?? d.capabilities ?? []).slice(0, 5);
            const extraTools = Math.max(0, (d.tools ?? d.capabilities ?? []).length - tools.length);
            return `
              <button type="button" class="def-tile ${info?.isProjectCustom ? "is-project-custom" : ""}" data-def-idx="${idx}">
                <div class="def-tile-top">
                  <div class="def-tile-name">
                    <strong>${escHtml(d.name || d.id)}</strong>
                    <code>${escHtml(d.id)}</code>
                  </div>
                  <div class="def-tile-badges">
                    ${info ? renderDefinitionScopeBadges(info) : ""}
                    <span class="ide-chip" style="color:${m.color};border-color:${m.border};background:${m.bg}">${escHtml(m.label)}</span>
                  </div>
                </div>
                <p class="def-tile-desc">${escHtml(trunc(d.description || d.source_path, 110))}</p>
                ${
                  tools.length > 0
                    ? `<div class="chip-wrap">
                        ${tools.map((t) => `<span class="cap-chip">${escHtml(t)}</span>`).join("")}
                        ${extraTools > 0 ? `<span class="cap-chip">+${extraTools}</span>` : ""}
                      </div>`
                    : ""
                }
                <div class="def-tile-foot">
                  <code>${escHtml(trunc(d.source_path, 42))}</code>
                  <span class="token-est">~${d.est_tokens}t</span>
                </div>
              </button>
            `;
          })
          .join("")}
      </div>
    `;
  }

  private bindInteractions(
    team: TeamDetailsResponse,
    filteredSkills: TeamSkillEntry[],
    filteredDefs: TeamDefinitionEntry[]
  ): void {
    this.root
      .querySelector("[data-team-refresh]")
      ?.addEventListener("click", () => void this.load(this.currentProject));

    this.root.querySelectorAll<HTMLButtonElement>("[data-copy-cp]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const cpId = btn.dataset.copyCp;
        const cmd = cpId ? team.workflow.checkpoints[cpId]?.command : undefined;
        if (!cmd) return;
        const ok = await copyTextSafe(cmd);
        btn.textContent = ok ? "Copied ✓" : "Failed";
        btn.classList.toggle("copied", ok);
        window.setTimeout(() => {
          btn.textContent = "Copy";
          btn.classList.remove("copied");
        }, 1600);
      });
    });

    // Model Routing Policy Bar interactions
    this.root.querySelector<HTMLSelectElement>("[data-mr-policy]")?.addEventListener("change", (ev) => {
      const policy = (ev.target as HTMLSelectElement).value as ModelRoutingPolicy;
      void this.mutateRouting(
        { workflow: { policy } },
        `Updated default routing policy to "${policy}".`,
        "[data-mr-policy]"
      );
    });

    this.root
      .querySelector<HTMLInputElement>("[data-mr-respect-host]")
      ?.addEventListener("change", (ev) => {
        const checked = (ev.target as HTMLInputElement).checked;
        const label = getRespectOrchestratorLabel(this.embedScope.lockedIde);
        void this.mutateRouting(
          { workflow: { respectBuiltInOrchestrators: checked } },
          checked ? `Enabled ${label}.` : `Disabled ${label}.`,
          "[data-mr-respect-host]"
        );
      });

    this.root
      .querySelector<HTMLInputElement>("[data-mr-sync-toggle]")
      ?.addEventListener("change", (ev) => {
        this.syncOnSave = (ev.target as HTMLInputElement).checked;
      });

    this.root.querySelector("[data-mr-retry]")?.addEventListener("click", () => {
      this.routingStatus?.retryFn?.();
    });

    this.root.querySelector("[data-mr-adopt]")?.addEventListener("click", () => {
      void this.adoptGlobalCatalog(team);
    });

    this.root.querySelector("[data-mr-open-index]")?.addEventListener("click", () => {
      const view =
        this.modelIndex ?? synthesizeModelIndexViewFromTeam(team);
      this.modelIndexDialog.open({
        view,
        projectId: this.currentProject,
        workspace: this.currentWorkspace || this.embedScope.lockedWorkspace || "",
        embedScope: this.embedScope,
        initialTab: this.embedScope.lockedIde ?? undefined,
      });
    });

    this.root.querySelector<HTMLButtonElement>("[data-mr-copy-cli]")?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      const cmd = btn.dataset.mrCopyCli ?? "";
      const ok = await copyTextSafe(cmd);
      btn.textContent = ok ? "Copied ✓" : "Failed";
      btn.classList.toggle("copied", ok);
      window.setTimeout(() => {
        btn.textContent = "Copy CLI";
        btn.classList.remove("copied");
      }, 1500);
    });

    // Per-role tier & policy controls
    this.root.querySelectorAll<HTMLSelectElement>("[data-role-tier]").forEach((sel) => {
      sel.addEventListener("change", () => {
        const roleId = sel.dataset.roleTier;
        if (!roleId) return;
        const val = sel.value ? (sel.value as ModelTier) : null;
        void this.mutateRouting(
          { role: { id: roleId, modelTier: val } },
          val
            ? `Set ${roleId} modelTier to "${val}".`
            : `Reset ${roleId} modelTier to Model Index default.`,
          `[data-role-tier="${roleId}"]`
        );
      });
    });

    this.root.querySelectorAll<HTMLSelectElement>("[data-role-policy]").forEach((sel) => {
      sel.addEventListener("change", () => {
        const roleId = sel.dataset.rolePolicy;
        if (!roleId) return;
        const val = sel.value ? (sel.value as ModelRoutingPolicy) : null;
        void this.mutateRouting(
          { role: { id: roleId, modelPolicy: val } },
          val
            ? `Set ${roleId} modelPolicy to "${val}".`
            : `Inherited ${roleId} policy from workflow default.`,
          `[data-role-policy="${roleId}"]`
        );
      });
    });

    const rosterById = new Map(team.roster.map((r) => [r.id, r]));
    this.root.querySelectorAll<HTMLButtonElement>("[data-roster-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = btn.dataset.rosterId ? rosterById.get(btn.dataset.rosterId) : undefined;
        if (entry) this.openRosterDetail(entry);
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>("[data-roster-override]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = btn.dataset.rosterOverride
          ? rosterById.get(btn.dataset.rosterOverride)
          : undefined;
        if (entry) this.openRoleOverrideModal(entry, team);
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>("[data-jump-project-custom]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.catalogTab = "definitions";
        this.sourceFilter = "project-custom";
        this.render('[data-source-filter="project-custom"]');
        const catalogEl = this.root.querySelector<HTMLElement>(".team-catalog");
        catalogEl?.scrollIntoView({ behavior: "smooth", block: "start" });
        const activeChip = this.root.querySelector<HTMLElement>(
          '[data-source-filter="project-custom"]'
        );
        activeChip?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>("[data-catalog-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.catalogTab as CatalogTab | undefined;
        if (tab && tab !== this.catalogTab) {
          this.catalogTab = tab;
          if (
            tab === "skills" &&
            (this.sourceFilter === "project-custom" || this.sourceFilter === "global")
          ) {
            this.sourceFilter = "all";
          }
          this.render(`[data-catalog-tab="${tab}"]`);
        }
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>("[data-source-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const src = btn.dataset.sourceFilter as SourceFilter | undefined;
        if (src && src !== this.sourceFilter) {
          this.sourceFilter = src;
          this.render(`[data-source-filter="${src}"]`);
          const activeChip = this.root.querySelector<HTMLElement>(
            `[data-source-filter="${src}"]`
          );
          activeChip?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>("[data-skill-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.skillIdx);
        const skill = filteredSkills[idx];
        if (skill) this.openSkillDetail(skill);
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>("[data-def-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.defIdx);
        const def = filteredDefs[idx];
        if (def) this.openDefinitionDetail(def);
      });
    });
  }
}
