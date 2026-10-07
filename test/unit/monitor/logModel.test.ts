import * as assert from 'assert';
import {
  CUT_SUFFIX,
  EMPTY_MESSAGE,
  MAX_MESSAGE_BYTES,
  OMITTED_MESSAGE,
  capMessage,
  coredumpEvent,
  formatEntryLine,
  levelLetter,
  levelOf,
  markerEntry,
  markerText,
  parseJournalJsonLine,
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

  it('maps letters', () => {
    assert.deepStrictEqual(
      (['error', 'warning', 'info', 'debug', 'unknown', 'agent', 'marker'] as const).map(levelLetter),
      ['E', 'W', 'I', 'D', '·', 'A', ''],
    );
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
