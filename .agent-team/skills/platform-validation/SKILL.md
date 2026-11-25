---
name: platform-validation
description: Cross-platform validation matrix and hard invariants for Antigravity, Claude Code, and VS Code Copilot adapters, hooks, telemetry correlation, context/model tracking, and live UI follow.
---

# Cross-Platform Validation Matrix & Invariants

Use this rubric alongside the three platform specialists (`vscode-copilot-specialist`, `claude-code-specialist`, `antigravity-specialist`) whenever validating compiler outputs, hooks, telemetry adapters, or live Studio behavior.

## 1. Platform Comparison Matrix

| Dimension | Antigravity (`antigravity`) | Claude Code (`claude-code`) | VS Code Copilot (`copilot-vscode`) |
| :--- | :--- | :--- | :--- |
| **Compiled Outputs** | `.agents/plugins/<id>/` (`plugin.json`, `agents/*.md`, `rules/AGENTS.md`, `skills/*/SKILL.md`), `antigravity-plugin/` | `.claude/agents/*.md`, `.claude/settings.json`, `.mcp.json`, `CLAUDE.md` | `.github/agents/*.agent.md`, `.github/hooks/agent-studio.json`, `.vscode/mcp.json` |
| **Model Routing** | Portable tier enums (`flash_lite`/`flash`/`pro`/`inherit`); `orchestrator` uses `inherit` under `deferToHostOrchestrator` for `/swarm` & UI picker | Family aliases (`haiku`/`sonnet`/`opus`/`inherit`) yielding to `CLAUDE_CODE_SUBAGENT_MODEL` and `/model` | Picker arrays with `model-policy: preferred` (omitted on `defer-to-host`) for Fusion/Auto compatibility |
| **Hook & Containment Contract** | Capability-stripped `orchestrator` + `.agents/plugins/` rules | `PreToolUse` deny exits `0` with `hookSpecificOutput.permissionDecision: "deny"` on stdout; `PostToolUseFailure` enabled; no `MultiEdit` | 8 hooks (`SessionStart`..`PreCompact`) using single `timeoutSec` (no conflicting `timeout`); `SubagentStart`/`SubagentStop` emit `actor: "root"` + `targetAgentId` |
| **Telemetry Source & Discovery** | Passive JSONL transcripts (`AntigravityAdapter`): full-file cached scan beyond 32KB (`CREATED_SUBAGENT_RE`, `isMultiAgent`, `file:///` `workspaceUris`, tail `status`) | Passive JSONL (`ClaudeCodeAdapter`): hyphenated workspace matching, `subagents/agent-*.jsonl` correlated with `Agent`/`Task` & `mtimeMs` | Hybrid PushBus + `CopilotVSCodeAdapter` across `Code`, `Code - Insiders`, `VSCodium` (`chatSessions/*.json(l)`, `GitHub.copilot-chat/transcripts/*.jsonl`, `transcript_path`) |
| **Session Correlation & Dedup** | `openToolCalls` (`invoke_subagent`/`send_message`/`notify_user`), parallel `pendingSpawns`, `manage_subagents` | Deduplicate streaming `type: "assistant"` usage by `(agentId, message.id)`; Tier-1 dedup across `Agent`/`Task`, `SendMessage`, `AskUserQuestion`, board ops | `PushBus.subagentToParent` re-homes in-order & out-of-order subagent `session_id`s to parent; zero orphan sessions |
| **Context, Tokens & Live UI** | Decimal `MODEL_SELECTION_RE`, 1M default context window, `lastTurnContext = inTok + cachedTok`; `heartbeatTimer` hash-diff SSE; `open_studio` / `app.html` | Non-monotonic `lastTurnContext = inTok + cachedTok + outTok` (respects `/compact`); `[1m]` 1M context windows; MCP App multi-IDE filtering | `app.ts` SSE session pinning (`stream.updateParams`) + mismatch drop guard; server-authoritative `snapshot.ts`/`LiveStudio.ts` (no phantom `subagent-<hash>`); `StudioPanel` preserves `sessionId` |

## 2. Non-Negotiable Cross-Platform Invariants
1. **Zero Drift & Determinism:** `node dist/cli/index.js sync` followed by `sync --check` and `doctor` must pass with zero drift and without reading Layer 1 (`~/.agent-studio/model-index.json`) unless `--use-global-index` is requested.
2. **Strict Read-Only Orchestrator:** Across all three IDEs, `orchestrator` never receives edit/write/shell tools, and `PreToolUse` / hook rules block direct edits to `pipeline/board.json`.
3. **Single Authoritative Session Tree:** Subagent events must correlate under their parent orchestrator session (never spawning orphan sessions or phantom `subagent-<hash>` UI nodes).
4. **Accurate Non-Monotonic Context & Model Accounting:** `lastTurnContext` must reflect the latest turn (decreasing after `/compact` or new smaller turns), and streaming/hook duplicates must never inflate token totals.
5. **Embedded Extension Scoping (`embed=1`):** Extension panels detect host IDE (`antigravity` vs `copilot-vscode`) and workspace root, hiding cross-IDE/cross-project chrome while preserving full switching in standalone Web Studio.
