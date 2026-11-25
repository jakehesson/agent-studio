import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanHumanSummary,
  computeDeterministicEventId,
  computeMergeKey,
  isBoardMutationToolCall,
  isSelfDaemonCommand,
  normalizeWsPath,
  parseEpochSeconds,
  prettifyAgentLabel,
  prettifyModelName,
  summarizeToolCall,
  toIsoUtc,
  unquoteArg,
  type AdapterHealth,
  type DiscoveredSession,
  type EnrichedEvent,
  type ModelSource,
  type PassiveIdeAdapter,
  type UsageDelta,
} from "../types.js";
import {
  getKnownProjects,
  matchProjectIdForWorkspaces,
} from "./project-match.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATED_SUBAGENT_RE =
  /Created the following subagent:\s*\{[^}]*"conversationId"\s*:\s*"([0-9a-f-]{36})"/is;
const CANCELED_SUBAGENT_RE =
  /Subagent\s+"([0-9a-f-]{36})"\s+has been explicitly canceled by the user/i;
const MODEL_SELECTION_RE =
  /Model Selection.*?\bto\s+([A-Za-z0-9 ._()/-]+?)(?:\.|\n|<|$)/i;
const ACTIVE_WS_RE =
  /Active Workspaces?:\s*\n(?:\s*-\s*)?([a-zA-Z]:\/[^\s\n"'<>|]+|\/[^\s\n"'<>|]+)/gi;
const CMD_CWD_RE =
  /Command Working Directory:\s*([a-zA-Z]:\/[^\s\n"'<>|]+|\/[^\s\n"'<>|]+)/gi;
const WIN_ABS_PATH_RE = /\b([a-zA-Z]:\/[^"\s\n'<>|,;()`]+)/g;

interface AntigravityToolCall {
  name?: string;
  args?: Record<string, unknown>;
}

interface AntigravityRow {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: AntigravityToolCall[];
  model?: string;
  modelId?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  token_count?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  metadata?: {
    model?: string;
    modelId?: string;
  };
}

export interface AntigravityAdapterOptions {
  brainDir?: string;
}

async function readJsonlRows(filePath: string): Promise<AntigravityRow[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const rows: AntigravityRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rows.push(parsed as AntigravityRow);
      }
    } catch {
      // Skip malformed partial lines during active writes.
    }
  }
  return rows;
}

function extractWorkspacesFromText(sampleText: string): string[] {
  // Unescape JSON-encoded transcript text so Windows backslashes & newlines match cleanly
  const unescaped = sampleText
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "/")
    .replace(/\\/g, "/");

  const found = new Set<string>();
  const addCandidate = (raw: string, isExplicitHeader: boolean): void => {
    let cleaned = raw.trim().replace(/["'`,.;:)]+$/g, "");
    cleaned = cleaned.replace(/\/+/g, "/").replace(/\/+$/, "");
    const norm = normalizeWsPath(cleaned);
    if (!norm || norm.length <= 3) return;
    const low = norm.toLowerCase();
    if (!isExplicitHeader) {
      if (
        low.includes("/.gemini/") ||
        low.includes("/appdata/roaming/") ||
        low.includes("/appdata/local/programs/") ||
        low.includes("/program files") ||
        low.includes("/node_modules/")
      ) {
        return;
      }
    }
    found.add(norm);
  };

  for (const m of unescaped.matchAll(ACTIVE_WS_RE)) {
    if (m[1]) addCandidate(m[1], true);
  }
  for (const m of unescaped.matchAll(CMD_CWD_RE)) {
    if (m[1]) addCandidate(m[1], true);
  }
  for (const m of unescaped.matchAll(WIN_ABS_PATH_RE)) {
    if (!m[1]) continue;
    let candidate = m[1].replace(/\/+/g, "/").replace(/\/+$/, "");
    // Strip filename if path ends with an extension like .ts/.py/.json/.md
    if (/\/[^/]+\.[a-z0-9]{1,8}$/i.test(candidate)) {
      candidate = candidate.slice(0, candidate.lastIndexOf("/"));
    }
    addCandidate(candidate, false);
  }
  return [...found];
}

function detectRootName(rows: AntigravityRow[]): { id: string; role: string } {
  for (const row of rows.slice(0, 8)) {
    const content = String(row.content ?? "");
    const m = /You are\s+\*\*`?([a-zA-Z0-9_-]+)`?\*\*/.exec(content);
    if (m?.[1]) {
      return { id: m[1].toLowerCase(), role: "Lead Coordinator" };
    }
  }
  return { id: "root", role: "Lead Coordinator" };
}

function detectTitle(rows: AntigravityRow[], fallbackId: string): string {
  for (const row of rows.slice(0, 10)) {
    if (row.type === "USER_INPUT" && row.content) {
      const clean = row.content
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (clean) return clean.slice(0, 80);
    }
  }
  return `Antigravity ${fallbackId.slice(0, 8)}`;
}

export class AntigravityAdapter implements PassiveIdeAdapter {
  readonly ide = "antigravity" as const;
  private readonly brainDir: string;

  constructor(options?: AntigravityAdapterOptions) {
    this.brainDir =
      options?.brainDir ??
      process.env.ANTIGRAVITY_BRAIN_DIR?.trim() ??
      path.join(os.homedir(), ".gemini", "antigravity", "brain");
  }

  async getHealth(): Promise<AdapterHealth> {
    try {
      const stat = await fs.stat(this.brainDir);
      if (!stat.isDirectory()) {
        return {
          ide: this.ide,
          status: "degraded",
          rootDir: this.brainDir,
          sessionsFound: 0,
          message: "Brain path is not a directory",
        };
      }
      const sessions = await this.discoverSessions({ limit: 50 });
      return {
        ide: this.ide,
        status: "ok",
        rootDir: this.brainDir,
        sessionsFound: sessions.length,
      };
    } catch {
      return {
        ide: this.ide,
        status: "degraded",
        rootDir: this.brainDir,
        sessionsFound: 0,
        message: "Antigravity brain directory not found",
      };
    }
  }

  async discoverSessions(opts?: {
    limit?: number;
    workspaceRoots?: string[];
  }): Promise<DiscoveredSession[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.brainDir);
    } catch {
      return [];
    }

    const knownProjects = getKnownProjects();
    const rawCandidates: Array<{
      cid: string;
      filePath: string;
      mtimeMs: number;
      sizeBytes: number;
    }> = [];

    for (const entry of entries) {
      if (!UUID_RE.test(entry)) continue;
      const tpath = path.join(
        this.brainDir,
        entry,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      try {
        const st = await fs.stat(tpath);
        if (st.isFile() && st.size > 0) {
          rawCandidates.push({
            cid: entry,
            filePath: tpath,
            mtimeMs: st.mtimeMs,
            sizeBytes: st.size,
          });
        }
      } catch {
        // Skip conversations without transcripts.
      }
    }

    rawCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const limit = opts?.limit ?? 100;
    const childIds = new Set<string>();
    const inspected: Array<{
      session: DiscoveredSession;
      spawnedChildren: string[];
    }> = [];

    for (const cand of rawCandidates.slice(0, limit * 2)) {
      let headText = "";
      try {
        const fh = await fs.open(cand.filePath, "r");
        try {
          const buf = Buffer.alloc(Math.min(cand.sizeBytes, 32768));
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          headText = buf.subarray(0, bytesRead).toString("utf8");
        } finally {
          await fh.close();
        }
      } catch {
        continue;
      }

      // Skip transcripts that look like spawned child subagents (start with SYSTEM_MESSAGE [Message] sender=...)
      const firstLine = headText.split(/\r?\n/, 1)[0] ?? "";
      if (
        firstLine.includes('"type":"SYSTEM_MESSAGE"') ||
        firstLine.includes('"type": "SYSTEM_MESSAGE"')
      ) {
        if (firstLine.includes("sender=") && !firstLine.includes('"USER_INPUT"')) {
          childIds.add(cand.cid);
          continue;
        }
      }

      const spawnedChildren: string[] = [];
      const unescapedHead = headText.replace(/\\"/g, '"');
      for (const m of unescapedHead.matchAll(
        new RegExp(CREATED_SUBAGENT_RE.source, "gis"),
      )) {
        if (m[1]) {
          spawnedChildren.push(m[1]);
          childIds.add(m[1]);
        }
      }

      const workspaces = extractWorkspacesFromText(headText);
      const primaryWs = workspaces[0];
      const projectId =
        matchProjectIdForWorkspaces(workspaces, knownProjects) ??
        (primaryWs ? path.basename(primaryWs) : undefined);

      const isMultiAgent =
        headText.includes("invoke_subagent") ||
        headText.includes("send_message") ||
        spawnedChildren.length > 0;

      // Extract quick title from first USER_INPUT line if available
      let title = `Antigravity ${cand.cid.slice(0, 8)}`;
      for (const line of headText.split(/\r?\n/).slice(0, 12)) {
        if (!line.includes("USER_INPUT")) continue;
        try {
          const row = JSON.parse(line) as AntigravityRow;
          if (row.type === "USER_INPUT" && row.content) {
            const clean = row.content
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim();
            if (clean) {
              title = clean.slice(0, 80);
              break;
            }
          }
        } catch {
          // ignore
        }
      }

      inspected.push({
        session: {
          ide: this.ide,
          sessionId: cand.cid,
          filePath: cand.filePath,
          workspacePath: primaryWs,
          workspaces,
          projectId,
          title,
          mtimeMs: cand.mtimeMs,
          sizeBytes: cand.sizeBytes,
          isMultiAgent,
        },
        spawnedChildren,
      });
    }

    const topLevel = inspected
      .filter((item) => !childIds.has(item.session.sessionId))
      .map((item) => item.session);

    return topLevel.slice(0, limit);
  }

  async parseSession(session: DiscoveredSession): Promise<EnrichedEvent[]> {
    const rootCid = session.sessionId;
    const rootRows = await readJsonlRows(session.filePath);
    if (rootRows.length === 0) return [];

    const knownProjects = getKnownProjects();
    const { id: rootId } = detectRootName(rootRows);
    const title = detectTitle(rootRows, rootCid);
    if (!session.title) session.title = title;

    const convToAgent = new Map<string, string>([[rootCid, rootId]]);
    const agentToConv = new Map<string, string>([[rootId, rootCid]]);
    const agentLabels = new Map<string, string>([
      [rootId, prettifyAgentLabel(rootId)],
    ]);
    const agentParent = new Map<string, string>();
    const pendingSpawns: Array<{
      parentCid: string;
      targetId: string;
      role: string;
      requestedModel?: string;
      spawnEvent: EnrichedEvent;
    }> = [];

    interface AgentUsageAcc {
      model?: string;
      modelSource: ModelSource;
      inheritFrom?: string;
      hasExact: boolean;
      exactInput: number;
      exactOutput: number;
      exactCached: number;
      lastTurnContext: number;
      estInputChars: number;
      estOutputChars: number;
    }
    const agentUsageAcc = new Map<string, AgentUsageAcc>();
    const ensureUsageAcc = (aid: string): AgentUsageAcc => {
      let acc = agentUsageAcc.get(aid);
      if (!acc) {
        acc = {
          modelSource: "unknown",
          hasExact: false,
          exactInput: 0,
          exactOutput: 0,
          exactCached: 0,
          lastTurnContext: 0,
          estInputChars: 0,
          estOutputChars: 0,
        };
        agentUsageAcc.set(aid, acc);
      }
      return acc;
    };

    const visited = new Set<string>();
    const queue: string[] = [rootCid];
    const rawEvents: EnrichedEvent[] = [];

    const sampleWorkspaces = (): string[] => {
      const all = [...session.workspaces];
      if (session.workspacePath && !all.includes(session.workspacePath)) {
        all.unshift(session.workspacePath);
      }
      if (all.length === 0) {
        const sample = rootRows
          .slice(0, 12)
          .map((r) => `${r.content ?? ""} ${JSON.stringify(r.tool_calls ?? [])}`)
          .join("\n");
        all.push(...extractWorkspacesFromText(sample));
      }
      return all;
    };

    const allWorkspaces = sampleWorkspaces();
    const workspacePath = session.workspacePath ?? allWorkspaces[0];
    const projectId =
      matchProjectIdForWorkspaces(allWorkspaces, knownProjects) ??
      session.projectId;

    const makeEvent = (input: {
      epoch: number;
      agentId: string;
      agentLabel?: string;
      parentAgentId?: string;
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
    }): EnrichedEvent => {
      const ts = toIsoUtc(input.epoch);
      const id = computeDeterministicEventId({
        ide: this.ide,
        sessionId: rootCid,
        agentId: input.agentId,
        kind: input.kind,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        epoch: input.epoch,
        summary: input.summary,
      });
      const mergeKey = computeMergeKey({
        sessionId: rootCid,
        agentId: input.agentId,
        kind: input.kind,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        epoch: input.epoch,
      });
      return {
        id,
        mergeKey,
        ts,
        epoch: input.epoch,
        ide: this.ide,
        channel: "passive",
        sessionId: rootCid,
        workspacePath,
        projectId,
        agentId: input.agentId,
        agentLabel: input.agentLabel ?? agentLabels.get(input.agentId),
        parentAgentId: input.parentAgentId ?? agentParent.get(input.agentId),
        kind: input.kind,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        targetAgentId: input.targetAgentId,
        summary: input.summary,
        payload: input.payload,
        status: input.status,
        isSelfDaemon: input.isSelfDaemon,
        isError: input.isError,
        waitingReason: input.waitingReason,
      };
    };

    while (queue.length > 0) {
      const cid = queue.shift()!;
      if (visited.has(cid)) continue;
      visited.add(cid);

      const tpath =
        cid === rootCid
          ? session.filePath
          : path.join(
              this.brainDir,
              cid,
              ".system_generated",
              "logs",
              "transcript.jsonl",
            );
      const rows = cid === rootCid ? rootRows : await readJsonlRows(tpath);
      let senderId = convToAgent.get(cid);
      if (!senderId) {
        senderId = `agent-${cid.slice(0, 6)}`;
        convToAgent.set(cid, senderId);
        agentToConv.set(senderId, cid);
        agentLabels.set(senderId, prettifyAgentLabel(senderId));
      }

      // Open tool call FIFO per conversation to match subsequent GENERIC tool output rows
      const openToolCalls: Array<{
        toolCallId: string;
        toolName: string;
        summary: string;
        isSelfDaemon: boolean;
      }> = [];

      let fallbackEpoch = session.mtimeMs / 1000 - Math.max(rows.length, 1);

      const acc = ensureUsageAcc(senderId);

      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx]!;
        const epoch = parseEpochSeconds(row.created_at, fallbackEpoch + idx);
        fallbackEpoch = epoch;
        const rtype = row.type ?? "";
        const rstatus = row.status ?? "";
        const rsource = row.source ?? "";
        const content = String(row.content ?? "");
        const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];

        // Extract model & token usage from every row of this agent's transcript
        const rowModelRaw =
          row.model ?? row.modelId ?? row.metadata?.model ?? row.metadata?.modelId;
        if (typeof rowModelRaw === "string" && rowModelRaw.trim()) {
          const pretty = prettifyModelName(rowModelRaw);
          if (pretty) {
            acc.model = pretty;
            acc.modelSource = "exact";
          }
        }
        if (
          (rtype === "USER_SETTINGS_CHANGE" ||
            rtype === "SYSTEM_MESSAGE" ||
            content.includes("Model Selection")) &&
          content
        ) {
          const mSel = MODEL_SELECTION_RE.exec(content);
          if (mSel?.[1]) {
            const pretty = prettifyModelName(mSel[1]);
            if (pretty) {
              acc.model = pretty;
              acc.modelSource = "exact";
            }
          }
        }

        const rIn =
          typeof row.input_tokens === "number"
            ? row.input_tokens
            : typeof row.usage?.input_tokens === "number"
              ? row.usage.input_tokens
              : typeof row.usage?.prompt_tokens === "number"
                ? row.usage.prompt_tokens
                : undefined;
        const rOut =
          typeof row.output_tokens === "number"
            ? row.output_tokens
            : typeof row.usage?.output_tokens === "number"
              ? row.usage.output_tokens
              : typeof row.usage?.completion_tokens === "number"
                ? row.usage.completion_tokens
                : undefined;
        const rCached =
          (typeof row.cache_read_tokens === "number" ? row.cache_read_tokens : 0) +
          (typeof row.cache_creation_tokens === "number" ? row.cache_creation_tokens : 0) +
          (typeof row.usage?.cache_read_tokens === "number" ? row.usage.cache_read_tokens : 0) +
          (typeof row.usage?.cache_read_input_tokens === "number"
            ? row.usage.cache_read_input_tokens
            : 0) +
          (typeof row.usage?.cache_creation_input_tokens === "number"
            ? row.usage.cache_creation_input_tokens
            : 0);

        if (rIn !== undefined || rOut !== undefined || typeof row.token_count === "number") {
          acc.hasExact = true;
          const inTok = Math.max(0, Math.round(rIn ?? (rOut === undefined ? (row.token_count ?? 0) : 0)));
          const outTok = Math.max(0, Math.round(rOut ?? 0));
          const cachedTok = Math.max(0, Math.round(rCached));
          acc.exactInput += inTok;
          acc.exactOutput += outTok;
          acc.exactCached += cachedTok;
          acc.lastTurnContext = Math.max(acc.lastTurnContext, inTok + cachedTok + outTok);
        }

        // Accumulate char-based fallback estimation for transcripts without exact token fields
        if (rtype === "USER_INPUT" || rtype === "SYSTEM_MESSAGE" || rtype === "GENERIC") {
          acc.estInputChars += content.length;
        } else if (rtype === "PLANNER_RESPONSE") {
          acc.estOutputChars +=
            content.length +
            (typeof row.thinking === "string" ? row.thinking.length : 0) +
            (toolCalls.length > 0 ? JSON.stringify(toolCalls).length : 0);
        }

        // 1. Match subagent creation inside GENERIC rows (including source === "MODEL")
        if (rtype === "GENERIC" || CREATED_SUBAGENT_RE.test(content)) {
          const mSub = CREATED_SUBAGENT_RE.exec(content);
          if (mSub?.[1] && mSub[1] !== cid) {
            const childCid = mSub[1];
            let spawnedId: string | undefined;
            let spawnedRole = "";
            let requestedModel: string | undefined;
            let spawnEvent: EnrichedEvent | undefined;
            const spawnIdx = pendingSpawns.findIndex(
              (p) => p.parentCid === cid,
            );
            if (spawnIdx >= 0) {
              const popped = pendingSpawns.splice(spawnIdx, 1)[0];
              spawnedId = popped?.targetId;
              spawnedRole = popped?.role ?? "";
              requestedModel = popped?.requestedModel;
              spawnEvent = popped?.spawnEvent;
            }
            if (!convToAgent.has(childCid)) {
              let baseId = spawnedId || `subagent-${childCid.slice(0, 6)}`;
              const existingConv = agentToConv.get(baseId);
              if (existingConv && existingConv !== childCid) {
                let n = 2;
                while (agentToConv.has(`${baseId}-${n}`)) n++;
                baseId = `${baseId}-${n}`;
              }
              convToAgent.set(childCid, baseId);
              agentToConv.set(baseId, childCid);
              agentLabels.set(
                baseId,
                spawnedRole || prettifyAgentLabel(baseId),
              );
              agentParent.set(baseId, senderId);
            }
            const resolvedChildId = convToAgent.get(childCid);
            if (resolvedChildId) {
              const childAcc = ensureUsageAcc(resolvedChildId);
              const reqLow = (requestedModel ?? "").trim().toLowerCase();
              if (!reqLow || reqLow === "inherit") {
                childAcc.inheritFrom = senderId;
              } else {
                const pretty = prettifyModelName(requestedModel ?? "");
                if (pretty && childAcc.modelSource !== "exact") {
                  childAcc.model = pretty;
                  childAcc.modelSource = "exact";
                }
              }
            }
            if (spawnEvent && resolvedChildId) {
              spawnEvent.targetAgentId = resolvedChildId;
              spawnEvent.id = computeDeterministicEventId({
                ide: this.ide,
                sessionId: rootCid,
                agentId: spawnEvent.agentId,
                kind: spawnEvent.kind,
                toolCallId: `${spawnEvent.toolCallId ?? ""}:${resolvedChildId}`,
                toolName: spawnEvent.toolName,
                epoch: spawnEvent.epoch,
                summary: spawnEvent.summary,
              });
              spawnEvent.payload = {
                ...(spawnEvent.payload ?? {}),
                childConvId: childCid,
                targetAgentId: resolvedChildId,
              };
            }
            if (!visited.has(childCid)) {
              queue.push(childCid);
            }
          }
        }

        // 2. USER_INPUT -> user_input event
        if (rtype === "USER_INPUT" && content.trim()) {
          const clean = cleanHumanSummary(content, 130);
          if (clean) {
            rawEvents.push(
              makeEvent({
                epoch,
                agentId: senderId,
                targetAgentId: senderId,
                kind: "user_input",
                summary: `Human: ${clean}`,
                payload: { body: content.slice(0, 1400), conv: cid },
              }),
            );
          }
        }

        // 3. SYSTEM_MESSAGE: detect canceled subagent OR incoming peer/parent message wake
        if (rtype === "SYSTEM_MESSAGE" && content.trim()) {
          const mCanceled = CANCELED_SUBAGENT_RE.exec(content);
          if (mCanceled?.[1]) {
            const canceledCid = mCanceled[1];
            rawEvents.push(
              makeEvent({
                epoch,
                agentId: canceledCid,
                targetAgentId: canceledCid,
                kind: "subagent_done",
                summary: "Canceled by user",
                status: "ok",
                payload: { canceled: true, source: rsource, conv: cid },
              }),
            );
          } else {
            const mContent = /content=(.+)/s.exec(content);
            const snippet = cleanHumanSummary(mContent?.[1] ?? content, 90);
            rawEvents.push(
              makeEvent({
                epoch,
                agentId: senderId,
                kind: "thinking_start",
                summary: snippet
                  ? `Thinking: ${snippet}`
                  : "Thinking on incoming message",
                payload: { source: rsource, conv: cid },
              }),
            );
          }
        }

        // 4. GENERIC tool result row closes oldest open tool call (when status !== RUNNING)
        if (rtype === "GENERIC") {
          const selfDaemon = isSelfDaemonCommand(content);
          if (rstatus !== "RUNNING" && openToolCalls.length > 0) {
            const finished = openToolCalls.shift()!;
            const isErr = rstatus === "ERROR";
            rawEvents.push(
              makeEvent({
                epoch,
                agentId: senderId,
                kind: "tool_end",
                toolName: finished.toolName,
                toolCallId: finished.toolCallId,
                summary: cleanHumanSummary(
                  isErr
                    ? `Failed: ${finished.summary}`
                    : `Completed: ${finished.summary}`,
                  140,
                ),
                status: isErr ? "error" : "ok",
                isError: isErr,
                isSelfDaemon: finished.isSelfDaemon || selfDaemon,
                payload: {
                  conv: cid,
                  source: rsource,
                  outputPreview: content.slice(0, 400),
                  ...(!isErr ? { routineEnd: true } : {}),
                },
              }),
            );
          } else if (rstatus === "ERROR") {
            rawEvents.push(
              makeEvent({
                epoch,
                agentId: senderId,
                kind: "tool_end",
                summary: cleanHumanSummary(`Error: ${content}`, 140),
                status: "error",
                isError: true,
                payload: { conv: cid },
              }),
            );
          }
        }

        // 5. PLANNER_RESPONSE tool calls
        if (toolCalls.length > 0) {
          for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
            const tc = toolCalls[tcIdx]!;
            const tname = String(tc.name ?? "");
            const args = tc.args ?? {};
            const toolCallId = `${cid}:${idx}:${tcIdx}:${tname}`;
            const actionText = summarizeToolCall(tname, args);

            if (tname === "invoke_subagent") {
              const rawType = unquoteArg(args.TypeName) || "subagent";
              const role = unquoteArg(args.Role) || rawType;
              const prompt = unquoteArg(args.Prompt);
              const requestedModel = unquoteArg(args.Model ?? args.model);
              const targetSlug = rawType
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "-");
              if (!agentLabels.has(targetSlug)) {
                agentLabels.set(targetSlug, role || prettifyAgentLabel(targetSlug));
              }
              agentParent.set(targetSlug, senderId);
              const spawnSummary = cleanHumanSummary(`Spawned ${role}`, 140);
              const spawnEvent = makeEvent({
                epoch: epoch + tcIdx * 0.0001,
                agentId: senderId,
                targetAgentId: targetSlug,
                kind: "subagent_spawn",
                toolName: tname,
                toolCallId,
                summary: spawnSummary,
                payload: {
                  role,
                  ...(requestedModel ? { requestedModel } : {}),
                  prompt: prompt.slice(0, 1000),
                  conv: cid,
                },
              });
              rawEvents.push(spawnEvent);
              pendingSpawns.push({
                parentCid: cid,
                targetId: targetSlug,
                role,
                requestedModel: requestedModel || undefined,
                spawnEvent,
              });
              openToolCalls.push({
                toolCallId,
                toolName: tname,
                summary: spawnSummary,
                isSelfDaemon: false,
              });
            } else if (tname === "send_message") {
              const recipientRaw = unquoteArg(args.Recipient);
              const body = unquoteArg(args.Message);
              if (UUID_RE.test(recipientRaw) && !visited.has(recipientRaw)) {
                queue.push(recipientRaw);
              }
              const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
              const msgSummary =
                cleanHumanSummary(firstLine || body, 140) || "Peer message";
              rawEvents.push(
                makeEvent({
                  epoch: epoch + tcIdx * 0.0001,
                  agentId: senderId,
                  targetAgentId: recipientRaw,
                  kind: "message",
                  toolName: tname,
                  toolCallId,
                  summary: msgSummary,
                  payload: {
                    body: body.slice(0, 1400),
                    recipientRaw,
                    conv: cid,
                  },
                }),
              );
              openToolCalls.push({
                toolCallId,
                toolName: tname,
                summary: msgSummary,
                isSelfDaemon: false,
              });
            } else if (tname === "notify_user") {
              const body = unquoteArg(args.Message) || "Updated user";
              const firstLine = body.split(/\r?\n/, 1)[0] ?? body;
              const notifySummary = cleanHumanSummary(`To Human: ${firstLine}`, 140);
              rawEvents.push(
                makeEvent({
                  epoch: epoch + tcIdx * 0.0001,
                  agentId: senderId,
                  targetAgentId: "human",
                  kind: "message",
                  toolName: tname,
                  toolCallId,
                  summary: notifySummary,
                  payload: { body: body.slice(0, 1400), conv: cid },
                }),
              );
              openToolCalls.push({
                toolCallId,
                toolName: tname,
                summary: notifySummary,
                isSelfDaemon: false,
              });
            } else if (tname === "ask_question") {
              const qSummary = "Asked user a question";
              rawEvents.push(
                makeEvent({
                  epoch: epoch + tcIdx * 0.0001,
                  agentId: senderId,
                  targetAgentId: "human",
                  kind: "tool_start",
                  toolName: tname,
                  toolCallId,
                  summary: qSummary,
                  waitingReason: "user",
                  payload: { args, conv: cid },
                }),
              );
              openToolCalls.push({
                toolCallId,
                toolName: tname,
                summary: qSummary,
                isSelfDaemon: false,
              });
            } else {
              const cmdLine = unquoteArg(args.CommandLine);
              const selfDaemon = isSelfDaemonCommand(
                cmdLine || JSON.stringify(args),
                args.IsDaemon,
              );
              const isBoardMut = isBoardMutationToolCall(tname, args);
              rawEvents.push(
                makeEvent({
                  epoch: epoch + tcIdx * 0.0001,
                  agentId: senderId,
                  kind: isBoardMut ? "board_mutation" : "tool_start",
                  toolName: tname,
                  toolCallId,
                  summary: actionText,
                  isSelfDaemon: selfDaemon,
                  payload: {
                    args: Object.fromEntries(
                      Object.entries(args).map(([k, v]) => [
                        k,
                        unquoteArg(v).slice(0, 200),
                      ]),
                    ),
                    conv: cid,
                  },
                }),
              );
              openToolCalls.push({
                toolCallId,
                toolName: tname,
                summary: actionText,
                isSelfDaemon: selfDaemon,
              });
            }
          }
        } else if (rtype === "PLANNER_RESPONSE" && content.trim()) {
          // Clean assistant yield without tool calls
          const kind =
            senderId === rootId ? "assistant_turn_end" : "subagent_done";
          rawEvents.push(
            makeEvent({
              epoch,
              agentId: senderId,
              kind,
              summary: cleanHumanSummary(content, 140),
              payload: { body: content.slice(0, 1000), conv: cid },
            }),
          );
        }
      }
    }

    // Second pass: resolve UUID agentIds & targetAgentIds -> friendly discovered agentIds
    for (const ev of rawEvents) {
      if (convToAgent.has(ev.agentId)) {
        ev.agentId = convToAgent.get(ev.agentId)!;
        ev.agentLabel = agentLabels.get(ev.agentId) ?? ev.agentLabel;
        ev.parentAgentId = agentParent.get(ev.agentId) ?? ev.parentAgentId;
      } else if (UUID_RE.test(ev.agentId)) {
        ev.agentId = `agent-${ev.agentId.slice(0, 6)}`;
      }
      if (ev.targetAgentId && convToAgent.has(ev.targetAgentId)) {
        ev.targetAgentId = convToAgent.get(ev.targetAgentId);
      } else if (ev.targetAgentId && UUID_RE.test(ev.targetAgentId)) {
        ev.targetAgentId = `agent-${ev.targetAgentId.slice(0, 6)}`;
      }
    }

    // Resolve inherited child models & attach finalized per-agent UsageDelta totals
    for (const [, acc] of agentUsageAcc.entries()) {
      if (!acc.model && acc.inheritFrom) {
        const parentAcc = agentUsageAcc.get(acc.inheritFrom);
        if (parentAcc?.model) {
          acc.model = parentAcc.model;
          acc.modelSource = "inherited";
        }
      }
    }

    const lastEventByAgent = new Map<string, EnrichedEvent>();
    for (const ev of rawEvents) {
      lastEventByAgent.set(ev.agentId, ev);
    }

    for (const [aid, acc] of agentUsageAcc.entries()) {
      const inputTokens = acc.hasExact
        ? acc.exactInput
        : Math.round(acc.estInputChars / 4);
      const outputTokens = acc.hasExact
        ? acc.exactOutput
        : Math.round(acc.estOutputChars / 4);
      const cachedTokens = acc.hasExact ? acc.exactCached : 0;
      const contextTokens = acc.hasExact
        ? acc.lastTurnContext
        : inputTokens + outputTokens;
      const usageDelta: UsageDelta = {
        model: acc.model,
        modelSource: acc.model ? acc.modelSource : "unknown",
        usageSource: acc.hasExact ? "exact" : "estimated",
        inputTokens,
        outputTokens,
        cachedTokens,
        contextTokens,
        isTotal: true,
      };
      const targetEv = lastEventByAgent.get(aid);
      if (targetEv) {
        targetEv.usageDelta = usageDelta;
        targetEv.payload = { ...(targetEv.payload ?? {}), _usageDelta: usageDelta };
      } else {
        // Spawned child with 0 rows emitted: attach model hint on matching spawn event
        const spawnEv = rawEvents.find(
          (e) => e.kind === "subagent_spawn" && e.targetAgentId === aid,
        );
        if (spawnEv && acc.model) {
          spawnEv.payload = {
            ...(spawnEv.payload ?? {}),
            childModel: acc.model,
            childModelSource: acc.modelSource,
          };
        }
      }
    }

    return rawEvents;
  }
}
