import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  BoardSchema,
  NormalizedEventSchema,
  SessionSnapshotSchema,
  TeamManifestSchema,
  createDeterministicEventId,
  parseBoardJson,
  parseTeamYaml,
  serializeTeamYaml,
} from "../../src/schema/index.js";

const REPO_ROOT = path.resolve(process.cwd());
const LEGACY_BOARD_PATH = path.join(REPO_ROOT, "tests", "fixtures", "legacy-board.json");

const SAMPLE_TEAM_YAML = `
schemaVersion: 1
project:
  id: agent-visualizer
  title: Agent Studio
  description: IDE-agnostic multi-agent orchestration & live monitoring studio
  mockupsDirs:
    - docs/mockups

targets:
  - antigravity
  - claude-code
  - copilot-vscode

workflow:
  boardPath: pipeline/board.json
  stages: [ready, design, dev, test, done]
  enforcement:
    orchestratorReadOnly: true
    qaGateRequired: true
    blockDirectBoardEdits: true
  suites:
    smoke: [CP0, CP1]
    full: [CP0, CP1, CP2]
  checkpoints:
    CP0:
      title: Static Typecheck & Unit Suite
      command: npm run check
      steps:
        - Run TypeScript typecheck and unit tests.
      pass: [Exit code 0 with zero errors.]
      fail: [Any compile or assertion failure.]

roster:
  - id: orchestrator
    name: Team Orchestrator
    roleType: orchestrator
    boardRole: orchestrator
    promptFile: agents/orchestrator.md
    capabilities: [read, search, delegate, ask_user, mcp_board]
    handoffs: [architect, backend-engineer, qa-validator]
  - id: backend-engineer
    name: Backend Engineer
    roleType: specialist
    boardRole: backend
    promptFile: agents/backend-engineer.md
    capabilities: [read, search, edit, shell, mcp_board]
  - id: qa-validator
    name: QA Validator
    roleType: qa
    boardRole: qa
    promptFile: agents/qa-validator.md
    capabilities: [read, search, edit_tests, shell, mcp_board, mcp_testrun]

skills:
  - skills/agile-board-workflow
  - skills/qa-validation
`;

describe("Schema validation (team.yaml, board.json, telemetry)", () => {
  it("parses and round-trips canonical .agent-team/team.yaml", () => {
    const manifest = parseTeamYaml(SAMPLE_TEAM_YAML);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.project.id, "agent-visualizer");
    assert.deepEqual(manifest.targets, [
      "antigravity",
      "claude-code",
      "copilot-vscode",
    ]);
    assert.equal(manifest.workflow.enforcement.qaGateRequired, true);
    assert.equal(manifest.roster.length, 3);
    assert.deepEqual(manifest.roster[0]?.capabilities, [
      "read",
      "search",
      "delegate",
      "ask_user",
      "mcp_board",
    ]);

    const yamlOut = serializeTeamYaml(manifest);
    const reparsed = parseTeamYaml(yamlOut);
    assert.deepEqual(reparsed, manifest);
  });

  it("rejects invalid team.yaml target and empty roster", () => {
    assert.throws(() =>
      TeamManifestSchema.parse({
        schemaVersion: 1,
        project: { id: "x", title: "X" },
        targets: ["invalid-ide"],
        roster: [],
      }),
    );
  });

  it("parses and round-trips team.yaml with optional modelRouting, modelTier, modelPolicy, and per-IDE models", () => {
    const withRouting = `${SAMPLE_TEAM_YAML}
workflow_model_note: ignored-passthrough
`;
    // Verify legacy SAMPLE_TEAM_YAML does not gain spurious model keys on serialize
    const legacy = parseTeamYaml(SAMPLE_TEAM_YAML);
    assert.equal(legacy.workflow.modelRouting, undefined);
    assert.equal(legacy.roster[0]?.modelTier, undefined);
    assert.ok(!serializeTeamYaml(legacy).includes("modelRouting"));
    assert.ok(withRouting.length > 0);

    const routingYaml = `
schemaVersion: 1
project:
  id: routed-app
  title: Routed App
targets: [antigravity, claude-code, copilot-vscode]
workflow:
  boardPath: pipeline/board.json
  stages: [ready, design, dev, test, done]
  modelRouting:
    policy: prefer-fallback
    respectBuiltInOrchestrators: true
    allowSubagentModelHints: true
    copilotHandoffModels: false
    idePolicies:
      copilot-vscode: defer-to-host
roster:
  - id: orchestrator
    name: Team Orchestrator
    roleType: orchestrator
    boardRole: orchestrator
    promptFile: agents/orchestrator.md
    capabilities: [read, delegate, mcp_board]
    modelTier: fast
    modelPolicy: defer-to-host
  - id: backend-engineer
    name: Backend Engineer
    roleType: specialist
    boardRole: backend
    promptFile: agents/backend-engineer.md
    capabilities: [read, edit, shell]
    modelTier: balanced
    models:
      antigravity: flash
      claude-code: sonnet
      copilot-vscode:
        - Claude Sonnet 4.5 (copilot)
        - GPT-4.1 (copilot)
skills: []
`;
    const parsed = parseTeamYaml(routingYaml);
    assert.equal(parsed.workflow.modelRouting?.policy, "prefer-fallback");
    assert.equal(
      parsed.workflow.modelRouting?.idePolicies?.["copilot-vscode"],
      "defer-to-host",
    );
    assert.equal(parsed.roster[0]?.modelTier, "fast");
    assert.equal(parsed.roster[0]?.modelPolicy, "defer-to-host");
    assert.deepEqual(parsed.roster[1]?.models?.["copilot-vscode"], [
      "Claude Sonnet 4.5 (copilot)",
      "GPT-4.1 (copilot)",
    ]);
    assert.deepEqual(parseTeamYaml(serializeTeamYaml(parsed)), parsed);
  });

  it("reads a temp copy of sanitized tests/fixtures/legacy-board.json with zero data loss", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "av-schema-board-"));
    try {
      const copyPath = path.join(tmpDir, "board.json");
      const rawText = await fs.readFile(LEGACY_BOARD_PATH, "utf8");
      await fs.writeFile(copyPath, rawText, "utf8");

      const originalObj = JSON.parse(rawText) as Record<string, unknown>;
      const parsed = parseBoardJson(JSON.parse(await fs.readFile(copyPath, "utf8")));

      assert.equal(parsed.project, "agent-visualizer");
      assert.equal(parsed.active_sprint, "S1");
      assert.ok(parsed.items.length >= 20, "expected real board items");
      assert.ok(parsed.testruns.length >= 8, "expected real board testruns");

      // Exact round-trip fidelity check (no dropped fields like evidence, verified_build, kv, ac)
      assert.deepEqual(parsed, originalObj);

      // Re-validating serialized JSON remains identical
      const revalidated = BoardSchema.parse(JSON.parse(JSON.stringify(parsed)));
      assert.deepEqual(revalidated, originalObj);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("validates NormalizedEvent and SessionSnapshot schemas", () => {
    const id = createDeterministicEventId([
      "2026-11-24T18:00:00Z",
      "sess-1",
      "orchestrator",
      "board_mutation",
    ]);
    assert.equal(id.length, 16);

    const ev = NormalizedEventSchema.parse({
      id,
      ts: "2026-11-24T18:00:00Z",
      ide: "claude-code",
      sessionId: "sess-1",
      workspacePath: "/workspace/agent-studio",
      projectId: "agent-visualizer",
      agentId: "orchestrator",
      agentLabel: "Team Orchestrator",
      kind: "board_mutation",
      toolName: "board",
      summary: "Moved S1-17 to test",
      payload: { itemId: "S1-17", state: "test" },
    });
    assert.equal(ev.ide, "claude-code");
    assert.equal(ev.kind, "board_mutation");

    const snap = SessionSnapshotSchema.parse({
      sessionId: "sess-1",
      ide: "antigravity",
      projectId: "agent-visualizer",
      updatedAt: "2026-11-24T18:00:05Z",
      status: "WORKING",
      waitingOn: null,
      agents: [
        {
          id: "root",
          label: "Orchestrator",
          ide: "antigravity",
          status: "THINKING",
          toolCalls: 3,
          messagesSent: 2,
          messagesReceived: 1,
        },
      ],
      edges: [{ from: "root", to: "backend-engineer", count: 1, lastKind: "message" }],
      events: [ev],
      counters: {
        totalEvents: 1,
        toolCalls: 3,
        messages: 1,
        boardMutations: 1,
        activeAgents: 1,
        completedAgents: 0,
      },
    });
    assert.equal(snap.status, "WORKING");

    assert.throws(() =>
      NormalizedEventSchema.parse({
        id: "abc",
        ts: "2026-11-24T18:00:00Z",
        ide: "not-a-valid-ide",
        sessionId: "sess-1",
        agentId: "root",
        kind: "message",
        summary: "invalid",
      }),
    );
  });
});
