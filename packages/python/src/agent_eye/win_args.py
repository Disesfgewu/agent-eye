"""Windows argument safety for start_dev_server (Issue #27); port of security/win-args.ts.

``.cmd`` shims (npm, vite, ...) can only be started through ``cmd.exe``, which treats ``& | < > ^ ( )``
in the command line as operators. Arguments are quoted so those are literal, and refused outright when
they cannot be quoted reliably: an embedded ``"``, ``%`` (environment expansion happens even inside
quotes) and ``^``.
"""
from __future__ import annotations

import re
from typing import Optional


def windows_unsafe_arg(arg: str) -> Optional[str]:
    if re.search(r'["%^]', arg):
        shown = arg if len(arg) <= 40 else arg[:40] + "..."
        return f'argument "{shown}" contains " % or ^, which cmd.exe would interpret; rename or drop it'
    return None


def quote_win_arg(arg: str) -> str:
    return f'"{arg}"' if arg == "" or re.search(r"[\s&|<>^()!]", arg) else arg
