#!/usr/bin/env python3
"""Antigravity Agent Visualizer — Cross-Project Multi-Agent Activity & Comms Studio.

Zero-dependency local web dashboard for observing ANY Antigravity multi-agent
session in real time:
  - Dynamic agent discovery (root coordinator + all spawned subagents via
    `invoke_subagent`, `"Created the following subagent"`, and `send_message`)
  - Auto-layout SVG topology graph with non-overlapping Agent Status Cards
  - Live THINKING / WORKING / DONE / WAITING / BLOCKED / IDLE state detection
  - Video-style scrubbing timeline with live tail edge, colored event ticks,
    hover preview tooltips, playback speed control, and full history rewind
  - Unified live Messages + Tool Calls stream with payload inspector

Usage:
    python agent_visualizer.py [--port 8765] [--host 127.0.0.1] [--session <uuid>] [--open]
"""

from __future__ import annotations

import argparse
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import time
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
import webbrowser

DEFAULT_BRAIN_DIR = Path.home() / ".gemini" / "antigravity" / "brain"

UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
CREATED_SUBAGENT_RE = re.compile(
    r"Created the following subagent:\s*\{[^}]*\"conversationId\"\s*:\s*\"([0-9a-f-]{36})\"",
    re.S,
)

PALETTE = [
    "#a855f7",  # Lead / Root (violet)
    "#ec4899",  # Pink
    "#06b6d4",  # Cyan
    "#3b82f6",  # Blue
    "#10b981",  # Emerald
    "#f59e0b",  # Amber
    "#f97316",  # Orange
    "#8b5cf6",  # Purple
    "#14b8a6",  # Teal
    "#ef4444",  # Rose
]

ACRONYMS = {"ui", "ux", "dom", "css", "qa", "api", "ops", "ai", "mcp", "ssh", "sql", "llm"}


def prettify_agent_label(raw_id: str) -> str:
    """Turn a slug like 'demo-ui-designer' or 'research' into a crisp card label."""
    if not raw_id:
        return "Agent"
    if raw_id == "root":
        return "Coordinator"
    parts = [p for p in re.split(r"[-_\s]+", raw_id.strip()) if p]
    # Strip redundant project prefix if followed by 2+ descriptive words
    if len(parts) >= 3 and parts[0].lower() in {"app", "proj"}:
        parts = parts[1:]
    out = []
    for p in parts:
        pl = p.lower()
        if pl in ACRONYMS:
            out.append(pl.upper())
        else:
            out.append(p.capitalize())
    label = " ".join(out)
    return label[:20] if len(label) > 20 else label


def unquote_arg(val: Any) -> str:
    """Antigravity transcripts store tool_call arg values as JSON-encoded strings."""
    if val is None:
        return ""
    if isinstance(val, str):
        s = val.strip()
        if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
            try:
                decoded = json.loads(s)
                if isinstance(decoded, str):
                    return decoded
            except Exception:
                pass
        return val
    return str(val)


def classify_message(sender: str, recipient: str, body: str, root_id: str, fallback: str = "peer") -> str:
    low = (body or "").lower()
    if any(k in low for k in ("blocker", "qa fail", "deadlock", "cannot proceed", "failed", "error:")):
        return "blocker"
    if any(k in low for k in ("complete", "completed", "pass", "verified", "ready for", "all checks passed")):
        if recipient == root_id or sender != root_id:
            return "complete"
    if sender == root_id:
        return "dispatch"
    return fallback


def summarize_tool_call(tname: str, args: dict[str, Any]) -> str:
    if tname == "read_file":
        p = unquote_arg(args.get("Path"))
        return f"Read: {Path(p).name if p else 'file'}"
    if tname == "write_file":
        p = unquote_arg(args.get("Path"))
        return f"Write: {Path(p).name if p else 'file'}"
    if tname == "edit_file":
        p = unquote_arg(args.get("Path"))
        return f"Edit: {Path(p).name if p else 'file'}"
    if tname == "run_command":
        summary = unquote_arg(args.get("toolSummary")) or unquote_arg(args.get("CommandLine"))[:38]
        return f"Run: {summary}"
    if tname == "invoke_subagent":
        role = unquote_arg(args.get("Role")) or unquote_arg(args.get("TypeName"))
        return f"Spawn: {role}"
    if tname == "send_message":
        return "Sending message"
    if tname == "search_web":
        return f"Search: {unquote_arg(args.get('query'))[:32]}"
    if tname == "call_mcp_tool":
        return f"MCP: {unquote_arg(args.get('ToolName'))}"
    if tname == "swarm":
        return f"Swarm: {unquote_arg(args.get('action'))} {unquote_arg(args.get('name'))}".strip()
    return f"Tool: {tname}"


FS_TOOLS = {
    "read_file", "write_file", "edit_file", "multi_replace_file_content",
    "replace_file_content", "view_file", "view_file_outline", "view_code_item",
    "find_by_name", "grep_search", "list_dir",
}
FS_READ_TOOLS = {"read_file", "view_file", "view_file_outline", "view_code_item", "find_by_name", "grep_search", "list_dir"}
SHELL_TOOLS = {"run_command", "send_command_input", "command_status", "manage_task"}
WEB_TOOLS = {"read_url_content", "search_web", "browser_subagent", "open_browser_url"}


def classify_external_tool(tname: str, args: dict[str, Any]) -> tuple[str, str, str, str] | None:
    """Map a tool call to an external system node: (ext_id, label, role, color)."""
    if not tname or tname in ("invoke_subagent", "send_message", "notify_user"):
        return None
    if tname.startswith("mcp_"):
        parts = tname.split("_")
        srv = parts[1] if len(parts) > 2 else "server"
        return (f"ext:mcp:{srv}", f"MCP: {prettify_agent_label(srv)}", "MCP External Server", "#38bdf8")
    if tname in ("call_mcp_tool", "read_resource", "list_resources"):
        srv = (unquote_arg(args.get("ServerName")) or "mcp").strip().lower().replace(" ", "-")
        return (f"ext:mcp:{srv}", f"MCP: {prettify_agent_label(srv)}", "MCP External Server", "#38bdf8")
    if tname in WEB_TOOLS:
        return ("ext:web", "Web / Browser", "External HTTP & Browser", "#14b8a6")
    if tname in SHELL_TOOLS:
        return ("ext:shell", "Local Shell", "OS / Terminal Runtime", "#f97316")
    if tname in FS_TOOLS:
        return ("ext:fs", "Workspace FS", "Local Filesystem", "#64748b")
    return None


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    meta: dict[str, str] = {}
    body = text
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip().lower()] = v.strip().strip('"').strip("'")
            body = parts[2].strip()
    return meta, body


def discover_agent_definitions(workspace_roots: list[Path] | None = None) -> dict[str, dict[str, Any]]:
    """Discover Antigravity agent .md definitions across global plugins & session workspaces."""
    defs: dict[str, dict[str, Any]] = {}
    candidates: list[Path] = []
    home = Path.home()
    plugins_dir = home / ".gemini" / "config" / "plugins"
    if plugins_dir.is_dir():
        candidates.extend(sorted(plugins_dir.glob("*/agents/*.md")))

    search_dirs: list[Path] = [home / ".gemini" / "antigravity" / "agents"]
    seen_roots: set[str] = set()
    for root in [Path.cwd(), *(workspace_roots or [])]:
        try:
            key = str(root.resolve()).lower()
        except OSError:
            key = str(root).lower()
        if key in seen_roots or not root.is_dir():
            continue
        seen_roots.add(key)
        search_dirs.extend(
            [
                root / ".agents" / "agents",
                root / ".gemini" / "agents",
                root / ".claude" / "agents",
                root / "agents",
            ]
        )
        for pdir in (
            root / ".agents" / "plugins",
            root / ".gemini" / "plugins",
            root / ".claude" / "plugins",
        ):
            if pdir.is_dir():
                candidates.extend(sorted(pdir.glob("*/agents/*.md")))

    for extra in search_dirs:
        if extra.is_dir():
            candidates.extend(sorted(extra.glob("*.md")))

    for path in candidates:
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta, body = _parse_frontmatter(raw)
        raw_name = meta.get("name") or path.stem
        slug = raw_name.strip().lower().replace(" ", "-")
        defs[slug] = {
            "id": slug,
            "name": raw_name,
            "description": meta.get("description") or "",
            "model": meta.get("model") or "",
            "source_path": str(path).replace("\\", "/"),
            "chars": len(raw),
            "est_tokens": max(1, len(raw) // 4),
            "preview": body[:1400],
        }
    return defs


def read_transcript_rows(tpath: Path, max_lines: int = 0) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not tpath.is_file():
        return rows
    try:
        with tpath.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
                if max_lines > 0 and len(rows) >= max_lines:
                    break
    except OSError:
        return rows
    return rows


def _read_transcript_tail_rows(tpath: Path, max_bytes: int = 32768, max_lines: int = 30) -> list[dict[str, Any]]:
    """Read the last ~max_lines JSONL rows from a transcript in O(1) time."""
    if not tpath.is_file():
        return []
    try:
        size = tpath.stat().st_size
        with tpath.open("rb") as fh:
            if size > max_bytes:
                fh.seek(size - max_bytes)
                fh.readline()  # discard partial first line
            raw = fh.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    rows: list[dict[str, Any]] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows[-max_lines:] if len(rows) > max_lines else rows


_SESSION_META_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_PROJECT_PATH_RE = re.compile(
    r"(?:[A-Za-z]:[/\\]+(?:Work|Projects|dev|src|Repos|Code)[/\\]+(?:Personal[/\\]+)?|"
    r"/(?:home|Users)/[^/]+/(?:Work|Projects|dev|src|Repos|Code)/(?:Personal/)?)"
    r"([A-Za-z0-9][A-Za-z0-9 _.-]{0,48})",
    re.I,
)


def _detect_workspace_roots(rows: list[dict[str, Any]]) -> list[Path]:
    """Extract existing workspace/project root directories referenced in transcript rows."""
    chunks: list[str] = []
    total = 0
    for r in rows[:120]:
        if total >= 32000:
            break
        c = str(r.get("content") or "")[:3000]
        if c:
            chunks.append(c)
            total += len(c)
        for tc in r.get("tool_calls") or []:
            a = str(tc.get("args") or "")[:1500]
            if a:
                chunks.append(a)
                total += len(a)
    sample = "\n".join(chunks)
    roots: list[Path] = []
    seen: set[str] = set()
    for m in _PROJECT_PATH_RE.finditer(sample):
        raw_root = m.group(0).strip().rstrip("\\/.")
        key = raw_root.lower()
        if key in seen:
            continue
        p = Path(raw_root)
        if p.is_dir():
            seen.add(key)
            roots.append(p)
    return roots


_ACTIVE_WS_RE = re.compile(r"Active Workspaces:\s*-\s*((?:[A-Za-z]:[/\\]|/)[^\r\n]+)", re.I)
_CMD_CWD_RE = re.compile(r"Command Working Directory:\s*((?:[A-Za-z]:[/\\]|/)[^\r\n]+)", re.I)
_EXPLICIT_PROJECT_RE = re.compile(
    r"""(?:['"]project['"]\s*:\s*['"]([a-z0-9][a-z0-9_-]{1,48})['"]|--project(?:=|\s+)['"]?([a-z0-9][a-z0-9_-]{1,48})['"]?)""",
    re.I,
)
_SUBPROJECT_PATH_RE = re.compile(
    r"(?:[A-Za-z]:[/\\]+|/)[^\r\n\"'`<>|]*?[/\\](?:mods[/\\][A-Za-z0-9_-]+|projects|packages|apps)[/\\]([A-Za-z0-9][A-Za-z0-9_-]{2,48})(?:[/\\]|$)",
    re.I,
)


def _norm_ws_path(p: str) -> str:
    """Normalize a workspace path for cross-platform comparison."""
    s = str(p or "").strip().strip("\"'`").replace("\\", "/")
    s = re.sub(r"/+", "/", s).rstrip("/")
    return s.lower() if os.name == "nt" else s


def _extract_session_workspaces(sample_text: str) -> list[str]:
    """Extract deduplicated normalized workspace paths from transcript sample text."""
    seen: set[str] = set()
    workspaces: list[str] = []

    def _add(raw: str) -> None:
        norm = _norm_ws_path(raw.rstrip("\\/."))
        if norm and norm not in seen:
            seen.add(norm)
            workspaces.append(norm)

    for m in _ACTIVE_WS_RE.finditer(sample_text):
        _add(m.group(1))
    for m in _CMD_CWD_RE.finditer(sample_text):
        _add(m.group(1))
    for m in _PROJECT_PATH_RE.finditer(sample_text):
        _add(m.group(0))
    return workspaces


def _session_matches_filter(session: dict[str, Any], workspace: str = "", project: str = "") -> bool:
    """Return True if a session matches the optional workspace/project filter."""
    workspace = workspace.strip()
    project = project.strip()
    if not workspace and not project:
        return True

    ws_list: list[str] = session.get("workspaces") or []
    sess_proj = str(session.get("project") or "")

    if workspace:
        norm_ws = _norm_ws_path(workspace)
        ws_name = Path(workspace).name.lower()
        for w in ws_list:
            if w == norm_ws or w.startswith(norm_ws + "/"):
                return True
        if ws_name and sess_proj.lower() == ws_name:
            return True
        return False

    norm_proj = re.sub(r"[\s_-]+", "", project.lower())
    if not norm_proj:
        return True
    if re.sub(r"[\s_-]+", "", sess_proj.lower()) == norm_proj:
        return True
    for w in ws_list:
        base = w.rsplit("/", 1)[-1]
        if re.sub(r"[\s_-]+", "", base.lower()) == norm_proj:
            return True
    return False


_GENERIC_PROJECT_NAMES = {
    "personal", "tmp", "temp", "logs", "brain", "work", "projects",
    "repos", "code", "dev", "src", "default", "all", "none", "test", "tests",
}


def _norm_project_key(name: str) -> str:
    return re.sub(r"[\s_-]+", "", name.lower())


_BOARD_PROJECTS_CACHE: tuple[float, list[dict[str, Any]]] = (0.0, [])


def _discover_board_projects(ttl_sec: float = 30.0) -> list[dict[str, Any]]:
    """Discover registered DevOps board projects from sibling/workspace project.json files."""
    global _BOARD_PROJECTS_CACHE
    now = time.time()
    if _BOARD_PROJECTS_CACHE[1] and (now - _BOARD_PROJECTS_CACHE[0]) < ttl_sec:
        return _BOARD_PROJECTS_CACHE[1]

    roots: list[Path] = []
    env_root = os.environ.get("AV_PROJECTS_ROOT", "").strip()
    if env_root:
        roots.append(Path(env_root))
    parent_root = Path(__file__).resolve().parent.parent
    if parent_root not in roots:
        roots.append(parent_root)

    found: dict[str, dict[str, Any]] = {}
    patterns = (
        "*/project.json",
        "*/mods/*/*/project.json",
        "*/mods/*/project.json",
        "*/projects/*/project.json",
    )
    for base in roots:
        if not base.is_dir():
            continue
        for pat in patterns:
            for pjson in sorted(base.glob(pat)):
                try:
                    cfg = json.loads(pjson.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if not isinstance(cfg, dict):
                    continue
                pid = str(cfg.get("name") or pjson.parent.name).strip()
                if not pid or pid in found:
                    continue
                root_path = pjson.parent.resolve()
                found[pid] = {
                    "id": pid,
                    "display_name": str(cfg.get("display_name") or cfg.get("title") or pid).strip(),
                    "root": str(root_path),
                    "root_norm": str(root_path).replace("\\", "/").rstrip("/").lower(),
                    "root_name": root_path.name,
                }

    result = sorted(found.values(), key=lambda bp: bp["id"].lower())
    _BOARD_PROJECTS_CACHE = (now, result)
    return result


def _detect_session_project(sample_text: str) -> str:
    """Dynamically infer the most specific project/subproject name from transcript text."""
    ws_base = ""
    for rx in (_ACTIVE_WS_RE, _CMD_CWD_RE):
        for m in rx.finditer(sample_text):
            raw = m.group(1).strip().strip("\"'`").rstrip("\\/.")
            if raw:
                base = raw.replace("\\", "/").rsplit("/", 1)[-1].strip()
                if base and base.lower() not in _GENERIC_PROJECT_NAMES:
                    ws_base = base
                    break
        if ws_base:
            break

    # 1. Prefer explicit tool/CLI project identifiers and monorepo subproject paths
    #    (e.g., mods/<category>/<subproject>, projects/<subproject>, --project <slug>)
    #    so multi-project workspaces don't collapse all subprojects into one parent folder.
    sub_counts: dict[str, int] = {}
    for m in _EXPLICIT_PROJECT_RE.finditer(sample_text):
        slug = (m.group(1) or m.group(2) or "").strip()
        if not slug or slug.lower() in _GENERIC_PROJECT_NAMES:
            continue
        sub_counts[slug] = sub_counts.get(slug, 0) + 3
    for m in _SUBPROJECT_PATH_RE.finditer(sample_text):
        slug = m.group(1).strip()
        if not slug or slug.lower() in _GENERIC_PROJECT_NAMES:
            continue
        sub_counts[slug] = sub_counts.get(slug, 0) + 1

    if sub_counts:
        best_sub = max(sub_counts.items(), key=lambda kv: kv[1])[0]
        if ws_base and _norm_project_key(best_sub) == _norm_project_key(ws_base):
            return ws_base
        return best_sub

    # 2. Fall back to workspace/CWD folder basename for single-project repos.
    if ws_base:
        return ws_base

    # 3. Fall back to most frequent top-level project path in transcript text.
    counts: dict[str, int] = {}
    for m in _PROJECT_PATH_RE.finditer(sample_text):
        name = m.group(1).strip().rstrip(".,;:'\"`)")
        if not name or name.lower() in _GENERIC_PROJECT_NAMES:
            continue
        counts[name] = counts.get(name, 0) + 1
    if not counts:
        return "General"
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _analyze_session_tail(tail_rows: list[dict[str, Any]]) -> tuple[str, str | None]:
    """Infer (tail_state, waiting_on) from the tail rows of a session transcript.

    tail_state is one of: 'waiting', 'working', 'thinking', 'completed'.
    """
    if not tail_rows:
        return "completed", None

    def _is_viz_daemon(txt: str) -> bool:
        return "agent-visualizer.py" in txt or "agent_visualizer.py" in txt

    # Scan forward over tail_rows to track pending user/approval/subagent waits
    waiting_on: str | None = None
    for r in tail_rows:
        rtype = r.get("type") or ""
        rstatus = (r.get("status") or "").upper()
        if rtype == "USER_INPUT":
            waiting_on = None
            continue
        if rtype == "SYSTEM_MESSAGE":
            # A subagent reply or background task completion clears a subagent wait
            if waiting_on and waiting_on.startswith("Subagent"):
                waiting_on = None
            continue
        if rstatus in ("WAITING_FOR_USER", "PENDING_APPROVAL", "NEEDS_APPROVAL"):
            waiting_on = "Tool approval"
        for tc in r.get("tool_calls") or []:
            tname = tc.get("name") or ""
            args = tc.get("args") or {}
            if tname == "ask_user_question":
                waiting_on = "Question"
            elif tname == "notify_user":
                blocked = str(args.get("BlockedOnUser") or "").strip().lower()
                if blocked == "true":
                    waiting_on = "User input"
            elif tname in ("write_file", "edit_file") and args.get("ArtifactMetadata"):
                raw_meta = args.get("ArtifactMetadata")
                meta_obj: dict[str, Any] = {}
                if isinstance(raw_meta, dict):
                    meta_obj = raw_meta
                elif isinstance(raw_meta, str):
                    try:
                        dec = json.loads(raw_meta)
                        if isinstance(dec, str):
                            dec = json.loads(dec)
                        if isinstance(dec, dict):
                            meta_obj = dec
                    except Exception:
                        meta_obj = {}
                if meta_obj.get("RequestFeedback") is True:
                    waiting_on = "Plan approval"
            elif tname == "invoke_subagent":
                role = unquote_arg(args.get("Role")) or unquote_arg(args.get("TypeName"))
                waiting_on = f"Subagent: {role}" if role else "Subagent"

    last_row = tail_rows[-1]
    ltype = last_row.get("type") or ""
    lstatus = (last_row.get("status") or "").upper()
    ltcs = last_row.get("tool_calls") or []
    lcontent = str(last_row.get("content") or "")

    # If the planner produced a final text response with no tool calls, only keep waiting_on
    # if it was set by that same response or is waiting on a subagent/approval/question.
    if ltype == "PLANNER_RESPONSE" and not ltcs and waiting_on and waiting_on.startswith("Subagent"):
        return "waiting", waiting_on

    if waiting_on:
        return "waiting", waiting_on

    non_daemon_running = any(
        (r.get("status") or "").upper() == "RUNNING" and not _is_viz_daemon(str(r.get("content") or ""))
        for r in tail_rows[-6:]
    )
    if lstatus == "RUNNING" and not _is_viz_daemon(lcontent):
        return "working", None
    if ltype == "PLANNER_RESPONSE" and len(ltcs) > 0:
        if not any(_is_viz_daemon(json.dumps(tc.get("args") or {})) for tc in ltcs):
            return "working", None
    if non_daemon_running:
        return "working", None
    if ltype in ("SYSTEM_MESSAGE", "USER_INPUT", "GENERIC"):
        return "thinking", None
    return "completed", None


def _inspect_session_entry(entry_id: str, tpath: Path, mtime: float) -> dict[str, Any]:
    cached = _SESSION_META_CACHE.get(entry_id)
    if cached and cached[0] == mtime:
        return cached[1]

    rows = read_transcript_rows(tpath, max_lines=150)
    tail_rows = _read_transcript_tail_rows(tpath, max_bytes=32768, max_lines=30)
    first_user = ""
    subagent_count = 0
    child_ids: list[str] = []
    sample_chunks: list[str] = []
    sample_len = 0

    for r in rows:
        c = str(r.get("content") or "")
        if sample_len < 24000:
            sample_chunks.append(c[:4000])
            sample_len += min(len(c), 4000)
        if not first_user and r.get("type") == "USER_INPUT" and c.strip():
            clean = re.sub(r"<[^>]+>", " ", c)
            clean = re.sub(r"@\[[^\]]+\]", " ", clean)
            clean = re.sub(r"\s+", " ", clean).strip()
            clean = re.sub(r"\s*The current local time is:.*$", "", clean, flags=re.I)
            clean = re.sub(r"\s*The user's current state is as follows:.*$", "", clean, flags=re.I)
            clean = re.sub(r"\s+", " ", clean).strip()
            first_user = clean[:96]
        for tc in r.get("tool_calls") or []:
            if sample_len < 24000:
                args_str = str(tc.get("args") or "")[:1500]
                sample_chunks.append(args_str)
                sample_len += len(args_str)
            if tc.get("name") == "invoke_subagent":
                subagent_count += 1
        for m in CREATED_SUBAGENT_RE.finditer(c):
            child_ids.append(m.group(1))

    is_child = not first_user and len(rows) > 0 and rows[0].get("type") != "USER_INPUT"
    sample_text = "\n".join(sample_chunks)
    project = _detect_session_project(sample_text)
    workspaces = _extract_session_workspaces(sample_text)
    tail_state, waiting_on = _analyze_session_tail(tail_rows)
    meta = {
        "first_user": first_user,
        "subagent_count": subagent_count,
        "child_ids": child_ids,
        "is_child": is_child,
        "project": project,
        "workspaces": workspaces,
        "tail_state": tail_state,
        "waiting_on": waiting_on,
    }
    _SESSION_META_CACHE[entry_id] = (mtime, meta)
    return meta


def list_recent_sessions(
    brain_dir: Path,
    limit: int = 120,
    workspace: str = "",
    project: str = "",
) -> list[dict[str, Any]]:
    """List top-level Antigravity sessions across ALL projects, with optional filtering."""
    if not brain_dir.is_dir():
        return []

    raw_entries: list[dict[str, Any]] = []
    for sub in brain_dir.iterdir():
        if not sub.is_dir() or not UUID_RE.fullmatch(sub.name):
            continue
        tpath = sub / ".system_generated" / "logs" / "transcript.jsonl"
        if not tpath.is_file():
            continue
        try:
            mtime = tpath.stat().st_mtime
        except OSError:
            continue
        raw_entries.append({"id": sub.name, "path": tpath, "mtime": mtime})

    raw_entries.sort(key=lambda e: e["mtime"], reverse=True)

    child_ids: set[str] = set()
    for entry in raw_entries:
        meta = _inspect_session_entry(entry["id"], entry["path"], entry["mtime"])
        for cid in meta["child_ids"]:
            child_ids.add(cid)
        if meta["is_child"]:
            child_ids.add(entry["id"])
        entry["meta"] = meta

    now = time.time()
    sessions: list[dict[str, Any]] = []
    for entry in raw_entries:
        meta = entry["meta"]
        if entry["id"] in child_ids or meta["is_child"]:
            continue
        has_sub = meta["subagent_count"] > 0
        lt = time.localtime(entry["mtime"])
        age_sec = max(0, int(now - entry["mtime"]))
        tail_state = meta.get("tail_state") or "completed"
        waiting_on = meta.get("waiting_on")
        # Expire stale thinking/working/subagent-wait states (>15 min idle)
        if tail_state in ("thinking", "working") and age_sec >= 900:
            status = "completed"
            waiting_on = None
        elif tail_state == "waiting" and waiting_on and waiting_on.startswith("Subagent") and age_sec >= 1800:
            status = "completed"
            waiting_on = None
        else:
            status = tail_state
        is_waiting = bool(waiting_on) and status == "waiting"
        is_completed = status == "completed" and not is_waiting

        session_item = {
            "id": entry["id"],
            "label": meta["first_user"] or f"Session {entry['id'][:8]}",
            "project": meta["project"],
            "workspaces": meta.get("workspaces", []),
            "mtime": entry["mtime"],
            "updated": time.strftime("%H:%M:%S", lt),
            "updated_date": time.strftime("%m/%d %H:%M", lt),
            "has_subagents": has_sub,
            "is_multi_agent": has_sub,
            "subagent_count": meta["subagent_count"],
            "priority": 2 if has_sub else 1,
            "status": status,
            "waiting_on": waiting_on,
            "is_waiting": is_waiting,
            "is_completed": is_completed,
        }
        sessions.append(session_item)

    # Canonicalize project names against registered DevOps board projects first,
    # then merge any remaining variants sharing the same normalized key.
    board_projects = _discover_board_projects()
    board_key_map: dict[str, str] = {}
    board_root_map: list[tuple[str, str]] = []
    board_ids: set[str] = set()
    for bp in board_projects:
        pid = bp["id"]
        board_ids.add(pid)
        for alias in (pid, bp["root_name"]):
            k = _norm_project_key(alias)
            if k:
                board_key_map.setdefault(k, pid)
        if bp["root_norm"]:
            board_root_map.append((bp["root_norm"], pid))
    # Sort longest root path first so subprojects match before parent workspaces
    board_root_map.sort(key=lambda pair: len(pair[0]), reverse=True)

    for s in sessions:
        key = _norm_project_key(s["project"])
        if key in board_key_map:
            s["project"] = board_key_map[key]
        else:
            # Try matching session workspaces against registered board project roots
            for ws in s.get("workspaces") or []:
                ws_norm = str(ws).replace("\\", "/").rstrip("/").lower()
                for root_norm, pid in board_root_map:
                    if ws_norm == root_norm or ws_norm.startswith(root_norm + "/"):
                        s["project"] = pid
                        break
                if s["project"] in board_ids:
                    break

    proj_variants: dict[str, dict[str, int]] = {}
    for s in sessions:
        p = s["project"]
        key = _norm_project_key(p)
        if not key:
            continue
        bucket = proj_variants.setdefault(key, {})
        bucket[p] = bucket.get(p, 0) + 1

    canonical_map: dict[str, str] = {}
    for key, counts in proj_variants.items():
        if key in board_key_map:
            canonical_map[key] = board_key_map[key]
        else:
            # Prefer kebab-case slugs when present, else most frequent.
            best_name = max(
                counts.items(),
                key=lambda kv: (1 if "-" in kv[0] else 0, kv[1], kv[0].lower()),
            )[0]
            canonical_map[key] = best_name

    for s in sessions:
        key = _norm_project_key(s["project"])
        if key in canonical_map:
            s["project"] = canonical_map[key]
        s["is_board_project"] = s["project"] in board_ids

    if workspace or project:
        sessions = [s for s in sessions if _session_matches_filter(s, workspace=workspace, project=project)]

    sessions.sort(key=lambda s: s["mtime"], reverse=True)
    return sessions[:limit]


def detect_root_name(rows: list[dict[str, Any]]) -> tuple[str, str]:
    """Infer a friendly root coordinator id + role from the opening prompt if present."""
    for r in rows[:6]:
        if r.get("type") == "USER_INPUT":
            c = str(r.get("content") or "")
            m = re.search(r"agents/([a-z0-9_-]+)\.md", c, re.I)
            if m:
                slug = m.group(1)
                return slug, "Lead Coordinator"
    return "coordinator", "Root Coordinator"


def parse_live_session(brain_dir: Path, root_conv_id: str) -> dict[str, Any]:
    """Dynamically discover root + all spawned subagents and compute live states & timeline."""
    root_tpath = brain_dir / root_conv_id / ".system_generated" / "logs" / "transcript.jsonl"
    root_rows = read_transcript_rows(root_tpath)
    root_id, root_role = detect_root_name(root_rows)

    conv_to_agent: dict[str, str] = {root_conv_id: root_id}
    pending_spawns: list[tuple[str, str, str]] = []  # (parent_cid, target_id, target_role)
    agent_info: dict[str, dict[str, Any]] = {}
    agent_order: list[str] = []
    events: list[dict[str, Any]] = []
    activity: list[dict[str, Any]] = []
    visited: set[str] = set()
    queue: list[str] = [root_conv_id]

    def ensure_agent(
        aid: str,
        role: str = "",
        conv_id: str | None = None,
        node_type: str = "agent",
        label_override: str = "",
        color_override: str = "",
    ) -> dict[str, Any]:
        if aid not in agent_info:
            color = color_override or PALETTE[len(agent_order) % len(PALETTE)]
            agent_order.append(aid)
            agent_info[aid] = {
                "id": aid,
                "label": label_override or prettify_agent_label(aid),
                "role": role or ("Lead Coordinator" if aid == root_id else "Specialist Subagent"),
                "color": color,
                "node_type": node_type,
                "is_root": aid == root_id,
                "conv_id": conv_id,
                "state": "idle",
                "action": "Standby",
                "steps": 0,
                "tool_calls": 0,
                "msg_sent": 0,
                "msg_recv": 0,
                "last_mtime": 0.0,
                "has_running": False,
                "is_thinking": False,
                "thinking_action": "",
                "last_wake_ts": "",
                "last_complete_ts": "",
                "has_error": False,
                "reported_done": False,
                "recent_actions": [],
                "spawn_prompt": "",
                "context_chars": 0,
                "fs_reads": 0,
                "pending_prompt": None,
            }
        else:
            if role and agent_info[aid]["role"] == "Specialist Subagent":
                agent_info[aid]["role"] = role
            if conv_id and not agent_info[aid]["conv_id"]:
                agent_info[aid]["conv_id"] = conv_id
        return agent_info[aid]

    ensure_agent("human", "User / Prompt Source", node_type="human", label_override="Human", color_override="#f59e0b")
    ensure_agent(root_id, root_role, root_conv_id, node_type="agent")

    while queue:
        cid = queue.pop(0)
        if cid in visited:
            continue
        visited.add(cid)

        tpath = brain_dir / cid / ".system_generated" / "logs" / "transcript.jsonl"
        rows = root_rows if cid == root_conv_id else read_transcript_rows(tpath)
        sender_id = conv_to_agent.get(cid)
        if not sender_id:
            sender_id = f"agent-{cid[:6]}"
            conv_to_agent[cid] = sender_id

        info = ensure_agent(sender_id, conv_id=cid)
        info["conv_id"] = cid
        info["steps"] = len(rows)
        if tpath.is_file():
            try:
                info["last_mtime"] = max(info["last_mtime"], tpath.stat().st_mtime)
            except OSError:
                pass

        pending_prompt: dict[str, Any] | None = None

        for idx, row in enumerate(rows):
            ts = row.get("created_at") or ""
            rtype = row.get("type") or ""
            status = row.get("status") or ""
            content = str(row.get("content") or "")
            tool_calls = row.get("tool_calls") or []

            if rtype == "USER_INPUT":
                pending_prompt = None
            elif rtype == "SYSTEM_MESSAGE" and pending_prompt and pending_prompt.get("kind") == "approval":
                pending_prompt = None
            elif rtype == "GENERIC" and status == "DONE" and pending_prompt and pending_prompt.get("kind") == "question":
                pending_prompt = None

            if rtype in ("SYSTEM_MESSAGE", "USER_INPUT") and ts >= info["last_wake_ts"]:
                info["last_wake_ts"] = ts
            if status == "ERROR" and idx >= len(rows) - 3:
                info["has_error"] = True
            info["context_chars"] += len(content) + (len(json.dumps(tool_calls)) if tool_calls else 0)

            if rtype == "USER_INPUT" and content.strip():
                clean_prompt = re.sub(r"<[^>]+>", " ", content)
                clean_prompt = re.sub(r"\s+", " ", clean_prompt).strip()
                if clean_prompt:
                    h_info = agent_info["human"]
                    h_info["steps"] += 1
                    h_info["action"] = f"Prompt: {clean_prompt[:34]}"
                    h_info["last_mtime"] = max(h_info["last_mtime"], info["last_mtime"])
                    h_info["recent_actions"].append({"ts": ts, "tool": "USER_INPUT", "text": clean_prompt[:60]})
                    if len(h_info["recent_actions"]) > 8:
                        h_info["recent_actions"] = h_info["recent_actions"][-8:]
                    ev = {
                        "id": f"{cid}:{idx}:human:in",
                        "ts": ts,
                        "from": "human",
                        "to": sender_id,
                        "kind": "human",
                        "title": f"Human: {clean_prompt[:85]}",
                        "body": content[:1400],
                        "conv": cid,
                    }
                    events.append(ev)
                    activity.append(ev)

            # Match newly created subagent conversationId to the queued invoke_subagent call
            m_sub = CREATED_SUBAGENT_RE.search(content)
            if m_sub:
                child_cid = m_sub.group(1)
                if child_cid != cid:
                    spawned_id, spawned_role = None, ""
                    for pi, (p_cid, p_id, p_role) in enumerate(pending_spawns):
                        if p_cid == cid:
                            spawned_id, spawned_role = p_id, p_role
                            pending_spawns.pop(pi)
                            break
                    if child_cid not in conv_to_agent:
                        base_id = spawned_id or f"subagent-{child_cid[:6]}"
                        # Disambiguate if multiple instances of same TypeName are spawned
                        if base_id in agent_info and agent_info[base_id]["conv_id"] not in (None, child_cid):
                            n = 2
                            while f"{base_id}-{n}" in agent_info:
                                n += 1
                            base_id = f"{base_id}-{n}"
                        conv_to_agent[child_cid] = base_id
                        ensure_agent(base_id, spawned_role, child_cid)
                    if child_cid not in visited:
                        queue.append(child_cid)

            for tc in tool_calls:
                tname = tc.get("name", "")
                args = tc.get("args") or {}
                action_text = summarize_tool_call(tname, args)

                info["tool_calls"] += 1
                info["action"] = action_text
                info["recent_actions"].append({"ts": ts, "tool": tname, "text": action_text})
                if len(info["recent_actions"]) > 8:
                    info["recent_actions"] = info["recent_actions"][-8:]

                if tname == "invoke_subagent":
                    raw_type = unquote_arg(args.get("TypeName")) or "subagent"
                    role = unquote_arg(args.get("Role")) or raw_type
                    prompt = unquote_arg(args.get("Prompt"))
                    target_id = raw_type.strip().lower().replace(" ", "-")
                    t_info = ensure_agent(target_id, role)
                    if prompt and not t_info["spawn_prompt"]:
                        t_info["spawn_prompt"] = prompt
                    pending_spawns.append((cid, target_id, role))
                    ev = {
                        "id": f"{cid}:{idx}:spawn:{target_id}",
                        "ts": ts,
                        "from": sender_id,
                        "to": target_id,
                        "kind": "dispatch",
                        "title": f"Spawned {role}",
                        "body": prompt[:1000],
                        "conv": cid,
                    }
                    events.append(ev)
                    activity.append(ev)
                elif tname == "ask_question":
                    raw_qs = args.get("questions")
                    parsed_qs: list[Any] = []
                    if isinstance(raw_qs, list):
                        parsed_qs = raw_qs
                    elif isinstance(raw_qs, str):
                        try:
                            dec = json.loads(raw_qs)
                            if isinstance(dec, str):
                                dec = json.loads(dec)
                            if isinstance(dec, list):
                                parsed_qs = dec
                        except Exception:
                            parsed_qs = []
                    clean_qs = []
                    for q in parsed_qs:
                        if isinstance(q, dict):
                            q_text = str(q.get("question") or "").strip()
                            opts = [str(o) for o in (q.get("options") or []) if str(o).strip()]
                            if q_text or opts:
                                clean_qs.append({
                                    "question": q_text,
                                    "options": opts,
                                    "is_multi_select": bool(q.get("is_multi_select")),
                                })
                    if clean_qs:
                        pending_prompt = {
                            "id": f"{cid}:{idx}:ask_question",
                            "kind": "question",
                            "agent_id": sender_id,
                            "agent_label": info["label"],
                            "agent_color": info["color"],
                            "ts": ts,
                            "questions": clean_qs,
                        }
                        first_q = clean_qs[0]["question"] or "Multiple-choice question"
                        ev = {
                            "id": f"{cid}:{idx}:human:question",
                            "ts": ts,
                            "from": sender_id,
                            "to": "human",
                            "kind": "human",
                            "title": f"-> Human Question: {first_q[:72]}",
                            "body": "\n\n".join(
                                q["question"] + ("\n" + "\n".join(f"  - {o}" for o in q["options"]) if q["options"] else "")
                                for q in clean_qs
                            )[:1400],
                            "conv": cid,
                        }
                        events.append(ev)
                        activity.append(ev)
                elif tname == "notify_user":
                    msg = unquote_arg(args.get("Message")) or "Updated user"
                    ev = {
                        "id": f"{cid}:{idx}:human:out",
                        "ts": ts,
                        "from": sender_id,
                        "to": "human",
                        "kind": "human",
                        "title": f"-> Human: {msg.splitlines()[0][:80]}",
                        "body": msg[:1400],
                        "conv": cid,
                    }
                    events.append(ev)
                    activity.append(ev)
                elif tname == "send_message":
                    rec_cid = unquote_arg(args.get("Recipient"))
                    msg = unquote_arg(args.get("Message"))
                    if UUID_RE.fullmatch(rec_cid) and rec_cid not in visited:
                        queue.append(rec_cid)
                    ev = {
                        "id": f"{cid}:{idx}:msg:{rec_cid[:8]}",
                        "ts": ts,
                        "from": sender_id,
                        "to": rec_cid,
                        "kind": "peer",
                        "title": (msg.splitlines()[0][:95] if msg else "Peer message"),
                        "body": msg[:1400],
                        "conv": cid,
                    }
                    events.append(ev)
                    activity.append(ev)
                else:
                    if tname in ("write_file", "edit_file") and args.get("ArtifactMetadata"):
                        raw_meta = args.get("ArtifactMetadata")
                        meta_obj: dict[str, Any] = {}
                        if isinstance(raw_meta, dict):
                            meta_obj = raw_meta
                        elif isinstance(raw_meta, str):
                            try:
                                dec_m = json.loads(raw_meta)
                                if isinstance(dec_m, str):
                                    dec_m = json.loads(dec_m)
                                if isinstance(dec_m, dict):
                                    meta_obj = dec_m
                            except Exception:
                                meta_obj = {}
                        if meta_obj.get("RequestFeedback") is True:
                            art_path = unquote_arg(args.get("Path"))
                            art_name = Path(art_path).name if art_path else "Plan Artifact"
                            pending_prompt = {
                                "id": f"{cid}:{idx}:approval_gate",
                                "kind": "approval",
                                "agent_id": sender_id,
                                "agent_label": info["label"],
                                "agent_color": info["color"],
                                "ts": ts,
                                "artifact": art_name,
                                "summary": str(meta_obj.get("Summary") or "").strip(),
                                "options": ["Proceed", "Request Changes"],
                            }
                    if tname in FS_READ_TOOLS:
                        info["fs_reads"] += 1
                    ext_meta = classify_external_tool(tname, args)
                    target_to = sender_id
                    if ext_meta:
                        ext_id, ext_label, ext_role, ext_color = ext_meta
                        ext_info = ensure_agent(
                            ext_id,
                            ext_role,
                            node_type="external",
                            label_override=ext_label,
                            color_override=ext_color,
                        )
                        ext_info["steps"] += 1
                        ext_info["tool_calls"] += 1
                        ext_info["msg_recv"] += 1
                        ext_info["action"] = action_text
                        ext_info["last_mtime"] = max(ext_info["last_mtime"], info["last_mtime"])
                        ext_info["recent_actions"].append({"ts": ts, "tool": tname, "text": f"{sender_id}: {action_text}"})
                        if len(ext_info["recent_actions"]) > 8:
                            ext_info["recent_actions"] = ext_info["recent_actions"][-8:]
                        target_to = ext_id
                    activity.append(
                        {
                            "id": f"{cid}:{idx}:tool:{tname}",
                            "ts": ts,
                            "from": sender_id,
                            "to": target_to,
                            "kind": "tool",
                            "title": action_text,
                            "body": f"[{sender_id}] {tname}\n{json.dumps({k: unquote_arg(v)[:200] for k, v in args.items()}, indent=2)}",
                            "conv": cid,
                        }
                    )

        info["pending_prompt"] = pending_prompt

        # Inspect transcript tail for active THINKING vs running tool vs yielded turn
        if rows:
            last_row = rows[-1]
            ltype = last_row.get("type") or ""
            lstatus = last_row.get("status") or ""
            ltcs = last_row.get("tool_calls") or []
            lcontent = str(last_row.get("content") or "")

            def is_viz_daemon(txt: str) -> bool:
                return "agent-visualizer.py" in txt or "agent_visualizer.py" in txt

            non_daemon_running = any(
                r.get("status") == "RUNNING" and not is_viz_daemon(str(r.get("content") or ""))
                for r in rows[-6:]
            )
            if lstatus == "RUNNING" and not is_viz_daemon(lcontent):
                info["has_running"] = True
            elif ltype == "PLANNER_RESPONSE" and len(ltcs) > 0:
                if not any(is_viz_daemon(json.dumps(tc.get("args") or {})) for tc in ltcs):
                    info["has_running"] = True
            else:
                info["has_running"] = non_daemon_running

            if ltype in ("SYSTEM_MESSAGE", "USER_INPUT"):
                info["is_thinking"] = True
                m_cnt = re.search(r"content=(.+)", lcontent, re.S)
                snippet = m_cnt.group(1) if m_cnt else lcontent
                snippet = re.sub(r"<[^>]+>|[`*#>]+", " ", snippet)
                snippet = re.sub(r"\s+", " ", snippet).strip()
                info["thinking_action"] = f"Thinking: {snippet[:34]}" if snippet else "Thinking on incoming message…"
            elif ltype == "GENERIC" and not info["has_running"]:
                info["is_thinking"] = True
                info["thinking_action"] = "Thinking on tool output…"

    # Second pass: resolve UUID recipients -> agent ids & compute edge counts
    edge_counts: dict[str, int] = {}
    for ev in events:
        if ev["to"] in conv_to_agent:
            ev["to"] = conv_to_agent[ev["to"]]
        elif UUID_RE.fullmatch(str(ev["to"])):
            ev["to"] = f"agent-{ev['to'][:6]}"
            ensure_agent(ev["to"])
        if ev["kind"] != "human":
            ev["kind"] = classify_message(
                ev["from"], ev["to"], ev["body"], root_id, "dispatch" if ev["kind"] == "dispatch" else "peer"
            )

        if ev["from"] in agent_info:
            agent_info[ev["from"]]["msg_sent"] += 1
            if ev["kind"] == "complete":
                if (ev.get("ts") or "") >= agent_info[ev["from"]]["last_complete_ts"]:
                    agent_info[ev["from"]]["last_complete_ts"] = ev.get("ts") or ""
                agent_info[ev["from"]]["action"] = f"Completed: {ev['title'][:36]}"
            elif ev["kind"] == "peer":
                to_lbl = agent_info.get(ev["to"], {}).get("label", ev["to"])
                agent_info[ev["from"]]["action"] = f"-> {to_lbl}: {ev['title'][:28]}"
        if ev["to"] in agent_info and ev["to"] != ev["from"]:
            agent_info[ev["to"]]["msg_recv"] += 1

        if ev["from"] != ev["to"]:
            pair = "|".join(sorted([ev["from"], ev["to"]]))
            edge_counts[pair] = edge_counts.get(pair, 0) + 1

    ev_by_id = {e["id"]: e for e in events}
    for act in activity:
        if act["id"] in ev_by_id:
            act["to"] = ev_by_id[act["id"]]["to"]
            act["kind"] = ev_by_id[act["id"]]["kind"]
        elif act["kind"] == "tool" and act.get("from") and act.get("to") and act["from"] != act["to"]:
            pair = "|".join(sorted([act["from"], act["to"]]))
            edge_counts[pair] = edge_counts.get(pair, 0) + 1

    events.sort(key=lambda e: e.get("ts") or "")
    activity.sort(key=lambda e: e.get("ts") or "")

    last_epoch = 0.0
    for item in activity:
        ts_str = item.get("ts") or ""
        ep = None
        if ts_str:
            try:
                ep = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
            except ValueError:
                ep = None
        if ep is None:
            ep = last_epoch + 1.0 if last_epoch else time.time()
        last_epoch = ep
        item["epoch"] = ep

    now = time.time()
    for aid, info in agent_info.items():
        age = int(now - info["last_mtime"]) if info["last_mtime"] > 0 else None
        info["age_sec"] = age
        ntype = info.get("node_type", "agent")
        if ntype == "human":
            info["state"] = "waiting" if (info["msg_sent"] > 0 or info["msg_recv"] > 0) else "idle"
            continue
        if ntype == "external":
            info["state"] = "working" if (age is not None and age < 15) else ("waiting" if info["tool_calls"] > 0 else "idle")
            continue
        info["reported_done"] = bool(
            info["last_complete_ts"]
            and (not info["last_wake_ts"] or info["last_complete_ts"] >= info["last_wake_ts"])
        )
        actively_thinking = info["is_thinking"] and (age is not None and age < 900)
        if not info["conv_id"]:
            info["state"] = "idle"
        elif actively_thinking:
            info["state"] = "thinking"
            if info["thinking_action"]:
                info["action"] = info["thinking_action"]
        elif info.get("pending_prompt"):
            info["state"] = "waiting"
            info["action"] = (
                "Waiting for user answer…"
                if info["pending_prompt"].get("kind") == "question"
                else "Waiting for plan approval…"
            )
        elif info["has_running"] or (age is not None and age < 12):
            info["state"] = "working"
        elif info["has_error"]:
            info["state"] = "blocker"
        elif info["reported_done"] and not info["is_root"]:
            info["state"] = "done"
        else:
            info["state"] = "waiting"

    # Build Agent Definitions & Context Diagnostics
    disk_defs = discover_agent_definitions(_detect_workspace_roots(root_rows))
    definitions: list[dict[str, Any]] = []
    matched_slugs: set[str] = set()

    for aid in agent_order:
        info = agent_info[aid]
        if info.get("node_type") != "agent":
            continue
        base_slug = re.sub(r"-\d+$", "", aid)
        d_rec = disk_defs.get(aid) or disk_defs.get(base_slug)
        if d_rec:
            matched_slugs.add(d_rec["id"])

        spawn_prompt = info.get("spawn_prompt") or ""
        ctx_chars = int(info.get("context_chars") or 0)
        est_ctx_tokens = ctx_chars // 4
        issues: list[dict[str, str]] = []

        if not info["is_root"] and not d_rec:
            issues.append({
                "level": "warn",
                "code": "NO_DEF_FILE",
                "label": "No .md Definition",
                "detail": "Spawned without a matching agent definition file; relies solely on ad-hoc spawn prompt.",
            })
        if not info["is_root"] and spawn_prompt and len(spawn_prompt) < 120:
            issues.append({
                "level": "warn",
                "code": "THIN_HANDOFF",
                "label": "Thin Handoff Prompt",
                "detail": f"Spawn prompt is only {len(spawn_prompt)} chars — may lack file paths, constraints, or acceptance criteria.",
            })
        if d_rec and d_rec["chars"] > 12000:
            issues.append({
                "level": "warn",
                "code": "LARGE_DEF",
                "label": "Large Definition",
                "detail": f"Definition file is ~{d_rec['est_tokens']:,} tokens; consumes system prompt budget on every turn.",
            })
        if ctx_chars > 120000:
            issues.append({
                "level": "warn",
                "code": "LARGE_CONTEXT",
                "label": "High Context Size",
                "detail": f"Transcript context is ~{est_ctx_tokens:,} tokens ({info['steps']} steps) — risk of context dilution or truncation.",
            })
        if not info["is_root"] and info["steps"] >= 3 and info["fs_reads"] == 0 and info["msg_recv"] <= 1:
            issues.append({
                "level": "info",
                "code": "ISOLATED_CONTEXT",
                "label": "Isolated Context",
                "detail": "Subagent has 0 workspace reads and <=1 incoming message; verify it has enough repo context.",
            })
        if info["has_error"]:
            issues.append({
                "level": "error",
                "code": "RECENT_ERROR",
                "label": "Recent Error",
                "detail": "Agent encountered an ERROR status in its recent transcript steps.",
            })

        definitions.append({
            "id": aid,
            "label": info["label"],
            "role": info["role"],
            "color": info["color"],
            "is_root": info["is_root"],
            "in_session": True,
            "state": info["state"],
            "source_path": d_rec["source_path"] if d_rec else "",
            "def_tokens": d_rec["est_tokens"] if d_rec else 0,
            "def_preview": d_rec["preview"] if d_rec else "",
            "description": d_rec["description"] if d_rec else "",
            "spawn_prompt": spawn_prompt[:1200],
            "spawn_chars": len(spawn_prompt),
            "context_tokens": est_ctx_tokens,
            "steps": info["steps"],
            "tool_calls": info["tool_calls"],
            "issues": issues,
        })

    for slug, d_rec in disk_defs.items():
        if slug in matched_slugs:
            continue
        issues = []
        if d_rec["chars"] > 12000:
            issues.append({
                "level": "warn",
                "code": "LARGE_DEF",
                "label": "Large Definition",
                "detail": f"Definition file is ~{d_rec['est_tokens']:,} tokens.",
            })
        definitions.append({
            "id": slug,
            "label": prettify_agent_label(slug),
            "role": d_rec["description"][:80] if d_rec["description"] else "Available Agent Definition",
            "color": "#64748b",
            "is_root": False,
            "in_session": False,
            "state": "idle",
            "source_path": d_rec["source_path"],
            "def_tokens": d_rec["est_tokens"],
            "def_preview": d_rec["preview"],
            "description": d_rec["description"],
            "spawn_prompt": "",
            "spawn_chars": 0,
            "context_tokens": 0,
            "steps": 0,
            "tool_calls": 0,
            "issues": issues,
        })

    pending_prompts = [
        agent_info[aid]["pending_prompt"]
        for aid in agent_order
        if agent_info[aid].get("pending_prompt")
    ]

    return {
        "session_id": root_conv_id,
        "root_id": root_id,
        "agent_order": agent_order,
        "agents": agent_info,
        "edge_counts": edge_counts,
        "events": events[-400:],
        "activity": activity[-600:],
        "definitions": definitions,
        "pending_prompts": pending_prompts,
    }


# ---------------------------------------------------------------------------
# Project-agnostic HTML Design Mockup Discovery & Feedback Store
# ---------------------------------------------------------------------------

_MOCKUP_SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".cache",
    "target",
    "bin",
    "obj",
    ".idea",
    ".vscode",
    ".agents",
    "logs",
    "tmp",
    "temp",
}

_MOCKUP_SCAN_CACHE: dict[tuple[str, tuple[str, ...]], tuple[float, list[dict[str, Any]]]] = {}


def _slugify_project(raw: str) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", str(raw or "").strip().lower()).strip("-")
    return slug or "project"


def _prettify_mockup_name(rel_path: str, theme_meta: dict[str, Any] | None = None) -> str:
    if isinstance(theme_meta, dict):
        for key in ("display_name", "name", "title"):
            val = str(theme_meta.get(key) or "").strip()
            if val:
                return val
    p = PurePosixPath(rel_path)
    stem = p.stem
    parent = p.parent.name if p.parent and p.parent.name not in ("", ".") else ""
    generic_stems = {"mockup", "design-mockup", "index"}
    generic_parents = {"mockups", "themes", "design", "designs", "ui"}
    if stem.lower() in generic_stems and parent and parent.lower() not in generic_parents:
        return prettify_agent_label(parent)
    if parent and parent.lower() not in generic_parents:
        return f"{prettify_agent_label(parent)} — {prettify_agent_label(stem)}"
    return prettify_agent_label(stem)


def _is_safe_scan_root(p: Path) -> bool:
    try:
        rp = p.resolve()
    except OSError:
        return False
    if not rp.is_dir():
        return False
    if len(rp.parts) <= 1:
        return False
    try:
        if rp == Path.home().resolve():
            return False
    except OSError:
        pass
    return True


def _is_mockup_html_file(fname: str, rel_dir_parts: tuple[str, ...], is_explicit_dir: bool) -> bool:
    low = fname.lower()
    if not low.endswith(".html"):
        return False
    if low.startswith(("mockup", "design-mockup")):
        return True
    if is_explicit_dir and len(rel_dir_parts) == 0:
        return True
    if len(rel_dir_parts) >= 1 and rel_dir_parts[-1].lower() == "mockups":
        return True
    if len(rel_dir_parts) >= 2 and rel_dir_parts[-2].lower() == "themes":
        return True
    return False


def _scan_mockup_entries(
    brain_dir: Path,
    mockup_dirs: list[Path] | None = None,
    ttl_sec: float = 5.0,
    force: bool = False,
) -> list[dict[str, Any]]:
    """Bounded shallow walk across explicit dirs, board projects, session workspaces, and sibling workspaces."""
    extra_dirs = [Path(d) for d in (mockup_dirs or [])]
    cache_key = (str(brain_dir), tuple(str(d) for d in extra_dirs))
    now = time.time()
    cached = _MOCKUP_SCAN_CACHE.get(cache_key)
    if not force and cached and (now - cached[0]) < ttl_sec:
        return cached[1]

    # Collect candidate roots in priority order:
    # 1. Explicit --mockup-dir CLI roots
    # 2. Registered board_projects roots
    # 3. Detected workspace roots from recent sessions
    # 4. Sibling project directories under common workspace parent(s)
    candidates: list[tuple[Path, str, str, bool]] = []
    seen_roots: set[str] = set()

    def _add_root(path: Path, project_id: str, project_name: str, is_explicit: bool) -> None:
        if not _is_safe_scan_root(path):
            return
        rp = path.resolve()
        rkey = _norm_ws_path(str(rp))
        if rkey in seen_roots:
            return
        seen_roots.add(rkey)
        candidates.append((rp, _slugify_project(project_id), project_name.strip() or rp.name, is_explicit))

    for d in extra_dirs:
        _add_root(d, d.name, d.name, True)

    for bp in _discover_board_projects():
        bp_root = Path(bp["root"])
        _add_root(bp_root, bp["id"], bp["display_name"], False)

    try:
        recent = list_recent_sessions(brain_dir, limit=25)
    except Exception:
        recent = []
    for sess in recent:
        for ws in sess.get("workspaces") or []:
            wpath = Path(ws)
            _add_root(wpath, wpath.name, wpath.name, False)

    parent_roots: list[Path] = []
    env_root = os.environ.get("AV_PROJECTS_ROOT", "").strip()
    if env_root:
        parent_roots.append(Path(env_root))
    parent_roots.append(Path(__file__).resolve().parent.parent)

    for base in parent_roots:
        if not base.is_dir():
            continue
        try:
            children = sorted(base.iterdir(), key=lambda x: x.name.lower())
        except OSError:
            continue
        for child in children:
            if not child.is_dir():
                continue
            cname = child.name
            if cname.startswith(".") or cname.lower() in _MOCKUP_SKIP_DIRS:
                continue
            _add_root(child, cname, cname, False)

    entries: list[dict[str, Any]] = []
    seen_files: set[str] = set()
    used_ids: set[str] = set()
    max_depth = 4

    for root_path, project_id, project_name, is_explicit in candidates:
        for dirpath, dirnames, filenames in os.walk(root_path):
            cur_dir = Path(dirpath)
            try:
                rel_dir = cur_dir.relative_to(root_path)
            except ValueError:
                dirnames[:] = []
                continue
            rel_parts = rel_dir.parts if rel_dir != Path(".") else ()
            if len(rel_parts) >= max_depth:
                dirnames[:] = []
            else:
                dirnames[:] = [
                    d for d in sorted(dirnames)
                    if not d.startswith(".") and d.lower() not in _MOCKUP_SKIP_DIRS
                ]

            for fname in sorted(filenames):
                if not _is_mockup_html_file(fname, rel_parts, is_explicit):
                    continue
                fpath = (cur_dir / fname).resolve()
                fkey = _norm_ws_path(str(fpath))
                if fkey in seen_files:
                    continue
                seen_files.add(fkey)
                rel_posix = fpath.relative_to(root_path).as_posix()
                base_id = f"{project_id}/{rel_posix}"
                mid = base_id
                suffix = 2
                while mid in used_ids:
                    mid = f"{project_id}-{suffix}/{rel_posix}"
                    suffix += 1
                used_ids.add(mid)
                entries.append(
                    {
                        "id": mid,
                        "project": project_id,
                        "project_name": project_name,
                        "rel_path": rel_posix,
                        "file_path": fpath,
                        "abs_dir": fpath.parent,
                    }
                )

    _MOCKUP_SCAN_CACHE[cache_key] = (now, entries)
    return entries


def _hydrate_mockup(entry: dict[str, Any], include_feedback: bool = False) -> dict[str, Any] | None:
    fpath: Path = entry["file_path"]
    if not fpath.is_file():
        return None
    try:
        st = fpath.stat()
    except OSError:
        return None

    mtime = float(st.st_mtime)
    size = int(st.st_size)
    abs_dir: Path = entry["abs_dir"]

    # Include direct sibling CSS mtime so live-reload triggers on stylesheet edits too.
    try:
        for sib in abs_dir.iterdir():
            if sib.is_file() and sib.suffix.lower() == ".css":
                mtime = max(mtime, float(sib.stat().st_mtime))
    except OSError:
        pass

    fb_path = abs_dir / "FEEDBACK.md"
    has_feedback = fb_path.is_file()
    feedback_mtime = 0.0
    if has_feedback:
        try:
            feedback_mtime = float(fb_path.stat().st_mtime)
        except OSError:
            feedback_mtime = 0.0

    tj_path = abs_dir / "theme.json"
    has_theme_json = tj_path.is_file()
    theme_meta: dict[str, Any] | None = None
    if has_theme_json:
        try:
            raw_tj = tj_path.read_text(encoding="utf-8", errors="replace")
            if len(raw_tj) <= 65536:
                parsed_tj = json.loads(raw_tj)
                if isinstance(parsed_tj, dict):
                    theme_meta = parsed_tj
        except Exception:
            theme_meta = None

    item: dict[str, Any] = {
        "id": entry["id"],
        "project": entry["project"],
        "project_name": entry["project_name"],
        "name": _prettify_mockup_name(entry["rel_path"], theme_meta),
        "rel_path": entry["rel_path"],
        "abs_dir": str(abs_dir),
        "mtime": mtime,
        "size": size,
        "has_feedback": has_feedback,
        "feedback_mtime": feedback_mtime,
        "has_theme_json": has_theme_json,
        "theme_meta": theme_meta,
    }
    if include_feedback:
        item["feedback"] = (
            fb_path.read_text(encoding="utf-8", errors="replace") if has_feedback else ""
        )
    return item


def discover_mockups(
    brain_dir: Path,
    mockup_dirs: list[Path] | None = None,
    project: str = "",
    selected_id: str = "",
    force: bool = False,
) -> dict[str, Any]:
    """Return discovered mockups, project summary list, and optional selected mockup detail."""
    entries = _scan_mockup_entries(brain_dir, mockup_dirs=mockup_dirs, force=force)
    all_items: list[dict[str, Any]] = []
    entry_by_id: dict[str, dict[str, Any]] = {}
    for e in entries:
        item = _hydrate_mockup(e, include_feedback=False)
        if item is not None:
            all_items.append(item)
            entry_by_id[item["id"]] = e

    all_items.sort(key=lambda m: (-m["mtime"], m["project_name"].lower(), m["rel_path"].lower()))

    proj_map: dict[str, dict[str, Any]] = {}
    for m in all_items:
        pid = m["project"]
        if pid not in proj_map:
            proj_map[pid] = {"id": pid, "name": m["project_name"], "count": 0}
        proj_map[pid]["count"] += 1
    projects = sorted(proj_map.values(), key=lambda p: p["name"].lower())

    proj_filter = project.strip()
    if proj_filter and proj_filter.upper() != "ALL":
        norm_pf = _norm_project_key(proj_filter)
        filtered = [
            m for m in all_items
            if m["project"].lower() == proj_filter.lower()
            or _norm_project_key(m["project"]) == norm_pf
            or _norm_project_key(m["project_name"]) == norm_pf
        ]
    else:
        filtered = all_items

    selected: dict[str, Any] | None = None
    sel_id = selected_id.strip()
    if sel_id:
        if sel_id in entry_by_id:
            selected = _hydrate_mockup(entry_by_id[sel_id], include_feedback=True)
    elif filtered:
        first_id = filtered[0]["id"]
        selected = _hydrate_mockup(entry_by_id[first_id], include_feedback=True)

    return {
        "mockups": filtered,
        "projects": projects,
        "selected": selected,
        "server_time": time.strftime("%H:%M:%S"),
    }


def _find_mockup_entry(
    brain_dir: Path,
    mockup_id: str,
    mockup_dirs: list[Path] | None = None,
) -> dict[str, Any] | None:
    mid = mockup_id.strip()
    if not mid:
        return None
    entries = _scan_mockup_entries(brain_dir, mockup_dirs=mockup_dirs)
    for e in entries:
        if e["id"] == mid:
            return e
    # Retry once with a fresh scan in case a newly created mockup was requested
    entries = _scan_mockup_entries(brain_dir, mockup_dirs=mockup_dirs, force=True)
    for e in entries:
        if e["id"] == mid:
            return e
    return None


def _resolve_mockup_asset(abs_dir: Path, rel_asset: str) -> tuple[int, Path | None]:
    """Strictly resolve a relative asset path inside abs_dir. Returns (status_code, path_or_None)."""
    raw = str(rel_asset or "").strip().replace("\\", "/")
    if not raw or "\x00" in raw or raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        return (int(HTTPStatus.FORBIDDEN), None)
    parts = PurePosixPath(raw).parts
    if not parts or any(part in ("..", "") for part in parts):
        return (int(HTTPStatus.FORBIDDEN), None)
    base = abs_dir.resolve()
    try:
        target = (base / raw).resolve()
    except OSError:
        return (int(HTTPStatus.FORBIDDEN), None)
    if target == base or base not in target.parents:
        return (int(HTTPStatus.FORBIDDEN), None)
    if not target.is_file():
        return (int(HTTPStatus.NOT_FOUND), None)
    return (int(HTTPStatus.OK), target)


DASHBOARD_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Antigravity Agent Visualizer</title>
<style>
  :root {
    --bg: #07090f;
    --panel: #0e131f;
    --panel-2: #141c2e;
    --border: #1e2942;
    --text: #e8effa;
    --muted: #8b9bb8;
    --lead: #a855f7;
    --thinking: #c084fc;
    --peer: #06b6d4;
    --complete: #10b981;
    --blocker: #f43f5e;
    --dispatch: #818cf8;
    --tool: #64748b;
    --warn: #f59e0b;
    --target-size: 28px;
  }
  @media (pointer: coarse) {
    :root { --target-size: 44px; }
  }
  * { box-sizing: border-box; }
  html {
    scroll-padding-bottom: calc(92px + env(safe-area-inset-bottom, 0px));
  }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
    font-size: 13px; line-height: 1.45;
    min-height: 100dvh;
    overflow-wrap: break-word;
  }
  header {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
    gap: 10px;
    padding: max(10px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) 10px max(16px, env(safe-area-inset-left, 0px));
    background: var(--panel); border-bottom: 1px solid var(--border);
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .pulse-dot {
    width: 10px; height: 10px; border-radius: 50%; background: var(--complete);
    box-shadow: 0 0 0 0 rgba(16,185,129,.7); animation: hb 2s infinite;
  }
  .pulse-dot.sim { background: var(--peer); box-shadow: 0 0 0 0 rgba(6,182,212,.7); }
  @keyframes hb {
    0% { box-shadow: 0 0 0 0 rgba(16,185,129,.65); }
    70% { box-shadow: 0 0 0 9px rgba(16,185,129,0); }
    100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
  }
  @keyframes dashFlow { to { stroke-dashoffset: -28; } }
  @keyframes nodePulse { 0%, 100% { opacity: 0.28; } 50% { opacity: 0.92; } }
  @keyframes dotBlink { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
  @keyframes scanSlide { 0% { transform: translateX(-56px); } 100% { transform: translateX(186px); } }

  h1 { margin: 0; font-size: clamp(0.9rem, 0.82rem + 0.35vw, 1rem); font-weight: 650; text-wrap: balance; }
  .sub { color: var(--muted); font-size: 11.5px; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
  button, select, .btn-link {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 7px; padding: 6px 10px; font-size: 12px; cursor: pointer;
  }
  .btn-link { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
  button:hover, select:hover, .btn-link:hover { border-color: #3e5585; color: #fff; }
  button.active { background: #1e2d4d; border-color: var(--peer); color: #fff; }
  select { max-width: 340px; }

  .pill {
    display: inline-block; padding: 1px 6px; border-radius: 99px; font-size: 10px;
    font-weight: 600; border: 1px solid var(--border); color: var(--muted);
  }
  .pill.ok, .pill.done { color: #34d399; border-color: rgba(16,185,129,.45); background: rgba(16,185,129,.12); }
  .pill.working { color: #4ade80; border-color: rgba(74,222,128,.55); background: rgba(22,163,74,.2); }
  .pill.waiting, .pill.peer { color: #22d3ee; border-color: rgba(6,182,212,.45); background: rgba(6,182,212,.12); }
  .pill.blocker { color: #fb7185; border-color: rgba(244,63,94,.5); background: rgba(244,63,94,.14); }
  .pill.dispatch { color: #a5b4fc; border-color: rgba(129,140,248,.45); background: rgba(129,140,248,.12); }
  .pill.human { color: #fcd34d; border-color: rgba(245,158,11,.5); background: rgba(245,158,11,.14); }
  .pill.tool { color: #94a3b8; border-color: rgba(148,163,184,.35); background: rgba(148,163,184,.08); }

  main {
    display: grid; grid-template-columns: 1.45fr 1fr; gap: 14px;
    padding: 12px max(16px, env(safe-area-inset-right, 0px)) 10px max(16px, env(safe-area-inset-left, 0px));
    height: calc(100vh - 144px); height: calc(100dvh - 144px); min-height: 460px;
  }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    display: flex; flex-direction: column; overflow: hidden; min-width: 0;
    container: pane / inline-size;
  }
  .card-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 13px; border-bottom: 1px solid var(--border); gap: 8px; flex-wrap: wrap;
  }
  .card-title { font-weight: 650; font-size: 13px; }
  .legend { display: flex; gap: 10px; font-size: 11px; color: var(--muted); align-items: center; flex-wrap: wrap; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .sw { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

  #graphWrap { flex: 1; position: relative; min-height: 360px; background: radial-gradient(circle at 50% 45%, #101728 0%, #080b12 72%); overflow: hidden; touch-action: none; cursor: grab; }
  #graphWrap.panning { cursor: grabbing; }
  svg#graph { width: 100%; height: 100%; display: block; user-select: none; }
  .flow-edge { animation: dashFlow 1.1s linear infinite; }
  .work-halo { animation: nodePulse 1.4s ease-in-out infinite; }
  .live-dot { animation: dotBlink 1.1s ease-in-out infinite; }
  .scan-bar { animation: scanSlide 1.5s linear infinite; }
  .agent-card { cursor: pointer; }
  .ext-edge { transition: stroke-opacity 0.16s ease, stroke-width 0.16s ease; }
  .ext-edge.ext-lit { stroke-opacity: 0.92 !important; stroke-width: 2.2 !important; }

  .topo-head-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto; }
  .topo-seg {
    display: inline-flex; background: #090e19; padding: 2px; border-radius: 8px;
    border: 1px solid var(--border); gap: 2px;
  }
  .topo-seg button {
    border: none; background: transparent; color: var(--muted);
    padding: 4px 9px; border-radius: 6px; font-size: 11px; font-weight: 650;
  }
  .topo-seg button.active { background: #1e2d4d; color: #f8fafc; }
  .zoom-bar {
    display: inline-flex; align-items: center; gap: 2px;
    background: #090e19; padding: 2px; border-radius: 8px; border: 1px solid var(--border);
  }
  .zoom-bar button, .fs-btn {
    border: none; background: transparent; color: var(--muted);
    padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 650;
  }
  .zoom-bar button:hover, .fs-btn:hover { background: #162138; color: #f8fafc; }
  .fs-btn { border: 1px solid var(--border); background: #090e19; }
  .fs-btn.active { background: #1e3a8a; border-color: #60a5fa; color: #eff6ff; }

  #paneTopology.is-fullscreen, #paneTopology:fullscreen {
    position: fixed; inset: 0; z-index: 9999;
    width: 100vw; height: 100dvh; max-width: none; max-height: none;
    border-radius: 0; border: none; background: var(--panel);
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  }
  #paneTopology.is-fullscreen #graphWrap, #paneTopology:fullscreen #graphWrap {
    min-height: 0; flex: 1;
  }

  .run-selector {
    display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px;
    padding-bottom: 7px; border-bottom: 1px solid var(--border);
  }
  .run-chip {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;
    background: #131c31; border: 1px solid #263554; color: #cbd5e1; cursor: pointer;
  }
  .run-chip:hover { border-color: #60a5fa; color: #f8fafc; }
  .run-chip.active { background: #1e3a8a; border-color: #60a5fa; color: #eff6ff; }
  .run-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }

  .summary-strip {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
    padding: 8px 13px; border-top: 1px solid var(--border); background: #0a0f1a; font-size: 11.5px;
  }
  .summary-strip b { display: block; font-size: 14px; font-family: ui-monospace, Consolas, monospace; margin-top: 1px; }

  .feed-filters { display: flex; gap: 5px; padding: 8px 11px; border-bottom: 1px solid var(--border); flex-wrap: wrap; align-items: center; }
  .feed { flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .ev {
    background: var(--panel-2); border: 1px solid var(--border); border-left: 3px solid var(--peer);
    border-radius: 7px; padding: 7px 10px; cursor: pointer;
  }
  .ev.complete { border-left-color: var(--complete); }
  .ev.blocker { border-left-color: var(--blocker); }
  .ev.dispatch { border-left-color: var(--dispatch); }
  .ev.human { border-left-color: var(--warn); }
  .ev.tool { border-left-color: var(--tool); opacity: 0.88; }
  .ev.selected { border-color: #4f6aa3; background: #1a2540; opacity: 1; }
  .ev-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 11px; }
  .ev-route { font-weight: 650; color: #f8fafc; }
  .ev-title { margin-top: 2px; color: #cbd5e1; font-size: 12px; }
  .tab-bar { display: inline-flex; gap: 4px; background: #090e19; padding: 3px; border-radius: 8px; border: 1px solid var(--border); }
  .tab-btn {
    border: none; background: transparent; color: var(--muted); padding: 4px 10px;
    border-radius: 6px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px;
  }
  .tab-btn.active { background: #1e2d4d; color: #f8fafc; }
  .tab-badge {
    padding: 0 6px; border-radius: 99px; font-size: 10px; font-weight: 700;
    background: rgba(245,158,11,.2); color: #fcd34d; border: 1px solid rgba(245,158,11,.5);
  }
  .tab-badge.err { background: rgba(244,63,94,.22); color: #fda4af; border-color: rgba(244,63,94,.55); }
  .defs-pane {
    flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .defs-summary {
    display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;
    padding: 8px 11px; border-radius: 7px; background: #0a0f1a; border: 1px solid var(--border); font-size: 11.5px; color: var(--muted);
  }
  .def-filter-banner {
    display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 7px 11px; border-radius: 7px; background: rgba(59,130,246,.12);
    border: 1px solid rgba(96,165,250,.4); font-size: 11.5px; color: #dbeafe;
  }
  .def-filter-banner button {
    padding: 3px 9px; font-size: 11px; border-radius: 6px;
    background: rgba(15,23,42,.85); border: 1px solid rgba(96,165,250,.45); color: #bfdbfe;
  }
  .def-card {
    background: var(--panel-2); border: 1px solid var(--border); border-left: 3px solid var(--muted);
    border-radius: 8px; padding: 11px 13px; display: flex; flex-direction: column; gap: 8px;
  }
  .def-card.has-warn { border-color: rgba(245,158,11,.35); }
  .def-card.has-err { border-color: rgba(244,63,94,.45); }
  .def-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
  .def-title-wrap { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .def-name { font-weight: 700; font-size: 13px; color: #f8fafc; }
  .def-id-tag {
    font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; color: #94a3b8;
    background: #090e19; border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px;
  }
  .def-path { font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; color: #94a3b8; word-break: break-all; }
  .def-desc { font-size: 11.5px; color: #cbd5e1; line-height: 1.45; }
  .def-activity {
    padding: 7px 10px; border-radius: 7px; background: #0a0f1a;
    border: 1px solid var(--border); border-left: 3px solid var(--muted);
    display: flex; flex-direction: column; gap: 3px;
  }
  .def-activity.working { border-left-color: #4ade80; background: rgba(22,163,74,.08); }
  .def-activity.thinking { border-left-color: #c084fc; background: rgba(168,85,247,.1); }
  .def-activity.blocker { border-left-color: #fb7185; background: rgba(244,63,94,.1); }
  .def-activity.done { border-left-color: #34d399; }
  .def-activity.waiting { border-left-color: #22d3ee; }
  .def-activity-top {
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
    font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em;
  }
  .def-activity-text {
    font-size: 12px; color: #f1f5f9; font-weight: 500; word-break: break-word;
  }
  .def-metrics {
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px;
  }
  .def-metric {
    background: #0a0f1a; border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 8px; display: flex; flex-direction: column; gap: 2px;
  }
  .def-metric span { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
  .def-metric b { font-size: 12.5px; font-family: ui-monospace, Consolas, monospace; color: #e2e8f0; }
  .def-tool-chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .def-tool-chip {
    font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; color: #cbd5e1;
    background: #0a0f1a; border: 1px solid var(--border); border-radius: 99px; padding: 2px 8px;
  }
  .def-tool-chip b { color: #93c5fd; margin-left: 3px; }
  .def-issues { display: flex; flex-direction: column; gap: 4px; }
  .issue-row {
    display: flex; align-items: flex-start; gap: 6px; font-size: 11px; padding: 4px 7px;
    border-radius: 6px; background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.3); color: #fde68a;
  }
  .issue-row.error { background: rgba(244,63,94,.12); border-color: rgba(244,63,94,.38); color: #fecdd3; }
  .issue-row.info { background: rgba(56,189,248,.1); border-color: rgba(56,189,248,.3); color: #bae6fd; }
  .issue-row.ok { background: rgba(16,185,129,.1); border-color: rgba(16,185,129,.3); color: #a7f3d0; }
  .def-details {
    font-size: 11.5px; color: #cbd5e1;
    background: #0a0f1a; border: 1px solid var(--border); border-radius: 7px; padding: 6px 9px;
  }
  .def-details summary {
    cursor: pointer; color: #93c5fd; font-weight: 600; user-select: none;
    list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .def-details summary::-webkit-details-marker { display: none; }
  .def-sum-left { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .def-chevron { display: inline-block; transition: transform .15s ease; font-size: 10px; color: #64748b; }
  .def-details[open] > summary .def-chevron { transform: rotate(90deg); color: #93c5fd; }
  .def-copy-btn {
    flex-shrink: 0; padding: 2px 8px; font-size: 10.5px; font-weight: 600; border-radius: 5px;
    background: #131c2e; border: 1px solid var(--border); color: #cbd5e1; cursor: pointer;
  }
  .def-copy-btn:hover { border-color: #60a5fa; color: #f8fafc; }
  .def-copy-btn.copied { border-color: rgba(16,185,129,.6); background: rgba(16,185,129,.18); color: #6ee7b7; }
  .def-details pre {
    margin: 7px 0 2px; padding: 9px 10px; border-radius: 6px; background: #070b14; border: 1px solid var(--border);
    white-space: pre-wrap; word-break: break-word; max-height: min(46dvh, 420px); min-height: 56px; overflow-y: auto;
    font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; line-height: 1.48; color: #e2e8f0;
    user-select: text; -webkit-user-select: text;
  }
  .def-log-list {
    margin-top: 7px; display: flex; flex-direction: column; gap: 5px;
    max-height: min(36dvh, 300px); overflow-y: auto;
  }
  .def-log-item {
    background: #070b14; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
    display: flex; flex-direction: column; gap: 2px; font-size: 11px;
  }
  .def-log-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; color: var(--muted); font-size: 10.5px; }
  .def-log-body { color: #e2e8f0; word-break: break-word; user-select: text; -webkit-user-select: text; }
  .inspector {
    border-top: 1px solid var(--border); padding: 9px 12px; background: #0a0f1a;
    max-height: 155px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 11.5px; white-space: pre-wrap; color: #cbd5e1;
  }
  .pending-bar {
    padding: 10px 20px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .pending-card {
    background: linear-gradient(135deg, rgba(245,158,11,.13), rgba(14,19,31,.96));
    border: 1px solid rgba(245,158,11,.48);
    border-radius: 12px;
    padding: 11px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: 0 4px 18px rgba(0,0,0,.35);
  }
  .pending-card.approval {
    background: linear-gradient(135deg, rgba(168,85,247,.14), rgba(14,19,31,.96));
    border-color: rgba(192,132,252,.52);
  }
  .pending-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .pending-head-left {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pending-badge {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: .06em;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(245,158,11,.22);
    color: #fbbf24;
    border: 1px solid rgba(245,158,11,.5);
  }
  .pending-card.approval .pending-badge {
    background: rgba(168,85,247,.22);
    color: #d8b4fe;
    border-color: rgba(192,132,252,.55);
  }
  .pending-q-text {
    font-size: 13px;
    font-weight: 600;
    color: #f8fafc;
    line-height: 1.4;
  }
  .pending-summary {
    font-size: 12px;
    color: #cbd5e1;
    line-height: 1.45;
  }
  .pending-opts {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 2px;
  }
  .pending-opt {
    font-size: 11.5px;
    color: #e2e8f0;
    background: rgba(15,23,42,.85);
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 5px 10px;
    line-height: 1.35;
  }
  .pending-opt.rec {
    border-color: rgba(74,222,128,.55);
    background: rgba(22,163,74,.14);
    color: #dcfce7;
  }
  .pending-opt-num {
    font-weight: 700;
    color: #fbbf24;
    margin-right: 6px;
  }
  .pending-card.approval .pending-opt-num { color: #d8b4fe; }
  .pending-hint {
    font-size: 11px;
    color: var(--muted);
  }
  .empty { color: var(--muted); text-align: center; padding: 34px 14px; }

  .timeline-bar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
    min-height: 76px;
    padding: 8px max(16px, env(safe-area-inset-right, 0px)) max(10px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px));
    background: linear-gradient(180deg, rgba(14,19,31,.96) 0%, #090d16 100%);
    border-top: 1px solid var(--border);
    box-shadow: 0 -8px 28px rgba(0,0,0,.45);
    display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 14px;
  }
  .tl-transport { display: flex; align-items: center; gap: 5px; }
  .tl-btn {
    height: 32px; min-width: 32px; padding: 0 9px; border-radius: 7px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 650; background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
  }
  .tl-btn.play { min-width: 40px; background: #1d4ed8; border-color: #3b82f6; color: #fff; }
  .tl-btn.play.playing { background: #0f766e; border-color: #14b8a6; }
  .tl-speed { font-family: ui-monospace, Consolas, monospace; min-width: 38px; color: #cbd5e1; }

  .tl-center { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .tl-meta-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 11px; color: var(--muted); }
  .tl-now-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 72%; color: #cbd5e1; font-weight: 500; }
  .tl-track-wrap { position: relative; height: 28px; display: flex; align-items: center; cursor: pointer; user-select: none; touch-action: none; }
  .tl-track { position: relative; width: 100%; height: 8px; border-radius: 99px; background: #172035; border: 1px solid #24324f; overflow: visible; }
  .tl-fill {
    position: absolute; left: 0; top: -1px; bottom: -1px; border-radius: 99px;
    background: linear-gradient(90deg, #06b6d4 0%, #10b981 100%);
    pointer-events: none; transition: width 70ms linear;
  }
  .tl-fill.history { background: linear-gradient(90deg, #6366f1 0%, #f59e0b 100%); }
  .tl-ticks { position: absolute; inset: 0; pointer-events: none; }
  .tl-tick { position: absolute; top: -4px; width: 3px; height: 14px; border-radius: 2px; transform: translateX(-50%); opacity: 0.92; }
  .tl-tick.tool { top: 0; height: 6px; width: 2px; opacity: 0.45; }
  .tl-tail-glow { position: absolute; right: -2px; top: -3px; width: 6px; height: 12px; border-radius: 3px; background: #10b981; box-shadow: 0 0 10px #10b981; pointer-events: none; }
  .tl-thumb {
    position: absolute; top: 50%; width: 16px; height: 16px; border-radius: 50%;
    background: #f8fafc; border: 3px solid #10b981;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 0 3px rgba(16,185,129,.25), 0 2px 8px rgba(0,0,0,.6);
    pointer-events: none; transition: left 70ms linear, transform 120ms ease;
  }
  .tl-track-wrap:hover .tl-thumb, .tl-track-wrap.dragging .tl-thumb { transform: translate(-50%, -50%) scale(1.18); }
  .tl-thumb.history { border-color: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.28), 0 2px 8px rgba(0,0,0,.6); }

  .tl-hover {
    position: absolute; bottom: 32px; transform: translateX(-50%);
    background: #0d1424; border: 1px solid #3b5280; border-radius: 7px;
    padding: 5px 9px; font-size: 11px; color: #e2e8f0; white-space: nowrap;
    box-shadow: 0 8px 22px rgba(0,0,0,.65); pointer-events: none; display: none; z-index: 60;
    max-width: 360px; overflow: hidden; text-overflow: ellipsis;
  }
  .tl-hover b { color: #38bdf8; }

  .tl-right { display: flex; align-items: center; gap: 10px; }
  .tl-timecode { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; color: #cbd5e1; text-align: right; line-height: 1.25; }
  .tl-timecode span { display: block; font-size: 10px; color: var(--muted); }
  .live-pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px;
    border-radius: 99px; font-size: 11.5px; font-weight: 700; letter-spacing: .04em;
    border: 1px solid rgba(16,185,129,.55); background: rgba(16,185,129,.16); color: #6ee7b7;
    cursor: pointer; white-space: nowrap;
  }
  .live-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px #10b981; animation: hb 1.8s infinite; }
  .live-pill.behind { border-color: rgba(245,158,11,.65); background: rgba(245,158,11,.16); color: #fcd34d; }
  .live-pill.behind .dot { background: #f59e0b; box-shadow: none; animation: none; }

  /* Session Picker Popover */
  .session-picker { position: relative; display: inline-block; }
  .session-trigger {
    display: inline-flex; align-items: center; gap: 8px; max-width: 440px; min-width: 240px;
    background: #131c31; border: 1px solid #2a3b5c; color: var(--text);
    padding: 6px 11px; border-radius: 9px; cursor: pointer; font-size: 12px; text-align: left;
  }
  .session-trigger:hover { border-color: #4f6b9a; background: #18233c; }
  .session-trigger .st-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-weight: 500; }
  .session-trigger .st-caret { color: var(--muted); font-size: 10px; flex-shrink: 0; }
  .proj-pill {
    display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 999px;
    font-size: 10px; font-weight: 700; letter-spacing: .02em; white-space: nowrap; flex-shrink: 0;
    border: 1px solid rgba(255,255,255,.14);
  }
  .sub-badge {
    display: inline-flex; align-items: center; gap: 2px; padding: 1px 6px; border-radius: 999px;
    font-size: 10px; font-weight: 700; background: rgba(245,158,11,.16); color: #fbbf24;
    border: 1px solid rgba(245,158,11,.35); white-space: nowrap; flex-shrink: 0;
  }
  .wait-badge {
    display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px; border-radius: 999px;
    font-size: 10px; font-weight: 700; background: rgba(239,68,68,.16); color: #fca5a5;
    border: 1px solid rgba(239,68,68,.42); white-space: nowrap; flex-shrink: 0;
    max-width: 190px; overflow: hidden; text-overflow: ellipsis;
  }
  .project-select {
    background: #131c31; border: 1px solid #2a3b5c; color: var(--text);
    padding: 6px 10px; border-radius: 9px; font-size: 12px; font-weight: 500;
    cursor: pointer; max-width: 180px; outline: none;
  }
  .project-select:hover, .project-select:focus { border-color: #4f6b9a; background: #18233c; }
  .session-menu {
    position: absolute; top: calc(100% + 6px); right: 0; width: 520px; max-width: 92vw;
    background: #0f172a; border: 1px solid #2b3c5e; border-radius: 12px;
    box-shadow: 0 18px 48px rgba(0,0,0,.65); z-index: 60; display: none; flex-direction: column;
    overflow: hidden;
  }
  .session-menu.open { display: flex; }
  .session-menu-head {
    padding: 10px 12px; border-bottom: 1px solid var(--border); background: #0c1324;
    display: flex; flex-direction: column; gap: 8px;
  }
  .session-search-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .session-search {
    flex: 1 1 160px; min-width: 0; background: #131c31; border: 1px solid #263554; color: var(--text);
    padding: 7px 10px; border-radius: 8px; font-size: 12px; outline: none;
  }
  .session-search:focus { border-color: #60a5fa; }
  .session-multi-btn {
    padding: 6px 10px; border-radius: 8px; font-size: 11px; font-weight: 600;
    background: #131c31; border: 1px solid #263554; color: var(--muted); cursor: pointer; white-space: nowrap;
  }
  .session-multi-btn.active { background: rgba(245,158,11,.18); border-color: rgba(245,158,11,.5); color: #fbbf24; }
  .session-multi-btn.active-filter { background: rgba(59,130,246,.2); border-color: rgba(96,165,250,.55); color: #93c5fd; }
  .session-proj-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
  .proj-tab {
    padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600;
    background: #131c31; border: 1px solid #263554; color: var(--muted); cursor: pointer;
  }
  .proj-tab:hover { border-color: #4f6b9a; color: var(--text); }
  .proj-tab.active { background: #1e3a8a; border-color: #60a5fa; color: #eff6ff; }
  .session-list { max-height: 420px; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
  .session-item {
    display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid transparent; background: transparent; color: var(--text);
    cursor: pointer; text-align: left; width: 100%;
  }
  .session-item:hover { background: #162138; border-color: #283a5e; }
  .session-item.active { background: #172554; border-color: #3b82f6; }
  .session-item-top { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .session-item-time { margin-left: auto; color: var(--muted); font-size: 10.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .session-item-title { font-size: 12.5px; font-weight: 500; color: #e2e8f0; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-empty { padding: 24px 12px; text-align: center; color: var(--muted); font-size: 12px; }

  /* Mobile segmented view switcher (shown on cover screen / < 640px) */
  .mobile-nav {
    display: none;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    padding: 6px max(10px, env(safe-area-inset-right, 0px)) 6px max(10px, env(safe-area-inset-left, 0px));
    background: #0a0f1a;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .mobile-nav-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 36px; padding: 6px 8px; border-radius: 8px;
    font-size: 12px; font-weight: 650; color: var(--muted);
    background: var(--panel); border: 1px solid var(--border);
  }
  .mobile-nav-btn.active {
    background: #1e2d4d; border-color: var(--peer); color: #f8fafc;
  }

  /* Component-driven adaptation via container queries */
  @container pane (inline-size < 420px) {
    .summary-strip { grid-template-columns: repeat(2, 1fr); gap: 6px; padding: 7px 10px; }
    .def-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .card-head { padding: 8px 10px; }
    .legend { gap: 7px; font-size: 10.5px; }
  }

  /* Touch-friendly sizing on coarse pointers (phones & foldables) */
  @media (pointer: coarse) {
    .tl-btn { min-height: 40px; min-width: 40px; }
    .tl-btn.play { min-width: 46px; }
    .live-pill { min-height: 40px; padding: 6px 12px; }
    .tl-track-wrap { height: 36px; }
    .tl-thumb { width: 20px; height: 20px; }
    .session-trigger, .project-select, .controls > button { min-height: 40px; }
    .session-multi-btn, .session-search { min-height: 40px; }
    .proj-tab { min-height: 36px; padding: 5px 11px; }
    .mobile-nav-btn { min-height: var(--target-size); }
    .feed-filters button { min-height: 34px; padding: 5px 11px; }
    .def-details summary { min-height: 36px; }
    .def-copy-btn { min-height: 34px; padding: 4px 12px; font-size: 11.5px; }
    .topo-seg button, .zoom-bar button, .fs-btn { min-height: 36px; padding: 5px 10px; font-size: 12px; }
    .run-chip { min-height: 34px; padding: 4px 10px; }
    .tl-hint { display: none; }
  }

  /* Foldable Open / Tablet (640px – 1020px, e.g. Galaxy Z Fold 7 unfolded ~700–840px) */
  @media (max-width: 1020px) and (min-width: 640px) {
    body { display: flex; flex-direction: column; height: 100dvh; }
    header { padding: max(8px, env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) 8px max(12px, env(safe-area-inset-left, 0px)); gap: 8px; }
    .brand .sub { max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .session-trigger { min-width: 160px; max-width: 260px; }
    main {
      flex: 1; min-height: 0; height: auto;
      grid-template-columns: 1fr 1fr; gap: 12px;
      padding: 10px max(12px, env(safe-area-inset-right, 0px)) calc(84px + env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px));
    }
    #graphWrap { min-height: 220px; }
    .inspector { max-height: 128px; }
    .tl-hint { display: none; }
    .timeline-bar { gap: 10px; min-height: 68px; padding-top: 6px; }
    .tl-now-label { max-width: 100%; }
  }

  /* Dual-screen / Hinge-aware split when browser exposes Viewport Segments API */
  @media (horizontal-viewport-segments: 2) {
    main {
      grid-template-columns: env(viewport-segment-width 0 0) env(viewport-segment-width 1 0);
      gap: max(12px, calc(env(viewport-segment-left 1 0) - env(viewport-segment-right 0 0)));
    }
  }

  /* Compact / Cover Screen (< 640px, e.g. Galaxy Z Fold 7 closed ~360–412px) */
  @media (max-width: 639px) {
    body { display: flex; flex-direction: column; height: 100dvh; }
    header {
      padding: max(8px, env(safe-area-inset-top, 0px)) max(10px, env(safe-area-inset-right, 0px)) 8px max(10px, env(safe-area-inset-left, 0px));
      gap: 7px;
    }
    .brand { width: 100%; gap: 8px; }
    .brand .sub { display: none; }
    .controls { width: 100%; gap: 6px; }
    .controls > button { padding: 6px 10px; font-size: 12px; }
    .project-select { flex: 1 1 120px; max-width: none; min-width: 0; }
    .session-picker { flex: 1 1 100%; min-width: 0; }
    .session-trigger { min-width: 0; width: 100%; max-width: none; }
    .session-proj-tabs { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
    .session-proj-tabs .proj-tab { flex-shrink: 0; }
    .session-menu {
      position: fixed;
      left: max(8px, env(safe-area-inset-left, 0px));
      right: max(8px, env(safe-area-inset-right, 0px));
      top: auto;
      bottom: calc(114px + env(safe-area-inset-bottom, 0px));
      width: auto; max-width: none; max-height: 62dvh;
    }

    .mobile-nav { display: grid; }
    .pending-bar { padding: 8px 10px 0; }

    main {
      flex: 1; min-height: 0; height: auto;
      display: flex; flex-direction: column; gap: 0;
      padding: 8px max(10px, env(safe-area-inset-right, 0px)) calc(112px + env(safe-area-inset-bottom, 0px)) max(10px, env(safe-area-inset-left, 0px));
    }
    main[data-mobile-pane="topology"] #paneStream { display: none; }
    main:not([data-mobile-pane="topology"]) #paneTopology { display: none; }
    #paneTopology, #paneStream { flex: 1; min-height: 0; }
    #paneStream .tab-bar { display: none; }

    #graphWrap {
      min-height: 0; flex: 1;
      overflow: hidden;
    }
    svg#graph { width: 100%; height: 100%; }
    .legend { display: none; }

    .feed-filters {
      flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch;
      scrollbar-width: none; padding: 7px 9px;
    }
    .feed-filters::-webkit-scrollbar { display: none; }
    .feed-filters button { flex-shrink: 0; white-space: nowrap; }
    .inspector { max-height: 112px; font-size: 11px; padding: 8px 10px; }

    .timeline-bar {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-areas:
        "center center"
        "transport right";
      gap: 4px 8px;
      min-height: 102px;
      padding: 6px max(10px, env(safe-area-inset-right, 0px)) max(8px, env(safe-area-inset-bottom, 0px)) max(10px, env(safe-area-inset-left, 0px));
    }
    .tl-center { grid-area: center; gap: 2px; }
    .tl-transport { grid-area: transport; gap: 4px; }
    .tl-right { grid-area: right; gap: 6px; justify-content: flex-end; }
    .tl-hint { display: none; }
    .tl-now-label { max-width: 100%; font-size: 11px; }
    .tl-timecode { font-size: 10.5px; }
    .tl-timecode span { display: none; }
    .tl-btn { padding: 0 7px; font-size: 11.5px; }
    .live-pill { padding: 5px 9px; font-size: 11px; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">
    <span id="statusDot" class="pulse-dot"></span>
    <div>
      <h1>Antigravity Agent Visualizer</h1>
      <div id="statusSub" class="sub">Connecting to live Antigravity transcripts…</div>
    </div>
  </div>
  <div class="controls">
    <button id="btnLive" class="active">Live Session</button>
    <button id="btnSim">Demo Sprint</button>
    <select id="projectFilterSelect" class="project-select" aria-label="Filter sessions by project" title="Filter sessions by project">
      <option value="ALL">All Projects</option>
    </select>
    <div id="sessionPickerWrap" class="session-picker">
      <button id="sessionPickerBtn" class="session-trigger" type="button" title="Switch Antigravity session">
        <span class="st-label">Loading sessions…</span>
        <span class="st-caret">▾</span>
      </button>
      <div id="sessionPickerMenu" class="session-menu" role="dialog" aria-label="Select session">
        <div class="session-menu-head">
          <div class="session-search-row">
            <input id="sessionSearch" class="session-search" type="search" placeholder="Search chats, projects, or session ID…" autocomplete="off" />
            <button id="btnHideCompleted" class="session-multi-btn" type="button" aria-pressed="false" title="Hide completed sessions that are not waiting">Active / Waiting</button>
            <button id="btnMultiOnly" class="session-multi-btn active" type="button" aria-pressed="true" title="Show multi-agent sessions only">★ Multi-agent</button>
          </div>
          <div id="sessionProjTabs" class="session-proj-tabs"></div>
        </div>
        <div id="sessionList" class="session-list"></div>
      </div>
    </div>
    <button id="btnClearNode" style="display:none;">All Agents</button>
    <a id="livePreviewLink" class="btn-link" href="/preview" title="Open Live Design Mockup Preview Studio">Live Preview</a>
    <a id="linkDevOpsBoard" class="btn-link" href="http://127.0.0.1:8766/#board" target="_top" title="Open Agile Mod DevOps Board">DevOps Board ↗</a>
  </div>
</header>

<section id="pendingPrompts" class="pending-bar" style="display:none;"></section>

<nav class="mobile-nav" id="mobileNav" aria-label="View switcher">
  <button id="mobTabTopo" class="mobile-nav-btn active" type="button">Topology</button>
  <button id="mobTabStream" class="mobile-nav-btn" type="button">Live Stream</button>
  <button id="mobTabDefs" class="mobile-nav-btn" type="button">Details <span id="defIssueBadgeMobile" class="tab-badge" style="display:none;">0</span></button>
</nav>

<main id="mainGrid" data-mobile-pane="topology">
  <section id="paneTopology" class="card">
    <div class="card-head">
      <span class="card-title">Live Agent Activity & Mesh Topology</span>
      <div class="topo-head-right">
        <div class="topo-seg" role="group" aria-label="Topology view mode">
          <button id="btnViewGrouped" type="button" class="active" title="Collapse repeated invocations by role">Grouped</button>
          <button id="btnViewAll" type="button" title="Show every individual agent run">All Runs</button>
        </div>
        <div class="zoom-bar" role="group" aria-label="Zoom controls">
          <button id="btnZoomOut" type="button" title="Zoom out" aria-label="Zoom out">−</button>
          <button id="btnZoomFit" type="button" title="Fit topology to view" aria-label="Fit to view">Fit</button>
          <button id="btnZoomIn" type="button" title="Zoom in" aria-label="Zoom in">+</button>
        </div>
        <button id="btnFullscreen" class="fs-btn" type="button" aria-pressed="false" title="Toggle fullscreen topology">⛶ Fullscreen</button>
      </div>
      <div class="legend" style="width:100%;">
        <span><i class="sw" style="background:#f59e0b" aria-hidden="true"></i>Human</span>
        <span><i class="sw" style="background:#c084fc" aria-hidden="true"></i>Thinking</span>
        <span><i class="sw" style="background:var(--complete)" aria-hidden="true"></i>Working / Done</span>
        <span><i class="sw" style="background:var(--peer)" aria-hidden="true"></i>Peer-to-Peer</span>
        <span><i class="sw" style="background:#38bdf8" aria-hidden="true"></i>External</span>
        <span><i class="sw" style="background:var(--blocker)" aria-hidden="true"></i>Blocker</span>
      </div>
    </div>
    <div id="graphWrap" role="region" tabindex="0" aria-label="Agent topology mesh">
      <svg id="graph" viewBox="0 0 880 480" preserveAspectRatio="xMidYMid meet"></svg>
    </div>
    <div class="summary-strip">
      <div><span class="sub">Active / Agents</span><b id="statActive">0</b></div>
      <div><span class="sub">Total Tool Calls</span><b id="statTools">0</b></div>
      <div><span class="sub">Peer Messages</span><b id="statPeer" style="color:var(--peer)">0</b></div>
      <div><span class="sub">Completions</span><b id="statOrch" style="color:var(--complete)">0</b></div>
    </div>
  </section>

  <section id="paneStream" class="card">
    <div class="card-head">
      <div class="tab-bar">
        <button id="tabStream" class="tab-btn active">Live Stream</button>
        <button id="tabDefs" class="tab-btn">Agent Details <span id="defIssueBadge" class="tab-badge" style="display:none;">0</span></button>
      </div>
      <div id="streamHeadControls" style="display:flex;gap:6px;align-items:center;">
        <button id="btnShowTools" class="active" style="padding:3px 8px;font-size:11px;">+ Tool Calls</button>
        <span id="eventCount" class="pill">0 items</span>
      </div>
    </div>
    <div class="feed-filters" id="filterBar">
      <button class="active" data-f="all">All</button>
      <button data-f="human">Human</button>
      <button data-f="peer">Peer-to-Peer</button>
      <button data-f="complete">Completions</button>
      <button data-f="blocker">Blockers</button>
      <button data-f="dispatch">Dispatch</button>
      <button data-f="tool">Tools</button>
    </div>
    <div class="feed" id="feed"></div>
    <div class="defs-pane" id="defsPane" style="display:none;"></div>
    <div class="inspector" id="inspector">Click any agent card, stream item, or scrub the timeline below to inspect.</div>
  </section>
</main>

<footer class="timeline-bar" id="timelineBar">
  <div class="tl-transport">
    <button id="tlStart" class="tl-btn" type="button" title="Jump to start (Home)" aria-label="Jump to start">⏮</button>
    <button id="tlPrev" class="tl-btn" type="button" title="Previous event (←)" aria-label="Previous event">◀</button>
    <button id="tlPlay" class="tl-btn play" type="button" title="Play / Pause replay (Space)" aria-label="Play or pause replay">▶</button>
    <button id="tlNext" class="tl-btn" type="button" title="Next event (→)" aria-label="Next event">▶|</button>
    <button id="tlSpeed" class="tl-btn tl-speed" type="button" title="Playback speed" aria-label="Playback speed">1×</button>
  </div>

  <div class="tl-center">
    <div class="tl-meta-row">
      <span id="tlNowLabel" class="tl-now-label">Connecting to timeline…</span>
      <span class="tl-hint" style="font-size:10.5px;">Drag track to scrub · Space play/pause · ←/→ step · L live</span>
    </div>
    <div id="tlTrackWrap" class="tl-track-wrap">
      <div id="tlHover" class="tl-hover"></div>
      <div class="tl-track">
        <div id="tlFill" class="tl-fill" style="width:100%;"></div>
        <div id="tlTicks" class="tl-ticks"></div>
        <div id="tlTailGlow" class="tl-tail-glow" title="Live edge"></div>
        <div id="tlThumb" class="tl-thumb" style="left:100%;"></div>
      </div>
    </div>
  </div>

  <div class="tl-right">
    <div class="tl-timecode">
      <div id="tlClock">00:00 / 00:00</div>
      <span id="tlFrames">0 / 0 events</span>
    </div>
    <button id="tlLiveBtn" class="live-pill" title="Snap to live tail (L)">
      <span class="dot"></span><span id="tlLiveText">LIVE</span>
    </button>
  </div>
</footer>

<script>
const SIM_AGENTS = [
  { id: "human", label: "Human", role: "User / Prompt Source", color: "#f59e0b", node_type: "human", is_root: false },
  { id: "coordinator", label: "Coordinator", role: "Lead Orchestrator", color: "#a855f7", node_type: "agent", is_root: true },
  { id: "researcher", label: "Researcher", role: "Codebase Explorer", color: "#06b6d4", node_type: "agent", is_root: false },
  { id: "architect", label: "Architect", role: "Design & Spec", color: "#ec4899", node_type: "agent", is_root: false },
  { id: "implementer", label: "Implementer", role: "Feature Engineer", color: "#3b82f6", node_type: "agent", is_root: false },
  { id: "verifier", label: "Verifier", role: "Tests & QA Gate", color: "#10b981", node_type: "agent", is_root: false },
  { id: "ext:fs", label: "Workspace FS", role: "Local Filesystem", color: "#64748b", node_type: "external", is_root: false },
  { id: "ext:shell", label: "Local Shell", role: "OS / Terminal Runtime", color: "#f97316", node_type: "external", is_root: false }
];

const SIM_DEFINITIONS = [
  {
    id: "coordinator", label: "Coordinator", role: "Lead Orchestrator", color: "#a855f7", is_root: true, in_session: true,
    state: "working", source_path: "~/.gemini/config/plugins/core/agents/coordinator.md", def_tokens: 620,
    def_preview: "You are the Lead Coordinator. Decompose tasks, spawn specialist subagents with full file paths and acceptance criteria, and synthesize results for the Human.",
    spawn_prompt: "", spawn_chars: 0, context_tokens: 4800, steps: 14, tool_calls: 6, issues: []
  },
  {
    id: "researcher", label: "Researcher", role: "Codebase Explorer", color: "#06b6d4", is_root: false, in_session: true,
    state: "done", source_path: "", def_tokens: 0, def_preview: "",
    spawn_prompt: "Map target modules and interfaces before design.", spawn_chars: 46, context_tokens: 3200, steps: 8, tool_calls: 5,
    issues: [
      { level: "warn", code: "NO_DEF_FILE", label: "No .md Definition", detail: "Spawned without a matching agent definition file; relies solely on ad-hoc spawn prompt." },
      { level: "warn", code: "THIN_HANDOFF", label: "Thin Handoff Prompt", detail: "Spawn prompt is only 46 chars — may lack file paths, constraints, or acceptance criteria." }
    ]
  },
  {
    id: "implementer", label: "Implementer", role: "Feature Engineer", color: "#3b82f6", is_root: false, in_session: true,
    state: "done", source_path: "~/.gemini/config/plugins/core/agents/implementer.md", def_tokens: 940,
    def_preview: "Apply minimal surgical edits according to the Architecture Spec. Verify compilation and unit tests before handing off to Verifier.",
    spawn_prompt: "Implement changes in core_module.py according to the finalized spec from Architect, guard empty inputs, and add regression tests.",
    spawn_chars: 130, context_tokens: 11200, steps: 19, tool_calls: 11, issues: []
  }
];

const SIM_SCRIPT = [
  { from: "human", to: "coordinator", kind: "human", title: "Human: Add parser guard and verify with tests", body: "Please add an empty-input guard to core_module.py and run full QA." },
  { from: "coordinator", to: "researcher", kind: "dispatch", title: "Spawned Codebase Explorer", body: "Map target modules and interfaces before design." },
  { from: "researcher", to: "ext:fs", kind: "tool", title: "Read: core_module.py", body: "Scanned parser entry points." },
  { from: "coordinator", to: "architect", kind: "dispatch", title: "Spawned Design & Spec", body: "Draft design spec in coordination with Researcher." },
  { from: "researcher", to: "architect", kind: "peer", title: "Peer handoff: verified module entry points", body: "Shared verified symbol list directly to Architect." },
  { from: "architect", to: "coordinator", kind: "complete", title: "COMPLETE: Architecture spec ready", body: "Spec finalized and cross-checked with Researcher." },
  { from: "coordinator", to: "implementer", kind: "dispatch", title: "Spawned Feature Engineer", body: "Implement changes according to spec." },
  { from: "implementer", to: "ext:fs", kind: "tool", title: "Edit: core_module.py", body: "Applied implementation changes." },
  { from: "implementer", to: "coordinator", kind: "complete", title: "COMPLETE: Implementation ready for QA", body: "All unit checks compiled cleanly." },
  { from: "coordinator", to: "verifier", kind: "dispatch", title: "Spawned Tests & QA Gate", body: "Run full test suite and report defects directly to Implementer." },
  { from: "verifier", to: "ext:shell", kind: "tool", title: "Run: pytest tests/", body: "Executed full regression suite." },
  { from: "verifier", to: "implementer", kind: "blocker", title: "QA FAIL: edge case in parser", body: "Empty input throws KeyError — please guard and re-verify." },
  { from: "implementer", to: "verifier", kind: "peer", title: "Fix pushed -> ready for Round 2 QA", body: "Added guard and regression test." },
  { from: "verifier", to: "coordinator", kind: "complete", title: "COMPLETE: All checks PASS", body: "0 failures, ready for release." },
  { from: "coordinator", to: "human", kind: "human", title: "-> Human: Guard added and all tests PASS", body: "Parser guard implemented and verified with 0 failures." }
];

const CARD_W = 186, CARD_H = 84;
const EXT_W = 152, EXT_H = 46;
let mode = "live";
let rightTab = "stream";
let filterKind = "all";
let showTools = true;
let selectedNode = null;
let selectedGroup = null;
let hoveredNode = null;
let topoView = (typeof localStorage !== "undefined" && localStorage.getItem("av_topo_view")) === "all" ? "all" : "grouped";
let viewState = { x: 0, y: 0, w: 880, h: 480, baseW: 880, baseH: 480, userModified: false };
let currentNodeToGroup = {};
let currentGroupMembers = {};
const openDefSections = new Set();
let lastDefsRenderKey = "";
let defsRenderDeferred = false;

function hasActiveSelectionIn(el) {
  if (!el || !window.getSelection) return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return false;
  const a = sel.anchorNode, f = sel.focusNode;
  return Boolean((a && el.contains(a)) || (f && el.contains(f)));
}

function copyTextWithFeedback(text, btn) {
  const done = () => {
    if (!btn) return;
    const prev = btn.dataset.origLabel || btn.textContent;
    btn.dataset.origLabel = prev;
    btn.textContent = "✓ Copied";
    btn.classList.add("copied");
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      btn.textContent = btn.dataset.origLabel || "Copy";
      btn.classList.remove("copied");
    }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
      done();
    });
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
    done();
  }
}

document.addEventListener("selectionchange", () => {
  if (!defsRenderDeferred || rightTab !== "defs") return;
  const pane = document.getElementById("defsPane");
  if (!hasActiveSelectionIn(pane)) {
    defsRenderDeferred = false;
    renderDefinitions(true);
  }
});
let selectedEventId = null;
let liveState = null;
let sse = null;
let seenEventIds = new Set();

let playhead = 0;
let liveTail = true;
let playTimer = null;
const SPEEDS = [1, 2, 4];
let speedIdx = 0;
let isDragging = false;
let lastTicksSig = "";

function colorForKind(k) {
  return { human: "#f59e0b", peer: "#06b6d4", complete: "#10b981", blocker: "#f43f5e", dispatch: "#818cf8", tool: "#64748b" }[k] || "#94a3b8";
}
function stateStyle(st) {
  return {
    thinking:{ label: "THINKING", fill: "#3b1764", stroke: "#c084fc", text: "#f3e8ff" },
    working: { label: "WORKING",  fill: "#14532d", stroke: "#4ade80", text: "#86efac" },
    done:    { label: "DONE",     fill: "#064e3b", stroke: "#10b981", text: "#6ee7b7" },
    waiting: { label: "WAITING",  fill: "#0c4a6e", stroke: "#38bdf8", text: "#7dd3fc" },
    blocker: { label: "BLOCKED",  fill: "#7f1d1d", stroke: "#f43f5e", text: "#fda4af" },
    idle:    { label: "IDLE",     fill: "#1e293b", stroke: "#475569", text: "#94a3b8" }
  }[st] || { label: "IDLE", fill: "#1e293b", stroke: "#475569", text: "#94a3b8" };
}
function fmtAge(sec) {
  if (sec == null) return "—";
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  return `${Math.floor(sec/3600)}h ago`;
}
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function fmtTs(ts) {
  if (!ts) return "";
  if (ts.includes("T")) {
    const d = new Date(ts);
    if (!isNaN(d)) return d.toLocaleTimeString([], { hour12: false });
  }
  return ts;
}
function trunc(s, n) { return !s ? "" : (s.length > n ? s.slice(0, n - 1) + "…" : s); }

function getRoster() {
  if (mode === "sim") return SIM_AGENTS;
  if (!liveState || !liveState.agents) return [];
  const order = liveState.agent_order || Object.keys(liveState.agents);
  return order.map(id => liveState.agents[id]).filter(Boolean);
}

function roleKeyFor(a) {
  if (a.node_type === "human" || a.id === "human") return "human";
  if (a.node_type === "external") return a.id;
  if (a.is_root) return "root:" + a.id;
  const base = String(a.label || a.role || a.id).replace(/\s*(?:#\d+|\(\d+\))$/, "").trim().toLowerCase();
  return "role:" + (base || a.id);
}

function statePriority(st) {
  return { thinking: 6, working: 5, blocker: 4, waiting: 3, done: 2, idle: 1 }[st] || 0;
}

function buildGraphModel(roster, states, counts) {
  const nodeToGroup = {};
  const groupMembers = {};
  if (topoView !== "grouped") {
    const nodes = roster.map(a => {
      nodeToGroup[a.id] = a.id;
      groupMembers[a.id] = [a.id];
      const info = states[a.id] || a;
      return { ...a, ...info, id: a.id, is_group: false, run_count: 1, members: [a.id], primary_id: a.id };
    });
    return { nodes, edges: { ...counts }, nodeToGroup, groupMembers };
  }

  const groupOrder = [];
  const groups = {};
  roster.forEach(a => {
    const isSpecial = a.node_type === "human" || a.id === "human" || a.node_type === "external" || a.is_root;
    const gid = isSpecial ? a.id : roleKeyFor(a);
    nodeToGroup[a.id] = gid;
    if (!groups[gid]) {
      groups[gid] = { id: gid, base: a, isSpecial, members: [] };
      groupOrder.push(gid);
    }
    groups[gid].members.push(a);
  });

  const nodes = groupOrder.map(gid => {
    const g = groups[gid];
    const memberIds = g.members.map(m => m.id);
    groupMembers[gid] = memberIds;
    if (g.isSpecial || g.members.length === 1) {
      const m = g.members[0];
      const info = states[m.id] || m;
      return {
        ...m, ...info, id: gid,
        is_group: !g.isSpecial, run_count: 1,
        members: memberIds, primary_id: m.id
      };
    }
    let primary = g.members[g.members.length - 1];
    let bestPrio = -1;
    let totalSteps = 0, totalTools = 0, totalSent = 0, totalRecv = 0;
    let bestAge = null;
    g.members.forEach(m => {
      const info = states[m.id] || m;
      const p = statePriority(info.state);
      if (p >= bestPrio) { bestPrio = p; primary = m; }
      totalSteps += info.steps || 0;
      totalTools += info.tool_calls || 0;
      totalSent += info.msg_sent || 0;
      totalRecv += info.msg_recv || 0;
      if (info.age_sec != null && (bestAge == null || info.age_sec < bestAge)) bestAge = info.age_sec;
    });
    const pInfo = states[primary.id] || primary;
    const cleanLabel = String(primary.label || g.base.label || gid).replace(/\s*(?:#\d+|\(\d+\))$/, "").trim();
    return {
      ...g.base,
      ...pInfo,
      id: gid,
      label: cleanLabel || g.base.label,
      steps: totalSteps,
      tool_calls: totalTools,
      msg_sent: totalSent,
      msg_recv: totalRecv,
      age_sec: bestAge,
      is_group: true,
      run_count: g.members.length,
      members: memberIds,
      primary_id: primary.id
    };
  });

  const mergedEdges = {};
  Object.entries(counts || {}).forEach(([pairKey, cnt]) => {
    const [aId, bId] = pairKey.split("|");
    const ga = nodeToGroup[aId] || aId;
    const gb = nodeToGroup[bId] || bId;
    if (!ga || !gb || ga === gb) return;
    const mk = [ga, gb].sort().join("|");
    mergedEdges[mk] = (mergedEdges[mk] || 0) + (cnt || 0);
  });

  return { nodes, edges: mergedEdges, nodeToGroup, groupMembers };
}

function layoutNodes(nodes) {
  // Strict non-overlapping dynamic layout with Active vs Completed tiering for 1..20+ agents
  const map = {};
  if (!nodes.length) return { map, worldW: 880, worldH: 480, completedY: null, extY: null };

  const GAP_X = 28, GAP_Y = 34, PAD_X = 44, PAD_TOP = 26, PAD_BOT = 28;
  const STEP_X = CARD_W + GAP_X;
  const STEP_Y = CARD_H + GAP_Y;
  const MAX_COLS = 5;

  const human = nodes.find(a => a.node_type === "human" || a.id === "human");
  const externals = nodes.filter(a => a.node_type === "external");
  const agents = nodes.filter(a => a.node_type !== "human" && a.node_type !== "external" && a.id !== "human");
  const root = agents.find(a => a.is_root) || agents[0];
  const others = root ? agents.filter(a => a.id !== root.id) : [];

  const splitActiveDone = others.length > 4;
  const isCompleted = (a) => a.state === "done" || a.state === "idle";
  const activeTier = splitActiveDone ? others.filter(a => !isCompleted(a)) : others;
  const doneTier = splitActiveDone ? others.filter(a => isCompleted(a)) : [];

  const maxAgentCols = Math.max(
    human && root ? 2 : 1,
    Math.min(MAX_COLS, Math.max(activeTier.length, doneTier.length, 1))
  );
  const extCols = Math.min(6, externals.length);
  const contentW = Math.max(
    880 - PAD_X * 2,
    maxAgentCols * CARD_W + Math.max(0, maxAgentCols - 1) * GAP_X,
    extCols * EXT_W + Math.max(0, extCols - 1) * 20
  );
  const worldW = Math.round(contentW + PAD_X * 2);
  const centerX = worldW / 2;

  const topY = PAD_TOP + CARD_H / 2;
  if (human && root) {
    map[human.id] = { ...human, x: Math.round(centerX - STEP_X * 0.85), y: topY };
    map[root.id] = { ...root, x: Math.round(centerX + STEP_X * 0.35), y: topY };
  } else if (human) {
    map[human.id] = { ...human, x: Math.round(centerX), y: topY };
  } else if (root) {
    map[root.id] = { ...root, x: Math.round(centerX), y: topY };
  }

  let cursorY = topY + CARD_H / 2 + 44;

  const placeRows = (arr, isMutedRail) => {
    if (!arr.length) return;
    const cols = Math.min(MAX_COLS, arr.length);
    for (let i = 0; i < arr.length; i += cols) {
      const row = arr.slice(i, i + cols);
      const rowW = row.length * CARD_W + (row.length - 1) * GAP_X;
      const startX = centerX - rowW / 2 + CARD_W / 2;
      const cy = Math.round(cursorY + CARD_H / 2);
      row.forEach((a, idx) => {
        map[a.id] = { ...a, x: Math.round(startX + idx * STEP_X), y: cy, _mutedRail: Boolean(isMutedRail) };
      });
      cursorY += STEP_Y;
    }
  };

  if (activeTier.length > 0) {
    placeRows(activeTier, false);
  }

  let completedY = null;
  if (doneTier.length > 0) {
    if (activeTier.length > 0) {
      completedY = Math.round(cursorY - GAP_Y / 2 + 6);
      cursorY += 26;
    }
    placeRows(doneTier, true);
  }

  let extY = null;
  if (externals.length > 0) {
    extY = Math.round(cursorY + 6);
    cursorY = extY + 24;
    const eCols = Math.min(6, externals.length);
    for (let i = 0; i < externals.length; i += eCols) {
      const row = externals.slice(i, i + eCols);
      const eGap = 20;
      const rowW = row.length * EXT_W + (row.length - 1) * eGap;
      const startX = centerX - rowW / 2 + EXT_W / 2;
      const cy = Math.round(cursorY + EXT_H / 2);
      row.forEach((e, idx) => {
        map[e.id] = { ...e, x: Math.round(startX + idx * (EXT_W + eGap)), y: cy };
      });
      cursorY += EXT_H + 18;
    }
  }

  const worldH = Math.max(480, Math.round(cursorY + PAD_BOT));
  return { map, worldW, worldH, completedY, extY };
}

function applyViewBox() {
  const svg = document.getElementById("graph");
  if (!svg) return;
  svg.setAttribute("viewBox", `${viewState.x.toFixed(1)} ${viewState.y.toFixed(1)} ${viewState.w.toFixed(1)} ${viewState.h.toFixed(1)}`);
}

function fitGraph() {
  viewState.x = 0;
  viewState.y = 0;
  viewState.w = viewState.baseW;
  viewState.h = viewState.baseH;
  viewState.userModified = false;
  applyViewBox();
}

function zoomBy(factor, cxFrac = 0.5, cyFrac = 0.5) {
  const minW = viewState.baseW * 0.28;
  const maxW = viewState.baseW * 3.0;
  const nextW = Math.max(minW, Math.min(maxW, viewState.w * factor));
  const actualFactor = nextW / viewState.w;
  const nextH = viewState.h * actualFactor;
  viewState.x += (viewState.w - nextW) * cxFrac;
  viewState.y += (viewState.h - nextH) * cyFrac;
  viewState.w = nextW;
  viewState.h = nextH;
  viewState.userModified = true;
  applyViewBox();
}

function updateExternalEdgeHighlight() {
  const svg = document.getElementById("graph");
  if (!svg) return;
  const activeKey = hoveredNode || selectedGroup || (selectedNode ? (currentNodeToGroup[selectedNode] || selectedNode) : null);
  svg.querySelectorAll(".ext-edge").forEach(el => {
    const hit = activeKey && (el.dataset.a === activeKey || el.dataset.b === activeKey);
    el.classList.toggle("ext-lit", Boolean(hit));
  });
}

function renderInspectorForNode(nodeId, groupId = null) {
  const insp = document.getElementById("inspector");
  if (!insp) return;
  const states = getAgentStates();
  const members = (groupId && currentGroupMembers[groupId]) ? currentGroupMembers[groupId] : null;

  if (members && members.length > 1) {
    const activeMemberId = nodeId && members.includes(nodeId) ? nodeId : null;
    const chipsHtml = [
      `<button type="button" class="run-chip ${!activeMemberId ? "active" : ""}" data-run="__all__">All ${members.length} runs</button>`,
      ...members.map((mid, idx) => {
        const mInfo = states[mid] || { id: mid, state: "idle", steps: 0 };
        const st = stateStyle(mInfo.state);
        return `<button type="button" class="run-chip ${activeMemberId === mid ? "active" : ""}" data-run="${escHtml(mid)}" title="${escHtml(mInfo.action || "")}"><i class="run-dot" style="background:${st.stroke}"></i>Run #${idx + 1} · ${st.label} (${mInfo.steps || 0})</button>`;
      })
    ].join("");

    let bodyText = "";
    if (activeMemberId) {
      const info = states[activeMemberId] || { id: activeMemberId, state: "idle" };
      const st = stateStyle(info.state);
      const lines = (info.recent_actions || []).slice(-5).map(r => `  ${fmtTs(r.ts)} · ${r.text}`).join("\n");
      bodyText = `${activeMemberId} [${st.label}]\nRole: ${info.role || ""}\nCurrent: ${info.action || ""}\nSteps: ${info.steps || 0} · Tools: ${info.tool_calls || 0} · Sent/Recv: ${info.msg_sent || 0}/${info.msg_recv || 0} · Last: ${fmtAge(info.age_sec)}` +
        (lines ? `\n\nRecent actions:\n${lines}` : "");
    } else {
      const summaryLines = members.map((mid, idx) => {
        const m = states[mid] || { state: "idle", steps: 0, tool_calls: 0, action: "" };
        return `  Run #${idx + 1} [${stateStyle(m.state).label}] ${m.steps || 0} steps · ${m.tool_calls || 0} tools — ${trunc(m.action || m.role || "", 60)}`;
      }).join("\n");
      const first = states[members[0]] || {};
      bodyText = `${first.label || groupId} (${members.length} runs)\nRole: ${first.role || ""}\n\n${summaryLines}`;
    }

    insp.innerHTML = `<div class="run-selector">${chipsHtml}</div><div class="insp-body">${escHtml(bodyText)}</div>`;
    insp.querySelectorAll(".run-chip").forEach(btn => {
      btn.onclick = () => {
        const rid = btn.dataset.run;
        selectedNode = rid === "__all__" ? null : rid;
        renderInspectorForNode(selectedNode, groupId);
        renderAll();
      };
    });
    return;
  }

  const targetId = nodeId || (members && members[0]);
  if (!targetId) return;
  const info = states[targetId] || { id: targetId, state: "idle" };
  const ntype = info.node_type || "agent";
  const st = stateStyle(info.state);
  const lines = (info.recent_actions || []).slice(-5).map(r => `  ${fmtTs(r.ts)} · ${r.text}`).join("\n");
  insp.textContent =
    `${targetId} [${ntype === "external" ? "EXTERNAL" : (ntype === "human" ? "HUMAN" : st.label)}]\nRole: ${info.role || ""}\nCurrent: ${info.action || ""}\nSteps: ${info.steps || 0} · Tools: ${info.tool_calls || 0} · Sent/Recv: ${info.msg_sent || 0}/${info.msg_recv || 0} · Last: ${fmtAge(info.age_sec)}` +
    (lines ? `\n\nRecent actions:\n${lines}` : "");
}

function getFullTimeline() {
  if (mode === "sim") {
    return SIM_SCRIPT.map((e, i) => ({ ...e, id: "sim-" + i, ts: `T+${String(i * 4).padStart(2, "0")}s`, epoch: i * 4 }));
  }
  return (liveState && liveState.activity) || [];
}
function getEffectiveIndex() {
  const tl = getFullTimeline();
  if (!tl.length) return -1;
  if (mode === "live" && liveTail) return tl.length - 1;
  return Math.max(0, Math.min(playhead, tl.length - 1));
}
function isScrubbingHistory() {
  const tl = getFullTimeline();
  return mode === "live" && tl.length > 0 && (!liveTail || playhead < tl.length - 1);
}

function curveBetween(na, nb, seed = 1) {
  const mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2;
  const dx = nb.x - na.x, dy = nb.y - na.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = seed * 22;
  return { x1: na.x, y1: na.y, cx: mx - (dy / len) * off, cy: my + (dx / len) * off, x2: nb.x, y2: nb.y };
}

function buildSnapshot(slice) {
  const roster = getRoster();
  const agents = {};
  const edges = {};
  const refEpoch = slice.length ? (slice[slice.length - 1].epoch || 0) : 0;

  roster.forEach(a => {
    agents[a.id] = {
      ...a, state: "idle", action: "Standby",
      steps: 0, tool_calls: 0, msg_sent: 0, msg_recv: 0,
      last_epoch: null, reported_done: false, has_blocker: false,
      recent_actions: [], age_sec: null
    };
  });

  slice.forEach(ev => {
    const fromA = agents[ev.from];
    const toA = agents[ev.to];
    if (ev.kind === "tool") {
      if (fromA) {
        fromA.tool_calls += 1; fromA.steps += 1;
        fromA.action = ev.title || "Running tool";
        fromA.last_epoch = ev.epoch;
        fromA.recent_actions.push({ ts: ev.ts, text: ev.title });
      }
      if (toA && ev.to !== ev.from && toA.node_type === "external") {
        toA.tool_calls += 1; toA.steps += 1; toA.msg_recv += 1;
        toA.action = ev.title || "External call";
        toA.last_epoch = ev.epoch;
        toA.recent_actions.push({ ts: ev.ts, text: `${ev.from}: ${ev.title}` });
        const k = [ev.from, ev.to].sort().join("|");
        edges[k] = (edges[k] || 0) + 1;
      }
    } else {
      if (fromA) {
        fromA.msg_sent += 1; fromA.steps += 1;
        fromA.last_epoch = ev.epoch;
        fromA.action = ev.kind === "complete" ? `Completed: ${ev.title}` : `-> ${(toA?.label || ev.to)}: ${ev.title}`;
        fromA.recent_actions.push({ ts: ev.ts, text: ev.title });
        if (ev.kind === "complete") fromA.reported_done = true;
        if (ev.kind === "blocker") fromA.has_blocker = true;
      }
      if (toA && ev.to !== ev.from) {
        toA.msg_recv += 1; toA.last_epoch = ev.epoch;
        if (ev.kind === "dispatch" && toA.steps === 0) toA.action = `Assigned: ${ev.title}`;
      }
      if (ev.from && ev.to && ev.from !== ev.to) {
        const k = [ev.from, ev.to].sort().join("|");
        edges[k] = (edges[k] || 0) + 1;
      }
    }
  });

  const head = slice[slice.length - 1];
  roster.forEach(a => {
    const info = agents[a.id];
    const touched = info.steps > 0 || info.msg_recv > 0;
    if (!touched) { info.state = "idle"; return; }
    const dt = (info.last_epoch != null && refEpoch) ? Math.max(0, Math.round(refEpoch - info.last_epoch)) : 0;
    info.age_sec = dt;
    const isHeadActor = head && (head.from === a.id || (head.to === a.id && head.kind !== "tool"));
    if (isHeadActor && head.kind === "blocker") info.state = "blocker";
    else if (isHeadActor && head.kind === "complete" && !a.is_root) info.state = "done";
    else if (isHeadActor || (dt <= 20 && !info.reported_done)) info.state = "working";
    else if (info.reported_done && !a.is_root) info.state = "done";
    else if (info.has_blocker && !info.reported_done) info.state = "blocker";
    else info.state = "waiting";
  });
  return { agents, edges };
}

function getAgentStates() {
  if (mode === "live" && !isScrubbingHistory() && liveState && liveState.agents) return liveState.agents;
  const tl = getFullTimeline(), idx = getEffectiveIndex();
  return buildSnapshot(idx >= 0 ? tl.slice(0, idx + 1) : []).agents;
}
function getEdgeCounts() {
  if (mode === "live" && !isScrubbingHistory() && liveState && liveState.edge_counts) return liveState.edge_counts;
  const tl = getFullTimeline(), idx = getEffectiveIndex();
  return buildSnapshot(idx >= 0 ? tl.slice(0, idx + 1) : []).edges;
}
function getStreamItems() {
  const tl = getFullTimeline(), idx = getEffectiveIndex();
  const sliced = idx >= 0 ? tl.slice(0, idx + 1) : [];
  if (mode === "sim") return sliced;
  return showTools ? sliced : sliced.filter(e => e.kind !== "tool");
}

let currentLayout = {};

function renderGraph() {
  const svg = document.getElementById("graph");
  const ns = "http://www.w3.org/2000/svg";
  const roster = getRoster();
  const states = getAgentStates();
  const rawCounts = getEdgeCounts();
  const model = buildGraphModel(roster, states, rawCounts);
  currentNodeToGroup = model.nodeToGroup;
  currentGroupMembers = model.groupMembers;

  const laid = layoutNodes(model.nodes);
  currentLayout = laid.map;
  const counts = model.edges;
  const nodes = model.nodes;
  const rootId = (nodes.find(a => a.is_root) || nodes.find(a => a.node_type !== "human" && a.node_type !== "external") || {}).id;

  const baseChanged = viewState.baseW !== laid.worldW || viewState.baseH !== laid.worldH;
  viewState.baseW = laid.worldW;
  viewState.baseH = laid.worldH;
  if (!viewState.userModified || baseChanged) {
    viewState.x = 0; viewState.y = 0;
    viewState.w = laid.worldW; viewState.h = laid.worldH;
    if (baseChanged && !viewState.userModified) viewState.userModified = false;
  }
  applyViewBox();

  let packetLayer = svg.querySelector("#packets");
  svg.innerHTML = "";

  const drawDivider = (yPos, label) => {
    const sepG = document.createElementNS(ns, "g");
    const sepLine = document.createElementNS(ns, "line");
    sepLine.setAttribute("x1", "26"); sepLine.setAttribute("y1", String(yPos));
    sepLine.setAttribute("x2", String(laid.worldW - 26)); sepLine.setAttribute("y2", String(yPos));
    sepLine.setAttribute("stroke", "#1e2942"); sepLine.setAttribute("stroke-dasharray", "4 5");
    const sepLbl = document.createElementNS(ns, "text");
    sepLbl.setAttribute("x", "34"); sepLbl.setAttribute("y", String(yPos - 6));
    sepLbl.setAttribute("fill", "#64748b"); sepLbl.setAttribute("font-size", "9.5");
    sepLbl.setAttribute("font-weight", "700"); sepLbl.setAttribute("letter-spacing", "0.08em");
    sepLbl.textContent = label;
    sepG.append(sepLine, sepLbl);
    svg.appendChild(sepG);
  };

  if (laid.completedY != null) drawDivider(laid.completedY, "COMPLETED / STANDBY");
  if (laid.extY != null) drawDivider(laid.extY, "EXTERNALS & INTEGRATIONS");

  // Build edge list: human->root + coordinator->all subagent nodes + every observed pair
  const pairSet = new Set();
  const hasHuman = nodes.some(a => a.node_type === "human" || a.id === "human");
  if (hasHuman && rootId) pairSet.add(["human", rootId].sort().join("|"));
  nodes.forEach(a => {
    if (rootId && a.id !== rootId && a.node_type !== "human" && a.node_type !== "external") {
      pairSet.add([rootId, a.id].sort().join("|"));
    }
  });
  Object.keys(counts).forEach(k => pairSet.add(k));

  const activeHighlightKey = hoveredNode || selectedGroup || (selectedNode ? (currentNodeToGroup[selectedNode] || selectedNode) : null);

  const edgeLayer = document.createElementNS(ns, "g");
  Array.from(pairSet).forEach((pairKey, i) => {
    const [aId, bId] = pairKey.split("|");
    const na = currentLayout[aId], nb = currentLayout[bId];
    if (!na || !nb) return;
    const isHumanEdge = na.node_type === "human" || nb.node_type === "human";
    const isExtEdge = na.node_type === "external" || nb.node_type === "external";
    const isPeer = !isHumanEdge && !isExtEdge && aId !== rootId && bId !== rootId;
    const c = curveBetween(na, nb, isExtEdge ? 0.2 : (isPeer ? 0.45 : (i % 2 === 0 ? -0.75 : 0.75)));
    const count = counts[pairKey] || 0;
    const isActiveEnd = (n) => n && (n.state === "working" || n.state === "thinking");
    const isHot = (isActiveEnd(na) || isActiveEnd(nb)) && count > 0;

    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", `M ${c.x1} ${c.y1} Q ${c.cx} ${c.cy} ${c.x2} ${c.y2}`);
    path.setAttribute("fill", "none");
    let strokeCol = count > 0 ? (isPeer ? "#06b6d4" : "#a855f7") : (isPeer ? "rgba(6,182,212,0.18)" : "rgba(168,85,247,0.15)");
    if (isHumanEdge) strokeCol = count > 0 ? "#f59e0b" : "rgba(245,158,11,0.22)";
    else if (isExtEdge) strokeCol = "#38bdf8";
    path.setAttribute("stroke", strokeCol);

    if (isExtEdge) {
      path.classList.add("ext-edge");
      path.dataset.a = aId;
      path.dataset.b = bId;
      const lit = activeHighlightKey && (aId === activeHighlightKey || bId === activeHighlightKey);
      if (lit) path.classList.add("ext-lit");
      path.setAttribute("stroke-opacity", "0.16");
      path.setAttribute("stroke-width", "1.25");
      path.setAttribute("stroke-dasharray", "4 4");
    } else {
      path.setAttribute("stroke-opacity", isHot ? "0.95" : (count > 0 ? "0.72" : "1"));
      path.setAttribute("stroke-width", isHot ? "2.6" : (count > 0 ? "2.2" : "1.25"));
      if (isPeer || isHot) path.setAttribute("stroke-dasharray", count > 0 ? "7 5" : "4 6");
      if (isHot) path.classList.add("flow-edge");
    }
    edgeLayer.appendChild(path);

    if (count > 0 && !isExtEdge) {
      const mx = 0.25 * c.x1 + 0.5 * c.cx + 0.25 * c.x2;
      const my = 0.25 * c.y1 + 0.5 * c.cy + 0.25 * c.y2;
      const lblText = `${count} msg`;
      const pillW = Math.max(38, lblText.length * 6.2 + 10);
      const bg = document.createElementNS(ns, "rect");
      bg.setAttribute("x", mx - pillW / 2); bg.setAttribute("y", my - 10);
      bg.setAttribute("width", pillW); bg.setAttribute("height", 19); bg.setAttribute("rx", 9);
      bg.setAttribute("fill", "#0b1220"); bg.setAttribute("stroke", isHumanEdge ? "#f59e0b" : (isPeer ? "#06b6d4" : "#a855f7"));
      bg.setAttribute("stroke-width", "1.2");
      const tx = document.createElementNS(ns, "text");
      tx.setAttribute("x", mx); tx.setAttribute("y", my + 3);
      tx.setAttribute("text-anchor", "middle"); tx.setAttribute("fill", "#e2e8f0");
      tx.setAttribute("font-size", "10"); tx.setAttribute("font-weight", "650");
      tx.textContent = lblText;
      edgeLayer.append(bg, tx);
    }
  });
  svg.appendChild(edgeLayer);

  if (!packetLayer) { packetLayer = document.createElementNS(ns, "g"); packetLayer.id = "packets"; }
  svg.appendChild(packetLayer);

  const nodeLayer = document.createElementNS(ns, "g");
  nodes.forEach(a => {
    const pos = currentLayout[a.id];
    if (!pos) return;
    const info = a;
    const ntype = a.node_type || "agent";
    const st = stateStyle(info.state);
    const isStacked = a.is_group && a.run_count > 1;
    const isSelected = selectedGroup === a.id || (!selectedGroup && selectedNode === a.primary_id) || (a.members && selectedNode && a.members.includes(selectedNode));

    const g = document.createElementNS(ns, "g");
    g.classList.add("agent-card");
    if (pos._mutedRail && !isSelected) g.setAttribute("opacity", "0.82");

    g.onmouseenter = () => { hoveredNode = a.id; updateExternalEdgeHighlight(); };
    g.onmouseleave = () => { if (hoveredNode === a.id) hoveredNode = null; updateExternalEdgeHighlight(); };

    g.onclick = () => {
      if (isStacked) {
        if (selectedGroup === a.id) {
          selectedGroup = null;
          selectedNode = null;
        } else {
          selectedGroup = a.id;
          selectedNode = null;
        }
      } else {
        selectedGroup = null;
        selectedNode = selectedNode === a.primary_id ? null : a.primary_id;
      }
      document.getElementById("btnClearNode").style.display = (selectedNode || selectedGroup) ? "inline-block" : "none";
      if (selectedGroup || selectedNode) {
        renderInspectorForNode(selectedNode, selectedGroup);
      } else {
        document.getElementById("inspector").textContent = "Click any agent card, stream item, or scrub the timeline below to inspect.";
      }
      renderAll();
    };

    if (ntype === "external") {
      const ex = pos.x - EXT_W / 2, ey = pos.y - EXT_H / 2;
      const icon = a.id.startsWith("ext:mcp:") ? "🔌" : (a.id === "ext:web" ? "🌐" : (a.id === "ext:shell" ? "⚡" : "📁"));
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", ex); rect.setAttribute("y", ey);
      rect.setAttribute("width", EXT_W); rect.setAttribute("height", EXT_H); rect.setAttribute("rx", 9);
      rect.setAttribute("fill", "#0b1322");
      rect.setAttribute("stroke", isSelected ? "#ffffff" : a.color);
      rect.setAttribute("stroke-width", isSelected ? "2.2" : "1.5");
      rect.setAttribute("stroke-dasharray", "5 3");

      const lbl = document.createElementNS(ns, "text");
      lbl.setAttribute("x", ex + 10); lbl.setAttribute("y", ey + 19);
      lbl.setAttribute("fill", "#e2e8f0"); lbl.setAttribute("font-size", "11.2"); lbl.setAttribute("font-weight", "700");
      lbl.textContent = `${icon} ${trunc(a.label, 14)}`;

      const sub = document.createElementNS(ns, "text");
      sub.setAttribute("x", ex + 10); sub.setAttribute("y", ey + 35);
      sub.setAttribute("fill", "#94a3b8"); sub.setAttribute("font-size", "9.6");
      sub.setAttribute("font-family", "ui-monospace, Consolas, monospace");
      sub.textContent = `${info.tool_calls || 0} calls · ${trunc(info.action || a.role, 14)}`;

      g.append(rect, lbl, sub);
      nodeLayer.appendChild(g);
      return;
    }

    const w = ntype === "human" ? 168 : CARD_W;
    const h = ntype === "human" ? 74 : CARD_H;
    const x = pos.x - w / 2, y = pos.y - h / 2;
    const isLiveBusy = ntype === "agent" && (info.state === "working" || info.state === "thinking");

    if (isStacked) {
      const layers = Math.min(2, a.run_count - 1);
      for (let li = layers; li >= 1; li--) {
        const off = li * 5;
        const back = document.createElementNS(ns, "rect");
        back.setAttribute("x", x + off); back.setAttribute("y", y + off);
        back.setAttribute("width", w); back.setAttribute("height", h); back.setAttribute("rx", 11);
        back.setAttribute("fill", "#0c1324");
        back.setAttribute("stroke", a.color);
        back.setAttribute("stroke-opacity", li === 1 ? "0.48" : "0.26");
        back.setAttribute("stroke-width", "1.3");
        g.appendChild(back);
      }
    }

    if (isLiveBusy || info.state === "blocker") {
      const halo = document.createElementNS(ns, "rect");
      halo.setAttribute("x", x - 5); halo.setAttribute("y", y - 5);
      halo.setAttribute("width", w + 10); halo.setAttribute("height", h + 10);
      halo.setAttribute("rx", 14); halo.setAttribute("fill", "none");
      halo.setAttribute("stroke", st.stroke); halo.setAttribute("stroke-width", "3.2");
      halo.classList.add("work-halo");
      g.appendChild(halo);
    }

    const rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", x); rect.setAttribute("y", y);
    rect.setAttribute("width", w); rect.setAttribute("height", h); rect.setAttribute("rx", ntype === "human" ? 16 : 11);
    rect.setAttribute("fill", ntype === "human" ? "#1d1609" : (info.state === "idle" ? "#0d121e" : (info.state === "thinking" ? "#191532" : "#121b2e")));
    rect.setAttribute("stroke", isSelected ? "#ffffff" : (ntype === "human" ? "#f59e0b" : (info.state === "thinking" ? "#c084fc" : (info.state === "idle" ? "#24314c" : a.color))));
    rect.setAttribute("stroke-width", isSelected ? "2.5" : (isLiveBusy || ntype === "human" ? "2.2" : (info.state === "idle" ? "1.3" : "2")));

    const bar = document.createElementNS(ns, "rect");
    bar.setAttribute("x", x + 1); bar.setAttribute("y", y + 1);
    bar.setAttribute("width", 5); bar.setAttribute("height", h - 2); bar.setAttribute("rx", 3);
    bar.setAttribute("fill", info.state === "thinking" ? "#c084fc" : a.color);
    bar.setAttribute("opacity", info.state === "idle" && ntype !== "human" ? "0.4" : "1");

    const nameTx = document.createElementNS(ns, "text");
    nameTx.setAttribute("x", x + 14); nameTx.setAttribute("y", y + 22);
    nameTx.setAttribute("fill", ntype === "human" ? "#fde68a" : "#f8fafc"); nameTx.setAttribute("font-size", "12.2"); nameTx.setAttribute("font-weight", "700");
    nameTx.textContent = ntype === "human" ? "👤 Human" : trunc(a.label, isStacked ? 11 : 14);

    const pillW = ntype === "human" ? 54 : (isLiveBusy ? 72 : 60);
    const pillX = x + w - pillW - 8;
    const pillBg = document.createElementNS(ns, "rect");
    pillBg.setAttribute("x", pillX); pillBg.setAttribute("y", y + 9);
    pillBg.setAttribute("width", pillW); pillBg.setAttribute("height", 17); pillBg.setAttribute("rx", 8.5);
    pillBg.setAttribute("fill", ntype === "human" ? "rgba(245,158,11,0.18)" : st.fill);
    pillBg.setAttribute("stroke", ntype === "human" ? "#f59e0b" : st.stroke); pillBg.setAttribute("stroke-width", "1.1");

    const pillTx = document.createElementNS(ns, "text");
    pillTx.setAttribute("x", pillX + (isLiveBusy ? pillW / 2 + 4 : pillW / 2)); pillTx.setAttribute("y", y + 21);
    pillTx.setAttribute("text-anchor", "middle"); pillTx.setAttribute("fill", ntype === "human" ? "#fcd34d" : st.text);
    pillTx.setAttribute("font-size", "8.9"); pillTx.setAttribute("font-weight", "700");
    pillTx.textContent = ntype === "human" ? "USER" : st.label;

    const actTx = document.createElementNS(ns, "text");
    actTx.setAttribute("x", x + 14); actTx.setAttribute("y", y + 44);
    actTx.setAttribute("fill", info.state === "thinking" ? "#e9d5ff" : (info.state === "idle" && ntype !== "human" ? "#64748b" : "#cbd5e1"));
    actTx.setAttribute("font-size", "10.6");
    actTx.textContent = trunc(info.action || a.role, ntype === "human" ? 22 : 26);

    const metaTx = document.createElementNS(ns, "text");
    metaTx.setAttribute("x", x + 14); metaTx.setAttribute("y", y + (ntype === "human" ? 61 : 66));
    metaTx.setAttribute("fill", info.state === "thinking" ? "#d8b4fe" : "#8b9bb8"); metaTx.setAttribute("font-size", "10");
    metaTx.setAttribute("font-family", "ui-monospace, Consolas, monospace");
    const ageLbl = info.state === "thinking" && info.age_sec != null ? `thinking ${fmtDuration(info.age_sec)}` : fmtAge(info.age_sec);
    metaTx.textContent = ntype === "human"
      ? `${info.msg_sent || 0} prompts · ${info.msg_recv || 0} replies`
      : (info.steps > 0 ? `${info.steps} steps · ${info.tool_calls} tools · ${ageLbl}` : trunc(a.role, 26));

    g.append(rect, bar, nameTx, pillBg, pillTx, actTx, metaTx);

    if (isStacked) {
      const cntTxt = `×${a.run_count}`;
      const cw = Math.max(24, cntTxt.length * 7 + 8);
      const cx = x + w - cw - 8;
      const cy = y + h - 22;
      const cntBg = document.createElementNS(ns, "rect");
      cntBg.setAttribute("x", cx); cntBg.setAttribute("y", cy);
      cntBg.setAttribute("width", cw); cntBg.setAttribute("height", 16); cntBg.setAttribute("rx", 8);
      cntBg.setAttribute("fill", "#1e3a8a"); cntBg.setAttribute("stroke", "#60a5fa"); cntBg.setAttribute("stroke-width", "1.1");
      const cntEl = document.createElementNS(ns, "text");
      cntEl.setAttribute("x", cx + cw / 2); cntEl.setAttribute("y", cy + 11.5);
      cntEl.setAttribute("text-anchor", "middle"); cntEl.setAttribute("fill", "#eff6ff");
      cntEl.setAttribute("font-size", "9.5"); cntEl.setAttribute("font-weight", "750");
      cntEl.textContent = cntTxt;
      g.append(cntBg, cntEl);
    }

    if (isLiveBusy) {
      const pDot = document.createElementNS(ns, "circle");
      pDot.setAttribute("cx", pillX + 9); pDot.setAttribute("cy", y + 17.5);
      pDot.setAttribute("r", "3"); pDot.setAttribute("fill", st.stroke);
      pDot.classList.add("live-dot");
      g.appendChild(pDot);

      const clipId = `clip-${a.id.replace(/[^a-z0-9]/gi, "_")}`;
      const defs = document.createElementNS(ns, "defs");
      const cp = document.createElementNS(ns, "clipPath");
      cp.setAttribute("id", clipId);
      const cRect = document.createElementNS(ns, "rect");
      cRect.setAttribute("x", x + 6); cRect.setAttribute("y", y + CARD_H - 5);
      cRect.setAttribute("width", CARD_W - 10); cRect.setAttribute("height", 4); cRect.setAttribute("rx", 2);
      cp.appendChild(cRect); defs.appendChild(cp);

      const trackBg = document.createElementNS(ns, "rect");
      trackBg.setAttribute("x", x + 6); trackBg.setAttribute("y", y + CARD_H - 5);
      trackBg.setAttribute("width", CARD_W - 10); trackBg.setAttribute("height", 3.5);
      trackBg.setAttribute("rx", 2); trackBg.setAttribute("fill", "rgba(255,255,255,0.08)");

      const scanWrap = document.createElementNS(ns, "g");
      scanWrap.setAttribute("clip-path", `url(#${clipId})`);
      const scan = document.createElementNS(ns, "rect");
      scan.setAttribute("x", x + 6); scan.setAttribute("y", y + CARD_H - 5);
      scan.setAttribute("width", 56); scan.setAttribute("height", 3.5); scan.setAttribute("rx", 2);
      scan.setAttribute("fill", st.stroke); scan.classList.add("scan-bar");
      scanWrap.appendChild(scan);
      g.append(defs, trackBg, scanWrap);
    }
    nodeLayer.appendChild(g);
  });
  svg.appendChild(nodeLayer);
}

function animatePacket(ev) {
  if (!ev || ev.kind === "tool" || ev.from === ev.to) return;
  const fa = currentNodeToGroup[ev.from] || ev.from;
  const tb = currentNodeToGroup[ev.to] || ev.to;
  if (fa === tb) return;
  const na = currentLayout[fa], nb = currentLayout[tb];
  const pg = document.getElementById("packets");
  if (!na || !nb || !pg) return;
  const c = curveBetween(na, nb, 0.5);
  const ns = "http://www.w3.org/2000/svg";
  const dot = document.createElementNS(ns, "circle");
  dot.setAttribute("r", "6.5"); dot.setAttribute("fill", colorForKind(ev.kind));
  dot.setAttribute("stroke", "#ffffff"); dot.setAttribute("stroke-width", "1.4");
  pg.appendChild(dot);

  const t0 = performance.now(), dur = 800;
  (function tick(now) {
    const t = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    const omt = 1 - e;
    dot.setAttribute("cx", omt*omt*c.x1 + 2*omt*e*c.cx + e*e*c.x2);
    dot.setAttribute("cy", omt*omt*c.y1 + 2*omt*e*c.cy + e*e*c.y2);
    dot.setAttribute("opacity", t > 0.85 ? String((1 - t) / 0.15) : "1");
    if (t < 1) requestAnimationFrame(tick); else dot.remove();
  })(t0);
}

function renderMetrics() {
  const states = Object.values(getAgentStates()).filter(s => (s.node_type || "agent") === "agent");
  const spawned = states.filter(s => s.state !== "idle").length;
  const thinking = states.filter(s => s.state === "thinking").length;
  const working = states.filter(s => s.state === "working").length;
  const tools = states.reduce((acc, s) => acc + (s.tool_calls || 0), 0);
  const tl = getFullTimeline(), idx = getEffectiveIndex();
  const evs = (idx >= 0 ? tl.slice(0, idx + 1) : []).filter(e => e.kind !== "tool");
  document.getElementById("statActive").textContent = thinking > 0
    ? `${thinking} thinking · ${working} tools · ${spawned}/${states.length}`
    : `${working} working · ${spawned}/${states.length} live`;
  document.getElementById("statTools").textContent = tools;
  document.getElementById("statPeer").textContent = evs.filter(e => e.kind === "peer").length;
  document.getElementById("statOrch").textContent = evs.filter(e => e.kind === "complete").length;
}

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getDefinitions() {
  if (mode === "sim") return SIM_DEFINITIONS;
  return (liveState && liveState.definitions) || [];
}

function setMobilePane(pane) {
  const mainEl = document.getElementById("mainGrid");
  if (mainEl) mainEl.dataset.mobilePane = pane;
  document.getElementById("mobTabTopo")?.classList.toggle("active", pane === "topology");
  document.getElementById("mobTabStream")?.classList.toggle("active", pane === "stream");
  document.getElementById("mobTabDefs")?.classList.toggle("active", pane === "defs");
  if (pane === "stream") setRightTab("stream");
  else if (pane === "defs") setRightTab("defs");
}

function setRightTab(tab) {
  rightTab = tab;
  document.getElementById("tabStream").classList.toggle("active", tab === "stream");
  document.getElementById("tabDefs").classList.toggle("active", tab === "defs");
  document.getElementById("streamHeadControls").style.display = tab === "stream" ? "flex" : "none";
  document.getElementById("filterBar").style.display = tab === "stream" ? "flex" : "none";
  document.getElementById("feed").style.display = tab === "stream" ? "flex" : "none";
  document.getElementById("defsPane").style.display = tab === "defs" ? "flex" : "none";
  document.getElementById("inspector").style.display = tab === "stream" ? "block" : "none";
  if (tab === "defs") renderDefinitions(true);
}

function renderDefinitions(force = false) {
  const allDefs = getDefinitions();
  const activeDefs = allDefs.filter(d => d.in_session);
  const totalIssues = activeDefs.reduce((acc, d) => acc + (d.issues || []).filter(i => i.level === "warn" || i.level === "error").length, 0);
  const hasErr = activeDefs.some(d => (d.issues || []).some(i => i.level === "error"));
  for (const badgeId of ["defIssueBadge", "defIssueBadgeMobile"]) {
    const badge = document.getElementById(badgeId);
    if (badge) {
      badge.style.display = totalIssues > 0 ? "inline-block" : "none";
      badge.textContent = `⚠ ${totalIssues}`;
      badge.classList.toggle("err", hasErr);
    }
  }
  if (rightTab !== "defs") return;

  const pane = document.getElementById("defsPane");
  const states = getAgentStates();
  const tl = getFullTimeline();
  const idx = getEffectiveIndex();
  const slice = idx >= 0 ? tl.slice(0, idx + 1) : [];

  const filtered = selectedNode ? allDefs.filter(d => d.id === selectedNode) : allDefs;

  // Build per-agent tool breakdown & recent timeline comms from current snapshot slice
  const toolMap = {};
  const commsMap = {};
  const recentToolMap = {};
  for (let i = 0; i < slice.length; i++) {
    const ev = slice[i];
    if (ev.kind === "tool") {
      const aid = ev.from;
      if (aid) {
        if (!toolMap[aid]) toolMap[aid] = {};
        const rawTitle = String(ev.title || "tool").trim();
        const toolName = rawTitle.split(/[\s(:]/)[0] || rawTitle;
        toolMap[aid][toolName] = (toolMap[aid][toolName] || 0) + 1;
        if (!recentToolMap[aid]) recentToolMap[aid] = [];
        recentToolMap[aid].push(ev);
      }
    } else {
      if (ev.from) {
        if (!commsMap[ev.from]) commsMap[ev.from] = [];
        commsMap[ev.from].push(ev);
      }
      if (ev.to && ev.to !== ev.from) {
        if (!commsMap[ev.to]) commsMap[ev.to] = [];
        commsMap[ev.to].push(ev);
      }
    }
  }

  // Fingerprint check to avoid redundant DOM replacement
  const renderKey = JSON.stringify([
    mode,
    selectedNode || "",
    idx,
    totalIssues,
    filtered.map(d => {
      const a = states[d.id] || {};
      return [
        d.id, d.in_session, a.state || d.state, a.action || "", a.age_sec ?? "",
        a.steps ?? d.steps ?? 0, a.tool_calls ?? d.tool_calls ?? 0,
        a.msg_sent ?? 0, a.msg_recv ?? 0, d.context_tokens || 0,
        (d.def_preview || "").length, (d.spawn_prompt || "").length,
        (d.issues || []).length,
        (commsMap[d.id] || []).length,
        (recentToolMap[d.id] || []).length,
      ];
    }),
  ]);
  if (!force && renderKey === lastDefsRenderKey) return;
  if (!force && hasActiveSelectionIn(pane)) {
    defsRenderDeferred = true;
    return;
  }

  const prevScrollTop = pane.scrollTop;
  let html = "";
  if (selectedNode) {
    const selLabel = states[selectedNode]?.label || filtered[0]?.label || selectedNode;
    html += `<div class="def-filter-banner">
      <span>Showing details for <b>${escHtml(selLabel)}</b></span>
      <button type="button" class="def-clear-filter-btn">Show all agents</button>
    </div>`;
  }

  if (!filtered.length) {
    pane.innerHTML = html + `<div class="empty">No agent details match the current filter.</div>`;
    lastDefsRenderKey = renderKey;
    defsRenderDeferred = false;
    pane.querySelector(".def-clear-filter-btn")?.addEventListener("click", () => {
      selectedNode = null;
      document.getElementById("btnClearNode").style.display = "none";
      renderAll();
    });
    return;
  }

  html += `<div class="defs-summary">
    <span><b>${activeDefs.length}</b> in session · <b>${allDefs.length - activeDefs.length}</b> available on disk</span>
    <span>${totalIssues > 0 ? `<b style="color:#fcd34d;">⚠ ${totalIssues} potential context issue${totalIssues === 1 ? "" : "s"}</b>` : `<b style="color:#34d399;">✓ No context issues detected</b>`}</span>
  </div>`;

  const renderExpandablePrompt = (secKey, title, content) => {
    if (!content) return "";
    const isOpen = openDefSections.has(secKey) ? " open" : "";
    return `<details class="def-details" data-def-key="${escHtml(secKey)}"${isOpen}>
      <summary>
        <span class="def-sum-left"><span class="def-chevron" aria-hidden="true">▸</span><span>${title}</span></span>
        <button type="button" class="def-copy-btn" title="Copy prompt text">Copy</button>
      </summary>
      <pre>${escHtml(content)}</pre>
    </details>`;
  };

  filtered.forEach(d => {
    const live = states[d.id] || null;
    const effState = (live && live.state) || d.state || "idle";
    const st = stateStyle(effState);
    const issues = d.issues || [];
    const hasCardErr = issues.some(i => i.level === "error");
    const hasCardWarn = issues.some(i => i.level === "warn");
    const cardCls = hasCardErr ? "def-card has-err" : (hasCardWarn ? "def-card has-warn" : "def-card");

    const steps = live ? (live.steps ?? d.steps ?? 0) : (d.steps || 0);
    const tools = live ? (live.tool_calls ?? d.tool_calls ?? 0) : (d.tool_calls || 0);
    const msgSent = live ? (live.msg_sent || 0) : 0;
    const msgRecv = live ? (live.msg_recv || 0) : 0;
    const lastAge = live && live.age_sec != null ? fmtAge(live.age_sec) : (d.in_session ? "active" : "—");
    const liveAction = live && live.action ? live.action : (d.in_session ? "Standby" : "");

    const issueHtml = issues.length
      ? issues.map(i => `<div class="issue-row ${i.level}"><b>${i.level === "error" ? "✕" : (i.level === "info" ? "ℹ" : "⚠")} ${escHtml(i.label)}:</b> <span>${escHtml(i.detail)}</span></div>`).join("")
      : `<div class="issue-row ok"><b>✓ Healthy Context:</b> <span>Definition &amp; handoff metrics look balanced.</span></div>`;

    const activityHtml = d.in_session
      ? `<div class="def-activity ${escHtml(effState)}">
          <div class="def-activity-top">
            <span>${effState === "thinking" ? "🧠 Thinking / Reasoning" : (effState === "working" ? "⚡ Current Activity" : "Last Activity")}</span>
            <span>Last seen: ${escHtml(lastAge)}</span>
          </div>
          <div class="def-activity-text">${escHtml(liveAction || "Standby")}</div>
        </div>`
      : "";

    const topTools = Object.entries(toolMap[d.id] || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const toolChipsHtml = topTools.length
      ? `<div class="def-tool-chips">${topTools.map(([name, cnt]) => `<span class="def-tool-chip">${escHtml(name)}<b>×${cnt}</b></span>`).join("")}</div>`
      : "";

    const defDetails = renderExpandablePrompt(
      `${d.id}:def`,
      `Definition prompt (~${(d.def_tokens || 0).toLocaleString()} tok)`,
      d.def_preview
    );
    const spawnDetails = renderExpandablePrompt(
      `${d.id}:spawn`,
      `Spawn handoff prompt (${(d.spawn_chars || (d.spawn_prompt || "").length).toLocaleString()} chars)`,
      d.spawn_prompt
    );

    const agentComms = (commsMap[d.id] || []).slice(-8).reverse();
    const commsKey = `${d.id}:comms`;
    const commsDetails = agentComms.length
      ? `<details class="def-details" data-def-key="${escHtml(commsKey)}"${openDefSections.has(commsKey) ? " open" : ""}>
          <summary>
            <span class="def-sum-left"><span class="def-chevron" aria-hidden="true">▸</span><span>Recent comms &amp; handoffs (${(commsMap[d.id] || []).length})</span></span>
          </summary>
          <div class="def-log-list">${agentComms.map(ev => {
            const fromL = states[ev.from]?.label || ev.from;
            const toL = states[ev.to]?.label || ev.to;
            return `<div class="def-log-item">
              <div class="def-log-top">
                <span>${escHtml(fromL)} → ${escHtml(toL)}</span>
                <span class="pill ${ev.kind === "complete" ? "ok" : escHtml(ev.kind)}">${escHtml(ev.kind)} · ${fmtTs(ev.ts)}</span>
              </div>
              <div class="def-log-body">${escHtml(ev.title || ev.body || "")}</div>
            </div>`;
          }).join("")}</div>
        </details>`
      : "";

    const recentTools = (recentToolMap[d.id] || []).slice(-8).reverse();
    const toolsKey = `${d.id}:tools`;
    const toolsDetails = recentTools.length
      ? `<details class="def-details" data-def-key="${escHtml(toolsKey)}"${openDefSections.has(toolsKey) ? " open" : ""}>
          <summary>
            <span class="def-sum-left"><span class="def-chevron" aria-hidden="true">▸</span><span>Recent tool calls (${(recentToolMap[d.id] || []).length})</span></span>
          </summary>
          <div class="def-log-list">${recentTools.map(ev => `<div class="def-log-item">
            <div class="def-log-top">
              <span>${fmtTs(ev.ts)}</span>
              <span class="pill tool">tool</span>
            </div>
            <div class="def-log-body">${escHtml(ev.title || "")}</div>
          </div>`).join("")}</div>
        </details>`
      : "";

    html += `<div class="${cardCls}" style="border-left-color:${d.color || "#64748b"};">
      <div class="def-head">
        <div class="def-title-wrap">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span class="def-name">${escHtml(d.label)}</span>
            <span class="def-id-tag">${escHtml(d.id)}</span>
          </div>
          <span class="sub">${escHtml(d.role)}</span>
        </div>
        <div style="display:flex;gap:5px;align-items:center;">
          ${d.in_session ? `<span class="pill ${escHtml(effState)}">${st.label}</span>` : `<span class="pill">ON DISK</span>`}
        </div>
      </div>
      ${d.description ? `<div class="def-desc">${escHtml(d.description)}</div>` : ""}
      <div class="def-path">${d.source_path ? `📄 ${escHtml(d.source_path)}` : "⚡ Runtime-only (no .md definition file)"}</div>
      ${activityHtml}
      <div class="def-metrics">
        <div class="def-metric"><span>Steps</span><b>${steps}</b></div>
        <div class="def-metric"><span>Tool Calls</span><b>${tools}</b></div>
        <div class="def-metric"><span>Sent / Recv</span><b>${msgSent} / ${msgRecv}</b></div>
        <div class="def-metric"><span>Ctx / Def</span><b>~${(d.context_tokens || 0).toLocaleString()} / ${(d.def_tokens || 0).toLocaleString()}</b></div>
      </div>
      ${toolChipsHtml}
      <div class="def-issues">${issueHtml}</div>
      ${defDetails}${spawnDetails}${commsDetails}${toolsDetails}
    </div>`;
  });

  pane.innerHTML = html;
  pane.scrollTop = prevScrollTop;
  lastDefsRenderKey = renderKey;
  defsRenderDeferred = false;

  pane.querySelector(".def-clear-filter-btn")?.addEventListener("click", () => {
    selectedNode = null;
    document.getElementById("btnClearNode").style.display = "none";
    renderAll();
  });

  pane.querySelectorAll("details[data-def-key]").forEach(det => {
    det.addEventListener("toggle", () => {
      const k = det.dataset.defKey;
      if (!k) return;
      if (det.open) openDefSections.add(k);
      else openDefSections.delete(k);
    });
  });

  pane.querySelectorAll(".def-copy-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      const pre = btn.closest("details")?.querySelector("pre");
      if (pre) copyTextWithFeedback(pre.textContent || "", btn);
    });
  });
}

function renderFeed() {
  const all = getStreamItems();
  const tl = getFullTimeline();
  const states = getAgentStates();
  const groupSet = (selectedGroup && !selectedNode && currentGroupMembers[selectedGroup])
    ? new Set(currentGroupMembers[selectedGroup])
    : null;
  const filtered = all.filter(e => {
    if (filterKind !== "all" && e.kind !== filterKind) return false;
    if (selectedNode && e.from !== selectedNode && e.to !== selectedNode) return false;
    if (groupSet && !groupSet.has(e.from) && !groupSet.has(e.to)) return false;
    return true;
  });
  document.getElementById("eventCount").textContent = `${filtered.length} item${filtered.length === 1 ? "" : "s"}`;
  const feed = document.getElementById("feed");
  if (!filtered.length) {
    feed.innerHTML = `<div class="empty">${mode === "sim" ? "Press <b>▶ Play</b> or drag the timeline below." : "No matching activity up to this point in the timeline."}</div>`;
    return;
  }
  feed.innerHTML = filtered.slice(-80).reverse().map(e => {
    const fromL = states[e.from]?.label || e.from;
    const toL = states[e.to]?.label || e.to;
    const route = e.kind === "tool" ? `${fromL} (tool)` : `${fromL} -> ${toL}`;
    return `<div class="ev ${e.kind} ${selectedEventId === e.id ? "selected" : ""}" data-id="${e.id}">
      <div class="ev-top">
        <span class="ev-route">${route}</span>
        <span class="pill ${e.kind === "complete" ? "ok" : e.kind}">${e.kind} · ${fmtTs(e.ts)}</span>
      </div>
      <div class="ev-title">${String(e.title || "").replace(/</g,"&lt;")}</div>
    </div>`;
  }).join("");

  feed.querySelectorAll(".ev").forEach(el => {
    el.onclick = () => {
      selectedEventId = el.dataset.id;
      const found = all.find(x => x.id === selectedEventId);
      const tlIdx = tl.findIndex(x => x.id === selectedEventId);
      if (tlIdx >= 0) scrubTo(tlIdx, { animate: found && found.kind !== "tool" });
      if (found) {
        document.getElementById("inspector").textContent =
          `[${found.kind.toUpperCase()}] ${found.from} -> ${found.to} (${fmtTs(found.ts)})\n\n${found.body}`;
      }
    };
  });
}

function renderTimeline() {
  const tl = getFullTimeline(), n = tl.length, idx = getEffectiveIndex();
  const pct = n <= 1 ? (n === 1 ? 100 : 0) : (idx / (n - 1)) * 100;
  const history = isScrubbingHistory();
  const states = getAgentStates();

  const fill = document.getElementById("tlFill");
  const thumb = document.getElementById("tlThumb");
  fill.style.width = `${pct}%`; thumb.style.left = `${pct}%`;
  fill.classList.toggle("history", history || mode === "sim");
  thumb.classList.toggle("history", history || mode === "sim");
  document.getElementById("tlTailGlow").style.display = mode === "live" ? "block" : "none";

  const ticksSig = `${mode}:${liveState?.session_id || ""}:${n}`;
  if (ticksSig !== lastTicksSig) {
    lastTicksSig = ticksSig;
    document.getElementById("tlTicks").innerHTML = n > 1
      ? tl.map((ev, i) => `<i class="${ev.kind === "tool" ? "tl-tick tool" : "tl-tick"}" style="left:${((i/(n-1))*100).toFixed(3)}%;background:${colorForKind(ev.kind)};"></i>`).join("")
      : "";
  }

  const cur = idx >= 0 ? tl[idx] : null;
  const startEp = n ? (tl[0].epoch || 0) : 0;
  const endEp = n ? (tl[n - 1].epoch || startEp) : 0;
  const curEp = cur ? (cur.epoch || startEp) : startEp;
  document.getElementById("tlClock").textContent = `${fmtDuration(curEp - startEp)} / ${fmtDuration(endEp - startEp)}`;
  document.getElementById("tlFrames").textContent = `${n ? idx + 1 : 0} / ${n} events`;

  const lbl = document.getElementById("tlNowLabel");
  if (!cur) {
    lbl.textContent = mode === "sim" ? "Demo ready — press ▶ Play or scrub" : "Waiting for events…";
  } else {
    const fromL = states[cur.from]?.label || cur.from;
    const toL = states[cur.to]?.label || cur.to;
    const prefix = history ? `[REPLAY ${fmtTs(cur.ts)}] ` : (mode === "live" ? `[LIVE ${fmtTs(cur.ts)}] ` : `[DEMO ${cur.ts}] `);
    lbl.textContent = `${prefix}${cur.kind === "tool" ? fromL : `${fromL} → ${toL}`}: ${cur.title || ""}`;
  }

  const liveBtn = document.getElementById("tlLiveBtn");
  const liveTxt = document.getElementById("tlLiveText");
  if (mode === "sim") { liveBtn.classList.add("behind"); liveTxt.textContent = "DEMO"; }
  else if (!history) { liveBtn.classList.remove("behind"); liveTxt.textContent = "LIVE"; }
  else { liveBtn.classList.add("behind"); liveTxt.textContent = `↺ LIVE (-${Math.max(1, (n - 1) - idx)})`; }

  const playBtn = document.getElementById("tlPlay");
  playBtn.textContent = playTimer ? "⏸" : "▶";
  playBtn.classList.toggle("playing", Boolean(playTimer));
}

function renderPendingPrompts() {
  const el = document.getElementById("pendingPrompts");
  if (!el) return;
  const prompts = (mode === "live" && liveState && Array.isArray(liveState.pending_prompts))
    ? liveState.pending_prompts
    : [];
  if (!prompts.length) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "flex";
  el.innerHTML = prompts.map(p => {
    const isApproval = p.kind === "approval";
    const badge = isApproval ? "PLAN APPROVAL GATE" : "PENDING QUESTION";
    const agentLbl = escHtml(p.agent_label || p.agent_id || "Agent");
    const tsLbl = escHtml(fmtTime(p.ts));
    if (isApproval) {
      const art = escHtml(p.artifact || "Plan Artifact");
      const sum = escHtml(p.summary || "Agent is waiting for approval to continue the plan.");
      const opts = (p.options || ["Proceed", "Request Changes"]).map((o, i) => {
        const cls = i === 0 ? "pending-opt rec" : "pending-opt";
        return `<div class="${cls}"><span class="pending-opt-num">${i + 1}.</span>${escHtml(o)}</div>`;
      }).join("");
      return `
        <div class="pending-card approval">
          <div class="pending-head">
            <div class="pending-head-left">
              <span class="pending-badge">${badge}</span>
              <strong style="font-size:12.5px;color:#f8fafc;">${agentLbl}</strong>
              <span class="pill">${art}</span>
              <span class="sub">${tsLbl}</span>
            </div>
            <span class="pending-hint">Respond in Antigravity to continue</span>
          </div>
          <div class="pending-summary">${sum}</div>
          <div class="pending-opts">${opts}</div>
        </div>
      `;
    }
    const qsHtml = (p.questions || []).map((q, qi) => {
      const multiTag = q.is_multi_select ? ` <span class="pill">Multi-select</span>` : "";
      const optsHtml = (q.options && q.options.length)
        ? `<div class="pending-opts">${q.options.map((o, oi) => {
            const isRec = /^\(Recommended\)/i.test(o);
            return `<div class="pending-opt${isRec ? " rec" : ""}"><span class="pending-opt-num">${oi + 1}.</span>${escHtml(o)}</div>`;
          }).join("")}</div>`
        : "";
      return `
        <div style="display:flex;flex-direction:column;gap:5px;${qi > 0 ? "margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);" : ""}">
          <div class="pending-q-text">${escHtml(q.question || "Agent is asking a question")}${multiTag}</div>
          ${optsHtml}
        </div>
      `;
    }).join("");
    return `
      <div class="pending-card">
        <div class="pending-head">
          <div class="pending-head-left">
            <span class="pending-badge">${badge}</span>
            <strong style="font-size:12.5px;color:#f8fafc;">${agentLbl}</strong>
            <span class="sub">${tsLbl}</span>
          </div>
          <span class="pending-hint">Respond in Antigravity to continue</span>
        </div>
        ${qsHtml}
      </div>
    `;
  }).join("");
}

function renderAll() { renderPendingPrompts(); renderGraph(); renderMetrics(); renderFeed(); renderDefinitions(); renderTimeline(); }

function stopPlayback() { if (playTimer) { clearInterval(playTimer); playTimer = null; } renderTimeline(); }
function scrubTo(targetIdx, opts = {}) {
  const tl = getFullTimeline();
  if (!tl.length) return;
  const clamped = Math.max(0, Math.min(targetIdx, tl.length - 1));
  const prevIdx = playhead;
  playhead = clamped;
  if (mode === "live") liveTail = (clamped >= tl.length - 1) && !opts.forceHistory;
  const ev = tl[clamped];
  if (ev) {
    selectedEventId = ev.id;
    if (opts.inspect !== false) {
      document.getElementById("inspector").textContent =
        `[${ev.kind.toUpperCase()}] ${ev.from}${ev.kind === "tool" ? "" : " -> " + ev.to} (${fmtTs(ev.ts)})\n\n${ev.body || ev.title}`;
    }
  }
  renderAll();
  if (opts.animate && ev && ev.kind !== "tool" && clamped !== prevIdx) animatePacket(ev);
}
function snapToLive() {
  stopPlayback();
  if (mode !== "live") { document.getElementById("btnLive").click(); return; }
  const tl = getFullTimeline();
  liveTail = true; playhead = Math.max(0, tl.length - 1);
  renderAll();
}
function stepForward() {
  const tl = getFullTimeline();
  if (!tl.length) { stopPlayback(); return; }
  const cur = getEffectiveIndex();
  if (cur >= tl.length - 1) { stopPlayback(); if (mode === "live") { liveTail = true; renderAll(); } return; }
  const next = cur + 1;
  scrubTo(next, { animate: true });
  if (next >= tl.length - 1) { stopPlayback(); if (mode === "live") { liveTail = true; renderAll(); } }
}
function startPlayback() {
  const tl = getFullTimeline();
  if (!tl.length) return;
  if (getEffectiveIndex() >= tl.length - 1) { playhead = 0; liveTail = false; scrubTo(0, { animate: true }); }
  else { liveTail = false; }
  if (playTimer) clearInterval(playTimer);
  playTimer = setInterval(stepForward, Math.round(750 / SPEEDS[speedIdx]));
  renderTimeline();
}

const urlParams = new URLSearchParams(window.location.search);
const activeProjectParam = (urlParams.get("project") || "").trim();
const activeWorkspaceParam = (urlParams.get("workspace") || "").trim();

const devOpsBoardLink = document.getElementById("linkDevOpsBoard");
if (devOpsBoardLink) {
  devOpsBoardLink.href = `${window.location.protocol}//${window.location.hostname}:8766/#board`;
}

function syncLivePreviewLink() {
  const link = document.getElementById("livePreviewLink");
  if (!link) return;
  const proj = (sessionProjectFilter && sessionProjectFilter !== "ALL")
    ? sessionProjectFilter
    : (activeProjectParam && activeProjectParam.toUpperCase() !== "ALL" ? activeProjectParam : "");
  link.href = proj ? `/preview?project=${encodeURIComponent(proj)}` : "/preview";
}
syncLivePreviewLink();

let allSessions = [];
let boardProjects = [];
let currentSessionId = "";
let sessionProjectFilter = "ALL";
let sessionMultiOnly = true;
let sessionHideCompleted = false;
let sessionSearchQuery = "";

const PROJ_PALETTE = [
  ["#1e3a8a", "#93c5fd"],
  ["#064e3b", "#6ee7b7"],
  ["#581c87", "#d8b4fe"],
  ["#7c2d12", "#fdba74"],
  ["#164e63", "#67e8f9"],
  ["#701a75", "#f0abfc"],
  ["#365314", "#bef264"],
];
function projColors(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return PROJ_PALETTE[Math.abs(h) % PROJ_PALETTE.length];
}
function projPillHtml(name) {
  const proj = name || "General";
  const [bg, fg] = projColors(proj);
  return `<span class="proj-pill" style="background:${bg};color:${fg}">${escHtml(proj)}</span>`;
}
function waitBadgeHtml(s) {
  if (!s || (!s.is_waiting && !s.waiting_on)) return "";
  const reason = s.waiting_on || "Input";
  return `<span class="wait-badge" title="Waiting on ${escHtml(reason)}">⏳ Waiting: ${escHtml(reason)}</span>`;
}
function isMultiAgentSession(s) {
  return Boolean(s && (s.is_multi_agent || s.has_subagents || (s.subagent_count || 0) > 0));
}
function getProjectFilterEntries() {
  const base = sessionMultiOnly ? allSessions.filter(isMultiAgentSession) : allSessions;
  const counts = {};
  base.forEach(s => {
    const p = s.project || "General";
    counts[p] = (counts[p] || 0) + 1;
  });
  let entries;
  if (boardProjects.length > 0) {
    entries = boardProjects.map(bp => ({
      id: bp.id,
      label: bp.id,
      title: bp.display_name || bp.id,
      count: counts[bp.id] || 0,
    }));
    const validIds = new Set(entries.map(e => e.id));
    if (sessionProjectFilter !== "ALL" && !validIds.has(sessionProjectFilter)) {
      sessionProjectFilter = "ALL";
    }
  } else {
    entries = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([p, c]) => ({ id: p, label: p, title: p, count: c }));
    if (sessionProjectFilter !== "ALL" && !counts[sessionProjectFilter]) {
      sessionProjectFilter = "ALL";
    }
  }
  return { total: base.length, entries };
}
function syncProjectSelect() {
  const sel = document.getElementById("projectFilterSelect");
  if (!sel) return;
  const { total, entries } = getProjectFilterEntries();
  sel.innerHTML = [
    `<option value="ALL">All Projects (${total})</option>`,
    ...entries.map(e => `<option value="${escHtml(e.id)}" title="${escHtml(e.title)}">${escHtml(e.label)} (${e.count})</option>`),
  ].join("");
  sel.value = sessionProjectFilter;
  syncLivePreviewLink();
}
function updateSessionTrigger() {
  const btn = document.getElementById("sessionPickerBtn");
  if (!btn) return;
  const active = allSessions.find(s => s.id === currentSessionId) || allSessions[0];
  if (!active) {
    const filterLabel = activeProjectParam || activeWorkspaceParam;
    const emptyText = filterLabel ? `No sessions for ${filterLabel}` : "No sessions found";
    btn.innerHTML = `<span class="st-label">${escHtml(emptyText)}</span><span class="st-caret">▾</span>`;
    return;
  }
  const sub = isMultiAgentSession(active) ? `<span class="sub-badge">★ ${active.subagent_count}</span>` : "";
  const wait = waitBadgeHtml(active);
  btn.innerHTML = `${projPillHtml(active.project)}${wait}${sub}<span class="st-label">${escHtml(active.label)}</span><span class="st-caret">▾</span>`;
}
function renderSessionMenu() {
  const tabsEl = document.getElementById("sessionProjTabs");
  const listEl = document.getElementById("sessionList");
  if (!tabsEl || !listEl) return;

  const { total, entries } = getProjectFilterEntries();
  syncProjectSelect();

  tabsEl.innerHTML = [
    `<button type="button" class="proj-tab ${sessionProjectFilter === "ALL" ? "active" : ""}" data-proj="ALL">All (${total})</button>`,
    ...entries.map(e =>
      `<button type="button" class="proj-tab ${sessionProjectFilter === e.id ? "active" : ""}" data-proj="${escHtml(e.id)}" title="${escHtml(e.title)}">${escHtml(e.label)} (${e.count})</button>`
    ),
  ].join("");
  tabsEl.querySelectorAll(".proj-tab").forEach(b => {
    b.onclick = () => { sessionProjectFilter = b.dataset.proj; renderSessionMenu(); };
  });

  const q = sessionSearchQuery.trim().toLowerCase();
  const filtered = allSessions.filter(s => {
    if (sessionProjectFilter !== "ALL" && (s.project || "General") !== sessionProjectFilter) return false;
    if (sessionMultiOnly && !isMultiAgentSession(s)) return false;
    if (sessionHideCompleted && s.is_completed && !s.is_waiting) return false;
    if (q) {
      const hay = `${s.label || ""} ${s.project || ""} ${s.id || ""} ${s.waiting_on || ""} ${s.status || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    listEl.innerHTML = `<div class="session-empty">No matching sessions. Try clearing the search or filters.</div>`;
    return;
  }
  listEl.innerHTML = filtered.map(s => {
    const isActive = s.id === currentSessionId;
    const sub = s.has_subagents ? `<span class="sub-badge">★ ${s.subagent_count} agents</span>` : "";
    const wait = waitBadgeHtml(s);
    const when = s.updated_date || s.updated || "";
    return `<button type="button" class="session-item ${isActive ? "active" : ""}" data-sid="${s.id}">
      <div class="session-item-top">
        ${projPillHtml(s.project)}
        ${wait}
        ${sub}
        <span style="color:var(--muted);font-family:monospace;font-size:10px;">${s.id.slice(0, 8)}</span>
        <span class="session-item-time">${escHtml(when)}</span>
      </div>
      <div class="session-item-title">${escHtml(s.label)}</div>
    </button>`;
  }).join("");
  listEl.querySelectorAll(".session-item").forEach(item => {
    item.onclick = () => {
      const sid = item.dataset.sid;
      document.getElementById("sessionPickerMenu").classList.remove("open");
      if (sid && sid !== currentSessionId) startLive(sid);
    };
  });
}

function startLive(sessionId = "") {
  if (sse) { sse.close(); sse = null; }
  stopPlayback(); seenEventIds = new Set(); liveTail = true; playhead = 0; lastTicksSig = "";
  let firstBatch = true;
  const params = new URLSearchParams();
  if (sessionId) params.set("session", sessionId);
  if (activeProjectParam) params.set("project", activeProjectParam);
  if (activeWorkspaceParam) params.set("workspace", activeWorkspaceParam);
  const qs = params.toString();
  sse = new EventSource("/api/stream" + (qs ? "?" + qs : ""));
  sse.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    liveState = data;
    const sessions = data.sessions || [];
    const nextBoardProjects = Array.isArray(data.board_projects) ? data.board_projects : [];
    currentSessionId = sessions.length ? (data.session_id || currentSessionId) : "";
    const bpSig = nextBoardProjects.map(bp => bp.id || "").join("|");
    const sig = bpSig + "::" + sessions.map(s => `${s.id}:${s.mtime}:${s.project || ""}:${s.status || ""}:${s.waiting_on || ""}:${s.is_multi_agent ? 1 : 0}`).join(",");
    const wrap = document.getElementById("sessionPickerWrap");
    if (wrap && wrap.dataset.sig !== sig) {
      wrap.dataset.sig = sig;
      boardProjects = nextBoardProjects;
      allSessions = sessions;
      syncProjectSelect();
      if (document.getElementById("sessionPickerMenu").classList.contains("open")) renderSessionMenu();
    } else if (!sessions.length) {
      boardProjects = nextBoardProjects;
      allSessions = [];
      syncProjectSelect();
    }
    updateSessionTrigger();
    const newPackets = [];
    (data.events || []).forEach(ev => {
      if (!seenEventIds.has(ev.id)) { seenEventIds.add(ev.id); if (!firstBatch) newPackets.push(ev); }
    });
    firstBatch = false;
    const tl = data.activity || [];
    if (liveTail) playhead = Math.max(0, tl.length - 1);
    const filterLabel = activeProjectParam || activeWorkspaceParam;
    document.getElementById("statusSub").textContent = sessions.length
      ? `Live SSE · ${data.server_time} · session ${data.session_id?.slice(0,8) || "none"} · ${(data.agent_order || []).length} agent(s)`
      : (filterLabel
          ? `Live SSE · ${data.server_time} · No sessions found for ${filterLabel}`
          : `Live SSE · ${data.server_time} · No sessions found`);
    renderAll();
    if (liveTail) newPackets.slice(-6).forEach((ev, i) => setTimeout(() => animatePacket(ev), i * 180));
  };
}

const trackWrap = document.getElementById("tlTrackWrap");
const hoverTip = document.getElementById("tlHover");
function idxFromPointer(clientX) {
  const tl = getFullTimeline();
  if (tl.length <= 1) return 0;
  const rect = trackWrap.getBoundingClientRect();
  return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (tl.length - 1));
}
trackWrap.addEventListener("pointerdown", (e) => {
  stopPlayback(); isDragging = true; trackWrap.classList.add("dragging");
  trackWrap.setPointerCapture(e.pointerId);
  scrubTo(idxFromPointer(e.clientX), { animate: true });
});
trackWrap.addEventListener("pointermove", (e) => {
  const tl = getFullTimeline();
  if (!tl.length) { hoverTip.style.display = "none"; return; }
  const rect = trackWrap.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  const idx = idxFromPointer(e.clientX), ev = tl[idx];
  if (ev) {
    const startEp = tl[0].epoch || 0, rel = fmtDuration((ev.epoch || startEp) - startEp);
    const states = getAgentStates();
    const fromL = states[ev.from]?.label || ev.from;
    const route = ev.kind === "tool" ? fromL : `${fromL} → ${states[ev.to]?.label || ev.to}`;
    hoverTip.innerHTML = `<b>${rel}</b> · ${route} — ${String(trunc(ev.title || "", 42)).replace(/</g, "&lt;")}`;
    hoverTip.style.left = `${Math.max(90, Math.min(rect.width - 90, x))}px`;
    hoverTip.style.display = "block";
  }
  if (isDragging) scrubTo(idx, { animate: false });
});
trackWrap.addEventListener("pointerup", () => { isDragging = false; trackWrap.classList.remove("dragging"); });
trackWrap.addEventListener("pointerleave", () => { if (!isDragging) hoverTip.style.display = "none"; });

document.getElementById("tlStart").onclick = () => { stopPlayback(); scrubTo(0, { forceHistory: true, animate: true }); };
document.getElementById("tlPrev").onclick = () => { stopPlayback(); scrubTo(getEffectiveIndex() - 1, { forceHistory: true, animate: true }); };
document.getElementById("tlNext").onclick = () => { stopPlayback(); stepForward(); };
document.getElementById("tlPlay").onclick = () => { if (playTimer) stopPlayback(); else startPlayback(); };
document.getElementById("tlSpeed").onclick = (e) => {
  speedIdx = (speedIdx + 1) % SPEEDS.length; e.target.textContent = `${SPEEDS[speedIdx]}×`;
  if (playTimer) { stopPlayback(); startPlayback(); }
};
document.getElementById("tlLiveBtn").onclick = snapToLive;

window.addEventListener("keydown", (e) => {
  if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); if (playTimer) stopPlayback(); else startPlayback(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); stopPlayback(); scrubTo(getEffectiveIndex() - 1, { forceHistory: true, animate: true }); }
  else if (e.key === "ArrowRight") { e.preventDefault(); stopPlayback(); stepForward(); }
  else if (e.key === "Home") { e.preventDefault(); stopPlayback(); scrubTo(0, { forceHistory: true, animate: true }); }
  else if (e.key === "l" || e.key === "L") snapToLive();
});

document.getElementById("btnLive").onclick = () => {
  mode = "live"; stopPlayback(); lastTicksSig = "";
  document.getElementById("btnLive").classList.add("active");
  document.getElementById("btnSim").classList.remove("active");
  document.getElementById("sessionPickerWrap").style.display = "inline-block";
  const projSel = document.getElementById("projectFilterSelect");
  if (projSel) projSel.style.display = "";
  document.getElementById("statusDot").className = "pulse-dot";
  startLive(currentSessionId);
};
document.getElementById("btnSim").onclick = () => {
  mode = "sim"; stopPlayback(); lastTicksSig = "";
  if (sse) { sse.close(); sse = null; }
  playhead = 0; liveTail = false;
  document.getElementById("btnSim").classList.add("active");
  document.getElementById("btnLive").classList.remove("active");
  document.getElementById("sessionPickerWrap").style.display = "none";
  const projSel = document.getElementById("projectFilterSelect");
  if (projSel) projSel.style.display = "none";
  document.getElementById("sessionPickerMenu").classList.remove("open");
  document.getElementById("statusDot").className = "pulse-dot sim";
  document.getElementById("statusSub").textContent = "Demo Mode — press ▶ Play or drag the timeline scrubber";
  renderAll();
};
document.getElementById("projectFilterSelect").onchange = (e) => {
  sessionProjectFilter = e.target.value || "ALL";
  syncLivePreviewLink();
  renderSessionMenu();
};
document.getElementById("sessionPickerBtn").onclick = (e) => {
  e.stopPropagation();
  const menu = document.getElementById("sessionPickerMenu");
  const willOpen = !menu.classList.contains("open");
  menu.classList.toggle("open", willOpen);
  if (willOpen) {
    renderSessionMenu();
    const isTouchOrMobile = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768 || ("ontouchstart" in window);
    if (!isTouchOrMobile) {
      setTimeout(() => document.getElementById("sessionSearch")?.focus(), 20);
    }
  }
};
document.getElementById("sessionSearch").oninput = (e) => {
  sessionSearchQuery = e.target.value || "";
  renderSessionMenu();
};
document.getElementById("btnHideCompleted").onclick = (e) => {
  sessionHideCompleted = !sessionHideCompleted;
  e.target.classList.toggle("active-filter", sessionHideCompleted);
  e.target.setAttribute("aria-pressed", String(sessionHideCompleted));
  renderSessionMenu();
};
document.getElementById("btnMultiOnly").onclick = (e) => {
  sessionMultiOnly = !sessionMultiOnly;
  e.target.classList.toggle("active", sessionMultiOnly);
  e.target.setAttribute("aria-pressed", String(sessionMultiOnly));
  renderSessionMenu();
};
document.addEventListener("click", (e) => {
  const wrap = document.getElementById("sessionPickerWrap");
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById("sessionPickerMenu")?.classList.remove("open");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.getElementById("sessionPickerMenu")?.classList.remove("open");
    if (document.getElementById("paneTopology")?.classList.contains("is-fullscreen")) {
      setTopologyFullscreen(false);
    }
  }
});
document.getElementById("btnClearNode").onclick = () => {
  selectedNode = null; selectedGroup = null;
  document.getElementById("btnClearNode").style.display = "none";
  document.getElementById("inspector").textContent = "Click any agent card, stream item, or scrub the timeline below to inspect.";
  renderAll();
};

function setTopoView(nextView) {
  topoView = nextView === "all" ? "all" : "grouped";
  try { localStorage.setItem("av_topo_view", topoView); } catch (_) {}
  document.getElementById("btnViewGrouped")?.classList.toggle("active", topoView === "grouped");
  document.getElementById("btnViewAll")?.classList.toggle("active", topoView === "all");
  selectedGroup = null;
  viewState.userModified = false;
  renderAll();
}
document.getElementById("btnViewGrouped").onclick = () => setTopoView("grouped");
document.getElementById("btnViewAll").onclick = () => setTopoView("all");
document.getElementById("btnViewGrouped")?.classList.toggle("active", topoView === "grouped");
document.getElementById("btnViewAll")?.classList.toggle("active", topoView === "all");

document.getElementById("btnZoomIn").onclick = () => zoomBy(0.8);
document.getElementById("btnZoomOut").onclick = () => zoomBy(1.25);
document.getElementById("btnZoomFit").onclick = () => fitGraph();

function syncFullscreenBtn() {
  const pane = document.getElementById("paneTopology");
  const btn = document.getElementById("btnFullscreen");
  if (!pane || !btn) return;
  const active = Boolean(document.fullscreenElement === pane || pane.classList.contains("is-fullscreen"));
  btn.classList.toggle("active", active);
  btn.setAttribute("aria-pressed", active ? "true" : "false");
  btn.textContent = active ? "✕ Exit" : "⛶ Fullscreen";
}

function setTopologyFullscreen(wantFs) {
  const pane = document.getElementById("paneTopology");
  if (!pane) return;
  if (wantFs) {
    pane.classList.add("is-fullscreen");
    if (pane.requestFullscreen) {
      pane.requestFullscreen().catch(() => {});
    }
  } else {
    pane.classList.remove("is-fullscreen");
    if (document.fullscreenElement === pane && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }
  syncFullscreenBtn();
}

document.getElementById("btnFullscreen").onclick = () => {
  const pane = document.getElementById("paneTopology");
  const isFs = Boolean(document.fullscreenElement === pane || pane?.classList.contains("is-fullscreen"));
  setTopologyFullscreen(!isFs);
};
document.addEventListener("fullscreenchange", () => {
  const pane = document.getElementById("paneTopology");
  if (!document.fullscreenElement && pane) pane.classList.remove("is-fullscreen");
  syncFullscreenBtn();
});

// Pan & Zoom interactions on #graphWrap (mouse wheel, pointer drag, 2-finger pinch)
(function initPanZoom() {
  const wrap = document.getElementById("graphWrap");
  if (!wrap) return;
  const pointers = new Map();
  let dragStart = null;
  let didDrag = false;
  let pinchDist = null;

  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const cx = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
    const cy = rect.height ? (e.clientY - rect.top) / rect.height : 0.5;
    const factor = e.deltaY > 0 ? 1.12 : 0.89;
    zoomBy(factor, cx, cy);
  }, { passive: false });

  wrap.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, vx: viewState.x, vy: viewState.y };
      didDrag = false;
    } else if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      dragStart = null;
    }
  });

  wrap.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchDist) {
      const pts = Array.from(pointers.values());
      const nextDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (nextDist > 8) {
        zoomBy(pinchDist / nextDist, 0.5, 0.5);
        pinchDist = nextDist;
      }
      return;
    }
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (!didDrag && Math.hypot(dx, dy) < 5) return;
    didDrag = true;
    wrap.classList.add("panning");
    const rect = wrap.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scaleX = viewState.w / rect.width;
    const scaleY = viewState.h / rect.height;
    viewState.x = dragStart.vx - dx * scaleX;
    viewState.y = dragStart.vy - dy * scaleY;
    viewState.userModified = true;
    applyViewBox();
  });

  const endPtr = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = null;
    if (pointers.size === 0) {
      dragStart = null;
      wrap.classList.remove("panning");
    }
  };
  wrap.addEventListener("pointerup", endPtr);
  wrap.addEventListener("pointercancel", endPtr);
  wrap.addEventListener("click", (e) => {
    if (didDrag) { e.stopPropagation(); e.preventDefault(); didDrag = false; }
  }, true);
})();
document.getElementById("tabStream").onclick = () => setRightTab("stream");
document.getElementById("tabDefs").onclick = () => setRightTab("defs");
document.getElementById("mobTabTopo").onclick = () => setMobilePane("topology");
document.getElementById("mobTabStream").onclick = () => setMobilePane("stream");
document.getElementById("mobTabDefs").onclick = () => setMobilePane("defs");
document.getElementById("btnShowTools").onclick = (e) => { showTools = !showTools; e.target.classList.toggle("active", showTools); renderFeed(); };
document.querySelectorAll("#filterBar button").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("#filterBar button").forEach(x => x.classList.remove("active"));
    b.classList.add("active"); filterKind = b.dataset.f; renderFeed();
  };
});

if (urlParams.get("mode") === "sim") document.getElementById("btnSim").click();
else startLive(urlParams.get("session") || "");
</script>
</body>
</html>
"""

PREVIEW_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Design Preview Studio — Antigravity Agent Visualizer</title>
<style>
  :root {
    --bg: #07090f;
    --panel: #0e131f;
    --panel-2: #141c2e;
    --panel-3: #0a0f1a;
    --border: #1e2942;
    --border-hi: #344872;
    --text: #e8effa;
    --muted: #8b9bb8;
    --accent: #06b6d4;
    --accent-soft: rgba(6, 182, 212, 0.14);
    --live: #10b981;
    --live-soft: rgba(16, 185, 129, 0.14);
    --warn: #f59e0b;
    --danger: #f43f5e;
    --lead: #a855f7;
    --target-size: 30px;
  }
  @media (pointer: coarse) {
    :root { --target-size: 44px; }
  }
  * { box-sizing: border-box; }
  html {
    height: 100%;
    scroll-padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
    color-scheme: dark;
  }
  body {
    margin: 0;
    height: 100dvh;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    font-family: Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
    font-size: 13px;
    line-height: 1.45;
    overflow-wrap: break-word;
  }
  h1, h2, h3 { text-wrap: balance; margin: 0; }
  p, li { text-wrap: pretty; }
  :where(a, code) { overflow-wrap: anywhere; }

  /* Interactive target sizing */
  :where(button, select, .btn-link, [role="tab"]) {
    min-block-size: var(--target-size);
    font-family: inherit;
  }
  button, select, .btn-link {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.15s ease, background-color 0.15s ease, color 0.15s ease;
  }
  .btn-link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    text-decoration: none;
    white-space: nowrap;
  }
  button:hover:not(:disabled), select:hover:not(:disabled), .btn-link:hover {
    border-color: var(--border-hi);
    color: #fff;
  }
  button:focus-visible, select:focus-visible, textarea:focus-visible, .btn-link:focus-visible, [tabindex="0"]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Header Bar */
  header.studio-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    padding: max(8px, env(safe-area-inset-top, 0px)) max(14px, env(safe-area-inset-right, 0px)) 8px max(14px, env(safe-area-inset-left, 0px));
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .header-left, .header-right {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .back-link {
    background: #10192b;
    border-color: #263656;
    font-weight: 600;
  }
  .studio-title {
    font-size: clamp(0.88rem, 0.82rem + 0.3vw, 0.98rem);
    font-weight: 650;
    letter-spacing: -0.01em;
    color: #f8fafc;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .studio-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 999px;
    background: rgba(168, 85, 247, 0.16);
    border: 1px solid rgba(168, 85, 247, 0.4);
    color: #d8b4fe;
  }
  .selector-group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .selector-group select {
    max-width: 260px;
    min-width: 120px;
  }
  .live-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    min-block-size: var(--target-size);
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    background: var(--live-soft);
    border: 1px solid rgba(16, 185, 129, 0.42);
    color: #6ee7b7;
    white-space: nowrap;
  }
  .live-pill.updated {
    background: rgba(6, 182, 212, 0.2);
    border-color: rgba(6, 182, 212, 0.6);
    color: #67e8f9;
  }
  .live-pill.paused {
    background: rgba(245, 158, 11, 0.14);
    border-color: rgba(245, 158, 11, 0.45);
    color: #fcd34d;
  }
  .live-pill.offline {
    background: rgba(244, 63, 94, 0.14);
    border-color: rgba(244, 63, 94, 0.45);
    color: #fda4af;
  }
  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--live);
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
    animation: livePulse 2s infinite;
    flex-shrink: 0;
  }
  .live-pill.updated .live-dot { background: var(--accent); animation: none; }
  .live-pill.paused .live-dot { background: var(--warn); animation: none; }
  .live-pill.offline .live-dot { background: var(--danger); animation: none; }
  @keyframes livePulse {
    0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.65); }
    70% { box-shadow: 0 0 0 7px rgba(16, 185, 129, 0); }
    100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
  }

  /* Cover-screen Segmented Tabs (< 640px) */
  .mobile-tabs {
    display: none;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 6px max(10px, env(safe-area-inset-right, 0px)) 6px max(10px, env(safe-area-inset-left, 0px));
    gap: 6px;
    flex-shrink: 0;
  }
  .mobile-tabs [role="tab"] {
    position: relative;
    flex: 1 1 0;
    border: 1px solid var(--border);
    background: var(--panel-3);
    color: var(--muted);
    font-weight: 650;
    font-size: 12.5px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .mobile-tabs [role="tab"][aria-selected="true"] {
    background: #17233b;
    border-color: #2f4978;
    color: #f8fafc;
  }
  .mobile-tabs [role="tab"][aria-selected="true"]::after {
    content: "";
    position: absolute;
    inset: auto 10px 0 10px;
    border-block-end: 3px solid var(--accent);
    border-radius: 2px 2px 0 0;
  }
  .tab-count {
    font-size: 10.5px;
    font-family: ui-monospace, Consolas, monospace;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgba(6, 182, 212, 0.16);
    color: #67e8f9;
  }

  /* Main Studio Grid — Desktop (>= 1021px): Stage 1fr + Critique Sidebar 340px */
  main.studio-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: 12px;
    padding: 10px max(14px, env(safe-area-inset-right, 0px)) max(10px, env(safe-area-inset-bottom, 0px)) max(14px, env(safe-area-inset-left, 0px));
  }

  .pane {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  #paneStage { container: stage / inline-size; }
  #paneCritique { container: sidebar / inline-size; }

  /* Stage Toolbar & Presets */
  .stage-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--panel-3);
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .preset-strip {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
  }
  .preset-btn {
    position: relative;
    flex: 0 0 auto;
    white-space: nowrap;
    padding: 5px 10px;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--muted);
    background: #0d1424;
    border: 1px solid var(--border);
    border-radius: 7px;
  }
  .preset-btn[aria-pressed="true"] {
    background: #172742;
    border-color: var(--accent);
    color: #f8fafc;
  }
  .preset-btn[aria-pressed="true"]::after {
    content: "";
    position: absolute;
    inset: auto 8px 0 8px;
    border-block-end: 2px solid var(--accent);
  }
  .stage-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--muted);
    min-width: 0;
  }
  .stage-meta code {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 11px;
    color: #cbd5e1;
    background: #121a2d;
    padding: 2px 6px;
    border-radius: 5px;
    border: 1px solid var(--border);
  }

  /* Container query for narrow stage pane */
  @container stage (max-width: 560px) {
    .stage-toolbar { padding: 7px 9px; gap: 6px; }
    .stage-meta { width: 100%; justify-content: space-between; font-size: 10.5px; }
  }

  /* Stage Viewport */
  .stage-viewport {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: auto;
    background:
      radial-gradient(circle at 50% 40%, #11192c 0%, #070a12 75%);
    display: grid;
    place-items: center;
    padding: 16px;
    scroll-padding-bottom: 16px;
  }
  .stage-viewport.is-fit {
    padding: 0;
    display: flex;
  }

  .frame-shell {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    transition: width 0.2s ease, height 0.2s ease, transform 0.2s ease;
    max-width: 100%;
  }
  .frame-shell.preset-fit {
    width: 100%;
    height: 100%;
  }
  .frame-shell.preset-fit .bezel-wrap {
    width: 100%;
    height: 100%;
  }
  .frame-shell.preset-fit iframe {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  /* 16:9 TV Bezel */
  .frame-shell.preset-tv169 {
    width: min(100%, 1120px);
    min-width: 480px;
    aspect-ratio: 16 / 9;
    max-height: 100%;
  }
  .frame-shell.preset-tenfoot {
    width: min(100%, 1120px);
    min-width: 480px;
    aspect-ratio: 16 / 9;
    max-height: 100%;
    transform: scale(0.72);
    transform-origin: center center;
  }
  .bezel-wrap {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .tv-bezel {
    position: relative;
    width: 100%;
    height: 100%;
    padding: 12px 12px 18px 12px;
    border-radius: 16px;
    background: linear-gradient(160deg, #1d2433 0%, #0d111a 48%, #151b28 100%);
    border: 2px solid #2b354d;
    box-shadow:
      0 22px 54px rgba(0, 0, 0, 0.72),
      0 0 0 1px rgba(255, 255, 255, 0.05) inset,
      0 2px 0 rgba(255, 255, 255, 0.07) inset;
  }
  .tv-bezel::after {
    content: "";
    position: absolute;
    bottom: 6px;
    left: 50%;
    transform: translateX(-50%);
    width: 26px;
    height: 3px;
    border-radius: 999px;
    background: #38bdf8;
    box-shadow: 0 0 8px rgba(56, 189, 248, 0.7);
  }
  .tv-bezel iframe {
    width: 100%;
    height: 100%;
    border-radius: 6px;
    background: #05070c;
  }

  /* Fold Open (760px) & Mobile (390px) frames */
  .frame-shell.preset-fold {
    width: 760px;
    height: min(100%, 760px);
    min-height: 440px;
    flex-shrink: 0;
  }
  .frame-shell.preset-mobile {
    width: 390px;
    height: min(100%, 844px);
    min-height: 520px;
    flex-shrink: 0;
  }
  .device-frame {
    width: 100%;
    height: 100%;
    padding: 10px;
    border-radius: 20px;
    background: linear-gradient(180deg, #1a2234 0%, #0f1522 100%);
    border: 2px solid #2b3854;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.65);
  }
  .device-frame iframe {
    width: 100%;
    height: 100%;
    border-radius: 12px;
    background: #05070c;
  }

  iframe#mockupFrame {
    display: block;
    border: 0;
    background: #0b1020;
  }

  .scale-tag {
    position: absolute;
    top: 10px;
    right: 12px;
    z-index: 4;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(14, 19, 31, 0.88);
    border: 1px solid var(--border-hi);
    color: #cbd5e1;
    pointer-events: none;
  }

  .empty-stage {
    max-width: 460px;
    text-align: center;
    padding: 24px;
    border-radius: 12px;
    background: rgba(14, 19, 31, 0.9);
    border: 1px solid var(--border);
  }
  .empty-stage h2 { font-size: 15px; margin-bottom: 8px; color: #f8fafc; }
  .empty-stage p { margin: 0 0 8px; color: var(--muted); font-size: 12.5px; }

  /* Critique & Guidance Sidebar */
  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 13px;
    border-bottom: 1px solid var(--border);
    background: var(--panel-3);
    flex-shrink: 0;
  }
  .sidebar-head h2 {
    font-size: 13px;
    font-weight: 650;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .file-pill {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 10.5px;
    padding: 2px 6px;
    border-radius: 5px;
    background: #131c31;
    border: 1px solid #263554;
    color: #93c5fd;
  }

  .composer {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex-shrink: 0;
    background: #0c111d;
  }
  .chip-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .chip-btn {
    min-block-size: 26px;
    padding: 3px 8px;
    font-size: 11px;
    font-weight: 550;
    border-radius: 999px;
    background: #131c31;
    border: 1px solid #263554;
    color: #cbd5e1;
    white-space: nowrap;
  }
  .chip-btn:hover {
    border-color: var(--accent);
    background: #182744;
    color: #fff;
  }
  textarea#critiqueInput {
    width: 100%;
    min-height: 76px;
    max-height: 180px;
    resize: vertical;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: #080c15;
    color: var(--text);
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1.45;
  }
  textarea#critiqueInput::placeholder { color: #64748b; }
  .composer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .kbd-hint {
    font-size: 11px;
    color: var(--muted);
  }
  .kbd-hint kbd {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 10.5px;
    padding: 1px 5px;
    border-radius: 4px;
    background: #141d31;
    border: 1px solid var(--border);
    color: #cbd5e1;
  }
  .btn-primary {
    background: linear-gradient(180deg, #0891b2 0%, #0e7490 100%);
    border-color: #22d3ee;
    color: #f8fafc;
    font-weight: 650;
    padding: 6px 13px;
  }
  .btn-primary:hover:not(:disabled) {
    background: linear-gradient(180deg, #06b6d4 0%, #0891b2 100%);
    border-color: #67e8f9;
  }
  .save-status {
    font-size: 11.5px;
    min-height: 16px;
    color: var(--muted);
  }
  .save-status.ok { color: #6ee7b7; }
  .save-status.err { color: #fda4af; }

  @container sidebar (max-width: 310px) {
    .composer-actions { flex-direction: column; align-items: stretch; }
    .btn-primary { width: 100%; }
    .kbd-hint { display: none; }
  }

  /* Feedback History Log */
  .feedback-log {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 10px 12px calc(14px + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: 8px;
    scroll-padding-bottom: 24px;
  }
  .fb-empty {
    color: var(--muted);
    font-size: 12px;
    padding: 12px;
    border-radius: 8px;
    border: 1px dashed var(--border);
    background: rgba(10, 15, 26, 0.6);
  }
  .fb-card {
    background: #0b101d;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 9px 11px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .fb-heading {
    font-size: 11.5px;
    font-weight: 650;
    color: #67e8f9;
    font-family: ui-monospace, Consolas, monospace;
    border-bottom: 1px solid rgba(30, 41, 66, 0.7);
    padding-bottom: 4px;
  }
  .fb-body {
    font-size: 12.5px;
    color: #dbe6f7;
    white-space: pre-wrap;
  }
  .fb-list {
    margin: 0;
    padding-left: 16px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12.5px;
    color: #dbe6f7;
  }
  .fb-inline-code {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 11.5px;
    padding: 1px 4px;
    border-radius: 4px;
    background: #141e33;
    color: #93c5fd;
  }

  /* Touch ergonomics */
  @media (pointer: coarse) {
    .kbd-hint { display: none; }
    .chip-btn { min-block-size: 44px; padding: 6px 12px; font-size: 12px; }
    .preset-btn { min-block-size: 44px; padding: 6px 12px; font-size: 12px; }
  }

  /* Foldable Open / Tablet (640px – 1020px, e.g. Galaxy Z Fold 7 unfolded) */
  @media (max-width: 1020px) and (min-width: 640px) {
    header.studio-header {
      padding: max(8px, env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) 8px max(12px, env(safe-area-inset-left, 0px));
    }
    main.studio-grid {
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      padding: 8px max(12px, env(safe-area-inset-right, 0px)) max(10px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px));
    }
    .frame-shell.preset-tv169,
    .frame-shell.preset-tenfoot {
      min-width: 300px;
    }
  }

  /* Dual-screen / Hinge-aware split when browser exposes Viewport Segments API */
  @media (horizontal-viewport-segments: 2) {
    main.studio-grid {
      grid-template-columns: env(viewport-segment-width 0 0) env(viewport-segment-width 1 0);
      gap: max(12px, calc(env(viewport-segment-left 1 0) - env(viewport-segment-right 0 0)));
    }
  }

  /* Cover Screen / Mobile (< 640px, e.g. Galaxy Z Fold 7 closed) */
  @media (max-width: 639px) {
    header.studio-header {
      padding: max(8px, env(safe-area-inset-top, 0px)) max(10px, env(safe-area-inset-right, 0px)) 8px max(10px, env(safe-area-inset-left, 0px));
      gap: 7px;
    }
    .header-left, .header-right, .selector-group {
      width: 100%;
    }
    .selector-group select {
      flex: 1 1 130px;
      max-width: none;
      min-width: 0;
    }
    .mobile-tabs { display: flex; }
    .kbd-hint { display: none; }

    main.studio-grid {
      display: flex;
      flex-direction: column;
      gap: 0;
      padding: 8px max(10px, env(safe-area-inset-right, 0px)) max(10px, env(safe-area-inset-bottom, 0px)) max(10px, env(safe-area-inset-left, 0px));
    }
    main.studio-grid[data-mobile-tab="preview"] #paneCritique { display: none; }
    main.studio-grid[data-mobile-tab="critique"] #paneStage { display: none; }
    .pane { flex: 1; min-height: 0; }

    .preset-strip {
      flex-wrap: nowrap;
      overflow-x: auto;
      padding-bottom: 2px;
    }
    .chip-strip {
      flex-wrap: nowrap;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      padding-bottom: 2px;
    }
    .chip-btn { flex: 0 0 auto; }
    .stage-viewport { padding: 10px; }
  }
</style>
</head>
<body>
<header class="studio-header">
  <div class="header-left">
    <a class="btn-link back-link" href="/" title="Back to Antigravity Agent Visualizer">← Agent Visualizer</a>
    <h1 class="studio-title">Design Preview Studio <span class="studio-badge">LIVE</span></h1>
  </div>
  <div class="header-right">
    <div class="selector-group">
      <select id="projectSelect" aria-label="Filter mockups by project" title="Filter mockups by project">
        <option value="ALL">All Projects</option>
      </select>
      <select id="mockupSelect" aria-label="Select design mockup" title="Select design mockup">
        <option value="">Loading mockups…</option>
      </select>
    </div>
    <span id="liveStatusPill" class="live-pill" role="status" aria-live="polite">
      <span class="live-dot" aria-hidden="true"></span>
      <span id="liveStatusText">LIVE · Watching</span>
    </span>
    <button id="btnReload" type="button" title="Reload mockup iframe now">Reload</button>
    <a id="openRawLink" class="btn-link" href="#" target="_blank" rel="noopener" title="Open raw mockup HTML in a new tab">Open Raw ↗</a>
  </div>
</header>

<nav class="mobile-tabs" role="tablist" aria-label="Preview studio views">
  <button id="tabPreview" type="button" role="tab" aria-selected="true" tabindex="0">Preview</button>
  <button id="tabCritique" type="button" role="tab" aria-selected="false" tabindex="-1">Critique <span id="tabFeedbackCount" class="tab-count" style="display:none;">0</span></button>
</nav>

<main id="studioGrid" class="studio-grid" data-mobile-tab="preview">
  <section id="paneStage" class="pane" aria-label="Mockup preview stage">
    <div class="stage-toolbar">
      <div class="preset-strip" role="group" aria-label="Viewport aspect presets">
        <button class="preset-btn" type="button" data-preset="fit" aria-pressed="true">Fit / Fill</button>
        <button class="preset-btn" type="button" data-preset="tv169" aria-pressed="false">16:9 TV</button>
        <button class="preset-btn" type="button" data-preset="tenfoot" aria-pressed="false">10-Foot Scale</button>
        <button class="preset-btn" type="button" data-preset="fold" aria-pressed="false">Fold Open</button>
        <button class="preset-btn" type="button" data-preset="mobile" aria-pressed="false">Mobile</button>
      </div>
      <div class="stage-meta">
        <code id="metaPath">No mockup selected</code>
        <span id="metaInfo"></span>
      </div>
    </div>

    <div id="stageViewport" class="stage-viewport is-fit" role="region" tabindex="0" aria-label="Interactive mockup preview canvas">
      <div id="scaleTag" class="scale-tag" style="display:none;">10-Foot · 72%</div>
      <div id="frameShell" class="frame-shell preset-fit" style="display:none;">
        <div id="bezelWrap" class="bezel-wrap">
          <iframe id="mockupFrame" title="Live design mockup preview"></iframe>
        </div>
      </div>
      <div id="emptyStage" class="empty-stage">
        <h2>No Design Mockups Found</h2>
        <p>Select another project or add an HTML mockup file to a workspace directory (e.g. <code>themes/</code>, <code>mockups/</code>, <code>previews/</code>, or <code>ui/</code>).</p>
        <p>This studio polls automatically every 1.2s and hot-reloads whenever a mockup file changes on disk.</p>
      </div>
    </div>
  </section>

  <aside id="paneCritique" class="pane" aria-label="Critique and feedback log">
    <div class="sidebar-head">
      <h2>Critique &amp; Guidance <span id="critiqueCount" class="tab-count" style="display:none;">0</span></h2>
      <span class="file-pill">FEEDBACK.md</span>
    </div>

    <form id="critiqueForm" class="composer">
      <div class="chip-strip" role="group" aria-label="Quick critique chips">
        <button class="chip-btn" type="button" data-chip="Increase contrast">Increase contrast</button>
        <button class="chip-btn" type="button" data-chip="Tighten spacing">Tighten spacing</button>
        <button class="chip-btn" type="button" data-chip="Too cluttered">Too cluttered</button>
        <button class="chip-btn" type="button" data-chip="Font too small">Font too small</button>
        <button class="chip-btn" type="button" data-chip="Better hierarchy">Better hierarchy</button>
        <button class="chip-btn" type="button" data-chip="Looks great!">Looks great!</button>
      </div>
      <textarea id="critiqueInput" rows="3" placeholder="Add critique or design guidance for this mockup… (saved to sibling FEEDBACK.md)" aria-label="Critique note"></textarea>
      <div class="composer-actions">
        <span class="kbd-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> to save</span>
        <button id="btnSaveCritique" class="btn-primary" type="submit">Save Critique</button>
      </div>
      <div id="saveStatus" class="save-status" role="status" aria-live="polite"></div>
    </form>

    <div id="feedbackLog" class="feedback-log" aria-label="Saved feedback history">
      <div class="fb-empty">No critique entries yet for this mockup.</div>
    </div>
  </aside>
</main>

<script>
const POLL_MS = 1200;

const urlParams = new URLSearchParams(window.location.search);
let selectedProject = (urlParams.get("project") || "ALL").trim() || "ALL";
let selectedMockupId = (urlParams.get("id") || "").trim();

let activePreset = "fit";
let userPickedPreset = false;

let currentSelected = null;
let loadedMockupId = "";
let loadedMockupMtime = null;
let loadedFeedbackId = "";
let loadedFeedbackMtime = null;
let loadedFeedbackText = null;
let pollTimer = null;
let pollInFlight = false;

const projectSelect = document.getElementById("projectSelect");
const mockupSelect = document.getElementById("mockupSelect");
const liveStatusPill = document.getElementById("liveStatusPill");
const liveStatusText = document.getElementById("liveStatusText");
const btnReload = document.getElementById("btnReload");
const openRawLink = document.getElementById("openRawLink");
const studioGrid = document.getElementById("studioGrid");
const tabPreview = document.getElementById("tabPreview");
const tabCritique = document.getElementById("tabCritique");
const tabFeedbackCount = document.getElementById("tabFeedbackCount");
const critiqueCount = document.getElementById("critiqueCount");
const stageViewport = document.getElementById("stageViewport");
const scaleTag = document.getElementById("scaleTag");
const frameShell = document.getElementById("frameShell");
const bezelWrap = document.getElementById("bezelWrap");
const mockupFrame = document.getElementById("mockupFrame");
const emptyStage = document.getElementById("emptyStage");
const metaPath = document.getElementById("metaPath");
const metaInfo = document.getElementById("metaInfo");
const critiqueForm = document.getElementById("critiqueForm");
const critiqueInput = document.getElementById("critiqueInput");
const btnSaveCritique = document.getElementById("btnSaveCritique");
const saveStatus = document.getElementById("saveStatus");
const feedbackLog = document.getElementById("feedbackLog");
const presetButtons = Array.from(document.querySelectorAll(".preset-btn"));

function encodeMockupId(id) {
  return String(id || "").split("/").map(seg => encodeURIComponent(seg)).join("/");
}

function formatClock(epochSec) {
  if (!epochSec) return new Date().toTimeString().slice(0, 8);
  const d = new Date(Number(epochSec) * 1000);
  if (Number.isNaN(d.getTime())) return new Date().toTimeString().slice(0, 8);
  return d.toTimeString().slice(0, 8);
}

function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function setLiveStatus(state, label) {
  liveStatusPill.className = "live-pill" + (state ? ` ${state}` : "");
  liveStatusText.textContent = label;
}

function syncUrlParams() {
  const params = new URLSearchParams();
  if (selectedProject && selectedProject.toUpperCase() !== "ALL") {
    params.set("project", selectedProject);
  }
  if (selectedMockupId) {
    params.set("id", selectedMockupId);
  }
  const qs = params.toString();
  const nextUrl = qs ? `/preview?${qs}` : "/preview";
  if (window.location.pathname + window.location.search !== nextUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
}

function isThemeMockup(m) {
  if (!m) return false;
  if (m.has_theme_json) return true;
  const rel = String(m.rel_path || "");
  const id = String(m.id || "");
  return /(^|\/)themes(\/|$)/i.test(rel) || /(^|\/)themes(\/|$)/i.test(id);
}

function applyPreset(preset, isManual) {
  activePreset = preset || "fit";
  if (isManual) userPickedPreset = true;

  presetButtons.forEach(btn => {
    btn.setAttribute("aria-pressed", String(btn.dataset.preset === activePreset));
  });

  stageViewport.classList.toggle("is-fit", activePreset === "fit");
  frameShell.className = `frame-shell preset-${activePreset}`;
  scaleTag.style.display = activePreset === "tenfoot" ? "" : "none";

  if (activePreset === "tv169" || activePreset === "tenfoot") {
    bezelWrap.className = "bezel-wrap tv-bezel";
  } else if (activePreset === "fold" || activePreset === "mobile") {
    bezelWrap.className = "bezel-wrap device-frame";
  } else {
    bezelWrap.className = "bezel-wrap";
  }
}

presetButtons.forEach(btn => {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset, true));
});

/* Mobile Segmented Tabs */
function setMobileTab(tabName) {
  const isPreview = tabName !== "critique";
  studioGrid.dataset.mobileTab = isPreview ? "preview" : "critique";
  tabPreview.setAttribute("aria-selected", String(isPreview));
  tabPreview.tabIndex = isPreview ? 0 : -1;
  tabCritique.setAttribute("aria-selected", String(!isPreview));
  tabCritique.tabIndex = isPreview ? -1 : 0;
}

tabPreview.addEventListener("click", () => setMobileTab("preview"));
tabCritique.addEventListener("click", () => setMobileTab("critique"));
[tabPreview, tabCritique].forEach(tab => {
  tab.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = tab === tabPreview ? tabCritique : tabPreview;
      setMobileTab(next === tabPreview ? "preview" : "critique");
      next.focus();
    }
  });
});

/* Safe DOM-based FEEDBACK.md rendering (zero raw innerHTML / zero XSS) */
function appendFormattedInline(parent, text) {
  const str = String(text || "");
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIdx = 0;
  let match;
  while ((match = regex.exec(str)) !== null) {
    if (match.index > lastIdx) {
      parent.appendChild(document.createTextNode(str.slice(lastIdx, match.index)));
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      const codeEl = document.createElement("code");
      codeEl.className = "fb-inline-code";
      codeEl.textContent = token.slice(1, -1);
      parent.appendChild(codeEl);
    } else if (token.startsWith("**") && token.endsWith("**")) {
      const strongEl = document.createElement("strong");
      strongEl.textContent = token.slice(2, -2);
      parent.appendChild(strongEl);
    }
    lastIdx = regex.lastIndex;
  }
  if (lastIdx < str.length) {
    parent.appendChild(document.createTextNode(str.slice(lastIdx)));
  }
}

function renderFeedbackLog(markdownText) {
  feedbackLog.textContent = "";
  const raw = String(markdownText || "").trim();
  if (!raw) {
    const empty = document.createElement("div");
    empty.className = "fb-empty";
    empty.textContent = currentSelected
      ? "No critique entries yet for this mockup. Use the chips or composer above to write to FEEDBACK.md."
      : "Select a mockup to view or record FEEDBACK.md notes.";
    feedbackLog.appendChild(empty);
    tabFeedbackCount.style.display = "none";
    critiqueCount.style.display = "none";
    return;
  }

  const lines = raw.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      current = { heading: headingMatch[1].trim(), lines: [] };
      sections.push(current);
    } else {
      if (!current) {
        current = { heading: "", lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
    }
  }

  // Show newest entries first if multiple timestamped sections exist
  const ordered = sections.filter(s => s.heading || s.lines.some(l => l.trim())).reverse();
  const count = ordered.length;
  if (count > 0) {
    tabFeedbackCount.textContent = String(count);
    tabFeedbackCount.style.display = "";
    critiqueCount.textContent = String(count);
    critiqueCount.style.display = "";
  } else {
    tabFeedbackCount.style.display = "none";
    critiqueCount.style.display = "none";
  }

  for (const sec of ordered) {
    const card = document.createElement("article");
    card.className = "fb-card";

    if (sec.heading) {
      const h = document.createElement("div");
      h.className = "fb-heading";
      h.textContent = sec.heading;
      card.appendChild(h);
    }

    let ul = null;
    for (const l of sec.lines) {
      const trimmed = l.trim();
      if (!trimmed) {
        ul = null;
        continue;
      }
      const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
      if (bulletMatch) {
        if (!ul) {
          ul = document.createElement("ul");
          ul.className = "fb-list";
          card.appendChild(ul);
        }
        const li = document.createElement("li");
        appendFormattedInline(li, bulletMatch[1]);
        ul.appendChild(li);
      } else {
        ul = null;
        const p = document.createElement("div");
        p.className = "fb-body";
        appendFormattedInline(p, trimmed);
        card.appendChild(p);
      }
    }
    feedbackLog.appendChild(card);
  }
}

/* Quick-insert chips */
document.querySelectorAll(".chip-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const chip = btn.dataset.chip || "";
    if (!chip) return;
    const cur = critiqueInput.value;
    if (!cur.trim()) {
      critiqueInput.value = chip;
    } else if (cur.endsWith("\n") || cur.endsWith(" ")) {
      critiqueInput.value = cur + chip;
    } else {
      critiqueInput.value = `${cur}\n${chip}`;
    }
    if (!window.matchMedia("(pointer: coarse)").matches) {
      critiqueInput.focus();
    }
  });
});

async function submitCritique(e) {
  if (e) e.preventDefault();
  if (!currentSelected || !currentSelected.id) {
    saveStatus.className = "save-status err";
    saveStatus.textContent = "Select a mockup first.";
    return;
  }
  const note = critiqueInput.value.trim();
  if (!note) {
    saveStatus.className = "save-status err";
    saveStatus.textContent = "Enter a critique note before saving.";
    return;
  }

  btnSaveCritique.disabled = true;
  saveStatus.className = "save-status";
  saveStatus.textContent = "Saving to FEEDBACK.md…";

  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: currentSelected.id,
        view: activePreset,
        note,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    critiqueInput.value = "";
    loadedFeedbackId = currentSelected.id;
    loadedFeedbackMtime = data.mtime ?? null;
    loadedFeedbackText = data.feedback ?? "";
    renderFeedbackLog(loadedFeedbackText);
    saveStatus.className = "save-status ok";
    saveStatus.textContent = `Saved to FEEDBACK.md at ${formatClock(data.mtime)}`;
  } catch (err) {
    saveStatus.className = "save-status err";
    saveStatus.textContent = `Save failed: ${err.message || err}`;
  } finally {
    btnSaveCritique.disabled = false;
  }
}

critiqueForm.addEventListener("submit", submitCritique);
critiqueInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    submitCritique();
  }
});

function syncProjectSelectOptions(projects) {
  const list = Array.isArray(projects) ? projects : [];
  const total = list.reduce((acc, p) => acc + (Number(p.count) || 0), 0);
  const sig = list.map(p => `${p.id}:${p.count}`).join("|");
  if (projectSelect.dataset.sig !== sig) {
    projectSelect.dataset.sig = sig;
    projectSelect.textContent = "";

    const allOpt = document.createElement("option");
    allOpt.value = "ALL";
    allOpt.textContent = `All Projects (${total})`;
    projectSelect.appendChild(allOpt);

    for (const p of list) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.name || p.id} (${p.count || 0})`;
      projectSelect.appendChild(opt);
    }
  }
  const hasMatch = Array.from(projectSelect.options).some(o => o.value.toLowerCase() === selectedProject.toLowerCase());
  if (hasMatch) {
    const exact = Array.from(projectSelect.options).find(o => o.value.toLowerCase() === selectedProject.toLowerCase());
    if (exact) {
      selectedProject = exact.value;
      projectSelect.value = exact.value;
    }
  } else if (selectedProject.toUpperCase() === "ALL") {
    projectSelect.value = "ALL";
  }
}

function syncMockupSelectOptions(mockups, selected) {
  const list = Array.isArray(mockups) ? mockups : [];
  const sig = list.map(m => `${m.id}:${m.name}:${m.rel_path}`).join("|");
  if (mockupSelect.dataset.sig !== sig) {
    mockupSelect.dataset.sig = sig;
    mockupSelect.textContent = "";
    if (!list.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No mockups in project";
      mockupSelect.appendChild(opt);
    } else {
      for (const m of list) {
        const opt = document.createElement("option");
        opt.value = m.id;
        const projPrefix = selectedProject === "ALL" ? `[${m.project_name || m.project}] ` : "";
        opt.textContent = `${projPrefix}${m.name} — ${m.rel_path}`;
        mockupSelect.appendChild(opt);
      }
    }
  }
  if (selected && selected.id) {
    mockupSelect.value = selected.id;
  }
}

function loadMockupIframe(selected, forceReload) {
  if (!selected || !selected.id) {
    frameShell.style.display = "none";
    emptyStage.style.display = "";
    mockupFrame.removeAttribute("src");
    openRawLink.href = "#";
    openRawLink.setAttribute("aria-disabled", "true");
    metaPath.textContent = "No mockup selected";
    metaInfo.textContent = "";
    loadedMockupId = "";
    loadedMockupMtime = null;
    return;
  }

  emptyStage.style.display = "none";
  frameShell.style.display = "";

  const encodedId = encodeMockupId(selected.id);
  const rawUrl = `/api/mockup/${encodedId}`;
  openRawLink.href = rawUrl;
  openRawLink.removeAttribute("aria-disabled");

  metaPath.textContent = selected.rel_path || selected.name || selected.id;
  const infoParts = [];
  if (selected.theme_meta && selected.theme_meta.name) infoParts.push(selected.theme_meta.name);
  if (selected.size) infoParts.push(formatSize(selected.size));
  if (selected.mtime) infoParts.push(`mod ${formatClock(selected.mtime)}`);
  metaInfo.textContent = infoParts.join(" · ");

  const isSameMockup = loadedMockupId === selected.id;
  const mtimeChanged = loadedMockupMtime !== null && loadedMockupMtime !== selected.mtime;

  if (!isSameMockup && !userPickedPreset) {
    applyPreset(isThemeMockup(selected) ? "tv169" : "fit", false);
  }

  if (forceReload || !isSameMockup || loadedMockupMtime !== selected.mtime) {
    const cacheBust = forceReload ? `${selected.mtime || 0}-${Date.now()}` : String(selected.mtime || 0);
    mockupFrame.src = `${rawUrl}?t=${encodeURIComponent(cacheBust)}`;
    loadedMockupId = selected.id;
    loadedMockupMtime = selected.mtime;

    if (isSameMockup && mtimeChanged) {
      setLiveStatus("updated", `Updated ${formatClock(selected.mtime)}`);
    } else if (forceReload) {
      setLiveStatus("updated", `Updated ${formatClock(Date.now() / 1000)}`);
    } else {
      setLiveStatus("", "LIVE · Watching");
    }
  }
}

async function pollMockups(forceReload) {
  if (pollInFlight && !forceReload) return;
  pollInFlight = true;
  try {
    const params = new URLSearchParams();
    if (selectedProject && selectedProject.toUpperCase() !== "ALL") {
      params.set("project", selectedProject);
    }
    if (selectedMockupId) {
      params.set("id", selectedMockupId);
    }
    const qs = params.toString();
    const res = await fetch(qs ? `/api/mockups?${qs}` : "/api/mockups", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    syncProjectSelectOptions(data.projects);
    const mockups = Array.isArray(data.mockups) ? data.mockups : [];
    let selected = data.selected || null;

    // If selected mockup isn't in the filtered list (e.g. switched project), pick first available
    if (selected && mockups.length && !mockups.some(m => m.id === selected.id)) {
      selectedMockupId = mockups[0].id;
      pollInFlight = false;
      return pollMockups(forceReload);
    }

    currentSelected = selected;
    selectedMockupId = selected ? selected.id : "";
    syncMockupSelectOptions(mockups, selected);
    syncUrlParams();

    loadMockupIframe(selected, Boolean(forceReload));

    const nextFbId = selected ? selected.id : "";
    const nextFbMtime = selected ? (selected.feedback_mtime ?? null) : null;
    const nextFbText = selected ? (selected.feedback ?? "") : "";
    if (
      nextFbId !== loadedFeedbackId ||
      nextFbMtime !== loadedFeedbackMtime ||
      nextFbText !== loadedFeedbackText
    ) {
      loadedFeedbackId = nextFbId;
      loadedFeedbackMtime = nextFbMtime;
      loadedFeedbackText = nextFbText;
      renderFeedbackLog(nextFbText);
    }

    if (liveStatusPill.classList.contains("offline") || liveStatusPill.classList.contains("paused")) {
      setLiveStatus("", "LIVE · Watching");
    }
  } catch (err) {
    setLiveStatus("offline", "Offline · Retrying…");
  } finally {
    pollInFlight = false;
  }
}

projectSelect.addEventListener("change", () => {
  selectedProject = projectSelect.value || "ALL";
  selectedMockupId = "";
  userPickedPreset = false;
  syncUrlParams();
  pollMockups(false);
});

mockupSelect.addEventListener("change", () => {
  selectedMockupId = mockupSelect.value || "";
  userPickedPreset = false;
  syncUrlParams();
  pollMockups(false);
});

btnReload.addEventListener("click", () => {
  if (currentSelected) {
    loadMockupIframe(currentSelected, true);
  } else {
    pollMockups(true);
  }
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden) pollMockups(false);
  }, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    setLiveStatus("paused", "Paused (tab hidden)");
  } else {
    setLiveStatus("", "LIVE · Watching");
    pollMockups(false);
    startPolling();
  }
});

applyPreset("fit", false);
pollMockups(false);
startPolling();
</script>
</body>
</html>
"""


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        import sys
        _, exc, _ = sys.exc_info()
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def make_handler(
    brain_dir: Path,
    pinned_session: str,
    mockup_dirs: list[Path] | None = None,
) -> type[BaseHTTPRequestHandler]:
    extra_mockup_dirs = [Path(d) for d in (mockup_dirs or [])]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            pass

        def _send_bytes(self, body: bytes, content_type: str, status: int = HTTPStatus.OK) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, data: Any, status: int = HTTPStatus.OK) -> None:
            self._send_bytes(
                json.dumps(data).encode("utf-8"),
                "application/json; charset=utf-8",
                status=status,
            )

        def _serve_mockup_request(self, mockup_id: str, asset_rel: str = "") -> None:
            entry = _find_mockup_entry(brain_dir, mockup_id, mockup_dirs=extra_mockup_dirs)
            if not entry:
                self._send_bytes(b"Mockup Not Found", "text/plain; charset=utf-8", HTTPStatus.NOT_FOUND)
                return
            if asset_rel:
                status, target = _resolve_mockup_asset(entry["abs_dir"], asset_rel)
                if status != int(HTTPStatus.OK) or target is None:
                    msg = b"Forbidden" if status == int(HTTPStatus.FORBIDDEN) else b"Asset Not Found"
                    self._send_bytes(msg, "text/plain; charset=utf-8", status)
                    return
                ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
                if ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "image/svg+xml"):
                    ctype = f"{ctype}; charset=utf-8"
                self._send_bytes(target.read_bytes(), ctype, HTTPStatus.OK)
                return

            fpath: Path = entry["file_path"]
            if not fpath.is_file():
                self._send_bytes(b"Mockup Not Found", "text/plain; charset=utf-8", HTTPStatus.NOT_FOUND)
                return
            self._send_bytes(fpath.read_bytes(), "text/html; charset=utf-8", HTTPStatus.OK)

        def _serve_mockup_subpath(self, raw_rest: str) -> None:
            rest = unquote(raw_rest).lstrip("/")
            if not rest:
                self._send_bytes(b"Mockup Not Found", "text/plain; charset=utf-8", HTTPStatus.NOT_FOUND)
                return
            entries = _scan_mockup_entries(brain_dir, mockup_dirs=extra_mockup_dirs)
            # 1. Exact match on mockup id -> serve HTML
            for e in entries:
                if e["id"] == rest:
                    self._serve_mockup_request(e["id"])
                    return
            # 2. Match `<id>/<asset>` -> serve sibling asset
            for e in sorted(entries, key=lambda x: len(x["id"]), reverse=True):
                prefix = e["id"] + "/"
                if rest.startswith(prefix):
                    self._serve_mockup_request(e["id"], rest[len(prefix):])
                    return
            # 3. Match `<id_parent_dir>/<asset>` so relative URLs inside iframe `/api/mockup/<id>` resolve cleanly
            for e in sorted(entries, key=lambda x: len(x["id"]), reverse=True):
                parent_prefix = e["id"].rsplit("/", 1)[0] + "/" if "/" in e["id"] else ""
                if parent_prefix and rest.startswith(parent_prefix):
                    asset_rel = rest[len(parent_prefix):]
                    self._serve_mockup_request(e["id"], asset_rel)
                    return
            self._send_bytes(b"Mockup Not Found", "text/plain; charset=utf-8", HTTPStatus.NOT_FOUND)

        def _build_payload(self, requested_session: str, workspace: str = "", project: str = "") -> dict[str, Any]:
            all_sessions = list_recent_sessions(brain_dir, limit=120)
            if (workspace or project) and not requested_session:
                matched = [s for s in all_sessions if _session_matches_filter(s, workspace=workspace, project=project)]
                sid = matched[0]["id"] if matched else (all_sessions[0]["id"] if all_sessions else "")
            else:
                sid = requested_session or pinned_session or (all_sessions[0]["id"] if all_sessions else "")
            if sid:
                parsed = parse_live_session(brain_dir, sid)
            else:
                parsed = {"session_id": "", "root_id": "coordinator", "agent_order": [], "agents": {}, "edge_counts": {}, "events": [], "activity": []}
            parsed["sessions"] = all_sessions
            parsed["board_projects"] = [
                {"id": bp["id"], "display_name": bp["display_name"], "root": bp["root"]}
                for bp in _discover_board_projects()
            ]
            parsed["filter"] = {"project": project, "workspace": workspace}
            parsed["server_time"] = time.strftime("%H:%M:%S")
            return parsed

        def do_POST(self) -> None:
            u = urlparse(self.path)
            if u.path == "/api/feedback":
                try:
                    length = int(self.headers.get("Content-Length", "0") or "0")
                except ValueError:
                    length = 0
                raw = self.rfile.read(min(max(length, 0), 65536))
                try:
                    data = json.loads(raw.decode("utf-8"))
                except Exception:
                    self._send_json({"ok": False, "error": "invalid json"}, HTTPStatus.BAD_REQUEST)
                    return
                if not isinstance(data, dict):
                    self._send_json({"ok": False, "error": "invalid json payload"}, HTTPStatus.BAD_REQUEST)
                    return

                mockup_id = str(data.get("id") or "").strip()
                note = str(data.get("note") or "").strip()
                view = re.sub(r"[\r\n]+", " ", str(data.get("view") or "default")).strip() or "default"

                if not note:
                    self._send_json({"ok": False, "error": "empty note"}, HTTPStatus.BAD_REQUEST)
                    return
                entry = _find_mockup_entry(brain_dir, mockup_id, mockup_dirs=extra_mockup_dirs)
                if not entry:
                    self._send_json({"ok": False, "error": "unknown mockup id"}, HTTPStatus.NOT_FOUND)
                    return

                fb_path = Path(entry["abs_dir"]).resolve() / "FEEDBACK.md"
                stamp = time.strftime("%Y-%m-%d %H:%M:%S")
                try:
                    with fb_path.open("a", encoding="utf-8") as fp:
                        fp.write(f"### {stamp} (View: '{view}')\n{note}\n\n")
                    feedback_text = fb_path.read_text(encoding="utf-8", errors="replace")
                    mtime = float(fb_path.stat().st_mtime)
                except OSError as exc:
                    self._send_json({"ok": False, "error": f"write failed: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
                    return

                self._send_json(
                    {
                        "ok": True,
                        "id": entry["id"],
                        "feedback": feedback_text,
                        "mtime": mtime,
                    },
                    HTTPStatus.OK,
                )
                return

            self._send_bytes(b"Not Found", "text/plain; charset=utf-8", HTTPStatus.NOT_FOUND)

        def do_GET(self) -> None:
            u = urlparse(self.path)
            qs = parse_qs(u.query)
            req_session = (qs.get("session") or [""])[0]
            req_workspace = (qs.get("workspace") or [""])[0].strip()
            req_project = (qs.get("project") or [""])[0].strip()

            if u.path in ("/", "/index.html"):
                self._send_bytes(DASHBOARD_HTML.encode("utf-8"), "text/html; charset=utf-8")
            elif u.path == "/preview":
                self._send_bytes(PREVIEW_HTML.encode("utf-8"), "text/html; charset=utf-8")
            elif u.path == "/api/mockups":
                req_id = (qs.get("id") or [""])[0].strip()
                payload = discover_mockups(
                    brain_dir,
                    mockup_dirs=extra_mockup_dirs,
                    project=req_project,
                    selected_id=req_id,
                )
                self._send_json(payload)
            elif u.path == "/api/mockup":
                req_id = (qs.get("id") or [""])[0].strip()
                req_asset = (qs.get("asset") or [""])[0].strip()
                self._serve_mockup_request(req_id, req_asset)
            elif u.path.startswith("/api/mockup/"):
                self._serve_mockup_subpath(u.path[len("/api/mockup/"):])
            elif u.path == "/api/state":
                payload = self._build_payload(req_session, workspace=req_workspace, project=req_project)
                self._send_json(payload)
            elif u.path == "/api/sessions":
                sessions = list_recent_sessions(brain_dir, workspace=req_workspace, project=req_project)
                self._send_json(sessions)
            elif u.path == "/api/stream":
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                try:
                    while True:
                        payload = self._build_payload(req_session, workspace=req_workspace, project=req_project)
                        chunk = f"data: {json.dumps(payload)}\n\n".encode("utf-8")
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        time.sleep(1.5)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                    return
            else:
                self._send_bytes(b"Not Found", "text/plain", HTTPStatus.NOT_FOUND)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Antigravity Cross-Project Agent Visualizer")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--brain-dir", default=str(DEFAULT_BRAIN_DIR))
    parser.add_argument("--session", default="", help="Pin a specific Antigravity conversation UUID")
    parser.add_argument(
        "--mockup-dir",
        action="append",
        default=[],
        help="Additional directory to scan for HTML design mockups (repeatable)",
    )
    parser.add_argument("--open", action="store_true", help="Open the visualizer URL in the default browser")
    args = parser.parse_args()

    brain_dir = Path(args.brain_dir)
    mockup_dirs = [Path(d) for d in args.mockup_dir]
    server = QuietThreadingHTTPServer(
        (args.host, args.port),
        make_handler(brain_dir, args.session, mockup_dirs=mockup_dirs),
    )
    display_host = "127.0.0.1" if args.host in ("0.0.0.0", "::", "") else args.host
    url = f"http://{display_host}:{args.port}/"
    print(f"Antigravity Agent Visualizer running at {url} (bind={args.host}:{args.port}, brain={brain_dir})", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Antigravity Agent Visualizer.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
