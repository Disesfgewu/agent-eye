import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterInteractive,
  truncateText,
  diffSnapshots,
  formatConsole,
  formatNetwork,
  selectNetwork,
} from "../dist/browser/format.js";

const SNAP = `- generic [active] [ref=e1]:
  - heading "Store" [level=1] [ref=e2]
  - navigation [ref=e3]:
    - link "Home" [ref=e4] [cursor=pointer]:
      - /url: /
  - paragraph [ref=e6]: Welcome to the store, great deals.
  - list [ref=e7]:
    - listitem [ref=e8]:
      - link "Product 1" [ref=e9] [cursor=pointer]:
        - /url: /p/1
      - button "Add 1" [ref=e10]
  - generic [ref=e20] [cursor=pointer]: Clickable div
  - textbox "search" [ref=e14]
  - combobox [ref=e15]:
    - option "a" [selected]`;

test("filterInteractive keeps actionable elements, drops structure/prose, inlines hrefs", () => {
  const out = filterInteractive(SNAP).split("\n");
  assert.deepEqual(out, [
    'heading "Store" [level=1] [ref=e2]',
    'link "Home" [ref=e4] → /',
    'link "Product 1" [ref=e9] → /p/1',
    'button "Add 1" [ref=e10]',
    'generic [ref=e20] [cursor=pointer]: Clickable div',
    'textbox "search" [ref=e14]',
    "combobox [ref=e15]",
  ]);
  assert.ok(!out.join("\n").includes("Welcome to the store"));
});

test("filterInteractive on an empty/canvas snapshot returns empty string", () => {
  assert.equal(filterInteractive(""), "");
});

test("truncateText: untouched when short, cut at a line boundary with a marker when long", () => {
  assert.deepEqual(truncateText("abc", 10, "hint"), { text: "abc", truncated: false });
  const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const r = truncateText(long, 100, "narrow it");
  assert.equal(r.truncated, true);
  assert.match(r.text, /… truncated \d+ chars\. narrow it$/);
  assert.ok(r.text.length < long.length);
  assert.ok(!/line \d+\n… truncated/.test(r.text) || r.text.split("\n").every((l) => l.length < 60));
});

test("diffSnapshots: reports added/removed lines, undefined when identical", () => {
  const a = "- button \"A\" [ref=e1]\n- button \"B\" [ref=e2]";
  const b = "- button \"B\" [ref=e2]\n- button \"C\" [ref=e3]";
  assert.equal(diffSnapshots(a, a), undefined);
  assert.equal(diffSnapshots(a, b), '- - button "A" [ref=e1]\n+ - button "C" [ref=e3]');
});

const con = (type, text, epoch = 1, location) => ({ type, text, epoch, location });

test("formatConsole: filters types (warn alias), collapses duplicates, strips origin", () => {
  const entries = [
    con("error", "boom"),
    con("error", "boom"),
    con("log", "hi"),
    con("warning", "careful", 1, "http://localhost:3000/app.js:1:2"),
  ];
  const out = formatConsole(entries, { types: ["error", "warn"], limit: 50, origin: "http://localhost:3000" });
  assert.equal(out, "[error] boom  ×2\n[warning] careful  (/app.js:1:2)");
  assert.equal(formatConsole([], { limit: 5 }), "(no console messages)");
});

test("formatConsole: limit keeps most recent distinct and says how many were omitted", () => {
  const entries = ["a", "b", "c", "d"].map((t) => con("log", t));
  const out = formatConsole(entries, { limit: 2 });
  assert.equal(out, "(2 older distinct messages omitted; raise limit)\n[log] c\n[log] d");
});

const net = (method, url, status, resourceType, extra = {}) => ({ method, url, status, resourceType, epoch: 1, ...extra });
const O = "http://localhost:3000";
const base = { limit: 100, origin: O, redact: (u) => u.replace(/token=[^&]+/, "token=<redacted>") };

test("formatNetwork: one compact line per request, static hidden unless failed", () => {
  const entries = [
    net("GET", `${O}/`, 200, "document"),
    net("GET", `${O}/static/a.js`, 200, "script"),
    net("GET", `${O}/static/missing.js`, 404, "script"),
    net("GET", `${O}/api/products?token=abc`, 200, "fetch"),
    net("GET", `${O}/api/products?token=abc`, 200, "fetch"),
    net("POST", `${O}/api/order`, 0, "fetch", { failure: "net::ERR_FAILED" }),
  ];
  const out = formatNetwork(entries, base);
  assert.equal(
    out,
    [
      "GET 200 document /",
      "GET 404 script /static/missing.js",
      "GET 200 fetch /api/products?token=<redacted>  ×2",
      "POST FAILED(net::ERR_FAILED) fetch /api/order",
      "(1 static assets hidden (ok); pass includeStatic to see them)",
    ].join("\n")
  );
});

test("formatNetwork: failedOnly, urlContains and includeStatic filters", () => {
  const entries = [
    net("GET", `${O}/a.png`, 200, "image"),
    net("GET", `${O}/api/x`, 500, "xhr"),
    net("GET", `${O}/api/y`, 200, "xhr"),
  ];
  assert.equal(formatNetwork(entries, { ...base, failedOnly: true }), "GET 500 xhr /api/x");
  assert.equal(formatNetwork(entries, { ...base, urlContains: "API/Y" }), "GET 200 xhr /api/y");
  assert.match(formatNetwork(entries, { ...base, includeStatic: true }), /GET 200 image \/a\.png/);
  assert.equal(formatNetwork(entries, { ...base, urlContains: "zzz" }), "(no matching requests)");
});

test("selectNetwork counts hidden static assets", () => {
  const r = selectNetwork([net("GET", `${O}/a.css`, 200, "stylesheet"), net("GET", `${O}/b`, 200, "fetch")], base);
  assert.equal(r.hiddenStatic, 1);
  assert.equal(r.shown.length, 1);
});

import { formatHealth } from "../dist/browser/format.js";

test("formatHealth: summarizes status, console and failures in a few lines", () => {
  const out = formatHealth({
    url: "http://localhost:3000/",
    title: "Shop",
    origin: "http://localhost:3000",
    redact: (u) => u,
    console: [con("error", "TypeError: x"), con("error", "TypeError: x"), con("warning", "w"), con("log", "hi")],
    network: [
      net("GET", "http://localhost:3000/", 200, "document"),
      net("GET", "http://localhost:3000/api/productz", 404, "fetch"),
      net("GET", "http://localhost:3000/a.js", 200, "script"),
    ],
  });
  assert.equal(
    out,
    [
      "URL: http://localhost:3000/",
      "Title: Shop   Document: 200",
      "Console: 2 error(s), 1 warning(s)",
      "[error] TypeError: x  ×2",
      "Network: 1 failed of 3 request(s)",
      "GET 404 fetch /api/productz",
    ].join("\n")
  );
});

test("formatHealth: healthy page is just a few lines", () => {
  const out = formatHealth({ url: "u", title: "", redact: (x) => x, console: [], network: [net("GET", "u", 200, "document")] });
  assert.equal(out, "URL: u\nTitle: (none)   Document: 200\nConsole: 0 error(s), 0 warning(s)\nNetwork: 0 failed of 1 request(s)");
});
