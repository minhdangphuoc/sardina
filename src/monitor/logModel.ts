/**
 * Pure model of the Device Monitor's device log: journal entries (JSON and `short-precise` text),
 * levels, process markers and the one-line text format of the output channel. No `vscode` import.
 */

import { describeExit, signalName, type ExitInfo } from './appStats';

// --- entries ---

export type LogLevel = 'error' | 'warning' | 'info' | 'debug' | 'unknown' | 'agent' | 'marker';
export type LogSource = 'json' | 'text' | 'agent' | 'marker';

export interface JournalEntry {
  /** Sequence number; 0 for entries parsed from a line. */
  id: number;
  source: LogSource;
  /** Epoch milliseconds. */
  ts: number;
  message: string;
  /** Journal `PRIORITY` 0..7 when known. */
  priority?: number;
  /** `_PID`, else `SYSLOG_PID`. */
  pid?: number;
  syslogPid?: number;
  /** `SYSLOG_IDENTIFIER`, else `_COMM`; empty when neither is known. */
  tag: string;
  comm?: string;
  exe?: string;
  unit?: string;
  transport?: string;
  codeFile?: string;
  codeLine?: number;
  codeFunc?: string;
  category?: string;
  coredumpPid?: number;
  coredumpComm?: string;
  coredumpSignal?: number;
  cursor?: string;
}

export const MAX_MESSAGE_BYTES = 16 * 1024;
export const CUT_SUFFIX = '… [cut]';
export const OMITTED_MESSAGE = '[message longer than 4 KiB; journald omitted it]';
export const EMPTY_MESSAGE = '[no message]';
export const AGENT_TAG = 'journalctl';

/** UTF-8 length of a string without allocating. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Cuts `s` to `maxBytes` of UTF-8 (on a character boundary) and appends `… [cut]`. */
export function capMessage(s: string, maxBytes: number = MAX_MESSAGE_BYTES): string {
  if (s.length * 3 <= maxBytes && s.length <= maxBytes) return s;
  let bytes = 0;
  let i = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let b: number;
    let units = 1;
    if (c < 0x80) b = 1;
    else if (c < 0x800) b = 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      b = 4;
      units = 2;
    } else b = 3;
    if (bytes + b > maxBytes) break;
    bytes += b;
    i += units - 1;
  }
  return i >= s.length ? s : s.slice(0, i) + CUT_SUFFIX;
}

function agentEntry(message: string, ts: number): JournalEntry {
  return { id: 0, source: 'agent', ts, message: capMessage(message), tag: AGENT_TAG };
}

function field(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (typeof v === 'string') return v;
  // journald sends a field that occurs twice as an array of values
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

function intField(o: Record<string, unknown>, key: string): number | undefined {
  const s = field(o, key);
  if (s === undefined || !/^\d{1,10}$/.test(s)) return undefined;
  return Number(s);
}

function decodeMessage(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v === null) return OMITTED_MESSAGE;
  if (Array.isArray(v)) {
    const bytes = Uint8Array.from(v.slice(0, MAX_MESSAGE_BYTES * 4 + 4) as number[]);
    return new TextDecoder('utf-8').decode(bytes);
  }
  return undefined;
}

/**
 * One line of `journalctl -o json`. Needs `MESSAGE` (string, byte array or null) and
 * `__REALTIME_TIMESTAMP` (µs as a string); anything else (journalctl's own stderr, the stream's end
 * line) becomes an `agent` entry tagged `journalctl`. Never throws.
 */
export function parseJournalJsonLine(line: string, now: number = Date.now()): JournalEntry {
  const text = line.replace(/\r$/, '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      obj = undefined;
    }
    if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
      const o = obj as Record<string, unknown>;
      const tsUs = field(o, '__REALTIME_TIMESTAMP');
      if ('MESSAGE' in o && tsUs !== undefined && /^\d{1,20}$/.test(tsUs)) {
        const message = decodeMessage(o.MESSAGE);
        if (message !== undefined) return journalEntry(o, Math.floor(Number(tsUs) / 1000), message);
      }
      // the stream's own `{"ok":false,"error":…}` line, or any other object: show its text
      const err = typeof o.error === 'string' ? o.error : undefined;
      return agentEntry(err ?? trimmed, now);
    }
  }
  return agentEntry(text, now);
}

function journalEntry(o: Record<string, unknown>, ts: number, rawMessage: string): JournalEntry {
  const comm = field(o, '_COMM');
  const ident = field(o, 'SYSLOG_IDENTIFIER');
  const pid = intField(o, '_PID');
  const syslogPid = intField(o, 'SYSLOG_PID');
  const entry: JournalEntry = {
    id: 0,
    source: 'json',
    ts,
    message: capMessage(rawMessage === '' ? EMPTY_MESSAGE : rawMessage),
    tag: ident || comm || '',
  };
  const priority = intField(o, 'PRIORITY');
  if (priority !== undefined && priority <= 7) entry.priority = priority;
  const effectivePid = pid ?? syslogPid;
  if (effectivePid !== undefined) entry.pid = effectivePid;
  if (syslogPid !== undefined) entry.syslogPid = syslogPid;
  if (comm) entry.comm = comm;
  const exe = field(o, '_EXE');
  if (exe) entry.exe = exe;
  const unit = field(o, '_SYSTEMD_UNIT');
  if (unit) entry.unit = unit;
  const transport = field(o, '_TRANSPORT');
  if (transport) entry.transport = transport;
  const codeFile = field(o, 'CODE_FILE');
  if (codeFile) entry.codeFile = codeFile.slice(0, 1024);
  const codeLine = intField(o, 'CODE_LINE');
  if (codeLine !== undefined) entry.codeLine = codeLine;
  const codeFunc = field(o, 'CODE_FUNC');
  if (codeFunc) entry.codeFunc = codeFunc.slice(0, 256);
  const category = field(o, 'QT_CATEGORY');
  if (category) entry.category = category.slice(0, 256);
  const cdPid = intField(o, 'COREDUMP_PID');
  if (cdPid !== undefined) entry.coredumpPid = cdPid;
  const cdComm = field(o, 'COREDUMP_COMM');
  if (cdComm) entry.coredumpComm = cdComm;
  const cdSig = intField(o, 'COREDUMP_SIGNAL');
  if (cdSig !== undefined) entry.coredumpSignal = cdSig;
  const cursor = field(o, '__CURSOR');
  if (cursor && cursor.length <= 512) entry.cursor = cursor;
  return entry;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_PRECISE =
  /^([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))? (\S+) ([^\s:[]+)(?:\[(\d+)\])?: ?(.*)$/s;

/**
 * One line of the text stream (`Oct 05 13:42:01.123456 host ident[pid]: message`, journald's
 * `short-precise`). The line has no year, so `now` supplies it; the time is local. The level is
 * unknown. A line that does not fit (journal banners, errors) becomes an `agent` entry.
 */
export function parseShortPreciseLine(line: string, now: number = Date.now()): JournalEntry {
  const text = line.replace(/\r$/, '');
  const m = SHORT_PRECISE.exec(text);
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (!m || month < 0) return agentEntry(text, now);
  const year = new Date(now).getFullYear();
  const micros = m[6] ? Number(m[6].padEnd(6, '0')) : 0;
  const ts = new Date(year, month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Math.floor(micros / 1000)).getTime();
  const entry: JournalEntry = {
    id: 0,
    source: 'text',
    ts: Number.isFinite(ts) ? ts : now,
    message: capMessage(m[10] === '' ? EMPTY_MESSAGE : m[10]),
    tag: m[8],
  };
  if (m[9] !== undefined) {
    entry.pid = Number(m[9]);
    entry.syslogPid = entry.pid;
  }
  return entry;
}

// --- levels ---

interface DeriveRule {
  level: 'error' | 'warning';
  pattern: RegExp;
}

/** Message text that lifts a priority-6 stdout line to a warning or an error (D9). Errors first. */
export const DERIVE_RULES: readonly DeriveRule[] = [
  { level: 'error', pattern: /\b(?:ReferenceError|TypeError|SyntaxError)\b/ },
  { level: 'error', pattern: /\bis not a type\b/ },
  { level: 'error', pattern: /\bCannot assign\b/ },
  { level: 'error', pattern: /^(?:qml: )?(?:Error|Critical|Fatal):/i },
  { level: 'warning', pattern: /^(?:qml: )?Warning:/i },
  { level: 'warning', pattern: /\bBinding loop detected\b/ },
  { level: 'warning', pattern: /\bUnable to assign\b/ },
];

/**
 * 0..3 error, 4 warning, 5 and 6 info, 7 debug; unknown when there is no priority; `agent` and
 * `marker` for synthetic rows. With `deriveFromText`, a priority-6 line that came through
 * `_TRANSPORT=stdout` is lifted by `DERIVE_RULES`.
 */
export function levelOf(entry: JournalEntry, deriveFromText: boolean = false): LogLevel {
  if (entry.source === 'marker') return 'marker';
  if (entry.source === 'agent') return 'agent';
  const p = entry.priority;
  if (p === undefined) return 'unknown';
  if (p <= 3) return 'error';
  if (p === 4) return 'warning';
  if (p <= 6) {
    if (deriveFromText && p === 6 && entry.transport === 'stdout') {
      for (const rule of DERIVE_RULES) if (rule.pattern.test(entry.message)) return rule.level;
    }
    return 'info';
  }
  return 'debug';
}

/** One letter for the level column: E W I D, `·` unknown, A agent, empty for markers. */
export function levelLetter(level: LogLevel): string {
  switch (level) {
    case 'error':
      return 'E';
    case 'warning':
      return 'W';
    case 'info':
      return 'I';
    case 'debug':
      return 'D';
    case 'agent':
      return 'A';
    case 'unknown':
      return '·';
    case 'marker':
      return '';
  }
}

// --- "package: mine" ---

export interface AppIdentity {
  /** Application name (the binary's basename). */
  name?: string;
  /** Absolute binary path. */
  binary?: string;
  /** Every pid of the app seen so far, so a crashed instance's last lines stay. */
  pids: Iterable<number>;
}

/** `comm` is cut to 15 characters by the kernel. */
export const COMM_LENGTH = 15;

// --- process markers ---

export type ProcessEvent =
  | { type: 'started'; app: string; pid?: number; mode?: 'run' | 'debug' }
  | { type: 'exited'; app: string; exit: ExitInfo }
  | { type: 'resumed' }
  | { type: 'cleared' };

export function markerText(event: ProcessEvent): string {
  switch (event.type) {
    case 'started': {
      const extra = [event.pid !== undefined ? `pid ${event.pid}` : '', event.mode ?? ''].filter(Boolean).join(', ');
      return `── ${event.app} started${extra ? ` (${extra})` : ''} ──`;
    }
    case 'exited':
      return `── ${event.app} ${describeExit(event.exit)} ──`;
    case 'resumed':
      return '── log resumed; entries may be missing ──';
    case 'cleared':
      return '── log cleared ──';
  }
}

/** A synthetic row for a stream that was cut and picked up again. */
export function markerEntry(event: ProcessEvent, ts: number): JournalEntry {
  return { id: 0, source: 'marker', ts, message: markerText(event), tag: '' };
}

/** A `systemd-coredump` line (or any entry with `COREDUMP_PID`) as a crash event for `app`. */
export function coredumpEvent(entry: JournalEntry, app: AppIdentity): ProcessEvent | undefined {
  if (entry.source !== 'json' || entry.coredumpPid === undefined || !app.name) return undefined;
  const pids = new Set(app.pids);
  const cut = app.name.slice(0, COMM_LENGTH);
  if (!pids.has(entry.coredumpPid) && entry.coredumpComm !== cut) return undefined;
  const exit: ExitInfo = { coredump: true };
  if (entry.coredumpSignal !== undefined) exit.signal = signalName(entry.coredumpSignal) ?? entry.coredumpSignal;
  return { type: 'exited', app: app.name, exit };
}

// --- text for Save ---

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** `HH:MM:SS.mmm`, local time. */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--.---';
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** One line per entry for the `.log` file: `13:42:01.123 W 4321 harbour-demo: message`. */
export function formatEntryLine(entry: JournalEntry, deriveLevels: boolean = false): string {
  if (entry.source === 'marker') return `${formatTime(entry.ts)} ${entry.message}`;
  const letter = levelLetter(levelOf(entry, deriveLevels));
  const pid = entry.pid !== undefined ? ` ${entry.pid}` : '';
  const tag = entry.tag ? ` ${entry.tag}` : '';
  return `${formatTime(entry.ts)} ${letter}${pid}${tag}: ${entry.message.replace(/\r?\n/g, '\n    ')}`;
}
