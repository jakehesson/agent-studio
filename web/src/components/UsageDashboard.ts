import type { AgentNodeSnapshot, SessionUsageSummary } from "../types.js";
import { inferContextWindow, synthesizeSessionUsage } from "../state/snapshot.js";
import {
  escHtml,
  fmtContextWindow,
  fmtTokens,
  fmtUsd,
  formatActorName,
  getContextZone,
  getStatusStyle,
  trunc,
} from "../utils.js";

const MODEL_COLORS = [
  "#a855f7",
  "#06b6d4",
  "#10b981",
  "#f59e0b",
  "#38bdf8",
  "#ec4899",
  "#818cf8",
];

function modelSwatchColor(idx: number): string {
  return MODEL_COLORS[idx % MODEL_COLORS.length] ?? "#06b6d4";
}

function formatWindowDisplay(
  ctxWin: number,
  nominalCtxWin?: number
): { label: string; title: string; isEffBelow1M: boolean } {
  if (ctxWin === 1_000_000) {
    return { label: "1M", title: "1,000,000 token context window", isEffBelow1M: false };
  }
  if (nominalCtxWin === 1_000_000 && ctxWin >= 850_000) {
    const effK = `${Math.round(ctxWin / 1_000)}k`;
    return {
      label: "1M",
      title: `${effK} eff. · 1M nominal`,
      isEffBelow1M: true,
    };
  }
  if (nominalCtxWin && nominalCtxWin > ctxWin) {
    return {
      label: fmtContextWindow(ctxWin),
      title: `${fmtContextWindow(ctxWin)} eff. · ${fmtContextWindow(nominalCtxWin)} nominal`,
      isEffBelow1M: false,
    };
  }
  return {
    label: fmtContextWindow(ctxWin),
    title: ctxWin > 0 ? `${ctxWin.toLocaleString()} token context window` : "Unknown context window",
    isEffBelow1M: false,
  };
}

function usageSourceBadge(src: "exact" | "estimated" | "mixed"): {
  label: string;
  cls: string;
} {
  if (src === "exact") return { label: "Exact", cls: "ok" };
  if (src === "mixed") return { label: "Mixed", cls: "dispatch" };
  return { label: "~Est.", cls: "tool" };
}

export interface UsageDashboardRenderOptions {
  agents: AgentNodeSnapshot[];
  sessionUsage?: SessionUsageSummary;
  labelMap?: Map<string, string>;
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string) => void;
}

export class UsageDashboard {
  private container: HTMLElement;
  private showTokenHelp = false;
  private lastOpts: UsageDashboardRenderOptions | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;

      const helpBtn = target.closest<HTMLButtonElement>("[data-usage-toggle-help]");
      if (helpBtn) {
        this.showTokenHelp = !this.showTokenHelp;
        if (this.lastOpts) {
          this.render(this.lastOpts);
          this.container
            .querySelector<HTMLButtonElement>("[data-usage-toggle-help]")
            ?.focus({ preventScroll: true });
        }
        return;
      }

      const agentBtn = target.closest<HTMLButtonElement>("[data-usage-agent-id]");
      if (agentBtn) {
        const aid = agentBtn.dataset.usageAgentId;
        if (aid) this.lastOpts?.onSelectAgent?.(aid);
      }
    });
  }

  public render(opts: UsageDashboardRenderOptions): void {
    this.lastOpts = opts;
    const prevScrollTop = this.container.scrollTop;
    const activeEl = document.activeElement as HTMLElement | null;
    const restoreHelpFocus =
      !!activeEl &&
      this.container.contains(activeEl) &&
      activeEl.matches("[data-usage-toggle-help]");

    const aiAgents = opts.agents.filter((a) => (a.nodeType ?? "agent") === "agent");
    if (aiAgents.length === 0) {
      this.container.innerHTML = `<div class="empty-state">No agent token usage recorded for this session yet.</div>`;
      return;
    }

    const summary = opts.sessionUsage ?? synthesizeSessionUsage(aiAgents);
    const freshTokens = summary.inputTokens + summary.outputTokens;
    const cachePct =
      summary.totalTokens > 0
        ? Math.round((summary.cachedTokens / summary.totalTokens) * 100)
        : 0;
    const srcBadge = usageSourceBadge(summary.usageSource);
    const peakZone = getContextZone(summary.peakContextPercent);
    const peakAgent =
      (summary.peakContextAgentId
        ? aiAgents.find((a) => a.id === summary.peakContextAgentId)
        : undefined) ??
      [...aiAgents].sort(
        (a, b) =>
          (b.usage?.contextPercent ?? 0) - (a.usage?.contextPercent ?? 0) ||
          (b.usage?.contextTokens ?? 0) - (a.usage?.contextTokens ?? 0)
      )[0];
    const peakCtxTok = peakAgent?.usage?.contextTokens ?? 0;
    const peakModelName = peakAgent?.usage?.model || peakAgent?.model;
    const peakCtxWin =
      peakAgent?.usage?.contextWindow ??
      (peakAgent ? inferContextWindow(peakModelName, peakAgent.ide) : 0);
    const peakNomWin =
      peakAgent?.usage?.nominalContextWindow ??
      (peakAgent && peakModelName
        ? (() => {
            const inf = inferContextWindow(peakModelName, peakAgent.ide);
            return inf > peakCtxWin ? inf : undefined;
          })()
        : undefined);
    const peakWinDisp = formatWindowDisplay(peakCtxWin, peakNomWin);
    const peakAgentLabel = summary.peakContextAgentId
      ? formatActorName(summary.peakContextAgentId, opts.labelMap)
      : "—";

    const totalTools = aiAgents.reduce((s, a) => s + (a.toolCalls || 0), 0);
    const costStr = fmtUsd(summary.costUsd);
    const avgTokPerTool =
      totalTools > 0 ? `${fmtTokens(summary.totalTokens / totalTools)} / tool` : "0 tools";

    const sortedAgents = [...aiAgents].sort((a, b) => {
      const diff = (b.usage?.totalTokens ?? 0) - (a.usage?.totalTokens ?? 0);
      if (diff !== 0) return diff;
      const aFresh = (a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0);
      const bFresh = (b.usage?.inputTokens ?? 0) + (b.usage?.outputTokens ?? 0);
      return bFresh - aFresh;
    });
    const maxAgentTokens = Math.max(
      1,
      ...sortedAgents.map((a) => a.usage?.totalTokens ?? 0)
    );

    const smartZoneCount = sortedAgents.filter(
      (a) => (a.usage?.contextPercent ?? 0) <= 40
    ).length;

    const peakPctClamped = Math.max(0, Math.min(100, summary.peakContextPercent));

    const modelBarHtml =
      summary.models.length > 0
        ? `
          <section class="usage-section-card" aria-label="Model token distribution">
            <div class="usage-section-head">
              <span class="usage-section-title">Model Distribution</span>
              <span class="muted">${summary.models.length} ${summary.models.length === 1 ? "model" : "models"}</span>
            </div>
            <div class="model-dist-bar" role="img" aria-label="Token share by model">
              ${summary.models
                .map((m, i) => {
                  const pct = Math.max(2, Math.min(100, m.sharePercent));
                  return `<span class="model-dist-seg" style="width:${pct.toFixed(1)}%;background:${modelSwatchColor(i)}" title="${escHtml(m.model)}: ${fmtTokens(m.totalTokens)} (${m.sharePercent.toFixed(1)}%)"></span>`;
                })
                .join("")}
            </div>
            <div class="model-legend">
              ${summary.models
                .map(
                  (m, i) => `
                    <span class="model-legend-item">
                      <i class="sw" style="background:${modelSwatchColor(i)}" aria-hidden="true"></i>
                      <strong>${escHtml(trunc(m.model, 28))}</strong>
                      <span class="muted">· ${m.agentCount}a · ${fmtTokens(m.totalTokens)} (${m.sharePercent.toFixed(0)}%)</span>
                    </span>
                  `
                )
                .join("")}
            </div>
          </section>
        `
        : "";

    const agentMarkersHtml = sortedAgents
      .map((a) => {
        const pct = Math.max(0, Math.min(100, a.usage?.contextPercent ?? 0));
        const zone = getContextZone(pct);
        const name = formatActorName(a.id, opts.labelMap, a.label);
        const isPeak = a.id === summary.peakContextAgentId;
        return `<span
          class="sz-marker sz-${zone.cssClass} ${isPeak ? "is-peak" : ""}"
          style="left:${pct.toFixed(1)}%"
          title="${escHtml(`${name}: ${pct.toFixed(1)}% (${zone.label})`)}"
        ></span>`;
      })
      .join("");

    const agentCardsHtml = sortedAgents
      .map((a) => {
        const u = a.usage;
        const name = formatActorName(a.id, opts.labelMap, a.label);
        const st = getStatusStyle(a.status);
        const modelName = u?.model || a.model || "Unknown";
        const total = u?.totalTokens ?? 0;
        const input = u?.inputTokens ?? 0;
        const output = u?.outputTokens ?? 0;
        const cached = u?.cachedTokens ?? 0;
        const fresh = input + output;
        const agentCachePct = total > 0 ? Math.round((cached / total) * 100) : 0;
        const ctxTok = u?.contextTokens ?? fresh;
        const inferredWin = inferContextWindow(modelName, a.ide);
        const ctxWin = u?.contextWindow ?? inferredWin;
        const nomWin =
          u?.nominalContextWindow ?? (inferredWin > ctxWin ? inferredWin : undefined);
        const winDisp = formatWindowDisplay(ctxWin, nomWin);
        const ctxPct = Math.max(
          0,
          Math.min(
            100,
            u?.contextPercent ?? (ctxWin > 0 ? (ctxTok / ctxWin) * 100 : 0)
          )
        );
        const zone = getContextZone(ctxPct);

        const relScale = maxAgentTokens > 0 ? (total / maxAgentTokens) * 100 : 0;
        const tokDenom = Math.max(1, input + output + cached);
        const inW = (input / tokDenom) * relScale;
        const outW = (output / tokDenom) * relScale;
        const cacheW = (cached / tokDenom) * relScale;
        const isSelected = opts.selectedAgentId === a.id;
        const barAriaLabel = `${name} tokens: ${fmtTokens(fresh)} fresh (${fmtTokens(input)} in, ${fmtTokens(output)} out), ${fmtTokens(cached)} cached (${agentCachePct}%), ${fmtTokens(total)} total`;

        return `
          <button
            type="button"
            class="usage-agent-card ${isSelected ? "selected" : ""}"
            data-usage-agent-id="${escHtml(a.id)}"
            aria-pressed="${isSelected ? "true" : "false"}"
          >
            <div class="usage-agent-top">
              <div class="usage-agent-ident">
                <strong class="usage-agent-name">${escHtml(name)}</strong>
                <span class="s-status ${st.cssClass}">${st.label}</span>
              </div>
              <div class="usage-agent-metrics">
                <strong class="usage-agent-total">${fmtTokens(fresh)} fresh</strong>
                ${cached > 0 ? `<span class="usage-cache-pill">${agentCachePct}% cached</span>` : ""}
                <span class="usage-agent-cum muted">${fmtTokens(total)} tot</span>
              </div>
            </div>

            <div class="usage-model-row">
              <span class="usage-model-pill" title="Model (${escHtml(u?.modelSource ?? "unknown")})">${escHtml(trunc(modelName, 34))}</span>
              ${
                u?.usageSource === "estimated"
                  ? `<span class="pill tool">~Est.</span>`
                  : `<span class="pill ok">Exact</span>`
              }
              ${
                u?.costUsd
                  ? `<span class="usage-cost-chip">${escHtml(fmtUsd(u.costUsd))}</span>`
                  : ""
              }
            </div>

            <div class="usage-bar-group">
              <div class="tok-stack-track" role="img" aria-label="${escHtml(barAriaLabel)}">
                ${inW > 0 ? `<span class="tok-seg tok-in" style="width:${inW.toFixed(1)}%"></span>` : ""}
                ${outW > 0 ? `<span class="tok-seg tok-out" style="width:${outW.toFixed(1)}%"></span>` : ""}
                ${cacheW > 0 ? `<span class="tok-seg tok-cache" style="width:${cacheW.toFixed(1)}%"></span>` : ""}
              </div>
              <div class="tok-chip-legend">
                <span><i class="sw sw-in" aria-hidden="true"></i>In ${fmtTokens(input)}</span>
                <span><i class="sw sw-out" aria-hidden="true"></i>Out ${fmtTokens(output)}</span>
                <span><i class="sw sw-cache" aria-hidden="true"></i>Cache ${fmtTokens(cached)} (${agentCachePct}%)</span>
              </div>
            </div>

            <div class="ctx-meter-group">
              <div class="ctx-meter-head">
                <span class="muted" title="${escHtml(winDisp.title)}">Context ${fmtTokens(ctxTok)} / ${escHtml(winDisp.label)}${winDisp.isEffBelow1M ? ` <span class="ctx-eff-hint">(${Math.round(ctxWin / 1_000)}k eff.)</span>` : ""} · <b>${ctxPct.toFixed(1)}%</b></span>
                <span class="zone-pill zone-${zone.cssClass}">${escHtml(zone.label)}</span>
              </div>
              <div
                class="ctx-meter-track"
                role="progressbar"
                aria-label="${escHtml(name)} context window fill"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow="${Math.round(ctxPct)}"
                aria-valuetext="${escHtml(`${ctxPct.toFixed(1)}% (${zone.label}; handoff advisory at 55%, compact at 70%)`)}"
              >
                <span class="ctx-smart-tint" aria-hidden="true"></span>
                <span class="ctx-meter-fill ctx-${zone.cssClass}" style="width:${ctxPct.toFixed(1)}%"></span>
                <span class="ctx-bound-tick tick-40" title="Smart Zone limit (40%)" aria-hidden="true"></span>
                <span class="ctx-bound-tick tick-55" title="Handoff advisory (55%)" aria-hidden="true"></span>
                <span class="ctx-bound-tick tick-70" title="Compact threshold (70%)" aria-hidden="true"></span>
              </div>
            </div>
          </button>
        `;
      })
      .join("");

    const tokenExplainHtml = this.showTokenHelp
      ? `<div id="usage-token-explain" class="usage-explain-note" role="note">Fresh tokens (In + Out) are newly processed. Cached tokens are prompt-cache re-reads summed across every turn—so cumulative totals can exceed your Peak Context window.</div>`
      : "";

    this.container.innerHTML = `
      <div class="usage-dashboard">
        <section class="usage-kpi-strip" aria-label="Session token and context KPIs">
          <div class="usage-kpi">
            <div class="usage-kpi-top">
              <span>Fresh Tokens</span>
              <span class="usage-kpi-actions">
                <span class="pill ${srcBadge.cls}">${srcBadge.label}</span>
                <button
                  type="button"
                  class="usage-info-btn"
                  data-usage-toggle-help
                  aria-expanded="${this.showTokenHelp ? "true" : "false"}"
                  aria-controls="usage-token-explain"
                  aria-label="Explain fresh vs. cached tokens"
                >?</button>
              </span>
            </div>
            <div class="usage-kpi-val">
              <b>${fmtTokens(freshTokens)}</b>
              <span class="usage-kpi-tot muted">/ ${fmtTokens(summary.totalTokens)} tot</span>
            </div>
            <small class="muted usage-kpi-meta">In ${fmtTokens(summary.inputTokens)} · Out ${fmtTokens(summary.outputTokens)} · Cache ${fmtTokens(summary.cachedTokens)} (${cachePct}%)</small>
          </div>

          <div class="usage-kpi">
            <div class="usage-kpi-top">
              <span>Peak Context</span>
              <span class="zone-pill zone-${peakZone.cssClass}">${escHtml(peakZone.label)}</span>
            </div>
            <div class="usage-kpi-val">
              <b class="kpi-${peakZone.cssClass}">${summary.peakContextPercent.toFixed(1)}%</b>
              ${peakCtxWin > 0 ? `<span class="usage-kpi-tot muted" title="${escHtml(peakWinDisp.title)}">${fmtTokens(peakCtxTok)} / ${escHtml(peakWinDisp.label)}</span>` : ""}
            </div>
            <small class="muted" title="${escHtml(peakWinDisp.isEffBelow1M ? peakWinDisp.title : peakAgentLabel)}">Peak: ${escHtml(trunc(peakAgentLabel, 22))}${peakWinDisp.isEffBelow1M ? ` · ${Math.round(peakCtxWin / 1_000)}k eff.` : ""}</small>
          </div>

          <div class="usage-kpi">
            <div class="usage-kpi-top">
              <span>Models Active</span>
            </div>
            <b>${summary.models.length}</b>
            <small class="muted">${escHtml(
              summary.models
                .slice(0, 2)
                .map((m) => trunc(m.model, 16))
                .join(" · ") || "Unknown"
            )}</small>
          </div>

          <div class="usage-kpi">
            <div class="usage-kpi-top">
              <span>Agents &amp; Flow</span>
            </div>
            <b>${aiAgents.length}a · ${totalTools}t</b>
            <small class="muted">${escHtml(costStr ? `${costStr} est.` : avgTokPerTool)}</small>
          </div>
        </section>

        ${tokenExplainHtml}

        <section class="usage-section-card smart-zone-card" aria-label="Context Smart Zone window">
          <div class="usage-section-head">
            <div class="sz-title-row">
              <span class="usage-section-title">Context Smart Zone Window</span>
              <span class="zone-pill zone-${peakZone.cssClass}">${peakZone.label} · ${summary.peakContextPercent.toFixed(1)}%</span>
            </div>
            <span class="muted">${smartZoneCount}/${sortedAgents.length} in Smart Zone</span>
          </div>

          <div class="smart-zone-track" role="img" aria-label="Context Smart Zone bar: peak ${summary.peakContextPercent.toFixed(1)}%; thresholds at 40% Smart Zone, 55% Handoff, 70% Compact">
            <span class="sz-band sz-band-smart" aria-hidden="true"></span>
            <span class="sz-band sz-band-drift" aria-hidden="true"></span>
            <span class="sz-band sz-band-compact" aria-hidden="true"></span>
            <span class="sz-peak-fill ctx-${peakZone.cssClass}" style="width:${peakPctClamped.toFixed(1)}%" aria-hidden="true"></span>
            <span class="sz-thresh tick-40" aria-hidden="true"><em>40%</em></span>
            <span class="sz-thresh tick-55" aria-hidden="true"><em>55%</em></span>
            <span class="sz-thresh tick-70" aria-hidden="true"><em>70%</em></span>
            ${agentMarkersHtml}
          </div>

          <div class="sz-legend">
            <span><i class="sw" style="background:#10b981" aria-hidden="true"></i>Smart Zone ≤40%</span>
            <span><i class="sw" style="background:#f59e0b" aria-hidden="true"></i>Drift 40–70%</span>
            <span><i class="sw sw-handoff" aria-hidden="true"></i>Handoff 55%</span>
            <span><i class="sw" style="background:#ef4444" aria-hidden="true"></i>Compact &gt;70%</span>
          </div>
        </section>

        ${modelBarHtml}

        <section class="usage-agents-section" aria-label="Per-agent token and context breakdown">
          <div class="usage-section-head">
            <span class="usage-section-title">Per-Agent Usage (${sortedAgents.length})</span>
            <span class="muted">Sorted by total tokens</span>
          </div>
          <div class="usage-agents-list">
            ${agentCardsHtml}
          </div>
        </section>
      </div>
    `;

    if (prevScrollTop > 0) {
      this.container.scrollTop = prevScrollTop;
    }

    if (restoreHelpFocus) {
      this.container
        .querySelector<HTMLButtonElement>("[data-usage-toggle-help]")
        ?.focus({ preventScroll: true });
    }
  }
}
