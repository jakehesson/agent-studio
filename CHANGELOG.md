# Changelog

All notable changes to **Agent Studio** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
