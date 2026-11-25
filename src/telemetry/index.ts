import path from "node:path";
import { listProjects, resolveProject } from "../board/registry.js";
import type { IdeSource } from "../schema/telemetry.js";
import { AntigravityAdapter } from "./adapters/antigravity.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CopilotVSCodeAdapter } from "./adapters/copilot-vscode.js";
import {
  getKnownProjects,
  normalizeComparePath,
  pathMatchesRoot,
} from "./adapters/project-match.js";
import { discoverTeamDetailsCached } from "./definitions.js";
import { buildSessionSnapshot } from "./normalizer.js";
import { PushBus, type IngestResult } from "./push-bus.js";
import {
  type AdapterHealth,
  type DiscoveredSession,
  type PassiveIdeAdapter,
  type RichSessionSnapshot,
} from "./types.js";

export * from "./types.js";
export * from "./definitions.js";
export * from "./push-bus.js";
export * from "./normalizer.js";
export { AntigravityAdapter } from "./adapters/antigravity.js";
export { ClaudeCodeAdapter } from "./adapters/claude-code.js";
export {
  CopilotVSCodeAdapter,
  reconstructVSCodeDeltaJsonl,
} from "./adapters/copilot-vscode.js";

export interface TelemetryAggregatorOptions {
  brainDir?: string;
  claudeDir?: string;
  vscodeDir?: string;
  extraWorkspaces?: string[];
  includeGlobalTelemetryFile?: boolean;
  adapters?: PassiveIdeAdapter[];
}

export interface SessionQueryFilter {
  ide?: string;
  project?: string;
  workspace?: string;
  multiOnly?: boolean;
  limit?: number;
}

function normProjKey(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface ResolvedProjectFilter {
  aliases: Set<string>;
  roots: string[];
}

function buildProjectFilterCriteria(projectFilter: string): ResolvedProjectFilter {
  const aliases = new Set<string>();
  const roots: string[] = [];
  const seenRoots = new Set<string>();

  const addAlias = (val: string | undefined): void => {
    if (!val) return;
    const norm = normProjKey(val);
    if (norm) aliases.add(norm);
  };

  const addRoot = (rootPath: string | undefined): void => {
    if (!rootPath) return;
    const norm = normalizeComparePath(rootPath);
    if (norm && !seenRoots.has(norm)) {
      seenRoots.add(norm);
      roots.push(norm);
    }
    const base = path.basename(rootPath);
    addAlias(base);
  };

  addAlias(projectFilter);

  try {
    const resolved = resolveProject(projectFilter);
    addAlias(resolved.id);
    addAlias(resolved.title);
    addRoot(resolved.root);
  } catch {
    // Unknown project ID or non-path filter; fall through to known-projects scan.
  }

  const targetNorm = normProjKey(projectFilter);
  for (const kp of getKnownProjects()) {
    const kpAliases = [
      normProjKey(kp.id),
      normProjKey(kp.title),
      normProjKey(path.basename(kp.root)),
    ];
    if (kpAliases.includes(targetNorm)) {
      addAlias(kp.id);
      addAlias(kp.title);
      addRoot(kp.root);
    }
  }

  return { aliases, roots };
}

function sessionMatchesFilter(
  session: DiscoveredSession,
  filter: SessionQueryFilter,
  projectCriteria?: ResolvedProjectFilter,
): boolean {
  const ideFilter = filter.ide?.trim().toLowerCase();
  if (ideFilter && ideFilter !== "all" && session.ide.toLowerCase() !== ideFilter) {
    return false;
  }

  if (filter.multiOnly && !session.isMultiAgent) {
    return false;
  }

  const sessionWorkspaces = [
    ...(session.workspacePath ? [session.workspacePath] : []),
    ...session.workspaces,
  ].filter(Boolean);

  if (filter.workspace) {
    // Strict forward containment only (never match a parent dir onto a sibling/child target!)
    const matchesWs = sessionWorkspaces.some((w) =>
      pathMatchesRoot(w, filter.workspace!),
    );
    if (!matchesWs) return false;
  }

  const projFilter = filter.project?.trim().toLowerCase();
  if (projFilter && projFilter !== "all") {
    const criteria =
      projectCriteria ?? buildProjectFilterCriteria(filter.project!);
    const sidProjNorm = normProjKey(session.projectId ?? "");
    const aliasMatch = sidProjNorm.length > 0 && criteria.aliases.has(sidProjNorm);
    const rootMatch =
      criteria.roots.length > 0 &&
      sessionWorkspaces.some((w) =>
        criteria.roots.some((root) => pathMatchesRoot(w, root)),
      );
    if (!aliasMatch && !rootMatch) {
      return false;
    }
  }

  return true;
}

export class TelemetryAggregator {
  readonly adapters: PassiveIdeAdapter[];
  readonly pushBus: PushBus;

  constructor(options?: TelemetryAggregatorOptions) {
    this.adapters = options?.adapters ?? [
      new AntigravityAdapter({ brainDir: options?.brainDir }),
      new ClaudeCodeAdapter({ projectsDir: options?.claudeDir }),
      new CopilotVSCodeAdapter({ storageDir: options?.vscodeDir }),
    ];
    this.pushBus = new PushBus({
      extraWorkspaces: options?.extraWorkspaces,
      includeGlobalTelemetryFile: options?.includeGlobalTelemetryFile,
    });
  }

  ingest(rawItems: unknown[]): IngestResult {
    return this.pushBus.ingest(rawItems);
  }

  async pollPushFiles(): Promise<IngestResult> {
    return this.pushBus.pollFiles();
  }

  async getAdaptersHealth(): Promise<AdapterHealth[]> {
    return Promise.all(this.adapters.map((a) => a.getHealth()));
  }

  async discoverSessions(
    filter: SessionQueryFilter = {},
  ): Promise<DiscoveredSession[]> {
    await this.pushBus.pollFiles();

    const perAdapter = await Promise.all(
      this.adapters.map((a) =>
        a
          .discoverSessions({ limit: filter.limit ?? 100 })
          .catch(() => [] as DiscoveredSession[]),
      ),
    );

    const byId = new Map<string, DiscoveredSession>();
    for (const list of perAdapter) {
      for (const s of list) {
        byId.set(s.sessionId, s);
      }
    }

    // Merge active push-bus sessions (upgrading mtime / creating push-only sessions)
    for (const ps of this.pushBus.discoverPushSessions()) {
      const existing = byId.get(ps.sessionId);
      if (existing) {
        existing.mtimeMs = Math.max(existing.mtimeMs, ps.mtimeMs);
        existing.isMultiAgent = existing.isMultiAgent || ps.isMultiAgent;
        if (!existing.projectId && ps.projectId) {
          existing.projectId = ps.projectId;
        }
        if (!existing.workspacePath && ps.workspacePath) {
          existing.workspacePath = ps.workspacePath;
        }
      } else {
        byId.set(ps.sessionId, ps);
      }
    }

    const projCriteria =
      filter.project && filter.project.trim().toLowerCase() !== "all"
        ? buildProjectFilterCriteria(filter.project)
        : undefined;
    const filtered = [...byId.values()].filter((s) =>
      sessionMatchesFilter(s, filter, projCriteria),
    );
    filtered.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return filtered.slice(0, filter.limit ?? 100);
  }

  async getSessionSnapshot(
    sessionId?: string,
    filter: SessionQueryFilter = {},
  ): Promise<{
    snapshot: RichSessionSnapshot;
    sessions: DiscoveredSession[];
    boardProjects: Array<{ id: string; title: string; root: string }>;
  }> {
    const sessions = await this.discoverSessions(filter);
    const boardProjects = listProjects().map((p) => ({
      id: p.id,
      title: p.title,
      root: p.root,
    }));

    const target = sessionId
      ? sessions.find((s) => s.sessionId === sessionId)
      : sessions[0];

    if (!target) {
      // Check if pushBus holds events for an explicitly requested sessionId
      const pushEvents = sessionId ? this.pushBus.getSessionEvents(sessionId) : [];
      const fallbackRoots = [
        ...(filter.workspace ? [filter.workspace] : []),
        process.cwd(),
      ];
      const team = await discoverTeamDetailsCached(
        fallbackRoots,
        filter.workspace,
        15_000,
      ).catch(() => null);
      const snap = buildSessionSnapshot(pushEvents, {
        sessionId: sessionId ?? "",
        ide: (pushEvents[0]?.ide ?? "unknown") as IdeSource,
        definitions: team?.definitions,
      });
      snap.definitions = team?.definitions ?? [];
      return { snapshot: snap, sessions, boardProjects };
    }

    const adapter = this.adapters.find((a) => a.ide === target.ide);
    const passiveEvents =
      adapter && target.filePath
        ? await adapter.parseSession(target).catch(() => [])
        : [];
    const pushEvents = this.pushBus.getSessionEvents(target.sessionId);

    const sessionWorkspaces = [
      ...(target.workspacePath ? [target.workspacePath] : []),
      ...target.workspaces,
      process.cwd(),
    ];
    const team = await discoverTeamDetailsCached(
      sessionWorkspaces,
      target.workspacePath,
      15_000,
    ).catch(() => null);

    const snapshot = buildSessionSnapshot([...passiveEvents, ...pushEvents], {
      sessionId: target.sessionId,
      ide: target.ide,
      projectId: target.projectId,
      workspacePath: target.workspacePath,
      definitions: team?.definitions,
    });
    snapshot.definitions = team?.definitions ?? [];

    // Backfill summary status on matched session entry
    target.status = snapshot.status;
    target.waitingOn = snapshot.waitingOn ?? null;
    target.isWaiting = snapshot.is_waiting;
    target.isCompleted = snapshot.is_completed;
    target.isMultiAgent = target.isMultiAgent || snapshot.is_multi_agent;

    return { snapshot, sessions, boardProjects };
  }
}
