import type {
  AgentEdgeSnapshot,
  AgentNodeSnapshot,
  AgentStatus,
  AgentUsageMetrics,
  IdeSource,
  ModelUsageBucket,
  NormalizedEvent,
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
  costUsd?: number;
}

export function inferContextWindow(model?: string, ide?: IdeSource): number {
  const low = (model ?? "").trim().toLowerCase();
  if (low.includes("[1m]")) return 1_000_000;
  if (low.includes("gemini")) return 1_000_000;
  if (low.includes("claude")) return 200_000;
  if (low.includes("gpt-4.1") || low.includes("gpt 4.1")) return 1_000_000;
  if (
    low.includes("gpt-4o") ||
    low.includes("gpt 4o") ||
    /\bo[134](?:\b|-|_)/.test(low)
  ) {
    return 128_000;
  }
  if ((!low || low === "unknown") && ide === "antigravity") {
    return 1_000_000;
  }
  return 200_000;
}

function estimateEventChars(ev: NormalizedEvent): { inChars: number; outChars: number } {
  const sumLen = (ev.summary ?? "").length;
  let payloadLen = 0;
  if (ev.payload) {
    try {
      payloadLen = JSON.stringify(ev.payload).length;
    } catch {
      payloadLen = 0;
    }
  }
  const total = sumLen + Math.min(payloadLen, 8000);
  if (ev.kind === "user_input" || ev.kind === "tool_end") {
    return { inChars: total, outChars: 0 };
  }
  return { inChars: Math.round(total * 0.25), outChars: Math.round(total * 0.75) };
}

export function synthesizeSessionUsage(agents: AgentNodeSnapshot[]): SessionUsageSummary {
  const aiAgents = agents.filter((a) => (a.nodeType ?? "agent") === "agent");
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let peakContextPercent = 0;
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
    if (u.contextPercent >= peakContextPercent && u.contextPercent > 0) {
      peakContextPercent = u.contextPercent;
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
    low === "elicitationserialized"
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
  const agentMap = new Map<string, AgentNodeSnapshot>();
  const openTools = new Map<string, Set<string>>();
  const activeChildren = new Map<string, Set<string>>();
  const reportedDone = new Map<string, boolean>();
  const hasBlocker = new Map<string, boolean>();
  const waitingReason = new Map<string, string | null>();
  const estTokenAcc = new Map<string, { inChars: number; outChars: number }>();
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

    const acc = estTokenAcc.get(actor.id) ?? { inChars: 0, outChars: 0 };
    const delta = estimateEventChars(ev);
    acc.inChars += delta.inChars;
    acc.outChars += delta.outChars;
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
          if (typeof uDelta.contextTokens === "number") {
            uAcc.contextTokens = Math.max(
              uAcc.contextTokens,
              Math.round(uDelta.contextTokens)
            );
          } else {
            uAcc.contextTokens = Math.max(
              uAcc.contextTokens,
              uAcc.inputTokens + uAcc.outputTokens
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

    const toolSet = openTools.get(actor.id) ?? new Set<string>();
    openTools.set(actor.id, toolSet);

    switch (ev.kind) {
      case "session_start": {
        actor.summary = ev.summary || "Session started";
        pushAction(actor, ev);
        break;
      }
      case "user_input": {
        const human = ensureNode("ext:human", { label: "User", nodeType: "human", ide: ev.ide });
        human.messagesSent += 1;
        human.lastEventAt = ev.ts;
        human.lastEpoch = ev.epoch;
        human.summary = ev.summary;
        pushAction(human, ev);

        actor.messagesReceived += 1;
        actor.summary = `Prompt: ${ev.summary}`;
        actor.thinkingSince = ev.ts;
        actor.thinkingEpoch = ev.epoch;
        reportedDone.set(actor.id, false);
        hasBlocker.set(actor.id, false);
        waitingReason.set(actor.id, null);
        pushAction(actor, ev);
        bumpEdge("ext:human", actor.id, ev.kind, ev.ts);
        totalMessages += 1;
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
          const callKey = ev.toolCallId ?? ev.toolName ?? ev.id;
          toolSet.add(callKey);
          actor.activeTool = ev.toolName ?? "tool";
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
        const callKey = ev.toolCallId ?? ev.toolName;
        if (callKey && toolSet.has(callKey)) {
          toolSet.delete(callKey);
        } else if (toolSet.size > 0) {
          const first = toolSet.values().next().value;
          if (first) toolSet.delete(first);
        }
        if (toolSet.size === 0) actor.activeTool = undefined;
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
        if (!ev.targetAgentId && actor.id === "root") {
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
        toolSet.clear();
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
      const contextWindow = inferContextWindow(model, node.ide);
      const contextTokens = uAcc.contextTokens;
      const contextPercent =
        contextWindow > 0
          ? Math.min(100, Math.round((contextTokens / contextWindow) * 1000) / 10)
          : 0;
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
        contextPercent,
        ...(uAcc.costUsd !== undefined
          ? { costUsd: Math.round(uAcc.costUsd * 10000) / 10000 }
          : {}),
      };
    } else if (isAtLiveTail && baseUsage) {
      node.usage = baseUsage;
    } else {
      const acc = estTokenAcc.get(node.id) ?? { inChars: 0, outChars: 0 };
      const inputTokens = Math.round(acc.inChars / 4);
      const outputTokens = Math.round(acc.outChars / 4);
      const totalTokens = inputTokens + outputTokens;
      const model = uAcc?.model || node.model || baseUsage?.model || "Unknown";
      const contextWindow = inferContextWindow(model, node.ide);
      const contextTokens = totalTokens;
      const contextPercent =
        contextWindow > 0
          ? Math.min(100, Math.round((contextTokens / contextWindow) * 1000) / 10)
          : 0;
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
  const rawAgents = Array.isArray(obj.agents)
    ? (obj.agents as AgentNodeSnapshot[]).map((a) => ({
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
      }))
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
    pendingPrompts: Array.isArray(obj.pendingPrompts)
      ? (obj.pendingPrompts as SessionSnapshot["pendingPrompts"])
      : undefined,
    definitions: Array.isArray(obj.definitions)
      ? (obj.definitions as SessionSnapshot["definitions"])
      : undefined,
  };
}
