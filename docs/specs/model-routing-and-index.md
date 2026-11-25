# Technical Specification: Per-Role Model Routing, Built-In IDE Compatibility & Agent-Readable Model Index

- **Board Item:** `S1-41` (feeds `S1-42` Backend and `S1-43` Frontend + UX)
- **Status:** Design Specification
- **Target Release:** `0.5.0` (lockstep across `package.json`, `extension/package.json`, `web/package.json`)
- **Related Docs:** [IDE_INTEGRATION.md](../IDE_INTEGRATION.md) · [SETUP_AGENT.md](../SETUP_AGENT.md) · [IDE_EXTENSION.md](../IDE_EXTENSION.md)

---

## 1. Goal, Non-Goals & Invariants

### Goal
Enable deterministic, cost- and quality-aware **per-role model routing** across **Antigravity**, **Claude Code**, and **VS Code / GitHub Copilot** backed by an **agent-readable, app-updatable Model Index (`model-index.json`)**, while staying 100% compatible with built-in IDE orchestrators and model pickers (**Antigravity `/swarm`**, **Copilot Fusion / Auto**, **Claude Code `/model` & `CLAUDE_CODE_SUBAGENT_MODEL`**).

### Non-Goals
- **Do not** hardcode fragile preview model IDs into compiled agent frontmatter by default; emit portable tier enums (`flash_lite`/`flash`/`pro`), family aliases (`haiku`/`sonnet`/`opus`), or preferred fallback arrays (`model-policy: preferred`).
- **Do not** fight or override host built-in orchestrators when `/swarm`, Copilot Fusion/Auto, or user/env overrides are active.
- **Do not** alter the existing stdio `MCP_TOOLS` array in `src/mcp/server.ts` (pinned by `tests/unit/mcp-stdio.test.ts`); extend `app_get_team` / `GET /api/team` additively and expose writes via CLI + REST `/api/model-index` + `skills/model-routing/SKILL.md`.
- **Do not** let machine-local `vscode.lm.selectChatModels()` refreshes dirty Git repositories or break CI `agent-studio sync --check`.

### Architectural Invariants
1. **CI Determinism Invariant:** `compileTeam()` and `checkTeamDrift()` read **only** Layer 0 (built-in defaults) + Layer 2 (repo `.agent-team/model-index.json` + `.agent-team/team.yaml`) unless `--use-global-index` is explicitly passed.
2. **Backwards-Compatible `team.yaml`:** All new fields on `WorkflowConfigSchema` and `RosterEntrySchema` are `.optional()`, preserving exact `parseTeamYaml -> serializeTeamYaml -> parseTeamYaml` round-trips for existing manifests (`tests/unit/schema.test.ts`).
3. **IDE Extension Scoping Invariant (`embed=1`):** Embedded views (`embed=1&ide=<host>&workspace=<root>`) display and edit only the active host IDE's models, policies, and checks. Standalone Web Studio exposes all three IDEs.

---

## 2. Model Index Schema & 3-Layer Storage / Overlay Semantics

### 2.1 Storage Layers & Resolution Precedence

| Layer | Path | Owner / Writer | Read By | Git-Tracked |
| :--- | :--- | :--- | :--- | :--- |
| **Layer 0: Built-in Seed** | `DEFAULT_MODEL_INDEX` in `src/schema/model-index.ts` | Package / CLI / Extension bundle | Always (base layer) | Yes (code) |
| **Layer 1: Global Overlay** | `<getAgentStudioHome()>/model-index.json` (`~/.agent-studio/model-index.json`, respects `AGENT_STUDIO_HOME`) | VS Code `vscode.lm` live sync, `agent-studio models ... --scope global`, `PUT /api/model-index?scope=global` | Runtime APIs (`GET /api/model-index`, `GET /api/team`, `models show`), `sync --use-global-index` | No |
| **Layer 2: Workspace Override** | `<projectRoot>/.agent-team/model-index.json` | `agent-studio init`, repo agents (`team-setup`), `agent-studio models ... --scope workspace`, Web Studio workspace save | `compileTeam()`, `sync --check`, `doctor`, runtime APIs | Yes |

### 2.2 Overlay Merge Rules (`resolveEffectiveModelIndex`)
1. `roleRecommendations`: shallow-merge per `roleId` (`Layer 2 > Layer 1 > Layer 0`).
2. `ides[ide].tiers[tier]`: merge per `(ide, tier)` (`Layer 2 > Layer 1 > Layer 0`).
3. `ides[ide].catalog`: **upsert by `(ide, entry.id)`** rather than replacing the array whole:
   - Start from Layer 0 built-in entries.
   - Apply Layer 1 entries by `id` (adding newly discovered `vscode-lm` entries and updating `available`, `label`, `vendor`, `family`, `contextWindow`, `discoveredAt`).
   - Apply Layer 2 entries by `id` (preserving Layer 1 `vscode-lm` entries that are not explicitly overridden in Layer 2, so live VS Code availability remains visible even when `.agent-team/model-index.json` exists).
   - When Layer 1 marks a previously `"vscode-lm"` entry `available: false`, that live availability status propagates unless Layer 2 explicitly sets `source: "user"` or `source: "agent"`.

### 2.3 Zod Schema (`src/schema/model-index.ts`)

```ts
export const ModelTierSchema = z.enum(["fast", "balanced", "reasoning"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const ModelRoutingPolicySchema = z.enum([
  "defer-to-host",
  "prefer-fallback",
  "pinned",
]);
export type ModelRoutingPolicy = z.infer<typeof ModelRoutingPolicySchema>;

export const ModelCapabilityTagSchema = z.enum([
  "coding",
  "reasoning",
  "multimodal",
  "fast",
  "orchestration",
  "search",
  "long-context",
]);

export const ModelSourceTagSchema = z.enum([
  "built-in",
  "vscode-lm",
  "agent",
  "user",
]);

export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  vendor: z.string().optional(),
  family: z.string().optional(),
  tier: ModelTierSchema,
  capabilities: z.array(ModelCapabilityTagSchema).default([]),
  contextWindow: z.number().int().positive().optional(),
  premiumMultiplier: z.number().nonnegative().optional(),
  available: z.boolean().default(true),
  source: ModelSourceTagSchema.default("built-in"),
  discoveredAt: z.string().optional(),
  notes: z.string().optional(),
}).passthrough();

export const IdeTierBindingSchema = z.object({
  primary: z.string().min(1),
  fallback: z.array(z.string().min(1)).default([]),
  omitOnDefer: z.boolean().optional(),
  notes: z.string().optional(),
}).passthrough();

export const IdeModelConfigSchema = z.object({
  mode: z.enum(["tier-enum", "family-alias", "picker-array"]),
  tiers: z.object({
    fast: IdeTierBindingSchema,
    balanced: IdeTierBindingSchema,
    reasoning: IdeTierBindingSchema,
  }),
  catalog: z.array(ModelCatalogEntrySchema).default([]),
  lastSyncedAt: z.string().optional(),
  syncSource: z.enum(["built-in", "vscode-lm", "manual"]).optional(),
}).passthrough();

export const RoleRecommendationSchema = z.object({
  tier: ModelTierSchema,
  rationale: z.string().min(1),
  multimodalPreferred: z.boolean().optional(),
  deferToHostOrchestrator: z.boolean().optional(),
}).passthrough();

export const ModelIndexSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1).default(1),
  updatedAt: z.string().min(1),
  updatedBy: z.enum(["built-in", "cli", "api", "vscode-lm", "agent", "user"]).default("built-in"),
  notes: z.string().optional(),
  roleRecommendations: z.record(z.string(), RoleRecommendationSchema),
  ides: z.object({
    antigravity: IdeModelConfigSchema,
    "claude-code": IdeModelConfigSchema,
    "copilot-vscode": IdeModelConfigSchema,
  }),
}).passthrough();
```

Also export `ModelIndexOverlaySchema` (same top-level `schemaVersion: 1` with `roleRecommendations`, `ides.*.tiers.*`, and `ides.*.catalog` optional/partial) for sparse Layer 1 and Layer 2 files.

### 2.4 Built-In Research-Backed Role & Tier Defaults (`DEFAULT_MODEL_INDEX`)

| Role ID | Default Tier | Special Flags | Rationale |
| :--- | :--- | :--- | :--- |
| `orchestrator` | `fast` | `deferToHostOrchestrator: true` | Read-only board triage, dispatch, and QA gate verification (#1 token-savings lever). |
| `architect` | `reasoning` | — | Technical specs, schemas, concurrency, and boundaries have highest downstream leverage. |
| `ux-designer` | `reasoning` | `multimodalPreferred: true` | Layout audits, visual hierarchy, multimodal UI inspection, and Z Fold 7 ergonomics. |
| `backend-engineer` | `balanced` | — | Server, CLI, compiler, and unit-test throughput with strong coding precision. |
| `frontend-engineer` | `balanced` | — | Interactive UI, SVG/CSS, and iterative typecheck/build fixes. |
| `qa-validator` | `fast` | — | Deterministic checkpoint runs, MCP testrun recording, and pass/fail triage (#2 token-savings lever). |
| `team-setup` | `balanced` | — | Repo inspection, user interview, deterministic `init`/`sync`/`doctor` onboarding. |

#### Built-In IDE Tier Bindings

| Tier | Antigravity (`tier-enum`) | Claude Code (`family-alias`) | VS Code Copilot (`picker-array`) |
| :--- | :--- | :--- | :--- |
| `fast` | `primary: "flash_lite"`, `fallback: ["flash_lite", "flash", "inherit"]` | `primary: "haiku"`, `fallback: ["haiku", "sonnet", "inherit"]` | `primary: "Claude Haiku 4.5 (copilot)"`, `fallback: ["Claude Haiku 4.5 (copilot)", "Gemini 3 Flash (copilot)", "GPT-4.1 (copilot)", "GPT-4o mini (copilot)"]`, `omitOnDefer: true` |
| `balanced` | `primary: "flash"`, `fallback: ["flash", "pro", "inherit"]` | `primary: "sonnet"`, `fallback: ["sonnet", "opus", "inherit"]` | `primary: "Claude Sonnet 4.5 (copilot)"`, `fallback: ["Claude Sonnet 4.5 (copilot)", "Claude Sonnet 4 (copilot)", "GPT-4.1 (copilot)", "Gemini 2.5 Pro (copilot)"]`, `omitOnDefer: true` |
| `reasoning` | `primary: "pro"`, `fallback: ["pro", "flash", "inherit"]` | `primary: "opus"`, `fallback: ["opus", "sonnet", "inherit"]` | `primary: "Claude Opus 4.5 (copilot)"`, `fallback: ["Claude Opus 4.5 (copilot)", "Claude Opus 4.1 (copilot)", "Claude Sonnet 4.5 (copilot)", "Gemini 2.5 Pro (copilot)"]`, `omitOnDefer: true` |

**Seed Catalog Coverage:**
- **Antigravity:** `inherit`, `flash_lite`, `flash`, `pro`, plus family metadata entries (`gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-neon`, `gemini-4-hydrogen`).
- **Claude Code:** `inherit`, `haiku`, `sonnet`, `opus`.
- **Copilot / VS Code:** Seed picker strings above (`source: "built-in"`), automatically augmented/annotated by live `vscode.lm.selectChatModels()` (`source: "vscode-lm"`).

### 2.5 Concurrency & Atomic Persistence (`src/models/store.ts`)
- Mirror `src/board/store.ts`:
  - `withModelIndexLock(filePath, fn)` using `<filePath>.lock` (`O_CREAT | O_EXCL`, `staleMs = 30_000`, `timeoutMs = 10_000`).
  - `writeJsonAtomic(filePath, data)` using temp file + `fsync` + `renameWithRetry` (handles Windows `EPERM`/`EACCES`/`EBUSY`).
  - `writeTeamYamlAtomic(teamYamlPath, manifest)` using the same lock + atomic rename pattern whenever CLI/REST updates `.agent-team/team.yaml`.

---

## 3. `team.yaml` Per-Role Model Routing & Host Compatibility Policies

### 3.1 Schema Extensions (`src/schema/team.ts`)

Add optional fields to `WorkflowConfigSchema` and `RosterEntrySchema`:

```ts
export const IdeModelOverrideSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z.object({
    primary: z.string().min(1).optional(),
    fallback: z.array(z.string().min(1)).optional(),
    omit: z.boolean().optional(),
    copilotPolicy: z.enum(["preferred", "required"]).optional(),
  }).passthrough(),
]);

export const WorkflowModelRoutingSchema = z.object({
  policy: ModelRoutingPolicySchema.default("prefer-fallback"),
  respectBuiltInOrchestrators: z.boolean().default(true),
  allowSubagentModelHints: z.boolean().default(true),
  copilotHandoffModels: z.boolean().default(false),
  idePolicies: z.object({
    antigravity: ModelRoutingPolicySchema.optional(),
    "claude-code": ModelRoutingPolicySchema.optional(),
    "copilot-vscode": ModelRoutingPolicySchema.optional(),
  }).optional(),
}).passthrough();
```

- On `WorkflowConfigSchema`: `modelRouting: WorkflowModelRoutingSchema.optional()`
- On `RosterEntrySchema`:
  - `modelTier: ModelTierSchema.optional()`
  - `modelPolicy: ModelRoutingPolicySchema.optional()`
  - `models: z.object({ antigravity: IdeModelOverrideSchema.optional(), "claude-code": IdeModelOverrideSchema.optional(), "copilot-vscode": IdeModelOverrideSchema.optional() }).optional()`

### 3.2 Precedence & Policy Semantics (`src/models/resolver.ts`)

For `(manifest, role, ide, index)`:
1. **Effective Policy:**
   `role.modelPolicy ?? manifest.workflow.modelRouting?.idePolicies?.[ide] ?? manifest.workflow.modelRouting?.policy ?? "prefer-fallback"`
2. **Effective Tier:**
   `role.modelTier ?? index.roleRecommendations[role.id]?.tier ?? defaultTierForRoleType(role.roleType, role.id)`
   (Fallback by `roleType`: `orchestrator -> fast`, `qa -> fast`, `architect | ux-designer -> reasoning`, others -> `balanced`).
3. **Emission Matrix by Policy:**

| Policy | Antigravity (`.agents/plugins/.../agents/<role>.md`) | Claude Code (`.claude/agents/<role>.md`) | VS Code Copilot (`.github/agents/<role>.agent.md`) |
| :--- | :--- | :--- | :--- |
| **`defer-to-host`** | Emit `model: inherit` (or omit if override `{ omit: true }`) | Emit `model: inherit` (yields to `CLAUDE_CODE_SUBAGENT_MODEL` & `/model`) | **Omit `model` & `model-policy`** completely (unlocks **Copilot Fusion / Auto** + 10% Auto discount) |
| **`prefer-fallback`** *(default)* | Emit `model: <tierEnum \| override>` (`flash_lite` \| `flash` \| `pro` \| `inherit`) — compatible with `/swarm` & UI picker | Emit `model: <familyAlias \| override>` (`haiku` \| `sonnet` \| `opus` \| `inherit`) — overridden by `CLAUDE_CODE_SUBAGENT_MODEL` & invocation param | Emit `model: [<ordered picker strings>]` (or string override) AND **`model-policy: preferred`** (never `required`, preserves Fusion/org/user overrides) |
| **`pinned`** | Emit explicit `override` ID or concrete catalog ID matching tier (falls back to tier enum if none) | Emit explicit `override` ID or concrete catalog ID matching tier (falls back to alias if none) | Emit explicit `model` + **`model-policy: required`** (or `override.copilotPolicy ?? "required"`) |

### 3.3 Built-In Host Compatibility Guardrails
- **Antigravity `/swarm` & `invoke_subagent`:** When `respectBuiltInOrchestrators` is `true` (default), compiled orchestrator rules & prompt explicitly instruct `orchestrator` to pass `Model: "inherit"` (or omit explicit model forcing) whenever `/swarm` or a user UI Model Selection override is active, and otherwise use tier enums (`flash_lite`/`flash`/`pro`) when `allowSubagentModelHints` is `true`.
- **VS Code Copilot Fusion / Auto & Handoffs:**
  - `model-policy: required` is **never** emitted unless `policy === "pinned"` or `override.copilotPolicy === "required"`.
  - `handoffs[].model` is **omitted by default** (`copilotHandoffModels: false`) so Copilot handoffs follow target agent `model` + `model-policy: preferred` or active Fusion/Auto selection. When `copilotHandoffModels: true` and target policy is not `defer-to-host`, emit `handoffs[].model` from target's primary model string.
- **Claude Code Hierarchy:** Frontmatter `model:` obeys native resolution (`CLAUDE_CODE_SUBAGENT_MODEL` env -> `Agent` invocation param -> `.claude/agents/<role>.md` `model:` -> session `/model`).

---

## 4. Cross-IDE Compiler Rules, Telemetry Definitions, Doctor Checks & Templates

### 4.1 Compilers (`src/compiler/`)
- **`antigravity.ts`:** Resolve each role via `resolveRoleModel(manifest, role, "antigravity", modelIndex)`. Unless `resolved.omit`, set `fmObj.model = resolved.frontmatterModel`.
- **`claude-code.ts`:** Resolve each role via `resolveRoleModel(manifest, role, "claude-code", modelIndex)`. Unless `resolved.omit`, set `fmObj.model = resolved.frontmatterModel`.
- **`copilot-vscode.ts`:** Resolve each role via `resolveRoleModel(manifest, role, "copilot-vscode", modelIndex)`. Unless `resolved.omit`, set `fmObj.model = resolved.frontmatterModel` and (when set) `fmObj["model-policy"] = resolved.copilotPolicy`. Extend `buildCopilotHandoffs` in `capabilities.ts` with optional `{ includeModels, resolvedByRoleId }` controlled by `workflow.modelRouting?.copilotHandoffModels`.
- **`global-install.ts`:** Global `team-setup` emits `model: "inherit"` for Antigravity/Claude Code and omits `model` for global Copilot prompt so global onboarding yields to whatever model the user selected.
- **`shared.ts`:** Update `renderSharedTeamRules(manifest, modelIndex?)` to append a concise **`## Model Routing & Host Compatibility`** section containing active policy, host-deferral rule (`/swarm`, Copilot Fusion/Auto, `CLAUDE_CODE_SUBAGENT_MODEL`), and a compact per-role resolved table (`role | tier | antigravity | claude-code | copilot-vscode`).
- **`index.ts`:** `planCompiledFiles` / `compileTeam` load deterministic workspace Model Index (`Layer 0 + Layer 2`, or `Layer 0 + Layer 1 + Layer 2` only when `options?.useGlobalIndex === true`) and pass it into all 3 IDE compilers and `renderSharedTeamRules`.

### 4.2 Telemetry Definitions (`src/telemetry/definitions.ts`)
- **Critical Array-Model Fix:** Line 509 currently drops array `meta.model` (`typeof meta.model === "string"`). Update parsing so:
  - `model`: if `string`, trimmed string; if `string[]`, `meta.model[0] ?? ""` (keeps `src/telemetry/normalizer.ts` `prettifyModelName(def.model)` working cleanly).
  - `modelFallbacks?: string[]`: full array when `meta.model` is an array.
  - `modelPolicy?: string`: parsed from `meta["model-policy"]`.
- **Additive `TeamDetails` Enrichment (served by both `GET /api/team` and MCP `app_get_team`):**
  - `modelRouting?: ResolvedWorkflowRoutingSummary` (policy, `respectBuiltInOrchestrators`, `allowSubagentModelHints`, `copilotHandoffModels`, `idePolicies`)
  - `roster[i]`: optional `modelTier`, `modelPolicy`, `models`, and `resolvedModels` per IDE (`{ model, fallback, copilotPolicy, omitted, tier, policy, source }`)
  - `modelIndexSummary?: { updatedAt, updatedBy, hasGlobalOverlay, hasWorkspaceOverlay, globalLastSyncedAt? }`

### 4.3 Doctor Checks (`src/cli/commands/doctor.ts`)
Add `modelIndex: ModelIndexHealthInfo` to `DoctorReport`:
- `valid: boolean`, `policy: ModelRoutingPolicy`, `layers: { globalPath, globalExists, workspacePath, workspaceExists }`, `warnings: string[]`, `errors: string[]`.
- Validation checks:
  1. Malformed JSON or schema error in `~/.agent-studio/model-index.json` or `.agent-team/model-index.json` -> `errors` (sets `doctor.ok = false`).
  2. `copilot-vscode` enabled with `policy: "pinned"` or `model-policy: required` -> warning: *"Copilot `model-policy: required` bypasses Copilot Fusion / Auto overrides."*
  3. `copilot-vscode` enabled & installed, `global` catalog has 0 `vscode-lm` entries or `lastSyncedAt` older than 30 days -> info/warning: *"Run VS Code command 'Agent Studio: Refresh Live Model Index' to sync live Copilot models."*
  4. Role override references a Copilot picker string whose live `vscode-lm` entry has `available === false` -> warning.

### 4.4 Templates, Skills & Repo `.agent-team/` Dogfooding
- `src/templates/manifest.ts`: `buildDefaultTeamManifest` populates `workflow.modelRouting` (`prefer-fallback`) and research-backed `modelTier` per default role; `scaffoldAgentTeam` writes `.agent-team/model-index.json` via `writeIfAllowed`.
- `src/templates/skills.ts`: Add **`skills/model-routing/SKILL.md`** documenting overlay paths, schema fields, `agent-studio models` commands, and host deferral rules; mention model routing in `skills/team-setup/SKILL.md`.
- `src/templates/prompts.ts`: Update `renderOrchestratorPrompt` (host-deferral rule + per-role tier table) and `renderTeamSetupPrompt` (confirm model policy / tiers during onboarding).
- **Repo `.agent-team/`:** Update `.agent-team/team.yaml`, add `.agent-team/model-index.json` and `.agent-team/skills/model-routing/SKILL.md`, update `.agent-team/agents/orchestrator.md` & `team-setup.md`, and run `npx agent-studio sync` (plus bump lockstep SemVer `0.4.0 -> 0.5.0` across `package.json`, `extension/package.json`, `web/package.json`, and `web/src/mcp-app-entry.ts` client info).

---

## 5. CLI + REST API + VS Code Extension Live-Catalog Sync Contract

### 5.1 CLI (`src/cli/commands/models.ts` via `agent-studio models <op>` / alias `model-index`)

| Subcommand | Flags & Arguments | Behavior |
| :--- | :--- | :--- |
| `show` | `[--project <id\|dir>] [--ide <ide>] [--layer effective\|global\|workspace\|built-in] [--json]` | Prints effective/layer Model Index, role recommendations, and per-IDE resolved models. |
| `set-tier` | `<ide> <fast\|balanced\|reasoning> <primary> [--fallback a,b,c] [--omit-on-defer] [--scope workspace\|global] [--project <id\|dir>] [--sync] [--json]` | Updates tier binding atomically in target overlay; optionally runs `compileTeam()`. |
| `set-role` | `<roleId> [--tier <tier>] [--policy <policy>] [--ide <ide> --model <id\|a,b\|omit>] [--project <id\|dir>] [--sync] [--json]` | Updates `roster[roleId]` in `.agent-team/team.yaml` atomically; optionally syncs IDEs. |
| `set-policy` | `<defer-to-host\|prefer-fallback\|pinned> [--ide <ide>] [--respect-host true\|false] [--handoff-models true\|false] [--project <id\|dir>] [--sync] [--json]` | Updates `workflow.modelRouting` in `.agent-team/team.yaml`. |
| `upsert` | `--ide <ide> --id <modelId> [--label <name>] [--vendor <v>] [--family <f>] [--tier <tier>] [--capabilities a,b] [--available true\|false] [--scope global\|workspace] [--project <id\|dir>] [--json]` | Upserts a `ModelCatalogEntry` in the target overlay. |
| `discover` | `--ide <ide> [--stdin \| --file <path>] [--scope global\|workspace] [--project <id\|dir>] [--json]` | Ingests a JSON array of discovered models (used by VS Code extension offline fallback or scripts). |
| `adopt` | `[--ide <ide>] [--tier <tier>] [--project <id\|dir>] [--sync] [--json]` | Copies discovered catalog/tier updates from Layer 1 (`global`) into Layer 2 (`.agent-team/model-index.json`) for deterministic Git tracking. |
| `reset` | `[--scope global\|workspace] [--project <id\|dir>] [--sync] [--json]` | Resets global overlay or workspace `.agent-team/model-index.json` back to built-in seed. |

Also add `--use-global-index` flag on `agent-studio sync` (explicit opt-in; never enabled by default).

### 5.2 REST API (`src/server/http-server.ts`)

1. **`GET /api/model-index?project=<id>&workspace=<root>&ide=<ide>`**
   - Returns `{ ok: true, projectId, projectRoot, effective, layers: { globalPath, globalExists, globalUpdatedAt, workspacePath, workspaceExists, workspaceUpdatedAt, globalDiffersFromWorkspace }, routing: { policy, respectBuiltInOrchestrators, allowSubagentModelHints, copilotHandoffModels, idePolicies, resolvedRoles } }`.
   - When `?ide=<ide>` is passed, `effective.ides` and `routing.resolvedRoles[*].resolved` may filter to that IDE (frontend also enforces `embedScope.lockedIde`).
2. **`PUT /api/model-index` & `PATCH /api/model-index`**
   - Request JSON: `{ scope?: "workspace" | "global", project?: string, workspace?: string, sync?: boolean, create?: boolean, patch: ModelIndexOverlay }`.
   - Validates `patch`, writes atomically under file lock, runs `compileTeam()` if `scope === "workspace"` and `sync !== false` and `team.yaml` exists, clears `clearTeamDetailsCache()`, returns `200 { ok: true, effective, layers, routing, compileResult? }`.
   - Errors: `400` on invalid JSON/Zod error, `404` when `scope === "workspace"` and project root has no `.agent-team/` (`create !== true`).
3. **`POST /api/model-index/discover`**
   - Request JSON: `{ ide: IdeTarget, source?: "vscode-lm" | "manual", scope?: "global" | "workspace", project?: string, models: Array<{ id: string, label?: string, vendor?: string, family?: string, maxInputTokens?: number, tierHint?: ModelTier, capabilities?: ModelCapabilityTag[] }> }`.
   - Normalizes & infers tier when `tierHint` omitted (`inferModelTier(id, family, maxInputTokens)`), upserts entries with `available: true`, marks stale `source === "vscode-lm"` entries for that `ide` not present in `models` as `available: false`, writes atomically (default `scope: "global"`), returns `200 { ok: true, count, added, updated, effective }`.
4. **`PATCH /api/team/routing`**
   - Request JSON: `{ project?: string, workspace?: string, sync?: boolean, workflow?: Partial<WorkflowModelRouting>, role?: { id: string, modelTier?: ModelTier | null, modelPolicy?: ModelRoutingPolicy | null, models?: Record<string, IdeModelOverride | null> } }`.
   - Updates `.agent-team/team.yaml` atomically (`null` clears optional overrides back to default), runs `compileTeam()` if `sync !== false`, clears `clearTeamDetailsCache()`, returns `200 { ok: true, routing, compileResult? }`.

### 5.3 VS Code Extension Live-Catalog Sync (`extension/src/modelSync.ts`)
- **Feature Detection:** Guard `vscode.lm?.selectChatModels` and `vscode.lm?.onDidChangeChatModels` at runtime (`typeof selectFn === "function"`) so older VS Code or Antigravity hosts never throw.
- **Host Scoping:**
  - Read `hostIde = serverManager.detectHostIde()`.
  - When `hostIde === "copilot-vscode"`, map each `LanguageModelChat` to `{ id: formatPickerLabel(m.name, m.vendor), label: m.name, vendor: m.vendor, family: m.family, maxInputTokens: m.maxInputTokens }` (avoiding duplicate `(vendor)` suffix if `m.name` already includes `(${m.vendor})`).
  - When `hostIde === "antigravity"`, only emit under `ide: "antigravity"` if `selectChatModels` exposes models; never inject Copilot picker strings into Antigravity.
- **Transport:**
  1. Ensure server is running (`ensureRunning(false)`), then `POST /api/model-index/discover` (`scope: "global"`).
  2. If server is offline during manual command, pipe JSON into `serverManager.runCli(["models", "discover", "--ide", hostIde, "--scope", "global", "--stdin", "--json"])`.
- **Lifecycle & Commands:**
  - Sync once non-blocking after startup probe succeeds; subscribe to `vscode.lm.onDidChangeChatModels` with a `2000ms` debounce.
  - Register command `agentStudio.refreshModelIndex` (`"Refresh Live Model Index"`) in `extension/package.json` & `extension/src/extension.ts`.

---

## 6. Web Studio UI Contract (`embed=1` Scoping & Galaxy Z Fold 7 Responsive Design)

### 6.1 Information Architecture & Controls (`web/src/views/Team.ts` + `web/src/views/Doctor.ts`)
Integrate into **`TeamView`** (avoiding a 6th desktop tab or crowding the 6-item cover bottom nav):
1. **Model Routing Policy Bar** (below Workflow/Checkpoints, above Canonical Roster):
   - Host Policy `<select>` (`prefer-fallback`, `defer-to-host`, `pinned`) + toggle `"Respect Built-in Orchestrators (/swarm · Fusion)"` + `"Sync IDEs on Save"` toggle.
   - Index source badge (`Built-in` / `Global Overlay` / `Workspace .agent-team/model-index.json`) + `"Inspect & Edit Model Index"` button + `"Adopt Global Catalog"` button (visible only when `layers.globalDiffersFromWorkspace` is true).
2. **Per-Role Model Controls on `.roster-card`:**
   - Tier badge (`Fast` / `Balanced` / `Reasoning`) + Tier `<select>` (`Index Default` / `Fast` / `Balanced` / `Reasoning`) + Role Policy `<select>` (`Inherit` / `Prefer Fallback` / `Defer to Host` / `Pinned`).
   - Resolved model pill strip:
     - **Standalone (`!embedScope.lockedIde`):** compact badges per enabled IDE (`AGY`, `CC`, `VSC`).
     - **Embedded (`embed=1` + `lockedIde`):** show **ONLY** `lockedIde`'s resolved model/policy pill (`Omitted — Copilot Fusion/Auto` when deferred).
   - `"Customize Model…"` button opening role override modal (or section inside `team-detail-dialog`).
3. **Model Index Inspector / Editor Dialog (`<dialog class="model-index-dialog" closedby="any">` + Safari light-dismiss fallback):**
   - **IDE Tabs:** Standalone shows `Antigravity` | `Claude Code` | `VS Code Copilot` | `Role Tier Defaults`; **Embedded (`embed=1`) hides all non-host IDE tabs**.
   - **Tier Bindings Editor:** Primary model `<select>` / combo + ordered fallback chip list (move up/down, remove, add from catalog) + target scope toggle (`Workspace` vs `Global`).
   - **Catalog List + Add Form:** Displays `label`, `id`, `tier`, `capabilities`, `source` (`built-in`/`vscode-lm`/`agent`/`user`), `available` status dot, plus inline `"Add Model"` form (`id`, `label`, `tier`, `vendor`).
   - **MCP App Mode (`isMcpAppTransportActive()`):** Renders read-only inspection with one-click copyable CLI commands (`npx agent-studio models ...`) instead of disabled/broken HTTP mutation forms.
4. **`DoctorView` Integration:**
   - Render `model-index` health check item returned by `fetchDoctor()` cleanly; in `embed=1`, filter any IDE-specific model warnings to `lockedIde` only.

### 6.2 Galaxy Z Fold 7 Three-Tier Responsive & WCAG AA Contract
- **Tier 1 — Cover / Compact (`< 640px`, ~360–412px):**
  - Policy bar controls stack vertically (`flex-direction: column`); IDE/source filter chips scroll horizontally (`overflow-x: auto`).
  - `model-index-dialog` renders as a **bottom sheet** (`max-height: 88dvh`, `margin-top: auto`, top drag handle, `padding-bottom: max(14px, env(safe-area-inset-bottom))`).
  - Catalog tables become stacked mobile cards or scroll inside `role="region" tabindex="0"` containers (`overflow-x: auto`).
  - `@media (pointer: coarse)`: every `<select>`, `<button>`, tab, and reorder control has `min-height: 44px; min-width: 44px`.
- **Tier 2 — Open / Unfolded (`640px – 1020px`, ~700–840px):**
  - Preserve **2-column `1fr 1fr` split** for `.team-roster-grid`, `.model-tiers-grid`, and `.model-catalog-grid` inside `100dvh`.
  - Honor `@media (horizontal-viewport-segments: 2)` with `env(viewport-segment-width ...)` and hinge gap `max(12px, calc(env(viewport-segment-left 1 0) - env(viewport-segment-right 0 0)))`.
- **Tier 3 — Desktop (`>= 1021px`):**
  - Multi-column studio layout (`repeat(3, minmax(0, 1fr))` roster/tier grids), inline policy toolbar, centered modal dialog (`max-width: min(880px, 92vw)`).
- **Accessibility & States:**
  - `role="status"` / `aria-live="polite"` feedback banner on save/sync (`"Saved & synced 24 IDE files"` or actionable error + `"Retry"`), `aria-busy="true"` while saving, `:focus-visible` outlines, WCAG AA `>= 4.5:1` contrast, `@media (forced-colors: active)`, and `@media (prefers-reduced-motion: reduce)`.

---

## 7. Non-Overlapping Write Scopes & Verification Criteria

### 7.1 Exclusive File Ownership

| Story | Owner(s) | Exclusive Write Scope | Must NOT Edit |
| :--- | :--- | :--- | :--- |
| **S1-42** | `backend-engineer` | `src/schema/{model-index,team,index}.ts`, `src/models/{index,store,resolver}.ts`, `src/index.ts`, `src/compiler/{antigravity,claude-code,copilot-vscode,capabilities,shared,global-install,index}.ts`, `src/templates/{manifest,prompts,skills}.ts`, `src/telemetry/definitions.ts`, `src/cli/{index,commands/{models,doctor,init,sync}}.ts`, `src/server/http-server.ts`, `extension/src/{modelSync,extension,serverManager}.ts`, `extension/package.json`, `.agent-team/**` + synced IDE outputs, `docs/{IDE_INTEGRATION,SETUP_AGENT}.md`, `tests/unit/{model-routing,schema,compiler,server,extension}.test.ts`, lockstep version bump `0.5.0` in `package.json`, `extension/package.json`, `web/package.json` | `web/src/**` (except version bump in `web/package.json` — or leave `web/src/mcp-app-entry.ts` version to S1-43 / final sync) |
| **S1-43** | `frontend-engineer` + `ux-designer` | `web/src/types.ts`, `web/src/api.ts`, `web/src/views/{Team,Doctor}.ts`, `web/src/components/ModelIndexDialog.ts` (new, optional), `web/src/styles/{views,responsive}.css`, `web/src/mcp-app-entry.ts` (`version: "0.5.0"`), UX review notes | `src/**`, `extension/**`, `.agent-team/**`, `package.json`, `extension/package.json`, `web/package.json` |

> **Packaging & Sequencing Rule:** `S1-42` and `S1-43` can implement concurrently against the REST/JSON contracts in Section 5.2 and Section 6. After both land, run the final lockstep packaging build (`npm run build:all && npm run build:plugin && npm --prefix extension run package`) so `extension/dist/web/`, `antigravity-plugin/dist/bin/app.html`, and `extension/agent-studio-0.5.0.vsix` include both backend CLI/server and frontend UI before `qa-validator` closes `test -> done`.

### 7.2 Concrete Verification Criteria (QA Checkpoints)

- **CP0 (`npm run check && npm test`):**
  1. `ModelIndexSchema` + `TeamManifestSchema` round-trip old manifests without model fields identically (`schema.test.ts`).
  2. Compiler unit tests verify all 3 policies (`defer-to-host`, `prefer-fallback`, `pinned`) across Antigravity, Claude Code, and Copilot (including Copilot `model: [...]` + `model-policy: preferred`, omitted `model` on `defer-to-host`, `handoffs[].model` off by default, and idempotent `sync --check` even when Layer 1 global overlay differs).
  3. Store lock + atomic write tests on `model-index.json` and `team.yaml`.
  4. CLI `models show|set-tier|set-role|set-policy|upsert|discover|adopt|reset` + `doctor --json` model-index checks.
  5. HTTP server tests for `GET /api/model-index`, `PUT /api/model-index`, `POST /api/model-index/discover` (tier inference + stale `vscode-lm` `available: false`), `PATCH /api/team/routing`, and `GET /api/team` array-model parsing.
  6. Extension unit checks: `scoping.ts`, `modelSync.ts` feature-detection/picker formatting (`"Name (vendor)"` deduplication), lockstep SemVer `0.5.0`, and matching `extension/agent-studio-0.5.0.vsix`.
- **CP1 (`npm --prefix web run check && npm --prefix web run build`):**
  1. Zero TypeScript errors across `web/src/**` and clean Vite + MCP App single-file build (`dist/web/` + `dist/mcp-app/`).
  2. Browser/UX verification at **390×844** (Z Fold 7 cover), **768×880** (Z Fold 7 unfolded + viewport segments), and **1440×900** (desktop) confirming zero overflow/clipping, `44px` coarse touch targets, `embed=1` strict host-IDE scoping, `mcpAppMode` read-only fallback, and WCAG AA contrast.
- **CP2 (`python tests/smoke_test.py`):**
  - Legacy Python visualizer smoke suite exits `0`.
