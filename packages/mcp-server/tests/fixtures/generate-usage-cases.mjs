// Regenerate after an INTENTIONAL change to usage/estimate.ts:  npm run build && node tests/fixtures/generate-usage-cases.mjs
// (then review the diff: the Python port must produce the same numbers). Writes tests/fixtures/usage-cases.json,
// golden cases computed by the TypeScript reference; the Node and Python suites both execute them.
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url)); // packages/mcp-server/
const E = await import(pathToFileURL(root + "dist/usage/estimate.js").href);

const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString("base64");
};
/** Minimal JPEG: SOI, an APP0 segment, then SOF0 carrying the size. */
const jpeg = (w, h) => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt8(0xff, 0); sof.writeUInt8(0xc0, 1); sof.writeUInt16BE(17, 2); sof.writeUInt8(8, 4);
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof.writeUInt8(3, 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]).toString("base64");
};

const text = [
  "", "a", "abcd", "abcde", "hello world, this is ascii text", "x".repeat(1000),
  "你好，世界", "混合 mixed ascii 和中文 text", "emoji 😀 test 🎉", "é à ü ñ", "line1\nline2\n\tindented",
  JSON.stringify({ target: "e12", text: "hello", submit: true }),
].map((t) => ({ text: t, tokens: E.estimateTextTokens(t) }));

const images = [
  ["png 1280x800", png(1280, 800)], ["png 100x100", png(100, 100)], ["png 4000x3000 (downscaled)", png(4000, 3000)],
  ["png 1x1", png(1, 1)], ["png 0x0 (invalid)", png(0, 0)], ["jpeg 800x600", jpeg(800, 600)], ["jpeg 3000x2000", jpeg(3000, 2000)],
  ["not an image", Buffer.from("not an image at all").toString("base64")], ["empty", ""],
].map(([name, data]) => ({ name, data, tokens: E.estimateImageTokens(data) }));

const results = [
  [],
  [{ type: "text", text: "hello world" }],
  [{ type: "text", text: "Screenshot captured." }, { type: "image", data: png(1280, 800), mimeType: "image/png" }],
  [{ type: "text", text: "你好" }, { type: "text", text: "" }, { type: "image" }, { type: "resource" }],
].map((content) => ({ content, tokens: E.estimateResultTokens(content) }));

fs.writeFileSync(root + "tests/fixtures/usage-cases.json", JSON.stringify({ _comment: "Golden token estimates from the TypeScript reference (usage/estimate.ts); executed by the Node and Python suites.", text, images, results }, null, 1));
console.log("text", text.length, "images", images.length, "results", results.length);
