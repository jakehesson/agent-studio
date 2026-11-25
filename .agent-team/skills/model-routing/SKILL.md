---
name: model-routing
description: Inspect and update Agent Studio's 3-layer Model Index (model-index.json), per-role tiers, and host-compatible IDE routing policies (Antigravity /swarm, VS Code Copilot Fusion/Auto, Claude Code).
---

# Model Routing & Agent-Readable Model Index Skill

## 3-Layer Model Index Architecture
1. **Layer 0 (Built-in Seed):** Default role recommendations, portable tier bindings (`fast`, `balanced`, `reasoning`), and seed catalogs bundled in `agent-studio`.
2. **Layer 1 (Global Overlay):** `~/.agent-studio/model-index.json` (respects `AGENT_STUDIO_HOME`). Stores live `vscode.lm` discovered models and user-level defaults. Not Git-tracked.
3. **Layer 2 (Workspace Override):** `.agent-team/model-index.json`. Git-tracked project catalog, tier overrides, and role recommendations.

## CI Determinism & Overlay Precedence
- `npx agent-studio sync` and `sync --check` read **Layer 0 + Layer 2 only** unless `--use-global-index` is explicitly passed so CI builds stay deterministic.
- Runtime views (`GET /api/model-index`, `GET /api/team`, `npx agent-studio models show`) merge **Layer 2 > Layer 1 > Layer 0**, upserting catalog entries by `(ide, id)`.

## Host-Compatibility Policies (`workflow.modelRouting.policy`)
- **`prefer-fallback` (default):**
  - **Antigravity:** Emits portable tier enums (`flash_lite`, `flash`, `pro`) — compatible with `/swarm` and UI selection.
  - **Claude Code:** Emits family aliases (`haiku`, `sonnet`, `opus`) — yields automatically to `CLAUDE_CODE_SUBAGENT_MODEL`, invocation overrides, and `/model`.
  - **VS Code Copilot:** Emits ordered fallback picker arrays (`["Claude Sonnet 4.5 (copilot)", ...]`) with `model-policy: preferred` so Fusion/Auto and org overrides are never blocked.
- **`defer-to-host`:** Emits `model: inherit` for Antigravity/Claude Code and omits `model` & `model-policy` for Copilot (unlocks pure Copilot Fusion/Auto).
- **`pinned`:** Emits explicit model IDs and Copilot `model-policy: required` (bypasses Copilot Auto; `doctor` flags a warning).

## Key Schema Fields
- `.agent-team/model-index.json`: `roleRecommendations.<roleId>.tier`, `ides.<ide>.tiers.<tier>.{primary,fallback,omitOnDefer}`, `ides.<ide>.catalog[]` (`id`, `label`, `tier`, `capabilities`, `available`, `source`).
- `.agent-team/team.yaml`: `workflow.modelRouting.{policy,respectBuiltInOrchestrators,allowSubagentModelHints,copilotHandoffModels,idePolicies}` and `roster[].{modelTier,modelPolicy,models}`.

## Safe Agent & CLI Update Commands
- Inspect effective index & resolved per-IDE models: `npx agent-studio models show`
- Update a tier binding in workspace index: `npx agent-studio models set-tier copilot-vscode balanced "Claude Sonnet 4.5 (copilot)" --fallback "Claude Sonnet 4.5 (copilot),GPT-4.1 (copilot)" --sync`
- Update a role's tier or policy: `npx agent-studio models set-role architect --tier reasoning --sync`
- Switch workflow routing policy: `npx agent-studio models set-policy defer-to-host --sync`
- Upsert a model into catalog: `npx agent-studio models upsert --ide antigravity --id gemini-4-neon --tier reasoning`
- Adopt live Layer 1 models into Git-tracked `.agent-team/model-index.json`: `npx agent-studio models adopt --sync`
- Reset workspace or global overlay: `npx agent-studio models reset --scope workspace --sync`

> **Never hand-edit compiled IDE outputs** (`.agents/plugins/`, `.claude/agents/`, `.github/agents/`). Update `.agent-team/` via CLI or JSON/YAML, then run `npx agent-studio sync`.
