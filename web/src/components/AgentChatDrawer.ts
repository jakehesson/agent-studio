import type {
  AgentNodeSnapshot,
  ConnectionState,
  ReplyCapabilities,
  ReplyToHostRequest,
  ReplyToHostResult,
  SessionSnapshot,
  TeamDefinitionEntry,
} from "../types.js";
import { AgentChatPane, type ChatSessionContext } from "./AgentChatPane.js";

export type ChatDrawerSessionContext = ChatSessionContext;

export interface AgentChatDrawerOptions {
  embedMode?: boolean;
  mcpAppMode?: boolean;
  getSessionContext: () => ChatDrawerSessionContext;
  getReplyCapabilities: () => ReplyCapabilities;
  onReplyToHost: (req: ReplyToHostRequest) => Promise<ReplyToHostResult>;
  onCancelPrompt?: (promptId: string, reason?: string) => Promise<ReplyToHostResult>;
  onOpenInspector?: (agentId: string) => void;
  onSwitchAgent?: (agentId: string) => void;
}

export interface OpenAgentChatParams {
  agent: AgentNodeSnapshot;
  labelMap?: Map<string, string>;
  definition?: TeamDefinitionEntry;
  focusQuestion?: boolean;
}

export class AgentChatDrawer {
  private dialog: HTMLDialogElement;
  private pane: AgentChatPane;
  private isOpen = false;
  private isWide = false;
  private lastInvokerEl: HTMLElement | null = null;

  constructor(opts: AgentChatDrawerOptions) {
    const dlg = document.createElement("dialog");
    dlg.className = "chat-drawer-dialog";
    dlg.setAttribute("closedby", "any");
    dlg.setAttribute("aria-labelledby", "chatDrawerTitle");
    document.body.appendChild(dlg);
    this.dialog = dlg;

    this.pane = new AgentChatPane(dlg, {
      mode: "drawer",
      headingId: "chatDrawerTitle",
      embedMode: opts.embedMode,
      mcpAppMode: opts.mcpAppMode,
      getSessionContext: opts.getSessionContext,
      getReplyCapabilities: opts.getReplyCapabilities,
      onReplyToHost: opts.onReplyToHost,
      onCancelPrompt: opts.onCancelPrompt,
      onOpenInspector: opts.onOpenInspector,
      onSwitchAgent: opts.onSwitchAgent ? (id) => opts.onSwitchAgent?.(id) : undefined,
      onClose: () => this.close(),
      onToggleWide: () => {
        this.isWide = !this.isWide;
        this.dialog.classList.toggle("is-wide", this.isWide);
        return this.isWide;
      },
    });

    this.bindDialogEvents();
  }

  private bindDialogEvents(): void {
    const dlg = this.dialog;

    // Safari fallback for <dialog closedby="any"> using pointerdown/pointerup outside bounding box
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const isOutside = (e: PointerEvent): boolean => {
        const r = dlg.getBoundingClientRect();
        return (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        );
      };
      dlg.addEventListener("pointerdown", (e) => {
        pressedOutside = isOutside(e);
      });
      dlg.addEventListener("pointerup", (e) => {
        if (pressedOutside && isOutside(e)) {
          dlg.close();
        }
        pressedOutside = false;
      });
    }

    dlg.addEventListener("close", () => {
      dlg.returnValue = "";
      this.isOpen = false;
      const closedAgentId = this.pane.getCurrentAgentId();
      this.pane.reset();
      const invoker = this.lastInvokerEl;
      this.lastInvokerEl = null;
      window.requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) {
          return;
        }
        if (invoker && invoker.isConnected) {
          invoker.focus({ preventScroll: true });
          return;
        }
        if (closedAgentId) {
          const escaped =
            typeof CSS !== "undefined" && typeof CSS.escape === "function"
              ? CSS.escape(closedAgentId)
              : closedAgentId.replace(/["\\]/g, "\\$&");
          const fallbackEl = document.querySelector<HTMLElement>(
            `[data-chat-agent-id="${escaped}"], [data-open-chat="${escaped}"]`
          );
          fallbackEl?.focus({ preventScroll: true });
        }
      });
    });
  }

  public setRuntimeScope(scope: { embedMode?: boolean; mcpAppMode?: boolean }): void {
    this.pane.setRuntimeScope(scope);
  }

  public setConnectionState(status: ConnectionState): void {
    this.pane.setConnectionState(status);
  }

  public dispose(): void {
    this.pane.dispose();
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
  }

  public getOpenAgentId(): string | null {
    return this.isOpen ? this.pane.getCurrentAgentId() : null;
  }

  public open(params: OpenAgentChatParams): void {
    const activeBeforeOpen = document.activeElement;
    if (!this.isOpen && activeBeforeOpen instanceof HTMLElement && activeBeforeOpen !== document.body) {
      this.lastInvokerEl = activeBeforeOpen;
    }

    if (!this.dialog.open) {
      this.isOpen = true;
      this.dialog.showModal();
    } else {
      this.isOpen = true;
    }

    this.pane.openAgent({
      agent: params.agent,
      labelMap: params.labelMap,
      definition: params.definition,
      focusQuestion: params.focusQuestion,
    });
  }

  public close(): void {
    if (this.dialog.open) {
      this.dialog.close();
    } else {
      this.pane.reset();
    }
  }

  public notifySnapshot(
    snapshot: SessionSnapshot,
    mergedAgents: AgentNodeSnapshot[],
    labelMap?: Map<string, string>
  ): void {
    if (!this.isOpen) return;
    this.pane.notifySnapshot(snapshot, mergedAgents, labelMap);
  }
}
