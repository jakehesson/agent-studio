import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanHumanSummary,
  computeDeterministicEventId,
  computeMergeKey,
  extractProviderUsageDetails,
  isBoardMutationToolCall,
  isSelfDaemonCommand,
  normalizePendingQuestions,
  normalizeWsPath,
  parseEpochSeconds,
  prettifyAgentLabel,
  prettifyModelName,
  summarizeToolCall,
  toIsoUtc,
  unquoteArg,
  type AdapterHealth,
  type AgentStatus,
  type DiscoveredSession,
  type EnrichedEvent,
  type ModelSource,
  type ParseSessionOptions,
  type PassiveIdeAdapter,
  type UsageDelta,
} from "../types.js";
import {
  getKnownProjects,
  matchProjectIdForWorkspaces,
} from "./project-match.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THINKING_INLINE_MAX = 800;

function formatAnswerValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val.trim();
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) {
    return val.map(formatAnswerValue).filter(Boolean).join(", ");
  }
  if (typeof val === "object") {
    const rec = val as Record<string, unknown>;
    if (
      typeof rec.question === "string" &&
      (rec.answer !== undefined || rec.value !== undefined)
    ) {
      const a = formatAnswerValue(rec.answer ?? rec.value);
      return a ? `${rec.question.trim()}: ${a}` : "";
    }
    return Object.entries(rec)
      .map(([k, v]) => {
        const formatted = formatAnswerValue(v);
        if (!formatted) return "";
        return k.trim() ? `${k.trim()}: ${formatted}` : formatted;
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractAntigravityAnswerText(rawContent: string): string {
  const trimmed = rawContent.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed.trim();
      if (Array.isArray(parsed)) {
        const joined = parsed.map(formatAnswerValue).filter(Boolean).join("\n");
        return joined || trimmed;
      }
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>;
        for (const key of ["answers", "answer", "response", "text"]) {
          if (rec[key] !== undefined) {
            const unwrapped = formatAnswerValue(rec[key]);
            if (unwrapped) return unwrapped;
          }
        }
        const formattedMap = formatAnswerValue(rec);
        if (formattedMap) return formattedMap;
      }
    } catch {
      // Fallback to raw trimmed text if not valid JSON.
    }
  }
  return trimmed;
}
const CREATED_SUBAGENT_RE =
  /Created the following subagent:\s*(\{[^}]*"conversationId"\s*:\s*"([0-9a-f-]{36})"[^}]*\})/is;
const CANCELED_SUBAGENT_RE =
  /Subagent\s+"([0-9a-f-]{36})"\s+has been explicitly canceled by the user/i;
const MODEL_SELECTION_RE =
  /Model Selection.*?\bto\s+([A-Za-z0-9 ._()/-]+?)(?:\.(?:\s|$)|\n|<|$)/i;
const ACTIVE_WS_RE =
  /Active Workspaces?:\s*\n(?:\s*-\s*)?([a-zA-Z]:\/[^\s\n"'<>|]+|\/[^\s\n"'<>|]+)/gi;
const CMD_CWD_RE =
  /Command Working Directory:\s*([a-zA-Z]:\/[^\s\n"'<>|]+|\/[^\s\n"'<>|]+)/gi;
const FILE_URI_RE = /file:\/\/\/[^\s"'<>|\\)]+/gi;
const POSIX_FIELD_PATH_RE =
  /"(?:cwd|workspacePath|workspace_path|root|DirectoryPath|SearchPath|TargetFile|AbsolutePath)"\s*:\s*"(\/[^"\n]+)"/gi;
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
  cached_tokens?: number;
  reasoning_tokens?: number;
  thinking_tokens?: number;
  thoughtsTokenCount?: number;
  token_count?: number;
  costUsd?: number;
  cost_usd?: number;
  usage?: Record<string, unknown> & {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  usageMetadata?: Record<string, unknown> & {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
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
        low.includes("/node_modules/") ||
        low.startsWith("/tmp/") ||
        low.startsWith("/usr/") ||
        low.startsWith("/bin/") ||
        low.startsWith("/etc/")
      ) {
        return;
      }
    }
    found.add(norm);
  };

  const activeBlockRe = /Active Workspaces?:\s*\n((?:\s*-\s*[^\n]+\n?)+)/gi;
  for (const blockMatch of unescaped.matchAll(activeBlockRe)) {
    const block = blockMatch[1] ?? "";
    for (const line of block.split(/\r?\n/)) {
      const m = /^\s*-\s*([a-zA-Z]:\/[^\n"'<>|]+|\/[^\n"'<>|]+)/.exec(line);
      if (m?.[1]) addCandidate(m[1].trim(), true);
    }
  }
  for (const m of unescaped.matchAll(ACTIVE_WS_RE)) {
    if (m[1]) addCandidate(m[1], true);
  }
  for (const m of unescaped.matchAll(CMD_CWD_RE)) {
    if (m[1]) addCandidate(m[1], true);
  }
  for (const m of sampleText.matchAll(FILE_URI_RE)) {
    if (!m[0]) continue;
    let decoded = normalizeWsPath(m[0]).replace(/\/+/g, "/").replace(/\/+$/, "");
    if (/\/[^/]+\.[a-z0-9]{1,8}$/i.test(decoded)) {
      decoded = decoded.slice(0, decoded.lastIndexOf("/"));
    }
    addCandidate(decoded, false);
  }
  for (const m of unescaped.matchAll(POSIX_FIELD_PATH_RE)) {
    if (!m[1]) continue;
    let candidate = m[1].replace(/\/+/g, "/").replace(/\/+$/, "");
    if (/\/[^/]+\.[a-z0-9]{1,8}$/i.test(candidate)) {
      candidate = candidate.slice(0, candidate.lastIndexOf("/"));
    }
    addCandidate(candidate, false);
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

interface CachedDiscoveryMeta {
  mtimeMs: number;
  sizeBytes: number;
  isChild: boolean;
  spawnedChildren: string[];
  workspaces: string[];
  isMultiAgent: boolean;
  title: string;
  tailStatus?: AgentStatus;
  isCompleted?: boolean;
  waitingOn?: "user" | "tool_approval" | "subagent" | null;
  pendingQuestionCount?: number;
  waitingSummary?: string;
}

export class AntigravityAdapter implements PassiveIdeAdapter {
  readonly ide = "antigravity" as const;
  private readonly brainDir: string;
  private readonly discoveryCache = new Map<string, CachedDiscoveryMeta>();

  constructor(options?: AntigravityAdapterOptions) {
    this.brainDir =
      options?.brainDir ??
      process.env.ANTIGRAVITY_BRAIN_DIR?.trim() ??
      path.join(os.homedir(), ".gemini", "antigravity", "brain");
  }

  getBrainDir(): string {
    return this.brainDir;
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
      let meta = this.discoveryCache.get(cand.cid);
      if (
        !meta ||
        meta.mtimeMs !== cand.mtimeMs ||
        meta.sizeBytes !== cand.sizeBytes
      ) {
        let fullText = "";
        try {
          fullText = await fs.readFile(cand.filePath, "utf8");
        } catch {
          continue;
        }

        const lines = fullText.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const firstLine = lines[0] ?? "";
        const isChild =
          (firstLine.includes('"type":"SYSTEM_MESSAGE"') ||
            firstLine.includes('"type": "SYSTEM_MESSAGE"')) &&
          firstLine.includes("sender=") &&
          !fullText.includes('"USER_INPUT"');

        const spawnedChildren: string[] = [];
        const unescapedText = fullText.replace(/\\"/g, '"');
        for (const m of unescapedText.matchAll(
          new RegExp(CREATED_SUBAGENT_RE.source, "gis"),
        )) {
          if (m[2]) {
            spawnedChildren.push(m[2]);
          }
        }

        const workspaces = extractWorkspacesFromText(fullText);
        const isMultiAgent =
          fullText.includes("invoke_subagent") ||
          fullText.includes("send_message") ||
          spawnedChildren.length > 0;

        let title = `Antigravity ${cand.cid.slice(0, 8)}`;
        for (const line of lines.slice(0, 20)) {
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

        // Inspect tail row for accurate discovery status & waiting state
        let tailStatus: AgentStatus | undefined;
        let isCompleted: boolean | undefined;
        let waitingOn: "user" | "tool_approval" | "subagent" | null = null;
        let pendingQuestionCount = 0;
        let waitingSummary: string | undefined;
        for (let li = lines.length - 1; li >= 0; li--) {
          try {
            const tailRow = JSON.parse(lines[li]!) as AntigravityRow;
            if (tailRow.type === "PLANNER_RESPONSE") {
              const tcs = Array.isArray(tailRow.tool_calls)
                ? tailRow.tool_calls
                : [];
              const askTc = tcs.find((tc) => tc.name === "ask_question");
              const notifyBlockedTc = tcs.find(
                (tc) =>
                  tc.name === "notify_user" &&
                  (tc.args?.BlockedOnUser === true ||
                    unquoteArg(tc.args?.BlockedOnUser).toLowerCase() === "true"),
              );
              if (askTc) {
                const qs = normalizePendingQuestions(
                  askTc.args?.questions ?? askTc.args,
                  { defaultAllowCustomInput: true },
                );
                tailStatus = "WAITING";
                isCompleted = false;
                waitingOn = "user";
                pendingQuestionCount = Math.max(1, qs.length);
                waitingSummary =
                  cleanHumanSummary(
                    qs[0]?.header ?? qs[0]?.question ?? "Asked user a question",
                    80,
                  ) || "Asked user a question";
              } else if (notifyBlockedTc) {
                const msg = unquoteArg(notifyBlockedTc.args?.Message).trim();
                tailStatus = "WAITING";
                isCompleted = false;
                waitingOn = "user";
                pendingQuestionCount = 1;
                waitingSummary =
                  cleanHumanSummary(msg || "Waiting for user response", 80) ||
                  "Waiting for user response";
              } else if (tcs.length === 0 && tailRow.content?.trim()) {
                tailStatus = "DONE";
                isCompleted = true;
              } else if (tcs.length > 0) {
                tailStatus = "WORKING";
                isCompleted = false;
              }
            } else if (tailRow.type === "GENERIC") {
              if (tailRow.status === "RUNNING") {
                tailStatus = "WORKING";
                isCompleted = false;
              } else if (tailRow.status === "ERROR") {
                tailStatus = "BLOCKED";
                isCompleted = false;
              }
            } else if (tailRow.type === "USER_INPUT") {
              tailStatus = "THINKING";
              isCompleted = false;
            }
            break;
          } catch {
            // Skip partial trailing line
          }
        }

        meta = {
          mtimeMs: cand.mtimeMs,
          sizeBytes: cand.sizeBytes,
          isChild,
          spawnedChildren,
          workspaces,
          isMultiAgent,
          title,
          tailStatus,
          isCompleted,
          waitingOn,
          pendingQuestionCount,
          waitingSummary,
        };
        this.discoveryCache.set(cand.cid, meta);
      }

      for (const spawnedId of meta.spawnedChildren) {
        childIds.add(spawnedId);
      }
      if (meta.isChild) {
        childIds.add(cand.cid);
        continue;
      }

      const primaryWs = meta.workspaces[0];
      const projectId =
        matchProjectIdForWorkspaces(meta.workspaces, knownProjects) ??
        (primaryWs ? path.basename(primaryWs) : undefined);

      inspected.push({
        session: {
          ide: this.ide,
          sessionId: cand.cid,
          filePath: cand.filePath,
          workspacePath: primaryWs,
          workspaces: meta.workspaces,
          projectId,
          title: meta.title,
          mtimeMs: cand.mtimeMs,
          sizeBytes: cand.sizeBytes,
          isMultiAgent: meta.isMultiAgent,
          ...(meta.tailStatus ? { status: meta.tailStatus } : {}),
          waitingOn: meta.waitingOn ?? null,
          pendingQuestionCount: meta.pendingQuestionCount ?? 0,
          ...(meta.waitingSummary ? { waitingSummary: meta.waitingSummary } : {}),
          ...(meta.waitingOn ? { isWaiting: true } : {}),
          ...(meta.isCompleted !== undefined
            ? { isCompleted: meta.isCompleted }
            : {}),
        },
        spawnedChildren: meta.spawnedChildren,
      });
    }

    const topLevel = inspected
      .filter((item) => !childIds.has(item.session.sessionId))
      .map((item) => item.session);

    return topLevel.slice(0, limit);
  }

  async parseSession(
    session: DiscoveredSession,
    opts?: ParseSessionOptions,
  ): Promise<EnrichedEvent[]> {
    const rootCid = session.sessionId;
    const rootRows = await readJsonlRows(session.filePath);
    if (rootRows.length === 0) {
      return [];
    }

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
      prompt: string;
      requestedModel?: string;
      spawnEvent: EnrichedEvent;
    }> = [];
    const childRowsCache = new Map<string, AntigravityRow[]>();

    interface AgentUsageAcc {
      model?: string;
      modelSource: ModelSource;
      inheritFrom?: string;
      hasExact: boolean;
      exactInput: number;
      exactOutput: number;
      exactCached: number;
      exactCacheRead: number;
      exactCacheWrite: number;
      hasCacheSplit: boolean;
      hasUnsplitCached: boolean;
      exactReasoning: number;
      hasExactReasoning: boolean;
      lastTurnContext: number;
      estInputChars: number;
      estOutputChars: number;
      costUsd?: number;
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
          exactCacheRead: 0,
          exactCacheWrite: 0,
          hasCacheSplit: false,
          hasUnsplitCached: false,
          exactReasoning: 0,
          hasExactReasoning: false,
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
    const fullBodies = new Map<EnrichedEvent, string>();

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
      fullBody?: string;
      inlineBody?: string;
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
      const hasBody =
        typeof input.fullBody === "string" && input.fullBody.length > 0;
      const bodyLength = hasBody ? input.fullBody!.length : undefined;
      const bodyTruncated = hasBody
        ? input.fullBody!.length > (input.inlineBody?.length ?? 0)
        : undefined;
      const ev: EnrichedEvent = {
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
        ...(bodyLength !== undefined ? { bodyLength } : {}),
        ...(bodyTruncated !== undefined ? { bodyTruncated } : {}),
        status: input.status,
        isSelfDaemon: input.isSelfDaemon,
        isError: input.isError,
        waitingReason: input.waitingReason,
      };
      if (hasBody) {
        fullBodies.set(ev, input.fullBody!);
      }
      return ev;
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
      const rows =
        cid === rootCid
          ? rootRows
          : childRowsCache.get(cid) ?? (await readJsonlRows(tpath));
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
        questionPrompt?: string;
        blockedOnUser?: boolean;
      }> = [];
      const pruneStaleNotify = (): void => {
        for (let oi = openToolCalls.length - 1; oi >= 0; oi--) {
          const tname = openToolCalls[oi]!.toolName;
          if (tname === "notify_user" || tname === "ask_question") {
            openToolCalls.splice(oi, 1);
          }
        }
      };

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
                : typeof row.usageMetadata?.promptTokenCount === "number"
                  ? row.usageMetadata.promptTokenCount
                  : undefined;
        const rOut =
          typeof row.output_tokens === "number"
            ? row.output_tokens
            : typeof row.usage?.output_tokens === "number"
              ? row.usage.output_tokens
              : typeof row.usage?.completion_tokens === "number"
                ? row.usage.completion_tokens
                : typeof row.usageMetadata?.candidatesTokenCount === "number"
                  ? row.usageMetadata.candidatesTokenCount
                  : undefined;
        const usageDetails = extractProviderUsageDetails(
          [
            row as unknown as Record<string, unknown>,
            row.usage as Record<string, unknown> | undefined,
            row.usageMetadata as Record<string, unknown> | undefined,
          ],
          rOut,
        );

        if (
          rIn !== undefined ||
          rOut !== undefined ||
          typeof row.token_count === "number" ||
          usageDetails.reasoningSource === "exact"
        ) {
          acc.hasExact = true;
          const inTok = Math.max(
            0,
            Math.round(
              rIn ?? (rOut === undefined && usageDetails.outputTokens === 0 ? (row.token_count ?? 0) : 0),
            ),
          );
          const outTok = usageDetails.outputTokens;
          const cachedTok = usageDetails.cachedTokens;
          acc.exactInput += inTok;
          acc.exactOutput += outTok;
          acc.exactCached += cachedTok;
          if (usageDetails.cacheSplitKnown) {
            acc.hasCacheSplit = true;
            acc.exactCacheRead += usageDetails.cacheReadTokens ?? 0;
            acc.exactCacheWrite += usageDetails.cacheWriteTokens ?? 0;
          } else if (cachedTok > 0) {
            acc.hasUnsplitCached = true;
          }
          if (usageDetails.reasoningTokens !== undefined) {
            acc.hasExactReasoning = true;
            acc.exactReasoning += usageDetails.reasoningTokens;
          }
          acc.lastTurnContext = inTok + cachedTok;
        }
        const rawCost =
          typeof row.costUsd === "number"
            ? row.costUsd
            : typeof row.cost_usd === "number"
              ? row.cost_usd
              : typeof row.usage?.costUsd === "number"
                ? (row.usage.costUsd as number)
                : typeof row.usage?.cost_usd === "number"
                  ? (row.usage.cost_usd as number)
                  : undefined;
        if (typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0) {
          acc.costUsd = (acc.costUsd ?? 0) + rawCost;
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
        const isCreatedSubagentRow = CREATED_SUBAGENT_RE.test(content);
        if (rtype === "GENERIC" || isCreatedSubagentRow) {
          const mSub = CREATED_SUBAGENT_RE.exec(content);
          if (mSub?.[2] && mSub[2] !== cid) {
            const childCid = mSub[2];
            let spawnedId: string | undefined;
            let spawnedRole = "";
            let requestedModel: string | undefined;
            let spawnEvent: EnrichedEvent | undefined;

            const matchingIndices = pendingSpawns
              .map((p, pIdx) => (p.parentCid === cid ? pIdx : -1))
              .filter((pIdx) => pIdx >= 0);

            let spawnIdx = matchingIndices[0] ?? -1;

            if (matchingIndices.length > 1) {
              // Correlate parallel pendingSpawns by child transcript initial message or JSON hint
              let createdMeta: Record<string, unknown> | undefined;
              try {
                if (mSub[1]) {
                  const parsed: unknown = JSON.parse(mSub[1]);
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    createdMeta = parsed as Record<string, unknown>;
                  }
                }
              } catch {
                // ignore
              }
              const metaHint = String(
                createdMeta?.type ??
                  createdMeta?.TypeName ??
                  createdMeta?.role ??
                  createdMeta?.Role ??
                  createdMeta?.name ??
                  "",
              )
                .trim()
                .toLowerCase();

              let childMsg = "";
              if (!childRowsCache.has(childCid)) {
                const childPath = path.join(
                  this.brainDir,
                  childCid,
                  ".system_generated",
                  "logs",
                  "transcript.jsonl",
                );
                childRowsCache.set(childCid, await readJsonlRows(childPath));
              }
              const cRows = childRowsCache.get(childCid) ?? [];
              const firstSys = cRows.find(
                (cr) => cr.type === "SYSTEM_MESSAGE" && cr.content,
              );
              if (firstSys?.content) {
                const mContent = /content=(.+)/s.exec(firstSys.content);
                childMsg = (mContent?.[1] ?? firstSys.content)
                  .replace(/\s+/g, " ")
                  .trim();
              }

              if (childMsg) {
                const promptMatch = matchingIndices.find((pIdx) => {
                  const pPrompt = pendingSpawns[pIdx]!.prompt
                    .replace(/\s+/g, " ")
                    .trim();
                  if (!pPrompt) return false;
                  const prefix = pPrompt.slice(0, 60);
                  return (
                    childMsg === pPrompt ||
                    childMsg.includes(prefix) ||
                    pPrompt.includes(childMsg.slice(0, 60))
                  );
                });
                if (promptMatch !== undefined) {
                  spawnIdx = promptMatch;
                }
              } else if (metaHint) {
                const roleMatch = matchingIndices.find((pIdx) => {
                  const cand = pendingSpawns[pIdx]!;
                  return (
                    cand.targetId.toLowerCase() === metaHint ||
                    cand.role.toLowerCase() === metaHint
                  );
                });
                if (roleMatch !== undefined) {
                  spawnIdx = roleMatch;
                }
              }
            }

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
          const openAsk = [...openToolCalls]
            .reverse()
            .find(
              (tc) =>
                tc.toolName === "ask_question" ||
                (tc.toolName === "notify_user" && tc.blockedOnUser),
            );
          pruneStaleNotify();
          const clean = cleanHumanSummary(content, 130);
          if (clean) {
            const inlineBody = content.slice(0, 1400);
            rawEvents.push(
              makeEvent({
                epoch,
                agentId: senderId,
                targetAgentId: senderId,
                kind: "user_input",
                ...(openAsk
                  ? { toolCallId: `${openAsk.toolCallId}:answer` }
                  : {}),
                summary: `Human: ${clean}`,
                payload: {
                  body: inlineBody,
                  conv: cid,
                  ...(openAsk
                    ? {
                        isHumanAnswer: true,
                        questionToolCallId: openAsk.toolCallId,
                        ...(openAsk.questionPrompt
                          ? { questionPrompt: openAsk.questionPrompt }
                          : {}),
                        targetAgentId: senderId,
                      }
                    : {}),
                },
                fullBody: content,
                inlineBody,
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

        // 4. GENERIC tool result row closes oldest open tool call (when status !== RUNNING and not subagent-create row)
        if (rtype === "GENERIC" && !isCreatedSubagentRow) {
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
            if (
              !isErr &&
              (finished.toolName === "ask_question" ||
                (finished.toolName === "notify_user" && finished.blockedOnUser)) &&
              content.trim()
            ) {
              const answerText = extractAntigravityAnswerText(content);
              if (answerText) {
                const cleanAns =
                  cleanHumanSummary(answerText, 130) || answerText.slice(0, 130);
                const inlineBody = answerText.slice(0, 1400);
                rawEvents.push(
                  makeEvent({
                    epoch: epoch + 0.0002,
                    agentId: senderId,
                    targetAgentId: senderId,
                    kind: "user_input",
                    toolCallId: `${finished.toolCallId}:answer`,
                    summary: `Human: ${cleanAns}`,
                    payload: {
                      isHumanAnswer: true,
                      questionToolCallId: finished.toolCallId,
                      ...(finished.questionPrompt
                        ? { questionPrompt: finished.questionPrompt }
                        : {}),
                      targetAgentId: senderId,
                      body: inlineBody,
                      conv: cid,
                    },
                    fullBody: answerText,
                    inlineBody,
                  }),
                );
              }
            }
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

        // 5. PLANNER_RESPONSE tool calls & prose/thinking
        const plannerThinking =
          rtype === "PLANNER_RESPONSE" && typeof row.thinking === "string"
            ? row.thinking.trim()
            : "";
        if (plannerThinking) {
          const inlineThink = plannerThinking.slice(0, THINKING_INLINE_MAX);
          rawEvents.push(
            makeEvent({
              epoch: epoch - 0.0002,
              agentId: senderId,
              kind: "thinking_start",
              summary: cleanHumanSummary(plannerThinking, 120) || "Thinking…",
              payload: { body: inlineThink, isThought: true, conv: cid },
              fullBody: plannerThinking,
              inlineBody: inlineThink,
            }),
          );
        }

        if (toolCalls.length > 0) {
          pruneStaleNotify();

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
              const inlinePrompt = prompt.slice(0, 1000);
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
                  prompt: inlinePrompt,
                  conv: cid,
                },
                fullBody: prompt,
                inlineBody: inlinePrompt,
              });
              rawEvents.push(spawnEvent);
              pendingSpawns.push({
                parentCid: cid,
                targetId: targetSlug,
                role,
                prompt,
                requestedModel: requestedModel || undefined,
                spawnEvent,
              });
            } else if (tname === "manage_subagents") {
              const action = unquoteArg(
                args.Action ?? args.action ?? args.Operation ?? args.operation,
              ).toLowerCase();
              const targetCid = unquoteArg(
                args.ConversationId ??
                  args.conversationId ??
                  args.SubagentId ??
                  args.subagentId ??
                  args.Id ??
                  args.id,
              );
              const isCancel =
                action === "cancel" ||
                action === "stop" ||
                action === "terminate" ||
                action === "kill" ||
                args.Cancel === true ||
                args.cancel === "true";
              if (isCancel && targetCid) {
                rawEvents.push(
                  makeEvent({
                    epoch: epoch + tcIdx * 0.0001,
                    agentId: targetCid,
                    targetAgentId: targetCid,
                    kind: "subagent_done",
                    toolName: tname,
                    toolCallId,
                    summary: "Canceled by user",
                    status: "ok",
                    payload: { canceled: true, action: action || "cancel", conv: cid },
                  }),
                );
              } else {
                rawEvents.push(
                  makeEvent({
                    epoch: epoch + tcIdx * 0.0001,
                    agentId: senderId,
                    kind: "tool_start",
                    toolName: tname,
                    toolCallId,
                    summary: actionText,
                    payload: { args, conv: cid },
                  }),
                );
                openToolCalls.push({
                  toolCallId,
                  toolName: tname,
                  summary: actionText,
                  isSelfDaemon: false,
                });
              }
            } else if (tname === "send_message") {
              const recipientRaw = unquoteArg(args.Recipient);
              const body = unquoteArg(args.Message);
              if (UUID_RE.test(recipientRaw) && !visited.has(recipientRaw)) {
                queue.push(recipientRaw);
              }
              const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
              const msgSummary =
                cleanHumanSummary(firstLine || body, 140) || "Peer message";
              const inlineBody = body.slice(0, 1400);
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
                    body: inlineBody,
                    recipientRaw,
                    conv: cid,
                  },
                  fullBody: body,
                  inlineBody,
                }),
              );
            } else if (tname === "notify_user") {
              const body = unquoteArg(args.Message) || "Updated user";
              const blockedOnUser =
                args.BlockedOnUser === true ||
                unquoteArg(args.BlockedOnUser).toLowerCase() === "true";
              const firstLine = body.split(/\r?\n/, 1)[0] ?? body;
              const notifySummary = cleanHumanSummary(`To Human: ${firstLine}`, 140);
              const inlineBody = body.slice(0, 1400);
              const blockedQuestions = blockedOnUser
                ? [
                    {
                      question: body,
                      type: "text" as const,
                      options: [],
                      allowCustomInput: true,
                    },
                  ]
                : undefined;
              rawEvents.push(
                makeEvent({
                  epoch: epoch + tcIdx * 0.0001,
                  agentId: senderId,
                  targetAgentId: "human",
                  kind: "message",
                  toolName: tname,
                  toolCallId,
                  summary: notifySummary,
                  ...(blockedOnUser ? { waitingReason: "user" as const } : {}),
                  payload: {
                    body: inlineBody,
                    conv: cid,
                    ...(blockedOnUser
                      ? {
                          blockedOnUser: true,
                          questions: blockedQuestions,
                          promptTitle:
                            cleanHumanSummary(firstLine, 120) ||
                            "Message from agent",
                          promptKind: "question",
                          blockingToolCall: false,
                        }
                      : {}),
                  },
                  fullBody: body,
                  inlineBody,
                }),
              );
              if (blockedOnUser) {
                openToolCalls.push({
                  toolCallId,
                  toolName: tname,
                  summary: notifySummary,
                  isSelfDaemon: false,
                  questionPrompt: body.trim().slice(0, 500) || notifySummary,
                  blockedOnUser: true,
                });
              }
            } else if (tname === "ask_question") {
              const parsedQuestions = normalizePendingQuestions(
                args.questions ?? args,
                { defaultAllowCustomInput: true },
              );
              const qSummary = parsedQuestions[0]?.question
                ? cleanHumanSummary(parsedQuestions[0].question, 100)
                : "Asked user a question";
              rawEvents.push(
                makeEvent({
                  epoch: epoch + tcIdx * 0.0001,
                  agentId: senderId,
                  targetAgentId: "human",
                  kind: "tool_start",
                  toolName: tname,
                  toolCallId,
                  summary: qSummary || "Asked user a question",
                  waitingReason: "user",
                  payload: {
                    args,
                    conv: cid,
                    questions: parsedQuestions,
                    promptTitle: qSummary || "Question for you",
                    promptKind: "question",
                    blockingToolCall: true,
                  },
                }),
              );
              const questionPrompt =
                parsedQuestions
                  .map((q) => q.question.trim())
                  .filter(Boolean)
                  .join(" / ")
                  .slice(0, 500) ||
                qSummary ||
                "Asked user a question";
              openToolCalls.push({
                toolCallId,
                toolName: tname,
                summary: qSummary || "Asked user a question",
                isSelfDaemon: false,
                questionPrompt,
                blockedOnUser: true,
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
        } else if (rtype === "PLANNER_RESPONSE" && (content.trim() || plannerThinking)) {
          pruneStaleNotify();
          if (content.trim()) {
            // Clean assistant yield without tool calls
            const kind =
              senderId === rootId ? "assistant_turn_end" : "subagent_done";
            const inlineBody = content.slice(0, 1000);
            rawEvents.push(
              makeEvent({
                epoch,
                agentId: senderId,
                kind,
                summary: cleanHumanSummary(content, 140),
                payload: { body: inlineBody, conv: cid },
                fullBody: content,
                inlineBody,
              }),
            );
          }
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
      if (ev.payload?.isHumanAnswer && ev.payload.targetAgentId) {
        ev.payload.targetAgentId = ev.targetAgentId ?? ev.agentId;
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
      const hasSplit = acc.hasExact && acc.hasCacheSplit && !acc.hasUnsplitCached;
      const usageDelta: UsageDelta = {
        model: acc.model,
        modelSource: acc.model ? acc.modelSource : "unknown",
        usageSource: acc.hasExact ? "exact" : "estimated",
        inputTokens,
        outputTokens,
        cachedTokens,
        ...(hasSplit
          ? {
              cacheReadTokens: acc.exactCacheRead,
              cacheWriteTokens: acc.exactCacheWrite,
            }
          : {}),
        ...(acc.hasExact && acc.hasExactReasoning
          ? {
              reasoningTokens: Math.min(outputTokens, acc.exactReasoning),
              reasoningSource: "exact" as const,
            }
          : {}),
        ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
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

    if (opts?.onFullBody) {
      for (const [ev, raw] of fullBodies.entries()) {
        opts.onFullBody(ev.id, raw);
      }
    }

    return rawEvents;
  }
}
