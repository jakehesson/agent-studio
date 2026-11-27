# Changelog

All notable changes to **Agent Studio** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.15.0] - 2026-11-26

> Released with the QA gate overridden at the user's request (QA rerun skipped).

### Added
- **Direct In-Messages-UI Human Answering (`S1-77`):**
  - Added the Studio-owned `ask_human` MCP tool and the VS Code `agent_studio_ask_human` Language Model tool, so agents can ask questions that the user answers directly in Agent Studio.
  - Added **Send Answer** and a two-step **Cancel** in the Messages tab and Chat Drawer.
  - Added the `PromptBridge` with HTTP routes `/api/prompts*` and `/api/health`, a docked prompt tray with multi-prompt tabs, and MCP App `app_answer_prompt` / `app_cancel_prompt`.
  - Added a fail-open `preToolUse` redirect of `vscode_askQuestions` to `ask_human` when Studio is open on that workspace (opt out with `AGENT_STUDIO_DISABLE_ASK_REDIRECT=1`).
  - Added a shared team rule preferring `ask_human`.

### Changed
- Antigravity `notify_user(BlockedOnUser)` is no longer treated as `blockingToolCall`.
- `ask_human` runs off the serial MCP queue with progress keepalives and cancellation.
- `team-setup` on Antigravity now inherits MCP.
- A server bound to `0.0.0.0` rejects non-loopback `Host` headers on `/api/prompts*`.

### Fixed
- Removed the duplicate passive Copilot "Copy & Focus IDE" card for `ask_human`.
- Fixed light-theme `.btn-secondary:hover` contrast.
- Fixed the prompt tray clipping on short screens.
- Cards now lock after a remote answer, cancel, or expiry.
- Prompts are no longer hidden when a session has no agents.

### Security
- Added a Host/Origin guard on `/api/prompts*` against DNS rebinding, with no wildcard CORS.
- Added strict `vscode-webview://` origin validation.
- Prompt IDs reject raw `..` and encoded traversal.
- Active and terminal prompt counts are bounded.

## [0.14.0] - 2026-11-26

### Added
- **VS Code Copilot Harness Conformance (`S1-68`, `S1-69`, `S1-70`):**
  - Added `workflow.copilotHarness: "copilot" | "legacy-local"` support, portable tool aliases (`read`, `search`, `edit`, `execute`, `agent`), and `user-invocable` / `disable-model-invocation` frontmatter across compiled `.github/agents/*.agent.md` files.
  - Coalesced root `.mcp.json` across `claude-code` and `copilot-vscode` (`type: "stdio"` + `tools: ["*"]`), expanded `.github/hooks/agent-studio.json` to all 10 canonical camelCase `json-merge` hooks, and added `$COPILOT_HOME` global install, agent/skill definition discovery, and workspace-scoped `$COPILOT_HOME/session-state/*/events.jsonl` passive telemetry discovery.
- **Durable Customization-Preserving `agent-studio upgrade` (`S1-71`, `S1-72`):**
  - Added `agent-studio upgrade` (`--dry-run`, `--diff`, `--write-incoming`, `--force`, `--global`) backed by deterministic git-committed `.agent-team/.upgrade-state.json` (`src/schema/upgrade-state.ts`, `src/cli/commands/upgrade.ts`).
  - Added structured `migrationWarnings` to `agent-studio doctor` and the Web Studio Doctor card with `embed=1` IDE scoping and Galaxy Z Fold 7 three-tier responsive layout.

### Changed
- **Safe `agent-studio sync` & Legacy Cleanup:**
  - Updated `agent-studio sync [--force]` to preserve user-modified or unmarked generated Markdown files and perform surgical legacy cleanup (removing `.vscode/mcp.json` `servers["agent-studio"]` and SHA-256-verified `.github/prompts/learn.prompt.md` / `<VSCodeUserDir>/prompts/*`).
- **Runtime Copilot Model IDs & Hook Output Formats:**
  - Updated `DEFAULT_MODEL_INDEX`, `extension/src/modelSync.ts`, and Web Studio to runtime Copilot model IDs (`claude-sonnet-4.6`, `claude-opus-4.6`, `gpt-5.4`, etc.) with deterministic compile-time `LEGACY_COPILOT_MODEL_ALIASES` normalization that preserves custom/BYOK IDs.
  - Set `disable-model-invocation: true` on `skills/learn/SKILL.md` and updated `hook-emit` to emit top-level JSON (`permissionDecision`, `additionalContext`) for camelCase Copilot events while preserving `hookSpecificOutput` for `claude-code` and legacy PascalCase Copilot.

### Fixed
- **Subagent Correlation, Doctor Deduplication & Upgrade Locking (`S1-73`, `BUG-28`, `BUG-29`, `BUG-30`):**
  - Fixed label-only `subagentStart` + UUID `subagentStop` correlation and out-of-order label backfill with bounded LRU correlation maps in `PushBus` and `src/telemetry/normalizer.ts`.
  - Coalesced `doctor` `fileCount` reporting, deduplicated `migrationWarnings`, added atomic `upgrade` locking, eliminated first-run `model-index.json` churn, and fixed a stale-lockfile unlink TOCTOU race in `src/models/store.ts`.
  - Fixed comma-separated `warning.ide` filtering in `web/src/views/Doctor.ts` for strict `embed=1` IDE isolation.

### Security
- **Path Containment, Fail-Closed `preToolUse` & Telemetry Symlink Guards:**
  - Enforced path traversal and symlink containment (`SafeSlugSchema`, `SafeRelativePosixPathSchema`, `UpgradeStateKeySchema`, `assertContainedPath`) across `team.yaml`, `.upgrade-state.json`, `upgrade.ts`, and `src/compiler/{shared,index}.ts`.
  - Hardened `hook-emit` `preToolUse` (`create`, `str_replace`, `str_replace_editor` with `command === "view"` awareness, `apply_patch`, `multiedit`, `TargetFile`, >256KB & malformed JSON fail-closed, `execute`/`shell`/`terminal` board-write detection, and `"Team Orchestrator"` roster name matching) plus symlink/realpath containment and a 64KB `workspace.yaml` cap in `CopilotVSCodeAdapter.discoverSessions()`.

## [0.13.0] - 2026-11-26

### Added
- **Agent Chat Slide-Out Drawer & Waiting-for-Human-Choice Flow (`S1-66`):**
  - Added on-demand full chat extraction (`GET /api/chat`, `GET /api/sessions/:id/chat`, and MCP `app_get_chat`) across Antigravity (`ask_question` / `notify_user`), Claude Code (`AskUserQuestion`), and VS Code / Copilot (`questionCarousel` / `vscode_askQuestions` / elicitation) with `PendingHumanPrompt` correlation and answered/canceled suppression.
  - Added `AgentChatDrawer` (`<dialog>` slide-out with Galaxy Z Fold 7 three-tier & hinge-aware styling) and interactive `QuestionCard` answer flow (extension `postMessage` reply bridge, MCP App `sendMessage`, and clipboard fallback) alongside waiting-for-response indicators across `TopologySvg`, `ContextBar`, `ActivityFeed`, and Extension Status Bar / Sidebar.
- **DevOps Item-Driven Context-Threshold Handoff & Task Splitting (`S1-65`):**
  - Added `ContextHandoffSchema` plus `board op=handoff` and `board op=split` operations (`src/board/engine.ts`, `src/schema/board.ts`, `src/mcp/server.ts`) with cycle/duplicate dependency guards, 3-channel context advisories (`55%` Handoff / `PreCompact` via hooks, telemetry, and MCP board guidance), updated core team rules/prompts across all compiled IDE adapters, and `AgileBoard` / `UsageDashboard` handoff UI.

### Changed
- **Evidence-Based Model Routing & Orchestrator Prompt (`S1-67`):**
  - Upgraded `model-routing` skill (`src/templates/skills.ts`, `.agent-team/skills/model-routing/SKILL.md`) and `orchestrator` prompt (`src/templates/prompts.ts`, `.agent-team/agents/orchestrator.md`) with 10 ordered routing rules, the `expected_cost` formula (`initial_cost + retry_probability * retry_cost + review_cost`), 11 rerouting triggers, structured JSON decision contract, anti-over-delegation guardrails, and `ContextHandoffSchema` alignment (`decisions`, `assumptions`, `unresolved_issues`).

### Fixed
- **Accurate Model Context Windows in VS Code Telemetry (`BUG-26`):**
  - Implemented 4-tier `contextWindow` resolution across backend telemetry, `model-index.json`, extension live `vscode.lm` catalog sync, and Web Studio Smart Zone calculations, adding `1M` context window parity for MAI (`mai-*`) and GPT-4.1/5.4 models plus Copilot Auto version and subagent propagation.
- **Model Selection Ranking & Legacy Default Removal (`BUG-27`):**
  - Enforced `Accuracy -> Cost -> Speed` ranking across built-in model catalogs, role tier assignments (`orchestrator` / `qa-validator` set to `balanced`), live model sync, and cross-IDE `deferToHostOrchestrator` handling so compiled agents no longer default to outdated models such as Claude Haiku 4.5.

## [0.12.0] - 2026-11-25

### Added
- **Team-Agent Grouped Topology Visual (`S1-59`, `S1-64`):**
  - Added an auto-smart `[Grouped | Mesh]` layout toggle and `[Basic | Detailed]` detail switch in `web/src/components/TopologySvg.ts` backed by `web/src/state/topologyGrouping.ts`.
  - Organized **Grouped** mode into three clear swimlanes (Human, Coordinator, and Team-Agent clusters with per-run sub-rows, tool badges, cross-swimlane cluster splitting when a team member spans Active and Completed swimlanes, and external target chips) and added Radial Ring **Mesh** layout with cross-agent peer arcs, Galaxy Z Fold 7 three-tier responsive styling, and SEP-1865 MCP App parity (`docs/mockups/agent-mesh-grouped-and-sms.html`).
- **Clickable Message Counts, Consolidated Tools & Unified SMS Conversation Stream (`S1-60`, `S1-62`, `S1-63`, `S1-64`):**
  - Unified agent/human message events into an SMS-style conversation stream inside the `Messages` tab (`web/src/components/ActivityFeed.ts`, `web/src/views/LiveStudio.ts`) featuring team-member accent color alignment on SMS bubbles, sticky Run-Filter pills, `CommReaderModal` full-body hydration, and smart auto-scroll.
  - Consolidated the `Tools` tab into `Messages` as compact Workspace FS / Local Shell pill chips with bounded `220px` scrollable drawers.
  - Added clickable connector-line `[N msg]` pills, per-agent/per-run message badges, and footer `Messages` KPI jumps that navigate directly into the filtered thread.
- **Backend Full-Body Hydration & `teamRoster` Snapshot Metadata (`S1-61`, `S1-63`):**
  - Preserved and exposed full untruncated message/event bodies (`src/telemetry/types.ts`, `src/schema/telemetry.ts`, `src/telemetry/normalizer.ts`, `src/telemetry/push-bus.ts`, `src/telemetry/adapters/copilot-vscode.ts`, `src/cli/commands/hook-emit.ts`) with unit coverage in `tests/unit/event-body.test.ts` and Markdown/inspector support (`web/src/utils/markdown.ts`, `web/src/components/PayloadInspector.ts`).
  - Added `teamRoster` discovery metadata to `RichSessionSnapshot` in `src/telemetry/index.ts` and `src/telemetry/definitions.ts` for Grouped topology role resolution.
- **In-App GitHub Feedback Modal & Release Guardrails (`S1-57`, `S1-58`):**
  - Added the in-app GitHub Issues feedback modal across Web Studio, MCP App, and VS Code/Antigravity extension (`FeedbackDialog`, `ContextBar`, server/extension feedback handlers), `scripts/check-version-lockstep.mjs` integrated into `npm run check`, contract parity tests, and Vite `__APP_VERSION__` defines.
  - Added pre-push local Antigravity MCP App plugin (`--install`) and `.vsix` extension installation steps to the `release-management` skill and `release-engineer` agent.

### Fixed
- **Antigravity Canonical Team Roster Discovery (`BUG-25`, `S1-63`):**
  - Fixed Antigravity team roster discovery with `file://` URI decoding, ancestor `.agent-team/team.yaml` walk-up, multi-line `Active Workspaces:` parsing, and `"Specialist Subagent"` placeholder guards across `src/telemetry/adapters/antigravity.ts`, `src/telemetry/definitions.ts`, and `src/telemetry/index.ts`.
- **Messages Stream, `#msg` Filtering & Tool Drawer Layout (`BUG-23`, `BUG-24`):**
  - Fixed stacked flat-feed rendering in `Messages`, strict `#msg` line-endpoint filtering, and `.tool-burst-card` `0px` collapse across `web/src/components/ActivityFeed.ts`, `web/src/styles/studio.css`, and `web/src/styles/mcp-app-theme.css`.
- **Copilot Subagent UUID Display Names (`BUG-21`):**
  - Fixed VS Code / Copilot subagent UUID fragments rendering as mesh agent names by resolving readable subagent names across `CopilotVSCodeAdapter`, `PushBus`, and `src/telemetry/normalizer.ts` (`tests/unit/telemetry.test.ts`).
- **Live Refresh Scroll & `<details>` Stability (`BUG-22`):**
  - Preserved `<details>` open/closed state and container/`<pre>` scroll positions in `web/src/components/PayloadInspector.ts` and prevented live SSE/polling refreshes from jumping scroll position in `ActivityFeed`.

## [0.11.1] - 2026-11-25

### Fixed
- **Live SSE Test Reliability (`tests/unit/server.test.ts`):**
  - Reused `pendingRead` across 100ms timer ticks in the live SSE `readUntil` helper to eliminate a `ReadableStreamDefaultReader.read()` race where abandoned concurrent reads could swallow SSE chunks under CI load.
- Includes all **0.11.0** improvements: VS Code / Copilot & GitHub Enterprise feed parity (`S1-56`) and token/context usage accuracy (`BUG-20`).

## [0.11.0] - 2026-11-25

### Added
- **VS Code / Copilot & GitHub Enterprise Session Parity (`S1-56`):**
  - Added human-readable hook feed summaries (`summarizeToolCall`) in `src/cli/commands/hook-emit.ts` across `PreToolUse`, `PostToolUse`, and `PostToolUseFailure`, promoted `write_agent` / `read_agent` to `message` edges, and guarded against `agent_id === sessionId` / `parent_agent_id === sessionId` creating phantom UUID nodes.
  - Expanded VS Code / Copilot tool classification and summary coverage (`src/telemetry/types.ts`, `web/src/utils.ts`) for `powershell`, `view`, `rg`, `glob`, `apply_patch`, `sql`, `skill`, `tool_search_tool`, `rename_chat`, `copilot_*` tools, `manage_todo_list`, and slash-prefixed tool IDs, plus empty-label Markdown link basename extraction (`[](file:///...)` -> basename).
  - Enriched `CopilotVSCodeAdapter` (`src/telemetry/adapters/copilot-vscode.ts`) passive session and transcript feed text using `thinking.generatedTitle`, `textEditGroup.uri`, `turnText` completion summaries, and `assistant.message` prose + `toolRequests` extraction (suppressing duplicate `"Turn completed"` rows).
  - Added canonical Tier-2 cross-channel tool-alias deduplication (`canonicalDedupToolName`) and namespace-stripped subagent label reconciliation (`normalizeSubagentLabel`, e.g. `VS Code Synced Data:break-glass` -> `BreakGlass`) in `src/telemetry/normalizer.ts`.

### Fixed
- **VS Code / Copilot Token Usage & Context Window Accuracy (`BUG-20`):**
  - Added `normalizeCopilotUsage()` across `CopilotVSCodeAdapter` and `hook-emit.ts` to subtract inclusive `cachedTokens` from OpenAI/Copilot `promptTokens`/`inputTokens` while preserving Anthropic raw usage and preventing `completionTokens`-only turns from overwriting `lastTurnContext`.
  - Separated incremental usage rows from cumulative `session.usage_checkpoint` / `session.shutdown` checkpoints in `events.jsonl` parsing to eliminate checkpoint double-counting.
  - Propagated explicit IDE `selectedModel.metadata.maxInputTokens` / `tokenLimit` via `UsageDelta.contextWindow`, aligned `inferContextWindow(model, ide)` across backend and frontend (`400_000` for GPT-5 / GPT-6), replaced cumulative fallback context estimation with active-turn non-cumulative estimation, and aligned Peak Context KPI display in `web/src/components/UsageDashboard.ts`.

## [0.10.0] - 2026-11-25

### Added
- **Cross-IDE `/learn` Skill for Durable Session Knowledge Capture (`S1-55`):**
  - Added the canonical `learn` skill (`src/templates/skills.ts`, `src/templates/manifest.ts`, `.agent-team/skills/learn/SKILL.md`) to extract durable session takeaways (user corrections, bug root causes, invariants, repeated workflows), deduplicate against existing docs, enforce `< 8 KB` / zero-secret caps, and confirm surgical edits before running `agent-studio sync` + `sync --check`.
  - Compiled `/learn` across all three supported IDEs: Antigravity (`.agents/plugins/*/skills/learn/SKILL.md` and `antigravity-plugin/scripts/build-plugin.mjs`), Claude Code (`.claude/skills/learn/SKILL.md`), and VS Code / GitHub Copilot (`.github/skills/learn/SKILL.md` plus `.github/prompts/learn.prompt.md` generated by `renderCopilotLearnPrompt` in `src/compiler/copilot-vscode.ts`).
  - Added `learn` skill and Copilot `learn.prompt.md` installation to `installGlobalSetupAgent` (`src/compiler/global-install.ts`) and unit coverage in `tests/unit/compiler.test.ts` and `tests/unit/antigravity-plugin.test.ts`.

## [0.9.1] - 2026-11-25

### Fixed
- **VS Code Copilot Telemetry Accuracy, Subagent Deduplication & Live Status (`BUG-19`):**
  - Eliminated inflated `User` prompt counts and spurious `User -> subagent` edges by coercing subagent `UserPromptSubmit` hook events (`subagentId !== "root"`, parent-re-homed events, and orphan-migrated events) into `thinking_start` instead of `user_input`.
  - Fixed duplicate subagent nodes between passive `chatSessions`/transcripts and live hooks by clamping `isComplete: true` session completion epochs, improving `subagentToParent` orphan migration and UUID-only matching, and preserving readable subagent identities across adapters and `PushBus`.
  - Collapsed split root UUID nodes into the canonical `Coordinator` node in `buildSnapshot()` and `normalizer.ts`.
  - Fixed `WORKING` `activeTool` status labels to display readable tool names instead of raw `call_...` tool-call IDs.

## [0.9.0] - 2026-11-25

### Added
- **Permanent Platform Validation Specialist Agents (`S1-52`):**
  - Added read-only `vscode-copilot-specialist`, `claude-code-specialist`, and `antigravity-specialist` agents plus the shared `platform-validation` skill synced across Antigravity, Claude Code, and GitHub Copilot / VS Code.
- **VS Code Copilot Discovery, Transcripts & Hooks:**
  - Added multi-variant VS Code storage discovery (`Code`, `Code - Insiders`, `VSCodium`), `GitHub.copilot-chat/transcripts/*.jsonl` parsing with `(mtimeMs, sizeBytes)` caching, and `PushBus` hook `transcript_path` / `agent_transcript_path` enrichment.
  - Added `SessionStart`, `UserPromptSubmit`, and `PreCompact` hooks for VS Code Copilot (`.github/hooks/agent-studio.json`) and `PostToolUseFailure` hook for Claude Code (`.claude/settings.json`).
  - Added VS Code extension sidebar session deep-linking (`?session=<id>`) and webview panel session preservation on reveal.

### Changed
- **Passive Transcript Live Streaming & Cross-Adapter Improvements:**
  - Added passive transcript live streaming over SSE (`heartbeatTimer` polling with per-client `inFlight` guard and volatile-field hash stripping) so Antigravity, Claude Code, and VS Code passive updates stream live without manual refresh.
  - Updated `AntigravityAdapter` for full-file cached discovery beyond 32 KB (`isMultiAgent`, `file:///` `workspaceUris`, tail `status`), `deferToHostOrchestrator` emitting `model: inherit` on `orchestrator.md`, and removed deprecated `MultiEdit` from Claude Code compiled agent tools.
  - Switched to non-monotonic `lastTurnContext` tracking across all three adapters so context compaction (`/compact`) drops displayed occupancy accurately, and added `[1m]` and IDE-aware context window inference.

### Fixed
- **VS Code Copilot Session Correlation & Ghost Node Elimination (`BUG-16`):**
  - Added `PushBus` `subagentToParent` re-homing (including out-of-order orphan migration), fixed `SubagentStart`/`SubagentStop` actor (`root`) vs `targetAgentId` & `agent_type` preservation, and prevented `PreToolUse`/`PostToolUse` `Agent`/`Task` without `targetAgentId` from spawning ghost nodes or marking Coordinator `DONE`.
  - Pinned Live Studio SSE `stream.updateParams({ session })` with mismatched-session frame drop guards and eliminated phantom `subagent-<hash>` ghost cards using server-authoritative live tail.
- **VS Code Copilot Context, Token & Model Tracking (`BUG-17`):**
  - Hydrated real usage, model, and subagent metadata from VS Code transcripts and `toolCallRounds`, fixed `root -> orchestrator` definition model fallback, improved fallback token estimation and `peakContextPercent` reporting, and fixed `CopilotVSCodeAdapter` `subagent.*` self-loop edges.
- **Claude Code & Antigravity Telemetry Accuracy:**
  - Fixed Claude Code streaming assistant `message.id` usage deduplication (eliminating 3x–5x token inflation), `PreToolUse` deny exit code (`0` with JSON on stdout), `subagents/agent-*.jsonl` correlation and `mtimeMs` inclusion, hyphenated workspace matching, and MCP App multi-IDE filtering.
  - Fixed Antigravity `openToolCalls` desync on `invoke_subagent`/`send_message`/`notify_user`, parallel `pendingSpawns` correlation, `manage_subagents` cancel handling, and decimal `MODEL_SELECTION_RE` truncation.

### Security
- **Hardened `transcriptPath` / `agentTranscriptPath` Ingestion (`BUG-18`):**
  - Enforced strict syntactic checks (rejecting null bytes, control chars, UNC/device prefixes, `..` traversal, relative paths, non-`.jsonl`, and `telemetry.jsonl`), `lstat`/`realpath` containment via `path.relative` against server-trusted roots only, a 20 MB file size cap, and a 64 paths/session `PushBus` cap.

## [0.8.2] - 2026-11-25

### Added
- **Private GitHub Packages Publishing (`S1-51`):**
  - Configured `@jakehesson/agent-studio` (`publishConfig` for `https://npm.pkg.github.com`) while preserving the `agent-studio` CLI bin name.
  - Added automated private `npm publish` step to `.github/workflows/release.yml` and documented installation/auth setup in `README.md`.

### Fixed
- **Cross-Platform CI & Launcher Hardening (`BUG-15` / `S1-51`):**
  - Used `#!/bin/sh` in the POSIX PATH-fallback mock (`tests/unit/compiler.test.ts`) so Linux CI tests pass even when `/usr/bin` is stripped from `PATH`.
  - Increased `tests/unit/mcp-stdio.test.ts` timeout to `20_000 ms` for reliable CI execution.
  - Stripped `Path` / `PATH` case variants on Windows in launcher unit tests (`tests/unit/compiler.test.ts`, `tests/unit/extension.test.ts`) and added `SystemRoot\System32\cmd.exe` fallback in `src/compiler/launcher.ts`.

### Changed
- **Web Studio & Sidebar UI Copy (`S1-51`):**
  - Updated all remaining CLI command hints across `web/src/` (`api.ts`, `IdeUsageGuides.ts`, `ModelIndexDialog.ts`, `AgileBoard.ts`, `Doctor.ts`, `Team.ts`) from `npx agent-studio` to `agent-studio`.

## [0.8.1] - 2026-11-25

### Fixed
- **VSIX-Only Machine CLI/Hook/MCP Execution (`BUG-14`):**
  - Eliminated `npm E404` errors (`npx agent-studio`) on VSIX-only / non-npm-published machines where the extension is installed without a global npm install.
  - **Extension Auto-Shim (`extension/src/cliShim.ts`, `extension/src/extension.ts`):** VS Code / Antigravity extension activation now atomically syncs the bundled `studio-cli.mjs` and cross-platform `agent-studio` / `agent-studio.cmd` shims to `~/.agent-studio/bin/` and prepends that directory to integrated terminal `PATH`.
  - **Portable Hook & MCP Launcher (`src/compiler/launcher.ts`):** Compiled Copilot, Claude Code, and Antigravity hooks and MCP configs (`.github/hooks/agent-studio.json`, `.claude/settings.json`, `.mcp.json`, `.vscode/mcp.json`, `.agents/plugins/*/mcp_config.json`) now use a portable `node -e` launcher resolving `~/.agent-studio/bin/studio-cli.mjs`, local `node_modules/.bin`, or `PATH` (preserving `HOOK_TAG_NEEDLE` and failing open on hooks).

### Changed
- **Templates & Skills (`src/templates/prompts.ts`, `src/templates/skills.ts`):**
  - Updated `team-setup` prompts, skills, and generated IDE adapters to prefer `agent-studio` / `~/.agent-studio/bin` instead of raw `npx agent-studio`.

## [0.8.0] - 2026-11-25

### Added
- **First-Class `code-reviewer` Agent (`S1-49`):**
  - Registered `code-reviewer` (`roleType: specialist`, `boardRole: review`, `modelTier: reasoning`) in `.agent-team/team.yaml`, compiled IDE adapters (Antigravity, Claude Code, GitHub Copilot / VS Code), and orchestrator handoff workflows (`src/templates/manifest.ts`, `src/templates/prompts.ts`, `src/schema/model-index.ts`, `src/models/defaults.ts`).
- **Universal `code-review` & Repo-Specific `architecture-review` Skills:**
  - Added the 5-pillar `code-review` skill (syntax/types, security, architecture conformance, performance/concurrency, test coverage) and repo-tailored `architecture-review` skill (`src/templates/skills.ts`, `.agent-team/skills/`), bundled into the Antigravity MCP App plugin (`antigravity-plugin/scripts/build-plugin.mjs`).
- **Architectural Research Detection & `team-setup` Enhancement:**
  - Added `detectProjectArchitecture` (`src/templates/detect.ts`) to inspect repository topology hints, frameworks, state management, concurrency signals, API boundaries, storage signals, monorepo workspaces, and CI workflows.
  - Enhanced `team-setup` prompts and skills to run deep architectural research tasks tailoring `architecture-review` and `code-reviewer` to repository invariants, module boundaries, and concurrency contracts.

### Changed
- **`init` & `doctor` Architecture Diagnostics:**
  - Updated `agent-studio init` (`src/cli/commands/init.ts`) to surface detected architectural topology and frameworks during scaffolding.
  - Updated `agent-studio doctor` (`src/cli/commands/doctor.ts`) with `architectureReview` health checks reporting `code-reviewer` roster registration, review skill presence, and deep architectural research customization status.

## [0.7.0] - 2026-11-24

### Added
- **Project & Custom Agent Visibility in Web Studio Team Tab (`S1-47`):**
  - Surfaced project-specific and custom (non-roster) agents alongside team roster and global agents in the Web Studio Team tab (`web/src/views/Team.ts`) with `Project Agent`, `Team Roster`, and `Global` scope badges.
  - Added dedicated `Project / Custom` and `Global` scope filter chips plus quick-jump summary pills while preserving `embed=1` host-IDE scoping and Galaxy Z Fold 7 three-tier responsive and forced-colors accessibility ergonomics (`web/src/styles/views.css`, `web/src/styles/responsive.css`, `web/src/styles/mcp-app-theme.css`).

### Fixed
- **Frontmatter-less Generated Markdown Drift Check (`BUG-12`):**
  - Fixed `verifyGeneratedMarkdownHash` (`src/compiler/merge.ts`, `tests/unit/compiler.test.ts`) newline handling on frontmatter-less generated markdown files (such as `rules/AGENTS.md`) so unmodified files verify cleanly and outdated files report `out-of-date` rather than false `modified (SHA-256 marker mismatch)` drift.

## [0.6.0] - 2026-11-25

### Added
- **Formatted Communication Reader Modal & Full-Body Telemetry (`S1-45`):**
  - Added bounded in-memory `EventBodyStore` (`src/telemetry/body-store.ts`) and full untruncated message/prompt body capture across Antigravity, Claude Code, and VS Code Copilot telemetry adapters, exposed on demand via `GET /api/event-body` and MCP `app_get_event_body` while keeping SSE/state payloads lightweight.
  - Added dedicated `<dialog closedby="any">` `CommReaderModal` (`web/src/components/CommReaderModal.ts`) accessible from 1-click **Read** buttons in `ActivityFeed` and **Reader View** in `PayloadInspector`, featuring ~92vw × 90dvh desktop sizing with a 1-click Fullscreen toggle (auto-fullscreen on Fold/Mobile) and Galaxy Z Fold 7 three-tier responsive ergonomics.
  - Added zero-dependency, XSS-safe GFM Markdown renderer (`web/src/utils/markdown.ts`) supporting headings, emphasis, horizontal rules, lists/task lists, blockquotes, scrollable tables, fenced code blocks with language pills and per-block Copy buttons, sticky Table of Contents for 2+ headings, Formatted/Raw toggle, Copy Markdown, and a collapsible Raw JSON drawer.
  - Added safe link handling (`https://` in new tab with `noopener noreferrer`; styled `file://` chips) and an IDE Extension `postMessage` file-link bridge (`extension/src/fileLinkBridge.ts`, `extension/src/webviewProvider.ts`) to open workspace/agent files in `ViewColumn.Beside` (`preserveFocus: true`) with line selection.

## [0.5.0] - 2026-11-25

### Added
- **3-Layer Updatable Model Index & Per-Role Model Routing:**
  - Added canonical + global + workspace-override `model-index.json` schema (`src/schema/model-index.ts`, `src/models/`), `agent-studio models` CLI subcommands (`show`, `discover`, `set-tier`, `set-policy`, `reset`), and REST endpoints (`/api/model-index`, `/api/model-index/discover`, `/api/team/routing`).
  - Added `modelRouting` policies (`prefer-fallback`, `defer-to-host`, `pinned`) and per-role `modelTier` / `modelPolicy` / `models` overrides in `.agent-team/team.yaml`, compiled safely across Antigravity (`/swarm` compatible), Claude Code, and GitHub Copilot / VS Code (Fusion/Auto compatible).
  - Added Model Index Inspector & Editor dialog, Role Overrides modal, and live `vscode.lm` catalog discovery (`extension/src/modelSync.ts`).
- **Open-Source Release Hygiene & CI/CD:**
  - Added MIT `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, GitHub issue/PR templates, `pipeline/board.example.json`, and sanitized `tests/fixtures/legacy-board.json`.
  - Added cross-platform GitHub Actions workflows (`.github/workflows/ci.yml` on Ubuntu & Windows, `.github/workflows/release.yml` publishing `.vsix` and Antigravity plugin `.zip` assets).

### Changed
- **Portable Compiler MCP Configs:** Emitted `["-y", "agent-studio", "mcp"]` (without machine-specific `--project <absPath>`) across Antigravity `mcp_config.json`, Claude Code `.mcp.json`, and VS Code `.vscode/mcp.json`, letting `resolveProject()` auto-detect from `cwd`.

## [0.4.0] - 2026-11-25

### Added
- **Per-Agent Token, Context Smart Zone & Model Usage Telemetry:**
  - Extracted exact API input/output/cache tokens (Claude Code & VS Code Copilot) and estimated prompt/completion/context window metrics (Antigravity) per agent and session total in `/api/state`, `/api/stream`, and `app_get_state`.
  - Added a visual **Usage** tab alongside the Live Activity Stream displaying session KPIs (total tokens, peak context %, active models, estimated cost) and per-agent context window meters across standalone Web Studio, VS Code VSIX, and Antigravity MCP App.

## [0.3.0] - 2026-11-24

### Added
- **Native Antigravity MCP App Plugin (`antigravity-plugin/`):**
  - Packaged a zero-HTTP-server Antigravity plugin bundle (`plugin.json`, `mcp_config.json`, bundled CLI binary, and single-file SEP-1865 `app.html` with `aux_pane` + `global` + `open_studio` tool support).

## [0.2.0] - 2026-11-24

### Added
- **VS Code & Antigravity `.vsix` Extension (`extension/`):**
  - Added thin extension with Activity Bar sidebar, Status Bar indicator, embedded Web Studio panel, and automatic host-IDE + primary workspace scoping (`embed=1`).
  - Added core 10-point **Token & Context Discipline** always-on rules and portable `skills/token-efficiency/SKILL.md` across all compiled IDEs.
  - Added dynamic SemVer VSIX packaging (`agent-studio-<version>.vsix`).

## [0.1.0] - 2026-11-24

### Added
- **Core CLI, Locked Agile Board & Stdio MCP Server (`src/`):**
  - Implemented `agent-studio` CLI (`init`, `sync`, `doctor`, `serve`, `mcp`, `board`, `testrun`, `projects`, `hook-emit`).
  - Implemented atomic `pipeline/board.json.lock` mutations and server-side QA Gate (`test -> done` requires a closed, passing testrun).
  - Implemented `.agent-team/` 3-IDE compiler (`antigravity`, `claude-code`, `copilot-vscode`), hybrid telemetry aggregator (`hook-emit` + transcript parsing), and unified single-port Vite Web Studio (`web/`) with Galaxy Z Fold 7 three-tier responsive layout and UX Designer role.
