"""Real-browser checks for engine selection / device emulation (Issue #5) and CDP attach (Issue #40) in the Python package.

Each agent runs in its own process (tests/_agent_proc.py): Playwright's sync API allows one instance per thread, and the CDP
test needs the agent and a separate "user's browser" at the same time.

Skipped without Playwright unless AGENT_EYE_REQUIRE_PLAYWRIGHT=1 (CI). Firefox / WebKit tests are skipped when the
engine is not installed unless AGENT_EYE_REQUIRE_ENGINES lists it (comma separated).
"""
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
    HAVE_PLAYWRIGHT = True
except ImportError:  # pragma: no cover
    HAVE_PLAYWRIGHT = False

HELPER = os.path.join(os.path.dirname(__file__), "_agent_proc.py")
REQUIRED_ENGINES = {e.strip() for e in os.environ.get("AGENT_EYE_REQUIRE_ENGINES", "").split(",") if e.strip()}
RUN = unittest.skipUnless(HAVE_PLAYWRIGHT or os.environ.get("AGENT_EYE_REQUIRE_PLAYWRIGHT") == "1", "playwright not installed")

PAGES = {
    "/": b'<!doctype html><meta name="viewport" content="width=device-width"><title>app</title><h1>agent-app</h1><button id="b">go</button><a id="p" href="/popup" target="_blank">open popup</a>',
    "/secret": b"<!doctype html><title>secret</title><h1>USER-PRIVATE-TAB</h1>",
    "/popup": b"<!doctype html><title>popup</title><h1>popup-from-agent</h1>",
    "/imds": b'<!doctype html><title>imds</title><script>fetch("http://169.254.169.254/latest/meta-data/",{mode:"no-cors"}).catch(()=>{});</script>probe',
}


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGES.get(self.path.split("?")[0], PAGES["/"])
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _QuietServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):  # browsers reset idle connections on shutdown: not an error here
        pass


class AgentError(Exception):
    pass


class AgentProcess:
    """One AgentEye in its own process, driven over stdin/stdout."""

    def __init__(self, workspace: str, **env):
        full = {**os.environ, "AGENT_EYE_HEADLESS": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", **{k: str(v) for k, v in env.items()}}
        self.proc = subprocess.Popen([sys.executable, "-W", "ignore", HELPER, workspace], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     text=True, encoding="utf-8", env=full, bufsize=1)
        first = json.loads(self.proc.stdout.readline())
        assert first.get("ready"), first

    def call(self, name, *args, **kwargs):
        self.proc.stdin.write(json.dumps({"call": name, "args": list(args), "kwargs": kwargs}) + "\n")
        self.proc.stdin.flush()
        reply = json.loads(self.proc.stdout.readline())
        if "error" in reply:
            raise AgentError(reply["error"])
        return reply["ok"]

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=30)
        except Exception:
            self.proc.kill()


class _WebFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = _QuietServer(("127.0.0.1", 0), _Handler)
        cls.web = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.ws = tempfile.mkdtemp(prefix="ae-py-eng-")
        cls._agents = []

    @classmethod
    def tearDownClass(cls):
        for a in cls._agents:
            a.close()
        cls.httpd.shutdown()
        shutil.rmtree(cls.ws, ignore_errors=True)

    def agent(self, **env) -> AgentProcess:
        a = AgentProcess(tempfile.mkdtemp(prefix="ae-py-ws-", dir=self.ws), **env)
        self._agents.append(a)
        return a


@RUN
class EnginesAndDevices(_WebFixture):
    def test_device_emulation_and_viewport_on_chromium(self):
        a = self.agent(AGENT_EYE_DEVICE="iPhone 15")
        a.call("navigate", self.web + "/")
        info = a.call("_eval", "({w: innerWidth, ua: navigator.userAgent, touch: 'ontouchstart' in window, dpr: devicePixelRatio})")
        self.assertEqual(info["w"], 393)
        self.assertIn("iPhone", info["ua"])
        self.assertTrue(info["touch"])
        self.assertEqual(info["dpr"], 3)
        b = self.agent(AGENT_EYE_VIEWPORT="900x600")
        b.call("navigate", self.web + "/")
        self.assertEqual(b.call("_eval", "innerWidth"), 900)

    def test_bad_settings_are_explained(self):
        for env, needle in (
            ({"AGENT_EYE_BROWSER": "safari"}, "is not supported"),
            ({"AGENT_EYE_DEVICE": "Nokia 3310"}, "not a known Playwright device"),
            ({"AGENT_EYE_VIEWPORT": "100x100"}, "is invalid"),
            ({"AGENT_EYE_BROWSER": "firefox", "AGENT_EYE_BROWSER_CHANNEL": "chrome"}, "only applies to chromium"),
        ):
            with self.subTest(env=env):
                a = self.agent(**env)
                with self.assertRaises(AgentError) as ctx:
                    a.call("navigate", self.web + "/")
                self.assertIn(needle, str(ctx.exception))

    def _engine_check(self, engine: str):
        a = self.agent(AGENT_EYE_BROWSER=engine)
        try:
            a.call("navigate", self.web + "/")
        except AgentError as exc:
            if "is not installed" in str(exc) and engine not in REQUIRED_ENGINES:
                self.skipTest(f"{engine} is not installed (python -m playwright install {engine})")
            raise
        self.assertRegex(a.call("snapshot"), r'button "go" \[ref=(?:f\d+)?e\d+\]')
        a.call("navigate", self.web + "/imds")
        time.sleep(0.8)
        self.assertIn("169.254.169.254", a.call("network", failed_only=True), f"metadata hosts must be blocked on {engine} too")
        perf = a.call("perf_summary")
        self.assertIn(f"{engine}, cpu x1", perf)
        if engine != "chromium":
            self.assertIn(f"n/a on {engine}", perf)

    def test_firefox(self):
        self._engine_check("firefox")

    def test_webkit(self):
        self._engine_check("webkit")


@RUN
class CdpAttach(_WebFixture):
    """The agent must never touch a browser it did not launch (its tabs, input, window) beyond the tabs it opens."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.pw = sync_playwright().start()
        cls.cdp_port = free_port()
        profile = tempfile.mkdtemp(prefix="ae-py-cdp-profile-")
        # a real browser PROCESS whose tabs live in the DEFAULT context (like `chrome --remote-debugging-port`), unlike
        # chromium.launch(), which has no default context and would make every isolation check pass trivially
        cls.proc = subprocess.Popen(
            [cls.pw.chromium.executable_path, "--headless=new", f"--remote-debugging-port={cls.cdp_port}", f"--user-data-dir={profile}",
             "--no-first-run", "--no-default-browser-check", "--no-sandbox", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(80):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.cdp_port}/json/version", timeout=1).read()
                break
            except Exception:
                time.sleep(0.25)
        cls.user_browser = cls.pw.chromium.connect_over_cdp(f"http://127.0.0.1:{cls.cdp_port}")
        cls.user_ctx = cls.user_browser.contexts[0]

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        try:
            cls.user_browser.close()
        except Exception:
            pass
        cls.proc.kill()
        cls.pw.stop()

    def user_pages(self, pump):
        """The user's tabs. Playwright's sync API only processes events from other processes during one of its own calls,
        so pump it first, or tabs opened by the agent would not be visible yet."""
        pump.wait_for_timeout(400)
        return self.user_ctx.pages

    def test_the_agent_only_touches_its_own_tabs(self):
        user_tab = self.user_ctx.new_page()
        user_tab.goto(self.web + "/secret")
        user_tab.evaluate("document.title = 'secret-edited'")
        before = len(self.user_pages(user_tab))
        agent = self.agent(AGENT_EYE_CDP_URL=f"http://127.0.0.1:{self.cdp_port}")

        agent.call("navigate", self.web + "/")
        self.assertEqual(len(self.user_pages(user_tab)), before + 1, "exactly one new tab for the agent")
        snap = agent.call("snapshot")
        self.assertIn("agent-app", snap)
        self.assertNotIn("USER-PRIVATE-TAB", snap)
        self.assertTrue(user_tab.url.endswith("/secret"))
        self.assertEqual(user_tab.title(), "secret-edited")

        late = self.user_ctx.new_page()  # a tab the user opens while the agent is attached
        late.goto(self.web + "/secret")
        late_snap = agent.call("snapshot")
        self.assertIn("agent-app", late_snap)
        self.assertNotIn("USER-PRIVATE-TAB", late_snap, "a tab the user opens later is not adopted")

        agent.call("click", "#p")  # the agent's own popup IS followed
        agent.call("wait_for", text="popup-from-agent", timeout_ms=4000)

        agent.call("navigate", self.web + "/imds")
        time.sleep(0.8)
        self.assertIn("169.254.169.254", agent.call("network", failed_only=True), "metadata requests blocked on the agent's tab")

        injected = user_tab.evaluate("typeof window.__agentEyeLock === 'function' || !!document.getElementById('__agent_eye_status')")
        self.assertFalse(injected, "nothing is injected into the user's tab")

        agent.call("navigate", self.web + "/")
        with self.assertRaises(AgentError) as ctx:
            agent.call("set_storage", clear=True)
        self.assertIn("own browser", str(ctx.exception))
        size = user_tab.evaluate("[window.outerWidth, window.outerHeight]")
        agent.call("resize", 700, 500)
        self.assertEqual(user_tab.evaluate("[window.outerWidth, window.outerHeight]"), size, "the user's window is not resized")

        agent.call("close_browser")
        time.sleep(0.5)
        self.assertFalse(user_tab.is_closed())
        self.assertFalse(late.is_closed())
        self.assertEqual(len(self.user_pages(user_tab)), before + 1, "only the agent's tabs were closed (user tab + late tab remain)")
        self.assertIsNone(self.proc.poll(), "the user's browser keeps running")
        user_tab.close()
        late.close()

    def test_misconfiguration_is_explained(self):
        for env, needle in (
            ({"AGENT_EYE_CDP_URL": "http://192.168.1.50:9222"}, "must point at this machine"),
            ({"AGENT_EYE_CDP_URL": f"http://127.0.0.1:{self.cdp_port}", "AGENT_EYE_DEVICE": "iPhone 15"}, "AGENT_EYE_DEVICE"),
            ({"AGENT_EYE_CDP_URL": f"http://127.0.0.1:{self.cdp_port}", "AGENT_EYE_BROWSER": "firefox"}, "Chromium-only"),
            ({"AGENT_EYE_CDP_URL": "http://127.0.0.1:1"}, "remote-debugging-port"),
        ):
            with self.subTest(env=env):
                a = self.agent(**env)
                with self.assertRaises(AgentError) as ctx:
                    a.call("navigate", self.web + "/")
                self.assertIn(needle, str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
