/**
 * Token estimation without a tokenizer dependency. These are ESTIMATES meant for
 * relative comparison (did this change make output cheaper?), not billing.
 *
 *  - ASCII text: ~4 chars per token (override: AGENT_EYE_CHARS_PER_TOKEN).
 *  - Non-ASCII (CJK, emoji, …): ~1 token per code point — a 4-chars/token rule
 *    badly under-counts these.
 *  - Images: Anthropic's published rule of thumb, tokens ≈ width*height/750,
 *    with the long edge downscaled to 1568px (so ≈1,600 tokens at most).
 */
const DEFAULT_CHARS_PER_TOKEN = 4;
const MAX_IMAGE_TOKENS = 1600;
const MAX_LONG_EDGE = 1568;

function charsPerToken(): number {
  const v = Number(process.env.AGENT_EYE_CHARS_PER_TOKEN);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CHARS_PER_TOKEN;
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / charsPerToken()) + wide;
}

/** Reads width/height from a PNG or JPEG buffer; undefined if unrecognised. */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  // PNG: 8-byte signature, then IHDR with big-endian width/height at 16..24.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk segments until a Start-Of-Frame marker.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

export function estimateImageTokens(base64Data: string): number {
  const size = imageSize(Buffer.from(base64Data, "base64"));
  if (!size || size.width <= 0 || size.height <= 0) return MAX_IMAGE_TOKENS;
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(size.width, size.height));
  const tokens = Math.ceil((size.width * scale * size.height * scale) / 750);
  return Math.min(tokens, MAX_IMAGE_TOKENS);
}

type ContentBlock = { type: string; text?: string; data?: string };

/** Estimated tokens of an MCP tool result's content blocks. */
export function estimateResultTokens(content: ContentBlock[] | undefined): number {
  let total = 0;
  for (const block of content ?? []) {
    if (block.type === "text" && block.text) total += estimateTextTokens(block.text);
    else if (block.type === "image" && block.data) total += estimateImageTokens(block.data);
  }
  return total;
}
