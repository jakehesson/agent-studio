# Agent Studio — Antigravity Usage Guide

Complete, step-by-step guide to installing, configuring, running sprints, and monitoring multi-agent sessions with **Agent Studio** in **Antigravity**.

---

## 1. Prerequisites

- **Node.js `>= 20.0.0`** (`node -v`)
- **Antigravity** installed with local workspace plugins enabled (`~/.gemini/config/plugins/` and `~/.gemini/antigravity/brain/`)

---

## 2. Installation & Setup

### Option A: Global Bootstrap (Recommended for Multi-Repo Use)
Install the global `team-setup` onboarding agent and skill once into `~/.gemini/config/plugins/agent-studio/`:

```bash
npx agent-studio init --global
```

Reload Antigravity, open **any** repository, and ask `team-setup` to onboard it.

### Option B: Direct Project Initialization
Initialize the current repository directly from your terminal:

```bash
# Compile for Antigravity only (or include claude-code,copilot-vscode)
npx agent-studio init --ides antigravity

# Non-interactive (keeps existing pipeline/board.json untouched)
npx agent-studio init --ides antigravity,claude-code,copilot-vscode --non-interactive
```

### What Gets Compiled for Antigravity
`npx agent-studio sync` generates a self-contained workspace plugin under `.agents/plugins/<projectId>-team/`:

| Generated File | Purpose |
| :--- | :--- |
| `.agents/plugins/<id>-team/plugin.json` | Antigravity plugin manifest + suggested prompts |
| `.agents/plugins/<id>-team/agents/<role>.md` | Agent prompts with native `tools:`, `mainAgent`, `subagent`, `inheritMcp` frontmatter |
| `.agents/plugins/<id>-team/skills/<skill>/SKILL.md` | Workflow & domain skills (`agile-board-workflow`, `architecture-spec`, `qa-validation`, `team-setup`) |
| `.agents/plugins/<id>-team/rules/AGENTS.md` | Always-on workspace rules, guardrails, and QA checkpoints |
| `.agents/plugins/<id>-team/mcp_config.json` | Wires the `agent-studio` stdio MCP server (`npx -y agent-studio mcp`, auto-detects project from `cwd`) |

> [!IMPORTANT]
> **Reload Workspace Plugin:** After running `init` or `sync`, reload the Antigravity workspace window so Antigravity picks up newly generated agents, skills, and `mcp_config.json`.
> **Safe Migration Tip:** If your repo already uses an older Antigravity plugin (for example `.agents/plugins/my-legacy-team/`), pass `--id <distinct-id>` during `init` so Agent Studio compiles into a separate `.agents/plugins/<distinct-id>-team/` directory without collision.

---

## 3. Tailoring Your Team with `team-setup`

Instead of hand-editing YAML, invoke **`team-setup`** in Antigravity:

> *"Use `team-setup` to inspect this repository's build/test scripts, tailor `.agent-team/team.yaml` and specialist prompts, then run `npx agent-studio sync` and `npx agent-studio doctor`."*

Remember:
- **Edit ONLY `.agent-team/`** (`team.yaml`, `agents/*.md`, `skills/*/SKILL.md`).
- **Never edit `.agents/plugins/<id>-team/*` directly** — every compiled file embeds a SHA-256 drift marker (`hash:sha256:...`). Run `npx agent-studio sync` after any edit to `.agent-team/`.

---

## 4. Running a Full Sprint with `orchestrator`

Because `workflow.enforcement.orchestratorReadOnly: true` is enabled by default, `orchestrator.md` omits `write_file`, `edit_file`, and `run_command` from its `tools:` allowlist—enforcing a strict manager/dispatcher boundary at the tool layer.

### Sprint Lifecycle (`ready -> design -> dev -> test -> done`)
1. **Plan & Triage:** `orchestrator` calls the `agent-studio` MCP `board` tool (`op: "status"` and `op: "next"`) to pick the highest-priority unblocked item (S1/S2 bugs first).
2. **Design (`ready -> design -> dev`):** `orchestrator` spawns `architect` via `invoke_subagent` to author a concise specification in `docs/` and record a board note.
3. **Implementation (`dev -> test`):** `orchestrator` dispatches `backend-engineer` and/or `frontend-engineer` via `invoke_subagent` with strict non-overlapping file scopes. Specialists run local checks, record evidence notes via MCP `board`, and report back via `send_message`.
4. **QA Gate (`test -> done`):** `orchestrator` dispatches `qa-validator`, which runs checkpoint commands (`CP0`, `CP1`, ...), records a formal MCP `testrun` (`start` → `record` → `close`), and only then transitions `test -> done` (the MCP server rejects `test -> done` without a passing testrun!).

---

## 5. Live Monitoring in Agent Studio

Start the unified single-port Web Studio:

```bash
# Localhost (auto-opens browser)
npx agent-studio serve --open

# LAN / Tailscale (access from phone, tablet, or Galaxy Z Fold 7)
npx agent-studio serve --host 0.0.0.0 --port 8767
```

### How Antigravity Telemetry Works
- **Zero-Config Passive Discovery:** `AntigravityAdapter` watches `~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl` and sibling subagent transcripts referenced by `invoke_subagent` / `send_message`.
- **Dynamic Agent Discovery:** Never hardcodes agent names—discovers the coordinator and every spawned subagent dynamically.
- **Live 6-State Machine:**
  - `THINKING` (violet pulsing halo + live timer) when a `USER_INPUT`, `SYSTEM_MESSAGE`, or `GENERIC` tool result awaits the next planner response.
  - `WORKING` (amber indicator) during active tool calls (self-daemon `serve` commands are automatically excluded).
  - `WAITING` on `ask_question` or active child subagents; `BLOCKED` on QA gate or fatal errors; `DONE` on clean turn completion (automatically resets if a new user turn resumes the session).
- **Video-Style Timeline Scrubber:** Stays pinned to `● LIVE`; drag backward or use `Space` (play/pause), `←`/`→` (step), `Home` (start), and `L` (snap back to `● LIVE`) to replay the entire agent graph at any historical event.

---

## 6. Copy-Pasteable Antigravity Prompts

- **Onboard a repository:**
  > `Use team-setup to onboard this repository to Agent Studio, configure CP0/CP1 checkpoints for our test scripts, sync all IDEs, and verify with doctor.`
- **Start or continue a sprint:**
  > `Use orchestrator to check board status, pick the next unblocked item, dispatch specialists with clear scopes, and enforce the QA gate before marking done.`
- **Run QA verification manually:**
  > `Use qa-validator to run the smoke testrun suite against items in the test stage, record all checkpoints via MCP testrun, and report pass/fail.`
- **Check config health:**
  > `Run npx agent-studio doctor --json and npx agent-studio sync --check and fix any drift.`

---

## 7. Antigravity Troubleshooting

| Issue | Likely Cause | Fix |
| :--- | :--- | :--- |
| New agents or `agent-studio` MCP tools don't appear | Workspace plugin not reloaded after `sync` | Reload the Antigravity workspace window; confirm `.agents/plugins/<id>-team/plugin.json` and `mcp_config.json` exist. |
| Sessions don't appear in Live Studio | Custom Antigravity brain directory | Pass `--brain-dir <path>` to `agent-studio serve` or set `ANTIGRAVITY_BRAIN_DIR=<path>`. |
| `sync --check` reports `modified` on `.agents/plugins/...` | Compiled file was edited directly | Move your edit into `.agent-team/` and re-run `npx agent-studio sync`. |
| `board move ... done` fails with `QA_GATE_REJECTED` | No closed, passing `testrun` covers the item | Dispatch `qa-validator` (or run `npx agent-studio testrun start/record/close`) before moving to `done`. |
| `doctor` reports `manifestValid: false` | Syntax/schema error in `.agent-team/team.yaml` | Inspect the Zod error printed by `npx agent-studio doctor` and fix `.agent-team/team.yaml`. |
