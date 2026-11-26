import {
  DEFAULT_MODEL_INDEX,
  DEFAULT_MODEL_INDEX_TIMESTAMP,
  ModelIndexSchema,
  type ModelCapabilityTag,
  type ModelCatalogEntry,
  type ModelIndex,
  type ModelTier,
  type ModelUpdatedBy,
  type SelectionPriorityMetric,
} from "../schema/model-index.js";
import type { RoleType } from "../schema/team.js";

export { DEFAULT_MODEL_INDEX, DEFAULT_MODEL_INDEX_TIMESTAMP };

/**
 * Deterministic compile-time / migration alias table mapping all 16 built-in
 * legacy `"<Label> (copilot)"` picker IDs to Copilot runtime model IDs.
 * Unknown custom / enterprise BYOK model IDs are intentionally excluded and
 * preserved untouched.
 */
export const LEGACY_COPILOT_MODEL_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    "Claude Opus 4.6 (copilot)": "claude-opus-4.6",
    "GPT-5.4 (copilot)": "gpt-5.4",
    "Claude Opus 4.5 (copilot)": "claude-opus-4.5",
    "Gemini 3.1 Pro (copilot)": "gemini-3.1-pro",
    "Claude Sonnet 4.6 (copilot)": "claude-sonnet-4.6",
    "Mai Code 2 (copilot)": "mai-code-2",
    "Claude Sonnet 4.5 (copilot)": "claude-sonnet-4.5",
    "Gemini 3 Flash (copilot)": "gemini-3-flash",
    "Mai Code 2 Flash (copilot)": "mai-code-2-flash",
    "GPT-5 mini (copilot)": "gpt-5-mini",
    "GPT-4.1 (copilot)": "gpt-4.1",
    "Claude Haiku 4.5 (copilot)": "claude-haiku-4.5",
    "GPT-4o mini (copilot)": "gpt-4o-mini",
    "Claude Sonnet 4 (copilot)": "claude-sonnet-4",
    "Gemini 2.5 Pro (copilot)": "gemini-2.5-pro",
    "Claude Opus 4.1 (copilot)": "claude-opus-4.1",
  });

const LEGACY_COPILOT_ALIAS_LOWER_MAP = new Map<string, string>(
  Object.entries(LEGACY_COPILOT_MODEL_ALIASES).map(([legacy, runtime]) => [
    legacy.replace(/\s+/g, " ").trim().toLowerCase(),
    runtime,
  ]),
);

/**
 * Normalizes known built-in legacy `"<Label> (copilot)"` picker IDs to
 * Copilot runtime model IDs while preserving custom / BYOK IDs untouched.
 */
export function normalizeLegacyCopilotModelId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return id;
  const direct = LEGACY_COPILOT_MODEL_ALIASES[trimmed];
  if (direct) return direct;
  const folded = trimmed.replace(/\s+/g, " ").toLowerCase();
  return LEGACY_COPILOT_ALIAS_LOWER_MAP.get(folded) ?? trimmed;
}

export const normalizeCopilotModelId = normalizeLegacyCopilotModelId;

export function isLegacyCopilotPickerId(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed) return false;
  const folded = trimmed.replace(/\s+/g, " ").toLowerCase();
  return (
    LEGACY_COPILOT_ALIAS_LOWER_MAP.has(folded) || /\(copilot\)$/i.test(trimmed)
  );
}

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
    return "balanced";
  }
  const lowId = (roleId ?? "").trim().toLowerCase();
  if (
    lowId === "architect" ||
    lowId === "ux-designer" ||
    lowId === "code-reviewer" ||
    (roleType as string).trim().toLowerCase() === "review"
  ) {
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
    /\bo[134](?:[-_ ]|$)/.test(combined) ||
    /gpt[-_ ]?5\.4/.test(combined)
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
  if (
    /\b(sonnet|carbon|gpt[-_ ]?4\.1|gpt[-_ ]?4o|gpt[-_ ]?5|codex|mai)\b/.test(
      combined,
    ) ||
    /^mai[-_]/.test(combined)
  ) {
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

const SOURCE_PRIORITY: Record<string, number> = {
  user: 4,
  agent: 3,
  "vscode-lm": 2,
  "built-in": 1,
};

export function accuracyScore(entry: ModelCatalogEntry): number {
  if (typeof entry.accuracyRank === "number" && Number.isFinite(entry.accuracyRank)) {
    return entry.accuracyRank;
  }
  const combined = `${entry.id} ${entry.family ?? ""} ${entry.label}`.toLowerCase();
  if (/claude[-_ ]?opus[-_ ]?4[.-]6|\bopus[-_ ]?4[.-]6\b/.test(combined)) return 100;
  if (/gpt[-_ ]?5[.-]4/.test(combined)) return 96;
  if (/claude[-_ ]?opus[-_ ]?4[.-]5|\bopus[-_ ]?4[.-]5\b/.test(combined)) return 93;
  if (/gemini[-_ ]?3[.-]1[-_ ]?pro|gemini[-_ ]?4[-_ ]?(?:neon|argon)/.test(combined)) return 90;
  if (/claude[-_ ]?sonnet[-_ ]?4[.-]6|\bsonnet[-_ ]?4[.-]6\b/.test(combined)) return 88;
  if (/\bmai[-_ ]?code[-_ ]?2\b(?!.*flash)/.test(combined)) return 85;
  if (/claude[-_ ]?sonnet[-_ ]?4[.-]5|\bsonnet[-_ ]?4[.-]5\b/.test(combined)) return 82;
  if (/gpt[-_ ]?5[.-]3[-_ ]?codex|gpt[-_ ]?5(?!.*mini)/.test(combined)) return 80;
  if (/gemini[-_ ]?3[-_ ]?pro|gemini[-_ ]?3[.-]8/.test(combined)) return 79;
  if (/gemini[-_ ]?3[-_ ]?flash/.test(combined)) return 78;
  if (/\bmai[-_ ]?code[-_ ]?2[-_ ]?flash\b|\bmai[-_ ]?code[-_ ]?2\b/.test(combined)) return 76;
  if (/gemini[-_ ]?2[.-]5[-_ ]?pro/.test(combined)) return 75;
  if (/gpt[-_ ]?5[-_ ]?mini/.test(combined)) return 72;
  if (/claude[-_ ]?opus[-_ ]?4[.-]1/.test(combined)) return 72;
  if (/gpt[-_ ]?4[.-]1/.test(combined)) return 70;
  if (/claude[-_ ]?sonnet[-_ ]?4\b/.test(combined)) return 68;
  if (/gemini[-_ ]?4[-_ ]?carbon|\bpro\b/.test(combined)) return 66;
  if (/\bopus\b/.test(combined)) return 90;
  if (/\bsonnet\b/.test(combined)) return 80;
  if (/\bflash\b/.test(combined)) return 60;
  if (/claude[-_ ]?haiku[-_ ]?4[.-]5|\bhaiku\b/.test(combined)) return 45;
  if (/gpt[-_ ]?4o[-_ ]?mini/.test(combined)) return 35;
  if (/gpt[-_ ]?4o\b/.test(combined)) return 55;
  if (entry.tier === "reasoning") return 75;
  if (entry.tier === "balanced") return 65;
  return 50;
}

export function defaultCostMultiplier(entry: ModelCatalogEntry): number {
  if (typeof entry.premiumMultiplier === "number" && Number.isFinite(entry.premiumMultiplier)) {
    return entry.premiumMultiplier;
  }
  const combined = `${entry.id} ${entry.family ?? ""}`.toLowerCase();
  if (/opus[-_ ]?4\.1/.test(combined)) return 10;
  if (/opus/.test(combined)) return 3;
  if (/sonnet|gemini[-_ ]?(?:2\.5|3\.1)[-_ ]?pro|gpt[-_ ]?5\.4|gpt[-_ ]?5\b/.test(combined)) return 1;
  if (/haiku|flash|mai/.test(combined)) return 0.33;
  if (/mini|gpt[-_ ]?4\.1/.test(combined)) return 0;
  return entry.tier === "reasoning" ? 2 : entry.tier === "balanced" ? 1 : 0.33;
}

export function speedScore(entry: ModelCatalogEntry): number {
  if (typeof entry.speedRank === "number" && Number.isFinite(entry.speedRank)) {
    return entry.speedRank;
  }
  if (entry.capabilities.includes("fast") || entry.tier === "fast") {
    return 85;
  }
  if (entry.tier === "balanced") {
    return 65;
  }
  return 45;
}

/**
 * Deterministic Accuracy -> Cost -> Speed comparator for tier model candidates.
 */
export function rankCatalogModelsForTier(
  entries: readonly ModelCatalogEntry[],
  tier: ModelTier,
  selectionPriority: readonly SelectionPriorityMetric[] = [
    "accuracy",
    "cost",
    "speed",
  ],
): ModelCatalogEntry[] {
  const available = entries.filter((e) => e.available !== false);
  const pool = available.length > 0 ? [...available] : [...entries];

  const priorityOrder =
    selectionPriority.length > 0
      ? selectionPriority
      : (["accuracy", "cost", "speed"] as const);

  return pool.sort((a, b) => {
    const depDiff = Number(Boolean(a.deprecated)) - Number(Boolean(b.deprecated));
    if (depDiff !== 0) return depDiff;

    const exactTierDiff = Number(b.tier === tier) - Number(a.tier === tier);
    if (exactTierDiff !== 0) return exactTierDiff;

    for (const metric of priorityOrder) {
      if (metric === "accuracy") {
        const diff = accuracyScore(b) - accuracyScore(a);
        if (diff !== 0) return diff;
      } else if (metric === "cost") {
        const diff = defaultCostMultiplier(a) - defaultCostMultiplier(b);
        if (diff !== 0) return diff;
      } else if (metric === "speed") {
        const diff = speedScore(b) - speedScore(a);
        if (diff !== 0) return diff;
      }
    }

    const srcDiff =
      (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0);
    if (srcDiff !== 0) return srcDiff;

    return a.id.localeCompare(b.id);
  });
}
