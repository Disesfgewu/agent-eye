"""Optional MCP server exposing the Agent Eye tools over the Model Context
Protocol, so any MCP-aware agent can use them. Requires the `mcp` extra:

    pip install "agent-eye[mcp]"
    agent-eye-mcp --workspace .

Ask-tier actions (dev servers, form submits) require the policy category to be
set to "allow" here, since a bare stdio server has no interactive approver by
default; high-risk actions stay denied.
"""
from __future__ import annotations

import json
import os
import sys

from .browser import AgentEye
from .policy import PolicyError


def _arg(name: str):
    argv = sys.argv[1:]
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    for a in argv:
        if a.startswith(name + "="):
            return a[len(name) + 1:]
    return None


def main() -> None:
    try:
        from mcp.server.fastmcp import FastMCP
    except Exception:
        sys.stderr.write(
            "The MCP server requires the 'mcp' extra. Install with: pip install \"agent-eye[mcp]\"\n"
        )
        sys.exit(1)

    workspace = _arg("--workspace") or os.environ.get("AGENT_EYE_WORKSPACE") or os.getcwd()
    auto = os.environ.get("AGENT_EYE_AUTO_APPROVE") == "1"
    eye = AgentEye(
        workspace=workspace,
        on_approve=(lambda *_: True) if auto else None,
        headless=os.environ.get("AGENT_EYE_HEADLESS") == "1",
    )

    mcp = FastMCP("agent-eye")

    def guarded(fn):
        try:
            return fn()
        except PolicyError as e:
            return f"[policy] {e}"
        except Exception as e:  # surface as a tool error string
            return f"[error] {e}"

    @mcp.tool()
    def browser_navigate(url: str) -> str:
        """Open an http(s) URL (allowlisted hosts only) in the browser."""
        return guarded(lambda: json.dumps(eye.navigate(url)))

    @mcp.tool()
    def browser_snapshot() -> str:
        """Return the page's accessibility snapshot (the agent's 'eyes')."""
        return guarded(eye.snapshot)

    @mcp.tool()
    def browser_click(target: str) -> str:
        """Click an element by ref or selector."""
        return guarded(lambda: (eye.click(target), "clicked")[1])

    @mcp.tool()
    def browser_click_at(x: float, y: float) -> str:
        """Click at viewport coordinates (for canvas UIs like Flutter web)."""
        return guarded(lambda: (eye.click_at(x, y), f"clicked ({x},{y})")[1])

    @mcp.tool()
    def browser_type(target: str, text: str, submit: bool = False) -> str:
        """Type text into an input; submit=True presses Enter."""
        return guarded(lambda: (eye.type(target, text, submit), "typed")[1])

    @mcp.tool()
    def browser_get_console_logs(limit: int = 100) -> str:
        """Return recent browser console messages and page errors."""
        return guarded(lambda: json.dumps(eye.get_console_logs(limit)))

    @mcp.tool()
    def browser_get_network_requests(limit: int = 60) -> str:
        """Return recent network requests (sensitive headers redacted)."""
        return guarded(lambda: json.dumps(eye.get_network_requests(limit)))

    @mcp.tool()
    def start_dev_server(id: str, command: str, args: list = [], cwd: str = ".") -> str:
        """Start an allowlisted dev-server command (cwd confined to workspace)."""
        return guarded(lambda: eye.start_dev_server(id, command, args, cwd))

    @mcp.tool()
    def get_dev_server_logs(id: str, limit: int = 200) -> str:
        """Return recent stdout/stderr and status for a dev server."""
        return guarded(lambda: json.dumps(eye.get_dev_server_logs(id, limit)))

    @mcp.tool()
    def stop_dev_server(id: str) -> str:
        """Stop a dev server this tool started."""
        return guarded(lambda: f"stopped {id}" if eye.stop_dev_server(id) else f"no server {id}")

    try:
        mcp.run()
    finally:
        eye.close()


if __name__ == "__main__":
    main()
