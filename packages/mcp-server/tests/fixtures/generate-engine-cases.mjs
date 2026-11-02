// Regenerate after an INTENTIONAL change to browser/engine.ts:  npm run build && node tests/fixtures/generate-engine-cases.mjs
// (then review the diff: the Python port must produce the same output). Writes tests/fixtures/engine-cases.json,
// golden cases computed by the TypeScript reference; the Node and Python suites both execute them.
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url)); // packages/mcp-server/
const E = await import(pathToFileURL(root + "dist/browser/engine.js").href);

/** Runs fn and records either its value or the error message (JSON null stands for undefined). */
const run = (fn) => {
  try {
    return { value: fn() ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
};

const DEVICES = {
  "iPhone 15": { userAgent: "UA-iphone", viewport: { width: 393, height: 659 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, defaultBrowserType: "webkit" },
  "iPhone 15 Pro": { userAgent: "UA-iphone-pro", viewport: { width: 393, height: 659 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, defaultBrowserType: "webkit" },
  "Pixel 7": { userAgent: "UA-pixel", viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, defaultBrowserType: "chromium" },
  "Desktop Chrome": { userAgent: "UA-desktop", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, defaultBrowserType: "chromium" },
};

const engineInputs = [undefined, "", "   ", "chromium", "Firefox", " WEBKIT ", "safari", "chrome", "edge"];
const viewportInputs = ["1280x800", "390X844", " 800x600 ", "", "  ", undefined, "100x100", "9999x800", "abc", "1280", "1280x", "12345x800", "200x200", "3840x2400", "3841x800", "199x800", "800x2401"];
const deviceCases = [];
for (const name of ["iPhone 15", "iphone 15", " Pixel 7 ", "iPhone 99", "Nokia 3310", "pixel", "desktop chrome"]) {
  for (const engine of ["chromium", "firefox", "webkit"]) deviceCases.push({ name, engine, ...run(() => E.resolveDevice(DEVICES, name, engine)) });
}
const hintCases = [];
for (const engine of ["chromium", "firefox", "webkit"]) {
  for (const message of ["browserType.launch: Executable doesn't exist at /x/chrome", "browserType.launchPersistentContext: install the browsers", "Target closed", "boom"]) {
    const hint = E.launchErrorHint(engine, new Error(message));
    hintCases.push({ engine, message, expect: hint ? hint.message : null });
  }
}
const cdpUrls = [undefined, "", "   ", "http://127.0.0.1:9222", "http://localhost:9222", "https://localhost:9222", "http://[::1]:9222", "ws://127.0.0.1:9222/devtools/browser/abc",
  "http://LOCALHOST:9222", "http://192.168.1.10:9222", "http://example.com:9222", "http://10.0.0.5:9222", "http://169.254.169.254/", "http://0.0.0.0:9222",
  "http://127.0.0.1.evil.com:9222", "http://localhost.evil.com:9222", "http://user@evil.com:9222", "not a url", "file:///etc/passwd", "javascript:alert(1)"];
const incompat = [
  [{}, undefined], [{ AGENT_EYE_BROWSER: "chromium", AGENT_EYE_VIEWPORT: "1000x700" }, undefined], [{ AGENT_EYE_BROWSER: "firefox" }, undefined],
  [{}, "chrome"], [{ AGENT_EYE_DEVICE: "iPhone 15" }, undefined], [{ AGENT_EYE_DEVICE: "   " }, undefined], [{ AGENT_EYE_BROWSER: " WebKit " }, undefined],
];

fs.writeFileSync(root + "tests/fixtures/engine-cases.json", JSON.stringify({
  _comment: "Golden cases from the TypeScript reference (browser/engine.ts); executed by the Node and Python suites.",
  devices: DEVICES,
  engines: engineInputs.map((input) => ({ input: input ?? null, ...run(() => E.parseEngine(input)) })),
  viewports: viewportInputs.map((input) => ({ input: input ?? null, ...run(() => E.parseViewport(input)) })),
  deviceCases,
  hints: hintCases,
  cdpUrls: cdpUrls.map((input) => ({ input: input ?? null, ...run(() => E.parseCdpUrl(input)) })),
  incompat: incompat.map(([env, channel]) => ({ env, channel: channel ?? null, expect: E.cdpIncompatibility(env, channel) ?? null })),
}, null, 1));
console.log("engines", engineInputs.length, "viewports", viewportInputs.length, "devices", deviceCases.length, "hints", hintCases.length, "cdp", cdpUrls.length, "incompat", incompat.length);
