import { createHash } from "node:crypto";
import { z } from "zod";
import { ModelTierSchema } from "./model-index.js";

export const IDE_SOURCES = [
  "antigravity",
  "claude-code",
  "copilot-vscode",
  "mcp",
  "unknown",
] as const;
export const IdeSourceSchema = z.enum(IDE_SOURCES);
export type IdeSource = z.infer<typeof IdeSourceSchema>;

export const AGENT_STATUSES = [
  "THINKING",
  "WORKING",
  "WAITING",
  "BLOCKED",
  "DONE",
  "IDLE",
] as const;
export const AgentStatusSchema = z.enum(AGENT_STATUSES);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const EVENT_KINDS = [
  "session_start",
  "user_input",
  "thinking_start",
  "tool_start",
  "tool_end",
  "subagent_spawn",
  "subagent_done",
  "message",
  "board_mutation",
  "assistant_turn_end",
] as const;
export const EventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKindSchema>;

export const NormalizedEventSchema = z.object({
  id: z.string().min(1),
  ts: z.string().min(1),
  ide: IdeSourceSchema,
  sessionId: z.string().min(1),
  workspacePath: z.string().optional(),
  projectId: z.string().optional(),
  agentId: z.string().min(1),
  agentLabel: z.string().optional(),
  parentAgentId: z.string().optional(),
  kind: EventKindSchema,
  toolName: z.string().optional(),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  bodyLength: z.number().int().nonnegative().optional(),
  bodyTruncated: z.boolean().optional(),
});
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

export const ModelSourceSchema = z.enum([
  "exact",
  "inherited",
  "definition",
  "unknown",
]);
export type ModelSource = z.infer<typeof ModelSourceSchema>;

export const UsageSourceSchema = z.enum(["exact", "estimated"]);
export type UsageSource = z.infer<typeof UsageSourceSchema>;

export const SessionUsageSourceSchema = z.enum(["exact", "estimated", "mixed"]);
export type SessionUsageSource = z.infer<typeof SessionUsageSourceSchema>;

export const WORK_CATEGORY_IDS = [
  "exploration_reads",
  "code_editing",
  "shell_build_tests",
  "reasoning_planning",
  "orchestration_subagents",
  "board_mcp_workflow",
  "web_docs_external",
  "conversation_overhead",
] as const;
export const WorkCategoryIdSchema = z.enum(WORK_CATEGORY_IDS);
export type WorkCategoryId = z.infer<typeof WorkCategoryIdSchema>;

export const BreakdownAttributionSchema = z.enum([
  "exact",
  "attributed",
  "estimated",
]);
export type BreakdownAttribution = z.infer<typeof BreakdownAttributionSchema>;

export const ReasoningSourceSchema = z.enum(["exact", "estimated", "none"]);
export type ReasoningSource = z.infer<typeof ReasoningSourceSchema>;

export const TokenCompositionBreakdownSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  nonReasoningOutputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  freshTokens: z.number().int().nonnegative(),
  cacheSplitKnown: z.boolean(),
  cacheHitRate: z.number().min(0).max(100),
  effectiveMultiplier: z.number().min(0),
  reasoningSource: ReasoningSourceSchema,
});
export type TokenCompositionBreakdown = z.infer<
  typeof TokenCompositionBreakdownSchema
>;

export const CategoryUsageBucketSchema = z.object({
  category: WorkCategoryIdSchema,
  label: z.string().min(1),
  attribution: BreakdownAttributionSchema,
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  freshTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  sharePercent: z.number().min(0).max(100),
  freshSharePercent: z.number().min(0).max(100),
  costUsd: z.number().nonnegative(),
  credits: z.number().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  topTools: z.array(z.string()),
});
export type CategoryUsageBucket = z.infer<typeof CategoryUsageBucketSchema>;

export const AgentBreakdownEntrySchema = z.object({
  agentId: z.string().min(1),
  label: z.string().min(1),
  role: z.string(),
  model: z.string().min(1),
  tier: ModelTierSchema,
  usageSource: UsageSourceSchema,
  costSource: UsageSourceSchema,
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  freshTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  sharePercent: z.number().min(0).max(100),
  cacheHitRate: z.number().min(0).max(100),
  costUsd: z.number().nonnegative(),
  credits: z.number().nonnegative(),
  premiumRequests: z.number().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  dominantCategory: WorkCategoryIdSchema,
});
export type AgentBreakdownEntry = z.infer<typeof AgentBreakdownEntrySchema>;

export const TierUsageBucketSchema = z.object({
  tier: ModelTierSchema,
  agentCount: z.number().int().nonnegative(),
  modelCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  freshTokens: z.number().int().nonnegative(),
  sharePercent: z.number().min(0).max(100),
  costUsd: z.number().nonnegative(),
  credits: z.number().nonnegative(),
  premiumRequests: z.number().nonnegative().optional(),
});
export type TierUsageBucket = z.infer<typeof TierUsageBucketSchema>;

export const EfficiencyInsightSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["info", "opportunity", "warning"]),
  title: z.string().min(1),
  detail: z.string().min(1),
  recommendation: z.string().min(1),
  metricValue: z.number(),
  metricUnit: z.enum(["%", "tokens", "credits", "count"]),
  estimatedSavingsTokens: z.number().int().nonnegative().optional(),
  estimatedSavingsCredits: z.number().nonnegative().optional(),
  estimatedSavingsUsd: z.number().nonnegative().optional(),
  affectedAgentIds: z.array(z.string()).optional(),
});
export type EfficiencyInsight = z.infer<typeof EfficiencyInsightSchema>;

export const AgentUsageMetricsSchema = z.object({
  model: z.string().min(1),
  modelSource: ModelSourceSchema,
  usageSource: UsageSourceSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  contextTokens: z.number().int().nonnegative(),
  contextWindow: z.number().int().positive(),
  nominalContextWindow: z.number().int().positive().optional(),
  contextPercent: z.number().min(0).max(100),
  costUsd: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  reasoningSource: ReasoningSourceSchema.optional(),
  tier: ModelTierSchema.optional(),
  credits: z.number().nonnegative().optional(),
  creditSource: UsageSourceSchema.optional(),
  premiumMultiplier: z.number().nonnegative().optional(),
  premiumRequests: z.number().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
  dominantCategory: WorkCategoryIdSchema.optional(),
});
export type AgentUsageMetrics = z.infer<typeof AgentUsageMetricsSchema>;

export const ModelUsageBucketSchema = z.object({
  model: z.string().min(1),
  agentCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  sharePercent: z.number().min(0).max(100),
  tier: ModelTierSchema.optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  costSource: SessionUsageSourceSchema.optional(),
  credits: z.number().nonnegative().optional(),
  premiumMultiplier: z.number().nonnegative().optional(),
  premiumRequests: z.number().nonnegative().optional(),
});
export type ModelUsageBucket = z.infer<typeof ModelUsageBucketSchema>;

export const SessionUsageBreakdownTotalsSchema = z.object({
  costUsd: z.number().nonnegative(),
  costSource: SessionUsageSourceSchema,
  credits: z.number().nonnegative(),
  creditUnit: z.literal("compute_credits"),
  creditSource: SessionUsageSourceSchema,
  premiumRequests: z.number().nonnegative().optional(),
  turns: z.number().int().nonnegative(),
});
export type SessionUsageBreakdownTotals = z.infer<
  typeof SessionUsageBreakdownTotalsSchema
>;

export const SessionUsageBreakdownSchema = z.object({
  composition: TokenCompositionBreakdownSchema,
  byCategory: z.array(CategoryUsageBucketSchema),
  byAgent: z.array(AgentBreakdownEntrySchema),
  byModel: z.array(ModelUsageBucketSchema),
  byTier: z.array(TierUsageBucketSchema),
  insights: z.array(EfficiencyInsightSchema),
  totals: SessionUsageBreakdownTotalsSchema,
});
export type SessionUsageBreakdown = z.infer<typeof SessionUsageBreakdownSchema>;

export const SessionUsageSummarySchema = z.object({
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  peakContextPercent: z.number().min(0).max(100),
  peakContextAgentId: z.string().nullable(),
  usageSource: SessionUsageSourceSchema,
  costUsd: z.number().nonnegative().optional(),
  models: z.array(ModelUsageBucketSchema),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  credits: z.number().nonnegative().optional(),
  creditSource: SessionUsageSourceSchema.optional(),
  premiumRequests: z.number().nonnegative().optional(),
  breakdown: SessionUsageBreakdownSchema.optional(),
});
export type SessionUsageSummary = z.infer<typeof SessionUsageSummarySchema>;

export const AgentNodeSnapshotSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  parentAgentId: z.string().optional(),
  ide: IdeSourceSchema,
  status: AgentStatusSchema,
  activeTool: z.string().optional(),
  thinkingSince: z.string().optional(),
  lastEventAt: z.string().optional(),
  toolCalls: z.number().int().nonnegative().default(0),
  messagesSent: z.number().int().nonnegative().default(0),
  messagesReceived: z.number().int().nonnegative().default(0),
  summary: z.string().optional(),
  model: z.string().optional(),
  usage: AgentUsageMetricsSchema.optional(),
});
export type AgentNodeSnapshot = z.infer<typeof AgentNodeSnapshotSchema>;

export const AgentEdgeSnapshotSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  count: z.number().int().nonnegative(),
  lastKind: EventKindSchema.optional(),
  lastTs: z.string().optional(),
});
export type AgentEdgeSnapshot = z.infer<typeof AgentEdgeSnapshotSchema>;

export const SessionCountersSchema = z.object({
  totalEvents: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  boardMutations: z.number().int().nonnegative(),
  activeAgents: z.number().int().nonnegative(),
  completedAgents: z.number().int().nonnegative(),
});
export type SessionCounters = z.infer<typeof SessionCountersSchema>;

export const SessionTeamRosterEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  role: z.string().optional(),
});
export type SessionTeamRosterEntry = z.infer<typeof SessionTeamRosterEntrySchema>;

export const PendingQuestionOptionSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
});
export type PendingQuestionOption = z.infer<typeof PendingQuestionOptionSchema>;

export const PendingQuestionTypeSchema = z.enum([
  "single_select",
  "multi_select",
  "text",
]);
export type PendingQuestionType = z.infer<typeof PendingQuestionTypeSchema>;

export const PendingQuestionItemSchema = z.object({
  id: z.string().optional(),
  header: z.string().optional(),
  question: z.string(),
  type: PendingQuestionTypeSchema,
  options: z.array(PendingQuestionOptionSchema),
  allowCustomInput: z.boolean().optional(),
  defaultValue: z.string().optional(),
});
export type PendingQuestionItem = z.infer<typeof PendingQuestionItemSchema>;

export const PROMPT_SOURCES = [
  "native",
  "studio-mcp",
  "studio-vscode-lm",
] as const;
export const PromptSourceSchema = z.enum(PROMPT_SOURCES);
export type PromptSource = z.infer<typeof PromptSourceSchema>;

export const PROMPT_STATUSES = [
  "pending",
  "answered",
  "canceled",
  "expired",
] as const;
export const PromptStatusSchema = z.enum(PROMPT_STATUSES);
export type PromptStatus = z.infer<typeof PromptStatusSchema>;

export const PendingHumanPromptSchema = z.object({
  id: z.string(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  agentId: z.string(),
  agentLabel: z.string(),
  kind: z.enum(["question", "approval"]),
  title: z.string(),
  summary: z.string().optional(),
  questions: z.array(PendingQuestionItemSchema),
  options: z
    .array(
      z.object({
        label: z.string(),
        recommended: z.boolean().optional(),
      }),
    )
    .optional(),
  ts: z.string().optional(),
  blockingToolCall: z.boolean(),
  directReply: z.boolean().optional(),
  promptSource: PromptSourceSchema.optional(),
  status: PromptStatusSchema.optional(),
  answerText: z.string().optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().optional(),
  sessionId: z.string().optional(),
  workspacePath: z.string().optional(),
  ide: IdeSourceSchema.optional(),
});
export type PendingHumanPrompt = z.infer<typeof PendingHumanPromptSchema>;

export const PromptBridgeQuestionInputSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  header: z.string().max(120).optional(),
  question: z.string().trim().min(1).max(2000),
  type: PendingQuestionTypeSchema.optional(),
  options: z.array(PendingQuestionOptionSchema).max(25).optional(),
  allowCustomInput: z.boolean().optional(),
  defaultValue: z.string().max(2000).optional(),
});

export const PromptBridgeCreateSchema = z.object({
  title: z.string().max(140).optional(),
  summary: z.string().max(500).optional(),
  kind: z.enum(["question", "approval"]).optional(),
  questions: z.array(PromptBridgeQuestionInputSchema).min(1).max(10),
  agentId: z.string().min(1).max(120).optional(),
  agentLabel: z.string().min(1).max(120).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  workspacePath: z.string().min(1).max(1024).optional(),
  projectId: z.string().min(1).max(120).optional(),
  ide: IdeSourceSchema.optional(),
  toolName: z.string().min(1).max(120).optional(),
  toolCallId: z.string().min(1).max(200).optional(),
  promptSource: z.enum(["studio-mcp", "studio-vscode-lm"]).optional(),
  timeoutMs: z.number().int().min(5000).max(1_800_000).default(600_000),
});
export type PromptBridgeCreateInput = z.input<typeof PromptBridgeCreateSchema>;
export type PromptBridgeCreateParsed = z.infer<typeof PromptBridgeCreateSchema>;

export const PromptBridgeAnswerSchema = z.object({
  answerText: z.string().trim().min(1).max(32_768),
  answers: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
  responder: z.string().max(120).optional(),
});
export type PromptBridgeAnswerInput = z.infer<typeof PromptBridgeAnswerSchema>;

export const PromptBridgeCancelSchema = z.object({
  reason: z.string().max(512).optional(),
});
export type PromptBridgeCancelInput = z.infer<typeof PromptBridgeCancelSchema>;

export const SessionSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  ide: IdeSourceSchema,
  projectId: z.string().optional(),
  workspacePath: z.string().optional(),
  updatedAt: z.string().min(1),
  status: AgentStatusSchema,
  waitingOn: z.string().nullable().optional(),
  agents: z.array(AgentNodeSnapshotSchema),
  edges: z.array(AgentEdgeSnapshotSchema),
  events: z.array(NormalizedEventSchema),
  counters: SessionCountersSchema,
  usage: SessionUsageSummarySchema.optional(),
  teamRoster: z.array(SessionTeamRosterEntrySchema).optional(),
  modelContextWindows: z.record(z.string(), z.number().int().positive()).optional(),
  pendingPrompts: z.array(PendingHumanPromptSchema).optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

export function createDeterministicEventId(parts: readonly (string | undefined)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part ?? "");
    hash.update("\u001f");
  }
  return hash.digest("hex").slice(0, 16);
}
