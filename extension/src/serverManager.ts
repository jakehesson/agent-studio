import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  buildScopedSessionsQueryString,
  buildScopedViewUrl,
  detectHostIdeFromAppName,
  getHostIdeDisplayName,
  normalizeWorkspacePath,
  type HostIde,
  type StudioView,
} from "./scoping";

export type { HostIde };

export type ServerMode = "external" | "managed" | "offline";

export interface ServerConfig {
  port: number;
  host: string;
  autoStart: boolean;
  externalUrl: string;
  mcpAutoRegister: boolean;
}

export interface ServerStatus {
  mode: ServerMode;
  online: boolean;
  localBaseUrl: string;
  browserBaseUrl: string;
  port: number;
}

export interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ServerManager implements vscode.Disposable {
  private child: ChildProcess | null = null;
  private mode: ServerMode = "offline";
  private startingPromise: Promise<ServerStatus> | null = null;
  private readonly onStatusChangedEmitter = new vscode.EventEmitter<ServerStatus>();
  public readonly onStatusChanged = this.onStatusChangedEmitter.event;

  constructor(
    private readonly extensionPath: string,
    private readonly output: vscode.OutputChannel,
  ) {}

  public getConfig(): ServerConfig {
    const cfg = vscode.workspace.getConfiguration("agentStudio");
    const rawPort = cfg.get<number>("port", 8767);
    const port =
      typeof rawPort === "number" && Number.isFinite(rawPort) && rawPort > 0
        ? Math.floor(rawPort)
        : 8767;
    const host = (cfg.get<string>("host", "127.0.0.1") || "127.0.0.1").trim();
    const autoStart = cfg.get<boolean>("autoStart", true);
    const externalUrl = (cfg.get<string>("externalUrl", "") || "")
      .trim()
      .replace(/\/+$/, "");
    const mcpAutoRegister = cfg.get<boolean>("mcpAutoRegister", true);
    return { port, host, autoStart, externalUrl, mcpAutoRegister };
  }

  public getStudioCliPath(): string {
    return path.join(this.extensionPath, "dist", "studio-cli.mjs");
  }

  public getWebDir(): string {
    return path.join(this.extensionPath, "dist", "web");
  }

  public getNodeCommand(): { command: string; env: NodeJS.ProcessEnv } {
    const isElectron = Boolean(
      (process.versions as Record<string, string | undefined>).electron,
    );
    if (process.execPath && fs.existsSync(process.execPath)) {
      return {
        command: process.execPath,
        env: isElectron
          ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
          : { ...process.env },
      };
    }
    return { command: "node", env: { ...process.env } };
  }

  public getLocalBaseUrl(): string {
    const { port } = this.getConfig();
    return `http://127.0.0.1:${port}`;
  }

  public getBrowserBaseUrl(): string {
    const { externalUrl } = this.getConfig();
    return externalUrl || this.getLocalBaseUrl();
  }

  public getStatus(): ServerStatus {
    const { port } = this.getConfig();
    return {
      mode: this.mode,
      online: this.mode !== "offline",
      localBaseUrl: this.getLocalBaseUrl(),
      browserBaseUrl: this.getBrowserBaseUrl(),
      port,
    };
  }

  public getPrimaryWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  public getNormalizedWorkspaceRoot(): string | undefined {
    return normalizeWorkspacePath(this.getPrimaryWorkspaceRoot());
  }

  public getWorkspaceLabel(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder?.name) return folder.name;
    const root = this.getPrimaryWorkspaceRoot();
    return root ? path.basename(root) : "No workspace";
  }

  public detectHostIde(): HostIde {
    return detectHostIdeFromAppName(vscode.env.appName);
  }

  public getHostIdeDisplayName(): string {
    return getHostIdeDisplayName(this.detectHostIde());
  }

  public buildScopedSessionsQuery(limit?: number): string {
    return buildScopedSessionsQueryString({
      hostIde: this.detectHostIde(),
      workspaceRoot: this.getNormalizedWorkspaceRoot(),
      projectId: this.detectWorkspaceProjectId(),
      limit,
    });
  }

  public detectWorkspaceProjectId(): string | undefined {
    const root = this.getPrimaryWorkspaceRoot();
    if (!root) return undefined;

    // 1. Check .agent-team/team.yaml (`project:\n  id: <slug>`)
    const teamYamlPath = path.join(root, ".agent-team", "team.yaml");
    if (fs.existsSync(teamYamlPath)) {
      try {
        const text = fs.readFileSync(teamYamlPath, "utf8");
        const match = text.match(
          /^project:\s*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+id:\s*["']?([a-zA-Z0-9._-]+)["']?/m,
        );
        if (match?.[1]) return match[1].trim();
      } catch {
        // ignore read error
      }
    }

    // 2. Check legacy project.json
    const projectJsonPath = path.join(root, "project.json");
    if (fs.existsSync(projectJsonPath)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(projectJsonPath, "utf8"),
        ) as Record<string, unknown>;
        if (typeof parsed.name === "string" && parsed.name.trim()) {
          return parsed.name.trim();
        }
      } catch {
        // ignore
      }
    }

    // 3. Check pipeline/board.json
    const boardPath = path.join(root, "pipeline", "board.json");
    if (fs.existsSync(boardPath)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(boardPath, "utf8"),
        ) as Record<string, unknown>;
        if (typeof parsed.project === "string" && parsed.project.trim()) {
          return parsed.project.trim();
        }
      } catch {
        // ignore
      }
    }

    return undefined;
  }

  public buildViewUrl(
    baseUrl: string,
    view?: StudioView,
    projectId?: string,
    opts?: {
      embed?: boolean;
      sessionId?: string;
      agentId?: string;
      focusQuestion?: boolean;
    },
  ): string {
    const resolvedProject = projectId ?? this.detectWorkspaceProjectId();
    return buildScopedViewUrl({
      baseUrl,
      view,
      projectId: resolvedProject,
      sessionId: opts?.sessionId,
      agentId: opts?.agentId,
      focusQuestion: opts?.focusQuestion,
      embed: opts?.embed,
      hostIde: this.detectHostIde(),
      workspaceRoot: this.getNormalizedWorkspaceRoot(),
    });
  }

  public async checkHealth(
    baseUrl = this.getLocalBaseUrl(),
    timeoutMs = 1200,
  ): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/doctor`, {
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  public async fetchJson<T>(
    endpointPath: string,
    timeoutMs = 2500,
  ): Promise<T | null> {
    const bases = [this.getLocalBaseUrl()];
    const ext = this.getConfig().externalUrl;
    if (ext && ext !== bases[0]) bases.push(ext);

    for (const base of bases) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}${endpointPath}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          return (await res.json()) as T;
        }
      } catch {
        // try next base
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  public async postJson<T>(
    endpointPath: string,
    body: unknown,
    timeoutMs = 4000,
  ): Promise<T | null> {
    const bases = [this.getLocalBaseUrl()];
    const ext = this.getConfig().externalUrl;
    if (ext && ext !== bases[0]) bases.push(ext);

    for (const base of bases) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}${endpointPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.ok) {
          return (await res.json()) as T;
        }
      } catch {
        // try next base
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  public async ensureRunning(forceStart = false): Promise<ServerStatus> {
    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = this.ensureRunningInternal(forceStart).finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  private async ensureRunningInternal(forceStart: boolean): Promise<ServerStatus> {
    const cfg = this.getConfig();
    const localBase = this.getLocalBaseUrl();

    // 1. Probe local port first so we NEVER collide with an existing daemon
    if (await this.checkHealth(localBase, 1200)) {
      if (!this.child) {
        this.setMode("external");
        this.output.appendLine(
          `[server] Attached to existing Agent Studio daemon at ${localBase}`,
        );
      } else {
        this.setMode("managed");
      }
      return this.getStatus();
    }

    // 2. If user configured an externalUrl (e.g. Tailscale remote host) and it's healthy, attach
    if (cfg.externalUrl && (await this.checkHealth(cfg.externalUrl, 1200))) {
      this.setMode("external");
      this.output.appendLine(
        `[server] Attached to external Agent Studio server at ${cfg.externalUrl}`,
      );
      return this.getStatus();
    }

    // 3. Respect autoStart unless explicitly triggered by a command
    if (!cfg.autoStart && !forceStart) {
      this.setMode("offline");
      return this.getStatus();
    }

    // 4. Spawn bundled studio-cli.mjs serve
    return this.spawnManagedServer();
  }

  private async spawnManagedServer(): Promise<ServerStatus> {
    const cfg = this.getConfig();
    const cliPath = this.getStudioCliPath();
    const webDir = this.getWebDir();

    if (!fs.existsSync(cliPath)) {
      this.output.appendLine(`[server] Missing bundled CLI at ${cliPath}`);
      this.setMode("offline");
      return this.getStatus();
    }

    this.stopManagedChild();

    const { command, env } = this.getNodeCommand();
    const args = [
      cliPath,
      "serve",
      "--host",
      cfg.host,
      "--port",
      String(cfg.port),
      "--web-dir",
      webDir,
    ];

    this.output.appendLine(
      `[server] Starting managed Agent Studio server: ${command} ${args.join(" ")}`,
    );

    const cwd = this.getPrimaryWorkspaceRoot() ?? this.extensionPath;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      this.output.append(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.output.append(chunk.toString("utf8"));
    });
    child.on("exit", (code, signal) => {
      this.output.appendLine(
        `[server] Managed server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      if (this.child === child) {
        this.child = null;
        this.setMode("offline");
      }
    });
    child.on("error", (err) => {
      this.output.appendLine(`[server] Failed to spawn server: ${err.message}`);
      if (this.child === child) {
        this.child = null;
        this.setMode("offline");
      }
    });

    const localBase = this.getLocalBaseUrl();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (this.child !== child) {
        break;
      }
      if (await this.checkHealth(localBase, 800)) {
        this.setMode("managed");
        this.output.appendLine(`[server] Managed server ready at ${localBase}`);
        return this.getStatus();
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    this.output.appendLine(
      `[server] Timed out waiting for managed server at ${localBase}`,
    );
    this.setMode("offline");
    return this.getStatus();
  }

  public async restart(): Promise<ServerStatus> {
    if (this.mode === "external" && !this.child) {
      const ok = await this.checkHealth(this.getLocalBaseUrl(), 1200);
      if (ok) {
        this.output.appendLine(
          `[server] Port ${this.getConfig().port} is served by an external daemon; keeping it running untouched.`,
        );
        void vscode.window.showInformationMessage(
          `Agent Studio is attached to an external daemon on port ${this.getConfig().port}. External daemons are never killed by the extension.`,
        );
        this.setMode("external");
        return this.getStatus();
      }
    }

    this.stopManagedChild();
    return this.spawnManagedServer();
  }

  public async runCli(
    args: string[],
    cwdOrOptions?: string | { cwd?: string; stdinText?: string },
  ): Promise<CliRunResult> {
    const cliPath = this.getStudioCliPath();
    if (!fs.existsSync(cliPath)) {
      throw new Error(`Bundled Agent Studio CLI not found at ${cliPath}`);
    }
    const { command, env } = this.getNodeCommand();
    const opts =
      typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : cwdOrOptions;
    const workdir = opts?.cwd ?? this.getPrimaryWorkspaceRoot() ?? process.cwd();
    const hasStdin = opts?.stdinText !== undefined;
    this.output.appendLine(
      `[cli] Running: agent-studio ${args.join(" ")} (cwd=${workdir})`,
    );

    return new Promise<CliRunResult>((resolve, reject) => {
      const child = spawn(command, [cliPath, ...args], {
        cwd: workdir,
        env,
        stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      if (hasStdin && child.stdin) {
        child.stdin.end(opts!.stdinText, "utf8");
      }

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        this.output.append(text);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        this.output.append(text);
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  private setMode(next: ServerMode): void {
    const changed = this.mode !== next;
    this.mode = next;
    if (changed) {
      this.onStatusChangedEmitter.fire(this.getStatus());
    }
  }

  private stopManagedChild(): void {
    if (!this.child) return;
    const proc = this.child;
    this.child = null;
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore if already exited
    }
    this.setMode("offline");
  }

  public dispose(): void {
    this.stopManagedChild();
    this.onStatusChangedEmitter.dispose();
  }
}
