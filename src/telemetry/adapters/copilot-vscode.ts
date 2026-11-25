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
  type ParseSessionOptions,
  type PassiveIdeAdapter,
  type UsageDelta,
} from "../types.js";
import {
  getKnownProjects,
  matchProjectIdForWorkspaces,
} from "./project-match.js";

interface VSCodeResponseItem {
  kind?: string;
  value?: string;
  content?: string | { value?: string };
  toolId?: string;
  toolName?: string;
  toolCallId?: string;
  isComplete?: boolean;
  isConfirmed?: boolean;
  invocationMessage?: string | { value?: string };
  pastTenseMessage?: string | { value?: string };
  generatedTitle?: string;
  resultDetails?: unknown;
  toolSpecificData?: Record<string, unknown>;
}

interface VSCodeRequest {
  requestId?: string;
  timestamp?: number;
  isCanceled?: boolean;
  completionTokens?: number;
  message?: { text?: string };
  agent?: { id?: string; name?: string; fullName?: string };
  modeInfo?: { modeId?: string; modeName?: string };
  modelId?: string;
  modelState?: { value?: number; completedAt?: number };
  response?: VSCodeResponseItem[];
  result?: {
    details?: string;
    errorDetails?: { message?: string };
    metadata?: {
      usage?: {
        promptTokens?: number;
        completionTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
        cachedTokens?: number;
        totalTokens?: number;
      };
    };
  };
}

interface VSCodeChatSessionState {
  sessionId?: string;
  customTitle?: string;
  creationDate?: number;
  lastMessageDate?: number;
  requests?: VSCodeRequest[];
}

interface DeltaRow {
  kind?: number;
  k?: Array<string | number>;
  i?: number;
  v?: unknown;
}

export interface CopilotVSCodeAdapterOptions {
  storageDir?: string;
}

function defaultVSCodeStorageDir(): string {
  const envOverride = process.env.VSCODE_STORAGE_DIR?.trim();
  if (envOverride) return envOverride;
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Code", "User", "workspaceStorage");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "workspaceStorage",
    );
  }
  return path.join(os.homedir(), ".config", "Code", "User", "workspaceStorage");
}

function extractMessageText(
  val: string | { value?: string } | undefined,
): string {
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && typeof val.value === "string") {
    return val.value;
  }
  return "";
}

function setAtPath(
  root: Record<string, unknown>,
  keyPath: Array<string | number>,
  value: unknown,
): void {
  if (keyPath.length === 0) return;
  let curr: unknown = root;
  for (let idx = 0; idx < keyPath.length - 1; idx++) {
    const key = keyPath[idx]!;
    const nextKey = keyPath[idx + 1]!;
    if (Array.isArray(curr) && typeof key === "number") {
      if (curr[key] === undefined || curr[key] === null) {
        curr[key] = typeof nextKey === "number" ? [] : {};
      }
      curr = curr[key];
    } else if (curr && typeof curr === "object") {
      const rec = curr as Record<string | number, unknown>;
      if (rec[key] === undefined || rec[key] === null) {
        rec[key] = typeof nextKey === "number" ? [] : {};
      }
      curr = rec[key];
    } else {
      return;
    }
  }
  const lastKey = keyPath[keyPath.length - 1]!;
  if (Array.isArray(curr) && typeof lastKey === "number") {
    curr[lastKey] = value;
  } else if (curr && typeof curr === "object") {
    (curr as Record<string | number, unknown>)[lastKey] = value;
  }
}

function spliceAtPath(
  root: Record<string, unknown>,
  keyPath: Array<string | number>,
  index: number | undefined,
  value: unknown,
): void {
  if (keyPath.length === 0) return;
  let curr: unknown = root;
  for (let idx = 0; idx < keyPath.length - 1; idx++) {
    const key = keyPath[idx]!;
    const nextKey = keyPath[idx + 1]!;
    if (Array.isArray(curr) && typeof key === "number") {
      if (curr[key] === undefined || curr[key] === null) {
        curr[key] = typeof nextKey === "number" ? [] : {};
      }
      curr = curr[key];
    } else if (curr && typeof curr === "object") {
      const rec = curr as Record<string | number, unknown>;
      if (rec[key] === undefined || rec[key] === null) {
        rec[key] = typeof nextKey === "number" ? [] : {};
      }
      curr = rec[key];
    } else {
      return;
    }
  }

  const lastKey = keyPath[keyPath.length - 1]!;
  let targetArr: unknown[] | undefined;
  if (Array.isArray(curr) && typeof lastKey === "number") {
    if (!Array.isArray(curr[lastKey])) curr[lastKey] = [];
    targetArr = curr[lastKey] as unknown[];
  } else if (curr && typeof curr === "object") {
    const rec = curr as Record<string | number, unknown>;
    if (!Array.isArray(rec[lastKey])) rec[lastKey] = [];
    targetArr = rec[lastKey] as unknown[];
  }
  if (!targetArr) return;

  const items = Array.isArray(value) ? value : value !== undefined ? [value] : [];
  if (typeof index === "number" && index >= 0) {
    // Delta kind=2 with index replaces tail from index (VS Code's array truncate+append semantics)
    targetArr.splice(index, targetArr.length - index, ...items);
  } else {
    targetArr.push(...items);
  }
}

export function reconstructVSCodeDeltaJsonl(
  rawText: string,
): VSCodeChatSessionState {
  let state: Record<string, unknown> = {};
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: DeltaRow;
    try {
      row = JSON.parse(trimmed) as DeltaRow;
    } catch {
      continue;
    }
    if (row.kind === 0 && row.v && typeof row.v === "object") {
      state = structuredClone(row.v) as Record<string, unknown>;
    } else if (row.kind === 1 && Array.isArray(row.k)) {
      setAtPath(state, row.k, row.v);
    } else if (row.kind === 2 && Array.isArray(row.k)) {
      spliceAtPath(state, row.k, row.i, row.v);
    }
  }
  return state as VSCodeChatSessionState;
}

async function readWorkspaceJsonFolder(
  wsHashDir: string,
): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(wsHashDir, "workspace.json"), "utf8");
    const parsed = JSON.parse(raw) as { folder?: string; workspace?: string };
    const uri = parsed.folder ?? parsed.workspace;
    if (typeof uri === "string" && uri.trim()) {
      return normalizeWsPath(uri);
    }
  } catch {
    // workspace.json absent or unreadable
  }
  return undefined;
}

export class CopilotVSCodeAdapter implements PassiveIdeAdapter {
  readonly ide = "copilot-vscode" as const;
  private readonly storageDir: string;
  private readonly stateCache = new Map<
    string,
    { mtimeMs: number; sizeBytes: number; state: VSCodeChatSessionState }
  >();

  constructor(options?: CopilotVSCodeAdapterOptions) {
    this.storageDir = options?.storageDir ?? defaultVSCodeStorageDir();
  }

  private async loadChatSessionState(
    filePath: string,
    mtimeMs: number,
    sizeBytes: number,
  ): Promise<VSCodeChatSessionState | null> {
    const cached = this.stateCache.get(filePath);
    if (
      cached &&
      cached.mtimeMs === mtimeMs &&
      cached.sizeBytes === sizeBytes
    ) {
      return cached.state;
    }

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }

    let state: VSCodeChatSessionState;
    try {
      if (filePath.endsWith(".jsonl")) {
        state = reconstructVSCodeDeltaJsonl(raw);
      } else {
        state = JSON.parse(raw) as VSCodeChatSessionState;
      }
    } catch {
      return null;
    }

    this.stateCache.set(filePath, { mtimeMs, sizeBytes, state });
    return state;
  }

  async getHealth(): Promise<AdapterHealth> {
    try {
      const st = await fs.stat(this.storageDir);
      if (!st.isDirectory()) {
        return {
          ide: this.ide,
          status: "degraded",
          rootDir: this.storageDir,
          sessionsFound: 0,
          message: "VS Code workspaceStorage path is not a directory",
        };
      }
      const sessions = await this.discoverSessions({ limit: 50 });
      return {
        ide: this.ide,
        status: "ok",
        rootDir: this.storageDir,
        sessionsFound: sessions.length,
      };
    } catch {
      return {
        ide: this.ide,
        status: "degraded",
        rootDir: this.storageDir,
        sessionsFound: 0,
        message: "VS Code workspaceStorage directory not found",
      };
    }
  }

  async discoverSessions(opts?: {
    limit?: number;
    workspaceRoots?: string[];
  }): Promise<DiscoveredSession[]> {
    let hashDirs: string[];
    try {
      hashDirs = await fs.readdir(this.storageDir);
    } catch {
      return [];
    }

    const knownProjects = getKnownProjects();
    const sessions: DiscoveredSession[] = [];

    for (const hdir of hashDirs) {
      const wsDir = path.join(this.storageDir, hdir);
      const chatDir = path.join(wsDir, "chatSessions");
      let chatFiles: string[];
      try {
        chatFiles = await fs.readdir(chatDir);
      } catch {
        continue;
      }

      const workspacePath = await readWorkspaceJsonFolder(wsDir);
      const workspaces = workspacePath ? [workspacePath] : [];
      const projectId =
        matchProjectIdForWorkspaces(workspaces, knownProjects) ??
        (workspacePath ? path.basename(workspacePath) : undefined);

      for (const fname of chatFiles) {
        if (!fname.endsWith(".json") && !fname.endsWith(".jsonl")) continue;
        const filePath = path.join(chatDir, fname);
        let fst;
        try {
          fst = await fs.stat(filePath);
          if (!fst.isFile() || fst.size === 0) continue;
        } catch {
          continue;
        }

        const state = await this.loadChatSessionState(
          filePath,
          fst.mtimeMs,
          fst.size,
        );
        if (!state) continue;

        const requests = Array.isArray(state.requests) ? state.requests : [];
        const sessionId =
          state.sessionId ||
          fname.replace(/\.jsonl?$/i, "");

        const firstPrompt = requests[0]?.message?.text
          ?.replace(/\s+/g, " ")
          .trim();
        const title =
          state.customTitle?.trim() ||
          firstPrompt?.slice(0, 80) ||
          `Copilot ${sessionId.slice(0, 8)}`;

        const distinctAgents = new Set<string>();
        let hasSubagent = false;
        for (const req of requests) {
          const aid = req.modeInfo?.modeName || req.agent?.name || req.agent?.id;
          if (aid) distinctAgents.add(aid);
          for (const resp of req.response ?? []) {
            const tid = (resp.toolId ?? resp.toolName ?? "").toLowerCase();
            if (tid.includes("subagent")) hasSubagent = true;
          }
        }

        sessions.push({
          ide: this.ide,
          sessionId,
          filePath,
          workspacePath,
          workspaces: workspacePath ? [workspacePath] : [],
          projectId,
          title,
          mtimeMs: fst.mtimeMs,
          sizeBytes: fst.size,
          isMultiAgent: hasSubagent || distinctAgents.size > 1,
        });
      }
    }

    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions.slice(0, opts?.limit ?? 100);
  }

  async parseSession(
    session: DiscoveredSession,
    opts?: ParseSessionOptions,
  ): Promise<EnrichedEvent[]> {
    let fst;
    try {
      fst = await fs.stat(session.filePath);
    } catch {
      return [];
    }
    const state = await this.loadChatSessionState(
      session.filePath,
      fst.mtimeMs,
      fst.size,
    );
    if (!state) return [];

    const knownProjects = getKnownProjects();
    const workspacePath = session.workspacePath;
    const projectId =
      matchProjectIdForWorkspaces(
        [workspacePath, ...session.workspaces],
        knownProjects,
      ) ?? session.projectId;

    const requests = Array.isArray(state.requests) ? state.requests : [];
    const events: EnrichedEvent[] = [];

    interface CopilotUsageAcc {
      model?: string;
      hasExact: boolean;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      lastTurnContext: number;
      estInputChars: number;
      estOutputChars: number;
    }
    const usageAccByAgent = new Map<string, CopilotUsageAcc>();
    const ensureAcc = (aid: string): CopilotUsageAcc => {
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

    for (let rIdx = 0; rIdx < requests.length; rIdx++) {
      const req = requests[rIdx]!;
      const reqEpoch = parseEpochSeconds(
        req.timestamp,
        (state.creationDate ? state.creationDate / 1000 : session.mtimeMs / 1000) +
          rIdx,
      );
      const rawAgent =
        req.modeInfo?.modeName || req.agent?.name || req.agent?.id || "root";
      const agentId =
        rawAgent.toLowerCase() === "agent" ||
        rawAgent.toLowerCase() === "github.copilot.editsagent" ||
        rawAgent.toLowerCase() === "github.copilot.default"
          ? "root"
          : rawAgent.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      const agentLabel =
        agentId === "root"
          ? "Copilot Agent"
          : prettifyAgentLabel(rawAgent);

      const acc = ensureAcc(agentId);
      if (typeof req.modelId === "string" && req.modelId.trim()) {
        const pretty = prettifyModelName(req.modelId);
        if (pretty) acc.model = pretty;
      }
      const metaUsage = req.result?.metadata?.usage;
      const exactIn =
        typeof metaUsage?.promptTokens === "number"
          ? metaUsage.promptTokens
          : typeof metaUsage?.inputTokens === "number"
            ? metaUsage.inputTokens
            : undefined;
      const exactOut =
        typeof metaUsage?.completionTokens === "number"
          ? metaUsage.completionTokens
          : typeof metaUsage?.outputTokens === "number"
            ? metaUsage.outputTokens
            : typeof req.completionTokens === "number"
              ? req.completionTokens
              : undefined;
      const exactCached =
        typeof metaUsage?.cachedTokens === "number" ? metaUsage.cachedTokens : 0;

      if (exactIn !== undefined || exactOut !== undefined) {
        acc.hasExact = true;
        const inTok = Math.max(0, Math.round(exactIn ?? 0));
        const outTok = Math.max(0, Math.round(exactOut ?? 0));
        const cachedTok = Math.max(0, Math.round(exactCached));
        acc.inputTokens += inTok;
        acc.outputTokens += outTok;
        acc.cachedTokens += cachedTok;
        acc.lastTurnContext = Math.max(
          acc.lastTurnContext,
          inTok + cachedTok + outTok,
        );
      }
      acc.estInputChars += (req.message?.text ?? "").length;
      if (Array.isArray(req.response) && req.response.length > 0) {
        acc.estOutputChars += JSON.stringify(req.response).length;
      }

      const emit = (input: {
        epoch: number;
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
      }): void => {
        const id = computeDeterministicEventId({
          ide: this.ide,
          sessionId: session.sessionId,
          agentId,
          kind: input.kind,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          epoch: input.epoch,
          summary: input.summary,
        });
        const mergeKey = computeMergeKey({
          sessionId: session.sessionId,
          agentId,
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
        events.push({
          id,
          mergeKey,
          ts: toIsoUtc(input.epoch),
          epoch: input.epoch,
          ide: this.ide,
          channel: "passive",
          sessionId: session.sessionId,
          workspacePath,
          projectId,
          agentId,
          agentLabel,
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
        });
        if (hasBody) {
          opts?.onFullBody?.(id, input.fullBody!);
        }
      };

      // 1. User prompt
      const promptText = req.message?.text?.trim() ?? "";
      if (promptText) {
        const inlineBody = promptText.slice(0, 1400);
        emit({
          epoch: reqEpoch,
          kind: "user_input",
          targetAgentId: agentId,
          summary: `Human: ${promptText.replace(/\s+/g, " ").slice(0, 90)}`,
          payload: { body: inlineBody, requestId: req.requestId },
          fullBody: promptText,
          inlineBody,
        });
      }

      // 2. Response items
      const responses = Array.isArray(req.response) ? req.response : [];
      for (let i = 0; i < responses.length; i++) {
        const item = responses[i]!;
        const stepEpoch = reqEpoch + (i + 1) * 0.01;
        const rkind = item.kind ?? "";

        if (rkind === "thinking") {
          const thinkText = extractMessageText(item.value);
          emit({
            epoch: stepEpoch,
            kind: "thinking_start",
            summary: thinkText.replace(/\s+/g, " ").trim().slice(0, 80) || "Thinking…",
          });
        } else if (rkind === "prepareToolInvocation") {
          const tname = item.toolName || item.toolId || "tool";
          emit({
            epoch: stepEpoch,
            kind: "tool_start",
            toolName: tname,
            toolCallId: item.toolCallId,
            summary: `Preparing: ${tname}`,
          });
        } else if (rkind === "toolInvocationSerialized") {
          const tname = item.toolId || item.toolName || "tool";
          const callId = item.toolCallId || `${req.requestId ?? rIdx}:${i}:${tname}`;
          const msg =
            extractMessageText(item.pastTenseMessage) ||
            extractMessageText(item.invocationMessage) ||
            item.generatedTitle ||
            tname;
          const lowTool = tname.toLowerCase();
          const selfDaemon = isSelfDaemonCommand(
            msg + " " + JSON.stringify(item.toolSpecificData ?? {}),
          );

          if (lowTool.includes("subagent")) {
            const subLabel =
              String(item.toolSpecificData?.agentName ?? item.generatedTitle ?? "Subagent");
            const subId = subLabel.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "subagent";
            const rawSubPrompt =
              typeof item.toolSpecificData?.prompt === "string"
                ? item.toolSpecificData.prompt
                : typeof item.toolSpecificData?.instructions === "string"
                  ? item.toolSpecificData.instructions
                  : typeof item.toolSpecificData?.description === "string"
                    ? item.toolSpecificData.description
                    : extractMessageText(item.invocationMessage);
            const subPrompt = rawSubPrompt.trim();
            const inlinePrompt = subPrompt ? subPrompt.slice(0, 1000) : "";
            const compactSpecificData = item.toolSpecificData
              ? {
                  ...item.toolSpecificData,
                  ...(typeof item.toolSpecificData.prompt === "string"
                    ? { prompt: item.toolSpecificData.prompt.slice(0, 1000) }
                    : {}),
                  ...(typeof item.toolSpecificData.instructions === "string"
                    ? { instructions: item.toolSpecificData.instructions.slice(0, 1000) }
                    : {}),
                }
              : undefined;
            emit({
              epoch: stepEpoch,
              kind: "subagent_spawn",
              toolName: tname,
              toolCallId: callId,
              targetAgentId: subId,
              summary: `Spawned ${subLabel}`,
              payload: {
                toolSpecificData: compactSpecificData,
                ...(inlinePrompt ? { prompt: inlinePrompt } : {}),
              },
              ...(subPrompt
                ? { fullBody: subPrompt, inlineBody: inlinePrompt }
                : {}),
            });
            if (item.isComplete) {
              const doneText = (
                extractMessageText(item.pastTenseMessage) ||
                (typeof item.resultDetails === "string" ? item.resultDetails : "")
              ).trim();
              const inlineDone = doneText ? doneText.slice(0, 1000) : "";
              emit({
                epoch: stepEpoch + 0.005,
                kind: "subagent_done",
                toolName: tname,
                toolCallId: callId,
                targetAgentId: subId,
                summary: `Subagent finished: ${subLabel}`,
                ...(inlineDone ? { payload: { body: inlineDone } } : {}),
                ...(doneText
                  ? { fullBody: doneText, inlineBody: inlineDone }
                  : {}),
              });
            }
          } else if (lowTool === "vscode_askquestions") {
            emit({
              epoch: stepEpoch,
              kind: "tool_start",
              toolName: tname,
              toolCallId: callId,
              targetAgentId: "human",
              summary: msg.slice(0, 90),
              waitingReason: item.isComplete ? undefined : "user",
            });
            if (item.isComplete) {
              emit({
                epoch: stepEpoch + 0.005,
                kind: "tool_end",
                toolName: tname,
                toolCallId: callId,
                summary: `Answered: ${msg.slice(0, 80)}`,
              });
            }
          } else {
            const needsApproval =
              item.isComplete === false && item.isConfirmed === false;
            const specificArgs = item.toolSpecificData ?? {};
            const isBoardMut = isBoardMutationToolCall(tname, specificArgs);
            const cleanMsg = isBoardMut
              ? summarizeToolCall(tname, specificArgs)
              : cleanHumanSummary(msg, 140) || summarizeToolCall(tname, specificArgs);
            emit({
              epoch: stepEpoch,
              kind: isBoardMut ? "board_mutation" : "tool_start",
              toolName: tname,
              toolCallId: callId,
              summary: cleanMsg,
              isSelfDaemon: selfDaemon,
              waitingReason: needsApproval ? "tool_approval" : undefined,
              payload: {
                isConfirmed: item.isConfirmed,
                toolSpecificData: item.toolSpecificData,
              },
            });
            if (item.isComplete) {
              emit({
                epoch: stepEpoch + 0.005,
                kind: "tool_end",
                toolName: tname,
                toolCallId: callId,
                summary: cleanHumanSummary(`Completed: ${cleanMsg}`, 140),
                isSelfDaemon: selfDaemon,
                payload: {
                  resultDetails: item.resultDetails,
                  routineEnd: true,
                },
              });
            }
          }
        } else if (
          rkind === "questionCarousel" ||
          rkind === "elicitationSerialized"
        ) {
          emit({
            epoch: stepEpoch,
            kind: "tool_start",
            toolName: rkind,
            toolCallId: `${req.requestId ?? rIdx}:${i}:${rkind}`,
            targetAgentId: "human",
            summary: "Waiting for user answer",
            waitingReason: "user",
          });
        } else if (rkind === "textEditGroup") {
          const callId = `${req.requestId ?? rIdx}:${i}:edit`;
          emit({
            epoch: stepEpoch,
            kind: "tool_start",
            toolName: "copilot_edit",
            toolCallId: callId,
            summary: "Edit workspace files",
          });
          emit({
            epoch: stepEpoch + 0.002,
            kind: "tool_end",
            toolName: "copilot_edit",
            toolCallId: callId,
            summary: "Applied file edits",
          });
        }
      }

      // 3. Turn completion
      const completedAtMs = req.modelState?.completedAt;
      if ((completedAtMs || req.result) && !req.isCanceled) {
        const endEpoch = parseEpochSeconds(
          completedAtMs,
          reqEpoch + (responses.length + 1) * 0.01,
        );
        const hasErr = Boolean(req.result?.errorDetails);
        const markdownChunks = responses
          .filter(
            (r) => !r.kind || r.kind === "markdownContent" || r.kind === "text",
          )
          .map((r) =>
            (extractMessageText(r.value) || extractMessageText(r.content)).trim(),
          )
          .filter(Boolean);
        const turnText = (
          markdownChunks.join("\n\n") ||
          req.result?.errorDetails?.message ||
          req.result?.details ||
          ""
        ).trim();
        const inlineTurnBody = turnText ? turnText.slice(0, 1000) : "";
        const turnPayload: Record<string, unknown> | undefined =
          req.result || inlineTurnBody
            ? {
                ...(req.result ? { result: req.result } : {}),
                ...(inlineTurnBody ? { body: inlineTurnBody } : {}),
              }
            : undefined;
        emit({
          epoch: Math.max(endEpoch, reqEpoch + (responses.length + 1) * 0.01),
          kind: "assistant_turn_end",
          summary: hasErr
            ? `Error: ${req.result?.errorDetails?.message ?? "Copilot error"}`
            : "Turn completed",
          status: hasErr ? "error" : "ok",
          isError: hasErr,
          payload: turnPayload,
          ...(turnText
            ? { fullBody: turnText, inlineBody: inlineTurnBody }
            : {}),
        });
      }
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
        isTotal: true,
      };
      targetEv.usageDelta = usageDelta;
      targetEv.payload = { ...(targetEv.payload ?? {}), _usageDelta: usageDelta };
    }

    return events;
  }
}
