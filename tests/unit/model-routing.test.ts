import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { buildDoctorReport } from "../../src/cli/commands/doctor.js";
import { runModelsCli } from "../../src/cli/commands/models.js";
import { runSync } from "../../src/cli/commands/sync.js";
import {
  checkTeamDrift,
  compileTeam,
  installGlobalSetupAgent,
} from "../../src/compiler/index.js";
import { splitFrontmatter } from "../../src/compiler/shared.js";
import {
  DEFAULT_MODEL_INDEX,
  LEGACY_COPILOT_MODEL_ALIASES,
  accuracyScore,
  defaultTierForRoleType,
  getFileLockPath,
  getGlobalModelIndexPath,
  getTeamYamlPath,
  getWorkspaceModelIndexPath,
  inferModelTier,
  isLegacyCopilotPickerId,
  normalizeCopilotModelId,
  normalizeLegacyCopilotModelId,
  rankCatalogModelsForTier,
  resolveEffectiveModelIndex,
  resolveRoleModel,
  updateModelIndexOverlay,
  withTeamYamlLock,
  writeModelIndexAtomic,
} from "../../src/models/index.js";
import { ModelIndexSchema } from "../../src/schema/model-index.js";
import {
  parseTeamYaml,
  serializeTeamYaml,
} from "../../src/schema/team.js";
import { discoverTeamDetails } from "../../src/telemetry/definitions.js";
import { scaffoldAgentTeam } from "../../src/templates/index.js";

describe("Per-Role Model Routing, 3-Layer Model Index & Compilers", () => {
  let tmpDir: string;
  let origHome: string | undefined;
  let origStudioHome: string | undefined;
  let origVscodeUserDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "av-model-routing-"));
    origHome = process.env.HOME;
    origStudioHome = process.env.AGENT_STUDIO_HOME;
    origVscodeUserDir = process.env.VSCODE_USER_DIR;
    process.env.HOME = tmpDir;
    process.env.AGENT_STUDIO_HOME = path.join(tmpDir, ".agent-studio");
    process.env.VSCODE_USER_DIR = path.join(tmpDir, "vscode-user");
  });

  afterEach(() => {
    process.exitCode = 0;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origStudioHome === undefined) delete process.env.AGENT_STUDIO_HOME;
    else process.env.AGENT_STUDIO_HOME = origStudioHome;
    if (origVscodeUserDir === undefined) delete process.env.VSCODE_USER_DIR;
    else process.env.VSCODE_USER_DIR = origVscodeUserDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates DEFAULT_MODEL_INDEX and enforces 3-layer overlay merge & vscode-lm availability propagation", async () => {
    const validated = ModelIndexSchema.parse(DEFAULT_MODEL_INDEX);
    assert.equal(validated.roleRecommendations.orchestrator?.tier, "balanced");
    assert.equal(validated.roleRecommendations["qa-validator"]?.tier, "balanced");
    assert.equal(validated.roleRecommendations.architect?.tier, "reasoning");
    assert.equal(
      validated.roleRecommendations["code-reviewer"]?.tier,
      "reasoning",
    );
    assert.equal(
      defaultTierForRoleType("specialist", "code-reviewer"),
      "reasoning",
    );
    assert.equal(
      validated.roleRecommendations["ux-designer"]?.multimodalPreferred,
      true,
    );

    const repo = path.join(tmpDir, "repo-overlay");
    fs.mkdirSync(path.join(repo, ".agent-team"), { recursive: true });

    // Layer 1 (global) adds a new vscode-lm model, overrides balanced primary, and marks a previously synced model unavailable
    await writeModelIndexAtomic(getGlobalModelIndexPath(), {
      schemaVersion: 1,
      updatedAt: "2026-11-25T01:00:00Z",
      updatedBy: "vscode-lm",
      ides: {
        "copilot-vscode": {
          tiers: {
            balanced: { primary: "GPT-4.1 (copilot)" },
          },
          catalog: [
            {
              id: "GPT-5 Codex (copilot)",
              label: "GPT-5 Codex",
              vendor: "copilot",
              family: "gpt-5",
              tier: "balanced",
              capabilities: ["coding"],
              available: true,
              source: "vscode-lm",
              discoveredAt: "2026-11-25T01:00:00Z",
            },
            {
              id: "Claude Sonnet 3.7 (copilot)",
              label: "Claude Sonnet 3.7",
              vendor: "copilot",
              tier: "balanced",
              capabilities: ["coding"],
              available: false,
              source: "vscode-lm",
              discoveredAt: "2026-11-25T01:00:00Z",
            },
          ],
        },
      },
    });

    // Layer 2 (workspace) overrides balanced tier primary, keeps stale vscode-lm available:true, AND explicitly pins a user entry
    await writeModelIndexAtomic(getWorkspaceModelIndexPath(repo), {
      schemaVersion: 1,
      updatedAt: "2026-11-25T02:00:00Z",
      updatedBy: "cli",
      roleRecommendations: {
        "qa-validator": {
          tier: "balanced",
          rationale: "Custom QA override in workspace",
        },
      },
      ides: {
        "copilot-vscode": {
          tiers: {
            balanced: { primary: "Claude Sonnet 4.5 (copilot)" },
          },
          catalog: [
            {
              id: "Claude Sonnet 3.7 (copilot)",
              label: "Claude Sonnet 3.7",
              vendor: "copilot",
              tier: "balanced",
              capabilities: ["coding"],
              available: true,
              source: "vscode-lm",
            },
            {
              id: "User Pinned Model (copilot)",
              label: "User Pinned Model",
              vendor: "copilot",
              tier: "reasoning",
              capabilities: ["reasoning"],
              available: true,
              source: "user",
            },
          ],
        },
      },
    });

    const effective = resolveEffectiveModelIndex({ projectRoot: repo, useGlobal: true });
    // Layer 2 > Layer 1 > Layer 0 for tier primary & role recommendation
    assert.equal(
      effective.ides["copilot-vscode"].tiers.balanced.primary,
      "Claude Sonnet 4.5 (copilot)",
    );
    assert.equal(effective.roleRecommendations["qa-validator"]?.tier, "balanced");
    // Layer 1 discovered entry remains visible in effective catalog even though Layer 2 exists
    assert.ok(
      effective.ides["copilot-vscode"].catalog.some(
        (c) => c.id === "GPT-5 Codex (copilot)" && c.available === true,
      ),
    );
    // Layer 1 live available: false propagates over Layer 2 non-user/non-agent vscode-lm entry
    const staleEntry = effective.ides["copilot-vscode"].catalog.find(
      (c) => c.id === "Claude Sonnet 3.7 (copilot)",
    );
    assert.equal(staleEntry?.available, false);

    // If Layer 2 explicitly sets source: "user", availability remains true even if Layer 1 marks unavailable
    await updateModelIndexOverlay(getGlobalModelIndexPath(), (cur) => ({
      ...cur!,
      ides: {
        "copilot-vscode": {
          catalog: [
            ...(cur?.ides?.["copilot-vscode"]?.catalog ?? []),
            {
              id: "User Pinned Model (copilot)",
              label: "User Pinned Model",
              tier: "reasoning",
              capabilities: ["reasoning"],
              available: false,
              source: "vscode-lm",
            },
          ],
        },
      },
    }));
    const effective2 = resolveEffectiveModelIndex({ projectRoot: repo, useGlobal: true });
    assert.equal(
      effective2.ides["copilot-vscode"].catalog.find(
        (c) => c.id === "User Pinned Model (copilot)",
      )?.available,
      true,
    );
  });

  it("serializes concurrent atomic model-index and team.yaml updates via lockfiles without data loss or stale locks", async () => {
    const repo = path.join(tmpDir, "repo-lock");
    scaffoldAgentTeam(repo, { projectId: "lock-app", projectTitle: "Lock App" });

    const indexPath = getWorkspaceModelIndexPath(repo);
    const lockPath = getFileLockPath(indexPath);

    // Create a stale lockfile (> staleMs) and verify recovery
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999 }), "utf8");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, past, past);

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        updateModelIndexOverlay(
          indexPath,
          (cur) => {
            const next = JSON.parse(JSON.stringify(cur ?? { schemaVersion: 1 })) as {
              schemaVersion: 1;
              ides?: { antigravity?: { catalog?: Array<{ id: string; label: string; tier: "fast"; capabilities: []; available: true; source: "user" }> } };
            };
            next.ides ??= {};
            next.ides.antigravity ??= {};
            next.ides.antigravity.catalog = [
              ...(next.ides.antigravity.catalog ?? []),
              {
                id: `custom-model-${n}`,
                label: `Custom Model ${n}`,
                tier: "fast",
                capabilities: [],
                available: true,
                source: "user",
              },
            ];
            return next;
          },
          { staleMs: 5_000, timeoutMs: 10_000 },
        ),
      ),
    );

    assert.equal(fs.existsSync(lockPath), false, "lockfile must be cleaned up");
    const effective = resolveEffectiveModelIndex({ projectRoot: repo, useGlobal: false });
    for (let n = 1; n <= 5; n++) {
      assert.ok(
        effective.ides.antigravity.catalog.some((c) => c.id === `custom-model-${n}`),
        `missing concurrent entry custom-model-${n}`,
      );
    }

    // Concurrent team.yaml lock updates
    const teamPath = getTeamYamlPath(repo);
    await Promise.all(
      ["orchestrator", "qa-validator"].map((roleId) =>
        withTeamYamlLock(teamPath, (manifest) => {
          const r = manifest.roster.find((x) => x.id === roleId);
          if (r) r.modelPolicy = "defer-to-host";
        }),
      ),
    );
    const afterManifest = parseTeamYaml(fs.readFileSync(teamPath, "utf8"));
    assert.equal(
      afterManifest.roster.find((r) => r.id === "orchestrator")?.modelPolicy,
      "defer-to-host",
    );
    assert.equal(
      afterManifest.roster.find((r) => r.id === "qa-validator")?.modelPolicy,
      "defer-to-host",
    );
    assert.equal(fs.existsSync(getFileLockPath(teamPath)), false);
  });

  it("resolves models across prefer-fallback, defer-to-host, and pinned policies and compiles all 3 IDEs deterministically", async () => {
    const repo = path.join(tmpDir, "repo-policies");
    scaffoldAgentTeam(repo, { projectId: "policy-app", projectTitle: "Policy App" });

    // 1. Default (prefer-fallback) compilation
    compileTeam(repo);

    // Check Antigravity orchestrator -> inherit (honoring deferToHostOrchestrator && respectBuiltInOrchestrators)
    const agyOrchFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".agents", "plugins", "policy-app-team", "agents", "orchestrator.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown };
    assert.equal(agyOrchFm.model, "inherit");

    // When respectBuiltInOrchestrators is false, Antigravity orchestrator falls back to balanced tier binding (flash)
    const policyManifest = parseTeamYaml(fs.readFileSync(getTeamYamlPath(repo), "utf8"));
    const policyOrch = policyManifest.roster.find((r) => r.id === "orchestrator")!;
    policyManifest.workflow.modelRouting = {
      ...policyManifest.workflow.modelRouting,
      policy: "prefer-fallback",
      respectBuiltInOrchestrators: false,
      allowSubagentModelHints: true,
      copilotHandoffModels: false,
      selectionPriority: ["accuracy", "cost", "speed"],
    };
    const agyOrchOptOut = resolveRoleModel(
      policyManifest,
      policyOrch,
      "antigravity",
      DEFAULT_MODEL_INDEX,
    );
    assert.equal(agyOrchOptOut.frontmatterModel, "flash");

    // Cross-IDE deferToHostOrchestrator: Copilot omits orchestrator model under respectBuiltInOrchestrators: true,
    // while emitting balanced array under respectBuiltInOrchestrators: false.
    const vscOrchDefault = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".github", "agents", "orchestrator.agent.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown; "model-policy"?: string; handoffs?: Array<{ agent: string; model?: string }> };
    assert.equal(vscOrchDefault.model, undefined);
    assert.equal(vscOrchDefault["model-policy"], undefined);
    const vscOrchOptOut = resolveRoleModel(
      policyManifest,
      policyOrch,
      "copilot-vscode",
      DEFAULT_MODEL_INDEX,
    );
    assert.equal(vscOrchOptOut.omit, false);
    assert.equal(vscOrchOptOut.primaryModel, "claude-sonnet-4.6");

    // Check Claude Code architect -> opus
    const ccArchFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(path.join(repo, ".claude", "agents", "architect.md"), "utf8"),
      ).frontmatter ?? "",
    ) as { model?: unknown };
    assert.equal(ccArchFm.model, "opus");

    // Check code-reviewer across all 3 IDEs -> pro / opus / claude-opus-4.6 fallback array
    const agyRevFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".agents", "plugins", "policy-app-team", "agents", "code-reviewer.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown };
    assert.equal(agyRevFm.model, "pro");

    const ccRevFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(path.join(repo, ".claude", "agents", "code-reviewer.md"), "utf8"),
      ).frontmatter ?? "",
    ) as { model?: unknown };
    assert.equal(ccRevFm.model, "opus");

    const vscRevFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".github", "agents", "code-reviewer.agent.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown; "model-policy"?: string };
    assert.ok(Array.isArray(vscRevFm.model));
    assert.equal((vscRevFm.model as string[])[0], "claude-opus-4.6");
    assert.equal(vscRevFm["model-policy"], "preferred");

    // Check Copilot backend-engineer -> picker array + model-policy: preferred; orchestrator handoffs omitted in copilot mode
    const vscBackendFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".github", "agents", "backend-engineer.agent.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown; "model-policy"?: string };
    assert.ok(Array.isArray(vscBackendFm.model));
    assert.equal((vscBackendFm.model as string[])[0], "claude-sonnet-4.6");
    assert.equal(vscBackendFm["model-policy"], "preferred");

    assert.equal(
      vscOrchDefault.handoffs,
      undefined,
      "handoffs must be omitted in copilot harness mode",
    );

    // Shared rules include Model Routing & Host Compatibility section
    assert.ok(
      fs
        .readFileSync(path.join(repo, "CLAUDE.md"), "utf8")
        .includes("## Model Routing & Host Compatibility"),
    );

    // CI Determinism: modifying Layer 1 global overlay must NOT trigger drift in checkTeamDrift / sync --check
    // Use a sparse Layer 2 overlay (without tiers.balanced) so Layer 1 can show through when --use-global-index is passed
    await writeModelIndexAtomic(getWorkspaceModelIndexPath(repo), {
      schemaVersion: 1,
      updatedAt: "2026-11-25T00:00:00Z",
      updatedBy: "cli",
    });
    compileTeam(repo);
    await runModelsCli(
      ["set-tier", "copilot-vscode", "balanced", "gpt-4.1", "--scope", "global", "--quiet"],
    );
    const deterministicDrift = checkTeamDrift(repo);
    assert.equal(deterministicDrift.ok, true, "Layer 1 global change must not break CI sync --check");

    // Explicit --use-global-index opts into Layer 1
    await runSync(["--project", repo, "--use-global-index", "--quiet"]);
    const vscBackendGlobal = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".github", "agents", "backend-engineer.agent.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: string[] };
    assert.equal(vscBackendGlobal.model?.[0], "gpt-4.1");
    // Restore workspace default seed before continuing policy assertions
    await runModelsCli(["reset", "--scope", "workspace", "--project", repo, "--sync", "--quiet"]);

    // 2. defer-to-host policy -> inherit for AGY/CC, omit model & model-policy completely for Copilot
    await runModelsCli(["set-policy", "defer-to-host", "--project", repo, "--sync", "--quiet"]);
    const agyDefer = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".agents", "plugins", "policy-app-team", "agents", "backend-engineer.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown };
    const ccDefer = parseYaml(
      splitFrontmatter(
        fs.readFileSync(path.join(repo, ".claude", "agents", "backend-engineer.md"), "utf8"),
      ).frontmatter ?? "",
    ) as { model?: unknown };
    const vscDefer = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".github", "agents", "backend-engineer.agent.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown; "model-policy"?: unknown };
    assert.equal(agyDefer.model, "inherit");
    assert.equal(ccDefer.model, "inherit");
    assert.equal(vscDefer.model, undefined);
    assert.equal(vscDefer["model-policy"], undefined);

    // 3. pinned policy + copilotHandoffModels: true
    await runModelsCli([
      "set-policy",
      "pinned",
      "--handoff-models",
      "true",
      "--project",
      repo,
      "--sync",
      "--quiet",
    ]);
    const vscPinned = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".github", "agents", "backend-engineer.agent.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown; "model-policy"?: unknown };
    assert.equal(vscPinned.model, "claude-sonnet-4.6");
    assert.equal(vscPinned["model-policy"], "required");

    // In legacy-local harness mode, copilotHandoffModels: true emits model on handoffs
    await withTeamYamlLock(getTeamYamlPath(repo), (m) => {
      m.workflow.copilotHarness = "legacy-local";
    });
    compileTeam(repo);
    const vscOrchPinned = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".github", "agents", "orchestrator.agent.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { handoffs?: Array<{ agent: string; model?: string }> };
    assert.ok(
      vscOrchPinned.handoffs?.some((h) => h.agent === "backend-engineer" && Boolean(h.model)),
      "handoffs[].model emitted in legacy-local mode when copilotHandoffModels is true",
    );

    // 4. agent-studio models set-questions toggles mode and syncs IDE rules
    await runModelsCli(["set-questions", "native-ide", "--project", repo, "--sync", "--quiet"]);
    const manifestNative = parseTeamYaml(
      fs.readFileSync(path.join(repo, ".agent-team", "team.yaml"), "utf8"),
    );
    assert.equal(manifestNative.workflow.humanQuestions, "native-ide");
    const rulesNative = fs.readFileSync(
      path.join(repo, ".agents", "plugins", "policy-app-team", "rules", "AGENTS.md"),
      "utf8",
    );
    assert.match(rulesNative, /Use your host IDE's native question dialog/);

    await runModelsCli(["set-questions", "studio-mcp", "--project", repo, "--sync", "--quiet"]);
    const manifestMcp = parseTeamYaml(
      fs.readFileSync(path.join(repo, ".agent-team", "team.yaml"), "utf8"),
    );
    assert.equal(manifestMcp.workflow.humanQuestions, "studio-mcp");
    const rulesMcp = fs.readFileSync(
      path.join(repo, ".agents", "plugins", "policy-app-team", "rules", "AGENTS.md"),
      "utf8",
    );
    assert.match(rulesMcp, /NEVER use native ask tools/);

    // 4. Direct resolveRoleModel precedence check (override { omit: true } and per-IDE policy)
    const manifest = parseTeamYaml(fs.readFileSync(getTeamYamlPath(repo), "utf8"));
    const backend = manifest.roster.find((r) => r.id === "backend-engineer")!;
    backend.models = { antigravity: { omit: true } };
    const omitted = resolveRoleModel(manifest, backend, "antigravity", DEFAULT_MODEL_INDEX);
    assert.equal(omitted.omit, true);
    assert.equal(omitted.frontmatterModel, undefined);

    // 5. Global install emits model: inherit for AGY & CC and omits for Copilot (in $COPILOT_HOME)
    installGlobalSetupAgent({ homeDir: tmpDir });
    const globalAgyFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(tmpDir, ".gemini", "config", "plugins", "agent-studio", "agents", "team-setup.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown };
    const globalCcFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(path.join(tmpDir, ".claude", "agents", "team-setup.md"), "utf8"),
      ).frontmatter ?? "",
    ) as { model?: unknown };
    const globalVscFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(tmpDir, ".copilot", "agents", "team-setup.agent.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown };
    assert.equal(globalAgyFm.model, "inherit");
    assert.equal(globalCcFm.model, "inherit");
    assert.equal(globalVscFm.model, undefined);
  });

  it("parses YAML array meta.model in definitions.ts and enriches TeamDetails additively", async () => {
    const repo = path.join(tmpDir, "repo-defs");
    scaffoldAgentTeam(repo, { projectId: "defs-app", projectTitle: "Defs App" });
    compileTeam(repo);

    const details = await discoverTeamDetails([repo], repo, { includeGlobal: false });
    assert.ok(details.modelRouting);
    assert.equal(details.modelRouting.policy, "prefer-fallback");
    assert.ok(details.modelIndexSummary);
    assert.equal(details.modelIndexSummary.hasWorkspaceOverlay, true);

    const vscBackend = details.definitions.find(
      (d) => d.source_ide === "copilot-vscode" && d.id === "backend-engineer",
    );
    assert.ok(vscBackend);
    assert.equal(vscBackend.model, "claude-sonnet-4.6");
    assert.ok(
      Array.isArray(vscBackend.modelFallbacks) && vscBackend.modelFallbacks.length >= 2,
    );
    assert.equal(vscBackend.modelPolicy, "preferred");

    const rosterBackend = details.roster.find((r) => r.id === "backend-engineer");
    assert.equal(rosterBackend?.modelTier, "balanced");
    assert.equal(
      rosterBackend?.resolvedModels?.["copilot-vscode"]?.copilotPolicy,
      "preferred",
    );
  });

  it("runs CLI models show|set-tier|set-role|upsert|discover|adopt|reset and doctor modelIndex checks", async () => {
    const repo = path.join(tmpDir, "repo-cli");
    scaffoldAgentTeam(repo, { projectId: "cli-app", projectTitle: "CLI App" });
    compileTeam(repo);

    // Ensure vscode-user dir exists so doctor detects copilot-vscode as installed
    fs.mkdirSync(process.env.VSCODE_USER_DIR!, { recursive: true });

    // Tier inference checks
    assert.equal(inferModelTier("Claude Haiku 4.5 (copilot)"), "fast");
    assert.equal(inferModelTier("o3-mini"), "reasoning");
    assert.equal(inferModelTier("GPT-4o mini (copilot)"), "fast");
    assert.equal(inferModelTier("Claude Sonnet 4.5 (copilot)"), "balanced");

    // 1. CLI discover into global via stdinText
    await runModelsCli(
      ["discover", "--ide", "copilot-vscode", "--scope", "global", "--project", repo, "--quiet"],
      {
        stdinText: JSON.stringify([
          { id: "Claude Sonnet 4.5 (copilot)", label: "Claude Sonnet 4.5", vendor: "copilot" },
          { id: "Legacy Preview (copilot)", label: "Legacy Preview", vendor: "copilot" },
        ]),
      },
    );

    // Re-discover without Legacy Preview -> marks it available: false
    await runModelsCli(
      ["discover", "--ide", "copilot-vscode", "--scope", "global", "--project", repo, "--quiet"],
      {
        stdinText: JSON.stringify([
          { id: "Claude Sonnet 4.5 (copilot)", label: "Claude Sonnet 4.5", vendor: "copilot" },
        ]),
      },
    );

    // 2. CLI adopt copies live Layer 1 models into Layer 2 workspace
    const adoptRes = (await runModelsCli([
      "adopt",
      "--ide",
      "copilot-vscode",
      "--project",
      repo,
      "--sync",
      "--quiet",
    ])) as { adoptedCatalogCount: number };
    assert.ok(adoptRes.adoptedCatalogCount >= 1);

    // 3. CLI upsert + set-tier + set-role + show
    await runModelsCli([
      "upsert",
      "--ide",
      "antigravity",
      "--id",
      "gemini-custom-fast",
      "--tier",
      "fast",
      "--project",
      repo,
      "--quiet",
    ]);
    await runModelsCli([
      "set-role",
      "backend-engineer",
      "--ide",
      "copilot-vscode",
      "--model",
      "Legacy Preview (copilot)",
      "--project",
      repo,
      "--sync",
      "--quiet",
    ]);

    const showRes = (await runModelsCli([
      "show",
      "--project",
      repo,
      "--ide",
      "copilot-vscode",
      "--quiet",
    ])) as { ok: boolean; resolvedRoles: Array<{ id: string }> };
    assert.equal(showRes.ok, true);
    assert.ok(showRes.resolvedRoles.length >= 5);

    // 4. Doctor check detects unavailable vscode-lm override warning
    const docWarn = buildDoctorReport(repo);
    assert.equal(docWarn.ok, true);
    assert.equal(docWarn.modelIndex.valid, true);
    assert.ok(
      docWarn.modelIndex.warnings.some((w) => w.includes("Legacy Preview (copilot)")),
    );

    // 5. Pinned policy triggers Copilot model-policy: required warning
    await runModelsCli(["set-policy", "pinned", "--project", repo, "--sync", "--quiet"]);
    const docPinned = buildDoctorReport(repo);
    assert.ok(
      docPinned.modelIndex.warnings.some((w) => w.includes("model-policy: required")),
    );

    // 6. Malformed workspace model-index.json sets modelIndex.valid = false & doctor.ok = false
    fs.writeFileSync(getWorkspaceModelIndexPath(repo), "{ not valid json", "utf8");
    const docBroken = buildDoctorReport(repo);
    assert.equal(docBroken.modelIndex.valid, false);
    assert.equal(docBroken.ok, false);
    assert.ok(docBroken.modelIndex.errors.length >= 1);

    // 7. Reset repairs workspace model-index cleanly
    await runModelsCli(["reset", "--scope", "workspace", "--project", repo, "--sync", "--quiet"]);
    const docRepaired = buildDoctorReport(repo);
    assert.equal(docRepaired.modelIndex.valid, true);
  });

  it("ranks models deterministically by Accuracy -> Cost -> Speed, filters unavailable/deprecated entries, and auto-ranks untouched tiers on vscode-lm discovery", async () => {
    // 1. Accuracy -> Cost -> Speed + deprecated exclusion
    const rankedFast = rankCatalogModelsForTier(
      DEFAULT_MODEL_INDEX.ides["copilot-vscode"].catalog,
      "fast",
    );
    assert.equal(rankedFast[0]?.id, "gemini-3-flash");
    assert.ok(
      rankedFast.findIndex((m) => m.id === "claude-haiku-4.5") >
        rankedFast.findIndex((m) => m.id === "gpt-5-mini"),
      "deprecated claude-haiku-4.5 must rank below modern fast models",
    );
    assert.equal(
      DEFAULT_MODEL_INDEX.ides["copilot-vscode"].catalog.find(
        (m) => m.id === "gpt-4.1",
      )?.contextWindow,
      1_000_000,
    );

    // 2. Cost tie-breaker when accuracyRank is identical
    const tieRanked = rankCatalogModelsForTier(
      [
        {
          id: "Expensive-A",
          label: "Expensive A",
          tier: "balanced",
          capabilities: ["coding"],
          accuracyRank: 85,
          premiumMultiplier: 3,
          speedRank: 90,
          available: true,
          source: "built-in",
        },
        {
          id: "Cheaper-B",
          label: "Cheaper B",
          tier: "balanced",
          capabilities: ["coding"],
          accuracyRank: 85,
          premiumMultiplier: 0.33,
          speedRank: 70,
          available: true,
          source: "built-in",
        },
      ],
      "balanced",
    );
    assert.equal(tieRanked[0]?.id, "Cheaper-B");

    // 3. resolveRoleModel filters out catalog entries marked available: false
    const repo = path.join(tmpDir, "repo-avail-filter");
    scaffoldAgentTeam(repo, { projectId: "avail-app", projectTitle: "Avail App" });
    const manifest = parseTeamYaml(fs.readFileSync(getTeamYamlPath(repo), "utf8"));
    const backend = manifest.roster.find((r) => r.id === "backend-engineer")!;
    const filteredIdx = resolveEffectiveModelIndex({
      projectRoot: repo,
      useGlobal: true,
      globalOverlay: {
        schemaVersion: 1,
        ides: {
          "copilot-vscode": {
            catalog: [
              {
                id: "claude-sonnet-4.6",
                label: "Claude Sonnet 4.6",
                tier: "balanced",
                capabilities: ["coding"],
                available: false,
                source: "vscode-lm",
              },
            ],
          },
        },
      },
    });
    const resolvedBackend = resolveRoleModel(
      manifest,
      backend,
      "copilot-vscode",
      filteredIdx,
    );
    assert.equal(resolvedBackend.primaryModel, "gpt-5.4");
    assert.ok(
      !resolvedBackend.fallbackModels.includes("claude-sonnet-4.6"),
    );

    // 4. applyDiscoveredModels auto-ranks untouched tiers and preserves explicit user overrides
    await runModelsCli(
      ["discover", "--ide", "copilot-vscode", "--scope", "global", "--project", repo, "--quiet"],
      {
        stdinText: JSON.stringify([
          {
            id: "mai-code-2",
            label: "Mai Code 2",
            vendor: "copilot",
            family: "mai-code-2",
            version: "mai-code-2",
            maxInputTokens: 921_805,
          },
          {
            id: "claude-sonnet-4.6",
            label: "Claude Sonnet 4.6",
            vendor: "copilot",
            family: "claude-sonnet-4.6",
            maxInputTokens: 200_000,
          },
        ]),
      },
    );
    const afterDiscover = resolveEffectiveModelIndex({
      projectRoot: repo,
      useGlobal: true,
    });
    assert.equal(
      afterDiscover.ides["copilot-vscode"].tiers.balanced.primary,
      "claude-sonnet-4.6",
    );

    // Explicit user override via set-tier must NOT be overwritten by subsequent discovery
    await writeModelIndexAtomic(getWorkspaceModelIndexPath(repo), {
      schemaVersion: 1,
      updatedAt: "2026-11-26T00:00:00Z",
      updatedBy: "cli",
    });
    await runModelsCli([
      "set-tier",
      "copilot-vscode",
      "balanced",
      "mai-code-2",
      "--scope",
      "global",
      "--quiet",
    ]);
    await runModelsCli(
      ["discover", "--ide", "copilot-vscode", "--scope", "global", "--project", repo, "--quiet"],
      {
        stdinText: JSON.stringify([
          {
            id: "mai-code-2",
            label: "Mai Code 2",
            vendor: "copilot",
            family: "mai-code-2",
            maxInputTokens: 921_805,
          },
          {
            id: "claude-sonnet-4.6",
            label: "Claude Sonnet 4.6",
            vendor: "copilot",
            family: "claude-sonnet-4.6",
            maxInputTokens: 200_000,
          },
        ]),
      },
    );
    const afterManual = resolveEffectiveModelIndex({
      projectRoot: repo,
      useGlobal: true,
    });
    assert.equal(
      afterManual.ides["copilot-vscode"].tiers.balanced.primary,
      "mai-code-2",
    );

    // 5. Hyphenated version matching in accuracyScore
    assert.equal(
      accuracyScore({
        id: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        tier: "reasoning",
        capabilities: ["reasoning"],
        available: true,
        source: "built-in",
      }),
      100,
    );
    assert.equal(
      accuracyScore({
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        tier: "balanced",
        capabilities: ["coding"],
        available: true,
        source: "built-in",
      }),
      88,
    );
  });

  it("maps legacy built-in Copilot picker IDs deterministically while preserving custom/BYOK IDs", () => {
    assert.equal(Object.keys(LEGACY_COPILOT_MODEL_ALIASES).length, 16);
    assert.equal(
      normalizeLegacyCopilotModelId("Claude Sonnet 4.6 (copilot)"),
      "claude-sonnet-4.6",
    );
    assert.equal(
      normalizeCopilotModelId("  claude   opus 4.6 (COPILOT)  "),
      "claude-opus-4.6",
    );
    assert.equal(normalizeLegacyCopilotModelId("GPT-5.4 (copilot)"), "gpt-5.4");
    assert.equal(
      isLegacyCopilotPickerId("Claude Sonnet 4.6 (copilot)"),
      true,
    );
    assert.equal(isLegacyCopilotPickerId("claude-sonnet-4.6"), false);

    // Custom / BYOK IDs must NEVER be rewritten
    assert.equal(
      normalizeLegacyCopilotModelId("custom/enterprise-byok-model"),
      "custom/enterprise-byok-model",
    );
    assert.equal(
      normalizeLegacyCopilotModelId("My Custom Org Model (copilot)"),
      "My Custom Org Model (copilot)",
    );

    // resolveRoleModel normalizes legacy pins in "copilot" mode, preserves in "legacy-local"
    const repo = path.join(tmpDir, "repo-alias-resolve");
    scaffoldAgentTeam(repo, { projectId: "alias-app", projectTitle: "Alias App" });
    const manifest = parseTeamYaml(fs.readFileSync(getTeamYamlPath(repo), "utf8"));
    const backend = manifest.roster.find((r) => r.id === "backend-engineer")!;
    backend.models = {
      "copilot-vscode": [
        "Claude Sonnet 4.6 (copilot)",
        "GPT-5.4 (copilot)",
        "custom/byok-fallback",
      ],
    };

    const resolvedCopilot = resolveRoleModel(
      manifest,
      backend,
      "copilot-vscode",
      DEFAULT_MODEL_INDEX,
    );
    assert.deepEqual(resolvedCopilot.frontmatterModel, [
      "claude-sonnet-4.6",
      "gpt-5.4",
      "custom/byok-fallback",
    ]);
    assert.equal(resolvedCopilot.primaryModel, "claude-sonnet-4.6");

    manifest.workflow.copilotHarness = "legacy-local";
    const resolvedLegacy = resolveRoleModel(
      manifest,
      backend,
      "copilot-vscode",
      DEFAULT_MODEL_INDEX,
    );
    assert.deepEqual(resolvedLegacy.frontmatterModel, [
      "Claude Sonnet 4.6 (copilot)",
      "GPT-5.4 (copilot)",
      "custom/byok-fallback",
    ]);
  });
});
