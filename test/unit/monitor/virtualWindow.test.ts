import * as assert from 'assert';
import { HeightIndex, computeRange, isAtEnd, lineHeightFor, scrollTopToReveal } from '../../../src/monitor/webview/virtualWindow';

function uniform(n: number): HeightIndex {
  const h = new HeightIndex();
  h.reset(n, () => 1);
  return h;
}

describe('HeightIndex', () => {
  it('sums line counts and finds rows by offset', () => {
    const h = new HeightIndex();
    h.reset(4, (i) => [1, 3, 1, 2][i]);
    assert.strictEqual(h.totalLines, 7);
    assert.deepStrictEqual([0, 1, 2, 3].map((i) => h.topLines(i)), [0, 1, 4, 5]);
    assert.deepStrictEqual([0, 0.9, 1, 3.99, 4, 5, 6.5].map((y) => h.indexAtLine(y)), [0, 0, 1, 1, 2, 3, 3]);
    assert.strictEqual(h.linesOf(1), 3);
  });
  it('clamps out-of-range offsets and handles empty', () => {
    const h = uniform(3);
    assert.strictEqual(h.indexAtLine(-5), 0);
    assert.strictEqual(h.indexAtLine(99), 2);
    const e = new HeightIndex();
    e.reset(0, () => 1);
    assert.strictEqual(e.indexAtLine(0), -1);
    assert.strictEqual(e.totalLines, 0);
  });
  it('treats heights below one line (and NaN) as one', () => {
    const h = new HeightIndex();
    h.reset(3, (i) => [0, -2, NaN][i]);
    assert.strictEqual(h.totalLines, 3);
  });
  it('can shrink and grow', () => {
    const h = uniform(1000);
    h.reset(10, () => 2);
    assert.strictEqual(h.count, 10);
    assert.strictEqual(h.totalLines, 20);
  });
});

describe('computeRange', () => {
  it('renders the viewport plus the overscan, bounded by the list', () => {
    const h = uniform(10_000);
    // 20 px lines, 400 px viewport = 20 rows; scrolled to row 500
    assert.deepStrictEqual(computeRange(h, 10_000, 400, 20, 5), { start: 495, end: 526 });
    assert.deepStrictEqual(computeRange(h, 0, 400, 20, 5), { start: 0, end: 26 });
    const r = computeRange(h, 1_000_000, 400, 20, 5);
    assert.strictEqual(r.end, 10_000);
  });
  it('keeps the DOM bounded whatever the list size', () => {
    const h = uniform(100_000);
    const r = computeRange(h, 500_000, 800, 18);
    assert.ok(r.end - r.start <= 800 / 18 + 2 + 2 * 100 + 1, `${r.end - r.start}`);
  });
  it('handles variable heights and an empty list', () => {
    const h = new HeightIndex();
    h.reset(5, (i) => (i === 1 ? 10 : 1));
    assert.deepStrictEqual(computeRange(h, 40, 20, 20, 0), { start: 1, end: 2 });
    const e = new HeightIndex();
    e.reset(0, () => 1);
    assert.deepStrictEqual(computeRange(e, 0, 100, 20), { start: 0, end: 0 });
    assert.deepStrictEqual(computeRange(h, 0, 100, 0), { start: 0, end: 0 });
  });
  it('treats negative scroll as zero', () => {
    assert.strictEqual(computeRange(uniform(50), -50, 100, 10, 0).start, 0);
  });
});

describe('scrollTopToReveal', () => {
  const h = uniform(100);
  it('does nothing for a row in view', () => {
    assert.strictEqual(scrollTopToReveal(h, 5, 0, 200, 20), 0);
  });
  it('scrolls up to a row above and down to a row below', () => {
    assert.strictEqual(scrollTopToReveal(h, 2, 400, 200, 20), 40);
    assert.strictEqual(scrollTopToReveal(h, 30, 0, 200, 20), 620 - 200);
  });
  it('shows the top of a row taller than the viewport', () => {
    const t = new HeightIndex();
    t.reset(3, (i) => (i === 1 ? 50 : 1));
    assert.strictEqual(scrollTopToReveal(t, 1, 0, 100, 20), 20);
  });
  it('ignores a bad index', () => {
    assert.strictEqual(scrollTopToReveal(h, -1, 7, 200, 20), 7);
    assert.strictEqual(scrollTopToReveal(h, 100, 7, 200, 20), 7);
  });
});

describe('isAtEnd, lineHeightFor', () => {
  it('detects the end with slack', () => {
    assert.ok(isAtEnd(800, 200, 1000));
    assert.ok(isAtEnd(797, 200, 1000));
    assert.ok(!isAtEnd(700, 200, 1000));
  });
  it('derives a line height from the editor font size', () => {
    assert.strictEqual(lineHeightFor(13), 20);
    assert.strictEqual(lineHeightFor(8), 16);
    assert.strictEqual(lineHeightFor(NaN), 20);
    assert.strictEqual(lineHeightFor(0), 20);
  });
});
