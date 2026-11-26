import fsSync from "node:fs";
import fs from "node:fs/promises";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  boardGate,
  boardStatus,
  listProjects,
  readBoard,
  resolveProject,
  testrunList,
} from "../board/index.js";
import {
  compileTeam,
  loadTeamManifest,
  type CompileResult,
} from "../compiler/index.js";
import {
  applyDiscoveredModels,
  buildWorkflowRoutingSummary,
  doesGlobalDifferFromWorkspace,
  getGlobalModelIndexPath,
  getTeamYamlPath,
  getWorkspaceModelIndexPath,
  inspectModelIndexLayerSync,
  mergeModelIndexLayers,
  mergeOverlayPatch,
  resolveEffectiveModelIndex,
  resolveRoleModel,
  updateModelIndexOverlay,
  withTeamYamlLock,
  type ResolvedRoleModel,
} from "../models/index.js";
import {
  ModelCapabilityTagSchema,
  ModelIndexOverlaySchema,
  ModelRoutingPolicySchema,
  ModelTierSchema,
  type ModelIndex,
} from "../schema/model-index.js";
import {
  IdeModelOverrideSchema,
  IdeTargetSchema,
  type IdeTarget,
  type TeamManifest,
} from "../schema/team.js";
import {
  TelemetryAggregator,
  clearTeamDetailsCache,
  computeDeterministicEventId,
  discoverTeamDetailsCached,
  toIsoUtc,
  type EnrichedEvent,
  type IdeSource,
  type TelemetryAggregatorOptions,
} from "../telemetry/index.js";
import {
  appendMockupFeedback,
  discoverMockups,
  resolveMockupAsset,
  scanMockupEntries,
  type MockupEntry,
} from "./mockups.js";
import {
  FEEDBACK_BODY_MAX_BYTES,
  resolveFeedbackStatus,
  submitFeedbackGithubIssue,
  type FeedbackServerDeps,
} from "./feedback.js";

const MAX_INGEST_BODY_BYTES = 512 * 1024;
const MAX_MODEL_BODY_BYTES = 512 * 1024;
const SSE_DEBOUNCE_MS = 150;
const SSE_HEARTBEAT_MS = 1500;

const ALL_IDES: IdeTarget[] = ["antigravity", "claude-code", "copilot-vscode"];

const ModelIndexMutationSchema = z.object({
  scope: z.enum(["workspace", "global"]).default("workspace"),
  project: z.string().optional(),
  workspace: z.string().optional(),
  ide: IdeTargetSchema.optional(),
  sync: z.boolean().default(true),
  create: z.boolean().default(false),
  patch: ModelIndexOverlaySchema,
});

const DiscoverModelsPayloadSchema = z.object({
  ide: IdeTargetSchema,
  source: z.enum(["vscode-lm", "manual"]).default("vscode-lm"),
  scope: z.enum(["workspace", "global"]).default("global"),
  project: z.string().optional(),
  workspace: z.string().optional(),
  create: z.boolean().default(false),
  models: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().optional(),
      vendor: z.string().optional(),
      family: z.string().optional(),
      version: z.string().optional(),
      maxInputTokens: z.number().int().positive().optional(),
      tierHint: ModelTierSchema.optional(),
      capabilities: z.array(ModelCapabilityTagSchema).optional(),
      premiumMultiplier: z.number().nonnegative().optional(),
      notes: z.string().optional(),
    }),
  ),
});

const PatchTeamRoutingSchema = z.object({
  project: z.string().optional(),
  workspace: z.string().optional(),
  ide: IdeTargetSchema.optional(),
  sync: z.boolean().default(true),
  workflow: z
    .object({
      policy: ModelRoutingPolicySchema.optional(),
      respectBuiltInOrchestrators: z.boolean().optional(),
      allowSubagentModelHints: z.boolean().optional(),
      copilotHandoffModels: z.boolean().optional(),
      idePolicies: z
        .object({
          antigravity: ModelRoutingPolicySchema.nullable().optional(),
          "claude-code": ModelRoutingPolicySchema.nullable().optional(),
          "copilot-vscode": ModelRoutingPolicySchema.nullable().optional(),
        })
        .optional(),
    })
    .optional(),
  role: z
    .object({
      id: z.string().min(1),
      modelTier: ModelTierSchema.nullable().optional(),
      modelPolicy: ModelRoutingPolicySchema.nullable().optional(),
      models: z
        .record(IdeTargetSchema, IdeModelOverrideSchema.nullable())
        .nullable()
        .optional(),
    })
    .optional(),
});

const QUIET_SOCKET_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ERR_STREAM_DESTROYED",
]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const FALLBACK_STUDIO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Agent Studio</title>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0b1020; color: #e2e8f0; display: grid; place-items: center; min-height: 100dvh; }
  main { max-width: 560px; padding: 24px; border: 1px solid #1e293b; border-radius: 12px; background: #111827; }
  h1 { margin: 0 0 8px; font-size: 1.25rem; color: #c084fc; }
  p { margin: 0 0 12px; line-height: 1.5; color: #94a3b8; }
  code { background: #1e293b; padding: 2px 6px; border-radius: 4px; color: #38bdf8; }
</style>
</head>
<body>
  <main>
    <h1>Agent Studio API Server Online</h1>
    <p>Unified single-port telemetry, Agile Board, Mockups, and Doctor endpoints are active.</p>
    <p>Static web assets (<code>dist/web/index.html</code>) are not built yet; REST &amp; SSE APIs are ready at <code>/api/sessions</code>, <code>/api/state</code>, <code>/api/stream</code>, <code>/api/board</code>, <code>/api/mockups</code>, and <code>/api/doctor</code>.</p>
  </main>
</body>
</html>
`;

export type DoctorProvider = (projectRoot?: string) => Promise<unknown>;

export interface StudioServerOptions extends TelemetryAggregatorOptions {
  host?: string;
  port?: number;
  webDir?: string;
  extraMockupDirs?: string[];
  doctorProvider?: DoctorProvider;
  aggregator?: TelemetryAggregator;
  feedbackDeps?: FeedbackServerDeps;
}

export interface StudioServerHandle {
  server: Server;
  aggregator: TelemetryAggregator;
  listen: (port?: number, host?: string) => Promise<{ host: string; port: number }>;
  close: () => Promise<void>;
}

interface SseClient {
  res: ServerResponse;
  sessionId?: string;
  ide?: string;
  project?: string;
  workspace?: string;
  multiOnly?: boolean;
  lastPayloadHash: string;
  inFlight?: boolean;
}

function isQuietSocketErr(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && QUIET_SOCKET_CODES.has(code);
}

function safeWrite(res: ServerResponse, chunk: string | Buffer): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(chunk);
    return true;
  } catch (err) {
    if (!isQuietSocketErr(err)) {
      process.stderr.write(`[agent-studio serve] write error: ${String(err)}\n`);
    }
    return false;
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBytes(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer | string,
  extraHeaders?: Record<string, string>,
): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_INGEST_BODY_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer | string) => {
      if (tooLarge) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += buf.length;
      if (total > maxBytes) {
        tooLarge = true;
        reject(new Error("PAYLOAD_TOO_LARGE"));
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });

    req.on("error", (err) => reject(err));
  });
}

function defaultWebDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, "..", "web");
}

function parseBoolParam(val: string | null): boolean {
  if (!val) return false;
  const low = val.trim().toLowerCase();
  return low === "1" || low === "true" || low === "yes";
}

function resolveModelProjectContext(
  projectParam: string | undefined,
  workspaceParam: string | undefined,
  extraWorkspaces?: string[],
): { projectId: string | null; projectRoot: string } {
  if (workspaceParam && workspaceParam.trim()) {
    const abs = path.resolve(workspaceParam.trim());
    let projectId: string | null = null;
    try {
      projectId = loadTeamManifest(abs).project.id;
    } catch {
      projectId = null;
    }
    return { projectId, projectRoot: abs };
  }

  if (projectParam && projectParam.trim() && projectParam.trim().toLowerCase() !== "all") {
    const trimmed = projectParam.trim();
    try {
      const resolved = resolveProject(trimmed);
      return { projectId: resolved.id, projectRoot: resolved.root };
    } catch {
      const asDir = path.resolve(trimmed);
      if (fsSync.existsSync(asDir) && fsSync.statSync(asDir).isDirectory()) {
        return { projectId: path.basename(asDir), projectRoot: asDir };
      }
      throw new Error(`Project not found: ${trimmed}`);
    }
  }

  try {
    const resolved = resolveProject(undefined);
    return { projectId: resolved.id, projectRoot: resolved.root };
  } catch {
    const fallbackRoot = extraWorkspaces?.[0]
      ? path.resolve(extraWorkspaces[0])
      : process.cwd();
    return { projectId: null, projectRoot: fallbackRoot };
  }
}

function buildModelIndexSnapshot(
  projectId: string | null,
  projectRoot: string,
  ideFilter?: IdeTarget,
): {
  ok: true;
  projectId: string | null;
  projectRoot: string;
  effective: Omit<ModelIndex, "ides"> & {
    ides: Partial<ModelIndex["ides"]>;
  };
  layers: {
    globalPath: string;
    globalExists: boolean;
    globalUpdatedAt: string | null;
    workspacePath: string;
    workspaceExists: boolean;
    workspaceUpdatedAt: string | null;
    globalDiffersFromWorkspace: boolean;
  };
  routing: ReturnType<typeof buildWorkflowRoutingSummary> & {
    resolvedRoles: Array<{
      id: string;
      name: string;
      roleType: string;
      modelTier: string | null;
      modelPolicy: string | null;
      models: TeamManifest["roster"][number]["models"] | null;
      resolved: Partial<Record<IdeTarget, ResolvedRoleModel>>;
    }>;
  };
} {
  const globalPath = getGlobalModelIndexPath();
  const workspacePath = getWorkspaceModelIndexPath(projectRoot);
  const globalInspect = inspectModelIndexLayerSync(globalPath);
  const wsInspect = inspectModelIndexLayerSync(workspacePath);
  const globalOverlay = globalInspect.valid ? globalInspect.data : null;
  const wsOverlay = wsInspect.valid ? wsInspect.data : null;

  const fullEffective = mergeModelIndexLayers(globalOverlay, wsOverlay);
  const targetIdes = ideFilter ? [ideFilter] : ALL_IDES;

  let manifest: TeamManifest | null = null;
  try {
    manifest = loadTeamManifest(projectRoot);
  } catch {
    manifest = null;
  }

  const resolvedRoles = (manifest?.roster ?? []).map((role) => {
    const perIde: Partial<Record<IdeTarget, ResolvedRoleModel>> = {};
    for (const ide of targetIdes) {
      perIde[ide] = resolveRoleModel(manifest!, role, ide, fullEffective);
    }
    return {
      id: role.id,
      name: role.name,
      roleType: role.roleType,
      modelTier: role.modelTier ?? null,
      modelPolicy: role.modelPolicy ?? null,
      models: role.models ?? null,
      resolved: perIde,
    };
  });

  const filteredIdes: Partial<ModelIndex["ides"]> = ideFilter
    ? { [ideFilter]: fullEffective.ides[ideFilter] }
    : { ...fullEffective.ides };

  const summary = buildWorkflowRoutingSummary(manifest);
  const effectiveProjectId = manifest?.project.id ?? projectId;

  return {
    ok: true,
    projectId: effectiveProjectId,
    projectRoot: projectRoot.replace(/\\/g, "/"),
    effective: {
      ...fullEffective,
      ides: filteredIdes,
    },
    layers: {
      globalPath: globalPath.replace(/\\/g, "/"),
      globalExists: globalInspect.exists,
      globalUpdatedAt: globalOverlay?.updatedAt ?? null,
      workspacePath: workspacePath.replace(/\\/g, "/"),
      workspaceExists: wsInspect.exists,
      workspaceUpdatedAt: wsOverlay?.updatedAt ?? null,
      globalDiffersFromWorkspace: doesGlobalDifferFromWorkspace(
        globalOverlay,
        wsOverlay,
        ideFilter,
      ),
    },
    routing: {
      ...summary,
      resolvedRoles,
    },
  };
}

export function createStudioServer(
  options: StudioServerOptions = {},
): StudioServerHandle {
  const aggregator = options.aggregator ?? new TelemetryAggregator(options);
  const webDir = options.webDir ?? defaultWebDir();
  const extraMockupDirs = options.extraMockupDirs ?? [];
  const sseClients = new Set<SseClient>();

  let debounceTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const pushStateToClient = async (
    client: SseClient,
    force = false,
  ): Promise<void> => {
    if (client.res.writableEnded || client.res.destroyed) {
      sseClients.delete(client);
      return;
    }
    if (client.inFlight) return;
    client.inFlight = true;
    try {
      const payload = await aggregator.getSessionSnapshot(client.sessionId, {
        ide: client.ide,
        project: client.project,
        workspace: client.workspace,
        multiOnly: client.multiOnly,
      });
      const fullBody = {
        ...payload.snapshot,
        sessions: payload.sessions,
        board_projects: payload.boardProjects,
      };
      // Strip volatile server_time (and per-second ageSec / empty-session updatedAt) before hashing
      const hashableBody = {
        ...fullBody,
        server_time: undefined,
        ...(payload.snapshot.events.length === 0 ? { updatedAt: undefined } : {}),
        agents: payload.snapshot.agents.map(({ ageSec: _ageSec, ...rest }) => rest),
      };
      const payloadHash = JSON.stringify(hashableBody);
      if (!force && payloadHash === client.lastPayloadHash) {
        return;
      }
      client.lastPayloadHash = payloadHash;
      const serialized = JSON.stringify(fullBody);
      if (!safeWrite(client.res, `event: state\ndata: ${serialized}\n\n`)) {
        sseClients.delete(client);
      }
    } catch {
      // Non-fatal push error
    } finally {
      client.inFlight = false;
    }
  };

  const broadcastDebounced = (): void => {
    if (sseClients.size === 0) return;
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      for (const client of [...sseClients]) {
        void pushStateToClient(client, false);
      }
    }, SSE_DEBOUNCE_MS);
  };

  aggregator.pushBus.on("ingest", () => {
    broadcastDebounced();
  });

  const findMockupById = async (id: string): Promise<MockupEntry | null> => {
    const entries = await scanMockupEntries({
      extraMockupDirs,
      workspaceRoots: options.extraWorkspaces,
    });
    return entries.find((e) => e.id === id) ?? null;
  };

  const serveMockupAssetOrHtml = async (
    res: ServerResponse,
    mockupId: string,
    relAsset?: string,
  ): Promise<void> => {
    const entry = await findMockupById(mockupId);
    if (!entry) {
      sendBytes(res, 404, "text/plain; charset=utf-8", "Mockup Not Found");
      return;
    }
    if (relAsset) {
      const resolved = await resolveMockupAsset(entry.abs_dir, relAsset);
      if (resolved.status !== 200 || !resolved.filePath) {
        sendBytes(
          res,
          resolved.status,
          "text/plain; charset=utf-8",
          resolved.status === 403 ? "Forbidden" : "Not Found",
        );
        return;
      }
      const ext = path.extname(resolved.filePath).toLowerCase();
      const mime = MIME_TYPES[ext] ?? "application/octet-stream";
      const data = await fs.readFile(resolved.filePath);
      sendBytes(res, 200, mime, data);
      return;
    }

    try {
      const html = await fs.readFile(entry.file_path);
      sendBytes(res, 200, "text/html; charset=utf-8", html);
    } catch {
      sendBytes(res, 404, "text/plain; charset=utf-8", "Mockup Not Found");
    }
  };

  const serveStaticWeb = async (
    res: ServerResponse,
    pathname: string,
  ): Promise<void> => {
    const clean = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const resolved = await resolveMockupAsset(webDir, clean);
    if (resolved.status === 200 && resolved.filePath) {
      const ext = path.extname(resolved.filePath).toLowerCase();
      const mime = MIME_TYPES[ext] ?? "application/octet-stream";
      const data = await fs.readFile(resolved.filePath);
      sendBytes(res, 200, mime, data);
      return;
    }

    // SPA fallback to dist/web/index.html if present
    const indexPath = path.join(webDir, "index.html");
    try {
      const html = await fs.readFile(indexPath);
      sendBytes(res, 200, "text/html; charset=utf-8", html);
      return;
    } catch {
      // Fallback placeholder shell when dist/web is not yet built
      if (pathname === "/" || !pathname.includes(".")) {
        sendBytes(res, 200, "text/html; charset=utf-8", FALLBACK_STUDIO_HTML);
        return;
      }
      sendBytes(res, 404, "text/plain; charset=utf-8", "Not Found");
    }
  };

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    req.on("error", (err) => {
      if (!isQuietSocketErr(err)) {
        process.stderr.write(`[agent-studio serve] req error: ${String(err)}\n`);
      }
    });
    res.on("error", (err) => {
      if (!isQuietSocketErr(err)) {
        process.stderr.write(`[agent-studio serve] res error: ${String(err)}\n`);
      }
    });

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // 1. GET /api/sessions
    if (method === "GET" && pathname === "/api/sessions") {
      const limitParam = url.searchParams.get("limit");
      const sessions = await aggregator.discoverSessions({
        ide: url.searchParams.get("ide") ?? undefined,
        project: url.searchParams.get("project") ?? undefined,
        workspace: url.searchParams.get("workspace") ?? undefined,
        multiOnly: parseBoolParam(url.searchParams.get("multiOnly")),
        limit: limitParam ? Number.parseInt(limitParam, 10) : 100,
      });
      const projects = listProjects();
      sendJson(res, 200, { sessions, projects });
      return;
    }

    // 2. GET /api/state
    if (method === "GET" && pathname === "/api/state") {
      const payload = await aggregator.getSessionSnapshot(
        url.searchParams.get("session") ?? undefined,
        {
          ide: url.searchParams.get("ide") ?? undefined,
          project: url.searchParams.get("project") ?? undefined,
          workspace: url.searchParams.get("workspace") ?? undefined,
          multiOnly: parseBoolParam(url.searchParams.get("multiOnly")),
        },
      );
      sendJson(res, 200, {
        ...payload.snapshot,
        sessions: payload.sessions,
        board_projects: payload.boardProjects,
      });
      return;
    }

    // 2b. GET /api/event-body
    if (method === "GET" && pathname === "/api/event-body") {
      const session = url.searchParams.get("session")?.trim();
      const eventId = url.searchParams.get("event")?.trim();
      if (!session || !eventId) {
        sendJson(res, 400, {
          ok: false,
          error: "Missing session or event query parameter",
        });
        return;
      }
      const entry = await aggregator.getEventBody({
        sessionId: session,
        eventId,
        ide: url.searchParams.get("ide") ?? undefined,
        project: url.searchParams.get("project") ?? undefined,
        workspace: url.searchParams.get("workspace") ?? undefined,
      });
      if (!entry) {
        sendJson(res, 404, {
          ok: false,
          error: "Event body not found",
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        sessionId: session,
        eventId,
        body: entry.body,
        truncated: entry.truncated,
        byteLength: entry.byteLength,
      });
      return;
    }

    // 2c. GET /api/chat and GET /api/sessions/:id/chat
    const isSessionChatRoute =
      method === "GET" &&
      pathname.startsWith("/api/sessions/") &&
      pathname.endsWith("/chat");
    if ((method === "GET" && pathname === "/api/chat") || isSessionChatRoute) {
      let sessionParam = url.searchParams.get("session")?.trim();
      if (isSessionChatRoute) {
        const rawId = pathname
          .slice("/api/sessions/".length, -"/chat".length)
          .trim();
        if (
          !rawId ||
          rawId.includes("/") ||
          rawId.includes("\\") ||
          rawId.includes("..")
        ) {
          sendJson(res, 404, {
            ok: false,
            error: "Session not found",
          });
          return;
        }
        sessionParam = rawId;
      }
      if (!sessionParam) {
        sendJson(res, 400, {
          ok: false,
          error: "Missing session query parameter",
        });
        return;
      }
      const rawLimitParam = url.searchParams.get("limit");
      const parsedLimit = rawLimitParam
        ? Number.parseInt(rawLimitParam, 10)
        : 80;
      const chatRes = await aggregator.getAgentChat({
        sessionId: sessionParam,
        agentId: url.searchParams.get("agent")?.trim() || "root",
        ide: url.searchParams.get("ide") ?? undefined,
        project: url.searchParams.get("project") ?? undefined,
        workspace: url.searchParams.get("workspace") ?? undefined,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : 80,
        before: url.searchParams.get("before")?.trim() || undefined,
      });
      if (!chatRes) {
        sendJson(res, 404, {
          ok: false,
          error: "Session not found",
        });
        return;
      }
      sendJson(res, 200, chatRes);
      return;
    }

    // 3. GET /api/stream (SSE)
    if (method === "GET" && pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      safeWrite(res, ": connected\n\n");

      const client: SseClient = {
        res,
        sessionId: url.searchParams.get("session") ?? undefined,
        ide: url.searchParams.get("ide") ?? undefined,
        project: url.searchParams.get("project") ?? undefined,
        workspace: url.searchParams.get("workspace") ?? undefined,
        multiOnly: parseBoolParam(url.searchParams.get("multiOnly")),
        lastPayloadHash: "",
      };
      sseClients.add(client);

      req.on("close", () => {
        sseClients.delete(client);
      });

      await pushStateToClient(client, true);
      return;
    }

    // 4. POST /api/ingest
    if (method === "POST" && pathname === "/api/ingest") {
      let body: unknown;
      try {
        body = await readJsonBody(req, MAX_INGEST_BODY_BYTES);
      } catch (err) {
        const code = err instanceof Error ? err.message : "";
        if (code === "PAYLOAD_TOO_LARGE") {
          sendJson(res, 413, { ok: false, error: "Payload exceeds 512 KB limit" });
          return;
        }
        sendJson(res, 400, { ok: false, error: "Invalid JSON payload" });
        return;
      }

      const items = Array.isArray(body)
        ? body
        : body &&
            typeof body === "object" &&
            Array.isArray((body as { events?: unknown }).events)
          ? ((body as { events: unknown[] }).events)
          : [body];

      try {
        const result = aggregator.ingest(items);
        const advisory = aggregator.evaluateIngestAdvisory(result.events);
        sendJson(res, 202, {
          ok: true,
          accepted: result.accepted,
          deduped: result.deduped,
          ...(advisory ? { advisory } : {}),
        });
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // 5. GET /api/projects
    if (method === "GET" && pathname === "/api/projects") {
      sendJson(res, 200, { projects: listProjects() });
      return;
    }

    // 6. GET /api/board
    if (method === "GET" && pathname === "/api/board") {
      try {
        const workspaceParam = url.searchParams.get("workspace")?.trim() || undefined;
        const projectParam = url.searchParams.get("project")?.trim() || undefined;
        const ref =
          projectParam && projectParam.toLowerCase() !== "all"
            ? projectParam
            : workspaceParam;
        const project = resolveProject(ref, workspaceParam);
        const ctx = { project };
        const [board, statusRes, gateRes, runsRes] = await Promise.all([
          readBoard(project.boardPath),
          boardStatus(ctx, {
            sprint: url.searchParams.get("sprint") ?? undefined,
            showDone: parseBoolParam(url.searchParams.get("showDone")),
          }),
          boardGate(ctx),
          testrunList(ctx, { limit: 25 }),
        ]);
        sendJson(res, 200, {
          project: {
            id: project.id,
            title: project.title,
            root: project.root,
            qaGateRequired: project.qaGateRequired,
          },
          board,
          status: statusRes.data,
          gate: gateRes.data,
          testruns: runsRes.data,
        });
      } catch (err) {
        sendJson(res, 404, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // 6b. GET /api/team
    if (method === "GET" && pathname === "/api/team") {
      const projectParam = url.searchParams.get("project") ?? undefined;
      const workspaceParam = url.searchParams.get("workspace") ?? undefined;
      let resolvedRoot: string | undefined;
      if (projectParam && projectParam.toLowerCase() !== "all") {
        try {
          resolvedRoot = resolveProject(projectParam).root;
        } catch {
          resolvedRoot = undefined;
        }
      } else if (!workspaceParam) {
        try {
          resolvedRoot = resolveProject(undefined).root;
        } catch {
          resolvedRoot = process.cwd();
        }
      }
      const primaryRoot = workspaceParam || resolvedRoot || process.cwd();
      const workspaceRoots = [
        ...(workspaceParam ? [workspaceParam] : []),
        ...(resolvedRoot ? [resolvedRoot] : []),
        ...(options.extraWorkspaces ?? []),
      ];
      const details = await discoverTeamDetailsCached(
        workspaceRoots,
        primaryRoot,
        15_000,
      );
      sendJson(res, 200, details);
      return;
    }

    // 6c. GET /api/model-index
    if (method === "GET" && pathname === "/api/model-index") {
      const rawIde = url.searchParams.get("ide")?.trim();
      let ideFilter: IdeTarget | undefined;
      if (rawIde) {
        const parsedIde = IdeTargetSchema.safeParse(rawIde);
        if (!parsedIde.success) {
          sendJson(res, 400, {
            ok: false,
            error: `Invalid ide parameter "${rawIde}".`,
          });
          return;
        }
        ideFilter = parsedIde.data;
      }

      try {
        const ctx = resolveModelProjectContext(
          url.searchParams.get("project") ?? undefined,
          url.searchParams.get("workspace") ?? undefined,
          options.extraWorkspaces,
        );
        sendJson(
          res,
          200,
          buildModelIndexSnapshot(ctx.projectId, ctx.projectRoot, ideFilter),
        );
      } catch (err) {
        sendJson(res, 404, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // 6d. PUT /api/model-index & PATCH /api/model-index
    if ((method === "PUT" || method === "PATCH") && pathname === "/api/model-index") {
      let rawBody: unknown;
      try {
        rawBody = await readJsonBody(req, MAX_MODEL_BODY_BYTES);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        sendJson(res, msg === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
          ok: false,
          error:
            msg === "PAYLOAD_TOO_LARGE"
              ? "Payload exceeds 512 KB limit"
              : "Invalid JSON payload",
        });
        return;
      }

      const parsedBody = ModelIndexMutationSchema.safeParse(rawBody);
      if (!parsedBody.success) {
        sendJson(res, 400, {
          ok: false,
          error: parsedBody.error.issues.map((i) => i.message).join("; "),
        });
        return;
      }
      const input = parsedBody.data;

      let ctx: { projectId: string | null; projectRoot: string };
      try {
        ctx = resolveModelProjectContext(
          input.project ?? url.searchParams.get("project") ?? undefined,
          input.workspace ?? url.searchParams.get("workspace") ?? undefined,
          options.extraWorkspaces,
        );
      } catch (err) {
        sendJson(res, 404, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (input.scope === "workspace") {
        const agentTeamDir = path.join(ctx.projectRoot, ".agent-team");
        if (!fsSync.existsSync(agentTeamDir) && !input.create) {
          sendJson(res, 404, {
            ok: false,
            error: `Workspace has no .agent-team/ directory at ${ctx.projectRoot}`,
          });
          return;
        }
      }

      const targetPath =
        input.scope === "global"
          ? getGlobalModelIndexPath()
          : getWorkspaceModelIndexPath(ctx.projectRoot);
      const nowIso = new Date().toISOString();

      await updateModelIndexOverlay(targetPath, (current) => {
        if (method === "PUT") {
          return {
            ...input.patch,
            schemaVersion: 1,
            updatedAt: nowIso,
            updatedBy: input.patch.updatedBy ?? "api",
          };
        }
        return mergeOverlayPatch(current, input.patch, "api", nowIso);
      });

      let compileResult: CompileResult | undefined;
      if (
        input.scope === "workspace" &&
        input.sync &&
        fsSync.existsSync(getTeamYamlPath(ctx.projectRoot))
      ) {
        compileResult = compileTeam(ctx.projectRoot);
      }

      clearTeamDetailsCache();
      const snapshot = buildModelIndexSnapshot(
        ctx.projectId,
        ctx.projectRoot,
        input.ide,
      );
      sendJson(res, 200, {
        ...snapshot,
        ...(compileResult ? { compileResult } : {}),
      });
      return;
    }

    // 6e. POST /api/model-index/discover
    if (method === "POST" && pathname === "/api/model-index/discover") {
      let rawBody: unknown;
      try {
        rawBody = await readJsonBody(req, MAX_MODEL_BODY_BYTES);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        sendJson(res, msg === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
          ok: false,
          error:
            msg === "PAYLOAD_TOO_LARGE"
              ? "Payload exceeds 512 KB limit"
              : "Invalid JSON payload",
        });
        return;
      }

      const parsedBody = DiscoverModelsPayloadSchema.safeParse(rawBody);
      if (!parsedBody.success) {
        sendJson(res, 400, {
          ok: false,
          error: parsedBody.error.issues.map((i) => i.message).join("; "),
        });
        return;
      }
      const input = parsedBody.data;

      let ctx: { projectId: string | null; projectRoot: string };
      try {
        ctx = resolveModelProjectContext(
          input.project ?? url.searchParams.get("project") ?? undefined,
          input.workspace ?? url.searchParams.get("workspace") ?? undefined,
          options.extraWorkspaces,
        );
      } catch (err) {
        sendJson(res, 404, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (input.scope === "workspace") {
        const agentTeamDir = path.join(ctx.projectRoot, ".agent-team");
        if (!fsSync.existsSync(agentTeamDir) && !input.create) {
          sendJson(res, 404, {
            ok: false,
            error: `Workspace has no .agent-team/ directory at ${ctx.projectRoot}`,
          });
          return;
        }
      }

      const targetPath =
        input.scope === "global"
          ? getGlobalModelIndexPath()
          : getWorkspaceModelIndexPath(ctx.projectRoot);
      const nowIso = new Date().toISOString();

      let counts = { count: 0, added: 0, updated: 0, markedUnavailable: 0 };
      await updateModelIndexOverlay(targetPath, (current) => {
        const applied = applyDiscoveredModels(current, {
          ide: input.ide,
          models: input.models,
          source: input.source,
          updatedBy: input.source === "vscode-lm" ? "vscode-lm" : "api",
          nowIso,
        });
        counts = {
          count: applied.count,
          added: applied.added,
          updated: applied.updated,
          markedUnavailable: applied.markedUnavailable,
        };
        return applied.overlay;
      });

      clearTeamDetailsCache();
      const effective = resolveEffectiveModelIndex({
        projectRoot: ctx.projectRoot,
        useGlobal: true,
        ignoreMalformedGlobal: true,
      });

      sendJson(res, 200, {
        ok: true,
        ide: input.ide,
        scope: input.scope,
        ...counts,
        effective,
      });
      return;
    }

    // 6f. PATCH /api/team/routing
    if (method === "PATCH" && pathname === "/api/team/routing") {
      let rawBody: unknown;
      try {
        rawBody = await readJsonBody(req, MAX_MODEL_BODY_BYTES);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        sendJson(res, msg === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
          ok: false,
          error:
            msg === "PAYLOAD_TOO_LARGE"
              ? "Payload exceeds 512 KB limit"
              : "Invalid JSON payload",
        });
        return;
      }

      const parsedBody = PatchTeamRoutingSchema.safeParse(rawBody);
      if (!parsedBody.success) {
        sendJson(res, 400, {
          ok: false,
          error: parsedBody.error.issues.map((i) => i.message).join("; "),
        });
        return;
      }
      const input = parsedBody.data;

      let ctx: { projectId: string | null; projectRoot: string };
      try {
        ctx = resolveModelProjectContext(
          input.project ?? url.searchParams.get("project") ?? undefined,
          input.workspace ?? url.searchParams.get("workspace") ?? undefined,
          options.extraWorkspaces,
        );
      } catch (err) {
        sendJson(res, 404, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      const teamYamlPath = getTeamYamlPath(ctx.projectRoot);
      if (!fsSync.existsSync(teamYamlPath)) {
        sendJson(res, 404, {
          ok: false,
          error: `Missing .agent-team/team.yaml at ${ctx.projectRoot}`,
        });
        return;
      }

      try {
        await withTeamYamlLock(teamYamlPath, (manifest) => {
          if (input.workflow) {
            const mr = (manifest.workflow.modelRouting ??= {
              policy: "prefer-fallback",
              respectBuiltInOrchestrators: true,
              allowSubagentModelHints: true,
              copilotHandoffModels: false,
              selectionPriority: ["accuracy", "cost", "speed"],
            });
            const wf = input.workflow;
            if (wf.policy !== undefined) {
              mr.policy = wf.policy;
            }
            if (wf.respectBuiltInOrchestrators !== undefined) {
              mr.respectBuiltInOrchestrators = wf.respectBuiltInOrchestrators;
            }
            if (wf.allowSubagentModelHints !== undefined) {
              mr.allowSubagentModelHints = wf.allowSubagentModelHints;
            }
            if (wf.copilotHandoffModels !== undefined) {
              mr.copilotHandoffModels = wf.copilotHandoffModels;
            }
            if (wf.idePolicies) {
              mr.idePolicies ??= {};
              for (const ide of ALL_IDES) {
                const pol = wf.idePolicies[ide];
                if (pol === undefined) continue;
                if (pol === null) {
                  delete mr.idePolicies[ide];
                } else {
                  mr.idePolicies[ide] = pol;
                }
              }
              if (Object.keys(mr.idePolicies).length === 0) {
                delete mr.idePolicies;
              }
            }
          }

          if (input.role) {
            const roleEntry = manifest.roster.find(
              (r) => r.id === input.role!.id,
            );
            if (!roleEntry) {
              throw new Error(`ROLE_NOT_FOUND:${input.role.id}`);
            }
            if (input.role.modelTier !== undefined) {
              if (input.role.modelTier === null) {
                delete roleEntry.modelTier;
              } else {
                roleEntry.modelTier = input.role.modelTier;
              }
            }
            if (input.role.modelPolicy !== undefined) {
              if (input.role.modelPolicy === null) {
                delete roleEntry.modelPolicy;
              } else {
                roleEntry.modelPolicy = input.role.modelPolicy;
              }
            }
            if (input.role.models !== undefined) {
              if (input.role.models === null) {
                delete roleEntry.models;
              } else {
                roleEntry.models ??= {};
                for (const ide of ALL_IDES) {
                  const val = input.role.models[ide];
                  if (val === undefined) continue;
                  if (val === null) {
                    delete roleEntry.models[ide];
                  } else {
                    roleEntry.models[ide] = val;
                  }
                }
                if (Object.keys(roleEntry.models).length === 0) {
                  delete roleEntry.models;
                }
              }
            }
          }
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("ROLE_NOT_FOUND:")) {
          sendJson(res, 404, {
            ok: false,
            error: `Role "${msg.slice("ROLE_NOT_FOUND:".length)}" not found in team.yaml`,
          });
          return;
        }
        throw err;
      }

      const compileResult = input.sync
        ? compileTeam(ctx.projectRoot)
        : undefined;
      clearTeamDetailsCache();
      const snapshot = buildModelIndexSnapshot(
        ctx.projectId,
        ctx.projectRoot,
        input.ide,
      );
      sendJson(res, 200, {
        ok: true,
        routing: snapshot.routing,
        effective: snapshot.effective,
        layers: snapshot.layers,
        ...(compileResult ? { compileResult } : {}),
      });
      return;
    }

    // 7. GET /api/mockups
    if (method === "GET" && pathname === "/api/mockups") {
      const result = await discoverMockups({
        extraMockupDirs,
        workspaceRoots: options.extraWorkspaces,
        project: url.searchParams.get("project") ?? undefined,
        selectedId: url.searchParams.get("id") ?? undefined,
      });
      sendJson(res, 200, result);
      return;
    }

    // 8. GET /api/mockup & GET /api/mockup/*
    if (method === "GET" && pathname === "/api/mockup") {
      const id = url.searchParams.get("id") ?? "";
      const asset = url.searchParams.get("asset") ?? undefined;
      if (!id) {
        sendBytes(res, 404, "text/plain; charset=utf-8", "Mockup Not Found");
        return;
      }
      await serveMockupAssetOrHtml(res, id, asset);
      return;
    }

    if (method === "GET" && pathname.startsWith("/api/mockup/")) {
      const rest = pathname.slice("/api/mockup/".length);
      if (!rest || rest.includes("..")) {
        sendBytes(res, 403, "text/plain; charset=utf-8", "Forbidden");
        return;
      }
      const entries = await scanMockupEntries({
        extraMockupDirs,
        workspaceRoots: options.extraWorkspaces,
      });
      // Exact match on mockup id
      const exact = entries.find((e) => e.id === rest);
      if (exact) {
        await serveMockupAssetOrHtml(res, exact.id);
        return;
      }
      // Match <id>/<asset>
      const sorted = [...entries].sort((a, b) => b.id.length - a.id.length);
      for (const e of sorted) {
        if (rest.startsWith(e.id + "/")) {
          await serveMockupAssetOrHtml(res, e.id, rest.slice(e.id.length + 1));
          return;
        }
        const parentPrefix = e.id.includes("/")
          ? e.id.slice(0, e.id.lastIndexOf("/") + 1)
          : "";
        if (parentPrefix && rest.startsWith(parentPrefix)) {
          await serveMockupAssetOrHtml(
            res,
            e.id,
            rest.slice(parentPrefix.length),
          );
          return;
        }
      }
      sendBytes(res, 404, "text/plain; charset=utf-8", "Mockup Not Found");
      return;
    }

    // 9. POST /api/feedback
    if (method === "POST" && pathname === "/api/feedback") {
      let body: unknown;
      try {
        body = await readJsonBody(req, MAX_INGEST_BODY_BYTES);
      } catch {
        sendJson(res, 400, { ok: false, error: "Invalid JSON payload" });
        return;
      }
      const rec =
        body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const id = typeof rec.id === "string" ? rec.id.trim() : "";
      const note = typeof rec.note === "string" ? rec.note.trim() : "";
      const view = typeof rec.view === "string" ? rec.view : "default";
      if (!id || !note) {
        sendJson(res, 400, { ok: false, error: "id and note are required" });
        return;
      }
      const entry = await findMockupById(id);
      if (!entry) {
        sendJson(res, 404, { ok: false, error: "Mockup not found" });
        return;
      }
      const saved = await appendMockupFeedback(entry.abs_dir, { note, view });
      sendJson(res, 200, { ok: true, id, feedback: saved.feedback });
      return;
    }

    // 9b. GET /api/feedback/status
    if (method === "GET" && pathname === "/api/feedback/status") {
      const status = await resolveFeedbackStatus(options.feedbackDeps);
      sendJson(res, 200, status);
      return;
    }

    // 9c. POST /api/feedback/github-issue
    if (method === "POST" && pathname === "/api/feedback/github-issue") {
      let body: unknown;
      try {
        body = await readJsonBody(req, FEEDBACK_BODY_MAX_BYTES);
      } catch (err) {
        const code = err instanceof Error ? err.message : "";
        if (code === "PAYLOAD_TOO_LARGE") {
          sendJson(res, 413, { ok: false, error: "Payload exceeds 32 KB limit" });
          return;
        }
        sendJson(res, 400, { ok: false, error: "Invalid JSON payload" });
        return;
      }
      const result = await submitFeedbackGithubIssue(body, options.feedbackDeps);
      sendJson(res, result.status, result.body);
      return;
    }

    // 10. GET /api/doctor
    if (method === "GET" && pathname === "/api/doctor") {
      const workspaceParam = url.searchParams.get("workspace")?.trim() || undefined;
      const projectParam = url.searchParams.get("project")?.trim() || undefined;
      let resolvedRoot: string | undefined;
      if (workspaceParam) {
        resolvedRoot = path.resolve(workspaceParam);
      } else {
        try {
          resolvedRoot = resolveProject(
            projectParam && projectParam.toLowerCase() !== "all"
              ? projectParam
              : undefined,
          ).root;
        } catch {
          resolvedRoot = projectParam;
        }
      }

      const adapters = await aggregator.getAdaptersHealth();
      if (options.doctorProvider) {
        try {
          const custom = await options.doctorProvider(resolvedRoot);
          sendJson(res, 200, {
            ok: true,
            nodeVersion: process.version,
            adapters,
            doctor: custom,
          });
          return;
        } catch (err) {
          sendJson(res, 500, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            adapters,
          });
          return;
        }
      }

      sendJson(res, 200, {
        ok: true,
        nodeVersion: process.version,
        registeredProjects: listProjects().length,
        adapters,
        pushSessions: aggregator.pushBus.getAllSessionIds().length,
      });
      return;
    }

    // 11. POST /api/doctor/test-event
    if (method === "POST" && pathname === "/api/doctor/test-event") {
      let body: Record<string, unknown> = {};
      try {
        const parsed = await readJsonBody(req, MAX_INGEST_BODY_BYTES);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        // Optional body; defaults are fine.
      }

      const ideRaw = typeof body.ide === "string" ? body.ide : "mcp";
      const ide: IdeSource =
        ideRaw === "antigravity" ||
        ideRaw === "claude-code" ||
        ideRaw === "copilot-vscode" ||
        ideRaw === "mcp"
          ? ideRaw
          : "mcp";
      const sessionId =
        typeof body.sessionId === "string" && body.sessionId.trim()
          ? body.sessionId.trim()
          : "doctor-probe";
      const projectId =
        typeof body.project === "string" && body.project.trim()
          ? body.project.trim()
          : undefined;
      const epoch = Date.now() / 1000;
      const summary = "Doctor live telemetry test event";

      const testEvent: EnrichedEvent = {
        id: computeDeterministicEventId({
          ide,
          sessionId,
          agentId: "doctor",
          kind: "message",
          epoch,
          summary,
        }),
        ts: toIsoUtc(epoch),
        epoch,
        ide,
        channel: "mcp",
        sessionId,
        projectId,
        agentId: "doctor",
        agentLabel: "Doctor Probe",
        kind: "message",
        summary,
        payload: { synthetic: true, probe: true },
      };

      const result = aggregator.ingest([testEvent]);
      sendJson(res, 200, {
        ok: true,
        accepted: result.accepted,
        event: testEvent,
      });
      return;
    }

    // 12. Static Web Studio assets (dist/web/)
    if (method === "GET") {
      await serveStaticWeb(res, pathname);
      return;
    }

    sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      if (!isQuietSocketErr(err)) {
        process.stderr.write(
          `[agent-studio serve] unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { ok: false, error: "Internal Server Error" });
      }
    });
  });

  server.on("clientError", (err, socket) => {
    if (!isQuietSocketErr(err) && !socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  const listen = async (
    port = options.port ?? 8767,
    host = options.host ?? "127.0.0.1",
  ): Promise<{ host: string; port: number }> => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    heartbeatTimer = setInterval(() => {
      void (async () => {
        await aggregator.pollPushFiles().catch(() => undefined);
        for (const client of [...sseClients]) {
          if (!safeWrite(client.res, ": keepalive\n\n")) {
            sseClients.delete(client);
            continue;
          }
          void pushStateToClient(client, false);
        }
      })();
    }, SSE_HEARTBEAT_MS);
    heartbeatTimer.unref();

    const addr = server.address();
    const actualPort =
      addr && typeof addr === "object" ? addr.port : port;
    return { host, port: actualPort };
  };

  const close = async (): Promise<void> => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    for (const client of [...sseClients]) {
      try {
        client.res.end();
      } catch {
        // ignore
      }
      sseClients.delete(client);
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { server, aggregator, listen, close };
}
