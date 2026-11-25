# Agent Studio — Claude Code Usage Guide

Complete, step-by-step guide to setting up, running multi-agent sprints, enforcing hooks, and monitoring live sessions with **Agent Studio** in **Claude Code**.

---

## 1. Prerequisites

- **Node.js `>= 20.0.0`** (`node -v`)
- **Claude Code CLI** installed (`claude --version`)

---

## 2. Installation & Setup

### Option A: Global Bootstrap (Use `@team-setup` in Any Repo)
Install the global `team-setup` subagent and skill into `~/.claude/agents/team-setup.md` and `~/.claude/skills/team-setup/SKILL.md`:

```bash
npx agent-studio init --global
```

### Option B: Project Initialization
Initialize the current repository and compile Claude Code native configs:

```bash
# Compile for Claude Code (or include antigravity,copilot-vscode)
npx agent-studio init --ides claude-code

# Non-interactive multi-IDE bootstrap (preserves existing pipeline/board.json)
npx agent-studio init --ides antigravity,claude-code,copilot-vscode --non-interactive
```

### What Gets Compiled / Merged for Claude Code
`npx agent-studio sync` emits and non-destructively merges:

| Target File | Strategy | Purpose |
| :--- | :--- | :--- |
| `.claude/agents/<role>.md` | Generated (SHA-256 tracked) | Subagents (`orchestrator`, `architect`, `ux-designer`, `backend-engineer`, `frontend-engineer`, `qa-validator`, `team-setup`) with explicit `tools:` allowlists |
| `.claude/skills/<skill>/SKILL.md` | Generated (SHA-256 tracked) | Reusable workflow skills |
| `CLAUDE.md` | **Managed block merge** | Updates only `<!-- agent-studio:begin --> ... <!-- agent-studio:end -->`; preserves all user instructions above and below |
| `.mcp.json` | **Key-scoped JSON merge** | Adds/updates only `mcpServers["agent-studio"]`; preserves all existing user MCP servers |
| `.claude/settings.json` | **Key-scoped JSON merge** | Merges `agent-studio hook-emit` hooks for `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`; preserves existing user permissions and hooks |

### Approving the Project MCP Server
On first launch of `claude` inside the repository, Claude Code prompts you to approve the project-scoped `.mcp.json` server (`agent-studio`). Approve it so agents can call `mcp__agent-studio__board`, `mcp__agent-studio__projects`, `mcp__agent-studio__testrun`, and `mcp__agent-studio__telemetry`.

---

## 3. Using `@team-setup` & `@orchestrator`

### Onboarding / Customizing with `@team-setup`
In Claude Code chat, invoke `@team-setup` to inspect your repository stack, tailor `.agent-team/team.yaml` and role prompts, recompile with `npx agent-studio sync`, and verify with `npx agent-studio doctor`.

### Running Sprints with `@orchestrator` + `Agent` Subagents
Invoke `@orchestrator` to manage your sprint backlog:
- **Read-Only Tool Allowlist:** With `orchestratorReadOnly: true`, `.claude/agents/orchestrator.md` allows only `Read`, `Glob`, `Grep`, `Agent`, `AskUserQuestion`, `mcp__agent-studio__board`, and `mcp__agent-studio__projects`—strictly omitting `Edit`, `Write`, `MultiEdit`, and `Bash`.
- **Subagent Delegation:** `@orchestrator` delegates design, UX audits, implementation, and QA via Claude Code's `Agent` tool to `architect`, `ux-designer`, `backend-engineer`, `frontend-engineer`, and `qa-validator`.
- **QA Gate:** `qa-validator` has `mcp__agent-studio__testrun` in its allowlist to record checkpoints (`start` → `record` → `close`) before `test -> done` is permitted by the MCP server.

---

## 4. Hooks & `PreToolUse` Board Protection

Every Claude Code hook in `.claude/settings.json` invokes:

```bash
npx agent-studio hook-emit --ide claude-code --event <PreToolUse|PostToolUse|SubagentStart|SubagentStop|Stop>
```

- **Direct `board.json` Edit Guardrail (`PreToolUse`):** If any agent tries to `Edit`, `Write`, `MultiEdit`, or `Bash`-overwrite `pipeline/board.json` directly, `hook-emit` returns structured `permissionDecision: "deny"` JSON on stdout and exits with code **`2`** (hard block), instructing the agent to use the `agent-studio` MCP `board` tool instead.
- **Fast Offline Resilience (`< 200ms`):** For all normal events, `hook-emit` POSTs to `http://127.0.0.1:8767/api/ingest` with a `150ms` timeout. If `agent-studio serve` is not running, it appends a single NDJSON line to `.agent-studio/telemetry.jsonl` and exits `0` immediately—never blocking or slowing down Claude Code.

---

## 5. Live Monitoring & Dual-Channel Deduplication

Start the unified Web Studio:

```bash
npx agent-studio serve --open
# Or expose on LAN / Tailscale:
npx agent-studio serve --host 0.0.0.0 --port 8767
```

Claude Code feeds Agent Studio through **two synchronized channels**:
1. **Active Hooks (`< 50ms` live responsiveness):** `.claude/settings.json` hooks stream real-time `tool_start`, `tool_end`, `subagent_spawn`, `subagent_done`, and `assistant_turn_end` events immediately via `/api/ingest`.
2. **Passive Transcript Adapter:** `ClaudeCodeAdapter` discovers `~/.claude/projects/<encoded-cwd>/<session>.jsonl` plus `subagents/agent-*.jsonl` (ignoring `cost-state`/`api-request-blob` noise) and enriches every event with full tool args, thinking blocks, and subagent hierarchy.
3. **Automatic Deduplication:** Paired hook + passive events sharing `tool_use_id` (Tier-1) or matching within a 2-second bucket (Tier-2) merge cleanly into one event—combining instant live status with full timeline scrub fidelity.

---

## 6. Copy-Pasteable Claude Code Prompts

- **Onboard or customize a project:**
  > `@team-setup Inspect this repo, configure .agent-team/team.yaml with our real test commands, run npx agent-studio sync, and verify with npx agent-studio doctor.`
- **Run the next sprint item end-to-end:**
  > `@orchestrator Check board status, select the next unblocked item, dispatch the appropriate engineer subagent with a strict write scope, then dispatch qa-validator to run checkpoints and close the testrun.`
- **Verify zero drift before committing:**
  > `Run npx agent-studio sync --check && npx agent-studio doctor`
- **File a bug properly via MCP:**
  > `@qa-validator File an S1 bug on the agent-studio board with reproduction steps and move the failing item back to dev.`

---

## 7. Claude Code Troubleshooting

| Issue | Likely Cause | Fix |
| :--- | :--- | :--- |
| `mcp__agent-studio__*` tools unavailable | Project `.mcp.json` server not yet approved | Restart `claude` in the repo root and approve the `agent-studio` MCP server prompt; verify `.mcp.json` contains `mcpServers["agent-studio"]`. |
| `PreToolUse` hook blocked an edit with exit code `2` | An agent tried to edit `pipeline/board.json` directly | This is the guardrail working as intended—instruct the agent to use `mcp__agent-studio__board` instead. |
| Sessions don't appear in Live Studio | Custom Claude projects directory | Pass `--claude-dir <path>` to `agent-studio serve` or set `CLAUDE_PROJECTS_DIR=<path>`. |
| Custom user instructions in `CLAUDE.md` or user hooks in `.claude/settings.json` | Worried `sync` will overwrite them | Safe by design: `sync` touches only the `<!-- agent-studio:begin/end -->` block and `agent-studio hook-emit` entries. Confirm with `npx agent-studio sync --check`. |
| `doctor` reports missing hook events | `.claude/settings.json` edited manually or out of sync | Run `npx agent-studio sync` to merge missing hook entries non-destructively. |
