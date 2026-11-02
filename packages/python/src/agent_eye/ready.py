"""Readiness helpers for start_dev_server (port of devserver/ready.ts).

Compiled stacks (Go, Rust, .NET, JVM) take seconds to minutes to build; polling
logs costs one LLM turn per poll and a compile error looks like "still building".
Waiting for the port - or for the process to die - removes both problems.

Probing is loopback-only (127.0.0.1 / ::1) by construction, so it cannot be turned
into a port scanner for other hosts.
"""
from __future__ import annotations

import re
import socket
import time
from typing import Callable, Iterable, List, Optional, Tuple

# "http://127.0.0.1:8080", "localhost:3000", "[::]:4000"
_LOOPBACK_PORT = re.compile(r"(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b")
# "Listening and serving HTTP on :8080", "listening on :3000"
_LISTEN_PORT = re.compile(r"\b(?:listening|serving|running|started|bound|binding)\b[^\n]{0,40}?\s:(\d{2,5})\b", re.IGNORECASE)
# "Server running on port 3000", "port: 8080"
_PORT_WORD = re.compile(r"\bport\s*(?:is|=|:)?\s*(\d{2,5})\b", re.IGNORECASE)


def extract_ports(lines: Iterable[str], max_ports: int = 5) -> List[int]:
    """Distinct plausible listening ports mentioned in log lines, in first-seen order."""
    seen: List[int] = []
    for line in lines:
        for rx in (_LOOPBACK_PORT, _LISTEN_PORT, _PORT_WORD):
            for m in rx.finditer(line):
                port = int(m.group(1))
                if 80 <= port <= 65535 and port not in seen:
                    seen.append(port)
    return seen[:max_ports]


def try_connect(port: int, host: str, timeout: float = 0.3) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def port_open(port: int) -> bool:
    return try_connect(port, "127.0.0.1") or try_connect(port, "::1")


def wait_for_port(
    port: int,
    timeout_s: float,
    is_alive: Callable[[], bool],
    interval_s: float = 0.25,
    probe: Optional[Callable[[int], bool]] = None,
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Tuple[str, float]:
    """Returns ("ready" | "exited" | "timeout", elapsed_seconds)."""
    probe = probe or port_open
    start = now()
    while True:
        alive = is_alive()
        # Probe even after exit once: a launcher may hand the server to a daemon and return.
        if probe(port):
            return "ready", now() - start
        if not alive:
            return "exited", now() - start
        if now() - start >= timeout_s:
            return "timeout", now() - start
        sleep(interval_s)
