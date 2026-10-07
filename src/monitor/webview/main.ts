/**
 * Device Monitor page entry: message dispatch, the App card and the action buttons. Built into
 * `media/monitor/monitor.js`. The skeleton is static HTML from `monitorCore.ts`; this script fills
 * it with `textContent` and DOM calls only.
 */

import { formatRss, formatUptime } from '../appStats';
import { ACTION_NAMES, asHostMessage, type ActionName, type ActionState, type AppStatsView, type HostMessage, type PageMessage } from '../protocol';
import { controlGlyphs } from '../displayText';
import { History, sparkPoints } from './appModel';

interface VsCodeApi {
  postMessage(message: PageMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const REDRAW_MS = 500;
const SPARK_W = 120;
const SPARK_H = 28;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`monitor page: missing #${id}`);
  return el as T;
}

function post(m: PageMessage): void {
  vscode.postMessage(m);
}

// --- connection line ---

const STATE_TEXT = { connecting: 'Connecting…', connected: 'Connected', offline: 'Offline' } as const;

function renderOverview(m: Extract<HostMessage, { type: 'overview' }>): void {
  byId('dot').className = `dot ${m.state}`;
  byId('state').textContent = STATE_TEXT[m.state];
  const line = byId('line');
  line.textContent = controlGlyphs(m.line);
  line.title = controlGlyphs(m.line);
}

// --- app ---

const cpuHistory = new History();
const rssHistory = new History();
let appDirty = false;
let lastRedraw = 0;
let redrawTimer: ReturnType<typeof setTimeout> | undefined;
let appView: Extract<HostMessage, { type: 'app' }> | undefined;
let appRunning = false;

function setActionsHidden(): void {
  // Restart and Stop only make sense for a running app; Run installed app only for a stopped, known one.
  byId('act-restartApp').hidden = !appRunning;
  byId('act-stopApp').hidden = !appRunning;
}

/** A line sparkline: polyline, faint area under it and a dot on the latest point; no axes. */
function drawSpark(id: string, values: readonly number[], max?: number): void {
  const pts = sparkPoints(values, SPARK_W, SPARK_H, max);
  const list = pts ? pts.split(' ') : [];
  byId(`spark-${id}-line`).setAttribute('points', pts);
  byId(`spark-${id}-area`).setAttribute('points', list.length > 0 ? `0,${SPARK_H} ${pts} ${SPARK_W},${SPARK_H}` : '');
  const [x, y] = (list[list.length - 1] ?? '0,0').split(',');
  const dot = byId(`spark-${id}-dot`);
  for (const k of ['x1', 'x2']) dot.setAttribute(k, x);
  for (const k of ['y1', 'y2']) dot.setAttribute(k, y);
  dot.style.display = list.length > 0 ? '' : 'none';
}

function drawApp(): void {
  redrawTimer = undefined;
  lastRedraw = Date.now();
  appDirty = false;
  const v = appView;
  const s: AppStatsView | null = v?.stats ?? null;
  appRunning = v?.app !== undefined && s?.pid !== undefined && s.pid > 0;
  byId('app-running').hidden = !appRunning;
  byId('app-idle').hidden = appRunning;
  byId('act-runApp').hidden = v?.app === undefined;
  setActionsHidden();
  if (!v?.app) {
    byId('idle-text').textContent = 'No app launched from VS Code yet';
    return;
  }
  const name = controlGlyphs(v.app.name);
  if (!appRunning) {
    byId('idle-text').textContent = `${name} is not running`;
    return;
  }
  const appName = byId('app-name');
  appName.textContent = name;
  appName.title = name;
  byId('app-meta').textContent = [`pid ${s?.pid}`, v.mode === 'debug' ? 'debugging' : v.mode === 'run' ? 'running' : ''].filter(Boolean).join(' · ');
  byId('cpu-value').textContent = s?.cpu !== undefined ? `${Math.round(s.cpu)} %` : '—';
  byId('mem-value').textContent = s?.rssKb !== undefined ? formatRss(s.rssKb) : '—';
  drawSpark('cpu', cpuHistory.list, 100);
  drawSpark('rss', rssHistory.list);
  byId('app-counters').textContent = `up ${formatUptime(s?.uptimeSec)} · restarts ${v.counters.restarts} · crashes ${v.counters.crashes}`;
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
    const st = actions[name];
    if (!btn || !st) continue;
    btn.setAttribute('aria-disabled', String(!st.enabled));
    btn.title = st.enabled ? '' : st.reason ?? '';
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
    case 'init':
      byId('device').textContent = controlGlyphs(m.device);
      break;
    case 'overview':
      renderOverview(m);
      break;
    case 'app':
      appView = m;
      if (m.stats) {
        cpuHistory.push(m.stats.cpu);
        rssHistory.push(m.stats.rssKb);
      }
      scheduleApp();
      break;
    case 'actions':
      applyActions(m.actions);
      break;
    case 'notice':
      byId('notice').textContent = controlGlyphs(m.text);
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
    console.error('monitor page: message failed', m.type, err);
  }
});

document.addEventListener('visibilitychange', () => {
  const on = !document.hidden;
  if (on && appDirty) scheduleApp();
  post({ type: 'ui.visible', on });
});

drawApp();
post({ type: 'ready' });
