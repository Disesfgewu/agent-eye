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
const check = (name, cond) => { if (!cond) ok = false; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

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
check("includeHistory returns earlier loads too (x2)", /×2/.test(cons3));
// SSRF: a page on an allowlisted host must not be able to reach cloud-metadata addresses.
await c.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${port}/imds` } });
await new Promise((r) => setTimeout(r, 500));
const ssrf = textOf(await c.callTool({ name: "browser_get_network_requests", arguments: { failedOnly: true } }));
check("page-initiated request to 169.254.169.254 cannot resolve (blocked at the browser)", /169\.254\.169\.254/.test(ssrf) && /ERR_NAME_NOT_RESOLVED/.test(ssrf));

const usage = await c.callTool({ name: "usage_report", arguments: {} });
check("usage_report counts the calls made", /browser_snapshot \| [1-9]\d* \|/.test(textOf(usage)) && /Calls: \d+/.test(textOf(usage)));

await c.close();
server.close();
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log(ok ? "\nE2E PASS" : "\nE2E FAIL");
process.exit(ok ? 0 : 1);
