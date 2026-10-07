/**
 * The Device Monitor's App stats source: the agent's `stats` stream (agent 1.10.0+, one long-lived
 * session, 1 s) or, without it, `APP_STATS_SCRIPT` polled over `sfdk device exec` at the configured
 * interval. Polling runs only while the tab is visible and a binary is known. `vscode` is imported
 * for types only; the panel (M-8) injects the setting values and the capability from the probe.
 */

import type * as vscode from 'vscode';
import type { Services } from '../core/services';
import { deviceSessions as defaultSessions, type DeviceSessionHandle, type DeviceSessions } from '../core/deviceSessions';
import { AGENT_BINARY } from '../agent/agentCore';
import { APP_STATS_SCRIPT, cpuPercent, parseAppStatsOutput, parseStatsStreamLine, sysCpuPercent, type AppSample } from './appStats';
import { Emitter } from './logSource';

/** The runner's `NO_TIMEOUT` (0); not imported because that module needs `vscode` at load time. */
const NO_TIMEOUT = 0;

export type StatsMode = 'stream' | 'poll';

export const POLL_INTERVAL_DEFAULT_SEC = 5;
export const POLL_INTERVAL_MIN_SEC = 2;
export const STREAM_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;
/** The agent's `exe` alphabet (`^/[A-Za-z0-9._+/-]{1,255}$`, no `..`). */
export const EXE_RE = /^\/[A-Za-z0-9._+/-]{1,255}$/;

/** The agent's stream when its ping says `stats`, else polling. */
export function chooseStatsMode(stats: boolean | undefined): StatsMode {
  return stats === true ? 'stream' : 'poll';
}

/** `sailfish.monitor.pollIntervalSeconds` in milliseconds: default 5 s, minimum 2 s. */
export function pollIntervalMs(seconds: unknown): number {
  const s = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : POLL_INTERVAL_DEFAULT_SEC;
  return Math.max(POLL_INTERVAL_MIN_SEC, s) * 1000;
}

/** True when `binary` may be passed to the agent or the script (absolute path in the agent's alphabet). */
export function isValidExe(binary: string): boolean {
  return EXE_RE.test(binary) && !binary.includes('..');
}

/** `sfdk` argv of the agent stream. */
export function statsStreamArgs(exe: string, intervalMs: number = STREAM_INTERVAL_MS): string[] {
  return ['device', 'exec', '--', AGENT_BINARY, '--request', 'stats', '--exe', exe, '--interval', String(Math.round(intervalMs))];
}

/** `sfdk` argv of one poll: the fixed script, the binary as a positional argument. */
export function statsPollArgs(binary: string): string[] {
  return ['device', 'exec', '--', 'sh', '-c', APP_STATS_SCRIPT, 'sh', binary];
}

export interface ProcessTransition {
  type: 'start' | 'exit';
  pid: number;
  ts: number;
}

/** Start/exit events implied by two consecutive samples (polling has no event stream). */
export function pidTransitions(prev: AppSample | undefined, cur: AppSample): ProcessTransition[] {
  const before = prev?.pid ?? 0;
  if (before === cur.pid) return [];
  const out: ProcessTransition[] = [];
  if (before > 0) out.push({ type: 'exit', pid: before, ts: cur.ts });
  if (cur.pid > 0) out.push({ type: 'start', pid: cur.pid, ts: cur.ts });
  return out;
}

/** One sample as the panel shows it. */
export interface StatsUpdate {
  sample: AppSample;
  /** Percent of one core; undefined for the first polled sample. */
  cpu?: number;
  sysCpu?: number;
  load1?: number;
  memAvailableKb?: number;
  startedMs?: number;
}

export interface StatsEnd {
  reason: 'error' | 'stopped' | 'ended';
  text: string;
}

export interface StatsSourceOptions {
  device: string;
  mode: StatsMode;
  /** The app's binary path; settable later with `setBinary`. */
  binary?: string;
  /** Polling interval in ms (`pollIntervalMs`). */
  intervalMs?: number;
  /** The app name for the registry label, e.g. `harbour-demo`. */
  app?: string;
  sessions?: DeviceSessions;
  now?: () => number;
}

type Services_ = Pick<Services, 'runner' | 'output'>;

function makeToken(): { cancel(): void; token: vscode.CancellationToken } {
  let cancelled = false;
  const listeners = new Set<() => void>();
  return {
    cancel: () => {
      cancelled = true;
      for (const l of [...listeners]) l();
    },
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: (l: () => void) => {
        listeners.add(l);
        return { dispose: () => void listeners.delete(l) };
      },
    } as unknown as vscode.CancellationToken,
  };
}

export class AppStatsSource {
  private readonly sampleEmitter = new Emitter<StatsUpdate>();
  private readonly processEmitter = new Emitter<ProcessTransition>();
  private readonly endEmitter = new Emitter<StatsEnd>();
  readonly onSample = this.sampleEmitter.event;
  readonly onProcess = this.processEmitter.event;
  readonly onEnd = this.endEmitter.event;

  private binary: string | undefined;
  private visible = true;
  private started = false;
  private disposed = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: { cancel(): void } | undefined;
  private registration: DeviceSessionHandle | undefined;
  private prev: AppSample | undefined;
  private lastError = '';

  constructor(
    private readonly services: Services_,
    private readonly opts: StatsSourceOptions,
  ) {
    this.binary = opts.binary;
  }

  get mode(): StatsMode {
    return this.opts.mode;
  }

  /** Registers `('monitor','app monitor')` and starts; polling waits for a binary and for visibility. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    this.registration = (this.opts.sessions ?? defaultSessions).register(this.opts.device, 'monitor', 'app monitor', () => {
      this.dispose();
      return Promise.resolve();
    });
    this.run();
  }

  /** A new or changed binary restarts the stream/poll; undefined stops polling until one is known. */
  setBinary(binary: string | undefined): void {
    if (binary === this.binary) return;
    this.binary = binary;
    this.prev = undefined;
    if (this.started && !this.disposed) this.run();
  }

  /** Hidden tab: no polling tick runs (the stream keeps going, it costs nothing per sample). */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (this.opts.mode === 'poll' && this.started && !this.disposed && visible) this.run();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRun();
    this.registration?.dispose();
    this.registration = undefined;
  }

  private cancelRun(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.inFlight?.cancel();
    this.inFlight = undefined;
  }

  private run(): void {
    this.cancelRun();
    const binary = this.binary;
    if (!binary || !isValidExe(binary)) return;
    if (this.opts.mode === 'stream') void this.stream(binary, this.generation);
    else if (this.visible) void this.poll(binary, this.generation);
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private emit(update: StatsUpdate): void {
    for (const t of pidTransitions(this.prev, update.sample)) this.processEmitter.fire(t);
    this.prev = update.sample;
    this.sampleEmitter.fire(update);
  }

  private async stream(binary: string, gen: number): Promise<void> {
    const ctl = makeToken();
    this.inFlight = ctl;
    this.lastError = '';
    try {
      const result = await this.services.runner.run({
        args: statsStreamArgs(binary),
        device: this.opts.device,
        timeoutMs: NO_TIMEOUT,
        token: ctl.token,
        collectOutput: false,
        onLine: (line, stream) => {
          if (gen !== this.generation) return;
          if (stream === 'stderr') {
            if (line.trim()) this.lastError = line.trim();
            return;
          }
          const item = parseStatsStreamLine(line, this.now());
          if (!item) {
            const err = /"error"\s*:\s*"([^"]{1,200})"/.exec(line);
            if (err) this.lastError = err[1];
            return;
          }
          if (item.type === 'sample') {
            // The stream carries its own CPU numbers; transitions come as events as well, so only
            // the sample is forwarded and `prev` is kept for the pid check.
            this.prev = item.sample;
            const update: StatsUpdate = { sample: item.sample };
            if (item.cpu !== undefined) update.cpu = item.cpu;
            if (item.sysCpuPct !== undefined) update.sysCpu = item.sysCpuPct;
            if (item.load1 !== undefined) update.load1 = item.load1;
            if (item.memAvailableKb !== undefined) update.memAvailableKb = item.memAvailableKb;
            if (item.startedMs !== undefined) update.startedMs = item.startedMs;
            this.sampleEmitter.fire(update);
          } else {
            this.processEmitter.fire({ type: item.type, pid: item.pid, ts: item.ts });
          }
        },
      });
      if (gen !== this.generation) return;
      this.inFlight = undefined;
      if (result.cancelled) return;
      this.endEmitter.fire({
        reason: result.exitCode !== 0 ? 'error' : 'ended',
        text: this.lastError || (result.exitCode !== 0 ? `the stats stream ended with exit ${result.exitCode}` : 'The stats stream ended.'),
      });
    } catch (err) {
      if (gen !== this.generation) return;
      const message = err instanceof Error ? err.message : String(err);
      this.services.output.log('error', `app stats: ${message}`);
      this.endEmitter.fire({ reason: 'error', text: message });
    }
  }

  private async poll(binary: string, gen: number): Promise<void> {
    const ctl = makeToken();
    this.inFlight = ctl;
    const started = this.now();
    try {
      const result = await this.services.runner.run({
        args: statsPollArgs(binary),
        device: this.opts.device,
        timeoutMs: POLL_TIMEOUT_MS,
        token: ctl.token,
      });
      if (gen !== this.generation) return;
      this.inFlight = undefined;
      if (result.exitCode === 0) {
        const sample = parseAppStatsOutput(result.stdout, this.now());
        if (sample) {
          const update: StatsUpdate = { sample };
          const cpu = cpuPercent(this.prev, sample);
          if (cpu !== undefined) update.cpu = cpu;
          const sys = sysCpuPercent(this.prev?.sys, sample.sys);
          if (sys !== undefined) update.sysCpu = sys;
          this.emit(update);
        }
      } else if (!result.cancelled) {
        this.services.output.log('warn', `app stats poll failed (exit ${result.exitCode}): ${result.stderr.trim().split(/\r?\n/)[0] ?? ''}`);
      }
    } catch (err) {
      if (gen !== this.generation) return;
      this.services.output.log('error', `app stats: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (gen !== this.generation) return;
    // The next tick is scheduled after this one finished, so slow links never overlap polls.
    const wait = Math.max(0, (this.opts.intervalMs ?? POLL_INTERVAL_DEFAULT_SEC * 1000) - (this.now() - started));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (gen === this.generation && this.visible) void this.poll(binary, gen);
    }, wait);
  }
}
