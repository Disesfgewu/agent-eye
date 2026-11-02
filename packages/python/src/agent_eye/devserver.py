"""Dev-server child-process management (plan 7.2): argv/shell-safe spawn,
workspace-bound cwd, log capture, and whole-tree teardown."""
from __future__ import annotations

import os
import subprocess
import sys
import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .win_args import quote_win_arg, windows_launch, windows_unsafe_arg

IS_WINDOWS = sys.platform == "win32"
LOG_CAPACITY = 1000


@dataclass
class _Server:
    id: str
    command: str
    args: list
    cwd: str
    proc: subprocess.Popen
    logs: deque = field(default_factory=lambda: deque(maxlen=LOG_CAPACITY))
    status: str = "running"
    exit_code: object = None


class DevServerManager:
    def __init__(self, reaper=None):
        self._servers: dict = {}
        self._reaper = reaper  # ProcessReaper: records children so an abrupt death of this process cannot orphan them

    def start(self, sid: str, command: str, args: list, cwd: str) -> bool:
        existing = self._servers.get(sid)
        if existing and existing.status == "running":
            return True  # already running
        # PYTHONUNBUFFERED: Python dev servers otherwise buffer stdout when piped, hiding "listening on ..." lines.
        env = {**os.environ, "FORCE_COLOR": "0", "BROWSER": "none", "PYTHONUNBUFFERED": "1"}
        launch = windows_launch(command, cwd, env) if IS_WINDOWS else ("direct", None)
        if IS_WINDOWS and launch[0] == "direct":
            # a real .exe: no shell, any argument is data (Issue #35)
            proc = subprocess.Popen(
                [launch[1], *args], cwd=cwd, env=env,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            )
        elif IS_WINDOWS:
            # Defense in depth: the guard already refuses these (Issue #27), but this module must not rely on it.
            for a in [command, *args]:
                unsafe = windows_unsafe_arg(a)
                if unsafe:
                    raise RuntimeError(f"Refusing to start: {unsafe}.")
            line = " ".join([command, *(quote_win_arg(a) for a in args)])
            proc = subprocess.Popen(
                line, cwd=cwd, env=env, shell=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1,
            )
        else:
            proc = subprocess.Popen(
                [command, *args], cwd=cwd, env=env,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, start_new_session=True,
            )
        server = _Server(id=sid, command=command, args=list(args), cwd=cwd, proc=proc)
        self._servers[sid] = server
        if self._reaper:
            self._reaper.track(proc.pid)
        threading.Thread(target=self._pump, args=(server,), daemon=True).start()
        return False

    def _pump(self, server: _Server):
        assert server.proc.stdout is not None
        for line in server.proc.stdout:
            server.logs.append({
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "text": line.rstrip("\n"),
            })
        server.proc.wait()
        if self._reaper:
            self._reaper.untrack(server.proc.pid)
        server.status = "exited"
        server.exit_code = server.proc.returncode

    def get_logs(self, sid: str, limit=None):
        server = self._servers.get(sid)
        if not server:
            return None
        logs = list(server.logs)
        return logs[-limit:] if limit else logs

    def get_status(self, sid: str):
        server = self._servers.get(sid)
        if not server:
            return None
        return {"status": server.status, "exit_code": server.exit_code}

    def stop(self, sid: str) -> bool:
        server = self._servers.get(sid)
        if not server:
            return False
        if server.status == "running":
            _kill_tree(server.proc)
        if self._reaper:
            self._reaper.untrack(server.proc.pid)
        server.status = "exited"
        return True

    def stop_all(self):
        for sid in list(self._servers.keys()):
            self.stop(sid)


def _kill_tree(proc: subprocess.Popen):
    try:
        if IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        else:
            import signal
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass
