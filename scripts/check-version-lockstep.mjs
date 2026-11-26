#!/usr/bin/env node
/**
 * Verifies exact SemVer lockstep across all Agent Studio package manifests
 * and runtime fallback version constants.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SEMVER_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @typedef {{ label: string; relPath: string; extract: (raw: string) => string | null }} VersionTarget
 */

/** @type {VersionTarget[]} */
const TARGETS = [
  {
    label: "package.json",
    relPath: "package.json",
    extract: (raw) => {
      const parsed = JSON.parse(raw);
      return typeof parsed?.version === "string" ? parsed.version.trim() : null;
    },
  },
  {
    label: "web/package.json",
    relPath: "web/package.json",
    extract: (raw) => {
      const parsed = JSON.parse(raw);
      return typeof parsed?.version === "string" ? parsed.version.trim() : null;
    },
  },
  {
    label: "extension/package.json",
    relPath: "extension/package.json",
    extract: (raw) => {
      const parsed = JSON.parse(raw);
      return typeof parsed?.version === "string" ? parsed.version.trim() : null;
    },
  },
  {
    label: "src/mcp/server.ts (resolveServerVersion fallback)",
    relPath: "src/mcp/server.ts",
    extract: (raw) => {
      const fnMatch =
        /function\s+resolveServerVersion\s*\([^)]*\)\s*:\s*string\s*\{[\s\S]*?\n\s*return\s+"([^"]+)"\s*;\s*\n\}/.exec(
          raw,
        );
      return fnMatch?.[1]?.trim() ?? null;
    },
  },
  {
    label: "extension/src/mcpProvider.ts (readExtensionVersion fallback)",
    relPath: "extension/src/mcpProvider.ts",
    extract: (raw) => {
      const fnMatch =
        /function\s+readExtensionVersion\s*\([^)]*\)\s*:\s*string\s*\{[\s\S]*?\n\s*return\s+"([^"]+)"\s*;\s*\n\}/.exec(
          raw,
        );
      return fnMatch?.[1]?.trim() ?? null;
    },
  },
  {
    label: "web/src/mcp-app-entry.ts (App version)",
    relPath: "web/src/mcp-app-entry.ts",
    extract: (raw) => {
      const appMatch =
        /new\s+App\s*\(\s*\{\s*name:\s*"Agent Studio"\s*,\s*version:\s*"([^"]+)"\s*\}/.exec(
          raw,
        );
      return appMatch?.[1]?.trim() ?? null;
    },
  },
];

function main() {
  const results = [];
  let hasError = false;

  for (const target of TARGETS) {
    const absPath = path.join(REPO_ROOT, target.relPath);
    if (!fs.existsSync(absPath)) {
      results.push({
        ...target,
        version: null,
        error: "File not found",
      });
      hasError = true;
      continue;
    }
    try {
      const raw = fs.readFileSync(absPath, "utf8");
      const version = target.extract(raw);
      if (!version || !SEMVER_RE.test(version)) {
        results.push({
          ...target,
          version: version ?? "<missing>",
          error: "Could not extract valid SemVer version",
        });
        hasError = true;
        continue;
      }
      results.push({ ...target, version, error: null });
    } catch (err) {
      results.push({
        ...target,
        version: null,
        error: err instanceof Error ? err.message : String(err),
      });
      hasError = true;
    }
  }

  const expected = results[0]?.error === null ? results[0].version : null;
  const uniqueVersions = new Set(
    results.filter((r) => r.error === null).map((r) => r.version),
  );
  if (uniqueVersions.size > 1) {
    hasError = true;
  }

  if (hasError || !expected) {
    console.error("[FAIL] Version lockstep check failed:\n");
    for (const r of results) {
      if (r.error) {
        console.error(
          `  - ${r.relPath.padEnd(32)} : ERROR (${r.error}) [extracted: ${r.version ?? "none"}]`,
        );
      } else if (expected && r.version !== expected) {
        console.error(
          `  - ${r.relPath.padEnd(32)} : ${r.version}  <-- MISMATCH (expected ${expected})`,
        );
      } else {
        console.error(`  - ${r.relPath.padEnd(32)} : ${r.version}`);
      }
    }
    console.error(
      "\nEnsure all 6 files share the exact same SemVer version before proceeding.",
    );
    process.exit(1);
  }

  console.log(
    `[OK] Version lockstep verified: ${expected} across ${results.length} files.`,
  );
}

main();
