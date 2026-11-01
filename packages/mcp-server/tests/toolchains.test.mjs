import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { classifyCommand } from "../dist/security/command-guard.js";
import { DEFAULT_POLICY } from "../dist/policy/types.js";

const ws = path.resolve("/tmp/ws");
const verdict = (cmd, args) => classifyCommand(cmd, args, ".", ws, DEFAULT_POLICY.commandAllowlist).verdict;

test("rejections carry an actionable reason", () => {
  const v = classifyCommand("cargo", ["watch", "-s", "x"], ".", ws, DEFAULT_POLICY.commandAllowlist);
  assert.equal(v.verdict, "outside");
  assert.match(v.reason, /cargo watch/);
  const g = classifyCommand("go", ["run", "example.com/x@latest"], ".", ws, DEFAULT_POLICY.commandAllowlist);
  assert.match(g.reason, /not a local package/);
});

test("Windows shims (.exe/.cmd/.bat) get the same rules", () => {
  assert.equal(verdict("go.exe", ["run", "."]), "allowlisted");
  assert.equal(verdict("go.exe", ["run", "-exec", "sh", "."]), "outside");
  assert.equal(verdict("mvnw.cmd", ["spring-boot:run"]), "allowlisted");
  assert.equal(verdict("gradlew.bat", ["bootRun", "-I", "x"]), "outside");
});

test("mvnw/gradlew with a path must resolve inside the workspace", () => {
  assert.equal(verdict("./mvnw", ["spring-boot:run"]), "allowlisted");
  assert.equal(verdict("./backend/gradlew", ["bootRun"]), "allowlisted");
  assert.equal(verdict("../../tmp/evil/mvnw", ["spring-boot:run"]), "outside");
  assert.equal(verdict("/opt/evil/gradlew", ["bootRun"]), "outside");
});

test("the toolchain launchers are in the default allowlist", () => {
  for (const c of ["go", "cargo", "trunk", "dx", "air", "templ", "wails", "dotnet", "mvn", "mvnw", "gradle", "gradlew", "mix"]) {
    assert.ok(DEFAULT_POLICY.commandAllowlist.includes(c), c);
  }
});
