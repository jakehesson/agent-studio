# In-App GitHub Feedback Specification (S1-57)

## 1. Goal & Non-Goals
- **Goal:** Enable users to submit bug reports, feature requests, and questions to `jakehesson/agent-studio` directly from Agent Studio across all three runtime surfaces: VS Code/Antigravity Extension (`embed=1`), standalone Web Studio (`agent-studio serve`), and SEP-1865 MCP App (`app.html`), with optional sanitized diagnostics.
- **Non-Goals:** Supporting custom target repositories, reading/listing/editing existing GitHub issues, uploading screenshots/attachments, or exposing authentication tokens to browser/webview contexts.

## 2. Hard Security & Repository Invariants
1. **Compile-Time Locked Target (All Surfaces):**
   - `FEEDBACK_GITHUB_OWNER = "jakehesson"`
   - `FEEDBACK_GITHUB_REPO = "agent-studio"`
   - `FEEDBACK_ISSUES_API_URL = "https://api.github.com/repos/jakehesson/agent-studio/issues"`
   - `FEEDBACK_NEW_ISSUE_URL = "https://github.com/jakehesson/agent-studio/issues/new"`
2. **Zero Client/Config Target Control:** Never accept `owner`, `repo`, `endpoint`, `apiUrl`, or `gh` flags from HTTP requests, query params, config files, env vars, or `postMessage`.
3. **Strict Execution Bounds:**
   - HTTP server and extension may ONLY perform `POST` to `FEEDBACK_ISSUES_API_URL`.
   - CLI fallback may ONLY invoke `execFile("gh", ["issue", "create", "--repo", "jakehesson/agent-studio", "--title", title, "--body", body, ...], { timeout: 10_000, windowsHide: true })`—never `exec` or shell interpolation.
   - Extension `openExternal` guard: parse `new URL(url)` and verify `url.startsWith(FEEDBACK_NEW_ISSUE_URL)`, `origin === "https://github.com"`, and `pathname === "/jakehesson/agent-studio/issues/new"`.
4. **No Token Leakage:** Keep `GITHUB_TOKEN`/`GH_TOKEN` and VS Code `AuthenticationSession.accessToken` strictly server/extension-host side; never serialize them into responses, logs, URLs, or error strings.

## 3. Contracts & Schemas

### 3.1 Sanitized Diagnostics Allowlist (`FeedbackDiagnostics`)
Both server (`sanitizeFeedbackDiagnostics`) and extension host must pick **only** these fields, enforce bounds, and strip/reject unexpected keys or nested objects:
- `appVersion?: string` (max 32)
- `ide?: "antigravity" | "claude-code" | "copilot-vscode" | "mcp" | "unknown"`
- `model?: string` (max 120)
- `contextTokens?: number` (int >= 0)
- `contextWindow?: number` (int >= 0)
- `contextPercent?: number` (number 0..100)
- `agentCount?: number` (int >= 0)
- `eventCount?: number` (int >= 0)
- `embedMode?: boolean`
- `osPlatform?: string` (server-populated `process.platform`, max 32)

**Forbidden:** workspace paths, filenames, session IDs, user prompts, tool inputs/outputs, or tokens.

### 3.2 Payload & Markdown Format
- `category`: `"bug" | "feature" | "question"` (maps to label `bug` | `enhancement` | `question`, prefixed in title as `[Bug]`, `[Feature]`, `[Question]`).
- `title`: trimmed string, `1..200` chars.
- `description`: trimmed string, `1..4000` chars.
- `includeDiagnostics`: boolean (default `true`).
- `diagnostics`: optional `FeedbackDiagnostics`.
- Body formatter renders `### Description` + optional `### Environment Diagnostics` Markdown table (omitting undefined fields).

### 3.3 Standalone Server Endpoints (`src/server/`)
Note: Keep existing `POST /api/feedback` (Mockups feedback) untouched.
- **`GET /api/feedback/status`** -> `200 { ok: true, repo: "jakehesson/agent-studio", directAvailable: boolean, method: "github-token" | "gh-cli" | "none", newIssueUrl: FEEDBACK_NEW_ISSUE_URL, appVersion: string }`
  - `method`: `"github-token"` if `GITHUB_TOKEN || GH_TOKEN` non-empty; else `"gh-cli"` if `gh` executable is present (`execFile("gh", ["--version"], { timeout: 2000, windowsHide: true })` exits `0`, zero other `gh` subcommands); else `"none"`.
- **`POST /api/feedback/github-issue`** (body cap `32 KB`, strict Zod schema):
  1. Validate & sanitize payload (`400 { ok: false, error }` on invalid input).
  2. If env token exists, `POST FEEDBACK_ISSUES_API_URL` (`timeout: 10_000`). On `201`, return `{ ok: true, mode: "created", issueUrl, issueNumber }`.
  3. Otherwise (or on token error if `gh` is authenticated), invoke `execFile("gh", ["issue", "create", "--repo", "jakehesson/agent-studio", "--title", ..., "--body", ..., "--label", ...])`. If `gh` rejects unknown label, retry once without `--label`.
  4. On CLI/network/auth failure, return `200 { ok: true, mode: "fallback", prefillUrl, reason }` where `prefillUrl` starts with `FEEDBACK_NEW_ISSUE_URL`.

### 3.4 Extension Host <-> Iframe Bridge (`embed=1`)
`StudioPanel` validates iframe messages (`event.source === frame.contentWindow && expectedOrigin && event.origin === expectedOrigin`) and replies only to `expectedOrigin`:
- `agentStudio:feedbackStatusRequest` `{ requestId }` -> host checks `vscode.authentication.getSession("github", ["public_repo"], { silent: true })`, responds `agentStudio:feedbackStatus` `{ requestId, githubAuthAvailable: boolean, accountLabel?: string }`.
- `agentStudio:submitFeedback` `{ requestId, payload }` -> host sanitizes payload, requests `getSession("github", ["public_repo"], { createIfNone: true })`, `POST`s to `FEEDBACK_ISSUES_API_URL`, returns `agentStudio:submitFeedbackResult` `{ requestId, ok: true, mode: "created", issueUrl, issueNumber }` or `{ requestId, ok: false, mode: "fallback", fallbackUrl, reason }`.
- `agentStudio:openFeedbackUrl` `{ url }` -> validates `FEEDBACK_NEW_ISSUE_URL` prefix/origin before `vscode.env.openExternal`.

### 3.5 Client / MCP App Fallback URL Builder (`web/`)
Build `${FEEDBACK_NEW_ISSUE_URL}?title=...&body=...&labels=...`. Cap total URL length at `<= 6000` chars by truncating `body` with `\n\n...[truncated; paste full details]` and surfacing a UI truncation warning + "Copy Markdown" button.

## 4. Edge Cases & UX Requirements
- **GitHub REST `labels`:** Non-collaborator OAuth tokens ignore `labels` on public repos; treat label application as best-effort.
- **Galaxy Z Fold 7 & Accessibility:** `FeedbackDialog` uses native `<dialog closedby="any">`, keyboard focus return, `44px` touch targets (`pointer: coarse`), `100dvh` bottom-sheet presentation on `<640px`, and no overflow at `360px` / `720px` / desktop.

## 5. Exclusive Parallel File Ownership
- **`backend-engineer` (`src/`, `extension/`, `tests/`):**
  - New: `src/server/feedback.ts`, `extension/src/feedback.ts`, `tests/unit/feedback.test.ts`
  - Modified: `src/server/http-server.ts`, `src/server/index.ts`, `extension/src/webviewProvider.ts`
- **`frontend-engineer` (`web/`):**
  - New: `web/src/components/FeedbackDialog.ts`, `web/src/utils/feedbackUrl.ts`
  - Modified: `web/src/types.ts`, `web/src/api.ts`, `web/src/components/ContextBar.ts`, `web/src/app.ts`, `web/src/styles/studio.css`, `web/src/styles/responsive.css`

## 6. Verification Checklist
- Unit tests (`tests/unit/feedback.test.ts`): constant lock, target-override rejection, `sanitizeFeedbackDiagnostics` key stripping & max lengths, `execFile` args (no shell), `openExternal` URL guard, `6000`-char URL truncation, and `POST /api/feedback/github-issue` fallback behavior.
- Checkpoints: `CP0` (`npm run check && npm test`), `CP1` (`npm --prefix web run check && npm --prefix web run build`), `CP2` (`python tests/smoke_test.py`), plus `npm --prefix extension run compile`.
