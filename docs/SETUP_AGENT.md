# Agent Studio — AI Setup Agent (`team-setup`) & Customization Guide

Agent Studio pairs a **deterministic CLI** (`init`, `sync`, `upgrade`, `doctor`) with a **cross-IDE AI Setup Agent (`team-setup`)** so you never have to hand-write IDE frontmatter or hook JSON—and AI agents never hallucinate config syntax.

---

## 1. Global vs. Project-Level Onboarding

### Global Bootstrap (`--global`)
Install `team-setup` once into your user-level IDE directories so you can onboard *any* greenfield or brownfield repository straight from chat:

```bash
npx agent-studio init --global
```

Files installed globally (respecting `HOME` / `AGENT_STUDIO_HOME` / `COPILOT_HOME` / `VSCODE_USER_DIR` overrides):
- **Antigravity:** `~/.gemini/config/plugins/agent-studio/` (`plugin.json`, `agents/team-setup.md`, `skills/team-setup/SKILL.md`, `skills/learn/SKILL.md`)
- **Claude Code:** `~/.claude/agents/team-setup.md`, `~/.claude/skills/team-setup/SKILL.md`, and `~/.claude/skills/learn/SKILL.md`
- **VS Code / Copilot (`$COPILOT_HOME`, default `~/.copilot`):** `~/.copilot/agents/team-setup.agent.md`, `~/.copilot/instructions/team-setup.instructions.md`, `~/.copilot/skills/team-setup/SKILL.md`, and `~/.copilot/skills/learn/SKILL.md` *(use `agent-studio upgrade --global` to migrate & clean unmodified legacy `<VSCodeUserDir>/prompts/` files)*

### Project-Level Initialization
To onboard a single repository directly from the terminal (and keep `.agent-team/` + compiled adapters Git-tracked for teammates):

```bash
npx agent-studio init
# Explicit flags for CI / scripted onboarding:
npx agent-studio init --project /path/to/repo --ides antigravity,claude-code,copilot-vscode --non-interactive
```

What `init` does automatically:
1. Detects installed IDEs on the machine (falling back to all 3 targets if none are present).
2. Auto-detects the repository stack (**Node.js**, **Python**, **Rust**, **Go**, or **Generic**) and populates sensible default `CP0`/`CP1`/`CP2` checkpoint commands.
3. Scaffolds `.agent-team/team.yaml`, `.agent-team/model-index.json`, `.agent-team/.upgrade-state.json`, role prompts (`agents/*.md`), and skills (`skills/*/SKILL.md` including `skills/model-routing`)—skipping already-customized files unless `--force` is passed.
4. Creates `pipeline/board.json` **only if it does not already exist** (existing boards are preserved verbatim).
5. Registers the workspace in `~/.agent-studio/projects.json`.
6. Runs `sync` and `doctor` to verify everything compiles cleanly with zero drift.

---

## 2. Invoking `team-setup` Inside Your IDE

Open any repository in **Antigravity**, **Claude Code**, or **VS Code Copilot** and invoke the `team-setup` agent:
- **Antigravity:** Select `team-setup` (or prompt: *"Use `team-setup` to onboard this repo to Agent Studio."*).
- **Claude Code:** Invoke `@team-setup` and ask it to configure Agent Studio for the current repository.
- **VS Code Copilot:** Choose **Team Setup Agent** in the Copilot Chat agent picker (or reference `team-setup.agent.md`).

### What `team-setup` Does
1. **Inspects the repo:** Reads `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, CI workflows, and any pre-existing `.agents/`, `.claude/`, `.github/`, or `pipeline/board.json`.
2. **Interviews you briefly:** Confirms target IDEs, whether to keep or specialize the default blueprint (`orchestrator`, `architect`, `ux-designer`, `backend-engineer`, `frontend-engineer`, `qa-validator`, plus any domain specialists like `mobile-engineer` or `data-engineer`), and exact QA gate test commands.
3. **Runs deterministic CLI scaffolding:** Executes `npx agent-studio init --ides ... --non-interactive`.
4. **Tailors `.agent-team/`:** Updates `.agent-team/team.yaml`, specialist prompts, and skills with project-specific architecture and test commands.
5. **Compiles & verifies:** Runs `npx agent-studio sync`, `npx agent-studio sync --check`, and `npx agent-studio doctor`, then reports how to invoke `orchestrator` and launch `npx agent-studio serve --open`.

---

## 3. Customizing `.agent-team/team.yaml`, Roles & Skills

**Golden Rule:** Edit **only** files inside `.agent-team/` (never hand-edit generated files inside `.agents/plugins/`, `.claude/agents/`, or `.github/agents/`).

### Adding or Customizing a Specialist Role
1. Create `.agent-team/agents/<role-id>.md` with the specialist's scope and handoff rules.
2. Register the role in `.agent-team/team.yaml` under `roster:`:
   ```yaml
   - id: data-engineer
     name: Data Engineer
     roleType: specialist
     boardRole: data
     promptFile: agents/data-engineer.md
     description: ETL pipelines, database migrations, and SQL performance tests.
     capabilities: [read, search, edit, shell, mcp_board]
   ```
3. Add `"data-engineer"` to `orchestrator.handoffs` for Antigravity / Web Studio / `legacy-local` delegation topology.
4. Recompile across all target IDEs (safe by default—user-modified compiled Markdown files are skipped unless `--force` is passed):
   ```bash
   npx agent-studio sync
   ```

### Safely Upgrading Existing Repositories (`agent-studio upgrade`)
When upgrading Agent Studio across releases, run:

```bash
# Preview template updates, unified diffs, and legacy Copilot migrations without writing
npx agent-studio upgrade --dry-run --diff

# Apply safe upgrade (fast-forwards unmodified stock templates, preserves customized .agent-team/*.md,
# adds new built-in skills, migrates legacy "(copilot)" model IDs, and cleans legacy .vscode/mcp.json)
npx agent-studio upgrade

# Also upgrade global $COPILOT_HOME / Antigravity / Claude Code setup files
npx agent-studio upgrade --global
```

`.agent-team/.upgrade-state.json` stores deterministic SHA-256 template provenance (no machine-local paths or volatile timestamps) so customizations stay protected across upgrades. Pass `--write-incoming` to inspect `.incoming` template files or `--force` to overwrite customized files explicitly.

### Customizing Verification Checkpoints & Suites
Edit `workflow.checkpoints` and `workflow.suites` in `.agent-team/team.yaml`:

```yaml
workflow:
  boardPath: pipeline/board.json
  stages: [ready, design, dev, test, done]
  enforcement:
    orchestratorReadOnly: true
    qaGateRequired: true
    blockDirectBoardEdits: true
  suites:
    smoke: [CP0, CP1]
    full: [CP0, CP1, CP2]
  checkpoints:
    CP0:
      title: Typecheck & Unit Suite
      command: npm run check && npm test
```

Then run `npx agent-studio sync` so all compiled IDE rules and prompts stay aligned.

---

## 4. Drift Detection (`sync --check`)

Every generated Markdown file carries an embedded SHA-256 content hash:
```html
<!-- GENERATED BY agent-studio sync — DO NOT EDIT DIRECTLY; edit .agent-team/ instead. hash:sha256:... -->
```
Shared files (`CLAUDE.md`, `.github/copilot-instructions.md`, `.mcp.json`, `.vscode/mcp.json`, `.claude/settings.json`) are checked strictly within their managed blocks or `agent-studio` JSON keys—your own notes, MCP servers, and hooks never trigger false drift.

Add drift verification to CI or your `CP0` checkpoint:

```bash
npx agent-studio sync --check
```

- Exits `0` when all compiled IDE adapters match `.agent-team/`.
- Exits `1` listing every `missing`, `modified`, or `out-of-date` file. Run `npx agent-studio sync` to reconcile.

---

## 5. Troubleshooting `agent-studio doctor`

Run `npx agent-studio doctor` (or `npx agent-studio doctor --json` for machine-readable output):

| Symptom in `doctor` | Cause | Fix |
| :--- | :--- | :--- |
| `nodeVersion.ok: false` | Node.js version is below `20.0.0` | Upgrade to Node 20 LTS or newer (`node -v`). |
| `manifestValid: false` | `.agent-team/team.yaml` is missing or fails Zod schema validation | Run `npx agent-studio init` or fix the reported YAML field in `.agent-team/team.yaml`. |
| `drift.ok: false` | A generated IDE file was hand-edited or `.agent-team/` changed without re-syncing | Run `npx agent-studio sync` to regenerate cleanly. |
| `mcpStatus.ok: false` | Missing `agent-studio` server entry in `.mcp.json` (or `.vscode/mcp.json` in `legacy-local`), or `mcp_config.json` | Run `npx agent-studio sync` (or `upgrade`); approve the project MCP server in Claude Code / VS Code when prompted. |
| `hooksStatus.ok: false` | Missing one or more `hook-emit` events in `.claude/settings.json` or `.github/hooks/agent-studio.json` | Run `npx agent-studio sync` (or `upgrade`) to merge missing hook entries non-destructively. |
| `modelIndex.valid: false` | Malformed JSON or schema error in `~/.agent-studio/model-index.json` or `.agent-team/model-index.json` | Fix JSON syntax or run `npx agent-studio models reset --scope workspace` (or `--scope global`). |
| `ides.<ide>.telemetryDirExists: false` | IDE hasn't written a session yet, or uses a non-default storage path | Start one session in that IDE, or pass `--brain-dir` / `--claude-dir` / `--vscode-dir` (or env vars `ANTIGRAVITY_BRAIN_DIR`, `CLAUDE_PROJECTS_DIR`, `VSCODE_STORAGE_DIR`) to `agent-studio serve`. |

---

## 6. Configuring Per-Role Model Routing (`model-index.json`)

Agent Studio uses a 3-layer Model Index so `sync --check` stays CI-deterministic while local VS Code hosts can still discover live models:
- **Layer 0 (Built-in Seed):** Default tiers (`fast`, `balanced`, `reasoning`) and role recommendations (`orchestrator` -> `fast`, `qa-validator` -> `fast`, `backend-engineer`/`frontend-engineer` -> `balanced`, `architect`/`ux-designer` -> `reasoning`).
- **Layer 1 (`~/.agent-studio/model-index.json`):** Live catalog populated automatically by the VS Code extension (`Agent Studio: Refresh Live Model Index`) or `npx agent-studio models discover --scope global`.
- **Layer 2 (`.agent-team/model-index.json`):** Git-tracked workspace overrides read by `sync` and `doctor`.

Common CLI commands:
```bash
npx agent-studio models show
npx agent-studio models set-tier copilot-vscode balanced claude-sonnet-4.6 --fallback claude-sonnet-4.6,gpt-5.4 --sync
npx agent-studio models set-role qa-validator --tier fast --sync
npx agent-studio models set-policy prefer-fallback --sync
npx agent-studio models adopt --sync
```
