import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { classifyUrl } from "../dist/security/url-guard.js";
import { classifyCommand } from "../dist/security/command-guard.js";
import { redactHeaders, redactText } from "../dist/security/redaction.js";
import { RingBuffer } from "../dist/browser/ring-buffer.js";
import { DEFAULT_POLICY } from "../dist/policy/types.js";

const allow = DEFAULT_POLICY.navigationAllowlist;

test("classifyUrl: localhost is allowlisted", () => {
  assert.equal(classifyUrl("http://localhost:3000/x", allow).verdict, "allowlisted");
  assert.equal(classifyUrl("http://127.0.0.1:5173", allow).verdict, "allowlisted");
  assert.equal(classifyUrl("http://[::1]:8080", allow).verdict, "allowlisted");
});

test("classifyUrl: non-http schemes are blocked", () => {
  for (const u of ["file:///etc/passwd", "chrome://settings", "data:text/html,hi", "javascript:alert(1)", "ftp://x"]) {
    assert.equal(classifyUrl(u, allow).verdict, "blocked", u);
  }
});

test("classifyUrl: cloud metadata and link-local are hard-blocked even if allowlisted", () => {
  const wide = [...allow, "169.254.169.254", "metadata.google.internal"];
  assert.equal(classifyUrl("http://169.254.169.254/latest/meta-data", wide).verdict, "blocked");
  assert.equal(classifyUrl("http://metadata.google.internal/", wide).verdict, "blocked");
  assert.equal(classifyUrl("http://169.254.10.10/", wide).verdict, "blocked");
  // decimal / hex encodings are normalized by WHATWG URL to dotted form
  assert.equal(classifyUrl("http://2852039166/", wide).verdict, "blocked");
});

test("classifyUrl: external and private hosts outside the allowlist are 'outside'", () => {
  assert.equal(classifyUrl("https://example.com", allow).verdict, "outside");
  const priv = classifyUrl("http://192.168.1.5", allow);
  assert.equal(priv.verdict, "outside");
  assert.match(priv.reason, /private/);
});

test("classifyUrl: leading-dot allowlist entry matches subdomains only", () => {
  const a = [".example.com"];
  assert.equal(classifyUrl("https://sub.example.com", a).verdict, "allowlisted");
  assert.equal(classifyUrl("https://example.com", a).verdict, "allowlisted");
  assert.equal(classifyUrl("https://evilexample.com", a).verdict, "outside");
});

test("classifyUrl: garbage input is blocked", () => {
  assert.equal(classifyUrl("not a url", allow).verdict, "blocked");
});

const ws = path.resolve("/tmp/ws");
const cmdAllow = DEFAULT_POLICY.commandAllowlist;

test("classifyCommand: plain allowlisted command passes", () => {
  const v = classifyCommand("npm", ["run", "dev"], ".", ws, cmdAllow);
  assert.equal(v.verdict, "allowlisted");
});

test("classifyCommand: .exe/.cmd suffix and path prefix are normalized for allowlist match", () => {
  assert.equal(classifyCommand("npm.cmd", [], ".", ws, cmdAllow).verdict, "allowlisted");
});

test("classifyCommand: shell metacharacters are blocked", () => {
  for (const c of ["npm; rm -rf /", "npm && ls", "npm | cat", "$(whoami)", "npm`id`"]) {
    assert.equal(classifyCommand(c, [], ".", ws, cmdAllow).verdict, "blocked", c);
  }
  assert.equal(classifyCommand("npm", ["a\nb"], ".", ws, cmdAllow).verdict, "blocked");
});

test("classifyCommand: cwd escaping the workspace is blocked", () => {
  assert.equal(classifyCommand("npm", [], "..", ws, cmdAllow).verdict, "blocked");
  assert.equal(classifyCommand("npm", [], "../../etc", ws, cmdAllow).verdict, "blocked");
  assert.equal(classifyCommand("npm", [], "sub/dir", ws, cmdAllow).verdict, "allowlisted");
});

test("classifyCommand: non-allowlisted executable is 'outside'; empty is blocked", () => {
  assert.equal(classifyCommand("curl", [], ".", ws, cmdAllow).verdict, "outside");
  assert.equal(classifyCommand("  ", [], ".", ws, cmdAllow).verdict, "blocked");
});

test("redactHeaders: sensitive headers redacted case-insensitively; disabled passes through", () => {
  const h = { Authorization: "Bearer x", "Set-Cookie": "a=b", "X-Api-Key": "k", Accept: "*/*" };
  const r = redactHeaders(h, true);
  assert.equal(r.Authorization, "<redacted>");
  assert.equal(r["Set-Cookie"], "<redacted>");
  assert.equal(r["X-Api-Key"], "<redacted>");
  assert.equal(r.Accept, "*/*");
  assert.deepEqual(redactHeaders(h, false), h);
});

test("redactText: token-like query params redacted, others untouched", () => {
  assert.equal(
    redactText("https://x/y?access_token=abc123&page=2&api_key=zzz", true),
    "https://x/y?access_token=<redacted>&page=2&api_key=<redacted>"
  );
  assert.equal(redactText("https://x/y?token=abc", false), "https://x/y?token=abc");
});

test("RingBuffer: keeps newest N, recent(limit), clear()", () => {
  const b = new RingBuffer(3);
  for (let i = 1; i <= 5; i++) b.push(i);
  assert.deepEqual(b.recent(), [3, 4, 5]);
  assert.deepEqual(b.recent(2), [4, 5]);
  assert.equal(b.size, 3);
  b.clear();
  assert.equal(b.size, 0);
});

test("DEFAULT_POLICY: highRisk is denied by default", () => {
  assert.equal(DEFAULT_POLICY.categories.highRisk, "deny");
});
