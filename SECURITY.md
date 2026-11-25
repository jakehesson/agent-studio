# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.8.x   | :white_check_mark: |
| 0.7.x   | :white_check_mark: |
| < 0.7.0 | :x:                |

## Data & Privacy Model

Agent Studio runs **100% locally** on your machine:
- Session transcripts, hooks, and Agile Board state (`pipeline/board.json`, `~/.agent-studio/`) are read and stored locally and are **never** transmitted to external servers.
- Compiled IDE MCP configurations (`.mcp.json`, `.vscode/mcp.json`, `.agents/plugins/*/mcp_config.json`) invoke `npx -y agent-studio mcp` over local stdio using `cwd` without embedding machine paths.
- When exposing `agent-studio serve` over a LAN or private overlay network (such as Tailscale), bind to `127.0.0.1` unless remote access over an authenticated tunnel is intentionally configured.

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, report vulnerabilities privately via GitHub Security Advisories:
- **GitHub Security Advisories:** https://github.com/jakehesson/agent-studio/security/advisories/new

Please include:
- A clear description of the vulnerability and potential impact
- Steps to reproduce or a minimal proof of concept
- Affected version(s) and host OS / IDE environment

You can expect an acknowledgment within 72 hours and coordinated disclosure once a fix is ready.
