// End-to-end browser smoke test. Serves a tiny page, spawns the BUILT MCP
// server headless, and drives navigate → snapshot → screenshot, asserting each.
// Cross-platform (used by CI on Ubuntu to verify the Linux browser path, and
// runnable locally on Windows/macOS). Requires Chromium:
//   npx playwright install --with-deps chromium
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const textOf = (r) => (r.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/missing")) { res.statusCode = 404; return res.end("nf"); }
  if (req.url.startsWith("/popup")) { res.setHeader("content-type", "text/html"); return res.end("<!doctype html><h1>popup-page</h1>"); }
  if (req.url.startsWith("/actions")) {
    res.setHeader("content-type", "text/html");
    return res.end(`<!doctype html><title>actions</title>
<select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select>
<input id="i" aria-label="field" onkeydown="document.getElementById('out').textContent='key:'+event.key">
<button id="h" onmouseover="document.getElementById('out').textContent='hovered'">hover me</button>
<button id="d" onclick="document.getElementById('out').textContent = confirm('Delete?') ? 'deleted' : 'kept'">del</button>
<a id="p" href="/popup" target="_blank">open popup</a>
<p id="out"></p>
<script>setTimeout(()=>{const e=document.createElement('p');e.textContent='late-text';document.body.appendChild(e)},600)</script>`);
  }
  if (req.url.startsWith("/slow.js")) { return setTimeout(() => { res.setHeader("content-type", "application/javascript"); res.end("window.__slow = 1;"); }, 400); }
  if (req.url.startsWith("/big.js")) { res.setHeader("content-type", "application/javascript"); return res.end("/*" + "x".repeat(300 * 1024) + "*/"); }
  if (req.url.startsWith("/perf")) {
    res.setHeader("content-type", "text/html");
    return res.end(`<!doctype html><title>perf</title><h1 id="hero">perf page</h1><script src="/slow.js"></script><script src="/big.js" async></script>
<script>const t=Date.now();while(Date.now()-t<250){}
setTimeout(()=>{const d=document.createElement('div');d.style.cssText='height:200px;background:#eee';document.body.insertBefore(d,document.getElementById('hero'));},300);</script>`);
  }
  if (req.url.startsWith("/state")) {
    res.setHeader("content-type", "text/html");
    return res.end(`<!doctype html><title>state</title><pre id="out"></pre><script>document.getElementById('out').textContent='cookie='+document.cookie+' ls='+(localStorage.getItem('tok')||'none')+' ss='+(sessionStorage.getItem('s')||'none');</script>`);
  }
  if (req.url.startsWith("/upload")) {
    res.setHeader("content-type", "text/html");
    return res.end(`<!doctype html><title>upload</title><input type="file" id="f" aria-label="file"><p id="o">nothing</p><script>f.onchange=()=>{o.textContent=Array.from(f.files).map(x=>x.name+':'+x.size).join(',')}</script>`);
  }
  if (req.url.startsWith("/imds")) { res.setHeader("content-type", "text/html"); return res.end('<!doctype html><script>fetch("http://169.254.169.254/latest/meta-data/",{mode:"no-cors"}).catch(()=>{});</script>ssrf probe'); }
  res.setHeader("content-type", "text/html");
  res.end('<!doctype html><h1 id="t">agent-eye e2e ok</h1><button id="b">go</button><script>console.error("e2e-boom");fetch("/missing");</script>');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ae-e2e-"));

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--workspace", ws],
  env: { ...process.env, AGENT_EYE_HEADLESS: "1", AGENT_EYE_LOG_LEVEL: "warn" },
});
const c = new Client({ name: "e2e", version: "0" }, {});
await c.connect(transport);

let ok = true;
const check = (name, cond, detail = "") => {
  if (!cond) ok = false;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond && detail) console.log("      " + String(detail).split("\n").join("\n      ").slice(0, 1500));
};

const tools = (await c.listTools()).tools;
check(`tools listed (${tools.length})`, tools.length >= 13);

const nav = await c.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${port}` } });
check("browser_navigate", !nav.isError);

const snap = await c.callTool({ name: "browser_snapshot", arguments: {} });
check("snapshot shows page content", /agent-eye e2e ok/.test(textOf(snap)));
const refMatch = /button "go" \[ref=(e\d+)\]/.exec(textOf(snap));
check("snapshot emits [ref=eN] handles", !!refMatch);
const clickRes = await c.callTool({ name: "browser_click", arguments: { target: refMatch ? refMatch[1] : "e0" } });
check("browser_click works with a snapshot ref", !clickRes.isError);
const found = textOf(await c.callTool({ name: "browser_snapshot", arguments: { find: "go" } }));
check("snapshot find= returns the matching element with its ref", /button "go" (\[active\] )?\[ref=e\d+\]/.test(found) && !/agent-eye e2e ok/.test(found));
const shallow = textOf(await c.callTool({ name: "browser_snapshot", arguments: { depth: 1 } }));
check("snapshot depth=1 cuts children and says how to expand them", /…\(\+\d+ nodes, expand: selector=e\d+\)/.test(shallow) && !/agent-eye e2e ok/.test(shallow));

const shot = await c.callTool({ name: "browser_screenshot", arguments: {} });
check("screenshot returns an image", (shot.content || []).some((x) => x.type === "image"));

const bad = await c.callTool({ name: "browser_navigate", arguments: { url: "file:///etc/passwd" } });
check("file:// navigation blocked by policy", /blocked/i.test(textOf(bad)));

await new Promise((r) => setTimeout(r, 300));
const cons1 = textOf(await c.callTool({ name: "browser_get_console_logs", arguments: { types: ["error"] } }));
check("console shows the page error", /\[error\] e2e-boom/.test(cons1));
const net1 = textOf(await c.callTool({ name: "browser_get_network_requests", arguments: { failedOnly: true } }));
check("network (compact) shows the failed request", /GET 404 fetch \/missing/.test(net1) && !/requestHeaders/.test(net1));
const interactive = textOf(await c.callTool({ name: "browser_snapshot", arguments: { interactive: true } }));
check("interactive snapshot lists the button with a ref", /button "go".*\[ref=e\d+\]/.test(interactive));
const delta1 = textOf(await c.callTool({ name: "browser_snapshot", arguments: { delta: true } }));
const delta2 = textOf(await c.callTool({ name: "browser_snapshot", arguments: { delta: true } }));
check("delta snapshot reports no changes the second time", delta1.includes("e2e ok") && /no changes since last snapshot/.test(delta2));
// Reload: old errors must not leak into the new page load unless asked for.
await c.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${port}/?v=2` } });
await new Promise((r) => setTimeout(r, 300));
const cons2 = textOf(await c.callTool({ name: "browser_get_console_logs", arguments: { types: ["error"] } }));
check("console is scoped to the current page load (no x2)", /\[error\] e2e-boom/.test(cons2) && !/×2/.test(cons2));
const cons3 = textOf(await c.callTool({ name: "browser_get_console_logs", arguments: { types: ["error"], includeHistory: true } }));
// Chromium collapses the repeat to "×2"; Firefox includes the page URL in the location so it lists two lines.
check("includeHistory returns earlier loads too", (cons3.match(/e2e-boom/g) || []).length >= 2 || /×2/.test(cons3));
// SSRF: a page on an allowlisted host must not be able to reach cloud-metadata addresses.
await c.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${port}/imds` } });
await new Promise((r) => setTimeout(r, 500));
const ssrf = textOf(await c.callTool({ name: "browser_get_network_requests", arguments: { failedOnly: true } }));
const engine = process.env.AGENT_EYE_BROWSER || "chromium";
// Chromium blocks at the resolver (ERR_NAME_NOT_RESOLVED); Firefox/WebKit via request interception (engine-specific error text).
check(`page-initiated request to 169.254.169.254 is blocked (${engine})`, /169\.254\.169\.254/.test(ssrf) && (engine !== "chromium" || /ERR_NAME_NOT_RESOLVED/.test(ssrf)));

// ---- interaction tools (Issue #4) ----
const A = `http://127.0.0.1:${port}/actions`;
const call = async (name, args = {}) => c.callTool({ name, arguments: args });
await call("browser_navigate", { url: A });
check("wait_for text that appears later", !(await call("browser_wait_for", { text: "late-text" })).isError);
check("wait_for times out with an error when the text never appears", (await call("browser_wait_for", { text: "never-there", timeoutMs: 300 })).isError === true);
check("select_option picks Beta", !(await call("browser_select_option", { target: "#s", values: ["Beta"] })).isError
  && /option "Beta" \[selected\]/.test(textOf(await call("browser_snapshot"))));
await call("browser_hover", { target: "#h" });
check("hover fires mouseover", !(await call("browser_wait_for", { text: "hovered", timeoutMs: 2000 })).isError);
await call("browser_click", { target: "#i" });
await call("browser_press_key", { key: "Escape" });
check("press_key delivers the key", !(await call("browser_wait_for", { text: "key:Escape", timeoutMs: 2000 })).isError);
const hasImage = (r) => (r.content || []).some((x) => x.type === "image");
const shot1 = await call("browser_screenshot", { ifChanged: true });
const shot2 = await call("browser_screenshot", { ifChanged: true });
check("screenshot ifChanged: first shot returns the image", hasImage(shot1));
const imgOf = (r) => Buffer.from((r.content || []).find((x) => x.type === "image")?.data ?? "", "base64");
const [b1, b2] = [imgOf(shot1), imgOf(shot2)];
const differing = b1.length === b2.length ? [...b1].filter((v, i) => v !== b2[i]).length : -1;
check("screenshot ifChanged: identical page -> one line, no image", !hasImage(shot2) && /unchanged/i.test(textOf(shot2)),
  `${textOf(shot2)} | two captures of a static page: ${b1.length} vs ${b2.length} bytes, ${differing < 0 ? "different sizes" : `${differing} differing bytes`}`);
await call("browser_type", { target: "#i", text: "changed-input" });
check("screenshot ifChanged: after a visible change the image is returned again", hasImage(await call("browser_screenshot", { ifChanged: true })));
check("screenshot without ifChanged always returns the image", hasImage(await call("browser_screenshot", {})));
await call("browser_click", { target: "#d" });
check("confirm() is dismissed (not auto-confirmed) and recorded", !(await call("browser_wait_for", { text: "kept", timeoutMs: 2000 })).isError
  && /\[dialog\] confirm: "Delete\?" -> dismissed/.test(textOf(await call("browser_get_console_logs", { types: ["dialog"] }))));
const resized = await call("browser_resize", { width: 800, height: 600 });
check("resize works", !resized.isError && /800x600/.test(textOf(resized)));
const back = await call("browser_history", { action: "back" });
check("history back works and stays in scope", !back.isError && /back: http:\/\/127\.0\.0\.1/.test(textOf(back)));
const fwd = await call("browser_history", { action: "forward" });
check("history forward returns to the page", !fwd.isError && /\/actions/.test(textOf(fwd)));
await call("browser_click", { target: "#p" });
await new Promise((r) => setTimeout(r, 800));
check("popup (target=_blank) is followed and visible to the agent", /popup-page/.test(textOf(await call("browser_snapshot")))
  && /\[popup\] opened/.test(textOf(await call("browser_get_console_logs", { types: ["popup"], includeHistory: true }))));
// ---- composite tools (Issue #3) ----
const vp = await call("browser_verify_page", { url: `http://127.0.0.1:${port}/` });
const vpt = textOf(vp);
check("verify_page: one call reports status, console error, failed request, actionable elements",
  !vp.isError && /Document: 200/.test(vpt) && /Console: [1-9]d* error/.test(vpt) && /e2e-boom/.test(vpt) && /GET 404 fetch \/missing/.test(vpt) && /button "go"/.test(vpt));
check("verify_page respects the navigation scope", (await call("browser_verify_page", { url: "file:///etc/passwd" })).isError === true);

const batch = await call("browser_batch", { steps: [
  { action: "navigate", url: A },
  { action: "select", target: "#s", values: ["Beta"] },
  { action: "hover", target: "#h" },
  { action: "wait", text: "hovered", timeoutMs: 2000 },
] });
const bt = textOf(batch);
check("batch runs a whole flow in one call and appends a health summary",
  !batch.isError && /1\. navigate ✓/.test(bt) && /4\. wait ✓/.test(bt) && /Console: \d+ error/.test(bt));
const failing = await call("browser_batch", { report: "none", steps: [
  { action: "wait", text: "never-there", timeoutMs: 300 },
  { action: "hover", target: "#h" },
] });
check("batch stops at the first failure and marks the rest skipped", failing.isError === true && /1\. wait ✗/.test(textOf(failing)) && /2\. hover – skipped/.test(textOf(failing)));
await call("browser_navigate", { url: A });
const denied = await call("browser_batch", { report: "none", steps: [
  { action: "select", target: "#s", values: ["Beta"] },
  { action: "navigate", url: "https://example.com/" },
] });
const afterDenied = textOf(await call("browser_snapshot"));
check("batch checks every step first: a denied step means NOTHING ran", denied.isError === true && /Nothing was executed/.test(textOf(denied)) && !/option "Beta" \[selected\]/.test(afterDenied));
check("batch rejects malformed steps without running anything", (await call("browser_batch", { steps: [{ action: "click" }] })).isError === true);
const usage = await c.callTool({ name: "usage_report", arguments: {} });
check("usage_report counts the calls made", /browser_snapshot \| [1-9]\d* \|/.test(textOf(usage)) && /Calls: \d+/.test(textOf(usage)));

// ---- state tools (Issue #38) ----
await call("browser_navigate", { url: `http://127.0.0.1:${port}/state` });
const setRes = await call("browser_set_storage", { cookies: [{ name: "sid", value: "abc123" }], localStorage: { tok: "xyz789" }, sessionStorage: { s: "sess456" } });
check("set_storage reports names, never values", !setRes.isError && /cookie:sid/.test(textOf(setRes)) && !/abc123|xyz789|sess456/.test(textOf(setRes)), textOf(setRes));
await call("browser_history", { action: "reload" });
const seen = textOf(await call("browser_snapshot"));
check("cookie, localStorage and sessionStorage are visible to the page after reload", /sid=abc123/.test(seen) && /ls=xyz789/.test(seen) && /ss=sess456/.test(seen), seen);
const events = fs.readFileSync(path.join(ws, ".agent-artifacts", "events.jsonl"), "utf8");
check("values never reach the activity timeline (names do)", /cookie:sid/.test(events) && !/abc123|xyz789|sess456/.test(events));
const pathed = await call("browser_set_storage", { cookies: [{ name: "scoped", value: "yes", path: "/state" }, { name: "elsewhere", value: "no", path: "/other" }] });
check("cookies with a path are accepted (Playwright rejects url+path, so domain+path is used)", !pathed.isError, textOf(pathed));
await call("browser_history", { action: "reload" });
const scoped = textOf(await call("browser_snapshot"));
check("a cookie's path scoping is honoured: /state sees `scoped`, not `elsewhere`", /scoped=yes/.test(scoped) && !/elsewhere=no/.test(scoped), scoped);
check("a cookie value that smuggles attributes is refused", (await call("browser_set_storage", { cookies: [{ name: "a", value: "v; Domain=evil.com" }] })).isError === true);
await call("browser_set_storage", { clear: true });
await call("browser_history", { action: "reload" });
check("clear removes cookies and storage of this host", /cookie= ls=none ss=none/.test(textOf(await call("browser_snapshot"))));

fs.writeFileSync(path.join(ws, "hello.txt"), "hello");
fs.writeFileSync(path.join(ws, ".env"), "SECRET=1");
await call("browser_navigate", { url: `http://127.0.0.1:${port}/upload` });
const up = await call("browser_upload_file", { target: "#f", paths: ["hello.txt"] });
check("upload_file attaches a workspace file", !up.isError && /hello\.txt/.test(textOf(up)), textOf(up));
check("the page received the file (name and size)", /hello\.txt:5/.test(textOf(await call("browser_snapshot"))));
check("upload refuses a secret file inside the workspace", (await call("browser_upload_file", { target: "#f", paths: [".env"] })).isError === true);
check("upload refuses a path outside the workspace", (await call("browser_upload_file", { target: "#f", paths: ["../../../../etc/hosts"] })).isError === true);

// ---- performance summary (Issue #39) ----
await call("browser_navigate", { url: `http://127.0.0.1:${port}/perf` });
const perf = textOf(await call("browser_perf_summary", {}));
const eng = process.env.AGENT_EYE_BROWSER || "chromium";
check("perf_summary: header, TTFB and request count (all engines)", /Perf http:\/\/127\.0\.0\.1:\d+\/perf \(reloaded, /.test(perf) && /TTFB \d+ ms/.test(perf) && /\d+ requests/.test(perf), perf);
check("perf_summary: the slow request is listed as slowest", /slowest: .*\/slow\.js/.test(perf), perf);
check("perf_summary: the heavy request is listed as largest", /largest: .*\/big\.js/.test(perf), perf);
if (eng === "chromium") {
  check("perf_summary (chromium): LCP, a real layout shift and a long task are reported", /LCP \d+ ms/.test(perf) && /CLS 0\.\d+ [✓~✗]/.test(perf) && /\(\d+ long tasks?, worst \d+ ms\)/.test(perf) && !/CLS 0 ✓/.test(perf), perf);
  check("perf_summary (chromium): CPU throttle is applied and shown", /cpu x4/.test(textOf(await call("browser_perf_summary", { cpuSlowdown: 4 }))));
} else {
  check(`perf_summary (${eng}): missing metrics are reported as n/a, not invented`, /n\/a on /.test(perf) || /LCP/.test(perf), perf);
}
check("perf_summary refuses a URL outside the allowlist", (await call("browser_perf_summary", { url: "https://example.com/" })).isError === true);

await c.close();
server.close();
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log(ok ? "\nE2E PASS" : "\nE2E FAIL");
process.exit(ok ? 0 : 1);
