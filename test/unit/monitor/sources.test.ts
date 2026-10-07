import * as assert from 'node:assert/strict';
import { AGENT_BINARY } from '../../../src/agent/agentCore';
import { DeviceSessions } from '../../../src/core/deviceSessions';
import { APP_STATS_SCRIPT } from '../../../src/monitor/appStats';
import {
  JournalLogSource,
  chooseLogFormat,
  classifyLogLine,
  clampLogLines,
  logRequestArgs,
  type LogEnd,
} from '../../../src/monitor/logSource';
import {
  AppStatsSource,
  chooseStatsMode,
  isValidExe,
  pidTransitions,
  pollIntervalMs,
  statsPollArgs,
  statsStreamArgs,
  type StatsUpdate,
} from '../../../src/monitor/statsSource';
import type { JournalEntry } from '../../../src/monitor/logModel';

const JSON_LINE = JSON.stringify({
  __CURSOR: 's=abc;i=1;b=2;m=3;t=4;x=5',
  __REALTIME_TIMESTAMP: '1733500000123456',
  MESSAGE: '\u001b[31mred\u001b[0m text',
  PRIORITY: '3',
  SYSLOG_IDENTIFIER: 'harbour-demo',
  _PID: '4321',
});

describe('monitor sources: log helpers', () => {
  it('chooses json only when the agent lists it', () => {
    assert.equal(chooseLogFormat(['text', 'json']), 'json');
    assert.equal(chooseLogFormat(['text']), 'text');
    assert.equal(chooseLogFormat(undefined), 'text');
  });

  it('clamps the initial tail to the agent range', () => {
    assert.equal(clampLogLines(0), 1);
    assert.equal(clampLogLines(250.7), 250);
    assert.equal(clampLogLines(99999), 10000);
    assert.equal(clampLogLines('x'), 200);
  });

  it('builds the text and json argv; a cursor replaces --lines', () => {
    const base = ['device', 'exec', '--', AGENT_BINARY, '--request', 'logs'];
    assert.deepEqual(logRequestArgs({ format: 'text', lines: 100 }), [...base, '--lines', '100']);
    assert.deepEqual(logRequestArgs({ format: 'json', lines: 100, clientArgs: ['--client', 'host'] }), [
      ...base,
      '--lines',
      '100',
      '--format',
      'json',
      '--client',
      'host',
    ]);
    assert.deepEqual(logRequestArgs({ format: 'json', lines: 100, after: 's=a;i=1' }), [...base, '--format', 'json', '--after', 's=a;i=1']);
  });

  it('never sends an invalid cursor or a cursor in text mode', () => {
    const a = logRequestArgs({ format: 'json', lines: 5, after: 'x y; rm -rf /' });
    assert.ok(!a.includes('--after'));
    assert.ok(a.includes('--lines'));
    assert.ok(!logRequestArgs({ format: 'text', lines: 5, after: 's=a' }).includes('--after'));
  });

  it('classifies json lines, strips ANSI and keeps the cursor', () => {
    const r = classifyLogLine(JSON_LINE, 'json');
    assert.equal(r.kind, 'entry');
    if (r.kind !== 'entry') return;
    assert.equal(r.entry.message, 'red text');
    assert.equal(r.entry.cursor, 's=abc;i=1;b=2;m=3;t=4;x=5');
    assert.equal(r.entry.pid, 4321);
  });

  it('caps a huge message at 16 KiB', () => {
    const big = JSON.stringify({ __REALTIME_TIMESTAMP: '1733500000123456', MESSAGE: 'x'.repeat(40000) });
    const r = classifyLogLine(big, 'json');
    assert.equal(r.kind, 'entry');
    if (r.kind === 'entry') assert.ok(Buffer.byteLength(r.entry.message) <= 16 * 1024 + 16);
  });

  it('parses short-precise text lines', () => {
    const r = classifyLogLine('Oct 05 13:42:01.123456 host harbour-demo[4321]: hello', 'text');
    assert.equal(r.kind, 'entry');
    if (r.kind === 'entry') {
      assert.equal(r.entry.source, 'text');
      assert.equal(r.entry.tag, 'harbour-demo');
    }
  });

  it('ends on the phone refusals with the describeAgentRefusal text', () => {
    const r = classifyLogLine('{"ok":false,"error":"logs disabled on the phone"}', 'json');
    assert.equal(r.kind, 'end');
    if (r.kind === 'end') assert.match(r.text, /Allow system logs/);
    const s = classifyLogLine('{"ok":false,"error":"stopped from the phone"}', 'text');
    assert.equal(s.kind, 'end');
  });

  it('recognises a failed cursor seek and skips blank lines', () => {
    assert.equal(classifyLogLine('Failed to seek to cursor: Cannot assign requested address', 'json').kind, 'seekFailed');
    assert.equal(classifyLogLine('   ', 'json').kind, 'skip');
  });
});

describe('monitor sources: stats helpers', () => {
  it('picks the stream only when the ping says stats', () => {
    assert.equal(chooseStatsMode(true), 'stream');
    assert.equal(chooseStatsMode(false), 'poll');
    assert.equal(chooseStatsMode(undefined), 'poll');
  });

  it('polls at least every 2 s, default 5 s', () => {
    assert.equal(pollIntervalMs(undefined), 5000);
    assert.equal(pollIntervalMs(1), 2000);
    assert.equal(pollIntervalMs(10), 10000);
  });

  it('validates the binary path', () => {
    assert.ok(isValidExe('/usr/bin/harbour-demo'));
    assert.ok(!isValidExe('harbour-demo'));
    assert.ok(!isValidExe('/usr/bin/../x'));
    assert.ok(!isValidExe('/usr/bin/a b'));
    assert.ok(!isValidExe('/usr/bin/a;rm'));
  });

  it('builds argv arrays with the script as one element and the binary positional', () => {
    assert.deepEqual(statsPollArgs('/usr/bin/harbour-demo'), ['device', 'exec', '--', 'sh', '-c', APP_STATS_SCRIPT, 'sh', '/usr/bin/harbour-demo']);
    assert.deepEqual(statsStreamArgs('/usr/bin/harbour-demo', 1000), [
      'device', 'exec', '--', AGENT_BINARY, '--request', 'stats', '--exe', '/usr/bin/harbour-demo', '--interval', '1000',
    ]);
  });

  it('derives start/exit transitions from two samples', () => {
    const s = (pid: number, ts: number) => ({ pid, ts });
    assert.deepEqual(pidTransitions(undefined, s(0, 1)), []);
    assert.deepEqual(pidTransitions(s(0, 1), s(5, 2)), [{ type: 'start', pid: 5, ts: 2 }]);
    assert.deepEqual(pidTransitions(s(5, 2), s(5, 3)), []);
    assert.deepEqual(pidTransitions(s(5, 3), s(0, 4)), [{ type: 'exit', pid: 5, ts: 4 }]);
    assert.deepEqual(pidTransitions(s(5, 3), s(6, 4)), [
      { type: 'exit', pid: 5, ts: 4 },
      { type: 'start', pid: 6, ts: 4 },
    ]);
  });
});

interface FakeRun {
  args: string[];
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  token?: { onCancellationRequested(l: () => void): unknown };
}

type FakeResult = { exitCode: number; stdout?: string; stderr?: string; cancelled?: boolean };

function fakeServices(script: (r: FakeRun) => FakeResult | Promise<FakeResult> | Promise<never>) {
  const runs: FakeRun[] = [];
  const logs: string[] = [];
  const services = {
    runner: {
      run: async (opts: FakeRun) => {
        runs.push(opts);
        const r = await script(opts);
        return { stdout: '', stderr: '', cancelled: false, timedOut: false, argv: [], durationMs: 0, signal: undefined, ...r };
      },
    },
    output: { log: (_l: string, m: string) => void logs.push(m) },
  };
  return { services: services as unknown as ConstructorParameters<typeof JournalLogSource>[0], runs, logs };
}

describe('JournalLogSource', () => {
  it('streams entries in a batch, registers a session and reports a refusal end', async () => {
    const sessions = new DeviceSessions();
    const { services, runs } = fakeServices((r) => {
      r.onLine?.(JSON_LINE, 'stdout');
      r.onLine?.('{"ok":false,"error":"stopped from the phone"}', 'stdout');
      return { exitCode: 0 };
    });
    const src = new JournalLogSource(services, { device: 'dev', format: 'json', logLines: 50, sessions });
    const got: JournalEntry[][] = [];
    const ends: LogEnd[] = [];
    src.onEntries((e) => got.push(e));
    src.onEnd((e) => ends.push(e));
    assert.equal(await src.start(), true);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(runs.length, 1);
    assert.equal(got.flat().length, 1);
    assert.equal(src.lastCursor, 's=abc;i=1;b=2;m=3;t=4;x=5');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'refused');
    assert.equal(ends[0].agentError, 'stopped from the phone');
    assert.equal(sessions.activeFor('dev').length, 0);
  });

  it('refuses before starting when the phone has logs off', async () => {
    const { services, runs } = fakeServices(() => ({ exitCode: 0 }));
    const src = new JournalLogSource(services, {
      device: 'dev',
      format: 'text',
      logLines: 10,
      sessions: new DeviceSessions(),
      probe: () => Promise.resolve({ state: 'running', version: '1.10.0', developerMode: true, settings: { logs: false } }),
    });
    const ends: LogEnd[] = [];
    src.onEnd((e) => ends.push(e));
    assert.equal(await src.start(), false);
    assert.equal(runs.length, 0);
    assert.equal(ends[0].reason, 'refused');
  });

  it('resumes after the cursor following a pause', async () => {
    const sessions = new DeviceSessions();
    let n = 0;
    const { services, runs } = fakeServices((r) => {
      if (n++ === 0) r.onLine?.(JSON_LINE, 'stdout');
      return new Promise<never>(() => undefined);
    });
    const src = new JournalLogSource(services, { device: 'dev', format: 'json', logLines: 50, sessions });
    await src.start();
    await new Promise((r) => setTimeout(r, 20));
    src.pause();
    assert.equal(sessions.activeFor('dev').length, 0);
    await src.resume();
    assert.equal(runs.length, 2);
    assert.ok(runs[1].args.includes('--after'));
    assert.ok(!runs[1].args.includes('--lines'));
    src.dispose();
  });
});

describe('JournalLogSource cursor resume', () => {
  it('starts after the cursor it was given', async () => {
    const { services, runs } = fakeServices(() => new Promise<never>(() => undefined));
    const src = new JournalLogSource(services, { device: 'dev', format: 'json', logLines: 50, sessions: new DeviceSessions(), after: 's=a;i=7' });
    await src.start();
    assert.deepEqual(runs[0].args.slice(-3), ['json', '--after', 's=a;i=7']);
    assert.ok(!runs[0].args.includes('--lines'));
    src.dispose();
  });

  it('a failed seek ends the silent stream and reconnects with the tail and a marker', async () => {
    // Recorded (T4-4): one plain line, then nothing more and no exit until the client closes.
    const { services, runs } = fakeServices(
      (r) =>
        new Promise((resolve) => {
          r.token?.onCancellationRequested(() => resolve({ exitCode: 0, cancelled: true }));
          if (runs.length === 1) r.onLine?.('Failed to seek to cursor: Invalid argument', 'stdout');
        }),
    );
    const src = new JournalLogSource(services, { device: 'dev', format: 'json', logLines: 50, sessions: new DeviceSessions(), after: 's=bogus;i=1;b=x' });
    const got: JournalEntry[] = [];
    const ends: LogEnd[] = [];
    src.onEntries((e) => got.push(...e));
    src.onEnd((e) => ends.push(e));
    await src.start();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(runs.length, 2);
    assert.ok(runs[0].args.includes('--after'));
    assert.ok(!runs[1].args.includes('--after') && runs[1].args.includes('--lines'));
    assert.ok(got.some((e) => e.source === 'marker'));
    assert.equal(ends.length, 0);
    src.dispose();
  });
});

describe('AppStatsSource', () => {
  const POLL_OUT = 'pid 0\ncpu  1 2 3 4 5 6 7 8\n';

  it('polls with the script, registers monitor and stops with dispose', async () => {
    const sessions = new DeviceSessions();
    const { services, runs } = fakeServices(() => ({ exitCode: 0, stdout: POLL_OUT }));
    const src = new AppStatsSource(services, { device: 'dev', mode: 'poll', binary: '/usr/bin/harbour-demo', intervalMs: 10, sessions });
    const updates: StatsUpdate[] = [];
    src.onSample((u) => updates.push(u));
    src.start();
    assert.equal(sessions.activeFor('dev')[0].kind, 'monitor');
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(runs.length >= 2);
    assert.equal(runs[0].args[3], 'sh');
    assert.equal(runs[0].args[7], '/usr/bin/harbour-demo');
    assert.equal(updates[0].sample.pid, 0);
    src.dispose();
    const count = runs.length;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(runs.length, count);
    assert.equal(sessions.activeFor('dev').length, 0);
  });

  it('does not poll without a binary or while hidden', async () => {
    const { services, runs } = fakeServices(() => ({ exitCode: 0, stdout: POLL_OUT }));
    const src = new AppStatsSource(services, { device: 'dev', mode: 'poll', intervalMs: 10, sessions: new DeviceSessions() });
    src.start();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(runs.length, 0);
    src.setVisible(false);
    src.setBinary('/usr/bin/harbour-demo');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(runs.length, 0);
    src.setVisible(true);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(runs.length >= 1);
    src.dispose();
  });

  it('reads the agent stream: samples and start/exit events', async () => {
    const { services, runs } = fakeServices((r) => {
      r.onLine?.('{"event":"start","pid":7,"ts":1000}', 'stdout');
      r.onLine?.('{"ts":2000,"pid":7,"state":"S","cpu":12.44,"rssKb":2048,"threads":3,"sys":{"cpu":30,"load1":0.5,"memAvailableKb":900}}', 'stdout');
      return new Promise<never>(() => undefined);
    });
    const src = new AppStatsSource(services, { device: 'dev', mode: 'stream', binary: '/usr/bin/harbour-demo', sessions: new DeviceSessions() });
    const updates: StatsUpdate[] = [];
    const events: string[] = [];
    src.onSample((u) => updates.push(u));
    src.onProcess((e) => events.push(`${e.type}:${e.pid}`));
    src.start();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(runs[0].args.includes('--exe'));
    assert.deepEqual(events, ['start:7']);
    assert.equal(updates[0].cpu, 12.4);
    assert.equal(updates[0].sysCpu, 30);
    assert.equal(updates[0].sample.rssKb, 2048);
    src.dispose();
  });
});
