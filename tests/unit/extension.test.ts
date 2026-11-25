import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";
import type * as ModelSyncModule from "../../extension/src/modelSync.js";
import type * as ScopingModule from "../../extension/src/scoping.js";

function loadExtensionScopingModule(): typeof ScopingModule {
  const srcPath = path.join(REPO_ROOT, "extension", "src", "scoping.ts");
  const source = fs.readFileSync(srcPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
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
    },
  });
  const mod = { exports: {} as Partial<typeof ModelSyncModule> };
  const fn = new Function("exports", "module", outputText);
  fn(mod.exports, mod);
  return mod.exports as typeof ModelSyncModule;
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

    // Embedded extension URL includes embed=1, ide, workspace, view, and project
    const embeddedUrl = new URL(
      buildScopedViewUrl({
        baseUrl: "http://127.0.0.1:8767/",
        view: "doctor",
        projectId: "agent-studio",
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

    // Standalone Open in Browser URL omits embed, ide, and workspace
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

    // Verify extension webview & status bar wire embed=true and scoped session queries
    const webviewSrc = fs.readFileSync(
      path.join(EXT_ROOT, "src", "webviewProvider.ts"),
      "utf8",
    );
    const statusBarSrc = fs.readFileSync(
      path.join(EXT_ROOT, "src", "statusBar.ts"),
      "utf8",
    );
    assert.ok(webviewSrc.includes("{ embed: true }"));
    assert.ok(webviewSrc.includes("buildScopedSessionsQuery("));
    assert.ok(statusBarSrc.includes("buildScopedSessionsQuery("));
  });

  it("modelSync formats Copilot picker labels without duplication, guards missing vscode.lm, and falls back to CLI when offline", async () => {
    const {
      ModelSyncManager,
      formatPickerLabel,
      isLanguageModelApiSupported,
      mapLanguageModelsForHost,
    } = loadExtensionModelSyncModule();

    // Picker formatting + deduplication
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

    // Host scoping: Copilot appends (vendor); Antigravity never injects Copilot picker labels
    const copilotMapped = mapLanguageModelsForHost("copilot-vscode", [
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", vendor: "copilot", family: "claude-sonnet-4.5", maxInputTokens: 200_000 },
      { id: "dup", name: "Claude Sonnet 4.5 (copilot)", vendor: "copilot" },
    ]);
    assert.equal(copilotMapped.length, 1);
    assert.equal(copilotMapped[0]?.id, "Claude Sonnet 4.5 (copilot)");

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
    assert.match(cliCalls[0]?.stdinText ?? "", /Claude Haiku 4\.5 \(copilot\)/);
    offlineMgr.dispose();

    // Verify extension/package.json contributes agentStudio.refreshModelIndex
    const extPkg = JSON.parse(
      fs.readFileSync(path.join(EXT_ROOT, "package.json"), "utf8"),
    ) as { contributes: { commands: Array<{ command: string }> } };
    assert.ok(
      extPkg.contributes.commands.some((c) => c.command === "agentStudio.refreshModelIndex"),
    );
  });
});
