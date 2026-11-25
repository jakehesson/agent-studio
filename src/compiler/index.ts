import fs from "node:fs";
import path from "node:path";
import { resolveEffectiveModelIndex } from "../models/store.js";
import type { ModelIndex } from "../schema/model-index.js";
import {
  parseTeamYaml,
  type IdeTarget,
  type TeamManifest,
} from "../schema/team.js";
import { compileAntigravity } from "./antigravity.js";
import { compileClaudeCode } from "./claude-code.js";
import { compileCopilotVsCode } from "./copilot-vscode.js";
import {
  computeDrift,
  mergeJsonKeyScoped,
  mergeManagedMarkdownBlock,
  normalizeLf,
  type DriftReport,
  type ExpectedFile,
} from "./merge.js";

export interface CompileOptions {
  ides?: IdeTarget[];
  manifest?: TeamManifest;
  /** Opt-in to include Layer 1 (~/.agent-studio/model-index.json). Default false for CI determinism. */
  useGlobalIndex?: boolean;
  /** Optional explicit pre-resolved ModelIndex override. */
  modelIndex?: ModelIndex;
}

export interface CompileResult {
  projectRoot: string;
  projectId: string;
  targets: IdeTarget[];
  written: string[];
  merged: string[];
  unchanged: string[];
  totalFiles: number;
}

export function loadTeamManifest(projectRoot: string): TeamManifest {
  const teamYamlPath = path.resolve(projectRoot, ".agent-team", "team.yaml");
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

  return { manifest, targets, files, modelIndex };
}

export function compileTeam(
  projectRoot: string,
  options?: CompileOptions,
): CompileResult {
  const root = path.resolve(projectRoot);
  const { manifest, targets, files } = planCompiledFiles(root, options);

  const written: string[] = [];
  const merged: string[] = [];
  const unchanged: string[] = [];

  for (const expected of files) {
    const absPath = path.join(root, expected.relPath);
    const normRel = expected.relPath.replace(/\\/g, "/");
    const exists = fs.existsSync(absPath);
    const existingRaw = exists ? normalizeLf(fs.readFileSync(absPath, "utf8")) : null;

    let nextContent: string;
    let isMergeKind = false;

    if (expected.kind === "generated") {
      nextContent = normalizeLf(expected.content);
    } else if (expected.kind === "managed-markdown") {
      isMergeKind = true;
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

  return {
    projectRoot: root,
    projectId: manifest.project.id,
    targets,
    written,
    merged,
    unchanged,
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
export * from "./capabilities.js";
export * from "./antigravity.js";
export * from "./claude-code.js";
export * from "./copilot-vscode.js";
export * from "./global-install.js";
