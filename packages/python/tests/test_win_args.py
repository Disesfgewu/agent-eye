"""Issue #27: metacharacters in start_dev_server args must not reach cmd.exe as operators."""
import os
import tempfile
import time
import unittest

from agent_eye import guards
from agent_eye.devserver import DevServerManager
from agent_eye.policy import DEFAULT_CMD_ALLOWLIST
from agent_eye.win_args import quote_win_arg, windows_unsafe_arg

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

    @unittest.skipUnless(WIN, "Windows-only path")
    def test_guard_blocks_and_process_does_not_inject(self):
        ws = tempfile.mkdtemp(prefix="ae-inj-")
        for args in (["run", 'a"b'], ["run", "%COMSPEC%"], ["run", "x^&calc"]):
            self.assertEqual(guards.classify_command("npm", args, ".", ws, DEFAULT_CMD_ALLOWLIST)[0], "blocked")
        m = DevServerManager()
        m.start("t", "node", ["--version", "&echo", "pwned>PWNED.txt"], ws)
        time.sleep(3)
        m.stop_all()
        self.assertFalse(os.path.exists(os.path.join(ws, "PWNED.txt")))
        with self.assertRaises(RuntimeError):
            m.start("u", "node", ["--version", 'a"b'], ws)


if __name__ == "__main__":
    unittest.main()
