import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../compiler/merge.js";
import { createWorkspaceDefaultModelIndex } from "../models/defaults.js";
import {
  TeamManifestSchema,
  serializeTeamYaml,
  type IdeTarget,
  type TeamManifest,
} from "../schema/team.js";
import {
  normalizeUpgradeStateKey,
  resolveAgentStudioVersion,
  serializeUpgradeState,
  type ManagedFileRecord,
} from "../schema/upgrade-state.js";
import { detectRepoStack, type DetectedRepoInfo } from "./detect.js";
import {
  renderArchitectPrompt,
  renderBackendEngineerPrompt,
  renderCodeReviewerPrompt,
  renderFrontendEngineerPrompt,
  renderOrchestratorPrompt,
  renderQaValidatorPrompt,
  renderTeamSetupPrompt,
  renderUxDesignerPrompt,
} from "./prompts.js";
import { getDefaultSkills } from "./skills.js";

export interface BuildManifestOptions {
  projectId?: string;
  projectTitle?: string;
  description?: string;
  targets?: IdeTarget[];
  boardPath?: string;
}

export interface ScaffoldTeamOptions extends BuildManifestOptions {
  force?: boolean;
}

export interface ScaffoldTeamResult {
  manifest: TeamManifest;
  detected: DetectedRepoInfo;
  created: string[];
  skipped: string[];
}

export function buildDefaultTeamManifest(
  projectRoot: string,
  options?: BuildManifestOptions,
): { manifest: TeamManifest; detected: DetectedRepoInfo } {
  const detected = detectRepoStack(projectRoot);
  const targets: IdeTarget[] =
    options?.targets && options.targets.length > 0
      ? options.targets
      : ["antigravity", "claude-code", "copilot-vscode"];

  const manifest = TeamManifestSchema.parse({
    schemaVersion: 1,
    project: {
      id: options?.projectId ?? detected.projectId,
      title: options?.projectTitle ?? detected.projectTitle,
      description: options?.description ?? detected.description,
      mockupsDirs: detected.mockupsDirs,
    },
    targets,
    workflow: {
      boardPath: options?.boardPath ?? "pipeline/board.json",
      stages: ["ready", "design", "dev", "test", "done"],
      enforcement: {
        orchestratorReadOnly: true,
        qaGateRequired: true,
        blockDirectBoardEdits: true,
      },
      humanQuestions: "studio-mcp",
      suites: detected.suites,
      checkpoints: detected.checkpoints,
      modelRouting: {
        policy: "prefer-fallback",
        respectBuiltInOrchestrators: true,
        allowSubagentModelHints: true,
        copilotHandoffModels: false,
      },
    },
    roster: [
      {
        id: "orchestrator",
        name: "Team Orchestrator",
        roleType: "orchestrator",
        boardRole: "orchestrator",
        promptFile: "agents/orchestrator.md",
        modelTier: "balanced",
        description:
          "Strict manager and dispatcher overseeing ready -> design -> dev -> test -> done and enforcing the QA gate via agent-studio MCP.",
        capabilities: ["read", "search", "delegate", "ask_user", "mcp_board"],
        handoffs: [
          "architect",
          "ux-designer",
          "backend-engineer",
          "frontend-engineer",
          "code-reviewer",
          "qa-validator",
        ],
      },
      {
        id: "architect",
        name: "System Architect",
        roleType: "specialist",
        boardRole: "design",
        promptFile: "agents/architect.md",
        modelTier: "reasoning",
        description:
          "System architecture, technical specifications, data schemas, and API contracts.",
        capabilities: ["read", "search", "write_docs", "mcp_board"],
      },
      {
        id: "ux-designer",
        name: "UX Engineer & Designer",
        roleType: "specialist",
        boardRole: "ux",
        promptFile: "agents/ux-designer.md",
        modelTier: "reasoning",
        description:
          "Usability engineering, interaction design, layout/overflow audits, WCAG AA accessibility, and Galaxy Z Fold 7 three-tier responsive ergonomics partnering with frontend-engineer.",
        capabilities: ["read", "search", "write_docs", "mcp_board"],
      },
      {
        id: "backend-engineer",
        name: "Backend Engineer",
        roleType: "specialist",
        boardRole: "backend",
        promptFile: "agents/backend-engineer.md",
        modelTier: "balanced",
        description:
          "Server, CLI, data layer, and core backend implementation with unit test coverage.",
        capabilities: ["read", "search", "edit", "shell", "mcp_board"],
      },
      {
        id: "frontend-engineer",
        name: "Frontend Engineer",
        roleType: "specialist",
        boardRole: "frontend",
        promptFile: "agents/frontend-engineer.md",
        modelTier: "balanced",
        description:
          "UI, interactive views, visualizations, and responsive styling across mobile, foldable, and desktop.",
        capabilities: ["read", "search", "edit", "shell", "mcp_board"],
      },
      {
        id: "code-reviewer",
        name: "Code Reviewer",
        roleType: "specialist",
        boardRole: "review",
        promptFile: "agents/code-reviewer.md",
        modelTier: "reasoning",
        description:
          "Rigorous code reviewer auditing syntax, security, architecture conformance, performance, concurrency, and test coverage before QA gate sign-off.",
        capabilities: ["read", "search", "shell", "mcp_board"],
      },
      {
        id: "qa-validator",
        name: "QA Validator",
        roleType: "qa",
        boardRole: "qa",
        promptFile: "agents/qa-validator.md",
        modelTier: "balanced",
        description:
          "Automated test suites, formal MCP testruns, bug filing, and test -> done QA gate verification.",
        capabilities: [
          "read",
          "search",
          "edit_tests",
          "shell",
          "mcp_board",
          "mcp_testrun",
        ],
      },
      {
        id: "team-setup",
        name: "Team Setup Agent",
        roleType: "setup",
        boardRole: "ops",
        promptFile: "agents/team-setup.md",
        modelTier: "balanced",
        description:
          "Cross-IDE AI Setup Agent that inspects the repo, tailors .agent-team/, compiles IDE adapters, and verifies health.",
        capabilities: ["read", "search", "edit", "shell", "ask_user"],
      },
    ],
    skills: [
      "skills/agile-board-workflow",
      "skills/architecture-spec",
      "skills/ux-review",
      "skills/code-review",
      "skills/architecture-review",
      "skills/qa-validation",
      "skills/token-efficiency",
      "skills/model-routing",
      "skills/team-setup",
      "skills/learn",
    ],
  });

  return { manifest, detected };
}

function writeIfAllowed(
  root: string,
  relPath: string,
  content: string,
  force: boolean,
  created: string[],
  skipped: string[],
): void {
  const absPath = path.join(root, relPath);
  if (fs.existsSync(absPath) && !force) {
    skipped.push(relPath.replace(/\\/g, "/"));
    return;
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
  created.push(relPath.replace(/\\/g, "/"));
}

export function scaffoldAgentTeam(
  projectRoot: string,
  options?: ScaffoldTeamOptions,
): ScaffoldTeamResult {
  const root = path.resolve(projectRoot);
  const force = Boolean(options?.force);
  const { manifest, detected } = buildDefaultTeamManifest(root, options);

  const created: string[] = [];
  const skipped: string[] = [];

  writeIfAllowed(
    root,
    ".agent-team/team.yaml",
    serializeTeamYaml(manifest),
    force,
    created,
    skipped,
  );

  writeIfAllowed(
    root,
    ".agent-team/model-index.json",
    JSON.stringify(createWorkspaceDefaultModelIndex(), null, 2) + "\n",
    force,
    created,
    skipped,
  );

  const agentPrompts: Array<[string, string]> = [
    [".agent-team/agents/orchestrator.md", renderOrchestratorPrompt(manifest)],
    [".agent-team/agents/architect.md", renderArchitectPrompt(manifest)],
    [".agent-team/agents/ux-designer.md", renderUxDesignerPrompt(manifest)],
    [
      ".agent-team/agents/backend-engineer.md",
      renderBackendEngineerPrompt(manifest),
    ],
    [
      ".agent-team/agents/frontend-engineer.md",
      renderFrontendEngineerPrompt(manifest),
    ],
    [
      ".agent-team/agents/code-reviewer.md",
      renderCodeReviewerPrompt(manifest, detected),
    ],
    [".agent-team/agents/qa-validator.md", renderQaValidatorPrompt(manifest)],
    [".agent-team/agents/team-setup.md", renderTeamSetupPrompt(manifest)],
  ];

  const stockMarkdownEntries: Array<[string, string]> = [...agentPrompts];

  for (const [relPath, content] of agentPrompts) {
    writeIfAllowed(root, relPath, content, force, created, skipped);
  }

  for (const skill of getDefaultSkills(detected)) {
    const relPath = `.agent-team/${skill.relDir}/SKILL.md`;
    stockMarkdownEntries.push([relPath, skill.content]);
    writeIfAllowed(
      root,
      relPath,
      skill.content,
      force,
      created,
      skipped,
    );
  }

  const agentStudioVersion = resolveAgentStudioVersion();
  const managedFiles: Record<string, ManagedFileRecord> = {};
  for (const [relPath, stockContent] of stockMarkdownEntries) {
    const stockHash = sha256Hex(stockContent);
    const absPath = path.join(root, relPath);
    const diskContent = fs.existsSync(absPath)
      ? fs.readFileSync(absPath, "utf8")
      : stockContent;
    const localHash = sha256Hex(diskContent);
    const customized = localHash !== stockHash;
    managedFiles[normalizeUpgradeStateKey(relPath)] = {
      stockHash,
      customized,
      ...(customized ? { localHash } : {}),
      templateVersion: agentStudioVersion,
    };
  }

  writeIfAllowed(
    root,
    ".agent-team/.upgrade-state.json",
    serializeUpgradeState({
      schemaVersion: 1,
      agentStudioVersion,
      files: managedFiles,
    }),
    force,
    created,
    skipped,
  );

  return { manifest, detected, created, skipped };
}
