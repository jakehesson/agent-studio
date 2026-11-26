import { createHash } from "node:crypto";
import { z } from "zod";

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
});
export type AgentUsageMetrics = z.infer<typeof AgentUsageMetricsSchema>;

export const ModelUsageBucketSchema = z.object({
  model: z.string().min(1),
  agentCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  sharePercent: z.number().min(0).max(100),
});
export type ModelUsageBucket = z.infer<typeof ModelUsageBucketSchema>;

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
});
export type PendingHumanPrompt = z.infer<typeof PendingHumanPromptSchema>;

export const ChatMessageRoleSchema = z.enum([
  "user",
  "assistant",
  "thinking",
  "tool",
  "question",
  "subagent",
]);
export type ChatMessageRole = z.infer<typeof ChatMessageRoleSchema>;

export const ChatToolCallRefSchema = z.object({
  toolCallId: z.string().optional(),
  toolName: z.string(),
  summary: z.string(),
  status: z.enum(["running", "ok", "error", "denied"]).optional(),
  inputPreview: z.string().optional(),
  output: z.string().optional(),
});
export type ChatToolCallRef = z.infer<typeof ChatToolCallRefSchema>;

export const AgentChatMessageSchema = z.object({
  id: z.string(),
  ts: z.string(),
  epoch: z.number(),
  agentId: z.string(),
  role: ChatMessageRoleSchema,
  text: z.string(),
  thinking: z.string().optional(),
  tools: z.array(ChatToolCallRefSchema).optional(),
  pendingPromptId: z.string().optional(),
  subagentId: z.string().optional(),
  subagentLabel: z.string().optional(),
});
export type AgentChatMessage = z.infer<typeof AgentChatMessageSchema>;

export const AgentChatResponseSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string(),
  agentId: z.string(),
  agentLabel: z.string(),
  ide: IdeSourceSchema,
  messages: z.array(AgentChatMessageSchema),
  totalMessages: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
  pendingPrompt: PendingHumanPromptSchema.nullable(),
});
export type AgentChatResponse = z.infer<typeof AgentChatResponseSchema>;

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
