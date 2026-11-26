import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  boardAdd,
  boardGate,
  boardMove,
  boardNext,
  boardNote,
  boardOwner,
  boardPlan,
  boardReport,
  boardShow,
  boardStatus,
  listProjects,
  readBoard,
  registerProject,
  resolveProject,
  testrunClose,
  testrunList,
  testrunRecord,
  testrunStart,
  testrunStep,
  type ResolvedProject,
} from "../board/index.js";
import { buildDoctorReport } from "../cli/commands/doctor.js";
import {
  BOARD_ITEM_TYPES,
  BOARD_STATES,
  BUG_RESOLUTIONS,
  BUG_SEVERITIES,
  type BoardItemType,
  type BoardState,
  type BugResolution,
  type BugSeverity,
} from "../schema/board.js";
import {
  createDeterministicEventId,
  EVENT_KINDS,
  IDE_SOURCES,
  NormalizedEventSchema,
  type EventKind,
  type IdeSource,
  type NormalizedEvent,
} from "../schema/telemetry.js";
import {
  TelemetryAggregator,
  computeDeterministicEventId,
  discoverTeamDetailsCached,
  toIsoUtc,
  type EnrichedEvent,
} from "../telemetry/index.js";

declare const __AGENT_STUDIO_VERSION__: string | undefined;

function resolveServerVersion(): string {
  if (
    typeof __AGENT_STUDIO_VERSION__ === "string" &&
    __AGENT_STUDIO_VERSION__.trim().length > 0
  ) {
    return __AGENT_STUDIO_VERSION__.trim();
  }
  const envVer = process.env.AGENT_STUDIO_VERSION?.trim();
  if (envVer) {
    return envVer;
  }
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    for (const rel of [
      "../../package.json",
      "../package.json",
      "../../../package.json",
    ]) {
      const candidate = path.resolve(thisDir, rel);
      if (!fsSync.existsSync(candidate)) continue;
      const parsed = JSON.parse(fsSync.readFileSync(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        (parsed.name === "agent-studio" ||
          parsed.name === "agent-studio-vscode") &&
        typeof parsed.version === "string" &&
        parsed.version.trim().length > 0
      ) {
        return parsed.version.trim();
      }
    }
  } catch {
    // Fall through to default version
  }
  return "0.11.1";
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_APP_RESOURCE_URI = "ui://agent-studio/app.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const MAX_MCP_APP_HTML_BYTES = 10 * 1024 * 1024;

const FALLBACK_MCP_APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Studio</title>
  <style>
    body { margin: 0; padding: 24px; font-family: var(--font-sans, system-ui, sans-serif); background: var(--color-background-primary, #0b1020); color: var(--color-text-primary, #e2e8f0); }
    .card { max-width: 560px; margin: 0 auto; padding: 20px; border-radius: 12px; border: 1px solid var(--color-border-primary, #1e293b); background: var(--color-background-secondary, #111827); }
    h1 { margin: 0 0 8px; font-size: 1.15rem; }
    p { margin: 0; line-height: 1.5; color: var(--color-text-secondary, #94a3b8); }
  </style>
</head>
<body>
  <div class="card">
    <h1>Agent Studio MCP App</h1>
    <p>Build the MCP App UI bundle (<code>dist/mcp-app/app.html</code>) to load the full interactive topology, timeline scrubber, team roster, Agile board, and Doctor studio.</p>
  </div>
</body>
</html>
`;

export const MCP_RESOURCES = [
  {
    uri: MCP_APP_RESOURCE_URI,
    name: "Agent Studio",
    description:
      "Interactive Live Multi-Agent Topology, Timeline Scrubber, Team Roster, Agile Board & Doctor UI",
    mimeType: MCP_APP_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
] as const;

export const MCP_SERVER_INFO: { readonly name: string; readonly version: string } = {
  name: "agent-studio",
  version: resolveServerVersion(),
};

export interface McpServerOptions {
  defaultProject?: string;
  cwd?: string;
  sessionId?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const MCP_TOOLS = [
  {
    name: "projects",
    description:
      "List, register, or inspect projects tracked by Agent Studio (~/.agent-studio/projects.json).",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["list", "register", "info"],
          description: "Project registry operation.",
        },
        project: {
          type: "string",
          description: "Project ID or root path (for info).",
        },
        id: {
          type: "string",
          description: "Explicit project ID slug (for register).",
        },
        title: {
          type: "string",
          description: "Human-friendly project title (for register).",
        },
        root: {
          type: "string",
          description: "Project workspace root path (for register).",
        },
        boardPath: {
          type: "string",
          description: "Relative path to board.json (default pipeline/board.json).",
        },
        setDefault: {
          type: "boolean",
          description: "Set as default project in registry.",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "board",
    description:
      "Project-agnostic Agile DevOps Board engine with strict server-side QA Gate enforcement on test -> done transitions.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "status",
            "next",
            "show",
            "add",
            "move",
            "note",
            "owner",
            "plan",
            "gate",
            "report",
          ],
          description: "Board operation to execute.",
        },
        project: {
          type: "string",
          description: "Project ID or directory path (optional if cwd/default resolves).",
        },
        itemId: {
          type: "string",
          description: "Item ID (e.g. S1-01, BUG-01).",
        },
        id: {
          type: "string",
          description: "Alias for itemId.",
        },
        sprint: { type: "string", description: "Sprint ID (e.g. S1)." },
        goal: { type: "string", description: "Sprint goal (for plan)." },
        showDone: { type: "boolean", description: "Include done items in status." },
        role: { type: "string", description: "Agent/board role." },
        limit: { type: "number", description: "Max items to return." },
        type: {
          type: "string",
          enum: [...BOARD_ITEM_TYPES],
          description: "Item type (for add).",
        },
        title: { type: "string", description: "Item title (for add)." },
        ac: {
          type: "array",
          items: { type: "string" },
          description: "Acceptance criteria list (for add).",
        },
        deps: {
          type: "array",
          items: { type: "string" },
          description: "Dependency item IDs (for add).",
        },
        severity: {
          type: "string",
          enum: [...BUG_SEVERITIES],
          description: "Bug severity S1..S4 (for add bug).",
        },
        points: { type: "number", description: "Story points estimate." },
        repro: { type: "string", description: "Bug repro steps (for add bug)." },
        foundIn: { type: "string", description: "Build ID where bug was found." },
        suite: { type: "string", description: "Required QA suite override." },
        requiredCheckpoints: {
          type: "array",
          items: { type: "string" },
          description: "Required QA checkpoint IDs override.",
        },
        state: {
          type: "string",
          enum: [...BOARD_STATES],
          description: "Target workflow state (for move).",
        },
        actor: {
          type: "string",
          description: "Role or agent name performing the action.",
        },
        note: { type: "string", description: "Note or transition reason." },
        text: { type: "string", description: "Alias for note (for op=note)." },
        evidence: { type: "string", description: "Evidence reference or path." },
        build: { type: "string", description: "Build ID (for bug fix/close)." },
        resolution: {
          type: "string",
          enum: [...BUG_RESOLUTIONS],
          description: "Bug resolution (for closing bugs).",
        },
        overrideReason: {
          type: "string",
          description:
            "Audited override reason to bypass QA Gate on test -> done (recorded in item notes).",
        },
        owner: { type: "string", description: "Owner name (for op=owner)." },
        writeFile: {
          type: "boolean",
          description: "Write docs/sprints/<sprint>-review.md (for op=report).",
        },
        sessionId: { type: "string", description: "Optional caller session ID for telemetry." },
        ide: {
          type: "string",
          enum: [...IDE_SOURCES],
          description: "Optional caller IDE source for telemetry.",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "testrun",
    description:
      "Start, record checkpoints/steps, close, and list QA testruns required to pass the server-side QA Gate.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["start", "record", "step", "close", "list"],
          description: "Testrun operation.",
        },
        project: { type: "string", description: "Project ID or workspace path." },
        runId: { type: "string", description: "Testrun ID (e.g. TR-001)." },
        suite: { type: "string", description: "Suite name (e.g. smoke, full)." },
        build: { type: "string", description: "Build identifier." },
        actor: { type: "string", description: "QA actor name." },
        items: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of item IDs explicitly covered by this run.",
        },
        checkpoint: { type: "string", description: "Checkpoint ID (e.g. CP0)." },
        stepIndex: {
          type: "number",
          description: "0-based step index (for op=step).",
        },
        result: {
          type: "string",
          enum: ["pass", "fail", "skip"],
          description: "Checkpoint or step outcome.",
        },
        note: { type: "string", description: "Verification evidence note." },
        bug: { type: "string", description: "Associated bug ID if failed." },
        status: {
          type: "string",
          enum: ["running", "passed", "failed"],
          description: "Optional status filter (for op=list).",
        },
        limit: { type: "number", description: "Max runs to return (for op=list)." },
        sessionId: { type: "string", description: "Optional caller session ID." },
        ide: {
          type: "string",
          enum: [...IDE_SOURCES],
          description: "Optional caller IDE source.",
        },
      },
      required: ["op"],
    },
  },
  {
    name: "telemetry",
    description:
      "Emit live normalized telemetry events or explicit agent handoffs to <projectRoot>/.agent-studio/telemetry.jsonl.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["emit", "handoff"],
          description: "Telemetry operation.",
        },
        project: { type: "string", description: "Project ID or workspace path." },
        sessionId: { type: "string", description: "Session UUID or identifier." },
        ide: {
          type: "string",
          enum: [...IDE_SOURCES],
          description: "Source IDE (default mcp).",
        },
        agentId: { type: "string", description: "Emitting agent ID/slug." },
        agentLabel: { type: "string", description: "Display label for agent." },
        parentAgentId: { type: "string", description: "Parent coordinator agent ID." },
        targetAgentId: {
          type: "string",
          description: "Target agent ID (for op=handoff).",
        },
        kind: {
          type: "string",
          enum: [...EVENT_KINDS],
          description: "Normalized event kind (for op=emit, default message).",
        },
        toolName: { type: "string", description: "Optional tool name." },
        summary: { type: "string", description: "Human-readable event summary." },
        payload: {
          type: "object",
          description: "Additional structured metadata.",
        },
      },
      required: ["op", "summary"],
    },
  },
  {
    name: "open_studio",
    title: "Agent Studio",
    description:
      "Open the interactive Agent Studio MCP App UI (Live Multi-Agent Topology, Timeline Scrubber, Team Roster, Agile Board, and Doctor). All parameters are optional.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["studio", "team", "board", "doctor"],
          description: "Initial view tab to focus (default studio).",
        },
        project: {
          type: "string",
          description: "Optional registered project ID or workspace path.",
        },
        session: {
          type: "string",
          description: "Optional session UUID to inspect.",
        },
        workspace: {
          type: "string",
          description: "Optional workspace root path.",
        },
      },
    },
    _meta: {
      ui: {
        resourceUri: MCP_APP_RESOURCE_URI,
      },
      "com.google.antigravity/ui": {
        entrypoints: [
          { type: "aux_pane", title: "Agent Studio" },
          { type: "global", title: "Agent Studio" },
        ],
      },
    },
  },
  {
    name: "app_get_state",
    description:
      "App-only data bridge returning live multi-agent session snapshot, discovered sessions, and registered board projects.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string" },
        ide: { type: "string" },
        project: { type: "string" },
        workspace: { type: "string" },
        multiOnly: { type: "boolean" },
      },
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  {
    name: "app_get_event_body",
    description:
      "App-only data bridge returning the full untruncated body for a specific session event.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string" },
        event: { type: "string" },
        ide: { type: "string" },
        project: { type: "string" },
        workspace: { type: "string" },
      },
      required: ["session", "event"],
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  {
    name: "app_get_board",
    description:
      "App-only data bridge returning the live Agile Board snapshot, sprint status, QA gate state, and recent testruns.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        workspace: { type: "string" },
        sprint: { type: "string" },
        showDone: { type: "boolean" },
      },
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  {
    name: "app_get_team",
    description:
      "App-only data bridge returning discovered agent team definitions, skills, and rules for the active workspace.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        workspace: { type: "string" },
      },
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  {
    name: "app_get_doctor",
    description:
      "App-only data bridge returning workspace Doctor diagnostics and telemetry adapter health.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        workspace: { type: "string" },
      },
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  {
    name: "app_send_test_event",
    description:
      "App-only diagnostic bridge that injects a synthetic telemetry probe event into the live aggregator.",
    inputSchema: {
      type: "object",
      properties: {
        ide: { type: "string" },
        project: { type: "string" },
        sessionId: { type: "string" },
        summary: { type: "string" },
      },
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
] as const;

function str(val: unknown): string | undefined {
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : undefined;
}

function strArray(val: unknown): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val.filter((v): v is string => typeof v === "string");
}

function num(val: unknown): number | undefined {
  return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}

function bool(val: unknown): boolean | undefined {
  return typeof val === "boolean" ? val : undefined;
}

function asIdeSource(val: unknown): IdeSource {
  if (typeof val === "string" && (IDE_SOURCES as readonly string[]).includes(val)) {
    return val as IdeSource;
  }
  return "mcp";
}

function asEventKind(val: unknown, fallback: EventKind): EventKind {
  if (typeof val === "string" && (EVENT_KINDS as readonly string[]).includes(val)) {
    return val as EventKind;
  }
  return fallback;
}

export async function appendProjectTelemetry(
  projectRoot: string,
  event: NormalizedEvent,
): Promise<void> {
  try {
    const validated = NormalizedEventSchema.parse(event);
    const telemetryPath = path.join(
      projectRoot,
      ".agent-studio",
      "telemetry.jsonl",
    );
    await fs.mkdir(path.dirname(telemetryPath), { recursive: true });
    await fs.appendFile(telemetryPath, JSON.stringify(validated) + "\n", "utf8");
  } catch {
    // Telemetry persistence is strictly best-effort and must never fail MCP tool calls.
  }
}

function buildTelemetryEvent(params: {
  project?: ResolvedProject;
  sessionId?: string;
  ide?: IdeSource;
  agentId?: string;
  agentLabel?: string;
  parentAgentId?: string;
  kind: EventKind;
  toolName?: string;
  summary: string;
  payload?: Record<string, unknown>;
}): NormalizedEvent {
  const ts = new Date().toISOString();
  const sessionId = params.sessionId || `mcp-${params.project?.id ?? "default"}`;
  const agentId = params.agentId || "mcp-agent";
  const id = createDeterministicEventId([
    ts,
    sessionId,
    agentId,
    params.kind,
    params.toolName,
    params.summary,
  ]);

  return NormalizedEventSchema.parse({
    id,
    ts,
    ide: params.ide ?? "mcp",
    sessionId,
    workspacePath: params.project?.root,
    projectId: params.project?.id,
    agentId,
    agentLabel: params.agentLabel,
    parentAgentId: params.parentAgentId,
    kind: params.kind,
    toolName: params.toolName,
    summary: params.summary,
    payload: params.payload,
  });
}

async function executeProjectsTool(
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<McpToolCallResult> {
  const op = str(args.op);
  if (op === "list") {
    const projects = listProjects();
    if (projects.length === 0) {
      return {
        content: [{ type: "text", text: "No projects registered." }],
      };
    }
    const lines = projects.map(
      (p) => `${p.id}: ${p.title} (${p.root}) [board=${p.boardPath}]`,
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (op === "register") {
    const root = str(args.root) ?? options.cwd ?? process.cwd();
    const entry = registerProject({
      id: str(args.id),
      title: str(args.title),
      root,
      boardPath: str(args.boardPath),
      setDefault: bool(args.setDefault),
    });
    return {
      content: [
        {
          type: "text",
          text: `registered ${entry.id}: ${entry.title} (${entry.root})`,
        },
      ],
    };
  }

  if (op === "info") {
    const resolved = resolveProject(
      str(args.project) ?? options.defaultProject,
      options.cwd,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: resolved.id,
              title: resolved.title,
              root: resolved.root,
              boardPath: resolved.boardPath,
              teamPath: resolved.teamPath,
              qaGateRequired: resolved.qaGateRequired,
              hasTeamManifest: resolved.teamManifest !== null,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown projects op: ${String(args.op)}` }],
  };
}

async function executeBoardTool(
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<McpToolCallResult> {
  const op = str(args.op);
  const project = resolveProject(
    str(args.project) ?? options.defaultProject,
    options.cwd,
  );
  const ctx = { project };
  const actor = str(args.actor) ?? "orchestrator";
  const ide = asIdeSource(args.ide);
  const sessionId = str(args.sessionId) ?? options.sessionId;
  const itemId = str(args.itemId) ?? str(args.id);

  let text: string;
  let isMutation = false;
  let eventPayload: Record<string, unknown> = { tool: "board", op, actor };

  switch (op) {
    case "status": {
      const res = await boardStatus(ctx, {
        sprint: str(args.sprint),
        showDone: bool(args.showDone),
      });
      text = res.text;
      break;
    }
    case "next": {
      const res = await boardNext(ctx, {
        role: str(args.role),
        limit: num(args.limit),
      });
      text = res.text;
      break;
    }
    case "show": {
      if (!itemId) throw new Error("board show requires itemId");
      const res = await boardShow(ctx, { itemId });
      text = res.text;
      eventPayload = { ...eventPayload, itemId };
      break;
    }
    case "add": {
      const type = str(args.type) as BoardItemType | undefined;
      const title = str(args.title);
      const role = str(args.role);
      if (!type || !(BOARD_ITEM_TYPES as readonly string[]).includes(type)) {
        throw new Error(`board add requires type in ${BOARD_ITEM_TYPES.join(", ")}`);
      }
      if (!title) throw new Error("board add requires title");
      if (!role) throw new Error("board add requires role");
      const res = await boardAdd(ctx, {
        type,
        title,
        role,
        sprint: str(args.sprint),
        ac: strArray(args.ac),
        deps: strArray(args.deps),
        severity: str(args.severity) as BugSeverity | undefined,
        points: num(args.points),
        actor,
        foundIn: str(args.foundIn),
        repro: str(args.repro),
        suite: str(args.suite),
        requiredCheckpoints: strArray(args.requiredCheckpoints),
      });
      text = res.text;
      isMutation = true;
      eventPayload = {
        ...eventPayload,
        itemId: res.data.id,
        type: res.data.type,
        state: res.data.state,
        role: res.data.role,
      };
      break;
    }
    case "move": {
      if (!itemId) throw new Error("board move requires itemId");
      const state = str(args.state) as BoardState | undefined;
      if (!state || !(BOARD_STATES as readonly string[]).includes(state)) {
        throw new Error(`board move requires state in ${BOARD_STATES.join(", ")}`);
      }
      const res = await boardMove(ctx, {
        itemId,
        state,
        actor,
        note: str(args.note) ?? str(args.text),
        evidence: str(args.evidence),
        build: str(args.build),
        resolution: str(args.resolution) as BugResolution | undefined,
        overrideReason: str(args.overrideReason),
      });
      text = res.text;
      isMutation = true;
      eventPayload = {
        ...eventPayload,
        itemId: res.data.item.id,
        state: res.data.item.state,
        qaGate: res.data.qaGate,
        coveringTestrun: res.data.coveringTestrun,
      };
      break;
    }
    case "note": {
      if (!itemId) throw new Error("board note requires itemId");
      const noteText = str(args.text) ?? str(args.note);
      if (!noteText) throw new Error("board note requires text or note");
      const res = await boardNote(ctx, {
        itemId,
        actor,
        text: noteText,
        evidence: str(args.evidence),
      });
      text = res.text;
      isMutation = true;
      eventPayload = { ...eventPayload, itemId };
      break;
    }
    case "owner": {
      if (!itemId) throw new Error("board owner requires itemId");
      const owner = str(args.owner);
      if (!owner) throw new Error("board owner requires owner");
      const res = await boardOwner(ctx, { itemId, owner });
      text = res.text;
      isMutation = true;
      eventPayload = { ...eventPayload, itemId, owner };
      break;
    }
    case "plan": {
      const sprint = str(args.sprint);
      if (!sprint) throw new Error("board plan requires sprint");
      const res = await boardPlan(ctx, { sprint, goal: str(args.goal) });
      text = res.text;
      isMutation = true;
      eventPayload = { ...eventPayload, sprint };
      break;
    }
    case "gate": {
      const res = await boardGate(ctx);
      text = res.text;
      eventPayload = { ...eventPayload, passed: res.data.passed };
      break;
    }
    case "report": {
      const res = await boardReport(ctx, {
        sprint: str(args.sprint),
        writeFile: bool(args.writeFile),
      });
      text = res.text;
      eventPayload = { ...eventPayload, sprint: res.data.sprint };
      break;
    }
    default:
      throw new Error(`Unknown board op: ${String(args.op)}`);
  }

  const event = buildTelemetryEvent({
    project,
    sessionId,
    ide,
    agentId: actor,
    kind: isMutation ? "board_mutation" : "tool_end",
    toolName: "board",
    summary: `board.${op}: ${text.split("\n")[0] ?? ""}`,
    payload: eventPayload,
  });
  await appendProjectTelemetry(project.root, event);

  return { content: [{ type: "text", text }] };
}

async function executeTestrunTool(
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<McpToolCallResult> {
  const op = str(args.op);
  const project = resolveProject(
    str(args.project) ?? options.defaultProject,
    options.cwd,
  );
  const ctx = { project };
  const actor = str(args.actor) ?? "qa";
  const ide = asIdeSource(args.ide);
  const sessionId = str(args.sessionId) ?? options.sessionId;

  let text: string;
  let isMutation = false;
  let eventPayload: Record<string, unknown> = { tool: "testrun", op, actor };

  switch (op) {
    case "start": {
      const suite = str(args.suite);
      if (!suite) throw new Error("testrun start requires suite");
      const res = await testrunStart(ctx, {
        suite,
        build: str(args.build),
        actor,
        items: strArray(args.items),
      });
      text = res.text;
      isMutation = true;
      eventPayload = { ...eventPayload, runId: res.data.id, suite };
      break;
    }
    case "record": {
      const runId = str(args.runId);
      const checkpoint = str(args.checkpoint);
      const result = str(args.result);
      if (!runId || !checkpoint) {
        throw new Error("testrun record requires runId and checkpoint");
      }
      if (result !== "pass" && result !== "fail" && result !== "skip") {
        throw new Error("testrun record requires result: pass | fail | skip");
      }
      const res = await testrunRecord(ctx, {
        runId,
        checkpoint,
        result,
        note: str(args.note),
        bug: str(args.bug),
      });
      text = res.text;
      isMutation = true;
      eventPayload = { ...eventPayload, runId, checkpoint, result };
      break;
    }
    case "step": {
      const runId = str(args.runId);
      const checkpoint = str(args.checkpoint);
      const stepIndex = num(args.stepIndex);
      const result = str(args.result);
      if (!runId || !checkpoint || stepIndex === undefined) {
        throw new Error("testrun step requires runId, checkpoint, and stepIndex");
      }
      if (result !== "pass" && result !== "fail" && result !== "skip") {
        throw new Error("testrun step requires result: pass | fail | skip");
      }
      const res = await testrunStep(ctx, {
        runId,
        checkpoint,
        stepIndex,
        result,
        note: str(args.note),
      });
      text = res.text;
      isMutation = true;
      eventPayload = { ...eventPayload, runId, checkpoint, stepIndex, result };
      break;
    }
    case "close": {
      const runId = str(args.runId);
      if (!runId) throw new Error("testrun close requires runId");
      const res = await testrunClose(ctx, { runId });
      text = res.text;
      isMutation = true;
      eventPayload = {
        ...eventPayload,
        runId,
        status: res.data.testrun.status,
      };
      break;
    }
    case "list": {
      const statusRaw = str(args.status);
      const statusFilter =
        statusRaw === "running" ||
        statusRaw === "passed" ||
        statusRaw === "failed"
          ? statusRaw
          : undefined;
      const res = await testrunList(ctx, {
        limit: num(args.limit),
        suite: str(args.suite),
        status: statusFilter,
      });
      text = res.text;
      break;
    }
    default:
      throw new Error(`Unknown testrun op: ${String(args.op)}`);
  }

  const event = buildTelemetryEvent({
    project,
    sessionId,
    ide,
    agentId: actor,
    kind: isMutation ? "board_mutation" : "tool_end",
    toolName: "testrun",
    summary: `testrun.${op}: ${text.split("\n")[0] ?? ""}`,
    payload: eventPayload,
  });
  await appendProjectTelemetry(project.root, event);

  return { content: [{ type: "text", text }] };
}

async function executeTelemetryTool(
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<McpToolCallResult> {
  const op = str(args.op);
  const summary = str(args.summary);
  if (!summary) {
    throw new Error("telemetry requires non-empty summary");
  }

  let project: ResolvedProject | undefined;
  try {
    project = resolveProject(
      str(args.project) ?? options.defaultProject,
      options.cwd,
    );
  } catch {
    project = undefined;
  }

  const ide = asIdeSource(args.ide);
  const sessionId = str(args.sessionId) ?? options.sessionId;
  const agentId = str(args.agentId) ?? "orchestrator";
  const targetAgentId = str(args.targetAgentId);
  const basePayload =
    args.payload && typeof args.payload === "object" && !Array.isArray(args.payload)
      ? (args.payload as Record<string, unknown>)
      : {};

  let kind: EventKind;
  let payload: Record<string, unknown>;

  if (op === "handoff") {
    kind = "message";
    payload = {
      ...basePayload,
      type: "handoff",
      from: agentId,
      to: targetAgentId ?? "unknown",
    };
  } else if (op === "emit") {
    kind = asEventKind(args.kind, "message");
    payload = basePayload;
  } else {
    throw new Error(`Unknown telemetry op: ${String(args.op)}`);
  }

  const event = buildTelemetryEvent({
    project,
    sessionId,
    ide,
    agentId,
    agentLabel: str(args.agentLabel),
    parentAgentId: str(args.parentAgentId),
    kind,
    toolName: str(args.toolName) ?? "telemetry",
    summary,
    payload,
  });

  const targetRoot = project?.root ?? options.cwd ?? process.cwd();
  await appendProjectTelemetry(targetRoot, event);

  return {
    content: [
      {
        type: "text",
        text: `emitted ${event.kind} (${event.id}): ${event.summary}`,
      },
    ],
  };
}

let lazyAggregator: TelemetryAggregator | null = null;

function getMcpAggregator(): TelemetryAggregator {
  if (!lazyAggregator) {
    lazyAggregator = new TelemetryAggregator();
  }
  return lazyAggregator;
}

async function readMcpAppHtml(): Promise<string> {
  const candidates: string[] = [];
  const envHtml = process.env.AGENT_STUDIO_APP_HTML?.trim();
  if (envHtml) {
    candidates.push(path.resolve(envHtml));
  }
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(
    path.join(thisDir, "app.html"),
    path.resolve(thisDir, "../../dist/mcp-app/app.html"),
    path.resolve(thisDir, "../../../dist/mcp-app/app.html"),
  );

  let html = FALLBACK_MCP_APP_HTML;
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      html = await fs.readFile(candidate, "utf8");
      break;
    }
  }

  const sizeBytes = Buffer.byteLength(html, "utf8");
  if (sizeBytes > MAX_MCP_APP_HTML_BYTES) {
    throw new Error(
      `MCP App HTML exceeds 10 MiB limit (${sizeBytes} bytes).`,
    );
  }
  return html;
}

async function executeOpenStudioTool(
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<McpToolCallResult> {
  const rawView = str(args.view);
  const view =
    rawView === "studio" ||
    rawView === "team" ||
    rawView === "board" ||
    rawView === "doctor"
      ? rawView
      : "studio";
  const explicitProject = str(args.project) ?? options.defaultProject;
  let resolvedProjectId = explicitProject;
  let resolvedWorkspace = str(args.workspace);

  if (!resolvedProjectId || !resolvedWorkspace) {
    try {
      const proj = resolveProject(explicitProject, options.cwd);
      resolvedProjectId = resolvedProjectId ?? proj.id;
      resolvedWorkspace = resolvedWorkspace ?? proj.root;
    } catch {
      // Optional — studio opens cleanly even with {} and no workspace
    }
  }

  const session = str(args.session);
  const structuredContent: Record<string, unknown> = {
    view,
    project: resolvedProjectId ?? null,
    session: session ?? null,
    workspace: resolvedWorkspace ?? null,
    ide: "antigravity",
    version: MCP_SERVER_INFO.version,
  };

  const parts = [`Opened Agent Studio (view=${view}`];
  if (resolvedProjectId) parts.push(`project=${resolvedProjectId}`);
  if (session) parts.push(`session=${session}`);
  const summaryText = `${parts.join(", ")}).`;

  return {
    content: [{ type: "text", text: summaryText }],
    structuredContent,
  };
}

async function executeAppGetStateTool(
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<McpToolCallResult> {
  const aggregator = getMcpAggregator();
  const ide = str(args.ide);
  const project = str(args.project) ?? options.defaultProject;
  const workspace = str(args.workspace);
  const session = str(args.session);
  const multiOnly = bool(args.multiOnly);

  const payload = await aggregator.getSessionSnapshot(session, {
    ide,
    project,
    workspace,
    multiOnly,
  });

  const structuredContent: Record<string, unknown> = {
    ...payload.snapshot,
    sessions: payload.sessions,
    board_projects: payload.boardProjects,
  };

  return {
    content: [
      {
        type: "text",
        text: `Loaded state for session ${payload.snapshot.sessionId || "none"} (${payload.sessions.length} session(s)).`,
      },
    ],
    structuredContent,
  };
}

async function executeAppGetEventBodyTool(
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<McpToolCallResult> {
  const session = str(args.session);
  const eventId = str(args.event);
  if (!session || !eventId) {
    const errPayload: Record<string, unknown> = {
      ok: false,
      error: "Missing session or event query parameter",
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(errPayload) }],
      structuredContent: errPayload,
    };
  }

  const aggregator = getMcpAggregator();
  const entry = await aggregator.getEventBody({
    sessionId: session,
    eventId,
    ide: str(args.ide),
    project: str(args.project) ?? options.defaultProject,
    workspace: str(args.workspace),
  });

  if (!entry) {
    const errPayload: Record<string, unknown> = {
      ok: false,
      error: "Event body not found",
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(errPayload) }],
      structuredContent: errPayload,
    };
  }

  const payload: Record<string, unknown> = {
    ok: true,
    sessionId: session,
    eventId,
    body: entry.body,
    truncated: entry.truncated,
    byteLength: entry.byteLength,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function executeAppGetBoardTool(
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<McpToolCallResult> {
  const workspaceParam = str(args.workspace);
  const projectParam = str(args.project);
  const ref =
    projectParam && projectParam.toLowerCase() !== "all"
      ? projectParam
      : workspaceParam ?? options.defaultProject;
  const project = resolveProject(ref, workspaceParam ?? options.cwd);
  const ctx = { project };
  const [board, statusRes, gateRes, runsRes] = await Promise.all([
    readBoard(project.boardPath),
    boardStatus(ctx, {
      sprint: str(args.sprint),
      showDone: bool(args.showDone),
    }),
    boardGate(ctx),
    testrunList(ctx, { limit: 25 }),
  ]);

  const structuredContent: Record<string, unknown> = {
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
  };

  return {
    content: [
      {
        type: "text",
        text: `Loaded Agile Board for ${project.id} (${board.items.length} item(s)).`,
      },
    ],
    structuredContent,
  };
}

async function executeAppGetTeamTool(
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<McpToolCallResult> {
  const projectParam = str(args.project) ?? options.defaultProject;
  const workspaceParam = str(args.workspace);
  let resolvedRoot: string | undefined;

  if (projectParam && projectParam.toLowerCase() !== "all") {
    try {
      resolvedRoot = resolveProject(projectParam, options.cwd).root;
    } catch {
      resolvedRoot = undefined;
    }
  } else if (!workspaceParam) {
    try {
      resolvedRoot = resolveProject(undefined, options.cwd).root;
    } catch {
      resolvedRoot = options.cwd ?? process.cwd();
    }
  }

  const primaryRoot = workspaceParam ?? resolvedRoot ?? options.cwd ?? process.cwd();
  const workspaceRoots = [
    ...(workspaceParam ? [workspaceParam] : []),
    ...(resolvedRoot ? [resolvedRoot] : []),
  ];

  const details = await discoverTeamDetailsCached(
    workspaceRoots,
    primaryRoot,
    15_000,
  );

  return {
    content: [
      {
        type: "text",
        text: `Loaded team roster (${details.definitions.length} agent(s), ${details.skills.length} skill(s)).`,
      },
    ],
    structuredContent: details as unknown as Record<string, unknown>,
  };
}

async function executeAppGetDoctorTool(
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<McpToolCallResult> {
  const aggregator = getMcpAggregator();
  const projectParam = str(args.project) ?? options.defaultProject;
  const workspaceParam = str(args.workspace);
  let resolvedRoot = workspaceParam;

  if (!resolvedRoot) {
    try {
      resolvedRoot = resolveProject(projectParam, options.cwd).root;
    } catch {
      resolvedRoot = options.cwd ?? process.cwd();
    }
  }

  const [adapters, report] = await Promise.all([
    aggregator.getAdaptersHealth(),
    Promise.resolve(buildDoctorReport(resolvedRoot)),
  ]);

  const structuredContent: Record<string, unknown> = {
    ok: report.ok,
    nodeVersion: process.version,
    adapters,
    doctor: report,
  };

  return {
    content: [
      {
        type: "text",
        text: `Doctor report for ${report.projectId ?? resolvedRoot}: ${report.ok ? "PASS" : "ISSUES"}.`,
      },
    ],
    structuredContent,
  };
}

async function executeAppSendTestEventTool(
  args: Record<string, unknown>,
  options: McpServerOptions,
): Promise<McpToolCallResult> {
  const aggregator = getMcpAggregator();
  const ideRaw = str(args.ide);
  const ide: IdeSource =
    ideRaw === "antigravity" ||
    ideRaw === "claude-code" ||
    ideRaw === "copilot-vscode" ||
    ideRaw === "mcp"
      ? ideRaw
      : "antigravity";
  const sessionId = str(args.sessionId) ?? "doctor-probe";
  const projectId = str(args.project) ?? options.defaultProject;
  const summary = str(args.summary) ?? "Doctor live telemetry test event";
  const epoch = Date.now() / 1000;

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
  const structuredContent: Record<string, unknown> = {
    ok: true,
    accepted: result.accepted,
    event: testEvent,
  };

  return {
    content: [
      {
        type: "text",
        text: `Injected synthetic test event (accepted=${result.accepted}).`,
      },
    ],
    structuredContent,
  };
}

export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  options: McpServerOptions = {},
): Promise<McpToolCallResult> {
  try {
    switch (name) {
      case "projects":
        return await executeProjectsTool(args, options);
      case "board":
        return await executeBoardTool(args, options);
      case "testrun":
        return await executeTestrunTool(args, options);
      case "telemetry":
        return await executeTelemetryTool(args, options);
      case "open_studio":
        return await executeOpenStudioTool(args, options);
      case "app_get_state":
        return await executeAppGetStateTool(args, options);
      case "app_get_event_body":
        return await executeAppGetEventBodyTool(args, options);
      case "app_get_board":
        return await executeAppGetBoardTool(args, options);
      case "app_get_team":
        return await executeAppGetTeamTool(args, options);
      case "app_get_doctor":
        return await executeAppGetDoctorTool(args, options);
      case "app_send_test_event":
        return await executeAppSendTestEventTool(args, options);
      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort telemetry for rejected QA gate / tool errors when project resolves
    if (name === "board" || name === "testrun") {
      try {
        const project = resolveProject(
          str(args.project) ?? options.defaultProject,
          options.cwd,
        );
        const event = buildTelemetryEvent({
          project,
          sessionId: str(args.sessionId) ?? options.sessionId,
          ide: asIdeSource(args.ide),
          agentId: str(args.actor) ?? "mcp-agent",
          kind: "tool_end",
          toolName: name,
          summary: `${name}.${str(args.op) ?? "unknown"} error: ${message}`,
          payload: {
            tool: name,
            op: str(args.op),
            isError: true,
            error: message,
          },
        });
        await appendProjectTelemetry(project.root, event);
      } catch {
        // Ignore telemetry failure on error path.
      }
    }
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
}

export async function handleJsonRpcMessage(
  msg: JsonRpcRequest,
  options: McpServerOptions = {},
): Promise<JsonRpcResponse | null> {
  const hasId = msg.id !== undefined;
  const id = msg.id ?? null;

  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid Request" },
    };
  }

  // Notifications have no id and must not receive a response.
  if (!hasId) {
    return null;
  }

  switch (msg.method) {
    case "initialize": {
      const requestedVersion =
        msg.params && typeof msg.params.protocolVersion === "string"
          ? msg.params.protocolVersion
          : MCP_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            requestedVersion === MCP_PROTOCOL_VERSION
              ? requestedVersion
              : MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: MCP_SERVER_INFO,
        },
      };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "resources/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { resources: MCP_RESOURCES },
      };

    case "resources/read": {
      const params = msg.params ?? {};
      const uri = typeof params.uri === "string" ? params.uri : "";
      if (uri !== MCP_APP_RESOURCE_URI) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `Unknown resource URI: ${uri || "(empty)"}`,
          },
        };
      }
      try {
        const html = await readMcpAppHtml();
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri: MCP_APP_RESOURCE_URI,
                mimeType: MCP_APP_MIME_TYPE,
                text: html,
                _meta: {
                  ui: {
                    prefersBorder: false,
                  },
                },
              },
            ],
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: MCP_TOOLS },
      };

    case "tools/call": {
      const params = msg.params ?? {};
      const toolName = typeof params.name === "string" ? params.name : "";
      const toolArgs =
        params.arguments &&
        typeof params.arguments === "object" &&
        !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

      if (!toolName) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Missing tool name in tools/call" },
        };
      }

      const result = await dispatchToolCall(toolName, toolArgs, options);
      return {
        jsonrpc: "2.0",
        id,
        result,
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
  }
}

export async function startMcpStdioServer(
  options: McpServerOptions = {},
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  let queue: Promise<void> = Promise.resolve();

  const writeResponse = (resp: JsonRpcResponse): void => {
    process.stdout.write(JSON.stringify(resp) + "\n");
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    queue = queue.then(async () => {
      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(trimmed) as JsonRpcRequest;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        writeResponse({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Parse error: ${errMsg}` },
        });
        return;
      }

      try {
        const resp = await handleJsonRpcMessage(parsed, options);
        if (resp !== null) {
          writeResponse(resp);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[agent-studio mcp] internal error: ${errMsg}\n`);
        if (parsed.id !== undefined) {
          writeResponse({
            jsonrpc: "2.0",
            id: parsed.id ?? null,
            error: { code: -32603, message: `Internal error: ${errMsg}` },
          });
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      queue.finally(() => resolve());
    });
  });
}
