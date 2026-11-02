import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { classifyCommand } from "../dist/security/command-guard.js";
import { BLOCKED_HOST_RESOLVER_RULES } from "../dist/security/url-guard.js";
import { DEFAULT_POLICY } from "../dist/policy/types.js";

const ws = path.resolve("/tmp/ws");
const verdict = (cmd, args) => classifyCommand(cmd, args, ".", ws, DEFAULT_POLICY.commandAllowlist).verdict;

test("Windows executable suffix does not bypass the guard", () => {
  assert.equal(verdict("node.exe", ["-e", "1"]), "outside");
  assert.equal(verdict("python.exe", ["-c", "1"]), "outside");
  assert.equal(verdict("npx.cmd", ["evil"]), "outside");
});

test("host-resolver rules cover the hard-blocked metadata hosts", () => {
  for (const h of ["169.254.169.254", "metadata.google.internal", "metadata.goog", "100.100.100.200", "168.63.129.16"]) {
    assert.match(BLOCKED_HOST_RESOLVER_RULES, new RegExp(`MAP ${h.replace(/\./g, "\\.")} ~NOTFOUND`));
  }
});
