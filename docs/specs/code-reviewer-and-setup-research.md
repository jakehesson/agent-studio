# Technical Specification: First-Class `code-reviewer` Agent & Architecture-Research Onboarding (`team-setup`)

- **Board Item:** `S1-48`
- **Status:** Design Specification (`design -> dev`)
- **Scope:** `.agent-team/`, `src/schema/`, `src/models/`, `src/templates/`, `src/cli/`, `antigravity-plugin/`, `docs/`, `tests/`
- **Related Docs:** [SETUP_AGENT.md](../SETUP_AGENT.md) · [USAGE.md](../USAGE.md) · [model-routing-and-index.md](./model-routing-and-index.md)

---

## 1. Goal, Non-Goals & Architectural Invariants

### Goal
1. Introduce **`code-reviewer`** as a first-class blueprint agent across canonical `.agent-team/`, CLI scaffolding (`src/templates/`), Model Index (`DEFAULT_MODEL_INDEX`), and compiled adapters (**Antigravity**, **Claude Code**, **VS Code Copilot**), equipped with a universal 5-pillar code review skill (`skills/code-review`) and a repo-tailored architecture conformance skill (`skills/architecture-review`).
2. Upgrade **`team-setup`** (agent prompt, `skills/team-setup/SKILL.md`, `antigravity-plugin`, and deterministic pre-scan in `src/templates/detect.ts` + `src/cli/`) so onboarding deeply researches the target repository's architectural style, state/concurrency contracts, invariants, and failure modes—and persists a tailored `skills/architecture-review/SKILL.md` and `agents/code-reviewer.md` rubric for that repo.

### Non-Goals
- **Do not** add breaking changes to `TeamManifestSchema` (`RoleTypeSchema`), `BoardSchema`, or stdio `MCP_TOOLS` (`src/mcp/server.ts`).
- **Do not** grant `code-reviewer` source-editing (`edit`, `write_docs`, `edit_tests`) or QA gate-closing (`mcp_testrun`) permissions; code review remains strictly non-mutating on source files and distinct from `qa-validator`'s formal testrun gate.
- **Do not** make `doctor.ok` fail when `skills/architecture-review/SKILL.md` has not yet been customized by `team-setup`; `npx agent-studio init --non-interactive` must continue passing `doctor` cleanly in CI.

### Codebase Reality & Template Architecture Mapping
> Note for implementers: Agent Studio does **not** store raw `team.yaml` or `model-index.json` files under `src/templates/` or a root `skills/` folder. Canonical workspace artifacts live in `.agent-team/`, while CLI scaffolding templates are authored programmatically in TypeScript:
> - **Canonical Agent Studio repo config:** `.agent-team/team.yaml`, `.agent-team/model-index.json`, `.agent-team/agents/*.md`, `.agent-team/skills/*/SKILL.md`
> - **CLI Template Builders:** `src/templates/manifest.ts` (`buildDefaultTeamManifest`, `scaffoldAgentTeam`), `src/templates/prompts.ts`, `src/templates/skills.ts`, `src/templates/detect.ts`
> - **Layer 0 Model Seed:** `src/schema/model-index.ts` (`DEFAULT_MODEL_INDEX`) & `src/models/defaults.ts` (`defaultTierForRoleType`)

---

## 2. First-Class `code-reviewer` Agent Contract

### 2.1 Canonical Roster & Schema Compatibility
`RoleTypeSchema` (`"orchestrator" | "specialist" | "qa" | "setup"`) remains unchanged for 100% backwards compatibility. Like `architect` (`boardRole: "design"`) and `ux-designer` (`boardRole: "ux"`), `code-reviewer` registers as:

```yaml
- id: code-reviewer
  name: Code Reviewer
  roleType: specialist
  boardRole: review
  promptFile: agents/code-reviewer.md
  modelTier: reasoning
  capabilities:
    - read
    - search
    - shell
    - mcp_board
  description: Rigorous code reviewer auditing syntax, security, architecture
    conformance, performance, concurrency, and test coverage before QA gate
    sign-off.
```

- **Roster Placement:** Between `frontend-engineer` and `qa-validator`.
- **`orchestrator.handoffs`:**
  - Blueprint default (`src/templates/manifest.ts`): `["architect", "ux-designer", "backend-engineer", "frontend-engineer", "code-reviewer", "qa-validator"]`
  - Repo `.agent-team/team.yaml`: `["architect", "ux-designer", "backend-engineer", "frontend-engineer", "code-reviewer", "qa-validator", "release-engineer"]`

### 2.2 Capability Mapping & Read-Only Review Sandbox
With `capabilities: ["read", "search", "shell", "mcp_board"]` (omitting `edit`, `write_docs`, `edit_tests`, `mcp_testrun`), `src/compiler/capabilities.ts` compiles the following native tool allowlists with **zero compiler branching needed**:

| IDE Target | Output Path | Compiled `tools` | Model (`prefer-fallback`) |
| :--- | :--- | :--- | :--- |
| **Antigravity** | `.agents/plugins/<id>-team/agents/code-reviewer.md` | `["read_file", "run_command"]`, `inheritMcp: true`, `mainAgent: false`, `subagent: true` | `pro` |
| **Claude Code** | `.claude/agents/code-reviewer.md` | `["Read", "Glob", "Grep", "Bash", "mcp__agent-studio__board", "mcp__agent-studio__projects"]` | `opus` |
| **VS Code Copilot** | `.github/agents/code-reviewer.agent.md` | `["read/readFile", "search/codebase", "search/textSearch", "search/fileSearch", "execute/runInTerminal", "agent-studio/*"]` | `["Claude Opus 4.5 (copilot)", ...]` + `model-policy: preferred` |

- **Containment Rule:** `code-reviewer.md` must explicitly instruct the agent that shell tools (`run_command` / `Bash` / `execute/runInTerminal`) are for read-only diff/check inspection (`git diff`, `git status`, `rg`, typecheck, linter, targeted test execution) and never for modifying repository files. `PreToolUse` (`hook-emit.ts`) continues blocking direct writes to `pipeline/board.json`.

### 2.3 Model Routing Defaults (`src/schema/model-index.ts`, `src/models/defaults.ts`, `.agent-team/model-index.json`)
1. **`DEFAULT_MODEL_INDEX.roleRecommendations["code-reviewer"]`** (Layer 0 seed) & **`.agent-team/model-index.json`**:
   ```json
   "code-reviewer": {
     "tier": "reasoning",
     "rationale": "Deep code review for security vulnerabilities, architecture conformance, concurrency bugs, performance regressions, and test coverage."
   }
   ```
2. **`defaultTierForRoleType(roleType, roleId)`** in `src/models/defaults.ts` (and mirrored fallback in `web/src/views/Team.ts` `defaultTierForRole`):
   - Return `"reasoning"` when `lowId === "architect" || lowId === "ux-designer" || lowId === "code-reviewer"` (or `rt === "review"`).

### 2.4 Code Review Capabilities & Workflow Integration
1. **Skill 1 — `skills/code-review/SKILL.md` (Universal 5-Pillar Rubric):**
   - **Pillar 1 — Syntax, Types & Correctness:** Type soundness, null/undefined handling, exhaustiveness, schema/contract alignment, dead code, error propagation.
   - **Pillar 2 — Security & Trust Boundaries:** Injection (SQL/shell/HTML/XSS), path traversal & symlink escape, authn/authz enforcement, secret exposure, input bounds/payload caps, unsafe deserialization.
   - **Pillar 3 — Architecture Conformance:** Compliance with repo-specific layering, dependency direction, invariants, and rules defined in `skills/architecture-review/SKILL.md` and the active Architect spec.
   - **Pillar 4 — Performance, Resource & Concurrency Safety:** Algorithmic complexity, N+1 queries, unbounded loops/buffers, race conditions, lock acquisition/release (`finally` cleanup), async timeouts/backpressure, memory leaks.
   - **Pillar 5 — Test Coverage & Edge Cases:** Happy path + failure/boundary tests, regression coverage for bug fixes, deterministic mocks/temp isolation, no skipped/relaxed assertions.
   - **Finding Classification & Output Contract:**
     - `[P0 Blocker]` — Security flaw, data corruption, crash, race condition, or violated hard invariant (must return `test -> dev`; file bug via `board { op: "add", type: "bug" }`).
     - `[P1 Required]` — Missing test coverage for core logic, broken boundary/error handling, architectural violation, or significant perf regression (must resolve before QA gate).
     - `[P2 Advisory]` — Non-blocking clarity, naming, or minor refactor suggestions.
   - **Board Handoff:** Post structured review summary (`CODE REVIEW PASS` or `CODE REVIEW CHANGES REQUESTED` with file:line citations) via `board { op: "note" }`.
2. **Skill 2 — `skills/architecture-review/SKILL.md` (Repo-Tailored Profile & Rubric):**
   - Holds the target repo's researched architectural style, module boundary rules, state/concurrency contracts, failure modes, and project-specific `P0`/`P1`/`P2` checks.
   - Scaffolder (`src/templates/skills.ts`) generates a structured baseline seeded from `detectRepoStack()` signals with status `PENDING DEEP RESEARCH (run team-setup)`.
   - In this repo (`.agent-team/skills/architecture-review/SKILL.md`), pre-populate **Agent Studio**'s real invariants (CI determinism Layer 0+2 only, atomic file locks for `board.json` / `model-index.json` / `team.yaml`, `orchestratorReadOnly` 3-layer enforcement, `embed=1` IDE Extension Scoping Invariant, SemVer lockstep across 3 `package.json` files, Galaxy Z Fold 7 3-tier CSS layout, zero-dep Python fallback parity, no hand-edits to compiled IDE files).
3. **Orchestrator Integration (`renderOrchestratorPrompt` + `.agent-team/agents/orchestrator.md`):**
   - Update Dispatch Loop step 5 so after implementation (`dev -> test`), `orchestrator` dispatches `code-reviewer` for non-trivial code changes (security, architecture, concurrency, coverage) before or alongside `qa-validator` formal checkpoint execution (`testrun`).

---

## 3. Enhanced `team-setup` Research Workflow & CLI Contracts

### 3.1 Deterministic Architecture Signal Pre-Scan (`src/templates/detect.ts`)
Extend `DetectedRepoInfo` additively (no breaking changes to existing fields):

```ts
export type ArchitecturalTopology =
  | "modular-monolith"
  | "monorepo"
  | "microservices"
  | "layered"
  | "event-driven"
  | "full-stack-web"
  | "cli-library"
  | "unknown";

export interface DetectedArchitectureSignals {
  topologyHints: ArchitecturalTopology[];
  frameworks: string[];
  stateManagement: string[];
  concurrencySignals: string[];
  apiBoundaries: string[];
  storageSignals: string[];
  topLevelDirs: string[];
  monorepoWorkspaces: string[];
  ciWorkflows: string[];
}

export interface DetectedRepoInfo {
  // existing fields preserved verbatim...
  architecture: DetectedArchitectureSignals;
}
```

**Bounded Scan Contract (`detectArchitectureSignals`):**
- Only inspect `projectRoot` depth 1 directory entries (ignoring `node_modules`, `.git`, `dist`, `out`, `build`, `target`, `__pycache__`, `.venv`), `.github/workflows/*.yml` filenames, and already-read root manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) plus shallow presence checks for `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`, `go.work`, `docker-compose.yml`, `compose.yaml`.
- Never recurse unboundedly, never follow external symlinks, and never read source file contents during `init` (keep `detectRepoStack()` `< 10ms` and deterministic).
- Map dependency/directory signals deterministically to:
  - `topologyHints`: e.g., `workspaces` / `packages/` / `apps/` -> `"monorepo"`; `docker-compose` / `services/` / `k8s/` -> `"microservices"`; `web/` + `src/server/` or Next/Nuxt/Remix -> `"full-stack-web"`; `bin` / `src/cli/` -> `"cli-library"`; `kafka`/`nats`/`bullmq`/`amqplib`/`sse` -> `"event-driven"`; `domain/`/`application/`/`infrastructure/`/`adapters/` -> `"layered"`.
  - `frameworks`, `stateManagement`, `concurrencySignals`, `apiBoundaries`, `storageSignals` from manifest dependency names.

### 3.2 `src/templates/` & `src/cli/` Updates
1. **`src/templates/skills.ts`:**
   - Change signature to `getDefaultSkills(detected?: DetectedRepoInfo): SkillTemplate[]` (keeping `detected` optional preserves zero-arg callers in `src/compiler/global-install.ts`).
   - Add `"code-review"` and `"architecture-review"` entries.
   - `renderArchitectureReviewSkillTemplate(detected?: DetectedRepoInfo)` embeds the detected `DetectedArchitectureSignals` block and a `<!-- architecture-research: pending -->` (or `Status: PENDING DEEP RESEARCH — run team-setup`) marker plus structured sections for `team-setup` to complete.
   - Update `"team-setup"` skill with the mandatory Deep Architectural Research & `code-reviewer` Tailoring steps.
2. **`src/templates/prompts.ts`:**
   - Add `renderCodeReviewerPrompt(manifest: TeamManifest, detected?: DetectedRepoInfo): string`.
   - Enhance `renderTeamSetupPrompt(manifest?: TeamManifest)` Step 1 & Step 4 with explicit architectural research tasks:
     - **Step 1b — Deep Architectural Research:** Inspect entry points, module graph, state stores, concurrency primitives, and trust boundaries (delegating 5+ file surveys to a read-only `research` subagent) to classify architectural style (monolith, modular monolith, microservices, layered/clean/hexagonal, event-driven, full-stack framework conventions), state management, and concurrency model.
     - **Step 1c — Invariants & Failure Modes:** Extract repository-specific invariants, coupling/lockstep rules, forbidden cross-layer imports, and known/likely failure modes (races, stale locks, schema drift, auth bypasses, resource leaks).
     - **Step 4b — Equip `code-reviewer`:** Populate `.agent-team/skills/architecture-review/SKILL.md` (clearing the `PENDING DEEP RESEARCH` status) and customize `.agent-team/agents/code-reviewer.md` with repo-specific review focus, static commands, and `P0`/`P1`/`P2` architectural rubric before running `npx agent-studio sync` and `npx agent-studio doctor`.
3. **`src/templates/manifest.ts`:**
   - Include `code-reviewer` in `buildDefaultTeamManifest()` `roster` and `orchestrator.handoffs`, and include `"skills/code-review"` and `"skills/architecture-review"` in `manifest.skills`.
   - Write `.agent-team/agents/code-reviewer.md` in `scaffoldAgentTeam()` and pass `detected` into `getDefaultSkills(detected)`.
4. **`src/cli/commands/init.ts`:**
   - Print an `Arch:` summary line in non-quiet text mode summarizing `scaffold.detected.architecture.topologyHints` and `frameworks` (plus a hint to invoke `team-setup` for deep architectural tailoring). JSON output automatically includes `scaffold.detected.architecture`.
5. **`src/cli/commands/doctor.ts`:**
   - Add an **informational, non-blocking** `architectureReview` field to `DoctorReport`:
     ```ts
     export interface ArchitectureReviewHealthInfo {
       codeReviewerDefined: boolean;
       codeReviewSkillPresent: boolean;
       architectureSkillPresent: boolean;
       customized: boolean; // false if architecture-review/SKILL.md still contains PENDING DEEP RESEARCH marker
     }
     ```
   - **Invariant:** `architectureReview.customized === false` MUST **not** fail `doctor.ok` or exit code `1` (emit an informational status line in `formatDoctorText` only).
6. **`antigravity-plugin/scripts/build-plugin.mjs`:**
   - Update `TEAM_SETUP_AGENT_MD` workflow bullets to include architectural style/invariant research and equipping `code-reviewer` + `skills/architecture-review/SKILL.md`.

---

## 4. Exclusive File Ownership & Execution Plan

| Workstream | Owner | Exclusive Write Scope |
| :--- | :--- | :--- |
| **Backend + Templates + CLI + `.agent-team/`** | `backend-engineer` | `src/schema/model-index.ts`, `src/models/defaults.ts`, `src/templates/detect.ts`, `src/templates/prompts.ts`, `src/templates/skills.ts`, `src/templates/manifest.ts`, `src/cli/commands/init.ts`, `src/cli/commands/doctor.ts`, `antigravity-plugin/scripts/build-plugin.mjs`, `.agent-team/**`, compiled `.agents/plugins/agent-studio-team/**`, `.claude/**`, `.github/**`, `CLAUDE.md`, `docs/SETUP_AGENT.md`, `docs/USAGE.md`, `docs/guides/*.md` |
| **Frontend Tier Fallback Sync (Tiny)** | `frontend-engineer` (or `backend-engineer` if sequential) | `web/src/views/Team.ts` (`defaultTierForRole` 1-line addition of `"code-reviewer"` / `"review"`) |
| **QA & Regression Tests** | `qa-validator` | `tests/unit/compiler.test.ts`, `tests/unit/model-routing.test.ts` (update `handoffs.length` 5->6 and add `code-reviewer`, `detectArchitectureSignals`, `architecture-review` skill, and `doctor.architectureReview` assertions) + formal MCP `testrun` |

---

## 5. Edge Cases & Compatibility Constraints

1. **Brownfield Upgrades (`init` without `--force`):** Existing `.agent-team/team.yaml` and customized agent prompts are preserved by `writeIfAllowed()`. Document in `team-setup` & `docs/SETUP_AGENT.md` how `team-setup` upgrades an existing repo non-destructively (adding `code-reviewer` to `team.yaml` + `model-index.json`, writing missing `code-reviewer.md` / `code-review/SKILL.md` / `architecture-review/SKILL.md`, and running `sync`).
2. **Idempotency & CI Drift:** `detectArchitectureSignals()` output for a given directory tree must be sorted deterministically (alphabetical `topLevelDirs`, `frameworks`, etc.) so `scaffoldAgentTeam()` + `compileTeam()` + `checkTeamDrift()` produces zero spurious diffs.
3. **Existing Unit Test Coupling:** `tests/unit/compiler.test.ts` lines 268–272 currently assert `vscOrchFm.handoffs.length === 5` and exact 5-element array `["architect", "ux-designer", "backend-engineer", "frontend-engineer", "qa-validator"]`; this must be updated to `6` elements with `"code-reviewer"` inserted before `"qa-validator"`.
4. **Global Setup (`init --global`):** `installGlobalSetupAgent()` calls `getDefaultSkills().find((s) => s.id === "team-setup")`. Keeping `detected` optional on `getDefaultSkills(detected?)` guarantees global install remains clean and project-agnostic while delivering the upgraded `team-setup` skill everywhere.

---

## 6. Verification Criteria (`qa-validator` Checklist)

1. **Checkpoints (Required Suite):**
   - `CP0`: `npm run check && npm test` passes with zero TS errors and 100% unit tests green.
   - `CP1`: `npm --prefix web run check && npm --prefix web run build` passes cleanly.
   - `CP2`: `python tests/smoke_test.py` passes with exit code `0`.
   - **Additional CLI/Plugin Checks:**
     - `node dist/cli/index.js sync --check` exits `0` in repo root (zero drift across Antigravity, Claude Code, VS Code Copilot).
     - `node dist/cli/index.js doctor --json` reports `ok: true` and `architectureReview: { codeReviewerDefined: true, codeReviewSkillPresent: true, architectureSkillPresent: true, customized: true }`.
     - `node antigravity-plugin/scripts/build-plugin.mjs` exits `0`.
2. **Required New / Updated Unit Assertions:**
   - **Default Blueprint & Compilers (`tests/unit/compiler.test.ts`):**
     - `scaffoldAgentTeam()` creates `.agent-team/agents/code-reviewer.md`, `.agent-team/skills/code-review/SKILL.md`, and `.agent-team/skills/architecture-review/SKILL.md`.
     - Compiled Antigravity (`code-reviewer.md`), Claude Code (`code-reviewer.md`), and Copilot (`code-reviewer.agent.md`) contain SHA-256 markers, read+search+shell+mcp_board tools, and **omit** all file-edit tools (`write_file`, `edit_file`, `Edit`, `Write`, `MultiEdit`, `edit/editFiles`, `edit/createFile`).
     - Copilot `orchestrator.agent.md` `handoffs` includes `"code-reviewer"` (6 handoffs total).
     - `detectRepoStack()` populates `architecture` signals deterministically across Node/monorepo/microservices/Python/Rust/Go fixtures without crashing on empty repos.
     - `runInit()` passes `buildDoctorReport()` with `doctor.ok === true` even when `architectureReview.customized === false`.
   - **Model Routing (`tests/unit/model-routing.test.ts`):**
     - `DEFAULT_MODEL_INDEX.roleRecommendations["code-reviewer"]?.tier === "reasoning"`.
     - `defaultTierForRoleType("specialist", "code-reviewer") === "reasoning"`.
     - Compiled `code-reviewer` resolves to `pro` (Antigravity), `opus` (Claude Code), and `Claude Opus 4.5 (copilot)` fallback array (Copilot) under `prefer-fallback`.
