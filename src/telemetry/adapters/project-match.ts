import path from "node:path";
import { listProjects, resolveProject } from "../../board/registry.js";
import { normalizeWsPath } from "../types.js";

export interface KnownProjectEntry {
  id: string;
  title: string;
  root: string;
}

export function normalizeComparePath(raw: string): string {
  const s = normalizeWsPath(raw).replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!s) return "";
  return /^[a-z]:\//i.test(s) ? s.toLowerCase() : s;
}

export function pathMatchesRoot(
  candidateWs: string,
  targetRoot: string,
): boolean {
  const w = normalizeComparePath(candidateWs);
  const r = normalizeComparePath(targetRoot);
  if (!w || !r) return false;
  return w === r || w.startsWith(r + "/");
}

export function getKnownProjects(): KnownProjectEntry[] {
  const entries: KnownProjectEntry[] = [];
  const seen = new Set<string>();

  const push = (entry: KnownProjectEntry): void => {
    const key = `${entry.id.toLowerCase()}|${normalizeComparePath(entry.root)}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  try {
    for (const p of listProjects()) {
      push({ id: p.id, title: p.title, root: p.root });
    }
  } catch {
    // Registry absent or unreadable.
  }

  try {
    const cwdProj = resolveProject(undefined);
    push({ id: cwdProj.id, title: cwdProj.title, root: cwdProj.root });
  } catch {
    // Cwd is not a project root.
  }

  return entries;
}

export function matchProjectIdForWorkspaces(
  workspaces: ReadonlyArray<string | undefined>,
  knownProjects?: ReadonlyArray<KnownProjectEntry>,
): string | undefined {
  const cleanWs = workspaces
    .filter((w): w is string => typeof w === "string" && w.trim().length > 0)
    .map(normalizeComparePath)
    .filter(Boolean);
  if (cleanWs.length === 0) return undefined;

  const projects = (knownProjects ?? getKnownProjects())
    .map((p) => ({
      id: p.id,
      root: normalizeComparePath(p.root),
    }))
    .filter((p) => p.root.length > 0)
    .sort((a, b) => b.root.length - a.root.length);

  let bestId: string | undefined;
  let bestRootLen = -1;

  for (const ws of cleanWs) {
    for (const proj of projects) {
      if (ws === proj.root || ws.startsWith(proj.root + "/")) {
        if (proj.root.length > bestRootLen) {
          bestRootLen = proj.root.length;
          bestId = proj.id;
        }
        break;
      }
    }
  }

  return bestId;
}
