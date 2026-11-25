# Multi-IDE Telemetry, Hook Bus & State Machine Specification

> **Document Target:** `docs/TELEMETRY_SPEC.md`
> **Scope:** Canonical telemetry specification for `src/schema/`, `src/telemetry/`, `src/cli/hook-emit.ts`, `src/mcp/`, and `src/server/`
> **Validation:** Verified against `agent_visualizer.py` (Antigravity), `~/.claude/projects/**/*.jsonl` (Claude Code), and VS Code `workspaceStorage/*/chatSessions/*.{json,jsonl}` (VS Code Copilot — both legacy `.json` snapshots and modern delta-encoded `.jsonl`).

---

## 0. Canonical TypeScript Contracts (`src/schema/telemetry.ts`)

All passive file adapters, IDE hook bridges, and MCP emitters normalize into a single discriminated event schema (`NormalizedEvent`) and fold into a backward-compatible `SessionSnapshot`.

```ts
export type IdeSource = "antigravity" | "claude-code" | "copilot-vscode" | "mcp" | "unknown";
export type TelemetryChannel = "passive" | "hook" | "mcp";
export type AgentStatus = "THINKING" | "WORKING" | "WAITING" | "BLOCKED" | "DONE" | "IDLE";
export type LegacyAgentState = "thinking" | "working" | "waiting" | "blocker" | "done" | "idle";
export type NodeType = "agent" | "human" | "external";

export type NormalizedEventKind =
  | "session_start"
  | "user_input"
  | "thinking_start"
  | "tool_start"
  | "tool_end"
  | "subagent_spawn"
  | "subagent_done"
  | "message"
  | "board_mutation"
  | "assistant_turn_end";

export interface NormalizedEvent {
  id: string;                      // Deterministic 16-char hex SHA-256 (see §3.1)
  mergeKey?: string;               // Cross-channel dedupe key (see §3.2)
  ts: string;                      // ISO-8601 UTC timestamp
  epoch: number;                   // Unix seconds (float); REQUIRED for timeline scrubbing
  ide: IdeSource;
  channel: TelemetryChannel;
  sessionId: string;               // Root conversation/session UUID
  workspacePath?: string;          // Normalized forward-slash workspace path
  projectId?: string;              // Matched DevOps board / registry project ID
  agentId: string;                 // "root" or subagent UUID/slug
  agentLabel?: string;             // Human-friendly display name
  parentAgentId?: string;          // Enables arbitrary delegation trees
  kind: NormalizedEventKind;
  toolName?: string;
  toolCallId?: string;             // Native call ID for Tier-1 deduplication
  targetAgentId?: string;          // Message/handoff/external target node ID
  summary: string;
  payload?: Record<string, unknown>;
}
```

### 0.1 External Node Taxonomy

To keep the topology mesh uncluttered and project-agnostic across all three IDEs, external integrations are classified into normalized `external` nodes (`nodeType: "external"`) rather than hardcoded project names:

| External Node ID | Display Label | Matched Tools / Triggers |
| :--- | :--- | :--- |
| `ext:human` | User (`nodeType: "human"`) | `user_input`, `ask_question`, `AskUserQuestion`, `vscode_askQuestions`, `elicitationSerialized` |
| `ext:board` | Agile Board MCP | `mcp__agent-studio__board`, `mcp__agent-studio__testrun`, `board`, `testrun`, `agile-modkit` |
| `ext:shell` | Local Shell / Terminal | `run_command`, `Bash`, `run_in_terminal`, `send_to_terminal`, `get_terminal_output` |
| `ext:fs` | Workspace Filesystem | `read_file`, `write_file`, `edit_file`, `Read`, `Edit`, `Write`, `MultiEdit`, `Glob`, `Grep`, `copilot_readFile`, `copilot_applyPatch`, `copilot_createFile`, `copilot_findFiles` |
| `ext:web` | Web / Browser / Docs | `fetch`, `copilot_fetchWebPage`, `vscode_fetchWebPage_internal`, `chrome-devtools`, `gemini_search_docs` |
| `ext:mcp:<server>` | MCP Server (`<server>`) | Any other `mcp__<server>__*`, `mcp_<server>_*`, or `call_mcp_tool(ServerName=<server>)` |

---

## 1. Passive Native File Adapters

Each passive adapter implements a common `PassiveIdeAdapter` interface:

```ts
export interface DiscoveredSession {
  ide: IdeSource;
  sessionId: string;
  filePath: string;
  workspacePath?: string;
  projectId?: string;
  title?: string;
  mtimeMs: number;
  sizeBytes: number;
  isMultiAgent: boolean;
}

export interface PassiveIdeAdapter {
  readonly ide: IdeSource;
  discoverSessions(opts?: { limit?: number; workspaceRoots?: string[] }): Promise<DiscoveredSession[]>;
  parseSession(session: DiscoveredSession): Promise<NormalizedEvent[]>;
}
```

### 1.1 Antigravity Adapter (`src/telemetry/adapters/antigravity.ts`)

- **Discovery Path:** `~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl` (overrideable via `ANTIGRAVITY_BRAIN_DIR` or `--brain-dir`).
- **Session Metadata:**
  - Root session UUID is the `<uuid>` directory name.
  - Subagent transcripts live under sibling `<subagent-uuid>/.system_generated/logs/transcript.jsonl` referenced by `invoke_subagent` / `send_message` (`Recipient`, `ConversationId`) in the parent transcript.
  - Workspace & project detection is strictly project-agnostic: scan `USER_INPUT`, `SYSTEM_MESSAGE`, `read_file`/`edit_file`/`write_file` `Path` args, and `run_command` cwd paths; match longest registered project root first (never reverse-prefix a parent directory against a sibling child project).
- **JSONL Line Schema & Mapping:**
  - Row fields: `step_index`, `source`, `type` (`USER_INPUT` | `SYSTEM_MESSAGE` | `PLANNER_RESPONSE` | `GENERIC`), `status`, `created_at`, `model`, `content`, `tool_calls` (or `calls`), `input_tokens`, `output_tokens`.
  - **Unquoting Rule:** Antigravity `tool_calls[].args` strings may carry escaped quotes or JSON-encoded strings; unwrap outer quotes cleanly without mutating inner payloads.
  - **Event Normalization:**
    - `USER_INPUT` → `kind: "user_input"`, `agentId: "root"`, `targetAgentId: "root"`.
    - `PLANNER_RESPONSE` with `tool_calls`:
      - `invoke_subagent` → `kind: "subagent_spawn"` (`parentAgentId: currentAgentId`, `targetAgentId: subagentId`, `agentLabel` from `Name`/`Role`).
      - `send_message` → `kind: "message"` (`agentId: currentAgentId`, `targetAgentId: Recipient`, `summary` clipped from `Message`).
      - `ask_question` → `kind: "tool_start"` (`toolName: "ask_question"`, triggers `WAITING` on human until response).
      - Other tools → `kind: "tool_start"` (with `toolCallId` synthesized from `step_index + toolIndex + name`).
    - Following `GENERIC` step (tool result) → `kind: "tool_end"` matching prior `tool_start`.
    - `PLANNER_RESPONSE` with non-empty `content` and empty `tool_calls` → `kind: "assistant_turn_end"` (or `kind: "subagent_done"` for subagents).
    - **Self-Daemon Exclusion:** `run_command` calls launching `agent_visualizer.py`, `board_dashboard.py`, or `agent-studio serve` (or flagged `IsDaemon: true`) are tagged `payload.isSelfDaemon = true` and excluded from `WORKING` detection.

### 1.2 Claude Code Adapter (`src/telemetry/adapters/claude-code.ts`)

- **Discovery Path:** `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` plus subagent files `~/.claude/projects/<encoded-cwd>/<session-uuid>/subagents/agent-*.jsonl` (overrideable via `CLAUDE_PROJECTS_DIR`).
  - Encoded workspace directory example: `C--Projects-MyApp/<session-uuid>.jsonl`.
  - Authoritative workspace path comes from row-level `cwd` field (`entry.cwd`) whenever present; fallback decodes `<encoded-cwd>`.
- **Empirically Observed Top-Level Fields & Types:**
  - `type`: `"user"`, `"assistant"`, `"attachment"`, `"queue-operation"`, `"last-prompt"`, `"api-request"`, `"api-request-shape"`, `"api-request-blob"`, `"cost-state"`, `"atis-latch"`.
  - Key metadata: `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `isSidechain`, `version`, `message` (`{ id, role, model, content, stop_reason, stop_details, usage }`).
  - Ignore non-timeline internal telemetry rows (`api-request-blob`, `api-request-shape`, `cost-state`, `atis-latch`) for event generation, while optionally aggregating `totalCostUSD` / `usage` into session metadata.
- **Event Normalization:**
  - `type === "user"` with string or `text` blocks → `kind: "user_input"` (if `isSidechain !== true` and no `tool_result` blocks).
  - `type === "user"` containing `content[]` items with `type === "tool_result"` → `kind: "tool_end"` with `toolCallId: block.tool_use_id`, `payload.isError: Boolean(block.is_error)`.
  - `type === "assistant"` iterating `message.content[]`:
    - `block.type === "thinking"` → `kind: "thinking_start"`.
    - `block.type === "tool_use"`:
      - If `block.name === "Agent"` or `block.name === "Task"` → `kind: "subagent_spawn"` (`toolCallId: block.id`, `agentLabel: block.input?.subagent_type || block.input?.description`).
      - Else → `kind: "tool_start"` (`toolName: block.name`, `toolCallId: block.id`, `payload.input: block.input`).
    - If `message.stop_reason === "end_turn"` (and no pending `tool_use` blocks in that message) → `kind: "assistant_turn_end"`.
  - Subagent files (`subagents/agent-<id>.jsonl`): parsed with `parentAgentId: "root"`, `agentId: "agent-<id>"`, inheriting root `sessionId`; final `end_turn` emits `kind: "subagent_done"`.

### 1.3 VS Code Copilot Adapter (`src/telemetry/adapters/copilot-vscode.ts`)

- **Discovery Paths:**
  - Windows: `%APPDATA%/Code/User/workspaceStorage/<hash>/chatSessions/*.{json,jsonl}` (also scan `Code - Insiders` if present; overrideable via `VSCODE_STORAGE_DIR`).
  - macOS: `~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.{json,jsonl}`.
  - Linux: `~/.config/Code/User/workspaceStorage/<hash>/chatSessions/*.{json,jsonl}`.
  - **Workspace Resolution:** Read sibling `<hash>/workspace.json` (`{ "folder": "file:///path/to/workspace" }`), URL-decode `file:///` URI, and normalize drive letters and forward slashes (`/path/to/workspace`).
- **Dual Format Support (Empirically Verified):**
  1. **Legacy Full Snapshot (`.json`):**
     - Top-level keys: `sessionId`, `version`, `creationDate`, `lastMessageDate`, `customTitle`, `initialLocation`, `requesterUsername`, `responderUsername`, `requests[]`.
  2. **Modern Delta-Encoded Event Log (`.jsonl`):**
     - Each line is `{ kind: 0 | 1 | 2, k?: (string | number)[], i?: number, v?: unknown }`:
       - `kind === 0`: Base session state snapshot (`state = structuredClone(row.v)`). Keys include `creationDate`, `sessionId`, `version`, `initialLocation`, `responderUsername`, `requests`, `pendingRequests`, `inputState`, `hasPendingEdits`.
       - `kind === 1`: Set value at key path `k` (e.g. `k: ["requests", 0, "modelState"]`, `v: { value: 1, completedAt: ... }`). Traverse `k[0..n-2]`, creating intermediate objects/arrays if needed, and assign `target[k[n-1]] = row.v`.
       - `kind === 2`: Splice / append into array at key path `k` (e.g. `k: ["requests", 0, "response"]`, optional index `i`, `v: [...]`). If `typeof row.i === "number"`, splice at index `i` (replacing or inserting); if `row.i` is omitted, append items of `row.v` (if array) or push `row.v` to the array at `k`.
     - After replaying all JSONL delta rows in order, the reconstructed object matches the exact `requests[]` structure of legacy `.json`!
- **Request & Response Normalization:**
  - Each `req` in `state.requests[]` contains: `requestId`, `timestamp` (epoch ms), `message: { text, parts }`, `agent: { id, name, fullName }`, `modeInfo: { modeId, modeName, modeInstructions }`, `modelId`, `modelState: { value, completedAt }`, `response[]`, `result: { details, errorDetails, metadata, timings }`, `isCanceled`.
  - Agent attribution: `agentId = req.modeInfo?.modeName || req.agent?.id || "root"` (custom `.github/agents/*.agent.md` agents appear in `modeInfo.modeName` / `agent.name`!).
  - Emit `kind: "user_input"` from `req.message.text` at `req.timestamp / 1000`.
  - Iterate `req.response[]` items by `item.kind`:
    - `"thinking"` → `kind: "thinking_start"`.
    - `"prepareToolInvocation"` → `kind: "tool_start"` (`toolName: item.toolName || item.toolId`).
    - `"toolInvocationSerialized"` →
      - Extract `toolId` (e.g. `copilot_readFile`, `copilot_applyPatch`, `run_in_terminal`, `vscode_askQuestions`, `mcp_*`, `runSubagent`), `toolCallId`, `isComplete`, `isConfirmed`, `invocationMessage`, `pastTenseMessage`, `resultDetails`.
      - If `toolId` matches subagent invocation (`runSubagent` / `agent/runSubagent`) → emit `subagent_spawn` (and `subagent_done` if `isComplete === true`).
      - Else emit `tool_start` (`toolCallId: item.toolCallId`, `toolName: item.toolId`) and, when `item.isComplete === true`, emit `tool_end` (`toolCallId: item.toolCallId`).
      - If `isComplete === false && isConfirmed === false` → marks agent `WAITING` (tool approval).
    - `"elicitationSerialized"` → triggers `WAITING` on user input/confirmation.
    - `"textEditGroup"` → file edit activity summary (`toolName: "copilot_edit"`).
  - Completion: When `req.modelState?.completedAt` or `req.result` is present (and `!req.isCanceled`), emit `kind: "assistant_turn_end"` at `(req.modelState?.completedAt ?? req.timestamp) / 1000`. If `req.result?.errorDetails` is present, attach `payload.isError = true`.

---

## 2. Active Push Telemetry Bus & Guardrail Hooks

### 2.1 Active Push Channels

1. **HTTP Ingest Endpoint:** `POST http://127.0.0.1:<port>/api/ingest` (accepts single `NormalizedEvent` JSON or `{ events: NormalizedEvent[] }`, validates via `NormalizedEventSchema`, responds `202 Accepted` within `< 10ms`).
2. **File Fallback Log:** `<projectRoot>/.agent-studio/telemetry.jsonl` (newline-delimited `NormalizedEvent` JSON). Tailed incrementally by `PushBus` (tracking byte offset + inode/size truncation reset) so events emitted while `agent-studio serve` is stopped are replayed immediately when the server starts.

### 2.2 IDE Hook Payloads (Claude Code & VS Code Copilot)

Both Claude Code (`.claude/settings.json`) and VS Code Copilot (`.github/hooks/agent-studio.json`) invoke `agent-studio hook-emit --ide <ide> --event <hookEvent>` with a JSON payload on `stdin`:

| Hook Event | Claude Code `stdin` Fields | VS Code Copilot `stdin` Fields | Normalized `kind` |
| :--- | :--- | :--- | :--- |
| `PreToolUse` | `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_use_id` | `sessionId`, `cwd`, `toolName`, `toolInput`, `toolCallId` | `tool_start` (+ guardrail check) |
| `PostToolUse` | `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id` | `sessionId`, `cwd`, `toolName`, `toolResult`, `toolCallId` | `tool_end` |
| `SubagentStart` | `session_id`, `cwd`, `agent_id`, `agent_type` | `sessionId`, `cwd`, `agentId`, `agentName` | `subagent_spawn` |
| `SubagentStop` | `session_id`, `cwd`, `agent_id`, `agent_type` | `sessionId`, `cwd`, `agentId`, `agentName` | `subagent_done` |
| `Stop` | `session_id`, `cwd`, `stop_hook_active` | `sessionId`, `cwd` | `assistant_turn_end` |

### 2.3 `agent-studio hook-emit` Resilience & `PreToolUse` Guardrail Contract

- **Fast-Fail Budget:** Total runtime MUST remain `< 200ms` when the studio server is offline:
  1. Parse `stdin` JSON (non-blocking, bounded to 256 KB).
  2. **Guardrail Check (`PreToolUse` only):**
     - Inspect `tool_name` / `toolName` and target file paths in `tool_input` / `toolInput` (`file_path`, `path`, `target`, `command`).
     - If `workflow.enforcement.blockDirectBoardEdits` is enabled and an edit/write/shell tool targets `pipeline/board.json` directly:
       - Write structured deny JSON to `stdout` (compatible with both Claude Code and VS Code Copilot hook protocols):
         ```json
         {
           "hookSpecificOutput": {
             "hookEventName": "PreToolUse",
             "permissionDecision": "deny",
             "permissionDecisionReason": "Direct edits to pipeline/board.json are blocked by Agent Studio. Use the agent-studio MCP `board` tool instead."
           }
         }
         ```
       - Emit a `tool_end` / `BLOCKED` telemetry event and **exit with code `2`** (hard block).
  3. Normalize the hook payload into a `NormalizedEvent` (`channel: "hook"`).
  4. Send `POST http://127.0.0.1:<port>/api/ingest` with an `AbortController` timeout of **`150ms`**.
  5. On timeout, `ECONNREFUSED`, or non-2xx response: append the single NDJSON line to `<projectRoot>/.agent-studio/telemetry.jsonl` (`fs.appendFileSync`, best-effort) and **exit `0`** immediately — never breaking or slowing down the host IDE.

### 2.4 MCP Server Telemetry Emissions (`src/mcp/server.ts`)

Every `board`, `testrun`, and `telemetry` MCP tool invocation appends a `NormalizedEvent` (`channel: "mcp"`) to `<projectRoot>/.agent-studio/telemetry.jsonl` (best-effort, non-fatal):
- Mutating `board` ops (`add`, `move`, `note`, `owner`, `plan`) & `testrun` ops (`start`, `record`, `step`, `close`) → `kind: "board_mutation"`.
- Read-only `board`/`testrun` ops & rejected QA Gate errors → `kind: "tool_end"`.
- `telemetry` `handoff` → `kind: "message"` with `payload: { type: "handoff", from, to }`.

---

## 3. Cross-Channel Deduplication

Because Claude Code and VS Code Copilot can emit **both** live `hook` events (`< 50ms` latency) and richer `passive` transcript entries (seconds later, with full outputs/token counts), the normalizer deduplicates and merges events deterministically.

### 3.1 Deterministic Event ID (`id`)

`id` is a 16-character lowercase hex prefix of SHA-256 over canonical fields separated by ASCII Unit Separator (`\u001f`):

```ts
id = sha256([ide, sessionId, agentId, kind, toolCallId ?? toolName ?? "", String(Math.floor(epoch)), summary.slice(0, 80)].join("\u001f")).slice(0, 16)
```

### 3.2 Two-Tier Merge Keys (`mergeKey`)

1. **Tier-1 (Exact Native Tool Call ID):** When `toolCallId` is present (Claude Code `tool_use_id`, VS Code `toolCallId`, Antigravity synthesized call ID):
   ```ts
   mergeKey = `t1:${sessionId}:${agentId}:${kind}:${toolCallId}`
   ```
2. **Tier-2 (2-Second Time-Bucket Fallback):** When `toolCallId` is absent (e.g. `user_input`, `subagent_spawn`, `assistant_turn_end`, or hook/passive pairs lacking shared IDs):
   ```ts
   const bucket2s = Math.floor(epoch / 2);
   mergeKey = `t2:${sessionId}:${agentId}:${kind}:${toolName ?? ""}:${bucket2s}`
   ```

### 3.3 Channel Merge Precedence Table

When two events share a `mergeKey` (Tier-1 exact match, or Tier-2 match within ±1 adjacent 2-second bucket):

| Field | Winning Precedence | Rationale |
| :--- | :--- | :--- |
| `ts` / `epoch` | Earliest (`min(epoch)`) for `*_start`; `hook` timestamp if available | Preserves real-time live arrival ordering without timeline jumps |
| `payload` | Deep merge with `passive` > `mcp` > `hook` | Passive transcripts contain full structured tool args/outputs; hooks carry fast metadata |
| `summary` | Longer non-empty summary (`passive` > `mcp` > `hook`) | Avoids overwriting rich transcript summaries with terse hook stubs |
| `agentLabel` / `parentAgentId` | First non-empty (`mcp` > `passive` > `hook`) | Retains explicit hierarchy metadata |
| `channel` | Retain highest-fidelity channel (`passive` upgrades `hook`) while recording `payload._channels = ["hook", "passive"]` | Lets Doctor/Inspector verify dual-channel health |

---

## 4. Unified 6-State Machine & Server API Contract

### 4.1 Six-State Machine (`THINKING | WORKING | WAITING | BLOCKED | DONE | IDLE`)

Each agent in a session folds its time-ordered `NormalizedEvent[]` into a live `AgentStatus` (with lowercase `LegacyAgentState` alias for existing UI parity):

| State | Entry Triggers | Timers & Decay / Exit Rules |
| :--- | :--- | :--- |
| `WORKING` | Unmatched `tool_start` (excluding `isSelfDaemon === true` and human-prompt tools like `ask_question` / `vscode_askQuestions`) | Cleared on matching `tool_end`, `assistant_turn_end`, or `subagent_done`. If no event arrives for **`900s` (15m)**, decays to `IDLE` (stale session safety). |
| `THINKING` | `thinking_start`, OR unanswered `user_input`, `tool_end`, or `subagent_spawn` at the tail of the stream while the file/session is active | Shows live elapsed timer (`thinkingSince`). Requires **`12s`** grace window after `tool_end` / `user_input` before transitioning if turn completion hasn't arrived; decays to `IDLE` after **`900s`** (or `DONE` if `mtime` stale `> 1800s` with no open tools). |
| `WAITING` | Unmatched human-input tool (`ask_question`, `AskUserQuestion`, `vscode_askQuestions`, `elicitationSerialized`), unconfirmed tool (`isConfirmed === false`), or coordinator waiting on active child subagents (`waitingOn: "subagent:<id>"` or `"user"` / `"tool_approval"`) | Cleared when user responds (`user_input`), tool confirms (`tool_end`), or all awaited child subagents reach `DONE`. |
| `BLOCKED` | `PreToolUse` guardrail denial, QA Gate rejection error (`QA_GATE_REJECTED`), `message` with blocker classification (`BLOCKER:` / `blocked`), or unrecovered fatal tool error | Cleared on subsequent non-error `tool_start`, `user_input`, or `assistant_turn_end`. |
| `DONE` | Clean `assistant_turn_end` or `subagent_done` with zero open tools and zero active child subagents | Sets `reportedDone = true`. **Reset Rule (`reportedDone` reset):** Any subsequent `user_input`, `thinking_start`, `tool_start`, or incoming `message` to that agent immediately resets `reportedDone = false` and re-enters `THINKING`/`WORKING` (crucial for multi-turn resumed sessions). |
| `IDLE` | Initial state before first activity, or inactive session with no events for **`> 1800s` (30m)** (with `15s` debounce after `session_start` before marking idle if no turn started) | Transitions to `THINKING` or `WORKING` on next active event. |

**Key Parity Invariants:**
- **Self-Daemon Exclusion:** Commands flagged `isSelfDaemon` (`agent_visualizer.py`, `board_dashboard.py`, `agent-studio serve`) NEVER hold an agent in `WORKING`.
- **Monotonic Numeric `epoch`:** Every event emitted into `SessionSnapshot.events` carries a monotonically non-decreasing float `epoch` (Unix seconds). If two events share an identical timestamp, add `+0.0001` tie-breaker epsilon so timeline scrubbing and `buildSnapshot(cursor)` remain strictly deterministic.

### 4.2 `SessionSnapshot` Contract

```ts
export interface SessionSnapshot {
  sessionId: string;
  ide: IdeSource;
  projectId?: string;
  workspacePath?: string;
  updatedAt: string;
  serverTime: string;
  status: AgentStatus;
  waitingOn: string | null;
  isWaiting: boolean;
  isCompleted: boolean;
  isMultiAgent: boolean;
  agents: AgentNodeSnapshot[];
  edges: AgentEdgeSnapshot[];
  events: NormalizedEvent[];       // Ordered by monotonic `epoch`
  counters: {
    totalEvents: number;
    toolCalls: number;
    messages: number;
    boardMutations: number;
    activeAgents: number;
    completedAgents: number;
  };
}
```

### 4.3 Unified Single-Port HTTP & SSE API Contract (`agent-studio serve`)

All routes are served on one port (default `8767`, `--host 127.0.0.1` or `0.0.0.0`) with zero external runtime dependencies:

| Method & Endpoint | Query / Body Parameters | Response & Behavior |
| :--- | :--- | :--- |
| `GET /api/sessions` | `?ide=all\|antigravity\|claude-code\|copilot-vscode&project=<id>&workspace=<path>&multiOnly=true\|false&limit=100` | Returns `{ sessions: DiscoveredSessionSummary[], projects: RegisteredProject[] }` including `ide`, `projectId`, `status`, `waitingOn`, `isWaiting`, `isCompleted`, `isMultiAgent`. |
| `GET /api/state` | `?session=<id>&ide=<ide>&project=<id>&workspace=<path>` | Returns full `SessionSnapshot` plus `sessions[]` list and `boardProjects[]` (backward-compatible with existing Web Studio). |
| `GET /api/stream` | `?session=<id>&ide=<ide>&project=<id>&workspace=<path>` | Server-Sent Events (`text/event-stream`), pushes `event: state` JSON frames on file mtime change or `POST /api/ingest` push, plus `: keepalive` comment every `15s`. Gracefully swallows Windows `ECONNRESET`/`ECONNABORTED`/`EPIPE` on disconnect. |
| `POST /api/ingest` | Body: `NormalizedEvent` or `{ events: NormalizedEvent[] }` | Validates via `NormalizedEventSchema`, merges into `PushBus` + deduplicator, broadcasts to matching SSE subscribers, returns `202 { ok: true, accepted: number }`. |
| `GET /api/board` | `?project=<id>&sprint=<sp>&showDone=true\|false` | Returns live Agile Board snapshot (`board.json` + sprint counts + open bugs + testruns + QA gate status). |
| `GET /api/mockups` | `?project=<id>` | Project-agnostic discovery of HTML mockups across registered project roots and `team.yaml` `mockupsDirs`. |
| `GET /api/mockup` & `GET /api/mockup/<id>/<asset>` | `?id=<mockupId>&t=<mtime>` | Serves mockup HTML and sibling assets with `Cache-Control: no-store` and strict `path.resolve` root-containment traversal protection (`403`/`404` on `..`). |
| `POST /api/feedback` | Body: `{ id: string, note: string, view?: string }` | Appends timestamped critique to sibling `FEEDBACK.md` alongside the validated mockup entry. |
| `GET /api/doctor` | `?project=<id>` | Runs live IDE & configuration health checks (Node version, `team.yaml` schema, adapter drift hashes, MCP server handshake, hook health, telemetry directory reachability) and returns structured check cards. |
| `POST /api/doctor/test-event` | Body: `{ project?: string, ide?: IdeSource }` | Emits a synthetic `NormalizedEvent` through the active `PushBus` so the Doctor view can verify end-to-end live SSE delivery with one click. |

---

## 5. Telemetry & Adapter Verification Criteria

Automated replay and integration tests in `tests/unit/` verify the following invariants across all three IDEs:

1. **Antigravity Adapter (`antigravity-multi-agent.jsonl`)**
   - Dynamic discovery of root coordinator and spawned subagents with zero hardcoded agent names.
   - Unquoted tool args, `send_message` edges, and `isSelfDaemon` exclusion from `WORKING`.
   - Multi-turn `reportedDone` reset when a new `USER_INPUT` arrives after `DONE`.
2. **Claude Code Adapter (`claude-code-session.jsonl` + `subagents/agent-1.jsonl`)**
   - Extracts `cwd`, ignores `cost-state`/`api-request-blob` noise, and maps `thinking`, `tool_use`, `tool_result`, and `Agent` subagent spawns.
   - Links `subagents/agent-1.jsonl` under `parentAgentId: "root"` and transitions `subagent_done` → `DONE`.
3. **VS Code Copilot Adapter (`copilot-legacy.json` & `copilot-delta.jsonl`)**
   - Legacy `.json` snapshot extracts `requests[]`, `toolInvocationSerialized`, and `workspace.json` folder URI decoding.
   - Delta-encoded `.jsonl` (`kind: 0`, `kind: 1`, `kind: 2` with and without index `i`) reconstructs full `requests[]` identically, handling `thinking`, `toolInvocationSerialized` (`isComplete: false` → `WORKING`/`WAITING`, `isComplete: true` → `tool_end`), and `elicitationSerialized` → `WAITING`.
4. **Cross-Channel Deduplication & `hook-emit` Offline Fallback**
   - Paired `hook` (`PreToolUse`/`PostToolUse`) + `passive` transcript events sharing `toolCallId` collapse to a single Tier-1 merged event with `hook` timestamp + `passive` payload.
   - Paired events without `toolCallId` within 2s collapse via Tier-2 merge key.
   - `agent-studio hook-emit` completes in **`< 200ms`** with exit code `0` and appends valid NDJSON to `.agent-studio/telemetry.jsonl` when `serve` is offline.
   - `PreToolUse` targeting `pipeline/board.json` returns structured `permissionDecision: "deny"` JSON on stdout and exits with code **`2`**.
5. **Unified State Machine & Ephemeral HTTP/SSE Server**
   - All 6 states (`THINKING`, `WORKING`, `WAITING`, `BLOCKED`, `DONE`, `IDLE`) transition deterministically, including `12s`/`15s`/`900s`/`1800s` timer transitions and monotonic `epoch`.
   - Ephemeral `agent-studio serve` returns `200` on `/api/sessions`, `/api/state`, `/api/board`, `/api/mockups`, `/api/doctor`, `202` on `POST /api/ingest`, and streams live `POST /api/ingest` updates over `/api/stream` SSE.
