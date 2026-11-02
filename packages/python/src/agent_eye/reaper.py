"""Process reaper (port of the idea in packages/mcp-server/src/reaper.ts, Issue #68).

Normal exits stop dev servers in ``AgentEye.close()``. An ABRUPT death of the Python process (SIGKILL, crash, terminal
closed, the agent host force-killed) orphans the servers it started: Go/Rust/Node/JVM processes keep holding their ports and
the next ``start_dev_server`` fails with "port already in use". This registry records every child this process spawns and,
at the next start, reaps the children of owners that are no longer alive.

Safety invariants:

* Only processes THIS tool started and registered are ever killed, never an arbitrary PID.
* A recorded PID is killed only if the process alive under it has the SAME START TIME as when it was registered. PIDs are
  reused (after a reboot, or just after a long time), so "the PID is alive" is not evidence that it is our orphan.
* The owner is judged the same way: an owner PID that is alive but started at a different time is a dead owner whose PID was
  reused, so its children are reaped; a genuinely live owner (another agent in the same workspace) is never touched.
"""
from __future__ import annotations

import atexit
import json
import os
import subprocess
import sys
import threading
from typing import Dict, List, Optional

IS_WINDOWS = sys.platform == "win32"


def process_start(pid: int) -> Optional[str]:
    """An opaque token that changes if the PID is reused: the process start time. None if the process is gone/unreadable."""
    if pid <= 0:
        return None
    try:
        if IS_WINDOWS:
            return _win_start(pid)
        if sys.platform.startswith("linux"):
            with open(f"/proc/{pid}/stat", "rb") as f:
                data = f.read().decode("utf-8", "replace")
            # fields after the ")" that closes the command name: state is field 3, starttime (clock ticks since boot) is field 22
            fields = data[data.rindex(")") + 2:].split()
            # a zombie (Z) or dead (X) process is finished: it only lingers until its parent calls wait()
            return None if fields[0] in ("Z", "X") else fields[19]
        out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout.strip()
        return out or None
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def _win_start(pid: int) -> Optional[str]:
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    handle = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not k32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
            return None
        code = wintypes.DWORD()
        if k32.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value != 259:  # STILL_ACTIVE
            return None  # already exited (a handle can outlive the process)
        return str((created.dwHighDateTime << 32) | created.dwLowDateTime)
    finally:
        k32.CloseHandle(handle)


def kill_tree(pid: int) -> None:
    """Kills a process and its whole tree (best-effort)."""
    try:
        if IS_WINDOWS:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            return
        import signal
        try:
            # our POSIX children are session leaders (start_new_session), so their pgid is their pid
            if os.getpgid(pid) == pid:
                os.killpg(pid, signal.SIGKILL)
                return
        except OSError:
            pass
        os.kill(pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        pass  # the process may already be gone


class ProcessReaper:
    """Registry of the children this process spawned, in ``<pids_dir>/<owner pid>`` (JSON)."""

    def __init__(self, pids_dir: str):
        self.dir = pids_dir
        os.makedirs(pids_dir, exist_ok=True)
        self.file = os.path.join(pids_dir, str(os.getpid()))
        self._children: Dict[int, Optional[str]] = {}
        self._owner_start = process_start(os.getpid())
        self._lock = threading.Lock()  # track() runs on the caller's thread, untrack() on the log-pump threads
        atexit.register(self._kill_all)  # last resort if the normal shutdown did not run

    def track(self, pid: Optional[int]) -> None:
        if not pid:
            return
        start = process_start(pid)
        with self._lock:
            self._children[pid] = start
            self._flush()

    def untrack(self, pid: Optional[int]) -> None:
        if not pid:
            return
        with self._lock:
            if self._children.pop(pid, 0) != 0:
                self._flush()

    def dispose(self) -> None:
        try:
            os.remove(self.file)
        except OSError:
            pass

    def _flush(self) -> None:
        try:
            with open(self.file, "w", encoding="utf-8") as f:
                json.dump({"ownerStart": self._owner_start, "children": [{"pid": p, "start": s} for p, s in self._children.items()]}, f)
        except OSError:
            pass

    def _kill_all(self) -> None:
        for pid, start in list(self._children.items()):
            if start is not None and process_start(pid) == start:
                kill_tree(pid)
        self._children.clear()
        self.dispose()

    @staticmethod
    def reap_stale(pids_dir: str) -> List[int]:
        """Kills children recorded by owners that are no longer alive; returns the PIDs killed."""
        killed: List[int] = []
        try:
            names = os.listdir(pids_dir)
        except OSError:
            return killed
        for name in names:
            if not name.isdigit() or int(name) == os.getpid():
                continue
            owner = int(name)
            path = os.path.join(pids_dir, name)
            try:
                with open(path, encoding="utf-8") as f:
                    rec = json.load(f)
            except (OSError, ValueError):
                rec = {}
            owner_now = process_start(owner)
            # alive AND the same process that wrote the file (or an old file without a start time: judge by liveness alone)
            if owner_now is not None and (rec.get("ownerStart") in (None, owner_now)):
                continue
            for child in rec.get("children", []):
                pid, start = child.get("pid"), child.get("start")
                # only a process that still has the START TIME recorded at registration is our orphan; a reused PID is left alone
                if isinstance(pid, int) and start is not None and process_start(pid) == start:
                    kill_tree(pid)
                    killed.append(pid)
            try:
                os.remove(path)
            except OSError:
                pass
        return killed
