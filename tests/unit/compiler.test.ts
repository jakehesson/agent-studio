import assert from "node:assert/strict";
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
  checkTeamDrift,
  compileTeam,
  computeDrift,
  extractGeneratedHash,
  formatGeneratedMarker,
  installGlobalSetupAgent,
  MANAGED_BEGIN,
  MANAGED_END,
  mapCapabilitiesToAntigravity,
  mergeJsonKeyScoped,
  mergeManagedMarkdownBlock,
  renderManagedMarkdownBlock,
  resolveEffectiveCapabilities,
  verifyGeneratedMarkdownHash,
  wrapGeneratedMarkdown,
} from "../../src/compiler/index.js";
import { splitFrontmatter } from "../../src/compiler/shared.js";
import {
  parseTeamYaml,
  serializeTeamYaml,
  type TeamManifest,
} from "../../src/schema/team.js";
import {
  detectRepoStack,
  scaffoldAgentTeam,
} from "../../src/templates/index.js";

const tempDirs: string[] = [];
const savedEnv = {
  AGENT_STUDIO_HOME: process.env.AGENT_STUDIO_HOME,
  HOME: process.env.HOME,
  VSCODE_USER_DIR: process.env.VSCODE_USER_DIR,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(
  key: "AGENT_STUDIO_HOME" | "HOME" | "VSCODE_USER_DIR",
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

    const agyMcp = JSON.parse(
      fs.readFileSync(path.join(agyPluginDir, "mcp_config.json"), "utf8"),
    ) as { mcpServers: Record<string, { command: string; args: string[] }> };
    assert.equal(agyMcp.mcpServers["agent-studio"]?.command, "npx");
    assert.deepEqual(agyMcp.mcpServers["agent-studio"]?.args, ["-y", "agent-studio", "mcp"]);

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
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.equal(ccMcp.mcpServers["agent-studio"]?.command, "npx");
    assert.deepEqual(ccMcp.mcpServers["agent-studio"]?.args, ["-y", "agent-studio", "mcp"]);

    const ccSettings = JSON.parse(
      fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    for (const ev of ["PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"]) {
      const list = ccSettings.hooks[ev];
      assert.ok(Array.isArray(list) && list.length === 1, `missing Claude hook ${ev}`);
      assert.ok(
        list[0]?.hooks[0]?.command.includes(`--ide claude-code --event ${ev}`),
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
      handoffs: Array<{ label: string; agent: string; prompt: string; send: boolean }>;
    };
    assert.ok(vscOrchFm.tools.includes("agent/runSubagent"));
    assert.ok(vscOrchFm.tools.includes("agent-studio/*"));
    assert.ok(!vscOrchFm.tools.includes("edit/editFiles"));
    assert.ok(!vscOrchFm.tools.includes("edit/createFile"));
    assert.ok(!vscOrchFm.tools.includes("execute/runInTerminal"));

    assert.ok(Array.isArray(vscOrchFm.handoffs) && vscOrchFm.handoffs.length === 5);
    assert.deepEqual(
      vscOrchFm.handoffs.map((h) => h.agent),
      ["architect", "ux-designer", "backend-engineer", "frontend-engineer", "qa-validator"],
    );

    // Verify ux-designer agent, ux-review skill, and core token-efficiency skill & rules compiled across all 3 IDEs
    assert.ok(fs.existsSync(path.join(agyPluginDir, "agents", "ux-designer.md")));
    assert.ok(fs.existsSync(path.join(agyPluginDir, "skills", "ux-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(agyPluginDir, "skills", "token-efficiency", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".claude", "agents", "ux-designer.md")));
    assert.ok(fs.existsSync(path.join(repo, ".claude", "skills", "ux-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".claude", "skills", "token-efficiency", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".github", "agents", "ux-designer.agent.md")));
    assert.ok(fs.existsSync(path.join(repo, ".github", "skills", "ux-review", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".github", "skills", "token-efficiency", "SKILL.md")));

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

    const vscMcp = JSON.parse(
      fs.readFileSync(path.join(repo, ".vscode", "mcp.json"), "utf8"),
    ) as { servers: Record<string, { type: string; command: string; args: string[] }> };
    assert.equal(vscMcp.servers["agent-studio"]?.type, "stdio");
    assert.equal(vscMcp.servers["agent-studio"]?.command, "npx");
    assert.deepEqual(vscMcp.servers["agent-studio"]?.args, ["-y", "agent-studio", "mcp"]);

    const copilotHooks = JSON.parse(
      fs.readFileSync(path.join(repo, ".github", "hooks", "agent-studio.json"), "utf8"),
    ) as { hooks: Record<string, Array<{ command: string }>> };
    for (const ev of ["PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"]) {
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
        MANAGED_BEGIN,
        "stale managed content",
        MANAGED_END,
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
    assert.ok(res1.merged.includes(".vscode/mcp.json"));
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

    // Verify .mcp.json preserved user-postgres AND added agent-studio
    const mcpAfter = JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    assert.ok(mcpAfter.mcpServers["user-postgres"]);
    assert.ok(mcpAfter.mcpServers["agent-studio"]);

    // Verify .vscode/mcp.json preserved inputs + user-github AND added agent-studio
    const vscMcpAfter = JSON.parse(
      fs.readFileSync(path.join(repo, ".vscode", "mcp.json"), "utf8"),
    ) as { inputs: unknown[]; servers: Record<string, unknown> };
    assert.equal(vscMcpAfter.inputs.length, 1);
    assert.ok(vscMcpAfter.servers["user-github"]);
    assert.ok(vscMcpAfter.servers["agent-studio"]);

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

    // Re-sync repairs drift while still keeping user header in CLAUDE.md
    const resync = await runSync(["--project", repo, "--quiet"]);
    assert.equal(resync.ok, true);
    assert.ok(fs.readFileSync(claudeMdPath, "utf8").startsWith("# Custom User Header"));

    const afterFix = await runSync(["--project", repo, "--check", "--quiet"]);
    assert.equal(afterFix.ok, true);
    assert.equal(afterFix.exitCode, 0);
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

    // Claude Code global agent & skill
    assert.ok(fs.existsSync(path.join(fakeHome, ".claude", "agents", "team-setup.md")));
    assert.ok(
      fs.existsSync(path.join(fakeHome, ".claude", "skills", "team-setup", "SKILL.md")),
    );

    // VS Code global prompts/instructions inside sandboxed HOME
    const directRes = installGlobalSetupAgent({ homeDir: fakeHome });
    assert.ok(
      directRes.installedFiles.some((f) => f.endsWith("team-setup.agent.md")),
    );
    assert.ok(
      directRes.installedFiles.some((f) => f.endsWith("team-setup.instructions.md")),
    );
  });
});
