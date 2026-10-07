/**
 * Device Monitor page entry: sections, state restore, the ack loop and message dispatch. Built
 * into `media/monitor/monitor.js` (esbuild entry added with the panel wiring). The skeleton is
 * static HTML from `monitorCore.ts`; this script fills it with `textContent` and DOM calls only.
 */

import { formatTime } from '../logModel';
import { formatRss, formatUptime, formatCounters } from '../appStats';
import {
  ACTION_NAMES,
  SECTION_IDS,
  asHostMessage,
  type ActionName,
  type ActionState,
  type AppStatsView,
  type HostMessage,
  type PageMessage,
  type SectionId,
} from '../protocol';
import { controlGlyphs } from '../displayText';
import { History, describeCpu, describeRss, sparkPoints } from './appModel';
import { DEFAULT_LOG_STATE, LogView, type LogViewState } from './logView';

interface VsCodeApi {
  postMessage(message: PageMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState {
  collapsed: SectionId[];
  log: Partial<LogViewState>;
}

const vscode = acquireVsCodeApi();
const REDRAW_MS = 500;
const SPARK_W = 120;
const SPARK_H = 32;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`monitor page: missing #${id}`);
  return el as T;
}

function post(m: PageMessage): void {
  vscode.postMessage(m);
}

function readSaved(): PersistedState | undefined {
  const raw = vscode.getState();
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const collapsed = Array.isArray(r.collapsed) ? r.collapsed.filter((x): x is SectionId => (SECTION_IDS as readonly unknown[]).includes(x)) : [];
  const log = typeof r.log === 'object' && r.log !== null ? (r.log as Partial<LogViewState>) : {};
  return { collapsed, log };
}

const saved = readSaved();
const collapsed = new Set<SectionId>(saved?.collapsed ?? []);
let logView: LogView | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function persist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    const state: PersistedState = { collapsed: [...collapsed], log: logView ? logView.getState() : { ...DEFAULT_LOG_STATE } };
    vscode.setState(state);
  }, 300);
}

// --- sections ---

function setSection(id: SectionId, open: boolean): void {
  const btn = byId<HTMLButtonElement>(`toggle-${id}`);
  const body = byId(`body-${id}`);
  btn.setAttribute('aria-expanded', String(open));
  body.hidden = !open;
  byId(`sec-${id}`).classList.toggle('collapsed', !open);
  const chev = btn.querySelector('.chev');
  if (chev) chev.textContent = open ? '▾' : '▸';
  if (open) collapsed.delete(id);
  else collapsed.add(id);
  persist();
}

for (const id of SECTION_IDS) {
  setSection(id, !collapsed.has(id));
  byId(`toggle-${id}`).addEventListener('click', () => setSection(id, collapsed.has(id)));
}

// --- overview, sessions ---

function renderOverview(rows: { label: string; value: string }[]): void {
  const dl = byId('overview-list');
  dl.replaceChildren();
  byId('overview-empty').hidden = rows.length > 0;
  for (const r of rows) {
    const dt = document.createElement('dt');
    dt.textContent = controlGlyphs(String(r.label));
    const dd = document.createElement('dd');
    dd.textContent = controlGlyphs(String(r.value));
    dl.append(dt, dd);
  }
}

function renderSessions(list: { id: number; kind: string; label: string; startedAt: number; app?: string; pid?: number; mode?: string }[]): void {
  const ul = byId('sessions-list');
  ul.replaceChildren();
  byId('sessions-empty').hidden = list.length > 0;
  for (const s of list) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'session-name';
    const details = [s.kind, s.app, s.pid !== undefined ? `pid ${s.pid}` : '', s.mode, `since ${formatTime(s.startedAt).slice(0, 8)}`].filter(Boolean).join(' · ');
    name.textContent = controlGlyphs(`${s.label}`);
    const meta = document.createElement('span');
    meta.className = 'muted small';
    meta.textContent = controlGlyphs(` ${details}`);
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = 'Stop';
    stop.setAttribute('aria-label', controlGlyphs(`Stop ${s.label}`));
    stop.addEventListener('click', () => post({ type: 'session.stop', id: s.id }));
    li.append(name, meta, stop);
    ul.appendChild(li);
  }
}

// --- app ---

const cpuHistory = new History();
const rssHistory = new History();
let appDirty = false;
let lastRedraw = 0;
let redrawTimer: ReturnType<typeof setTimeout> | undefined;
let appView: { app?: { name: string; binary?: string }; stats: AppStatsView | null; counters: { restarts: number; crashes: number }; source: string } | undefined;

function kv(dl: HTMLElement, rows: [string, string][]): void {
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = controlGlyphs(v);
    dl.append(dt, dd);
  }
}

function drawApp(): void {
  redrawTimer = undefined;
  lastRedraw = Date.now();
  appDirty = false;
  const v = appView;
  byId('app-empty').hidden = v?.app !== undefined;
  byId('app-body').hidden = v?.app === undefined;
  if (!v?.app) return;
  const s = v.stats;
  const running = s?.pid !== undefined && s.pid > 0;
  kv(byId('app-kv'), [
    ['Name', v.app.name],
    ['Binary', v.app.binary ?? '—'],
    ['PID', running ? String(s?.pid) : 'not running'],
    ['State', s?.state ?? '—'],
    ['CPU', s?.cpu !== undefined ? `${s.cpu.toFixed(1)} %${s.sysCpu !== undefined ? ` (device ${s.sysCpu.toFixed(0)} %)` : ''}` : '—'],
    ['Memory (RSS)', formatRss(s?.rssKb)],
    ['Threads', s?.threads !== undefined ? String(s.threads) : '—'],
    ['Uptime', formatUptime(s?.uptimeSec)],
  ]);
  byId('app-counters').textContent = formatCounters(v.counters);
  byId('app-source').textContent = v.source;
  const cpuText = describeCpu(cpuHistory.list);
  const rssText = describeRss(rssHistory.list);
  byId('spark-cpu-line').setAttribute('points', sparkPoints(cpuHistory.list, SPARK_W, SPARK_H, 100));
  byId('spark-rss-line').setAttribute('points', sparkPoints(rssHistory.list, SPARK_W, SPARK_H));
  byId('spark-cpu-t').textContent = cpuText;
  byId('spark-rss-t').textContent = rssText;
  byId('spark-cpu-cap').textContent = cpuText;
  byId('spark-rss-cap').textContent = rssText;
}

function scheduleApp(): void {
  appDirty = true;
  if (redrawTimer || document.hidden) return;
  const wait = Math.max(0, REDRAW_MS - (Date.now() - lastRedraw));
  redrawTimer = setTimeout(() => requestAnimationFrame(drawApp), wait);
}

// --- actions and banner ---

function applyActions(actions: Partial<Record<ActionName, ActionState>>): void {
  for (const name of ACTION_NAMES) {
    const btn = document.getElementById(`act-${name}`);
    const why = document.getElementById(`why-${name}`);
    const st = actions[name];
    if (!btn || !why || !st) continue;
    btn.setAttribute('aria-disabled', String(!st.enabled));
    btn.title = st.enabled ? '' : st.reason ?? '';
    why.textContent = st.enabled ? '' : st.reason ?? '';
  }
}

for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-action]'))) {
  btn.addEventListener('click', () => {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const name = ACTION_NAMES.find((a) => a === btn.dataset.action);
    if (name) post({ type: 'action', name });
  });
}

function showBanner(m: Extract<HostMessage, { type: 'banner' }>): void {
  byId('banner').hidden = false;
  byId('banner-text').textContent = controlGlyphs(m.text);
  const box = byId('banner-actions');
  box.replaceChildren();
  for (const a of m.actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = controlGlyphs(a.label);
    btn.addEventListener('click', () => {
      if (a.resume) post({ type: 'resume', what: a.resume });
      else if (a.action && ACTION_NAMES.includes(a.action)) post({ type: 'action', name: a.action });
    });
    box.appendChild(btn);
  }
}

// --- dispatch ---

function handle(m: HostMessage): void {
  switch (m.type) {
    case 'init': {
      byId('device').textContent = controlGlyphs(m.device);
      const s = m.settings;
      const maxEntries = Number.isFinite(s.maxEntries) ? s.maxEntries : 10_000;
      if (!logView) {
        logView = new LogView({ post, persist }, saved?.log, maxEntries);
      }
      logView.configure(maxEntries, s.deriveLevels === true, s.groupStackFrames !== false, saved !== undefined && Object.keys(saved.log).length > 0);
      if (s.reveal && (SECTION_IDS as readonly string[]).includes(s.reveal)) {
        setSection(s.reveal, true);
        if (s.reveal === 'logs') logView.focusGrid();
        else byId(`toggle-${s.reveal}`).focus();
      }
      break;
    }
    case 'overview':
      renderOverview(m.rows);
      break;
    case 'sessions':
      renderSessions(m.list);
      break;
    case 'app':
      appView = { app: m.app, stats: m.stats, counters: m.counters, source: m.source };
      if (m.stats) {
        cpuHistory.push(m.stats.cpu);
        rssHistory.push(m.stats.rssKb);
      }
      logView?.setIdentity(m.identity);
      scheduleApp();
      break;
    case 'actions':
      applyActions(m.actions);
      break;
    case 'log.append':
      logView?.append(m);
      break;
    case 'log.state':
      logView?.setStatus(m);
      break;
    case 'log.clear':
      logView?.clear();
      break;
    case 'notice':
      logView?.notice(controlGlyphs(m.text));
      break;
    case 'banner':
      showBanner(m);
      break;
    case 'banner.clear':
      byId('banner').hidden = true;
      break;
  }
}

window.addEventListener('message', (ev: MessageEvent<unknown>) => {
  const m = asHostMessage(ev.data);
  if (!m) return;
  try {
    handle(m);
  } catch (err) {
    // a bad message must not stop the page; the host sees the missing ack and slows down
    console.error('monitor page: message failed', m.type, err);
  }
});

document.addEventListener('visibilitychange', () => {
  const on = !document.hidden;
  logView?.setVisible(on);
  if (on && appDirty) scheduleApp();
  post({ type: 'ui.visible', on });
});

window.addEventListener('beforeunload', persist);
post({ type: 'ready' });
