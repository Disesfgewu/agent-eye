import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// src/browser-settings.ts has no `vscode` import: bundle it with esbuild and test the real code under plain Node.
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ae-ext-")), "browser-settings.mjs");
await build({ entryPoints: [path.join(here, "../src/browser-settings.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const m = await import(pathToFileURL(out).href);

test("normalizeEngines keeps only known engines in canonical order, defaulting to chromium", () => {
  assert.deepEqual(m.normalizeEngines(["webkit", "firefox", "firefox"]), ["firefox", "webkit"]);
  assert.deepEqual(m.normalizeEngines([]), ["chromium"]);
  assert.deepEqual(m.normalizeEngines(["; rm -rf /", "chrome"]), ["chromium"]);
});

test("playwrightInstallArgs can only ever contain fixed engine names (the installer runs through a shell)", () => {
  assert.deepEqual(m.playwrightInstallArgs(["chromium"], true), ["playwright", "install", "--with-deps", "chromium"]);
  assert.deepEqual(m.playwrightInstallArgs(["webkit", "firefox"], false), ["playwright", "install", "firefox", "webkit"]);
  assert.deepEqual(m.playwrightInstallArgs(["firefox; calc", "$(evil)"], false), ["playwright", "install", "chromium"]);
});

test("browserServerEnv maps settings to the server's env knobs and explains ignored values", () => {
  assert.deepEqual(m.browserServerEnv({}), { env: {}, warnings: [] });
  assert.deepEqual(m.browserServerEnv({ browser: "chromium", channel: "chrome" }).env, { AGENT_EYE_BROWSER_CHANNEL: "chrome" });
  const ff = m.browserServerEnv({ browser: "firefox", device: "iPhone 15", viewport: "390x844" });
  assert.deepEqual(ff.env, { AGENT_EYE_BROWSER: "firefox", AGENT_EYE_DEVICE: "iPhone 15", AGENT_EYE_VIEWPORT: "390x844" });
  assert.deepEqual(ff.warnings, []);
  const clash = m.browserServerEnv({ browser: "webkit", channel: "chrome" });
  assert.equal(clash.env.AGENT_EYE_BROWSER_CHANNEL, undefined);
  assert.match(clash.warnings[0], /only applies to chromium/);
});

test("browserServerEnv ignores (and reports) invalid values instead of failing the server at launch", () => {
  const bad = m.browserServerEnv({ browser: "safari", device: "x; rm -rf /", viewport: "100x100" });
  assert.deepEqual(bad.env, {});
  assert.equal(bad.warnings.length, 3);
  assert.deepEqual(m.browserServerEnv({ viewport: "9999x800" }).env, {});
  assert.equal(m.browserServerEnv({ viewport: " 1280X800 " }).env.AGENT_EYE_VIEWPORT, "1280x800");
});

test("playwrightBrowsersDir follows Playwright's rules per platform", () => {
  assert.equal(m.playwrightBrowsersDir({ PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" }, "linux", "/home/u"), "/opt/pw");
  assert.equal(m.playwrightBrowsersDir({}, "linux", "/home/u"), "/home/u/.cache/ms-playwright");
  assert.equal(m.playwrightBrowsersDir({}, "darwin", "/Users/u"), "/Users/u/Library/Caches/ms-playwright");
  assert.equal(m.playwrightBrowsersDir({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\Users\\u"), "C:\\L\\ms-playwright");
});

test("enginesFromListing recognises downloaded engines from directory names", () => {
  assert.deepEqual(m.enginesFromListing(["chromium-1200", "chromium_headless_shell-1200", "ffmpeg-1011", "firefox-1495"]), ["chromium", "firefox"]);
  assert.deepEqual(m.enginesFromListing(["webkit-2200", ".links"]), ["webkit"]);
  assert.deepEqual(m.enginesFromListing([]), []);
});
