import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEngine, parseViewport, resolveDevice, launchErrorHint, DEFAULT_VIEWPORT } from "../dist/browser/engine.js";
import { isBlockedHost } from "../dist/security/url-guard.js";

test("parseEngine: default, valid values (case-insensitive), invalid", () => {
  assert.equal(parseEngine(undefined), "chromium");
  assert.equal(parseEngine(""), "chromium");
  assert.equal(parseEngine(" Firefox "), "firefox");
  assert.equal(parseEngine("webkit"), "webkit");
  assert.throws(() => parseEngine("safari"), /not supported.*chromium, firefox, webkit/);
});

test("parseViewport: valid, unset, and rejected values", () => {
  assert.deepEqual(parseViewport("390x844"), { width: 390, height: 844 });
  assert.equal(parseViewport(undefined), undefined);
  assert.equal(parseViewport("  "), undefined);
  for (const bad of ["abc", "1280", "100x100", "9999x800", "1280x9999", "1280*800", "-1280x800"]) {
    assert.throws(() => parseViewport(bad), /invalid/, bad);
  }
  assert.deepEqual(DEFAULT_VIEWPORT, { width: 1280, height: 800 });
});

const DEVICES = {
  "iPhone 15": { userAgent: "UA-iphone", viewport: { width: 393, height: 659 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, defaultBrowserType: "webkit" },
  "Pixel 7": { userAgent: "UA-pixel", viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, defaultBrowserType: "chromium" },
};

test("resolveDevice: case-insensitive lookup; isMobile dropped for firefox only", () => {
  const d = resolveDevice(DEVICES, "iphone 15", "webkit");
  assert.equal(d.userAgent, "UA-iphone");
  assert.equal(d.isMobile, true);
  assert.equal(d.deviceScaleFactor, 3);
  const f = resolveDevice(DEVICES, "Pixel 7", "firefox");
  assert.equal("isMobile" in f, false);
  assert.equal(f.hasTouch, true);
});

test("resolveDevice: unknown device gives suggestions", () => {
  assert.throws(() => resolveDevice(DEVICES, "iPhone 99", "chromium"), /not a known Playwright device\. Similar: iPhone 15/);
  assert.throws(() => resolveDevice(DEVICES, "Toaster", "chromium"), /playwright\.dev\/docs\/emulation/);
});

test("launchErrorHint: missing executable → install command", () => {
  const e = launchErrorHint("firefox", new Error("browserType.launchPersistentContext: Executable doesn't exist at /x"));
  assert.match(e.message, /npx playwright install firefox/);
  assert.equal(launchErrorHint("webkit", new Error("something else")), undefined);
});

test("isBlockedHost: metadata + link-local blocked, normal hosts not (non-Chromium route fallback)", () => {
  for (const h of ["169.254.169.254", "METADATA.GOOGLE.INTERNAL", "metadata.goog", "100.100.100.200", "168.63.129.16", "169.254.1.1"]) {
    assert.equal(isBlockedHost(h), true, h);
  }
  for (const h of ["localhost", "127.0.0.1", "example.com", "169.255.0.1", "10.0.0.1"]) {
    assert.equal(isBlockedHost(h), false, h);
  }
});
