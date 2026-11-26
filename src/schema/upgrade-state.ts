import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const UPGRADE_STATE_FILENAME = ".upgrade-state.json";

export const ManagedFileRecordSchema = z.object({
  stockHash: z.string().regex(/^[0-9a-f]{64}$/),
  customized: z.boolean(),
  localHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  templateVersion: z.string().min(1),
});
export type ManagedFileRecord = z.infer<typeof ManagedFileRecordSchema>;

export function assertSafeUpgradeStateKey(relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("Upgrade state key must be a non-empty relative path.");
  }
  if (/[\x00-\x1f\x7f]/.test(relPath)) {
    throw new Error(
      `Upgrade state key contains unsafe control characters: ${JSON.stringify(relPath)}`,
    );
  }
  if (relPath.startsWith("/") || relPath.startsWith("\\")) {
    throw new Error(`Upgrade state key must be relative, got: ${relPath}`);
  }
  if (/^[A-Za-z]:/.test(relPath)) {
    throw new Error(
      `Upgrade state key must not contain a drive letter: ${relPath}`,
    );
  }

  const slashNormalized = relPath.replace(/\\/g, "/");
  const rawSegments = slashNormalized.split("/");
  if (rawSegments.some((seg) => seg === "..")) {
    throw new Error(
      `Upgrade state key must not contain '..' segments: ${relPath}`,
    );
  }

  const stripped = slashNormalized
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\.agent-team\//, "");

  if (
    !stripped ||
    stripped.startsWith("/") ||
    /^[A-Za-z]:/.test(stripped)
  ) {
    throw new Error(`Invalid upgrade state key: ${relPath}`);
  }

  const finalSegments = stripped.split("/");
  if (
    finalSegments.some((seg) => seg.length === 0 || seg === "." || seg === "..")
  ) {
    throw new Error(
      `Invalid path segments in upgrade state key: ${relPath}`,
    );
  }

  return stripped;
}

export function normalizeUpgradeStateKey(relPath: string): string {
  return assertSafeUpgradeStateKey(relPath);
}

export const UpgradeStateKeySchema = z
  .string()
  .min(1)
  .superRefine((key, ctx) => {
    try {
      assertSafeUpgradeStateKey(key);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

export const UpgradeStateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  agentStudioVersion: z.string().min(1),
  files: z.record(UpgradeStateKeySchema, ManagedFileRecordSchema).default({}),
});
export type UpgradeState = z.infer<typeof UpgradeStateSchema>;

export function getUpgradeStatePath(projectRoot: string): string {
  return path.resolve(projectRoot, ".agent-team", UPGRADE_STATE_FILENAME);
}

export function sortUpgradeState(state: UpgradeState): UpgradeState {
  const validated = UpgradeStateSchema.parse(state);
  const sortedEntries = Object.entries(validated.files)
    .map(([k, v]) => [normalizeUpgradeStateKey(k), v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const files: Record<string, ManagedFileRecord> = {};
  for (const [key, record] of sortedEntries) {
    files[key] = record;
  }

  return {
    schemaVersion: 1,
    agentStudioVersion: validated.agentStudioVersion,
    files,
  };
}

export function parseUpgradeState(raw: string): UpgradeState {
  const parsed: unknown = JSON.parse(raw);
  return sortUpgradeState(UpgradeStateSchema.parse(parsed));
}

export function serializeUpgradeState(state: UpgradeState): string {
  return JSON.stringify(sortUpgradeState(state), null, 2) + "\n";
}

export function readUpgradeStateSync(projectRoot: string): UpgradeState | null {
  const filePath = getUpgradeStatePath(projectRoot);
  if (!fsSync.existsSync(filePath)) {
    return null;
  }
  const raw = fsSync.readFileSync(filePath, "utf8");
  return parseUpgradeState(raw);
}

export async function readUpgradeState(
  projectRoot: string,
): Promise<UpgradeState | null> {
  const filePath = getUpgradeStatePath(projectRoot);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseUpgradeState(raw);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

export function resolveAgentStudioVersion(): string {
  const envVer = process.env.AGENT_STUDIO_VERSION?.trim();
  if (envVer) {
    return envVer;
  }
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    for (const rel of [
      "../../package.json",
      "../package.json",
      "../../../package.json",
    ]) {
      const candidate = path.resolve(thisDir, rel);
      if (!fsSync.existsSync(candidate)) continue;
      const parsed = JSON.parse(fsSync.readFileSync(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        (parsed.name === "@jakehesson/agent-studio" ||
          parsed.name === "agent-studio" ||
          parsed.name === "agent-studio-vscode") &&
        typeof parsed.version === "string" &&
        parsed.version.trim().length > 0
      ) {
        return parsed.version.trim();
      }
    }
  } catch {
    // Fall through to default version
  }
  return "0.13.0";
}
