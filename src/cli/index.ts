#!/usr/bin/env node
import {
  boardAdd,
  boardGate,
  boardHandoff,
  boardMove,
  boardNext,
  boardNote,
  boardOwner,
  boardPlan,
  boardReport,
  boardShow,
  boardSplit,
  boardStatus,
  listProjects,
  registerProject,
  resolveProject,
  testrunClose,
  testrunList,
  testrunRecord,
  testrunStart,
  testrunStep,
} from "../board/index.js";
import { MCP_SERVER_INFO, startMcpStdioServer } from "../mcp/server.js";
import type {
  BoardItemType,
  BoardState,
  BugResolution,
  BugSeverity,
} from "../schema/board.js";
import { buildDoctorReport, runDoctor } from "./commands/doctor.js";
import { runHookEmit } from "./commands/hook-emit.js";
import { runInit } from "./commands/init.js";
import { runModelsCli } from "./commands/models.js";
import { runServe } from "./commands/serve.js";
import { runSync } from "./commands/sync.js";
import { runUpgrade } from "./commands/upgrade.js";

interface ParsedFlags {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseArgv(argv: string[]): ParsedFlags {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const raw = token.slice(2);
      const eqIdx = raw.indexOf("=");
      let key: string;
      let value: string | boolean;
      if (eqIdx >= 0) {
        key = raw.slice(0, eqIdx);
        value = raw.slice(eqIdx + 1);
      } else {
        key = raw;
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i++;
        } else {
          value = true;
        }
      }
      const existing = flags[key];
      if (existing === undefined) {
        flags[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(String(value));
      } else {
        flags[key] = [String(existing), String(value)];
      }
    } else if (token === "-h") {
      flags.help = true;
    } else if (token === "-v") {
      flags.version = true;
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

function flagStr(
  flags: ParsedFlags["flags"],
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const v = flags[name];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.length > 0) return v[v.length - 1];
  }
  return undefined;
}

function flagBool(flags: ParsedFlags["flags"], ...names: string[]): boolean {
  for (const name of names) {
    const v = flags[name];
    if (v === true || v === "true" || v === "1") return true;
  }
  return false;
}

function flagList(
  flags: ParsedFlags["flags"],
  ...names: string[]
): string[] | undefined {
  const out: string[] = [];
  for (const name of names) {
    const v = flags[name];
    if (typeof v === "string") {
      out.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (Array.isArray(v)) {
      for (const entry of v) {
        out.push(...entry.split(",").map((s) => s.trim()).filter(Boolean));
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

function printHelp(): void {
  process.stdout.write(
    [
      `${MCP_SERVER_INFO.name} v${MCP_SERVER_INFO.version} — IDE-Agnostic Agent Team Flow & Monitoring Suite`,
      "",
      "Usage:",
      "  agent-studio <command> [subcommand] [options]",
      "",
      "Commands:",
      "  init [--ides ...] [--global] [--project <dir>]   Scaffold .agent-team/, board.json, and compile IDE adapters",
      "  sync [--check] [--force] [--use-global-index]    Compile .agent-team/ into Antigravity, Claude Code & VS Code",
      "  upgrade [--dry-run] [--diff] [--force] [--global] Safely upgrade .agent-team/, models & IDE adapters",
      "  models <op> [options]                            Manage Model Index & routing (show|set-tier|set-role|set-policy|set-questions|upsert|discover|adopt|reset)",
      "  doctor [--project <id|dir>] [--json]             Validate schemas, drift hashes, MCP configs & IDE hooks",
      "  serve [--port 8767] [--host 127.0.0.1] [--open]  Launch unified single-port Web Studio (Live, Board, Mockups, Doctor)",
      "  mcp [--project <id|path>]                        Run stdio MCP server (JSON-RPC 2.0)",
      "  hook-emit --ide <ide> --event <type> [--port N]  Fast IDE hook telemetry & PreToolUse guardrail bridge",
      "  board <op> [--project <id|path>] [...]           Agile Board (status|next|show|add|move|note|owner|handoff|split|plan|gate|report)",
      "  testrun <op> [--project <id|path>] [...]         QA Testruns (start|record|step|close|list)",
      "  projects <list|register|info> [options]          Manage ~/.agent-studio/projects.json",
      "",
    ].join("\n"),
  );
}

async function runProjectsCli(args: string[]): Promise<void> {
  const { positionals, flags } = parseArgv(args);
  const op = positionals[0] ?? "list";
  const asJson = flagBool(flags, "json");

  if (op === "list") {
    const projects = listProjects();
    if (asJson) {
      process.stdout.write(JSON.stringify(projects, null, 2) + "\n");
      return;
    }
    if (projects.length === 0) {
      process.stdout.write("No projects registered.\n");
      return;
    }
    for (const p of projects) {
      process.stdout.write(`${p.id}\t${p.title}\t${p.root}\n`);
    }
    return;
  }

  if (op === "register") {
    const root = positionals[1] ?? flagStr(flags, "root") ?? process.cwd();
    const entry = registerProject({
      id: flagStr(flags, "id"),
      title: flagStr(flags, "title"),
      root,
      boardPath: flagStr(flags, "board-path", "boardPath"),
      setDefault: flagBool(flags, "default", "set-default"),
    });
    process.stdout.write(
      asJson
        ? JSON.stringify(entry, null, 2) + "\n"
        : `registered ${entry.id}: ${entry.title} (${entry.root})\n`,
    );
    return;
  }

  if (op === "info") {
    const ref = positionals[1] ?? flagStr(flags, "project");
    const resolved = resolveProject(ref);
    process.stdout.write(
      JSON.stringify(
        {
          id: resolved.id,
          title: resolved.title,
          root: resolved.root,
          boardPath: resolved.boardPath,
          teamPath: resolved.teamPath,
          qaGateRequired: resolved.qaGateRequired,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  throw new Error(`Unknown projects subcommand: ${op}`);
}

async function runBoardCli(args: string[]): Promise<void> {
  const { positionals, flags } = parseArgv(args);
  const op = positionals[0] ?? "status";
  const project = resolveProject(flagStr(flags, "project"));
  const ctx = { project };
  const asJson = flagBool(flags, "json");
  const actor = flagStr(flags, "actor") ?? "orchestrator";

  let res: { text: string; data: unknown };

  switch (op) {
    case "status":
      res = await boardStatus(ctx, {
        sprint: flagStr(flags, "sprint"),
        showDone: flagBool(flags, "show-done", "showDone"),
      });
      break;
    case "next":
      res = await boardNext(ctx, {
        role: flagStr(flags, "role"),
        limit: flagStr(flags, "limit")
          ? Number.parseInt(flagStr(flags, "limit")!, 10)
          : undefined,
      });
      break;
    case "show": {
      const itemId = positionals[1] ?? flagStr(flags, "id", "item");
      if (!itemId) throw new Error("Usage: agent-studio board show <itemId>");
      res = await boardShow(ctx, { itemId });
      break;
    }
    case "add": {
      const type = (flagStr(flags, "type") ?? positionals[1]) as BoardItemType;
      const title = flagStr(flags, "title") ?? positionals[2];
      const role = flagStr(flags, "role") ?? positionals[3];
      if (!type || !title || !role) {
        throw new Error(
          "Usage: agent-studio board add --type <story|task|bug|spike> --title <text> --role <role>",
        );
      }
      res = await boardAdd(ctx, {
        type,
        title,
        role,
        sprint: flagStr(flags, "sprint"),
        ac: flagList(flags, "ac"),
        deps: flagList(flags, "deps"),
        severity: flagStr(flags, "severity") as BugSeverity | undefined,
        points: flagStr(flags, "points")
          ? Number.parseInt(flagStr(flags, "points")!, 10)
          : undefined,
        actor,
        repro: flagStr(flags, "repro"),
        foundIn: flagStr(flags, "found-in", "foundIn"),
        suite: flagStr(flags, "suite"),
      });
      break;
    }
    case "move": {
      const itemId = positionals[1] ?? flagStr(flags, "id", "item");
      const state = (positionals[2] ?? flagStr(flags, "state")) as BoardState;
      if (!itemId || !state) {
        throw new Error(
          "Usage: agent-studio board move <itemId> <state> [--actor <actor>] [--note <text>]",
        );
      }
      res = await boardMove(ctx, {
        itemId,
        state,
        actor,
        note: flagStr(flags, "note"),
        evidence: flagStr(flags, "evidence"),
        build: flagStr(flags, "build"),
        resolution: flagStr(flags, "resolution") as BugResolution | undefined,
        overrideReason: flagStr(flags, "override-reason", "overrideReason"),
      });
      break;
    }
    case "note": {
      const itemId = positionals[1] ?? flagStr(flags, "id", "item");
      const text = positionals[2] ?? flagStr(flags, "text", "note");
      if (!itemId || !text) {
        throw new Error("Usage: agent-studio board note <itemId> <text>");
      }
      res = await boardNote(ctx, {
        itemId,
        actor,
        text,
        evidence: flagStr(flags, "evidence"),
      });
      break;
    }
    case "owner": {
      const itemId = positionals[1] ?? flagStr(flags, "id", "item");
      const owner = positionals[2] ?? flagStr(flags, "owner");
      if (!itemId || !owner) {
        throw new Error("Usage: agent-studio board owner <itemId> <owner>");
      }
      res = await boardOwner(ctx, { itemId, owner });
      break;
    }
    case "handoff": {
      const itemId = positionals[1] ?? flagStr(flags, "id", "item", "itemId");
      const kind = (flagStr(flags, "kind") ?? "fresh_context") as
        | "fresh_context"
        | "task_split";
      const summary = flagStr(flags, "summary");
      const continuationBrief = flagStr(
        flags,
        "continuation-brief",
        "continuationBrief",
        "brief",
      );
      if (!itemId || !summary || !continuationBrief) {
        throw new Error(
          "Usage: agent-studio board handoff <itemId> --kind <fresh_context|task_split> --summary <text> --brief <text>",
        );
      }
      const splitRaw = flagStr(flags, "split-proposals", "splitProposals");
      let splitProposals:
        | Array<{
            title: string;
            role: string;
            ac: string[];
            deps?: string[];
            rationale?: string;
          }>
        | undefined;
      if (splitRaw) {
        const parsed: unknown = JSON.parse(splitRaw);
        if (!Array.isArray(parsed)) {
          throw new Error("--split-proposals must be a JSON array of split proposal objects");
        }
        splitProposals = (
          parsed as Array<{
            title: string;
            role: string;
            ac?: string[];
            deps?: string[];
            rationale?: string;
          }>
        ).map((p) => ({ ...p, ac: p.ac ?? [] }));
      }
      res = await boardHandoff(ctx, {
        itemId,
        kind,
        actor,
        objective: flagStr(flags, "objective"),
        summary,
        evidence: flagList(flags, "evidence"),
        decisions: flagList(flags, "decisions"),
        assumptions: flagList(flags, "assumptions"),
        unresolvedIssues: flagList(flags, "unresolved-issues", "unresolvedIssues"),
        modifiedFiles: flagList(flags, "modified-files", "modifiedFiles"),
        verifiedChecks: flagList(flags, "verified-checks", "verifiedChecks"),
        remainingWork: flagList(flags, "remaining-work", "remainingWork"),
        continuationBrief,
        splitProposals,
        contextPercent: flagStr(flags, "context-percent", "contextPercent")
          ? Number.parseFloat(flagStr(flags, "context-percent", "contextPercent")!)
          : undefined,
        contextTokens: flagStr(flags, "context-tokens", "contextTokens")
          ? Number.parseInt(flagStr(flags, "context-tokens", "contextTokens")!, 10)
          : undefined,
        contextWindow: flagStr(flags, "context-window", "contextWindow")
          ? Number.parseInt(flagStr(flags, "context-window", "contextWindow")!, 10)
          : undefined,
        sessionId: flagStr(flags, "session-id", "sessionId"),
        agentId: flagStr(flags, "agent-id", "agentId"),
        keepOwner: flagBool(flags, "keep-owner", "keepOwner"),
      });
      break;
    }
    case "split": {
      const itemId = positionals[1] ?? flagStr(flags, "id", "item", "itemId");
      if (!itemId) {
        throw new Error("Usage: agent-studio board split <itemId> [--subtasks <json>]");
      }
      const subtasksRaw = flagStr(flags, "subtasks");
      let subtasks:
        | Array<{
            title: string;
            role: string;
            ac: string[];
            deps?: string[];
            rationale?: string;
          }>
        | undefined;
      if (subtasksRaw) {
        const parsed: unknown = JSON.parse(subtasksRaw);
        if (!Array.isArray(parsed)) {
          throw new Error("--subtasks must be a JSON array of subtask proposal objects");
        }
        subtasks = (
          parsed as Array<{
            title: string;
            role: string;
            ac?: string[];
            deps?: string[];
            rationale?: string;
          }>
        ).map((p) => ({ ...p, ac: p.ac ?? [] }));
      }
      res = await boardSplit(ctx, {
        itemId,
        actor,
        subtasks,
        blockParent: flags["block-parent"] !== undefined || flags.blockParent !== undefined
          ? flagBool(flags, "block-parent", "blockParent")
          : true,
      });
      break;
    }
    case "plan": {
      const sprint = positionals[1] ?? flagStr(flags, "sprint");
      if (!sprint) {
        throw new Error("Usage: agent-studio board plan <sprint> [--goal <text>]");
      }
      res = await boardPlan(ctx, { sprint, goal: flagStr(flags, "goal") });
      break;
    }
    case "gate":
      res = await boardGate(ctx);
      break;
    case "report":
      res = await boardReport(ctx, {
        sprint: flagStr(flags, "sprint"),
        writeFile: flagBool(flags, "write", "writeFile"),
      });
      break;
    default:
      throw new Error(`Unknown board subcommand: ${op}`);
  }

  process.stdout.write(
    asJson ? JSON.stringify(res.data, null, 2) + "\n" : res.text + "\n",
  );
}

async function runTestrunCli(args: string[]): Promise<void> {
  const { positionals, flags } = parseArgv(args);
  const op = positionals[0] ?? "list";
  const project = resolveProject(flagStr(flags, "project"));
  const ctx = { project };
  const asJson = flagBool(flags, "json");

  let res: { text: string; data: unknown };

  switch (op) {
    case "start": {
      const suite = positionals[1] ?? flagStr(flags, "suite");
      if (!suite) {
        throw new Error("Usage: agent-studio testrun start <suite> [--build <id>]");
      }
      res = await testrunStart(ctx, {
        suite,
        build: flagStr(flags, "build"),
        actor: flagStr(flags, "actor") ?? "qa",
        items: flagList(flags, "items"),
      });
      break;
    }
    case "record": {
      const runId = positionals[1] ?? flagStr(flags, "run", "runId");
      const checkpoint = positionals[2] ?? flagStr(flags, "checkpoint", "cp");
      const result = (positionals[3] ?? flagStr(flags, "result")) as
        | "pass"
        | "fail"
        | "skip";
      if (!runId || !checkpoint || !result) {
        throw new Error(
          "Usage: agent-studio testrun record <runId> <checkpoint> <pass|fail|skip> [--note <text>]",
        );
      }
      res = await testrunRecord(ctx, {
        runId,
        checkpoint,
        result,
        note: flagStr(flags, "note"),
        bug: flagStr(flags, "bug"),
      });
      break;
    }
    case "step": {
      const runId = positionals[1] ?? flagStr(flags, "run", "runId");
      const checkpoint = positionals[2] ?? flagStr(flags, "checkpoint", "cp");
      const stepIndex = positionals[3] ?? flagStr(flags, "step");
      const result = (positionals[4] ?? flagStr(flags, "result")) as
        | "pass"
        | "fail"
        | "skip";
      if (!runId || !checkpoint || !stepIndex || !result) {
        throw new Error(
          "Usage: agent-studio testrun step <runId> <checkpoint> <stepIndex> <pass|fail|skip>",
        );
      }
      res = await testrunStep(ctx, {
        runId,
        checkpoint,
        stepIndex: Number.parseInt(stepIndex, 10),
        result,
        note: flagStr(flags, "note"),
      });
      break;
    }
    case "close": {
      const runId = positionals[1] ?? flagStr(flags, "run", "runId");
      if (!runId) throw new Error("Usage: agent-studio testrun close <runId>");
      res = await testrunClose(ctx, { runId });
      break;
    }
    case "list":
      res = await testrunList(ctx, {
        suite: flagStr(flags, "suite"),
        limit: flagStr(flags, "limit")
          ? Number.parseInt(flagStr(flags, "limit")!, 10)
          : undefined,
      });
      break;
    default:
      throw new Error(`Unknown testrun subcommand: ${op}`);
  }

  process.stdout.write(
    asJson ? JSON.stringify(res.data, null, 2) + "\n" : res.text + "\n",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }

  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${MCP_SERVER_INFO.version}\n`);
    return;
  }

  const rest = argv.slice(1);

  if (cmd === "init") {
    await runInit(rest);
    return;
  }

  if (cmd === "sync") {
    await runSync(rest);
    return;
  }

  if (cmd === "upgrade") {
    await runUpgrade(rest);
    return;
  }

  if (cmd === "models" || cmd === "model-index") {
    await runModelsCli(rest);
    return;
  }

  if (cmd === "doctor") {
    await runDoctor(rest);
    return;
  }

  if (cmd === "hook-emit") {
    const res = await runHookEmit(rest);
    if (res.exitCode !== 0) {
      process.exitCode = res.exitCode;
    }
    return;
  }

  if (cmd === "serve") {
    await runServe(rest, {
      doctorProvider: async (root) => buildDoctorReport(root ?? process.cwd()),
    });
    return;
  }

  if (cmd === "mcp") {
    const { flags } = parseArgv(rest);
    await startMcpStdioServer({
      defaultProject: flagStr(flags, "project"),
      sessionId: flagStr(flags, "session-id", "sessionId"),
    });
    return;
  }

  if (cmd === "projects") {
    await runProjectsCli(rest);
    return;
  }

  if (cmd === "board") {
    await runBoardCli(rest);
    return;
  }

  if (cmd === "testrun") {
    await runTestrunCli(rest);
    return;
  }

  process.stderr.write(
    `[agent-studio] Unknown command "${cmd}". Run "agent-studio --help" for available commands.\n`,
  );
  process.exitCode = 1;
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[agent-studio] Error: ${msg}\n`);
  process.exitCode = 1;
});
