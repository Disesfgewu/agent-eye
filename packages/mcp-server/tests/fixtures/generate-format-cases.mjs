// Regenerate after an INTENTIONAL change to browser/format.ts:  npm run build && node tests/fixtures/generate-format-cases.mjs
// (then review the diff: the Python port must produce the same output). Generates tests/fixtures/format-cases.json: golden cases computed by the TypeScript reference
// implementation (browser/format.ts). The Node and Python test-suites both execute this file.
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url)); // packages/mcp-server/
const F = await import(pathToFileURL(root + "dist/browser/format.js").href);
const R = await import(pathToFileURL(root + "dist/security/redaction.js").href);

const SNAP = `- banner [ref=e1]:
  - link "Home" [ref=e2] [cursor=pointer]:
    - /url: /
  - navigation "Main" [ref=e3]:
    - list [ref=e4]:
      - listitem [ref=e5]:
        - link "Shop" [ref=e6] [cursor=pointer]:
          - /url: /shop
      - listitem [ref=e7]:
        - link "Blog" [ref=e8] [cursor=pointer]:
          - /url: /blog
- main [ref=e9]:
  - heading "Checkout" [level=1] [ref=e10]
  - form "Payment" [ref=e11]:
    - textbox "Card number" [ref=e12]
    - button "Pay now" [ref=e13] [cursor=pointer]
    - button "Cancel" [ref=e14] [cursor=pointer]
    - generic [ref=e20] [cursor=pointer]: Click me (div button)
- dialog "Confirm" [ref=e16]:
  - button "OK" [ref=e17]
- contentinfo [ref=e15]:
  - text: © 2026`;
const SNAP2 = SNAP.replace('button "Cancel" [ref=e14] [cursor=pointer]', 'button "Back" [ref=e14] [cursor=pointer]') + '\n- alert [ref=e30]: Saved';
const EMPTY = "- generic [ref=e1]";
const QUOTED = '- main [ref=e1]:\n  - button "Say \\"hi\\"" [ref=e2]:\n  - button "plain" [ref=e3]';

const con = (type, text, epoch = 1, location) => ({ type, text, epoch, ...(location ? { location } : {}) });
const CONSOLE = [
  con("error", "Uncaught TypeError: x is undefined", 1, "http://localhost:3000/app.js:10:5"),
  con("log", "hello"), con("log", "hello"), con("log", "hello"),
  con("warning", "deprecated API", 1, "http://localhost:3000/lib.js:2:1"),
  con("error", "Failed to load resource: 404", 1, "http://localhost:3000/missing.png:0:0"),
  con("error", "Uncaught TypeError: x is undefined", 1, "http://localhost:3000/app.js:10:5"),
  con("dialog", "confirm: Delete?"), con("popup", "opened http://localhost:3000/pop"),
  con("warn", "legacy warn spelling"),
];
const net = (method, url, status, resourceType, epoch = 1, failure) => ({ method, url, status, resourceType, epoch, ...(failure ? { failure } : {}) });
const NETWORK = [
  net("GET", "http://localhost:3000/", 200, "document"),
  net("GET", "http://localhost:3000/app.js", 200, "script"),
  net("GET", "http://localhost:3000/style.css", 200, "stylesheet"),
  net("GET", "http://localhost:3000/logo.png", 200, "image"),
  net("GET", "http://localhost:3000/api/items?token=SECRET123&page=1", 200, "fetch"),
  net("GET", "http://localhost:3000/api/items?token=SECRET123&page=1", 200, "fetch"),
  net("POST", "http://localhost:3000/api/login", 401, "xhr"),
  net("GET", "http://localhost:3000/missing.js", 404, "script"),
  net("GET", "https://cdn.example.com/lib.js", 0, "script", 1, "net::ERR_NAME_NOT_RESOLVED"),
  net("GET", "http://localhost:3000/api/slow", 500, "fetch"),
];

const cases = [];
const add = (name, fn, args, expect) => cases.push({ name, fn, args, expect });
const redactors = { identity: (u) => u, secrets: (u) => R.redactText(u, true) };

// snapshots
for (const [label, snap] of [["tree", SNAP], ["tree2", SNAP2], ["empty", EMPTY], ["escaped-quotes", QUOTED]]) {
  add(`filterInteractive: ${label}`, "filterInteractive", [snap], F.filterInteractive(snap));
}
for (const d of [1, 2, 3, 20]) add(`limitDepth: depth ${d}`, "limitDepth", [SNAP, d], F.limitDepth(SNAP, d));
add("limitDepth: escaped quotes", "limitDepth", [QUOTED, 1], F.limitDepth(QUOTED, 1));
for (const q of ["pay now", "BUTTON", "shop", "e13", "zzz", "  ", "dialog", "ok", "click me"]) add(`findInSnapshot: "${q}"`, "findInSnapshot", [SNAP, q], F.findInSnapshot(SNAP, q));
add("findInSnapshot: limit 2", "findInSnapshot", [SNAP, "button", 2], F.findInSnapshot(SNAP, "button", 2));
add("findInSnapshot: escaped quotes", "findInSnapshot", [QUOTED, "hi"], F.findInSnapshot(QUOTED, "hi"));
add("diffSnapshots: changed", "diffSnapshots", [SNAP, SNAP2], F.diffSnapshots(SNAP, SNAP2) ?? null);
add("diffSnapshots: identical", "diffSnapshots", [SNAP, SNAP], F.diffSnapshots(SNAP, SNAP) ?? null);
add("diffSnapshots: duplicate lines", "diffSnapshots", ["- a\n- a\n- b", "- a\n- b\n- b"], F.diffSnapshots("- a\n- a\n- b", "- a\n- b\n- b") ?? null);
add("truncateText: fits", "truncateText", ["short", 100, "hint"], F.truncateText("short", 100, "hint"));
const longText = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
add("truncateText: cut at a line boundary", "truncateText", [longText, 300, "Narrow it."], F.truncateText(longText, 300, "Narrow it."));
add("truncateText: no newline to cut at", "truncateText", ["y".repeat(500), 100, "h"], F.truncateText("y".repeat(500), 100, "h"));

// element handles (Playwright >= 1.64 prefixes the frame: f1e12)
for (const t of ["e12", "ref=e12", "aria-ref=f1e12", " f2e3 ", "button", "#e12", "e", "f1", "e12x", "css=.e1", "ref=", "xe12"]) add(`parseRef: ${JSON.stringify(t)}`, "parseRef", [t], F.parseRef(t) ?? null);
const SNAPF = SNAP.replace(/\[ref=e(\d+)\]/g, "[ref=f1e$1]");
add("limitDepth: frame-prefixed refs", "limitDepth", [SNAPF, 2], F.limitDepth(SNAPF, 2));

// console
add("formatConsole: everything", "formatConsole", [CONSOLE, { limit: 50, origin: "http://localhost:3000" }], F.formatConsole(CONSOLE, { limit: 50, origin: "http://localhost:3000" }));
add("formatConsole: errors only", "formatConsole", [CONSOLE, { types: ["error"], limit: 50 }], F.formatConsole(CONSOLE, { types: ["error"], limit: 50 }));
add("formatConsole: warn alias", "formatConsole", [CONSOLE, { types: ["warn"], limit: 50 }], F.formatConsole(CONSOLE, { types: ["warn"], limit: 50 }));
add("formatConsole: limit 2 keeps the most recent distinct", "formatConsole", [CONSOLE, { limit: 2 }], F.formatConsole(CONSOLE, { limit: 2 }));
add("formatConsole: none", "formatConsole", [[], { limit: 5 }], F.formatConsole([], { limit: 5 }));
add("formatConsole: type filter with no match", "formatConsole", [CONSOLE, { types: ["debug"], limit: 5 }], F.formatConsole(CONSOLE, { types: ["debug"], limit: 5 }));

// network
const o = "http://localhost:3000";
const netCase = (name, opts, redactor = "identity") => add(`formatNetwork: ${name}`, "formatNetwork", [NETWORK, { ...opts, redact: redactor }], F.formatNetwork(NETWORK, { ...opts, redact: redactors[redactor] }));
netCase("default hides static assets", { limit: 100, origin: o });
netCase("failed only", { limit: 100, origin: o, failedOnly: true });
netCase("include static", { limit: 100, origin: o, includeStatic: true });
netCase("url filter", { limit: 100, origin: o, urlContains: "API" });
netCase("limit 2", { limit: 2, origin: o });
netCase("no origin", { limit: 100 });
netCase("secrets redacted", { limit: 100, origin: o, includeStatic: true }, "secrets");
add("formatNetwork: nothing matches", "formatNetwork", [NETWORK, { limit: 5, urlContains: "zzz", redact: "identity" }], F.formatNetwork(NETWORK, { limit: 5, urlContains: "zzz", redact: redactors.identity }));
add("selectNetwork: counts hidden static", "selectNetwork", [NETWORK, { limit: 5, redact: "identity" }], (({ shown, hiddenStatic }) => ({ shown, hiddenStatic }))(F.selectNetwork(NETWORK, { limit: 5, redact: redactors.identity })));

// health
add("formatHealth: errors and failures", "formatHealth", [{ url: o + "/", title: "Shop", console: CONSOLE, network: NETWORK, origin: o, redact: "identity" }], F.formatHealth({ url: o + "/", title: "Shop", console: CONSOLE, network: NETWORK, origin: o, redact: redactors.identity }));
add("formatHealth: warnings only", "formatHealth", [{ url: o + "/", title: "", console: [con("warning", "w1"), con("log", "l")], network: [net("GET", o + "/", 200, "document")], origin: o, redact: "identity" }], F.formatHealth({ url: o + "/", title: "", console: [con("warning", "w1"), con("log", "l")], network: [net("GET", o + "/", 200, "document")], origin: o, redact: redactors.identity }));
add("formatHealth: clean page", "formatHealth", [{ url: o + "/", title: "OK", console: [], network: [net("GET", o + "/", 200, "document")], redact: "identity" }], F.formatHealth({ url: o + "/", title: "OK", console: [], network: [net("GET", o + "/", 200, "document")], redact: redactors.identity }));

fs.writeFileSync(root + "tests/fixtures/format-cases.json", JSON.stringify({ _comment: "Golden cases from the TypeScript reference (browser/format.ts); executed by the Node and Python suites. redact: 'identity' | 'secrets' (security/redaction redactText).", cases }, null, 1));
console.log("cases:", cases.length);
