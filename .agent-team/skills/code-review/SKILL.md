---
name: code-review
description: Universal 5-pillar code review rubric covering syntax/types, security, architecture conformance, performance/concurrency, and test coverage before QA gate sign-off.
---

# Code Review Skill (5-Pillar Rubric)

## Read-Only Containment
- Perform reviews strictly read-only (`git diff`, `git status`, search, typecheck, linter, and targeted test runs).
- Never modify repository source files, tests, docs, or `pipeline/board.json` directly.

## Five Review Pillars
1. **Syntax, Types & Correctness:** Type soundness, null/undefined handling, exhaustiveness, schema/contract alignment, dead code, and error propagation.
2. **Security & Trust Boundaries:** Injection (SQL/shell/HTML/XSS), path traversal and symlink escape, authn/authz enforcement, secret exposure, input bounds/payload caps, and unsafe deserialization.
3. **Architecture Conformance:** Compliance with repo-specific layering, dependency direction, invariants, and rules in `skills/architecture-review/SKILL.md` and the active Architect spec.
4. **Performance, Resource & Concurrency Safety:** Algorithmic complexity, N+1 queries, unbounded loops/buffers, race conditions, lock acquisition/release (`finally` cleanup), async timeouts/backpressure, and resource/memory leaks.
5. **Test Coverage & Edge Cases:** Happy path plus failure/boundary tests, regression coverage for bug fixes, deterministic mocks/temp isolation, and no skipped or relaxed assertions.

## Finding Classification
- **`[P0 Blocker]`** — Security flaw, data corruption, crash, race condition, or violated hard invariant (must return `test -> dev`; file bug via `board { op: "add", type: "bug" }`).
- **`[P1 Required]`** — Missing test coverage for core logic, broken boundary/error handling, architectural violation, or significant perf regression (must resolve before QA gate).
- **`[P2 Advisory]`** — Non-blocking clarity, naming, or minor refactor suggestions.

## Board Handoff
- Post a structured review summary (`CODE REVIEW PASS` or `CODE REVIEW CHANGES REQUESTED` with `file:line` citations) via `board { op: "note" }`.
- On `CODE REVIEW CHANGES REQUESTED` with blockers, file bugs and transition the item back to `dev`; on `CODE REVIEW PASS`, clear for `qa-validator`.
