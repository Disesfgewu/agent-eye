"""AgentEye.detect_project + start_dev_server readiness against real processes (Python http.server)."""
import os
import shutil
import socket
import sys
import tempfile
import unittest

from agent_eye import AgentEye
from agent_eye.policy import Policy


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class DevServerReadiness(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp(prefix="ae-py-ws-")
        os.makedirs(os.path.join(self.ws, "site"))
        with open(os.path.join(self.ws, "site", "index.html"), "w", encoding="utf-8") as f:
            f.write("<h1>ok</h1>")
        with open(os.path.join(self.ws, "package.json"), "w", encoding="utf-8") as f:
            f.write('{"scripts":{"dev":"vite"},"devDependencies":{"vite":"5"}}')
        self.eye = AgentEye(workspace=self.ws, policy=Policy(), on_approve=lambda *_: True, headless=True)
        self.py = "python" if os.name == "nt" else "python3"

    def tearDown(self):
        self.eye._dev.stop_all()
        shutil.rmtree(self.ws, ignore_errors=True)

    def test_detect_project_lists_the_vite_app_and_scopes_to_a_subdirectory(self):
        out = self.eye.detect_project()
        self.assertIn('command="npm" args=["run","dev"]', out)
        scoped = self.eye.detect_project("site")
        self.assertIn("Static HTML @ site", scoped)
        self.assertNotIn("Vite", scoped)
        with self.assertRaises(Exception):
            self.eye.detect_project("..")

    def test_wait_until_ready_then_refuse_a_port_that_is_taken(self):
        port = free_port()
        out = self.eye.start_dev_server("web", self.py, ["-m", "http.server", str(port)], "site", port=port, wait_seconds=20)
        self.assertIn(f"Ready: http://localhost:{port}", out)
        with self.assertRaises(RuntimeError) as ctx:
            self.eye.start_dev_server("web2", self.py, ["-m", "http.server", str(port)], "site", port=port)
        self.assertIn("already accepts connections", str(ctx.exception))
        again = self.eye.start_dev_server("web", self.py, ["-m", "http.server", str(port)], "site", port=port)
        self.assertIn("already running", again)
        self.assertIn("Ready", again)

    def test_a_process_that_dies_returns_its_output_instead_of_hanging(self):
        port = free_port()
        # a script file (inline `-c` code is refused by the interpreter guard)
        with open(os.path.join(self.ws, "boom.py"), "w", encoding="utf-8") as f:
            f.write("import sys\nprint('compile error: nope')\nsys.exit(3)\n")
        with self.assertRaises(RuntimeError) as ctx:
            self.eye.start_dev_server("boom", self.py, ["boom.py"], ".", port=port, wait_seconds=20)
        self.assertIn("exited with code 3", str(ctx.exception))
        self.assertIn("compile error: nope", str(ctx.exception))

    def test_inline_code_is_refused(self):
        with self.assertRaises(Exception):
            self.eye.start_dev_server("x", self.py, ["-c", "print(1)"], ".")

    def test_timeout_says_how_to_keep_waiting(self):
        port = free_port()
        with open(os.path.join(self.ws, "sleepy.py"), "w", encoding="utf-8") as f:
            f.write("import time\nprint('listening soon on port %d')\ntime.sleep(30)\n" % (port + 1))
        out = self.eye.start_dev_server("sleepy", self.py, ["sleepy.py"], ".", port=port, wait_seconds=1)
        self.assertIn("Still running but port", out)
        self.assertIn("same id and port", out)
        self.assertIn(f"{port + 1}", out)


if __name__ == "__main__":
    unittest.main()
