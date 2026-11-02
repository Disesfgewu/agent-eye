import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  estimateTextTokens,
  estimateImageTokens,
  estimateResultTokens,
  imageSize,
} from "../dist/usage/estimate.js";
import { UsageLedger } from "../dist/usage/ledger.js";

function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width, height) {
  // SOI, APP0(len 16), SOF0 with height/width.
  const b = Buffer.alloc(2 + 18 + 19);
  b[0] = 0xff; b[1] = 0xd8;
  b[2] = 0xff; b[3] = 0xe0; b.writeUInt16BE(16, 4);
  const sof = 20;
  b[sof] = 0xff; b[sof + 1] = 0xc0; b.writeUInt16BE(17, sof + 2);
  b[sof + 4] = 8;
  b.writeUInt16BE(height, sof + 5);
  b.writeUInt16BE(width, sof + 7);
  return b;
}

test("estimateTextTokens: ascii ~4 chars/token, empty is 0", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("a".repeat(400)), 100);
});

test("estimateTextTokens: non-ASCII counts ~1 token per code point", () => {
  assert.equal(estimateTextTokens("按鈕沒有作用"), 6);
});

test("imageSize parses PNG and JPEG headers", () => {
  assert.deepEqual(imageSize(png(1280, 800)), { width: 1280, height: 800 });
  assert.deepEqual(imageSize(jpeg(640, 480)), { width: 640, height: 480 });
  assert.equal(imageSize(Buffer.from("nope")), undefined);
});

test("estimateImageTokens: w*h/750, capped, unknown format falls back to cap", () => {
  assert.equal(estimateImageTokens(png(750, 100).toString("base64")), 100);
  assert.equal(estimateImageTokens(png(1280, 800).toString("base64")), Math.ceil((1280 * 800) / 750));
  assert.equal(estimateImageTokens(png(8000, 8000).toString("base64")), 1600);
  assert.equal(estimateImageTokens(Buffer.from("garbage").toString("base64")), 1600);
});

test("estimateResultTokens sums text and image blocks", () => {
  const t = estimateResultTokens([
    { type: "text", text: "a".repeat(40) },
    { type: "image", data: png(750, 100).toString("base64") },
  ]);
  assert.equal(t, 10 + 100);
  assert.equal(estimateResultTokens(undefined), 0);
});

test("UsageLedger aggregates per tool and renders a report", () => {
  const l = new UsageLedger();
  l.setToolDefinitionOverhead(1500, 15);
  l.record("browser_snapshot", 5, 1000, 10, true);
  l.record("browser_snapshot", 5, 3000, 20, true);
  l.record("browser_click", 8, 12, 5, false);
  const s = l.summary();
  assert.equal(s.totals.calls, 3);
  assert.equal(s.totals.errors, 1);
  assert.equal(s.totals.outTokens, 4012);
  assert.equal(s.tools.browser_snapshot.maxOutTokens, 3000);
  const r = l.report();
  assert.match(r, /~1,500 tokens, 15 tools/);
  assert.match(r, /browser_snapshot \| 2 \| 4,000 \| 2,000 \| 3,000 \| 0/);
  // sorted by output cost, heaviest first
  assert.ok(r.indexOf("browser_snapshot |") < r.indexOf("browser_click |"));
});

test("UsageLedger.flush writes usage.json + history, and skips empty sessions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-usage-"));
  try {
    new UsageLedger(dir).flush();
    assert.equal(fs.existsSync(path.join(dir, "usage-history.jsonl")), false);

    const l = new UsageLedger(dir);
    l.record("browser_snapshot", 1, 2, 3, true);
    l.flush();
    const cur = JSON.parse(fs.readFileSync(path.join(dir, "usage.json"), "utf8"));
    assert.equal(cur.totals.calls, 1);
    const hist = fs.readFileSync(path.join(dir, "usage-history.jsonl"), "utf8").trim().split("\n");
    assert.equal(hist.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
