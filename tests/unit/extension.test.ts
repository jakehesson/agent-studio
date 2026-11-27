import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";
import type * as CliShimModule from "../../extension/src/cliShim.js";
import type * as ModelSyncModule from "../../extension/src/modelSync.js";
import type * as ScopingModule from "../../extension/src/scoping.js";

function loadExtensionScopingModule(): typeof ScopingModule {
  const srcPath = path.join(REPO_ROOT, "extension", "src", "scoping.ts");
  const source = fs.readFileSync(srcPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const mod = { exports: {} as Partial<typeof ScopingModule> };
  const fn = new Function("exports", "module", outputText);
  fn(mod.exports, mod);
  return mod.exports as typeof ScopingModule;
}

function loadExtensionModelSyncModule(): typeof ModelSyncModule {
  const srcPath = path.join(REPO_ROOT, "extension", "src", "modelSync.ts");
  const source = fs.readFileSync(srcPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const mod = { exports: {} as Partial<typeof ModelSyncModule> };
  const fn = new Function("exports", "module", outputText);
  fn(mod.exports, mod);
  return mod.exports as typeof ModelSyncModule;
}

function loadExtensionCliShimModule(): typeof CliShimModule {
  const srcPath = path.join(REPO_ROOT, "extension", "src", "cliShim.ts");
  const source = fs.readFileSync(srcPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const mod = { exports: {} as Partial<typeof CliShimModule> };
  const localRequire = createRequire(srcPath);
  const fn = new Function("exports", "module", "require", outputText);
  fn(mod.exports, mod, localRequire);
  return mod.exports as typeof CliShimModule;
}

function transpileTsFile(
  filePath: string,
  customRequire: (id: string) => unknown,
): Record<string, unknown> {
  const source = fs.readFileSync(filePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const mod = { exports: {} as Record<string, unknown> };
  const fn = new Function("exports", "module", "require", outputText);
  fn(mod.exports, mod, customRequire);
  return mod.exports;
}

function createVscodeMock() {
  const createdStatusItems: Array<{
    command?: string;
    text: string;
    tooltip: unknown;
    backgroundColor: unknown;
    show(): void;
    dispose(): void;
  }> = [];
  const createdPanels: Array<{
    viewType: string;
    title: string;
    viewColumn: number;
    showOptions: unknown;
    webviewOptions: unknown;
    webview: {
      html: string;
      postedMessages: unknown[];
      postMessage(msg: unknown): Promise<boolean>;
      onDidReceiveMessage(cb: (msg: unknown) => void): { dispose(): void };
      emitMessage(msg: unknown): Promise<void>;
    };
    revealedColumns: number[];
    revealedCalls: Array<{ viewColumn: number; preserveFocus?: boolean }>;
    reveal(col: number, preserveFocus?: boolean): void;
    onDidDispose(cb: () => void): { dispose(): void };
    dispose(): void;
  }> = [];
  const executedCommands: Array<{ command: string; args: unknown[] }> = [];
  const clipboardWrites: string[] = [];
  let availableCommands: string[] = ["workbench.action.chat.open"];
  let executeCommandImpl:
    | ((command: string, ...args: unknown[]) => Promise<unknown>)
    | undefined;
  let clipboardError: Error | undefined;

  class MockThemeColor {
    constructor(public readonly id: string) {}
  }
  class MockMarkdownString {
    constructor(public readonly value: string) {}
  }

  const vscodeMock = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { One: 1, Beside: 2 },
    ThemeColor: MockThemeColor,
    MarkdownString: MockMarkdownString,
    Uri: {
      parse: (v: string) => ({ toString: () => v }),
      file: (v: string) => ({ fsPath: v, toString: () => `file://${v}` }),
    },
    Range: class {
      constructor(
        public startLine: number,
        public startChar: number,
        public endLine: number,
        public endChar: number,
      ) {}
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: REPO_ROOT }, name: "AgentVisualizer" }],
    },
    extensions: {
      getExtension: () => ({ packageJSON: { version: EXPECTED_VERSION } }),
    },
    env: {
      asExternalUri: async (uri: { toString(skip?: boolean): string }) => uri,
      openExternal: async () => true,
      clipboard: {
        writeText: async (text: string) => {
          if (clipboardError) throw clipboardError;
          clipboardWrites.push(text);
        },
      },
    },
    commands: {
      getCommands: async (_filterInternal?: boolean) => availableCommands,
      executeCommand: async (command: string, ...args: unknown[]) => {
        executedCommands.push({ command, args });
        if (executeCommandImpl) {
          return await executeCommandImpl(command, ...args);
        }
        return undefined;
      },
    },
    window: {
      showWarningMessage: async () => undefined,
      createStatusBarItem: () => {
        const item = {
          command: undefined as string | undefined,
          text: "",
          tooltip: undefined as unknown,
          backgroundColor: undefined as unknown,
          show() {},
          dispose() {},
        };
        createdStatusItems.push(item);
        return item;
      },
      createWebviewPanel: (
        viewType: string,
        title: string,
        showOptions?: number | { viewColumn: number; preserveFocus?: boolean },
        webviewOptions?: unknown,
      ) => {
        let msgHandler: ((msg: unknown) => unknown) | undefined;
        let disposeHandler: (() => void) | undefined;
        let disposed = false;
        const postedMessages: unknown[] = [];
        const revealedColumns: number[] = [];
        const revealedCalls: Array<{ viewColumn: number; preserveFocus?: boolean }> = [];
        const viewColumn =
          typeof showOptions === "number"
            ? showOptions
            : showOptions?.viewColumn ?? 1;
        const panel = {
          viewType,
          title,
          viewColumn,
          showOptions,
          webviewOptions,
          revealedColumns,
          revealedCalls,
          webview: {
            html: "",
            postedMessages,
            postMessage: async (msg: unknown) => {
              postedMessages.push(msg);
              return true;
            },
            onDidReceiveMessage: (cb: (msg: unknown) => unknown) => {
              msgHandler = cb;
              return { dispose() {} };
            },
            emitMessage: async (msg: unknown) => {
              if (msgHandler) {
                await msgHandler(msg);
              }
            },
          },
          reveal(col: number, preserveFocus?: boolean) {
            revealedColumns.push(col);
            revealedCalls.push({ viewColumn: col, preserveFocus });
          },
          onDidDispose(cb: () => void) {
            disposeHandler = cb;
            return { dispose() {} };
          },
          dispose() {
            if (disposed) return;
            disposed = true;
            disposeHandler?.();
          },
        };
        createdPanels.push(panel);
        return panel;
      },
    },
  };

  return {
    vscodeMock,
    createdStatusItems,
    createdPanels,
    executedCommands,
    clipboardWrites,
    setAvailableCommands: (cmds: string[]) => {
      availableCommands = cmds;
    },
    setExecuteCommandImpl: (
      fn: ((command: string, ...args: unknown[]) => Promise<unknown>) | undefined,
    ) => {
      executeCommandImpl = fn;
    },
    setClipboardError: (err: Error | undefined) => {
      clipboardError = err;
    },
  };
}

function loadExtensionStatusBarModule(vscodeMock: unknown) {
  const srcPath = path.join(EXT_ROOT, "src", "statusBar.ts");
  const localRequire = createRequire(srcPath);
  const scopingExports = loadExtensionScopingModule();
  return transpileTsFile(srcPath, (id) => {
    if (id === "vscode") return vscodeMock;
    if (id === "./scoping") return scopingExports;
    return localRequire(id);
  }) as {
    buildStatusBarPresentation: (input: {
      sessions: Array<{
        sessionId: string;
        title?: string;
        status?: string;
        ide?: string;
        waitingOn?: string | null;
        pendingQuestionCount?: number;
        waitingSummary?: string;
      }>;
      openItemsCount: number;
      openBugsCount: number;
      sprint: string;
      hostIdeName: string;
      workspaceLabel: string;
      mode: string;
      port: number;
    }) => {
      text: string;
      isWarning: boolean;
      tooltipLines: string[];
      waitingCount: number;
      activeCount: number;
    };
    StatusBarManager: new (serverManager: unknown) => {
      poll(): Promise<void>;
      dispose(): void;
    };
  };
}

function loadExtensionWebviewProviderModule(vscodeMock: unknown) {
  const srcPath = path.join(EXT_ROOT, "src", "webviewProvider.ts");
  const localRequire = createRequire(srcPath);
  const scopingExports = loadExtensionScopingModule();
  const fileLinkExports = transpileTsFile(
    path.join(EXT_ROOT, "src", "fileLinkBridge.ts"),
    (id) => localRequire(id),
  );
  const feedbackExports = transpileTsFile(
    path.join(EXT_ROOT, "src", "feedback.ts"),
    (id) => localRequire(id),
  );
  return transpileTsFile(srcPath, (id) => {
    if (id === "vscode") return vscodeMock;
    if (id === "./scoping") return scopingExports;
    if (id === "./fileLinkBridge") return fileLinkExports;
    if (id === "./feedback") return feedbackExports;
    return localRequire(id);
  }) as {
    REPLY_MAX_TEXT_BYTES: number;
    validateReplyToAgentMessage: (raw: unknown) =>
      | { ok: true; requestId: string; text: string; blockingToolCall: boolean }
      | { ok: false; requestId: string; reason: string };
    handleReplyToAgent: (
      raw: unknown,
      deps: {
        writeClipboard(text: string): Promise<void>;
        getCommands(filterInternal?: boolean): Promise<string[]>;
        executeCommand(command: string, ...rest: unknown[]): Promise<unknown>;
      },
    ) => Promise<{
      type: "agentStudio:replyResult";
      requestId: string;
      ok: boolean;
      mode: "prefilled" | "focused_copied" | "copied" | "error";
      message: string;
    }>;
    renderSidebarSessionsHtml: (
      sessions: Array<{
        sessionId: string;
        ide?: string;
        title?: string;
        status?: string;
        waitingOn?: string | null;
        pendingQuestionCount?: number;
        waitingSummary?: string;
      }>,
      limit?: number,
    ) => string;
    StudioPanel: {
      currentPanel: { dispose(): void } | undefined;
      createOrShow: (
        serverManager: unknown,
        view?: string,
        sessionIdOrOptions?:
          | string
          | { sessionId?: string; openWaiting?: boolean },
      ) => Promise<void>;
    };
    StudioSidebarProvider: new (serverManager: unknown) => {
      resolveWebviewView(webviewView: unknown): void;
      refresh(): Promise<void>;
      dispose(): void;
    };
  };
}

const REPO_ROOT = path.resolve(process.cwd());
const EXT_ROOT = path.join(REPO_ROOT, "extension");
const EXT_ENTRY = path.join(EXT_ROOT, "dist", "extension.js");
const STUDIO_CLI = path.join(EXT_ROOT, "dist", "studio-cli.mjs");
const EXT_WEB_INDEX = path.join(EXT_ROOT, "dist", "web", "index.html");

function readManifestVersion(manifestPath: string): string {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    version?: string;
  };
  assert.ok(
    typeof parsed.version === "string" && /^\d+\.\d+\.\d+/.test(parsed.version),
    `Expected valid SemVer version in ${manifestPath}, got ${String(parsed.version)}`,
  );
  return parsed.version;
}

const EXPECTED_VERSION = readManifestVersion(path.join(EXT_ROOT, "package.json"));
const VSIX_PATH = path.join(EXT_ROOT, `agent-studio-${EXPECTED_VERSION}.vsix`);

/**
 * Pure stdlib ZIP Central Directory reader — lists every entry path inside a .vsix archive
 * without requiring external unzip utilities or npm packages.
 */
function listZipEntries(zipPath: string): string[] {
  const buf = fs.readFileSync(zipPath);
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;

  let eocdOffset = -1;
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, `Invalid ZIP/VSIX archive (missing EOCD): ${zipPath}`);

  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdEnd = cdOffset + cdSize;

  const entries: string[] = [];
  let cursor = cdOffset;
  while (cursor < cdEnd) {
    assert.equal(
      buf.readUInt32LE(cursor),
      CD_SIG,
      `Corrupt central directory entry at offset ${cursor}`,
    );
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const name = buf
      .subarray(cursor + 46, cursor + 46 + nameLen)
      .toString("utf8");
    entries.push(name);
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

describe("VS Code / Antigravity IDE Extension (.vsix)", () => {
  it("keeps lockstep SemVer versions across package.json, extension/package.json, and web/package.json", () => {
    const rootVer = readManifestVersion(path.join(REPO_ROOT, "package.json"));
    const extVer = readManifestVersion(path.join(EXT_ROOT, "package.json"));
    const webVer = readManifestVersion(path.join(REPO_ROOT, "web", "package.json"));

    assert.equal(extVer, rootVer, "extension/package.json version must match root package.json");
    assert.equal(webVer, rootVer, "web/package.json version must match root package.json");
    assert.ok(
      fs.existsSync(path.join(EXT_ROOT, `agent-studio-${rootVer}.vsix`)),
      `Expected packaged VSIX matching lockstep version: extension/agent-studio-${rootVer}.vsix`,
    );

    const distCliVersion = execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "dist", "cli", "index.js"), "--version"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 10_000 },
    ).trim();
    const bundledCliVersion = execFileSync(
      process.execPath,
      [STUDIO_CLI, "--version"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 10_000 },
    ).trim();

    assert.equal(distCliVersion, rootVer, "dist/cli/index.js --version must match package.json");
    assert.equal(bundledCliVersion, rootVer, "extension/dist/studio-cli.mjs --version must match package.json");
  });

  it("builds self-contained extension.js, studio-cli.mjs, web assets, and .vsix package", () => {
    assert.ok(fs.existsSync(EXT_ENTRY), `Missing ${EXT_ENTRY}`);
    assert.ok(fs.existsSync(STUDIO_CLI), `Missing ${STUDIO_CLI}`);
    assert.ok(fs.existsSync(EXT_WEB_INDEX), `Missing ${EXT_WEB_INDEX}`);
    assert.ok(fs.existsSync(VSIX_PATH), `Missing ${VSIX_PATH}`);
    assert.ok(fs.statSync(VSIX_PATH).size > 20_000, "VSIX archive unexpectedly tiny");
  });

  it("runs bundled studio-cli.mjs init & doctor --json standalone with ok: true", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "av-ext-cli-"));
    const tmpHome = path.join(tmpBase, "home");
    const tmpProj = path.join(tmpBase, "demo-proj");
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(tmpProj, { recursive: true });
    fs.writeFileSync(
      path.join(tmpProj, "package.json"),
      JSON.stringify({ name: "ext-smoke-app", scripts: { test: "node --test" } }),
      "utf8",
    );

    const env = {
      ...process.env,
      HOME: tmpHome,
      AGENT_STUDIO_HOME: path.join(tmpHome, ".agent-studio"),
    };

    try {
      execFileSync(
        process.execPath,
        [
          STUDIO_CLI,
          "init",
          "--project",
          tmpProj,
          "--ides",
          "antigravity,claude-code,copilot-vscode",
          "--non-interactive",
        ],
        {
          cwd: tmpProj,
          env,
          encoding: "utf8",
          timeout: 15_000,
        },
      );

      const stdout = execFileSync(
        process.execPath,
        [STUDIO_CLI, "doctor", "--json", "--project", tmpProj],
        {
          cwd: tmpProj,
          env,
          encoding: "utf8",
          timeout: 15_000,
        },
      );

      const report = JSON.parse(stdout) as {
        ok: boolean;
        projectId: string;
        manifestValid: boolean;
        drift: { ok: boolean; checkedCount: number };
      };
      assert.equal(report.ok, true);
      assert.equal(report.projectId, "ext-smoke-app");
      assert.equal(report.manifestValid, true);
      assert.equal(report.drift.ok, true);
      assert.ok(report.drift.checkedCount > 0);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("packages required files into .vsix and excludes node_modules/", () => {
    const entries = listZipEntries(VSIX_PATH);
    assert.ok(entries.includes("extension/package.json"), "VSIX missing extension/package.json");
    assert.ok(entries.includes("extension/dist/extension.js"), "VSIX missing extension/dist/extension.js");
    assert.ok(entries.includes("extension/dist/studio-cli.mjs"), "VSIX missing extension/dist/studio-cli.mjs");
    assert.ok(entries.includes("extension/dist/web/index.html"), "VSIX missing extension/dist/web/index.html");
    assert.ok(
      entries.includes("extension/media/agent-studio-icon.svg"),
      "VSIX missing extension/media/agent-studio-icon.svg",
    );

    const leakedNodeModules = entries.filter((e) => e.includes("node_modules/"));
    assert.deepEqual(
      leakedNodeModules,
      [],
      `VSIX leaked node_modules entries: ${leakedNodeModules.slice(0, 5).join(", ")}`,
    );
  });

  it("scopes embedded IDE URLs and session queries strictly to host IDE and workspace while preserving standalone browser URLs", () => {
    const {
      buildScopedSessionsQueryString,
      buildScopedViewUrl,
      detectHostIdeFromAppName,
      getHostIdeDisplayName,
      normalizeWorkspacePath,
    } = loadExtensionScopingModule();

    assert.equal(detectHostIdeFromAppName("Antigravity"), "antigravity");
    assert.equal(detectHostIdeFromAppName("AGY Insider"), "antigravity");
    assert.equal(detectHostIdeFromAppName("Visual Studio Code"), "copilot-vscode");
    assert.equal(detectHostIdeFromAppName("Visual Studio Code - Insiders"), "copilot-vscode");
    assert.equal(detectHostIdeFromAppName(undefined), "copilot-vscode");

    assert.equal(getHostIdeDisplayName("antigravity"), "Antigravity");
    assert.equal(getHostIdeDisplayName("copilot-vscode"), "VS Code");
    assert.equal(
      normalizeWorkspacePath("C:\\Projects\\DemoRepo\\"),
      "C:/Projects/DemoRepo",
    );

    // Embedded extension URL includes embed=1, ide, workspace, view, project, and optional session
    const embeddedUrl = new URL(
      buildScopedViewUrl({
        baseUrl: "http://127.0.0.1:8767/",
        view: "doctor",
        projectId: "agent-studio",
        sessionId: "sess-123",
        embed: true,
        hostIde: "antigravity",
        workspaceRoot: "C:\\Projects\\DemoRepo",
      }),
    );
    assert.equal(embeddedUrl.searchParams.get("embed"), "1");
    assert.equal(embeddedUrl.searchParams.get("ide"), "antigravity");
    assert.equal(
      embeddedUrl.searchParams.get("workspace"),
      "C:/Projects/DemoRepo",
    );
    assert.equal(embeddedUrl.searchParams.get("view"), "doctor");
    assert.equal(embeddedUrl.searchParams.get("project"), "agent-studio");
    assert.equal(embeddedUrl.searchParams.get("session"), "sess-123");

    // Standalone Open in Browser URL omits embed, ide, workspace, and session when unset
    const standaloneUrl = new URL(
      buildScopedViewUrl({
        baseUrl: "https://studio.example.ts.net:8767",
        view: "studio",
        projectId: "agent-studio",
        embed: false,
        hostIde: "antigravity",
        workspaceRoot: "C:\\Projects\\DemoRepo",
      }),
    );
    assert.equal(standaloneUrl.searchParams.get("embed"), null);
    assert.equal(standaloneUrl.searchParams.get("ide"), null);
    assert.equal(standaloneUrl.searchParams.get("workspace"), null);
    assert.equal(standaloneUrl.searchParams.get("project"), "agent-studio");
    assert.equal(standaloneUrl.searchParams.get("session"), null);

    // Scoped sessions query used by Sidebar & StatusBar
    const q = new URLSearchParams(
      buildScopedSessionsQueryString({
        hostIde: "copilot-vscode",
        workspaceRoot: "C:\\Repo\\MyApp",
        projectId: "my-app",
        limit: 15,
      }).slice(1),
    );
    assert.equal(q.get("ide"), "copilot-vscode");
    assert.equal(q.get("workspace"), "C:/Repo/MyApp");
    assert.equal(q.get("project"), "my-app");
    assert.equal(q.get("limit"), "15");

    // Verify extension webview & status bar wire embed=true, sessionId deep-linking, reload skip, and scoped session queries
    const webviewSrc = fs.readFileSync(
      path.join(EXT_ROOT, "src", "webviewProvider.ts"),
      "utf8",
    );
    const statusBarSrc = fs.readFileSync(
      path.join(EXT_ROOT, "src", "statusBar.ts"),
      "utf8",
    );
    assert.ok(webviewSrc.includes("{ embed: true, sessionId: effectiveSessionId }"));
    assert.ok(webviewSrc.includes("resolvedUrl === this.currentResolvedUrl"));
    assert.ok(webviewSrc.includes("!opts?.force"));
    assert.ok(webviewSrc.includes("buildScopedSessionsQuery("));
    assert.ok(statusBarSrc.includes("buildScopedSessionsQuery("));
  });

  it("modelSync preserves native runtime model IDs for Copilot and Antigravity, guards missing vscode.lm, and falls back to CLI when offline", async () => {
    const {
      ModelSyncManager,
      formatPickerLabel,
      isLanguageModelApiSupported,
      mapLanguageModelsForHost,
    } = loadExtensionModelSyncModule();

    // Deprecated helper compatibility check
    assert.equal(formatPickerLabel("Claude Sonnet 4.5", "copilot"), "Claude Sonnet 4.5 (copilot)");
    assert.equal(
      formatPickerLabel("Claude Sonnet 4.5 (copilot)", "copilot"),
      "Claude Sonnet 4.5 (copilot)",
    );
    assert.equal(formatPickerLabel("GPT-4.1", undefined), "GPT-4.1");

    // Safe feature detection
    assert.equal(isLanguageModelApiSupported(undefined), false);
    assert.equal(isLanguageModelApiSupported({}), false);
    assert.equal(
      isLanguageModelApiSupported({ selectChatModels: async () => [] }),
      true,
    );

    // Host scoping: Copilot & Antigravity both preserve native runtime m.id and deduplicate by id
    const copilotMapped = mapLanguageModelsForHost("copilot-vscode", [
      { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", vendor: "copilot", family: "claude-sonnet-4.6", version: "20250929", maxInputTokens: 200_000 },
      { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6 (duplicate)", vendor: "copilot" },
      { id: "gpt-5.4", name: "GPT-5.4", vendor: "copilot", family: "gpt-5.4" },
    ]);
    assert.equal(copilotMapped.length, 2);
    assert.equal(copilotMapped[0]?.id, "claude-sonnet-4.6");
    assert.equal(copilotMapped[0]?.label, "Claude Sonnet 4.6");
    assert.equal(copilotMapped[0]?.vendor, "copilot");
    assert.equal(copilotMapped[0]?.version, "20250929");
    assert.equal(copilotMapped[0]?.maxInputTokens, 200_000);
    assert.equal(copilotMapped[1]?.id, "gpt-5.4");
    assert.equal(copilotMapped[1]?.label, "GPT-5.4");

    const agyMapped = mapLanguageModelsForHost("antigravity", [
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", vendor: "google" },
    ]);
    assert.equal(agyMapped[0]?.id, "gemini-3.8-flash");

    // Transport test: HTTP online vs CLI offline fallback + missing LM API no-throw
    const logs: string[] = [];
    const posted: Array<{ endpoint: string; body: unknown }> = [];
    const cliCalls: Array<{ args: string[]; stdinText?: string }> = [];

    const noLmMgr = new ModelSyncManager(
      {
        detectHostIde: () => "antigravity",
        detectWorkspaceProjectId: () => "demo",
        getPrimaryWorkspaceRoot: () => REPO_ROOT,
        getStatus: () => ({ online: false }),
        ensureRunning: async () => ({ online: false }),
        postJson: async () => null,
        runCli: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
      { appendLine: (l) => logs.push(l) },
      undefined,
    );
    const noLmRes = await noLmMgr.syncNow({ reason: "manual" });
    assert.equal(noLmRes.skipped, true);
    assert.equal(noLmRes.reason, "lm-api-unavailable");
    noLmMgr.dispose();

    const onlineMgr = new ModelSyncManager(
      {
        detectHostIde: () => "copilot-vscode",
        detectWorkspaceProjectId: () => "demo",
        getPrimaryWorkspaceRoot: () => REPO_ROOT,
        getStatus: () => ({ online: true }),
        ensureRunning: async () => ({ online: true }),
        postJson: async <T>(endpoint: string, body: unknown) => {
          posted.push({ endpoint, body });
          return { ok: true, count: 1, added: 1, updated: 0 } as T;
        },
        runCli: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
      { appendLine: (l) => logs.push(l) },
      {
        selectChatModels: async () => [
          { id: "gpt-4.1", name: "GPT-4.1", vendor: "copilot", family: "gpt-4.1" },
        ],
      },
    );
    const onlineRes = await onlineMgr.syncNow({ reason: "startup" });
    assert.equal(onlineRes.ok, true);
    assert.equal(onlineRes.transport, "http");
    assert.equal(posted[0]?.endpoint, "/api/model-index/discover");
    onlineMgr.dispose();

    const offlineMgr = new ModelSyncManager(
      {
        detectHostIde: () => "copilot-vscode",
        detectWorkspaceProjectId: () => "demo",
        getPrimaryWorkspaceRoot: () => REPO_ROOT,
        getStatus: () => ({ online: false }),
        ensureRunning: async () => ({ online: false }),
        postJson: async () => null,
        runCli: async (args, opts) => {
          const stdinText = typeof opts === "object" ? opts?.stdinText : undefined;
          cliCalls.push({ args, stdinText });
          return { code: 0, stdout: JSON.stringify({ added: 1, updated: 0 }), stderr: "" };
        },
      },
      { appendLine: (l) => logs.push(l) },
      {
        selectChatModels: async () => [
          { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", vendor: "copilot" },
        ],
      },
    );
    const offlineRes = await offlineMgr.syncNow({ reason: "manual", allowCliFallback: true });
    assert.equal(offlineRes.ok, true);
    assert.equal(offlineRes.transport, "cli");
    assert.ok(cliCalls[0]?.args.includes("--stdin"));
    assert.match(cliCalls[0]?.stdinText ?? "", /"id"\s*:\s*"claude-haiku-4\.5"/);
    assert.match(cliCalls[0]?.stdinText ?? "", /"label"\s*:\s*"Claude Haiku 4\.5"/);
    offlineMgr.dispose();

    // Verify extension/package.json contributes agentStudio.refreshModelIndex
    const extPkg = JSON.parse(
      fs.readFileSync(path.join(EXT_ROOT, "package.json"), "utf8"),
    ) as { contributes: { commands: Array<{ command: string }> } };
    assert.ok(
      extPkg.contributes.commands.some((c) => c.command === "agentStudio.refreshModelIndex"),
    );
  });

  it("cliShim syncs atomic shims idempotently, handles missing source, registers terminal PATH, and executes --version", () => {
    const {
      registerTerminalPath,
      resolveAgentStudioBinDir,
      syncCliShims,
    } = loadExtensionCliShimModule();

    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "av-shim-test-"));
    const fakeHome = path.join(tmpBase, "studio home");
    const prevEnvHome = process.env.AGENT_STUDIO_HOME;

    try {
      process.env.AGENT_STUDIO_HOME = fakeHome;
      assert.equal(resolveAgentStudioBinDir(), path.join(fakeHome, "bin"));
      assert.equal(
        resolveAgentStudioBinDir(path.join(tmpBase, "override")),
        path.join(tmpBase, "override", "bin"),
      );

      // Missing source returns ok: false without throwing
      const missingRes = syncCliShims({
        sourceCliPath: path.join(tmpBase, "does-not-exist.mjs"),
        agentStudioHome: fakeHome,
      });
      assert.equal(missingRes.ok, false);
      assert.ok(missingRes.error);
      assert.deepEqual(missingRes.written, []);

      // Initial sync writes all 3 files
      const firstRes = syncCliShims({
        sourceCliPath: STUDIO_CLI,
        agentStudioHome: fakeHome,
      });
      assert.equal(firstRes.ok, true);
      assert.equal(firstRes.binDir, path.join(fakeHome, "bin"));
      assert.equal(firstRes.cliPath, path.join(fakeHome, "bin", "studio-cli.mjs"));
      assert.equal(firstRes.written.length, 3);

      const cmdPath = path.join(firstRes.binDir, "agent-studio.cmd");
      const shPath = path.join(firstRes.binDir, "agent-studio");
      assert.equal(
        fs.readFileSync(cmdPath, "utf8"),
        '@echo off\r\nnode "%~dp0studio-cli.mjs" %*\r\n',
      );
      assert.equal(
        fs.readFileSync(shPath, "utf8"),
        '#!/usr/bin/env sh\nexec node "$(dirname "$0")/studio-cli.mjs" "$@"\n',
      );
      if (process.platform !== "win32") {
        const mode = fs.statSync(shPath).mode & 0o777;
        assert.ok((mode & 0o111) !== 0, "POSIX shim must be executable");
      }

      // Second sync is 100% idempotent (written === [])
      const secondRes = syncCliShims({
        sourceCliPath: STUDIO_CLI,
        agentStudioHome: fakeHome,
      });
      assert.equal(secondRes.ok, true);
      assert.deepEqual(secondRes.written, []);

      // Content change triggers atomic rewrite without leaving .tmp-* files
      fs.writeFileSync(cmdPath, "stale-content", "utf8");
      const thirdRes = syncCliShims({
        sourceCliPath: STUDIO_CLI,
        agentStudioHome: fakeHome,
      });
      assert.equal(thirdRes.ok, true);
      assert.deepEqual(thirdRes.written, [cmdPath]);
      assert.equal(
        fs.readFileSync(cmdPath, "utf8"),
        '@echo off\r\nnode "%~dp0studio-cli.mjs" %*\r\n',
      );
      const leftoverTemps = fs
        .readdirSync(firstRes.binDir)
        .filter((f) => f.startsWith(".tmp-"));
      assert.deepEqual(leftoverTemps, []);

      // registerTerminalPath prepends binDir + path.delimiter
      const prepended: Array<{ key: string; value: string }> = [];
      assert.equal(registerTerminalPath(undefined, firstRes.binDir), false);
      assert.equal(
        registerTerminalPath(
          {
            prepend(key, value) {
              prepended.push({ key, value });
            },
          },
          firstRes.binDir,
        ),
        true,
      );
      assert.deepEqual(prepended, [
        { key: "PATH", value: `${firstRes.binDir}${path.delimiter}` },
      ]);

      // Invoke generated shim directly with --version
      const nodeBinDir = path.dirname(process.execPath);
      const basePath = process.env.PATH ?? "";
      const shimEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const k of Object.keys(shimEnv)) {
        if (k.toLowerCase() === "path") delete shimEnv[k];
      }
      shimEnv.PATH = `${nodeBinDir}${path.delimiter}${basePath}`;
      const comSpec =
        process.env.ComSpec ||
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
      const runRes =
        process.platform === "win32"
          ? spawnSync(
              comSpec,
              ["/d", "/s", "/c", `""${cmdPath}" --version"`],
              {
                env: shimEnv,
                encoding: "utf8",
                timeout: 10_000,
                windowsVerbatimArguments: true,
              },
            )
          : spawnSync(shPath, ["--version"], {
              env: shimEnv,
              encoding: "utf8",
              timeout: 10_000,
            });
      assert.equal(runRes.status, 0, `Shim exited with ${runRes.status}: ${runRes.stderr}`);
      assert.equal(runRes.stdout.trim(), EXPECTED_VERSION);
    } finally {
      if (prevEnvHome === undefined) {
        delete process.env.AGENT_STUDIO_HOME;
      } else {
        process.env.AGENT_STUDIO_HOME = prevEnvHome;
      }
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("statusBar highlights scoped waiting sessions with warningBackground, tooltip summaries, and resets when waitingCount is 0", async () => {
    const mock = createVscodeMock();
    const { StatusBarManager, buildStatusBarPresentation } =
      loadExtensionStatusBarModule(mock.vscodeMock);

    // Pure presentation checks: subagent waiting alone does not count as human waiting
    const subagentOnly = buildStatusBarPresentation({
      sessions: [
        { sessionId: "s-sub", title: "Subagent Task", status: "WORKING", waitingOn: "subagent" },
      ],
      openItemsCount: 2,
      openBugsCount: 0,
      sprint: "S1",
      hostIdeName: "VS Code",
      workspaceLabel: "Repo",
      mode: "managed",
      port: 8767,
    });
    assert.equal(subagentOnly.waitingCount, 0);
    assert.equal(subagentOnly.isWarning, false);
    assert.equal(subagentOnly.text, "$(pulse) Agent Studio: 1 active");

    // Live StatusBarManager poll transitions: waiting -> cleared -> offline
    let currentSessions: Array<{
      sessionId: string;
      title?: string;
      status?: string;
      waitingOn?: string | null;
      pendingQuestionCount?: number;
      waitingSummary?: string;
    }> = [
      {
        sessionId: "sess-wait-1",
        title: "Auth Refactor",
        status: "WAITING",
        waitingOn: "user",
        pendingQuestionCount: 2,
        waitingSummary: "Choose OAuth vs PAT",
      },
      {
        sessionId: "sess-wait-2",
        title: "DB Migration",
        status: "WORKING",
        waitingOn: "tool_approval",
        waitingSummary: "Approve schema push",
      },
      {
        sessionId: "sess-work-3",
        title: "Lint Pass",
        status: "WORKING",
        waitingOn: null,
      },
    ];
    let serverOnline = true;

    const fakeServerManager = {
      onStatusChanged: () => ({ dispose() {} }),
      getStatus: () => ({
        mode: serverOnline ? "managed" : "offline",
        online: serverOnline,
        localBaseUrl: "http://127.0.0.1:8767",
        browserBaseUrl: "http://127.0.0.1:8767",
        port: 8767,
      }),
      getLocalBaseUrl: () => "http://127.0.0.1:8767",
      checkHealth: async () => serverOnline,
      detectWorkspaceProjectId: () => "agent-studio",
      getHostIdeDisplayName: () => "VS Code",
      getWorkspaceLabel: () => "AgentVisualizer",
      buildScopedSessionsQuery: (limit?: number) =>
        `?ide=copilot-vscode&workspace=C%3A%2FRepo&limit=${limit ?? 25}`,
      fetchJson: async (endpoint: string) => {
        if (endpoint.startsWith("/api/sessions")) {
          return { sessions: currentSessions };
        }
        return { board: { active_sprint: "S1", items: [] } };
      },
    };

    const mgr = new StatusBarManager(fakeServerManager);
    try {
      await mgr.poll();
      const item = mock.createdStatusItems[0];
      assert.ok(item, "Expected StatusBarItem to be created");
      assert.match(item.text, /\$\(question\) 2 waiting/);
      assert.match(item.text, /3 active/);
      assert.ok(item.backgroundColor instanceof mock.vscodeMock.ThemeColor);
      assert.equal(
        (item.backgroundColor as { id: string }).id,
        "statusBarItem.warningBackground",
      );
      const tipValue = (item.tooltip as { value: string }).value;
      assert.match(tipValue, /Waiting for input: \*\*2\*\*/);
      assert.match(tipValue, /`Auth Refactor` — Choose OAuth vs PAT/);
      assert.match(tipValue, /`DB Migration` — Approve schema push/);

      // Reset warning when waiting sessions resolve
      currentSessions = [
        { sessionId: "sess-work-3", title: "Lint Pass", status: "WORKING", waitingOn: null },
      ];
      await mgr.poll();
      assert.equal(item.backgroundColor, undefined);
      assert.equal(item.text, "$(pulse) Agent Studio: 1 active");

      // Also clear background when offline
      currentSessions = [
        { sessionId: "sess-wait-1", title: "Auth Refactor", status: "WAITING", waitingOn: "user" },
      ];
      await mgr.poll();
      assert.ok(item.backgroundColor);
      serverOnline = false;
      await mgr.poll();
      assert.equal(item.backgroundColor, undefined);
      assert.match(item.text, /offline/);
    } finally {
      mgr.dispose();
    }
  });

  it("sidebar renders waiting badges/summaries and StudioPanel supports openWaiting deep-links and focusSession reuse", async () => {
    const mock = createVscodeMock();
    const {
      StudioPanel,
      StudioSidebarProvider,
      renderSidebarSessionsHtml,
    } = loadExtensionWebviewProviderModule(mock.vscodeMock);
    const { buildScopedViewUrl, appendDeepLinkParams } = loadExtensionScopingModule();

    // Verify URL helpers
    const scopedUrl = new URL(
      buildScopedViewUrl({
        baseUrl: "http://127.0.0.1:8767",
        view: "studio",
        projectId: "agent-studio",
        sessionId: "sess-9",
        openWaiting: true,
        embed: true,
        hostIde: "copilot-vscode",
        workspaceRoot: "C:\\Repo",
      }),
    );
    assert.equal(scopedUrl.searchParams.get("embed"), "1");
    assert.equal(scopedUrl.searchParams.get("openWaiting"), "1");
    const appended = new URL(
      appendDeepLinkParams("http://127.0.0.1:8767/?embed=1&session=s1", {
        openWaiting: true,
      }),
    );
    assert.equal(appended.searchParams.get("openWaiting"), "1");

    // Verify sidebar waiting markup prioritizes waiting sessions and includes reduced-motion-safe dot + badge + summary
    const listHtml = renderSidebarSessionsHtml([
      { sessionId: "work-1", title: "Idle Session", status: "IDLE", ide: "copilot-vscode" },
      {
        sessionId: "wait-1",
        title: "Need Choice",
        status: "WAITING",
        ide: "copilot-vscode",
        waitingOn: "user",
        pendingQuestionCount: 2,
        waitingSummary: "Pick deployment target",
      },
    ]);
    assert.ok(listHtml.indexOf("wait-1") < listHtml.indexOf("work-1"));
    assert.match(listHtml, /class="dot waiting"/);
    assert.match(listHtml, /Needs Input \(2\)/);
    assert.match(listHtml, /Pick deployment target/);
    assert.match(listHtml, /data-open-waiting="1"/);

    // Verify full StudioSidebarProvider refresh & click relay
    const fakeServerManager = {
      onStatusChanged: () => ({ dispose() {} }),
      ensureRunning: async () => ({ online: true }),
      getStatus: () => ({
        mode: "managed",
        online: true,
        localBaseUrl: "http://127.0.0.1:8767",
        browserBaseUrl: "http://127.0.0.1:8767",
        port: 8767,
      }),
      detectWorkspaceProjectId: () => "agent-studio",
      getHostIdeDisplayName: () => "VS Code",
      getWorkspaceLabel: () => "AgentVisualizer",
      buildScopedSessionsQuery: () => "?ide=copilot-vscode&workspace=C%3A%2FRepo&limit=15",
      buildViewUrl: (
        baseUrl: string,
        view?: string,
        projectId?: string,
        opts?: { embed?: boolean; sessionId?: string },
      ) =>
        buildScopedViewUrl({
          baseUrl,
          view: view as "studio" | undefined,
          projectId: projectId ?? "agent-studio",
          sessionId: opts?.sessionId,
          embed: opts?.embed,
          hostIde: "copilot-vscode",
          workspaceRoot: "C:\\Repo",
        }),
      fetchJson: async (endpoint: string) => {
        if (endpoint.startsWith("/api/sessions")) {
          return {
            sessions: [
              {
                sessionId: "wait-1",
                title: "Need Choice",
                status: "WAITING",
                ide: "copilot-vscode",
                waitingOn: "user",
                waitingSummary: "Pick option A or B",
              },
            ],
          };
        }
        return { project: { id: "agent-studio", title: "Agent Studio" }, board: { active_sprint: "S1", items: [] } };
      },
    };

    const sidebar = new StudioSidebarProvider(fakeServerManager);
    let sidebarMsgHandler: ((msg: unknown) => Promise<void>) | undefined;
    const mockWebviewView = {
      visible: true,
      webview: {
        options: {},
        html: "",
        onDidReceiveMessage: (cb: (msg: unknown) => Promise<void>) => {
          sidebarMsgHandler = cb;
          return { dispose() {} };
        },
      },
      onDidChangeVisibility: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} }),
    };
    sidebar.resolveWebviewView(mockWebviewView);
    await sidebar.refresh();
    assert.match(mockWebviewView.webview.html, /prefers-reduced-motion:\s*reduce/);
    assert.match(mockWebviewView.webview.html, /body\.vscode-light \.waiting-badge/);
    assert.match(mockWebviewView.webview.html, /@media \(forced-colors: active\)[\s\S]*?\.waiting-badge[\s\S]*?CanvasText/);
    assert.match(mockWebviewView.webview.html, /data-open-waiting="1"/);

    await sidebarMsgHandler?.({
      command: "agentStudio.openStudio",
      sessionId: "wait-1",
      openWaiting: true,
    });
    assert.deepEqual(mock.executedCommands[0], {
      command: "agentStudio.openStudio",
      args: [{ sessionId: "wait-1", openWaiting: true }],
    });
    sidebar.dispose();

    // Verify StudioPanel.createOrShow new panel URL vs existing panel focusSession postMessage
    try {
      await StudioPanel.createOrShow(fakeServerManager, "studio", {
        sessionId: "wait-1",
        openWaiting: true,
      });
      assert.equal(mock.createdPanels.length, 1);
      const panel = mock.createdPanels[0]!;
      assert.match(panel.webview.html, /openWaiting=1/);
      assert.match(panel.webview.html, /agentStudio:focusSession/);
      assert.match(panel.webview.html, /agentStudio:replyToAgent/);
      assert.match(panel.webview.html, /agentStudio:replyResult/);

      const initialHtml = panel.webview.html;
      await StudioPanel.createOrShow(fakeServerManager, "studio", {
        sessionId: "wait-2",
        openWaiting: true,
      });
      assert.equal(mock.createdPanels.length, 1);
      assert.equal(panel.webview.html, initialHtml, "Existing panel should focus via postMessage without reloading iframe");
      assert.deepEqual(panel.webview.postedMessages.at(-1), {
        type: "agentStudio:focusSession",
        sessionId: "wait-2",
        openWaiting: true,
      });
    } finally {
      StudioPanel.currentPanel?.dispose();
    }
  });

  it("handles agentStudio:replyToAgent validation, non-blocking prefill, blocking focus+copy, and command fallback", async () => {
    const mock = createVscodeMock();
    const {
      REPLY_MAX_TEXT_BYTES,
      StudioPanel,
      handleReplyToAgent,
    } = loadExtensionWebviewProviderModule(mock.vscodeMock);
    const { buildScopedViewUrl } = loadExtensionScopingModule();

    const makeDeps = () => ({
      writeClipboard: (text: string) => mock.vscodeMock.env.clipboard.writeText(text),
      getCommands: () => mock.vscodeMock.commands.getCommands(),
      executeCommand: (cmd: string, ...args: unknown[]) =>
        mock.vscodeMock.commands.executeCommand(cmd, ...args),
    });

    // Validation rejections return error without throwing
    const emptyErr = await handleReplyToAgent(
      { requestId: "req-empty", text: "   ", blockingToolCall: false },
      makeDeps(),
    );
    assert.equal(emptyErr.ok, false);
    assert.equal(emptyErr.mode, "error");
    assert.equal(emptyErr.requestId, "req-empty");

    const oversizeErr = await handleReplyToAgent(
      {
        requestId: "req-big",
        text: "a".repeat(REPLY_MAX_TEXT_BYTES + 1),
        blockingToolCall: false,
      },
      makeDeps(),
    );
    assert.equal(oversizeErr.ok, false);
    assert.equal(oversizeErr.mode, "error");
    assert.equal(oversizeErr.requestId, "req-big");

    const badBoolErr = await handleReplyToAgent(
      { requestId: "req-bool", text: "hello", blockingToolCall: "yes" },
      makeDeps(),
    );
    assert.equal(badBoolErr.ok, false);
    assert.equal(badBoolErr.mode, "error");

    // Non-blocking: copy + prefill workbench.action.chat.open
    const prefillRes = await handleReplyToAgent(
      { requestId: "req-1", text: "Proceed with Option A", blockingToolCall: false },
      makeDeps(),
    );
    assert.equal(prefillRes.ok, true);
    assert.equal(prefillRes.mode, "prefilled");
    assert.equal(prefillRes.requestId, "req-1");
    assert.equal(mock.clipboardWrites.at(-1), "Proceed with Option A");
    assert.deepEqual(mock.executedCommands.at(-1), {
      command: "workbench.action.chat.open",
      args: [{ query: "Proceed with Option A", isPartialQuery: true }],
    });

    // Blocking synchronous tool call: copy + focus only (no query args)
    const focusRes = await handleReplyToAgent(
      { requestId: "req-2", text: "Option B", blockingToolCall: true },
      makeDeps(),
    );
    assert.equal(focusRes.ok, true);
    assert.equal(focusRes.mode, "focused_copied");
    assert.equal(focusRes.requestId, "req-2");
    assert.equal(mock.clipboardWrites.at(-1), "Option B");
    assert.deepEqual(mock.executedCommands.at(-1), {
      command: "workbench.action.chat.open",
      args: [],
    });

    // Fallback when workbench.action.chat.open throws
    mock.setExecuteCommandImpl(async () => {
      throw new Error("command unavailable");
    });
    const throwFallback = await handleReplyToAgent(
      { requestId: "req-3", text: "Fallback text", blockingToolCall: true },
      makeDeps(),
    );
    assert.equal(throwFallback.ok, true);
    assert.equal(throwFallback.mode, "copied");
    assert.equal(throwFallback.requestId, "req-3");

    // Fallback when workbench.action.chat.open is not registered on host IDE
    mock.setExecuteCommandImpl(undefined);
    mock.setAvailableCommands([]);
    const missingCmdFallback = await handleReplyToAgent(
      { requestId: "req-4", text: "No chat cmd", blockingToolCall: false },
      makeDeps(),
    );
    assert.equal(missingCmdFallback.ok, true);
    assert.equal(missingCmdFallback.mode, "copied");
    assert.equal(missingCmdFallback.requestId, "req-4");

    // End-to-end StudioPanel webview message relay for agentStudio:replyToAgent
    mock.setAvailableCommands(["workbench.action.chat.open"]);
    const fakeServerManager = {
      ensureRunning: async () => ({ online: true }),
      getStatus: () => ({
        mode: "managed",
        online: true,
        localBaseUrl: "http://127.0.0.1:8767",
        browserBaseUrl: "http://127.0.0.1:8767",
        port: 8767,
      }),
      buildViewUrl: (baseUrl: string, view?: string, projectId?: string, opts?: { embed?: boolean; sessionId?: string }) =>
        buildScopedViewUrl({ baseUrl, view: view as "studio", projectId, sessionId: opts?.sessionId, embed: opts?.embed }),
    };

    try {
      await StudioPanel.createOrShow(fakeServerManager, "studio", "sess-e2e");
      const panel = mock.createdPanels[0]!;
      await panel.webview.emitMessage({
        type: "agentStudio:replyToAgent",
        requestId: "req-e2e",
        text: "Approve plan",
        blockingToolCall: false,
      });
      assert.deepEqual(panel.webview.postedMessages.at(-1), {
        type: "agentStudio:replyResult",
        requestId: "req-e2e",
        ok: true,
        mode: "prefilled",
        message: "Prefilled IDE chat input (and copied to clipboard) — review and press Enter to send.",
      });
    } finally {
      StudioPanel.currentPanel?.dispose();
    }
  });
});
