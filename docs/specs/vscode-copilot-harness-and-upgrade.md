# Spec: VS Code Copilot Agent-Customization Harness & Safe Upgrade Architecture (`S1-68`)

## 1. Goal & Non-Goals

### Goal
Conform Agent Studio's `copilot-vscode` compiler, hooks, global installation, model index, passive/push telemetry, Doctor diagnostics, Extension, and Web Studio to the unified VS Code Copilot agent-customization harness (`https://code.visualstudio.com/docs/agent-customization/migrate-customizations`), while introducing a general, durable, customization-preserving `agent-studio upgrade` + safe `agent-studio sync` workflow for this and all future releases.

### Non-Goals
- Do **not** alter `antigravity` or `claude-code` runtime invariants (read-only orchestrator, Antigravity `buildPortableMcpSpec()` in `mcp_config.json`, Claude `PreToolUse` exit `0` + `hookSpecificOutput`, non-monotonic context tracking, `embed=1` scoping).
- Do **not** overwrite user-customized Markdown (`.agent-team/*.md` or compiled IDE files) during `sync` or `upgrade` unless `--force` is explicitly passed.
- Do **not** drop support for legacy Local Copilot environments; provide explicit `workflow.copilotHarness: "legacy-local"` opt-in and dual-format parsing in `hook-emit.ts`.

---

## 2. Contracts & Schemas

### 2.1 Team Manifest Schema (`src/schema/team.ts`)
Add harness selection and per-role invocation visibility controls while remaining backwards compatible via optional defaults:

```ts
export const CopilotHarnessSchema = z.enum(["copilot", "legacy-local"]);
export type CopilotHarness = z.infer<typeof CopilotHarnessSchema>;
```

- **`WorkflowConfigSchema`**: add `copilotHarness: CopilotHarnessSchema.optional()`.
  - Helper `resolveCopilotHarness(manifest?: TeamManifest | null): CopilotHarness` returns `manifest?.workflow.copilotHarness ?? "copilot"`.
- **`RosterEntrySchema`**: add:
  - `userInvocable: z.boolean().optional()`
  - `disableModelInvocation: z.boolean().optional()`
  - Default emission rules in `"copilot"` harness mode:
    - `user-invocable`: `role.userInvocable ?? (role.roleType === "orchestrator" || role.roleType === "setup")` (`true` for `orchestrator` and `team-setup`; `false` for specialists and `qa`).
    - `disable-model-invocation`: `role.disableModelInvocation ?? false`.

### 2.2 Provenance State Schema (`.agent-team/.upgrade-state.json` — `src/schema/upgrade-state.ts`)
Deterministic, Git-committed provenance file tracking stock template baselines **without machine-local absolute paths or volatile timestamps**:

```ts
export const ManagedFileRecordSchema = z.object({
  stockHash: z.string().regex(/^[0-9a-f]{64}$/),
  customized: z.boolean(),
  localHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  templateVersion: z.string().min(1),
});

export const UpgradeStateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  agentStudioVersion: z.string().min(1),
  files: z.record(z.string(), ManagedFileRecordSchema).default({}), // POSIX paths relative to .agent-team/
});
```

- Key order in `files` MUST be lexicographically sorted before serialization (`writeJsonAtomic`) so repeated `upgrade` runs produce 0-byte diffs when nothing changes.
- `scaffoldAgentTeam()` (`src/templates/manifest.ts`) initializes `.agent-team/.upgrade-state.json` on `agent-studio init` (setting `customized: false` for newly created stock `.md` files and `customized: localHash !== stockHash` if preserving pre-existing `.md` files without `--force`).

### 2.3 Compiler Contracts (`src/compiler/`)

#### A. Tool Aliases (`src/compiler/capabilities.ts`)
Update `mapCapabilitiesToCopilotVsCode(capabilities: Capability[], options?: { harness?: CopilotHarness })`:
- **`"copilot"` (default):**
  - `"read"` → `"read"`
  - `"search"` → `"search"`
  - `"edit"` | `"write_docs"` | `"edit_tests"` → `"edit"`
  - `"shell"` → `"execute"`
  - `"delegate"` → `"agent"`
  - `"ask_user"` → omitted (native runtime `ask_user`)
  - `"mcp_board"` → `"agent-studio/*"`
  - `"mcp_testrun"` → `"agent-studio/testrun"`
- **`"legacy-local"`:** retains `read/readFile`, `search/codebase`, `search/textSearch`, `search/fileSearch`, `edit/editFiles`, `edit/createFile`, `execute/runInTerminal`, `agent/runSubagent`, `agent-studio/*`, `agent-studio/testrun`.
- `resolveEffectiveCapabilities` continues stripping `edit`, `write_docs`, `edit_tests`, `shell` for `orchestrator` under `orchestratorReadOnly: true`, guaranteeing `orchestrator.agent.md` never receives `"edit"` or `"execute"`.

#### B. Agent, Skill, Prompt, Hook & MCP Compilation (`src/compiler/copilot-vscode.ts`, `claude-code.ts`)
When `harness === "copilot"`:
1. **`.github/agents/<role>.agent.md`**:
   - Frontmatter emits `name`, `description`, `model` / `model-policy` (resolved via runtime IDs + legacy alias mapper), `tools`, `user-invocable`, `disable-model-invocation`.
   - **Omit `handoffs:`** completely (while preserving `team.yaml` `handoffs` for Antigravity, Web UI, and `"legacy-local"`).
2. **`.github/prompts/learn.prompt.md`**:
   - **Do NOT emit.** Rely on `.github/skills/learn/SKILL.md` with `disable-model-invocation: true` (and `argument-hint: "[optional focus]"`) for manual `/learn` slash invocation across Copilot and Claude Code.
3. **`.mcp.json` (shared across `claude-code` & `copilot-vscode`):**
   - `compileCopilotVsCode` emits `kind: "json-merge"` for `relPath: ".mcp.json"` with:
     ```json
     {
       "mcpServers": {
         "agent-studio": {
           "type": "stdio",
           "command": "node",
           "args": ["-e", "..."],
           "tools": ["*"]
         }
       }
     }
     ```
     (`tools: ["*"]` is required by Copilot's `.mcp.json` schema; empirical `claude mcp list`/`get` verification confirms Claude Code accepts both `"type": "stdio"` and `"tools": ["*"]`).
   - `compileClaudeCode` emits `kind: "json-merge"` for `relPath: ".mcp.json"` with `"type": "stdio"` + `buildPortableMcpSpec()` (and when `manifest.targets.includes("copilot-vscode")` with `harness === "copilot"`, preserves/includes `"tools": ["*"]` so filtered `sync --ides claude-code` does not introduce drift against `copilot-vscode`).
   - `compileAntigravity` keeps `buildPortableMcpSpec()` unchanged in `mcp_config.json`.
4. **`.github/hooks/agent-studio.json`**:
   - Canonical camelCase hook array (`COPILOT_HOOK_EVENTS_CANONICAL`):
     `["sessionStart", "userPromptSubmitted", "preCompact", "preToolUse", "postToolUse", "postToolUseFailure", "subagentStart", "subagentStop", "agentStop", "sessionEnd"]` (10 events).
   - Compiled as **`kind: "json-merge"`** (not `kind: "generated"`) using `{ version: 1, hooks: { ... } }` with `timeoutSec: 5` and **no `"managedBy"` key** in `"copilot"` mode.
   - Patch includes `pruneManagedHookEvents: LEGACY_COPILOT_HOOK_EVENTS` and `removeTopLevelIfEqual: { managedBy: "agent-studio" }` so old PascalCase Agent Studio hook entries (`HOOK_TAG_NEEDLE`) are cleanly migrated without touching user-authored hooks in `.github/hooks/agent-studio.json`.
- When `harness === "legacy-local"`: emits legacy `.vscode/mcp.json` (`servers["agent-studio"]`), `handoffs:`, `.github/prompts/learn.prompt.md`, and PascalCase `LEGACY_COPILOT_HOOK_EVENTS` (keeping `kind: "json-merge"` non-destructive hooks).

#### C. Identical-Path Coalescing & Safe Sync (`src/compiler/merge.ts`, `src/compiler/index.ts`, `src/cli/commands/sync.ts`)
1. **`coalesceExpectedFiles(files: ExpectedFile[])`** in `planCompiledFiles()`:
   - Merges `ExpectedFile` entries of `kind === "json-merge"` that share the same normalized `relPath` (e.g., `.mcp.json` from `claude-code` + `copilot-vscode`) by deep-merging nested plain objects in `mcpServers[key]`, `servers[key]`, `scopedEntries[top][sub]`, `topLevelDefaults`, `removeTopLevelIfEqual`, and `hooks` arrays.
   - Retains `contributors?: IdeTarget[]` on `ExpectedFile` so `computeDrift()` checks the coalesced file once with zero false drift and reports drift against the contributing IDE(s).
2. **`JsonMergePatch` Extensions (`src/compiler/merge.ts`)**:
   - `topLevelDefaults?: Record<string, unknown>`: sets top-level key if absent (e.g., `version: 1` in `.github/hooks/agent-studio.json`).
   - `removeTopLevelIfEqual?: Record<string, unknown>`: deletes top-level key only when its current value equals the specified sentinel (e.g., `{ managedBy: "agent-studio" }`).
   - `pruneManagedHookEvents?: readonly string[]`: removes entries matching `isManagedHookEntry(entry)` from listed legacy hook event arrays; deletes the event key only if the filtered array becomes empty (preserving any user-authored hooks under that event key).
3. **Safe `compileTeam(projectRoot, options?)` (`force?: boolean`, `cleanLegacy?: boolean`):**
   - For `kind === "generated"`: if target exists and `existingRaw !== nextContent`, when `!options?.force`:
     - On Markdown files (`.md`): verify `extractGeneratedHash(existingRaw) !== null && verifyGeneratedMarkdownHash(existingRaw)`. If false (tampered or unmarked non-Agent-Studio file), **skip overwrite**, preserve disk content, and push `{ path, ide, reason }` to `CompileResult.skippedModified` + human warning to `CompileResult.warnings`.
     - On JSON `generated` files (e.g. `plugin.json`): if unparseable JSON and `!force`, skip + warn in `skippedModified`.
   - For `kind === "managed-markdown"` (`CLAUDE.md`, `.github/copilot-instructions.md`): if `actualBlock !== null` and `!verifyGeneratedMarkdownHash(actualBlock)` and `!force`, **skip overwrite** and record in `skippedModified` (content outside `<!-- agent-studio:begin/end -->` is always preserved).
   - For `kind === "json-merge"`: always performs non-destructive key-scoped merge (never skipped unless malformed JSON).
   - **Surgical Legacy Artifact Cleanup** (runs when `targets.includes("copilot-vscode")` and `harness === "copilot"` and `options?.cleanLegacy !== false`):
     - `.vscode/mcp.json`: if valid JSON object with `servers["agent-studio"]`, remove ONLY `servers["agent-studio"]`; remove `servers` if empty; unlink `.vscode/mcp.json` ONLY if root JSON object is `{}`. Never remove user MCP servers or `inputs`. Record action in `CompileResult.cleanedLegacy`.
     - `.github/prompts/learn.prompt.md`: unlink ONLY if `extractGeneratedHash(raw) !== null && verifyGeneratedMarkdownHash(raw) === true`. Otherwise preserve untouched and emit warning in `CompileResult.warnings`.
   - **`agent-studio sync [--force]` (`src/cli/commands/sync.ts`)**:
     - Parses `--force` and forwards to `compileTeam`.
     - Prints `skippedModified` warnings to stderr (non-JSON mode) and includes `skippedModified`, `cleanedLegacy`, `warnings` in JSON output. Exit code `0` on sync (unless `--check` detects drift, which exits `1`).

#### D. Global Install (`src/compiler/global-install.ts`)
- Add `resolveCopilotHomeDir(homeDir: string, explicitCopilotHome?: string): string`: checks explicit option → `process.env.COPILOT_HOME?.trim()` → `path.join(homeDir, ".copilot")`.
- For `targets.includes("copilot-vscode")` in `"copilot"` mode:
  - Write `$COPILOT_HOME/agents/team-setup.agent.md` (`tools: ["read", "search", "edit", "execute"]`, `user-invocable: true`, `disable-model-invocation: false`).
  - Write `$COPILOT_HOME/instructions/team-setup.instructions.md` (`name: "team-setup"`, `description: ...`).
  - Write `$COPILOT_HOME/skills/team-setup/SKILL.md` and `$COPILOT_HOME/skills/learn/SKILL.md` (`disable-model-invocation: true`).
  - Surgically clean legacy `<VSCodeUserDir>/prompts/{team-setup.agent.md, team-setup.instructions.md, learn.prompt.md}` ONLY when `extractGeneratedHash` + `verifyGeneratedMarkdownHash` proves unmodified Agent Studio ownership; otherwise preserve and record in `GlobalInstallResult.warnings`.

### 2.4 Runtime Model IDs & Legacy Alias Mapper (`src/schema/model-index.ts`, `src/models/`, `extension/src/modelSync.ts`)
1. **Default Catalog & Tiers (`src/schema/model-index.ts`)**:
   - Replace `"Name (copilot)"` IDs in `DEFAULT_MODEL_INDEX.ides["copilot-vscode"]` with runtime model IDs (`claude-sonnet-4.6`, `claude-opus-4.6`, `gpt-5.4`, `gemini-3.1-pro`, `mai-code-2`, `claude-sonnet-4.5`, `gemini-3-flash`, `mai-code-2-flash`, `gpt-5-mini`, `gpt-4.1`, `claude-haiku-4.5`, `gpt-4o-mini`, `claude-sonnet-4`, `gemini-2.5-pro`, `claude-opus-4.1`), keeping human `label`s unchanged.
2. **Live Extension Sync (`extension/src/modelSync.ts`)**:
   - In `mapLanguageModelsForHost("copilot-vscode", models)`, use native `rawId || rawName` (`m.id`) as `id` and `rawName || id` as `label`. Keep `formatPickerLabel` exported (marked `@deprecated`) only for helper compatibility until callers migrate.
3. **Deterministic Legacy Alias Mapper (`src/models/defaults.ts` + `src/models/resolve.ts`)**:
   - Export `LEGACY_COPILOT_MODEL_ALIASES: Readonly<Record<string, string>>` mapping all 16 built-in `"Name (copilot)"` labels → runtime IDs (plus case-insensitive normalized lookup against built-in `label + " (copilot)"` forms). **Never** rewrite unknown custom/BYOK model IDs.
   - Export `normalizeLegacyCopilotModelId(id: string): string` and `isLegacyCopilotPickerId(id: string): boolean`.
   - In `resolveRoleModel()`: when `ide === "copilot-vscode"` and `harness === "copilot"`, pass resolved `primaryModel`, `fallbackModels`, and `frontmatterModel` through `normalizeLegacyCopilotModelId()` so legacy pins compile immediately during `sync` even before `upgrade`.

### 2.5 `agent-studio upgrade` Command (`src/cli/commands/upgrade.ts`, `src/cli/index.ts`)
- **CLI Signature:**
  `agent-studio upgrade [--project <id|dir>] [--ides <list>] [--dry-run] [--diff] [--write-incoming] [--force] [--global] [--use-global-index] [--json] [--quiet]`
- **Execution Pipeline:**
  1. Resolve `projectRoot` and verify `.agent-team/team.yaml` exists.
  2. Detect repo stack (`detectRepoStack(projectRoot)`) and compute current stock templates (`agents/*.md` for built-in roles present in stock blueprint, `skills/*/SKILL.md` for `getDefaultSkills(detected)`).
  3. Load `.agent-team/.upgrade-state.json` (if present; `null` triggers **First-Time Bootstrap**).
  4. **Classify & Process Canonical `.agent-team/*.md`:**
     - *Missing built-in skill*: if `!prev` in upgrade state (new skill in this release) → create `.agent-team/skills/<id>/SKILL.md` + register `"skills/<id>"` in `team.yaml` `skills`; if `prev` exists (user deleted) → preserve deletion unless `--force`.
     - *Missing built-in role prompt*: if role exists in `manifest.roster`, create prompt file; otherwise skip.
     - *First-time bootstrap (`state === null || !prev`)*: if `localHash === stockNextHash`, record `{ stockHash: stockNextHash, customized: false, templateVersion }`; if `localHash !== stockNextHash`, treat as **presumed user-customized** (preserve untouched, record `{ stockHash: stockNextHash, customized: true, localHash, templateVersion }`; overwrite only if `--force`). Note: `skills/architecture-review/SKILL.md` without `PENDING DEEP RESEARCH` marker is always treated as user-customized.
     - *Tracked file (`prev` exists)*:
       - If `localHash === stockNextHash`: mark unchanged (`customized: false`).
       - Else if `!prev.customized && localHash === prev.stockHash`: **auto fast-forward** with new `stockContent` (`customized: false`, `stockHash: stockNextHash`).
       - Else (user modified): if `--force`, overwrite (`customized: false`, `stockHash: stockNextHash`); otherwise preserve untouched, mark `customized: true`, optionally print unified diff (`--diff`) or write `.incoming` sibling (`--write-incoming`).
  5. **Key-Scoped Merge Structured Configs:**
     - `.agent-team/team.yaml` (under `withTeamYamlLock`): merge missing defaults (`workflow.modelRouting`, `workflow.contextThresholds`), append newly added built-in `skills/<id>` entries, rewrite known `LEGACY_COPILOT_MODEL_ALIASES` inside `roster[].models["copilot-vscode"]` while preserving custom/BYOK IDs. Write ONLY if serialized AST/content changed.
     - `.agent-team/model-index.json` (under `withFileLock`): rewrite known `LEGACY_COPILOT_MODEL_ALIASES` in `ides["copilot-vscode"].tiers` & `catalog[]` (deduplicating colliding runtime IDs cleanly, preferring non-`built-in` entries), add missing `roleRecommendations` & new `DEFAULT_MODEL_INDEX` catalog entries without overwriting user/live entries or `available: false` flags. Preserve all custom/BYOK models untouched.
     - If `--global`: run `installGlobalSetupAgent` (with `$COPILOT_HOME` + legacy cleanup) and migrate known `LEGACY_COPILOT_MODEL_ALIASES` in `~/.agent-studio/model-index.json`.
  6. Persist `.agent-team/.upgrade-state.json` atomically (`writeJsonAtomic` + `withFileLock`) only if state changed (and skip all writes under `--dry-run`).
  7. Run safe `compileTeam(projectRoot, { force, cleanLegacy: true, ides, useGlobalIndex })` (skipped in `--dry-run`, simulated via `planCompiledFiles` + `computeDrift` instead) and `buildDoctorReport(projectRoot)`.

### 2.6 Hook-Emit, Tool Classification, Subagent Correlation & Passive Discovery
1. **`src/cli/commands/hook-emit.ts` (`P0-1`, `P0-2`, `P0-3`, `P1-9`)**:
   - **Event normalization (`normalizeHookEventName`)**: accept canonical camelCase (`sessionStart`, `sessionEnd`, `userPromptSubmitted`, `userPromptTransformed`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `preCompact`, `subagentStart`, `subagentStop`, `agentStop`, `permissionRequest`, `notification`, `errorOccurred`) AND PascalCase aliases (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `SubagentStart`, `SubagentStop`, `Stop`).
   - **Stdout response formatting**:
     - `isNewCopilotFormat = ide === "copilot-vscode" && /^[a-z]/.test(rawHookEvent)`:
       - `preToolUse` deny: `{ permissionDecision: "deny", permissionDecisionReason: denyReason }` on stdout + stderr guardrail message + **`exitCode: 0`**.
       - Advisory (`sessionStart`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `notification`): `{ additionalContext: advisory.message }` on stdout.
       - Suppress stdout completely for `preCompact`, `userPromptSubmitted`, `userPromptTransformed`, `sessionEnd`, `errorOccurred`, `permissionRequest` (and non-denied `preToolUse` / normal `agentStop` / `subagentStop`).
     - `claude-code` & legacy PascalCase `copilot-vscode`: retain `{ hookSpecificOutput: { hookEventName, ... } }` (`exitCode: 0` for `claude-code`, `exitCode: 2` for PascalCase `copilot-vscode` `PreToolUse` deny).
   - **Tools**: add `"create"`, `"str_replace"`, `"str_replace_editor"` (guarding `str_replace_editor` as edit unless `toolInput.command === "view"`) to `EDIT_OR_WRITE_TOOLS` (check `file_path`, `filePath`, `path`, `Path`, `target`, `target_file`, `targetFile`); add `"ask_user"` to `QUESTION_TOOLS`; ensure `"task"` triggers `subagent_spawn`/`subagent_done`.
   - **Stop/Subagent payloads**: extract `response` / `last_assistant_message` / `lastAssistantMessage` on `subagentStop` & `agentStop` into `payload.body` + `bodyLength`; preserve `agentName`/`agentDisplayName`/`agentType`/`agentId`.
2. **Telemetry Tool Classification & Correlation (`src/telemetry/`)**:
   - `types.ts`: add `"create"`, `"str_replace"`, `"str_replace_editor"` to `FS_TOOL_SET`; `"web_fetch"` to `WEB_TOOL_SET`; `"ask_user"` to `HUMAN_TOOL_SET`; support `choices` + `allow_freeform` in `normalizePendingQuestions`; update `summarizeToolCall` for `create`, `str_replace`, `str_replace_editor` (check `command === "view"`), `ask_user`, `web_fetch`, `task`.
   - `normalizer.ts`: add `"create"`, `"str_replace"`, `"str_replace_editor"` → `"fs_edit"` and `"web_fetch"` in `canonicalDedupToolName`; enhance `reconcileCopilotSubagents` so slug-only `subagentStart` + UUID `subagentStop` + passive `task`/`subagent.started` collapse to one canonical node.
   - `push-bus.ts`: correlate label-only `subagent_spawn` (`subagentStart` without `agentId`) to subsequent `subagent_done` (`subagentStop`) and child tool hooks carrying opaque `agentId` + matching `agentType`/`agentLabel` via per-session open-subagent label queue (`subagentToParent` memoization).
   - `adapters/copilot-vscode.ts` & `src/telemetry/index.ts`:
     - Add `"task"` to `isSubagentToolName` and `"ask_user"` to `isCopilotAskTool`.
     - Update `isTranscriptJsonlPath` to match both `/transcripts/.../*.jsonl` AND `/session-state/.../events.jsonl`.
     - Add workspace-scoped passive discovery of `$COPILOT_HOME/session-state/*/events.jsonl` (supporting `copilotHomeDir` option + `COPILOT_HOME` env, extracting workspace root from `workspace.yaml` `cwd:`/`git_root:` or `session.start` `data.context.cwd`/`cwd`, respecting `workspaceRoots` filter, deduping by `sessionId` across `workspaceStorage` and `session-state`). Add `resolveCopilotHomeDir()` to `getDefaultAllowedTranscriptRoots` & `TelemetryAggregator.getAllowedTranscriptRoots()`.
   - `definitions.ts`: scan `$COPILOT_HOME/agents/*.agent.md` when `includeGlobal: true`.

### 2.7 Doctor Diagnostics, Extension & Web Studio UI
- **`src/cli/commands/doctor.ts`**:
  - Verify `.mcp.json` (`mcpServers["agent-studio"]`) for `copilot-vscode` under `"copilot"` harness (or `.vscode/mcp.json` under `"legacy-local"`).
  - Verify `.github/hooks/agent-studio.json` against active harness `COPILOT_HOOK_EVENTS`.
  - Add `$COPILOT_HOME` to `detectInstalledIdes()` candidates and check global `$COPILOT_HOME` files in `DoctorReport`.
  - Add `migrationWarnings: string[]` to `DoctorReport` (flagging: stale `.vscode/mcp.json` `servers["agent-studio"]`, stale `.github/prompts/learn.prompt.md`, legacy PascalCase hook entries in `.github/hooks/agent-studio.json`, legacy global `<VSCodeUserDir>/prompts/*`, legacy `"(copilot)"` model IDs in workspace/global index or `team.yaml`, and `modified` compiled files requiring `--force`).
- **`extension/src/`**: `modelSync.ts` runtime IDs; `extension.ts` + `mcpProvider.ts` copy updates.
- **`web/src/`**:
  - `utils.ts` + `state/topologyGrouping.ts`: classify `create`, `str_replace`, `str_replace_editor`, `ask_user`, `task`, `view`, `bash`, `powershell`, `grep`, `glob`, `web_fetch`.
  - `components/IdeUsageGuides.ts`: update `copilot-vscode` guide (`.mcp.json`, camelCase hooks, `$COPILOT_HOME`, `agent` tool & `user-invocable`, `session-state/*/events.jsonl`, `agent-studio upgrade`).
  - `views/Doctor.ts`, `api.ts`, `types.ts`: surface `migrationWarnings` cleanly (filtered by `embed=1` `lockedIde`).
  - `views/Team.ts`, `components/ModelIndexDialog.ts`, `state/modelIndex.ts`: recognize `/.copilot/` in `getDefinitionScope()`, update example IDs (`claude-sonnet-4.6`) and `buildDefaultModelIndex()` Copilot IDs.

---

## 3. Edge Cases & Failure Modes

1. **Shared `.mcp.json` Partial Target Sync (`sync --ides claude-code`):**
   - If `team.yaml` enables both `claude-code` and `copilot-vscode` (`"copilot"` harness), running `agent-studio sync --ides claude-code` MUST NOT strip `"tools": ["*"]` from `.mcp.json` `mcpServers["agent-studio"]` (check `manifest.targets.includes("copilot-vscode")` when `harness === "copilot"`), preventing false drift in subsequent `doctor` checks.
2. **Mixed User + Agent Studio Hooks in `.github/hooks/agent-studio.json`:**
   - `mergeJsonKeyScoped` strips ONLY entries matching `isManagedHookEntry` (`HOOK_TAG_NEEDLE`) from `LEGACY_COPILOT_HOOK_EVENTS` and removes `managedBy` ONLY if equal to `"agent-studio"`. User hooks under either PascalCase or camelCase events remain untouched.
3. **Hook Stdout Ignored by Copilot on `preCompact` / `userPromptSubmitted`:**
   - Emit zero stdout on `preCompact` & `userPromptSubmitted` in camelCase Copilot mode while still pushing telemetry (`isPreCompact: true`) to `PushBus` so subsequent `postToolUse` / `subagentStart` hooks surface context advisories via `{ additionalContext }`.
4. **Windows Path Case & Atomic Locking:**
   - Use `withFileLock` + `writeJsonAtomic` (`renameWithRetry`) for `.agent-team/.upgrade-state.json`, `model-index.json`, and `withTeamYamlLock` for `team.yaml`; normalize all keys inside `.upgrade-state.json` to relative POSIX paths with LF-normalized SHA-256 hashes so Windows/macOS/Linux stay 100% deterministic.
5. **Custom/BYOK Model Preservation:**
   - `LEGACY_COPILOT_MODEL_ALIASES` only maps known built-in `"Name (copilot)"` IDs. Arbitrary custom or enterprise BYOK model IDs (even containing spaces or vendor tags) are preserved untouched across `resolveRoleModel`, `upgrade`, and `modelSync`.
6. **Subagent Label Collisions (`subagentStart` without `agentId`):**
   - Correlation queue in `PushBus` matches `(sessionId, normalizeSubagentLabel(agentType))` FIFO on open unlinked spawns, falling back cleanly when `agentId` arrives out of order.
7. **`session-state/*/events.jsonl` Workspace Isolation & Dedup:**
   - Sessions in `$COPILOT_HOME/session-state/` without a matching workspace (`workspace.yaml` / `session.start` cwd) are excluded when `workspaceRoots` scoping is active, and duplicate `sessionId`s across `workspaceStorage` and `session-state` merge into one `DiscoveredSession`.

---

## 4. Exclusive File Ownership & Task Split Plan

Execute via `board { op: "split", itemId: "S1-68" }` into 5 tightly scoped subtasks with zero write-scope overlap:

| Task | Role | Deps | Exclusive Write Scope | Summary |
| :--- | :--- | :--- | :--- | :--- |
| **S1-68-T1** | `backend-engineer` | — | `src/schema/team.ts`, `src/schema/model-index.ts`, `src/models/{defaults,resolve,store}.ts`, `src/compiler/{capabilities,copilot-vscode,claude-code,merge,index,global-install}.ts`, `src/cli/commands/sync.ts`, `src/templates/{skills,prompts}.ts`, `tests/unit/{compiler,model-routing}.test.ts` | Copilot harness schema & compiler (`.mcp.json` coalescing, camelCase `json-merge` hooks, omit `handoffs:`/`learn.prompt.md`, `user-invocable`, `$COPILOT_HOME` global install, runtime model IDs + legacy alias mapper, safe `sync [--force]` + surgical legacy cleanup). |
| **S1-68-T2** | `backend-engineer` | `S1-68-T1` | `src/schema/upgrade-state.ts`, `src/cli/commands/upgrade.ts`, `src/cli/index.ts`, `src/cli/commands/doctor.ts`, `src/templates/manifest.ts`, `src/telemetry/definitions.ts`, `tests/unit/upgrade.test.ts`, `.agent-team/*`, `docs/{guides/COPILOT_VSCODE,IDE_INTEGRATION,SETUP_AGENT,TELEMETRY_SPEC}.md`, `README.md`, compiled IDE outputs | `agent-studio upgrade` + `.upgrade-state.json` provenance + Doctor migration diagnostics + `$COPILOT_HOME` definitions + docs + dogfood `upgrade` on this repo. |
| **S1-68-T3** | `backend-engineer` | — | `src/cli/commands/hook-emit.ts`, `src/telemetry/{types,normalizer,push-bus,index}.ts`, `src/telemetry/adapters/copilot-vscode.ts`, `tests/unit/telemetry.test.ts` | `hook-emit` top-level JSON & dual camelCase/PascalCase parsing, Copilot native runtime tool classification (`create`/`str_replace`/`ask_user`/`task`/`web_fetch`/etc.), `subagentStart`/`subagentStop` correlation, and `$COPILOT_HOME/session-state/*/events.jsonl` discovery. |
| **S1-68-T4** | `frontend-engineer` | — | `extension/src/{modelSync,extension,mcpProvider}.ts`, `web/src/{utils,api,types}.ts`, `web/src/state/{modelIndex,topologyGrouping}.ts`, `web/src/components/{IdeUsageGuides,ModelIndexDialog}.ts`, `web/src/views/{Doctor,Team}.ts`, `tests/unit/extension.test.ts` | Extension runtime `modelSync` IDs & copy + Web Studio tool classification, usage guides, Doctor migration warnings (`embed=1` scoped), Team global `.copilot` scope, and default Model Index runtime IDs. |
| **S1-68-T5** | `qa-validator` | `S1-68-T2`, `S1-68-T3`, `S1-68-T4` | `pipeline/board.json` (via MCP `testrun` only) | Full verification gate (`CP0`, `CP1`, `CP2`), `node dist/cli/index.js sync --check`, `node dist/cli/index.js doctor`, and formal MCP `testrun` sign-off (alongside `code-reviewer`, `vscode-copilot-specialist`, `claude-code-specialist` audits). |

> **Parallelism Note:** `S1-68-T1`, `S1-68-T3`, and `S1-68-T4` have strictly disjoint file sets and can run concurrently immediately; `S1-68-T2` executes once `S1-68-T1` lands; `S1-68-T5` validates the integrated result.

---

## 5. Verification Checklist

1. **Compiler & Coalescing (`tests/unit/compiler.test.ts`)**:
   - Compiled `.github/agents/*.agent.md` use portable tool aliases (`read`, `search`, `edit`, `execute`, `agent`, `agent-studio/*`), emit `user-invocable` / `disable-model-invocation`, omit `handoffs:`, and omit `.github/prompts/learn.prompt.md`.
   - `workflow.copilotHarness: "legacy-local"` preserves legacy `read/readFile`, `handoffs:`, `.vscode/mcp.json`, PascalCase hooks, and `learn.prompt.md`.
   - Shared `.mcp.json` coalesces `claude-code` + `copilot-vscode` cleanly (`"type": "stdio"`, `"tools": ["*"]`) with zero `sync --check` drift, including filtered `sync --ides claude-code`.
   - `.github/hooks/agent-studio.json` uses 10 camelCase events via `json-merge`, omits `"managedBy"`, preserves user hooks, and removes only `HOOK_TAG_NEEDLE` legacy PascalCase entries.
   - `sync` without `--force` skips user-modified Markdown + warns; `sync --force` overwrites and restores zero drift.
   - Surgical cleanup removes only `servers["agent-studio"]` from `.vscode/mcp.json` (deleting file iff empty `{}`) and unlinks `.github/prompts/learn.prompt.md` + `<VSCodeUserDir>/prompts/*` only when SHA-256 marker validates.
   - `installGlobalSetupAgent` writes to `$COPILOT_HOME` (`COPILOT_HOME` override supported).
2. **Model Routing & Upgrade (`tests/unit/model-routing.test.ts`, `tests/unit/upgrade.test.ts`)**:
   - `DEFAULT_MODEL_INDEX` uses runtime IDs (`claude-sonnet-4.6`, etc.); compile-time alias mapper translates `"Claude Sonnet 4.6 (copilot)"` → `claude-sonnet-4.6` without touching custom/BYOK IDs.
   - `upgrade` handles first-time bootstrap (preserves modified `.agent-team/*.md` as `customized: true`), auto fast-forwards unmodified stock files, auto-adds missing built-in skills + `team.yaml` registration, supports `--dry-run`, `--diff`, `--write-incoming`, `--force`, `--global`, and rewrites legacy `(copilot)` IDs while keeping custom/BYOK models intact.
   - `doctor` validates `.mcp.json`, camelCase hooks, `$COPILOT_HOME`, and emits structured `migrationWarnings`.
3. **Hook-Emit & Telemetry (`tests/unit/telemetry.test.ts`)**:
   - `hook-emit` emits top-level JSON (`permissionDecision` + `exitCode: 0` on camelCase `preToolUse` deny; `{ additionalContext }` on `sessionStart`/`postToolUse`/`postToolUseFailure`/`subagentStart`/`notification`; empty stdout on `preCompact`/`userPromptSubmitted`), while preserving `hookSpecificOutput` for `claude-code` and PascalCase Copilot.
   - Classifies `create`, `str_replace`, `str_replace_editor` (`command === "view"` awareness), `ask_user`, `task`, `view`, `bash`, `powershell`, `grep`, `glob`, `web_fetch`.
   - Correlates `subagentStart` (label-only, no `agentId`) with `subagentStop` (`agentId` + `response`/`last_assistant_message`).
   - Discovers `$COPILOT_HOME/session-state/*/events.jsonl` scoped by workspace and deduplicates against `workspaceStorage`.
4. **Extension & Web Studio (`tests/unit/extension.test.ts`, `CP1`)**:
   - `mapLanguageModelsForHost("copilot-vscode", ...)` emits native `m.id` runtime IDs.
   - Web Studio builds cleanly (`CP1`) with updated guides, tool icons/classifications, Doctor migration warnings (`embed=1` scoped), and runtime model defaults.
5. **Checkpoints & Drift Gates**:
   - `CP0`: `npm run check && npm --prefix extension run check && npm test`
   - `CP1`: `npm --prefix web run check && npm --prefix web run build`
   - `CP2`: `python tests/smoke_test.py`
   - `node dist/cli/index.js sync --check && node dist/cli/index.js doctor`
