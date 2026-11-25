## Summary
<!-- Briefly describe what this PR changes and why. -->

## Related Issue / Board Item
<!-- Link issue(s) or board item IDs if applicable. -->

## Checklist
- [ ] Edited canonical `.agent-team/` sources (not hand-edited compiled IDE files) and ran `node dist/cli/index.js sync` if team configs changed
- [ ] Zero personal paths, hostnames, UUIDs, or private transcripts introduced
- [ ] Lockstep SemVer preserved across `package.json`, `web/package.json`, `extension/package.json`, `src/mcp/server.ts`, and `web/src/mcp-app-entry.ts` (if version bumped)
- [ ] Ran verification checks:
  - [ ] `npm run check && npm --prefix web run check && npm --prefix extension run check`
  - [ ] `npm run build:all && npm --prefix extension run package && node antigravity-plugin/scripts/build-plugin.mjs`
  - [ ] `npm test`
  - [ ] `node dist/cli/index.js sync --check`
  - [ ] `python tests/smoke_test.py`
  - [ ] `npm pack --dry-run`
