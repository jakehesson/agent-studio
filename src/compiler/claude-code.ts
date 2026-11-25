import path from "node:path";
import { resolveRoleModel } from "../models/resolve.js";
import {
  DEFAULT_MODEL_INDEX,
  type ModelIndex,
} from "../schema/model-index.js";
import type { TeamManifest } from "../schema/team.js";
import {
  mapCapabilitiesToClaudeCode,
  resolveEffectiveCapabilities,
} from "./capabilities.js";
import {
  buildPortableHookCommand,
  buildPortableMcpSpec,
} from "./launcher.js";
import {
  type ClaudeHookRule,
  type ExpectedFile,
  wrapGeneratedMarkdown,
} from "./merge.js";
import {
  loadManifestSkills,
  readRolePrompt,
  renderSharedTeamRules,
  serializeFrontmatter,
} from "./shared.js";

export const CLAUDE_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

export function buildClaudeCodeHooks(): Record<string, ClaudeHookRule[]> {
  const hooks: Record<string, ClaudeHookRule[]> = {};
  for (const eventName of CLAUDE_HOOK_EVENTS) {
    const rule: ClaudeHookRule = {
      hooks: [
        {
          type: "command",
          command: buildPortableHookCommand("claude-code", eventName),
          timeout: 5,
        },
      ],
    };
    if (eventName === "PreToolUse" || eventName === "PostToolUse") {
      rule.matcher = "*";
    }
    hooks[eventName] = [rule];
  }
  return hooks;
}

export function compileClaudeCode(
  projectRoot: string,
  manifest: TeamManifest,
  modelIndex: ModelIndex = DEFAULT_MODEL_INDEX,
): ExpectedFile[] {
  const root = path.resolve(projectRoot);
  const files: ExpectedFile[] = [];

  for (const role of manifest.roster) {
    const effectiveCaps = resolveEffectiveCapabilities(
      role,
      manifest.workflow.enforcement,
    );
    const tools = mapCapabilitiesToClaudeCode(effectiveCaps);
    const resolvedModel = resolveRoleModel(
      manifest,
      role,
      "claude-code",
      modelIndex,
    );
    const fmObj: Record<string, unknown> = {
      name: role.id,
      description: role.description ?? `${role.name} (${role.boardRole})`,
      ...( !resolvedModel.omit && resolvedModel.frontmatterModel !== undefined
        ? { model: resolvedModel.frontmatterModel }
        : {}),
      tools,
    };
    const promptBody = readRolePrompt(root, role);
    files.push({
      relPath: `.claude/agents/${role.id}.md`,
      ide: "claude-code",
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
      relPath: `.claude/skills/${skill.id}/SKILL.md`,
      ide: "claude-code",
      kind: "generated",
      content: wrapGeneratedMarkdown(skill.body, fm),
    });
  }

  files.push({
    relPath: "CLAUDE.md",
    ide: "claude-code",
    kind: "managed-markdown",
    blockContent: renderSharedTeamRules(manifest, modelIndex),
  });

  files.push({
    relPath: ".mcp.json",
    ide: "claude-code",
    kind: "json-merge",
    patch: {
      mcpServers: {
        "agent-studio": buildPortableMcpSpec(),
      },
    },
  });

  files.push({
    relPath: ".claude/settings.json",
    ide: "claude-code",
    kind: "json-merge",
    patch: {
      hooks: buildClaudeCodeHooks(),
    },
  });

  return files;
}
