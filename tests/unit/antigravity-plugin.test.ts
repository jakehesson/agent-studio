import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(process.cwd());
const BUILD_SCRIPT = path.join(
  REPO_ROOT,
  "antigravity-plugin",
  "scripts",
  "build-plugin.mjs",
);

const ALLOWED_PLUGIN_JSON_KEYS = new Set([
  "name",
  "displayName",
  "version",
  "description",
  "logo",
  "suggestedPrompts",
  "author",
  "homepage",
  "repository",
  "disabled",
]);

describe("Native Antigravity MCP App Plugin Packager", () => {
  it("builds and installs a schema-compliant Antigravity plugin bundle with standalone MCP binary", () => {
    const rootPkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { version: string };

    const tmpInstallDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "av-agy-plugin-"),
    );

    try {
      execFileSync(
        process.execPath,
        [BUILD_SCRIPT, "--install-dir", tmpInstallDir],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 30_000,
        },
      );

      // 1. Validate plugin.json strict schema (only allowed top-level fields)
      const pluginJsonPath = path.join(tmpInstallDir, "plugin.json");
      assert.ok(fs.existsSync(pluginJsonPath), "Missing plugin.json");
      const pluginJson = JSON.parse(
        fs.readFileSync(pluginJsonPath, "utf8"),
      ) as Record<string, unknown>;

      for (const key of Object.keys(pluginJson)) {
        assert.ok(
          ALLOWED_PLUGIN_JSON_KEYS.has(key),
          `Disallowed top-level key in plugin.json: ${key}`,
        );
      }
      assert.equal(pluginJson.name, "agent-studio");
      assert.equal(pluginJson.displayName, "Agent Studio");
      assert.equal(pluginJson.version, rootPkg.version);
      assert.equal(pluginJson.logo, "assets/logo.svg");
      assert.ok(
        Array.isArray(pluginJson.suggestedPrompts) &&
          pluginJson.suggestedPrompts.length === 3,
        "plugin.json should include 3 suggestedPrompts",
      );

      // 2. Validate mcp_config.json uses ${PLUGIN_ROOT}, ${PLUGIN_DATA}, and prefixed server name
      const mcpConfigPath = path.join(tmpInstallDir, "mcp_config.json");
      assert.ok(fs.existsSync(mcpConfigPath), "Missing mcp_config.json");
      const mcpConfig = JSON.parse(
        fs.readFileSync(mcpConfigPath, "utf8"),
      ) as {
        mcpServers: Record<
          string,
          { command: string; args: string[]; env?: Record<string, string> }
        >;
      };
      const serverEntry = mcpConfig.mcpServers["agent-studio-app"];
      assert.ok(
        serverEntry,
        'mcp_config.json must declare prefixed server "agent-studio-app"',
      );
      assert.equal(serverEntry.command, "node");
      assert.deepEqual(serverEntry.args, [
        "${PLUGIN_ROOT}/bin/agent-studio-mcp.mjs",
        "mcp",
      ]);
      assert.equal(
        serverEntry.env?.AGENT_STUDIO_APP_HTML,
        "${PLUGIN_ROOT}/bin/app.html",
      );
      assert.equal(serverEntry.env?.AGENT_STUDIO_DATA_DIR, "${PLUGIN_DATA}");

      // 3. Validate bundled assets, agent, skills, and plain-Markdown rules
      const expectedFiles = [
        "assets/logo.svg",
        "bin/agent-studio-mcp.mjs",
        "bin/app.html",
        "agents/team-setup.md",
        "skills/team-setup/SKILL.md",
        "skills/token-efficiency/SKILL.md",
        "rules/AGENTS.md",
      ];
      for (const rel of expectedFiles) {
        const abs = path.join(tmpInstallDir, rel);
        assert.ok(fs.existsSync(abs), `Missing packaged plugin file: ${rel}`);
      }

      const rulesText = fs.readFileSync(
        path.join(tmpInstallDir, "rules", "AGENTS.md"),
        "utf8",
      );
      assert.ok(
        !rulesText.trimStart().startsWith("---"),
        "rules/AGENTS.md must be plain Markdown without YAML frontmatter",
      );
      assert.ok(rulesText.includes("Token & Context Discipline"));

      const htmlText = fs.readFileSync(
        path.join(tmpInstallDir, "bin", "app.html"),
        "utf8",
      );
      assert.match(htmlText, /<!doctype html/i);

      // 4. Verify bundled bin/agent-studio-mcp.mjs runs standalone and reports exact version
      const binPath = path.join(tmpInstallDir, "bin", "agent-studio-mcp.mjs");
      const versionOut = execFileSync(process.execPath, [binPath, "--version"], {
        cwd: tmpInstallDir,
        encoding: "utf8",
        timeout: 10_000,
      }).trim();
      assert.equal(versionOut, rootPkg.version);
    } finally {
      fs.rmSync(tmpInstallDir, { recursive: true, force: true });
    }
  });
});
