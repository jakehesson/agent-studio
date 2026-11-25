import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentStudioHome, listProjects } from "../board/registry.js";
import { NormalizedEventSchema } from "../schema/telemetry.js";
import {
  computeDeterministicEventId,
  computeMergeKey,
  normalizeWsPath,
  parseEpochSeconds,
  toIsoUtc,
  type DiscoveredSession,
  type EnrichedEvent,
  type TelemetryChannel,
} from "./types.js";

export const MAX_EVENTS_PER_SESSION = 2000;

export interface IngestResult {
  accepted: number;
  deduped: number;
  events: EnrichedEvent[];
}

export interface PushBusOptions {
  extraWorkspaces?: string[];
  includeGlobalTelemetryFile?: boolean;
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
    payload:
      obj.payload &&
      typeof obj.payload === "object" &&
      !Array.isArray(obj.payload)
        ? (obj.payload as Record<string, unknown>)
        : undefined,
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
  };
}

export class PushBus extends EventEmitter {
  private readonly sessions = new Map<string, EnrichedEvent[]>();
  private readonly seenIds = new Map<string, Set<string>>();
  private readonly fileOffsets = new Map<string, number>();
  private readonly extraWorkspaces: string[];
  private readonly includeGlobalFile: boolean;

  constructor(options?: PushBusOptions) {
    super();
    this.extraWorkspaces = options?.extraWorkspaces ?? [];
    this.includeGlobalFile = options?.includeGlobalTelemetryFile ?? true;
  }

  ingest(rawItems: unknown[]): IngestResult {
    let accepted = 0;
    let deduped = 0;
    const acceptedEvents: EnrichedEvent[] = [];

    for (const raw of rawItems) {
      const ev = coerceToEnrichedEvent(raw);
      let list = this.sessions.get(ev.sessionId);
      let ids = this.seenIds.get(ev.sessionId);
      if (!list || !ids) {
        list = [];
        ids = new Set();
        this.sessions.set(ev.sessionId, list);
        this.seenIds.set(ev.sessionId, ids);
      }

      if (ids.has(ev.id)) {
        deduped += 1;
        continue;
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

      out.push({
        ide: first.ide,
        sessionId,
        filePath: ws
          ? path.join(ws, ".agent-studio", "telemetry.jsonl")
          : "",
        workspacePath: ws,
        workspaces: ws ? [ws] : [],
        projectId: pid,
        title: first.summary.slice(0, 80) || `Live ${sessionId.slice(0, 8)}`,
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
