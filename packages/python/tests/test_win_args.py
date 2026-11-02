"""Issues #27/#35: cmd.exe metacharacters in start_dev_server args; real executables are spawned directly."""
import json
import os
import tempfile
import time
import unittest

from agent_eye import guards
from agent_eye.devserver import DevServerManager
from agent_eye.policy import DEFAULT_CMD_ALLOWLIST
from agent_eye.win_args import quote_win_arg, windows_launch, windows_unsafe_arg

WIN = os.name == "nt"


class WinArgs(unittest.TestCase):
    def test_unsafe_args_are_refused(self):
        for bad in ['a"b', "%PATH%", "x^y", '"&calc"']:
            self.assertIsNotNone(windows_unsafe_arg(bad), bad)
        for ok in ["run", "--port=3000", "&echo", "a>b", "a b", "(x)", ""]:
            self.assertIsNone(windows_unsafe_arg(ok), ok)

    def test_quoting_makes_operators_literal(self):
        self.assertEqual(quote_win_arg("&echo"), '"&echo"')
        self.assertEqual(quote_win_arg("x>file"), '"x>file"')
        self.assertEqual(quote_win_arg("a b"), '"a b"')
        self.assertEqual(quote_win_arg(""), '""')
        self.assertEqual(quote_win_arg("--port=3000"), "--port=3000")

    def test_windows_launch_resolution(self):
        d = tempfile.mkdtemp(prefix="ae-launch-")
        cwd = tempfile.mkdtemp(prefix="ae-cwd-")
        for f in ("tool.exe", "shim.cmd", "old.bat", "both.cmd", "both.exe"):
            open(os.path.join(d, f), "w").close()
        env = {"PATH": d, "PATHEXT": ".COM;.EXE;.BAT;.CMD"}
        self.assertEqual(windows_launch("tool", cwd, env), ("direct", os.path.join(d, "tool.exe")))
        self.assertEqual(windows_launch("tool.exe", cwd, env)[0], "direct")
        self.assertEqual(windows_launch("shim", cwd, env), ("cmd", None))
        self.assertEqual(windows_launch("old", cwd, env), ("cmd", None))
        self.assertEqual(windows_launch("both", cwd, env)[0], "direct")
        self.assertEqual(windows_launch("missing", cwd, env), ("cmd", None))
        open(os.path.join(cwd, "shim.exe"), "w").close()
        self.assertEqual(windows_launch("shim", cwd, env)[0], "direct", "cwd wins over PATH, like cmd.exe")

    @unittest.skipUnless(WIN, "Windows-only path")
    def test_shims_are_strict_and_real_executables_get_literal_args(self):
        ws = tempfile.mkdtemp(prefix="ae-inj-")
        for args in (["run", 'a"b'], ["run", "%COMSPEC%"], ["run", "x^&calc"]):
            self.assertEqual(guards.classify_command("npm", args, ".", ws, DEFAULT_CMD_ALLOWLIST)[0], "blocked")
        want = ['a"b', "%PATH%", "x^&y", "&echo", "p>q", "two words"]
        self.assertEqual(guards.classify_command("python", ["dump.py", *want], ".", ws, DEFAULT_CMD_ALLOWLIST)[0], "allowlisted")
        with open(os.path.join(ws, "dump.py"), "w", encoding="utf-8") as f:
            f.write("import json, sys\njson.dump(sys.argv[1:], open('argv.json', 'w'))\n")
        m = DevServerManager()
        m.start("d", "python", ["dump.py", *want], ws)
        time.sleep(3)
        m.stop_all()
        with open(os.path.join(ws, "argv.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), want)
        self.assertFalse(os.path.exists(os.path.join(ws, "q")), "no redirection happened")
        m2 = DevServerManager()
        m2.start("t", "npm", ["--version", "&echo", "pwned>PWNED.txt"], ws)
        time.sleep(4)
        m2.stop_all()
        self.assertFalse(os.path.exists(os.path.join(ws, "PWNED.txt")))
        with self.assertRaises(RuntimeError):
            m2.start("u", "npm", ["--version", 'a"b'], ws)


if __name__ == "__main__":
    unittest.main()
