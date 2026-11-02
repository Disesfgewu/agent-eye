import { test } from "node:test";
import assert from "node:assert/strict";
import { diffReleases, parseState, renderBody, renderComment, safeTag, releaseUrl } from "./ecosystem-watch.mjs";

test("diffReleases: first run baselines everything and reports no changes", () => {
  const r = diffReleases({}, { "a/b": "v1", "c/d": "2.0" });
  assert.deepEqual(r.changes, []);
  assert.equal(r.baseline.length, 2);
  assert.deepEqual(r.next, { "a/b": "v1", "c/d": "2.0" });
});

test("diffReleases: reports only repos whose tag changed; idempotent on a second run", () => {
  const prev = { "a/b": "v1", "c/d": "2.0" };
  const first = diffReleases(prev, { "a/b": "v2", "c/d": "2.0" });
  assert.deepEqual(first.changes, [{ repo: "a/b", from: "v1", to: "v2" }]);
  const second = diffReleases(first.next, { "a/b": "v2", "c/d": "2.0" });
  assert.deepEqual(second.changes, []);
  assert.deepEqual(second.baseline, []);
});

test("diffReleases: a repo that could not be checked keeps its previous value", () => {
  const r = diffReleases({ "a/b": "v1" }, { "a/b": null });
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.next, { "a/b": "v1" });
});

test("state round-trips through the issue body", () => {
  const state = { "a/b": "v1.2.3", "c/d": "release-5" };
  assert.deepEqual(parseState(renderBody(state, "2026-11-02")), state);
  assert.deepEqual(parseState("no state here"), {});
  assert.deepEqual(parseState("<!-- ecosystem-state: {not json} -->"), {});
  assert.deepEqual(parseState(undefined), {});
});

test("untrusted tag text can never inject mentions or markdown into issue text", () => {
  assert.equal(safeTag("v1.2.3"), "v1.2.3");
  assert.equal(safeTag("@browserbasehq/stagehand@3.0.0"), "@browserbasehq/stagehand@3.0.0");
  assert.equal(safeTag("playwright-mcp@1.2"), "playwright-mcp@1.2");
  for (const bad of ["@everyone", "v1 @octocat", "[x](http://evil)", "v1\nINJECT", "`;", "", "a".repeat(81), 5, null]) {
    assert.equal(safeTag(bad), "(unprintable tag)", String(bad));
  }
  const c = renderComment([{ repo: "a/b", from: "v1", to: "@everyone" }], "2026-11-02");
  assert.ok(!c.includes("@everyone"));
  assert.ok(renderBody({ "a/b": "[x](http://evil)" }, "d").includes("(unprintable tag)"));
});

test("release links are built from the repo + encoded tag, never from API data", () => {
  assert.equal(releaseUrl("a/b", "v1.0+x"), "https://github.com/a/b/releases/tag/v1.0%2Bx");
  const c = renderComment([{ repo: "microsoft/playwright", from: "v1.61.0", to: "v1.62.0" }], "2026-11-02");
  assert.match(c, /microsoft\/playwright.*v1\.61\.0.*v1\.62\.0.*releases\/tag\/v1\.62\.0/);
});
