# Agent Studio — VS Code & Antigravity Extension

Self-contained IDE extension wrapping the **Agent Studio** live multi-agent monitoring studio, QA-gated Agile Board, Agent Team inspector, and cross-IDE Setup/Doctor tooling inside **VS Code** and **Antigravity IDE**.

## Features
- **Activity Bar Sidebar (`Studio Overview`):** Live server status, active sessions across Antigravity / Claude Code / GitHub Copilot, sprint & bug summary, and one-click view launchers.
- **Full-Bleed Editor Tab (`Agent Studio: Open Studio`):** Embeds Live Studio (SVG topology mesh + video timeline scrubber), Agile Board Kanban, Agent Team, Mockups, and Setup & Doctor directly inside an editor tab with Remote SSH/WSL/Tunnel port forwarding.
- **Status Bar Telemetry Pill:** Live active-session counter and one-click launcher.
- **Daemon-Friendly Server Management:** Automatically attaches to an existing Agent Studio server on port `8767` (such as a Tailscale `0.0.0.0:8767` daemon) without conflict, or spawns the bundled local server on demand.
- **Command Palette Onboarding:** Run `Agent Studio: Onboard Workspace (Init & Sync)`, `Sync IDE Adapters`, and `Run Doctor Check` without leaving your IDE.
- **Auto-Registered MCP Provider:** Feature-detects VS Code's `lm.registerMcpServerDefinitionProvider` API to expose the bundled `agent-studio` stdio MCP server automatically.

## Commands
- `Agent Studio: Open Studio`
- `Agent Studio: Open Agile Board`
- `Agent Studio: Open Agent Team`
- `Agent Studio: Open Setup & Doctor`
- `Agent Studio: Open in Browser`
- `Agent Studio: Onboard Workspace (Init & Sync)`
- `Agent Studio: Sync IDE Adapters`
- `Agent Studio: Run Doctor Check`
- `Agent Studio: Restart Server`
