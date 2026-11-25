import fs from "node:fs";
import path from "node:path";
import { parseTeamYaml, type TeamManifest } from "../../schema/team.js";
import type { EventKind, IdeSource } from "../../schema/telemetry.js";
import {
  cleanHumanSummary,
  computeDeterministicEventId,
  computeMergeKey,
  isBoardMutationToolCall,
  normalizeWsPath,
  prettifyModelName,
  toIsoUtc,
  type EnrichedEvent,
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
}

const EDIT_OR_WRITE_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "edit_file",
  "write_file",
  "edit/editfiles",
  "edit/createfile",
  "copilot_applypatch",
  "copilot_createfile",
  "replace_file_content",
  "multi_replace_file_content",
]);

const SHELL_TOOLS = new Set([
  "bash",
  "run_command",
  "run_in_terminal",
  "execute/runinterminal",
]);

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

function readStdinWithCap(timeoutMs = 250): Promise<string> {
  if (process.stdin.isTTY) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_BYTES = 256 * 1024;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onEnd);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    const onData = (buf: Buffer | string): void => {
      const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
      if (totalBytes + b.length <= MAX_BYTES) {
        chunks.push(b);
        totalBytes += b.length;
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

function mapHookEventToKind(hookEvent: string, isSubagent = false): EventKind {
  switch (hookEvent.toLowerCase()) {
    case "sessionstart":
      return "session_start";
    case "userpromptsubmit":
      return isSubagent ? "thinking_start" : "user_input";
    case "pretooluse":
      return "tool_start";
    case "posttooluse":
    case "posttoolusefailure":
      return "tool_end";
    case "subagentstart":
      return "subagent_spawn";
    case "subagentstop":
      return "subagent_done";
    case "precompact":
      return "message";
    case "stop":
      return "assistant_turn_end";
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

function extractHookUsageDelta(
  payload: Record<string, unknown>,
  model?: string,
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
    "cache_read_tokens",
  );
  const cacheCreate = numField(
    src,
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_creation_tokens",
  );
  const cachedTokens =
    cacheRead !== undefined || cacheCreate !== undefined
      ? Math.max(0, Math.round((cacheRead ?? 0) + (cacheCreate ?? 0)))
      : undefined;
  const contextTokens = numField(src, "context_tokens", "contextTokens");
  const costUsd = numField(src, "cost_usd", "costUsd", "total_cost_usd", "totalCostUSD");

  const prettyModel = model ? prettifyModelName(model) || model : undefined;
  const hasTokens =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    cachedTokens !== undefined ||
    contextTokens !== undefined;

  if (!prettyModel && !hasTokens && costUsd === undefined) {
    return undefined;
  }

  return {
    ...(prettyModel ? { model: prettyModel, modelSource: "exact" as const } : {}),
    ...(hasTokens ? { usageSource: "exact" as const } : {}),
    ...(inputTokens !== undefined ? { inputTokens: Math.max(0, Math.round(inputTokens)) } : {}),
    ...(outputTokens !== undefined ? { outputTokens: Math.max(0, Math.round(outputTokens)) } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(contextTokens !== undefined ? { contextTokens: Math.max(0, Math.round(contextTokens)) } : {}),
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

function targetsBoardFile(
  toolName: string,
  toolInput: Record<string, unknown>,
  boardRelPath: string,
): boolean {
  const lowTool = toolName.toLowerCase();
  const normBoard = boardRelPath.replace(/\\/g, "/").toLowerCase();
  const boardBase = path.basename(normBoard);

  if (EDIT_OR_WRITE_TOOLS.has(lowTool)) {
    const filePath = (
      strField(toolInput, "file_path", "filePath", "path", "Path", "target") ??
      ""
    )
      .replace(/\\/g, "/")
      .toLowerCase();
    if (!filePath) return false;
    return filePath.endsWith(normBoard) || filePath.endsWith("/" + boardBase) || filePath === boardBase;
  }

  if (SHELL_TOOLS.has(lowTool)) {
    const cmd = (
      strField(toolInput, "command", "CommandLine", "cmd") ?? ""
    )
      .replace(/\\/g, "/")
      .toLowerCase();
    if (!cmd) return false;
    const mentionsBoard = cmd.includes(normBoard) || cmd.includes("pipeline/board.json");
    const looksLikeWrite =
      cmd.includes(">") ||
      cmd.includes("set-content") ||
      cmd.includes("out-file") ||
      cmd.includes("write_text") ||
      cmd.includes("sed -i") ||
      cmd.includes("tee ");
    return mentionsBoard && looksLikeWrite;
  }

  return false;
}

function evaluatePreToolUseGuardrail(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  role?: string;
  manifest: TeamManifest | null;
}): string | null {
  const blockDirectBoardEdits =
    params.manifest?.workflow.enforcement.blockDirectBoardEdits ?? true;
  const orchestratorReadOnly =
    params.manifest?.workflow.enforcement.orchestratorReadOnly ?? true;
  const boardPath =
    params.manifest?.workflow.boardPath ?? "pipeline/board.json";

  if (
    blockDirectBoardEdits &&
    targetsBoardFile(params.toolName, params.toolInput, boardPath)
  ) {
    return `Direct edits to ${boardPath} are blocked by Agent Studio. Use the agent-studio MCP \`board\` tool instead.`;
  }

  if (
    orchestratorReadOnly &&
    params.role?.toLowerCase() === "orchestrator"
  ) {
    const lowTool = params.toolName.toLowerCase();
    if (EDIT_OR_WRITE_TOOLS.has(lowTool) || SHELL_TOOLS.has(lowTool)) {
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

  const rawStdin =
    io?.stdinText !== undefined ? io.stdinText : await readStdinWithCap();

  let payload: Record<string, unknown> = {};
  if (rawStdin.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawStdin);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed stdin must never crash the IDE hook.
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

  const hookEvent =
    flags.event ??
    strField(payload, "hook_event_name", "hookEventName", "event") ??
    "PreToolUse";
  const hookLow = hookEvent.toLowerCase();

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

  const subagentId = strField(
    payload,
    "agent_id",
    "agentId",
    "subagent_id",
    "subagentId",
  );
  const subagentType = strField(
    payload,
    "agent_type",
    "agentType",
    "agent_name",
    "agentName",
  );
  const parentAgentId = strField(payload, "parent_agent_id", "parentAgentId");
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

  const isSubagentLifecycle =
    hookLow === "subagentstart" || hookLow === "subagentstop";
  const isToolHook =
    hookLow === "pretooluse" ||
    hookLow === "posttooluse" ||
    hookLow === "posttoolusefailure";

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

  const role =
    flags.role ??
    strField(payload, "agent_role", "agentRole", "role", "agent_type", "agentName");

  const isSubagentContext = Boolean(subagentId && subagentId !== "root");
  const epoch = Date.now() / 1000;
  let kind = mapHookEventToKind(hookEvent, isSubagentContext);
  const lowTool = (toolName ?? "").toLowerCase();
  if (hookLow === "pretooluse" && toolName) {
    if ((lowTool === "agent" || lowTool === "task") && targetAgentId) {
      kind = "subagent_spawn";
    } else if (lowTool === "sendmessage") {
      kind = "message";
    } else if (lowTool === "askuserquestion") {
      kind = "user_input";
    } else if (isBoardMutationToolCall(toolName, toolInput)) {
      kind = "board_mutation";
    }
  } else if (
    (hookLow === "posttooluse" || hookLow === "posttoolusefailure") &&
    (lowTool === "agent" || lowTool === "task") &&
    targetAgentId
  ) {
    kind = "subagent_done";
  }

  // Evaluate PreToolUse guardrails before delivering telemetry
  let denyReason: string | null = null;
  if (hookLow === "pretooluse" && toolName) {
    denyReason = evaluatePreToolUseGuardrail({
      toolName,
      toolInput,
      role,
      manifest,
    });
  }

  const promptText =
    strField(payload, "prompt", "user_prompt", "userPrompt") ??
    (typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : payload.message &&
          typeof payload.message === "object" &&
          !Array.isArray(payload.message)
        ? strField(payload.message as Record<string, unknown>, "text", "content")
        : undefined);

  let status: EnrichedEvent["status"] = "ok";
  let isError = false;
  if (hookLow === "pretooluse") {
    if (denyReason) {
      status = "denied";
      isError = true;
    } else {
      status = "running";
      isError = false;
    }
  } else if (hookLow === "posttoolusefailure") {
    status = "error";
    isError = true;
  } else if (hookLow === "posttooluse") {
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

  const readableActor = agentLabel || (agentId === "root" ? "Coordinator" : agentId);
  const summary = denyReason
    ? `DENIED ${toolName ?? "tool"}: ${denyReason}`
    : isSubagentLifecycle
      ? `${hookLow === "subagentstart" ? "Spawned" : "Completed"} ${subagentType || normalizedSubagentId}`
      : hookLow === "userpromptsubmit"
        ? isSubagentContext
          ? (promptText ? cleanHumanSummary(promptText, 130) : "") || "Starting task…"
          : promptText
            ? `Human: ${cleanHumanSummary(promptText, 130)}`
            : `${hookEvent} (${readableActor})`
        : toolName
          ? `${hookEvent}: ${toolName}`
          : `${hookEvent} (${readableActor})`;

  const usageDelta = extractHookUsageDelta(payload, modelRaw);

  const eventPayload: Record<string, unknown> = {
    hookEvent,
    toolInput,
    ...(toolArgsRaw !== undefined ? { toolArgs: toolArgsRaw } : {}),
    ...(toolResultRaw !== undefined ? { toolResult: toolResultRaw } : {}),
    ...(subagentId !== undefined ? { agentId: subagentId } : {}),
    ...(subagentType !== undefined
      ? { agentType: subagentType, agentLabel: subagentType }
      : {}),
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(agentTranscriptPath !== undefined ? { agentTranscriptPath } : {}),
    ...(modelRaw !== undefined ? { model: modelRaw } : {}),
    ...(promptText !== undefined
      ? { prompt: promptText, body: promptText }
      : {}),
    ...(isError ? { isError: true } : {}),
    ...(denyReason ? { denyReason } : {}),
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
    ...(usageDelta ? { usageDelta } : {}),
    payload: eventPayload,
  };
  void isToolHook;

  const port = flags.port ?? process.env.AGENT_STUDIO_PORT ?? "8767";
  const ingestUrl = `http://127.0.0.1:${port}/api/ingest`;
  let deliveredVia: "http" | "file" | "none" = "none";

  try {
    const resp = await fetchFn(ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(150),
    });
    if (resp.ok) {
      deliveredVia = "http";
    } else if (appendTelemetryFallback(cwd, event)) {
      deliveredVia = "file";
    }
  } catch {
    if (appendTelemetryFallback(cwd, event)) {
      deliveredVia = "file";
    }
  }

  if (denyReason) {
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

  return { exitCode: 0, denied: false, deliveredVia, event };
}
