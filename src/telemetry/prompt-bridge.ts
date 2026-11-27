import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { resolveProject } from "../board/registry.js";
import {
  createDeterministicEventId,
  type IdeSource,
  type PendingHumanPrompt,
  type PendingQuestionItem,
  type PromptBridgeAnswerInput,
  type PromptBridgeCreateInput,
  type PromptStatus,
} from "../schema/telemetry.js";
import {
  getKnownProjects,
  matchProjectIdForWorkspaces,
  normalizeComparePath,
  pathMatchesRoot,
} from "./adapters/project-match.js";
import type { EventBodyStore } from "./body-store.js";
import type { PushBus } from "./push-bus.js";
import {
  cleanHumanSummary,
  normalizeWsPath,
  prettifyAgentLabel,
  toIsoUtc,
  type DiscoveredSession,
} from "./types.js";

export const MAX_ACTIVE_PROMPTS = 64;
export const MAX_TERMINAL_PROMPTS = 200;
export const DEFAULT_PROMPT_TTL_MS = 600_000;
export const TERMINAL_RETENTION_MS = 120_000;
export const PROMPT_SWEEP_INTERVAL_MS = 15_000;
export const ACTIVE_SESSION_ATTRIBUTION_WINDOW_MS = 15 * 60 * 1000;
export const MAX_PROMPT_WAIT_MS = 30_000;
const INLINE_BODY_MAX_CHARS = 1400;

export interface PromptBridgeRecord {
  id: string;
  status: PromptStatus;
  promptSource: "studio-mcp" | "studio-vscode-lm";
  directReply: true;
  kind: "question" | "approval";
  title: string;
  summary?: string;
  questions: PendingQuestionItem[];
  options?: Array<{ label: string; recommended?: boolean }>;
  agentId: string;
  agentLabel: string;
  sessionId: string;
  autoAttributed: boolean;
  workspacePath?: string;
  projectId?: string;
  ide: IdeSource;
  toolName?: string;
  toolCallId: string;
  createdAtMs: number;
  ts: string;
  expiresAtMs: number;
  expiresAt: string;
  resolvedAtMs?: number;
  resolvedAt?: string;
  answerText?: string;
  answers?: Record<string, string | string[]>;
  responder?: string;
  cancelReason?: string;
  blockingToolCall: false;
}

export interface PromptBridgeFilter {
  sessionId?: string;
  ide?: string;
  project?: string;
  workspace?: string;
}

export type CreatePromptResult =
  | { ok: true; prompt: PendingHumanPrompt; record: PromptBridgeRecord }
  | { ok: false; statusCode: 429 | 503; error: string };

export type ResolvePromptResult =
  | { ok: true; prompt: PendingHumanPrompt; record: PromptBridgeRecord }
  | { ok: false; notFound: true; conflict?: false }
  | {
      ok: false;
      notFound?: false;
      conflict: true;
      status: PromptStatus;
      prompt: PendingHumanPrompt;
    };

export interface PromptBridgeOptions {
  pushBus: PushBus;
  bodyStore?: EventBodyStore;
  findActiveSession?: (criteria: {
    ide?: IdeSource;
    workspacePath?: string;
    projectId?: string;
    sessionId?: string;
  }) => Promise<DiscoveredSession | null>;
}

function normProjKey(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toPendingHumanPrompt(record: PromptBridgeRecord): PendingHumanPrompt {
  return {
    id: record.id,
    toolCallId: record.toolCallId,
    ...(record.toolName ? { toolName: record.toolName } : {}),
    agentId: record.agentId,
    agentLabel: record.agentLabel,
    kind: record.kind,
    title: record.title,
    ...(record.summary ? { summary: record.summary } : {}),
    questions: record.questions,
    ...(record.options ? { options: record.options } : {}),
    ts: record.ts,
    blockingToolCall: false,
    directReply: true,
    promptSource: record.promptSource,
    status: record.status,
    ...(record.answerText !== undefined ? { answerText: record.answerText } : {}),
    ...(record.answers !== undefined ? { answers: record.answers } : {}),
    expiresAt: record.expiresAt,
    sessionId: record.sessionId,
    ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
    ide: record.ide,
  };
}

function normalizeCreateQuestions(
  rawQuestions: PromptBridgeCreateInput["questions"],
): PendingQuestionItem[] {
  return rawQuestions.map((q) => {
    const options = Array.isArray(q.options) ? q.options : [];
    const type: PendingQuestionItem["type"] =
      options.length === 0 || q.type === "text"
        ? "text"
        : q.type === "multi_select"
          ? "multi_select"
          : "single_select";
    return {
      ...(q.id ? { id: q.id } : {}),
      ...(q.header?.trim() ? { header: q.header.trim() } : {}),
      question: q.question.trim(),
      type,
      options,
      allowCustomInput: q.allowCustomInput ?? true,
      ...(q.defaultValue !== undefined ? { defaultValue: q.defaultValue } : {}),
    };
  });
}

function inferProjectId(
  explicitProjectId: string | undefined,
  workspacePath: string | undefined,
): string | undefined {
  if (explicitProjectId?.trim()) {
    return explicitProjectId.trim();
  }
  if (!workspacePath) return undefined;
  try {
    return resolveProject(undefined, workspacePath).id;
  } catch {
    return matchProjectIdForWorkspaces([workspacePath]);
  }
}

export function promptMatchesProjectFilter(
  prompt: { projectId?: string; workspacePath?: string },
  projectFilter: string,
): boolean {
  const trimmed = projectFilter.trim();
  if (!trimmed || trimmed.toLowerCase() === "all") return true;
  const aliases = new Set<string>();
  const roots: string[] = [];
  const addAlias = (v: string | undefined): void => {
    if (!v) return;
    const k = normProjKey(v);
    if (k) aliases.add(k);
  };
  const addRoot = (r: string | undefined): void => {
    if (!r) return;
    const norm = normalizeComparePath(r);
    if (norm && !roots.includes(norm)) roots.push(norm);
    addAlias(path.basename(r));
  };
  addAlias(trimmed);
  try {
    const resolved = resolveProject(trimmed);
    addAlias(resolved.id);
    addAlias(resolved.title);
    addRoot(resolved.root);
  } catch {
    // Unknown project ID; check known projects below.
  }
  const targetNorm = normProjKey(trimmed);
  for (const kp of getKnownProjects()) {
    const kpAliases = [
      normProjKey(kp.id),
      normProjKey(kp.title),
      normProjKey(path.basename(kp.root)),
    ];
    if (kpAliases.includes(targetNorm)) {
      addAlias(kp.id);
      addAlias(kp.title);
      addRoot(kp.root);
    }
  }
  const pidNorm = normProjKey(prompt.projectId ?? "");
  if (pidNorm && aliases.has(pidNorm)) return true;
  if (
    prompt.workspacePath &&
    roots.some((root) => pathMatchesRoot(prompt.workspacePath!, root))
  ) {
    return true;
  }
  return false;
}

export class PromptBridge extends EventEmitter {
  private readonly records = new Map<string, PromptBridgeRecord>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly pushBus: PushBus;
  private readonly bodyStore?: EventBodyStore;
  private readonly findActiveSession?: PromptBridgeOptions["findActiveSession"];
  private sweepTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private pendingCreates = 0;

  constructor(options: PromptBridgeOptions) {
    super();
    this.pushBus = options.pushBus;
    this.bodyStore = options.bodyStore;
    this.findActiveSession = options.findActiveSession;
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, PROMPT_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const [id, set] of this.waiters.entries()) {
      for (const wake of [...set]) {
        wake();
      }
      this.waiters.delete(id);
    }
  }

  private notifyWaiters(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    for (const wake of [...set]) {
      wake();
    }
  }

  private ingestTerminalToolEnd(
    record: PromptBridgeRecord,
    targetStatus: "canceled" | "expired",
    reason?: string,
  ): void {
    const nowMs = record.resolvedAtMs ?? Date.now();
    const epoch = nowMs / 1000;
    this.pushBus.ingest([
      {
        id: createDeterministicEventId(["pb", targetStatus, record.id]),
        ts: toIsoUtc(epoch),
        epoch,
        ide: record.ide,
        channel: "mcp",
        sessionId: record.sessionId,
        ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
        ...(record.projectId ? { projectId: record.projectId } : {}),
        agentId: record.agentId,
        agentLabel: record.agentLabel,
        kind: "tool_end",
        toolName: record.toolName,
        toolCallId: record.toolCallId,
        summary:
          targetStatus === "expired"
            ? `Expired: ${record.title}`
            : `Canceled: ${reason?.trim() || record.title}`,
        status: "error",
        isError: true,
        payload: {
          promptId: record.id,
          directReply: true,
          promptSource: record.promptSource,
          promptStatus: targetStatus,
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
          isError: true,
        },
      },
    ]);
  }

  private expireRecordIfNeeded(record: PromptBridgeRecord, nowMs: number): boolean {
    if (record.status !== "pending" || nowMs < record.expiresAtMs) {
      return false;
    }
    record.status = "expired";
    record.resolvedAtMs = nowMs;
    record.resolvedAt = toIsoUtc(nowMs / 1000);
    this.ingestTerminalToolEnd(record, "expired", "Prompt timed out");
    this.notifyWaiters(record.id);
    this.emit("change", {
      type: "expired",
      prompt: toPendingHumanPrompt(record),
    });
    return true;
  }

  sweep(nowMs = Date.now()): void {
    const terminal: PromptBridgeRecord[] = [];
    for (const record of this.records.values()) {
      this.expireRecordIfNeeded(record, nowMs);
      if (record.status !== "pending") {
        const resolvedAt = record.resolvedAtMs ?? record.createdAtMs;
        if (nowMs - resolvedAt >= TERMINAL_RETENTION_MS) {
          this.records.delete(record.id);
        } else {
          terminal.push(record);
        }
      }
    }

    if (terminal.length > MAX_TERMINAL_PROMPTS) {
      terminal.sort(
        (a, b) =>
          (a.resolvedAtMs ?? a.createdAtMs) - (b.resolvedAtMs ?? b.createdAtMs),
      );
      const excess = terminal.length - MAX_TERMINAL_PROMPTS;
      for (let i = 0; i < excess; i++) {
        this.records.delete(terminal[i]!.id);
      }
    }
  }

  getActiveCount(): number {
    this.sweep();
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === "pending") count++;
    }
    return count;
  }

  getRecord(id: string): PromptBridgeRecord | null {
    const rec = this.records.get(id);
    if (!rec) return null;
    this.expireRecordIfNeeded(rec, Date.now());
    return rec;
  }

  getPrompt(id: string): PendingHumanPrompt | null {
    const rec = this.getRecord(id);
    return rec ? toPendingHumanPrompt(rec) : null;
  }

  listPendingRecords(filter?: PromptBridgeFilter): PromptBridgeRecord[] {
    this.sweep();
    const ideFilter = filter?.ide?.trim().toLowerCase();
    const sessionFilter = filter?.sessionId?.trim();
    const workspaceFilter = filter?.workspace?.trim();
    const projectFilter = filter?.project?.trim();

    const out: PromptBridgeRecord[] = [];
    for (const rec of this.records.values()) {
      if (rec.status !== "pending") continue;
      if (sessionFilter && rec.sessionId !== sessionFilter) continue;
      if (workspaceFilter) {
        if (
          !rec.workspacePath ||
          !pathMatchesRoot(rec.workspacePath, workspaceFilter)
        ) {
          continue;
        }
      }
      if (
        projectFilter &&
        projectFilter.toLowerCase() !== "all" &&
        !promptMatchesProjectFilter(rec, projectFilter)
      ) {
        continue;
      }
      if (ideFilter && ideFilter !== "all") {
        const matchesDirectIde = rec.ide.toLowerCase() === ideFilter;
        const matchesAutoMcp = rec.autoAttributed && rec.ide === "mcp";
        if (!matchesDirectIde && !matchesAutoMcp) {
          continue;
        }
      }
      out.push(rec);
    }
    out.sort((a, b) => b.createdAtMs - a.createdAtMs);
    return out;
  }

  listPending(filter?: PromptBridgeFilter): PendingHumanPrompt[] {
    return this.listPendingRecords(filter).map(toPendingHumanPrompt);
  }

  async createPrompt(input: PromptBridgeCreateInput): Promise<CreatePromptResult> {
    if (this.disposed) {
      return { ok: false, statusCode: 503, error: "Prompt bridge disposed" };
    }
    this.sweep();
    let activeCount = 0;
    for (const r of this.records.values()) {
      if (r.status === "pending") activeCount++;
    }
    // Reserve a slot synchronously (before any await) so concurrent bursts
    // can never exceed MAX_ACTIVE_PROMPTS.
    if (activeCount + this.pendingCreates >= MAX_ACTIVE_PROMPTS) {
      return {
        ok: false,
        statusCode: 429,
        error: `Maximum active prompts limit (${MAX_ACTIVE_PROMPTS}) reached`,
      };
    }
    this.pendingCreates++;
    try {
      return await this.createPromptReserved(input);
    } finally {
      this.pendingCreates--;
    }
  }

  private async createPromptReserved(
    input: PromptBridgeCreateInput,
  ): Promise<CreatePromptResult> {
    const id = `pb_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const promptSource = input.promptSource ?? "studio-mcp";
    const workspacePath = input.workspacePath?.trim()
      ? normalizeWsPath(input.workspacePath.trim())
      : undefined;
    const projectId = inferProjectId(input.projectId, workspacePath);

    let sessionId = input.sessionId?.trim() || "";
    let autoAttributed = false;
    let resolvedIde: IdeSource | undefined = input.ide;

    if (sessionId) {
      if (!resolvedIde && this.findActiveSession) {
        const matched = await this.findActiveSession({
          sessionId,
          workspacePath,
          projectId,
        }).catch(() => null);
        if (matched) {
          resolvedIde = matched.ide;
        }
      }
      if (!resolvedIde) {
        resolvedIde =
          promptSource === "studio-vscode-lm" ? "copilot-vscode" : "mcp";
      }
    } else {
      const searchIde =
        input.ide ??
        (promptSource === "studio-vscode-lm" ? "copilot-vscode" : undefined);
      let matched: DiscoveredSession | null = null;
      if (this.findActiveSession) {
        matched = await this.findActiveSession({
          ide: searchIde,
          workspacePath,
          projectId,
        }).catch(() => null);
      } else {
        matched = this.findActivePushSessionFallback({
          ide: searchIde,
          workspacePath,
          projectId,
        });
      }

      if (matched) {
        sessionId = matched.sessionId;
        autoAttributed = false;
        if (!resolvedIde) {
          resolvedIde =
            promptSource === "studio-vscode-lm" ? "copilot-vscode" : matched.ide;
        }
      } else {
        sessionId = `prompt-${id}`;
        autoAttributed = true;
        resolvedIde =
          resolvedIde ??
          (promptSource === "studio-vscode-lm" ? "copilot-vscode" : "mcp");
      }
    }

    const questions = normalizeCreateQuestions(input.questions);
    const kind = input.kind ?? "question";
    const agentId = input.agentId?.trim() || "root";
    const agentLabel = input.agentLabel?.trim() || prettifyAgentLabel(agentId);
    const toolName =
      input.toolName?.trim() ||
      (promptSource === "studio-vscode-lm"
        ? "agent_studio_ask_human"
        : "ask_human");
    const toolCallId = input.toolCallId?.trim() || id;
    const title =
      cleanHumanSummary(
        input.title?.trim() ||
          questions[0]?.header ||
          questions[0]?.question ||
          (kind === "approval" ? "Approval requested" : "Question for you"),
        140,
      ) || "Question for you";
    const summary = input.summary?.trim()
      ? cleanHumanSummary(input.summary.trim(), 500) || undefined
      : undefined;
    const firstOpts = questions[0]?.options ?? [];
    const options =
      firstOpts.length > 0
        ? firstOpts.map((o) => ({
            label: o.label,
            ...(o.recommended ? { recommended: true } : {}),
          }))
        : undefined;

    const createdAtMs = Date.now();
    const timeoutMs = input.timeoutMs ?? DEFAULT_PROMPT_TTL_MS;
    const expiresAtMs = createdAtMs + timeoutMs;
    const ts = toIsoUtc(createdAtMs / 1000);
    const expiresAt = toIsoUtc(expiresAtMs / 1000);

    const record: PromptBridgeRecord = {
      id,
      status: "pending",
      promptSource,
      directReply: true,
      kind,
      title,
      ...(summary ? { summary } : {}),
      questions,
      ...(options ? { options } : {}),
      agentId,
      agentLabel,
      sessionId,
      autoAttributed,
      ...(workspacePath ? { workspacePath } : {}),
      ...(projectId ? { projectId } : {}),
      ide: resolvedIde,
      toolName,
      toolCallId,
      createdAtMs,
      ts,
      expiresAtMs,
      expiresAt,
      blockingToolCall: false,
    };

    if (this.disposed) {
      return { ok: false, statusCode: 503, error: "Prompt bridge disposed" };
    }
    this.records.set(id, record);

    const epoch = createdAtMs / 1000;
    this.pushBus.ingest([
      {
        id: createDeterministicEventId(["pb", "start", record.id]),
        ts,
        epoch,
        ide: record.ide,
        channel: "mcp",
        sessionId: record.sessionId,
        ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
        ...(record.projectId ? { projectId: record.projectId } : {}),
        agentId: record.agentId,
        agentLabel: record.agentLabel,
        targetAgentId: "human",
        kind: "tool_start",
        toolName: record.toolName,
        toolCallId: record.toolCallId,
        summary:
          cleanHumanSummary(
            `Ask user: ${record.questions[0]?.question ?? record.title}`,
            120,
          ) || record.title,
        status: "running",
        waitingReason: "user",
        payload: {
          promptId: record.id,
          directReply: true,
          promptSource: record.promptSource,
          promptStatus: "pending",
          expiresAt: record.expiresAt,
          blockingToolCall: false,
          questions: record.questions,
          promptTitle: record.title,
          ...(record.summary ? { promptSummary: record.summary } : {}),
          promptKind: record.kind,
        },
      },
    ]);

    const prompt = toPendingHumanPrompt(record);
    this.emit("change", { type: "created", prompt });
    return { ok: true, prompt, record };
  }

  private findActivePushSessionFallback(criteria: {
    ide?: IdeSource;
    workspacePath?: string;
    projectId?: string;
  }): DiscoveredSession | null {
    const nowMs = Date.now();
    const candidates = this.pushBus
      .discoverPushSessions()
      .filter((s) => {
        if (
          s.sessionId.startsWith("mcp-") ||
          s.sessionId.startsWith("prompt-")
        ) {
          return false;
        }
        if (nowMs - s.mtimeMs > ACTIVE_SESSION_ATTRIBUTION_WINDOW_MS) {
          return false;
        }
        if (
          criteria.ide &&
          criteria.ide !== "mcp" &&
          criteria.ide !== "unknown" &&
          s.ide !== criteria.ide
        ) {
          return false;
        }
        if (criteria.workspacePath) {
          const wss = [
            ...(s.workspacePath ? [s.workspacePath] : []),
            ...s.workspaces,
          ];
          const matchesWs = wss.some(
            (w) =>
              pathMatchesRoot(w, criteria.workspacePath!) ||
              pathMatchesRoot(criteria.workspacePath!, w),
          );
          if (!matchesWs) return false;
        }
        if (criteria.projectId) {
          const matchesProj =
            s.projectId?.toLowerCase() === criteria.projectId.toLowerCase();
          if (!matchesProj && !criteria.workspacePath) return false;
        }
        return true;
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0] ?? null;
  }

  answerPrompt(
    id: string,
    input: PromptBridgeAnswerInput,
  ): ResolvePromptResult {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, notFound: true };
    }
    this.expireRecordIfNeeded(record, Date.now());
    if (record.status !== "pending") {
      return {
        ok: false,
        conflict: true,
        status: record.status,
        prompt: toPendingHumanPrompt(record),
      };
    }

    const nowMs = Date.now();
    const baseEpoch = nowMs / 1000;
    record.status = "answered";
    record.answerText = input.answerText;
    record.answers = input.answers;
    record.responder = input.responder?.trim() || undefined;
    record.resolvedAtMs = nowMs;
    record.resolvedAt = toIsoUtc(baseEpoch);

    const questionPrompt =
      record.questions
        .map((q) => q.question.trim())
        .filter(Boolean)
        .join(" / ")
        .slice(0, 500) || record.title;
    const inlineBody = record.answerText.slice(0, INLINE_BODY_MAX_CHARS);
    const userInputId = createDeterministicEventId(["pb", "answer", record.id]);
    if (record.answerText.length > INLINE_BODY_MAX_CHARS && this.bodyStore) {
      this.bodyStore.set(record.sessionId, userInputId, record.answerText);
    }

    this.pushBus.ingest([
      {
        id: createDeterministicEventId(["pb", "end", record.id]),
        ts: toIsoUtc(baseEpoch),
        epoch: baseEpoch,
        ide: record.ide,
        channel: "mcp",
        sessionId: record.sessionId,
        ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
        ...(record.projectId ? { projectId: record.projectId } : {}),
        agentId: record.agentId,
        agentLabel: record.agentLabel,
        kind: "tool_end",
        toolName: record.toolName,
        toolCallId: record.toolCallId,
        summary: `Answered: ${cleanHumanSummary(record.answerText, 100)}`,
        status: "ok",
        isError: false,
        payload: {
          promptId: record.id,
          directReply: true,
          promptSource: record.promptSource,
          promptStatus: "answered",
          outputPreview: inlineBody,
        },
      },
      {
        id: userInputId,
        ts: toIsoUtc(baseEpoch + 0.001),
        epoch: baseEpoch + 0.001,
        ide: record.ide,
        channel: "mcp",
        sessionId: record.sessionId,
        ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
        ...(record.projectId ? { projectId: record.projectId } : {}),
        agentId: record.agentId,
        agentLabel: record.agentLabel,
        targetAgentId: record.agentId,
        kind: "user_input",
        summary: `Human: ${cleanHumanSummary(record.answerText, 120)}`,
        payload: {
          isHumanAnswer: true,
          directReply: true,
          promptId: record.id,
          questionToolCallId: record.toolCallId,
          questionPrompt,
          targetAgentId: record.agentId,
          body: record.answerText,
          ...(record.answers ? { answers: record.answers } : {}),
          ...(record.responder ? { responder: record.responder } : {}),
        },
      },
    ]);

    const prompt = toPendingHumanPrompt(record);
    this.notifyWaiters(record.id);
    this.emit("change", { type: "answered", prompt });
    return { ok: true, prompt, record };
  }

  cancelPrompt(id: string, reason?: string): ResolvePromptResult {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, notFound: true };
    }
    this.expireRecordIfNeeded(record, Date.now());
    if (record.status !== "pending") {
      return {
        ok: false,
        conflict: true,
        status: record.status,
        prompt: toPendingHumanPrompt(record),
      };
    }

    const nowMs = Date.now();
    record.status = "canceled";
    record.cancelReason = reason?.trim() || undefined;
    record.resolvedAtMs = nowMs;
    record.resolvedAt = toIsoUtc(nowMs / 1000);

    this.ingestTerminalToolEnd(record, "canceled", record.cancelReason);

    const prompt = toPendingHumanPrompt(record);
    this.notifyWaiters(record.id);
    this.emit("change", { type: "canceled", prompt });
    return { ok: true, prompt, record };
  }

  async waitForResolution(
    id: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<PendingHumanPrompt | null> {
    const initial = this.getRecord(id);
    if (!initial) return null;
    if (initial.status !== "pending") {
      return toPendingHumanPrompt(initial);
    }

    const clampedWait = Math.max(
      0,
      Math.min(MAX_PROMPT_WAIT_MS, Number.isFinite(waitMs) ? waitMs : 0),
    );
    if (clampedWait <= 0 || signal?.aborted || this.disposed) {
      return toPendingHumanPrompt(initial);
    }

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      let waiterSet = this.waiters.get(id);
      if (!waiterSet) {
        waiterSet = new Set();
        this.waiters.set(id, waiterSet);
      }

      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        waiterSet?.delete(onWake);
        if (waiterSet && waiterSet.size === 0) {
          this.waiters.delete(id);
        }
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };

      const onWake = (): void => {
        if (this.disposed) {
          cleanup();
          return;
        }
        const cur = this.getRecord(id);
        if (!cur || cur.status !== "pending") {
          cleanup();
        }
      };

      const onAbort = (): void => {
        cleanup();
      };

      waiterSet.add(onWake);
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      timer = setTimeout(() => {
        this.getRecord(id);
        cleanup();
      }, clampedWait);
      timer.unref();
    });

    return this.getPrompt(id);
  }
}
