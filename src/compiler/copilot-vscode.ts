import path from "node:path";
import {
  resolveRoleModel,
  type ResolvedRoleModel,
} from "../models/resolve.js";
import {
  DEFAULT_MODEL_INDEX,
  type ModelIndex,
} from "../schema/model-index.js";
import type { TeamManifest } from "../schema/team.js";
import {
  buildCopilotHandoffs,
  mapCapabilitiesToCopilotVsCode,
  resolveEffectiveCapabilities,
} from "./capabilities.js";
import {
  buildPortableHookCommand,
  buildPortableMcpSpec,
} from "./launcher.js";
import { type ExpectedFile, wrapGeneratedMarkdown } from "./merge.js";
import {
  loadManifestSkills,
  readRolePrompt,
  renderSharedTeamRules,
  serializeFrontmatter,
} from "./shared.js";

export const COPILOT_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

export function buildCopilotHooksConfig(): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const eventName of COPILOT_HOOK_EVENTS) {
    hooks[eventName] = [
      {
        type: "command",
        command: buildPortableHookCommand("copilot-vscode", eventName),
        timeoutSec: 5,
      },
    ];
  }
  return {
    version: 1,
    managedBy: "agent-studio",
    hooks,
  };
}

export function compileCopilotVsCode(
  projectRoot: string,
  manifest: TeamManifest,
  modelIndex: ModelIndex = DEFAULT_MODEL_INDEX,
): ExpectedFile[] {
  const root = path.resolve(projectRoot);
  const files: ExpectedFile[] = [];

  const resolvedByRoleId = new Map<string, ResolvedRoleModel>();
  for (const role of manifest.roster) {
    resolvedByRoleId.set(
      role.id,
      resolveRoleModel(manifest, role, "copilot-vscode", modelIndex),
    );
  }
  const includeHandoffModels = Boolean(
    manifest.workflow.modelRouting?.copilotHandoffModels,
  );

  for (const role of manifest.roster) {
    const effectiveCaps = resolveEffectiveCapabilities(
      role,
      manifest.workflow.enforcement,
    );
    const tools = mapCapabilitiesToCopilotVsCode(effectiveCaps);
    const handoffs = buildCopilotHandoffs(role, manifest.roster, {
      includeModels: includeHandoffModels,
      resolvedByRoleId,
    });
    const resolvedModel = resolvedByRoleId.get(role.id)!;

    const fmObj: Record<string, unknown> = {
      name: role.name,
      description: role.description ?? `${role.name} (${role.boardRole})`,
      ...( !resolvedModel.omit && resolvedModel.frontmatterModel !== undefined
        ? { model: resolvedModel.frontmatterModel }
        : {}),
      ...( !resolvedModel.omit && resolvedModel.copilotPolicy
        ? { "model-policy": resolvedModel.copilotPolicy }
        : {}),
      tools,
    };
    if (handoffs.length > 0) {
      fmObj.handoffs = handoffs;
    }

    const promptBody = readRolePrompt(root, role);
    files.push({
      relPath: `.github/agents/${role.id}.agent.md`,
      ide: "copilot-vscode",
      kind: "generated",
      content: wrapGeneratedMarkdown(promptBody, serializeFrontmatter(fmObj)),
    });
  }

  for (const skill of loadManifestSkills(root, manifest)) {
    const fm =
      skill.frontmatter ??
      serializeFrontmatter({
        name: skill.id,
        description: `Agent Studio skill: ${skill.id}`,
      });
    files.push({
      relPath: `.github/skills/${skill.id}/SKILL.md`,
      ide: "copilot-vscode",
      kind: "generated",
      content: wrapGeneratedMarkdown(skill.body, fm),
    });
  }

  files.push({
    relPath: ".github/copilot-instructions.md",
    ide: "copilot-vscode",
    kind: "managed-markdown",
    blockContent: renderSharedTeamRules(manifest, modelIndex),
  });

  files.push({
    relPath: ".vscode/mcp.json",
    ide: "copilot-vscode",
    kind: "json-merge",
    patch: {
      servers: {
        "agent-studio": {
          type: "stdio",
          ...buildPortableMcpSpec(),
        },
      },
    },
  });

  files.push({
    relPath: ".github/hooks/agent-studio.json",
    ide: "copilot-vscode",
    kind: "generated",
    content: JSON.stringify(buildCopilotHooksConfig(), null, 2) + "\n",
  });

  return files;
}
