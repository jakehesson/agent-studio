import fs from "node:fs";
import path from "node:path";
import {
  registerProject,
  type RegisteredProject,
} from "../../board/registry.js";
import { initBoardFile } from "../../board/store.js";
import {
  installGlobalSetupAgent,
  type GlobalInstallResult,
} from "../../compiler/global-install.js";
import { compileTeam, type CompileResult } from "../../compiler/index.js";
import { IdeTargetSchema, type IdeTarget } from "../../schema/team.js";
import {
  scaffoldAgentTeam,
  type ScaffoldTeamResult,
} from "../../templates/manifest.js";
import {
  buildDoctorReport,
  detectInstalledIdes,
  type DoctorReport,
} from "./doctor.js";

const ALL_IDES: IdeTarget[] = ["antigravity", "claude-code", "copilot-vscode"];

export interface InitCommandResult {
  ok: boolean;
  globalResult?: GlobalInstallResult;
  projectRoot?: string;
  targets?: IdeTarget[];
  scaffold?: ScaffoldTeamResult;
  boardCreated?: boolean;
  boardPreserved?: boolean;
  registeredProject?: RegisteredProject;
  compileResult?: CompileResult;
  doctorReport?: DoctorReport;
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

function parseInitArgs(args: string[]): {
  projectDir?: string;
  ides?: IdeTarget[];
  global: boolean;
  nonInteractive: boolean;
  force: boolean;
  id?: string;
  title?: string;
  json: boolean;
  quiet: boolean;
} {
  let projectDir: string | undefined;
  let ides: IdeTarget[] | undefined;
  let global = false;
  let nonInteractive = false;
  let force = false;
  let id: string | undefined;
  let title: string | undefined;
  let json = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token) continue;
    if (token === "--global") {
      global = true;
    } else if (token === "--non-interactive") {
      nonInteractive = true;
    } else if (token === "--force") {
      force = true;
    } else if (token === "--json") {
      json = true;
    } else if (token === "--quiet") {
      quiet = true;
    } else if (token === "--project" && args[i + 1]) {
      projectDir = args[++i];
    } else if (token.startsWith("--project=")) {
      projectDir = token.slice("--project=".length);
    } else if (token === "--ides" && args[i + 1]) {
      ides = parseIdeList(args[++i]!);
    } else if (token.startsWith("--ides=")) {
      ides = parseIdeList(token.slice("--ides=".length));
    } else if (token === "--id" && args[i + 1]) {
      id = args[++i];
    } else if (token.startsWith("--id=")) {
      id = token.slice("--id=".length);
    } else if (token === "--title" && args[i + 1]) {
      title = args[++i];
    } else if (token.startsWith("--title=")) {
      title = token.slice("--title=".length);
    }
  }

  return {
    projectDir,
    ides,
    global,
    nonInteractive,
    force,
    id,
    title,
    json,
    quiet,
  };
}

function resolveAutoTargets(explicitIdes?: IdeTarget[]): IdeTarget[] {
  if (explicitIdes && explicitIdes.length > 0) {
    return explicitIdes;
  }
  const detected = detectInstalledIdes();
  const installed = ALL_IDES.filter((ide) => detected[ide].installed);
  return installed.length > 0 ? installed : [...ALL_IDES];
}

export async function runInit(args: string[]): Promise<InitCommandResult> {
  const parsed = parseInitArgs(args);
  const targets = resolveAutoTargets(parsed.ides);

  let globalResult: GlobalInstallResult | undefined;
  if (parsed.global) {
    globalResult = installGlobalSetupAgent({
      ides: parsed.ides ?? [...ALL_IDES],
    });
    if (!parsed.projectDir) {
      const result: InitCommandResult = {
        ok: true,
        globalResult,
        targets: globalResult.targets,
      };
      if (!parsed.quiet) {
        if (parsed.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          process.stdout.write(
            `[agent-studio] Installed global team-setup agent/skills into ${globalResult.homeDir} (${globalResult.installedFiles.length} files).\n`,
          );
        }
      }
      return result;
    }
  }

  const projectRoot = path.resolve(parsed.projectDir ?? process.cwd());
  fs.mkdirSync(projectRoot, { recursive: true });

  const scaffold = scaffoldAgentTeam(projectRoot, {
    projectId: parsed.id,
    projectTitle: parsed.title,
    targets,
    force: parsed.force,
  });

  const boardAbsPath = path.resolve(
    projectRoot,
    scaffold.manifest.workflow.boardPath,
  );
  let boardCreated = false;
  let boardPreserved = false;

  if (fs.existsSync(boardAbsPath)) {
    boardPreserved = true;
  } else {
    await initBoardFile(boardAbsPath, {
      projectId: scaffold.manifest.project.id,
      milestoneName: `${scaffold.manifest.project.title} — Initial Milestone`,
      suites: scaffold.manifest.workflow.suites,
    });
    boardCreated = true;
  }

  const registeredProject = registerProject({
    id: scaffold.manifest.project.id,
    title: scaffold.manifest.project.title,
    root: projectRoot,
    boardPath: scaffold.manifest.workflow.boardPath,
    teamPath: ".agent-team/team.yaml",
  });

  const compileResult = compileTeam(projectRoot, { ides: parsed.ides });
  const doctorReport = buildDoctorReport(projectRoot);

  const result: InitCommandResult = {
    ok: doctorReport.ok,
    ...(globalResult ? { globalResult } : {}),
    projectRoot,
    targets: compileResult.targets,
    scaffold,
    boardCreated,
    boardPreserved,
    registeredProject,
    compileResult,
    doctorReport,
  };

  if (!parsed.quiet) {
    if (parsed.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      const boardSummary = boardPreserved
        ? `preserved existing ${scaffold.manifest.workflow.boardPath}`
        : `initialized ${scaffold.manifest.workflow.boardPath}`;
      const arch = scaffold.detected.architecture;
      const archParts: string[] = [];
      if (arch.topologyHints.length > 0) {
        archParts.push(arch.topologyHints.join(", "));
      }
      if (arch.frameworks.length > 0) {
        archParts.push(`frameworks=${arch.frameworks.join(", ")}`);
      }
      const archSummary =
        (archParts.length > 0 ? archParts.join(" · ") : "unknown") +
        " (run team-setup for deep architectural research)";
      process.stdout.write(
        [
          `[agent-studio] Initialized ${scaffold.manifest.project.title} (${scaffold.manifest.project.id})`,
          `  Stack:    ${scaffold.detected.stack}`,
          `  Arch:     ${archSummary}`,
          `  Targets:  ${compileResult.targets.join(", ")}`,
          `  Board:    ${boardSummary}`,
          `  Scaffold: ${scaffold.created.length} created, ${scaffold.skipped.length} preserved`,
          `  Sync:     ${compileResult.written.length} written, ${compileResult.merged.length} merged, ${compileResult.unchanged.length} unchanged`,
          `  Doctor:   ${doctorReport.ok ? "PASS" : "ISSUES FOUND"}`,
        ].join("\n") + "\n",
      );
    }
  }

  if (!doctorReport.ok) {
    process.exitCode = 1;
  }

  return result;
}
