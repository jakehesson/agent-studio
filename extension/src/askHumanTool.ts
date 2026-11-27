import * as vscode from "vscode";
import type { DisposableLike, OutputChannelLike } from "./modelSync";
import type { HostIde } from "./scoping";

export const ASK_HUMAN_TOOL_NAME = "agent_studio_ask_human";
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_TIMEOUT_SECONDS = 1800;
export const DEFAULT_POLL_WAIT_MS = 20_000;
const CREATE_REQUEST_TIMEOUT_MS = 5_000;
const CANCEL_REQUEST_TIMEOUT_MS = 3_000;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;
const POLL_ERROR_BACKOFF_MS = 250;

export type AskHumanQuestionType = "single_select" | "multi_select" | "text";
export type AskHumanPromptKind = "question" | "approval";

export interface AskHumanQuestionOptionInput {
  id?: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface AskHumanQuestionInput {
  id?: string;
  header?: string;
  question: string;
  type: AskHumanQuestionType;
  options: AskHumanQuestionOptionInput[];
  allowCustomInput?: boolean;
  defaultValue?: string;
}

export interface AskHumanToolInput {
  title?: string;
  summary?: string;
  kind?: AskHumanPromptKind;
  questions: AskHumanQuestionInput[];
  agentId?: string;
  agentLabel?: string;
  sessionId?: string;
  timeoutSeconds?: number;
}

export interface AskHumanCreatePayload {
  promptSource: "studio-vscode-lm";
  toolName: typeof ASK_HUMAN_TOOL_NAME;
  ide: HostIde;
  workspacePath?: string;
  projectId?: string;
  sessionId?: string;
  title?: string;
  summary?: string;
  kind?: AskHumanPromptKind;
  questions: AskHumanQuestionInput[];
  agentId?: string;
  agentLabel?: string;
  timeoutMs: number;
}

export interface PromptBridgePromptRecord {
  id: string;
  status: "pending" | "answered" | "canceled" | "expired" | string;
  title?: string;
  summary?: string;
  answerText?: string;
  answers?: Record<string, unknown>;
  expiresAt?: string;
  cancelReason?: string;
  reason?: string;
}

export interface AskHumanServerTransport {
  ensureRunning(
    forceStart?: boolean,
  ): Promise<{ online: boolean; localBaseUrl: string }>;
  getLocalBaseUrl(): string;
  detectHostIde(): HostIde;
  getPrimaryWorkspaceRoot(): string | undefined;
  detectWorkspaceProjectId(): string | undefined;
}

export interface LanguageModelToolApiLike {
  registerTool?: <T>(
    name: string,
    tool: vscode.LanguageModelTool<T>,
  ) => vscode.Disposable;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AskHumanToolDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollWaitMs?: number;
}

export type BuildPayloadResult =
  | { ok: true; payload: AskHumanCreatePayload }
  | { ok: false; error: string };

export interface PollPromptResult {
  outcome: "answered" | "canceled" | "expired" | "error";
  prompt?: PromptBridgePromptRecord;
  httpStatus?: number;
  error?: string;
}

const VALID_QUESTION_TYPES = new Set<AskHumanQuestionType>([
  "single_select",
  "multi_select",
  "text",
]);

function trimOptionalString(value: unknown, maxLen?: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (maxLen !== undefined && trimmed.length > maxLen) {
    return trimmed.slice(0, maxLen);
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildAskHumanCreatePayload(
  rawInput: unknown,
  context: {
    ide: HostIde;
    workspacePath?: string;
    projectId?: string;
  },
): BuildPayloadResult {
  if (!isPlainObject(rawInput)) {
    return { ok: false, error: "Tool input must be a JSON object." };
  }

  if (rawInput.title !== undefined && typeof rawInput.title !== "string") {
    return { ok: false, error: "'title' must be a string when provided." };
  }
  if (rawInput.summary !== undefined && typeof rawInput.summary !== "string") {
    return { ok: false, error: "'summary' must be a string when provided." };
  }

  let kind: AskHumanPromptKind | undefined;
  if (rawInput.kind !== undefined) {
    if (rawInput.kind !== "question" && rawInput.kind !== "approval") {
      return {
        ok: false,
        error: "'kind' must be either 'question' or 'approval'.",
      };
    }
    kind = rawInput.kind;
  }

  if (!Array.isArray(rawInput.questions)) {
    return { ok: false, error: "'questions' must be an array of 1 to 10 items." };
  }
  if (rawInput.questions.length < 1 || rawInput.questions.length > 10) {
    return {
      ok: false,
      error: `'questions' must contain between 1 and 10 items (received ${rawInput.questions.length}).`,
    };
  }

  const questions: AskHumanQuestionInput[] = [];
  for (let i = 0; i < rawInput.questions.length; i += 1) {
    const rawQ = rawInput.questions[i];
    if (!isPlainObject(rawQ)) {
      return { ok: false, error: `questions[${i}] must be an object.` };
    }
    const questionText = trimOptionalString(rawQ.question);
    if (!questionText) {
      return {
        ok: false,
        error: `questions[${i}].question must be a non-empty string.`,
      };
    }
    if (
      typeof rawQ.type !== "string" ||
      !VALID_QUESTION_TYPES.has(rawQ.type as AskHumanQuestionType)
    ) {
      return {
        ok: false,
        error: `questions[${i}].type must be one of 'single_select', 'multi_select', or 'text'.`,
      };
    }
    if (!Array.isArray(rawQ.options)) {
      return {
        ok: false,
        error: `questions[${i}].options must be an array.`,
      };
    }

    const options: AskHumanQuestionOptionInput[] = [];
    for (let j = 0; j < rawQ.options.length; j += 1) {
      const rawOpt = rawQ.options[j];
      if (!isPlainObject(rawOpt)) {
        return {
          ok: false,
          error: `questions[${i}].options[${j}] must be an object.`,
        };
      }
      const label = trimOptionalString(rawOpt.label);
      if (!label) {
        return {
          ok: false,
          error: `questions[${i}].options[${j}].label must be a non-empty string.`,
        };
      }
      if (
        rawOpt.recommended !== undefined &&
        typeof rawOpt.recommended !== "boolean"
      ) {
        return {
          ok: false,
          error: `questions[${i}].options[${j}].recommended must be a boolean.`,
        };
      }
      const id = trimOptionalString(rawOpt.id);
      const description = trimOptionalString(rawOpt.description);
      options.push({
        ...(id ? { id } : {}),
        label,
        ...(description ? { description } : {}),
        ...(rawOpt.recommended !== undefined
          ? { recommended: rawOpt.recommended }
          : {}),
      });
    }

    if (
      rawQ.allowCustomInput !== undefined &&
      typeof rawQ.allowCustomInput !== "boolean"
    ) {
      return {
        ok: false,
        error: `questions[${i}].allowCustomInput must be a boolean.`,
      };
    }

    const qId = trimOptionalString(rawQ.id);
    const header = trimOptionalString(rawQ.header);
    const defaultValue = trimOptionalString(rawQ.defaultValue);
    questions.push({
      ...(qId ? { id: qId } : {}),
      ...(header ? { header } : {}),
      question: questionText,
      type: rawQ.type as AskHumanQuestionType,
      options,
      ...(rawQ.allowCustomInput !== undefined
        ? { allowCustomInput: rawQ.allowCustomInput }
        : {}),
      ...(defaultValue ? { defaultValue } : {}),
    });
  }

  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (rawInput.timeoutSeconds !== undefined) {
    if (
      typeof rawInput.timeoutSeconds !== "number" ||
      !Number.isFinite(rawInput.timeoutSeconds)
    ) {
      return {
        ok: false,
        error: "'timeoutSeconds' must be a finite number when provided.",
      };
    }
    timeoutSeconds = Math.min(
      MAX_TIMEOUT_SECONDS,
      Math.max(MIN_TIMEOUT_SECONDS, rawInput.timeoutSeconds),
    );
  }
  const timeoutMs = Math.round(timeoutSeconds * 1000);

  const title = trimOptionalString(rawInput.title, 140);
  const summary = trimOptionalString(rawInput.summary, 500);
  const agentId = trimOptionalString(rawInput.agentId);
  const agentLabel = trimOptionalString(rawInput.agentLabel);
  const sessionId = trimOptionalString(rawInput.sessionId);
  const workspacePath = trimOptionalString(context.workspacePath);
  const projectId = trimOptionalString(context.projectId);

  return {
    ok: true,
    payload: {
      promptSource: "studio-vscode-lm",
      toolName: ASK_HUMAN_TOOL_NAME,
      ide: context.ide,
      ...(workspacePath ? { workspacePath } : {}),
      ...(projectId ? { projectId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(kind ? { kind } : {}),
      questions,
      ...(agentId ? { agentId } : {}),
      ...(agentLabel ? { agentLabel } : {}),
      timeoutMs,
    },
  };
}

export function createTextToolResult(text: string): vscode.LanguageModelToolResult {
  const vscodeAny = vscode as unknown as {
    LanguageModelToolResult?: new (content: unknown[]) => vscode.LanguageModelToolResult;
    LanguageModelTextPart?: new (value: string) => vscode.LanguageModelTextPart;
  };
  if (
    typeof vscodeAny.LanguageModelToolResult === "function" &&
    typeof vscodeAny.LanguageModelTextPart === "function"
  ) {
    return new vscodeAny.LanguageModelToolResult([
      new vscodeAny.LanguageModelTextPart(text),
    ]);
  }
  return {
    content: [{ value: text }],
  } as unknown as vscode.LanguageModelToolResult;
}

export function formatAskHumanResultText(
  result:
    | {
        status: "answered";
        promptId: string;
        answerText: string;
        answers?: Record<string, unknown>;
      }
    | {
        status: "canceled";
        promptId?: string;
        reason?: string;
      }
    | {
        status: "expired";
        promptId?: string;
        reason?: string;
      }
    | {
        status: "offline";
        reason?: string;
      }
    | {
        status: "invalid_input";
        error: string;
      }
    | {
        status: "error";
        promptId?: string;
        httpStatus?: number;
        error: string;
      },
): string {
  switch (result.status) {
    case "answered": {
      const jsonBlock = JSON.stringify(
        {
          ok: true,
          status: "answered",
          promptId: result.promptId,
          answerText: result.answerText,
          answers: result.answers ?? {},
        },
        null,
        2,
      );
      return [
        `Human answered in Agent Studio Messages (promptId: ${result.promptId}).`,
        "",
        "Answer:",
        result.answerText || "(empty)",
        "",
        "```json",
        jsonBlock,
        "```",
      ].join("\n");
    }
    case "canceled": {
      const reason = result.reason?.trim() || "Canceled before a response was submitted.";
      const jsonBlock = JSON.stringify({
        ok: false,
        status: "canceled",
        ...(result.promptId ? { promptId: result.promptId } : {}),
        reason,
        fallbackRecommended: true,
        fallbackTool: "vscode_askQuestions",
      });
      return [
        `Human prompt was canceled${result.promptId ? ` (promptId: ${result.promptId})` : ""}: ${reason}`,
        "If you still need input, fall back to native `vscode_askQuestions` or ask the user directly in chat.",
        "",
        "```json",
        jsonBlock,
        "```",
      ].join("\n");
    }
    case "expired": {
      const reason = result.reason?.trim() || "Timed out waiting for a human response.";
      const jsonBlock = JSON.stringify({
        ok: false,
        status: "expired",
        ...(result.promptId ? { promptId: result.promptId } : {}),
        reason,
        fallbackRecommended: true,
        fallbackTool: "vscode_askQuestions",
      });
      return [
        `Human prompt expired in Agent Studio${result.promptId ? ` (promptId: ${result.promptId})` : ""}: ${reason}`,
        "You may retry `agent_studio_ask_human` or fall back to native `vscode_askQuestions`.",
        "",
        "```json",
        jsonBlock,
        "```",
      ].join("\n");
    }
    case "offline": {
      const reason =
        result.reason?.trim() ||
        "Agent Studio local server is offline or unreachable.";
      const jsonBlock = JSON.stringify({
        ok: false,
        status: "offline",
        reason,
        fallbackRecommended: true,
        fallbackTool: "vscode_askQuestions",
      });
      return [
        `${reason} Could not deliver the question to Agent Studio Messages UI.`,
        "Fall back to native `vscode_askQuestions` (or ask the user directly in chat).",
        "",
        "```json",
        jsonBlock,
        "```",
      ].join("\n");
    }
    case "invalid_input": {
      const jsonBlock = JSON.stringify({
        ok: false,
        status: "invalid_input",
        error: result.error,
      });
      return [
        `Invalid arguments for agent_studio_ask_human: ${result.error}`,
        "",
        "```json",
        jsonBlock,
        "```",
      ].join("\n");
    }
    case "error": {
      const jsonBlock = JSON.stringify({
        ok: false,
        status: "error",
        ...(result.promptId ? { promptId: result.promptId } : {}),
        ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
        error: result.error,
        fallbackRecommended: true,
        fallbackTool: "vscode_askQuestions",
      });
      return [
        `Agent Studio prompt request failed${result.httpStatus !== undefined ? ` (HTTP ${result.httpStatus})` : ""}: ${result.error}`,
        "Fall back to native `vscode_askQuestions` (or ask the user directly in chat).",
        "",
        "```json",
        jsonBlock,
        "```",
      ].join("\n");
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function extractPromptRecord(raw: unknown): PromptBridgePromptRecord | undefined {
  if (!isPlainObject(raw)) return undefined;
  const candidate = isPlainObject(raw.prompt) ? raw.prompt : raw;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return undefined;
  }
  return candidate as unknown as PromptBridgePromptRecord;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return res.statusText || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        return parsed.error.trim();
      }
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return parsed.message.trim();
      }
    } catch {
      // fall through to raw text
    }
    return text.slice(0, 300);
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

export async function postCancelPrompt(
  baseUrl: string,
  promptId: string,
  reason: string,
  fetchImpl: FetchLike = fetch,
  output?: OutputChannelLike,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CANCEL_REQUEST_TIMEOUT_MS);
  try {
    const cleanBase = baseUrl.replace(/\/+$/, "");
    await fetchImpl(
      `${cleanBase}/api/prompts/${encodeURIComponent(promptId)}/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
        signal: controller.signal,
      },
    );
  } catch (err) {
    output?.appendLine(
      `[ask-human] Best-effort cancel for prompt ${promptId} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function pollPromptUntilResolved(opts: {
  baseUrl: string;
  promptId: string;
  timeoutMs: number;
  token: vscode.CancellationToken;
  output?: OutputChannelLike;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollWaitMs?: number;
}): Promise<PollPromptResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const pollWaitMs = opts.pollWaitMs ?? DEFAULT_POLL_WAIT_MS;
  const cleanBase = opts.baseUrl.replace(/\/+$/, "");
  const deadlineMs = now() + opts.timeoutMs + 5_000;

  let cancelledByToken = opts.token.isCancellationRequested;
  let activePollController: AbortController | null = null;
  let cancelPostPromise: Promise<void> | null = null;

  const triggerCancel = () => {
    cancelledByToken = true;
    activePollController?.abort();
    if (!cancelPostPromise) {
      cancelPostPromise = postCancelPrompt(
        cleanBase,
        opts.promptId,
        "Cancelled by IDE/user",
        fetchImpl,
        opts.output,
      );
    }
  };

  const cancelListener = opts.token.onCancellationRequested(() => {
    triggerCancel();
  });

  try {
    if (opts.token.isCancellationRequested) {
      triggerCancel();
      await cancelPostPromise;
      return {
        outcome: "canceled",
        prompt: {
          id: opts.promptId,
          status: "canceled",
          cancelReason: "Cancelled by IDE/user",
        },
      };
    }

    let consecutiveErrors = 0;

    while (!cancelledByToken && !opts.token.isCancellationRequested) {
      const remainingMs = deadlineMs - now();
      if (remainingMs <= 0) {
        break;
      }

      const waitMs = Math.max(1_000, Math.min(pollWaitMs, remainingMs));
      const controller = new AbortController();
      activePollController = controller;
      const safetyTimer = setTimeout(
        () => controller.abort(),
        waitMs + 10_000,
      );

      try {
        const res = await fetchImpl(
          `${cleanBase}/api/prompts/${encodeURIComponent(opts.promptId)}?waitMs=${waitMs}`,
          {
            method: "GET",
            signal: controller.signal,
          },
        );

        if (cancelledByToken || opts.token.isCancellationRequested) {
          break;
        }

        if (res.status === 404) {
          return {
            outcome: "expired",
            httpStatus: 404,
            prompt: {
              id: opts.promptId,
              status: "expired",
              reason: "Prompt was no longer found on the Agent Studio server.",
            },
          };
        }

        if (!res.ok) {
          consecutiveErrors += 1;
          const errMsg = await readErrorMessage(res);
          if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
            return {
              outcome: "error",
              httpStatus: res.status,
              error: errMsg,
            };
          }
          await sleep(POLL_ERROR_BACKOFF_MS, controller.signal);
          continue;
        }

        consecutiveErrors = 0;
        const body = (await res.json()) as unknown;
        const prompt = extractPromptRecord(body);
        if (!prompt) {
          return {
            outcome: "error",
            error: "Malformed prompt status response from Agent Studio server.",
          };
        }

        if (prompt.status === "answered") {
          return { outcome: "answered", prompt };
        }
        if (prompt.status === "canceled") {
          return { outcome: "canceled", prompt };
        }
        if (prompt.status === "expired") {
          return { outcome: "expired", prompt };
        }
      } catch (err) {
        if (cancelledByToken || opts.token.isCancellationRequested) {
          break;
        }
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          return {
            outcome: "error",
            error: err instanceof Error ? err.message : String(err),
          };
        }
        await sleep(POLL_ERROR_BACKOFF_MS);
      } finally {
        clearTimeout(safetyTimer);
        if (activePollController === controller) {
          activePollController = null;
        }
      }
    }

    if (cancelledByToken || opts.token.isCancellationRequested) {
      if (!cancelPostPromise) {
        triggerCancel();
      }
      await cancelPostPromise;
      return {
        outcome: "canceled",
        prompt: {
          id: opts.promptId,
          status: "canceled",
          cancelReason: "Cancelled by IDE/user",
        },
      };
    }

    // Local deadline elapsed without server terminal state
    await postCancelPrompt(
      cleanBase,
      opts.promptId,
      "Timed out waiting for human response",
      fetchImpl,
      opts.output,
    );
    return {
      outcome: "expired",
      prompt: {
        id: opts.promptId,
        status: "expired",
        reason: "Timed out waiting for human response.",
      },
    };
  } finally {
    cancelListener.dispose();
  }
}

export function createAskHumanToolHandler(
  serverManager: AskHumanServerTransport,
  output: OutputChannelLike,
  deps: AskHumanToolDeps = {},
): vscode.LanguageModelTool<AskHumanToolInput> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    prepareInvocation(options) {
      const title = trimOptionalString(options?.input?.title, 140);
      // Intentionally omit `confirmationMessages` so VS Code does not show an intrusive confirmation modal.
      return {
        invocationMessage: title
          ? `Waiting for your answer in Agent Studio Messages: ${title}`
          : "Waiting for your answer in Agent Studio Messages…",
      };
    },

    async invoke(options, token) {
      const built = buildAskHumanCreatePayload(options?.input, {
        ide: serverManager.detectHostIde(),
        workspacePath: serverManager.getPrimaryWorkspaceRoot(),
        projectId: serverManager.detectWorkspaceProjectId(),
      });

      if (!built.ok) {
        return createTextToolResult(
          formatAskHumanResultText({
            status: "invalid_input",
            error: built.error,
          }),
        );
      }

      if (token.isCancellationRequested) {
        return createTextToolResult(
          formatAskHumanResultText({
            status: "canceled",
            reason: "Cancelled by IDE/user",
          }),
        );
      }

      let status: { online: boolean; localBaseUrl: string };
      try {
        status = await serverManager.ensureRunning(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[ask-human] ensureRunning failed: ${msg}`);
        return createTextToolResult(
          formatAskHumanResultText({
            status: "offline",
            reason: msg,
          }),
        );
      }

      if (!status.online) {
        output.appendLine(
          "[ask-human] Agent Studio server is offline; advising fallback to native vscode_askQuestions.",
        );
        return createTextToolResult(
          formatAskHumanResultText({
            status: "offline",
          }),
        );
      }

      if (token.isCancellationRequested) {
        return createTextToolResult(
          formatAskHumanResultText({
            status: "canceled",
            reason: "Cancelled by IDE/user",
          }),
        );
      }

      const baseUrl = (
        status.localBaseUrl || serverManager.getLocalBaseUrl()
      ).replace(/\/+$/, "");

      const createController = new AbortController();
      const createTimer = setTimeout(
        () => createController.abort(),
        CREATE_REQUEST_TIMEOUT_MS,
      );
      const createCancelListener = token.onCancellationRequested(() => {
        createController.abort();
      });

      let createdPrompt: PromptBridgePromptRecord | undefined;
      try {
        const res = await fetchImpl(`${baseUrl}/api/prompts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(built.payload),
          signal: createController.signal,
        });

        if (!res.ok) {
          const errMsg = await readErrorMessage(res);
          output.appendLine(
            `[ask-human] POST /api/prompts failed (HTTP ${res.status}): ${errMsg}`,
          );
          return createTextToolResult(
            formatAskHumanResultText({
              status: "error",
              httpStatus: res.status,
              error: errMsg,
            }),
          );
        }

        const body = (await res.json()) as unknown;
        createdPrompt = extractPromptRecord(body);
        if (!createdPrompt) {
          return createTextToolResult(
            formatAskHumanResultText({
              status: "error",
              error: "Server did not return a valid prompt ID.",
            }),
          );
        }
      } catch (err) {
        if (token.isCancellationRequested) {
          return createTextToolResult(
            formatAskHumanResultText({
              status: "canceled",
              reason: "Cancelled by IDE/user",
            }),
          );
        }
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[ask-human] POST /api/prompts threw: ${msg}`);
        return createTextToolResult(
          formatAskHumanResultText({
            status: "offline",
            reason: `Failed to reach Agent Studio server (${msg}).`,
          }),
        );
      } finally {
        clearTimeout(createTimer);
        createCancelListener.dispose();
      }

      if (createdPrompt.status === "answered") {
        return createTextToolResult(
          formatAskHumanResultText({
            status: "answered",
            promptId: createdPrompt.id,
            answerText: createdPrompt.answerText ?? "",
            answers: createdPrompt.answers,
          }),
        );
      }
      if (createdPrompt.status === "canceled") {
        return createTextToolResult(
          formatAskHumanResultText({
            status: "canceled",
            promptId: createdPrompt.id,
            reason: createdPrompt.cancelReason ?? createdPrompt.reason,
          }),
        );
      }
      if (createdPrompt.status === "expired") {
        return createTextToolResult(
          formatAskHumanResultText({
            status: "expired",
            promptId: createdPrompt.id,
            reason: createdPrompt.reason,
          }),
        );
      }

      const pollResult = await pollPromptUntilResolved({
        baseUrl,
        promptId: createdPrompt.id,
        timeoutMs: built.payload.timeoutMs,
        token,
        output,
        fetchImpl,
        now: deps.now,
        sleep: deps.sleep,
        pollWaitMs: deps.pollWaitMs,
      });

      if (pollResult.outcome === "answered" && pollResult.prompt) {
        return createTextToolResult(
          formatAskHumanResultText({
            status: "answered",
            promptId: pollResult.prompt.id,
            answerText: pollResult.prompt.answerText ?? "",
            answers: pollResult.prompt.answers,
          }),
        );
      }

      if (pollResult.outcome === "canceled") {
        return createTextToolResult(
          formatAskHumanResultText({
            status: "canceled",
            promptId: pollResult.prompt?.id ?? createdPrompt.id,
            reason: pollResult.prompt?.cancelReason ?? pollResult.prompt?.reason,
          }),
        );
      }

      if (pollResult.outcome === "expired") {
        return createTextToolResult(
          formatAskHumanResultText({
            status: "expired",
            promptId: pollResult.prompt?.id ?? createdPrompt.id,
            reason: pollResult.prompt?.reason,
          }),
        );
      }

      return createTextToolResult(
        formatAskHumanResultText({
          status: "error",
          promptId: createdPrompt.id,
          httpStatus: pollResult.httpStatus,
          error: pollResult.error ?? "Unknown error while waiting for response.",
        }),
      );
    },
  };
}

export function isLanguageModelToolApiSupported(
  lm: LanguageModelToolApiLike | undefined | null,
): lm is LanguageModelToolApiLike & {
  registerTool: NonNullable<LanguageModelToolApiLike["registerTool"]>;
} {
  return Boolean(lm && typeof lm.registerTool === "function");
}

function createNoopDisposable(): vscode.Disposable {
  const vscodeAny = vscode as unknown as {
    Disposable?: new (callOnDispose: () => void) => vscode.Disposable;
  };
  if (typeof vscodeAny.Disposable === "function") {
    return new vscodeAny.Disposable(() => undefined);
  }
  return { dispose: () => undefined } as unknown as vscode.Disposable;
}

/**
 * Safely registers `agent_studio_ask_human` via `vscode.lm.registerTool` when available,
 * returning a clean no-op disposable on Antigravity or older VS Code hosts.
 */
export function registerAskHumanTool(
  serverManager: AskHumanServerTransport,
  output: OutputChannelLike,
  lmApi?: LanguageModelToolApiLike | null,
  deps: AskHumanToolDeps = {},
): DisposableLike {
  const resolvedLm =
    arguments.length >= 3
      ? lmApi
      : (vscode as unknown as { lm?: LanguageModelToolApiLike }).lm;

  if (!isLanguageModelToolApiSupported(resolvedLm)) {
    output.appendLine(
      `[ask-human] Host IDE (${serverManager.detectHostIde()}) does not expose vscode.lm.registerTool; skipping ${ASK_HUMAN_TOOL_NAME} registration.`,
    );
    return createNoopDisposable();
  }

  try {
    const handler = createAskHumanToolHandler(serverManager, output, deps);
    const disposable = resolvedLm.registerTool(ASK_HUMAN_TOOL_NAME, handler);
    output.appendLine(
      `[ask-human] Registered language model tool '${ASK_HUMAN_TOOL_NAME}'.`,
    );
    return disposable;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(
      `[ask-human] Skipping ${ASK_HUMAN_TOOL_NAME} registration: ${msg}`,
    );
    return createNoopDisposable();
  }
}
