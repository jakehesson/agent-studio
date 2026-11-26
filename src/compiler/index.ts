import fs from "node:fs";
import path from "node:path";
import { resolveEffectiveModelIndex } from "../models/store.js";
import type { ModelIndex } from "../schema/model-index.js";
import {
  parseTeamYaml,
  resolveCopilotHarness,
  type IdeTarget,
  type TeamManifest,
} from "../schema/team.js";
import { compileAntigravity } from "./antigravity.js";
import { compileClaudeCode } from "./claude-code.js";
import { compileCopilotVsCode } from "./copilot-vscode.js";
import {
  coalesceExpectedFiles,
  computeDrift,
  extractGeneratedHash,
  extractManagedMarkdownBlock,
  mergeJsonKeyScoped,
  mergeManagedMarkdownBlock,
  normalizeLf,
  verifyGeneratedMarkdownHash,
  type DriftReport,
  type ExpectedFile,
} from "./merge.js";
import { assertContainedPath } from "./shared.js";

export interface CompileOptions {
  ides?: IdeTarget[];
  manifest?: TeamManifest;
  /** Opt-in to include Layer 1 (~/.agent-studio/model-index.json). Default false for CI determinism. */
  useGlobalIndex?: boolean;
  /** Optional explicit pre-resolved ModelIndex override. */
  modelIndex?: ModelIndex;
  /** Overwrite user-modified or unmarked compiled files when true. */
  force?: boolean;
  /** Run surgical legacy artifact cleanup (default true when harness === "copilot"). */
  cleanLegacy?: boolean;
}

export interface SkippedModifiedEntry {
  path: string;
  ide: IdeTarget;
  reason: string;
}

export interface CompileResult {
  projectRoot: string;
  projectId: string;
  targets: IdeTarget[];
  written: string[];
  merged: string[];
  unchanged: string[];
  skippedModified: SkippedModifiedEntry[];
  cleanedLegacy: string[];
  warnings: string[];
  totalFiles: number;
}

export function loadTeamManifest(projectRoot: string): TeamManifest {
  const root = path.resolve(projectRoot);
  const teamYamlPath = assertContainedPath(
    root,
    ".agent-team/team.yaml",
    "team.yaml",
  );
  if (!fs.existsSync(teamYamlPath)) {
    throw new Error(
      `Missing canonical team manifest: ${teamYamlPath}. Run "agent-studio init" first.`,
    );
  }
  const raw = fs.readFileSync(teamYamlPath, "utf8");
  return parseTeamYaml(raw);
}

export function planCompiledFiles(
  projectRoot: string,
  options?: CompileOptions,
): {
  manifest: TeamManifest;
  targets: IdeTarget[];
  files: ExpectedFile[];
  modelIndex: ModelIndex;
} {
  const root = path.resolve(projectRoot);
  const manifest = options?.manifest ?? loadTeamManifest(root);
  const modelIndex =
    options?.modelIndex ??
    resolveEffectiveModelIndex({
      projectRoot: root,
      useGlobal: options?.useGlobalIndex === true,
    });
  const targets: IdeTarget[] =
    options?.ides && options.ides.length > 0 ? options.ides : manifest.targets;

  const files: ExpectedFile[] = [];

  if (targets.includes("antigravity")) {
    files.push(...compileAntigravity(root, manifest, modelIndex));
  }
  if (targets.includes("claude-code")) {
    files.push(...compileClaudeCode(root, manifest, modelIndex));
  }
  if (targets.includes("copilot-vscode")) {
    files.push(...compileCopilotVsCode(root, manifest, modelIndex));
  }

  return {
    manifest,
    targets,
    files: coalesceExpectedFiles(files),
    modelIndex,
  };
}

function isPlainJsonObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function cleanupLegacyCopilotArtifacts(
  root: string,
  cleanedLegacy: string[],
  warnings: string[],
): void {
  const vscodeMcpPath = assertContainedPath(
    root,
    ".vscode/mcp.json",
    "legacy cleanup",
  );
  if (fs.existsSync(vscodeMcpPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(vscodeMcpPath, "utf8"));
      if (isPlainJsonObject(parsed) && isPlainJsonObject(parsed.servers)) {
        const servers = parsed.servers;
        if (Object.prototype.hasOwnProperty.call(servers, "agent-studio")) {
          delete servers["agent-studio"];
          if (Object.keys(servers).length === 0) {
            delete parsed.servers;
          }
          if (Object.keys(parsed).length === 0) {
            fs.unlinkSync(vscodeMcpPath);
          } else {
            fs.writeFileSync(
              vscodeMcpPath,
              JSON.stringify(parsed, null, 2) + "\n",
              "utf8",
            );
          }
          cleanedLegacy.push(".vscode/mcp.json");
        }
      }
    } catch {
      warnings.push(
        "[.vscode/mcp.json] Legacy VS Code MCP file is malformed JSON; preserving untouched.",
      );
    }
  }

  const learnPromptPath = assertContainedPath(
    root,
    ".github/prompts/learn.prompt.md",
    "legacy cleanup",
  );
  if (fs.existsSync(learnPromptPath)) {
    const raw = fs.readFileSync(learnPromptPath, "utf8");
    if (
      extractGeneratedHash(raw) !== null &&
      verifyGeneratedMarkdownHash(raw) === true
    ) {
      fs.unlinkSync(learnPromptPath);
      cleanedLegacy.push(".github/prompts/learn.prompt.md");
    } else {
      warnings.push(
        "[.github/prompts/learn.prompt.md] Legacy Copilot prompt file was manually modified or lacks an Agent Studio SHA-256 marker; preserving untouched.",
      );
    }
  }
}

export function compileTeam(
  projectRoot: string,
  options?: CompileOptions,
): CompileResult {
  const root = path.resolve(projectRoot);
  const { manifest, targets, files } = planCompiledFiles(root, options);
  const force = options?.force === true;

  const written: string[] = [];
  const merged: string[] = [];
  const unchanged: string[] = [];
  const skippedModified: SkippedModifiedEntry[] = [];
  const cleanedLegacy: string[] = [];
  const warnings: string[] = [];

  for (const expected of files) {
    const absPath = assertContainedPath(
      root,
      expected.relPath,
      "compiled output",
    );
    const normRel = expected.relPath.replace(/\\/g, "/");
    const exists = fs.existsSync(absPath);
    const existingRaw = exists ? normalizeLf(fs.readFileSync(absPath, "utf8")) : null;

    let nextContent: string;
    let isMergeKind = false;

    if (expected.kind === "generated") {
      nextContent = normalizeLf(expected.content);
      if (exists && existingRaw !== null && existingRaw !== nextContent && !force) {
        if (normRel.endsWith(".md")) {
          const hasMarker = extractGeneratedHash(existingRaw) !== null;
          const validHash = hasMarker && verifyGeneratedMarkdownHash(existingRaw);
          if (!validHash) {
            const reason = hasMarker
              ? "Generated Markdown file was manually modified (SHA-256 marker mismatch); skipping overwrite (pass --force to replace)."
              : "Existing Markdown file lacks Agent Studio SHA-256 marker; skipping overwrite (pass --force to replace).";
            skippedModified.push({ path: normRel, ide: expected.ide, reason });
            warnings.push(`[${normRel}] ${reason}`);
            continue;
          }
        } else if (normRel.endsWith(".json")) {
          let validJsonObject = false;
          try {
            const parsed: unknown = JSON.parse(existingRaw);
            validJsonObject = isPlainJsonObject(parsed);
          } catch {
            validJsonObject = false;
          }
          if (!validJsonObject) {
            const reason =
              "Existing JSON file is malformed/unparseable; skipping overwrite (pass --force to replace).";
            skippedModified.push({ path: normRel, ide: expected.ide, reason });
            warnings.push(`[${normRel}] ${reason}`);
            continue;
          }
        }
      }
    } else if (expected.kind === "managed-markdown") {
      isMergeKind = true;
      if (!force && exists && existingRaw !== null) {
        const actualBlock = extractManagedMarkdownBlock(existingRaw);
        if (actualBlock !== null && !verifyGeneratedMarkdownHash(actualBlock)) {
          const reason =
            "Managed <!-- agent-studio:begin/end --> block was manually modified; skipping overwrite (pass --force to replace).";
          skippedModified.push({ path: normRel, ide: expected.ide, reason });
          warnings.push(`[${normRel}] ${reason}`);
          continue;
        }
      }
      nextContent = normalizeLf(
        mergeManagedMarkdownBlock(existingRaw, expected.blockContent),
      );
    } else {
      isMergeKind = true;
      let existingJson: Record<string, unknown> | null = null;
      if (existingRaw && existingRaw.trim().length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(existingRaw);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Cannot non-destructively merge ${normRel}: invalid JSON (${msg})`,
          );
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(
            `Cannot non-destructively merge ${normRel}: expected a JSON object at root.`,
          );
        }
        existingJson = parsed as Record<string, unknown>;
      }
      const mergedObj = mergeJsonKeyScoped(existingJson, expected.patch);
      nextContent = JSON.stringify(mergedObj, null, 2) + "\n";
    }

    if (existingRaw === nextContent) {
      unchanged.push(normRel);
      continue;
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, nextContent, "utf8");
    if (isMergeKind && exists) {
      merged.push(normRel);
    } else {
      written.push(normRel);
    }
  }

  if (
    targets.includes("copilot-vscode") &&
    resolveCopilotHarness(manifest) === "copilot" &&
    options?.cleanLegacy !== false
  ) {
    cleanupLegacyCopilotArtifacts(root, cleanedLegacy, warnings);
  }

  return {
    projectRoot: root,
    projectId: manifest.project.id,
    targets,
    written,
    merged,
    unchanged,
    skippedModified,
    cleanedLegacy,
    warnings,
    totalFiles: files.length,
  };
}

export function checkTeamDrift(
  projectRoot: string,
  options?: CompileOptions,
): DriftReport {
  const root = path.resolve(projectRoot);
  const { files } = planCompiledFiles(root, options);
  return computeDrift(root, files);
}

export * from "./merge.js";
export * from "./shared.js";
export * from "./capabilities.js";
export * from "./antigravity.js";
export * from "./claude-code.js";
export * from "./copilot-vscode.js";
export * from "./global-install.js";
export * from "./launcher.js";
