"""Conformance: engine / viewport / device / CDP rules must agree with the TypeScript reference (golden cases)."""
import json
import os
import unittest

from agent_eye import engine as E

FIX = os.path.join(os.path.dirname(__file__), "..", "..", "mcp-server", "tests", "fixtures", "engine-cases.json")
with open(FIX, encoding="utf-8") as f:
    G = json.load(f)


def outcome(fn, *args):
    """{"value": ...} or {"error": message}, like the generator records it (None <-> JSON null)."""
    try:
        return {"value": fn(*args)}
    except ValueError as exc:
        return {"error": str(exc)}


class EngineGolden(unittest.TestCase):
    def test_fixture_is_not_vacuous(self):
        for key, n in (("engines", 9), ("viewports", 15), ("deviceCases", 20), ("hints", 12), ("cdpUrls", 18), ("incompat", 7)):
            self.assertGreaterEqual(len(G[key]), n, key)

    def test_parse_engine(self):
        for c in G["engines"]:
            with self.subTest(input=c["input"]):
                self.assertEqual(outcome(E.parse_engine, c["input"]), {k: c[k] for k in ("value", "error") if k in c})

    def test_parse_viewport(self):
        for c in G["viewports"]:
            with self.subTest(input=c["input"]):
                self.assertEqual(outcome(E.parse_viewport, c["input"]), {k: c[k] for k in ("value", "error") if k in c})

    def test_resolve_device(self):
        for c in G["deviceCases"]:
            with self.subTest(name=c["name"], engine=c["engine"]):
                self.assertEqual(outcome(E.resolve_device, G["devices"], c["name"], c["engine"]), {k: c[k] for k in ("value", "error") if k in c})

    def test_launch_error_hint(self):
        for c in G["hints"]:
            with self.subTest(engine=c["engine"], message=c["message"]):
                hint = E.launch_error_hint(c["engine"], Exception(c["message"]))
                self.assertEqual(str(hint) if hint else None, c["expect"])
        self.assertIn("python -m playwright install firefox", str(E.launch_error_hint("firefox", Exception("Executable doesn't exist"), "python -m playwright install")))

    def test_parse_cdp_url(self):
        for c in G["cdpUrls"]:
            with self.subTest(input=c["input"]):
                self.assertEqual(outcome(E.parse_cdp_url, c["input"]), {k: c[k] for k in ("value", "error") if k in c})

    def test_cdp_incompatibility(self):
        for c in G["incompat"]:
            with self.subTest(env=c["env"], channel=c["channel"]):
                self.assertEqual(E.cdp_incompatibility(c["env"], c["channel"]), c["expect"])


if __name__ == "__main__":
    unittest.main()
