import fs from "node:fs";
import path from "node:path";
import {
  getAntigravityPluginRelDir,
} from "../../compiler/antigravity.js";
import { CLAUDE_HOOK_EVENTS } from "../../compiler/claude-code.js";
import {
  COPILOT_HOOK_EVENTS_CANONICAL,
  LEGACY_COPILOT_HOOK_EVENTS,
} from "../../compiler/copilot-vscode.js";
import {
  resolveCopilotHomeDir,
  resolveEffectiveHomeDir,
  resolveVsCodeUserDir,
} from "../../compiler/global-install.js";
import {
  checkTeamDrift,
  loadTeamManifest,
  planCompiledFiles,
} from "../../compiler/index.js";
import {
  HOOK_TAG_NEEDLE,
  isManagedHookEntry,
  type DriftReport,
} from "../../compiler/merge.js";
import { resolveProject } from "../../board/registry.js";
import { isLegacyCopilotPickerId } from "../../models/defaults.js";
import { resolveRoleModel } from "../../models/resolve.js";
import {
  getGlobalModelIndexPath,
  getWorkspaceModelIndexPath,
  inspectModelIndexLayerSync,
  mergeModelIndexLayers,
} from "../../models/store.js";
import type {
  ModelIndexOverlay,
  ModelRoutingPolicy,
} from "../../schema/model-index.js";
import {
  resolveCopilotHarness,
  type CopilotHarness,
  type IdeModelOverride,
  type IdeTarget,
  type TeamManifest,
} from "../../schema/team.js";

const ALL_IDES: IdeTarget[] = ["antigravity", "claude-code", "copilot-vscode"];

export interface NodeVersionCheck {
  current: string;
  required: string;
  ok: boolean;
}

export interface IdePresenceInfo {
  ide: IdeTarget;
  installed: boolean;
  detectedPaths: string[];
  telemetryDir: string;
  telemetryDirExists: boolean;
}

export interface AdapterHealthInfo {
  ide: IdeTarget;
  enabled: boolean;
  ok: boolean;
  fileCount: number;
  driftCount: number;
}

export interface McpConfigCheck {
  path: string;
  enabled: boolean;
  present: boolean;
  configured: boolean;
  ok: boolean;
}

export interface McpStatusReport {
  ok: boolean;
  configs: Record<IdeTarget, McpConfigCheck>;
}

export interface HookConfigCheck {
  path: string;
  enabled: boolean;
  present: boolean;
  configured: boolean;
  events: string[];
  missingEvents: string[];
  ok: boolean;
}

export interface HooksStatusReport {
  ok: boolean;
  configs: Record<"claude-code" | "copilot-vscode", HookConfigCheck>;
}

export interface ModelIndexHealthInfo {
  valid: boolean;
  policy: ModelRoutingPolicy;
  layers: {
    globalPath: string;
    globalExists: boolean;
    workspacePath: string;
    workspaceExists: boolean;
  };
  warnings: string[];
  errors: string[];
}

export interface ArchitectureReviewHealthInfo {
  codeReviewerDefined: boolean;
  codeReviewSkillPresent: boolean;
  architectureSkillPresent: boolean;
  customized: boolean;
}

export interface DoctorMigrationWarning {
  id?: string;
  ide?: IdeTarget | string;
  severity?: "warn" | "info" | "error";
  path?: string;
  title?: string;
  message: string;
  fixHint?: string;
}

export interface DoctorReport {
  ok: boolean;
  projectId: string | null;
  projectRoot: string;
  manifestValid: boolean;
  manifestError?: string;
  nodeVersion: NodeVersionCheck;
  ides: Record<IdeTarget, IdePresenceInfo>;
  adapters: Record<IdeTarget, AdapterHealthInfo>;
  drift: DriftReport;
  mcpStatus: McpStatusReport;
  hooksStatus: HooksStatusReport;
  modelIndex: ModelIndexHealthInfo;
  architectureReview: ArchitectureReviewHealthInfo;
  migrationWarnings: DoctorMigrationWarning[];
  telemetryFallbackPath: string;
  telemetryFallbackExists: boolean;
}

function checkNodeVersion(): NodeVersionCheck {
  const current = process.versions.node;
  const major = Number.parseInt(current.split(".")[0] ?? "0", 10);
  return {
    current,
    required: ">=20.0.0",
    ok: Number.isFinite(major) && major >= 20,
  };
}

function getTelemetryPaths(homeDir: string, isOverridden: boolean): Record<IdeTarget, string> {
  const agyBrain =
    process.env.ANTIGRAVITY_BRAIN_DIR?.trim() ||
    path.join(homeDir, ".gemini", "antigravity", "brain");
  const claudeProjects =
    process.env.CLAUDE_PROJECTS_DIR?.trim() ||
    path.join(homeDir, ".claude", "projects");
  const vscodeUserDir = resolveVsCodeUserDir(homeDir, isOverridden);
  const vscodeStorage =
    process.env.VSCODE_STORAGE_DIR?.trim() ||
    path.join(vscodeUserDir, "workspaceStorage");

  return {
    antigravity: path.resolve(agyBrain),
    "claude-code": path.resolve(claudeProjects),
    "copilot-vscode": path.resolve(vscodeStorage),
  };
}

export function detectInstalledIdes(options?: {
  homeDir?: string;
}): Record<IdeTarget, IdePresenceInfo> {
  const { homeDir, isOverridden } = resolveEffectiveHomeDir(options?.homeDir);
  const telemetryPaths = getTelemetryPaths(homeDir, isOverridden);
  const vscodeUserDir = resolveVsCodeUserDir(homeDir, isOverridden);
  const copilotHomeDir = resolveCopilotHomeDir(homeDir);

  const agyCandidates = [
    path.join(homeDir, ".gemini", "antigravity"),
    path.join(homeDir, ".gemini", "config", "plugins"),
    telemetryPaths.antigravity,
  ];
  const agyDetected = agyCandidates.filter((p) => fs.existsSync(p));

  const claudeCandidates = [
    path.join(homeDir, ".claude"),
    telemetryPaths["claude-code"],
  ];
  const claudeDetected = claudeCandidates.filter((p) => fs.existsSync(p));

  const vscodeCandidates = [
    copilotHomeDir,
    vscodeUserDir,
    telemetryPaths["copilot-vscode"],
  ];
  const vscodeDetected = vscodeCandidates.filter((p) => fs.existsSync(p));

  return {
    antigravity: {
      ide: "antigravity",
      installed: agyDetected.length > 0,
      detectedPaths: agyDetected,
      telemetryDir: telemetryPaths.antigravity,
      telemetryDirExists: fs.existsSync(telemetryPaths.antigravity),
    },
    "claude-code": {
      ide: "claude-code",
      installed: claudeDetected.length > 0,
      detectedPaths: claudeDetected,
      telemetryDir: telemetryPaths["claude-code"],
      telemetryDirExists: fs.existsSync(telemetryPaths["claude-code"]),
    },
    "copilot-vscode": {
      ide: "copilot-vscode",
      installed: vscodeDetected.length > 0,
      detectedPaths: vscodeDetected,
      telemetryDir: telemetryPaths["copilot-vscode"],
      telemetryDirExists:
        fs.existsSync(telemetryPaths["copilot-vscode"]) ||
        fs.existsSync(path.join(copilotHomeDir, "session-state")),
    },
  };
}

function tryReadJsonObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasMcpEntry(
  filePath: string,
  containerKey: "mcpServers" | "servers",
): { present: boolean; configured: boolean } {
  if (!fs.existsSync(filePath)) {
    return { present: false, configured: false };
  }
  const obj = tryReadJsonObject(filePath);
  if (!obj) {
    return { present: true, configured: false };
  }
  const container = obj[containerKey];
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    return { present: true, configured: false };
  }
  const entry = (container as Record<string, unknown>)["agent-studio"];
  return {
    present: true,
    configured: Boolean(entry && typeof entry === "object"),
  };
}

function inspectClaudeHooks(filePath: string): {
  present: boolean;
  events: string[];
  missingEvents: string[];
} {
  if (!fs.existsSync(filePath)) {
    return {
      present: false,
      events: [],
      missingEvents: [...CLAUDE_HOOK_EVENTS],
    };
  }
  const obj = tryReadJsonObject(filePath);
  const hooksObj =
    obj && obj.hooks && typeof obj.hooks === "object" && !Array.isArray(obj.hooks)
      ? (obj.hooks as Record<string, unknown>)
      : {};

  const events: string[] = [];
  const missingEvents: string[] = [];

  for (const eventName of CLAUDE_HOOK_EVENTS) {
    const rawList = hooksObj[eventName];
    const hasStudioHook =
      Array.isArray(rawList) &&
      rawList.some((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const inner = (entry as { hooks?: unknown }).hooks;
        return (
          Array.isArray(inner) &&
          inner.some(
            (h) =>
              Boolean(h) &&
              typeof h === "object" &&
              typeof (h as { command?: unknown }).command === "string" &&
              ((h as { command: string }).command.includes(HOOK_TAG_NEEDLE)),
          )
        );
      });
    if (hasStudioHook) {
      events.push(eventName);
    } else {
      missingEvents.push(eventName);
    }
  }

  return { present: true, events, missingEvents };
}

function isCopilotStudioHookEntry(entry: unknown): boolean {
  if (isManagedHookEntry(entry)) return true;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const rec = entry as { command?: unknown; timeoutSec?: unknown; timeout?: unknown };
  const hasTimeout =
    typeof rec.timeoutSec === "number" || typeof rec.timeout === "number";
  return (
    hasTimeout &&
    typeof rec.command === "string" &&
    rec.command.includes(HOOK_TAG_NEEDLE)
  );
}

function inspectCopilotHooks(
  filePath: string,
  harness: CopilotHarness = "copilot",
): {
  present: boolean;
  events: string[];
  missingEvents: string[];
  legacyEventsFound: string[];
} {
  const expectedEvents =
    harness === "legacy-local"
      ? LEGACY_COPILOT_HOOK_EVENTS
      : COPILOT_HOOK_EVENTS_CANONICAL;

  if (!fs.existsSync(filePath)) {
    return {
      present: false,
      events: [],
      missingEvents: [...expectedEvents],
      legacyEventsFound: [],
    };
  }
  const obj = tryReadJsonObject(filePath);
  const hooksObj =
    obj && obj.hooks && typeof obj.hooks === "object" && !Array.isArray(obj.hooks)
      ? (obj.hooks as Record<string, unknown>)
      : {};

  const events: string[] = [];
  const missingEvents: string[] = [];

  for (const eventName of expectedEvents) {
    const rawList = hooksObj[eventName];
    const hasStudioHook =
      Array.isArray(rawList) &&
      rawList.some((entry) => isCopilotStudioHookEntry(entry));
    if (hasStudioHook) {
      events.push(eventName);
    } else {
      missingEvents.push(eventName);
    }
  }

  const legacyEventsFound: string[] = [];
  if (harness === "copilot") {
    for (const legacyEvent of LEGACY_COPILOT_HOOK_EVENTS) {
      const rawList = hooksObj[legacyEvent];
      if (
        Array.isArray(rawList) &&
        rawList.some((entry) => isCopilotStudioHookEntry(entry))
      ) {
        legacyEventsFound.push(legacyEvent);
      }
    }
  }

  return { present: true, events, missingEvents, legacyEventsFound };
}

function collectLegacyCopilotIdsFromLayer(
  layer: ModelIndexOverlay | null | undefined,
): string[] {
  const copilot = layer?.ides?.["copilot-vscode"];
  if (!copilot) return [];
  const found = new Set<string>();
  if (copilot.tiers) {
    for (const tier of ["fast", "balanced", "reasoning"] as const) {
      const binding = copilot.tiers[tier];
      if (!binding) continue;
      if (binding.primary && isLegacyCopilotPickerId(binding.primary)) {
        found.add(binding.primary);
      }
      for (const fb of binding.fallback ?? []) {
        if (isLegacyCopilotPickerId(fb)) {
          found.add(fb);
        }
      }
    }
  }
  for (const entry of copilot.catalog ?? []) {
    if (entry.id && isLegacyCopilotPickerId(entry.id)) {
      found.add(entry.id);
    }
  }
  return [...found];
}

function extractCopilotOverrideIds(override: IdeModelOverride | undefined): string[] {
  if (!override) return [];
  if (typeof override === "string") return [override];
  if (Array.isArray(override)) return override;
  const out: string[] = [];
  if (override.primary) out.push(override.primary);
  if (override.fallback) out.push(...override.fallback);
  return out;
}

export function buildDoctorReport(projectRoot: string): DoctorReport {
  const root = path.resolve(projectRoot);
  const nodeVersion = checkNodeVersion();
  const ides = detectInstalledIdes();

  let manifest: TeamManifest | null = null;
  let manifestValid = false;
  let manifestError: string | undefined;

  try {
    manifest = loadTeamManifest(root);
    manifestValid = true;
  } catch (err) {
    manifestError = err instanceof Error ? err.message : String(err);
  }

  const globalIndexPath = getGlobalModelIndexPath();
  const workspaceIndexPath = getWorkspaceModelIndexPath(root);
  const globalInspect = inspectModelIndexLayerSync(globalIndexPath);
  const workspaceInspect = inspectModelIndexLayerSync(workspaceIndexPath);

  const modelErrors: string[] = [];
  const modelWarnings: string[] = [];
  if (!globalInspect.valid) {
    modelErrors.push(
      `Invalid global model index (${globalIndexPath}): ${globalInspect.error ?? "parse error"}`,
    );
  }
  if (!workspaceInspect.valid) {
    modelErrors.push(
      `Invalid workspace model index (${workspaceIndexPath}): ${workspaceInspect.error ?? "parse error"}`,
    );
  }

  const deterministicModelIndex = mergeModelIndexLayers(
    null,
    workspaceInspect.valid ? workspaceInspect.data : null,
  );
  const runtimeModelIndex = mergeModelIndexLayers(
    globalInspect.valid ? globalInspect.data : null,
    workspaceInspect.valid ? workspaceInspect.data : null,
  );

  const enabledTargets = new Set<IdeTarget>(manifest?.targets ?? []);
  let drift: DriftReport = { ok: false, checkedCount: 0, entries: [] };
  const fileCountByIde: Record<IdeTarget, number> = {
    antigravity: 0,
    "claude-code": 0,
    "copilot-vscode": 0,
  };

  if (manifest) {
    const planned = planCompiledFiles(root, {
      manifest,
      modelIndex: deterministicModelIndex,
    });
    for (const file of planned.files) {
      const contributors =
        file.contributors && file.contributors.length > 0
          ? new Set(file.contributors)
          : [file.ide];
      for (const ide of contributors) {
        fileCountByIde[ide]++;
      }
    }
    drift = checkTeamDrift(root, {
      manifest,
      modelIndex: deterministicModelIndex,
    });
  }

  const policy: ModelRoutingPolicy =
    manifest?.workflow.modelRouting?.policy ?? "prefer-fallback";

  if (enabledTargets.has("copilot-vscode")) {
    const anyRequired =
      policy === "pinned" ||
      manifest?.workflow.modelRouting?.idePolicies?.["copilot-vscode"] ===
        "pinned" ||
      Boolean(
        manifest?.roster.some((role) => {
          const res = resolveRoleModel(
            manifest!,
            role,
            "copilot-vscode",
            runtimeModelIndex,
          );
          return !res.omit && res.copilotPolicy === "required";
        }),
      );
    if (anyRequired) {
      modelWarnings.push(
        "Copilot `model-policy: required` bypasses Copilot Fusion / Auto overrides.",
      );
    }

    if (ides["copilot-vscode"].installed) {
      const globalCopilot = globalInspect.data?.ides?.["copilot-vscode"];
      const liveEntries = (globalCopilot?.catalog ?? []).filter(
        (entry) => entry.source === "vscode-lm",
      );
      const lastSyncedMs = globalCopilot?.lastSyncedAt
        ? Date.parse(globalCopilot.lastSyncedAt)
        : Number.NaN;
      const staleSync =
        !Number.isFinite(lastSyncedMs) ||
        Date.now() - lastSyncedMs > 30 * 86_400_000;
      if (liveEntries.length === 0 || staleSync) {
        modelWarnings.push(
          "Run VS Code command 'Agent Studio: Refresh Live Model Index' to sync live Copilot models.",
        );
      }
    }

    if (manifest) {
      const copilotCatalogById = new Map(
        runtimeModelIndex.ides["copilot-vscode"].catalog.map((e) => [e.id, e]),
      );
      for (const role of manifest.roster) {
        const ids = extractCopilotOverrideIds(role.models?.["copilot-vscode"]);
        for (const modelId of ids) {
          const entry = copilotCatalogById.get(modelId);
          if (
            entry &&
            entry.source === "vscode-lm" &&
            entry.available === false
          ) {
            modelWarnings.push(
              `Role "${role.id}" references unavailable Copilot model "${modelId}" (vscode-lm live status: unavailable).`,
            );
          }
        }
      }
    }
  }

  const modelIndex: ModelIndexHealthInfo = {
    valid: modelErrors.length === 0,
    policy,
    layers: {
      globalPath: globalIndexPath,
      globalExists: globalInspect.exists,
      workspacePath: workspaceIndexPath,
      workspaceExists: workspaceInspect.exists,
    },
    warnings: modelWarnings,
    errors: modelErrors,
  };

  const adapters: Record<IdeTarget, AdapterHealthInfo> = {} as Record<
    IdeTarget,
    AdapterHealthInfo
  >;
  for (const ide of ALL_IDES) {
    const enabled = enabledTargets.has(ide);
    const driftCount = drift.entries.filter((e) => e.ide === ide).length;
    adapters[ide] = {
      ide,
      enabled,
      ok: !enabled || (manifestValid && driftCount === 0),
      fileCount: fileCountByIde[ide],
      driftCount,
    };
  }

  const projectId = manifest?.project.id ?? null;
  const agyMcpRel = projectId
    ? `${getAntigravityPluginRelDir(projectId)}/mcp_config.json`
    : ".agents/plugins/<project>-team/mcp_config.json";
  const agyMcp = projectId
    ? hasMcpEntry(path.join(root, agyMcpRel), "mcpServers")
    : { present: false, configured: false };
  const claudeMcp = hasMcpEntry(path.join(root, ".mcp.json"), "mcpServers");
  const vscodeMcp = hasMcpEntry(
    path.join(root, ".vscode", "mcp.json"),
    "servers",
  );

  const copilotHarness = resolveCopilotHarness(manifest);
  const copilotMcpPath =
    copilotHarness === "legacy-local" ? ".vscode/mcp.json" : ".mcp.json";
  const copilotMcp = copilotHarness === "legacy-local" ? vscodeMcp : claudeMcp;

  const mcpConfigs: Record<IdeTarget, McpConfigCheck> = {
    antigravity: {
      path: agyMcpRel,
      enabled: enabledTargets.has("antigravity"),
      present: agyMcp.present,
      configured: agyMcp.configured,
      ok: !enabledTargets.has("antigravity") || agyMcp.configured,
    },
    "claude-code": {
      path: ".mcp.json",
      enabled: enabledTargets.has("claude-code"),
      present: claudeMcp.present,
      configured: claudeMcp.configured,
      ok: !enabledTargets.has("claude-code") || claudeMcp.configured,
    },
    "copilot-vscode": {
      path: copilotMcpPath,
      enabled: enabledTargets.has("copilot-vscode"),
      present: copilotMcp.present,
      configured: copilotMcp.configured,
      ok: !enabledTargets.has("copilot-vscode") || copilotMcp.configured,
    },
  };
  const mcpStatus: McpStatusReport = {
    ok: Object.values(mcpConfigs).every((c) => c.ok),
    configs: mcpConfigs,
  };

  const claudeHooksInfo = inspectClaudeHooks(
    path.join(root, ".claude", "settings.json"),
  );
  const copilotHooksInfo = inspectCopilotHooks(
    path.join(root, ".github", "hooks", "agent-studio.json"),
    copilotHarness,
  );

  const hooksConfigs: Record<"claude-code" | "copilot-vscode", HookConfigCheck> =
    {
      "claude-code": {
        path: ".claude/settings.json",
        enabled: enabledTargets.has("claude-code"),
        present: claudeHooksInfo.present,
        configured: claudeHooksInfo.missingEvents.length === 0,
        events: claudeHooksInfo.events,
        missingEvents: claudeHooksInfo.missingEvents,
        ok:
          !enabledTargets.has("claude-code") ||
          claudeHooksInfo.missingEvents.length === 0,
      },
      "copilot-vscode": {
        path: ".github/hooks/agent-studio.json",
        enabled: enabledTargets.has("copilot-vscode"),
        present: copilotHooksInfo.present,
        configured: copilotHooksInfo.missingEvents.length === 0,
        events: copilotHooksInfo.events,
        missingEvents: copilotHooksInfo.missingEvents,
        ok:
          !enabledTargets.has("copilot-vscode") ||
          copilotHooksInfo.missingEvents.length === 0,
      },
    };
  const hooksStatus: HooksStatusReport = {
    ok: Object.values(hooksConfigs).every((c) => c.ok),
    configs: hooksConfigs,
  };

  const telemetryFallbackPath = path.join(root, ".agent-studio", "telemetry.jsonl");
  const telemetryFallbackExists = fs.existsSync(telemetryFallbackPath);

  const codeReviewerDefined = Boolean(
    manifest?.roster.some((r) => r.id === "code-reviewer"),
  );
  const codeReviewSkillPath = path.join(
    root,
    ".agent-team",
    "skills",
    "code-review",
    "SKILL.md",
  );
  const archSkillPath = path.join(
    root,
    ".agent-team",
    "skills",
    "architecture-review",
    "SKILL.md",
  );
  const codeReviewSkillPresent = fs.existsSync(codeReviewSkillPath);
  const architectureSkillPresent = fs.existsSync(archSkillPath);
  let architectureCustomized = false;
  if (architectureSkillPresent) {
    try {
      const archSkillContent = fs.readFileSync(archSkillPath, "utf8");
      architectureCustomized =
        !archSkillContent.includes("PENDING DEEP RESEARCH") &&
        !archSkillContent.includes("architecture-research: pending");
    } catch {
      architectureCustomized = false;
    }
  }
  const architectureReview: ArchitectureReviewHealthInfo = {
    codeReviewerDefined,
    codeReviewSkillPresent,
    architectureSkillPresent,
    customized: architectureCustomized,
  };

  const migrationWarnings: DoctorMigrationWarning[] = [];
  if (enabledTargets.has("copilot-vscode") && copilotHarness === "copilot") {
    if (vscodeMcp.configured) {
      migrationWarnings.push({
        id: "legacy-vscode-mcp",
        ide: "copilot-vscode",
        severity: "warn",
        path: ".vscode/mcp.json",
        title: "Stale .vscode/mcp.json entry",
        message:
          'Found legacy servers["agent-studio"] in .vscode/mcp.json; unified Copilot harness uses .mcp.json (mcpServers["agent-studio"]).',
        fixHint: "agent-studio upgrade",
      });
    }

    const legacyLearnPromptPath = path.join(
      root,
      ".github",
      "prompts",
      "learn.prompt.md",
    );
    if (fs.existsSync(legacyLearnPromptPath)) {
      migrationWarnings.push({
        id: "legacy-learn-prompt",
        ide: "copilot-vscode",
        severity: "warn",
        path: ".github/prompts/learn.prompt.md",
        title: "Legacy Copilot learn.prompt.md",
        message:
          "Legacy .github/prompts/learn.prompt.md is superseded by .github/skills/learn/SKILL.md in Copilot harness mode.",
        fixHint: "agent-studio upgrade",
      });
    }

    if (copilotHooksInfo.legacyEventsFound.length > 0) {
      migrationWarnings.push({
        id: "legacy-copilot-hooks",
        ide: "copilot-vscode",
        severity: "warn",
        path: ".github/hooks/agent-studio.json",
        title: "Legacy PascalCase Copilot hooks",
        message: `Found legacy PascalCase hook entries (${copilotHooksInfo.legacyEventsFound.join(", ")}) in .github/hooks/agent-studio.json; canonical Copilot harness uses camelCase events.`,
        fixHint: "agent-studio upgrade",
      });
    }

    const { homeDir, isOverridden } = resolveEffectiveHomeDir();
    const vscodeUserDir = resolveVsCodeUserDir(homeDir, isOverridden);
    const copilotHomeDir = resolveCopilotHomeDir(homeDir);
    const legacyGlobalNames = [
      "team-setup.agent.md",
      "team-setup.instructions.md",
      "learn.prompt.md",
    ];
    for (const legacyName of legacyGlobalNames) {
      const legacyGlobalPath = path.join(vscodeUserDir, "prompts", legacyName);
      if (fs.existsSync(legacyGlobalPath)) {
        migrationWarnings.push({
          id: `legacy-global-copilot-${legacyName}`,
          ide: "copilot-vscode",
          severity: "warn",
          path: legacyGlobalPath,
          title: `Legacy global VS Code prompts/${legacyName}`,
          message: `Found legacy global Copilot file (${legacyName}) in VSCodeUserDir prompts/; unified Copilot harness uses $COPILOT_HOME (${copilotHomeDir}).`,
          fixHint: "agent-studio upgrade --global",
        });
      }
    }
  }

  if (manifest) {
    const manifestLegacyIds = new Set<string>();
    for (const role of manifest.roster) {
      for (const id of extractCopilotOverrideIds(role.models?.["copilot-vscode"])) {
        if (isLegacyCopilotPickerId(id)) {
          manifestLegacyIds.add(id);
        }
      }
    }
    if (manifestLegacyIds.size > 0) {
      migrationWarnings.push({
        id: "legacy-copilot-models-team-yaml",
        ide: "copilot-vscode",
        severity: "warn",
        path: ".agent-team/team.yaml",
        title: 'Legacy "(copilot)" model IDs in team.yaml',
        message: `Found legacy "(copilot)" picker IDs in .agent-team/team.yaml: ${[...manifestLegacyIds].join(", ")}.`,
        fixHint: "agent-studio upgrade",
      });
    }
  }

  const wsLegacyIds = collectLegacyCopilotIdsFromLayer(workspaceInspect.data);
  if (wsLegacyIds.length > 0) {
    migrationWarnings.push({
      id: "legacy-copilot-models-workspace",
      ide: "copilot-vscode",
      severity: "warn",
      path: ".agent-team/model-index.json",
      title: 'Legacy "(copilot)" model IDs in workspace model index',
      message: `Found legacy "(copilot)" picker IDs in .agent-team/model-index.json: ${wsLegacyIds.join(", ")}.`,
      fixHint: "agent-studio upgrade",
    });
  }

  const globalLegacyIds = collectLegacyCopilotIdsFromLayer(globalInspect.data);
  if (globalLegacyIds.length > 0) {
    migrationWarnings.push({
      id: "legacy-copilot-models-global",
      ide: "copilot-vscode",
      severity: "warn",
      path: globalIndexPath,
      title: 'Legacy "(copilot)" model IDs in global model index',
      message: `Found legacy "(copilot)" picker IDs in ${globalIndexPath}: ${globalLegacyIds.join(", ")}.`,
      fixHint: "agent-studio upgrade --global",
    });
  }

  const emittedModifiedById = new Map<string, DoctorMigrationWarning>();
  for (const entry of drift.entries) {
    if (entry.status === "modified") {
      const warningId = `modified-compiled-${entry.path}`;
      const existing = emittedModifiedById.get(warningId);
      if (existing) {
        const existingIdes = new Set(
          String(existing.ide ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        if (!existingIdes.has(entry.ide)) {
          existingIdes.add(entry.ide);
          existing.ide = [...existingIdes].join(", ");
        }
        continue;
      }
      const warning: DoctorMigrationWarning = {
        id: warningId,
        ide: entry.ide,
        severity: "warn",
        path: entry.path,
        title: "Manually modified compiled file",
        message: `${entry.path} was manually modified and is skipped by safe sync/upgrade unless --force is passed.`,
        fixHint: "agent-studio sync --force",
      };
      emittedModifiedById.set(warningId, warning);
      migrationWarnings.push(warning);
    }
  }

  const ok =
    nodeVersion.ok &&
    manifestValid &&
    modelIndex.valid &&
    drift.ok &&
    mcpStatus.ok &&
    hooksStatus.ok;

  return {
    ok,
    projectId,
    projectRoot: root,
    manifestValid,
    ...(manifestError ? { manifestError } : {}),
    nodeVersion,
    ides,
    adapters,
    drift,
    mcpStatus,
    hooksStatus,
    modelIndex,
    architectureReview,
    migrationWarnings,
    telemetryFallbackPath,
    telemetryFallbackExists,
  };
}

function parseDoctorArgs(args: string[]): {
  projectRef?: string;
  json: boolean;
  quiet: boolean;
} {
  let projectRef: string | undefined;
  let json = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token) continue;
    if (token === "--json") {
      json = true;
    } else if (token === "--quiet") {
      quiet = true;
    } else if (token === "--project" && args[i + 1]) {
      projectRef = args[++i];
    } else if (token.startsWith("--project=")) {
      projectRef = token.slice("--project=".length);
    }
  }

  return { projectRef, json, quiet };
}

function resolveProjectRootArg(projectRef?: string): string {
  if (!projectRef) {
    return path.resolve(process.cwd());
  }
  const directPath = path.resolve(projectRef);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isDirectory()) {
    return directPath;
  }
  const resolved = resolveProject(projectRef);
  return resolved.root;
}

function formatDoctorText(report: DoctorReport): string {
  const archRev = report.architectureReview;
  const archRevStatus = !archRev.codeReviewerDefined
    ? "NOT CONFIGURED (no code-reviewer in roster)"
    : !archRev.codeReviewSkillPresent || !archRev.architectureSkillPresent
      ? "INCOMPLETE (missing review skill)"
      : archRev.customized
        ? "OK (customized)"
        : "PENDING DEEP RESEARCH (run team-setup)";

  const lines: string[] = [
    `Agent Studio Doctor — ${report.projectId ?? path.basename(report.projectRoot)} (${report.ok ? "PASS" : "ISSUES FOUND"})`,
    `  Root:         ${report.projectRoot}`,
    `  Node:         v${report.nodeVersion.current} (${report.nodeVersion.ok ? "OK" : `requires ${report.nodeVersion.required}`})`,
    `  Manifest:     ${report.manifestValid ? "valid (.agent-team/team.yaml)" : `INVALID (${report.manifestError ?? "missing"})`}`,
    `  Drift Check:  ${report.drift.ok ? `PASS (${report.drift.checkedCount} files in sync)` : `DRIFT (${report.drift.entries.length} issue(s))`}`,
    `  MCP Configs:  ${report.mcpStatus.ok ? "OK" : "MISSING/INCOMPLETE"}`,
    `  IDE Hooks:    ${report.hooksStatus.ok ? "OK" : "MISSING/INCOMPLETE"}`,
    `  Model Index:  ${report.modelIndex.valid ? `OK (policy=${report.modelIndex.policy})` : `INVALID (${report.modelIndex.errors.length} error(s))`}`,
    `  Code Review:  ${archRevStatus}`,
  ];

  for (const ide of ALL_IDES) {
    const presence = report.ides[ide];
    const adapter = report.adapters[ide];
    const mcp = report.mcpStatus.configs[ide];
    lines.push(
      `  [${ide}] installed=${presence.installed ? "yes" : "no"} enabled=${adapter.enabled ? "yes" : "no"} drift=${adapter.driftCount} mcp=${mcp.configured ? "ok" : "missing"}`,
    );
  }

  for (const err of report.modelIndex.errors) {
    lines.push(`  Model Index Error: ${err}`);
  }
  for (const warn of report.modelIndex.warnings) {
    lines.push(`  Model Index Warning: ${warn}`);
  }
  if (report.migrationWarnings.length > 0) {
    lines.push("  Migration Advisories:");
    for (const mw of report.migrationWarnings) {
      const fix = mw.fixHint ? ` (fix: ${mw.fixHint})` : "";
      lines.push(`    - [${mw.ide ?? "all"}] ${mw.message}${fix}`);
    }
  }

  if (!report.drift.ok) {
    lines.push("  Drift entries:");
    for (const entry of report.drift.entries) {
      lines.push(`    - [${entry.status}] ${entry.path}: ${entry.reason}`);
    }
  }

  return lines.join("\n") + "\n";
}

export async function runDoctor(args: string[]): Promise<DoctorReport> {
  const parsed = parseDoctorArgs(args);
  const projectRoot = resolveProjectRootArg(parsed.projectRef);
  const report = buildDoctorReport(projectRoot);

  if (!parsed.quiet) {
    if (parsed.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(formatDoctorText(report));
    }
  }

  if (!report.ok) {
    process.exitCode = 1;
  }

  return report;
}
