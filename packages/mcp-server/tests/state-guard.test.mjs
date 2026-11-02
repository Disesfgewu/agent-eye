import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkUploadPath, checkUploads, storageInputProblem, MAX_UPLOAD_FILE_BYTES } from "../dist/security/state-guard.js";

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ae-state-")));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ae-state-out-")));
const w = (rel, body = "x") => {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), body);
};
w("fixtures/photo.png", "png-bytes");
w("notes.md", "hello");
w(".env", "SECRET=1");
w(".env.local", "SECRET=1");
w("config/id_rsa", "key");
w("certs/server.pem", "pem");
w("certs/cert.key", "k");
w("credentials.json", "{}");
w(".git/config", "[core]");
w(".agent-eye/policy.json", "{}");
w("app/.ssh/known_hosts", "h");
fs.mkdirSync(path.join(ws, "adir"));
fs.writeFileSync(path.join(outside, "secret.txt"), "outside");

test("upload: plain workspace files are accepted (relative and absolute)", () => {
  const rel = checkUploadPath(ws, "fixtures/photo.png");
  assert.ok(rel.ok);
  assert.equal(rel.size, 9);
  assert.ok(checkUploadPath(ws, path.join(ws, "notes.md")).ok);
});

test("upload: secrets, tooling state and credentials are refused", () => {
  for (const p of [".env", ".env.local", "config/id_rsa", "certs/server.pem", "certs/cert.key", "credentials.json", ".git/config", ".agent-eye/policy.json", "app/.ssh/known_hosts"]) {
    const r = checkUploadPath(ws, p);
    assert.equal(r.ok, false, p);
  }
});

test("upload: outside the workspace, directories and missing files are refused", () => {
  assert.match(checkUploadPath(ws, path.join(outside, "secret.txt")).reason, /outside the workspace/);
  assert.match(checkUploadPath(ws, path.relative(ws, path.join(outside, "secret.txt"))).reason, /outside the workspace/);
  assert.match(checkUploadPath(ws, "adir").reason, /not a regular file/);
  assert.match(checkUploadPath(ws, "nope.txt").reason, /does not exist/);
  assert.equal(checkUploadPath(ws, "").ok, false);
  assert.equal(checkUploadPath(ws, "a\0b").ok, false);
});

test("upload: a symlink that points outside the workspace is resolved and refused", (t) => {
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "innocent.txt"));
  } catch {
    t.skip("symlinks need privileges on this machine");
    return;
  }
  assert.match(checkUploadPath(ws, "innocent.txt").reason, /outside the workspace/);
});

test("upload: size and count limits", () => {
  const big = path.join(ws, "big.bin");
  fs.writeFileSync(big, Buffer.alloc(MAX_UPLOAD_FILE_BYTES + 1));
  assert.match(checkUploadPath(ws, "big.bin").reason, /limit 25 MB per file/);
  assert.match(checkUploads(ws, Array.from({ length: 11 }, () => "notes.md")).reason, /at most 10/);
  assert.match(checkUploads(ws, []).reason, /no files/);
  const ok = checkUploads(ws, ["notes.md", "fixtures/photo.png"]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.files.map((f) => f.name), ["notes.md", "photo.png"]);
});

test("storage: valid input passes, bad names / values / sizes are explained", () => {
  assert.equal(storageInputProblem({ cookies: [{ name: "sid", value: "abc123", httpOnly: true, sameSite: "Lax" }], localStorage: { token: "x.y.z" } }), undefined);
  assert.match(storageInputProblem({ cookies: [{ name: "bad name", value: "v" }] }), /not a valid cookie name/);
  assert.match(storageInputProblem({ cookies: [{ name: "a", value: "v; Domain=evil.com" }] }), /value must be/);
  assert.match(storageInputProblem({ cookies: [{ name: "a", value: "v\nSet-Cookie: b=c" }] }), /value must be/);
  assert.match(storageInputProblem({ cookies: [{ name: "a", value: "v", path: "/a b" }] }), /invalid path/);
  assert.match(storageInputProblem({ cookies: [{ name: "a", value: "v", sameSite: "None" }] }), /requires secure/);
  assert.match(storageInputProblem({ cookies: Array.from({ length: 31 }, (_, i) => ({ name: `c${i}`, value: "v" })) }), /at most 30 cookies/);
  assert.match(storageInputProblem({ localStorage: { "": "v" } }), /key/);
  assert.match(storageInputProblem({ sessionStorage: { k: "x".repeat(9000) } }), /larger than/);
  assert.match(storageInputProblem({ localStorage: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, "v"])) }), /at most 50/);
});
