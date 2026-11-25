import path from "node:path";
import { resolveRoleModel } from "../models/resolve.js";
import {
  DEFAULT_MODEL_INDEX,
  type ModelIndex,
} from "../schema/model-index.js";
import type { TeamManifest } from "../schema/team.js";
import {
  mapCapabilitiesToAntigravity,
  resolveEffectiveCapabilities,
} from "./capabilities.js";
import { buildPortableMcpSpec } from "./launcher.js";
import { type ExpectedFile, wrapGeneratedMarkdown } from "./merge.js";
import {
  loadManifestSkills,
  readRolePrompt,
  renderSharedTeamRules,
  serializeFrontmatter,
} from "./shared.js";

export function getAntigravityPluginRelDir(projectId: string): string {
  return `.agents/plugins/${projectId}-team`;
}

export function compileAntigravity(
  projectRoot: string,
  manifest: TeamManifest,
  modelIndex: ModelIndex = DEFAULT_MODEL_INDEX,
): ExpectedFile[] {
  const root = path.resolve(projectRoot);
  const pluginDir = getAntigravityPluginRelDir(manifest.project.id);
  const files: ExpectedFile[] = [];

  const orchestrator = manifest.roster.find((r) => r.roleType === "orchestrator");
  const qa = manifest.roster.find((r) => r.roleType === "qa");
  const setup = manifest.roster.find((r) => r.roleType === "setup");

  const pluginJson = {
    name: `${manifest.project.id}-team`,
    displayName: `${manifest.project.title} Engineering Team`,
    version: "1.0.0",
    description:
      manifest.project.description ??
      `Scoped multi-agent engineering team for ${manifest.project.title}, managed by agent-studio.`,
    suggestedPrompts: [
      orchestrator
        ? `Use ${orchestrator.id} to inspect the ${manifest.project.id} Agile board and plan the next sprint item`
        : `Inspect the ${manifest.project.id} Agile board`,
      qa
        ? `Run QA verification checkpoints with ${qa.id}`
        : `Run QA checkpoints for ${manifest.project.id}`,
      setup
        ? `Use ${setup.id} to customize team roles or sync IDE configs`
        : `Sync IDE configs for ${manifest.project.id}`,
    ],
  };

  files.push({
    relPath: `${pluginDir}/plugin.json`,
    ide: "antigravity",
    kind: "generated",
    content: JSON.stringify(pluginJson, null, 2) + "\n",
  });

  const mcpConfig = {
    mcpServers: {
      "agent-studio": buildPortableMcpSpec(),
    },
  };

  files.push({
    relPath: `${pluginDir}/mcp_config.json`,
    ide: "antigravity",
    kind: "generated",
    content: JSON.stringify(mcpConfig, null, 2) + "\n",
  });

  files.push({
    relPath: `${pluginDir}/rules/AGENTS.md`,
    ide: "antigravity",
    kind: "generated",
    content: wrapGeneratedMarkdown(renderSharedTeamRules(manifest, modelIndex)),
  });

  for (const role of manifest.roster) {
    const effectiveCaps = resolveEffectiveCapabilities(
      role,
      manifest.workflow.enforcement,
    );
    const readOnly =
      manifest.workflow.enforcement.orchestratorReadOnly &&
      role.roleType === "orchestrator";
    const mapped = mapCapabilitiesToAntigravity(effectiveCaps, { readOnly });
    const resolvedModel = resolveRoleModel(
      manifest,
      role,
      "antigravity",
      modelIndex,
    );
    const fmObj: Record<string, unknown> = {
      name: role.id,
      description: role.description ?? `${role.name} (${role.boardRole})`,
      ...( !resolvedModel.omit && resolvedModel.frontmatterModel !== undefined
        ? { model: resolvedModel.frontmatterModel }
        : {}),
      mainAgent: role.roleType === "orchestrator" || role.roleType === "setup",
      subagent: true,
      inheritCustomizations: true,
      inheritMcp: mapped.inheritMcp,
      tools: mapped.tools,
    };
    const promptBody = readRolePrompt(root, role);
    files.push({
      relPath: `${pluginDir}/agents/${role.id}.md`,
      ide: "antigravity",
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
      relPath: `${pluginDir}/skills/${skill.id}/SKILL.md`,
      ide: "antigravity",
      kind: "generated",
      content: wrapGeneratedMarkdown(skill.body, fm),
    });
  }

  return files;
}
