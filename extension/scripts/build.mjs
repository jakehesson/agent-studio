import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(extRoot, "..");

const distDir = path.join(extRoot, "dist");
const sourceWebDir = path.join(repoRoot, "dist", "web");
const targetWebDir = path.join(distDir, "web");

async function main() {
  if (!fs.existsSync(path.join(sourceWebDir, "index.html"))) {
    throw new Error(
      `Missing prebuilt Web Studio assets at ${sourceWebDir}. Run "npm --prefix web run build" in the repository root first.`,
    );
  }

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  // 1. Bundle VS Code / Antigravity extension entrypoint (CommonJS)
  await build({
    entryPoints: [path.join(extRoot, "src", "extension.ts")],
    outfile: path.join(distDir, "extension.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    sourcemap: false,
    minify: false,
    logLevel: "info",
  });

  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const studioVersion =
    typeof rootPkg.version === "string" && rootPkg.version.trim()
      ? rootPkg.version.trim()
      : "0.2.0";

  // 2. Bundle core agent-studio CLI + server + MCP into one self-contained ESM module
  await build({
    entryPoints: [path.join(repoRoot, "src", "cli", "index.ts")],
    outfile: path.join(distDir, "studio-cli.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: false,
    minify: false,
    define: {
      __AGENT_STUDIO_VERSION__: JSON.stringify(studioVersion),
    },
    banner: {
      js: 'import { createRequire as __agentStudioCreateRequire } from "node:module"; const require = __agentStudioCreateRequire(import.meta.url);',
    },
    logLevel: "info",
  });

  // 3. Copy compiled Web Studio static assets (dist/web -> extension/dist/web)
  fs.cpSync(sourceWebDir, targetWebDir, { recursive: true });

  const extSize = fs.statSync(path.join(distDir, "extension.js")).size;
  const cliSize = fs.statSync(path.join(distDir, "studio-cli.mjs")).size;
  console.log(
    `[agent-studio-vscode] Built dist/extension.js (${(extSize / 1024).toFixed(1)} kB), ` +
      `dist/studio-cli.mjs (${(cliSize / 1024).toFixed(1)} kB), and copied dist/web/.`,
  );
}

main().catch((err) => {
  console.error("[agent-studio-vscode] Build failed:", err);
  process.exit(1);
});
