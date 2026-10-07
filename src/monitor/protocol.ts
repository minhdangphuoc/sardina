/**
 * Message protocol between the Device Monitor panel (host) and its page. Shared by both bundles:
 * no `vscode`, no DOM. Every page-to-host message goes through `parsePageMessage`, which accepts
 * exact `type` strings and drops unknown fields.
 */

import type { AppCounters } from './appStats';

// --- shared vocabulary ---

export const ACTION_NAMES = ['restartApp', 'stopApp', 'runApp', 'screenshot', 'openMirror', 'showLogs'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export const RESUME_TARGETS = ['app', 'all'] as const;
export type ResumeTarget = (typeof RESUME_TARGETS)[number];

// --- host to page ---

/** `connecting` until the first probe answered; `offline` when the device cannot be reached. */
export type ConnectionState = 'connecting' | 'connected' | 'offline';
export const CONNECTION_STATES: readonly ConnectionState[] = ['connecting', 'connected', 'offline'];

/** One sample of the app, as the App card shows it. */
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

export interface ActionState {
  enabled: boolean;
  /** Why it is disabled; shown as the button's tooltip. */
  reason?: string;
}

export interface BannerAction {
  label: string;
  resume?: ResumeTarget;
  action?: ActionName;
}

export type HostMessage =
  | { type: 'init'; device: string }
  | {
      type: 'overview';
      state: ConnectionState;
      /** `Wi‑Fi · aarch64 · OS 5.1.0.11 · agent 1.10.0`. */
      line: string;
    }
  | {
      type: 'app';
      /** Absent: no app known. */
      app?: { name: string; binary?: string };
      mode?: 'run' | 'debug';
      stats: AppStatsView | null;
      counters: AppCounters;
    }
  | { type: 'actions'; actions: Partial<Record<ActionName, ActionState>> }
  | { type: 'notice'; text: string }
  | { type: 'banner'; text: string; actions: BannerAction[] }
  | { type: 'banner.clear' };

export const HOST_MESSAGE_TYPES: readonly HostMessage['type'][] = ['init', 'overview', 'app', 'actions', 'notice', 'banner', 'banner.clear'];

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
      return typeof m.device === 'string' ? (raw as HostMessage) : undefined;
    case 'overview':
      return typeof m.line === 'string' && typeof m.state === 'string' && (CONNECTION_STATES as readonly string[]).includes(m.state) ? (raw as HostMessage) : undefined;
    case 'app':
      return typeof m.counters === 'object' && m.counters !== null ? (raw as HostMessage) : undefined;
    case 'actions':
      return typeof m.actions === 'object' && m.actions !== null ? (raw as HostMessage) : undefined;
    case 'notice':
      return typeof m.text === 'string' ? (raw as HostMessage) : undefined;
    case 'banner':
      return typeof m.text === 'string' && Array.isArray(m.actions) ? (raw as HostMessage) : undefined;
    default:
      return raw as HostMessage;
  }
}

// --- page to host ---

export type PageMessage =
  | { type: 'ready' }
  | { type: 'action'; name: ActionName }
  | { type: 'ui.visible'; on: boolean }
  | { type: 'resume'; what: ResumeTarget };

export const PAGE_MESSAGE_TYPES: readonly PageMessage['type'][] = ['ready', 'action', 'ui.visible', 'resume'];

export type PageParse = { ok: true; message: PageMessage } | { ok: false; reason: 'unknown-type' | 'invalid' };

function oneOf<T extends string>(v: unknown, list: readonly T[]): T | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;
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
    case 'ui.visible':
      return typeof m.on === 'boolean' ? ok({ type, on: m.on }) : bad;
    case 'action': {
      const name = oneOf(m.name, ACTION_NAMES);
      return name ? ok({ type, name }) : bad;
    }
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
