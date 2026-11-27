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
    validateOpenChatTabMessage: (raw: unknown) => {
      sessionId: string;
      agentId: string;
      agentLabel?: string;
      focusQuestion: boolean;
    } | null;
    formatAgentChatPanelTitle: (agentLabel?: string, agentId?: string) => string;
    handleFocusIdeChat: (
      rawRequestId: unknown,
      deps: {
        getCommands(filterInternal?: boolean): Promise<string[]>;
        executeCommand(command: string, ...rest: unknown[]): Promise<unknown>;
      },
    ) => Promise<{
      type: "agentStudio:focusIdeChatResult";
      requestId: string;
      ok: boolean;
      message: string;
    }>;
    StudioPanel: {
      currentPanel: { dispose(): void } | undefined;
      createOrShow: (
        serverManager: unknown,
        view?: string,
        sessionIdOrOptions?:
          | string
          | { sessionId?: string; openWaiting?: boolean; openChatAgentId?: string },
      ) => Promise<void>;
    };
    AgentChatPanel: {
      viewType: string;
      currentPanel: { dispose(): void } | undefined;
      createOrShow: (
        serverManager: unknown,
        target: {
          sessionId: string;
          agentId: string;
          agentLabel?: string;
          focusQuestion?: boolean;
        },
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

  it("sidebar renders waiting badges/summaries and StudioPanel supports openWaiting/openChat deep-links and focusSession reuse", async () => {
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
        openChatAgentId: "architect",
        embed: true,
        hostIde: "copilot-vscode",
        workspaceRoot: "C:\\Repo",
      }),
    );
    assert.equal(scopedUrl.searchParams.get("embed"), "1");
    assert.equal(scopedUrl.searchParams.get("openWaiting"), "1");
    assert.equal(scopedUrl.searchParams.get("openChat"), "architect");
    const appended = new URL(
      appendDeepLinkParams("http://127.0.0.1:8767/?embed=1&session=s1", {
        openWaiting: true,
        openChatAgentId: "qa",
      }),
    );
    assert.equal(appended.searchParams.get("openWaiting"), "1");
    assert.equal(appended.searchParams.get("openChat"), "qa");

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
        openChatAgentId: "backend",
      });
      assert.equal(mock.createdPanels.length, 1);
      const panel = mock.createdPanels[0]!;
      assert.match(panel.webview.html, /openWaiting=1/);
      assert.match(panel.webview.html, /openChat=backend/);
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

  it("scoping supports chat view, agentId, and focusQuestion while preserving openChatAgentId", () => {
    const { buildScopedViewUrl } = loadExtensionScopingModule();

    const chatUrl = new URL(
      buildScopedViewUrl({
        baseUrl: "http://127.0.0.1:8767",
        view: "chat",
        projectId: "agent-studio",
        sessionId: "sess-chat-1",
        agentId: "  backend-engineer  ",
        focusQuestion: true,
        embed: true,
        hostIde: "antigravity",
        workspaceRoot: "D:\\Work\\Personal\\AgentVisualizer",
      }),
    );
    assert.equal(chatUrl.searchParams.get("embed"), "1");
    assert.equal(chatUrl.searchParams.get("ide"), "antigravity");
    assert.equal(
      chatUrl.searchParams.get("workspace"),
      "D:/Work/Personal/AgentVisualizer",
    );
    assert.equal(chatUrl.searchParams.get("view"), "chat");
    assert.equal(chatUrl.searchParams.get("project"), "agent-studio");
    assert.equal(chatUrl.searchParams.get("session"), "sess-chat-1");
    assert.equal(chatUrl.searchParams.get("agent"), "backend-engineer");
    assert.equal(chatUrl.searchParams.get("focusQuestion"), "1");
    assert.equal(chatUrl.searchParams.get("openChat"), null);

    // Blank agentId and focusQuestion=false are omitted; openChatAgentId remains intact
    const noFocusUrl = new URL(
      buildScopedViewUrl({
        baseUrl: "http://127.0.0.1:8767",
        view: "studio",
        agentId: "   ",
        focusQuestion: false,
        openChatAgentId: "architect",
      }),
    );
    assert.equal(noFocusUrl.searchParams.get("agent"), null);
    assert.equal(noFocusUrl.searchParams.get("focusQuestion"), null);
    assert.equal(noFocusUrl.searchParams.get("openChat"), "architect");
  });

  it("validates openChatTab payloads, formats chat panel titles, and handles focusIdeChat", async () => {
    const mock = createVscodeMock();
    const {
      validateOpenChatTabMessage,
      validateReplyToAgentMessage,
      formatAgentChatPanelTitle,
      handleFocusIdeChat,
    } = loadExtensionWebviewProviderModule(mock.vscodeMock);

    // validateOpenChatTabMessage accepts valid payloads, trims/caps agentLabel, ignores ide/workspace
    assert.deepEqual(
      validateOpenChatTabMessage({
        type: "agentStudio:openChatTab",
        sessionId: "  sess-123  ",
        agentId: "  architect  ",
        agentLabel: "  Lead\x07 Architect  ",
        focusQuestion: true,
        ide: "claude-code",
        workspace: "/evil/other/workspace",
      }),
      {
        sessionId: "sess-123",
        agentId: "architect",
        agentLabel: "Lead Architect",
        focusQuestion: true,
      },
    );

    const longLabel = "A".repeat(150);
    const truncated = validateOpenChatTabMessage({
      sessionId: "s1",
      agentId: "a1",
      agentLabel: longLabel,
    });
    assert.equal(truncated?.agentLabel?.length, 120);
    assert.equal(truncated?.focusQuestion, false);

    // Rejects invalid / empty / oversized / control-char payloads
    assert.equal(validateOpenChatTabMessage(null), null);
    assert.equal(validateOpenChatTabMessage([]), null);
    assert.equal(validateOpenChatTabMessage({ sessionId: "   ", agentId: "a1" }), null);
    assert.equal(validateOpenChatTabMessage({ sessionId: "s1", agentId: "" }), null);
    assert.equal(
      validateOpenChatTabMessage({ sessionId: "a".repeat(257), agentId: "a1" }),
      null,
    );
    assert.equal(
      validateOpenChatTabMessage({ sessionId: "s1", agentId: "b".repeat(257) }),
      null,
    );
    assert.equal(
      validateOpenChatTabMessage({ sessionId: "s1\n", agentId: "a1" }),
      null,
    );
    assert.equal(
      validateOpenChatTabMessage({ sessionId: "s1", agentId: "a1\x1b" }),
      null,
    );

    // formatAgentChatPanelTitle
    assert.equal(formatAgentChatPanelTitle("Backend Engineer", "backend"), "Chat: Backend Engineer");
    assert.equal(formatAgentChatPanelTitle("   ", "backend-engineer"), "Chat: backend-engineer");
    assert.equal(formatAgentChatPanelTitle(undefined, undefined), "Chat: Agent");
    assert.equal(formatAgentChatPanelTitle("QA\n\t Validator", "qa"), "Chat: QA Validator");
    const longTitle = formatAgentChatPanelTitle("Very Long Agent Display Name That Exceeds Forty Eight Characters");
    assert.ok(longTitle.length <= 48);
    assert.ok(longTitle.startsWith("Chat: "));
    assert.ok(longTitle.endsWith("…"));

    // validateReplyToAgentMessage must continue rejecting empty text
    const emptyReply = validateReplyToAgentMessage({
      requestId: "r-empty",
      text: "   ",
      blockingToolCall: false,
    });
    assert.equal(emptyReply.ok, false);

    // handleFocusIdeChat: available -> executes workbench.action.chat.open with no args
    const focusDeps = {
      getCommands: (filterInternal?: boolean) =>
        mock.vscodeMock.commands.getCommands(filterInternal),
      executeCommand: (cmd: string, ...args: unknown[]) =>
        mock.vscodeMock.commands.executeCommand(cmd, ...args),
    };
    const okRes = await handleFocusIdeChat("  req-focus-1  ", focusDeps);
    assert.deepEqual(okRes, {
      type: "agentStudio:focusIdeChatResult",
      requestId: "req-focus-1",
      ok: true,
      message: "Focused IDE chat.",
    });
    assert.deepEqual(mock.executedCommands.at(-1), {
      command: "workbench.action.chat.open",
      args: [],
    });

    // Oversized requestId normalizes to ""
    const bigReqRes = await handleFocusIdeChat("x".repeat(257), focusDeps);
    assert.equal(bigReqRes.requestId, "");
    assert.equal(bigReqRes.ok, true);

    // Unavailable command -> ok: false
    mock.setAvailableCommands(["some.other.command"]);
    const unavailRes = await handleFocusIdeChat("req-focus-2", focusDeps);
    assert.deepEqual(unavailRes, {
      type: "agentStudio:focusIdeChatResult",
      requestId: "req-focus-2",
      ok: false,
      message: "IDE chat command is not available in this host.",
    });

    // Command execution throws -> ok: false
    mock.setAvailableCommands(["workbench.action.chat.open"]);
    mock.setExecuteCommandImpl(async () => {
      throw new Error("boom");
    });
    const errRes = await handleFocusIdeChat("req-focus-3", focusDeps);
    assert.deepEqual(errRes, {
      type: "agentStudio:focusIdeChatResult",
      requestId: "req-focus-3",
      ok: false,
      message: "IDE chat command is not available in this host.",
    });
  });

  it("AgentChatPanel opens reusable side tab, performs race-free chatTabReady hot-switching, relays messages, and disposes cleanly", async () => {
    const mock = createVscodeMock();
    const {
      AgentChatPanel,
      StudioPanel,
    } = loadExtensionWebviewProviderModule(mock.vscodeMock);
    const { buildScopedViewUrl } = loadExtensionScopingModule();

    let serverOnline = true;
    let statusListener: ((status: { mode: string; online: boolean; localBaseUrl: string; browserBaseUrl: string; port: number }) => void) | undefined;
    const fakeServerManager = {
      onStatusChanged: (
        cb: (status: { mode: string; online: boolean; localBaseUrl: string; browserBaseUrl: string; port: number }) => void,
      ) => {
        statusListener = cb;
        return { dispose() {} };
      },
      ensureRunning: async () => ({
        mode: serverOnline ? "managed" : "offline",
        online: serverOnline,
        localBaseUrl: "http://127.0.0.1:8767",
        browserBaseUrl: "http://127.0.0.1:8767",
        port: 8767,
      }),
      getStatus: () => ({
        mode: serverOnline ? "managed" : "offline",
        online: serverOnline,
        localBaseUrl: "http://127.0.0.1:8767",
        browserBaseUrl: "http://127.0.0.1:8767",
        port: 8767,
      }),
      buildViewUrl: (
        baseUrl: string,
        view?: string,
        projectId?: string,
        opts?: {
          embed?: boolean;
          sessionId?: string;
          agentId?: string;
          focusQuestion?: boolean;
        },
      ) =>
        buildScopedViewUrl({
          baseUrl,
          view: view as "studio" | "chat" | undefined,
          projectId: projectId ?? "agent-studio",
          sessionId: opts?.sessionId,
          agentId: opts?.agentId,
          focusQuestion: opts?.focusQuestion,
          embed: opts?.embed,
          hostIde: "copilot-vscode",
          workspaceRoot: "D:\\Work\\Personal\\AgentVisualizer",
        }),
    };

    try {
      // 1. Cold open creates a single ViewColumn.Beside panel with chat URL
      await AgentChatPanel.createOrShow(fakeServerManager, {
        sessionId: "sess-1",
        agentId: "architect",
        agentLabel: "Architect",
        focusQuestion: true,
      });

      assert.ok(AgentChatPanel.currentPanel);
      assert.equal(mock.createdPanels.length, 1);
      const chatPanel = mock.createdPanels[0]!;
      assert.equal(chatPanel.viewType, AgentChatPanel.viewType);
      assert.equal(chatPanel.title, "Chat: Architect");
      assert.deepEqual(chatPanel.showOptions, {
        viewColumn: mock.vscodeMock.ViewColumn.Beside,
        preserveFocus: false,
      });
      assert.deepEqual(chatPanel.webviewOptions, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });

      const initialHtml = chatPanel.webview.html;
      assert.match(initialHtml, /view=chat/);
      assert.match(initialHtml, /embed=1/);
      assert.match(initialHtml, /session=sess-1/);
      assert.match(initialHtml, /agent=architect/);
      assert.match(initialHtml, /focusQuestion=1/);
      assert.match(initialHtml, /agentStudio:openChatTab/);
      assert.match(initialHtml, /agentStudio:chatTabReady/);
      assert.match(initialHtml, /agentStudio:showAgentChat/);
      assert.match(initialHtml, /agentStudio:focusIdeChat/);
      assert.match(initialHtml, /agentStudio:focusIdeChatResult/);

      // 2. Calling createOrShow BEFORE chatTabReady queues pendingTarget (latest-wins) without resetting HTML or posting prematurely
      await AgentChatPanel.createOrShow(fakeServerManager, {
        sessionId: "sess-1",
        agentId: "backend",
        agentLabel: "Backend",
        focusQuestion: false,
      });
      await AgentChatPanel.createOrShow(fakeServerManager, {
        sessionId: "sess-2",
        agentId: "qa",
        agentLabel: "QA Validator",
        focusQuestion: true,
      });

      assert.equal(mock.createdPanels.length, 1);
      assert.equal(chatPanel.webview.html, initialHtml);
      assert.equal(chatPanel.title, "Chat: QA Validator");
      assert.deepEqual(chatPanel.revealedCalls.at(-1), {
        viewColumn: mock.vscodeMock.ViewColumn.Beside,
        preserveFocus: false,
      });
      assert.equal(
        chatPanel.webview.postedMessages.filter(
          (m) => (m as { type?: string }).type === "agentStudio:showAgentChat",
        ).length,
        0,
        "Must not post showAgentChat before iframe signals agentStudio:chatTabReady",
      );

      // 3. Receiving agentStudio:chatTabReady flushes only the latest pending target
      await chatPanel.webview.emitMessage({ type: "agentStudio:chatTabReady" });
      assert.deepEqual(chatPanel.webview.postedMessages.at(-1), {
        type: "agentStudio:showAgentChat",
        sessionId: "sess-2",
        agentId: "qa",
        agentLabel: "QA Validator",
        focusQuestion: true,
      });

      // 4. Subsequent createOrShow AFTER iframeReady immediately posts showAgentChat without reloading HTML
      await AgentChatPanel.createOrShow(fakeServerManager, {
        sessionId: "sess-3",
        agentId: "frontend",
        agentLabel: "Frontend",
        focusQuestion: false,
      });
      assert.equal(chatPanel.webview.html, initialHtml);
      assert.equal(chatPanel.title, "Chat: Frontend");
      assert.deepEqual(chatPanel.webview.postedMessages.at(-1), {
        type: "agentStudio:showAgentChat",
        sessionId: "sess-3",
        agentId: "frontend",
        agentLabel: "Frontend",
        focusQuestion: false,
      });

      // 5. agentStudio:openChatTab inside AgentChatPanel re-targets itself cleanly
      await chatPanel.webview.emitMessage({
        type: "agentStudio:openChatTab",
        sessionId: "sess-4",
        agentId: "ux",
        agentLabel: "UX Designer",
        focusQuestion: true,
      });
      assert.equal(mock.createdPanels.length, 1);
      assert.equal(chatPanel.title, "Chat: UX Designer");
      assert.deepEqual(chatPanel.webview.postedMessages.at(-1), {
        type: "agentStudio:showAgentChat",
        sessionId: "sess-4",
        agentId: "ux",
        agentLabel: "UX Designer",
        focusQuestion: true,
      });

      // 6. agentStudio:focusIdeChat and agentStudio:replyToAgent inside AgentChatPanel
      assert.match(chatPanel.webview.html, /agentStudio\.openFile/);
      assert.match(chatPanel.webview.html, /agentStudio:openFile/);
      assert.match(chatPanel.webview.html, /agentStudio:replyResult/);

      await chatPanel.webview.emitMessage({
        type: "agentStudio:focusIdeChat",
        requestId: "chat-focus-1",
      });
      assert.deepEqual(chatPanel.webview.postedMessages.at(-1), {
        type: "agentStudio:focusIdeChatResult",
        requestId: "chat-focus-1",
        ok: true,
        message: "Focused IDE chat.",
      });

      await chatPanel.webview.emitMessage({
        type: "agentStudio:replyToAgent",
        requestId: "chat-reply-1",
        text: "Proceed with option B",
        blockingToolCall: false,
      });
      assert.deepEqual(chatPanel.webview.postedMessages.at(-1), {
        type: "agentStudio:replyResult",
        requestId: "chat-reply-1",
        ok: true,
        mode: "prefilled",
        message:
          "Prefilled IDE chat input (and copied to clipboard) — review and press Enter to send.",
      });

      // 7. Server offline -> online recovery re-renders currentTarget
      serverOnline = false;
      statusListener?.({
        mode: "offline",
        online: false,
        localBaseUrl: "http://127.0.0.1:8767",
        browserBaseUrl: "http://127.0.0.1:8767",
        port: 8767,
      });
      serverOnline = true;
      statusListener?.({
        mode: "managed",
        online: true,
        localBaseUrl: "http://127.0.0.1:8767",
        browserBaseUrl: "http://127.0.0.1:8767",
        port: 8767,
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.match(chatPanel.webview.html, /session=sess-4/);
      assert.match(chatPanel.webview.html, /agent=ux/);

      // 8. StudioPanel relays agentStudio:openChatTab into AgentChatPanel and handles agentStudio:focusIdeChat
      await StudioPanel.createOrShow(fakeServerManager, "studio", "sess-studio");
      assert.equal(mock.createdPanels.length, 2);
      const studioPanel = mock.createdPanels[1]!;

      await studioPanel.webview.emitMessage({
        type: "agentStudio:openChatTab",
        sessionId: "sess-from-studio",
        agentId: "reviewer",
        agentLabel: "Code Reviewer",
        focusQuestion: false,
        ide: "claude-code",
        workspace: "/spoofed",
      });
      assert.equal(mock.createdPanels.length, 2, "Should reuse existing AgentChatPanel");
      assert.equal(chatPanel.title, "Chat: Code Reviewer");
      assert.match(
        chatPanel.webview.html,
        /ide=copilot-vscode/,
        "Host scoping must remain locked to host IDE",
      );

      // Invalid openChatTab payload is ignored
      await studioPanel.webview.emitMessage({
        type: "agentStudio:openChatTab",
        sessionId: "",
        agentId: "reviewer",
      });
      assert.equal(chatPanel.title, "Chat: Code Reviewer");

      // StudioPanel also supports agentStudio:focusIdeChat and reuse with openChatAgentId
      await studioPanel.webview.emitMessage({
        type: "agentStudio:focusIdeChat",
        requestId: "studio-focus-1",
      });
      assert.deepEqual(studioPanel.webview.postedMessages.at(-1), {
        type: "agentStudio:focusIdeChatResult",
        requestId: "studio-focus-1",
        ok: true,
        message: "Focused IDE chat.",
      });

      const studioInitialHtml = studioPanel.webview.html;
      await StudioPanel.createOrShow(fakeServerManager, "studio", {
        sessionId: "sess-studio-2",
        openChatAgentId: "backend",
      });
      assert.equal(mock.createdPanels.length, 2, "StudioPanel should reuse existing panel");
      assert.equal(studioPanel.webview.html, studioInitialHtml);
      assert.deepEqual(studioPanel.webview.postedMessages.at(-1), {
        type: "agentStudio:focusSession",
        sessionId: "sess-studio-2",
        openChatAgentId: "backend",
      });

      // 9. dispose() clears AgentChatPanel.currentPanel so next open creates a new panel
      AgentChatPanel.currentPanel?.dispose();
      assert.equal(AgentChatPanel.currentPanel, undefined);
      await AgentChatPanel.createOrShow(fakeServerManager, {
        sessionId: "sess-5",
        agentId: "qa",
      });
      assert.equal(mock.createdPanels.length, 3);
      assert.equal(mock.createdPanels[2]!.title, "Chat: qa");
    } finally {
      AgentChatPanel.currentPanel?.dispose();
      StudioPanel.currentPanel?.dispose();
    }
  });

  it("serializes concurrent AgentChatPanel.createOrShow cold-open and out-of-order showTarget calls", async () => {
    const mock = createVscodeMock();
    const { AgentChatPanel } = loadExtensionWebviewProviderModule(mock.vscodeMock);
    const { buildScopedViewUrl } = loadExtensionScopingModule();

    let resolveEnsure!: (val: {
      mode: string;
      online: boolean;
      localBaseUrl: string;
      browserBaseUrl: string;
      port: number;
    }) => void;
    const ensurePromise = new Promise<{
      mode: string;
      online: boolean;
      localBaseUrl: string;
      browserBaseUrl: string;
      port: number;
    }>((resolve) => {
      resolveEnsure = resolve;
    });

    const slowServerManager = {
      ensureRunning: () => ensurePromise,
      getStatus: () => ({
        mode: "managed",
        online: true,
        localBaseUrl: "http://127.0.0.1:8767",
        browserBaseUrl: "http://127.0.0.1:8767",
        port: 8767,
      }),
      buildViewUrl: (
        baseUrl: string,
        view?: string,
        projectId?: string,
        opts?: {
          embed?: boolean;
          sessionId?: string;
          agentId?: string;
          focusQuestion?: boolean;
        },
      ) =>
        buildScopedViewUrl({
          baseUrl,
          view: view as "studio" | "chat" | undefined,
          projectId: projectId ?? "agent-studio",
          sessionId: opts?.sessionId,
          agentId: opts?.agentId,
          focusQuestion: opts?.focusQuestion,
          embed: opts?.embed,
          hostIde: "antigravity",
          workspaceRoot: "D:\\Work\\Personal\\AgentVisualizer",
        }),
    };

    try {
      // Fire two concurrent cold-open calls while ensureRunning is still pending
      const p1 = AgentChatPanel.createOrShow(slowServerManager, {
        sessionId: "sess-race-1",
        agentId: "architect",
        agentLabel: "Architect",
        focusQuestion: false,
      });
      const p2 = AgentChatPanel.createOrShow(slowServerManager, {
        sessionId: "sess-race-2",
        agentId: "backend",
        agentLabel: "Backend Engineer",
        focusQuestion: true,
      });

      assert.equal(mock.createdPanels.length, 0);
      resolveEnsure({
        mode: "managed",
        online: true,
        localBaseUrl: "http://127.0.0.1:8767",
        browserBaseUrl: "http://127.0.0.1:8767",
        port: 8767,
      });
      await Promise.all([p1, p2]);

      assert.equal(
        mock.createdPanels.length,
        1,
        "Concurrent cold-open must create at most one WebviewPanel",
      );
      const panel = mock.createdPanels[0]!;
      assert.equal(panel.title, "Chat: Backend Engineer");
      assert.match(panel.webview.html, /session=sess-race-2/);
      assert.match(panel.webview.html, /agent=backend/);
      assert.match(panel.webview.html, /focusQuestion=1/);

      // A third target arriving before chatTabReady routes cleanly via showAgentChat after ready
      await AgentChatPanel.createOrShow(slowServerManager, {
        sessionId: "sess-race-3",
        agentId: "qa",
        agentLabel: "QA Validator",
        focusQuestion: false,
      });
      assert.equal(mock.createdPanels.length, 1);
      assert.equal(panel.title, "Chat: QA Validator");
      await panel.webview.emitMessage({ type: "agentStudio:chatTabReady" });
      assert.deepEqual(panel.webview.postedMessages.at(-1), {
        type: "agentStudio:showAgentChat",
        sessionId: "sess-race-3",
        agentId: "qa",
        agentLabel: "QA Validator",
        focusQuestion: false,
      });
    } finally {
      AgentChatPanel.currentPanel?.dispose();
    }
  });
});
