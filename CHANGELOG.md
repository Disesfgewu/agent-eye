# Changelog

## Unreleased

- **Go, Rust, .NET, JVM and Elixir dev servers** (`go`, `air`, `templ`, `wails`, `cargo`, `trunk`, `dx`, `dotnet`, `mvn`/`mvnw`, `gradle`/`gradlew`, `mix`) are now in the default allowlist, restricted to their dev-loop subcommands. Flags that would run another program, fetch remote code or leave the workspace (`go run -exec`, `cargo --config`, `cargo watch -s`, `dotnet -p:RunCommand`, `mvn -D…jvmArguments`, `gradle -I`, `mix run -e`, …) are refused and fall under `highRisk`. 6 test groups / ~190 allow-deny cases.
- **Firefox & WebKit engines + device emulation**: `AGENT_EYE_BROWSER=chromium|firefox|webkit`, `AGENT_EYE_DEVICE="iPhone 15"`, `AGENT_EYE_VIEWPORT=WxH`. Cloud-metadata blocking is enforced on every engine (request interception on non-Chromium), so switching engine never weakens the SSRF guard. Clear errors for bad values or an engine that isn't installed.
- **Maintenance**: MCP server now reports its real version (was hard-coded `0.1.0`); root/server/extension versions unified and guarded by a test; removed the dead instance-lock plumbing (`ownsGlobals`) and its stale README/SKILL text; SKILL no longer contradicts itself on closing the browser and its frontmatter description is shorter (it is loaded into every conversation).
- **Ecosystem tracking**: `docs/ECOSYSTEM.md` (sourced comparison + support matrix) and a weekly `ecosystem-watch` workflow that keeps one rolling "Ecosystem watch" issue updated with new upstream releases.
- **Scripted composite tools**: `browser_verify_page` (navigate + status + console + failed requests + actionable elements in one call; 124 tokens without the element list) and `browser_batch` (≤20 steps in one call; all steps are permission-checked before any executes). Cuts LLM round-trips for the most common operations. `AGENT_EYE_TOOLSET=core` omits them.
- **More interaction tools** (closing the gap with Playwright MCP / DevTools MCP): `browser_press_key`, `browser_hover`, `browser_select_option`, `browser_wait_for`, `browser_history` (back/forward/reload), `browser_resize`. JS dialogs are now answered and recorded (`[dialog] …`, default: dismiss confirm/prompt); popups / `target=_blank` tabs are followed and captured. All go through the permission gate. Fixed cost ≈ +780 tokens/session; `AGENT_EYE_TOOLSET=core` opts out.
- **Security: no inline-code execution via allowlisted interpreters** (`node -e`, `python -c`, `npx evil-pkg`, `deno eval`, …) and **page-initiated requests to cloud-metadata hosts are blocked** at the browser (`--host-resolver-rules`, cache-friendly). 56 new unit tests + an e2e SSRF check.
- **Token-lean tool output** (measured with the ledger on a 40-script / 60-product page: network dump 11,089 → 167 tokens, repeat snapshot with `delta` ~−98%, `interactive` snapshot ~−50%). Network is one line per request, static assets hidden unless failed, headers opt-in. Console/network now default to the **current page load** (reset on navigation/reload) with `includeHistory` to opt out; duplicates collapse to `×N`. `browser_snapshot` gains `interactive`/`selector`/`delta`/`maxChars` (default cap 12k chars); `browser_screenshot` gains `selector`; `browser_evaluate` output capped; shorter untrusted-data framing; trimmed tool descriptions.
- **Token ledger + `usage_report` tool.** Every tool call's argument/result size is estimated and aggregated per tool; persisted to `.agent-artifacts/usage.json` and `usage-history.jsonl`. Includes the fixed tool-definition overhead. Adds unit tests (`npm test`).

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
