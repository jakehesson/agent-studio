import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { registerProject } from "../../src/board/registry.js";
import { MCP_TOOLS, dispatchToolCall } from "../../src/mcp/server.js";
import {
  computePremiumRequests,
  estimateCostUsd,
  resolveModelPricing,
  usdToComputeCredits,
} from "../../src/models/index.js";
import {
  SessionSnapshotSchema,
  SessionUsageBreakdownSchema,
} from "../../src/schema/telemetry.js";
import { createStudioServer } from "../../src/server/http-server.js";
import {
  AntigravityAdapter,
  ClaudeCodeAdapter,
  CopilotVSCodeAdapter,
  MAX_BREAKDOWN_SESSIONS,
  PushBus,
  TelemetryAggregator,
  allocateHamilton,
  buildSessionSnapshot,
  classifyEventWorkCategory,
  coerceToEnrichedEvent,
  computeSessionBreakdown,
  type EnrichedEvent,
} from "../../src/telemetry/index.js";

function makeEv(
  partial: Partial<EnrichedEvent> & Pick<EnrichedEvent, "kind">,
): EnrichedEvent {
  return {
    id: partial.id ?? `ev-${Math.random().toString(36).slice(2, 10)}`,
    ts: partial.ts ?? "2026-11-26T12:00:00.000Z",
    epoch: partial.epoch ?? Date.parse("2026-11-26T12:00:00.000Z") / 1000,
    ide: partial.ide ?? "antigravity",
    channel: partial.channel ?? "passive",
    sessionId: partial.sessionId ?? "sess-1",
    agentId: partial.agentId ?? "root",
    summary: partial.summary ?? partial.kind,
    ...partial,
  };
}

describe("S1-78 Token & Credit Count Breakdown", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "av-breakdown-test-"));
    origHome = process.env.AGENT_STUDIO_HOME;
    process.env.AGENT_STUDIO_HOME = path.join(tmpDir, "studio-home");
  });

  afterEach(async () => {
    if (origHome === undefined) {
      delete process.env.AGENT_STUDIO_HOME;
    } else {
      process.env.AGENT_STUDIO_HOME = origHome;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("1. resolveModelPricing & credit/cost calculations across families, tiers, and Copilot multipliers", () => {
    const opus = resolveModelPricing("Claude Opus 4.6", "copilot-vscode");
    assert.equal(opus.tier, "reasoning");
    assert.equal(opus.inputPer1M, 5);
    assert.equal(opus.outputPer1M, 25);
    assert.equal(opus.cacheReadPer1M, 0.5);
    assert.equal(opus.cacheWritePer1M, 6.25);
    assert.equal(opus.premiumMultiplier, 3);

    const opus41 = resolveModelPricing("claude-opus-4.1", "copilot-vscode");
    assert.equal(opus41.tier, "reasoning");
    assert.equal(opus41.inputPer1M, 15);
    assert.equal(opus41.premiumMultiplier, 10);

    const sonnet = resolveModelPricing("claude-sonnet-4-5", "claude-code");
    assert.equal(sonnet.tier, "balanced");
    assert.equal(sonnet.inputPer1M, 3);
    assert.equal(sonnet.outputPer1M, 15);
    assert.equal(sonnet.premiumMultiplier, undefined);

    const haiku = resolveModelPricing("claude-haiku-4.5", "claude-code");
    assert.equal(haiku.tier, "fast");
    assert.equal(haiku.inputPer1M, 1);

    const gemFlashLite = resolveModelPricing("gemini-3.5-flash-lite", "antigravity");
    assert.equal(gemFlashLite.tier, "fast");
    assert.equal(gemFlashLite.inputPer1M, 0.1);

    const gemPro = resolveModelPricing("gemini-3.1-pro", "copilot-vscode");
    assert.equal(gemPro.tier, "reasoning");
    assert.equal(gemPro.premiumMultiplier, 1);

    const gpt5Mini = resolveModelPricing("gpt-5-mini", "copilot-vscode");
    assert.equal(gpt5Mini.tier, "fast");
    assert.equal(gpt5Mini.premiumMultiplier, 0);

    const o4Mini = resolveModelPricing("o4-mini");
    assert.equal(o4Mini.tier, "reasoning");
    assert.equal(o4Mini.inputPer1M, 1.1);

    const grokFast = resolveModelPricing("grok-code-fast-1");
    assert.equal(grokFast.tier, "fast");
    assert.equal(grokFast.inputPer1M, 0.2);

    const customUnknown = resolveModelPricing("custom-corp-model-v1");
    assert.equal(customUnknown.tier, "balanced");
    assert.equal(customUnknown.inputPer1M, 2.5);

    const customCatalogPricing = resolveModelPricing("my-model", "antigravity", [
      {
        id: "my-model",
        label: "My Model",
        tier: "reasoning",
        capabilities: ["reasoning"],
        premiumMultiplier: 2.5,
        available: true,
        source: "user",
      },
    ]);
    assert.equal(customCatalogPricing.tier, "reasoning");
    assert.equal(customCatalogPricing.premiumMultiplier, 2.5);

    const estUsd = estimateCostUsd(
      {
        uncachedInputTokens: 100_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 20_000,
        outputTokens: 10_000,
      },
      sonnet,
    );
    // (0.1*3) + (1*0.3) + (0.02*3.75) + (0.01*15) = 0.3 + 0.3 + 0.075 + 0.15 = 0.825
    assert.ok(Math.abs(estUsd - 0.825) < 1e-9);
    assert.equal(usdToComputeCredits(0.825), 82.5);
    assert.equal(usdToComputeCredits(0.0014), 0.1);
    assert.equal(usdToComputeCredits(0.014), 1.4);
    assert.equal(computePremiumRequests(4, 0.33), 1.32);
    assert.equal(computePremiumRequests(3, 3), 9);
  });

  it("2. Adapter & PushBus extraction: cacheRead/Write split, inclusive vs Gemini thoughtsTokenCount without double-counting", async () => {
    // A. Antigravity with Gemini thoughtsTokenCount (separate from candidatesTokenCount) + cache split
    const brainDir = path.join(tmpDir, "brain");
    const cid = "11111111-1111-1111-1111-111111111111";
    const agPath = path.join(
      brainDir,
      cid,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await fs.mkdir(path.dirname(agPath), { recursive: true });
    await fs.writeFile(
      agPath,
      [
        {
          step_index: 0,
          type: "USER_INPUT",
          created_at: "2026-11-26T10:00:00Z",
          content: "Active Workspaces:\n- c:/Projects/App\nPlan feature",
        },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-26T10:00:02Z",
          model: "gemini-3.1-pro",
          thinking: "Deeply analyzing requirements...",
          content: "Here is the plan.",
          usageMetadata: {
            promptTokenCount: 1000,
            candidatesTokenCount: 200,
            thoughtsTokenCount: 300,
            cachedContentTokenCount: 4000,
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    const agAdapter = new AntigravityAdapter({ brainDir });
    const [agSess] = await agAdapter.discoverSessions();
    assert.ok(agSess);
    const agEvents = await agAdapter.parseSession(agSess);
    const agSnap = buildSessionSnapshot(agEvents, {
      sessionId: cid,
      ide: "antigravity",
    });
    const agRoot = agSnap.agents.find((a) => a.id === "root");
    // outputTokens = candidatesTokenCount (200) + thoughtsTokenCount (300) = 500
    assert.equal(agRoot?.usage?.outputTokens, 500);
    assert.equal(agRoot?.usage?.reasoningTokens, 300);
    assert.equal(agRoot?.usage?.reasoningSource, "exact");
    // cachedContentTokenCount is unsplit combined cachedTokens
    assert.equal(agRoot?.usage?.cachedTokens, 4000);
    assert.equal(agSnap.usage?.breakdown?.composition.cacheSplitKnown, false);
    assert.equal(agSnap.usage?.breakdown?.composition.nonReasoningOutputTokens, 200);
    assert.equal(agSnap.usage?.breakdown?.composition.totalTokens, 5500);

    // B. Claude Code: streaming deduplication preserved + cache split + inclusive reasoning_tokens
    const claudeDir = path.join(tmpDir, "claude");
    const projFolder = path.join(claudeDir, "C--Projects-App");
    const cSessId = "22222222-2222-2222-2222-222222222222";
    await fs.mkdir(projFolder, { recursive: true });
    await fs.writeFile(
      path.join(projFolder, `${cSessId}.jsonl`),
      [
        {
          type: "user",
          uuid: "u1",
          sessionId: cSessId,
          cwd: "C:\\Projects\\App",
          timestamp: "2026-11-26T10:05:00Z",
          message: { role: "user", content: "Fix bug" },
        },
        {
          type: "assistant",
          uuid: "a1-partial",
          sessionId: cSessId,
          timestamp: "2026-11-26T10:05:01Z",
          message: {
            id: "msg-1",
            role: "assistant",
            model: "claude-sonnet-4-5",
            stop_reason: null,
            content: [{ type: "thinking", thinking: "Step 1" }],
            usage: {
              input_tokens: 500,
              output_tokens: 100,
              cache_read_input_tokens: 2000,
              cache_creation_input_tokens: 300,
              output_tokens_details: { reasoning_tokens: 80 },
            },
          },
        },
        {
          type: "assistant",
          uuid: "a1-final",
          sessionId: cSessId,
          timestamp: "2026-11-26T10:05:02Z",
          message: {
            id: "msg-1",
            role: "assistant",
            model: "claude-sonnet-4-5",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Fixed." }],
            usage: {
              input_tokens: 500,
              output_tokens: 400,
              cache_read_input_tokens: 2000,
              cache_creation_input_tokens: 300,
              output_tokens_details: { reasoning_tokens: 150 },
            },
          },
        },
        {
          type: "cost-state",
          timestamp: "2026-11-26T10:05:03Z",
          totalCostUSD: 0.025,
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      "utf8",
    );

    const claudeAdapter = new ClaudeCodeAdapter({ projectsDir: claudeDir });
    const [cSess] = await claudeAdapter.discoverSessions();
    assert.ok(cSess);
    const cSnap = buildSessionSnapshot(await claudeAdapter.parseSession(cSess), {
      sessionId: cSessId,
      ide: "claude-code",
    });
    const cRoot = cSnap.agents.find((a) => a.id === "root");
    assert.equal(cRoot?.usage?.inputTokens, 500);
    assert.equal(cRoot?.usage?.outputTokens, 400);
    assert.equal(cRoot?.usage?.cacheReadTokens, 2000);
    assert.equal(cRoot?.usage?.cacheWriteTokens, 300);
    assert.equal(cRoot?.usage?.cachedTokens, 2300);
    assert.equal(cRoot?.usage?.reasoningTokens, 150);
    assert.equal(cRoot?.usage?.reasoningSource, "exact");
    assert.equal(cRoot?.usage?.costUsd, 0.025);
    assert.equal(cRoot?.usage?.credits, 2.5);
    assert.equal(cSnap.usage?.breakdown?.composition.cacheSplitKnown, true);
    assert.equal(cSnap.usage?.breakdown?.composition.nonReasoningOutputTokens, 250);
    assert.equal(cSnap.usage?.breakdown?.totals.costSource, "exact");

    // C. Copilot VS Code: combined cachedTokens -> cacheSplitKnown=false + inclusive reasoning clamped + premiumRequests
    const vscDir = path.join(tmpDir, "vscode");
    const wsDir = path.join(vscDir, "ws1");
    await fs.mkdir(path.join(wsDir, "chatSessions"), { recursive: true });
    await fs.writeFile(
      path.join(wsDir, "workspace.json"),
      JSON.stringify({ folder: "file:///c%3A/Projects/App" }),
      "utf8",
    );
    const vscMs = Date.parse("2026-11-26T10:10:00Z");
    await fs.writeFile(
      path.join(wsDir, "chatSessions", "vsc-1.json"),
      JSON.stringify({
        sessionId: "vsc-1",
        creationDate: vscMs,
        requests: [
          {
            requestId: "r1",
            timestamp: vscMs,
            modelId: "copilot/claude-opus-4.6",
            message: { text: "Review PR" },
            response: [{ kind: "markdownContent", value: "Looks good" }],
            modelState: { value: 1, completedAt: vscMs + 1000 },
            result: {
              usage: {
                promptTokens: 5000,
                completionTokens: 300,
                cachedTokens: 4000,
                completion_tokens_details: { reasoning_tokens: 120 },
              },
            },
          },
          {
            requestId: "r2",
            timestamp: vscMs + 2000,
            modelId: "copilot/claude-opus-4.6",
            message: { text: "Check tests" },
            response: [{ kind: "markdownContent", value: "All pass" }],
            modelState: { value: 1, completedAt: vscMs + 3000 },
            result: {
              usage: {
                promptTokens: 6000,
                completionTokens: 200,
                cachedTokens: 5000,
                completion_tokens_details: { reasoning_tokens: 999 }, // clamped to 200
              },
            },
          },
        ],
      }),
      "utf8",
    );

    const vscAdapter = new CopilotVSCodeAdapter({ storageDir: vscDir });
    const [vSess] = await vscAdapter.discoverSessions();
    assert.ok(vSess);
    const vSnap = buildSessionSnapshot(await vscAdapter.parseSession(vSess), {
      sessionId: "vsc-1",
      ide: "copilot-vscode",
    });
    const vRoot = vSnap.agents.find((a) => a.id === "root");
    assert.equal(vRoot?.usage?.inputTokens, 2000); // (5000-4000) + (6000-5000)
    assert.equal(vRoot?.usage?.cachedTokens, 9000);
    assert.equal(vRoot?.usage?.cacheReadTokens, undefined);
    assert.equal(vRoot?.usage?.outputTokens, 500);
    assert.equal(vRoot?.usage?.reasoningTokens, 320); // 120 + min(200, 999)
    assert.equal(vRoot?.usage?.turns, 2);
    assert.equal(vRoot?.usage?.premiumMultiplier, 3);
    assert.equal(vRoot?.usage?.premiumRequests, 6);
    assert.equal(vSnap.usage?.breakdown?.composition.cacheSplitKnown, false);
    assert.equal(vSnap.usage?.breakdown?.totals.premiumRequests, 6);

    // D. PushBus coercion does not double-count Gemini thoughtsTokenCount on re-coercion
    const coerced1 = coerceToEnrichedEvent({
      ide: "antigravity",
      sessionId: "push-1",
      agentId: "root",
      kind: "assistant_turn_end",
      summary: "Done",
      usageDelta: {
        inputTokens: 100,
        outputTokens: 50,
        thoughtsTokenCount: 25,
      },
    });
    assert.equal(coerced1.usageDelta?.outputTokens, 75);
    assert.equal(coerced1.usageDelta?.reasoningTokens, 25);
    const coerced2 = coerceToEnrichedEvent(coerced1);
    assert.equal(coerced2.usageDelta?.outputTokens, 75);
    assert.equal(coerced2.usageDelta?.reasoningTokens, 25);
  });

  it("3. classifyEventWorkCategory covers all 8 work categories across IDEs", () => {
    assert.equal(
      classifyEventWorkCategory(makeEv({ kind: "thinking_start" })),
      "reasoning_planning",
    );
    assert.equal(
      classifyEventWorkCategory(makeEv({ kind: "subagent_spawn" })),
      "orchestration_subagents",
    );
    assert.equal(
      classifyEventWorkCategory(makeEv({ kind: "subagent_done" })),
      "orchestration_subagents",
    );
    assert.equal(
      classifyEventWorkCategory(makeEv({ kind: "board_mutation" })),
      "board_mcp_workflow",
    );
    assert.equal(
      classifyEventWorkCategory(makeEv({ kind: "user_input" })),
      "conversation_overhead",
    );
    assert.equal(
      classifyEventWorkCategory(makeEv({ kind: "message" })),
      "conversation_overhead",
    );
    assert.equal(
      classifyEventWorkCategory(makeEv({ kind: "assistant_turn_end" })),
      "conversation_overhead",
    );

    const toolCases: Array<[string, string, Record<string, unknown>?]> = [
      ["read_file", "exploration_reads"],
      ["copilot_readFile", "exploration_reads"],
      ["search/codebase", "exploration_reads"],
      ["read/readFile", "exploration_reads"],
      ["str_replace_editor", "exploration_reads", { args: { command: "view" } }],
      ["str_replace_editor", "code_editing", { args: { command: "str_replace" } }],
      ["edit_file", "code_editing"],
      ["copilot_applyPatch", "code_editing"],
      ["edit/editFiles", "code_editing"],
      ["run_command", "shell_build_tests"],
      ["execute/runInTerminal", "shell_build_tests"],
      ["my_custom_terminal_tool", "shell_build_tests"],
      ["manage_todo_list", "reasoning_planning"],
      ["EnterPlanMode", "reasoning_planning"],
      ["invoke_subagent", "orchestration_subagents"],
      ["agent/runSubagent", "orchestration_subagents"],
      ["send_message", "orchestration_subagents"],
      ["read_url_content", "web_docs_external"],
      ["gemini_search_docs", "web_docs_external"],
      ["mcp__chrome-devtools__click", "web_docs_external"],
      ["mcp__github__list_issues", "board_mcp_workflow"],
      ["board", "board_mcp_workflow"],
      ["ask_human", "conversation_overhead"],
      ["mcp__agent-studio__ask_human", "conversation_overhead"],
      ["rename_chat", "conversation_overhead"],
    ];

    for (const [toolName, expected, payload] of toolCases) {
      assert.equal(
        classifyEventWorkCategory(
          makeEv({ kind: "tool_start", toolName, payload }),
        ),
        expected,
        `toolName ${toolName}`,
      );
    }
  });

  it("4. Zero-drift Hamilton partitioning & strict schema invariants", () => {
    const alloc = allocateHamilton(100, [1, 1, 1]);
    assert.deepEqual(alloc, [34, 33, 33]);
    assert.equal(
      alloc.reduce((s, n) => s + n, 0),
      100,
    );

    const events: EnrichedEvent[] = [
      makeEv({
        id: "e1",
        epoch: 1000,
        agentId: "root",
        kind: "user_input",
        summary: "Inspect files",
      }),
      makeEv({
        id: "e2",
        epoch: 1001,
        agentId: "root",
        kind: "thinking_start",
        summary: "Analyzing the codebase architecture carefully before reading",
      }),
      makeEv({
        id: "e3",
        epoch: 1002,
        agentId: "root",
        kind: "tool_start",
        toolName: "read_file",
        summary: "Read src/index.ts",
      }),
      makeEv({
        id: "e4",
        epoch: 1003,
        agentId: "root",
        kind: "tool_start",
        toolName: "edit_file",
        summary: "Edit src/index.ts with fix",
      }),
      makeEv({
        id: "e5",
        epoch: 1004,
        agentId: "root",
        kind: "tool_start",
        toolName: "run_command",
        summary: "Run npm test",
        usageDelta: {
          model: "claude-sonnet-4.6",
          modelSource: "exact",
          usageSource: "exact",
          inputTokens: 1337,
          outputTokens: 777,
          cacheReadTokens: 4321,
          cacheWriteTokens: 555,
          cachedTokens: 4876,
          costUsd: 0.0317,
          isTotal: true,
        },
      }),
      // Second agent with per-turn exact usage (!isTotal)
      makeEv({
        id: "e6",
        epoch: 1005,
        agentId: "qa",
        parentAgentId: "root",
        kind: "tool_start",
        toolName: "run_command",
        summary: "Run verification",
        usageDelta: {
          model: "claude-haiku-4.5",
          modelSource: "exact",
          usageSource: "exact",
          inputTokens: 200,
          outputTokens: 100,
          cacheReadTokens: 800,
          cacheWriteTokens: 0,
          cachedTokens: 800,
          reasoningTokens: 20,
          reasoningSource: "exact",
        },
      }),
      makeEv({
        id: "e7",
        epoch: 1006,
        agentId: "qa",
        parentAgentId: "root",
        kind: "board_mutation",
        toolName: "board",
        summary: "Transition to done",
        usageDelta: {
          model: "claude-haiku-4.5",
          modelSource: "exact",
          usageSource: "exact",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 400,
          cacheWriteTokens: 0,
          cachedTokens: 400,
        },
      }),
    ];

    const snap = buildSessionSnapshot(events, {
      sessionId: "zero-drift-sess",
      ide: "claude-code",
    });

    // Zod schema validation passes
    const parsedSnap = SessionSnapshotSchema.parse(snap);
    const b = SessionUsageBreakdownSchema.parse(parsedSnap.usage?.breakdown);

    // Strict Composition Invariants
    const comp = b.composition;
    assert.equal(comp.totalTokens, parsedSnap.usage!.totalTokens);
    assert.equal(
      comp.totalTokens,
      comp.uncachedInputTokens +
        comp.cacheReadTokens +
        comp.cacheWriteTokens +
        comp.nonReasoningOutputTokens +
        comp.reasoningTokens,
    );
    assert.equal(
      comp.freshTokens,
      comp.uncachedInputTokens +
        comp.nonReasoningOutputTokens +
        comp.reasoningTokens,
    );

    // Zero-drift category invariants
    const catTokenSum = b.byCategory.reduce((s, c) => s + c.totalTokens, 0);
    assert.equal(catTokenSum, parsedSnap.usage!.totalTokens);
    const catDeciCreditSum = b.byCategory.reduce(
      (s, c) => s + Math.round(c.credits * 10),
      0,
    );
    assert.equal(catDeciCreditSum, Math.round(b.totals.credits * 10));

    // Per-turn exact agent ("qa") preserves exact attribution on its categories
    const boardCat = b.byCategory.find(
      (c) => c.category === "board_mcp_workflow",
    );
    assert.ok(boardCat);
    assert.equal(boardCat.attribution, "exact");
    assert.equal(boardCat.uncachedInputTokens, 100);
    assert.equal(boardCat.outputTokens, 50);
  });

  it("5. All 6 EfficiencyInsight trigger and non-trigger cases", () => {
    // Trigger 5 insights in exploration-heavy session + heavy_shell_output in shell-heavy session
    const t0 = 1_700_000_000;
    const exploreHeavyEvents: EnrichedEvent[] = [
      makeEv({
        id: "i1",
        epoch: t0,
        agentId: "root",
        kind: "user_input",
        summary: "Investigate",
      }),
      // 6 exploration reads -> triggers high_exploration_ratio + repeated_tool_churn
      ...Array.from({ length: 6 }, (_, idx) =>
        makeEv({
          id: `exp-${idx}`,
          epoch: t0 + 1 + idx,
          agentId: "root",
          kind: "tool_start",
          toolName: "read_file",
          summary: "Read src/large-file.ts", // identical 6x -> triggers repeated_tool_churn!
        }),
      ),
      makeEv({
        id: "root-usage",
        epoch: t0 + 20,
        agentId: "root",
        kind: "assistant_turn_end",
        summary: "Done",
        usageDelta: {
          model: "claude-opus-4.6", // reasoning tier doing routine read work -> triggers reasoning_tier_on_routine_work
          modelSource: "exact",
          usageSource: "exact",
          inputTokens: 110_000, // low cache hit rate (<40%) + context bloat (>=50% of 200k)
          outputTokens: 5_000,
          cacheReadTokens: 10_000,
          cacheWriteTokens: 0,
          cachedTokens: 10_000,
          contextTokens: 120_000,
          contextWindow: 200_000,
          isTotal: true,
        },
      }),
      makeEv({
        id: "sub-usage",
        epoch: t0 + 21,
        agentId: "helper",
        parentAgentId: "root",
        kind: "tool_start",
        toolName: "read_file",
        summary: "Helper read",
        usageDelta: {
          model: "claude-haiku-4.5",
          modelSource: "exact",
          usageSource: "exact",
          inputTokens: 1000,
          outputTokens: 200,
          cachedTokens: 2000,
          cacheReadTokens: 2000,
          cacheWriteTokens: 0,
          isTotal: true,
        },
      }),
    ];

    const exploreSnap = buildSessionSnapshot(exploreHeavyEvents, {
      sessionId: "explore-sess",
      ide: "claude-code",
    });
    const exploreIds = new Set(
      (exploreSnap.usage?.breakdown?.insights ?? []).map((i) => i.id),
    );
    assert.ok(exploreIds.has("low_cache_hit_rate"));
    assert.ok(exploreIds.has("high_exploration_ratio"));
    assert.ok(exploreIds.has("reasoning_tier_on_routine_work"));
    assert.ok(exploreIds.has("orchestrator_context_bloat"));
    assert.ok(exploreIds.has("repeated_tool_churn"));

    // Shell-heavy + failing error churn session -> triggers heavy_shell_output & repeated_tool_churn
    const shellHeavyEvents: EnrichedEvent[] = [
      makeEv({
        id: "s0",
        epoch: t0,
        agentId: "root",
        kind: "user_input",
        summary: "Run tests",
      }),
      ...Array.from({ length: 3 }, (_, idx) =>
        makeEv({
          id: `sh-${idx}`,
          epoch: t0 + 1 + idx,
          agentId: "root",
          kind: "tool_start",
          toolName: "run_command",
          summary: `npm test --run-${idx} ${"x".repeat(400)}`,
          status: "error",
          isError: true,
        }),
      ),
      makeEv({
        id: "s-end",
        epoch: t0 + 10,
        agentId: "root",
        kind: "assistant_turn_end",
        summary: "Done",
        usageDelta: {
          model: "claude-sonnet-4.6",
          modelSource: "exact",
          usageSource: "exact",
          inputTokens: 10_000,
          outputTokens: 2_000,
          cacheReadTokens: 50_000,
          cacheWriteTokens: 0,
          cachedTokens: 50_000,
          isTotal: true,
        },
      }),
    ];
    const shellSnap = buildSessionSnapshot(shellHeavyEvents, {
      sessionId: "shell-sess",
      ide: "claude-code",
    });
    const shellIds = new Set(
      (shellSnap.usage?.breakdown?.insights ?? []).map((i) => i.id),
    );
    assert.ok(shellIds.has("heavy_shell_output"));
    assert.ok(shellIds.has("repeated_tool_churn"));

    // Clean, efficient session -> triggers ZERO insights
    const cleanEvents: EnrichedEvent[] = [
      makeEv({
        id: "c1",
        epoch: t0,
        agentId: "root",
        kind: "user_input",
        summary: "Implement feature",
      }),
      makeEv({
        id: "c2",
        epoch: t0 + 1,
        agentId: "root",
        kind: "tool_start",
        toolName: "edit_file",
        summary: "Edit file 1",
      }),
      makeEv({
        id: "c3",
        epoch: t0 + 2,
        agentId: "root",
        kind: "tool_start",
        toolName: "edit_file",
        summary: "Edit file 2",
      }),
      makeEv({
        id: "c4",
        epoch: t0 + 3,
        agentId: "root",
        kind: "tool_start",
        toolName: "edit_file",
        summary: "Edit file 3",
      }),
      makeEv({
        id: "c5",
        epoch: t0 + 4,
        agentId: "root",
        kind: "assistant_turn_end",
        summary: "Done",
        usageDelta: {
          model: "claude-sonnet-4.6",
          modelSource: "exact",
          usageSource: "exact",
          inputTokens: 5_000,
          outputTokens: 1_500,
          cacheReadTokens: 45_000,
          cacheWriteTokens: 2_000,
          cachedTokens: 47_000,
          contextTokens: 52_000,
          contextWindow: 200_000,
          isTotal: true,
        },
      }),
    ];

    const cleanSnap = buildSessionSnapshot(cleanEvents, {
      sessionId: "clean-sess",
      ide: "claude-code",
    });
    assert.equal(cleanSnap.usage?.breakdown?.insights.length, 0);
  });

  it("6. GET /api/telemetry/breakdown & MCP telemetry { op: 'breakdown' } with scoping, windows, and agent filters", async () => {
    const wsA = path.join(tmpDir, "repo-a");
    const wsB = path.join(tmpDir, "repo-b");
    await fs.mkdir(path.join(wsA, ".agent-studio"), { recursive: true });
    await fs.mkdir(path.join(wsB, ".agent-studio"), { recursive: true });
    await fs.writeFile(
      path.join(wsA, ".agent-studio", "board.json"),
      JSON.stringify({
        projectId: "proj-a",
        title: "Proj A",
        items: [],
        sprints: [],
        testRuns: [],
      }),
      "utf8",
    );
    registerProject({ id: "proj-a", title: "Proj A", root: wsA });

    const brainDir = path.join(tmpDir, "brain-http");
    const nowMs = Date.now();
    const mkAgSession = async (
      cid: string,
      ws: string,
      mtimeMs: number,
      inTok: number,
    ) => {
      const p = path.join(
        brainDir,
        cid,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      await fs.mkdir(path.dirname(p), { recursive: true });
      const tsIso = new Date(mtimeMs).toISOString();
      await fs.writeFile(
        p,
        [
          {
            step_index: 0,
            type: "USER_INPUT",
            created_at: tsIso,
            content: `Active Workspaces:\n- ${ws.replace(/\\/g, "/")}\nTask`,
          },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            created_at: tsIso,
            model: "gemini-3.8-flash",
            content: "Completed task",
            usage: {
              input_tokens: inTok,
              output_tokens: 200,
              cache_read_tokens: 1000,
              cache_creation_input_tokens: 100,
            },
          },
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
        "utf8",
      );
      const tSec = mtimeMs / 1000;
      await fs.utimes(p, tSec, tSec);
    };

    const sRecentA = "aaaaaaaa-1111-1111-1111-111111111111";
    const sOldA = "bbbbbbbb-1111-1111-1111-111111111111";
    const sOtherB = "cccccccc-1111-1111-1111-111111111111";

    await mkAgSession(sRecentA, wsA, nowMs - 30 * 60_000, 1000); // 30m ago
    await mkAgSession(sOldA, wsA, nowMs - 3 * 24 * 3600_000, 2000); // 3d ago
    await mkAgSession(sOtherB, wsB, nowMs - 10 * 60_000, 9999); // different workspace

    const aggregator = new TelemetryAggregator({
      brainDir,
      claudeDir: path.join(tmpDir, "none-claude"),
      vscodeDir: path.join(tmpDir, "none-vsc"),
      copilotHomeDir: path.join(tmpDir, "none-copilot"),
      includeGlobalTelemetryFile: false,
    });

    // Also ingest a subagent event on sRecentA via PushBus to test agent filtering
    aggregator.ingest([
      {
        ide: "antigravity",
        sessionId: sRecentA,
        workspacePath: wsA,
        projectId: "proj-a",
        agentId: "backend-engineer",
        parentAgentId: "root",
        kind: "tool_start",
        toolName: "edit_file",
        summary: "Edit handler",
        usageDelta: {
          model: "claude-sonnet-4.6",
          modelSource: "exact",
          usageSource: "exact",
          inputTokens: 500,
          outputTokens: 150,
          cacheReadTokens: 1500,
          cacheWriteTokens: 0,
          cachedTokens: 1500,
          isTotal: true,
        },
      },
    ]);

    const handle = createStudioServer({
      aggregator,
    });
    const { port } = await handle.listen(0, "127.0.0.1");

    try {
      const base = `http://127.0.0.1:${port}`;

      // 1. Default session window scoped to project proj-a (excludes wsB!)
      const res1 = await fetch(
        `${base}/api/telemetry/breakdown?ide=antigravity&project=proj-a`,
      );
      assert.equal(res1.status, 200);
      const body1 = (await res1.json()) as {
        ok: boolean;
        scope: { window: string; sessionCount: number; sessionIds: string[] };
        breakdown: {
          composition: { totalTokens: number };
          byAgent: Array<{ agentId: string }>;
        };
      };
      assert.equal(body1.ok, true);
      assert.equal(body1.scope.window, "session");
      assert.equal(body1.scope.sessionCount, 1);
      assert.deepEqual(body1.scope.sessionIds, [sRecentA]);
      // root (1000+200+1000+100 = 2300) + backend-engineer (500+150+1500 = 2150) = 4450
      assert.equal(body1.breakdown.composition.totalTokens, 4450);

      // 2. Agent filter on sRecentA
      const resAgent = await fetch(
        `${base}/api/telemetry/breakdown?ide=antigravity&project=proj-a&agent=backend-engineer`,
      );
      assert.equal(resAgent.status, 200);
      const bodyAgent = (await resAgent.json()) as {
        breakdown: {
          composition: { totalTokens: number };
          byAgent: Array<{ agentId: string }>;
        };
      };
      assert.equal(bodyAgent.breakdown.byAgent.length, 1);
      assert.equal(bodyAgent.breakdown.byAgent[0]?.agentId, "backend-engineer");
      assert.equal(bodyAgent.breakdown.composition.totalTokens, 2150);

      // 3. 7d window includes both sRecentA and sOldA, still strictly excludes wsB
      const res7d = await fetch(
        `${base}/api/telemetry/breakdown?ide=antigravity&project=proj-a&window=7d`,
      );
      assert.equal(res7d.status, 200);
      const body7d = (await res7d.json()) as {
        scope: { sessionCount: number; sessionIds: string[] };
        breakdown: { composition: { totalTokens: number } };
      };
      assert.equal(body7d.scope.sessionCount, 2);
      assert.ok(body7d.scope.sessionIds.includes(sRecentA));
      assert.ok(body7d.scope.sessionIds.includes(sOldA));
      assert.ok(!body7d.scope.sessionIds.includes(sOtherB));
      // 4450 (sRecentA) + (2000+200+1000+100 = 3300) (sOldA) = 7750
      assert.equal(body7d.breakdown.composition.totalTokens, 7750);

      // 4. Invalid window returns 400
      const resBad = await fetch(
        `${base}/api/telemetry/breakdown?window=invalid`,
      );
      assert.equal(resBad.status, 400);

      // 5. MCP telemetry tool op="breakdown" + schema check
      const telemetryTool = MCP_TOOLS.find((t) => t.name === "telemetry");
      assert.ok(telemetryTool);
      assert.deepEqual(telemetryTool.inputSchema.required, ["op"]);
      assert.ok(
        (
          telemetryTool.inputSchema.properties as Record<
            string,
            { enum?: readonly string[] }
          >
        ).op?.enum?.includes("breakdown"),
      );

      const mcpRes = await dispatchToolCall(
        "telemetry",
        {
          op: "breakdown",
          ide: "antigravity",
          project: "proj-a",
          window: "24h",
        },
        { cwd: wsA, aggregator },
      );
      assert.ok(!mcpRes.isError);
      assert.ok(mcpRes.content[0]?.text.includes("Token & Credit Breakdown"));
      const sc = mcpRes.structuredContent as {
        ok: boolean;
        scope: { window: string; sessionCount: number };
        summary: { totalTokens: number };
        breakdown: { composition: { totalTokens: number } };
      };
      assert.equal(sc.ok, true);
      assert.equal(sc.scope.window, "24h");
      assert.equal(sc.scope.sessionCount, 1);
      assert.equal(sc.summary.totalTokens, 4450);
      assert.equal(sc.breakdown.composition.totalTokens, 4450);

      // MCP emit still requires summary
      const emitErr = await dispatchToolCall(
        "telemetry",
        { op: "emit", project: "proj-a" },
        { cwd: wsA, aggregator },
      );
      assert.equal(emitErr.isError, true);
      assert.match(emitErr.content[0]?.text ?? "", /requires non-empty summary/);

      assert.equal(MAX_BREAKDOWN_SESSIONS, 20);
    } finally {
      await handle.close();
    }
  });
});
