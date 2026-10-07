/**
 * Generic virtualised list: only the rows in the visible window plus an overscan exist in the DOM.
 * Row heights are whole numbers of text lines (a folded row is one line, an expanded one more).
 * All sizes are set through CSSOM (`el.style`), which the page's CSP allows; never `style=""`.
 */

import { HeightIndex, OVERSCAN_ROWS, computeRange, isAtEnd, scrollTopToReveal } from './virtualWindow';

export interface VirtualListOptions {
  /** The scrolling element. */
  viewport: HTMLElement;
  /** Child of `viewport` whose height is the whole list; rows are positioned inside it. */
  spacer: HTMLElement;
  count(): number;
  /** Height of row `i` in lines. */
  lines(i: number): number;
  /** Fills a freshly created or invalidated row element (`el` is emptied before the call). */
  renderRow(i: number, el: HTMLElement): void;
  overscan?: number;
}

export class VirtualList {
  private readonly heights = new HeightIndex();
  private readonly rows = new Map<number, HTMLElement>();
  private linePx = 18;
  private frame = 0;
  private readonly overscan: number;

  constructor(private readonly o: VirtualListOptions) {
    this.overscan = o.overscan ?? OVERSCAN_ROWS;
    o.viewport.addEventListener('scroll', () => this.schedule(), { passive: true });
  }

  /** Pixel height of one line; call again when the font size changes. */
  setLinePx(px: number): void {
    this.linePx = px;
    this.relayout();
  }

  get renderedCount(): number {
    return this.rows.size;
  }

  rowElement(i: number): HTMLElement | undefined {
    return this.rows.get(i);
  }

  /**
   * Re-reads counts and heights, then renders. Rows with an index below `keepBelow` stay in the DOM
   * untouched (valid when only later rows were added); the default re-renders everything.
   */
  relayout(keepBelow: number = 0): void {
    this.heights.reset(this.o.count(), (i) => this.o.lines(i));
    this.o.spacer.style.height = `${this.heights.totalLines * this.linePx}px`;
    this.drop(keepBelow);
    this.render();
  }

  /** Re-renders every row currently in the DOM (content changed, positions did not). */
  invalidate(): void {
    this.drop();
    this.render();
  }

  private drop(keepBelow: number = 0): void {
    for (const [i, el] of this.rows) {
      if (i < keepBelow) continue;
      el.remove();
      this.rows.delete(i);
    }
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Renders the window now. */
  render(): void {
    const vp = this.o.viewport;
    const range = computeRange(this.heights, vp.scrollTop, vp.clientHeight, this.linePx, this.overscan);
    for (const [i, el] of this.rows) {
      if (i < range.start || i >= range.end) {
        el.remove();
        this.rows.delete(i);
      }
    }
    for (let i = range.start; i < range.end; i++) {
      if (this.rows.has(i)) continue;
      const el = document.createElement('div');
      el.className = 'row';
      el.style.top = `${this.heights.topLines(i) * this.linePx}px`;
      el.style.height = `${this.heights.linesOf(i) * this.linePx}px`;
      this.o.renderRow(i, el);
      this.o.spacer.appendChild(el);
      this.rows.set(i, el);
    }
  }

  /** Scrolls just enough to show row `i` and renders it. */
  reveal(i: number): void {
    const vp = this.o.viewport;
    vp.scrollTop = scrollTopToReveal(this.heights, i, vp.scrollTop, vp.clientHeight, this.linePx);
    this.render();
  }

  scrollToEnd(): void {
    const vp = this.o.viewport;
    vp.scrollTop = Math.max(0, this.heights.totalLines * this.linePx - vp.clientHeight);
    this.render();
  }

  atEnd(): boolean {
    const vp = this.o.viewport;
    return isAtEnd(vp.scrollTop, vp.clientHeight, this.heights.totalLines * this.linePx);
  }

  /** Rows per page for PageUp/PageDown. */
  pageRows(): number {
    return Math.max(1, Math.floor(this.o.viewport.clientHeight / this.linePx) - 1);
  }
}
