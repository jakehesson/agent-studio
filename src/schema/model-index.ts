import { z } from "zod";

export const ModelTierSchema = z.enum(["fast", "balanced", "reasoning"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const ModelRoutingPolicySchema = z.enum([
  "defer-to-host",
  "prefer-fallback",
  "pinned",
]);
export type ModelRoutingPolicy = z.infer<typeof ModelRoutingPolicySchema>;

export const ModelCapabilityTagSchema = z.enum([
  "coding",
  "reasoning",
  "multimodal",
  "fast",
  "orchestration",
  "search",
  "long-context",
]);
export type ModelCapabilityTag = z.infer<typeof ModelCapabilityTagSchema>;

export const ModelSourceTagSchema = z.enum([
  "built-in",
  "vscode-lm",
  "agent",
  "user",
]);
export type ModelSourceTag = z.infer<typeof ModelSourceTagSchema>;

export const IdeSyncSourceSchema = z.enum(["built-in", "vscode-lm", "manual"]);
export type IdeSyncSource = z.infer<typeof IdeSyncSourceSchema>;

export const ModelUpdatedBySchema = z.enum([
  "built-in",
  "cli",
  "api",
  "vscode-lm",
  "agent",
  "user",
]);
export type ModelUpdatedBy = z.infer<typeof ModelUpdatedBySchema>;

export const IdeModelModeSchema = z.enum([
  "tier-enum",
  "family-alias",
  "picker-array",
]);
export type IdeModelMode = z.infer<typeof IdeModelModeSchema>;

export const ModelCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    vendor: z.string().optional(),
    family: z.string().optional(),
    tier: ModelTierSchema,
    capabilities: z.array(ModelCapabilityTagSchema).default([]),
    contextWindow: z.number().int().positive().optional(),
    premiumMultiplier: z.number().nonnegative().optional(),
    available: z.boolean().default(true),
    source: ModelSourceTagSchema.default("built-in"),
    discoveredAt: z.string().optional(),
    notes: z.string().optional(),
  })
  .passthrough();
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const IdeTierBindingSchema = z
  .object({
    primary: z.string().min(1),
    fallback: z.array(z.string().min(1)).default([]),
    omitOnDefer: z.boolean().optional(),
    notes: z.string().optional(),
  })
  .passthrough();
export type IdeTierBinding = z.infer<typeof IdeTierBindingSchema>;

export const IdeModelConfigSchema = z
  .object({
    mode: IdeModelModeSchema,
    tiers: z.object({
      fast: IdeTierBindingSchema,
      balanced: IdeTierBindingSchema,
      reasoning: IdeTierBindingSchema,
    }),
    catalog: z.array(ModelCatalogEntrySchema).default([]),
    lastSyncedAt: z.string().optional(),
    syncSource: IdeSyncSourceSchema.optional(),
  })
  .passthrough();
export type IdeModelConfig = z.infer<typeof IdeModelConfigSchema>;

export const RoleRecommendationSchema = z
  .object({
    tier: ModelTierSchema,
    rationale: z.string().min(1),
    multimodalPreferred: z.boolean().optional(),
    deferToHostOrchestrator: z.boolean().optional(),
  })
  .passthrough();
export type RoleRecommendation = z.infer<typeof RoleRecommendationSchema>;

export const ModelIndexSchema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(1).default(1),
    updatedAt: z.string().min(1),
    updatedBy: ModelUpdatedBySchema.default("built-in"),
    notes: z.string().optional(),
    roleRecommendations: z.record(z.string(), RoleRecommendationSchema),
    ides: z.object({
      antigravity: IdeModelConfigSchema,
      "claude-code": IdeModelConfigSchema,
      "copilot-vscode": IdeModelConfigSchema,
    }),
  })
  .passthrough();
export type ModelIndex = z.infer<typeof ModelIndexSchema>;

export const IdeTierBindingPatchSchema = z
  .object({
    primary: z.string().min(1).optional(),
    fallback: z.array(z.string().min(1)).optional(),
    omitOnDefer: z.boolean().optional(),
    notes: z.string().optional(),
  })
  .passthrough();
export type IdeTierBindingPatch = z.infer<typeof IdeTierBindingPatchSchema>;

export const IdeModelOverlaySchema = z
  .object({
    mode: IdeModelModeSchema.optional(),
    tiers: z
      .object({
        fast: IdeTierBindingPatchSchema.optional(),
        balanced: IdeTierBindingPatchSchema.optional(),
        reasoning: IdeTierBindingPatchSchema.optional(),
      })
      .partial()
      .optional(),
    catalog: z.array(ModelCatalogEntrySchema).optional(),
    lastSyncedAt: z.string().optional(),
    syncSource: IdeSyncSourceSchema.optional(),
  })
  .passthrough();
export type IdeModelOverlay = z.infer<typeof IdeModelOverlaySchema>;

export const ModelIndexOverlaySchema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(1).default(1),
    updatedAt: z.string().min(1).optional(),
    updatedBy: ModelUpdatedBySchema.optional(),
    notes: z.string().optional(),
    roleRecommendations: z
      .record(z.string(), RoleRecommendationSchema)
      .optional(),
    ides: z
      .object({
        antigravity: IdeModelOverlaySchema.optional(),
        "claude-code": IdeModelOverlaySchema.optional(),
        "copilot-vscode": IdeModelOverlaySchema.optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();
export type ModelIndexOverlay = z.infer<typeof ModelIndexOverlaySchema>;

export const DEFAULT_MODEL_INDEX_TIMESTAMP = "2026-11-25T00:00:00.000Z";

export const DEFAULT_MODEL_INDEX: ModelIndex = ModelIndexSchema.parse({
  schemaVersion: 1,
  updatedAt: DEFAULT_MODEL_INDEX_TIMESTAMP,
  updatedBy: "built-in",
  notes:
    "Built-in Agent Studio model index with portable IDE tier bindings, research-backed role recommendations, and host-compatible defaults.",
  roleRecommendations: {
    orchestrator: {
      tier: "fast",
      deferToHostOrchestrator: true,
      rationale:
        "Read-only board triage, dispatch, and QA gate verification (#1 token-savings lever).",
    },
    architect: {
      tier: "reasoning",
      rationale:
        "Technical specs, schemas, concurrency, and boundaries have highest downstream leverage.",
    },
    "ux-designer": {
      tier: "reasoning",
      multimodalPreferred: true,
      rationale:
        "Layout audits, visual hierarchy, multimodal UI inspection, and Z Fold 7 ergonomics.",
    },
    "backend-engineer": {
      tier: "balanced",
      rationale:
        "Server, CLI, compiler, and unit-test throughput with strong coding precision.",
    },
    "frontend-engineer": {
      tier: "balanced",
      rationale:
        "Interactive UI, SVG/CSS, and iterative typecheck/build fixes.",
    },
    "qa-validator": {
      tier: "fast",
      rationale:
        "Deterministic checkpoint runs, MCP testrun recording, and pass/fail triage (#2 token-savings lever).",
    },
    "team-setup": {
      tier: "balanced",
      rationale:
        "Repo inspection, user interview, deterministic init/sync/doctor onboarding.",
    },
  },
  ides: {
    antigravity: {
      mode: "tier-enum",
      syncSource: "built-in",
      tiers: {
        fast: {
          primary: "flash_lite",
          fallback: ["flash_lite", "flash", "inherit"],
          notes: "Portable fast tier enum for read-only routing and QA verification.",
        },
        balanced: {
          primary: "flash",
          fallback: ["flash", "pro", "inherit"],
          notes: "Portable balanced tier enum for daily implementation throughput.",
        },
        reasoning: {
          primary: "pro",
          fallback: ["pro", "flash", "inherit"],
          notes: "Portable high-reasoning tier enum for architecture & UX audits.",
        },
      },
      catalog: [
        {
          id: "inherit",
          label: "Inherit Host Selection (inherit)",
          vendor: "antigravity",
          family: "tier-enum",
          tier: "balanced",
          capabilities: ["orchestration", "coding", "reasoning"],
          available: true,
          source: "built-in",
          notes: "Defers to /swarm or active user UI Model Selection.",
        },
        {
          id: "flash_lite",
          label: "Flash Lite (flash_lite)",
          vendor: "google",
          family: "tier-enum",
          tier: "fast",
          capabilities: ["fast", "search", "orchestration"],
          available: true,
          source: "built-in",
          notes: "Antigravity portable fast tier enum.",
        },
        {
          id: "flash",
          label: "Flash (flash)",
          vendor: "google",
          family: "tier-enum",
          tier: "balanced",
          capabilities: ["coding", "fast", "multimodal", "long-context"],
          available: true,
          source: "built-in",
          notes: "Antigravity portable balanced tier enum.",
        },
        {
          id: "pro",
          label: "Pro (pro)",
          vendor: "google",
          family: "tier-enum",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "multimodal", "long-context"],
          available: true,
          source: "built-in",
          notes: "Antigravity portable reasoning tier enum.",
        },
        {
          id: "gemini-3.5-flash-lite",
          label: "Gemini 3.5 Flash Lite",
          vendor: "google",
          family: "gemini-3.5",
          tier: "fast",
          capabilities: ["fast", "search", "coding"],
          contextWindow: 1_000_000,
          available: true,
          source: "built-in",
        },
        {
          id: "gemini-3.8-flash",
          label: "Gemini 3.8 Flash",
          vendor: "google",
          family: "gemini-3.8",
          tier: "balanced",
          capabilities: ["coding", "fast", "multimodal", "long-context"],
          contextWindow: 1_000_000,
          available: true,
          source: "built-in",
        },
        {
          id: "gemini-4-carbon",
          label: "Gemini 4 Carbon",
          vendor: "google",
          family: "gemini-4",
          tier: "balanced",
          capabilities: ["coding", "reasoning", "multimodal"],
          contextWindow: 1_000_000,
          available: true,
          source: "built-in",
        },
        {
          id: "gemini-4-argon",
          label: "Gemini 4 Argon",
          vendor: "google",
          family: "gemini-4",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "orchestration"],
          contextWindow: 1_000_000,
          available: true,
          source: "built-in",
        },
        {
          id: "gemini-4-neon",
          label: "Gemini 4 Neon",
          vendor: "google",
          family: "gemini-4",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "multimodal", "long-context"],
          contextWindow: 1_000_000,
          available: true,
          source: "built-in",
        },
        {
          id: "gemini-4-hydrogen",
          label: "Gemini 4 Hydrogen",
          vendor: "google",
          family: "gemini-4",
          tier: "fast",
          capabilities: ["fast", "search"],
          contextWindow: 1_000_000,
          available: true,
          source: "built-in",
        },
      ],
    },
    "claude-code": {
      mode: "family-alias",
      syncSource: "built-in",
      tiers: {
        fast: {
          primary: "haiku",
          fallback: ["haiku", "sonnet", "inherit"],
          notes: "Yields to CLAUDE_CODE_SUBAGENT_MODEL and Agent invocation overrides.",
        },
        balanced: {
          primary: "sonnet",
          fallback: ["sonnet", "opus", "inherit"],
          notes: "Balanced coding alias; yields to CLAUDE_CODE_SUBAGENT_MODEL.",
        },
        reasoning: {
          primary: "opus",
          fallback: ["opus", "sonnet", "inherit"],
          notes: "Deep architecture & design alias; yields to CLAUDE_CODE_SUBAGENT_MODEL.",
        },
      },
      catalog: [
        {
          id: "inherit",
          label: "Inherit Session / Env (inherit)",
          vendor: "anthropic",
          family: "alias",
          tier: "balanced",
          capabilities: ["orchestration", "coding", "reasoning"],
          available: true,
          source: "built-in",
          notes: "Inherits session /model or CLAUDE_CODE_SUBAGENT_MODEL.",
        },
        {
          id: "haiku",
          label: "Claude Haiku (haiku)",
          vendor: "anthropic",
          family: "haiku",
          tier: "fast",
          capabilities: ["fast", "search", "orchestration"],
          contextWindow: 200_000,
          available: true,
          source: "built-in",
        },
        {
          id: "sonnet",
          label: "Claude Sonnet (sonnet)",
          vendor: "anthropic",
          family: "sonnet",
          tier: "balanced",
          capabilities: ["coding", "reasoning", "multimodal"],
          contextWindow: 200_000,
          available: true,
          source: "built-in",
        },
        {
          id: "opus",
          label: "Claude Opus (opus)",
          vendor: "anthropic",
          family: "opus",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "orchestration", "multimodal"],
          contextWindow: 200_000,
          available: true,
          source: "built-in",
        },
      ],
    },
    "copilot-vscode": {
      mode: "picker-array",
      syncSource: "built-in",
      tiers: {
        fast: {
          primary: "Claude Haiku 4.5 (copilot)",
          fallback: [
            "Claude Haiku 4.5 (copilot)",
            "Gemini 3 Flash (copilot)",
            "GPT-4.1 (copilot)",
            "GPT-4o mini (copilot)",
          ],
          omitOnDefer: true,
          notes: "Emits model-policy: preferred unless policy is pinned; omitted on defer-to-host for Fusion/Auto.",
        },
        balanced: {
          primary: "Claude Sonnet 4.5 (copilot)",
          fallback: [
            "Claude Sonnet 4.5 (copilot)",
            "Claude Sonnet 4 (copilot)",
            "GPT-4.1 (copilot)",
            "Gemini 2.5 Pro (copilot)",
          ],
          omitOnDefer: true,
          notes: "Emits model-policy: preferred unless policy is pinned; omitted on defer-to-host for Fusion/Auto.",
        },
        reasoning: {
          primary: "Claude Opus 4.5 (copilot)",
          fallback: [
            "Claude Opus 4.5 (copilot)",
            "Claude Opus 4.1 (copilot)",
            "Claude Sonnet 4.5 (copilot)",
            "Gemini 2.5 Pro (copilot)",
          ],
          omitOnDefer: true,
          notes: "Emits model-policy: preferred unless policy is pinned; omitted on defer-to-host for Fusion/Auto.",
        },
      },
      catalog: [
        {
          id: "Claude Haiku 4.5 (copilot)",
          label: "Claude Haiku 4.5",
          vendor: "copilot",
          family: "claude-haiku-4.5",
          tier: "fast",
          capabilities: ["fast", "search", "orchestration"],
          contextWindow: 200_000,
          premiumMultiplier: 0.33,
          available: true,
          source: "built-in",
        },
        {
          id: "Gemini 3 Flash (copilot)",
          label: "Gemini 3 Flash",
          vendor: "copilot",
          family: "gemini-3-flash",
          tier: "fast",
          capabilities: ["fast", "multimodal", "long-context"],
          contextWindow: 1_000_000,
          premiumMultiplier: 0.33,
          available: true,
          source: "built-in",
        },
        {
          id: "GPT-4.1 (copilot)",
          label: "GPT-4.1",
          vendor: "copilot",
          family: "gpt-4.1",
          tier: "balanced",
          capabilities: ["coding", "fast", "long-context"],
          contextWindow: 128_000,
          premiumMultiplier: 0,
          available: true,
          source: "built-in",
        },
        {
          id: "GPT-4o mini (copilot)",
          label: "GPT-4o mini",
          vendor: "copilot",
          family: "gpt-4o-mini",
          tier: "fast",
          capabilities: ["fast"],
          contextWindow: 128_000,
          premiumMultiplier: 0,
          available: true,
          source: "built-in",
        },
        {
          id: "Claude Sonnet 4.5 (copilot)",
          label: "Claude Sonnet 4.5",
          vendor: "copilot",
          family: "claude-sonnet-4.5",
          tier: "balanced",
          capabilities: ["coding", "reasoning", "multimodal"],
          contextWindow: 200_000,
          premiumMultiplier: 1,
          available: true,
          source: "built-in",
        },
        {
          id: "Claude Sonnet 4 (copilot)",
          label: "Claude Sonnet 4",
          vendor: "copilot",
          family: "claude-sonnet-4",
          tier: "balanced",
          capabilities: ["coding", "reasoning"],
          contextWindow: 200_000,
          premiumMultiplier: 1,
          available: true,
          source: "built-in",
        },
        {
          id: "Gemini 2.5 Pro (copilot)",
          label: "Gemini 2.5 Pro",
          vendor: "copilot",
          family: "gemini-2.5-pro",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "multimodal", "long-context"],
          contextWindow: 1_000_000,
          premiumMultiplier: 1,
          available: true,
          source: "built-in",
        },
        {
          id: "Claude Opus 4.5 (copilot)",
          label: "Claude Opus 4.5",
          vendor: "copilot",
          family: "claude-opus-4.5",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "orchestration", "multimodal"],
          contextWindow: 200_000,
          premiumMultiplier: 3,
          available: true,
          source: "built-in",
        },
        {
          id: "Claude Opus 4.1 (copilot)",
          label: "Claude Opus 4.1",
          vendor: "copilot",
          family: "claude-opus-4.1",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "orchestration"],
          contextWindow: 200_000,
          premiumMultiplier: 10,
          available: true,
          source: "built-in",
        },
      ],
    },
  },
});
