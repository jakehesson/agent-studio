import type { HostIde } from "./scoping";

export interface LanguageModelChatLike {
  id: string;
  name?: string;
  vendor?: string;
  family?: string;
  version?: string;
  maxInputTokens?: number;
}

export interface DisposableLike {
  dispose(): void;
}

export interface LanguageModelApiLike {
  selectChatModels?: (
    selector?: Record<string, unknown>,
  ) => PromiseLike<readonly LanguageModelChatLike[]>;
  onDidChangeChatModels?: (listener: () => void) => DisposableLike;
}

export interface OutputChannelLike {
  appendLine(value: string): void;
}

export interface ModelSyncTransport {
  detectHostIde(): HostIde;
  detectWorkspaceProjectId(): string | undefined;
  getPrimaryWorkspaceRoot(): string | undefined;
  getStatus(): { online: boolean };
  ensureRunning(forceStart?: boolean): Promise<{ online: boolean }>;
  postJson<T>(
    endpointPath: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<T | null>;
  runCli(
    args: string[],
    cwdOrOptions?: string | { cwd?: string; stdinText?: string },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface DiscoveredModelPayload {
  id: string;
  label: string;
  vendor?: string;
  family?: string;
  version?: string;
  maxInputTokens?: number;
}

export interface ModelSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  transport?: "http" | "cli";
  ide: HostIde;
  count: number;
  added?: number;
  updated?: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @deprecated Copilot now preserves native runtime model IDs (`m.id`).
 * Kept only for legacy helper compatibility until callers migrate.
 * Formats Copilot picker labels as `"${name} (${vendor})"` without duplicating
 * an existing `(vendor)` suffix.
 */
export function formatPickerLabel(name: string, vendor?: string): string {
  const cleanName = name.trim();
  const cleanVendor = vendor?.trim();
  if (!cleanName) {
    return cleanVendor ?? "";
  }
  if (!cleanVendor) {
    return cleanName;
  }
  const suffixRe = new RegExp(`\\(${escapeRegExp(cleanVendor)}\\)`, "i");
  if (suffixRe.test(cleanName)) {
    return cleanName;
  }
  return `${cleanName} (${cleanVendor})`;
}

export function isLanguageModelApiSupported(
  lm: LanguageModelApiLike | undefined | null,
): boolean {
  return Boolean(lm && typeof lm.selectChatModels === "function");
}

export function mapLanguageModelsForHost(
  hostIde: HostIde,
  models: readonly LanguageModelChatLike[],
): DiscoveredModelPayload[] {
  const seen = new Set<string>();
  const mapped: DiscoveredModelPayload[] = [];

  for (const m of models) {
    const rawName = (m.name ?? m.id ?? "").trim();
    const rawId = (m.id ?? m.name ?? "").trim();
    const vendor = m.vendor?.trim() || undefined;
    const family = m.family?.trim() || undefined;
    const version = m.version?.trim() || undefined;
    const maxInputTokens =
      typeof m.maxInputTokens === "number" &&
      Number.isFinite(m.maxInputTokens) &&
      m.maxInputTokens > 0
        ? Math.floor(m.maxInputTokens)
        : undefined;

    const id = rawId || rawName;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    mapped.push({
      id,
      label: rawName || id,
      ...(vendor ? { vendor } : {}),
      ...(family ? { family } : {}),
      ...(version ? { version } : {}),
      ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    });
  }

  return mapped;
}

export const MODEL_SYNC_DEBOUNCE_MS = 2000;

export class ModelSyncManager implements DisposableLike {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private changeSubscription: DisposableLike | undefined;
  private inFlight: Promise<ModelSyncResult> | undefined;
  private disposed = false;

  constructor(
    private readonly transport: ModelSyncTransport,
    private readonly output: OutputChannelLike,
    private readonly lm: LanguageModelApiLike | undefined,
    private readonly debounceMs: number = MODEL_SYNC_DEBOUNCE_MS,
  ) {
    if (this.lm && typeof this.lm.onDidChangeChatModels === "function") {
      try {
        this.changeSubscription = this.lm.onDidChangeChatModels(() => {
          this.scheduleDebouncedSync();
        });
      } catch (err) {
        this.output.appendLine(
          `[model-sync] Failed to subscribe to onDidChangeChatModels: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  public scheduleDebouncedSync(): void {
    if (this.disposed) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.syncNow({ reason: "event" });
    }, this.debounceMs);
  }

  public async syncNow(opts?: {
    reason?: "startup" | "event" | "manual";
    allowCliFallback?: boolean;
  }): Promise<ModelSyncResult> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.syncNowInternal(opts).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async syncNowInternal(opts?: {
    reason?: "startup" | "event" | "manual";
    allowCliFallback?: boolean;
  }): Promise<ModelSyncResult> {
    const hostIde = this.transport.detectHostIde();
    if (!isLanguageModelApiSupported(this.lm)) {
      this.output.appendLine(
        `[model-sync] vscode.lm.selectChatModels unavailable on ${hostIde}; skipping live model discovery.`,
      );
      return {
        ok: false,
        skipped: true,
        reason: "lm-api-unavailable",
        ide: hostIde,
        count: 0,
      };
    }

    let rawModels: readonly LanguageModelChatLike[];
    try {
      rawModels = await this.lm!.selectChatModels!();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[model-sync] selectChatModels failed: ${msg}`);
      return {
        ok: false,
        skipped: true,
        reason: msg,
        ide: hostIde,
        count: 0,
      };
    }

    if (hostIde === "antigravity" && rawModels.length === 0) {
      return {
        ok: true,
        skipped: true,
        reason: "antigravity-no-lm-models",
        ide: hostIde,
        count: 0,
      };
    }

    const models = mapLanguageModelsForHost(hostIde, rawModels);
    const project = this.transport.detectWorkspaceProjectId();
    const workspaceRoot = this.transport.getPrimaryWorkspaceRoot();

    const status = await this.transport.ensureRunning(false);
    if (status.online) {
      const resp = await this.transport.postJson<{
        ok?: boolean;
        count?: number;
        added?: number;
        updated?: number;
      }>("/api/model-index/discover", {
        ide: hostIde,
        source: "vscode-lm",
        scope: "global",
        ...(project ? { project } : {}),
        ...(workspaceRoot ? { workspace: workspaceRoot } : {}),
        models,
      });

      if (resp?.ok) {
        this.output.appendLine(
          `[model-sync] Synced ${models.length} live ${hostIde} model(s) via HTTP (added=${resp.added ?? 0}, updated=${resp.updated ?? 0}).`,
        );
        return {
          ok: true,
          transport: "http",
          ide: hostIde,
          count: models.length,
          added: resp.added,
          updated: resp.updated,
        };
      }
    }

    const allowCli = opts?.allowCliFallback ?? opts?.reason === "manual";
    if (allowCli) {
      try {
        const res = await this.transport.runCli(
          [
            "models",
            "discover",
            "--ide",
            hostIde,
            "--scope",
            "global",
            "--stdin",
            "--json",
          ],
          {
            cwd: workspaceRoot,
            stdinText: JSON.stringify({ models }),
          },
        );
        if (res.code === 0) {
          let parsed: { added?: number; updated?: number } = {};
          try {
            parsed = JSON.parse(res.stdout) as { added?: number; updated?: number };
          } catch {
            // ignore non-json stdout
          }
          this.output.appendLine(
            `[model-sync] Synced ${models.length} live ${hostIde} model(s) via offline CLI fallback.`,
          );
          return {
            ok: true,
            transport: "cli",
            ide: hostIde,
            count: models.length,
            added: parsed.added,
            updated: parsed.updated,
          };
        }
        return {
          ok: false,
          reason: res.stderr || `CLI exited with code ${res.code}`,
          ide: hostIde,
          count: models.length,
        };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
          ide: hostIde,
          count: models.length,
        };
      }
    }

    return {
      ok: false,
      skipped: true,
      reason: "server-offline",
      ide: hostIde,
      count: models.length,
    };
  }

  public dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.changeSubscription?.dispose();
    this.changeSubscription = undefined;
  }
}
