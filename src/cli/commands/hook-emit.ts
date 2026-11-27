import fs from "node:fs";
import path from "node:path";
import { parseTeamYaml, type TeamManifest } from "../../schema/team.js";
import type { EventKind, IdeSource } from "../../schema/telemetry.js";
import {
  buildContextAdvisoryMessage,
  DEFAULT_CONTEXT_THRESHOLDS,
  type ContextAdvisory,
} from "../../telemetry/push-bus.js";
import {
  cleanHumanSummary,
  computeDeterministicEventId,
  computeMergeKey,
  inferContextWindow,
  isBoardMutationToolCall,
  isOpaqueAgentId,
  normalizeCopilotUsage,
  normalizePendingQuestions,
  normalizeWsPath,
  prettifyModelName,
  summarizeToolCall,
  toIsoUtc,
  unquoteArg,
  type EnrichedEvent,
  type PendingQuestionItem,
  type UsageDelta,
} from "../../telemetry/types.js";

export interface HookEmitIo {
  stdinText?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  fetchImpl?: typeof fetch;
}

export interface HookEmitResult {
  exitCode: number;
  denied: boolean;
  deliveredVia: "http" | "file" | "none";
  event?: EnrichedEvent;
  advisory?: ContextAdvisory;
}

const EDIT_OR_WRITE_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "edit_file",
  "write_file",
  "apply_patch",
  "create",
  "str_replace",
  "edit/editfiles",
  "edit/createfile",
  "copilot_applypatch",
  "copilot_createfile",
  "copilot_replacestring",
  "copilot_multireplacestring",
  "replace_file_content",
  "multi_replace_file_content",
]);

function isEditOrWriteToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  const low = toolName.toLowerCase();
  if (low === "str_replace_editor") {
    const cmd = strField(toolInput, "command", "Command")?.toLowerCase();
    return cmd !== "view";
  }
  return EDIT_OR_WRITE_TOOLS.has(low);
}

const SHELL_TOOLS = new Set([
  "bash",
  "powershell",
  "run_command",
  "run_in_terminal",
  "execute/runinterminal",
  "execute",
  "shell",
  "terminal",
]);

const MAX_STDIN_BYTES = 256 * 1024;

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!tok || !tok.startsWith("--")) continue;
    const raw = tok.slice(2);
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      out[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[raw] = next;
        i++;
      } else {
        out[raw] = "true";
      }
    }
  }
  return out;
}

function readStdinWithCap(
  timeoutMs = 250,
): Promise<{ text: string; truncated: boolean }> {
  if (process.stdin.isTTY) {
    return Promise.resolve({ text: "", truncated: false });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onEnd);
      process.stdin.pause();
      resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated });
    };

    const onData = (buf: Buffer | string): void => {
      const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
      if (totalBytes + b.length <= MAX_STDIN_BYTES) {
        chunks.push(b);
        totalBytes += b.length;
      } else {
        truncated = true;
      }
    };
    const onEnd = (): void => finish();

    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onEnd);
    process.stdin.resume();
  });
}

function loadTeamManifestBestEffort(cwd: string): TeamManifest | null {
  try {
    const p = path.join(cwd, ".agent-team", "team.yaml");
    if (!fs.existsSync(p)) return null;
    return parseTeamYaml(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const HOOK_EVENT_CANONICAL_MAP: Readonly<Record<string, string>> = {
  sessionstart: "sessionStart",
  sessionend: "sessionEnd",
  userpromptsubmitted: "userPromptSubmitted",
  userpromptsubmit: "userPromptSubmitted",
  userprompttransformed: "userPromptTransformed",
  pretooluse: "preToolUse",
  posttooluse: "postToolUse",
  posttoolusefailure: "postToolUseFailure",
  precompact: "preCompact",
  subagentstart: "subagentStart",
  subagentstop: "subagentStop",
  agentstop: "agentStop",
  stop: "agentStop",
  permissionrequest: "permissionRequest",
  notification: "notification",
  erroroccurred: "errorOccurred",
};

const NEW_COPILOT_ADVISORY_EVENTS = new Set([
  "sessionStart",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "notification",
]);

export function normalizeHookEventName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "preToolUse";
  return HOOK_EVENT_CANONICAL_MAP[trimmed.toLowerCase()] ?? trimmed;
}

function mapHookEventToKind(hookCanon: string, isSubagent = false): EventKind {
  switch (hookCanon) {
    case "sessionStart":
      return "session_start";
    case "userPromptSubmitted":
      return isSubagent ? "thinking_start" : "user_input";
    case "userPromptTransformed":
      return "thinking_start";
    case "preToolUse":
      return "tool_start";
    case "postToolUse":
    case "postToolUseFailure":
      return "tool_end";
    case "subagentStart":
      return "subagent_spawn";
    case "subagentStop":
      return "subagent_done";
    case "agentStop":
    case "sessionEnd":
      return "assistant_turn_end";
    case "preCompact":
    case "permissionRequest":
    case "notification":
    case "errorOccurred":
      return "message";
    default:
      return "message";
  }
}

function slug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function numField(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function anyField(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

function firstNonOpaqueField(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") {
      const t = v.trim();
      if (t && !isOpaqueAgentId(t) && t.toLowerCase() !== "subagent") {
        return t;
      }
    }
  }
  return undefined;
}

function extractHookUsageDelta(
  payload: Record<string, unknown>,
  model?: string,
  ide?: IdeSource,
): UsageDelta | undefined {
  const usageObj = objField(payload, "usage", "token_usage", "tokenUsage");
  const src = Object.keys(usageObj).length > 0 ? usageObj : payload;

  const inputTokens = numField(
    src,
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
  );
  const outputTokens = numField(
    src,
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
  );
  const cacheRead = numField(
    src,
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cached_tokens",
    "cachedTokens",
    "cached_prompt_tokens",
    "cachedPromptTokens",
    "cacheReadTokens",
    "cache_read_tokens",
  );
  const cacheCreate = numField(
    src,
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cacheWriteTokens",
    "cache_write_tokens",
    "cache_creation_tokens",
  );
  const cachedTokens =
    cacheRead !== undefined || cacheCreate !== undefined
      ? Math.max(0, Math.round((cacheRead ?? 0) + (cacheCreate ?? 0)))
      : undefined;
  const contextTokens = numField(
    src,
    "context_tokens",
    "contextTokens",
    "currentTokens",
    "current_tokens",
  );
  const rawContextWindow =
    numField(
      src,
      "contextWindow",
      "context_window",
      "maxInputTokens",
      "max_input_tokens",
      "tokenLimit",
      "token_limit",
    ) ??
    numField(
      payload,
      "contextWindow",
      "context_window",
      "maxInputTokens",
      "max_input_tokens",
      "tokenLimit",
      "token_limit",
    );
  const contextWindow =
    rawContextWindow !== undefined && rawContextWindow > 0
      ? Math.round(rawContextWindow)
      : undefined;
  const costUsd = numField(src, "cost_usd", "costUsd", "total_cost_usd", "totalCostUSD");

  const prettyModel = model ? prettifyModelName(model) || model : undefined;
  const hasTokens =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    cachedTokens !== undefined ||
    contextTokens !== undefined;

  if (!prettyModel && !hasTokens && costUsd === undefined && contextWindow === undefined) {
    return undefined;
  }

  if (ide === "copilot-vscode" && hasTokens) {
    const norm = normalizeCopilotUsage({
      inTok: inputTokens,
      outTok: outputTokens,
      cachedTok: cachedTokens,
      contextTok: contextTokens,
    });
    return {
      ...(prettyModel ? { model: prettyModel, modelSource: "exact" as const } : {}),
      usageSource: "exact" as const,
      ...(inputTokens !== undefined ? { inputTokens: norm.freshIn } : {}),
      ...(outputTokens !== undefined ? { outputTokens: norm.outTok } : {}),
      ...(cachedTokens !== undefined ? { cachedTokens: norm.cachedTok } : {}),
      ...(norm.turnContext !== undefined ? { contextTokens: norm.turnContext } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(costUsd !== undefined && costUsd >= 0 ? { costUsd } : {}),
    };
  }

  return {
    ...(prettyModel ? { model: prettyModel, modelSource: "exact" as const } : {}),
    ...(hasTokens ? { usageSource: "exact" as const } : {}),
    ...(inputTokens !== undefined ? { inputTokens: Math.max(0, Math.round(inputTokens)) } : {}),
    ...(outputTokens !== undefined ? { outputTokens: Math.max(0, Math.round(outputTokens)) } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(contextTokens !== undefined ? { contextTokens: Math.max(0, Math.round(contextTokens)) } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(costUsd !== undefined && costUsd >= 0 ? { costUsd } : {}),
  };
}

function strField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function objField(
  obj: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  for (const k of keys) {
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return {};
}

const PATH_FIELD_KEY_SET = new Set([
  "file_path",
  "filepath",
  "path",
  "target",
  "target_file",
  "targetfile",
  "uri",
  "file",
  "destination",
  "dest",
  "new_path",
  "newpath",
  "old_path",
  "oldpath",
]);

const NESTED_ARRAY_KEY_SET = new Set([
  "edits",
  "files",
  "changes",
  "operations",
  "patches",
  "items",
]);

const PATCH_TEXT_KEY_SET = new Set([
  "patch",
  "input",
  "diff",
  "rawpatch",
  "raw_patch",
]);

function stripFileUri(raw: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      if (u.protocol === "file:") {
        let p = decodeURIComponent(u.pathname);
        if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(p)) {
          p = p.slice(1);
        }
        return p;
      }
    } catch {
      // fall through
    }
  }
  return trimmed;
}

function normalizeForBoardCompare(p: string): string {
  return path.normalize(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function matchesBoardPath(
  rawCandidate: string,
  boardRelPath: string,
  cwd: string,
): boolean {
  const cleaned = stripFileUri(rawCandidate);
  if (!cleaned) return false;
  const resolvedBoard = normalizeForBoardCompare(path.resolve(cwd, boardRelPath));
  const resolvedCandidate = normalizeForBoardCompare(path.resolve(cwd, cleaned));
  if (resolvedCandidate === resolvedBoard) {
    return true;
  }
  const normRelBoard = boardRelPath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  const normPosixCand = path.posix
    .normalize(cleaned.replace(/\\/g, "/"))
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return normPosixCand === normRelBoard;
}

function extractPathsFromPatchText(patchText: string): string[] {
  const out: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const codexMatch = /^\s*\*{3}\s*(?:Update File|Add File|Delete File|Move to)\s*:\s*(.+)$/i.exec(
      line,
    );
    if (codexMatch?.[1]) {
      const p = codexMatch[1].trim();
      if (p) out.push(p);
      continue;
    }
    const diffMatch = /^\s*(?:\+\+\+|---)\s+(.+)$/.exec(line);
    if (diffMatch?.[1]) {
      const raw = diffMatch[1].split("\t")[0]!.trim().replace(/^["']|["']$/g, "");
      if (!raw || raw === "/dev/null") continue;
      out.push(raw);
      if (/^[ab]\//i.test(raw)) {
        out.push(raw.slice(2));
      }
    }
  }
  return out;
}

function collectCandidatePathsFromInput(
  obj: Record<string, unknown>,
  lowTool: string,
  depth = 0,
): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    const lowKey = key.toLowerCase();
    if (PATH_FIELD_KEY_SET.has(lowKey)) {
      if (typeof val === "string" && val.trim()) {
        out.push(val.trim());
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string" && item.trim()) {
            out.push(item.trim());
          } else if (item && typeof item === "object" && !Array.isArray(item)) {
            out.push(
              ...collectCandidatePathsFromInput(
                item as Record<string, unknown>,
                lowTool,
                depth + 1,
              ),
            );
          }
        }
      } else if (val && typeof val === "object") {
        const uriRec = val as Record<string, unknown>;
        const uriPath = strField(uriRec, "fsPath", "path", "external");
        if (uriPath) out.push(uriPath);
      }
    } else if (NESTED_ARRAY_KEY_SET.has(lowKey) && Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && item.trim()) {
          out.push(item.trim());
        } else if (item && typeof item === "object" && !Array.isArray(item)) {
          out.push(
            ...collectCandidatePathsFromInput(
              item as Record<string, unknown>,
              lowTool,
              depth + 1,
            ),
          );
        }
      }
    }

    if (
      (PATCH_TEXT_KEY_SET.has(lowKey) ||
        ((lowTool === "apply_patch" || lowTool === "copilot_applypatch") &&
          (lowKey === "content" || lowKey === "text"))) &&
      typeof val === "string" &&
      val.trim()
    ) {
      out.push(...extractPathsFromPatchText(val));
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeShellBoardWrite(rawCmd: string, boardRelPath: string): boolean {
  const cmdNorm = rawCmd.replace(/\\/g, "/").toLowerCase();
  const normBoard = boardRelPath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
  const boardBase = path.posix.basename(normBoard);
  const boardBaseRe = new RegExp(
    `(?:^|[\\s/"'\`=,(])${escapeRegExp(boardBase)}(?:$|[\\s"'\`,);&|])`,
    "i",
  );
  const mentionsBoard =
    cmdNorm.includes(normBoard) ||
    cmdNorm.includes("pipeline/board.json") ||
    boardBaseRe.test(cmdNorm);
  if (!mentionsBoard) return false;

  const cmdNoDevNull = cmdNorm
    .replace(/\b\d*>&\d+\b/g, " ")
    .replace(/\b\d*>\s*(?:\/dev\/null|nul)\b/g, " ");
  const hasRedirect = /(?:^|[^=-])>{1,2}/.test(cmdNoDevNull);
  const hasScriptRuntime =
    /\b(?:node|nodejs|tsx|ts-node)\s+(?:--eval|-e)\b/.test(cmdNorm) ||
    /\bpython[23]?\s+-c\b/.test(cmdNorm) ||
    /\bruby\s+-e\b/.test(cmdNorm) ||
    /\bperl\s+-[a-z]*e\b/.test(cmdNorm) ||
    /\b(?:pwsh|powershell)\s+(?:-[a-z]*c|-command|-encodedcommand|-enc)\b/.test(
      cmdNorm,
    );
  const hasFileOp =
    /\b(?:cp|mv|rm|tee|truncate|install|touch)\b/.test(cmdNorm) ||
    /\bsed\s+(?:-[a-z]*i|--in-place)\b/.test(cmdNorm) ||
    /\bdd\b.*\bof=/.test(cmdNorm) ||
    /\b(?:write_text|writefilesync|writefile)\b/.test(cmdNorm);
  const hasPowerShellWrite =
    /\b(?:set-content|out-file|add-content|remove-item|move-item|copy-item|rename-item|clear-content|new-item)\b/.test(
      cmdNorm,
    );

  return hasRedirect || hasScriptRuntime || hasFileOp || hasPowerShellWrite;
}

function targetsBoardFile(
  toolName: string,
  toolInput: Record<string, unknown>,
  boardRelPath: string,
  cwd: string,
): boolean {
  const lowTool = toolName.toLowerCase();

  if (isEditOrWriteToolCall(toolName, toolInput)) {
    const candidates = collectCandidatePathsFromInput(toolInput, lowTool);
    return candidates.some((cand) => matchesBoardPath(cand, boardRelPath, cwd));
  }

  if (SHELL_TOOLS.has(lowTool)) {
    const cmd = strField(
      toolInput,
      "command",
      "Command",
      "CommandLine",
      "commandLine",
      "cmd",
      "script",
      "Script",
    );
    if (!cmd) return false;
    return looksLikeShellBoardWrite(cmd, boardRelPath);
  }

  return false;
}

function isOrchestratorRole(
  roleCandidates: ReadonlyArray<string>,
  manifest: TeamManifest | null,
): boolean {
  const orchestratorKeys = new Set<string>(["orchestrator"]);
  if (manifest?.roster) {
    for (const entry of manifest.roster) {
      if (entry.roleType === "orchestrator") {
        if (entry.id.trim()) orchestratorKeys.add(entry.id.trim().toLowerCase());
        if (entry.name.trim()) orchestratorKeys.add(entry.name.trim().toLowerCase());
        if (entry.boardRole.trim()) {
          orchestratorKeys.add(entry.boardRole.trim().toLowerCase());
        }
      }
    }
  }
  for (const cand of roleCandidates) {
    const norm = cand.trim().toLowerCase();
    if (norm && orchestratorKeys.has(norm)) {
      return true;
    }
  }
  return false;
}

function evaluatePreToolUseGuardrail(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  roleCandidates: ReadonlyArray<string>;
  manifest: TeamManifest | null;
  cwd: string;
}): string | null {
  const blockDirectBoardEdits =
    params.manifest?.workflow.enforcement.blockDirectBoardEdits ?? true;
  const orchestratorReadOnly =
    params.manifest?.workflow.enforcement.orchestratorReadOnly ?? true;
  const boardPath =
    params.manifest?.workflow.boardPath ?? "pipeline/board.json";

  if (
    blockDirectBoardEdits &&
    targetsBoardFile(params.toolName, params.toolInput, boardPath, params.cwd)
  ) {
    return `Direct edits to ${boardPath} are blocked by Agent Studio. Use the agent-studio MCP \`board\` tool instead.`;
  }

  if (
    orchestratorReadOnly &&
    isOrchestratorRole(params.roleCandidates, params.manifest)
  ) {
    const lowTool = params.toolName.toLowerCase();
    if (isEditOrWriteToolCall(params.toolName, params.toolInput) || SHELL_TOOLS.has(lowTool)) {
      return `Orchestrator is read-only (orchestratorReadOnly=true). Tool "${params.toolName}" is denied; delegate edits and shell commands to a specialist subagent.`;
    }
  }

  return null;
}

function appendTelemetryFallback(workspaceRoot: string, event: EnrichedEvent): boolean {
  try {
    const filePath = path.join(workspaceRoot, ".agent-studio", "telemetry.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(event) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function runHookEmit(
  args: string[],
  io?: HookEmitIo,
): Promise<HookEmitResult> {
  const flags = parseFlags(args);
  const writeStdout = io?.stdout ?? ((s: string) => process.stdout.write(s));
  const writeStderr = io?.stderr ?? ((s: string) => process.stderr.write(s));
  const fetchFn = io?.fetchImpl ?? fetch;

  let rawStdin = "";
  let stdinTruncated = false;
  if (io?.stdinText !== undefined) {
    const rawBuf = Buffer.from(io.stdinText, "utf8");
    if (rawBuf.length > MAX_STDIN_BYTES) {
      stdinTruncated = true;
      rawStdin = rawBuf.subarray(0, MAX_STDIN_BYTES).toString("utf8");
    } else {
      rawStdin = io.stdinText;
    }
  } else {
    const capRes = await readStdinWithCap();
    rawStdin = capRes.text;
    stdinTruncated = capRes.truncated;
  }

  let payload: Record<string, unknown> = {};
  let malformedJson = false;
  if (rawStdin.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawStdin);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      } else {
        malformedJson = true;
      }
    } catch {
      // Malformed stdin must never crash the IDE hook; preToolUse fails closed below.
      malformedJson = true;
    }
  }

  const ideRaw =
    flags.ide ?? strField(payload, "ide") ?? "unknown";
  const ide: IdeSource =
    ideRaw === "antigravity" ||
    ideRaw === "claude-code" ||
    ideRaw === "copilot-vscode" ||
    ideRaw === "mcp"
      ? ideRaw
      : "unknown";

  const rawHookEvent =
    flags.event ??
    strField(payload, "hook_event_name", "hookEventName", "event", "hookEvent") ??
    "PreToolUse";
  const hookCanon = normalizeHookEventName(rawHookEvent);
  const hookEvent = rawHookEvent;
  const isNewCopilotFormat =
    ide === "copilot-vscode" && /^[a-z]/.test(rawHookEvent.trim());

  const cwd = path.resolve(
    flags.cwd ?? strField(payload, "cwd", "workspacePath") ?? process.cwd(),
  );
  const manifest = loadTeamManifestBestEffort(cwd);

  const sessionId =
    strField(payload, "session_id", "sessionId") ?? `hook-${path.basename(cwd)}`;
  const toolName = strField(payload, "tool_name", "toolName");
  const toolCallId = strField(payload, "tool_use_id", "toolCallId", "tool_call_id");
  const toolArgsRaw = anyField(
    payload,
    "tool_args",
    "toolArgs",
    "tool_input",
    "toolInput",
  );
  let toolInput = objField(payload, "tool_input", "toolInput", "tool_args", "toolArgs");
  if (Object.keys(toolInput).length === 0 && typeof toolArgsRaw === "string") {
    try {
      const parsedArgs: unknown = JSON.parse(toolArgsRaw);
      if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
        toolInput = parsedArgs as Record<string, unknown>;
      }
    } catch {
      // ignore non-JSON toolArgs string
    }
  }
  const toolResultRaw = anyField(
    payload,
    "tool_response",
    "tool_result",
    "toolResponse",
    "toolResult",
  );

  const isSubagentLifecycle =
    hookCanon === "subagentStart" || hookCanon === "subagentStop";
  const subagentType = firstNonOpaqueField(
    payload,
    "agent_display_name",
    "agentDisplayName",
    "agent_type",
    "agentType",
    "agent_name",
    "agentName",
    "subagent_type",
    "subagentType",
    "subagent_name",
    "subagentName",
    "subAgentName",
    "subAgentType",
    "agent_label",
    "agentLabel",
    "agent_role",
    "agentRole",
    "role",
    ...(isSubagentLifecycle ? ["name"] : []),
  );
  const rawAgentName = firstNonOpaqueField(
    payload,
    "agent_name",
    "agentName",
    "name",
  );
  const rawSubagentId = strField(
    payload,
    "agent_id",
    "agentId",
    "subagent_id",
    "subagentId",
  );
  const rawParentAgentId = strField(payload, "parent_agent_id", "parentAgentId");
  // Guard against IDE hooks (e.g. VS Code Copilot) echoing the root sessionId as agent_id
  // or parent_agent_id. Preserve Claude Code orphan subagent hooks that carry agent_type.
  const isRootUuidEcho =
    rawSubagentId !== undefined &&
    rawSubagentId === sessionId &&
    (ide !== "claude-code" || !subagentType);
  const subagentId = isRootUuidEcho ? undefined : rawSubagentId;
  const parentAgentId =
    rawParentAgentId && rawParentAgentId !== sessionId
      ? rawParentAgentId
      : undefined;
  const parentSessionId = strField(
    payload,
    "parent_session_id",
    "parentSessionId",
  );
  const transcriptPath = strField(payload, "transcript_path", "transcriptPath");
  const agentTranscriptPath = strField(
    payload,
    "agent_transcript_path",
    "agentTranscriptPath",
  );
  const modelRaw = strField(payload, "model", "model_id", "modelId");

  const typeSlug = subagentType ? slug(subagentType) : undefined;
  const normalizedSubagentId =
    ide === "claude-code"
      ? subagentId && subagentId !== "root"
        ? subagentId.startsWith("agent-")
          ? subagentId
          : `agent-${subagentId}`
        : typeSlug || "subagent"
      : subagentId && subagentId !== "root"
        ? subagentId
        : typeSlug || "subagent";

  const isToolHook =
    hookCanon === "preToolUse" ||
    hookCanon === "postToolUse" ||
    hookCanon === "postToolUseFailure";

  let agentId: string;
  let targetAgentId: string | undefined;
  let resolvedParentAgentId: string | undefined;
  let agentLabel: string | undefined;

  if (isSubagentLifecycle) {
    agentId = parentAgentId || "root";
    targetAgentId = normalizedSubagentId;
    resolvedParentAgentId = parentAgentId ? "root" : undefined;
  } else if (subagentId && subagentId !== "root") {
    agentId = normalizedSubagentId;
    resolvedParentAgentId = parentAgentId || "root";
    agentLabel = subagentType;
  } else {
    agentId = flags.role ?? "root";
  }

  const roleCandidates: string[] = [];
  if (flags.role?.trim()) {
    roleCandidates.push(flags.role.trim());
  } else {
    for (const k of [
      "agent_role",
      "agentRole",
      "role",
      "agentName",
      "agent_name",
      "agentType",
      "agent_type",
      "agentDisplayName",
      "agent_display_name",
      "customAgent",
      "custom_agent",
    ]) {
      const v = payload[k];
      if (typeof v === "string" && v.trim()) {
        roleCandidates.push(v.trim());
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        const rec = v as Record<string, unknown>;
        const nested = strField(rec, "id", "name", "role", "displayName");
        if (nested) roleCandidates.push(nested);
      }
    }
  }

  const isSubagentContext = Boolean(subagentId && subagentId !== "root");
  const epoch = Date.now() / 1000;
  let kind = mapHookEventToKind(hookCanon, isSubagentContext);
  const lowTool = (toolName ?? "").toLowerCase();
  const isMessageTool =
    lowTool === "sendmessage" ||
    lowTool === "send_message" ||
    lowTool === "write_agent" ||
    lowTool === "read_agent";
  const QUESTION_TOOLS = new Set([
    "askuserquestion",
    "ask_question",
    "ask_user",
    "vscode_askquestions",
    "ask_questions",
    "askquestions",
  ]);
  const isQuestionTool = QUESTION_TOOLS.has(lowTool);
  const isBlockedNotifyUser =
    lowTool === "notify_user" &&
    (toolInput.BlockedOnUser === true ||
      unquoteArg(toolInput.BlockedOnUser).toLowerCase() === "true");

  let waitingReason: EnrichedEvent["waitingReason"];
  let parsedQuestions: PendingQuestionItem[] = [];

  if (hookCanon === "preToolUse" && toolName) {
    if ((lowTool === "agent" || lowTool === "task") && targetAgentId) {
      kind = "subagent_spawn";
    } else if (isMessageTool) {
      kind = "message";
      if (!targetAgentId) {
        const msgTarget = strField(
          toolInput,
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
        );
        if (msgTarget && msgTarget !== sessionId && msgTarget !== agentId) {
          targetAgentId = msgTarget;
        }
      }
    } else if (isQuestionTool || isBlockedNotifyUser) {
      kind = "tool_start";
      waitingReason = "user";
      if (!targetAgentId) {
        targetAgentId = "human";
      }
      if (isBlockedNotifyUser) {
        const msg = unquoteArg(toolInput.Message ?? toolInput.message).trim();
        if (msg) {
          parsedQuestions = [
            {
              question: msg,
              type: "text",
              options: [],
              allowCustomInput: true,
            },
          ];
        }
      } else {
        parsedQuestions = normalizePendingQuestions(toolInput, {
          defaultAllowCustomInput: true,
        });
      }
    } else if (isBoardMutationToolCall(toolName, toolInput)) {
      kind = "board_mutation";
    }
  } else if (
    (hookCanon === "postToolUse" || hookCanon === "postToolUseFailure") &&
    (lowTool === "agent" || lowTool === "task") &&
    targetAgentId
  ) {
    kind = "subagent_done";
  } else if (hookCanon === "permissionRequest") {
    waitingReason = "tool_approval";
    if (!targetAgentId) {
      targetAgentId = "human";
    }
  } else if (hookCanon === "notification") {
    if (!targetAgentId) {
      targetAgentId = "human";
    }
  }

  const port = flags.port ?? process.env.AGENT_STUDIO_PORT ?? "8767";

  // Evaluate PreToolUse guardrails before delivering telemetry
  let denyReason: string | null = null;
  if (hookCanon === "preToolUse") {
    if (stdinTruncated || malformedJson) {
      denyReason =
        "PreToolUse payload exceeded 256KB limit or was malformed JSON; failing closed.";
    } else if (toolName) {
      denyReason = evaluatePreToolUseGuardrail({
        toolName,
        toolInput,
        roleCandidates,
        manifest,
        cwd,
      });
      if (
        !denyReason &&
        lowTool === "vscode_askquestions" &&
        manifest?.workflow?.humanQuestions !== "native-ide" &&
        process.env.AGENT_STUDIO_DISABLE_ASK_REDIRECT !== "1"
      ) {
        try {
          const healthUrl = `http://127.0.0.1:${port}/api/health?workspace=${encodeURIComponent(cwd)}`;
          const healthRes = await fetchFn(healthUrl, {
            method: "GET",
            signal: AbortSignal.timeout(150),
          });
          if (healthRes.ok) {
            const healthData = (await healthRes.json()) as {
              hasActiveUi?: boolean;
            };
            if (healthData && healthData.hasActiveUi === true) {
              denyReason =
                "Agent Studio UI is active for this workspace. Use agent_studio_ask_human (or ask_human) instead of vscode_askquestions so the user can reply directly in Agent Studio Messages UI.";
            }
          }
        } catch {
          // Fail open when Agent Studio server is offline or probe times out.
        }
      }
    }
  }

  const promptText =
    strField(
      payload,
      "prompt",
      "user_prompt",
      "userPrompt",
      "transformedPrompt",
      "transformed_prompt",
      "transformedContent",
    ) ??
    (typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : payload.message &&
          typeof payload.message === "object" &&
          !Array.isArray(payload.message)
        ? strField(payload.message as Record<string, unknown>, "text", "content")
        : undefined);

  const isStopLifecycle =
    hookCanon === "subagentStop" || hookCanon === "agentStop";
  const stopResponseText = isStopLifecycle
    ? strField(
        payload,
        "response",
        "last_assistant_message",
        "lastAssistantMessage",
      ) ??
      (payload.response &&
      typeof payload.response === "object" &&
      !Array.isArray(payload.response)
        ? strField(
            payload.response as Record<string, unknown>,
            "text",
            "content",
            "message",
          )
        : undefined)
    : undefined;

  const errorText =
    hookCanon === "errorOccurred"
      ? (typeof payload.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : payload.error &&
              typeof payload.error === "object" &&
              !Array.isArray(payload.error)
            ? strField(
                payload.error as Record<string, unknown>,
                "message",
                "error",
                "reason",
              )
            : strField(payload, "errorMessage", "error_message", "reason")) ??
        promptText
      : undefined;

  let status: EnrichedEvent["status"] = "ok";
  let isError = false;
  if (hookCanon === "preToolUse") {
    if (denyReason) {
      status = "denied";
      isError = true;
    } else {
      status = "running";
      isError = false;
    }
  } else if (
    hookCanon === "postToolUseFailure" ||
    hookCanon === "errorOccurred"
  ) {
    status = "error";
    isError = true;
  } else if (hookCanon === "postToolUse") {
    const respObj =
      toolResultRaw &&
      typeof toolResultRaw === "object" &&
      !Array.isArray(toolResultRaw)
        ? (toolResultRaw as Record<string, unknown>)
        : undefined;
    const toolIsError =
      respObj?.is_error === true ||
      respObj?.isError === true ||
      payload.is_error === true ||
      payload.isError === true;
    status = toolIsError ? "error" : "ok";
    isError = toolIsError;
  }

  const readableActor =
    agentLabel ||
    (agentId === "root"
      ? "Coordinator"
      : isOpaqueAgentId(agentId)
        ? "Subagent"
        : agentId);
  const readableTarget =
    subagentType ||
    (isOpaqueAgentId(normalizedSubagentId) ? "Subagent" : normalizedSubagentId);
  const toolSummary = toolName ? summarizeToolCall(toolName, toolInput) : undefined;
  const notifTitle =
    hookCanon === "notification"
      ? promptText ?? strField(payload, "title", "body", "notification")
      : undefined;
  const summary = denyReason
    ? `DENIED ${toolName ?? "tool"}: ${denyReason}`
    : isSubagentLifecycle
      ? `${hookCanon === "subagentStart" ? "Spawned" : "Completed"} ${readableTarget}`
      : hookCanon === "userPromptSubmitted"
        ? isSubagentContext
          ? (promptText ? cleanHumanSummary(promptText, 130) : "") || "Starting task…"
          : promptText
            ? `Human: ${cleanHumanSummary(promptText, 130)}`
            : `${hookEvent} (${readableActor})`
        : hookCanon === "userPromptTransformed"
          ? (promptText ? cleanHumanSummary(promptText, 130) : "") || "Prompt transformed"
          : hookCanon === "errorOccurred"
            ? errorText
              ? cleanHumanSummary(`Error: ${errorText}`, 140)
              : `Error (${readableActor})`
            : hookCanon === "permissionRequest"
              ? toolSummary
                ? `Approve: ${toolSummary}`
                : promptText
                  ? cleanHumanSummary(promptText, 140)
                  : `Permission requested (${readableActor})`
              : hookCanon === "notification"
                ? notifTitle
                  ? cleanHumanSummary(notifTitle, 140)
                  : `${hookEvent} (${readableActor})`
                : toolSummary
                  ? hookCanon === "postToolUse" || hookCanon === "postToolUseFailure"
                    ? cleanHumanSummary(
                        isError ? `Failed: ${toolSummary}` : `Completed: ${toolSummary}`,
                        140,
                      )
                    : toolSummary
                  : hookCanon === "preCompact"
                    ? `PreCompact (${readableActor})`
                    : `${hookEvent} (${readableActor})`;

  const usageDelta = extractHookUsageDelta(payload, modelRaw, ide);
  const toolMsgBody = isMessageTool
    ? strField(toolInput, "message", "content", "body", "text")
    : undefined;
  const fullBodyText =
    promptText ??
    stopResponseText ??
    (errorText ? `Error: ${errorText}` : undefined) ??
    notifTitle ??
    toolMsgBody;

  const eventPayload: Record<string, unknown> = {
    hookEvent,
    toolInput,
    ...(hookCanon === "preCompact" ? { isPreCompact: true } : {}),
    ...(toolArgsRaw !== undefined ? { toolArgs: toolArgsRaw } : {}),
    ...(toolResultRaw !== undefined ? { toolResult: toolResultRaw } : {}),
    ...(subagentId !== undefined ? { agentId: subagentId } : {}),
    ...(subagentType !== undefined
      ? { agentType: subagentType, agentLabel: subagentType }
      : {}),
    ...(rawAgentName && rawAgentName !== subagentType
      ? { agentName: rawAgentName }
      : {}),
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(agentTranscriptPath !== undefined ? { agentTranscriptPath } : {}),
    ...(modelRaw !== undefined ? { model: modelRaw } : {}),
    ...(promptText !== undefined
      ? { prompt: promptText, body: promptText }
      : fullBodyText !== undefined
        ? { body: fullBodyText }
        : {}),
    ...(isError ? { isError: true } : {}),
    ...(denyReason ? { denyReason } : {}),
    ...(hookCanon === "permissionRequest"
      ? {
          promptKind: "approval",
          promptTitle: toolSummary ? `Approve: ${toolSummary}` : summary,
          blockingToolCall: true,
        }
      : {}),
    ...(isBlockedNotifyUser ? { blockingToolCall: false } : {}),
    ...(parsedQuestions.length > 0
      ? {
          questions: parsedQuestions,
          promptKind: "question",
          blockingToolCall: !isBlockedNotifyUser,
        }
      : {}),
    ...(usageDelta ? { _usageDelta: usageDelta } : {}),
  };

  const event: EnrichedEvent = {
    id: computeDeterministicEventId({
      ide,
      sessionId,
      agentId,
      kind,
      toolCallId,
      toolName,
      targetAgentId,
      epoch,
      summary,
    }),
    mergeKey: computeMergeKey({
      sessionId,
      agentId,
      kind,
      toolCallId,
      toolName,
      epoch,
    }),
    ts: toIsoUtc(epoch),
    epoch,
    ide,
    channel: "hook",
    sessionId,
    workspacePath: normalizeWsPath(cwd),
    projectId: manifest?.project.id,
    agentId,
    ...(agentLabel ? { agentLabel } : {}),
    ...(resolvedParentAgentId ? { parentAgentId: resolvedParentAgentId } : {}),
    kind,
    toolName,
    toolCallId,
    ...(targetAgentId ? { targetAgentId } : {}),
    summary,
    status,
    isError,
    ...(fullBodyText !== undefined ? { bodyLength: fullBodyText.length } : {}),
    ...(waitingReason && !denyReason ? { waitingReason } : {}),
    ...(usageDelta ? { usageDelta } : {}),
    payload: eventPayload,
  };
  void isToolHook;

  const ingestUrl = `http://127.0.0.1:${port}/api/ingest`;
  let deliveredVia: "http" | "file" | "none" = "none";
  let serverAdvisory: ContextAdvisory | undefined;

  try {
    const resp = await fetchFn(ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(150),
    });
    if (resp.ok) {
      deliveredVia = "http";
      try {
        const respData = (await resp.json()) as { advisory?: ContextAdvisory };
        if (
          respData &&
          typeof respData.advisory === "object" &&
          respData.advisory !== null &&
          typeof respData.advisory.message === "string"
        ) {
          serverAdvisory = respData.advisory;
        }
      } catch {
        // Ignore non-JSON ingest responses.
      }
    } else if (appendTelemetryFallback(cwd, event)) {
      deliveredVia = "file";
    }
  } catch {
    if (appendTelemetryFallback(cwd, event)) {
      deliveredVia = "file";
    }
  }

  if (denyReason) {
    if (isNewCopilotFormat) {
      const denyPayload = {
        permissionDecision: "deny",
        permissionDecisionReason: denyReason,
      };
      writeStdout(JSON.stringify(denyPayload) + "\n");
      writeStderr(`[agent-studio guardrail] ${denyReason}\n`);
      return { exitCode: 0, denied: true, deliveredVia, event };
    }
    const denyPayload = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denyReason,
      },
    };
    writeStdout(JSON.stringify(denyPayload) + "\n");
    writeStderr(`[agent-studio guardrail] ${denyReason}\n`);
    const exitCode = ide === "claude-code" ? 0 : 2;
    return { exitCode, denied: true, deliveredVia, event };
  }

  let advisory: ContextAdvisory | undefined = serverAdvisory;
  if (!advisory && deliveredVia !== "http") {
    const isPreCompact = hookCanon === "preCompact";
    const ctxTokens =
      usageDelta?.contextTokens ??
      (usageDelta && typeof usageDelta.inputTokens === "number"
        ? usageDelta.inputTokens +
          (usageDelta.cachedTokens ?? 0) +
          (usageDelta.outputTokens ?? 0)
        : undefined);
    if (isPreCompact || (typeof ctxTokens === "number" && ctxTokens > 0)) {
      const resolvedModel = usageDelta?.model ?? modelRaw ?? "unknown";
      const ctxWindow =
        usageDelta?.contextWindow ?? inferContextWindow(resolvedModel, ide);
      const thresholds = manifest?.workflow.contextThresholds;
      const handoffPercent =
        thresholds?.handoffPercent ?? DEFAULT_CONTEXT_THRESHOLDS.handoffPercent;
      const compactPercent =
        thresholds?.compactPercent ?? DEFAULT_CONTEXT_THRESHOLDS.compactPercent;
      const safeTokens = typeof ctxTokens === "number" ? ctxTokens : 0;
      const ctxPercent =
        ctxWindow > 0
          ? Math.min(100, Math.round((safeTokens / ctxWindow) * 1000) / 10)
          : 0;
      const band =
        isPreCompact || ctxPercent >= compactPercent
          ? "compact"
          : ctxPercent >= handoffPercent
            ? "handoff"
            : null;
      if (band) {
        advisory = {
          band,
          sessionId,
          agentId,
          contextTokens: safeTokens,
          contextWindow: ctxWindow,
          contextPercent: ctxPercent,
          ...(resolvedModel !== "unknown" ? { model: resolvedModel } : {}),
          ...(isPreCompact ? { isPreCompact: true } : {}),
          message: buildContextAdvisoryMessage({
            band,
            contextPercent: ctxPercent,
            contextWindow: ctxWindow,
            handoffPercent,
            isPreCompact,
          }),
        };
      }
    }
  }

  if (isNewCopilotFormat) {
    if (advisory && NEW_COPILOT_ADVISORY_EVENTS.has(hookCanon)) {
      writeStdout(JSON.stringify({ additionalContext: advisory.message }) + "\n");
    }
  } else {
    const advisoryHookEventName =
      hookCanon === "preToolUse"
        ? "PreToolUse"
        : hookCanon === "postToolUse"
          ? "PostToolUse"
          : hookCanon === "userPromptSubmitted"
            ? "UserPromptSubmit"
            : hookCanon === "preCompact"
              ? "PreCompact"
              : null;

    if (advisory && advisoryHookEventName) {
      writeStdout(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: advisoryHookEventName,
            additionalContext: advisory.message,
          },
        }) + "\n",
      );
    }
  }

  return {
    exitCode: 0,
    denied: false,
    deliveredVia,
    event,
    ...(advisory ? { advisory } : {}),
  };
}
