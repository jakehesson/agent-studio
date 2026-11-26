import fs from "node:fs/promises";
import path from "node:path";
import {
  BOARD_STATES,
  BUG_RESOLUTIONS,
  BUG_SEVERITIES,
  SplitProposalSchema,
  type Board,
  type BoardItem,
  type BoardItemType,
  type BoardState,
  type BugResolution,
  type BugSeverity,
  type ContextHandoff,
  type SplitProposal,
  type TestrunRecord,
} from "../schema/board.js";
import type { ResolvedProject } from "./registry.js";
import { readBoard, withBoardLock, type BoardLockOptions } from "./store.js";

export const ALLOWED_TRANSITIONS: Record<BoardState, readonly BoardState[]> = {
  backlog: ["ready", "blocked"],
  ready: ["design", "dev", "test", "blocked", "backlog"],
  design: ["dev", "test", "blocked", "ready"],
  dev: ["test", "blocked", "design", "ready"],
  test: ["done", "dev", "blocked"],
  done: ["dev"],
  blocked: ["backlog", "ready", "design", "dev", "test"],
};

const MAX_NOTES = 50;

export class QaGateError extends Error {
  readonly code = "QA_GATE_REJECTED";
  readonly itemId: string;
  readonly requiredSuite: string;
  readonly requiredCheckpoints: string[];

  constructor(
    message: string,
    itemId: string,
    requiredSuite: string,
    requiredCheckpoints: string[],
  ) {
    super(message);
    this.name = "QaGateError";
    this.itemId = itemId;
    this.requiredSuite = requiredSuite;
    this.requiredCheckpoints = requiredCheckpoints;
  }
}

export interface BoardEngineContext {
  project: ResolvedProject;
  lockOptions?: BoardLockOptions;
}

export interface EngineResult<T = unknown> {
  text: string;
  data: T;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function findItem(board: Board, itemId: string): BoardItem {
  const needle = itemId.trim().toLowerCase();
  const item = board.items.find((it) => it.id.toLowerCase() === needle);
  if (!item) {
    throw new Error(`No item "${itemId}" on board "${board.project ?? "unknown"}"`);
  }
  return item;
}

function depsDone(board: Board, item: BoardItem): boolean {
  const doneIds = new Set(
    board.items.filter((i) => i.state === "done").map((i) => i.id.toLowerCase()),
  );
  return (item.deps ?? []).every((dep) => doneIds.has(dep.toLowerCase()));
}

function unfinishedDeps(board: Board, item: BoardItem): string[] {
  const doneIds = new Set(
    board.items.filter((i) => i.state === "done").map((i) => i.id.toLowerCase()),
  );
  return (item.deps ?? []).filter((dep) => !doneIds.has(dep.toLowerCase()));
}

function formatItemLine(board: Board, item: BoardItem): string {
  const sev = item.severity ? ` ${item.severity}` : "";
  const missing = unfinishedDeps(board, item);
  const depText = missing.length > 0 ? ` (deps:${missing.join(",")})` : "";
  const handoffTag =
    item.handoff?.status === "pending_handoff"
      ? " [HANDOFF_PENDING]"
      : item.handoff?.status === "pending_split"
        ? " [SPLIT_PENDING]"
        : "";
  return `${item.id} [${item.state}] ${item.type}/${item.role}${sev}: ${item.title}${depText}${handoffTag}`;
}

function appendNote(item: BoardItem, actor: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (!item.notes) {
    item.notes = [];
  }
  item.notes.push(`${nowIso()} ${actor}: ${trimmed}`);
  if (item.notes.length > MAX_NOTES) {
    item.notes = item.notes.slice(-MAX_NOTES);
  }
}

function parseTimestampMs(ts: string | undefined | null): number | null {
  if (!ts) return null;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? null : parsed;
}

function extractNoteTimestampMs(note: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/.exec(
    note,
  );
  return match?.[1] ? parseTimestampMs(match[1]) : null;
}

function getItemFreshnessMs(item: BoardItem): number | null {
  if (item.reopened_at) {
    const ms = parseTimestampMs(item.reopened_at);
    if (ms !== null) return ms;
  }
  const notes = item.notes ?? [];
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    if (n && n.includes("REOPENED")) {
      const ms = extractNoteTimestampMs(n);
      if (ms !== null) return ms;
    }
  }
  if (item.created_at) {
    const ms = parseTimestampMs(item.created_at);
    if (ms !== null) return ms;
  }
  const firstNote = notes[0];
  if (firstNote) {
    return extractNoteTimestampMs(firstNote);
  }
  return null;
}

function resolveRequiredSuiteAndCheckpoints(
  board: Board,
  item: BoardItem,
): { suiteName: string; checkpoints: string[] } {
  if (item.required_checkpoints && item.required_checkpoints.length > 0) {
    return {
      suiteName: item.suite ?? "custom",
      checkpoints: item.required_checkpoints,
    };
  }
  const suites = board.suites ?? {};
  const suiteName =
    item.suite ??
    (suites["smoke"] ? "smoke" : undefined) ??
    (suites[board.milestone.final_suite] ? board.milestone.final_suite : undefined) ??
    Object.keys(suites)[0] ??
    "smoke";
  const checkpoints = suites[suiteName] ?? [];
  return { suiteName, checkpoints };
}

function findCoveringPassingTestrun(
  board: Board,
  item: BoardItem,
): {
  testrun: TestrunRecord | null;
  suiteName: string;
  checkpoints: string[];
} {
  const { suiteName, checkpoints } = resolveRequiredSuiteAndCheckpoints(board, item);
  const freshnessMs = getItemFreshnessMs(item);
  const itemLower = item.id.toLowerCase();

  const candidates = [...(board.testruns ?? [])].reverse();
  for (const tr of candidates) {
    if (tr.status !== "passed" || !tr.closed) {
      continue;
    }

    const results = tr.results ?? {};
    const allCheckpointsPassed = checkpoints.every((cp) => {
      const val = results[cp];
      return typeof val === "string" && val.toLowerCase().startsWith("pass");
    });
    if (!allCheckpointsPassed) {
      continue;
    }

    if (tr.items && tr.items.length > 0) {
      const explicitlyCovers = tr.items.some(
        (id) => id.toLowerCase() === itemLower,
      );
      if (!explicitlyCovers) {
        continue;
      }
      return { testrun: tr, suiteName, checkpoints };
    }

    // General suite run (no explicit items array): verify freshness so stale historical runs
    // from before item creation or reopen cannot bypass the QA Gate.
    const closedMs = parseTimestampMs(tr.closed);
    if (freshnessMs !== null && closedMs !== null && closedMs < freshnessMs) {
      continue;
    }

    return { testrun: tr, suiteName, checkpoints };
  }

  return { testrun: null, suiteName, checkpoints };
}

export async function boardStatus(
  ctx: BoardEngineContext,
  opts?: { sprint?: string; showDone?: boolean },
): Promise<
  EngineResult<{
    project: string;
    milestone: Board["milestone"];
    sprint: string | null;
    counts: Record<string, number>;
    openBugs: BoardItem[];
    items: BoardItem[];
    latestBuild: string | null;
  }>
> {
  const board = await readBoard(ctx.project.boardPath);
  const sp = opts?.sprint ?? board.active_sprint ?? null;
  const sprintInfo = sp ? board.sprints[sp] : undefined;
  const sprintItems = sp
    ? board.items.filter((i) => i.sprint === sp)
    : [...board.items];

  const counts: Record<string, number> = {};
  for (const item of sprintItems) {
    counts[item.state] = (counts[item.state] ?? 0) + 1;
  }

  const openBugs = board.items.filter(
    (i) => i.type === "bug" && i.state !== "done",
  );
  const latestBuild =
    board.builds.length > 0
      ? (board.builds[board.builds.length - 1]?.id ?? null)
      : null;

  const visibleItems = sprintItems.filter(
    (i) => Boolean(opts?.showDone) || i.state !== "done",
  );
  const extraBugs = openBugs.filter((b) => b.sprint !== sp);

  const countParts = BOARD_STATES.filter((st) => (counts[st] ?? 0) > 0).map(
    (st) => `${st}=${counts[st]}`,
  );
  const severities = [...new Set(openBugs.map((b) => b.severity ?? "?"))].sort();

  const lines: string[] = [
    `${board.milestone.id} ${board.milestone.name} | sprint ${sp ?? "none"} (${sprintInfo?.status ?? "unknown"}): ${sprintInfo?.goal ?? ""}`,
    `counts: ${countParts.join(", ") || "none"}`,
    `open bugs: ${openBugs.length} (${severities.join(", ") || "-"})`,
    `latest build: ${latestBuild ?? "none"}`,
    ...visibleItems.slice(0, 30).map((i) => formatItemLine(board, i)),
    ...extraBugs.slice(0, 10).map((i) => formatItemLine(board, i)),
  ];

  return {
    text: lines.join("\n"),
    data: {
      project: board.project ?? ctx.project.id,
      milestone: board.milestone,
      sprint: sp,
      counts,
      openBugs,
      items: visibleItems,
      latestBuild,
    },
  };
}

export async function boardNext(
  ctx: BoardEngineContext,
  opts?: { role?: string; limit?: number },
): Promise<EngineResult<BoardItem[]>> {
  const board = await readBoard(ctx.project.boardPath);
  const sp = board.active_sprint ?? null;
  const limit = opts?.limit ?? 5;
  const roleFilter = opts?.role?.trim().toLowerCase();

  const ready = board.items.filter((item) => {
    if (item.state !== "ready") return false;
    if (!depsDone(board, item)) return false;
    if (sp && item.sprint !== sp && item.type !== "bug") return false;
    if (roleFilter && item.role.toLowerCase() !== roleFilter) return false;
    return true;
  });

  ready.sort((a, b) => {
    const aBug = a.type === "bug" ? 0 : 1;
    const bBug = b.type === "bug" ? 0 : 1;
    if (aBug !== bBug) return aBug - bBug;
    const aSev = a.severity ?? "S9";
    const bSev = b.severity ?? "S9";
    return aSev.localeCompare(bSev);
  });

  const sliced = ready.slice(0, limit);
  const text =
    sliced.length === 0
      ? `no ready items${opts?.role ? ` for role ${opts.role}` : ""}`
      : sliced.map((i) => formatItemLine(board, i)).join("\n");

  return { text, data: sliced };
}

export async function boardShow(
  ctx: BoardEngineContext,
  opts: { itemId: string },
): Promise<EngineResult<BoardItem>> {
  const board = await readBoard(ctx.project.boardPath);
  const item = findItem(board, opts.itemId);
  const out: string[] = [formatItemLine(board, item)];

  const scalarKeys = [
    "points",
    "deps",
    "split_from",
    "found_in",
    "fixed_in",
    "verified_build",
    "resolution",
    "owner",
    "suite",
  ] as const;
  for (const key of scalarKeys) {
    const val = item[key];
    if (val !== undefined && val !== null && (!Array.isArray(val) || val.length > 0)) {
      out.push(`${key}: ${Array.isArray(val) ? val.join(", ") : String(val)}`);
    }
  }
  if (item.handoff) {
    const h = item.handoff;
    out.push("handoff:");
    out.push(`  status: ${h.status}`);
    out.push(`  kind: ${h.kind}`);
    out.push(`  actor: ${h.actor} (${h.created_at})`);
    if (h.objective) {
      out.push(`  objective: ${h.objective}`);
    }
    if (h.context_percent !== undefined) {
      const tokPart =
        h.context_tokens !== undefined && h.context_window !== undefined
          ? ` (${h.context_tokens}/${h.context_window})`
          : "";
      out.push(`  context: ${h.context_percent}%${tokPart}`);
    }
    out.push(`  summary: ${h.summary}`);
    if (h.evidence && h.evidence.length > 0) {
      out.push("  evidence:");
      for (const ev of h.evidence) {
        out.push(`    - ${ev}`);
      }
    }
    if (h.decisions && h.decisions.length > 0) {
      out.push("  decisions:");
      for (const dec of h.decisions) {
        out.push(`    - ${dec}`);
      }
    }
    if (h.assumptions && h.assumptions.length > 0) {
      out.push("  assumptions:");
      for (const asmp of h.assumptions) {
        out.push(`    - ${asmp}`);
      }
    }
    if (h.unresolved_issues && h.unresolved_issues.length > 0) {
      out.push("  unresolved_issues:");
      for (const issue of h.unresolved_issues) {
        out.push(`    - ${issue}`);
      }
    }
    if (h.modified_files && h.modified_files.length > 0) {
      out.push(`  modified_files: ${h.modified_files.join(", ")}`);
    }
    if (h.verified_checks && h.verified_checks.length > 0) {
      out.push(`  verified_checks: ${h.verified_checks.join(", ")}`);
    }
    if (h.remaining_work && h.remaining_work.length > 0) {
      out.push("  remaining_work:");
      for (const rw of h.remaining_work) {
        out.push(`    - ${rw}`);
      }
    }
    out.push(`  continuation_brief: ${h.continuation_brief}`);
    if (h.split_proposals && h.split_proposals.length > 0) {
      out.push("  split_proposals:");
      for (const sp of h.split_proposals) {
        out.push(
          `    - [${sp.role}] ${sp.title}${sp.ac.length > 0 ? ` (ac: ${sp.ac.join("; ")})` : ""}`,
        );
      }
    }
  }
  if (item.ac && item.ac.length > 0) {
    out.push("AC:");
    for (const ac of item.ac) {
      out.push(`  - ${ac}`);
    }
  }
  if (item.evidence && item.evidence.length > 0) {
    out.push(`evidence: ${item.evidence.slice(-6).join("; ")}`);
  }
  if (item.notes && item.notes.length > 0) {
    out.push("notes:");
    for (const note of item.notes.slice(-8)) {
      out.push(`  ${note}`);
    }
  }

  return { text: out.join("\n"), data: item };
}

export interface AddItemInput {
  type: BoardItemType;
  title: string;
  role: string;
  sprint?: string;
  ac?: string[];
  severity?: BugSeverity;
  deps?: string[];
  points?: number;
  actor?: string;
  foundIn?: string;
  repro?: string;
  suite?: string;
  requiredCheckpoints?: string[];
}

export async function boardAdd(
  ctx: BoardEngineContext,
  opts: AddItemInput,
): Promise<EngineResult<BoardItem>> {
  if (!opts.title.trim()) {
    throw new Error("Item title must not be empty");
  }
  if (!opts.role.trim()) {
    throw new Error("Item role must not be empty");
  }
  if (opts.type === "bug") {
    if (!opts.severity || !BUG_SEVERITIES.includes(opts.severity)) {
      throw new Error(`Bugs require severity one of ${BUG_SEVERITIES.join(", ")}`);
    }
  }

  return withBoardLock(
    ctx.project.boardPath,
    (board) => {
      const sp = opts.sprint ?? board.active_sprint ?? "S1";
      const prefix = opts.type === "bug" ? "BUG" : sp;
      const prefixRe = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`, "i");

      let maxNum = 0;
      for (const existing of board.items) {
        const match = prefixRe.exec(existing.id);
        if (match?.[1]) {
          const num = Number.parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      }
      const nextNum = maxNum + 1;
      const id = `${prefix}-${String(nextNum).padStart(2, "0")}`;
      const createdAt = nowIso();

      const item: BoardItem = {
        id,
        type: opts.type,
        title: opts.title.trim(),
        role: opts.role.trim(),
        sprint: sp,
        state:
          opts.type === "bug" || sp === board.active_sprint
            ? "ready"
            : "backlog",
        ac: [...(opts.ac ?? [])],
        deps: [...(opts.deps ?? [])],
        notes: [],
        created_at: createdAt,
      };

      if (opts.points !== undefined) {
        item.points = Math.trunc(opts.points);
      }
      if (opts.suite) {
        item.suite = opts.suite;
      }
      if (opts.requiredCheckpoints && opts.requiredCheckpoints.length > 0) {
        item.required_checkpoints = [...opts.requiredCheckpoints];
      }
      if (opts.type === "bug") {
        item.severity = opts.severity;
        const latestBuild =
          board.builds.length > 0
            ? (board.builds[board.builds.length - 1]?.id ?? null)
            : null;
        item.found_in = opts.foundIn ?? latestBuild;
        if (!item.ac || item.ac.length === 0) {
          item.ac = [
            "Repro steps no longer reproduce on a new build",
            "QA retest recorded with verified_build",
          ];
        }
      }

      const actor = opts.actor?.trim() || "orchestrator";
      appendNote(item, actor, opts.repro ? `repro: ${opts.repro}` : "created");
      board.items.push(item);

      return {
        text: `added ${formatItemLine(board, item)}`,
        data: item,
      };
    },
    ctx.lockOptions,
  );
}

export interface MoveItemInput {
  itemId: string;
  state: BoardState;
  actor: string;
  note?: string;
  evidence?: string;
  build?: string;
  resolution?: BugResolution;
  overrideReason?: string;
}

export async function boardMove(
  ctx: BoardEngineContext,
  opts: MoveItemInput,
): Promise<EngineResult<{ item: BoardItem; qaGate: "passed" | "overridden" | "not_applicable"; coveringTestrun?: string }>> {
  const actor = opts.actor?.trim() || "orchestrator";

  return withBoardLock(
    ctx.project.boardPath,
    (board) => {
      const item = findItem(board, opts.itemId);
      const cur = item.state;
      const target = opts.state;

      if (!ALLOWED_TRANSITIONS[cur].includes(target)) {
        throw new Error(
          `Illegal transition ${cur} -> ${target} for ${item.id} (allowed: ${ALLOWED_TRANSITIONS[cur].join(", ")})`,
        );
      }

      if ((target === "design" || target === "dev" || target === "test") && !depsDone(board, item)) {
        const missing = unfinishedDeps(board, item);
        throw new Error(`${item.id} has unfinished deps: ${missing.join(", ")}`);
      }

      if (target === "blocked" && !opts.note?.trim()) {
        throw new Error("Blocking an item requires a note explaining the reason");
      }

      if (target === "test" && !opts.note?.trim() && !opts.evidence?.trim()) {
        throw new Error("Handoff to test requires a note or evidence path");
      }

      let qaGateStatus: "passed" | "overridden" | "not_applicable" = "not_applicable";
      let coveringTestrunId: string | undefined;

      if (target === "done") {
        const qaGateRequired = ctx.project.qaGateRequired;
        const { testrun, suiteName, checkpoints } = findCoveringPassingTestrun(
          board,
          item,
        );

        if (qaGateRequired) {
          if (testrun) {
            qaGateStatus = "passed";
            coveringTestrunId = testrun.id;
          } else if (opts.overrideReason && opts.overrideReason.trim().length > 0) {
            qaGateStatus = "overridden";
            appendNote(
              item,
              actor,
              `[QA_GATE_OVERRIDE] ${opts.overrideReason.trim()}`,
            );
          } else {
            const cpText =
              checkpoints.length > 0 ? checkpoints.join(", ") : "none";
            throw new QaGateError(
              `QA Gate rejected ${cur} -> done for ${item.id}: no closed, passing testrun covers suite "${suiteName}" (checkpoints: ${cpText}). Run testrun start/record/close first, or pass overrideReason for an audited override.`,
              item.id,
              suiteName,
              checkpoints,
            );
          }
        } else if (testrun) {
          qaGateStatus = "passed";
          coveringTestrunId = testrun.id;
        }

        if (item.type === "bug") {
          const verifiedBuild = opts.build?.trim() || testrun?.build;
          if (!verifiedBuild && qaGateStatus !== "overridden") {
            throw new Error(
              `Closing bug ${item.id} requires build (the build QA retested on)`,
            );
          }
          if (verifiedBuild) {
            item.verified_build = verifiedBuild;
          }
          const res = opts.resolution ?? "fixed";
          if (!BUG_RESOLUTIONS.includes(res)) {
            throw new Error(
              `Invalid bug resolution "${String(res)}". Must be one of: ${BUG_RESOLUTIONS.join(", ")}`,
            );
          }
          item.resolution = res;
        }
      }

      if (target === "dev" && (cur === "test" || cur === "done")) {
        item.reopened_at = nowIso();
        appendNote(item, actor, "REOPENED");
      }

      if (opts.build && target === "test" && item.type === "bug") {
        item.fixed_in = opts.build;
      }

      if (target === "blocked") {
        item.blocked_from = cur;
      }

      if (opts.evidence?.trim()) {
        if (!item.evidence) item.evidence = [];
        item.evidence.push(opts.evidence.trim());
      } else if (coveringTestrunId) {
        const tag = `${coveringTestrunId} PASS`;
        if (!item.evidence) item.evidence = [];
        if (!item.evidence.some((e) => e.includes(coveringTestrunId))) {
          item.evidence.push(tag);
        }
      }

      item.state = target;
      if (
        item.handoff?.status === "pending_handoff" &&
        (target === "design" || target === "dev" || target === "test")
      ) {
        item.handoff.status = "resumed";
      } else if (
        target === "done" &&
        (item.handoff?.status === "pending_handoff" ||
          item.handoff?.status === "pending_split" ||
          item.handoff?.status === "resumed")
      ) {
        item.handoff.status = "cleared";
      }
      const transitionNote = `${cur}->${target}${opts.note?.trim() ? ` | ${opts.note.trim()}` : ""}${coveringTestrunId ? ` (${coveringTestrunId})` : ""}`;
      appendNote(item, actor, transitionNote);

      return {
        text: formatItemLine(board, item),
        data: {
          item,
          qaGate: qaGateStatus,
          coveringTestrun: coveringTestrunId,
        },
      };
    },
    ctx.lockOptions,
  );
}

export async function boardNote(
  ctx: BoardEngineContext,
  opts: { itemId: string; actor: string; text: string; evidence?: string },
): Promise<EngineResult<BoardItem>> {
  return withBoardLock(
    ctx.project.boardPath,
    (board) => {
      const item = findItem(board, opts.itemId);
      appendNote(item, opts.actor || "orchestrator", opts.text);
      if (opts.evidence?.trim()) {
        if (!item.evidence) item.evidence = [];
        item.evidence.push(opts.evidence.trim());
      }
      return {
        text: `noted ${item.id}`,
        data: item,
      };
    },
    ctx.lockOptions,
  );
}

export async function boardOwner(
  ctx: BoardEngineContext,
  opts: { itemId: string; owner: string },
): Promise<EngineResult<BoardItem>> {
  return withBoardLock(
    ctx.project.boardPath,
    (board) => {
      const item = findItem(board, opts.itemId);
      item.owner = opts.owner.trim();
      if (item.handoff?.status === "pending_handoff") {
        item.handoff.status = "resumed";
      }
      return {
        text: `owner ${item.id}=${item.owner}`,
        data: item,
      };
    },
    ctx.lockOptions,
  );
}

export interface HandoffItemInput {
  itemId: string;
  kind: "fresh_context" | "task_split";
  actor: string;
  objective?: string;
  summary: string;
  evidence?: string[];
  decisions?: string[];
  assumptions?: string[];
  unresolvedIssues?: string[];
  modifiedFiles?: string[];
  verifiedChecks?: string[];
  remainingWork?: string[];
  continuationBrief: string;
  splitProposals?: SplitProposal[];
  contextPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
  sessionId?: string;
  agentId?: string;
  keepOwner?: boolean;
}

function cleanOptionalStringList(items?: string[]): string[] | undefined {
  if (!items || items.length === 0) return undefined;
  const cleaned = items.map((s) => s.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

export async function boardHandoff(
  ctx: BoardEngineContext,
  opts: HandoffItemInput,
): Promise<EngineResult<BoardItem>> {
  const actor = opts.actor?.trim() || "orchestrator";
  const objective = opts.objective?.trim() || undefined;
  const summary = opts.summary?.trim();
  const continuationBrief = opts.continuationBrief?.trim();
  const evidence = cleanOptionalStringList(opts.evidence);
  const decisions = cleanOptionalStringList(opts.decisions);
  const assumptions = cleanOptionalStringList(opts.assumptions);
  const unresolvedIssues = cleanOptionalStringList(opts.unresolvedIssues);
  if (!summary) {
    throw new Error("board handoff requires non-empty summary");
  }
  if (!continuationBrief) {
    throw new Error("board handoff requires non-empty continuationBrief");
  }
  if (opts.kind !== "fresh_context" && opts.kind !== "task_split") {
    throw new Error('board handoff kind must be "fresh_context" or "task_split"');
  }
  const validatedProposals = opts.splitProposals?.map((p) =>
    SplitProposalSchema.parse(p),
  );

  return withBoardLock(
    ctx.project.boardPath,
    (board) => {
      const item = findItem(board, opts.itemId);
      const status =
        opts.kind === "task_split" ? "pending_split" : "pending_handoff";
      const handoff: ContextHandoff = {
        status,
        kind: opts.kind,
        created_at: nowIso(),
        actor,
        ...(opts.sessionId?.trim() ? { session_id: opts.sessionId.trim() } : {}),
        ...(opts.agentId?.trim() ? { agent_id: opts.agentId.trim() } : {}),
        ...(typeof opts.contextPercent === "number" &&
        Number.isFinite(opts.contextPercent)
          ? { context_percent: Math.min(100, Math.max(0, opts.contextPercent)) }
          : {}),
        ...(typeof opts.contextTokens === "number" &&
        Number.isFinite(opts.contextTokens) &&
        opts.contextTokens >= 0
          ? { context_tokens: Math.round(opts.contextTokens) }
          : {}),
        ...(typeof opts.contextWindow === "number" &&
        Number.isFinite(opts.contextWindow) &&
        opts.contextWindow > 0
          ? { context_window: Math.round(opts.contextWindow) }
          : {}),
        ...(objective ? { objective } : {}),
        summary,
        ...(evidence ? { evidence } : {}),
        ...(decisions ? { decisions } : {}),
        ...(assumptions ? { assumptions } : {}),
        ...(unresolvedIssues ? { unresolved_issues: unresolvedIssues } : {}),
        modified_files: [...(opts.modifiedFiles ?? [])],
        ...(opts.verifiedChecks && opts.verifiedChecks.length > 0
          ? { verified_checks: [...opts.verifiedChecks] }
          : {}),
        remaining_work: [...(opts.remainingWork ?? [])],
        continuation_brief: continuationBrief,
        ...(validatedProposals && validatedProposals.length > 0
          ? { split_proposals: validatedProposals }
          : {}),
      };

      item.handoff = handoff;
      if (opts.keepOwner !== true) {
        item.owner = null;
      }
      appendNote(item, actor, `[HANDOFF:${opts.kind}] ${summary}`);

      return {
        text: `${item.id} ${status.toUpperCase()} (${opts.kind}): ${summary}`,
        data: item,
      };
    },
    ctx.lockOptions,
  );
}

export interface SplitItemInput {
  itemId: string;
  actor: string;
  subtasks?: SplitProposal[];
  blockParent?: boolean;
}

export async function boardSplit(
  ctx: BoardEngineContext,
  opts: SplitItemInput,
): Promise<EngineResult<{ parent: BoardItem; children: BoardItem[] }>> {
  const actor = opts.actor?.trim() || "orchestrator";
  const blockParent = opts.blockParent ?? true;

  return withBoardLock(
    ctx.project.boardPath,
    (board) => {
      const parent = findItem(board, opts.itemId);
      const rawProposals =
        opts.subtasks && opts.subtasks.length > 0
          ? opts.subtasks
          : parent.handoff?.split_proposals;
      if (!rawProposals || rawProposals.length === 0) {
        throw new Error(
          `board split requires subtasks or existing handoff.split_proposals on ${parent.id}`,
        );
      }
      const proposals = rawProposals.map((p) => SplitProposalSchema.parse(p));

      const sp = parent.sprint ?? board.active_sprint ?? "S1";
      const prefix = sp;
      const prefixRe = new RegExp(
        `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`,
        "i",
      );
      let maxNum = 0;
      for (const existing of board.items) {
        const match = prefixRe.exec(existing.id);
        if (match?.[1]) {
          const num = Number.parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      }

      const createdAt = nowIso();
      const children: BoardItem[] = [];
      const parentLow = parent.id.toLowerCase();
      for (const prop of proposals) {
        maxNum += 1;
        const childId = `${prefix}-${String(maxNum).padStart(2, "0")}`;
        const childLow = childId.toLowerCase();
        const dedupedDeps: string[] = [];
        const seenDeps = new Set<string>();
        for (const rawDep of prop.deps ?? []) {
          const cleanDep = rawDep.trim();
          if (!cleanDep) continue;
          const lowDep = cleanDep.toLowerCase();
          if (lowDep === childLow) {
            throw new Error(
              `Circular dependency in split proposal "${prop.title}": child ${childId} cannot depend on itself`,
            );
          }
          if (blockParent && lowDep === parentLow) {
            throw new Error(
              `Circular dependency in split proposal "${prop.title}": child ${childId} cannot depend on parent ${parent.id} when blockParent is enabled`,
            );
          }
          if (!seenDeps.has(lowDep)) {
            seenDeps.add(lowDep);
            dedupedDeps.push(cleanDep);
          }
        }
        const child: BoardItem = {
          id: childId,
          type: "task",
          title: prop.title.trim(),
          role: prop.role.trim(),
          sprint: sp,
          state: parent.state === "backlog" ? "backlog" : "ready",
          ac: [...(prop.ac ?? [])],
          deps: dedupedDeps,
          notes: [],
          created_at: createdAt,
          split_from: parent.id,
        };
        appendNote(
          child,
          actor,
          prop.rationale?.trim()
            ? `split from ${parent.id}: ${prop.rationale.trim()}`
            : `split from ${parent.id}`,
        );
        children.push(child);
      }
      board.items.push(...children);

      const childIds = children.map((c) => c.id);
      if (blockParent) {
        const existingDeps = new Set((parent.deps ?? []).map((d) => d.toLowerCase()));
        parent.deps = [...(parent.deps ?? [])];
        for (const cid of childIds) {
          if (!existingDeps.has(cid.toLowerCase())) {
            parent.deps.push(cid);
            existingDeps.add(cid.toLowerCase());
          }
        }
      }
      if (parent.handoff) {
        parent.handoff.status = "resumed";
      }
      appendNote(parent, actor, `[SPLIT] created ${childIds.join(", ")}`);

      return {
        text: `split ${parent.id} -> ${childIds.join(", ")}`,
        data: { parent, children },
      };
    },
    ctx.lockOptions,
  );
}

export async function boardPlan(
  ctx: BoardEngineContext,
  opts: { sprint: string; goal?: string },
): Promise<EngineResult<{ sprint: string; readyCount: number; carriedOver: string[] }>> {
  return withBoardLock(
    ctx.project.boardPath,
    (board) => {
      const sprintId = opts.sprint.trim();
      if (!board.sprints[sprintId]) {
        if (opts.goal) {
          board.sprints[sprintId] = {
            goal: opts.goal,
            status: "planned",
          };
          if (!board.milestone.sprints.includes(sprintId)) {
            board.milestone.sprints.push(sprintId);
          }
        } else {
          throw new Error(
            `Unknown sprint "${sprintId}". Pass goal to create a new sprint.`,
          );
        }
      }

      const prev = board.active_sprint;
      const carriedOver: string[] = [];
      if (prev && prev !== sprintId) {
        for (const item of board.items) {
          if (item.sprint === prev && item.state !== "done" && item.type !== "bug") {
            item.sprint = sprintId;
            carriedOver.push(item.id);
          }
        }
        const prevSprint = board.sprints[prev];
        if (prevSprint) {
          prevSprint.status = "closed";
          prevSprint.closed_at = nowIso();
        }
      }

      board.active_sprint = sprintId;
      const targetSprint = board.sprints[sprintId];
      if (targetSprint) {
        targetSprint.status = "active";
        targetSprint.started_at = nowIso();
        if (opts.goal) {
          targetSprint.goal = opts.goal;
        }
      }

      let readyCount = 0;
      for (const item of board.items) {
        if (item.sprint === sprintId && item.state === "backlog") {
          item.state = "ready";
          readyCount += 1;
        }
      }

      return {
        text: `sprint ${sprintId} active; ${readyCount} items ready; carried over: ${carriedOver.join(",") || "none"}`,
        data: { sprint: sprintId, readyCount, carriedOver },
      };
    },
    ctx.lockOptions,
  );
}

export async function boardGate(
  ctx: BoardEngineContext,
): Promise<EngineResult<{ passed: boolean; reasons: string[]; milestoneId: string; latestRun?: string }>> {
  const board = await readBoard(ctx.project.boardPath);
  const ms = board.milestone;
  const reasons: string[] = [];

  const milestoneItems = board.items.filter(
    (i) => i.sprint && ms.sprints.includes(i.sprint) && i.type !== "bug",
  );
  const openItems = milestoneItems
    .filter((i) => i.state !== "done")
    .map((i) => i.id);
  if (openItems.length > 0) {
    reasons.push(`open items: ${openItems.join(",")}`);
  }

  const bugs = board.items.filter((i) => i.type === "bug");
  const openBugs = bugs.filter((b) => b.state !== "done").map((b) => b.id);
  if (openBugs.length > 0) {
    reasons.push(
      `open bugs (ALL severities must be fixed+retested): ${openBugs.join(",")}`,
    );
  }

  for (const bug of bugs) {
    if (
      bug.state === "done" &&
      bug.resolution === "accepted_upstream" &&
      !bug.user_signoff
    ) {
      reasons.push(`${bug.id} accepted_upstream without user_signoff`);
    }
  }

  const unverifiedBugs = bugs
    .filter((b) => b.state === "done" && !b.verified_build)
    .map((b) => b.id);
  if (unverifiedBugs.length > 0) {
    reasons.push(`bugs closed without verified_build: ${unverifiedBugs.join(",")}`);
  }

  const latestBuild =
    board.builds.length > 0
      ? board.builds[board.builds.length - 1]?.id
      : undefined;

  const passedFinalRuns = board.testruns.filter(
    (t) => t.suite === ms.final_suite && t.status === "passed",
  );
  const latestFinalRun = passedFinalRuns[passedFinalRuns.length - 1];
  if (!latestFinalRun) {
    reasons.push(`no passed ${ms.final_suite} testrun`);
  } else if (latestBuild && latestFinalRun.build !== latestBuild) {
    reasons.push(
      `last passed ${ms.final_suite} (${latestFinalRun.id}) is on build ${latestFinalRun.build}, latest is ${latestBuild} -> full retest required`,
    );
  }

  if (reasons.length > 0) {
    return {
      text: `GATE ${ms.id}: FAIL\n- ${reasons.join("\n- ")}`,
      data: { passed: false, reasons, milestoneId: ms.id },
    };
  }

  return {
    text: `GATE ${ms.id}: PASS (run ${latestFinalRun?.id ?? "none"}${latestBuild ? `, build ${latestBuild}` : ""})`,
    data: {
      passed: true,
      reasons: [],
      milestoneId: ms.id,
      latestRun: latestFinalRun?.id,
    },
  };
}

export async function boardReport(
  ctx: BoardEngineContext,
  opts?: { sprint?: string; writeFile?: boolean },
): Promise<EngineResult<{ sprint: string; markdown: string; path?: string; doneCount: number; openCount: number }>> {
  const board = await readBoard(ctx.project.boardPath);
  const sp = opts?.sprint ?? board.active_sprint ?? "S1";
  const sprintInfo = board.sprints[sp];
  const items = board.items.filter((i) => i.sprint === sp);
  const done = items.filter((i) => i.state === "done");
  const open = items.filter((i) => i.state !== "done");
  const bugs = board.items.filter((i) => i.type === "bug");
  const openBugs = bugs.filter((b) => b.state !== "done").length;
  const closedBugs = bugs.filter((b) => b.state === "done").length;

  const lines: string[] = [
    `# Sprint ${sp} review`,
    "",
    `Goal: ${sprintInfo?.goal ?? ""}`,
    "",
    `Generated: ${nowIso()}`,
    "",
    `## Done (${done.length})`,
    ...done.map((i) => `- ${i.id} ${i.title}`),
    "",
    `## Not done / carry-over (${open.length})`,
    ...open.map((i) => `- ${i.id} [${i.state}] ${i.title}`),
    "",
    "## Bugs",
    `- open: ${openBugs}, closed: ${closedBugs}`,
    "",
    "## Test runs",
    ...board.testruns
      .slice(-8)
      .map((t) => `- ${t.id} ${t.suite} build=${t.build} ${t.status}`),
    "",
    "## Retro (orchestrator fills: keep / change / try)",
    "- keep:",
    "- change:",
    "- try:",
  ];

  const markdown = lines.join("\n") + "\n";
  let writtenPath: string | undefined;

  if (opts?.writeFile) {
    writtenPath = path.join(ctx.project.root, "docs", "sprints", `${sp}-review.md`);
    await fs.mkdir(path.dirname(writtenPath), { recursive: true });
    await fs.writeFile(writtenPath, markdown, "utf8");
  }

  return {
    text: writtenPath
      ? `wrote ${writtenPath} (${done.length} done, ${open.length} open)`
      : markdown.trimEnd(),
    data: {
      sprint: sp,
      markdown,
      path: writtenPath,
      doneCount: done.length,
      openCount: open.length,
    },
  };
}

export async function testrunStart(
  ctx: BoardEngineContext,
  opts: { suite: string; build?: string; actor?: string; items?: string[] },
): Promise<EngineResult<TestrunRecord>> {
  return withBoardLock(
    ctx.project.boardPath,
    (board) => {
      const suites = board.suites ?? {};
      const checkpoints = suites[opts.suite];
      if (!checkpoints) {
        throw new Error(
          `Unknown suite "${opts.suite}" (available: ${Object.keys(suites).join(", ") || "none"})`,
        );
      }

      const latestBuild =
        board.builds.length > 0
          ? board.builds[board.builds.length - 1]?.id
          : undefined;
      const build =
        opts.build?.trim() ||
        latestBuild ||
        `local-${nowIso().replace(/[-:TZ]/g, "").slice(0, 12)}`;

      let maxRun = 0;
      for (const tr of board.testruns) {
        const m = /^TR-(\d+)$/i.exec(tr.id);
        if (m?.[1]) {
          const n = Number.parseInt(m[1], 10);
          if (n > maxRun) maxRun = n;
        }
      }
      const runId = `TR-${String(maxRun + 1).padStart(3, "0")}`;

      const record: TestrunRecord = {
        id: runId,
        suite: opts.suite,
        build,
        started: nowIso(),
        status: "running",
        results: {},
        bugs: [],
        actor: opts.actor?.trim() || "qa",
      };
      if (opts.items && opts.items.length > 0) {
        record.items = [...opts.items];
      }

      board.testruns.push(record);
      return {
        text: `${runId} started suite=${opts.suite} build=${build} checkpoints=${checkpoints.join(",")}`,
        data: record,
      };
    },
    ctx.lockOptions,
  );
}

export async function testrunRecord(
  ctx: BoardEngineContext,
  opts: {
    runId: string;
    checkpoint: string;
    result: "pass" | "fail" | "skip";
    note?: string;
    bug?: string;
  },
): Promise<EngineResult<TestrunRecord>> {
  return withBoardLock(
    ctx.project.boardPath,
    (board) => {
      const tr = board.testruns.find(
        (t) => t.id.toLowerCase() === opts.runId.toLowerCase(),
      );
      if (!tr || tr.status !== "running") {
        throw new Error(`No running testrun "${opts.runId}"`);
      }
      const suiteCps = board.suites[tr.suite] ?? [];
      if (!suiteCps.includes(opts.checkpoint)) {
        throw new Error(
          `Checkpoint "${opts.checkpoint}" not in suite "${tr.suite}" (${suiteCps.join(", ")})`,
        );
      }

      tr.results[opts.checkpoint] =
        opts.result + (opts.note?.trim() ? `: ${opts.note.trim()}` : "");
      if (opts.bug?.trim()) {
        tr.bugs.push(opts.bug.trim());
      }

      return {
        text: `${tr.id} ${opts.checkpoint}=${opts.result}`,
        data: tr,
      };
    },
    ctx.lockOptions,
  );
}

export async function testrunStep(
  ctx: BoardEngineContext,
  opts: {
    runId: string;
    checkpoint: string;
    stepIndex: number | string;
    result: "pass" | "fail" | "skip";
    note?: string;
  },
): Promise<EngineResult<TestrunRecord>> {
  const idxKey = String(opts.stepIndex);
  return withBoardLock(
    ctx.project.boardPath,
    (board) => {
      const tr = board.testruns.find(
        (t) => t.id.toLowerCase() === opts.runId.toLowerCase(),
      );
      if (!tr || tr.status !== "running") {
        throw new Error(`No running testrun "${opts.runId}"`);
      }
      const suiteCps = board.suites[tr.suite] ?? [];
      if (!suiteCps.includes(opts.checkpoint)) {
        throw new Error(
          `Checkpoint "${opts.checkpoint}" not in suite "${tr.suite}"`,
        );
      }
      if (!tr.step_results) {
        tr.step_results = {};
      }
      if (!tr.step_results[opts.checkpoint]) {
        tr.step_results[opts.checkpoint] = {};
      }
      const cpSteps = tr.step_results[opts.checkpoint];
      if (cpSteps) {
        cpSteps[idxKey] =
          opts.result + (opts.note?.trim() ? `: ${opts.note.trim()}` : "");
      }
      return {
        text: `${tr.id} ${opts.checkpoint} step ${idxKey}=${opts.result}`,
        data: tr,
      };
    },
    ctx.lockOptions,
  );
}

export async function testrunClose(
  ctx: BoardEngineContext,
  opts: { runId: string },
): Promise<
  EngineResult<{
    testrun: TestrunRecord;
    missing: string[];
    failed: string[];
  }>
> {
  return withBoardLock(
    ctx.project.boardPath,
    (board) => {
      const tr = board.testruns.find(
        (t) => t.id.toLowerCase() === opts.runId.toLowerCase(),
      );
      if (!tr) {
        throw new Error(`Unknown testrun "${opts.runId}"`);
      }
      const cps = board.suites[tr.suite] ?? [];
      const missing = cps.filter((cp) => !(cp in tr.results));
      const failed = Object.entries(tr.results)
        .filter(([, val]) => !val.toLowerCase().startsWith("pass"))
        .map(([cp]) => cp);

      tr.status = missing.length === 0 && failed.length === 0 ? "passed" : "failed";
      tr.closed = nowIso();

      return {
        text: `${tr.id} ${tr.status} missing=${missing.join(",") || "-"} failed=${failed.join(",") || "-"} bugs=${tr.bugs.join(",") || "-"}`,
        data: { testrun: tr, missing, failed },
      };
    },
    ctx.lockOptions,
  );
}

export async function testrunList(
  ctx: BoardEngineContext,
  opts?: { limit?: number; suite?: string; status?: "running" | "passed" | "failed" },
): Promise<EngineResult<TestrunRecord[]>> {
  const board = await readBoard(ctx.project.boardPath);
  let runs = [...board.testruns];
  if (opts?.suite) {
    runs = runs.filter((r) => r.suite === opts.suite);
  }
  if (opts?.status) {
    runs = runs.filter((r) => r.status === opts.status);
  }
  const limit = opts?.limit ?? 15;
  const sliced = runs.slice(-limit);
  const text =
    sliced.length === 0
      ? "no testruns"
      : sliced
          .map(
            (r) =>
              `${r.id} [${r.status}] suite=${r.suite} build=${r.build} checkpoints=${Object.keys(r.results).join(",") || "-"}`,
          )
          .join("\n");

  return { text, data: sliced };
}
