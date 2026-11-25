import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SyncCliShimsOptions {
  sourceCliPath: string;
  agentStudioHome?: string;
}

export interface SyncCliShimsResult {
  ok: boolean;
  binDir: string;
  cliPath: string;
  written: string[];
  error?: string;
}

export interface EnvCollectionLike {
  prepend(variable: string, value: string): void;
}

export function resolveAgentStudioBinDir(agentStudioHome?: string): string {
  const home =
    agentStudioHome?.trim() ||
    process.env.AGENT_STUDIO_HOME?.trim() ||
    path.join(os.homedir(), ".agent-studio");
  return path.join(home, "bin");
}

function writeFileIfChangedAtomic(
  targetPath: string,
  nextBuf: Buffer,
  mode?: number,
): boolean {
  if (fs.existsSync(targetPath)) {
    const existingBuf = fs.readFileSync(targetPath);
    if (existingBuf.equals(nextBuf)) {
      return false;
    }
  }

  const dir = path.dirname(targetPath);
  const tmpPath = path.join(
    dir,
    `.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  try {
    fs.writeFileSync(tmpPath, nextBuf);
    if (mode !== undefined) {
      try {
        fs.chmodSync(tmpPath, mode);
      } catch {
        // best-effort chmod on non-POSIX filesystems
      }
    }
    fs.renameSync(tmpPath, targetPath);
    if (mode !== undefined) {
      try {
        fs.chmodSync(targetPath, mode);
      } catch {
        // best-effort chmod on non-POSIX filesystems
      }
    }
    return true;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // ignore temp cleanup errors
    }
  }
}

export function syncCliShims(opts: SyncCliShimsOptions): SyncCliShimsResult {
  const binDir = resolveAgentStudioBinDir(opts.agentStudioHome);
  const cliPath = path.join(binDir, "studio-cli.mjs");
  const written: string[] = [];

  try {
    if (!opts.sourceCliPath || !fs.existsSync(opts.sourceCliPath)) {
      return {
        ok: false,
        binDir,
        cliPath,
        written,
        error: `Source CLI bundle not found: ${opts.sourceCliPath}`,
      };
    }

    const sourceBuf = fs.readFileSync(opts.sourceCliPath);
    fs.mkdirSync(binDir, { recursive: true });

    const targets: Array<{ path: string; content: Buffer; mode?: number }> = [
      { path: cliPath, content: sourceBuf },
      {
        path: path.join(binDir, "agent-studio.cmd"),
        content: Buffer.from(
          '@echo off\r\nnode "%~dp0studio-cli.mjs" %*\r\n',
          "utf8",
        ),
      },
      {
        path: path.join(binDir, "agent-studio"),
        content: Buffer.from(
          '#!/usr/bin/env sh\nexec node "$(dirname "$0")/studio-cli.mjs" "$@"\n',
          "utf8",
        ),
        mode: 0o755,
      },
    ];

    for (const target of targets) {
      if (writeFileIfChangedAtomic(target.path, target.content, target.mode)) {
        written.push(target.path);
      }
    }

    return {
      ok: true,
      binDir,
      cliPath,
      written,
    };
  } catch (err) {
    return {
      ok: false,
      binDir,
      cliPath,
      written,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerTerminalPath(
  envCollection: EnvCollectionLike | undefined,
  binDir: string,
): boolean {
  if (!envCollection || !binDir.trim()) {
    return false;
  }
  try {
    envCollection.prepend("PATH", `${binDir}${path.delimiter}`);
    return true;
  } catch {
    return false;
  }
}
