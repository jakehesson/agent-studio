# Technical Specification: Context Window Accuracy, Accuracy-First Model Ranking & DevOps-Item Handoff Protocol

- **Board Items:** `BUG-26` (Context Window Accuracy), `BUG-27` (Accuracy -> Cost -> Speed Ranking), `S1-65` (DevOps-Item Context-Threshold Handoff & Task-Splitting Protocol)
- **Status:** Design Specification (`design`)
- **Related Specs & Docs:** [model-routing-and-index.md](./model-routing-and-index.md) · [TELEMETRY_SPEC.md](../TELEMETRY_SPEC.md) · [IDE_INTEGRATION.md](../IDE_INTEGRATION.md)

---

## 1. Goal, Non-Goals & Architectural Invariants

### Goal
Unify three interdependent fixes into one coherent contract across telemetry, model routing, board state, IDE hooks, MCP responses, and Web Studio:
1. **`BUG-26`:** Resolve accurate per-model context windows (notably `1,000,000` / `1M` for `Mai Code 2` / `mai-*`, `GPT-4.1`, and `GPT-5.4`) across live VS Code `maxInputTokens`, Copilot `Auto` `version` metadata, subagent spawns, the 3-layer `ModelIndex`, and `inferContextWindow()` parity.
2. **`BUG-27`:** Enforce deterministic **`Accuracy -> Cost -> Speed`** model ranking and modern built-in model defaults across `copilot-vscode`, `claude-code`, and `antigravity`, eliminating outdated weak defaults (`Claude Haiku 4.5`) and honoring `deferToHostOrchestrator` across all three IDEs.
3. **`S1-65`:** Add structured context-handoff and task-split state on DevOps board items (`pipeline/board.json`), surface context-budget advisories before Drift degrades into auto-compaction, and enforce fresh-context handoff vs. orchestrator task-splitting across rules, prompts, skills, and Web Studio.

### Non-Goals
- **Do not** add or rename top-level entries in `MCP_TOOLS` (`src/mcp/server.ts`) — `tests/unit/mcp-stdio.test.ts:182-197` pins the 11 tool names (`projects`, `board`, `testrun`, `telemetry`, `open_studio`, `app_*`). Extend `board` `op` enums and parameters additively.
- **Do not** break `pipeline/board.json` or `tests/fixtures/legacy-board.json` backwards compatibility — all new `BoardItemSchema` fields are optional.
- **Do not** leak Layer 1 `~/.agent-studio/model-index.json` into `compileTeam()`, `checkTeamDrift()`, or `sync --check` unless `--use-global-index` is explicitly passed.

### Hard Invariants
1. **Contract Parity:** `inferContextWindow(model, ide)` in `src/telemetry/types.ts` and `web/src/state/snapshot.ts` MUST stay byte-equivalent in output across the full matrix (`tests/unit/contract-parity.test.ts:108-228`).
2. **Board Atomicity:** Every mutation to `pipeline/board.json` MUST run inside `withBoardLock` + `writeBoardAtomic` (`src/board/store.ts:67-162`).
3. **Hook Latency Budget:** `agent-studio hook-emit` (`src/cli/commands/hook-emit.ts`) MUST remain `< 200ms` offline with exit `0` fallback to `.agent-studio/telemetry.jsonl`, while preserving `PreToolUse` hard deny (`exitCode: 2` / Claude Code `permissionDecision: "deny"`).
4. **Module Boundaries & UI Standards:** `web/` MUST NOT import Node-only modules from `src/`; `embed=1` extension scoping and Galaxy Z Fold 7 three-tier responsive layouts MUST remain intact.

---

## 2. `BUG-26`: Context Window Resolution Order & Parity

### 2.1 Exact 4-Tier Resolution Precedence
Every usage/context calculation in `src/telemetry/normalizer.ts`, `src/cli/commands/hook-emit.ts`, `src/telemetry/push-bus.ts`, and `web/src/state/snapshot.ts` MUST resolve `contextWindow` in this exact order:
1. **Explicit Live Per-Agent Window (`uDelta.contextWindow`):** Direct `maxInputTokens` / `contextWindow` reported on the agent's transcript or hook payload (e.g., `135_805` in `tests/unit/telemetry.test.ts:3961` or `921_805` from VS Code Copilot `selectedModel.metadata.maxInputTokens`). Preserve verbatim so `contextPercent = contextTokens / contextWindow` reflects true remaining input capacity before compaction.
2. **Session-Level `model -> contextWindow` & Subagent Propagation (`CopilotVSCodeAdapter`):**
   - Extend `VSCodeChatSessionState.inputState.selectedModel` (`src/telemetry/adapters/copilot-vscode.ts:116-123`) to inspect `version` and `family` on both `selectedModel` and `selectedModel.metadata`.
   - When `selectedModel.id` / `selectedModel.metadata?.id` is `"auto"` (Copilot Auto), resolve the underlying model identifier from `selectedModel.metadata?.version || selectedModel.version || selectedModel.metadata?.family || selectedModel.family` before `prettifyModelName()`, so `{ id: "auto", family: "vscModelF", version: "mai-code-2-flash", maxInputTokens: 921805 }` resolves to `"Mai Code 2 Flash"` instead of `"Auto"`.
   - Maintain a session-level `modelWindowMap: Map<string, number>` from `selectedModel` (`{ normalizedModel -> maxInputTokens }`) and per-request usage windows. When emitting `subagent_spawn` (`copilot-vscode.ts:2142-2250`), propagate `contextWindow` via `usageDelta` / `payload.childContextWindow` whenever `childModel` matches a known session model OR the subagent omits `childModel` and inherits root's model.
3. **Effective Merged `ModelIndex` Catalog (`Layer 2 > Layer 1 > Layer 0`):**
   - `extension/src/modelSync.ts:92-128`: preserve optional `version?: string` on `DiscoveredModelPayload` / `mapLanguageModelsForHost()` alongside `maxInputTokens`.
   - `src/telemetry/definitions.ts:421-493`: extract a compact `modelContextWindows: Record<string, number>` map from `effectiveModelIndex.ides` catalogs (keyed by lowercased `entry.id`, `entry.label`, and `entry.family`) and attach it to `TeamDetails`.
   - Propagate `modelContextWindows` through `TelemetryAggregator.getSessionSnapshot()` (`src/telemetry/index.ts`), `SnapshotBuildOptions` (`src/telemetry/normalizer.ts`), and `RichSessionSnapshot` (`src/telemetry/types.ts` + `web/src/types.ts`) so both backend snapshots and Web Studio (`GET /api/state`, SSE `/api/stream`, `web/src/state/snapshot.ts`) resolve live VS Code `maxInputTokens` when an agent lacks an inline `usageDelta.contextWindow`.
4. **Updated `inferContextWindow(model, ide)` Fallback (`src/telemetry/types.ts:1101-1130` & `web/src/state/snapshot.ts:55-84`):**
   - `[1m]` explicit tag -> `1_000_000`
   - empty / `"unknown"` -> `ide === "antigravity" ? 1_000_000 : 200_000`
   - `mai` (`/\bmai\b/i` or `/^mai[-_]/i`, covering `"Mai Code 2"`, `"Mai Code 2 Flash"`, `"mai-code-2-flash"`, `"Mai Code 2 (copilot)"`) -> `1_000_000`
   - `gemini`, `gpt-4.1`, `gpt 4.1`, `gpt-5.4`, `gpt 5.4` -> `1_000_000` *(check `gpt-5.4` BEFORE generic `gpt-5`)*
   - `gpt-5` (excluding `5.4`), `gpt-6` -> `400_000`
   - `gpt-4o`, `o1`, `o3`, `o4` -> `128_000`
   - default -> `200_000`

### 2.2 Effective vs. Nominal Window Display (`921,805` vs. `1M` MAI)
- VS Code Copilot `maxInputTokens` (e.g., `921_805` for MAI or `135_805` for GPT-5) represents the **effective input budget** after output/system token reservations.
- Keep `usage.contextWindow` set to the exact live `maxInputTokens` when explicitly provided (ensuring `108k / 921.8k = 11.7% Smart Zone`, preserving `tests/unit/telemetry.test.ts:3961`, and computing safe compaction margins).
- Add optional `nominalContextWindow?: number` on `AgentUsageMetricsSchema` (`src/schema/telemetry.ts`) when `inferContextWindow(model, ide) > contextWindow` (e.g., `1_000_000` for MAI when `contextWindow === 921_805`).
- In `DEFAULT_MODEL_INDEX` (`src/schema/model-index.ts`) and `.agent-team/model-index.json`, seed `Mai Code 2 (copilot)` and `Mai Code 2 Flash (copilot)` with `contextWindow: 1_000_000`, and fix `GPT-4.1 (copilot)` from `128_000` to **`1_000_000`**.
- In `UsageDashboard.ts`, render `fmtContextWindow(ctxWin)` (`1M` when `1_000_000`, or `1M` display pill / `922k eff. · 1M nominal` tooltip when `nominalContextWindow === 1_000_000 && ctxWin >= 850_000`) so MAI never appears as `200k Drift`.

---

## 3. `BUG-27`: `Accuracy -> Cost -> Speed` Model Selection & Modern Catalog

### 3.1 Deterministic Ranking Policy
Add optional schema fields (`.passthrough()`, backwards-compatible):
- On `ModelIndexSchema` and `WorkflowModelRoutingSchema`:
  ```ts
  selectionPriority: z
    .array(z.enum(["accuracy", "cost", "speed"]))
    .default(["accuracy", "cost", "speed"])
  ```
- On `ModelCatalogEntrySchema` (`src/schema/model-index.ts:52-67`):
  - `accuracyRank?: number` (higher = better coding/reasoning quality)
  - `speedRank?: number` (higher = faster response throughput)
  - `deprecated?: boolean` (marks legacy superseded models like `Claude Haiku 4.5`, `Claude Sonnet 4`, `Claude Opus 4.1`, `GPT-4o mini`, `Gemini 2.5 Pro` so they rank below modern models and are never chosen as primary defaults)

**Deterministic Tier Candidate Comparator (`rankCatalogModelsForTier(entries, tier)`):**
1. Filter out `entry.available === false` (unless zero available candidates exist, in which case fall back cleanly and emit a `doctor` warning).
2. Prefer `!entry.deprecated` over `entry.deprecated === true`.
3. Prefer exact `entry.tier === tier` over cross-tier fallback.
4. **Accuracy (`accuracyScore(entry)` descending):** explicit `entry.accuracyRank` if set; otherwise deterministic family/version rank (`claude-opus-4.6` > `gpt-5.4` > `claude-opus-4.5` > `gemini-3.1-pro` / `gemini-4-neon|argon` > `claude-sonnet-4.6` > `mai-code-2` > `claude-sonnet-4.5` > `gpt-5.3-codex` / `gpt-5` > `gemini-3-pro` > `gemini-3-flash` > `gpt-5-mini` > `gpt-4.1` > ... > `claude-haiku-4.5` > `gpt-4o-mini`).
5. **Cost (`costScore(entry)` ascending):** `entry.premiumMultiplier ?? defaultCostMultiplier(entry)` (lower multiplier breaks accuracy ties).
6. **Speed (`speedScore(entry)` descending):** explicit `entry.speedRank`, else `capabilities.includes("fast")` / `tier === "fast"`.
7. Deterministic tie-breaker: source priority (`user` > `agent` > `vscode-lm` > `built-in`), then `id.localeCompare(b.id)`.

### 3.2 Updated Modern Default Catalogs & Role Tiers (`DEFAULT_MODEL_INDEX`, `src/templates/manifest.ts`, `.agent-team/`)

| IDE | Tier | `primary` | `fallback` (ordered Accuracy -> Cost -> Speed) |
| :--- | :--- | :--- | :--- |
| `copilot-vscode` | `reasoning` | `Claude Opus 4.6 (copilot)` | `["Claude Opus 4.6 (copilot)", "GPT-5.4 (copilot)", "Gemini 3.1 Pro (copilot)", "Claude Opus 4.5 (copilot)"]` |
| `copilot-vscode` | `balanced` | `Claude Sonnet 4.6 (copilot)` | `["Claude Sonnet 4.6 (copilot)", "GPT-5.4 (copilot)", "Mai Code 2 (copilot)", "Claude Sonnet 4.5 (copilot)"]` |
| `copilot-vscode` | `fast` | `Gemini 3 Flash (copilot)` | `["Gemini 3 Flash (copilot)", "Mai Code 2 (copilot)", "GPT-5 mini (copilot)", "GPT-4.1 (copilot)"]` |
| `claude-code` | `reasoning` | `opus` | `["opus", "sonnet", "inherit"]` |
| `claude-code` | `balanced` | `sonnet` | `["sonnet", "opus", "inherit"]` |
| `claude-code` | `fast` | `haiku` | `["haiku", "sonnet", "inherit"]` |
| `antigravity` | `reasoning` | `pro` | `["pro", "flash", "inherit"]` |
| `antigravity` | `balanced` | `flash` | `["flash", "pro", "inherit"]` |
| `antigravity` | `fast` | `flash_lite` | `["flash_lite", "flash", "inherit"]` |

**Role Tier Recommendations (`src/models/defaults.ts:48-65`, `DEFAULT_MODEL_INDEX.roleRecommendations`, `src/templates/manifest.ts`, `.agent-team/team.yaml` & `model-index.json`):**
- **`orchestrator`:** Upgrade `fast` -> **`balanced`** (`deferToHostOrchestrator: true`). Coordination and task-splitting require strong judgment; read-only triage should not run on low-accuracy fast models.
- **`qa-validator`:** Upgrade `fast` -> **`balanced`** so test triage, checkpoint execution, and bug reproduction never default to `haiku` / `Claude Haiku 4.5`.
- Keep `architect`, `ux-designer`, `code-reviewer`, `*-specialist` on `reasoning`, and `backend-engineer`, `frontend-engineer`, `team-setup` on `balanced`.
- Legacy entries (`Claude Haiku 4.5 (copilot)`, `Claude Sonnet 4 (copilot)`, `Claude Opus 4.1 (copilot)`, `GPT-4o mini (copilot)`, `Gemini 2.5 Pro (copilot)`) remain in `copilot-vscode.catalog` with `deprecated: true` (and `GPT-4.1 (copilot)` updated to `contextWindow: 1_000_000`) so existing overlays still resolve metadata without breaking user pins.

### 3.3 `resolveRoleModel()` & `applyDiscoveredModels()` Behavior
1. **Cross-IDE `deferToHostOrchestrator` (`src/models/resolve.ts:307-328`):**
   - When `!override && policy !== "pinned" && (manifest.workflow.modelRouting?.respectBuiltInOrchestrators ?? true) && roleRec?.deferToHostOrchestrator`:
     - `antigravity`: `frontmatterModel: "inherit"`, `primaryModel: "inherit"`
     - `claude-code`: `frontmatterModel: "inherit"`, `primaryModel: "inherit"`
     - `copilot-vscode`: `omit: true`, `frontmatterModel: undefined`, `copilotPolicy: undefined` *(lets Copilot Fusion / Auto / user picker run without forcing a hardcoded orchestrator model; when `respectBuiltInOrchestrators: false`, resolves `balanced` array)*.
2. **Filter Unavailable Entries (`src/models/resolve.ts:268-304`):**
   - Filter `copilot-vscode` `prefer-fallback` candidate arrays against catalog `available !== false` (unless a role explicitly pinned a string override or all candidates are unavailable).
3. **Auto Re-Rank Discovered Models (`src/models/store.ts:660-790`):**
   - In `applyDiscoveredModels()` when `source === "vscode-lm"`, recompute `tiers[tier].primary` and `tiers[tier].fallback` (top 4) using `rankCatalogModelsForTier()` **only when** the overlay does not carry explicit user/CLI tier customizations (`prevIde.syncSource !== "manual"` and no `user`/`cli` `tiers` patch), preserving explicit user overrides and CI determinism (Layer 1 only).

### 3.4 Required Unit Test Updates (`tests/unit/`)
- `tests/unit/model-routing.test.ts`: update assertions for `orchestrator.tier === "balanced"` (L67), `agyOrchOptOut.frontmatterModel === "flash"` (L315), `Claude Opus 4.6 (copilot)` (L352), `Claude Sonnet 4.6 (copilot)` (L365, L463, L530), and `orchestrator.agent.md` omitting `model` under `respectBuiltInOrchestrators: true` while emitting `balanced` under `false`. Add assertions for `Accuracy -> Cost -> Speed` ranking, `available: false` filtering, and `deprecated` exclusion.
- `tests/unit/contract-parity.test.ts`: add `Mai Code 2`, `mai-code-2-flash`, `Mai Code 2 (copilot)`, `gpt-5.4`, `GPT 5.4` -> `1_000_000` to `MODEL_MATRIX`.
- `tests/unit/telemetry.test.ts`: preserve existing `135_805` assertion (L3961) and add tests for Copilot `auto` + `version: "mai-code-2-flash"` -> `1_000_000` / `921_805` propagation to subagents.
- `tests/unit/compiler.test.ts` & `tests/unit/extension.test.ts`: add assertions for `PreCompact` in `CLAUDE_HOOK_EVENTS` and `version` propagation in `mapLanguageModelsForHost`.

---

## 4. `S1-65`: DevOps-Item Context-Threshold Handoff & Task-Splitting Protocol

### 4.1 Board Schema (`src/schema/board.ts`)
Extend `BoardItemSchema` additively (existing `pipeline/board.json` remains valid with zero migration):
```ts
export const HANDOFF_STATUSES = [
  "pending_handoff",
  "pending_split",
  "resumed",
  "cleared",
] as const;

export const SplitProposalSchema = z.object({
  title: z.string().min(1),
  role: z.string().min(1),
  ac: z.array(z.string()).default([]),
  deps: z.array(z.string()).optional(),
  rationale: z.string().optional(),
}).passthrough();

export const ContextHandoffSchema = z.object({
  status: z.enum(HANDOFF_STATUSES),
  kind: z.enum(["fresh_context", "task_split"]),
  created_at: z.string().min(1),
  actor: z.string().min(1),
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  context_percent: z.number().min(0).max(100).optional(),
  context_tokens: z.number().int().nonnegative().optional(),
  context_window: z.number().int().positive().optional(),
  summary: z.string().min(1),
  modified_files: z.array(z.string()).default([]),
  verified_checks: z.array(z.string()).optional(),
  remaining_work: z.array(z.string()).default([]),
  continuation_brief: z.string().min(1),
  split_proposals: z.array(SplitProposalSchema).optional(),
}).passthrough();
```
Add optional fields on `BoardItemSchema`:
- `handoff: ContextHandoffSchema.nullable().optional()`
- `split_from: z.string().min(1).nullable().optional()`

### 4.2 Board Engine, CLI & MCP (`src/board/engine.ts`, `src/cli/index.ts`, `src/mcp/server.ts`)
Extend `board` `op` enum with `"handoff"` and `"split"` (all mutations inside `withBoardLock`):
1. **`boardHandoff` (`op: "handoff"`):**
   - Inputs: `itemId`, `kind` (`"fresh_context" | "task_split"`), `actor`, `summary`, `modifiedFiles[]`, `remainingWork[]`, `continuationBrief`, optional `verifiedChecks[]`, `splitProposals[]`, `contextPercent`, `contextTokens`, `contextWindow`, `sessionId`, `agentId`, `keepOwner?: boolean`.
   - Sets `item.handoff` (`status: kind === "task_split" ? "pending_split" : "pending_handoff"`), clears `item.owner = null` unless `keepOwner === true`, appends `[HANDOFF:${kind}] ${summary}` to `item.notes`, and emits `board_mutation` telemetry (`payload: { itemId, handoffKind: kind, contextPercent }`).
2. **`boardSplit` (`op: "split"`):**
   - Inputs: `itemId`, `actor`, optional `subtasks` (defaults to `item.handoff?.split_proposals`), optional `blockParent?: boolean` (default `true` unless parent moves/tracks `deps`).
   - Atomically creates child items (`split_from: parent.id`, preserving `sprint`), appends new child IDs to `parent.deps`, sets `parent.handoff.status = "resumed"` (if `parent.handoff` exists), appends `[SPLIT] created ${childIds.join(", ")}` to `parent.notes`, and emits `board_mutation` telemetry.
3. **Read & Transition Hooks:**
   - `boardShow`: prints structured `handoff:` block (`status`, `kind`, `context`, `summary`, `modified_files`, `remaining_work`, `continuation_brief`, `split_proposals`) so a fresh-context subagent only needs one `board { op: "show", itemId }` call.
   - `boardStatus` / `boardNext`: appends `[HANDOFF_PENDING]` or `[SPLIT_PENDING]` tags on active items.
   - `boardMove` / `boardOwner`: when moving a `pending_handoff` item to `dev`/`design`/`test` or assigning a new `owner`, auto-transitions `item.handoff.status` from `"pending_handoff"` to `"resumed"`.

### 4.3 Context Thresholds & Cross-IDE Delivery
Add optional `workflow.contextThresholds` on `WorkflowConfigSchema` (`src/schema/team.ts`):
- `warnPercent`: default `45`
- `handoffPercent`: default `55` (fires **15% before** the `70%` Compact boundary in `web/src/utils.ts:532-541`)
- `compactPercent`: default `70`

**3-Channel Advisory Delivery:**
1. **`POST /api/ingest` (`src/server/http-server.ts:744-780` & `src/telemetry/push-bus.ts`):**
   - `PushBus` tracks per-`(sessionId, agentId)` latest `contextTokens`, resolved `contextWindow` (using BUG-26 4-tier precedence), and `lastAdvisedBand` (`"ok" | "warn" | "handoff" | "compact"`).
   - `POST /api/ingest` returns `{ ok: true, accepted, deduped, advisory? }` (`202 Accepted`), setting `advisory` ONLY on upward band transitions (debounced per `(sessionId, agentId, band)`) or on `PreCompact`.
2. **Claude Code & VS Code Copilot Hooks (`src/cli/commands/hook-emit.ts`, `src/compiler/claude-code.ts`, `src/compiler/copilot-vscode.ts`):**
   - Add `"PreCompact"` to `CLAUDE_HOOK_EVENTS` (`src/compiler/claude-code.ts:28-35`); `COPILOT_HOOK_EVENTS` already includes `"PreCompact"`. Map `PreCompact` -> `kind: "message"` with `payload.isPreCompact = true`.
   - In `runHookEmit`: `PreToolUse` `denyReason` retains strict top priority (`exitCode: 2` / Claude Code `permissionDecision: "deny"`). Otherwise, read `advisory` from the `/api/ingest` response (or compute offline fallback directly from stdin `usageDelta` + `inferContextWindow(model, ide)` within `<200ms` budget).
   - When an advisory triggers on `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, or `PreCompact`, write stdout JSON (`exitCode = 0`):
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "<HookEventName>",
         "additionalContext": "[agent-studio context-budget: 58% of 1M] Drift/Handoff threshold reached. Pause new exploration and call `board { op: 'handoff', ... }` to checkpoint for a fresh context or return split proposals to orchestrator."
       }
     }
     ```
3. **Antigravity & MCP Advisory Fallback (`src/mcp/server.ts`):**
   - Because `compileAntigravity` has no CLI hook runner, `executeBoardTool` and `executeTelemetryTool` perform a fast (`<=80ms` timeout) check against `http://127.0.0.1:${port}/api/state` (or `getMcpAggregator()` fallback when server is offline). When the active agent's `contextPercent >= handoffPercent` and `op !== "handoff"`, append a concise `\n[CONTEXT_ADVISORY] ...` block to the MCP tool text result.

### 4.4 Decision Workflow, Rules, Prompts & Skills
Update `renderSharedTeamRules()` (`src/compiler/shared.ts:167-177`), `src/templates/prompts.ts`, `src/templates/skills.ts` (`agile-board-workflow`, `token-efficiency`), and `.agent-team/` (then run `npx agent-studio sync`):
- **Fresh-Context Handoff (`kind: "fresh_context"`):** Trigger at `>= 55%` (or `PreCompact`) when remaining work is cohesive and fits in one fresh Smart Zone (`<= 40%`). Specialist checkpoints clean build/test status into `board { op: "handoff", kind: "fresh_context", ... }`, returns `ITEM <ID> | HANDOFF_PENDING`, and terminates; `orchestrator` spawns a fresh subagent briefed solely with `board { op: "show", itemId }`.
- **Orchestrator Task-Split (`kind: "task_split"`):** Trigger when remaining work spans multiple modules/roles or exceeds one context budget. Specialist attaches `splitProposals` (exclusive file scopes + ACs) via `board { op: "handoff", kind: "task_split", ... }` and stops; `orchestrator` runs `board { op: "split", itemId }` and dispatches each child item to a fresh subagent.

### 4.5 Web Studio UI (`web/src/`)
- `web/src/types.ts`: mirror `ContextHandoffRecord`, `handoff`, `split_from` on `BoardItem`; `nominalContextWindow` on `AgentUsageMetrics`; `modelContextWindows` on `SessionSnapshot`.
- `web/src/views/AgileBoard.ts`: render `HANDOFF` / `SPLIT` status pills on Kanban cards (`renderKanbanCard`), a pending-handoff badge in the KPI strip, and a structured **Context Handoff / Split Brief** section (`summary`, `modified_files`, `remaining_work`, `continuation_brief`, `split_proposals`) inside `renderItemDetail`.
- `web/src/components/UsageDashboard.ts`: add `55%` Handoff tick on the Smart Zone track and per-agent context bars alongside `40%` Smart Zone and `70%` Compact, plus `1M` nominal clarity tooltip/label when `nominalContextWindow` exceeds `contextWindow`.

---

## 5. Parallel Execution Plan & Verification Checklist

### Non-Overlapping File Ownership
- **`backend-engineer`:**
  - `src/schema/{board,model-index,team,telemetry}.ts`
  - `src/models/{defaults,resolve,store}.ts`
  - `src/board/{engine,store}.ts`, `src/cli/index.ts`, `src/cli/commands/hook-emit.ts`, `src/mcp/server.ts`
  - `src/telemetry/{types,definitions,normalizer,push-bus,index}.ts`, `src/telemetry/adapters/copilot-vscode.ts`
  - `src/server/http-server.ts`, `src/compiler/{shared,claude-code}.ts`, `src/templates/{manifest,prompts,skills}.ts`
  - `extension/src/modelSync.ts`
  - `.agent-team/` + compiled outputs (`npx agent-studio sync`), and `tests/unit/*.test.ts`
- **`frontend-engineer` (+ `ux-designer` review):**
  - `web/src/types.ts`, `web/src/state/snapshot.ts`, `web/src/views/AgileBoard.ts`, `web/src/components/UsageDashboard.ts`, `web/src/styles/*.css`

### Verification Checkpoints (QA Gate)
1. **`CP0`:** `npm run check && npm --prefix extension run check && npm test` (all updated + new unit tests pass, `contract-parity.test.ts` passes, zero TS errors).
2. **`CP1`:** `npm --prefix web run check && npm --prefix web run build` (Web Studio + MCP App bundle cleanly).
3. **`CP2`:** `python tests/smoke_test.py` (zero-dep fallback smoke passes).
4. **Sync & Health:** `npx agent-studio sync --check` exits `0` and `npx agent-studio doctor --json` passes with zero drift.
