/**
 * Pure parsers and counters for the Device Monitor's App section: the polling script's output
 * (`/proc/<pid>/stat`, `status`, `uptime`), the agent's stats stream, CPU arithmetic and the
 * restart/crash counters. No `vscode` import, so it is unit tested directly.
 */

/**
 * Run as `sh -c APP_STATS_SCRIPT sh <binary>`: the binary is a positional argument, never part of
 * the script text. `pgrep -x -f` matches the whole command line, so the remote shell that runs the
 * script is not matched.
 */
export const APP_STATS_SCRIPT = [
  `p=$(pgrep -x -f "$1" | head -n 1); [ -n "$p" ] || { echo 'pid 0'; head -n 1 /proc/stat; exit 0; }`,
  `echo "pid $p"; cat /proc/$p/stat; echo '--'; cat /proc/$p/status; echo '--'; cat /proc/uptime; head -n 1 /proc/stat`,
].join('\n');

/** Kernel clock ticks per second; 100 on every Sailfish OS target. */
export const CLOCK_TICKS_PER_SECOND = 100;

export interface ProcStat {
  pid: number;
  comm: string;
  state: string;
  /** utime + stime, in clock ticks. */
  cpuTicks: number;
  threads: number;
  /** Field 22: process start, in clock ticks after boot. */
  startTicks: number;
}

export interface SysCpu {
  /** Sum of all jiffies of the first `cpu` line. */
  total: number;
  idle: number;
}

export interface AppSample {
  pid: number;
  state?: string;
  comm?: string;
  cpuTicks?: number;
  threads?: number;
  rssKb?: number;
  /** Seconds since the process started. */
  uptimeSec?: number;
  sys?: SysCpu;
  /** Host clock of the sample in ms; set by the caller. */
  ts: number;
}

/**
 * `/proc/<pid>/stat`. `comm` sits in parentheses and may itself contain spaces and parentheses, so
 * the split is on the last `)`. Returns undefined for anything that is not a stat line.
 */
export function parseProcStat(line: string): ProcStat | undefined {
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  const pid = Number(line.slice(0, open).trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const rest = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0] is field 3 (state); field N is rest[N - 3].
  if (rest.length < 20) return undefined;
  const num = (field: number): number => Number(rest[field - 3]);
  const utime = num(14);
  const stime = num(15);
  const threads = num(20);
  const startTicks = num(22);
  if (![utime, stime, threads, startTicks].every((n) => Number.isFinite(n) && n >= 0)) return undefined;
  return { pid, comm: line.slice(open + 1, close), state: rest[0], cpuTicks: utime + stime, threads, startTicks };
}

/** `VmRSS` of `/proc/<pid>/status` in kB. */
export function parseVmRssKb(status: string): number | undefined {
  const m = /^VmRSS:\s*(\d+)\s*kB/m.exec(status);
  return m ? Number(m[1]) : undefined;
}

/** `Threads:` of `/proc/<pid>/status`. */
export function parseThreads(status: string): number | undefined {
  const m = /^Threads:\s*(\d+)/m.exec(status);
  return m ? Number(m[1]) : undefined;
}

/** First number of `/proc/uptime`, in seconds. */
export function parseUptimeSec(text: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\b/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** The aggregate `cpu ` line of `/proc/stat`. */
export function parseSysCpu(line: string): SysCpu | undefined {
  const m = /^cpu\s+(.+)$/.exec(line.trim());
  if (!m) return undefined;
  const parts = m[1].split(/\s+/).map(Number);
  if (parts.length < 4 || !parts.every((n) => Number.isFinite(n) && n >= 0)) return undefined;
  // user nice system idle iowait irq softirq steal (guest is already inside user)
  const total = parts.slice(0, 8).reduce((a, b) => a + b, 0);
  return { total, idle: (parts[3] ?? 0) + (parts[4] ?? 0) };
}

/**
 * The output of `APP_STATS_SCRIPT`. `pid 0` means not running (the following line is the system
 * CPU line); a truncated or garbled running output still yields the pid with whatever parsed.
 */
export function parseAppStatsOutput(output: string, ts: number): AppSample | undefined {
  const lines = output.split(/\r?\n/);
  const first = /^pid (\d+)\s*$/.exec(lines[0] ?? '');
  if (!first) return undefined;
  const pid = Number(first[1]);
  if (pid === 0) {
    const sys = lines.slice(1).map(parseSysCpu).find((s) => s !== undefined);
    return sys ? { pid: 0, sys, ts } : { pid: 0, ts };
  }
  const sections: string[][] = [[]];
  for (const line of lines.slice(1)) {
    if (line === '--') sections.push([]);
    else sections[sections.length - 1].push(line);
  }
  const stat = parseProcStat(sections[0].join(' '));
  const status = (sections[1] ?? []).join('\n');
  const tail = sections[2] ?? [];
  const uptime = tail.map(parseUptimeSec).find((n) => n !== undefined);
  const sys = tail.map(parseSysCpu).find((s) => s !== undefined);
  const sample: AppSample = { pid, ts };
  if (stat) {
    sample.state = stat.state;
    sample.comm = stat.comm;
    sample.cpuTicks = stat.cpuTicks;
    sample.threads = stat.threads;
    if (uptime !== undefined) sample.uptimeSec = Math.max(0, uptime - stat.startTicks / CLOCK_TICKS_PER_SECOND);
  }
  const rss = parseVmRssKb(status);
  if (rss !== undefined) sample.rssKb = rss;
  const threads = parseThreads(status);
  if (threads !== undefined && sample.threads === undefined) sample.threads = threads;
  if (sys) sample.sys = sys;
  return sample;
}

/** Percent of one core between two samples of the same pid; undefined when it cannot be computed. */
export function cpuPercent(prev: AppSample | undefined, cur: AppSample): number | undefined {
  if (!prev || prev.pid === 0 || prev.pid !== cur.pid) return undefined;
  if (prev.cpuTicks === undefined || cur.cpuTicks === undefined) return undefined;
  const wallSec = (cur.ts - prev.ts) / 1000;
  const ticks = cur.cpuTicks - prev.cpuTicks;
  if (!(wallSec > 0) || ticks < 0) return undefined;
  return round1((ticks / CLOCK_TICKS_PER_SECOND / wallSec) * 100);
}

/** Whole-device CPU percent between two samples, from `/proc/stat` jiffies. */
export function sysCpuPercent(prev: SysCpu | undefined, cur: SysCpu | undefined): number | undefined {
  if (!prev || !cur) return undefined;
  const total = cur.total - prev.total;
  const idle = cur.idle - prev.idle;
  if (!(total > 0) || idle < 0) return undefined;
  return round1(((total - idle) / total) * 100);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Uptime as `m:ss` (`h:mm:ss` from an hour). */
export function formatUptime(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Resident memory for display: `48.2 MB` (kB / 1024). */
export function formatRss(kb: number | undefined): string {
  if (kb === undefined || !Number.isFinite(kb) || kb < 0) return '—';
  return kb >= 1024 ? `${(Math.round((kb / 1024) * 10) / 10).toFixed(1)} MB` : `${Math.round(kb)} kB`;
}

/** Common Linux signal names; undefined for anything else. */
export function signalName(n: number): string | undefined {
  const names: Record<number, string> = {
    1: 'SIGHUP',
    2: 'SIGINT',
    3: 'SIGQUIT',
    4: 'SIGILL',
    5: 'SIGTRAP',
    6: 'SIGABRT',
    7: 'SIGBUS',
    8: 'SIGFPE',
    9: 'SIGKILL',
    10: 'SIGUSR1',
    11: 'SIGSEGV',
    12: 'SIGUSR2',
    13: 'SIGPIPE',
    14: 'SIGALRM',
    15: 'SIGTERM',
  };
  return names[n];
}

// --- agent stats stream (PLAN-device-monitor §4.2) ---

export type StatsStreamItem =
  | { type: 'sample'; sample: AppSample; cpu?: number; sysCpuPct?: number; load1?: number; memAvailableKb?: number; startedMs?: number }
  | { type: 'start'; pid: number; ts: number }
  | { type: 'exit'; pid: number; ts: number };

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * One line of the agent's stats stream: a sample, or a `start`/`exit` event. Anything that is not
 * valid JSON or has no usable shape gives undefined (the caller ignores it).
 */
export function parseStatsStreamLine(line: string, fallbackTs: number = 0): StatsStreamItem | undefined {
  const text = line.trim();
  if (!text.startsWith('{') || text.length > 65536) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  const ts = finiteNumber(o.ts) ?? fallbackTs;
  if (o.event === 'start' || o.event === 'exit') {
    const pid = finiteNumber(o.pid);
    if (pid === undefined || !Number.isInteger(pid) || pid < 0) return undefined;
    return { type: o.event, pid, ts };
  }
  const pid = finiteNumber(o.pid);
  if (pid === undefined || !Number.isInteger(pid) || pid < 0) return undefined;
  const sample: AppSample = { pid, ts };
  const item: Extract<StatsStreamItem, { type: 'sample' }> = { type: 'sample', sample };
  if (typeof o.state === 'string') sample.state = o.state.slice(0, 4);
  const threads = finiteNumber(o.threads);
  if (threads !== undefined) sample.threads = threads;
  const rss = finiteNumber(o.rssKb);
  if (rss !== undefined) sample.rssKb = rss;
  const cpu = finiteNumber(o.cpu);
  if (cpu !== undefined && cpu >= 0) item.cpu = round1(cpu);
  const started = finiteNumber(o.started);
  if (started !== undefined && started > 0) {
    item.startedMs = started;
    if (ts > started) sample.uptimeSec = (ts - started) / 1000;
  }
  const sys = o.sys;
  if (typeof sys === 'object' && sys !== null && !Array.isArray(sys)) {
    const s = sys as Record<string, unknown>;
    const sc = finiteNumber(s.cpu);
    if (sc !== undefined && sc >= 0) item.sysCpuPct = round1(sc);
    const l1 = finiteNumber(s.load1);
    if (l1 !== undefined) item.load1 = l1;
    const mem = finiteNumber(s.memAvailableKb);
    if (mem !== undefined) item.memAvailableKb = mem;
  }
  return item;
}

// --- restarts and crashes ---

/** How an app instance ended, as far as the host knows it. */
export interface ExitInfo {
  /** Exit code of the app terminal's process, when known. */
  code?: number;
  /** Signal name or number, from the terminal or from `COREDUMP_SIGNAL`. */
  signal?: string | number;
  /** True when a `systemd-coredump` journal line named the pid. */
  coredump?: boolean;
}

/** A non-zero code, a signal or a coredump is a crash; code 0 or nothing known is a normal exit. */
export function isCrash(exit: ExitInfo): boolean {
  if (exit.coredump) return true;
  if (exit.signal !== undefined && exit.signal !== '') return true;
  return exit.code !== undefined && exit.code !== 0;
}

export function describeExit(exit: ExitInfo): string {
  const signal = typeof exit.signal === 'number' ? (signalName(exit.signal) ?? `signal ${exit.signal}`) : exit.signal;
  if (isCrash(exit)) {
    if (signal) return `crashed (${signal})`;
    return exit.code !== undefined ? `crashed (exit code ${exit.code})` : 'crashed';
  }
  return exit.code !== undefined ? `exited with code ${exit.code}` : 'exited';
}

export interface AppCounters {
  restarts: number;
  crashes: number;
}

/**
 * Counts restarts and crashes for one panel's lifetime from pid transitions and exit facts.
 * - `pidSeen(pid, sessionActive)`: a pid different from the previous non-zero pid is a restart when
 *   a session is still registered (the app was relaunched under it); the very first pid is not.
 * - `exited(pid, info)`: records the end of `pid`; a crash is counted once per pid even when the
 *   terminal and the coredump line both report it.
 */
export class AppCounter {
  private lastPid = 0;
  private everSeen = false;
  private readonly crashed = new Set<number>();
  private readonly counters: AppCounters = { restarts: 0, crashes: 0 };

  get value(): Readonly<AppCounters> {
    return { ...this.counters };
  }

  /** Reports the pid of a sample or `start` event; 0 means not running. Returns true when it counted a restart. */
  pidSeen(pid: number, sessionActive: boolean): boolean {
    if (pid <= 0) return false;
    const changed = this.everSeen && pid !== this.lastPid;
    this.everSeen = true;
    this.lastPid = pid;
    if (changed && sessionActive) {
      this.counters.restarts++;
      return true;
    }
    return false;
  }

  /** Reports an exit; returns true when it counted a crash. `pid` may be undefined (terminal exit line). */
  exited(pid: number | undefined, info: ExitInfo): boolean {
    if (!isCrash(info)) return false;
    const key = pid ?? this.lastPid;
    if (key > 0) {
      if (this.crashed.has(key)) return false;
      this.crashed.add(key);
    }
    this.counters.crashes++;
    return true;
  }
}

/** `restarts 2 · crashes 1`. */
export function formatCounters(c: Readonly<AppCounters>): string {
  return `restarts ${c.restarts} · crashes ${c.crashes}`;
}
