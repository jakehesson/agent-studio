import fs from "node:fs";
import path from "node:path";
import { resolveProject } from "../../board/registry.js";
import {
  installGlobalSetupAgent,
  type GlobalInstallResult,
} from "../../compiler/global-install.js";
import {
  assertContainedPath,
  compileTeam,
  computeDrift,
  loadTeamManifest,
  planCompiledFiles,
  type CompileResult,
} from "../../compiler/index.js";
import {
  normalizeLf,
  sha256Hex,
  type DriftReport,
} from "../../compiler/merge.js";
import { normalizeLegacyCopilotModelId } from "../../models/defaults.js";
import {
  getGlobalModelIndexPath,
  getTeamYamlPath,
  getWorkspaceModelIndexPath,
  readModelIndexLayer,
  withFileLock,
  writeJsonAtomic,
  writeTeamYamlAtomic,
} from "../../models/store.js";
import {
  DEFAULT_MODEL_INDEX,
  ModelIndexOverlaySchema,
  type IdeModelOverlay,
  type ModelCatalogEntry,
  type ModelIndexOverlay,
} from "../../schema/model-index.js";
import {
  IdeTargetSchema,
  parseTeamYaml,
  resolveCopilotHarness,
  serializeTeamYaml,
  type IdeModelOverride,
  type IdeTarget,
  type TeamManifest,
} from "../../schema/team.js";
import {
  getUpgradeStatePath,
  normalizeUpgradeStateKey,
  readUpgradeState,
  resolveAgentStudioVersion,
  serializeUpgradeState,
  sortUpgradeState,
  type ManagedFileRecord,
  type UpgradeState,
} from "../../schema/upgrade-state.js";
import { detectRepoStack, type DetectedRepoInfo } from "../../templates/detect.js";
import {
  renderArchitectPrompt,
  renderBackendEngineerPrompt,
  renderCodeReviewerPrompt,
  renderFrontendEngineerPrompt,
  renderOrchestratorPrompt,
  renderQaValidatorPrompt,
  renderTeamSetupPrompt,
  renderUxDesignerPrompt,
} from "../../templates/prompts.js";
import { getDefaultSkills } from "../../templates/skills.js";
import { buildDoctorReport, type DoctorReport } from "./doctor.js";

const ALL_IDES: IdeTarget[] = ["antigravity", "claude-code", "copilot-vscode"];

export interface UpgradeDiffEntry {
  path: string;
  diff: string;
}

export interface ModelMigrationSummary {
  changed: boolean;
  rewrittenIds: Array<{ from: string; to: string; location: string }>;
  addedCatalogIds: Array<{ ide: IdeTarget; id: string }>;
  addedRoleRecommendations: string[];
  dedupedCatalogIds: string[];
}

export interface UpgradeCommandResult {
  ok: boolean;
  dryRun: boolean;
  force: boolean;
  global: boolean;
  projectRoot?: string;
  firstTimeBootstrap: boolean;
  addedFiles: string[];
  fastForwardedFiles: string[];
  unchangedFiles: string[];
  preservedCustomizedFiles: string[];
  preservedDeletedFiles: string[];
  forcedFiles: string[];
  incomingWritten: string[];
  diffs: UpgradeDiffEntry[];
  teamYamlUpdated: boolean;
  teamYamlChanges: string[];
  workspaceModelIndex: ModelMigrationSummary;
  globalModelIndex?: ModelMigrationSummary;
  upgradeStateUpdated: boolean;
  globalResult?: GlobalInstallResult;
  compileResult?: CompileResult;
  dryRunDrift?: DriftReport;
  doctorReport?: DoctorReport;
}

interface ParsedUpgradeArgs {
  projectRef?: string;
  hasExplicitProject: boolean;
  ides?: IdeTarget[];
  dryRun: boolean;
  diff: boolean;
  writeIncoming: boolean;
  force: boolean;
  global: boolean;
  useGlobalIndex: boolean;
  json: boolean;
  quiet: boolean;
}

function parseIdeList(raw: string): IdeTarget[] {
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Expected at least one IDE target for --ides.");
  }
  return tokens.map((token) => IdeTargetSchema.parse(token));
}

function parseUpgradeArgs(args: string[]): ParsedUpgradeArgs {
  let projectRef: string | undefined;
  let hasExplicitProject = false;
  let ides: IdeTarget[] | undefined;
  let dryRun = false;
  let diff = false;
  let writeIncoming = false;
  let force = false;
  let global = false;
  let useGlobalIndex = false;
  let json = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token) continue;
    if (token === "--dry-run") {
      dryRun = true;
    } else if (token === "--diff") {
      diff = true;
    } else if (token === "--write-incoming") {
      writeIncoming = true;
    } else if (token === "--force") {
      force = true;
    } else if (token === "--global") {
      global = true;
    } else if (token === "--use-global-index") {
      useGlobalIndex = true;
    } else if (token === "--json") {
      json = true;
    } else if (token === "--quiet") {
      quiet = true;
    } else if (token === "--project" && args[i + 1]) {
      projectRef = args[++i];
      hasExplicitProject = true;
    } else if (token.startsWith("--project=")) {
      projectRef = token.slice("--project=".length);
      hasExplicitProject = true;
    } else if (token === "--ides" && args[i + 1]) {
      ides = parseIdeList(args[++i]!);
    } else if (token.startsWith("--ides=")) {
      ides = parseIdeList(token.slice("--ides=".length));
    }
  }

  return {
    projectRef,
    hasExplicitProject,
    ides,
    dryRun,
    diff,
    writeIncoming,
    force,
    global,
    useGlobalIndex,
    json,
    quiet,
  };
}

function resolveProjectRootArg(projectRef?: string): string {
  if (!projectRef) {
    return path.resolve(process.cwd());
  }
  const directPath = path.resolve(projectRef);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isDirectory()) {
    return directPath;
  }
  return resolveProject(projectRef).root;
}

/**
 * Generates a compact line-level unified diff between local and incoming content.
 */
export function createUnifiedDiff(
  relPath: string,
  localText: string,
  incomingText: string,
): string {
  const a = normalizeLf(localText).split("\n");
  const b = normalizeLf(incomingText).split("\n");
  const m = a.length;
  const n = b.length;

  // LCS matrix for bounded markdown templates
  const dp: Uint32Array[] = Array.from(
    { length: m + 1 },
    () => new Uint32Array(n + 1),
  );
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    const lineA = a[i]!;
    for (let j = n - 1; j >= 0; j--) {
      if (lineA === b[j]) {
        row[j] = 1 + nextRow[j + 1]!;
      } else {
        row[j] = nextRow[j]! >= row[j + 1]! ? nextRow[j]! : row[j + 1]!;
      }
    }
  }

  type Op = { kind: " " | "-" | "+"; line: string; aLine: number; bLine: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]!, aLine: i + 1, bLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "-", line: a[i]!, aLine: i + 1, bLine: j + 1 });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j]!, aLine: i + 1, bLine: j + 1 });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: "-", line: a[i]!, aLine: i + 1, bLine: j + 1 });
    i++;
  }
  while (j < n) {
    ops.push({ kind: "+", line: b[j]!, aLine: i + 1, bLine: j + 1 });
    j++;
  }

  const changedIndices: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.kind !== " ") changedIndices.push(k);
  }
  if (changedIndices.length === 0) return "";

  const ctx = 3;
  const hunks: Array<[number, number]> = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - ctx);
    const end = Math.min(ops.length - 1, idx + ctx);
    const prev = hunks[hunks.length - 1];
    if (prev && start <= prev[1] + 1) {
      prev[1] = end;
    } else {
      hunks.push([start, end]);
    }
  }

  const out = [
    `--- a/.agent-team/${relPath}`,
    `+++ b/.agent-team/${relPath} (incoming)`,
  ];
  for (const [start, end] of hunks) {
    const slice = ops.slice(start, end + 1);
    const aStart = slice[0]!.aLine;
    const bStart = slice[0]!.bLine;
    const aCount = slice.filter((o) => o.kind !== "+").length;
    const bCount = slice.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of slice) {
      out.push(`${op.kind}${op.line}`);
    }
  }
  return out.join("\n") + "\n";
}

function buildStockMarkdownMap(
  manifest: TeamManifest,
  detected: DetectedRepoInfo,
): Map<string, string> {
  const map = new Map<string, string>();
  const roleRenderers: Record<string, () => string> = {
    orchestrator: () => renderOrchestratorPrompt(manifest),
    architect: () => renderArchitectPrompt(manifest),
    "ux-designer": () => renderUxDesignerPrompt(manifest),
    "backend-engineer": () => renderBackendEngineerPrompt(manifest),
    "frontend-engineer": () => renderFrontendEngineerPrompt(manifest),
    "code-reviewer": () => renderCodeReviewerPrompt(manifest, detected),
    "qa-validator": () => renderQaValidatorPrompt(manifest),
    "team-setup": () => renderTeamSetupPrompt(manifest),
  };

  for (const role of manifest.roster) {
    const renderer = roleRenderers[role.id];
    if (!renderer) continue;
    const key = normalizeUpgradeStateKey(role.promptFile);
    map.set(key, renderer());
  }

  for (const skill of getDefaultSkills(detected)) {
    const key = normalizeUpgradeStateKey(`${skill.relDir}/SKILL.md`);
    map.set(key, skill.content);
  }

  return map;
}

function isArchReviewCustomized(relKey: string, rawContent: string): boolean {
  if (relKey !== "skills/architecture-review/SKILL.md") return false;
  return (
    !rawContent.includes("PENDING DEEP RESEARCH") &&
    !rawContent.includes("architecture-research: pending")
  );
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function migrateCopilotOverride(
  override: IdeModelOverride,
  roleId: string,
  rewrites: Array<{ from: string; to: string; location: string }>,
): { next: IdeModelOverride; changed: boolean } {
  if (typeof override === "string") {
    const mapped = normalizeLegacyCopilotModelId(override);
    if (mapped !== override) {
      rewrites.push({
        from: override,
        to: mapped,
        location: `team.yaml:roster.${roleId}.models.copilot-vscode`,
      });
      return { next: mapped, changed: true };
    }
    return { next: override, changed: false };
  }

  if (Array.isArray(override)) {
    let changed = false;
    const mappedList = override.map((id) => {
      const mapped = normalizeLegacyCopilotModelId(id);
      if (mapped !== id) {
        changed = true;
        rewrites.push({
          from: id,
          to: mapped,
          location: `team.yaml:roster.${roleId}.models.copilot-vscode`,
        });
      }
      return mapped;
    });
    const deduped = dedupeStrings(mappedList);
    if (deduped.length !== mappedList.length) changed = true;
    return { next: deduped, changed };
  }

  let changed = false;
  const clone: Record<string, unknown> = { ...override };
  if (typeof override.primary === "string") {
    const mapped = normalizeLegacyCopilotModelId(override.primary);
    if (mapped !== override.primary) {
      changed = true;
      rewrites.push({
        from: override.primary,
        to: mapped,
        location: `team.yaml:roster.${roleId}.models.copilot-vscode.primary`,
      });
      clone.primary = mapped;
    }
  }
  if (Array.isArray(override.fallback)) {
    const mappedFb = override.fallback.map((id) => {
      const mapped = normalizeLegacyCopilotModelId(id);
      if (mapped !== id) {
        changed = true;
        rewrites.push({
          from: id,
          to: mapped,
          location: `team.yaml:roster.${roleId}.models.copilot-vscode.fallback`,
        });
      }
      return mapped;
    });
    const deduped = dedupeStrings(mappedFb);
    if (deduped.length !== mappedFb.length) changed = true;
    clone.fallback = deduped;
  }
  return { next: clone as IdeModelOverride, changed };
}

function applyTeamYamlUpgrades(
  manifest: TeamManifest,
  skillsToRegister: string[],
): { next: TeamManifest; changed: boolean; changes: string[] } {
  const next: TeamManifest = JSON.parse(JSON.stringify(manifest)) as TeamManifest;
  const changes: string[] = [];
  let changed = false;

  if (!next.workflow.modelRouting) {
    next.workflow.modelRouting = {
      policy: "prefer-fallback",
      respectBuiltInOrchestrators: true,
      allowSubagentModelHints: true,
      copilotHandoffModels: false,
      selectionPriority: ["accuracy", "cost", "speed"],
    };
    changed = true;
    changes.push("Added workflow.modelRouting defaults");
  }

  if (!next.workflow.contextThresholds) {
    next.workflow.contextThresholds = {
      warnPercent: 45,
      handoffPercent: 55,
      compactPercent: 70,
    };
    changed = true;
    changes.push("Added workflow.contextThresholds defaults");
  }

  const existingSkills = new Set(next.skills.map((s) => s.replace(/\\/g, "/")));
  for (const skillDir of skillsToRegister) {
    const normalized = skillDir.replace(/\\/g, "/");
    if (!existingSkills.has(normalized)) {
      next.skills.push(normalized);
      existingSkills.add(normalized);
      changed = true;
      changes.push(`Registered skill "${normalized}"`);
    }
  }

  const rewrites: Array<{ from: string; to: string; location: string }> = [];
  for (const role of next.roster) {
    const copilotOverride = role.models?.["copilot-vscode"];
    if (!copilotOverride) continue;
    const migrated = migrateCopilotOverride(copilotOverride, role.id, rewrites);
    if (migrated.changed) {
      role.models!["copilot-vscode"] = migrated.next;
      changed = true;
    }
  }
  for (const rw of rewrites) {
    changes.push(`Rewrote ${rw.location}: "${rw.from}" -> "${rw.to}"`);
  }

  return { next, changed, changes };
}

function dedupeCopilotCatalogEntries(
  entries: ModelCatalogEntry[],
  dedupedIds: string[],
): ModelCatalogEntry[] {
  const byId = new Map<string, ModelCatalogEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      continue;
    }
    dedupedIds.push(entry.id);
    // Prefer non-"built-in" entries (live vscode-lm, user, agent) over built-in stock entries
    const existingIsBuiltIn = existing.source === "built-in";
    const nextIsBuiltIn = entry.source === "built-in";
    if (existingIsBuiltIn && !nextIsBuiltIn) {
      byId.set(entry.id, entry);
    } else if (!existingIsBuiltIn && nextIsBuiltIn) {
      // keep existing live/user entry
    } else {
      // Preserve unavailable flag if either marks unavailable
      if (existing.available === false && entry.available !== false) {
        byId.set(entry.id, { ...entry, available: false });
      }
    }
  }
  return [...byId.values()];
}

export function migrateModelIndexOverlay(
  current: ModelIndexOverlay,
  options?: { addMissingRoleRecommendations?: boolean },
): { next: ModelIndexOverlay; summary: ModelMigrationSummary } {
  const next: ModelIndexOverlay = JSON.parse(
    JSON.stringify(current),
  ) as ModelIndexOverlay;
  const rewrittenIds: ModelMigrationSummary["rewrittenIds"] = [];
  const addedCatalogIds: ModelMigrationSummary["addedCatalogIds"] = [];
  const addedRoleRecommendations: string[] = [];
  const dedupedCatalogIds: string[] = [];
  let changed = false;

  if (next.ides?.["copilot-vscode"]) {
    const copilot: IdeModelOverlay = next.ides["copilot-vscode"];
    if (copilot.tiers) {
      for (const tierName of ["fast", "balanced", "reasoning"] as const) {
        const binding = copilot.tiers[tierName];
        if (!binding) continue;
        if (binding.primary) {
          const mapped = normalizeLegacyCopilotModelId(binding.primary);
          if (mapped !== binding.primary) {
            rewrittenIds.push({
              from: binding.primary,
              to: mapped,
              location: `ides.copilot-vscode.tiers.${tierName}.primary`,
            });
            binding.primary = mapped;
            changed = true;
          }
        }
        if (Array.isArray(binding.fallback)) {
          const mappedFb = binding.fallback.map((id) => {
            const mapped = normalizeLegacyCopilotModelId(id);
            if (mapped !== id) {
              rewrittenIds.push({
                from: id,
                to: mapped,
                location: `ides.copilot-vscode.tiers.${tierName}.fallback`,
              });
              changed = true;
            }
            return mapped;
          });
          const deduped = dedupeStrings(mappedFb);
          if (
            deduped.length !== binding.fallback.length ||
            deduped.some((v, idx) => v !== binding.fallback![idx])
          ) {
            binding.fallback = deduped;
            changed = true;
          }
        }
      }
    }

    if (Array.isArray(copilot.catalog)) {
      const rewrittenCatalog = copilot.catalog.map((entry) => {
        const mapped = normalizeLegacyCopilotModelId(entry.id);
        if (mapped !== entry.id) {
          rewrittenIds.push({
            from: entry.id,
            to: mapped,
            location: "ides.copilot-vscode.catalog",
          });
          changed = true;
          return { ...entry, id: mapped };
        }
        return entry;
      });
      const deduped = dedupeCopilotCatalogEntries(
        rewrittenCatalog,
        dedupedCatalogIds,
      );
      if (deduped.length !== rewrittenCatalog.length) {
        changed = true;
      }
      copilot.catalog = deduped;
    }
  }

  if (next.ides) {
    for (const ide of ALL_IDES) {
      const ideCfg = next.ides[ide];
      if (!ideCfg || !Array.isArray(ideCfg.catalog)) continue;
      const existingIds = new Set(ideCfg.catalog.map((e) => e.id));
      for (const stockEntry of DEFAULT_MODEL_INDEX.ides[ide].catalog) {
        if (!existingIds.has(stockEntry.id)) {
          ideCfg.catalog.push(
            JSON.parse(JSON.stringify(stockEntry)) as ModelCatalogEntry,
          );
          existingIds.add(stockEntry.id);
          addedCatalogIds.push({ ide, id: stockEntry.id });
          changed = true;
        }
      }
    }
  }

  if (
    options?.addMissingRoleRecommendations !== false &&
    next.roleRecommendations
  ) {
    for (const [roleId, rec] of Object.entries(
      DEFAULT_MODEL_INDEX.roleRecommendations,
    )) {
      if (!(roleId in next.roleRecommendations)) {
        next.roleRecommendations[roleId] = JSON.parse(JSON.stringify(rec));
        addedRoleRecommendations.push(roleId);
        changed = true;
      }
    }
  }

  const validated = ModelIndexOverlaySchema.parse(next);
  return {
    next: validated,
    summary: {
      changed,
      rewrittenIds,
      addedCatalogIds,
      addedRoleRecommendations,
      dedupedCatalogIds: dedupeStrings(dedupedCatalogIds),
    },
  };
}

function emptyMigrationSummary(): ModelMigrationSummary {
  return {
    changed: false,
    rewrittenIds: [],
    addedCatalogIds: [],
    addedRoleRecommendations: [],
    dedupedCatalogIds: [],
  };
}

async function migrateModelIndexFile(
  filePath: string,
  dryRun: boolean,
  options?: { addMissingRoleRecommendations?: boolean },
): Promise<ModelMigrationSummary> {
  if (!fs.existsSync(filePath)) {
    return emptyMigrationSummary();
  }
  if (dryRun) {
    const current = await readModelIndexLayer(filePath);
    if (!current) return emptyMigrationSummary();
    return migrateModelIndexOverlay(current, options).summary;
  }
  return withFileLock(filePath, async () => {
    const current = await readModelIndexLayer(filePath);
    if (!current) return emptyMigrationSummary();
    const { next, summary } = migrateModelIndexOverlay(current, options);
    if (summary.changed) {
      await writeJsonAtomic(filePath, next);
    }
    return summary;
  });
}

function formatUpgradeText(res: UpgradeCommandResult): string {
  const prefix = res.dryRun ? "[DRY-RUN] " : "";
  const lines: string[] = [
    `${prefix}Agent Studio Upgrade — ${res.projectRoot ?? "global"} (${res.ok ? "PASS" : "ISSUES FOUND"})`,
  ];

  if (res.projectRoot) {
    lines.push(
      `  Bootstrap:   ${res.firstTimeBootstrap ? "first-time provenance initialized" : "incremental (.upgrade-state.json)"}`,
      `  Canonical:   +${res.addedFiles.length} added, ${res.fastForwardedFiles.length} fast-forwarded, ${res.preservedCustomizedFiles.length} customized preserved, ${res.forcedFiles.length} forced, ${res.unchangedFiles.length} unchanged`,
    );
    if (res.preservedDeletedFiles.length > 0) {
      lines.push(
        `  Deleted:     ${res.preservedDeletedFiles.length} user-deleted built-in file(s) preserved`,
      );
    }
    if (res.incomingWritten.length > 0) {
      lines.push(`  Incoming:    ${res.incomingWritten.join(", ")}`);
    }
    if (res.teamYamlUpdated) {
      lines.push(`  team.yaml:   ${res.teamYamlChanges.join("; ")}`);
    }
    if (res.workspaceModelIndex.changed) {
      lines.push(
        `  Model Index: ${res.workspaceModelIndex.rewrittenIds.length} legacy ID(s) migrated, ${res.workspaceModelIndex.addedCatalogIds.length} catalog entry(ies) added`,
      );
    }
  }

  if (res.globalModelIndex?.changed) {
    lines.push(
      `  Global Index: ${res.globalModelIndex.rewrittenIds.length} legacy ID(s) migrated, ${res.globalModelIndex.addedCatalogIds.length} catalog entry(ies) added`,
    );
  }
  if (res.globalResult) {
    lines.push(
      `  Global IDE:  ${res.globalResult.installedFiles.length} installed ($COPILOT_HOME=${res.globalResult.copilotHomeDir}), ${res.globalResult.cleanedLegacy.length} legacy cleaned`,
    );
  }

  if (res.compileResult) {
    lines.push(
      `  Compile:     ${res.compileResult.written.length} written, ${res.compileResult.merged.length} merged, ${res.compileResult.unchanged.length} unchanged, ${res.compileResult.cleanedLegacy.length} legacy cleaned, ${res.compileResult.skippedModified.length} skipped (modified)`,
    );
    for (const warn of res.compileResult.warnings) {
      lines.push(`  Warning:     ${warn}`);
    }
  } else if (res.dryRunDrift) {
    lines.push(
      `  Compile Plan: ${res.dryRunDrift.ok ? "in sync" : `${res.dryRunDrift.entries.length} file(s) would update`}`,
    );
  }

  if (res.doctorReport) {
    lines.push(
      `  Doctor:      ${res.doctorReport.ok ? "PASS" : "ISSUES FOUND"} (${res.doctorReport.migrationWarnings.length} migration warning(s))`,
    );
  }

  for (const d of res.diffs) {
    lines.push("", d.diff.trimEnd());
  }

  return lines.join("\n") + "\n";
}

export async function runUpgrade(args: string[]): Promise<UpgradeCommandResult> {
  const parsed = parseUpgradeArgs(args);
  const candidateRoot = resolveProjectRootArg(parsed.projectRef);
  const teamYamlExists = fs.existsSync(getTeamYamlPath(candidateRoot));
  const standaloneGlobal =
    parsed.global && !parsed.hasExplicitProject && !teamYamlExists;

  if (!standaloneGlobal && !teamYamlExists) {
    throw new Error(
      `Missing canonical team manifest: ${getTeamYamlPath(candidateRoot)}. Run "agent-studio init" first.`,
    );
  }

  const agentStudioVersion = resolveAgentStudioVersion();
  const addedFiles: string[] = [];
  const fastForwardedFiles: string[] = [];
  const unchangedFiles: string[] = [];
  const preservedCustomizedFiles: string[] = [];
  const preservedDeletedFiles: string[] = [];
  const forcedFiles: string[] = [];
  const incomingWritten: string[] = [];
  const diffs: UpgradeDiffEntry[] = [];

  let firstTimeBootstrap = false;
  let teamYamlUpdated = false;
  let teamYamlChanges: string[] = [];
  let workspaceModelIndex = emptyMigrationSummary();
  let globalModelIndex: ModelMigrationSummary | undefined;
  let upgradeStateUpdated = false;
  let globalResult: GlobalInstallResult | undefined;
  let compileResult: CompileResult | undefined;
  let dryRunDrift: DriftReport | undefined;
  let doctorReport: DoctorReport | undefined;
  let activeManifest: TeamManifest | null = null;

  if (!standaloneGlobal) {
    const projectRoot = candidateRoot;
    const upgradeStatePath = getUpgradeStatePath(projectRoot);
    const agentTeamDir = assertContainedPath(
      projectRoot,
      ".agent-team",
      ".agent-team directory",
    );

    const runWorkspaceCriticalSection = async (): Promise<TeamManifest> => {
      let manifest = loadTeamManifest(projectRoot);
      const detected = detectRepoStack(projectRoot);
      const prevState = await readUpgradeState(projectRoot);
      firstTimeBootstrap = prevState === null;

      const stockFiles = buildStockMarkdownMap(manifest, detected);
      const nextStateFiles: Record<string, ManagedFileRecord> = {};
      const skillsToRegister: string[] = [];

      // Retain records for any previously tracked files not in current stock
      if (prevState) {
        for (const [key, rec] of Object.entries(prevState.files)) {
          if (!stockFiles.has(key)) {
            assertContainedPath(agentTeamDir, key, "upgrade state entry");
            nextStateFiles[key] = rec;
          }
        }
      }

      for (const [relKey, stockContent] of stockFiles.entries()) {
        const absPath = assertContainedPath(
          agentTeamDir,
          relKey,
          "upgrade target",
        );
        const stockNextHash = sha256Hex(stockContent);
        const exists = fs.existsSync(absPath);
        const prev = prevState?.files?.[relKey];
        const isSkill =
          relKey.startsWith("skills/") && relKey.endsWith("/SKILL.md");

        if (!exists) {
          if (!prev || parsed.force) {
            if (!parsed.dryRun) {
              fs.mkdirSync(path.dirname(absPath), { recursive: true });
              fs.writeFileSync(absPath, stockContent, "utf8");
            }
            if (isSkill) {
              skillsToRegister.push(relKey.slice(0, -"/SKILL.md".length));
            }
            addedFiles.push(relKey);
            nextStateFiles[relKey] = {
              stockHash: stockNextHash,
              customized: false,
              templateVersion: agentStudioVersion,
            };
          } else {
            preservedDeletedFiles.push(relKey);
            nextStateFiles[relKey] = {
              ...prev,
              stockHash: stockNextHash,
              templateVersion: agentStudioVersion,
            };
          }
          continue;
        }

        const localRaw = fs.readFileSync(absPath, "utf8");
        const localHash = sha256Hex(localRaw);
        const archCustomized = isArchReviewCustomized(relKey, localRaw);

        if (localHash === stockNextHash) {
          unchangedFiles.push(relKey);
          nextStateFiles[relKey] = {
            stockHash: stockNextHash,
            customized: false,
            templateVersion: agentStudioVersion,
          };
          continue;
        }

        const isTrackedUnmodified =
          Boolean(prev) &&
          !prev!.customized &&
          !archCustomized &&
          localHash === prev!.stockHash;

        if (isTrackedUnmodified) {
          if (!parsed.dryRun) {
            fs.writeFileSync(absPath, stockContent, "utf8");
          }
          fastForwardedFiles.push(relKey);
          nextStateFiles[relKey] = {
            stockHash: stockNextHash,
            customized: false,
            templateVersion: agentStudioVersion,
          };
          continue;
        }

        // First-time bootstrap mismatch OR user-modified tracked file
        if (parsed.force) {
          if (!parsed.dryRun) {
            fs.writeFileSync(absPath, stockContent, "utf8");
          }
          forcedFiles.push(relKey);
          nextStateFiles[relKey] = {
            stockHash: stockNextHash,
            customized: false,
            templateVersion: agentStudioVersion,
          };
        } else {
          preservedCustomizedFiles.push(relKey);
          nextStateFiles[relKey] = {
            stockHash: stockNextHash,
            customized: true,
            localHash,
            templateVersion: agentStudioVersion,
          };
          if (parsed.diff) {
            const diffText = createUnifiedDiff(relKey, localRaw, stockContent);
            if (diffText) {
              diffs.push({ path: relKey, diff: diffText });
            }
          }
          if (parsed.writeIncoming && !parsed.dryRun) {
            const incomingPath = assertContainedPath(
              agentTeamDir,
              `${relKey}.incoming`,
              "incoming template",
            );
            fs.writeFileSync(incomingPath, stockContent, "utf8");
            incomingWritten.push(`.agent-team/${relKey}.incoming`);
          }
        }
      }

      // Key-scoped merge of .agent-team/team.yaml
      const teamYamlPath = assertContainedPath(
        agentTeamDir,
        "team.yaml",
        "team.yaml",
      );
      if (parsed.dryRun) {
        const simulated = applyTeamYamlUpgrades(manifest, skillsToRegister);
        teamYamlUpdated = simulated.changed;
        teamYamlChanges = simulated.changes;
        manifest = simulated.next;
      } else {
        const teamRes = await withFileLock(teamYamlPath, async () => {
          const raw = fs.readFileSync(teamYamlPath, "utf8");
          const current = parseTeamYaml(raw);
          const applied = applyTeamYamlUpgrades(current, skillsToRegister);
          if (applied.changed) {
            await writeTeamYamlAtomic(teamYamlPath, applied.next);
          }
          return applied;
        });
        teamYamlUpdated = teamRes.changed;
        teamYamlChanges = teamRes.changes;
        manifest = teamRes.next;
      }

      // Non-destructive upgrade of .agent-team/model-index.json
      const wsModelIndexPath = assertContainedPath(
        agentTeamDir,
        "model-index.json",
        "model-index.json",
      );
      workspaceModelIndex = await migrateModelIndexFile(
        wsModelIndexPath,
        parsed.dryRun,
        { addMissingRoleRecommendations: true },
      );

      // Persist .agent-team/.upgrade-state.json deterministically
      const nextState: UpgradeState = sortUpgradeState({
        schemaVersion: 1,
        agentStudioVersion,
        files: nextStateFiles,
      });
      const nextStateJson = serializeUpgradeState(nextState);
      const existingStateJson = fs.existsSync(upgradeStatePath)
        ? normalizeLf(fs.readFileSync(upgradeStatePath, "utf8"))
        : null;

      if (existingStateJson !== normalizeLf(nextStateJson)) {
        upgradeStateUpdated = true;
        if (!parsed.dryRun) {
          await writeJsonAtomic(upgradeStatePath, nextState);
        }
      }

      return manifest;
    };

    const manifest = parsed.dryRun
      ? await runWorkspaceCriticalSection()
      : await withFileLock(upgradeStatePath, runWorkspaceCriticalSection);
    activeManifest = manifest;

    if (parsed.global || parsed.useGlobalIndex) {
      globalModelIndex = await migrateModelIndexFile(
        getGlobalModelIndexPath(),
        parsed.dryRun,
        { addMissingRoleRecommendations: false },
      );
      if (parsed.global && !parsed.dryRun) {
        globalResult = installGlobalSetupAgent({
          ides: parsed.ides ?? manifest.targets,
          harness: resolveCopilotHarness(manifest),
        });
      }
    }

    if (parsed.dryRun) {
      const planned = planCompiledFiles(projectRoot, {
        ides: parsed.ides,
        manifest,
        useGlobalIndex: parsed.useGlobalIndex,
      });
      dryRunDrift = computeDrift(projectRoot, planned.files);
    } else {
      compileResult = compileTeam(projectRoot, {
        ides: parsed.ides,
        useGlobalIndex: parsed.useGlobalIndex,
        force: parsed.force,
        cleanLegacy: true,
      });
    }

    doctorReport = buildDoctorReport(projectRoot);
  } else {
    // Standalone --global upgrade
    globalModelIndex = await migrateModelIndexFile(
      getGlobalModelIndexPath(),
      parsed.dryRun,
      { addMissingRoleRecommendations: false },
    );
    if (!parsed.dryRun) {
      globalResult = installGlobalSetupAgent({
        ides: parsed.ides ?? [...ALL_IDES],
        harness: "copilot",
      });
    }
  }

  const ok = standaloneGlobal
    ? true
    : parsed.dryRun
      ? true
      : Boolean(doctorReport?.ok);

  const result: UpgradeCommandResult = {
    ok,
    dryRun: parsed.dryRun,
    force: parsed.force,
    global: parsed.global,
    ...(standaloneGlobal ? {} : { projectRoot: candidateRoot }),
    firstTimeBootstrap,
    addedFiles,
    fastForwardedFiles,
    unchangedFiles,
    preservedCustomizedFiles,
    preservedDeletedFiles,
    forcedFiles,
    incomingWritten,
    diffs,
    teamYamlUpdated,
    teamYamlChanges,
    workspaceModelIndex,
    ...(globalModelIndex ? { globalModelIndex } : {}),
    upgradeStateUpdated,
    ...(globalResult ? { globalResult } : {}),
    ...(compileResult ? { compileResult } : {}),
    ...(dryRunDrift ? { dryRunDrift } : {}),
    ...(doctorReport ? { doctorReport } : {}),
  };

  if (!parsed.quiet) {
    if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(formatUpgradeText(result));
    }
  }

  if (!result.ok && !parsed.dryRun && activeManifest) {
    process.exitCode = 1;
  }

  return result;
}
