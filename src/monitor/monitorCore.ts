/**
 * Pure host side of the Device Monitor page: the panel HTML (CSP with a nonce, static skeleton,
 * no inline handlers), the gate every page message passes through and the one-in-flight guard for
 * actions. No `vscode` import.
 */

import { escapeHtml } from '../agent/mirrorCore';
import { parsePageMessage, type ActionName, type PageMessage } from './protocol';

export const UNKNOWN_WARN_COUNT = 5;
export const UNKNOWN_WARN_WINDOW_MS = 10_000;

export interface MonitorHtmlOptions {
  nonce: string;
  /** `webview.cspSource`. */
  cspSource: string;
  device: string;
  /** `asWebviewUri(media/monitor/monitor.js)`. */
  scriptUri: string;
  /** `asWebviewUri(media/monitor/monitor.css)`. */
  styleUri: string;
}

export function monitorCsp(nonce: string, cspSource: string): string {
  const n = escapeHtml(nonce);
  const c = escapeHtml(cspSource);
  return `default-src 'none'; style-src ${c} 'nonce-${n}'; script-src 'nonce-${n}'; img-src ${c} data:; font-src ${c}`;
}

function spark(id: string, cls: string, label: string): string {
  return `<svg id="spark-${id}" class="spark ${cls}" viewBox="0 0 120 28" preserveAspectRatio="none" role="img" aria-labelledby="spark-${id}-t"><title id="spark-${id}-t">${label}</title><polygon id="spark-${id}-area" class="area" points=""></polygon><polyline id="spark-${id}-line" points=""></polyline><line id="spark-${id}-dot" class="dot-end" x1="0" y1="0" x2="0" y2="0"></line></svg>`;
}

/** The page: static skeleton (the script fills it with `textContent` and DOM calls only). */
export function monitorHtml(o: MonitorHtmlOptions): string {
  const n = escapeHtml(o.nonce);
  const d = escapeHtml(o.device);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${monitorCsp(o.nonce, o.cspSource)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Monitor: ${d}</title>
<link rel="stylesheet" href="${escapeHtml(o.styleUri)}">
</head>
<body>
<h1 class="sr-only">Device Monitor: <span id="device">${d}</span></h1>
<main id="main">
  <div id="banner" class="banner" role="status" hidden><span id="banner-text" class="ellipsis"></span><span id="banner-actions"></span></div>
  <div class="status">
    <span id="dot" class="dot connecting" aria-hidden="true"></span>
    <span id="state" class="state">Connecting…</span>
    <span id="line" class="muted line"></span>
  </div>
  <section id="app-card" class="card" aria-label="App">
    <div id="app-running" hidden>
      <div class="app-head"><span id="app-name" class="app-name ellipsis"></span><span id="app-meta" class="muted ellipsis"></span></div>
      <div class="metric"><span class="label">CPU</span><span id="cpu-value" class="value">—</span>${spark('cpu', 'cpu', 'CPU history')}</div>
      <div class="metric"><span class="label">MEM</span><span id="mem-value" class="value">—</span>${spark('rss', 'rss', 'Memory history')}</div>
      <div id="app-counters" class="muted"></div>
    </div>
    <div id="app-idle" class="idle">
      <span id="idle-text" class="idle-text">No app launched from VS Code yet</span>
    </div>
  </section>
</main>
<script nonce="${n}" src="${escapeHtml(o.scriptUri)}"></script>
</body>
</html>
`;
}

// --- page message gate ---

export type GateResult = { message: PageMessage; warning?: undefined } | { message?: undefined; warning?: string };

/**
 * Validates page messages for the host. Unknown types and malformed messages are ignored and
 * counted; five unknown types within ten seconds yield one warning text (then the count restarts).
 */
export class PageMessageGate {
  private readonly unknownTimes: number[] = [];
  private invalidCount = 0;

  /** Messages ignored because of a malformed shape (known type). */
  get invalid(): number {
    return this.invalidCount;
  }

  accept(raw: unknown, now: number): GateResult {
    const r = parsePageMessage(raw);
    if (r.ok) return { message: r.message };
    if (r.reason === 'invalid') {
      this.invalidCount++;
      return {};
    }
    while (this.unknownTimes.length > 0 && now - this.unknownTimes[0] >= UNKNOWN_WARN_WINDOW_MS) this.unknownTimes.shift();
    this.unknownTimes.push(now);
    if (this.unknownTimes.length >= UNKNOWN_WARN_COUNT) {
      this.unknownTimes.length = 0;
      return { warning: `Device Monitor page sent ${UNKNOWN_WARN_COUNT} unknown messages in ${UNKNOWN_WARN_WINDOW_MS / 1000} s; ignored.` };
    }
    return {};
  }
}

/** One action in flight at a time, per action name. */
export class ActionGuard {
  private readonly running = new Set<ActionName>();

  /** True when the action may start; call `finish` when it ended. */
  tryStart(name: ActionName): boolean {
    if (this.running.has(name)) return false;
    this.running.add(name);
    return true;
  }

  finish(name: ActionName): void {
    this.running.delete(name);
  }

  isRunning(name: ActionName): boolean {
    return this.running.has(name);
  }
}
