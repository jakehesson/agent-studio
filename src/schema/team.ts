import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  ModelRoutingPolicySchema,
  ModelTierSchema,
} from "./model-index.js";

export const IdeTargetSchema = z.enum([
  "antigravity",
  "claude-code",
  "copilot-vscode",
]);
export type IdeTarget = z.infer<typeof IdeTargetSchema>;

export const RoleTypeSchema = z.enum([
  "orchestrator",
  "specialist",
  "qa",
  "setup",
]);
export type RoleType = z.infer<typeof RoleTypeSchema>;

export const CapabilitySchema = z.enum([
  "read",
  "search",
  "edit",
  "write_docs",
  "edit_tests",
  "shell",
  "delegate",
  "ask_user",
  "mcp_board",
  "mcp_testrun",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const CheckpointDefinitionSchema = z
  .object({
    title: z.string().min(1),
    command: z.string().min(1).optional(),
    steps: z.array(z.string()).default([]),
    pass: z.array(z.string()).default([]),
    fail: z.array(z.string()).default([]),
  })
  .passthrough();
export type CheckpointDefinition = z.infer<typeof CheckpointDefinitionSchema>;

export const WorkflowEnforcementSchema = z
  .object({
    orchestratorReadOnly: z.boolean().default(true),
    qaGateRequired: z.boolean().default(true),
    blockDirectBoardEdits: z.boolean().default(true),
  })
  .passthrough();
export type WorkflowEnforcement = z.infer<typeof WorkflowEnforcementSchema>;

export const IdeModelOverrideSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z
    .object({
      primary: z.string().min(1).optional(),
      fallback: z.array(z.string().min(1)).optional(),
      omit: z.boolean().optional(),
      copilotPolicy: z.enum(["preferred", "required"]).optional(),
    })
    .passthrough(),
]);
export type IdeModelOverride = z.infer<typeof IdeModelOverrideSchema>;

export const WorkflowModelRoutingSchema = z
  .object({
    policy: ModelRoutingPolicySchema.default("prefer-fallback"),
    respectBuiltInOrchestrators: z.boolean().default(true),
    allowSubagentModelHints: z.boolean().default(true),
    copilotHandoffModels: z.boolean().default(false),
    idePolicies: z
      .object({
        antigravity: ModelRoutingPolicySchema.optional(),
        "claude-code": ModelRoutingPolicySchema.optional(),
        "copilot-vscode": ModelRoutingPolicySchema.optional(),
      })
      .optional(),
  })
  .passthrough();
export type WorkflowModelRouting = z.infer<typeof WorkflowModelRoutingSchema>;

export const WorkflowConfigSchema = z
  .object({
    boardPath: z.string().min(1).default("pipeline/board.json"),
    stages: z
      .array(z.string().min(1))
      .min(1)
      .default(["ready", "design", "dev", "test", "done"]),
    enforcement: WorkflowEnforcementSchema.default({
      orchestratorReadOnly: true,
      qaGateRequired: true,
      blockDirectBoardEdits: true,
    }),
    suites: z.record(z.string(), z.array(z.string())).default({
      smoke: ["CP0", "CP1"],
      full: ["CP0", "CP1", "CP2"],
    }),
    checkpoints: z.record(z.string(), CheckpointDefinitionSchema).default({}),
    modelRouting: WorkflowModelRoutingSchema.optional(),
  })
  .passthrough();
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

export const RosterEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    roleType: RoleTypeSchema,
    boardRole: z.string().min(1),
    promptFile: z.string().min(1),
    capabilities: z.array(CapabilitySchema).default([]),
    handoffs: z.array(z.string().min(1)).optional(),
    description: z.string().optional(),
    modelTier: ModelTierSchema.optional(),
    modelPolicy: ModelRoutingPolicySchema.optional(),
    models: z
      .object({
        antigravity: IdeModelOverrideSchema.optional(),
        "claude-code": IdeModelOverrideSchema.optional(),
        "copilot-vscode": IdeModelOverrideSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const TeamProjectSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    mockupsDirs: z.array(z.string()).default([]),
  })
  .passthrough();
export type TeamProject = z.infer<typeof TeamProjectSchema>;

export const TeamManifestSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    project: TeamProjectSchema,
    targets: z
      .array(IdeTargetSchema)
      .min(1)
      .default(["antigravity", "claude-code", "copilot-vscode"]),
    workflow: WorkflowConfigSchema.default({
      boardPath: "pipeline/board.json",
      stages: ["ready", "design", "dev", "test", "done"],
      enforcement: {
        orchestratorReadOnly: true,
        qaGateRequired: true,
        blockDirectBoardEdits: true,
      },
      suites: {
        smoke: ["CP0", "CP1"],
        full: ["CP0", "CP1", "CP2"],
      },
      checkpoints: {},
    }),
    roster: z.array(RosterEntrySchema).min(1),
    skills: z.array(z.string().min(1)).default([]),
  })
  .passthrough();
export type TeamManifest = z.infer<typeof TeamManifestSchema>;

export function parseTeamYaml(yamlText: string): TeamManifest {
  const raw: unknown = parseYaml(yamlText);
  return TeamManifestSchema.parse(raw);
}

export function serializeTeamYaml(manifest: TeamManifest): string {
  const validated = TeamManifestSchema.parse(manifest);
  return stringifyYaml(validated);
}
