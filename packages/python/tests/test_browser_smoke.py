"""Real-browser smoke test for the Python package (needs `playwright` + `python -m playwright install chromium`).

Skipped when Playwright is not installed, unless AGENT_EYE_REQUIRE_PLAYWRIGHT=1 (CI), where it must run.
"""
import http.server
import os
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

PAGE = b"""<!doctype html><h1 id="t">py-e2e-ok</h1><button id="b" onclick="document.title='clicked'">go</button>
<script>fetch("http://169.254.169.254/latest/meta-data/",{mode:"no-cors"}).catch(()=>{});</script>"""


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *a):
        pass


@unittest.skipUnless(HAVE_PLAYWRIGHT or os.environ.get("AGENT_EYE_REQUIRE_PLAYWRIGHT") == "1", "playwright not installed")
class BrowserSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.ws = tempfile.mkdtemp(prefix="ae-py-br-")
        cls.eye = AgentEye(workspace=cls.ws, policy=Policy(), on_approve=lambda *_: True, headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.eye.close()
        cls.httpd.shutdown()
        shutil.rmtree(cls.ws, ignore_errors=True)

    def test_navigate_snapshot_refs_click_and_ssrf_block(self):
        nav = self.eye.navigate(f"http://127.0.0.1:{self.port}/")
        self.assertEqual(nav["url"], f"http://127.0.0.1:{self.port}/")
        snap = self.eye.snapshot()
        self.assertIn("py-e2e-ok", snap)
        ref = __import__("re").search(r'button "go" \[ref=(e\d+)\]', snap)
        self.assertIsNotNone(ref, "snapshot must carry [ref=eN] handles")
        self.eye.click(ref.group(1))
        self.assertEqual(self.eye._ensure_page().title(), "clicked")
        time.sleep(0.5)
        failed = [r for r in self.eye.get_network_requests() if "169.254.169.254" in r["url"]]
        self.assertTrue(failed, "the probe request should be recorded")
        self.assertIn("ERR_NAME_NOT_RESOLVED", failed[0].get("failure", ""), "metadata host must not resolve")


if __name__ == "__main__":
    unittest.main()
