# Agent Eye (Python)

Give **Python AI agents** eyes and hands in the browser: drive a real browser and
manage dev servers, with the same **server-side permission model** as the Agent
Eye VS Code extension / MCP server. Use it as a programmatic API or as an MCP
server.

## Install

```bash
pip install "git+https://github.com/Disesfgewu/agent-eye.git#subdirectory=packages/python"
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

Methods: `navigate`, `snapshot(interactive, selector, delta, depth, find, max_chars)`, `click`, `click_at`,
`type`, `press_key`, `hover`, `select_option`, `wait_for`, `history`, `resize`, `screenshot` / `screenshot_if_changed`,
`set_storage`, `upload_file`, `perf_summary`,
`console(types, limit, include_history)` and `network(failed_only, url_contains, include_static, ...)`
(compact, current page load only), raw `get_console_logs` / `get_network_requests`, `evaluate` (high-risk),
`verify_page`, `batch`, `detect_project`, `start_dev_server`, `get_dev_server_logs`, `stop_dev_server`.

### Any stack, not just JavaScript

```python
print(eye.detect_project())
# 1. Go · Gin @ server: start_dev_server id="server" command="go" args=["run","."] cwd="server" port=8080 (typical)
# 2. Vite @ web: start_dev_server id="web" command="npm" args=["run","dev"] cwd="web" port=5173 (typical)

# With `port`, start_dev_server waits (loopback only, max 55 s per call) until the server listens;
# if the process dies first (e.g. a Go/Rust compile error) it raises RuntimeError with the last output.
print(eye.start_dev_server("server", "go", ["run", "."], cwd="server", port=8080))
```

Detects JS/TS, Go, Rust (Axum/Actix/Rocket, Trunk/Yew/Leptos, Dioxus), .NET, Maven/Gradle
(Spring Boot, Quarkus), Elixir/Phoenix, Django/Flask/FastAPI, Laravel, Rails/Jekyll, Flutter,
Deno and static sites. `go`, `cargo`, `trunk`, `dx`, `air`, `templ`, `wails`, `dotnet`,
`mvn`/`mvnw`, `gradle`/`gradlew` and `mix` are allowlisted for their **dev loop only**
(`go run`, `cargo run|watch`, `dotnet run|watch`, `mvn spring-boot:run`, ...): flags that run
another program or leave the workspace (`go run -exec`, `cargo --config`, `dotnet -p:...`,
`mvn -D...jvmArguments`, `mix run -e`, ...) are refused, as are inline-code interpreters
(`python -c`, `node -e`, `npx evil-pkg`).

Options: `workspace`, `policy`, `on_approve`, `headless`, `channel`
(`"chrome"`/`"msedge"`), `show_cursor`, `slow_mo`.

## As an MCP server

```bash
pip install "agent-eye[mcp]"
agent-eye-mcp --workspace .
```

The MCP server needs **Python 3.10+** (every `mcp` release does); the Python API itself supports 3.9.

Exposes the same tools over MCP for any MCP-aware agent (`mcp` 1.x and 2.x are both supported; all tools run on one
dedicated thread because Playwright's sync API is thread-affine). `usage_report` shows the estimated token cost per tool.

## Parity with the Node MCP server

The Python package is a smaller port. The **security guards and project detection are kept in
lock-step** with the Node server: both implementations run the same fixture files
(`packages/mcp-server/tests/fixtures/command-cases.json`, `detect-cases.json`) in CI, so a rule
fixed on one side and missing on the other fails the build.

| | Python | Node server |
|---|---|---|
| URL / command / interpreter / toolchain guards, redaction, policy | yes | yes |
| `detect_project`, `start_dev_server(port=...)` readiness wait | yes | yes |
| Snapshot with `[ref=eN]` handles, metadata-host request blocking (Chromium) | yes | yes |
| press / hover / select / wait_for / history (post-checked against the allowlist) / resize, dialogs and popups | yes | yes |
| Compact output: snapshot `interactive`/`selector`/`delta`/`depth`/`find`/cap, one-line network, console/network scoped to the current page load | yes (golden-tested against the Node formatters) | yes |
| `verify_page`, `batch` (all steps approved before any runs) | yes | yes |
| Token usage ledger + `usage_report` (estimator golden-tested against the Node one) | yes (MCP server) | yes |
| `set_storage` / `upload_file` (write-only, workspace-confined, secrets refused), `perf_summary`, screenshot `selector` / `if_changed` | yes (guards and formatters golden-tested against the Node ones) | yes |
| Firefox / WebKit / device emulation, CDP attach | **no** | yes |

## Tests

```bash
cd packages/python
PYTHONPATH=src python -m unittest discover -s tests     # stdlib only; the browser smoke test needs playwright
```

## Security model (enforced in-process, not by prompt)

- **Action categories × allow/ask/deny** (`.agent-eye/policy.json`): read-only
  observation allowed; page interaction allowed; side effects / dev-server starts
  ask; high risk denied.
- **Navigation scope**: http(s) to allowlisted hosts only (localhost by default);
  `file://`, cloud-metadata and link-local IPs hard-blocked (SSRF defense).
- **Command scope**: argv-only, shell metacharacters rejected, cwd confined to the
  workspace, executables allowlisted. An allowlisted interpreter or build tool does not
  allow inline/remote code or program-running flags (see above). Compiling or running a
  project still executes project-owned code (`build.rs`, `package.json` scripts, ...):
  set `execute` to `ask` for untrusted repositories.
- **Request-level SSRF guard**: page-initiated requests to cloud-metadata hosts cannot
  resolve (Chromium `--host-resolver-rules`).
- **Dedicated browser profile** — never your real one.
- **Redaction**: `Authorization`/`Cookie`/token values stripped from network data.
- **Prompt-injection framing**: page-derived content is wrapped as untrusted data.

## License

Apache-2.0
