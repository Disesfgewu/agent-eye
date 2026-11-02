"""Issue #68: dev servers must not be orphaned when the agent process dies abruptly, and the reaper must never kill a process
that merely reuses a recorded PID."""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from agent_eye.reaper import ProcessReaper, kill_tree, process_start

HELPER = os.path.join(os.path.dirname(__file__), "_agent_proc.py")
SLEEPER = [sys.executable, "-c", "import time; time.sleep(300)"]


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def port_open(port: int) -> bool:
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.3).close()
        return True
    except OSError:
        return False


def readline_within(stream, seconds: float):
    """stream.readline() that gives up (returns None) instead of blocking forever when the other side never answers."""
    box = []
    t = threading.Thread(target=lambda: box.append(stream.readline()), daemon=True)
    t.start()
    t.join(seconds)
    return box[0] if box else None


def wait_until(pred, seconds=15.0) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.2)
    return pred()


class ProcessStart(unittest.TestCase):
    def test_start_token_is_stable_for_a_live_process_and_none_for_a_gone_one(self):
        p = subprocess.Popen(SLEEPER)
        try:
            a = process_start(p.pid)
            self.assertTrue(a)
            self.assertEqual(a, process_start(p.pid))
            if sys.platform != "darwin":  # macOS reports the start time with 1-second resolution (`ps -o lstart`)
                self.assertNotEqual(a, process_start(os.getpid()), "different processes have different start tokens")
        finally:
            p.kill()
            p.wait()
        self.assertTrue(wait_until(lambda: process_start(p.pid) is None, 5), "an exited process has no start token")
        self.assertIsNone(process_start(0))


@unittest.skipUnless(sys.platform.startswith("linux"), "zombie processes: Linux only")
class Zombies(unittest.TestCase):
    """A killed process stays a zombie (and /proc/<pid> stays readable) until its parent wait()s for it. It is finished."""

    def make_zombie(self):
        pid = os.fork()
        if pid == 0:
            os._exit(0)
        self.assertTrue(wait_until(lambda: "Z" == open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[0], 5), "premise: a zombie")
        self.addCleanup(os.waitpid, pid, 0)
        return pid

    def test_a_zombie_has_no_start_token(self):
        self.assertIsNone(process_start(self.make_zombie()))

    def test_a_zombie_owner_counts_as_dead_and_its_children_are_reaped(self):
        d = tempfile.mkdtemp(prefix="ae-zombie-")
        child = subprocess.Popen(SLEEPER)
        try:
            zombie = self.make_zombie()
            with open(os.path.join(d, str(zombie)), "w", encoding="utf-8") as f:
                json.dump({"ownerStart": "any", "children": [{"pid": child.pid, "start": process_start(child.pid)}]}, f)
            self.assertEqual(ProcessReaper.reap_stale(d), [child.pid])
            self.assertTrue(wait_until(lambda: child.poll() is not None, 10))
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()


class ReapStale(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ae-pids-")
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()
            p.wait()

    def spawn(self):
        p = subprocess.Popen(SLEEPER)
        self.procs.append(p)
        return p

    def record(self, owner_pid, owner_start, children):
        with open(os.path.join(self.dir, str(owner_pid)), "w", encoding="utf-8") as f:
            json.dump({"ownerStart": owner_start, "children": [{"pid": p, "start": s} for p, s in children]}, f)

    def dead_pid(self):
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        return p.pid

    def test_orphan_of_a_dead_owner_with_matching_start_time_is_killed(self):
        child = self.spawn()
        self.record(self.dead_pid(), "whatever", [(child.pid, process_start(child.pid))])
        killed = ProcessReaper.reap_stale(self.dir)
        self.assertEqual(killed, [child.pid])
        self.assertTrue(wait_until(lambda: child.poll() is not None, 10), "the orphan is really dead")
        self.assertEqual(os.listdir(self.dir), [], "the dead owner's record is removed")

    def test_a_reused_pid_is_never_killed(self):
        innocent = self.spawn()
        # the record claims this PID started at a different time than the process now alive under it
        self.record(self.dead_pid(), None, [(innocent.pid, "start-time-of-some-earlier-process")])
        self.assertEqual(ProcessReaper.reap_stale(self.dir), [])
        time.sleep(0.5)
        self.assertIsNone(innocent.poll(), "an unrelated process that reuses a recorded PID must survive")
        self.assertEqual(os.listdir(self.dir), [])

    def test_children_of_a_live_owner_are_left_alone(self):
        owner, child = self.spawn(), self.spawn()
        self.record(owner.pid, process_start(owner.pid), [(child.pid, process_start(child.pid))])
        self.assertEqual(ProcessReaper.reap_stale(self.dir), [])
        self.assertIsNone(child.poll())
        self.assertEqual(os.listdir(self.dir), [str(owner.pid)], "a live owner's record stays")

    def test_an_owner_pid_reused_by_another_process_counts_as_dead(self):
        stranger, child = self.spawn(), self.spawn()
        self.record(stranger.pid, "start-time-of-the-original-owner", [(child.pid, process_start(child.pid))])
        self.assertEqual(ProcessReaper.reap_stale(self.dir), [child.pid])
        self.assertTrue(wait_until(lambda: child.poll() is not None, 10))
        self.assertIsNone(stranger.poll(), "the stranger that reused the owner PID is not touched")

    def test_corrupt_and_foreign_files_are_ignored(self):
        with open(os.path.join(self.dir, "not-a-pid"), "w") as f:
            f.write("x")
        with open(os.path.join(self.dir, str(self.dead_pid())), "w") as f:
            f.write("{ not json")
        self.assertEqual(ProcessReaper.reap_stale(self.dir), [])
        self.assertEqual(os.listdir(self.dir), ["not-a-pid"])

    def test_track_untrack_round_trip(self):
        r = ProcessReaper(self.dir)
        child = self.spawn()
        r.track(child.pid)
        with open(r.file, encoding="utf-8") as f:
            rec = json.load(f)
        self.assertEqual(rec["children"], [{"pid": child.pid, "start": process_start(child.pid)}])
        r.untrack(child.pid)
        with open(r.file, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["children"], [])
        r.dispose()
        self.assertFalse(os.path.exists(r.file))


class AbruptDeath(unittest.TestCase):
    """The scenario from the issue, with real processes: the agent is killed hard, a second one must find the port free."""

    def test_a_hard_killed_agent_leaves_no_server_behind(self):
        ws = tempfile.mkdtemp(prefix="ae-orphan-")
        port = free_port()
        env = {**os.environ, "AGENT_EYE_HEADLESS": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        agent = subprocess.Popen([sys.executable, "-W", "ignore", HELPER, ws], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 text=True, encoding="utf-8", env=env, bufsize=1)
        child_pid = None
        agent_pid = None
        try:
            hello = json.loads(agent.stdout.readline())
            self.assertTrue(hello.get("ready"))
            # the real agent process: on Windows a venv's python.exe is a launcher, so Popen.pid is not the interpreter
            agent_pid = hello["pid"]
            agent.stdin.write(json.dumps({"call": "start_dev_server", "args": ["web", sys.executable, ["-m", "http.server", str(port), "--bind", "127.0.0.1"]]}) + "\n")
            agent.stdin.flush()
            self.assertIn("ok", json.loads(agent.stdout.readline()))
            self.assertTrue(wait_until(lambda: port_open(port)), "the dev server is up")
            with open(os.path.join(ws, ".agent-eye", "pids", str(agent_pid)), encoding="utf-8") as f:
                children = json.load(f)["children"]
            self.assertEqual(len(children), 1, "the server was registered with the reaper")
            child_pid = children[0]["pid"]

            # SIGKILL / TerminateProcess on the interpreter itself: no atexit, no close()
            os.kill(agent_pid, signal.SIGKILL if hasattr(signal, "SIGKILL") else signal.SIGTERM)
            self.assertTrue(wait_until(lambda: process_start(agent_pid) is None, 10), "the agent is dead")
            self.assertTrue(port_open(port), "premise: the orphan keeps holding the port after its owner died")

            # a new agent in the same workspace reaps it when it starts
            second = subprocess.Popen([sys.executable, "-W", "ignore", HELPER, ws], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      text=True, encoding="utf-8", env=env, bufsize=1)
            try:
                self.assertTrue(json.loads(second.stdout.readline()).get("ready"))
                self.assertTrue(wait_until(lambda: not port_open(port), 20), "the orphaned server was reaped and the port is free")
                self.assertFalse(os.path.exists(os.path.join(ws, ".agent-eye", "pids", str(agent_pid))))
            finally:
                second.stdin.close()
                second.wait(timeout=30)
        finally:
            if agent_pid and process_start(agent_pid):
                kill_tree(agent_pid)
            if agent.poll() is None:
                agent.kill()
            if child_pid and process_start(child_pid):
                kill_tree(child_pid)


class DevServerStdin(unittest.TestCase):
    """A dev server must not inherit the agent's stdin. In the Python MCP server that stdin IS the JSON-RPC channel: a server that
    reads stdin would steal protocol messages. (Found because the abrupt-death test's server never came up when the agent's stdin
    was a pipe.)"""

    def test_children_get_an_empty_stdin_not_the_agents(self):
        ws = tempfile.mkdtemp(prefix="ae-stdin-")
        with open(os.path.join(ws, "readin.py"), "w", encoding="utf-8") as f:
            f.write("import sys\nprint('stdin=' + repr(sys.stdin.read()), flush=True)\nimport time\ntime.sleep(5)\n")
        env = {**os.environ, "AGENT_EYE_HEADLESS": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        agent = subprocess.Popen([sys.executable, "-W", "ignore", HELPER, ws], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 text=True, encoding="utf-8", env=env, bufsize=1)
        try:
            self.assertTrue(json.loads(agent.stdout.readline()).get("ready"))
            agent.stdin.write(json.dumps({"call": "start_dev_server", "args": ["reader", sys.executable, ["readin.py"]]}) + "\n")
            agent.stdin.flush()
            started = readline_within(agent.stdout, 20)
            self.assertIsNotNone(started, "the agent did not answer start_dev_server")
            self.assertIn("ok", json.loads(started))
            seen = ""
            for _ in range(24):
                agent.stdin.write(json.dumps({"call": "get_dev_server_logs", "args": ["reader"]}) + "\n")
                agent.stdin.flush()
                reply = readline_within(agent.stdout, 5)
                # a child that inherited the agent's stdin swallows these commands, so the agent never replies
                self.assertIsNotNone(reply, "the agent stopped answering: its stdin was consumed by the dev server")
                seen = json.dumps(json.loads(reply))
                if "stdin=" in seen:
                    break
                time.sleep(0.25)
            self.assertIn("stdin=''", seen, "the child saw EOF immediately instead of blocking on the agent's stdin")
        finally:
            agent.kill()
            agent.wait()


if __name__ == "__main__":
    unittest.main()
