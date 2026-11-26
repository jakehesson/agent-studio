import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listProjects } from "../../board/registry.js";
import { MAX_TRANSCRIPT_BYTES, validateTranscriptPath } from "../push-bus.js";
import {
  cleanHumanSummary,
  computeDeterministicEventId,
  computeMergeKey,
  isBoardMutationToolCall,
  isOpaqueAgentId,
  isSelfDaemonCommand,
  normalizeCopilotUsage,
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

interface VSCodeUsageObject {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cachedTokens?: number;
  cachedPromptTokens?: number;
  cacheReadInputTokens?: number;
  cacheReadTokens?: number;
  cache_read_input_tokens?: number;
  cacheCreationInputTokens?: number;
  cache_creation_input_tokens?: number;
  contextTokens?: number;
  context_tokens?: number;
  currentTokens?: number;
  current_tokens?: number;
  tokenLimit?: number;
  token_limit?: number;
  maxInputTokens?: number;
  max_input_tokens?: number;
  contextWindow?: number;
  context_window?: number;
  totalTokens?: number;
  costUsd?: number;
  cost_usd?: number;
}

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
  uri?: string | { path?: string; fsPath?: string; external?: string };
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
    usage?: VSCodeUsageObject;
    metadata?: {
      promptTokens?: number;
      completionTokens?: number;
      cachedTokens?: number;
      cachedPromptTokens?: number;
      cacheReadInputTokens?: number;
      usage?: VSCodeUsageObject;
      toolCallRounds?: Array<{
        usage?: VSCodeUsageObject;
        modelId?: string;
      }>;
    };
  };
}

interface VSCodeChatSessionState {
  sessionId?: string;
  customTitle?: string;
  creationDate?: number;
  lastMessageDate?: number;
  inputState?: {
    selectedModel?:
      | string
      | {
          identifier?: string;
          id?: string;
          name?: string;
          metadata?: { id?: string; name?: string; maxInputTokens?: number };
        };
  };
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

export interface CopilotTranscriptParseOptions extends ParseSessionOptions {
  agentIdOverride?: string;
  agentLabelOverride?: string;
  parentAgentIdOverride?: string;
  workspacePath?: string;
  projectId?: string;
  allowedRoots?: ReadonlyArray<string>;
}

interface CachedTranscriptDiscoveryMeta {
  mtimeMs: number;
  sizeBytes: number;
  sessionId: string;
  title: string;
  isMultiAgent: boolean;
  isSubagentTranscript: boolean;
  distinctAgentsCount: number;
}

const VSCODE_VARIANTS = ["Code", "Code - Insiders", "VSCodium"] as const;

function variantStorageDir(variant: string): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, variant, "User", "workspaceStorage");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      variant,
      "User",
      "workspaceStorage",
    );
  }
  return path.join(os.homedir(), ".config", variant, "User", "workspaceStorage");
}

function defaultVSCodeStorageDirs(): string[] {
  const envOverride = process.env.VSCODE_STORAGE_DIR?.trim();
  if (envOverride) return [envOverride];
  return VSCODE_VARIANTS.map((v) => variantStorageDir(v));
}

function isSubagentToolName(lowTool: string): boolean {
  return (
    lowTool === "agent" ||
    lowTool === "runsubagent" ||
    lowTool === "agent/runsubagent" ||
    lowTool.includes("subagent")
  );
}

function extractSelectedModel(
  selectedModel: NonNullable<VSCodeChatSessionState["inputState"]>["selectedModel"],
): string | undefined {
  if (!selectedModel) return undefined;
  if (typeof selectedModel === "string") {
    return selectedModel.trim() || undefined;
  }
  return (
    selectedModel.metadata?.id?.trim() ||
    selectedModel.id?.trim() ||
    selectedModel.identifier?.trim() ||
    selectedModel.metadata?.name?.trim() ||
    selectedModel.name?.trim() ||
    undefined
  );
}

function extractSelectedModelContextWindow(
  selectedModel: NonNullable<VSCodeChatSessionState["inputState"]>["selectedModel"],
): number | undefined {
  if (!selectedModel || typeof selectedModel === "string") return undefined;
  const maxIn = selectedModel.metadata?.maxInputTokens;
  if (typeof maxIn === "number" && Number.isFinite(maxIn) && maxIn > 0) {
    return Math.round(maxIn);
  }
  return undefined;
}

function extractUriBasename(uri: VSCodeResponseItem["uri"]): string | undefined {
  if (!uri) return undefined;
  const raw =
    typeof uri === "string"
      ? uri
      : uri.fsPath || uri.path || uri.external || "";
  const rawClean = raw.trim().split(/[?#]/)[0] ?? "";
  if (!rawClean) return undefined;
  let decoded = rawClean;
  try {
    decoded = decodeURIComponent(rawClean);
  } catch {
    // keep raw if malformed URI encoding
  }
  const norm = decoded
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const base = path.posix.basename(norm);
  return base || undefined;
}

function isMessageToolName(lowTool: string): boolean {
  return (
    lowTool === "write_agent" ||
    lowTool === "read_agent" ||
    lowTool === "send_message" ||
    lowTool === "sendmessage"
  );
}

function extractMessageTarget(args: Record<string, unknown>): string | undefined {
  for (const key of [
    "targetAgentId",
    "target_agent_id",
    "agent_id",
    "agentId",
    "recipient",
    "Recipient",
    "target",
    "to",
    "agent_name",
    "agentName",
    "name",
  ]) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return undefined;
}

function extractMessagePayload(args: Record<string, unknown>): {
  msgTarget?: string;
  msgBody?: string;
  inlineBody?: string;
  compactArgs: Record<string, unknown>;
} {
  const msgTarget = extractMessageTarget(args);
  const rawVal = args.message ?? args.content ?? args.body;
  const msgBody = typeof rawVal === "string" ? rawVal.trim() : undefined;
  const inlineBody = msgBody ? msgBody.slice(0, 1400) : undefined;
  const compactArgs =
    msgBody && msgBody.length > 1400
      ? {
          ...args,
          ...(typeof args.message === "string" ? { message: inlineBody } : {}),
          ...(typeof args.content === "string" ? { content: inlineBody } : {}),
          ...(typeof args.body === "string" ? { body: inlineBody } : {}),
        }
      : args;
  return { msgTarget, msgBody, inlineBody, compactArgs };
}

function extractUsageNumbers(
  u: Record<string, unknown> | VSCodeUsageObject | undefined,
): {
  inTok?: number;
  outTok?: number;
  cachedTok: number;
  contextTok?: number;
  contextWindow?: number;
  costUsd?: number;
} {
  if (!u || typeof u !== "object") {
    return { cachedTok: 0 };
  }
  const rec = u as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const inTok = num("promptTokens", "inputTokens", "input_tokens", "prompt_tokens");
  const outTok = num(
    "completionTokens",
    "outputTokens",
    "output_tokens",
    "completion_tokens",
  );
  const cacheRead =
    num(
      "cachedTokens",
      "cachedPromptTokens",
      "cacheReadInputTokens",
      "cacheReadTokens",
      "cache_read_input_tokens",
      "cache_read_tokens",
    ) ?? 0;
  const cacheCreate =
    num(
      "cacheCreationInputTokens",
      "cache_creation_input_tokens",
      "cacheWriteTokens",
      "cache_write_tokens",
    ) ?? 0;
  const contextTok = num(
    "contextTokens",
    "context_tokens",
    "currentTokens",
    "current_tokens",
  );
  const rawWin = num(
    "tokenLimit",
    "token_limit",
    "maxInputTokens",
    "max_input_tokens",
    "contextWindow",
    "context_window",
  );
  const contextWindow =
    rawWin !== undefined && rawWin > 0 ? Math.round(rawWin) : undefined;
  const costUsd = num("costUsd", "cost_usd", "totalCostUSD");
  return {
    inTok,
    outTok,
    cachedTok: Math.max(0, Math.round(cacheRead + cacheCreate)),
    contextTok,
    contextWindow,
    costUsd,
  };
}

function extractModelMetricsUsage(modelMetrics: unknown): {
  inTok?: number;
  outTok?: number;
  cachedTok: number;
  contextWindow?: number;
  costUsd?: number;
  model?: string;
} {
  if (!modelMetrics || typeof modelMetrics !== "object") {
    return { cachedTok: 0 };
  }
  const entries: Array<[string | undefined, unknown]> = Array.isArray(modelMetrics)
    ? modelMetrics.map((v) => [undefined, v])
    : Object.entries(modelMetrics as Record<string, unknown>);

  let hasIn = false;
  let hasOut = false;
  let inSum = 0;
  let outSum = 0;
  let cachedSum = 0;
  let contextWindow: number | undefined;
  let costSum = 0;
  let hasCost = false;
  let model: string | undefined;

  for (const [mKey, val] of entries) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const rec = val as Record<string, unknown>;
    if (!model && mKey) {
      const pretty = prettifyModelName(mKey) || mKey;
      if (pretty) model = pretty;
    }
    const usageObj =
      rec.usage && typeof rec.usage === "object" && !Array.isArray(rec.usage)
        ? (rec.usage as Record<string, unknown>)
        : rec;
    const u = extractUsageNumbers(usageObj);
    const outer = extractUsageNumbers(rec);
    const cw = u.contextWindow ?? outer.contextWindow;
    if (cw !== undefined && cw > 0) contextWindow = cw;
    if (u.inTok !== undefined) {
      hasIn = true;
      inSum += Math.max(0, Math.round(u.inTok));
    }
    if (u.outTok !== undefined) {
      hasOut = true;
      outSum += Math.max(0, Math.round(u.outTok));
    }
    cachedSum += u.cachedTok;
    const cost = u.costUsd ?? outer.costUsd;
    if (cost !== undefined && cost >= 0) {
      costSum += cost;
      hasCost = true;
    }
  }

  return {
    ...(hasIn ? { inTok: inSum } : {}),
    ...(hasOut ? { outTok: outSum } : {}),
    cachedTok: cachedSum,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(hasCost ? { costUsd: costSum } : {}),
    ...(model ? { model } : {}),
  };
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

interface TranscriptRow {
  type?: string;
  event?: string;
  id?: string;
  timestamp?: string | number;
  sessionId?: string;
  parentSessionId?: string;
  model?: string;
  modelId?: string;
  content?: string;
  prompt?: string;
  agentId?: string;
  agentName?: string;
  agentType?: string;
  usage?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function isTranscriptJsonlPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  return norm.includes("/transcripts/") && norm.endsWith(".jsonl");
}

function parseJsonlRows(raw: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rows.push(parsed as TranscriptRow);
      }
    } catch {
      // Ignore partial lines during active writes.
    }
  }
  return rows;
}

export class CopilotVSCodeAdapter implements PassiveIdeAdapter {
  readonly ide = "copilot-vscode" as const;
  private readonly storageDir: string;
  private readonly storageDirs: string[];
  private readonly stateCache = new Map<
    string,
    { mtimeMs: number; sizeBytes: number; state: VSCodeChatSessionState }
  >();
  private readonly transcriptDiscoveryCache = new Map<
    string,
    CachedTranscriptDiscoveryMeta
  >();

  constructor(options?: CopilotVSCodeAdapterOptions) {
    const explicit =
      options?.storageDir?.trim() || process.env.VSCODE_STORAGE_DIR?.trim();
    if (explicit) {
      this.storageDir = explicit;
      this.storageDirs = [explicit];
    } else {
      this.storageDirs = defaultVSCodeStorageDirs();
      this.storageDir = this.storageDirs[0]!;
    }
  }

  getStorageDirs(): string[] {
    return [...this.storageDirs];
  }

  private getDefaultAllowedTranscriptRoots(workspacePath?: string): string[] {
    const roots = new Set<string>(this.storageDirs);
    const home = os.homedir();
    roots.add(path.join(home, ".copilot"));
    roots.add(path.join(home, ".claude"));
    roots.add(path.join(home, ".gemini"));
    try {
      for (const proj of listProjects()) {
        if (proj.root) roots.add(proj.root);
      }
    } catch {
      // Registry unreadable
    }
    if (workspacePath && workspacePath.trim()) {
      roots.add(workspacePath.trim());
    }
    return [...roots];
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
    const existingDirs: string[] = [];
    for (const dir of this.storageDirs) {
      try {
        const st = await fs.stat(dir);
        if (st.isDirectory()) existingDirs.push(dir);
      } catch {
        // Variant not installed
      }
    }
    if (existingDirs.length === 0) {
      return {
        ide: this.ide,
        status: "degraded",
        rootDir: this.storageDir,
        sessionsFound: 0,
        message: "VS Code workspaceStorage directory not found",
      };
    }
    const sessions = await this.discoverSessions({ limit: 50 });
    return {
      ide: this.ide,
      status: "ok",
      rootDir: existingDirs[0]!,
      sessionsFound: sessions.length,
    };
  }

  async discoverSessions(opts?: {
    limit?: number;
    workspaceRoots?: string[];
  }): Promise<DiscoveredSession[]> {
    const knownProjects = getKnownProjects();
    const byId = new Map<string, DiscoveredSession>();
    const limit = opts?.limit ?? 100;

    interface TranscriptCandidate {
      filePath: string;
      fname: string;
      mtimeMs: number;
      sizeBytes: number;
      workspacePath?: string;
      projectId?: string;
    }
    const transcriptCandidates: TranscriptCandidate[] = [];

    for (const baseStorageDir of this.storageDirs) {
      let hashDirs: string[];
      try {
        hashDirs = await fs.readdir(baseStorageDir);
      } catch {
        continue;
      }

      for (const hdir of hashDirs) {
        const wsDir = path.join(baseStorageDir, hdir);
        const workspacePath = await readWorkspaceJsonFolder(wsDir);
        const workspaces = workspacePath ? [workspacePath] : [];
        const projectId =
          matchProjectIdForWorkspaces(workspaces, knownProjects) ??
          (workspacePath ? path.basename(workspacePath) : undefined);

        // 1. chatSessions/*.json(l)
        const chatDir = path.join(wsDir, "chatSessions");
        let chatFiles: string[] = [];
        try {
          chatFiles = await fs.readdir(chatDir);
        } catch {
          chatFiles = [];
        }

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
            state.sessionId || fname.replace(/\.jsonl?$/i, "");

          const firstPrompt = requests[0]?.message?.text
            ?.replace(/\s+/g, " ")
            .trim();
          const title =
            state.customTitle?.trim() ||
            firstPrompt?.slice(0, 80) ||
            `Copilot ${sessionId.slice(0, 8)}`;

          let hasSubagent = false;
          for (const req of requests) {
            for (const resp of req.response ?? []) {
              const tid = (resp.toolId ?? resp.toolName ?? "").toLowerCase();
              if (isSubagentToolName(tid)) {
                hasSubagent = true;
                break;
              }
            }
            if (hasSubagent) break;
          }

          const candidate: DiscoveredSession = {
            ide: this.ide,
            sessionId,
            filePath,
            workspacePath,
            workspaces: workspacePath ? [workspacePath] : [],
            projectId,
            title,
            mtimeMs: fst.mtimeMs,
            sizeBytes: fst.size,
            isMultiAgent: hasSubagent,
          };
          const prev = byId.get(sessionId);
          if (!prev || candidate.mtimeMs > prev.mtimeMs) {
            byId.set(sessionId, candidate);
          }
        }

        // 2. Collect GitHub.copilot-chat/transcripts/*.jsonl stats first
        const transcriptsDir = path.join(
          wsDir,
          "GitHub.copilot-chat",
          "transcripts",
        );
        let transcriptFiles: string[] = [];
        try {
          transcriptFiles = await fs.readdir(transcriptsDir);
        } catch {
          transcriptFiles = [];
        }

        for (const fname of transcriptFiles) {
          if (!fname.endsWith(".jsonl")) continue;
          const filePath = path.join(transcriptsDir, fname);
          let fst;
          try {
            fst = await fs.stat(filePath);
            if (!fst.isFile() || fst.size === 0 || fst.size > MAX_TRANSCRIPT_BYTES) {
              continue;
            }
          } catch {
            continue;
          }
          transcriptCandidates.push({
            filePath,
            fname,
            mtimeMs: fst.mtimeMs,
            sizeBytes: fst.size,
            workspacePath,
            projectId,
          });
        }
      }
    }

    // Stat-sort transcripts desc and slice before reading/parsing, using (mtimeMs, sizeBytes) cache
    transcriptCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const cand of transcriptCandidates.slice(0, Math.max(limit * 2, 50))) {
      let meta = this.transcriptDiscoveryCache.get(cand.filePath);
      if (
        !meta ||
        meta.mtimeMs !== cand.mtimeMs ||
        meta.sizeBytes !== cand.sizeBytes
      ) {
        let raw = "";
        try {
          raw = await fs.readFile(cand.filePath, "utf8");
        } catch {
          continue;
        }
        const rows = parseJsonlRows(raw);
        if (rows.length === 0) continue;

        let sessionId = cand.fname.replace(/\.jsonl$/i, "");
        let title = `Copilot ${sessionId.slice(0, 8)}`;
        let isMultiAgent = false;
        let isSubagentTranscript = false;
        const distinctAgents = new Set<string>();

        for (const row of rows) {
          const rtype = (row.type ?? row.event ?? "").toLowerCase();
          const d =
            row.data && typeof row.data === "object" ? row.data : undefined;
          if (rtype === "session.start") {
            const sid =
              (typeof d?.sessionId === "string" && d.sessionId.trim()) ||
              (typeof row.sessionId === "string" && row.sessionId.trim());
            if (sid) sessionId = sid;
            if (
              (typeof d?.parentSessionId === "string" &&
                d.parentSessionId.trim()) ||
              (typeof row.parentSessionId === "string" &&
                row.parentSessionId.trim())
            ) {
              isSubagentTranscript = true;
            }
          }
          if (rtype === "user.message" && title.startsWith("Copilot ")) {
            const txt =
              (typeof d?.content === "string" && d.content) ||
              (typeof d?.transformedContent === "string" &&
                d.transformedContent) ||
              (typeof row.content === "string" && row.content) ||
              (typeof row.prompt === "string" && row.prompt) ||
              "";
            const clean = txt.replace(/\s+/g, " ").trim();
            if (clean) title = clean.slice(0, 80);
          }
          if (rtype.startsWith("subagent.")) {
            isMultiAgent = true;
          }
          const aid =
            (typeof d?.agentName === "string" && d.agentName) ||
            (typeof row.agentName === "string" && row.agentName) ||
            undefined;
          if (aid) distinctAgents.add(aid);
        }

        meta = {
          mtimeMs: cand.mtimeMs,
          sizeBytes: cand.sizeBytes,
          sessionId,
          title,
          isMultiAgent,
          isSubagentTranscript,
          distinctAgentsCount: distinctAgents.size,
        };
        this.transcriptDiscoveryCache.set(cand.filePath, meta);
      }

      if (meta.isSubagentTranscript) continue;

      const prev = byId.get(meta.sessionId);
      if (prev) {
        prev.mtimeMs = Math.max(prev.mtimeMs, cand.mtimeMs);
        prev.isMultiAgent =
          prev.isMultiAgent ||
          meta.isMultiAgent ||
          meta.distinctAgentsCount > 1;
        if (prev.title?.startsWith("Copilot ") && !meta.title.startsWith("Copilot ")) {
          prev.title = meta.title;
        }
      } else {
        byId.set(meta.sessionId, {
          ide: this.ide,
          sessionId: meta.sessionId,
          filePath: cand.filePath,
          workspacePath: cand.workspacePath,
          workspaces: cand.workspacePath ? [cand.workspacePath] : [],
          projectId: cand.projectId,
          title: meta.title,
          mtimeMs: cand.mtimeMs,
          sizeBytes: cand.sizeBytes,
          isMultiAgent: meta.isMultiAgent || meta.distinctAgentsCount > 1,
        });
      }
    }

    const sessions = [...byId.values()];
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions.slice(0, limit);
  }

  async parseTranscriptFile(
    filePath: string,
    sessionId: string,
    agentIdOrOpts?: string | CopilotTranscriptParseOptions,
    maybeOpts?: CopilotTranscriptParseOptions,
  ): Promise<EnrichedEvent[]> {
    const opts: CopilotTranscriptParseOptions =
      typeof agentIdOrOpts === "string"
        ? { ...(maybeOpts ?? {}), agentIdOverride: agentIdOrOpts }
        : { ...(agentIdOrOpts ?? {}) };

    const allowedRoots =
      opts.allowedRoots ??
      this.getDefaultAllowedTranscriptRoots(opts.workspacePath);
    const validPath = await validateTranscriptPath(filePath, allowedRoots, {
      maxBytes: MAX_TRANSCRIPT_BYTES,
    });
    if (!validPath) return [];

    let raw: string;
    let mtimeMs = Date.now();
    try {
      const fst = await fs.stat(validPath);
      if (!fst.isFile() || fst.size > MAX_TRANSCRIPT_BYTES) {
        return [];
      }
      mtimeMs = fst.mtimeMs;
      raw = await fs.readFile(validPath, "utf8");
    } catch {
      return [];
    }

    const rows = parseJsonlRows(raw);
    if (rows.length === 0) return [];

    const knownProjects = getKnownProjects();
    const workspacePath = opts.workspacePath;
    const projectId =
      opts.projectId ??
      (workspacePath
        ? matchProjectIdForWorkspaces([workspacePath], knownProjects) ??
          path.basename(workspacePath)
        : undefined);

    const events: EnrichedEvent[] = [];
    const defaultAgentId = opts.agentIdOverride?.trim() || "root";
    const defaultParentId =
      opts.parentAgentIdOverride ??
      (defaultAgentId !== "root" ? "root" : undefined);

    interface TranscriptUsageAcc {
      model?: string;
      hasExact: boolean;
      hasIncrementalExact: boolean;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      lastTurnContext: number;
      contextWindow?: number;
      cumulativeFallback?: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        costUsd?: number;
      };
      estInputChars: number;
      estOutputChars: number;
      priorBoundedProseChars: number;
      currTurnProseChars: number;
      currTurnChars: number;
      costUsd?: number;
      agentLabel?: string;
    }
    const usageAccByAgent = new Map<string, TranscriptUsageAcc>();
    const ensureAcc = (aid: string): TranscriptUsageAcc => {
      let acc = usageAccByAgent.get(aid);
      if (!acc) {
        acc = {
          hasExact: false,
          hasIncrementalExact: false,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          lastTurnContext: 0,
          estInputChars: 0,
          estOutputChars: 0,
          priorBoundedProseChars: 0,
          currTurnProseChars: 0,
          currTurnChars: 0,
        };
        usageAccByAgent.set(aid, acc);
      }
      return acc;
    };

    const emittedProseCompletionByAgent = new Map<string, boolean>();
    const toolSummaryMap = new Map<
      string,
      { toolName: string; summary: string; agentId: string }
    >();
    const subagentIdByCallId = new Map<
      string,
      { subId: string; subLabel: string }
    >();
    const usedSubagentSlugs = new Set<string>();
    let fallbackEpoch = mtimeMs / 1000 - Math.max(rows.length, 1);

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx]!;
      const rtype = (row.type ?? row.event ?? "").toLowerCase();
      const d =
        row.data && typeof row.data === "object" && !Array.isArray(row.data)
          ? row.data
          : (row as Record<string, unknown>);
      const epoch = parseEpochSeconds(
        (d.timestamp as string | number | undefined) ?? row.timestamp,
        fallbackEpoch + idx,
      );
      fallbackEpoch = epoch;

      const rowAgentRaw =
        (typeof d.agentId === "string" && d.agentId.trim()) ||
        (typeof row.agentId === "string" && row.agentId.trim()) ||
        undefined;
      const agentId = opts.agentIdOverride
        ? defaultAgentId
        : rowAgentRaw && rowAgentRaw !== "root"
          ? rowAgentRaw
          : defaultAgentId;
      const parentAgentId =
        agentId !== "root" ? defaultParentId ?? "root" : undefined;

      const acc = ensureAcc(agentId);
      if (
        opts.agentLabelOverride &&
        !isOpaqueAgentId(opts.agentLabelOverride) &&
        !acc.agentLabel
      ) {
        acc.agentLabel = opts.agentLabelOverride;
      }

      const rawLabelCandidates = [
        d.agentDisplayName,
        d.agentName,
        d.agentType,
        d.subAgentName,
        d.subagentName,
        row.agentName,
        row.agentType,
      ];
      const rawLabel = rawLabelCandidates.find(
        (v): v is string =>
          typeof v === "string" && Boolean(v.trim()) && !isOpaqueAgentId(v),
      )?.trim();
      if (rawLabel && !rtype.startsWith("subagent.") && !acc.agentLabel) {
        acc.agentLabel = rawLabel;
      }

      const rowModelRaw =
        (typeof d.newModel === "string" && d.newModel.trim()) ||
        (typeof d.selectedModel === "string" && d.selectedModel.trim()) ||
        (typeof d.model === "string" && d.model.trim()) ||
        (typeof d.modelId === "string" && d.modelId.trim()) ||
        (typeof row.model === "string" && row.model.trim()) ||
        (typeof row.modelId === "string" && row.modelId.trim()) ||
        undefined;
      if (rowModelRaw && !rtype.startsWith("subagent.")) {
        const pretty = prettifyModelName(rowModelRaw) || rowModelRaw;
        if (pretty) acc.model = pretty;
      }

      const usageCandidate =
        (d.usage && typeof d.usage === "object" && !Array.isArray(d.usage)
          ? (d.usage as Record<string, unknown>)
          : undefined) ??
        (row.usage &&
        typeof row.usage === "object" &&
        !Array.isArray(row.usage)
          ? row.usage
          : undefined) ??
        d;
      const u = extractUsageNumbers(usageCandidate);
      const dataMeta = extractUsageNumbers(d);
      const rowMeta = extractUsageNumbers(row as Record<string, unknown>);
      const rowContextWindow =
        u.contextWindow ?? dataMeta.contextWindow ?? rowMeta.contextWindow;
      if (rowContextWindow !== undefined && rowContextWindow > 0) {
        acc.contextWindow = rowContextWindow;
      }

      const isIncrementalUsageRow =
        rtype === "assistant.message" ||
        rtype === "assistant.usage" ||
        rtype === "session.usage_record";
      const isCumulativeUsageRow =
        rtype === "session.usage_checkpoint" || rtype === "session.shutdown";

      if (isIncrementalUsageRow) {
        if (
          u.inTok !== undefined ||
          u.outTok !== undefined ||
          u.contextTok !== undefined
        ) {
          const norm = normalizeCopilotUsage({
            inTok: u.inTok,
            outTok: u.outTok,
            cachedTok: u.cachedTok,
            contextTok: u.contextTok,
          });
          acc.hasExact = true;
          acc.hasIncrementalExact = true;
          acc.inputTokens += norm.freshIn;
          acc.outputTokens += norm.outTok;
          acc.cachedTokens += norm.cachedTok;
          if (norm.turnContext !== undefined) {
            acc.lastTurnContext = norm.turnContext;
          }
        }
        if (u.costUsd !== undefined && u.costUsd >= 0) {
          acc.costUsd = (acc.costUsd ?? 0) + u.costUsd;
        }
      } else if (isCumulativeUsageRow) {
        const mm =
          rtype === "session.shutdown" && d.modelMetrics
            ? extractModelMetricsUsage(d.modelMetrics)
            : undefined;
        if (mm?.contextWindow !== undefined && mm.contextWindow > 0) {
          acc.contextWindow = mm.contextWindow;
        }
        if (mm?.model && !acc.model) {
          acc.model = mm.model;
        }
        if (rtype === "session.usage_checkpoint") {
          const ckCtx = u.contextTok ?? dataMeta.contextTok;
          if (ckCtx !== undefined) {
            acc.lastTurnContext = Math.max(0, Math.round(ckCtx));
          }
        }
        const cumIn = mm?.inTok ?? u.inTok;
        const cumOut = mm?.outTok ?? u.outTok;
        const cumCached = mm && (mm.inTok !== undefined || mm.outTok !== undefined)
          ? mm.cachedTok
          : u.cachedTok;
        const cumCost = mm?.costUsd ?? u.costUsd;
        if (cumIn !== undefined || cumOut !== undefined) {
          const norm = normalizeCopilotUsage({
            inTok: cumIn,
            outTok: cumOut,
            cachedTok: cumCached,
          });
          acc.cumulativeFallback = {
            inputTokens: norm.freshIn,
            outputTokens: norm.outTok,
            cachedTokens: norm.cachedTok,
            ...(cumCost !== undefined && cumCost >= 0 ? { costUsd: cumCost } : {}),
          };
        }
      } else if (
        u.inTok !== undefined ||
        u.outTok !== undefined ||
        u.contextTok !== undefined
      ) {
        const norm = normalizeCopilotUsage({
          inTok: u.inTok,
          outTok: u.outTok,
          cachedTok: u.cachedTok,
          contextTok: u.contextTok,
        });
        acc.hasExact = true;
        acc.hasIncrementalExact = true;
        acc.inputTokens += norm.freshIn;
        acc.outputTokens += norm.outTok;
        acc.cachedTokens += norm.cachedTok;
        if (norm.turnContext !== undefined) {
          acc.lastTurnContext = norm.turnContext;
        }
        if (u.costUsd !== undefined && u.costUsd >= 0) {
          acc.costUsd = (acc.costUsd ?? 0) + u.costUsd;
        }
      }

      const agentLabel =
        acc.agentLabel ||
        (agentId === "root" ? "Copilot Agent" : undefined);

      const emit = (input: {
        epoch?: number;
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
        overrideAgentId?: string;
        overrideAgentLabel?: string;
        overrideParentAgentId?: string;
      }): void => {
        const evEpoch = input.epoch ?? epoch;
        const evAgentId = input.overrideAgentId ?? agentId;
        const evAgentLabel = input.overrideAgentLabel ?? agentLabel;
        const evParentId =
          input.overrideParentAgentId ??
          (evAgentId !== "root" ? parentAgentId ?? "root" : undefined);
        const id = computeDeterministicEventId({
          ide: this.ide,
          sessionId,
          agentId: evAgentId,
          kind: input.kind,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          epoch: evEpoch,
          summary: input.summary,
        });
        const mergeKey = computeMergeKey({
          sessionId,
          agentId: evAgentId,
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
        events.push({
          id,
          mergeKey,
          ts: toIsoUtc(evEpoch),
          epoch: evEpoch,
          ide: this.ide,
          channel: "passive",
          sessionId,
          workspacePath,
          projectId,
          agentId: evAgentId,
          ...(evAgentLabel ? { agentLabel: evAgentLabel } : {}),
          ...(evParentId ? { parentAgentId: evParentId } : {}),
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
          opts.onFullBody?.(id, input.fullBody!);
        }
      };

      if (rtype === "session.start") {
        emit({
          kind: "session_start",
          summary: "Session started",
          payload: {
            ...(rowModelRaw ? { model: rowModelRaw } : {}),
          },
        });
      } else if (rtype === "user.message") {
        emittedProseCompletionByAgent.set(agentId, false);
        const txt = (
          (typeof d.content === "string" && d.content) ||
          (typeof d.transformedContent === "string" && d.transformedContent) ||
          (typeof row.content === "string" && row.content) ||
          (typeof row.prompt === "string" && row.prompt) ||
          ""
        ).trim();
        if (txt) {
          if (acc.currTurnChars > 0) {
            acc.priorBoundedProseChars += Math.min(4000, acc.currTurnProseChars);
            acc.currTurnProseChars = 0;
            acc.currTurnChars = 0;
          }
          acc.estInputChars += txt.length;
          acc.currTurnProseChars += txt.length;
          acc.currTurnChars += txt.length;
          const inlineBody = txt.slice(0, 1400);
          if (agentId !== "root") {
            emit({
              kind: "thinking_start",
              summary: cleanHumanSummary(txt, 130) || "Starting task…",
              payload: { body: inlineBody, prompt: inlineBody },
              fullBody: txt,
              inlineBody,
            });
          } else {
            emit({
              kind: "user_input",
              targetAgentId: agentId,
              summary: `Human: ${cleanHumanSummary(txt, 130)}`,
              payload: {
                body: inlineBody,
                prompt: inlineBody,
                _passiveSource: "transcript",
              },
              fullBody: txt,
              inlineBody,
            });
          }
        }
      } else if (rtype === "assistant.turn_start") {
        emittedProseCompletionByAgent.set(agentId, false);
      } else if (rtype === "assistant.message") {
        const msgText =
          (typeof d.content === "string" && d.content.trim()) || "";
        const reasoning =
          (typeof d.reasoningText === "string" && d.reasoningText.trim()) || "";
        acc.estOutputChars += msgText.length + reasoning.length;
        acc.currTurnProseChars += msgText.length + reasoning.length;
        acc.currTurnChars += msgText.length + reasoning.length;
        if (reasoning) {
          emit({
            kind: "thinking_start",
            summary: cleanHumanSummary(reasoning, 100) || "Thinking…",
          });
        }
        const toolReqs = Array.isArray(d.toolRequests) ? d.toolRequests : [];
        if (toolReqs.length > 0) {
          if (msgText) {
            const inlineBody = msgText.slice(0, 1000);
            emit({
              kind: "thinking_start",
              summary: cleanHumanSummary(msgText, 140) || "Thinking…",
              payload: { body: inlineBody },
              fullBody: msgText,
              inlineBody,
            });
          }
          for (let ti = 0; ti < toolReqs.length; ti++) {
            const tr = toolReqs[ti] as Record<string, unknown>;
            const tname =
              (typeof tr.name === "string" && tr.name) ||
              (typeof tr.toolName === "string" && tr.toolName) ||
              "tool";
            const callId =
              (typeof tr.toolCallId === "string" && tr.toolCallId) ||
              `${idx}:${ti}:${tname}`;
            const args =
              tr.arguments &&
              typeof tr.arguments === "object" &&
              !Array.isArray(tr.arguments)
                ? (tr.arguments as Record<string, unknown>)
                : {};
            const lowTool = tname.toLowerCase();
            const isBoardMut = isBoardMutationToolCall(tname, args);
            const isMsgTool = isMessageToolName(lowTool);
            const sum = summarizeToolCall(tname, args);
            acc.currTurnChars += sum.length;
            toolSummaryMap.set(callId, { toolName: tname, summary: sum, agentId });
            const msgInfo = isMsgTool ? extractMessagePayload(args) : undefined;
            emit({
              epoch: epoch + (ti + (msgText ? 1 : 0)) * 0.0001,
              kind: isMsgTool
                ? "message"
                : isBoardMut
                  ? "board_mutation"
                  : "tool_start",
              toolName: tname,
              toolCallId: callId,
              ...(msgInfo?.msgTarget ? { targetAgentId: msgInfo.msgTarget } : {}),
              summary: sum,
              status: isMsgTool ? "ok" : "running",
              payload: {
                args: msgInfo?.compactArgs ?? args,
                ...(msgInfo?.inlineBody ? { body: msgInfo.inlineBody } : {}),
              },
              ...(msgInfo?.msgBody
                ? { fullBody: msgInfo.msgBody, inlineBody: msgInfo.inlineBody }
                : {}),
            });
          }
        } else if (msgText) {
          emittedProseCompletionByAgent.set(agentId, true);
          const inlineBody = msgText.slice(0, 1000);
          emit({
            kind:
              agentId === "root" ? "assistant_turn_end" : "subagent_done",
            summary: cleanHumanSummary(msgText, 140) || "Turn completed",
            status: "ok",
            payload: { body: inlineBody },
            fullBody: msgText,
            inlineBody,
          });
        }
      } else if (rtype === "assistant.turn_end") {
        if (emittedProseCompletionByAgent.get(agentId)) {
          emittedProseCompletionByAgent.set(agentId, false);
        } else {
          emit({
            kind: agentId === "root" ? "assistant_turn_end" : "subagent_done",
            summary: "Turn completed",
            status: "ok",
          });
        }
      } else if (rtype === "tool.execution_start") {
        const tname =
          (typeof d.mcpToolName === "string" && d.mcpToolName) ||
          (typeof d.toolName === "string" && d.toolName) ||
          "tool";
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) ||
          `${idx}:${tname}`;
        const args =
          d.arguments &&
          typeof d.arguments === "object" &&
          !Array.isArray(d.arguments)
            ? (d.arguments as Record<string, unknown>)
            : {};
        const lowTool = tname.toLowerCase();
        const isBoardMut = isBoardMutationToolCall(tname, args);
        const isMsgTool = isMessageToolName(lowTool);
        const sum = summarizeToolCall(tname, args);
        acc.currTurnChars += sum.length;
        const selfDaemon = isSelfDaemonCommand(
          sum + " " + JSON.stringify(args),
        );
        toolSummaryMap.set(callId, { toolName: tname, summary: sum, agentId });
        const msgInfo = isMsgTool ? extractMessagePayload(args) : undefined;
        emit({
          kind: isMsgTool
            ? "message"
            : isBoardMut
              ? "board_mutation"
              : "tool_start",
          toolName: tname,
          toolCallId: callId,
          ...(msgInfo?.msgTarget ? { targetAgentId: msgInfo.msgTarget } : {}),
          summary: sum,
          status: isMsgTool ? "ok" : "running",
          isSelfDaemon: selfDaemon,
          payload: {
            args: msgInfo?.compactArgs ?? args,
            ...(msgInfo?.inlineBody ? { body: msgInfo.inlineBody } : {}),
          },
          ...(msgInfo?.msgBody
            ? { fullBody: msgInfo.msgBody, inlineBody: msgInfo.inlineBody }
            : {}),
        });
      } else if (rtype === "tool.execution_complete") {
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) || undefined;
        const prev = callId ? toolSummaryMap.get(callId) : undefined;
        const tname =
          (typeof d.toolName === "string" && d.toolName) || prev?.toolName;
        const isErr = d.success === false || d.isError === true || Boolean(d.error);
        const baseLabel = prev?.summary ?? tname ?? "tool call";
        acc.currTurnChars += baseLabel.length;
        emit({
          kind: "tool_end",
          toolName: tname,
          toolCallId: callId,
          summary: cleanHumanSummary(
            isErr ? `Failed: ${baseLabel}` : `Completed: ${baseLabel}`,
            140,
          ),
          status: isErr ? "error" : "ok",
          isError: isErr,
          payload: {
            ...(d.result !== undefined ? { result: d.result } : {}),
            ...(d.error !== undefined ? { error: d.error } : {}),
            ...(!isErr ? { routineEnd: true } : {}),
          },
        });
      } else if (
        rtype === "subagent.started" ||
        rtype === "subagent.start"
      ) {
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) || undefined;
        const subLabel =
          [
            d.agentDisplayName,
            d.subAgentName,
            d.subagentName,
            d.agentName,
            d.agentType,
            d.subagentType,
            d.description,
          ]
            .find(
              (v): v is string =>
                typeof v === "string" &&
                Boolean(v.trim()) &&
                !isOpaqueAgentId(v),
            )
            ?.trim() || "Subagent";
        const explicitSubId =
          (typeof d.subAgentInvocationId === "string" &&
            d.subAgentInvocationId.trim() &&
            d.subAgentInvocationId.trim() !== "root" &&
            d.subAgentInvocationId.trim()) ||
          (typeof d.agentId === "string" &&
            d.agentId.trim() &&
            d.agentId.trim() !== "root" &&
            d.agentId.trim()) ||
          (typeof d.subagentId === "string" &&
            d.subagentId.trim() &&
            d.subagentId.trim() !== "root" &&
            d.subagentId.trim()) ||
          undefined;
        const baseSlug =
          subLabel
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "subagent";
        let rawSubId: string;
        if (explicitSubId) {
          rawSubId = explicitSubId;
          usedSubagentSlugs.add(rawSubId);
        } else {
          rawSubId = baseSlug;
          let suffix = 2;
          while (usedSubagentSlugs.has(rawSubId)) {
            rawSubId = `${baseSlug}-${suffix++}`;
          }
          usedSubagentSlugs.add(rawSubId);
        }
        if (callId) {
          subagentIdByCallId.set(callId, { subId: rawSubId, subLabel });
        }
        const subModel =
          typeof d.model === "string" && d.model.trim()
            ? prettifyModelName(d.model) || d.model.trim()
            : undefined;
        if (subModel) {
          const subAcc = ensureAcc(rawSubId);
          subAcc.model = subModel;
          subAcc.agentLabel = subLabel;
        }
        const subPrompt =
          typeof d.prompt === "string" ? d.prompt.trim() : "";
        const inlinePrompt = subPrompt ? subPrompt.slice(0, 1000) : "";
        const spawnActorLabel =
          defaultAgentId === "root"
            ? usageAccByAgent.get("root")?.agentLabel || "Copilot Agent"
            : usageAccByAgent.get(defaultAgentId)?.agentLabel ||
              (opts.agentLabelOverride &&
              !isOpaqueAgentId(opts.agentLabelOverride)
                ? opts.agentLabelOverride
                : undefined);
        emit({
          kind: "subagent_spawn",
          toolName: "runSubagent",
          toolCallId: callId,
          targetAgentId: rawSubId,
          overrideAgentId: defaultAgentId,
          overrideAgentLabel: spawnActorLabel,
          overrideParentAgentId:
            defaultAgentId !== "root" ? defaultParentId ?? "root" : undefined,
          summary: `Spawned ${subLabel}`,
          payload: {
            agentLabel: subLabel,
            agentType: subLabel,
            _passiveSource: "transcript",
            ...(subModel
              ? { childModel: subModel, childModelSource: "exact" }
              : {}),
            ...(inlinePrompt ? { prompt: inlinePrompt } : {}),
          },
          ...(subPrompt
            ? { fullBody: subPrompt, inlineBody: inlinePrompt }
            : {}),
        });
      } else if (
        rtype === "subagent.completed" ||
        rtype === "subagent.stop" ||
        rtype === "subagent.failed"
      ) {
        const callId =
          (typeof d.toolCallId === "string" && d.toolCallId) || undefined;
        const prevSub = callId ? subagentIdByCallId.get(callId) : undefined;
        const subLabel =
          prevSub?.subLabel ||
          [
            d.agentDisplayName,
            d.subAgentName,
            d.subagentName,
            d.agentName,
            d.agentType,
            d.subagentType,
          ]
            .find(
              (v): v is string =>
                typeof v === "string" &&
                Boolean(v.trim()) &&
                !isOpaqueAgentId(v),
            )
            ?.trim() ||
          "Subagent";
        const rawSubId =
          prevSub?.subId ||
          (typeof d.agentId === "string" && d.agentId.trim()) ||
          (typeof d.subagentId === "string" && d.subagentId.trim()) ||
          subLabel.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") ||
          "subagent";
        const isErr = rtype === "subagent.failed" || Boolean(d.error);
        const doneText =
          typeof d.result === "string"
            ? d.result.trim()
            : typeof d.error === "string"
              ? d.error.trim()
              : "";
        const inlineDone = doneText ? doneText.slice(0, 1000) : "";
        const doneActorLabel =
          defaultAgentId === "root"
            ? usageAccByAgent.get("root")?.agentLabel || "Copilot Agent"
            : usageAccByAgent.get(defaultAgentId)?.agentLabel ||
              (opts.agentLabelOverride &&
              !isOpaqueAgentId(opts.agentLabelOverride)
                ? opts.agentLabelOverride
                : undefined);
        emit({
          kind: "subagent_done",
          toolName: "runSubagent",
          toolCallId: callId,
          targetAgentId: rawSubId,
          overrideAgentId: defaultAgentId,
          overrideAgentLabel: doneActorLabel,
          overrideParentAgentId:
            defaultAgentId !== "root" ? defaultParentId ?? "root" : undefined,
          summary: isErr
            ? `Subagent failed: ${subLabel}`
            : `Subagent finished: ${subLabel}`,
          status: isErr ? "error" : "ok",
          isError: isErr,
          ...(inlineDone ? { payload: { body: inlineDone } } : {}),
          ...(doneText
            ? { fullBody: doneText, inlineBody: inlineDone }
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
      if (!acc.hasIncrementalExact && acc.cumulativeFallback) {
        acc.hasExact = true;
        acc.inputTokens = acc.cumulativeFallback.inputTokens;
        acc.outputTokens = acc.cumulativeFallback.outputTokens;
        acc.cachedTokens = acc.cumulativeFallback.cachedTokens;
        if (
          acc.costUsd === undefined &&
          acc.cumulativeFallback.costUsd !== undefined
        ) {
          acc.costUsd = acc.cumulativeFallback.costUsd;
        }
      } else if (acc.lastTurnContext > 0) {
        acc.hasExact = true;
      }
      const inputTokens = acc.hasExact
        ? acc.inputTokens
        : Math.round(acc.estInputChars / 4);
      const outputTokens = acc.hasExact
        ? acc.outputTokens
        : Math.round(acc.estOutputChars / 4);
      const cachedTokens = acc.hasExact ? acc.cachedTokens : 0;
      const contextTokens = acc.hasExact
        ? acc.lastTurnContext
        : Math.round((acc.priorBoundedProseChars + acc.currTurnChars) / 4);
      const usageDelta: UsageDelta = {
        model: acc.model,
        modelSource: acc.model ? "exact" : "unknown",
        usageSource: acc.hasExact ? "exact" : "estimated",
        inputTokens,
        outputTokens,
        cachedTokens,
        contextTokens,
        ...(acc.contextWindow !== undefined
          ? { contextWindow: acc.contextWindow }
          : {}),
        ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
        isTotal: true,
      };
      targetEv.usageDelta = usageDelta;
      targetEv.payload = { ...(targetEv.payload ?? {}), _usageDelta: usageDelta };
    }

    return events;
  }

  async parseSession(
    session: DiscoveredSession,
    opts?: ParseSessionOptions,
  ): Promise<EnrichedEvent[]> {
    if (
      !session.filePath ||
      path.basename(session.filePath).toLowerCase() === "telemetry.jsonl"
    ) {
      return [];
    }

    if (isTranscriptJsonlPath(session.filePath)) {
      return this.parseTranscriptFile(session.filePath, session.sessionId, {
        ...opts,
        workspacePath: session.workspacePath,
        projectId: session.projectId,
      });
    }

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

    const selectedModelFallback = extractSelectedModel(
      state.inputState?.selectedModel,
    );
    const selectedModelContextWindow = extractSelectedModelContextWindow(
      state.inputState?.selectedModel,
    );

    const requests = Array.isArray(state.requests) ? state.requests : [];
    const events: EnrichedEvent[] = [];

    interface CopilotUsageAcc {
      model?: string;
      hasExact: boolean;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      lastTurnContext: number;
      contextWindow?: number;
      estInputChars: number;
      estOutputChars: number;
      priorBoundedProseChars: number;
      prevTurnProseChars: number;
      latestTurnChars: number;
      costUsd?: number;
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
          contextWindow: selectedModelContextWindow,
          estInputChars: 0,
          estOutputChars: 0,
          priorBoundedProseChars: 0,
          prevTurnProseChars: 0,
          latestTurnChars: 0,
        };
        usageAccByAgent.set(aid, acc);
      }
      return acc;
    };

    const usedSubagentSlugs = new Set<string>();

    for (let rIdx = 0; rIdx < requests.length; rIdx++) {
      const req = requests[rIdx]!;
      const reqEpoch = parseEpochSeconds(
        req.timestamp,
        (state.creationDate ? state.creationDate / 1000 : session.mtimeMs / 1000) +
          rIdx,
      );
      // Top-level requests[] always belong to the root coordinator thread
      const agentId = "root";
      const agentLabel = "Copilot Agent";

      const acc = ensureAcc(agentId);
      const rawModel =
        (typeof req.modelId === "string" && req.modelId.trim()
          ? req.modelId
          : undefined) ?? selectedModelFallback;
      if (rawModel) {
        const pretty = prettifyModelName(rawModel);
        if (pretty) acc.model = pretty;
      }

      const rounds = Array.isArray(req.result?.metadata?.toolCallRounds)
        ? req.result!.metadata!.toolCallRounds!
        : [];
      const roundUsages = rounds
        .map((r) => extractUsageNumbers(r.usage))
        .filter((u) => u.inTok !== undefined || u.outTok !== undefined);

      const directUsage = extractUsageNumbers(
        req.result?.usage ?? req.result?.metadata?.usage,
      );
      const metaFields = extractUsageNumbers(
        req.result?.metadata as Record<string, unknown> | undefined,
      );
      const reqContextWindow =
        directUsage.contextWindow ?? metaFields.contextWindow;
      if (reqContextWindow !== undefined && reqContextWindow > 0) {
        acc.contextWindow = reqContextWindow;
      }

      const hasDirectPromptOrContext =
        directUsage.inTok !== undefined ||
        directUsage.contextTok !== undefined ||
        metaFields.inTok !== undefined ||
        metaFields.contextTok !== undefined;
      const hasDirectOut =
        directUsage.outTok !== undefined ||
        metaFields.outTok !== undefined ||
        typeof req.completionTokens === "number";

      if (
        hasDirectPromptOrContext ||
        (hasDirectOut && roundUsages.length === 0)
      ) {
        const rawIn = directUsage.inTok ?? metaFields.inTok;
        const rawOut =
          directUsage.outTok ??
          metaFields.outTok ??
          (typeof req.completionTokens === "number"
            ? req.completionTokens
            : undefined);
        const rawCached =
          directUsage.cachedTok > 0
            ? directUsage.cachedTok
            : metaFields.cachedTok;
        const rawCtx = directUsage.contextTok ?? metaFields.contextTok;
        const norm = normalizeCopilotUsage({
          inTok: rawIn,
          outTok: rawOut,
          cachedTok: rawCached,
          contextTok: rawCtx,
        });
        acc.hasExact = true;
        acc.inputTokens += norm.freshIn;
        acc.outputTokens += norm.outTok;
        acc.cachedTokens += norm.cachedTok;
        if (norm.turnContext !== undefined) {
          acc.lastTurnContext = norm.turnContext;
        }
        const cost = directUsage.costUsd ?? metaFields.costUsd;
        if (cost !== undefined && cost >= 0) {
          acc.costUsd = (acc.costUsd ?? 0) + cost;
        }
      } else if (roundUsages.length > 0) {
        acc.hasExact = true;
        for (const ru of roundUsages) {
          if (ru.contextWindow !== undefined && ru.contextWindow > 0) {
            acc.contextWindow = ru.contextWindow;
          }
          const norm = normalizeCopilotUsage({
            inTok: ru.inTok,
            outTok: ru.outTok,
            cachedTok: ru.cachedTok,
            contextTok: ru.contextTok,
          });
          acc.inputTokens += norm.freshIn;
          acc.outputTokens += norm.outTok;
          acc.cachedTokens += norm.cachedTok;
          if (norm.turnContext !== undefined) {
            acc.lastTurnContext = norm.turnContext;
          }
          if (ru.costUsd !== undefined && ru.costUsd >= 0) {
            acc.costUsd = (acc.costUsd ?? 0) + ru.costUsd;
          }
        }
      }

      const reqPromptChars = (req.message?.text ?? "").length;
      acc.estInputChars += reqPromptChars;
      let respVisibleChars = 0;
      let respProseChars = 0;
      if (Array.isArray(req.response)) {
        for (const item of req.response) {
          const rk = item.kind ?? "";
          if (rk === "thinking") {
            const len =
              extractMessageText(item.value).length +
              (item.generatedTitle?.length ?? 0);
            respVisibleChars += len;
            respProseChars += len;
          } else if (!rk || rk === "markdownContent" || rk === "text") {
            const len = (
              extractMessageText(item.value) || extractMessageText(item.content)
            ).length;
            respVisibleChars += len;
            respProseChars += len;
          } else if (rk === "toolInvocationSerialized") {
            const title =
              extractMessageText(item.pastTenseMessage) ||
              extractMessageText(item.invocationMessage) ||
              item.generatedTitle ||
              item.toolId ||
              item.toolName ||
              "";
            respVisibleChars += title.length;
          } else if (rk === "textEditGroup") {
            const base = extractUriBasename(item.uri);
            respVisibleChars += base ? `Edit ${base}`.length : 20;
          } else {
            const len = (
              extractMessageText(item.value) ||
              extractMessageText(item.content) ||
              item.generatedTitle ||
              ""
            ).length;
            respVisibleChars += len;
          }
        }
      }
      acc.estOutputChars += respVisibleChars;
      if (acc.latestTurnChars > 0) {
        acc.priorBoundedProseChars += Math.min(4000, acc.prevTurnProseChars);
      }
      acc.prevTurnProseChars = reqPromptChars + respProseChars;
      acc.latestTurnChars = reqPromptChars + respVisibleChars;

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
          summary: `Human: ${cleanHumanSummary(promptText, 130)}`,
          payload: {
            body: inlineBody,
            requestId: req.requestId,
            _passiveSource: "chatSessions",
          },
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
          const thinkText = extractMessageText(item.value).trim();
          const genTitle =
            typeof item.generatedTitle === "string"
              ? item.generatedTitle.trim()
              : "";
          const inlineBody = thinkText ? thinkText.slice(0, 1000) : "";
          emit({
            epoch: stepEpoch,
            kind: "thinking_start",
            summary:
              cleanHumanSummary(genTitle || thinkText, 120) || "Thinking…",
            ...(inlineBody ? { payload: { body: inlineBody } } : {}),
            ...(thinkText ? { fullBody: thinkText, inlineBody } : {}),
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

          if (isSubagentToolName(lowTool)) {
            const tsd = item.toolSpecificData;
            const subLabel = String(
              tsd?.subAgentName ??
                tsd?.agentName ??
                tsd?.agentType ??
                tsd?.description ??
                item.generatedTitle ??
                "Subagent",
            ).trim();
            const explicitSubId =
              (typeof tsd?.subAgentInvocationId === "string" &&
                tsd.subAgentInvocationId.trim() &&
                tsd.subAgentInvocationId.trim() !== "root" &&
                tsd.subAgentInvocationId.trim()) ||
              (typeof tsd?.agentId === "string" &&
                tsd.agentId.trim() &&
                tsd.agentId.trim() !== "root" &&
                tsd.agentId.trim()) ||
              (typeof tsd?.subagentId === "string" &&
                tsd.subagentId.trim() &&
                tsd.subagentId.trim() !== "root" &&
                tsd.subagentId.trim()) ||
              undefined;
            const baseSlug =
              subLabel
                .toLowerCase()
                .replace(/[^a-z0-9_-]+/g, "-")
                .replace(/^-+|-+$/g, "") || "subagent";
            let subId: string;
            if (explicitSubId) {
              subId = explicitSubId;
              usedSubagentSlugs.add(subId);
            } else {
              subId = baseSlug;
              let suffix = 2;
              while (usedSubagentSlugs.has(subId)) {
                subId = `${baseSlug}-${suffix++}`;
              }
              usedSubagentSlugs.add(subId);
            }
            const subModelRaw =
              typeof tsd?.model === "string" && tsd.model.trim()
                ? tsd.model.trim()
                : undefined;
            const subModel = subModelRaw
              ? prettifyModelName(subModelRaw) || subModelRaw
              : undefined;
            const rawSubPrompt =
              typeof tsd?.prompt === "string"
                ? tsd.prompt
                : typeof tsd?.instructions === "string"
                  ? tsd.instructions
                  : typeof tsd?.description === "string"
                    ? tsd.description
                    : extractMessageText(item.invocationMessage);
            const subPrompt = rawSubPrompt.trim();
            const inlinePrompt = subPrompt ? subPrompt.slice(0, 1000) : "";
            const compactSpecificData = tsd
              ? {
                  ...tsd,
                  ...(typeof tsd.prompt === "string"
                    ? { prompt: tsd.prompt.slice(0, 1000) }
                    : {}),
                  ...(typeof tsd.instructions === "string"
                    ? { instructions: tsd.instructions.slice(0, 1000) }
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
                agentLabel: subLabel,
                agentType: subLabel,
                _passiveSource: "chatSessions",
                ...(subModel
                  ? { childModel: subModel, childModelSource: "exact" }
                  : {}),
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
            const isMsgTool = isMessageToolName(lowTool);
            const cleanMsg =
              isBoardMut || isMsgTool
                ? summarizeToolCall(tname, specificArgs)
                : cleanHumanSummary(msg, 140) || summarizeToolCall(tname, specificArgs);
            if (isMsgTool) {
              const msgInfo = extractMessagePayload(specificArgs);
              emit({
                epoch: stepEpoch,
                kind: "message",
                toolName: tname,
                toolCallId: callId,
                ...(msgInfo.msgTarget ? { targetAgentId: msgInfo.msgTarget } : {}),
                summary: cleanMsg,
                isSelfDaemon: selfDaemon,
                payload: {
                  isConfirmed: item.isConfirmed,
                  toolSpecificData: item.toolSpecificData
                    ? msgInfo.compactArgs
                    : item.toolSpecificData,
                  ...(msgInfo.inlineBody ? { body: msgInfo.inlineBody } : {}),
                },
                ...(msgInfo.msgBody
                  ? { fullBody: msgInfo.msgBody, inlineBody: msgInfo.inlineBody }
                  : {}),
              });
            } else {
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
          const fileBase = extractUriBasename(item.uri);
          emit({
            epoch: stepEpoch,
            kind: "tool_start",
            toolName: "copilot_edit",
            toolCallId: callId,
            summary: fileBase ? `Edit ${fileBase}` : "Edit workspace files",
          });
          emit({
            epoch: stepEpoch + 0.002,
            kind: "tool_end",
            toolName: "copilot_edit",
            toolCallId: callId,
            summary: fileBase
              ? `Completed: Edit ${fileBase}`
              : "Applied file edits",
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
            : cleanHumanSummary(turnText, 140) || "Turn completed",
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
        : Math.round((acc.priorBoundedProseChars + acc.latestTurnChars) / 4);
      const usageDelta: UsageDelta = {
        model: acc.model,
        modelSource: acc.model ? "exact" : "unknown",
        usageSource: acc.hasExact ? "exact" : "estimated",
        inputTokens,
        outputTokens,
        cachedTokens,
        contextTokens,
        ...(acc.contextWindow !== undefined
          ? { contextWindow: acc.contextWindow }
          : {}),
        ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
        isTotal: true,
      };
      targetEv.usageDelta = usageDelta;
      targetEv.payload = { ...(targetEv.payload ?? {}), _usageDelta: usageDelta };
    }

    return events;
  }
}
