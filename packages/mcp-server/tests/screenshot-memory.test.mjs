import { test } from "node:test";
import assert from "node:assert/strict";
import { ScreenshotMemory } from "../dist/browser/screenshot-memory.js";
import { estimateImageTokens, estimateTextTokens } from "../dist/usage/estimate.js";

const png = (n) => Buffer.from(`fake-png-${n}`);

test("identical bytes for the same key are reported unchanged; different bytes or keys are not", () => {
  const m = new ScreenshotMemory();
  assert.equal(m.unchanged("k", png(1)), undefined, "nothing remembered yet");
  m.remember("k", png(1), "screenshots/a.png", 1000);
  const same = m.unchanged("k", png(1));
  assert.equal(same?.rel, "screenshots/a.png");
  assert.equal(same?.at, 1000);
  assert.equal(m.unchanged("k", png(2)), undefined, "different pixels");
  assert.equal(m.unchanged("other", png(1)), undefined, "different page/scope");
});

test("touch refreshes the 'seen' time; remember replaces the old shot", () => {
  const m = new ScreenshotMemory();
  m.remember("k", png(1), "a.png", 1000);
  m.touch("k", 5000);
  assert.equal(m.unchanged("k", png(1))?.at, 5000);
  m.remember("k", png(2), "b.png", 6000);
  assert.equal(m.unchanged("k", png(1)), undefined);
  assert.equal(m.unchanged("k", png(2))?.rel, "b.png");
});

test("memory is bounded (least recently remembered entries are dropped)", () => {
  const m = new ScreenshotMemory(3);
  for (let i = 0; i < 5; i++) m.remember(`k${i}`, png(i), `s${i}.png`);
  assert.equal(m.unchanged("k0", png(0)), undefined);
  assert.equal(m.unchanged("k1", png(1)), undefined);
  assert.ok(m.unchanged("k4", png(4)));
});

test("an 'unchanged' reply is orders of magnitude cheaper than resending a 1280x800 image", () => {
  const reply = "Screenshot unchanged since 12s ago (identical to .agent-artifacts/screenshots/1-page-ab12.png); image not resent.";
  // minimal PNG header carrying 1280x800 (what the ledger's estimator reads)
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  const image = estimateImageTokens(header.toString("base64"));
  const text = estimateTextTokens(reply);
  assert.ok(text * 20 < image, `${text} vs ${image}`);
  console.log(`      (1280x800 image ≈ ${image} tokens; unchanged reply ≈ ${text})`);
});
