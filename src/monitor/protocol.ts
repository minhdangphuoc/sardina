/**
 * Message protocol between the Device Monitor panel (host) and its page (PLAN-device-monitor §7.2).
 * Shared by both bundles: no `vscode`, no DOM. Every page-to-host message goes through
 * `parsePageMessage`, which accepts exact `type` strings, integers in range, strings cut to 512
 * characters without control characters, and drops unknown fields.
 */

import { MIN_LEVELS, type JournalEntry, type MinLevel } from './logModel';
import { FIELD_MAX, sanitizeField } from './displayText';
import type { AppCounters } from './appStats';

// --- shared vocabulary ---

export const SECTION_IDS = ['overview', 'sessions', 'app', 'logs', 'actions'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const ACTION_NAMES = ['restartApp', 'stopApp', 'screenshot', 'openMirror', 'refresh', 'installAgent'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export const RESUME_TARGETS = ['logs', 'app', 'all'] as const;
export type ResumeTarget = (typeof RESUME_TARGETS)[number];

export const SAVE_FORMATS = ['log', 'jsonl'] as const;
export type SaveFormat = (typeof SAVE_FORMATS)[number];

export type LogStatus = 'starting' | 'live' | 'paused' | 'stopped' | 'off' | 'needsAgent';
export const LOG_STATUSES: readonly LogStatus[] = ['starting', 'live', 'paused', 'stopped', 'off', 'needsAgent'];

/** The entries of one `log.append` batch are at most this many (the host splits larger ones). */
export const MAX_BATCH_ENTRIES = 500;
/** Upper bound of ids a `log.save` filter may carry; larger values are rejected. */
export const MAX_TAGS_IN_FILTER = 64;

export type LogFormat = 'json' | 'text';

// --- host to page ---

export interface InitSettings {
  /** Entries the page keeps (`sailfish.monitor.logBufferLines`). */
  maxEntries: number;
  deriveLevels: boolean;
  groupStackFrames: boolean;
  /** Section to expand and focus on first show. */
  reveal?: SectionId;
}

export interface OverviewRow {
  label: string;
  value: string;
}

export interface SessionRow {
  id: number;
  kind: string;
  label: string;
  startedAt: number;
  app?: string;
  pid?: number;
  mode?: 'run' | 'debug';
}

/** One sample of the app, as the App section shows it. */
export interface AppStatsView {
  pid?: number;
  state?: string;
  /** Percent of one core. */
  cpu?: number;
  /** Device total, percent. */
  sysCpu?: number;
  rssKb?: number;
  threads?: number;
  uptimeSec?: number;
}

/** Who "package: mine" means. */
export interface AppIdentityWire {
  name?: string;
  binary?: string;
  pids: number[];
}

export interface BannerAction {
  label: string;
  resume?: ResumeTarget;
  action?: ActionName;
}

export interface ActionState {
  enabled: boolean;
  /** Why it is disabled; shown next to the button. */
  reason?: string;
}

export type HostMessage =
  | { type: 'init'; device: string; settings: InitSettings }
  | { type: 'overview'; rows: OverviewRow[] }
  | { type: 'sessions'; list: SessionRow[] }
  | {
      type: 'app';
      /** Absent: no app known ("No app launched from VS Code yet"). */
      app?: { name: string; binary?: string };
      stats: AppStatsView | null;
      counters: AppCounters;
      /** `agent 1 s`, `polling every 5 s`, `paused (tab hidden)`. */
      source: string;
      identity?: AppIdentityWire;
    }
  | { type: 'actions'; actions: Partial<Record<ActionName, ActionState>> }
  | { type: 'log.append'; entries: JournalEntry[]; dropped: number; upTo: number }
  | { type: 'log.state'; status: LogStatus; reason?: string; format?: LogFormat; rate?: number; pending?: number }
  | { type: 'log.clear' }
  | { type: 'notice'; text: string }
  | { type: 'banner'; text: string; actions: BannerAction[] }
  | { type: 'banner.clear' };

export const HOST_MESSAGE_TYPES: readonly HostMessage['type'][] = [
  'init',
  'overview',
  'sessions',
  'app',
  'actions',
  'log.append',
  'log.state',
  'log.clear',
  'notice',
  'banner',
  'banner.clear',
];

/**
 * Shape check for what the page receives. The host is trusted, but a malformed message must not
 * take the page down: returns the message when `type` is known and its container fields have the
 * right JS type, otherwise undefined.
 */
export function asHostMessage(raw: unknown): HostMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  if (typeof m.type !== 'string' || !(HOST_MESSAGE_TYPES as readonly string[]).includes(m.type)) return undefined;
  switch (m.type) {
    case 'init':
      return typeof m.device === 'string' && typeof m.settings === 'object' && m.settings !== null ? (raw as HostMessage) : undefined;
    case 'overview':
      return Array.isArray(m.rows) ? (raw as HostMessage) : undefined;
    case 'sessions':
      return Array.isArray(m.list) ? (raw as HostMessage) : undefined;
    case 'app':
      return typeof m.counters === 'object' && m.counters !== null && typeof m.source === 'string' ? (raw as HostMessage) : undefined;
    case 'actions':
      return typeof m.actions === 'object' && m.actions !== null ? (raw as HostMessage) : undefined;
    case 'log.append':
      return Array.isArray(m.entries) && typeof m.dropped === 'number' && typeof m.upTo === 'number' ? (raw as HostMessage) : undefined;
    case 'log.state':
      return typeof m.status === 'string' && (LOG_STATUSES as readonly string[]).includes(m.status) ? (raw as HostMessage) : undefined;
    case 'notice':
      return typeof m.text === 'string' ? (raw as HostMessage) : undefined;
    case 'banner':
      return typeof m.text === 'string' && Array.isArray(m.actions) ? (raw as HostMessage) : undefined;
    default:
      return raw as HostMessage;
  }
}

// --- page to host ---

/** The log filter the page had when the user pressed Save, so the host can apply `entryVisible`. */
export interface SaveFilter {
  minLevel: MinLevel;
  tags: string[];
  mine: boolean;
  query: string;
  deriveLevels: boolean;
}

export type PageMessage =
  | { type: 'ready' }
  | { type: 'log.ack'; upTo: number }
  | { type: 'log.pause'; on: boolean }
  | { type: 'log.clear' }
  | { type: 'log.save'; filteredOnly: boolean; format: SaveFormat; filter?: SaveFilter }
  | { type: 'openSource'; file: string; line: number; col?: number }
  | { type: 'action'; name: ActionName }
  | { type: 'session.stop'; id: number }
  | { type: 'ui.visible'; on: boolean }
  | { type: 'resume'; what: ResumeTarget };

export const PAGE_MESSAGE_TYPES: readonly PageMessage['type'][] = [
  'ready',
  'log.ack',
  'log.pause',
  'log.clear',
  'log.save',
  'openSource',
  'action',
  'session.stop',
  'ui.visible',
  'resume',
];

export type PageParse = { ok: true; message: PageMessage } | { ok: false; reason: 'unknown-type' | 'invalid' };

const MAX_ID = Number.MAX_SAFE_INTEGER;
const MAX_LINE = 10_000_000;

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): T | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}

function parseFilter(raw: unknown): SaveFilter | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const f = raw as Record<string, unknown>;
  const minLevel = oneOf(f.minLevel, MIN_LEVELS);
  if (!minLevel || typeof f.mine !== 'boolean' || typeof f.deriveLevels !== 'boolean' || typeof f.query !== 'string') return undefined;
  if (!Array.isArray(f.tags) || f.tags.length > MAX_TAGS_IN_FILTER) return undefined;
  const tags: string[] = [];
  for (const t of f.tags) {
    if (typeof t !== 'string') return undefined;
    tags.push(sanitizeField(t));
  }
  return { minLevel, tags, mine: f.mine, query: sanitizeField(f.query), deriveLevels: f.deriveLevels };
}

/** Validates one page message; distinguishes an unknown `type` (counted by the host) from a bad shape. */
export function parsePageMessage(raw: unknown): PageParse {
  const bad: PageParse = { ok: false, reason: 'invalid' };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad;
  const m = raw as Record<string, unknown>;
  const type = oneOf(m.type, PAGE_MESSAGE_TYPES);
  if (!type) return { ok: false, reason: 'unknown-type' };
  const ok = (message: PageMessage): PageParse => ({ ok: true, message });
  switch (type) {
    case 'ready':
      return ok({ type });
    case 'log.clear':
      return ok({ type });
    case 'log.ack':
      return isInt(m.upTo, 0, MAX_ID) ? ok({ type, upTo: m.upTo }) : bad;
    case 'log.pause':
    case 'ui.visible':
      return typeof m.on === 'boolean' ? ok({ type, on: m.on }) : bad;
    case 'log.save': {
      const format = oneOf(m.format, SAVE_FORMATS);
      if (!format || typeof m.filteredOnly !== 'boolean') return bad;
      if (!m.filteredOnly) return ok({ type, filteredOnly: false, format });
      const filter = parseFilter(m.filter);
      // "only what the filters show" is meaningless without the filters
      return filter ? ok({ type, filteredOnly: true, format, filter }) : bad;
    }
    case 'openSource': {
      // A path is never cut: a shortened path would name a different file.
      if (typeof m.file !== 'string' || m.file.length === 0 || m.file.length > FIELD_MAX) return bad;
      const file = sanitizeField(m.file);
      if (file.length === 0 || !isInt(m.line, 1, MAX_LINE)) return bad;
      if (m.col === undefined) return ok({ type, file, line: m.line });
      return isInt(m.col, 1, MAX_LINE) ? ok({ type, file, line: m.line, col: m.col }) : bad;
    }
    case 'action': {
      const name = oneOf(m.name, ACTION_NAMES);
      return name ? ok({ type, name }) : bad;
    }
    case 'session.stop':
      return isInt(m.id, 1, MAX_ID) ? ok({ type, id: m.id }) : bad;
    case 'resume': {
      const what = oneOf(m.what, RESUME_TARGETS);
      return what ? ok({ type, what }) : bad;
    }
  }
}

/** `parsePageMessage` reduced to the message or undefined. */
export function validatePageMessage(raw: unknown): PageMessage | undefined {
  const r = parsePageMessage(raw);
  return r.ok ? r.message : undefined;
}
