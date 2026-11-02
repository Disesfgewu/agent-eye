import { createHash } from "node:crypto";

/**
 * Remembers the last screenshot per (page, scope) so `browser_screenshot ifChanged` can answer
 * "unchanged" in one line instead of re-sending an image (~1.4k tokens each). Equality is exact
 * (SHA-256 of the PNG bytes); the capture runs with animations and the caret frozen so a static page
 * is byte-stable. A page with a live clock, video or running animation is simply always "changed".
 */
export interface ShotMemory {
  hash: string;
  at: number;
  rel: string;
}

export class ScreenshotMemory {
  private readonly entries = new Map<string, ShotMemory>();

  constructor(private readonly capacity = 20) {}

  static hash(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
  }

  /** The previous shot for `key` when `buffer` is byte-identical to it; otherwise undefined. */
  unchanged(key: string, buffer: Buffer): ShotMemory | undefined {
    const prev = this.entries.get(key);
    return prev && prev.hash === ScreenshotMemory.hash(buffer) ? prev : undefined;
  }

  remember(key: string, buffer: Buffer, rel: string, now = Date.now()): void {
    this.entries.delete(key); // refresh insertion order (LRU)
    this.entries.set(key, { hash: ScreenshotMemory.hash(buffer), at: now, rel });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as string);
  }

  /** Marks a still-identical shot as freshly seen (so "since" reflects the last time it was confirmed). */
  touch(key: string, now = Date.now()): void {
    const prev = this.entries.get(key);
    if (prev) prev.at = now;
  }
}
