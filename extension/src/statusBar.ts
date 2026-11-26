import * as vscode from "vscode";
import { isSessionWaitingForHuman } from "./scoping";
import type { ServerManager } from "./serverManager";

export interface StatusBarSessionItem {
  sessionId: string;
  title?: string;
  status?: string;
  ide?: string;
  waitingOn?: string | null;
  pendingQuestionCount?: number;
  waitingSummary?: string;
}

interface SessionsApiResponse {
  sessions?: StatusBarSessionItem[];
}

interface BoardApiResponse {
  board?: {
    active_sprint?: string;
    items?: Array<{ type?: string; state?: string }>;
  };
}

function sanitizeInlineMarkdown(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/`/g, "'").trim();
}

export interface StatusBarPresentation {
  text: string;
  isWarning: boolean;
  tooltipLines: string[];
  waitingCount: number;
  activeCount: number;
}

export function buildStatusBarPresentation(input: {
  sessions: StatusBarSessionItem[];
  openItemsCount: number;
  openBugsCount: number;
  sprint: string;
  hostIdeName: string;
  workspaceLabel: string;
  mode: string;
  port: number;
}): StatusBarPresentation {
  const {
    sessions,
    openItemsCount,
    openBugsCount,
    sprint,
    hostIdeName,
    workspaceLabel,
    mode,
    port,
  } = input;

  const waitingSessions = sessions.filter(isSessionWaitingForHuman);
  const waitingCount = waitingSessions.length;
  const active = sessions.filter(
    (s) =>
      ["THINKING", "WORKING", "WAITING", "BLOCKED"].includes(
        (s.status ?? "").toUpperCase(),
      ) || isSessionWaitingForHuman(s),
  );

  let text: string;
  if (waitingCount > 0) {
    text =
      active.length > 0
        ? `$(question) ${waitingCount} waiting · ${active.length} active`
        : `$(question) ${waitingCount} waiting · :${port}`;
  } else if (active.length > 0) {
    text = `$(pulse) Agent Studio: ${active.length} active`;
  } else {
    text = `$(radio-tower) Agent Studio :${port}`;
  }

  const waitingLines =
    waitingCount > 0
      ? [
          `- Waiting for input: **${waitingCount}**`,
          ...waitingSessions.slice(0, 5).map((s) => {
            const label = sanitizeInlineMarkdown(
              s.title || s.sessionId.slice(0, 8),
            );
            const summary =
              typeof s.waitingSummary === "string" && s.waitingSummary.trim()
                ? ` — ${sanitizeInlineMarkdown(s.waitingSummary)}`
                : "";
            return `  - \`${label}\`${summary}`;
          }),
          ...(waitingCount > 5 ? [`  - _…and ${waitingCount - 5} more_`] : []),
        ]
      : [];

  const tooltipLines = [
    `**Agent Studio** (\`${hostIdeName}\` · \`${workspaceLabel}\` · \`${mode}\` on \`:${port}\`)`,
    "",
    ...waitingLines,
    `- Active sessions: **${active.length}** (${sessions.length} in this IDE & workspace)`,
    `- Sprint \`${sprint}\`: **${openItemsCount}** open item(s), **${openBugsCount}** open bug(s)`,
    "",
    `_Click to open Agent Studio_`,
  ];

  return {
    text,
    isWarning: waitingCount > 0,
    tooltipLines,
    waitingCount,
    activeCount: active.length,
  };
}

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly serverManager: ServerManager) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "agentStudio.openStudio";
    this.item.text = "$(radio-tower) Agent Studio";
    this.item.tooltip = "Open Agent Studio";
    this.item.show();

    this.disposables.push(
      this.serverManager.onStatusChanged(() => {
        void this.poll();
      }),
    );

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, 8000);
    void this.poll();
  }

  public async poll(): Promise<void> {
    const status = this.serverManager.getStatus();
    const healthy = await this.serverManager.checkHealth(
      status.online ? status.localBaseUrl : this.serverManager.getLocalBaseUrl(),
      1200,
    );

    if (!healthy && !status.online) {
      this.item.text = "$(warning) Agent Studio (offline)";
      this.item.backgroundColor = undefined;
      this.item.tooltip = new vscode.MarkdownString(
        `**Agent Studio** is offline on port \`${status.port}\`.\n\nClick to start and open the Studio.`,
      );
      return;
    }

    const projectId = this.serverManager.detectWorkspaceProjectId();
    const hostIdeName = this.serverManager.getHostIdeDisplayName();
    const workspaceLabel = this.serverManager.getWorkspaceLabel();
    const sessionsQuery = this.serverManager.buildScopedSessionsQuery(25);
    const [sessionsData, boardData] = await Promise.all([
      this.serverManager.fetchJson<SessionsApiResponse>(
        `/api/sessions${sessionsQuery}`,
      ),
      this.serverManager.fetchJson<BoardApiResponse>(
        `/api/board${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`,
      ),
    ]);

    const sessions = sessionsData?.sessions ?? [];
    const items = boardData?.board?.items ?? [];
    const openItems = items.filter((i) => i.state !== "done");
    const openBugs = openItems.filter((i) => i.type === "bug");
    const sprint = boardData?.board?.active_sprint ?? "—";

    const presentation = buildStatusBarPresentation({
      sessions,
      openItemsCount: openItems.length,
      openBugsCount: openBugs.length,
      sprint,
      hostIdeName,
      workspaceLabel,
      mode: status.mode,
      port: status.port,
    });

    this.item.text = presentation.text;
    this.item.backgroundColor = presentation.isWarning
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    this.item.tooltip = new vscode.MarkdownString(
      presentation.tooltipLines.join("\n"),
    );
  }

  public dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.item.dispose();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}
