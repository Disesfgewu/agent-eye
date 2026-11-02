"""End-to-end: the Python MCP server over stdio, driven by the official MCP client (needs the `mcp` extra + Playwright)."""
import asyncio
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

try:
    import playwright  # noqa: F401
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    HAVE = True
except ImportError:  # pragma: no cover
    HAVE = False

PAGE = b"""<!doctype html><title>mcp</title><h1>mcp-page</h1><button id="b">go</button><script>console.error("mcp-boom")</script>"""


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *a):
        pass


def text_of(result) -> str:
    return "\n".join(c.text for c in result.content if getattr(c, "type", "") == "text")


@unittest.skipUnless(HAVE or os.environ.get("AGENT_EYE_REQUIRE_MCP") == "1", "mcp + playwright not installed (mcp needs Python >= 3.10)")
class McpServer(unittest.TestCase):
    def test_tools_listed_and_a_verify_flow_is_measured(self):
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        ws = tempfile.mkdtemp(prefix="ae-py-mcp-")
        src = os.path.join(os.path.dirname(__file__), "..", "src")
        env = {**os.environ, "PYTHONPATH": os.path.abspath(src), "AGENT_EYE_HEADLESS": "1", "PYTHONUTF8": "1"}

        async def drive():
            params = StdioServerParameters(command=sys.executable, args=["-m", "agent_eye.mcp_server", "--workspace", ws], env=env)
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    names = {t.name for t in (await session.list_tools()).tools}
                    for want in ("browser_navigate", "browser_snapshot", "browser_verify_page", "browser_batch", "browser_press_key",
                                 "browser_history", "detect_project", "start_dev_server", "usage_report", "browser_screenshot",
                                 "browser_set_storage", "browser_upload_file", "browser_perf_summary", "browser_close", "browser_show_status"):
                        self.assertIn(want, names)
                    verify = text_of(await session.call_tool("browser_verify_page", {"url": f"http://127.0.0.1:{port}/", "snapshot": "none"}))
                    self.assertIn("Title: mcp", verify)
                    self.assertIn("mcp-boom", verify)
                    find = text_of(await session.call_tool("browser_snapshot", {"find": "go"}))
                    self.assertRegex(find, r'button "go" \[ref=')
                    detected = text_of(await session.call_tool("detect_project", {}))
                    self.assertIn("No runnable project found", detected)
                    blocked = text_of(await session.call_tool("browser_navigate", {"url": "file:///etc/passwd"}))
                    self.assertIn("blocked", blocked.lower())
                    shot = await session.call_tool("browser_screenshot", {"if_changed": True})
                    self.assertEqual([c.type for c in shot.content], ["text", "image"], "first shot returns the image")
                    again = await session.call_tool("browser_screenshot", {"if_changed": True})
                    self.assertEqual([c.type for c in again.content], ["text"], "identical page: one line, no image")
                    self.assertIn("unchanged", text_of(again))
                    perf = text_of(await session.call_tool("browser_perf_summary", {}))
                    self.assertIn("Perf http://127.0.0.1:", perf)
                    bad = text_of(await session.call_tool("browser_set_storage", {"cookies": [{"name": "a", "value": "v; x=y"}]}))
                    self.assertIn("Not set", bad)
                    report = text_of(await session.call_tool("usage_report", {}))
                    return report

        try:
            report = asyncio.run(drive())
        finally:
            httpd.shutdown()
        self.assertRegex(report, r"Tool definitions \(fixed per session\): ~[\d,]+ tokens, \d+ tools")
        self.assertIn("browser_verify_page | 1 |", report)
        self.assertIn("browser_snapshot | 1 |", report)
        shot_row = next(line for line in report.splitlines() if line.startswith("browser_screenshot |"))
        self.assertLess(int(shot_row.split("|")[2].strip().replace(",", "")), 2500, "images are priced by size, not by base64 length")
        usage = os.path.join(ws, ".agent-artifacts", "usage.json")
        self.assertTrue(os.path.exists(usage), "the ledger is flushed when the server exits")
        with open(usage, encoding="utf-8") as f:
            self.assertGreaterEqual(json.load(f)["totals"]["calls"], 4)
        shutil.rmtree(ws, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
