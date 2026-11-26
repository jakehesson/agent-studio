import fs from "node:fs";
import path from "node:path";
import { resolveProject } from "../../board/registry.js";
import {
  compileTeam,
  loadTeamManifest,
  type CompileResult,
} from "../../compiler/index.js";
import {
  createDefaultModelIndex,
  createWorkspaceDefaultModelIndex,
  inferModelCapabilities,
  inferModelTier,
} from "../../models/defaults.js";
import {
  buildWorkflowRoutingSummary,
  resolveRoleModel,
  type ResolvedRoleModel,
} from "../../models/resolve.js";
import {
  adoptGlobalOverlayIntoWorkspace,
  applyDiscoveredModels,
  doesGlobalDifferFromWorkspace,
  getGlobalModelIndexPath,
  getTeamYamlPath,
  getWorkspaceModelIndexPath,
  mergeOverlayPatch,
  readModelIndexLayerSync,
  resolveEffectiveModelIndex,
  updateModelIndexOverlay,
  upsertCatalogModel,
  withFileLock,
  withTeamYamlLock,
  writeModelIndexAtomic,
  type DiscoverModelInput,
} from "../../models/store.js";
import {
  DEFAULT_MODEL_INDEX,
  ModelCapabilityTagSchema,
  ModelCatalogEntrySchema,
  ModelRoutingPolicySchema,
  ModelTierSchema,
  type ModelCapabilityTag,
  type ModelIndex,
  type ModelIndexOverlay,
  type ModelRoutingPolicy,
  type ModelTier,
} from "../../schema/model-index.js";
import {
  IdeTargetSchema,
  type IdeModelOverride,
  type IdeTarget,
  type TeamManifest,
} from "../../schema/team.js";

const ALL_IDES: IdeTarget[] = ["antigravity", "claude-code", "copilot-vscode"];

interface ParsedCliArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseCliArgs(args: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const raw = token.slice(2);
      const eqIdx = raw.indexOf("=");
      let key: string;
      let value: string | boolean;
      if (eqIdx >= 0) {
        key = raw.slice(0, eqIdx);
        value = raw.slice(eqIdx + 1);
      } else {
        key = raw;
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i++;
        } else {
          value = true;
        }
      }
      const existing = flags[key];
      if (existing === undefined) {
        flags[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(String(value));
      } else {
        flags[key] = [String(existing), String(value)];
      }
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

function flagStr(
  flags: ParsedCliArgs["flags"],
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const v = flags[name];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.length > 0) return v[v.length - 1];
  }
  return undefined;
}

function flagBool(
  flags: ParsedCliArgs["flags"],
  ...names: string[]
): boolean | undefined {
  for (const name of names) {
    const v = flags[name];
    if (v === undefined) continue;
    if (v === true || v === "true" || v === "1") return true;
    if (v === false || v === "false" || v === "0") return false;
  }
  return undefined;
}

function flagList(
  flags: ParsedCliArgs["flags"],
  ...names: string[]
): string[] | undefined {
  const out: string[] = [];
  for (const name of names) {
    const v = flags[name];
    if (typeof v === "string") {
      out.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (Array.isArray(v)) {
      for (const entry of v) {
        out.push(...entry.split(",").map((s) => s.trim()).filter(Boolean));
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

function resolveProjectRootArg(projectRef?: string): string {
  if (!projectRef) {
    return path.resolve(process.cwd());
  }
  const directPath = path.resolve(projectRef);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isDirectory()) {
    return directPath;
  }
  return resolveProject(projectRef).root;
}

function resolveScope(raw?: string, defaultScope: "workspace" | "global" = "workspace"): "workspace" | "global" {
  if (!raw) return defaultScope;
  const low = raw.trim().toLowerCase();
  if (low === "workspace" || low === "global") return low;
  throw new Error(`Invalid --scope "${raw}". Expected "workspace" or "global".`);
}

function readAllStdinSync(): string {
  return fs.readFileSync(0, "utf8");
}

function parseDiscoverInputs(rawJson: string): DiscoverModelInput[] {
  const parsed: unknown = JSON.parse(rawJson);
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: unknown[] }).models
      : null;
  if (!arr) {
    throw new Error(
      "Expected a JSON array of models or { models: [...] } payload.",
    );
  }

  return arr.map((item, idx) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Model entry at index ${idx} must be an object.`);
    }
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) {
      throw new Error(`Model entry at index ${idx} is missing non-empty "id".`);
    }
    const tierHint =
      typeof rec.tierHint === "string"
        ? ModelTierSchema.parse(rec.tierHint)
        : typeof rec.tier === "string"
          ? ModelTierSchema.parse(rec.tier)
          : undefined;
    const capabilities = Array.isArray(rec.capabilities)
      ? rec.capabilities.map((c) => ModelCapabilityTagSchema.parse(c))
      : undefined;
    return {
      id,
      label: typeof rec.label === "string" ? rec.label : undefined,
      vendor: typeof rec.vendor === "string" ? rec.vendor : undefined,
      family: typeof rec.family === "string" ? rec.family : undefined,
      version: typeof rec.version === "string" ? rec.version : undefined,
      maxInputTokens:
        typeof rec.maxInputTokens === "number" ? rec.maxInputTokens : undefined,
      tierHint,
      capabilities,
      premiumMultiplier:
        typeof rec.premiumMultiplier === "number"
          ? rec.premiumMultiplier
          : undefined,
      notes: typeof rec.notes === "string" ? rec.notes : undefined,
    };
  });
}

function tryLoadManifest(projectRoot: string): TeamManifest | null {
  const teamYamlPath = getTeamYamlPath(projectRoot);
  if (!fs.existsSync(teamYamlPath)) return null;
  return loadTeamManifest(projectRoot);
}

function maybeSync(projectRoot: string, syncFlag: boolean): CompileResult | undefined {
  if (!syncFlag) return undefined;
  const teamYamlPath = getTeamYamlPath(projectRoot);
  if (!fs.existsSync(teamYamlPath)) return undefined;
  return compileTeam(projectRoot);
}

export interface ModelsCliOptions {
  stdinText?: string;
  quiet?: boolean;
}

export async function runModelsCli(
  args: string[],
  options: ModelsCliOptions = {},
): Promise<unknown> {
  const { positionals, flags } = parseCliArgs(args);
  const op = positionals[0] ?? "show";
  const asJson = flagBool(flags, "json") ?? false;
  const quiet = options.quiet || (flagBool(flags, "quiet") ?? false);
  const projectRef = flagStr(flags, "project");
  const projectRoot = resolveProjectRootArg(projectRef);

  const emit = (data: unknown, textLines: string[]): unknown => {
    if (!quiet) {
      process.stdout.write(
        asJson ? JSON.stringify(data, null, 2) + "\n" : textLines.join("\n") + "\n",
      );
    }
    return data;
  };

  switch (op) {
    case "show": {
      const layer = (flagStr(flags, "layer") ?? "effective").toLowerCase();
      const ideRaw = flagStr(flags, "ide");
      const ideFilter = ideRaw ? IdeTargetSchema.parse(ideRaw) : undefined;
      const globalPath = getGlobalModelIndexPath();
      const workspacePath = getWorkspaceModelIndexPath(projectRoot);
      const globalOverlay = readModelIndexLayerSync(globalPath);
      const workspaceOverlay = readModelIndexLayerSync(workspacePath);
      const effective = resolveEffectiveModelIndex({
        projectRoot,
        useGlobal: true,
        globalOverlay,
        workspaceOverlay,
      });

      let selectedIndex: ModelIndex | ModelIndexOverlay | null;
      if (layer === "built-in") {
        selectedIndex = DEFAULT_MODEL_INDEX;
      } else if (layer === "global") {
        selectedIndex = globalOverlay;
      } else if (layer === "workspace") {
        selectedIndex = workspaceOverlay;
      } else if (layer === "effective") {
        selectedIndex = effective;
      } else {
        throw new Error(
          `Unknown --layer "${layer}". Expected effective|global|workspace|built-in.`,
        );
      }

      const manifest = tryLoadManifest(projectRoot);
      const targetIdes = ideFilter ? [ideFilter] : ALL_IDES;
      const resolvedRoles = manifest
        ? manifest.roster.map((role) => {
            const perIde: Partial<Record<IdeTarget, ResolvedRoleModel>> = {};
            for (const ide of targetIdes) {
              perIde[ide] = resolveRoleModel(manifest, role, ide, effective);
            }
            return {
              id: role.id,
              name: role.name,
              roleType: role.roleType,
              resolved: perIde,
            };
          })
        : [];

      const payload = {
        ok: true,
        layer,
        projectRoot,
        layers: {
          globalPath,
          globalExists: globalOverlay !== null,
          workspacePath,
          workspaceExists: workspaceOverlay !== null,
          globalDiffersFromWorkspace: doesGlobalDifferFromWorkspace(
            globalOverlay,
            workspaceOverlay,
            ideFilter,
          ),
        },
        index: selectedIndex,
        routing: manifest ? buildWorkflowRoutingSummary(manifest) : undefined,
        resolvedRoles,
      };

      const lines: string[] = [
        `Agent Studio Model Index (layer=${layer})`,
        `  Global:    ${globalPath} (${globalOverlay ? "present" : "none"})`,
        `  Workspace: ${workspacePath} (${workspaceOverlay ? "present" : "none"})`,
      ];
      for (const ide of targetIdes) {
        const cfg = effective.ides[ide];
        lines.push(
          `  [${ide}] mode=${cfg.mode} fast=${cfg.tiers.fast.primary} | balanced=${cfg.tiers.balanced.primary} | reasoning=${cfg.tiers.reasoning.primary} (catalog=${cfg.catalog.length})`,
        );
      }
      if (resolvedRoles.length > 0) {
        lines.push("  Roles:");
        for (const r of resolvedRoles) {
          const summary = targetIdes
            .map((ide) => {
              const res = r.resolved[ide]!;
              const val = res.omit ? "<omit>" : res.primaryModel;
              return `${ide}=${val}`;
            })
            .join(", ");
          lines.push(`    - ${r.id}: ${summary}`);
        }
      }
      return emit(payload, lines);
    }

    case "set-tier": {
      const ideRaw = positionals[1] ?? flagStr(flags, "ide");
      const tierRaw = positionals[2] ?? flagStr(flags, "tier");
      const primary = (positionals[3] ?? flagStr(flags, "primary"))?.trim();
      if (!ideRaw || !tierRaw || !primary) {
        throw new Error(
          "Usage: agent-studio models set-tier <ide> <fast|balanced|reasoning> <primary> [--fallback a,b,c] [--omit-on-defer] [--scope workspace|global] [--sync]",
        );
      }
      const ide = IdeTargetSchema.parse(ideRaw);
      const tier = ModelTierSchema.parse(tierRaw);
      const scope = resolveScope(flagStr(flags, "scope"), "workspace");
      const fallbackFlag = flagList(flags, "fallback");
      const omitOnDefer = flagBool(flags, "omit-on-defer", "omitOnDefer");
      const syncFlag = flagBool(flags, "sync") ?? false;
      const targetPath =
        scope === "global"
          ? getGlobalModelIndexPath()
          : getWorkspaceModelIndexPath(projectRoot);
      const nowIso = new Date().toISOString();

      const updated = await updateModelIndexOverlay(targetPath, (current) => {
        const existingFallback =
          current?.ides?.[ide]?.tiers?.[tier]?.fallback ??
          DEFAULT_MODEL_INDEX.ides[ide].tiers[tier].fallback;
        const nextFallback = fallbackFlag
          ? fallbackFlag
          : existingFallback.includes(primary)
            ? existingFallback
            : [primary, ...existingFallback];
        return mergeOverlayPatch(
          current,
          {
            schemaVersion: 1,
            updatedAt: nowIso,
            updatedBy: "cli",
            ides: {
              [ide]: {
                tiers: {
                  [tier]: {
                    primary,
                    fallback: nextFallback,
                    ...(omitOnDefer !== undefined ? { omitOnDefer } : {}),
                    notes: "User/CLI tier override.",
                    autoRanked: false,
                  },
                },
              },
            },
          },
          "cli",
          nowIso,
        );
      });

      const compileResult =
        scope === "workspace" ? maybeSync(projectRoot, syncFlag) : undefined;
      return emit(
        { ok: true, scope, path: targetPath, ide, tier, primary, overlay: updated, compileResult },
        [
          `[agent-studio] Updated ${scope} ${ide}.${tier} -> ${primary}`,
          ...(compileResult
            ? [`  Synced ${compileResult.totalFiles} IDE files.`]
            : []),
        ],
      );
    }

    case "set-role": {
      const roleId = (positionals[1] ?? flagStr(flags, "role"))?.trim();
      if (!roleId) {
        throw new Error(
          "Usage: agent-studio models set-role <roleId> [--tier <tier>] [--policy <policy>] [--ide <ide> --model <id|a,b|omit>] [--sync]",
        );
      }
      const tierStr = flagStr(flags, "tier");
      const policyStr = flagStr(flags, "policy");
      const ideStr = flagStr(flags, "ide");
      const modelStr = flagStr(flags, "model");
      const syncFlag = flagBool(flags, "sync") ?? false;

      if (modelStr !== undefined && !ideStr) {
        throw new Error("--model requires --ide <antigravity|claude-code|copilot-vscode>.");
      }

      const teamYamlPath = getTeamYamlPath(projectRoot);
      const updatedRole = await withTeamYamlLock(teamYamlPath, (manifest) => {
        const role = manifest.roster.find((r) => r.id === roleId);
        if (!role) {
          throw new Error(`Role "${roleId}" not found in ${teamYamlPath}.`);
        }

        if (tierStr !== undefined) {
          const low = tierStr.trim().toLowerCase();
          if (low === "default" || low === "clear" || low === "null" || low === "none") {
            delete role.modelTier;
          } else {
            role.modelTier = ModelTierSchema.parse(low);
          }
        }

        if (policyStr !== undefined) {
          const low = policyStr.trim().toLowerCase();
          if (low === "inherit" || low === "default" || low === "clear" || low === "null") {
            delete role.modelPolicy;
          } else {
            role.modelPolicy = ModelRoutingPolicySchema.parse(low);
          }
        }

        if (ideStr && modelStr !== undefined) {
          const ide = IdeTargetSchema.parse(ideStr);
          const trimmed = modelStr.trim();
          const low = trimmed.toLowerCase();
          if (low === "clear" || low === "default" || low === "null") {
            if (role.models) {
              delete role.models[ide];
              if (Object.keys(role.models).length === 0) {
                delete role.models;
              }
            }
          } else {
            role.models ??= {};
            let overrideVal: IdeModelOverride;
            if (low === "omit") {
              overrideVal = { omit: true };
            } else if (trimmed.includes(",")) {
              const items = trimmed
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              if (items.length === 0) {
                throw new Error("--model list cannot be empty.");
              }
              overrideVal = items;
            } else {
              overrideVal = trimmed;
            }
            role.models[ide] = overrideVal;
          }
        }

        return role;
      });

      const compileResult = maybeSync(projectRoot, syncFlag);
      return emit(
        { ok: true, role: updatedRole, compileResult },
        [
          `[agent-studio] Updated role "${roleId}" in .agent-team/team.yaml`,
          ...(compileResult
            ? [`  Synced ${compileResult.totalFiles} IDE files.`]
            : []),
        ],
      );
    }

    case "set-policy": {
      const policyRaw = positionals[1] ?? flagStr(flags, "policy");
      if (!policyRaw) {
        throw new Error(
          "Usage: agent-studio models set-policy <defer-to-host|prefer-fallback|pinned> [--ide <ide>] [--respect-host true|false] [--handoff-models true|false] [--sync]",
        );
      }
      const policy: ModelRoutingPolicy = ModelRoutingPolicySchema.parse(
        policyRaw.trim(),
      );
      const ideRaw = flagStr(flags, "ide");
      const ide = ideRaw ? IdeTargetSchema.parse(ideRaw) : undefined;
      const respectHost = flagBool(flags, "respect-host", "respectHost");
      const handoffModels = flagBool(flags, "handoff-models", "handoffModels");
      const allowHints = flagBool(flags, "allow-hints", "allowHints");
      const syncFlag = flagBool(flags, "sync") ?? false;

      const teamYamlPath = getTeamYamlPath(projectRoot);
      const updatedRouting = await withTeamYamlLock(teamYamlPath, (manifest) => {
        const mr = (manifest.workflow.modelRouting ??= {
          policy: "prefer-fallback",
          respectBuiltInOrchestrators: true,
          allowSubagentModelHints: true,
          copilotHandoffModels: false,
          selectionPriority: ["accuracy", "cost", "speed"],
        });
        if (ide) {
          mr.idePolicies ??= {};
          mr.idePolicies[ide] = policy;
        } else {
          mr.policy = policy;
        }
        if (respectHost !== undefined) {
          mr.respectBuiltInOrchestrators = respectHost;
        }
        if (handoffModels !== undefined) {
          mr.copilotHandoffModels = handoffModels;
        }
        if (allowHints !== undefined) {
          mr.allowSubagentModelHints = allowHints;
        }
        return mr;
      });

      const compileResult = maybeSync(projectRoot, syncFlag);
      return emit(
        { ok: true, modelRouting: updatedRouting, compileResult },
        [
          `[agent-studio] Set ${ide ? `${ide} policy` : "workflow policy"} -> ${policy}`,
          ...(compileResult
            ? [`  Synced ${compileResult.totalFiles} IDE files.`]
            : []),
        ],
      );
    }

    case "upsert": {
      const ideRaw = flagStr(flags, "ide");
      const id = flagStr(flags, "id")?.trim();
      if (!ideRaw || !id) {
        throw new Error(
          "Usage: agent-studio models upsert --ide <ide> --id <modelId> [--label <name>] [--vendor <v>] [--family <f>] [--tier <tier>] [--capabilities a,b] [--available true|false] [--scope global|workspace]",
        );
      }
      const ide = IdeTargetSchema.parse(ideRaw);
      const scope = resolveScope(flagStr(flags, "scope"), "workspace");
      const vendor = flagStr(flags, "vendor")?.trim();
      const family = flagStr(flags, "family")?.trim();
      const label = flagStr(flags, "label")?.trim() || id;
      const rawWindow = flagStr(flags, "context-window", "contextWindow");
      const contextWindow = rawWindow ? Number.parseInt(rawWindow, 10) : undefined;
      const tierRaw = flagStr(flags, "tier");
      const tier: ModelTier = tierRaw
        ? ModelTierSchema.parse(tierRaw)
        : inferModelTier(id, family, contextWindow);
      const rawCaps = flagList(flags, "capabilities");
      const capabilities: ModelCapabilityTag[] = rawCaps
        ? rawCaps.map((c) => ModelCapabilityTagSchema.parse(c))
        : inferModelCapabilities(id, tier, family, contextWindow);
      const available = flagBool(flags, "available") ?? true;
      const notes = flagStr(flags, "notes");
      const targetPath =
        scope === "global"
          ? getGlobalModelIndexPath()
          : getWorkspaceModelIndexPath(projectRoot);
      const nowIso = new Date().toISOString();

      let wasAdded = false;
      const updated = await updateModelIndexOverlay(targetPath, (current) => {
        const entry = ModelCatalogEntrySchema.parse({
          id,
          label,
          ...(vendor ? { vendor } : {}),
          ...(family ? { family } : {}),
          tier,
          capabilities,
          ...(contextWindow && Number.isFinite(contextWindow) && contextWindow > 0
            ? { contextWindow }
            : {}),
          available,
          source: "user",
          discoveredAt: nowIso,
          ...(notes ? { notes } : {}),
        });
        const res = upsertCatalogModel(current, ide, entry, "cli", nowIso);
        wasAdded = res.added;
        return res.overlay;
      });

      return emit(
        { ok: true, scope, ide, id, added: wasAdded, overlay: updated },
        [
          `[agent-studio] ${wasAdded ? "Added" : "Updated"} ${ide} catalog entry "${id}" (tier=${tier}, scope=${scope})`,
        ],
      );
    }

    case "discover": {
      const ideRaw = flagStr(flags, "ide");
      if (!ideRaw) {
        throw new Error(
          "Usage: agent-studio models discover --ide <ide> [--stdin | --file <path>] [--scope global|workspace]",
        );
      }
      const ide = IdeTargetSchema.parse(ideRaw);
      const scope = resolveScope(flagStr(flags, "scope"), "global");
      const sourceRaw = flagStr(flags, "source")?.trim();
      const source: "vscode-lm" | "manual" =
        sourceRaw === "manual" ? "manual" : "vscode-lm";
      const filePath = flagStr(flags, "file");
      const useStdin = flagBool(flags, "stdin") ?? false;

      let rawJson: string;
      if (options.stdinText !== undefined) {
        rawJson = options.stdinText;
      } else if (filePath) {
        rawJson = fs.readFileSync(path.resolve(filePath), "utf8");
      } else if (useStdin) {
        rawJson = readAllStdinSync();
      } else {
        throw new Error("Pass --stdin or --file <path> with discovered model JSON.");
      }

      const models = parseDiscoverInputs(rawJson);
      const targetPath =
        scope === "global"
          ? getGlobalModelIndexPath()
          : getWorkspaceModelIndexPath(projectRoot);
      const nowIso = new Date().toISOString();

      let summary = { count: 0, added: 0, updated: 0, markedUnavailable: 0 };
      await updateModelIndexOverlay(targetPath, (current) => {
        const applied = applyDiscoveredModels(current, {
          ide,
          models,
          source,
          updatedBy: source === "vscode-lm" ? "vscode-lm" : "cli",
          nowIso,
        });
        summary = {
          count: applied.count,
          added: applied.added,
          updated: applied.updated,
          markedUnavailable: applied.markedUnavailable,
        };
        return applied.overlay;
      });

      const effective = resolveEffectiveModelIndex({
        projectRoot,
        useGlobal: true,
      });

      return emit(
        {
          ok: true,
          ide,
          scope,
          path: targetPath,
          ...summary,
          effective,
        },
        [
          `[agent-studio] Discovered ${summary.count} ${ide} model(s) into ${scope} (${summary.added} added, ${summary.updated} updated, ${summary.markedUnavailable} marked unavailable).`,
        ],
      );
    }

    case "adopt": {
      const ideRaw = flagStr(flags, "ide");
      const tierRaw = flagStr(flags, "tier");
      const ide = ideRaw ? IdeTargetSchema.parse(ideRaw) : undefined;
      const tier = tierRaw ? ModelTierSchema.parse(tierRaw) : undefined;
      const syncFlag = flagBool(flags, "sync") ?? false;

      const globalOverlay = readModelIndexLayerSync(getGlobalModelIndexPath());
      const workspacePath = getWorkspaceModelIndexPath(projectRoot);

      let adoptedCatalogCount = 0;
      let adoptedTierCount = 0;
      const nextWorkspace = await updateModelIndexOverlay(
        workspacePath,
        (currentWorkspace) => {
          const res = adoptGlobalOverlayIntoWorkspace(
            globalOverlay,
            currentWorkspace,
            { ide, tier, updatedBy: "cli" },
          );
          adoptedCatalogCount = res.adoptedCatalogCount;
          adoptedTierCount = res.adoptedTierCount;
          return res.overlay;
        },
      );

      const compileResult = maybeSync(projectRoot, syncFlag);
      return emit(
        {
          ok: true,
          path: workspacePath,
          adoptedCatalogCount,
          adoptedTierCount,
          overlay: nextWorkspace,
          compileResult,
        },
        [
          `[agent-studio] Adopted ${adoptedCatalogCount} catalog entry(s) and ${adoptedTierCount} tier binding(s) into ${workspacePath}`,
          ...(compileResult
            ? [`  Synced ${compileResult.totalFiles} IDE files.`]
            : []),
        ],
      );
    }

    case "reset": {
      const scope = resolveScope(flagStr(flags, "scope"), "workspace");
      const syncFlag = flagBool(flags, "sync") ?? false;
      const targetPath =
        scope === "global"
          ? getGlobalModelIndexPath()
          : getWorkspaceModelIndexPath(projectRoot);
      const seed =
        scope === "global"
          ? createDefaultModelIndex({
              updatedAt: new Date().toISOString(),
              updatedBy: "cli",
            })
          : createWorkspaceDefaultModelIndex({
              updatedAt: new Date().toISOString(),
              updatedBy: "cli",
            });

      const updated = await withFileLock(targetPath, async () => {
        await writeModelIndexAtomic(targetPath, seed);
        return seed;
      });
      const compileResult =
        scope === "workspace" ? maybeSync(projectRoot, syncFlag) : undefined;
      return emit(
        { ok: true, scope, path: targetPath, overlay: updated, compileResult },
        [
          `[agent-studio] Reset ${scope} model index (${targetPath}) to built-in seed.`,
          ...(compileResult
            ? [`  Synced ${compileResult.totalFiles} IDE files.`]
            : []),
        ],
      );
    }

    default:
      throw new Error(
        `Unknown models subcommand "${op}". Expected show|set-tier|set-role|set-policy|upsert|discover|adopt|reset.`,
      );
  }
}
