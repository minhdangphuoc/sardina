/** Adds one item and keeps only the newest `limit` entries. */
export function pushBounded<T>(values: T[], value: T, limit: number): void {
  if (limit < 1) return;
  const remove = values.length - limit + 1;
  if (remove > 0) values.splice(0, remove);
  values.push(value);
}

/** A Set that forgets its oldest distinct values once it reaches `limit`. */
export class BoundedSet<T> implements Iterable<T> {
  private readonly values = new Set<T>();

  constructor(private readonly limit: number) {}

  add(value: T): void {
    if (this.limit < 1 || this.values.has(value)) return;
    this.values.add(value);
    if (this.values.size > this.limit) {
      const oldest = this.values.values().next();
      if (!oldest.done) this.values.delete(oldest.value);
    }
  }

  has(value: T): boolean {
    return this.values.has(value);
  }

  [Symbol.iterator](): Iterator<T> {
    return this.values[Symbol.iterator]();
  }
}

/** Callbacks waiting for one event; settled callbacks remove themselves before that event. */
export class CallbackSet {
  private readonly callbacks = new Set<() => void>();

  add(callback: () => void): void {
    this.callbacks.add(callback);
  }

  delete(callback: () => void): void {
    this.callbacks.delete(callback);
  }

  drain(): void {
    const pending = [...this.callbacks];
    this.callbacks.clear();
    for (const callback of pending) callback();
  }

  get size(): number {
    return this.callbacks.size;
  }
}
