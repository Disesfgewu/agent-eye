# Agent Eye (Python)

Give **Python AI agents** eyes and hands in the browser: drive a real browser and
manage dev servers, with the same **server-side permission model** as the Agent
Eye VS Code extension / MCP server. Use it as a programmatic API or as an MCP
server.

## Install

```bash
pip install "git+https://github.com/agent-eye/agent-eye.git#subdirectory=packages/python"
# or, from a clone:
pip install -e packages/python
python -m playwright install chromium   # or pass channel="chrome" to reuse system Chrome
```

## Programmatic API

```python
from agent_eye import AgentEye

# on_approve gates "ask"-tier actions (dev servers, form submits). Return True
# to allow. Without it, ask-tier actions fail safe (denied). High-risk actions
# (evaluate, non-allowlisted commands/domains) are denied by default.
with AgentEye(workspace=".", on_approve=lambda title, detail: True) as eye:
    eye.start_dev_server("web", "npm", ["run", "dev"])
    eye.navigate("http://localhost:3000")     # localhost-only by default
    print(eye.snapshot())                      # accessibility tree ("eyes")
    eye.click_at(640, 400)                     # coordinate click (canvas/Flutter)
    print(eye.get_console_logs())              # find frontend bugs
    for r in eye.get_network_requests():       # verify front↔back↔db integration
        print(r["method"], r["url"], r["status"])
    eye.screenshot(save_path="page.png")
```

Methods: `navigate`, `snapshot`, `click`, `click_at`, `type`, `screenshot`,
`get_console_logs`, `get_network_requests`, `evaluate` (high-risk),
`start_dev_server`, `get_dev_server_logs`, `stop_dev_server`.

Options: `workspace`, `policy`, `on_approve`, `headless`, `channel`
(`"chrome"`/`"msedge"`), `show_cursor`, `slow_mo`.

## As an MCP server

```bash
pip install "agent-eye[mcp]"
agent-eye-mcp --workspace .
```

Exposes the same tools over MCP for any MCP-aware agent.

## Security model (enforced in-process, not by prompt)

- **Action categories × allow/ask/deny** (`.agent-eye/policy.json`): read-only
  observation allowed; page interaction allowed; side effects / dev-server starts
  ask; high risk denied.
- **Navigation scope**: http(s) to allowlisted hosts only (localhost by default);
  `file://`, cloud-metadata and link-local IPs hard-blocked (SSRF defense).
- **Command scope**: argv-only, shell metacharacters rejected, cwd confined to the
  workspace, executables allowlisted.
- **Dedicated browser profile** — never your real one.
- **Redaction**: `Authorization`/`Cookie`/token values stripped from network data.
- **Prompt-injection framing**: page-derived content is wrapped as untrusted data.

## License

MIT
