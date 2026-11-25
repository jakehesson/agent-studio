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
  type AdapterHealth,
  type DiscoveredSession,
  type EnrichedEvent,
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

export class ClaudeCodeAdapter implements PassiveIdeAdapter {
  readonly ide = "claude-code" as const;
  private readonly projectsDir: string;

  constructor(options?: ClaudeCodeAdapterOptions) {
    this.projectsDir =
      options?.projectsDir ??
      process.env.CLAUDE_PROJECTS_DIR?.trim() ??
      path.join(os.homedir(), ".claude", "projects");
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
    const sessions: DiscoveredSession[] = [];

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
        let headText = "";
        try {
          const fh = await fs.open(filePath, "r");
          try {
            const buf = Buffer.alloc(Math.min(fst.size, 32768));
            const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
            headText = buf.subarray(0, bytesRead).toString("utf8");
          } finally {
            await fh.close();
          }
        } catch {
          continue;
        }

        let cwd: string | undefined;
        let title = `Claude ${sessionId.slice(0, 8)}`;
        let isMultiAgent = false;

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

        // Check for <session>/subagents/ directory
        const subDir = path.join(folderPath, sessionId, "subagents");
        try {
          const subFiles = await fs.readdir(subDir);
          if (subFiles.some((f) => f.endsWith(".jsonl"))) {
            isMultiAgent = true;
          }
        } catch {
          // No subagents dir.
        }

        const decodedFolderWs = decodeEncodedCwd(folder);
        const workspaces = [
          ...(cwd ? [cwd] : []),
          ...(decodedFolderWs && decodedFolderWs !== cwd
            ? [decodedFolderWs]
            : []),
        ];
        const workspacePath = workspaces[0];
        const projectId =
          matchProjectIdForWorkspaces(workspaces, knownProjects) ??
          (workspacePath ? path.basename(workspacePath) : undefined);

        sessions.push({
          ide: this.ide,
          sessionId,
          filePath,
          workspacePath,
          workspaces,
          projectId,
          title,
          mtimeMs: fst.mtimeMs,
          sizeBytes: fst.size,
          isMultiAgent,
        });
      }
    }

    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions.slice(0, opts?.limit ?? 100);
  }

  async parseSession(session: DiscoveredSession): Promise<EnrichedEvent[]> {
    const mainRows = await readClaudeJsonl(session.filePath);
    if (mainRows.length === 0) return [];

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

    const events: EnrichedEvent[] = [];
    const spawnToolUseMap = new Map<
      string,
      { targetAgentId: string; agentLabel: string }
    >();
    const toolSummaryMap = new Map<string, { toolName: string; summary: string }>();

    interface ClaudeUsageAcc {
      model?: string;
      hasExact: boolean;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
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
          lastTurnContext: 0,
          estInputChars: 0,
          estOutputChars: 0,
        };
        usageAccByAgent.set(aid, acc);
      }
      return acc;
    };

    const parseRowsForAgent = (
      rows: ClaudeRow[],
      defaultAgentId: string,
      defaultParentAgentId?: string,
      defaultLabel?: string,
    ): void => {
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
        const isInlineSidechain =
          defaultAgentId === "root" && row.isSidechain === true;
        const agentId = isInlineSidechain
          ? row.agentId
            ? `agent-${row.agentId}`
            : `sidechain-${(row.parentUuid ?? row.uuid ?? "sub").slice(0, 6)}`
          : defaultAgentId;
        const parentAgentId = isInlineSidechain
          ? "root"
          : defaultParentAgentId;
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
          (typeof usage.input_tokens === "number" ||
            typeof usage.output_tokens === "number")
        ) {
          acc.hasExact = true;
          const inTok = Math.max(0, Math.round(usage.input_tokens ?? 0));
          const outTok = Math.max(0, Math.round(usage.output_tokens ?? 0));
          const cacheRead = Math.max(
            0,
            Math.round(usage.cache_read_input_tokens ?? 0),
          );
          const cacheCreate = Math.max(
            0,
            Math.round(usage.cache_creation_input_tokens ?? 0),
          );
          const cachedTok = cacheRead + cacheCreate;
          acc.inputTokens += inTok;
          acc.outputTokens += outTok;
          acc.cachedTokens += cachedTok;
          acc.lastTurnContext = Math.max(
            acc.lastTurnContext,
            inTok + cachedTok + outTok,
          );
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
        }): void => {
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
          events.push({
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
            status: input.status,
            isSelfDaemon: input.isSelfDaemon,
            isError: input.isError,
            waitingReason: input.waitingReason,
          });
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
                if (spawnInfo) {
                  emit({
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
                    },
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
                          : undefined,
                    },
                    offset: bIdx * 0.0001,
                  });
                }
              }
            });
            if (!hadToolResult) {
              const txt = extractTextFromContent(content).trim();
              if (txt) {
                emit({
                  kind: "user_input",
                  targetAgentId: agentId,
                  summary: `Human: ${cleanHumanSummary(txt, 130)}`,
                  payload: { body: txt.slice(0, 1400) },
                });
              }
            }
          } else if (typeof content === "string" && content.trim()) {
            emit({
              kind: "user_input",
              targetAgentId: agentId,
              summary: `Human: ${cleanHumanSummary(content, 130)}`,
              payload: { body: content.slice(0, 1400) },
            });
          }
        } else if (rtype === "assistant") {
          const content = row.message?.content;
          const blocks = Array.isArray(content) ? content : [];
          let hasToolUse = false;

          blocks.forEach((block, bIdx) => {
            if (block.type === "thinking") {
              emit({
                kind: "thinking_start",
                summary:
                  cleanHumanSummary(block.thinking ?? "", 100) || "Thinking…",
                offset: bIdx * 0.0001,
              });
            } else if (block.type === "tool_use") {
              hasToolUse = true;
              const tname = block.name ?? "tool";
              const input = block.input ?? {};
              const callId = block.id ?? `${row.uuid ?? i}:${bIdx}`;

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
                    input.description ?? input.subagent_type ?? prettifyAgentLabel(subId),
                  ),
                  60,
                );
                spawnToolUseMap.set(callId, {
                  targetAgentId: subId,
                  agentLabel: subLabel,
                });
                emit({
                  kind: "subagent_spawn",
                  toolName: tname,
                  toolCallId: callId,
                  targetAgentId: subId,
                  summary: cleanHumanSummary(`Spawned ${subLabel}`, 140),
                  payload: { input, subagentId: subId },
                  offset: bIdx * 0.0001,
                });
              } else if (tname === "SendMessage") {
                const target = String(input.recipient ?? input.to ?? "peer");
                const body = String(input.message ?? input.content ?? "");
                const msgSummary =
                  cleanHumanSummary(body.split(/\r?\n/, 1)[0] ?? body, 140) ||
                  "Sent message";
                toolSummaryMap.set(callId, { toolName: tname, summary: msgSummary });
                emit({
                  kind: "message",
                  toolName: tname,
                  toolCallId: callId,
                  targetAgentId: target,
                  summary: msgSummary,
                  payload: { input, body: body.slice(0, 1000) },
                  offset: bIdx * 0.0001,
                });
              } else if (tname === "AskUserQuestion") {
                const qSummary = "Asked user a question";
                toolSummaryMap.set(callId, { toolName: tname, summary: qSummary });
                emit({
                  kind: "tool_start",
                  toolName: tname,
                  toolCallId: callId,
                  targetAgentId: "human",
                  summary: qSummary,
                  waitingReason: "user",
                  payload: { input },
                  offset: bIdx * 0.0001,
                });
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
              }
            }
          });

          if (row.message?.stop_reason === "end_turn" && !hasToolUse) {
            const txt = extractTextFromContent(content).trim();
            emit({
              kind:
                agentId === "root" ? "assistant_turn_end" : "subagent_done",
              summary: cleanHumanSummary(txt, 140) || "Turn completed",
              payload: { body: txt.slice(0, 1000) },
              offset: (blocks.length + 1) * 0.0001,
            });
          }
        }
      }
    };

    // Parse main session transcript
    parseRowsForAgent(mainRows, "root", undefined, "Coordinator");

    // Parse nested subagent files under <folder>/<sessionId>/subagents/agent-*.jsonl
    const subagentsDir = path.join(
      path.dirname(session.filePath),
      session.sessionId,
      "subagents",
    );
    try {
      const subFiles = await fs.readdir(subagentsDir);
      for (const sf of subFiles.sort()) {
        if (!sf.endsWith(".jsonl")) continue;
        const subId = sf.slice(0, -".jsonl".length);
        const subRows = await readClaudeJsonl(path.join(subagentsDir, sf));
        parseRowsForAgent(
          subRows,
          subId,
          "root",
          prettifyAgentLabel(subId),
        );
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
      const usageDelta: UsageDelta = {
        model: acc.model,
        modelSource: acc.model ? "exact" : "unknown",
        usageSource: acc.hasExact ? "exact" : "estimated",
        inputTokens,
        outputTokens,
        cachedTokens,
        contextTokens,
        ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
        isTotal: true,
      };
      targetEv.usageDelta = usageDelta;
      targetEv.payload = { ...(targetEv.payload ?? {}), _usageDelta: usageDelta };
    }

    return events;
  }
}
