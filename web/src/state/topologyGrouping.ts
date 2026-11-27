import type {
  AgentEdgeSnapshot,
  AgentNodeSnapshot,
  AgentStatus,
  IdeSource,
  NormalizedEvent,
  PendingQuestionItem,
  PendingQuestionOption,
  TeamDefinitionEntry,
  TeamRosterRef,
} from "../types.js";
import {
  classifyEventReadable,
  classifyExternalTarget,
  cleanSummaryText,
  fmtClock,
  fmtDuration,
  formatActorName,
  isErrorEvent,
  isRoutineToolEnd,
  normalizeEpoch,
  truncateWords,
} from "../utils.js";

export type ClusterVisualState = "working" | "waiting" | "blocked" | "done";

export interface ClusterRunItem {
  agent: AgentNodeSnapshot;
  id: string;
  displayId: string;
  state: ClusterVisualState;
  tools: number;
  msgs: number;
  task: string;
}

export interface TeamAgentCluster {
  id: string;
  teamRole: string;
  subtitle: string;
  state: ClusterVisualState;
  ide: IdeSource;
  isTeamDefined: boolean;
  isAdhoc: boolean;
  threadKey: string;
  agentIds: string[];
  msgCount: number;
  msgsSent: number;
  msgsRecv: number;
  totalTools: number;
  extTools: string[];
  leadAgentId: string;
  leadTask: string;
  railColor: string;
  runs: ClusterRunItem[];
}

export type ThreadSelection =
  | {
      key: "all";
      kind: "all";
      label: string;
      route: string;
    }
  | {
      key: string;
      kind: "pair";
      a: string;
      b: string;
      aIds?: string[];
      bIds?: string[];
      label: string;
      route: string;
    }
  | {
      key: string;
      kind: "cluster";
      clusterId: string;
      agentIds: string[];
      runId?: string;
      label: string;
      route: string;
      runs?: ClusterRunItem[];
    }
  | {
      key: string;
      kind: "agent";
      agentId: string;
      label: string;
      route: string;
    };

export interface PeerLink {
  from: string;
  to: string;
  count: number;
  threadKey: string;
  label: string;
}

export interface TopologyModel {
  humanNode: AgentNodeSnapshot | null;
  rootAgent: AgentNodeSnapshot | null;
  externalNodes: AgentNodeSnapshot[];
  clusters: TeamAgentCluster[];
  peerLinks: PeerLink[];
  humanRootMsgCount: number;
  totalAiAgents: number;
  totalActors: number;
  autoMode: "grouped" | "mesh";
  extByAgent: Map<string, Set<string>>;
  pairCounts: Map<string, number>;
}

export interface ToolCategoryGroup {
  extId: string;
  label: string;
  count: number;
  events: NormalizedEvent[];
}

export interface BehindThoughtStep {
  kind: "thought";
  epoch: number;
  ts: string;
  timeLabel: string;
  text: string;
  event: NormalizedEvent;
  durationLabel?: string;
}

export interface BehindToolStep {
  kind: "tool";
  epoch: number;
  ts: string;
  timeLabel: string;
  toolName: string;
  summary: string;
  status: "running" | "ok" | "error" | "denied";
  durationSec?: number;
  durationLabel?: string;
  inputPreview?: string;
  outputPreview?: string;
  event: NormalizedEvent;
  endEvent?: NormalizedEvent;
}

export type BehindStep = BehindThoughtStep | BehindToolStep;

export interface BehindSummary {
  thoughtCount: number;
  toolCount: number;
  durationLabel?: string;
}

export interface SmsMessageItem {
  kind: "message";
  event: NormalizedEvent;
  dir: "inbound" | "outbound";
  fromLabel: string;
  roleBadge: string;
  routeLabel: string;
  timeLabel: string;
  text: string;
  fullMarkdownText: string;
  tools: string[];
  toolGroups: ToolCategoryGroup[];
  runId?: string;
  hasFullBody: boolean;
  accentColor: string;
  isHumanAnswer?: boolean;
  replyToEntryId?: string;
  replyToQuote?: string;
  replyToActorLabel?: string;
  questions?: PendingQuestionItem[];
  chosenAnswerText?: string;
  behindSteps: BehindStep[];
  behindSummary: BehindSummary;
}

export interface SmsToolBurstItem {
  kind: "tool_burst";
  groupKey: string;
  agentId: string;
  agentLabel: string;
  events: NormalizedEvent[];
  categories: ToolCategoryGroup[];
  categorySummary: string;
  timeRange: string;
  hasError: boolean;
  dir: "inbound" | "outbound";
  accentColor: string;
}

export type SmsStreamEntry = SmsMessageItem | SmsToolBurstItem;

interface CatalogTarget {
  key: string;
  id: string;
  name: string;
  roleDesc: string;
  aliases: Set<string>;
}

const CLUSTER_RAIL_PALETTE = [
  "#f59e0b",
  "#06b6d4",
  "#a855f7",
  "#10b981",
  "#ec4899",
  "#38bdf8",
  "#818cf8",
];

export function pickRailColor(key: string): string {
  const baseKey = key.replace(/::(?:active|done)$/, "");
  let h = 0;
  for (let i = 0; i < baseKey.length; i++) {
    h = (h * 31 + baseKey.charCodeAt(i)) | 0;
  }
  return CLUSTER_RAIL_PALETTE[Math.abs(h) % CLUSTER_RAIL_PALETTE.length] ?? "#06b6d4";
}

function normSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function stripIdePrefix(slug: string): string {
  return slug.replace(/^(?:ag|cc|gh|vsc|av|vs|mc)-/, "");
}

function stripRunSuffix(raw: string): string {
  return raw
    .trim()
    .replace(/(?:\s*#\d+|\s+run\s*\d+|[-_:]run[-_:]?\d+|[-_:]\d+|\s+\(\d+\))$/i, "")
    .trim();
}

const GENERIC_PLACEHOLDER_SLUGS = new Set([
  "specialist-subagent",
  "specialist",
  "specialist-agent",
  "sub-agent",
  "subagent",
  "assistant",
  "task",
  "runsubagent",
  "agent",
  "worker",
  "adhoc",
  "ad-hoc",
  "explore",
  "general-purpose",
  "general",
]);

export function isGenericPlaceholderRole(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const s = stripIdePrefix(normSlug(stripRunSuffix(raw)));
  return !s || GENERIC_PLACEHOLDER_SLUGS.has(s);
}

function isGenericTaskSlug(slug: string): boolean {
  const s = stripIdePrefix(normSlug(stripRunSuffix(slug)));
  return !s || GENERIC_PLACEHOLDER_SLUGS.has(s);
}

function isOpaqueActorId(raw: string): boolean {
  const s = raw.trim();
  if (!s) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return true;
  }
  const stripped = stripIdePrefix(normSlug(stripRunSuffix(s)));
  if (!stripped) return true;
  if (/^(?:agent-|subagent-|run-|task-)?[0-9a-f]{6,}$/i.test(stripped)) {
    return true;
  }
  return /^\d+$/.test(stripped);
}

export function mapAgentStatusToClusterState(status: AgentStatus): ClusterVisualState {
  switch (status) {
    case "BLOCKED":
      return "blocked";
    case "WORKING":
    case "THINKING":
      return "working";
    case "WAITING":
      return "waiting";
    default:
      return "done";
  }
}

function statePriority(s: ClusterVisualState): number {
  switch (s) {
    case "blocked":
      return 4;
    case "working":
      return 3;
    case "waiting":
      return 2;
    default:
      return 1;
  }
}

function aggregateClusterState(runs: ClusterRunItem[]): ClusterVisualState {
  let best: ClusterVisualState = "done";
  for (const r of runs) {
    if (statePriority(r.state) > statePriority(best)) {
      best = r.state;
    }
  }
  return best;
}

function buildTeamCatalog(
  teamRoster?: TeamRosterRef[],
  definitions?: TeamDefinitionEntry[]
): CatalogTarget[] {
  const byKey = new Map<string, CatalogTarget>();

  const addEntry = (id: string, name?: string, roleDesc?: string) => {
    const cleanId = id.trim();
    if (!cleanId) return;
    const baseSlug = stripIdePrefix(normSlug(cleanId));
    if (!baseSlug || baseSlug === "orchestrator" || baseSlug === "root") return;

    const existing = byKey.get(baseSlug);
    const aliases = existing?.aliases ?? new Set<string>();
    aliases.add(normSlug(cleanId));
    aliases.add(baseSlug);
    if (name?.trim()) {
      aliases.add(normSlug(name));
      aliases.add(stripIdePrefix(normSlug(name)));
    }

    if (existing) {
      if (!existing.name && name?.trim()) existing.name = name.trim();
      if (!existing.roleDesc && roleDesc?.trim()) existing.roleDesc = roleDesc.trim();
      return;
    }

    byKey.set(baseSlug, {
      key: baseSlug,
      id: cleanId,
      name: (name ?? "").trim() || cleanId,
      roleDesc: (roleDesc ?? "").trim(),
      aliases,
    });
  };

  for (const entry of teamRoster ?? []) {
    addEntry(entry.id, entry.name, entry.role);
  }
  for (const def of definitions ?? []) {
    const roleDesc =
      def.roleType && def.boardRole && def.roleType.toLowerCase() !== def.boardRole.toLowerCase()
        ? `${def.roleType} · ${def.boardRole}`
        : def.roleType || def.boardRole || "";
    addEntry(def.id, def.name, roleDesc);
  }

  return Array.from(byKey.values());
}

function matchAgentToCatalog(
  agent: AgentNodeSnapshot,
  catalog: CatalogTarget[]
): CatalogTarget | null {
  if (catalog.length === 0) return null;

  const rawCandidates: string[] = [
    stripRunSuffix(agent.id),
    agent.id,
    stripRunSuffix(agent.label ?? ""),
    agent.label ?? "",
  ];
  if (agent.role && !isGenericPlaceholderRole(agent.role)) {
    rawCandidates.push(stripRunSuffix(agent.role), agent.role);
  }

  const orderedSlugs: string[] = [];
  const seenSlugs = new Set<string>();
  const pushSlug = (s: string) => {
    if (!s || isGenericTaskSlug(s) || seenSlugs.has(s)) return;
    seenSlugs.add(s);
    orderedSlugs.push(s);
  };

  for (const raw of rawCandidates) {
    if (!raw || !raw.trim()) continue;
    const s = normSlug(raw);
    if (!s) continue;
    pushSlug(s);
    pushSlug(stripIdePrefix(s));
  }

  // Pass 1: exact alias match in candidate priority order
  for (const cand of orderedSlugs) {
    for (const item of catalog) {
      if (item.aliases.has(cand)) return item;
    }
  }

  // Pass 2: longest prefix/suffix match in candidate priority order (e.g. "frontend-engineer-run-2" -> "frontend-engineer")
  for (const cand of orderedSlugs) {
    let bestItem: CatalogTarget | null = null;
    let bestLen = 0;
    for (const item of catalog) {
      for (const alias of item.aliases) {
        if (
          alias.length >= 4 &&
          alias.length > bestLen &&
          (cand.startsWith(`${alias}-`) || cand.endsWith(`-${alias}`))
        ) {
          bestItem = item;
          bestLen = alias.length;
        }
      }
    }
    if (bestItem) return bestItem;
  }

  return null;
}

export function isCommunicationEvent(ev: NormalizedEvent): boolean {
  if (
    ev.kind === "message" ||
    ev.kind === "user_input" ||
    ev.kind === "subagent_spawn" ||
    ev.kind === "subagent_done" ||
    ev.kind === "assistant_turn_end"
  ) {
    return true;
  }
  if (ev.kind === "tool_start") {
    const tool = (ev.toolName ?? "").toLowerCase();
    return (
      tool === "ask_question" ||
      tool === "ask_user" ||
      tool === "askuserquestion" ||
      tool === "vscode_askquestions" ||
      tool === "questioncarousel" ||
      tool === "elicitationserialized" ||
      tool === "write_agent" ||
      tool === "read_agent"
    );
  }
  return false;
}

function isHumanPromptToolName(toolName?: string): boolean {
  const low = (toolName ?? "").toLowerCase();
  return (
    low === "ask_question" ||
    low === "ask_user" ||
    low === "askuserquestion" ||
    low === "vscode_askquestions" ||
    low === "questioncarousel" ||
    low === "elicitationserialized"
  );
}

function normalizeEndpointId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const trimmed = id.trim();
  if (!trimmed) return undefined;
  return trimmed === "human" ? "ext:human" : trimmed;
}

export function resolveCommEndpoints(
  ev: NormalizedEvent,
  rootId: string | undefined,
  agentParentMap: Map<string, string | undefined>
): { fromId: string; toId: string } | null {
  if (!isCommunicationEvent(ev)) return null;

  if (ev.kind === "user_input") {
    const rawActor = normalizeEndpointId(ev.agentId);
    const actor =
      rawActor && rawActor !== "ext:human"
        ? rawActor
        : normalizeEndpointId(ev.targetAgentId) || rootId || "root";
    if (ev.payload?.isHumanAnswer === true) {
      return { fromId: "ext:human", toId: actor };
    }
    const parentId = normalizeEndpointId(ev.parentAgentId || agentParentMap.get(actor));
    const isSub = Boolean(rootId && actor !== rootId && parentId);
    if (!isSub) {
      return { fromId: "ext:human", toId: actor };
    }
    return { fromId: parentId!, toId: actor };
  }

  if (ev.kind === "tool_start" && isHumanPromptToolName(ev.toolName)) {
    const fromId = normalizeEndpointId(ev.agentId);
    return fromId ? { fromId, toId: "ext:human" } : null;
  }

  if (ev.kind === "tool_start") {
    const fromId = normalizeEndpointId(ev.agentId);
    const toId =
      normalizeEndpointId(ev.targetAgentId) ||
      normalizeEndpointId(ev.parentAgentId || (fromId ? agentParentMap.get(fromId) : undefined)) ||
      rootId;
    return fromId && toId && fromId !== toId ? { fromId, toId } : null;
  }

  if (ev.kind === "subagent_spawn") {
    const fromId = normalizeEndpointId(ev.agentId);
    const toId = normalizeEndpointId(ev.targetAgentId);
    return fromId && toId && fromId !== toId ? { fromId, toId } : null;
  }

  if (ev.kind === "subagent_done") {
    if (!ev.targetAgentId && (ev.agentId === "root" || ev.agentId === rootId)) {
      return null;
    }
    const childId = normalizeEndpointId(
      ev.targetAgentId && ev.targetAgentId !== ev.agentId ? ev.targetAgentId : ev.agentId
    );
    const parentId =
      normalizeEndpointId(ev.parentAgentId || (childId ? agentParentMap.get(childId) : undefined)) ||
      rootId;
    return childId && parentId && childId !== parentId
      ? { fromId: childId, toId: parentId }
      : null;
  }

  if (ev.kind === "assistant_turn_end") {
    const fromId = normalizeEndpointId(ev.agentId);
    const toId =
      normalizeEndpointId(ev.targetAgentId) ||
      normalizeEndpointId(ev.parentAgentId || (fromId ? agentParentMap.get(fromId) : undefined)) ||
      (fromId === rootId ? "ext:human" : rootId);
    return fromId && toId && fromId !== toId ? { fromId, toId } : null;
  }

  if (ev.kind === "message") {
    const fromId = normalizeEndpointId(ev.agentId);
    const explicitTarget = normalizeEndpointId(ev.targetAgentId);
    const toId =
      (explicitTarget && explicitTarget !== fromId ? explicitTarget : undefined) ||
      normalizeEndpointId(ev.parentAgentId || (fromId ? agentParentMap.get(fromId) : undefined)) ||
      (fromId === rootId ? "ext:human" : rootId);
    return fromId && toId && fromId !== toId ? { fromId, toId } : null;
  }

  return null;
}

export function eventTouchesPair(
  ev: NormalizedEvent,
  a: string,
  b: string,
  rootId: string | undefined,
  agentParentMap: Map<string, string | undefined>,
  aIds?: string[],
  bIds?: string[]
): boolean {
  const ep = resolveCommEndpoints(ev, rootId, agentParentMap);
  if (!ep) return false;

  const setA = new Set((aIds && aIds.length > 0 ? aIds : [a]).map((id) => normalizeEndpointId(id) || id));
  const setB = new Set((bIds && bIds.length > 0 ? bIds : [b]).map((id) => normalizeEndpointId(id) || id));

  return (setA.has(ep.fromId) && setB.has(ep.toId)) || (setB.has(ep.fromId) && setA.has(ep.toId));
}

export function matchesThreadSelection(
  ev: NormalizedEvent,
  thread: ThreadSelection,
  rootId: string | undefined,
  agentParentMap: Map<string, string | undefined>
): boolean {
  const ep = resolveCommEndpoints(ev, rootId, agentParentMap);
  if (!ep) return false;

  if (thread.kind === "all") {
    return true;
  }
  if (thread.kind === "pair") {
    return eventTouchesPair(ev, thread.a, thread.b, rootId, agentParentMap, thread.aIds, thread.bIds);
  }
  if (thread.kind === "cluster") {
    const clusterSet = new Set(thread.runId ? [thread.runId] : thread.agentIds);
    if (rootId) {
      return (
        (ep.fromId === rootId && clusterSet.has(ep.toId)) ||
        (clusterSet.has(ep.fromId) && ep.toId === rootId)
      );
    }
    return clusterSet.has(ep.fromId) || clusterSet.has(ep.toId);
  }
  if (thread.kind === "agent") {
    const target = normalizeEndpointId(thread.agentId) || thread.agentId;
    return ep.fromId === target || ep.toId === target;
  }
  return false;
}

export function buildTopologyModel(opts: {
  agents: AgentNodeSnapshot[];
  edges: AgentEdgeSnapshot[];
  events: NormalizedEvent[];
  teamRoster?: TeamRosterRef[];
  definitions?: TeamDefinitionEntry[];
  labelMap?: Map<string, string>;
}): TopologyModel {
  const { agents, edges, events, teamRoster, definitions, labelMap } = opts;

  const humanNode =
    agents.find((a) => a.nodeType === "human" || a.id === "ext:human") ?? null;
  const externalNodes = agents.filter((a) => a.nodeType === "external");
  const aiAgents = agents.filter(
    (a) => (a.nodeType ?? "agent") === "agent" && a.id !== "ext:human"
  );
  const rootAgent =
    aiAgents.find((a) => a.id === "root" || !a.parentAgentId) ?? aiAgents[0] ?? null;
  const subagents = rootAgent
    ? aiAgents.filter((a) => a.id !== rootAgent.id)
    : [];

  const extByAgent = new Map<string, Set<string>>();
  const addExt = (aid: string, extId: string) => {
    if (!aid || !extId || extId === "ext:human") return;
    let s = extByAgent.get(aid);
    if (!s) {
      s = new Set<string>();
      extByAgent.set(aid, s);
    }
    s.add(extId);
  };

  const pairCounts = new Map<string, number>();
  const bumpPair = (a: string, b: string, delta: number) => {
    if (!a || !b || a === b) return;
    const key = [a, b].sort().join("|");
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + delta);
  };

  for (const e of edges) {
    if (e.from.startsWith("ext:") && e.from !== "ext:human") {
      addExt(e.to, e.from);
      continue;
    }
    if (e.to.startsWith("ext:") && e.to !== "ext:human") {
      addExt(e.from, e.to);
      continue;
    }
    bumpPair(e.from, e.to, e.count);
  }

  for (const ev of events) {
    if (ev.kind === "tool_start") {
      const ext = ev.targetAgentId?.startsWith("ext:")
        ? { id: ev.targetAgentId }
        : classifyExternalTarget(ev.toolName);
      if (ext && ext.id !== "ext:human") addExt(ev.agentId, ext.id);
    } else if (ev.kind === "board_mutation") {
      addExt(ev.agentId, "ext:board");
    }
  }

  const catalog = buildTeamCatalog(teamRoster, definitions);

  interface DraftCluster {
    id: string;
    teamRole: string;
    subtitle: string;
    isTeamDefined: boolean;
    isAdhoc: boolean;
    agents: AgentNodeSnapshot[];
  }

  const draftClusters = new Map<string, DraftCluster>();
  const unmatchedByRole = new Map<string, { label: string; agents: AgentNodeSnapshot[] }>();
  const adhocAgents: AgentNodeSnapshot[] = [];

  for (const sub of subagents) {
    const matched = matchAgentToCatalog(sub, catalog);
    if (matched) {
      const cid = `team:${matched.key}`;
      let entry = draftClusters.get(cid);
      if (!entry) {
        entry = {
          id: cid,
          teamRole: matched.name,
          subtitle: matched.roleDesc
            ? `Team Agent · ${matched.roleDesc}`
            : "Team Agent",
          isTeamDefined: true,
          isAdhoc: false,
          agents: [],
        };
        draftClusters.set(cid, entry);
      }
      entry.agents.push(sub);
      continue;
    }

    let baseRoleRaw = "";
    const rawRole = sub.role?.trim() ?? "";
    if (rawRole && !isGenericPlaceholderRole(rawRole)) {
      const strippedRole = stripRunSuffix(rawRole);
      if (strippedRole && !isGenericTaskSlug(strippedRole) && !isOpaqueActorId(strippedRole)) {
        baseRoleRaw = strippedRole;
      }
    }
    if (!baseRoleRaw) {
      const strippedId = stripRunSuffix(sub.id);
      if (strippedId && !isGenericTaskSlug(strippedId) && !isOpaqueActorId(strippedId)) {
        baseRoleRaw = formatActorName(strippedId);
      }
    }
    if (!baseRoleRaw) {
      const rawLabel = (sub.label?.trim() || labelMap?.get(sub.id)?.trim() || "");
      const strippedLabel = stripRunSuffix(rawLabel);
      if (
        strippedLabel &&
        !isGenericPlaceholderRole(strippedLabel) &&
        !isGenericTaskSlug(strippedLabel) &&
        !isOpaqueActorId(strippedLabel)
      ) {
        baseRoleRaw = formatActorName(strippedLabel, undefined, strippedLabel);
      }
    }
    const roleSlug = normSlug(baseRoleRaw);

    if (isGenericTaskSlug(baseRoleRaw) || !roleSlug) {
      adhocAgents.push(sub);
    } else {
      const existing = unmatchedByRole.get(roleSlug);
      if (existing) {
        existing.agents.push(sub);
      } else {
        unmatchedByRole.set(roleSlug, { label: baseRoleRaw, agents: [sub] });
      }
    }
  }

  // Repeated non-generic unmatched roles (>= 2 runs) become their own cluster; singletons go to Ad-hoc / Task
  for (const [roleSlug, group] of unmatchedByRole.entries()) {
    if (group.agents.length >= 2) {
      const cid = `role:${roleSlug}`;
      draftClusters.set(cid, {
        id: cid,
        teamRole: group.label,
        subtitle: `Subagent Role ×${group.agents.length}`,
        isTeamDefined: false,
        isAdhoc: false,
        agents: group.agents,
      });
    } else {
      adhocAgents.push(...group.agents);
    }
  }

  if (adhocAgents.length > 0) {
    draftClusters.set("adhoc-task", {
      id: "adhoc-task",
      teamRole: "Ad-hoc / Task",
      subtitle:
        adhocAgents.length === 1
          ? "Unmatched task subagent"
          : `Unmatched task subagents ×${adhocAgents.length}`,
      isTeamDefined: false,
      isAdhoc: true,
      agents: adhocAgents,
    });
  }

  const rootId = rootAgent?.id;
  const agentParentMap = new Map<string, string | undefined>();
  for (const a of agents) {
    agentParentMap.set(a.id, a.parentAgentId);
  }

  const commPairCounts = new Map<string, number>();
  const bumpCommPair = (a: string, b: string) => {
    if (!a || !b || a === b) return;
    const key = [a, b].sort().join("|");
    commPairCounts.set(key, (commPairCounts.get(key) ?? 0) + 1);
  };
  for (const ev of events) {
    const ep = resolveCommEndpoints(ev, rootId, agentParentMap);
    if (ep) {
      bumpCommPair(ep.fromId, ep.toId);
    }
  }
  const hasEvents = events.length > 0;
  const effectivePairCounts = hasEvents ? commPairCounts : pairCounts;

  const clusters: TeamAgentCluster[] = [];

  for (const draft of draftClusters.values()) {
    const allRuns: ClusterRunItem[] = draft.agents.map((a, idx) => {
      const baseName = formatActorName(a.id, labelMap, a.label);
      const hasNum = /#\d+$/.test(baseName);
      const displayId =
        draft.agents.length > 1 && !hasNum ? `${baseName} #${idx + 1}` : baseName;
      const state = mapAgentStatusToClusterState(a.status);
      const lineMsgs = rootId
        ? effectivePairCounts.get([rootId, a.id].sort().join("|")) ?? 0
        : 0;
      const msgs = hasEvents
        ? lineMsgs
        : lineMsgs > 0
          ? lineMsgs
          : a.messagesSent + a.messagesReceived;
      const roleHint = a.role && !isGenericPlaceholderRole(a.role) ? a.role : undefined;
      const task = cleanSummaryText(
        a.activeTool ? `⚙ ${a.activeTool}` : a.summary || roleHint || "Standby"
      );
      return {
        agent: a,
        id: a.id,
        displayId,
        state,
        tools: a.toolCalls || 0,
        msgs,
        task,
      };
    });

    const railColor = draft.isAdhoc ? "#6366f1" : pickRailColor(draft.id);

    const pushClusterSlice = (
      sliceId: string,
      sliceRuns: ClusterRunItem[],
      isSplitSlice: boolean,
      sliceKind?: "active" | "done"
    ) => {
      // Active / waiting / blocked runs first, then completed runs
      sliceRuns.sort((a, b) => {
        const diff = statePriority(b.state) - statePriority(a.state);
        if (diff !== 0) return diff;
        return (b.agent.lastEpoch ?? 0) - (a.agent.lastEpoch ?? 0);
      });

      const clusterState = aggregateClusterState(sliceRuns);
      const agentIds = sliceRuns.map((r) => r.id);
      const extSet = new Set<string>();
      let totalTools = 0;
      let msgsSent = 0;
      let msgsRecv = 0;
      let lineMsgSum = 0;

      for (const r of sliceRuns) {
        totalTools += r.tools;
        msgsSent += r.agent.messagesSent || 0;
        msgsRecv += r.agent.messagesReceived || 0;
        if (rootId) {
          lineMsgSum += effectivePairCounts.get([rootId, r.id].sort().join("|")) ?? 0;
        }
        for (const ext of extByAgent.get(r.id) ?? []) {
          extSet.add(ext);
        }
      }

      const msgCount = hasEvents
        ? lineMsgSum
        : lineMsgSum > 0
          ? lineMsgSum
          : Math.max(msgsSent + msgsRecv, sliceRuns.length);
      const leadRun = sliceRuns[0];

      let sliceSubtitle = draft.subtitle;
      if (isSplitSlice) {
        if (draft.isAdhoc) {
          const adj = sliceKind === "active" ? "Active" : "Completed";
          sliceSubtitle =
            sliceRuns.length === 1
              ? `${adj} task subagent`
              : `${adj} task subagents ×${sliceRuns.length}`;
        } else if (!draft.isTeamDefined) {
          sliceSubtitle = `Subagent Role ×${sliceRuns.length}`;
        }
      }

      clusters.push({
        id: sliceId,
        teamRole: draft.teamRole,
        subtitle: sliceSubtitle,
        state: clusterState,
        ide: leadRun?.agent.ide ?? rootAgent?.ide ?? "unknown",
        isTeamDefined: draft.isTeamDefined,
        isAdhoc: draft.isAdhoc,
        threadKey: `cluster:${sliceId}`,
        agentIds,
        msgCount,
        msgsSent,
        msgsRecv,
        totalTools,
        extTools: Array.from(extSet),
        leadAgentId: leadRun?.id ?? sliceId,
        leadTask: leadRun?.task || sliceSubtitle,
        railColor,
        runs: sliceRuns,
      });
    };

    const activeRuns = allRuns.filter((r) => r.state !== "done");
    const doneRuns = allRuns.filter((r) => r.state === "done");

    if (activeRuns.length > 0 && doneRuns.length > 0) {
      pushClusterSlice(`${draft.id}::active`, activeRuns, true, "active");
      pushClusterSlice(`${draft.id}::done`, doneRuns, true, "done");
    } else {
      pushClusterSlice(draft.id, allRuns, false);
    }
  }

  // Sort clusters: active/working/waiting/blocked first, Ad-hoc at end of its tier
  clusters.sort((a, b) => {
    const pa = statePriority(a.state);
    const pb = statePriority(b.state);
    if (pa !== pb) return pb - pa;
    if (a.isAdhoc !== b.isAdhoc) return a.isAdhoc ? 1 : -1;
    return b.runs.length - a.runs.length || a.teamRole.localeCompare(b.teamRole);
  });

  // Cross-agent peer links (non-root, non-human, non-external)
  const peerLinks: PeerLink[] = [];
  const subagentIdSet = new Set(subagents.map((s) => s.id));
  for (const [pairKey, count] of effectivePairCounts.entries()) {
    if (count <= 0) continue;
    const [a, b] = pairKey.split("|");
    if (!a || !b) continue;
    if (subagentIdSet.has(a) && subagentIdSet.has(b)) {
      const labelA = formatActorName(a, labelMap);
      const labelB = formatActorName(b, labelMap);
      peerLinks.push({
        from: a,
        to: b,
        count,
        threadKey: `pair:${a}|${b}`,
        label: `${labelA} ↔ ${labelB}`,
      });
    }
  }

  const humanKeyId = humanNode ? normalizeEndpointId(humanNode.id) || humanNode.id : undefined;
  const humanRootMsgCount =
    humanKeyId && rootId
      ? hasEvents
        ? effectivePairCounts.get([humanKeyId, rootId].sort().join("|")) ?? 0
        : effectivePairCounts.get([humanKeyId, rootId].sort().join("|")) ||
          (humanNode?.messagesSent ?? 0) + (humanNode?.messagesReceived ?? 0)
      : 0;

  const totalAiAgents = aiAgents.length;
  const totalActors = totalAiAgents + (humanNode ? 1 : 0);
  const hasRepeatedRoles = clusters.some((c) => c.runs.length > 1);
  const autoMode: "grouped" | "mesh" =
    totalActors > 8 || hasRepeatedRoles ? "grouped" : "mesh";

  return {
    humanNode,
    rootAgent,
    externalNodes,
    clusters,
    peerLinks,
    humanRootMsgCount,
    totalAiAgents,
    totalActors,
    autoMode,
    extByAgent,
    pairCounts,
  };
}

function formatExternalToolLabel(extId: string): string {
  if (extId === "ext:fs") return "Workspace FS";
  if (extId === "ext:shell") return "Local Shell";
  if (extId === "ext:board") return "Agile Board";
  if (extId === "ext:web") return "Web & Docs";
  if (extId === "ext:tool") return "Tools";
  return extId.replace(/^ext:mcp:/i, "MCP: ");
}

function resolveToolExtId(ev: NormalizedEvent): string {
  if (ev.kind === "board_mutation") return "ext:board";
  if (ev.targetAgentId?.startsWith("ext:") && ev.targetAgentId !== "ext:human") {
    return ev.targetAgentId;
  }
  const ext = classifyExternalTarget(ev.toolName);
  if (ext && ext.id !== "ext:human") return ext.id;
  const cls = classifyEventReadable(ev);
  if (cls.category === "board") return "ext:board";
  if (cls.category === "edit" || cls.category === "read") return "ext:fs";
  if (cls.category === "command") return "ext:shell";
  return "ext:tool";
}

function buildToolCategoryGroups(events: NormalizedEvent[]): ToolCategoryGroup[] {
  const byExt = new Map<string, NormalizedEvent[]>();
  for (const ev of events) {
    const extId = resolveToolExtId(ev);
    let list = byExt.get(extId);
    if (!list) {
      list = [];
      byExt.set(extId, list);
    }
    list.push(ev);
  }
  const groups: ToolCategoryGroup[] = [];
  for (const [extId, list] of byExt.entries()) {
    groups.push({
      extId,
      label: formatExternalToolLabel(extId),
      count: list.length,
      events: list,
    });
  }
  return groups;
}

function resolveActorDirection(
  actorId: string,
  thread: ThreadSelection,
  rootId: string | undefined
): "inbound" | "outbound" {
  if (actorId === "ext:human") return "outbound";
  if (thread.kind === "pair") {
    const normA = normalizeEndpointId(thread.a) || thread.a;
    const normB = normalizeEndpointId(thread.b) || thread.b;
    if (normA === "ext:human" || normB === "ext:human") {
      return actorId === "ext:human" ? "outbound" : "inbound";
    }
    if (rootId && (normA === rootId || normB === rootId)) {
      return actorId === rootId ? "outbound" : "inbound";
    }
    return actorId === normA ? "outbound" : "inbound";
  }
  return actorId === rootId ? "outbound" : "inbound";
}

function shouldIncludeToolBurstForActor(
  actorId: string,
  thread: ThreadSelection,
  rootId: string | undefined,
  seenPeerComm: boolean
): boolean {
  if (thread.kind === "all") return true;
  if (thread.kind === "pair") {
    const normA = normalizeEndpointId(thread.a) || thread.a;
    const normB = normalizeEndpointId(thread.b) || thread.b;
    const setA = new Set(
      (thread.aIds && thread.aIds.length > 0 ? thread.aIds : [normA]).map(
        (id) => normalizeEndpointId(id) || id
      )
    );
    const setB = new Set(
      (thread.bIds && thread.bIds.length > 0 ? thread.bIds : [normB]).map(
        (id) => normalizeEndpointId(id) || id
      )
    );
    if (setA.has("ext:human") || setB.has("ext:human")) {
      const aiSet = setA.has("ext:human") ? setB : setA;
      return aiSet.has(actorId);
    }
    if (rootId && (setA.has(rootId) || setB.has(rootId))) {
      const subSet = setA.has(rootId) ? setB : setA;
      return subSet.has(actorId);
    }
    return seenPeerComm && (setA.has(actorId) || setB.has(actorId));
  }
  if (thread.kind === "cluster") {
    const clusterSet = new Set(thread.runId ? [thread.runId] : thread.agentIds);
    return clusterSet.has(actorId);
  }
  if (thread.kind === "agent") {
    return actorId === (normalizeEndpointId(thread.agentId) || thread.agentId);
  }
  return false;
}

function eventHasFullBody(ev: NormalizedEvent): boolean {
  if (ev.bodyTruncated) return true;
  if (typeof ev.bodyLength === "number" && ev.bodyLength > (ev.summary?.length ?? 0)) {
    return true;
  }
  const p = ev.payload;
  const body =
    (typeof p?.body === "string" && p.body.trim()) ||
    (typeof p?.message === "string" && p.message.trim()) ||
    (typeof p?.Message === "string" && p.Message.trim()) ||
    (typeof p?.prompt === "string" && p.prompt.trim()) ||
    "";
  if (body && body.length > (ev.summary?.length ?? 0) + 24) return true;
  return (ev.summary?.length ?? 0) > 150;
}

export function resolveActorAccentColor(opts: {
  actorId: string;
  rootId?: string;
  clusters?: TeamAgentCluster[];
  agent?: AgentNodeSnapshot;
  teamRoster?: TeamRosterRef[];
  definitions?: TeamDefinitionEntry[];
}): string {
  const { actorId, rootId, clusters, agent, teamRoster, definitions } = opts;
  const normId = normalizeEndpointId(actorId) || actorId;
  if (normId === "ext:human" || normId === "human") {
    return "#f59e0b";
  }
  if (normId === "root" || (rootId && normId === rootId)) {
    return "#a855f7";
  }
  if (clusters && clusters.length > 0) {
    const cluster = clusters.find(
      (c) => c.agentIds.includes(normId) || c.agentIds.includes(actorId)
    );
    if (cluster?.railColor) return cluster.railColor;
  }
  if (agent) {
    const catalog = buildTeamCatalog(teamRoster, definitions);
    const matched = matchAgentToCatalog(agent, catalog);
    if (matched) return pickRailColor(`team:${matched.key}`);
  }
  const stripped = stripRunSuffix(normId);
  const baseSlug = stripIdePrefix(normSlug(stripped));
  if (baseSlug && !isGenericTaskSlug(baseSlug) && !isOpaqueActorId(stripped)) {
    return pickRailColor(`role:${baseSlug}`);
  }
  return "#6366f1";
}

function toEpochMs(epoch: number): number {
  return epoch > 1e12 ? epoch : epoch * 1000;
}

function formatSubDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`;
  if (seconds < 60) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  return fmtDuration(seconds);
}

function extractFullMessageMarkdown(ev: NormalizedEvent): string {
  const p = ev.payload;
  const fromPayload =
    (typeof p?.body === "string" && p.body.trim()) ||
    (typeof p?.text === "string" && p.text.trim()) ||
    (typeof p?.message === "string" && p.message.trim()) ||
    (typeof p?.Message === "string" && p.Message.trim()) ||
    (typeof p?.prompt === "string" && p.prompt.trim()) ||
    "";
  if (fromPayload) return fromPayload;
  if (typeof ev.summary === "string" && ev.summary.trim()) {
    return ev.summary.trim();
  }
  return ev.kind;
}

function isPlaceholderThoughtSummary(raw: string | undefined): boolean {
  const s = cleanSummaryText(raw).toLowerCase();
  return (
    !s ||
    s === "thinking…" ||
    s === "thinking..." ||
    s === "reasoning…" ||
    s === "reasoning..." ||
    s === "thinking"
  );
}

function extractThoughtText(ev: NormalizedEvent): string | null {
  const p = ev.payload;
  const fromPayload =
    (typeof p?.body === "string" && p.body.trim()) ||
    (typeof p?.text === "string" && p.text.trim()) ||
    (typeof p?.thinking === "string" && p.thinking.trim()) ||
    (typeof p?.reasoning === "string" && p.reasoning.trim()) ||
    "";
  if (fromPayload) return fromPayload;
  if (isPlaceholderThoughtSummary(ev.summary) && ev.bodyTruncated !== true) {
    return null;
  }
  return (typeof ev.summary === "string" && ev.summary.trim()) || null;
}

function formatPayloadPreview(val: unknown): string | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return undefined;
    return trimmed.length > 1200 ? `${trimmed.slice(0, 1199)}…` : trimmed;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  if (typeof val === "object") {
    try {
      const json = JSON.stringify(val, null, 2);
      if (!json || json === "{}" || json === "[]") return undefined;
      return json.length > 1200 ? `${json.slice(0, 1199)}…` : json;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const TOOL_INTERNAL_KEYS = new Set([
  "routineEnd",
  "isError",
  "blocker",
  "durationMs",
  "durationSec",
  "toolResult",
  "resultDetails",
  "output",
  "outputPreview",
  "result",
  "response",
  "error",
  "preview",
  "bodyTruncated",
  "bodyLength",
  "permissionDecision",
]);

function extractToolInputPreview(ev: NormalizedEvent): string | undefined {
  const p = ev.payload;
  if (!p) return undefined;
  const direct =
    formatPayloadPreview(p.inputPreview) ??
    formatPayloadPreview(p.toolInput) ??
    formatPayloadPreview(p.toolArgs) ??
    formatPayloadPreview(p.args) ??
    formatPayloadPreview(p.input) ??
    formatPayloadPreview(p.arguments);
  if (direct) return direct;

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!TOOL_INTERNAL_KEYS.has(k) && v !== undefined) {
      rest[k] = v;
    }
  }
  return formatPayloadPreview(rest);
}

function extractToolOutputPreview(ev: NormalizedEvent): string | undefined {
  const p = ev.payload;
  if (!p) return undefined;
  return (
    formatPayloadPreview(p.outputPreview) ??
    formatPayloadPreview(p.toolResult) ??
    formatPayloadPreview(p.resultDetails) ??
    formatPayloadPreview(p.output) ??
    formatPayloadPreview(p.result) ??
    formatPayloadPreview(p.response) ??
    formatPayloadPreview(p.error) ??
    formatPayloadPreview(p.preview)
  );
}

function normalizeQuestionOption(raw: unknown): PendingQuestionOption | null {
  if (typeof raw === "string" && raw.trim()) {
    return { label: raw.trim() };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const label =
    typeof r.label === "string"
      ? r.label.trim()
      : typeof r.value === "string"
        ? r.value.trim()
        : "";
  if (!label) return null;
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    label,
    description: typeof r.description === "string" ? r.description : undefined,
    recommended: Boolean(r.recommended),
  };
}

function extractQuestionsFromPayload(ev: NormalizedEvent): PendingQuestionItem[] | undefined {
  const p = ev.payload;
  if (!p) return undefined;
  if (Array.isArray(p.questions) && p.questions.length > 0) {
    const items: PendingQuestionItem[] = [];
    for (const raw of p.questions) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;
      const options = Array.isArray(r.options)
        ? r.options.map(normalizeQuestionOption).filter((o): o is PendingQuestionOption => o !== null)
        : [];
      const rawType = r.type;
      const type: PendingQuestionItem["type"] =
        rawType === "multi_select" || rawType === "text" || rawType === "single_select"
          ? rawType
          : options.length > 0
            ? "single_select"
            : "text";
      const question =
        (typeof r.question === "string" && r.question.trim()) ||
        (typeof r.title === "string" && r.title.trim()) ||
        (typeof r.prompt === "string" && r.prompt.trim()) ||
        "";
      if (!question && options.length === 0) continue;
      items.push({
        id: typeof r.id === "string" ? r.id : undefined,
        header: typeof r.header === "string" ? r.header : undefined,
        question,
        type,
        options,
        allowCustomInput: typeof r.allowCustomInput === "boolean" ? r.allowCustomInput : undefined,
        defaultValue: typeof r.defaultValue === "string" ? r.defaultValue : undefined,
      });
    }
    if (items.length > 0) return items;
  }

  if (Array.isArray(p.options) && p.options.length > 0) {
    const options = p.options
      .map(normalizeQuestionOption)
      .filter((o): o is PendingQuestionOption => o !== null);
    if (options.length > 0) {
      const question =
        (typeof p.question === "string" && p.question.trim()) ||
        (typeof p.title === "string" && p.title.trim()) ||
        (typeof p.prompt === "string" && p.prompt.trim()) ||
        cleanSummaryText(ev.summary) ||
        "";
      return [
        {
          question,
          type: "single_select",
          options,
        },
      ];
    }
  }
  return undefined;
}

export interface ExtractSmsStreamOptions {
  events: NormalizedEvent[];
  agents: AgentNodeSnapshot[];
  thread: ThreadSelection;
  labelMap?: Map<string, string>;
  clusters?: TeamAgentCluster[];
  teamRoster?: TeamRosterRef[];
  definitions?: TeamDefinitionEntry[];
  showRawTools?: boolean;
}

export interface SmsStreamResult {
  entries: SmsStreamEntry[];
  hiddenBurstCount: number;
  hiddenToolCount: number;
  hiddenBackgroundAgents: string[];
}

export function extractSmsStreamWithMeta(
  opts: ExtractSmsStreamOptions,
  options?: { showRawTools?: boolean }
): SmsStreamResult {
  const { events, agents, thread, labelMap, clusters, teamRoster, definitions } = opts;
  const showRawTools = options?.showRawTools ?? opts.showRawTools ?? false;

  const aiAgents = agents.filter((a) => (a.nodeType ?? "agent") === "agent");
  const rootAgent =
    aiAgents.find((a) => a.id === "root" || !a.parentAgentId) ?? aiAgents[0];
  const rootId = rootAgent?.id;

  const parentMap = new Map<string, string | undefined>();
  const roleMap = new Map<string, string>();
  const statusMap = new Map<string, AgentStatus>();
  const agentById = new Map<string, AgentNodeSnapshot>();
  for (const a of agents) {
    parentMap.set(a.id, a.parentAgentId);
    if (a.role) roleMap.set(a.id, a.role);
    statusMap.set(a.id, a.status);
    agentById.set(a.id, a);
  }
  const accentColorCache = new Map<string, string>();
  const getAccent = (actorId: string): string => {
    const cached = accentColorCache.get(actorId);
    if (cached) return cached;
    const resolved = resolveActorAccentColor({
      actorId,
      rootId,
      clusters,
      agent: agentById.get(actorId),
      teamRoster,
      definitions,
    });
    accentColorCache.set(actorId, resolved);
    return resolved;
  };

  // Track tool calls & thoughts per agent since their previous communication bubble
  const pendingBubbleToolsByAgent = new Map<string, NormalizedEvent[]>();
  const pendingThoughtsByAgent = new Map<string, BehindThoughtStep[]>();
  const pendingToolsByAgent = new Map<string, BehindToolStep[]>();
  const seenToolCallIds = new Set<string>();
  const emittedQuestionToolCallIds = new Set<string>();
  const commSpeakers = new Set<string>();

  const entries: SmsStreamEntry[] = [];
  // Accumulate tool calls per agent within each gap between SMS messages (preserves first-seen agent order)
  const gapBurstsByAgent = new Map<string, NormalizedEvent[]>();
  let seenPeerComm = false;
  let hiddenBurstCount = 0;
  let hiddenToolCount = 0;
  const hiddenToolAgentSet = new Set<string>();

  const flushGapBursts = () => {
    if (gapBurstsByAgent.size === 0) return;
    for (const [agentId, burstEvents] of gapBurstsByAgent.entries()) {
      if (burstEvents.length === 0) continue;
      if (!showRawTools) {
        hiddenBurstCount += 1;
        hiddenToolCount += burstEvents.length;
        hiddenToolAgentSet.add(agentId);
        continue;
      }
      const first = burstEvents[0]!;
      const last = burstEvents[burstEvents.length - 1]!;
      const categories = buildToolCategoryGroups(burstEvents);
      const categorySummary = categories.map((c) => `${c.label} (${c.count})`).join(", ");
      const firstTime = fmtClock(first.ts || first.epoch);
      const lastTime = fmtClock(last.ts || last.epoch);
      const timeRange = firstTime === lastTime ? firstTime : `${firstTime}–${lastTime}`;

      entries.push({
        kind: "tool_burst",
        groupKey: `burst:${agentId}:${first.id}`,
        agentId,
        agentLabel: formatActorName(agentId, labelMap, first.agentLabel),
        events: burstEvents,
        categories,
        categorySummary,
        timeRange,
        hasError: burstEvents.some(isErrorEvent),
        dir: resolveActorDirection(agentId, thread, rootId),
        accentColor: getAccent(agentId),
      });
    }
    gapBurstsByAgent.clear();
  };

  for (let idx = 0; idx < events.length; idx++) {
    const ev = events[idx]!;
    const evEpoch = normalizeEpoch(ev, idx);

    if (ev.kind === "thinking_start") {
      const actorId = normalizeEndpointId(ev.agentId) || ev.agentId;
      if (actorId && actorId !== "ext:human") {
        const thoughtText = extractThoughtText(ev);
        if (thoughtText !== null) {
          let tList = pendingThoughtsByAgent.get(actorId);
          if (!tList) {
            tList = [];
            pendingThoughtsByAgent.set(actorId, tList);
          }
          const durSec =
            typeof ev.payload?.durationMs === "number" && Number.isFinite(ev.payload.durationMs)
              ? ev.payload.durationMs / 1000
              : typeof ev.payload?.durationSec === "number" && Number.isFinite(ev.payload.durationSec)
                ? ev.payload.durationSec
                : undefined;
          tList.push({
            kind: "thought",
            epoch: evEpoch,
            ts: ev.ts,
            timeLabel: fmtClock(ev.ts || ev.epoch),
            text: thoughtText,
            event: ev,
            ...(durSec !== undefined ? { durationLabel: formatSubDuration(durSec) } : {}),
          });
        }
      }
      continue;
    }

    const isToolStart = ev.kind === "tool_start" && !isHumanPromptToolName(ev.toolName);
    const isBoardMut = ev.kind === "board_mutation";
    const isCommTool = isCommunicationEvent(ev);

    if ((isToolStart && !isCommTool) || isBoardMut || ev.kind === "tool_end") {
      const actorId = normalizeEndpointId(ev.agentId) || ev.agentId;

      if (isToolStart && ev.toolCallId) {
        seenToolCallIds.add(ev.toolCallId);
      }

      if (actorId && actorId !== "ext:human") {
        let stepList = pendingToolsByAgent.get(actorId);
        if (!stepList) {
          stepList = [];
          pendingToolsByAgent.set(actorId, stepList);
        }

        if (isToolStart || isBoardMut) {
          const toolName = ev.toolName || (isBoardMut ? "board_mutation" : "tool");
          const status: BehindToolStep["status"] =
            ev.payload?.permissionDecision === "deny"
              ? "denied"
              : isErrorEvent(ev)
                ? "error"
                : isBoardMut
                  ? "ok"
                  : "running";
          stepList.push({
            kind: "tool",
            epoch: evEpoch,
            ts: ev.ts,
            timeLabel: fmtClock(ev.ts || ev.epoch),
            toolName,
            summary: cleanSummaryText(ev.summary) || toolName,
            status,
            inputPreview: extractToolInputPreview(ev),
            outputPreview: extractToolOutputPreview(ev),
            event: ev,
          });
        } else if (ev.kind === "tool_end") {
          const isQuestionToolEnd =
            Boolean(ev.toolCallId && emittedQuestionToolCallIds.has(ev.toolCallId)) ||
            isHumanPromptToolName(ev.toolName);

          if (!isQuestionToolEnd || isErrorEvent(ev)) {
            let matched: BehindToolStep | undefined;
            if (ev.toolCallId) {
              matched = stepList.find((s) => s.event.toolCallId === ev.toolCallId);
            }
            if (!matched && ev.toolName) {
              const targetTool = ev.toolName.toLowerCase();
              matched = stepList.find(
                (s) => s.status === "running" && s.toolName.toLowerCase() === targetTool
              );
            }
            if (!matched) {
              matched = stepList.find((s) => s.status === "running");
            }

            if (matched) {
              matched.endEvent = ev;
              matched.status =
                ev.payload?.permissionDecision === "deny"
                  ? "denied"
                  : isErrorEvent(ev)
                    ? "error"
                    : "ok";
              const explicitDurSec =
                typeof ev.payload?.durationMs === "number" && Number.isFinite(ev.payload.durationMs)
                  ? ev.payload.durationMs / 1000
                  : typeof ev.payload?.durationSec === "number" && Number.isFinite(ev.payload.durationSec)
                    ? ev.payload.durationSec
                    : undefined;
              const diffSec =
                explicitDurSec !== undefined
                  ? explicitDurSec
                  : evEpoch > 0 && matched.epoch > 0 && evEpoch >= matched.epoch
                    ? (toEpochMs(evEpoch) - toEpochMs(matched.epoch)) / 1000
                    : undefined;
              if (diffSec !== undefined && Number.isFinite(diffSec) && diffSec >= 0) {
                matched.durationSec = diffSec;
                matched.durationLabel = formatSubDuration(diffSec);
              }
              const outPrev = extractToolOutputPreview(ev);
              if (outPrev) matched.outputPreview = outPrev;
              const endSummary = cleanSummaryText(ev.summary);
              if (
                endSummary &&
                (!matched.summary || matched.summary === matched.toolName) &&
                !/^(Done|Finished):?\s/i.test(endSummary)
              ) {
                matched.summary = endSummary;
              }
            } else if (isErrorEvent(ev) || !isRoutineToolEnd(ev)) {
              const toolName = ev.toolName || "tool";
              stepList.push({
                kind: "tool",
                epoch: evEpoch,
                ts: ev.ts,
                timeLabel: fmtClock(ev.ts || ev.epoch),
                toolName,
                summary: cleanSummaryText(ev.summary) || toolName,
                status:
                  ev.payload?.permissionDecision === "deny"
                    ? "denied"
                    : isErrorEvent(ev)
                      ? "error"
                      : "ok",
                inputPreview: extractToolInputPreview(ev),
                outputPreview: extractToolOutputPreview(ev),
                event: ev,
              });
            }
          }
        }
      }

      if (ev.kind === "tool_end") {
        const hasErr = isErrorEvent(ev);
        if (!hasErr && (isRoutineToolEnd(ev) || (ev.toolCallId && seenToolCallIds.has(ev.toolCallId)))) {
          continue;
        }
      }

      if (actorId && actorId !== "ext:human") {
        let bList = pendingBubbleToolsByAgent.get(actorId);
        if (!bList) {
          bList = [];
          pendingBubbleToolsByAgent.set(actorId, bList);
        }
        bList.push(ev);

        if (shouldIncludeToolBurstForActor(actorId, thread, rootId, seenPeerComm)) {
          let agentBurst = gapBurstsByAgent.get(actorId);
          if (!agentBurst) {
            agentBurst = [];
            gapBurstsByAgent.set(actorId, agentBurst);
          }
          agentBurst.push(ev);
        }
      }
      continue;
    }

    if (!isCommTool) continue;

    if (ev.kind === "tool_start" && isHumanPromptToolName(ev.toolName) && ev.toolCallId) {
      emittedQuestionToolCallIds.add(ev.toolCallId);
    }

    const ep = resolveCommEndpoints(ev, rootId, parentMap);
    const speakerId = ep?.fromId ?? (normalizeEndpointId(ev.agentId) || ev.agentId);
    const receiverId = ep?.toId;

    if (!matchesThreadSelection(ev, thread, rootId, parentMap)) {
      if (speakerId !== "ext:human") {
        pendingBubbleToolsByAgent.delete(speakerId);
        pendingThoughtsByAgent.delete(speakerId);
        pendingToolsByAgent.delete(speakerId);
      }
      continue;
    }

    seenPeerComm = true;
    flushGapBursts();

    commSpeakers.add(speakerId);

    const isHumanAnswer = ev.kind === "user_input" && ev.payload?.isHumanAnswer === true;
    const isHumanQuestion =
      (ev.kind === "tool_start" && isHumanPromptToolName(ev.toolName)) ||
      (ev.kind === "message" && ev.payload?.blockedOnUser === true);

    const fromLabel = isHumanAnswer
      ? "You"
      : speakerId === "ext:human"
        ? "User"
        : formatActorName(speakerId, labelMap, ev.agentLabel);
    const toLabel = receiverId
      ? receiverId === "ext:human"
        ? isHumanQuestion
          ? "You"
          : "User"
        : formatActorName(receiverId, labelMap)
      : "";

    const dir = resolveActorDirection(speakerId, thread, rootId);

    const agentToolEvents = pendingBubbleToolsByAgent.get(speakerId) ?? [];
    const toolGroups = buildToolCategoryGroups(agentToolEvents);
    const tools = toolGroups.map((g) => `${g.label} · ${g.count}`);
    pendingBubbleToolsByAgent.delete(speakerId);

    let behindSteps: BehindStep[] = [];
    if (speakerId !== "ext:human") {
      const thoughts = pendingThoughtsByAgent.get(speakerId) ?? [];
      const toolSteps = pendingToolsByAgent.get(speakerId) ?? [];
      pendingThoughtsByAgent.delete(speakerId);
      pendingToolsByAgent.delete(speakerId);
      behindSteps = [...thoughts, ...toolSteps].sort((a, b) => a.epoch - b.epoch);
    }

    const thoughtCount = behindSteps.filter((s) => s.kind === "thought").length;
    const toolCount = behindSteps.filter((s) => s.kind === "tool").length;
    let durationLabel: string | undefined;
    if (behindSteps.length > 0) {
      const firstMs = toEpochMs(behindSteps[0]!.epoch);
      const msgMs = toEpochMs(evEpoch);
      const spanSec = msgMs > firstMs ? (msgMs - firstMs) / 1000 : 0;
      if (spanSec >= 0.05) {
        durationLabel = formatSubDuration(spanSec);
      } else {
        const summed = behindSteps.reduce(
          (acc, s) => acc + (s.kind === "tool" && s.durationSec ? s.durationSec : 0),
          0
        );
        if (summed >= 0.001) {
          durationLabel = formatSubDuration(summed);
        }
      }
    }

    const status = statusMap.get(speakerId);
    const mappedRole = roleMap.get(speakerId);
    const nonGenericRole =
      mappedRole && !isGenericPlaceholderRole(mappedRole) ? mappedRole : undefined;
    const baseRole =
      speakerId === "ext:human"
        ? "Session Root"
        : speakerId === rootId
          ? "Orchestrator"
          : nonGenericRole || "Subagent";
    const roleBadge = isHumanAnswer
      ? "Answered Question"
      : isHumanQuestion
        ? `${baseRole} · ASKED USER`
        : ev.kind === "subagent_spawn"
          ? `${baseRole} · DISPATCH`
          : ev.kind === "subagent_done"
            ? `${baseRole} · DONE`
            : status && speakerId !== "ext:human" && speakerId !== rootId
              ? `${baseRole} · ${status}`
              : baseRole;

    const fullMarkdownText = extractFullMessageMarkdown(ev);
    const questions = isHumanQuestion ? extractQuestionsFromPayload(ev) : undefined;

    let replyToEntryId: string | undefined;
    let replyToQuote: string | undefined;
    let replyToActorLabel: string | undefined;

    if (isHumanAnswer) {
      const qToolCallId =
        typeof ev.payload?.questionToolCallId === "string"
          ? ev.payload.questionToolCallId.trim()
          : "";
      let matchedQuestion: SmsMessageItem | undefined;

      if (qToolCallId) {
        for (let k = entries.length - 1; k >= 0; k--) {
          const candidate = entries[k]!;
          if (candidate.kind !== "message") continue;
          const candCallId =
            candidate.event.toolCallId ||
            (typeof candidate.event.payload?.toolCallId === "string"
              ? candidate.event.payload.toolCallId
              : "");
          if (candCallId === qToolCallId) {
            matchedQuestion = candidate;
            break;
          }
        }
      }

      if (!matchedQuestion) {
        for (let k = entries.length - 1; k >= 0; k--) {
          const candidate = entries[k]!;
          if (candidate.kind !== "message") continue;
          const isQ =
            (candidate.event.kind === "tool_start" &&
              isHumanPromptToolName(candidate.event.toolName)) ||
            Boolean(candidate.questions?.length);
          if (!isQ) continue;
          const candAgent =
            normalizeEndpointId(candidate.event.agentId) || candidate.event.agentId;
          if (!receiverId || candAgent === receiverId) {
            matchedQuestion = candidate;
            break;
          }
        }
      }

      if (matchedQuestion) {
        replyToEntryId = matchedQuestion.event.id;
        replyToActorLabel = matchedQuestion.fromLabel;
        const rawQuote =
          matchedQuestion.questions?.[0]?.question || matchedQuestion.fullMarkdownText;
        replyToQuote = truncateWords(cleanSummaryText(rawQuote), 100);
        matchedQuestion.chosenAnswerText = fullMarkdownText;
      }
    }

    const runId =
      speakerId !== "ext:human" && speakerId !== rootId
        ? speakerId
        : receiverId && receiverId !== "ext:human" && receiverId !== rootId
          ? receiverId
          : undefined;

    entries.push({
      kind: "message",
      event: ev,
      dir,
      fromLabel,
      roleBadge,
      routeLabel: toLabel ? `${fromLabel} → ${toLabel}` : fromLabel,
      timeLabel: fmtClock(ev.ts || ev.epoch),
      text: truncateWords(fullMarkdownText, 320),
      fullMarkdownText,
      tools,
      toolGroups,
      runId,
      hasFullBody: eventHasFullBody(ev),
      accentColor: isHumanAnswer ? "#10b981" : getAccent(speakerId),
      ...(isHumanAnswer ? { isHumanAnswer: true } : {}),
      ...(replyToEntryId ? { replyToEntryId } : {}),
      ...(replyToQuote ? { replyToQuote } : {}),
      ...(replyToActorLabel ? { replyToActorLabel } : {}),
      ...(questions ? { questions } : {}),
      behindSteps,
      behindSummary: {
        thoughtCount,
        toolCount,
        ...(durationLabel ? { durationLabel } : {}),
      },
    });
  }

  flushGapBursts();

  const hiddenBackgroundAgents = Array.from(hiddenToolAgentSet).filter(
    (aid) => !commSpeakers.has(aid)
  );

  return {
    entries,
    hiddenBurstCount,
    hiddenToolCount,
    hiddenBackgroundAgents,
  };
}

export function extractSmsStream(
  opts: ExtractSmsStreamOptions,
  options?: { showRawTools?: boolean }
): SmsStreamEntry[] {
  return extractSmsStreamWithMeta(opts, options).entries;
}

export function extractSmsMessages(
  opts: ExtractSmsStreamOptions,
  options?: { showRawTools?: boolean }
): SmsMessageItem[] {
  return extractSmsStreamWithMeta(opts, options).entries.filter(
    (entry): entry is SmsMessageItem => entry.kind === "message"
  );
}
