#!/usr/bin/env python3
"""Automated verification suite for Antigravity Agent Visualizer.

Checks:
  1. Python syntax compilation
  2. Embedded dashboard & preview JavaScript syntax via `node --check` (if Node is available)
  3. Live transcript discovery & parsing across recent sessions
  4. Ephemeral HTTP server smoke test on `/`, `/api/sessions`, `/api/state`,
     `/preview`, `/api/mockups`, `/api/mockup`, sibling assets, traversal rejection,
     and `POST /api/feedback` (isolated in a temporary directory)
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import py_compile
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "agent_visualizer.py"


def _http_status(url: str) -> int:
    try:
        with urlopen(url, timeout=5) as r:
            return r.status
    except HTTPError as exc:
        return exc.code


def main() -> int:
    # 1. Python syntax
    py_compile.compile(str(SCRIPT), doraise=True)
    print("[PASS] py_compile")

    # Load module
    spec = importlib.util.spec_from_file_location("agent_visualizer", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # 2. Inline JS syntax via node --check (DASHBOARD_HTML + PREVIEW_HTML)
    js_targets = [
        ("DASHBOARD_HTML", mod.DASHBOARD_HTML),
        ("PREVIEW_HTML", mod.PREVIEW_HTML),
    ]
    if shutil.which("node"):
        for label, html_src in js_targets:
            scripts = re.findall(r"<script(?:\s[^>]*)?>(.*?)</script>", html_src, re.S)
            assert scripts, f"Missing <script> block in {label}"
            for idx, js_code in enumerate(scripts, start=1):
                proc = subprocess.run(
                    ["node", "--check"],
                    input=js_code,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
                if proc.returncode != 0:
                    print(f"[FAIL] node --check ({label} script #{idx}):\n{proc.stderr}", file=sys.stderr)
                    return 1
            print(f"[PASS] node --check ({label} JS)")
    else:
        print("[SKIP] node not installed")

    # 3. Transcript discovery
    sessions = mod.list_recent_sessions(mod.DEFAULT_BRAIN_DIR, limit=5)
    print(f"[PASS] list_recent_sessions -> {len(sessions)} session(s)")
    if sessions:
        top = sessions[0]
        parsed = mod.parse_live_session(mod.DEFAULT_BRAIN_DIR, top["id"])
        assert "agents" in parsed and "activity" in parsed and "edge_counts" in parsed
        for act in parsed["activity"]:
            assert isinstance(act.get("epoch"), (int, float)), f"Missing/invalid epoch in activity: {act}"
        print(
            f"[PASS] parse_live_session({top['id'][:8]}) -> "
            f"{len(parsed['agents'])} agent(s), {len(parsed['events'])} msg(s), {len(parsed['activity'])} activity"
        )

    # 4. Ephemeral HTTP server smoke test (port 0 = OS-assigned free port)
    #    Use an isolated temporary mockup directory so real user FEEDBACK.md files are never touched.
    with tempfile.TemporaryDirectory(prefix="av_smoke_mockups_") as tmp_dir:
        tmp_mockup_dir = Path(tmp_dir)
        mockup_html = (
            "<!DOCTYPE html><html><head><link rel='stylesheet' href='style.css'></head>"
            "<body><h1>QA Smoke Mockup</h1></body></html>"
        )
        mockup_css = "body { background: #10141c; color: #f8fafc; }\n"
        (tmp_mockup_dir / "MOCKUP.html").write_text(mockup_html, encoding="utf-8")
        (tmp_mockup_dir / "style.css").write_text(mockup_css, encoding="utf-8")

        server = mod.QuietThreadingHTTPServer(
            ("127.0.0.1", 0),
            mod.make_handler(mod.DEFAULT_BRAIN_DIR, "", mockup_dirs=[tmp_mockup_dir]),
        )
        port = server.server_address[1]
        base_url = f"http://127.0.0.1:{port}"
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        try:
            # 4a. Core dashboard & state endpoints
            with urlopen(f"{base_url}/", timeout=5) as r:
                body = r.read().decode("utf-8")
                assert r.status == 200 and "timelineBar" in body
            with urlopen(f"{base_url}/api/sessions", timeout=5) as r:
                sess_data = json.loads(r.read().decode("utf-8"))
                assert r.status == 200 and isinstance(sess_data, list)
            with urlopen(f"{base_url}/api/state", timeout=5) as r:
                data = json.loads(r.read().decode("utf-8"))
                assert r.status == 200 and "agents" in data and "sessions" in data
            print(f"[PASS] HTTP smoke test (/, /api/sessions, /api/state on ephemeral port {port})")

            # 4b. Live Design Mockup Preview studio HTML
            with urlopen(f"{base_url}/preview", timeout=5) as r:
                preview_body = r.read().decode("utf-8")
                assert (
                    r.status == 200
                    and "mockupFrame" in preview_body
                    and "critiqueInput" in preview_body
                    and "feedbackLog" in preview_body
                )
            print("[PASS] GET /preview returns PREVIEW_HTML (mockupFrame, critiqueInput, feedbackLog)")

            # 4c. Mockup discovery
            with urlopen(f"{base_url}/api/mockups", timeout=5) as r:
                mockups_payload = json.loads(r.read().decode("utf-8"))
                assert r.status == 200
                assert "mockups" in mockups_payload and "projects" in mockups_payload and "selected" in mockups_payload
            tmp_resolved = str(tmp_mockup_dir.resolve())
            matched = [
                m for m in mockups_payload["mockups"]
                if Path(m["abs_dir"]).resolve() == Path(tmp_resolved) and m["rel_path"].endswith("MOCKUP.html")
            ]
            assert matched, f"Temp mockup not discovered in /api/mockups: {mockups_payload['mockups']}"
            mockup_id = matched[0]["id"]
            print(f"[PASS] GET /api/mockups discovered temp fixture ({mockup_id})")

            # 4d. Mockup HTML serving via query param and subpath with Cache-Control: no-store
            with urlopen(f"{base_url}/api/mockup?id={quote(mockup_id, safe='')}&t=123", timeout=5) as r:
                html_q = r.read().decode("utf-8")
                cc_q = r.headers.get("Cache-Control", "")
                assert r.status == 200 and "QA Smoke Mockup" in html_q and "no-store" in cc_q
            with urlopen(f"{base_url}/api/mockup/{quote(mockup_id, safe='/')}", timeout=5) as r:
                html_p = r.read().decode("utf-8")
                cc_p = r.headers.get("Cache-Control", "")
                assert r.status == 200 and "QA Smoke Mockup" in html_p and "no-store" in cc_p
            print("[PASS] GET /api/mockup (?id=&t=123 and /<id>) with Cache-Control: no-store")

            # 4e. Sibling CSS asset serving (both subpath and query param)
            parent_dir_id = mockup_id.rsplit("/", 1)[0]
            with urlopen(f"{base_url}/api/mockup/{quote(parent_dir_id, safe='/')}/style.css", timeout=5) as r:
                css_sub = r.read().decode("utf-8")
                assert r.status == 200 and "background: #10141c" in css_sub
            with urlopen(f"{base_url}/api/mockup?id={quote(mockup_id, safe='')}&asset=style.css", timeout=5) as r:
                css_q = r.read().decode("utf-8")
                assert r.status == 200 and "background: #10141c" in css_q
            print("[PASS] Sibling asset serving (/api/mockup/<dir>/style.css & ?asset=style.css)")

            # 4f. Path traversal & unknown ID rejection
            trav_asset_status = _http_status(
                f"{base_url}/api/mockup?id={quote(mockup_id, safe='')}&asset=../secret.txt"
            )
            assert trav_asset_status == 403, f"Expected 403 for ../ asset traversal, got {trav_asset_status}"
            unknown_id_status = _http_status(f"{base_url}/api/mockup?id=nonexistent/../../etc/passwd")
            assert unknown_id_status == 404, f"Expected 404 for unknown/traversal id, got {unknown_id_status}"
            unknown_subpath_status = _http_status(f"{base_url}/api/mockup/nonexistent/MOCKUP.html")
            assert unknown_subpath_status == 404, f"Expected 404 for unknown subpath, got {unknown_subpath_status}"
            print("[PASS] Path traversal & unknown ID rejection (403 on ../ asset, 404 on unknown/traversal id)")

            # 4g. POST /api/feedback writes sibling FEEDBACK.md in tempdir and reflects in GET /api/mockups?id=...
            fb_req = Request(
                f"{base_url}/api/feedback",
                data=json.dumps({
                    "id": mockup_id,
                    "view": "16:9 TV",
                    "note": "QA smoke note",
                }).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(fb_req, timeout=5) as r:
                fb_res = json.loads(r.read().decode("utf-8"))
                assert r.status == 200 and fb_res.get("ok") is True
                assert "QA smoke note" in fb_res.get("feedback", "")

            fb_file = tmp_mockup_dir / "FEEDBACK.md"
            assert fb_file.is_file(), "Expected sibling FEEDBACK.md to be created in temp mockup dir"
            fb_disk = fb_file.read_text(encoding="utf-8")
            assert "16:9 TV" in fb_disk and "QA smoke note" in fb_disk

            with urlopen(f"{base_url}/api/mockups?id={quote(mockup_id, safe='')}", timeout=5) as r:
                refreshed = json.loads(r.read().decode("utf-8"))
                assert r.status == 200
                selected = refreshed.get("selected") or {}
                assert selected.get("id") == mockup_id
                assert "QA smoke note" in selected.get("feedback", "")
                assert "16:9 TV" in selected.get("feedback", "")
            print("[PASS] POST /api/feedback writes sibling FEEDBACK.md and persists in GET /api/mockups?id=...")
        finally:
            server.shutdown()
            server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
