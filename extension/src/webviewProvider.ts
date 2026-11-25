import fs from "node:fs";
import * as vscode from "vscode";
import {
  getDefaultAllowedRoots,
  resolveAllowedFileUri,
} from "./fileLinkBridge";
import type { ServerManager } from "./serverManager";

export type StudioViewName = "studio" | "board" | "team" | "mockups" | "doctor";

interface SessionsApiResponse {
  sessions?: Array<{
    sessionId: string;
    ide?: string;
    projectId?: string;
    title?: string;
    status?: string;
    isMultiAgent?: boolean;
  }>;
}

interface BoardApiResponse {
  project?: { id: string; title: string };
  board?: {
    active_sprint?: string;
    items?: Array<{
      id: string;
      type?: string;
      state?: string;
      severity?: string;
    }>;
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 24; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

export class StudioPanel {
  public static currentPanel: StudioPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private currentView: StudioViewName = "studio";
  private currentSessionId: string | undefined;
  private currentResolvedUrl = "";
  private currentOnline = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly serverManager: ServerManager,
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (msg: {
        type?: string;
        uri?: string;
        startLine?: number;
        endLine?: number;
      }) => {
        if (msg?.type === "retry") {
          await this.serverManager.ensureRunning(true);
          await this.render(this.currentView, this.currentSessionId, { force: true });
        } else if (msg?.type === "openExternal") {
          await vscode.commands.executeCommand("agentStudio.openInBrowser");
        } else if (msg?.type === "openFile" && typeof msg.uri === "string") {
          await this.handleOpenFileMessage({
            uri: msg.uri,
            startLine: msg.startLine,
            endLine: msg.endLine,
          });
        }
      },
      null,
      this.disposables,
    );
  }

  private async handleOpenFileMessage(msg: {
    uri: string;
    startLine?: number;
    endLine?: number;
  }): Promise<void> {
    const allowedRoots = getDefaultAllowedRoots(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    );
    const resolved = resolveAllowedFileUri(msg.uri, allowedRoots, {
      startLine: msg.startLine,
      endLine: msg.endLine,
    });
    if (!resolved.ok) {
      void vscode.window.showWarningMessage(resolved.reason);
      return;
    }

    try {
      const st = await fs.promises.stat(resolved.fsPath);
      if (!st.isFile()) {
        void vscode.window.showWarningMessage(
          `Cannot open path (not a file): ${resolved.fsPath}`,
        );
        return;
      }
    } catch {
      void vscode.window.showWarningMessage(
        `File not found: ${resolved.fsPath}`,
      );
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(resolved.fsPath),
      );
      let selection: vscode.Range | undefined;
      if (resolved.startLine !== undefined) {
        const maxLine = Math.max(0, doc.lineCount - 1);
        const start = Math.min(Math.max(0, resolved.startLine - 1), maxLine);
        const end =
          resolved.endLine !== undefined
            ? Math.min(Math.max(start, resolved.endLine - 1), maxLine)
            : start;
        const endChar =
          resolved.endLine !== undefined && end > start
            ? doc.lineAt(end).text.length
            : 0;
        selection = new vscode.Range(start, 0, end, endChar);
      }
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        ...(selection ? { selection } : {}),
      });
    } catch (err) {
      void vscode.window.showWarningMessage(
        `Failed to open file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public static async createOrShow(
    serverManager: ServerManager,
    view: StudioViewName = "studio",
    sessionId?: string,
  ): Promise<void> {
    await serverManager.ensureRunning(true);

    if (StudioPanel.currentPanel) {
      StudioPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      await StudioPanel.currentPanel.render(view, sessionId);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "agentStudio.panel",
      "Agent Studio",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    const instance = new StudioPanel(panel, serverManager);
    StudioPanel.currentPanel = instance;
    await instance.render(view, sessionId);
  }

  public async render(
    view: StudioViewName,
    sessionId?: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    const effectiveSessionId =
      sessionId !== undefined
        ? sessionId
        : view === this.currentView
          ? this.currentSessionId
          : undefined;

    const status = this.serverManager.getStatus();
    const rawTargetUrl = this.serverManager.buildViewUrl(
      status.online ? status.localBaseUrl : status.browserBaseUrl,
      view,
      undefined,
      { embed: true, sessionId: effectiveSessionId },
    );

    let resolvedUrl = rawTargetUrl;
    try {
      const external = await vscode.env.asExternalUri(
        vscode.Uri.parse(rawTargetUrl),
      );
      resolvedUrl = external.toString(true);
    } catch {
      resolvedUrl = rawTargetUrl;
    }

    if (
      !opts?.force &&
      this.currentResolvedUrl &&
      view === this.currentView &&
      resolvedUrl === this.currentResolvedUrl &&
      status.online === this.currentOnline
    ) {
      return;
    }

    this.currentView = view;
    this.currentSessionId = effectiveSessionId;
    this.currentResolvedUrl = resolvedUrl;
    this.currentOnline = status.online;

    const nonce = getNonce();
    const safeUrl = escapeHtml(resolvedUrl);
    let expectedOrigin = "";
    try {
      expectedOrigin = new URL(resolvedUrl).origin;
    } catch {
      expectedOrigin = "";
    }

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src http://127.0.0.1:* http://localhost:* https:;" />
  <title>Agent Studio</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #0b1020;
      color: #e2e8f0;
      font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
    }
    .frame-host {
      position: relative;
      width: 100%;
      height: 100%;
    }
    iframe {
      border: 0;
      width: 100%;
      height: 100%;
      display: block;
      background: #0b1020;
    }
    .overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: rgba(11, 16, 32, 0.94);
      padding: 24px;
      text-align: center;
      z-index: 10;
      transition: opacity 0.2s ease;
    }
    .overlay.hidden {
      opacity: 0;
      pointer-events: none;
    }
    .spinner {
      width: 28px;
      height: 28px;
      border: 3px solid rgba(148, 163, 184, 0.25);
      border-top-color: #a855f7;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .title { font-size: 14px; font-weight: 600; color: #f8fafc; }
    .sub { font-size: 12px; color: #94a3b8; max-width: 440px; word-break: break-all; }
    .actions { display: flex; gap: 8px; margin-top: 6px; }
    button {
      background: #1e293b;
      color: #f8fafc;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    button.primary {
      background: #7c3aed;
      border-color: #8b5cf6;
    }
    button:hover { filter: brightness(1.1); }
  </style>
</head>
<body>
  <div class="frame-host">
    <div id="overlay" class="overlay">
      <div class="spinner" id="spinner"></div>
      <div class="title" id="statusTitle">${status.online ? "Connecting to Agent Studio..." : "Agent Studio server is offline"}</div>
      <div class="sub">${safeUrl}</div>
      <div class="actions">
        <button class="primary" id="retryBtn">Retry Connection</button>
        <button id="browserBtn">Open in Browser</button>
      </div>
    </div>
    <iframe
      id="studioFrame"
      src="${safeUrl}"
      allow="clipboard-read; clipboard-write"
      title="Agent Studio"
    ></iframe>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById("studioFrame");
    const overlay = document.getElementById("overlay");
    const statusTitle = document.getElementById("statusTitle");
    const spinner = document.getElementById("spinner");
    let loaded = false;

    frame.addEventListener("load", () => {
      loaded = true;
      overlay.classList.add("hidden");
    });

    setTimeout(() => {
      if (!loaded) {
        spinner.style.display = "none";
        statusTitle.textContent = "Unable to load Agent Studio iframe — check server or open in browser.";
      }
    }, 5000);

    document.getElementById("retryBtn").addEventListener("click", () => {
      vscode.postMessage({ type: "retry" });
    });
    document.getElementById("browserBtn").addEventListener("click", () => {
      vscode.postMessage({ type: "openExternal" });
    });

    const expectedOrigin = ${JSON.stringify(expectedOrigin)};
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow) return;
      if (!expectedOrigin || event.origin !== expectedOrigin) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "agentStudio.openFile" && typeof data.uri === "string") {
        vscode.postMessage({
          type: "openFile",
          uri: data.uri,
          startLine: typeof data.startLine === "number" ? data.startLine : undefined,
          endLine: typeof data.endLine === "number" ? data.endLine : undefined,
        });
      }
    });
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    StudioPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}

export class StudioSidebarProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "agentStudio.sidebar";
  private view: vscode.WebviewView | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly serverManager: ServerManager) {
    this.disposables.push(
      this.serverManager.onStatusChanged(() => {
        void this.refresh();
      }),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(
      async (msg: { command?: string; sessionId?: string }) => {
        if (!msg?.command) return;
        if (msg.command === "refresh") {
          await this.serverManager.ensureRunning(false);
          await this.refresh();
          return;
        }
        if (msg.sessionId) {
          await vscode.commands.executeCommand(msg.command, msg.sessionId);
        } else {
          await vscode.commands.executeCommand(msg.command);
        }
      },
      null,
      this.disposables,
    );

    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this.startPolling();
          void this.refresh();
        } else {
          this.stopPolling();
        }
      },
      null,
      this.disposables,
    );

    webviewView.onDidDispose(
      () => {
        this.stopPolling();
        this.view = undefined;
      },
      null,
      this.disposables,
    );

    this.startPolling();
    void this.refresh();
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, 10_000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  public async refresh(): Promise<void> {
    if (!this.view) return;
    const status = this.serverManager.getStatus();
    const projectId = this.serverManager.detectWorkspaceProjectId();
    const hostIdeName = this.serverManager.getHostIdeDisplayName();
    const workspaceLabel = this.serverManager.getWorkspaceLabel();
    const sessionsQuery = this.serverManager.buildScopedSessionsQuery(15);

    const [sessionsData, boardData] = status.online
      ? await Promise.all([
          this.serverManager.fetchJson<SessionsApiResponse>(
            `/api/sessions${sessionsQuery}`,
          ),
          this.serverManager.fetchJson<BoardApiResponse>(
            `/api/board${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`,
          ),
        ])
      : [null, null];

    const sessions = sessionsData?.sessions ?? [];
    const activeSessions = sessions.filter((s) =>
      ["THINKING", "WORKING", "WAITING", "BLOCKED"].includes(
        (s.status ?? "").toUpperCase(),
      ),
    );
    const items = boardData?.board?.items ?? [];
    const openItems = items.filter((i) => i.state !== "done");
    const openBugs = openItems.filter((i) => i.type === "bug");
    const activeSprint = boardData?.board?.active_sprint ?? "—";
    const boardTitle = boardData?.project?.title ?? projectId ?? "No board loaded";

    const modeLabel =
      status.mode === "external"
        ? `Online (External :${status.port})`
        : status.mode === "managed"
          ? `Online (Managed :${status.port})`
          : "Offline";

    const nonce = getNonce();
    const topSessionsHtml =
      sessions.slice(0, 4).length > 0
        ? sessions
            .slice(0, 4)
            .map((s) => {
              const st = (s.status ?? "IDLE").toUpperCase();
              const dotClass =
                st === "THINKING"
                  ? "thinking"
                  : st === "WORKING"
                    ? "working"
                    : st === "BLOCKED"
                      ? "blocked"
                      : st === "DONE"
                        ? "done"
                        : "idle";
              const label = escapeHtml(s.title || s.sessionId.slice(0, 8));
              const ide = escapeHtml(s.ide || "ide");
              return `<button class="session-row" data-cmd="agentStudio.openStudio" data-session-id="${escapeHtml(s.sessionId)}" title="${escapeHtml(s.sessionId)}">
                <span class="dot ${dotClass}"></span>
                <span class="session-name">${label}</span>
                <span class="pill">${ide}</span>
              </button>`;
            })
            .join("")
        : `<div class="muted">No recent sessions detected yet.</div>`;

    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: 12px;
      line-height: 1.45;
    }
    .section {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.22));
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 10px;
      background: var(--vscode-editor-background, rgba(0,0,0,0.12));
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .heading {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.75;
      margin: 0 0 8px 0;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      font-size: 12px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      flex: 0 0 auto;
    }
    .dot.online, .dot.done { background: #22c55e; }
    .dot.offline, .dot.blocked { background: #ef4444; }
    .dot.thinking { background: #a855f7; }
    .dot.working { background: #f59e0b; }
    .dot.idle { background: #64748b; }
    .kpis {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      margin-top: 6px;
    }
    .kpi {
      border-radius: 4px;
      padding: 6px;
      background: var(--vscode-sideBar-background);
      text-align: center;
    }
    .kpi-val { font-size: 15px; font-weight: 700; }
    .kpi-lbl { font-size: 10px; opacity: 0.72; }
    .btn-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 6px;
    }
    button.action {
      width: 100%;
      text-align: left;
      padding: 7px 10px;
      border-radius: 5px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.18));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
    }
    button.action.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.action:hover { opacity: 0.92; }
    button.icon-btn {
      background: transparent;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      color: var(--vscode-foreground);
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 11px;
      cursor: pointer;
    }
    .session-row {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 6px;
      margin-bottom: 4px;
      border: 0;
      border-radius: 4px;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      cursor: pointer;
      text-align: left;
      font-size: 11px;
    }
    .session-row:hover { filter: brightness(1.1); }
    .session-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pill {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 999px;
      background: rgba(128, 128, 128, 0.2);
      flex: 0 0 auto;
    }
    .muted { opacity: 0.7; font-size: 11px; }
  </style>
</head>
<body>
  <div class="section">
    <div class="row" style="margin-bottom: 6px;">
      <span class="pill" title="Scoped to current Host IDE &amp; Workspace">${escapeHtml(hostIdeName)} · ${escapeHtml(workspaceLabel)}</span>
      <button class="icon-btn" data-cmd="refresh">Refresh</button>
    </div>
    <div class="row">
      <div class="status-badge">
        <span class="dot ${status.online ? "online" : "offline"}"></span>
        <span>${escapeHtml(modeLabel)}</span>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="kpi-val">${activeSessions.length}</div><div class="kpi-lbl">Active</div></div>
      <div class="kpi"><div class="kpi-val">${openItems.length}</div><div class="kpi-lbl">Open Items</div></div>
      <div class="kpi"><div class="kpi-val">${openBugs.length}</div><div class="kpi-lbl">Bugs</div></div>
    </div>
  </div>

  <div class="section">
    <div class="heading">Quick Views</div>
    <div class="btn-grid">
      <button class="action primary" data-cmd="agentStudio.openStudio">Open Full Studio</button>
      <button class="action" data-cmd="agentStudio.openBoard">Agile Board (${escapeHtml(activeSprint)} · ${escapeHtml(boardTitle)})</button>
      <button class="action" data-cmd="agentStudio.openTeam">Agent Team</button>
      <button class="action" data-cmd="agentStudio.openDoctor">Doctor &amp; Guides</button>
      <button class="action" data-cmd="agentStudio.openInBrowser">Open in Browser</button>
    </div>
  </div>

  <div class="section">
    <div class="heading">Recent Sessions (${sessions.length})</div>
    ${topSessionsHtml}
  </div>

  <div class="section">
    <div class="heading">Workspace Tooling</div>
    <div class="btn-grid">
      <button class="action" data-cmd="agentStudio.initWorkspace">Onboard Workspace (Init &amp; Sync)</button>
      <button class="action" data-cmd="agentStudio.syncWorkspace">Sync IDE Adapters</button>
      <button class="action" data-cmd="agentStudio.runDoctor">Run Doctor Check</button>
      <button class="action" data-cmd="agentStudio.restartServer">Restart Server</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll("[data-cmd]").forEach((el) => {
      el.addEventListener("click", () => {
        const cmd = el.getAttribute("data-cmd");
        const sessionId = el.getAttribute("data-session-id");
        if (cmd) {
          vscode.postMessage(sessionId ? { command: cmd, sessionId } : { command: cmd });
        }
      });
    });
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    this.stopPolling();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}
