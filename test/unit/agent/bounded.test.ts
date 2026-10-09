import * as assert from 'assert';
import { BoundedSet, CallbackSet, pushBounded } from '../../../src/core/bounded';

describe('bounded retention helpers', () => {
  it('keeps only the newest history entries', () => {
    const values: number[] = [];
    for (let i = 0; i < 10; i++) pushBounded(values, i, 3);
    assert.deepStrictEqual(values, [7, 8, 9]);
    pushBounded(values, 10, 0);
    assert.deepStrictEqual(values, [7, 8, 9]);
  });

  it('keeps only the newest distinct set values', () => {
    const values = new BoundedSet<number>(3);
    for (const value of [1, 2, 2, 3, 4]) values.add(value);
    assert.deepStrictEqual([...values], [2, 3, 4]);
    assert.strictEqual(values.has(1), false);
    assert.strictEqual(values.has(4), true);
  });

  it('removes settled callbacks and drains only pending ones', () => {
    const callbacks = new CallbackSet();
    let called = 0;
    const settled = () => called++;
    const pending = () => called++;
    callbacks.add(settled);
    callbacks.add(pending);
    callbacks.delete(settled);
    assert.strictEqual(callbacks.size, 1);
    callbacks.drain();
    assert.strictEqual(called, 1);
    assert.strictEqual(callbacks.size, 0);
  });
});
