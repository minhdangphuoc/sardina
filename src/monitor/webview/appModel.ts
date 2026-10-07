/**
 * Pure helpers of the App section: a fixed-size history, sparkline geometry and the text
 * alternative. No DOM types.
 */

export const HISTORY_POINTS = 60;

/** The last `HISTORY_POINTS` values of a series; `undefined` samples are skipped. */
export class History {
  private values: number[] = [];

  constructor(private readonly max: number = HISTORY_POINTS) {}

  push(v: number | undefined): void {
    if (v === undefined || !Number.isFinite(v)) return;
    this.values.push(v);
    if (this.values.length > this.max) this.values.shift();
  }

  clear(): void {
    this.values = [];
  }

  get list(): readonly number[] {
    return this.values;
  }
}

/** `x,y x,y …` for an SVG polyline of `width` x `height`; the y axis runs from 0 to `max` (or the data's max). */
export function sparkPoints(values: readonly number[], width: number, height: number, max?: number): string {
  if (values.length === 0) return '';
  const top = Math.max(max ?? 0, ...values, 1e-9);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = values.length > 1 ? i * step : width;
      const y = height - (Math.max(0, v) / top) * (height - 2) - 1;
      return `${round1(x)},${round1(y)}`;
    })
    .join(' ');
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface SeriesSummary {
  avg: number;
  max: number;
}

export function summarize(values: readonly number[]): SeriesSummary | undefined {
  if (values.length === 0) return undefined;
  let sum = 0;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v > max) max = v;
  }
  return { avg: sum / values.length, max };
}

/** `CPU over the last minute: avg 8 %, max 31 %`. */
export function describeCpu(values: readonly number[]): string {
  const s = summarize(values);
  if (!s) return 'CPU over the last minute: no data yet';
  return `CPU over the last minute: avg ${Math.round(s.avg)} %, max ${Math.round(s.max)} %`;
}

/** `Memory over the last minute: avg 48 MB, max 52 MB` (values in kB). */
export function describeRss(valuesKb: readonly number[]): string {
  const s = summarize(valuesKb);
  if (!s) return 'Memory over the last minute: no data yet';
  const mb = (kb: number): string => `${Math.round(kb / 1024)} MB`;
  return `Memory over the last minute: avg ${mb(s.avg)}, max ${mb(s.max)}`;
}
