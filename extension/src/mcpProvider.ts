import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { ServerManager } from "./serverManager";

function readExtensionVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Fall back to current release version if package.json is unavailable
  }
  return "0.7.0";
}

interface McpProviderLike {
  provideMcpServerDefinitions: () => unknown[];
}

type RegisterMcpFn = (id: string, provider: McpProviderLike) => vscode.Disposable;

type McpStdioCtor = new (
  label: string,
  command: string,
  args?: string[],
  env?: Record<string, string | number | null>,
  version?: string,
) => unknown;

/**
 * Safely feature-detects VS Code's `vscode.lm.registerMcpServerDefinitionProvider` API
 * so the extension works cleanly on both newer VS Code (1.99+) and older VS Code / Antigravity hosts.
 */
export function registerMcpProvider(
  serverManager: ServerManager,
  output: vscode.OutputChannel,
): vscode.Disposable {
  const cfg = serverManager.getConfig();
  if (!cfg.mcpAutoRegister) {
    output.appendLine("[mcp] agentStudio.mcpAutoRegister is disabled; skipping provider.");
    return new vscode.Disposable(() => undefined);
  }

  const vscodeAny = vscode as unknown as {
    lm?: { registerMcpServerDefinitionProvider?: RegisterMcpFn };
    McpStdioServerDefinition?: McpStdioCtor;
  };

  const registerFn = vscodeAny.lm?.registerMcpServerDefinitionProvider;
  const StdioCtor = vscodeAny.McpStdioServerDefinition;

  if (typeof registerFn !== "function" || typeof StdioCtor !== "function") {
    output.appendLine(
      "[mcp] Host IDE does not expose vscode.lm.registerMcpServerDefinitionProvider; using project .mcp.json / .vscode/mcp.json configs instead.",
    );
    return new vscode.Disposable(() => undefined);
  }

  try {
    const disposable = registerFn("agent-studio.mcp", {
      provideMcpServerDefinitions: () => {
        const cliPath = serverManager.getStudioCliPath();
        const workspaceRoot = serverManager.getPrimaryWorkspaceRoot();
        const { command, env } = serverManager.getNodeCommand();
        const args = [cliPath, "mcp"];
        if (workspaceRoot) {
          args.push("--project", workspaceRoot);
        }
        const envMap: Record<string, string | number | null> = {};
        if (env.ELECTRON_RUN_AS_NODE) {
          envMap.ELECTRON_RUN_AS_NODE = env.ELECTRON_RUN_AS_NODE;
        }
        return [
          new StdioCtor(
            "Agent Studio",
            command,
            args,
            Object.keys(envMap).length > 0 ? envMap : undefined,
            readExtensionVersion(),
          ),
        ];
      },
    });
    output.appendLine(
      "[mcp] Registered Agent Studio stdio MCP server definition provider.",
    );
    return disposable;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(`[mcp] Skipping MCP provider registration: ${msg}`);
    return new vscode.Disposable(() => undefined);
  }
}
