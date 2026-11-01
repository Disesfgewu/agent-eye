import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCommand } from "../dist/security/command-guard.js";
import { inlineCodeReason } from "../dist/security/interpreter-guard.js";
import { DEFAULT_POLICY } from "../dist/policy/types.js";

// The same table is executed by the Python suite (packages/python/tests), so the two
// implementations of the command guard cannot silently drift apart.
const CASES = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/command-cases.json", import.meta.url)), "utf8"));
const ws = path.resolve("/tmp/ws");
const verdict = (cmd, args) => classifyCommand(cmd, args, ".", ws, DEFAULT_POLICY.commandAllowlist).verdict;

for (const [cmd, args, note] of CASES.safe) {
  test(`allowed: ${cmd} ${args.join(" ")}${note ? ` (${note})` : ""}`, () => {
    assert.equal(verdict(cmd, args), "allowlisted");
  });
}

for (const [cmd, args, note] of CASES.blocked) {
  test(`not allowlisted: ${cmd} ${args.join(" ")}${note ? ` (${note})` : ""}`, () => {
    assert.equal(verdict(cmd, args), "outside");
    assert.ok(inlineCodeReason(path.basename(cmd).replace(/\.(exe|cmd|bat|ps1)$/i, ""), args), "has a reason");
  });
}
