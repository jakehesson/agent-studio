export type HostIde = "antigravity" | "copilot-vscode";

export type StudioView =
  | "studio"
  | "board"
  | "team"
  | "mockups"
  | "doctor"
  | "chat";

export function detectHostIdeFromAppName(appName: string | undefined): HostIde {
  if (appName && /antigravity|agy/i.test(appName)) {
    return "antigravity";
  }
  return "copilot-vscode";
}

export function getHostIdeDisplayName(ide: HostIde): string {
  return ide === "antigravity" ? "Antigravity" : "VS Code";
}

export function normalizeWorkspacePath(fsPath: string | undefined): string | undefined {
  if (!fsPath) return undefined;
  const trimmed = fsPath.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
}

export interface BuildScopedViewUrlInput {
  baseUrl: string;
  view?: StudioView;
  projectId?: string;
  sessionId?: string;
  agentId?: string;
  focusQuestion?: boolean;
  openWaiting?: boolean;
  openChatAgentId?: string;
  embed?: boolean;
  hostIde?: HostIde;
  workspaceRoot?: string;
}

export function buildScopedViewUrl(input: BuildScopedViewUrlInput): string {
  const params = new URLSearchParams();
  if (input.embed) {
    params.set("embed", "1");
    if (input.hostIde) {
      params.set("ide", input.hostIde);
    }
    const normWs = normalizeWorkspacePath(input.workspaceRoot);
    if (normWs) {
      params.set("workspace", normWs);
    }
  }
  if (input.view && input.view !== "studio") {
    params.set("view", input.view);
  }
  if (input.projectId) {
    params.set("project", input.projectId);
  }
  if (input.sessionId) {
    params.set("session", input.sessionId);
  }
  if (input.agentId && input.agentId.trim()) {
    params.set("agent", input.agentId.trim());
  }
  if (input.focusQuestion === true) {
    params.set("focusQuestion", "1");
  }
  if (input.openWaiting) {
    params.set("openWaiting", "1");
  }
  if (input.openChatAgentId && input.openChatAgentId.trim()) {
    params.set("openChat", input.openChatAgentId.trim());
  }
  const qs = params.toString();
  return `${input.baseUrl.replace(/\/+$/, "")}/${qs ? `?${qs}` : ""}`;
}

export function appendDeepLinkParams(
  rawUrl: string,
  opts?: { openWaiting?: boolean; openChatAgentId?: string },
): string {
  const hasWaiting = Boolean(opts?.openWaiting);
  const chatAgent = opts?.openChatAgentId?.trim();
  if (!hasWaiting && !chatAgent) {
    return rawUrl;
  }
  const parsed = new URL(rawUrl);
  if (hasWaiting) {
    parsed.searchParams.set("openWaiting", "1");
  }
  if (chatAgent) {
    parsed.searchParams.set("openChat", chatAgent);
  }
  return parsed.toString();
}

export interface SessionWaitingInfo {
  status?: string;
  waitingOn?: string | null;
  pendingQuestionCount?: number;
  waitingSummary?: string;
}

export function isSessionWaitingForHuman(session: SessionWaitingInfo): boolean {
  const status = (session.status ?? "").toUpperCase();
  const pendingCount =
    typeof session.pendingQuestionCount === "number" &&
    Number.isFinite(session.pendingQuestionCount)
      ? session.pendingQuestionCount
      : 0;
  return (
    session.waitingOn === "user" ||
    session.waitingOn === "tool_approval" ||
    pendingCount > 0 ||
    status === "WAITING"
  );
}

export interface ScopedSessionsQueryInput {
  hostIde: HostIde;
  workspaceRoot?: string;
  projectId?: string;
  limit?: number;
}

export function buildScopedSessionsQueryString(
  input: ScopedSessionsQueryInput,
): string {
  const params = new URLSearchParams();
  params.set("ide", input.hostIde);
  const normWs = normalizeWorkspacePath(input.workspaceRoot);
  if (normWs) {
    params.set("workspace", normWs);
  }
  if (input.projectId) {
    params.set("project", input.projectId);
  }
  if (typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0) {
    params.set("limit", String(Math.floor(input.limit)));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
