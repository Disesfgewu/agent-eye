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

const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end('<!doctype html><h1 id="t">agent-eye e2e ok</h1><button id="b">go</button>');
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

const shot = await c.callTool({ name: "browser_screenshot", arguments: {} });
check("screenshot returns an image", (shot.content || []).some((x) => x.type === "image"));

const bad = await c.callTool({ name: "browser_navigate", arguments: { url: "file:///etc/passwd" } });
check("file:// navigation blocked by policy", /blocked/i.test(textOf(bad)));

await c.close();
server.close();
try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
console.log(ok ? "\nE2E PASS" : "\nE2E FAIL");
process.exit(ok ? 0 : 1);
