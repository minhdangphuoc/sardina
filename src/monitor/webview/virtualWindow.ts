/**
 * Windowing math of the virtualised list: row heights in lines, prefix sums, and the range of
 * rows to keep in the DOM. Pure (no DOM types) so it is unit tested under mocha.
 */

/** Rows kept above and below the visible ones (PLAN-device-monitor §5.5). */
export const OVERSCAN_ROWS = 100;

/** Pixel height of one text line for an editor font size, never below 16. */
export function lineHeightFor(fontSizePx: number): number {
  const size = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : 13;
  return Math.max(16, Math.ceil(size * 1.5));
}

export interface RowRange {
  /** First row index to render. */
  start: number;
  /** One past the last row index to render. */
  end: number;
}

/** Row tops from per-row line counts. `tops[i]` is the line offset of row `i`; `tops[count]` the total. */
export class HeightIndex {
  private tops: Float64Array = new Float64Array(1);
  private n = 0;

  get count(): number {
    return this.n;
  }

  /** Rebuilds from `lines(i)` (values below 1 count as 1). */
  reset(count: number, lines: (i: number) => number): void {
    const c = Math.max(0, Math.floor(count));
    if (this.tops.length < c + 1) this.tops = new Float64Array(Math.max(c + 1, this.tops.length * 2));
    let acc = 0;
    for (let i = 0; i < c; i++) {
      this.tops[i] = acc;
      acc += Math.max(1, Math.floor(lines(i)) || 1);
    }
    this.tops[c] = acc;
    this.n = c;
  }

  /** Total height in lines. */
  get totalLines(): number {
    return this.tops[this.n];
  }

  /** Height of row `i` in lines. */
  linesOf(i: number): number {
    return this.tops[i + 1] - this.tops[i];
  }

  /** Top of row `i` in lines. */
  topLines(i: number): number {
    return this.tops[Math.max(0, Math.min(i, this.n))];
  }

  /** Index of the row that contains line offset `y`; clamped to the last row. -1 when empty. */
  indexAtLine(y: number): number {
    if (this.n === 0) return -1;
    if (y <= 0) return 0;
    if (y >= this.tops[this.n]) return this.n - 1;
    let lo = 0;
    let hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

/** Rows to render for a scroll position, with `overscan` extra rows on both sides. */
export function computeRange(index: HeightIndex, scrollTopPx: number, viewportPx: number, linePx: number, overscan: number = OVERSCAN_ROWS): RowRange {
  if (index.count === 0 || linePx <= 0) return { start: 0, end: 0 };
  const first = index.indexAtLine(Math.max(0, scrollTopPx) / linePx);
  const last = index.indexAtLine((Math.max(0, scrollTopPx) + Math.max(0, viewportPx)) / linePx);
  return { start: Math.max(0, first - overscan), end: Math.min(index.count, last + 1 + overscan) };
}

/** Scroll position that brings row `i` fully into view, or `current` when it already is. */
export function scrollTopToReveal(index: HeightIndex, i: number, current: number, viewportPx: number, linePx: number): number {
  if (i < 0 || i >= index.count) return current;
  const top = index.topLines(i) * linePx;
  const bottom = top + index.linesOf(i) * linePx;
  if (top < current) return top;
  if (bottom > current + viewportPx) return Math.max(0, Math.min(top, bottom - viewportPx));
  return current;
}

/** Whether the scroll position is at the end, within `slackPx`. */
export function isAtEnd(scrollTopPx: number, viewportPx: number, totalPx: number, slackPx: number = 4): boolean {
  return scrollTopPx + viewportPx >= totalPx - slackPx;
}
