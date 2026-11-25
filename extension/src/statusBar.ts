import * as vscode from "vscode";
import type { ServerManager } from "./serverManager";

interface SessionsApiResponse {
  sessions?: Array<{
    sessionId: string;
    status?: string;
    ide?: string;
  }>;
}

interface BoardApiResponse {
  board?: {
    active_sprint?: string;
    items?: Array<{ type?: string; state?: string }>;
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
    const active = sessions.filter((s) =>
      ["THINKING", "WORKING", "WAITING", "BLOCKED"].includes(
        (s.status ?? "").toUpperCase(),
      ),
    );
    const items = boardData?.board?.items ?? [];
    const openItems = items.filter((i) => i.state !== "done");
    const openBugs = openItems.filter((i) => i.type === "bug");
    const sprint = boardData?.board?.active_sprint ?? "—";

    if (active.length > 0) {
      this.item.text = `$(pulse) Agent Studio: ${active.length} active`;
    } else {
      this.item.text = `$(radio-tower) Agent Studio :${status.port}`;
    }

    const tip = new vscode.MarkdownString(
      [
        `**Agent Studio** (\`${hostIdeName}\` · \`${workspaceLabel}\` · \`${status.mode}\` on \`:${status.port}\`)`,
        "",
        `- Active sessions: **${active.length}** (${sessions.length} in this IDE & workspace)`,
        `- Sprint \`${sprint}\`: **${openItems.length}** open item(s), **${openBugs.length}** open bug(s)`,
        "",
        `_Click to open Agent Studio_`,
      ].join("\n"),
    );
    this.item.tooltip = tip;
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
