import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { quoteWinArg, windowsUnsafeArg } from "../dist/security/win-args.js";
import { classifyCommand } from "../dist/security/command-guard.js";
import { DevServerManager } from "../dist/devserver/dev-server-manager.js";
import { DEFAULT_POLICY } from "../dist/policy/types.js";

const win = process.platform === "win32";

test("windowsUnsafeArg refuses what cmd.exe would interpret even inside quotes", () => {
  for (const bad of ['a"b', "%PATH%", "x^y", '"&calc"']) assert.ok(windowsUnsafeArg(bad), bad);
  for (const ok of ["run", "--port=3000", "&echo", "a>b", "a b", "(x)", "", "--define={\a\}"]) assert.equal(windowsUnsafeArg(ok), undefined, ok);
});

test("quoteWinArg makes cmd operators literal", () => {
  assert.equal(quoteWinArg("&echo"), '"&echo"');
  assert.equal(quoteWinArg("x>file"), '"x>file"');
  assert.equal(quoteWinArg("a b"), '"a b"');
  assert.equal(quoteWinArg("(x)"), '"(x)"');
  assert.equal(quoteWinArg(""), '""');
  assert.equal(quoteWinArg("--port=3000"), "--port=3000");
});

test("Windows: the command guard blocks args cmd.exe would interpret", { skip: !win }, () => {
  const ws = path.resolve(os.tmpdir());
  for (const args of [["run", 'a"b'], ["run", "%COMSPEC%"], ["run", "x^&calc"]]) {
    assert.equal(classifyCommand("npm", args, ".", ws, DEFAULT_POLICY.commandAllowlist).verdict, "blocked", args.join(" "));
  }
  assert.equal(classifyCommand("npm", ["run", "dev", "--", "--port=3000"], ".", ws, DEFAULT_POLICY.commandAllowlist).verdict, "allowlisted");
});

test("Windows: an allowlisted command cannot smuggle a second command through its args (Issue #27)", { skip: !win }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ae-inj-"));
  const m = new DevServerManager();
  m.start("t", "node", ["--version", "&echo", "pwned>PWNED.txt"], ws);
  await new Promise((r) => setTimeout(r, 3000));
  await m.stopAll();
  assert.equal(fs.existsSync(path.join(ws, "PWNED.txt")), false, "args must stay literal");
  assert.throws(() => m.start("u", "node", ["--version", 'a"b'], ws), /Refusing to start/);
});
