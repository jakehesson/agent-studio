import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IdeTarget } from "../schema/team.js";
import { renderTeamSetupPrompt } from "../templates/prompts.js";
import { getDefaultSkills } from "../templates/skills.js";
import {
  mapCapabilitiesToAntigravity,
  mapCapabilitiesToClaudeCode,
  mapCapabilitiesToCopilotVsCode,
} from "./capabilities.js";
import { renderCopilotLearnPrompt } from "./copilot-vscode.js";
import { wrapGeneratedMarkdown } from "./merge.js";
import { serializeFrontmatter, splitFrontmatter } from "./shared.js";

export interface GlobalInstallOptions {
  ides?: IdeTarget[];
  homeDir?: string;
  vscodeUserDir?: string;
}

export interface GlobalInstallResult {
  homeDir: string;
  targets: IdeTarget[];
  installedFiles: string[];
}

export function resolveEffectiveHomeDir(explicitHome?: string): {
  homeDir: string;
  isOverridden: boolean;
} {
  if (explicitHome?.trim()) {
    return { homeDir: path.resolve(explicitHome.trim()), isOverridden: true };
  }
  const envHome = process.env.HOME?.trim();
  if (envHome) {
    return { homeDir: path.resolve(envHome), isOverridden: true };
  }
  const studioHome = process.env.AGENT_STUDIO_HOME?.trim();
  if (studioHome) {
    const resolved = path.resolve(studioHome);
    const base = path.basename(resolved);
    const derived =
      base === ".agent-studio" ? path.dirname(resolved) : resolved;
    return { homeDir: derived, isOverridden: true };
  }
  return { homeDir: os.homedir(), isOverridden: false };
}

export function resolveVsCodeUserDir(
  homeDir: string,
  isOverridden: boolean,
  explicitVsCodeUserDir?: string,
): string {
  if (explicitVsCodeUserDir?.trim()) {
    return path.resolve(explicitVsCodeUserDir.trim());
  }
  const envDir = process.env.VSCODE_USER_DIR?.trim();
  if (envDir) {
    return path.resolve(envDir);
  }
  if (process.platform === "win32") {
    if (!isOverridden && process.env.APPDATA?.trim()) {
      return path.join(process.env.APPDATA.trim(), "Code", "User");
    }
    return path.join(homeDir, "AppData", "Roaming", "Code", "User");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Code", "User");
  }
  return path.join(homeDir, ".config", "Code", "User");
}

function writeFileEnsureDir(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

export function installGlobalSetupAgent(
  options?: GlobalInstallOptions,
): GlobalInstallResult {
  const { homeDir, isOverridden } = resolveEffectiveHomeDir(options?.homeDir);
  const targets: IdeTarget[] =
    options?.ides && options.ides.length > 0
      ? options.ides
      : ["antigravity", "claude-code", "copilot-vscode"];

  const installedFiles: string[] = [];
  const setupPrompt = renderTeamSetupPrompt();
  const defaultSkills = getDefaultSkills();
  const setupSkill = defaultSkills.find((s) => s.id === "team-setup");
  const skillParts = setupSkill
    ? splitFrontmatter(setupSkill.content)
    : {
        frontmatter: serializeFrontmatter({
          name: "team-setup",
          description: "Onboard any repository to Agent Studio.",
        }),
        body: "# Team Setup Skill\n",
      };
  const learnSkill = defaultSkills.find((s) => s.id === "learn");
  const learnParts = learnSkill
    ? splitFrontmatter(learnSkill.content)
    : {
        frontmatter: serializeFrontmatter({
          name: "learn",
          description:
            "Capture durable session learnings (user corrections, bug root causes, invariants, repeated workflows) into AGENTS.md, .agent-team/ agents, or quickref skills and re-sync IDEs.",
          "argument-hint": "[optional focus]",
        }),
        body: "# Session Learning & Knowledge Capture (`/learn`)\n",
      };

  const setupCapabilities = [
    "read",
    "search",
    "edit",
    "shell",
    "ask_user",
  ] as const;

  if (targets.includes("antigravity")) {
    const pluginRoot = path.join(
      homeDir,
      ".gemini",
      "config",
      "plugins",
      "agent-studio",
    );
    const agyTools = mapCapabilitiesToAntigravity([...setupCapabilities]);

    const pluginJson = {
      name: "agent-studio",
      displayName: "Agent Studio Global Bootstrapper",
      version: "1.0.0",
      description:
        "Global cross-project Agent Studio onboarding agent (team-setup) and setup skill.",
      suggestedPrompts: [
        "Use team-setup to onboard this repository to Agent Studio",
      ],
    };

    installedFiles.push(
      writeFileEnsureDir(
        path.join(pluginRoot, "plugin.json"),
        JSON.stringify(pluginJson, null, 2) + "\n",
      ),
    );

    const agyFm = serializeFrontmatter({
      name: "team-setup",
      description:
        "Cross-IDE AI Setup Agent that inspects any repository, tailors .agent-team/, compiles IDE adapters, and verifies health.",
      model: "inherit",
      mainAgent: true,
      subagent: true,
      inheritCustomizations: true,
      inheritMcp: agyTools.inheritMcp,
      tools: agyTools.tools,
    });
    installedFiles.push(
      writeFileEnsureDir(
        path.join(pluginRoot, "agents", "team-setup.md"),
        wrapGeneratedMarkdown(setupPrompt, agyFm),
      ),
    );

    installedFiles.push(
      writeFileEnsureDir(
        path.join(pluginRoot, "skills", "team-setup", "SKILL.md"),
        wrapGeneratedMarkdown(skillParts.body, skillParts.frontmatter),
      ),
    );

    installedFiles.push(
      writeFileEnsureDir(
        path.join(pluginRoot, "skills", "learn", "SKILL.md"),
        wrapGeneratedMarkdown(learnParts.body, learnParts.frontmatter),
      ),
    );
  }

  if (targets.includes("claude-code")) {
    const claudeDir = path.join(homeDir, ".claude");
    const ccTools = mapCapabilitiesToClaudeCode([...setupCapabilities]);
    const ccFm = serializeFrontmatter({
      name: "team-setup",
      description:
        "Cross-IDE AI Setup Agent that inspects any repository, tailors .agent-team/, compiles IDE adapters, and verifies health.",
      model: "inherit",
      tools: ccTools,
    });
    installedFiles.push(
      writeFileEnsureDir(
        path.join(claudeDir, "agents", "team-setup.md"),
        wrapGeneratedMarkdown(setupPrompt, ccFm),
      ),
    );
    installedFiles.push(
      writeFileEnsureDir(
        path.join(claudeDir, "skills", "team-setup", "SKILL.md"),
        wrapGeneratedMarkdown(skillParts.body, skillParts.frontmatter),
      ),
    );
    installedFiles.push(
      writeFileEnsureDir(
        path.join(claudeDir, "skills", "learn", "SKILL.md"),
        wrapGeneratedMarkdown(learnParts.body, learnParts.frontmatter),
      ),
    );
  }

  if (targets.includes("copilot-vscode")) {
    const vscodeUserDir = resolveVsCodeUserDir(
      homeDir,
      isOverridden,
      options?.vscodeUserDir,
    );
    const promptsDir = path.join(vscodeUserDir, "prompts");
    const copilotTools = mapCapabilitiesToCopilotVsCode([...setupCapabilities]);
    const copilotFm = serializeFrontmatter({
      name: "Team Setup Agent",
      description:
        "Cross-IDE AI Setup Agent that inspects any repository, tailors .agent-team/, compiles IDE adapters, and verifies health.",
      tools: copilotTools,
    });
    installedFiles.push(
      writeFileEnsureDir(
        path.join(promptsDir, "team-setup.agent.md"),
        wrapGeneratedMarkdown(setupPrompt, copilotFm),
      ),
    );
    installedFiles.push(
      writeFileEnsureDir(
        path.join(promptsDir, "team-setup.instructions.md"),
        wrapGeneratedMarkdown(
          skillParts.body,
          serializeFrontmatter({
            name: "team-setup",
            description:
              "Global Agent Studio team onboarding workflow and CLI rules.",
          }),
        ),
      ),
    );
    installedFiles.push(
      writeFileEnsureDir(
        path.join(promptsDir, "learn.prompt.md"),
        renderCopilotLearnPrompt(learnParts.body, learnParts.frontmatter),
      ),
    );
  }

  return {
    homeDir,
    targets,
    installedFiles,
  };
}
