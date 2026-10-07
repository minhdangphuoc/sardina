import * as assert from 'assert';
import {
  CUT_SUFFIX,
  EMPTY_MESSAGE,
  LogBuffer,
  MAX_MESSAGE_BYTES,
  OMITTED_MESSAGE,
  capMessage,
  coredumpEvent,
  entryVisible,
  findSourceRefs,
  foldMessage,
  formatEntryLine,
  groupStackFrames,
  isMine,
  levelLetter,
  levelOf,
  levelPasses,
  markerEntry,
  markerText,
  matches,
  parseJournalJsonLine,
  parseQuery,
  parseShortPreciseLine,
  utf8Length,
  type JournalEntry,
} from '../../../src/monitor/logModel';

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();

function json(fields: Record<string, unknown>): string {
  return JSON.stringify({ __REALTIME_TIMESTAMP: '1733500000123456', ...fields });
}

function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  return { id: 0, source: 'json', ts: 1000, message: 'hello', tag: 'app', priority: 6, pid: 10, ...over };
}

describe('parseJournalJsonLine', () => {
  it('maps a full object', () => {
    const e = parseJournalJsonLine(
      json({
        MESSAGE: 'qml: hi',
        PRIORITY: '4',
        SYSLOG_IDENTIFIER: 'harbour-demo',
        _COMM: 'harbour-demo',
        _PID: '4321',
        SYSLOG_PID: '4000',
        _EXE: '/usr/bin/harbour-demo',
        _SYSTEMD_UNIT: 'user@100000.service',
        _TRANSPORT: 'stdout',
        CODE_FILE: 'main.cpp',
        CODE_LINE: '12',
        CODE_FUNC: 'main',
        QT_CATEGORY: 'qml',
        COREDUMP_PID: '77',
        COREDUMP_COMM: 'harbour-demo',
        COREDUMP_SIGNAL: '11',
        __CURSOR: 's=abc;i=1',
      }),
      NOW,
    );
    assert.deepStrictEqual(e, {
      id: 0,
      source: 'json',
      ts: 1733500000123,
      message: 'qml: hi',
      priority: 4,
      pid: 4321,
      syslogPid: 4000,
      tag: 'harbour-demo',
      comm: 'harbour-demo',
      exe: '/usr/bin/harbour-demo',
      unit: 'user@100000.service',
      transport: 'stdout',
      codeFile: 'main.cpp',
      codeLine: 12,
      codeFunc: 'main',
      category: 'qml',
      coredumpPid: 77,
      coredumpComm: 'harbour-demo',
      coredumpSignal: 11,
      cursor: 's=abc;i=1',
    });
  });

  it('accepts a minimal object; the tag falls back to _COMM and the pid to SYSLOG_PID', () => {
    const e = parseJournalJsonLine(json({ MESSAGE: 'x', _COMM: 'kworker', SYSLOG_PID: '5' }), NOW);
    assert.strictEqual(e.tag, 'kworker');
    assert.strictEqual(e.pid, 5);
    assert.strictEqual(e.priority, undefined);
    const bare = parseJournalJsonLine(json({ MESSAGE: 'x' }), NOW);
    assert.strictEqual(bare.tag, '');
    assert.strictEqual(bare.source, 'json');
  });

  it('shows a placeholder for a null MESSAGE and for an empty one', () => {
    assert.strictEqual(parseJournalJsonLine(json({ MESSAGE: null }), NOW).message, OMITTED_MESSAGE);
    assert.strictEqual(parseJournalJsonLine(json({ MESSAGE: '' }), NOW).message, EMPTY_MESSAGE);
  });

  it('decodes a byte-array message as UTF-8 with replacement characters', () => {
    const bytes = [...Buffer.from('héllo ')].concat([0xff]);
    assert.strictEqual(parseJournalJsonLine(json({ MESSAGE: bytes }), NOW).message, 'héllo �');
  });

  it('takes the first value of a repeated field', () => {
    assert.strictEqual(parseJournalJsonLine(json({ MESSAGE: 'x', SYSLOG_IDENTIFIER: ['a', 'b'] }), NOW).tag, 'a');
  });

  it('ignores an out-of-range priority and garbage numbers', () => {
    const e = parseJournalJsonLine(json({ MESSAGE: 'x', PRIORITY: '9', _PID: 'abc', CODE_LINE: '-1' }), NOW);
    assert.strictEqual(e.priority, undefined);
    assert.strictEqual(e.pid, undefined);
    assert.strictEqual(e.codeLine, undefined);
  });

  it('turns non-JSON text, journalctl errors and other objects into agent entries', () => {
    for (const line of ['Failed to seek to cursor', '{broken', '', '[1,2]', '{"MESSAGE":"no timestamp"}', '{"__REALTIME_TIMESTAMP":"1"}']) {
      const e = parseJournalJsonLine(line, NOW);
      assert.strictEqual(e.source, 'agent', line);
      assert.strictEqual(e.tag, 'journalctl');
      assert.strictEqual(e.ts, NOW);
    }
    assert.strictEqual(parseJournalJsonLine('Failed to seek to cursor', NOW).message, 'Failed to seek to cursor');
  });

  it('shows the error text of the stream end line', () => {
    const e = parseJournalJsonLine('{"ok":false,"error":"logs disabled on the phone"}', NOW);
    assert.strictEqual(e.source, 'agent');
    assert.strictEqual(e.message, 'logs disabled on the phone');
  });

  it('cuts a 1 MB message at 16 KiB', () => {
    const e = parseJournalJsonLine(json({ MESSAGE: 'A'.repeat(1024 * 1024) }), NOW);
    assert.ok(e.message.endsWith(CUT_SUFFIX));
    assert.ok(utf8Length(e.message) <= MAX_MESSAGE_BYTES + utf8Length(CUT_SUFFIX));
    assert.strictEqual(e.message.length, MAX_MESSAGE_BYTES + CUT_SUFFIX.length);
  });

  it('cuts multi-byte text on a character boundary', () => {
    const cut = capMessage('😀'.repeat(10), 10);
    assert.strictEqual(cut, '😀😀' + CUT_SUFFIX);
    assert.strictEqual(capMessage('short'), 'short');
  });
});

describe('parseShortPreciseLine', () => {
  it('parses ident[pid]: message with microseconds', () => {
    const e = parseShortPreciseLine('Oct 05 13:42:01.123456 sailfish harbour-demo[4321]: qml: hello: world', NOW);
    assert.strictEqual(e.source, 'text');
    assert.strictEqual(e.tag, 'harbour-demo');
    assert.strictEqual(e.pid, 4321);
    assert.strictEqual(e.message, 'qml: hello: world');
    assert.strictEqual(e.ts, new Date(2026, 9, 5, 13, 42, 1, 123).getTime());
    assert.strictEqual(e.priority, undefined);
    assert.strictEqual(levelOf(e), 'unknown');
  });

  it('handles a line with no [pid] and a single-digit padded day', () => {
    const e = parseShortPreciseLine('Oct  5 13:42:01.5 host kernel: usb 1-1: new device', NOW);
    assert.strictEqual(e.tag, 'kernel');
    assert.strictEqual(e.pid, undefined);
    assert.strictEqual(e.message, 'usb 1-1: new device');
    assert.strictEqual(e.ts, new Date(2026, 9, 5, 13, 42, 1, 500).getTime());
  });

  it('turns banners and garbage into agent entries', () => {
    for (const line of ['-- Logs begin at Mon 2026-10-05 --', '', 'Xyz 05 13:42:01 host a: b']) {
      assert.strictEqual(parseShortPreciseLine(line, NOW).source, 'agent', line);
    }
  });
});

describe('levelOf', () => {
  const byPriority: [number, string][] = [
    [0, 'error'],
    [1, 'error'],
    [2, 'error'],
    [3, 'error'],
    [4, 'warning'],
    [5, 'info'],
    [6, 'info'],
    [7, 'debug'],
  ];
  for (const [p, level] of byPriority) {
    it(`priority ${p} is ${level}`, () => assert.strictEqual(levelOf(entry({ priority: p })), level));
  }
  it('is unknown without a priority, agent and marker for synthetic rows', () => {
    assert.strictEqual(levelOf(entry({ priority: undefined })), 'unknown');
    assert.strictEqual(levelOf(entry({ source: 'agent' })), 'agent');
    assert.strictEqual(levelOf(markerEntry({ type: 'cleared' }, 1)), 'marker');
  });

  const derived: [string, string][] = [
    ['qml: ReferenceError: foo is not defined', 'error'],
    ['file:///x.qml:3:1: TypeError: Property undefined', 'error'],
    ['Foo is not a type', 'error'],
    ['Cannot assign to non-existent property "x"', 'error'],
    ['Error: bad', 'error'],
    ['Warning: something', 'warning'],
    ['qml: Warning: something', 'warning'],
    ['Binding loop detected for property "width"', 'warning'],
    ['qml: just a log', 'info'],
  ];
  for (const [msg, level] of derived) {
    it(`derives ${level} from "${msg}" only for stdout priority 6`, () => {
      const stdout = entry({ priority: 6, transport: 'stdout', message: msg });
      assert.strictEqual(levelOf(stdout, true), level);
      assert.strictEqual(levelOf(stdout, false), 'info');
      assert.strictEqual(levelOf(entry({ priority: 6, transport: 'journal', message: msg }), true), 'info');
      assert.strictEqual(levelOf(entry({ priority: 7, transport: 'stdout', message: msg }), true), 'debug');
    });
  }

  it('maps letters and the minimum level', () => {
    assert.deepStrictEqual(
      (['error', 'warning', 'info', 'debug', 'unknown', 'agent', 'marker'] as const).map(levelLetter),
      ['E', 'W', 'I', 'D', '·', 'A', ''],
    );
    assert.ok(levelPasses('error', 'warning'));
    assert.ok(!levelPasses('info', 'warning'));
    assert.ok(levelPasses('unknown', 'info'));
    assert.ok(!levelPasses('unknown', 'warning'));
    assert.ok(levelPasses('agent', 'error'));
    assert.ok(levelPasses('marker', 'error'));
    assert.ok(levelPasses('debug', 'verbose'));
    assert.ok(!levelPasses('debug', 'info'));
  });
});

describe('parseQuery and matches', () => {
  const e = entry({ tag: 'harbour-demo', pid: 4321, message: 'Hello World', priority: 4 });

  it('matches substrings case-insensitively over message and tag', () => {
    assert.ok(matches(e, parseQuery('hello')));
    assert.ok(matches(e, parseQuery('WORLD demo')));
    assert.ok(!matches(e, parseQuery('nothing')));
    assert.ok(matches(e, parseQuery('')));
  });
  it('excludes with -word', () => {
    assert.ok(!matches(e, parseQuery('hello -world')));
    assert.ok(matches(e, parseQuery('hello -nothing')));
    assert.deepStrictEqual(parseQuery('-').terms, [{ text: '-', negate: false }]);
  });
  it('filters by tag:, pid: and level:', () => {
    assert.ok(matches(e, parseQuery('tag:harbour-demo')));
    assert.ok(matches(e, parseQuery('tag:other tag:HARBOUR-demo')));
    assert.ok(!matches(e, parseQuery('tag:other')));
    assert.ok(matches(e, parseQuery('pid:4321')));
    assert.ok(!matches(e, parseQuery('pid:1')));
    assert.ok(matches(e, parseQuery('level:w')));
    assert.ok(!matches(e, parseQuery('level:e')));
    assert.strictEqual(parseQuery('level:warning').level, 'warning');
    // not a level: plain text
    assert.deepStrictEqual(parseQuery('level:zzz').terms, [{ text: 'level:zzz', negate: false }]);
    assert.deepStrictEqual(parseQuery('pid:abc').terms, [{ text: 'pid:abc', negate: false }]);
  });
  it('compiles /re/ once and honours /i', () => {
    const q = parseQuery('/hel+o w/i');
    assert.ok(q.regex);
    assert.ok(matches(e, q));
    assert.ok(!matches(e, parseQuery('/^world/')));
    assert.ok(!matches(e, parseQuery('/hello/')));
    assert.ok(matches(e, parseQuery('/Hello/')));
    const g = parseQuery('/o/');
    assert.ok(matches(e, g) && matches(e, g));
  });
  it('falls back to text for an invalid or catastrophic pattern and says so', () => {
    for (const bad of ['/(unclosed/', '/(a+)+$/', '/(.*)*x/', `/${'a'.repeat(300)}/`]) {
      const q = parseQuery(bad);
      assert.strictEqual(q.regex, undefined, bad);
      assert.ok(q.regexNote, bad);
      assert.strictEqual(q.terms.length, 1);
    }
  });
  it('caps a huge query and never throws', () => {
    assert.ok(parseQuery('x'.repeat(100000)).terms[0].text.length <= 500);
  });
  it('lets markers through every query', () => {
    assert.ok(matches(markerEntry({ type: 'cleared' }, 1), parseQuery('nothing tag:x pid:1 level:e')));
  });
});

describe('entryVisible and isMine', () => {
  const app = { name: 'harbour-demo-very-long-name', binary: '/usr/bin/harbour-demo-very-long-name', pids: [100] };
  it('matches pids, exe, comm cut to 15, identifier and coredump', () => {
    assert.ok(isMine(entry({ pid: 100, tag: 'x' }), app));
    assert.ok(isMine(entry({ pid: 1, syslogPid: 100, tag: 'x' }), app));
    assert.ok(isMine(entry({ pid: 1, tag: 'x', exe: app.binary }), app));
    assert.ok(isMine(entry({ pid: 1, tag: 'x', comm: 'harbour-demo-ve' }), app));
    assert.ok(isMine(entry({ pid: 1, tag: app.name }), app));
    assert.ok(isMine(entry({ pid: 1, tag: 'x', coredumpPid: 100 }), app));
    assert.ok(isMine(entry({ pid: 1, tag: 'systemd-coredump', message: `Process 100 (${app.name}) of user dumped core` }), app));
    assert.ok(isMine(entry({ pid: 1, tag: 'invoker', message: `Invoked ${app.binary}` }), app));
    assert.ok(isMine(entry({ pid: 1, tag: 'booster-silica-qt5', message: `launching ${app.name}` }), app));
    assert.ok(!isMine(entry({ pid: 1, tag: 'other', message: app.name }), app));
    assert.ok(!isMine(entry({ pid: 2, tag: 'invoker', message: 'something else' }), app));
  });
  it('combines the filters', () => {
    const f = { minLevel: 'warning' as const, tags: [] as string[], query: parseQuery(''), deriveLevels: false };
    assert.ok(!entryVisible(entry({ priority: 6 }), f));
    assert.ok(entryVisible(entry({ priority: 3 }), f));
    assert.ok(!entryVisible(entry({ priority: 3, tag: 'a' }), { ...f, tags: ['b'] }));
    assert.ok(!entryVisible(entry({ priority: 3, pid: 5 }), { ...f, mine: app }));
    assert.ok(entryVisible(markerEntry({ type: 'cleared' }, 1), { ...f, mine: app, minLevel: 'error' }));
  });
});

describe('LogBuffer', () => {
  it('assigns ids and wraps by count, reporting dropped', () => {
    const b = new LogBuffer(3);
    for (let i = 0; i < 5; i++) b.push(entry({ message: `m${i}` }));
    assert.deepStrictEqual(b.all().map((e) => e.message), ['m2', 'm3', 'm4']);
    assert.deepStrictEqual(b.all().map((e) => e.id), [3, 4, 5]);
    assert.strictEqual(b.droppedTotal, 2);
    assert.strictEqual(b.lastId, 5);
    const s = b.since(0);
    assert.strictEqual(s.dropped, 2);
    assert.strictEqual(s.entries.length, 3);
    const t = b.since(3);
    assert.strictEqual(t.dropped, 0);
    assert.deepStrictEqual(t.entries.map((e) => e.id), [4, 5]);
    assert.strictEqual(b.since(5).entries.length, 0);
    assert.deepStrictEqual(b.since(3, 1).entries.map((e) => e.id), [4]);
  });
  it('wraps by bytes but always keeps the newest entry', () => {
    const b = new LogBuffer(100, 10);
    b.push(entry({ message: 'aaaa' }));
    b.push(entry({ message: 'bbbb' }));
    b.push(entry({ message: 'cccc' }));
    assert.deepStrictEqual(b.all().map((e) => e.message), ['bbbb', 'cccc']);
    assert.strictEqual(b.bytes, 8);
    b.push(entry({ message: 'x'.repeat(50) }));
    assert.strictEqual(b.size, 1);
    assert.strictEqual(b.bytes, 50);
  });
  it('does not store the caller object and finds entries by id', () => {
    const b = new LogBuffer();
    const e = entry();
    const id = b.push(e);
    assert.strictEqual(e.id, 0);
    assert.strictEqual(b.get(id)?.id, id);
    assert.strictEqual(b.get(id + 1), undefined);
    assert.strictEqual(new LogBuffer().get(1), undefined);
  });
  it('clears but keeps counting ids, and lists tags by frequency', () => {
    const b = new LogBuffer();
    b.pushMany([entry({ tag: 'a' }), entry({ tag: 'b' }), entry({ tag: 'b' }), entry({ tag: '' })]);
    assert.deepStrictEqual(b.tags(), ['b', 'a']);
    b.clear();
    assert.strictEqual(b.size, 0);
    assert.strictEqual(b.bytes, 0);
    assert.strictEqual(b.push(entry()), 5);
    assert.strictEqual(b.since(0).dropped, 4);
  });
  it('compacts after many evictions without losing order', () => {
    const b = new LogBuffer(10);
    for (let i = 0; i < 5000; i++) b.push(entry({ message: String(i) }));
    assert.deepStrictEqual(b.all().map((e) => e.message), Array.from({ length: 10 }, (_, i) => String(4990 + i)));
    assert.strictEqual(b.get(5000)?.message, '4999');
    assert.deepStrictEqual(b.since(4995).entries.map((e) => e.id), [4996, 4997, 4998, 4999, 5000]);
  });
  it('clamps the limits', () => {
    assert.strictEqual(new LogBuffer(10_000_000).maxEntries, 100_000);
    assert.strictEqual(new LogBuffer(0).maxEntries, 10_000);
  });
});

describe('folding and grouping', () => {
  it('folds a multi-line message', () => {
    assert.deepStrictEqual(foldMessage('one'), { head: 'one', more: 0 });
    assert.deepStrictEqual(foldMessage('a\nb\r\nc\n\n'), { head: 'a', more: 2 });
    assert.deepStrictEqual(foldMessage(''), { head: '', more: 0 });
  });
  it('groups stack frames from the same pid within 50 ms', () => {
    const list = [
      entry({ ts: 1000, message: 'ReferenceError: x' }),
      entry({ ts: 1010, message: '    at foo (file.qml:1)' }),
      entry({ ts: 1030, message: 'at bar' }),
      entry({ ts: 1200, message: '  late frame' }),
      entry({ ts: 1210, pid: 11, message: '  other pid' }),
      markerEntry({ type: 'cleared' }, 1215),
      entry({ ts: 1216, message: '  after marker' }),
    ];
    const g = groupStackFrames(list);
    assert.deepStrictEqual(g.map((x) => x.frames.length), [2, 0, 0, 0, 0]);
    assert.strictEqual(g[0].entry.message, 'ReferenceError: x');
    assert.deepStrictEqual(groupStackFrames([]), []);
  });
});

describe('findSourceRefs', () => {
  it('finds file:// with line and column', () => {
    const msg = 'Warning: file:///usr/share/harbour-demo/qml/pages/Main.qml:12:5: Unable to assign';
    const [r] = findSourceRefs(msg);
    assert.strictEqual(r.file, '/usr/share/harbour-demo/qml/pages/Main.qml');
    assert.strictEqual(r.line, 12);
    assert.strictEqual(r.col, 5);
    assert.strictEqual(msg.slice(r.start, r.end), 'file:///usr/share/harbour-demo/qml/pages/Main.qml:12:5');
  });
  it('finds qrc:/ and bare /usr/share paths without a column', () => {
    assert.deepStrictEqual(findSourceRefs('at qrc:/qml/Main.qml:3'), [{ file: 'qrc:/qml/Main.qml', line: 3, start: 3, end: 22 }]);
    const bare = findSourceRefs('/usr/share/harbour-demo/qml/a.js:7 failed');
    assert.strictEqual(bare.length, 1);
    assert.strictEqual(bare[0].file, '/usr/share/harbour-demo/qml/a.js');
    assert.strictEqual(bare[0].col, undefined);
  });
  it('does not report a file:// URL twice and finds several', () => {
    const refs = findSourceRefs('file:///usr/share/a/x.qml:1 and qrc:/y.qml:2:3');
    assert.deepStrictEqual(refs.map((r) => [r.file, r.line, r.col]), [
      ['/usr/share/a/x.qml', 1, undefined],
      ['qrc:/y.qml', 2, 3],
    ]);
  });
  it('decodes %20 and keeps literal spaces', () => {
    assert.strictEqual(findSourceRefs('file:///home/u/My%20Project/x.qml:4')[0].file, '/home/u/My Project/x.qml');
    assert.strictEqual(findSourceRefs('file:///home/u/My Project/x.qml:4')[0].file, '/home/u/My Project/x.qml');
    assert.strictEqual(findSourceRefs('file:///bad%zz/x.qml:4')[0].file, '/bad%zz/x.qml');
  });
  it('adds CODE_FILE and CODE_LINE without a span', () => {
    assert.deepStrictEqual(findSourceRefs('plain', { codeFile: '/src/a.cpp', codeLine: 9 }), [
      { file: '/src/a.cpp', line: 9, start: -1, end: -1 },
    ]);
    assert.deepStrictEqual(findSourceRefs('plain', { codeFile: '/src/a.cpp' }), []);
    assert.deepStrictEqual(findSourceRefs('nothing here'), []);
  });
});

describe('process markers', () => {
  it('words the markers', () => {
    assert.strictEqual(markerText({ type: 'started', app: 'harbour-demo', pid: 4321, mode: 'debug' }), '── harbour-demo started (pid 4321, debug) ──');
    assert.strictEqual(markerText({ type: 'started', app: 'a' }), '── a started ──');
    assert.strictEqual(markerText({ type: 'exited', app: 'a', exit: { code: 0 } }), '── a exited with code 0 ──');
    assert.strictEqual(markerText({ type: 'exited', app: 'a', exit: { signal: 'SIGSEGV' } }), '── a crashed (SIGSEGV) ──');
    assert.strictEqual(markerText({ type: 'exited', app: 'a', exit: { code: 3 } }), '── a crashed (exit code 3) ──');
    assert.strictEqual(markerText({ type: 'resumed' }), '── log resumed; entries may be missing ──');
    assert.strictEqual(markerText({ type: 'cleared' }), '── log cleared ──');
    const m = markerEntry({ type: 'cleared' }, 5);
    assert.deepStrictEqual([m.source, m.ts, m.id], ['marker', 5, 0]);
  });
  it('turns a coredump line for the app into a crash event', () => {
    const app = { name: 'harbour-demo', pids: [4321] };
    const line = entry({ tag: 'systemd-coredump', coredumpPid: 4321, coredumpSignal: 11, coredumpComm: 'harbour-demo' });
    assert.deepStrictEqual(coredumpEvent(line, app), { type: 'exited', app: 'harbour-demo', exit: { coredump: true, signal: 'SIGSEGV' } });
    assert.strictEqual(markerText(coredumpEvent(line, app)!), '── harbour-demo crashed (SIGSEGV) ──');
    assert.strictEqual(coredumpEvent(entry({ coredumpPid: 5, coredumpComm: 'other' }), app), undefined);
    assert.strictEqual(coredumpEvent(entry(), app), undefined);
    assert.deepStrictEqual(coredumpEvent(entry({ coredumpPid: 1, coredumpSignal: 99, coredumpComm: 'harbour-demo' }), app)?.type, 'exited');
  });
  it('formats a line for the saved log', () => {
    const e = entry({ ts: new Date(2026, 9, 7, 13, 4, 5, 6).getTime(), priority: 4, pid: 7, tag: 'a', message: 'x\ny' });
    assert.strictEqual(formatEntryLine(e), '13:04:05.006 W 7 a: x\n    y');
    assert.strictEqual(formatEntryLine(markerEntry({ type: 'cleared' }, e.ts)), '13:04:05.006 ── log cleared ──');
  });
});
