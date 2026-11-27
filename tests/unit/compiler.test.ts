import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { listProjects } from "../../src/board/registry.js";
import {
  buildDoctorReport,
  runDoctor,
} from "../../src/cli/commands/doctor.js";
import { runInit } from "../../src/cli/commands/init.js";
import { runSync } from "../../src/cli/commands/sync.js";
import {
  buildCopilotHooksConfig,
  buildPortableHookCommand,
  buildPortableMcpSpec,
  checkTeamDrift,
  compileTeam,
  computeDrift,
  COPILOT_HOOK_EVENTS_CANONICAL,
  extractGeneratedHash,
  formatGeneratedMarker,
  HOOK_TAG_NEEDLE,
  installGlobalSetupAgent,
  LEGACY_COPILOT_HOOK_EVENTS,
  MANAGED_BEGIN,
  MANAGED_END,
  mapCapabilitiesToAntigravity,
  mapCapabilitiesToClaudeCode,
  mapCapabilitiesToCopilotVsCode,
  mergeJsonKeyScoped,
  mergeManagedMarkdownBlock,
  planCompiledFiles,
  renderManagedMarkdownBlock,
  resolveCopilotHomeDir,
  resolveEffectiveCapabilities,
  verifyGeneratedMarkdownHash,
  wrapGeneratedMarkdown,
} from "../../src/compiler/index.js";
import {
  assertContainedPath,
  splitFrontmatter,
} from "../../src/compiler/shared.js";
import {
  parseTeamYaml,
  serializeTeamYaml,
  type TeamManifest,
} from "../../src/schema/team.js";
import {
  detectProjectArchitecture,
  detectRepoStack,
  scaffoldAgentTeam,
} from "../../src/templates/index.js";

const tempDirs: string[] = [];
const savedEnv = {
  AGENT_STUDIO_HOME: process.env.AGENT_STUDIO_HOME,
  COPILOT_HOME: process.env.COPILOT_HOME,
  HOME: process.env.HOME,
  VSCODE_USER_DIR: process.env.VSCODE_USER_DIR,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(
  key: "AGENT_STUDIO_HOME" | "COPILOT_HOME" | "HOME" | "VSCODE_USER_DIR",
  val: string | undefined,
): void {
  if (val === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = val;
  }
}

afterEach(() => {
  process.exitCode = 0;
  restoreEnvVar("AGENT_STUDIO_HOME", savedEnv.AGENT_STUDIO_HOME);
  restoreEnvVar("COPILOT_HOME", savedEnv.COPILOT_HOME);
  restoreEnvVar("HOME", savedEnv.HOME);
  restoreEnvVar("VSCODE_USER_DIR", savedEnv.VSCODE_USER_DIR);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Templates & Stack Detection", () => {
  it("auto-detects Node, Python, Rust, Go, and generic stacks", () => {
    const nodeDir = makeTempDir("av-stack-node-");
    fs.writeFileSync(
      path.join(nodeDir, "package.json"),
      JSON.stringify({
        name: "@acme/my-service",
        description: "Node service",
        scripts: { check: "tsc --noEmit", test: "node --test", build: "tsc" },
      }),
      "utf8",
    );
    const nodeInfo = detectRepoStack(nodeDir);
    assert.equal(nodeInfo.stack, "node");
    assert.equal(nodeInfo.projectId, "my-service");
    assert.equal(nodeInfo.checkpoints.CP0?.command, "npm run check");
    assert.equal(nodeInfo.checkpoints.CP1?.command, "npm test");

    const pyDir = makeTempDir("av-stack-py-");
    fs.writeFileSync(
      path.join(pyDir, "pyproject.toml"),
      '[project]\nname = "py-analytics"\ndescription = "Python worker"\n',
      "utf8",
    );
    const pyInfo = detectRepoStack(pyDir);
    assert.equal(pyInfo.stack, "python");
    assert.equal(pyInfo.projectId, "py-analytics");
    assert.equal(pyInfo.checkpoints.CP1?.command, "pytest");

    const rustDir = makeTempDir("av-stack-rust-");
    fs.writeFileSync(
      path.join(rustDir, "Cargo.toml"),
      '[package]\nname = "fast-engine"\n',
      "utf8",
    );
    const rustInfo = detectRepoStack(rustDir);
    assert.equal(rustInfo.stack, "rust");
    assert.equal(rustInfo.checkpoints.CP1?.command, "cargo test");

    const goDir = makeTempDir("av-stack-go-");
    fs.writeFileSync(
      path.join(goDir, "go.mod"),
      "module github.com/acme/go-gateway\n\ngo 1.22\n",
      "utf8",
    );
    const goInfo = detectRepoStack(goDir);
    assert.equal(goInfo.stack, "go");
    assert.equal(goInfo.projectId, "go-gateway");
    assert.equal(goInfo.checkpoints.CP1?.command, "go test ./...");

    const genericDir = makeTempDir("av-stack-generic-");
    const genericInfo = detectRepoStack(genericDir);
    assert.equal(genericInfo.stack, "generic");
    assert.deepEqual(genericInfo.architecture.topologyHints, ["unknown"]);
    assert.deepEqual(genericInfo.architecture.frameworks, []);
    assert.deepEqual(genericInfo.architecture.topLevelDirs, []);
  });

  it("detects architecture signals deterministically across monorepo, microservices, full-stack, Python, Rust, and Go fixtures", () => {
    // 1. Node monorepo + full-stack + event-driven + CI workflow
    const monoDir = makeTempDir("av-arch-mono-");
    fs.mkdirSync(path.join(monoDir, "packages"), { recursive: true });
    fs.mkdirSync(path.join(monoDir, "web"), { recursive: true });
    fs.mkdirSync(path.join(monoDir, "src", "cli"), { recursive: true });
    fs.mkdirSync(path.join(monoDir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(monoDir, ".github", "workflows", "ci.yml"), "name: CI\n", "utf8");
    fs.writeFileSync(path.join(monoDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - web\n", "utf8");
    fs.writeFileSync(
      path.join(monoDir, "package.json"),
      JSON.stringify({
        name: "mono-studio",
        bin: { mono: "dist/cli.js" },
        dependencies: {
          react: "^19.0.0",
          express: "^5.0.0",
          zustand: "^5.0.0",
          bullmq: "^5.0.0",
          zod: "^3.24.0",
          "@prisma/client": "^6.0.0",
        },
      }),
      "utf8",
    );

    const monoArch1 = detectProjectArchitecture(monoDir);
    const monoArch2 = detectRepoStack(monoDir).architecture;
    assert.deepEqual(monoArch1, monoArch2);
    assert.ok(monoArch1.topologyHints.includes("monorepo"));
    assert.ok(monoArch1.topologyHints.includes("full-stack-web"));
    assert.ok(monoArch1.topologyHints.includes("cli-library"));
    assert.ok(monoArch1.topologyHints.includes("event-driven"));
    assert.ok(monoArch1.frameworks.includes("react"));
    assert.ok(monoArch1.frameworks.includes("express"));
    assert.ok(monoArch1.stateManagement.includes("zustand"));
    assert.ok(monoArch1.concurrencySignals.includes("bullmq"));
    assert.ok(monoArch1.apiBoundaries.includes("http-rest"));
    assert.ok(monoArch1.apiBoundaries.includes("schema-validation"));
    assert.ok(monoArch1.storageSignals.includes("prisma"));
    assert.deepEqual(monoArch1.monorepoWorkspaces, ["packages/*", "web"]);
    assert.deepEqual(monoArch1.ciWorkflows, ["ci.yml"]);

    // 2. Microservices + Python
    const microDir = makeTempDir("av-arch-micro-");
    fs.mkdirSync(path.join(microDir, "services"), { recursive: true });
    fs.writeFileSync(path.join(microDir, "docker-compose.yml"), "services:\n  api: {}\n", "utf8");
    fs.writeFileSync(
      path.join(microDir, "pyproject.toml"),
      '[project]\nname = "py-micro"\ndependencies = ["fastapi>=0.115", "celery>=5.4", "pydantic>=2.0"]\n',
      "utf8",
    );
    const microArch = detectRepoStack(microDir).architecture;
    assert.ok(microArch.topologyHints.includes("microservices"));
    assert.ok(microArch.topologyHints.includes("event-driven"));
    assert.ok(microArch.frameworks.includes("fastapi"));
    assert.ok(microArch.concurrencySignals.includes("task-queue"));
    assert.ok(microArch.apiBoundaries.includes("schema-validation"));

    // 3. Rust + layered
    const rustLayered = makeTempDir("av-arch-rust-");
    fs.mkdirSync(path.join(rustLayered, "src", "domain"), { recursive: true });
    fs.mkdirSync(path.join(rustLayered, "src", "adapters"), { recursive: true });
    fs.writeFileSync(
      path.join(rustLayered, "Cargo.toml"),
      '[package]\nname = "layered-rs"\n[dependencies]\naxum = "0.7"\ntokio = "1"\nsqlx = "0.8"\n',
      "utf8",
    );
    const rustArch = detectRepoStack(rustLayered).architecture;
    assert.ok(rustArch.topologyHints.includes("layered"));
    assert.ok(rustArch.frameworks.includes("axum"));
    assert.ok(rustArch.concurrencySignals.includes("tokio-async"));
    assert.ok(rustArch.storageSignals.includes("postgres-sql"));

    // 4. Go
    const goDir = makeTempDir("av-arch-go-");
    fs.mkdirSync(path.join(goDir, "cmd"), { recursive: true });
    fs.writeFileSync(
      path.join(goDir, "go.mod"),
      "module github.com/acme/svc\nrequire (\n  github.com/gin-gonic/gin v1.10.0\n  golang.org/x/sync v0.8.0\n)\n",
      "utf8",
    );
    const goArch = detectRepoStack(goDir).architecture;
    assert.ok(goArch.topologyHints.includes("cli-library"));
    assert.ok(goArch.frameworks.includes("gin"));
    assert.ok(goArch.concurrencySignals.includes("errgroup"));
  });
});

describe("Multi-IDE Compiler (Golden Fixtures & Orchestrator Read-Only)", () => {
  it("compiles Antigravity, Claude Code, and Copilot/VS Code artifacts with strict read-only orchestrator and VS Code handoffs", () => {
    const repo = makeTempDir("av-golden-");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "demo-studio", scripts: { check: "tsc", test: "node --test" } }),
      "utf8",
    );

    scaffoldAgentTeam(repo, { projectId: "demo-studio", projectTitle: "Demo Studio" });

    // Intentionally attempt to grant edit + shell to orchestrator in team.yaml
    // to verify orchestratorReadOnly: true strips them across all 3 IDEs!
    const teamYamlPath = path.join(repo, ".agent-team", "team.yaml");
    const manifest: TeamManifest = parseTeamYaml(fs.readFileSync(teamYamlPath, "utf8"));
    const orch = manifest.roster.find((r) => r.id === "orchestrator");
    assert.ok(orch, "orchestrator must exist in default roster");
    orch.capabilities.push("edit", "shell", "write_docs", "edit_tests");
    fs.writeFileSync(teamYamlPath, serializeTeamYaml(manifest), "utf8");

    const result = compileTeam(repo);
    assert.deepEqual(result.targets, ["antigravity", "claude-code", "copilot-vscode"]);
    assert.ok(result.written.length >= 20, `expected >= 20 compiled files, got ${result.written.length}`);

    // --- 1. Antigravity checks ---
    const agyPluginDir = path.join(repo, ".agents", "plugins", "demo-studio-team");
    assert.ok(fs.existsSync(path.join(agyPluginDir, "plugin.json")));
    assert.ok(fs.existsSync(path.join(agyPluginDir, "rules", "AGENTS.md")));
    assert.ok(fs.existsSync(path.join(agyPluginDir, "skills", "agile-board-workflow", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(agyPluginDir, "skills", "team-setup", "SKILL.md")));

    const expectedMcp = buildPortableMcpSpec();
    const agyMcp = JSON.parse(
      fs.readFileSync(path.join(agyPluginDir, "mcp_config.json"), "utf8"),
    ) as { mcpServers: Record<string, { command: string; args: string[] }> };
    assert.deepEqual(agyMcp.mcpServers["agent-studio"], expectedMcp);

    const agyOrchRaw = fs.readFileSync(
      path.join(agyPluginDir, "agents", "orchestrator.md"),
      "utf8",
    );
    assert.ok(verifyGeneratedMarkdownHash(agyOrchRaw));
    const agyOrchFm = parseYaml(splitFrontmatter(agyOrchRaw).frontmatter ?? "") as {
      tools: string[];
      inheritMcp: boolean;
    };
    assert.equal(agyOrchFm.inheritMcp, true);
    assert.ok(agyOrchFm.tools.includes("invoke_subagent"));
    assert.ok(!agyOrchFm.tools.includes("write_file"));
    assert.ok(!agyOrchFm.tools.includes("edit_file"));
    assert.ok(!agyOrchFm.tools.includes("run_command"));

    // Verify architect and ux-designer receive native Antigravity 2.0 search/discovery
    // tooling (read_file + run_command) without legacy v1 unmapped tool names.
    for (const roleId of ["architect", "ux-designer"]) {
      const roleRaw = fs.readFileSync(
        path.join(agyPluginDir, "agents", `${roleId}.md`),
        "utf8",
      );
      assert.ok(verifyGeneratedMarkdownHash(roleRaw));
      const roleFm = parseYaml(splitFrontmatter(roleRaw).frontmatter ?? "") as {
        tools: string[];
        inheritMcp: boolean;
      };
      assert.equal(roleFm.inheritMcp, true);
      assert.ok(roleFm.tools.includes("read_file"), `${roleId} must have read_file`);
      assert.ok(roleFm.tools.includes("run_command"), `${roleId} must have run_command for search`);
      assert.ok(roleFm.tools.includes("write_file"), `${roleId} must have write_file`);
      assert.ok(roleFm.tools.includes("edit_file"), `${roleId} must have edit_file`);
      assert.equal(new Set(roleFm.tools).size, roleFm.tools.length, `${roleId} tools must be deduplicated`);
      for (const legacyTool of ["grep_search", "find_by_name", "list_dir", "view_file_outline"]) {
        assert.ok(!roleFm.tools.includes(legacyTool), `${roleId} must not emit legacy/unmapped ${legacyTool}`);
      }
    }

    // --- 2. Claude Code checks ---
    const ccOrchRaw = fs.readFileSync(
      path.join(repo, ".claude", "agents", "orchestrator.md"),
      "utf8",
    );
    assert.ok(verifyGeneratedMarkdownHash(ccOrchRaw));
    const ccOrchFm = parseYaml(splitFrontmatter(ccOrchRaw).frontmatter ?? "") as {
      tools: string[];
    };
    assert.ok(ccOrchFm.tools.includes("Read"));
    assert.ok(ccOrchFm.tools.includes("Agent"));
    assert.ok(ccOrchFm.tools.includes("mcp__agent-studio__board"));
    assert.ok(!ccOrchFm.tools.includes("Edit"));
    assert.ok(!ccOrchFm.tools.includes("Write"));
    assert.ok(!ccOrchFm.tools.includes("MultiEdit"));
    assert.ok(!ccOrchFm.tools.includes("Bash"));

    const ccQaFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(path.join(repo, ".claude", "agents", "qa-validator.md"), "utf8"),
      ).frontmatter ?? "",
    ) as { tools: string[] };
    assert.ok(ccQaFm.tools.includes("mcp__agent-studio__testrun"));
    assert.ok(ccQaFm.tools.includes("Bash"));

    const ccMcp = JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { type?: string; command: string; args: string[]; tools?: string[] }>;
    };
    assert.deepEqual(ccMcp.mcpServers["agent-studio"], {
      type: "stdio",
      ...expectedMcp,
      tools: ["*"],
    });

    const ccSettings = JSON.parse(
      fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"),
    ) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
    for (const ev of [
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PreCompact",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ]) {
      const list = ccSettings.hooks[ev];
      assert.ok(Array.isArray(list) && list.length === 1, `missing Claude hook ${ev}`);
      assert.ok(
        list[0]?.hooks[0]?.command.includes(`--ide claude-code --event ${ev}`),
      );
      if (ev === "PreToolUse" || ev === "PostToolUse" || ev === "PostToolUseFailure") {
        assert.equal(list[0]?.matcher, "*", `${ev} must have matcher: "*"`);
      }
    }

    // Verify backend-engineer Claude tools exclude deprecated MultiEdit
    const ccBackendFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(path.join(repo, ".claude", "agents", "backend-engineer.md"), "utf8"),
      ).frontmatter ?? "",
    ) as { tools: string[] };
    assert.ok(ccBackendFm.tools.includes("Edit"));
    assert.ok(ccBackendFm.tools.includes("Write"));
    assert.ok(!ccBackendFm.tools.includes("MultiEdit"));

    // Verify Copilot hooks use 10 canonical camelCase events, version 1, timeoutSec 5, and NO managedBy
    const vscHooks = JSON.parse(
      fs.readFileSync(path.join(repo, ".github", "hooks", "agent-studio.json"), "utf8"),
    ) as {
      version?: number;
      managedBy?: string;
      hooks: Record<string, Array<{ type?: string; command: string; timeoutSec?: number }>>;
    };
    assert.equal(vscHooks.version, 1);
    assert.equal(vscHooks.managedBy, undefined);
    for (const ev of COPILOT_HOOK_EVENTS_CANONICAL) {
      assert.ok(
        Array.isArray(vscHooks.hooks[ev]) && vscHooks.hooks[ev]!.length === 1,
        `missing Copilot hook ${ev}`,
      );
      assert.equal(vscHooks.hooks[ev]![0]?.type, "command");
      assert.equal(vscHooks.hooks[ev]![0]?.timeoutSec, 5);
      assert.ok(
        vscHooks.hooks[ev]![0]?.command.includes(`--ide copilot-vscode --event ${ev}`),
      );
    }

    // --- 3. GitHub Copilot / VS Code checks ---
    const vscOrchRaw = fs.readFileSync(
      path.join(repo, ".github", "agents", "orchestrator.agent.md"),
      "utf8",
    );
    assert.ok(verifyGeneratedMarkdownHash(vscOrchRaw));
    const vscOrchFm = parseYaml(splitFrontmatter(vscOrchRaw).frontmatter ?? "") as {
      tools: string[];
      "user-invocable"?: boolean;
      "disable-model-invocation"?: boolean;
      handoffs?: Array<{ label: string; agent: string; prompt: string; send: boolean }>;
    };
    assert.ok(vscOrchFm.tools.includes("agent"));
    assert.ok(vscOrchFm.tools.includes("agent-studio/*"));
    assert.ok(!vscOrchFm.tools.includes("edit"));
    assert.ok(!vscOrchFm.tools.includes("execute"));
    assert.ok(!vscOrchFm.tools.includes("edit/editFiles"));
    assert.ok(!vscOrchFm.tools.includes("edit/createFile"));
    assert.ok(!vscOrchFm.tools.includes("execute/runInTerminal"));
    assert.equal(vscOrchFm["user-invocable"], true);
    assert.equal(vscOrchFm["disable-model-invocation"], false);
    assert.equal(vscOrchFm.handoffs, undefined);

    // Verify scaffolded canonical code-reviewer and review skills
    assert.ok(fs.existsSync(path.join(repo, ".agent-team", "agents", "code-reviewer.md")));
    assert.ok(fs.existsSync(path.join(repo, ".agent-team", "skills", "code-review", "SKILL.md")));
    const archSkillRaw = fs.readFileSync(
      path.join(repo, ".agent-team", "skills", "architecture-review", "SKILL.md"),
      "utf8",
    );
    assert.ok(archSkillRaw.includes("PENDING DEEP RESEARCH"));

    // Verify compiled code-reviewer across all 3 IDEs: SHA-256 valid, read+search+shell+mcp_board only, ZERO file-edit tools
    const agyReviewerRaw = fs.readFileSync(
      path.join(agyPluginDir, "agents", "code-reviewer.md"),
      "utf8",
    );
    assert.ok(verifyGeneratedMarkdownHash(agyReviewerRaw));
    const agyReviewerFm = parseYaml(splitFrontmatter(agyReviewerRaw).frontmatter ?? "") as {
      tools: string[];
      inheritMcp: boolean;
    };
    assert.equal(agyReviewerFm.inheritMcp, true);
    assert.ok(agyReviewerFm.tools.includes("read_file"));
    assert.ok(agyReviewerFm.tools.includes("run_command"));
    assert.ok(!agyReviewerFm.tools.includes("write_file"));
    assert.ok(!agyReviewerFm.tools.includes("edit_file"));

    const ccReviewerRaw = fs.readFileSync(
      path.join(repo, ".claude", "agents", "code-reviewer.md"),
      "utf8",
    );
    assert.ok(verifyGeneratedMarkdownHash(ccReviewerRaw));
    const ccReviewerFm = parseYaml(splitFrontmatter(ccReviewerRaw).frontmatter ?? "") as {
      tools: string[];
    };
    assert.ok(ccReviewerFm.tools.includes("Read"));
    assert.ok(ccReviewerFm.tools.includes("Glob"));
    assert.ok(ccReviewerFm.tools.includes("Grep"));
    assert.ok(ccReviewerFm.tools.includes("Bash"));
    assert.ok(ccReviewerFm.tools.includes("mcp__agent-studio__board"));
    assert.ok(!ccReviewerFm.tools.includes("Edit"));
    assert.ok(!ccReviewerFm.tools.includes("Write"));
    assert.ok(!ccReviewerFm.tools.includes("MultiEdit"));
    assert.ok(!ccReviewerFm.tools.includes("mcp__agent-studio__testrun"));

    const vscReviewerRaw = fs.readFileSync(
      path.join(repo, ".github", "agents", "code-reviewer.agent.md"),
      "utf8",
    );
    assert.ok(verifyGeneratedMarkdownHash(vscReviewerRaw));
    const vscReviewerFm = parseYaml(splitFrontmatter(vscReviewerRaw).frontmatter ?? "") as {
      tools: string[];
      "user-invocable"?: boolean;
      "disable-model-invocation"?: boolean;
    };
    assert.ok(vscReviewerFm.tools.includes("read"));
    assert.ok(vscReviewerFm.tools.includes("search"));
    assert.ok(vscReviewerFm.tools.includes("execute"));
    assert.ok(vscReviewerFm.tools.includes("agent-studio/*"));
    assert.ok(!vscReviewerFm.tools.includes("edit"));
    assert.ok(!vscReviewerFm.tools.includes("agent-studio/testrun"));
    assert.equal(vscReviewerFm["user-invocable"], false);
    assert.equal(vscReviewerFm["disable-model-invocation"], false);

    // Verify ux-designer agent, ux-review, code-review, architecture-review, and token-efficiency skills compiled across all 3 IDEs
    assert.ok(fs.existsSync(path.join(agyPluginDir, "agents", "ux-designer.md")));
    assert.ok(fs.existsSync(path.join(agyPluginDir, "skills", "ux-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(agyPluginDir, "skills", "code-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(agyPluginDir, "skills", "architecture-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(agyPluginDir, "skills", "token-efficiency", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(agyPluginDir, "skills", "learn", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".claude", "agents", "ux-designer.md")));
    assert.ok(fs.existsSync(path.join(repo, ".claude", "skills", "ux-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".claude", "skills", "code-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".claude", "skills", "architecture-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".claude", "skills", "token-efficiency", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".claude", "skills", "learn", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".github", "agents", "ux-designer.agent.md")));
    assert.ok(fs.existsSync(path.join(repo, ".github", "skills", "ux-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".github", "skills", "code-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".github", "skills", "architecture-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".github", "skills", "token-efficiency", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".github", "skills", "learn", "SKILL.md")));
    // Default "copilot" harness omits .github/prompts/learn.prompt.md in favor of .github/skills/learn/SKILL.md
    assert.equal(fs.existsSync(path.join(repo, ".github", "prompts", "learn.prompt.md")), false);
    assert.equal(fs.existsSync(path.join(repo, ".vscode", "mcp.json")), false);

    // Verify per-IDE learn adaptation & frontmatter
    const agyLearnRaw = fs.readFileSync(
      path.join(agyPluginDir, "skills", "learn", "SKILL.md"),
      "utf8",
    );
    assert.ok(verifyGeneratedMarkdownHash(agyLearnRaw));
    const agyLearnFm = parseYaml(splitFrontmatter(agyLearnRaw).frontmatter ?? "") as Record<
      string,
      unknown
    >;
    assert.equal(agyLearnFm.name, "learn");
    assert.equal(agyLearnFm["disable-slash-command"], undefined);
    assert.equal(agyLearnFm["disable-model-invocation"], true);

    const ccLearnRaw = fs.readFileSync(
      path.join(repo, ".claude", "skills", "learn", "SKILL.md"),
      "utf8",
    );
    assert.ok(verifyGeneratedMarkdownHash(ccLearnRaw));
    const ccLearnFm = parseYaml(splitFrontmatter(ccLearnRaw).frontmatter ?? "") as Record<
      string,
      unknown
    >;
    assert.equal(ccLearnFm.name, "learn");
    assert.equal(ccLearnFm["argument-hint"], "[optional focus]");
    assert.equal(ccLearnFm["disable-model-invocation"], true);

    const vscLearnSkillRaw = fs.readFileSync(
      path.join(repo, ".github", "skills", "learn", "SKILL.md"),
      "utf8",
    );
    assert.ok(verifyGeneratedMarkdownHash(vscLearnSkillRaw));
    const vscLearnSkillFm = parseYaml(
      splitFrontmatter(vscLearnSkillRaw).frontmatter ?? "",
    ) as Record<string, unknown>;
    assert.equal(vscLearnSkillFm["disable-model-invocation"], true);

    // Verify ask_user capability mappings & shared rules across all 3 IDEs
    const agyAsk = mapCapabilitiesToAntigravity(["read", "ask_user"]);
    assert.equal(agyAsk.inheritMcp, true);
    assert.ok(agyAsk.tools.includes("ask_question"));

    const ccAsk = mapCapabilitiesToClaudeCode(["read", "ask_user"]);
    assert.ok(ccAsk.includes("AskUserQuestion"));
    assert.ok(ccAsk.includes("mcp__agent-studio__ask_human"));

    const vscAsk = mapCapabilitiesToCopilotVsCode(["read", "ask_user"]);
    assert.ok(vscAsk.includes("agent_studio_ask_human"));

    const agyRules = fs.readFileSync(path.join(agyPluginDir, "rules", "AGENTS.md"), "utf8");
    assert.match(agyRules, /ask_human/);
    assert.match(agyRules, /agent_studio_ask_human/);
    assert.ok(
      fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8").includes("ask_human"),
    );

    // Verify always-on Token & Context Discipline rules appear in all 3 IDE rules files
    assert.ok(
      fs
        .readFileSync(path.join(agyPluginDir, "rules", "AGENTS.md"), "utf8")
        .includes("Token & Context Discipline"),
    );
    assert.ok(
      fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8").includes("Token & Context Discipline"),
    );
    assert.ok(
      fs
        .readFileSync(path.join(repo, ".github", "copilot-instructions.md"), "utf8")
        .includes("Token & Context Discipline"),
    );

    const copilotHooks = JSON.parse(
      fs.readFileSync(path.join(repo, ".github", "hooks", "agent-studio.json"), "utf8"),
    ) as { hooks: Record<string, Array<{ command: string }>> };
    for (const ev of COPILOT_HOOK_EVENTS_CANONICAL) {
      const list = copilotHooks.hooks[ev];
      assert.ok(Array.isArray(list) && list.length === 1, `missing Copilot hook ${ev}`);
      assert.ok(
        list[0]?.command.includes(`--ide copilot-vscode --event ${ev}`),
      );
    }
  });

  it("is strictly idempotent on double-sync (zero diffs on second run)", () => {
    const repo = makeTempDir("av-idempotent-");
    scaffoldAgentTeam(repo, { projectId: "idemp-app", projectTitle: "Idemp App" });

    const first = compileTeam(repo);
    assert.ok(first.written.length > 0);

    const second = compileTeam(repo);
    assert.equal(second.written.length, 0);
    assert.equal(second.merged.length, 0);
    assert.equal(second.unchanged.length, first.totalFiles);

    const drift = checkTeamDrift(repo);
    assert.equal(drift.ok, true);
    assert.equal(drift.entries.length, 0);
  });

  it("S1-67: compiles self-contained skills/model-routing with 10 rules, expected_cost, 11 triggers, exact JSON contract, and lean orchestrator pointers", () => {
    const repo = makeTempDir("av-s1-67-");
    scaffoldAgentTeam(repo, { projectId: "s67-app", projectTitle: "S67 App" });
    compileTeam(repo);

    for (const skillPath of [
      path.join(repo, ".agents", "plugins", "s67-app-team", "skills", "model-routing", "SKILL.md"),
      path.join(repo, ".claude", "skills", "model-routing", "SKILL.md"),
      path.join(repo, ".github", "skills", "model-routing", "SKILL.md"),
    ]) {
      const raw = fs.readFileSync(skillPath, "utf8");
      const fm = parseYaml(splitFrontmatter(raw).frontmatter ?? "") as Record<string, unknown>;
      assert.equal(fm.name, "model-routing");
      assert.equal(fm["disable-model-invocation"], undefined, "skill must remain model-invoked");
      assert.match(String(fm.description), /10 ordered decision rules/i);
      assert.match(raw, /expected_cost = initial_cost \+ retry_probability \* retry_cost \+ review_cost/);
      assert.match(raw, /## 11 Rerouting Triggers & Anti-Churn Rule/);
      assert.match(raw, /Do not re-run routing after every successful phase/);
      assert.match(raw, /"strategy": "single_model \| planner_executor \| coordinator_workers \| specialist_pipeline \| planner_workers_reviewer"/);
      assert.match(raw, /"reasoning_complexity": "low \| medium \| high \| frontier"/);
      assert.match(raw, /"required_fields": \[/);
      assert.match(raw, /"catalog_warnings": \[\]/);
      assert.match(raw, /3-Layer Model Index Architecture/);
      assert.match(raw, /agent-studio models show/);
    }

    for (const orchPath of [
      path.join(repo, ".agents", "plugins", "s67-app-team", "agents", "orchestrator.md"),
      path.join(repo, ".claude", "agents", "orchestrator.md"),
      path.join(repo, ".github", "agents", "orchestrator.agent.md"),
    ]) {
      const raw = fs.readFileSync(orchPath, "utf8");
      assert.match(raw, /## Routing, Decomposition & Validation Discipline/);
      assert.match(raw, /skills\/model-routing\/SKILL\.md/);
      assert.match(raw, /expected_cost = initial_cost \+ retry_probability \* retry_cost \+ review_cost/);
      assert.ok(!raw.includes('"estimated_peak_tokens"'), "orchestrator prompt must stay lean without JSON schema bloat");
    }
  });
});

describe("Antigravity Capability Mapping", () => {
  const LEGACY_UNMAPPED_TOOLS = [
    "grep_search",
    "find_by_name",
    "list_dir",
    "view_file_outline",
  ];

  it("maps read only to read_file without shell access", () => {
    const mapped = mapCapabilitiesToAntigravity(["read"]);
    assert.deepEqual(mapped.tools, ["read_file"]);
    assert.equal(mapped.inheritMcp, false);
  });

  it("maps search to native Antigravity 2.0 read_file + run_command and deduplicates cleanly", () => {
    const searchOnly = mapCapabilitiesToAntigravity(["search"]);
    assert.deepEqual(searchOnly.tools, ["read_file", "run_command"]);
    assert.equal(searchOnly.inheritMcp, false);
    for (const legacy of LEGACY_UNMAPPED_TOOLS) {
      assert.ok(!searchOnly.tools.includes(legacy));
    }

    const deduped = mapCapabilitiesToAntigravity(["read", "search", "shell"]);
    assert.deepEqual(deduped.tools, ["read_file", "run_command"]);
  });

  it("grants architect and ux-designer search/discovery tooling alongside doc write tools", () => {
    const architect = mapCapabilitiesToAntigravity([
      "read",
      "search",
      "write_docs",
      "mcp_board",
    ]);
    assert.deepEqual(architect.tools, [
      "read_file",
      "run_command",
      "write_file",
      "edit_file",
    ]);
    assert.equal(architect.inheritMcp, true);

    const uxDesigner = mapCapabilitiesToAntigravity([
      "read",
      "search",
      "write_docs",
      "mcp_board",
    ]);
    assert.deepEqual(uxDesigner.tools, [
      "read_file",
      "run_command",
      "write_file",
      "edit_file",
    ]);
    assert.equal(uxDesigner.inheritMcp, true);
  });

  it("enforces strict read-only boundary for orchestrator even with search and forbidden caps", () => {
    const effective = resolveEffectiveCapabilities(
      {
        id: "orchestrator",
        name: "Team Orchestrator",
        roleType: "orchestrator",
        boardRole: "orchestrator",
        promptFile: "agents/orchestrator.md",
        capabilities: [
          "read",
          "search",
          "delegate",
          "ask_user",
          "mcp_board",
          "edit",
          "write_docs",
          "edit_tests",
          "shell",
        ],
      },
      {
        orchestratorReadOnly: true,
        qaGateRequired: true,
        blockDirectBoardEdits: true,
      },
    );

    const mapped = mapCapabilitiesToAntigravity(effective, { readOnly: true });
    assert.equal(mapped.inheritMcp, true);
    assert.deepEqual(mapped.tools, [
      "read_file",
      "invoke_subagent",
      "define_subagent",
      "manage_subagents",
      "send_message",
      "ask_question",
    ]);
    assert.ok(!mapped.tools.includes("write_file"));
    assert.ok(!mapped.tools.includes("edit_file"));
    assert.ok(!mapped.tools.includes("run_command"));

    // Defense-in-depth: even if forbidden capabilities bypass resolveEffectiveCapabilities,
    // readOnly: true still strips write_file, edit_file, and run_command.
    const rawReadOnly = mapCapabilitiesToAntigravity(
      ["read", "search", "edit", "shell", "delegate"],
      { readOnly: true },
    );
    assert.ok(!rawReadOnly.tools.includes("write_file"));
    assert.ok(!rawReadOnly.tools.includes("edit_file"));
    assert.ok(!rawReadOnly.tools.includes("run_command"));
    assert.ok(rawReadOnly.tools.includes("read_file"));
    assert.ok(rawReadOnly.tools.includes("invoke_subagent"));
  });
});

describe("Non-Destructive Merges", () => {
  it("preserves user Markdown above/below managed blocks and user JSON servers/hooks/settings", () => {
    const repo = makeTempDir("av-merge-");
    scaffoldAgentTeam(repo, { projectId: "merge-app", projectTitle: "Merge App" });

    // Pre-existing user CLAUDE.md with custom instructions AND a prior managed block
    const claudeMdPath = path.join(repo, "CLAUDE.md");
    fs.writeFileSync(
      claudeMdPath,
      [
        "# My Existing Repo Notes",
        "Keep this top note untouched.",
        "",
        renderManagedMarkdownBlock("stale managed content"),
        "",
        "## Footer Notes",
        "Keep this footer untouched.",
        "",
      ].join("\n"),
      "utf8",
    );

    // Pre-existing .github/copilot-instructions.md without markers
    const copilotInstrPath = path.join(repo, ".github", "copilot-instructions.md");
    fs.mkdirSync(path.dirname(copilotInstrPath), { recursive: true });
    fs.writeFileSync(
      copilotInstrPath,
      "# Team Coding Style\nAlways prefer explicit return types.\n",
      "utf8",
    );

    // Pre-existing .mcp.json with user MCP server
    fs.writeFileSync(
      path.join(repo, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            "user-postgres": { command: "npx", args: ["-y", "postgres-mcp"] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    // Pre-existing .vscode/mcp.json with user server and inputs
    fs.mkdirSync(path.join(repo, ".vscode"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".vscode", "mcp.json"),
      JSON.stringify(
        {
          inputs: [{ id: "db-url", type: "promptString", description: "DB URL" }],
          servers: {
            "user-github": { type: "stdio", command: "gh-mcp", args: [] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    // Pre-existing .claude/settings.json with user permissions + custom PreToolUse hook
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".claude", "settings.json"),
      JSON.stringify(
        {
          permissions: { allow: ["Read"] },
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "echo user-pre-hook" }],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    // First sync merges non-destructively
    const res1 = compileTeam(repo);
    assert.ok(res1.merged.includes("CLAUDE.md"));
    assert.ok(res1.merged.includes(".github/copilot-instructions.md"));
    assert.ok(res1.merged.includes(".mcp.json"));
    assert.ok(res1.merged.includes(".claude/settings.json"));

    // Verify CLAUDE.md preserved top & bottom
    const claudeMdAfter = fs.readFileSync(claudeMdPath, "utf8");
    assert.ok(claudeMdAfter.includes("# My Existing Repo Notes\nKeep this top note untouched."));
    assert.ok(claudeMdAfter.includes("## Footer Notes\nKeep this footer untouched."));
    assert.ok(!claudeMdAfter.includes("stale managed content"));
    assert.ok(claudeMdAfter.includes("Merge App — Agent Studio Team Rules"));

    // Verify copilot-instructions.md preserved user header and appended managed block
    const copilotAfter = fs.readFileSync(copilotInstrPath, "utf8");
    assert.ok(copilotAfter.startsWith("# Team Coding Style\nAlways prefer explicit return types."));
    assert.ok(copilotAfter.includes(MANAGED_BEGIN));
    assert.ok(copilotAfter.includes(MANAGED_END));

    // Verify .mcp.json preserved user-postgres AND added agent-studio with type: stdio & tools: ["*"]
    const mcpAfter = JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { type?: string; tools?: string[] }>;
    };
    assert.ok(mcpAfter.mcpServers["user-postgres"]);
    assert.ok(mcpAfter.mcpServers["agent-studio"]);
    assert.equal(mcpAfter.mcpServers["agent-studio"]?.type, "stdio");
    assert.deepEqual(mcpAfter.mcpServers["agent-studio"]?.tools, ["*"]);

    // Verify .vscode/mcp.json user servers + inputs were left untouched in copilot harness mode
    const vscMcpAfter = JSON.parse(
      fs.readFileSync(path.join(repo, ".vscode", "mcp.json"), "utf8"),
    ) as { inputs: unknown[]; servers: Record<string, unknown> };
    assert.equal(vscMcpAfter.inputs.length, 1);
    assert.ok(vscMcpAfter.servers["user-github"]);
    assert.equal(vscMcpAfter.servers["agent-studio"], undefined);

    // Verify .claude/settings.json preserved permissions + user PreToolUse hook AND added studio hooks
    const ccSettingsAfter = JSON.parse(
      fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"),
    ) as {
      permissions: { allow: string[] };
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.deepEqual(ccSettingsAfter.permissions.allow, ["Read"]);
    assert.equal(ccSettingsAfter.hooks.PreToolUse.length, 2);
    assert.equal(ccSettingsAfter.hooks.PreToolUse[0]?.hooks[0]?.command, "echo user-pre-hook");
    assert.ok(
      ccSettingsAfter.hooks.PreToolUse[1]?.hooks[0]?.command.includes("agent-studio hook-emit"),
    );

    // Second sync must be 100% idempotent (no duplicate hooks or blocks)
    const res2 = compileTeam(repo);
    assert.equal(res2.written.length, 0);
    assert.equal(res2.merged.length, 0);
    const ccSettingsSecond = JSON.parse(
      fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"),
    ) as { hooks: { PreToolUse: unknown[] } };
    assert.equal(ccSettingsSecond.hooks.PreToolUse.length, 2);

    // Direct unit check on merge helpers
    const mergedMd = mergeManagedMarkdownBlock("Intro\n", "Hello block");
    assert.ok(mergedMd.startsWith("Intro\n\n<!-- agent-studio:begin -->"));
    assert.ok(extractGeneratedHash(mergedMd) !== null);

    const mergedJson = mergeJsonKeyScoped(
      { mcpServers: { keep: { command: "x" } }, extra: 42 },
      { mcpServers: { "agent-studio": { command: "npx" } } },
    );
    assert.equal(mergedJson.extra, 42);
    assert.ok((mergedJson.mcpServers as Record<string, unknown>).keep);
    assert.ok((mergedJson.mcpServers as Record<string, unknown>)["agent-studio"]);
  });
});

describe("Drift Detection (sync --check)", () => {
  it("fails when a generated file is tampered with and passes again after re-sync", async () => {
    const repo = makeTempDir("av-drift-");
    scaffoldAgentTeam(repo, { projectId: "drift-app", projectTitle: "Drift App" });
    compileTeam(repo);

    // Clean check passes
    const clean = await runSync(["--project", repo, "--check", "--quiet"]);
    assert.equal(clean.ok, true);
    assert.equal(clean.exitCode, 0);

    // Adding user content OUTSIDE managed block does NOT cause false drift
    const claudeMdPath = path.join(repo, "CLAUDE.md");
    fs.writeFileSync(
      claudeMdPath,
      "# Custom User Header\n\n" + fs.readFileSync(claudeMdPath, "utf8"),
      "utf8",
    );
    const stillClean = await runSync(["--project", repo, "--check", "--quiet"]);
    assert.equal(stillClean.ok, true);

    // Tamper with a compiled agent file
    const tamperedPath = path.join(repo, ".claude", "agents", "backend-engineer.md");
    fs.appendFileSync(tamperedPath, "\n<!-- hand edit -->\n", "utf8");

    const failed = await runSync(["--project", repo, "--check", "--quiet"]);
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 1);
    assert.ok(
      failed.drift?.entries.some(
        (e) =>
          e.path === ".claude/agents/backend-engineer.md" &&
          e.status === "modified",
      ),
    );
    process.exitCode = 0;

    // Safe sync WITHOUT --force skips user-modified generated Markdown and preserves edits
    const safeSkip = await runSync(["--project", repo, "--quiet"]);
    assert.equal(safeSkip.ok, true);
    assert.equal(safeSkip.exitCode, 0);
    assert.ok(
      safeSkip.compileResult?.skippedModified.some(
        (s) => s.path === ".claude/agents/backend-engineer.md",
      ),
    );
    assert.ok(fs.readFileSync(tamperedPath, "utf8").includes("<!-- hand edit -->"));
    const stillModified = await runSync(["--project", repo, "--check", "--quiet"]);
    assert.equal(stillModified.ok, false);
    process.exitCode = 0;

    // Re-sync WITH --force repairs drift while still keeping user header in CLAUDE.md
    const resync = await runSync(["--project", repo, "--force", "--quiet"]);
    assert.equal(resync.ok, true);
    assert.equal(resync.compileResult?.skippedModified.length, 0);
    assert.ok(fs.readFileSync(claudeMdPath, "utf8").startsWith("# Custom User Header"));

    const afterFix = await runSync(["--project", repo, "--check", "--quiet"]);
    assert.equal(afterFix.ok, true);
    assert.equal(afterFix.exitCode, 0);

    // Tamper with managed block inside CLAUDE.md -> skipped without --force, repaired with --force
    const claudeTampered = fs
      .readFileSync(claudeMdPath, "utf8")
      .replace("Drift App — Agent Studio Team Rules", "Tampered Block Title");
    fs.writeFileSync(claudeMdPath, claudeTampered, "utf8");
    const safeSkipManaged = compileTeam(repo);
    assert.ok(
      safeSkipManaged.skippedModified.some((s) => s.path === "CLAUDE.md"),
    );
    assert.ok(fs.readFileSync(claudeMdPath, "utf8").includes("Tampered Block Title"));

    const forceManaged = compileTeam(repo, { force: true });
    assert.equal(forceManaged.skippedModified.length, 0);
    assert.ok(fs.readFileSync(claudeMdPath, "utf8").startsWith("# Custom User Header"));
    assert.ok(fs.readFileSync(claudeMdPath, "utf8").includes("Drift App — Agent Studio Team Rules"));
    assert.equal(checkTeamDrift(repo).ok, true);
  });

  it("omits .github/prompts/learn.prompt.md in legacy-local mode when skills/learn is absent from manifest", () => {
    const repo = makeTempDir("av-no-learn-");
    scaffoldAgentTeam(repo, { projectId: "no-learn", projectTitle: "No Learn" });
    const teamYamlPath = path.join(repo, ".agent-team", "team.yaml");
    const manifest: TeamManifest = parseTeamYaml(fs.readFileSync(teamYamlPath, "utf8"));
    manifest.workflow.copilotHarness = "legacy-local";
    manifest.skills = manifest.skills.filter((s) => s !== "skills/learn");
    fs.writeFileSync(teamYamlPath, serializeTeamYaml(manifest), "utf8");

    compileTeam(repo);
    assert.equal(
      fs.existsSync(path.join(repo, ".github", "prompts", "learn.prompt.md")),
      false,
    );
    assert.equal(checkTeamDrift(repo).ok, true);
  });

  it("round-trips verifyGeneratedMarkdownHash for frontmatter-less and frontmatter-bearing markdown and detects manual edits", () => {
    const body = "# Shared Team Rules\n\nFollow the Agile board.";

    // Frontmatter-less (e.g., rules/AGENTS.md)
    const noFm = wrapGeneratedMarkdown(body);
    assert.equal(verifyGeneratedMarkdownHash(noFm), true);
    assert.equal(verifyGeneratedMarkdownHash(noFm.replace(/\n/g, "\r\n")), true);

    // Backward-compatible single-newline separator after marker
    const singleNl = `${formatGeneratedMarker(`${body}\n`)}\n${body}\n`;
    assert.equal(verifyGeneratedMarkdownHash(singleNl), true);

    // Genuine manual edits on frontmatter-less markdown fail verification
    assert.equal(verifyGeneratedMarkdownHash(`${noFm}\nExtra line\n`), false);
    assert.equal(verifyGeneratedMarkdownHash(`# Prepended\n${noFm}`), false);
    assert.equal(
      verifyGeneratedMarkdownHash(noFm.replace("# Shared Team Rules", "# Edited Rules")),
      false,
    );

    // Frontmatter-bearing (e.g., agents/*.md)
    const withFm = wrapGeneratedMarkdown(body, "name: architect\nmodel: pro");
    assert.equal(verifyGeneratedMarkdownHash(withFm), true);
    assert.equal(
      verifyGeneratedMarkdownHash(withFm.replace("model: pro", "model: flash")),
      false,
    );
    assert.equal(
      verifyGeneratedMarkdownHash(withFm.replace("Follow the Agile board.", "Edited body.")),
      false,
    );

    // Managed markdown block (e.g., CLAUDE.md)
    const managed = renderManagedMarkdownBlock(body);
    assert.equal(verifyGeneratedMarkdownHash(managed), true);
    assert.equal(
      verifyGeneratedMarkdownHash(managed.replace("Follow the Agile board.", "Tampered.")),
      false,
    );
  });

  it("classifies outdated frontmatter-less files as out-of-date and manually edited ones as modified", () => {
    const repo = makeTempDir("av-frontmatterless-drift-");
    const relRules = ".agents/plugins/test-team/rules/AGENTS.md";
    const absRules = path.join(repo, relRules);
    fs.mkdirSync(path.dirname(absRules), { recursive: true });

    const oldRules = wrapGeneratedMarkdown("# Rules v1\n\nOld rules.");
    const newRules = wrapGeneratedMarkdown("# Rules v2\n\nNew rules.");
    fs.writeFileSync(absRules, oldRules, "utf8");

    const outdatedReport = computeDrift(repo, [
      {
        relPath: relRules,
        ide: "antigravity",
        kind: "generated",
        content: newRules,
      },
    ]);
    assert.equal(outdatedReport.ok, false);
    assert.equal(outdatedReport.entries.length, 1);
    assert.equal(outdatedReport.entries[0]?.status, "out-of-date");

    // Manual edit to the file on disk must classify as modified
    fs.writeFileSync(
      absRules,
      oldRules.replace("Old rules.", "Hand-edited rules."),
      "utf8",
    );
    const modifiedReport = computeDrift(repo, [
      {
        relPath: relRules,
        ide: "antigravity",
        kind: "generated",
        content: newRules,
      },
    ]);
    assert.equal(modifiedReport.ok, false);
    assert.equal(modifiedReport.entries.length, 1);
    assert.equal(modifiedReport.entries[0]?.status, "modified");
  });
});

describe("CLI Init, Global Install & Doctor", () => {
  it("runInit scaffolds project, preserves existing pipeline/board.json, registers project, and passes buildDoctorReport", async () => {
    const fakeHome = makeTempDir("av-home-");
    process.env.HOME = fakeHome;
    process.env.AGENT_STUDIO_HOME = path.join(fakeHome, ".agent-studio");

    const repo = makeTempDir("av-init-proj-");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "existing-board-app", scripts: { test: "node --test" } }),
      "utf8",
    );

    // Create a pre-existing pipeline/board.json with an active item to verify preservation
    const boardPath = path.join(repo, "pipeline", "board.json");
    fs.mkdirSync(path.dirname(boardPath), { recursive: true });
    const preExistingBoard = {
      project: "existing-board-app",
      milestone: { id: "M1", name: "Existing", sprints: ["S1"], final_suite: "smoke" },
      active_sprint: "S1",
      sprints: { S1: { goal: "Preserve me", status: "active" } },
      suites: { smoke: ["CP0"] },
      items: [
        {
          id: "S1-01",
          type: "task",
          title: "Keep this existing item",
          role: "backend",
          state: "dev",
          sprint: "S1",
          ac: [],
          deps: [],
          notes: [],
        },
      ],
      builds: [],
      testruns: [],
      kv: { sentinel: "do-not-clobber" },
    };
    fs.writeFileSync(boardPath, JSON.stringify(preExistingBoard, null, 2), "utf8");

    const initRes = await runInit([
      "--project",
      repo,
      "--ides",
      "antigravity,claude-code,copilot-vscode",
      "--non-interactive",
      "--quiet",
    ]);

    assert.equal(initRes.ok, true);
    assert.equal(initRes.boardPreserved, true);
    assert.equal(initRes.boardCreated, false);

    // Existing board content must be 100% intact
    const boardAfter = JSON.parse(fs.readFileSync(boardPath, "utf8")) as {
      items: Array<{ id: string }>;
      kv: { sentinel: string };
    };
    assert.equal(boardAfter.items.length, 1);
    assert.equal(boardAfter.items[0]?.id, "S1-01");
    assert.equal(boardAfter.kv.sentinel, "do-not-clobber");

    // Project must be registered in temp AGENT_STUDIO_HOME/projects.json
    const registered = listProjects();
    assert.ok(registered.some((p) => p.id === "existing-board-app"));

    // Doctor report must match contract and pass
    const doctor = buildDoctorReport(repo);
    assert.equal(doctor.ok, true);
    assert.equal(doctor.nodeVersion.ok, true);
    assert.equal(doctor.manifestValid, true);
    assert.equal(doctor.drift.ok, true);
    assert.equal(doctor.mcpStatus.ok, true);
    assert.equal(doctor.hooksStatus.ok, true);
    assert.ok(doctor.ides.antigravity);
    assert.ok(doctor.ides["claude-code"]);
    assert.ok(doctor.ides["copilot-vscode"]);
    assert.equal(doctor.adapters.antigravity.ok, true);
    assert.equal(doctor.adapters["claude-code"].ok, true);
    assert.equal(doctor.adapters["copilot-vscode"].ok, true);
    assert.deepEqual(doctor.architectureReview, {
      codeReviewerDefined: true,
      codeReviewSkillPresent: true,
      architectureSkillPresent: true,
      customized: false,
    });

    // Customizing architecture-review/SKILL.md flips customized -> true cleanly
    fs.writeFileSync(
      path.join(repo, ".agent-team", "skills", "architecture-review", "SKILL.md"),
      "---\nname: architecture-review\ndescription: Tailored rubric\n---\n\n# Architecture Review\n",
      "utf8",
    );
    compileTeam(repo);
    const doctorCustomized = buildDoctorReport(repo);
    assert.equal(doctorCustomized.ok, true);
    assert.equal(doctorCustomized.architectureReview.customized, true);

    const cliDoctor = await runDoctor(["--project", repo, "--json", "--quiet"]);
    assert.equal(cliDoctor.ok, true);
  });

  it("runInit --global installs team-setup agent and skill into sandboxed HOME for all 3 IDEs", async () => {
    const fakeHome = makeTempDir("av-global-home-");
    process.env.HOME = fakeHome;
    process.env.AGENT_STUDIO_HOME = path.join(fakeHome, ".agent-studio");

    const res = await runInit(["--global", "--quiet"]);
    assert.equal(res.ok, true);
    assert.ok(res.globalResult);
    assert.equal(res.globalResult.homeDir, path.resolve(fakeHome));

    // Antigravity global plugin
    assert.ok(
      fs.existsSync(
        path.join(fakeHome, ".gemini", "config", "plugins", "agent-studio", "plugin.json"),
      ),
    );
    assert.ok(
      fs.existsSync(
        path.join(
          fakeHome,
          ".gemini",
          "config",
          "plugins",
          "agent-studio",
          "agents",
          "team-setup.md",
        ),
      ),
    );
    assert.ok(
      fs.existsSync(
        path.join(
          fakeHome,
          ".gemini",
          "config",
          "plugins",
          "agent-studio",
          "skills",
          "team-setup",
          "SKILL.md",
        ),
      ),
    );
    const globalAgyLearnPath = path.join(
      fakeHome,
      ".gemini",
      "config",
      "plugins",
      "agent-studio",
      "skills",
      "learn",
      "SKILL.md",
    );
    assert.ok(fs.existsSync(globalAgyLearnPath));
    assert.ok(verifyGeneratedMarkdownHash(fs.readFileSync(globalAgyLearnPath, "utf8")));

    // Claude Code global agent & skills
    assert.ok(fs.existsSync(path.join(fakeHome, ".claude", "agents", "team-setup.md")));
    assert.ok(
      fs.existsSync(path.join(fakeHome, ".claude", "skills", "team-setup", "SKILL.md")),
    );
    const globalCcLearnPath = path.join(
      fakeHome,
      ".claude",
      "skills",
      "learn",
      "SKILL.md",
    );
    assert.ok(fs.existsSync(globalCcLearnPath));
    assert.ok(verifyGeneratedMarkdownHash(fs.readFileSync(globalCcLearnPath, "utf8")));

    // Copilot global files under $COPILOT_HOME (default ~/.copilot)
    const copilotAgentPath = path.join(fakeHome, ".copilot", "agents", "team-setup.agent.md");
    const copilotInstrPath = path.join(
      fakeHome,
      ".copilot",
      "instructions",
      "team-setup.instructions.md",
    );
    const copilotSetupSkillPath = path.join(
      fakeHome,
      ".copilot",
      "skills",
      "team-setup",
      "SKILL.md",
    );
    const copilotLearnSkillPath = path.join(
      fakeHome,
      ".copilot",
      "skills",
      "learn",
      "SKILL.md",
    );
    assert.ok(fs.existsSync(copilotAgentPath));
    assert.ok(fs.existsSync(copilotInstrPath));
    assert.ok(fs.existsSync(copilotSetupSkillPath));
    assert.ok(fs.existsSync(copilotLearnSkillPath));

    const copilotAgentFm = parseYaml(
      splitFrontmatter(fs.readFileSync(copilotAgentPath, "utf8")).frontmatter ?? "",
    ) as Record<string, unknown>;
    assert.deepEqual(copilotAgentFm.tools, [
      "read",
      "search",
      "edit",
      "execute",
      "agent_studio_ask_human",
    ]);
    assert.equal(copilotAgentFm["user-invocable"], true);
    assert.equal(copilotAgentFm["disable-model-invocation"], false);

    const copilotLearnRaw = fs.readFileSync(copilotLearnSkillPath, "utf8");
    assert.ok(verifyGeneratedMarkdownHash(copilotLearnRaw));
    const copilotLearnFm = parseYaml(
      splitFrontmatter(copilotLearnRaw).frontmatter ?? "",
    ) as Record<string, unknown>;
    assert.equal(copilotLearnFm["disable-model-invocation"], true);

    // Test COPILOT_HOME override + surgical cleanup of <VSCodeUserDir>/prompts/*
    const customCopilotHome = path.join(fakeHome, "custom-copilot-home");
    const fakeVsCodeUserDir = path.join(fakeHome, "vscode-user-prompts-test");
    const legacyPromptsDir = path.join(fakeVsCodeUserDir, "prompts");
    fs.mkdirSync(legacyPromptsDir, { recursive: true });
    // 1. Unmodified SHA-256-verified legacy files -> unlinked
    const validLegacyAgent = wrapGeneratedMarkdown("# Setup", "name: Team Setup Agent");
    const validLegacyLearn = wrapGeneratedMarkdown("# Learn", "agent: agent");
    fs.writeFileSync(path.join(legacyPromptsDir, "team-setup.agent.md"), validLegacyAgent, "utf8");
    fs.writeFileSync(path.join(legacyPromptsDir, "learn.prompt.md"), validLegacyLearn, "utf8");
    // 2. Modified/unmarked legacy file -> preserved with warning
    fs.writeFileSync(
      path.join(legacyPromptsDir, "team-setup.instructions.md"),
      "# Custom user instructions without marker\n",
      "utf8",
    );

    process.env.COPILOT_HOME = customCopilotHome;
    assert.equal(resolveCopilotHomeDir(fakeHome), path.resolve(customCopilotHome));
    const directRes = installGlobalSetupAgent({
      homeDir: fakeHome,
      vscodeUserDir: fakeVsCodeUserDir,
    });
    assert.equal(directRes.copilotHomeDir, path.resolve(customCopilotHome));
    assert.ok(
      fs.existsSync(path.join(customCopilotHome, "agents", "team-setup.agent.md")),
    );
    assert.equal(
      fs.existsSync(path.join(legacyPromptsDir, "team-setup.agent.md")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(legacyPromptsDir, "learn.prompt.md")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(legacyPromptsDir, "team-setup.instructions.md")),
      true,
    );
    assert.equal(directRes.cleanedLegacy.length, 2);
    assert.ok(
      directRes.warnings.some((w) => w.includes("team-setup.instructions.md")),
    );
  });
});

describe("S1-69: Copilot Harness, Shared .mcp.json Coalescing & Surgical Legacy Cleanup", () => {
  it("supports workflow.copilotHarness: legacy-local escape hatch while defaulting to copilot harness", () => {
    const repo = makeTempDir("av-legacy-harness-");
    scaffoldAgentTeam(repo, { projectId: "legacy-app", projectTitle: "Legacy App" });
    const teamYamlPath = path.join(repo, ".agent-team", "team.yaml");
    const manifest: TeamManifest = parseTeamYaml(fs.readFileSync(teamYamlPath, "utf8"));
    manifest.workflow.copilotHarness = "legacy-local";
    fs.writeFileSync(teamYamlPath, serializeTeamYaml(manifest), "utf8");

    compileTeam(repo);
    assert.equal(checkTeamDrift(repo).ok, true);

    assert.deepEqual(
      mapCapabilitiesToCopilotVsCode(["read", "search", "edit", "shell", "delegate"], {
        harness: "legacy-local",
      }),
      [
        "read/readFile",
        "search/codebase",
        "search/textSearch",
        "search/fileSearch",
        "edit/editFiles",
        "edit/createFile",
        "execute/runInTerminal",
        "agent/runSubagent",
      ],
    );

    const vscOrchFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(path.join(repo, ".github", "agents", "orchestrator.agent.md"), "utf8"),
      ).frontmatter ?? "",
    ) as { tools: string[]; handoffs?: Array<{ agent: string }> };
    assert.ok(vscOrchFm.tools.includes("agent/runSubagent"));
    assert.ok(Array.isArray(vscOrchFm.handoffs) && vscOrchFm.handoffs.length === 6);

    assert.ok(fs.existsSync(path.join(repo, ".vscode", "mcp.json")));
    assert.ok(fs.existsSync(path.join(repo, ".github", "prompts", "learn.prompt.md")));

    const hooksCfg = JSON.parse(
      fs.readFileSync(path.join(repo, ".github", "hooks", "agent-studio.json"), "utf8"),
    ) as { managedBy?: string; hooks: Record<string, unknown[]> };
    assert.equal(hooksCfg.managedBy, "agent-studio");
    for (const ev of LEGACY_COPILOT_HOOK_EVENTS) {
      assert.ok(Array.isArray(hooksCfg.hooks[ev]) && hooksCfg.hooks[ev]!.length === 1);
    }
    assert.deepEqual(
      buildCopilotHooksConfig("legacy-local").managedBy,
      "agent-studio",
    );
  });

  it("coalesces shared .mcp.json across claude-code & copilot-vscode with zero drift on filtered --ides claude-code", async () => {
    const repo = makeTempDir("av-coalesce-mcp-");
    scaffoldAgentTeam(repo, { projectId: "coalesce-app", projectTitle: "Coalesce App" });

    const planned = planCompiledFiles(repo);
    const mcpEntries = planned.files.filter((f) => f.relPath === ".mcp.json");
    assert.equal(mcpEntries.length, 1, ".mcp.json must be coalesced into a single ExpectedFile");
    assert.deepEqual(mcpEntries[0]?.contributors, ["claude-code", "copilot-vscode"]);

    compileTeam(repo);
    assert.equal(checkTeamDrift(repo).ok, true);

    // Filtered sync --ides claude-code must still include tools: ["*"] so full sync --check has zero drift
    fs.rmSync(path.join(repo, ".mcp.json"));
    const filteredSync = await runSync(["--project", repo, "--ides", "claude-code", "--quiet"]);
    assert.equal(filteredSync.ok, true);
    const mcpJson = JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { type?: string; tools?: string[] }>;
    };
    assert.equal(mcpJson.mcpServers["agent-studio"]?.type, "stdio");
    assert.deepEqual(mcpJson.mcpServers["agent-studio"]?.tools, ["*"]);
    assert.equal(checkTeamDrift(repo).ok, true);
  });

  it("migrates legacy PascalCase Copilot hooks to camelCase while preserving user hooks and pruning managedBy", () => {
    const repo = makeTempDir("av-hooks-migrate-");
    scaffoldAgentTeam(repo, { projectId: "hooks-app", projectTitle: "Hooks App" });

    const hooksPath = path.join(repo, ".github", "hooks", "agent-studio.json");
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          version: 1,
          managedBy: "agent-studio",
          hooks: {
            SessionStart: [
              {
                type: "command",
                command: buildPortableHookCommand("copilot-vscode", "SessionStart"),
                timeoutSec: 5,
              },
            ],
            PreToolUse: [
              { type: "command", command: "echo my-custom-pascal-hook" },
              {
                type: "command",
                command: buildPortableHookCommand("copilot-vscode", "PreToolUse"),
                timeoutSec: 5,
              },
            ],
            preToolUse: [
              { type: "command", command: "echo my-custom-camel-hook" },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    compileTeam(repo);
    const migrated = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as {
      version: number;
      managedBy?: string;
      hooks: Record<string, Array<{ command: string }>>;
    };
    assert.equal(migrated.version, 1);
    assert.equal(migrated.managedBy, undefined);
    assert.equal(migrated.hooks.SessionStart, undefined, "empty legacy SessionStart key should be removed");
    assert.deepEqual(migrated.hooks.PreToolUse, [
      { type: "command", command: "echo my-custom-pascal-hook" },
    ]);
    assert.equal(migrated.hooks.preToolUse?.length, 2);
    assert.equal(migrated.hooks.preToolUse?.[0]?.command, "echo my-custom-camel-hook");
    assert.ok(migrated.hooks.preToolUse?.[1]?.command.includes(HOOK_TAG_NEEDLE));
    assert.equal(checkTeamDrift(repo).ok, true);
  });

  it("respects explicit RosterEntry userInvocable/disableModelInvocation and performs surgical legacy cleanup", async () => {
    const repo = makeTempDir("av-cleanup-");
    scaffoldAgentTeam(repo, { projectId: "cleanup-app", projectTitle: "Cleanup App" });
    const teamYamlPath = path.join(repo, ".agent-team", "team.yaml");
    const manifest: TeamManifest = parseTeamYaml(fs.readFileSync(teamYamlPath, "utf8"));
    const backend = manifest.roster.find((r) => r.id === "backend-engineer")!;
    backend.userInvocable = true;
    backend.disableModelInvocation = true;
    fs.writeFileSync(teamYamlPath, serializeTeamYaml(manifest), "utf8");

    // Case 1: .vscode/mcp.json containing ONLY servers["agent-studio"] -> unlinked; valid learn.prompt.md -> unlinked
    const vscodeMcpPath = path.join(repo, ".vscode", "mcp.json");
    fs.mkdirSync(path.dirname(vscodeMcpPath), { recursive: true });
    fs.writeFileSync(
      vscodeMcpPath,
      JSON.stringify({ servers: { "agent-studio": { type: "stdio", command: "node", args: [] } } }),
      "utf8",
    );
    const learnPromptPath = path.join(repo, ".github", "prompts", "learn.prompt.md");
    fs.mkdirSync(path.dirname(learnPromptPath), { recursive: true });
    fs.writeFileSync(
      learnPromptPath,
      wrapGeneratedMarkdown("# Learn", "agent: agent\ndescription: test"),
      "utf8",
    );

    const res1 = compileTeam(repo);
    assert.equal(fs.existsSync(vscodeMcpPath), false);
    assert.equal(fs.existsSync(learnPromptPath), false);
    assert.ok(res1.cleanedLegacy.includes(".vscode/mcp.json"));
    assert.ok(res1.cleanedLegacy.includes(".github/prompts/learn.prompt.md"));

    const backendFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(path.join(repo, ".github", "agents", "backend-engineer.agent.md"), "utf8"),
      ).frontmatter ?? "",
    ) as Record<string, unknown>;
    assert.equal(backendFm["user-invocable"], true);
    assert.equal(backendFm["disable-model-invocation"], true);

    // Case 2: .vscode/mcp.json with user servers + inputs, and modified learn.prompt.md -> preserved + warned
    fs.writeFileSync(
      vscodeMcpPath,
      JSON.stringify({
        inputs: [{ id: "api-key", type: "promptString" }],
        servers: {
          "user-server": { type: "stdio", command: "my-mcp", args: [] },
          "agent-studio": { type: "stdio", command: "node", args: [] },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(learnPromptPath, "# Modified user prompt without valid hash\n", "utf8");

    const res2 = compileTeam(repo);
    assert.equal(fs.existsSync(vscodeMcpPath), true);
    const vscMcpAfter = JSON.parse(fs.readFileSync(vscodeMcpPath, "utf8")) as {
      inputs: unknown[];
      servers: Record<string, unknown>;
    };
    assert.equal(vscMcpAfter.inputs.length, 1);
    assert.ok(vscMcpAfter.servers["user-server"]);
    assert.equal(vscMcpAfter.servers["agent-studio"], undefined);
    assert.ok(res2.cleanedLegacy.includes(".vscode/mcp.json"));
    assert.equal(fs.existsSync(learnPromptPath), true);
    assert.ok(res2.warnings.some((w) => w.includes(".github/prompts/learn.prompt.md")));

    // Case 3: unmarked .md file & invalid generated JSON skipped unless --force
    const customAgentPath = path.join(repo, ".github", "agents", "qa-validator.agent.md");
    fs.writeFileSync(customAgentPath, "# Hand-written unmarked agent\n", "utf8");
    const agyPluginJsonPath = path.join(repo, ".agents", "plugins", "cleanup-app-team", "plugin.json");
    fs.writeFileSync(agyPluginJsonPath, "{ broken json", "utf8");

    const resSkip = await runSync(["--project", repo, "--quiet"]);
    assert.equal(resSkip.ok, true);
    assert.ok(resSkip.compileResult?.skippedModified.some((s) => s.path.endsWith("qa-validator.agent.md")));
    assert.ok(resSkip.compileResult?.skippedModified.some((s) => s.path.endsWith("plugin.json")));
    assert.equal(fs.readFileSync(customAgentPath, "utf8"), "# Hand-written unmarked agent\n");

    const resForce = await runSync(["--project", repo, "--force", "--quiet"]);
    assert.equal(resForce.ok, true);
    assert.equal(resForce.compileResult?.skippedModified.length, 0);
    assert.ok(verifyGeneratedMarkdownHash(fs.readFileSync(customAgentPath, "utf8")));
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(agyPluginJsonPath, "utf8")));
  });
});

describe("Portable Hook & MCP Launcher", () => {
  it("preserves HOOK_TAG_NEEDLE and embeds zero shell-unsafe characters inside node -e bodies", () => {
    const hookCmd = buildPortableHookCommand("copilot-vscode", "PreToolUse");
    assert.ok(hookCmd.startsWith('node -e "') && hookCmd.endsWith('"'));
    assert.ok(hookCmd.includes(HOOK_TAG_NEEDLE));
    assert.ok(hookCmd.includes("--ide copilot-vscode --event PreToolUse"));

    const hookBody = hookCmd.slice('node -e "'.length, -1);
    assert.equal(
      /["$`%\\\r\n]/.test(hookBody),
      false,
      'hook body must contain zero ", $, `, %, \\, or newlines',
    );

    const mcpSpec = buildPortableMcpSpec();
    assert.equal(mcpSpec.command, "node");
    assert.equal(mcpSpec.args[0], "-e");
    assert.equal(
      /["$`%\\\r\n]/.test(mcpSpec.args[1]),
      false,
      'MCP body must contain zero ", $, `, %, \\, or newlines',
    );
  });

  it("executes compiled hook command via shell with piped stdin, preserves exit 0/2, resolves PATH fallback, and fails open when missing", () => {
    const tmpBase = makeTempDir("av-launcher-");
    const emptyCwd = path.join(tmpBase, "empty cwd");
    const studioHome = path.join(tmpBase, "studio home");
    const binDir = path.join(studioHome, "bin");
    fs.mkdirSync(emptyCwd, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const hookCmd = buildPortableHookCommand("copilot-vscode", "PreToolUse");
    const nodeDir = path.dirname(process.execPath);
    const isolatedEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(isolatedEnv)) {
      if (k.toLowerCase() === "path") delete isolatedEnv[k];
    }
    isolatedEnv.HOME = tmpBase;
    isolatedEnv.USERPROFILE = tmpBase;
    isolatedEnv.AGENT_STUDIO_HOME = studioHome;
    isolatedEnv.PATH = nodeDir;

    // 1. Mock studio-cli.mjs returning exit 0 and echoing args + stdin
    const mockCli = path.join(binDir, "studio-cli.mjs");
    fs.writeFileSync(
      mockCli,
      [
        'import fs from "node:fs";',
        'const stdin = fs.readFileSync(0, "utf8");',
        'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }));',
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );

    const res0 = spawnSync(hookCmd, {
      cwd: emptyCwd,
      env: isolatedEnv,
      shell: true,
      input: "{}",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(res0.status, 0, `expected exit 0, got ${res0.status}: ${res0.stderr}`);
    const parsed0 = JSON.parse(res0.stdout) as { argv: string[]; stdin: string };
    assert.deepEqual(parsed0.argv, [
      "hook-emit",
      "--ide",
      "copilot-vscode",
      "--event",
      "PreToolUse",
    ]);
    assert.equal(parsed0.stdin, "{}");

    // 2. Mock studio-cli.mjs returning exit 2 (PreToolUse guardrail deny)
    fs.writeFileSync(mockCli, "process.exit(2);\n", "utf8");
    const res2 = spawnSync(hookCmd, {
      cwd: emptyCwd,
      env: isolatedEnv,
      shell: true,
      input: "{}",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(res2.status, 2, `expected exit 2 guardrail propagation, got ${res2.status}`);

    // 3. Remove AGENT_STUDIO_HOME shim -> verify PATH fallback (with spaces in dir)
    fs.rmSync(mockCli, { force: true });
    const pathFallbackDir = path.join(tmpBase, "path with space");
    fs.mkdirSync(pathFallbackDir, { recursive: true });
    if (process.platform === "win32") {
      fs.writeFileSync(
        path.join(pathFallbackDir, "agent-studio.cmd"),
        "@echo off\r\nexit /b 2\r\n",
        "utf8",
      );
    } else {
      const shBin = path.join(pathFallbackDir, "agent-studio");
      fs.writeFileSync(shBin, "#!/bin/sh\nexit 2\n", "utf8");
      fs.chmodSync(shBin, 0o755);
    }
    const resPathFallback = spawnSync(hookCmd, {
      cwd: emptyCwd,
      env: {
        ...isolatedEnv,
        PATH: `${pathFallbackDir}${path.delimiter}${nodeDir}`,
      },
      shell: true,
      input: "{}",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(
      resPathFallback.status,
      2,
      `expected PATH fallback exit 2, got ${resPathFallback.status}: ${resPathFallback.stderr}`,
    );

    // 4. Missing CLI everywhere -> hook fails open with exit 0
    const resMissingHook = spawnSync(hookCmd, {
      cwd: emptyCwd,
      env: isolatedEnv,
      shell: true,
      input: "{}",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(resMissingHook.status, 0, "missing CLI hook must fail open with exit 0");

    // 5. Missing CLI everywhere -> MCP launcher exits 1 with install hint
    const mcpSpec = buildPortableMcpSpec();
    const resMissingMcp = spawnSync(mcpSpec.command, mcpSpec.args, {
      cwd: emptyCwd,
      env: isolatedEnv,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(resMissingMcp.status, 1);
    assert.match(resMissingMcp.stderr, /agent-studio CLI not found/);
  });
});

describe("BUG-28 & BUG-30: Schema Path Containment, Symlink Guard & sync --force CLI E2E", () => {
  it("rejects path traversal and unsafe identifiers in team.yaml (project.id, role.id, role.promptFile, skills[])", () => {
    const repo = makeTempDir("av-team-traversal-");
    scaffoldAgentTeam(repo, { projectId: "safe-app", projectTitle: "Safe App" });
    const baseManifest = parseTeamYaml(
      fs.readFileSync(path.join(repo, ".agent-team", "team.yaml"), "utf8"),
    );

    for (const badId of ["../evil", "a/b", "a\\b", ".", "..", "-bad", "bad..id", "bad\0id"]) {
      const badProj = structuredClone(baseManifest);
      badProj.project.id = badId;
      assert.throws(
        () => serializeTeamYaml(badProj),
        `expected project.id ${JSON.stringify(badId)} to be rejected`,
      );

      const badRole = structuredClone(baseManifest);
      badRole.roster[0]!.id = badId;
      assert.throws(
        () => serializeTeamYaml(badRole),
        `expected role.id ${JSON.stringify(badId)} to be rejected`,
      );
    }

    for (const badRelPath of [
      "../outside.md",
      "agents/../../outside.md",
      "/etc/passwd",
      "\\Windows\\System32",
      "C:/escape.md",
      "C:escape.md",
      "agents/./foo.md",
      "agents\\foo.md",
      "agents/bad\0.md",
    ]) {
      const badPrompt = structuredClone(baseManifest);
      badPrompt.roster[0]!.promptFile = badRelPath;
      assert.throws(
        () => serializeTeamYaml(badPrompt),
        `expected promptFile ${JSON.stringify(badRelPath)} to be rejected`,
      );

      const badSkill = structuredClone(baseManifest);
      badSkill.skills = [badRelPath];
      assert.throws(
        () => serializeTeamYaml(badSkill),
        `expected skill ${JSON.stringify(badRelPath)} to be rejected`,
      );
    }
  });

  it("blocks lexical traversal and symlink/junction escapes via assertContainedPath", () => {
    const sandbox = makeTempDir("av-symlink-");
    const baseDir = path.join(sandbox, "workspace", ".agent-team");
    const outsideDir = path.join(sandbox, "outside");
    fs.mkdirSync(path.join(baseDir, "agents"), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "# Secret\n", "utf8");

    assert.throws(
      () => assertContainedPath(baseDir, "../outside/secret.md", "test"),
      /Path traversal blocked/,
    );
    assert.throws(
      () => assertContainedPath(baseDir, "agents/bad\0.md", "test"),
      /Unsafe control characters/,
    );

    const escapedLink = path.join(baseDir, "linked-outside");
    fs.symlinkSync(
      outsideDir,
      escapedLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => assertContainedPath(baseDir, "linked-outside/secret.md", "test"),
      /Symlink escape blocked/,
    );
    assert.throws(
      () => assertContainedPath(baseDir, "linked-outside/new-file.md", "test"),
      /Symlink escape blocked/,
    );
  });

  it("supports agent-studio sync --force CLI e2e to overwrite modified compiled files and clear drift", () => {
    const repo = makeTempDir("av-sync-force-e2e-");
    scaffoldAgentTeam(repo, { projectId: "force-e2e", projectTitle: "Force E2E" });
    compileTeam(repo);

    const compiledAgent = path.join(repo, ".github", "agents", "qa-validator.agent.md");
    fs.appendFileSync(compiledAgent, "\n<!-- manual drift -->\n", "utf8");
    assert.equal(checkTeamDrift(repo).ok, false);

    const cliPath = path.resolve(process.cwd(), "dist", "cli", "index.js");
    const res = spawnSync(
      process.execPath,
      [cliPath, "sync", "--project", repo, "--force", "--quiet"],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(res.status, 0, `sync --force failed: ${res.stderr}`);
    assert.equal(checkTeamDrift(repo).ok, true);
    assert.ok(verifyGeneratedMarkdownHash(fs.readFileSync(compiledAgent, "utf8")));
  });
});
