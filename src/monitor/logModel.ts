/**
 * Pure model of the Device Monitor's log viewer: journal entries (JSON and `short-precise` text),
 * levels, a bounded buffer, the query language, message folding, source references and process
 * markers. No `vscode` import and no DOM, so the host, the webview and the unit tests share it.
 */

import { describeExit, signalName, type ExitInfo } from './appStats';

// --- entries ---

export type LogLevel = 'error' | 'warning' | 'info' | 'debug' | 'unknown' | 'agent' | 'marker';
export type LogSource = 'json' | 'text' | 'agent' | 'marker';

export interface JournalEntry {
  /** Assigned by `LogBuffer.push` (monotonic, never reused); 0 before that. */
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

export type MinLevel = 'verbose' | 'debug' | 'info' | 'warning' | 'error';
/** The chooser's order. Journald has one level (7) for both of the first two. */
export const MIN_LEVELS: readonly MinLevel[] = ['verbose', 'debug', 'info', 'warning', 'error'];

const RANK: Record<MinLevel, number> = { verbose: 0, debug: 1, info: 2, warning: 3, error: 4 };

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

/** Whether `level` is shown at minimum level `min`. Agent and marker rows always show; unknown counts as info. */
export function levelPasses(level: LogLevel, min: MinLevel): boolean {
  if (level === 'agent' || level === 'marker') return true;
  const rank = level === 'unknown' ? RANK.info : RANK[level];
  return rank >= RANK[min];
}

// --- bounded buffer ---

export const DEFAULT_MAX_ENTRIES = 10_000;
export const MAX_ENTRIES_LIMIT = 100_000;
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export interface BufferSlice {
  entries: JournalEntry[];
  /** Entries after the requested id that were evicted before they could be read. */
  dropped: number;
}

/** Ring buffer bounded by entry count and by message bytes, whichever is hit first. */
export class LogBuffer {
  private items: JournalEntry[] = [];
  private head = 0;
  private byteTotal = 0;
  private nextId = 1;
  private evicted = 0;
  readonly maxEntries: number;
  readonly maxBytes: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES, maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxEntries = Math.max(1, Math.min(MAX_ENTRIES_LIMIT, Math.floor(maxEntries) || DEFAULT_MAX_ENTRIES));
    this.maxBytes = Math.max(1, Math.floor(maxBytes) || DEFAULT_MAX_BYTES);
  }

  get size(): number {
    return this.items.length - this.head;
  }

  /** Message bytes currently held. */
  get bytes(): number {
    return this.byteTotal;
  }

  /** Entries evicted (or cleared) over the buffer's lifetime. */
  get droppedTotal(): number {
    return this.evicted;
  }

  /** Id of the newest entry, 0 when nothing was ever pushed. */
  get lastId(): number {
    return this.nextId - 1;
  }

  /** Stores a copy of `entry` with a fresh id and returns that id. The newest entry is always kept. */
  push(entry: JournalEntry): number {
    const id = this.nextId++;
    this.items.push({ ...entry, id });
    this.byteTotal += utf8Length(entry.message);
    while (this.size > 1 && (this.size > this.maxEntries || this.byteTotal > this.maxBytes)) this.evictOldest();
    return id;
  }

  pushMany(entries: readonly JournalEntry[]): void {
    for (const e of entries) this.push(e);
  }

  private evictOldest(): void {
    const old = this.items[this.head];
    this.byteTotal -= utf8Length(old.message);
    this.head++;
    this.evicted++;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }

  /** Snapshot of everything held, oldest first. */
  all(): JournalEntry[] {
    return this.items.slice(this.head);
  }

  /** Entries with id greater than `afterId` (at most `limit`) and how many of the older ones were lost. */
  since(afterId: number, limit: number = 500): BufferSlice {
    const first = this.size > 0 ? this.items[this.head].id : this.nextId;
    const dropped = Math.max(0, first - (afterId + 1));
    // ids are consecutive, so the position is arithmetic
    const start = this.head + Math.max(0, afterId + 1 - first);
    return { entries: this.items.slice(start, start + Math.max(0, limit)), dropped };
  }

  get(id: number): JournalEntry | undefined {
    if (this.size === 0) return undefined;
    const idx = this.head + (id - this.items[this.head].id);
    const e = this.items[idx];
    return e && e.id === id ? e : undefined;
  }

  /** Empties the buffer; ids keep counting. */
  clear(): void {
    this.evicted += this.size;
    this.items = [];
    this.head = 0;
    this.byteTotal = 0;
  }

  /** Distinct tags held, most frequent first. */
  tags(): string[] {
    const counts = new Map<string, number>();
    for (let i = this.head; i < this.items.length; i++) {
      const t = this.items[i].tag;
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }
}

// --- query language ---

export interface QueryTerm {
  text: string;
  negate: boolean;
}

export interface Query {
  /** Substring terms, all of which must match (case-insensitive) unless negated. */
  terms: QueryTerm[];
  /** `tag:x` values; an entry passes when its tag is any of them. */
  tags: string[];
  /** `pid:123` values; an entry passes when its pid is any of them. */
  pids: number[];
  /** `level:w` minimum level. */
  level?: MinLevel;
  /** `/re/` or `/re/i`, compiled once. */
  regex?: RegExp;
  /** Why an invalid or risky `/re/` was used as plain text instead. */
  regexNote?: string;
}

export const MAX_QUERY_LENGTH = 500;
const MAX_REGEX_LENGTH = 200;
const REGEX_BUDGET_MS = 100;

function levelFromLetter(s: string): MinLevel | undefined {
  const c = s.toLowerCase();
  if (c.length === 0) return undefined;
  for (const l of MIN_LEVELS) if (l.startsWith(c)) return l;
  return undefined;
}

// a quantified group that itself contains a quantifier: (a+)+, (.*)*, (a|b+)*
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

function compileRegex(source: string, flags: string): { regex?: RegExp; note?: string } {
  if (source.length > MAX_REGEX_LENGTH) return { note: 'regular expression too long, searching as text' };
  if (NESTED_QUANTIFIER.test(source)) return { note: 'regular expression could take too long, searching as text' };
  let regex: RegExp;
  try {
    regex = new RegExp(source, flags);
  } catch {
    return { note: 'invalid regular expression, searching as text' };
  }
  const start = Date.now();
  regex.test('a'.repeat(24) + '!\n' + 'ab '.repeat(8));
  regex.lastIndex = 0;
  if (Date.now() - start > REGEX_BUDGET_MS) return { note: 'regular expression is too slow, searching as text' };
  return { regex };
}

/**
 * Parses the query bar: whitespace-separated words; `-word` excludes, `tag:x`, `pid:123`,
 * `level:w` (v, d, i, w, e), and a whole query of the form `/re/` or `/re/i` is a regular
 * expression. Never throws; an invalid or catastrophic pattern falls back to plain text and sets
 * `regexNote`.
 */
export function parseQuery(input: string): Query {
  const q: Query = { terms: [], tags: [], pids: [] };
  const text = input.slice(0, MAX_QUERY_LENGTH).trim();
  if (!text) return q;
  const re = /^\/(.+)\/(i?)$/s.exec(text);
  if (re) {
    const compiled = compileRegex(re[1], re[2]);
    if (compiled.regex) {
      q.regex = compiled.regex;
      return q;
    }
    q.regexNote = compiled.note;
    q.terms.push({ text: text.toLowerCase(), negate: false });
    return q;
  }
  for (const word of text.split(/\s+/)) {
    const lower = word.toLowerCase();
    if (lower.startsWith('tag:') && word.length > 4) {
      q.tags.push(word.slice(4));
    } else if (lower.startsWith('pid:') && /^\d{1,10}$/.test(word.slice(4))) {
      q.pids.push(Number(word.slice(4)));
    } else if (lower.startsWith('level:') && levelFromLetter(word.slice(6))) {
      q.level = levelFromLetter(word.slice(6));
    } else if (word.startsWith('-') && word.length > 1) {
      q.terms.push({ text: lower.slice(1), negate: true });
    } else {
      q.terms.push({ text: lower, negate: false });
    }
  }
  return q;
}

/** Whether a query has no effect. */
export function isEmptyQuery(q: Query): boolean {
  return q.terms.length === 0 && q.tags.length === 0 && q.pids.length === 0 && q.level === undefined && q.regex === undefined;
}

/** Whether `entry` satisfies `query`. Markers always match. */
export function matches(entry: JournalEntry, query: Query, deriveLevels: boolean = false): boolean {
  if (entry.source === 'marker') return true;
  if (query.level && !levelPasses(levelOf(entry, deriveLevels), query.level)) return false;
  if (query.tags.length > 0 && !query.tags.some((t) => t.toLowerCase() === entry.tag.toLowerCase())) return false;
  if (query.pids.length > 0 && (entry.pid === undefined || !query.pids.includes(entry.pid))) return false;
  if (query.regex) {
    query.regex.lastIndex = 0;
    if (!query.regex.test(entry.message) && !query.regex.test(entry.tag)) return false;
  }
  if (query.terms.length > 0) {
    const hay = `${entry.tag} ${entry.message}`.toLowerCase();
    for (const t of query.terms) if (hay.includes(t.text) === t.negate) return false;
  }
  return true;
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

/**
 * Whether an entry belongs to the app: a known pid, the binary as `_EXE`, the name as `_COMM` (cut
 * to 15) or `SYSLOG_IDENTIFIER`, a `systemd-coredump` line naming it, or an `invoker`/`booster`
 * line mentioning it.
 */
export function isMine(entry: JournalEntry, app: AppIdentity): boolean {
  const pids = app.pids instanceof Set ? app.pids : new Set(app.pids);
  const name = app.name;
  const cut = name?.slice(0, COMM_LENGTH);
  if (entry.pid !== undefined && pids.has(entry.pid)) return true;
  if (entry.syslogPid !== undefined && pids.has(entry.syslogPid)) return true;
  if (app.binary && entry.exe === app.binary) return true;
  if (name && (entry.tag === name || entry.comm === cut || entry.tag === cut)) return true;
  if (entry.coredumpPid !== undefined && pids.has(entry.coredumpPid)) return true;
  if (cut && entry.coredumpComm === cut) return true;
  const launcher = entry.tag === 'invoker' || entry.tag.startsWith('booster');
  const coredump = entry.tag === 'systemd-coredump';
  if (launcher || coredump) {
    if (name && entry.message.includes(name)) return true;
    if (app.binary && entry.message.includes(app.binary)) return true;
  }
  return false;
}

// --- combined filters ---

export interface LogFilters {
  minLevel: MinLevel;
  /** Tag chips; empty means all tags. */
  tags: readonly string[];
  /** Present when "package: mine" is on. */
  mine?: AppIdentity;
  query: Query;
  deriveLevels: boolean;
}

/** The viewer's whole filter: level chooser, tag chips, "mine" and the query bar. Markers always show. */
export function entryVisible(entry: JournalEntry, f: LogFilters): boolean {
  if (entry.source === 'marker') return true;
  if (!levelPasses(levelOf(entry, f.deriveLevels), f.minLevel)) return false;
  if (f.tags.length > 0 && !f.tags.includes(entry.tag)) return false;
  if (f.mine && !isMine(entry, f.mine)) return false;
  return matches(entry, f.query, f.deriveLevels);
}

// --- folding ---

export interface Folded {
  /** First line. */
  head: string;
  /** Number of further lines (trailing blank lines do not count). */
  more: number;
}

export function foldMessage(message: string): Folded {
  const lines = message.split(/\r?\n/);
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  return { head: lines[0], more: lines.length - 1 };
}

export const STACK_WINDOW_MS = 50;

export function isStackFrameLine(message: string): boolean {
  return /^\s/.test(message) || message.startsWith('at ');
}

export interface EntryGroup {
  entry: JournalEntry;
  /** Following stack-frame lines from the same pid, within 50 ms of the previous line. */
  frames: JournalEntry[];
}

/** Groups QML/JS stack frames under the line that precedes them. Markers and agent rows stay alone. */
export function groupStackFrames(entries: readonly JournalEntry[]): EntryGroup[] {
  const groups: EntryGroup[] = [];
  let prev: JournalEntry | undefined;
  for (const e of entries) {
    const open = groups[groups.length - 1];
    const groupable =
      open !== undefined &&
      prev !== undefined &&
      e.source !== 'marker' &&
      e.source !== 'agent' &&
      open.entry.source !== 'marker' &&
      open.entry.source !== 'agent' &&
      e.pid !== undefined &&
      e.pid === prev.pid &&
      e.ts - prev.ts >= 0 &&
      e.ts - prev.ts <= STACK_WINDOW_MS &&
      isStackFrameLine(e.message);
    if (groupable) open.frames.push(e);
    else groups.push({ entry: e, frames: [] });
    prev = e;
  }
  return groups;
}

// --- source references ---

export interface SourceRef {
  /** `/abs/path.qml`, `qrc:/path.qml` or a path as logged; `%20` decoded. */
  file: string;
  line: number;
  col?: number;
  /** Span of the reference in the message; -1 for a reference from `CODE_FILE`/`CODE_LINE`. */
  start: number;
  end: number;
}

const SOURCE_REF =
  /(?:file:\/\/(\/[^:'"<>\n]*?\.[A-Za-z0-9]{1,6})|(qrc:\/[^:'"<>\n]*?\.[A-Za-z0-9]{1,6})|(\/usr\/share\/[^:'"<>\n]*?\.[A-Za-z0-9]{1,6})):(\d{1,7})(?::(\d{1,7}))?/g;

function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p.replace(/%20/g, ' ');
  }
}

/** `file://`, `qrc:/` and bare `/usr/share/…` references with a line (and column), plus `CODE_FILE`/`CODE_LINE`. */
export function findSourceRefs(message: string, entry?: Pick<JournalEntry, 'codeFile' | 'codeLine'>): SourceRef[] {
  const refs: SourceRef[] = [];
  const text = message.length > 4096 ? message.slice(0, 4096) : message;
  const re = new RegExp(SOURCE_REF.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3];
    const ref: SourceRef = { file: decodePath(raw), line: Number(m[4]), start: m.index, end: m.index + m[0].length };
    if (m[5] !== undefined) ref.col = Number(m[5]);
    refs.push(ref);
  }
  if (entry?.codeFile && entry.codeLine !== undefined && entry.codeLine > 0) {
    refs.push({ file: entry.codeFile, line: entry.codeLine, start: -1, end: -1 });
  }
  return refs;
}

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

/** A synthetic row for `LogBuffer.push`. */
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
