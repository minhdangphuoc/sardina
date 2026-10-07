/**
 * The Device Monitor's log source: streams the device agent's `logs` request, turns lines into
 * journal entries and delivers them in batches. It imports `vscode` for types only (the pure helpers
 * and the class are unit tested under plain mocha); the panel (M-8) injects the probe, the client
 * arguments and the setting values, and pauses/resumes it around agent installs.
 *
 * Refusals (`logs disabled on the phone`, `stopped from the phone`) end the stream with the
 * `describeAgentRefusal` text; the monitor never reads the journal through the SSH login itself.
 */

import type * as vscode from 'vscode';
import type { Services } from '../core/services';
import { deviceSessions as defaultSessions, type DeviceSessionHandle, type DeviceSessions } from '../core/deviceSessions';
import { AGENT_BINARY, describeAgentRefusal, parseAgentReply, phoneRefusal, type AgentProbe } from '../agent/agentCore';
import { stripAnsi } from './displayText';
import { capMessage, markerEntry, parseJournalJsonLine, parseShortPreciseLine, type JournalEntry } from './logModel';

/** The runner's `NO_TIMEOUT` (0); not imported because that module needs `vscode` at load time. */
const NO_TIMEOUT = 0;

export type LogFormat = 'text' | 'json';

export const LOG_LINES_MIN = 1;
export const LOG_LINES_MAX = 10_000;
export const LOG_LINES_DEFAULT = 200;
/** Entries per `onEntries` call at most (the page protocol's MAX_BATCH_ENTRIES). */
export const LOG_BATCH_MAX = 500;
const LOG_BATCH_MS = 50;
/** Cursors the agent accepts (`^[A-Za-z0-9;=:._-]{1,512}$`); anything else is not sent. */
export const CURSOR_RE = /^[A-Za-z0-9;=:._-]{1,512}$/;
const SEEK_FAILED_RE = /failed to seek to cursor|cursor .* not found|failed to seek/i;

/** Minimal typed event, so the module needs no `vscode` runtime. */
export class Emitter<T> {
  private readonly listeners = new Set<(e: T) => void>();
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // a faulty listener must not stop the stream
      }
    }
  }
}

/** `format:"json"` only when the agent's ping lists it (agent 1.10.0+), else the text stream. */
export function chooseLogFormat(logFormats: readonly string[] | undefined): LogFormat {
  return logFormats?.includes('json') ? 'json' : 'text';
}

/** The `sailfish.monitor.logLines` value as the agent's 1..10000 range; non-numbers give the default. */
export function clampLogLines(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return LOG_LINES_DEFAULT;
  return Math.min(LOG_LINES_MAX, Math.max(LOG_LINES_MIN, Math.floor(n)));
}

export interface LogRequestOptions {
  format: LogFormat;
  lines: number;
  /** Resume cursor; used only in JSON mode and only when the agent would accept it. */
  after?: string;
  /** Extra words such as `['--client', 'host']`. */
  clientArgs?: readonly string[];
}

/** The `sfdk` argv for one log stream (argv array, never a shell string). */
export function logRequestArgs(o: LogRequestOptions): string[] {
  const args = ['device', 'exec', '--', AGENT_BINARY, '--request', 'logs'];
  const after = o.format === 'json' && o.after !== undefined && CURSOR_RE.test(o.after) ? o.after : undefined;
  // With a cursor the agent resumes after it; `-n` would only add noise.
  if (after === undefined) args.push('--lines', String(clampLogLines(o.lines)));
  if (o.format === 'json') args.push('--format', 'json');
  if (after !== undefined) args.push('--after', after);
  if (o.clientArgs) args.push(...o.clientArgs);
  return args;
}

export type LogLine =
  | { kind: 'entry'; entry: JournalEntry }
  | { kind: 'end'; error: string; text: string }
  | { kind: 'seekFailed' }
  | { kind: 'skip' };

/** Reads the end-of-stream line `{"ok":false,"error":…}`; undefined for anything else. */
function endLine(text: string): string | undefined {
  if (!text.startsWith('{')) return undefined;
  const reply = parseAgentReply(text);
  return reply && !reply.ok && reply.error ? reply.error : undefined;
}

/**
 * One stdout line of the stream as an entry, the stream's end, a failed cursor seek or nothing.
 * ANSI sequences are removed first and the message is capped at 16 KiB.
 */
export function classifyLogLine(raw: string, format: LogFormat, now: number = Date.now()): LogLine {
  const line = stripAnsi(raw).replace(/\r$/, '');
  if (line.trim() === '') return { kind: 'skip' };
  const error = endLine(line.trim());
  if (error !== undefined) return { kind: 'end', error, text: describeAgentRefusal(error) };
  if (format === 'json') {
    const entry = parseJournalJsonLine(line, now);
    if (entry.source === 'agent' && SEEK_FAILED_RE.test(entry.message)) return { kind: 'seekFailed' };
    return { kind: 'entry', entry: capEntry(entry) };
  }
  return { kind: 'entry', entry: capEntry(parseShortPreciseLine(line, now)) };
}

function capEntry(e: JournalEntry): JournalEntry {
  // JSON escapes ESC as \u001b, so the sequences only appear after parsing.
  const message = capMessage(stripAnsi(e.message));
  return message === e.message ? e : { ...e, message };
}

export type LogEndReason = 'refused' | 'error' | 'stopped' | 'ended';

export interface LogEnd {
  reason: LogEndReason;
  /** User-facing text for `refused`/`error`/`ended`; empty for `stopped`. */
  text: string;
  /** For `refused`: the agent's error string, e.g. `logs disabled on the phone` or `stopped from the phone`. */
  agentError?: string;
}

export interface LogSourceOptions {
  device: string;
  /** From the probe (`chooseLogFormat`). */
  format: LogFormat;
  /** `sailfish.monitor.logLines`: the initial tail (read by the panel in M-8). */
  logLines: number;
  /** `['--client', name]` words; empty when the host name is unusable. */
  clientArgs?: readonly string[];
  /** The agent probe (ping), used to refuse before starting when the phone has logs off. */
  probe?: () => Promise<AgentProbe>;
  sessions?: DeviceSessions;
  /** Clock for entries without a timestamp; tests inject it. */
  now?: () => number;
}

type Services_ = Pick<Services, 'runner' | 'output'>;

/**
 * Streams one device's journal. `start()` resolves once the stream was started (or refused);
 * `onEnd` fires when it ends for any reason except `pause()`.
 */
export class JournalLogSource {
  private readonly entriesEmitter = new Emitter<JournalEntry[]>();
  private readonly endEmitter = new Emitter<LogEnd>();
  readonly onEntries = this.entriesEmitter.event;
  readonly onEnd = this.endEmitter.event;

  private cursor: string | undefined;
  private pending: JournalEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cts: { cancel(): void; token: vscode.CancellationToken } | undefined;
  private registration: DeviceSessionHandle | undefined;
  private paused = false;
  private disposed = false;
  private generation = 0;
  private lastError = '';

  constructor(
    private readonly services: Services_,
    private readonly opts: LogSourceOptions,
  ) {}

  get running(): boolean {
    return this.cts !== undefined;
  }

  /** The last journal cursor seen (JSON mode); resume uses it. */
  get lastCursor(): string | undefined {
    return this.cursor;
  }

  /** Starts streaming; a second call while running is a no-op. Returns false when the phone refuses. */
  async start(): Promise<boolean> {
    if (this.disposed || this.running) return this.running;
    this.paused = false;
    if (this.opts.probe) {
      const probeResult = await this.opts.probe();
      const refusal = phoneRefusal(probeResult, 'logs');
      if (refusal) {
        this.endEmitter.fire({ reason: 'refused', text: refusal, agentError: 'logs disabled on the phone' });
        return false;
      }
      if (this.disposed) return false;
    }
    void this.stream(this.cursor !== undefined && this.opts.format === 'json' ? this.cursor : undefined);
    return true;
  }

  /** Stops the stream without reporting an end (for agent installs, a hidden tab); `resume()` continues from the cursor. */
  pause(): void {
    this.paused = true;
    this.halt();
  }

  /** Continues after `pause()`: JSON mode resumes after the last cursor, text mode restarts with the initial tail. */
  async resume(): Promise<boolean> {
    if (this.disposed) return false;
    const hadCursor = this.cursor !== undefined && this.opts.format === 'json';
    const ok = await this.start();
    if (ok && !hadCursor) this.push(markerEntry({ type: 'resumed' }, this.now()));
    return ok;
  }

  /** Ends the stream and the registry entry; no `onEnd`. */
  dispose(): void {
    this.disposed = true;
    this.halt();
    this.pending = [];
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private halt(): void {
    this.generation++;
    this.cts?.cancel();
    this.cts = undefined;
    this.registration?.dispose();
    this.registration = undefined;
    this.flush();
  }

  private push(entry: JournalEntry): void {
    this.pending.push(entry);
    if (this.pending.length >= LOG_BATCH_MAX) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), LOG_BATCH_MS);
  }

  /** Delivers what is buffered, in batches of at most 500. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, LOG_BATCH_MAX);
      this.entriesEmitter.fire(batch);
    }
  }

  private async stream(after: string | undefined): Promise<void> {
    const gen = ++this.generation;
    let cancelled = false;
    const listeners = new Set<() => void>();
    const cts = {
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
    this.cts = cts;
    this.lastError = '';
    this.registration = (this.opts.sessions ?? defaultSessions).register(this.opts.device, 'logs', 'device logs', () => {
      this.dispose();
      return Promise.resolve();
    });
    let end: LogEnd | undefined;
    let retryWithoutCursor = false;
    try {
      const result = await this.services.runner.run({
        args: logRequestArgs({
          format: this.opts.format,
          lines: this.opts.logLines,
          after,
          clientArgs: this.opts.clientArgs,
        }),
        device: this.opts.device,
        timeoutMs: NO_TIMEOUT,
        token: cts.token,
        collectOutput: false,
        onLine: (line, stream) => {
          if (gen !== this.generation) return;
          if (stream === 'stderr') {
            if (line.trim()) this.lastError = stripAnsi(line).trim();
            return;
          }
          const parsed = classifyLogLine(line, this.opts.format, this.now());
          switch (parsed.kind) {
            case 'entry':
              if (parsed.entry.cursor) this.cursor = parsed.entry.cursor;
              this.push(parsed.entry);
              break;
            case 'end':
              end = { reason: 'refused', text: parsed.text, agentError: parsed.error };
              break;
            case 'seekFailed':
              retryWithoutCursor = true;
              break;
            case 'skip':
              break;
          }
        },
      });
      if (gen !== this.generation) return;
      if (retryWithoutCursor && after !== undefined) {
        // The cursor no longer exists: reconnect with the initial tail and say entries may be missing.
        this.cursor = undefined;
        this.registration.dispose();
        this.cts = undefined;
        this.push(markerEntry({ type: 'resumed' }, this.now()));
        void this.stream(undefined);
        return;
      }
      if (!end) {
        if (result.cancelled) end = { reason: 'stopped', text: '' };
        else if (result.exitCode !== 0) {
          end = { reason: 'error', text: this.lastError || `the log stream ended with exit ${result.exitCode}` };
        } else end = { reason: 'ended', text: 'The log stream ended.' };
      }
    } catch (err) {
      if (gen !== this.generation) return;
      const message = err instanceof Error ? err.message : String(err);
      this.services.output.log('error', `device logs: ${message}`);
      end = { reason: 'error', text: message };
    }
    // Reached only by the live generation: a pause/dispose bumped it and returned above.
    this.registration?.dispose();
    this.registration = undefined;
    this.cts = undefined;
    this.flush();
    if (!this.paused && !this.disposed && end) this.endEmitter.fire(end);
  }
}
