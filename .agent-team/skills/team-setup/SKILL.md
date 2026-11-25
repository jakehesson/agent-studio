---
name: team-setup
description: Onboard or update any repository for IDE-agnostic multi-agent orchestration (Antigravity, Claude Code, GitHub Copilot / VS Code) using agent-studio.
---

# Agent Studio Team Setup Skill

## Purpose
Guides the `team-setup` AI agent (or human developer) through safe, deterministic multi-IDE onboarding.

## Golden Rules
1. **Canonical Source:** Edit ONLY `.agent-team/team.yaml`, `.agent-team/model-index.json`, `.agent-team/agents/*.md`, and `.agent-team/skills/*/SKILL.md`.
2. **Never Hand-Edit Compiled Outputs:** Always run `npx agent-studio sync` to regenerate IDE adapters cleanly.
3. **Preserve Existing Work:** `init` never clobbers an existing `pipeline/board.json`, and `sync` uses managed Markdown blocks and key-scoped JSON merges.
4. **Verify Health:** Finish every setup or config change with `npx agent-studio doctor` and `npx agent-studio sync --check`.

## Quick Commands
- Global bootstrap (`team-setup` in all IDEs): `npx agent-studio init --global`
- Project bootstrap: `npx agent-studio init --ides antigravity,claude-code,copilot-vscode --non-interactive`
- Inspect/update model routing: `npx agent-studio models show` / `npx agent-studio models set-policy prefer-fallback --sync`
- Recompile after `.agent-team/` edits: `npx agent-studio sync`
- CI / QA drift check: `npx agent-studio sync --check`
- Diagnostics: `npx agent-studio doctor`
- Launch Web Studio: `npx agent-studio serve --open`
