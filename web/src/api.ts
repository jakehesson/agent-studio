import type {
  BoardApiResponse,
  BoardData,
  BoardItem,
  CheckStatus,
  ConnectionState,
  DoctorApiResponse,
  DoctorCheckItem,
  HostIde,
  IdeFilter,
  IdeHealthCard,
  IdeModelOverride,
  IdeSource,
  MockupEntry,
  MockupsApiResponse,
  ModelCapabilityTag,
  ModelIndex,
  ModelIndexOverlay,
  ModelIndexView,
  ModelRoutingPolicy,
  ModelTier,
  RegisteredProject,
  SessionSnapshot,
  SessionsResponse,
  TeamDetailsResponse,
  TestrunRecord,
  WorkflowModelRouting,
} from "./types.js";
import { normalizeServerSnapshot } from "./state/snapshot.js";
import {
  normalizeModelIndexHealth,
  normalizeModelIndexView,
  normalizeWorkflowRouting,
  synthesizeModelIndexViewFromTeam,
} from "./state/modelIndex.js";
import { normalizeStatus } from "./utils.js";

export interface McpToolCallResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

export interface McpAppClientLike {
  callServerTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpToolCallResult>;
}

let mcpTransport: McpAppClientLike | null = null;
const MCP_MAX_CONCURRENT = 2;
let mcpInFlight = 0;
const mcpWaitQueue: Array<() => void> = [];

export function setMcpAppTransport(client: McpAppClientLike | null): void {
  mcpTransport = client;
}

export function isMcpAppTransportActive(): boolean {
  return mcpTransport !== null;
}

function cleanArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null && v !== "") {
      out[k] = v;
    }
  }
  return out;
}

async function acquireMcpSlot(): Promise<void> {
  if (mcpInFlight < MCP_MAX_CONCURRENT) {
    mcpInFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    mcpWaitQueue.push(() => {
      mcpInFlight += 1;
      resolve();
    });
  });
}

function releaseMcpSlot(): void {
  mcpInFlight = Math.max(0, mcpInFlight - 1);
  const next = mcpWaitQueue.shift();
  if (next) next();
}

function extractMcpPayload<T>(res: McpToolCallResult, toolName: string): T {
  const textBlocks = (res.content ?? [])
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text ?? "");
  const combinedText = textBlocks.join("\n").trim();

  if (res.isError) {
    throw new Error(combinedText || `MCP tool ${toolName} returned an error`);
  }
  if (res.structuredContent !== undefined && res.structuredContent !== null) {
    return res.structuredContent as T;
  }
  if (combinedText) {
    try {
      return JSON.parse(combinedText) as T;
    } catch {
      return { ok: true, message: combinedText } as unknown as T;
    }
  }
  return {} as T;
}

async function callMcpToolJson<T>(
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const client = mcpTransport;
  if (!client) {
    throw new Error(`MCP App transport is not initialized (tool: ${name})`);
  }
  await acquireMcpSlot();
  try {
    const res = await client.callServerTool({
      name,
      arguments: cleanArgs(args),
    });
    return extractMcpPayload<T>(res, name);
  } finally {
    releaseMcpSlot();
  }
}

function qs(params: Record<string, string | undefined | null | boolean>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 160)}` : ""}`);
  }
  return (await res.json()) as T;
}

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

function normalizeProjectEntry(raw: unknown): RegisteredProject | null {
  const rec = asRecord(raw);
  const id = typeof rec.id === "string" ? rec.id : "";
  if (!id) return null;
  return {
    id,
    title: typeof rec.title === "string" ? rec.title : undefined,
    name: typeof rec.name === "string" ? rec.name : undefined,
    rootPath:
      typeof rec.rootPath === "string"
        ? rec.rootPath
        : typeof rec.root === "string"
          ? rec.root
          : undefined,
    path: typeof rec.path === "string" ? rec.path : undefined,
    boardPath: typeof rec.boardPath === "string" ? rec.boardPath : undefined,
  };
}

export async function fetchSessions(opts: {
  ide?: IdeFilter;
  project?: string;
  workspace?: string;
  multiOnly?: boolean;
  limit?: number;
}): Promise<SessionsResponse> {
  const data = mcpTransport
    ? await callMcpToolJson<Record<string, unknown>>("app_get_state", {
        ide: opts.ide && opts.ide !== "all" ? opts.ide : "antigravity",
        project: opts.project,
        workspace: opts.workspace,
        multiOnly: opts.multiOnly ? true : undefined,
      })
    : await fetchJson<Record<string, unknown>>(
        `/api/sessions${qs({
          ide: opts.ide && opts.ide !== "all" ? opts.ide : "all",
          project: opts.project || undefined,
          workspace: opts.workspace || undefined,
          multiOnly: opts.multiOnly ? "true" : undefined,
          limit: String(opts.limit ?? 100),
        })}`
      );
  const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
  const sessions = rawSessions.map((s) => {
    const r = asRecord(s);
    return {
      sessionId: typeof r.sessionId === "string" ? r.sessionId : "",
      ide: (typeof r.ide === "string" ? r.ide : "unknown") as IdeSource,
      projectId: typeof r.projectId === "string" ? r.projectId : undefined,
      workspacePath: typeof r.workspacePath === "string" ? r.workspacePath : undefined,
      title: typeof r.title === "string" ? r.title : undefined,
      status: normalizeStatus(typeof r.status === "string" ? r.status : undefined),
      waitingOn: typeof r.waitingOn === "string" ? r.waitingOn : null,
      isWaiting: Boolean(r.isWaiting),
      isCompleted: Boolean(r.isCompleted),
      isMultiAgent: Boolean(r.isMultiAgent),
      agentCount: typeof r.agentCount === "number" ? r.agentCount : undefined,
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : undefined,
      mtimeMs: typeof r.mtimeMs === "number" ? r.mtimeMs : undefined,
    };
  });

  const rawProjects = Array.isArray(data.projects)
    ? data.projects
    : Array.isArray(data.board_projects)
      ? data.board_projects
      : Array.isArray(data.boardProjects)
        ? data.boardProjects
        : [];
  const projects = rawProjects
    .map(normalizeProjectEntry)
    .filter((p): p is RegisteredProject => p !== null);

  return { sessions, projects };
}

export async function fetchState(opts: {
  session?: string;
  ide?: IdeFilter;
  project?: string;
  workspace?: string;
}): Promise<SessionSnapshot> {
  const raw = mcpTransport
    ? await callMcpToolJson<unknown>("app_get_state", {
        session: opts.session,
        ide: opts.ide && opts.ide !== "all" ? opts.ide : undefined,
        project: opts.project,
        workspace: opts.workspace,
      })
    : await fetchJson<unknown>(
        `/api/state${qs({
          session: opts.session || undefined,
          ide: opts.ide && opts.ide !== "all" ? opts.ide : undefined,
          project: opts.project || undefined,
          workspace: opts.workspace || undefined,
        })}`
      );
  return normalizeServerSnapshot(raw);
}

export interface EventBodyResult {
  ok: boolean;
  sessionId?: string;
  eventId?: string;
  body?: string;
  truncated?: boolean;
  byteLength?: number;
  error?: string;
}

export async function fetchEventBody(params: {
  sessionId: string;
  eventId: string;
  ide?: string;
  project?: string;
  workspace?: string;
}): Promise<EventBodyResult> {
  try {
    const raw = isMcpAppTransportActive()
      ? await callMcpToolJson<Record<string, unknown>>("app_get_event_body", {
          session: params.sessionId,
          event: params.eventId,
          ide: params.ide && params.ide !== "all" ? params.ide : undefined,
          project: params.project,
          workspace: params.workspace,
        })
      : await fetchJson<Record<string, unknown>>(
          `/api/event-body${qs({
            session: params.sessionId,
            event: params.eventId,
            ide: params.ide && params.ide !== "all" ? params.ide : undefined,
            project: params.project || undefined,
            workspace: params.workspace || undefined,
          })}`
        );

    const ok = raw.ok !== false;
    if (!ok) {
      return {
        ok: false,
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : params.sessionId,
        eventId: typeof raw.eventId === "string" ? raw.eventId : params.eventId,
        error: typeof raw.error === "string" && raw.error ? raw.error : "Unable to load full message body",
      };
    }

    return {
      ok: true,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : params.sessionId,
      eventId: typeof raw.eventId === "string" ? raw.eventId : params.eventId,
      body: typeof raw.body === "string" ? raw.body : undefined,
      truncated: typeof raw.truncated === "boolean" ? raw.truncated : undefined,
      byteLength: typeof raw.byteLength === "number" ? raw.byteLength : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      sessionId: params.sessionId,
      eventId: params.eventId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchBoard(opts: {
  project?: string;
  workspace?: string;
  sprint?: string;
  showDone?: boolean;
}): Promise<BoardApiResponse> {
  const raw = mcpTransport
    ? await callMcpToolJson<Record<string, unknown>>("app_get_board", {
        project: opts.project,
        workspace: opts.workspace,
        sprint: opts.sprint,
        showDone: opts.showDone,
      })
    : await fetchJson<Record<string, unknown>>(
        `/api/board${qs({
          project: opts.project || undefined,
          workspace: opts.workspace || undefined,
          sprint: opts.sprint || undefined,
          showDone: opts.showDone ? "true" : undefined,
        })}`
      );

  // Backend returns project as `{ id, title, root, qaGateRequired }` or string
  const projObj = asRecord(raw.project);
  const projectId =
    typeof raw.project === "string"
      ? raw.project
      : typeof projObj.id === "string"
        ? projObj.id
        : undefined;

  const projects: RegisteredProject[] = [];
  if (Array.isArray(raw.projects)) {
    for (const p of raw.projects) {
      const norm = normalizeProjectEntry(p);
      if (norm) projects.push(norm);
    }
  } else if (projectId) {
    projects.push({
      id: projectId,
      title: typeof projObj.title === "string" ? projObj.title : projectId,
      rootPath: typeof projObj.root === "string" ? projObj.root : undefined,
    });
  }

  const rawBoard = raw.board ? asRecord(raw.board) : null;
  let board: BoardData | null = null;
  if (rawBoard) {
    const rawItems = Array.isArray(rawBoard.items) ? (rawBoard.items as BoardItem[]) : [];
    const rawTestrunsFromBoard = Array.isArray(rawBoard.testruns)
      ? (rawBoard.testruns as TestrunRecord[])
      : [];
    const runsContainer = asRecord(raw.testruns);
    const rawTestrunsFromApi = Array.isArray(raw.testruns)
      ? (raw.testruns as TestrunRecord[])
      : Array.isArray(runsContainer.testruns)
        ? (runsContainer.testruns as TestrunRecord[])
        : [];
    const testruns =
      rawTestrunsFromBoard.length > 0 ? rawTestrunsFromBoard : rawTestrunsFromApi;

    board = {
      project:
        typeof rawBoard.project === "string" ? rawBoard.project : projectId,
      milestone: rawBoard.milestone
        ? (rawBoard.milestone as BoardData["milestone"])
        : undefined,
      active_sprint:
        typeof rawBoard.active_sprint === "string" ? rawBoard.active_sprint : null,
      sprints: rawBoard.sprints
        ? (rawBoard.sprints as BoardData["sprints"])
        : undefined,
      suites: rawBoard.suites
        ? (rawBoard.suites as BoardData["suites"])
        : undefined,
      items: rawItems,
      testruns,
    };
  }

  const statusRec = asRecord(raw.status);
  const counts =
    raw.counts && typeof raw.counts === "object"
      ? (raw.counts as Record<string, number>)
      : statusRec.counts && typeof statusRec.counts === "object"
        ? (statusRec.counts as Record<string, number>)
        : undefined;

  const openBugsFromApi = Array.isArray(raw.openBugs)
    ? (raw.openBugs as BoardItem[])
    : Array.isArray(statusRec.open_bugs)
      ? (statusRec.open_bugs as BoardItem[])
      : board
        ? board.items.filter((it) => it.type === "bug" && it.state !== "done")
        : [];

  const gateRec = asRecord(raw.gate);
  const qaGate =
    raw.qaGate && typeof raw.qaGate === "object"
      ? (raw.qaGate as BoardApiResponse["qaGate"])
      : {
          required:
            typeof projObj.qaGateRequired === "boolean"
              ? projObj.qaGateRequired
              : true,
          passedCount:
            typeof gateRec.passed === "number" ? gateRec.passed : undefined,
          blockedItems: Array.isArray(gateRec.blocked)
            ? (gateRec.blocked as string[])
            : undefined,
        };

  return {
    ok: raw.ok !== false,
    project: projectId,
    projects,
    board,
    counts,
    openBugs: openBugsFromApi,
    qaGate,
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

function normalizeMockupEntry(raw: unknown): MockupEntry | null {
  const r = asRecord(raw);
  const id = typeof r.id === "string" ? r.id : "";
  if (!id) return null;

  const relPath =
    typeof r.relPath === "string"
      ? r.relPath
      : typeof r.rel_path === "string"
        ? r.rel_path
        : "";
  const fileName =
    typeof r.fileName === "string"
      ? r.fileName
      : relPath.split("/").pop() || id;
  const title =
    typeof r.title === "string"
      ? r.title
      : typeof r.name === "string"
        ? r.name
        : fileName;
  const projectId =
    typeof r.projectId === "string"
      ? r.projectId
      : typeof r.project === "string"
        ? r.project
        : undefined;
  const mtimeMs =
    typeof r.mtimeMs === "number"
      ? r.mtimeMs
      : typeof r.mtime === "number"
        ? r.mtime > 1e12
          ? r.mtime
          : Math.round(r.mtime * 1000)
        : undefined;

  return {
    id,
    title,
    projectId,
    fileName,
    relPath: relPath || undefined,
    mtimeMs,
    url: typeof r.url === "string" ? r.url : undefined,
    feedback: typeof r.feedback === "string" ? r.feedback : undefined,
  };
}

export async function fetchMockups(
  project?: string,
  selectedId?: string,
  workspace?: string
): Promise<MockupsApiResponse> {
  const data = await fetchJson<Record<string, unknown>>(
    `/api/mockups${qs({
      project: project || undefined,
      id: selectedId || undefined,
      workspace: workspace || undefined,
    })}`
  );

  const selectedRec = data.selected ? normalizeMockupEntry(data.selected) : null;
  const rawList = Array.isArray(data.mockups) ? data.mockups : [];
  const mockups = rawList
    .map(normalizeMockupEntry)
    .filter((m): m is MockupEntry => m !== null)
    .map((m) =>
      selectedRec && m.id === selectedRec.id && selectedRec.feedback !== undefined
        ? { ...m, feedback: selectedRec.feedback }
        : m
    );

  const rawProjects = Array.isArray(data.projects) ? data.projects : [];
  const projects = rawProjects
    .map(normalizeProjectEntry)
    .filter((p): p is RegisteredProject => p !== null);

  return { mockups, projects };
}

export async function postMockupFeedback(payload: {
  id: string;
  note: string;
  view?: string;
}): Promise<{ ok: boolean; feedback?: string }> {
  return fetchJson<{ ok: boolean; feedback?: string }>("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const KNOWN_IDES: Array<{ id: IdeSource; name: string }> = [
  { id: "antigravity", name: "Antigravity" },
  { id: "claude-code", name: "Claude Code" },
  { id: "copilot-vscode", name: "GitHub Copilot / VS Code" },
];

function mapTelemetryAdapterStatus(rawStatus: unknown): CheckStatus {
  if (rawStatus === "ok" || rawStatus === "pass") return "pass";
  if (rawStatus === "degraded" || rawStatus === "warn") return "warn";
  if (rawStatus === "unavailable" || rawStatus === "fail") return "fail";
  return "unknown";
}

export async function fetchTeam(opts: {
  project?: string;
  workspace?: string;
}): Promise<TeamDetailsResponse> {
  const raw = mcpTransport
    ? await callMcpToolJson<Record<string, unknown>>("app_get_team", {
        project: opts.project,
        workspace: opts.workspace,
      })
    : await fetchJson<Record<string, unknown>>(
        `/api/team${qs({
          project: opts.project || undefined,
          workspace: opts.workspace || undefined,
        })}`
      );
  const proj = asRecord(raw.project);
  const wf = asRecord(raw.workflow);
  const enf = asRecord(wf.enforcement);

  return {
    project: {
      id: typeof proj.id === "string" ? proj.id : opts.project || "workspace",
      title:
        typeof proj.title === "string"
          ? proj.title
          : typeof proj.id === "string"
            ? proj.id
            : "Agent Team",
      description: typeof proj.description === "string" ? proj.description : "",
      root: typeof proj.root === "string" ? proj.root : "",
    },
    hasManifest: Boolean(raw.hasManifest),
    targets: Array.isArray(raw.targets)
      ? raw.targets.filter((t): t is string => typeof t === "string")
      : [],
    workflow: {
      boardPath:
        typeof wf.boardPath === "string" ? wf.boardPath : "pipeline/board.json",
      stages: Array.isArray(wf.stages)
        ? wf.stages.filter((s): s is string => typeof s === "string")
        : ["ready", "design", "dev", "test", "done"],
      enforcement: {
        orchestratorReadOnly: enf.orchestratorReadOnly !== false,
        qaGateRequired: enf.qaGateRequired !== false,
        blockDirectBoardEdits: enf.blockDirectBoardEdits !== false,
      },
      suites:
        wf.suites && typeof wf.suites === "object"
          ? (wf.suites as Record<string, string[]>)
          : {},
      checkpoints:
        wf.checkpoints && typeof wf.checkpoints === "object"
          ? (wf.checkpoints as TeamDetailsResponse["workflow"]["checkpoints"])
          : {},
    },
    roster: Array.isArray(raw.roster)
      ? (raw.roster as TeamDetailsResponse["roster"])
      : [],
    skills: Array.isArray(raw.skills)
      ? (raw.skills as TeamDetailsResponse["skills"])
      : [],
    definitions: Array.isArray(raw.definitions)
      ? (raw.definitions as TeamDetailsResponse["definitions"])
      : [],
    modelRouting:
      raw.modelRouting && typeof raw.modelRouting === "object"
        ? normalizeWorkflowRouting(raw.modelRouting)
        : undefined,
    modelIndexSummary:
      raw.modelIndexSummary && typeof raw.modelIndexSummary === "object"
        ? (raw.modelIndexSummary as TeamDetailsResponse["modelIndexSummary"])
        : undefined,
    server_time:
      typeof raw.server_time === "string"
        ? raw.server_time
        : new Date().toISOString(),
  };
}

export async function fetchModelIndex(opts: {
  project?: string;
  workspace?: string;
  ide?: HostIde | null;
} = {}): Promise<ModelIndexView> {
  if (mcpTransport) {
    const team = await fetchTeam({
      project: opts.project,
      workspace: opts.workspace,
    });
    return synthesizeModelIndexViewFromTeam(team);
  }
  const raw = await fetchJson<Record<string, unknown>>(
    `/api/model-index${qs({
      project: opts.project || undefined,
      workspace: opts.workspace || undefined,
      ide: opts.ide || undefined,
    })}`
  );
  return normalizeModelIndexView(raw);
}

export async function putModelIndex(payload: {
  scope?: "workspace" | "global";
  project?: string;
  workspace?: string;
  sync?: boolean;
  create?: boolean;
  patch: ModelIndexOverlay;
}): Promise<ModelIndexView> {
  if (mcpTransport) {
    throw new Error(
      "Model Index writes are read-only in MCP App mode. Run `agent-studio models set-tier ...` in terminal."
    );
  }
  const raw = await fetchJson<Record<string, unknown>>("/api/model-index", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return normalizeModelIndexView(raw);
}

export async function patchModelIndex(payload: {
  scope?: "workspace" | "global";
  project?: string;
  workspace?: string;
  sync?: boolean;
  create?: boolean;
  patch: ModelIndexOverlay;
}): Promise<ModelIndexView> {
  if (mcpTransport) {
    throw new Error(
      "Model Index writes are read-only in MCP App mode. Run `agent-studio models upsert ...` in terminal."
    );
  }
  const raw = await fetchJson<Record<string, unknown>>("/api/model-index", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return normalizeModelIndexView(raw);
}

export async function discoverModelIndex(payload: {
  ide: HostIde;
  source?: "vscode-lm" | "manual";
  scope?: "global" | "workspace";
  project?: string;
  workspace?: string;
  models: Array<{
    id: string;
    label?: string;
    vendor?: string;
    family?: string;
    maxInputTokens?: number;
    tierHint?: ModelTier;
    capabilities?: ModelCapabilityTag[];
  }>;
}): Promise<{
  ok: boolean;
  count: number;
  added: number;
  updated: number;
  effective?: ModelIndex;
}> {
  if (mcpTransport) {
    throw new Error(
      "Model discovery requires HTTP Studio or CLI (`agent-studio models discover`)."
    );
  }
  return fetchJson("/api/model-index/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function patchTeamRouting(payload: {
  project?: string;
  workspace?: string;
  sync?: boolean;
  workflow?: Partial<WorkflowModelRouting>;
  role?: {
    id: string;
    modelTier?: ModelTier | null;
    modelPolicy?: ModelRoutingPolicy | null;
    models?: Partial<Record<HostIde, IdeModelOverride | null>>;
  };
}): Promise<{
  ok: boolean;
  routing?: ModelIndexView["routing"];
  compileResult?: unknown;
}> {
  if (mcpTransport) {
    throw new Error(
      "Routing updates are read-only in MCP App mode. Run `agent-studio models set-policy` or `set-role`."
    );
  }
  return fetchJson("/api/team/routing", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function fetchDoctor(
  project?: string,
  workspace?: string
): Promise<DoctorApiResponse> {
  const raw = mcpTransport
    ? await callMcpToolJson<Record<string, unknown>>("app_get_doctor", {
        project,
        workspace,
      })
    : await fetchJson<Record<string, unknown>>(
        `/api/doctor${qs({
          project: project || undefined,
          workspace: workspace || undefined,
        })}`
      );

  // If server already returns canonical DoctorApiResponse with ides[] array, preserve it
  if (Array.isArray(raw.ides) && !raw.doctor) {
    const out = raw as unknown as DoctorApiResponse;
    const mi = normalizeModelIndexHealth(raw.modelIndex);
    return mi ? { ...out, modelIndex: mi } : out;
  }

  const doc = asRecord(raw.doctor);
  const hasDoc = Object.keys(doc).length > 0;

  // Live passive adapter health array from `aggregator.getAdaptersHealth()`
  const liveAdapterMap = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw.adapters)) {
    for (const a of raw.adapters) {
      const rec = asRecord(a);
      if (typeof rec.ide === "string") liveAdapterMap.set(rec.ide, rec);
    }
  }

  const docIdes = asRecord(doc.ides);
  const docAdapters = asRecord(doc.adapters);
  const docDrift = asRecord(doc.drift);
  const rawDriftEntries = Array.isArray(docDrift.entries) ? docDrift.entries : [];
  const docMcp = asRecord(doc.mcpStatus);
  const docMcpConfigs = asRecord(docMcp.configs);
  const docHooks = asRecord(doc.hooksStatus);
  const docHookConfigs = asRecord(docHooks.configs);
  const docNode = asRecord(doc.nodeVersion);

  const driftFiles = rawDriftEntries.map((entry) => {
    const e = asRecord(entry);
    return {
      file:
        typeof e.path === "string"
          ? e.path
          : typeof e.file === "string"
            ? e.file
            : "unknown",
      status: typeof e.status === "string" ? e.status : "drifted",
      ide: typeof e.ide === "string" ? e.ide : undefined,
      reason: typeof e.reason === "string" ? e.reason : undefined,
    };
  });

  const ides: IdeHealthCard[] = KNOWN_IDES.map(({ id, name }) => {
    const presence = asRecord(docIdes[id]);
    const compAdapter = asRecord(docAdapters[id]);
    const liveAdapter = liveAdapterMap.get(id) ?? {};
    const mcpCfg = asRecord(docMcpConfigs[id]);
    const hookCfg = asRecord(docHookConfigs[id]);

    const ideDrifts = driftFiles
      .filter((d) => d.ide === id)
      .map((d) => d.file);

    const liveStatus = mapTelemetryAdapterStatus(liveAdapter.status);
    const detected =
      typeof presence.installed === "boolean"
        ? presence.installed
        : liveStatus === "pass" ||
          (typeof liveAdapter.sessionsFound === "number" &&
            liveAdapter.sessionsFound > 0);

    const enabled =
      typeof compAdapter.enabled === "boolean" ? compAdapter.enabled : undefined;

    let adapterStatus: CheckStatus = liveStatus;
    if (hasDoc && typeof compAdapter.ok === "boolean") {
      if (!compAdapter.ok) adapterStatus = "warn";
      else if (liveStatus === "fail") {
        adapterStatus = detected ? "warn" : "unknown";
      } else {
        adapterStatus = "pass";
      }
    }

    const telemetryPath =
      typeof presence.telemetryDir === "string"
        ? presence.telemetryDir
        : typeof liveAdapter.rootDir === "string"
          ? liveAdapter.rootDir
          : undefined;

    const telemetryReachable =
      typeof presence.telemetryDirExists === "boolean"
        ? presence.telemetryDirExists
        : liveStatus === "pass";

    return {
      ide: id,
      name,
      detected,
      enabled,
      adapterStatus,
      configDrift: ideDrifts,
      mcpConfigured: Boolean(mcpCfg.configured),
      hooksConfigured:
        id === "antigravity" ? false : Boolean(hookCfg.configured),
      telemetryPath,
      telemetryReachable,
      sessionCount:
        typeof liveAdapter.sessionsFound === "number"
          ? liveAdapter.sessionsFound
          : undefined,
      fileCount:
        typeof compAdapter.fileCount === "number"
          ? compAdapter.fileCount
          : undefined,
      details:
        typeof liveAdapter.message === "string"
          ? liveAdapter.message
          : undefined,
    };
  });

  const checks: DoctorCheckItem[] = [];

  // Node runtime check
  const nodeCurrent =
    typeof docNode.current === "string"
      ? `v${docNode.current.replace(/^v/, "")}`
      : typeof raw.nodeVersion === "string"
        ? raw.nodeVersion
        : undefined;
  if (nodeCurrent) {
    const nodeOk = typeof docNode.ok === "boolean" ? docNode.ok : true;
    checks.push({
      id: "node-version",
      label: "Node.js Runtime",
      status: nodeOk ? "pass" : "fail",
      detail: `${nodeCurrent} (required ${typeof docNode.required === "string" ? docNode.required : ">=20.0.0"})`,
    });
  }

  // team.yaml manifest check
  const teamYamlValid =
    typeof doc.manifestValid === "boolean"
      ? doc.manifestValid
      : typeof raw.teamYamlValid === "boolean"
        ? raw.teamYamlValid
        : false;
  if (hasDoc) {
    checks.push({
      id: "team-manifest",
      label: "Canonical Manifest (.agent-team/team.yaml)",
      status: teamYamlValid ? "pass" : "warn",
      detail: teamYamlValid
        ? `Valid manifest for project ${typeof doc.projectId === "string" ? doc.projectId : "(workspace)"}`
        : typeof doc.manifestError === "string"
          ? doc.manifestError
          : "Manifest not initialized yet",
      fixHint: teamYamlValid ? undefined : "agent-studio init",
    });

    // Drift summary check
    const driftOk = docDrift.ok === true;
    const checkedCount =
      typeof docDrift.checkedCount === "number" ? docDrift.checkedCount : 0;
    checks.push({
      id: "adapter-drift",
      label: "Compiled IDE Adapter Drift",
      status: driftOk ? "pass" : "warn",
      detail: driftOk
        ? `${checkedCount} generated file(s) in sync`
        : `${driftFiles.length} file(s) drifted from .agent-team/`,
      fixHint: driftOk ? undefined : "agent-studio sync",
    });

    // MCP config check
    const mcpOk = docMcp.ok === true;
    checks.push({
      id: "mcp-wiring",
      label: "MCP Server Configuration",
      status: mcpOk ? "pass" : "warn",
      detail: mcpOk
        ? "agent-studio MCP configured for all enabled IDE targets"
        : "One or more enabled IDEs are missing agent-studio MCP entries",
      fixHint: mcpOk ? undefined : "agent-studio sync",
    });

    // IDE Hooks check
    const hooksOk = docHooks.ok === true;
    checks.push({
      id: "ide-hooks",
      label: "Telemetry & Guardrail Hooks",
      status: hooksOk ? "pass" : "warn",
      detail: hooksOk
        ? "Claude Code & VS Code hooks registered"
        : "Missing hook events for one or more enabled IDEs",
      fixHint: hooksOk ? undefined : "agent-studio sync",
    });
  }

  // Passive telemetry adapter checks
  for (const [ideId, adapter] of liveAdapterMap.entries()) {
    const st = mapTelemetryAdapterStatus(adapter.status);
    const count = typeof adapter.sessionsFound === "number" ? adapter.sessionsFound : 0;
    const rootDir = typeof adapter.rootDir === "string" ? adapter.rootDir : "";
    checks.push({
      id: `telemetry-${ideId}`,
      label: `Passive Adapter (${ideId})`,
      status: st,
      detail:
        typeof adapter.message === "string" && adapter.message
          ? `${adapter.message} (${count} sessions)`
          : `${count} session(s) discovered in ${rootDir || "default path"}`,
    });
  }

  return {
    ok: hasDoc ? Boolean(doc.ok) : Boolean(raw.ok),
    project:
      typeof doc.projectId === "string"
        ? doc.projectId
        : typeof raw.project === "string"
          ? raw.project
          : project,
    nodeVersion: nodeCurrent,
    teamYamlValid,
    ides,
    checks,
    guardrails: {
      orchestratorReadOnly: teamYamlValid,
      qaGateRequired: true,
      blockDirectBoardEdits: hasDoc ? docHooks.ok === true : true,
    },
    driftFiles,
    modelIndex: normalizeModelIndexHealth(doc.modelIndex ?? raw.modelIndex),
    timestamp:
      typeof raw.timestamp === "string"
        ? raw.timestamp
        : new Date().toISOString(),
  };
}

export async function postDoctorTestEvent(payload: {
  project?: string;
  ide?: IdeSource;
  summary?: string;
}): Promise<{
  ok: boolean;
  accepted?: number;
  deduped?: number;
  eventId?: string;
  message?: string;
}> {
  const raw = mcpTransport
    ? await callMcpToolJson<Record<string, unknown>>("app_send_test_event", {
        ide: payload.ide ?? "antigravity",
        project: payload.project,
        summary: payload.summary ?? "Doctor live telemetry test event",
      })
    : await fetchJson<Record<string, unknown>>("/api/doctor/test-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
  const ev = asRecord(raw.event);
  const eventId =
    typeof ev.id === "string"
      ? ev.id
      : typeof raw.eventId === "string"
        ? raw.eventId
        : undefined;
  return {
    ok: raw.ok !== false,
    accepted: typeof raw.accepted === "number" ? raw.accepted : undefined,
    deduped: typeof raw.deduped === "number" ? raw.deduped : undefined,
    eventId,
    message: typeof raw.message === "string" ? raw.message : undefined,
  };
}

export interface StreamOptions {
  session?: string;
  ide?: IdeFilter;
  project?: string;
  workspace?: string;
  onState: (snapshot: SessionSnapshot) => void;
  onStatus: (state: ConnectionState) => void;
}

export class StudioStreamClient {
  private es: EventSource | null = null;
  private retryTimer: number | null = null;
  private pollTimer: number | null = null;
  private pollInFlight = false;
  private retryDelayMs = 1000;
  private closed = false;
  private opts: StreamOptions;
  private onVisibilityChange: () => void;

  constructor(opts: StreamOptions) {
    this.opts = opts;
    this.onVisibilityChange = () => {
      if (!this.closed && isMcpAppTransportActive() && !document.hidden) {
        void this.pollMcpOnce();
      }
    };
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  public connect(): void {
    this.closed = false;
    this.openTransport();
  }

  public updateParams(params: {
    session?: string;
    ide?: IdeFilter;
    project?: string;
    workspace?: string;
  }): void {
    this.opts.session = params.session;
    this.opts.ide = params.ide;
    this.opts.project = params.project;
    this.opts.workspace = params.workspace;
    this.reconnectNow();
  }

  public reconnectNow(): void {
    this.clearTimers();
    this.es?.close();
    this.es = null;
    this.retryDelayMs = 1000;
    if (!this.closed) {
      this.openTransport();
    }
  }

  public dispose(): void {
    this.closed = true;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.clearTimers();
    this.es?.close();
    this.es = null;
  }

  private clearTimers(): void {
    if (this.retryTimer != null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pollTimer != null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private openTransport(): void {
    if (this.closed) return;
    if (isMcpAppTransportActive()) {
      this.startMcpPolling();
    } else {
      this.openSocket();
    }
  }

  private startMcpPolling(): void {
    this.clearTimers();
    this.opts.onStatus("connecting");
    void this.pollMcpOnce();
    this.pollTimer = window.setInterval(() => {
      if (this.closed || document.hidden || this.pollInFlight) return;
      void this.pollMcpOnce();
    }, 2500);
  }

  private async pollMcpOnce(): Promise<void> {
    if (this.closed || this.pollInFlight || !isMcpAppTransportActive()) return;
    this.pollInFlight = true;
    try {
      const snapshot = await fetchState({
        session: this.opts.session,
        ide: this.opts.ide,
        project: this.opts.project,
        workspace: this.opts.workspace,
      });
      if (!this.closed) {
        this.opts.onStatus("live");
        this.opts.onState(snapshot);
      }
    } catch {
      if (!this.closed) {
        this.opts.onStatus("reconnecting");
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private openSocket(): void {
    if (this.closed) return;
    this.opts.onStatus("connecting");

    const url = `/api/stream${qs({
      session: this.opts.session || undefined,
      ide: this.opts.ide && this.opts.ide !== "all" ? this.opts.ide : undefined,
      project: this.opts.project || undefined,
      workspace: this.opts.workspace || undefined,
    })}`;

    const es = new EventSource(url);
    this.es = es;

    const handlePayload = (rawData: string): void => {
      try {
        const parsed = JSON.parse(rawData) as unknown;
        const snapshot = normalizeServerSnapshot(parsed);
        this.retryDelayMs = 1000;
        this.opts.onStatus("live");
        this.opts.onState(snapshot);
      } catch {
        // Ignore malformed keepalive or partial frames
      }
    };

    es.onopen = () => {
      this.retryDelayMs = 1000;
      this.opts.onStatus("live");
    };

    es.addEventListener("state", (ev) => {
      if (ev instanceof MessageEvent && typeof ev.data === "string") {
        handlePayload(ev.data);
      }
    });

    es.onmessage = (ev) => {
      if (typeof ev.data === "string" && ev.data.trim().startsWith("{")) {
        handlePayload(ev.data);
      }
    };

    es.onerror = () => {
      es.close();
      if (this.es === es) this.es = null;
      if (this.closed) return;
      this.opts.onStatus("reconnecting");
      this.clearTimers();
      this.retryTimer = window.setTimeout(() => {
        this.retryDelayMs = Math.min(10000, Math.round(this.retryDelayMs * 1.6));
        this.openSocket();
      }, this.retryDelayMs);
    };
  }
}
