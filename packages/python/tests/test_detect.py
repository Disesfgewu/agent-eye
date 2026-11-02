"""Conformance: project detection must agree with the TypeScript implementation.

Runs packages/mcp-server/tests/fixtures/detect-cases.json (shared with the Node suite).
"""
import json
import os
import shutil
import socket
import tempfile
import unittest

from agent_eye import guards
from agent_eye.detect import detect_projects, format_detected, scan_workspace
from agent_eye.policy import DEFAULT_CMD_ALLOWLIST
from agent_eye.ready import extract_ports, port_open, wait_for_port

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "..", "mcp-server", "tests", "fixtures")
with open(os.path.join(FIXTURES, "detect-cases.json"), encoding="utf-8") as f:
    CASES = json.load(f)

_KEYS = {"dir": "dir", "stack": "stack", "command": "command", "args": "args", "port": "port", "portSource": "port_source"}


class DetectConformance(unittest.TestCase):
    def test_fixture_count_is_not_vacuous(self):
        self.assertGreaterEqual(len(CASES), 35)

    def test_every_fixture(self):
        for c in CASES:
            with self.subTest(case=c["name"]):
                res = detect_projects(c["files"], platform=c.get("platform", "linux"))
                self.assertEqual(len(res.projects), len(c["expect"]), [p.__dict__ for p in res.projects])
                for i, want in enumerate(c["expect"]):
                    for k, v in want.items():
                        self.assertEqual(getattr(res.projects[i], _KEYS[k]), v, f"project {i} {k}")
                if "notes" in c:
                    self.assertEqual(len(res.notes), c["notes"])

    def test_every_suggestion_is_accepted_by_the_command_guard(self):
        ws = tempfile.mkdtemp(prefix="ae-py-")
        host = "win32" if os.name == "nt" else "linux"  # Windows-style suggestions only make sense on Windows
        for c in CASES:
            for p in detect_projects(c["files"], platform=host).projects:
                with self.subTest(case=c["name"], cmd=p.command):
                    verdict, reason, _ = guards.classify_command(p.command, p.args, p.dir, ws, DEFAULT_CMD_ALLOWLIST)
                    self.assertEqual(verdict, "allowlisted", reason)

    def test_format_matches_the_typescript_output(self):
        case = next(c for c in CASES if c["name"] == "go gin at the root")
        out = format_detected(detect_projects(case["files"], platform="linux"))
        self.assertEqual(out, '1. Go · Gin @ .: start_dev_server id="app" command="go" args=["run","."] cwd="." port=8080 (typical)')
        self.assertIn("[NOT STARTABLE: nope]", format_detected(detect_projects(case["files"], platform="linux"), ["nope"]))
        self.assertIn("No runnable project found", format_detected(detect_projects({})))

    def test_scan_workspace_reads_manifests_only_and_skips_vendored_dirs(self):
        root = tempfile.mkdtemp(prefix="ae-scan-")
        outside = tempfile.mkdtemp(prefix="ae-out-")
        try:
            def w(rel, body=""):
                p = os.path.join(root, *rel.split("/"))
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w", encoding="utf-8") as fh:
                    fh.write(body)
            w("go.mod", "module x\n")
            w("main.go", "package main // secret-body")
            w("node_modules/dep/package.json", "{}")
            w("target/debug/Cargo.toml", "[package]")
            w("a/b/c/d/e/package.json", "{}")
            w("svc/Cargo.toml", '[package]\nname="svc"\n')
            try:
                os.symlink(outside, os.path.join(root, "link"), target_is_directory=True)
            except (OSError, NotImplementedError):
                pass
            files = scan_workspace(root)
            self.assertEqual(files["go.mod"], "module x\n")
            self.assertEqual(files["main.go"], "", "non-manifest content is never read")
            self.assertFalse([p for p in files if p.startswith(("node_modules", "target", "link"))])
            self.assertNotIn("a/b/c/d/e/package.json", files)
            self.assertIn("svc", files["svc/Cargo.toml"])
        finally:
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(outside, ignore_errors=True)


class ReadyTests(unittest.TestCase):
    def test_extract_ports(self):
        self.assertEqual(extract_ports(["[GIN-debug] Listening and serving HTTP on :8080"]), [8080])
        self.assertEqual(extract_ports(["  Local:   http://localhost:5173/"]), [5173])
        self.assertEqual(extract_ports(["server listening at http://127.0.0.1:8080/", "listening on http://[::1]:3000"]), [8080, 3000])
        self.assertEqual(extract_ports(["Server running on port 4000"]), [4000])
        self.assertEqual(extract_ports(["Running MyAppWeb.Endpoint with Bandit at 127.0.0.1:4000 (http)"]), [4000])
        self.assertEqual(extract_ports(["12:30:45 INFO started in 3000 ms", "ok"]), [])
        self.assertEqual(extract_ports(["localhost:99999", "localhost:22"]), [])

    def _wait(self, probes, alive, timeout=1.0):
        t = [0.0]
        pi = [0]
        ai = [0]

        def probe(_p):
            v = probes[min(pi[0], len(probes) - 1)]
            pi[0] += 1
            return v

        def is_alive():
            v = alive[min(ai[0], len(alive) - 1)]
            ai[0] += 1
            return v

        def sleep(s):
            t[0] += s

        return wait_for_port(1, timeout, is_alive, interval_s=0.1, probe=probe, now=lambda: t[0], sleep=sleep)

    def test_wait_for_port_outcomes(self):
        state, elapsed = self._wait([False, False, True], [True])
        self.assertEqual(state, "ready")
        self.assertAlmostEqual(elapsed, 0.2)
        self.assertEqual(self._wait([False], [True, False])[0], "exited")
        state, elapsed = self._wait([False], [True])
        self.assertEqual(state, "timeout")
        self.assertGreaterEqual(elapsed, 1.0)
        self.assertEqual(self._wait([True], [False])[0], "ready", "a launcher that hands off to a daemon still counts as ready")

    def test_port_open_on_a_real_loopback_listener(self):
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        port = srv.getsockname()[1]
        self.assertTrue(port_open(port))
        srv.close()
        self.assertFalse(port_open(port))


if __name__ == "__main__":
    unittest.main()
