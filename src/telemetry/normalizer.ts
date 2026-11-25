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
  openTools: Set<string>;
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
}

function formatHms(epochSec: number): string {
  const d = new Date(Math.round(epochSec * 1000));
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function buildSessionSnapshot(
  rawEvents: EnrichedEvent[],
  opts: SnapshotBuildOptions,
): RichSessionSnapshot {
  const nowSec = opts.nowEpochSec ?? Date.now() / 1000;
  const deduped = deduplicateEvents(rawEvents);

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

  // Determine root agent ID (first non-human agent or "root")
  const rootId =
    events.find(
      (e) =>
        e.agentId &&
        e.agentId !== "human" &&
        !e.agentId.startsWith("ext:") &&
        !e.parentAgentId,
    )?.agentId ?? "root";

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
        openTools: new Set(),
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
    ag.fallbackChars += ev.summary.length;

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
    if (
      ev.kind === "subagent_spawn" &&
      ev.targetAgentId &&
      typeof ev.payload?.childModel === "string" &&
      ev.payload.childModel.trim()
    ) {
      const childSt = ensureAgent(ev.targetAgentId, {
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
        const human = ensureAgent("human");
        human.steps += 1;
        human.messagesSent += 1;
        human.lastEventEpoch = Math.max(human.lastEventEpoch, ev.epoch);
        human.action = ev.summary.slice(0, 48);
        pushRecent(human, ev.ts, "USER_INPUT", ev.summary);

        // Reset reportedDone + waiting/blocker when user sends a new turn!
        ag.reportedDone = false;
        ag.waitingReason = null;
        ag.waitingDetail = null;
        ag.hasBlocker = false;
        ag.isThinking = true;
        ag.thinkingSinceEpoch = ev.epoch;
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
        if (ev.status === "denied") {
          ag.hasBlocker = true;
          ag.action = `Blocked: ${ev.summary}`;
        } else if (ev.waitingReason) {
          ag.waitingReason = ev.waitingReason;
          ag.waitingDetail =
            ev.waitingReason === "user"
              ? "Waiting for user answer"
              : "Waiting for tool approval";
          ag.openTools.add(callKey);
        } else if (!ev.isSelfDaemon) {
          ag.hasBlocker = false;
          ag.waitingReason = null;
          ag.openTools.add(callKey);
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
          const firstKey = ag.openTools.values().next().value;
          if (firstKey !== undefined) ag.openTools.delete(firstKey);
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
          parentAgentId: ag.id,
          ide: ev.ide,
          epoch: ev.epoch,
        });
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
          conv: convId,
          ide: ev.ide,
          toolName: ev.toolName,
          channel: ev.channel,
        });
        break;
      }

      case "subagent_done": {
        // Could be emitted either by the child itself or by the parent receiving tool_result for targetAgentId
        const doneId =
          ev.targetAgentId && ev.targetAgentId !== ag.id
            ? ev.targetAgentId
            : ag.id;
        const doneAgent = ensureAgent(doneId, { ide: ev.ide, epoch: ev.epoch });
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

  // Resolve root model first so Antigravity subagents without explicit model can inherit it
  const rootAgForModel = agentMap.get(rootId);
  if (rootAgForModel && !rootAgForModel.model) {
    const defModel = defModelById.get(rootId.toLowerCase());
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

      // Resolve model fallback chain: runtime exact/inherited -> definition -> root inherit (Antigravity) -> "Unknown"
      let finalModel = ag.model;
      let finalModelSource: ModelSource = ag.modelSource;
      if (!finalModel) {
        const baseSlug = ag.id.replace(/-\d+$/, "").toLowerCase();
        const defMatch =
          defModelById.get(ag.id.toLowerCase()) ?? defModelById.get(baseSlug);
        if (defMatch) {
          finalModel = defMatch;
          finalModelSource = "definition";
        } else if (!ag.isRoot && ag.ide === "antigravity" && resolvedRootModel) {
          finalModel = resolvedRootModel;
          finalModelSource = "inherited";
        } else {
          finalModel = "Unknown";
          finalModelSource = "unknown";
        }
      }
      agentModel = finalModel;

      const inputTokens = ag.hasExplicitUsage
        ? ag.inputTokens
        : Math.round(ag.fallbackChars / 4);
      const outputTokens = ag.hasExplicitUsage ? ag.outputTokens : 0;
      const cachedTokens = ag.hasExplicitUsage ? ag.cachedTokens : 0;
      const totalTokens = inputTokens + outputTokens + cachedTokens;
      const contextWindow = inferContextWindow(finalModel);
      const contextTokens = ag.hasExplicitUsage
        ? ag.contextTokens
        : inputTokens + outputTokens;
      const contextPercent =
        contextWindow > 0
          ? Math.min(100, Math.round((contextTokens / contextWindow) * 1000) / 10)
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
      if (contextPercent > peakContextPercent) {
        peakContextPercent = contextPercent;
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
