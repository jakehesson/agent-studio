import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentStudioHome, listProjects } from "../board/registry.js";
import { NormalizedEventSchema } from "../schema/telemetry.js";
import { defaultEventBodyStore, type EventBodyStore } from "./body-store.js";
import {
  cleanHumanSummary,
  computeDeterministicEventId,
  computeMergeKey,
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

export class PushBus extends EventEmitter {
  private readonly sessions = new Map<string, EnrichedEvent[]>();
  private readonly seenIds = new Map<string, Set<string>>();
  private readonly fileOffsets = new Map<string, number>();
  private readonly subagentToParent = new Map<string, SubagentParentMapping>();
  private readonly sessionTranscriptPaths = new Map<string, Set<string>>();
  private readonly agentTranscriptPaths = new Map<string, Map<string, string>>();
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

  private recordTranscriptPath(
    sessionId: string,
    agentId: string,
    transcriptPath: string | undefined,
  ): void {
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
    const targetKey = agentId && agentId.trim() ? agentId.trim() : "root";
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
        const migrated: EnrichedEvent = {
          ...oldEv,
          kind: coercedKind,
          summary: coercedSummary,
          sessionId: mapping.parentSessionId,
          agentId: mapping.agentId,
          parentAgentId: "root",
          agentLabel: oldEv.agentLabel || mapping.agentLabel,
          mergeKey: computeMergeKey({
            sessionId: mapping.parentSessionId,
            agentId: mapping.agentId,
            kind: coercedKind,
            toolCallId: oldEv.toolCallId,
            toolName: oldEv.toolName,
            epoch: oldEv.epoch,
          }),
        };
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
        this.recordTranscriptPath(mapping.parentSessionId, mapping.agentId, tp);
      }
    }
    if (orphanAgentPaths) {
      for (const tp of orphanAgentPaths.values()) {
        this.recordTranscriptPath(mapping.parentSessionId, mapping.agentId, tp);
      }
    }

    this.sessions.delete(orphanSessionId);
    this.seenIds.delete(orphanSessionId);
    this.sessionTranscriptPaths.delete(orphanSessionId);
    this.agentTranscriptPaths.delete(orphanSessionId);
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
        ev.agentLabel = ev.agentLabel || parentMapping.agentLabel;
        ev.mergeKey = computeMergeKey({
          sessionId: ev.sessionId,
          agentId: ev.agentId,
          kind: ev.kind,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          epoch: ev.epoch,
        });
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
        const resolvedLabel =
          ev.agentLabel ||
          (typeof ev.payload?.agentLabel === "string" &&
          ev.payload.agentLabel.trim()
            ? ev.payload.agentLabel.trim()
            : undefined);
        const resolvedType =
          typeof ev.payload?.agentType === "string" &&
          ev.payload.agentType.trim()
            ? ev.payload.agentType.trim()
            : undefined;
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
          this.subagentToParent.set(originalSessionId, memoized);
          this.migrateOrphanSession(originalSessionId, memoized);
        }
      }

      // Register subagent-to-parent mapping on subagent_spawn and re-home any out-of-order orphan session
      if (ev.kind === "subagent_spawn" && ev.targetAgentId) {
        const rawSubId =
          typeof ev.payload?.agentId === "string" && ev.payload.agentId.trim()
            ? ev.payload.agentId.trim()
            : undefined;
        const agentType =
          typeof ev.payload?.agentType === "string" &&
          ev.payload.agentType.trim()
            ? ev.payload.agentType.trim()
            : undefined;
        const agentLabel =
          (typeof ev.payload?.agentLabel === "string" &&
          ev.payload.agentLabel.trim()
            ? ev.payload.agentLabel.trim()
            : undefined) ?? agentType;
        const mapping: SubagentParentMapping = {
          parentSessionId: ev.sessionId,
          agentId: ev.targetAgentId,
          agentLabel,
          agentType,
        };
        if (ev.targetAgentId !== "subagent" && ev.targetAgentId !== "root") {
          this.subagentToParent.set(ev.targetAgentId, mapping);
          this.migrateOrphanSession(ev.targetAgentId, mapping);
        }
        if (
          rawSubId &&
          rawSubId !== ev.targetAgentId &&
          rawSubId !== "subagent" &&
          rawSubId !== "root"
        ) {
          this.subagentToParent.set(rawSubId, mapping);
          this.migrateOrphanSession(rawSubId, mapping);
        }
      }

      if (
        (ev.kind === "subagent_spawn" || ev.kind === "subagent_done") &&
        ev.targetAgentId
      ) {
        if (typeof ev.payload?.agentTranscriptPath === "string") {
          this.recordTranscriptPath(
            ev.sessionId,
            ev.targetAgentId,
            ev.payload.agentTranscriptPath,
          );
        }
      }

      if (typeof ev.payload?.transcriptPath === "string") {
        this.recordTranscriptPath(
          ev.sessionId,
          ev.agentId,
          ev.payload.transcriptPath,
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
