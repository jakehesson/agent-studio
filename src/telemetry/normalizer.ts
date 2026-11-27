import type { ModelCatalogEntry, ModelIndex } from "../schema/model-index.js";
import type {
  AgentEdgeSnapshot,
  AgentStatus,
  AgentUsageMetrics,
  IdeSource,
  ModelSource,
  PendingHumanPrompt,
  PendingQuestionItem,
  SessionUsageSource,
  SessionUsageSummary,
  UsageSource,
} from "../schema/telemetry.js";
import {
  computeEventThinkingChars,
  computeSessionBreakdown,
  type AgentBreakdownInput,
} from "./breakdown.js";
import {
  PALETTE,
  classifyExternalTool,
  classifyMessage,
  cleanHumanSummary,
  computeMergeKey,
  computePendingPromptId,
  inferContextWindow,
  isOpaqueAgentId,
  lookupModelContextWindow,
  normalizePendingQuestions,
  normalizeSubagentLabel,
  prettifyAgentLabel,
  prettifyModelName,
  stripSubagentNamespacePrefix,
  toIsoUtc,
  type ActivityItem,
  type EnrichedEvent,
  type LegacyAgentState,
  type NodeType,
  type RichAgentNode,
  type RichSessionSnapshot,
  type TelemetryChannel,
  type UsageDelta,
} from "./types.js";

export const WORKING_FRESH_SEC = 12;
export const EXTERNAL_ACTIVE_SEC = 15;
export const ACTIVE_DECAY_SEC = 900;
export const STALE_SESSION_SEC = 1800;
export const THINKING_INLINE_MAX = 800;
export const MAX_THINKING_INLINE_EVENTS = 200;

const CHANNEL_FIDELITY_RANK: Record<TelemetryChannel, number> = {
  hook: 1,
  mcp: 2,
  passive: 3,
};

const CHANNEL_LABEL_RANK: Record<TelemetryChannel, number> = {
  hook: 1,
  passive: 2,
  mcp: 3,
};

function mergePayloads(
  low: Record<string, unknown> | undefined,
  high: Record<string, unknown> | undefined,
  channels: Set<TelemetryChannel>,
): Record<string, unknown> {
  return {
    ...(low ?? {}),
    ...(high ?? {}),
    _channels: [...channels],
  };
}

function mergeTwoEvents(a: EnrichedEvent, b: EnrichedEvent): EnrichedEvent {
  const rankA = CHANNEL_FIDELITY_RANK[a.channel];
  const rankB = CHANNEL_FIDELITY_RANK[b.channel];
  const higher = rankB > rankA ? b : a;
  const lower = rankB > rankA ? a : b;

  const channels = new Set<TelemetryChannel>([a.channel, b.channel]);
  for (const prev of [a.payload?._channels, b.payload?._channels]) {
    if (Array.isArray(prev)) {
      for (const ch of prev) {
        if (ch === "passive" || ch === "hook" || ch === "mcp") {
          channels.add(ch);
        }
      }
    }
  }

  // Earliest timestamp wins (hook arrives first for live starts)
  const earliestEpoch = Math.min(a.epoch, b.epoch);
  const ts = earliestEpoch === a.epoch ? a.ts : b.ts;

  // Prefer higher-fidelity channel's summary if non-empty, or longer summary
  const summary =
    higher.summary.length >= lower.summary.length && higher.summary.trim()
      ? higher.summary
      : lower.summary || higher.summary;

  const labelPref =
    CHANNEL_LABEL_RANK[b.channel] > CHANNEL_LABEL_RANK[a.channel] ? b : a;
  const labelAlt = labelPref === b ? a : b;

  return {
    ...lower,
    ...higher,
    id: higher.id,
    mergeKey: higher.mergeKey ?? lower.mergeKey,
    ts,
    epoch: earliestEpoch,
    channel: higher.channel,
    summary,
    agentLabel: labelPref.agentLabel || labelAlt.agentLabel,
    parentAgentId: labelPref.parentAgentId || labelAlt.parentAgentId,
    workspacePath: higher.workspacePath || lower.workspacePath,
    projectId: higher.projectId || lower.projectId,
    toolCallId: higher.toolCallId || lower.toolCallId,
    targetAgentId: higher.targetAgentId || lower.targetAgentId,
    isSelfDaemon: Boolean(a.isSelfDaemon || b.isSelfDaemon),
    isError: Boolean(a.isError || b.isError),
    waitingReason: higher.waitingReason ?? lower.waitingReason,
    status: higher.status ?? lower.status,
    usageDelta: higher.usageDelta ?? lower.usageDelta,
    payload: mergePayloads(lower.payload, higher.payload, channels),
  };
}

function parseTier2Key(
  key: string,
): { prefix: string; bucket: number } | null {
  if (!key.startsWith("t2:")) return null;
  const lastColon = key.lastIndexOf(":");
  if (lastColon < 0) return null;
  const bucket = Number.parseInt(key.slice(lastColon + 1), 10);
  if (!Number.isFinite(bucket)) return null;
  return { prefix: key.slice(0, lastColon), bucket };
}

export function canonicalDedupToolName(toolName?: string): string {
  const low = (toolName ?? "").trim().toLowerCase();
  if (!low) return "";
  if (
    low === "read" ||
    low === "read_file" ||
    low === "view" ||
    low === "view_file" ||
    low === "copilot_readfile"
  ) {
    return "fs_read";
  }
  if (
    low === "bash" ||
    low === "powershell" ||
    low === "run_command" ||
    low === "run_in_terminal" ||
    low === "execute/runinterminal"
  ) {
    return "shell";
  }
  if (
    low === "edit" ||
    low === "edit_file" ||
    low === "multiedit" ||
    low === "write" ||
    low === "write_file" ||
    low === "apply_patch" ||
    low === "create" ||
    low === "str_replace" ||
    low === "str_replace_editor" ||
    low === "copilot_applypatch" ||
    low === "copilot_edit" ||
    low === "copilot_replacestring" ||
    low === "copilot_multireplacestring" ||
    low === "copilot_createfile" ||
    low === "replace_file_content" ||
    low === "multi_replace_file_content" ||
    low === "edit/editfiles" ||
    low === "edit/createfile"
  ) {
    return "fs_edit";
  }
  if (
    low === "web_fetch" ||
    low === "webfetch" ||
    low === "read_url_content" ||
    low === "copilot_fetchwebpage" ||
    low === "vscode_fetchwebpage_internal"
  ) {
    return "web_fetch";
  }
  if (
    low === "grep" ||
    low === "grep_search" ||
    low === "rg" ||
    low === "copilot_findtextinfiles"
  ) {
    return "fs_search";
  }
  if (
    low === "glob" ||
    low === "find_by_name" ||
    low === "copilot_findfiles"
  ) {
    return "fs_glob";
  }
  if (
    low === "agent" ||
    low === "task" ||
    low === "invoke_subagent" ||
    low === "runsubagent" ||
    low === "agent/runsubagent"
  ) {
    return "subagent";
  }
  return low;
}

function extractNormalizedPrompt(ev: EnrichedEvent): string {
  const raw =
    (typeof ev.payload?.prompt === "string" && ev.payload.prompt) ||
    (typeof ev.payload?.body === "string" && ev.payload.body) ||
    ev.summary.replace(/^Human:\s*/i, "");
  return raw.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
}

/**
 * Deduplicates and merges events across passive transcripts, IDE hooks, and MCP calls.
 * - Tier-1: exact match on `t1:<session>:<agent>:<kind>:<toolCallId>`
 * - Tier-2: match on `t2:<session>:<agent>:<kind>:<toolName>:<bucket2s>` within ±1 bucket
 */
export function deduplicateEvents(events: EnrichedEvent[]): EnrichedEvent[] {
  const ordered = [...events].sort((a, b) => a.epoch - b.epoch);
  const result: EnrichedEvent[] = [];
  const tier1Index = new Map<string, number>();
  const tier2Index = new Map<string, number>();
  const idIndex = new Map<string, number>();
  const userInputBySessionAgent = new Map<string, number[]>();

  for (const ev of ordered) {
    const mergeKey =
      ev.mergeKey ??
      computeMergeKey({
        sessionId: ev.sessionId,
        agentId: ev.agentId,
        kind: ev.kind,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        epoch: ev.epoch,
      });

    let matchIdx: number | undefined = idIndex.get(ev.id);

    if (matchIdx === undefined && mergeKey.startsWith("t1:")) {
      matchIdx = tier1Index.get(mergeKey);
    }

    const t2 = parseTier2Key(mergeKey);
    const canonTool = canonicalDedupToolName(
      ev.toolName ?? (t2 ? t2.prefix.split(":").slice(4).join(":") : undefined),
    );
    const canonT2Prefix =
      t2 && canonTool
        ? `t2:${ev.sessionId}:${ev.agentId}:${ev.kind}:${canonTool}`
        : undefined;

    if (matchIdx === undefined && t2) {
      for (const delta of [0, -1, 1]) {
        const probe = `${t2.prefix}:${t2.bucket + delta}`;
        const candidate = tier2Index.get(probe);
        if (candidate !== undefined) {
          const existing = result[candidate];
          if (existing && existing.channel !== ev.channel) {
            matchIdx = candidate;
            break;
          }
        }
      }
      if (
        matchIdx === undefined &&
        canonT2Prefix &&
        canonT2Prefix !== t2.prefix
      ) {
        for (const delta of [0, -1, 1]) {
          const probe = `${canonT2Prefix}:${t2.bucket + delta}`;
          const candidate = tier2Index.get(probe);
          if (candidate !== undefined) {
            const existing = result[candidate];
            if (existing && existing.channel !== ev.channel) {
              matchIdx = candidate;
              break;
            }
          }
        }
      }
    }

    if (matchIdx === undefined && ev.kind === "user_input") {
      const normPrompt = extractNormalizedPrompt(ev);
      if (normPrompt) {
        const uiKey = `${ev.sessionId}:${ev.agentId}`;
        const candidates = userInputBySessionAgent.get(uiKey) ?? [];
        for (const candidate of candidates) {
          const existing = result[candidate];
          if (!existing) continue;
          const distinctSource =
            existing.channel !== ev.channel ||
            existing.payload?._passiveSource !== ev.payload?._passiveSource;
          if (!distinctSource) continue;
          if (Math.abs(ev.epoch - existing.epoch) > 15) continue;
          if (extractNormalizedPrompt(existing) === normPrompt) {
            matchIdx = candidate;
            break;
          }
        }
      }
    }

    if (matchIdx !== undefined) {
      const merged = mergeTwoEvents(result[matchIdx]!, ev);
      result[matchIdx] = merged;
      idIndex.set(merged.id, matchIdx);
      if (mergeKey.startsWith("t1:")) tier1Index.set(mergeKey, matchIdx);
      if (t2) {
        tier2Index.set(mergeKey, matchIdx);
        if (canonT2Prefix && canonT2Prefix !== t2.prefix) {
          tier2Index.set(`${canonT2Prefix}:${t2.bucket}`, matchIdx);
        }
      }
    } else {
      const idx = result.length;
      result.push({ ...ev, mergeKey });
      idIndex.set(ev.id, idx);
      if (mergeKey.startsWith("t1:")) tier1Index.set(mergeKey, idx);
      if (t2) {
        tier2Index.set(mergeKey, idx);
        if (canonT2Prefix && canonT2Prefix !== t2.prefix) {
          tier2Index.set(`${canonT2Prefix}:${t2.bucket}`, idx);
        }
      }
      if (ev.kind === "user_input") {
        const uiKey = `${ev.sessionId}:${ev.agentId}`;
        let list = userInputBySessionAgent.get(uiKey);
        if (!list) {
          list = [];
          userInputBySessionAgent.set(uiKey, list);
        }
        list.push(idx);
      }
    }
  }

  result.sort((a, b) => a.epoch - b.epoch);
  return result;
}

export function toLegacyState(status: AgentStatus): LegacyAgentState {
  switch (status) {
    case "THINKING":
      return "thinking";
    case "WORKING":
      return "working";
    case "WAITING":
      return "waiting";
    case "BLOCKED":
      return "blocker";
    case "DONE":
      return "done";
    case "IDLE":
      return "idle";
  }
}

export interface SnapshotBuildOptions {
  sessionId: string;
  ide?: IdeSource;
  projectId?: string;
  workspacePath?: string;
  nowEpochSec?: number;
  definitions?: Array<{
    id: string;
    model?: string;
  }>;
  modelContextWindows?: Record<string, number>;
  modelCatalog?: readonly ModelCatalogEntry[] | ModelIndex;
}

interface MutableAgentState {
  id: string;
  label: string;
  parentAgentId?: string;
  ide: IdeSource;
  nodeType: NodeType;
  isRoot: boolean;
  role: string;
  color: string;
  action: string;
  steps: number;
  toolCalls: number;
  messagesSent: number;
  messagesReceived: number;
  lastEventEpoch: number;
  firstEventEpoch: number;
  openTools: Map<string, string>;
  isThinking: boolean;
  thinkingSinceEpoch?: number;
  thinkingAction?: string;
  hasBlocker: boolean;
  reportedDone: boolean;
  waitingReason: "user" | "tool_approval" | "subagent" | null;
  waitingDetail: string | null;
  openPendingPrompt: PendingHumanPrompt | null;
  recentActions: Array<{ ts: string; tool: string; text: string }>;
  convId?: string;
  // Token, context & model usage accumulators
  model?: string;
  modelSource: ModelSource;
  usageSource: UsageSource;
  hasExplicitUsage: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hasCacheSplit: boolean;
  hasUnsplitCached: boolean;
  reasoningTokens: number;
  hasExactReasoning: boolean;
  hadIsTotalUsage: boolean;
  thinkingChars: number;
  turnEndCount: number;
  userInputCount: number;
  events: EnrichedEvent[];
  contextTokens: number;
  contextWindow?: number;
  costUsd?: number;
  fallbackChars: number;
  fallbackInputChars: number;
  fallbackOutputChars: number;
  fallbackPriorProseChars: number;
  fallbackTurnProseChars: number;
  fallbackTurnTotalChars: number;
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

function formatHms(epochSec: number): string {
  const d = new Date(Math.round(epochSec * 1000));
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function strVal(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function buildPendingPromptForEvent(
  ag: MutableAgentState,
  ev: EnrichedEvent,
): PendingHumanPrompt | null {
  if (
    (ev.waitingReason !== "user" && ev.waitingReason !== "tool_approval") ||
    ev.status === "denied"
  ) {
    return null;
  }

  const kind: "question" | "approval" =
    ev.payload?.promptKind === "approval" || ev.waitingReason === "tool_approval"
      ? "approval"
      : "question";

  let questions: PendingQuestionItem[] = normalizePendingQuestions(
    ev.payload?.questions,
    { defaultAllowCustomInput: true },
  );

  if (questions.length === 0) {
    const rawArgs =
      ev.payload?.args ??
      ev.payload?.input ??
      ev.payload?.toolInput ??
      ev.payload?.toolSpecificData;
    questions = normalizePendingQuestions(rawArgs, {
      defaultAllowCustomInput: true,
    });
  }

  if (questions.length === 0 && typeof ev.payload?.body === "string" && ev.payload.body.trim()) {
    questions = [
      {
        question: ev.payload.body.trim(),
        type: "text",
        options: [],
        allowCustomInput: true,
      },
    ];
  }

  if (questions.length === 0) {
    if (kind === "approval") {
      const promptMsg =
        cleanHumanSummary(
          String(
            ev.payload?.promptSummary ??
              ev.summary ??
              `Approve ${ev.toolName ?? "tool"}?`,
          ),
          300,
        ) || `Approve ${ev.toolName ?? "tool"}?`;
      questions = [
        {
          question: promptMsg,
          type: "single_select",
          options: [
            { label: "Approve", recommended: true },
            { label: "Reject" },
          ],
          allowCustomInput: true,
        },
      ];
    } else {
      const fallbackQ =
        cleanHumanSummary(
          String(
            ev.payload?.prompt ??
              ev.payload?.body ??
              ev.summary ??
              "Waiting for user answer",
          ),
          300,
        ) || "Waiting for user answer";
      questions = [
        {
          question: fallbackQ,
          type: "text",
          options: [],
          allowCustomInput: true,
        },
      ];
    }
  }

  const title =
    cleanHumanSummary(
      String(
        ev.payload?.promptTitle ??
          questions[0]?.header ??
          questions[0]?.question ??
          ev.summary ??
          (kind === "approval"
            ? `Approval: ${ev.toolName ?? "tool"}`
            : "Question for user"),
      ),
      140,
    ) || "Waiting for input";

  const rawSummary =
    typeof ev.payload?.promptSummary === "string"
      ? ev.payload.promptSummary
      : ev.summary;
  const summary = cleanHumanSummary(rawSummary ?? "", 240) || undefined;

  const firstOpts = questions[0]?.options ?? [];
  const options =
    firstOpts.length > 0
      ? firstOpts.map((o) => ({
          label: o.label,
          ...(o.recommended ? { recommended: true } : {}),
        }))
      : undefined;

  const blockingToolCall =
    typeof ev.payload?.blockingToolCall === "boolean"
      ? ev.payload.blockingToolCall
      : Boolean(ev.toolName);
  const directReply = ev.payload?.directReply === true ? true : undefined;
  const promptSource =
    ev.payload?.promptSource === "native" ||
    ev.payload?.promptSource === "studio-mcp" ||
    ev.payload?.promptSource === "studio-vscode-lm"
      ? ev.payload.promptSource
      : undefined;
  const promptStatus =
    ev.payload?.promptStatus === "pending" ||
    ev.payload?.promptStatus === "answered" ||
    ev.payload?.promptStatus === "canceled" ||
    ev.payload?.promptStatus === "expired"
      ? ev.payload.promptStatus
      : undefined;
  const expiresAt =
    typeof ev.payload?.expiresAt === "string" && ev.payload.expiresAt.trim()
      ? ev.payload.expiresAt.trim()
      : undefined;
  const promptId =
    typeof ev.payload?.promptId === "string" && ev.payload.promptId.trim()
      ? ev.payload.promptId.trim()
      : computePendingPromptId(ag.id, ev.toolCallId, ev.id);

  return {
    id: promptId,
    ...(ev.toolCallId ? { toolCallId: ev.toolCallId } : {}),
    ...(ev.toolName ? { toolName: ev.toolName } : {}),
    agentId: ag.id,
    agentLabel: ag.label,
    kind,
    title,
    ...(summary ? { summary } : {}),
    questions,
    ...(options ? { options } : {}),
    ts: ev.ts,
    blockingToolCall,
    ...(directReply !== undefined ? { directReply } : {}),
    ...(promptSource !== undefined ? { promptSource } : {}),
    ...(promptStatus !== undefined ? { status: promptStatus } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
    ...(ev.workspacePath ? { workspacePath: ev.workspacePath } : {}),
    ...(ev.ide ? { ide: ev.ide } : {}),
  };
}

function doesToolEndMatchPrompt(
  prompt: PendingHumanPrompt,
  ev: EnrichedEvent,
): boolean {
  if (prompt.toolCallId && ev.toolCallId) {
    return prompt.toolCallId === ev.toolCallId;
  }
  if (prompt.toolName && ev.toolName) {
    return prompt.toolName.toLowerCase() === ev.toolName.toLowerCase();
  }
  return true;
}

function isUuidOrOpaqueId(raw?: string): boolean {
  return isOpaqueAgentId(raw);
}

function isGenericSubagentLabel(raw?: string): boolean {
  if (!raw) return true;
  if (isUuidOrOpaqueId(raw)) return true;
  const norm = normalizeSubagentLabel(raw);
  return !norm || norm === "subagent";
}

function normalizePromptKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const norm = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return norm.length >= 12 ? norm.slice(0, 120) : undefined;
}

/**
 * Reconciles VS Code Copilot passive subagent runs (slug/UUID from chatSessions or
 * transcript.jsonl) with live hook subagents (SubagentStart/Stop UUIDs and orphan
 * subagent hook events) onto a single canonical subagent ID per invocation.
 */
function reconcileCopilotSubagents(rawEvents: EnrichedEvent[]): EnrichedEvent[] {
  if (!rawEvents.some((e) => e.ide === "copilot-vscode")) {
    return rawEvents;
  }

  const events = rawEvents.map((e) => ({
    ...e,
    ...(e.payload ? { payload: { ...e.payload } } : {}),
  }));

  interface PassiveSubCand {
    pId: string;
    spawnEv?: EnrichedEvent;
    epoch: number;
    normLabel: string;
    readableLabel: string;
    passiveSource?: string;
    isGeneric: boolean;
  }
  interface HookSubCand {
    hId: string;
    spawnEv?: EnrichedEvent;
    spawnEvs: EnrichedEvent[];
    hasDoneOrChild: boolean;
    epoch: number;
    normLabel: string;
    altNormLabels: Set<string>;
    readableLabel?: string;
    isGeneric: boolean;
  }

  const passiveByPId = new Map<string, PassiveSubCand>();
  const passiveNonSpawnByPId = new Map<string, PassiveSubCand>();
  const hookByHId = new Map<string, HookSubCand>();

  for (const ev of events) {
    if (ev.ide !== "copilot-vscode") continue;

    if (
      ev.channel === "passive" &&
      ev.kind === "subagent_spawn" &&
      ev.targetAgentId &&
      ev.targetAgentId !== "root"
    ) {
      const pId = ev.targetAgentId;
      const explicitReadable =
        [strVal(ev.payload?.agentLabel), strVal(ev.payload?.agentType)].find(
          (v) => v && !isUuidOrOpaqueId(v),
        );
      const readable =
        explicitReadable || (!isUuidOrOpaqueId(pId) ? pId : "Subagent");
      const labelCandidate =
        explicitReadable ||
        (!isUuidOrOpaqueId(pId) ? pId.replace(/-\d+$/, "") : "Subagent");
      const normLabel = normalizeSubagentLabel(labelCandidate);
      const isGen =
        !normLabel ||
        normLabel === "subagent" ||
        isUuidOrOpaqueId(labelCandidate);
      const passiveSource = strVal(ev.payload?._passiveSource);
      const prev = passiveByPId.get(pId);
      if (!prev || ev.epoch < prev.epoch) {
        passiveByPId.set(pId, {
          pId,
          spawnEv: ev,
          epoch: ev.epoch,
          normLabel,
          readableLabel: readable,
          passiveSource,
          isGeneric: isGen,
        });
      }
      continue;
    }

    if (
      ev.channel === "passive" &&
      ev.agentId &&
      ev.agentId !== "root" &&
      ev.agentId !== "human" &&
      !ev.agentId.startsWith("ext:")
    ) {
      const pId = ev.agentId;
      const candLabel =
        [
          strVal(ev.agentLabel),
          strVal(ev.payload?.agentLabel),
          strVal(ev.payload?.agentType),
        ].find((v) => v && !isGenericSubagentLabel(v)) ||
        (!isGenericSubagentLabel(pId) ? pId : undefined);
      const readable = candLabel || "Subagent";
      const labelCandidate =
        candLabel ||
        (!isUuidOrOpaqueId(pId) ? pId.replace(/-\d+$/, "") : "Subagent");
      const normLabel = normalizeSubagentLabel(labelCandidate);
      const isGen = isGenericSubagentLabel(labelCandidate);
      const passiveSource = strVal(ev.payload?._passiveSource);
      const prev = passiveNonSpawnByPId.get(pId);
      if (!prev) {
        passiveNonSpawnByPId.set(pId, {
          pId,
          epoch: ev.epoch,
          normLabel,
          readableLabel: readable,
          passiveSource,
          isGeneric: isGen,
        });
      } else {
        prev.epoch = Math.min(prev.epoch, ev.epoch);
        if (prev.isGeneric && candLabel && !isGenericSubagentLabel(candLabel)) {
          prev.readableLabel = candLabel;
          prev.normLabel = normalizeSubagentLabel(candLabel);
          prev.isGeneric = false;
        }
      }
    }

    if (ev.channel === "hook") {
      const registerHookCand = (
        hId: string,
        readableList: Array<string | undefined>,
        spawnEv?: EnrichedEvent,
        isDoneOrChild = false,
      ): void => {
        const cleanList = readableList.filter(
          (v): v is string => Boolean(v && !isGenericSubagentLabel(v)),
        );
        const cleanReadable = cleanList[0];
        const normLabel = normalizeSubagentLabel(cleanReadable || hId);
        const isGen = !cleanReadable;
        const prev = hookByHId.get(hId);
        if (!prev) {
          const altNormLabels = new Set<string>();
          for (const lbl of cleanList) {
            const nl = normalizeSubagentLabel(lbl);
            if (nl) altNormLabels.add(nl);
          }
          if (normLabel) altNormLabels.add(normLabel);
          hookByHId.set(hId, {
            hId,
            ...(spawnEv ? { spawnEv } : {}),
            spawnEvs: spawnEv ? [spawnEv] : [],
            hasDoneOrChild: isDoneOrChild,
            epoch: ev.epoch,
            normLabel,
            altNormLabels,
            readableLabel: cleanReadable,
            isGeneric: isGen,
          });
        } else {
          if (spawnEv) {
            prev.spawnEvs.push(spawnEv);
            if (!prev.spawnEv || ev.epoch < prev.spawnEv.epoch) {
              prev.spawnEv = spawnEv;
            }
          }
          if (isDoneOrChild) {
            prev.hasDoneOrChild = true;
          }
          prev.epoch = Math.min(prev.epoch, ev.epoch);
          for (const lbl of cleanList) {
            const nl = normalizeSubagentLabel(lbl);
            if (nl) prev.altNormLabels.add(nl);
          }
          if (cleanReadable && (!prev.readableLabel || prev.isGeneric)) {
            prev.readableLabel = cleanReadable;
            prev.normLabel = normalizeSubagentLabel(cleanReadable);
            prev.isGeneric = false;
          }
        }
      };

      if (
        ev.kind === "subagent_spawn" &&
        ev.targetAgentId &&
        ev.targetAgentId !== "root"
      ) {
        registerHookCand(
          ev.targetAgentId,
          [
            strVal(ev.payload?.agentLabel),
            strVal(ev.payload?.agentType),
            strVal(ev.payload?.agentName),
          ],
          ev,
          false,
        );
      } else if (
        ev.agentId &&
        ev.agentId !== "root" &&
        ev.agentId !== "human" &&
        !ev.agentId.startsWith("ext:")
      ) {
        registerHookCand(
          ev.agentId,
          [
            strVal(ev.agentLabel),
            strVal(ev.payload?.agentLabel),
            strVal(ev.payload?.agentType),
            strVal(ev.payload?.agentName),
          ],
          undefined,
          true,
        );
      } else if (
        ev.kind === "subagent_done" &&
        ev.targetAgentId &&
        ev.targetAgentId !== "root"
      ) {
        registerHookCand(
          ev.targetAgentId,
          [
            strVal(ev.payload?.agentLabel),
            strVal(ev.payload?.agentType),
            strVal(ev.payload?.agentName),
          ],
          undefined,
          true,
        );
      }
    }
  }

  // Step 0: Correlate label-only hook subagent_spawn (no agentId) with UUID-bearing
  // hook subagent_done / child tool hooks so they collapse onto one canonical node.
  const unlinkedHookSpawns: Array<{
    cand: HookSubCand;
    spawnEv: EnrichedEvent;
    normLabels: string[];
  }> = [];
  for (const cand of hookByHId.values()) {
    if (isUuidOrOpaqueId(cand.hId) || cand.hasDoneOrChild) continue;
    for (const spawnEv of cand.spawnEvs) {
      if (strVal(spawnEv.payload?.agentId)) continue;
      const norms = [...cand.altNormLabels].filter(
        (n) => n && n !== "subagent",
      );
      unlinkedHookSpawns.push({
        cand,
        spawnEv,
        normLabels: norms.length > 0 ? norms : [cand.normLabel].filter(Boolean),
      });
    }
  }
  if (unlinkedHookSpawns.length > 0) {
    unlinkedHookSpawns.sort((a, b) => a.spawnEv.epoch - b.spawnEv.epoch);
    const uuidHookTargets = [...hookByHId.values()]
      .filter((c) => isUuidOrOpaqueId(c.hId) && !c.spawnEv && c.hasDoneOrChild)
      .sort((a, b) => a.epoch - b.epoch);
    const matchedUuidSet = new Set<string>();
    const matchedSpawnEvs = new Set<EnrichedEvent>();

    const linkSpawnToUuid = (
      sp: { cand: HookSubCand; spawnEv: EnrichedEvent },
      u: HookSubCand,
    ): void => {
      matchedUuidSet.add(u.hId);
      matchedSpawnEvs.add(sp.spawnEv);
      sp.spawnEv.targetAgentId = u.hId;
      const resolvedLbl =
        (!sp.cand.isGeneric ? sp.cand.readableLabel : undefined) ||
        (!u.isGeneric ? u.readableLabel : undefined) ||
        (!isUuidOrOpaqueId(sp.cand.hId) ? sp.cand.hId : undefined);
      if (resolvedLbl) {
        u.readableLabel = resolvedLbl;
        u.normLabel = normalizeSubagentLabel(resolvedLbl);
        u.isGeneric = false;
        sp.spawnEv.payload = {
          ...(sp.spawnEv.payload ?? {}),
          agentLabel: resolvedLbl,
        };
      }
      sp.spawnEv.mergeKey = computeMergeKey({
        sessionId: sp.spawnEv.sessionId,
        agentId: sp.spawnEv.agentId,
        kind: sp.spawnEv.kind,
        toolCallId: sp.spawnEv.toolCallId,
        toolName: sp.spawnEv.toolName,
        epoch: sp.spawnEv.epoch,
      });
      u.spawnEv = sp.spawnEv;
      u.spawnEvs.push(sp.spawnEv);
      u.epoch = Math.min(u.epoch, sp.spawnEv.epoch);
    };

    // Pass 0a: Named label match within <= 300s (chronological FIFO)
    for (const sp of unlinkedHookSpawns) {
      if (sp.cand.isGeneric) continue;
      const match = uuidHookTargets.find(
        (u) =>
          !matchedUuidSet.has(u.hId) &&
          !u.isGeneric &&
          u.epoch >= sp.spawnEv.epoch - 5 &&
          u.epoch - sp.spawnEv.epoch <= 300 &&
          sp.normLabels.some((nl) => u.altNormLabels.has(nl)),
      );
      if (match) linkSpawnToUuid(sp, match);
    }

    // Pass 0b: Unambiguous single remaining generic/label-less UUID target within <= 30s
    const remSpawns = unlinkedHookSpawns.filter(
      (sp) => !matchedSpawnEvs.has(sp.spawnEv),
    );
    const remUuids = uuidHookTargets.filter((u) => !matchedUuidSet.has(u.hId));
    if (remSpawns.length === 1 && remUuids.length === 1) {
      const sp = remSpawns[0]!;
      const u = remUuids[0]!;
      if (Math.abs(u.epoch - sp.spawnEv.epoch) <= 30) {
        linkSpawnToUuid(sp, u);
      }
    }

    // Remove exhausted label-only hook candidates that have no remaining unlinked spawns
    for (const sp of unlinkedHookSpawns) {
      if (!matchedSpawnEvs.has(sp.spawnEv)) continue;
      const remaining = sp.cand.spawnEvs.filter((se) => !matchedSpawnEvs.has(se));
      if (remaining.length === 0) {
        hookByHId.delete(sp.cand.hId);
      } else {
        sp.cand.spawnEvs = remaining;
        sp.cand.spawnEv = remaining[0];
      }
    }
  }

  for (const [pId, actor] of passiveNonSpawnByPId.entries()) {
    if (!passiveByPId.has(pId) && !hookByHId.has(pId)) {
      passiveByPId.set(pId, actor);
    }
  }

  const cleanupOpaqueLabels = (): void => {
    for (const ev of events) {
      if (ev.ide !== "copilot-vscode") continue;
      const hLbl = hookByHId.get(ev.agentId)?.readableLabel;
      if (hLbl && isGenericSubagentLabel(ev.agentLabel)) {
        ev.agentLabel = hLbl;
      } else if (ev.agentLabel && isUuidOrOpaqueId(ev.agentLabel)) {
        delete ev.agentLabel;
      }
      if (hLbl && ev.summary === `Stop (${ev.agentId})`) {
        ev.summary = `Stop (${hLbl})`;
      }
      if (
        (ev.kind === "subagent_spawn" || ev.kind === "subagent_done") &&
        ev.targetAgentId
      ) {
        const targetLbl = hookByHId.get(ev.targetAgentId)?.readableLabel;
        if (targetLbl && isGenericSubagentLabel(strVal(ev.payload?.agentLabel))) {
          ev.payload = { ...(ev.payload ?? {}), agentLabel: targetLbl };
        }
      }
    }
  };

  if (passiveByPId.size === 0 || hookByHId.size === 0) {
    cleanupOpaqueLabels();
    return events;
  }

  const passiveList = [...passiveByPId.values()].sort(
    (a, b) => a.epoch - b.epoch,
  );
  const hookList = [...hookByHId.values()].sort((a, b) => a.epoch - b.epoch);

  const matchedHookIds = new Set<string>();
  const matchedPassiveIds = new Set<string>();
  const matches: Array<{ p: PassiveSubCand; h: HookSubCand }> = [];

  // 1. Exact ID pre-match
  for (const p of passiveList) {
    const exactH = hookByHId.get(p.pId);
    if (exactH && !matchedHookIds.has(exactH.hId)) {
      matchedPassiveIds.add(p.pId);
      matchedHookIds.add(exactH.hId);
      matches.push({ p, h: exactH });
    }
  }

  // 2. Best-pair matching by |h.epoch - p.epoch| ascending for named matches (<= 120s)
  const namedPairs: Array<{ p: PassiveSubCand; h: HookSubCand; diff: number }> = [];
  for (const p of passiveList) {
    if (matchedPassiveIds.has(p.pId) || p.isGeneric) continue;
    for (const h of hookList) {
      if (matchedHookIds.has(h.hId) || h.isGeneric) continue;
      if (h.normLabel !== p.normLabel) continue;
      const diff = Math.abs(h.epoch - p.epoch);
      if (diff <= 120) {
        namedPairs.push({ p, h, diff });
      }
    }
  }
  namedPairs.sort(
    (a, b) =>
      Math.floor(a.diff) - Math.floor(b.diff) ||
      a.p.epoch - b.p.epoch ||
      a.h.epoch - b.h.epoch,
  );
  for (const pair of namedPairs) {
    if (matchedPassiveIds.has(pair.p.pId) || matchedHookIds.has(pair.h.hId)) {
      continue;
    }
    matchedPassiveIds.add(pair.p.pId);
    matchedHookIds.add(pair.h.hId);
    matches.push({ p: pair.p, h: pair.h });
  }

  // 3. Generic/UUID-only pairs: unambiguous within <= 5s (or <= 15s if unambiguous in 15s),
  // treating dual-passive representations of the same normLabel as one logical invocation.
  const remPassives = passiveList.filter((p) => !matchedPassiveIds.has(p.pId));
  const remHooks = hookList.filter((h) => !matchedHookIds.has(h.hId));
  const genericPairs: Array<{ p: PassiveSubCand; h: HookSubCand; diff: number }> = [];
  for (const p of remPassives) {
    for (const h of remHooks) {
      if (!p.isGeneric && !h.isGeneric) continue;
      const diff = Math.abs(h.epoch - p.epoch);
      if (diff > 15) continue;
      const windowSec = diff <= 5 ? 5 : 15;
      const closeH = remHooks.filter((oh) => Math.abs(oh.epoch - p.epoch) <= windowSec);
      const closeP = remPassives.filter((op) => Math.abs(h.epoch - op.epoch) <= windowSec);
      const distinctPassiveGroup =
        closeP.length === 1 ||
        (!closeP.some((op) => op.isGeneric) &&
          new Set(closeP.map((op) => op.normLabel)).size === 1 &&
          new Set(closeP.map((op) => op.passiveSource ?? "")).size === closeP.length);
      if (closeH.length === 1 && distinctPassiveGroup) {
        genericPairs.push({ p, h, diff });
      }
    }
  }
  genericPairs.sort(
    (a, b) =>
      Math.floor(a.diff) - Math.floor(b.diff) ||
      a.p.epoch - b.p.epoch ||
      a.h.epoch - b.h.epoch,
  );
  for (const pair of genericPairs) {
    if (matchedPassiveIds.has(pair.p.pId) || matchedHookIds.has(pair.h.hId)) {
      continue;
    }
    matchedPassiveIds.add(pair.p.pId);
    matchedHookIds.add(pair.h.hId);
    matches.push({ p: pair.p, h: pair.h });
  }

  // 3b. Parallel / multi-spawn disambiguation within <= 15s:
  // First match by prompt prefix when available; then pair remaining primary passives
  // (skipping dual-source secondary twins of already-matched passives) greedily by |h.epoch - p.epoch|.
  const remHooksAfter3a = hookList.filter((h) => !matchedHookIds.has(h.hId));
  const remPassivesAfter3a = passiveList.filter((p) => !matchedPassiveIds.has(p.pId));
  if (remHooksAfter3a.length > 0 && remPassivesAfter3a.length > 0) {
    const promptPairs: Array<{ p: PassiveSubCand; h: HookSubCand; diff: number }> = [];
    for (const p of remPassivesAfter3a) {
      const pPrompt = normalizePromptKey(p.spawnEv?.payload?.prompt);
      if (!pPrompt) continue;
      for (const h of remHooksAfter3a) {
        if (!p.isGeneric && !h.isGeneric) continue;
        const hPrompt = normalizePromptKey(h.spawnEv?.payload?.prompt);
        if (!hPrompt) continue;
        const diff = Math.abs(h.epoch - p.epoch);
        if (diff > 15) continue;
        if (pPrompt === hPrompt || pPrompt.startsWith(hPrompt.slice(0, 40)) || hPrompt.startsWith(pPrompt.slice(0, 40))) {
          promptPairs.push({ p, h, diff });
        }
      }
    }
    promptPairs.sort(
      (a, b) =>
        Math.floor(a.diff) - Math.floor(b.diff) ||
        a.p.epoch - b.p.epoch ||
        a.h.epoch - b.h.epoch,
    );
    for (const pair of promptPairs) {
      if (matchedPassiveIds.has(pair.p.pId) || matchedHookIds.has(pair.h.hId)) {
        continue;
      }
      matchedPassiveIds.add(pair.p.pId);
      matchedHookIds.add(pair.h.hId);
      matches.push({ p: pair.p, h: pair.h });
    }

    const isDualTwinCandidate = (p: PassiveSubCand): boolean => {
      if (p.isGeneric || !p.passiveSource) return false;
      const hasMatchedTwin = matches.some(
        (m) =>
          !m.p.isGeneric &&
          m.p.normLabel === p.normLabel &&
          Boolean(m.p.passiveSource) &&
          m.p.passiveSource !== p.passiveSource &&
          Math.abs(p.epoch - m.p.epoch) <= 15,
      );
      if (hasMatchedTwin) return true;
      // Prefer chatSessions over transcript when both represent the same named run
      if (p.passiveSource !== "chatSessions") {
        return remPassivesAfter3a.some(
          (other) =>
            !matchedPassiveIds.has(other.pId) &&
            other.pId !== p.pId &&
            !other.isGeneric &&
            other.normLabel === p.normLabel &&
            other.passiveSource === "chatSessions" &&
            Math.abs(p.epoch - other.epoch) <= 15,
        );
      }
      return false;
    };

    const parallelPairs: Array<{ p: PassiveSubCand; h: HookSubCand; diff: number }> = [];
    for (const p of remPassivesAfter3a) {
      if (matchedPassiveIds.has(p.pId) || isDualTwinCandidate(p)) continue;
      for (const h of remHooksAfter3a) {
        if (matchedHookIds.has(h.hId)) continue;
        if (!p.isGeneric && !h.isGeneric) continue;
        const diff = Math.abs(h.epoch - p.epoch);
        if (diff <= 15) {
          parallelPairs.push({ p, h, diff });
        }
      }
    }
    parallelPairs.sort(
      (a, b) =>
        Math.floor(a.diff) - Math.floor(b.diff) ||
        a.p.epoch - b.p.epoch ||
        a.h.epoch - b.h.epoch,
    );
    for (const pair of parallelPairs) {
      if (matchedPassiveIds.has(pair.p.pId) || matchedHookIds.has(pair.h.hId)) {
        continue;
      }
      matchedPassiveIds.add(pair.p.pId);
      matchedHookIds.add(pair.h.hId);
      matches.push({ p: pair.p, h: pair.h });
    }
  }

  if (matches.length === 0) {
    cleanupOpaqueLabels();
    return events;
  }

  const pToH = new Map<string, { hId: string; readableLabel?: string }>();
  const hReadableById = new Map<string, string>();
  const matchedHSet = new Set<string>();
  const mergedSourcesByHId = new Map<string, Set<string>>();
  for (const { p, h } of matches) {
    const cleanP =
      p.readableLabel && p.readableLabel !== "Subagent" && !isUuidOrOpaqueId(p.readableLabel)
        ? stripSubagentNamespacePrefix(p.readableLabel)
        : undefined;
    const cleanH =
      h.readableLabel && !isUuidOrOpaqueId(h.readableLabel)
        ? stripSubagentNamespacePrefix(h.readableLabel)
        : undefined;
    const readableLabel =
      (h.readableLabel && p.readableLabel !== cleanP ? cleanH : undefined) ||
      cleanP ||
      cleanH ||
      p.readableLabel;
    pToH.set(p.pId, { hId: h.hId, readableLabel });
    matchedHSet.add(h.hId);
    if (readableLabel) hReadableById.set(h.hId, readableLabel);
    const srcs = new Set<string>();
    if (p.passiveSource) srcs.add(p.passiveSource);
    mergedSourcesByHId.set(h.hId, srcs);
  }

  // 4. Dual passive source reconciliation: remap secondary passive spawns from a different
  // _passiveSource matching an already-matched p within ±15s onto the same matchedHId
  const secondaryPassiveLinks: Array<{
    secondary: PassiveSubCand;
    primary: PassiveSubCand;
    hId: string;
  }> = [];
  for (const p2 of passiveList) {
    if (matchedPassiveIds.has(p2.pId)) continue;
    if (!p2.passiveSource || p2.isGeneric) continue;
    let bestMatch: { p: PassiveSubCand; h: HookSubCand; diff: number } | undefined;
    for (const m of matches) {
      if (!m.p.passiveSource || m.p.passiveSource === p2.passiveSource) continue;
      if (mergedSourcesByHId.get(m.h.hId)?.has(p2.passiveSource)) continue;
      if (m.p.isGeneric || m.p.normLabel !== p2.normLabel) continue;
      const diff = Math.abs(p2.epoch - m.p.epoch);
      if (diff <= 15 && (!bestMatch || diff < bestMatch.diff)) {
        bestMatch = { p: m.p, h: m.h, diff };
      }
    }
    if (bestMatch) {
      matchedPassiveIds.add(p2.pId);
      mergedSourcesByHId.get(bestMatch.h.hId)?.add(p2.passiveSource);
      pToH.set(p2.pId, {
        hId: bestMatch.h.hId,
        readableLabel: hReadableById.get(bestMatch.h.hId),
      });
      secondaryPassiveLinks.push({
        secondary: p2,
        primary: bestMatch.p,
        hId: bestMatch.h.hId,
      });
    }
  }

  // Canonicalize pId -> hId across all copilot-vscode events and collect O(N) done/epoch indices
  const passiveDoneByHId = new Map<string, EnrichedEvent[]>();
  const hookDoneByHId = new Map<string, EnrichedEvent[]>();
  const maxHookEpochByHId = new Map<string, number>();

  for (const ev of events) {
    if (ev.ide !== "copilot-vscode") continue;
    let remappedActor = false;
    const pMapActor = pToH.get(ev.agentId);
    if (pMapActor) {
      ev.agentId = pMapActor.hId;
      remappedActor = true;
    }
    const pMapTarget = ev.targetAgentId ? pToH.get(ev.targetAgentId) : undefined;
    if (pMapTarget) {
      ev.targetAgentId = pMapTarget.hId;
    }
    const pMapParent = ev.parentAgentId ? pToH.get(ev.parentAgentId) : undefined;
    if (pMapParent) {
      ev.parentAgentId = pMapParent.hId;
    }

    if (matchedHSet.has(ev.agentId)) {
      if (!ev.parentAgentId) {
        ev.parentAgentId = "root";
      }
      const lbl = hReadableById.get(ev.agentId);
      if (
        lbl &&
        (!ev.agentLabel ||
          ev.agentLabel === ev.agentId ||
          isGenericSubagentLabel(ev.agentLabel))
      ) {
        ev.agentLabel = lbl;
      } else if (ev.agentLabel && isUuidOrOpaqueId(ev.agentLabel)) {
        delete ev.agentLabel;
      }
      if (lbl && ev.summary === `Stop (${ev.agentId})`) {
        ev.summary = `Stop (${lbl})`;
      }
    } else if (ev.agentLabel && isUuidOrOpaqueId(ev.agentLabel)) {
      const hLbl = hookByHId.get(ev.agentId)?.readableLabel;
      if (hLbl) {
        ev.agentLabel = hLbl;
      } else {
        delete ev.agentLabel;
      }
    }

    if (
      ev.targetAgentId &&
      matchedHSet.has(ev.targetAgentId) &&
      (ev.kind === "subagent_spawn" || ev.kind === "subagent_done")
    ) {
      const lbl = hReadableById.get(ev.targetAgentId);
      const curPayloadLbl = strVal(ev.payload?.agentLabel);
      if (
        lbl &&
        (!curPayloadLbl ||
          isGenericSubagentLabel(curPayloadLbl) ||
          stripSubagentNamespacePrefix(curPayloadLbl) !== curPayloadLbl)
      ) {
        ev.payload = { ...(ev.payload ?? {}), agentLabel: lbl };
      }
    }

    if (remappedActor) {
      ev.mergeKey = computeMergeKey({
        sessionId: ev.sessionId,
        agentId: ev.agentId,
        kind: ev.kind,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        epoch: ev.epoch,
      });
    }

    // Pre-index subagent_done and hook max epochs per matched hId in O(N)
    const relevantHId =
      ev.targetAgentId && matchedHSet.has(ev.targetAgentId)
        ? ev.targetAgentId
        : matchedHSet.has(ev.agentId)
          ? ev.agentId
          : undefined;
    if (relevantHId) {
      if (ev.channel === "hook") {
        const prevMax = maxHookEpochByHId.get(relevantHId);
        if (prevMax === undefined || ev.epoch > prevMax) {
          maxHookEpochByHId.set(relevantHId, ev.epoch);
        }
      }
      if (ev.kind === "subagent_done") {
        const map = ev.channel === "passive" ? passiveDoneByHId : ev.channel === "hook" ? hookDoneByHId : undefined;
        if (map) {
          let list = map.get(relevantHId);
          if (!list) {
            list = [];
            map.set(relevantHId, list);
          }
          list.push(ev);
        }
      }
    }
  }

  for (const { p, h } of matches) {
    if (p.spawnEv) {
      const spawnCallId = p.spawnEv.toolCallId || `reconcile-${h.hId}`;
      p.spawnEv.toolCallId = spawnCallId;
      p.spawnEv.mergeKey = computeMergeKey({
        sessionId: p.spawnEv.sessionId,
        agentId: p.spawnEv.agentId,
        kind: p.spawnEv.kind,
        toolCallId: spawnCallId,
        toolName: p.spawnEv.toolName,
        epoch: p.spawnEv.epoch,
      });
      if (h.spawnEv) {
        h.spawnEv.toolCallId = spawnCallId;
        h.spawnEv.toolName = h.spawnEv.toolName || p.spawnEv.toolName;
        h.spawnEv.mergeKey = p.spawnEv.mergeKey;
      }
    }

    const pDoneCandidates = passiveDoneByHId.get(h.hId) ?? [];
    const pDone =
      pDoneCandidates.find(
        (e) => p.spawnEv?.toolCallId && e.toolCallId === p.spawnEv.toolCallId,
      ) ?? pDoneCandidates[0];
    const hDone = (hookDoneByHId.get(h.hId) ?? [])[0];
    if (pDone && hDone) {
      // Prevent synthetic turn-start passive subagent_done from rewinding before hook tool calls
      const laterEpoch = Math.max(pDone.epoch, hDone.epoch);
      const laterTs = laterEpoch === hDone.epoch ? hDone.ts : pDone.ts;
      pDone.epoch = laterEpoch;
      pDone.ts = laterTs;
      hDone.epoch = laterEpoch;
      hDone.ts = laterTs;

      const doneCallId =
        pDone.toolCallId ||
        hDone.toolCallId ||
        p.spawnEv?.toolCallId ||
        `reconcile-done-${h.hId}`;
      pDone.toolCallId = doneCallId;
      pDone.mergeKey = computeMergeKey({
        sessionId: pDone.sessionId,
        agentId: pDone.agentId,
        kind: pDone.kind,
        toolCallId: doneCallId,
        toolName: pDone.toolName,
        epoch: pDone.epoch,
      });
      hDone.toolCallId = doneCallId;
      hDone.toolName = hDone.toolName || pDone.toolName;
      hDone.mergeKey = pDone.mergeKey;
    } else if (pDone && !hDone) {
      const maxHookEp = maxHookEpochByHId.get(h.hId);
      if (maxHookEp !== undefined && pDone.epoch <= maxHookEp) {
        pDone.epoch = maxHookEp + 0.001;
        pDone.ts = toIsoUtc(pDone.epoch);
        pDone.mergeKey = computeMergeKey({
          sessionId: pDone.sessionId,
          agentId: pDone.agentId,
          kind: pDone.kind,
          toolCallId: pDone.toolCallId,
          toolName: pDone.toolName,
          epoch: pDone.epoch,
        });
      }
    }
  }

  for (const { secondary, primary, hId } of secondaryPassiveLinks) {
    if (secondary.spawnEv && primary.spawnEv) {
      secondary.spawnEv.toolCallId = primary.spawnEv.toolCallId;
      secondary.spawnEv.mergeKey = primary.spawnEv.mergeKey;
    }
    const pDones = passiveDoneByHId.get(hId) ?? [];
    if (pDones.length > 1) {
      const canonicalDone = pDones[0]!;
      for (let i = 1; i < pDones.length; i++) {
        const extraDone = pDones[i]!;
        const laterEp = Math.max(canonicalDone.epoch, extraDone.epoch);
        const laterTs = laterEp === extraDone.epoch ? extraDone.ts : canonicalDone.ts;
        canonicalDone.epoch = laterEp;
        canonicalDone.ts = laterTs;
        extraDone.epoch = laterEp;
        extraDone.ts = laterTs;
        if (canonicalDone.toolCallId) {
          extraDone.toolCallId = canonicalDone.toolCallId;
        }
        if (canonicalDone.mergeKey?.startsWith("t1:")) {
          extraDone.mergeKey = canonicalDone.mergeKey;
        }
      }
    }
  }

  return events;
}

export function buildSessionSnapshot(
  rawEvents: EnrichedEvent[],
  opts: SnapshotBuildOptions,
): RichSessionSnapshot {
  const nowSec = opts.nowEpochSec ?? Date.now() / 1000;
  const reconciled = reconcileCopilotSubagents(rawEvents);
  const deduped = deduplicateEvents(reconciled);

  // Enforce strict monotonic numeric epoch (+0.0001 tie-breaker epsilon)
  let prevEpoch = 0;
  const events: EnrichedEvent[] = deduped.map((ev) => {
    let ep = Number.isFinite(ev.epoch) ? ev.epoch : nowSec;
    if (prevEpoch > 0 && ep <= prevEpoch) {
      ep = prevEpoch + 0.0001;
    }
    prevEpoch = ep;
    return { ...ev, epoch: ep };
  });

  // Cap inline payload.body on older thinking_start events beyond the latest 200
  // while keeping summary, bodyLength, and bodyTruncated for lazy EventBodyStore hydration.
  let thinkingSeen = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind === "thinking_start") {
      thinkingSeen += 1;
      if (
        thinkingSeen > MAX_THINKING_INLINE_EVENTS &&
        ev.payload &&
        "body" in ev.payload
      ) {
        const { body: strippedBody, ...restPayload } = ev.payload;
        if (
          typeof strippedBody === "string" &&
          strippedBody.length > (ev.summary ?? "").length
        ) {
          ev.bodyTruncated = true;
          if (ev.bodyLength === undefined) {
            ev.bodyLength = strippedBody.length;
          }
        }
        ev.payload = restPayload;
      }
    }
  }

  const primaryIde: IdeSource = opts.ide ?? events[0]?.ide ?? "unknown";
  const workspacePath =
    opts.workspacePath ?? events.find((e) => e.workspacePath)?.workspacePath;
  const projectId =
    opts.projectId ?? events.find((e) => e.projectId)?.projectId;

  // Determine root agent ID (prefer explicit "root" before falling back to first unparented agent)
  const rootId =
    events.find((e) => e.agentId === "root" && !e.parentAgentId)?.agentId ??
    events.find(
      (e) =>
        e.agentId &&
        e.agentId !== "human" &&
        !e.agentId.startsWith("ext:") &&
        !e.parentAgentId,
    )?.agentId ??
    "root";

  const agentMap = new Map<string, MutableAgentState>();
  const agentOrder: string[] = [];

  const ensureAgent = (
    id: string,
    extra?: {
      label?: string;
      parentAgentId?: string;
      ide?: IdeSource;
      nodeType?: NodeType;
      role?: string;
      color?: string;
      convId?: string;
      epoch?: number;
    },
  ): MutableAgentState => {
    let st = agentMap.get(id);
    const validExtraLabel =
      extra?.label && !isUuidOrOpaqueId(extra.label) ? extra.label : undefined;
    if (!st) {
      const color =
        extra?.color ?? PALETTE[agentOrder.length % PALETTE.length]!;
      const nodeType: NodeType =
        extra?.nodeType ??
        (id === "human" || id === "ext:human"
          ? "human"
          : id.startsWith("ext:")
            ? "external"
            : "agent");
      const isRoot = nodeType === "agent" && id === rootId;
      st = {
        id,
        label: validExtraLabel || prettifyAgentLabel(id),
        parentAgentId: extra?.parentAgentId,
        ide: extra?.ide ?? primaryIde,
        nodeType,
        isRoot,
        role:
          extra?.role ||
          (nodeType === "human"
            ? "User / Prompt Source"
            : isRoot
              ? "Lead Coordinator"
              : "Specialist Subagent"),
        color,
        action: "Standby",
        steps: 0,
        toolCalls: 0,
        messagesSent: 0,
        messagesReceived: 0,
        lastEventEpoch: extra?.epoch ?? 0,
        firstEventEpoch: extra?.epoch ?? 0,
        openTools: new Map(),
        isThinking: false,
        hasBlocker: false,
        reportedDone: false,
        waitingReason: null,
        waitingDetail: null,
        openPendingPrompt: null,
        recentActions: [],
        convId: extra?.convId,
        modelSource: "unknown",
        usageSource: "estimated",
        hasExplicitUsage: false,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        hasCacheSplit: false,
        hasUnsplitCached: false,
        reasoningTokens: 0,
        hasExactReasoning: false,
        hadIsTotalUsage: false,
        thinkingChars: 0,
        turnEndCount: 0,
        userInputCount: 0,
        events: [],
        contextTokens: 0,
        fallbackChars: 0,
        fallbackInputChars: 0,
        fallbackOutputChars: 0,
        fallbackPriorProseChars: 0,
        fallbackTurnProseChars: 0,
        fallbackTurnTotalChars: 0,
      };
      agentMap.set(id, st);
      agentOrder.push(id);
    } else {
      if (
        validExtraLabel &&
        (st.label === prettifyAgentLabel(id) ||
          st.label === "Subagent" ||
          isUuidOrOpaqueId(st.label))
      ) {
        st.label = validExtraLabel;
      }
      if (extra?.parentAgentId && !st.parentAgentId) {
        st.parentAgentId = extra.parentAgentId;
      }
      if (extra?.convId && !st.convId) {
        st.convId = extra.convId;
      }
    }
    return st;
  };

  ensureAgent("human", {
    label: "Human",
    nodeType: "human",
    role: "User / Prompt Source",
    color: "#f59e0b",
  });
  ensureAgent(rootId, {
    nodeType: "agent",
    role: "Lead Coordinator",
    ide: primaryIde,
  });

  const activity: ActivityItem[] = [];
  const edgeMap = new Map<string, AgentEdgeSnapshot>();
  const edgeCounts: Record<string, number> = {};
  const lastToolSummaryByKey = new Map<string, string>();

  let totalToolCalls = 0;
  let totalMessages = 0;
  let totalBoardMutations = 0;

  const recordEdge = (
    from: string,
    to: string,
    kind: EnrichedEvent["kind"],
    ts: string,
  ): void => {
    if (!from || !to || from === to) return;
    const dirKey = `${from}->${to}`;
    const existing = edgeMap.get(dirKey);
    if (existing) {
      existing.count += 1;
      existing.lastKind = kind;
      existing.lastTs = ts;
    } else {
      edgeMap.set(dirKey, { from, to, count: 1, lastKind: kind, lastTs: ts });
    }
    const pairKey = [from, to].sort().join("|");
    edgeCounts[pairKey] = (edgeCounts[pairKey] ?? 0) + 1;
  };

  const pushRecent = (
    ag: MutableAgentState,
    ts: string,
    tool: string,
    text: string,
  ): void => {
    ag.recentActions.push({ ts, tool, text: text.slice(0, 80) });
    if (ag.recentActions.length > 8) {
      ag.recentActions = ag.recentActions.slice(-8);
    }
  };

  for (const ev of events) {
    const convId =
      typeof ev.payload?.conv === "string" ? ev.payload.conv : undefined;
    const ag = ensureAgent(ev.agentId, {
      label: ev.agentLabel,
      parentAgentId: ev.parentAgentId,
      ide: ev.ide,
      convId,
      epoch: ev.epoch,
    });
    ag.steps += 1;
    ag.events.push(ev);
    if (ev.kind === "thinking_start") {
      ag.thinkingChars += computeEventThinkingChars(ev);
    } else if (ev.kind === "assistant_turn_end") {
      ag.turnEndCount += 1;
    } else if (ev.kind === "user_input") {
      ag.userInputCount += 1;
    }
    if (ag.firstEventEpoch === 0) ag.firstEventEpoch = ev.epoch;
    ag.lastEventEpoch = Math.max(ag.lastEventEpoch, ev.epoch);
    const FALLBACK_EVENT_CAP = 2000;
    const summaryChars = Math.min(FALLBACK_EVENT_CAP, ev.summary.length);
    const bodyChars = Math.min(
      FALLBACK_EVENT_CAP,
      Math.max(
        ev.bodyLength ?? 0,
        payloadTextLen(ev.payload?.body),
        payloadTextLen(ev.payload?.prompt),
      ),
    );
    const toolInChars = Math.min(
      FALLBACK_EVENT_CAP,
      Math.max(
        payloadTextLen(ev.payload?.toolArgs),
        payloadTextLen(ev.payload?.toolInput),
        payloadTextLen(ev.payload?.args),
        payloadTextLen(ev.payload?.input),
      ),
    );
    const toolOutChars = Math.min(
      FALLBACK_EVENT_CAP,
      Math.max(
        payloadTextLen(ev.payload?.toolResult),
        payloadTextLen(ev.payload?.resultDetails),
        payloadTextLen(ev.payload?.preview),
      ),
    );
    const evCharSpan = Math.min(
      FALLBACK_EVENT_CAP,
      Math.max(summaryChars, bodyChars, toolInChars, toolOutChars),
    );
    ag.fallbackChars += evCharSpan;
    if (ev.kind === "user_input") {
      if (ag.fallbackTurnTotalChars > 0) {
        ag.fallbackPriorProseChars += Math.min(4000, ag.fallbackTurnProseChars);
        ag.fallbackTurnProseChars = 0;
        ag.fallbackTurnTotalChars = 0;
      }
      const c = Math.max(summaryChars, bodyChars);
      ag.fallbackInputChars += c;
      ag.fallbackTurnProseChars += c;
      ag.fallbackTurnTotalChars += c;
    } else if (ev.kind === "tool_end") {
      const c = Math.max(summaryChars, toolOutChars, bodyChars);
      ag.fallbackInputChars += c;
      ag.fallbackTurnTotalChars += c;
    } else if (ev.kind === "tool_start" || ev.kind === "board_mutation") {
      const c = Math.max(summaryChars, toolInChars);
      ag.fallbackOutputChars += c;
      ag.fallbackTurnTotalChars += c;
    } else if (
      ev.kind === "subagent_spawn" ||
      ev.kind === "message" ||
      ev.kind === "assistant_turn_end" ||
      ev.kind === "subagent_done" ||
      ev.kind === "thinking_start"
    ) {
      const c = Math.max(summaryChars, bodyChars);
      ag.fallbackOutputChars += c;
      ag.fallbackTurnProseChars += c;
      ag.fallbackTurnTotalChars += c;
    } else {
      ag.fallbackInputChars += summaryChars;
      ag.fallbackTurnProseChars += summaryChars;
      ag.fallbackTurnTotalChars += summaryChars;
    }

    // Fold per-event UsageDelta metadata if present
    const uDelta: UsageDelta | undefined =
      ev.usageDelta ??
      (ev.payload?._usageDelta &&
      typeof ev.payload._usageDelta === "object" &&
      !Array.isArray(ev.payload._usageDelta)
        ? (ev.payload._usageDelta as UsageDelta)
        : undefined);
    if (uDelta) {
      if (uDelta.model && uDelta.model.trim()) {
        const pretty = prettifyModelName(uDelta.model) || uDelta.model.trim();
        const incomingSrc = uDelta.modelSource ?? "exact";
        if (
          !ag.model ||
          incomingSrc === "exact" ||
          ag.modelSource === "unknown"
        ) {
          ag.model = pretty;
          ag.modelSource = incomingSrc;
        }
      }
      if (
        typeof uDelta.inputTokens === "number" ||
        typeof uDelta.outputTokens === "number" ||
        typeof uDelta.cachedTokens === "number" ||
        typeof uDelta.cacheReadTokens === "number" ||
        typeof uDelta.cacheWriteTokens === "number" ||
        typeof uDelta.reasoningTokens === "number"
      ) {
        ag.hasExplicitUsage = true;
        if (uDelta.usageSource === "exact") {
          ag.usageSource = "exact";
        }
        const inTok = Math.max(0, Math.round(uDelta.inputTokens ?? 0));
        const outTok = Math.max(0, Math.round(uDelta.outputTokens ?? 0));
        const hasSplitFields =
          typeof uDelta.cacheReadTokens === "number" ||
          typeof uDelta.cacheWriteTokens === "number";
        const splitRead = hasSplitFields
          ? Math.max(0, Math.round(uDelta.cacheReadTokens ?? 0))
          : 0;
        const splitWrite = hasSplitFields
          ? Math.max(0, Math.round(uDelta.cacheWriteTokens ?? 0))
          : 0;
        const cachedTok =
          typeof uDelta.cachedTokens === "number"
            ? Math.max(0, Math.round(uDelta.cachedTokens))
            : splitRead + splitWrite;
        const hasReason = typeof uDelta.reasoningTokens === "number";
        const reasonTok = hasReason
          ? Math.min(outTok, Math.max(0, Math.round(uDelta.reasoningTokens!)))
          : 0;
        if (uDelta.isTotal) {
          ag.hadIsTotalUsage = true;
          ag.inputTokens = inTok;
          ag.outputTokens = outTok;
          ag.cachedTokens = cachedTok;
          if (hasSplitFields) {
            ag.hasCacheSplit = true;
            ag.hasUnsplitCached = false;
            ag.cacheReadTokens = splitRead;
            ag.cacheWriteTokens = splitWrite;
          } else {
            ag.hasCacheSplit = false;
            ag.hasUnsplitCached = cachedTok > 0;
            ag.cacheReadTokens = 0;
            ag.cacheWriteTokens = 0;
          }
          if (hasReason) {
            ag.hasExactReasoning = true;
            ag.reasoningTokens = reasonTok;
          } else {
            ag.hasExactReasoning = false;
            ag.reasoningTokens = 0;
          }
          ag.contextTokens = Math.max(
            0,
            Math.round(uDelta.contextTokens ?? inTok + outTok),
          );
        } else {
          ag.inputTokens += inTok;
          ag.outputTokens += outTok;
          ag.cachedTokens += cachedTok;
          if (hasSplitFields) {
            ag.hasCacheSplit = true;
            ag.cacheReadTokens += splitRead;
            ag.cacheWriteTokens += splitWrite;
          } else if (cachedTok > 0) {
            ag.hasUnsplitCached = true;
          }
          if (hasReason) {
            ag.hasExactReasoning = true;
            ag.reasoningTokens += reasonTok;
          }
          if (
            typeof uDelta.contextTokens === "number" &&
            Number.isFinite(uDelta.contextTokens) &&
            uDelta.contextTokens > 0
          ) {
            ag.contextTokens = Math.round(uDelta.contextTokens);
          } else if (
            typeof uDelta.inputTokens === "number" &&
            (inTok > 0 || cachedTok > 0)
          ) {
            ag.contextTokens = inTok + cachedTok + outTok;
          }
        }
      }
      if (
        typeof uDelta.contextWindow === "number" &&
        Number.isFinite(uDelta.contextWindow) &&
        uDelta.contextWindow > 0
      ) {
        ag.contextWindow = Math.round(uDelta.contextWindow);
      }
      if (typeof uDelta.costUsd === "number" && Number.isFinite(uDelta.costUsd)) {
        ag.costUsd = uDelta.isTotal
          ? uDelta.costUsd
          : (ag.costUsd ?? 0) + uDelta.costUsd;
      }
    }

    // Apply child model hint attached to subagent_spawn payloads (e.g. spawned child with 0 rows)
    const rawSpawnLabel =
      (typeof ev.payload?.agentLabel === "string" && ev.payload.agentLabel.trim()
        ? ev.payload.agentLabel.trim()
        : undefined) ||
      (typeof ev.payload?.agentType === "string" && ev.payload.agentType.trim()
        ? ev.payload.agentType.trim()
        : undefined);
    const spawnLabelHint =
      rawSpawnLabel && !isUuidOrOpaqueId(rawSpawnLabel)
        ? rawSpawnLabel
        : undefined;
    if (
      ev.kind === "subagent_spawn" &&
      ev.targetAgentId &&
      ((typeof ev.payload?.childModel === "string" &&
        ev.payload.childModel.trim()) ||
        (typeof ev.payload?.childContextWindow === "number" &&
          Number.isFinite(ev.payload.childContextWindow) &&
          ev.payload.childContextWindow > 0))
    ) {
      const childSt = ensureAgent(ev.targetAgentId, {
        label: spawnLabelHint,
        parentAgentId: ag.id,
        ide: ev.ide,
        epoch: ev.epoch,
      });
      if (
        !childSt.model &&
        typeof ev.payload?.childModel === "string" &&
        ev.payload.childModel.trim()
      ) {
        childSt.model =
          prettifyModelName(ev.payload.childModel) || ev.payload.childModel;
        childSt.modelSource =
          ev.payload.childModelSource === "exact" ||
          ev.payload.childModelSource === "inherited"
            ? ev.payload.childModelSource
            : "inherited";
      }
      if (
        !childSt.contextWindow &&
        typeof ev.payload?.childContextWindow === "number" &&
        Number.isFinite(ev.payload.childContextWindow) &&
        ev.payload.childContextWindow > 0
      ) {
        childSt.contextWindow = Math.round(ev.payload.childContextWindow);
      }
    }

    switch (ev.kind) {
      case "session_start": {
        ag.action = "Session started";
        break;
      }

      case "user_input": {
        const isHumanAnswer = ev.payload?.isHumanAnswer === true;
        const isSubagentTarget =
          !ag.isRoot || Boolean(ag.parentAgentId) || Boolean(ev.parentAgentId);

        // Reset reportedDone + waiting/blocker when a turn starts!
        ag.reportedDone = false;
        ag.waitingReason = null;
        ag.waitingDetail = null;
        ag.openPendingPrompt = null;
        ag.hasBlocker = false;
        if (typeof ev.payload?.questionToolCallId === "string") {
          ag.openTools.delete(ev.payload.questionToolCallId);
        }
        ag.isThinking = true;
        ag.thinkingSinceEpoch = ev.epoch;

        if (isSubagentTarget && !isHumanAnswer) {
          const cleanTask =
            cleanHumanSummary(ev.summary.replace(/^Human:\s*/i, ""), 130) ||
            "Starting task…";
          ag.thinkingAction = cleanTask;
          ag.action = cleanTask;
          break;
        }

        const human = ensureAgent("human");
        human.steps += 1;
        human.messagesSent += 1;
        human.lastEventEpoch = Math.max(human.lastEventEpoch, ev.epoch);
        human.action = ev.summary.slice(0, 48);
        pushRecent(human, ev.ts, "USER_INPUT", ev.summary);

        ag.thinkingAction = isHumanAnswer
          ? "Thinking on human answer…"
          : "Thinking on user prompt…";
        ag.messagesReceived += 1;

        recordEdge("human", ag.id, ev.kind, ev.ts);
        activity.push({
          id: ev.id,
          ts: ev.ts,
          epoch: ev.epoch,
          from: "human",
          to: ag.id,
          kind: "human",
          title: ev.summary,
          body: String(ev.payload?.body ?? ev.summary),
          ...(ev.bodyLength !== undefined ? { bodyLength: ev.bodyLength } : {}),
          ...(ev.bodyTruncated !== undefined
            ? { bodyTruncated: ev.bodyTruncated }
            : {}),
          conv: convId,
          ide: ev.ide,
          channel: ev.channel,
        });
        break;
      }

      case "thinking_start": {
        ag.reportedDone = false;
        ag.hasBlocker = false;
        ag.isThinking = true;
        ag.thinkingSinceEpoch = ag.thinkingSinceEpoch ?? ev.epoch;
        ag.thinkingAction = ev.summary || "Thinking…";
        ag.action = ag.thinkingAction;
        break;
      }

      case "tool_start": {
        ag.reportedDone = false;
        ag.isThinking = false;
        ag.thinkingSinceEpoch = undefined;
        ag.toolCalls += 1;
        totalToolCalls += 1;
        ag.action = cleanHumanSummary(
          ev.summary || `Tool: ${ev.toolName ?? "tool"}`,
          140,
        );
        pushRecent(ag, ev.ts, ev.toolName ?? "tool", ag.action);

        if (ev.toolCallId) {
          lastToolSummaryByKey.set(`${ag.id}::${ev.toolCallId}`, ag.action);
        }
        if (ev.toolName) {
          lastToolSummaryByKey.set(`${ag.id}::${ev.toolName}`, ag.action);
        }

        const callKey = ev.toolCallId ?? `${ev.toolName ?? "tool"}:${ev.id}`;
        const toolLabel = ev.toolName?.trim() || "tool";
        if (!ev.isSelfDaemon) {
          ag.openPendingPrompt = null;
        }
        if (ev.status === "denied") {
          ag.hasBlocker = true;
          ag.waitingReason = null;
          ag.waitingDetail = null;
          ag.openPendingPrompt = null;
          ag.action = `Blocked: ${ev.summary}`;
        } else if (ev.waitingReason) {
          ag.waitingReason = ev.waitingReason;
          ag.waitingDetail =
            ev.waitingReason === "user"
              ? "Waiting for user answer"
              : "Waiting for tool approval";
          ag.openPendingPrompt = buildPendingPromptForEvent(ag, ev);
          ag.openTools.set(callKey, toolLabel);
        } else if (!ev.isSelfDaemon) {
          ag.hasBlocker = false;
          ag.waitingReason = null;
          ag.waitingDetail = null;
          ag.openTools.set(callKey, toolLabel);
        }

        let targetId = ev.targetAgentId ?? ag.id;
        if (ev.toolName) {
          const ext = classifyExternalTool(
            ev.toolName,
            (ev.payload?.args as Record<string, unknown> | undefined) ??
              (ev.payload?.input as Record<string, unknown> | undefined),
          );
          if (ext) {
            const extNode = ensureAgent(ext.id, {
              label: ext.label,
              nodeType: ext.nodeType,
              role: ext.role,
              color: ext.color,
              epoch: ev.epoch,
            });
            extNode.steps += 1;
            extNode.toolCalls += 1;
            extNode.messagesReceived += 1;
            extNode.lastEventEpoch = Math.max(extNode.lastEventEpoch, ev.epoch);
            extNode.action = ag.action;
            pushRecent(extNode, ev.ts, ev.toolName, `${ag.id}: ${ag.action}`);
            targetId = ext.id;
          }
        }

        if (targetId !== ag.id) {
          recordEdge(ag.id, targetId, ev.kind, ev.ts);
        }

        activity.push({
          id: ev.id,
          ts: ev.ts,
          epoch: ev.epoch,
          from: ag.id,
          to: targetId,
          kind: ev.status === "denied" ? "blocker" : "tool",
          title: ag.action,
          body: JSON.stringify(ev.payload ?? { summary: ev.summary }, null, 2),
          conv: convId,
          ide: ev.ide,
          toolName: ev.toolName,
          channel: ev.channel,
        });
        break;
      }

      case "tool_end": {
        const prevStartSummary =
          (ev.toolCallId
            ? lastToolSummaryByKey.get(`${ag.id}::${ev.toolCallId}`)
            : undefined) ??
          (ev.toolName
            ? lastToolSummaryByKey.get(`${ag.id}::${ev.toolName}`)
            : undefined);

        const isErr = Boolean(
          ev.isError || ev.status === "error" || ev.status === "denied",
        );

        if (
          prevStartSummary &&
          (!ev.summary ||
            /^(Done:|PostToolUse:|Tool completed|Tool failed)/i.test(
              ev.summary,
            ))
        ) {
          ev.summary = cleanHumanSummary(
            isErr
              ? `Failed: ${prevStartSummary}`
              : `Completed: ${prevStartSummary}`,
            140,
          );
        }

        if (!isErr) {
          ev.payload = { ...(ev.payload ?? {}), routineEnd: true };
        }

        if (ev.toolCallId && ag.openTools.has(ev.toolCallId)) {
          ag.openTools.delete(ev.toolCallId);
        } else if (ag.openTools.size > 0) {
          let deleted = false;
          const endToolName = ev.toolName?.trim();
          if (endToolName) {
            for (const [k, v] of ag.openTools.entries()) {
              if (v === endToolName) {
                ag.openTools.delete(k);
                deleted = true;
                break;
              }
            }
          }
          if (!deleted) {
            const firstKey = ag.openTools.keys().next().value;
            if (firstKey !== undefined) ag.openTools.delete(firstKey);
          }
        }

        const promptMatches =
          !ag.openPendingPrompt || doesToolEndMatchPrompt(ag.openPendingPrompt, ev);
        if (promptMatches) {
          ag.openPendingPrompt = null;
          if (ag.waitingReason === "user" || ag.waitingReason === "tool_approval") {
            ag.waitingReason = null;
            ag.waitingDetail = null;
          }
        }

        if (isErr) {
          ag.hasBlocker = true;
          ag.isThinking = false;
          ag.action = cleanHumanSummary(ev.summary || "Tool error", 140);
          activity.push({
            id: ev.id,
            ts: ev.ts,
            epoch: ev.epoch,
            from: ag.id,
            to: ag.id,
            kind: "blocker",
            title: ag.action,
            body: JSON.stringify(ev.payload ?? { summary: ev.summary }, null, 2),
            conv: convId,
            ide: ev.ide,
            toolName: ev.toolName,
            channel: ev.channel,
          });
        } else {
          ag.hasBlocker = false;
          if (ag.openTools.size === 0 && !ag.reportedDone) {
            ag.isThinking = true;
            ag.thinkingSinceEpoch = ev.epoch;
            ag.thinkingAction = "Thinking on tool output…";
          }
        }
        break;
      }

      case "subagent_spawn": {
        ag.reportedDone = false;
        ag.toolCalls += 1;
        totalToolCalls += 1;
        totalMessages += 1;
        const targetId = ev.targetAgentId || "subagent";
        const child = ensureAgent(targetId, {
          label: spawnLabelHint,
          parentAgentId: ag.id,
          ide: ev.ide,
          epoch: ev.epoch,
        });
        child.steps += 1;
        if (child.firstEventEpoch === 0) child.firstEventEpoch = ev.epoch;
        child.lastEventEpoch = Math.max(child.lastEventEpoch, ev.epoch);
        child.reportedDone = false;
        child.messagesReceived += 1;
        child.isThinking = true;
        child.thinkingSinceEpoch = ev.epoch;
        child.action = "Spawned";
        ag.messagesSent += 1;
        ag.action = ev.summary;
        pushRecent(ag, ev.ts, ev.toolName ?? "spawn", ev.summary);

        recordEdge(ag.id, child.id, ev.kind, ev.ts);
        activity.push({
          id: ev.id,
          ts: ev.ts,
          epoch: ev.epoch,
          from: ag.id,
          to: child.id,
          kind: "dispatch",
          title: ev.summary,
          body: String(ev.payload?.prompt ?? ev.summary),
          ...(ev.bodyLength !== undefined ? { bodyLength: ev.bodyLength } : {}),
          ...(ev.bodyTruncated !== undefined
            ? { bodyTruncated: ev.bodyTruncated }
            : {}),
          conv: convId,
          ide: ev.ide,
          toolName: ev.toolName,
          channel: ev.channel,
        });
        break;
      }

      case "subagent_done": {
        // Never mark root as reportedDone when targetAgentId is absent
        if (!ev.targetAgentId && (ag.id === "root" || ag.id === rootId)) {
          break;
        }
        // Could be emitted either by the child itself or by the parent receiving tool_result for targetAgentId
        const doneId =
          ev.targetAgentId && ev.targetAgentId !== ag.id
            ? ev.targetAgentId
            : ag.id;
        const doneAgent = ensureAgent(doneId, { ide: ev.ide, epoch: ev.epoch });
        if (ev.toolCallId) {
          if (ag.id !== doneAgent.id) {
            ag.openTools.delete(ev.toolCallId);
          }
          const parentId = doneAgent.parentAgentId || ev.parentAgentId || rootId;
          if (parentId && parentId !== doneAgent.id) {
            agentMap.get(parentId)?.openTools.delete(ev.toolCallId);
          }
        }
        doneAgent.openTools.clear();
        doneAgent.isThinking = false;
        doneAgent.thinkingSinceEpoch = undefined;
        doneAgent.waitingReason = null;
        doneAgent.waitingDetail = null;
        doneAgent.openPendingPrompt = null;
        doneAgent.reportedDone = true;
        doneAgent.lastEventEpoch = Math.max(doneAgent.lastEventEpoch, ev.epoch);
        doneAgent.action = cleanHumanSummary(ev.summary || "Completed", 140);
        if (ev.payload?.canceled === true) {
          doneAgent.hasBlocker = false;
        } else if (ev.isError) {
          doneAgent.hasBlocker = true;
        }
        break;
      }

      case "message": {
        totalMessages += 1;
        ag.messagesSent += 1;
        const targetId = ev.targetAgentId || rootId;
        const body = String(ev.payload?.body ?? ev.summary);
        const msgClass =
          targetId === "human"
            ? "human"
            : classifyMessage(ag.id, targetId, body, rootId);
        const cleanTitle = cleanHumanSummary(ev.summary, 140) || "Message";
        ev.summary = cleanTitle;

        if (targetId !== ag.id) {
          const target = ensureAgent(targetId, {
            ide: ev.ide,
            epoch: ev.epoch,
          });
          target.messagesReceived += 1;
          target.lastEventEpoch = Math.max(target.lastEventEpoch, ev.epoch);
          if (target.nodeType === "agent") {
            // Incoming message wakes recipient -> reset reportedDone
            target.reportedDone = false;
          }
          recordEdge(ag.id, targetId, ev.kind, ev.ts);
        }

        if (ev.waitingReason === "user" || ev.waitingReason === "tool_approval") {
          ag.waitingReason = ev.waitingReason;
          ag.waitingDetail =
            ev.waitingReason === "user"
              ? "Waiting for user answer"
              : "Waiting for tool approval";
          ag.openPendingPrompt = buildPendingPromptForEvent(ag, ev);
        }

        if (msgClass === "blocker") {
          ag.hasBlocker = true;
          ag.action = cleanHumanSummary(`Blocker: ${cleanTitle}`, 100);
        } else if (msgClass === "complete" && !ag.isRoot) {
          ag.reportedDone = true;
          ag.isThinking = false;
          ag.action = cleanHumanSummary(`Completed: ${cleanTitle}`, 100);
        } else {
          ag.action = cleanHumanSummary(`To ${targetId}: ${cleanTitle}`, 100);
        }
        pushRecent(ag, ev.ts, "message", cleanTitle);

        activity.push({
          id: ev.id,
          ts: ev.ts,
          epoch: ev.epoch,
          from: ag.id,
          to: targetId,
          kind: msgClass,
          title: cleanTitle,
          body,
          ...(ev.bodyLength !== undefined ? { bodyLength: ev.bodyLength } : {}),
          ...(ev.bodyTruncated !== undefined
            ? { bodyTruncated: ev.bodyTruncated }
            : {}),
          conv: convId,
          ide: ev.ide,
          toolName: ev.toolName,
          channel: ev.channel,
        });
        break;
      }

      case "board_mutation": {
        totalBoardMutations += 1;
        ag.toolCalls += 1;
        totalToolCalls += 1;
        ag.openPendingPrompt = null;
        if (ev.waitingReason === "user" || ev.waitingReason === "tool_approval") {
          ag.waitingReason = ev.waitingReason;
          ag.waitingDetail =
            ev.waitingReason === "user"
              ? "Waiting for user answer"
              : "Waiting for tool approval";
          ag.openPendingPrompt = buildPendingPromptForEvent(ag, ev);
        } else if (!ev.isSelfDaemon) {
          ag.waitingReason = null;
          ag.waitingDetail = null;
        }
        const cleanBoardTitle = cleanHumanSummary(ev.summary, 140);
        ev.summary = cleanBoardTitle;
        ag.action = cleanBoardTitle;
        pushRecent(ag, ev.ts, ev.toolName ?? "board", cleanBoardTitle);

        if (ev.toolCallId) {
          lastToolSummaryByKey.set(`${ag.id}::${ev.toolCallId}`, cleanBoardTitle);
        }
        if (ev.toolName) {
          lastToolSummaryByKey.set(`${ag.id}::${ev.toolName}`, cleanBoardTitle);
        }

        const boardNode = ensureAgent("ext:board", {
          label: "Agile Board MCP",
          nodeType: "external",
          role: "Agile Board & QA Gate",
          color: "#38bdf8",
          epoch: ev.epoch,
        });
        boardNode.steps += 1;
        boardNode.toolCalls += 1;
        boardNode.messagesReceived += 1;
        boardNode.lastEventEpoch = Math.max(boardNode.lastEventEpoch, ev.epoch);
        boardNode.action = ev.summary;
        recordEdge(ag.id, "ext:board", ev.kind, ev.ts);

        activity.push({
          id: ev.id,
          ts: ev.ts,
          epoch: ev.epoch,
          from: ag.id,
          to: "ext:board",
          kind: "board",
          title: ev.summary,
          body: JSON.stringify(ev.payload ?? {}, null, 2),
          conv: convId,
          ide: ev.ide,
          toolName: ev.toolName ?? "board",
          channel: ev.channel,
        });
        break;
      }

      case "assistant_turn_end": {
        ag.openTools.clear();
        ag.isThinking = false;
        ag.thinkingSinceEpoch = undefined;
        ag.waitingReason = null;
        ag.waitingDetail = null;
        ag.openPendingPrompt = null;
        ag.reportedDone = true;
        ag.action = ev.summary || "Turn completed";
        if (ev.isError || ev.status === "error") {
          ag.hasBlocker = true;
        }
        break;
      }

      default: {
        if (ev.waitingReason === "user" || ev.waitingReason === "tool_approval") {
          ag.waitingReason = ev.waitingReason;
          ag.waitingDetail =
            ev.waitingReason === "user"
              ? "Waiting for user answer"
              : "Waiting for tool approval";
          ag.openPendingPrompt = buildPendingPromptForEvent(ag, ev);
        }
        break;
      }
    }
  }

  // Finalize per-agent 6-state computation
  const richAgents: RichAgentNode[] = [];
  let activeAgentCount = 0;
  let completedAgentCount = 0;

  // First compute statuses for non-root agents so coordinator can detect waiting on active children
  const computedStatus = new Map<string, AgentStatus>();

  const computeStatusFor = (ag: MutableAgentState): AgentStatus => {
    const age =
      ag.lastEventEpoch > 0 ? Math.max(0, nowSec - ag.lastEventEpoch) : null;

    if (ag.nodeType === "human") {
      return ag.messagesSent > 0 || ag.messagesReceived > 0 ? "WAITING" : "IDLE";
    }
    if (ag.nodeType === "external") {
      if (age !== null && age < EXTERNAL_ACTIVE_SEC) return "WORKING";
      return ag.toolCalls > 0 ? "WAITING" : "IDLE";
    }

    if (ag.steps === 0) return "IDLE";
    if (ag.hasBlocker) return "BLOCKED";
    if (ag.waitingReason) return "WAITING";

    if (ag.openTools.size > 0) {
      if (age !== null && age > ACTIVE_DECAY_SEC) return "IDLE";
      return "WORKING";
    }

    if (ag.isThinking) {
      if (age !== null && age > STALE_SESSION_SEC) return "DONE";
      if (age !== null && age > ACTIVE_DECAY_SEC) return "IDLE";
      return "THINKING";
    }

    if (ag.reportedDone) {
      return "DONE";
    }

    if (age !== null && age < WORKING_FRESH_SEC) {
      return "WORKING";
    }

    if (age !== null && age > STALE_SESSION_SEC) {
      return "IDLE";
    }

    return "WAITING";
  };

  for (const id of agentOrder) {
    const ag = agentMap.get(id)!;
    computedStatus.set(id, computeStatusFor(ag));
  }

  // Check if root coordinator is waiting on any active child subagent
  let sessionWaitingOn: string | null = null;
  for (const id of agentOrder) {
    const ag = agentMap.get(id)!;
    if (ag.nodeType !== "agent") continue;
    const st = computedStatus.get(id)!;
    if (st === "WAITING" && ag.waitingReason) {
      sessionWaitingOn = ag.waitingReason;
      break;
    }
  }

  const rootAgent = agentMap.get(rootId);
  if (rootAgent && !sessionWaitingOn) {
    const activeChild = agentOrder
      .map((id) => agentMap.get(id)!)
      .find(
        (ag) =>
          ag.nodeType === "agent" &&
          !ag.isRoot &&
          ["THINKING", "WORKING"].includes(computedStatus.get(ag.id) ?? "IDLE"),
      );
    if (activeChild && computedStatus.get(rootId) === "WAITING") {
      sessionWaitingOn = `subagent:${activeChild.id}`;
      rootAgent.action = `Waiting on ${activeChild.label}…`;
    }
  }

  // Build lookup map of definition models for fallback model resolution
  const defModelById = new Map<string, string>();
  for (const def of opts.definitions ?? []) {
    if (def.model && def.model.trim()) {
      const pretty = prettifyModelName(def.model) || def.model.trim();
      if (pretty) {
        defModelById.set(def.id.toLowerCase(), pretty);
      }
    }
  }

  // Resolve root model first so subagents without explicit model can inherit it
  const rootAgForModel = agentMap.get(rootId);
  if (rootAgForModel && !rootAgForModel.model) {
    const defModel =
      defModelById.get(rootId.toLowerCase()) ??
      (rootId === "root" ? defModelById.get("orchestrator") : undefined);
    if (defModel) {
      rootAgForModel.model = defModel;
      rootAgForModel.modelSource = "definition";
    }
  }
  const resolvedRootModel = rootAgForModel?.model;

  let sessionTotalTokens = 0;
  let sessionInputTokens = 0;
  let sessionOutputTokens = 0;
  let sessionCachedTokens = 0;
  let peakContextPercent = 0;
  let peakContextTokens = 0;
  let peakContextAgentId: string | null = null;
  let exactUsageAgents = 0;
  let estimatedUsageAgents = 0;
  const breakdownInputs: AgentBreakdownInput[] = [];

  for (const id of agentOrder) {
    const ag = agentMap.get(id)!;
    const status = computedStatus.get(id)!;
    const ageSec =
      ag.lastEventEpoch > 0
        ? Math.max(0, Math.round(nowSec - ag.lastEventEpoch))
        : null;

    let agentUsage: AgentUsageMetrics | undefined;
    let agentModel: string | undefined;

    if (ag.nodeType === "agent") {
      if (["THINKING", "WORKING", "WAITING", "BLOCKED"].includes(status)) {
        activeAgentCount += 1;
      } else if (status === "DONE") {
        completedAgentCount += 1;
      }

      // Resolve model fallback chain: runtime exact/inherited -> definition -> root inherit -> "Unknown"
      let finalModel = ag.model;
      let finalModelSource: ModelSource = ag.modelSource;
      if (!finalModel) {
        const baseSlug = ag.id.replace(/-\d+$/, "").toLowerCase();
        const defMatch =
          defModelById.get(ag.id.toLowerCase()) ?? defModelById.get(baseSlug);
        if (defMatch) {
          finalModel = defMatch;
          finalModelSource = "definition";
        } else if (
          !ag.isRoot &&
          (ag.ide === "antigravity" ||
            ag.ide === "copilot-vscode" ||
            ag.ide === "claude-code") &&
          resolvedRootModel
        ) {
          finalModel = resolvedRootModel;
          finalModelSource = "inherited";
        } else {
          finalModel = "Unknown";
          finalModelSource = "unknown";
        }
      }
      agentModel = finalModel;

      let inputTokens = 0;
      let outputTokens = 0;
      if (ag.hasExplicitUsage) {
        inputTokens = ag.inputTokens;
        outputTokens = ag.outputTokens;
      } else {
        const rawIn = Math.round(ag.fallbackInputChars / 4);
        const rawOut = Math.round(ag.fallbackOutputChars / 4);
        if (rawIn > 0 && rawOut === 0) {
          inputTokens = rawIn >= 2 ? Math.round(rawIn * 0.7) : rawIn;
          outputTokens = Math.max(1, rawIn - inputTokens);
        } else if (rawOut > 0 && rawIn === 0) {
          outputTokens = rawOut >= 2 ? Math.max(1, Math.round(rawOut * 0.4)) : rawOut;
          inputTokens = Math.max(1, rawOut - outputTokens);
        } else {
          inputTokens = rawIn;
          outputTokens = rawOut;
        }
      }
      const cachedTokens = ag.hasExplicitUsage ? ag.cachedTokens : 0;
      const totalTokens = inputTokens + outputTokens + cachedTokens;
      const rootAg = agentMap.get("root");
      const inheritedRootWindow =
        !ag.isRoot &&
        ag.ide === "copilot-vscode" &&
        resolvedRootModel &&
        finalModel === resolvedRootModel
          ? rootAg?.contextWindow
          : undefined;
      const contextWindow =
        ag.contextWindow ??
        inheritedRootWindow ??
        lookupModelContextWindow(finalModel, opts.modelContextWindows) ??
        inferContextWindow(finalModel, ag.ide);
      const inferredNominal = inferContextWindow(finalModel, ag.ide);
      const nominalContextWindow =
        inferredNominal > contextWindow ? inferredNominal : undefined;
      const estTurnContext = Math.round(
        (ag.fallbackPriorProseChars + ag.fallbackTurnTotalChars) / 4,
      );
      const contextTokens = ag.hasExplicitUsage
        ? ag.contextTokens
        : ag.fallbackPriorProseChars === 0 && inputTokens + outputTokens > 0 && estTurnContext === 0
          ? 1
          : estTurnContext;
      const rawPct = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
      const rounded1 = Math.round(rawPct * 10) / 10;
      const contextPercent =
        contextTokens > 0 && contextWindow > 0
          ? Math.min(
              100,
              rounded1 > 0
                ? rounded1
                : Math.max(0.01, Math.round(rawPct * 100) / 100),
            )
          : 0;
      const usageSource: UsageSource = ag.hasExplicitUsage
        ? ag.usageSource
        : "estimated";

      agentUsage = {
        model: finalModel,
        modelSource: finalModelSource,
        usageSource,
        inputTokens,
        outputTokens,
        cachedTokens,
        totalTokens,
        contextTokens,
        contextWindow,
        ...(nominalContextWindow !== undefined ? { nominalContextWindow } : {}),
        contextPercent,
        ...(ag.costUsd !== undefined ? { costUsd: ag.costUsd } : {}),
      };

      sessionTotalTokens += totalTokens;
      sessionInputTokens += inputTokens;
      sessionOutputTokens += outputTokens;
      sessionCachedTokens += cachedTokens;
      if (usageSource === "exact") {
        exactUsageAgents += 1;
      } else {
        estimatedUsageAgents += 1;
      }
      if (
        contextTokens > 0 &&
        (contextPercent > peakContextPercent ||
          (contextPercent === peakContextPercent &&
            contextTokens > peakContextTokens) ||
          peakContextAgentId === null)
      ) {
        peakContextPercent = contextPercent;
        peakContextTokens = contextTokens;
        peakContextAgentId = ag.id;
      }

      const turns =
        ag.turnEndCount > 0 || ag.userInputCount > 0
          ? Math.max(ag.turnEndCount, ag.userInputCount)
          : ag.steps > 0 || totalTokens > 0
            ? 1
            : 0;

      breakdownInputs.push({
        agentId: ag.id,
        label: ag.label,
        role: ag.role,
        ide: ag.ide,
        isRoot: ag.isRoot,
        model: finalModel,
        usageSource,
        inputTokens,
        outputTokens,
        cachedTokens,
        ...(ag.hasCacheSplit && !ag.hasUnsplitCached
          ? {
              cacheReadTokens: ag.cacheReadTokens,
              cacheWriteTokens: ag.cacheWriteTokens,
              hasCacheSplit: true,
            }
          : { hasCacheSplit: false }),
        ...(ag.hasExactReasoning
          ? { reasoningTokens: ag.reasoningTokens, hasExactReasoning: true }
          : { hasExactReasoning: false }),
        hadIsTotalUsage: ag.hadIsTotalUsage,
        contextPercent,
        ...(ag.costUsd !== undefined ? { costUsd: ag.costUsd } : {}),
        toolCalls: ag.toolCalls,
        turns,
        thinkingChars: ag.thinkingChars,
        events: ag.events,
      });
    }

    richAgents.push({
      id: ag.id,
      label: ag.label,
      parentAgentId: ag.parentAgentId,
      ide: ag.ide,
      status,
      state: toLegacyState(status),
      nodeType: ag.nodeType,
      isRoot: ag.isRoot,
      role: ag.role,
      color: ag.color,
      action:
        status === "THINKING" && ag.thinkingAction
          ? ag.thinkingAction
          : ag.waitingDetail && status === "WAITING"
            ? ag.waitingDetail
            : ag.action,
      activeTool:
        ag.openTools.size > 0
          ? ag.openTools.values().next().value
          : undefined,
      thinkingSince: ag.thinkingSinceEpoch
        ? toIsoUtc(ag.thinkingSinceEpoch)
        : undefined,
      lastEventAt:
        ag.lastEventEpoch > 0 ? toIsoUtc(ag.lastEventEpoch) : undefined,
      toolCalls: ag.toolCalls,
      messagesSent: ag.messagesSent,
      messagesReceived: ag.messagesReceived,
      summary: ag.action,
      steps: ag.steps,
      ageSec,
      convId: ag.convId,
      recentActions: ag.recentActions,
      pendingPrompt: ag.openPendingPrompt,
      ...(agentModel ? { model: agentModel } : {}),
      ...(agentUsage ? { usage: agentUsage } : {}),
    });
  }

  const sessionUsageSource: SessionUsageSource =
    exactUsageAgents > 0 && estimatedUsageAgents > 0
      ? "mixed"
      : exactUsageAgents > 0
        ? "exact"
        : "estimated";

  const breakdownResult = computeSessionBreakdown({
    agents: breakdownInputs,
    events,
    modelCatalog: opts.modelCatalog,
  });

  for (const agentNode of richAgents) {
    if (!agentNode.usage) continue;
    const extras = breakdownResult.agentExtras.get(agentNode.id);
    if (!extras) continue;
    Object.assign(agentNode.usage, {
      ...(extras.cacheReadTokens !== undefined
        ? { cacheReadTokens: extras.cacheReadTokens }
        : {}),
      ...(extras.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: extras.cacheWriteTokens }
        : {}),
      reasoningTokens: extras.reasoningTokens,
      reasoningSource: extras.reasoningSource,
      tier: extras.tier,
      costUsd: extras.costUsd,
      credits: extras.credits,
      creditSource: extras.creditSource,
      ...(extras.premiumMultiplier !== undefined
        ? { premiumMultiplier: extras.premiumMultiplier }
        : {}),
      ...(extras.premiumRequests !== undefined
        ? { premiumRequests: extras.premiumRequests }
        : {}),
      turns: extras.turns,
      dominantCategory: extras.dominantCategory,
    });
  }

  const sessionUsage: SessionUsageSummary = {
    totalTokens: sessionTotalTokens,
    inputTokens: sessionInputTokens,
    outputTokens: sessionOutputTokens,
    cachedTokens: sessionCachedTokens,
    cacheReadTokens: breakdownResult.sessionCacheReadTokens,
    cacheWriteTokens: breakdownResult.sessionCacheWriteTokens,
    reasoningTokens: breakdownResult.sessionReasoningTokens,
    peakContextPercent,
    peakContextAgentId,
    usageSource: sessionUsageSource,
    costUsd: breakdownResult.sessionCostUsd,
    credits: breakdownResult.sessionCredits,
    creditSource: breakdownResult.sessionCreditSource,
    ...(breakdownResult.sessionPremiumRequests !== undefined
      ? { premiumRequests: breakdownResult.sessionPremiumRequests }
      : {}),
    models: breakdownResult.breakdown.byModel,
    breakdown: breakdownResult.breakdown,
  };

  // Overall session status
  const agentOnlyStatuses = richAgents
    .filter((a) => a.nodeType === "agent")
    .map((a) => a.status);

  let sessionStatus: AgentStatus = "IDLE";
  if (agentOnlyStatuses.includes("BLOCKED")) {
    sessionStatus = "BLOCKED";
  } else if (agentOnlyStatuses.includes("WORKING")) {
    sessionStatus = "WORKING";
  } else if (agentOnlyStatuses.includes("THINKING")) {
    sessionStatus = "THINKING";
  } else if (agentOnlyStatuses.includes("WAITING")) {
    sessionStatus = "WAITING";
  } else if (
    agentOnlyStatuses.length > 0 &&
    agentOnlyStatuses.every((s) => s === "DONE")
  ) {
    sessionStatus = "DONE";
  }

  const realAgentCount = richAgents.filter((a) => a.nodeType === "agent").length;
  const updatedAt =
    events.length > 0 ? events[events.length - 1]!.ts : toIsoUtc(nowSec);
  const pendingPrompts: PendingHumanPrompt[] = richAgents
    .filter((a) => a.nodeType === "agent" && a.pendingPrompt != null)
    .map((a) => a.pendingPrompt!);

  return {
    sessionId: opts.sessionId,
    session_id: opts.sessionId,
    ide: primaryIde,
    projectId,
    workspacePath,
    updatedAt,
    server_time: formatHms(nowSec),
    status: sessionStatus,
    waitingOn: sessionWaitingOn,
    waiting_on: sessionWaitingOn,
    is_waiting: sessionStatus === "WAITING" || Boolean(sessionWaitingOn),
    is_completed: sessionStatus === "DONE",
    is_multi_agent: realAgentCount > 1,
    agents: richAgents,
    edges: [...edgeMap.values()],
    events,
    activity,
    edge_counts: edgeCounts,
    counters: {
      totalEvents: events.length,
      toolCalls: totalToolCalls,
      messages: totalMessages,
      boardMutations: totalBoardMutations,
      activeAgents: activeAgentCount,
      completedAgents: completedAgentCount,
    },
    usage: sessionUsage,
    pendingPrompts,
    ...(opts.modelContextWindows &&
    Object.keys(opts.modelContextWindows).length > 0
      ? { modelContextWindows: opts.modelContextWindows }
      : {}),
  };
}
