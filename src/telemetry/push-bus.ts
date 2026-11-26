import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentStudioHome, listProjects } from "../board/registry.js";
import { NormalizedEventSchema, type IdeSource } from "../schema/telemetry.js";
import { defaultEventBodyStore, type EventBodyStore } from "./body-store.js";
import {
  cleanHumanSummary,
  computeDeterministicEventId,
  computeMergeKey,
  inferContextWindow,
  isOpaqueAgentId,
  lookupModelContextWindow,
  normalizeSubagentLabel,
  normalizeWsPath,
  parseEpochSeconds,
  prettifyModelName,
  toIsoUtc,
  type DiscoveredSession,
  type EnrichedEvent,
  type TelemetryChannel,
  type UsageDelta,
} from "./types.js";

export const MAX_EVENTS_PER_SESSION = 2000;
export const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
export const MAX_TRANSCRIPT_PATHS_PER_SESSION = 64;
export const MAX_CONTEXT_TRACKERS = 2000;
export const MAX_CORRELATION_ENTRIES = 500;

/**
 * Fast syntactic pre-check for transcriptPath / agentTranscriptPath values.
 * Rejects non-strings, empty strings, null bytes/control chars, UNC/device
 * prefixes, explicit `..` segments, relative paths, non-`.jsonl` suffixes,
 * and `telemetry.jsonl`.
 */
export function isValidTranscriptPathSyntax(rawPath: unknown): rawPath is string {
  if (typeof rawPath !== "string") return false;
  if (/[\x00-\x1f\x7f]/.test(rawPath)) return false;
  const trimmed = rawPath.trim();
  if (!trimmed) return false;
  // Reject UNC paths (\\host\share, //host/share) and Windows device paths (\\?\, \\.\)
  if (/^(?:\\\\|\/\/|\\\\\?\\|\\\\\.\\|[\\/]{2})/.test(trimmed)) return false;
  // Reject explicit parent-directory traversal segments
  if (/(?:^|[\\/])\.\.(?:$|[\\/])/.test(trimmed)) return false;
  if (!path.isAbsolute(trimmed)) return false;
  if (!/\.jsonl$/i.test(trimmed)) return false;
  if (path.basename(trimmed).toLowerCase() === "telemetry.jsonl") return false;
  return true;
}

function isPathStrictlyInsideRoot(realRoot: string, realTarget: string): boolean {
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

/**
 * Validates that `rawPath` is a regular `.jsonl` file (<= maxBytes) whose
 * resolved `fs.realpath` remains strictly contained within at least one
 * directory in `allowedRoots`. Returns the canonical realpath or `null`.
 */
export async function validateTranscriptPath(
  rawPath: unknown,
  allowedRoots: ReadonlyArray<string>,
  opts?: { maxBytes?: number },
): Promise<string | null> {
  if (!isValidTranscriptPathSyntax(rawPath)) return null;
  const trimmed = rawPath.trim();
  const maxBytes = opts?.maxBytes ?? MAX_TRANSCRIPT_BYTES;

  let lst;
  try {
    lst = await fs.lstat(trimmed);
  } catch {
    return null;
  }
  if (!lst.isFile() && !lst.isSymbolicLink()) {
    return null;
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(trimmed);
  } catch {
    return null;
  }
  if (
    !/\.jsonl$/i.test(realPath) ||
    path.basename(realPath).toLowerCase() === "telemetry.jsonl"
  ) {
    return null;
  }

  let st;
  try {
    st = await fs.stat(realPath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > maxBytes) {
    return null;
  }

  for (const root of allowedRoots) {
    if (typeof root !== "string" || !root.trim()) continue;
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root.trim());
    } catch {
      continue;
    }
    if (isPathStrictlyInsideRoot(realRoot, realPath)) {
      return realPath;
    }
  }
  return null;
}

export interface IngestResult {
  accepted: number;
  deduped: number;
  events: EnrichedEvent[];
}

export interface PushBusOptions {
  extraWorkspaces?: string[];
  includeGlobalTelemetryFile?: boolean;
  bodyStore?: EventBodyStore;
}

function extractRawBodyText(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const payload =
    obj.payload && typeof obj.payload === "object" && !Array.isArray(obj.payload)
      ? (obj.payload as Record<string, unknown>)
      : undefined;
  if (payload) {
    if (typeof payload.body === "string" && payload.body.length > 0) {
      return payload.body;
    }
    if (typeof payload.prompt === "string" && payload.prompt.length > 0) {
      return payload.prompt;
    }
  }
  if (typeof obj.body === "string" && obj.body.length > 0) {
    return obj.body;
  }
  return undefined;
}

export function coerceToEnrichedEvent(raw: unknown): EnrichedEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Telemetry event must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const epoch = parseEpochSeconds(
    (obj.epoch as number | undefined) ?? (obj.ts as string | undefined),
  );
  const ts =
    typeof obj.ts === "string" && obj.ts.trim() ? obj.ts : toIsoUtc(epoch);

  const ide =
    typeof obj.ide === "string" && obj.ide.trim() ? obj.ide : "unknown";
  const sessionId =
    typeof obj.sessionId === "string" && obj.sessionId.trim()
      ? obj.sessionId
      : "default";
  const agentId =
    typeof obj.agentId === "string" && obj.agentId.trim()
      ? obj.agentId
      : "root";
  const kind =
    typeof obj.kind === "string" && obj.kind.trim() ? obj.kind : "message";
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const toolName =
    typeof obj.toolName === "string" && obj.toolName.trim()
      ? obj.toolName
      : undefined;
  const toolCallId =
    typeof obj.toolCallId === "string" && obj.toolCallId.trim()
      ? obj.toolCallId
      : undefined;

  const id =
    typeof obj.id === "string" && obj.id.trim()
      ? obj.id
      : computeDeterministicEventId({
          ide: ide as EnrichedEvent["ide"],
          sessionId,
          agentId,
          kind: kind as EnrichedEvent["kind"],
          toolCallId,
          toolName,
          epoch,
          summary,
        });

  const rawPayload =
    obj.payload &&
    typeof obj.payload === "object" &&
    !Array.isArray(obj.payload)
      ? (obj.payload as Record<string, unknown>)
      : undefined;

  let sanitizedPayload: Record<string, unknown> | undefined = rawPayload;
  let computedBodyLength: number | undefined =
    typeof obj.bodyLength === "number" &&
    Number.isInteger(obj.bodyLength) &&
    obj.bodyLength >= 0
      ? obj.bodyLength
      : undefined;
  let computedBodyTruncated: boolean | undefined =
    typeof obj.bodyTruncated === "boolean" ? obj.bodyTruncated : undefined;

  if (rawPayload) {
    if (typeof rawPayload.body === "string") {
      const full = rawPayload.body;
      const inline = full.slice(0, 1400);
      if (full.length > inline.length) {
        sanitizedPayload = { ...rawPayload, body: inline };
      }
      if (full.length > 0) {
        computedBodyLength ??= full.length;
        computedBodyTruncated ??= full.length > inline.length;
      }
    } else if (typeof rawPayload.prompt === "string") {
      const full = rawPayload.prompt;
      const inline = full.slice(0, 1000);
      if (full.length > inline.length) {
        sanitizedPayload = { ...rawPayload, prompt: inline };
      }
      if (full.length > 0) {
        computedBodyLength ??= full.length;
        computedBodyTruncated ??= full.length > inline.length;
      }
    }
  }

  const validated = NormalizedEventSchema.parse({
    id,
    ts,
    ide,
    sessionId,
    workspacePath:
      typeof obj.workspacePath === "string" && obj.workspacePath.trim()
        ? normalizeWsPath(obj.workspacePath)
        : undefined,
    projectId:
      typeof obj.projectId === "string" && obj.projectId.trim()
        ? obj.projectId.trim()
        : undefined,
    agentId,
    agentLabel:
      typeof obj.agentLabel === "string" && obj.agentLabel.trim()
        ? obj.agentLabel.trim()
        : undefined,
    parentAgentId:
      typeof obj.parentAgentId === "string" && obj.parentAgentId.trim()
        ? obj.parentAgentId.trim()
        : undefined,
    kind,
    toolName,
    summary,
    payload: sanitizedPayload,
    ...(computedBodyLength !== undefined
      ? { bodyLength: computedBodyLength }
      : {}),
    ...(computedBodyTruncated !== undefined
      ? { bodyTruncated: computedBodyTruncated }
      : {}),
  });

  const channel: TelemetryChannel =
    obj.channel === "passive" || obj.channel === "hook" || obj.channel === "mcp"
      ? obj.channel
      : validated.ide === "mcp"
        ? "mcp"
        : "hook";

  const mergeKey =
    typeof obj.mergeKey === "string" && obj.mergeKey.trim()
      ? obj.mergeKey.trim()
      : computeMergeKey({
          sessionId: validated.sessionId,
          agentId: validated.agentId,
          kind: validated.kind,
          toolCallId,
          toolName: validated.toolName,
          epoch,
        });

  const targetAgentId =
    typeof obj.targetAgentId === "string" && obj.targetAgentId.trim()
      ? obj.targetAgentId.trim()
      : typeof validated.payload?.to === "string"
        ? validated.payload.to
        : undefined;

  const status =
    obj.status === "ok" ||
    obj.status === "running" ||
    obj.status === "error" ||
    obj.status === "denied"
      ? obj.status
      : validated.payload?.isError === true
        ? "error"
        : undefined;

  const isError =
    obj.isError === true ||
    status === "error" ||
    status === "denied" ||
    validated.payload?.isError === true;

  const isSelfDaemon = obj.isSelfDaemon === true;
  const waitingReason =
    obj.waitingReason === "user" ||
    obj.waitingReason === "tool_approval" ||
    obj.waitingReason === "subagent"
      ? obj.waitingReason
      : undefined;

  const rawUsageDelta =
    obj.usageDelta &&
    typeof obj.usageDelta === "object" &&
    !Array.isArray(obj.usageDelta)
      ? (obj.usageDelta as UsageDelta)
      : rawPayload?._usageDelta &&
          typeof rawPayload._usageDelta === "object" &&
          !Array.isArray(rawPayload._usageDelta)
        ? (rawPayload._usageDelta as UsageDelta)
        : undefined;

  const topModel =
    typeof obj.model === "string" && obj.model.trim()
      ? obj.model.trim()
      : typeof rawPayload?.model === "string" && rawPayload.model.trim()
        ? rawPayload.model.trim()
        : undefined;

  let usageDelta: UsageDelta | undefined = rawUsageDelta
    ? { ...rawUsageDelta }
    : undefined;
  if (topModel && !usageDelta?.model) {
    const pretty = prettifyModelName(topModel) || topModel;
    usageDelta = {
      ...(usageDelta ?? {}),
      model: pretty,
      modelSource: usageDelta?.modelSource ?? "exact",
    };
  }

  return {
    ...validated,
    epoch,
    channel,
    mergeKey,
    toolCallId,
    targetAgentId,
    status,
    isSelfDaemon,
    isError,
    waitingReason,
    ...(usageDelta ? { usageDelta } : {}),
  };
}

export interface SubagentParentMapping {
  parentSessionId: string;
  agentId: string;
  agentLabel?: string;
  agentType?: string;
}

export type ContextBand = "ok" | "warn" | "handoff" | "compact";

export interface ContextThresholdConfig {
  warnPercent: number;
  handoffPercent: number;
  compactPercent: number;
}

export const DEFAULT_CONTEXT_THRESHOLDS: ContextThresholdConfig = {
  warnPercent: 45,
  handoffPercent: 55,
  compactPercent: 70,
};

export interface AgentContextTrackerState {
  contextTokens: number;
  contextWindow?: number;
  model?: string;
  ide?: IdeSource;
  updatedAtMs: number;
  lastAdvisedBand: ContextBand;
  pendingDeferredAdvisory?: boolean;
}

export interface ContextAdvisory {
  band: Exclude<ContextBand, "ok">;
  sessionId: string;
  agentId: string;
  contextTokens: number;
  contextWindow: number;
  contextPercent: number;
  model?: string;
  isPreCompact?: boolean;
  message: string;
}

const CONTEXT_BAND_RANK: Record<ContextBand, number> = {
  ok: 0,
  warn: 1,
  handoff: 2,
  compact: 3,
};

export function formatContextWindowShort(windowTokens: number): string {
  if (windowTokens >= 1_000_000) {
    const m = Math.round((windowTokens / 1_000_000) * 10) / 10;
    return `${m}`.replace(/\.0$/, "") + "M";
  }
  return `${Math.round(windowTokens / 1000)}k`;
}

export function buildContextAdvisoryMessage(params: {
  band: Exclude<ContextBand, "ok">;
  contextPercent: number;
  contextWindow: number;
  handoffPercent: number;
  isPreCompact?: boolean;
}): string {
  const pct = Math.round(params.contextPercent);
  const winLabel = formatContextWindowShort(params.contextWindow);
  if (params.band === "compact" || params.isPreCompact) {
    return `[agent-studio context-budget: ${pct}% of ${winLabel}] Compact threshold reached${params.isPreCompact ? " (PreCompact)" : ""}. Pause new exploration and call \`board { op: 'handoff', ... }\` to checkpoint for a fresh context or return split proposals to orchestrator.`;
  }
  if (params.band === "handoff") {
    return `[agent-studio context-budget: ${pct}% of ${winLabel}] Drift/Handoff threshold reached. Pause new exploration and call \`board { op: 'handoff', ... }\` to checkpoint for a fresh context or return split proposals to orchestrator.`;
  }
  return `[agent-studio context-budget: ${pct}% of ${winLabel}] Approaching Drift zone (${params.handoffPercent}% handoff threshold). Wrap up active edits cleanly and prepare a \`board { op: 'handoff', ... }\` checkpoint if work continues.`;
}

export class PushBus extends EventEmitter {
  private readonly sessions = new Map<string, EnrichedEvent[]>();
  private readonly seenIds = new Map<string, Set<string>>();
  private readonly fileOffsets = new Map<string, number>();
  private readonly subagentToParent = new Map<string, SubagentParentMapping>();
  private readonly openUnlinkedSpawns = new Map<
    string,
    Array<{
      spawnId: string;
      normLabels: string[];
      label?: string;
      epoch: number;
      linkedUuid?: string;
    }>
  >();
  private readonly pendingUnlinkedUuids = new Map<
    string,
    Array<{
      uuid: string;
      normLabels: string[];
      label?: string;
      epoch: number;
      hasDone?: boolean;
    }>
  >();
  private readonly copilotUuidToSpawn = new Map<
    string,
    Map<string, { spawnId: string; label?: string }>
  >();
  private readonly sessionTranscriptPaths = new Map<string, Set<string>>();
  private readonly agentTranscriptPaths = new Map<string, Map<string, string>>();
  private readonly agentLabels = new Map<string, Map<string, string>>();
  private readonly contextTrackers = new Map<string, AgentContextTrackerState>();
  private readonly extraWorkspaces: string[];
  private readonly includeGlobalFile: boolean;
  private readonly bodyStore: EventBodyStore;

  constructor(options?: PushBusOptions) {
    super();
    this.extraWorkspaces = options?.extraWorkspaces ?? [];
    this.includeGlobalFile = options?.includeGlobalTelemetryFile ?? true;
    this.bodyStore = options?.bodyStore ?? defaultEventBodyStore;
  }

  getExtraWorkspaces(): string[] {
    return [...this.extraWorkspaces];
  }

  getTranscriptPaths(sessionId: string): string[] {
    return [...(this.sessionTranscriptPaths.get(sessionId) ?? [])];
  }

  getAgentTranscriptPaths(sessionId: string): Map<string, string> {
    return new Map(this.agentTranscriptPaths.get(sessionId) ?? []);
  }

  private recordAgentLabel(
    sessionId: string,
    agentId: string,
    label: string | undefined,
  ): void {
    const aid = agentId?.trim();
    const lbl = label?.trim();
    if (!aid || aid === "root" || aid === "subagent") return;
    if (!lbl || isOpaqueAgentId(lbl) || lbl.toLowerCase() === "subagent") return;
    let byAgent = this.agentLabels.get(sessionId);
    if (!byAgent) {
      byAgent = new Map();
      this.agentLabels.set(sessionId, byAgent);
    }
    byAgent.set(aid, lbl);
  }

  getAgentLabel(sessionId: string, agentId: string): string | undefined {
    const aid = agentId?.trim();
    if (!aid) return undefined;
    const direct = this.agentLabels.get(sessionId)?.get(aid);
    if (direct && !isOpaqueAgentId(direct)) return direct;
    const mapping = this.subagentToParent.get(aid);
    if (mapping && mapping.parentSessionId === sessionId) {
      const mLbl = (mapping.agentLabel ?? mapping.agentType)?.trim();
      if (mLbl && !isOpaqueAgentId(mLbl) && mLbl.toLowerCase() !== "subagent") {
        return mLbl;
      }
    }
    return undefined;
  }

  private recordTranscriptPath(
    sessionId: string,
    agentId: string,
    transcriptPath: string | undefined,
    agentLabel?: string,
  ): void {
    const targetKey = agentId && agentId.trim() ? agentId.trim() : "root";
    if (agentLabel) {
      this.recordAgentLabel(sessionId, targetKey, agentLabel);
    }
    if (!isValidTranscriptPathSyntax(transcriptPath)) return;
    const tp = transcriptPath.trim();
    let set = this.sessionTranscriptPaths.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionTranscriptPaths.set(sessionId, set);
    }
    if (!set.has(tp)) {
      if (set.size >= MAX_TRANSCRIPT_PATHS_PER_SESSION) return;
      set.add(tp);
    }
    let byAgent = this.agentTranscriptPaths.get(sessionId);
    if (!byAgent) {
      byAgent = new Map();
      this.agentTranscriptPaths.set(sessionId, byAgent);
    }
    if (
      !byAgent.has(targetKey) &&
      byAgent.size >= MAX_TRANSCRIPT_PATHS_PER_SESSION
    ) {
      return;
    }
    byAgent.set(targetKey, tp);
  }

  private migrateOrphanSession(
    orphanSessionId: string,
    mapping: SubagentParentMapping,
  ): void {
    if (!orphanSessionId || orphanSessionId === mapping.parentSessionId) return;
    const orphanEvents = this.sessions.get(orphanSessionId);
    const orphanPaths = this.sessionTranscriptPaths.get(orphanSessionId);
    const orphanAgentPaths = this.agentTranscriptPaths.get(orphanSessionId);

    const mappingLabel = (mapping.agentLabel ?? mapping.agentType)?.trim();
    const cleanMappingLabel =
      mappingLabel &&
      !isOpaqueAgentId(mappingLabel) &&
      mappingLabel.toLowerCase() !== "subagent"
        ? mappingLabel
        : undefined;
    if (cleanMappingLabel) {
      this.recordAgentLabel(
        mapping.parentSessionId,
        mapping.agentId,
        cleanMappingLabel,
      );
    }

    if (orphanEvents && orphanEvents.length > 0) {
      let parentList = this.sessions.get(mapping.parentSessionId);
      let parentIds = this.seenIds.get(mapping.parentSessionId);
      if (!parentList || !parentIds) {
        parentList = [];
        parentIds = new Set();
        this.sessions.set(mapping.parentSessionId, parentList);
        this.seenIds.set(mapping.parentSessionId, parentIds);
      }

      for (const oldEv of orphanEvents) {
        if (parentIds.has(oldEv.id)) continue;
        const body = this.bodyStore.get(orphanSessionId, oldEv.id);
        if (body && !this.bodyStore.has(mapping.parentSessionId, oldEv.id)) {
          this.bodyStore.set(mapping.parentSessionId, oldEv.id, body.body);
        }

        const coercedKind =
          oldEv.kind === "user_input" ? "thinking_start" : oldEv.kind;
        const coercedSummary =
          oldEv.kind === "user_input"
            ? oldEv.summary.replace(/^Human:\s*/i, "").trim() || "Starting task…"
            : oldEv.summary;
        const existingLbl =
          oldEv.agentLabel && !isOpaqueAgentId(oldEv.agentLabel)
            ? oldEv.agentLabel
            : undefined;
        const resolvedMigratedLabel = existingLbl || cleanMappingLabel;
        if (resolvedMigratedLabel) {
          this.recordAgentLabel(
            mapping.parentSessionId,
            mapping.agentId,
            resolvedMigratedLabel,
          );
        }
        const migrated: EnrichedEvent = {
          ...oldEv,
          kind: coercedKind,
          summary: coercedSummary,
          sessionId: mapping.parentSessionId,
          agentId: mapping.agentId,
          parentAgentId: "root",
          ...(resolvedMigratedLabel ? { agentLabel: resolvedMigratedLabel } : {}),
          mergeKey: computeMergeKey({
            sessionId: mapping.parentSessionId,
            agentId: mapping.agentId,
            kind: coercedKind,
            toolCallId: oldEv.toolCallId,
            toolName: oldEv.toolName,
            epoch: oldEv.epoch,
          }),
        };
        if (!resolvedMigratedLabel) {
          delete migrated.agentLabel;
        }
        parentList.push(migrated);
        parentIds.add(migrated.id);
      }

      parentList.sort((a, b) => a.epoch - b.epoch);
      while (parentList.length > MAX_EVENTS_PER_SESSION) {
        const evicted = parentList.shift();
        if (evicted) {
          parentIds.delete(evicted.id);
        }
      }
    }

    if (orphanPaths) {
      for (const tp of orphanPaths) {
        this.recordTranscriptPath(
          mapping.parentSessionId,
          mapping.agentId,
          tp,
          cleanMappingLabel,
        );
      }
    }
    if (orphanAgentPaths) {
      for (const tp of orphanAgentPaths.values()) {
        this.recordTranscriptPath(
          mapping.parentSessionId,
          mapping.agentId,
          tp,
          cleanMappingLabel,
        );
      }
    }

    this.sessions.delete(orphanSessionId);
    this.seenIds.delete(orphanSessionId);
    this.sessionTranscriptPaths.delete(orphanSessionId);
    this.agentTranscriptPaths.delete(orphanSessionId);
    this.agentLabels.delete(orphanSessionId);

    const orphanPrefix = `${orphanSessionId}\u001f`;
    const targetKey = this.contextTrackerKey(
      mapping.parentSessionId,
      mapping.agentId,
    );
    for (const [k, orphanState] of [...this.contextTrackers.entries()]) {
      if (!k.startsWith(orphanPrefix)) continue;
      const existing = this.contextTrackers.get(targetKey);
      if (existing) {
        existing.contextTokens = Math.max(
          existing.contextTokens,
          orphanState.contextTokens,
        );
        existing.contextWindow ??= orphanState.contextWindow;
        existing.model ??= orphanState.model;
        existing.ide ??= orphanState.ide;
        if (
          CONTEXT_BAND_RANK[orphanState.lastAdvisedBand] >
          CONTEXT_BAND_RANK[existing.lastAdvisedBand]
        ) {
          existing.lastAdvisedBand = orphanState.lastAdvisedBand;
        }
        existing.updatedAtMs = Math.max(
          existing.updatedAtMs,
          orphanState.updatedAtMs,
        );
        this.setContextTracker(targetKey, existing);
      } else {
        this.setContextTracker(targetKey, { ...orphanState });
      }
      this.contextTrackers.delete(k);
    }
  }

  private extractCopilotSubagentLabels(ev: EnrichedEvent): {
    label?: string;
    normLabels: string[];
  } {
    const rawCandidates = [
      ev.agentLabel,
      typeof ev.payload?.agentLabel === "string" ? ev.payload.agentLabel : undefined,
      typeof ev.payload?.agentType === "string" ? ev.payload.agentType : undefined,
      typeof ev.payload?.agentName === "string" ? ev.payload.agentName : undefined,
    ];
    const cleanCandidates: string[] = [];
    const normLabels: string[] = [];
    for (const raw of rawCandidates) {
      const trimmed = raw?.trim();
      if (!trimmed || isOpaqueAgentId(trimmed)) continue;
      if (trimmed.toLowerCase() === "subagent") continue;
      if (!cleanCandidates.includes(trimmed)) cleanCandidates.push(trimmed);
      const norm = normalizeSubagentLabel(trimmed);
      if (norm && norm !== "subagent" && !normLabels.includes(norm)) {
        normLabels.push(norm);
      }
    }
    return {
      label: cleanCandidates[0],
      normLabels,
    };
  }

  private setBoundedMapEntry<K, V>(
    map: Map<K, V>,
    key: K,
    value: V,
    maxEntries = MAX_CORRELATION_ENTRIES,
  ): void {
    if (map.has(key)) {
      map.delete(key);
    }
    map.set(key, value);
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private recordCopilotUuidMapping(
    sessionId: string,
    uuid: string,
    spawnId: string,
    label?: string,
  ): void {
    let byUuid = this.copilotUuidToSpawn.get(sessionId);
    if (!byUuid) {
      byUuid = new Map();
    }
    this.setBoundedMapEntry(byUuid, uuid, { spawnId, label });
    this.setBoundedMapEntry(this.copilotUuidToSpawn, sessionId, byUuid);
    this.setBoundedMapEntry(this.subagentToParent, uuid, {
      parentSessionId: sessionId,
      agentId: spawnId,
      ...(label ? { agentLabel: label, agentType: label } : {}),
    });
    if (label) {
      this.recordAgentLabel(sessionId, spawnId, label);
    }
  }

  private migrateCopilotUuidEvents(
    sessionId: string,
    uuid: string,
    spawnId: string,
    label?: string,
  ): void {
    const list = this.sessions.get(sessionId);
    if (list) {
      for (const oldEv of list) {
        let changed = false;
        if (oldEv.agentId === uuid) {
          oldEv.agentId = spawnId;
          oldEv.parentAgentId = oldEv.parentAgentId || "root";
          if (label && (!oldEv.agentLabel || isOpaqueAgentId(oldEv.agentLabel))) {
            oldEv.agentLabel = label;
          }
          changed = true;
        }
        if (oldEv.targetAgentId === uuid) {
          oldEv.targetAgentId = spawnId;
          if (label && oldEv.payload && !oldEv.payload.agentLabel) {
            oldEv.payload = { ...oldEv.payload, agentLabel: label };
          }
          changed = true;
        }
        if (changed) {
          oldEv.mergeKey = computeMergeKey({
            sessionId: oldEv.sessionId,
            agentId: oldEv.agentId,
            kind: oldEv.kind,
            toolCallId: oldEv.toolCallId,
            toolName: oldEv.toolName,
            epoch: oldEv.epoch,
          });
        }
      }
    }

    const byAgentPaths = this.agentTranscriptPaths.get(sessionId);
    if (byAgentPaths && byAgentPaths.has(uuid)) {
      const tp = byAgentPaths.get(uuid)!;
      byAgentPaths.delete(uuid);
      if (!byAgentPaths.has(spawnId)) {
        byAgentPaths.set(spawnId, tp);
      }
    }

    const oldCtxKey = this.contextTrackerKey(sessionId, uuid);
    const oldCtx = this.contextTrackers.get(oldCtxKey);
    if (oldCtx) {
      const targetKey = this.contextTrackerKey(sessionId, spawnId);
      const existing = this.contextTrackers.get(targetKey);
      if (existing) {
        existing.contextTokens = Math.max(
          existing.contextTokens,
          oldCtx.contextTokens,
        );
        existing.contextWindow ??= oldCtx.contextWindow;
        existing.model ??= oldCtx.model;
        existing.ide ??= oldCtx.ide;
        this.setContextTracker(targetKey, existing);
      } else {
        this.setContextTracker(targetKey, { ...oldCtx });
      }
      this.contextTrackers.delete(oldCtxKey);
    }
  }

  ingest(rawItems: unknown[]): IngestResult {
    let accepted = 0;
    let deduped = 0;
    const acceptedEvents: EnrichedEvent[] = [];

    for (const raw of rawItems) {
      const ev = coerceToEnrichedEvent(raw);
      const rawBody = extractRawBodyText(raw);

      // Re-home events belonging to a known subagent session (or carrying explicit parentSessionId)
      const originalSessionId = ev.sessionId;
      const directMapping = this.subagentToParent.get(originalSessionId);
      const agentMapping =
        !directMapping && ev.agentId !== "root"
          ? this.subagentToParent.get(ev.agentId)
          : undefined;
      const parentMapping =
        directMapping ??
        (agentMapping && ev.sessionId !== agentMapping.parentSessionId
          ? agentMapping
          : undefined);
      const explicitParentSid =
        typeof ev.payload?.parentSessionId === "string" &&
        ev.payload.parentSessionId.trim() &&
        ev.payload.parentSessionId.trim() !== originalSessionId
          ? ev.payload.parentSessionId.trim()
          : undefined;

      if (parentMapping) {
        if (ev.kind === "user_input") {
          ev.kind = "thinking_start";
          ev.summary =
            ev.summary.replace(/^Human:\s*/i, "").trim() || "Starting task…";
        }
        ev.sessionId = parentMapping.parentSessionId;
        ev.agentId = parentMapping.agentId;
        ev.parentAgentId = "root";
        const curLbl =
          ev.agentLabel && !isOpaqueAgentId(ev.agentLabel)
            ? ev.agentLabel
            : undefined;
        const inherited =
          (parentMapping.agentLabel ?? parentMapping.agentType)?.trim();
        ev.agentLabel =
          curLbl ||
          (inherited && !isOpaqueAgentId(inherited) ? inherited : undefined);
        ev.mergeKey = computeMergeKey({
          sessionId: ev.sessionId,
          agentId: ev.agentId,
          kind: ev.kind,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          epoch: ev.epoch,
        });
      } else if (agentMapping && ev.sessionId === agentMapping.parentSessionId) {
        ev.parentAgentId = ev.parentAgentId || "root";
        const inherited =
          (agentMapping.agentLabel ?? agentMapping.agentType)?.trim();
        if (
          inherited &&
          !isOpaqueAgentId(inherited) &&
          (!ev.agentLabel ||
            isOpaqueAgentId(ev.agentLabel) ||
            ev.agentLabel.trim().toLowerCase() === "subagent")
        ) {
          ev.agentLabel = inherited;
        }
      } else if (explicitParentSid) {
        const payloadAgentId =
          typeof ev.payload?.agentId === "string" &&
          ev.payload.agentId.trim() &&
          ev.payload.agentId.trim() !== "root"
            ? ev.payload.agentId.trim()
            : undefined;
        const resolvedAgentId =
          ev.agentId !== "root"
            ? ev.agentId
            : payloadAgentId ?? originalSessionId;
        const rawEvLbl =
          ev.agentLabel && !isOpaqueAgentId(ev.agentLabel)
            ? ev.agentLabel
            : undefined;
        const rawPayloadLbl =
          typeof ev.payload?.agentLabel === "string" &&
          ev.payload.agentLabel.trim() &&
          !isOpaqueAgentId(ev.payload.agentLabel.trim())
            ? ev.payload.agentLabel.trim()
            : undefined;
        const resolvedType =
          typeof ev.payload?.agentType === "string" &&
          ev.payload.agentType.trim() &&
          !isOpaqueAgentId(ev.payload.agentType.trim())
            ? ev.payload.agentType.trim()
            : undefined;
        const resolvedLabel = rawEvLbl || rawPayloadLbl || resolvedType;
        if (ev.kind === "user_input") {
          ev.kind = "thinking_start";
          ev.summary =
            ev.summary.replace(/^Human:\s*/i, "").trim() || "Starting task…";
        }
        ev.sessionId = explicitParentSid;
        ev.agentId = resolvedAgentId;
        ev.parentAgentId = "root";
        ev.agentLabel = resolvedLabel;
        ev.mergeKey = computeMergeKey({
          sessionId: ev.sessionId,
          agentId: ev.agentId,
          kind: ev.kind,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          epoch: ev.epoch,
        });
        if (
          originalSessionId &&
          originalSessionId !== "root" &&
          originalSessionId !== "subagent" &&
          originalSessionId !== "default"
        ) {
          const memoized: SubagentParentMapping = {
            parentSessionId: explicitParentSid,
            agentId: resolvedAgentId,
            agentLabel: resolvedLabel,
            agentType: resolvedType,
          };
          this.setBoundedMapEntry(this.subagentToParent, originalSessionId, memoized);
          this.migrateOrphanSession(originalSessionId, memoized);
        }
      }

      if (ev.agentLabel && isOpaqueAgentId(ev.agentLabel)) {
        delete ev.agentLabel;
      }
      if (ev.agentId !== "root") {
        const knownLbl =
          (ev.agentLabel && !isOpaqueAgentId(ev.agentLabel)
            ? ev.agentLabel
            : undefined) ??
          (typeof ev.payload?.agentLabel === "string" &&
          ev.payload.agentLabel.trim() &&
          !isOpaqueAgentId(ev.payload.agentLabel.trim())
            ? ev.payload.agentLabel.trim()
            : undefined) ??
          (typeof ev.payload?.agentType === "string" &&
          ev.payload.agentType.trim() &&
          !isOpaqueAgentId(ev.payload.agentType.trim())
            ? ev.payload.agentType.trim()
            : undefined);
        if (knownLbl) {
          this.recordAgentLabel(ev.sessionId, ev.agentId, knownLbl);
          if (!ev.agentLabel) ev.agentLabel = knownLbl;
        } else {
          const prevKnown = this.getAgentLabel(ev.sessionId, ev.agentId);
          if (prevKnown) ev.agentLabel = prevKnown;
        }
      }

      // Correlate Copilot label-only subagentStart (no agentId) with UUID child/subagentStop events
      if (ev.kind === "subagent_spawn" && ev.targetAgentId) {
        const hasExplicitPayloadUuid =
          typeof ev.payload?.agentId === "string" &&
          Boolean(ev.payload.agentId.trim());
        if (
          ev.targetAgentId !== "root" &&
          ev.targetAgentId !== "subagent" &&
          !isOpaqueAgentId(ev.targetAgentId) &&
          !hasExplicitPayloadUuid
        ) {
          const { label, normLabels } = this.extractCopilotSubagentLabels(ev);
          const spawnNorms =
            normLabels.length > 0
              ? normLabels
              : [normalizeSubagentLabel(ev.targetAgentId)].filter(Boolean);
          const openQueue = this.openUnlinkedSpawns.get(ev.sessionId) ?? [];
          let spawnId = ev.targetAgentId;
          if (openQueue.some((e) => e.spawnId === spawnId)) {
            let suffix = 2;
            while (openQueue.some((e) => e.spawnId === `${ev.targetAgentId}-${suffix}`)) {
              suffix++;
            }
            spawnId = `${ev.targetAgentId}-${suffix}`;
            ev.targetAgentId = spawnId;
            ev.id = computeDeterministicEventId({
              ide: ev.ide,
              sessionId: ev.sessionId,
              agentId: ev.agentId,
              kind: ev.kind,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              targetAgentId: ev.targetAgentId,
              epoch: ev.epoch,
              summary: ev.summary,
            });
            ev.mergeKey = computeMergeKey({
              sessionId: ev.sessionId,
              agentId: ev.agentId,
              kind: ev.kind,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              epoch: ev.epoch,
            });
          }

          const pendingQueue = this.pendingUnlinkedUuids.get(ev.sessionId);
          let matchedPendingIdx = -1;
          if (pendingQueue && pendingQueue.length > 0) {
            matchedPendingIdx = pendingQueue.findIndex(
              (p) =>
                Math.abs(ev.epoch - p.epoch) <= 120 &&
                (p.normLabels.some((nl) => spawnNorms.includes(nl)) ||
                  (p.normLabels.length === 0 && pendingQueue.length === 1)),
            );
          }
          if (pendingQueue && matchedPendingIdx >= 0) {
            const [pending] = pendingQueue.splice(matchedPendingIdx, 1);
            if (pendingQueue.length === 0) {
              this.pendingUnlinkedUuids.delete(ev.sessionId);
            }
            if (pending) {
              const resolvedLbl = label || pending.label;
              this.recordCopilotUuidMapping(
                ev.sessionId,
                pending.uuid,
                spawnId,
                resolvedLbl,
              );
              this.migrateCopilotUuidEvents(
                ev.sessionId,
                pending.uuid,
                spawnId,
                resolvedLbl,
              );
              if (!pending.hasDone) {
                openQueue.push({
                  spawnId,
                  normLabels: spawnNorms,
                  label: resolvedLbl,
                  epoch: ev.epoch,
                  linkedUuid: pending.uuid,
                });
                this.setBoundedMapEntry(
                  this.openUnlinkedSpawns,
                  ev.sessionId,
                  openQueue,
                );
              }
            }
          } else {
            openQueue.push({
              spawnId,
              normLabels: spawnNorms,
              label,
              epoch: ev.epoch,
            });
            this.setBoundedMapEntry(
              this.openUnlinkedSpawns,
              ev.sessionId,
              openQueue,
            );
          }
        }
      } else if (
        ev.agentId !== "root" &&
        isOpaqueAgentId(ev.agentId) &&
        ev.ide === "copilot-vscode"
      ) {
        const existingMap = this.copilotUuidToSpawn
          .get(ev.sessionId)
          ?.get(ev.agentId);
        if (existingMap) {
          ev.agentId = existingMap.spawnId;
          ev.parentAgentId = ev.parentAgentId || "root";
          if (existingMap.label && (!ev.agentLabel || isOpaqueAgentId(ev.agentLabel))) {
            ev.agentLabel = existingMap.label;
          }
          ev.mergeKey = computeMergeKey({
            sessionId: ev.sessionId,
            agentId: ev.agentId,
            kind: ev.kind,
            toolCallId: ev.toolCallId,
            toolName: ev.toolName,
            epoch: ev.epoch,
          });
        } else {
          const openQueue = this.openUnlinkedSpawns.get(ev.sessionId);
          const { label, normLabels } = this.extractCopilotSubagentLabels(ev);
          const match = openQueue?.find(
            (entry) =>
              (!entry.linkedUuid || entry.linkedUuid === ev.agentId) &&
              (normLabels.length > 0
                ? normLabels.some((nl) => entry.normLabels.includes(nl))
                : openQueue.length === 1),
          );
          if (match) {
            match.linkedUuid = ev.agentId;
            const resolvedLbl = match.label || label;
            this.recordCopilotUuidMapping(
              ev.sessionId,
              ev.agentId,
              match.spawnId,
              resolvedLbl,
            );
            ev.agentId = match.spawnId;
            ev.parentAgentId = ev.parentAgentId || "root";
            if (resolvedLbl && (!ev.agentLabel || isOpaqueAgentId(ev.agentLabel))) {
              ev.agentLabel = resolvedLbl;
            }
            ev.mergeKey = computeMergeKey({
              sessionId: ev.sessionId,
              agentId: ev.agentId,
              kind: ev.kind,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              epoch: ev.epoch,
            });
          } else {
            const pQueue = this.pendingUnlinkedUuids.get(ev.sessionId) ?? [];
            const prevPending = pQueue.find((p) => p.uuid === ev.agentId);
            if (prevPending) {
              if (!prevPending.label && label) prevPending.label = label;
              for (const nl of normLabels) {
                if (!prevPending.normLabels.includes(nl)) {
                  prevPending.normLabels.push(nl);
                }
              }
              this.setBoundedMapEntry(
                this.pendingUnlinkedUuids,
                ev.sessionId,
                pQueue,
              );
            } else {
              pQueue.push({
                uuid: ev.agentId,
                normLabels,
                label,
                epoch: ev.epoch,
              });
              this.setBoundedMapEntry(
                this.pendingUnlinkedUuids,
                ev.sessionId,
                pQueue,
              );
            }
          }
        }
      } else if (
        ev.kind === "subagent_done" &&
        ev.targetAgentId &&
        ev.targetAgentId !== "root" &&
        ev.targetAgentId !== "subagent"
      ) {
        const openQueue = this.openUnlinkedSpawns.get(ev.sessionId);
        if (isOpaqueAgentId(ev.targetAgentId)) {
          const uuid = ev.targetAgentId;
          const existingMap = this.copilotUuidToSpawn
            .get(ev.sessionId)
            ?.get(uuid);
          if (existingMap) {
            ev.targetAgentId = existingMap.spawnId;
            if (existingMap.label && ev.payload && !ev.payload.agentLabel) {
              ev.payload = { ...ev.payload, agentLabel: existingMap.label };
            }
            ev.mergeKey = computeMergeKey({
              sessionId: ev.sessionId,
              agentId: ev.agentId,
              kind: ev.kind,
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              epoch: ev.epoch,
            });
            if (openQueue) {
              const qIdx = openQueue.findIndex(
                (e) => e.spawnId === existingMap.spawnId,
              );
              if (qIdx >= 0) openQueue.splice(qIdx, 1);
              if (openQueue.length === 0) {
                this.openUnlinkedSpawns.delete(ev.sessionId);
              }
            }
          } else if (openQueue && openQueue.length > 0) {
            const { label, normLabels } = this.extractCopilotSubagentLabels(ev);
            const qIdx = openQueue.findIndex(
              (entry) =>
                (!entry.linkedUuid || entry.linkedUuid === uuid) &&
                (normLabels.length > 0
                  ? normLabels.some((nl) => entry.normLabels.includes(nl))
                  : openQueue.length === 1),
            );
            if (qIdx >= 0) {
              const [entry] = openQueue.splice(qIdx, 1);
              if (openQueue.length === 0) {
                this.openUnlinkedSpawns.delete(ev.sessionId);
              }
              if (entry) {
                const resolvedLbl = entry.label || label;
                this.recordCopilotUuidMapping(
                  ev.sessionId,
                  uuid,
                  entry.spawnId,
                  resolvedLbl,
                );
                ev.targetAgentId = entry.spawnId;
                if (resolvedLbl && ev.payload && !ev.payload.agentLabel) {
                  ev.payload = { ...ev.payload, agentLabel: resolvedLbl };
                }
                ev.mergeKey = computeMergeKey({
                  sessionId: ev.sessionId,
                  agentId: ev.agentId,
                  kind: ev.kind,
                  toolCallId: ev.toolCallId,
                  toolName: ev.toolName,
                  epoch: ev.epoch,
                });
              }
            }
          } else if (ev.ide === "copilot-vscode") {
            const { label, normLabels } = this.extractCopilotSubagentLabels(ev);
            const pQueue = this.pendingUnlinkedUuids.get(ev.sessionId) ?? [];
            const prevPending = pQueue.find((p) => p.uuid === uuid);
            if (prevPending) {
              prevPending.hasDone = true;
              if (!prevPending.label && label) prevPending.label = label;
              for (const nl of normLabels) {
                if (!prevPending.normLabels.includes(nl)) {
                  prevPending.normLabels.push(nl);
                }
              }
              this.setBoundedMapEntry(
                this.pendingUnlinkedUuids,
                ev.sessionId,
                pQueue,
              );
            } else {
              pQueue.push({
                uuid,
                normLabels,
                label,
                epoch: ev.epoch,
                hasDone: true,
              });
              this.setBoundedMapEntry(
                this.pendingUnlinkedUuids,
                ev.sessionId,
                pQueue,
              );
            }
          }
        } else if (openQueue && openQueue.length > 0) {
          const qIdx = openQueue.findIndex((e) => e.spawnId === ev.targetAgentId);
          if (qIdx >= 0) {
            openQueue.splice(qIdx, 1);
            if (openQueue.length === 0) {
              this.openUnlinkedSpawns.delete(ev.sessionId);
            }
          }
        }
      }

      // Register subagent-to-parent mapping on subagent_spawn and re-home any out-of-order orphan session
      if (ev.kind === "subagent_spawn" && ev.targetAgentId) {
        const rawSubId =
          typeof ev.payload?.agentId === "string" && ev.payload.agentId.trim()
            ? ev.payload.agentId.trim()
            : undefined;
        const rawType =
          typeof ev.payload?.agentType === "string" &&
          ev.payload.agentType.trim()
            ? ev.payload.agentType.trim()
            : undefined;
        const rawLabel =
          typeof ev.payload?.agentLabel === "string" &&
          ev.payload.agentLabel.trim()
            ? ev.payload.agentLabel.trim()
            : undefined;
        const agentType =
          rawType && !isOpaqueAgentId(rawType) ? rawType : undefined;
        const agentLabel =
          (rawLabel && !isOpaqueAgentId(rawLabel) ? rawLabel : undefined) ??
          agentType;
        const mapping: SubagentParentMapping = {
          parentSessionId: ev.sessionId,
          agentId: ev.targetAgentId,
          agentLabel,
          agentType,
        };
        if (ev.targetAgentId !== "subagent" && ev.targetAgentId !== "root") {
          this.setBoundedMapEntry(
            this.subagentToParent,
            ev.targetAgentId,
            mapping,
          );
          this.recordAgentLabel(ev.sessionId, ev.targetAgentId, agentLabel);
          this.migrateOrphanSession(ev.targetAgentId, mapping);
        }
        if (
          rawSubId &&
          rawSubId !== ev.targetAgentId &&
          rawSubId !== "subagent" &&
          rawSubId !== "root"
        ) {
          this.setBoundedMapEntry(this.subagentToParent, rawSubId, mapping);
          this.recordAgentLabel(ev.sessionId, rawSubId, agentLabel);
          this.migrateOrphanSession(rawSubId, mapping);
        }
        if (agentLabel && agentLabel.toLowerCase() !== "subagent") {
          for (const existing of this.sessions.get(ev.sessionId) ?? []) {
            if (
              (existing.agentId === ev.targetAgentId ||
                (rawSubId && existing.agentId === rawSubId)) &&
              (!existing.agentLabel ||
                isOpaqueAgentId(existing.agentLabel) ||
                existing.agentLabel.trim().toLowerCase() === "subagent")
            ) {
              existing.agentLabel = agentLabel;
            }
          }
        }
      }

      if (
        (ev.kind === "subagent_spawn" || ev.kind === "subagent_done") &&
        ev.targetAgentId
      ) {
        const targetLbl =
          (typeof ev.payload?.agentLabel === "string" &&
          ev.payload.agentLabel.trim() &&
          !isOpaqueAgentId(ev.payload.agentLabel.trim())
            ? ev.payload.agentLabel.trim()
            : undefined) ??
          (typeof ev.payload?.agentType === "string" &&
          ev.payload.agentType.trim() &&
          !isOpaqueAgentId(ev.payload.agentType.trim())
            ? ev.payload.agentType.trim()
            : undefined) ??
          this.getAgentLabel(ev.sessionId, ev.targetAgentId);
        if (targetLbl) {
          this.recordAgentLabel(ev.sessionId, ev.targetAgentId, targetLbl);
        }
        if (typeof ev.payload?.agentTranscriptPath === "string") {
          this.recordTranscriptPath(
            ev.sessionId,
            ev.targetAgentId,
            ev.payload.agentTranscriptPath,
            targetLbl,
          );
        }
      }

      if (typeof ev.payload?.transcriptPath === "string") {
        this.recordTranscriptPath(
          ev.sessionId,
          ev.agentId,
          ev.payload.transcriptPath,
          ev.agentLabel,
        );
      }

      let list = this.sessions.get(ev.sessionId);
      let ids = this.seenIds.get(ev.sessionId);
      if (!list || !ids) {
        list = [];
        ids = new Set();
        this.sessions.set(ev.sessionId, list);
        this.seenIds.set(ev.sessionId, ids);
      }

      if (rawBody !== undefined && !this.bodyStore.has(ev.sessionId, ev.id)) {
        this.bodyStore.set(ev.sessionId, ev.id, rawBody);
      }

      if (ids.has(ev.id)) {
        deduped += 1;
        continue;
      }

      if (rawBody !== undefined) {
        this.bodyStore.set(ev.sessionId, ev.id, rawBody);
      }

      list.push(ev);
      ids.add(ev.id);

      // Enforce ring-buffer cap
      while (list.length > MAX_EVENTS_PER_SESSION) {
        const evicted = list.shift();
        if (evicted) {
          ids.delete(evicted.id);
        }
      }

      accepted += 1;
      acceptedEvents.push(ev);
      this.recordEventContextUsage(ev);
    }

    if (acceptedEvents.length > 0) {
      this.emit("ingest", acceptedEvents);
    }

    return { accepted, deduped, events: acceptedEvents };
  }

  getSessionEvents(sessionId: string): EnrichedEvent[] {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  getAllSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  private contextTrackerKey(sessionId: string, agentId: string): string {
    return `${sessionId}\u001f${agentId || "root"}`;
  }

  private setContextTracker(key: string, state: AgentContextTrackerState): void {
    if (this.contextTrackers.has(key)) {
      this.contextTrackers.delete(key);
    }
    this.contextTrackers.set(key, state);
    while (this.contextTrackers.size > MAX_CONTEXT_TRACKERS) {
      const oldest = this.contextTrackers.keys().next().value;
      if (oldest === undefined) break;
      this.contextTrackers.delete(oldest);
    }
  }

  private recordEventContextUsage(ev: EnrichedEvent): void {
    const key = this.contextTrackerKey(ev.sessionId, ev.agentId);
    const existing = this.contextTrackers.get(key) ?? {
      contextTokens: 0,
      lastAdvisedBand: "ok" as ContextBand,
      updatedAtMs: Date.now(),
    };

    const uDelta = ev.usageDelta;
    const rawModel =
      uDelta?.model ??
      (typeof ev.payload?.model === "string" && ev.payload.model.trim()
        ? prettifyModelName(ev.payload.model) || ev.payload.model.trim()
        : undefined);
    if (rawModel) {
      existing.model = rawModel;
    }
    if (ev.ide && ev.ide !== "unknown") {
      existing.ide = ev.ide;
    }
    if (
      typeof uDelta?.contextWindow === "number" &&
      Number.isFinite(uDelta.contextWindow) &&
      uDelta.contextWindow > 0
    ) {
      existing.contextWindow = Math.round(uDelta.contextWindow);
    }
    if (uDelta) {
      const ctxTok =
        typeof uDelta.contextTokens === "number" &&
        Number.isFinite(uDelta.contextTokens)
          ? Math.round(uDelta.contextTokens)
          : typeof uDelta.inputTokens === "number"
            ? Math.round(
                uDelta.inputTokens +
                  (uDelta.cachedTokens ?? 0) +
                  (uDelta.outputTokens ?? 0),
              )
            : undefined;
      if (ctxTok !== undefined && ctxTok >= 0) {
        existing.contextTokens = ctxTok;
      }
    }
    existing.updatedAtMs = Date.now();
    this.setContextTracker(key, existing);
  }

  getAgentContextState(
    sessionId: string,
    agentId = "root",
  ): AgentContextTrackerState | undefined {
    const entry = this.contextTrackers.get(
      this.contextTrackerKey(sessionId, agentId),
    );
    return entry ? { ...entry } : undefined;
  }

  markDeferredPreCompactAdvisory(sessionId: string, agentId = "root"): void {
    const key = this.contextTrackerKey(sessionId, agentId);
    const entry = this.contextTrackers.get(key);
    if (entry) {
      entry.pendingDeferredAdvisory = true;
      this.setContextTracker(key, entry);
    }
  }

  consumeDeferredPreCompactAdvisory(
    sessionId: string,
    agentId = "root",
  ): boolean {
    const key = this.contextTrackerKey(sessionId, agentId);
    const entry = this.contextTrackers.get(key);
    if (!entry?.pendingDeferredAdvisory) return false;
    entry.pendingDeferredAdvisory = false;
    this.setContextTracker(key, entry);
    return true;
  }

  evaluateContextAdvisory(params: {
    sessionId: string;
    agentId?: string;
    ide?: IdeSource;
    model?: string;
    contextTokens?: number;
    contextWindow?: number;
    isPreCompact?: boolean;
    thresholds?: Partial<ContextThresholdConfig>;
    modelContextWindows?: Record<string, number>;
  }): ContextAdvisory | null {
    const agentId = params.agentId?.trim() || "root";
    const key = this.contextTrackerKey(params.sessionId, agentId);
    const tracker = this.contextTrackers.get(key) ?? {
      contextTokens: 0,
      lastAdvisedBand: "ok" as ContextBand,
      updatedAtMs: Date.now(),
    };

    const warnPercent =
      params.thresholds?.warnPercent ?? DEFAULT_CONTEXT_THRESHOLDS.warnPercent;
    const handoffPercent =
      params.thresholds?.handoffPercent ??
      DEFAULT_CONTEXT_THRESHOLDS.handoffPercent;
    const compactPercent =
      params.thresholds?.compactPercent ??
      DEFAULT_CONTEXT_THRESHOLDS.compactPercent;

    const model = params.model ?? tracker.model ?? "unknown";
    const ide = params.ide ?? tracker.ide;
    const contextTokens = Math.max(
      0,
      Math.round(params.contextTokens ?? tracker.contextTokens ?? 0),
    );
    const contextWindow =
      (typeof params.contextWindow === "number" &&
      Number.isFinite(params.contextWindow) &&
      params.contextWindow > 0
        ? Math.round(params.contextWindow)
        : undefined) ??
      tracker.contextWindow ??
      lookupModelContextWindow(model, params.modelContextWindows) ??
      inferContextWindow(model, ide);

    const rawPct = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
    const contextPercent = Math.min(100, Math.round(rawPct * 10) / 10);

    let band: ContextBand = "ok";
    if (params.isPreCompact || contextPercent >= compactPercent) {
      band = "compact";
    } else if (contextPercent >= handoffPercent) {
      band = "handoff";
    } else if (contextPercent >= warnPercent) {
      band = "warn";
    }

    tracker.contextTokens = Math.max(tracker.contextTokens, contextTokens);
    tracker.contextWindow = contextWindow;
    if (model && model !== "unknown") tracker.model = model;
    if (ide && ide !== "unknown") tracker.ide = ide;
    tracker.updatedAtMs = Date.now();

    if (band === "ok") {
      // Allow re-advising if a session genuinely compacted back well below warnPercent.
      if (contextPercent < Math.max(0, warnPercent - 5)) {
        tracker.lastAdvisedBand = "ok";
      }
      this.setContextTracker(key, tracker);
      return null;
    }

    const shouldEmit =
      Boolean(params.isPreCompact) ||
      CONTEXT_BAND_RANK[band] > CONTEXT_BAND_RANK[tracker.lastAdvisedBand];

    if (!shouldEmit) {
      this.setContextTracker(key, tracker);
      return null;
    }

    if (CONTEXT_BAND_RANK[band] > CONTEXT_BAND_RANK[tracker.lastAdvisedBand]) {
      tracker.lastAdvisedBand = band;
    }
    this.setContextTracker(key, tracker);

    return {
      band,
      sessionId: params.sessionId,
      agentId,
      contextTokens,
      contextWindow,
      contextPercent,
      ...(model && model !== "unknown" ? { model } : {}),
      ...(params.isPreCompact ? { isPreCompact: true } : {}),
      message: buildContextAdvisoryMessage({
        band,
        contextPercent,
        contextWindow,
        handoffPercent,
        isPreCompact: params.isPreCompact,
      }),
    };
  }

  discoverPushSessions(): DiscoveredSession[] {
    const out: DiscoveredSession[] = [];
    for (const [sessionId, evs] of this.sessions.entries()) {
      if (evs.length === 0) continue;
      const last = evs[evs.length - 1]!;
      const first = evs[0]!;
      const ws = evs.find((e) => e.workspacePath)?.workspacePath;
      const pid = evs.find((e) => e.projectId)?.projectId;
      const agents = new Set(evs.map((e) => e.agentId));
      const isMulti =
        agents.size > 1 ||
        evs.some(
          (e) =>
            e.kind === "subagent_spawn" ||
            e.kind === "message" ||
            e.kind === "board_mutation",
        );

      const firstUser = evs.find((e) => e.kind === "user_input");
      const rawPromptTitle = firstUser
        ? (typeof firstUser.payload?.prompt === "string" &&
          firstUser.payload.prompt.trim()
            ? firstUser.payload.prompt
            : typeof firstUser.payload?.body === "string" &&
                firstUser.payload.body.trim()
              ? firstUser.payload.body
              : firstUser.summary.replace(/^Human:\s*/i, ""))
        : undefined;
      const nonSessionStart = evs.find((e) => e.kind !== "session_start");
      const title =
        (rawPromptTitle ? cleanHumanSummary(rawPromptTitle, 80) : "") ||
        cleanHumanSummary(
          (nonSessionStart ?? first).summary,
          80,
        ) ||
        `Live ${sessionId.slice(0, 8)}`;

      out.push({
        ide: first.ide,
        sessionId,
        filePath: ws
          ? path.join(ws, ".agent-studio", "telemetry.jsonl")
          : "",
        workspacePath: ws,
        workspaces: ws ? [ws] : [],
        projectId: pid,
        title,
        mtimeMs: Math.round(last.epoch * 1000),
        sizeBytes: evs.length,
        isMultiAgent: isMulti,
      });
    }
    return out;
  }

  private getWatchedTelemetryFiles(): string[] {
    const paths = new Set<string>();
    try {
      for (const proj of listProjects()) {
        paths.add(path.join(proj.root, ".agent-studio", "telemetry.jsonl"));
      }
    } catch {
      // Registry unreadable; proceed with explicit workspaces.
    }
    for (const ws of this.extraWorkspaces) {
      paths.add(path.join(ws, ".agent-studio", "telemetry.jsonl"));
    }
    if (this.includeGlobalFile) {
      paths.add(path.join(getAgentStudioHome(), "telemetry.jsonl"));
    }
    return [...paths];
  }

  async pollFiles(): Promise<IngestResult> {
    let totalAccepted = 0;
    let totalDeduped = 0;
    const allNew: EnrichedEvent[] = [];

    for (const filePath of this.getWatchedTelemetryFiles()) {
      let st;
      try {
        st = await fs.stat(filePath);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }

      let offset = this.fileOffsets.get(filePath) ?? 0;
      if (st.size < offset) {
        // File was truncated or rotated
        offset = 0;
      }
      if (st.size === offset) continue;

      const bytesToRead = st.size - offset;
      const fh = await fs.open(filePath, "r");
      let chunk = "";
      try {
        const buf = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fh.read(buf, 0, bytesToRead, offset);
        chunk = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }

      // Only consume up to the last complete newline so partial writes wait for next poll
      const lastNl = chunk.lastIndexOf("\n");
      if (lastNl < 0) continue;

      const completePart = chunk.slice(0, lastNl + 1);
      const consumedBytes = Buffer.byteLength(completePart, "utf8");
      this.fileOffsets.set(filePath, offset + consumedBytes);

      const batch: unknown[] = [];
      for (const line of completePart.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          batch.push(JSON.parse(trimmed));
        } catch {
          // Skip corrupt lines.
        }
      }

      if (batch.length > 0) {
        const res = this.ingest(batch);
        totalAccepted += res.accepted;
        totalDeduped += res.deduped;
        allNew.push(...res.events);
      }
    }

    return { accepted: totalAccepted, deduped: totalDeduped, events: allNew };
  }
}
