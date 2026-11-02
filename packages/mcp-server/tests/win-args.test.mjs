import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { quoteWinArg, windowsLaunch, windowsUnsafeArg } from "../dist/security/win-args.js";
import { classifyCommand } from "../dist/security/command-guard.js";
import { DevServerManager } from "../dist/devserver/dev-server-manager.js";
import { DEFAULT_POLICY } from "../dist/policy/types.js";

const win = process.platform === "win32";
const allow = DEFAULT_POLICY.commandAllowlist;

test("windowsUnsafeArg refuses what cmd.exe would interpret even inside quotes", () => {
  for (const bad of ['a"b', "%PATH%", "x^y", '"&calc"']) assert.ok(windowsUnsafeArg(bad), bad);
  for (const ok of ["run", "--port=3000", "&echo", "a>b", "a b", "(x)", "", "--define={\\a\\}"]) assert.equal(windowsUnsafeArg(ok), undefined, ok);
});

test("quoteWinArg makes cmd operators literal", () => {
  assert.equal(quoteWinArg("&echo"), '"&echo"');
  assert.equal(quoteWinArg("x>file"), '"x>file"');
  assert.equal(quoteWinArg("a b"), '"a b"');
  assert.equal(quoteWinArg("(x)"), '"(x)"');
  assert.equal(quoteWinArg(""), '""');
  assert.equal(quoteWinArg("--port=3000"), "--port=3000");
});

test("windowsLaunch: real executables are direct, .cmd/.bat shims and unknown names go through cmd.exe (Issue #35)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-launch-"));
  for (const f of ["tool.exe", "shim.cmd", "old.bat", "both.cmd", "both.exe"]) fs.writeFileSync(path.join(dir, f), "");
  const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ae-cwd-"));
  assert.deepEqual(windowsLaunch("tool", cwd, env), { mode: "direct", file: path.join(dir, "tool.exe") });
  assert.deepEqual(windowsLaunch("tool.exe", cwd, env), { mode: "direct", file: path.join(dir, "tool.exe") });
  assert.deepEqual(windowsLaunch("shim", cwd, env), { mode: "cmd" });
  assert.deepEqual(windowsLaunch("old", cwd, env), { mode: "cmd" });
  assert.equal(windowsLaunch("both", cwd, env).mode, "direct", "PATHEXT order: .exe before .cmd");
  assert.deepEqual(windowsLaunch("missing", cwd, env), { mode: "cmd" });
  // the working directory wins over PATH, like cmd.exe
  fs.writeFileSync(path.join(cwd, "shim.exe"), "");
  assert.equal(windowsLaunch("shim", cwd, env).mode, "direct");
  // explicit relative path
  fs.mkdirSync(path.join(cwd, "bin"));
  fs.writeFileSync(path.join(cwd, "bin", "wrapper.cmd"), "");
  assert.deepEqual(windowsLaunch("./bin/wrapper.cmd", cwd, env), { mode: "cmd" });
});

test("Windows: only .cmd shims are subject to cmd.exe quoting rules; real executables take any argument", { skip: !win }, () => {
  const ws = path.resolve(os.tmpdir());
  for (const args of [["run", 'a"b'], ["run", "%COMSPEC%"], ["run", "x^&calc"]]) {
    assert.equal(classifyCommand("npm", args, ".", ws, allow).verdict, "blocked", `npm ${args.join(" ")}`);
  }
  assert.equal(classifyCommand("npm", ["run", "dev", "--", "--port=3000"], ".", ws, allow).verdict, "allowlisted");
  // node.exe is spawned directly (Issue #35), so quotes, % and ^ are just data
  assert.equal(classifyCommand("node", ["server.js", 'a"b', "%PATH%", "x^&y"], ".", ws, allow).verdict, "allowlisted");
});

test("Windows: an allowlisted shim cannot smuggle a second command through its args (Issue #27)", { skip: !win }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ae-inj-"));
  const m = new DevServerManager();
  m.start("t", "npm", ["--version", "&echo", "pwned>PWNED.txt"], ws);
  await new Promise((r) => setTimeout(r, 4000));
  await m.stopAll();
  assert.equal(fs.existsSync(path.join(ws, "PWNED.txt")), false, "args must stay literal");
  assert.throws(() => m.start("u", "npm", ["--version", 'a"b'], ws), /Refusing to start/);
});

test("Windows: a real executable receives quotes, % and ^ literally (Issue #35)", { skip: !win }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ae-direct-"));
  fs.writeFileSync(path.join(ws, "dump.js"), 'require("fs").writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)));');
  const want = ['a"b', "%PATH%", "x^&y", "&echo", "p>q", "two words"];
  const m = new DevServerManager();
  m.start("d", "node", ["dump.js", ...want], ws);
  await new Promise((r) => setTimeout(r, 2500));
  await m.stopAll();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, "argv.json"), "utf8")), want);
  assert.equal(fs.existsSync(path.join(ws, "q")), false, "no redirection happened");
});
