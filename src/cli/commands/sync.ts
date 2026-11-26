import fs from "node:fs";
import path from "node:path";
import { resolveProject } from "../../board/registry.js";
import {
  checkTeamDrift,
  compileTeam,
  type CompileResult,
} from "../../compiler/index.js";
import type { DriftReport } from "../../compiler/merge.js";
import { IdeTargetSchema, type IdeTarget } from "../../schema/team.js";

export interface SyncCommandResult {
  mode: "sync" | "check";
  ok: boolean;
  exitCode: number;
  projectRoot: string;
  compileResult?: CompileResult;
  drift?: DriftReport;
}

function parseIdeList(raw: string): IdeTarget[] {
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Expected at least one IDE target for --ides.");
  }
  return tokens.map((token) => IdeTargetSchema.parse(token));
}

function parseSyncArgs(args: string[]): {
  projectRef?: string;
  ides?: IdeTarget[];
  check: boolean;
  force: boolean;
  useGlobalIndex: boolean;
  json: boolean;
  quiet: boolean;
} {
  let projectRef: string | undefined;
  let ides: IdeTarget[] | undefined;
  let check = false;
  let force = false;
  let useGlobalIndex = false;
  let json = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token) continue;
    if (token === "--check") {
      check = true;
    } else if (token === "--force") {
      force = true;
    } else if (token === "--use-global-index") {
      useGlobalIndex = true;
    } else if (token === "--json") {
      json = true;
    } else if (token === "--quiet") {
      quiet = true;
    } else if (token === "--project" && args[i + 1]) {
      projectRef = args[++i];
    } else if (token.startsWith("--project=")) {
      projectRef = token.slice("--project=".length);
    } else if (token === "--ides" && args[i + 1]) {
      ides = parseIdeList(args[++i]!);
    } else if (token.startsWith("--ides=")) {
      ides = parseIdeList(token.slice("--ides=".length));
    }
  }

  return { projectRef, ides, check, force, useGlobalIndex, json, quiet };
}

function resolveProjectRootArg(projectRef?: string): string {
  if (!projectRef) {
    return path.resolve(process.cwd());
  }
  const directPath = path.resolve(projectRef);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isDirectory()) {
    return directPath;
  }
  return resolveProject(projectRef).root;
}

export async function runSync(args: string[]): Promise<SyncCommandResult> {
  const parsed = parseSyncArgs(args);
  const projectRoot = resolveProjectRootArg(parsed.projectRef);

  if (parsed.check) {
    const drift = checkTeamDrift(projectRoot, {
      ides: parsed.ides,
      useGlobalIndex: parsed.useGlobalIndex,
    });
    const result: SyncCommandResult = {
      mode: "check",
      ok: drift.ok,
      exitCode: drift.ok ? 0 : 1,
      projectRoot,
      drift,
    };

    if (!parsed.quiet) {
      if (parsed.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else if (drift.ok) {
        process.stdout.write(
          `[agent-studio] sync --check PASS (${drift.checkedCount} files in sync).\n`,
        );
      } else {
        const lines = [
          `[agent-studio] sync --check FAILED: ${drift.entries.length} drifted file(s):`,
          ...drift.entries.map(
            (e) => `  - [${e.status}] ${e.path} (${e.ide}): ${e.reason}`,
          ),
          `Run "agent-studio sync --project ${projectRoot}" to reconcile.`,
        ];
        process.stderr.write(lines.join("\n") + "\n");
      }
    }

    if (!drift.ok) {
      process.exitCode = 1;
    }

    return result;
  }

  const compileResult = compileTeam(projectRoot, {
    ides: parsed.ides,
    useGlobalIndex: parsed.useGlobalIndex,
    force: parsed.force,
  });
  const result: SyncCommandResult = {
    mode: "sync",
    ok: true,
    exitCode: 0,
    projectRoot,
    compileResult,
  };

  if (!parsed.quiet) {
    if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      const skippedSummary =
        compileResult.skippedModified.length > 0
          ? `, ${compileResult.skippedModified.length} skipped (modified)`
          : "";
      const cleanedSummary =
        compileResult.cleanedLegacy.length > 0
          ? `, ${compileResult.cleanedLegacy.length} legacy cleaned`
          : "";
      process.stdout.write(
        `[agent-studio] synced ${compileResult.projectId} (${compileResult.targets.join(", ")}): ` +
          `${compileResult.written.length} written, ${compileResult.merged.length} merged, ${compileResult.unchanged.length} unchanged${skippedSummary}${cleanedSummary}.\n`,
      );
      for (const warning of compileResult.warnings) {
        process.stderr.write(`[agent-studio] warning: ${warning}\n`);
      }
    }
  }

  return result;
}
