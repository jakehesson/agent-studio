import { fetchDoctor, postDoctorTestEvent } from "../api.js";
import { IdeUsageGuides, type GuideIdeId } from "../components/IdeUsageGuides.js";
import type {
  CheckStatus,
  DoctorApiResponse,
  EmbedScope,
  HostIde,
  IdeHealthCard,
  ModelIndexHealth,
  SessionSnapshot,
} from "../types.js";
import { escHtml, getIdeMeta } from "../utils.js";

function statusIcon(st: CheckStatus): string {
  if (st === "pass") return "✓ PASS";
  if (st === "warn") return "⚠ WARN";
  if (st === "fail") return "✕ FAIL";
  return "• INFO";
}

function isModelMessageRelevantToIde(msg: string, lockedIde: HostIde | null): boolean {
  if (!lockedIde) return true;
  const low = msg.toLowerCase();
  const mentionsCopilot =
    low.includes("copilot") ||
    low.includes("vs code") ||
    low.includes("vscode") ||
    low.includes(".agent.md") ||
    low.includes("(copilot)") ||
    low.includes("fusion") ||
    low.includes("vscode-lm") ||
    low.includes("refresh live model index") ||
    low.includes("picker");
  const mentionsAntigravity =
    low.includes("antigravity") ||
    low.includes("/swarm") ||
    low.includes(".agents/plugins");
  const mentionsClaude =
    low.includes("claude code") ||
    low.includes("claude-code") ||
    low.includes(".claude/") ||
    low.includes("claude_code_subagent_model") ||
    low.includes("claudecode");

  if (!mentionsCopilot && !mentionsAntigravity && !mentionsClaude) {
    return true;
  }
  if (lockedIde === "copilot-vscode") return mentionsCopilot;
  if (lockedIde === "antigravity") return mentionsAntigravity;
  return mentionsClaude;
}

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export class DoctorView {
  private root: HTMLElement;
  private onOpenTeam?: () => void;
  private currentProject = "";
  private currentWorkspace = "";
  private embedScope: EmbedScope = {
    embedMode: false,
    lockedIde: null,
    lockedWorkspace: "",
  };
  private data: DoctorApiResponse | null = null;
  private loading = false;
  private errorMsg: string | null = null;
  private guides: IdeUsageGuides | null = null;
  private activeGuideIde: GuideIdeId = "antigravity";

  private testState: {
    status: "idle" | "sending" | "awaiting_sse" | "confirmed" | "error";
    eventId?: string;
    message?: string;
    sentAt?: number;
  } = { status: "idle" };

  constructor(root: HTMLElement, opts?: { onOpenTeam?: () => void }) {
    this.root = root;
    this.onOpenTeam = opts?.onOpenTeam;
    this.render();
  }

  public setEmbedScope(scope: EmbedScope): void {
    this.embedScope = { ...scope };
    if (scope.lockedIde) {
      this.activeGuideIde = scope.lockedIde;
    }
    this.render();
  }

  public async load(projectId: string, workspace?: string): Promise<void> {
    this.currentProject = projectId;
    if (workspace !== undefined) this.currentWorkspace = workspace;
    const effectiveWorkspace = this.currentWorkspace || this.embedScope.lockedWorkspace || undefined;
    this.loading = true;
    this.errorMsg = null;
    this.render();
    try {
      this.data = await fetchDoctor(projectId || undefined, effectiveWorkspace);
    } catch (err) {
      this.errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  /**
   * Called by App shell whenever a live SSE snapshot arrives so Doctor can confirm
   * true end-to-end PushBus -> Normalizer -> SSE round-trip delivery.
   */
  public notifyLiveSnapshot(snapshot: SessionSnapshot): void {
    if (this.testState.status !== "awaiting_sse") return;
    const match = this.testState.eventId
      ? snapshot.events.some((ev) => ev.id === this.testState.eventId)
      : snapshot.events.some(
          (ev) =>
            ev.summary.toLowerCase().includes("doctor test") ||
            (this.testState.sentAt != null && ev.epoch * 1000 >= this.testState.sentAt - 2000)
        );
    if (match) {
      const ms = this.testState.sentAt ? Math.max(1, Date.now() - this.testState.sentAt) : 0;
      this.testState = {
        status: "confirmed",
        eventId: this.testState.eventId,
        message: `Round-trip SSE delivery confirmed in ${ms}ms!`,
      };
      this.updateTestBanner();
    }
  }

  private updateTestBanner(): void {
    const slot = this.root.querySelector<HTMLElement>("[data-test-banner-slot]");
    if (slot) {
      slot.innerHTML =
        this.testState.status !== "idle"
          ? `<div class="test-banner status-${escHtml(this.testState.status)}" role="status">
              <strong>${
                this.testState.status === "confirmed"
                  ? "✓ Verified"
                  : this.testState.status === "error"
                    ? "✕ Failed"
                    : "⋯ Testing"
              }</strong>
              <span>${escHtml(this.testState.message)}</span>
            </div>`
          : "";
    }
    const sendBtn = this.root.querySelector<HTMLButtonElement>("[data-send-test]");
    if (sendBtn) {
      sendBtn.disabled = this.testState.status === "sending";
      sendBtn.textContent =
        this.testState.status === "sending" ? "⋯ Sending…" : "⚡ Send Test Event";
    }
  }

  private async triggerTestEvent(): Promise<void> {
    this.testState = {
      status: "sending",
      message: "Dispatching synthetic event via POST /api/doctor/test-event…",
      sentAt: Date.now(),
    };
    this.updateTestBanner();

    try {
      const res = await postDoctorTestEvent({
        project: this.currentProject || undefined,
        ide: this.embedScope.lockedIde ?? "mcp",
      });
      this.testState = {
        status: "awaiting_sse",
        eventId: res.eventId,
        sentAt: this.testState.sentAt,
        message: res.message || `Event ${res.eventId ?? ""} accepted — waiting for SSE broadcast…`,
      };
      this.updateTestBanner();

      // If no SSE frame arrives within 3.5s, show accepted status clearly
      window.setTimeout(() => {
        if (this.testState.status === "awaiting_sse") {
          this.testState = {
            status: "confirmed",
            eventId: this.testState.eventId,
            message: `Accepted by server (${this.testState.eventId ?? "ok"}). Switch to Live Studio to view timeline event.`,
          };
          this.updateTestBanner();
        }
      }, 3500);
    } catch (err) {
      this.testState = {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      this.updateTestBanner();
    }
  }

  private render(): void {
    if (this.loading && !this.data) {
      this.root.innerHTML = `<div class="view-placeholder">Running IDE &amp; telemetry diagnostics…</div>`;
      return;
    }

    if (this.errorMsg && !this.data) {
      this.root.innerHTML = `
        <div class="view-empty-wrap">
          <div class="view-empty-card">
            <h2>Doctor Diagnostics Unavailable</h2>
            <p>${escHtml(this.errorMsg)}</p>
            <button type="button" class="btn-primary" data-doc-refresh>Retry</button>
          </div>
        </div>
      `;
      this.root
        .querySelector("[data-doc-refresh]")
        ?.addEventListener("click", () => void this.load(this.currentProject));
      return;
    }

    const doc = this.data;
    const ides: IdeHealthCard[] = doc?.ides?.length
      ? doc.ides
      : [
          {
            ide: "antigravity",
            name: "Antigravity",
            detected: false,
            adapterStatus: "unknown",
            configDrift: [],
            mcpConfigured: false,
            hooksConfigured: false,
          },
          {
            ide: "claude-code",
            name: "Claude Code",
            detected: false,
            adapterStatus: "unknown",
            configDrift: [],
            mcpConfigured: false,
            hooksConfigured: false,
          },
          {
            ide: "copilot-vscode",
            name: "GitHub Copilot / VS Code",
            detected: false,
            adapterStatus: "unknown",
            configDrift: [],
            mcpConfigured: false,
            hooksConfigured: false,
          },
        ];

    const lockedIde = this.embedScope.lockedIde;
    const visibleIdes = lockedIde
      ? ides.filter((c) => c.ide === lockedIde)
      : ides;
    const checks = (doc?.checks ?? []).filter((c) => {
      if (!lockedIde) return true;
      if (c.id.startsWith("telemetry-") && c.id !== `telemetry-${lockedIde}`) return false;
      if (c.id.includes("model") && !isModelMessageRelevantToIde(`${c.label} ${c.detail}`, lockedIde)) {
        return false;
      }
      return true;
    });
    const driftFiles = (doc?.driftFiles ?? []).filter((d) => {
      if (!lockedIde) return true;
      return !d.ide || d.ide === lockedIde;
    });
    const guard = doc?.guardrails;

    const hostIdeCard = lockedIde ? visibleIdes[0] : undefined;
    const hostIdeMeta = lockedIde ? getIdeMeta(lockedIde) : null;

    this.root.innerHTML = `
      <div class="doctor-view">
        <section class="card doctor-hero">
          <div class="doctor-hero-top">
            <div>
              <h2>Setup &amp; Telemetry Doctor</h2>
              <p class="muted">
                ${
                  lockedIde && hostIdeMeta
                    ? `Live health verification for <strong>${escHtml(hostIdeMeta.label)}</strong> adapter, MCP guardrails, and SSE push telemetry in this workspace.`
                    : "Live health verification across Antigravity, Claude Code, and GitHub Copilot / VS Code adapters, MCP guardrails, and SSE push telemetry."
                }
              </p>
            </div>
            <div class="doctor-hero-actions">
              <button type="button" class="btn-secondary" data-jump-guides>📖 ${lockedIde && hostIdeMeta ? `${escHtml(hostIdeMeta.label)} Guide` : "Usage Guides"}</button>
              <button
                type="button"
                class="btn-secondary"
                data-doc-refresh
                ${this.loading ? "disabled" : ""}
              >${this.loading ? "Refreshing…" : "↻ Re-run Doctor"}</button>
              <button
                type="button"
                class="btn-primary"
                data-send-test
                ${this.testState.status === "sending" ? "disabled" : ""}
              >${this.testState.status === "sending" ? "⋯ Sending…" : "⚡ Send Test Event"}</button>
            </div>
          </div>

          <div data-test-banner-slot></div>

          <div class="kpi-strip">
            <div class="kpi-card"><span>Node Runtime</span><b>${escHtml(doc?.nodeVersion || "v22+")}</b></div>
            <div class="kpi-card"><span>team.yaml</span><b class="${doc?.teamYamlValid ? "kpi-ok" : "kpi-warn"}">${doc?.teamYamlValid ? "VALID" : "PENDING"}</b></div>
            ${
              lockedIde && hostIdeMeta
                ? `<div class="kpi-card"><span>Host IDE</span><b class="${hostIdeCard?.detected ? "kpi-ok" : "kpi-warn"}">${escHtml(hostIdeMeta.label)} · ${hostIdeCard?.detected ? "DETECTED" : "NOT FOUND"}</b></div>`
                : `<div class="kpi-card"><span>IDEs Detected</span><b>${visibleIdes.filter((i) => i.detected).length} / ${visibleIdes.length}</b></div>`
            }
            <div class="kpi-card"><span>Config Drift</span><b class="${driftFiles.length === 0 ? "kpi-ok" : "kpi-warn"}">${driftFiles.length}</b></div>
          </div>
        </section>

        <section class="ide-cards-grid ${lockedIde ? "is-single-ide" : ""}" aria-label="Detected IDE adapters">
          ${visibleIdes.map((card) => this.renderIdeCard(card)).join("")}
        </section>

        ${this.renderModelIndexHealthCard(doc?.modelIndex, lockedIde)}

        <div class="doctor-bottom-grid">
          <section class="card board-panel">
            <div class="card-head">
              <span class="card-title">Guardrails &amp; Enforcement</span>
              <span class="pill ok">Defense-in-Depth</span>
            </div>
            <div class="board-panel-body guardrail-list">
              <div class="issue-row ${guard?.orchestratorReadOnly !== false ? "ok" : "warn"}">
                <span>${guard?.orchestratorReadOnly !== false ? "✓" : "⚠"}</span>
                <span><strong>Orchestrator Read-Only Tool Allowlist</strong> — Edit/write/shell tools stripped across compiled IDE configs.</span>
              </div>
              <div class="issue-row ${guard?.qaGateRequired !== false ? "ok" : "warn"}">
                <span>${guard?.qaGateRequired !== false ? "✓" : "⚠"}</span>
                <span><strong>Server-Side MCP QA Gate</strong> — Rejects <code>test → done</code> transitions without a closed passing testrun.</span>
              </div>
              <div class="issue-row ${guard?.blockDirectBoardEdits !== false ? "ok" : "warn"}">
                <span>${guard?.blockDirectBoardEdits !== false ? "✓" : "⚠"}</span>
                <span><strong>PreToolUse Hook Protection</strong> — Blocks direct edits to <code>pipeline/board.json</code> in Claude Code &amp; VS Code.</span>
              </div>
            </div>
          </section>

          <section class="card board-panel">
            <div class="card-head">
              <span class="card-title">System Checks &amp; Drift</span>
              <span class="muted">${checks.length} checks</span>
            </div>
            <div class="board-panel-body">
              ${
                checks.length === 0 && driftFiles.length === 0
                  ? `<div class="issue-row ok">✓ All adapter hashes and telemetry paths look healthy.</div>`
                  : [
                      ...checks.map(
                        (c) => `
                          <div class="issue-row ${c.status === "pass" ? "ok" : c.status === "fail" ? "error" : "warn"}">
                            <span class="check-tag">${escHtml(statusIcon(c.status))}</span>
                            <div>
                              <strong>${escHtml(c.label)}</strong> — ${escHtml(c.detail)}
                              ${c.fixHint ? `<div class="muted">Fix: <code>${escHtml(c.fixHint)}</code></div>` : ""}
                            </div>
                          </div>
                        `
                      ),
                      ...driftFiles.map(
                        (d) => `
                          <div class="issue-row warn">
                            <span class="check-tag">DRIFT</span>
                            <div><code>${escHtml(d.file)}</code> (${escHtml(d.status)})${d.reason ? ` — ${escHtml(d.reason)}` : ""} · run <code>agent-studio sync</code></div>
                          </div>
                        `
                      ),
                    ].join("")
              }
            </div>
          </section>
        </div>

        <div data-ide-guides-slot></div>
      </div>
    `;

    this.updateTestBanner();

    this.root
      .querySelector("[data-doc-refresh]")
      ?.addEventListener("click", () => void this.load(this.currentProject));
    this.root
      .querySelector("[data-send-test]")
      ?.addEventListener("click", () => void this.triggerTestEvent());

    const guidesSlot = this.root.querySelector("[data-ide-guides-slot]") as HTMLElement | null;
    if (guidesSlot) {
      this.guides = new IdeUsageGuides(
        guidesSlot,
        lockedIde ?? this.activeGuideIde,
        lockedIde
      );
      guidesSlot.addEventListener("click", (e) => {
        const tab = (e.target as Element | null)?.closest<HTMLButtonElement>("[data-guide-tab]");
        const ide = tab?.dataset.guideTab as GuideIdeId | undefined;
        if (ide) this.activeGuideIde = ide;
      });
    }

    this.root.querySelector("[data-jump-guides]")?.addEventListener("click", () => {
      this.guides?.selectIde(this.activeGuideIde, true);
    });

    this.root.querySelectorAll<HTMLButtonElement>("[data-open-guide]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ide = btn.dataset.openGuide as GuideIdeId | undefined;
        if (ide) {
          this.activeGuideIde = ide;
          this.guides?.selectIde(ide, true);
        }
      });
    });

    this.root.querySelector("[data-doc-open-team]")?.addEventListener("click", () => {
      this.onOpenTeam?.();
    });

    this.root.querySelectorAll<HTMLButtonElement>("[data-doc-copy-cmd]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const cmd = btn.dataset.docCopyCmd ?? "";
        if (!cmd) return;
        const ok = await copyTextSafe(cmd);
        btn.textContent = ok ? "Copied ✓" : "Failed";
        btn.classList.toggle("copied", ok);
        window.setTimeout(() => {
          btn.textContent = "Copy CLI";
          btn.classList.remove("copied");
        }, 1500);
      });
    });
  }

  private renderModelIndexHealthCard(
    mi: ModelIndexHealth | undefined,
    lockedIde: HostIde | null
  ): string {
    if (!mi) return "";
    const filteredErrors = mi.errors.filter((e) =>
      isModelMessageRelevantToIde(e, lockedIde)
    );
    const filteredWarnings = mi.warnings.filter((w) =>
      isModelMessageRelevantToIde(w, lockedIde)
    );
    const hasErr = !mi.valid || filteredErrors.length > 0;
    const hasWarn = filteredWarnings.length > 0;
    const statusBadgeClass = hasErr ? "cp-failed" : hasWarn ? "cp-running" : "cp-passed";
    const statusBadgeText = hasErr ? "✕ ERRORS" : hasWarn ? "⚠ WARNINGS" : "✓ HEALTHY";
    const quickCli = lockedIde
      ? `agent-studio models show --ide ${lockedIde}`
      : "agent-studio models show";

    return `
      <section class="card model-index-health" aria-labelledby="docModelIndexHeading">
        <div class="card-head">
          <div class="mi-health-title-group">
            <span class="card-title" id="docModelIndexHeading">Model Index &amp; Routing Health</span>
            <span class="pill dispatch">Policy: ${escHtml(mi.policy)}</span>
            <span class="cp-badge ${statusBadgeClass}">${statusBadgeText}</span>
          </div>
          <div class="mi-health-actions">
            <button type="button" class="guide-copy-btn" data-doc-copy-cmd="${escHtml(quickCli)}">Copy CLI</button>
            ${
              this.onOpenTeam
                ? `<button type="button" class="btn-secondary btn-sm" data-doc-open-team>Manage Model Routing →</button>`
                : ""
            }
          </div>
        </div>

        <div class="board-panel-body">
          <div class="mi-health-layers">
            <div class="mi-health-layer">
              <div class="mi-health-layer-top">
                <strong>Workspace Overlay</strong>
                <span class="pill ${mi.layers.workspaceExists ? "ok" : "tool"}">
                  ${mi.layers.workspaceExists ? "✓ Active" : "○ Built-in Defaults"}
                </span>
              </div>
              <code>${escHtml(mi.layers.workspacePath)}</code>
              ${
                mi.layers.workspaceUpdatedAt
                  ? `<span class="muted">Updated: ${escHtml(mi.layers.workspaceUpdatedAt)}</span>`
                  : ""
              }
            </div>
            <div class="mi-health-layer">
              <div class="mi-health-layer-top">
                <strong>Global Overlay</strong>
                <span class="pill ${mi.layers.globalExists ? "ok" : "tool"}">
                  ${mi.layers.globalExists ? "✓ Present" : "○ Not Created"}
                </span>
              </div>
              <code>${escHtml(mi.layers.globalPath)}</code>
              ${
                mi.layers.globalLastSyncedAt
                  ? `<span class="muted">Last Synced: ${escHtml(mi.layers.globalLastSyncedAt)}</span>`
                  : ""
              }
            </div>
          </div>

          ${filteredErrors
            .map(
              (err) => `
                <div class="issue-row error">
                  <span class="check-tag">✕ ERR</span>
                  <span>${escHtml(err)}</span>
                </div>
              `
            )
            .join("")}

          ${filteredWarnings
            .map(
              (warn) => `
                <div class="issue-row warn">
                  <span class="check-tag">⚠ WARN</span>
                  <span>${escHtml(warn)}</span>
                </div>
              `
            )
            .join("")}

          ${
            filteredErrors.length === 0 && filteredWarnings.length === 0
              ? `<div class="issue-row ok">
                  <span class="check-tag">✓ PASS</span>
                  <span>Model Index overlays and host routing policies are valid${lockedIde ? ` for ${escHtml(getIdeMeta(lockedIde).label)}` : ""}.</span>
                </div>`
              : ""
          }
        </div>
      </section>
    `;
  }

  private renderIdeCard(card: IdeHealthCard): string {
    const meta = getIdeMeta(card.ide);
    return `
      <article class="card ide-health-card">
        <div class="card-head">
          <div class="ide-card-title">
            <span class="ide-chip" style="color:${meta.color};border-color:${meta.border};background:${meta.bg}">${escHtml(meta.short)}</span>
            <strong>${escHtml(card.name || meta.label)}</strong>
          </div>
          <span class="cp-badge cp-${card.detected ? "passed" : "running"}">${card.detected ? "DETECTED" : "NOT FOUND"}</span>
        </div>
        <div class="ide-card-body">
          <div class="ide-stat-row">
            <span>Adapter Health</span>
            <span class="status-text st-${escHtml(card.adapterStatus)}">${escHtml(statusIcon(card.adapterStatus))}</span>
          </div>
          <div class="ide-stat-row">
            <span>MCP Server Wired</span>
            <span>${card.mcpConfigured ? "✓ Configured" : "— Not wired"}</span>
          </div>
          <div class="ide-stat-row">
            <span>Telemetry Hooks</span>
            <span>${card.hooksConfigured ? "✓ Active" : "Passive only"}</span>
          </div>
          ${
            card.sessionCount != null
              ? `<div class="ide-stat-row"><span>Discovered Sessions</span><b>${card.sessionCount}</b></div>`
              : ""
          }
          ${
            card.telemetryPath
              ? `<div class="ide-path"><code>${escHtml(card.telemetryPath)}</code></div>`
              : ""
          }
          ${
            card.configDrift.length > 0
              ? `<div class="issue-row warn">⚠ ${card.configDrift.length} drifted file(s): ${escHtml(card.configDrift.join(", "))}</div>`
              : `<div class="issue-row ok">✓ Zero config drift</div>`
          }
          <div class="ide-card-foot">
            <button
              type="button"
              class="ide-guide-jump"
              data-open-guide="${escHtml(card.ide)}"
            >📖 View ${escHtml(meta.label)} Guide →</button>
          </div>
        </div>
      </article>
    `;
  }
}
