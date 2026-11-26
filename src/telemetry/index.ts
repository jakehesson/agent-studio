import os from "node:os";
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
import {
  defaultEventBodyStore,
  type EventBodyEntry,
  type EventBodyStore,
} from "./body-store.js";
import { discoverTeamDetailsCached, type TeamDetails } from "./definitions.js";
import { buildSessionSnapshot } from "./normalizer.js";
import {
  PushBus,
  validateTranscriptPath,
  type IngestResult,
} from "./push-bus.js";
import {
  type AdapterHealth,
  type DiscoveredSession,
  type EnrichedEvent,
  type PassiveIdeAdapter,
  type RichSessionSnapshot,
} from "./types.js";

export * from "./types.js";
export * from "./body-store.js";
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
  bodyStore?: EventBodyStore;
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

function resolveProjectRootHint(projectHint?: string): string | undefined {
  const hint = projectHint?.trim();
  if (!hint || hint.toLowerCase() === "all") return undefined;
  try {
    return resolveProject(hint).root;
  } catch {
    return undefined;
  }
}

function extractTeamRosterForSession(
  team: TeamDetails | null,
  explicitRoots: string[],
): RichSessionSnapshot["teamRoster"] {
  if (!team || !team.hasManifest || team.roster.length === 0) {
    return undefined;
  }
  if (explicitRoots.length > 0) {
    const manifestRoot = team.project.root;
    const matchesSessionRoot = explicitRoots.some((r) =>
      pathMatchesRoot(r, manifestRoot),
    );
    if (!matchesSessionRoot) {
      return undefined;
    }
  }
  return team.roster.map((r) => ({
    id: r.id,
    ...(r.name ? { name: r.name } : {}),
    ...(r.boardRole || r.roleType
      ? { role: r.boardRole || r.roleType }
      : {}),
  }));
}

export class TelemetryAggregator {
  readonly adapters: PassiveIdeAdapter[];
  readonly pushBus: PushBus;
  readonly bodyStore: EventBodyStore;

  constructor(options?: TelemetryAggregatorOptions) {
    this.bodyStore = options?.bodyStore ?? defaultEventBodyStore;
    this.adapters = options?.adapters ?? [
      new AntigravityAdapter({ brainDir: options?.brainDir }),
      new ClaudeCodeAdapter({ projectsDir: options?.claudeDir }),
      new CopilotVSCodeAdapter({ storageDir: options?.vscodeDir }),
    ];
    this.pushBus = new PushBus({
      extraWorkspaces: options?.extraWorkspaces,
      includeGlobalTelemetryFile: options?.includeGlobalTelemetryFile,
      bodyStore: this.bodyStore,
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
    const isSyntheticMcp = (s: DiscoveredSession): boolean =>
      s.ide === "mcp" && s.sessionId.startsWith("mcp-");
    filtered.sort((a, b) => {
      const synthDiff = Number(isSyntheticMcp(a)) - Number(isSyntheticMcp(b));
      if (synthDiff !== 0) return synthDiff;
      return b.mtimeMs - a.mtimeMs;
    });
    return filtered.slice(0, filter.limit ?? 100);
  }

  private getAllowedTranscriptRoots(trustedWorkspacePath?: string): string[] {
    const roots = new Set<string>();
    const copilotAdapter = this.adapters.find(
      (a): a is CopilotVSCodeAdapter => a instanceof CopilotVSCodeAdapter,
    );
    if (copilotAdapter) {
      for (const dir of copilotAdapter.getStorageDirs()) {
        roots.add(dir);
      }
    }
    const antigravityAdapter = this.adapters.find(
      (a): a is AntigravityAdapter => a instanceof AntigravityAdapter,
    );
    if (antigravityAdapter) {
      roots.add(antigravityAdapter.getBrainDir());
    }
    const claudeAdapter = this.adapters.find(
      (a): a is ClaudeCodeAdapter => a instanceof ClaudeCodeAdapter,
    );
    if (claudeAdapter) {
      roots.add(claudeAdapter.getProjectsDir());
    }

    const home = os.homedir();
    roots.add(path.join(home, ".copilot"));
    roots.add(path.join(home, ".claude"));
    roots.add(path.join(home, ".gemini"));

    try {
      for (const proj of listProjects()) {
        if (proj.root) roots.add(proj.root);
      }
    } catch {
      // Registry unreadable; continue with configured roots.
    }
    for (const ws of this.pushBus.getExtraWorkspaces()) {
      if (ws) roots.add(ws);
    }
    if (trustedWorkspacePath && trustedWorkspacePath.trim()) {
      roots.add(trustedWorkspacePath.trim());
    }
    return [...roots];
  }

  private async loadPushTranscriptEvents(
    sessionId: string,
    opts: {
      excludeFilePath?: string;
      workspacePath?: string;
      trustedWorkspacePath?: string;
      projectId?: string;
      ide?: IdeSource;
    },
  ): Promise<EnrichedEvent[]> {
    const copilotAdapter = this.adapters.find(
      (a): a is CopilotVSCodeAdapter => a instanceof CopilotVSCodeAdapter,
    );
    if (!copilotAdapter) return [];
    const ide = opts.ide;
    if (ide && ide !== "copilot-vscode" && ide !== "unknown") {
      return [];
    }

    const allowedRoots = this.getAllowedTranscriptRoots(
      opts.trustedWorkspacePath,
    );
    const excludeNorm = opts.excludeFilePath
      ? path.resolve(opts.excludeFilePath).toLowerCase()
      : "";
    const parsedPaths = new Set<string>();
    const out: EnrichedEvent[] = [];

    const parseOne = async (
      tp: string,
      agentIdOverride?: string,
      agentLabelOverride?: string,
    ): Promise<void> => {
      const validPath = await validateTranscriptPath(tp, allowedRoots);
      if (!validPath) return;
      const low = validPath.toLowerCase();
      if (
        low === excludeNorm ||
        parsedPaths.has(low) ||
        path.basename(low) === "telemetry.jsonl"
      ) {
        return;
      }
      parsedPaths.add(low);
      const evs = await copilotAdapter
        .parseTranscriptFile(validPath, sessionId, {
          agentIdOverride,
          ...(agentLabelOverride ? { agentLabelOverride } : {}),
          workspacePath: opts.workspacePath,
          projectId: opts.projectId,
          allowedRoots,
          onFullBody: (eventId, body) => {
            this.bodyStore.set(sessionId, eventId, body);
          },
        })
        .catch(() => [] as EnrichedEvent[]);
      out.push(...evs);
    };

    const agentPaths = this.pushBus.getAgentTranscriptPaths(sessionId);
    const rootPath = agentPaths.get("root");
    if (rootPath) {
      await parseOne(rootPath, undefined);
    }
    for (const [aid, tp] of agentPaths.entries()) {
      if (aid === "root") continue;
      await parseOne(tp, aid, this.pushBus.getAgentLabel(sessionId, aid));
    }
    for (const tp of this.pushBus.getTranscriptPaths(sessionId)) {
      await parseOne(tp, undefined);
    }

    return out;
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
      const pushIde = (pushEvents[0]?.ide ?? "unknown") as IdeSource;
      const pushWs =
        pushEvents.find((e) => e.workspacePath)?.workspacePath ??
        filter.workspace;
      const pushProj = pushEvents.find((e) => e.projectId)?.projectId;
      const transcriptEvents = sessionId
        ? await this.loadPushTranscriptEvents(sessionId, {
            workspacePath: pushWs,
            projectId: pushProj,
            ide: pushIde,
          })
        : [];
      const resolvedPushProjectRoot = resolveProjectRootHint(pushProj);
      const resolvedFilterProjectRoot = resolveProjectRootHint(filter.project);
      const explicitRoots = [
        ...(pushWs ? [pushWs] : []),
        ...(resolvedPushProjectRoot ? [resolvedPushProjectRoot] : []),
        ...(filter.workspace ? [filter.workspace] : []),
        ...(resolvedFilterProjectRoot ? [resolvedFilterProjectRoot] : []),
      ];
      const fallbackRoots =
        explicitRoots.length > 0 ? explicitRoots : [process.cwd()];
      const team = await discoverTeamDetailsCached(
        fallbackRoots,
        pushWs ??
          resolvedPushProjectRoot ??
          filter.workspace ??
          resolvedFilterProjectRoot,
        15_000,
      ).catch(() => null);
      const snap = buildSessionSnapshot([...transcriptEvents, ...pushEvents], {
        sessionId: sessionId ?? "",
        ide: pushIde,
        projectId: pushProj,
        workspacePath: pushWs,
        definitions: team?.definitions,
      });
      snap.definitions = team?.definitions ?? [];
      const teamRoster = extractTeamRosterForSession(team, explicitRoots);
      if (teamRoster) {
        snap.teamRoster = teamRoster;
      }
      return { snapshot: snap, sessions, boardProjects };
    }

    const adapter = this.adapters.find((a) => a.ide === target.ide);
    const passiveEvents =
      adapter && target.filePath
        ? await adapter
            .parseSession(target, {
              onFullBody: (eventId, body) => {
                this.bodyStore.set(target.sessionId, eventId, body);
              },
            })
            .catch(() => [])
        : [];
    const pushEvents = this.pushBus.getSessionEvents(target.sessionId);
    const isPassiveSession =
      Boolean(target.filePath) &&
      path.basename(target.filePath).toLowerCase() !== "telemetry.jsonl";
    const pushTranscriptEvents = await this.loadPushTranscriptEvents(
      target.sessionId,
      {
        excludeFilePath: target.filePath,
        workspacePath: target.workspacePath,
        trustedWorkspacePath: isPassiveSession
          ? target.workspacePath
          : undefined,
        projectId: target.projectId,
        ide: target.ide,
      },
    );

    const resolvedTargetProjectRoot = resolveProjectRootHint(target.projectId);
    const resolvedFilterProjectRoot = resolveProjectRootHint(filter.project);
    const explicitRoots = [
      ...(target.workspacePath ? [target.workspacePath] : []),
      ...target.workspaces,
      ...(resolvedTargetProjectRoot ? [resolvedTargetProjectRoot] : []),
      ...(filter.workspace ? [filter.workspace] : []),
      ...(resolvedFilterProjectRoot ? [resolvedFilterProjectRoot] : []),
    ];
    const sessionWorkspaces =
      explicitRoots.length > 0 ? explicitRoots : [process.cwd()];
    const team = await discoverTeamDetailsCached(
      sessionWorkspaces,
      target.workspacePath ??
        resolvedTargetProjectRoot ??
        filter.workspace ??
        resolvedFilterProjectRoot,
      15_000,
    ).catch(() => null);

    const snapshot = buildSessionSnapshot(
      [...passiveEvents, ...pushTranscriptEvents, ...pushEvents],
      {
        sessionId: target.sessionId,
        ide: target.ide,
        projectId: target.projectId,
        workspacePath: target.workspacePath,
        definitions: team?.definitions,
      },
    );
    snapshot.definitions = team?.definitions ?? [];
    const teamRoster = extractTeamRosterForSession(team, explicitRoots);
    if (teamRoster) {
      snapshot.teamRoster = teamRoster;
    }

    // Backfill summary status on matched session entry
    target.status = snapshot.status;
    target.waitingOn = snapshot.waitingOn ?? null;
    target.isWaiting = snapshot.is_waiting;
    target.isCompleted = snapshot.is_completed;
    target.isMultiAgent = target.isMultiAgent || snapshot.is_multi_agent;

    return { snapshot, sessions, boardProjects };
  }

  async getEventBody(params: {
    sessionId: string;
    eventId: string;
    ide?: string;
    project?: string;
    workspace?: string;
  }): Promise<EventBodyEntry | null> {
    const { sessionId, eventId } = params;
    if (!sessionId || !eventId) return null;

    const cached = this.bodyStore.get(sessionId, eventId);
    if (cached) return cached;

    const sessions = await this.discoverSessions({
      ide: params.ide,
      project: params.project,
      workspace: params.workspace,
      limit: 200,
    });

    const afterPoll = this.bodyStore.get(sessionId, eventId);
    if (afterPoll) return afterPoll;

    const target = sessions.find((s) => s.sessionId === sessionId);

    if (target && target.filePath) {
      const adapter = this.adapters.find((a) => a.ide === target.ide);
      if (adapter) {
        await adapter
          .parseSession(target, {
            onFullBody: (eid, body) => {
              this.bodyStore.set(target.sessionId, eid, body);
            },
          })
          .catch(() => []);
        const fromPassive = this.bodyStore.get(sessionId, eventId);
        if (fromPassive) return fromPassive;
      }
    }

    // Fallback: check push-linked transcript files (including Copilot subagent transcripts)
    const pushEvents = this.pushBus.getSessionEvents(sessionId);
    const rawParamIde =
      params.ide && params.ide !== "all" ? (params.ide as IdeSource) : undefined;
    const pushIde = (target?.ide ??
      pushEvents[0]?.ide ??
      rawParamIde ??
      "unknown") as IdeSource;
    const pushWs =
      target?.workspacePath ??
      pushEvents.find((e) => e.workspacePath)?.workspacePath ??
      params.workspace;
    const pushProj =
      target?.projectId ??
      pushEvents.find((e) => e.projectId)?.projectId ??
      params.project;
    const isPassiveSession =
      Boolean(target?.filePath) &&
      path.basename(target!.filePath).toLowerCase() !== "telemetry.jsonl";

    await this.loadPushTranscriptEvents(sessionId, {
      excludeFilePath: target?.filePath,
      workspacePath: pushWs,
      trustedWorkspacePath: isPassiveSession
        ? target!.workspacePath
        : undefined,
      projectId: pushProj,
      ide: pushIde,
    }).catch(() => []);

    return this.bodyStore.get(sessionId, eventId) ?? null;
  }
}
