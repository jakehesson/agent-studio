import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extRoot = path.resolve(__dirname, "..");

const pkgPath = path.join(extRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = pkg.version?.trim();
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[agent-studio-vscode] Invalid version in ${pkgPath}: "${version ?? ""}"`);
  process.exit(1);
}

const outFile = `agent-studio-${version}.vsix`;

// Remove stale older agent-studio-*.vsix archives so only the current version remains
for (const entry of fs.readdirSync(extRoot)) {
  if (/^agent-studio-.*\.vsix$/i.test(entry) && entry !== outFile) {
    fs.rmSync(path.join(extRoot, entry), { force: true });
    console.log(`[agent-studio-vscode] Removed stale VSIX: ${entry}`);
  }
}

const res = spawnSync(
  "npx",
  [
    "vsce",
    "package",
    "--no-dependencies",
    "--allow-missing-repository",
    "--out",
    outFile,
  ],
  {
    cwd: extRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (res.error) {
  console.error("[agent-studio-vscode] Failed to run vsce:", res.error);
  process.exit(1);
}
process.exit(res.status ?? 1);
