import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseTeamYaml, type TeamManifest } from "../schema/team.js";

export const RegisteredProjectSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  root: z.string().min(1),
  boardPath: z.string().min(1).default("pipeline/board.json"),
  teamPath: z.string().min(1).default(".agent-team/team.yaml"),
  registeredAt: z.string().min(1),
});
export type RegisteredProject = z.infer<typeof RegisteredProjectSchema>;

export const ProjectRegistryFileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  defaultProject: z.string().optional(),
  projects: z.record(z.string(), RegisteredProjectSchema).default({}),
});
export type ProjectRegistryFile = z.infer<typeof ProjectRegistryFileSchema>;

export interface ResolvedProject {
  id: string;
  title: string;
  root: string;
  boardPath: string;
  teamPath: string;
  qaGateRequired: boolean;
  teamManifest: TeamManifest | null;
}

export interface RegisterProjectInput {
  id?: string;
  title?: string;
  root: string;
  boardPath?: string;
  teamPath?: string;
  setDefault?: boolean;
}

export function getAgentStudioHome(): string {
  const override = process.env.AGENT_STUDIO_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".agent-studio");
}

export function getRegistryPath(): string {
  return path.join(getAgentStudioHome(), "projects.json");
}

export function slugifyProjectId(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

function tryReadTeamManifest(teamYamlPath: string): TeamManifest | null {
  if (!fs.existsSync(teamYamlPath)) {
    return null;
  }
  const text = fs.readFileSync(teamYamlPath, "utf8");
  return parseTeamYaml(text);
}

function inferProjectMetadata(
  rootDir: string,
  boardRelPath?: string,
  teamRelPath?: string,
): {
  id: string;
  title: string;
  boardPath: string;
  teamPath: string;
  teamManifest: TeamManifest | null;
} {
  const resolvedTeamRel = teamRelPath ?? ".agent-team/team.yaml";
  const absTeamPath = path.resolve(rootDir, resolvedTeamRel);
  const teamManifest = tryReadTeamManifest(absTeamPath);

  let inferredId: string | undefined = teamManifest?.project.id;
  let inferredTitle: string | undefined = teamManifest?.project.title;
  const inferredBoardRel =
    boardRelPath ?? teamManifest?.workflow.boardPath ?? "pipeline/board.json";

  if (!inferredId || !inferredTitle) {
    const projectJsonPath = path.join(rootDir, "project.json");
    if (fs.existsSync(projectJsonPath)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(projectJsonPath, "utf8"),
        ) as Record<string, unknown>;
        if (!inferredId && typeof parsed.name === "string" && parsed.name.trim()) {
          inferredId = parsed.name.trim();
        }
        if (!inferredTitle && typeof parsed.title === "string" && parsed.title.trim()) {
          inferredTitle = parsed.title.trim();
        }
      } catch {
        // Ignore malformed legacy project.json during inference.
      }
    }
  }

  if (!inferredId) {
    const absBoardPath = path.resolve(rootDir, inferredBoardRel);
    if (fs.existsSync(absBoardPath)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(absBoardPath, "utf8"),
        ) as Record<string, unknown>;
        if (typeof parsed.project === "string" && parsed.project.trim()) {
          inferredId = parsed.project.trim();
        }
      } catch {
        // Ignore unreadable board.json during inference.
      }
    }
  }

  const dirName = path.basename(rootDir);
  const id = slugifyProjectId(inferredId ?? dirName);
  const title = inferredTitle ?? inferredId ?? dirName;

  return {
    id,
    title,
    boardPath: inferredBoardRel,
    teamPath: resolvedTeamRel,
    teamManifest,
  };
}

export function loadRegistry(): ProjectRegistryFile {
  const regPath = getRegistryPath();
  if (!fs.existsSync(regPath)) {
    return { schemaVersion: 1, projects: {} };
  }
  const raw: unknown = JSON.parse(fs.readFileSync(regPath, "utf8"));
  return ProjectRegistryFileSchema.parse(raw);
}

export function saveRegistry(registry: ProjectRegistryFile): void {
  const validated = ProjectRegistryFileSchema.parse(registry);
  const regPath = getRegistryPath();
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  const tmpPath = `${regPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(validated, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, regPath);
}

export function listProjects(): RegisteredProject[] {
  const reg = loadRegistry();
  return Object.values(reg.projects).sort((a, b) => a.id.localeCompare(b.id));
}

export function registerProject(input: RegisterProjectInput): RegisteredProject {
  const root = path.resolve(input.root);
  if (!fs.existsSync(root)) {
    throw new Error(`Project root does not exist: ${root}`);
  }
  const inferred = inferProjectMetadata(root, input.boardPath, input.teamPath);
  const id = input.id ? slugifyProjectId(input.id) : inferred.id;
  const title = input.title?.trim() || inferred.title;

  const entry: RegisteredProject = {
    id,
    title,
    root,
    boardPath: inferred.boardPath,
    teamPath: inferred.teamPath,
    registeredAt: new Date().toISOString(),
  };

  const reg = loadRegistry();
  reg.projects[id] = entry;
  if (input.setDefault || !reg.defaultProject) {
    reg.defaultProject = id;
  }
  saveRegistry(reg);
  return entry;
}

function hydrateResolvedProject(entry: {
  id: string;
  title: string;
  root: string;
  boardPath: string;
  teamPath: string;
}): ResolvedProject {
  const root = path.resolve(entry.root);
  const teamPath = path.resolve(root, entry.teamPath);
  const teamManifest = tryReadTeamManifest(teamPath);
  const effectiveBoardRel = teamManifest?.workflow.boardPath ?? entry.boardPath;
  const boardPath = path.resolve(root, effectiveBoardRel);
  const qaGateRequired = teamManifest?.workflow.enforcement.qaGateRequired ?? true;

  return {
    id: entry.id,
    title: teamManifest?.project.title ?? entry.title,
    root,
    boardPath,
    teamPath,
    qaGateRequired,
    teamManifest,
  };
}

function findProjectRootFromDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    if (
      fs.existsSync(path.join(current, ".agent-team", "team.yaml")) ||
      fs.existsSync(path.join(current, "pipeline", "board.json"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveProject(
  projectRef?: string,
  cwd?: string,
): ResolvedProject {
  const reg = loadRegistry();
  const ref = projectRef?.trim();

  if (ref) {
    const exact = reg.projects[ref];
    if (exact) {
      return hydrateResolvedProject(exact);
    }

    const lower = ref.toLowerCase();
    const ciMatch = Object.values(reg.projects).find(
      (p) => p.id.toLowerCase() === lower || p.title.toLowerCase() === lower,
    );
    if (ciMatch) {
      return hydrateResolvedProject(ciMatch);
    }

    const candidatePath = path.resolve(cwd ?? process.cwd(), ref);
    if (fs.existsSync(candidatePath)) {
      const stat = fs.statSync(candidatePath);
      if (stat.isFile() && path.basename(candidatePath).endsWith(".json")) {
        // Direct path to a board.json file (e.g. <root>/pipeline/board.json)
        const parentDir = path.dirname(candidatePath);
        const rootDir =
          path.basename(parentDir).toLowerCase() === "pipeline"
            ? path.dirname(parentDir)
            : parentDir;
        const relBoard = path.relative(rootDir, candidatePath);
        const inferred = inferProjectMetadata(rootDir, relBoard);
        return hydrateResolvedProject({
          id: inferred.id,
          title: inferred.title,
          root: rootDir,
          boardPath: relBoard,
          teamPath: inferred.teamPath,
        });
      }
      if (stat.isDirectory()) {
        const inferred = inferProjectMetadata(candidatePath);
        return hydrateResolvedProject({
          id: inferred.id,
          title: inferred.title,
          root: candidatePath,
          boardPath: inferred.boardPath,
          teamPath: inferred.teamPath,
        });
      }
    }

    const known = Object.keys(reg.projects).sort().join(", ") || "none";
    throw new Error(
      `Unknown project "${ref}". Registered projects: ${known}. Pass a valid project ID or project directory path.`,
    );
  }

  const startDir = path.resolve(cwd ?? process.cwd());
  const detectedRoot = findProjectRootFromDir(startDir);
  if (detectedRoot) {
    const normDetected = path.resolve(detectedRoot).toLowerCase();
    const matched = Object.values(reg.projects).find(
      (p) => path.resolve(p.root).toLowerCase() === normDetected,
    );
    if (matched) {
      return hydrateResolvedProject(matched);
    }
    const inferred = inferProjectMetadata(detectedRoot);
    return hydrateResolvedProject({
      id: inferred.id,
      title: inferred.title,
      root: detectedRoot,
      boardPath: inferred.boardPath,
      teamPath: inferred.teamPath,
    });
  }

  if (reg.defaultProject && reg.projects[reg.defaultProject]) {
    const def = reg.projects[reg.defaultProject];
    if (def) {
      return hydrateResolvedProject(def);
    }
  }

  throw new Error(
    `Could not resolve project from "${startDir}". Register a project with "agent-studio projects register <path>" or pass --project.`,
  );
}
