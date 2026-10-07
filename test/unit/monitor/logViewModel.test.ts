import * as assert from 'assert';
import { parseQuery, type JournalEntry, type LogFilters } from '../../../src/monitor/logModel';
import {
  LogRows,
  describeLogStatus,
  describeRow,
  firstRef,
  groupLines,
  rowRefs,
  splitLine,
} from '../../../src/monitor/webview/logViewModel';
import { findSourceRefs } from '../../../src/monitor/logModel';

let nextId = 1;
function e(message: string, over: Partial<JournalEntry> = {}): JournalEntry {
  return { id: nextId++, source: 'json', ts: 1000 + nextId, message, tag: 'app', pid: 10, priority: 6, ...over };
}

function filters(over: Partial<LogFilters> = {}): LogFilters {
  return { minLevel: 'verbose', tags: [], query: parseQuery(''), deriveLevels: false, ...over };
}

function rowsOf(rows: LogRows): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) out.push(rows.rowAt(i)?.entry.message ?? '?');
  return out;
}

describe('LogRows filtering through the log model', () => {
  it('shows everything with no filter', () => {
    const r = new LogRows(100);
    r.append([e('a'), e('b'), e('c')]);
    assert.deepStrictEqual(rowsOf(r), ['a', 'b', 'c']);
  });

  it('applies level, tag, query and "mine" like entryVisible', () => {
    const r = new LogRows(100);
    r.append([
      e('quiet', { priority: 6 }),
      e('warn boom', { priority: 4, tag: 'qml' }),
      e('err boom', { priority: 3, pid: 99 }),
      e('other', { priority: 4, pid: 50, tag: 'sys' }),
    ]);
    r.setFilters({ filters: filters({ minLevel: 'warning' }), groupFrames: true });
    r.rebuildAll();
    assert.deepStrictEqual(rowsOf(r), ['warn boom', 'err boom', 'other']);
    r.setFilters({ filters: filters({ query: parseQuery('boom -err') }), groupFrames: true });
    r.rebuildAll();
    assert.deepStrictEqual(rowsOf(r), ['warn boom']);
    r.setFilters({ filters: filters({ tags: ['sys'] }), groupFrames: true });
    r.rebuildAll();
    assert.deepStrictEqual(rowsOf(r), ['other']);
    r.setFilters({ filters: filters({ mine: { name: 'zzz', pids: new Set([99]) } }), groupFrames: true });
    r.rebuildAll();
    assert.deepStrictEqual(rowsOf(r), ['err boom']);
  });

  it('keeps markers whatever the filter says', () => {
    const r = new LogRows(100);
    r.setFilters({ filters: filters({ query: parseQuery('zzz') }), groupFrames: true });
    r.append([e('x'), { id: 500, source: 'marker', ts: 1, message: '── log cleared ──', tag: '' }]);
    assert.deepStrictEqual(rowsOf(r), ['── log cleared ──']);
  });

  it('filters appended entries as they arrive', () => {
    const r = new LogRows(100);
    r.setFilters({ filters: filters({ query: parseQuery('keep') }), groupFrames: true });
    r.rebuildAll();
    r.append([e('keep 1'), e('drop')]);
    r.append([e('keep 2')]);
    assert.deepStrictEqual(rowsOf(r), ['keep 1', 'keep 2']);
  });

  it('rebuilds in time slices and an append during a rebuild is not lost', () => {
    const r = new LogRows(10_000);
    const many: JournalEntry[] = [];
    for (let i = 0; i < 1000; i++) many.push(e(i % 2 ? 'odd' : 'even'));
    r.append(many);
    r.setFilters({ filters: filters({ query: parseQuery('odd') }), groupFrames: true });
    assert.strictEqual(r.length, 0);
    assert.ok(r.rebuilding);
    let clock = 0;
    const now = (): number => (clock += 1); // every clock read costs 1 ms
    assert.strictEqual(r.rebuildStep(1, now), false, 'a tiny budget leaves work for the next frame');
    assert.ok(r.length > 0 && r.length < 500);
    r.append([e('odd late')]);
    let steps = 0;
    while (!r.rebuildStep(1, now)) steps++;
    assert.ok(steps > 3);
    assert.strictEqual(r.length, 501);
    assert.strictEqual(r.rowAt(500)?.entry.message, 'odd late');
    assert.ok(!r.rebuilding);
  });

  it('stays correct when entries arrive after the scan passed the tail', () => {
    const r = new LogRows(100);
    r.append([e('a', { ts: 1000 }), e('  frame', { ts: 1001 })]);
    r.setFilters({ filters: filters(), groupFrames: true });
    r.rebuildAll();
    r.append([e('  frame 2', { ts: 1002 })]);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r.rowAt(0)?.frames.length, 2);
  });
});

describe('LogRows grouping and folding', () => {
  const t = 5_000_000;
  it('groups stack frames under the line before them and counts the extra lines', () => {
    const r = new LogRows(100);
    r.append([e('TypeError: x', { ts: t }), e('    at f (a.qml:1)', { ts: t + 5 }), e('    at g (a.qml:2)', { ts: t + 9 }), e('next', { ts: t + 500 })]);
    assert.strictEqual(r.length, 2);
    const g = r.rowAt(0);
    assert.ok(g);
    assert.strictEqual(g.extra, 2);
    assert.deepStrictEqual(groupLines(g), ['TypeError: x', '    at f (a.qml:1)', '    at g (a.qml:2)']);
    assert.strictEqual(r.rowAt(1)?.extra, 0);
  });

  it('counts the extra lines of a multi-line message', () => {
    const r = new LogRows(100);
    r.append([e('one\ntwo\nthree\n\n')]);
    assert.strictEqual(r.rowAt(0)?.extra, 2);
  });

  it('turning grouping off shows every line as its own row', () => {
    const r = new LogRows(100);
    r.append([e('a', { ts: t }), e('  b', { ts: t + 1 })]);
    assert.strictEqual(r.length, 1);
    r.setFilters({ filters: filters(), groupFrames: false });
    r.rebuildAll();
    assert.strictEqual(r.length, 2);
    r.setFilters({ filters: filters(), groupFrames: true });
    r.rebuildAll();
    assert.strictEqual(r.length, 1);
  });

  it('keeps a group when only a frame matches the query', () => {
    const r = new LogRows(100);
    r.setFilters({ filters: filters({ query: parseQuery('needle') }), groupFrames: true });
    r.append([e('head', { ts: t }), e('  at needle (x.qml:1)', { ts: t + 1 }), e('other', { ts: t + 900 })]);
    assert.deepStrictEqual(rowsOf(r), ['head']);
  });

  it('attaches late frames to the last group even across appends', () => {
    const r = new LogRows(100);
    r.append([e('head', { ts: t })]);
    r.append([e('  frame', { ts: t + 10 })]);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r.rowAt(0)?.frames.length, 1);
    assert.strictEqual(r.size, 2);
  });
});

describe('LogRows bounds', () => {
  it('evicts the oldest entries beyond the limit and keeps the view consistent', () => {
    const r = new LogRows(5);
    for (let i = 0; i < 4; i++) r.append([e(`m${i * 2}`, { ts: i * 1000 }), e(`m${i * 2 + 1}`, { ts: i * 1000 + 500 })]);
    assert.strictEqual(r.size, 5);
    assert.strictEqual(r.evicted, 3);
    assert.deepStrictEqual(rowsOf(r), ['m3', 'm4', 'm5', 'm6', 'm7']);
    assert.strictEqual(r.indexOfSeq(r.rowAt(0)?.seq ?? -1), 0);
  });
  it('never drops the newest group and counts frames', () => {
    const r = new LogRows(2);
    r.append([e('a', { ts: 0 }), e('  f1', { ts: 1 }), e('  f2', { ts: 2 })]);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r.size, 3);
  });
  it('clear empties and counts the loss', () => {
    const r = new LogRows(10);
    r.append([e('a'), e('b')]);
    r.clear();
    assert.strictEqual(r.length, 0);
    assert.strictEqual(r.size, 0);
    assert.strictEqual(r.evicted, 2);
  });
  it('adds a skipped-lines marker row with a negative id', () => {
    const r = new LogRows(10);
    r.appendMarker('7 lines skipped by the viewer', 1);
    r.appendMarker('again', 2);
    assert.strictEqual(r.rowAt(0)?.entry.source, 'marker');
    assert.ok((r.rowAt(0)?.entry.id ?? 0) < 0);
    assert.notStrictEqual(r.rowAt(0)?.entry.id, r.rowAt(1)?.entry.id);
  });
  it('lists tags by frequency', () => {
    const r = new LogRows(10);
    r.append([e('1', { tag: 'b' }), e('2', { tag: 'a' }), e('3', { tag: 'a' }), e('4', { tag: '' })]);
    assert.deepStrictEqual(r.tags(), ['a', 'b']);
  });
  it('finds rows by seq with binary search', () => {
    const r = new LogRows(1000);
    const list: JournalEntry[] = [];
    for (let i = 0; i < 100; i++) list.push(e(`m${i}`, { ts: i * 1000 }));
    r.append(list);
    for (let i = 0; i < 100; i += 7) assert.strictEqual(r.indexOfSeq(r.rowAt(i)?.seq ?? -1), i);
    assert.strictEqual(r.indexOfSeq(-5), -1);
    assert.strictEqual(r.indexOfSeq(99999), -1);
  });
});

describe('source links', () => {
  it('splits a line at the reference spans', () => {
    const line = 'ReferenceError at file:///usr/share/app/qml/Main.qml:12:5 oops';
    const segs = splitLine(line, findSourceRefs(line));
    assert.deepStrictEqual(segs.map((s) => s.text), ['ReferenceError at ', 'file:///usr/share/app/qml/Main.qml:12:5', ' oops']);
    assert.strictEqual(segs[1].ref?.file, '/usr/share/app/qml/Main.qml');
    assert.strictEqual(segs[1].ref?.line, 12);
    assert.strictEqual(segs[1].ref?.col, 5);
    assert.strictEqual(segs[0].ref, undefined);
  });
  it('returns one plain segment without references, including for an empty line', () => {
    assert.deepStrictEqual(splitLine('hello', []), [{ text: 'hello' }]);
    assert.deepStrictEqual(splitLine('', []), [{ text: '' }]);
  });
  it('ignores references from CODE_FILE and out-of-range spans', () => {
    const segs = splitLine('abc', [
      { file: 'x', line: 1, start: -1, end: -1 },
      { file: 'y', line: 1, start: 2, end: 99 },
    ]);
    assert.deepStrictEqual(segs, [{ text: 'abc' }]);
  });
  it('picks the first reference of a row, else CODE_FILE', () => {
    const g = { entry: e('no ref\nfile:///a/b.qml:3', { codeFile: '/z.qml', codeLine: 9 }), frames: [] };
    const refs = rowRefs(g, groupLines(g));
    assert.strictEqual(firstRef(refs)?.file, '/a/b.qml');
    const h = { entry: e('plain', { codeFile: '/z.qml', codeLine: 9 }), frames: [] };
    assert.strictEqual(firstRef(rowRefs(h, groupLines(h)))?.file, '/z.qml');
    const none = { entry: e('plain'), frames: [] };
    assert.strictEqual(firstRef(rowRefs(none, groupLines(none))), undefined);
  });
});

describe('status and row text', () => {
  it('describes every state', () => {
    assert.strictEqual(describeLogStatus({ status: 'live', format: 'json', rate: 127.6, pending: 0 }), 'live · json · 128 lines/s');
    assert.strictEqual(describeLogStatus({ status: 'live', pending: 0 }), 'live');
    assert.strictEqual(describeLogStatus({ status: 'paused', pending: 120 }), 'paused · 120 new');
    assert.strictEqual(describeLogStatus({ status: 'stopped', reason: 'device changed', pending: 0 }), 'stopped: device changed');
    assert.strictEqual(describeLogStatus({ status: 'stopped', pending: 0 }), 'stopped');
    assert.strictEqual(describeLogStatus({ status: 'off', pending: 0 }), 'logs off on the phone');
    assert.strictEqual(describeLogStatus({ status: 'needsAgent', pending: 0 }), 'needs the device agent');
    assert.strictEqual(describeLogStatus({ status: 'starting', pending: 0 }), 'starting…');
  });
  it('describes a row for screen readers', () => {
    assert.strictEqual(describeRow({ entry: e('hi\nmore', { tag: 'qml', pid: 7 }), frames: [] }, 'warning', '13:00:00.000'), '13:00:00.000 warning qml 7: hi');
    assert.strictEqual(describeRow({ entry: { id: 1, source: 'marker', ts: 0, message: '── x ──', tag: '' }, frames: [] }, 'marker', 't'), '── x ──');
  });
});
