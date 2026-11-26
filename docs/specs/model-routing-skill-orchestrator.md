# Technical Specification: Upgraded `model-routing` Skill, Enhanced `orchestrator` Prompt & Additive `ContextHandoffSchema` Alignment

- **Board Item:** `S1-67` (extends `S1-65` and `BUG-27`)
- **Status:** Design Specification (`design`)
- **Related Specs & Docs:** [context-window-model-ranking-handoff.md](./context-window-model-ranking-handoff.md) · [model-routing-and-index.md](./model-routing-and-index.md)

---

## 1. Goal, Skill Packaging Findings & Invariants

### Goal
Upgrade `skills/model-routing/SKILL.md` and the `orchestrator` prompt (`src/templates/prompts.ts`, `src/templates/skills.ts`, and canonical `.agent-team/`) using the repository's `writing-for-agents` discipline, while optionally aligning `ContextHandoffSchema` (`S1-65`) with the skill's `handoff_policy.required_fields`.

### Compiler Finding on Skill Folder Assets
Inspection of `src/compiler/` confirms that **sibling files inside a skill directory are NOT copied**:
- `loadManifestSkills()` (`src/compiler/shared.ts:57-83`) loads only `.agent-team/<skillEntry>/SKILL.md`.
- `compileAntigravity()` (`src/compiler/antigravity.ts:121-134`), `compileClaudeCode()` (`src/compiler/claude-code.ts:98-111`), `compileCopilotVsCode()` (`src/compiler/copilot-vscode.ts:154-175`), `templates/manifest.ts:271-275`, and `doctor.ts:580-590` emit/validate only `SKILL.md` per skill.

**Architectural Consequence:** Keep `skills/model-routing/SKILL.md` **self-contained** (single `SKILL.md`, no sibling `REFERENCE.md` or `SCHEMA.md` files). Apply progressive disclosure across the **two-tier boundary that exists across all 3 IDEs**: keep `orchestrator.md` (always in context) tight and operational, and push the full 10-rule reference, `expected_cost` formula, 11 rerouting triggers, JSON contract, and CLI guide behind sharp context pointers into `skills/model-routing/SKILL.md`.

### Hard Invariants
1. **Model-Invoked Skill:** Omit `disable-model-invocation` on `skills/model-routing/SKILL.md` so `orchestrator` and specialists trigger it autonomously; keep frontmatter `description` front-loaded with distinct trigger branches.
2. **Preserve Existing Model-Index & Host Policies:** Retain 3-Layer Model Index (`Layer 0`, `Layer 1`, `Layer 2`), CI determinism (`Layer 0 + Layer 2` unless `--use-global-index`), host policies (`prefer-fallback` / `defer-to-host` / `pinned`), `selectionPriority: ["accuracy", "cost", "speed"]`, and `agent-studio models ...` CLI commands.
3. **100% Backwards-Compatible Board Schema:** New `ContextHandoffSchema` fields are `.optional()`, existing `MCP_TOOLS` tool names stay unchanged (`tests/unit/mcp-stdio.test.ts`), and `npx agent-studio sync --check` exits `0`.

---

## 2. Upgraded `skills/model-routing/SKILL.md`

Target files: `src/templates/skills.ts` (`getDefaultSkills()` entry `id: "model-routing"`) and `.agent-team/skills/model-routing/SKILL.md` (re-synced via `npx agent-studio sync`).

### 2.1 Frontmatter Pointer (Trigger Branches)
```yaml
---
name: model-routing
description: Select or reroute models using ordered rules, expected_cost, smart-zone decomposition, 11 rerouting triggers, or structured routing JSON; or inspect and update Agent Studio's 3-layer Model Index (model-index.json) and host policies.
---
```

### 2.2 Required Content Structure (Ordered Steps -> Reference -> Platform CLI)

1. **10 Ordered Decision Rules (Strict Precedence 1–10):**
   1. **Hard constraints first:** Filter out candidates failing context window, required modalities/tools, privacy/data-residency, cost/rate/latency caps, or `available === false` (treat `deprecated: true` as ineligible when non-deprecated candidates exist).
   2. **Validated smart zone:** Route tasks cleanly inside the model's empirically validated smart zone (`<= 40%` target; `55%` handoff / `70%` compact ceiling).
   3. **Decompose exceeding scope:** When total scope exceeds the best eligible model's smart zone, decompose into bounded subtasks with explicit DevOps handoffs rather than executing in drift/red zone.
   4. **Task-specific evidence:** Rank eligible models via `selectionPriority: ["accuracy", "cost", "speed"]` using verified catalog capability and task-relevant benchmark evidence.
   5. **Reserve strongest tier for high-leverage work:** Assign `reasoning` tier to planning/architecture, integration, code/security review, and hard exceptions; route well-scoped execution to `balanced` / `fast` once acceptance criteria are sharp.
   6. **Require validation before accepting worker output:** Every worker deliverable passes an explicit validation check (typecheck/test/lint/review/schema check) before state transitions or downstream integration.
   7. **Minimize total expected cost:** Evaluate total expected cost using:
      `expected_cost = initial_cost + retry_probability * retry_cost + review_cost`
      *(A cheap weak model that triggers retries or heavy review loops costs more than a stronger model succeeding in one pass.)*
   8. **Return uncertainty explicitly:** When catalog fields, benchmarks, or task constraints are incomplete, state explicit `uncertainties` and set `confidence < 0.7`.
   9. **Re-route on material drift:** Re-evaluate routing only when one of the 11 rerouting triggers fires (do-not-churn rule).
   10. **Stop or escalate when unsatisfied:** If zero eligible models satisfy hard constraints, set `decision.primary_model: null`, explain missing constraints, and escalate to the user/host rather than guessing.

2. **Execution Discipline & Approval Gates (Co-located with Expected Cost):**
   - **Single bounded call vs. fanout:** Prefer a single bounded model call whenever one cohesive pass is more reliable and economical than multi-agent orchestration.
   - **Worker count != decomposition:** Partition by true context/cognitive boundaries rather than spawning extra workers; avoid duplicating the same large context across redundant parallel workers.
   - **Approval / review gate:** Require explicit user approval (or `code-reviewer` + `qa-validator` gate) before consequential or irreversible actions (destructive data/schema mutations, production deploys, force-pushes, security/billing changes).

3. **11 Rerouting Triggers & Do-Not-Churn Rule:**
   1. Context exceeds initial estimate by **> +25%**.
   2. Active agent enters **amber/drift (`>40%`–`55%` handoff) or red/compact (`>70%`) zone**.
   3. A **new modality or tool requirement** is discovered mid-task.
   4. Selected model becomes **unavailable / rate-limited / `available: false`**.
   5. Selected model **fails validation twice** on the same subtask.
   6. Repeated **tool-call or schema/formatting failures** occur.
   7. **Privacy or data-residency constraints** tighten.
   8. **Failure impact / blast radius increases** (e.g., auth, locks, migrations, trust boundaries).
   9. User **materially changes scope** or acceptance criteria.
   10. Coordinator **cannot produce a complete handoff** (`handoff_policy.required_fields`).
   11. Catalog evidence becomes **stale or contradictory** (`catalog_warnings`).
   - **Do-Not-Churn Rule:** Retain the active routing choice after routine successful phases unless a trigger above fires or the next phase's cognitive/modality profile differs materially.

4. **Structured Routing Decision JSON Output Contract & Output Requirements:**
   ```json
   {
     "decision": {
       "primary_model": "string | null",
       "tier": "fast | balanced | reasoning | null",
       "confidence": 0.0,
       "mode": "single | decomposed | escalate",
       "expected_cost_rationale": "string"
     },
     "request_analysis": {
       "task_type": "string",
       "hard_constraints": ["string"],
       "estimated_context_tokens": null,
       "failure_impact": "low | medium | high",
       "irreversible_actions": ["string"],
       "decomposition_needed": false
     },
     "routing_plan": [
       {
         "step_id": "string",
         "role": "string",
         "model_id": "string | null",
         "smart_zone_budget_pct": 40,
         "validation_gate": "string",
         "requires_user_approval": false
       }
     ],
     "model_evidence": [
       {
         "model_id": "string",
         "catalog_source": "built-in | vscode-lm | agent | user",
         "context_window": null,
         "capabilities": ["string"],
         "cost_multiplier": null,
         "benchmark_evidence": null
       }
     ],
     "rejected_candidates": [{ "model_id": "string", "reason": "string" }],
     "fallbacks": ["string"],
     "handoff_policy": {
       "required_fields": [
         "objective",
         "completed_work",
         "evidence",
         "decisions",
         "assumptions",
         "unresolved_issues",
         "artifacts",
         "validation_results",
         "next_steps"
       ],
       "enforce_on_context_handoff": true
     },
     "validation_plan": { "checks": ["string"], "validator_role": "string" },
     "uncertainties": ["string"],
     "catalog_warnings": ["string"]
   }
   ```
   **Positive Output & Anti-Fabrication Rules:**
   - When asked to produce a routing decision payload, output **only valid raw JSON** without Markdown fences or surrounding commentary.
   - Populate `primary_model`, `routing_plan[].model_id`, `model_evidence[].model_id`, and `fallbacks` strictly from observed catalog entries (`available !== false`).
   - Output `null` for any undetermined metric (`context_window`, `cost_multiplier`, `benchmark_evidence`, `estimated_context_tokens`, or `primary_model`); state missing metadata in `uncertainties`, set `confidence < 0.7`, and record stale/conflicting catalog metadata in `catalog_warnings`.
   - Cite only benchmarks directly relevant to `request_analysis.task_type`.
   - When hard constraints cannot be met, emit `decision.primary_model: null`, `decision.mode: "escalate"`, and list unmet requirements in `uncertainties`.

5. **Agent Studio 3-Layer Model Index, Host Policies & Safe CLI Reference:**
   Preserve verbatim coverage of `Layer 0` / `Layer 1` / `Layer 2`, CI determinism (`Layer 0 + Layer 2` default), `prefer-fallback` / `defer-to-host` / `pinned`, `selectionPriority: ["accuracy", "cost", "speed"]`, schema keys, and `agent-studio models show|set-tier|set-role|set-policy|upsert|adopt|reset`.

---

## 3. Enhanced `orchestrator` Prompt (`src/templates/prompts.ts` + `.agent-team/agents/orchestrator.md`)

Keep `renderOrchestratorPrompt()` (`src/templates/prompts.ts:51-93`) concise and free of JSON-schema bloat by placing a tight **Routing, Decomposition & Validation Discipline** section alongside **Model Routing & Built-In Host Compatibility** and **Dispatch Loop**, pointing to `skills/model-routing/SKILL.md`:

- **Ordered Routing & Expected Cost:** Apply `skills/model-routing` (`Accuracy -> Cost -> Speed`, hard constraints + validated smart zone first, then `expected_cost = initial_cost + retry_probability * retry_cost + review_cost`) when selecting or overriding subagent models without an active host/user override. Consult `skills/model-routing/SKILL.md` whenever producing a structured routing decision JSON or editing `.agent-team/model-index.json`.
- **Anti-Over-Delegation & Tier Discipline:** Reserve `reasoning` models for planning, integration, architecture/code review, and hard exceptions; prefer a single bounded call over multi-agent fanout whenever cohesive and more economical; keep parallel write scopes disjoint and never duplicate the same large context across redundant workers.
- **Smart-Zone Decomposition & Complete Handoffs:** Target `<= 40%` smart zone per subagent. When work exceeds the smart zone or returns `HANDOFF_PENDING` / `SPLIT_PENDING`, require complete DevOps handoff fields (`objective`, `summary`/`completed_work`, `evidence`, `decisions`, `assumptions`, `unresolved_issues`, `modified_files`/`artifacts`, `verified_checks`/`validation_results`, `remaining_work` + `continuation_brief`/`next_steps`) via `board { op: "handoff" }` or decompose via `board { op: "split" }` before dispatching a fresh context.
- **Rerouting, Validation & Approval Gates:** Keep stable assignments across routine successful phases; consult `skills/model-routing` to re-route only on material triggers (context `> +25%`, drift/compact zone, new modality/tool, model unavailable, 2x validation failure, repeated tool failures, tighter privacy, higher blast radius, scope change, incomplete handoff, stale/conflicting catalog). Require validation (`code-reviewer` / `qa-validator` / check evidence) before accepting worker output, require explicit user approval before consequential or irreversible actions, and stop/escalate when no eligible model meets hard constraints or `confidence < 0.7`.

---

## 4. Additive `ContextHandoffSchema` Alignment

### 4.1 Mapping `handoff_policy.required_fields` to `ContextHandoffSchema`
Preserve all existing `S1-65` fields (`src/schema/board.ts:53-72`) and add 5 **optional** fields so `board.json` aligns 1-to-1 with `handoff_policy.required_fields`:

| `handoff_policy.required_fields` | `ContextHandoffSchema` Field | Status |
| :--- | :--- | :--- |
| `objective` | `objective?: string` | **New optional** |
| `completed_work` | `summary: string` | Existing required |
| `evidence` | `evidence?: string[]` | **New optional** |
| `decisions` | `decisions?: string[]` | **New optional** |
| `assumptions` | `assumptions?: string[]` | **New optional** |
| `unresolved_issues` | `unresolved_issues?: string[]` | **New optional** |
| `artifacts` | `modified_files: string[]` | Existing |
| `validation_results` | `verified_checks?: string[]` | Existing optional |
| `next_steps` | `remaining_work: string[]` + `continuation_brief: string` | Existing |

### 4.2 End-to-End Touchpoints
1. **`src/schema/board.ts` (`ContextHandoffSchema`):** Add `objective: z.string().min(1).optional()`, `evidence: z.array(z.string()).optional()`, `decisions: z.array(z.string()).optional()`, `assumptions: z.array(z.string()).optional()`, `unresolved_issues: z.array(z.string()).optional()`.
2. **`src/board/engine.ts` (`HandoffItemInput`, `boardHandoff`, `boardShow`):** Accept optional `objective`, `evidence`, `decisions`, `assumptions`, `unresolvedIssues`; store non-empty values; print each populated section cleanly in `boardShow`.
3. **`src/mcp/server.ts` (`MCP_TOOLS` `board` schema + `executeBoardTool`) & `src/cli/index.ts` (`runBoardCli`):** Add optional `objective` (`type: "string"`), `evidenceItems` (`type: "array"` of strings, avoiding `oneOf` on existing `evidence: { type: "string" }` for strict MCP clients while runtime `op=handoff` accepts `evidenceItems` or string/array `evidence`), `decisions` (`type: "array"`), `assumptions` (`type: "array"`), `unresolvedIssues` (`type: "array"`) — CLI flags `--objective`, `--evidence`, `--decisions`, `--assumptions`, `--unresolved-issues` / `--unresolvedIssues`.
4. **`web/src/types.ts` & `web/src/views/AgileBoard.ts`:** Mirror the 5 optional fields on `ContextHandoffRecord` and display non-empty `Objective`, `Decisions`, `Assumptions`, `Unresolved Issues`, and `Evidence` blocks inside `renderHandoffBrief()`.

---

## 5. Parallel Execution Plan & Verification

- **`backend-engineer` scope:** `src/schema/board.ts`, `src/board/engine.ts`, `src/mcp/server.ts`, `src/cli/index.ts`, `src/templates/prompts.ts`, `src/templates/skills.ts`, `.agent-team/` + compiled outputs via `npx agent-studio sync`, and unit tests (`tests/unit/model-routing.test.ts`, `tests/unit/compiler.test.ts`, `tests/unit/board-lock-and-gate.test.ts`, `tests/unit/mcp-stdio.test.ts`).
- **`frontend-engineer` scope:** `web/src/types.ts`, `web/src/views/AgileBoard.ts`, `web/src/styles/views.css`.
- **QA Gate Checkpoints:**
  - `CP0`: `npm run check && npm --prefix extension run check && npm test` (verify new assertions for 10 rules, `expected_cost`, 11 triggers, JSON output contract, enhanced `orchestrator` prompt, backwards-compatible + full `ContextHandoffSchema` round-trips).
  - `CP1`: `npm --prefix web run check && npm --prefix web run build`
  - `CP2`: `python tests/smoke_test.py`
  - **Sync & Health:** `npx agent-studio sync --check` exits `0`; `npx agent-studio doctor --json` passes.
