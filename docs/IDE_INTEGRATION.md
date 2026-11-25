# Agent Studio — Multi-IDE Integration Playbook

`npx agent-studio sync` compiles your single canonical `.agent-team/` directory into native configurations for **Antigravity**, **Claude Code**, and **GitHub Copilot / VS Code** simultaneously.

> **Dedicated Step-by-Step Usage Guides:**
> - [Antigravity Usage Guide (`docs/guides/ANTIGRAVITY.md`)](guides/ANTIGRAVITY.md)
> - [Claude Code Usage Guide (`docs/guides/CLAUDE_CODE.md`)](guides/CLAUDE_CODE.md)
> - [GitHub Copilot / VS Code Usage Guide (`docs/guides/COPILOT_VSCODE.md`)](guides/COPILOT_VSCODE.md)

| Concern | Antigravity | Claude Code | GitHub Copilot / VS Code |
| :--- | :--- | :--- | :--- |
| **Compiled Agents** | `.agents/plugins/<id>-team/agents/<role>.md` | `.claude/agents/<role>.md` | `.github/agents/<role>.agent.md` *(with `handoffs:`)* |
| **Compiled Skills** | `.agents/plugins/<id>-team/skills/<skill>/SKILL.md` | `.claude/skills/<skill>/SKILL.md` | `.github/skills/<skill>/SKILL.md` |
| **Rules / Instructions** | `.agents/plugins/<id>-team/rules/AGENTS.md` | `CLAUDE.md` *(managed block)* | `.github/copilot-instructions.md` *(managed block)* |
| **MCP Config** | `.agents/plugins/<id>-team/mcp_config.json` | `.mcp.json` *(key-scoped merge)* | `.vscode/mcp.json` *(key-scoped merge, `"servers"`)* |
| **Telemetry & Hooks** | Passive brain JSONL + MCP events | `.claude/settings.json` (`hook-emit`) + passive JSONL | `.github/hooks/agent-studio.json` (`hook-emit`) + passive chatSessions |

---

## 1. Antigravity

### What `agent-studio sync` Generates
Under `.agents/plugins/<projectId>-team/`:
- `plugin.json` — Workspace plugin manifest with suggested prompts.
- `agents/<role>.md` — Frontmatter with `mainAgent`, `subagent`, `inheritCustomizations: true`, `inheritMcp`, and native `tools:` allowlist (`orchestrator` has no `write_file`, `edit_file`, or `run_command`).
- `skills/<skill>/SKILL.md` — Portable workflow & domain skills.
- `rules/AGENTS.md` — Workspace guardrails, roster summary, and checkpoints.
- `mcp_config.json` — Registers the `agent-studio` stdio MCP server (`npx -y agent-studio mcp`, auto-detecting the project from `cwd`).

### Enabling & Invoking
1. Run `npx agent-studio sync --ides antigravity` in your repository.
2. Reload the workspace in Antigravity so `.agents/plugins/<projectId>-team/` is picked up.
3. Start a session with the **`orchestrator`** agent (or **`team-setup`** to customize roles).

### Telemetry Discovery
- Passive adapter watches `~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl` (override with `--brain-dir <path>` or `ANTIGRAVITY_BRAIN_DIR`).
- Subagents spawned via `invoke_subagent` and messages sent via `send_message` are discovered dynamically with zero hardcoded project names.
- All MCP `board` / `testrun` mutations also append `NormalizedEvent` records to `<projectRoot>/.agent-studio/telemetry.jsonl`.

---

## 2. Claude Code

### What `agent-studio sync` Generates / Merges
- `.claude/agents/<role>.md` — Subagent definitions with explicit `tools:` allowlists (`Read`, `Glob`, `Grep`, `Agent`, `AskUserQuestion`, `mcp__agent-studio__board`, `mcp__agent-studio__projects`, `mcp__agent-studio__testrun`). `orchestrator` omits `Edit`, `Write`, `MultiEdit`, and `Bash`.
- `.claude/skills/<skill>/SKILL.md` — Native Claude Code skills.
- `CLAUDE.md` — Inserts or updates **only** the `<!-- agent-studio:begin --> ... <!-- agent-studio:end -->` block; all user-written instructions above and below remain untouched.
- `.mcp.json` — Non-destructively merges `mcpServers["agent-studio"]` while preserving any pre-existing user MCP servers.
- `.claude/settings.json` — Non-destructively merges `hooks` for `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, and `Stop` invoking:
  ```bash
  npx agent-studio hook-emit --ide claude-code --event <Event>
  ```
  Existing user settings (`permissions`, custom hooks, etc.) are preserved verbatim.

### Enabling & Invoking
1. Run `npx agent-studio sync --ides claude-code`.
2. Launch Claude Code in the repository and approve the project `.mcp.json` `agent-studio` server when prompted.
3. Invoke the coordinator via `@orchestrator` (or ask Claude to delegate via the `Agent` tool) and let it dispatch specialists (`architect`, `ux-designer`, `backend-engineer`, `frontend-engineer`, `qa-validator`).

### Telemetry & Guardrails
- **Active Hooks:** `PreToolUse` blocks raw `Edit`/`Write`/`MultiEdit`/`Bash` mutations targeting `pipeline/board.json` (exit code `2`) and pushes sub-second live events to `http://127.0.0.1:8767/api/ingest` (150ms timeout, falling back to `.agent-studio/telemetry.jsonl` with exit `0` when the Web Studio server is stopped).
- **Passive Transcripts:** `ClaudeCodeAdapter` discovers `~/.claude/projects/<encoded-cwd>/<session>.jsonl` and `subagents/agent-*.jsonl` (override with `--claude-dir <path>` or `CLAUDE_PROJECTS_DIR`), merging live hook pings with richer transcript payloads via Tier-1 (`tool_use_id`) and Tier-2 deduplication.

---

## 3. GitHub Copilot / VS Code

### What `agent-studio sync` Generates / Merges
- `.github/agents/<role>.agent.md` — Custom Copilot Chat agents with native VS Code tool allowlists (`read/readFile`, `search/*`, `edit/*`, `execute/runInTerminal`, `agent/runSubagent`, `agent-studio/*`).
  - `orchestrator.agent.md` includes native **`handoffs:`** buttons (`→ System Architect`, `→ UX Engineer & Designer`, `→ Backend Engineer`, `→ Frontend Engineer`, `→ QA Validator`) and omits all edit/terminal tools.
- `.github/skills/<skill>/SKILL.md` — Portable skills for Copilot agents.
- `.github/copilot-instructions.md` — Non-destructive managed block (`<!-- agent-studio:begin/end -->`) preserving existing repository Copilot instructions.
- `.vscode/mcp.json` — Non-destructively merges `servers["agent-studio"]` using VS Code's `"servers"` schema (`type: "stdio"`) while preserving existing user servers and `inputs`.
- `.github/hooks/agent-studio.json` — Wires `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, and `Stop` hooks invoking:
  ```bash
  npx agent-studio hook-emit --ide copilot-vscode --event <Event>
  ```

### Enabling & Invoking
1. Run `npx agent-studio sync --ides copilot-vscode`.
2. Open the repository in VS Code and trust/start the `agent-studio` MCP server in `.vscode/mcp.json` when prompted.
3. Open **GitHub Copilot Chat**, select **`Team Orchestrator`** (`orchestrator`) from the Agent dropdown, and use the built-in **Handoffs** buttons to transition work seamlessly to specialists (`Architect`, `Backend Engineer`, `Frontend Engineer`, `QA Validator`).

### Telemetry & Partial Storage Fallback
- **Passive Chat Sessions:** `CopilotVSCodeAdapter` reads VS Code `workspaceStorage/<hash>/chatSessions/*.{json,jsonl}` (supporting both legacy `.json` snapshots and modern delta-encoded `.jsonl` logs, plus `Code - Insiders`; override via `--vscode-dir <path>` or `VSCODE_STORAGE_DIR`).
- **Graceful Fallback When Session Storage Is Partial or Unavailable:** If a VS Code build changes chat session storage, runs in a remote container, or delays flushing `.jsonl` deltas, **active hooks** (`.github/hooks/agent-studio.json`) and **MCP board/telemetry events** (`agent-studio mcp`) continue streaming full live activity through `POST /api/ingest` and `.agent-studio/telemetry.jsonl` without interruption.

---

## 4. Per-Role Model Routing & Built-In Host Compatibility

Agent Studio routes models per role using `.agent-team/team.yaml` (`workflow.modelRouting`, `roster[].modelTier`, `roster[].modelPolicy`, `roster[].models`) backed by a 3-layer **Model Index (`model-index.json`)**:
- **Layer 0:** Built-in portable defaults (`fast` / `balanced` / `reasoning` role tiers and seed IDE catalogs).
- **Layer 1 (`~/.agent-studio/model-index.json`, respects `AGENT_STUDIO_HOME`):** Machine-local live catalog synced by VS Code (`vscode.lm.selectChatModels`) via `Agent Studio: Refresh Live Model Index` (`agentStudio.refreshModelIndex`).
- **Layer 2 (`.agent-team/model-index.json`):** Git-tracked workspace index used deterministically by `sync` and `sync --check` (unless `--use-global-index` is explicitly passed).

### Built-In IDE Policy Matrix
| Policy | Antigravity | Claude Code | VS Code Copilot |
| :--- | :--- | :--- | :--- |
| **`defer-to-host`** | `model: inherit` | `model: inherit` (yields to `CLAUDE_CODE_SUBAGENT_MODEL` / `/model`) | Omits `model` & `model-policy` (unlocks **Copilot Fusion / Auto**) |
| **`prefer-fallback`** *(default)* | `flash_lite` \| `flash` \| `pro` (compatible with `/swarm` & UI picker) | `haiku` \| `sonnet` \| `opus` (overridden by env/invocation/`/model`) | Ordered fallback array + `model-policy: preferred` (`handoffs[].model` omitted by default) |
| **`pinned`** | Concrete model ID or tier enum | Concrete model ID or alias | Explicit `model` + `model-policy: required` |

Manage routing from the CLI without hand-editing compiled files:
```bash
npx agent-studio models show
npx agent-studio models set-policy defer-to-host --sync
npx agent-studio models set-role architect --tier reasoning --sync
npx agent-studio models adopt --sync
```

---

## 5. Verifying Cross-IDE Health

Run `doctor` from the repository root after syncing:

```bash
npx agent-studio doctor
npx agent-studio sync --check
```

Then open the **Doctor** view in `npx agent-studio serve --open` and click **Send Test Event** to verify live SSE updates end to end.
