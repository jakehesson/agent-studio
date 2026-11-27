import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  capChatText,
  cleanHumanSummary,
  computeDeterministicEventId,
  computeMergeKey,
  computePendingPromptId,
  extractProviderUsageDetails,
  formatQuestionsPreview,
  isBoardMutationToolCall,
  isSelfDaemonCommand,
  normalizePendingQuestions,
  normalizeWsPath,
  parseEpochSeconds,
  prettifyAgentLabel,
  prettifyModelName,
  summarizeToolCall,
  toIsoUtc,
  type AdapterHealth,
  type AgentChatMessage,
  type AgentStatus,
  type ChatToolCallRef,
  type DiscoveredSession,
  type EnrichedEvent,
  type ParseChatOptions,
  type ParseSessionOptions,
  type PassiveIdeAdapter,
  type UsageDelta,
} from "../types.js";
import {
  getKnownProjects,
  matchProjectIdForWorkspaces,
} from "./project-match.js";

const SKIP_TYPES = new Set([
  "api-request",
  "api-request-shape",
  "api-request-blob",
  "cost-state",
  "last-prompt",
  "atis-latch",
  "queue-operation",
  "attachment",
]);
const THINKING_INLINE_MAX = 800;

function formatClaudeAnswerValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val.trim();
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) {
    return val.map(formatClaudeAnswerValue).filter(Boolean).join(", ");
  }
  if (typeof val === "object") {
    return Object.entries(val as Record<string, unknown>)
      .map(([k, v]) => {
        const formatted = formatClaudeAnswerValue(v);
        if (!formatted) return "";
        return k.trim() ? `${k.trim()}: ${formatted}` : formatted;
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractClaudeAnswerText(
  toolUseResult: ClaudeRow["toolUseResult"],
  resultText: string,
): string {
  if (
    toolUseResult &&
    typeof toolUseResult === "object" &&
    "answers" in toolUseResult &&
    toolUseResult.answers !== undefined
  ) {
    const formatted = formatClaudeAnswerValue(toolUseResult.answers);
    if (formatted) return formatted;
  }
  const trimmedResult = resultText.trim();
  if (trimmedResult) return trimmedResult;
  if (typeof toolUseResult === "string" && toolUseResult.trim()) {
    return toolUseResult.trim();
  }
  return "";
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRow {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  agentId?: string;
  totalCostUSD?: number;
  toolUseResult?: { agentId?: string; answers?: unknown; [key: string]: unknown } | string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: string | ClaudeContentBlock[];
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

export interface ClaudeCodeAdapterOptions {
  projectsDir?: string;
}

function encodeCwdVariants(root: string): string[] {
  const resolved = path.resolve(root).replace(/\\/g, "/").replace(/\/+$/, "");
  const basic = resolved
    .replace(/^([A-Za-z]):\//, "$1--")
    .replace(/\//g, "-");
  const dotNorm = resolved
    .replace(/^([A-Za-z]):\//, "$1--")
    .replace(/[/. _]/g, "-");
  return [...new Set([basic.toLowerCase(), dotNorm.toLowerCase()])];
}

function resolveEncodedFolderWorkspace(
  folder: string,
  candidateRoots: ReadonlyArray<string>,
): string | undefined {
  const lowFolder = folder.toLowerCase();
  for (const root of candidateRoots) {
    if (!root) continue;
    if (encodeCwdVariants(root).includes(lowFolder)) {
      return normalizeWsPath(root);
    }
  }
  return decodeEncodedCwd(folder);
}

function decodeEncodedCwd(encodedDirName: string): string | undefined {
  if (!encodedDirName) return undefined;
  // Windows encoding: C--Projects-MyApp -> c:/Projects/MyApp (best-effort when cwd field missing)
  const winMatch = /^([A-Za-z])--(.+)$/.exec(encodedDirName);
  if (winMatch?.[1] && winMatch[2]) {
    return normalizeWsPath(`${winMatch[1]}:/${winMatch[2].replace(/-/g, "/")}`);
  }
  if (encodedDirName.startsWith("-")) {
    return normalizeWsPath("/" + encodedDirName.slice(1).replace(/-/g, "/"));
  }
  return undefined;
}

async function readClaudeJsonl(filePath: string): Promise<ClaudeRow[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const rows: ClaudeRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rows.push(parsed as ClaudeRow);
      }
    } catch {
      // Ignore partial/truncated lines during live writes.
    }
  }
  return rows;
}

function extractTextFromContent(
  content: string | ClaudeContentBlock[] | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n");
}

interface CachedClaudeDiscoveryMeta {
  mtimeMs: number;
  sizeBytes: number;
  cwd?: string;
  title: string;
  isMultiAgent: boolean;
  waitingOn: "user" | "tool_approval" | "subagent" | null;
  pendingQuestionCount: number;
  waitingSummary?: string;
  tailStatus?: AgentStatus;
}

export class ClaudeCodeAdapter implements PassiveIdeAdapter {
  readonly ide = "claude-code" as const;
  private readonly projectsDir: string;
  private readonly discoveryCache = new Map<string, CachedClaudeDiscoveryMeta>();

  constructor(options?: ClaudeCodeAdapterOptions) {
    this.projectsDir =
      options?.projectsDir ??
      process.env.CLAUDE_PROJECTS_DIR?.trim() ??
      path.join(os.homedir(), ".claude", "projects");
  }

  getProjectsDir(): string {
    return this.projectsDir;
  }

  async getHealth(): Promise<AdapterHealth> {
    try {
      const st = await fs.stat(this.projectsDir);
      if (!st.isDirectory()) {
        return {
          ide: this.ide,
          status: "degraded",
          rootDir: this.projectsDir,
          sessionsFound: 0,
          message: "Claude projects path is not a directory",
        };
      }
      const sessions = await this.discoverSessions({ limit: 50 });
      return {
        ide: this.ide,
        status: "ok",
        rootDir: this.projectsDir,
        sessionsFound: sessions.length,
      };
    } catch {
      return {
        ide: this.ide,
        status: "degraded",
        rootDir: this.projectsDir,
        sessionsFound: 0,
        message: "Claude Code projects directory not found",
      };
    }
  }

  async discoverSessions(opts?: {
    limit?: number;
    workspaceRoots?: string[];
  }): Promise<DiscoveredSession[]> {
    let projectFolders: string[];
    try {
      projectFolders = await fs.readdir(this.projectsDir);
    } catch {
      return [];
    }

    const knownProjects = getKnownProjects();
    const candidateRoots = [
      ...(opts?.workspaceRoots ?? []),
      ...knownProjects.map((p) => p.root),
    ];
    const limit = opts?.limit ?? 100;

    interface ClaudeCandidate {
      folder: string;
      folderPath: string;
      sessionId: string;
      filePath: string;
      mtimeMs: number;
      sizeBytes: number;
      hasSubagentFiles: boolean;
    }
    const candidates: ClaudeCandidate[] = [];

    for (const folder of projectFolders) {
      const folderPath = path.join(this.projectsDir, folder);
      let st;
      try {
        st = await fs.stat(folderPath);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }

      let files: string[];
      try {
        files = await fs.readdir(folderPath);
      } catch {
        continue;
      }

      for (const fname of files) {
        if (!fname.endsWith(".jsonl")) continue;
        const filePath = path.join(folderPath, fname);
        let fst;
        try {
          fst = await fs.stat(filePath);
          if (!fst.isFile() || fst.size === 0) continue;
        } catch {
          continue;
        }

        const sessionId = fname.slice(0, -".jsonl".length);
        let maxMtimeMs = fst.mtimeMs;
        let hasSubagentFiles = false;
        const subDir = path.join(folderPath, sessionId, "subagents");
        try {
          const subFiles = await fs.readdir(subDir);
          for (const sf of subFiles) {
            if (!sf.endsWith(".jsonl")) continue;
            hasSubagentFiles = true;
            try {
              const sst = await fs.stat(path.join(subDir, sf));
              if (sst.isFile() && sst.mtimeMs > maxMtimeMs) {
                maxMtimeMs = sst.mtimeMs;
              }
            } catch {
              // ignore unreadable subagent stat
            }
          }
        } catch {
          // No subagents dir.
        }

        candidates.push({
          folder,
          folderPath,
          sessionId,
          filePath,
          mtimeMs: maxMtimeMs,
          sizeBytes: fst.size,
          hasSubagentFiles,
        });
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const sessions: DiscoveredSession[] = [];

    for (const cand of candidates.slice(0, limit * 2)) {
      let meta = this.discoveryCache.get(cand.filePath);
      if (
        !meta ||
        meta.mtimeMs !== cand.mtimeMs ||
        meta.sizeBytes !== cand.sizeBytes
      ) {
        let headText = "";
        let tailText = "";
        try {
          const fh = await fs.open(cand.filePath, "r");
          try {
            const headBuf = Buffer.alloc(Math.min(cand.sizeBytes, 32768));
            const { bytesRead } = await fh.read(headBuf, 0, headBuf.length, 0);
            headText = headBuf.subarray(0, bytesRead).toString("utf8");
            if (cand.sizeBytes > 32768) {
              const tailLen = 32768;
              const tailBuf = Buffer.alloc(tailLen);
              const tailOffset = Math.max(0, cand.sizeBytes - tailLen);
              const tailRes = await fh.read(tailBuf, 0, tailLen, tailOffset);
              tailText = tailBuf.subarray(0, tailRes.bytesRead).toString("utf8");
            } else {
              tailText = headText;
            }
          } finally {
            await fh.close();
          }
        } catch {
          continue;
        }

        let cwd: string | undefined;
        let title = `Claude ${cand.sessionId.slice(0, 8)}`;
        let isMultiAgent = cand.hasSubagentFiles;

        for (const line of headText.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          try {
            const row = JSON.parse(t) as ClaudeRow;
            if (!cwd && row.cwd) {
              cwd = normalizeWsPath(row.cwd);
            }
            if (row.isSidechain) {
              isMultiAgent = true;
            }
            if (row.type === "user" && title.startsWith("Claude ")) {
              const txt = extractTextFromContent(row.message?.content)
                .replace(/\s+/g, " ")
                .trim();
              if (txt) title = txt.slice(0, 80);
            }
            if (row.type === "assistant" && Array.isArray(row.message?.content)) {
              for (const b of row.message.content) {
                if (
                  b.type === "tool_use" &&
                  (b.name === "Agent" || b.name === "Task" || b.name === "SendMessage")
                ) {
                  isMultiAgent = true;
                }
              }
            }
          } catch {
            // ignore
          }
        }

        let pendingAskCallId: string | null = null;
        let pendingQuestionCount = 0;
        let waitingSummary: string | undefined;
        let tailStatus: AgentStatus | undefined;

        for (const line of tailText.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          try {
            const row = JSON.parse(t) as ClaudeRow;
            if (!cwd && row.cwd) cwd = normalizeWsPath(row.cwd);
            if (row.isSidechain) isMultiAgent = true;
            if (row.type === "user") {
              const content = row.message?.content;
              if (Array.isArray(content)) {
                let hasUserText = false;
                for (const b of content) {
                  if (b.type === "tool_result") {
                    if (pendingAskCallId && (!b.tool_use_id || b.tool_use_id === pendingAskCallId)) {
                      pendingAskCallId = null;
                      pendingQuestionCount = 0;
                      waitingSummary = undefined;
                      if (tailStatus === "WAITING") {
                        tailStatus = "WORKING";
                      }
                    }
                  } else if (b.type === "text" && b.text?.trim()) {
                    hasUserText = true;
                  }
                }
                if (hasUserText) {
                  pendingAskCallId = null;
                  pendingQuestionCount = 0;
                  waitingSummary = undefined;
                  tailStatus = "THINKING";
                }
              } else if (typeof content === "string" && content.trim()) {
                pendingAskCallId = null;
                pendingQuestionCount = 0;
                waitingSummary = undefined;
                tailStatus = "THINKING";
              }
            } else if (row.type === "assistant") {
              const blocks = Array.isArray(row.message?.content)
                ? row.message.content
                : [];
              let hasTool = false;
              for (const b of blocks) {
                if (b.type === "tool_use") {
                  hasTool = true;
                  if (b.name === "AskUserQuestion") {
                    const qs = normalizePendingQuestions(b.input ?? {}, {
                      defaultAllowCustomInput: true,
                    });
                    pendingAskCallId = b.id ?? "__ask__";
                    pendingQuestionCount = Math.max(1, qs.length);
                    waitingSummary =
                      cleanHumanSummary(
                        qs[0]?.header ?? qs[0]?.question ?? "Asked user a question",
                        80,
                      ) || "Asked user a question";
                    tailStatus = "WAITING";
                  } else {
                    pendingAskCallId = null;
                    pendingQuestionCount = 0;
                    waitingSummary = undefined;
                    tailStatus = "WORKING";
                  }
                }
              }
              if (row.message?.stop_reason === "end_turn" && !hasTool) {
                pendingAskCallId = null;
                pendingQuestionCount = 0;
                waitingSummary = undefined;
                tailStatus = "DONE";
              }
            }
          } catch {
            // ignore partial leading/trailing line
          }
        }

        meta = {
          mtimeMs: cand.mtimeMs,
          sizeBytes: cand.sizeBytes,
          cwd,
          title,
          isMultiAgent,
          waitingOn: pendingAskCallId ? "user" : null,
          pendingQuestionCount,
          waitingSummary,
          tailStatus,
        };
        this.discoveryCache.set(cand.filePath, meta);
      }

      const decodedFolderWs = resolveEncodedFolderWorkspace(
        cand.folder,
        candidateRoots,
      );
      const workspaces = [
        ...(meta.cwd ? [meta.cwd] : []),
        ...(decodedFolderWs && decodedFolderWs !== meta.cwd
          ? [decodedFolderWs]
          : []),
      ];
      const workspacePath = workspaces[0];
      const projectId =
        matchProjectIdForWorkspaces(workspaces, knownProjects) ??
        (workspacePath ? path.basename(workspacePath) : undefined);

      sessions.push({
        ide: this.ide,
        sessionId: cand.sessionId,
        filePath: cand.filePath,
        workspacePath,
        workspaces,
        projectId,
        title: meta.title,
        mtimeMs: cand.mtimeMs,
        sizeBytes: cand.sizeBytes,
        isMultiAgent: meta.isMultiAgent,
        ...(meta.tailStatus ? { status: meta.tailStatus } : {}),
        waitingOn: meta.waitingOn,
        pendingQuestionCount: meta.pendingQuestionCount,
        ...(meta.waitingSummary ? { waitingSummary: meta.waitingSummary } : {}),
        ...(meta.waitingOn ? { isWaiting: true } : {}),
      });
    }

    return sessions.slice(0, limit);
  }

  async parseSession(
    session: DiscoveredSession,
    opts?: ParseSessionOptions,
  ): Promise<EnrichedEvent[]> {
    const res = await this.parseSessionInternal(session, opts);
    return res.events;
  }

  async parseChat(
    session: DiscoveredSession,
    opts?: ParseChatOptions,
  ): Promise<AgentChatMessage[]> {
    const res = await this.parseSessionInternal(session, { includeChat: true });
    const reqAgent = opts?.agentId?.trim();
    const filtered = reqAgent
      ? res.chatMessages.filter((m) => m.agentId === reqAgent)
      : res.chatMessages;
    filtered.sort((a, b) => a.epoch - b.epoch);
    return filtered;
  }

  private async parseSessionInternal(
    session: DiscoveredSession,
    opts?: ParseSessionOptions & { includeChat?: boolean },
  ): Promise<{ events: EnrichedEvent[]; chatMessages: AgentChatMessage[] }> {
    const mainRows = await readClaudeJsonl(session.filePath);
    if (mainRows.length === 0) return { events: [], chatMessages: [] };

    const knownProjects = getKnownProjects();
    const allWorkspaces = [...session.workspaces];
    let workspacePath = session.workspacePath;
    for (const r of mainRows) {
      if (r.cwd) {
        const norm = normalizeWsPath(r.cwd);
        if (!workspacePath) workspacePath = norm;
        if (!allWorkspaces.includes(norm)) allWorkspaces.push(norm);
      }
    }
    const projectId =
      matchProjectIdForWorkspaces(
        [workspacePath, ...allWorkspaces],
        knownProjects,
      ) ?? session.projectId;

    const includeChat = Boolean(opts?.includeChat);
    const events: EnrichedEvent[] = [];
    const chatMessages: AgentChatMessage[] = [];
    const chatToolRefById = new Map<string, ChatToolCallRef>();
    const seenChatToolUseIds = new Set<string>();
    const lastAssistantByMsgId = new Map<string, AgentChatMessage>();
    const assistantProseByMsgId = new Map<string, string>();
    const mergeStreamingText = (
      prev: string | undefined,
      next: string,
    ): string => {
      const a = (prev ?? "").trim();
      const b = next.trim();
      if (!a) return b;
      if (!b) return a;
      if (a === b || a.includes(b)) return a;
      if (b.startsWith(a) || b.includes(a)) return b;
      return `${a}\n\n${b}`;
    };
    const spawnToolUseMap = new Map<
      string,
      {
        callId: string;
        targetAgentId: string;
        agentLabel: string;
        prompt: string;
        matchedSubId?: string;
        matchedFromResult?: string;
        spawnEvent?: EnrichedEvent;
        doneEvent?: EnrichedEvent;
        chatSpawnMsg?: AgentChatMessage;
      }
    >();
    const spawnRecords: Array<{
      callId: string;
      targetAgentId: string;
      agentLabel: string;
      prompt: string;
      matchedSubId?: string;
      matchedFromResult?: string;
      spawnEvent?: EnrichedEvent;
      doneEvent?: EnrichedEvent;
      chatSpawnMsg?: AgentChatMessage;
    }> = [];
    const toolSummaryMap = new Map<
      string,
      {
        toolName: string;
        summary: string;
        isAskQuestion?: boolean;
        questionPrompt?: string;
      }
    >();

    interface ClaudeUsageAcc {
      model?: string;
      hasExact: boolean;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      hasCacheSplit: boolean;
      hasUnsplitCached: boolean;
      reasoningTokens: number;
      hasExactReasoning: boolean;
      lastTurnContext: number;
      estInputChars: number;
      estOutputChars: number;
      costUsd?: number;
    }
    const usageAccByAgent = new Map<string, ClaudeUsageAcc>();
    const ensureAcc = (aid: string): ClaudeUsageAcc => {
      let acc = usageAccByAgent.get(aid);
      if (!acc) {
        acc = {
          hasExact: false,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          hasCacheSplit: false,
          hasUnsplitCached: false,
          reasoningTokens: 0,
          hasExactReasoning: false,
          lastTurnContext: 0,
          estInputChars: 0,
          estOutputChars: 0,
        };
        usageAccByAgent.set(aid, acc);
      }
      return acc;
    };

    const resolveRowAgentId = (
      row: ClaudeRow,
      defaultAgentId: string,
    ): { agentId: string; parentAgentId?: string } => {
      const isInlineSidechain =
        defaultAgentId === "root" && row.isSidechain === true;
      const agentId = isInlineSidechain
        ? row.agentId
          ? `agent-${row.agentId}`
          : `sidechain-${(row.parentUuid ?? row.uuid ?? "sub").slice(0, 6)}`
        : defaultAgentId;
      return {
        agentId,
        parentAgentId: isInlineSidechain ? "root" : undefined,
      };
    };

    const parseRowsForAgent = (
      rows: ClaudeRow[],
      defaultAgentId: string,
      defaultParentAgentId?: string,
      defaultLabel?: string,
    ): void => {
      // Pre-pass: deduplicate streaming type:"assistant" usage per (agentId, row.message.id),
      // keeping the final row (stop_reason != null / highest output_tokens).
      const finalUsageRowByMsg = new Map<
        string,
        { rowIdx: number; hasStop: boolean; outTok: number }
      >();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        if (row.type !== "assistant") continue;
        const usage = row.message?.usage;
        if (
          !usage ||
          (typeof usage.input_tokens !== "number" &&
            typeof usage.output_tokens !== "number")
        ) {
          continue;
        }
        const { agentId } = resolveRowAgentId(row, defaultAgentId);
        const msgId = row.message?.id;
        const key = msgId ? `${agentId}\0${msgId}` : `__row_${i}`;
        const hasStop = row.message?.stop_reason != null;
        const outTok = Math.max(0, Math.round(usage.output_tokens ?? 0));
        const prev = finalUsageRowByMsg.get(key);
        if (
          !prev ||
          (hasStop && !prev.hasStop) ||
          (hasStop === prev.hasStop && outTok >= prev.outTok)
        ) {
          finalUsageRowByMsg.set(key, { rowIdx: i, hasStop, outTok });
        }
      }
      const selectedUsageIndices = new Set<number>(
        [...finalUsageRowByMsg.values()].map((v) => v.rowIdx),
      );

      let fallbackEpoch = session.mtimeMs / 1000 - Math.max(rows.length, 1);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const rtype = row.type ?? "";
        if (rtype === "cost-state" && typeof row.totalCostUSD === "number") {
          const acc = ensureAcc(defaultAgentId);
          acc.costUsd = Math.max(acc.costUsd ?? 0, row.totalCostUSD);
          continue;
        }
        if (!rtype || SKIP_TYPES.has(rtype)) continue;

        const epoch = parseEpochSeconds(row.timestamp, fallbackEpoch + i);
        fallbackEpoch = epoch;

        // Flat sidechain fallback when subagent messages are logged inline with isSidechain: true
        const resolvedIds = resolveRowAgentId(row, defaultAgentId);
        const agentId = resolvedIds.agentId;
        const parentAgentId = resolvedIds.parentAgentId ?? defaultParentAgentId;
        const agentLabel =
          defaultLabel ??
          (agentId === "root" ? "Coordinator" : prettifyAgentLabel(agentId));

        // Capture model & exact/estimated token usage for this agent
        const acc = ensureAcc(agentId);
        if (typeof row.message?.model === "string" && row.message.model.trim()) {
          const pretty = prettifyModelName(row.message.model);
          if (pretty) acc.model = pretty;
        }
        const usage = row.message?.usage;
        if (
          usage &&
          (rtype !== "assistant" || selectedUsageIndices.has(i)) &&
          (typeof usage.input_tokens === "number" ||
            typeof usage.output_tokens === "number")
        ) {
          acc.hasExact = true;
          const inTok = Math.max(0, Math.round(usage.input_tokens ?? 0));
          const details = extractProviderUsageDetails(
            [usage as Record<string, unknown>],
            usage.output_tokens,
          );
          const outTok = details.outputTokens;
          const cachedTok = details.cachedTokens;
          acc.inputTokens += inTok;
          acc.outputTokens += outTok;
          acc.cachedTokens += cachedTok;
          if (details.cacheSplitKnown) {
            acc.hasCacheSplit = true;
            acc.cacheReadTokens += details.cacheReadTokens ?? 0;
            acc.cacheWriteTokens += details.cacheWriteTokens ?? 0;
          } else if (cachedTok > 0) {
            acc.hasUnsplitCached = true;
          }
          if (details.reasoningTokens !== undefined) {
            acc.hasExactReasoning = true;
            acc.reasoningTokens += details.reasoningTokens;
          }
          // Set to latest deduplicated turn (not Math.max) so /compact drops context properly
          acc.lastTurnContext = inTok + cachedTok + outTok;
        }
        const rawContent = row.message?.content;
        const contentChars =
          typeof rawContent === "string"
            ? rawContent.length
            : Array.isArray(rawContent)
              ? JSON.stringify(rawContent).length
              : 0;
        if (rtype === "user") {
          acc.estInputChars += contentChars;
        } else if (rtype === "assistant") {
          acc.estOutputChars += contentChars;
        }

        const emit = (input: {
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
          offset?: number;
          fullBody?: string;
          inlineBody?: string;
        }): EnrichedEvent => {
          const evEpoch = epoch + (input.offset ?? 0);
          const id = computeDeterministicEventId({
            ide: this.ide,
            sessionId: session.sessionId,
            agentId,
            kind: input.kind,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            epoch: evEpoch,
            summary: input.summary,
          });
          const mergeKey = computeMergeKey({
            sessionId: session.sessionId,
            agentId,
            kind: input.kind,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            epoch: evEpoch,
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
            ts: toIsoUtc(evEpoch),
            epoch: evEpoch,
            ide: this.ide,
            channel: "passive",
            sessionId: session.sessionId,
            workspacePath,
            projectId,
            agentId,
            agentLabel,
            parentAgentId,
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
          events.push(ev);
          if (hasBody) {
            opts?.onFullBody?.(id, input.fullBody!);
          }
          return ev;
        };

        if (rtype === "user") {
          const content = row.message?.content;
          if (Array.isArray(content)) {
            let hadToolResult = false;
            content.forEach((block, bIdx) => {
              if (block.type === "tool_result") {
                hadToolResult = true;
                const callId = block.tool_use_id ?? `${row.uuid ?? i}:${bIdx}`;
                const spawnInfo = spawnToolUseMap.get(callId);
                const isErr = Boolean(block.is_error);
                const resultText =
                  typeof block.content === "string"
                    ? block.content.trim()
                    : Array.isArray(block.content)
                      ? extractTextFromContent(
                          block.content as ClaudeContentBlock[],
                        ).trim()
                      : "";
                if (includeChat) {
                  const ref = chatToolRefById.get(callId);
                  if (ref) {
                    ref.status = isErr ? "error" : "ok";
                    if (resultText) {
                      ref.output = capChatText(resultText);
                    }
                  }
                }
                if (spawnInfo) {
                  const turAgent =
                    row.toolUseResult &&
                    typeof row.toolUseResult === "object" &&
                    typeof row.toolUseResult.agentId === "string"
                      ? row.toolUseResult.agentId.trim()
                      : undefined;
                  const matchText =
                    turAgent ??
                    /agentId:\s*([a-zA-Z0-9_-]+)/i.exec(resultText)?.[1];
                  if (matchText) {
                    spawnInfo.matchedFromResult = matchText.startsWith("agent-")
                      ? matchText
                      : `agent-${matchText}`;
                  }
                  const inlineBody = resultText ? resultText.slice(0, 1000) : "";
                  spawnInfo.doneEvent = emit({
                    kind: "subagent_done",
                    toolName: "Agent",
                    toolCallId: callId,
                    targetAgentId: spawnInfo.targetAgentId,
                    summary: cleanHumanSummary(
                      `Subagent finished: ${spawnInfo.agentLabel}`,
                      140,
                    ),
                    status: isErr ? "error" : "ok",
                    isError: isErr,
                    payload: {
                      targetAgentId: spawnInfo.targetAgentId,
                      isError: isErr,
                      ...(inlineBody ? { body: inlineBody } : {}),
                    },
                    ...(resultText ? { fullBody: resultText, inlineBody } : {}),
                    offset: bIdx * 0.0001,
                  });
                } else {
                  const prev = toolSummaryMap.get(callId);
                  const baseLabel = prev?.summary ?? "tool call";
                  emit({
                    kind: "tool_end",
                    toolName: prev?.toolName,
                    toolCallId: callId,
                    summary: cleanHumanSummary(
                      isErr ? `Failed: ${baseLabel}` : `Completed: ${baseLabel}`,
                      140,
                    ),
                    status: isErr ? "error" : "ok",
                    isError: isErr,
                    payload: {
                      toolUseId: callId,
                      isError: isErr,
                      ...(!isErr ? { routineEnd: true } : {}),
                      preview:
                        typeof block.content === "string"
                          ? block.content.slice(0, 300)
                          : resultText
                            ? resultText.slice(0, 300)
                            : undefined,
                    },
                    offset: bIdx * 0.0001,
                  });
                  if (prev?.isAskQuestion && !isErr) {
                    const answerText = extractClaudeAnswerText(
                      row.toolUseResult,
                      resultText,
                    );
                    if (answerText) {
                      const cleanAns =
                        cleanHumanSummary(answerText, 130) ||
                        answerText.slice(0, 130);
                      const inlineBody = answerText.slice(0, 1400);
                      emit({
                        kind: "user_input",
                        toolCallId: `${callId}:answer`,
                        targetAgentId: agentId,
                        summary: `Human: ${cleanAns}`,
                        payload: {
                          isHumanAnswer: true,
                          questionToolCallId: callId,
                          ...(prev.questionPrompt
                            ? { questionPrompt: prev.questionPrompt }
                            : {}),
                          targetAgentId: agentId,
                          body: inlineBody,
                        },
                        fullBody: answerText,
                        inlineBody,
                        offset: (bIdx + 0.5) * 0.0001,
                      });
                    }
                  }
                }
              }
            });
            const txt = extractTextFromContent(content).trim();
            if (!hadToolResult && txt) {
              const inlineBody = txt.slice(0, 1400);
              emit({
                kind: "user_input",
                targetAgentId: agentId,
                summary: `Human: ${cleanHumanSummary(txt, 130)}`,
                payload: { body: inlineBody },
                fullBody: txt,
                inlineBody,
              });
            }
            if (includeChat && txt) {
              chatMessages.push({
                id: `chat:cc:${agentId}:${i}:user`,
                ts: toIsoUtc(epoch),
                epoch,
                agentId,
                role: "user",
                text: capChatText(txt),
              });
            }
          } else if (typeof content === "string" && content.trim()) {
            const inlineBody = content.slice(0, 1400);
            emit({
              kind: "user_input",
              targetAgentId: agentId,
              summary: `Human: ${cleanHumanSummary(content, 130)}`,
              payload: { body: inlineBody },
              fullBody: content,
              inlineBody,
            });
            if (includeChat) {
              chatMessages.push({
                id: `chat:cc:${agentId}:${i}:user`,
                ts: toIsoUtc(epoch),
                epoch,
                agentId,
                role: "user",
                text: capChatText(content.trim()),
              });
            }
          }
        } else if (rtype === "assistant") {
          const content = row.message?.content;
          const blocks = Array.isArray(content) ? content : [];
          let hasToolUse = false;
          const chatThinkingParts: string[] = [];
          const chatTextParts: string[] = [];
          const chatTurnTools: ChatToolCallRef[] = [];
          const chatSpecialMsgs: AgentChatMessage[] = [];
          if (typeof content === "string" && content.trim()) {
            chatTextParts.push(content.trim());
          }

          blocks.forEach((block, bIdx) => {
            if (block.type === "thinking") {
              const thinkText =
                typeof block.thinking === "string" ? block.thinking.trim() : "";
              if (includeChat && thinkText) {
                chatThinkingParts.push(thinkText);
              }
              if (thinkText) {
                const inlineBody = thinkText.slice(0, THINKING_INLINE_MAX);
                emit({
                  kind: "thinking_start",
                  summary: cleanHumanSummary(thinkText, 100) || "Thinking…",
                  payload: { body: inlineBody, isThought: true },
                  fullBody: thinkText,
                  inlineBody,
                  offset: bIdx * 0.0001,
                });
              } else {
                emit({
                  kind: "thinking_start",
                  summary: "Thinking…",
                  offset: bIdx * 0.0001,
                });
              }
            } else if (block.type === "text") {
              if (includeChat && typeof block.text === "string" && block.text.trim()) {
                chatTextParts.push(block.text.trim());
              }
            } else if (block.type === "tool_use") {
              hasToolUse = true;
              const tname = block.name ?? "tool";
              const input = block.input ?? {};
              const callId = block.id ?? `${row.uuid ?? i}:${bIdx}`;
              const isNewChatTool = !seenChatToolUseIds.has(callId);
              if (includeChat) seenChatToolUseIds.add(callId);

              if (tname === "Agent" || tname === "Task") {
                const subType = String(
                  input.subagent_type ?? input.name ?? input.description ?? "subagent",
                )
                  .trim()
                  .toLowerCase()
                  .replace(/[^a-z0-9_-]+/g, "-")
                  .slice(0, 32);
                const subId = subType || `subagent-${callId.slice(0, 6)}`;
                const subLabel = cleanHumanSummary(
                  String(
                    input.name ?? input.description ?? input.subagent_type ?? prettifyAgentLabel(subId),
                  ),
                  60,
                );
                const rawPrompt =
                  typeof input.prompt === "string"
                    ? input.prompt
                    : typeof input.description === "string"
                      ? input.description
                      : "";
                const inlinePrompt = rawPrompt ? rawPrompt.slice(0, 1000) : "";
                const compactInput = {
                  ...(typeof input.subagent_type === "string"
                    ? { subagent_type: input.subagent_type }
                    : {}),
                  ...(typeof input.name === "string" ? { name: input.name } : {}),
                  ...(typeof input.description === "string"
                    ? { description: input.description.slice(0, 200) }
                    : {}),
                  ...(inlinePrompt ? { prompt: inlinePrompt } : {}),
                };
                const spawnEv = emit({
                  kind: "subagent_spawn",
                  toolName: tname,
                  toolCallId: callId,
                  targetAgentId: subId,
                  summary: cleanHumanSummary(`Spawned ${subLabel}`, 140),
                  payload: {
                    input: compactInput,
                    agentLabel: subLabel,
                    ...(typeof input.subagent_type === "string"
                      ? { agentType: input.subagent_type }
                      : {}),
                    ...(inlinePrompt ? { prompt: inlinePrompt } : {}),
                    subagentId: subId,
                  },
                  ...(rawPrompt
                    ? { fullBody: rawPrompt, inlineBody: inlinePrompt }
                    : {}),
                  offset: bIdx * 0.0001,
                });
                let chatSpawnMsg: AgentChatMessage | undefined;
                if (includeChat && isNewChatTool) {
                  chatSpawnMsg = {
                    id: `chat:cc:${agentId}:${i}:sub:${bIdx}`,
                    ts: toIsoUtc(epoch + (bIdx + 1) * 0.0001),
                    epoch: epoch + (bIdx + 1) * 0.0001,
                    agentId,
                    role: "subagent",
                    text: capChatText(rawPrompt.trim() || `Spawned ${subLabel}`),
                    subagentId: subId,
                    subagentLabel: subLabel,
                  };
                  chatSpecialMsgs.push(chatSpawnMsg);
                }
                const rec = {
                  callId,
                  targetAgentId: subId,
                  agentLabel: subLabel,
                  prompt: rawPrompt.trim(),
                  spawnEvent: spawnEv,
                  ...(chatSpawnMsg ? { chatSpawnMsg } : {}),
                };
                spawnToolUseMap.set(callId, rec);
                spawnRecords.push(rec);
              } else if (tname === "SendMessage") {
                const target = String(input.recipient ?? input.to ?? "peer");
                const body = String(input.message ?? input.content ?? "");
                const msgSummary =
                  cleanHumanSummary(body.split(/\r?\n/, 1)[0] ?? body, 140) ||
                  "Sent message";
                const inlineBody = body.slice(0, 1000);
                const compactInput = {
                  ...(typeof input.recipient === "string"
                    ? { recipient: input.recipient }
                    : {}),
                  ...(typeof input.to === "string" ? { to: input.to } : {}),
                  body: inlineBody,
                };
                toolSummaryMap.set(callId, { toolName: tname, summary: msgSummary });
                emit({
                  kind: "message",
                  toolName: tname,
                  toolCallId: callId,
                  targetAgentId: target,
                  summary: msgSummary,
                  payload: { input: compactInput, body: inlineBody },
                  ...(body ? { fullBody: body, inlineBody } : {}),
                  offset: bIdx * 0.0001,
                });
                if (includeChat && isNewChatTool) {
                  chatSpecialMsgs.push({
                    id: `chat:cc:${agentId}:${i}:msg:${bIdx}`,
                    ts: toIsoUtc(epoch + (bIdx + 1) * 0.0001),
                    epoch: epoch + (bIdx + 1) * 0.0001,
                    agentId,
                    role: "subagent",
                    text: capChatText(body || msgSummary),
                    subagentId: target,
                  });
                }
              } else if (tname === "AskUserQuestion") {
                const parsedQuestions = normalizePendingQuestions(input, {
                  defaultAllowCustomInput: true,
                });
                const qSummary = parsedQuestions[0]?.question
                  ? cleanHumanSummary(parsedQuestions[0].question, 100)
                  : "Asked user a question";
                const qTitle =
                  cleanHumanSummary(
                    parsedQuestions[0]?.header ??
                      parsedQuestions[0]?.question ??
                      "Question for user",
                    100,
                  ) || "Question for user";
                const questionPrompt =
                  parsedQuestions
                    .map((q) => q.question.trim())
                    .filter(Boolean)
                    .join(" / ")
                    .slice(0, 500) ||
                  qSummary ||
                  "Asked user a question";
                toolSummaryMap.set(callId, {
                  toolName: tname,
                  summary: qSummary || "Asked user a question",
                  isAskQuestion: true,
                  questionPrompt,
                });
                emit({
                  kind: "tool_start",
                  toolName: tname,
                  toolCallId: callId,
                  targetAgentId: "human",
                  summary: qSummary || "Asked user a question",
                  waitingReason: "user",
                  payload: {
                    input,
                    questions: parsedQuestions,
                    promptTitle: qTitle,
                    promptKind: "question",
                    blockingToolCall: true,
                  },
                  offset: bIdx * 0.0001,
                });
                if (includeChat && isNewChatTool) {
                  chatSpecialMsgs.push({
                    id: `chat:cc:${agentId}:${i}:ask:${bIdx}`,
                    ts: toIsoUtc(epoch + (bIdx + 1) * 0.0001),
                    epoch: epoch + (bIdx + 1) * 0.0001,
                    agentId,
                    role: "question",
                    text: capChatText(
                      formatQuestionsPreview(
                        parsedQuestions,
                        qSummary || "Asked user a question",
                      ),
                    ),
                    pendingPromptId: computePendingPromptId(agentId, callId),
                  });
                }
              } else {
                const cmd = String(input.command ?? "");
                const selfDaemon = isSelfDaemonCommand(
                  cmd || JSON.stringify(input),
                );
                const actionSummary = summarizeToolCall(tname, input);
                const isBoardMut = isBoardMutationToolCall(tname, input);
                toolSummaryMap.set(callId, { toolName: tname, summary: actionSummary });
                emit({
                  kind: isBoardMut ? "board_mutation" : "tool_start",
                  toolName: tname,
                  toolCallId: callId,
                  summary: actionSummary,
                  isSelfDaemon: selfDaemon,
                  payload: { input },
                  offset: bIdx * 0.0001,
                });
                if (includeChat && isNewChatTool) {
                  const ref: ChatToolCallRef = {
                    toolCallId: callId,
                    toolName: tname,
                    summary: actionSummary,
                    status: "running",
                    inputPreview: capChatText(JSON.stringify(input), 4096),
                  };
                  chatTurnTools.push(ref);
                  chatToolRefById.set(callId, ref);
                }
              }
            }
          });

          if (includeChat) {
            const joinedThinking = chatThinkingParts.join("\n\n").trim();
            const joinedText = chatTextParts.join("\n\n").trim();
            if (joinedThinking || joinedText || chatTurnTools.length > 0) {
              const msgId = row.message?.id;
              const groupKey = msgId ? `${agentId}\0${msgId}` : undefined;
              const existingMsg = groupKey
                ? lastAssistantByMsgId.get(groupKey)
                : undefined;

              if (existingMsg) {
                if (joinedThinking) {
                  existingMsg.thinking = capChatText(
                    mergeStreamingText(existingMsg.thinking, joinedThinking),
                  );
                  if (existingMsg.role === "thinking" && !joinedText && chatTurnTools.length === 0) {
                    existingMsg.text = existingMsg.thinking;
                  }
                }
                if (joinedText) {
                  const prevProse = groupKey
                    ? assistantProseByMsgId.get(groupKey)
                    : undefined;
                  const mergedProse = mergeStreamingText(prevProse, joinedText);
                  if (groupKey) {
                    assistantProseByMsgId.set(groupKey, mergedProse);
                  }
                  if (existingMsg.role === "thinking") {
                    existingMsg.role = "assistant";
                  }
                  existingMsg.text = capChatText(mergedProse);
                }
                if (chatTurnTools.length > 0) {
                  if (existingMsg.role === "thinking") {
                    existingMsg.role = "assistant";
                    if (!joinedText) {
                      existingMsg.text =
                        chatTurnTools.length === 1
                          ? chatTurnTools[0]!.summary
                          : `Ran ${chatTurnTools.length} tools`;
                    }
                  }
                  existingMsg.tools = [
                    ...(existingMsg.tools ?? []),
                    ...chatTurnTools,
                  ];
                }
              } else {
                const hasAssistantContent =
                  joinedText.length > 0 || chatTurnTools.length > 0;
                const msg: AgentChatMessage = {
                  id: `chat:cc:${agentId}:${i}:ast`,
                  ts: toIsoUtc(epoch),
                  epoch,
                  agentId,
                  role: hasAssistantContent ? "assistant" : "thinking",
                  text: capChatText(
                    joinedText ||
                      (chatTurnTools.length > 0
                        ? chatTurnTools.length === 1
                          ? chatTurnTools[0]!.summary
                          : `Ran ${chatTurnTools.length} tools`
                        : joinedThinking),
                  ),
                  ...(joinedThinking
                    ? { thinking: capChatText(joinedThinking) }
                    : {}),
                  ...(chatTurnTools.length > 0 ? { tools: chatTurnTools } : {}),
                };
                chatMessages.push(msg);
                if (groupKey) {
                  lastAssistantByMsgId.set(groupKey, msg);
                  if (joinedText) {
                    assistantProseByMsgId.set(groupKey, joinedText);
                  }
                }
              }
            }
            chatMessages.push(...chatSpecialMsgs);
          }

          if (row.message?.stop_reason === "end_turn" && !hasToolUse) {
            const txt = extractTextFromContent(content).trim();
            const inlineBody = txt.slice(0, 1000);
            emit({
              kind:
                agentId === "root" ? "assistant_turn_end" : "subagent_done",
              summary: cleanHumanSummary(txt, 140) || "Turn completed",
              payload: { body: inlineBody },
              ...(txt ? { fullBody: txt, inlineBody } : {}),
              offset: (blocks.length + 1) * 0.0001,
            });
          }
        }
      }
    };

    // Parse main session transcript
    parseRowsForAgent(mainRows, "root", undefined, "Coordinator");

    // Parse nested subagent files under <folder>/<sessionId>/subagents/agent-*.jsonl
    // Correlate each file with main-transcript Agent/Task tool_use calls by tool_result agentId / prompt / order.
    const subagentsDir = path.join(
      path.dirname(session.filePath),
      session.sessionId,
      "subagents",
    );
    try {
      const subFiles = (await fs.readdir(subagentsDir))
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
      const loadedSubs: Array<{
        subId: string;
        rows: ClaudeRow[];
        firstPrompt: string;
        firstEpoch: number;
      }> = [];
      for (const sf of subFiles) {
        const subId = sf.slice(0, -".jsonl".length);
        const subRows = await readClaudeJsonl(path.join(subagentsDir, sf));
        const firstUserRow = subRows.find((r) => r.type === "user");
        const firstPrompt = firstUserRow
          ? extractTextFromContent(firstUserRow.message?.content).trim()
          : "";
        const firstEpoch = parseEpochSeconds(subRows[0]?.timestamp, 0);
        loadedSubs.push({ subId, rows: subRows, firstPrompt, firstEpoch });
      }
      loadedSubs.sort(
        (a, b) => a.firstEpoch - b.firstEpoch || a.subId.localeCompare(b.subId),
      );

      for (const sub of loadedSubs) {
        // 1. Exact match by tool_result agentId
        let matched = spawnRecords.find(
          (r) => !r.matchedSubId && r.matchedFromResult === sub.subId,
        );
        // 2. Match by initial user prompt
        if (!matched && sub.firstPrompt) {
          const normSubPrompt = sub.firstPrompt.replace(/\s+/g, " ").trim();
          const prefix = normSubPrompt.slice(0, 80);
          matched = spawnRecords.find((r) => {
            if (r.matchedSubId || !r.prompt) return false;
            const normSpawnPrompt = r.prompt.replace(/\s+/g, " ").trim();
            return (
              normSpawnPrompt === normSubPrompt ||
              (prefix.length >= 16 &&
                (normSpawnPrompt.includes(prefix) ||
                  normSubPrompt.includes(normSpawnPrompt.slice(0, 80))))
            );
          });
        }
        // 3. Fallback by chronological order
        if (!matched) {
          matched = spawnRecords.find((r) => !r.matchedSubId);
        }

        let resolvedLabel = prettifyAgentLabel(sub.subId);
        if (matched) {
          matched.matchedSubId = sub.subId;
          resolvedLabel = matched.agentLabel || resolvedLabel;
          if (matched.spawnEvent) {
            matched.spawnEvent.targetAgentId = sub.subId;
            matched.spawnEvent.payload = {
              ...(matched.spawnEvent.payload ?? {}),
              subagentId: sub.subId,
              agentLabel: resolvedLabel,
            };
          }
          if (matched.doneEvent) {
            matched.doneEvent.targetAgentId = sub.subId;
            matched.doneEvent.payload = {
              ...(matched.doneEvent.payload ?? {}),
              targetAgentId: sub.subId,
            };
          }
          if (matched.chatSpawnMsg) {
            matched.chatSpawnMsg.subagentId = sub.subId;
            matched.chatSpawnMsg.subagentLabel = resolvedLabel;
          }
        }

        parseRowsForAgent(sub.rows, sub.subId, "root", resolvedLabel);
      }
    } catch {
      // No nested subagents directory.
    }

    // Attach finalized per-agent UsageDelta totals onto each agent's last emitted event
    const lastEvByAgent = new Map<string, EnrichedEvent>();
    for (const ev of events) {
      lastEvByAgent.set(ev.agentId, ev);
    }
    for (const [aid, acc] of usageAccByAgent.entries()) {
      const targetEv = lastEvByAgent.get(aid);
      if (!targetEv) continue;
      const inputTokens = acc.hasExact
        ? acc.inputTokens
        : Math.round(acc.estInputChars / 4);
      const outputTokens = acc.hasExact
        ? acc.outputTokens
        : Math.round(acc.estOutputChars / 4);
      const cachedTokens = acc.hasExact ? acc.cachedTokens : 0;
      const contextTokens = acc.hasExact
        ? acc.lastTurnContext
        : inputTokens + outputTokens;
      const hasSplit = acc.hasExact && acc.hasCacheSplit && !acc.hasUnsplitCached;
      const usageDelta: UsageDelta = {
        model: acc.model,
        modelSource: acc.model ? "exact" : "unknown",
        usageSource: acc.hasExact ? "exact" : "estimated",
        inputTokens,
        outputTokens,
        cachedTokens,
        ...(hasSplit
          ? {
              cacheReadTokens: acc.cacheReadTokens,
              cacheWriteTokens: acc.cacheWriteTokens,
            }
          : {}),
        ...(acc.hasExact && acc.hasExactReasoning
          ? {
              reasoningTokens: Math.min(outputTokens, acc.reasoningTokens),
              reasoningSource: "exact" as const,
            }
          : {}),
        contextTokens,
        ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
        isTotal: true,
      };
      targetEv.usageDelta = usageDelta;
      targetEv.payload = { ...(targetEv.payload ?? {}), _usageDelta: usageDelta };
    }

    return { events, chatMessages };
  }
}
