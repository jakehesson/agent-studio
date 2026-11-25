import {
  DEFAULT_MODEL_INDEX,
  type IdeTierBinding,
  type ModelIndex,
  type ModelRoutingPolicy,
  type ModelTier,
} from "../schema/model-index.js";
import type {
  IdeModelOverride,
  IdeTarget,
  RosterEntry,
  TeamManifest,
  WorkflowModelRouting,
} from "../schema/team.js";
import { defaultTierForRoleType } from "./defaults.js";

const ALL_IDES: IdeTarget[] = ["antigravity", "claude-code", "copilot-vscode"];

const PORTABLE_ENUM_OR_ALIAS_IDS = new Set([
  "inherit",
  "flash_lite",
  "flash",
  "pro",
  "haiku",
  "sonnet",
  "opus",
]);

export type ModelResolutionSource =
  | "role-override"
  | "ide-policy"
  | "workflow-policy"
  | "index-tier"
  | "built-in-default";

export interface ResolvedRoleModel {
  ide: IdeTarget;
  roleId: string;
  tier: ModelTier;
  policy: ModelRoutingPolicy;
  frontmatterModel?: string | string[];
  primaryModel: string;
  fallbackModels: string[];
  copilotPolicy?: "preferred" | "required";
  omit: boolean;
  source: ModelResolutionSource;
}

export interface WorkflowRoutingSummary {
  policy: ModelRoutingPolicy;
  respectBuiltInOrchestrators: boolean;
  allowSubagentModelHints: boolean;
  copilotHandoffModels: boolean;
  idePolicies: Partial<Record<IdeTarget, ModelRoutingPolicy>>;
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

interface NormalizedIdeOverride {
  kind: "string" | "array" | "object";
  primary?: string;
  fallback?: string[];
  omit?: boolean;
  copilotPolicy?: "preferred" | "required";
}

function normalizeOverride(
  raw: IdeModelOverride | undefined,
): NormalizedIdeOverride | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    return { kind: "string", primary: raw.trim(), fallback: [raw.trim()] };
  }
  if (Array.isArray(raw)) {
    const cleaned = dedupeStrings(raw);
    if (cleaned.length === 0) return null;
    return { kind: "array", primary: cleaned[0], fallback: cleaned };
  }
  return {
    kind: "object",
    primary: raw.primary?.trim(),
    fallback: raw.fallback ? dedupeStrings(raw.fallback) : undefined,
    omit: raw.omit,
    copilotPolicy: raw.copilotPolicy,
  };
}

function findConcreteCatalogModelForTier(
  modelIndex: ModelIndex,
  ide: IdeTarget,
  tier: ModelTier,
): string | undefined {
  const catalog = modelIndex.ides[ide].catalog;
  const candidates = catalog.filter(
    (entry) =>
      entry.tier === tier &&
      entry.available !== false &&
      !PORTABLE_ENUM_OR_ALIAS_IDS.has(entry.id),
  );
  if (candidates.length === 0) {
    return undefined;
  }
  // Prefer user / agent / live vscode-lm entries over built-in seed metadata
  const nonBuiltIn = candidates.find((c) => c.source !== "built-in");
  return (nonBuiltIn ?? candidates[0])?.id;
}

export function buildWorkflowRoutingSummary(
  manifest?: TeamManifest | null,
): WorkflowRoutingSummary {
  const mr: Partial<WorkflowModelRouting> = manifest?.workflow.modelRouting ?? {};
  return {
    policy: mr.policy ?? "prefer-fallback",
    respectBuiltInOrchestrators: mr.respectBuiltInOrchestrators ?? true,
    allowSubagentModelHints: mr.allowSubagentModelHints ?? true,
    copilotHandoffModels: mr.copilotHandoffModels ?? false,
    idePolicies: { ...(mr.idePolicies ?? {}) },
  };
}

export function resolveEffectivePolicy(
  manifest: TeamManifest,
  role: RosterEntry,
  ide: IdeTarget,
): { policy: ModelRoutingPolicy; source: "role-override" | "ide-policy" | "workflow-policy" | "built-in-default" } {
  if (role.modelPolicy) {
    return { policy: role.modelPolicy, source: "role-override" };
  }
  const idePol = manifest.workflow.modelRouting?.idePolicies?.[ide];
  if (idePol) {
    return { policy: idePol, source: "ide-policy" };
  }
  const wfPol = manifest.workflow.modelRouting?.policy;
  if (wfPol) {
    return { policy: wfPol, source: "workflow-policy" };
  }
  return { policy: "prefer-fallback", source: "built-in-default" };
}

export function resolveEffectiveTier(
  role: RosterEntry,
  modelIndex: ModelIndex,
): { tier: ModelTier; source: "role-override" | "index-tier" | "built-in-default" } {
  if (role.modelTier) {
    return { tier: role.modelTier, source: "role-override" };
  }
  const rec = modelIndex.roleRecommendations[role.id];
  if (rec?.tier) {
    return { tier: rec.tier, source: "index-tier" };
  }
  return {
    tier: defaultTierForRoleType(role.roleType, role.id),
    source: "built-in-default",
  };
}

export function resolveRoleModel(
  manifest: TeamManifest,
  role: RosterEntry,
  ide: IdeTarget,
  modelIndex: ModelIndex = DEFAULT_MODEL_INDEX,
): ResolvedRoleModel {
  const { tier, source: tierSource } = resolveEffectiveTier(role, modelIndex);
  const { policy, source: policySource } = resolveEffectivePolicy(
    manifest,
    role,
    ide,
  );
  const tierBinding: IdeTierBinding = modelIndex.ides[ide].tiers[tier];
  const override = normalizeOverride(role.models?.[ide]);

  const effectiveSource: ModelResolutionSource = override
    ? "role-override"
    : policySource !== "built-in-default"
      ? policySource
      : tierSource;

  // 1. Explicit { omit: true } on any policy omits frontmatter model
  if (override?.omit === true) {
    return {
      ide,
      roleId: role.id,
      tier,
      policy,
      primaryModel: "",
      fallbackModels: [],
      omit: true,
      source: "role-override",
    };
  }

  // 2. defer-to-host policy
  if (policy === "defer-to-host") {
    if (ide === "copilot-vscode") {
      return {
        ide,
        roleId: role.id,
        tier,
        policy,
        primaryModel: "",
        fallbackModels: [],
        omit: true,
        source: effectiveSource,
      };
    }
    return {
      ide,
      roleId: role.id,
      tier,
      policy,
      frontmatterModel: "inherit",
      primaryModel: "inherit",
      fallbackModels: ["inherit"],
      omit: false,
      source: effectiveSource,
    };
  }

  // 3. pinned policy
  if (policy === "pinned") {
    if (ide === "copilot-vscode") {
      const pinnedPrimary =
        override?.primary ?? override?.fallback?.[0] ?? tierBinding.primary;
      const copilotPolicy = override?.copilotPolicy ?? "required";
      return {
        ide,
        roleId: role.id,
        tier,
        policy,
        frontmatterModel: pinnedPrimary,
        primaryModel: pinnedPrimary,
        fallbackModels: [pinnedPrimary],
        copilotPolicy,
        omit: false,
        source: effectiveSource,
      };
    }

    const pinnedModel =
      override?.primary ??
      override?.fallback?.[0] ??
      findConcreteCatalogModelForTier(modelIndex, ide, tier) ??
      tierBinding.primary;
    return {
      ide,
      roleId: role.id,
      tier,
      policy,
      frontmatterModel: pinnedModel,
      primaryModel: pinnedModel,
      fallbackModels: [pinnedModel],
      omit: false,
      source: effectiveSource,
    };
  }

  // 4. prefer-fallback policy (default)
  if (ide === "copilot-vscode") {
    const copilotPolicy = override?.copilotPolicy ?? "preferred";
    if (override?.kind === "string" && override.primary) {
      return {
        ide,
        roleId: role.id,
        tier,
        policy,
        frontmatterModel: override.primary,
        primaryModel: override.primary,
        fallbackModels: [override.primary],
        copilotPolicy,
        omit: false,
        source: effectiveSource,
      };
    }
    const orderedList = override
      ? dedupeStrings([
          ...(override.primary ? [override.primary] : []),
          ...(override.fallback ?? []),
        ])
      : dedupeStrings([tierBinding.primary, ...tierBinding.fallback]);
    const finalArray =
      orderedList.length > 0 ? orderedList : [tierBinding.primary];
    return {
      ide,
      roleId: role.id,
      tier,
      policy,
      frontmatterModel: finalArray,
      primaryModel: finalArray[0] ?? tierBinding.primary,
      fallbackModels: finalArray,
      copilotPolicy,
      omit: false,
      source: effectiveSource,
    };
  }

  // Antigravity & Claude Code under prefer-fallback
  const resolvedPrimary =
    override?.primary ?? override?.fallback?.[0] ?? tierBinding.primary;
  const fallbackList = dedupeStrings([
    resolvedPrimary,
    ...(override?.fallback ?? tierBinding.fallback),
  ]);
  return {
    ide,
    roleId: role.id,
    tier,
    policy,
    frontmatterModel: resolvedPrimary,
    primaryModel: resolvedPrimary,
    fallbackModels: fallbackList,
    omit: false,
    source: effectiveSource,
  };
}

export function resolveManifestModels(
  manifest: TeamManifest,
  modelIndex: ModelIndex = DEFAULT_MODEL_INDEX,
  targets: IdeTarget[] = ALL_IDES,
): Map<string, Record<IdeTarget, ResolvedRoleModel>> {
  const byRole = new Map<string, Record<IdeTarget, ResolvedRoleModel>>();
  for (const role of manifest.roster) {
    const perIde = {} as Record<IdeTarget, ResolvedRoleModel>;
    for (const ide of targets) {
      perIde[ide] = resolveRoleModel(manifest, role, ide, modelIndex);
    }
    byRole.set(role.id, perIde);
  }
  return byRole;
}
