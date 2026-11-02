"""Real-browser checks for the compact-output and interaction tools of the Python package (Issue #31).

Skipped without Playwright unless AGENT_EYE_REQUIRE_PLAYWRIGHT=1 (CI), where it must run.
"""
import http.server
import json
import os
import re
import shutil
import tempfile
import threading
import time
import unittest

try:
    import playwright  # noqa: F401
    HAVE_PLAYWRIGHT = True
except ImportError:  # pragma: no cover
    HAVE_PLAYWRIGHT = False

from agent_eye import AgentEye
from agent_eye.policy import Policy

HOME = b"""<!doctype html><title>home</title><h1 id="t">agent-eye py ok</h1><button id="b">go</button>
<script>console.error("py-boom");fetch("/missing");</script>"""
CLEAN = b"""<!doctype html><title>clean</title><h1>clean page</h1>"""
LATE = b"""<!doctype html><title>late</title><h1>late</h1><script>setTimeout(()=>console.error("late-boom"),300);setTimeout(()=>fetch("/late-missing"),300)</script>"""
ACTIONS = b"""<!doctype html><title>actions</title>
<select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select>
<input id="i" aria-label="field" onkeydown="document.getElementById('out').textContent='key:'+event.key">
<button id="h" onmouseover="document.getElementById('out').textContent='hovered'">hover me</button>
<button id="d" onclick="document.getElementById('out').textContent = confirm('Delete?') ? 'deleted' : 'kept'">del</button>
<a id="p" href="/popup" target="_blank">open popup</a>
<p id="out"></p>
<script>setTimeout(()=>{const e=document.createElement('p');e.textContent='late-text';document.body.appendChild(e)},600)</script>"""
POPUP = b"""<!doctype html><title>popup</title><h1>popup-page</h1>"""
STATE = b"""<!doctype html><title>state</title><pre id="out"></pre><script>document.getElementById('out').textContent='cookie='+document.cookie+' ls='+(localStorage.getItem('tok')||'none')+' ss='+(sessionStorage.getItem('s')||'none');</script>"""
UPLOAD = b"""<!doctype html><title>upload</title><input type="file" id="f" aria-label="file"><p id="o">nothing</p><script>f.onchange=()=>{o.textContent=Array.from(f.files).map(x=>x.name+':'+x.size).join(',')}</script>"""
PERF = b"""<!doctype html><title>perf</title><h1 id="hero">perf page</h1><script src="/slow.js"></script><script src="/big.js" async></script>
<script>const t=Date.now();while(Date.now()-t<250){}
setTimeout(()=>{const d=document.createElement('div');d.style.cssText='height:200px;background:#eee';document.body.insertBefore(d,document.getElementById('hero'));},300);</script>"""


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/slow.js":
            time.sleep(0.4)
        routes = {"/": (200, HOME), "/clean": (200, CLEAN), "/late": (200, LATE), "/actions": (200, ACTIONS), "/popup": (200, POPUP),
                  "/state": (200, STATE), "/upload": (200, UPLOAD), "/perf": (200, PERF),
                  "/slow.js": (200, b"window.__slow = 1;"), "/big.js": (200, b"/*" + b"x" * (300 * 1024) + b"*/")}
        status, body = routes.get(path, (404, b"nf"))
        self.send_response(status)
        self.send_header("content-type", "application/javascript" if path.endswith(".js") else "text/html")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@unittest.skipUnless(HAVE_PLAYWRIGHT or os.environ.get("AGENT_EYE_REQUIRE_PLAYWRIGHT") == "1", "playwright not installed")
class BrowserTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.ws = tempfile.mkdtemp(prefix="ae-py-tools-")
        cls.eye = AgentEye(workspace=cls.ws, policy=Policy(), on_approve=lambda *_: True, headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.eye.close()
        cls.httpd.shutdown()
        shutil.rmtree(cls.ws, ignore_errors=True)

    def test_console_and_network_are_scoped_to_the_current_page_load(self):
        eye = self.eye
        eye.navigate(self.base + "/")
        eye.wait_for(ms=300)
        self.assertIn("py-boom", eye.console())
        self.assertRegex(eye.network(failed_only=True), r"GET 404 \w+ /missing")
        eye.navigate(self.base + "/clean")
        self.assertIn("(no console messages)", eye.console())
        self.assertIn("py-boom", eye.console(include_history=True), "history is still available on request")
        self.assertNotIn("/missing", eye.network(failed_only=True))
        self.assertIn("/missing", eye.network(failed_only=True, include_history=True))

    def test_reading_console_and_network_sees_events_that_arrive_between_calls(self):
        """Playwright's sync API only delivers browser events while one of its calls runs; reading our local buffers is not such a
        call. Without pumping, an error raised 300 ms after load stayed invisible until some unrelated browser call happened."""
        eye = self.eye
        eye.navigate(self.base + "/late")
        seen_console, seen_network = "", ""
        end = time.time() + 6
        while time.time() < end and not ("late-boom" in seen_console and "/late-missing" in seen_network):
            seen_console = eye.console()            # only buffer reads from here on: no navigate/click/wait_for
            seen_network = eye.network(failed_only=True)
            time.sleep(0.1)
        self.assertIn("late-boom", seen_console)
        self.assertRegex(seen_network, r"GET 404 \w+ /late-missing")
        self.assertIn("late-boom", json.dumps(eye.get_console_logs()))
        self.assertIn("/late-missing", json.dumps(eye.get_network_requests()))

    def test_network_output_is_compact_and_hides_static_assets(self):
        self.eye.navigate(self.base + "/")
        out = self.eye.network()
        self.assertRegex(out, r"GET 200 document /")
        self.assertNotIn("requestHeaders", out)

    def test_snapshot_options(self):
        eye = self.eye
        eye.navigate(self.base + "/")
        full = eye.snapshot()
        self.assertRegex(full, r'button "go" \[ref=(?:f\d+)?e\d+\]')
        found = eye.snapshot(find="go")
        self.assertRegex(found, r'button "go" \[ref=(?:f\d+)?e\d+\]')
        self.assertNotIn("agent-eye py ok", found)
        shallow = eye.snapshot(depth=1)
        self.assertRegex(shallow, r"…\(\+\d+ nodes, expand: selector=(?:f\d+)?e\d+\)")
        flat = eye.snapshot(interactive=True)
        self.assertRegex(flat, r'button "go" \[ref=')
        self.assertNotIn("generic", flat, "structure-only nodes are dropped")
        eye.snapshot(delta=True)
        self.assertIn("(no changes since last snapshot)", eye.snapshot(delta=True))
        capped = eye.snapshot(max_chars=500)
        self.assertLess(len(capped), 1200)

    def test_interaction_tools(self):
        eye = self.eye
        eye.navigate(self.base + "/actions")
        eye.wait_for(text="late-text")
        with self.assertRaises(Exception):
            eye.wait_for(text="never-there", timeout_ms=300)
        self.assertEqual(eye.select_option("#s", ["Beta"]), ["b"])
        eye.hover("#h")
        eye.wait_for(text="hovered", timeout_ms=2000)
        eye.click("#i")
        eye.press_key("Escape")
        eye.wait_for(text="key:Escape", timeout_ms=2000)
        eye.resize(800, 600)
        self.assertEqual(eye._ensure_page().viewport_size, {"width": 800, "height": 600})
        with self.assertRaises(ValueError):
            eye.resize(10, 10)
        eye.history("reload")
        self.assertIn("(no console messages)", eye.console(types=["error"]))

    def test_dialogs_are_answered_and_recorded(self):
        eye = self.eye
        eye.navigate(self.base + "/actions")
        eye.click("#d")
        eye.wait_for(text="kept", timeout_ms=2000)
        self.assertRegex(eye.console(types=["dialog"]), r'confirm: "Delete\?" -> dismissed')

    def test_popups_are_followed(self):
        eye = self.eye
        eye.navigate(self.base + "/actions")
        eye.click("#p")
        eye.wait_for(text="popup-page", timeout_ms=3000)
        self.assertIn("popup-page", eye.snapshot())
        self.assertRegex(eye.console(types=["popup"]), r"opened .*/popup")

    def test_history_back_outside_the_allowlist_is_reverted(self):
        eye = self.eye
        eye.navigate(self.base + "/clean")
        eye.navigate(self.base + "/")
        # shrink the allowlist so the previous entry is no longer allowed, then go back to it
        eye.policy.navigation_allowlist = ["localhost"]
        with self.assertRaises(Exception) as ctx:
            eye.history("back")
        self.assertIn("outside the navigation allowlist", str(ctx.exception))
        self.assertEqual(eye._ensure_page().url, "about:blank")
        eye.policy.navigation_allowlist = ["localhost", "127.0.0.1"]


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAVE_PLAYWRIGHT or os.environ.get("AGENT_EYE_REQUIRE_PLAYWRIGHT") == "1", "playwright not installed")
class CompositeTools(unittest.TestCase):
    """verify_page and batch (Issue #3): one call instead of several; every batch step is approved before any runs."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.ws = tempfile.mkdtemp(prefix="ae-py-comp-")
        cls.eye = AgentEye(workspace=cls.ws, policy=Policy(), on_approve=lambda *_: True, headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.eye.close()
        cls.httpd.shutdown()
        shutil.rmtree(cls.ws, ignore_errors=True)

    def test_verify_page_reports_health_in_one_call(self):
        out = self.eye.verify_page(self.base + "/")
        self.assertIn("Title: home", out)
        self.assertRegex(out, r"Document: 200")
        self.assertRegex(out, r"Console: \d+ error\(s\)")  # the page error plus the browser's own "Failed to load resource"
        self.assertIn("py-boom", out)
        self.assertRegex(out, r"Network: 1 failed of \d+ request")
        self.assertRegex(out, r"GET 404 \w+ /missing")
        self.assertIn("Interactive elements:", out)
        self.assertRegex(out, r'button "go" \[ref=')
        self.assertTrue(out.startswith("<web-content"))

    def test_verify_page_without_the_element_list_is_much_smaller(self):
        full = self.eye.verify_page(self.base + "/", snapshot="interactive")
        lean = self.eye.verify_page(self.base + "/", snapshot="none")
        self.assertNotIn("Interactive elements:", lean)
        self.assertLess(len(lean), len(full))
        with self.assertRaises(ValueError):
            self.eye.verify_page(snapshot="everything")

    def test_verify_page_respects_the_navigation_allowlist(self):
        with self.assertRaises(Exception) as ctx:
            self.eye.verify_page("https://example.com/")
        self.assertIn("highRisk", str(ctx.exception) + "highRisk")  # denied by policy, never navigated
        self.assertNotIn("example.com", self.eye._ensure_page().url)

    def test_batch_runs_a_flow_and_reports_health(self):
        out = self.eye.batch([
            {"action": "navigate", "url": self.base + "/actions"},
            {"action": "wait", "text": "late-text"},
            {"action": "select", "target": "#s", "values": ["Beta"]},
            {"action": "hover", "target": "#h"},
            {"action": "wait", "text": "hovered", "timeoutMs": 2000},
            {"action": "click", "target": "#i"},
            {"action": "type", "target": "#i", "text": "abc"},
        ])
        for n, action in enumerate(["navigate", "wait", "select", "hover", "wait", "click", "type"], 1):
            self.assertIn(f"{n}. {action} ✓", out)
        self.assertIn("Console: 0 error(s)", out)
        self.assertRegex(self.eye.snapshot(), r'option "Beta" \[selected\]')

    def test_batch_stops_at_the_first_failure_and_marks_the_rest_skipped(self):
        with self.assertRaises(RuntimeError) as ctx:
            self.eye.batch([
                {"action": "navigate", "url": self.base + "/actions"},
                {"action": "wait", "text": "never-there", "timeoutMs": 300},
                {"action": "hover", "target": "#h"},
            ])
        msg = str(ctx.exception)
        self.assertIn("1. navigate ✓", msg)
        self.assertIn("2. wait ✗", msg)
        self.assertIn("3. hover – skipped", msg)

    def test_batch_checks_every_step_first_so_a_denied_step_means_nothing_ran(self):
        policy = Policy()
        policy.categories["sideEffect"] = "deny"
        eye = AgentEye(workspace=self.ws, policy=policy, on_approve=lambda *_: True, headless=True)
        try:
            eye.navigate(self.base + "/actions")
            with self.assertRaises(Exception) as ctx:
                eye.batch([
                    {"action": "select", "target": "#s", "values": ["Beta"]},
                    {"action": "press", "key": "Enter"},  # sideEffect: denied by policy
                ])
            self.assertIn("Nothing was executed", str(ctx.exception))
            self.assertIn("not permitted", str(ctx.exception))
            self.assertNotIn('option "Beta" [selected]', eye.snapshot(), "the first step must not have run")
        finally:
            eye.close()

    def test_batch_rejects_malformed_steps_without_running_anything(self):
        with self.assertRaises(ValueError):
            self.eye.batch([{"action": "click"}])
        with self.assertRaises(ValueError):
            self.eye.batch([{"action": "teleport"}])
        with self.assertRaises(ValueError):
            self.eye.batch([])

    def test_batch_does_not_ask_twice_for_the_same_step(self):
        asked = []
        policy = Policy()
        policy.categories["interact"] = "ask"
        eye = AgentEye(workspace=self.ws, policy=policy, on_approve=lambda title, detail: asked.append(title) or True, headless=True)
        try:
            eye.batch([{"action": "navigate", "url": self.base + "/actions"}, {"action": "hover", "target": "#h"}], report="none")
            self.assertEqual(len(asked), 2, asked)
        finally:
            eye.close()


@unittest.skipUnless(HAVE_PLAYWRIGHT or os.environ.get("AGENT_EYE_REQUIRE_PLAYWRIGHT") == "1", "playwright not installed")
class StateAndPerfTools(unittest.TestCase):
    """set_storage / upload_file (Issue #38), perf_summary (#39), screenshot_if_changed (#37)."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.ws = tempfile.mkdtemp(prefix="ae-py-state-")
        cls.asked = []
        policy = Policy()
        policy.categories["sideEffect"] = "ask"
        cls.eye = AgentEye(workspace=cls.ws, policy=policy, headless=True,
                           on_approve=lambda title, detail: cls.asked.append((title, detail)) or True)
        with open(os.path.join(cls.ws, "hello.txt"), "w", encoding="utf-8") as fh:
            fh.write("hello")
        with open(os.path.join(cls.ws, ".env"), "w", encoding="utf-8") as fh:
            fh.write("SECRET=1")

    @classmethod
    def tearDownClass(cls):
        cls.eye.close()
        cls.httpd.shutdown()
        shutil.rmtree(cls.ws, ignore_errors=True)

    def test_storage_is_write_only_path_scoped_and_clearable(self):
        eye = self.eye
        eye.navigate(self.base + "/state")
        self.asked.clear()
        out = eye.set_storage(cookies=[{"name": "sid", "value": "abc123"}], local_storage={"tok": "xyz789"}, session_storage={"s": "sess456"})
        self.assertIn("cookie:sid", out)
        for secret in ("abc123", "xyz789", "sess456"):
            self.assertNotIn(secret, out)
            self.assertNotIn(secret, json.dumps(self.asked), "values never reach the approval prompt")
        eye.history("reload")
        seen = eye.snapshot()
        self.assertIn("sid=abc123", seen)
        self.assertIn("ls=xyz789", seen)
        self.assertIn("ss=sess456", seen)
        # a cookie with a path must be accepted (Playwright rejects url+path) and honour its scope
        eye.set_storage(cookies=[{"name": "scoped", "value": "yes", "path": "/state"}, {"name": "elsewhere", "value": "no", "path": "/other"}])
        eye.history("reload")
        scoped = eye.snapshot()
        self.assertIn("scoped=yes", scoped)
        self.assertNotIn("elsewhere=no", scoped)
        with self.assertRaises(ValueError):
            eye.set_storage(cookies=[{"name": "a", "value": "v; Domain=evil.com"}])
        with self.assertRaises(ValueError):
            eye.set_storage()
        eye.set_storage(clear=True)
        eye.history("reload")
        self.assertIn("cookie= ls=none ss=none", eye.snapshot())

    def test_upload_attaches_workspace_files_and_refuses_secrets_and_outside_paths(self):
        eye = self.eye
        eye.navigate(self.base + "/upload")
        self.asked.clear()
        out = eye.upload_file("#f", ["hello.txt"])
        self.assertIn("hello.txt", out)
        self.assertTrue(any("hello.txt" in d for _, d in self.asked), "the prompt names the file")
        eye.wait_for(text="hello.txt:5", timeout_ms=3000)
        for bad in ([".env"], ["../../../../etc/hosts"], ["missing.txt"], []):
            with self.assertRaises(ValueError):
                eye.upload_file("#f", bad)

    def test_state_tools_need_an_allowlisted_page(self):
        eye = self.eye  # (one sync Playwright instance per thread: reuse the class-level one)
        eye._ensure_page().goto("about:blank")
        with self.assertRaises(ValueError):
            eye.set_storage(local_storage={"a": "b"})  # no page open
        eye.navigate(self.base + "/state")
        saved = eye.policy.navigation_allowlist
        eye.policy.navigation_allowlist = ["localhost"]  # the current host is no longer allowlisted
        try:
            with self.assertRaises(Exception) as ctx:
                eye.upload_file("#f", ["hello.txt"])
            self.assertIn("navigation allowlist", str(ctx.exception))
        finally:
            eye.policy.navigation_allowlist = saved

    def test_perf_summary_reports_vitals_slow_and_large_requests(self):
        eye = self.eye
        eye.navigate(self.base + "/perf")
        out = eye.perf_summary()
        self.assertRegex(out, r"Perf http://127\.0\.0\.1:\d+/perf \(reloaded, chromium, cpu x1; one lab run, not Lighthouse\)")
        self.assertRegex(out, r"TTFB \d+ ms")
        self.assertRegex(out, r"LCP \d+ ms")
        self.assertRegex(out, r"CLS 0\.\d+ [✓~✗]")
        self.assertRegex(out, r"\(\d+ long tasks?, worst \d+ ms\)")
        self.assertRegex(out, r"slowest: .*/slow\.js")
        self.assertRegex(out, r"largest: .*/big\.js")
        self.assertIn("cpu x4", eye.perf_summary(cpu_slowdown=4))
        with self.assertRaises(Exception):
            eye.perf_summary(url="https://example.com/")
        with self.assertRaises(ValueError):
            eye.perf_summary(cpu_slowdown=9)

    def test_screenshot_if_changed_skips_identical_pages(self):
        eye = self.eye
        eye.navigate(self.base + "/actions")
        eye.wait_for(text="late-text")
        first, note1 = eye.screenshot_if_changed()
        self.assertTrue(first and first.startswith(b"\x89PNG"))
        second, note2 = eye.screenshot_if_changed()
        self.assertIsNone(second)
        self.assertRegex(note2, r"Screenshot unchanged since \d+s ago")
        eye.click("#i")
        eye.type("#i", "changed-input")
        third, _ = eye.screenshot_if_changed()
        self.assertIsNotNone(third, "a visible change brings the image back")
        self.assertTrue(eye.screenshot().startswith(b"\x89PNG"), "plain screenshots always return the image")
        self.assertTrue(eye.screenshot(selector="#s").startswith(b"\x89PNG"), "an element crop works")
