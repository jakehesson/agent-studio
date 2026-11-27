# Direct in-Messages-UI Human Question Answering (S1-77)

Technical spec for **S1-77** across **Core Backend**, **Extension**, and **Web / MCP App**.

## 1. Core Backend Scope (`src/`, `tests/unit/`, `.agent-team/` via sync)

### 1.1 Schema & Type Parity (`src/schema/telemetry.ts`, `src/telemetry/types.ts`)
- Add `PromptSourceSchema = z.enum(["native", "studio-mcp", "studio-vscode-lm"])` and `PromptStatusSchema = z.enum(["pending", "answered", "canceled", "expired"])`.
- Extend `PendingHumanPromptSchema` with optional fields: `directReply?: boolean`, `promptSource?: PromptSource`, `status?: PromptStatus`, `answerText?: string`, `answers?: Record<string, unknown>`, `expiresAt?: string`, `sessionId?: string`, `workspacePath?: string`, `ide?: IdeSource`.
- Add Zod schemas in `src/schema/telemetry.ts`:
  - `PromptBridgeCreateSchema`: `{ title?(<=140), summary?(<=500), kind?("question"|"approval"), questions(1..10), agentId?, agentLabel?, sessionId?, workspacePath?, projectId?, ide?, toolName?, toolCallId?, promptSource?("studio-mcp"|"studio-vscode-lm"), timeoutMs?(5000..1800000, default 600000) }`.
  - `PromptBridgeAnswerSchema`: `{ answerText(1..32768), answers?: Record<string, string|string[]>, responder? }`.
  - `PromptBridgeCancelSchema`: `{ reason?(<=512) }`.
- Re-export `PromptSource`, `PromptStatus` in `src/telemetry/types.ts`; add `"ask_human"`, `"agent_studio_ask_human"`, `"mcp__agent-studio__ask_human"`, `"agent-studio/ask_human"` to `HUMAN_TOOL_SET` (`classifyExternalTool` -> `ext:human`) and `isCopilotAskTool` (`src/telemetry/adapters/copilot-vscode.ts`).

### 1.2 PromptBridge (`src/telemetry/prompt-bridge.ts`) & `TelemetryAggregator` (`src/telemetry/index.ts`)
- Export `PromptBridge extends EventEmitter`, attached as `readonly promptBridge: PromptBridge` on `TelemetryAggregator`.
- **Lifecycle & Caps:** `pending -> answered | canceled | expired` (immutable terminal states). `MAX_ACTIVE_PROMPTS = 64` (429 when full post-sweep), `MAX_TERMINAL_PROMPTS = 200`, `DEFAULT_PROMPT_TTL_MS = 600_000`, `TERMINAL_RETENTION_MS = 120_000`, `15_000`ms `.unref()` sweep timer cleared on `dispose()` / `server.close()`.
- **Atomic One-Shot Resolution & Waiter:** `answerPrompt`/`cancelPrompt` synchronously require `status === "pending"` (else `{ ok: false, conflict: true, status }` -> `409`). `waitForResolution(id, waitMs, signal?)` resolves immediately on resolution or `min(waitMs, 30_000)`.
- **Session/Workspace Attribution (`sessionId` omitted, `embed=1`, spun-off chats):**
  - Normalize `workspacePath` via `normalizeWsPath`; infer `projectId` via `resolveProject(undefined, workspacePath)`; default `ide` to `"copilot-vscode"` (`studio-vscode-lm`) or active-session IDE / `"mcp"` (`studio-mcp`).
  - When `sessionId` is omitted: pick newest active non-synthetic session matching `{ ide, workspace, project }` (`mtimeMs` <=15m), else synthesize `"prompt-" + id` (`autoAttributed = true`).
  - `createPrompt` ingests synthetic `tool_start` into `PushBus` (`waitingReason: "user"`, `payload: { directReply: true, promptSource, blockingToolCall: false, questions, promptTitle, promptSummary }`).
  - `answerPrompt` ingests `tool_end` (`status: "ok"`) **plus** `user_input` (`payload: { isHumanAnswer: true, directReply: true, promptId, questionToolCallId, questionPrompt, targetAgentId, body }` + `bodyStore` if >1400 chars) into `PushBus` so S1-76 Messages SMS displays the answer bubble and `normalizer.ts` clears waiting state. `cancel`/`expire` ingests `tool_end` (`status: "error"`, `isError: true`).
  - `TelemetryAggregator.getSessionSnapshot` & `discoverSessions` overlay `PromptBridge` pending prompts matching `p.sessionId === snapshot.sessionId` OR (`p.autoAttributed` + `pathMatchesRoot` workspace/project match + `p.ide === "mcp"` or filter match), keeping `embed=1` isolated across workspaces and other IDEs.

### 1.3 HTTP Routes & Liveness (`src/server/http-server.ts`)
- Wire `aggregator.promptBridge.on("change", () => broadcastDebounced())`.
- `GET /api/health`: pure in-memory (<2ms), accepts `?workspace=`; returns `{ ok: true, sseClients, matchingSseClients, hasActiveUi, activePromptCount }` counting open `sseClients` with empty or `pathMatchesRoot`-compatible `workspace`.
- `GET /api/prompts`: list `pending` prompts filtered by `?session=`, `?ide=`, `?project=`, `?workspace=`.
- `POST /api/prompts`: 512 KB cap (`MAX_INGEST_BODY_BYTES`), Zod-validated -> `201` `{ ok: true, prompt }` or `429`.
- `GET /api/prompts/:id`: reject `/`, `\`, `..`; supports `?waitMs=0..30000` -> `200` or `404`.
- `POST /api/prompts/:id/answer`: 64 KB cap -> `200`, `404`, `409`.
- `POST /api/prompts/:id/cancel`: 8 KB cap -> `200`, `404`, `409`.
- **Origin guard on `POST /api/prompts*`:** if `Origin` is present, allow only loopback (`127.0.0.1`, `localhost`, `[::1]`), `vscode-webview://`, or same `Host`; else `403` without wildcard CORS.

### 1.4 `ask_human` & App Tools (`src/mcp/server.ts`)
- Add `ask_human` (`title?`, `summary?`, `kind?`, `questions` [1..10], `agentId?`, `agentLabel?`, `sessionId?`, `project?`, `workspace?`, `ide?`, `timeoutSeconds?`) plus app-only (`_meta.ui.visibility: ["app"]`) `app_answer_prompt` (`promptId`, `answerText`, `answers?`, `responder?`) and `app_cancel_prompt` (`promptId`, `reason?`).
- **Off-queue execution in `startMcpStdioServer`:** dispatch `ask_human` off the serial `queue` chain (tracked in `activeTasks` + `inFlightRequests` `Map<string, AbortController>`) so `app_get_state`, `app_answer_prompt`, `board`, `ping`, and `notifications/cancelled` never deadlock. Serialize `stdout.write` via `writeLine`.
- Abort on `notifications/cancelled` (`params.requestId`) and `rl.on("close")`, issuing `POST /api/prompts/:id/cancel`. Emit `notifications/progress` every `20_000`ms when `params._meta?.progressToken` exists.
- **Fallback:** `app_get_state`/`app_get_chat` call `aggregator.touchMcpAppClient()`. `ask_human` uses HTTP (`127.0.0.1:${AGENT_STUDIO_PORT ?? 8767}`, 250ms probe, `?waitMs=20000`) unless `AGENT_STUDIO_MCP_NO_HTTP === "1"` or `options.aggregator` is injected. If HTTP offline: use local `promptBridge` if `hasRecentMcpAppClient(15_000)` is true; else fail fast (`isError: true`, `structuredContent: { ok: false, status: "unavailable", fallbackRequired: true, reason }`). `app_get_state` merges HTTP active prompts (`<=80`ms); `app_answer_prompt`/`app_cancel_prompt` try HTTP first, then local `promptBridge`.

### 1.5 Fail-Open `preToolUse`, Antigravity & Compilers
- `src/cli/commands/hook-emit.ts`: on `preToolUse` for `lowTool === "vscode_askquestions"` (unless `AGENT_STUDIO_DISABLE_ASK_REDIRECT === "1"`), probe `GET /api/health?workspace=${cwd}` (`AbortSignal.timeout(150)`). Redirect via `denyReason` (`agent_studio_ask_human`/`ask_human`) **only** when `res.ok && data.hasActiveUi === true`; fail open otherwise. Never redirect `ask_human`/`agent_studio_ask_human`. Set `blockingToolCall: false` on `isBlockedNotifyUser`.
- `src/telemetry/adapters/antigravity.ts`: set `blockingToolCall: false` on `notify_user(BlockedOnUser: true)` (keep `blockedOnUser: true` in `openToolCalls`, and `ask_question` `blockingToolCall: true`).
- `src/compiler/shared.ts`: update `renderSharedTeamRules` so agents prefer `ask_human`/`agent_studio_ask_human` when Studio is active, falling back natively if offline.
- `src/compiler/capabilities.ts`: under `ask_user`, set `inheritMcp = true` (Antigravity), add `"mcp__agent-studio__ask_human"` (Claude Code), and add `"agent_studio_ask_human"` (Copilot; `mcp_board` keeps `"agent-studio/*"`). Run `npx agent-studio sync`.

## 2. Extension Scope (`extension/`)
- **`extension/package.json`:** Contribute `languageModelTools` entry `agent_studio_ask_human` (`toolReferenceName: "agent_studio_ask_human"`, `canBeReferencedInPrompt: true`, matching `ask_human` `inputSchema`).
- **`extension/src/askHumanTool.ts`:** `registerAskHumanTool(serverManager, output)` guards `vscode.lm?.registerTool` (no-op on Antigravity). `prepareInvocation` omits `confirmationMessages`. `invoke(options, token)` calls `serverManager.ensureRunning(false)` (advising native fallback if offline), posts `POST /api/prompts` (`promptSource: "studio-vscode-lm"`, `ide`, `workspacePath`, `projectId`, `sessionId?`), long-polls `GET /api/prompts/:id?waitMs=20000`, forwards `token.onCancellationRequested` to `POST .../cancel` (disposing listener in `finally`), and returns `vscode.LanguageModelToolResult`.
- **`extension/src/extension.ts`, `serverManager.ts`, `webviewProvider.ts`:** Register `registerAskHumanTool` in `activate`. No `webviewProvider.ts` `postMessage` change needed (iframe loads same-origin from `ServerManager.getLocalBaseUrl()`).

## 3. Frontend & MCP App Scope (`web/`)
- **`web/src/types.ts` & `web/src/state/snapshot.ts`:** Mirror `PromptSource`, `PromptStatus`, `PendingHumanPrompt` additions (`directReply`, `promptSource`, `status`, `answerText`, `answers`, `expiresAt`), `ReplyToHostRequest` (`directReply?`, `promptSource?`, `answers?`), `ReplyToHostResult["mode"]` (`"answered"|"canceled"`), and `onCancelPrompt` across `QuestionCard`, `ActivityFeed`, `AgentChatPane`, `AgentChatDrawer`, `LiveStudioView`, `AgentStudioApp`.
- **`web/src/api.ts`:** Add `answerPendingPrompt` & `cancelPendingPrompt` (MCP `app_answer_prompt`/`app_cancel_prompt` when `isMcpAppTransportActive()`, else HTTP `POST /api/prompts/:id/answer|cancel`).
- **`web/src/app.ts` & `web/src/mcp-app-entry.ts`:** `sendReplyToHost` routes `req.directReply === true` via `answerPendingPrompt` (`409` handled, network failure falls back to `copyTextSafe`), refreshing state in `mcpAppMode`. Keep `mcp-app-entry.ts` `sendMessage` exclusively for `!req.directReply && !req.blockingToolCall`.
- **`web/src/components/QuestionCard.ts`, `ActivityFeed.ts`, `AgentChatPane.ts`, `AgentChatDrawer.ts`, `LiveStudio.ts`, `utils.ts`:** `getPrimaryActionMeta` returns `"Send Answer"` + Copy + Cancel (`data-qc-cancel`) when `directReply === true`, hides `.qc-blocking-note`, locks against double submit, clears `promptDraftStore`, preserves `44px` tap targets, Z Fold 7 wrapping, and WCAG AA contrast. Add `ask_human`/`agent_studio_ask_human` to `classifyExternalTarget`.

## 4. Verification & Edge-Case Matrix
- **Invariants:** Off-queue MCP never blocks `app_answer_prompt`/`notifications/cancelled`; `hook-emit` fails open <=150ms when offline/no UI; `vscode.lm.registerTool` no-ops on Antigravity; `embed=1` stays workspace/IDE-isolated when `sessionId` omitted; `POST /api/prompts*` enforces Origin (`403`) & one-shot (`409`).
- **Tests:** Core (`mcp-stdio.test.ts`, `server.test.ts`, `chat-and-prompts.test.ts`, `compiler.test.ts`); Extension (`extension.test.ts`); Frontend (`web-chat-prompts.test.ts`, `contract-parity.test.ts`).
- **Gates:** `CP0` (`npm run check && npm --prefix extension run check && npm test`), `CP1` (`npm --prefix web run check && npm --prefix web run build`), `CP2` (`python tests/smoke_test.py`), `npx agent-studio sync --check`.
