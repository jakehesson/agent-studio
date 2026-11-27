import fs from "node:fs";
import * as vscode from "vscode";
import {
  getDefaultAllowedRoots,
  resolveAllowedFileUri,
} from "./fileLinkBridge";
import {
  handleFeedbackStatusRequest,
  handleSubmitFeedback,
  validateFeedbackExternalUrl,
  type VscodeAuthLike,
} from "./feedback";
import {
  appendDeepLinkParams,
  isSessionWaitingForHuman,
  type StudioView,
} from "./scoping";
import type { ServerManager } from "./serverManager";

export type StudioViewName = StudioView;

export interface StudioPanelOpenOptions {
  sessionId?: string;
  openWaiting?: boolean;
}

export const REPLY_MAX_TEXT_BYTES = 32 * 1024;

export type ReplyToAgentMode =
  | "prefilled"
  | "focused_copied"
  | "copied"
  | "error";

export interface ReplyToAgentResult {
  type: "agentStudio:replyResult";
  requestId: string;
  ok: boolean;
  mode: ReplyToAgentMode;
  message: string;
}

export interface ReplyBridgeDeps {
  writeClipboard(text: string): Promise<void>;
  getCommands(filterInternal?: boolean): Promise<string[]>;
  executeCommand(command: string, ...rest: unknown[]): Promise<unknown>;
}

export function validateReplyToAgentMessage(
  raw: unknown,
):
  | { ok: true; requestId: string; text: string; blockingToolCall: boolean }
  | { ok: false; requestId: string; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, requestId: "", reason: "Invalid reply payload." };
  }
  const obj = raw as Record<string, unknown>;
  const rawReqId = obj.requestId;
  const requestId =
    typeof rawReqId === "string" && rawReqId.trim().length > 0 && rawReqId.length <= 256
      ? rawReqId.trim()
      : "";
  if (!requestId) {
    return { ok: false, requestId: "", reason: "Missing or invalid requestId." };
  }
  if (typeof obj.text !== "string") {
    return { ok: false, requestId, reason: "Reply text must be a string." };
  }
  if (obj.text.trim().length === 0) {
    return { ok: false, requestId, reason: "Reply text cannot be empty." };
  }
  if (Buffer.byteLength(obj.text, "utf8") > REPLY_MAX_TEXT_BYTES) {
    return {
      ok: false,
      requestId,
      reason: `Reply text exceeds maximum size (${REPLY_MAX_TEXT_BYTES} bytes).`,
    };
  }
  if (typeof obj.blockingToolCall !== "boolean") {
    return {
      ok: false,
      requestId,
      reason: "blockingToolCall must be a boolean.",
    };
  }
  return {
    ok: true,
    requestId,
    text: obj.text,
    blockingToolCall: obj.blockingToolCall,
  };
}

export async function handleReplyToAgent(
  raw: unknown,
  deps: ReplyBridgeDeps,
): Promise<ReplyToAgentResult> {
  const checked = validateReplyToAgentMessage(raw);
  if (!checked.ok) {
    return {
      type: "agentStudio:replyResult",
      requestId: checked.requestId,
      ok: false,
      mode: "error",
      message: checked.reason,
    };
  }

  const { requestId, text, blockingToolCall } = checked;
  let clipboardCopied = false;
  try {
    await deps.writeClipboard(text);
    clipboardCopied = true;
  } catch {
    clipboardCopied = false;
  }

  let chatCommandAvailable = true;
  try {
    const commands = await deps.getCommands(true);
    if (Array.isArray(commands)) {
      chatCommandAvailable = commands.includes("workbench.action.chat.open");
    }
  } catch {
    chatCommandAvailable = true;
  }

  if (!blockingToolCall) {
    if (chatCommandAvailable) {
      try {
        await deps.executeCommand("workbench.action.chat.open", {
          query: text,
          isPartialQuery: true,
        });
        return {
          type: "agentStudio:replyResult",
          requestId,
          ok: true,
          mode: "prefilled",
          message: clipboardCopied
            ? "Prefilled IDE chat input (and copied to clipboard) — review and press Enter to send."
            : "Prefilled IDE chat input — review and press Enter to send.",
        };
      } catch {
        // Fall through to clipboard fallback
      }
    }
    if (clipboardCopied) {
      return {
        type: "agentStudio:replyResult",
        requestId,
        ok: true,
        mode: "copied",
        message:
          "Copied answer to clipboard — paste or select in the active IDE prompt.",
      };
    }
    return {
      type: "agentStudio:replyResult",
      requestId,
      ok: false,
      mode: "error",
      message: "Unable to prefill IDE chat or copy reply to clipboard.",
    };
  }

  if (chatCommandAvailable) {
    try {
      await deps.executeCommand("workbench.action.chat.open");
      return {
        type: "agentStudio:replyResult",
        requestId,
        ok: true,
        mode: "focused_copied",
        message: clipboardCopied
          ? "Copied answer & focused IDE chat — select/paste in the active prompt to confirm."
          : "Focused IDE chat — select/paste in the active prompt to confirm.",
      };
    } catch {
      // Fall through to clipboard fallback
    }
  }

  if (clipboardCopied) {
    return {
      type: "agentStudio:replyResult",
      requestId,
      ok: true,
      mode: "copied",
      message:
        "Copied answer to clipboard — paste or select in the active IDE prompt.",
    };
  }

  return {
    type: "agentStudio:replyResult",
    requestId,
    ok: false,
    mode: "error",
    message: "Unable to focus IDE chat or copy reply to clipboard.",
  };
}

export interface SidebarSessionItem {
  sessionId: string;
  ide?: string;
  projectId?: string;
  title?: string;
  status?: string;
  isMultiAgent?: boolean;
  waitingOn?: string | null;
  pendingQuestionCount?: number;
  waitingSummary?: string;
}

interface SessionsApiResponse {
  sessions?: SidebarSessionItem[];
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

interface SharedWebviewMessage {
  type?: string;
  uri?: string;
  startLine?: number;
  endLine?: number;
  requestId?: unknown;
  payload?: unknown;
  url?: unknown;
  text?: unknown;
  blockingToolCall?: unknown;
}

async function handleOpenFileMessage(msg: {
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

async function handleSharedWebviewMessage(
  msg: SharedWebviewMessage,
  panel: vscode.WebviewPanel,
): Promise<boolean> {
  if (msg?.type === "openExternal") {
    await vscode.commands.executeCommand("agentStudio.openInBrowser");
    return true;
  }
  if (msg?.type === "openFile" && typeof msg.uri === "string") {
    await handleOpenFileMessage({
      uri: msg.uri,
      startLine: msg.startLine,
      endLine: msg.endLine,
    });
    return true;
  }
  if (msg?.type === "agentStudio:feedbackStatusRequest") {
    const auth = (
      vscode as unknown as { authentication?: VscodeAuthLike }
    ).authentication;
    const reply = await handleFeedbackStatusRequest(msg.requestId, auth);
    void panel.webview.postMessage(reply);
    return true;
  }
  if (msg?.type === "agentStudio:submitFeedback") {
    const auth = (
      vscode as unknown as { authentication?: VscodeAuthLike }
    ).authentication;
    const extVersion = vscode.extensions.getExtension(
      "agent-studio.agent-studio-vscode",
    )?.packageJSON?.version;
    const reply = await handleSubmitFeedback(msg.requestId, msg.payload, {
      auth,
      appVersion: typeof extVersion === "string" ? extVersion : undefined,
    });
    void panel.webview.postMessage(reply);
    return true;
  }
  if (msg?.type === "agentStudio:openFeedbackUrl") {
    const checked = validateFeedbackExternalUrl(msg.url);
    if (!checked.ok) {
      void vscode.window.showWarningMessage(
        `Blocked unsafe feedback URL: ${checked.reason}`,
      );
      return true;
    }
    await vscode.env.openExternal(vscode.Uri.parse(checked.url));
    return true;
  }
  if (msg?.type === "agentStudio:replyToAgent") {
    const reply = await handleReplyToAgent(msg, {
      writeClipboard: async (text) => {
        await vscode.env.clipboard.writeText(text);
      },
      getCommands: async (filterInternal) =>
        await vscode.commands.getCommands(filterInternal),
      executeCommand: async (command, ...args) =>
        await vscode.commands.executeCommand(command, ...args),
    });
    void panel.webview.postMessage(reply);
    return true;
  }
  return false;
}

async function resolveExternalPanelUrl(rawTargetUrl: string): Promise<{
  resolvedUrl: string;
  expectedOrigin: string;
}> {
  let resolvedUrl = rawTargetUrl;
  try {
    const external = await vscode.env.asExternalUri(
      vscode.Uri.parse(rawTargetUrl),
    );
    resolvedUrl = external.toString(true);
  } catch {
    resolvedUrl = rawTargetUrl;
  }

  let expectedOrigin = "";
  try {
    expectedOrigin = new URL(resolvedUrl).origin;
  } catch {
    expectedOrigin = "";
  }
  return { resolvedUrl, expectedOrigin };
}

function renderEmbeddedIframeHtml(opts: {
  title: string;
  resolvedUrl: string;
  expectedOrigin: string;
  online: boolean;
}): string {
  const nonce = getNonce();
  const safeUrl = escapeHtml(opts.resolvedUrl);
  const safeTitle = escapeHtml(opts.title);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src http://127.0.0.1:* http://localhost:* https:;" />
  <title>${safeTitle}</title>
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
      <div class="title" id="statusTitle">${opts.online ? "Connecting to Agent Studio..." : "Agent Studio server is offline"}</div>
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
      title="${safeTitle}"
    ></iframe>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById("studioFrame");
    const overlay = document.getElementById("overlay");
    const statusTitle = document.getElementById("statusTitle");
    const spinner = document.getElementById("spinner");
    let loaded = false;
    let pendingFocusMessage = null;

    frame.addEventListener("load", () => {
      loaded = true;
      overlay.classList.add("hidden");
      if (pendingFocusMessage && expectedOrigin && frame.contentWindow) {
        frame.contentWindow.postMessage(pendingFocusMessage, expectedOrigin);
        pendingFocusMessage = null;
      }
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

    const expectedOrigin = ${JSON.stringify(opts.expectedOrigin)};
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (event.source !== frame.contentWindow) {
        if (
          event.origin === window.location.origin &&
          expectedOrigin &&
          frame.contentWindow &&
          (data.type === "agentStudio:feedbackStatus" ||
            data.type === "agentStudio:submitFeedbackResult" ||
            data.type === "agentStudio:feedbackSubmitResult" ||
            data.type === "agentStudio:focusSession" ||
            data.type === "agentStudio:replyResult")
        ) {
          if (data.type === "agentStudio:focusSession" && !loaded) {
            pendingFocusMessage = data;
          } else {
            frame.contentWindow.postMessage(data, expectedOrigin);
          }
        }
        return;
      }
      if (!expectedOrigin || event.origin !== expectedOrigin) return;
      if ((data.type === "agentStudio.openFile" || data.type === "agentStudio:openFile") && typeof data.uri === "string") {
        vscode.postMessage({
          type: "openFile",
          uri: data.uri,
          startLine: typeof data.startLine === "number" ? data.startLine : undefined,
          endLine: typeof data.endLine === "number" ? data.endLine : undefined,
        });
      } else if (data.type === "agentStudio:feedbackStatusRequest") {
        vscode.postMessage({
          type: "agentStudio:feedbackStatusRequest",
          requestId: typeof data.requestId === "string" ? data.requestId : "",
        });
      } else if (data.type === "agentStudio:submitFeedback") {
        vscode.postMessage({
          type: "agentStudio:submitFeedback",
          requestId: typeof data.requestId === "string" ? data.requestId : "",
          payload: data.payload,
        });
      } else if (data.type === "agentStudio:openFeedbackUrl" && typeof data.url === "string") {
        vscode.postMessage({
          type: "agentStudio:openFeedbackUrl",
          url: data.url,
        });
      } else if (data.type === "agentStudio:replyToAgent") {
        vscode.postMessage({
          type: "agentStudio:replyToAgent",
          requestId: typeof data.requestId === "string" ? data.requestId : "",
          text: typeof data.text === "string" && data.text.length <= 65536 ? data.text : "",
          blockingToolCall: typeof data.blockingToolCall === "boolean" ? data.blockingToolCall : null,
        });
      }
    });
  </script>
</body>
</html>`;
}

export class StudioPanel {
  public static currentPanel: StudioPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private currentView: StudioViewName = "studio";
  private currentSessionId: string | undefined;
  private currentResolvedUrl = "";
  private currentOnline = false;
  private isDisposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly serverManager: ServerManager,
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (msg: SharedWebviewMessage) => {
        if (this.isDisposed) return;
        if (msg?.type === "retry") {
          await this.serverManager.ensureRunning(true);
          await this.render(this.currentView, this.currentSessionId, { force: true });
          return;
        }
        await handleSharedWebviewMessage(msg, this.panel);
      },
      null,
      this.disposables,
    );
  }

  public static async createOrShow(
    serverManager: ServerManager,
    view: StudioViewName = "studio",
    sessionIdOrOptions?: string | StudioPanelOpenOptions,
  ): Promise<void> {
    await serverManager.ensureRunning(true);

    const openOptions: StudioPanelOpenOptions =
      typeof sessionIdOrOptions === "string"
        ? { sessionId: sessionIdOrOptions }
        : sessionIdOrOptions ?? {};

    if (StudioPanel.currentPanel) {
      const current = StudioPanel.currentPanel;
      current.panel.reveal(vscode.ViewColumn.One);
      const status = serverManager.getStatus();
      const hasFocusTarget =
        openOptions.sessionId !== undefined ||
        openOptions.openWaiting !== undefined;
      if (
        hasFocusTarget &&
        current.currentResolvedUrl &&
        view === current.currentView &&
        status.online === current.currentOnline
      ) {
        await current.postFocusSession(openOptions);
        return;
      }
      await current.render(view, openOptions);
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
    await instance.render(view, openOptions);
  }

  public async postFocusSession(opts: StudioPanelOpenOptions): Promise<void> {
    if (opts.sessionId !== undefined) {
      this.currentSessionId = opts.sessionId;
    }
    await this.panel.webview.postMessage({
      type: "agentStudio:focusSession",
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.openWaiting !== undefined ? { openWaiting: opts.openWaiting } : {}),
    });
  }

  public async render(
    view: StudioViewName,
    sessionIdOrOptions?: string | (StudioPanelOpenOptions & { force?: boolean }),
    opts?: { force?: boolean },
  ): Promise<void> {
    const openOpts: StudioPanelOpenOptions & { force?: boolean } =
      typeof sessionIdOrOptions === "string"
        ? { sessionId: sessionIdOrOptions }
        : sessionIdOrOptions ?? {};

    const effectiveSessionId =
      openOpts.sessionId !== undefined
        ? openOpts.sessionId
        : view === this.currentView
          ? this.currentSessionId
          : undefined;

    const status = this.serverManager.getStatus();
    const baseTargetUrl = this.serverManager.buildViewUrl(
      status.online ? status.localBaseUrl : status.browserBaseUrl,
      view,
      undefined,
      { embed: true, sessionId: effectiveSessionId },
    );
    const rawTargetUrl = appendDeepLinkParams(baseTargetUrl, {
      openWaiting: openOpts.openWaiting,
    });

    const { resolvedUrl, expectedOrigin } =
      await resolveExternalPanelUrl(rawTargetUrl);
    if (this.isDisposed) return;

    if (
      !opts?.force &&
      !openOpts.force &&
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

    this.panel.webview.html = renderEmbeddedIframeHtml({
      title: "Agent Studio",
      resolvedUrl,
      expectedOrigin,
      online: status.online,
    });
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (StudioPanel.currentPanel === this) {
      StudioPanel.currentPanel = undefined;
    }
    this.panel.dispose();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}

export function renderSidebarSessionsHtml(
  sessions: SidebarSessionItem[],
  limit = 4,
): string {
  if (sessions.length === 0) {
    return `<div class="muted">No recent sessions detected yet.</div>`;
  }

  const ordered = [...sessions].sort((a, b) => {
    const aWait = isSessionWaitingForHuman(a) ? 0 : 1;
    const bWait = isSessionWaitingForHuman(b) ? 0 : 1;
    return aWait - bWait;
  });

  return ordered
    .slice(0, limit)
    .map((s) => {
      const isWaiting = isSessionWaitingForHuman(s);
      const st = (s.status ?? "IDLE").toUpperCase();
      const dotClass = isWaiting
        ? "waiting"
        : st === "THINKING"
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
      const rawSummary =
        isWaiting && typeof s.waitingSummary === "string"
          ? s.waitingSummary.trim()
          : "";
      const summaryHtml = rawSummary
        ? `<span class="session-sub">${escapeHtml(rawSummary)}</span>`
        : "";
      const pendingCount =
        typeof s.pendingQuestionCount === "number" && s.pendingQuestionCount > 0
          ? s.pendingQuestionCount
          : 0;
      const waitingBadgeText =
        pendingCount > 1 ? `Needs Input (${pendingCount})` : "Needs Input";
      const titleAttr = escapeHtml(
        rawSummary ? `${s.sessionId} — ${rawSummary}` : s.sessionId,
      );

      return `<button class="session-row${isWaiting ? " waiting" : ""}" data-cmd="agentStudio.openStudio" data-session-id="${escapeHtml(s.sessionId)}"${isWaiting ? ' data-open-waiting="1"' : ""} title="${titleAttr}">
                <span class="dot ${dotClass}"></span>
                <span class="session-main">
                  <span class="session-top">
                    <span class="session-name">${label}</span>
                    ${isWaiting ? `<span class="waiting-badge">${waitingBadgeText}</span>` : ""}
                    <span class="pill">${ide}</span>
                  </span>
                  ${summaryHtml}
                </span>
              </button>`;
    })
    .join("");
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
      async (msg: {
        command?: string;
        sessionId?: string;
        openWaiting?: boolean;
      }) => {
        if (!msg?.command) return;
        if (msg.command === "refresh") {
          await this.serverManager.ensureRunning(false);
          await this.refresh();
          return;
        }
        if (msg.sessionId) {
          if (msg.openWaiting) {
            await vscode.commands.executeCommand(msg.command, {
              sessionId: msg.sessionId,
              openWaiting: true,
            });
          } else {
            await vscode.commands.executeCommand(msg.command, msg.sessionId);
          }
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
    const activeSessions = sessions.filter(
      (s) =>
        ["THINKING", "WORKING", "WAITING", "BLOCKED"].includes(
          (s.status ?? "").toUpperCase(),
        ) || isSessionWaitingForHuman(s),
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
    const topSessionsHtml = renderSidebarSessionsHtml(sessions, 4);

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
    .dot.working { background: #3b82f6; }
    .dot.waiting {
      background: #f59e0b;
      box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.28);
      animation: pulse-waiting 1.6s ease-in-out infinite;
    }
    body.vscode-light .dot.waiting,
    body.vscode-high-contrast-light .dot.waiting {
      background: #b45309;
      box-shadow: 0 0 0 2px rgba(180, 83, 9, 0.22);
    }
    @keyframes pulse-waiting {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.22); opacity: 0.72; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dot.waiting { animation: none; }
    }
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
    .session-row.waiting {
      border: 1px solid rgba(245, 158, 11, 0.45);
      background: rgba(245, 158, 11, 0.08);
    }
    body.vscode-light .session-row.waiting,
    body.vscode-high-contrast-light .session-row.waiting {
      border-color: rgba(180, 83, 9, 0.45);
      background: rgba(254, 243, 199, 0.55);
    }
    .session-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .session-top {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .session-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-sub {
      font-size: 10px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .waiting-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 999px;
      background: rgba(217, 119, 6, 0.28);
      color: #fef3c7;
      border: 1px solid rgba(245, 158, 11, 0.55);
      flex: 0 0 auto;
    }
    body.vscode-light .waiting-badge,
    body.vscode-high-contrast-light .waiting-badge {
      color: #78350f;
      background: #fef3c7;
      border-color: #b45309;
    }
    @media (forced-colors: active) {
      .dot.waiting { border: 1px solid CanvasText; }
      .waiting-badge {
        border: 1px solid CanvasText;
        color: CanvasText;
        background: Canvas;
      }
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
        const openWaiting = el.getAttribute("data-open-waiting") === "1";
        if (cmd) {
          vscode.postMessage({
            command: cmd,
            ...(sessionId ? { sessionId } : {}),
            ...(openWaiting ? { openWaiting: true } : {}),
          });
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
