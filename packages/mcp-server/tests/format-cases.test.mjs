import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as F from "../dist/browser/format.js";
import { redactText } from "../dist/security/redaction.js";

// Golden cases computed from this implementation; the Python port (packages/python) runs the same file,
// so the two formatters cannot silently drift apart.
const { cases } = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./fixtures/format-cases.json", import.meta.url)), "utf8"));
const REDACTORS = { identity: (u) => u, secrets: (u) => redactText(u, true) };

/** JSON null stands for `undefined` (diffSnapshots: no changes). */
const withRedact = (opts) => (opts && typeof opts.redact === "string" ? { ...opts, redact: REDACTORS[opts.redact] } : opts);

for (const c of cases) {
  test(`format golden: ${c.name}`, () => {
    let args = c.args;
    if (["formatNetwork", "selectNetwork", "formatHealth"].includes(c.fn)) {
      args = c.fn === "formatHealth" ? [withRedact(c.args[0])] : [c.args[0], withRedact(c.args[1])];
    }
    const out = F[c.fn](...args);
    const got = c.fn === "selectNetwork" ? { shown: out.shown, hiddenStatic: out.hiddenStatic } : out ?? null;
    assert.deepEqual(got, c.expect);
  });
}

test("the fixture is not vacuous", () => {
  assert.ok(cases.length >= 40);
  assert.ok(new Set(cases.map((c) => c.fn)).size >= 9);
});
