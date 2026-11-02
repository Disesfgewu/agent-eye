# Changelog

## Unreleased

- **`browser_perf_summary`** (#39). Reloads the page (or opens an allowlisted URL) with LCP / layout-shift / long-task observers installed before it loads and returns, in about 120-170 tokens, TTFB, FCP, LCP with its element, CLS and TBT rated against web.dev thresholds, request count and size, and the slowest and largest requests; `cpuSlowdown` (chromium) throttles the CPU. It is a single lab run, not Lighthouse: no score, no raw trace, no heap snapshot. Firefox/WebKit report only the metrics their engines expose and mark the rest n/a. Fixed tool-definition cost +162 tokens in the full toolset (3,626 -> 3,788); `core` unchanged. Also refreshed `docs/ECOSYSTEM.md` (it still listed #36-#38 as gaps).
- **`browser_set_storage` and `browser_upload_file`** (#38). Test logged-in apps and file-input forms: set/clear cookies, localStorage and sessionStorage of the current allowlisted page, and attach workspace files to an `<input type=file>`. Write-only and defensive by design: values are never echoed, logged or shown on the timeline (names only); cookie values cannot smuggle attributes; uploads are limited to regular files inside the workspace (symlinks resolved), 10 files / 25 MB each / 100 MB total, with secrets and tooling state refused (`.env*`, keys/certs, `.git/`, `.ssh/`, `.agent-eye/`, ...). Both are `sideEffect` actions. Fixed tool-definition cost +296 tokens in the full toolset; `AGENT_EYE_TOOLSET=core` is unchanged (2,176).

## 0.3.0 - 2026-11-02

**Security release for anyone using `start_dev_server`** (#32: the command allowlist could be used to run arbitrary code through `python -m timeit`, `npm install <pkg>`, `rails runner`, `deno run npm:x`, ...; update recommended). Also: Windows real executables spawned without cmd.exe (#35), snapshot `depth`/`find` (#36), screenshot `ifChanged` (#37), Firefox/WebKit install + browser/device/viewport settings in the extension (#30), real-toolchain CI for .NET/Maven/Gradle/Elixir/Trunk (#33).
- **CI: .NET, Maven (Spring Boot), Gradle, Elixir and Trunk dev servers are now tested against the real toolchains** (#33; `toolchains` workflow, only runs when the guard/detection/dev-server sources change, weekly and on demand). Each starts a tiny project through the MCP server, fetches the served page and checks that its dangerous command shapes are refused. This surfaced one documentation fact: `Ready` means "the port accepts connections", and `trunk serve` listens even when the build failed.
- **Screenshot `ifChanged`** (#37). `browser_screenshot ifChanged:true` captures with animations and the caret frozen and, when the PNG is byte-identical to the previous shot of the same page/scope, answers `Screenshot unchanged since Ns ago ...` (≈29 tokens) instead of resending the image (≈1,366 tokens for 1280x800, −98%). Pages with a live clock/video/animation always count as changed. Fixed tool-definition cost +36 tokens (3,240 -> 3,276 full, 2,086 -> 2,122 core). Not done: downscaling/JPEG — image tokens depend on pixel dimensions, not file format, and resizing needs an image decoder dependency.
- **Snapshot `depth` and `find`** (#36). `depth: N` keeps the first N levels and marks every cut subtree with its node count and `expand: selector=eN`; `find: "text or role"` returns only the matching elements with their ancestor path (`main > form "Payment" > button "Pay now" [ref=e13]`). On a synthetic 300-product page (7,920 tokens as a full snapshot): `depth: 2` 34 tokens, `find` 9 tokens. Fixed tool-definition cost +54 tokens (3,240 -> 3,294 full toolset, 2,086 -> 2,140 `core`).
- **VS Code extension: pick Firefox/WebKit in the installer, new settings** (#30). `Agent Eye: Install Browser Runtime` now asks which browsers to install (Chromium/Firefox/WebKit, the configured one pre-ticked) and the first-run prompt installs the engine you selected. New settings `agentEye.browser`, `agentEye.device`, `agentEye.viewport` are passed to the server (invalid values are explained in a warning instead of failing at launch; `browserChannel` is ignored for non-Chromium engines). Changing them re-registers the server and offers to install a missing engine. Pure logic is unit-tested (6 tests); the VS Code UI itself (quick-pick, prompts) is not covered by automated tests.
- **Windows: real executables are spawned directly, without cmd.exe** (#35). `go`, `cargo`, `dotnet`, `node`, `python`, `php`, ... (anything that resolves to a `.exe`) now receive their arguments untouched, so quotes, `%` and `^` work (JSON values, `%`-containing flags). Only `.cmd`/`.bat` shims (`npm`, `pnpm`, `yarn`, `vite`, ...) still go through cmd.exe with the strict quoting/refusal rules from #27. Node server and Python package; verified with real processes on Windows.
- **Security: framework entry points and package managers can no longer run arbitrary code through the command allowlist** (#32). Verified bypasses before the fix (all were `allowlisted`): `python -m timeit -s "<code>"`, `python -m pip install x`, `python manage.py shell -c`, `rails runner`, `bundle exec ruby -e`, `flask shell`, `php artisan tinker`, `deno run npm:x`, `bun create x`, `npm install <pkg>`, `npm create`, `yarn add`. Now limited to server commands, in both the Node and Python guards, with 100 new shared test cases (280 total).
## 0.2.0 - 2026-11-02

Minor release: new tools (usage ledger, interaction and composite tools, `detect_project`), Go/Rust/.NET/JVM/Elixir dev servers, Firefox/WebKit, a snapshot-refs fix, and several security fixes (including a Windows allowlist bypass, #27). **Upgrade recommended for Windows users.** The extension's browser-runtime installer still installs Chromium only; for Firefox/WebKit run `npx playwright install firefox webkit` yourself.

- **Security (Windows): fixed an allowlist bypass in `start_dev_server` args** (#27). Dev servers on Windows are started through `cmd.exe`, which treated `& | < > ^ ( )` in arguments as operators, so an allowlisted command could run a second, arbitrary one. Args are now quoted, and args cmd.exe cannot be made to take literally (`"`, `%`, `^`) are refused. Node server and Python package; POSIX was never affected. CI now has a `windows-latest` job.
- **Python package brought to security parity** (it had fallen behind the Node server): interpreter guard (`python -c`, `node -e`, `npx evil`, ...), the new Go/Rust/.NET/JVM/Elixir toolchain rules, metadata-host list (`100.100.100.200`, `168.63.129.16`), request-level metadata blocking in Chromium, `detect_project`, `start_dev_server(port=...)` readiness wait, version 0.1.0 -> 0.1.3 (guarded by the version test). **Fixed:** the Python `snapshot()` had no `[ref=eN]` handles (same defect as #12), so ref-based clicks never worked. Python dev servers now run with `PYTHONUNBUFFERED=1` (Node server too) so "listening on ..." lines are captured. The command and detection cases are shared JSON fixtures executed by both the Node and Python test-suites; new CI job `python-tests`. The Python package still lacks the newer interaction/composite tools, compact output and usage ledger; the README lists exactly what.
- **`detect_project` + `start_dev_server` readiness wait.** `detect_project` scans the workspace (read-only, depth 4, no symlinks, manifests only) and returns the exact `start_dev_server` arguments and expected port for JS/TS (package manager from lockfile), Go (air, templ, Wails), Rust (Axum/Actix/Rocket, Trunk/Yew/Leptos, Dioxus, cargo-leptos, Tauri note), .NET (reads `launchSettings.json`), Maven/Gradle (Spring Boot, Quarkus, Micronaut, wrapper discovery), Elixir/Phoenix, Django/Flask/FastAPI, Laravel, Rails/Jekyll, Flutter, Deno and static sites (~56 tokens for a two-project monorepo). `start_dev_server` gains `port`/`waitSeconds`: it returns `Ready: http://localhost:PORT`, the build error if the process exits, or a polite "still building" with the ports found in the logs; a port already held by another process is refused instead of reporting a false "ready". Fixed cost: +194 tokens (full toolset) / +75 (`core`). 45 new tests incl. a shared JSON fixture file and an e2e against real Go/Rust/Python/Node servers (CI).
- **Go, Rust, .NET, JVM and Elixir dev servers** (`go`, `air`, `templ`, `wails`, `cargo`, `trunk`, `dx`, `dotnet`, `mvn`/`mvnw`, `gradle`/`gradlew`, `mix`) are now in the default allowlist, restricted to their dev-loop subcommands. Flags that would run another program, fetch remote code or leave the workspace (`go run -exec`, `cargo --config`, `cargo watch -s`, `dotnet -p:RunCommand`, `mvn -D…jvmArguments`, `gradle -I`, `mix run -e`, …) are refused and fall under `highRisk`. 130 allow/deny test cases (44 normal dev-loop commands, 86 refused shapes).
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
