# Ecosystem: browser tools for AI agents — and where Agent Eye stands

_"n/v" = not verified from the sources below. Last reviewed: 2026-11-02. A weekly workflow ([`ecosystem-watch`](../.github/workflows/ecosystem-watch.yml))
tracks new releases of the projects below in the rolling "Ecosystem watch" issue; update this page when
something material changes. Facts are from each project's README/docs (linked); third-party token numbers
are **blog/vendor claims, not our measurements** and are labelled as such._

## 1. Landscape

| Project | Form | License | Browsers | Best at |
|---|---|---|---|---|
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) (Microsoft) | MCP server | Apache-2.0 | Chrome, Firefox, WebKit, Edge; attach to a running Chrome via extension/CDP | Broadest automation surface (dozens of tools, extra ones behind `--caps` flags) |
| [Playwright CLI](https://github.com/microsoft/playwright-cli) (`@playwright/cli`) | CLI + installable agent *skills* | Apache-2.0 | Chromium, Firefox, WebKit (+ Chrome/Edge channels) | Token efficiency: "does not force page data into the LLM" |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) (Google) | MCP server (+ CLI) | Apache-2.0 | Chrome / Chrome for Testing only | **Debugging**: perf traces, Lighthouse, heap snapshots, source-mapped console, CSS inspection; `--slim` tool set |
| [agent-browser](https://github.com/vercel-labs/agent-browser) (Vercel Labs) | Rust CLI + daemon (+ `mcp` mode) | Apache-2.0 | Chrome (default), Lightpanda, Safari/iOS via WebDriver, attach via CDP | Lowest token cost: `snapshot -i`, `--delta`, `batch`, `--max-output`; auth vault; action policy |
| [Browser Use](https://github.com/browser-use/browser-use) | Python library, CLI (+ skill), MCP | MIT | Local, cloud, or remote over CDP | An LLM *agent loop* per task; largest community; paid cloud browsers |
| [Stagehand](https://github.com/browserbase/stagehand) (Browserbase) | SDK (TS/Python/Go) + hosted MCP | MIT (SDK) | Local Chrome or Browserbase cloud | `act` / `observe` / `extract` primitives; cached actions skip the model |
| **Agent Eye** (this repo) | MCP server + VS Code extension + Agent Skill | Apache-2.0 | Chromium (default; system Chrome/Edge via channel), Firefox, WebKit | **Watch-along** headed browser + server-side permission policy + managed dev servers + token ledger |

Other things worth knowing: the hosted Browserbase MCP server exposes `navigate`/`act`/`observe`/`extract`
(its local `@browserbasehq/mcp` package is archived); [Lightpanda](https://github.com/lightpanda-io/browser)
is a lightweight headless engine that agent-browser can drive.

## 2. How the others save tokens (the techniques we benchmark ourselves against)

| Technique | Who | Agent Eye |
|---|---|---|
| Tool schemas are paid every session; keep them small / optional (`--caps`, `--slim`) | Playwright MCP, DevTools MCP | ✅ `AGENT_EYE_TOOLSET=core` (#16/#17); ledger reports the fixed cost (#11) |
| Don't push page data into context — CLI + files on disk (`filename`, `filePath`) | Playwright CLI/MCP, DevTools MCP | ❌ not yet (outputs are inline; capped) |
| Scope snapshots: depth / subtree / interactive-only | Playwright MCP (`target`,`depth`), agent-browser (`-i -c -d -s`) | ✅ `interactive`, `selector`, `maxChars` (#14); ❌ no `depth` |
| **Delta snapshots** (only what changed) | agent-browser `--delta` | ✅ `delta` (#14) |
| Find instead of dump (`browser_find`, `find role/text`) | Playwright MCP, agent-browser | ❌ (selector-scoped snapshot is the nearest) |
| Network: hide static assets, filter, paginate | Playwright MCP, DevTools MCP | ✅ failed-first, one line per request, filters (#14) |
| Console/network "since last navigation" | DevTools MCP | ✅ per-page-load epochs (#14) |
| Skip unchanged screenshots (`--if-changed`) / omit images (`--image-responses omit`) | agent-browser, Playwright MCP | ❌ (element `selector` crop only) |
| Output caps (`--max-output`) | agent-browser | ✅ snapshot/evaluate caps (#14) |
| Batch many commands in one call | agent-browser `batch`, Playwright `fill_form` | ✅ `browser_batch`, `browser_verify_page` (#17) |
| Replay recorded runs without a model per step | Browser Use, Stagehand (cache) | ❌ (batch scripts are agent-authored, not recorded) |

### Third-party token numbers (unverified — treat as order-of-magnitude)

One 2026 blog's 10-step comparison: Playwright MCP ≈ 114k tokens, Chrome DevTools MCP ≈ 50k, Playwright CLI ≈ 27k,
agent-browser ≈ 7k ([source](https://www.heyuan110.com/posts/ai/2026-01-28-claude-code-browser-automation/)); tool-definition
overhead reported at ~15k (Playwright MCP) and ~18k (DevTools MCP). A separate comparison measured MCP-vs-MCP gaps
of only ~12–14% ([Zenn](https://zenn.dev/tmasuyama1114/articles/web_mcp_recommended?locale=en)). Methodologies differ and
vendors benchmark themselves; the only numbers we trust for decisions are ones from `usage_report` on our own tasks.

### Agent Eye measured (synthetic page: 40 scripts, 60 products, 16 API calls; ledger estimates)

| | before | after |
|---|---|---|
| network dump | 11,089 tokens | 167 |
| repeat snapshot (`delta`) | 1,289 | ~45 |
| health check (`browser_verify_page snapshot:"none"`) vs 4 separate calls | ~1,186 / 4 turns | 124 / 1 turn |
| fixed tool definitions | ~2.2k (15 tools) | ~3.5k (23 tools); ~2.2k with `AGENT_EYE_TOOLSET=core` |

(Not comparable to the third-party table: different tasks, different estimator.)

## 3. Capability gaps vs the field

| Capability | Playwright MCP | DevTools MCP | agent-browser | Agent Eye |
|---|---|---|---|---|
| Click / type / press / hover / select / wait / history / resize | ✅ | ✅ | ✅ | ✅ (#16) |
| Dialogs, popups/tabs | ✅ | ✅ | ✅ | ⚠️ auto-handled & followed; no tab list/switch |
| Firefox / WebKit | ✅ | ❌ | ⚠️ (WebDriver/Safari) | ✅ `AGENT_EYE_BROWSER` (#5) |
| Device emulation | ✅ | ✅ (`emulate`) | n/v | ✅ `AGENT_EYE_DEVICE` / `AGENT_EYE_VIEWPORT` (#5); `browser_resize` at runtime (#16) |
| Attach to the user's running Chrome (CDP / extension) | ✅ | n/v | ✅ | ❌ (by design: dedicated profile; revisit with ownership rules) |
| File upload, drag, multi-field form fill | ✅ | ✅ | ✅ (`upload`, `drag`, `batch`) | ❌ (needs a file-scope policy) |
| Cookies / localStorage / storage state | ✅ (`--caps=storage`) | ❌ | ✅ | ❌ (sensitive; opt-in policy first) |
| Network mocking / routing | ✅ (`--caps=network`) | ❌ | ✅ | ❌ |
| Performance traces, Lighthouse, heap snapshots | trace/video | ✅ | ✅ (`trace`,`profiler`,`a11y`) | ❌ |
| PDF, video/screencast, test-code generation | ✅ (`--caps`, `--codegen`) | screencast | PDF, `record` (codegen n/v) | ❌ |
| **Visible watch-along: cursor, narration banner, input lock** | ❌ | ❌ | dashboard | ✅ (unique) |
| **Server-side permission policy** (allow/ask/deny per action category) | flags (`--allowed-origins`…) | ❌ | ✅ (`--action-policy`, `--confirm-actions`) | ✅ |
| Dev-server lifecycle (start/logs/stop, reaped on exit) | ❌ | ❌ | ❌ | ✅ (unique) |
| Token ledger / usage report | ❌ | ❌ | ❌ | ✅ (#11) |
| Untrusted-content framing; SSRF/metadata guards | partial | – | `--content-boundaries`, domain allowlist | ✅ (#15) |

## 4. Positioning and suggested next steps

Agent Eye is **not** trying to be the broadest automation server — Playwright MCP already is. Its lane is
*safe, watchable frontend debugging loops* (run the dev server, watch the agent work, enforce what it may do,
measure what it costs). Suggested priorities, by value for that lane:

1. **Finish the cheap wins** — `depth`/`find`, `--if-changed` screenshots, write-large-output-to-file.
2. **Debugging depth** — Lighthouse/perf-trace, source-mapped console errors (DevTools MCP's strength); these are the most relevant gaps for a *debugging* tool.
3. **Careful, opt-in capabilities** — file upload and storage access behind explicit policy categories; never default-on.
4. **Re-measure quarterly** with `usage_report` on a fixed set of tasks, and update §2.

## Sources

- [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) · [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli)
- [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) ([tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md))
- [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)
- [browser-use/browser-use](https://github.com/browser-use/browser-use) · [browserbase/stagehand](https://github.com/browserbase/stagehand)
- Comparisons: [Browser Automation in Claude Code: 5 tools compared](https://www.heyuan110.com/posts/ai/2026-01-28-claude-code-browser-automation/), [Playwright vs Chrome DevTools MCP (Zenn)](https://zenn.dev/tmasuyama1114/articles/web_mcp_recommended?locale=en), [Playwright CLI vs MCP (Better Stack)](https://betterstack.com/community/guides/ai/playwright-cli-vs-mcp-browser/)
