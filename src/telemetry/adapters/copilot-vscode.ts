import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { listProjects } from "../../board/registry.js";
import { MAX_TRANSCRIPT_BYTES, validateTranscriptPath } from "../push-bus.js";
import {
  capChatText,
  cleanHumanSummary,
  computeDeterministicEventId,
  computeMergeKey,
  computePendingPromptId,
  extractProviderUsageDetails,
  formatQuestionsPreview,
  isBoardMutationToolCall,
  isOpaqueAgentId,
  isSelfDaemonCommand,
  normalizeCopilotUsage,
  normalizePendingQuestions,
  normalizeWsPath,
  parseEpochSeconds,
  prettifyAgentLabel,
  prettifyModelName,
  resolveEmptyFileLinks,
  summarizeToolCall,
  toIsoUtc,
  type AdapterHealth,
  type AgentChatMessage,
  type AgentStatus,
  type ChatToolCallRef,
  type DiscoveredSession,
  type EnrichedEvent,
  type ParseChatOptions,
  type ParseSessionOptions,
  type PassiveIdeAdapter,
  type PendingQuestionItem,
  type UsageDelta,
} from "../types.js";
import {
  getKnownProjects,
  matchProjectIdForWorkspaces,
  pathMatchesRoot,
} from "./project-match.js";

interface VSCodeUsageObject {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cachedTokens?: number;
  cachedPromptTokens?: number;
  cacheReadInputTokens?: number;
  cacheReadTokens?: number;
  cache_read_input_tokens?: number;
  cacheCreationInputTokens?: number;
  cache_creation_input_tokens?: number;
  contextTokens?: number;
  context_tokens?: number;
  currentTokens?: number;
  current_tokens?: number;
  tokenLimit?: number;
  token_limit?: number;
  maxInputTokens?: number;
  max_input_tokens?: number;
  contextWindow?: number;
  context_window?: number;
  totalTokens?: number;
  costUsd?: number;
  cost_usd?: number;
}

interface VSCodeResponseItem {
  kind?: string;
  value?: string;
  content?: string | { value?: string };
  toolId?: string;
  toolName?: string;
  toolCallId?: string;
  isComplete?: boolean;
  isConfirmed?: boolean;
  isUsed?: boolean;
  data?: unknown;
  questions?: unknown[];
  title?: string;
  subtitle?: string;
  message?: string | { value?: string };
  state?: string;
  requestedSchema?: Record<string, unknown>;
  invocationMessage?: string | { value?: string };
  pastTenseMessage?: string | { value?: string };
  generatedTitle?: string;
  uri?: string | { path?: string; fsPath?: string; external?: string };
  resultDetails?: unknown;
  toolSpecificData?: Record<string, unknown>;
}

interface VSCodeRequest {
  requestId?: string;
  timestamp?: number;
  isCanceled?: boolean;
  completionTokens?: number;
  message?: { text?: string };
  agent?: { id?: string; name?: string; fullName?: string };
  modeInfo?: { modeId?: string; modeName?: string };
  modelId?: string;
  modelState?: { value?: number; completedAt?: number };
  response?: VSCodeResponseItem[];
  result?: {
    details?: string;
    errorDetails?: { message?: string };
    usage?: VSCodeUsageObject;
    metadata?: {
      promptTokens?: number;
      completionTokens?: number;
      cachedTokens?: number;
      cachedPromptTokens?: number;
      cacheReadInputTokens?: number;
      usage?: VSCodeUsageObject;
      toolCallRounds?: Array<{
        usage?: VSCodeUsageObject;
        modelId?: string;
      }>;
    };
  };
}

interface VSCodeChatSessionState {
  sessionId?: string;
  customTitle?: string;
  creationDate?: number;
  lastMessageDate?: number;
  inputState?: {
    selectedModel?:
      | string
      | {
          identifier?: string;
          id?: string;
          name?: string;
          family?: string;
          version?: string;
          maxInputTokens?: number;
          metadata?: {
            id?: string;
            name?: string;
            family?: string;
            version?: string;
            maxInputTokens?: number;
          };
        };
  };
  requests?: VSCodeRequest[];
}

interface DeltaRow {
  kind?: number;
  k?: Array<string | number>;
  i?: number;
  v?: unknown;
}

export interface CopilotVSCodeAdapterOptions {
  storageDir?: string;
  copilotHomeDir?: string;
}

export function resolveCopilotHomeDir(
  homeDir: string = os.homedir(),
  explicitCopilotHome?: string,
): string {
  const explicit = explicitCopilotHome?.trim();
  if (explicit) return path.resolve(explicit);
  const envVal = process.env.COPILOT_HOME?.trim();
  if (envVal) return path.resolve(envVal);
  return path.resolve(path.join(homeDir, ".copilot"));
}

export interface CopilotTranscriptParseOptions extends ParseSessionOptions {
  agentIdOverride?: string;
  agentLabelOverride?: string;
  parentAgentIdOverride?: string;
  workspacePath?: string;
  projectId?: string;
  allowedRoots?: ReadonlyArray<string>;
}

interface CachedTranscriptDiscoveryMeta {
  mtimeMs: number;
  sizeBytes: number;
  sessionId: string;
  title: string;
  workspacePath?: string;
  workspaces: string[];
  isMultiAgent: boolean;
  isSubagentTranscript: boolean;
  distinctAgentsCount: number;
  waitingOn: "user" | "tool_approval" | "subagent" | null;
  pendingQuestionCount: number;
  waitingSummary?: string;
}

/**
 * Agent Studio's own direct-reply ask tools. These are answered through the
 * Prompt Bridge (`/api/prompts`), so the adapter must NOT also synthesize a
 * passive `blockingToolCall: true` prompt for them.
 */
export function isStudioDirectAskTool(lowTool: string): boolean {
  const t = lowTool.toLowerCase();
  return (
    t === "ask_human" ||
    t === "agent_studio_ask_human" ||
    t === "mcp__agent-studio__ask_human" ||
    t === "agent-studio/ask_human"
  );
}

function isCopilotAskTool(lowTool: string): boolean {
  return (
    lowTool === "vscode_askquestions" ||
    lowTool === "ask_questions" ||
    lowTool === "askquestions" ||
    lowTool === "ask_question" ||
    lowTool === "ask_user"
  ) && !isStudioDirectAskTool(lowTool);
}

function extractCopilotItemQuestions(
  item: VSCodeResponseItem,
): PendingQuestionItem[] {
  const rkind = item.kind ?? "";
  if (rkind === "questionCarousel") {
    return normalizePendingQuestions(item.questions ?? [], {
      defaultAllowCustomInput: true,
    });
  }
  if (rkind === "elicitationSerialized") {
    if (Array.isArray(item.questions) && item.questions.length > 0) {
      return normalizePendingQuestions(item.questions, {
        defaultAllowCustomInput: true,
      });
    }
    const msgText =
      extractMessageText(item.message) ||
      item.title ||
      item.subtitle ||
      "Confirmation requested";
    return [
      {
        ...(item.title ? { header: item.title } : {}),
        question: msgText,
        type: "single_select",
        options: [{ label: "Allow" }, { label: "Decline" }],
        allowCustomInput: true,
      },
    ];
  }
  const tsd = item.toolSpecificData;
  if (tsd?.questions !== undefined) {
    return normalizePendingQuestions(tsd.questions, {
      defaultAllowCustomInput: true,
    });
  }
  if (tsd) {
    const qs = normalizePendingQuestions(tsd, {
      defaultAllowCustomInput: true,
    });
    if (qs.length > 0) return qs;
  }
  const invMsg = extractMessageText(item.invocationMessage).trim();
  if (invMsg) {
    return [
      {
        question: invMsg,
        type: "text",
        options: [],
        allowCustomInput: true,
      },
    ];
  }
  return [];
}

interface CopilotRequestQuestionAnalysis {
  mergedCarouselToAskIdx: Map<number, number>;
  mergedAskQuestions: Map<number, PendingQuestionItem[]>;
  suppressedCarouselIndices: Set<number>;
  suppressedAskIndices: Set<number>;
  waitingOn: "user" | "tool_approval" | null;
  pendingQuestionCount: number;
  waitingSummary?: string;
}

function analyzeCopilotRequestQuestions(
  req: VSCodeRequest,
): CopilotRequestQuestionAnalysis {
  const responses = Array.isArray(req.response) ? req.response : [];
  const mergedCarouselToAskIdx = new Map<number, number>();
  const mergedAskQuestions = new Map<number, PendingQuestionItem[]>();
  const suppressedCarouselIndices = new Set<number>();
  const suppressedAskIndices = new Set<number>();
  const reqCompleted = Boolean(
    req.isCanceled || req.modelState?.completedAt || req.result,
  );

  const askIndicesByCallId = new Map<string, number>();
  for (let i = 0; i < responses.length; i++) {
    const item = responses[i]!;
    if (
      item.kind === "toolInvocationSerialized" &&
      isCopilotAskTool((item.toolId ?? item.toolName ?? "").toLowerCase())
    ) {
      if (item.toolCallId) {
        askIndicesByCallId.set(item.toolCallId, i);
      }
      if (item.isComplete === true || reqCompleted) {
        suppressedAskIndices.add(i);
      }
    }
  }

  for (let i = 0; i < responses.length; i++) {
    const item = responses[i]!;
    const rkind = item.kind ?? "";
    if (rkind !== "questionCarousel" && rkind !== "elicitationSerialized") {
      continue;
    }

    const prevItem = i > 0 ? responses[i - 1] : undefined;
    const prevIsAsk =
      prevItem?.kind === "toolInvocationSerialized" &&
      isCopilotAskTool(
        (prevItem.toolId ?? prevItem.toolName ?? "").toLowerCase(),
      );
    const matchingAskIdx =
      (item.toolCallId ? askIndicesByCallId.get(item.toolCallId) : undefined) ??
      (prevIsAsk ? i - 1 : undefined);
    const matchingAsk =
      matchingAskIdx !== undefined ? responses[matchingAskIdx] : undefined;

    const isElicitationDone =
      rkind === "elicitationSerialized" &&
      (item.isComplete === true ||
        (typeof item.state === "string" &&
          item.state.toLowerCase() !== "pending"));
    const isAnswered =
      Boolean(item.isUsed) ||
      (item.data !== undefined && item.data !== null) ||
      isElicitationDone;
    const precededByCompleteAsk = Boolean(
      matchingAsk && matchingAsk.isComplete === true,
    );
    const followedByMoreItems = i < responses.length - 1;
    const isSuppressed =
      isAnswered || precededByCompleteAsk || followedByMoreItems || reqCompleted;

    if (isSuppressed) {
      suppressedCarouselIndices.add(i);
    }

    if (
      rkind === "questionCarousel" &&
      matchingAskIdx !== undefined &&
      matchingAsk
    ) {
      mergedCarouselToAskIdx.set(i, matchingAskIdx);
      const carouselQs = extractCopilotItemQuestions(item);
      if (carouselQs.length > 0) {
        mergedAskQuestions.set(matchingAskIdx, carouselQs);
      }
      if (isSuppressed || matchingAsk.isComplete === true) {
        suppressedAskIndices.add(matchingAskIdx);
      }
    }
  }

  let waitingOn: "user" | "tool_approval" | null = null;
  let pendingQuestionCount = 0;
  let waitingSummary: string | undefined;

  if (!reqCompleted) {
    for (let i = responses.length - 1; i >= 0; i--) {
      const item = responses[i]!;
      const rkind = item.kind ?? "";
      if (rkind === "questionCarousel" || rkind === "elicitationSerialized") {
        if (
          suppressedCarouselIndices.has(i) ||
          mergedCarouselToAskIdx.has(i)
        ) {
          continue;
        }
        const qs = extractCopilotItemQuestions(item);
        waitingOn = "user";
        pendingQuestionCount = Math.max(1, qs.length);
        waitingSummary =
          cleanHumanSummary(
            qs[0]?.header ?? qs[0]?.question ?? "Waiting for user answer",
            80,
          ) || "Waiting for user answer";
        break;
      }
      if (rkind === "toolInvocationSerialized") {
        const lowTool = (item.toolId ?? item.toolName ?? "").toLowerCase();
        if (isCopilotAskTool(lowTool)) {
          if (suppressedAskIndices.has(i) || item.isComplete === true) continue;
          const qs =
            mergedAskQuestions.get(i) ?? extractCopilotItemQuestions(item);
          waitingOn = "user";
          pendingQuestionCount = Math.max(1, qs.length);
          waitingSummary =
            cleanHumanSummary(
              qs[0]?.header ?? qs[0]?.question ?? "Waiting for user answer",
              80,
            ) || "Waiting for user answer";
          break;
        }
        if (item.isComplete === false && item.isConfirmed === false) {
          const msg =
            extractMessageText(item.invocationMessage) ||
            item.generatedTitle ||
            item.toolId ||
            item.toolName ||
            "Tool approval";
          waitingOn = "tool_approval";
          pendingQuestionCount = 1;
          waitingSummary = cleanHumanSummary(msg, 80) || "Waiting for approval";
          break;
        }
      }
    }
  }

  return {
    mergedCarouselToAskIdx,
    mergedAskQuestions,
    suppressedCarouselIndices,
    suppressedAskIndices,
    waitingOn,
    pendingQuestionCount,
    waitingSummary,
  };
}

const VSCODE_VARIANTS = ["Code", "Code - Insiders", "VSCodium"] as const;

function variantStorageDir(variant: string): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, variant, "User", "workspaceStorage");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      variant,
      "User",
      "workspaceStorage",
    );
  }
  return path.join(os.homedir(), ".config", variant, "User", "workspaceStorage");
}

function defaultVSCodeStorageDirs(): string[] {
  const envOverride = process.env.VSCODE_STORAGE_DIR?.trim();
  if (envOverride) return [envOverride];
  return VSCODE_VARIANTS.map((v) => variantStorageDir(v));
}

function isSubagentToolName(lowTool: string): boolean {
  return (
    lowTool === "agent" ||
    lowTool === "task" ||
    lowTool === "runsubagent" ||
    lowTool === "agent/runsubagent" ||
    lowTool.includes("subagent")
  );
}

function extractSelectedModel(
  selectedModel: NonNullable<VSCodeChatSessionState["inputState"]>["selectedModel"],
): string | undefined {
  if (!selectedModel) return undefined;
  if (typeof selectedModel === "string") {
    return selectedModel.trim() || undefined;
  }
  const rawId =
    selectedModel.metadata?.id?.trim() ||
    selectedModel.id?.trim() ||
    selectedModel.identifier?.trim();
  const isAuto =
    Boolean(rawId) &&
    (rawId!.toLowerCase() === "auto" || rawId!.toLowerCase().endsWith("/auto"));
  if (isAuto) {
    const resolved =
      selectedModel.metadata?.version?.trim() ||
      selectedModel.version?.trim() ||
      selectedModel.metadata?.family?.trim() ||
      selectedModel.family?.trim();
    if (resolved) return resolved;
    const rawName =
      selectedModel.metadata?.name?.trim() || selectedModel.name?.trim();
    if (rawName && rawName.toLowerCase() !== "auto") return rawName;
    return rawId;
  }
  return (
    rawId ||
    selectedModel.metadata?.name?.trim() ||
    selectedModel.name?.trim() ||
    selectedModel.metadata?.version?.trim() ||
    selectedModel.version?.trim() ||
    selectedModel.metadata?.family?.trim() ||
    selectedModel.family?.trim() ||
    undefined
  );
}

function extractSelectedModelContextWindow(
  selectedModel: NonNullable<VSCodeChatSessionState["inputState"]>["selectedModel"],
): number | undefined {
  if (!selectedModel || typeof selectedModel === "string") return undefined;
  const maxIn =
    selectedModel.metadata?.maxInputTokens ?? selectedModel.maxInputTokens;
  if (typeof maxIn === "number" && Number.isFinite(maxIn) && maxIn > 0) {
    return Math.round(maxIn);
  }
  return undefined;
}

function extractUriBasename(uri: VSCodeResponseItem["uri"]): string | undefined {
  if (!uri) return undefined;
  const raw =
    typeof uri === "string"
      ? uri
      : uri.fsPath || uri.path || uri.external || "";
  const rawClean = raw.trim().split(/[?#]/)[0] ?? "";
  if (!rawClean) return undefined;
  let decoded = rawClean;
  try {
    decoded = decodeURIComponent(rawClean);
  } catch {
    // keep raw if malformed URI encoding
  }
  const norm = decoded
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const base = path.posix.basename(norm);
  return base || undefined;
}

function isMessageToolName(lowTool: string): boolean {
  return (
    lowTool === "write_agent" ||
    lowTool === "read_agent" ||
    lowTool === "send_message" ||
    lowTool === "sendmessage"
  );
}

function extractMessageTarget(args: Record<string, unknown>): string | undefined {
  for (const key of [
    "targetAgentId",
    "target_agent_id",
    "agent_id",
    "agentId",
    "recipient",
    "Recipient",
    "target",
    "to",
    "agent_name",
    "agentName",
    "name",
  ]) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return undefined;
}

const THINKING_INLINE_MAX = 800;

function formatToolOutput(val: unknown): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    const rec = val as Record<string, unknown>;
    if (typeof rec.content === "string") return rec.content;
    try {
      return JSON.stringify(val, null, 2);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

function formatCopilotAnswerValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const formatted = formatCopilotAnswerValue(parsed);
        if (formatted) return formatted;
      } catch {
        // Fallback to raw trimmed string.
      }
    }
    return trimmed;
  }
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) {
    return val.map(formatCopilotAnswerValue).filter(Boolean).join(", ");
  }
  if (typeof val === "object") {
    const rec = val as Record<string, unknown>;
    if (typeof rec.content === "string") {
      return formatCopilotAnswerValue(rec.content);
    }
    for (const key of ["answers", "answer", "response", "text"]) {
      if (rec[key] !== undefined) {
        const unwrapped = formatCopilotAnswerValue(rec[key]);
        if (unwrapped) return unwrapped;
      }
    }
    if (
      typeof rec.question === "string" &&
      (rec.answer !== undefined || rec.value !== undefined)
    ) {
      const a = formatCopilotAnswerValue(rec.answer ?? rec.value);
      return a ? `${rec.question.trim()}: ${a}` : "";
    }
    return Object.entries(rec)
      .map(([k, v]) => {
        const formatted = formatCopilotAnswerValue(v);
        if (!formatted) return "";
        return k.trim() ? `${k.trim()}: ${formatted}` : formatted;
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractCopilotAnswerText(
  rawVal: unknown,
  pastTenseMsg?: string,
): string {
  const formatted = formatCopilotAnswerValue(rawVal);
  if (formatted) return formatted;
  const past = (pastTenseMsg ?? "").trim();
  if (
    past &&
    !/^(answered|asked|completed|done|waiting for user answer)\.?$/i.test(past)
  ) {
    return past;
  }
  return "";
}

function extractMessagePayload(args: Record<string, unknown>): {
  msgTarget?: string;
  msgBody?: string;
  inlineBody?: string;
  compactArgs: Record<string, unknown>;
} {
  const msgTarget = extractMessageTarget(args);
  const rawVal = args.message ?? args.content ?? args.body;
  const msgBody = typeof rawVal === "string" ? rawVal.trim() : undefined;
  const inlineBody = msgBody ? msgBody.slice(0, 1400) : undefined;
  const compactArgs =
    msgBody && msgBody.length > 1400
      ? {
          ...args,
          ...(typeof args.message === "string" ? { message: inlineBody } : {}),
          ...(typeof args.content === "string" ? { content: inlineBody } : {}),
          ...(typeof args.body === "string" ? { body: inlineBody } : {}),
        }
      : args;
  return { msgTarget, msgBody, inlineBody, compactArgs };
}

function extractUsageNumbers(
  u: Record<string, unknown> | VSCodeUsageObject | undefined,
): {
  inTok?: number;
  outTok?: number;
  cachedTok: number;
  cacheReadTok?: number;
  cacheWriteTok?: number;
  cacheSplitKnown: boolean;
  reasoningTok?: number;
  reasoningSource?: "exact";
  contextTok?: number;
  contextWindow?: number;
  costUsd?: number;
} {
  if (!u || typeof u !== "object") {
    return { cachedTok: 0, cacheSplitKnown: false };
  }
  const rec = u as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const inTok = num("promptTokens", "inputTokens", "input_tokens", "prompt_tokens");
  const rawOutTok = num(
    "completionTokens",
    "outputTokens",
    "output_tokens",
    "completion_tokens",
    "candidatesTokenCount",
  );
  const details = extractProviderUsageDetails([rec], rawOutTok);
  const outTok =
    rawOutTok !== undefined || details.reasoningSource === "exact"
      ? details.outputTokens
      : undefined;
  const contextTok = num(
    "contextTokens",
    "context_tokens",
    "currentTokens",
    "current_tokens",
  );
  const rawWin = num(
    "tokenLimit",
    "token_limit",
    "maxInputTokens",
    "max_input_tokens",
    "contextWindow",
    "context_window",
  );
  const contextWindow =
    rawWin !== undefined && rawWin > 0 ? Math.round(rawWin) : undefined;
  const costUsd = num("costUsd", "cost_usd", "totalCostUSD");
  return {
    inTok,
    outTok,
    cachedTok: details.cachedTokens,
    ...(details.cacheReadTokens !== undefined
      ? { cacheReadTok: details.cacheReadTokens }
      : {}),
    ...(details.cacheWriteTokens !== undefined
      ? { cacheWriteTok: details.cacheWriteTokens }
      : {}),
    cacheSplitKnown: details.cacheSplitKnown,
    ...(details.reasoningTokens !== undefined
      ? { reasoningTok: details.reasoningTokens, reasoningSource: "exact" as const }
      : {}),
    contextTok,
    contextWindow,
    costUsd,
  };
}

function extractModelMetricsUsage(modelMetrics: unknown): {
  inTok?: number;
  outTok?: number;
  cachedTok: number;
  cacheReadTok?: number;
  cacheWriteTok?: number;
  cacheSplitKnown: boolean;
  reasoningTok?: number;
  contextWindow?: number;
  costUsd?: number;
  model?: string;
} {
  if (!modelMetrics || typeof modelMetrics !== "object") {
    return { cachedTok: 0, cacheSplitKnown: false };
  }
  const entries: Array<[string | undefined, unknown]> = Array.isArray(modelMetrics)
    ? modelMetrics.map((v) => [undefined, v])
    : Object.entries(modelMetrics as Record<string, unknown>);

  let hasIn = false;
  let hasOut = false;
  let inSum = 0;
  let outSum = 0;
  let cachedSum = 0;
  let cacheReadSum = 0;
  let cacheWriteSum = 0;
  let hasCacheSplit = false;
  let hasUnsplitCached = false;
  let reasoningSum = 0;
  let hasReasoning = false;
  let contextWindow: number | undefined;
  let costSum = 0;
  let hasCost = false;
  let model: string | undefined;

  for (const [mKey, val] of entries) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const rec = val as Record<string, unknown>;
    if (!model && mKey) {
      const pretty = prettifyModelName(mKey) || mKey;
      if (pretty) model = pretty;
    }
    const usageObj =
      rec.usage && typeof rec.usage === "object" && !Array.isArray(rec.usage)
        ? (rec.usage as Record<string, unknown>)
        : rec;
    const u = extractUsageNumbers(usageObj);
    const outer = extractUsageNumbers(rec);
    const cw = u.contextWindow ?? outer.contextWindow;
    if (cw !== undefined && cw > 0) contextWindow = cw;
    if (u.inTok !== undefined) {
      hasIn = true;
      inSum += Math.max(0, Math.round(u.inTok));
    }
    if (u.outTok !== undefined) {
      hasOut = true;
      outSum += Math.max(0, Math.round(u.outTok));
    }
    cachedSum += u.cachedTok;
    if (u.cacheSplitKnown) {
      hasCacheSplit = true;
      cacheReadSum += u.cacheReadTok ?? 0;
      cacheWriteSum += u.cacheWriteTok ?? 0;
    } else if (u.cachedTok > 0) {
      hasUnsplitCached = true;
    }
    const rTok = u.reasoningTok ?? outer.reasoningTok;
    if (rTok !== undefined) {
      hasReasoning = true;
      reasoningSum += rTok;
    }
    const cost = u.costUsd ?? outer.costUsd;
    if (cost !== undefined && cost >= 0) {
      costSum += cost;
      hasCost = true;
    }
  }

  const cacheSplitKnown = hasCacheSplit && !hasUnsplitCached;
  return {
    ...(hasIn ? { inTok: inSum } : {}),
    ...(hasOut ? { outTok: outSum } : {}),
    cachedTok: cachedSum,
    ...(cacheSplitKnown
      ? { cacheReadTok: cacheReadSum, cacheWriteTok: cacheWriteSum }
      : {}),
    cacheSplitKnown,
    ...(hasReasoning ? { reasoningTok: reasoningSum } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(hasCost ? { costUsd: costSum } : {}),
    ...(model ? { model } : {}),
  };
}

function extractMessageText(
  val: string | { value?: string } | undefined,
): string {
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && typeof val.value === "string") {
    return val.value;
  }
  return "";
}

function setAtPath(
  root: Record<string, unknown>,
  keyPath: Array<string | number>,
  value: unknown,
): void {
  if (keyPath.length === 0) return;
  let curr: unknown = root;
  for (let idx = 0; idx < keyPath.length - 1; idx++) {
    const key = keyPath[idx]!;
    const nextKey = keyPath[idx + 1]!;
    if (Array.isArray(curr) && typeof key === "number") {
      if (curr[key] === undefined || curr[key] === null) {
        curr[key] = typeof nextKey === "number" ? [] : {};
      }
      curr = curr[key];
    } else if (curr && typeof curr === "object") {
      const rec = curr as Record<string | number, unknown>;
      if (rec[key] === undefined || rec[key] === null) {
        rec[key] = typeof nextKey === "number" ? [] : {};
      }
      curr = rec[key];
    } else {
      return;
    }
  }
  const lastKey = keyPath[keyPath.length - 1]!;
  if (Array.isArray(curr) && typeof lastKey === "number") {
    curr[lastKey] = value;
  } else if (curr && typeof curr === "object") {
    (curr as Record<string | number, unknown>)[lastKey] = value;
  }
}

function spliceAtPath(
  root: Record<string, unknown>,
  keyPath: Array<string | number>,
  index: number | undefined,
  value: unknown,
): void {
  if (keyPath.length === 0) return;
  let curr: unknown = root;
  for (let idx = 0; idx < keyPath.length - 1; idx++) {
    const key = keyPath[idx]!;
    const nextKey = keyPath[idx + 1]!;
    if (Array.isArray(curr) && typeof key === "number") {
      if (curr[key] === undefined || curr[key] === null) {
        curr[key] = typeof nextKey === "number" ? [] : {};
      }
      curr = curr[key];
    } else if (curr && typeof curr === "object") {
      const rec = curr as Record<string | number, unknown>;
      if (rec[key] === undefined || rec[key] === null) {
        rec[key] = typeof nextKey === "number" ? [] : {};
      }
      curr = rec[key];
    } else {
      return;
    }
  }

  const lastKey = keyPath[keyPath.length - 1]!;
  let targetArr: unknown[] | undefined;
  if (Array.isArray(curr) && typeof lastKey === "number") {
    if (!Array.isArray(curr[lastKey])) curr[lastKey] = [];
    targetArr = curr[lastKey] as unknown[];
  } else if (curr && typeof curr === "object") {
    const rec = curr as Record<string | number, unknown>;
    if (!Array.isArray(rec[lastKey])) rec[lastKey] = [];
    targetArr = rec[lastKey] as unknown[];
  }
  if (!targetArr) return;

  const items = Array.isArray(value) ? value : value !== undefined ? [value] : [];
  if (typeof index === "number" && index >= 0) {
    // Delta kind=2 with index replaces tail from index (VS Code's array truncate+append semantics)
    targetArr.splice(index, targetArr.length - index, ...items);
  } else {
    targetArr.push(...items);
  }
}

export function reconstructVSCodeDeltaJsonl(
  rawText: string,
): VSCodeChatSessionState {
  let state: Record<string, unknown> = {};
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: DeltaRow;
    try {
      row = JSON.parse(trimmed) as DeltaRow;
    } catch {
      continue;
    }
    if (row.kind === 0 && row.v && typeof row.v === "object") {
      state = structuredClone(row.v) as Record<string, unknown>;
    } else if (row.kind === 1 && Array.isArray(row.k)) {
      setAtPath(state, row.k, row.v);
    } else if (row.kind === 2 && Array.isArray(row.k)) {
      spliceAtPath(state, row.k, row.i, row.v);
    }
  }
  return state as VSCodeChatSessionState;
}

async function readWorkspaceJsonFolder(
  wsHashDir: string,
): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(wsHashDir, "workspace.json"), "utf8");
    const parsed = JSON.parse(raw) as { folder?: string; workspace?: string };
    const uri = parsed.folder ?? parsed.workspace;
    if (typeof uri === "string" && uri.trim()) {
      return normalizeWsPath(uri);
    }
  } catch {
    // workspace.json absent or unreadable
  }
  return undefined;
}

const MAX_WORKSPACE_YAML_BYTES = 64 * 1024;

function isRealPathInsideRoot(realRoot: string, realTarget: string): boolean {
  const parsedRoot = path.parse(realRoot);
  if (parsedRoot.root === realRoot) return false;
  const normRoot =
    process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
  const normTarget =
    process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
  const rel = path.relative(normRoot, normTarget);
  if (!rel || rel === "." || rel === "..") return false;
  if (rel.startsWith(".." + path.sep)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

async function readSessionStateWorkspaceYaml(
  sessionDir: string,
  allowedRootDir?: string,
): Promise<{
  workspacePath?: string;
  workspaces: string[];
  sessionId?: string;
  title?: string;
}> {
  const workspaces: string[] = [];
  const pushWs = (raw: unknown): void => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const norm = normalizeWsPath(raw);
    if (norm && !workspaces.includes(norm)) {
      workspaces.push(norm);
    }
  };
  try {
    const yamlPath = path.join(sessionDir, "workspace.yaml");
    const lst = await fs.lstat(yamlPath);
    if (!lst.isFile() && !lst.isSymbolicLink()) {
      return { workspaces };
    }
    const realYaml = await fs.realpath(yamlPath);
    const realRoot = await fs.realpath(allowedRootDir ?? sessionDir);
    if (!isRealPathInsideRoot(realRoot, realYaml)) {
      return { workspaces };
    }
    const st = await fs.stat(realYaml);
    if (!st.isFile() || st.size === 0 || st.size > MAX_WORKSPACE_YAML_BYTES) {
      return { workspaces };
    }
    const raw = await fs.readFile(realYaml, "utf8");
    const parsed: unknown = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      pushWs(rec.cwd);
      pushWs(rec.git_root ?? rec.gitRoot);
      const id =
        typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : undefined;
      const summary =
        typeof rec.summary === "string" && rec.summary.trim()
          ? rec.summary.trim().replace(/\s+/g, " ").slice(0, 80)
          : undefined;
      return {
        workspacePath: workspaces[0],
        workspaces,
        sessionId: id,
        title: summary,
      };
    }
  } catch {
    // workspace.yaml absent or unreadable
  }
  return { workspaces };
}

interface TranscriptRow {
  type?: string;
  event?: string;
  id?: string;
  timestamp?: string | number;
  sessionId?: string;
  parentSessionId?: string;
  model?: string;
  modelId?: string;
  content?: string;
  prompt?: string;
  agentId?: string;
  agentName?: string;
  agentType?: string;
  usage?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function isTranscriptJsonlPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    (norm.includes("/transcripts/") && norm.endsWith(".jsonl")) ||
    (norm.includes("/session-state/") && norm.endsWith("/events.jsonl"))
  );
}

function parseJsonlRows(raw: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rows.push(parsed as TranscriptRow);
      }
    } catch {
      // Ignore partial lines during active writes.
    }
  }
  return rows;
}

export class CopilotVSCodeAdapter implements PassiveIdeAdapter {
  readonly ide = "copilot-vscode" as const;
  private readonly storageDir: string;
  private readonly storageDirs: string[];
  private readonly hasExplicitStorageDir: boolean;
  private readonly explicitCopilotHomeDir?: string;
  private readonly stateCache = new Map<
    string,
    { mtimeMs: number; sizeBytes: number; state: VSCodeChatSessionState }
  >();
  private readonly transcriptDiscoveryCache = new Map<
    string,
    CachedTranscriptDiscoveryMeta
  >();

  constructor(options?: CopilotVSCodeAdapterOptions) {
    const explicit =
      options?.storageDir?.trim() || process.env.VSCODE_STORAGE_DIR?.trim();
    this.hasExplicitStorageDir = Boolean(explicit);
    if (explicit) {
      this.storageDir = explicit;
      this.storageDirs = [explicit];
    } else {
      this.storageDirs = defaultVSCodeStorageDirs();
      this.storageDir = this.storageDirs[0]!;
    }
    this.explicitCopilotHomeDir = options?.copilotHomeDir?.trim() || undefined;
  }

  getStorageDirs(): string[] {
    return [...this.storageDirs];
  }

  getCopilotHomeDir(): string {
    return resolveCopilotHomeDir(os.homedir(), this.explicitCopilotHomeDir);
  }

  private shouldDiscoverSessionState(): boolean {
    return Boolean(
      this.explicitCopilotHomeDir ||
        process.env.COPILOT_HOME?.trim() ||
        !this.hasExplicitStorageDir,
    );
  }

  private getDefaultAllowedTranscriptRoots(workspacePath?: string): string[] {
    const roots = new Set<string>(this.storageDirs);
    const home = os.homedir();
    roots.add(this.getCopilotHomeDir());
    roots.add(path.join(home, ".copilot"));
    roots.add(path.join(home, ".claude"));
    roots.add(path.join(home, ".gemini"));
    try {
      for (const proj of listProjects()) {
        if (proj.root) roots.add(proj.root);
      }
    } catch {
      // Registry unreadable
    }
    if (workspacePath && workspacePath.trim()) {
      roots.add(workspacePath.trim());
    }
    return [...roots];
  }

  private async loadChatSessionState(
    filePath: string,
    mtimeMs: number,
    sizeBytes: number,
  ): Promise<VSCodeChatSessionState | null> {
    const cached = this.stateCache.get(filePath);
    if (
      cached &&
      cached.mtimeMs === mtimeMs &&
      cached.sizeBytes === sizeBytes
    ) {
      return cached.state;
    }

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }

    let state: VSCodeChatSessionState;
    try {
      if (filePath.endsWith(".jsonl")) {
        state = reconstructVSCodeDeltaJsonl(raw);
      } else {
        state = JSON.parse(raw) as VSCodeChatSessionState;
      }
    } catch {
      return null;
    }

    this.stateCache.set(filePath, { mtimeMs, sizeBytes, state });
    return state;
  }

  async getHealth(): Promise<AdapterHealth> {
    const existingDirs: string[] = [];
    for (const dir of this.storageDirs) {
      try {
        const st = await fs.stat(dir);
        if (st.isDirectory()) existingDirs.push(dir);
      } catch {
        // Variant not installed
      }
    }
    if (existingDirs.length === 0) {
      if (this.shouldDiscoverSessionState()) {
        const sessionStateDir = path.join(
          this.getCopilotHomeDir(),
          "session-state",
        );
        try {
          const sst = await fs.stat(sessionStateDir);
          if (sst.isDirectory()) {
            const sessions = await this.discoverSessions({ limit: 50 });
            return {
              ide: this.ide,
              status: "ok",
              rootDir: sessionStateDir,
              sessionsFound: sessions.length,
            };
          }
        } catch {
          // session-state not present
        }
      }
      return {
        ide: this.ide,
        status: "degraded",
        rootDir: this.storageDir,
        sessionsFound: 0,
        message: "VS Code workspaceStorage directory not found",
      };
    }
    const sessions = await this.discoverSessions({ limit: 50 });
    return {
      ide: this.ide,
      status: "ok",
      rootDir: existingDirs[0]!,
      sessionsFound: sessions.length,
    };
  }

  async discoverSessions(opts?: {
    limit?: number;
    workspaceRoots?: string[];
  }): Promise<DiscoveredSession[]> {
    const knownProjects = getKnownProjects();
    const byId = new Map<string, DiscoveredSession>();
    const limit = opts?.limit ?? 100;

    interface TranscriptCandidate {
      filePath: string;
      fname: string;
      sessionIdHint?: string;
      titleHint?: string;
      mtimeMs: number;
      sizeBytes: number;
      workspacePath?: string;
      workspaces?: string[];
      projectId?: string;
    }
    const transcriptCandidates: TranscriptCandidate[] = [];

    for (const baseStorageDir of this.storageDirs) {
      let hashDirs: string[];
      try {
        hashDirs = await fs.readdir(baseStorageDir);
      } catch {
        continue;
      }

      for (const hdir of hashDirs) {
        const wsDir = path.join(baseStorageDir, hdir);
        const workspacePath = await readWorkspaceJsonFolder(wsDir);
        const workspaces = workspacePath ? [workspacePath] : [];
        const projectId =
          matchProjectIdForWorkspaces(workspaces, knownProjects) ??
          (workspacePath ? path.basename(workspacePath) : undefined);

        // 1. chatSessions/*.json(l)
        const chatDir = path.join(wsDir, "chatSessions");
        let chatFiles: string[] = [];
        try {
          chatFiles = await fs.readdir(chatDir);
        } catch {
          chatFiles = [];
        }

        for (const fname of chatFiles) {
          if (!fname.endsWith(".json") && !fname.endsWith(".jsonl")) continue;
          const filePath = path.join(chatDir, fname);
          let fst;
          try {
            fst = await fs.stat(filePath);
            if (!fst.isFile() || fst.size === 0) continue;
          } catch {
            continue;
          }

          const state = await this.loadChatSessionState(
            filePath,
            fst.mtimeMs,
            fst.size,
          );
          if (!state) continue;

          const requests = Array.isArray(state.requests) ? state.requests : [];
          const sessionId =
            state.sessionId || fname.replace(/\.jsonl?$/i, "");

          const firstPrompt = requests[0]?.message?.text
            ?.replace(/\s+/g, " ")
            .trim();
          const title =
            state.customTitle?.trim() ||
            firstPrompt?.slice(0, 80) ||
            `Copilot ${sessionId.slice(0, 8)}`;

          let hasSubagent = false;
          for (const req of requests) {
            for (const resp of req.response ?? []) {
              const tid = (resp.toolId ?? resp.toolName ?? "").toLowerCase();
              if (isSubagentToolName(tid)) {
                hasSubagent = true;
                break;
              }
            }
            if (hasSubagent) break;
          }

          const lastReq = requests[requests.length - 1];
          const lastAnalysis = lastReq
            ? analyzeCopilotRequestQuestions(lastReq)
            : undefined;

          const candidate: DiscoveredSession = {
            ide: this.ide,
            sessionId,
            filePath,
            workspacePath,
            workspaces: workspacePath ? [workspacePath] : [],
            projectId,
            title,
            mtimeMs: fst.mtimeMs,
            sizeBytes: fst.size,
            isMultiAgent: hasSubagent,
            waitingOn: lastAnalysis?.waitingOn ?? null,
            pendingQuestionCount: lastAnalysis?.pendingQuestionCount ?? 0,
            ...(lastAnalysis?.waitingSummary
              ? { waitingSummary: lastAnalysis.waitingSummary }
              : {}),
            ...(lastAnalysis?.waitingOn
              ? { status: "WAITING" as AgentStatus, isWaiting: true }
              : lastReq?.modelState?.completedAt || lastReq?.result
                ? { status: "DONE" as AgentStatus, isCompleted: true }
                : {}),
          };
          const prev = byId.get(sessionId);
          if (!prev || candidate.mtimeMs > prev.mtimeMs) {
            byId.set(sessionId, candidate);
          }
        }

        // 2. Collect GitHub.copilot-chat/transcripts/*.jsonl stats first
        const transcriptsDir = path.join(
          wsDir,
          "GitHub.copilot-chat",
          "transcripts",
        );
        let transcriptFiles: string[] = [];
        try {
          transcriptFiles = await fs.readdir(transcriptsDir);
        } catch {
          transcriptFiles = [];
        }

        for (const fname of transcriptFiles) {
          if (!fname.endsWith(".jsonl")) continue;
          const rawFilePath = path.resolve(path.join(transcriptsDir, fname));
          const validPath = await validateTranscriptPath(
            rawFilePath,
            [baseStorageDir],
            { maxBytes: MAX_TRANSCRIPT_BYTES },
          );
          if (!validPath) continue;
          let fst;
          try {
            fst = await fs.stat(validPath);
            if (!fst.isFile() || fst.size === 0 || fst.size > MAX_TRANSCRIPT_BYTES) {
              continue;
            }
          } catch {
            continue;
          }
          transcriptCandidates.push({
            filePath: validPath,
            fname,
            mtimeMs: fst.mtimeMs,
            sizeBytes: fst.size,
            workspacePath,
            workspaces,
            projectId,
          });
        }
      }
    }

    // 3. Collect $COPILOT_HOME/session-state/*/events.jsonl
    if (this.shouldDiscoverSessionState()) {
      const copilotHome = this.getCopilotHomeDir();
      const sessionStateDir = path.join(copilotHome, "session-state");
      let stateEntries: string[] = [];
      try {
        const realCopilotHome = await fs.realpath(copilotHome);
        const realSessionState = await fs.realpath(sessionStateDir);
        if (isRealPathInsideRoot(realCopilotHome, realSessionState)) {
          stateEntries = await fs.readdir(realSessionState);
        }
      } catch {
        stateEntries = [];
      }
      for (const sdir of stateEntries) {
        const dirPath = path.join(sessionStateDir, sdir);
        const eventsPath = path.resolve(path.join(dirPath, "events.jsonl"));
        const validEventsPath = await validateTranscriptPath(
          eventsPath,
          [sessionStateDir],
          { maxBytes: MAX_TRANSCRIPT_BYTES },
        );
        if (!validEventsPath) continue;
        let fst;
        try {
          fst = await fs.stat(validEventsPath);
          if (!fst.isFile() || fst.size === 0 || fst.size > MAX_TRANSCRIPT_BYTES) {
            continue;
          }
        } catch {
          continue;
        }
        const wsMeta = await readSessionStateWorkspaceYaml(dirPath, sessionStateDir);
        const projectId =
          matchProjectIdForWorkspaces(wsMeta.workspaces, knownProjects) ??
          (wsMeta.workspacePath ? path.basename(wsMeta.workspacePath) : undefined);
        transcriptCandidates.push({
          filePath: validEventsPath,
          fname: "events.jsonl",
          sessionIdHint: wsMeta.sessionId ?? sdir,
          titleHint: wsMeta.title,
          mtimeMs: fst.mtimeMs,
          sizeBytes: fst.size,
          workspacePath: wsMeta.workspacePath,
          workspaces: wsMeta.workspaces,
          projectId,
        });
      }
    }

    // Stat-sort transcripts desc and slice before reading/parsing, using (mtimeMs, sizeBytes) cache
    transcriptCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const cand of transcriptCandidates.slice(0, Math.max(limit * 2, 50))) {
      let meta = this.transcriptDiscoveryCache.get(cand.filePath);
      if (
        !meta ||
        meta.mtimeMs !== cand.mtimeMs ||
        meta.sizeBytes !== cand.sizeBytes
      ) {
        let raw = "";
        try {
          raw = await fs.readFile(cand.filePath, "utf8");
        } catch {
          continue;
        }
        const rows = parseJsonlRows(raw);
        if (rows.length === 0) continue;

        let sessionId = cand.sessionIdHint || cand.fname.replace(/\.jsonl$/i, "");
        let title = cand.titleHint || `Copilot ${sessionId.slice(0, 8)}`;
        const extractedWorkspaces: string[] = [];
        let isMultiAgent = false;
        let isSubagentTranscript = false;
        const distinctAgents = new Set<string>();
        let openAskCallId: string | null = null;
        let pendingQuestionCount = 0;
        let waitingSummary: string | undefined;

        for (const row of rows) {
          const rtype = (row.type ?? row.event ?? "").toLowerCase();
          const d =
            row.data && typeof row.data === "object" ? row.data : undefined;
          if (rtype === "session.start") {
            const sid =
              (typeof d?.sessionId === "string" && d.sessionId.trim()) ||
              (typeof row.sessionId === "string" && row.sessionId.trim());
            if (sid) sessionId = sid;
            if (
              (typeof d?.parentSessionId === "string" &&
                d.parentSessionId.trim()) ||
              (typeof row.parentSessionId === "string" &&
                row.parentSessionId.trim())
            ) {
              isSubagentTranscript = true;
            }
            const ctxObj =
              d?.context &&
              typeof d.context === "object" &&
              !Array.isArray(d.context)
                ? (d.context as Record<string, unknown>)
                : undefined;
            for (const rawWs of [
              ctxObj?.cwd,
              ctxObj?.gitRoot,
              ctxObj?.git_root,
              d?.cwd,
              d?.workspacePath,
              (row as Record<string, unknown>).cwd,
            ]) {
              if (typeof rawWs === "string" && rawWs.trim()) {
                const norm = normalizeWsPath(rawWs);
                if (norm && !extractedWorkspaces.includes(norm)) {
                  extractedWorkspaces.push(norm);
                }
              }
            }
          }
          if (rtype === "user.message") {
            openAskCallId = null;
            pendingQuestionCount = 0;
            waitingSummary = undefined;
            if (title.startsWith("Copilot ")) {
              const txt =
                (typeof d?.content === "string" && d.content) ||
                (typeof d?.transformedContent === "string" &&
                  d.transformedContent) ||
                (typeof row.content === "string" && row.content) ||
                (typeof row.prompt === "string" && row.prompt) ||
                "";
              const clean = txt.replace(/\s+/g, " ").trim();
              if (clean) title = clean.slice(0, 80);
            }
          }
          if (rtype === "assistant.message" && Array.isArray(d?.toolRequests)) {
            for (const tr of d.toolRequests as Array<Record<string, unknown>>) {
              const tname = String(tr.name ?? tr.toolName ?? "").toLowerCase();
              if (isCopilotAskTool(tname)) {
                const args =
                  tr.arguments && typeof tr.arguments === "object"
                    ? (tr.arguments as Record<string, unknown>)
                    : {};
                const qs = normalizePendingQuestions(args, {
                  defaultAllowCustomInput: true,
                });
                openAskCallId =
                  typeof tr.toolCallId === "string" ? tr.toolCallId : "__ask__";
                pendingQuestionCount = Math.max(1, qs.length);
                waitingSummary =
                  cleanHumanSummary(
                    qs[0]?.header ?? qs[0]?.question ?? "Waiting for user answer",
                    80,
                  ) || "Waiting for user answer";
              }
            }
          }
          if (rtype === "tool.execution_start") {
            const tname = String(
              d?.mcpToolName ?? d?.toolName ?? "",
            ).toLowerCase();
            if (isCopilotAskTool(tname)) {
              const args =
                d?.arguments && typeof d.arguments === "object"
                  ? (d.arguments as Record<string, unknown>)
                  : {};
              const qs = normalizePendingQuestions(args, {
                defaultAllowCustomInput: true,
              });
              openAskCallId =
                typeof d?.toolCallId === "string" ? d.toolCallId : "__ask__";
              pendingQuestionCount = Math.max(1, qs.length);
              waitingSummary =
                cleanHumanSummary(
                  qs[0]?.header ?? qs[0]?.question ?? "Waiting for user answer",
                  80,
                ) || "Waiting for user answer";
            }
          }
          if (rtype === "tool.execution_complete") {
            const callId =
              typeof d?.toolCallId === "string" ? d.toolCallId : undefined;
            if (openAskCallId && (!callId || callId === openAskCallId)) {
              openAskCallId = null;
              pendingQuestionCount = 0;
              waitingSummary = undefined;
            }
          }
          if (rtype === "assistant.turn_end") {
            openAskCallId = null;
            pendingQuestionCount = 0;
            waitingSummary = undefined;
          }
          if (rtype.startsWith("subagent.")) {
            isMultiAgent = true;
          }
          const aid =
            (typeof d?.agentName === "string" && d.agentName) ||
            (typeof row.agentName === "string" && row.agentName) ||
            undefined;
          if (aid) distinctAgents.add(aid);
        }

        meta = {
          mtimeMs: cand.mtimeMs,
          sizeBytes: cand.sizeBytes,
          sessionId,
          title,
          workspacePath: extractedWorkspaces[0],
          workspaces: extractedWorkspaces,
          isMultiAgent,
          isSubagentTranscript,
          distinctAgentsCount: distinctAgents.size,
          waitingOn: openAskCallId ? "user" : null,
          pendingQuestionCount,
          waitingSummary,
        };
        this.transcriptDiscoveryCache.set(cand.filePath, meta);
      }

      if (meta.isSubagentTranscript) continue;

      const mergedWorkspaces: string[] = [];
      for (const ws of [...(cand.workspaces ?? []), ...meta.workspaces]) {
        if (ws && !mergedWorkspaces.includes(ws)) {
          mergedWorkspaces.push(ws);
        }
      }
      const resolvedWs = cand.workspacePath ?? meta.workspacePath ?? mergedWorkspaces[0];
      const resolvedProj =
        cand.projectId ??
        (mergedWorkspaces.length > 0
          ? matchProjectIdForWorkspaces(mergedWorkspaces, knownProjects) ??
            (resolvedWs ? path.basename(resolvedWs) : undefined)
          : undefined);

      const prev = byId.get(meta.sessionId);
      if (prev) {
        prev.mtimeMs = Math.max(prev.mtimeMs, cand.mtimeMs);
        prev.isMultiAgent =
          prev.isMultiAgent ||
          meta.isMultiAgent ||
          meta.distinctAgentsCount > 1;
        if (!prev.workspacePath && resolvedWs) {
          prev.workspacePath = resolvedWs;
        }
        for (const ws of mergedWorkspaces) {
          if (ws && !prev.workspaces.includes(ws)) {
            prev.workspaces.push(ws);
          }
        }
        if (!prev.projectId && resolvedProj) {
          prev.projectId = resolvedProj;
        }
        if (prev.title?.startsWith("Copilot ") && !meta.title.startsWith("Copilot ")) {
          prev.title = meta.title;
        }
        if (!prev.waitingOn && meta.waitingOn) {
          prev.waitingOn = meta.waitingOn;
          prev.pendingQuestionCount = meta.pendingQuestionCount;
          prev.waitingSummary = meta.waitingSummary;
          prev.status = "WAITING";
          prev.isWaiting = true;
        }
      } else {
        byId.set(meta.sessionId, {
          ide: this.ide,
          sessionId: meta.sessionId,
          filePath: cand.filePath,
          workspacePath: resolvedWs,
          workspaces: mergedWorkspaces.length > 0 ? mergedWorkspaces : resolvedWs ? [resolvedWs] : [],
          projectId: resolvedProj,
          title: meta.title,
          mtimeMs: cand.mtimeMs,
          sizeBytes: cand.sizeBytes,
          isMultiAgent: meta.isMultiAgent || meta.distinctAgentsCount > 1,
          waitingOn: meta.waitingOn,
          pendingQuestionCount: meta.pendingQuestionCount,
          ...(meta.waitingSummary ? { waitingSummary: meta.waitingSummary } : {}),
          ...(meta.waitingOn ? { status: "WAITING", isWaiting: true } : {}),
        });
      }
    }

    const scopeRoots = (opts?.workspaceRoots ?? []).filter(
      (r) => typeof r === "string" && r.trim().length > 0,
    );
    let sessions = [...byId.values()];
    if (scopeRoots.length > 0) {
      sessions = sessions.filter((s) => {
        const wsList = [
          ...(s.workspacePath ? [s.workspacePath] : []),
          ...s.workspaces,
        ].filter(Boolean);
        return wsList.some((w) =>
          scopeRoots.some((root) => pathMatchesRoot(w, root)),
        );
      });
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions.slice(0, limit);
  }

  async parseTranscriptFile(
    filePath: string,
    sessionId: string,
    agentIdOrOpts?: string | CopilotTranscriptParseOptions,
    maybeOpts?: CopilotTranscriptParseOptions,
  ): Promise<EnrichedEvent[]> {
    const opts: CopilotTranscriptParseOptions =
      typeof agentIdOrOpts === "string"
        ? { ...(maybeOpts ?? {}), agentIdOverride: agentIdOrOpts }
        : { ...(agentIdOrOpts ?? {}) };

    const allowedRoots =
      opts.allowedRoots ??
      this.getDefaultAllowedTranscriptRoots(opts.workspacePath);
    const validPath = await validateTranscriptPath(filePath, allowedRoots, {
      maxBytes: MAX_TRANSCRIPT_BYTES,
    });
    if (!validPath) return [];

    let raw: string;
    let mtimeMs = Date.now();
    try {
      const fst = await fs.stat(validPath);
      if (!fst.isFile() || fst.size > MAX_TRANSCRIPT_BYTES) {
        return [];
      }
      mtimeMs = fst.mtimeMs;
      raw = await fs.readFile(validPath, "utf8");
    } catch {
      return [];
    }

    const rows = parseJsonlRows(raw);
    if (rows.length === 0) return [];

    const knownProjects = getKnownProjects();
    const workspacePath = opts.workspacePath;
    const projectId =
      opts.projectId ??
      (workspacePath
        ? matchProjectIdForWorkspaces([workspacePath], knownProjects) ??
          path.basename(workspacePath)
        : undefined);

    const events: EnrichedEvent[] = [];
    const defaultAgentId = opts.agentIdOverride?.trim() || "root";
    const defaultParentId =
      opts.parentAgentIdOverride ??
      (defaultAgentId !== "root" ? "root" : undefined);

    interface TranscriptUsageAcc {
      model?: string;
      hasExact: boolean;
      hasIncrementalExact: boolean;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      hasCacheSplit: boolean;
      hasUnsplitCached: boolean;
      reasoningTokens: number;
      hasExactReasoning: boolean;
      lastTurnContext: number;
      contextWindow?: number;
      cumulativeFallback?: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        hasCacheSplit?: boolean;
        reasoningTokens?: number;
        hasExactReasoning?: boolean;
        costUsd?: number;
      };
      estInputChars: number;
      estOutputChars: number;
      priorBoundedProseChars: number;
      currTurnProseChars: number;
      currTurnChars: number;
      costUsd?: number;
      agentLabel?: string;
    }
    const usageAccByAgent = new Map<string, TranscriptUsageAcc>();
    const ensureAcc = (aid: string): TranscriptUsageAcc => {
      let acc = usageAccByAgent.get(aid);
      if (!acc) {
        acc = {
          hasExact: false,
          hasIncrementalExact: false,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          hasCacheSplit: false,
          hasUnsplitCached: false,
          reasoningTokens: 0,
          hasExactReasoning: false,
          lastTurnContext: 0,
          estInputChars: 0,
          estOutputChars: 0,
          priorBoundedProseChars: 0,
          currTurnProseChars: 0,
          currTurnChars: 0,
        };
        usageAccByAgent.set(aid, acc);
      }
      return acc;
    };

    const emittedProseCompletionByAgent = new Map<string, boolean>();
    const toolSummaryMap = new Map<
      string,
      {
        toolName: string;
        summary: string;
        agentId: string;
        isAskTool?: boolean;
        questionPrompt?: string;
      }
    >();
    const subagentIdByCallId = new Map<
      string,
      { subId: string; subLabel: string }
    >();
    const usedSubagentSlugs = new Set<string>();
    let fallbackEpoch = mtimeMs / 1000 - Math.max(rows.length, 1);

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx]!;
      const rtype = (row.type ?? row.event ?? "").toLowerCase();
      const d =
        row.data && typeof row.data === "object" && !Array.isArray(row.data)
          ? row.data
          : (row as Record<string, unknown>);
      const epoch = parseEpochSeconds(
        (d.timestamp as string | number | undefined) ?? row.timestamp,
        fallbackEpoch + idx,
      );
      fallbackEpoch = epoch;

      const rowAgentRaw =
        (typeof d.agentId === "string" && d.agentId.trim()) ||
        (typeof row.agentId === "string" && row.agentId.trim()) ||
        undefined;
      const agentId = opts.agentIdOverride
        ? defaultAgentId
        : rowAgentRaw && rowAgentRaw !== "root"
          ? rowAgentRaw
          : defaultAgentId;
      const parentAgentId =
        agentId !== "root" ? defaultParentId ?? "root" : undefined;

      const acc = ensureAcc(agentId);
      if (
        opts.agentLabelOverride &&
        !isOpaqueAgentId(opts.agentLabelOverride) &&
        !acc.agentLabel
      ) {
        acc.agentLabel = opts.agentLabelOverride;
      }

      const rawLabelCandidates = [
        d.agentDisplayName,
        d.agentName,
        d.agentType,
        d.subAgentName,
        d.subagentName,
        row.agentName,
        row.agentType,
      ];
      const rawLabel = rawLabelCandidates.find(
        (v): v is string =>
          typeof v === "string" && Boolean(v.trim()) && !isOpaqueAgentId(v),
      )?.trim();
      if (rawLabel && !rtype.startsWith("subagent.") && !acc.agentLabel) {
        acc.agentLabel = rawLabel;
      }

      const rowModelRaw =
        (typeof d.newModel === "string" && d.newModel.trim()) ||
        (typeof d.selectedModel === "string" && d.selectedModel.trim()) ||
        (typeof d.model === "string" && d.model.trim()) ||
        (typeof d.modelId === "string" && d.modelId.trim()) ||
        (typeof row.model === "string" && row.model.trim()) ||
        (typeof row.modelId === "string" && row.modelId.trim()) ||
        undefined;
      if (rowModelRaw && !rtype.startsWith("subagent.")) {
        const pretty = prettifyModelName(rowModelRaw) || rowModelRaw;
        if (pretty) acc.model = pretty;
      }

      const usageCandidate =
        (d.usage && typeof d.usage === "object" && !Array.isArray(d.usage)
          ? (d.usage as Record<string, unknown>)
          : undefined) ??
        (row.usage &&
        typeof row.usage === "object" &&
        !Array.isArray(row.usage)
          ? row.usage
          : undefined) ??
        d;
      const u = extractUsageNumbers(usageCandidate);
      const dataMeta = extractUsageNumbers(d);
      const rowMeta = extractUsageNumbers(row as Record<string, unknown>);
      const rowContextWindow =
        u.contextWindow ?? dataMeta.contextWindow ?? rowMeta.contextWindow;
      if (rowContextWindow !== undefined && rowContextWindow > 0) {
        acc.contextWindow = rowContextWindow;
      }

      const isIncrementalUsageRow =
        rtype === "assistant.message" ||
        rtype === "assistant.usage" ||
        rtype === "session.usage_record";
      const isCumulativeUsageRow =
        rtype === "session.usage_checkpoint" || rtype === "session.shutdown";

      if (isIncrementalUsageRow) {
        if (
          u.inTok !== undefined ||
          u.outTok !== undefined ||
          u.contextTok !== undefined
        ) {
          const norm = normalizeCopilotUsage({
            inTok: u.inTok,
            outTok: u.outTok,
            cachedTok: u.cachedTok,
            contextTok: u.contextTok,
          });
          acc.hasExact = true;
          acc.hasIncrementalExact = true;
          acc.inputTokens += norm.freshIn;
          acc.outputTokens += norm.outTok;
          acc.cachedTokens += norm.cachedTok;
          if (u.cacheSplitKnown) {
            acc.hasCacheSplit = true;
            acc.cacheReadTokens += u.cacheReadTok ?? 0;
            acc.cacheWriteTokens += u.cacheWriteTok ?? 0;
          } else if (norm.cachedTok > 0) {
            acc.hasUnsplitCached = true;
          }
          const rTok = u.reasoningTok ?? dataMeta.reasoningTok;
          if (rTok !== undefined) {
            acc.hasExactReasoning = true;
            acc.reasoningTokens += rTok;
          }
          if (norm.turnContext !== undefined) {
            acc.lastTurnContext = norm.turnContext;
          }
        }
        if (u.costUsd !== undefined && u.costUsd >= 0) {
          acc.costUsd = (acc.costUsd ?? 0) + u.costUsd;
        }
      } else if (isCumulativeUsageRow) {
        const mm =
          rtype === "session.shutdown" && d.modelMetrics
            ? extractModelMetricsUsage(d.modelMetrics)
            : undefined;
        if (mm?.contextWindow !== undefined && mm.contextWindow > 0) {
          acc.contextWindow = mm.contextWindow;
        }
        if (mm?.model && !acc.model) {
          acc.model = mm.model;
        }
        if (rtype === "session.usage_checkpoint") {
          const ckCtx = u.contextTok ?? dataMeta.contextTok;
          if (ckCtx !== undefined) {
            acc.lastTurnContext = Math.max(0, Math.round(ckCtx));
          }
        }
        const cumIn = mm?.inTok ?? u.inTok;
        const cumOut = mm?.outTok ?? u.outTok;
        const cumCached = mm && (mm.inTok !== undefined || mm.outTok !== undefined)
          ? mm.cachedTok
          : u.cachedTok;
        const cumSplitKnown =
          mm && (mm.inTok !== undefined || mm.outTok !== undefined)
            ? mm.cacheSplitKnown
            : u.cacheSplitKnown;
        const cumCacheRead =
          mm && (mm.inTok !== undefined || mm.outTok !== undefined)
            ? mm.cacheReadTok
            : u.cacheReadTok;
        const cumCacheWrite =
          mm && (mm.inTok !== undefined || mm.outTok !== undefined)
            ? mm.cacheWriteTok
            : u.cacheWriteTok;
        const cumReasoning =
          mm?.reasoningTok ?? u.reasoningTok ?? dataMeta.reasoningTok;
        const cumCost = mm?.costUsd ?? u.costUsd;
        if (cumIn !== undefined || cumOut !== undefined) {
          const norm = normalizeCopilotUsage({
            inTok: cumIn,
            outTok: cumOut,
            cachedTok: cumCached,
          });
          acc.cumulativeFallback = {
            inputTokens: norm.freshIn,
            outputTokens: norm.outTok,
            cachedTokens: norm.cachedTok,
            ...(cumSplitKnown
              ? {
                  cacheReadTokens: cumCacheRead ?? 0,
                  cacheWriteTokens: cumCacheWrite ?? 0,
                  hasCacheSplit: true,
                }
              : {}),
            ...(cumReasoning !== undefined
              ? { reasoningTokens: cumReasoning, hasExactReasoning: true }
              : {}),
            ...(cumCost !== undefined && cumCost >= 0 ? { costUsd: cumCost } : {}),
          };
        }
      } else if (
        u.inTok !== undefined ||
        u.outTok !== undefined ||
        u.contextTok !== undefined
      ) {
        const norm = normalizeCopilotUsage({
          inTok: u.inTok,
          outTok: u.outTok,
          cachedTok: u.cachedTok,
          contextTok: u.contextTok,
        });
        acc.hasExact = true;
        acc.hasIncrementalExact = true;
        acc.inputTokens += norm.freshIn;
        acc.outputTokens += norm.outTok;
        acc.cachedTokens += norm.cachedTok;
        if (u.cacheSplitKnown) {
          acc.hasCacheSplit = true;
          acc.cacheReadTokens += u.cacheReadTok ?? 0;
          acc.cacheWriteTokens += u.cacheWriteTok ?? 0;
        } else if (norm.cachedTok > 0) {
          acc.hasUnsplitCached = true;
        }
        const rTok = u.reasoningTok ?? dataMeta.reasoningTok;
        if (rTok !== undefined) {
          acc.hasExactReasoning = true;
          acc.reasoningTokens += rTok;
        }
        if (norm.turnContext !== undefined) {
          acc.lastTurnContext = norm.turnContext;
        }
        if (u.costUsd !== undefined && u.costUsd >= 0) {
          acc.costUsd = (acc.costUsd ?? 0) + u.costUsd;
        }
      }

      const agentLabel =
        acc.agentLabel ||
        (agentId === "root" ? "Copilot Agent" : undefined);

      const emit = (input: {
        epoch?: number;
        kind: EnrichedEvent["kind"];
        toolName?: string;
        toolCallId?: string;
        targetAgentId?: string;
        summary: string;
        payload?: Record<string, unknown>;
        status?: EnrichedEvent["status"];
        isSelfDaemon?: boolean;
        isError?: boolean;
        waitingReason?: EnrichedEvent["waitingReason"];
        fullBody?: string;
        inlineBody?: string;
        overrideAgentId?: string;
        overrideAgentLabel?: string;
        overrideParentAgentId?: string;
      }): void => {
        const evEpoch = input.epoch ?? epoch;
        const evAgentId = input.overrideAgentId ?? agentId;
        const evAgentLabel = input.overrideAgentLabel ?? agentLabel;
        const evParentId =
          input.overrideParentAgentId ??
          (evAgentId !== "root" ? parentAgentId ?? "root" : undefined);
        const id = computeDeterministicEventId({
          ide: this.ide,
          sessionId,
          agentId: evAgentId,
          kind: input.kind,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          epoch: evEpoch,
          summary: input.summary,
        });
        const mergeKey = computeMergeKey({
          sessionId,
          agentId: evAgentId,
          kind: input.kind,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          epoch: evEpoch,
        });
        const hasBody =
          typeof input.fullBody === "string" && input.fullBody.length > 0;
        const bodyLength = hasBody ? input.fullBody!.length : undefined;
        const bodyTruncated = hasBody
          ? input.fullBody!.length > (input.inlineBody?.length ?? 0)
          : undefined;
        events.push({
          id,
          mergeKey,
          ts: toIsoUtc(evEpoch),
          epoch: evEpoch,
          ide: this.ide,
          channel: "passive",
          sessionId,
          workspacePath,
          projectId,
          agentId: evAgentId,
          ...(evAgentLabel ? { agentLabel: evAgentLabel } : {}),
          ...(evParentId ? { parentAgentId: evParentId } : {}),
          kind: input.kind,
          toolName: input.toolName,
          toolCallId: input.toolCallId,
          targetAgentId: input.targetAgentId,
          summary: input.summary,
          payload: input.payload,
          ...(bodyLength !== undefined ? { bodyLength } : {}),
          ...(bodyTruncated !== undefined ? { bodyTruncated } : {}),
          status: input.status,
          isSelfDaemon: input.isSelfDaemon,
          isError: input.isError,
          waitingReason: input.waitingReason,
        });
        if (hasBody) {
          opts.onFullBody?.(id, input.fullBody!);
        }
      };

      if (rtype === "session.start") {
        emit({
          kind: "session_start",
          summary: "Session started",
          payload: {
            ...(rowModelRaw ? { model: rowModelRaw } : {}),
          },
        });
      } else if (rtype === "user.message") {
        emittedProseCompletionByAgent.set(agentId, false);
        const txt = (
          (typeof d.content === "string" && d.content) ||
          (typeof d.transformedContent === "string" && d.transformedContent) ||
          (typeof row.content === "string" && row.content) ||
          (typeof row.prompt === "string" && row.prompt) ||
          ""
        ).trim();
        if (txt) {
          if (acc.currTurnChars > 0) {
            acc.priorBoundedProseChars += Math.min(4000, acc.currTurnProseChars);
            acc.currTurnProseChars = 0;
            acc.currTurnChars = 0;
          }
          acc.estInputChars += txt.length;
          acc.currTurnProseChars += txt.length;
          acc.currTurnChars += txt.length;
          const inlineBody = txt.slice(0, 1400);
          if (agentId !== "root") {
            emit({
              kind: "thinking_start",
              summary: cleanHumanSummary(txt, 130) || "Starting task…",
              payload: { body: inlineBody, prompt: inlineBody },
              fullBody: txt,
              inlineBody,
            });
          } else {
            emit({
              kind: "user_input",
              targetAgentId: agentId,
              summary: `Human: ${cleanHumanSummary(txt, 130)}`,
              payload: {
                body: inlineBody,
                prompt: inlineBody,
                _passiveSource: "transcript",
              },
              fullBody: txt,
              inlineBody,
            });
          }
        }
      } else if (rtype === "assistant.turn_start") {
        emittedProseCompletionByAgent.set(agentId, false);
      } else if (rtype === "assistant.message") {
        const msgText =
          (typeof d.content === "string" && d.content.trim()) || "";
        const reasoning =
          (typeof d.reasoningText === "string" && d.reasoningText.trim()) || "";
        acc.estOutputChars += msgText.length + reasoning.length;
        acc.currTurnProseChars += msgText.length + reasoning.length;
        acc.currTurnChars += msgText.length + reasoning.length;
        if (reasoning) {
          const inlineReasoning = reasoning.slice(0, THINKING_INLINE_MAX);
          emit({
            kind: "thinking_start",
            summary: cleanHumanSummary(reasoning, 100) || "Thinking…",
            payload: { body: inlineReasoning, isThought: true },
            fullBody: reasoning,
            inlineBody: inlineReasoning,
          });
        }
        const toolReqs = Array.isArray(d.toolRequests) ? d.toolRequests : [];
        if (toolReqs.length > 0) {
          if (msgText) {
            const inlineBody = msgText.slice(0, 1000);
            emit({
              kind: "thinking_start",
              summary: cleanHumanSummary(msgText, 140) || "Thinking…",
              payload: { body: inlineBody, isPreToolProse: true },
              fullBody: msgText,
              inlineBody,
            });
          }
          for (let ti = 0; ti < toolReqs.length; ti++) {
            const tr = toolReqs[ti] as Record<string, unknown>;
            const tname =
              (typeof tr.name === "string" && tr.name) ||
              (typeof tr.toolName === "string" && tr.toolName) ||
              "tool";
            const callId =
              (typeof tr.toolCallId === "string" && tr.toolCallId) ||
              `${idx}:${ti}:${tname}`;
            const args =
              tr.arguments &&
              typeof tr.arguments === "object" &&
              !Array.isArray(tr.arguments)
                ? (tr.arguments as Record<string, unknown>)
                : {};
            const lowTool = tname.toLowerCase();
            const isBoardMut = isBoardMutationToolCall(tname, args);
            const isMsgTool = isMessageToolName(lowTool);
            const isAskTool =
              isCopilotAskTool(lowTool) && !isStudioDirectAskTool(lowTool);
            const parsedQuestions = isAskTool
              ? normalizePendingQuestions(args, { defaultAllowCustomInput: true })
              : [];
            const sum = isAskTool
              ? cleanHumanSummary(
                  parsedQuestions[0]?.question ?? "Waiting for user answer",
                  120,
                ) || "Waiting for user answer"
              : summarizeToolCall(tname, args);
            const questionPrompt = isAskTool
              ? parsedQuestions
                  .map((q) => q.question.trim())
                  .filter(Boolean)
                  .join(" / ")
                  .slice(0, 500) || sum
              : undefined;
            acc.currTurnChars += sum.length;
            toolSummaryMap.set(callId, {
              toolName: tname,
              summary: sum,
              agentId,
              ...(isAskTool ? { isAskTool: true, questionPrompt } : {}),
            });
            const msgInfo = isMsgTool ? extractMessagePayload(args) : undefined;
            emit({
              epoch: epoch + (ti + (msgText ? 1 : 0)) * 0.0001,
              kind: isMsgTool
                ? "message"
                : isBoardMut
                  ? "board_mutation"
                  : "tool_start",
              toolName: tname,
              toolCallId: callId,
              ...(isAskTool
                ? { targetAgentId: "human", waitingReason: "user" as const }
                : msgInfo?.msgTarget
                  ? { targetAgentId: msgInfo.msgTarget }
                  : {}),
              summary: sum,
              status: isMsgTool ? "ok" : "running",
              payload: {
                args: msgInfo?.compactArgs ?? args,
                ...(msgInfo?.inlineBody ? { body: msgInfo.inlineBody } : {}),
                ...(isAskTool
                  ? {
                      questions: parsedQuestions,
                      promptKind: "question",
                      blockingToolCall: true,
                    }
                  : {}),
              },
              ...(msgInfo?.msgBody
                ? { fullBody: msgInfo.msgBody, inlineBody: msgInfo.inlineBody }
                : {}),
            });
          }
        } else if (msgText) {
          emittedProseCompletionByAgent.set(agentId, true);
          const inlineBody = msgText.slice(0, 1000);
          emit({
            kind:
              agentId === "root" ? "assistant_turn_end" : "subagent_done",
            summary: cleanHumanSummary(msgText, 140) || "Turn completed",
            status: "ok",
            payload: { body: inlineBody },
            fullBody: msgText,
            inlineBody,
          });
        }
      } else if (rtype === "assistant.turn_end") {
        if (emittedProseCompletionByAgent.get(agentId)) {
          emittedProseCompletionByAgent.set(agentId, false);
        } else {
          emit({
            kind: agentId === "root" ? "assistant_turn_end" : "subagent_done",
            summary: "Turn completed",
            status: "ok",
          });
        }
      } else if (rtype === "tool.execution_start") {
        const tname =
          (typeof d.mcpToolName === "string" && d.mcpToolName) ||
          (typeof d.toolName === "string" && d.toolName) ||
          "tool";
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) ||
          `${idx}:${tname}`;
        const args =
          d.arguments &&
          typeof d.arguments === "object" &&
          !Array.isArray(d.arguments)
            ? (d.arguments as Record<string, unknown>)
            : {};
        const lowTool = tname.toLowerCase();
        const isBoardMut = isBoardMutationToolCall(tname, args);
        const isMsgTool = isMessageToolName(lowTool);
        const isAskTool =
              isCopilotAskTool(lowTool) && !isStudioDirectAskTool(lowTool);
        const parsedQuestions = isAskTool
          ? normalizePendingQuestions(args, { defaultAllowCustomInput: true })
          : [];
        const sum = isAskTool
          ? cleanHumanSummary(
              parsedQuestions[0]?.question ?? "Waiting for user answer",
              120,
            ) || "Waiting for user answer"
          : summarizeToolCall(tname, args);
        const questionPrompt = isAskTool
          ? parsedQuestions
              .map((q) => q.question.trim())
              .filter(Boolean)
              .join(" / ")
              .slice(0, 500) || sum
          : undefined;
        acc.currTurnChars += sum.length;
        const selfDaemon = isSelfDaemonCommand(
          sum + " " + JSON.stringify(args),
        );
        toolSummaryMap.set(callId, {
          toolName: tname,
          summary: sum,
          agentId,
          ...(isAskTool ? { isAskTool: true, questionPrompt } : {}),
        });
        const msgInfo = isMsgTool ? extractMessagePayload(args) : undefined;
        emit({
          kind: isMsgTool
            ? "message"
            : isBoardMut
              ? "board_mutation"
              : "tool_start",
          toolName: tname,
          toolCallId: callId,
          ...(isAskTool
            ? { targetAgentId: "human", waitingReason: "user" as const }
            : msgInfo?.msgTarget
              ? { targetAgentId: msgInfo.msgTarget }
              : {}),
          summary: sum,
          status: isMsgTool ? "ok" : "running",
          isSelfDaemon: selfDaemon,
          payload: {
            args: msgInfo?.compactArgs ?? args,
            ...(msgInfo?.inlineBody ? { body: msgInfo.inlineBody } : {}),
            ...(isAskTool
              ? {
                  questions: parsedQuestions,
                  promptKind: "question",
                  blockingToolCall: true,
                }
              : {}),
          },
          ...(msgInfo?.msgBody
            ? { fullBody: msgInfo.msgBody, inlineBody: msgInfo.inlineBody }
            : {}),
        });
      } else if (rtype === "tool.execution_complete") {
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) || undefined;
        const prev = callId ? toolSummaryMap.get(callId) : undefined;
        const tname =
          (typeof d.toolName === "string" && d.toolName) || prev?.toolName;
        const isErr = d.success === false || d.isError === true || Boolean(d.error);
        const baseLabel = prev?.summary ?? tname ?? "tool call";
        acc.currTurnChars += baseLabel.length;
        emit({
          kind: "tool_end",
          toolName: tname,
          toolCallId: callId,
          summary: cleanHumanSummary(
            isErr ? `Failed: ${baseLabel}` : `Completed: ${baseLabel}`,
            140,
          ),
          status: isErr ? "error" : "ok",
          isError: isErr,
          payload: {
            ...(d.result !== undefined ? { result: d.result } : {}),
            ...(d.error !== undefined ? { error: d.error } : {}),
            ...(!isErr ? { routineEnd: true } : {}),
          },
        });
        const isAsk = Boolean(
          prev?.isAskTool ||
            (tname &&
              isCopilotAskTool(tname.toLowerCase()) &&
              !isStudioDirectAskTool(tname.toLowerCase())),
        );
        if (isAsk && !isErr) {
          const rawOutput = formatToolOutput(d.result);
          const answerText = extractCopilotAnswerText(
            rawOutput || d.result,
          );
          if (answerText) {
            const askingAgentId = prev?.agentId ?? agentId;
            const answerCallId = callId
              ? `${callId}:answer`
              : `${idx}:${tname ?? "ask"}:answer`;
            const cleanAns =
              cleanHumanSummary(answerText, 130) || answerText.slice(0, 130);
            const inlineBody = answerText.slice(0, 1400);
            emit({
              epoch: epoch + 0.0002,
              kind: "user_input",
              toolCallId: answerCallId,
              overrideAgentId: askingAgentId,
              targetAgentId: askingAgentId,
              summary: `Human: ${cleanAns}`,
              payload: {
                isHumanAnswer: true,
                ...(callId ? { questionToolCallId: callId } : {}),
                ...(prev?.questionPrompt
                  ? { questionPrompt: prev.questionPrompt }
                  : {}),
                targetAgentId: askingAgentId,
                body: inlineBody,
              },
              fullBody: answerText,
              inlineBody,
            });
          }
        }
      } else if (
        rtype === "subagent.started" ||
        rtype === "subagent.start"
      ) {
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) || undefined;
        const subLabel =
          [
            d.agentDisplayName,
            d.subAgentName,
            d.subagentName,
            d.agentName,
            d.agentType,
            d.subagentType,
            d.description,
          ]
            .find(
              (v): v is string =>
                typeof v === "string" &&
                Boolean(v.trim()) &&
                !isOpaqueAgentId(v),
            )
            ?.trim() || "Subagent";
        const explicitSubId =
          (typeof d.subAgentInvocationId === "string" &&
            d.subAgentInvocationId.trim() &&
            d.subAgentInvocationId.trim() !== "root" &&
            d.subAgentInvocationId.trim()) ||
          (typeof d.agentId === "string" &&
            d.agentId.trim() &&
            d.agentId.trim() !== "root" &&
            d.agentId.trim()) ||
          (typeof d.subagentId === "string" &&
            d.subagentId.trim() &&
            d.subagentId.trim() !== "root" &&
            d.subagentId.trim()) ||
          undefined;
        const baseSlug =
          subLabel
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "subagent";
        let rawSubId: string;
        if (explicitSubId) {
          rawSubId = explicitSubId;
          usedSubagentSlugs.add(rawSubId);
        } else {
          rawSubId = baseSlug;
          let suffix = 2;
          while (usedSubagentSlugs.has(rawSubId)) {
            rawSubId = `${baseSlug}-${suffix++}`;
          }
          usedSubagentSlugs.add(rawSubId);
        }
        if (callId) {
          subagentIdByCallId.set(callId, { subId: rawSubId, subLabel });
        }
        const subModelRaw =
          typeof d.model === "string" && d.model.trim()
            ? d.model.trim()
            : undefined;
        const subModel = subModelRaw
          ? prettifyModelName(subModelRaw) || subModelRaw
          : undefined;
        const parentAcc = usageAccByAgent.get(defaultAgentId);
        const childContextWindow =
          subModel && parentAcc?.model && subModel === parentAcc.model
            ? parentAcc.contextWindow
            : !subModel
              ? parentAcc?.contextWindow
              : undefined;
        if (subModel) {
          const subAcc = ensureAcc(rawSubId);
          subAcc.model = subModel;
          subAcc.agentLabel = subLabel;
          if (childContextWindow !== undefined) {
            subAcc.contextWindow = childContextWindow;
          }
        }
        const subPrompt =
          typeof d.prompt === "string" ? d.prompt.trim() : "";
        const inlinePrompt = subPrompt ? subPrompt.slice(0, 1000) : "";
        const spawnActorLabel =
          defaultAgentId === "root"
            ? usageAccByAgent.get("root")?.agentLabel || "Copilot Agent"
            : usageAccByAgent.get(defaultAgentId)?.agentLabel ||
              (opts.agentLabelOverride &&
              !isOpaqueAgentId(opts.agentLabelOverride)
                ? opts.agentLabelOverride
                : undefined);
        emit({
          kind: "subagent_spawn",
          toolName: "runSubagent",
          toolCallId: callId,
          targetAgentId: rawSubId,
          overrideAgentId: defaultAgentId,
          overrideAgentLabel: spawnActorLabel,
          overrideParentAgentId:
            defaultAgentId !== "root" ? defaultParentId ?? "root" : undefined,
          summary: `Spawned ${subLabel}`,
          payload: {
            agentLabel: subLabel,
            agentType: subLabel,
            _passiveSource: "transcript",
            ...(subModel
              ? { childModel: subModel, childModelSource: "exact" }
              : {}),
            ...(childContextWindow !== undefined
              ? { childContextWindow }
              : {}),
            ...(inlinePrompt ? { prompt: inlinePrompt } : {}),
          },
          ...(subPrompt
            ? { fullBody: subPrompt, inlineBody: inlinePrompt }
            : {}),
        });
      } else if (
        rtype === "subagent.completed" ||
        rtype === "subagent.stop" ||
        rtype === "subagent.failed"
      ) {
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) || undefined;
        const prevSub = callId ? subagentIdByCallId.get(callId) : undefined;
        const subLabel =
          prevSub?.subLabel ||
          [
            d.agentDisplayName,
            d.subAgentName,
            d.subagentName,
            d.agentName,
            d.agentType,
            d.subagentType,
          ]
            .find(
              (v): v is string =>
                typeof v === "string" &&
                Boolean(v.trim()) &&
                !isOpaqueAgentId(v),
            )
            ?.trim() ||
          "Subagent";
        const rawSubId =
          prevSub?.subId ||
          (typeof d.agentId === "string" && d.agentId.trim()) ||
          (typeof d.subagentId === "string" && d.subagentId.trim()) ||
          subLabel.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") ||
          "subagent";
        const isErr = rtype === "subagent.failed" || Boolean(d.error);
        const doneText =
          typeof d.result === "string"
            ? d.result.trim()
            : typeof d.error === "string"
              ? d.error.trim()
              : "";
        const inlineDone = doneText ? doneText.slice(0, 1000) : "";
        const doneActorLabel =
          defaultAgentId === "root"
            ? usageAccByAgent.get("root")?.agentLabel || "Copilot Agent"
            : usageAccByAgent.get(defaultAgentId)?.agentLabel ||
              (opts.agentLabelOverride &&
              !isOpaqueAgentId(opts.agentLabelOverride)
                ? opts.agentLabelOverride
                : undefined);
        emit({
          kind: "subagent_done",
          toolName: "runSubagent",
          toolCallId: callId,
          targetAgentId: rawSubId,
          overrideAgentId: defaultAgentId,
          overrideAgentLabel: doneActorLabel,
          overrideParentAgentId:
            defaultAgentId !== "root" ? defaultParentId ?? "root" : undefined,
          summary: isErr
            ? `Subagent failed: ${subLabel}`
            : `Subagent finished: ${subLabel}`,
          status: isErr ? "error" : "ok",
          isError: isErr,
          ...(inlineDone ? { payload: { body: inlineDone } } : {}),
          ...(doneText
            ? { fullBody: doneText, inlineBody: inlineDone }
            : {}),
        });
      }
    }

    // Attach finalized per-agent UsageDelta totals onto each agent's last emitted event
    const lastEvByAgent = new Map<string, EnrichedEvent>();
    for (const ev of events) {
      lastEvByAgent.set(ev.agentId, ev);
    }
    for (const [aid, acc] of usageAccByAgent.entries()) {
      const targetEv = lastEvByAgent.get(aid);
      if (!targetEv) continue;
      if (!acc.hasIncrementalExact && acc.cumulativeFallback) {
        acc.hasExact = true;
        acc.inputTokens = acc.cumulativeFallback.inputTokens;
        acc.outputTokens = acc.cumulativeFallback.outputTokens;
        acc.cachedTokens = acc.cumulativeFallback.cachedTokens;
        if (acc.cumulativeFallback.hasCacheSplit) {
          acc.hasCacheSplit = true;
          acc.cacheReadTokens = acc.cumulativeFallback.cacheReadTokens ?? 0;
          acc.cacheWriteTokens = acc.cumulativeFallback.cacheWriteTokens ?? 0;
        } else if (acc.cachedTokens > 0) {
          acc.hasUnsplitCached = true;
        }
        if (acc.cumulativeFallback.hasExactReasoning) {
          acc.hasExactReasoning = true;
          acc.reasoningTokens = acc.cumulativeFallback.reasoningTokens ?? 0;
        }
        if (
          acc.costUsd === undefined &&
          acc.cumulativeFallback.costUsd !== undefined
        ) {
          acc.costUsd = acc.cumulativeFallback.costUsd;
        }
      } else if (acc.lastTurnContext > 0) {
        acc.hasExact = true;
      }
      const inputTokens = acc.hasExact
        ? acc.inputTokens
        : Math.round(acc.estInputChars / 4);
      const outputTokens = acc.hasExact
        ? acc.outputTokens
        : Math.round(acc.estOutputChars / 4);
      const cachedTokens = acc.hasExact ? acc.cachedTokens : 0;
      const contextTokens = acc.hasExact
        ? acc.lastTurnContext
        : Math.round((acc.priorBoundedProseChars + acc.currTurnChars) / 4);
      const hasSplit = acc.hasExact && acc.hasCacheSplit && !acc.hasUnsplitCached;
      const usageDelta: UsageDelta = {
        model: acc.model,
        modelSource: acc.model ? "exact" : "unknown",
        usageSource: acc.hasExact ? "exact" : "estimated",
        inputTokens,
        outputTokens,
        cachedTokens,
        ...(hasSplit
          ? {
              cacheReadTokens: acc.cacheReadTokens,
              cacheWriteTokens: acc.cacheWriteTokens,
            }
          : {}),
        ...(acc.hasExact && acc.hasExactReasoning
          ? {
              reasoningTokens: Math.min(outputTokens, acc.reasoningTokens),
              reasoningSource: "exact" as const,
            }
          : {}),
        contextTokens,
        ...(acc.contextWindow !== undefined
          ? { contextWindow: acc.contextWindow }
          : {}),
        ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
        isTotal: true,
      };
      targetEv.usageDelta = usageDelta;
      targetEv.payload = { ...(targetEv.payload ?? {}), _usageDelta: usageDelta };
    }

    return events;
  }

  async parseSession(
    session: DiscoveredSession,
    opts?: ParseSessionOptions,
  ): Promise<EnrichedEvent[]> {
    if (
      !session.filePath ||
      path.basename(session.filePath).toLowerCase() === "telemetry.jsonl"
    ) {
      return [];
    }

    if (isTranscriptJsonlPath(session.filePath)) {
      return this.parseTranscriptFile(session.filePath, session.sessionId, {
        ...opts,
        workspacePath: session.workspacePath,
        projectId: session.projectId,
      });
    }

    let fst;
    try {
      fst = await fs.stat(session.filePath);
    } catch {
      return [];
    }
    const state = await this.loadChatSessionState(
      session.filePath,
      fst.mtimeMs,
      fst.size,
    );
    if (!state) return [];

    const knownProjects = getKnownProjects();
    const workspacePath = session.workspacePath;
    const projectId =
      matchProjectIdForWorkspaces(
        [workspacePath, ...session.workspaces],
        knownProjects,
      ) ?? session.projectId;

    const selectedModelFallback = extractSelectedModel(
      state.inputState?.selectedModel,
    );
    const selectedModelContextWindow = extractSelectedModelContextWindow(
      state.inputState?.selectedModel,
    );
    const modelWindowMap = new Map<string, number>();
    const recordModelWindow = (rawOrPretty: string | undefined, win: number | undefined): void => {
      if (!rawOrPretty || typeof win !== "number" || !Number.isFinite(win) || win <= 0) {
        return;
      }
      const rounded = Math.round(win);
      const low = rawOrPretty.trim().toLowerCase();
      if (low) modelWindowMap.set(low, rounded);
      const pretty = prettifyModelName(rawOrPretty);
      if (pretty) modelWindowMap.set(pretty.toLowerCase(), rounded);
    };
    const lookupSessionModelWindow = (rawOrPretty: string | undefined): number | undefined => {
      if (!rawOrPretty) return undefined;
      const low = rawOrPretty.trim().toLowerCase();
      if (low && modelWindowMap.has(low)) return modelWindowMap.get(low);
      const pretty = prettifyModelName(rawOrPretty);
      if (pretty && modelWindowMap.has(pretty.toLowerCase())) {
        return modelWindowMap.get(pretty.toLowerCase());
      }
      return undefined;
    };
    recordModelWindow(selectedModelFallback, selectedModelContextWindow);

    const requests = Array.isArray(state.requests) ? state.requests : [];
    const events: EnrichedEvent[] = [];

    interface CopilotUsageAcc {
      model?: string;
      hasExact: boolean;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      hasCacheSplit: boolean;
      hasUnsplitCached: boolean;
      reasoningTokens: number;
      hasExactReasoning: boolean;
      lastTurnContext: number;
      contextWindow?: number;
      estInputChars: number;
      estOutputChars: number;
      priorBoundedProseChars: number;
      prevTurnProseChars: number;
      latestTurnChars: number;
      costUsd?: number;
    }
    const usageAccByAgent = new Map<string, CopilotUsageAcc>();
    const ensureAcc = (aid: string): CopilotUsageAcc => {
      let acc = usageAccByAgent.get(aid);
      if (!acc) {
        acc = {
          hasExact: false,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          hasCacheSplit: false,
          hasUnsplitCached: false,
          reasoningTokens: 0,
          hasExactReasoning: false,
          lastTurnContext: 0,
          contextWindow: selectedModelContextWindow,
          estInputChars: 0,
          estOutputChars: 0,
          priorBoundedProseChars: 0,
          prevTurnProseChars: 0,
          latestTurnChars: 0,
        };
        usageAccByAgent.set(aid, acc);
      }
      return acc;
    };

    const usedSubagentSlugs = new Set<string>();

    for (let rIdx = 0; rIdx < requests.length; rIdx++) {
      const req = requests[rIdx]!;
      const reqEpoch = parseEpochSeconds(
        req.timestamp,
        (state.creationDate ? state.creationDate / 1000 : session.mtimeMs / 1000) +
          rIdx,
      );
      // Top-level requests[] always belong to the root coordinator thread
      const agentId = "root";
      const agentLabel = "Copilot Agent";

      const acc = ensureAcc(agentId);
      const reqModelRaw =
        typeof req.modelId === "string" && req.modelId.trim()
          ? req.modelId.trim()
          : undefined;
      const rawModel =
        (reqModelRaw &&
        reqModelRaw.toLowerCase() !== "auto" &&
        !reqModelRaw.toLowerCase().endsWith("/auto")
          ? reqModelRaw
          : undefined) ?? selectedModelFallback;
      if (rawModel) {
        const pretty = prettifyModelName(rawModel);
        if (pretty) acc.model = pretty;
      }

      const rounds = Array.isArray(req.result?.metadata?.toolCallRounds)
        ? req.result!.metadata!.toolCallRounds!
        : [];
      const roundUsages = rounds
        .map((r) => extractUsageNumbers(r.usage))
        .filter((u) => u.inTok !== undefined || u.outTok !== undefined);

      const directUsage = extractUsageNumbers(
        req.result?.usage ?? req.result?.metadata?.usage,
      );
      const metaFields = extractUsageNumbers(
        req.result?.metadata as Record<string, unknown> | undefined,
      );
      const reqContextWindow =
        directUsage.contextWindow ?? metaFields.contextWindow;
      if (reqContextWindow !== undefined && reqContextWindow > 0) {
        acc.contextWindow = reqContextWindow;
        recordModelWindow(rawModel ?? acc.model, reqContextWindow);
      }

      const hasDirectPromptOrContext =
        directUsage.inTok !== undefined ||
        directUsage.contextTok !== undefined ||
        metaFields.inTok !== undefined ||
        metaFields.contextTok !== undefined;
      const hasDirectOut =
        directUsage.outTok !== undefined ||
        metaFields.outTok !== undefined ||
        typeof req.completionTokens === "number";

      if (
        hasDirectPromptOrContext ||
        (hasDirectOut && roundUsages.length === 0)
      ) {
        const rawIn = directUsage.inTok ?? metaFields.inTok;
        const rawOut =
          directUsage.outTok ??
          metaFields.outTok ??
          (typeof req.completionTokens === "number"
            ? req.completionTokens
            : undefined);
        const cacheSource =
          directUsage.cachedTok > 0 || directUsage.cacheSplitKnown
            ? directUsage
            : metaFields;
        const rawCached = cacheSource.cachedTok;
        const rawCtx = directUsage.contextTok ?? metaFields.contextTok;
        const norm = normalizeCopilotUsage({
          inTok: rawIn,
          outTok: rawOut,
          cachedTok: rawCached,
          contextTok: rawCtx,
        });
        acc.hasExact = true;
        acc.inputTokens += norm.freshIn;
        acc.outputTokens += norm.outTok;
        acc.cachedTokens += norm.cachedTok;
        if (cacheSource.cacheSplitKnown) {
          acc.hasCacheSplit = true;
          acc.cacheReadTokens += cacheSource.cacheReadTok ?? 0;
          acc.cacheWriteTokens += cacheSource.cacheWriteTok ?? 0;
        } else if (norm.cachedTok > 0) {
          acc.hasUnsplitCached = true;
        }
        const rTok = directUsage.reasoningTok ?? metaFields.reasoningTok;
        if (rTok !== undefined) {
          acc.hasExactReasoning = true;
          acc.reasoningTokens += rTok;
        }
        if (norm.turnContext !== undefined) {
          acc.lastTurnContext = norm.turnContext;
        }
        const cost = directUsage.costUsd ?? metaFields.costUsd;
        if (cost !== undefined && cost >= 0) {
          acc.costUsd = (acc.costUsd ?? 0) + cost;
        }
      } else if (roundUsages.length > 0) {
        acc.hasExact = true;
        for (const ru of roundUsages) {
          if (ru.contextWindow !== undefined && ru.contextWindow > 0) {
            acc.contextWindow = ru.contextWindow;
          }
          const norm = normalizeCopilotUsage({
            inTok: ru.inTok,
            outTok: ru.outTok,
            cachedTok: ru.cachedTok,
            contextTok: ru.contextTok,
          });
          acc.inputTokens += norm.freshIn;
          acc.outputTokens += norm.outTok;
          acc.cachedTokens += norm.cachedTok;
          if (ru.cacheSplitKnown) {
            acc.hasCacheSplit = true;
            acc.cacheReadTokens += ru.cacheReadTok ?? 0;
            acc.cacheWriteTokens += ru.cacheWriteTok ?? 0;
          } else if (norm.cachedTok > 0) {
            acc.hasUnsplitCached = true;
          }
          if (ru.reasoningTok !== undefined) {
            acc.hasExactReasoning = true;
            acc.reasoningTokens += ru.reasoningTok;
          }
          if (norm.turnContext !== undefined) {
            acc.lastTurnContext = norm.turnContext;
          }
          if (ru.costUsd !== undefined && ru.costUsd >= 0) {
            acc.costUsd = (acc.costUsd ?? 0) + ru.costUsd;
          }
        }
      }

      const reqPromptChars = (req.message?.text ?? "").length;
      acc.estInputChars += reqPromptChars;
      let respVisibleChars = 0;
      let respProseChars = 0;
      if (Array.isArray(req.response)) {
        for (const item of req.response) {
          const rk = item.kind ?? "";
          if (rk === "thinking") {
            const len =
              extractMessageText(item.value).length +
              (item.generatedTitle?.length ?? 0);
            respVisibleChars += len;
            respProseChars += len;
          } else if (!rk || rk === "markdownContent" || rk === "text") {
            const len = (
              extractMessageText(item.value) || extractMessageText(item.content)
            ).length;
            respVisibleChars += len;
            respProseChars += len;
          } else if (rk === "toolInvocationSerialized") {
            const title =
              extractMessageText(item.pastTenseMessage) ||
              extractMessageText(item.invocationMessage) ||
              item.generatedTitle ||
              item.toolId ||
              item.toolName ||
              "";
            respVisibleChars += title.length;
          } else if (rk === "textEditGroup") {
            const base = extractUriBasename(item.uri);
            respVisibleChars += base ? `Edit ${base}`.length : 20;
          } else {
            const len = (
              extractMessageText(item.value) ||
              extractMessageText(item.content) ||
              item.generatedTitle ||
              ""
            ).length;
            respVisibleChars += len;
          }
        }
      }
      acc.estOutputChars += respVisibleChars;
      if (acc.latestTurnChars > 0) {
        acc.priorBoundedProseChars += Math.min(4000, acc.prevTurnProseChars);
      }
      acc.prevTurnProseChars = reqPromptChars + respProseChars;
      acc.latestTurnChars = reqPromptChars + respVisibleChars;

      const emit = (input: {
        epoch: number;
        kind: EnrichedEvent["kind"];
        toolName?: string;
        toolCallId?: string;
        targetAgentId?: string;
        summary: string;
        payload?: Record<string, unknown>;
        status?: EnrichedEvent["status"];
        isSelfDaemon?: boolean;
        isError?: boolean;
        waitingReason?: EnrichedEvent["waitingReason"];
        fullBody?: string;
        inlineBody?: string;
      }): void => {
        const id = computeDeterministicEventId({
          ide: this.ide,
          sessionId: session.sessionId,
          agentId,
          kind: input.kind,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          epoch: input.epoch,
          summary: input.summary,
        });
        const mergeKey = computeMergeKey({
          sessionId: session.sessionId,
          agentId,
          kind: input.kind,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          epoch: input.epoch,
        });
        const hasBody =
          typeof input.fullBody === "string" && input.fullBody.length > 0;
        const bodyLength = hasBody ? input.fullBody!.length : undefined;
        const bodyTruncated = hasBody
          ? input.fullBody!.length > (input.inlineBody?.length ?? 0)
          : undefined;
        events.push({
          id,
          mergeKey,
          ts: toIsoUtc(input.epoch),
          epoch: input.epoch,
          ide: this.ide,
          channel: "passive",
          sessionId: session.sessionId,
          workspacePath,
          projectId,
          agentId,
          agentLabel,
          kind: input.kind,
          toolName: input.toolName,
          toolCallId: input.toolCallId,
          targetAgentId: input.targetAgentId,
          summary: input.summary,
          payload: input.payload,
          ...(bodyLength !== undefined ? { bodyLength } : {}),
          ...(bodyTruncated !== undefined ? { bodyTruncated } : {}),
          status: input.status,
          isSelfDaemon: input.isSelfDaemon,
          isError: input.isError,
          waitingReason: input.waitingReason,
        });
        if (hasBody) {
          opts?.onFullBody?.(id, input.fullBody!);
        }
      };

      const emitChatAnswer = (
        stepEpoch: number,
        callId: string,
        questions: PendingQuestionItem[],
        qTitle: string,
        rawAnswerData: unknown,
        pastTenseMsg: string,
      ): void => {
        const answerText = extractCopilotAnswerText(rawAnswerData, pastTenseMsg);
        if (!answerText) return;
        const questionPrompt =
          questions
            .map((q) => q.question.trim())
            .filter(Boolean)
            .join(" / ")
            .slice(0, 500) || qTitle;
        const cleanAns =
          cleanHumanSummary(answerText, 130) || answerText.slice(0, 130);
        const inlineBody = answerText.slice(0, 1400);
        emit({
          epoch: stepEpoch + 0.006,
          kind: "user_input",
          toolCallId: `${callId}:answer`,
          targetAgentId: agentId,
          summary: `Human: ${cleanAns}`,
          payload: {
            isHumanAnswer: true,
            questionToolCallId: callId,
            questionPrompt,
            targetAgentId: agentId,
            body: inlineBody,
          },
          fullBody: answerText,
          inlineBody,
        });
      };

      // 1. User prompt
      const promptText = req.message?.text?.trim() ?? "";
      if (promptText) {
        const inlineBody = promptText.slice(0, 1400);
        emit({
          epoch: reqEpoch,
          kind: "user_input",
          targetAgentId: agentId,
          summary: `Human: ${cleanHumanSummary(promptText, 130)}`,
          payload: {
            body: inlineBody,
            requestId: req.requestId,
            _passiveSource: "chatSessions",
          },
          fullBody: promptText,
          inlineBody,
        });
      }

      // 2. Response items
      const responses = Array.isArray(req.response) ? req.response : [];
      const reqCompleted = Boolean(
        req.isCanceled || req.modelState?.completedAt || req.result,
      );
      const reqQuestionAnalysis = analyzeCopilotRequestQuestions(req);
      for (let i = 0; i < responses.length; i++) {
        const item = responses[i]!;
        const stepEpoch = reqEpoch + (i + 1) * 0.01;
        const rkind = item.kind ?? "";

        if (rkind === "thinking") {
          const thinkText = extractMessageText(item.value).trim();
          const genTitle =
            typeof item.generatedTitle === "string"
              ? item.generatedTitle.trim()
              : "";
          const inlineBody = thinkText
            ? thinkText.slice(0, THINKING_INLINE_MAX)
            : "";
          emit({
            epoch: stepEpoch,
            kind: "thinking_start",
            summary:
              cleanHumanSummary(genTitle || thinkText, 120) || "Thinking…",
            payload: {
              ...(inlineBody ? { body: inlineBody } : {}),
              isThought: true,
            },
            ...(thinkText ? { fullBody: thinkText, inlineBody } : {}),
          });
        } else if (rkind === "prepareToolInvocation") {
          const tname = item.toolName || item.toolId || "tool";
          emit({
            epoch: stepEpoch,
            kind: "tool_start",
            toolName: tname,
            toolCallId: item.toolCallId,
            summary: `Preparing: ${tname}`,
          });
        } else if (rkind === "toolInvocationSerialized") {
          const tname = item.toolId || item.toolName || "tool";
          const callId = item.toolCallId || `${req.requestId ?? rIdx}:${i}:${tname}`;
          const msg =
            extractMessageText(item.pastTenseMessage) ||
            extractMessageText(item.invocationMessage) ||
            item.generatedTitle ||
            tname;
          const lowTool = tname.toLowerCase();
          const selfDaemon = isSelfDaemonCommand(
            msg + " " + JSON.stringify(item.toolSpecificData ?? {}),
          );

          if (isSubagentToolName(lowTool)) {
            const tsd = item.toolSpecificData;
            const subLabel = String(
              tsd?.subAgentName ??
                tsd?.agentName ??
                tsd?.agentType ??
                tsd?.agent_type ??
                tsd?.subagent_type ??
                tsd?.name ??
                tsd?.description ??
                item.generatedTitle ??
                "Subagent",
            ).trim();
            const explicitSubId =
              (typeof tsd?.subAgentInvocationId === "string" &&
                tsd.subAgentInvocationId.trim() &&
                tsd.subAgentInvocationId.trim() !== "root" &&
                tsd.subAgentInvocationId.trim()) ||
              (typeof tsd?.agentId === "string" &&
                tsd.agentId.trim() &&
                tsd.agentId.trim() !== "root" &&
                tsd.agentId.trim()) ||
              (typeof tsd?.subagentId === "string" &&
                tsd.subagentId.trim() &&
                tsd.subagentId.trim() !== "root" &&
                tsd.subagentId.trim()) ||
              undefined;
            const baseSlug =
              subLabel
                .toLowerCase()
                .replace(/[^a-z0-9_-]+/g, "-")
                .replace(/^-+|-+$/g, "") || "subagent";
            let subId: string;
            if (explicitSubId) {
              subId = explicitSubId;
              usedSubagentSlugs.add(subId);
            } else {
              subId = baseSlug;
              let suffix = 2;
              while (usedSubagentSlugs.has(subId)) {
                subId = `${baseSlug}-${suffix++}`;
              }
              usedSubagentSlugs.add(subId);
            }
            const subModelRaw =
              typeof tsd?.model === "string" && tsd.model.trim()
                ? tsd.model.trim()
                : undefined;
            const subModel = subModelRaw
              ? prettifyModelName(subModelRaw) || subModelRaw
              : undefined;
            const childContextWindow = subModel
              ? lookupSessionModelWindow(subModelRaw) ??
                lookupSessionModelWindow(subModel) ??
                (acc.model && subModel === acc.model ? acc.contextWindow : undefined)
              : lookupSessionModelWindow(acc.model) ??
                acc.contextWindow ??
                selectedModelContextWindow;
            const rawSubPrompt =
              typeof tsd?.prompt === "string"
                ? tsd.prompt
                : typeof tsd?.instructions === "string"
                  ? tsd.instructions
                  : typeof tsd?.description === "string"
                    ? tsd.description
                    : extractMessageText(item.invocationMessage);
            const subPrompt = rawSubPrompt.trim();
            const inlinePrompt = subPrompt ? subPrompt.slice(0, 1000) : "";
            const compactSpecificData = tsd
              ? {
                  ...tsd,
                  ...(typeof tsd.prompt === "string"
                    ? { prompt: tsd.prompt.slice(0, 1000) }
                    : {}),
                  ...(typeof tsd.instructions === "string"
                    ? { instructions: tsd.instructions.slice(0, 1000) }
                    : {}),
                }
              : undefined;
            emit({
              epoch: stepEpoch,
              kind: "subagent_spawn",
              toolName: tname,
              toolCallId: callId,
              targetAgentId: subId,
              summary: `Spawned ${subLabel}`,
              payload: {
                agentLabel: subLabel,
                agentType: subLabel,
                _passiveSource: "chatSessions",
                ...(subModel
                  ? { childModel: subModel, childModelSource: "exact" }
                  : {}),
                ...(childContextWindow !== undefined
                  ? { childContextWindow }
                  : {}),
                toolSpecificData: compactSpecificData,
                ...(inlinePrompt ? { prompt: inlinePrompt } : {}),
              },
              ...(subPrompt
                ? { fullBody: subPrompt, inlineBody: inlinePrompt }
                : {}),
            });
            if (item.isComplete) {
              const doneText = (
                extractMessageText(item.pastTenseMessage) ||
                (typeof item.resultDetails === "string" ? item.resultDetails : "")
              ).trim();
              const inlineDone = doneText ? doneText.slice(0, 1000) : "";
              emit({
                epoch: stepEpoch + 0.005,
                kind: "subagent_done",
                toolName: tname,
                toolCallId: callId,
                targetAgentId: subId,
                summary: `Subagent finished: ${subLabel}`,
                ...(inlineDone ? { payload: { body: inlineDone } } : {}),
                ...(doneText
                  ? { fullBody: doneText, inlineBody: inlineDone }
                  : {}),
              });
            }
          } else if (
            isCopilotAskTool(lowTool) &&
            !isStudioDirectAskTool(lowTool)
          ) {
            const mergedQs = reqQuestionAnalysis.mergedAskQuestions.get(i);
            const askQs =
              mergedQs && mergedQs.length > 0
                ? mergedQs
                : extractCopilotItemQuestions(item);
            const isAskSuppressed =
              Boolean(item.isComplete) ||
              reqQuestionAnalysis.suppressedAskIndices.has(i);
            const qTitle =
              cleanHumanSummary(
                askQs[0]?.header ?? askQs[0]?.question ?? msg,
                90,
              ) || "Waiting for user answer";
            emit({
              epoch: stepEpoch,
              kind: "tool_start",
              toolName: tname,
              toolCallId: callId,
              targetAgentId: "human",
              summary: qTitle,
              waitingReason: isAskSuppressed ? undefined : "user",
              payload: {
                questions: askQs,
                promptTitle: qTitle,
                promptKind: "question",
                blockingToolCall: true,
              },
            });
            if (isAskSuppressed) {
              emit({
                epoch: stepEpoch + 0.005,
                kind: "tool_end",
                toolName: tname,
                toolCallId: callId,
                summary: `Answered: ${qTitle.slice(0, 80)}`,
              });
              let mergedCarouselData: unknown;
              for (const [
                carIdx,
                askIdx,
              ] of reqQuestionAnalysis.mergedCarouselToAskIdx.entries()) {
                if (askIdx === i && responses[carIdx]?.data !== undefined) {
                  mergedCarouselData = responses[carIdx]!.data;
                  break;
                }
              }
              emitChatAnswer(
                stepEpoch,
                callId,
                askQs,
                qTitle,
                item.data ?? mergedCarouselData ?? item.resultDetails,
                extractMessageText(item.pastTenseMessage),
              );
            }
          } else {
            const needsApproval =
              !reqCompleted &&
              item.isComplete === false &&
              item.isConfirmed === false;
            const specificArgs = item.toolSpecificData ?? {};
            const isBoardMut = isBoardMutationToolCall(tname, specificArgs);
            const isMsgTool = isMessageToolName(lowTool);
            const cleanMsg =
              isBoardMut || isMsgTool
                ? summarizeToolCall(tname, specificArgs)
                : cleanHumanSummary(msg, 140) || summarizeToolCall(tname, specificArgs);
            if (isMsgTool) {
              const msgInfo = extractMessagePayload(specificArgs);
              emit({
                epoch: stepEpoch,
                kind: "message",
                toolName: tname,
                toolCallId: callId,
                ...(msgInfo.msgTarget ? { targetAgentId: msgInfo.msgTarget } : {}),
                summary: cleanMsg,
                isSelfDaemon: selfDaemon,
                payload: {
                  isConfirmed: item.isConfirmed,
                  toolSpecificData: item.toolSpecificData
                    ? msgInfo.compactArgs
                    : item.toolSpecificData,
                  ...(msgInfo.inlineBody ? { body: msgInfo.inlineBody } : {}),
                },
                ...(msgInfo.msgBody
                  ? { fullBody: msgInfo.msgBody, inlineBody: msgInfo.inlineBody }
                  : {}),
              });
            } else {
              emit({
                epoch: stepEpoch,
                kind: isBoardMut ? "board_mutation" : "tool_start",
                toolName: tname,
                toolCallId: callId,
                summary: cleanMsg,
                isSelfDaemon: selfDaemon,
                waitingReason: needsApproval ? "tool_approval" : undefined,
                payload: {
                  isConfirmed: item.isConfirmed,
                  toolSpecificData: item.toolSpecificData,
                  ...(needsApproval
                    ? {
                        promptKind: "approval",
                        promptTitle: cleanMsg || `Approve ${tname}`,
                        promptSummary:
                          extractMessageText(item.invocationMessage) || cleanMsg,
                        blockingToolCall: true,
                      }
                    : {}),
                },
              });
              if (item.isComplete) {
                emit({
                  epoch: stepEpoch + 0.005,
                  kind: "tool_end",
                  toolName: tname,
                  toolCallId: callId,
                  summary: cleanHumanSummary(`Completed: ${cleanMsg}`, 140),
                  isSelfDaemon: selfDaemon,
                  payload: {
                    resultDetails: item.resultDetails,
                    routineEnd: true,
                  },
                });
              }
            }
          }
        } else if (
          rkind === "questionCarousel" ||
          rkind === "elicitationSerialized"
        ) {
          if (reqQuestionAnalysis.mergedCarouselToAskIdx.has(i)) {
            continue;
          }
          const isSuppressed =
            reqQuestionAnalysis.suppressedCarouselIndices.has(i);
          const carouselQs = extractCopilotItemQuestions(item);
          const qTitle =
            cleanHumanSummary(
              carouselQs[0]?.header ??
                carouselQs[0]?.question ??
                "Waiting for user answer",
              90,
            ) || "Waiting for user answer";
          const callId = item.toolCallId || `${req.requestId ?? rIdx}:${i}:${rkind}`;
          emit({
            epoch: stepEpoch,
            kind: "tool_start",
            toolName: rkind,
            toolCallId: callId,
            targetAgentId: "human",
            summary: qTitle,
            waitingReason: isSuppressed ? undefined : "user",
            payload: {
              questions: carouselQs,
              promptTitle: qTitle,
              promptKind: "question",
              blockingToolCall: true,
              ...(item.isUsed !== undefined ? { isUsed: item.isUsed } : {}),
            },
          });
          if (isSuppressed) {
            emit({
              epoch: stepEpoch + 0.005,
              kind: "tool_end",
              toolName: rkind,
              toolCallId: callId,
              summary: `Answered: ${qTitle.slice(0, 80)}`,
            });
            emitChatAnswer(
              stepEpoch,
              callId,
              carouselQs,
              qTitle,
              item.data ?? item.resultDetails,
              extractMessageText(item.pastTenseMessage),
            );
          }
        } else if (rkind === "textEditGroup") {
          const callId = `${req.requestId ?? rIdx}:${i}:edit`;
          const fileBase = extractUriBasename(item.uri);
          emit({
            epoch: stepEpoch,
            kind: "tool_start",
            toolName: "copilot_edit",
            toolCallId: callId,
            summary: fileBase ? `Edit ${fileBase}` : "Edit workspace files",
          });
          emit({
            epoch: stepEpoch + 0.002,
            kind: "tool_end",
            toolName: "copilot_edit",
            toolCallId: callId,
            summary: fileBase
              ? `Completed: Edit ${fileBase}`
              : "Applied file edits",
          });
        }
      }

      // 3. Turn completion
      const completedAtMs = req.modelState?.completedAt;
      if (req.isCanceled) {
        emit({
          epoch: reqEpoch + (responses.length + 1) * 0.01,
          kind: "assistant_turn_end",
          summary: "Turn canceled",
          status: "ok",
        });
      } else if (completedAtMs || req.result) {
        const endEpoch = parseEpochSeconds(
          completedAtMs,
          reqEpoch + (responses.length + 1) * 0.01,
        );
        const hasErr = Boolean(req.result?.errorDetails);
        const markdownChunks = responses
          .filter(
            (r) => !r.kind || r.kind === "markdownContent" || r.kind === "text",
          )
          .map((r) =>
            (extractMessageText(r.value) || extractMessageText(r.content)).trim(),
          )
          .filter(Boolean);
        const turnText = (
          markdownChunks.join("\n\n") ||
          req.result?.errorDetails?.message ||
          req.result?.details ||
          ""
        ).trim();
        const inlineTurnBody = turnText ? turnText.slice(0, 1000) : "";
        const turnPayload: Record<string, unknown> | undefined =
          req.result || inlineTurnBody
            ? {
                ...(req.result ? { result: req.result } : {}),
                ...(inlineTurnBody ? { body: inlineTurnBody } : {}),
              }
            : undefined;
        emit({
          epoch: Math.max(endEpoch, reqEpoch + (responses.length + 1) * 0.01),
          kind: "assistant_turn_end",
          summary: hasErr
            ? `Error: ${req.result?.errorDetails?.message ?? "Copilot error"}`
            : cleanHumanSummary(turnText, 140) || "Turn completed",
          status: hasErr ? "error" : "ok",
          isError: hasErr,
          payload: turnPayload,
          ...(turnText
            ? { fullBody: turnText, inlineBody: inlineTurnBody }
            : {}),
        });
      }
    }

    // Attach finalized per-agent UsageDelta totals onto each agent's last emitted event
    const lastEvByAgent = new Map<string, EnrichedEvent>();
    for (const ev of events) {
      lastEvByAgent.set(ev.agentId, ev);
    }
    for (const [aid, acc] of usageAccByAgent.entries()) {
      const targetEv = lastEvByAgent.get(aid);
      if (!targetEv) continue;
      const inputTokens = acc.hasExact
        ? acc.inputTokens
        : Math.round(acc.estInputChars / 4);
      const outputTokens = acc.hasExact
        ? acc.outputTokens
        : Math.round(acc.estOutputChars / 4);
      const cachedTokens = acc.hasExact ? acc.cachedTokens : 0;
      const contextTokens = acc.hasExact
        ? acc.lastTurnContext
        : Math.round((acc.priorBoundedProseChars + acc.latestTurnChars) / 4);
      const hasSplit = acc.hasExact && acc.hasCacheSplit && !acc.hasUnsplitCached;
      const usageDelta: UsageDelta = {
        model: acc.model,
        modelSource: acc.model ? "exact" : "unknown",
        usageSource: acc.hasExact ? "exact" : "estimated",
        inputTokens,
        outputTokens,
        cachedTokens,
        ...(hasSplit
          ? {
              cacheReadTokens: acc.cacheReadTokens,
              cacheWriteTokens: acc.cacheWriteTokens,
            }
          : {}),
        ...(acc.hasExact && acc.hasExactReasoning
          ? {
              reasoningTokens: Math.min(outputTokens, acc.reasoningTokens),
              reasoningSource: "exact" as const,
            }
          : {}),
        contextTokens,
        ...(acc.contextWindow !== undefined
          ? { contextWindow: acc.contextWindow }
          : {}),
        ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
        isTotal: true,
      };
      targetEv.usageDelta = usageDelta;
      targetEv.payload = { ...(targetEv.payload ?? {}), _usageDelta: usageDelta };
    }

    return events;
  }

  async parseTranscriptChat(
    filePath: string,
    sessionId: string,
    opts?: CopilotTranscriptParseOptions,
  ): Promise<AgentChatMessage[]> {
    const allowedRoots =
      opts?.allowedRoots ??
      this.getDefaultAllowedTranscriptRoots(opts?.workspacePath);
    const validPath = await validateTranscriptPath(filePath, allowedRoots, {
      maxBytes: MAX_TRANSCRIPT_BYTES,
    });
    if (!validPath) return [];

    let raw: string;
    let mtimeMs = Date.now();
    try {
      const fst = await fs.stat(validPath);
      if (!fst.isFile() || fst.size > MAX_TRANSCRIPT_BYTES) {
        return [];
      }
      mtimeMs = fst.mtimeMs;
      raw = await fs.readFile(validPath, "utf8");
    } catch {
      return [];
    }

    const rows = parseJsonlRows(raw);
    if (rows.length === 0) return [];

    const messages: AgentChatMessage[] = [];
    const defaultAgentId = opts?.agentIdOverride?.trim() || "root";
    const toolRefByCallId = new Map<string, ChatToolCallRef>();
    const seenAskCallIds = new Set<string>();
    const askMsgByCallId = new Map<string, AgentChatMessage>();
    const subagentIdByCallId = new Map<
      string,
      { subId: string; subLabel: string }
    >();
    const usedSubagentSlugs = new Set<string>();
    let fallbackEpoch = mtimeMs / 1000 - Math.max(rows.length, 1);

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx]!;
      const rtype = (row.type ?? row.event ?? "").toLowerCase();
      const d =
        row.data && typeof row.data === "object" && !Array.isArray(row.data)
          ? row.data
          : (row as Record<string, unknown>);
      const epoch = parseEpochSeconds(
        (d.timestamp as string | number | undefined) ?? row.timestamp,
        fallbackEpoch + idx,
      );
      fallbackEpoch = epoch;

      const rowAgentRaw =
        (typeof d.agentId === "string" && d.agentId.trim()) ||
        (typeof row.agentId === "string" && row.agentId.trim()) ||
        undefined;
      const agentId = opts?.agentIdOverride
        ? defaultAgentId
        : rowAgentRaw && rowAgentRaw !== "root"
          ? rowAgentRaw
          : defaultAgentId;

      if (rtype === "user.message") {
        const txt = (
          (typeof d.content === "string" && d.content) ||
          (typeof d.transformedContent === "string" && d.transformedContent) ||
          (typeof row.content === "string" && row.content) ||
          (typeof row.prompt === "string" && row.prompt) ||
          ""
        ).trim();
        if (txt) {
          messages.push({
            id: `chat:vsc-tr:${sessionId}:${agentId}:${idx}:user`,
            ts: toIsoUtc(epoch),
            epoch,
            agentId,
            role: "user",
            text: capChatText(resolveEmptyFileLinks(txt)),
          });
        }
      } else if (rtype === "assistant.message") {
        const msgText =
          (typeof d.content === "string" && d.content.trim()) || "";
        const reasoning =
          (typeof d.reasoningText === "string" && d.reasoningText.trim()) || "";
        const toolReqs = Array.isArray(d.toolRequests) ? d.toolRequests : [];
        const turnTools: ChatToolCallRef[] = [];
        const specialMsgs: AgentChatMessage[] = [];

        for (let ti = 0; ti < toolReqs.length; ti++) {
          const tr = toolReqs[ti] as Record<string, unknown>;
          const tname =
            (typeof tr.name === "string" && tr.name) ||
            (typeof tr.toolName === "string" && tr.toolName) ||
            "tool";
          const callId =
            (typeof tr.toolCallId === "string" && tr.toolCallId) ||
            `${idx}:${ti}:${tname}`;
          const args =
            tr.arguments &&
            typeof tr.arguments === "object" &&
            !Array.isArray(tr.arguments)
              ? (tr.arguments as Record<string, unknown>)
              : {};
          const lowTool = tname.toLowerCase();
          if (isCopilotAskTool(lowTool)) {
            if (!seenAskCallIds.has(callId)) {
              seenAskCallIds.add(callId);
              const qs = normalizePendingQuestions(args, {
                defaultAllowCustomInput: true,
              });
              const qMsg: AgentChatMessage = {
                id: `chat:vsc-tr:${sessionId}:${agentId}:${idx}:ask:${ti}`,
                ts: toIsoUtc(epoch + (ti + 1) * 0.0001),
                epoch: epoch + (ti + 1) * 0.0001,
                agentId,
                role: "question",
                text: capChatText(
                  formatQuestionsPreview(qs, "Waiting for user answer"),
                ),
                pendingPromptId: computePendingPromptId(agentId, callId),
              };
              askMsgByCallId.set(callId, qMsg);
              specialMsgs.push(qMsg);
            }
          } else if (isMessageToolName(lowTool)) {
            const msgInfo = extractMessagePayload(args);
            specialMsgs.push({
              id: `chat:vsc-tr:${sessionId}:${agentId}:${idx}:msg:${ti}`,
              ts: toIsoUtc(epoch + (ti + 1) * 0.0001),
              epoch: epoch + (ti + 1) * 0.0001,
              agentId,
              role: "subagent",
              text: capChatText(
                msgInfo.msgBody || summarizeToolCall(tname, args),
              ),
              ...(msgInfo.msgTarget ? { subagentId: msgInfo.msgTarget } : {}),
            });
          } else {
            const ref: ChatToolCallRef = {
              toolCallId: callId,
              toolName: tname,
              summary: summarizeToolCall(tname, args),
              status: "running",
              inputPreview: capChatText(JSON.stringify(args), 4096),
            };
            turnTools.push(ref);
            toolRefByCallId.set(callId, ref);
          }
        }

        if (msgText || turnTools.length > 0) {
          messages.push({
            id: `chat:vsc-tr:${sessionId}:${agentId}:${idx}:ast`,
            ts: toIsoUtc(epoch),
            epoch,
            agentId,
            role: "assistant",
            text: capChatText(
              resolveEmptyFileLinks(msgText) ||
                (turnTools.length === 1
                  ? turnTools[0]!.summary
                  : `Ran ${turnTools.length} tools`),
            ),
            ...(reasoning ? { thinking: capChatText(reasoning) } : {}),
            ...(turnTools.length > 0 ? { tools: turnTools } : {}),
          });
        } else if (reasoning) {
          messages.push({
            id: `chat:vsc-tr:${sessionId}:${agentId}:${idx}:thk`,
            ts: toIsoUtc(epoch),
            epoch,
            agentId,
            role: "thinking",
            text: capChatText(reasoning),
            thinking: capChatText(reasoning),
          });
        }
        messages.push(...specialMsgs);
      } else if (rtype === "tool.execution_start") {
        const tname =
          (typeof d.mcpToolName === "string" && d.mcpToolName) ||
          (typeof d.toolName === "string" && d.toolName) ||
          "tool";
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) ||
          `${idx}:${tname}`;
        const args =
          d.arguments &&
          typeof d.arguments === "object" &&
          !Array.isArray(d.arguments)
            ? (d.arguments as Record<string, unknown>)
            : {};
        const lowTool = tname.toLowerCase();
        if (toolRefByCallId.has(callId)) {
          const existingRef = toolRefByCallId.get(callId)!;
          if (!existingRef.inputPreview && Object.keys(args).length > 0) {
            existingRef.inputPreview = capChatText(JSON.stringify(args), 4096);
          }
        } else if (
            isCopilotAskTool(lowTool) &&
            !isStudioDirectAskTool(lowTool)
          ) {
          if (!seenAskCallIds.has(callId)) {
            seenAskCallIds.add(callId);
            const qs = normalizePendingQuestions(args, {
              defaultAllowCustomInput: true,
            });
            const qMsg: AgentChatMessage = {
              id: `chat:vsc-tr:${sessionId}:${agentId}:${idx}:ask`,
              ts: toIsoUtc(epoch),
              epoch,
              agentId,
              role: "question",
              text: capChatText(
                formatQuestionsPreview(qs, "Waiting for user answer"),
              ),
              pendingPromptId: computePendingPromptId(agentId, callId),
            };
            askMsgByCallId.set(callId, qMsg);
            messages.push(qMsg);
          }
        } else if (isMessageToolName(lowTool)) {
          const msgInfo = extractMessagePayload(args);
          messages.push({
            id: `chat:vsc-tr:${sessionId}:${agentId}:${idx}:msg`,
            ts: toIsoUtc(epoch),
            epoch,
            agentId,
            role: "subagent",
            text: capChatText(
              msgInfo.msgBody || summarizeToolCall(tname, args),
            ),
            ...(msgInfo.msgTarget ? { subagentId: msgInfo.msgTarget } : {}),
          });
        } else {
          const ref: ChatToolCallRef = {
            toolCallId: callId,
            toolName: tname,
            summary: summarizeToolCall(tname, args),
            status: "running",
            inputPreview: capChatText(JSON.stringify(args), 4096),
          };
          toolRefByCallId.set(callId, ref);
          messages.push({
            id: `chat:vsc-tr:${sessionId}:${agentId}:${idx}:tool`,
            ts: toIsoUtc(epoch),
            epoch,
            agentId,
            role: "tool",
            text: ref.summary,
            tools: [ref],
          });
        }
      } else if (rtype === "tool.execution_complete") {
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) || undefined;
        const isErr =
          d.success === false || d.isError === true || Boolean(d.error);
        const outRaw = formatToolOutput(d.error ?? d.result).trim();
        const ref = callId ? toolRefByCallId.get(callId) : undefined;
        if (ref) {
          ref.status = isErr ? "error" : "ok";
          if (outRaw) ref.output = capChatText(outRaw);
        }
        const askMsg = callId ? askMsgByCallId.get(callId) : undefined;
        if (askMsg) {
          delete askMsg.pendingPromptId;
        }
      } else if (
        rtype === "subagent.started" ||
        rtype === "subagent.start"
      ) {
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) || undefined;
        const subLabel =
          [
            d.agentDisplayName,
            d.subAgentName,
            d.subagentName,
            d.agentName,
            d.agentType,
            d.subagentType,
            d.description,
          ]
            .find(
              (v): v is string =>
                typeof v === "string" &&
                Boolean(v.trim()) &&
                !isOpaqueAgentId(v),
            )
            ?.trim() || "Subagent";
        const explicitSubId =
          (typeof d.subAgentInvocationId === "string" &&
            d.subAgentInvocationId.trim() &&
            d.subAgentInvocationId.trim() !== "root" &&
            d.subAgentInvocationId.trim()) ||
          (typeof d.agentId === "string" &&
            d.agentId.trim() &&
            d.agentId.trim() !== "root" &&
            d.agentId.trim()) ||
          (typeof d.subagentId === "string" &&
            d.subagentId.trim() &&
            d.subagentId.trim() !== "root" &&
            d.subagentId.trim()) ||
          undefined;
        const baseSlug =
          subLabel
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "subagent";
        let rawSubId: string;
        if (explicitSubId) {
          rawSubId = explicitSubId;
          usedSubagentSlugs.add(rawSubId);
        } else {
          rawSubId = baseSlug;
          let suffix = 2;
          while (usedSubagentSlugs.has(rawSubId)) {
            rawSubId = `${baseSlug}-${suffix++}`;
          }
          usedSubagentSlugs.add(rawSubId);
        }
        if (callId) {
          subagentIdByCallId.set(callId, { subId: rawSubId, subLabel });
        }
        const subPrompt =
          typeof d.prompt === "string" ? d.prompt.trim() : "";
        messages.push({
          id: `chat:vsc-tr:${sessionId}:${agentId}:${idx}:substart`,
          ts: toIsoUtc(epoch),
          epoch,
          agentId,
          role: "subagent",
          text: capChatText(subPrompt || `Spawned ${subLabel}`),
          subagentId: rawSubId,
          subagentLabel: subLabel,
        });
      } else if (
        rtype === "subagent.completed" ||
        rtype === "subagent.stop" ||
        rtype === "subagent.failed"
      ) {
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) || undefined;
        const prevSub = callId ? subagentIdByCallId.get(callId) : undefined;
        const subLabel =
          prevSub?.subLabel ||
          [
            d.agentDisplayName,
            d.subAgentName,
            d.subagentName,
            d.agentName,
            d.agentType,
            d.subagentType,
          ]
            .find(
              (v): v is string =>
                typeof v === "string" &&
                Boolean(v.trim()) &&
                !isOpaqueAgentId(v),
            )
            ?.trim() ||
          "Subagent";
        const rawSubId =
          prevSub?.subId ||
          (typeof d.agentId === "string" && d.agentId.trim()) ||
          (typeof d.subagentId === "string" && d.subagentId.trim()) ||
          subLabel.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") ||
          "subagent";
        const isErr = rtype === "subagent.failed" || Boolean(d.error);
        const doneText =
          typeof d.result === "string"
            ? d.result.trim()
            : typeof d.error === "string"
              ? d.error.trim()
              : "";
        messages.push({
          id: `chat:vsc-tr:${sessionId}:${agentId}:${idx}:subdone`,
          ts: toIsoUtc(epoch),
          epoch,
          agentId,
          role: "subagent",
          text: capChatText(
            doneText ||
              (isErr
                ? `Subagent failed: ${subLabel}`
                : `Subagent finished: ${subLabel}`),
          ),
          subagentId: rawSubId,
          subagentLabel: subLabel,
        });
      }
    }

    return messages;
  }

  async parseChat(
    session: DiscoveredSession,
    opts?: ParseChatOptions,
  ): Promise<AgentChatMessage[]> {
    if (
      !session.filePath ||
      path.basename(session.filePath).toLowerCase() === "telemetry.jsonl"
    ) {
      return [];
    }

    const reqAgent = opts?.agentId?.trim();
    const normAlias = (v: string): string =>
      v.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    const targetAliases = new Set<string>();
    if (reqAgent) {
      targetAliases.add(reqAgent);
      targetAliases.add(reqAgent.toLowerCase());
      const ns = normAlias(reqAgent);
      if (ns) targetAliases.add(ns);
      for (const al of opts?.agentAliases ?? []) {
        const t = al.trim();
        if (!t) continue;
        targetAliases.add(t);
        targetAliases.add(t.toLowerCase());
        const nas = normAlias(t);
        if (nas) targetAliases.add(nas);
      }
    }
    const msgExtraAliases = new Map<AgentChatMessage, string[]>();
    const filterByAgent = (msgs: AgentChatMessage[]): AgentChatMessage[] => {
      const out = reqAgent
        ? msgs
            .filter((m) => {
              const candidates = [m.agentId, ...(msgExtraAliases.get(m) ?? [])];
              return candidates.some((c) => {
                const low = c.toLowerCase();
                const slugged = normAlias(c);
                return (
                  targetAliases.has(c) ||
                  targetAliases.has(low) ||
                  (slugged.length > 0 && targetAliases.has(slugged))
                );
              });
            })
            .map((m) => (m.agentId === reqAgent ? m : { ...m, agentId: reqAgent }))
        : msgs;
      out.sort((a, b) => a.epoch - b.epoch);
      return out;
    };

    if (isTranscriptJsonlPath(session.filePath)) {
      const msgs = await this.parseTranscriptChat(
        session.filePath,
        session.sessionId,
        {
          workspacePath: session.workspacePath,
          projectId: session.projectId,
        },
      );
      return filterByAgent(msgs);
    }

    let fst;
    try {
      fst = await fs.stat(session.filePath);
    } catch {
      return [];
    }
    const state = await this.loadChatSessionState(
      session.filePath,
      fst.mtimeMs,
      fst.size,
    );
    if (!state) return [];

    const messages: AgentChatMessage[] = [];
    const requests = Array.isArray(state.requests) ? state.requests : [];
    const usedSubagentSlugs = new Set<string>();

    for (let rIdx = 0; rIdx < requests.length; rIdx++) {
      const req = requests[rIdx]!;
      const reqEpoch = parseEpochSeconds(
        req.timestamp,
        (state.creationDate ? state.creationDate / 1000 : session.mtimeMs / 1000) +
          rIdx,
      );
      const agentId = "root";

      const promptText = req.message?.text?.trim() ?? "";
      if (promptText) {
        messages.push({
          id: `chat:vsc:${session.sessionId}:${rIdx}:user`,
          ts: toIsoUtc(reqEpoch),
          epoch: reqEpoch,
          agentId,
          role: "user",
          text: capChatText(resolveEmptyFileLinks(promptText)),
        });
      }

      const responses = Array.isArray(req.response) ? req.response : [];
      const reqQuestionAnalysis = analyzeCopilotRequestQuestions(req);

      for (let i = 0; i < responses.length; i++) {
        const item = responses[i]!;
        const stepEpoch = reqEpoch + (i + 1) * 0.01;
        const rkind = item.kind ?? "";

        if (rkind === "thinking") {
          const thinkText = extractMessageText(item.value).trim();
          const genTitle =
            typeof item.generatedTitle === "string"
              ? item.generatedTitle.trim()
              : "";
          const body = thinkText || genTitle;
          if (body) {
            messages.push({
              id: `chat:vsc:${session.sessionId}:${rIdx}:${i}:thk`,
              ts: toIsoUtc(stepEpoch),
              epoch: stepEpoch,
              agentId,
              role: "thinking",
              text: capChatText(resolveEmptyFileLinks(body)),
              thinking: capChatText(resolveEmptyFileLinks(body)),
            });
          }
        } else if (!rkind || rkind === "markdownContent" || rkind === "text") {
          const txt = (
            extractMessageText(item.value) || extractMessageText(item.content)
          ).trim();
          if (txt) {
            messages.push({
              id: `chat:vsc:${session.sessionId}:${rIdx}:${i}:ast`,
              ts: toIsoUtc(stepEpoch),
              epoch: stepEpoch,
              agentId,
              role: "assistant",
              text: capChatText(resolveEmptyFileLinks(txt)),
            });
          }
        } else if (rkind === "toolInvocationSerialized") {
          const tname = item.toolId || item.toolName || "tool";
          const callId =
            item.toolCallId || `${req.requestId ?? rIdx}:${i}:${tname}`;
          const msg =
            extractMessageText(item.pastTenseMessage) ||
            extractMessageText(item.invocationMessage) ||
            item.generatedTitle ||
            tname;
          const lowTool = tname.toLowerCase();

          if (isSubagentToolName(lowTool)) {
            const tsd = item.toolSpecificData;
            const subLabel = String(
              tsd?.subAgentName ??
                tsd?.agentName ??
                tsd?.agentType ??
                tsd?.agent_type ??
                tsd?.subagent_type ??
                tsd?.name ??
                tsd?.description ??
                item.generatedTitle ??
                "Subagent",
            ).trim();
            const explicitSubId =
              (typeof tsd?.subAgentInvocationId === "string" &&
                tsd.subAgentInvocationId.trim() &&
                tsd.subAgentInvocationId.trim() !== "root" &&
                tsd.subAgentInvocationId.trim()) ||
              (typeof tsd?.agentId === "string" &&
                tsd.agentId.trim() &&
                tsd.agentId.trim() !== "root" &&
                tsd.agentId.trim()) ||
              (typeof tsd?.subagentId === "string" &&
                tsd.subagentId.trim() &&
                tsd.subagentId.trim() !== "root" &&
                tsd.subagentId.trim()) ||
              undefined;
            const baseSlug =
              subLabel
                .toLowerCase()
                .replace(/[^a-z0-9_-]+/g, "-")
                .replace(/^-+|-+$/g, "") || "subagent";
            let subId: string;
            if (explicitSubId) {
              subId = explicitSubId;
              usedSubagentSlugs.add(subId);
            } else {
              subId = baseSlug;
              let suffix = 2;
              while (usedSubagentSlugs.has(subId)) {
                subId = `${baseSlug}-${suffix++}`;
              }
              usedSubagentSlugs.add(subId);
            }
            const rawSubPrompt =
              typeof tsd?.prompt === "string"
                ? tsd.prompt
                : typeof tsd?.instructions === "string"
                  ? tsd.instructions
                  : typeof tsd?.description === "string"
                    ? tsd.description
                    : extractMessageText(item.invocationMessage);
            const doneText = item.isComplete
              ? (
                  extractMessageText(item.pastTenseMessage) ||
                  (typeof item.resultDetails === "string"
                    ? item.resultDetails
                    : "")
                ).trim()
              : "";
            const subText = [rawSubPrompt.trim(), doneText]
              .filter(Boolean)
              .join("\n\n");
            messages.push({
              id: `chat:vsc:${session.sessionId}:${rIdx}:${i}:sub`,
              ts: toIsoUtc(stepEpoch),
              epoch: stepEpoch,
              agentId,
              role: "subagent",
              text: capChatText(
                resolveEmptyFileLinks(subText || `Spawned ${subLabel}`),
              ),
              subagentId: subId,
              subagentLabel: subLabel,
            });
          } else if (
            isCopilotAskTool(lowTool) &&
            !isStudioDirectAskTool(lowTool)
          ) {
            const mergedQs = reqQuestionAnalysis.mergedAskQuestions.get(i);
            const askQs =
              mergedQs && mergedQs.length > 0
                ? mergedQs
                : extractCopilotItemQuestions(item);
            const isAskSuppressed =
              Boolean(item.isComplete) ||
              reqQuestionAnalysis.suppressedAskIndices.has(i);
            const qText = formatQuestionsPreview(
              askQs,
              cleanHumanSummary(msg, 120) || "Waiting for user answer",
            );
            messages.push({
              id: `chat:vsc:${session.sessionId}:${rIdx}:${i}:ask`,
              ts: toIsoUtc(stepEpoch),
              epoch: stepEpoch,
              agentId,
              role: "question",
              text: capChatText(resolveEmptyFileLinks(qText)),
              ...(!isAskSuppressed
                ? { pendingPromptId: computePendingPromptId(agentId, callId) }
                : {}),
            });
          } else {
            const specificArgs = item.toolSpecificData ?? {};
            const isMsgTool = isMessageToolName(lowTool);
            if (isMsgTool) {
              const msgInfo = extractMessagePayload(specificArgs);
              messages.push({
                id: `chat:vsc:${session.sessionId}:${rIdx}:${i}:msg`,
                ts: toIsoUtc(stepEpoch),
                epoch: stepEpoch,
                agentId,
                role: "subagent",
                text: capChatText(
                  resolveEmptyFileLinks(
                    msgInfo.msgBody || summarizeToolCall(tname, specificArgs),
                  ),
                ),
                ...(msgInfo.msgTarget ? { subagentId: msgInfo.msgTarget } : {}),
              });
            } else {
              const cleanMsg =
                cleanHumanSummary(msg, 140) ||
                summarizeToolCall(tname, specificArgs);
              const outStr =
                typeof item.resultDetails === "string"
                  ? item.resultDetails
                  : item.resultDetails !== undefined
                    ? JSON.stringify(item.resultDetails, null, 2)
                    : "";
              const ref: ChatToolCallRef = {
                toolCallId: callId,
                toolName: tname,
                summary: cleanMsg,
                status: item.isComplete ? "ok" : "running",
                ...(Object.keys(specificArgs).length > 0
                  ? {
                      inputPreview: capChatText(
                        JSON.stringify(specificArgs),
                        4096,
                      ),
                    }
                  : {}),
                ...(outStr ? { output: capChatText(outStr) } : {}),
              };
              messages.push({
                id: `chat:vsc:${session.sessionId}:${rIdx}:${i}:tool`,
                ts: toIsoUtc(stepEpoch),
                epoch: stepEpoch,
                agentId,
                role: "tool",
                text: cleanMsg,
                tools: [ref],
              });
            }
          }
        } else if (
          rkind === "questionCarousel" ||
          rkind === "elicitationSerialized"
        ) {
          if (reqQuestionAnalysis.mergedCarouselToAskIdx.has(i)) {
            continue;
          }
          const isSuppressed =
            reqQuestionAnalysis.suppressedCarouselIndices.has(i);
          const carouselQs = extractCopilotItemQuestions(item);
          const qText = formatQuestionsPreview(
            carouselQs,
            "Waiting for user answer",
          );
          const callId =
            item.toolCallId || `${req.requestId ?? rIdx}:${i}:${rkind}`;
          messages.push({
            id: `chat:vsc:${session.sessionId}:${rIdx}:${i}:car`,
            ts: toIsoUtc(stepEpoch),
            epoch: stepEpoch,
            agentId,
            role: "question",
            text: capChatText(resolveEmptyFileLinks(qText)),
            ...(!isSuppressed
              ? { pendingPromptId: computePendingPromptId(agentId, callId) }
              : {}),
          });
        } else if (rkind === "textEditGroup") {
          const callId = `${req.requestId ?? rIdx}:${i}:edit`;
          const fileBase = extractUriBasename(item.uri);
          const summary = fileBase ? `Edit ${fileBase}` : "Edit workspace files";
          messages.push({
            id: `chat:vsc:${session.sessionId}:${rIdx}:${i}:edit`,
            ts: toIsoUtc(stepEpoch),
            epoch: stepEpoch,
            agentId,
            role: "tool",
            text: summary,
            tools: [
              {
                toolCallId: callId,
                toolName: "copilot_edit",
                summary,
                status: "ok",
              },
            ],
          });
        }
      }
    }

    // Check sibling GitHub.copilot-chat/transcripts/*.jsonl for matching session/subagent transcripts
    const wsHashDir = path.resolve(path.dirname(session.filePath), "..");
    const transcriptsDir = path.join(
      wsHashDir,
      "GitHub.copilot-chat",
      "transcripts",
    );
    const allowedRoots = this.getDefaultAllowedTranscriptRoots(
      session.workspacePath,
    );
    try {
      const tFiles = (await fs.readdir(transcriptsDir)).sort();
      const usedChildTranscriptSlugs = new Set<string>();
      for (const fname of tFiles) {
        if (!fname.endsWith(".jsonl")) continue;
        const tp = path.join(transcriptsDir, fname);
        const validPath = await validateTranscriptPath(tp, allowedRoots, {
          maxBytes: MAX_TRANSCRIPT_BYTES,
        });
        if (!validPath) continue;
        const raw = await fs.readFile(validPath, "utf8").catch(() => "");
        if (!raw) continue;
        const rows = parseJsonlRows(raw);
        const startRow = rows.find(
          (r) => (r.type ?? r.event ?? "").toLowerCase() === "session.start",
        );
        const d =
          startRow?.data && typeof startRow.data === "object"
            ? startRow.data
            : undefined;
        const trSid =
          (typeof d?.sessionId === "string" && d.sessionId.trim()) ||
          (typeof startRow?.sessionId === "string" &&
            startRow.sessionId.trim()) ||
          fname.replace(/\.jsonl$/i, "");
        const trParentSid =
          (typeof d?.parentSessionId === "string" &&
            d.parentSessionId.trim()) ||
          (typeof startRow?.parentSessionId === "string" &&
            startRow.parentSessionId.trim()) ||
          undefined;
        const isChildTranscript = trParentSid === session.sessionId;
        const isMatchingRootTranscript =
          !isChildTranscript &&
          trSid === session.sessionId &&
          messages.length === 0;
        if (isChildTranscript || isMatchingRootTranscript) {
          let agentOverride: string | undefined;
          const childAliases: string[] = [];
          if (isChildTranscript) {
            const rawChildName = [
              d?.agentDisplayName,
              d?.agentName,
              d?.agentType,
              d?.subAgentName,
              d?.subagentName,
              startRow?.agentName,
              startRow?.agentType,
            ]
              .find(
                (v): v is string =>
                  typeof v === "string" &&
                  Boolean(v.trim()) &&
                  !isOpaqueAgentId(v),
              )
              ?.trim();
            const explicitChildId = [
              d?.subAgentInvocationId,
              d?.agentId,
              d?.subagentId,
              startRow?.agentId,
            ]
              .find(
                (v): v is string =>
                  typeof v === "string" &&
                  Boolean(v.trim()) &&
                  v.trim() !== "root",
              )
              ?.trim();
            if (explicitChildId) {
              agentOverride = explicitChildId;
              usedChildTranscriptSlugs.add(agentOverride);
            } else if (rawChildName) {
              const baseSlug = normAlias(rawChildName) || "subagent";
              let slugId = baseSlug;
              let suffix = 2;
              while (usedChildTranscriptSlugs.has(slugId)) {
                slugId = `${baseSlug}-${suffix++}`;
              }
              usedChildTranscriptSlugs.add(slugId);
              agentOverride = slugId;
            } else {
              agentOverride = trSid;
            }
            if (rawChildName) childAliases.push(rawChildName);
            childAliases.push(trSid);
          }
          const trMsgs = await this.parseTranscriptChat(
            validPath,
            session.sessionId,
            {
              ...(agentOverride ? { agentIdOverride: agentOverride } : {}),
              workspacePath: session.workspacePath,
              projectId: session.projectId,
              allowedRoots,
            },
          );
          if (childAliases.length > 0) {
            for (const tm of trMsgs) {
              msgExtraAliases.set(tm, childAliases);
            }
          }
          messages.push(...trMsgs);
        }
      }
    } catch {
      // No sibling transcripts directory
    }

    return filterByAgent(messages);
  }
}
