import * as assert from 'assert';
import { LogRateLimiter, parseDecodingSize, sanitizeLogText } from '../../../src/agent/mirrorLog';

describe('mirrorLog', () => {
  it('sanitizeLogText strips control characters and caps the length', () => {
    assert.strictEqual(sanitizeLogText('a\nb\r\u001b[31mc\u0000'), 'a b [31mc');
    const long = sanitizeLogText('x'.repeat(5000));
    assert.ok(long.length <= 123);
  });

  it('parseDecodingSize accepts only small positive integers', () => {
    assert.strictEqual(parseDecodingSize(720, 1600), '720x1600');
    for (const bad of [[0, 5], [-1, 5], [1.5, 2], ['7', 8], [NaN, 1], [1e9, 1], [undefined, 1], ['a\nb', 1]]) {
      assert.strictEqual(parseDecodingSize(bad[0], bad[1]), undefined);
    }
  });

  it('LogRateLimiter allows a burst then drops until the window passes', () => {
    const l = new LogRateLimiter(3, 1000);
    assert.deepStrictEqual([0, 1, 2, 3, 4].map((t) => l.allow(t)), [true, true, true, false, false]);
    assert.strictEqual(l.allow(1001), true);
  });
});
