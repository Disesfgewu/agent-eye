"""Windows launch safety for start_dev_server (Issues #27, #35); port of security/win-args.ts.

Real executables (go.exe, node.exe, python.exe, ...) are spawned DIRECTLY, with no shell, so any
argument is fine. Only ``.cmd`` / ``.bat`` shims (npm, pnpm, yarn, vite, ...) must go through
``cmd.exe``, which treats ``& | < > ^ ( )`` as operators. For that path arguments are quoted so those
are literal, and refused outright when they cannot be quoted reliably: an embedded ``"``, ``%``
(environment expansion happens even inside quotes) and ``^``.
"""
from __future__ import annotations

import os
import re
from typing import Mapping, Optional, Tuple


def windows_unsafe_arg(arg: str) -> Optional[str]:
    if re.search(r'["%^]', arg):
        shown = arg if len(arg) <= 40 else arg[:40] + "..."
        return (f'argument "{shown}" contains " % or ^, which cmd.exe would interpret '
                "(this command is a .cmd/.bat shim, so it must go through cmd.exe); rename or drop it")
    return None


def quote_win_arg(arg: str) -> str:
    return f'"{arg}"' if arg == "" or re.search(r"[\s&|<>^()!]", arg) else arg


def windows_launch(command: str, cwd: str, env: Optional[Mapping[str, str]] = None) -> Tuple[str, Optional[str]]:
    """How a command will be started on Windows: ("direct", file) for a real .exe/.com, else ("cmd", None).

    Resolved like cmd.exe does: working directory first, then PATH, each PATHEXT extension in order.
    """
    env = os.environ if env is None else env
    pathext = [e.strip().lower() for e in (env.get("PATHEXT") or ".COM;.EXE;.BAT;.CMD").split(";") if e.strip()]
    has_dir = bool(re.search(r"[\/]", command))
    ext = os.path.splitext(command)[1].lower()
    path_dirs = [d for d in (env.get("PATH") or env.get("Path") or "").split(os.pathsep) if d]
    dirs = [os.path.abspath(cwd)] if has_dir else [os.path.abspath(cwd)] + path_dirs
    exts = [""] if ext and ext in pathext else pathext
    for d in dirs:
        for e in exts:
            f = os.path.abspath(os.path.join(cwd, command + e)) if has_dir else os.path.join(d, command + e)
            if os.path.isfile(f):
                return ("direct", f) if os.path.splitext(f)[1].lower() in (".exe", ".com") else ("cmd", None)
    return ("cmd", None)
