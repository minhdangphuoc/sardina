/**
 * Pure host side of the Device Monitor page: the panel HTML (CSP with a nonce, static skeleton,
 * no inline handlers), the gate every page message passes through, the one-in-flight guard for
 * actions and the conversion of the page's save filter. No `vscode` import.
 */

import { escapeHtml } from '../agent/mirrorCore';
import { parseQuery, type AppIdentity, type LogFilters } from './logModel';
import { parsePageMessage, type ActionName, type AppIdentityWire, type PageMessage, type SaveFilter } from './protocol';

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

function section(id: string, title: string, body: string): string {
  return `<section id="sec-${id}" class="section" aria-labelledby="h-${id}">
  <h2 id="h-${id}"><button type="button" class="disclosure" id="toggle-${id}" aria-expanded="true" aria-controls="body-${id}"><span class="chev" aria-hidden="true">▾</span>${title}</button></h2>
  <div id="body-${id}" class="section-body">
${body}
  </div>
</section>`;
}

const LOG_TOOLBAR = `    <div class="toolbar" role="toolbar" aria-label="Log filters">
      <label class="field">Level <select id="log-level">
        <option value="verbose">Verbose</option><option value="debug">Debug</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option>
      </select></label>
      <span class="menu-wrap"><button type="button" id="log-tags-btn" aria-haspopup="true" aria-expanded="false" aria-controls="log-tags-menu">Tags</button>
        <div id="log-tags-menu" class="popover" role="group" aria-label="Tags" hidden></div></span>
      <button type="button" id="log-mine" aria-pressed="false" title="Only lines from the app launched from VS Code">Mine</button>
      <input type="search" id="log-query" class="query" aria-label="Filter log" aria-describedby="log-query-hint" placeholder="Filter: text, -exclude, tag:x, pid:1, level:w, /regex/" autocomplete="off" spellcheck="false">
      <span id="log-query-hint" class="sr-only">Plain text, minus to exclude, tag colon, pid colon, level colon, or slash regular expression slash. Press slash to focus, Escape to clear.</span>
      <label class="check"><input type="checkbox" id="log-group" checked> Group stack frames</label>
      <label class="check"><input type="checkbox" id="log-derive"> Derive levels from text</label>
      <button type="button" id="log-expand">Expand all</button>
      <button type="button" id="log-collapse">Collapse all</button>
      <button type="button" id="log-pause" aria-pressed="false" title="Pause (p)">Pause</button>
      <button type="button" id="log-clear">Clear</button>
      <span class="save-group"><button type="button" id="log-save">Save…</button>
        <select id="log-save-format" aria-label="Save format"><option value="log">.log</option><option value="jsonl">.jsonl</option></select>
        <label class="check"><input type="checkbox" id="log-save-filtered" checked> only what the filters show</label></span>
      <span class="menu-wrap"><button type="button" id="log-help" aria-haspopup="true" aria-expanded="false" aria-controls="log-help-pop" aria-label="Keyboard shortcuts">?</button>
        <div id="log-help-pop" class="popover help" role="dialog" aria-label="Keyboard shortcuts" hidden>
          <dl>
            <dt>Up, Down</dt><dd>Move the active row</dd>
            <dt>Home, End</dt><dd>First row; last row and follow new lines</dd>
            <dt>Page Up, Page Down</dt><dd>Move a page</dd>
            <dt>Right, Left</dt><dd>Expand or collapse a folded entry</dd>
            <dt>Enter</dt><dd>Open the source link of the row, else expand or collapse</dd>
            <dt>/</dt><dd>Focus the filter</dd>
            <dt>Escape</dt><dd>Clear the filter; close this help</dd>
            <dt>p</dt><dd>Pause or resume</dd>
            <dt>?</dt><dd>Show this help</dd>
          </dl>
        </div></span>
    </div>
    <div class="status-line"><span id="log-status" role="status" aria-live="polite">Waiting for the device…</span>
      <button type="button" id="log-resume" hidden>Resume</button>
      <button type="button" id="log-install" hidden>Install Device Agent</button>
      <button type="button" id="log-jump" hidden>Jump to end</button></div>
    <div id="log-grid" class="grid" role="grid" aria-label="Device log" aria-rowcount="1" tabindex="0">
      <div class="row head" role="row" aria-rowindex="1">
        <div class="cell time" role="columnheader">Time<span class="sep" role="separator" aria-orientation="vertical" tabindex="0" data-col="time" aria-label="Resize the time column"></span></div>
        <div class="cell lvl" role="columnheader">Lvl</div>
        <div class="cell pid" role="columnheader">PID<span class="sep" role="separator" aria-orientation="vertical" tabindex="0" data-col="pid" aria-label="Resize the PID column"></span></div>
        <div class="cell tag" role="columnheader">Tag<span class="sep" role="separator" aria-orientation="vertical" tabindex="0" data-col="tag" aria-label="Resize the tag column"></span></div>
        <div class="cell msg" role="columnheader">Message</div>
      </div>
      <div id="log-body" class="body" role="rowgroup"><div id="log-spacer" class="spacer"></div></div>
    </div>`;

/** The page: static skeleton (the script fills it with `textContent` and DOM calls only). */
export function monitorHtml(o: MonitorHtmlOptions): string {
  const n = escapeHtml(o.nonce);
  const d = escapeHtml(o.device);
  const overview = `    <dl id="overview-list" class="kv"></dl>
    <p id="overview-empty" class="muted">Reading the device…</p>`;
  const sessions = `    <ul id="sessions-list" class="sessions"></ul>
    <p id="sessions-empty" class="muted">No sessions on this device.</p>`;
  const app = `    <p id="app-empty" class="muted">No app launched from VS Code yet</p>
    <div id="app-body" hidden>
      <dl id="app-kv" class="kv"></dl>
      <p id="app-counters" class="muted"></p>
      <p id="app-source" class="muted small"></p>
      <div class="sparks">
        <figure class="spark-fig"><figcaption id="spark-cpu-cap">CPU</figcaption>
          <svg id="spark-cpu" class="spark cpu" viewBox="0 0 120 32" preserveAspectRatio="none" role="img" aria-labelledby="spark-cpu-t"><title id="spark-cpu-t">CPU history</title><polyline id="spark-cpu-line" points=""></polyline></svg></figure>
        <figure class="spark-fig"><figcaption id="spark-rss-cap">Memory</figcaption>
          <svg id="spark-rss" class="spark rss" viewBox="0 0 120 32" preserveAspectRatio="none" role="img" aria-labelledby="spark-rss-t"><title id="spark-rss-t">Memory history</title><polyline id="spark-rss-line" points=""></polyline></svg></figure>
      </div>
    </div>`;
  const actions = `    <div class="actions">
      <span class="action"><button type="button" id="act-restartApp" data-action="restartApp" aria-describedby="why-restartApp">Restart app</button><span id="why-restartApp" class="why"></span></span>
      <span class="action"><button type="button" id="act-stopApp" data-action="stopApp" aria-describedby="why-stopApp">Stop app</button><span id="why-stopApp" class="why"></span></span>
      <span class="action"><button type="button" id="act-screenshot" data-action="screenshot" aria-describedby="why-screenshot">Screenshot</button><span id="why-screenshot" class="why"></span></span>
      <span class="action"><button type="button" id="act-openMirror" data-action="openMirror" aria-describedby="why-openMirror">Open mirror</button><span id="why-openMirror" class="why"></span></span>
      <span class="action"><button type="button" id="act-refresh" data-action="refresh" aria-describedby="why-refresh">Refresh</button><span id="why-refresh" class="why"></span></span>
    </div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${monitorCsp(o.nonce, o.cspSource)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Device Monitor: ${d}</title>
<link rel="stylesheet" href="${escapeHtml(o.styleUri)}">
</head>
<body>
<header class="top">
  <h1>Device Monitor: <span id="device">${d}</span></h1>
  <div id="banner" class="banner" role="status" hidden><span id="banner-text"></span><span id="banner-actions"></span></div>
</header>
<main id="main">
${section('overview', 'Overview', overview)}
${section('sessions', 'Sessions', sessions)}
${section('app', 'App', app)}
${section('logs', 'Logs', LOG_TOOLBAR)}
${section('actions', 'Actions', actions)}
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

/** The save dialog's "only what the filters show": the page's filter rebuilt as the model's `LogFilters`. */
export function toLogFilters(f: SaveFilter, identity: AppIdentityWire | undefined): LogFilters {
  const mine: AppIdentity | undefined = f.mine && identity ? { name: identity.name, binary: identity.binary, pids: new Set(identity.pids) } : undefined;
  // "mine" with no known app matches nothing rather than everything
  const noApp = f.mine && !identity;
  const filters: LogFilters = {
    minLevel: f.minLevel,
    tags: f.tags,
    mine: mine ?? (noApp ? { pids: new Set<number>() } : undefined),
    query: parseQuery(f.query),
    deriveLevels: f.deriveLevels,
  };
  return filters;
}
