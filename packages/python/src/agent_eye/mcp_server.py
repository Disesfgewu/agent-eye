"""Optional MCP server exposing the Agent Eye tools over the Model Context
Protocol, so any MCP-aware agent can use them. Requires the `mcp` extra:

    pip install "agent-eye[mcp]"
    agent-eye-mcp --workspace .

Ask-tier actions (dev servers, form submits) require the policy category to be
set to "allow" here, since a bare stdio server has no interactive approver by
default; high-risk actions stay denied.
"""
from __future__ import annotations

import concurrent.futures
import functools
import json
import os
import sys

from .browser import AgentEye
from .policy import PolicyError
from .usage import UsageLedger, estimate_tool_definition_tokens, measured


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
        from mcp.server.mcpserver import MCPServer as FastMCP  # mcp >= 2 renamed FastMCP to MCPServer
    except ImportError:
        try:
            from mcp.server.fastmcp import FastMCP  # mcp 1.x
        except ImportError as exc:
            # Say what actually failed: "install the extra" is wrong when it IS installed but too new/old/broken.
            sys.stderr.write(
                "The MCP server requires the 'mcp' package (pip install \"agent-eye[mcp]\"; mcp 1.x and 2.x are supported).\n"
                f"Import failed: {exc}\n"
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

    # Token ledger (Issue #1): every tool declared below is measured; usage_report reads it back.
    ledger = UsageLedger(os.path.join(os.path.abspath(workspace), ".agent-artifacts"))
    _declare = mcp.tool

    # Playwright's sync API is thread-affine and refuses to run inside an asyncio loop. mcp 1.x calls sync tools
    # on the event loop, mcp 2.x on arbitrary worker threads: neither is safe. Run EVERY tool (and the final
    # close) on one dedicated thread so the browser always lives and dies on the same thread.
    worker = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="agent-eye")

    def on_worker(fn):
        @functools.wraps(fn)
        def run(*args, **kwargs):
            return worker.submit(fn, *args, **kwargs).result()
        return run

    def _measured_tool(*a, **kw):
        decorate = _declare(*a, **kw)
        return lambda fn: decorate(measured(ledger, fn.__name__, on_worker(fn)))

    mcp.tool = _measured_tool

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
    def browser_snapshot(interactive: bool = False, selector: str = "", delta: bool = False,
                         depth: int = 0, find: str = "", max_chars: int = 12000) -> str:
        """Accessibility snapshot with [ref=eN] handles. Large pages: find (matching elements + ancestor path),
        depth (first N levels), interactive (actionable only), selector (one subtree), delta (changes only)."""
        return guarded(lambda: eye.snapshot(interactive, selector or None, delta, depth or None, find or None, max_chars))

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
    def browser_get_console_logs(types: list = [], limit: int = 50, include_history: bool = False) -> str:
        """Console messages and uncaught errors of the CURRENT page load (reset on navigation/reload), duplicates
        collapsed (xN). types: error, warning, log, info, debug, dialog, popup."""
        return guarded(lambda: eye.console(types or None, limit, include_history))

    @mcp.tool()
    def browser_get_network_requests(failed_only: bool = False, url_contains: str = "", include_static: bool = False,
                                     limit: int = 100, include_history: bool = False) -> str:
        """One line per request of the CURRENT page load (static assets hidden unless failed). Start with failed_only."""
        return guarded(lambda: eye.network(failed_only, url_contains or None, include_static, limit, include_history))

    @mcp.tool()
    def browser_verify_page(url: str = "", wait_for_text: str = "", snapshot: str = "interactive", settle_ms: int = 500) -> str:
        """One call: optionally navigate, wait for load, then report document status, console errors/warnings,
        failed requests and the actionable elements. Use instead of navigate + snapshot + console + network."""
        return guarded(lambda: eye.verify_page(url or None, wait_for_text or None, snapshot, settle_ms))

    @mcp.tool()
    def browser_batch(steps: list, report: str = "health") -> str:
        """Run up to 20 steps in ONE call and get per-step status plus a page-health summary. Steps are dicts:
        navigate{url} click/hover{target} type{target,text,submit?} press{key} select{target,values} wait{text?|ms?,timeoutMs?}.
        Every step is permission-checked before any runs; stops at the first failure."""
        return guarded(lambda: eye.batch(steps, report))

    @mcp.tool()
    def browser_press_key(key: str) -> str:
        """Press a key or combo (e.g. Enter, Escape, Tab, Control+A). Enter may submit a form."""
        return guarded(lambda: (eye.press_key(key), f"pressed {key}")[1])

    @mcp.tool()
    def browser_hover(target: str) -> str:
        """Hover an element by ref or selector (menus, tooltips)."""
        return guarded(lambda: (eye.hover(target), f"hovered {target}")[1])

    @mcp.tool()
    def browser_select_option(target: str, values: list) -> str:
        """Choose option(s) in a <select> by value or label."""
        return guarded(lambda: json.dumps(eye.select_option(target, values)))

    @mcp.tool()
    def browser_wait_for(text: str = "", text_gone: str = "", ms: int = 0, timeout_ms: int = 10000) -> str:
        """Wait until text appears or disappears, and/or pause briefly (max 10s). Prefer this over re-polling snapshots."""
        return guarded(lambda: (eye.wait_for(text or None, text_gone or None, ms, timeout_ms), "done waiting")[1])

    @mcp.tool()
    def browser_history(action: str) -> str:
        """back, forward or reload (reload to re-verify after a code change)."""
        return guarded(lambda: json.dumps(eye.history(action)))

    @mcp.tool()
    def browser_resize(width: int, height: int) -> str:
        """Resize the viewport (responsive / mobile layout checks)."""
        return guarded(lambda: (eye.resize(width, height), f"resized to {width}x{height}")[1])

    @mcp.tool()
    def detect_project(path: str = "") -> str:
        """List runnable projects (JS, Go, Rust, .NET, JVM, Elixir, Python, PHP, Ruby, Flutter, static) with exact
        start_dev_server args + port. Read-only; call first on an unfamiliar repo."""
        return guarded(lambda: eye.detect_project(path or None))

    @mcp.tool()
    def start_dev_server(id: str, command: str, args: list = [], cwd: str = ".", port: int = 0, wait_seconds: int = 0) -> str:
        """Start an allowlisted dev-server command (cwd confined to workspace). With port, wait until it listens
        or exits (build errors are returned); else return at once and poll get_dev_server_logs."""
        return guarded(lambda: eye.start_dev_server(id, command, args, cwd, port or None, wait_seconds or None))

    @mcp.tool()
    def get_dev_server_logs(id: str, limit: int = 200) -> str:
        """Return recent stdout/stderr and status for a dev server."""
        return guarded(lambda: json.dumps(eye.get_dev_server_logs(id, limit)))

    @mcp.tool()
    def stop_dev_server(id: str) -> str:
        """Stop a dev server this tool started."""
        return guarded(lambda: f"stopped {id}" if eye.stop_dev_server(id) else f"no server {id}")

    @mcp.tool()
    def usage_report() -> str:
        """Estimated token cost of Agent Eye tool calls this session (per tool). Read-only; call when asked how much a task cost."""
        return guarded(lambda: (eye.gate.check("observe", "Read token usage"), ledger.report())[1])

    try:
        import asyncio
        tools = asyncio.run(mcp.list_tools())
        ledger.set_tool_definition_overhead(
            sum(estimate_tool_definition_tokens(t.name, t.description or "", t.inputSchema) for t in tools), len(tools)
        )
    except Exception:
        pass  # measurement only

    try:
        mcp.run()
    finally:
        try:
            worker.submit(eye.close).result(timeout=30)
        finally:
            worker.shutdown(wait=False)
            ledger.flush()


if __name__ == "__main__":
    main()
