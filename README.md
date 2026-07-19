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

## Install (packaged .vsix)

```bash
# From the repo:
npm install && npm run build
cd packages/vscode-extension
npx @vscode/vsce package --no-dependencies   # produces agent-eye-0.1.0.vsix
code --install-extension agent-eye-0.1.0.vsix
```

The `.vsix` bundles the MCP server but not Playwright (too large + native). On
first run the extension prompts to install the browser runtime, or run **“Agent
Eye: Install Browser Runtime (Playwright)”** from the Command Palette — it
installs Playwright + Chromium into the extension's global storage, which the
server finds via `NODE_PATH`.

## Getting started (development)

```bash
npm install
npm run build                 # builds both packages (incl. the bundled server)
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

## Works with any frontend

Agent Eye is **framework-agnostic** — it is one universal tool, not a per-framework
template. It operates at two layers that don't care what framework you used:

- The **browser** (Playwright) sees the same DOM, screen, console, and network
  whether the page came from React, Vue, Svelte, Angular, SolidJS, plain
  HTML/CSS/JS, or Flutter web.
- **`start_dev_server`** runs *any* allowlisted command. The only per-framework
  difference is the dev command string — which is data, not code.

So you don't need a different setup per stack. Point the agent at your project and
tell it which command starts the dev server. Common ones (all allowlisted by
default):

| Stack | Typical dev command |
|---|---|
| React / Vite / Vue / Svelte | `npm run dev` · `pnpm dev` · `vite` |
| Next.js / Nuxt / Astro / Remix | `npm run dev` |
| Angular | `ng serve` |
| Plain HTML/CSS/JS | `python -m http.server 5500` · `npx serve` · `npx http-server` |
| **Flutter web** | `flutter run -d web-server --web-port 5500` |
| Django / Flask | `python manage.py runserver` · `flask run` |
| Rails / Jekyll / Hugo | `rails server` · `jekyll serve` · `hugo server` |

> **Flutter / canvas apps**: Flutter web renders to a canvas (CanvasKit), so the
> accessibility snapshot can be sparse. Agent Eye detects this and tells the agent
> to fall back to `browser_screenshot` (see the page) + coordinate clicks, while
> still using console/network logs — the debug loop still works, just vision-first
> instead of snapshot-first. Add any extra dev commands to `commandAllowlist` in
> `.agent-eye/policy.json`.

## Agent Skill: make every agent use it automatically

[`skills/agent-eye/SKILL.md`](skills/agent-eye/SKILL.md) is an Agent Skill that
makes AI agents treat browser verification as **mandatory for all frontend
work**: run the dev server, open the visible window, operate the real UI, read
console/network, fix, re-verify, and demo to the user. The VS Code command
**"Agent Eye: Setup for Claude Code"** installs it into the workspace's
`.claude/skills/agent-eye/` automatically (alongside `.mcp.json`); or copy it
there yourself (project) / to `~/.claude/skills/` (all projects).

## Tools

| Tool | Action category | Purpose |
|---|---|---|
| `browser_navigate(url)` | interact / highRisk | Open an http(s) URL (allowlisted hosts only). |
| `browser_snapshot()` | observe | Accessibility-tree snapshot with `[ref=eN]` handles — the agent's primary "eyes". |
| `browser_click(target)` | interact | Click by ref or Playwright selector. |
| `browser_click_at(x, y)` | interact | Click at viewport coordinates — for canvas UIs (Flutter web, WebGL, games) with no selectable DOM. |
| `browser_type(target, text, submit?)` | interact / sideEffect | Fill an input; `submit` presses Enter (side-effecting). |
| `browser_screenshot(fullPage?)` | observe | PNG saved to the timeline and returned. |
| `browser_get_console_logs(limit?)` | observe | Console messages + uncaught errors. |
| `browser_get_network_requests(limit?)` | observe | Requests with **sensitive headers redacted**. |
| `browser_show_status(message)` | interact | Live narration banner in the window so the watching user can follow the agent's work. |
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
| `AGENT_EYE_SHOW_CURSOR` | `agentEye.showCursor` | Pulsing cursor overlay so you can watch where the agent points/clicks (Playwright doesn't move the real OS pointer). On by default. |
| `AGENT_EYE_SLOWMO` | `agentEye.slowMoMs` | Slow each action by N ms so you can follow along (e.g. 300–800). |
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
