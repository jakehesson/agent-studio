---
name: qa-validation
description: Execute verification checkpoints, record formal testruns via agent-studio MCP, and enforce the test-to-done QA gate.
---

# QA Validation Skill

## Verification Sequence
1. Review the item's acceptance criteria (`board { op: "show", itemId }`) and diff/changed files.
2. Start a testrun via MCP: `testrun { op: "start", suite: "smoke", items: ["<ID>"] }`.
3. Run every checkpoint command declared in `.agent-team/team.yaml` (`CP0`, `CP1`, ...).
4. **Version Lockstep Check (when releasing features or bug fixes):** Confirm `package.json`, `extension/package.json`, and `web/package.json` share the bumped SemVer version and that the packaged `extension/agent-studio-<version>.vsix` matches it.
5. Record each checkpoint result: `testrun { op: "record", runId, checkpoint: "CP0", result: "pass|fail", note: "..." }`.
6. Close the testrun: `testrun { op: "close", runId }`.
7. On pass: move item `test -> done` (or notify `orchestrator`). On failure: file a bug with reproduction steps and move the item back to `dev`.
