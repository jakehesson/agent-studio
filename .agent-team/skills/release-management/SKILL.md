---
name: release-management
description: Step-by-step playbook for preparing an Agent Studio release (SemVer lockstep, CHANGELOG.md curation, full CI/packaging verification, release.yml verification, incremental session-scoped task/milestone commits, and pre-push checklist).
---

# Release Management Playbook

## Ongoing: Session-Scoped Task & Milestone Commits

1. **Draft Summary & Description Incrementally**
   - Maintain a Conventional Commit summary (`<type>(<scope>): <summary>`) and a concise bulleted body describing the active task or milestone as changes land.
2. **Select Only Current-Session Changes**
   - Inspect `git status --short` and **never** run blind `git add .` or `git add -A`.
   - Stage only the explicit file paths modified during the current session (`git add -- <session-files...>`), verify with `git diff --cached --stat`, and isolate any mixed-edit files before committing.
3. **Create Local Milestone / Task Commit**
   - Commit locally using `git commit -m "<type>(<scope>): <summary>" -m "<bulleted body>"`.
   - Never push commits or tags without explicit user approval.

## Preparing a Release

Follow this sequence whenever preparing a new **Agent Studio** release:

1. **Confirm Target Version (SemVer)**
   - Minor bump (`0.x.0 -> 0.(x+1).0`) for new features; patch bump (`0.x.y -> 0.x.(y+1)`) for standalone bug fixes.
   - Update `"version"` in strict lockstep across:
     - `package.json`
     - `web/package.json`
     - `extension/package.json`
     - `extension/src/mcpProvider.ts` (fallback version)
     - `src/mcp/server.ts` (fallback version)
     - `web/src/mcp-app-entry.ts` (`new App({ name: "Agent Studio", version: "..." })`)
     - `README.md` / `docs/` version references (if applicable)
   - Refresh lockfiles without changing dependencies:
     ```bash
     npm install --package-lock-only
     npm --prefix web install --package-lock-only
     npm --prefix extension install --package-lock-only
     ```

2. **Curate `CHANGELOG.md`**
   - Add a `## [<version>] - YYYY-MM-DD` section at the top of `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) (`Added`, `Changed`, `Fixed`, `Security`).
   - Verify `.github/workflows/release.yml` extracts the exact `## [<version>]` section cleanly (matching `TAG_VERSION="${GITHUB_REF_NAME#v}"`).

3. **Verify QA Validation Status (Do Not Re-Run QA Suites)**
   - Check via `agent-studio` MCP (`testrun` / `board`) or the orchestrator handoff that `qa-validator` has already recorded closed, passing `testrun`s covering all items in the release.
   - Do **not** re-run `npm test` or `python tests/smoke_test.py` when QA has already signed off (since release edits only touch version lockstep, `CHANGELOG.md`, and docs). If QA sign-off is missing or stale after code changes, flag `orchestrator` / `qa-validator` rather than duplicating QA.

4. **Run Build, Lockstep & Packaging Verification Pipeline**
   ```bash
   npm run check
   npm --prefix web run check
   npm --prefix extension run check
   npm run build:all
   npm --prefix extension run package
   node antigravity-plugin/scripts/build-plugin.mjs
   node dist/cli/index.js sync --check
   npm pack --dry-run
   ```
   - Confirm `extension/agent-studio-<version>.vsix` exists and `antigravity-plugin/dist/plugin.json` reports `<version>`.

5. **Verify Privacy & Release Hygiene**
   - Ensure zero personal paths, hostnames, UUIDs, or `pipeline/board.json` are staged.
   - Verify `SECURITY.md` lists the current minor branch (e.g. `0.5.x`) as supported.

6. **Install Local IDE Plugins & Extensions for Pre-Push Testing**
   - Refresh the native Antigravity MCP App plugin (`~/.gemini/config/plugins/agent-studio/`) and install `./extension/agent-studio-<version>.vsix --force` into every available local IDE CLI on `PATH`, explicitly checking **Antigravity IDE** (`antigravity-ide`, plus fallback aliases `antigravity` / `agy`) and **VS Code** (`code`, plus `code-insiders` if present):
     ```bash
     node antigravity-plugin/scripts/build-plugin.mjs --install
     code --install-extension ./extension/agent-studio-<version>.vsix --force
     antigravity-ide --install-extension ./extension/agent-studio-<version>.vsix --force
     # Fallback if Antigravity IDE exposes `antigravity` or `agy` instead of `antigravity-ide`:
     # antigravity --install-extension ./extension/agent-studio-<version>.vsix --force
     # agy --install-extension ./extension/agent-studio-<version>.vsix --force
     ```
   - Verify post-install versions: run `<cli> --list-extensions --show-versions` (filtered to `agent-studio`) for each detected IDE CLI and confirm `~/.gemini/config/plugins/agent-studio/plugin.json` matches `<version>`. Report the exact installed version per IDE (and warn explicitly if no Antigravity IDE CLI is found on `PATH` or if a version mismatches).
   - Remind the user to reload IDE windows / refresh the `agent-studio-app` MCP server to test locally before approving `git push`.

7. **Prepare Pre-Push / Pre-Tag Checklist for User Approval**
   - Never run `git push` or force-push without explicit user confirmation.
   - Present the exact commit, tag, and push commands for the user to approve or execute:
     ```bash
     git tag -a v<version> -m "Release v<version>"
     git push origin main --follow-tags
     ```
