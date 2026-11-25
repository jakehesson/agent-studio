import {
  DEFAULT_MODEL_INDEX,
  DEFAULT_MODEL_INDEX_TIMESTAMP,
  ModelIndexSchema,
  type ModelCapabilityTag,
  type ModelIndex,
  type ModelTier,
  type ModelUpdatedBy,
} from "../schema/model-index.js";
import type { RoleType } from "../schema/team.js";

export { DEFAULT_MODEL_INDEX, DEFAULT_MODEL_INDEX_TIMESTAMP };

export function cloneDefaultModelIndex(): ModelIndex {
  return JSON.parse(JSON.stringify(DEFAULT_MODEL_INDEX)) as ModelIndex;
}

export function createDefaultModelIndex(opts?: {
  updatedAt?: string;
  updatedBy?: ModelUpdatedBy;
  notes?: string;
}): ModelIndex {
  const base = cloneDefaultModelIndex();
  if (opts?.updatedAt) {
    base.updatedAt = opts.updatedAt;
  }
  if (opts?.updatedBy) {
    base.updatedBy = opts.updatedBy;
  }
  if (opts?.notes !== undefined) {
    base.notes = opts.notes;
  }
  return ModelIndexSchema.parse(base);
}

export function createWorkspaceDefaultModelIndex(opts?: {
  updatedAt?: string;
  updatedBy?: ModelUpdatedBy;
}): ModelIndex {
  return createDefaultModelIndex({
    updatedAt: opts?.updatedAt ?? DEFAULT_MODEL_INDEX_TIMESTAMP,
    updatedBy: opts?.updatedBy ?? "built-in",
    notes:
      "Workspace Agent Studio model index (.agent-team/model-index.json). Agents and Web Studio may update tier bindings, role recommendations, and catalog metadata deterministically.",
  });
}

export function defaultTierForRoleType(
  roleType: RoleType,
  roleId?: string,
): ModelTier {
  if (roleType === "orchestrator" || roleType === "qa") {
    return "fast";
  }
  const lowId = (roleId ?? "").trim().toLowerCase();
  if (lowId === "architect" || lowId === "ux-designer") {
    return "reasoning";
  }
  return "balanced";
}

export function inferModelTier(
  id: string,
  family?: string,
  maxInputTokens?: number,
): ModelTier {
  const combined = `${id} ${family ?? ""}`.toLowerCase();

  // Reasoning signals (checked before "mini" so o3-mini/o4-mini stay reasoning)
  if (
    /\b(opus|thinking|reason|reasoner|argon|neon|pro)\b/.test(combined) ||
    /\bo[134](?:[-_ ]|$)/.test(combined)
  ) {
    return "reasoning";
  }

  // Fast / lightweight signals
  if (
    /\b(haiku|flash[-_ ]?lite|flash|mini|nano|lite|instant|small|hydrogen|fast)\b/.test(
      combined,
    ) ||
    /4o[-_ ]?mini|gpt[-_ ]?4\.1[-_ ]?mini|gpt[-_ ]?5[-_ ]?mini/.test(combined)
  ) {
    return "fast";
  }

  // Balanced signals
  if (/\b(sonnet|carbon|gpt[-_ ]?4\.1|gpt[-_ ]?4o|gpt[-_ ]?5|codex)\b/.test(combined)) {
    return "balanced";
  }

  if (typeof maxInputTokens === "number" && Number.isFinite(maxInputTokens)) {
    if (maxInputTokens <= 32_000) return "fast";
    if (maxInputTokens >= 400_000) return "reasoning";
  }

  return "balanced";
}

export function inferModelCapabilities(
  id: string,
  tier: ModelTier,
  family?: string,
  maxInputTokens?: number,
): ModelCapabilityTag[] {
  const combined = `${id} ${family ?? ""}`.toLowerCase();
  const caps = new Set<ModelCapabilityTag>();

  if (tier === "fast") {
    caps.add("fast");
    caps.add("search");
  }
  if (tier === "reasoning") {
    caps.add("reasoning");
    caps.add("orchestration");
  }
  if (
    tier === "balanced" ||
    /sonnet|opus|gpt|codex|gemini|claude/.test(combined)
  ) {
    caps.add("coding");
  }
  if (/gemini|claude[-_ ]?(?:sonnet|opus|haiku)?[-_ ]?[34]|gpt[-_ ]?4\.1|gpt[-_ ]?4o|gpt[-_ ]?5/.test(combined)) {
    caps.add("multimodal");
  }
  if (typeof maxInputTokens === "number" && maxInputTokens >= 400_000) {
    caps.add("long-context");
  }

  return [...caps];
}
