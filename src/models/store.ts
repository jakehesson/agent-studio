import { randomBytes } from "node:crypto";
import fsSync, { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentStudioHome } from "../board/registry.js";
import {
  DEFAULT_MODEL_INDEX,
  ModelCatalogEntrySchema,
  ModelIndexOverlaySchema,
  ModelIndexSchema,
  type IdeModelConfig,
  type IdeModelOverlay,
  type IdeSyncSource,
  type IdeTierBinding,
  type IdeTierBindingPatch,
  type ModelCapabilityTag,
  type ModelCatalogEntry,
  type ModelIndex,
  type ModelIndexOverlay,
  type ModelSourceTag,
  type ModelTier,
  type ModelUpdatedBy,
} from "../schema/model-index.js";
import {
  TeamManifestSchema,
  parseTeamYaml,
  serializeTeamYaml,
  type IdeTarget,
  type TeamManifest,
} from "../schema/team.js";
import {
  cloneDefaultModelIndex,
  inferModelCapabilities,
  inferModelTier,
} from "./defaults.js";

const ALL_IDES: IdeTarget[] = ["antigravity", "claude-code", "copilot-vscode"];
const ALL_TIERS: ModelTier[] = ["fast", "balanced", "reasoning"];

export interface FileLockOptions {
  /** Maximum time to wait for lock acquisition (ms). Default: 10_000. */
  timeoutMs?: number;
  /** Age after which an existing lockfile is considered stale and recovered (ms). Default: 30_000. */
  staleMs?: number;
  /** Base polling delay between acquisition attempts (ms). Default: 15. */
  retryDelayMs?: number;
}

export interface LayerInspectionResult {
  path: string;
  exists: boolean;
  valid: boolean;
  data: ModelIndexOverlay | null;
  error?: string;
}

export interface ResolveEffectiveModelIndexOptions {
  projectRoot?: string;
  /** Read Layer 1 (~/.agent-studio/model-index.json). Default: true. */
  useGlobal?: boolean;
  /** Explicit Layer 1 override (skips filesystem read when provided). */
  globalOverlay?: ModelIndexOverlay | null;
  /** Explicit Layer 2 override (skips filesystem read when provided). */
  workspaceOverlay?: ModelIndexOverlay | null;
  /** Ignore malformed Layer 1 JSON/schema instead of throwing. Default: false. */
  ignoreMalformedGlobal?: boolean;
}

export interface DiscoverModelInput {
  id: string;
  label?: string;
  vendor?: string;
  family?: string;
  maxInputTokens?: number;
  tierHint?: ModelTier;
  capabilities?: ModelCapabilityTag[];
  premiumMultiplier?: number;
  notes?: string;
}

export interface DiscoverCatalogResult {
  overlay: ModelIndexOverlay;
  count: number;
  added: number;
  updated: number;
  markedUnavailable: number;
}

export interface AdoptGlobalModelsOptions {
  ide?: IdeTarget;
  tier?: ModelTier;
  updatedBy?: ModelUpdatedBy;
}

export interface AdoptGlobalModelsResult {
  adoptedCatalogCount: number;
  adoptedTierCount: number;
  overlay: ModelIndexOverlay;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrno(err: unknown, ...codes: string[]): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && codes.includes(code);
}

export async function renameWithRetry(src: string, dest: string): Promise<void> {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      if (isErrno(err, "EPERM", "EACCES", "EBUSY") && attempt < maxAttempts) {
        await sleep(15 * attempt);
        continue;
      }
      throw err;
    }
  }
}

export async function writeTextAtomic(
  filePath: string,
  payload: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await renameWithRetry(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
): Promise<void> {
  const payload = JSON.stringify(data, null, 2) + "\n";
  await writeTextAtomic(filePath, payload);
}

export function getGlobalModelIndexPath(): string {
  return path.join(getAgentStudioHome(), "model-index.json");
}

export function getWorkspaceModelIndexPath(projectRoot: string): string {
  return path.resolve(projectRoot, ".agent-team", "model-index.json");
}

export function getTeamYamlPath(projectRoot: string): string {
  return path.resolve(projectRoot, ".agent-team", "team.yaml");
}

export function getFileLockPath(filePath: string): string {
  return `${filePath}.lock`;
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => T | Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const staleMs = options?.staleMs ?? 30_000;
  const retryDelayMs = options?.retryDelayMs ?? 15;
  const lockPath = getFileLockPath(filePath);

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  while (!acquired) {
    try {
      const fd = await fs.open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      );
      try {
        const meta = JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        });
        await fd.writeFile(meta, "utf8");
      } finally {
        await fd.close();
      }
      acquired = true;
    } catch (err) {
      if (!isErrno(err, "EEXIST")) {
        throw err;
      }

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch (statErr) {
        if (isErrno(statErr, "ENOENT")) {
          continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `File lock timeout after ${timeoutMs}ms: ${lockPath}`,
        );
      }

      const jitter = Math.floor(Math.random() * Math.max(5, retryDelayMs));
      await sleep(retryDelayMs + jitter);
    }
  }

  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

export function readModelIndexLayerSync(
  filePath: string,
): ModelIndexOverlay | null {
  if (!fsSync.existsSync(filePath)) {
    return null;
  }
  const rawText = fsSync.readFileSync(filePath, "utf8");
  const parsed: unknown = JSON.parse(rawText);
  return ModelIndexOverlaySchema.parse(parsed);
}

export async function readModelIndexLayer(
  filePath: string,
): Promise<ModelIndexOverlay | null> {
  let rawText: string;
  try {
    rawText = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) {
      return null;
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(rawText);
  return ModelIndexOverlaySchema.parse(parsed);
}

export function inspectModelIndexLayerSync(
  filePath: string,
): LayerInspectionResult {
  if (!fsSync.existsSync(filePath)) {
    return { path: filePath, exists: false, valid: true, data: null };
  }
  try {
    const data = readModelIndexLayerSync(filePath);
    return { path: filePath, exists: true, valid: true, data };
  } catch (err) {
    return {
      path: filePath,
      exists: true,
      valid: false,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function writeModelIndexAtomic(
  filePath: string,
  overlay: ModelIndexOverlay,
): Promise<ModelIndexOverlay> {
  const validated = ModelIndexOverlaySchema.parse(overlay);
  await writeJsonAtomic(filePath, validated);
  return validated;
}

export async function withModelIndexLock<T>(
  filePath: string,
  fn: (current: ModelIndexOverlay | null) =>
    | { next: ModelIndexOverlay | null; result: T }
    | Promise<{ next: ModelIndexOverlay | null; result: T }>,
  options?: FileLockOptions,
): Promise<T> {
  return withFileLock(
    filePath,
    async () => {
      const current = await readModelIndexLayer(filePath);
      const { next, result } = await fn(current);
      if (next !== null) {
        await writeModelIndexAtomic(filePath, next);
      }
      return result;
    },
    options,
  );
}

export async function updateModelIndexOverlay(
  filePath: string,
  updater: (
    current: ModelIndexOverlay | null,
  ) => ModelIndexOverlay | Promise<ModelIndexOverlay>,
  options?: FileLockOptions,
): Promise<ModelIndexOverlay> {
  return withModelIndexLock(
    filePath,
    async (current) => {
      const next = await updater(current);
      const validated = ModelIndexOverlaySchema.parse(next);
      return { next: validated, result: validated };
    },
    options,
  );
}

export async function writeTeamYamlAtomic(
  teamYamlPath: string,
  manifest: TeamManifest,
): Promise<TeamManifest> {
  const validated = TeamManifestSchema.parse(manifest);
  const yamlText = serializeTeamYaml(validated);
  await writeTextAtomic(teamYamlPath, yamlText);
  return validated;
}

export async function withTeamYamlLock<T>(
  teamYamlPath: string,
  fn: (manifest: TeamManifest) => T | Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  return withFileLock(
    teamYamlPath,
    async () => {
      let raw: string;
      try {
        raw = await fs.readFile(teamYamlPath, "utf8");
      } catch (err) {
        if (isErrno(err, "ENOENT")) {
          throw new Error(`team.yaml missing: ${teamYamlPath}`);
        }
        throw err;
      }
      const manifest = parseTeamYaml(raw);
      const result = await fn(manifest);
      await writeTeamYamlAtomic(teamYamlPath, manifest);
      return result;
    },
    options,
  );
}

function mergeTierBinding(
  base: IdeTierBinding,
  patch: IdeTierBindingPatch | undefined,
): IdeTierBinding {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    primary: patch.primary ?? base.primary,
    fallback: patch.fallback ? [...patch.fallback] : [...base.fallback],
  };
}

function mergeCatalogEntries(
  baseCatalog: ModelCatalogEntry[],
  layer1Catalog: ModelCatalogEntry[] | undefined,
  layer2Catalog: ModelCatalogEntry[] | undefined,
): ModelCatalogEntry[] {
  const byId = new Map<string, ModelCatalogEntry>();
  const order: string[] = [];

  const upsert = (entry: ModelCatalogEntry): void => {
    const existing = byId.get(entry.id);
    if (!existing) {
      order.push(entry.id);
      byId.set(entry.id, {
        ...entry,
        capabilities: [...(entry.capabilities ?? [])],
      });
      return;
    }
    byId.set(entry.id, {
      ...existing,
      ...entry,
      capabilities: entry.capabilities
        ? [...entry.capabilities]
        : [...existing.capabilities],
    });
  };

  for (const entry of baseCatalog) {
    upsert(entry);
  }

  const layer1ById = new Map<string, ModelCatalogEntry>();
  for (const entry of layer1Catalog ?? []) {
    layer1ById.set(entry.id, entry);
    upsert(entry);
  }

  for (const entry of layer2Catalog ?? []) {
    const l1 = layer1ById.get(entry.id);
    upsert(entry);
    // Spec 2.2(3): If Layer 1 marks a previously "vscode-lm" entry available: false,
    // propagate live unavailability unless Layer 2 explicitly sets source "user" or "agent".
    if (
      l1 &&
      l1.source === "vscode-lm" &&
      l1.available === false &&
      entry.source !== "user" &&
      entry.source !== "agent"
    ) {
      const merged = byId.get(entry.id);
      if (merged) {
        merged.available = false;
        if (l1.discoveredAt) {
          merged.discoveredAt = l1.discoveredAt;
        }
      }
    }
  }

  return order.map((id) => byId.get(id)!);
}

function applyOverlayLayer(
  target: ModelIndex,
  layer: ModelIndexOverlay,
  layer1Snapshot?: ModelIndexOverlay | null,
): void {
  if (layer.updatedAt) {
    target.updatedAt = layer.updatedAt;
  }
  if (layer.updatedBy) {
    target.updatedBy = layer.updatedBy;
  }
  if (layer.notes !== undefined) {
    target.notes = layer.notes;
  }
  if (layer.roleRecommendations) {
    for (const [roleId, rec] of Object.entries(layer.roleRecommendations)) {
      const prev = target.roleRecommendations[roleId];
      target.roleRecommendations[roleId] = prev
        ? { ...prev, ...rec }
        : { ...rec };
    }
  }

  if (layer.ides) {
    for (const ide of ALL_IDES) {
      const idePatch = layer.ides[ide];
      if (!idePatch) continue;
      const ideTarget: IdeModelConfig = target.ides[ide];
      if (idePatch.mode) {
        ideTarget.mode = idePatch.mode;
      }
      if (idePatch.lastSyncedAt !== undefined) {
        ideTarget.lastSyncedAt = idePatch.lastSyncedAt;
      }
      if (idePatch.syncSource !== undefined) {
        ideTarget.syncSource = idePatch.syncSource;
      }
      if (idePatch.tiers) {
        for (const tier of ALL_TIERS) {
          ideTarget.tiers[tier] = mergeTierBinding(
            ideTarget.tiers[tier],
            idePatch.tiers[tier],
          );
        }
      }
      if (idePatch.catalog) {
        if (layer1Snapshot !== undefined) {
          // Merging Layer 2 after Layer 1 already applied
          ideTarget.catalog = mergeCatalogEntries(
            ideTarget.catalog,
            layer1Snapshot?.ides?.[ide]?.catalog,
            idePatch.catalog,
          );
        } else {
          ideTarget.catalog = mergeCatalogEntries(
            ideTarget.catalog,
            idePatch.catalog,
            undefined,
          );
        }
      }
    }
  }
}

export function mergeModelIndexLayers(
  layer1: ModelIndexOverlay | null,
  layer2: ModelIndexOverlay | null,
): ModelIndex {
  const effective = cloneDefaultModelIndex();
  if (layer1) {
    applyOverlayLayer(effective, layer1, undefined);
  }
  if (layer2) {
    applyOverlayLayer(effective, layer2, layer1 ?? null);
  }
  return ModelIndexSchema.parse(effective);
}

export function resolveEffectiveModelIndex(
  options: ResolveEffectiveModelIndexOptions = {},
): ModelIndex {
  const useGlobal = options.useGlobal ?? true;
  let layer1: ModelIndexOverlay | null = null;
  if (useGlobal) {
    if (options.globalOverlay !== undefined) {
      layer1 = options.globalOverlay;
    } else if (options.ignoreMalformedGlobal) {
      try {
        layer1 = readModelIndexLayerSync(getGlobalModelIndexPath());
      } catch {
        layer1 = null;
      }
    } else {
      layer1 = readModelIndexLayerSync(getGlobalModelIndexPath());
    }
  }

  let layer2: ModelIndexOverlay | null = null;
  if (options.workspaceOverlay !== undefined) {
    layer2 = options.workspaceOverlay;
  } else if (options.projectRoot) {
    layer2 = readModelIndexLayerSync(
      getWorkspaceModelIndexPath(options.projectRoot),
    );
  }

  return mergeModelIndexLayers(layer1, layer2);
}

export function mergeOverlayPatch(
  current: ModelIndexOverlay | null,
  patch: ModelIndexOverlay,
  updatedBy: ModelUpdatedBy = "api",
  nowIso = new Date().toISOString(),
): ModelIndexOverlay {
  const base: ModelIndexOverlay = current
    ? (JSON.parse(JSON.stringify(current)) as ModelIndexOverlay)
    : { schemaVersion: 1 };

  const out: ModelIndexOverlay = {
    ...base,
    schemaVersion: 1,
    updatedAt: patch.updatedAt ?? nowIso,
    updatedBy: patch.updatedBy ?? updatedBy,
    ...(patch.$schema !== undefined ? { $schema: patch.$schema } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
  };

  if (patch.roleRecommendations) {
    out.roleRecommendations = { ...(base.roleRecommendations ?? {}) };
    for (const [roleId, rec] of Object.entries(patch.roleRecommendations)) {
      const prev = out.roleRecommendations[roleId];
      out.roleRecommendations[roleId] = prev ? { ...prev, ...rec } : { ...rec };
    }
  }

  if (patch.ides) {
    out.ides = { ...(base.ides ?? {}) };
    for (const ide of ALL_IDES) {
      const idePatch = patch.ides[ide];
      if (!idePatch) continue;
      const prevIde: IdeModelOverlay = { ...(out.ides[ide] ?? {}) };
      const nextIde: IdeModelOverlay = {
        ...prevIde,
        ...(idePatch.mode !== undefined ? { mode: idePatch.mode } : {}),
        ...(idePatch.lastSyncedAt !== undefined
          ? { lastSyncedAt: idePatch.lastSyncedAt }
          : {}),
        ...(idePatch.syncSource !== undefined
          ? { syncSource: idePatch.syncSource }
          : {}),
      };

      if (idePatch.tiers) {
        nextIde.tiers = { ...(prevIde.tiers ?? {}) };
        for (const tier of ALL_TIERS) {
          const tPatch = idePatch.tiers[tier];
          if (!tPatch) continue;
          const prevTier = nextIde.tiers[tier];
          nextIde.tiers[tier] = {
            ...(prevTier ?? {}),
            ...tPatch,
            ...(tPatch.fallback ? { fallback: [...tPatch.fallback] } : {}),
          };
        }
      }

      if (idePatch.catalog) {
        const merged = mergeCatalogEntries(
          prevIde.catalog ?? [],
          idePatch.catalog,
          undefined,
        );
        nextIde.catalog = merged;
      }

      out.ides[ide] = nextIde;
    }
  }

  return ModelIndexOverlaySchema.parse(out);
}

export function upsertCatalogModel(
  current: ModelIndexOverlay | null,
  ide: IdeTarget,
  entry: ModelCatalogEntry,
  updatedBy: ModelUpdatedBy = "cli",
  nowIso = new Date().toISOString(),
): { overlay: ModelIndexOverlay; added: boolean } {
  const validatedEntry = ModelCatalogEntrySchema.parse(entry);
  const existing = current?.ides?.[ide]?.catalog ?? [];
  const added = !existing.some((c) => c.id === validatedEntry.id);
  const overlay = mergeOverlayPatch(
    current,
    {
      schemaVersion: 1,
      updatedAt: nowIso,
      updatedBy,
      ides: {
        [ide]: {
          catalog: [validatedEntry],
        },
      },
    },
    updatedBy,
    nowIso,
  );
  return { overlay, added };
}

export function applyDiscoveredModels(
  current: ModelIndexOverlay | null,
  opts: {
    ide: IdeTarget;
    models: DiscoverModelInput[];
    source?: "vscode-lm" | "manual";
    updatedBy?: ModelUpdatedBy;
    nowIso?: string;
  },
): DiscoverCatalogResult {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const inputSource = opts.source ?? "vscode-lm";
  const source: ModelSourceTag = inputSource === "manual" ? "user" : "vscode-lm";
  const syncSource: IdeSyncSource =
    inputSource === "vscode-lm" ? "vscode-lm" : "manual";
  const updatedBy: ModelUpdatedBy =
    opts.updatedBy ?? (inputSource === "vscode-lm" ? "vscode-lm" : "api");

  const next: ModelIndexOverlay = current
    ? (JSON.parse(JSON.stringify(current)) as ModelIndexOverlay)
    : { schemaVersion: 1 };
  next.schemaVersion = 1;
  next.updatedAt = nowIso;
  next.updatedBy = updatedBy;
  next.ides ??= {};

  const prevIde: IdeModelOverlay = { ...(next.ides[opts.ide] ?? {}) };
  const prevCatalog = [...(prevIde.catalog ?? [])];
  const byId = new Map<string, ModelCatalogEntry>();
  const order: string[] = [];

  for (const existing of prevCatalog) {
    byId.set(existing.id, { ...existing });
    order.push(existing.id);
  }

  let added = 0;
  let updated = 0;
  const incomingIds = new Set<string>();

  for (const raw of opts.models) {
    const id = raw.id.trim();
    if (!id) continue;
    incomingIds.add(id);

    const existing = byId.get(id);
    const tier =
      raw.tierHint ??
      existing?.tier ??
      inferModelTier(id, raw.family, raw.maxInputTokens);
    const capabilities =
      raw.capabilities && raw.capabilities.length > 0
        ? raw.capabilities
        : existing?.capabilities && existing.capabilities.length > 0
          ? existing.capabilities
          : inferModelCapabilities(id, tier, raw.family, raw.maxInputTokens);

    const nextEntry = ModelCatalogEntrySchema.parse({
      ...(existing ?? {}),
      id,
      label: raw.label?.trim() || existing?.label || id,
      ...(raw.vendor !== undefined
        ? { vendor: raw.vendor.trim() || undefined }
        : existing?.vendor
          ? { vendor: existing.vendor }
          : {}),
      ...(raw.family !== undefined
        ? { family: raw.family.trim() || undefined }
        : existing?.family
          ? { family: existing.family }
          : {}),
      tier,
      capabilities,
      ...(typeof raw.maxInputTokens === "number" && raw.maxInputTokens > 0
        ? { contextWindow: Math.floor(raw.maxInputTokens) }
        : existing?.contextWindow
          ? { contextWindow: existing.contextWindow }
          : {}),
      ...(raw.premiumMultiplier !== undefined
        ? { premiumMultiplier: raw.premiumMultiplier }
        : existing?.premiumMultiplier !== undefined
          ? { premiumMultiplier: existing.premiumMultiplier }
          : {}),
      available: true,
      source,
      discoveredAt: nowIso,
      ...(raw.notes !== undefined
        ? { notes: raw.notes }
        : existing?.notes
          ? { notes: existing.notes }
          : {}),
    });

    if (existing) {
      updated++;
      byId.set(id, nextEntry);
    } else {
      added++;
      order.push(id);
      byId.set(id, nextEntry);
    }
  }

  let markedUnavailable = 0;
  if (source === "vscode-lm") {
    for (const id of order) {
      if (incomingIds.has(id)) continue;
      const entry = byId.get(id);
      if (entry && entry.source === "vscode-lm" && entry.available !== false) {
        entry.available = false;
        entry.discoveredAt = nowIso;
        markedUnavailable++;
      }
    }
  }

  next.ides[opts.ide] = {
    ...prevIde,
    lastSyncedAt: nowIso,
    syncSource,
    catalog: order.map((id) => byId.get(id)!),
  };

  return {
    overlay: ModelIndexOverlaySchema.parse(next),
    count: incomingIds.size,
    added,
    updated,
    markedUnavailable,
  };
}

export function adoptGlobalOverlayIntoWorkspace(
  globalOverlay: ModelIndexOverlay | null,
  workspaceOverlay: ModelIndexOverlay | null,
  options: AdoptGlobalModelsOptions = {},
): AdoptGlobalModelsResult {
  const nowIso = new Date().toISOString();
  const updatedBy = options.updatedBy ?? "cli";
  const targetIdes = options.ide ? [options.ide] : ALL_IDES;

  const base: ModelIndexOverlay = workspaceOverlay
    ? (JSON.parse(JSON.stringify(workspaceOverlay)) as ModelIndexOverlay)
    : {
        ...cloneDefaultModelIndex(),
        updatedAt: nowIso,
        updatedBy,
      };
  base.schemaVersion = 1;
  base.updatedAt = nowIso;
  base.updatedBy = updatedBy;
  base.ides ??= {};

  let adoptedCatalogCount = 0;
  let adoptedTierCount = 0;

  if (!globalOverlay) {
    return {
      adoptedCatalogCount: 0,
      adoptedTierCount: 0,
      overlay: ModelIndexOverlaySchema.parse(base),
    };
  }

  for (const ide of targetIdes) {
    const gIde = globalOverlay.ides?.[ide];
    if (!gIde) continue;

    const wIde: IdeModelOverlay = { ...(base.ides[ide] ?? {}) };
    const wCatalog = [...(wIde.catalog ?? [])];
    const wById = new Map(wCatalog.map((c) => [c.id, c]));

    for (const entry of gIde.catalog ?? []) {
      if (options.tier && entry.tier !== options.tier) continue;
      const prev = wById.get(entry.id);
      const changed =
        !prev ||
        prev.available !== entry.available ||
        prev.label !== entry.label ||
        prev.tier !== entry.tier ||
        prev.vendor !== entry.vendor ||
        prev.family !== entry.family ||
        prev.contextWindow !== entry.contextWindow;
      if (changed) {
        adoptedCatalogCount++;
      }
      wById.set(entry.id, { ...entry });
      if (!prev) {
        wCatalog.push({ ...entry });
      } else {
        const idx = wCatalog.findIndex((c) => c.id === entry.id);
        if (idx >= 0) wCatalog[idx] = { ...entry };
      }
    }

    if (wCatalog.length > 0 || (gIde.catalog && gIde.catalog.length > 0)) {
      wIde.catalog = wCatalog;
    }

    if (gIde.tiers) {
      wIde.tiers = { ...(wIde.tiers ?? {}) };
      const targetTiers = options.tier ? [options.tier] : ALL_TIERS;
      for (const tier of targetTiers) {
        const gTier = gIde.tiers[tier];
        if (!gTier) continue;
        const prevTier = wIde.tiers[tier];
        if (JSON.stringify(prevTier ?? null) !== JSON.stringify(gTier)) {
          adoptedTierCount++;
        }
        wIde.tiers[tier] = {
          ...gTier,
          ...(gTier.fallback ? { fallback: [...gTier.fallback] } : {}),
        };
      }
    }

    if (gIde.lastSyncedAt) {
      wIde.lastSyncedAt = gIde.lastSyncedAt;
    }
    if (gIde.syncSource) {
      wIde.syncSource = gIde.syncSource;
    }

    base.ides[ide] = wIde;
  }

  return {
    adoptedCatalogCount,
    adoptedTierCount,
    overlay: ModelIndexOverlaySchema.parse(base),
  };
}

export function doesGlobalDifferFromWorkspace(
  globalOverlay: ModelIndexOverlay | null,
  workspaceOverlay: ModelIndexOverlay | null,
  ideFilter?: IdeTarget,
): boolean {
  if (!globalOverlay) return false;
  const targetIdes = ideFilter ? [ideFilter] : ALL_IDES;

  for (const ide of targetIdes) {
    const gIde = globalOverlay.ides?.[ide];
    if (!gIde) continue;
    const wIde = workspaceOverlay?.ides?.[ide];
    const defaultIde = DEFAULT_MODEL_INDEX.ides[ide];

    for (const tier of ALL_TIERS) {
      const gTier = gIde.tiers?.[tier];
      if (!gTier) continue;
      const wTier = wIde?.tiers?.[tier] ?? defaultIde.tiers[tier];
      if (
        (gTier.primary !== undefined && gTier.primary !== wTier.primary) ||
        (gTier.fallback !== undefined &&
          JSON.stringify(gTier.fallback) !== JSON.stringify(wTier.fallback))
      ) {
        return true;
      }
    }

    const wCatalogMap = new Map(
      (wIde?.catalog ?? defaultIde.catalog).map((c) => [c.id, c]),
    );
    for (const gEntry of gIde.catalog ?? []) {
      const wEntry = wCatalogMap.get(gEntry.id);
      if (!wEntry) return true;
      if (
        wEntry.available !== gEntry.available ||
        wEntry.tier !== gEntry.tier ||
        wEntry.label !== gEntry.label
      ) {
        return true;
      }
    }
  }

  return false;
}
