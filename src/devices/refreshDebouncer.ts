/**
 * FR-6.7: debounces manual refreshes to at most 1 per `intervalMs`, firing
 * immediately on the first call and coalescing any follow-up calls made
 * within the window into a single trailing call. No `vscode` import so this
 * can be unit-tested directly under plain mocha with an injected clock.
 */
export interface DebouncerHandle {
  dispose(): void;
}

export interface DebouncerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): DebouncerHandle;
}

const realClock: DebouncerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return { dispose: () => clearTimeout(handle) };
  },
};

export class RefreshDebouncer {
  private lastFire = -Infinity;
  private pending: DebouncerHandle | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly fire: () => void,
    private readonly clock: DebouncerClock = realClock,
  ) {}

  trigger(): void {
    const now = this.clock.now();
    const elapsed = now - this.lastFire;
    if (elapsed >= this.intervalMs) {
      this.lastFire = now;
      this.fire();
      return;
    }
    if (this.pending) {
      return;
    }
    const wait = this.intervalMs - elapsed;
    this.pending = this.clock.setTimeout(() => {
      this.pending = undefined;
      this.lastFire = this.clock.now();
      this.fire();
    }, wait);
  }

  dispose(): void {
    this.pending?.dispose();
    this.pending = undefined;
  }
}
