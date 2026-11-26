import type { IdeSource } from "../types.js";
import { escHtml, getIdeMeta } from "../utils.js";

export type GuideIdeId = "antigravity" | "claude-code" | "copilot-vscode";

interface GuideCommandBlock {
  label: string;
  code: string;
}

interface GuidePromptCard {
  badge: string;
  title: string;
  prompt: string;
}

interface GuideFileRow {
  concern: string;
  path: string;
  note: string;
}

interface GuideStep {
  num: string;
  title: string;
  detail: string;
}

interface IdeGuideSpec {
  id: GuideIdeId;
  name: string;
  tagline: string;
  setupCommands: GuideCommandBlock[];
  activationSteps: string[];
  prompts: GuidePromptCard[];
  files: GuideFileRow[];
  sprintSteps: GuideStep[];
  guardrailNote: string;
  overrideFlag: string;
  overrideEnv: string;
  overrideCmd: string;
  troubleshootingNote: string;
}

const GUIDE_SPECS: Record<GuideIdeId, IdeGuideSpec> = {
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    tagline:
      "Workspace plugin agents, native invoke_subagent / send_message topology, and zero-config passive brain JSONL discovery.",
    setupCommands: [
      {
        label: "Per-project setup & compile",
        code: `agent-studio init --ides antigravity\nagent-studio sync --ides antigravity && agent-studio doctor`,
      },
      {
        label: "One-time global setup (installs team-setup everywhere)",
        code: `agent-studio init --global`,
      },
      {
        label: "Launch unified Web Studio",
        code: `agent-studio serve --open`,
      },
    ],
    activationSteps: [
      "Run sync so .agents/plugins/<projectId>-team/ is generated inside the repository.",
      "Reload the workspace in Antigravity so the workspace plugin and mcp_config.json are discovered.",
      "Pick orchestrator (for sprints) or team-setup (to tailor roles/checkpoints) from the Antigravity agent selector.",
    ],
    prompts: [
      {
        badge: "team-setup",
        title: "Onboard or tailor this repository",
        prompt:
          "Use team-setup to inspect this repository, customize .agent-team/team.yaml with our stack's specialist roles and QA checkpoints, then run agent-studio sync and doctor.",
      },
      {
        badge: "orchestrator",
        title: "Start a QA-gated sprint loop",
        prompt:
          "Use orchestrator to check board status and next ready items, dispatch the right specialist subagents in parallel where safe, and require qa-validator to record a passing testrun before moving any item to done.",
      },
    ],
    files: [
      {
        concern: "Plugin Manifest",
        path: ".agents/plugins/<id>-team/plugin.json",
        note: "Registers workspace team & suggested prompts",
      },
      {
        concern: "Role Agents",
        path: ".agents/plugins/<id>-team/agents/<role>.md",
        note: "Tool allowlists (orchestrator has no edit/write/shell)",
      },
      {
        concern: "Skills",
        path: ".agents/plugins/<id>-team/skills/<skill>/SKILL.md",
        note: "Board workflow, architecture spec, QA validation",
      },
      {
        concern: "Rules",
        path: ".agents/plugins/<id>-team/rules/AGENTS.md",
        note: "Guardrails, roster table, verification checkpoints",
      },
      {
        concern: "MCP Wiring",
        path: ".agents/plugins/<id>-team/mcp_config.json",
        note: "Stdio MCP server (npx -y agent-studio mcp; auto-detects project from cwd)",
      },
      {
        concern: "Global Setup",
        path: "~/.gemini/config/plugins/agent-studio/",
        note: "Installed once by --global for any repo",
      },
    ],
    sprintSteps: [
      {
        num: "1",
        title: "Board Triage (status / next)",
        detail:
          "Orchestrator calls MCP board(op: 'status') & board(op: 'next') without touching source files.",
      },
      {
        num: "2",
        title: "Dynamic Subagent Dispatch",
        detail:
          "invoke_subagent spawns specialists; Live Studio renders every node, edge, and THINKING/WORKING state automatically.",
      },
      {
        num: "3",
        title: "QA Verification (CP0 / CP1 / CP2)",
        detail:
          "qa-validator executes checkpoints and records results via MCP testrun(op: 'start' | 'record' | 'close').",
      },
      {
        num: "4",
        title: "Server-Enforced QA Gate (test → done)",
        detail:
          "agent-studio mcp rejects moving items to done until a closed, passing testrun covers the suite.",
      },
    ],
    guardrailNote:
      "Orchestrator frontmatter omits write_file, edit_file, and run_command. All MCP board/testrun calls also append NormalizedEvent records to .agent-studio/telemetry.jsonl alongside passive brain JSONL discovery.",
    overrideFlag: "--brain-dir <path>",
    overrideEnv: "ANTIGRAVITY_BRAIN_DIR",
    overrideCmd:
      'ANTIGRAVITY_BRAIN_DIR="~/.gemini/antigravity/brain" agent-studio serve --brain-dir "~/.gemini/antigravity/brain"',
    troubleshootingNote:
      "Watches ~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl. If your brain directory lives on a custom drive or profile, pass --brain-dir or set ANTIGRAVITY_BRAIN_DIR. MCP board/testrun events always stream via .agent-studio/telemetry.jsonl even if brain transcripts are delayed.",
  },

  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    tagline:
      "Native .claude/agents subagents, non-destructive .mcp.json + CLAUDE.md managed blocks, and sub-second PreToolUse/PostToolUse hooks.",
    setupCommands: [
      {
        label: "Per-project setup & compile",
        code: `agent-studio init --ides claude-code\nagent-studio sync --ides claude-code && agent-studio doctor`,
      },
      {
        label: "One-time global setup (installs ~/.claude/agents/team-setup.md)",
        code: `agent-studio init --global`,
      },
      {
        label: "Verify zero config drift & launch Studio",
        code: `agent-studio sync --check && agent-studio serve --open`,
      },
    ],
    activationSteps: [
      "Launch Claude Code inside the repository root and approve the project .mcp.json agent-studio server when prompted.",
      "Verify .claude/settings.json hooks are active (non-destructively merged alongside your existing permissions).",
      "Launch with `claude --agent team-setup` (or ask Claude to use the team-setup agent) to customize roles, or run `claude --agent orchestrator` / ask Claude to dispatch orchestrator via the Agent tool.",
    ],
    prompts: [
      {
        badge: "--agent team-setup",
        title: "Onboard or customize repository",
        prompt:
          "Use the team-setup agent (or launch with `claude --agent team-setup`): inspect this repository, configure .agent-team/team.yaml with tailored specialist agents and test checkpoints, then run agent-studio sync and agent-studio doctor.",
      },
      {
        badge: "--agent orchestrator",
        title: "Run sprint via subagents + QA gate",
        prompt:
          "Use the orchestrator agent (or launch with `claude --agent orchestrator`): check the agent-studio board status, dispatch specialists for the next ready item using the Agent tool, and enforce qa-validator testrun verification before transitioning to done.",
      },
    ],
    files: [
      {
        concern: "Subagents",
        path: ".claude/agents/<role>.md",
        note: "Explicit tools: allowlist (orchestrator omits Edit/Write/Bash)",
      },
      {
        concern: "Skills",
        path: ".claude/skills/<skill>/SKILL.md",
        note: "Workflow skills auto-loaded by Claude Code",
      },
      {
        concern: "Instructions",
        path: "CLAUDE.md",
        note: "Fenced <!-- agent-studio:begin/end --> block preserves user notes",
      },
      {
        concern: "MCP Wiring",
        path: ".mcp.json",
        note: "Key-scoped merge into mcpServers['agent-studio']",
      },
      {
        concern: "Live Hooks",
        path: ".claude/settings.json",
        note: "PreToolUse, PostToolUse, SubagentStart/Stop, Stop -> hook-emit",
      },
      {
        concern: "Global Setup",
        path: "~/.claude/agents/team-setup.md",
        note: "Installed once by --global for any project",
      },
    ],
    sprintSteps: [
      {
        num: "1",
        title: "Board Check (MCP)",
        detail:
          "The orchestrator agent (launched via `claude --agent orchestrator` or dispatched via the Agent tool) calls mcp__agent-studio__board(status/next) and plans sprint work without edit/shell tools.",
      },
      {
        num: "2",
        title: "Specialist Delegation (Agent Tool)",
        detail:
          "SubagentStart/SubagentStop hooks stream spawns live while ClaudeCodeAdapter enriches from subagents/agent-*.jsonl.",
      },
      {
        num: "3",
        title: "QA Checkpoints & Testrun",
        detail:
          "qa-validator runs CP0/CP1/CP2 and records results with mcp__agent-studio__testrun.",
      },
      {
        num: "4",
        title: "Defense-in-Depth Gate",
        detail:
          "PreToolUse blocks direct Edit/Write/Bash mutations to pipeline/board.json (exit 2); MCP enforces passing testruns for done.",
      },
    ],
    guardrailNote:
      "PreToolUse hooks inspect every tool input: raw edits to pipeline/board.json return permissionDecision: 'deny' (exit 2). Live telemetry posts to /api/ingest with a 150ms timeout and falls back silently to .agent-studio/telemetry.jsonl (exit 0) if the server is stopped.",
    overrideFlag: "--claude-dir <path>",
    overrideEnv: "CLAUDE_PROJECTS_DIR",
    overrideCmd:
      'CLAUDE_PROJECTS_DIR="~/.claude/projects" agent-studio serve --claude-dir "~/.claude/projects"',
    troubleshootingNote:
      "Passive adapter scans ~/.claude/projects/<encoded-cwd>/<session>.jsonl and subagents/agent-*.jsonl, deduplicating live hook pings with richer transcript payloads via tool_use_id. Override with --claude-dir or CLAUDE_PROJECTS_DIR if Claude uses a custom config home.",
  },

  "copilot-vscode": {
    id: "copilot-vscode",
    name: "GitHub Copilot / VS Code",
    tagline:
      "Unified .github/agents/*.agent.md (user-invocable & agent tool), shared .mcp.json wiring, camelCase hooks, and $COPILOT_HOME session-state + chatSessions replay.",
    setupCommands: [
      {
        label: "Per-project setup & compile",
        code: `agent-studio init --ides copilot-vscode\nagent-studio sync --ides copilot-vscode && agent-studio doctor`,
      },
      {
        label: "Upgrade existing workspaces safely (preserves custom Markdown)",
        code: `agent-studio upgrade --dry-run\nagent-studio upgrade --global`,
      },
      {
        label: "One-time global setup (installs ~/.copilot/ / $COPILOT_HOME)",
        code: `agent-studio init --global`,
      },
      {
        label: "Launch unified Web Studio",
        code: `agent-studio serve --open`,
      },
    ],
    activationSteps: [
      "Open the repository in VS Code or Copilot CLI and trust/approve the agent-studio MCP server inside .mcp.json.",
      "Open GitHub Copilot Chat (or Copilot CLI) and choose Team Orchestrator (orchestrator) or Team Setup Agent (team-setup) — specialists use user-invocable: false so they stay scoped to subagent delegation.",
      "Orchestrator delegates to specialists via the native agent tool (or task in Copilot CLI) while .github/hooks/agent-studio.json streams camelCase lifecycle hooks live.",
    ],
    prompts: [
      {
        badge: "Team Setup Agent",
        title: "Onboard or upgrade repository",
        prompt:
          "Inspect this workspace, tailor .agent-team/team.yaml with our specialist roster and QA checkpoints, then run agent-studio upgrade (or sync) and agent-studio doctor.",
      },
      {
        badge: "Team Orchestrator",
        title: "Run sprint with native agent delegation",
        prompt:
          "Check agent-studio board status and next ready items, plan the active sprint, and delegate to Architect, Engineers, and QA Validator via the agent tool while enforcing the test → done QA gate.",
      },
    ],
    files: [
      {
        concern: "Custom Agents",
        path: ".github/agents/<role>.agent.md",
        note: "Portable tools (read/search/edit/execute/agent), user-invocable, model-policy; orchestrator omits edit/execute",
      },
      {
        concern: "Skills",
        path: ".github/skills/<skill>/SKILL.md",
        note: "Portable domain, QA, and /learn skills (replaces learn.prompt.md)",
      },
      {
        concern: "Instructions",
        path: ".github/copilot-instructions.md",
        note: "Managed block preserves existing repo Copilot instructions",
      },
      {
        concern: "MCP Wiring",
        path: ".mcp.json",
        note: "Key-scoped merge into mcpServers['agent-studio'] (type: stdio, tools: ['*']); shared with Claude Code",
      },
      {
        concern: "Live Hooks",
        path: ".github/hooks/agent-studio.json",
        note: "10 camelCase events (sessionStart, preToolUse, postToolUse, subagentStart/Stop, agentStop, sessionEnd) -> hook-emit",
      },
      {
        concern: "Global Setup",
        path: "~/.copilot/ ($COPILOT_HOME)",
        note: "Installs agents/team-setup.agent.md, instructions/, and skills/{team-setup,learn}/ via --global",
      },
    ],
    sprintSteps: [
      {
        num: "1",
        title: "Select Team Orchestrator",
        detail:
          "Orchestrator reads the board via agent-studio/* MCP tools and selects the highest-priority ready item.",
      },
      {
        num: "2",
        title: "Native Subagent Delegation (agent)",
        detail:
          "Dispatch Architect / Engineers via the native agent tool (or task); subagentStart/subagentStop hooks correlate runs live.",
      },
      {
        num: "3",
        title: "Run QA Suite & Record Testrun",
        detail:
          "Delegate to QA Validator to execute CP0/CP1/CP2 and log results via agent-studio/testrun.",
      },
      {
        num: "4",
        title: "Hook + MCP Guardrails",
        detail:
          "preToolUse blocks raw pipeline/board.json writes ({ permissionDecision: 'deny' }, exit 0); MCP rejects test → done without a passing testrun.",
      },
    ],
    guardrailNote:
      "Compiled orchestrator.agent.md strips edit and execute tools, while .github/hooks/agent-studio.json enforces camelCase preToolUse board protection and pushes live events with a 150ms fail-safe fallback to .agent-studio/telemetry.jsonl.",
    overrideFlag: "--vscode-dir <path>",
    overrideEnv: "COPILOT_HOME / VSCODE_STORAGE_DIR",
    overrideCmd:
      'COPILOT_HOME="~/.copilot" VSCODE_STORAGE_DIR="%APPDATA%/Code/User/workspaceStorage" agent-studio serve --vscode-dir "%APPDATA%/Code/User/workspaceStorage"',
    troubleshootingNote:
      "Discovers workspace-scoped $COPILOT_HOME/session-state/*/events.jsonl alongside VS Code workspaceStorage chatSessions (.json and delta .jsonl, including Code - Insiders) and deduplicates by sessionId. Run agent-studio upgrade to migrate legacy .vscode/mcp.json, PascalCase hooks, or (copilot) model IDs.",
  },
};

const GUIDE_ORDER: GuideIdeId[] = ["antigravity", "claude-code", "copilot-vscode"];

async function copyTextWithFallback(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy textarea copy
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

export class IdeUsageGuides {
  private container: HTMLElement;
  private activeIde: GuideIdeId = "antigravity";
  private lockedIde: GuideIdeId | null = null;
  private copyPayloadById = new Map<string, string>();

  constructor(
    container: HTMLElement,
    initialIde: GuideIdeId = "antigravity",
    lockedIde: GuideIdeId | null = null
  ) {
    this.container = container;
    this.lockedIde = lockedIde;
    this.activeIde = lockedIde ?? initialIde;
    this.render();
  }

  public selectIde(ide: IdeSource | GuideIdeId, scrollIntoView = false): void {
    const normalized: GuideIdeId = this.lockedIde
      ? this.lockedIde
      : ide === "claude-code" || ide === "copilot-vscode" || ide === "antigravity"
        ? ide
        : "antigravity";
    this.activeIde = normalized;
    this.render();
    const activeTab = this.container.querySelector<HTMLButtonElement>(
      `[data-guide-tab="${normalized}"]`
    );
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (scrollIntoView) {
      this.container.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  public getActiveIde(): GuideIdeId {
    return this.activeIde;
  }

  private render(): void {
    this.copyPayloadById.clear();
    const spec = GUIDE_SPECS[this.activeIde];
    const ideMeta = getIdeMeta(spec.id);

    const registerCopy = (id: string, text: string): string => {
      this.copyPayloadById.set(id, text);
      return id;
    };

    const overrideCopyId = registerCopy(`override-${spec.id}`, spec.overrideCmd);

    this.container.innerHTML = `
      <section class="card guides-shell" id="ide-usage-guides" aria-labelledby="ideGuidesHeading">
        <div class="guides-head">
          <div class="guides-title-wrap">
            <h3 id="ideGuidesHeading">${
              this.lockedIde
                ? `${escHtml(spec.name)} Setup &amp; Usage Guide`
                : "Setup &amp; Usage Guides by IDE"
            }</h3>
            <p class="muted">
              Author your team once in <code>.agent-team/</code>, compile natively with <code>agent-studio sync</code>, and follow the playbook ${
                this.lockedIde ? `for ${escHtml(spec.name)}` : "for your IDE"
              } below.
            </p>
          </div>
          ${
            this.lockedIde
              ? ""
              : `<div class="guide-tabs" role="tablist" aria-label="IDE usage guides">
                  ${GUIDE_ORDER.map((id) => {
                    const g = GUIDE_SPECS[id];
                    const m = getIdeMeta(id);
                    const selected = id === this.activeIde;
                    return `
                      <button
                        type="button"
                        role="tab"
                        id="guide-tab-${id}"
                        class="guide-tab"
                        data-guide-tab="${id}"
                        aria-selected="${selected ? "true" : "false"}"
                        tabindex="${selected ? "0" : "-1"}"
                      >
                        <span class="guide-tab-dot" style="background:${m.color}" aria-hidden="true"></span>
                        <span>${escHtml(g.name)}</span>
                      </button>
                    `;
                  }).join("")}
                </div>`
          }
        </div>

        <div
          class="guide-panel"
          ${this.lockedIde ? 'aria-labelledby="ideGuidesHeading"' : `role="tabpanel" aria-labelledby="guide-tab-${spec.id}"`}
          tabindex="0"
        >
          <div class="guide-banner" style="border-left-color:${ideMeta.color}">
            <span class="ide-chip" style="color:${ideMeta.color};border-color:${ideMeta.border};background:${ideMeta.bg}">${escHtml(ideMeta.short)}</span>
            <span class="guide-tagline">${escHtml(spec.tagline)}</span>
          </div>

          <div class="guide-two-col">
            <div class="guide-col">
              <article class="guide-card">
                <div class="guide-card-head">
                  <h4>1. Quick Setup (Global or Per-Project)</h4>
                  <span class="pill ok">Deterministic CLI</span>
                </div>
                <div class="guide-blocks">
                  ${spec.setupCommands
                    .map((cmd, idx) => {
                      const cid = registerCopy(`cmd-${spec.id}-${idx}`, cmd.code);
                      return `
                        <div class="code-block-wrap">
                          <div class="code-block-bar">
                            <span class="code-block-lbl">${escHtml(cmd.label)}</span>
                            <button
                              type="button"
                              class="guide-copy-btn"
                              data-copy-id="${cid}"
                              aria-label="Copy ${escHtml(cmd.label)} command"
                            >Copy</button>
                          </div>
                          <div
                            class="code-scroll"
                            role="region"
                            tabindex="0"
                            aria-label="${escHtml(cmd.label)} shell command"
                          >
                            <pre class="guide-pre"><code>${escHtml(cmd.code)}</code></pre>
                          </div>
                        </div>
                      `;
                    })
                    .join("")}
                </div>
              </article>

              <article class="guide-card">
                <div class="guide-card-head">
                  <h4>2. Invoke Setup Agent &amp; Orchestrator</h4>
                  <span class="pill dispatch">Ready-to-Paste Prompts</span>
                </div>
                <ol class="guide-steps-list">
                  ${spec.activationSteps.map((s) => `<li>${escHtml(s)}</li>`).join("")}
                </ol>
                <div class="guide-prompts">
                  ${spec.prompts
                    .map((p, idx) => {
                      const pid = registerCopy(`prompt-${spec.id}-${idx}`, p.prompt);
                      return `
                        <div class="prompt-card">
                          <div class="prompt-card-head">
                            <div class="prompt-title-group">
                              <span class="pill board">${escHtml(p.badge)}</span>
                              <strong>${escHtml(p.title)}</strong>
                            </div>
                            <button
                              type="button"
                              class="guide-copy-btn"
                              data-copy-id="${pid}"
                              aria-label="Copy ${escHtml(p.badge)} prompt"
                            >Copy</button>
                          </div>
                          <p class="prompt-body">${escHtml(p.prompt)}</p>
                        </div>
                      `;
                    })
                    .join("")}
                </div>
              </article>
            </div>

            <div class="guide-col">
              <article class="guide-card">
                <div class="guide-card-head">
                  <h4>3. Generated Files &amp; Wiring</h4>
                  <span class="pill tool">Edit only .agent-team/</span>
                </div>
                <div
                  class="table-scroll"
                  role="region"
                  tabindex="0"
                  aria-label="${escHtml(spec.name)} generated files table"
                >
                  <table class="guide-table">
                    <thead>
                      <tr>
                        <th>Concern</th>
                        <th>Path</th>
                        <th>Behavior</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${spec.files
                        .map(
                          (f) => `
                            <tr>
                              <td><strong>${escHtml(f.concern)}</strong></td>
                              <td><code>${escHtml(f.path)}</code></td>
                              <td class="muted">${escHtml(f.note)}</td>
                            </tr>
                          `
                        )
                        .join("")}
                    </tbody>
                  </table>
                </div>
              </article>

              <article class="guide-card">
                <div class="guide-card-head">
                  <h4>4. Day-to-Day Sprint Loop &amp; Guardrails</h4>
                  <span class="pill ok">QA-Gated</span>
                </div>
                <div class="sprint-steps">
                  ${spec.sprintSteps
                    .map(
                      (st) => `
                        <div class="sprint-step">
                          <span class="sprint-num" aria-hidden="true">${escHtml(st.num)}</span>
                          <div>
                            <strong>${escHtml(st.title)}</strong>
                            <p>${escHtml(st.detail)}</p>
                          </div>
                        </div>
                      `
                    )
                    .join("")}
                </div>
                <div class="issue-row ok">
                  <span>🛡</span>
                  <span>${escHtml(spec.guardrailNote)}</span>
                </div>
              </article>

              <article class="guide-card">
                <div class="guide-card-head">
                  <h4>5. Troubleshooting &amp; Path Overrides</h4>
                  <span class="pill human">Fallback Ready</span>
                </div>
                <div class="override-meta">
                  <span>CLI Flag: <code>${escHtml(spec.overrideFlag)}</code></span>
                  <span>Env Var: <code>${escHtml(spec.overrideEnv)}</code></span>
                </div>
                <div class="code-block-wrap">
                  <div class="code-block-bar">
                    <span class="code-block-lbl">Custom telemetry directory override</span>
                    <button
                      type="button"
                      class="guide-copy-btn"
                      data-copy-id="${overrideCopyId}"
                      aria-label="Copy telemetry path override command"
                    >Copy</button>
                  </div>
                  <div
                    class="code-scroll"
                    role="region"
                    tabindex="0"
                    aria-label="Telemetry path override command"
                  >
                    <pre class="guide-pre"><code>${escHtml(spec.overrideCmd)}</code></pre>
                  </div>
                </div>
                <p class="guide-note muted">${escHtml(spec.troubleshootingNote)}</p>
              </article>
            </div>
          </div>
        </div>
      </section>
    `;

    this.bindInteractions();
  }

  private bindInteractions(): void {
    const tabs = Array.from(
      this.container.querySelectorAll<HTMLButtonElement>("[data-guide-tab]")
    );

    tabs.forEach((btn, idx) => {
      btn.addEventListener("click", () => {
        const ide = btn.dataset.guideTab as GuideIdeId | undefined;
        if (ide && ide !== this.activeIde) {
          this.selectIde(ide, false);
        }
      });

      btn.addEventListener("keydown", (e) => {
        let nextIdx = -1;
        if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
        else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") nextIdx = 0;
        else if (e.key === "End") nextIdx = tabs.length - 1;

        if (nextIdx >= 0) {
          e.preventDefault();
          const target = tabs[nextIdx];
          const ide = target?.dataset.guideTab as GuideIdeId | undefined;
          if (ide) {
            this.selectIde(ide, false);
            this.container
              .querySelector<HTMLButtonElement>(`[data-guide-tab="${ide}"]`)
              ?.focus();
          }
        }
      });
    });

    this.container
      .querySelectorAll<HTMLButtonElement>("[data-copy-id]")
      .forEach((btn) => {
        btn.addEventListener("click", async () => {
          const cid = btn.dataset.copyId;
          const payload = cid ? this.copyPayloadById.get(cid) : undefined;
          if (!payload) return;
          const ok = await copyTextWithFallback(payload);
          btn.textContent = ok ? "Copied ✓" : "Copy failed";
          btn.classList.toggle("copied", ok);
          window.setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("copied");
          }, 1800);
        });
      });
  }
}
