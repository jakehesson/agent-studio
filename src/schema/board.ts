import { z } from "zod";

export const BOARD_STATES = [
  "backlog",
  "ready",
  "design",
  "dev",
  "test",
  "done",
  "blocked",
] as const;

export const BoardStateSchema = z.enum(BOARD_STATES);
export type BoardState = z.infer<typeof BoardStateSchema>;

export const BOARD_ITEM_TYPES = ["spike", "story", "task", "bug"] as const;
export const BoardItemTypeSchema = z.enum(BOARD_ITEM_TYPES);
export type BoardItemType = z.infer<typeof BoardItemTypeSchema>;

export const BUG_SEVERITIES = ["S1", "S2", "S3", "S4"] as const;
export const BugSeveritySchema = z.enum(BUG_SEVERITIES);
export type BugSeverity = z.infer<typeof BugSeveritySchema>;

export const BUG_RESOLUTIONS = [
  "fixed",
  "accepted_upstream",
  "duplicate",
  "not_a_bug",
] as const;
export const BugResolutionSchema = z.enum(BUG_RESOLUTIONS);
export type BugResolution = z.infer<typeof BugResolutionSchema>;

export const HANDOFF_STATUSES = [
  "pending_handoff",
  "pending_split",
  "resumed",
  "cleared",
] as const;
export const HandoffStatusSchema = z.enum(HANDOFF_STATUSES);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const SplitProposalSchema = z
  .object({
    title: z.string().min(1),
    role: z.string().min(1),
    ac: z.array(z.string()).default([]),
    deps: z.array(z.string()).optional(),
    rationale: z.string().optional(),
  })
  .passthrough();
export type SplitProposal = z.infer<typeof SplitProposalSchema>;

export const ContextHandoffSchema = z
  .object({
    status: HandoffStatusSchema,
    kind: z.enum(["fresh_context", "task_split"]),
    created_at: z.string().min(1),
    actor: z.string().min(1),
    session_id: z.string().optional(),
    agent_id: z.string().optional(),
    context_percent: z.number().min(0).max(100).optional(),
    context_tokens: z.number().int().nonnegative().optional(),
    context_window: z.number().int().positive().optional(),
    objective: z.string().min(1).optional(),
    summary: z.string().min(1),
    evidence: z.array(z.string()).optional(),
    decisions: z.array(z.string()).optional(),
    assumptions: z.array(z.string()).optional(),
    unresolved_issues: z.array(z.string()).optional(),
    modified_files: z.array(z.string()).default([]),
    verified_checks: z.array(z.string()).optional(),
    remaining_work: z.array(z.string()).default([]),
    continuation_brief: z.string().min(1),
    split_proposals: z.array(SplitProposalSchema).optional(),
  })
  .passthrough();
export type ContextHandoff = z.infer<typeof ContextHandoffSchema>;

export const MilestoneSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    sprints: z.array(z.string()).default([]),
    final_suite: z.string().min(1).default("full"),
  })
  .passthrough();
export type Milestone = z.infer<typeof MilestoneSchema>;

export const SprintInfoSchema = z
  .object({
    goal: z.string().optional(),
    status: z.string().optional(),
    started_at: z.string().nullable().optional(),
    closed_at: z.string().nullable().optional(),
  })
  .passthrough();
export type SprintInfo = z.infer<typeof SprintInfoSchema>;

export const BoardItemSchema = z
  .object({
    id: z.string().min(1),
    type: BoardItemTypeSchema,
    role: z.string().min(1),
    sprint: z.string().nullable().optional(),
    state: BoardStateSchema,
    title: z.string().min(1),
    ac: z.array(z.string()).optional(),
    deps: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
    owner: z.string().nullable().optional(),
    severity: BugSeveritySchema.nullable().optional(),
    points: z.number().nullable().optional(),
    resolution: z.union([BugResolutionSchema, z.string()]).nullable().optional(),
    found_in: z.string().nullable().optional(),
    fixed_in: z.string().nullable().optional(),
    verified_build: z.string().nullable().optional(),
    user_signoff: z.union([z.string(), z.boolean()]).nullable().optional(),
    blocked_from: BoardStateSchema.nullable().optional(),
    evidence: z.array(z.string()).optional(),
    suite: z.string().optional(),
    required_checkpoints: z.array(z.string()).optional(),
    created_at: z.string().optional(),
    reopened_at: z.string().optional(),
    handoff: ContextHandoffSchema.nullable().optional(),
    split_from: z.string().min(1).nullable().optional(),
  })
  .passthrough();
export type BoardItem = z.infer<typeof BoardItemSchema>;

export const BuildRecordSchema = z
  .object({
    id: z.string().min(1),
    profile: z.string().optional(),
    at: z.string().optional(),
    files: z.unknown().optional(),
  })
  .passthrough();
export type BuildRecord = z.infer<typeof BuildRecordSchema>;

export const TestrunStatusSchema = z.enum(["running", "passed", "failed"]);
export type TestrunStatus = z.infer<typeof TestrunStatusSchema>;

export const TestrunRecordSchema = z
  .object({
    id: z.string().min(1),
    suite: z.string().min(1),
    build: z.string().min(1),
    started: z.string().min(1),
    closed: z.string().optional(),
    status: TestrunStatusSchema,
    results: z.record(z.string(), z.string()).default({}),
    step_results: z
      .record(z.string(), z.record(z.string(), z.string()))
      .optional(),
    bugs: z.array(z.string()).default([]),
    actor: z.string().optional(),
    items: z.array(z.string()).optional(),
  })
  .passthrough();
export type TestrunRecord = z.infer<typeof TestrunRecordSchema>;

export const BoardSchema = z
  .object({
    project: z.string().min(1).optional(),
    milestone: MilestoneSchema,
    active_sprint: z.string().nullable().optional(),
    sprints: z.record(z.string(), SprintInfoSchema).default({}),
    suites: z.record(z.string(), z.array(z.string())).default({}),
    items: z.array(BoardItemSchema).default([]),
    builds: z.array(BuildRecordSchema).default([]),
    testruns: z.array(TestrunRecordSchema).default([]),
    bugs: z.array(z.unknown()).optional(),
    kv: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type Board = z.infer<typeof BoardSchema>;

export function parseBoardJson(raw: unknown): Board {
  return BoardSchema.parse(raw);
}
