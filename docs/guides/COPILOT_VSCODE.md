# Agent Studio — GitHub Copilot / VS Code Usage Guide

Complete, step-by-step guide to setting up custom Copilot Chat agents (`agent` tool, `user-invocable`, runtime model IDs), wiring shared `.mcp.json` & camelCase hooks, and monitoring live sessions with **Agent Studio** in **Visual Studio Code** and **Copilot CLI**.

---

## 1. Prerequisites

- **Node.js `>= 20.0.0`** (`node -v`)
- **Visual Studio Code** (Stable or Insiders) with **GitHub Copilot Chat** enabled (or GitHub Copilot CLI)

---

## 2. Installation & Setup

### Option A: Global Bootstrap (Use `Team Setup Agent` in Any Workspace)
Install the global `team-setup` agent, instructions, and `team-setup` / `learn` skills into `$COPILOT_HOME` (defaults to `~/.copilot`, or set `COPILOT_HOME` to override):

```bash
npx agent-studio init --global
```

Files installed under `$COPILOT_HOME` (`~/.copilot/`):
- `agents/team-setup.agent.md`
- `instructions/team-setup.instructions.md`
- `skills/team-setup/SKILL.md`
- `skills/learn/SKILL.md`

*(Upgrading an existing machine with `npx agent-studio upgrade --global` also surgically removes unmodified Agent Studio legacy files from `<VSCodeUserDir>/prompts/` while preserving user-modified files.)*

### Option B: Project Initialization & Safe Upgrade
Initialize a new repository or safely upgrade an existing one:

```bash
# Compile for GitHub Copilot / VS Code (or include antigravity,claude-code)
npx agent-studio init --ides copilot-vscode

# Non-interactive multi-IDE bootstrap (preserves existing pipeline/board.json)
npx agent-studio init --ides antigravity,claude-code,copilot-vscode --non-interactive

# Upgrade an existing repository safely (preserves customized .agent-team/*.md files)
npx agent-studio upgrade --dry-run --diff
npx agent-studio upgrade
```

### What Gets Compiled / Merged for GitHub Copilot / VS Code
`npx agent-studio sync` emits and non-destructively merges (under default `workflow.copilotHarness: "copilot"`):

| Target File | Strategy | Purpose |
| :--- | :--- | :--- |
| `.github/agents/<role>.agent.md` | Generated (SHA-256 tracked, safe skip if modified) | Custom Copilot agents with portable `tools:` (`read`, `search`, `edit`, `execute`, `agent`, `agent-studio/*`), `user-invocable`, `disable-model-invocation`, and runtime model IDs |
| `.github/skills/<skill>/SKILL.md` | Generated (SHA-256 tracked, safe skip if modified) | Portable workflow & domain skills (including `/learn` with `disable-model-invocation: true`) |
| `.github/copilot-instructions.md` | **Managed block merge** | Updates only `<!-- agent-studio:begin --> ... <!-- agent-studio:end -->`; preserves all existing repo Copilot instructions |
| `.mcp.json` | **Key-scoped JSON merge** | Shared with Claude Code; adds/updates only `mcpServers["agent-studio"]` (`type: "stdio"`, `tools: ["*"]`) while preserving existing user servers |
| `.github/hooks/agent-studio.json` | **Key-scoped JSON merge** | Non-destructively merges all 10 camelCase hooks (`sessionStart`, `userPromptSubmitted`, `preCompact`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `agentStop`, `sessionEnd`) with `timeoutSec: 5`, preserving user hooks |

> **Legacy Escape Hatch (`workflow.copilotHarness: "legacy-local"`):** Need legacy `.vscode/mcp.json`, `handoffs:`, `.github/prompts/learn.prompt.md`, or PascalCase hooks? Set `workflow.copilotHarness: "legacy-local"` in `.agent-team/team.yaml` and run `npx agent-studio sync`.

### Starting & Trusting `.mcp.json`
1. Open the repository in VS Code.
2. Open `.mcp.json` (or click the **Start** CodeLens above `"agent-studio"` inside `"mcpServers"`).
3. Trust the workspace MCP server when prompted so Copilot Chat agents can invoke `agent-studio/*` tools (`board`, `projects`, `testrun`, `telemetry`).

---

## 3. Using Custom Agents & Subagent Delegation

Open **GitHub Copilot Chat** (`Ctrl+Alt+I` / `Cmd+Ctrl+I`) and open the **Agent** dropdown:

- **Team Setup Agent (`team-setup.agent.md`):** (`user-invocable: true`) Inspects the workspace stack, interviews you on specialist roles & test commands, edits `.agent-team/team.yaml`, and runs `npx agent-studio sync` + `npx agent-studio doctor`.
- **Team Orchestrator (`orchestrator.agent.md`):** (`user-invocable: true`)
  - Strictly read-only (`orchestratorReadOnly: true` strips `edit` and `execute` from `tools:`).
  - Delegates work directly to specialist subagents (`architect`, `ux-designer`, `backend-engineer`, `frontend-engineer`, `code-reviewer`, `qa-validator`) via the `agent` tool, while keeping specialists `user-invocable: false` in the top-level dropdown unless explicitly overridden in `team.yaml`.
- **Manual `/learn` Skill (`.github/skills/learn/SKILL.md`):** Marked `disable-model-invocation: true` with `argument-hint: "[optional focus]"` so `/learn` runs on demand without triggering automatically.

---

## 4. Managed Instructions, Hooks & Guardrails

- **`.github/copilot-instructions.md`:** Your custom coding guidelines above or below `<!-- agent-studio:begin --> ... <!-- agent-studio:end -->` are never touched by `sync` and never trigger false drift.
- **`.github/hooks/agent-studio.json`:**
  - `preToolUse` runs `npx agent-studio hook-emit --ide copilot-vscode --event preToolUse`, blocking direct edits to `pipeline/board.json` via `{ permissionDecision: "deny", permissionDecisionReason }` (`exitCode: 0`) and directing agents to the `agent-studio` MCP `board` tool.
  - Advisory events (`sessionStart`, `postToolUse`, `postToolUseFailure`, `subagentStart`) surface context advisories via `{ additionalContext }`, while `preCompact` and `userPromptSubmitted` push telemetry silently (`200ms` timeout, falling back to `.agent-studio/telemetry.jsonl`).

---

## 5. Live Monitoring & Hybrid Storage Discovery

Start the unified Web Studio:

```bash
npx agent-studio serve --open
# Or expose on LAN / Tailscale:
npx agent-studio serve --host 0.0.0.0 --port 8767
```

### Hybrid Ingestion for VS Code Copilot & Copilot CLI
1. **Passive `chatSessions` & `$COPILOT_HOME/session-state` Adapter:** `CopilotVSCodeAdapter` scans VS Code `workspaceStorage/<hash>/chatSessions/*.{json,jsonl}` (Stable, Insiders, VSCodium), `GitHub.copilot-chat/transcripts/*.jsonl`, **and** workspace-scoped `$COPILOT_HOME/session-state/*/events.jsonl` (deduped by `sessionId`), normalizing inclusive prompt tokens, `selectedModel.metadata.maxInputTokens`, `thinking`, `textEditGroup`, `ask_user`, and `task` subagents.
2. **Active Hook + MCP Fallback:** Over SSH/WSL/Dev Containers or before `.jsonl` flushes, `.github/hooks/agent-studio.json` and `agent-studio mcp` stream live events into Live Studio via `/api/ingest` and `.agent-studio/telemetry.jsonl`.

---

## 6. Copy-Pasteable Copilot Chat Prompts

- **With `Team Setup Agent` selected:**
  > `Inspect this repository's stack and scripts, update .agent-team/team.yaml with our real lint/test checkpoints, run npx agent-studio sync, and verify everything passes with npx agent-studio doctor.`
- **With `Team Orchestrator` selected:**
  > `Check the agent-studio board status and next unblocked item, move it to dev, and delegate it to the right specialist.`
- **Verify zero drift from VS Code terminal:**
  > `npx agent-studio sync --check && npx agent-studio doctor`

---

## 7. VS Code / Copilot Troubleshooting

| Issue | Likely Cause | Fix |
| :--- | :--- | :--- |
| `agent-studio` MCP tools don't show up in Copilot Chat | MCP server stopped or not trusted | Open `.mcp.json`, click **Start** / **Restart** above `"agent-studio"` under `"mcpServers"`, and confirm `node >= 20` is on your `PATH`. |
| Doctor reports migration warnings (`.vscode/mcp.json`, `learn.prompt.md`, PascalCase hooks, `(copilot)` model IDs) | Repository was compiled under an older Agent Studio release | Run `npx agent-studio upgrade` (plus `npx agent-studio upgrade --global` for legacy `<VSCodeUserDir>/prompts/*` files). |
| Custom agents (`Team Orchestrator`, etc.) missing from dropdown | Workspace not reloaded or old VS Code Copilot Chat version | Update the GitHub Copilot Chat extension, confirm `.github/agents/*.agent.md` exists, and run **Developer: Reload Window**. |
| VS Code or Copilot CLI sessions don't appear in Live Studio | Custom `workspaceStorage` or `COPILOT_HOME` path | Pass `--vscode-dir <path>` or set `VSCODE_STORAGE_DIR` / `COPILOT_HOME` before starting `agent-studio serve`. |
| `sync` skipped a customized `.github/agents/*.agent.md` file | File was hand-edited on disk (SHA-256 marker mismatch) | Move your customization into `.agent-team/agents/<role>.md` and run `npx agent-studio sync --force`. |
