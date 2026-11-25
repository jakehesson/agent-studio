import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listProjects } from "../board/registry.js";
import { parseTeamYaml } from "../schema/team.js";
import { normalizeWsPath } from "../telemetry/types.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-test",
  "__pycache__",
  ".venv",
  "venv",
  "bin",
  "obj",
  "build",
]);

export interface MockupEntry {
  id: string;
  project: string;
  project_name: string;
  rel_path: string;
  file_path: string;
  abs_dir: string;
}

export interface HydratedMockup {
  id: string;
  project: string;
  project_name: string;
  name: string;
  rel_path: string;
  abs_dir: string;
  mtime: number;
  size: number;
  has_feedback: boolean;
  feedback_mtime: number;
  has_theme_json: boolean;
  theme_meta: Record<string, unknown> | null;
  feedback?: string;
}

export interface MockupDiscoveryResult {
  mockups: HydratedMockup[];
  projects: Array<{ id: string; name: string; count: number }>;
  selected: HydratedMockup | null;
  server_time: string;
}

function slugifyProject(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

function prettifyMockupName(
  relPath: string,
  themeMeta: Record<string, unknown> | null,
): string {
  if (themeMeta && typeof themeMeta.name === "string" && themeMeta.name.trim()) {
    return themeMeta.name.trim();
  }
  const parts = relPath.split("/").filter(Boolean);
  const file = parts[parts.length - 1] ?? relPath;
  const base = file.replace(/\.html$/i, "");
  if (base.toLowerCase() === "mockup" && parts.length >= 2) {
    return parts[parts.length - 2]!;
  }
  return base;
}

function isMockupHtmlFile(
  fname: string,
  relParts: string[],
  isExplicitDir: boolean,
): boolean {
  const low = fname.toLowerCase();
  if (!low.endsWith(".html")) return false;
  if (low.startsWith("mockup") || low.startsWith("design-mockup")) return true;
  if (isExplicitDir && relParts.length === 0) return true;
  const lastDir = (relParts[relParts.length - 1] ?? "").toLowerCase();
  if (lastDir === "mockups") return true;
  const parentDir = (relParts[relParts.length - 2] ?? "").toLowerCase();
  if (parentDir === "themes") return true;
  return false;
}

async function isSafeScanRoot(dirPath: string): Promise<boolean> {
  try {
    const rp = path.resolve(dirPath);
    const st = await fs.stat(rp);
    if (!st.isDirectory()) return false;
    if (rp === path.parse(rp).root) return false;
    if (rp.toLowerCase() === path.resolve(os.homedir()).toLowerCase()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function walkMockups(
  rootDir: string,
  projectId: string,
  projectName: string,
  isExplicit: boolean,
  seenFiles: Set<string>,
  usedIds: Set<string>,
  out: MockupEntry[],
): Promise<void> {
  const maxDepth = 4;

  const visit = async (curDir: string, relParts: string[]): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(curDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (
          relParts.length < maxDepth &&
          !ent.name.startsWith(".") &&
          !SKIP_DIRS.has(ent.name.toLowerCase())
        ) {
          await visit(path.join(curDir, ent.name), [...relParts, ent.name]);
        }
      } else if (ent.isFile()) {
        if (!isMockupHtmlFile(ent.name, relParts, isExplicit)) continue;
        const absFile = path.resolve(curDir, ent.name);
        const fkey = normalizeWsPath(absFile);
        if (seenFiles.has(fkey)) continue;
        seenFiles.add(fkey);

        const relPosix = [...relParts, ent.name].join("/");
        let mid = `${projectId}/${relPosix}`;
        let suffix = 2;
        while (usedIds.has(mid)) {
          mid = `${projectId}-${suffix}/${relPosix}`;
          suffix += 1;
        }
        usedIds.add(mid);

        out.push({
          id: mid,
          project: projectId,
          project_name: projectName,
          rel_path: relPosix,
          file_path: absFile,
          abs_dir: path.dirname(absFile),
        });
      }
    }
  };

  await visit(rootDir, []);
}

export async function scanMockupEntries(options?: {
  extraMockupDirs?: string[];
  workspaceRoots?: string[];
}): Promise<MockupEntry[]> {
  const candidates: Array<{
    root: string;
    projectId: string;
    projectName: string;
    isExplicit: boolean;
  }> = [];
  const seenRoots = new Set<string>();

  const addCandidate = async (
    dir: string,
    projectId: string,
    projectName: string,
    isExplicit: boolean,
  ): Promise<void> => {
    if (!(await isSafeScanRoot(dir))) return;
    const rp = path.resolve(dir);
    const key = normalizeWsPath(rp);
    if (seenRoots.has(key)) return;
    seenRoots.add(key);
    candidates.push({
      root: rp,
      projectId: slugifyProject(projectId),
      projectName: projectName.trim() || path.basename(rp),
      isExplicit,
    });
  };

  for (const d of options?.extraMockupDirs ?? []) {
    await addCandidate(d, path.basename(d), path.basename(d), true);
  }

  for (const proj of listProjects()) {
    // Prefer declared mockupsDirs from team.yaml if present
    try {
      const teamYamlPath = path.join(proj.root, proj.teamPath);
      const raw = await fs.readFile(teamYamlPath, "utf8");
      const manifest = parseTeamYaml(raw);
      for (const relMockDir of manifest.project.mockupsDirs ?? []) {
        await addCandidate(
          path.resolve(proj.root, relMockDir),
          proj.id,
          proj.title,
          true,
        );
      }
    } catch {
      // No team.yaml or unreadable.
    }
    await addCandidate(proj.root, proj.id, proj.title, false);
  }

  for (const ws of options?.workspaceRoots ?? []) {
    await addCandidate(ws, path.basename(ws), path.basename(ws), false);
  }

  const out: MockupEntry[] = [];
  const seenFiles = new Set<string>();
  const usedIds = new Set<string>();

  for (const c of candidates) {
    await walkMockups(
      c.root,
      c.projectId,
      c.projectName,
      c.isExplicit,
      seenFiles,
      usedIds,
      out,
    );
  }

  return out;
}

export async function hydrateMockup(
  entry: MockupEntry,
  includeFeedback = false,
): Promise<HydratedMockup | null> {
  let st;
  try {
    st = await fs.stat(entry.file_path);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }

  let mtime = st.mtimeMs / 1000;
  try {
    const siblings = await fs.readdir(entry.abs_dir, { withFileTypes: true });
    for (const sib of siblings) {
      if (sib.isFile() && sib.name.toLowerCase().endsWith(".css")) {
        const sst = await fs
          .stat(path.join(entry.abs_dir, sib.name))
          .catch(() => null);
        if (sst) mtime = Math.max(mtime, sst.mtimeMs / 1000);
      }
    }
  } catch {
    // ignore
  }

  const fbPath = path.join(entry.abs_dir, "FEEDBACK.md");
  let hasFeedback = false;
  let feedbackMtime = 0;
  let feedbackText: string | undefined;
  try {
    const fbst = await fs.stat(fbPath);
    if (fbst.isFile()) {
      hasFeedback = true;
      feedbackMtime = fbst.mtimeMs / 1000;
      if (includeFeedback) {
        feedbackText = await fs.readFile(fbPath, "utf8");
      }
    }
  } catch {
    if (includeFeedback) feedbackText = "";
  }

  let hasThemeJson = false;
  let themeMeta: Record<string, unknown> | null = null;
  try {
    const tjPath = path.join(entry.abs_dir, "theme.json");
    const rawTj = await fs.readFile(tjPath, "utf8");
    hasThemeJson = true;
    if (rawTj.length <= 65536) {
      const parsed: unknown = JSON.parse(rawTj);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        themeMeta = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // no theme.json
  }

  const hydrated: HydratedMockup = {
    id: entry.id,
    project: entry.project,
    project_name: entry.project_name,
    name: prettifyMockupName(entry.rel_path, themeMeta),
    rel_path: entry.rel_path,
    abs_dir: entry.abs_dir,
    mtime,
    size: st.size,
    has_feedback: hasFeedback,
    feedback_mtime: feedbackMtime,
    has_theme_json: hasThemeJson,
    theme_meta: themeMeta,
  };
  if (includeFeedback) {
    hydrated.feedback = feedbackText ?? "";
  }
  return hydrated;
}

export async function discoverMockups(options?: {
  extraMockupDirs?: string[];
  workspaceRoots?: string[];
  project?: string;
  selectedId?: string;
}): Promise<MockupDiscoveryResult> {
  const entries = await scanMockupEntries(options);
  const allItems: HydratedMockup[] = [];
  const entryById = new Map<string, MockupEntry>();

  for (const e of entries) {
    const h = await hydrateMockup(e, false);
    if (h) {
      allItems.push(h);
      entryById.set(h.id, e);
    }
  }

  allItems.sort(
    (a, b) =>
      b.mtime - a.mtime ||
      a.project_name.localeCompare(b.project_name) ||
      a.rel_path.localeCompare(b.rel_path),
  );

  const projMap = new Map<string, { id: string; name: string; count: number }>();
  for (const m of allItems) {
    const existing = projMap.get(m.project);
    if (existing) {
      existing.count += 1;
    } else {
      projMap.set(m.project, { id: m.project, name: m.project_name, count: 1 });
    }
  }
  const projects = [...projMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const pf = options?.project?.trim();
  const filtered =
    pf && pf.toUpperCase() !== "ALL"
      ? allItems.filter(
          (m) =>
            m.project.toLowerCase() === pf.toLowerCase() ||
            m.project_name.toLowerCase() === pf.toLowerCase(),
        )
      : allItems;

  let selected: HydratedMockup | null = null;
  const selId = options?.selectedId?.trim();
  if (selId && entryById.has(selId)) {
    selected = await hydrateMockup(entryById.get(selId)!, true);
  } else if (filtered[0]) {
    const firstEntry = entryById.get(filtered[0].id);
    if (firstEntry) selected = await hydrateMockup(firstEntry, true);
  }

  return {
    mockups: filtered,
    projects,
    selected,
    server_time: new Date().toTimeString().slice(0, 8),
  };
}

export async function resolveMockupAsset(
  absDir: string,
  relAsset: string,
): Promise<{ status: 200 | 403 | 404; filePath?: string }> {
  const raw = String(relAsset || "")
    .trim()
    .replace(/\\/g, "/");
  if (
    !raw ||
    raw.includes("\u0000") ||
    raw.startsWith("/") ||
    /^[A-Za-z]:/.test(raw)
  ) {
    return { status: 403 };
  }
  const parts = raw.split("/");
  if (parts.some((p) => p === ".." || p === "")) {
    return { status: 403 };
  }

  const base = path.resolve(absDir);
  const target = path.resolve(base, raw);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { status: 403 };
  }

  try {
    const st = await fs.stat(target);
    if (!st.isFile()) return { status: 404 };
    return { status: 200, filePath: target };
  } catch {
    return { status: 404 };
  }
}

export async function appendMockupFeedback(
  absDir: string,
  input: { note: string; view?: string },
): Promise<{ path: string; feedback: string }> {
  const note = input.note.trim();
  if (!note) {
    throw new Error("Feedback note must not be empty");
  }
  const view = (input.view ?? "default").replace(/[\r\n]+/g, " ").trim() || "default";
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const fbPath = path.join(absDir, "FEEDBACK.md");
  const block = `\n## ${ts} (${view})\n\n${note}\n`;
  await fs.appendFile(fbPath, block, "utf8");
  const feedback = await fs.readFile(fbPath, "utf8");
  return { path: fbPath, feedback };
}
