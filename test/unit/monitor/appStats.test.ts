import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  APP_STATS_SCRIPT,
  AppCounter,
  cpuPercent,
  describeExit,
  formatCounters,
  formatRss,
  formatUptime,
  isCrash,
  parseAppStatsOutput,
  parseProcStat,
  parseStatsStreamLine,
  parseSysCpu,
  parseUptimeSec,
  parseVmRssKb,
  signalName,
  sysCpuPercent,
} from '../../../src/monitor/appStats';

// fields 3..52 after the comm; utime=field 14, stime=15, threads=20, starttime=22
function statLine(pid: number, comm: string, utime: number, stime: number, threads = 9, start = 1000): string {
  const f: (string | number)[] = [];
  for (let n = 3; n <= 52; n++) f.push(0);
  f[0] = 'S';
  f[14 - 3] = utime;
  f[15 - 3] = stime;
  f[20 - 3] = threads;
  f[22 - 3] = start;
  return `${pid} (${comm}) ${f.join(' ')}`;
}

const STATUS = 'Name:\tharbour-demo\nState:\tS (sleeping)\nVmPeak:\t  99999 kB\nVmRSS:\t   48216 kB\nThreads:\t9\n';

function pollOutput(pid: number, utime: number, uptime = 1500.5): string {
  return [`pid ${pid}`, statLine(pid, 'harbour-demo', utime, 0), '--', STATUS.trimEnd(), '--', `${uptime} 4000.1`, 'cpu  100 0 50 800 10 0 5 0 0 0'].join('\n');
}

describe('parseProcStat', () => {
  it('parses a plain line', () => {
    assert.deepStrictEqual(parseProcStat(statLine(4321, 'harbour-demo', 120, 30)), {
      pid: 4321,
      comm: 'harbour-demo',
      state: 'S',
      cpuTicks: 150,
      threads: 9,
      startTicks: 1000,
    });
  });
  it('survives a comm with spaces and parentheses', () => {
    const p = parseProcStat(statLine(7, 'my (weird) app )', 5, 6, 3, 42));
    assert.strictEqual(p?.comm, 'my (weird) app )');
    assert.strictEqual(p?.cpuTicks, 11);
    assert.strictEqual(p?.threads, 3);
    assert.strictEqual(p?.startTicks, 42);
  });
  it('rejects garbage and short lines', () => {
    for (const bad of ['', 'x', '12 (a) S 1 2', '0 (a) ' + 'S 0 '.repeat(30), 'abc (a) S', ')(']) {
      assert.strictEqual(parseProcStat(bad), undefined, bad);
    }
  });
});

describe('small /proc parsers', () => {
  it('reads VmRSS, uptime and the system cpu line', () => {
    assert.strictEqual(parseVmRssKb(STATUS), 48216);
    assert.strictEqual(parseVmRssKb('Name: x\n'), undefined);
    assert.strictEqual(parseUptimeSec('1500.50 4000.10\n'), 1500.5);
    assert.strictEqual(parseUptimeSec('x'), undefined);
    assert.deepStrictEqual(parseSysCpu('cpu  100 0 50 800 10 0 5 0 0 0'), { total: 965, idle: 810 });
    assert.strictEqual(parseSysCpu('cpu0 1 2 3 4'), undefined);
    assert.strictEqual(parseSysCpu('cpu  a b c d'), undefined);
  });
});

describe('parseAppStatsOutput', () => {
  it('parses a running app', () => {
    const s = parseAppStatsOutput(pollOutput(4321, 200), 5000);
    assert.deepStrictEqual(s, {
      pid: 4321,
      ts: 5000,
      state: 'S',
      comm: 'harbour-demo',
      cpuTicks: 200,
      threads: 9,
      rssKb: 48216,
      uptimeSec: 1500.5 - 10,
      sys: { total: 965, idle: 810 },
    });
  });
  it('parses "pid 0" with the system line', () => {
    assert.deepStrictEqual(parseAppStatsOutput('pid 0\ncpu  1 2 3 4 5 6 7 8\n', 9), { pid: 0, ts: 9, sys: { total: 36, idle: 9 } });
    assert.deepStrictEqual(parseAppStatsOutput('pid 0\n', 9), { pid: 0, ts: 9 });
  });
  it('keeps the pid of a truncated or garbled output and rejects non-output', () => {
    assert.deepStrictEqual(parseAppStatsOutput('pid 12\n', 1), { pid: 12, ts: 1 });
    assert.strictEqual(parseAppStatsOutput('pid 12\nnot a stat line\n--\n--\n', 1)?.cpuTicks, undefined);
    assert.strictEqual(parseAppStatsOutput('', 1), undefined);
    assert.strictEqual(parseAppStatsOutput('sh: pgrep: not found', 1), undefined);
  });
  it('takes the thread count from status when stat is unusable', () => {
    const s = parseAppStatsOutput('pid 5\ngarbage\n--\nThreads:\t4\nVmRSS:\t10 kB\n--\n', 1);
    assert.strictEqual(s?.threads, 4);
    assert.strictEqual(s?.rssKb, 10);
  });
  it('passes the binary only as a positional argument', () => {
    assert.ok(APP_STATS_SCRIPT.includes('"$1"'));
    assert.ok(!APP_STATS_SCRIPT.includes('pgrep'), 'busybox pgrep -x -f misses invoker-started apps (T4-3)');
    assert.ok(!APP_STATS_SCRIPT.includes('harbour'));
  });
  it('finds the process whose first argument is the binary, not the shell that runs the script', function () {
    if (process.platform !== 'linux' || !fs.existsSync('/proc/self/comm')) return this.skip();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-stats-'));
    const binary = path.join(dir, 'harbour-demo');
    fs.copyFileSync('/bin/sleep', binary);
    fs.chmodSync(binary, 0o755);
    const child = spawn(binary, ['30'], { stdio: 'ignore' });
    try {
      const deadline = Date.now() + 2000;
      let out = '';
      while (Date.now() < deadline) {
        out = execFileSync('sh', ['-c', APP_STATS_SCRIPT, 'sh', binary], { encoding: 'utf8' });
        if (out.startsWith(`pid ${child.pid}\n`)) break;
      }
      assert.ok(out.startsWith(`pid ${child.pid}\n`), out.slice(0, 200));
      assert.strictEqual(parseAppStatsOutput(out, 1)?.pid, child.pid);
      const none = execFileSync('sh', ['-c', APP_STATS_SCRIPT, 'sh', path.join(dir, 'not-running')], { encoding: 'utf8' });
      assert.ok(none.startsWith('pid 0\n'), none);
    } finally {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cpu arithmetic', () => {
  it('computes percent of one core over two samples; the first shows nothing', () => {
    const a = parseAppStatsOutput(pollOutput(4321, 200), 10_000)!;
    const b = parseAppStatsOutput(pollOutput(4321, 250), 15_000)!;
    assert.strictEqual(cpuPercent(undefined, a), undefined);
    assert.strictEqual(cpuPercent(a, b), 10); // 50 ticks = 0.5 s of 5 s
  });
  it('gives nothing across a pid change, a reset counter, zero wall time or pid 0', () => {
    const a = parseAppStatsOutput(pollOutput(1, 200), 10_000)!;
    assert.strictEqual(cpuPercent(a, parseAppStatsOutput(pollOutput(2, 300), 15_000)!), undefined);
    assert.strictEqual(cpuPercent(a, parseAppStatsOutput(pollOutput(1, 100), 15_000)!), undefined);
    assert.strictEqual(cpuPercent(a, parseAppStatsOutput(pollOutput(1, 300), 10_000)!), undefined);
    assert.strictEqual(cpuPercent({ pid: 0, ts: 1 }, a), undefined);
  });
  it('computes the device total from jiffies', () => {
    assert.strictEqual(sysCpuPercent({ total: 1000, idle: 800 }, { total: 1200, idle: 900 }), 50);
    assert.strictEqual(sysCpuPercent({ total: 1, idle: 1 }, { total: 1, idle: 1 }), undefined);
    assert.strictEqual(sysCpuPercent(undefined, { total: 1, idle: 1 }), undefined);
  });
  it('formats uptime and memory', () => {
    assert.strictEqual(formatUptime(75.9), '1:15');
    assert.strictEqual(formatUptime(3725), '1:02:05');
    assert.strictEqual(formatUptime(undefined), '—');
    assert.strictEqual(formatUptime(-1), '—');
    assert.strictEqual(formatRss(48216), '47.1 MB');
    assert.strictEqual(formatRss(512), '512 kB');
    assert.strictEqual(formatRss(undefined), '—');
  });
});

describe('parseStatsStreamLine', () => {
  it('parses a sample with the system block', () => {
    const line =
      '{"ts":1733500000123,"pid":4321,"state":"S","cpu":12.44,"rssKb":48216,"threads":9,"started":1733499990000,' +
      '"sys":{"cpu":31.0,"load1":0.82,"memAvailableKb":812000}}';
    const item = parseStatsStreamLine(line);
    assert.deepStrictEqual(item, {
      type: 'sample',
      sample: { pid: 4321, ts: 1733500000123, state: 'S', threads: 9, rssKb: 48216, uptimeSec: 10.123 },
      cpu: 12.4,
      startedMs: 1733499990000,
      sysCpuPct: 31,
      load1: 0.82,
      memAvailableKb: 812000,
    });
  });
  it('parses the not-running sample and the events', () => {
    assert.deepStrictEqual(parseStatsStreamLine('{"ts":5,"pid":0,"sys":{"cpu":1}}'), {
      type: 'sample',
      sample: { pid: 0, ts: 5 },
      sysCpuPct: 1,
    });
    assert.deepStrictEqual(parseStatsStreamLine('{"event":"start","pid":4322,"ts":7}'), { type: 'start', pid: 4322, ts: 7 });
    assert.deepStrictEqual(parseStatsStreamLine('{"event":"exit","pid":4321}', 99), { type: 'exit', pid: 4321, ts: 99 });
  });
  it('ignores anything unusable', () => {
    for (const bad of ['', 'garbage', '{', '[]', '{"pid":"x"}', '{"event":"start"}', '{"event":"exit","pid":-1}', '{"ok":true,"stream":"stats"}', '{"pid":1.5}']) {
      assert.strictEqual(parseStatsStreamLine(bad), undefined, bad);
    }
  });
  it('drops negative or non-finite numbers', () => {
    const item = parseStatsStreamLine('{"ts":1,"pid":3,"cpu":-5,"rssKb":"x","sys":{"cpu":-1}}');
    assert.deepStrictEqual(item, { type: 'sample', sample: { pid: 3, ts: 1 } });
  });
});

describe('exit classification and counters', () => {
  it('knows signal names', () => {
    assert.strictEqual(signalName(11), 'SIGSEGV');
    assert.strictEqual(signalName(6), 'SIGABRT');
    assert.strictEqual(signalName(99), undefined);
  });
  it('classifies exits', () => {
    assert.ok(!isCrash({}));
    assert.ok(!isCrash({ code: 0 }));
    assert.ok(isCrash({ code: 1 }));
    assert.ok(isCrash({ signal: 'SIGSEGV' }));
    assert.ok(isCrash({ coredump: true, code: 0 }));
    assert.strictEqual(describeExit({ code: 0 }), 'exited with code 0');
    assert.strictEqual(describeExit({}), 'exited');
    assert.strictEqual(describeExit({ signal: 11 }), 'crashed (SIGSEGV)');
    assert.strictEqual(describeExit({ signal: 77 }), 'crashed (signal 77)');
    assert.strictEqual(describeExit({ code: 139 }), 'crashed (exit code 139)');
    assert.strictEqual(describeExit({ coredump: true }), 'crashed');
  });
  it('counts a restart only for a new pid while a session is active', () => {
    const c = new AppCounter();
    assert.strictEqual(c.pidSeen(0, true), false);
    assert.strictEqual(c.pidSeen(10, true), false); // first
    assert.strictEqual(c.pidSeen(10, true), false);
    assert.strictEqual(c.pidSeen(0, true), false);
    assert.strictEqual(c.pidSeen(11, true), true);
    assert.strictEqual(c.pidSeen(12, false), false);
    assert.deepStrictEqual(c.value, { restarts: 1, crashes: 0 });
  });
  it('counts a crash once per pid even when the terminal and the coredump both report it', () => {
    const c = new AppCounter();
    c.pidSeen(10, true);
    assert.strictEqual(c.exited(10, { code: 0 }), false);
    assert.strictEqual(c.exited(10, { code: 139 }), true);
    assert.strictEqual(c.exited(10, { coredump: true, signal: 'SIGSEGV' }), false);
    assert.strictEqual(c.exited(undefined, { signal: 'SIGABRT' }), false); // terminal line for the same last pid
    c.pidSeen(11, true);
    assert.strictEqual(c.exited(undefined, { code: 1 }), true);
    assert.deepStrictEqual(c.value, { restarts: 1, crashes: 2 });
    assert.strictEqual(formatCounters(c.value), 'restarts 1 · crashes 2');
  });
  it('counts crashes whose pid was never seen', () => {
    const c = new AppCounter();
    assert.strictEqual(c.exited(undefined, { code: 2 }), true);
    assert.strictEqual(c.exited(undefined, { code: 2 }), true);
  });
});
