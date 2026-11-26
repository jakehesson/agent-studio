---
name: agile-board-workflow
description: Manage sprints, backlog items, bugs, and QA-gated lifecycle transitions via the agent-studio MCP server.
---

# Agile Board Workflow

## Core Invariants
1. **Single Source of Truth:** Track all sprint work in `pipeline/board.json` exclusively through the `agent-studio` MCP (`board`, `testrun`, `projects`) or `agent-studio board ...` CLI.
2. **Never Hand-Edit `board.json`:** Direct edits bypass atomic locking, audit notes, and QA gate enforcement (and are blocked by `PreToolUse` hooks).
3. **Lifecycle Stages:** `ready -> design -> dev -> test -> done`.
4. **QA Gate:** Moving an item `test -> done` is rejected by the MCP server unless a closed, passing `testrun` covers its required suite.

## Standard Operations
- Inspect sprint status: `board { op: "status" }`
- Find next unblocked item: `board { op: "next" }`
- Inspect item details: `board { op: "show", itemId: "<ID>" }`
- Add work or bug: `board { op: "add", type: "task|story|bug", title: "...", role: "..." }`
- Record progress note: `board { op: "note", itemId: "<ID>", text: "..." }`
- Checkpoint context handoff: `board { op: "handoff", itemId: "<ID>", kind: "fresh_context|task_split", summary: "...", modifiedFiles: [...], remainingWork: [...], continuationBrief: "..." }`
- Execute orchestrator split: `board { op: "split", itemId: "<ID>" }` (creates child tasks from `split_proposals` and sets `split_from`)
- Transition state: `board { op: "move", itemId: "<ID>", state: "design|dev|test|done" }`
- Check release gate: `board { op: "gate" }`
