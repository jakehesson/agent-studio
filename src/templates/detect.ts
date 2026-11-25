import fs from "node:fs";
import path from "node:path";
import { slugifyProjectId } from "../board/registry.js";
import type { CheckpointDefinition } from "../schema/team.js";

export type RepoStack = "node" | "python" | "rust" | "go" | "generic";

export interface DetectedRepoInfo {
  stack: RepoStack;
  projectId: string;
  projectTitle: string;
  description: string;
  mockupsDirs: string[];
  checkpoints: Record<string, CheckpointDefinition>;
  suites: Record<string, string[]>;
  detectedFiles: string[];
}

function tryReadJson(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function tryReadText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function extractTomlString(text: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m");
  const match = text.match(re);
  return match?.[1]?.trim();
}

function toTitleCase(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function detectRepoStack(projectRoot: string): DetectedRepoInfo {
  const root = path.resolve(projectRoot);
  const dirName = path.basename(root);
  const detectedFiles: string[] = [];

  const pkgPath = path.join(root, "package.json");
  const pyprojectPath = path.join(root, "pyproject.toml");
  const reqTxtPath = path.join(root, "requirements.txt");
  const setupPyPath = path.join(root, "setup.py");
  const cargoPath = path.join(root, "Cargo.toml");
  const goModPath = path.join(root, "go.mod");
  const projectJsonPath = path.join(root, "project.json");

  const pkg = tryReadJson(pkgPath);
  const pyproject = tryReadText(pyprojectPath);
  const cargo = tryReadText(cargoPath);
  const goMod = tryReadText(goModPath);
  const legacyProjectJson = tryReadJson(projectJsonPath);

  if (pkg) detectedFiles.push("package.json");
  if (pyproject) detectedFiles.push("pyproject.toml");
  if (fs.existsSync(reqTxtPath)) detectedFiles.push("requirements.txt");
  if (fs.existsSync(setupPyPath)) detectedFiles.push("setup.py");
  if (cargo) detectedFiles.push("Cargo.toml");
  if (goMod) detectedFiles.push("go.mod");
  if (legacyProjectJson) detectedFiles.push("project.json");

  let stack: RepoStack = "generic";
  if (pkg) {
    stack = "node";
  } else if (cargo) {
    stack = "rust";
  } else if (goMod) {
    stack = "go";
  } else if (pyproject || fs.existsSync(reqTxtPath) || fs.existsSync(setupPyPath)) {
    stack = "python";
  }

  let rawId: string | undefined;
  let rawTitle: string | undefined;
  let description = `Multi-agent engineering workspace for ${dirName}`;

  if (legacyProjectJson) {
    if (typeof legacyProjectJson.name === "string" && legacyProjectJson.name.trim()) {
      rawId = legacyProjectJson.name.trim();
    }
    if (typeof legacyProjectJson.title === "string" && legacyProjectJson.title.trim()) {
      rawTitle = legacyProjectJson.title.trim();
    }
  }

  if (pkg) {
    if (!rawId && typeof pkg.name === "string" && pkg.name.trim()) {
      rawId = pkg.name.replace(/^@[^/]+\//, "").trim();
    }
    if (typeof pkg.description === "string" && pkg.description.trim()) {
      description = pkg.description.trim();
    }
  } else if (cargo) {
    rawId = rawId ?? extractTomlString(cargo, "name");
    description = extractTomlString(cargo, "description") ?? description;
  } else if (pyproject) {
    rawId = rawId ?? extractTomlString(pyproject, "name");
    description = extractTomlString(pyproject, "description") ?? description;
  } else if (goMod) {
    const modMatch = goMod.match(/^\s*module\s+(\S+)/m);
    if (modMatch?.[1]) {
      const segs = modMatch[1].split("/");
      rawId = rawId ?? segs[segs.length - 1];
    }
  }

  const projectId = slugifyProjectId(rawId ?? dirName);
  const projectTitle = rawTitle ?? toTitleCase(projectId);

  const mockupsDirs: string[] = [];
  for (const candidate of ["docs/mockups", "mockups"]) {
    if (fs.existsSync(path.join(root, candidate))) {
      mockupsDirs.push(candidate);
    }
  }
  if (mockupsDirs.length === 0) {
    mockupsDirs.push("docs/mockups");
  }

  const checkpoints = buildDefaultCheckpoints(stack, pkg);
  const cpKeys = Object.keys(checkpoints);
  const smokeKeys = cpKeys.slice(0, Math.min(2, cpKeys.length));
  const suites: Record<string, string[]> = {
    smoke: smokeKeys.length > 0 ? smokeKeys : ["CP0"],
    full: cpKeys.length > 0 ? cpKeys : ["CP0"],
  };

  return {
    stack,
    projectId,
    projectTitle,
    description,
    mockupsDirs,
    checkpoints,
    suites,
    detectedFiles,
  };
}

function buildDefaultCheckpoints(
  stack: RepoStack,
  pkg: Record<string, unknown> | null,
): Record<string, CheckpointDefinition> {
  if (stack === "node") {
    const scripts =
      pkg && typeof pkg.scripts === "object" && pkg.scripts !== null
        ? (pkg.scripts as Record<string, unknown>)
        : {};
    const checkCmd =
      typeof scripts.check === "string"
        ? "npm run check"
        : typeof scripts.typecheck === "string"
          ? "npm run typecheck"
          : typeof scripts.lint === "string"
            ? "npm run lint"
            : "npm run build";
    const testCmd =
      typeof scripts.test === "string" ? "npm test" : "node --test";
    const buildCmd =
      typeof scripts.build === "string" ? "npm run build" : testCmd;

    return {
      CP0: {
        title: "Static Check & Typecheck",
        command: checkCmd,
        steps: [`Run \`${checkCmd}\` to verify types and static checks.`],
        pass: ["Exit code 0 with zero type or lint errors."],
        fail: ["Any compiler, typecheck, or lint error."],
      },
      CP1: {
        title: "Automated Test Suite",
        command: testCmd,
        steps: [`Run \`${testCmd}\` and verify all unit/integration tests pass.`],
        pass: ["All test suites pass with exit code 0."],
        fail: ["Any failing assertion or unhandled test exception."],
      },
      CP2: {
        title: "Production Build Verification",
        command: buildCmd,
        steps: [`Run \`${buildCmd}\` to confirm clean distributable output.`],
        pass: ["Build completes cleanly with exit code 0."],
        fail: ["Build fails or produces broken artifacts."],
      },
    };
  }

  if (stack === "python") {
    return {
      CP0: {
        title: "Python Syntax & Static Check",
        command: "python -m compileall -q .",
        steps: ["Compile all Python sources to check for syntax errors."],
        pass: ["Exit code 0 with zero syntax errors."],
        fail: ["Any syntax or compilation error."],
      },
      CP1: {
        title: "Python Automated Tests",
        command: "pytest",
        steps: ["Run `pytest` across the repository test suite."],
        pass: ["All tests pass with exit code 0."],
        fail: ["Any failing test or collection error."],
      },
    };
  }

  if (stack === "rust") {
    return {
      CP0: {
        title: "Cargo Check",
        command: "cargo check --all-targets",
        steps: ["Run `cargo check --all-targets` to verify compilation."],
        pass: ["Compilation succeeds with exit code 0."],
        fail: ["Any compiler error."],
      },
      CP1: {
        title: "Cargo Test Suite",
        command: "cargo test",
        steps: ["Run `cargo test` for unit and integration tests."],
        pass: ["All Cargo tests pass."],
        fail: ["Any failing test or panic."],
      },
    };
  }

  if (stack === "go") {
    return {
      CP0: {
        title: "Go Vet",
        command: "go vet ./...",
        steps: ["Run `go vet ./...` to catch static issues."],
        pass: ["Exit code 0 with no vet diagnostics."],
        fail: ["Any `go vet` diagnostic or compile error."],
      },
      CP1: {
        title: "Go Test Suite",
        command: "go test ./...",
        steps: ["Run `go test ./...` across all packages."],
        pass: ["All packages pass with exit code 0."],
        fail: ["Any failing test or build error."],
      },
    };
  }

  return {
    CP0: {
      title: "Baseline Verification",
      command: "echo \"Configure CP0 command in .agent-team/team.yaml\"",
      steps: ["Run the repository's lint, typecheck, or smoke verification command."],
      pass: ["Verification exits cleanly with zero errors."],
      fail: ["Any check failure or regression."],
    },
    CP1: {
      title: "Functional Test Suite",
      command: "echo \"Configure CP1 command in .agent-team/team.yaml\"",
      steps: ["Execute automated tests covering modified modules."],
      pass: ["All functional tests pass."],
      fail: ["Any test failure or uncovered regression."],
    },
  };
}
