import * as vscode from "vscode";
import { registerMcpProvider } from "./mcpProvider";
import { ModelSyncManager, type LanguageModelApiLike } from "./modelSync";
import { ServerManager } from "./serverManager";
import { StatusBarManager } from "./statusBar";
import {
  StudioPanel,
  StudioSidebarProvider,
  type StudioViewName,
} from "./webviewProvider";

let serverManager: ServerManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Agent Studio");
  context.subscriptions.push(output);

  const manager = new ServerManager(context.extensionPath, output);
  serverManager = manager;
  context.subscriptions.push(manager);

  const sidebarProvider = new StudioSidebarProvider(manager);
  context.subscriptions.push(
    sidebarProvider,
    vscode.window.registerWebviewViewProvider(
      StudioSidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  const statusBar = new StatusBarManager(manager);
  context.subscriptions.push(statusBar);

  const mcpDisposable = registerMcpProvider(manager, output);
  context.subscriptions.push(mcpDisposable);

  const lmApi = (vscode as unknown as { lm?: LanguageModelApiLike }).lm;
  const modelSync = new ModelSyncManager(manager, output, lmApi);
  context.subscriptions.push(modelSync);

  const openView = async (view: StudioViewName): Promise<void> => {
    await StudioPanel.createOrShow(manager, view);
    void sidebarProvider.refresh();
    void statusBar.poll();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("agentStudio.openStudio", () =>
      openView("studio"),
    ),
    vscode.commands.registerCommand("agentStudio.openBoard", () =>
      openView("board"),
    ),
    vscode.commands.registerCommand("agentStudio.openTeam", () =>
      openView("team"),
    ),
    vscode.commands.registerCommand("agentStudio.openDoctor", () =>
      openView("doctor"),
    ),
    vscode.commands.registerCommand("agentStudio.openInBrowser", async () => {
      await manager.ensureRunning(true);
      const url = manager.buildViewUrl(manager.getBrowserBaseUrl(), "studio");
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("agentStudio.initWorkspace", async () => {
      const workspaceRoot = manager.getPrimaryWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showWarningMessage(
          "Open a workspace folder before onboarding with Agent Studio.",
        );
        return;
      }

      const hostIde = manager.detectHostIde();
      const picks = await vscode.window.showQuickPick(
        [
          {
            label: "Antigravity",
            description: ".agents/plugins/<id>-team/",
            ide: "antigravity",
            picked: hostIde === "antigravity",
          },
          {
            label: "Claude Code",
            description: ".claude/, CLAUDE.md, .mcp.json",
            ide: "claude-code",
            picked: false,
          },
          {
            label: "GitHub Copilot / VS Code",
            description: ".github/agents/, .vscode/mcp.json, hooks",
            ide: "copilot-vscode",
            picked: hostIde === "copilot-vscode",
          },
        ],
        {
          canPickMany: true,
          title: `Agent Studio — Select Target IDEs to Compile (Host: ${manager.getHostIdeDisplayName()})`,
          placeHolder: "Your current host IDE is pre-selected; check additional IDEs if desired",
        },
      );

      if (!picks || picks.length === 0) return;
      const ides = picks.map((p) => p.ide).join(",");

      output.show(true);
      try {
        const res = await manager.runCli(
          [
            "init",
            "--project",
            workspaceRoot,
            "--ides",
            ides,
            "--non-interactive",
          ],
          workspaceRoot,
        );
        if (res.code === 0) {
          const action = await vscode.window.showInformationMessage(
            `Agent Studio onboarded workspace (${ides}).`,
            "Open Setup & Doctor",
          );
          if (action === "Open Setup & Doctor") {
            await openView("doctor");
          }
        } else {
          void vscode.window.showErrorMessage(
            `Agent Studio init exited with code ${res.code}. See the Agent Studio output channel.`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Agent Studio init failed: ${msg}`);
      }
      void sidebarProvider.refresh();
    }),
    vscode.commands.registerCommand("agentStudio.syncWorkspace", async () => {
      const workspaceRoot = manager.getPrimaryWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showWarningMessage(
          "Open a workspace folder before syncing IDE adapters.",
        );
        return;
      }
      output.show(true);
      try {
        const res = await manager.runCli(
          ["sync", "--project", workspaceRoot],
          workspaceRoot,
        );
        if (res.code === 0) {
          void vscode.window.showInformationMessage(
            "Agent Studio synced IDE adapters successfully.",
          );
        } else {
          void vscode.window.showErrorMessage(
            `Agent Studio sync failed (exit ${res.code}). Check Output Channel.`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Agent Studio sync failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("agentStudio.runDoctor", async () => {
      const workspaceRoot = manager.getPrimaryWorkspaceRoot();
      if (!workspaceRoot) {
        void vscode.window.showWarningMessage(
          "Open a workspace folder before running Doctor.",
        );
        return;
      }
      output.show(true);
      try {
        const res = await manager.runCli(
          ["doctor", "--project", workspaceRoot],
          workspaceRoot,
        );
        if (res.code === 0) {
          const action = await vscode.window.showInformationMessage(
            "Agent Studio Doctor passed with zero drift.",
            "Open Doctor View",
          );
          if (action === "Open Doctor View") {
            await openView("doctor");
          }
        } else {
          const action = await vscode.window.showWarningMessage(
            "Agent Studio Doctor found configuration or drift issues.",
            "Open Doctor View",
          );
          if (action === "Open Doctor View") {
            await openView("doctor");
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Agent Studio doctor failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand("agentStudio.restartServer", async () => {
      const status = await manager.restart();
      void sidebarProvider.refresh();
      void statusBar.poll();
      if (status.online) {
        void vscode.window.showInformationMessage(
          `Agent Studio server ready (${status.mode}) at ${status.localBaseUrl}`,
        );
      } else {
        void vscode.window.showErrorMessage(
          "Agent Studio server failed to start. Check the Agent Studio Output Channel.",
        );
      }
    }),
    vscode.commands.registerCommand("agentStudio.refreshModelIndex", async () => {
      const result = await modelSync.syncNow({
        reason: "manual",
        allowCliFallback: true,
      });
      if (result.ok && !result.skipped) {
        void vscode.window.showInformationMessage(
          `Agent Studio refreshed ${result.count} live ${manager.getHostIdeDisplayName()} model(s) into global Model Index (${result.transport ?? "http"}).`,
        );
      } else if (result.skipped) {
        void vscode.window.showInformationMessage(
          `Agent Studio: live Language Model API (${result.reason ?? "unavailable"}) did not expose models on ${manager.getHostIdeDisplayName()}; using built-in/workspace Model Index.`,
        );
      } else {
        void vscode.window.showWarningMessage(
          `Agent Studio could not refresh live Model Index: ${result.reason ?? "unknown error"}`,
        );
      }
    }),
  );

  // Non-blocking startup probe / auto-start
  void manager.ensureRunning(false).then(() => {
    void sidebarProvider.refresh();
    void statusBar.poll();
    void modelSync.syncNow({ reason: "startup" });
  });
}

export function deactivate(): void {
  serverManager?.dispose();
  serverManager = undefined;
}
