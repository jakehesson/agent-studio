# Spec: VS Code Copilot Feed Parity (`S1-56`) & Usage Accuracy (`BUG-20`)

## 1. Canonical Token, Usage & Context Contract

Every `UsageDelta` emitted by adapters or `hook-emit` MUST obey one canonical contract before `normalizer.ts` or `web/src/state/snapshot.ts`:

- `inputTokens`: **fresh (uncached) input tokens only** (`>= 0`).
- `cachedTokens`: **cached input tokens** (`cacheRead + cacheCreate`, `>= 0`).
- `outputTokens`: **output / completion tokens** (`>= 0`).
- `contextTokens`: **active-turn context occupancy** (`promptTotal + outputTokens`), NEVER summed across turns.
- `contextWindow?`: **exact positive integer max input tokens** when reported by IDE metadata (`chatSessions` `inputState.selectedModel.metadata.maxInputTokens`, or `events.jsonl` `tokenLimit`/`maxInputTokens`/`contextWindow`).
- Downstream invariants (`normalizer.ts`, `snapshot.ts`, `UsageDashboard.ts`):
  - `freshTokens = inputTokens + outputTokens`
  - `totalTokens = inputTokens + outputTokens + cachedTokens`
  - `effectiveContextWindow = explicitContextWindow ?? inferContextWindow(model, ide)`

### Provider Normalization (Zero Antigravity / Claude Code Regression)
- **`claude-code` & `antigravity`**: unchanged (`input_tokens` is fresh-only; `contextTokens = inTok + cachedTok + outTok` in Claude Code, `inTok + cachedTok` in Antigravity).
- **`copilot-vscode` (`parseTranscriptFile`, `parseSession`, `hook-emit` when `ide === "copilot-vscode"`)**:
  OpenAI/Copilot APIs report `promptTokens`/`inputTokens` **inclusive** of `cachedTokens`/`cacheReadTokens`. Normalize via `normalizeCopilotUsage(u)`:
  - If `inTok !== undefined` and `cachedTok > 0` and `inTok >= cachedTok`:
    `freshIn = inTok - cachedTok`, `turnContext = contextTok ?? (inTok + (outTok ?? 0))`.
  - If `inTok !== undefined` and (`cachedTok === 0` or `inTok < cachedTok`, Anthropic raw format):
    `freshIn = inTok`, `turnContext = contextTok ?? (inTok + cachedTok + (outTok ?? 0))`.
  - If `inTok === undefined && contextTok === undefined` (`completionTokens`-only turn):
    DO NOT overwrite `lastTurnContext` with bare `outTok` (`422`); preserve previous `lastTurnContext`.

### `inferContextWindow(model, ide)` Alignment (Backend + Frontend)
Sync `src/telemetry/types.ts` and `web/src/state/snapshot.ts`:
1. `[1m]` → `1_000_000`
2. Empty/`unknown` → `ide === "antigravity" ? 1_000_000 : 200_000`
3. `gemini` or `gpt-4.1` → `1_000_000`
4. `gpt-5` / `gpt 5` / `gpt-6` / `gpt 6` → `400_000`
5. `gpt-4o` / `o1` / `o3` / `o4` → `128_000`
6. `claude` / fallback → `200_000`

---

## 2. Parsing, Checkpoints & Fallback Context

### `CopilotVSCodeAdapter` (`src/telemetry/adapters/copilot-vscode.ts`)
- **`parseTranscriptFile()`**:
  - Capture `tokenLimit`/`maxInputTokens`/`contextWindow` into `acc.contextWindow`.
  - Separate usage rows:
    - **Incremental** (`assistant.message`, `assistant.usage`, `session.usage_record`): `+=` into incremental totals; update `lastTurnContext` to latest turn (`normalizeCopilotUsage`).
    - **Cumulative** (`session.usage_checkpoint`, `session.shutdown` incl. `modelMetrics`): NEVER `+=` onto incremental totals. Update `acc.contextWindow` and `lastTurnContext` (from `session.usage_checkpoint` `contextTokens`/`currentTokens` only, never `session.shutdown` totals). Use latest checkpoint/shutdown totals only if zero incremental rows exist.
- **`parseSession()` (`chatSessions`)**:
  - Extract `state.inputState?.selectedModel?.metadata?.maxInputTokens` into `acc.contextWindow`.
  - Prefer `result.usage`/`result.metadata` over `toolCallRounds` only when direct/meta has `inTok !== undefined` or `contextTok !== undefined` (or `roundUsages.length === 0`), preventing bare `req.completionTokens` from masking `roundUsages` prompt tokens.

### Non-Cumulative Fallback Estimation (`copilot-vscode.ts`, `normalizer.ts`, `snapshot.ts`)
- Never use `JSON.stringify(req.response).length` in `parseSession()`; sum visible prose/thinking/concise tool titles instead.
- Cap per-event fallback payload chars at `2000`.
- When `!hasExact` / `!hasExplicitUsage`, compute `contextTokens` from latest `user_input` turn onward plus bounded prior prose (`<= 4000` chars/turn), NEVER cumulative tool JSON across all turns.

---

## 3. Feed & Label Parity (`S1-56`)

1. **Hook summaries & root UUID guard (`src/cli/commands/hook-emit.ts`)**:
   - Treat `agent_id === sessionId` or `parent_agent_id === sessionId` as `"root"` (never create phantom UUID node or coerce root `Stop` to `subagent_done`).
   - Use `summarizeToolCall(toolName, toolInput)` on `PreToolUse` / `PostToolUse` / `PostToolUseFailure` (prefix `"Completed: "` / `"Failed: "` post-tool), never `"PreToolUse: Read"`.
   - Promote `write_agent` / `read_agent` to `kind: "message"`.
2. **Markdown links & tool classification (`src/telemetry/types.ts`, `web/src/utils.ts`)**:
   - In `cleanHumanSummary` and `cleanSummaryText`, use `/\[([^\]]*)\]\(([^)]+)\)/g`: non-empty label → `label`; empty label `[](file:///.../foo.ts)` → decoded basename `foo.ts` (zero `file://` leakage).
   - Add VS Code/Copilot tools to `FS_TOOL_SET`, `SHELL_TOOL_SET`, `classifyExternalTool`/`classifyExternalTarget`, and `summarizeToolCall`: `powershell`, `view`, `rg`, `glob`, `apply_patch`, `sql`, `skill`, `tool_search_tool`, `rename_chat`, `write_agent`/`read_agent` (return `null` external target + `message` edge), `copilot_replaceString`, `copilot_multiReplaceString`, `copilot_findFiles`, `copilot_findTextInFiles`, `copilot_listDirectory`, `copilot_searchCodebase`, `copilot_getErrors`, `manage_todo_list`, and slash-prefixed IDs (`edit/editFiles`, `execute/runInTerminal`).
3. **Rich Copilot text (`copilot-vscode.ts`)**:
   - `parseSession()`: `thinking` uses `item.generatedTitle` + `fullBody`; `textEditGroup` extracts `item.uri` basename (`Edit <file>`); `assistant_turn_end` uses `cleanHumanSummary(turnText, 140) || "Turn completed"`.
   - `parseTranscriptFile()`: when `assistant.message` has both `msgText` and `toolRequests`, emit `thinking_start` (`cleanHumanSummary(msgText, 140)` + `fullBody`); suppress duplicate `"Turn completed"` on `assistant.turn_end` if the same turn already emitted prose completion.
4. **Dedup & reconciliation (`src/telemetry/normalizer.ts`)**:
   - Add `canonicalDedupToolName()` in Tier-2 cross-channel merge probing (`Read`/`view`/`copilot_readFile` → `fs_read`, `Bash`/`powershell`/`run_in_terminal` → `shell`, `Edit`/`apply_patch`/`copilot_replaceString` → `fs_edit`, `Grep`/`rg`/`copilot_findTextInFiles` → `fs_search`, `Glob`/`glob`/`copilot_findFiles` → `fs_glob`, `Agent`/`runSubagent` → `subagent`).
   - In `normalizeSubagentLabel()`, strip namespace prefixes (e.g. `VS Code Synced Data:`) and split camelCase so `"VS Code Synced Data:break-glass"` matches `"BreakGlass"`.

---

## 4. Exclusive File Boundaries & Tests

- **Backend (`backend-engineer`)**: `src/cli/commands/hook-emit.ts`, `src/telemetry/types.ts`, `src/telemetry/adapters/copilot-vscode.ts`, `src/telemetry/normalizer.ts`, `tests/unit/telemetry.test.ts` (update stale double-counting assertion at `:1708-1712` + add coverage).
- **Frontend (`frontend-engineer`)**: `web/src/utils.ts`, `web/src/state/snapshot.ts`, `web/src/components/UsageDashboard.ts` (show peak `contextTokens / contextWindow` in Peak Context KPI; zero cached double-count).

### Unit Tests (`tests/unit/telemetry.test.ts`) & Checkpoints
1. `hook-emit`: `agent_id === sessionId` stays `"root"`; `PreToolUse` uses `summarizeToolCall`; `copilot-vscode` inclusive hook usage normalizes `freshIn`.
2. `cleanHumanSummary`/`cleanSummaryText`: `[](file:///d:/repo/app.ts)` → `"app.ts"`.
3. `summarizeToolCall`/`classifyExternalTool`: all listed Copilot tools + `write_agent`/`read_agent` `message` edges.
4. `parseTranscriptFile`: incremental + `session.usage_checkpoint` + `session.shutdown` never double-count; inclusive `cachedTokens` yields accurate `totalTokens` & `contextTokens`; `assistant.message` with `content` + `toolRequests` preserves prose and suppresses duplicate `"Turn completed"`.
5. `parseSession`: `selectedModel.metadata.maxInputTokens` (`271805`/`921805`/`135805`) propagates `contextWindow`; `completionTokens`-only turn preserves `toolCallRounds` context; `thinking.generatedTitle`, `textEditGroup.uri`, and `turnText` summary verified.
6. `normalizer`: cross-channel alias dedup & `"VS Code Synced Data:break-glass"` vs `"BreakGlass"` reconciliation; non-cumulative estimated fallback.
7. Checkpoints: `CP0` (`npm run check && npm test`) and `CP1` (`npm --prefix web run check && npm --prefix web run build`).
