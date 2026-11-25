import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AgentEdgeSnapshot,
  AgentNodeSnapshot,
  AgentStatus,
  AgentUsageMetrics,
  EventKind,
  IdeSource,
  ModelSource,
  ModelUsageBucket,
  NormalizedEvent,
  SessionCounters,
  SessionSnapshot,
  SessionUsageSource,
  SessionUsageSummary,
  UsageSource,
} from "../schema/telemetry.js";

export type {
  AgentEdgeSnapshot,
  AgentNodeSnapshot,
  AgentStatus,
  AgentUsageMetrics,
  EventKind,
  IdeSource,
  ModelSource,
  ModelUsageBucket,
  NormalizedEvent,
  SessionCounters,
  SessionSnapshot,
  SessionUsageSource,
  SessionUsageSummary,
  UsageSource,
};

export interface UsageDelta {
  model?: string;
  modelSource?: ModelSource;
  usageSource?: UsageSource;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  contextTokens?: number;
  costUsd?: number;
  isTotal?: boolean;
}

export type TelemetryChannel = "passive" | "hook" | "mcp";
export type LegacyAgentState =
  | "thinking"
  | "working"
  | "waiting"
  | "blocker"
  | "done"
  | "idle";
export type NodeType = "agent" | "human" | "external";

export interface EnrichedEvent extends NormalizedEvent {
  epoch: number;
  channel: TelemetryChannel;
  mergeKey?: string;
  toolCallId?: string;
  targetAgentId?: string;
  status?: "ok" | "running" | "error" | "denied";
  isSelfDaemon?: boolean;
  isError?: boolean;
  waitingReason?: "user" | "tool_approval" | "subagent";
  usageDelta?: UsageDelta;
}

export interface AdapterHealth {
  ide: IdeSource;
  status: "ok" | "degraded" | "unavailable";
  rootDir: string;
  sessionsFound: number;
  message?: string;
}

export interface DiscoveredSession {
  ide: IdeSource;
  sessionId: string;
  filePath: string;
  workspacePath?: string;
  workspaces: string[];
  projectId?: string;
  title?: string;
  mtimeMs: number;
  sizeBytes: number;
  isMultiAgent: boolean;
  status?: AgentStatus;
  waitingOn?: string | null;
  isWaiting?: boolean;
  isCompleted?: boolean;
}

export interface RecentActionItem {
  ts: string;
  tool: string;
  text: string;
}

export interface RichAgentNode extends AgentNodeSnapshot {
  state: LegacyAgentState;
  nodeType: NodeType;
  isRoot: boolean;
  role: string;
  color: string;
  action: string;
  steps: number;
  ageSec: number | null;
  convId?: string;
  recentActions: RecentActionItem[];
  pendingPrompt?: Record<string, unknown> | null;
  model?: string;
  usage?: AgentUsageMetrics;
}

export interface ActivityItem {
  id: string;
  ts: string;
  epoch: number;
  from: string;
  to: string;
  kind: string;
  title: string;
  body: string;
  conv?: string;
  ide: IdeSource;
  toolName?: string;
  channel: TelemetryChannel;
}

export interface RichSessionSnapshot extends SessionSnapshot {
  session_id: string;
  server_time: string;
  waiting_on: string | null;
  is_waiting: boolean;
  is_completed: boolean;
  is_multi_agent: boolean;
  agents: RichAgentNode[];
  edges: AgentEdgeSnapshot[];
  events: EnrichedEvent[];
  activity: ActivityItem[];
  edge_counts: Record<string, number>;
  counters: SessionCounters;
  usage?: SessionUsageSummary;
  definitions?: Array<{
    id: string;
    name: string;
    roleType?: string;
    boardRole?: string;
    description: string;
    model: string;
    tools?: string[];
    capabilities?: string[];
    handoffs?: string[];
    source_ide: "canonical" | "antigravity" | "claude-code" | "copilot-vscode";
    source_path: string;
    chars: number;
    est_tokens: number;
    preview: string;
  }>;
}

export interface PassiveIdeAdapter {
  readonly ide: IdeSource;
  getHealth(): Promise<AdapterHealth>;
  discoverSessions(opts?: {
    limit?: number;
    workspaceRoots?: string[];
  }): Promise<DiscoveredSession[]>;
  parseSession(session: DiscoveredSession): Promise<EnrichedEvent[]>;
}

export const PALETTE = [
  "#a855f7", // Lead / Root (violet)
  "#ec4899", // Pink
  "#06b6d4", // Cyan
  "#3b82f6", // Blue
  "#10b981", // Emerald
  "#f59e0b", // Amber
  "#f97316", // Orange
  "#8b5cf6", // Purple
  "#14b8a6", // Teal
  "#ef4444", // Rose
] as const;

const ACRONYMS = new Set([
  "ui",
  "ux",
  "dom",
  "css",
  "qa",
  "api",
  "ops",
  "ai",
  "mcp",
  "ssh",
  "sql",
  "llm",
]);

export function prettifyAgentLabel(rawId: string): string {
  if (!rawId) return "Agent";
  if (rawId === "root") return "Coordinator";
  if (rawId === "human" || rawId === "ext:human") return "Human";
  let parts = rawId
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean);
  if (
    parts.length >= 3 &&
    ["app", "proj"].includes((parts[0] ?? "").toLowerCase())
  ) {
    parts = parts.slice(1);
  }
  const out = parts.map((p) => {
    const low = p.toLowerCase();
    if (ACRONYMS.has(low)) return low.toUpperCase();
    return p.charAt(0).toUpperCase() + p.slice(1);
  });
  const label = out.join(" ");
  return label.length > 24 ? label.slice(0, 24) : label;
}

export function unquoteArg(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") {
    const s = val.trim();
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(s);
        if (typeof decoded === "string") return decoded;
      } catch {
        // Keep original string if not valid JSON string literal.
      }
    }
    return val;
  }
  return String(val);
}

export function normalizeWsPath(rawPath: string): string {
  let p = String(rawPath || "").trim();
  if (!p) return "";
  if (p.startsWith("file:///")) {
    try {
      p = decodeURIComponent(p.slice("file:///".length));
    } catch {
      p = p.slice("file:///".length);
    }
    // On POSIX paths file:///home/foo becomes home/foo unless we keep leading / for non-drive paths
    if (!/^[a-zA-Z]:/.test(p) && !p.startsWith("/")) {
      p = "/" + p;
    }
  }
  p = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Z]:/.test(p)) {
    p = p[0]!.toLowerCase() + p.slice(1);
  }
  return p;
}

export function parseEpochSeconds(
  ts: string | number | undefined | null,
  fallbackSec?: number,
): number {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    // Convert ms epochs (> 1e11) to seconds
    return ts > 1e11 ? ts / 1000 : ts;
  }
  if (typeof ts === "string" && ts.trim()) {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) {
      return ms / 1000;
    }
  }
  return fallbackSec ?? Date.now() / 1000;
}

export function toIsoUtc(epochSec: number): string {
  return new Date(Math.round(epochSec * 1000)).toISOString();
}

export function computeDeterministicEventId(parts: {
  ide: IdeSource;
  sessionId: string;
  agentId: string;
  kind: EventKind;
  toolCallId?: string;
  toolName?: string;
  epoch: number;
  summary: string;
}): string {
  const hash = createHash("sha256");
  const fields = [
    parts.ide,
    parts.sessionId,
    parts.agentId,
    parts.kind,
    parts.toolCallId ?? parts.toolName ?? "",
    String(Math.floor(parts.epoch)),
    parts.summary.slice(0, 80),
  ];
  hash.update(fields.join("\u001f"));
  return hash.digest("hex").slice(0, 16);
}

export function computeMergeKey(ev: {
  sessionId: string;
  agentId: string;
  kind: EventKind;
  toolCallId?: string;
  toolName?: string;
  epoch: number;
}): string {
  if (ev.toolCallId && ev.toolCallId.trim()) {
    return `t1:${ev.sessionId}:${ev.agentId}:${ev.kind}:${ev.toolCallId.trim()}`;
  }
  const bucket2s = Math.floor(ev.epoch / 2);
  return `t2:${ev.sessionId}:${ev.agentId}:${ev.kind}:${ev.toolName ?? ""}:${bucket2s}`;
}

const SELF_DAEMON_PATTERNS = [
  "agent_visualizer.py",
  "agent-visualizer.py",
  "board_dashboard.py",
  "agent-studio serve",
  "dist/cli/index.js serve",
  "dist\\cli\\index.js serve",
];

export function isSelfDaemonCommand(text: string, isDaemonFlag?: unknown): boolean {
  if (isDaemonFlag === true || isDaemonFlag === "true") return true;
  const low = (text || "").toLowerCase();
  if (!low) return false;
  return SELF_DAEMON_PATTERNS.some((pat) => low.includes(pat));
}

export function classifyMessage(
  sender: string,
  recipient: string,
  body: string,
  rootId: string,
  fallback: "dispatch" | "peer" | "complete" | "blocker" = "peer",
): "dispatch" | "peer" | "complete" | "blocker" {
  const low = (body || "").toLowerCase();
  if (
    [
      "blocker",
      "qa fail",
      "qa_gate_rejected",
      "deadlock",
      "cannot proceed",
      "failed",
      "error:",
    ].some((k) => low.includes(k))
  ) {
    return "blocker";
  }
  if (
    [
      "complete",
      "completed",
      "pass",
      "verified",
      "ready for",
      "all checks passed",
    ].some((k) => low.includes(k))
  ) {
    if (recipient === rootId || sender !== rootId) {
      return "complete";
    }
  }
  if (sender === rootId) {
    return "dispatch";
  }
  return fallback;
}

const FS_TOOL_SET = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "multi_replace_file_content",
  "replace_file_content",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "find_by_name",
  "grep_search",
  "list_dir",
  "read",
  "write",
  "edit",
  "multiedit",
  "glob",
  "grep",
  "copilot_readfile",
  "copilot_applypatch",
  "copilot_createfile",
  "copilot_createdirectory",
  "copilot_findfiles",
  "copilot_findtextinfiles",
  "copilot_listdirectory",
  "copilot_getchangedfiles",
  "copilot_edit",
]);

const SHELL_TOOL_SET = new Set([
  "run_command",
  "send_command_input",
  "command_status",
  "manage_task",
  "bash",
  "run_in_terminal",
  "send_to_terminal",
  "get_terminal_output",
]);

const WEB_TOOL_SET = new Set([
  "read_url_content",
  "search_web",
  "browser_subagent",
  "open_browser_url",
  "webfetch",
  "websearch",
  "copilot_fetchwebpage",
  "vscode_fetchwebpage_internal",
  "gemini_search_docs",
  "gemini_get_doc",
]);

const HUMAN_TOOL_SET = new Set([
  "ask_question",
  "askuserquestion",
  "vscode_askquestions",
  "questioncarousel",
  "elicitationserialized",
]);

export interface ExternalToolClassification {
  id: string;
  label: string;
  role: string;
  color: string;
  nodeType: NodeType;
}

export function classifyExternalTool(
  toolName: string,
  args?: Record<string, unknown>,
): ExternalToolClassification | null {
  if (!toolName) return null;
  const low = toolName.toLowerCase();
  if (
    [
      "invoke_subagent",
      "send_message",
      "sendmessage",
      "notify_user",
      "agent",
      "task",
      "runsubagent",
      "agent/runsubagent",
    ].includes(low)
  ) {
    return null;
  }
  if (HUMAN_TOOL_SET.has(low)) {
    return {
      id: "ext:human",
      label: "Human",
      role: "User / Prompt Source",
      color: "#f59e0b",
      nodeType: "human",
    };
  }
  if (
    low === "board" ||
    low === "testrun" ||
    low.includes("agent-studio__board") ||
    low.includes("agent-studio__testrun")
  ) {
    return {
      id: "ext:board",
      label: "Agile Board MCP",
      role: "Agile Board & QA Gate",
      color: "#38bdf8",
      nodeType: "external",
    };
  }
  if (low.startsWith("mcp__") || low.startsWith("mcp_")) {
    const segs = low.startsWith("mcp__")
      ? low.slice(5).split("__")
      : low.slice(4).split("_");
    const srv = segs[0] || "server";
    return {
      id: `ext:mcp:${srv}`,
      label: `MCP: ${prettifyAgentLabel(srv)}`,
      role: "MCP External Server",
      color: "#38bdf8",
      nodeType: "external",
    };
  }
  if (
    low === "call_mcp_tool" ||
    low === "read_resource" ||
    low === "list_resources"
  ) {
    const srv = (
      unquoteArg(args?.ServerName ?? args?.serverName) || "mcp"
    )
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-");
    if (srv.includes("agent-studio")) {
      return {
        id: "ext:board",
        label: "Agile Board MCP",
        role: "Agile Board & QA Gate",
        color: "#38bdf8",
        nodeType: "external",
      };
    }
    return {
      id: `ext:mcp:${srv}`,
      label: `MCP: ${prettifyAgentLabel(srv)}`,
      role: "MCP External Server",
      color: "#38bdf8",
      nodeType: "external",
    };
  }
  if (WEB_TOOL_SET.has(low) || low.includes("chrome-devtools")) {
    return {
      id: "ext:web",
      label: "Web / Browser",
      role: "External HTTP & Browser",
      color: "#14b8a6",
      nodeType: "external",
    };
  }
  if (SHELL_TOOL_SET.has(low)) {
    return {
      id: "ext:shell",
      label: "Local Shell",
      role: "OS / Terminal Runtime",
      color: "#f97316",
      nodeType: "external",
    };
  }
  if (FS_TOOL_SET.has(low)) {
    return {
      id: "ext:fs",
      label: "Workspace FS",
      role: "Local Filesystem",
      color: "#64748b",
      nodeType: "external",
    };
  }
  return null;
}

export function cleanHumanSummary(text: string, maxLen = 140): string {
  if (!text) return "";
  let s = unquoteArg(text).trim();
  // Strip stray unmatched leading/trailing quotes from truncated JSON args
  if (s.startsWith('"') && !s.slice(1).includes('"')) {
    s = s.slice(1);
  }
  if (s.endsWith('"') && !s.slice(0, -1).includes('"')) {
    s = s.slice(0, -1);
  }
  // Convert Markdown links [label](url) -> label
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Strip HTML tags
  s = s.replace(/<[^>]+>/g, " ");
  // Strip Markdown formatting markers (**, __, `, headings, list bullets)
  s = s
    .replace(/\*\*|__/g, "")
    .replace(/`+/g, "")
    .replace(/(^|\n)\s*#{1,6}\s+/g, "$1")
    .replace(/(^|\n)\s*[-*•]\s+/g, "$1");
  // Collapse whitespace and newlines
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;

  const budget = Math.max(12, maxLen - 1);
  const sliced = s.slice(0, budget);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut =
    lastSpace >= Math.floor(budget * 0.45) ? sliced.slice(0, lastSpace) : sliced;
  return cut.replace(/[,;:\-–—(]+$/, "").trimEnd() + "…";
}

export function parseMcpArguments(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const unquoted = unquoteArg(raw).trim();
    if (unquoted.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(unquoted);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Fallback: extract simple key:"value" pairs from truncated JSON snippets
        const fallback: Record<string, unknown> = {};
        for (const m of unquoted.matchAll(/"([a-zA-Z0-9_]+)"\s*:\s*"([^"]*)"/g)) {
          if (m[1]) fallback[m[1]] = m[2] ?? "";
        }
        return fallback;
      }
    }
  }
  return {};
}

function resolveMcpToolAndArgs(
  tname: string,
  args: Record<string, unknown>,
): { mcpTool: string; mcpArgs: Record<string, unknown> } | null {
  const low = tname.toLowerCase();
  if (low === "call_mcp_tool") {
    const innerTool = unquoteArg(args.ToolName ?? args.toolName).toLowerCase();
    const innerArgs = parseMcpArguments(args.Arguments ?? args.arguments);
    return { mcpTool: innerTool, mcpArgs: innerArgs };
  }
  if (low === "board" || low === "testrun" || low === "projects" || low === "telemetry") {
    return { mcpTool: low, mcpArgs: args };
  }
  if (low.startsWith("mcp__") || low.startsWith("mcp_")) {
    const parts = low.startsWith("mcp__") ? low.slice(5).split("__") : low.slice(4).split("_");
    const innerTool = parts[parts.length - 1] ?? "";
    if (["board", "testrun", "projects", "telemetry"].includes(innerTool)) {
      return { mcpTool: innerTool, mcpArgs: args };
    }
    return { mcpTool: innerTool || low, mcpArgs: args };
  }
  return null;
}

const MUTATING_BOARD_OPS = new Set(["add", "move", "note", "owner", "plan"]);
const MUTATING_TESTRUN_OPS = new Set(["start", "record", "step", "close"]);

export function isBoardMutationToolCall(
  tname: string,
  args: Record<string, unknown>,
): boolean {
  const resolved = resolveMcpToolAndArgs(tname, args);
  if (!resolved) return false;
  const op = unquoteArg(resolved.mcpArgs.op).toLowerCase();
  if (resolved.mcpTool === "board") return MUTATING_BOARD_OPS.has(op);
  if (resolved.mcpTool === "testrun") return MUTATING_TESTRUN_OPS.has(op);
  return false;
}

function formatShortFile(rawPath: string): string {
  const cleaned = unquoteArg(rawPath).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!cleaned) return "file";
  const base = path.posix.basename(cleaned);
  return base || "file";
}

function summarizeShellCommand(rawCmd: string): string {
  const cmd = unquoteArg(rawCmd).trim();
  const low = cmd.toLowerCase();
  if (!cmd) return "Ran command";
  if (low.includes("smoke_test.py")) return "Ran Python smoke test suite";
  if (low.includes("npm test") || low.includes("node --test")) return "Ran unit tests";
  if (low.includes("npm run check") || low.includes("tsc ")) return "Ran TypeScript typecheck";
  if (low.includes("vite build") || low.includes("npm --prefix web run build")) return "Built web app";
  if (low.includes("npm run build")) return "Built project";
  if (low.includes("py_compile")) return "Checked Python syntax";
  if (low.includes("git status")) return "Checked git status";
  if (low.includes("git diff")) return "Reviewed git diff";
  if (low.includes("tailscale serve")) return "Checked Tailscale serve status";
  // Strip noisy drive paths for cleaner display
  const stripped = cmd.replace(/[a-zA-Z]:[\\/][^\s"']+[\\/](?=[^\s"']+)/g, "");
  return `Run: ${cleanHumanSummary(stripped, 95)}`;
}

export function summarizeToolCall(
  tname: string,
  args: Record<string, unknown>,
): string {
  const low = tname.toLowerCase();

  // 1. MCP Board / Testrun / Projects / Telemetry plain-English summaries
  const mcp = resolveMcpToolAndArgs(tname, args);
  if (mcp) {
    const op = unquoteArg(mcp.mcpArgs.op).toLowerCase();
    const itemId = unquoteArg(mcp.mcpArgs.id ?? mcp.mcpArgs.itemId);
    if (mcp.mcpTool === "board") {
      if (op === "move") {
        const state = unquoteArg(mcp.mcpArgs.state);
        const note = cleanHumanSummary(unquoteArg(mcp.mcpArgs.note), 65);
        const base = `Moved ${itemId || "item"} → ${state || "next"}`;
        return cleanHumanSummary(note ? `${base} — ${note}` : base, 140);
      }
      if (op === "add") {
        const itemType = unquoteArg(mcp.mcpArgs.type) || "item";
        const title = cleanHumanSummary(unquoteArg(mcp.mcpArgs.title), 100);
        return cleanHumanSummary(
          title ? `Added ${itemType}: ${title}` : `Added ${itemType} to board`,
          140,
        );
      }
      if (op === "status") return "Checked sprint board status";
      if (op === "next") return "Checked next ready work items";
      if (op === "show") return `Inspected work item ${itemId || ""}`.trim();
      if (op === "note") {
        const txt = cleanHumanSummary(
          unquoteArg(mcp.mcpArgs.text ?? mcp.mcpArgs.note),
          75,
        );
        return cleanHumanSummary(
          txt ? `Added note on ${itemId || "item"} — ${txt}` : `Added note on ${itemId || "item"}`,
          140,
        );
      }
      if (op === "owner") {
        const owner = unquoteArg(mcp.mcpArgs.owner);
        return `Assigned ${itemId || "item"} to ${owner || "agent"}`;
      }
      if (op === "plan") {
        const sp = unquoteArg(mcp.mcpArgs.sprint);
        return `Planned sprint ${sp || ""}`.trim();
      }
      if (op === "gate") return "Checked QA release gate";
      if (op === "report") return "Generated sprint report";
      return cleanHumanSummary(`Updated board (${op || "query"})`, 140);
    }

    if (mcp.mcpTool === "testrun") {
      const runId = unquoteArg(
        mcp.mcpArgs.run_id ?? mcp.mcpArgs.runId ?? mcp.mcpArgs.run ?? mcp.mcpArgs.id,
      );
      const cp = unquoteArg(mcp.mcpArgs.checkpoint ?? mcp.mcpArgs.cp);
      const result = unquoteArg(mcp.mcpArgs.result).toUpperCase();
      const suite = unquoteArg(mcp.mcpArgs.suite);
      if (op === "start") {
        return `Started ${suite || "smoke"} QA testrun`;
      }
      if (op === "record" || op === "step") {
        return cleanHumanSummary(
          `Recorded ${cp || "checkpoint"} ${result || "RESULT"} on ${runId || "testrun"}`,
          140,
        );
      }
      if (op === "close") {
        return `Closed QA testrun ${runId || ""}`.trim();
      }
      if (op === "list") return "Listed recent QA testruns";
      return cleanHumanSummary(`QA testrun (${op || "query"})`, 140);
    }

    if (mcp.mcpTool === "projects") {
      if (op === "register") {
        const pid = unquoteArg(mcp.mcpArgs.id ?? mcp.mcpArgs.title);
        return pid ? `Registered project ${pid}` : "Registered project";
      }
      return "Listed / checked registered projects";
    }

    if (mcp.mcpTool === "telemetry") {
      const sum = cleanHumanSummary(unquoteArg(mcp.mcpArgs.summary), 120);
      return sum || "Emitted live telemetry event";
    }

    return cleanHumanSummary(`MCP: ${prettifyAgentLabel(mcp.mcpTool)}`, 140);
  }

  // 2. File tools
  if (
    low === "read_file" ||
    low === "read" ||
    low === "copilot_readfile" ||
    low === "view_file"
  ) {
    const p = unquoteArg(args.Path ?? args.file_path ?? args.path ?? args.filePath);
    return `Read ${formatShortFile(p)}`;
  }
  if (
    low === "write_file" ||
    low === "write" ||
    low === "copilot_createfile"
  ) {
    const p = unquoteArg(args.Path ?? args.file_path ?? args.path ?? args.filePath);
    return `Wrote ${formatShortFile(p)}`;
  }
  if (
    low === "edit_file" ||
    low === "edit" ||
    low === "multiedit" ||
    low === "copilot_applypatch" ||
    low === "replace_file_content" ||
    low === "multi_replace_file_content"
  ) {
    const p = unquoteArg(args.Path ?? args.file_path ?? args.path ?? args.filePath);
    return `Edited ${formatShortFile(p)}`;
  }

  // 3. Shell tools
  if (low === "run_command" || low === "bash" || low === "run_in_terminal") {
    const explicit = unquoteArg(args.toolSummary ?? args.description);
    if (explicit) {
      return cleanHumanSummary(`Run: ${explicit}`, 120);
    }
    return summarizeShellCommand(
      unquoteArg(args.CommandLine ?? args.command),
    );
  }

  // 4. Subagent & messaging tools
  if (low === "invoke_subagent" || low === "agent" || low === "task") {
    const role = unquoteArg(
      args.Role ?? args.TypeName ?? args.subagent_type ?? args.description,
    );
    return cleanHumanSummary(`Spawned ${role || "subagent"}`, 140);
  }
  if (low === "send_message" || low === "sendmessage") {
    return "Sent message";
  }

  return cleanHumanSummary(`Tool: ${tname}`, 120);
}

export function matchProjectIdForWorkspace(
  workspacePath: string | undefined,
  registeredProjects: ReadonlyArray<{ id: string; root: string }>,
): string | undefined {
  if (!workspacePath) return undefined;
  const normWs = normalizeWsPath(workspacePath);
  if (!normWs) return undefined;

  // Longest-root prefix match; NEVER reverse-prefix a parent dir onto a sibling child!
  const sorted = [...registeredProjects]
    .map((p) => ({ id: p.id, root: normalizeWsPath(p.root) }))
    .filter((p) => p.root.length > 0)
    .sort((a, b) => b.root.length - a.root.length);

  for (const proj of sorted) {
    if (normWs === proj.root || normWs.startsWith(proj.root + "/")) {
      return proj.id;
    }
  }
  return undefined;
}

export function inferContextWindow(model: string): number {
  const low = (model || "").trim().toLowerCase();
  if (!low || low === "unknown") return 200_000;
  if (low.includes("gemini")) return 1_000_000;
  if (low.includes("claude")) return 200_000;
  if (low.includes("gpt-4.1") || low.includes("gpt 4.1")) return 1_000_000;
  if (
    low.includes("gpt-4o") ||
    low.includes("gpt 4o") ||
    /\bo[134](?:\b|-|_)/.test(low)
  ) {
    return 128_000;
  }
  return 200_000;
}

const MODEL_PREFIX_RE = /^(?:copilot|models|google|anthropic|openai|azure|vertex)\//i;

export function prettifyModelName(raw: string): string {
  const trimmed = unquoteArg(raw).trim();
  if (!trimmed) return "";
  const lowRaw = trimmed.toLowerCase();
  if (lowRaw === "inherit" || lowRaw === "unknown" || lowRaw === "default") {
    return "";
  }

  // Strip provider prefixes like "copilot/claude-sonnet-4" or "models/gemini-2.5-pro"
  const stripped = trimmed.replace(MODEL_PREFIX_RE, "").trim();
  if (!stripped) return "";

  // Preserve already-descriptive display names like "Gemini 4 Neon (High)"
  if (/\s/.test(stripped) && /[A-Z]/.test(stripped)) {
    return stripped;
  }

  const low = stripped.toLowerCase();
  if (low === "flash") return "Gemini Flash";
  if (low === "flash_lite" || low === "flash-lite") return "Gemini Flash Lite";
  if (low === "pro") return "Gemini Pro";

  // Match Gemini tier suffix pattern e.g. "gemini-4-neon-high" -> "Gemini 4 Neon (High)"
  const geminiTierMatch = /^gemini[-_](\d+(?:\.\d+)?)[-_]([a-z0-9]+)[-_](high|medium|low)$/i.exec(
    stripped,
  );
  if (geminiTierMatch?.[1] && geminiTierMatch[2] && geminiTierMatch[3]) {
    const ver = geminiTierMatch[1];
    const variant =
      geminiTierMatch[2].charAt(0).toUpperCase() +
      geminiTierMatch[2].slice(1).toLowerCase();
    const tier =
      geminiTierMatch[3].charAt(0).toUpperCase() +
      geminiTierMatch[3].slice(1).toLowerCase();
    return `Gemini ${ver} ${variant} (${tier})`;
  }

  // Match GPT models cleanly
  if (low.startsWith("gpt-")) {
    return "GPT-" + stripped.slice(4);
  }
  if (/^o[134](?:[-_].+)?$/i.test(stripped)) {
    return stripped.replace(/_/g, "-");
  }

  // Strip trailing YYYYMMDD snapshot date suffixes (e.g. claude-sonnet-4-5-20250929)
  const withoutDate = stripped.replace(/[-_]20\d{6}$/, "");

  // Convert hyphen/underscore slugs (e.g. "claude-sonnet-4" -> "Claude Sonnet 4",
  // "claude-sonnet-4-5" -> "Claude Sonnet 4.5", "gemini-2.5-flash" -> "Gemini 2.5 Flash")
  const tokens = withoutDate.split(/[-_]+/).filter(Boolean);
  const formatted: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    // Join consecutive single-digit minor version tokens with "." (e.g. ["4", "5"] -> "4.5")
    if (
      /^\d+$/.test(tok) &&
      formatted.length > 0 &&
      /^\d+$/.test(formatted[formatted.length - 1]!)
    ) {
      formatted[formatted.length - 1] = `${formatted[formatted.length - 1]}.${tok}`;
      continue;
    }
    if (/^\d+(?:\.\d+)?$/.test(tok)) {
      formatted.push(tok);
    } else {
      formatted.push(tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase());
    }
  }
  return formatted.join(" ");
}
