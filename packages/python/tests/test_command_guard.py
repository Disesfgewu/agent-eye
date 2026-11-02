"""Conformance: the Python command guard must agree with the TypeScript one.

Both suites execute packages/mcp-server/tests/fixtures/command-cases.json, so a
rule added or fixed on one side that is missing on the other fails CI.
"""
import json
import os
import tempfile
import unittest

from agent_eye import guards
from agent_eye.interpreter_guard import inline_code_reason
from agent_eye.policy import DEFAULT_CMD_ALLOWLIST

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "..", "mcp-server", "tests", "fixtures")
with open(os.path.join(FIXTURES, "command-cases.json"), encoding="utf-8") as f:
    CASES = json.load(f)


class CommandGuardConformance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ws = tempfile.mkdtemp(prefix="ae-py-")

    def verdict(self, cmd, args):
        return guards.classify_command(cmd, args, ".", self.ws, DEFAULT_CMD_ALLOWLIST)[0]

    def test_safe_commands_stay_allowlisted(self):
        for case in CASES["safe"]:
            cmd, args = case[0], case[1]
            with self.subTest(cmd=cmd, args=args):
                self.assertEqual(self.verdict(cmd, args), "allowlisted")

    def test_inline_remote_and_escaping_commands_are_not_allowlisted(self):
        for case in CASES["blocked"]:
            cmd, args = case[0], case[1]
            with self.subTest(cmd=cmd, args=args):
                v = self.verdict(cmd, args)
                # On Windows an argument cmd.exe would interpret (" % ^) is refused outright: stricter, still not allowed.
                self.assertIn(v, ("outside", "blocked") if os.name == "nt" else ("outside",))
                if v != "outside":
                    continue
                base = os.path.basename(cmd)
                for ext in (".exe", ".cmd", ".bat", ".ps1"):
                    if base.lower().endswith(ext):
                        base = base[: -len(ext)]
                self.assertTrue(inline_code_reason(base, args), "has a reason")

    def test_windows_shims_get_the_same_rules(self):
        self.assertEqual(self.verdict("go.exe", ["run", "."]), "allowlisted")
        self.assertEqual(self.verdict("go.exe", ["run", "-exec", "sh", "."]), "outside")
        self.assertEqual(self.verdict("mvnw.cmd", ["spring-boot:run"]), "allowlisted")
        self.assertEqual(self.verdict("gradlew.bat", ["bootRun", "-I", "x"]), "outside")
        self.assertEqual(self.verdict("node.exe", ["-e", "1"]), "outside")
        self.assertEqual(self.verdict("python.exe", ["-c", "1"]), "outside")
        self.assertEqual(self.verdict("npx.cmd", ["evil"]), "outside")

    def test_wrappers_with_a_path_must_stay_inside_the_workspace(self):
        self.assertEqual(self.verdict("./mvnw", ["spring-boot:run"]), "allowlisted")
        self.assertEqual(self.verdict("./backend/gradlew", ["bootRun"]), "allowlisted")
        self.assertEqual(self.verdict("../../tmp/evil/mvnw", ["spring-boot:run"]), "outside")
        self.assertEqual(self.verdict("/opt/evil/gradlew", ["bootRun"]), "outside")

    def test_metadata_hosts_are_hard_blocked(self):
        for host in ("169.254.169.254", "metadata.google.internal", "metadata.goog", "100.100.100.200", "168.63.129.16"):
            with self.subTest(host=host):
                self.assertEqual(guards.classify_url(f"http://{host}/", ["localhost", host])[0], "blocked")

    def test_toolchain_launchers_are_in_the_default_allowlist(self):
        for c in ("go", "cargo", "trunk", "dx", "air", "templ", "wails", "dotnet", "mvn", "mvnw", "gradle", "gradlew", "mix"):
            self.assertIn(c, DEFAULT_CMD_ALLOWLIST)


if __name__ == "__main__":
    unittest.main()
