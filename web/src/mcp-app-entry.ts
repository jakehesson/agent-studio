import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/studio.css";
import "./styles/views.css";
import "./styles/responsive.css";
import "./styles/mcp-app-theme.css";

import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import {
  cleanMcpArgs,
  extractMcpResultPayload,
  setMcpAppTransport,
  setMcpChatLoader,
  withMcpConcurrencySlot,
  type McpAppClientLike,
} from "./api.js";
import { AgentStudioApp, type StudioExternalDirective } from "./app.js";
import { copyTextSafe } from "./utils.js";

function extractDirective(raw: unknown): StudioExternalDirective {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const rec = raw as Record<string, unknown>;
  return {
    view: typeof rec.view === "string" ? rec.view : undefined,
    project: typeof rec.project === "string" ? rec.project : undefined,
    workspace: typeof rec.workspace === "string" ? rec.workspace : undefined,
    session: typeof rec.session === "string" ? rec.session : undefined,
    snapshot:
      rec.snapshot && typeof rec.snapshot === "object" ? rec.snapshot : undefined,
  };
}

function applyHostContext(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

async function bootMcpApp(): Promise<void> {
  const mountEl = document.getElementById("app");
  if (!mountEl) return;

  const mcpApp = new App({ name: "Agent Studio", version: "0.14.0" }, {});
  setMcpAppTransport(mcpApp as unknown as McpAppClientLike);
  setMcpChatLoader(async (params) =>
    withMcpConcurrencySlot(async () => {
      const res = await mcpApp.callServerTool({
        name: "app_get_chat",
        arguments: cleanMcpArgs({
          session: params.session,
          agent: params.agent,
          ide: params.ide && params.ide !== "all" ? params.ide : undefined,
          project: params.project,
          workspace: params.workspace,
          limit: params.limit,
          before: params.before,
        }),
      });
      return extractMcpResultPayload<unknown>(res, "app_get_chat");
    })
  );

  let studioApp: AgentStudioApp | null = null;
  let pendingDirective: StudioExternalDirective = {};

  const applyOrQueue = (next: StudioExternalDirective): void => {
    const merged: StudioExternalDirective = {
      ...pendingDirective,
      ...(next.view !== undefined ? { view: next.view } : {}),
      ...(next.project !== undefined ? { project: next.project } : {}),
      ...(next.workspace !== undefined ? { workspace: next.workspace } : {}),
      ...(next.session !== undefined ? { session: next.session } : {}),
      ...(next.snapshot !== undefined ? { snapshot: next.snapshot } : {}),
    };
    pendingDirective = merged;
    if (studioApp) {
      studioApp.applyExternalDirective(next);
    }
  };

  // CRITICAL (SEP-1865): Register ALL notification handlers BEFORE calling app.connect()
  mcpApp.ontoolinput = (params) => {
    applyOrQueue(extractDirective(params.arguments));
  };

  mcpApp.ontoolresult = (result) => {
    const fromStructured = extractDirective(result.structuredContent);
    if (
      fromStructured.view !== undefined ||
      fromStructured.project !== undefined ||
      fromStructured.workspace !== undefined ||
      fromStructured.session !== undefined ||
      fromStructured.snapshot !== undefined
    ) {
      applyOrQueue(fromStructured);
      return;
    }
    const textBlock = (result.content ?? []).find(
      (c) => c.type === "text" && typeof c.text === "string"
    );
    if (textBlock && "text" in textBlock && typeof textBlock.text === "string") {
      try {
        const parsed = JSON.parse(textBlock.text) as unknown;
        applyOrQueue(extractDirective(parsed));
      } catch {
        // Plain summary text for the model; ignore
      }
    }
  };

  mcpApp.ontoolcancelled = () => {
    studioApp?.setConnectionNotice("reconnecting");
  };

  mcpApp.onhostcontextchanged = (ctx) => {
    applyHostContext(ctx);
  };

  try {
    await mcpApp.connect();
    applyHostContext(mcpApp.getHostContext());
  } catch (err) {
    mountEl.innerHTML = `
      <div class="view-empty-wrap">
        <div class="view-empty-card">
          <h2>MCP App Handshake Failed</h2>
          <p class="muted">${String(err instanceof Error ? err.message : err)}</p>
        </div>
      </div>
    `;
    return;
  }

  studioApp = new AgentStudioApp(mountEl, {
    mcpAppMode: true,
    lockedIde: "antigravity",
    hideMockups: true,
    initialProject: pendingDirective.project,
    initialWorkspace: pendingDirective.workspace,
    initialSession: pendingDirective.session,
    initialView:
      pendingDirective.view === "team" ||
      pendingDirective.view === "board" ||
      pendingDirective.view === "doctor" ||
      pendingDirective.view === "studio"
        ? pendingDirective.view
        : "studio",
    getReplyCapabilities: () => ({
      canSendMessage: Boolean(mcpApp.getHostCapabilities()?.message),
      isMcpApp: true,
      isEmbed: false,
    }),
    onReplyToHost: async (req) => {
      const canSend = Boolean(mcpApp.getHostCapabilities()?.message) && !req.blockingToolCall;
      if (canSend) {
        try {
          const res = await mcpApp.sendMessage({
            role: "user",
            content: [{ type: "text", text: req.text }],
          });
          if (!res?.isError) {
            return {
              ok: true,
              mode: "sent",
              message: "Answer sent to chat.",
            };
          }
        } catch {
          // Fall through to clipboard fallback
        }
      }
      const copied = await copyTextSafe(req.text);
      return {
        ok: copied,
        mode: "copied",
        message: copied
          ? req.blockingToolCall
            ? "Copied answer — paste into your active IDE prompt to respond."
            : "Copied answer — paste into your chat to respond."
          : "Could not send or copy answer — please copy manually.",
      };
    },
  });

  if (pendingDirective.snapshot) {
    studioApp.applyExternalDirective({ snapshot: pendingDirective.snapshot });
  }
}

void bootMcpApp();
