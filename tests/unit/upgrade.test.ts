import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildDoctorReport, detectInstalledIdes } from "../../src/cli/commands/doctor.js";
import { runInit } from "../../src/cli/commands/init.js";
import { runUpgrade } from "../../src/cli/commands/upgrade.js";
import { sha256Hex, wrapGeneratedMarkdown } from "../../src/compiler/merge.js";
import {
  createWorkspaceDefaultModelIndex,
} from "../../src/models/defaults.js";
import {
  readModelIndexLayerSync,
  withFileLock,
} from "../../src/models/store.js";
import { parseTeamYaml, serializeTeamYaml } from "../../src/schema/team.js";
import {
  getUpgradeStatePath,
  normalizeUpgradeStateKey,
  parseUpgradeState,
  readUpgradeStateSync,
  serializeUpgradeState,
} from "../../src/schema/upgrade-state.js";
import { discoverTeamDetails } from "../../src/telemetry/definitions.js";
import { scaffoldAgentTeam } from "../../src/templates/manifest.js";

describe("S1-68-T2: Safe Upgrade, Provenance State, Doctor Migrations & $COPILOT_HOME Discovery", () => {
  let tmpRoot: string;
  let origHome: string | undefined;
  let origStudioHome: string | undefined;
  let origCopilotHome: string | undefined;
  let origVsCodeUserDir: string | undefined;
  const savedExitCode = process.exitCode;

  function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(tmpRoot, prefix));
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "av-upgrade-"));
    origHome = process.env.HOME;
    origStudioHome = process.env.AGENT_STUDIO_HOME;
    origCopilotHome = process.env.COPILOT_HOME;
    origVsCodeUserDir = process.env.VSCODE_USER_DIR;

    const fakeHome = makeTempDir("home-");
    process.env.HOME = fakeHome;
    process.env.AGENT_STUDIO_HOME = path.join(fakeHome, ".agent-studio");
    process.env.COPILOT_HOME = path.join(fakeHome, ".copilot");
    process.env.VSCODE_USER_DIR = path.join(fakeHome, "vscode-user");
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origStudioHome === undefined) delete process.env.AGENT_STUDIO_HOME;
    else process.env.AGENT_STUDIO_HOME = origStudioHome;
    if (origCopilotHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = origCopilotHome;
    if (origVsCodeUserDir === undefined) delete process.env.VSCODE_USER_DIR;
    else process.env.VSCODE_USER_DIR = origVsCodeUserDir;
    process.exitCode = savedExitCode;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("initializes deterministic .upgrade-state.json on fresh init without volatile timestamps or machine paths", async () => {
    const repo = makeTempDir("fresh-init-");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "fresh-upgrade-app", scripts: { test: "node --test" } }),
      "utf8",
    );

    const initRes = await runInit([
      "--project",
      repo,
      "--ides",
      "antigravity,claude-code,copilot-vscode",
      "--non-interactive",
      "--quiet",
    ]);
    assert.equal(initRes.ok, true);

    const statePath = getUpgradeStatePath(repo);
    assert.ok(fs.existsSync(statePath));
    const rawState = fs.readFileSync(statePath, "utf8");
    assert.equal(rawState.includes(repo), false);
    assert.equal(rawState.includes("\\"), false);

    const state = readUpgradeStateSync(repo);
    assert.ok(state);
    assert.equal(state.schemaVersion, 1);
    const keys = Object.keys(state.files);
    assert.deepEqual(
      keys,
      [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    assert.equal(state.files["agents/orchestrator.md"]?.customized, false);
    assert.equal(state.files["skills/learn/SKILL.md"]?.customized, false);

    const wsIndexPath = path.join(repo, ".agent-team", "model-index.json");
    const wsIndexBeforeUpgrade = fs.readFileSync(wsIndexPath, "utf8");

    // First upgrade right after init produces ZERO model-index churn (only architecture-review
    // fast-forwards if init created pipeline/ after scaffoldAgentTeam ran detectRepoStack)
    const firstUpRes = await runUpgrade(["--project", repo, "--quiet"]);
    assert.equal(firstUpRes.ok, true);
    assert.equal(firstUpRes.firstTimeBootstrap, false);
    assert.equal(firstUpRes.addedFiles.length, 0);
    assert.equal(firstUpRes.preservedCustomizedFiles.length, 0);
    assert.equal(firstUpRes.workspaceModelIndex.changed, false);
    assert.equal(fs.readFileSync(wsIndexPath, "utf8"), wsIndexBeforeUpgrade);

    // Second run is strictly a 0-diff no-op across team.yaml, model-index, and .upgrade-state.json
    const upRes = await runUpgrade(["--project", repo, "--quiet"]);
    assert.equal(upRes.ok, true);
    assert.equal(upRes.firstTimeBootstrap, false);
    assert.equal(upRes.addedFiles.length, 0);
    assert.equal(upRes.fastForwardedFiles.length, 0);
    assert.equal(upRes.preservedCustomizedFiles.length, 0);
    assert.equal(upRes.teamYamlUpdated, false);
    assert.equal(upRes.workspaceModelIndex.changed, false);
    assert.equal(upRes.upgradeStateUpdated, false);
  });

  it("bootstraps legacy repos without .upgrade-state.json, protects user-customized files & custom skills, and respects --dry-run / --diff / --write-incoming / --force", async () => {
    const repo = makeTempDir("bootstrap-");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "legacy-repo", scripts: { test: "node --test" } }),
      "utf8",
    );
    scaffoldAgentTeam(repo, { projectId: "legacy-repo", projectTitle: "Legacy Repo" });
    // Simulate a legacy repo before .upgrade-state.json existed
    fs.rmSync(getUpgradeStatePath(repo), { force: true });

    const backendPromptPath = path.join(repo, ".agent-team", "agents", "backend-engineer.md");
    const customBackendPrompt = "# Custom Backend Engineer\n\nKeep my custom repo rules.\n";
    fs.writeFileSync(backendPromptPath, customBackendPrompt, "utf8");

    const archSkillPath = path.join(repo, ".agent-team", "skills", "architecture-review", "SKILL.md");
    const customArchSkill = "---\nname: architecture-review\ndescription: Tailored arch\n---\n\n# Architecture\nTailored invariants.\n";
    fs.writeFileSync(archSkillPath, customArchSkill, "utf8");

    const customSkillDir = path.join(repo, ".agent-team", "skills", "domain-billing");
    fs.mkdirSync(customSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(customSkillDir, "SKILL.md"),
      "---\nname: domain-billing\ndescription: Billing rules\n---\n\n# Billing\n",
      "utf8",
    );

    // 1. --dry-run writes nothing to disk
    const dryRes = await runUpgrade(["--project", repo, "--dry-run", "--diff", "--quiet"]);
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.firstTimeBootstrap, true);
    assert.equal(fs.existsSync(getUpgradeStatePath(repo)), false);
    assert.equal(fs.existsSync(path.join(repo, ".mcp.json")), false);
    assert.ok(dryRes.preservedCustomizedFiles.includes("agents/backend-engineer.md"));
    assert.ok(dryRes.preservedCustomizedFiles.includes("skills/architecture-review/SKILL.md"));
    assert.ok(
      dryRes.diffs.some(
        (d) =>
          d.path === "agents/backend-engineer.md" &&
          d.diff.includes("-Keep my custom repo rules."),
      ),
    );
    assert.equal(fs.existsSync(`${backendPromptPath}.incoming`), false);

    // 2. Real upgrade without --force or --write-incoming preserves customized files and keeps tree clean of .incoming
    const upRes = await runUpgrade(["--project", repo, "--quiet"]);
    assert.equal(upRes.ok, true);
    assert.equal(upRes.firstTimeBootstrap, true);
    assert.equal(fs.readFileSync(backendPromptPath, "utf8"), customBackendPrompt);
    assert.equal(fs.readFileSync(archSkillPath, "utf8"), customArchSkill);
    assert.ok(fs.existsSync(path.join(customSkillDir, "SKILL.md")));
    assert.equal(fs.existsSync(`${backendPromptPath}.incoming`), false);

    const stateAfter = readUpgradeStateSync(repo);
    assert.equal(stateAfter?.files["agents/backend-engineer.md"]?.customized, true);
    assert.equal(stateAfter?.files["skills/architecture-review/SKILL.md"]?.customized, true);
    assert.equal(stateAfter?.files["agents/orchestrator.md"]?.customized, false);

    // 3. --write-incoming writes .incoming sibling for customized files
    const incRes = await runUpgrade(["--project", repo, "--write-incoming", "--quiet"]);
    assert.ok(incRes.incomingWritten.includes(".agent-team/agents/backend-engineer.md.incoming"));
    assert.ok(fs.existsSync(`${backendPromptPath}.incoming`));
    fs.rmSync(`${backendPromptPath}.incoming`, { force: true });
    fs.rmSync(`${archSkillPath}.incoming`, { force: true });

    // 4. --force overwrites customized files and clears customized flags
    const forceRes = await runUpgrade(["--project", repo, "--force", "--quiet"]);
    assert.equal(forceRes.ok, true);
    assert.ok(forceRes.forcedFiles.includes("agents/backend-engineer.md"));
    assert.notEqual(fs.readFileSync(backendPromptPath, "utf8"), customBackendPrompt);
    const stateForced = readUpgradeStateSync(repo);
    assert.equal(stateForced?.files["agents/backend-engineer.md"]?.customized, false);
  });

  it("auto fast-forwards unmodified stock files, auto-adds missing built-in skills, and preserves user-deleted tracked skills", async () => {
    const repo = makeTempDir("fast-forward-");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "ff-app" }),
      "utf8",
    );
    scaffoldAgentTeam(repo, { projectId: "ff-app", projectTitle: "FF App" });

    // Simulate an older unmodified stock template for frontend-engineer.md
    const fePath = path.join(repo, ".agent-team", "agents", "frontend-engineer.md");
    const stockFeNow = fs.readFileSync(fePath, "utf8");
    const olderStockFe = "# Old Stock Frontend Engineer\n";
    fs.writeFileSync(fePath, olderStockFe, "utf8");

    // Simulate missing new built-in skill (skills/learn) not in .upgrade-state.json or team.yaml
    const learnSkillPath = path.join(repo, ".agent-team", "skills", "learn", "SKILL.md");
    fs.rmSync(path.dirname(learnSkillPath), { recursive: true, force: true });

    // Simulate user-deleted tracked built-in skill (skills/ux-review) present in .upgrade-state.json
    const uxSkillPath = path.join(repo, ".agent-team", "skills", "ux-review", "SKILL.md");
    fs.rmSync(path.dirname(uxSkillPath), { recursive: true, force: true });

    const teamYamlPath = path.join(repo, ".agent-team", "team.yaml");
    const manifest = parseTeamYaml(fs.readFileSync(teamYamlPath, "utf8"));
    manifest.skills = manifest.skills.filter(
      (s) => s !== "skills/learn" && s !== "skills/ux-review",
    );
    fs.writeFileSync(teamYamlPath, serializeTeamYaml(manifest), "utf8");

    const state = readUpgradeStateSync(repo)!;
    state.files["agents/frontend-engineer.md"] = {
      stockHash: sha256Hex(olderStockFe),
      customized: false,
      templateVersion: "0.12.0",
    };
    delete state.files["skills/learn/SKILL.md"];
    fs.writeFileSync(getUpgradeStatePath(repo), serializeUpgradeState(state), "utf8");

    const upRes = await runUpgrade(["--project", repo, "--quiet"]);
    assert.equal(upRes.ok, true);
    assert.ok(upRes.fastForwardedFiles.includes("agents/frontend-engineer.md"));
    assert.equal(fs.readFileSync(fePath, "utf8"), stockFeNow);

    // Missing new built-in skill added + registered in team.yaml
    assert.ok(upRes.addedFiles.includes("skills/learn/SKILL.md"));
    assert.ok(fs.existsSync(learnSkillPath));
    const updatedManifest = parseTeamYaml(fs.readFileSync(teamYamlPath, "utf8"));
    assert.ok(updatedManifest.skills.includes("skills/learn"));

    // User-deleted tracked skill preserved deleted
    assert.ok(upRes.preservedDeletedFiles.includes("skills/ux-review/SKILL.md"));
    assert.equal(fs.existsSync(uxSkillPath), false);
  });

  it("migrates known legacy (copilot) model IDs across team.yaml, workspace model-index, and global model-index while preserving custom/BYOK IDs", async () => {
    const repo = makeTempDir("models-upgrade-");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "models-upgrade" }),
      "utf8",
    );
    scaffoldAgentTeam(repo, { projectId: "models-upgrade", projectTitle: "Models Upgrade" });

    // Inject legacy "(copilot)" IDs + custom/BYOK IDs into team.yaml
    const teamYamlPath = path.join(repo, ".agent-team", "team.yaml");
    const manifest = parseTeamYaml(fs.readFileSync(teamYamlPath, "utf8"));
    const backend = manifest.roster.find((r) => r.id === "backend-engineer")!;
    backend.models = {
      "copilot-vscode": {
        primary: "Claude Sonnet 4.6 (copilot)",
        fallback: ["GPT-5.4 (copilot)", "my-org/custom-byok-model"],
        copilotPolicy: "preferred",
      },
    };
    const architect = manifest.roster.find((r) => r.id === "architect")!;
    architect.models = {
      "copilot-vscode": "Enterprise Private (copilot)",
    };
    fs.writeFileSync(teamYamlPath, serializeTeamYaml(manifest), "utf8");

    // Inject legacy "(copilot)" IDs + colliding vscode-lm entry + BYOK entry into workspace model-index.json
    const wsIndexPath = path.join(repo, ".agent-team", "model-index.json");
    const wsIndex = createWorkspaceDefaultModelIndex();
    wsIndex.ides["copilot-vscode"].tiers.balanced = {
      primary: "Claude Sonnet 4.6 (copilot)",
      fallback: ["GPT-5.4 (copilot)", "my-org/custom-byok-model"],
    };
    wsIndex.ides["copilot-vscode"].catalog.unshift(
      {
        id: "Claude Sonnet 4.6 (copilot)",
        label: "Claude Sonnet 4.6",
        tier: "balanced",
        capabilities: ["coding"],
        available: true,
        source: "built-in",
      },
      {
        id: "my-org/custom-byok-model",
        label: "Custom BYOK",
        tier: "reasoning",
        capabilities: ["reasoning"],
        available: true,
        source: "user",
      },
    );
    // Mark existing live runtime entry unavailable to test collision preference
    const liveIdx = wsIndex.ides["copilot-vscode"].catalog.findIndex(
      (e) => e.id === "claude-sonnet-4.6",
    );
    wsIndex.ides["copilot-vscode"].catalog[liveIdx] = {
      ...wsIndex.ides["copilot-vscode"].catalog[liveIdx]!,
      source: "vscode-lm",
      available: false,
    };
    fs.writeFileSync(wsIndexPath, JSON.stringify(wsIndex, null, 2) + "\n", "utf8");

    // Seed legacy global model-index.json + legacy VSCodeUserDir/prompts
    const globalIndexPath = path.join(process.env.AGENT_STUDIO_HOME!, "model-index.json");
    fs.mkdirSync(path.dirname(globalIndexPath), { recursive: true });
    fs.writeFileSync(
      globalIndexPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          ides: {
            "copilot-vscode": {
              tiers: {
                reasoning: {
                  primary: "Claude Opus 4.6 (copilot)",
                  fallback: ["my-org/custom-byok-model"],
                },
              },
              catalog: [
                {
                  id: "Claude Opus 4.6 (copilot)",
                  label: "Claude Opus 4.6",
                  tier: "reasoning",
                  capabilities: ["reasoning"],
                  available: true,
                  source: "built-in",
                },
              ],
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const legacyPromptsDir = path.join(process.env.VSCODE_USER_DIR!, "prompts");
    fs.mkdirSync(legacyPromptsDir, { recursive: true });
    const stockLegacyAgent = wrapGeneratedMarkdown(
      "# Setup",
      "name: Team Setup Agent\ndescription: setup",
    );
    const modifiedLegacyInstr = "# User modified instructions without marker\n";
    fs.writeFileSync(
      path.join(legacyPromptsDir, "team-setup.agent.md"),
      stockLegacyAgent,
      "utf8",
    );
    fs.writeFileSync(
      path.join(legacyPromptsDir, "team-setup.instructions.md"),
      modifiedLegacyInstr,
      "utf8",
    );

    // Doctor before upgrade flags legacy IDs and legacy global prompt files
    const preDoc = buildDoctorReport(repo);
    assert.ok(
      preDoc.migrationWarnings.some((w) => w.id === "legacy-copilot-models-team-yaml"),
    );
    assert.ok(
      preDoc.migrationWarnings.some((w) => w.id === "legacy-copilot-models-workspace"),
    );
    assert.ok(
      preDoc.migrationWarnings.some((w) => w.id === "legacy-copilot-models-global"),
    );
    assert.ok(
      preDoc.migrationWarnings.some((w) =>
        w.id?.startsWith("legacy-global-copilot-"),
      ),
    );

    const upRes = await runUpgrade(["--project", repo, "--global", "--quiet"]);
    assert.equal(upRes.ok, true);
    assert.equal(upRes.teamYamlUpdated, true);
    assert.equal(upRes.workspaceModelIndex.changed, true);
    assert.equal(upRes.globalModelIndex?.changed, true);

    const migratedManifest = parseTeamYaml(fs.readFileSync(teamYamlPath, "utf8"));
    const migratedBackend = migratedManifest.roster.find(
      (r) => r.id === "backend-engineer",
    )!;
    assert.deepEqual(migratedBackend.models?.["copilot-vscode"], {
      primary: "claude-sonnet-4.6",
      fallback: ["gpt-5.4", "my-org/custom-byok-model"],
      copilotPolicy: "preferred",
    });
    const migratedArch = migratedManifest.roster.find((r) => r.id === "architect")!;
    assert.equal(
      migratedArch.models?.["copilot-vscode"],
      "Enterprise Private (copilot)",
    );

    const wsAfter = readModelIndexLayerSync(wsIndexPath)!;
    assert.deepEqual(wsAfter.ides?.["copilot-vscode"]?.tiers?.balanced, {
      primary: "claude-sonnet-4.6",
      fallback: ["gpt-5.4", "my-org/custom-byok-model"],
    });
    const sonnetEntries = (wsAfter.ides?.["copilot-vscode"]?.catalog ?? []).filter(
      (e) => e.id === "claude-sonnet-4.6",
    );
    assert.equal(sonnetEntries.length, 1);
    assert.equal(sonnetEntries[0]?.source, "vscode-lm");
    assert.equal(sonnetEntries[0]?.available, false);
    assert.ok(
      wsAfter.ides?.["copilot-vscode"]?.catalog?.some(
        (e) => e.id === "my-org/custom-byok-model",
      ),
    );

    const globalAfter = readModelIndexLayerSync(globalIndexPath)!;
    assert.equal(
      globalAfter.ides?.["copilot-vscode"]?.tiers?.reasoning?.primary,
      "claude-opus-4.6",
    );

    // $COPILOT_HOME installed, unmodified legacy file cleaned, modified legacy file preserved
    const copilotHome = process.env.COPILOT_HOME!;
    assert.ok(
      fs.existsSync(path.join(copilotHome, "agents", "team-setup.agent.md")),
    );
    assert.ok(
      fs.existsSync(path.join(copilotHome, "skills", "learn", "SKILL.md")),
    );
    assert.equal(
      fs.existsSync(path.join(legacyPromptsDir, "team-setup.agent.md")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(legacyPromptsDir, "team-setup.instructions.md")),
      true,
    );
  });

  it("detects $COPILOT_HOME in doctor, discovers global Copilot agents/skills in definitions.ts, and emits migrationWarnings for legacy workspace artifacts", async () => {
    // Isolate a home dir where only $COPILOT_HOME exists (no workspaceStorage or VSCodeUserDir)
    const isolatedHome = makeTempDir("copilot-only-home-");
    const customCopilotHome = path.join(isolatedHome, "custom-copilot-home");
    process.env.HOME = isolatedHome;
    process.env.AGENT_STUDIO_HOME = path.join(isolatedHome, ".agent-studio");
    process.env.COPILOT_HOME = customCopilotHome;
    process.env.VSCODE_USER_DIR = path.join(isolatedHome, "missing-vscode-user");

    fs.mkdirSync(path.join(customCopilotHome, "agents"), { recursive: true });
    fs.mkdirSync(path.join(customCopilotHome, "skills", "copilot-global-skill"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(customCopilotHome, "agents", "global-helper.agent.md"),
      "---\nname: global-helper\ndescription: Global Copilot helper\n---\n\n# Global Helper\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(
        customCopilotHome,
        "skills",
        "copilot-global-skill",
        "SKILL.md",
      ),
      "---\nname: copilot-global-skill\ndescription: Global skill\n---\n\n# Global Skill\n",
      "utf8",
    );

    const detected = detectInstalledIdes({ homeDir: isolatedHome });
    assert.equal(detected["copilot-vscode"].installed, true);
    assert.ok(
      detected["copilot-vscode"].detectedPaths.includes(
        path.resolve(customCopilotHome),
      ),
    );

    const repo = makeTempDir("doc-warn-");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "doc-warn-app" }),
      "utf8",
    );
    await runInit([
      "--project",
      repo,
      "--ides",
      "antigravity,claude-code,copilot-vscode",
      "--non-interactive",
      "--quiet",
    ]);

    const details = await discoverTeamDetails([repo], repo, {
      includeGlobal: true,
      homeDir: isolatedHome,
      copilotHomeDir: customCopilotHome,
    });
    assert.ok(
      details.definitions.some(
        (d) => d.id === "global-helper" && d.source_ide === "copilot-vscode",
      ),
    );
    assert.ok(
      details.skills.some(
        (s) =>
          s.id === "copilot-global-skill" &&
          s.source_ide === "copilot-vscode",
      ),
    );

    // Plant stale legacy workspace artifacts + manually modified compiled file
    fs.mkdirSync(path.join(repo, ".vscode"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { "agent-studio": { command: "npx" } } }, null, 2),
      "utf8",
    );
    fs.mkdirSync(path.join(repo, ".github", "prompts"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".github", "prompts", "learn.prompt.md"),
      wrapGeneratedMarkdown("# Legacy learn", "description: learn"),
      "utf8",
    );
    const hooksPath = path.join(repo, ".github", "hooks", "agent-studio.json");
    const hooksJson = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    hooksJson.hooks.SessionStart = [
      { type: "command", command: "agent-studio hook-emit --ide copilot-vscode --event SessionStart" },
    ];
    fs.writeFileSync(hooksPath, JSON.stringify(hooksJson, null, 2), "utf8");

    const compiledAgent = path.join(repo, ".github", "agents", "qa-validator.agent.md");
    fs.appendFileSync(compiledAgent, "\n<!-- manual edit -->\n", "utf8");

    const docWithWarnings = buildDoctorReport(repo);
    assert.ok(
      docWithWarnings.migrationWarnings.some((w) => w.id === "legacy-vscode-mcp"),
    );
    assert.ok(
      docWithWarnings.migrationWarnings.some((w) => w.id === "legacy-learn-prompt"),
    );
    assert.ok(
      docWithWarnings.migrationWarnings.some((w) => w.id === "legacy-copilot-hooks"),
    );
    assert.ok(
      docWithWarnings.migrationWarnings.some((w) =>
        w.id?.startsWith("modified-compiled-"),
      ),
    );

    // Upgrade --force cleans all workspace legacy artifacts and restores zero drift + zero warnings
    const cleanRes = await runUpgrade(["--project", repo, "--force", "--quiet"]);
    assert.equal(cleanRes.ok, true);
    assert.equal(cleanRes.doctorReport?.ok, true);
    assert.equal(cleanRes.doctorReport?.migrationWarnings.length, 0);
  });

  it("BUG-28: rejects path traversal, UNC/drive/absolute paths, and control chars in .upgrade-state.json keys", () => {
    const validHash = "a".repeat(64);
    for (const badKey of [
      "../escape.md",
      "agents/../../escape.md",
      ".agent-team/../team.yaml",
      "/etc/passwd",
      "\\Windows\\System32\\cmd.exe",
      "//server/share/file.md",
      "\\\\server\\share\\file.md",
      "C:\\evil.md",
      "C:/evil.md",
      "agents/./foo.md",
      "agents/bad\0.md",
      "",
    ]) {
      assert.throws(
        () => normalizeUpgradeStateKey(badKey),
        `normalizeUpgradeStateKey should reject ${JSON.stringify(badKey)}`,
      );
      assert.throws(
        () =>
          parseUpgradeState(
            JSON.stringify({
              schemaVersion: 1,
              agentStudioVersion: "0.13.0",
              files: {
                [badKey]: {
                  stockHash: validHash,
                  customized: false,
                  templateVersion: "0.13.0",
                },
              },
            }),
          ),
        `parseUpgradeState should reject key ${JSON.stringify(badKey)}`,
      );
    }
  });

  it("BUG-30: doctor credits shared .mcp.json in copilot-vscode fileCount and deduplicates modified-compiled-.mcp.json migrationWarnings", async () => {
    const repo = makeTempDir("doc-coalesce-");
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "coalesce-app" }),
      "utf8",
    );
    await runInit([
      "--project",
      repo,
      "--ides",
      "antigravity,claude-code,copilot-vscode",
      "--non-interactive",
      "--quiet",
    ]);

    const cleanDoc = buildDoctorReport(repo);
    assert.equal(cleanDoc.ok, true);
    // Default repo has 8 agents + 10 skills + copilot-instructions.md + hooks + shared .mcp.json = 21
    assert.equal(cleanDoc.adapters["copilot-vscode"].fileCount, 21);

    // Corrupt coalesced .mcp.json so computeDrift marks it "modified" for both claude-code and copilot-vscode
    fs.writeFileSync(path.join(repo, ".mcp.json"), "{ invalid json", "utf8");

    const warnDoc = buildDoctorReport(repo);
    assert.equal(warnDoc.ok, false);
    const mcpWarnings = warnDoc.migrationWarnings.filter(
      (w) => w.id === "modified-compiled-.mcp.json",
    );
    assert.equal(
      mcpWarnings.length,
      1,
      "coalesced .mcp.json drift must emit exactly one deduplicated migrationWarning",
    );
    assert.equal(mcpWarnings[0]?.ide, "claude-code, copilot-vscode");
  });

  it("recovers stale lockfiles via atomic rename without unlinking a fresh contender's lockfile", async () => {
    const lockDir = makeTempDir("lock-race-");
    const targetFile = path.join(lockDir, "model-index.json");
    const lockFile = `${targetFile}.lock`;
    fs.writeFileSync(targetFile, "{}\n", "utf8");
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 999999, token: "stale-token" }),
      "utf8",
    );
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, oldTime, oldTime);

    const events: string[] = [];
    await Promise.all([
      withFileLock(
        targetFile,
        async () => {
          events.push("w1-start");
          await new Promise((r) => setTimeout(r, 40));
          events.push("w1-end");
        },
        { staleMs: 1_000, timeoutMs: 5_000, retryDelayMs: 5 },
      ),
      withFileLock(
        targetFile,
        async () => {
          events.push("w2-start");
          await new Promise((r) => setTimeout(r, 20));
          events.push("w2-end");
        },
        { staleMs: 1_000, timeoutMs: 5_000, retryDelayMs: 5 },
      ),
    ]);

    assert.equal(events.length, 4);
    assert.ok(
      (events[0] === "w1-start" && events[1] === "w1-end") ||
        (events[0] === "w2-start" && events[1] === "w2-end"),
      `lock holders must not overlap: ${events.join(", ")}`,
    );
    assert.equal(fs.existsSync(lockFile), false);
  });
});
