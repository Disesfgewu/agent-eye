# Agent Eye

Give AI coding agents **eyes and hands in the browser** — so they can start your
dev servers, drive a visible browser, read console/network/DOM, and debug your
frontend the way you would, while you watch.

Agent Eye is an **MCP server** (the capability) wrapped in a **VS Code extension**
(the convenience + a live activity view). Because the capability is exposed over
the [Model Context Protocol](https://modelcontextprotocol.io), it works with
Claude Code, Cursor, GitHub Copilot agent mode, and any MCP-aware agent — not
just one.

> Status: v0.1 (MVP). The full autonomous loop
> (start dev server → open browser → snapshot → interact → read console → find bug)
> is implemented and verified end-to-end.

---

## Why

Coding agents can write code but usually can't *verify* it in a real browser.
Agent Eye closes that loop, following the design in [`plan.v1.md`](plan.v1.md).
Its defining principle is **server-side permission enforcement**: every action an
agent takes is checked against a policy inside the tool implementation, never by
asking the agent to behave. A prompt-injected agent still cannot exceed what the
user authorized. See [Security model](#security-model).

## Architecture

```
VS Code Extension (packages/vscode-extension)      MCP Server (packages/mcp-server)
  · "Setup for Claude Code" → writes .mcp.json        · Playwright browser control (headed)
  · McpServerDefinitionProvider (Copilot, 0-config)   · Dev-server lifecycle management
  · Activity sidebar (screenshots / logs / steps)     · Permission policy engine (7.1)
                                                       · SSRF / command / redaction guards (7.2/7.6)
                                                       · Artifacts → .agent-artifacts/
        └────────── spawns (stdio) ──────────────────────────┘
```

The extension does **not** call the agent; the agent (Claude Code, etc.) spawns
the MCP server and calls its tools. The extension only makes setup one click and
shows you what's happening.

## Requirements

- Node.js ≥ 20
- A one-time browser download: `npx playwright install chromium`
  (or set `agentEye.browserChannel` to `chrome`/`msedge` to use an installed browser)

## Getting started (development)

```bash
npm install
npm run build                 # builds both packages
npx playwright install chromium
```

### Use with Claude Code / Cursor

1. In VS Code, run **“Agent Eye: Setup for Claude Code (write .mcp.json)”** from the
   Command Palette. This writes a `.mcp.json` pointing at the built server and adds
   the artifact dirs to `.gitignore`.
2. Restart Claude Code (or reload its MCP servers). The `agent-eye` tools appear.
3. Ask your agent to, e.g., *“start the dev server, open it in the browser, and
   check the console for errors.”*
4. Open the **Agent Eye** sidebar (the eye icon) to watch screenshots, logs, and
   approvals in real time.

### Use with VS Code Copilot agent mode

No `.mcp.json` needed — the extension registers the server through VS Code's
`McpServerDefinitionProvider` API automatically. Just build, install the
extension, and the tools are available to Copilot.

## Tools

| Tool | Action category | Purpose |
|---|---|---|
| `browser_navigate(url)` | interact / highRisk | Open an http(s) URL (allowlisted hosts only). |
| `browser_snapshot()` | observe | Accessibility-tree snapshot with `[ref=eN]` handles — the agent's primary "eyes". |
| `browser_click(target)` | interact | Click by ref or Playwright selector. |
| `browser_type(target, text, submit?)` | interact / sideEffect | Fill an input; `submit` presses Enter (side-effecting). |
| `browser_screenshot(fullPage?)` | observe | PNG saved to the timeline and returned. |
| `browser_get_console_logs(limit?)` | observe | Console messages + uncaught errors. |
| `browser_get_network_requests(limit?)` | observe | Requests with **sensitive headers redacted**. |
| `browser_evaluate(expression)` | highRisk | Arbitrary JS — **disabled by default**. |
| `start_dev_server(id, command, args?, cwd?)` | execute / highRisk | Spawn an allowlisted command, cwd confined to the workspace. |
| `get_dev_server_logs(id, limit?)` | observe | stdout/stderr + status. |
| `stop_dev_server(id)` | execute | Terminate an owned process tree. |

## Security model

Enforced **inside the server**, so a manipulated agent can't get past it. Full
detail in [`plan.v1.md` §7](plan.v1.md).

- **Action categories × allow/ask/deny** (`.agent-eye/policy.json`). Defaults:
  read-only observation `allow`; page interaction `allow`; side-effecting actions
  and dev-server starts `ask`; high-risk (`evaluate`, non-allowlisted commands/
  domains) `deny`. A denied action returns a clear *policy boundary* error so the
  agent knows not to retry.
- **Navigation scope**: only http(s) to allowlisted hosts (localhost by default).
  `file://`/`chrome://`, cloud-metadata and link-local IPs are hard-blocked
  regardless of policy (SSRF defense).
- **Command scope**: argv-only spawn (no shell), shell metacharacters rejected,
  cwd confined to the workspace, executables allowlisted.
- **Dedicated browser profile** (`.agent-eye/browser-profile/`) — never your real
  one, so the agent never inherits your logins or saved passwords.
- **Human-in-the-loop**: `ask`-tier actions request approval via MCP elicitation;
  clients without it fail safe (deny).
- **Prompt-injection framing**: all page-derived content is wrapped as untrusted
  data. The real guarantee is the policy, not the framing.
- **Secret hygiene**: `Authorization`/`Cookie`/token-like values redacted from
  network artifacts; `.agent-artifacts/` and `.agent-eye/` are gitignored.
- **Single-instance lock**: the first server owns the browser/dev servers per
  workspace; a second instance reports it cleanly instead of crashing.

### Configuration knobs

| Env var (server) | Setting (extension) | Effect |
|---|---|---|
| `AGENT_EYE_WORKSPACE` | — | Workspace root (defaults to cwd / `--workspace`). |
| `AGENT_EYE_BROWSER_CHANNEL` | `agentEye.browserChannel` | `chrome`/`msedge` to use an installed browser. |
| `AGENT_EYE_HEADLESS=1` | — | Run headless (CI / remote). Headed is the default. |
| `AGENT_EYE_LOG_LEVEL` | `agentEye.logLevel` | `debug`/`info`/`warn`/`error`. |

## Development

```bash
npm run build       # build both packages
npm run typecheck   # type-check both packages
```

Layout:

- `packages/mcp-server` — the MCP server (TypeScript, ESM). Entry: `dist/index.js`.
- `packages/vscode-extension` — the VS Code extension (bundled with esbuild).

## License

MIT
