import type {
  HostIde,
  IdeModelConfig,
  IdeTierBinding,
  ModelCapabilityTag,
  ModelCatalogEntry,
  ModelIndex,
  ModelIndexHealth,
  ModelIndexLayersInfo,
  ModelIndexView,
  ModelRoutingPolicy,
  ModelSelectionCriterion,
  ModelSourceTag,
  ModelTier,
  RoleModelRouting,
  RoleRecommendation,
  TeamDetailsResponse,
  WorkflowModelRouting,
} from "../types.js";

const VALID_TIERS = new Set<ModelTier>(["fast", "balanced", "reasoning"]);
const VALID_POLICIES = new Set<ModelRoutingPolicy>([
  "defer-to-host",
  "prefer-fallback",
  "pinned",
]);
const VALID_SOURCES = new Set<ModelSourceTag>([
  "built-in",
  "vscode-lm",
  "agent",
  "user",
]);
const VALID_CAPS = new Set<ModelCapabilityTag>([
  "coding",
  "reasoning",
  "multimodal",
  "fast",
  "orchestration",
  "search",
  "long-context",
]);
const VALID_CRITERIA = new Set<ModelSelectionCriterion>([
  "accuracy",
  "cost",
  "speed",
]);

function normalizeSelectionPriority(
  raw: unknown,
  fallback: readonly ModelSelectionCriterion[] = ["accuracy", "cost", "speed"]
): ModelSelectionCriterion[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out: ModelSelectionCriterion[] = [];
  for (const item of raw) {
    if (
      typeof item === "string" &&
      VALID_CRITERIA.has(item as ModelSelectionCriterion) &&
      !out.includes(item as ModelSelectionCriterion)
    ) {
      out.push(item as ModelSelectionCriterion);
    }
  }
  return out.length > 0 ? out : [...fallback];
}

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

export function normalizeTier(val: unknown, fallback: ModelTier = "balanced"): ModelTier {
  return typeof val === "string" && VALID_TIERS.has(val as ModelTier)
    ? (val as ModelTier)
    : fallback;
}

export function normalizePolicy(
  val: unknown,
  fallback: ModelRoutingPolicy = "prefer-fallback"
): ModelRoutingPolicy {
  return typeof val === "string" && VALID_POLICIES.has(val as ModelRoutingPolicy)
    ? (val as ModelRoutingPolicy)
    : fallback;
}

export function buildDefaultModelIndex(): ModelIndex {
  return {
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
    updatedBy: "built-in",
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
          fast: { primary: "flash_lite", fallback: ["flash_lite", "flash", "inherit"] },
          balanced: { primary: "flash", fallback: ["flash", "pro", "inherit"] },
          reasoning: { primary: "pro", fallback: ["pro", "flash", "inherit"] },
        },
        catalog: [
          {
            id: "inherit",
            label: "Inherit Host / /swarm",
            tier: "balanced",
            capabilities: ["orchestration", "coding"],
            available: true,
            source: "built-in",
            notes: "Yields to active /swarm or user picker selection.",
          },
          {
            id: "flash_lite",
            label: "Flash Lite (Tier Enum)",
            tier: "fast",
            capabilities: ["fast", "orchestration"],
            available: true,
            source: "built-in",
          },
          {
            id: "flash",
            label: "Flash (Tier Enum)",
            tier: "balanced",
            capabilities: ["coding", "fast", "multimodal"],
            available: true,
            source: "built-in",
          },
          {
            id: "pro",
            label: "Pro (Tier Enum)",
            tier: "reasoning",
            capabilities: ["reasoning", "coding", "multimodal", "long-context"],
            available: true,
            source: "built-in",
          },
          {
            id: "gemini-3.5-flash-lite",
            label: "Gemini 3.5 Flash Lite",
            vendor: "google",
            family: "gemini-3.5",
            tier: "fast",
            capabilities: ["fast", "orchestration"],
            available: true,
            source: "built-in",
          },
          {
            id: "gemini-3.8-flash",
            label: "Gemini 3.8 Flash",
            vendor: "google",
            family: "gemini-3.8",
            tier: "balanced",
            capabilities: ["coding", "fast", "multimodal"],
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
          fast: { primary: "haiku", fallback: ["haiku", "sonnet", "inherit"] },
          balanced: { primary: "sonnet", fallback: ["sonnet", "opus", "inherit"] },
          reasoning: { primary: "opus", fallback: ["opus", "sonnet", "inherit"] },
        },
        catalog: [
          {
            id: "inherit",
            label: "Inherit Session /model",
            tier: "balanced",
            capabilities: ["orchestration", "coding"],
            available: true,
            source: "built-in",
            notes: "Yields to CLAUDE_CODE_SUBAGENT_MODEL and /model.",
          },
          {
            id: "haiku",
            label: "Claude Haiku (Alias)",
            vendor: "anthropic",
            family: "haiku",
            tier: "fast",
            capabilities: ["fast", "orchestration"],
            available: true,
            source: "built-in",
          },
          {
            id: "sonnet",
            label: "Claude Sonnet (Alias)",
            vendor: "anthropic",
            family: "sonnet",
            tier: "balanced",
            capabilities: ["coding", "reasoning", "multimodal"],
            available: true,
            source: "built-in",
          },
          {
            id: "opus",
            label: "Claude Opus (Alias)",
            vendor: "anthropic",
            family: "opus",
            tier: "reasoning",
            capabilities: ["reasoning", "coding", "multimodal", "long-context"],
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
  };
}

function normalizeBinding(raw: unknown, fallback: IdeTierBinding): IdeTierBinding {
  const rec = asRecord(raw);
  const primary =
    typeof rec.primary === "string" && rec.primary.trim()
      ? rec.primary.trim()
      : fallback.primary;
  const fb = Array.isArray(rec.fallback)
    ? rec.fallback.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : fallback.fallback;
  return {
    primary,
    fallback: fb,
    omitOnDefer:
      typeof rec.omitOnDefer === "boolean" ? rec.omitOnDefer : fallback.omitOnDefer,
    notes: typeof rec.notes === "string" ? rec.notes : fallback.notes,
  };
}

function normalizeCatalogEntry(raw: unknown): ModelCatalogEntry | null {
  const rec = asRecord(raw);
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return null;
  const caps = Array.isArray(rec.capabilities)
    ? rec.capabilities.filter(
        (c): c is ModelCapabilityTag =>
          typeof c === "string" && VALID_CAPS.has(c as ModelCapabilityTag)
      )
    : [];
  const src =
    typeof rec.source === "string" && VALID_SOURCES.has(rec.source as ModelSourceTag)
      ? (rec.source as ModelSourceTag)
      : "built-in";
  return {
    id,
    label: typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : id,
    vendor: typeof rec.vendor === "string" ? rec.vendor : undefined,
    family: typeof rec.family === "string" ? rec.family : undefined,
    tier: normalizeTier(rec.tier, "balanced"),
    capabilities: caps,
    contextWindow:
      typeof rec.contextWindow === "number" && rec.contextWindow > 0
        ? rec.contextWindow
        : undefined,
    premiumMultiplier:
      typeof rec.premiumMultiplier === "number" && rec.premiumMultiplier >= 0
        ? rec.premiumMultiplier
        : undefined,
    accuracyRank:
      typeof rec.accuracyRank === "number" && Number.isFinite(rec.accuracyRank)
        ? rec.accuracyRank
        : undefined,
    speedRank:
      typeof rec.speedRank === "number" && Number.isFinite(rec.speedRank)
        ? rec.speedRank
        : undefined,
    deprecated: typeof rec.deprecated === "boolean" ? rec.deprecated : undefined,
    available: typeof rec.available === "boolean" ? rec.available : true,
    source: src,
    discoveredAt: typeof rec.discoveredAt === "string" ? rec.discoveredAt : undefined,
    notes: typeof rec.notes === "string" ? rec.notes : undefined,
  };
}

function normalizeIdeConfig(raw: unknown, fallback: IdeModelConfig): IdeModelConfig {
  const rec = asRecord(raw);
  const rawTiers = asRecord(rec.tiers);
  const mode =
    rec.mode === "tier-enum" || rec.mode === "family-alias" || rec.mode === "picker-array"
      ? rec.mode
      : fallback.mode;
  const catalog = Array.isArray(rec.catalog)
    ? rec.catalog
        .map(normalizeCatalogEntry)
        .filter((e): e is ModelCatalogEntry => e !== null)
    : fallback.catalog;

  return {
    mode,
    tiers: {
      fast: normalizeBinding(rawTiers.fast, fallback.tiers.fast),
      balanced: normalizeBinding(rawTiers.balanced, fallback.tiers.balanced),
      reasoning: normalizeBinding(rawTiers.reasoning, fallback.tiers.reasoning),
    },
    catalog,
    lastSyncedAt:
      typeof rec.lastSyncedAt === "string" ? rec.lastSyncedAt : fallback.lastSyncedAt,
    syncSource:
      rec.syncSource === "built-in" ||
      rec.syncSource === "vscode-lm" ||
      rec.syncSource === "manual"
        ? rec.syncSource
        : fallback.syncSource,
  };
}

export function normalizeModelIndex(raw: unknown): ModelIndex {
  const def = buildDefaultModelIndex();
  const rec = asRecord(raw);
  const rawRecs = asRecord(rec.roleRecommendations);
  const roleRecommendations: Record<string, RoleRecommendation> = {
    ...def.roleRecommendations,
  };
  for (const [k, v] of Object.entries(rawRecs)) {
    const r = asRecord(v);
    if (typeof r.rationale === "string" && r.rationale.trim()) {
      roleRecommendations[k] = {
        tier: normalizeTier(r.tier, roleRecommendations[k]?.tier ?? "balanced"),
        rationale: r.rationale.trim(),
        multimodalPreferred:
          typeof r.multimodalPreferred === "boolean"
            ? r.multimodalPreferred
            : roleRecommendations[k]?.multimodalPreferred,
        deferToHostOrchestrator:
          typeof r.deferToHostOrchestrator === "boolean"
            ? r.deferToHostOrchestrator
            : roleRecommendations[k]?.deferToHostOrchestrator,
      };
    }
  }

  const rawIdes = asRecord(rec.ides);
  const updatedBy =
    rec.updatedBy === "built-in" ||
    rec.updatedBy === "cli" ||
    rec.updatedBy === "api" ||
    rec.updatedBy === "vscode-lm" ||
    rec.updatedBy === "agent" ||
    rec.updatedBy === "user"
      ? rec.updatedBy
      : def.updatedBy;

  return {
    $schema: typeof rec.$schema === "string" ? rec.$schema : undefined,
    schemaVersion: 1,
    updatedAt:
      typeof rec.updatedAt === "string" && rec.updatedAt ? rec.updatedAt : def.updatedAt,
    updatedBy,
    notes: typeof rec.notes === "string" ? rec.notes : undefined,
    selectionPriority: normalizeSelectionPriority(
      rec.selectionPriority,
      def.selectionPriority ?? ["accuracy", "cost", "speed"]
    ),
    roleRecommendations,
    ides: {
      antigravity: normalizeIdeConfig(rawIdes.antigravity, def.ides.antigravity),
      "claude-code": normalizeIdeConfig(rawIdes["claude-code"], def.ides["claude-code"]),
      "copilot-vscode": normalizeIdeConfig(
        rawIdes["copilot-vscode"],
        def.ides["copilot-vscode"]
      ),
    },
  };
}

export function normalizeWorkflowRouting(raw: unknown): WorkflowModelRouting {
  const rec = asRecord(raw);
  const rawIdePolicies = asRecord(rec.idePolicies);
  const idePolicies: Partial<Record<HostIde, ModelRoutingPolicy>> = {};
  for (const ide of ["antigravity", "claude-code", "copilot-vscode"] as HostIde[]) {
    if (typeof rawIdePolicies[ide] === "string" && VALID_POLICIES.has(rawIdePolicies[ide] as ModelRoutingPolicy)) {
      idePolicies[ide] = rawIdePolicies[ide] as ModelRoutingPolicy;
    }
  }
  return {
    policy: normalizePolicy(rec.policy, "prefer-fallback"),
    respectBuiltInOrchestrators: rec.respectBuiltInOrchestrators !== false,
    allowSubagentModelHints: rec.allowSubagentModelHints !== false,
    copilotHandoffModels: rec.copilotHandoffModels === true,
    selectionPriority: normalizeSelectionPriority(rec.selectionPriority),
    ...(Object.keys(idePolicies).length > 0 ? { idePolicies } : {}),
  };
}

function normalizeResolvedRoles(raw: unknown): Record<string, RoleModelRouting> {
  const out: Record<string, RoleModelRouting> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const r = asRecord(item);
      const id = typeof r.id === "string" ? r.id : typeof r.roleId === "string" ? r.roleId : "";
      if (!id) continue;
      out[id] = {
        id,
        modelTier: r.modelTier ? normalizeTier(r.modelTier) : undefined,
        modelPolicy: r.modelPolicy ? normalizePolicy(r.modelPolicy) : undefined,
        models: r.models && typeof r.models === "object" ? (r.models as RoleModelRouting["models"]) : undefined,
        resolved:
          r.resolved && typeof r.resolved === "object"
            ? (r.resolved as RoleModelRouting["resolved"])
            : undefined,
      };
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    for (const [k, val] of Object.entries(asRecord(raw))) {
      const r = asRecord(val);
      const id = typeof r.id === "string" && r.id ? r.id : k;
      out[id] = {
        id,
        modelTier: r.modelTier ? normalizeTier(r.modelTier) : undefined,
        modelPolicy: r.modelPolicy ? normalizePolicy(r.modelPolicy) : undefined,
        models: r.models && typeof r.models === "object" ? (r.models as RoleModelRouting["models"]) : undefined,
        resolved:
          r.resolved && typeof r.resolved === "object"
            ? (r.resolved as RoleModelRouting["resolved"])
            : undefined,
      };
    }
  }
  return out;
}

export function normalizeModelIndexView(raw: unknown): ModelIndexView {
  const rec = asRecord(raw);
  const rawLayers = asRecord(rec.layers);
  const rawRouting = asRecord(rec.routing);
  const wf = normalizeWorkflowRouting(rawRouting);

  const layers: ModelIndexLayersInfo = {
    globalPath:
      typeof rawLayers.globalPath === "string"
        ? rawLayers.globalPath
        : "~/.agent-studio/model-index.json",
    globalExists: Boolean(rawLayers.globalExists),
    globalUpdatedAt:
      typeof rawLayers.globalUpdatedAt === "string" ? rawLayers.globalUpdatedAt : undefined,
    workspacePath:
      typeof rawLayers.workspacePath === "string"
        ? rawLayers.workspacePath
        : ".agent-team/model-index.json",
    workspaceExists: Boolean(rawLayers.workspaceExists),
    workspaceUpdatedAt:
      typeof rawLayers.workspaceUpdatedAt === "string"
        ? rawLayers.workspaceUpdatedAt
        : undefined,
    globalDiffersFromWorkspace: Boolean(rawLayers.globalDiffersFromWorkspace),
  };

  return {
    ok: rec.ok !== false,
    projectId: typeof rec.projectId === "string" ? rec.projectId : undefined,
    projectRoot: typeof rec.projectRoot === "string" ? rec.projectRoot : undefined,
    effective: normalizeModelIndex(rec.effective),
    layers,
    routing: {
      ...wf,
      resolvedRoles: normalizeResolvedRoles(rawRouting.resolvedRoles),
    },
    compileResult: rec.compileResult,
  };
}

export function synthesizeModelIndexViewFromTeam(team: TeamDetailsResponse): ModelIndexView {
  const effective = buildDefaultModelIndex();
  if (team.modelIndexSummary?.updatedAt) {
    effective.updatedAt = team.modelIndexSummary.updatedAt;
  }
  const wf: WorkflowModelRouting = team.modelRouting
    ? {
        ...team.modelRouting,
        selectionPriority: normalizeSelectionPriority(team.modelRouting.selectionPriority),
      }
    : {
        policy: "prefer-fallback" as ModelRoutingPolicy,
        respectBuiltInOrchestrators: true,
        allowSubagentModelHints: true,
        copilotHandoffModels: false,
        selectionPriority: ["accuracy", "cost", "speed"],
      };
  if (wf.selectionPriority) {
    effective.selectionPriority = wf.selectionPriority;
  }

  const resolvedRoles: Record<string, RoleModelRouting> = {};
  for (const r of team.roster) {
    resolvedRoles[r.id] = {
      id: r.id,
      modelTier: r.modelTier,
      modelPolicy: r.modelPolicy,
      models: r.models,
      resolved: r.resolvedModels,
    };
  }

  return {
    ok: true,
    projectId: team.project.id,
    projectRoot: team.project.root,
    effective,
    layers: {
      globalPath: "~/.agent-studio/model-index.json",
      globalExists: Boolean(team.modelIndexSummary?.hasGlobalOverlay),
      globalUpdatedAt: team.modelIndexSummary?.globalLastSyncedAt,
      workspacePath: ".agent-team/model-index.json",
      workspaceExists: Boolean(team.modelIndexSummary?.hasWorkspaceOverlay),
      workspaceUpdatedAt: team.modelIndexSummary?.updatedAt,
      globalDiffersFromWorkspace: Boolean(team.modelIndexSummary?.globalDiffersFromWorkspace),
    },
    routing: {
      ...wf,
      resolvedRoles,
    },
  };
}

export function normalizeModelIndexHealth(raw: unknown): ModelIndexHealth | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = asRecord(raw);
  const rawLayers = asRecord(rec.layers);
  return {
    valid: rec.valid !== false,
    policy: normalizePolicy(rec.policy, "prefer-fallback"),
    layers: {
      globalPath:
        typeof rawLayers.globalPath === "string"
          ? rawLayers.globalPath
          : "~/.agent-studio/model-index.json",
      globalExists: Boolean(rawLayers.globalExists),
      workspacePath:
        typeof rawLayers.workspacePath === "string"
          ? rawLayers.workspacePath
          : ".agent-team/model-index.json",
      workspaceExists: Boolean(rawLayers.workspaceExists),
      globalLastSyncedAt:
        typeof rawLayers.globalLastSyncedAt === "string"
          ? rawLayers.globalLastSyncedAt
          : undefined,
      workspaceUpdatedAt:
        typeof rawLayers.workspaceUpdatedAt === "string"
          ? rawLayers.workspaceUpdatedAt
          : undefined,
    },
    warnings: Array.isArray(rec.warnings)
      ? rec.warnings.filter((w): w is string => typeof w === "string")
      : [],
    errors: Array.isArray(rec.errors)
      ? rec.errors.filter((e): e is string => typeof e === "string")
      : [],
  };
}
