import {
  DEFAULT_MODEL_INDEX,
  type ModelCatalogEntry,
  type ModelIndex,
  type ModelTier,
} from "../schema/model-index.js";
import {
  defaultCostMultiplier,
  inferModelTier,
  normalizeLegacyCopilotModelId,
} from "./defaults.js";

export interface ModelPricing {
  tier: ModelTier;
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
  premiumMultiplier?: number;
}

export interface TokenCostInput {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

const TIER_DEFAULT_RATES: Record<
  ModelTier,
  Omit<ModelPricing, "tier" | "premiumMultiplier">
> = {
  fast: {
    inputPer1M: 0.4,
    outputPer1M: 1.6,
    cacheReadPer1M: 0.04,
    cacheWritePer1M: 0.4,
  },
  balanced: {
    inputPer1M: 2.5,
    outputPer1M: 10,
    cacheReadPer1M: 0.25,
    cacheWritePer1M: 2.5,
  },
  reasoning: {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25,
  },
};

function normalizeModelLookupKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^(?:copilot|anthropic|google|openai|xai)\//i, "")
    .replace(/\s*\(copilot\)\s*$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isModelIndex(
  catalog: readonly ModelCatalogEntry[] | ModelIndex | undefined,
): catalog is ModelIndex {
  return Boolean(
    catalog &&
      !Array.isArray(catalog) &&
      typeof catalog === "object" &&
      "ides" in catalog,
  );
}

function collectCatalogEntries(
  ide?: string,
  catalog?: readonly ModelCatalogEntry[] | ModelIndex,
): readonly ModelCatalogEntry[] {
  if (Array.isArray(catalog)) {
    return catalog;
  }
  const index = isModelIndex(catalog) ? catalog : DEFAULT_MODEL_INDEX;
  if (
    ide === "antigravity" ||
    ide === "claude-code" ||
    ide === "copilot-vscode"
  ) {
    return index.ides[ide].catalog;
  }
  return [
    ...index.ides["copilot-vscode"].catalog,
    ...index.ides["claude-code"].catalog,
    ...index.ides.antigravity.catalog,
  ];
}

function findCatalogEntry(
  model: string,
  ide?: string,
  catalog?: readonly ModelCatalogEntry[] | ModelIndex,
): ModelCatalogEntry | undefined {
  const normalized = normalizeLegacyCopilotModelId(model);
  const key = normalizeModelLookupKey(normalized);
  if (!key) return undefined;

  const entries = collectCatalogEntries(ide, catalog);
  for (const entry of entries) {
    if (normalizeModelLookupKey(entry.id) === key) {
      return entry;
    }
  }
  for (const entry of entries) {
    if (
      normalizeModelLookupKey(entry.label) === key ||
      (entry.family && normalizeModelLookupKey(entry.family) === key)
    ) {
      return entry;
    }
  }
  return undefined;
}

function matchModelFamilyRates(
  normalizedModel: string,
  tier: ModelTier,
): Omit<ModelPricing, "tier" | "premiumMultiplier"> {
  const m = normalizedModel
    .toLowerCase()
    .replace(/^(?:copilot|anthropic|google|openai|xai)\//i, "");

  // Anthropic Claude family
  if (/opus[-_ ]?4[.-][01](?:[^0-9]|$)|\bclaude[-_ ]?opus[-_ ]?4(?![.-]\d)/.test(m)) {
    return {
      inputPer1M: 15,
      outputPer1M: 75,
      cacheReadPer1M: 1.5,
      cacheWritePer1M: 18.75,
    };
  }
  if (/opus/.test(m)) {
    return {
      inputPer1M: 5,
      outputPer1M: 25,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
    };
  }
  if (/sonnet/.test(m)) {
    return {
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 0.3,
      cacheWritePer1M: 3.75,
    };
  }
  if (/haiku[-_ ]?3/.test(m)) {
    return {
      inputPer1M: 0.8,
      outputPer1M: 4,
      cacheReadPer1M: 0.08,
      cacheWritePer1M: 1,
    };
  }
  if (/haiku/.test(m)) {
    return {
      inputPer1M: 1,
      outputPer1M: 5,
      cacheReadPer1M: 0.1,
      cacheWritePer1M: 1.25,
    };
  }

  // Google Gemini family
  if (/flash[-_ ]?lite|hydrogen/.test(m)) {
    return {
      inputPer1M: 0.1,
      outputPer1M: 0.4,
      cacheReadPer1M: 0.01,
      cacheWritePer1M: 0.1,
    };
  }
  if (/gemini.*flash|\bflash\b|gemini[-_ ]?4[-_ ]?carbon/.test(m)) {
    return {
      inputPer1M: 0.3,
      outputPer1M: 2.5,
      cacheReadPer1M: 0.03,
      cacheWritePer1M: 0.3,
    };
  }
  if (/gemini.*pro|gemini[-_ ]?4[-_ ]?(?:argon|neon)|\bpro\b/.test(m)) {
    return {
      inputPer1M: 1.25,
      outputPer1M: 10,
      cacheReadPer1M: 0.125,
      cacheWritePer1M: 1.25,
    };
  }

  // OpenAI reasoning (o1 / o3 / o4-mini)
  if (/\bo[34][-_ ]?mini\b/.test(m)) {
    return {
      inputPer1M: 1.1,
      outputPer1M: 4.4,
      cacheReadPer1M: 0.275,
      cacheWritePer1M: 1.1,
    };
  }
  if (/\bo[13]\b/.test(m)) {
    return {
      inputPer1M: 2,
      outputPer1M: 8,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 2,
    };
  }

  // OpenAI GPT-5.x & GPT-4.x
  if (/gpt[-_ ]?5[-_ ]?(?:mini|nano)/.test(m)) {
    return {
      inputPer1M: 0.25,
      outputPer1M: 2,
      cacheReadPer1M: 0.025,
      cacheWritePer1M: 0.25,
    };
  }
  if (/gpt[-_ ]?5\.4/.test(m)) {
    return {
      inputPer1M: 2.5,
      outputPer1M: 15,
      cacheReadPer1M: 0.25,
      cacheWritePer1M: 2.5,
    };
  }
  if (/gpt[-_ ]?5/.test(m)) {
    return {
      inputPer1M: 1.25,
      outputPer1M: 10,
      cacheReadPer1M: 0.125,
      cacheWritePer1M: 1.25,
    };
  }
  if (/gpt[-_ ]?4o[-_ ]?mini/.test(m)) {
    return {
      inputPer1M: 0.15,
      outputPer1M: 0.6,
      cacheReadPer1M: 0.075,
      cacheWritePer1M: 0.15,
    };
  }
  if (/gpt[-_ ]?4\.1[-_ ]?(?:mini|nano)/.test(m)) {
    return {
      inputPer1M: 0.4,
      outputPer1M: 1.6,
      cacheReadPer1M: 0.1,
      cacheWritePer1M: 0.4,
    };
  }
  if (/gpt[-_ ]?4\.1|gpt[-_ ]?4o/.test(m)) {
    return {
      inputPer1M: 2,
      outputPer1M: 8,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 2,
    };
  }

  // xAI Grok
  if (/grok.*(?:fast|mini)/.test(m)) {
    return {
      inputPer1M: 0.2,
      outputPer1M: 1.5,
      cacheReadPer1M: 0.05,
      cacheWritePer1M: 0.2,
    };
  }
  if (/grok/.test(m)) {
    return {
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 0.75,
      cacheWritePer1M: 3,
    };
  }

  // Mai Code
  if (/mai[-_ ]?code[-_ ]?2[-_ ]?flash/.test(m)) {
    return {
      inputPer1M: 0.25,
      outputPer1M: 1.5,
      cacheReadPer1M: 0.025,
      cacheWritePer1M: 0.25,
    };
  }
  if (/mai[-_ ]?code/.test(m)) {
    return {
      inputPer1M: 1.5,
      outputPer1M: 7.5,
      cacheReadPer1M: 0.15,
      cacheWritePer1M: 1.5,
    };
  }

  return TIER_DEFAULT_RATES[tier];
}

/**
 * Resolves model tier, per-1M token USD rates, and optional Copilot premium
 * request multiplier from normalized model families and the Layer 0 catalog.
 */
export function resolveModelPricing(
  model: string,
  ide?: string,
  catalog?: readonly ModelCatalogEntry[] | ModelIndex,
): ModelPricing {
  const raw = (model || "").trim();
  const normalized = normalizeLegacyCopilotModelId(raw);
  const catalogEntry = findCatalogEntry(normalized, ide, catalog);

  const tier: ModelTier =
    catalogEntry?.tier ??
    (normalized && normalized.toLowerCase() !== "unknown" && normalized.toLowerCase() !== "inherit"
      ? inferModelTier(normalized, catalogEntry?.family)
      : "balanced");

  const rates = matchModelFamilyRates(normalized || raw, tier);

  let premiumMultiplier = catalogEntry?.premiumMultiplier;
  if (premiumMultiplier === undefined && ide === "copilot-vscode") {
    const syntheticEntry: ModelCatalogEntry = catalogEntry ?? {
      id: normalized || "unknown",
      label: raw || "Unknown",
      family: normalized || undefined,
      tier,
      capabilities: [],
      available: true,
      source: "built-in",
    };
    premiumMultiplier = defaultCostMultiplier(syntheticEntry);
  }

  return {
    tier,
    ...rates,
    ...(premiumMultiplier !== undefined ? { premiumMultiplier } : {}),
  };
}

/**
 * Estimates USD cost from token counts and resolved per-1M pricing.
 * Note: `outputTokens` includes `reasoningTokens` (billed at output rate).
 */
export function estimateCostUsd(
  tokens: TokenCostInput,
  pricing: ModelPricing,
): number {
  const uncachedIn = Math.max(0, tokens.uncachedInputTokens);
  const cacheRead = Math.max(0, tokens.cacheReadTokens);
  const cacheWrite = Math.max(0, tokens.cacheWriteTokens);
  const out = Math.max(0, tokens.outputTokens);
  return (
    (uncachedIn * pricing.inputPer1M +
      cacheRead * pricing.cacheReadPer1M +
      cacheWrite * pricing.cacheWritePer1M +
      out * pricing.outputPer1M) /
    1_000_000
  );
}

/**
 * Converts USD cost to integer deci-credits (10 deci-credits = 1 credit = $0.01 USD).
 */
export function usdToDeciCredits(costUsd: number): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  return Math.round(costUsd * 1000);
}

/**
 * Converts USD cost to Compute Credits (1 credit = $0.01 USD, 0.1 credit precision).
 */
export function usdToComputeCredits(costUsd: number): number {
  return usdToDeciCredits(costUsd) / 10;
}

/**
 * Computes GitHub Copilot premium requests (`turns * premiumMultiplier`) rounded to 2 decimals.
 */
export function computePremiumRequests(
  turns: number,
  premiumMultiplier?: number,
): number | undefined {
  if (
    typeof premiumMultiplier !== "number" ||
    !Number.isFinite(premiumMultiplier) ||
    premiumMultiplier < 0
  ) {
    return undefined;
  }
  const safeTurns = Math.max(0, turns);
  return Math.round(safeTurns * premiumMultiplier * 100) / 100;
}
