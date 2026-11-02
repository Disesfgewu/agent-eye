"""Token ledger: the estimators must match the TypeScript reference (golden cases), and the ledger must account correctly."""
import json
import os
import tempfile
import unittest

from agent_eye.usage import (
    UsageLedger, estimate_image_tokens, estimate_result_tokens, estimate_text_tokens, measured,
)

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "mcp-server", "tests", "fixtures", "usage-cases.json")
with open(FIXTURE, encoding="utf-8") as f:
    CASES = json.load(f)


class Estimators(unittest.TestCase):
    def test_fixture_is_not_vacuous(self):
        self.assertGreaterEqual(len(CASES["text"]), 10)
        self.assertGreaterEqual(len(CASES["images"]), 8)

    def test_text_estimates_match_the_typescript_reference(self):
        for c in CASES["text"]:
            with self.subTest(text=c["text"][:30]):
                self.assertEqual(estimate_text_tokens(c["text"]), c["tokens"])

    def test_image_estimates_match_the_typescript_reference(self):
        for c in CASES["images"]:
            with self.subTest(image=c["name"]):
                self.assertEqual(estimate_image_tokens(c["data"]), c["tokens"])

    def test_result_estimates_match_the_typescript_reference(self):
        for i, c in enumerate(CASES["results"]):
            with self.subTest(result=i):
                self.assertEqual(estimate_result_tokens(c["content"]), c["tokens"])

    def test_chars_per_token_can_be_overridden(self):
        os.environ["AGENT_EYE_CHARS_PER_TOKEN"] = "2"
        try:
            self.assertEqual(estimate_text_tokens("abcd"), 2)
        finally:
            del os.environ["AGENT_EYE_CHARS_PER_TOKEN"]
        os.environ["AGENT_EYE_CHARS_PER_TOKEN"] = "nonsense"
        try:
            self.assertEqual(estimate_text_tokens("abcd"), 1)
        finally:
            del os.environ["AGENT_EYE_CHARS_PER_TOKEN"]


class Ledger(unittest.TestCase):
    def test_record_summary_and_report(self):
        led = UsageLedger()
        led.set_tool_definition_overhead(2000, 10)
        led.record("browser_snapshot", 10, 500, 12.0, True)
        led.record("browser_snapshot", 10, 300, 8.0, False)
        led.record("browser_click", 5, 20, 3.0, True)
        s = led.summary()
        self.assertEqual(s["totals"], {"calls": 3, "errors": 1, "inTokens": 25, "outTokens": 820})
        self.assertEqual(s["tools"]["browser_snapshot"]["maxOutTokens"], 500)
        rep = led.report()
        self.assertIn("Tool definitions (fixed per session): ~2,000 tokens, 10 tools", rep)
        self.assertIn("Calls: 3 (1 errors)", rep)
        self.assertIn("Total added to context ≈ 2,845 tokens", rep)
        self.assertLess(rep.index("browser_snapshot |"), rep.index("browser_click |"), "sorted by output tokens")

    def test_measured_wraps_without_changing_results_and_counts_text_errors(self):
        led = UsageLedger()

        def ok_tool(x: str = "") -> str:
            return "hello world" * 10

        def bad_tool() -> str:
            return "[policy] denied"

        def raising_tool() -> str:
            raise RuntimeError("boom")

        self.assertEqual(measured(led, "ok", ok_tool)(x="abc"), "hello world" * 10)
        self.assertEqual(measured(led, "bad", bad_tool)(), "[policy] denied")
        with self.assertRaises(RuntimeError):
            measured(led, "boom", raising_tool)()
        s = led.summary()
        self.assertEqual((s["tools"]["ok"]["calls"], s["tools"]["ok"]["errors"]), (1, 0))
        self.assertEqual(s["tools"]["bad"]["errors"], 1)
        self.assertEqual(s["tools"]["boom"]["errors"], 1)
        self.assertGreater(s["tools"]["ok"]["outTokens"], 20)
        self.assertEqual(measured(led, "n", ok_tool).__name__, "ok_tool", "functools.wraps keeps the signature FastMCP reads")

    def test_flush_writes_current_and_bounded_history(self):
        d = tempfile.mkdtemp(prefix="ae-usage-")
        led = UsageLedger(d)
        led.flush()
        self.assertFalse(os.path.exists(os.path.join(d, "usage.json")), "nothing worth recording")
        led.record("t", 1, 2, 1.0, True)
        led.flush()
        with open(os.path.join(d, "usage.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["totals"]["calls"], 1)
        for _ in range(210):
            led.flush()
        with open(os.path.join(d, "usage-history.jsonl"), encoding="utf-8") as f:
            self.assertEqual(len([ln for ln in f.read().split("\n") if ln]), 200)


if __name__ == "__main__":
    unittest.main()
