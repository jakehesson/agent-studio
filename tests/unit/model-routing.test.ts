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
  getFileLockPath,
  getGlobalModelIndexPath,
  getTeamYamlPath,
  getWorkspaceModelIndexPath,
  inferModelTier,
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
    assert.equal(validated.roleRecommendations.orchestrator?.tier, "fast");
    assert.equal(validated.roleRecommendations.architect?.tier, "reasoning");
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

    // Check Antigravity orchestrator -> flash_lite
    const agyOrchFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".agents", "plugins", "policy-app-team", "agents", "orchestrator.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown };
    assert.equal(agyOrchFm.model, "flash_lite");

    // Check Claude Code architect -> opus
    const ccArchFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(path.join(repo, ".claude", "agents", "architect.md"), "utf8"),
      ).frontmatter ?? "",
    ) as { model?: unknown };
    assert.equal(ccArchFm.model, "opus");

    // Check Copilot backend-engineer -> picker array + model-policy: preferred; orchestrator handoffs omit model by default
    const vscBackendFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".github", "agents", "backend-engineer.agent.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { model?: unknown; "model-policy"?: string };
    assert.ok(Array.isArray(vscBackendFm.model));
    assert.equal((vscBackendFm.model as string[])[0], "Claude Sonnet 4.5 (copilot)");
    assert.equal(vscBackendFm["model-policy"], "preferred");

    const vscOrchFm = parseYaml(
      splitFrontmatter(
        fs.readFileSync(
          path.join(repo, ".github", "agents", "orchestrator.agent.md"),
          "utf8",
        ),
      ).frontmatter ?? "",
    ) as { handoffs?: Array<{ agent: string; model?: string }> };
    assert.ok(
      vscOrchFm.handoffs?.every((h) => h.model === undefined),
      "handoffs[].model must be omitted by default",
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
      ["set-tier", "copilot-vscode", "balanced", "GPT-4.1 (copilot)", "--scope", "global", "--quiet"],
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
    assert.equal(vscBackendGlobal.model?.[0], "GPT-4.1 (copilot)");
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
    assert.equal(vscPinned.model, "Claude Sonnet 4.5 (copilot)");
    assert.equal(vscPinned["model-policy"], "required");

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
      "handoffs[].model emitted when copilotHandoffModels is true",
    );

    // 4. Direct resolveRoleModel precedence check (override { omit: true } and per-IDE policy)
    const manifest = parseTeamYaml(fs.readFileSync(getTeamYamlPath(repo), "utf8"));
    const backend = manifest.roster.find((r) => r.id === "backend-engineer")!;
    backend.models = { antigravity: { omit: true } };
    const omitted = resolveRoleModel(manifest, backend, "antigravity", DEFAULT_MODEL_INDEX);
    assert.equal(omitted.omit, true);
    assert.equal(omitted.frontmatterModel, undefined);

    // 5. Global install emits model: inherit for AGY & CC and omits for Copilot
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
          path.join(tmpDir, "vscode-user", "prompts", "team-setup.agent.md"),
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
    assert.equal(vscBackend.model, "Claude Sonnet 4.5 (copilot)");
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
});
