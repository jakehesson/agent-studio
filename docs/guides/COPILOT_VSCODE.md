# Agent Studio — GitHub Copilot / VS Code Usage Guide

Complete, step-by-step guide to setting up custom Copilot Chat agents with native handoff buttons, wiring VS Code MCP & hooks, and monitoring live sessions with **Agent Studio** in **Visual Studio Code**.

---

## 1. Prerequisites

- **Node.js `>= 20.0.0`** (`node -v`)
- **Visual Studio Code** (Stable or Insiders) with **GitHub Copilot Chat** enabled

---

## 2. Installation & Setup

### Option A: Global Bootstrap (Use `Team Setup Agent` in Any Workspace)
Install the global `team-setup.agent.md` and `team-setup.instructions.md` into your VS Code User `prompts/` directory:

```bash
npx agent-studio init --global
```

- Windows: `%APPDATA%\Code\User\prompts\`
- macOS: `~/Library/Application Support/Code/User/prompts/`
- Linux: `~/.config/Code/User/prompts/`

### Option B: Project Initialization
Initialize the current repository and compile VS Code / GitHub Copilot artifacts:

```bash
# Compile for GitHub Copilot / VS Code (or include antigravity,claude-code)
npx agent-studio init --ides copilot-vscode

# Non-interactive multi-IDE bootstrap (preserves existing pipeline/board.json)
npx agent-studio init --ides antigravity,claude-code,copilot-vscode --non-interactive
```

### What Gets Compiled / Merged for GitHub Copilot / VS Code
`npx agent-studio sync` emits and non-destructively merges:

| Target File | Strategy | Purpose |
| :--- | :--- | :--- |
| `.github/agents/<role>.agent.md` | Generated (SHA-256 tracked) | Custom Copilot Chat agents with native VS Code `tools:` allowlists and `handoffs:` buttons |
| `.github/skills/<skill>/SKILL.md` | Generated (SHA-256 tracked) | Portable workflow & domain skills |
| `.github/copilot-instructions.md` | **Managed block merge** | Updates only `<!-- agent-studio:begin --> ... <!-- agent-studio:end -->`; preserves all existing repo Copilot instructions |
| `.vscode/mcp.json` | **Key-scoped JSON merge** | Adds/updates only `servers["agent-studio"]` (`type: "stdio"`); preserves existing user `servers` and `inputs` |
| `.github/hooks/agent-studio.json` | Generated | Wires `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, and `Stop` hooks to `npx agent-studio hook-emit --ide copilot-vscode --event <E>` |

### Starting & Trusting `.vscode/mcp.json`
1. Open the repository in VS Code.
2. Open `.vscode/mcp.json` (or click the **Start** CodeLens above `"agent-studio"` inside `"servers"`).
3. Trust the workspace MCP server when prompted so Copilot Chat agents can invoke `agent-studio/*` tools (`board`, `projects`, `testrun`, `telemetry`).

---

## 3. Using Custom Agents & Native `handoffs:` Buttons

Open **GitHub Copilot Chat** (`Ctrl+Alt+I` / `Cmd+Ctrl+I`) and open the **Agent** dropdown:

- **Team Setup Agent (`team-setup.agent.md`):** Inspects the workspace stack, interviews you on specialist roles & test commands, edits `.agent-team/team.yaml`, and runs `npx agent-studio sync` + `npx agent-studio doctor`.
- **Team Orchestrator (`orchestrator.agent.md`):**
  - Strictly read-only (`orchestratorReadOnly: true` strips `edit/editFiles`, `edit/createFile`, and `execute/runInTerminal` from `tools:`).
  - Includes native **`handoffs:`** transition buttons at the bottom of its response:
    - **Delegate to System Architect** (`architect`)
    - **Delegate to UX Engineer & Designer** (`ux-designer`)
    - **Delegate to Backend Engineer** (`backend-engineer`)
    - **Delegate to Frontend Engineer** (`frontend-engineer`)
    - **Delegate to QA Validator** (`qa-validator`)
  - Click any handoff button to switch directly to that specialist with pre-filled context, or let `orchestrator` invoke subagents via `agent/runSubagent`.

---

## 4. Managed Instructions, Hooks & Guardrails

- **`.github/copilot-instructions.md`:** Your custom coding guidelines above or below `<!-- agent-studio:begin --> ... <!-- agent-studio:end -->` are never touched by `sync` and never trigger false drift.
- **`.github/hooks/agent-studio.json`:**
  - `PreToolUse` runs `npx agent-studio hook-emit --ide copilot-vscode --event PreToolUse`, blocking direct edits to `pipeline/board.json` (`permissionDecision: "deny"`, exit code `2`) and directing agents to the `agent-studio` MCP `board` tool.
  - All 5 hook events push live activity to `http://127.0.0.1:8767/api/ingest` (150ms timeout) and fall back silently to `.agent-studio/telemetry.jsonl` (`exit 0`) whenever the Web Studio server is offline.

---

## 5. Live Monitoring & Graceful Partial-Storage Fallback

Start the unified Web Studio:

```bash
npx agent-studio serve --open
# Or expose on LAN / Tailscale:
npx agent-studio serve --host 0.0.0.0 --port 8767
```

### Hybrid Ingestion for VS Code Copilot
1. **Passive `chatSessions` Adapter:** `CopilotVSCodeAdapter` scans VS Code `workspaceStorage/<hash>/chatSessions/*.{json,jsonl}` (both Stable and **VS Code Insiders**), decoding `workspace.json` folder URIs and supporting both legacy `.json` snapshots and modern delta-encoded `.jsonl` logs (`kind: 0/1/2`), `thinking`, `toolInvocationSerialized`, `elicitationSerialized`, and custom agent attribution (`modeInfo.modeName`).
2. **Active Hook + MCP Fallback:** If a VS Code update changes internal storage layout, runs over SSH/WSL/Dev Containers where local `workspaceStorage` is partial, or delays flushing `.jsonl` deltas, `.github/hooks/agent-studio.json` and `agent-studio mcp` continue streaming full real-time events into Live Studio via `/api/ingest` and `.agent-studio/telemetry.jsonl`.

---

## 6. Copy-Pasteable Copilot Chat Prompts

- **With `Team Setup Agent` selected:**
  > `Inspect this repository's stack and scripts, update .agent-team/team.yaml with our real lint/test checkpoints, run npx agent-studio sync, and verify everything passes with npx agent-studio doctor.`
- **With `Team Orchestrator` selected:**
  > `Check the agent-studio board status and next unblocked item, move it to dev, and prepare a handoff brief for the right specialist.`
- **With `QA Validator` selected:**
  > `Start a smoke testrun via the agent-studio MCP server, run all configured checkpoints, record each result, close the testrun, and move passing items from test to done.`
- **Verify zero drift from VS Code terminal:**
  > `npx agent-studio sync --check && npx agent-studio doctor`

---

## 7. VS Code / Copilot Troubleshooting

| Issue | Likely Cause | Fix |
| :--- | :--- | :--- |
| `agent-studio` MCP tools don't show up in Copilot Chat | MCP server stopped or not trusted | Open `.vscode/mcp.json`, click **Start** / **Restart** above `"agent-studio"`, and confirm `node >= 20` is on your `PATH`. |
| Custom agents (`Team Orchestrator`, etc.) missing from dropdown | Workspace not reloaded or old VS Code Copilot Chat version | Update the GitHub Copilot Chat extension, confirm `.github/agents/*.agent.md` exists, and run **Developer: Reload Window**. |
| VS Code sessions don't appear in Live Studio | Custom/Insiders/Portable `workspaceStorage` path | Pass `--vscode-dir <path>` to `agent-studio serve` or set `VSCODE_STORAGE_DIR=<path>`. |
| Remote SSH / WSL / Dev Container session missing passive logs | `workspaceStorage` lives on remote/client boundary | Ensure `.github/hooks/agent-studio.json` is active and check the **Doctor** view (**Send Test Event**) to confirm PushBus/SSE delivery. |
| `sync --check` fails on `.vscode/mcp.json` | `"agent-studio"` entry was altered or removed | Run `npx agent-studio sync` (your other user `"servers"` and `"inputs"` are preserved automatically). |
