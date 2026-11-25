# Agent Studio — Workspace Guidelines

This repository hosts **Agent Studio** (`agent-studio`) — the IDE-agnostic multi-agent orchestration CLI, QA-gated Agile Board MCP server, Web Studio UI, VS Code / Antigravity extension, and native Antigravity MCP App — alongside the standalone zero-dependency legacy Python visualizer (`agent_visualizer.py`).

## Architecture & Key Files
- `src/` — Core Node/TS CLI (`agent-studio`), stdio MCP server (`projects`, `board`, `testrun`, `telemetry`, `open_studio`), `.agent-team/` multi-IDE compiler (`antigravity`, `claude-code`, `copilot-vscode`), 3-layer Model Index (`src/models/`), and hybrid telemetry aggregator.
- `web/` — Unified Vite Web Studio & single-file SEP-1865 MCP App (`app.html`) with Galaxy Z Fold 7 three-tier responsive layout.
- `extension/` — Thin VS Code / Antigravity `.vsix` extension with automatic host-IDE and workspace scoping (`embed=1`).
- `antigravity-plugin/` — Native Antigravity MCP App plugin packager (`~/.gemini/config/plugins/agent-studio/`).
- `agent_visualizer.py` & `tests/smoke_test.py` — Standalone zero-dependency Python 3 visualizer and smoke verification suite (`py_compile`, `node --check`, transcript parsing, and ephemeral HTTP test).
- `.agent-team/` — Canonical team manifest (`team.yaml`), model index (`model-index.json`), agent prompts, and portable skills compiled via `npx agent-studio sync`.
- `pipeline/board.example.json` — Example Agile Board schema file (local `pipeline/board.json` is gitignored and managed only via `agent-studio` MCP or `npx agent-studio board`).

## Development Rules
1. **Follow the Agile Board**: Track all work via the `agent-studio` MCP (`board` / `testrun` tools) or `npx agent-studio board`. Never hand-edit `pipeline/board.json`.
2. Keep the visualizer **project-agnostic** (discover agents dynamically from `~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl`; never hardcode project-specific agent names).
3. Keep **zero external dependencies** (Python 3 stdlib + vanilla HTML/CSS/SVG/JS).
4. Run `python tests/smoke_test.py` after every change and verify all checks pass before finishing.
5. **IDE Extension Scoping Invariant**:
   - When running inside the IDE extension (`embed=1`), detect the host IDE (`antigravity` vs `copilot-vscode` from `vscode.env.appName`) and primary open workspace root, and scope **all** views, API calls, Sidebar items, and Status Bar counts strictly to that **host IDE** and **current workspace**.
   - Hide cross-IDE and cross-project UI chrome in embedded extension mode (multi-project switcher, other-IDE pills, other-IDE Doctor cards & Usage Guides, other-IDE Team definitions/skills).
   - Keep full multi-IDE + multi-project switching intact when running as the standalone Web Studio (`agent-studio serve` in a browser without `embed=1`).
6. **Core Token-Efficiency Invariant**:
   - Every Agent Studio blueprint (`src/templates/`), compiled IDE team rules block (`renderSharedTeamRules`), and onboarded `.agent-team/` repository must include **Token & Context Discipline** as an always-on core rule and **`skills/token-efficiency/SKILL.md`** as a core skill for all agents across Antigravity, Claude Code, and GitHub Copilot / VS Code.
7. **SemVer Versioning Invariant**:
   - Bump minor (`0.x.0 -> 0.(x+1).0`) when features are added; bump patch (`0.x.y -> 0.x.(y+1)`) for standalone bug-fix releases.
   - Keep `"version"` synchronized in lockstep across `package.json`, `extension/package.json`, and `web/package.json`.
   - Derive the packaged VSIX filename dynamically from `extension/package.json`'s `version` (`agent-studio-<version>.vsix`).
