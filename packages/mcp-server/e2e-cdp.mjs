// End-to-end check of CDP attach (Issue #40) against a REAL Chromium that plays "the user's browser".
// The point is what Agent Eye must NOT do to a browser it did not launch:
//   - adopt or read the user's existing tabs,
//   - adopt tabs the user opens later,
//   - lock the user's input, resize their window, or close their tabs / browser.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const textOf = (r) => (r.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
let ok = true;
const check = (name, cond, detail = "") => {
  if (!cond) ok = false;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `\n      ${String(detail).split("\n").join("\n      ")}` : ""}`);
};
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const web = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url.startsWith("/secret")) return res.end("<!doctype html><title>secret</title><h1>USER-PRIVATE-TAB</h1>");
  if (req.url.startsWith("/popup")) return res.end("<!doctype html><title>popup</title><h1>popup-from-agent</h1>");
  if (req.url.startsWith("/imds")) return res.end('<!doctype html><title>imds</title><script>fetch("http://169.254.169.254/latest/meta-data/",{mode:"no-cors"}).catch(()=>{});</script>probe');
  res.end('<!doctype html><title>app</title><h1>agent-app</h1><a id="p" href="/popup" target="_blank">open popup</a><input id="i" aria-label="field">');
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const webPort = web.address().port;

// ---- "the user's browser": a real Chromium PROCESS with a remote-debugging port (like `chrome --remote-debugging-port`).
// Its tabs live in the browser's DEFAULT context, which is exactly what the agent attaches to. (A Playwright-launched
// browser has no default context, so a test built on chromium.launch() would never put the agent and the "user" in the same
// context and every "does not touch the user's tabs" check below would pass trivially.)
const cdpPort = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ae-cdp-profile-"));
const proc = spawn(chromium.executablePath(), [
  "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--no-sandbox", "about:blank",
], { stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}
const userBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const userCtx = userBrowser.contexts()[0];
const userTab = await userCtx.newPage();
await userTab.goto(`http://127.0.0.1:${webPort}/secret`);
await userTab.evaluate(() => { document.title = "secret-edited"; });

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ae-cdp-"));
const start = async (env) => {
  const c = new Client({ name: "e2e-cdp", version: "0" }, {});
  await c.connect(new StdioClientTransport({
    command: "node",
    args: ["dist/index.js", "--workspace", ws],
    env: { ...process.env, AGENT_EYE_HEADLESS: "1", AGENT_EYE_LOG_LEVEL: "warn", AGENT_EYE_IDLE_CLOSE_MS: "0", ...env },
  }));
  return c;
};
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });

const c = await start({ AGENT_EYE_CDP_URL: `http://127.0.0.1:${cdpPort}` });
const before = userCtx.pages().length;
const nav = await call(c, "browser_navigate", { url: `http://127.0.0.1:${webPort}/` });
check("navigate works through the attached browser", !nav.isError, textOf(nav));
check("a NEW tab was opened for the agent; the user's tab count grew by exactly one", userCtx.pages().length === before + 1, `before=${before} after=${userCtx.pages().length}`);

const snap = textOf(await call(c, "browser_snapshot"));
check("the agent sees its own page and nothing of the user's tab", /agent-app/.test(snap) && !/USER-PRIVATE-TAB/.test(snap), snap);
check("the user's tab was not navigated or modified", userTab.url().endsWith("/secret") && (await userTab.title()) === "secret-edited");

// user opens a tab while the agent is attached: it must not become the agent's page
const lateTab = await userCtx.newPage();
await lateTab.goto(`http://127.0.0.1:${webPort}/secret-late`);
const snap2 = textOf(await call(c, "browser_snapshot"));
check("a tab the user opens later is NOT adopted by the agent", /agent-app/.test(snap2) && !/USER-PRIVATE-TAB/.test(snap2), snap2);

// the agent's own popup IS followed
await call(c, "browser_click", { target: "#p" });
await new Promise((r) => setTimeout(r, 800));
check("a popup opened by the agent's tab is followed", /popup-from-agent/.test(textOf(await call(c, "browser_snapshot"))));

// the SSRF guard applies on the agent's tabs
await call(c, "browser_navigate", { url: `http://127.0.0.1:${webPort}/imds` });
await new Promise((r) => setTimeout(r, 600));
const failed = textOf(await call(c, "browser_get_network_requests", { failedOnly: true }));
check("page-initiated requests to metadata hosts are blocked on the agent's tab", /169\.254\.169\.254/.test(failed), failed);

// no input lock / overlay in the user's tabs
const locked = await userTab.evaluate(() => typeof window.__agentEyeLock === "function" || !!document.getElementById("__agent_eye_status"));
check("nothing was injected into the user's tab (no input lock, no status banner)", locked === false);

// destructive helpers are refused or contained
await call(c, "browser_navigate", { url: `http://127.0.0.1:${webPort}/` });
const cleared = await call(c, "browser_set_storage", { clear: true });
check("browser_set_storage clear is refused on the user's browser", cleared.isError === true && /own browser/.test(textOf(cleared)), textOf(cleared));
const sizeBefore = await userTab.evaluate(() => [window.outerWidth, window.outerHeight]);
await call(c, "browser_resize", { width: 700, height: 500 });
check("browser_resize does not resize the user's window", JSON.stringify(await userTab.evaluate(() => [window.outerWidth, window.outerHeight])) === JSON.stringify(sizeBefore));

// closing: only our tabs go away, the browser and the user's tabs stay
await call(c, "browser_close");
await new Promise((r) => setTimeout(r, 500));
check("browser_close closes only the agent's tabs", userCtx.pages().length === before + 1 /* user tab + late tab */ && !userTab.isClosed() && !lateTab.isClosed(), `pages=${userCtx.pages().length}`);
check("the user's browser process is still running after the agent disconnects", proc.exitCode === null && (await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then((r) => r.ok, () => false)));
await c.close();

// ---- misconfiguration is explained, not silently accepted
const bad = await start({ AGENT_EYE_CDP_URL: "http://192.168.1.50:9222" });
const rejected = await call(bad, "browser_navigate", { url: `http://127.0.0.1:${webPort}/` });
check("a non-loopback CDP URL is refused with an explanation", rejected.isError === true && /must point at this machine/.test(textOf(rejected)), textOf(rejected));
await bad.close();
const mixed = await start({ AGENT_EYE_CDP_URL: `http://127.0.0.1:${cdpPort}`, AGENT_EYE_DEVICE: "iPhone 15" });
const clash = await call(mixed, "browser_navigate", { url: `http://127.0.0.1:${webPort}/` });
check("device emulation + CDP is refused with an explanation", clash.isError === true && /AGENT_EYE_DEVICE/.test(textOf(clash)), textOf(clash));
await mixed.close();
const nobody = await start({ AGENT_EYE_CDP_URL: "http://127.0.0.1:1" });
const unreachable = await call(nobody, "browser_navigate", { url: `http://127.0.0.1:${webPort}/` });
check("an unreachable endpoint gives an actionable error", unreachable.isError === true && /remote-debugging-port/.test(textOf(unreachable)), textOf(unreachable));
await nobody.close();

await userBrowser.close().catch(() => undefined);
proc.kill();
web.close();
console.log(ok ? "\nALL PASSED" : "\nFAILURES");
process.exit(ok ? 0 : 1);
