"""Conformance for the state guards and the performance summary: golden cases computed from the TypeScript reference."""
import json
import os
import tempfile
import unittest

from agent_eye import perf as P
from agent_eye import state_guard as S

FIX = os.path.join(os.path.dirname(__file__), "..", "..", "mcp-server", "tests", "fixtures")
with open(os.path.join(FIX, "state-cases.json"), encoding="utf-8") as f:
    STATE = json.load(f)["storage"]
with open(os.path.join(FIX, "perf-cases.json"), encoding="utf-8") as f:
    PERF = json.load(f)


class StorageGolden(unittest.TestCase):
    def test_fixture_is_not_vacuous(self):
        self.assertGreaterEqual(len(STATE), 20)
        self.assertGreaterEqual(sum(1 for c in STATE if c["expect"]), 10)

    def test_every_case_matches_the_typescript_reference(self):
        for c in STATE:
            with self.subTest(case=c["name"]):
                self.assertEqual(S.storage_input_problem(c["input"]), c["expect"])


class PerfGolden(unittest.TestCase):
    def test_injected_scripts_are_byte_identical_to_the_typescript_ones(self):
        self.assertEqual(P.PERF_INIT_SCRIPT, PERF["initScript"])
        self.assertEqual(P.PERF_COLLECT_SCRIPT, PERF["collectScript"])

    def test_formatted_reports(self):
        for c in PERF["perf"]:
            with self.subTest(case=c["name"]):
                self.assertEqual(P.format_perf(c["raw"], c["ctx"]), c["expect"])

    def test_total_blocking_time(self):
        for c in PERF["tbt"]:
            with self.subTest(long=c["long"], fcp=c["fcp"]):
                self.assertEqual(P.total_blocking_time(c["long"], c["fcp"]), c["expect"])

    def test_ratings_at_the_boundaries(self):
        for c in PERF["rates"]:
            with self.subTest(metric=c["metric"], value=c["value"]):
                self.assertEqual(P.rate(c["metric"], c["value"]), c["expect"])


class UploadPaths(unittest.TestCase):
    """Filesystem rules (mirrors tests/state-guard.test.mjs)."""

    @classmethod
    def setUpClass(cls):
        cls.ws = os.path.realpath(tempfile.mkdtemp(prefix="ae-state-"))
        cls.out = os.path.realpath(tempfile.mkdtemp(prefix="ae-state-out-"))

        def w(rel, body="x"):
            p = os.path.join(cls.ws, *rel.split("/"))
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(body)
        w("fixtures/photo.png", "png-bytes")
        w("notes.md", "hello")
        for rel in (".env", ".env.local", "config/id_rsa", "certs/server.pem", "certs/cert.key", "credentials.json",
                    ".git/config", ".agent-eye/policy.json", "app/.ssh/known_hosts"):
            w(rel)
        os.makedirs(os.path.join(cls.ws, "adir"))
        with open(os.path.join(cls.out, "secret.txt"), "w", encoding="utf-8") as fh:
            fh.write("outside")

    def test_plain_files_are_accepted(self):
        ok, res = S.check_upload_path(self.ws, "fixtures/photo.png")
        self.assertTrue(ok)
        self.assertEqual(res["size"], 9)
        self.assertTrue(S.check_upload_path(self.ws, os.path.join(self.ws, "notes.md"))[0])

    def test_secrets_and_tooling_state_are_refused(self):
        for p in (".env", ".env.local", "config/id_rsa", "certs/server.pem", "certs/cert.key", "credentials.json",
                  ".git/config", ".agent-eye/policy.json", "app/.ssh/known_hosts"):
            self.assertFalse(S.check_upload_path(self.ws, p)[0], p)

    def test_outside_directories_and_missing_files_are_refused(self):
        self.assertIn("outside the workspace", S.check_upload_path(self.ws, os.path.join(self.out, "secret.txt"))[1])
        rel = os.path.relpath(os.path.join(self.out, "secret.txt"), self.ws)
        self.assertIn("outside the workspace", S.check_upload_path(self.ws, rel)[1])
        self.assertIn("not a regular file", S.check_upload_path(self.ws, "adir")[1])
        self.assertIn("does not exist", S.check_upload_path(self.ws, "nope.txt")[1])
        self.assertFalse(S.check_upload_path(self.ws, "")[0])
        self.assertFalse(S.check_upload_path(self.ws, "a\0b")[0])

    def test_symlink_pointing_outside_is_resolved_and_refused(self):
        try:
            os.symlink(os.path.join(self.out, "secret.txt"), os.path.join(self.ws, "innocent.txt"))
        except (OSError, NotImplementedError):
            self.skipTest("symlinks need privileges on this machine")
        self.assertIn("outside the workspace", S.check_upload_path(self.ws, "innocent.txt")[1])

    def test_size_and_count_limits(self):
        with open(os.path.join(self.ws, "big.bin"), "wb") as fh:
            fh.write(b"\0" * (S.MAX_UPLOAD_FILE_BYTES + 1))
        self.assertIn("limit 25 MB per file", S.check_upload_path(self.ws, "big.bin")[1])
        self.assertIn("at most 10", S.check_uploads(self.ws, ["notes.md"] * 11)[1])
        self.assertIn("no files", S.check_uploads(self.ws, [])[1])
        ok, files = S.check_uploads(self.ws, ["notes.md", "fixtures/photo.png"])
        self.assertTrue(ok)
        self.assertEqual([f["name"] for f in files], ["notes.md", "photo.png"])


if __name__ == "__main__":
    unittest.main()
