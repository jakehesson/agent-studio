import os from "node:os";
import path from "node:path";
import { listProjects, resolveProject } from "../board/registry.js";
import type { ContextThresholds } from "../schema/team.js";
import type { AgentStatus, IdeSource } from "../schema/telemetry.js";
import { AntigravityAdapter } from "./adapters/antigravity.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import {
  CopilotVSCodeAdapter,
  resolveCopilotHomeDir,
} from "./adapters/copilot-vscode.js";
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
  type ContextAdvisory,
  type IngestResult,
} from "./push-bus.js";
import {
  capChatText,
  cleanHumanSummary,
  computePendingPromptId,
  formatQuestionsPreview,
  inferContextWindow,
  lookupModelContextWindow,
  normalizePendingQuestions,
  prettifyAgentLabel,
  type AdapterHealth,
  type AgentChatMessage,
  type AgentChatResponse,
  type ChatToolCallRef,
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
  copilotHomeDir?: string;
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

export const MAX_LATEST_SNAPSHOTS = 100;

export class TelemetryAggregator {
  readonly adapters: PassiveIdeAdapter[];
  readonly pushBus: PushBus;
  readonly bodyStore: EventBodyStore;
  private readonly latestSnapshots = new Map<
    string,
    {
      snapshot: RichSessionSnapshot;
      contextThresholds?: ContextThresholds;
      cachedAtMs: number;
    }
  >();

  private cacheSessionSnapshot(
    sessionId: string,
    snapshot: RichSessionSnapshot,
    contextThresholds?: ContextThresholds,
  ): void {
    if (!sessionId) return;
    if (this.latestSnapshots.has(sessionId)) {
      this.latestSnapshots.delete(sessionId);
    }
    this.latestSnapshots.set(sessionId, {
      snapshot,
      contextThresholds,
      cachedAtMs: Date.now(),
    });
    while (this.latestSnapshots.size > MAX_LATEST_SNAPSHOTS) {
      const oldest = this.latestSnapshots.keys().next().value;
      if (oldest === undefined) break;
      this.latestSnapshots.delete(oldest);
    }
  }

  constructor(options?: TelemetryAggregatorOptions) {
    this.bodyStore = options?.bodyStore ?? defaultEventBodyStore;
    this.adapters = options?.adapters ?? [
      new AntigravityAdapter({ brainDir: options?.brainDir }),
      new ClaudeCodeAdapter({ projectsDir: options?.claudeDir }),
      new CopilotVSCodeAdapter({
        storageDir: options?.vscodeDir,
        copilotHomeDir: options?.copilotHomeDir,
      }),
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

  getCachedAgentUsage(
    sessionId: string,
    agentId = "root",
  ): {
    contextTokens?: number;
    contextWindow?: number;
    model?: string;
    modelContextWindows?: Record<string, number>;
    contextThresholds?: ContextThresholds;
  } | null {
    const cached = this.latestSnapshots.get(sessionId);
    if (!cached) return null;
    const targetId = agentId?.trim() || "root";
    const ag =
      cached.snapshot.agents.find((a) => a.id === targetId) ??
      (targetId === "root"
        ? cached.snapshot.agents.find((a) => a.isRoot || a.id === "root")
        : undefined);
    return {
      contextTokens: ag?.usage?.contextTokens,
      contextWindow: ag?.usage?.contextWindow,
      model: ag?.usage?.model ?? ag?.model,
      modelContextWindows: cached.snapshot.modelContextWindows,
      contextThresholds: cached.contextThresholds,
    };
  }

  evaluateIngestAdvisory(events: EnrichedEvent[]): ContextAdvisory | null {
    let latestAdvisory: ContextAdvisory | null = null;
    for (const ev of events) {
      const cached = this.getCachedAgentUsage(ev.sessionId, ev.agentId);
      const live = this.pushBus.getAgentContextState(ev.sessionId, ev.agentId);
      const contextTokens = Math.max(
        live?.contextTokens ?? 0,
        cached?.contextTokens ?? 0,
      );
      const model =
        live?.model ??
        cached?.model ??
        (typeof ev.payload?.model === "string" && ev.payload.model.trim()
          ? ev.payload.model.trim()
          : undefined);
      const contextWindow =
        live?.contextWindow ??
        cached?.contextWindow ??
        (model
          ? lookupModelContextWindow(model, cached?.modelContextWindows)
          : undefined) ??
        inferContextWindow(model ?? "unknown", ev.ide);
      const rawHookEvent =
        typeof ev.payload?.hookEvent === "string" ? ev.payload.hookEvent : "";
      const isRawPreCompact =
        ev.payload?.isPreCompact === true ||
        rawHookEvent.toLowerCase() === "precompact";
      const isNewCopilotAdvisoryCarrier =
        ev.ide === "copilot-vscode" &&
        (rawHookEvent === "sessionStart" ||
          rawHookEvent === "postToolUse" ||
          rawHookEvent === "postToolUseFailure" ||
          rawHookEvent === "subagentStart" ||
          rawHookEvent === "notification");
      const hasDeferredPreCompact =
        !isRawPreCompact &&
        isNewCopilotAdvisoryCarrier &&
        this.pushBus.consumeDeferredPreCompactAdvisory(ev.sessionId, ev.agentId);
      const isPreCompact = isRawPreCompact || hasDeferredPreCompact;

      const adv = this.pushBus.evaluateContextAdvisory({
        sessionId: ev.sessionId,
        agentId: ev.agentId,
        ide: ev.ide,
        model,
        contextTokens,
        contextWindow,
        isPreCompact,
        thresholds: cached?.contextThresholds,
        modelContextWindows: cached?.modelContextWindows,
      });
      if (
        isRawPreCompact &&
        ev.ide === "copilot-vscode" &&
        rawHookEvent === "preCompact"
      ) {
        this.pushBus.markDeferredPreCompactAdvisory(ev.sessionId, ev.agentId);
      }
      if (adv) {
        latestAdvisory = adv;
      }
    }
    return latestAdvisory;
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
      const pushSummary = summarizePushWaiting(
        this.pushBus.getSessionEvents(ps.sessionId),
      );
      const existing = byId.get(ps.sessionId);
      if (existing) {
        const pushIsNewer = ps.mtimeMs >= existing.mtimeMs;
        existing.mtimeMs = Math.max(existing.mtimeMs, ps.mtimeMs);
        existing.isMultiAgent = existing.isMultiAgent || ps.isMultiAgent;
        if (!existing.projectId && ps.projectId) {
          existing.projectId = ps.projectId;
        }
        if (!existing.workspacePath && ps.workspacePath) {
          existing.workspacePath = ps.workspacePath;
        }
        if (pushIsNewer || !existing.waitingOn) {
          if (pushSummary.waitingOn) {
            existing.waitingOn = pushSummary.waitingOn;
            existing.pendingQuestionCount = pushSummary.pendingQuestionCount;
            existing.waitingSummary = pushSummary.waitingSummary;
            existing.status = "WAITING";
            existing.isWaiting = true;
          } else if (pushSummary.explicitlyCleared && pushIsNewer) {
            existing.waitingOn = null;
            existing.pendingQuestionCount = 0;
            delete existing.waitingSummary;
            existing.isWaiting = false;
            if (existing.status === "WAITING") {
              existing.status = pushSummary.suggestedStatus ?? "WORKING";
            }
          }
        }
      } else {
        ps.waitingOn = pushSummary.waitingOn;
        ps.pendingQuestionCount = pushSummary.pendingQuestionCount;
        if (pushSummary.waitingSummary) {
          ps.waitingSummary = pushSummary.waitingSummary;
        }
        if (pushSummary.waitingOn) {
          ps.status = "WAITING";
          ps.isWaiting = true;
        } else if (pushSummary.suggestedStatus) {
          ps.status = pushSummary.suggestedStatus;
        }
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
      roots.add(copilotAdapter.getCopilotHomeDir());
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
    roots.add(resolveCopilotHomeDir(home));
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
        modelContextWindows: team?.modelContextWindows,
      });
      snap.definitions = team?.definitions ?? [];
      const teamRoster = extractTeamRosterForSession(team, explicitRoots);
      if (teamRoster) {
        snap.teamRoster = teamRoster;
      }
      if (snap.sessionId) {
        this.cacheSessionSnapshot(snap.sessionId, snap, team?.contextThresholds);
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
        modelContextWindows: team?.modelContextWindows,
      },
    );
    snapshot.definitions = team?.definitions ?? [];
    const teamRoster = extractTeamRosterForSession(team, explicitRoots);
    if (teamRoster) {
      snapshot.teamRoster = teamRoster;
    }

    // Backfill summary status on matched session entry
    target.status = snapshot.status;
    const rawWait = snapshot.waitingOn ?? null;
    target.waitingOn =
      rawWait === "user" || rawWait === "tool_approval" || rawWait === "subagent"
        ? rawWait
        : rawWait?.startsWith("subagent:")
          ? "subagent"
          : null;
    target.pendingQuestionCount = snapshot.pendingPrompts?.length ?? 0;
    target.waitingSummary = snapshot.pendingPrompts?.[0]?.title;
    target.isWaiting = snapshot.is_waiting;
    target.isCompleted = snapshot.is_completed;
    target.isMultiAgent = target.isMultiAgent || snapshot.is_multi_agent;
    if (snapshot.sessionId) {
      this.cacheSessionSnapshot(
        snapshot.sessionId,
        snapshot,
        team?.contextThresholds,
      );
    }

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

  private async loadPushTranscriptChat(
    sessionId: string,
    opts: {
      excludeFilePath?: string;
      workspacePath?: string;
      trustedWorkspacePath?: string;
      projectId?: string;
      ide?: IdeSource;
      agentId?: string;
    },
  ): Promise<AgentChatMessage[]> {
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
    const out: AgentChatMessage[] = [];

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
      const msgs = await copilotAdapter
        .parseTranscriptChat(validPath, sessionId, {
          agentIdOverride,
          ...(agentLabelOverride ? { agentLabelOverride } : {}),
          workspacePath: opts.workspacePath,
          projectId: opts.projectId,
          allowedRoots,
        })
        .catch(() => [] as AgentChatMessage[]);
      out.push(...msgs);
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

    if (opts.agentId) {
      return out.filter((m) => m.agentId === opts.agentId);
    }
    return out;
  }

  async getAgentChat(params: {
    sessionId: string;
    agentId?: string;
    ide?: string;
    project?: string;
    workspace?: string;
    limit?: number;
    before?: string;
  }): Promise<AgentChatResponse | null> {
    const sessionId = params.sessionId.trim();
    if (!sessionId) return null;

    const sessions = await this.discoverSessions({
      ide: params.ide,
      project: params.project,
      workspace: params.workspace,
      limit: 500,
    });
    const target = sessions.find((s) => s.sessionId === sessionId);
    if (!target) {
      return null;
    }

    const snapRes = await this.getSessionSnapshot(target.sessionId, {
      ide: params.ide,
      project: params.project,
      workspace: params.workspace,
    });
    const snapshot = snapRes.snapshot;

    const requestedAgent = params.agentId?.trim() || "root";
    const agentNode =
      snapshot.agents.find((a) => a.id === requestedAgent) ??
      (requestedAgent === "root"
        ? snapshot.agents.find((a) => a.isRoot)
        : undefined);
    const resolvedAgentId = agentNode?.id ?? requestedAgent;
    const agentLabel =
      agentNode?.label ?? prettifyAgentLabel(resolvedAgentId);
    const pendingPrompt = agentNode?.pendingPrompt ?? null;

    const agentAliases = new Set<string>([resolvedAgentId, requestedAgent]);
    if (agentNode) {
      if (agentNode.label) agentAliases.add(agentNode.label);
      if (agentNode.convId) agentAliases.add(agentNode.convId);
    }
    for (const ev of snapshot.events) {
      const isSpawnOrDone =
        ev.kind === "subagent_spawn" || ev.kind === "subagent_done";
      const matchesAgent = isSpawnOrDone
        ? ev.targetAgentId === resolvedAgentId ||
          (ev.agentId === resolvedAgentId && !ev.targetAgentId)
        : ev.agentId === resolvedAgentId;
      if (!matchesAgent) continue;
      const pLbl =
        typeof ev.payload?.agentLabel === "string"
          ? ev.payload.agentLabel.trim()
          : undefined;
      const pType =
        typeof ev.payload?.agentType === "string"
          ? ev.payload.agentType.trim()
          : undefined;
      const pSubId =
        typeof ev.payload?.subagentId === "string"
          ? ev.payload.subagentId.trim()
          : undefined;
      if (pLbl) agentAliases.add(pLbl);
      if (pType) agentAliases.add(pType);
      if (pSubId) agentAliases.add(pSubId);
    }

    const adapter = this.adapters.find((a) => a.ide === target.ide);
    const isPassiveSession =
      Boolean(target.filePath) &&
      path.basename(target.filePath).toLowerCase() !== "telemetry.jsonl";

    const diskMsgs =
      adapter?.parseChat && isPassiveSession
        ? await adapter
            .parseChat(target, {
              agentId: resolvedAgentId,
              agentAliases: [...agentAliases],
            })
            .catch(() => [] as AgentChatMessage[])
        : [];

    const pushTranscriptMsgs = await this.loadPushTranscriptChat(
      target.sessionId,
      {
        excludeFilePath: target.filePath,
        workspacePath: target.workspacePath,
        trustedWorkspacePath: isPassiveSession
          ? target.workspacePath
          : undefined,
        projectId: target.projectId,
        ide: target.ide,
        agentId: resolvedAgentId,
      },
    );

    let allMsgs: AgentChatMessage[];
    if (diskMsgs.length > 0 || pushTranscriptMsgs.length > 0) {
      const seen = new Set<string>();
      allMsgs = [];
      for (const m of [...diskMsgs, ...pushTranscriptMsgs]) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        allMsgs.push(m);
      }
    } else {
      const pushEvents = this.pushBus.getSessionEvents(target.sessionId);
      const pushOnlyForAgent = pushEvents.filter(
        (e) =>
          e.agentId === resolvedAgentId ||
          (requestedAgent === "root" && e.agentId === "root"),
      );
      allMsgs = synthesizeChatFromEvents(
        pushOnlyForAgent,
        this.bodyStore,
        target.sessionId,
      );
    }

    allMsgs.sort((a, b) => a.epoch - b.epoch);

    const boundedMsgs: AgentChatMessage[] = allMsgs.map((m) => ({
      ...m,
      text: capChatText(m.text),
      ...(m.thinking !== undefined ? { thinking: capChatText(m.thinking) } : {}),
      ...(m.tools
        ? {
            tools: m.tools.map((t) => ({
              ...t,
              ...(t.inputPreview !== undefined
                ? { inputPreview: capChatText(t.inputPreview, 4096) }
                : {}),
              ...(t.output !== undefined
                ? { output: capChatText(t.output) }
                : {}),
            })),
          }
        : {}),
    }));

    const rawLimit = params.limit ?? 80;
    const limit = Math.max(
      1,
      Math.min(300, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 80),
    );
    const totalMessages = boundedMsgs.length;
    let endIdx = totalMessages;
    const before = params.before?.trim();
    if (before) {
      if (/^\d+$/.test(before)) {
        const parsedIdx = Number.parseInt(before, 10);
        endIdx = Math.max(0, Math.min(totalMessages, parsedIdx));
      } else {
        const idIdx = boundedMsgs.findIndex((m) => m.id === before);
        if (idIdx >= 0) {
          endIdx = idIdx;
        }
      }
    }

    const startIdx = Math.max(0, endIdx - limit);
    const page = boundedMsgs.slice(startIdx, endIdx);
    const hasMore = startIdx > 0;
    const nextCursor = hasMore ? String(startIdx) : undefined;

    return {
      ok: true,
      sessionId: target.sessionId,
      agentId: resolvedAgentId,
      agentLabel,
      ide: target.ide,
      messages: page,
      totalMessages,
      hasMore,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      pendingPrompt,
    };
  }
}

function summarizePushWaiting(events: EnrichedEvent[]): {
  waitingOn: "user" | "tool_approval" | "subagent" | null;
  pendingQuestionCount: number;
  waitingSummary?: string;
  explicitlyCleared: boolean;
  suggestedStatus?: AgentStatus;
} {
  if (events.length === 0) {
    return {
      waitingOn: null,
      pendingQuestionCount: 0,
      explicitlyCleared: false,
    };
  }
  const ordered = [...events].sort((a, b) => a.epoch - b.epoch);
  interface AgentWaitEntry {
    waitingOn: "user" | "tool_approval";
    pendingCallId?: string;
    pendingToolName?: string;
    pendingQuestionCount: number;
    waitingSummary?: string;
    epoch: number;
  }
  const waitingByAgent = new Map<string, AgentWaitEntry>();
  let clearedAny = false;
  let lastRootEvent: EnrichedEvent | undefined;
  let lastAnyEvent: EnrichedEvent | undefined;

  for (const ev of ordered) {
    lastAnyEvent = ev;
    const aid = ev.agentId || "root";
    if (aid === "root") {
      lastRootEvent = ev;
    }

    if (ev.kind === "user_input" || ev.kind === "assistant_turn_end") {
      if (waitingByAgent.delete(aid)) {
        clearedAny = true;
      }
    } else if (ev.kind === "subagent_done") {
      const doneAid =
        ev.targetAgentId && ev.targetAgentId !== aid ? ev.targetAgentId : aid;
      if (waitingByAgent.delete(doneAid)) {
        clearedAny = true;
      }
    } else if (ev.kind === "tool_start" || ev.kind === "board_mutation") {
      if (!ev.isSelfDaemon && waitingByAgent.delete(aid)) {
        clearedAny = true;
      }
      if (
        (ev.waitingReason === "user" || ev.waitingReason === "tool_approval") &&
        ev.status !== "denied"
      ) {
        const qs = normalizePendingQuestions(
          ev.payload?.questions ??
            ev.payload?.args ??
            ev.payload?.input ??
            ev.payload?.toolInput,
          { defaultAllowCustomInput: true },
        );
        const summary =
          cleanHumanSummary(
            String(
              ev.payload?.promptTitle ??
                qs[0]?.header ??
                qs[0]?.question ??
                ev.summary,
            ),
            80,
          ) || ev.summary;
        waitingByAgent.set(aid, {
          waitingOn: ev.waitingReason,
          pendingCallId: ev.toolCallId,
          pendingToolName: ev.toolName,
          pendingQuestionCount: Math.max(1, qs.length),
          waitingSummary: summary,
          epoch: ev.epoch,
        });
      }
    } else if (
      ev.kind === "message" &&
      (ev.waitingReason === "user" || ev.waitingReason === "tool_approval")
    ) {
      waitingByAgent.set(aid, {
        waitingOn: ev.waitingReason,
        pendingCallId: ev.toolCallId,
        pendingToolName: ev.toolName,
        pendingQuestionCount: 1,
        waitingSummary: cleanHumanSummary(ev.summary, 80) || ev.summary,
        epoch: ev.epoch,
      });
    } else if (ev.kind === "tool_end") {
      const cur = waitingByAgent.get(aid);
      if (cur) {
        const matches =
          (cur.pendingCallId && ev.toolCallId && cur.pendingCallId === ev.toolCallId) ||
          (!cur.pendingCallId &&
            (!cur.pendingToolName || !ev.toolName || cur.pendingToolName === ev.toolName)) ||
          (!ev.toolCallId &&
            (!cur.pendingToolName || !ev.toolName || cur.pendingToolName === ev.toolName));
        if (matches) {
          waitingByAgent.delete(aid);
          clearedAny = true;
        }
      }
    }
  }

  if (waitingByAgent.size > 0) {
    const primary =
      waitingByAgent.get("root") ??
      [...waitingByAgent.values()].sort((a, b) => b.epoch - a.epoch)[0]!;
    let totalCount = 0;
    for (const w of waitingByAgent.values()) {
      totalCount += w.pendingQuestionCount;
    }
    return {
      waitingOn: primary.waitingOn,
      pendingQuestionCount: totalCount,
      ...(primary.waitingSummary ? { waitingSummary: primary.waitingSummary } : {}),
      explicitlyCleared: false,
      suggestedStatus: "WAITING",
    };
  }

  const tailEv = lastRootEvent ?? lastAnyEvent;
  let suggestedStatus: AgentStatus = "WORKING";
  if (tailEv?.kind === "assistant_turn_end") {
    suggestedStatus = "DONE";
  } else if (
    tailEv?.kind === "user_input" ||
    tailEv?.kind === "thinking_start" ||
    (tailEv?.kind === "tool_end" && !tailEv.isError)
  ) {
    suggestedStatus = "THINKING";
  } else if (tailEv?.isError || tailEv?.status === "denied") {
    suggestedStatus = "BLOCKED";
  }

  return {
    waitingOn: null,
    pendingQuestionCount: 0,
    explicitlyCleared: clearedAny,
    suggestedStatus,
  };
}

export function synthesizeChatFromEvents(
  events: EnrichedEvent[],
  bodyStore: EventBodyStore,
  sessionId: string,
): AgentChatMessage[] {
  const ordered = [...events].sort((a, b) => a.epoch - b.epoch);
  const messages: AgentChatMessage[] = [];
  const toolRefByCallId = new Map<string, ChatToolCallRef>();

  const formatUnknown = (v: unknown): string => {
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  };

  for (const ev of ordered) {
    if (ev.kind === "session_start") continue;
    const storedBody = bodyStore.get(sessionId, ev.id)?.body;

    if (ev.kind === "user_input") {
      const txt =
        storedBody ??
        (typeof ev.payload?.body === "string" ? ev.payload.body : undefined) ??
        (typeof ev.payload?.prompt === "string"
          ? ev.payload.prompt
          : undefined) ??
        ev.summary.replace(/^Human:\s*/i, "");
      if (txt.trim()) {
        messages.push({
          id: `chat:push:${ev.id}`,
          ts: ev.ts,
          epoch: ev.epoch,
          agentId: ev.agentId,
          role: "user",
          text: capChatText(txt.trim()),
        });
      }
    } else if (ev.kind === "thinking_start") {
      const txt =
        storedBody ??
        (typeof ev.payload?.body === "string" ? ev.payload.body : undefined) ??
        ev.summary;
      if (txt.trim()) {
        messages.push({
          id: `chat:push:${ev.id}`,
          ts: ev.ts,
          epoch: ev.epoch,
          agentId: ev.agentId,
          role: "thinking",
          text: capChatText(txt.trim()),
          thinking: capChatText(txt.trim()),
        });
      }
    } else if (ev.kind === "tool_start" || ev.kind === "board_mutation") {
      if (ev.waitingReason === "user") {
        const qs = normalizePendingQuestions(
          ev.payload?.questions ??
            ev.payload?.args ??
            ev.payload?.input ??
            ev.payload?.toolInput,
          { defaultAllowCustomInput: true },
        );
        messages.push({
          id: `chat:push:${ev.id}`,
          ts: ev.ts,
          epoch: ev.epoch,
          agentId: ev.agentId,
          role: "question",
          text: capChatText(formatQuestionsPreview(qs, ev.summary)),
          pendingPromptId: computePendingPromptId(ev.agentId, ev.toolCallId, ev.id),
        });
      } else {
        const rawIn =
          ev.payload?.args ?? ev.payload?.input ?? ev.payload?.toolInput;
        const inputStr = formatUnknown(rawIn);
        const ref: ChatToolCallRef = {
          ...(ev.toolCallId ? { toolCallId: ev.toolCallId } : {}),
          toolName: ev.toolName ?? "tool",
          summary: ev.summary || ev.toolName || "Tool call",
          status: ev.status ?? "running",
          ...(inputStr ? { inputPreview: capChatText(inputStr, 4096) } : {}),
        };
        if (ev.toolCallId) {
          toolRefByCallId.set(ev.toolCallId, ref);
        }
        messages.push({
          id: `chat:push:${ev.id}`,
          ts: ev.ts,
          epoch: ev.epoch,
          agentId: ev.agentId,
          role: "tool",
          text: ref.summary,
          tools: [ref],
        });
      }
    } else if (ev.kind === "tool_end") {
      const outStr =
        storedBody ??
        formatUnknown(
          ev.payload?.outputPreview ??
            ev.payload?.preview ??
            ev.payload?.toolResult ??
            ev.payload?.result ??
            ev.payload?.error,
        ).trim();
      const matchedRef = ev.toolCallId
        ? toolRefByCallId.get(ev.toolCallId)
        : undefined;
      if (matchedRef) {
        matchedRef.status = ev.isError ? "error" : ev.status ?? "ok";
        if (outStr) matchedRef.output = capChatText(outStr);
      } else {
        messages.push({
          id: `chat:push:${ev.id}`,
          ts: ev.ts,
          epoch: ev.epoch,
          agentId: ev.agentId,
          role: "tool",
          text: capChatText(outStr || ev.summary),
          tools: [
            {
              ...(ev.toolCallId ? { toolCallId: ev.toolCallId } : {}),
              toolName: ev.toolName ?? "tool",
              summary: ev.summary,
              status: ev.isError ? "error" : ev.status ?? "ok",
              ...(outStr ? { output: capChatText(outStr) } : {}),
            },
          ],
        });
      }
    } else if (ev.kind === "message") {
      const body =
        storedBody ??
        (typeof ev.payload?.body === "string" ? ev.payload.body : undefined) ??
        ev.summary;
      if (ev.waitingReason === "user") {
        messages.push({
          id: `chat:push:${ev.id}`,
          ts: ev.ts,
          epoch: ev.epoch,
          agentId: ev.agentId,
          role: "question",
          text: capChatText(body),
          pendingPromptId: computePendingPromptId(ev.agentId, ev.toolCallId, ev.id),
        });
      } else if (ev.targetAgentId === "human") {
        messages.push({
          id: `chat:push:${ev.id}`,
          ts: ev.ts,
          epoch: ev.epoch,
          agentId: ev.agentId,
          role: "assistant",
          text: capChatText(body),
        });
      } else {
        messages.push({
          id: `chat:push:${ev.id}`,
          ts: ev.ts,
          epoch: ev.epoch,
          agentId: ev.agentId,
          role: "subagent",
          text: capChatText(body),
          ...(ev.targetAgentId ? { subagentId: ev.targetAgentId } : {}),
        });
      }
    } else if (ev.kind === "subagent_spawn" || ev.kind === "subagent_done") {
      const body =
        storedBody ??
        (typeof ev.payload?.prompt === "string"
          ? ev.payload.prompt
          : typeof ev.payload?.body === "string"
            ? ev.payload.body
            : undefined) ??
        ev.summary;
      const lbl =
        typeof ev.payload?.agentLabel === "string"
          ? ev.payload.agentLabel
          : undefined;
      messages.push({
        id: `chat:push:${ev.id}`,
        ts: ev.ts,
        epoch: ev.epoch,
        agentId: ev.agentId,
        role: "subagent",
        text: capChatText(body),
        ...(ev.targetAgentId ? { subagentId: ev.targetAgentId } : {}),
        ...(lbl ? { subagentLabel: lbl } : {}),
      });
    } else if (ev.kind === "assistant_turn_end") {
      const body =
        storedBody ??
        (typeof ev.payload?.body === "string" ? ev.payload.body : undefined) ??
        ev.summary;
      if (body.trim()) {
        messages.push({
          id: `chat:push:${ev.id}`,
          ts: ev.ts,
          epoch: ev.epoch,
          agentId: ev.agentId,
          role: "assistant",
          text: capChatText(body.trim()),
        });
      }
    }
  }

  return messages;
}
