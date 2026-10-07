/**
 * Pure model of the log viewer component: the bounded, grouped entry store with an incremental
 * filtered view, line splitting for source links, and status texts. No DOM types, so mocha tests it.
 * Filtering itself is `entryVisible` from the shared log model.
 */

import {
  findSourceRefs,
  foldMessage,
  groupStackFrames,
  entryVisible,
  type EntryGroup,
  type JournalEntry,
  type LogFilters,
  type SourceRef,
} from '../logModel';
import type { LogFormat, LogStatus } from '../protocol';

/** A display row: a head entry with its stack-frame lines. */
export interface LogGroup extends EntryGroup {
  /** Monotonic position in the store; never reused. */
  seq: number;
  /** Lines shown beyond the first when expanded. */
  extra: number;
}

function extraLines(g: EntryGroup): number {
  let n = foldMessage(g.entry.message).more;
  for (const f of g.frames) n += 1 + foldMessage(f.message).more;
  return n;
}

/** All lines of a row: the head's lines, then each frame's. Trailing blank lines are dropped. */
export function groupLines(g: EntryGroup): string[] {
  const lines: string[] = [];
  for (const e of [g.entry, ...g.frames]) {
    const parts = e.message.split(/\r?\n/);
    while (parts.length > 1 && parts[parts.length - 1].trim() === '') parts.pop();
    lines.push(...parts);
  }
  return lines;
}

export interface FilterSpec {
  filters: LogFilters;
  groupFrames: boolean;
}

const NO_FILTER: LogFilters = { minLevel: 'verbose', tags: [], query: { terms: [], tags: [], pids: [] }, deriveLevels: false };

/**
 * Entries held by the page, grouped, with the filtered view `rows` kept up to date on append and
 * rebuilt in time slices when the filter changes. Bounded by `maxEntries`.
 */
export class LogRows {
  private groups: LogGroup[] = [];
  private visible: LogGroup[] = [];
  private scanPos = 0;
  private nextSeq = 1;
  private total = 0;
  private evictedCount = 0;
  private syntheticId = 0;
  private spec: FilterSpec = { filters: NO_FILTER, groupFrames: true };

  constructor(readonly maxEntries: number) {}

  /** Entries held. */
  get size(): number {
    return this.total;
  }

  get evicted(): number {
    return this.evictedCount;
  }

  /** Filtered rows. */
  get length(): number {
    return this.visible.length;
  }

  get rebuilding(): boolean {
    return this.scanPos < this.groups.length;
  }

  rowAt(i: number): LogGroup | undefined {
    return this.visible[i];
  }

  /** Index of the visible row with this `seq`, or -1. */
  indexOfSeq(seq: number): number {
    let lo = 0;
    let hi = this.visible.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.visible[mid].seq;
      if (s === seq) return mid;
      if (s < seq) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Every held entry, oldest first (frames included). */
  allEntries(): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const g of this.groups) {
      out.push(g.entry);
      for (const f of g.frames) out.push(f);
    }
    return out;
  }

  /** Distinct tags held, most frequent first. */
  tags(): string[] {
    const counts = new Map<string, number>();
    for (const e of this.allEntries()) if (e.tag) counts.set(e.tag, (counts.get(e.tag) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }

  clear(): void {
    this.evictedCount += this.total;
    this.groups = [];
    this.visible = [];
    this.scanPos = 0;
    this.total = 0;
  }

  /** Adds entries (oldest first). Stack frames attach to the previous group when they follow its rule. */
  append(entries: readonly JournalEntry[]): void {
    if (entries.length === 0) return;
    const before = this.groups.length;
    const wasIdle = this.scanPos >= before;
    const last = before > 0 ? this.groups[before - 1] : undefined;
    const flat: JournalEntry[] = last ? [last.entry, ...last.frames, ...entries] : entries.slice();
    const regrouped: EntryGroup[] = this.spec.groupFrames ? groupStackFrames(flat) : flat.map((entry) => ({ entry, frames: [] }));
    if (last) this.groups.pop();
    const first = this.groups.length;
    if (this.scanPos > first) {
      this.scanPos = first;
      const cut = last ? last.seq : this.nextSeq;
      while (this.visible.length > 0 && this.visible[this.visible.length - 1].seq >= cut) this.visible.pop();
    }
    regrouped.forEach((g, i) => {
      const seq = i === 0 && last ? last.seq : this.nextSeq++;
      this.groups.push({ ...g, seq, extra: extraLines(g) });
    });
    this.total += entries.length;
    this.evict();
    if (wasIdle) this.scan(Number.POSITIVE_INFINITY, () => 0);
  }

  /** A viewer-side marker row (`N lines skipped by the viewer`). Ids are negative so they never clash. */
  appendMarker(message: string, ts: number): void {
    this.append([{ id: --this.syntheticId, source: 'marker', ts, message, tag: '' }]);
  }

  private evict(): void {
    let drop = 0;
    let total = this.total;
    while (total > this.maxEntries && drop < this.groups.length - 1) {
      const g = this.groups[drop];
      total -= 1 + g.frames.length;
      drop++;
    }
    if (drop === 0) return;
    this.evictedCount += this.total - total;
    this.total = total;
    this.groups.splice(0, drop);
    this.scanPos = Math.max(0, this.scanPos - drop);
    const firstSeq = this.groups[0].seq;
    let k = 0;
    while (k < this.visible.length && this.visible[k].seq < firstSeq) k++;
    if (k > 0) this.visible.splice(0, k);
  }

  private test(g: LogGroup): boolean {
    const f = this.spec.filters;
    if (entryVisible(g.entry, f)) return true;
    for (const fr of g.frames) if (entryVisible(fr, f)) return true;
    return false;
  }

  private scan(budgetMs: number, now: () => number): boolean {
    const start = now();
    let n = 0;
    while (this.scanPos < this.groups.length) {
      const g = this.groups[this.scanPos++];
      if (this.test(g)) this.visible.push(g);
      // the clock is read every 64 rows: reading it per row would dominate cheap filters
      if (++n % 64 === 0 && now() - start >= budgetMs) break;
    }
    return this.scanPos >= this.groups.length;
  }

  /** Changes the filter (and grouping) and starts a rebuild; drive it with `rebuildStep`. */
  setFilters(spec: FilterSpec): void {
    const regroup = spec.groupFrames !== this.spec.groupFrames;
    this.spec = spec;
    if (regroup) {
      const flat = this.allEntries();
      const grouped: EntryGroup[] = spec.groupFrames ? groupStackFrames(flat) : flat.map((entry) => ({ entry, frames: [] }));
      this.groups = grouped.map((g) => ({ ...g, seq: this.nextSeq++, extra: extraLines(g) }));
    }
    this.visible = [];
    this.scanPos = 0;
  }

  /** Runs the rebuild for about `budgetMs`; returns true when finished. */
  rebuildStep(budgetMs: number, now: () => number): boolean {
    return this.scan(budgetMs, now);
  }

  /** Finishes any rebuild at once (tests, small buffers). */
  rebuildAll(): void {
    this.scan(Number.POSITIVE_INFINITY, () => 0);
  }
}

// --- link spans ---

export interface LineSegment {
  text: string;
  /** Present on a source-link span. */
  ref?: SourceRef;
}

/** Splits one line into plain and link segments; overlapping or out-of-range references are ignored. */
export function splitLine(line: string, refs: readonly SourceRef[]): LineSegment[] {
  const inline = refs.filter((r) => r.start >= 0 && r.end <= line.length && r.end > r.start).sort((a, b) => a.start - b.start);
  const out: LineSegment[] = [];
  let pos = 0;
  for (const r of inline) {
    if (r.start < pos) continue;
    if (r.start > pos) out.push({ text: line.slice(pos, r.start) });
    out.push({ text: line.slice(r.start, r.end), ref: r });
    pos = r.end;
  }
  if (pos < line.length || out.length === 0) out.push({ text: line.slice(pos) });
  return out;
}

/** All references of a row: per line, plus the head entry's `CODE_FILE`/`CODE_LINE`. First is what Enter opens. */
export function rowRefs(g: EntryGroup, lines: readonly string[]): { perLine: SourceRef[][]; code?: SourceRef } {
  const perLine = lines.map((l) => findSourceRefs(l));
  const code = findSourceRefs('', g.entry).find((r) => r.start === -1);
  return { perLine, code };
}

export function firstRef(refs: { perLine: SourceRef[][]; code?: SourceRef }): SourceRef | undefined {
  for (const list of refs.perLine) if (list.length > 0) return list[0];
  return refs.code;
}

// --- status line ---

export interface StatusInput {
  status: LogStatus;
  reason?: string;
  format?: LogFormat;
  rate?: number;
  /** New lines held back while paused. */
  pending: number;
}

export function describeLogStatus(s: StatusInput): string {
  switch (s.status) {
    case 'starting':
      return 'starting…';
    case 'live': {
      const parts = ['live'];
      if (s.format) parts.push(s.format);
      if (s.rate !== undefined && Number.isFinite(s.rate)) parts.push(`${Math.round(s.rate)} lines/s`);
      return parts.join(' · ');
    }
    case 'paused':
      return `paused · ${s.pending} new`;
    case 'stopped':
      return s.reason ? `stopped: ${s.reason}` : 'stopped';
    case 'off':
      return s.reason ? `logs off on the phone: ${s.reason}` : 'logs off on the phone';
    case 'needsAgent':
      return 'needs the device agent';
  }
}

/** Text of a row for screen readers and the title attribute. */
export function describeRow(g: EntryGroup, levelName: string, time: string): string {
  const e = g.entry;
  if (e.source === 'marker') return e.message;
  const who = e.tag ? `${e.tag}${e.pid !== undefined ? ` ${e.pid}` : ''}` : '';
  return `${time} ${levelName}${who ? ` ${who}` : ''}: ${foldMessage(e.message).head.slice(0, 300)}`;
}
