import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginSrcRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pluginSrcRoot, "..");
const distDir = path.join(pluginSrcRoot, "dist");

function loadEsbuild() {
  const rootReq = createRequire(path.join(repoRoot, "package.json"));
  try {
    return rootReq("esbuild");
  } catch {
    const extReq = createRequire(
      path.join(repoRoot, "extension", "package.json"),
    );
    return extReq("esbuild");
  }
}

function parseFlags(argv) {
  let install = false;
  let installDir = null;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--install") {
      install = true;
    } else if (tok === "--install-dir" && argv[i + 1]) {
      installDir = argv[++i];
    } else if (tok && tok.startsWith("--install-dir=")) {
      installDir = tok.slice("--install-dir=".length);
    }
  }
  return { install, installDir };
}

function resolveDefaultAntigravityPluginDir() {
  const home = process.env.HOME?.trim() || os.homedir();
  return path.join(home, ".gemini", "config", "plugins", "agent-studio");
}

function writeFileEnsure(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

const FALLBACK_APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Studio</title>
  <style>
    body { margin: 0; padding: 24px; font-family: var(--font-sans, system-ui, sans-serif); background: var(--color-background-primary, #0b1020); color: var(--color-text-primary, #e2e8f0); }
    .card { max-width: 560px; margin: 0 auto; padding: 20px; border-radius: 12px; border: 1px solid var(--color-border-primary, #1e293b); background: var(--color-background-secondary, #111827); }
    h1 { margin: 0 0 8px; font-size: 1.15rem; }
    p { margin: 0; line-height: 1.5; color: var(--color-text-secondary, #94a3b8); }
  </style>
</head>
<body>
  <div class="card">
    <h1>Agent Studio MCP App</h1>
    <p>Run <code>npm --prefix web run build:mcp-app</code> and rebuild the plugin to embed the full interactive Agent Studio UI.</p>
  </div>
</body>
</html>
`;

const TOKEN_EFFICIENCY_RULES = `# Agent Studio — Token & Context Discipline (Core — All Agents)

1. **Memory first:** Check workspace quickref skills (\`*-quickref/SKILL.md\`) and \`AGENTS.md\` before exploring; trust verified paths, endpoints, and commands.
2. **Targeted reads:** Search first (\`rg\` / \`Select-String\`), then read narrow line ranges. Never dump whole large files, lockfiles, minified bundles, or huge JSON logs.
3. **Cap output:** Pipe noisy commands through head/tail/limit filters (\`Select-Object -First/-Last N\`, \`head\`/\`tail\`, \`--quiet\`).
4. **Batch calls:** Issue independent searches, reads, and edits in parallel in one turn; chain shell commands instead of one-call loops.
5. **Delegate breadth:** For 5+ file surveys or transcript/log mining, delegate to a scoped subagent with an explicit word cap and output format.
6. **Minimal edits:** Use small, surgical diffs; never rewrite whole files or re-read immediately after a clean edit.
7. **No script sprawl:** Keep throwaway probes out of the repo; extend existing helpers rather than adding one-off scripts.
8. **Concise replies:** Don't restate tool output or artifact contents; skip ceremony on simple tasks.
9. **Persist learnings:** Record durable verified facts (working commands, quirks, endpoints, fixes) in workspace quickrefs; never store secrets.
10. **Reuse subagent read-only checks:** Pass verified diagnostic/read-only findings forward into follow-on agent briefs instead of re-running redundant checks.
`;

const TEAM_SETUP_AGENT_MD = `---
name: team-setup
description: >-
  Cross-IDE AI Setup Agent that inspects any repository, tailors .agent-team/,
  compiles Antigravity / Claude Code / GitHub Copilot adapters, and verifies health.
mainAgent: true
subagent: true
inheritCustomizations: true
inheritMcp: true
tools:
  - read_file
  - write_file
  - edit_file
  - run_command
  - ask_question
---

# Agent Studio — Cross-IDE AI Setup Agent (\`team-setup\`)

You are **\`team-setup\`**, the Cross-IDE Onboarding & Configuration Agent for **Agent Studio**.

## Workflow
1. Inspect root build/config files (\`package.json\`, \`pyproject.toml\`, \`Cargo.toml\`, \`go.mod\`, existing \`.agent-team/\`, \`pipeline/board.json\`) and perform deep architectural research (topology, module boundaries, state/concurrency contracts, invariants, and failure modes — delegating 5+ file surveys to a read-only \`research\` subagent).
2. Confirm target IDEs (\`antigravity\`, \`claude-code\`, \`copilot-vscode\`), specialist roles (including \`code-reviewer\`), model routing policy, and QA gate checkpoints (\`CP0\`, \`CP1\`, \`CP2\`) with the user.
3. Run \`agent-studio init --ides antigravity,claude-code,copilot-vscode --non-interactive\` (if \`agent-studio\` is not on \`PATH\`, use \`node ~/.agent-studio/bin/studio-cli.mjs ...\`; preserves any existing \`pipeline/board.json\`).
4. Edit ONLY \`.agent-team/team.yaml\`, \`.agent-team/model-index.json\`, \`.agent-team/agents/*.md\`, and \`.agent-team/skills/*/SKILL.md\`. Populate \`.agent-team/skills/architecture-review/SKILL.md\` (removing the \`PENDING DEEP RESEARCH\` marker) and tailor \`.agent-team/agents/code-reviewer.md\` with the repository's concrete invariants and review rubric.
5. Run \`agent-studio sync\`, \`agent-studio sync --check\`, and \`agent-studio doctor\`, then open **Agent Studio** via the \`open_studio\` MCP App tool.
`;

async function main() {
  const { install, installDir } = parseFlags(process.argv.slice(2));
  const { build } = loadEsbuild();

  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const version =
    typeof rootPkg.version === "string" && rootPkg.version.trim()
      ? rootPkg.version.trim()
      : "0.3.0";

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(distDir, "bin"), { recursive: true });

  // 1. Bundle standalone MCP + CLI binary into antigravity-plugin/dist/bin/agent-studio-mcp.mjs
  await build({
    entryPoints: [path.join(repoRoot, "src", "cli", "index.ts")],
    outfile: path.join(distDir, "bin", "agent-studio-mcp.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: false,
    minify: false,
    define: {
      __AGENT_STUDIO_VERSION__: JSON.stringify(version),
    },
    banner: {
      js: 'import { createRequire as __agentStudioCreateRequire } from "node:module"; const require = __agentStudioCreateRequire(import.meta.url);',
    },
    logLevel: "info",
  });

  // 2. Copy single-file SEP-1865 MCP App HTML (or fallback placeholder if not built yet)
  const builtAppHtml = path.join(repoRoot, "dist", "mcp-app", "app.html");
  const targetAppHtml = path.join(distDir, "bin", "app.html");
  let usedRealHtml = false;
  if (fs.existsSync(builtAppHtml)) {
    fs.copyFileSync(builtAppHtml, targetAppHtml);
    usedRealHtml = true;
  } else {
    writeFileEnsure(targetAppHtml, FALLBACK_APP_HTML);
  }

  // 3. Copy square 128x128 SVG logo
  const logoSrc = path.join(pluginSrcRoot, "assets", "logo.svg");
  const logoDest = path.join(distDir, "assets", "logo.svg");
  fs.mkdirSync(path.dirname(logoDest), { recursive: true });
  fs.copyFileSync(logoSrc, logoDest);

  // 4. Write strict-schema plugin.json (ONLY allowed top-level fields)
  const pluginJson = {
    name: "agent-studio",
    displayName: "Agent Studio",
    version,
    description:
      "Native Antigravity MCP App for live multi-agent topology monitoring, video timeline scrubbing, team roster inspection, QA-gated Agile Board, and workspace diagnostics.",
    author: "Jake Hesson",
    homepage: "https://github.com/jakehesson/agent-studio#readme",
    repository: "https://github.com/jakehesson/agent-studio.git",
    logo: "assets/logo.svg",
    suggestedPrompts: [
      "Open Agent Studio to monitor active subagents and inspect the sprint board",
      "Use team-setup to onboard this repository to Agent Studio and run doctor",
      "Check sprint status and next unblocked items on the Agent Studio board",
    ],
  };
  writeFileEnsure(
    path.join(distDir, "plugin.json"),
    JSON.stringify(pluginJson, null, 2) + "\n",
  );

  // 5. Write mcp_config.json with prefixed server name "agent-studio-app"
  const mcpConfig = {
    mcpServers: {
      "agent-studio-app": {
        command: "node",
        args: ["${PLUGIN_ROOT}/bin/agent-studio-mcp.mjs", "mcp"],
        env: {
          AGENT_STUDIO_APP_HTML: "${PLUGIN_ROOT}/bin/app.html",
          AGENT_STUDIO_DATA_DIR: "${PLUGIN_DATA}",
        },
      },
    },
  };
  writeFileEnsure(
    path.join(distDir, "mcp_config.json"),
    JSON.stringify(mcpConfig, null, 2) + "\n",
  );

  // 6. Write agent, skills, and plain-Markdown always-on rules
  writeFileEnsure(
    path.join(distDir, "agents", "team-setup.md"),
    TEAM_SETUP_AGENT_MD,
  );
  writeFileEnsure(
    path.join(distDir, "rules", "AGENTS.md"),
    TOKEN_EFFICIENCY_RULES,
  );

  for (const skillId of [
    "team-setup",
    "token-efficiency",
    "code-review",
    "architecture-review",
    "learn",
  ]) {
    const canonicalSkill = path.join(
      repoRoot,
      ".agent-team",
      "skills",
      skillId,
      "SKILL.md",
    );
    const destSkill = path.join(distDir, "skills", skillId, "SKILL.md");
    if (fs.existsSync(canonicalSkill)) {
      fs.mkdirSync(path.dirname(destSkill), { recursive: true });
      fs.copyFileSync(canonicalSkill, destSkill);
    } else {
      throw new Error(`Missing canonical skill source: ${canonicalSkill}`);
    }
  }

  const binSizeKb = (
    fs.statSync(path.join(distDir, "bin", "agent-studio-mcp.mjs")).size / 1024
  ).toFixed(1);
  const htmlSizeKb = (fs.statSync(targetAppHtml).size / 1024).toFixed(1);
  console.log(
    `[antigravity-plugin] Built v${version} in ${distDir} ` +
      `(bin/agent-studio-mcp.mjs=${binSizeKb} kB, bin/app.html=${htmlSizeKb} kB, realUi=${usedRealHtml}).`,
  );

  // 7. Optional install into ~/.gemini/config/plugins/agent-studio/ or --install-dir
  // Note: overwrite in-place instead of rmdir(destRoot) so Windows file watchers or
  // an active Antigravity MCP server holding the directory handle never cause EBUSY.
  if (install || installDir) {
    const destRoot = installDir
      ? path.resolve(installDir)
      : resolveDefaultAntigravityPluginDir();
    fs.mkdirSync(destRoot, { recursive: true });
    fs.cpSync(distDir, destRoot, { recursive: true, force: true });
    console.log(`[antigravity-plugin] Installed plugin to ${destRoot}`);
  }
}

main().catch((err) => {
  console.error("[antigravity-plugin] Build failed:", err);
  process.exit(1);
});
