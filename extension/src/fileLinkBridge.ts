import os from "node:os";
import path from "node:path";

export interface ParsedFileUri {
  fsPath: string;
  startLine?: number;
  endLine?: number;
}

export type FileUriResolutionResult =
  | {
      ok: true;
      fsPath: string;
      startLine?: number;
      endLine?: number;
    }
  | {
      ok: false;
      reason: string;
    };

const LINE_ANCHOR_RE = /^L(\d+)(?:-L?(\d+))?$/i;

function isWindowsDrivePath(p: string): boolean {
  return /^[A-Za-z]:(?:[\\/]|$)/.test(p);
}

function toPositiveInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    return Math.floor(raw);
  }
  return undefined;
}

export function getDefaultAllowedRoots(
  workspaceFolders: ReadonlyArray<string>,
  homeDir: string = os.homedir(),
): string[] {
  return [
    ...workspaceFolders.filter(
      (w) => typeof w === "string" && w.trim().length > 0,
    ),
    path.join(homeDir, ".gemini"),
    path.join(homeDir, ".claude"),
  ];
}

export function parseFileUri(
  rawUri: string,
  opts?: { startLine?: number; endLine?: number },
): { ok: true; value: ParsedFileUri } | { ok: false; reason: string } {
  const trimmed = rawUri.trim();
  if (!trimmed) {
    return { ok: false, reason: "Empty file URI" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: `Invalid file URI: ${trimmed}` };
  }

  if (parsed.protocol !== "file:") {
    return {
      ok: false,
      reason: `Unsupported URI scheme "${parsed.protocol}" (expected file:)`,
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "" && host !== "localhost") {
    return {
      ok: false,
      reason: `Remote file host "${parsed.hostname}" is not allowed`,
    };
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { ok: false, reason: "Malformed percent-encoding in file URI" };
  }

  if (!decodedPathname) {
    return { ok: false, reason: "Missing path in file URI" };
  }

  // Strip leading slash on Windows drive paths: /d:/foo or /D:/foo -> d:/foo
  let fsPath = decodedPathname;
  if (/^\/[A-Za-z]:(?:[\\/]|$)/.test(fsPath)) {
    fsPath = fsPath.slice(1);
  }

  // Guard against UNC paths encoded via extra leading slashes (e.g. file://///server/share)
  if (fsPath.startsWith("//") || fsPath.startsWith("\\\\")) {
    return { ok: false, reason: "Remote UNC paths are not allowed" };
  }

  const pathImpl = isWindowsDrivePath(fsPath) ? path.win32 : path;
  const resolvedFsPath = pathImpl.resolve(fsPath);

  let startLine = toPositiveInt(opts?.startLine);
  let endLine = toPositiveInt(opts?.endLine);

  if (startLine === undefined && parsed.hash) {
    const fragment = parsed.hash.slice(1);
    const m = LINE_ANCHOR_RE.exec(fragment);
    if (m?.[1]) {
      startLine = Number.parseInt(m[1], 10);
      if (m[2]) {
        endLine = Number.parseInt(m[2], 10);
      }
    }
  }

  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    endLine = startLine;
  }

  return {
    ok: true,
    value: {
      fsPath: resolvedFsPath,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
    },
  };
}

export function isPathContainedInRoots(
  targetFsPath: string,
  allowedRoots: ReadonlyArray<string>,
): boolean {
  const useWin = isWindowsDrivePath(targetFsPath);
  const pathImpl = useWin ? path.win32 : path;
  const resolvedTarget = pathImpl.resolve(targetFsPath);
  const targetCmp =
    useWin || process.platform === "win32"
      ? resolvedTarget.toLowerCase()
      : resolvedTarget;

  for (const root of allowedRoots) {
    if (!root || !root.trim()) continue;
    const rootIsWin = isWindowsDrivePath(root);
    if (useWin !== rootIsWin && process.platform !== "win32") {
      continue;
    }
    const rootImpl = useWin || rootIsWin ? path.win32 : path;
    const resolvedRoot = rootImpl.resolve(root);
    const rootCmp =
      useWin || rootIsWin || process.platform === "win32"
        ? resolvedRoot.toLowerCase()
        : resolvedRoot;

    const rel = rootImpl.relative(rootCmp, targetCmp);
    if (rel === "" || (!rel.startsWith("..") && !rootImpl.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

export function resolveAllowedFileUri(
  rawUri: string,
  allowedRoots: ReadonlyArray<string>,
  opts?: { startLine?: number; endLine?: number },
): FileUriResolutionResult {
  const parsed = parseFileUri(rawUri, opts);
  if (!parsed.ok) {
    return parsed;
  }
  if (!isPathContainedInRoots(parsed.value.fsPath, allowedRoots)) {
    return {
      ok: false,
      reason: `Blocked opening path outside workspace/.gemini/.claude: ${parsed.value.fsPath}`,
    };
  }
  return {
    ok: true,
    fsPath: parsed.value.fsPath,
    ...(parsed.value.startLine !== undefined
      ? { startLine: parsed.value.startLine }
      : {}),
    ...(parsed.value.endLine !== undefined
      ? { endLine: parsed.value.endLine }
      : {}),
  };
}
