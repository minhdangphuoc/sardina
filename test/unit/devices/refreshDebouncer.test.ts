import * as assert from 'assert';
import { RefreshDebouncer, type DebouncerClock, type DebouncerHandle } from '../../../src/devices/refreshDebouncer';

/** Manual fake clock: `now` is a counter this test advances explicitly; `setTimeout` records callbacks it can fire on demand. */
function fakeClock() {
  let current = 0;
  const scheduled: { fn: () => void; disposed: boolean }[] = [];
  const clock: DebouncerClock = {
    now: () => current,
    setTimeout: (fn, _ms): DebouncerHandle => {
      const entry = { fn, disposed: false };
      scheduled.push(entry);
      return { dispose: () => (entry.disposed = true) };
    },
  };
  return {
    clock,
    advance(ms: number) {
      current += ms;
    },
    fireAllPending() {
      const pending = scheduled.splice(0, scheduled.length);
      for (const entry of pending) {
        if (!entry.disposed) entry.fn();
      }
    },
  };
}

describe('RefreshDebouncer (FR-6.7: at most 1 per 2s, immediate first call, coalesced follow-ups)', () => {
  it('fires immediately on the first call', () => {
    const { clock } = fakeClock();
    let fireCount = 0;
    const debouncer = new RefreshDebouncer(2000, () => fireCount++, clock);
    debouncer.trigger();
    assert.strictEqual(fireCount, 1);
  });

  it('coalesces rapid follow-up calls into a single trailing fire', () => {
    const fc = fakeClock();
    let fireCount = 0;
    const debouncer = new RefreshDebouncer(2000, () => fireCount++, fc.clock);
    debouncer.trigger();
    assert.strictEqual(fireCount, 1);

    fc.advance(100);
    debouncer.trigger();
    debouncer.trigger();
    debouncer.trigger();
    assert.strictEqual(fireCount, 1, 'no immediate second fire within the window');

    fc.fireAllPending();
    assert.strictEqual(fireCount, 2, 'exactly one trailing fire, not one per trigger() call');
  });

  it('fires immediately again once the interval has elapsed', () => {
    const fc = fakeClock();
    let fireCount = 0;
    const debouncer = new RefreshDebouncer(2000, () => fireCount++, fc.clock);
    debouncer.trigger();
    fc.advance(2000);
    debouncer.trigger();
    assert.strictEqual(fireCount, 2);
  });

  it('dispose() cancels a pending trailing fire', () => {
    const fc = fakeClock();
    let fireCount = 0;
    const debouncer = new RefreshDebouncer(2000, () => fireCount++, fc.clock);
    debouncer.trigger();
    fc.advance(100);
    debouncer.trigger();
    debouncer.dispose();
    fc.fireAllPending();
    assert.strictEqual(fireCount, 1, 'disposed debouncer must not fire the trailing call');
  });
});
