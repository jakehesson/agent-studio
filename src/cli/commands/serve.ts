import { spawn } from "node:child_process";
import {
  createStudioServer,
  type DoctorProvider,
  type StudioServerHandle,
} from "../../server/http-server.js";
import { buildDoctorReport } from "./doctor.js";

function parseServeFlags(args: string[]): {
  port: number;
  host: string;
  brainDir?: string;
  claudeDir?: string;
  vscodeDir?: string;
  webDir?: string;
  mockupDirs: string[];
  open: boolean;
} {
  let port = 8767;
  let host = "127.0.0.1";
  let brainDir: string | undefined;
  let claudeDir: string | undefined;
  let vscodeDir: string | undefined;
  let webDir: string | undefined;
  const mockupDirs: string[] = [];
  let open = false;

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!tok || !tok.startsWith("--")) continue;
    const raw = tok.slice(2);
    const eq = raw.indexOf("=");
    let key: string;
    let val: string | undefined;
    if (eq >= 0) {
      key = raw.slice(0, eq);
      val = raw.slice(eq + 1);
    } else {
      key = raw;
      const next = args[i + 1];
      if (key !== "open" && next !== undefined && !next.startsWith("--")) {
        val = next;
        i++;
      }
    }

    switch (key) {
      case "port":
        if (val) {
          const parsed = Number.parseInt(val, 10);
          if (Number.isFinite(parsed) && parsed >= 0) port = parsed;
        }
        break;
      case "host":
        if (val) host = val;
        break;
      case "brain-dir":
      case "brainDir":
        brainDir = val;
        break;
      case "claude-dir":
      case "claudeDir":
        claudeDir = val;
        break;
      case "vscode-dir":
      case "vscodeDir":
        vscodeDir = val;
        break;
      case "web-dir":
      case "webDir":
        webDir = val;
        break;
      case "mockup-dir":
      case "mockupDir":
        if (val) mockupDirs.push(val);
        break;
      case "open":
        open = val === undefined ? true : val !== "false" && val !== "0";
        break;
    }
  }

  return { port, host, brainDir, claudeDir, vscodeDir, webDir, mockupDirs, open };
}

function openBrowserBestEffort(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Non-fatal if browser open fails in headless environment.
  }
}

export async function runServe(
  args: string[],
  opts?: { doctorProvider?: DoctorProvider; keepAlive?: boolean },
): Promise<StudioServerHandle> {
  const cfg = parseServeFlags(args);
  const handle = createStudioServer({
    host: cfg.host,
    port: cfg.port,
    brainDir: cfg.brainDir,
    claudeDir: cfg.claudeDir,
    vscodeDir: cfg.vscodeDir,
    webDir: cfg.webDir,
    extraMockupDirs: cfg.mockupDirs,
    doctorProvider:
      opts?.doctorProvider ??
      (async (root) => buildDoctorReport(root ?? process.cwd())),
  });

  const bound = await handle.listen(cfg.port, cfg.host);
  const displayHost =
    bound.host === "0.0.0.0" || bound.host === "::" ? "127.0.0.1" : bound.host;
  const displayUrl = `http://${displayHost}:${bound.port}`;

  process.stdout.write(
    `[agent-studio] Unified Web Studio listening on ${bound.host}:${bound.port} (${displayUrl})\n`,
  );

  if (cfg.open) {
    openBrowserBestEffort(displayUrl);
  }

  if (opts?.keepAlive !== false) {
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        void handle.close().finally(() => resolve());
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  }

  return handle;
}
