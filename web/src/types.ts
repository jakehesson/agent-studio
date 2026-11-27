export type IdeSource =
  | "antigravity"
  | "claude-code"
  | "copilot-vscode"
  | "mcp"
  | "unknown";

export type IdeFilter = "all" | "antigravity" | "claude-code" | "copilot-vscode";
export type HostIde = "antigravity" | "claude-code" | "copilot-vscode";

export interface EmbedScope {
  embedMode: boolean;
  lockedIde: HostIde | null;
  lockedWorkspace: string;
  mcpAppMode?: boolean;
}

export type TelemetryChannel = "passive" | "hook" | "mcp";

export type AgentStatus =
  | "THINKING"
  | "WORKING"
  | "WAITING"
  | "BLOCKED"
  | "DONE"
  | "IDLE";

export type NodeType = "agent" | "human" | "external";

export type NormalizedEventKind =
  | "session_start"
  | "user_input"
  | "thinking_start"
  | "tool_start"
  | "tool_end"
  | "subagent_spawn"
  | "subagent_done"
  | "message"
  | "board_mutation"
  | "assistant_turn_end";

export interface NormalizedEvent {
  id: string;
  mergeKey?: string;
  ts: string;
  epoch: number;
  ide: IdeSource;
  channel?: TelemetryChannel;
  sessionId: string;
  workspacePath?: string;
  projectId?: string;
  agentId: string;
  agentLabel?: string;
  parentAgentId?: string;
  kind: NormalizedEventKind;
  toolName?: string;
  toolCallId?: string;
  targetAgentId?: string;
  summary: string;
  bodyLength?: number;
  bodyTruncated?: boolean;
  payload?: Record<string, unknown>;
}

export interface AgentUsageMetrics {
  model: string;
  modelSource: "exact" | "inherited" | "definition" | "unknown";
  usageSource: "exact" | "estimated";
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  contextTokens: number;
  contextWindow: number;
  nominalContextWindow?: number;
  contextPercent: number;
  costUsd?: number;
}

export interface ModelUsageBucket {
  model: string;
  agentCount: number;
  totalTokens: number;
  sharePercent: number;
}

export interface SessionUsageSummary {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  peakContextPercent: number;
  peakContextAgentId: string | null;
  usageSource: "exact" | "estimated" | "mixed";
  costUsd?: number;
  models: ModelUsageBucket[];
}

export interface AgentRecentAction {
  ts: string;
  text: string;
  kind: NormalizedEventKind;
  toolName?: string;
  routineEnd?: boolean;
  isError?: boolean;
}

export interface AgentNodeSnapshot {
  id: string;
  label: string;
  parentAgentId?: string;
  nodeType?: NodeType;
  ide: IdeSource;
  status: AgentStatus;
  model?: string;
  usage?: AgentUsageMetrics;
  activeTool?: string;
  thinkingSince?: string;
  thinkingEpoch?: number;
  lastEventAt?: string;
  lastEpoch?: number;
  steps?: number;
  toolCalls: number;
  messagesSent: number;
  messagesReceived: number;
  summary?: string;
  role?: string;
  recentActions?: AgentRecentAction[];
  pendingPrompt?: PendingHumanPrompt | null;
}

export interface AgentEdgeSnapshot {
  from: string;
  to: string;
  count: number;
  lastKind?: NormalizedEventKind;
  lastTs?: string;
}

export interface SessionCounters {
  totalEvents: number;
  toolCalls: number;
  messages: number;
  boardMutations: number;
  activeAgents: number;
  completedAgents: number;
}

export interface DiscoveredSessionSummary {
  sessionId: string;
  ide: IdeSource;
  projectId?: string;
  workspacePath?: string;
  title?: string;
  status: AgentStatus;
  waitingOn?: string | null;
  isWaiting?: boolean;
  isCompleted?: boolean;
  isMultiAgent?: boolean;
  agentCount?: number;
  updatedAt?: string;
  mtimeMs?: number;
}

export interface RegisteredProject {
  id: string;
  title?: string;
  name?: string;
  rootPath?: string;
  path?: string;
  boardPath?: string;
}

export interface PendingQuestionOption {
  id?: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface PendingQuestionItem {
  id?: string;
  header?: string;
  question: string;
  type: "single_select" | "multi_select" | "text";
  options: PendingQuestionOption[];
  allowCustomInput?: boolean;
  defaultValue?: string;
}

export type PromptSource = "native" | "studio-mcp" | "studio-vscode-lm";

export type PromptStatus = "pending" | "answered" | "canceled" | "expired";

export interface PendingHumanPrompt {
  id: string;
  toolCallId?: string;
  toolName?: string;
  agentId: string;
  agentLabel: string;
  kind: "question" | "approval";
  title: string;
  summary?: string;
  questions: PendingQuestionItem[];
  options?: Array<{ label: string; recommended?: boolean }>;
  ts?: string;
  blockingToolCall: boolean;
  directReply?: boolean;
  promptSource?: PromptSource;
  status?: PromptStatus;
  answerText?: string;
  answers?: Record<string, unknown>;
  expiresAt?: string;
  sessionId?: string;
  workspacePath?: string;
  ide?: IdeSource;
}

export type ChatMessageRole =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "question"
  | "subagent";

export interface ChatToolCallRef {
  toolCallId?: string;
  toolName: string;
  summary: string;
  status?: "running" | "ok" | "error" | "denied";
  inputPreview?: string;
  output?: string;
}

export interface AgentChatMessage {
  id: string;
  ts: string;
  epoch: number;
  agentId: string;
  role: ChatMessageRole;
  text: string;
  thinking?: string;
  tools?: ChatToolCallRef[];
  pendingPromptId?: string;
  subagentId?: string;
  subagentLabel?: string;
}

export interface AgentChatResponse {
  ok: true;
  sessionId: string;
  agentId: string;
  agentLabel: string;
  ide: string;
  messages: AgentChatMessage[];
  totalMessages: number;
  hasMore: boolean;
  nextCursor?: string;
  pendingPrompt: PendingHumanPrompt | null;
}

export interface ReplyToHostRequest {
  sessionId?: string;
  agentId: string;
  promptId?: string;
  text: string;
  blockingToolCall: boolean;
  directReply?: boolean;
  promptSource?: PromptSource;
  answers?: Record<string, string | string[]>;
}

export interface ReplyToHostResult {
  ok: boolean;
  mode: "sent" | "prefilled" | "copied" | "focused_copied" | "answered" | "canceled" | "error";
  message: string;
  conflict?: boolean;
  status?: PromptStatus;
}

export interface ReplyCapabilities {
  canSendMessage: boolean;
  isMcpApp: boolean;
  isEmbed: boolean;
}

export interface TeamRosterRef {
  id: string;
  name?: string;
  role?: string;
}

export interface SessionSnapshot {
  sessionId: string;
  ide: IdeSource;
  projectId?: string;
  workspacePath?: string;
  updatedAt: string;
  serverTime?: string;
  status: AgentStatus;
  waitingOn?: string | null;
  isWaiting?: boolean;
  isCompleted?: boolean;
  isMultiAgent?: boolean;
  agents: AgentNodeSnapshot[];
  edges: AgentEdgeSnapshot[];
  events: NormalizedEvent[];
  counters: SessionCounters;
  usage?: SessionUsageSummary;
  sessions?: DiscoveredSessionSummary[];
  boardProjects?: RegisteredProject[];
  pendingPrompts?: PendingHumanPrompt[];
  definitions?: TeamDefinitionEntry[];
  teamRoster?: TeamRosterRef[];
  modelContextWindows?: Record<string, number>;
}

export interface SessionsResponse {
  sessions: DiscoveredSessionSummary[];
  projects: RegisteredProject[];
}

/* ---------- Agile Board Types ---------- */

export type BoardState =
  | "backlog"
  | "ready"
  | "design"
  | "dev"
  | "test"
  | "done"
  | "blocked";

export type BugSeverity = "S1" | "S2" | "S3" | "S4";

export type HandoffStatus =
  | "pending_handoff"
  | "pending_split"
  | "resumed"
  | "cleared";

export type HandoffKind = "fresh_context" | "task_split";

export interface SplitProposal {
  title: string;
  role: string;
  ac?: string[];
  deps?: string[];
  rationale?: string;
}

export interface ContextHandoffRecord {
  status: HandoffStatus;
  kind: HandoffKind;
  created_at: string;
  actor: string;
  session_id?: string;
  agent_id?: string;
  context_percent?: number;
  context_tokens?: number;
  context_window?: number;
  objective?: string;
  summary: string;
  evidence?: string[];
  decisions?: string[];
  assumptions?: string[];
  unresolved_issues?: string[];
  modified_files?: string[];
  verified_checks?: string[];
  remaining_work?: string[];
  continuation_brief: string;
  split_proposals?: SplitProposal[];
}

export interface BoardItem {
  id: string;
  type: "spike" | "story" | "task" | "bug";
  role: string;
  sprint?: string | null;
  state: BoardState;
  title: string;
  ac?: string[];
  deps?: string[];
  notes?: string[];
  owner?: string | null;
  severity?: BugSeverity | null;
  points?: number | null;
  resolution?: string | null;
  suite?: string;
  required_checkpoints?: string[];
  created_at?: string;
  handoff?: ContextHandoffRecord | null;
  split_from?: string | null;
}

export interface TestrunRecord {
  id: string;
  suite: string;
  build: string;
  started: string;
  closed?: string;
  status: "running" | "passed" | "failed";
  results: Record<string, string>;
  step_results?: Record<string, Record<string, string>>;
  bugs: string[];
  actor?: string;
  items?: string[];
}

export interface SprintInfo {
  goal?: string;
  status?: string;
  started_at?: string | null;
  closed_at?: string | null;
}

export interface BoardData {
  project?: string;
  milestone?: {
    id: string;
    name: string;
    sprints?: string[];
    final_suite?: string;
  };
  active_sprint?: string | null;
  sprints?: Record<string, SprintInfo>;
  suites?: Record<string, string[]>;
  items: BoardItem[];
  testruns: TestrunRecord[];
}

export interface BoardApiResponse {
  ok?: boolean;
  project?: string;
  projects?: RegisteredProject[];
  board?: BoardData | null;
  counts?: Record<string, number>;
  openBugs?: BoardItem[];
  qaGate?: {
    required?: boolean;
    passedCount?: number;
    blockedItems?: string[];
  };
  error?: string;
}

/* ---------- Mockups Types ---------- */

export interface MockupEntry {
  id: string;
  title: string;
  projectId?: string;
  fileName: string;
  relPath?: string;
  mtimeMs?: number;
  url?: string;
  feedback?: string;
}

export interface MockupsApiResponse {
  mockups: MockupEntry[];
  projects?: RegisteredProject[];
}

/* ---------- Doctor Types ---------- */

export type CheckStatus = "pass" | "warn" | "fail" | "unknown";

export interface IdeHealthCard {
  ide: IdeSource;
  name: string;
  detected: boolean;
  enabled?: boolean;
  adapterStatus: CheckStatus;
  configDrift: string[];
  mcpConfigured: boolean;
  hooksConfigured: boolean;
  telemetryPath?: string;
  telemetryReachable?: boolean;
  sessionCount?: number;
  fileCount?: number;
  details?: string;
}

export interface DoctorCheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fixHint?: string;
}

export interface DoctorMigrationWarning {
  id?: string;
  ide?: IdeSource | string;
  severity?: "warn" | "info" | "error";
  path?: string;
  title?: string;
  message: string;
  fixHint?: string;
}

export type ModelTier = "fast" | "balanced" | "reasoning";

export type ModelRoutingPolicy =
  | "defer-to-host"
  | "prefer-fallback"
  | "pinned";

export type ModelPolicy = ModelRoutingPolicy;

export type ModelCapabilityTag =
  | "coding"
  | "reasoning"
  | "multimodal"
  | "fast"
  | "orchestration"
  | "search"
  | "long-context";

export type ModelSourceTag = "built-in" | "vscode-lm" | "agent" | "user";

export type IdeModelMode = "tier-enum" | "family-alias" | "picker-array";

export type ModelSelectionCriterion = "accuracy" | "cost" | "speed";

export interface ModelCatalogEntry {
  id: string;
  label: string;
  vendor?: string;
  family?: string;
  tier: ModelTier;
  capabilities: ModelCapabilityTag[];
  contextWindow?: number;
  premiumMultiplier?: number;
  accuracyRank?: number;
  speedRank?: number;
  deprecated?: boolean;
  available: boolean;
  source: ModelSourceTag;
  discoveredAt?: string;
  notes?: string;
}

export interface IdeTierBinding {
  primary: string;
  fallback: string[];
  omitOnDefer?: boolean;
  notes?: string;
}

export interface IdeModelConfig {
  mode: IdeModelMode;
  tiers: Record<ModelTier, IdeTierBinding>;
  catalog: ModelCatalogEntry[];
  lastSyncedAt?: string;
  syncSource?: "built-in" | "vscode-lm" | "manual";
}

export interface RoleRecommendation {
  tier: ModelTier;
  rationale: string;
  multimodalPreferred?: boolean;
  deferToHostOrchestrator?: boolean;
}

export interface ModelIndex {
  $schema?: string;
  schemaVersion: 1;
  updatedAt: string;
  updatedBy: "built-in" | "cli" | "api" | "vscode-lm" | "agent" | "user";
  notes?: string;
  selectionPriority?: ModelSelectionCriterion[];
  roleRecommendations: Record<string, RoleRecommendation>;
  ides: Record<HostIde, IdeModelConfig>;
}

export interface ModelIndexOverlay {
  schemaVersion?: 1;
  updatedAt?: string;
  updatedBy?: "built-in" | "cli" | "api" | "vscode-lm" | "agent" | "user";
  notes?: string;
  selectionPriority?: ModelSelectionCriterion[];
  roleRecommendations?: Record<string, Partial<RoleRecommendation>>;
  ides?: Partial<
    Record<
      HostIde,
      {
        mode?: IdeModelMode;
        tiers?: Partial<Record<ModelTier, Partial<IdeTierBinding>>>;
        catalog?: ModelCatalogEntry[];
        lastSyncedAt?: string;
        syncSource?: "built-in" | "vscode-lm" | "manual";
      }
    >
  >;
}

export type IdeModelOverride =
  | string
  | string[]
  | {
      primary?: string;
      fallback?: string[];
      omit?: boolean;
      copilotPolicy?: "preferred" | "required";
    };

export interface WorkflowModelRouting {
  policy: ModelRoutingPolicy;
  respectBuiltInOrchestrators: boolean;
  allowSubagentModelHints: boolean;
  copilotHandoffModels: boolean;
  selectionPriority?: ModelSelectionCriterion[];
  idePolicies?: Partial<Record<HostIde, ModelRoutingPolicy>>;
}

export interface ResolvedIdeModel {
  model: string | string[];
  fallback: string[];
  copilotPolicy?: "preferred" | "required";
  omitted?: boolean;
  tier: ModelTier;
  policy: ModelRoutingPolicy;
  source?: string;
}

export interface RoleModelRouting {
  id: string;
  modelTier?: ModelTier;
  modelPolicy?: ModelRoutingPolicy;
  models?: Partial<Record<HostIde, IdeModelOverride>>;
  resolved?: Partial<Record<HostIde, ResolvedIdeModel>>;
}

export interface ModelIndexLayersInfo {
  globalPath: string;
  globalExists: boolean;
  globalUpdatedAt?: string;
  workspacePath: string;
  workspaceExists: boolean;
  workspaceUpdatedAt?: string;
  globalDiffersFromWorkspace: boolean;
}

export interface ModelIndexView {
  ok: boolean;
  projectId?: string;
  projectRoot?: string;
  effective: ModelIndex;
  layers: ModelIndexLayersInfo;
  routing: WorkflowModelRouting & {
    resolvedRoles: Record<string, RoleModelRouting>;
  };
  compileResult?: unknown;
}

export interface ModelIndexHealth {
  valid: boolean;
  policy: ModelRoutingPolicy;
  layers: {
    globalPath: string;
    globalExists: boolean;
    workspacePath: string;
    workspaceExists: boolean;
    globalLastSyncedAt?: string;
    workspaceUpdatedAt?: string;
  };
  warnings: string[];
  errors: string[];
}

export interface DoctorApiResponse {
  ok?: boolean;
  project?: string;
  nodeVersion?: string;
  teamYamlValid?: boolean;
  ides: IdeHealthCard[];
  checks: DoctorCheckItem[];
  guardrails?: {
    orchestratorReadOnly?: boolean;
    qaGateRequired?: boolean;
    blockDirectBoardEdits?: boolean;
  };
  driftFiles?: Array<{ file: string; status: string; ide?: string; reason?: string }>;
  migrationWarnings?: DoctorMigrationWarning[];
  modelIndex?: ModelIndexHealth;
  timestamp?: string;
}

/* ---------- Agent Team Details Types ---------- */

export type TeamSourceIde =
  | "canonical"
  | "antigravity"
  | "claude-code"
  | "copilot-vscode";

export interface TeamCheckpoint {
  title: string;
  command?: string;
  steps: string[];
  pass: string[];
  fail: string[];
}

export interface TeamRosterEntry {
  id: string;
  name: string;
  roleType: string;
  boardRole: string;
  description: string;
  capabilities: string[];
  handoffs: string[];
  promptFile: string;
  source_path: string;
  chars: number;
  est_tokens: number;
  preview: string;
  modelTier?: ModelTier;
  modelPolicy?: ModelRoutingPolicy;
  models?: Partial<Record<HostIde, IdeModelOverride>>;
  resolvedModels?: Partial<Record<HostIde, ResolvedIdeModel>>;
}

export interface TeamSkillEntry {
  id: string;
  name: string;
  description: string;
  source_ide: TeamSourceIde;
  source_path: string;
  chars: number;
  est_tokens: number;
  preview: string;
}

export interface TeamDefinitionEntry {
  id: string;
  name: string;
  roleType?: string;
  boardRole?: string;
  description: string;
  model: string;
  tools?: string[];
  capabilities?: string[];
  handoffs?: string[];
  source_ide: TeamSourceIde;
  source_path: string;
  chars: number;
  est_tokens: number;
  preview: string;
}

export interface TeamDetailsResponse {
  project: {
    id: string;
    title: string;
    description: string;
    root: string;
  };
  hasManifest: boolean;
  targets: string[];
  workflow: {
    boardPath: string;
    stages: string[];
    enforcement: {
      orchestratorReadOnly: boolean;
      qaGateRequired: boolean;
      blockDirectBoardEdits: boolean;
    };
    suites: Record<string, string[]>;
    checkpoints: Record<string, TeamCheckpoint>;
  };
  roster: TeamRosterEntry[];
  skills: TeamSkillEntry[];
  definitions: TeamDefinitionEntry[];
  modelRouting?: WorkflowModelRouting;
  modelIndexSummary?: {
    updatedAt?: string;
    updatedBy?: string;
    hasGlobalOverlay?: boolean;
    hasWorkspaceOverlay?: boolean;
    globalLastSyncedAt?: string;
    globalDiffersFromWorkspace?: boolean;
  };
  server_time: string;
}

export type PrimaryView = "studio" | "team" | "board" | "mockups" | "doctor" | "chat";
export type CoverPane = "studio" | "feed" | "team" | "board" | "mockups" | "doctor";
export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

/* ---------- In-App GitHub Feedback Types (S1-57) ---------- */

export type FeedbackCategory = "bug" | "feature" | "telemetry" | "question";

export interface FeedbackDiagnostics {
  appVersion?: string;
  ide?: IdeSource;
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  agentCount?: number;
  eventCount?: number;
  embedMode?: boolean;
  osPlatform?: string;
}

export interface FeedbackStatusResponse {
  ok: boolean;
  repo: string;
  directAvailable: boolean;
  method: "vscode-github" | "github-token" | "gh-cli" | "none";
  accountLabel?: string;
  newIssueUrl: string;
  appVersion?: string;
}

export interface FeedbackSubmissionPayload {
  category: FeedbackCategory;
  title: string;
  description: string;
  includeDiagnostics: boolean;
  diagnostics?: FeedbackDiagnostics;
}

export interface FeedbackSubmitResult {
  ok: boolean;
  mode: "created" | "fallback";
  issueUrl?: string;
  issueNumber?: number;
  prefillUrl?: string;
  reason?: string;
}
