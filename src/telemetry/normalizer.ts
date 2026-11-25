import type {
  AgentEdgeSnapshot,
  AgentStatus,
  AgentUsageMetrics,
  IdeSource,
  ModelSource,
  ModelUsageBucket,
  SessionUsageSource,
  SessionUsageSummary,
  UsageSource,
} from "../schema/telemetry.js";
import {
  PALETTE,
  classifyExternalTool,
  classifyMessage,
  cleanHumanSummary,
  computeMergeKey,
  inferContextWindow,
  prettifyAgentLabel,
  prettifyModelName,
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

    if (matchIdx === undefined) {
      const t2 = parseTier2Key(mergeKey);
      if (t2) {
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
      if (mergeKey.startsWith("t2:")) tier2Index.set(mergeKey, matchIdx);
    } else {
      const idx = result.length;
      result.push({ ...ev, mergeKey });
      idIndex.set(ev.id, idx);
      if (mergeKey.startsWith("t1:")) tier1Index.set(mergeKey, idx);
      if (mergeKey.startsWith("t2:")) tier2Index.set(mergeKey, idx);
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
  contextTokens: number;
  costUsd?: number;
  fallbackChars: number;
  fallbackInputChars: number;
  fallbackOutputChars: number;
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

function normalizeSubagentLabel(raw?: string): string {
  if (!raw) return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function strVal(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function isUuidOrOpaqueId(raw?: string): boolean {
  const s = (raw ?? "").trim();
  if (!s) return true;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[0-9a-f]{12,}$/i.test(s)) return true;
  if (/^(?:agent-)?[0-9a-f]{8,}$/i.test(s)) return true;
  return false;
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
    spawnEv: EnrichedEvent;
    epoch: number;
    normLabel: string;
    readableLabel: string;
    passiveSource?: string;
    isGeneric: boolean;
  }
  interface HookSubCand {
    hId: string;
    spawnEv?: EnrichedEvent;
    epoch: number;
    normLabel: string;
    readableLabel?: string;
    isGeneric: boolean;
  }

  const passiveByPId = new Map<string, PassiveSubCand>();
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
      const readable =
        strVal(ev.payload?.agentLabel) ||
        strVal(ev.payload?.agentType) ||
        pId;
      const labelCandidate =
        strVal(ev.payload?.agentLabel) ||
        strVal(ev.payload?.agentType) ||
        pId.replace(/-\d+$/, "");
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

    if (ev.channel === "hook") {
      const registerHookCand = (
        hId: string,
        readable: string | undefined,
        spawnEv?: EnrichedEvent,
      ): void => {
        const normLabel = normalizeSubagentLabel(readable || hId);
        const isGen =
          !readable ||
          !normLabel ||
          normLabel === "subagent" ||
          isUuidOrOpaqueId(readable);
        const prev = hookByHId.get(hId);
        if (!prev) {
          hookByHId.set(hId, {
            hId,
            ...(spawnEv ? { spawnEv } : {}),
            epoch: ev.epoch,
            normLabel,
            readableLabel: readable,
            isGeneric: isGen,
          });
        } else {
          if (spawnEv && (!prev.spawnEv || ev.epoch < prev.spawnEv.epoch)) {
            prev.spawnEv = spawnEv;
          }
          prev.epoch = Math.min(prev.epoch, ev.epoch);
          if (!prev.readableLabel && readable) {
            prev.readableLabel = readable;
            prev.normLabel = normalizeSubagentLabel(readable);
            prev.isGeneric =
              !prev.normLabel ||
              prev.normLabel === "subagent" ||
              isUuidOrOpaqueId(readable);
          }
        }
      };

      if (
        ev.kind === "subagent_spawn" &&
        ev.targetAgentId &&
        ev.targetAgentId !== "root"
      ) {
        const readable =
          strVal(ev.payload?.agentLabel) || strVal(ev.payload?.agentType);
        registerHookCand(ev.targetAgentId, readable, ev);
      } else if (
        ev.agentId &&
        ev.agentId !== "root" &&
        ev.agentId !== "human" &&
        !ev.agentId.startsWith("ext:")
      ) {
        const readable =
          strVal(ev.agentLabel) ||
          strVal(ev.payload?.agentLabel) ||
          strVal(ev.payload?.agentType);
        registerHookCand(ev.agentId, readable);
      } else if (
        ev.kind === "subagent_done" &&
        ev.targetAgentId &&
        ev.targetAgentId !== "root"
      ) {
        const readable =
          strVal(ev.payload?.agentLabel) || strVal(ev.payload?.agentType);
        registerHookCand(ev.targetAgentId, readable);
      }
    }
  }

  if (passiveByPId.size === 0 || hookByHId.size === 0) {
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

  // 3. Generic/UUID-only pairs: unambiguous within <= 5s (or <= 15s if unambiguous in 15s)
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
      if (closeH.length === 1 && closeP.length === 1) {
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

  if (matches.length === 0) {
    return events;
  }

  const pToH = new Map<string, { hId: string; readableLabel?: string }>();
  const hReadableById = new Map<string, string>();
  const matchedHSet = new Set<string>();
  const mergedSourcesByHId = new Map<string, Set<string>>();
  for (const { p, h } of matches) {
    const readableLabel =
      (p.readableLabel && p.readableLabel !== "Subagent" && !isUuidOrOpaqueId(p.readableLabel)
        ? p.readableLabel
        : undefined) ||
      (h.readableLabel && !isUuidOrOpaqueId(h.readableLabel)
        ? h.readableLabel
        : undefined) ||
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
      if (lbl && (!ev.agentLabel || ev.agentLabel === ev.agentId || isUuidOrOpaqueId(ev.agentLabel))) {
        ev.agentLabel = lbl;
      }
      if (lbl && ev.summary === `Stop (${ev.agentId})`) {
        ev.summary = `Stop (${lbl})`;
      }
    }

    if (
      ev.targetAgentId &&
      matchedHSet.has(ev.targetAgentId) &&
      (ev.kind === "subagent_spawn" || ev.kind === "subagent_done")
    ) {
      const lbl = hReadableById.get(ev.targetAgentId);
      if (lbl && (!strVal(ev.payload?.agentLabel) || isUuidOrOpaqueId(strVal(ev.payload?.agentLabel)))) {
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

    const pDoneCandidates = passiveDoneByHId.get(h.hId) ?? [];
    const pDone =
      pDoneCandidates.find(
        (e) => p.spawnEv.toolCallId && e.toolCallId === p.spawnEv.toolCallId,
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
        p.spawnEv.toolCallId ||
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
    secondary.spawnEv.toolCallId = primary.spawnEv.toolCallId;
    secondary.spawnEv.mergeKey = primary.spawnEv.mergeKey;
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
        label: extra?.label || prettifyAgentLabel(id),
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
        recentActions: [],
        convId: extra?.convId,
        modelSource: "unknown",
        usageSource: "estimated",
        hasExplicitUsage: false,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        contextTokens: 0,
        fallbackChars: 0,
        fallbackInputChars: 0,
        fallbackOutputChars: 0,
      };
      agentMap.set(id, st);
      agentOrder.push(id);
    } else {
      if (extra?.label && st.label === prettifyAgentLabel(id)) {
        st.label = extra.label;
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
    if (ag.firstEventEpoch === 0) ag.firstEventEpoch = ev.epoch;
    ag.lastEventEpoch = Math.max(ag.lastEventEpoch, ev.epoch);
    const bodyChars = Math.max(
      ev.bodyLength ?? 0,
      payloadTextLen(ev.payload?.body),
      payloadTextLen(ev.payload?.prompt),
    );
    const toolInChars = Math.max(
      payloadTextLen(ev.payload?.toolArgs),
      payloadTextLen(ev.payload?.toolInput),
      payloadTextLen(ev.payload?.args),
      payloadTextLen(ev.payload?.input),
    );
    const toolOutChars = Math.max(
      payloadTextLen(ev.payload?.toolResult),
      payloadTextLen(ev.payload?.resultDetails),
      payloadTextLen(ev.payload?.preview),
    );
    const evCharSpan = Math.max(
      ev.summary.length,
      bodyChars,
      toolInChars,
      toolOutChars,
    );
    ag.fallbackChars += evCharSpan;
    if (ev.kind === "user_input") {
      ag.fallbackInputChars += Math.max(ev.summary.length, bodyChars);
    } else if (ev.kind === "tool_end") {
      ag.fallbackInputChars += Math.max(ev.summary.length, toolOutChars, bodyChars);
    } else if (ev.kind === "tool_start" || ev.kind === "board_mutation") {
      ag.fallbackOutputChars += Math.max(ev.summary.length, toolInChars);
    } else if (
      ev.kind === "subagent_spawn" ||
      ev.kind === "message" ||
      ev.kind === "assistant_turn_end" ||
      ev.kind === "subagent_done" ||
      ev.kind === "thinking_start"
    ) {
      ag.fallbackOutputChars += Math.max(ev.summary.length, bodyChars);
    } else {
      ag.fallbackInputChars += ev.summary.length;
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
        typeof uDelta.cachedTokens === "number"
      ) {
        ag.hasExplicitUsage = true;
        if (uDelta.usageSource === "exact") {
          ag.usageSource = "exact";
        }
        const inTok = Math.max(0, Math.round(uDelta.inputTokens ?? 0));
        const outTok = Math.max(0, Math.round(uDelta.outputTokens ?? 0));
        const cachedTok = Math.max(0, Math.round(uDelta.cachedTokens ?? 0));
        if (uDelta.isTotal) {
          ag.inputTokens = inTok;
          ag.outputTokens = outTok;
          ag.cachedTokens = cachedTok;
          ag.contextTokens = Math.max(
            0,
            Math.round(uDelta.contextTokens ?? inTok + outTok),
          );
        } else {
          ag.inputTokens += inTok;
          ag.outputTokens += outTok;
          ag.cachedTokens += cachedTok;
          if (typeof uDelta.contextTokens === "number") {
            ag.contextTokens = Math.max(
              ag.contextTokens,
              Math.round(uDelta.contextTokens),
            );
          } else {
            ag.contextTokens = Math.max(
              ag.contextTokens,
              ag.inputTokens + ag.outputTokens,
            );
          }
        }
      }
      if (typeof uDelta.costUsd === "number" && Number.isFinite(uDelta.costUsd)) {
        ag.costUsd = uDelta.isTotal
          ? uDelta.costUsd
          : (ag.costUsd ?? 0) + uDelta.costUsd;
      }
    }

    // Apply child model hint attached to subagent_spawn payloads (e.g. spawned child with 0 rows)
    const spawnLabelHint =
      (typeof ev.payload?.agentLabel === "string" && ev.payload.agentLabel.trim()
        ? ev.payload.agentLabel.trim()
        : undefined) ||
      (typeof ev.payload?.agentType === "string" && ev.payload.agentType.trim()
        ? ev.payload.agentType.trim()
        : undefined);
    if (
      ev.kind === "subagent_spawn" &&
      ev.targetAgentId &&
      typeof ev.payload?.childModel === "string" &&
      ev.payload.childModel.trim()
    ) {
      const childSt = ensureAgent(ev.targetAgentId, {
        label: spawnLabelHint,
        parentAgentId: ag.id,
        ide: ev.ide,
        epoch: ev.epoch,
      });
      if (!childSt.model) {
        childSt.model =
          prettifyModelName(ev.payload.childModel) || ev.payload.childModel;
        childSt.modelSource =
          ev.payload.childModelSource === "exact" ||
          ev.payload.childModelSource === "inherited"
            ? ev.payload.childModelSource
            : "inherited";
      }
    }

    switch (ev.kind) {
      case "session_start": {
        ag.action = "Session started";
        break;
      }

      case "user_input": {
        const isSubagentTarget =
          !ag.isRoot || Boolean(ag.parentAgentId) || Boolean(ev.parentAgentId);

        // Reset reportedDone + waiting/blocker when a turn starts!
        ag.reportedDone = false;
        ag.waitingReason = null;
        ag.waitingDetail = null;
        ag.hasBlocker = false;
        ag.isThinking = true;
        ag.thinkingSinceEpoch = ev.epoch;

        if (isSubagentTarget) {
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

        ag.thinkingAction = "Thinking on user prompt…";
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
        if (ev.status === "denied") {
          ag.hasBlocker = true;
          ag.action = `Blocked: ${ev.summary}`;
        } else if (ev.waitingReason) {
          ag.waitingReason = ev.waitingReason;
          ag.waitingDetail =
            ev.waitingReason === "user"
              ? "Waiting for user answer"
              : "Waiting for tool approval";
          ag.openTools.set(callKey, toolLabel);
        } else if (!ev.isSelfDaemon) {
          ag.hasBlocker = false;
          ag.waitingReason = null;
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

        if (ag.waitingReason === "user" || ag.waitingReason === "tool_approval") {
          ag.waitingReason = null;
          ag.waitingDetail = null;
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
        ag.reportedDone = true;
        ag.action = ev.summary || "Turn completed";
        if (ev.isError || ev.status === "error") {
          ag.hasBlocker = true;
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
  let sessionCostUsd = 0;
  let hasAnyCost = false;
  let peakContextPercent = 0;
  let peakContextTokens = 0;
  let peakContextAgentId: string | null = null;
  let exactUsageAgents = 0;
  let estimatedUsageAgents = 0;
  const modelBuckets = new Map<
    string,
    { model: string; agentCount: number; totalTokens: number }
  >();

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
      const contextWindow = inferContextWindow(finalModel, ag.ide);
      const contextTokens = ag.hasExplicitUsage
        ? ag.contextTokens
        : inputTokens + outputTokens;
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
        contextPercent,
        ...(ag.costUsd !== undefined ? { costUsd: ag.costUsd } : {}),
      };

      sessionTotalTokens += totalTokens;
      sessionInputTokens += inputTokens;
      sessionOutputTokens += outputTokens;
      sessionCachedTokens += cachedTokens;
      if (ag.costUsd !== undefined) {
        sessionCostUsd += ag.costUsd;
        hasAnyCost = true;
      }
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

      const bucket = modelBuckets.get(finalModel);
      if (bucket) {
        bucket.agentCount += 1;
        bucket.totalTokens += totalTokens;
      } else {
        modelBuckets.set(finalModel, {
          model: finalModel,
          agentCount: 1,
          totalTokens,
        });
      }
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
      pendingPrompt: null,
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

  const models: ModelUsageBucket[] = [...modelBuckets.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens || b.agentCount - a.agentCount)
    .map((b) => ({
      model: b.model,
      agentCount: b.agentCount,
      totalTokens: b.totalTokens,
      sharePercent:
        sessionTotalTokens > 0
          ? Math.min(100, Math.round((b.totalTokens / sessionTotalTokens) * 1000) / 10)
          : 0,
    }));

  const sessionUsage: SessionUsageSummary = {
    totalTokens: sessionTotalTokens,
    inputTokens: sessionInputTokens,
    outputTokens: sessionOutputTokens,
    cachedTokens: sessionCachedTokens,
    peakContextPercent,
    peakContextAgentId,
    usageSource: sessionUsageSource,
    ...(hasAnyCost ? { costUsd: Math.round(sessionCostUsd * 10000) / 10000 } : {}),
    models,
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
  };
}
