import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPerf, rate, totalBlockingTime } from "../dist/browser/perf.js";
import { estimateTextTokens } from "../dist/usage/estimate.js";

const ALL = ["largest-contentful-paint", "layout-shift", "longtask", "paint", "navigation", "resource"];
const ctx = { url: "http://localhost:3000/shop", how: "reloaded", engine: "chromium", cpuSlowdown: 1 };
const base = {
  ttfb: 12.4, dcl: 210, load: 640, fcp: 180.2, lcp: { t: 420.7, el: "img#hero.banner" }, cls: 0.0312,
  long: [{ s: 200, d: 180 }, { s: 500, d: 60 }, { s: 10, d: 90 }], supported: ALL,
  resources: [
    { u: "http://localhost:3000/api/products", d: 240, s: 4096 },
    { u: "http://localhost:3000/static/hero.jpg", d: 120, s: 184320 },
    { u: "http://localhost:3000/static/app.js", d: 90, s: 52000 },
    { u: "data:image/png;base64,AAAA", d: 1, s: 0 },
  ],
};

test("rate follows the web.dev thresholds at the boundaries", () => {
  assert.equal(rate("lcp", 2500), "good");
  assert.equal(rate("lcp", 2501), "ni");
  assert.equal(rate("lcp", 4001), "poor");
  assert.equal(rate("cls", 0.1), "good");
  assert.equal(rate("cls", 0.26), "poor");
  assert.equal(rate("fcp", 1800), "good");
  assert.equal(rate("tbt", 600), "ni");
  assert.equal(rate("tbt", 601), "poor");
});

test("totalBlockingTime counts only the excess over 50 ms of tasks that end after FCP", () => {
  const t = totalBlockingTime(base.long, 180);
  assert.equal(t.tbt, 140, "(180-50) + (60-50); the 90 ms task ends at 100 ms, before FCP, and is ignored");
  assert.equal(t.count, 2);
  assert.equal(t.worst, 180);
  assert.equal(totalBlockingTime([], 100).tbt, 0);
  assert.equal(totalBlockingTime([{ s: 0, d: 80 }], null).tbt, 30, "without FCP every task counts");
});

test("formatPerf: one compact, readable summary with ratings, LCP element and request highlights", () => {
  const out = formatPerf(base, ctx);
  assert.match(out, /^Perf http:\/\/localhost:3000\/shop \(reloaded, chromium, cpu x1; one lab run, not Lighthouse\)/);
  assert.match(out, /TTFB 12 ms · FCP 180 ms ✓ · LCP 421 ms ✓ \(img#hero\.banner\) · CLS 0\.031 ✓ · TBT 140 ms ✓ \(2 long tasks, worst 180 ms\) · DCL 210 ms · load 640 ms/);
  assert.match(out, /4 requests · 235 KB transferred/);
  assert.match(out, /slowest: 240 ms \/api\/products · 120 ms \/static\/hero\.jpg · 90 ms \/static\/app\.js/);
  assert.match(out, /largest: 180 KB \/static\/hero\.jpg · 51 KB \/static\/app\.js/);
  assert.ok(!/data:image/.test(out), "tiny/fast resources are not listed");
  assert.match(out, /✓ good {2}~ needs work {2}✗ poor/);
});

test("formatPerf: poor values are marked, singular long task, no highlights when nothing is slow or large", () => {
  const out = formatPerf({ ...base, fcp: 3500, lcp: { t: 4500, el: "" }, cls: 0.4, long: [{ s: 4000, d: 900 }], resources: [{ u: "http://localhost:3000/a.js", d: 5, s: 100 }] }, ctx);
  assert.match(out, /FCP 3500 ms ✗/);
  assert.match(out, /LCP 4500 ms ✗/);
  assert.match(out, /CLS 0\.4 ✗/);
  assert.match(out, /TBT 850 ms ✗ \(1 long task, worst 900 ms\)/);
  assert.ok(!/slowest:|largest:/.test(out));
});

test("formatPerf: engines without LCP / layout-shift / longtask say so instead of inventing numbers", () => {
  const out = formatPerf({ ...base, lcp: null, cls: null, long: [], supported: ["paint", "navigation", "resource"] }, { ...ctx, engine: "firefox" });
  assert.ok(!/LCP|CLS \d|TBT \d/.test(out.split("\n")[1]));
  assert.match(out, /n\/a on firefox: LCP, CLS, TBT \(use chromium for all metrics\)/);
  assert.match(out, /TTFB 12 ms · FCP 180 ms ✓/);
});

test("formatPerf: LCP supported but none reported, and CPU throttle shown", () => {
  const out = formatPerf({ ...base, lcp: null }, { ...ctx, cpuSlowdown: 4 });
  assert.match(out, /LCP none/);
  assert.match(out, /cpu x4/);
});

test("the summary stays small even for a page with 300 requests", () => {
  const resources = Array.from({ length: 300 }, (_, i) => ({ u: `http://localhost:3000/static/chunk-${i}.js`, d: 10 + i, s: 1000 * i }));
  const out = formatPerf({ ...base, resources }, ctx);
  const tokens = estimateTextTokens(out);
  assert.ok(tokens < 260, `${tokens} tokens`);
  console.log(`      (300-request page summary ≈ ${tokens} tokens)`);
});
