import { test } from "node:test";
import assert from "node:assert/strict";
import { findInSnapshot, limitDepth } from "../dist/browser/format.js";
import { estimateTextTokens } from "../dist/usage/estimate.js";

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
- contentinfo [ref=e15]:
  - text: © 2026`;

test("limitDepth keeps N levels and tells how to expand the cut subtrees", () => {
  const d1 = limitDepth(SNAP, 1);
  assert.equal(d1.split("\n").length, 3, "three top-level nodes");
  assert.match(d1, /- banner \[ref=e1\] …\(\+\d+ nodes, expand: selector=e1\)/);
  assert.match(d1, /- main \[ref=e9\] …\(\+\d+ nodes, expand: selector=e9\)/);
  assert.ok(!d1.includes("Pay now"));
  const d2 = limitDepth(SNAP, 2);
  assert.match(d2, /link "Home"/);
  assert.match(d2, /form "Payment" \[ref=e11\] …\(\+3 nodes, expand: selector=e11\)/);
  assert.ok(!d2.includes("Card number"));
  assert.equal(limitDepth(SNAP, 20), SNAP, "a depth larger than the tree changes nothing");
});

test("limitDepth does not count /url property lines as nodes", () => {
  assert.match(limitDepth(SNAP, 2), /link "Home" \[ref=e2\] \[cursor=pointer\]:?$/m, "a link whose only child is /url is not marked as cut");
});

test("findInSnapshot returns matches with their ancestor path", () => {
  const r = findInSnapshot(SNAP, "pay now");
  assert.equal(r, 'main > form "Payment" > button "Pay now" [ref=e13]');
  assert.equal(findInSnapshot(SNAP, "SHOP"), 'banner > navigation "Main" > list > listitem > link "Shop" [ref=e6] → /shop');
});

test("findInSnapshot matches roles too, caps results and reports misses", () => {
  const buttons = findInSnapshot(SNAP, "button").split("\n");
  assert.equal(buttons.length, 2);
  assert.match(findInSnapshot(SNAP, "link", 2), /… 1 more matches; refine the query/);
  assert.equal(findInSnapshot(SNAP, "zzz"), '(no elements match "zzz")');
  assert.equal(findInSnapshot(SNAP, "  "), "(empty find query)");
});

test("depth and find are far cheaper than the full tree on a large page", () => {
  const rows = Array.from({ length: 300 }, (_, i) => `    - listitem [ref=e${100 + i * 2}]:\n      - link "Product ${i}" [ref=e${101 + i * 2}] [cursor=pointer]:\n        - /url: /p/${i}`).join("\n");
  const big = `- main [ref=e1]:\n  - list "Products" [ref=e2]:\n${rows}\n  - button "Checkout" [ref=e9999] [cursor=pointer]`;
  const full = estimateTextTokens(big);
  const shallow = estimateTextTokens(limitDepth(big, 2));
  const found = estimateTextTokens(findInSnapshot(big, "checkout"));
  assert.ok(shallow < full * 0.05, `depth=2 ${shallow} vs full ${full}`);
  assert.ok(found < full * 0.02, `find ${found} vs full ${full}`);
  assert.match(findInSnapshot(big, "checkout"), /main > button "Checkout" \[ref=e9999\]/);
  console.log(`      (synthetic 300-product page: full ${full} tokens, depth=2 ${shallow}, find ${found})`);
});
