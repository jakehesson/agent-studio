# Agent Studio — Day-to-Day Usage & Workflow Guide

This guide covers running a full multi-agent sprint workflow with **Agent Studio**, enforcing the three-layer QA Gate, operating the unified Web Studio, and migrating existing `AgentVisualizer` / `agile-modkit` projects without data loss.

---

## 1. The Multi-Agent Sprint Lifecycle

Every project tracks work in `pipeline/board.json` through five canonical stages:

```text
ready  ──▶  design  ──▶  dev  ──▶  test  ──▶  done
              │           │          │          ▲
          Architect   Engineers   QA Validator  │ (MCP QA Gate: requires closed,
          (specs)     (code+unit) (testruns)    │  passing testrun!)
```

### Default Team Blueprint (+ Setup Agent)

| Role ID | Board Role | Purpose | Capabilities |
| :--- | :--- | :--- | :--- |
| `orchestrator` | `orchestrator` | Sprint manager & dispatcher (**strictly read-only**) | `read`, `search`, `delegate`, `ask_user`, `mcp_board` |
| `architect` | `design` | Architecture specs, schemas, API contracts (`docs/`) | `read`, `search`, `write_docs`, `mcp_board` |
| `ux-designer` | `ux` | Usability engineering, layout/overflow audits, WCAG AA accessibility & Galaxy Z Fold 7 three-tier ergonomics partnering with `frontend-engineer` | `read`, `search`, `write_docs`, `mcp_board` |
| `backend-engineer` | `backend` | Server, CLI, data layer, and backend unit tests | `read`, `search`, `edit`, `shell`, `mcp_board` |
| `frontend-engineer` | `frontend` | Web UI, visualizations, responsive CSS | `read`, `search`, `edit`, `shell`, `mcp_board` |
| `qa-validator` | `qa` | Test suites, formal MCP `testrun` verification, bug filing | `read`, `search`, `edit_tests`, `shell`, `mcp_board`, `mcp_testrun` |
| `team-setup` | `ops` | Repo analysis, `.agent-team/` tailoring, `sync` & `doctor` | `read`, `search`, `edit`, `shell`, `ask_user` |

---

## 2. Running the Orchestrator Dispatch Loop

Start any work session in **Antigravity**, **Claude Code**, or **VS Code Copilot** by invoking the `orchestrator` agent:

1. **Inspect sprint status:** `orchestrator` calls MCP `board { op: "status" }` and `board { op: "next" }` (S1/S2 bugs are prioritized before new stories/tasks).
2. **Assign & dispatch:** `orchestrator` moves the item to `design` or `dev`, sets its owner, and dispatches the specialist with a compact scope brief:
   ```text
   PROJECT <id> | ITEM <S1-XX> | SCOPE <exclusive file list> | ACCEPTANCE <criteria>
   ```
   When dispatching engineers in parallel, `orchestrator` enforces **non-overlapping write scopes**.
3. **Implementation handoff (`dev -> test`):** Specialists run local checks, record an evidence note via `board { op: "note" }`, and move the item to `test`.
4. **QA verification (`test -> done`):** `orchestrator` dispatches `qa-validator`, which:
   - Starts a testrun: `testrun { op: "start", suite: "smoke", items: ["S1-XX"] }`
   - Executes each checkpoint defined in `.agent-team/team.yaml` (`CP0`, `CP1`, `CP2`)
   - Records checkpoint outcomes: `testrun { op: "record", runId, checkpoint: "CP0", result: "pass", note: "..." }`
   - Closes the testrun: `testrun { op: "close", runId }`
   - Moves the item to `done` on pass, or files a bug (`board { op: "add", type: "bug" }`) and returns the item to `dev` on failure.

---

## 3. Defense-in-Depth QA Gate & Guardrails

Agent Studio enforces process discipline at three independent layers so no single IDE client quirk can bypass it:

1. **Layer 1 — IDE Tool Allowlists:** Compiled agent frontmatter strips edit/write/shell tools from `orchestrator` when `workflow.enforcement.orchestratorReadOnly: true` is set in `.agent-team/team.yaml`.
2. **Layer 2 — `PreToolUse` Guardrail Hooks:** In Claude Code (`.claude/settings.json`) and VS Code Copilot (`.github/hooks/agent-studio.json`), `npx agent-studio hook-emit --ide <ide> --event PreToolUse` inspects tool inputs and blocks direct edits to `pipeline/board.json` with exit code `2` and an actionable deny message directing the agent to use the `agent-studio` MCP `board` tool.
3. **Layer 3 — MCP Server QA Gate:** `agent-studio mcp` acquires an atomic lockfile (`board.json.lock` with stale-lock recovery) on every mutation and rejects `board { op: "move", state: "done" }` unless a closed, passing `testrun` covers the item's required suite (or an explicit `overrideReason` is logged for auditability).

### CLI Board & Testrun Quick Reference

You can also inspect or operate the board directly from any terminal:

```bash
# Inspect active sprint & next unblocked items
npx agent-studio board status
npx agent-studio board next

# Add a task or bug
npx agent-studio board add --type task --title "Add export endpoint" --role backend
npx agent-studio board add --type bug --title "SSE reconnect stalls" --role backend --severity S1

# Record a testrun and check the release gate
npx agent-studio testrun start smoke --items S1-01
npx agent-studio testrun record TR-1 CP0 pass --note "All 42 unit tests pass"
npx agent-studio testrun close TR-1
npx agent-studio board move S1-01 done --actor qa
npx agent-studio board gate
```

---

## 4. Operating the Unified Web Studio

Launch the single-port Web Studio:

```bash
npx agent-studio serve --open
# Or bind all interfaces for phone / foldable / Tailscale access:
npx agent-studio serve --host 0.0.0.0 --port 8767
```

### Top Context Bar
- **Project Switcher:** Switch between all workspaces registered in `~/.agent-studio/projects.json`.
- **IDE Filter:** Filter sessions across `All`, `Antigravity`, `Claude Code`, and `VS Code`.
- **Session Picker:** Pick any recent multi-agent or single-agent session; active `THINKING` / `WORKING` / `WAITING` / `BLOCKED` status badges update live via SSE (`/api/stream`).

### Live Studio & Timeline Scrubber
- **Topology Mesh:** Auto-arranged non-overlapping SVG graph of coordinator, subagents, human, and external tool nodes (`ext:board`, `ext:fs`, `ext:shell`, `ext:web`, `ext:mcp:*`) with IDE badges and animated edge packets.
- **Video-Style Timeline Scrubber:**
  - Stays pinned to `● LIVE` as new SSE frames arrive.
  - Drag or step backward to rewind into `↺ LIVE (-N)` mode; the entire topology graph, agent states, counters, and event stream reconstruct deterministically at the scrubbed event.
  - Playback speed selector (`1×`, `2×`, `4×`) and color-coded event tick marks.
- **Keyboard Shortcuts (Desktop):**
  - `Space` — Play / pause timeline replay
  - `←` / `→` — Step backward / forward one event
  - `Home` — Jump to first event in session
  - `L` — Snap back to `● LIVE` tail

### Agile Board, Mockups & Doctor Views
- **Agile Board:** Live 5-column Kanban (`ready` → `done`), open bugs sorted by severity, item detail drawer, and checkpoint matrix across recent testruns.
- **Mockups:** Automatically discovers HTML files in `mockupsDirs` (default `docs/mockups`), renders them in a sandboxed preview iframe, and appends timestamped review notes directly to sibling `FEEDBACK.md` files via `POST /api/feedback`.
- **Doctor:** Displays live health cards for Antigravity, Claude Code, and VS Code (installation, drift, MCP, hooks) and provides a **"Send Test Event"** button (`POST /api/doctor/test-event`) to verify end-to-end PushBus → SSE delivery in one click.

---

## 5. Zero-Loss Migration from Existing `AgentVisualizer` / `agile-modkit` Projects

If your repository already has a `pipeline/board.json` (and optionally a legacy `project.json` or `.agents/plugins/<legacy>-team/` plugin):

1. **Preserve your board automatically:** Running `npx agent-studio init` detects an existing `pipeline/board.json` and leaves it **100% untouched** (never overwriting items, sprints, bugs, or testruns).
2. **Avoid plugin directory collisions during cutover:** If you want to keep an existing Antigravity plugin (e.g. `.agents/plugins/my-legacy-team/`) active while testing Agent Studio, pass `--id <new-id>` (for example `npx agent-studio init --id my-app-studio`) so compiled Antigravity files land in `.agents/plugins/my-app-studio-team/`.
3. **Import checkpoints:** Copy your existing `project.json` checkpoint commands (`CP0`, `CP1`, `CP2`) into `.agent-team/team.yaml` under `workflow.checkpoints` and run `npx agent-studio sync`.
4. **Verify health:** Run `npx agent-studio doctor` and `npx agent-studio board status` to confirm your legacy items, testruns, and QA gates are read cleanly by the new engine.
