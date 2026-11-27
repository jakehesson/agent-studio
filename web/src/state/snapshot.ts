import type {
  AgentEdgeSnapshot,
  AgentNodeSnapshot,
  AgentStatus,
  AgentUsageMetrics,
  IdeSource,
  ModelUsageBucket,
  NormalizedEvent,
  PendingHumanPrompt,
  PendingQuestionItem,
  PendingQuestionOption,
  PromptSource,
  PromptStatus,
  SessionCounters,
  SessionSnapshot,
  SessionUsageSummary,
} from "../types.js";
import {
  classifyExternalTarget,
  isErrorEvent,
  isRoutineToolEnd,
  normalizeEpoch,
  normalizeStatus,
} from "../utils.js";

export interface ReconstructedSnapshot {
  agents: AgentNodeSnapshot[];
  edges: AgentEdgeSnapshot[];
  counters: SessionCounters;
  usage: SessionUsageSummary;
  activeEvent: NormalizedEvent | null;
}

interface UsageDeltaLike {
  model?: string;
  modelSource?: "exact" | "inherited" | "definition" | "unknown";
  usageSource?: "exact" | "estimated";
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  costUsd?: number;
  isTotal?: boolean;
}

interface UsageAcc {
  model?: string;
  modelSource: "exact" | "inherited" | "definition" | "unknown";
  usageSource: "exact" | "estimated";
  hasExplicitUsage: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  contextTokens: number;
  contextWindow?: number;
  costUsd?: number;
}

export function inferContextWindow(model?: string, ide?: IdeSource): number {
  const low = (model ?? "").trim().toLowerCase();
  if (low.includes("[1m]")) return 1_000_000;
  if (!low || low === "unknown") {
    return ide === "antigravity" ? 1_000_000 : 200_000;
  }
  if (/\bmai\b/i.test(low) || /^mai[-_]/i.test(low)) {
    return 1_000_000;
  }
  if (
    low.includes("gemini") ||
    low.includes("gpt-4.1") ||
    low.includes("gpt 4.1") ||
    low.includes("gpt-5.4") ||
    low.includes("gpt 5.4")
  ) {
    return 1_000_000;
  }
  if (
    low.includes("gpt-5") ||
    low.includes("gpt 5") ||
    low.includes("gpt-6") ||
    low.includes("gpt 6")
  ) {
    return 400_000;
  }
  if (
    low.includes("gpt-4o") ||
    low.includes("gpt 4o") ||
    /\bo[134](?:\b|-|_)/.test(low)
  ) {
    return 128_000;
  }
  return 200_000;
}

const MAX_FALLBACK_PAYLOAD_CHARS = 2000;
const MAX_PRIOR_TURN_PROSE_CHARS = 4000;

function fieldTextLen(val: unknown): number {
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

interface EventCharEstimate {
  inChars: number;
  outChars: number;
  proseChars: number;
  totalChars: number;
}

interface EstTokenAcc {
  inChars: number;
  outChars: number;
  priorProseChars: number;
  currentTurnProseChars: number;
  currentTurnTotalChars: number;
}

function estimateEventChars(ev: NormalizedEvent): EventCharEstimate {
  const sumLen = (ev.summary ?? "").length;
  const p = ev.payload;
  const bodyChars = Math.min(
    MAX_FALLBACK_PAYLOAD_CHARS,
    Math.max(
      typeof ev.bodyLength === "number" && Number.isFinite(ev.bodyLength)
        ? Math.max(0, Math.round(ev.bodyLength))
        : 0,
      fieldTextLen(p?.body),
      fieldTextLen(p?.prompt)
    )
  );
  const toolInChars = Math.min(
    MAX_FALLBACK_PAYLOAD_CHARS,
    Math.max(
      fieldTextLen(p?.toolArgs),
      fieldTextLen(p?.toolInput),
      fieldTextLen(p?.args),
      fieldTextLen(p?.input)
    )
  );
  const toolOutChars = Math.min(
    MAX_FALLBACK_PAYLOAD_CHARS,
    Math.max(
      fieldTextLen(p?.toolResult),
      fieldTextLen(p?.resultDetails),
      fieldTextLen(p?.preview)
    )
  );

  if (ev.kind === "user_input") {
    const totalChars = Math.max(sumLen, bodyChars);
    return { inChars: totalChars, outChars: 0, proseChars: totalChars, totalChars };
  }
  if (ev.kind === "tool_end") {
    const totalChars = Math.max(sumLen, toolOutChars, bodyChars);
    return { inChars: totalChars, outChars: 0, proseChars: 0, totalChars };
  }
  if (ev.kind === "tool_start" || ev.kind === "board_mutation") {
    const totalChars = Math.max(sumLen, toolInChars);
    return { inChars: 0, outChars: totalChars, proseChars: 0, totalChars };
  }
  if (
    ev.kind === "subagent_spawn" ||
    ev.kind === "message" ||
    ev.kind === "assistant_turn_end" ||
    ev.kind === "subagent_done" ||
    ev.kind === "thinking_start"
  ) {
    const totalChars = Math.max(sumLen, bodyChars);
    return { inChars: 0, outChars: totalChars, proseChars: totalChars, totalChars };
  }
  return { inChars: sumLen, outChars: 0, proseChars: sumLen, totalChars: sumLen };
}

function calcContextPercent(contextTokens: number, contextWindow: number): number {
  if (contextTokens <= 0 || contextWindow <= 0) return 0;
  const rawPct = (contextTokens / contextWindow) * 100;
  const rounded1 = Math.round(rawPct * 10) / 10;
  return Math.min(
    100,
    rounded1 > 0 ? rounded1 : Math.max(0.01, Math.round(rawPct * 100) / 100)
  );
}

function normalizeModelContextWindows(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim().toLowerCase();
    if (key && typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[key] = Math.round(v);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveCatalogContextWindow(
  model: string | undefined,
  modelContextWindows?: Record<string, number>
): number | undefined {
  if (!model || !modelContextWindows) return undefined;
  const low = model.trim().toLowerCase();
  if (!low || low === "unknown") return undefined;

  const lookup = (key: string): number | undefined => {
    if (!key) return undefined;
    const val = modelContextWindows[key];
    return typeof val === "number" && Number.isFinite(val) && val > 0
      ? Math.round(val)
      : undefined;
  };

  const direct = lookup(low);
  if (direct !== undefined) return direct;

  const noSuffix = low.replace(/\s*\([^)]+\)\s*$/, "").trim();
  if (noSuffix !== low) {
    const byNoSuffix = lookup(noSuffix);
    if (byNoSuffix !== undefined) return byNoSuffix;
  }

  const noPrefix = low
    .replace(/^(?:copilot|models|google|anthropic|openai|azure|vertex)\//i, "")
    .trim();
  if (noPrefix !== low) {
    const byNoPrefix = lookup(noPrefix);
    if (byNoPrefix !== undefined) return byNoPrefix;
  }

  const noBoth = noPrefix.replace(/\s*\([^)]+\)\s*$/, "").trim();
  if (noBoth !== low && noBoth !== noPrefix && noBoth !== noSuffix) {
    const byNoBoth = lookup(noBoth);
    if (byNoBoth !== undefined) return byNoBoth;
  }

  return undefined;
}

export function synthesizeSessionUsage(agents: AgentNodeSnapshot[]): SessionUsageSummary {
  const aiAgents = agents.filter((a) => (a.nodeType ?? "agent") === "agent");
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let peakContextPercent = 0;
  let peakContextTokens = 0;
  let peakContextAgentId: string | null = null;
  let costSum = 0;
  let hasCost = false;
  let exactCount = 0;
  let estCount = 0;

  const modelBuckets = new Map<string, { agentCount: number; totalTokens: number }>();

  for (const a of aiAgents) {
    const u = a.usage;
    if (!u) continue;
    totalTokens += u.totalTokens;
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    cachedTokens += u.cachedTokens;
    if (
      u.contextTokens > 0 &&
      (u.contextPercent > peakContextPercent ||
        (u.contextPercent === peakContextPercent &&
          u.contextTokens > peakContextTokens) ||
        peakContextAgentId === null)
    ) {
      peakContextPercent = u.contextPercent;
      peakContextTokens = u.contextTokens;
      peakContextAgentId = a.id;
    }
    if (typeof u.costUsd === "number" && Number.isFinite(u.costUsd)) {
      costSum += u.costUsd;
      hasCost = true;
    }
    if (u.usageSource === "exact") exactCount += 1;
    else estCount += 1;

    const modelName = u.model || a.model || "Unknown";
    const prev = modelBuckets.get(modelName);
    if (prev) {
      prev.agentCount += 1;
      prev.totalTokens += u.totalTokens;
    } else {
      modelBuckets.set(modelName, { agentCount: 1, totalTokens: u.totalTokens });
    }
  }

  const models: ModelUsageBucket[] = Array.from(modelBuckets.entries())
    .map(([model, b]) => ({
      model,
      agentCount: b.agentCount,
      totalTokens: b.totalTokens,
      sharePercent:
        totalTokens > 0
          ? Math.round((b.totalTokens / totalTokens) * 1000) / 10
          : aiAgents.length > 0
            ? Math.round((b.agentCount / aiAgents.length) * 1000) / 10
            : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.agentCount - a.agentCount);

  const usageSource: "exact" | "estimated" | "mixed" =
    exactCount > 0 && estCount > 0
      ? "mixed"
      : exactCount > 0
        ? "exact"
        : "estimated";

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    peakContextPercent: Math.round(peakContextPercent * 10) / 10,
    peakContextAgentId,
    usageSource,
    ...(hasCost ? { costUsd: Math.round(costSum * 10000) / 10000 } : {}),
    models,
  };
}

export function ensureMonotonicEvents(rawEvents: NormalizedEvent[]): NormalizedEvent[] {
  const sorted = rawEvents
    .map((ev, idx) => ({
      ...ev,
      epoch: normalizeEpoch(ev, idx),
    }))
    .sort((a, b) => a.epoch - b.epoch);

  let prev = -Infinity;
  return sorted.map((ev) => {
    const epoch = ev.epoch <= prev ? prev + 0.0001 : ev.epoch;
    prev = epoch;
    return { ...ev, epoch };
  });
}

function isHumanPromptTool(toolName?: string): boolean {
  if (!toolName) return false;
  const low = toolName.toLowerCase();
  return (
    low === "ask_question" ||
    low === "askuserquestion" ||
    low === "vscode_askquestions" ||
    low === "questioncarousel" ||
    low === "elicitationserialized" ||
    low === "ask_human" ||
    low === "agent_studio_ask_human" ||
    low === "mcp__agent-studio__ask_human" ||
    low === "agent-studio/ask_human"
  );
}

/**
 * Deterministically reconstructs agent states, edges, and counters at any timeline cursor
 * (inclusive index into `events`). Supports live-tail parity and full historical scrubbing.
 */
export function buildSnapshot(
  events: NormalizedEvent[],
  cursorIndex: number,
  baseSnapshot?: SessionSnapshot | null
): ReconstructedSnapshot {
  const safeIdx =
    events.length === 0 ? -1 : Math.max(0, Math.min(cursorIndex, events.length - 1));
  const slice = safeIdx >= 0 ? events.slice(0, safeIdx + 1) : [];

  const defaultIde: IdeSource = baseSnapshot?.ide ?? events[0]?.ide ?? "unknown";
  const rootId =
    baseSnapshot?.agents?.find(
      (a) => (a as AgentNodeSnapshot & { isRoot?: boolean }).isRoot
    )?.id ??
    slice.find((e) => e.agentId === "root" && !e.parentAgentId)?.agentId ??
    slice.find(
      (e) =>
        e.agentId &&
        e.agentId !== "human" &&
        e.agentId !== "ext:human" &&
        !e.agentId.startsWith("ext:") &&
        !e.parentAgentId
    )?.agentId ??
    "root";
  const agentMap = new Map<string, AgentNodeSnapshot>();
  const openTools = new Map<string, Map<string, string>>();
  const activeChildren = new Map<string, Set<string>>();
  const reportedDone = new Map<string, boolean>();
  const hasBlocker = new Map<string, boolean>();
  const waitingReason = new Map<string, string | null>();
  const estTokenAcc = new Map<string, EstTokenAcc>();
  const usageAccById = new Map<string, UsageAcc>();
  const baseUsageById = new Map<string, AgentUsageMetrics>();
  const edgeMap = new Map<string, AgentEdgeSnapshot>();

  // Seed roster from baseSnapshot so idle/undispatched agents retain their identity
  // (stash final usage separately so historical scrubbing never freezes end-of-session totals)
  if (baseSnapshot?.agents) {
    for (const a of baseSnapshot.agents) {
      if (a.usage) {
        baseUsageById.set(a.id, a.usage);
      }
      agentMap.set(a.id, {
        ...a,
        nodeType: a.nodeType ?? (a.id === "ext:human" ? "human" : a.id.startsWith("ext:") ? "external" : "agent"),
        status: "IDLE",
        usage: undefined,
        activeTool: undefined,
        thinkingSince: undefined,
        thinkingEpoch: undefined,
        steps: 0,
        toolCalls: 0,
        messagesSent: 0,
        messagesReceived: 0,
        summary: "Standby",
        recentActions: [],
        pendingPrompt: null,
      });
    }
  }

  const ensureNode = (
    id: string,
    opts?: {
      label?: string;
      ide?: IdeSource;
      parentAgentId?: string;
      nodeType?: "agent" | "human" | "external";
    }
  ): AgentNodeSnapshot => {
    let existing = agentMap.get(id);
    if (!existing) {
      const inferredType =
        opts?.nodeType ??
        (id === "ext:human" || id === "human"
          ? "human"
          : id.startsWith("ext:")
            ? "external"
            : "agent");
      existing = {
        id,
        label:
          opts?.label ||
          (id === "root"
            ? "Coordinator"
            : id === "ext:human" || id === "human"
              ? "User"
              : id.replace(/^ext:/, "")),
        parentAgentId: opts?.parentAgentId,
        nodeType: inferredType,
        ide: opts?.ide ?? defaultIde,
        status: "IDLE",
        steps: 0,
        toolCalls: 0,
        messagesSent: 0,
        messagesReceived: 0,
        summary: "Standby",
        recentActions: [],
      };
      agentMap.set(id, existing);
    } else {
      if (
        opts?.label &&
        (existing.label === existing.id ||
          existing.label === "Coordinator" ||
          existing.label === "subagent")
      ) {
        existing.label = opts.label;
      }
      if (opts?.parentAgentId && !existing.parentAgentId) {
        existing.parentAgentId = opts.parentAgentId;
      }
    }
    return existing;
  };

  const bumpEdge = (
    from: string,
    to: string,
    kind: NormalizedEvent["kind"],
    ts: string
  ): void => {
    if (!from || !to || from === to) return;
    const key = [from, to].sort().join("|");
    const prev = edgeMap.get(key);
    if (prev) {
      prev.count += 1;
      prev.lastKind = kind;
      prev.lastTs = ts;
    } else {
      edgeMap.set(key, { from, to, count: 1, lastKind: kind, lastTs: ts });
    }
  };

  const pushAction = (node: AgentNodeSnapshot, ev: NormalizedEvent): void => {
    node.recentActions = node.recentActions ?? [];
    node.recentActions.push({
      ts: ev.ts,
      text: ev.summary,
      kind: ev.kind,
      toolName: ev.toolName,
      routineEnd: isRoutineToolEnd(ev),
      isError: isErrorEvent(ev),
    });
    if (node.recentActions.length > 24) {
      node.recentActions.shift();
    }
  };

  let totalToolCalls = 0;
  let totalMessages = 0;
  let totalBoardMutations = 0;

  for (const ev of slice) {
    const actor = ensureNode(ev.agentId, {
      label: ev.agentLabel,
      ide: ev.ide,
      parentAgentId: ev.parentAgentId,
    });
    actor.lastEventAt = ev.ts;
    actor.lastEpoch = ev.epoch;
    actor.steps = (actor.steps ?? 0) + 1;

    const acc = estTokenAcc.get(actor.id) ?? {
      inChars: 0,
      outChars: 0,
      priorProseChars: 0,
      currentTurnProseChars: 0,
      currentTurnTotalChars: 0,
    };
    if (ev.kind === "user_input") {
      acc.priorProseChars += Math.min(
        MAX_PRIOR_TURN_PROSE_CHARS,
        acc.currentTurnProseChars
      );
      acc.currentTurnProseChars = 0;
      acc.currentTurnTotalChars = 0;
    }
    const delta = estimateEventChars(ev);
    acc.inChars += delta.inChars;
    acc.outChars += delta.outChars;
    acc.currentTurnTotalChars += delta.totalChars;
    if (delta.proseChars > 0) {
      acc.currentTurnProseChars = Math.min(
        MAX_PRIOR_TURN_PROSE_CHARS,
        acc.currentTurnProseChars + delta.proseChars
      );
    }
    estTokenAcc.set(actor.id, acc);
    if (!actor.model && typeof ev.payload?.model === "string" && ev.payload.model.trim()) {
      actor.model = ev.payload.model.trim();
    }

    const rawDelta =
      (ev as { usageDelta?: unknown }).usageDelta ?? ev.payload?._usageDelta;
    if (rawDelta && typeof rawDelta === "object" && !Array.isArray(rawDelta)) {
      const uDelta = rawDelta as UsageDeltaLike;
      const uAcc: UsageAcc = usageAccById.get(actor.id) ?? {
        modelSource: "unknown",
        usageSource: "estimated",
        hasExplicitUsage: false,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        contextTokens: 0,
      };
      if (typeof uDelta.model === "string" && uDelta.model.trim()) {
        const incomingSrc = uDelta.modelSource ?? "exact";
        if (
          !uAcc.model ||
          incomingSrc === "exact" ||
          uAcc.modelSource === "unknown"
        ) {
          uAcc.model = uDelta.model.trim();
          uAcc.modelSource = incomingSrc;
          actor.model = uAcc.model;
        }
      }
      if (
        typeof uDelta.contextWindow === "number" &&
        Number.isFinite(uDelta.contextWindow) &&
        uDelta.contextWindow > 0
      ) {
        uAcc.contextWindow = Math.round(uDelta.contextWindow);
      }
      if (
        typeof uDelta.inputTokens === "number" ||
        typeof uDelta.outputTokens === "number" ||
        typeof uDelta.cachedTokens === "number"
      ) {
        uAcc.hasExplicitUsage = true;
        if (uDelta.usageSource === "exact") {
          uAcc.usageSource = "exact";
        }
        const inTok = Math.max(0, Math.round(uDelta.inputTokens ?? 0));
        const outTok = Math.max(0, Math.round(uDelta.outputTokens ?? 0));
        const cachedTok = Math.max(0, Math.round(uDelta.cachedTokens ?? 0));
        if (uDelta.isTotal) {
          uAcc.inputTokens = inTok;
          uAcc.outputTokens = outTok;
          uAcc.cachedTokens = cachedTok;
          uAcc.contextTokens = Math.max(
            0,
            Math.round(uDelta.contextTokens ?? inTok + outTok)
          );
        } else {
          uAcc.inputTokens += inTok;
          uAcc.outputTokens += outTok;
          uAcc.cachedTokens += cachedTok;
          if (
            typeof uDelta.contextTokens === "number" &&
            Number.isFinite(uDelta.contextTokens)
          ) {
            uAcc.contextTokens = Math.max(
              uAcc.contextTokens,
              Math.round(uDelta.contextTokens)
            );
          } else if (typeof uDelta.inputTokens === "number" && inTok > 0) {
            uAcc.contextTokens = Math.max(
              uAcc.contextTokens,
              inTok + cachedTok + outTok
            );
          }
        }
      }
      if (typeof uDelta.costUsd === "number" && Number.isFinite(uDelta.costUsd)) {
        uAcc.costUsd = uDelta.isTotal
          ? uDelta.costUsd
          : (uAcc.costUsd ?? 0) + uDelta.costUsd;
      }
      usageAccById.set(actor.id, uAcc);
    }

    let toolMap = openTools.get(actor.id);
    if (!toolMap) {
      toolMap = new Map<string, string>();
      openTools.set(actor.id, toolMap);
    }

    switch (ev.kind) {
      case "session_start": {
        actor.summary = ev.summary || "Session started";
        pushAction(actor, ev);
        break;
      }
      case "user_input": {
        const isSubagentTarget =
          actor.id !== rootId ||
          Boolean(actor.parentAgentId) ||
          Boolean(ev.parentAgentId);
        if (!isSubagentTarget) {
          const human = ensureNode("ext:human", { label: "User", nodeType: "human", ide: ev.ide });
          human.messagesSent += 1;
          human.lastEventAt = ev.ts;
          human.lastEpoch = ev.epoch;
          human.summary = ev.summary;
          pushAction(human, ev);

          actor.messagesReceived += 1;
          bumpEdge("ext:human", actor.id, ev.kind, ev.ts);
          totalMessages += 1;
        }

        actor.summary = `Prompt: ${ev.summary}`;
        actor.thinkingSince = ev.ts;
        actor.thinkingEpoch = ev.epoch;
        reportedDone.set(actor.id, false);
        hasBlocker.set(actor.id, false);
        waitingReason.set(actor.id, null);
        pushAction(actor, ev);
        break;
      }
      case "thinking_start": {
        reportedDone.set(actor.id, false);
        actor.thinkingSince = ev.ts;
        actor.thinkingEpoch = ev.epoch;
        actor.summary = ev.summary || "Reasoning…";
        pushAction(actor, ev);
        break;
      }
      case "tool_start": {
        const isSelfDaemon = ev.payload?.isSelfDaemon === true;
        reportedDone.set(actor.id, false);
        hasBlocker.set(actor.id, false);
        actor.toolCalls += 1;
        totalToolCalls += 1;
        actor.summary = ev.summary || `Tool: ${ev.toolName ?? "exec"}`;
        pushAction(actor, ev);

        if (isHumanPromptTool(ev.toolName)) {
          waitingReason.set(actor.id, "user");
          const human = ensureNode("ext:human", { label: "User", nodeType: "human", ide: ev.ide });
          human.messagesReceived += 1;
          bumpEdge(actor.id, "ext:human", ev.kind, ev.ts);
        } else if (!isSelfDaemon) {
          const callKey = ev.toolCallId ?? `${ev.toolName ?? "tool"}:${ev.id}`;
          const readableName = ev.toolName?.trim() || "tool";
          toolMap.set(callKey, readableName);
          actor.activeTool = toolMap.values().next().value;
          if (ev.payload?.isConfirmed === false) {
            waitingReason.set(actor.id, "tool_approval");
          }
        }

        const extTarget = ev.targetAgentId?.startsWith("ext:")
          ? { id: ev.targetAgentId, label: ev.targetAgentId.replace(/^ext:/, "") }
          : classifyExternalTarget(ev.toolName);
        if (extTarget && extTarget.id !== "ext:human") {
          const extNode = ensureNode(extTarget.id, {
            label: extTarget.label,
            nodeType: "external",
            ide: ev.ide,
          });
          extNode.toolCalls += 1;
          extNode.lastEventAt = ev.ts;
          extNode.lastEpoch = ev.epoch;
          extNode.summary = ev.summary;
          pushAction(extNode, ev);
          bumpEdge(actor.id, extNode.id, ev.kind, ev.ts);
        }
        break;
      }
      case "tool_end": {
        if (ev.toolCallId && toolMap.has(ev.toolCallId)) {
          toolMap.delete(ev.toolCallId);
        } else if (ev.toolName) {
          const targetName = ev.toolName.trim();
          let matchedKey: string | undefined;
          for (const [k, v] of toolMap.entries()) {
            if (v === targetName || v === ev.toolName) {
              matchedKey = k;
              break;
            }
          }
          if (matchedKey !== undefined) {
            toolMap.delete(matchedKey);
          } else if (toolMap.size > 0) {
            const first = toolMap.keys().next().value;
            if (first !== undefined) toolMap.delete(first);
          }
        } else if (toolMap.size > 0) {
          const first = toolMap.keys().next().value;
          if (first !== undefined) toolMap.delete(first);
        }
        actor.activeTool =
          toolMap.size > 0 ? toolMap.values().next().value : undefined;
        if (waitingReason.get(actor.id) === "tool_approval") {
          waitingReason.set(actor.id, null);
        }
        actor.thinkingSince = ev.ts;
        actor.thinkingEpoch = ev.epoch;
        actor.summary = ev.summary || `Finished ${ev.toolName ?? "tool"}`;
        if (isErrorEvent(ev)) {
          hasBlocker.set(actor.id, true);
        }
        pushAction(actor, ev);
        break;
      }
      case "subagent_spawn": {
        const childId = ev.targetAgentId || "subagent";
        const childLabel =
          (typeof ev.payload?.agentLabel === "string" && ev.payload.agentLabel.trim()) ||
          (typeof ev.payload?.agentType === "string" && ev.payload.agentType.trim()) ||
          (typeof ev.payload?.role === "string" && ev.payload.role.trim()) ||
          undefined;
        const child = ensureNode(childId, {
          label: childLabel,
          parentAgentId: actor.id,
          ide: ev.ide,
          nodeType: "agent",
        });
        child.messagesReceived += 1;
        child.lastEventAt = ev.ts;
        child.lastEpoch = ev.epoch;
        child.thinkingSince = ev.ts;
        child.thinkingEpoch = ev.epoch;
        child.summary = ev.summary || "Spawned";
        reportedDone.set(child.id, false);
        pushAction(child, ev);

        actor.messagesSent += 1;
        actor.summary = `Dispatched ${child.label}`;
        pushAction(actor, ev);

        const kids = activeChildren.get(actor.id) ?? new Set<string>();
        kids.add(child.id);
        activeChildren.set(actor.id, kids);
        bumpEdge(actor.id, child.id, ev.kind, ev.ts);
        totalMessages += 1;
        break;
      }
      case "subagent_done": {
        if (!ev.targetAgentId && (actor.id === "root" || actor.id === rootId)) {
          pushAction(actor, ev);
          break;
        }
        const doneId =
          ev.targetAgentId && ev.targetAgentId !== actor.id
            ? ev.targetAgentId
            : actor.id;
        const doneNode =
          doneId === actor.id
            ? actor
            : ensureNode(doneId, {
                ide: ev.ide,
                parentAgentId: actor.id,
                nodeType: "agent",
              });
        openTools.get(doneNode.id)?.clear();
        doneNode.activeTool = undefined;
        if (ev.toolCallId && actor.id !== doneId && toolMap.has(ev.toolCallId)) {
          toolMap.delete(ev.toolCallId);
          actor.activeTool =
            toolMap.size > 0 ? toolMap.values().next().value : undefined;
        }
        doneNode.thinkingSince = undefined;
        doneNode.thinkingEpoch = undefined;
        doneNode.lastEventAt = ev.ts;
        doneNode.lastEpoch = ev.epoch;
        reportedDone.set(doneNode.id, true);
        waitingReason.set(doneNode.id, null);
        if (ev.payload?.canceled === true) {
          hasBlocker.set(doneNode.id, false);
        } else if (isErrorEvent(ev)) {
          hasBlocker.set(doneNode.id, true);
        } else {
          hasBlocker.set(doneNode.id, false);
        }
        doneNode.summary = ev.summary || "Completed";
        pushAction(doneNode, ev);

        const parentId =
          doneNode.parentAgentId ?? (doneId !== actor.id ? actor.id : undefined);
        if (parentId) {
          if (ev.toolCallId && parentId !== doneId) {
            const parentTools = openTools.get(parentId);
            if (parentTools?.has(ev.toolCallId)) {
              parentTools.delete(ev.toolCallId);
              const parentNode = agentMap.get(parentId);
              if (parentNode) {
                parentNode.activeTool =
                  parentTools.size > 0 ? parentTools.values().next().value : undefined;
              }
            }
          }
          activeChildren.get(parentId)?.delete(doneNode.id);
          bumpEdge(doneNode.id, parentId, ev.kind, ev.ts);
        }
        activeChildren.get(actor.id)?.delete(doneNode.id);
        break;
      }
      case "message": {
        actor.messagesSent += 1;
        totalMessages += 1;
        actor.summary = ev.summary;
        if (isErrorEvent(ev)) hasBlocker.set(actor.id, true);
        pushAction(actor, ev);

        if (ev.targetAgentId && ev.targetAgentId !== actor.id) {
          const target = ensureNode(ev.targetAgentId, { ide: ev.ide });
          target.messagesReceived += 1;
          target.lastEventAt = ev.ts;
          target.lastEpoch = ev.epoch;
          reportedDone.set(target.id, false);
          bumpEdge(actor.id, target.id, ev.kind, ev.ts);
        }
        break;
      }
      case "board_mutation": {
        totalBoardMutations += 1;
        actor.summary = ev.summary;
        pushAction(actor, ev);
        const boardExt = ensureNode("ext:board", {
          label: "Agile Board MCP",
          nodeType: "external",
          ide: "mcp",
        });
        boardExt.toolCalls += 1;
        boardExt.lastEventAt = ev.ts;
        boardExt.lastEpoch = ev.epoch;
        boardExt.summary = ev.summary;
        pushAction(boardExt, ev);
        bumpEdge(actor.id, boardExt.id, ev.kind, ev.ts);
        break;
      }
      case "assistant_turn_end": {
        toolMap.clear();
        actor.activeTool = undefined;
        waitingReason.set(actor.id, null);
        reportedDone.set(actor.id, true);
        if (isErrorEvent(ev)) {
          hasBlocker.set(actor.id, true);
        } else {
          hasBlocker.set(actor.id, false);
        }
        actor.summary = ev.summary || "Turn completed";
        pushAction(actor, ev);
        const parentId = actor.parentAgentId ?? ev.parentAgentId;
        if (parentId && parentId !== actor.id) {
          activeChildren.get(parentId)?.delete(actor.id);
        }
        break;
      }
    }
  }

  const headEvent = slice.length > 0 ? slice[slice.length - 1] ?? null : null;
  const refEpoch = headEvent?.epoch ?? 0;

  let activeAgents = 0;
  let completedAgents = 0;

  for (const node of agentMap.values()) {
    if (node.nodeType === "human" || node.nodeType === "external") {
      node.status = node.toolCalls > 0 || node.messagesSent > 0 || node.messagesReceived > 0 ? "DONE" : "IDLE";
      continue;
    }

    const touched =
      (node.steps ?? 0) > 0 || node.toolCalls > 0 || node.messagesSent > 0 || node.messagesReceived > 0;
    if (!touched) {
      node.status = "IDLE";
      continue;
    }

    const openToolCount = openTools.get(node.id)?.size ?? 0;
    const activeChildCount = activeChildren.get(node.id)?.size ?? 0;
    const wait = waitingReason.get(node.id);
    const done = reportedDone.get(node.id) === true;
    const blocked = hasBlocker.get(node.id) === true;
    const dt = node.lastEpoch != null ? Math.max(0, refEpoch - node.lastEpoch) : 0;

    let status: AgentStatus;
    if (blocked) {
      status = "BLOCKED";
    } else if (wait) {
      status = "WAITING";
    } else if (openToolCount > 0) {
      status = dt > 900 ? "IDLE" : "WORKING";
    } else if (activeChildCount > 0) {
      status = "WAITING";
    } else if (done) {
      status = "DONE";
    } else if (dt > 900) {
      status = "IDLE";
    } else {
      status = "THINKING";
    }

    node.status = status;
    if (status === "THINKING" || status === "WORKING" || status === "WAITING") {
      activeAgents += 1;
    } else if (status === "DONE") {
      completedAgents += 1;
    }

    // Reconstruct per-cursor usage from _usageDelta or char estimates; only fall back to baseUsage at live tail
    const isAtLiveTail = safeIdx >= events.length - 1;
    const uAcc = usageAccById.get(node.id);
    const baseUsage = baseUsageById.get(node.id);
    if (uAcc?.hasExplicitUsage) {
      const model = uAcc.model || node.model || baseUsage?.model || "Unknown";
      const totalTokens = uAcc.inputTokens + uAcc.outputTokens + uAcc.cachedTokens;
      const explicitContextWindow =
        uAcc.contextWindow && uAcc.contextWindow > 0
          ? uAcc.contextWindow
          : baseUsage?.contextWindow &&
              baseUsage.contextWindow > 0 &&
              (!uAcc.model || baseUsage.model === model)
            ? baseUsage.contextWindow
            : undefined;
      const catalogContextWindow = resolveCatalogContextWindow(
        model,
        baseSnapshot?.modelContextWindows
      );
      const inferredWin = inferContextWindow(model, node.ide);
      const contextWindow =
        explicitContextWindow ?? catalogContextWindow ?? inferredWin;
      const nominalContextWindow =
        inferredWin > contextWindow
          ? inferredWin
          : baseUsage?.nominalContextWindow &&
              baseUsage.nominalContextWindow > contextWindow
            ? baseUsage.nominalContextWindow
            : undefined;
      const contextTokens = uAcc.contextTokens;
      const contextPercent = calcContextPercent(contextTokens, contextWindow);
      node.usage = {
        model,
        modelSource:
          uAcc.modelSource !== "unknown"
            ? uAcc.modelSource
            : node.model
              ? "exact"
              : baseUsage?.modelSource ?? "unknown",
        usageSource: uAcc.usageSource,
        inputTokens: uAcc.inputTokens,
        outputTokens: uAcc.outputTokens,
        cachedTokens: uAcc.cachedTokens,
        totalTokens,
        contextTokens,
        contextWindow,
        ...(nominalContextWindow ? { nominalContextWindow } : {}),
        contextPercent,
        ...(uAcc.costUsd !== undefined
          ? { costUsd: Math.round(uAcc.costUsd * 10000) / 10000 }
          : {}),
      };
    } else if (isAtLiveTail && baseUsage) {
      node.usage = baseUsage;
    } else {
      const acc = estTokenAcc.get(node.id) ?? {
        inChars: 0,
        outChars: 0,
        priorProseChars: 0,
        currentTurnProseChars: 0,
        currentTurnTotalChars: 0,
      };
      const inputTokens = Math.round(acc.inChars / 4);
      const outputTokens = Math.round(acc.outChars / 4);
      const totalTokens = inputTokens + outputTokens;
      const model = uAcc?.model || node.model || baseUsage?.model || "Unknown";
      const explicitContextWindow =
        uAcc?.contextWindow && uAcc.contextWindow > 0
          ? uAcc.contextWindow
          : baseUsage?.contextWindow &&
              baseUsage.contextWindow > 0 &&
              (!uAcc?.model || baseUsage.model === model)
            ? baseUsage.contextWindow
            : undefined;
      const catalogContextWindow = resolveCatalogContextWindow(
        model,
        baseSnapshot?.modelContextWindows
      );
      const inferredWin = inferContextWindow(model, node.ide);
      const contextWindow =
        explicitContextWindow ?? catalogContextWindow ?? inferredWin;
      const nominalContextWindow =
        inferredWin > contextWindow
          ? inferredWin
          : baseUsage?.nominalContextWindow &&
              baseUsage.nominalContextWindow > contextWindow
            ? baseUsage.nominalContextWindow
            : undefined;
      const activeContextChars = acc.priorProseChars + acc.currentTurnTotalChars;
      const contextTokens = Math.min(totalTokens, Math.round(activeContextChars / 4));
      const contextPercent = calcContextPercent(contextTokens, contextWindow);
      const estUsage: AgentUsageMetrics = {
        model,
        modelSource: node.model ? "exact" : baseUsage?.modelSource ?? "unknown",
        usageSource: "estimated",
        inputTokens,
        outputTokens,
        cachedTokens: 0,
        totalTokens,
        contextTokens,
        contextWindow,
        ...(nominalContextWindow ? { nominalContextWindow } : {}),
        contextPercent,
      };
      node.usage = estUsage;
    }
  }

  const finalAgents = Array.from(agentMap.values());
  return {
    agents: finalAgents,
    edges: Array.from(edgeMap.values()),
    counters: {
      totalEvents: slice.length,
      toolCalls: totalToolCalls,
      messages: totalMessages,
      boardMutations: totalBoardMutations,
      activeAgents,
      completedAgents,
    },
    usage: synthesizeSessionUsage(finalAgents),
    activeEvent: headEvent,
  };
}

function normalizePendingOption(raw: unknown): PendingQuestionOption | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (typeof raw === "string" && raw.trim()) {
      return { label: raw.trim() };
    }
    return null;
  }
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === "string" ? r.label : typeof r.value === "string" ? r.value : "";
  if (!label) return null;
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    label,
    description: typeof r.description === "string" ? r.description : undefined,
    recommended: Boolean(r.recommended),
  };
}

function normalizePendingQuestionItem(raw: unknown): PendingQuestionItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const options = Array.isArray(r.options)
    ? r.options.map(normalizePendingOption).filter((o): o is PendingQuestionOption => o !== null)
    : [];
  const rawType = r.type;
  const type: PendingQuestionItem["type"] =
    rawType === "multi_select" || rawType === "text" || rawType === "single_select"
      ? rawType
      : options.length > 0
        ? "single_select"
        : "text";
  const question =
    typeof r.question === "string"
      ? r.question
      : typeof r.title === "string"
        ? r.title
        : typeof r.prompt === "string"
          ? r.prompt
          : "";
  if (!question && options.length === 0) return null;
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    header: typeof r.header === "string" ? r.header : undefined,
    question: question || (typeof r.header === "string" ? r.header : "Select an option"),
    type,
    options,
    allowCustomInput: typeof r.allowCustomInput === "boolean" ? r.allowCustomInput : undefined,
    defaultValue: typeof r.defaultValue === "string" ? r.defaultValue : undefined,
  };
}

function normalizePromptSource(raw: unknown): PromptSource | undefined {
  if (raw === "native" || raw === "studio-mcp" || raw === "studio-vscode-lm") {
    return raw;
  }
  return undefined;
}

function normalizePromptStatus(raw: unknown): PromptStatus | undefined {
  if (
    raw === "pending" ||
    raw === "answered" ||
    raw === "canceled" ||
    raw === "expired"
  ) {
    return raw;
  }
  return undefined;
}

export function normalizePendingHumanPrompt(raw: unknown): PendingHumanPrompt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  const agentId = typeof r.agentId === "string" ? r.agentId : "";
  const title = typeof r.title === "string" ? r.title : "";
  if (!id && !agentId && !title) return null;

  const rawOptions = Array.isArray(r.options)
    ? r.options
        .map((o): { label: string; recommended?: boolean } | null => {
          const norm = normalizePendingOption(o);
          return norm ? { label: norm.label, recommended: norm.recommended } : null;
        })
        .filter((o): o is { label: string; recommended?: boolean } => o !== null)
    : undefined;

  let questions = Array.isArray(r.questions)
    ? r.questions
        .map(normalizePendingQuestionItem)
        .filter((q): q is PendingQuestionItem => q !== null)
    : [];

  if (questions.length === 0 && rawOptions && rawOptions.length > 0) {
    questions = [
      {
        question: title || "Choose an option",
        type: "single_select",
        options: rawOptions.map((o) => ({ label: o.label, recommended: o.recommended })),
        allowCustomInput: true,
      },
    ];
  }

  const promptSource = normalizePromptSource(r.promptSource);
  const status = normalizePromptStatus(r.status);
  const answers =
    r.answers && typeof r.answers === "object" && !Array.isArray(r.answers)
      ? (r.answers as Record<string, unknown>)
      : undefined;

  return {
    id: id || `prompt-${agentId || "agent"}`,
    toolCallId: typeof r.toolCallId === "string" ? r.toolCallId : undefined,
    toolName: typeof r.toolName === "string" ? r.toolName : undefined,
    agentId,
    agentLabel: typeof r.agentLabel === "string" ? r.agentLabel : agentId || "Agent",
    kind: r.kind === "approval" ? "approval" : "question",
    title: title || "Waiting for input",
    summary: typeof r.summary === "string" ? r.summary : undefined,
    questions,
    options: rawOptions,
    ts: typeof r.ts === "string" ? r.ts : undefined,
    blockingToolCall: Boolean(r.blockingToolCall),
    ...(typeof r.directReply === "boolean" ? { directReply: r.directReply } : {}),
    ...(promptSource ? { promptSource } : {}),
    ...(status ? { status } : {}),
    ...(typeof r.answerText === "string" ? { answerText: r.answerText } : {}),
    ...(answers ? { answers } : {}),
    ...(typeof r.expiresAt === "string" ? { expiresAt: r.expiresAt } : {}),
    ...(typeof r.sessionId === "string" ? { sessionId: r.sessionId } : {}),
    ...(typeof r.workspacePath === "string" ? { workspacePath: r.workspacePath } : {}),
    ...(typeof r.ide === "string" ? { ide: r.ide as IdeSource } : {}),
  };
}

/**
 * Normalizes a raw `/api/state` or SSE payload so both canonical TS backend responses
 * and transitional payloads map cleanly into `SessionSnapshot`.
 */
export function normalizeServerSnapshot(raw: unknown): SessionSnapshot {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawEvents = Array.isArray(obj.events)
    ? (obj.events as NormalizedEvent[])
    : [];

  const events = ensureMonotonicEvents(rawEvents);
  const normalizedPendingPrompts = Array.isArray(obj.pendingPrompts)
    ? obj.pendingPrompts
        .map(normalizePendingHumanPrompt)
        .filter((p): p is PendingHumanPrompt => p !== null)
    : undefined;

  const promptByAgent = new Map<string, PendingHumanPrompt>();
  if (normalizedPendingPrompts) {
    for (const p of normalizedPendingPrompts) {
      if (p.agentId && !promptByAgent.has(p.agentId)) {
        promptByAgent.set(p.agentId, p);
      }
    }
  }

  const rawAgents = Array.isArray(obj.agents)
    ? (obj.agents as AgentNodeSnapshot[]).map((a) => {
        const normPrompt =
          a.pendingPrompt !== undefined
            ? normalizePendingHumanPrompt(a.pendingPrompt)
            : promptByAgent.get(a.id) ?? null;
        return {
          ...a,
          status: normalizeStatus(a.status),
          nodeType:
            a.nodeType ??
            (a.id === "ext:human" || a.id === "human"
              ? "human"
              : a.id.startsWith("ext:")
                ? "external"
                : "agent"),
          toolCalls: a.toolCalls ?? 0,
          messagesSent: a.messagesSent ?? 0,
          messagesReceived: a.messagesReceived ?? 0,
          pendingPrompt: normPrompt,
        };
      })
    : [];

  const rawEdges = Array.isArray(obj.edges) ? (obj.edges as AgentEdgeSnapshot[]) : [];
  const boardProjects = Array.isArray(obj.boardProjects)
    ? obj.boardProjects
    : Array.isArray(obj.board_projects)
      ? obj.board_projects
      : undefined;

  const countersObj = (obj.counters ?? {}) as Partial<SessionCounters>;

  return {
    sessionId: typeof obj.sessionId === "string" ? obj.sessionId : "",
    ide: (typeof obj.ide === "string" ? obj.ide : "unknown") as IdeSource,
    projectId: typeof obj.projectId === "string" ? obj.projectId : undefined,
    workspacePath: typeof obj.workspacePath === "string" ? obj.workspacePath : undefined,
    updatedAt:
      typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
    serverTime: typeof obj.serverTime === "string" ? obj.serverTime : undefined,
    status: normalizeStatus(typeof obj.status === "string" ? obj.status : "IDLE"),
    waitingOn: typeof obj.waitingOn === "string" ? obj.waitingOn : null,
    isWaiting: Boolean(obj.isWaiting),
    isCompleted: Boolean(obj.isCompleted),
    isMultiAgent: Boolean(obj.isMultiAgent),
    agents: rawAgents,
    edges: rawEdges,
    events,
    counters: {
      totalEvents: countersObj.totalEvents ?? events.length,
      toolCalls: countersObj.toolCalls ?? 0,
      messages: countersObj.messages ?? 0,
      boardMutations: countersObj.boardMutations ?? 0,
      activeAgents: countersObj.activeAgents ?? 0,
      completedAgents: countersObj.completedAgents ?? 0,
    },
    usage:
      obj.usage && typeof obj.usage === "object"
        ? (obj.usage as SessionUsageSummary)
        : undefined,
    sessions: Array.isArray(obj.sessions)
      ? (obj.sessions as SessionSnapshot["sessions"])
      : undefined,
    boardProjects: boardProjects as SessionSnapshot["boardProjects"],
    pendingPrompts: normalizedPendingPrompts,
    definitions: Array.isArray(obj.definitions)
      ? (obj.definitions as SessionSnapshot["definitions"])
      : undefined,
    teamRoster: Array.isArray(obj.teamRoster)
      ? (obj.teamRoster as SessionSnapshot["teamRoster"])
      : undefined,
    modelContextWindows: normalizeModelContextWindows(obj.modelContextWindows),
  };
}
