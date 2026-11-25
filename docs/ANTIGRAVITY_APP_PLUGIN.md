# Agent Studio — Native Antigravity MCP App Plugin

The **Antigravity MCP App Plugin** packages Agent Studio as a first-class, native Antigravity plugin implementing **SEP-1865 (MCP Apps)**—rendering Live Multi-Agent Topology, Video Timeline Scrubber, Agent Team Roster, QA-Gated Agile Board, and Setup/Doctor directly inside Antigravity with **zero external HTTP server required**.

---

## 1. Three Native Surfaces in Antigravity

Because the `open_studio` MCP tool declares both `ui.resourceUri` (`ui://agent-studio/app.html`) and Antigravity entrypoints (`aux_pane` + `global`), you can open Agent Studio from three native places:

1. **Side Pane (`+` menu):** Click **`+` → Agent Studio** in the auxiliary side pane to keep live topology or the Agile board open alongside your conversation.
2. **Full-Page Left Sidebar (`global`):** Click **Agent Studio** in Antigravity's left sidebar for a full-page workspace view.
3. **Inline in Conversation:** Ask any agent to call `open_studio` (optionally passing `{ view: "studio" | "team" | "board" | "doctor", project, session }`)—Antigravity renders or updates the live pane directly.

### Zero External Server & Native Theme Sync
- **Direct MCP Transport:** The single-file HTML UI (`bin/app.html`, served via `resources/read` with MIME type `text/html;profile=mcp-app`) talks directly to the bundled stdio MCP server over `postMessage` JSON-RPC using five app-only tools (`visibility: ["app"]`): `app_get_state`, `app_get_board`, `app_get_team`, `app_get_doctor`, and `app_send_test_event`.
- **Automatic Theme Sync:** Follows Antigravity's `hostContext.theme` (`light` / `dark`) and `styles.variables` (`--color-background-*`, `--color-text-*`, `--color-border-*`, `--font-sans`) live as you switch themes.
- **No Server Name Collisions:** The plugin registers its MCP server as `"agent-studio-app"` (`agent-studio_agent-studio-app`) so it coexists cleanly with any workspace-level `"agent-studio"` MCP server.

---

## 2. Building & Installing the Plugin

```bash
# 1. Build core TypeScript + single-file MCP App UI bundle (dist/mcp-app/app.html)
npm run build
npm --prefix web run build:mcp-app

# 2. Build the Antigravity plugin bundle into antigravity-plugin/dist/
npm run build:plugin

# 3. Install directly into ~/.gemini/config/plugins/agent-studio/
node antigravity-plugin/scripts/build-plugin.mjs --install
```

### Installed Plugin Layout (`~/.gemini/config/plugins/agent-studio/`)
```text
~/.gemini/config/plugins/agent-studio/
├── plugin.json                    # Strict-schema Antigravity manifest (name, displayName, version, logo, suggestedPrompts)
├── mcp_config.json                # Prefixed "agent-studio-app" stdio MCP server using ${PLUGIN_ROOT} & ${PLUGIN_DATA}
├── assets/logo.svg                # High-contrast 128x128 square SVG emblem
├── bin/
│   ├── agent-studio-mcp.mjs       # Self-contained esbuild-bundled MCP + CLI binary
│   └── app.html                   # Single-file SEP-1865 MCP App UI (< 10 MiB)
├── agents/team-setup.md           # Global cross-IDE onboarding agent
├── skills/
│   ├── team-setup/SKILL.md        # Onboarding playbook skill
│   └── token-efficiency/SKILL.md  # Core portable Token & Context Efficiency skill
└── rules/AGENTS.md                # Always-on 10-point Token & Context Discipline rules
```

---

## 3. Refreshing an Already-Running Plugin Server

New plugins in `~/.gemini/config/plugins/` are discovered automatically without restarting Antigravity. When iterating on an already-running `agent-studio-app` server, either restart it from **MCP Servers** settings or refresh it from an Antigravity terminal:

```bash
curl -sf -H "Content-Type: application/json" \
  -H "x-codeium-csrf-token: ${ANTIGRAVITY_CSRF_TOKEN}" \
  -d '{"serverName": "agent-studio_agent-studio-app"}' \
  "http://${ANTIGRAVITY_LS_ADDRESS:-localhost:5387}/exa.language_server_pb.LanguageServerService/RefreshMcpServers"
```

For rapid UI iteration without rebuilding the binary, set `AGENT_STUDIO_APP_HTML=/path/to/dist/mcp-app/app.html` so reopening the view picks up fresh HTML edits immediately.

---

## 4. Choosing Between All Three Surfaces

| Surface | Best For | Transport | Scope |
| :--- | :--- | :--- | :--- |
| **Native Antigravity MCP App Plugin** (`antigravity-plugin/`) | Native Antigravity side pane, sidebar, and inline conversation UI with zero background HTTP server | Stdio MCP + SEP-1865 `postMessage` (`app_get_*`) | Antigravity IDE + active workspace |
| **VS Code / Antigravity Extension** (`extension/agent-studio-0.6.0.vsix`) | VS Code Activity Bar sidebar, Status Bar pill, Command Palette onboarding, and Remote SSH/WSL port-forwarding | Local/External HTTP + SSE (`?embed=1`) | Host IDE (`copilot-vscode` / `antigravity`) + active workspace |
| **Standalone Web Studio** (`npx agent-studio serve --host 0.0.0.0 --port 8767`) | Multi-IDE + multi-project browser dashboard, mobile / Galaxy Z Fold 7 via Tailscale, Mockups gallery | HTTP + SSE (single port `8767`) | All registered projects & all 3 IDEs |
