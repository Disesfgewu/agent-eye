// Regenerate after an INTENTIONAL change to security/state-guard.ts or browser/perf.ts:
//   npm run build && node tests/fixtures/generate-state-perf-cases.mjs
// (then review the diff: the Python port must produce the same output). Writes state-cases.json and perf-cases.json,
// golden cases computed by the TypeScript reference; the Node and Python suites both execute them.
// perf-cases.json also carries the two JS snippets injected into pages, so the Python copies cannot drift.
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url)); // packages/mcp-server/
const S = await import(pathToFileURL(root + "dist/security/state-guard.js").href);
const P = await import(pathToFileURL(root + "dist/browser/perf.js").href);

const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const storage = [
  ["valid cookie + localStorage", { cookies: [{ name: "sid", value: "abc123", httpOnly: true, sameSite: "Lax" }], localStorage: { token: "x.y.z" } }],
  ["empty input", {}],
  ["bad cookie name (space)", { cookies: [{ name: "bad name", value: "v" }] }],
  ["empty cookie name", { cookies: [{ name: "", value: "v" }] }],
  ["cookie name too long", { cookies: [{ name: "n".repeat(129), value: "v" }] }],
  ["value smuggles attributes", { cookies: [{ name: "a", value: "v; Domain=evil.com" }] }],
  ["value with comma", { cookies: [{ name: "a", value: "v,w" }] }],
  ["value with quote", { cookies: [{ name: "a", value: 'v"w' }] }],
  ["value with backslash", { cookies: [{ name: "a", value: "v\w" }] }],
  ["value with CRLF", { cookies: [{ name: "a", value: "v\r\nSet-Cookie: b=c" }] }],
  ["value with a tab", { cookies: [{ name: "a", value: "v\tw" }] }],
  ["value too long", { cookies: [{ name: "a", value: "x".repeat(4097) }] }],
  ["value at the limit", { cookies: [{ name: "a", value: "x".repeat(4096) }] }],
  ["path with a space", { cookies: [{ name: "a", value: "v", path: "/a b" }] }],
  ["path not starting with /", { cookies: [{ name: "a", value: "v", path: "app" }] }],
  ["valid path", { cookies: [{ name: "a", value: "v", path: "/app/v1.2-x~y%20" }] }],
  ["SameSite=None without secure", { cookies: [{ name: "a", value: "v", sameSite: "None" }] }],
  ["SameSite=None with secure", { cookies: [{ name: "a", value: "v", sameSite: "None", secure: true }] }],
  ["31 cookies", { cookies: many(31, (i) => ({ name: `c${i}`, value: "v" })) }],
  ["30 cookies", { cookies: many(30, (i) => ({ name: `c${i}`, value: "v" })) }],
  ["empty localStorage key", { localStorage: { "": "v" } }],
  ["localStorage key too long", { localStorage: { ["k".repeat(129)]: "v" } }],
  ["sessionStorage value too long", { sessionStorage: { k: "x".repeat(8193) } }],
  ["51 localStorage entries", { localStorage: Object.fromEntries(many(51, (i) => [`k${i}`, "v"])) }],
  ["50 sessionStorage entries", { sessionStorage: Object.fromEntries(many(50, (i) => [`k${i}`, "v"])) }],
].map(([name, input]) => ({ name, input, expect: S.storageInputProblem(input) ?? null }));

fs.writeFileSync(root + "tests/fixtures/state-cases.json", JSON.stringify({ _comment: "Golden cases from the TypeScript reference (security/state-guard.ts storageInputProblem); executed by the Node and Python suites.", storage }, null, 1));

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
const lots = many(300, (i) => ({ u: `http://localhost:3000/static/chunk-${i}.js`, d: 10 + i, s: 1000 * i }));
const longName = { ...base, lcp: { t: 900, el: "div#" + "x".repeat(60) } };
const perf = [
  ["full chromium report", base, ctx],
  ["poor values", { ...base, fcp: 3500, lcp: { t: 4500, el: "" }, cls: 0.4, long: [{ s: 4000, d: 900 }], resources: [{ u: "http://localhost:3000/a.js", d: 5, s: 100 }] }, ctx],
  ["needs-work values", { ...base, fcp: 2000, lcp: { t: 3000, el: "p" }, cls: 0.15, long: [{ s: 500, d: 400 }] }, ctx],
  ["firefox without LCP / CLS / longtask", { ...base, lcp: null, cls: null, long: [], supported: ["paint", "navigation", "resource"] }, { ...ctx, engine: "firefox" }],
  ["LCP supported but none reported, cpu x4", { ...base, lcp: null }, { ...ctx, cpuSlowdown: 4 }],
  ["300 requests", { ...base, resources: lots }, ctx],
  ["long LCP element name is shortened", longName, ctx],
  ["navigated, no timing entries", { ttfb: null, dcl: null, load: null, fcp: null, lcp: null, cls: 0, long: [], supported: ALL, resources: [] }, { ...ctx, how: "navigated" }],
  ["CLS 0 and exact thresholds", { ...base, cls: 0, fcp: 1800, lcp: { t: 2500, el: "h1" }, long: [{ s: 300, d: 250 }] }, ctx],
  ["cross-origin and data: URLs", { ...base, resources: [{ u: "https://cdn.example.com/lib.js?v=" + "9".repeat(100), d: 300, s: 90000 }, { u: "data:image/svg+xml;base64," + "A".repeat(80), d: 80, s: 20000 }] }, ctx],
].map(([name, raw, c]) => ({ name, raw, ctx: c, expect: P.formatPerf(raw, c) }));
const tbt = [
  [[{ s: 200, d: 180 }, { s: 500, d: 60 }, { s: 10, d: 90 }], 180], [[], 100], [[{ s: 0, d: 80 }], null], [[{ s: 0, d: 40 }], null], [[{ s: 100, d: 51 }], 100],
].map(([long, fcp]) => ({ long, fcp, expect: P.totalBlockingTime(long, fcp) }));
const rates = ["fcp", "lcp", "cls", "tbt"].flatMap((m) => [0, 0.1, 0.25, 200, 600, 1800, 2500, 3000, 4000, 5000].map((v) => ({ metric: m, value: v, expect: P.rate(m, v) })));

fs.writeFileSync(root + "tests/fixtures/perf-cases.json", JSON.stringify({
  _comment: "Golden cases from the TypeScript reference (browser/perf.ts); executed by the Node and Python suites.",
  initScript: P.PERF_INIT_SCRIPT, collectScript: P.PERF_COLLECT_SCRIPT, perf, tbt, rates,
}, null, 1));
console.log("storage", storage.length, "perf", perf.length, "tbt", tbt.length, "rates", rates.length);
