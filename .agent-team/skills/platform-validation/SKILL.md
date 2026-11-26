---
name: platform-validation
description: Cross-platform validation matrix and hard invariants for Antigravity, Claude Code, and VS Code Copilot adapters, hooks, telemetry correlation, context/model tracking, and live UI follow.
---

# Cross-Platform Validation Matrix & Invariants

Use this rubric alongside the three platform specialists (`vscode-copilot-specialist`, `claude-code-specialist`, `antigravity-specialist`) whenever validating compiler outputs, hooks, telemetry adapters, or live Studio behavior.

## 1. Platform Comparison Matrix

| Dimension | Antigravity (`antigravity`) | Claude Code (`claude-code`) | VS Code Copilot (`copilot-vscode`) |
| :--- | :--- | :--- | :--- |
| **Compiled Outputs** | `.agents/plugins/<id>/` (`plugin.json`, `agents/*.md`, `rules/AGENTS.md`, `skills/*/SKILL.md`), `antigravity-plugin/` | `.claude/agents/*.md`, `.claude/settings.json`, `.mcp.json`, `CLAUDE.md` | `.github/agents/*.agent.md`, `.github/skills/*/SKILL.md`, `.github/hooks/agent-studio.json`, shared `.mcp.json` (or `.vscode/mcp.json` under `legacy-local`) |
| **Model Routing** | Portable tier enums (`flash_lite`/`flash`/`pro`/`inherit`); `orchestrator` uses `inherit` under `deferToHostOrchestrator` for `/swarm` & UI picker | Family aliases (`haiku`/`sonnet`/`opus`/`inherit`) yielding to `CLAUDE_CODE_SUBAGENT_MODEL` and `/model` | Runtime IDs (`claude-sonnet-4.6`, etc.) in picker arrays with `model-policy: preferred` (omitted on `defer-to-host`) for Fusion/Auto compatibility |
| **Hook & Containment Contract** | Capability-stripped `orchestrator` + `.agents/plugins/` rules | `PreToolUse` deny exits `0` with `hookSpecificOutput.permissionDecision: "deny"` on stdout; `PostToolUseFailure` enabled; no `MultiEdit` | 10 camelCase hooks (`sessionStart`..`sessionEnd`) via `json-merge` (`timeoutSec: 5`, no `managedBy`); camelCase `preToolUse` deny emits `{ permissionDecision: "deny", permissionDecisionReason }` + exit `0`; `subagentStart`/`subagentStop` emit `actor: "root"` + `targetAgentId` |
| **Telemetry Source & Discovery** | Passive JSONL transcripts (`AntigravityAdapter`): full-file cached scan beyond 32KB (`CREATED_SUBAGENT_RE`, `isMultiAgent`, `file:///` `workspaceUris`, tail `status`) | Passive JSONL (`ClaudeCodeAdapter`): hyphenated workspace matching, `subagents/agent-*.jsonl` correlated with `Agent`/`Task` & `mtimeMs` | Hybrid PushBus + `CopilotVSCodeAdapter` across `Code`, `Code - Insiders`, `VSCodium` (`chatSessions/*.json(l)`, `GitHub.copilot-chat/transcripts/*.jsonl`, `$COPILOT_HOME/session-state/*/events.jsonl`, `transcript_path`) |
| **Session Correlation & Dedup** | `openToolCalls` (`invoke_subagent`/`send_message`/`notify_user`), parallel `pendingSpawns`, `manage_subagents` | Deduplicate streaming `type: "assistant"` usage by `(agentId, message.id)`; Tier-1 dedup across `Agent`/`Task`, `SendMessage`, `AskUserQuestion`, board ops | `PushBus.subagentToParent` re-homes in-order & out-of-order subagent `session_id`s to parent; zero orphan sessions |
| **Context, Tokens & Live UI** | Decimal `MODEL_SELECTION_RE`, 1M default context window, `lastTurnContext = inTok + cachedTok`; `heartbeatTimer` hash-diff SSE; `open_studio` / `app.html` | Non-monotonic `lastTurnContext = inTok + cachedTok + outTok` (respects `/compact`); `[1m]` 1M context windows; MCP App multi-IDE filtering | `app.ts` SSE session pinning (`stream.updateParams`) + mismatch drop guard; server-authoritative `snapshot.ts`/`LiveStudio.ts` (no phantom `subagent-<hash>`); `StudioPanel` preserves `sessionId` |

## 2. Non-Negotiable Cross-Platform Invariants
1. **Zero Drift & Determinism:** `node dist/cli/index.js sync` followed by `sync --check` and `doctor` must pass with zero drift and without reading Layer 1 (`~/.agent-studio/model-index.json`) unless `--use-global-index` is requested.
2. **Strict Read-Only Orchestrator:** Across all three IDEs, `orchestrator` never receives edit/write/shell tools, and `PreToolUse` / hook rules block direct edits to `pipeline/board.json`.
3. **Single Authoritative Session Tree:** Subagent events must correlate under their parent orchestrator session (never spawning orphan sessions or phantom `subagent-<hash>` UI nodes).
4. **Accurate Non-Monotonic Context & Model Accounting:** `lastTurnContext` must reflect the latest turn (decreasing after `/compact` or new smaller turns), and streaming/hook duplicates must never inflate token totals.
5. **Embedded Extension Scoping (`embed=1`):** Extension panels detect host IDE (`antigravity` vs `copilot-vscode`) and workspace root, hiding cross-IDE/cross-project chrome while preserving full switching in standalone Web Studio.

## 3. VS Code / Copilot & GHE Verified Schema Invariants
- **UI Navigation Pointer:** Studio header lives in `web/src/components/ContextBar.ts` (not `TopBar.ts`).
- **Inclusive Prompt Tokens:** OpenAI/Copilot `promptTokens`/`inputTokens` are **inclusive** of `cachedTokens` (unlike Anthropic/Claude Code's fresh-only `input_tokens`); normalize via `normalizeCopilotUsage` strictly for `copilot-vscode`.
- **Incremental vs. Cumulative Events:** `~/.copilot/session-state/*/events.jsonl` mixes incremental rows (`assistant.message`, `session.usage_record`) with cumulative checkpoints (`session.usage_checkpoint`, `session.shutdown` `modelMetrics`) — use one source and never sum both.
- **Chat Session Limits & Empty Links:** `chatSessions/*.jsonl` exposes host limits at `inputState.selectedModel.metadata.maxInputTokens` and emits empty-label Markdown links `[](file:///...)` — extract the URI basename for display.
- **Hook Root Guard & Synced Namespace:** VS Code hooks echo `agent_id === sessionId` / `parent_agent_id === sessionId` on root turns (guard to `"root"`) and prefix synced subagents with `"VS Code Synced Data:"` (strip prefix during reconciliation).
