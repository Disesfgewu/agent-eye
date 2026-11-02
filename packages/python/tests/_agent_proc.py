"""Test helper: runs ONE AgentEye in its own process and executes JSON commands from stdin.

Playwright's sync API allows a single instance per thread, and the engine/CDP tests need several differently configured
agents (and a separate "user's browser") at once, so each agent lives in its own process:

    {"call": "navigate", "args": ["http://..."], "kwargs": {}}   ->   {"ok": <result>}  |  {"error": "<message>"}
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from agent_eye import AgentEye  # noqa: E402
from agent_eye.policy import Policy  # noqa: E402


def main() -> None:
    workspace = sys.argv[1]
    eye = AgentEye(workspace=workspace, policy=Policy(), on_approve=lambda *_: True, headless=True)
    out = sys.stdout
    out.write(json.dumps({"ready": True, "pid": os.getpid()}) + "\n")
    out.flush()
    for line in sys.stdin:
        cmd = json.loads(line)
        try:
            if cmd["call"] == "_eval":  # introspection for the tests: evaluate JS in the agent's current page
                result = eye._ensure_page().evaluate(cmd["args"][0])
            elif cmd["call"] == "_attr":
                result = eval(cmd["args"][0], {"eye": eye})  # noqa: S307 - test helper, input is the test's own
            else:
                result = getattr(eye, cmd["call"])(*cmd.get("args", []), **cmd.get("kwargs", {}))
            if isinstance(result, bytes):
                result = f"<{len(result)} bytes>"
            out.write(json.dumps({"ok": result}, default=str) + "\n")
        except BaseException as exc:  # noqa: BLE001
            out.write(json.dumps({"error": f"{type(exc).__name__}: {exc}"}) + "\n")
        out.flush()
    eye.close()


if __name__ == "__main__":
    main()
