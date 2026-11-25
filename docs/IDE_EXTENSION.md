# Agent Studio — VS Code & Antigravity IDE Extension (`.vsix`)

The **Agent Studio Extension** (`extension/agent-studio-<version>.vsix`, currently `extension/agent-studio-0.5.0.vsix`) embeds the full Agent Studio live monitor, QA-gated Agile Board, Agent Team inspector, Mockups gallery, and Setup/Doctor tooling directly inside **Visual Studio Code** and **Antigravity IDE**—with zero duplicated business logic and zero runtime external dependencies.

---

## 1. Installing the `.vsix` Extension

### Option A: From the IDE UI (Antigravity or VS Code)
1. Open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Click the **`...`** (*Views and More Actions*) menu in the top-right corner of the Extensions sidebar.
3. Choose **Install from VSIX...**.
4. Select `./extension/agent-studio-<version>.vsix` (e.g. `agent-studio-0.5.0.vsix`, or download a prebuilt `.vsix` from [GitHub Releases](https://github.com/jakehesson/agent-studio/releases)).
5. Reload the window if prompted, then click the **Agent Studio** icon in the Activity Bar.

### Option B: From the Command Line
Download `agent-studio-0.5.0.vsix` from [GitHub Releases](https://github.com/jakehesson/agent-studio/releases) or build it locally into `./extension/`, then install:

```powershell
# VS Code
code --install-extension ./extension/agent-studio-0.5.0.vsix

# Antigravity IDE
agy --install-extension ./extension/agent-studio-0.5.0.vsix
```

---

## 2. Features Inside Your IDE

- **Activity Bar Sidebar (`Studio Overview`):**
  - Displays live server status (`Online (External :8767)`, `Online (Managed :8767)`, or `Offline`), active session counts, open sprint items/bugs, recent sessions across Antigravity / Claude Code / GitHub Copilot, and one-click buttons.
- **Full-Bleed Editor Tab (`Agent Studio: Open Studio`):**
  - Opens the complete Web Studio inside a full editor tab (`Live Studio`, `Agile Board`, `Agent Team`, `Mockups`, `Doctor & Guides`), using `vscode.env.asExternalUri(...)` so Remote SSH, WSL, and VS Code Tunnels port-forward automatically.
- **Status Bar Telemetry Pill:**
  - Right-aligned status pill (`$(pulse) Agent Studio: N active` / `$(radio-tower) Agent Studio :8767`) with sprint & bug summary tooltip; click to jump directly to the Studio tab.
- **Command Palette Tooling (`Ctrl+Shift+P` / `Cmd+Shift+P`):**
  - `Agent Studio: Open Studio`
  - `Agent Studio: Open Agile Board`
  - `Agent Studio: Open Agent Team`
  - `Agent Studio: Open Setup & Doctor`
  - `Agent Studio: Open in Browser`
  - `Agent Studio: Onboard Workspace (Init & Sync)` *(multi-select QuickPick for Antigravity, Claude Code, and GitHub Copilot / VS Code)*
  - `Agent Studio: Sync IDE Adapters`
  - `Agent Studio: Run Doctor Check`
  - `Agent Studio: Restart Server`
- **Auto-Registered MCP Provider:**
  - Automatically feature-detects `vscode.lm.registerMcpServerDefinitionProvider` to register the bundled `agent-studio` stdio MCP server when supported by the host IDE (gracefully skipping on older hosts without crashing).

---

## 3. Automatic Host-IDE & Workspace Scoping

Agent Studio adapts automatically depending on whether you view it **inside the IDE extension** or in a **standalone browser**:

| Mode | Host IDE & Workspace Scope | UI Behavior |
| :--- | :--- | :--- |
| **Embedded IDE Extension** (`embed=1`) | Automatically detects the host IDE (`antigravity` vs `copilot-vscode` via `vscode.env.appName`) and primary open workspace root. | All Studio tabs (`?embed=1&ide=<host>&workspace=<root>&project=<id>`), the Activity Bar Sidebar, and the Status Bar pill display **only** sessions, agents, skills, Doctor checks, and Usage Guides for the current IDE and workspace. Cross-IDE and multi-project switcher chrome is hidden cleanly. |
| **Standalone Browser** (`Agent Studio: Open in Browser` / `agent-studio serve`) | Global multi-IDE & multi-project studio (no `embed=1`). | Preserves the full **Project Switcher**, **IDE Filter (`All | Antigravity | Claude Code | VS Code`)**, all 3 IDE Doctor cards, and all 3 per-IDE Usage Guides. |

When running **`Agent Studio: Onboard Workspace (Init & Sync)`**, your current host IDE is pre-selected by default in the QuickPick (you can still check additional IDEs to compile multi-IDE adapters).

---

## 4. Configuration (`agentStudio.*`)

Configure settings in **Settings UI** or `settings.json`:

```json
{
  "agentStudio.port": 8767,
  "agentStudio.host": "127.0.0.1",
  "agentStudio.autoStart": true,
  "agentStudio.externalUrl": "https://your-host.tailnet.ts.net:8767",
  "agentStudio.mcpAutoRegister": true
}
```

| Setting | Default | Description |
| :--- | :--- | :--- |
| `agentStudio.port` | `8767` | Local TCP port for the Agent Studio HTTP/SSE server. |
| `agentStudio.host` | `"127.0.0.1"` | Bind host when the extension spawns a managed local server (`0.0.0.0` for LAN/Tailscale). |
| `agentStudio.autoStart` | `true` | Automatically start the bundled server if nothing is listening on `port`. |
| `agentStudio.externalUrl` | `""` | Optional Tailscale/LAN URL used by **Open in Browser** and fallback connectivity. |
| `agentStudio.mcpAutoRegister` | `true` | Register the bundled stdio MCP server via VS Code's MCP provider API when supported. |

---

## 5. Coexisting with an External / Tailscale Daemon (`:8767`)

The extension is **daemon-friendly by design**:
1. On startup (and before opening any tab), `ServerManager` probes `http://127.0.0.1:<port>/api/doctor` first (1.2s timeout).
2. If an existing Agent Studio daemon is already running (such as a background Tailscale server started via `node dist/cli/index.js serve --host 0.0.0.0 --port 8767`), the extension attaches in **`external`** mode.
3. The extension **never kills, restarts, or conflicts with an external daemon**—closing the IDE or running `Agent Studio: Restart Server` leaves your external daemon untouched.
4. Only when port `8767` is offline (and `autoStart: true`) does the extension spawn its bundled `dist/studio-cli.mjs serve` process, which it cleanly terminates on `deactivate()`.

---

## 6. Rebuilding the `.vsix` Package

The extension bundles `src/cli/index.ts` → `extension/dist/studio-cli.mjs` and copies `dist/web/` → `extension/dist/web/` directly from the core repository:

```powershell
# 1. Ensure core Web Studio assets (dist/web/) are fresh
npm run build:all

# 2. Install extension devDependencies (first time only), typecheck, bundle & package
cd extension
npm install
npm run check
npm run package
```

Output package: `extension/agent-studio-<version>.vsix` (currently `extension/agent-studio-0.5.0.vsix`, derived dynamically from `extension/package.json`; self-contained, zero `node_modules/` inside the VSIX).
