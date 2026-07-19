/** Fixed-capacity FIFO buffer; oldest entries drop when full. Keeps console and
 * network capture bounded so a chatty page can't grow memory without limit. */
export class RingBuffer<T> {
  private items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  /** Returns up to `limit` most-recent items (all of them if limit omitted). */
  recent(limit?: number): T[] {
    if (limit === undefined || limit >= this.items.length) return [...this.items];
    return this.items.slice(this.items.length - limit);
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}
