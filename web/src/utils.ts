import type {
  AgentStatus,
  IdeSource,
  NormalizedEvent,
  NormalizedEventKind,
} from "./types.js";

export function escHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy copy
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function trunc(text: string | undefined | null, maxLen: number): string {
  const s = (text ?? "").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`;
}

/**
 * Strips wrapping quotes, inline Markdown syntax, collapses whitespace, and
 * normalizes ASCII arrows for clean display in feed cards and inspector prose.
 */
export function cleanSummaryText(raw: string | undefined | null): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";

  // Unwrap balanced outer quotes ("..." or '...')
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }

  // Strip Markdown links [label](url) -> label
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  // Strip bold/italic/code inline Markdown markers
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  // Normalize arrows and collapse whitespace
  s = s.replace(/\s*->\s*/g, " → ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Word-boundary truncation with ellipsis — never clips mid-word unless a single
 * unbroken token exceeds `maxLen`.
 */
export function truncateWords(text: string | undefined | null, maxLen: number): string {
  const s = (text ?? "").trim();
  if (s.length <= maxLen) return s;
  if (maxLen <= 2) return `${s.slice(0, Math.max(1, maxLen - 1))}…`;
  const slice = s.slice(0, maxLen - 1);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLen * 0.55)) {
    return `${slice.slice(0, lastSpace).replace(/[,.;:!?-]+$/, "")}…`;
  }
  return `${slice.trimEnd()}…`;
}

export function isErrorEvent(
  ev: Pick<NormalizedEvent, "summary" | "payload">
): boolean {
  const p = ev.payload;
  if (p) {
    if (p.isError === true || p.blocker === true) return true;
    if (p.permissionDecision === "deny") return true;
    if (typeof p.error === "string" && p.error.trim().length > 0) return true;
  }
  const up = (ev.summary ?? "").toUpperCase();
  return (
    up.includes("BLOCKER:") ||
    up.includes("QA_GATE_REJECTED") ||
    up.startsWith("ERROR:") ||
    up.includes("DENIED:")
  );
}

export function isRoutineToolEnd(
  ev: Pick<NormalizedEvent, "kind" | "summary" | "payload">
): boolean {
  if (ev.kind !== "tool_end") return false;
  if (isErrorEvent(ev)) return false;
  if (ev.payload?.routineEnd === true) return true;
  return /^(Done|Finished):?\s/i.test((ev.summary ?? "").trim());
}

function humanizeSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^ext:mcp:/i, "MCP: ")
    .replace(/^ext:/i, "")
    .replace(/^av-/i, "");
  return cleaned
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      const low = part.toLowerCase();
      if (low === "qa" || low === "ux" || low === "ui" || low === "mcp" || low === "api") {
        return low.toUpperCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function formatActorName(
  id: string | undefined | null,
  labelMap?: Map<string, string>,
  explicitLabel?: string
): string {
  const rawId = (id ?? "").trim();
  if (explicitLabel && explicitLabel.trim() && explicitLabel.trim() !== rawId) {
    const trimmed = explicitLabel.trim();
    if (/^[a-z]{2,3}-[a-z0-9-]+$/i.test(trimmed)) {
      return humanizeSlug(trimmed);
    }
    return trimmed;
  }
  if (!rawId) return "Agent";
  const mapped = labelMap?.get(rawId);
  if (mapped && mapped.trim()) {
    return /^[a-z]{2,3}-[a-z0-9-]+$/i.test(mapped.trim())
      ? humanizeSlug(mapped.trim())
      : mapped.trim();
  }
  if (rawId === "ext:human" || rawId === "human") return "User";
  if (rawId === "ext:board") return "Agile Board";
  if (rawId === "ext:shell") return "Local Shell";
  if (rawId === "ext:fs") return "Workspace FS";
  if (rawId === "ext:web") return "Web & Docs";
  if (rawId === "root") return "Coordinator";
  return humanizeSlug(rawId);
}

export type ReadableEventCategory =
  | "error"
  | "user"
  | "handoff"
  | "complete"
  | "message"
  | "board"
  | "waiting"
  | "thinking"
  | "edit"
  | "command"
  | "read"
  | "mcp"
  | "tool";

export interface ReadableEventClass {
  badge: string;
  cssClass: string;
  category: ReadableEventCategory;
  humanTitle: string;
  isLowSignal: boolean;
}

export function classifyEventReadable(
  ev: Pick<NormalizedEvent, "kind" | "toolName" | "summary" | "payload">
): ReadableEventClass {
  if (isErrorEvent(ev)) {
    return {
      badge: "Error",
      cssClass: "blocker",
      category: "error",
      humanTitle: "Error / Blocker",
      isLowSignal: false,
    };
  }

  const tool = (ev.toolName ?? "").toLowerCase();
  const sumLow = (ev.summary ?? "").toLowerCase();

  switch (ev.kind) {
    case "user_input":
      return {
        badge: "User",
        cssClass: "human",
        category: "user",
        humanTitle: "User Prompt",
        isLowSignal: false,
      };
    case "subagent_spawn":
      return {
        badge: "Handoff",
        cssClass: "dispatch",
        category: "handoff",
        humanTitle: "Subagent Handoff",
        isLowSignal: false,
      };
    case "subagent_done":
    case "assistant_turn_end":
      return {
        badge: "Completed",
        cssClass: "complete",
        category: "complete",
        humanTitle: ev.kind === "subagent_done" ? "Subagent Completed" : "Turn Completed",
        isLowSignal: false,
      };
    case "message":
      return {
        badge: "Message",
        cssClass: "peer",
        category: "message",
        humanTitle: "Agent Message",
        isLowSignal: false,
      };
    case "board_mutation": {
      const isQa =
        tool.includes("testrun") ||
        sumLow.includes("testrun") ||
        sumLow.includes("qa run") ||
        /\btr-\d+/i.test(ev.summary ?? "");
      return {
        badge: isQa ? "QA Run" : "Board",
        cssClass: "board",
        category: "board",
        humanTitle: isQa ? "QA Testrun Update" : "Agile Board Update",
        isLowSignal: false,
      };
    }
    case "thinking_start":
      return {
        badge: "Thinking",
        cssClass: "thinking",
        category: "thinking",
        humanTitle: "Agent Reasoning",
        isLowSignal: true,
      };
    case "session_start":
      return {
        badge: "Session",
        cssClass: "dispatch",
        category: "message",
        humanTitle: "Session Started",
        isLowSignal: false,
      };
    case "tool_start":
    case "tool_end": {
      if (
        tool === "ask_question" ||
        tool === "askuserquestion" ||
        tool === "vscode_askquestions" ||
        tool === "elicitationserialized"
      ) {
        return {
          badge: "Waiting",
          cssClass: "human",
          category: "waiting",
          humanTitle: "Waiting for User Input",
          isLowSignal: false,
        };
      }
      if (
        tool.includes("testrun") ||
        sumLow.includes("testrun") ||
        /\btr-\d+/i.test(ev.summary ?? "")
      ) {
        return {
          badge: "QA Run",
          cssClass: "board",
          category: "board",
          humanTitle: "QA Testrun Activity",
          isLowSignal: false,
        };
      }
      if (
        tool.includes("board") ||
        tool.includes("agile-modkit") ||
        sumLow.includes("board:") ||
        sumLow.includes("board ")
      ) {
        return {
          badge: "Board",
          cssClass: "board",
          category: "board",
          humanTitle: "Agile Board Check",
          isLowSignal: false,
        };
      }
      if (
        tool === "edit_file" ||
        tool === "write_file" ||
        tool === "edit" ||
        tool === "write" ||
        tool === "multiedit" ||
        tool === "copilot_applypatch" ||
        tool === "copilot_createfile" ||
        tool === "copilot_edit"
      ) {
        return {
          badge: "Edited",
          cssClass: "dispatch",
          category: "edit",
          humanTitle: "File Edited",
          isLowSignal: false,
        };
      }
      if (
        tool === "run_command" ||
        tool === "bash" ||
        tool === "run_in_terminal" ||
        tool === "send_to_terminal" ||
        tool.includes("terminal")
      ) {
        return {
          badge: "Command",
          cssClass: "peer",
          category: "command",
          humanTitle: "Terminal Command",
          isLowSignal: false,
        };
      }
      if (
        tool === "read_file" ||
        tool === "read" ||
        tool === "glob" ||
        tool === "grep" ||
        tool.startsWith("copilot_read") ||
        tool.startsWith("copilot_find") ||
        tool === "list_dir" ||
        tool === "find_by_name" ||
        tool === "grep_search"
      ) {
        return {
          badge: "Read",
          cssClass: "tool",
          category: "read",
          humanTitle: "Inspected File",
          isLowSignal: true,
        };
      }
      if (
        tool.startsWith("mcp") ||
        tool === "call_mcp_tool" ||
        tool.includes("_mcp_")
      ) {
        return {
          badge: "MCP",
          cssClass: "tool",
          category: "mcp",
          humanTitle: "MCP Tool Call",
          isLowSignal: true,
        };
      }
      return {
        badge: "Tool",
        cssClass: "tool",
        category: "tool",
        humanTitle: ev.toolName ? `Tool: ${ev.toolName}` : "Tool Execution",
        isLowSignal: true,
      };
    }
  }
}

export function fmtTimecode(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 3) return "just now";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function fmtClock(tsOrEpoch: string | number | undefined): string {
  if (tsOrEpoch == null) return "--:--:--";
  const d =
    typeof tsOrEpoch === "number"
      ? new Date(tsOrEpoch > 1e12 ? tsOrEpoch : tsOrEpoch * 1000)
      : new Date(tsOrEpoch);
  if (Number.isNaN(d.getTime())) return String(tsOrEpoch).slice(11, 19) || "--:--:--";
  return d.toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function fmtTokens(n: number | undefined | null): string {
  const val = Math.max(0, Math.round(Number.isFinite(n ?? 0) ? (n ?? 0) : 0));
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`;
  if (val >= 10_000) return `${(val / 1_000).toFixed(1)}k`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
  return String(val);
}

export function fmtContextWindow(n: number | undefined | null): string {
  const val = Math.max(0, Math.round(Number.isFinite(n ?? 0) ? (n ?? 0) : 0));
  if (val >= 1_000_000) {
    const m = val / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (val >= 1_000) {
    return `${Math.round(val / 1_000)}k`;
  }
  return String(val || "—");
}

export function fmtUsd(cost: number | undefined | null): string {
  if (cost == null || !Number.isFinite(cost) || cost <= 0) return "";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export interface ContextZoneInfo {
  id: "smart" | "drift" | "compact";
  label: string;
  cssClass: "ok" | "warn" | "err";
}

export function getContextZone(pct: number | undefined | null): ContextZoneInfo {
  const p = Number.isFinite(pct ?? 0) ? (pct ?? 0) : 0;
  if (p > 70) {
    return { id: "compact", label: "Compact", cssClass: "err" };
  }
  if (p > 40) {
    return { id: "drift", label: "Drift", cssClass: "warn" };
  }
  return { id: "smart", label: "Smart Zone", cssClass: "ok" };
}

export function contextHealthClass(pct: number | undefined | null): "ok" | "warn" | "err" {
  return getContextZone(pct).cssClass;
}

export interface IdeVisualMeta {
  id: IdeSource;
  label: string;
  short: string;
  color: string;
  bg: string;
  border: string;
}

export const IDE_META: Record<IdeSource, IdeVisualMeta> = {
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    short: "AGY",
    color: "#c084fc",
    bg: "rgba(168, 85, 247, 0.16)",
    border: "rgba(192, 132, 252, 0.45)",
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    short: "CLAUDE",
    color: "#fb923c",
    bg: "rgba(249, 115, 22, 0.16)",
    border: "rgba(251, 146, 60, 0.45)",
  },
  "copilot-vscode": {
    id: "copilot-vscode",
    label: "VS Code",
    short: "VSC",
    color: "#38bdf8",
    bg: "rgba(56, 189, 248, 0.16)",
    border: "rgba(56, 189, 248, 0.45)",
  },
  mcp: {
    id: "mcp",
    label: "MCP",
    short: "MCP",
    color: "#34d399",
    bg: "rgba(16, 185, 129, 0.16)",
    border: "rgba(52, 211, 153, 0.45)",
  },
  unknown: {
    id: "unknown",
    label: "Agent",
    short: "IDE",
    color: "#94a3b8",
    bg: "rgba(148, 163, 184, 0.14)",
    border: "rgba(148, 163, 184, 0.35)",
  },
};

export function getIdeMeta(ide?: string): IdeVisualMeta {
  if (!ide) return IDE_META.unknown;
  const key = ide.toLowerCase() as IdeSource;
  return IDE_META[key] ?? IDE_META.unknown;
}

export interface StatusVisualStyle {
  label: string;
  stroke: string;
  fill: string;
  text: string;
  dot: string;
  cssClass: string;
}

export function getStatusStyle(status?: string): StatusVisualStyle {
  const s = (status ?? "IDLE").toUpperCase() as AgentStatus;
  switch (s) {
    case "THINKING":
      return {
        label: "THINKING",
        stroke: "#c084fc",
        fill: "rgba(168, 85, 247, 0.22)",
        text: "#e9d5ff",
        dot: "#c084fc",
        cssClass: "thinking",
      };
    case "WORKING":
      return {
        label: "WORKING",
        stroke: "#f59e0b",
        fill: "rgba(245, 158, 11, 0.2)",
        text: "#fde68a",
        dot: "#f59e0b",
        cssClass: "working",
      };
    case "WAITING":
      return {
        label: "WAITING",
        stroke: "#06b6d4",
        fill: "rgba(6, 182, 212, 0.18)",
        text: "#67e8f9",
        dot: "#06b6d4",
        cssClass: "waiting",
      };
    case "BLOCKED":
      return {
        label: "BLOCKED",
        stroke: "#f43f5e",
        fill: "rgba(244, 63, 94, 0.2)",
        text: "#fda4af",
        dot: "#f43f5e",
        cssClass: "blocked",
      };
    case "DONE":
      return {
        label: "DONE",
        stroke: "#10b981",
        fill: "rgba(16, 185, 129, 0.18)",
        text: "#6ee7b7",
        dot: "#10b981",
        cssClass: "done",
      };
    default:
      return {
        label: "IDLE",
        stroke: "#475569",
        fill: "rgba(71, 85, 105, 0.2)",
        text: "#94a3b8",
        dot: "#64748b",
        cssClass: "idle",
      };
  }
}

export function colorForEventKind(
  kind: NormalizedEventKind,
  payload?: Record<string, unknown>
): string {
  if (payload?.isError || payload?.blocker || payload?.permissionDecision === "deny") {
    return "#f43f5e";
  }
  switch (kind) {
    case "subagent_spawn":
      return "#818cf8";
    case "subagent_done":
    case "assistant_turn_end":
      return "#10b981";
    case "message":
      return "#06b6d4";
    case "board_mutation":
      return "#a855f7";
    case "user_input":
      return "#f59e0b";
    case "thinking_start":
      return "#c084fc";
    case "tool_start":
    case "tool_end":
      return "#64748b";
    default:
      return "#94a3b8";
  }
}

const AGENT_PALETTE = [
  "#a855f7",
  "#06b6d4",
  "#38bdf8",
  "#10b981",
  "#818cf8",
  "#f59e0b",
  "#ec4899",
  "#22d3ee",
];

export function colorForAgent(agentId: string, isRoot = false): string {
  if (isRoot || agentId === "root") return "#a855f7";
  if (agentId === "ext:human" || agentId === "human") return "#f59e0b";
  if (agentId.startsWith("ext:")) return "#38bdf8";
  let h = 0;
  for (let i = 0; i < agentId.length; i++) {
    h = (h * 31 + agentId.charCodeAt(i)) | 0;
  }
  return AGENT_PALETTE[Math.abs(h) % AGENT_PALETTE.length] ?? "#06b6d4";
}

export function classifyExternalTarget(toolName?: string): { id: string; label: string } | null {
  if (!toolName) return null;
  const t = toolName.trim();
  const low = t.toLowerCase();

  if (
    low === "ask_question" ||
    low === "askuserquestion" ||
    low === "vscode_askquestions" ||
    low === "elicitationserealized" ||
    low === "elicitationserialized"
  ) {
    return { id: "ext:human", label: "User" };
  }

  if (
    low.includes("agent-studio__board") ||
    low.includes("agent-studio__testrun") ||
    low.includes("agile-modkit") ||
    low === "board" ||
    low === "testrun"
  ) {
    return { id: "ext:board", label: "Agile Board MCP" };
  }

  if (
    low === "run_command" ||
    low === "bash" ||
    low === "run_in_terminal" ||
    low === "send_to_terminal" ||
    low === "get_terminal_output" ||
    low.includes("terminal")
  ) {
    return { id: "ext:shell", label: "Local Shell" };
  }

  if (
    low === "read_file" ||
    low === "write_file" ||
    low === "edit_file" ||
    low === "read" ||
    low === "edit" ||
    low === "write" ||
    low === "multiedit" ||
    low === "glob" ||
    low === "grep" ||
    low.startsWith("copilot_read") ||
    low.startsWith("copilot_apply") ||
    low.startsWith("copilot_create") ||
    low.startsWith("copilot_find") ||
    low === "copilot_edit"
  ) {
    return { id: "ext:fs", label: "Workspace FS" };
  }

  if (
    low === "fetch" ||
    low.includes("fetchwebpage") ||
    low.includes("chrome-devtools") ||
    low.includes("search_docs") ||
    low.includes("web")
  ) {
    return { id: "ext:web", label: "Web & Docs" };
  }

  const mcpDouble = /^mcp__([^_]+)__/i.exec(t);
  if (mcpDouble?.[1]) {
    return { id: `ext:mcp:${mcpDouble[1]}`, label: `MCP: ${mcpDouble[1]}` };
  }
  const mcpSingle = /^mcp_([^_]+)_/i.exec(t);
  if (mcpSingle?.[1]) {
    return { id: `ext:mcp:${mcpSingle[1]}`, label: `MCP: ${mcpSingle[1]}` };
  }

  return null;
}

export function normalizeEpoch(ev: { epoch?: number; ts?: string }, fallbackIdx: number): number {
  if (typeof ev.epoch === "number" && Number.isFinite(ev.epoch) && ev.epoch > 0) {
    return ev.epoch;
  }
  if (ev.ts) {
    const parsed = Date.parse(ev.ts);
    if (!Number.isNaN(parsed)) return parsed / 1000;
  }
  return fallbackIdx;
}

export function normalizeStatus(raw?: string): AgentStatus {
  const s = (raw ?? "IDLE").toUpperCase();
  if (s === "BLOCKER") return "BLOCKED";
  if (
    s === "THINKING" ||
    s === "WORKING" ||
    s === "WAITING" ||
    s === "BLOCKED" ||
    s === "DONE" ||
    s === "IDLE"
  ) {
    return s;
  }
  return "IDLE";
}
