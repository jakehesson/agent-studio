# Contributing to Agent Studio

Thank you for your interest in contributing to **Agent Studio**!

## Local Development Setup

### Prerequisites
- **Node.js** >= 20 (`npm` included)
- **Python** >= 3.10 (for the legacy standalone `agent_visualizer.py` smoke suite)

### Install Dependencies
```bash
npm install
npm --prefix web install
npm --prefix extension install
```

### Build Everything
```bash
npm run build:all
npm --prefix extension run build
npm run build:plugin
```

## Verification Checkpoints

Run the full verification suite before opening a pull request:

```bash
# Typecheck core CLI/server + unit tests
npm run check

# Typecheck Web Studio + Vite / MCP App build
npm --prefix web run check
npm --prefix web run build

# Typecheck extension + build VSIX
npm --prefix extension run check
npm --prefix extension run package

# Build Antigravity MCP App plugin
node antigravity-plugin/scripts/build-plugin.mjs

# Run all unit tests
npm test

# Verify compiled IDE adapters have zero drift
node dist/cli/index.js sync --check

# Run legacy Python visualizer smoke suite
python tests/smoke_test.py

# Verify npm package contents
npm pack --dry-run
```

## Team Configuration & Generated Files

- **Edit canonical sources only:** Make team/role/skill/model changes in `.agent-team/` (`team.yaml`, `model-index.json`, `agents/*.md`, `skills/*/SKILL.md`), then run:
  ```bash
  node dist/cli/index.js sync
  ```
  Do **not** hand-edit generated files in `.agents/plugins/agent-studio-team/`, `.claude/`, `.github/agents/`, `.github/skills/`, `.mcp.json`, or `.vscode/mcp.json`.
- **Keep `pipeline/board.json` local:** `pipeline/board.json` is gitignored so contributors can run local sprints without polluting PR diffs. Use `pipeline/board.example.json` or `tests/fixtures/` for schema examples and tests.
- **Lockstep SemVer:** Keep `"version"` synchronized across `package.json`, `web/package.json`, `extension/package.json`, `src/mcp/server.ts`, and `web/src/mcp-app-entry.ts`.
- **Zero personal paths:** Never commit machine-specific paths, hostnames, UUIDs, or private transcripts.

## Pull Request Workflow
1. Fork the repository and create a feature branch from `main`.
2. Keep changes focused and include unit tests under `tests/unit/` for new behavior.
3. Run all verification commands above and confirm zero failures or sync drift.
4. Open a pull request using `.github/PULL_REQUEST_TEMPLATE.md`.
