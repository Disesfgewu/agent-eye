# Changelog

## 0.1.3

- **Strict per-instance process ownership.** On open, the server discovers the
  exact OS PIDs of the browser it launched (via its unique per-instance profile
  dir) and registers them; logs `Browser opened … ownedPids:[…]`. Untracked on
  close.
- **Open-on-demand / close-when-done.** The browser opens lazily (only when a
  browser tool is first used) and the skill now mandates `browser_close` as soon
  as the task is verified — ephemeral, like a human closing a tab. Reopens
  automatically if needed; idle auto-close is a safety net.

## 0.1.2

- **No zombies / no leaks (`ProcessReaper`).** Records every child PID this
  server spawns and, on startup, reaps any left behind by a server instance that
  died abruptly (SIGKILL/crash) — plus a synchronous kill on `exit`. Orphaned
  browsers from a SIGKILL are cleaned by killing whatever still holds a dead
  instance's profile dir.
- **Update re-points the MCP registration.** Auto-install now runs on every
  activation and re-points `~/.claude.json` at the current extension version's
  server (the previous version-guarded install left it pointing at the old
  version's path after an update).

## 0.1.1

- **Removed the false "another instance owns the browser" block.** No preemptive
  per-workspace lock; each instance uses its own per-pid Playwright profile, so
  multiple instances coexist and never falsely block each other.
- **Programmatic browser-runtime install** (progress notification, no terminal),
  fixing the Windows-PowerShell `&&` failure.
- Bundled server resolves Playwright via `AGENT_EYE_RUNTIME_DIR` (createRequire),
  fixing "Playwright is not installed" after a packaged install (ESM `import()`
  ignores `NODE_PATH`). HiDPI rendering at `deviceScaleFactor: 2`. Agent cursor
  no longer follows the user's real mouse. Local-dev policy defaults.
- CI runs an end-to-end headless browser test on Linux.

## 0.1.0

- Initial MVP: MCP server (Playwright browser control + dev-server management
  with server-side permission enforcement), VS Code extension (auto-installs the
  skill + MCP into agents' global config, activity sidebar, one-click setup),
  a pip-installable Python package, the `agent-eye` Agent Skill, and a
  self-contained `.vsix`.
