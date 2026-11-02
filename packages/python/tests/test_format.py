"""Conformance: the Python formatters must produce exactly what the TypeScript ones do.

Runs packages/mcp-server/tests/fixtures/format-cases.json (golden cases computed from the TS reference).
"""
import json
import os
import unittest

from agent_eye import format as F
from agent_eye.guards import redact_text

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "mcp-server", "tests", "fixtures", "format-cases.json")
with open(FIXTURE, encoding="utf-8") as f:
    CASES = json.load(f)["cases"]

REDACTORS = {"identity": lambda u: u, "secrets": lambda u: redact_text(u, True)}
FUNCS = {
    "filterInteractive": F.filter_interactive, "limitDepth": F.limit_depth, "findInSnapshot": F.find_in_snapshot,
    "diffSnapshots": F.diff_snapshots, "truncateText": F.truncate_text, "formatConsole": F.format_console,
    "formatNetwork": F.format_network, "selectNetwork": F.select_network, "formatHealth": F.format_health,
    "parseRef": F.parse_ref,
}


def with_redact(opts):
    return {**opts, "redact": REDACTORS[opts["redact"]]} if isinstance(opts.get("redact"), str) else opts


class FormatConformance(unittest.TestCase):
    def test_fixture_is_not_vacuous(self):
        self.assertGreaterEqual(len(CASES), 40)
        self.assertGreaterEqual(len({c["fn"] for c in CASES}), 10)

    def test_every_golden_case(self):
        for c in CASES:
            with self.subTest(case=c["name"]):
                args = c["args"]
                if c["fn"] == "formatHealth":
                    args = [with_redact(args[0])]
                elif c["fn"] in ("formatNetwork", "selectNetwork"):
                    args = [args[0], with_redact(args[1])]
                self.assertEqual(FUNCS[c["fn"]](*args), c["expect"])


if __name__ == "__main__":
    unittest.main()
