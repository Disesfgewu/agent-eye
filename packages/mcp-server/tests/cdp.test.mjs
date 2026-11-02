import { test } from "node:test";
import assert from "node:assert/strict";
import { cdpIncompatibility, parseCdpUrl } from "../dist/browser/engine.js";

test("parseCdpUrl: unset or blank means 'launch our own browser'", () => {
  assert.equal(parseCdpUrl(undefined), undefined);
  assert.equal(parseCdpUrl(""), undefined);
  assert.equal(parseCdpUrl("   "), undefined);
});

test("parseCdpUrl accepts loopback endpoints only", () => {
  for (const ok of ["http://127.0.0.1:9222", "http://localhost:9222", "https://localhost:9222", "http://[::1]:9222", "ws://127.0.0.1:9222/devtools/browser/abc", "http://LOCALHOST:9222"]) {
    assert.equal(parseCdpUrl(ok), ok, ok);
  }
  for (const bad of ["http://192.168.1.10:9222", "http://example.com:9222", "http://10.0.0.5:9222", "http://169.254.169.254/", "http://0.0.0.0:9222", "http://127.0.0.1.evil.com:9222", "http://localhost.evil.com:9222", "http://user@evil.com:9222"]) {
    assert.throws(() => parseCdpUrl(bad), /must point at this machine/, bad);
  }
});

test("parseCdpUrl rejects non-URLs and non-web schemes", () => {
  assert.throws(() => parseCdpUrl("not a url"), /not a valid URL/);
  assert.throws(() => parseCdpUrl("file:///etc/passwd"), /must be http/);
  assert.throws(() => parseCdpUrl("javascript:alert(1)"), /must be http/);
});

test("cdpIncompatibility flags settings that cannot apply to a browser we did not launch", () => {
  assert.equal(cdpIncompatibility({}, undefined), undefined);
  assert.equal(cdpIncompatibility({ AGENT_EYE_BROWSER: "chromium", AGENT_EYE_VIEWPORT: "1000x700" }, undefined), undefined);
  assert.match(cdpIncompatibility({ AGENT_EYE_BROWSER: "firefox" }, undefined), /Chromium-only/);
  assert.match(cdpIncompatibility({}, "chrome"), /BROWSER_CHANNEL/);
  assert.match(cdpIncompatibility({ AGENT_EYE_DEVICE: "iPhone 15" }, undefined), /AGENT_EYE_DEVICE/);
});
