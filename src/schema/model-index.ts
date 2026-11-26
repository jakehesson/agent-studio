import { z } from "zod";

export const ModelTierSchema = z.enum(["fast", "balanced", "reasoning"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const SelectionPriorityMetricSchema = z.enum([
  "accuracy",
  "cost",
  "speed",
]);
export type SelectionPriorityMetric = z.infer<
  typeof SelectionPriorityMetricSchema
>;

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
    accuracyRank: z.number().optional(),
    speedRank: z.number().optional(),
    deprecated: z.boolean().optional(),
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
    selectionPriority: z
      .array(SelectionPriorityMetricSchema)
      .default(["accuracy", "cost", "speed"]),
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
    selectionPriority: z.array(SelectionPriorityMetricSchema).optional(),
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
    "Built-in Agent Studio model index with portable IDE tier bindings, accuracy-first ranking, research-backed role recommendations, and host-compatible defaults.",
  selectionPriority: ["accuracy", "cost", "speed"],
  roleRecommendations: {
    orchestrator: {
      tier: "balanced",
      deferToHostOrchestrator: true,
      rationale:
        "Coordination, task-splitting, and board triage require strong judgment without falling back to low-accuracy fast models.",
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
    "code-reviewer": {
      tier: "reasoning",
      rationale:
        "Deep code review for security vulnerabilities, architecture conformance, concurrency bugs, performance regressions, and test coverage.",
    },
    "qa-validator": {
      tier: "balanced",
      rationale:
        "Deterministic checkpoint runs, MCP testrun recording, and accurate pass/fail bug triage.",
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
          primary: "gemini-3-flash",
          fallback: [
            "gemini-3-flash",
            "mai-code-2",
            "gpt-5-mini",
            "gpt-4.1",
          ],
          omitOnDefer: true,
          notes: "Emits model-policy: preferred unless policy is pinned; omitted on defer-to-host for Fusion/Auto.",
        },
        balanced: {
          primary: "claude-sonnet-4.6",
          fallback: [
            "claude-sonnet-4.6",
            "gpt-5.4",
            "mai-code-2",
            "claude-sonnet-4.5",
          ],
          omitOnDefer: true,
          notes: "Emits model-policy: preferred unless policy is pinned; omitted on defer-to-host for Fusion/Auto.",
        },
        reasoning: {
          primary: "claude-opus-4.6",
          fallback: [
            "claude-opus-4.6",
            "gpt-5.4",
            "gemini-3.1-pro",
            "claude-opus-4.5",
          ],
          omitOnDefer: true,
          notes: "Emits model-policy: preferred unless policy is pinned; omitted on defer-to-host for Fusion/Auto.",
        },
      },
      catalog: [
        {
          id: "claude-opus-4.6",
          label: "Claude Opus 4.6",
          vendor: "copilot",
          family: "claude-opus-4.6",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "orchestration", "multimodal"],
          contextWindow: 200_000,
          premiumMultiplier: 3,
          accuracyRank: 100,
          speedRank: 45,
          available: true,
          source: "built-in",
        },
        {
          id: "gpt-5.4",
          label: "GPT-5.4",
          vendor: "copilot",
          family: "gpt-5.4",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "orchestration", "multimodal", "long-context"],
          contextWindow: 1_000_000,
          premiumMultiplier: 1,
          accuracyRank: 96,
          speedRank: 65,
          available: true,
          source: "built-in",
        },
        {
          id: "claude-opus-4.5",
          label: "Claude Opus 4.5",
          vendor: "copilot",
          family: "claude-opus-4.5",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "orchestration", "multimodal"],
          contextWindow: 200_000,
          premiumMultiplier: 3,
          accuracyRank: 93,
          speedRank: 45,
          available: true,
          source: "built-in",
        },
        {
          id: "gemini-3.1-pro",
          label: "Gemini 3.1 Pro",
          vendor: "copilot",
          family: "gemini-3.1-pro",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "multimodal", "long-context"],
          contextWindow: 1_000_000,
          premiumMultiplier: 1,
          accuracyRank: 90,
          speedRank: 60,
          available: true,
          source: "built-in",
        },
        {
          id: "claude-sonnet-4.6",
          label: "Claude Sonnet 4.6",
          vendor: "copilot",
          family: "claude-sonnet-4.6",
          tier: "balanced",
          capabilities: ["coding", "reasoning", "multimodal"],
          contextWindow: 200_000,
          premiumMultiplier: 1,
          accuracyRank: 88,
          speedRank: 70,
          available: true,
          source: "built-in",
        },
        {
          id: "mai-code-2",
          label: "Mai Code 2",
          vendor: "copilot",
          family: "mai-code-2",
          tier: "balanced",
          capabilities: ["coding", "reasoning", "long-context"],
          contextWindow: 1_000_000,
          premiumMultiplier: 0.33,
          accuracyRank: 85,
          speedRank: 82,
          available: true,
          source: "built-in",
        },
        {
          id: "claude-sonnet-4.5",
          label: "Claude Sonnet 4.5",
          vendor: "copilot",
          family: "claude-sonnet-4.5",
          tier: "balanced",
          capabilities: ["coding", "reasoning", "multimodal"],
          contextWindow: 200_000,
          premiumMultiplier: 1,
          accuracyRank: 82,
          speedRank: 68,
          available: true,
          source: "built-in",
        },
        {
          id: "gemini-3-flash",
          label: "Gemini 3 Flash",
          vendor: "copilot",
          family: "gemini-3-flash",
          tier: "fast",
          capabilities: ["fast", "multimodal", "long-context"],
          contextWindow: 1_000_000,
          premiumMultiplier: 0.33,
          accuracyRank: 78,
          speedRank: 90,
          available: true,
          source: "built-in",
        },
        {
          id: "mai-code-2-flash",
          label: "Mai Code 2 Flash",
          vendor: "copilot",
          family: "mai-code-2-flash",
          tier: "fast",
          capabilities: ["fast", "coding", "long-context"],
          contextWindow: 1_000_000,
          premiumMultiplier: 0,
          accuracyRank: 76,
          speedRank: 92,
          available: true,
          source: "built-in",
        },
        {
          id: "gpt-5-mini",
          label: "GPT-5 mini",
          vendor: "copilot",
          family: "gpt-5-mini",
          tier: "fast",
          capabilities: ["fast", "coding"],
          contextWindow: 400_000,
          premiumMultiplier: 0,
          accuracyRank: 72,
          speedRank: 88,
          available: true,
          source: "built-in",
        },
        {
          id: "gpt-4.1",
          label: "GPT-4.1",
          vendor: "copilot",
          family: "gpt-4.1",
          tier: "balanced",
          capabilities: ["coding", "fast", "long-context"],
          contextWindow: 1_000_000,
          premiumMultiplier: 0,
          accuracyRank: 70,
          speedRank: 85,
          available: true,
          source: "built-in",
        },
        {
          id: "claude-haiku-4.5",
          label: "Claude Haiku 4.5",
          vendor: "copilot",
          family: "claude-haiku-4.5",
          tier: "fast",
          capabilities: ["fast", "search", "orchestration"],
          contextWindow: 200_000,
          premiumMultiplier: 0.33,
          accuracyRank: 45,
          speedRank: 92,
          deprecated: true,
          available: true,
          source: "built-in",
        },
        {
          id: "gpt-4o-mini",
          label: "GPT-4o mini",
          vendor: "copilot",
          family: "gpt-4o-mini",
          tier: "fast",
          capabilities: ["fast"],
          contextWindow: 128_000,
          premiumMultiplier: 0,
          accuracyRank: 35,
          speedRank: 95,
          deprecated: true,
          available: true,
          source: "built-in",
        },
        {
          id: "claude-sonnet-4",
          label: "Claude Sonnet 4",
          vendor: "copilot",
          family: "claude-sonnet-4",
          tier: "balanced",
          capabilities: ["coding", "reasoning"],
          contextWindow: 200_000,
          premiumMultiplier: 1,
          accuracyRank: 68,
          speedRank: 65,
          deprecated: true,
          available: true,
          source: "built-in",
        },
        {
          id: "gemini-2.5-pro",
          label: "Gemini 2.5 Pro",
          vendor: "copilot",
          family: "gemini-2.5-pro",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "multimodal", "long-context"],
          contextWindow: 1_000_000,
          premiumMultiplier: 1,
          accuracyRank: 75,
          speedRank: 55,
          deprecated: true,
          available: true,
          source: "built-in",
        },
        {
          id: "claude-opus-4.1",
          label: "Claude Opus 4.1",
          vendor: "copilot",
          family: "claude-opus-4.1",
          tier: "reasoning",
          capabilities: ["reasoning", "coding", "orchestration"],
          contextWindow: 200_000,
          premiumMultiplier: 10,
          accuracyRank: 72,
          speedRank: 40,
          deprecated: true,
          available: true,
          source: "built-in",
        },
      ],
    },
  },
});
