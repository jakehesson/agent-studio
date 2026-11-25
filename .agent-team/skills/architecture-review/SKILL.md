---
name: architecture-review
description: Agent Studio architecture profile, module boundaries, state/concurrency contracts, hard invariants, and P0/P1/P2 conformance rubric.
---

# Agent Studio — Architecture Profile & Conformance Rubric

## 1. Architectural Style & Topology
- **Topology:** `full-stack-web`, `cli-library`, `modular-monolith` (Node/TypeScript core in `src/`, Vite/TypeScript Web Studio & SEP-1865 MCP App in `web/`, thin VS Code/Antigravity extension in `extension/`, native Antigravity plugin bundler in `antigravity-plugin/`, and standalone Python 3 visualizer `agent_visualizer.py`).
- **API & IPC Boundaries:**
  - Stdio & HTTP/SSE MCP server (`src/mcp/server.ts`) exposing `projects`, `board`, `testrun`, `telemetry`, and `open_studio`.
  - Live monitoring REST & SSE server (`src/server/`) consumed by `web/` and `extension/`.
  - Multi-IDE compiler (`src/compiler/`) compiling `.agent-team/` into `.agents/plugins/`, `.claude/`, `.github/`, `CLAUDE.md`, `.mcp.json`, and `.vscode/mcp.json`.

## 2. Module Boundaries & Dependency Direction
- `src/schema/` defines Zod schemas and Layer 0 static constants (`TeamManifestSchema`, `BoardSchema`, `ModelIndexSchema`); it must remain free of CLI/server side effects.
- `src/models/` owns 3-layer Model Index resolution, tier inference, and atomic file locks (`board.json`, `model-index.json`, `team.yaml`).
- `src/compiler/` compiles canonical `.agent-team/` inputs deterministically; it must never mutate `.agent-team/` or depend on `src/server/`.
- `src/templates/` owns bounded stack/architecture detection and deterministic scaffolding; detection must stay bounded to root manifests and depth-1 directory entries (no unbounded recursion or external symlink traversal).
- `web/` consumes server HTTP/SSE endpoints and MCP App bridge APIs without importing Node-only modules from `src/`.

## 3. State Management, Concurrency & Locking Contracts
- **Atomic File Locking:** Mutations to `pipeline/board.json`, `.agent-team/model-index.json`, `~/.agent-studio/model-index.json`, and `.agent-team/team.yaml` must acquire file locks, release in `finally`, and recover stale locks safely.
- **CI Determinism (Layer 0 + Layer 2 only):** `compileTeam`, `checkTeamDrift`, `sync`, and `doctor` drift checks must merge **Layer 0 + Layer 2** only unless `--use-global-index` is explicitly specified; Layer 1 (`~/.agent-studio/model-index.json`) must never introduce CI drift.
- **Idempotency:** Double-running `npx agent-studio sync` must produce zero written/merged files and pass `sync --check` with zero drift.

## 4. Hard Repository Invariants & Lockstep Rules
1. **3-Layer Orchestrator Read-Only Enforcement:** `orchestrator` capabilities strip `edit`, `write_docs`, `edit_tests`, and `shell` across Antigravity, Claude Code, and Copilot; `PreToolUse` hooks block direct writes to `pipeline/board.json`.
2. **Never Hand-Edit Compiled Outputs or `pipeline/board.json`:** All team changes belong in `.agent-team/` followed by `npx agent-studio sync`; all board changes go through MCP `board` / `testrun` or `npx agent-studio board`.
3. **IDE Extension Scoping Invariant (`embed=1`):** Embedded IDE extension mode must detect the host IDE and current workspace root and scope all views, API calls, sidebar items, and status bar counts strictly to that host IDE + workspace, hiding cross-IDE/cross-project chrome while keeping standalone Web Studio multi-IDE/multi-project switching intact.
4. **Core Token-Efficiency Invariant:** All blueprints (`src/templates/`), compiled team rules (`renderSharedTeamRules`), and `.agent-team/` must retain always-on Token & Context Discipline rules and `skills/token-efficiency/SKILL.md`.
5. **SemVer Lockstep Invariant:** `"version"` must match across `package.json`, `extension/package.json`, and `web/package.json`, and packaged `.vsix` filenames must derive dynamically from `extension/package.json`.
6. **Zero-Dependency Python Fallback Parity:** `agent_visualizer.py` must remain 100% Python 3 stdlib + vanilla HTML/CSS/SVG/JS with zero external dependencies and project-agnostic transcript discovery.
7. **Galaxy Z Fold 7 Three-Tier Responsive Standard:** Web UI screens must support `< 640px` (`100dvh` segmented switcher), `640px–1020px` (`1fr 1fr` split + `horizontal-viewport-segments: 2`), and `>= 1021px` desktop without horizontal overflow or clipped controls.

## 5. Known Failure Modes & P0/P1/P2 Architectural Rubric
- **`[P0 Blocker]`:**
  - Breaking CI determinism by leaking Layer 1 global model-index state into `sync` / `sync --check`.
  - Bypassing atomic locks or leaving stale/unreleased locks on `board.json` / `model-index.json` / `team.yaml`.
  - Leaking edit/shell tools to `orchestrator` or `code-reviewer`, or weakening path-traversal/symlink checks in server/detect/compiler paths.
  - Breaking `embed=1` scoping or introducing cross-IDE leakage in extension mode.
  - Adding external dependencies to `agent_visualizer.py` or hand-editing compiled `.agents/` / `.claude/` / `.github/` files without updating `.agent-team/`.
- **`[P1 Required]`:**
  - Missing deterministic sorting in compiler/template outputs causing `sync --check` flakiness.
  - Missing unit/regression tests for schema changes, CLI commands, or edge cases (empty repo, malformed JSON/YAML, stale locks).
  - Breaking Galaxy Z Fold 7 responsive tiers, `safe-area-inset-*`, or `44px` touch targets in `web/`.
- **`[P2 Advisory]`:**
  - Minor duplication across adapters/templates, naming clarity, or non-blocking doc/comment polish.
