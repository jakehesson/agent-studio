import {
  computePremiumRequests,
  estimateCostUsd,
  resolveModelPricing,
  usdToDeciCredits,
} from "../models/pricing.js";
import type { ModelCatalogEntry, ModelIndex, ModelTier } from "../schema/model-index.js";
import type {
  AgentBreakdownEntry,
  BreakdownAttribution,
  CategoryUsageBucket,
  EfficiencyInsight,
  ModelUsageBucket,
  ReasoningSource,
  SessionUsageBreakdown,
  SessionUsageSource,
  TierUsageBucket,
  TokenCompositionBreakdown,
  UsageSource,
  WorkCategoryId,
} from "../schema/telemetry.js";
import type { EnrichedEvent, RichSessionSnapshot } from "./types.js";

export const MAX_BREAKDOWN_SESSIONS = 20;

export const WORK_CATEGORY_LABELS: Record<WorkCategoryId, string> = {
  exploration_reads: "Exploration & Reads",
  code_editing: "Code Editing",
  shell_build_tests: "Shell, Build & Tests",
  reasoning_planning: "Reasoning & Planning",
  orchestration_subagents: "Orchestration & Subagents",
  board_mcp_workflow: "Board & MCP Workflow",
  web_docs_external: "Web & Docs",
  conversation_overhead: "Conversation Overhead",
};

const EXPLORATION_TOOLS = new Set([
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "find_by_name",
  "grep_search",
  "list_dir",
  "read",
  "view",
  "glob",
  "grep",
  "rg",
  "copilot_readfile",
  "copilot_findfiles",
  "copilot_findtextinfiles",
  "copilot_listdirectory",
  "copilot_searchcodebase",
  "copilot_getchangedfiles",
  "copilot_geterrors",
]);

const CODE_EDITING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write",
  "edit",
  "multiedit",
  "apply_patch",
  "create",
  "str_replace",
  "copilot_applypatch",
  "copilot_createfile",
  "copilot_createdirectory",
  "copilot_edit",
  "copilot_replacestring",
  "copilot_multireplacestring",
]);

const SHELL_TOOLS = new Set([
  "run_command",
  "send_command_input",
  "command_status",
  "manage_task",
  "bash",
  "powershell",
  "run_in_terminal",
  "execute/runinterminal",
  "send_to_terminal",
  "get_terminal_output",
]);

const PLANNING_TOOLS = new Set([
  "manage_todo_list",
  "todowrite",
  "todoread",
  "enterplanmode",
  "exitplanmode",
  "sql",
]);

const ORCHESTRATION_TOOLS = new Set([
  "invoke_subagent",
  "agent",
  "task",
  "runsubagent",
  "agent/runsubagent",
  "send_message",
  "sendmessage",
  "write_agent",
  "read_agent",
  "tool_search_tool",
  "skill",
]);

const WEB_DOCS_TOOLS = new Set([
  "read_url_content",
  "search_web",
  "browser_subagent",
  "open_browser_url",
  "webfetch",
  "web_fetch",
  "websearch",
  "web_search",
  "copilot_fetchwebpage",
  "vscode_fetchwebpage_internal",
  "gemini_search_docs",
  "gemini_get_doc",
]);

const BOARD_MCP_TOOLS = new Set([
  "board",
  "testrun",
  "projects",
  "telemetry",
  "call_mcp_tool",
  "read_resource",
  "list_resources",
]);

const OVERHEAD_TOOLS = new Set([
  "ask_question",
  "askuserquestion",
  "ask_user",
  "vscode_askquestions",
  "ask_questions",
  "askquestions",
  "questioncarousel",
  "elicitationserialized",
  "ask_human",
  "agent_studio_ask_human",
  "mcp__agent-studio__ask_human",
  "agent-studio/ask_human",
  "rename_chat",
]);

function extractStrReplaceCommand(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (!payload) return undefined;
  const candidates = [
    payload.command,
    (payload.args as Record<string, unknown> | undefined)?.command,
    (payload.input as Record<string, unknown> | undefined)?.command,
    (payload.toolArgs as Record<string, unknown> | undefined)?.command,
    (payload.toolInput as Record<string, unknown> | undefined)?.command,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return c.trim().toLowerCase();
    }
  }
  return undefined;
}

/**
 * Deterministically classifies any normalized telemetry event into one of the 8
 * canonical work categories.
 */
export function classifyEventWorkCategory(
  ev: Pick<EnrichedEvent, "kind" | "toolName" | "summary" | "payload">,
): WorkCategoryId {
  if (ev.kind === "thinking_start") {
    return "reasoning_planning";
  }
  if (ev.kind === "subagent_spawn" || ev.kind === "subagent_done") {
    return "orchestration_subagents";
  }
  if (ev.kind === "board_mutation") {
    return "board_mcp_workflow";
  }
  if (ev.kind === "tool_start" || ev.kind === "tool_end") {
    const low = (ev.toolName ?? "").trim().toLowerCase();
    if (!low) return "conversation_overhead";

    if (OVERHEAD_TOOLS.has(low)) {
      return "conversation_overhead";
    }
    if (low === "str_replace_editor") {
      const cmd = extractStrReplaceCommand(ev.payload);
      if (cmd === "view" || (!cmd && /\bview\b/i.test(ev.summary ?? ""))) {
        return "exploration_reads";
      }
      return "code_editing";
    }
    if (
      EXPLORATION_TOOLS.has(low) ||
      low.startsWith("search/") ||
      low.startsWith("read/")
    ) {
      return "exploration_reads";
    }
    if (CODE_EDITING_TOOLS.has(low) || low.startsWith("edit/")) {
      return "code_editing";
    }
    if (
      SHELL_TOOLS.has(low) ||
      low.startsWith("execute/") ||
      low.includes("terminal")
    ) {
      return "shell_build_tests";
    }
    if (PLANNING_TOOLS.has(low)) {
      return "reasoning_planning";
    }
    if (ORCHESTRATION_TOOLS.has(low)) {
      return "orchestration_subagents";
    }
    if (WEB_DOCS_TOOLS.has(low) || low.includes("chrome-devtools")) {
      return "web_docs_external";
    }
    if (
      BOARD_MCP_TOOLS.has(low) ||
      low.startsWith("mcp__") ||
      low.startsWith("mcp_")
    ) {
      return "board_mcp_workflow";
    }
    return "conversation_overhead";
  }
  return "conversation_overhead";
}

/**
 * Hamilton largest-remainder integer allocation: guarantees `sum(out) === total`
 * with zero drift.
 */
export function allocateHamilton(
  total: number,
  weights: readonly number[],
): number[] {
  const safeTotal = Math.max(0, Math.round(total));
  if (weights.length === 0) return [];
  if (safeTotal === 0) return weights.map(() => 0);

  const cleanWeights = weights.map((w) =>
    Number.isFinite(w) && w > 0 ? w : 0,
  );
  let sumW = cleanWeights.reduce((acc, w) => acc + w, 0);
  const effWeights = sumW > 0 ? cleanWeights : weights.map(() => 1);
  if (sumW <= 0) {
    sumW = effWeights.length;
  }

  const floors: number[] = [];
  const remainders: Array<{ idx: number; rem: number; weight: number }> = [];
  let floorSum = 0;

  for (let i = 0; i < effWeights.length; i++) {
    const w = effWeights[i]!;
    const exact = (safeTotal * w) / sumW;
    const fl = Math.floor(exact);
    floors.push(fl);
    floorSum += fl;
    remainders.push({ idx: i, rem: exact - fl, weight: w });
  }

  let left = safeTotal - floorSum;
  remainders.sort(
    (a, b) => b.rem - a.rem || b.weight - a.weight || a.idx - b.idx,
  );
  for (let i = 0; i < remainders.length && left > 0; i++) {
    floors[remainders[i]!.idx]! += 1;
    left -= 1;
  }
  return floors;
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

function payloadTextLen(val: unknown): number {
  if (typeof val === "string") return val.length;
  if (val && typeof val === "object") {
    try {
      return JSON.stringify(val).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

export function computeEventWeight(ev: EnrichedEvent): number {
  const CAP = 2000;
  const summaryLen = Math.min(CAP, (ev.summary ?? "").length);
  const bodyLen = Math.min(
    CAP,
    Math.max(
      ev.bodyLength ?? 0,
      payloadTextLen(ev.payload?.body),
      payloadTextLen(ev.payload?.prompt),
    ),
  );
  const toolLen = Math.min(
    CAP,
    Math.max(
      payloadTextLen(ev.payload?.toolArgs),
      payloadTextLen(ev.payload?.toolInput),
      payloadTextLen(ev.payload?.args),
      payloadTextLen(ev.payload?.input),
      payloadTextLen(ev.payload?.toolResult),
      payloadTextLen(ev.payload?.resultDetails),
      payloadTextLen(ev.payload?.preview),
    ),
  );
  const span = Math.max(summaryLen, bodyLen, toolLen);
  const floor =
    ev.kind === "tool_start" ||
    ev.kind === "tool_end" ||
    ev.kind === "board_mutation" ||
    ev.kind === "subagent_spawn"
      ? 16
      : 4;
  return Math.max(floor, span);
}

export function computeEventThinkingChars(ev: EnrichedEvent): number {
  if (ev.kind !== "thinking_start") return 0;
  return Math.max(
    ev.bodyLength ?? 0,
    payloadTextLen(ev.payload?.body),
    (ev.summary ?? "").length,
  );
}

export interface AgentBreakdownInput {
  agentId: string;
  label: string;
  role: string;
  ide: string;
  isRoot: boolean;
  model: string;
  usageSource: UsageSource;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  hasCacheSplit: boolean;
  reasoningTokens?: number;
  hasExactReasoning: boolean;
  hadIsTotalUsage: boolean;
  contextPercent: number;
  costUsd?: number;
  toolCalls: number;
  turns: number;
  thinkingChars: number;
  events: EnrichedEvent[];
}

export interface ComputedAgentBreakdownExtras {
  tier: ModelTier;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens: number;
  reasoningSource: ReasoningSource;
  costUsd: number;
  costSource: UsageSource;
  credits: number;
  creditSource: UsageSource;
  premiumMultiplier?: number;
  premiumRequests?: number;
  turns: number;
  dominantCategory: WorkCategoryId;
}

export interface ComputeSessionBreakdownResult {
  breakdown: SessionUsageBreakdown;
  agentExtras: Map<string, ComputedAgentBreakdownExtras>;
  sessionCacheReadTokens: number;
  sessionCacheWriteTokens: number;
  sessionReasoningTokens: number;
  sessionCostUsd: number;
  sessionCredits: number;
  sessionCreditSource: SessionUsageSource;
  sessionPremiumRequests?: number;
}

interface MutableCatAcc {
  category: WorkCategoryId;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  nonReasoningOutputTokens: number;
  reasoningTokens: number;
  microUsd: number;
  deciCredits: number;
  eventCount: number;
  toolCalls: number;
  errorCount: number;
  toolFreq: Map<string, number>;
  attributions: Set<BreakdownAttribution>;
}

function ensureCatAcc(
  map: Map<WorkCategoryId, MutableCatAcc>,
  category: WorkCategoryId,
): MutableCatAcc {
  let acc = map.get(category);
  if (!acc) {
    acc = {
      category,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      nonReasoningOutputTokens: 0,
      reasoningTokens: 0,
      microUsd: 0,
      deciCredits: 0,
      eventCount: 0,
      toolCalls: 0,
      errorCount: 0,
      toolFreq: new Map(),
      attributions: new Set(),
    };
    map.set(category, acc);
  }
  return acc;
}

function mergeAttributions(
  attrs: ReadonlySet<BreakdownAttribution>,
): BreakdownAttribution {
  if (attrs.size === 0) return "estimated";
  if (attrs.size === 1) return attrs.values().next().value!;
  if (attrs.has("exact") || attrs.has("attributed")) return "attributed";
  return "estimated";
}

function isErrorEvent(ev: EnrichedEvent): boolean {
  return Boolean(
    ev.isError || ev.status === "error" || ev.status === "denied",
  );
}

function normalizeChurnSignature(ev: EnrichedEvent): string {
  const tool = (ev.toolName ?? "").trim().toLowerCase();
  const sum = (ev.summary ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return `${ev.agentId}::${tool}::${sum}`;
}

/**
 * Evaluates all 6 deterministic efficiency insights over the computed breakdown.
 */
export function detectEfficiencyInsights(params: {
  composition: TokenCompositionBreakdown;
  byCategory: readonly CategoryUsageBucket[];
  byAgent: readonly AgentBreakdownEntry[];
  events: readonly EnrichedEvent[];
  agentContextPercents: ReadonlyMap<string, number>;
  totalsCostUsd: number;
}): EfficiencyInsight[] {
  const {
    composition,
    byCategory,
    byAgent,
    events,
    agentContextPercents,
    totalsCostUsd,
  } = params;
  const insights: EfficiencyInsight[] = [];
  const catMap = new Map<WorkCategoryId, CategoryUsageBucket>(
    byCategory.map((b) => [b.category, b]),
  );

  const avgCostPerToken =
    composition.totalTokens > 0
      ? totalsCostUsd / composition.totalTokens
      : 0;
  const avgCostPerFreshToken =
    composition.freshTokens > 0
      ? totalsCostUsd / composition.freshTokens
      : avgCostPerToken;

  // 1. low_cache_hit_rate
  const totalInputFootprint =
    composition.uncachedInputTokens +
    composition.cacheReadTokens +
    composition.cacheWriteTokens;
  if (totalInputFootprint >= 10_000 && composition.cacheHitRate < 40) {
    const targetCacheRead = Math.round(totalInputFootprint * 0.6);
    const deltaCached = Math.max(
      0,
      targetCacheRead - composition.cacheReadTokens,
    );
    const estUsd = Math.round(deltaCached * avgCostPerToken * 0.8 * 10_000) / 10_000;
    const estCredits = usdToDeciCredits(estUsd) / 10;
    const affected = byAgent
      .filter((a) => {
        const inp =
          a.uncachedInputTokens + a.cacheReadTokens + a.cacheWriteTokens;
        return inp >= 5_000 && a.cacheHitRate < 40;
      })
      .map((a) => a.agentId);

    insights.push({
      id: "low_cache_hit_rate",
      severity: composition.cacheHitRate < 15 ? "warning" : "opportunity",
      title: "Low Prompt Cache Hit Rate",
      detail: `Only ${composition.cacheHitRate}% of ${totalInputFootprint.toLocaleString()} input tokens hit prompt cache.`,
      recommendation:
        "Stabilize static system/workspace prefixes and avoid frequent context resets to lift cache reuse above 60%.",
      metricValue: composition.cacheHitRate,
      metricUnit: "%",
      ...(deltaCached > 0 ? { estimatedSavingsTokens: deltaCached } : {}),
      ...(estCredits > 0 ? { estimatedSavingsCredits: estCredits } : {}),
      ...(estUsd > 0 ? { estimatedSavingsUsd: estUsd } : {}),
      ...(affected.length > 0 ? { affectedAgentIds: affected } : {}),
    });
  }

  // 2. high_exploration_ratio
  const exploration = catMap.get("exploration_reads");
  if (
    exploration &&
    composition.freshTokens >= 2_000 &&
    (exploration.freshSharePercent >= 45 || exploration.sharePercent >= 45) &&
    (exploration.toolCalls >= 4 || exploration.totalTokens >= 5_000)
  ) {
    const ratio = Math.max(
      exploration.freshSharePercent,
      exploration.sharePercent,
    );
    const savTokens = Math.round(exploration.freshTokens * 0.3);
    const estUsd = Math.round(savTokens * avgCostPerFreshToken * 10_000) / 10_000;
    const estCredits = usdToDeciCredits(estUsd) / 10;
    insights.push({
      id: "high_exploration_ratio",
      severity: ratio >= 65 ? "warning" : "opportunity",
      title: "High Exploration-to-Execution Ratio",
      detail: `Exploration & reads consume ${ratio}% (${exploration.freshTokens.toLocaleString()} fresh tokens across ${exploration.toolCalls} tool calls).`,
      recommendation:
        "Use targeted symbol/grep searches and narrow StartLine/EndLine reads, or consult workspace quickrefs before broad file scans.",
      metricValue: round1(ratio),
      metricUnit: "%",
      ...(savTokens > 0 ? { estimatedSavingsTokens: savTokens } : {}),
      ...(estCredits > 0 ? { estimatedSavingsCredits: estCredits } : {}),
      ...(estUsd > 0 ? { estimatedSavingsUsd: estUsd } : {}),
    });
  }

  // 3. heavy_shell_output
  const shell = catMap.get("shell_build_tests");
  if (
    shell &&
    shell.toolCalls >= 2 &&
    (shell.freshSharePercent >= 35 ||
      shell.sharePercent >= 35 ||
      shell.totalTokens >= 50_000)
  ) {
    const ratio = Math.max(shell.freshSharePercent, shell.sharePercent);
    const byPct = ratio >= 35;
    const savTokens = Math.round(shell.freshTokens * 0.4);
    const estUsd = Math.round(savTokens * avgCostPerFreshToken * 10_000) / 10_000;
    const estCredits = usdToDeciCredits(estUsd) / 10;
    insights.push({
      id: "heavy_shell_output",
      severity:
        ratio >= 55 || shell.totalTokens >= 100_000 ? "warning" : "opportunity",
      title: "Heavy Shell & Test Output Footprint",
      detail: `Shell, build & test commands account for ${ratio}% (${shell.totalTokens.toLocaleString()} tokens across ${shell.toolCalls} calls).`,
      recommendation:
        "Pipe verbose command logs through --quiet, head/tail, or targeted test filters instead of ingesting full stdout.",
      metricValue: byPct ? round1(ratio) : shell.totalTokens,
      metricUnit: byPct ? "%" : "tokens",
      ...(savTokens > 0 ? { estimatedSavingsTokens: savTokens } : {}),
      ...(estCredits > 0 ? { estimatedSavingsCredits: estCredits } : {}),
      ...(estUsd > 0 ? { estimatedSavingsUsd: estUsd } : {}),
    });
  }

  // 4. reasoning_tier_on_routine_work
  const routineCategories = new Set<WorkCategoryId>([
    "exploration_reads",
    "shell_build_tests",
    "board_mcp_workflow",
  ]);
  const routineReasoningAgents = byAgent.filter(
    (a) =>
      a.tier === "reasoning" &&
      (a.totalTokens >= 4_000 || a.toolCalls >= 4) &&
      routineCategories.has(a.dominantCategory),
  );
  if (routineReasoningAgents.length > 0) {
    const totalReasonTok = routineReasoningAgents.reduce(
      (s, a) => s + a.totalTokens,
      0,
    );
    const totalReasonUsd = routineReasoningAgents.reduce(
      (s, a) => s + a.costUsd,
      0,
    );
    const fastPricing = resolveModelPricing("fast-default");
    const avgCurCost =
      totalReasonTok > 0
        ? totalReasonUsd
        : 0;
    const estFastUsd =
      routineReasoningAgents.reduce(
        (s, a) =>
          s +
          estimateCostUsd(
            {
              uncachedInputTokens: a.uncachedInputTokens,
              cacheReadTokens: a.cacheReadTokens,
              cacheWriteTokens: a.cacheWriteTokens,
              outputTokens: a.outputTokens,
            },
            fastPricing,
          ),
        0,
      );
    const savUsd = Math.max(0, Math.round((avgCurCost - estFastUsd) * 10_000) / 10_000);
    const savCredits = usdToDeciCredits(savUsd) / 10;
    const pctOfSession =
      composition.totalTokens > 0
        ? round1((totalReasonTok / composition.totalTokens) * 100)
        : 100;

    insights.push({
      id: "reasoning_tier_on_routine_work",
      severity: savCredits >= 5 ? "warning" : "opportunity",
      title: "Reasoning-Tier Model on Routine Work",
      detail: `${routineReasoningAgents.map((a) => a.label).join(", ")} spent ${totalReasonTok.toLocaleString()} tokens on predominantly ${WORK_CATEGORY_LABELS[routineReasoningAgents[0]!.dominantCategory].toLowerCase()}.`,
      recommendation:
        "Route read/search, shell execution, and routine board checks to a fast or balanced tier model.",
      metricValue: pctOfSession,
      metricUnit: "%",
      ...(savCredits > 0 ? { estimatedSavingsCredits: savCredits } : {}),
      ...(savUsd > 0 ? { estimatedSavingsUsd: savUsd } : {}),
      affectedAgentIds: routineReasoningAgents.map((a) => a.agentId),
    });
  }

  // 5. orchestrator_context_bloat
  const rootEntry =
    byAgent.find((a) => a.agentId === "root" || a.agentId === "orchestrator") ??
    byAgent[0];
  if (rootEntry) {
    const rootCtxPct = agentContextPercents.get(rootEntry.agentId) ?? 0;
    const bloatedByContext = rootCtxPct >= 50;
    const bloatedByConcentration =
      byAgent.length > 1 &&
      rootEntry.sharePercent >= 65 &&
      rootEntry.totalTokens >= 20_000;
    if (bloatedByContext || bloatedByConcentration) {
      const metricVal = bloatedByContext ? rootCtxPct : rootEntry.sharePercent;
      const savTokens = Math.round(rootEntry.freshTokens * 0.25);
      const estUsd =
        Math.round(savTokens * avgCostPerFreshToken * 10_000) / 10_000;
      const estCredits = usdToDeciCredits(estUsd) / 10;
      insights.push({
        id: "orchestrator_context_bloat",
        severity:
          rootCtxPct >= 65 || rootEntry.sharePercent >= 80
            ? "warning"
            : "opportunity",
        title: "Orchestrator Context Concentration",
        detail: bloatedByContext
          ? `${rootEntry.label} reached ${rootCtxPct}% context window utilization (${rootEntry.sharePercent}% of session tokens).`
          : `${rootEntry.label} consumed ${rootEntry.sharePercent}% of tokens across a ${byAgent.length}-agent session.`,
        recommendation:
          "Delegate multi-file exploration and implementation to scoped subagents with capped outputs, and hand off before 55% drift.",
        metricValue: round1(metricVal),
        metricUnit: "%",
        ...(savTokens > 0 ? { estimatedSavingsTokens: savTokens } : {}),
        ...(estCredits > 0 ? { estimatedSavingsCredits: estCredits } : {}),
        ...(estUsd > 0 ? { estimatedSavingsUsd: estUsd } : {}),
        affectedAgentIds: [rootEntry.agentId],
      });
    }
  }

  // 6. repeated_tool_churn
  const repeatCounts = new Map<string, number>();
  const errorCounts = new Map<string, number>();
  for (const ev of events) {
    if (ev.kind === "tool_start" && ev.toolName) {
      const sig = normalizeChurnSignature(ev);
      repeatCounts.set(sig, (repeatCounts.get(sig) ?? 0) + 1);
    }
    if ((ev.kind === "tool_start" || ev.kind === "tool_end") && isErrorEvent(ev) && ev.toolName) {
      const errKey = `${ev.agentId}::${ev.toolName.trim().toLowerCase()}`;
      errorCounts.set(errKey, (errorCounts.get(errKey) ?? 0) + 1);
    }
  }
  const churnAgents = new Set<string>();
  let redundantCalls = 0;
  let maxRepeat = 0;
  let maxErrors = 0;
  for (const [sig, count] of repeatCounts.entries()) {
    if (count >= 4) {
      redundantCalls += count - 1;
      maxRepeat = Math.max(maxRepeat, count);
      churnAgents.add(sig.split("::")[0]!);
    }
  }
  for (const [errKey, count] of errorCounts.entries()) {
    if (count >= 3) {
      redundantCalls += count;
      maxErrors = Math.max(maxErrors, count);
      churnAgents.add(errKey.split("::")[0]!);
    }
  }
  if (redundantCalls > 0) {
    insights.push({
      id: "repeated_tool_churn",
      severity:
        maxRepeat >= 6 || maxErrors >= 4 ? "warning" : "opportunity",
      title: "Repeated Tool Call & Error Churn",
      detail: `Detected ${redundantCalls} redundant or repeatedly failing tool calls (${maxRepeat > 0 ? `up to ${maxRepeat} identical repeats` : `${maxErrors} repeated tool failures`}).`,
      recommendation:
        "Reuse prior tool results within the session and pause to inspect root errors before retrying failing calls.",
      metricValue: redundantCalls,
      metricUnit: "count",
      ...(churnAgents.size > 0 ? { affectedAgentIds: [...churnAgents] } : {}),
    });
  }

  return insights;
}

/**
 * Computes per-agent pricing/credits/reasoning and full SessionUsageBreakdown in
 * a single O(N) pass over already-normalized events with zero extra disk I/O.
 */
export function computeSessionBreakdown(params: {
  agents: readonly AgentBreakdownInput[];
  events: readonly EnrichedEvent[];
  modelCatalog?: readonly ModelCatalogEntry[] | ModelIndex;
}): ComputeSessionBreakdownResult {
  const { agents, events, modelCatalog } = params;
  const agentExtras = new Map<string, ComputedAgentBreakdownExtras>();
  const sessionCatMap = new Map<WorkCategoryId, MutableCatAcc>();
  const agentContextPercents = new Map<string, number>();

  const modelBuckets = new Map<
    string,
    {
      model: string;
      tier: ModelTier;
      agentCount: number;
      totalTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      reasoningTokens: number;
      microUsd: number;
      deciCredits: number;
      exactCosts: number;
      estCosts: number;
      premiumMultiplier?: number;
      premiumRequests?: number;
    }
  >();

  const tierBuckets = new Map<
    ModelTier,
    {
      tier: ModelTier;
      agentCount: number;
      models: Set<string>;
      totalTokens: number;
      freshTokens: number;
      microUsd: number;
      deciCredits: number;
      premiumRequests?: number;
    }
  >();

  const byAgentEntries: AgentBreakdownEntry[] = [];

  let totalUncachedIn = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalNonReasonOut = 0;
  let totalReasoning = 0;
  let totalTokens = 0;
  let totalFresh = 0;
  let anyAgentHasCacheSplit = false;
  let anyCachedAgentMissingSplit = false;
  let exactReasoningAgents = 0;
  let estimatedReasoningAgents = 0;
  let exactCostAgents = 0;
  let estimatedCostAgents = 0;
  let totalMicroUsd = 0;
  let totalDeciCredits = 0;
  let totalTurns = 0;
  let totalPremiumRequests: number | undefined;

  for (const ag of agents) {
    agentContextPercents.set(ag.agentId, ag.contextPercent);
    const pricing = resolveModelPricing(ag.model, ag.ide, modelCatalog);

    let reasoningTokens = 0;
    let reasoningSource: ReasoningSource = "none";
    if (ag.hasExactReasoning) {
      reasoningTokens = Math.min(
        ag.outputTokens,
        Math.max(0, ag.reasoningTokens ?? 0),
      );
      reasoningSource = "exact";
      exactReasoningAgents += 1;
    } else if (ag.thinkingChars > 0) {
      reasoningTokens = Math.min(
        ag.outputTokens,
        Math.round(ag.thinkingChars / 4),
      );
      reasoningSource = "estimated";
      estimatedReasoningAgents += 1;
    }

    const nonReasoningOutputTokens = Math.max(
      0,
      ag.outputTokens - reasoningTokens,
    );
    const effectiveCacheRead = ag.hasCacheSplit
      ? (ag.cacheReadTokens ?? 0)
      : ag.cachedTokens;
    const effectiveCacheWrite = ag.hasCacheSplit
      ? (ag.cacheWriteTokens ?? 0)
      : 0;

    if (ag.hasCacheSplit) {
      anyAgentHasCacheSplit = true;
    } else if (ag.cachedTokens > 0) {
      anyCachedAgentMissingSplit = true;
    }

    const agTotalTokens =
      ag.inputTokens +
      effectiveCacheRead +
      effectiveCacheWrite +
      nonReasoningOutputTokens +
      reasoningTokens;
    const agFreshTokens = ag.inputTokens + ag.outputTokens;

    const costSource: UsageSource =
      ag.costUsd !== undefined ? "exact" : "estimated";
    if (costSource === "exact") {
      exactCostAgents += 1;
    } else {
      estimatedCostAgents += 1;
    }

    const rawCostUsd =
      ag.costUsd !== undefined
        ? ag.costUsd
        : estimateCostUsd(
            {
              uncachedInputTokens: ag.inputTokens,
              cacheReadTokens: effectiveCacheRead,
              cacheWriteTokens: effectiveCacheWrite,
              outputTokens: ag.outputTokens,
            },
            pricing,
          );
    const agMicroUsd = Math.max(0, Math.round(rawCostUsd * 1_000_000));
    const agDeciCredits = usdToDeciCredits(rawCostUsd);
    const agCostUsd = agMicroUsd / 1_000_000;
    const agCredits = agDeciCredits / 10;

    const premiumRequests =
      (ag.ide === "copilot-vscode" || pricing.premiumMultiplier !== undefined) &&
      pricing.premiumMultiplier !== undefined
        ? computePremiumRequests(ag.turns, pricing.premiumMultiplier)
        : undefined;

    // Build per-agent category partition with zero drift
    const agCatMap = new Map<WorkCategoryId, MutableCatAcc>();
    const perTurnUsageEvents = !ag.hadIsTotalUsage
      ? ag.events.filter(
          (ev) =>
            ev.usageDelta &&
            !ev.usageDelta.isTotal &&
            (typeof ev.usageDelta.inputTokens === "number" ||
              typeof ev.usageDelta.outputTokens === "number" ||
              typeof ev.usageDelta.cachedTokens === "number"),
        )
      : [];

    const catWeights = new Map<WorkCategoryId, number>();
    for (const ev of ag.events) {
      const cat = classifyEventWorkCategory(ev);
      const cAcc = ensureCatAcc(agCatMap, cat);
      cAcc.eventCount += 1;
      if (
        ev.kind === "tool_start" ||
        ev.kind === "board_mutation" ||
        ev.kind === "subagent_spawn"
      ) {
        cAcc.toolCalls += 1;
      }
      if (isErrorEvent(ev)) {
        cAcc.errorCount += 1;
      }
      if (ev.toolName && (ev.kind === "tool_start" || ev.kind === "board_mutation")) {
        const t = ev.toolName.trim();
        cAcc.toolFreq.set(t, (cAcc.toolFreq.get(t) ?? 0) + 1);
      }
      catWeights.set(cat, (catWeights.get(cat) ?? 0) + computeEventWeight(ev));
    }

    if (perTurnUsageEvents.length > 0) {
      let assignedReasoning = 0;
      for (const ev of perTurnUsageEvents) {
        const u = ev.usageDelta!;
        const cat = classifyEventWorkCategory(ev);
        const cAcc = ensureCatAcc(agCatMap, cat);
        const inTok = Math.max(0, Math.round(u.inputTokens ?? 0));
        const outTok = Math.max(0, Math.round(u.outputTokens ?? 0));
        const evCached = Math.max(0, Math.round(u.cachedTokens ?? 0));
        const evCacheRead = ag.hasCacheSplit
          ? Math.max(0, Math.round(u.cacheReadTokens ?? evCached))
          : evCached;
        const evCacheWrite = ag.hasCacheSplit
          ? Math.max(0, Math.round(u.cacheWriteTokens ?? 0))
          : 0;
        const evReason =
          typeof u.reasoningTokens === "number"
            ? Math.min(outTok, Math.max(0, Math.round(u.reasoningTokens)))
            : 0;
        const evNonReasonOut = Math.max(0, outTok - evReason);

        cAcc.uncachedInputTokens += inTok;
        cAcc.cacheReadTokens += evCacheRead;
        cAcc.cacheWriteTokens += evCacheWrite;
        cAcc.nonReasoningOutputTokens += evNonReasonOut;
        cAcc.attributions.add(
          u.usageSource === "exact" ? "exact" : ag.usageSource === "exact" ? "exact" : "estimated",
        );

        if (evReason > 0) {
          const rAcc = ensureCatAcc(agCatMap, "reasoning_planning");
          rAcc.reasoningTokens += evReason;
          rAcc.attributions.add(
            u.reasoningSource === "exact" ? "exact" : "attributed",
          );
          assignedReasoning += evReason;
        }
      }
      const remainingReasoning = Math.max(0, reasoningTokens - assignedReasoning);
      if (remainingReasoning > 0) {
        const rAcc = ensureCatAcc(agCatMap, "reasoning_planning");
        const takeFromCat = Math.min(
          remainingReasoning,
          rAcc.nonReasoningOutputTokens,
        );
        if (takeFromCat > 0) {
          rAcc.nonReasoningOutputTokens -= takeFromCat;
          rAcc.reasoningTokens += takeFromCat;
        }
        const stillRem = remainingReasoning - takeFromCat;
        if (stillRem > 0) {
          const donors = [...agCatMap.values()].filter(
            (c) => c.nonReasoningOutputTokens > 0,
          );
          const taken = allocateHamilton(
            stillRem,
            donors.map((d) => d.nonReasoningOutputTokens),
          );
          for (let i = 0; i < donors.length; i++) {
            const sub = Math.min(
              donors[i]!.nonReasoningOutputTokens,
              taken[i]!,
            );
            donors[i]!.nonReasoningOutputTokens -= sub;
            rAcc.reasoningTokens += sub;
          }
        }
        rAcc.attributions.add(
          reasoningSource === "exact" ? "exact" : "attributed",
        );
      }
    } else {
      if (agCatMap.size === 0 && agTotalTokens > 0) {
        ensureCatAcc(agCatMap, "conversation_overhead");
        catWeights.set("conversation_overhead", 1);
      }
      const activeCats = [...agCatMap.keys()].filter(
        (c) => (catWeights.get(c) ?? 0) > 0,
      );
      if (activeCats.length > 0) {
        const weights = activeCats.map((c) => catWeights.get(c)!);
        const allocIn = allocateHamilton(ag.inputTokens, weights);
        const allocCR = allocateHamilton(effectiveCacheRead, weights);
        const allocCW = allocateHamilton(effectiveCacheWrite, weights);
        const allocNonROut = allocateHamilton(nonReasoningOutputTokens, weights);
        const attr: BreakdownAttribution =
          ag.usageSource === "exact" ? "attributed" : "estimated";
        for (let i = 0; i < activeCats.length; i++) {
          const cAcc = agCatMap.get(activeCats[i]!)!;
          cAcc.uncachedInputTokens += allocIn[i]!;
          cAcc.cacheReadTokens += allocCR[i]!;
          cAcc.cacheWriteTokens += allocCW[i]!;
          cAcc.nonReasoningOutputTokens += allocNonROut[i]!;
          cAcc.attributions.add(attr);
        }
      }
      if (reasoningTokens > 0) {
        const rAcc = ensureCatAcc(agCatMap, "reasoning_planning");
        rAcc.reasoningTokens += reasoningTokens;
        rAcc.attributions.add(
          reasoningSource === "exact" ? "exact" : "attributed",
        );
      }
    }

    // Distribute agent microUsd & deciCredits across agent's categories with zero drift
    const costCats = [...agCatMap.values()];
    if (costCats.length > 0) {
      const costWeights = costCats.map((c) => {
        const w = estimateCostUsd(
          {
            uncachedInputTokens: c.uncachedInputTokens,
            cacheReadTokens: c.cacheReadTokens,
            cacheWriteTokens: c.cacheWriteTokens,
            outputTokens: c.nonReasoningOutputTokens + c.reasoningTokens,
          },
          pricing,
        );
        return w > 0 ? w : c.eventCount;
      });
      const allocMicro = allocateHamilton(agMicroUsd, costWeights);
      const allocDeci = allocateHamilton(agDeciCredits, costWeights);
      for (let i = 0; i < costCats.length; i++) {
        costCats[i]!.microUsd += allocMicro[i]!;
        costCats[i]!.deciCredits += allocDeci[i]!;
      }
    }

    // Determine dominantCategory for this agent and merge into session categories
    let dominantCategory: WorkCategoryId = "conversation_overhead";
    let bestCatScore = -1;
    let bestCatFresh = -1;
    let bestCatEvents = -1;

    for (const cAcc of agCatMap.values()) {
      const cOut = cAcc.nonReasoningOutputTokens + cAcc.reasoningTokens;
      const cTotal =
        cAcc.uncachedInputTokens +
        cAcc.cacheReadTokens +
        cAcc.cacheWriteTokens +
        cOut;
      const cFresh = cAcc.uncachedInputTokens + cOut;
      if (
        cTotal > bestCatScore ||
        (cTotal === bestCatScore && cFresh > bestCatFresh) ||
        (cTotal === bestCatScore &&
          cFresh === bestCatFresh &&
          cAcc.eventCount > bestCatEvents)
      ) {
        bestCatScore = cTotal;
        bestCatFresh = cFresh;
        bestCatEvents = cAcc.eventCount;
        dominantCategory = cAcc.category;
      }

      const sAcc = ensureCatAcc(sessionCatMap, cAcc.category);
      sAcc.uncachedInputTokens += cAcc.uncachedInputTokens;
      sAcc.cacheReadTokens += cAcc.cacheReadTokens;
      sAcc.cacheWriteTokens += cAcc.cacheWriteTokens;
      sAcc.nonReasoningOutputTokens += cAcc.nonReasoningOutputTokens;
      sAcc.reasoningTokens += cAcc.reasoningTokens;
      sAcc.microUsd += cAcc.microUsd;
      sAcc.deciCredits += cAcc.deciCredits;
      sAcc.eventCount += cAcc.eventCount;
      sAcc.toolCalls += cAcc.toolCalls;
      sAcc.errorCount += cAcc.errorCount;
      for (const [tool, cnt] of cAcc.toolFreq.entries()) {
        sAcc.toolFreq.set(tool, (sAcc.toolFreq.get(tool) ?? 0) + cnt);
      }
      for (const a of cAcc.attributions) {
        sAcc.attributions.add(a);
      }
    }

    const agInputFootprint =
      ag.inputTokens + effectiveCacheRead + effectiveCacheWrite;
    const agCacheHitRate =
      agInputFootprint > 0
        ? round1((effectiveCacheRead / agInputFootprint) * 100)
        : 0;

    byAgentEntries.push({
      agentId: ag.agentId,
      label: ag.label,
      role: ag.role,
      model: ag.model,
      tier: pricing.tier,
      usageSource: ag.usageSource,
      costSource,
      uncachedInputTokens: ag.inputTokens,
      cacheReadTokens: effectiveCacheRead,
      cacheWriteTokens: effectiveCacheWrite,
      outputTokens: ag.outputTokens,
      reasoningTokens,
      freshTokens: agFreshTokens,
      totalTokens: agTotalTokens,
      sharePercent: 0, // Backfilled once session totalTokens is known
      cacheHitRate: agCacheHitRate,
      costUsd: agCostUsd,
      credits: agCredits,
      ...(premiumRequests !== undefined ? { premiumRequests } : {}),
      toolCalls: ag.toolCalls,
      turns: ag.turns,
      dominantCategory,
    });

    agentExtras.set(ag.agentId, {
      tier: pricing.tier,
      ...(ag.hasCacheSplit
        ? {
            cacheReadTokens: effectiveCacheRead,
            cacheWriteTokens: effectiveCacheWrite,
          }
        : {}),
      reasoningTokens,
      reasoningSource,
      costUsd: agCostUsd,
      costSource,
      credits: agCredits,
      creditSource: costSource,
      ...(pricing.premiumMultiplier !== undefined
        ? { premiumMultiplier: pricing.premiumMultiplier }
        : {}),
      ...(premiumRequests !== undefined ? { premiumRequests } : {}),
      turns: ag.turns,
      dominantCategory,
    });

    // Model bucket accumulation
    const mAcc = modelBuckets.get(ag.model);
    if (mAcc) {
      mAcc.agentCount += 1;
      mAcc.totalTokens += agTotalTokens;
      mAcc.cacheReadTokens += effectiveCacheRead;
      mAcc.cacheWriteTokens += effectiveCacheWrite;
      mAcc.reasoningTokens += reasoningTokens;
      mAcc.microUsd += agMicroUsd;
      mAcc.deciCredits += agDeciCredits;
      if (costSource === "exact") mAcc.exactCosts += 1;
      else mAcc.estCosts += 1;
      if (premiumRequests !== undefined) {
        mAcc.premiumRequests = round2(
          (mAcc.premiumRequests ?? 0) + premiumRequests,
        );
      }
    } else {
      modelBuckets.set(ag.model, {
        model: ag.model,
        tier: pricing.tier,
        agentCount: 1,
        totalTokens: agTotalTokens,
        cacheReadTokens: effectiveCacheRead,
        cacheWriteTokens: effectiveCacheWrite,
        reasoningTokens,
        microUsd: agMicroUsd,
        deciCredits: agDeciCredits,
        exactCosts: costSource === "exact" ? 1 : 0,
        estCosts: costSource === "estimated" ? 1 : 0,
        ...(pricing.premiumMultiplier !== undefined
          ? { premiumMultiplier: pricing.premiumMultiplier }
          : {}),
        ...(premiumRequests !== undefined ? { premiumRequests } : {}),
      });
    }

    // Tier bucket accumulation
    const tAcc = tierBuckets.get(pricing.tier);
    if (tAcc) {
      tAcc.agentCount += 1;
      tAcc.models.add(ag.model);
      tAcc.totalTokens += agTotalTokens;
      tAcc.freshTokens += agFreshTokens;
      tAcc.microUsd += agMicroUsd;
      tAcc.deciCredits += agDeciCredits;
      if (premiumRequests !== undefined) {
        tAcc.premiumRequests = round2(
          (tAcc.premiumRequests ?? 0) + premiumRequests,
        );
      }
    } else {
      tierBuckets.set(pricing.tier, {
        tier: pricing.tier,
        agentCount: 1,
        models: new Set([ag.model]),
        totalTokens: agTotalTokens,
        freshTokens: agFreshTokens,
        microUsd: agMicroUsd,
        deciCredits: agDeciCredits,
        ...(premiumRequests !== undefined ? { premiumRequests } : {}),
      });
    }

    totalUncachedIn += ag.inputTokens;
    totalCacheRead += effectiveCacheRead;
    totalCacheWrite += effectiveCacheWrite;
    totalNonReasonOut += nonReasoningOutputTokens;
    totalReasoning += reasoningTokens;
    totalTokens += agTotalTokens;
    totalFresh += agFreshTokens;
    totalMicroUsd += agMicroUsd;
    totalDeciCredits += agDeciCredits;
    totalTurns += ag.turns;
    if (premiumRequests !== undefined) {
      totalPremiumRequests = round2(
        (totalPremiumRequests ?? 0) + premiumRequests,
      );
    }
  }

  for (const entry of byAgentEntries) {
    entry.sharePercent =
      totalTokens > 0
        ? Math.min(100, round1((entry.totalTokens / totalTokens) * 100))
        : 0;
  }
  byAgentEntries.sort(
    (a, b) =>
      b.totalTokens - a.totalTokens || a.agentId.localeCompare(b.agentId),
  );

  const byCategory: CategoryUsageBucket[] = [...sessionCatMap.values()]
    .map((c) => {
      const outputTokens = c.nonReasoningOutputTokens + c.reasoningTokens;
      const catTotal =
        c.uncachedInputTokens +
        c.cacheReadTokens +
        c.cacheWriteTokens +
        outputTokens;
      const catFresh = c.uncachedInputTokens + outputTokens;
      const topTools = [...c.toolFreq.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([t]) => t);
      return {
        category: c.category,
        label: WORK_CATEGORY_LABELS[c.category],
        attribution: mergeAttributions(c.attributions),
        uncachedInputTokens: c.uncachedInputTokens,
        cacheReadTokens: c.cacheReadTokens,
        cacheWriteTokens: c.cacheWriteTokens,
        outputTokens,
        reasoningTokens: c.reasoningTokens,
        freshTokens: catFresh,
        totalTokens: catTotal,
        sharePercent:
          totalTokens > 0
            ? Math.min(100, round1((catTotal / totalTokens) * 100))
            : 0,
        freshSharePercent:
          totalFresh > 0
            ? Math.min(100, round1((catFresh / totalFresh) * 100))
            : 0,
        costUsd: c.microUsd / 1_000_000,
        credits: c.deciCredits / 10,
        eventCount: c.eventCount,
        toolCalls: c.toolCalls,
        errorCount: c.errorCount,
        topTools,
      };
    })
    .sort(
      (a, b) =>
        b.totalTokens - a.totalTokens ||
        b.eventCount - a.eventCount ||
        a.category.localeCompare(b.category),
    );

  const byModel: ModelUsageBucket[] = [...modelBuckets.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens || b.agentCount - a.agentCount)
    .map((m) => {
      const mCostSrc: SessionUsageSource =
        m.exactCosts > 0 && m.estCosts > 0
          ? "mixed"
          : m.exactCosts > 0
            ? "exact"
            : "estimated";
      return {
        model: m.model,
        agentCount: m.agentCount,
        totalTokens: m.totalTokens,
        sharePercent:
          totalTokens > 0
            ? Math.min(100, round1((m.totalTokens / totalTokens) * 100))
            : 0,
        tier: m.tier,
        cacheReadTokens: m.cacheReadTokens,
        cacheWriteTokens: m.cacheWriteTokens,
        reasoningTokens: m.reasoningTokens,
        costUsd: m.microUsd / 1_000_000,
        costSource: mCostSrc,
        credits: m.deciCredits / 10,
        ...(m.premiumMultiplier !== undefined
          ? { premiumMultiplier: m.premiumMultiplier }
          : {}),
        ...(m.premiumRequests !== undefined
          ? { premiumRequests: m.premiumRequests }
          : {}),
      };
    });

  const byTier: TierUsageBucket[] = [...tierBuckets.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((t) => ({
      tier: t.tier,
      agentCount: t.agentCount,
      modelCount: t.models.size,
      totalTokens: t.totalTokens,
      freshTokens: t.freshTokens,
      sharePercent:
        totalTokens > 0
          ? Math.min(100, round1((t.totalTokens / totalTokens) * 100))
          : 0,
      costUsd: t.microUsd / 1_000_000,
      credits: t.deciCredits / 10,
      ...(t.premiumRequests !== undefined
        ? { premiumRequests: t.premiumRequests }
        : {}),
    }));

  const cacheSplitKnown =
    anyCachedAgentMissingSplit ? false : anyAgentHasCacheSplit;
  const totalInputFootprint =
    totalUncachedIn + totalCacheRead + totalCacheWrite;
  const cacheHitRate =
    totalInputFootprint > 0
      ? round1((totalCacheRead / totalInputFootprint) * 100)
      : 0;
  const effectiveMultiplier = round2(totalTokens / Math.max(1, totalFresh));
  const sessionReasoningSource: ReasoningSource =
    estimatedReasoningAgents > 0
      ? "estimated"
      : exactReasoningAgents > 0
        ? "exact"
        : "none";

  const composition: TokenCompositionBreakdown = {
    uncachedInputTokens: totalUncachedIn,
    cacheReadTokens: totalCacheRead,
    cacheWriteTokens: totalCacheWrite,
    nonReasoningOutputTokens: totalNonReasonOut,
    reasoningTokens: totalReasoning,
    totalTokens,
    freshTokens: totalFresh,
    cacheSplitKnown,
    cacheHitRate,
    effectiveMultiplier,
    reasoningSource: sessionReasoningSource,
  };

  const sessionCostUsd = totalMicroUsd / 1_000_000;
  const sessionCredits = totalDeciCredits / 10;
  const sessionCostSource: SessionUsageSource =
    exactCostAgents > 0 && estimatedCostAgents > 0
      ? "mixed"
      : exactCostAgents > 0
        ? "exact"
        : "estimated";

  const insights = detectEfficiencyInsights({
    composition,
    byCategory,
    byAgent: byAgentEntries,
    events,
    agentContextPercents,
    totalsCostUsd: sessionCostUsd,
  });

  const breakdown: SessionUsageBreakdown = {
    composition,
    byCategory,
    byAgent: byAgentEntries,
    byModel,
    byTier,
    insights,
    totals: {
      costUsd: sessionCostUsd,
      costSource: sessionCostSource,
      credits: sessionCredits,
      creditUnit: "compute_credits",
      creditSource: sessionCostSource,
      ...(totalPremiumRequests !== undefined
        ? { premiumRequests: totalPremiumRequests }
        : {}),
      turns: totalTurns,
    },
  };

  return {
    breakdown,
    agentExtras,
    sessionCacheReadTokens: totalCacheRead,
    sessionCacheWriteTokens: totalCacheWrite,
    sessionReasoningTokens: totalReasoning,
    sessionCostUsd,
    sessionCredits,
    sessionCreditSource: sessionCostSource,
    ...(totalPremiumRequests !== undefined
      ? { sessionPremiumRequests: totalPremiumRequests }
      : {}),
  };
}

/**
 * Filters or merges one or more RichSessionSnapshots into an aggregated
 * SessionUsageBreakdown (optionally scoped to a single `agentId`), preserving
 * zero-drift invariants and re-evaluating insights on the merged view.
 */
export function aggregateBreakdownsFromSnapshots(params: {
  snapshots: readonly RichSessionSnapshot[];
  agentId?: string;
  modelCatalog?: readonly ModelCatalogEntry[] | ModelIndex;
}): {
  summary: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    peakContextPercent: number;
    peakContextAgentId: string | null;
    usageSource: SessionUsageSource;
    costUsd: number;
    credits: number;
    creditSource: SessionUsageSource;
    premiumRequests?: number;
    models: ModelUsageBucket[];
  };
  breakdown: SessionUsageBreakdown;
} {
  const { snapshots, agentId, modelCatalog } = params;
  const targetAgentId = agentId?.trim() || undefined;

  // Fast path: 1 snapshot, no agent filter, and breakdown already computed
  if (
    snapshots.length === 1 &&
    !targetAgentId &&
    snapshots[0]!.usage?.breakdown
  ) {
    const u = snapshots[0]!.usage;
    const b = u.breakdown!;
    return {
      summary: {
        totalTokens: u.totalTokens,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cachedTokens: u.cachedTokens,
        cacheReadTokens: u.cacheReadTokens ?? b.composition.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens ?? b.composition.cacheWriteTokens,
        reasoningTokens: u.reasoningTokens ?? b.composition.reasoningTokens,
        peakContextPercent: u.peakContextPercent,
        peakContextAgentId: u.peakContextAgentId,
        usageSource: u.usageSource,
        costUsd: u.costUsd ?? b.totals.costUsd,
        credits: u.credits ?? b.totals.credits,
        creditSource: u.creditSource ?? b.totals.creditSource,
        ...(u.premiumRequests !== undefined
          ? { premiumRequests: u.premiumRequests }
          : {}),
        models: u.models,
      },
      breakdown: b,
    };
  }

  // Build unified AgentBreakdownInput[] across snapshots (if multi-session, merge by agentId!)
  // Actually, computing each snapshot's agent inputs and merging by agentId (preserving exact per-session pricing)
  // ensures zero-drift AND handles multi-session windows + agentId filters cleanly.
  const mergedCatMap = new Map<WorkCategoryId, MutableCatAcc>();
  const mergedAgentMap = new Map<
    string,
    {
      entry: AgentBreakdownEntry;
      microUsd: number;
      deciCredits: number;
      exactUsage: number;
      estUsage: number;
      exactCost: number;
      estCost: number;
      maxContextPct: number;
      modelsSeen: Set<string>;
      catTotals: Map<WorkCategoryId, number>;
    }
  >();
  const mergedModelMap = new Map<
    string,
    {
      model: string;
      tier: ModelTier;
      agents: Set<string>;
      totalTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      reasoningTokens: number;
      microUsd: number;
      deciCredits: number;
      exactCost: number;
      estCost: number;
      premiumMultiplier?: number;
      premiumRequests?: number;
    }
  >();
  const mergedTierMap = new Map<
    ModelTier,
    {
      tier: ModelTier;
      agents: Set<string>;
      models: Set<string>;
      totalTokens: number;
      freshTokens: number;
      microUsd: number;
      deciCredits: number;
      premiumRequests?: number;
    }
  >();

  const allEvents: EnrichedEvent[] = [];
  const agentContextPercents = new Map<string, number>();

  let totalUncachedIn = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalNonReasonOut = 0;
  let totalReasoning = 0;
  let totalTokens = 0;
  let totalFresh = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalMicroUsd = 0;
  let totalDeciCredits = 0;
  let totalTurns = 0;
  let totalPremiumRequests: number | undefined;

  let anyCacheSplitTrue = false;
  let anyCacheSplitFalseWithCached = false;
  let exactReasoningCount = 0;
  let estReasoningCount = 0;
  let exactUsageCount = 0;
  let estUsageCount = 0;
  let exactCostCount = 0;
  let estCostCount = 0;
  let peakContextPercent = 0;
  let peakContextAgentId: string | null = null;

  for (const snap of snapshots) {
    // Reconstruct per-snapshot breakdown if missing or filter by agentId
    let b = snap.usage?.breakdown;
    if (!b || targetAgentId) {
      const snapAgentNodes = snap.agents.filter(
        (a) =>
          a.nodeType === "agent" &&
          (!targetAgentId || a.id === targetAgentId),
      );
      const eventsByAgent = new Map<string, EnrichedEvent[]>();
      for (const ev of snap.events) {
        if (targetAgentId && ev.agentId !== targetAgentId) continue;
        let list = eventsByAgent.get(ev.agentId);
        if (!list) {
          list = [];
          eventsByAgent.set(ev.agentId, list);
        }
        list.push(ev);
      }
      const inputs: AgentBreakdownInput[] = snapAgentNodes.map((a) => {
        const u = a.usage;
        const agEvs = eventsByAgent.get(a.id) ?? [];
        const thinkingChars = agEvs.reduce(
          (s, e) => s + computeEventThinkingChars(e),
          0,
        );
        const turnEnds = agEvs.filter((e) => e.kind === "assistant_turn_end").length;
        const userIns = agEvs.filter((e) => e.kind === "user_input").length;
        const turns =
          u?.turns ??
          (turnEnds > 0 || userIns > 0
            ? Math.max(turnEnds, userIns)
            : a.steps > 0
              ? 1
              : 0);
        const hadIsTotal = agEvs.some((e) => e.usageDelta?.isTotal);
        return {
          agentId: a.id,
          label: a.label,
          role: a.role,
          ide: a.ide,
          isRoot: a.isRoot,
          model: u?.model ?? a.model ?? "Unknown",
          usageSource: u?.usageSource ?? "estimated",
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          cachedTokens: u?.cachedTokens ?? 0,
          cacheReadTokens: u?.cacheReadTokens,
          cacheWriteTokens: u?.cacheWriteTokens,
          hasCacheSplit:
            u?.cacheReadTokens !== undefined || u?.cacheWriteTokens !== undefined,
          reasoningTokens: u?.reasoningTokens,
          hasExactReasoning: u?.reasoningSource === "exact",
          hadIsTotalUsage: hadIsTotal,
          contextPercent: u?.contextPercent ?? 0,
          costUsd: u?.costUsd,
          toolCalls: a.toolCalls,
          turns,
          thinkingChars,
          events: agEvs,
        };
      });
      b = computeSessionBreakdown({
        agents: inputs,
        events: targetAgentId
          ? snap.events.filter((e) => e.agentId === targetAgentId)
          : snap.events,
        modelCatalog,
      }).breakdown;
    }

    const comp = b.composition;
    totalUncachedIn += comp.uncachedInputTokens;
    totalCacheRead += comp.cacheReadTokens;
    totalCacheWrite += comp.cacheWriteTokens;
    totalNonReasonOut += comp.nonReasoningOutputTokens;
    totalReasoning += comp.reasoningTokens;
    totalTokens += comp.totalTokens;
    totalFresh += comp.freshTokens;
    totalOutput += comp.nonReasoningOutputTokens + comp.reasoningTokens;
    totalCached += comp.cacheReadTokens + comp.cacheWriteTokens;
    if (comp.cacheSplitKnown) anyCacheSplitTrue = true;
    else if (comp.cacheReadTokens + comp.cacheWriteTokens > 0) {
      anyCacheSplitFalseWithCached = true;
    }
    if (comp.reasoningSource === "exact") exactReasoningCount += 1;
    else if (comp.reasoningSource === "estimated") estReasoningCount += 1;

    totalMicroUsd += Math.round(b.totals.costUsd * 1_000_000);
    totalDeciCredits += Math.round(b.totals.credits * 10);
    totalTurns += b.totals.turns;
    if (b.totals.premiumRequests !== undefined) {
      totalPremiumRequests = round2(
        (totalPremiumRequests ?? 0) + b.totals.premiumRequests,
      );
    }

    for (const ev of snap.events) {
      if (!targetAgentId || ev.agentId === targetAgentId) {
        allEvents.push(ev);
      }
    }

    for (const aNode of snap.agents) {
      if (aNode.nodeType !== "agent") continue;
      if (targetAgentId && aNode.id !== targetAgentId) continue;
      const pct = aNode.usage?.contextPercent ?? 0;
      const prev = agentContextPercents.get(aNode.id) ?? 0;
      if (pct > prev) agentContextPercents.set(aNode.id, pct);
      if (pct > peakContextPercent) {
        peakContextPercent = pct;
        peakContextAgentId = aNode.id;
      }
    }

    for (const cat of b.byCategory) {
      const mCat = ensureCatAcc(mergedCatMap, cat.category);
      mCat.uncachedInputTokens += cat.uncachedInputTokens;
      mCat.cacheReadTokens += cat.cacheReadTokens;
      mCat.cacheWriteTokens += cat.cacheWriteTokens;
      mCat.nonReasoningOutputTokens += Math.max(
        0,
        cat.outputTokens - cat.reasoningTokens,
      );
      mCat.reasoningTokens += cat.reasoningTokens;
      mCat.microUsd += Math.round(cat.costUsd * 1_000_000);
      mCat.deciCredits += Math.round(cat.credits * 10);
      mCat.eventCount += cat.eventCount;
      mCat.toolCalls += cat.toolCalls;
      mCat.errorCount += cat.errorCount;
      mCat.attributions.add(cat.attribution);
      for (const t of cat.topTools) {
        mCat.toolFreq.set(t, (mCat.toolFreq.get(t) ?? 0) + 1);
      }
    }

    for (const ag of b.byAgent) {
      if (targetAgentId && ag.agentId !== targetAgentId) continue;
      if (ag.usageSource === "exact") exactUsageCount += 1;
      else estUsageCount += 1;
      if (ag.costSource === "exact") exactCostCount += 1;
      else estCostCount += 1;

      const agMicro = Math.round(ag.costUsd * 1_000_000);
      const agDeci = Math.round(ag.credits * 10);

      const prev = mergedAgentMap.get(ag.agentId);
      if (prev) {
        prev.entry.uncachedInputTokens += ag.uncachedInputTokens;
        prev.entry.cacheReadTokens += ag.cacheReadTokens;
        prev.entry.cacheWriteTokens += ag.cacheWriteTokens;
        prev.entry.outputTokens += ag.outputTokens;
        prev.entry.reasoningTokens += ag.reasoningTokens;
        prev.entry.freshTokens += ag.freshTokens;
        prev.entry.totalTokens += ag.totalTokens;
        prev.microUsd += agMicro;
        prev.deciCredits += agDeci;
        prev.entry.costUsd = prev.microUsd / 1_000_000;
        prev.entry.credits = prev.deciCredits / 10;
        if (ag.premiumRequests !== undefined) {
          prev.entry.premiumRequests = round2(
            (prev.entry.premiumRequests ?? 0) + ag.premiumRequests,
          );
        }
        prev.entry.toolCalls += ag.toolCalls;
        prev.entry.turns += ag.turns;
        if (ag.usageSource === "exact") prev.exactUsage += 1;
        else prev.estUsage += 1;
        if (ag.costSource === "exact") prev.exactCost += 1;
        else prev.estCost += 1;
        prev.catTotals.set(
          ag.dominantCategory,
          (prev.catTotals.get(ag.dominantCategory) ?? 0) + ag.totalTokens,
        );
      } else {
        const catTotals = new Map<WorkCategoryId, number>();
        catTotals.set(ag.dominantCategory, ag.totalTokens);
        mergedAgentMap.set(ag.agentId, {
          entry: { ...ag },
          microUsd: agMicro,
          deciCredits: agDeci,
          exactUsage: ag.usageSource === "exact" ? 1 : 0,
          estUsage: ag.usageSource === "estimated" ? 1 : 0,
          exactCost: ag.costSource === "exact" ? 1 : 0,
          estCost: ag.costSource === "estimated" ? 1 : 0,
          maxContextPct: agentContextPercents.get(ag.agentId) ?? 0,
          modelsSeen: new Set([ag.model]),
          catTotals,
        });
      }

      const mKey = ag.model;
      const mPrev = mergedModelMap.get(mKey);
      const pm = resolveModelPricing(ag.model, undefined, modelCatalog).premiumMultiplier;
      if (mPrev) {
        mPrev.agents.add(ag.agentId);
        mPrev.totalTokens += ag.totalTokens;
        mPrev.cacheReadTokens += ag.cacheReadTokens;
        mPrev.cacheWriteTokens += ag.cacheWriteTokens;
        mPrev.reasoningTokens += ag.reasoningTokens;
        mPrev.microUsd += agMicro;
        mPrev.deciCredits += agDeci;
        if (ag.costSource === "exact") mPrev.exactCost += 1;
        else mPrev.estCost += 1;
        if (ag.premiumRequests !== undefined) {
          mPrev.premiumRequests = round2(
            (mPrev.premiumRequests ?? 0) + ag.premiumRequests,
          );
        }
      } else {
        mergedModelMap.set(mKey, {
          model: ag.model,
          tier: ag.tier,
          agents: new Set([ag.agentId]),
          totalTokens: ag.totalTokens,
          cacheReadTokens: ag.cacheReadTokens,
          cacheWriteTokens: ag.cacheWriteTokens,
          reasoningTokens: ag.reasoningTokens,
          microUsd: agMicro,
          deciCredits: agDeci,
          exactCost: ag.costSource === "exact" ? 1 : 0,
          estCost: ag.costSource === "estimated" ? 1 : 0,
          ...(pm !== undefined ? { premiumMultiplier: pm } : {}),
          ...(ag.premiumRequests !== undefined
            ? { premiumRequests: ag.premiumRequests }
            : {}),
        });
      }

      const tPrev = mergedTierMap.get(ag.tier);
      if (tPrev) {
        tPrev.agents.add(ag.agentId);
        tPrev.models.add(ag.model);
        tPrev.totalTokens += ag.totalTokens;
        tPrev.freshTokens += ag.freshTokens;
        tPrev.microUsd += agMicro;
        tPrev.deciCredits += agDeci;
        if (ag.premiumRequests !== undefined) {
          tPrev.premiumRequests = round2(
            (tPrev.premiumRequests ?? 0) + ag.premiumRequests,
          );
        }
      } else {
        mergedTierMap.set(ag.tier, {
          tier: ag.tier,
          agents: new Set([ag.agentId]),
          models: new Set([ag.model]),
          totalTokens: ag.totalTokens,
          freshTokens: ag.freshTokens,
          microUsd: agMicro,
          deciCredits: agDeci,
          ...(ag.premiumRequests !== undefined
            ? { premiumRequests: ag.premiumRequests }
            : {}),
        });
      }
    }
  }

  const byAgent: AgentBreakdownEntry[] = [...mergedAgentMap.values()]
    .map((m) => {
      const e = m.entry;
      const inp = e.uncachedInputTokens + e.cacheReadTokens + e.cacheWriteTokens;
      e.sharePercent =
        totalTokens > 0
          ? Math.min(100, round1((e.totalTokens / totalTokens) * 100))
          : 0;
      e.cacheHitRate = inp > 0 ? round1((e.cacheReadTokens / inp) * 100) : 0;
      e.usageSource = m.exactUsage > 0 && m.estUsage === 0 ? "exact" : "estimated";
      e.costSource = m.exactCost > 0 && m.estCost === 0 ? "exact" : "estimated";
      let domCat = e.dominantCategory;
      let domVal = -1;
      for (const [cat, val] of m.catTotals.entries()) {
        if (val > domVal) {
          domVal = val;
          domCat = cat;
        }
      }
      e.dominantCategory = domCat;
      return e;
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || a.agentId.localeCompare(b.agentId));

  const byCategory: CategoryUsageBucket[] = [...mergedCatMap.values()]
    .map((c) => {
      const outputTokens = c.nonReasoningOutputTokens + c.reasoningTokens;
      const catTotal =
        c.uncachedInputTokens +
        c.cacheReadTokens +
        c.cacheWriteTokens +
        outputTokens;
      const catFresh = c.uncachedInputTokens + outputTokens;
      const topTools = [...c.toolFreq.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([t]) => t);
      return {
        category: c.category,
        label: WORK_CATEGORY_LABELS[c.category],
        attribution: mergeAttributions(c.attributions),
        uncachedInputTokens: c.uncachedInputTokens,
        cacheReadTokens: c.cacheReadTokens,
        cacheWriteTokens: c.cacheWriteTokens,
        outputTokens,
        reasoningTokens: c.reasoningTokens,
        freshTokens: catFresh,
        totalTokens: catTotal,
        sharePercent:
          totalTokens > 0
            ? Math.min(100, round1((catTotal / totalTokens) * 100))
            : 0,
        freshSharePercent:
          totalFresh > 0
            ? Math.min(100, round1((catFresh / totalFresh) * 100))
            : 0,
        costUsd: c.microUsd / 1_000_000,
        credits: c.deciCredits / 10,
        eventCount: c.eventCount,
        toolCalls: c.toolCalls,
        errorCount: c.errorCount,
        topTools,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || b.eventCount - a.eventCount);

  const byModel: ModelUsageBucket[] = [...mergedModelMap.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens || b.agents.size - a.agents.size)
    .map((m) => ({
      model: m.model,
      agentCount: m.agents.size,
      totalTokens: m.totalTokens,
      sharePercent:
        totalTokens > 0
          ? Math.min(100, round1((m.totalTokens / totalTokens) * 100))
          : 0,
      tier: m.tier,
      cacheReadTokens: m.cacheReadTokens,
      cacheWriteTokens: m.cacheWriteTokens,
      reasoningTokens: m.reasoningTokens,
      costUsd: m.microUsd / 1_000_000,
      costSource:
        m.exactCost > 0 && m.estCost > 0
          ? "mixed"
          : m.exactCost > 0
            ? "exact"
            : "estimated",
      credits: m.deciCredits / 10,
      ...(m.premiumMultiplier !== undefined
        ? { premiumMultiplier: m.premiumMultiplier }
        : {}),
      ...(m.premiumRequests !== undefined
        ? { premiumRequests: m.premiumRequests }
        : {}),
    }));

  const byTier: TierUsageBucket[] = [...mergedTierMap.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((t) => ({
      tier: t.tier,
      agentCount: t.agents.size,
      modelCount: t.models.size,
      totalTokens: t.totalTokens,
      freshTokens: t.freshTokens,
      sharePercent:
        totalTokens > 0
          ? Math.min(100, round1((t.totalTokens / totalTokens) * 100))
          : 0,
      costUsd: t.microUsd / 1_000_000,
      credits: t.deciCredits / 10,
      ...(t.premiumRequests !== undefined
        ? { premiumRequests: t.premiumRequests }
        : {}),
    }));

  const cacheSplitKnown =
    anyCacheSplitFalseWithCached ? false : anyCacheSplitTrue;
  const totalInputFootprint =
    totalUncachedIn + totalCacheRead + totalCacheWrite;
  const cacheHitRate =
    totalInputFootprint > 0
      ? round1((totalCacheRead / totalInputFootprint) * 100)
      : 0;
  const effectiveMultiplier = round2(totalTokens / Math.max(1, totalFresh));
  const reasoningSource: ReasoningSource =
    estReasoningCount > 0
      ? "estimated"
      : exactReasoningCount > 0
        ? "exact"
        : "none";

  const composition: TokenCompositionBreakdown = {
    uncachedInputTokens: totalUncachedIn,
    cacheReadTokens: totalCacheRead,
    cacheWriteTokens: totalCacheWrite,
    nonReasoningOutputTokens: totalNonReasonOut,
    reasoningTokens: totalReasoning,
    totalTokens,
    freshTokens: totalFresh,
    cacheSplitKnown,
    cacheHitRate,
    effectiveMultiplier,
    reasoningSource,
  };

  const costUsd = totalMicroUsd / 1_000_000;
  const credits = totalDeciCredits / 10;
  const usageSource: SessionUsageSource =
    exactUsageCount > 0 && estUsageCount > 0
      ? "mixed"
      : exactUsageCount > 0
        ? "exact"
        : "estimated";
  const costSource: SessionUsageSource =
    exactCostCount > 0 && estCostCount > 0
      ? "mixed"
      : exactCostCount > 0
        ? "exact"
        : "estimated";

  const insights = detectEfficiencyInsights({
    composition,
    byCategory,
    byAgent,
    events: allEvents,
    agentContextPercents,
    totalsCostUsd: costUsd,
  });

  const breakdown: SessionUsageBreakdown = {
    composition,
    byCategory,
    byAgent,
    byModel,
    byTier,
    insights,
    totals: {
      costUsd,
      costSource,
      credits,
      creditUnit: "compute_credits",
      creditSource: costSource,
      ...(totalPremiumRequests !== undefined
        ? { premiumRequests: totalPremiumRequests }
        : {}),
      turns: totalTurns,
    },
  };

  return {
    summary: {
      totalTokens,
      inputTokens: totalUncachedIn,
      outputTokens: totalOutput,
      cachedTokens: totalCached,
      cacheReadTokens: totalCacheRead,
      cacheWriteTokens: totalCacheWrite,
      reasoningTokens: totalReasoning,
      peakContextPercent,
      peakContextAgentId,
      usageSource,
      costUsd,
      credits,
      creditSource: costSource,
      ...(totalPremiumRequests !== undefined
        ? { premiumRequests: totalPremiumRequests }
        : {}),
      models: byModel,
    },
    breakdown,
  };
}
