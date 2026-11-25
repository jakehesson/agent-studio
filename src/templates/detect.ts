import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { slugifyProjectId } from "../board/registry.js";
import type { CheckpointDefinition } from "../schema/team.js";

export type RepoStack = "node" | "python" | "rust" | "go" | "generic";

export type ArchitecturalTopology =
  | "modular-monolith"
  | "monorepo"
  | "microservices"
  | "layered"
  | "event-driven"
  | "full-stack-web"
  | "cli-library"
  | "unknown";

export interface DetectedArchitectureSignals {
  topologyHints: ArchitecturalTopology[];
  frameworks: string[];
  stateManagement: string[];
  concurrencySignals: string[];
  apiBoundaries: string[];
  storageSignals: string[];
  topLevelDirs: string[];
  monorepoWorkspaces: string[];
  ciWorkflows: string[];
}

export interface DetectedRepoInfo {
  stack: RepoStack;
  projectId: string;
  projectTitle: string;
  description: string;
  mockupsDirs: string[];
  checkpoints: Record<string, CheckpointDefinition>;
  suites: Record<string, string[]>;
  detectedFiles: string[];
  architecture: DetectedArchitectureSignals;
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

  const architecture = detectProjectArchitecture(root, {
    stack,
    pkg,
    pyproject,
    cargo,
    goMod,
  });

  return {
    stack,
    projectId,
    projectTitle,
    description,
    mockupsDirs,
    checkpoints,
    suites,
    detectedFiles,
    architecture,
  };
}

const IGNORED_TOP_LEVEL_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
]);

function sortedUnique(items: Iterable<string>): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function isRealDirectory(dirPath: string): boolean {
  try {
    const stat = fs.lstatSync(dirPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function listDepth1Dirs(dirPath: string): string[] {
  if (!isRealDirectory(dirPath)) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || IGNORED_TOP_LEVEL_DIRS.has(entry.name)) {
        continue;
      }
      out.push(entry.name);
    }
    return out.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function listCiWorkflows(root: string): string[] {
  const workflowsDir = path.join(root, ".github", "workflows");
  if (!isRealDirectory(workflowsDir)) return [];
  try {
    const entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isFile() &&
          !e.isSymbolicLink() &&
          (e.name.endsWith(".yml") || e.name.endsWith(".yaml")),
      )
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function collectNodeDeps(pkg: Record<string, unknown> | null): Set<string> {
  const deps = new Set<string>();
  if (!pkg) return deps;
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const section = pkg[field];
    if (section && typeof section === "object" && !Array.isArray(section)) {
      for (const name of Object.keys(section as Record<string, unknown>)) {
        deps.add(name.toLowerCase());
      }
    }
  }
  return deps;
}

function collectPythonDeps(
  pyproject: string | null,
  requirementsTxt: string | null,
): Set<string> {
  const deps = new Set<string>();
  const combined = [pyproject ?? "", requirementsTxt ?? ""].join("\n");
  for (const rawLine of combined.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const quotedMatches = [
      ...line.matchAll(
        /["']([a-zA-Z0-9_.-]+)(?:\[[^\]]+\])?(?:[<>=!~;,\s"']|$)/g,
      ),
    ];
    if (quotedMatches.length > 0) {
      for (const m of quotedMatches) {
        if (m[1]) deps.add(m[1].toLowerCase().replace(/_/g, "-"));
      }
      continue;
    }
    const reqMatch = line.match(
      /^([a-zA-Z0-9_.-]+)(?:\[[^\]]+\])?(?:\s*(?:[<>=!~;@]|$))/,
    );
    if (
      reqMatch?.[1] &&
      !["name", "version", "description", "requires-python"].includes(
        reqMatch[1].toLowerCase(),
      )
    ) {
      deps.add(reqMatch[1].toLowerCase().replace(/_/g, "-"));
    }
  }
  return deps;
}

function collectRustDeps(cargo: string | null): Set<string> {
  const deps = new Set<string>();
  if (!cargo) return deps;
  let inDeps = false;
  for (const rawLine of cargo.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inDeps = /^\[(?:dev-|build-)?dependencies(?:\.[^\]]+)?\]/i.test(line);
      continue;
    }
    if (inDeps) {
      const m = line.match(/^([a-zA-Z0-9_-]+)\s*=/);
      if (m?.[1]) deps.add(m[1].toLowerCase());
    }
  }
  return deps;
}

function collectGoDeps(goMod: string | null): Set<string> {
  const deps = new Set<string>();
  if (!goMod) return deps;
  for (const rawLine of goMod.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    const cleaned = line.replace(/^require\s+/, "");
    const m = cleaned.match(/^([a-zA-Z0-9._/-]+)\s+v\d/);
    if (m?.[1]) {
      deps.add(m[1].toLowerCase());
    }
  }
  return deps;
}

function extractWorkspaces(
  root: string,
  pkg: Record<string, unknown> | null,
  cargo: string | null,
): { workspaces: string[]; hasMonorepoConfig: boolean } {
  const workspaces: string[] = [];
  let hasMonorepoConfig = false;

  if (pkg?.workspaces) {
    if (Array.isArray(pkg.workspaces)) {
      for (const w of pkg.workspaces) {
        if (typeof w === "string" && w.trim()) workspaces.push(w.trim());
      }
      hasMonorepoConfig = true;
    } else if (
      typeof pkg.workspaces === "object" &&
      Array.isArray((pkg.workspaces as { packages?: unknown }).packages)
    ) {
      for (const w of (pkg.workspaces as { packages: unknown[] }).packages) {
        if (typeof w === "string" && w.trim()) workspaces.push(w.trim());
      }
      hasMonorepoConfig = true;
    }
  }

  const pnpmWorkspaceText = tryReadText(path.join(root, "pnpm-workspace.yaml"));
  if (pnpmWorkspaceText !== null) {
    hasMonorepoConfig = true;
    try {
      const parsed = parseYaml(pnpmWorkspaceText) as { packages?: unknown } | null;
      if (parsed && Array.isArray(parsed.packages)) {
        for (const p of parsed.packages) {
          if (typeof p === "string" && p.trim()) workspaces.push(p.trim());
        }
      }
    } catch {
      // Ignore malformed yaml in pre-scan
    }
  }

  const lernaJson = tryReadJson(path.join(root, "lerna.json"));
  if (lernaJson) {
    hasMonorepoConfig = true;
    if (Array.isArray(lernaJson.packages)) {
      for (const p of lernaJson.packages) {
        if (typeof p === "string" && p.trim()) workspaces.push(p.trim());
      }
    }
  }

  for (const cfg of ["turbo.json", "nx.json", "go.work"]) {
    if (fs.existsSync(path.join(root, cfg))) {
      hasMonorepoConfig = true;
    }
  }

  if (cargo && /^\s*\[workspace\]/m.test(cargo)) {
    hasMonorepoConfig = true;
    const membersMatch = cargo.match(/members\s*=\s*\[([\s\S]*?)\]/m);
    if (membersMatch?.[1]) {
      for (const m of membersMatch[1].matchAll(/["']([^"']+)["']/g)) {
        if (m[1]?.trim()) workspaces.push(m[1].trim());
      }
    }
  }

  return { workspaces: sortedUnique(workspaces), hasMonorepoConfig };
}

function mapSignalMatches(
  deps: Set<string>,
  table: Array<[RegExp, string]>,
): string[] {
  const hits = new Set<string>();
  for (const dep of deps) {
    for (const [pattern, label] of table) {
      if (pattern.test(dep)) {
        hits.add(label);
      }
    }
  }
  return sortedUnique(hits);
}

const FRAMEWORK_RULES: Array<[RegExp, string]> = [
  [/^react$/, "react"],
  [/^next$/, "nextjs"],
  [/^vue$/, "vue"],
  [/^nuxt$/, "nuxt"],
  [/^svelte$|^@sveltejs\/kit$/, "svelte"],
  [/^solid-js$/, "solidjs"],
  [/^@angular\/core$/, "angular"],
  [/^express$/, "express"],
  [/^fastify$/, "fastify"],
  [/^koa$/, "koa"],
  [/^@nestjs\/core$/, "nestjs"],
  [/^hono$/, "hono"],
  [/^elysia$/, "elysia"],
  [/^vite$/, "vite"],
  [/^astro$/, "astro"],
  [/^@remix-run\/react$|^remix$/, "remix"],
  [/^electron$/, "electron"],
  [/^fastapi$/, "fastapi"],
  [/^django$/, "django"],
  [/^flask$/, "flask"],
  [/^starlette$/, "starlette"],
  [/^litestar$/, "litestar"],
  [/^streamlit$/, "streamlit"],
  [/^axum$/, "axum"],
  [/^actix-web$/, "actix-web"],
  [/^rocket$/, "rocket"],
  [/^tauri$/, "tauri"],
  [/^leptos$/, "leptos"],
  [/gin-gonic\/gin/, "gin"],
  [/labstack\/echo/, "echo"],
  [/gofiber\/fiber/, "fiber"],
  [/go-chi\/chi/, "chi"],
];

const STATE_RULES: Array<[RegExp, string]> = [
  [/^redux$|^@reduxjs\/toolkit$/, "redux"],
  [/^zustand$/, "zustand"],
  [/^jotai$/, "jotai"],
  [/^recoil$/, "recoil"],
  [/^mobx$/, "mobx"],
  [/^pinia$/, "pinia"],
  [/^xstate$/, "xstate"],
  [/^valtio$/, "valtio"],
  [/^@tanstack\/react-query$/, "tanstack-query"],
  [/^swr$/, "swr"],
  [/^rxjs$/, "rxjs"],
];

const CONCURRENCY_RULES: Array<[RegExp, string]> = [
  [/^bullmq$|^bull$/, "bullmq"],
  [/^agenda$/, "agenda"],
  [/^bottleneck$/, "bottleneck"],
  [/^p-limit$|^p-queue$/, "p-queue"],
  [/^async-mutex$/, "async-mutex"],
  [/^proper-lockfile$/, "lockfile"],
  [/^piscina$|^tinypool$/, "worker-pool"],
  [/^asyncio$|^anyio$|^trio$/, "asyncio"],
  [/^celery$|^dramatiq$|^rq$/, "task-queue"],
  [/^tokio$|^async-std$/, "tokio-async"],
  [/^rayon$/, "rayon"],
  [/^crossbeam$|^parking_lot$|^dashmap$/, "rust-sync"],
  [/golang\.org\/x\/sync/, "errgroup"],
];

const API_BOUNDARY_RULES: Array<[RegExp, string]> = [
  [/^@modelcontextprotocol\/sdk$/, "mcp-stdio-http"],
  [/^graphql$|^apollo-server$|^@apollo\/server$/, "graphql"],
  [/^@trpc\/server$/, "trpc"],
  [/^@grpc\/grpc-js$|^tonic$|google\.golang\.org\/grpc/, "grpc"],
  [/^ws$|^socket\.io$/, "websocket"],
  [/^express$|^fastify$|^hono$|^@nestjs\/core$|^fastapi$|^django$|^flask$|^axum$|^actix-web$|gin-gonic\/gin|labstack\/echo|gofiber\/fiber/, "http-rest"],
  [/^zod$|^pydantic$|^joi$|^valibot$|^serde$/, "schema-validation"],
  [/openapi|swagger/, "openapi"],
];

const STORAGE_RULES: Array<[RegExp, string]> = [
  [/^prisma$|^@prisma\/client$/, "prisma"],
  [/^drizzle-orm$/, "drizzle"],
  [/^typeorm$|^sequelize$/, "sql-orm"],
  [/^mongoose$|^mongodb$/, "mongodb"],
  [/^pg$|^postgres$|^psycopg2?$|^asyncpg$|^sqlx$|^diesel$|^gorm/, "postgres-sql"],
  [/^mysql2?$/, "mysql"],
  [/^sqlite3$|^better-sqlite3$|^rusqlite$/, "sqlite"],
  [/^redis$|^ioredis$/, "redis"],
  [/^duckdb$/, "duckdb"],
  [/^level$|^lowdb$/, "embedded-kv"],
];

export function detectProjectArchitecture(
  projectRoot: string,
  context?: {
    stack?: RepoStack;
    pkg?: Record<string, unknown> | null;
    pyproject?: string | null;
    cargo?: string | null;
    goMod?: string | null;
  },
): DetectedArchitectureSignals {
  const root = path.resolve(projectRoot);
  const pkg = context?.pkg !== undefined ? context.pkg : tryReadJson(path.join(root, "package.json"));
  const webPkg = tryReadJson(path.join(root, "web", "package.json"));
  const pyproject =
    context?.pyproject !== undefined ? context.pyproject : tryReadText(path.join(root, "pyproject.toml"));
  const requirementsTxt = tryReadText(path.join(root, "requirements.txt"));
  const cargo = context?.cargo !== undefined ? context.cargo : tryReadText(path.join(root, "Cargo.toml"));
  const goMod = context?.goMod !== undefined ? context.goMod : tryReadText(path.join(root, "go.mod"));

  const topLevelDirs = listDepth1Dirs(root);
  const srcSubDirs = listDepth1Dirs(path.join(root, "src"));
  const ciWorkflows = listCiWorkflows(root);
  const { workspaces: monorepoWorkspaces, hasMonorepoConfig } = extractWorkspaces(root, pkg, cargo);

  const deps = new Set<string>();
  for (const d of collectNodeDeps(pkg)) deps.add(d);
  for (const d of collectNodeDeps(webPkg)) deps.add(d);
  for (const d of collectPythonDeps(pyproject, requirementsTxt)) deps.add(d);
  for (const d of collectRustDeps(cargo)) deps.add(d);
  for (const d of collectGoDeps(goMod)) deps.add(d);

  const frameworks = mapSignalMatches(deps, FRAMEWORK_RULES);
  const stateManagement = mapSignalMatches(deps, STATE_RULES);
  const concurrencySignals = mapSignalMatches(deps, CONCURRENCY_RULES);
  const apiBoundaries = mapSignalMatches(deps, API_BOUNDARY_RULES);
  const storageSignals = mapSignalMatches(deps, STORAGE_RULES);

  const topologySet = new Set<ArchitecturalTopology>();
  const topSet = new Set(topLevelDirs);
  const srcSet = new Set(srcSubDirs);

  if (hasMonorepoConfig || monorepoWorkspaces.length > 0 || topSet.has("packages") || topSet.has("apps")) {
    topologySet.add("monorepo");
  }

  const hasCompose =
    fs.existsSync(path.join(root, "docker-compose.yml")) ||
    fs.existsSync(path.join(root, "docker-compose.yaml")) ||
    fs.existsSync(path.join(root, "compose.yml")) ||
    fs.existsSync(path.join(root, "compose.yaml"));
  if (hasCompose || topSet.has("services") || topSet.has("k8s")) {
    topologySet.add("microservices");
  }

  if (
    [...deps].some((d) =>
      /^(kafkajs|kafka|nats|bullmq|bull|amqplib|rabbitmq|celery|dramatiq|pulsar|rdkafka|lapin|eventsource)$/.test(
        d,
      ),
    )
  ) {
    topologySet.add("event-driven");
  }

  const layerMarkers = ["domain", "application", "infrastructure", "adapters", "ports", "repositories"];
  const layerMatches = layerMarkers.filter((m) => topSet.has(m) || srcSet.has(m));
  if (layerMatches.length >= 2) {
    topologySet.add("layered");
  }

  const hasWebDir = topSet.has("web") || topSet.has("frontend") || topSet.has("client");
  const hasServerDir = topSet.has("server") || topSet.has("backend") || topSet.has("api") || srcSet.has("server");
  const hasFullStackFramework = frameworks.some((f) =>
    ["nextjs", "nuxt", "remix", "astro", "django"].includes(f),
  );
  const hasFrontendFw = frameworks.some((f) =>
    ["react", "vue", "svelte", "solidjs", "angular", "vite"].includes(f),
  );
  const hasBackendFw = frameworks.some((f) =>
    ["express", "fastify", "koa", "nestjs", "hono", "fastapi", "flask", "axum", "actix-web", "gin", "echo", "fiber"].includes(f),
  );
  if ((hasWebDir && hasServerDir) || hasFullStackFramework || (hasFrontendFw && hasBackendFw)) {
    topologySet.add("full-stack-web");
  }

  const hasCliSignal =
    Boolean(pkg?.bin) ||
    srcSet.has("cli") ||
    topSet.has("cli") ||
    topSet.has("cmd") ||
    topSet.has("bin") ||
    Boolean(cargo && /\[\[bin\]\]/.test(cargo));
  if (hasCliSignal) {
    topologySet.add("cli-library");
  }

  if (
    !topologySet.has("microservices") &&
    !topologySet.has("monorepo") &&
    (topSet.has("src") || topSet.has("lib") || topSet.has("app")) &&
    (srcSubDirs.length >= 2 || frameworks.length > 0 || apiBoundaries.length > 0)
  ) {
    topologySet.add("modular-monolith");
  }

  if (topologySet.size === 0) {
    if (pkg || pyproject || cargo || goMod || topLevelDirs.length > 0) {
      topologySet.add("modular-monolith");
    } else {
      topologySet.add("unknown");
    }
  }

  return {
    topologyHints: [...topologySet].sort((a, b) => a.localeCompare(b)),
    frameworks,
    stateManagement,
    concurrencySignals,
    apiBoundaries,
    storageSignals,
    topLevelDirs,
    monorepoWorkspaces,
    ciWorkflows,
  };
}

export const detectArchitectureSignals = detectProjectArchitecture;

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
