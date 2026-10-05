/**
 * Pure parts of the screen mirror (no `vscode` import, unit-tested under plain mocha): request
 * arguments, the agent version gate, parsing of the streamed JSON lines, the latest-frame gate that
 * bounds memory, the fps meter and the webview page.
 */

import { AGENT_BINARY } from './agentCore';

export const MIRROR_DEFAULTS = { fps: 4, width: 360, quality: 60 } as const;
export const MIRROR_MIN_AGENT_VERSION = '1.1.0';
/** A longer line is corrupt: the daemon's largest frame is a native-size PNG of ~2 MB. */
export const MIRROR_MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface MirrorOptions {
  fps: number;
  width: number;
  quality: number;
}

/** Numeric dotted comparison; missing parts are 0 and a non-numeric part compares as 0. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.trim().split('.');
  const pb = b.trim().split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = part(pa[i]);
    const y = part(pb[i]);
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function part(s: string | undefined): number {
  if (s === undefined || !/^\d+$/.test(s)) return 0;
  return Number(s);
}

export function agentSupportsMirror(version: string): boolean {
  return compareVersions(version, MIRROR_MIN_AGENT_VERSION) >= 0;
}

/** The words after `sfdk device exec --`. */
export function mirrorRequestArgs(o: MirrorOptions): string[] {
  return [
    AGENT_BINARY,
    '--request',
    'mirror',
    '--fps',
    String(o.fps),
    '--width',
    String(o.width),
    '--quality',
    String(o.quality),
  ];
}

export type MirrorLine =
  | { kind: 'status'; ok: true; fps: number; width: number; quality: number }
  | { kind: 'fatal'; error: string }
  | {
      kind: 'frame';
      frame: number;
      ts: number;
      screen: [number, number];
      size: [number, number];
      format: 'jpeg' | 'png';
      data: string;
    }
  | { kind: 'same'; frame: number; ts: number }
  | { kind: 'soft-error'; frame: number; ts: number; error: string };

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function pair(v: unknown): [number, number] | undefined {
  if (Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1])) return [v[0], v[1]];
  return undefined;
}

/** One stdout line of the mirror stream; undefined when it is not a well-formed protocol line. */
export function parseMirrorLine(line: string): MirrorLine | undefined {
  if (line.length > MIRROR_MAX_LINE_BYTES) return undefined;
  const text = line.trim();
  if (!text.startsWith('{')) return undefined;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    o = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof o.ok === 'boolean') {
    if (!o.ok) return typeof o.error === 'string' ? { kind: 'fatal', error: o.error } : undefined;
    if (o.stream === 'mirror' && isNum(o.fps) && isNum(o.width) && isNum(o.quality)) {
      return { kind: 'status', ok: true, fps: o.fps, width: o.width, quality: o.quality };
    }
    return undefined;
  }
  if (!isNum(o.frame) || !isNum(o.ts)) return undefined;
  if (o.same === true) return { kind: 'same', frame: o.frame, ts: o.ts };
  if (typeof o.error === 'string') return { kind: 'soft-error', frame: o.frame, ts: o.ts, error: o.error };
  const screen = pair(o.screen);
  const size = pair(o.size);
  if (!screen || !size) return undefined;
  if (o.format !== 'jpeg' && o.format !== 'png') return undefined;
  if (typeof o.data !== 'string' || !BASE64_RE.test(o.data)) return undefined;
  return { kind: 'frame', frame: o.frame, ts: o.ts, screen, size, format: o.format, data: o.data };
}

export function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/**
 * At most one frame in flight to the webview and one pending; a newer pending frame replaces the
 * older one (counted in `dropped`).
 */
export class LatestFrame<F = unknown> {
  private inFlight = false;
  private pending: F | undefined;
  private hasPending = false;
  dropped = 0;

  /** The frame to post now (nothing in flight), or undefined when it was stored as pending. */
  offer(f: F): F | undefined {
    if (!this.inFlight) {
      this.inFlight = true;
      return f;
    }
    if (this.hasPending) this.dropped++;
    this.pending = f;
    this.hasPending = true;
    return undefined;
  }

  /** The webview showed the frame: the pending frame to post next, if any (marked in flight). */
  acked(): F | undefined {
    if (!this.hasPending) {
      this.inFlight = false;
      return undefined;
    }
    const f = this.pending;
    this.pending = undefined;
    this.hasPending = false;
    return f;
  }
}

/** Frames per second over the last 3 seconds. */
export class FpsMeter {
  private readonly stamps: number[] = [];
  private static readonly WINDOW_MS = 3000;

  tick(nowMs: number): void {
    this.stamps.push(nowMs);
    this.trim(nowMs);
  }

  fps(nowMs: number): number {
    this.trim(nowMs);
    return this.stamps.length / (FpsMeter.WINDOW_MS / 1000);
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - FpsMeter.WINDOW_MS;
    while (this.stamps.length > 0 && this.stamps[0] <= cutoff) this.stamps.shift();
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The self-contained mirror page: one image, a status strip and a Reconnect button. No input. */
export function mirrorHtml(nonce: string, device: string): string {
  const n = escapeHtml(nonce);
  const d = escapeHtml(device);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${n}'; script-src 'nonce-${n}'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mirror: ${d}</title>
<style nonce="${n}">
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  #strip { display: flex; gap: 12px; align-items: center; padding: 4px 8px; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
  #strip .grow { flex: 1; }
  #stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
  #screen { max-width: 100%; max-height: 100%; object-fit: contain; }
  #reconnect { display: none; }
  #reconnect.visible { display: inline-block; }
</style>
</head>
<body>
<div id="strip">
  <span id="device">${d}</span>
  <span id="size"></span>
  <span id="fps"></span>
  <span id="state" class="grow">connecting</span>
  <button id="reconnect" type="button">Reconnect</button>
</div>
<div id="stage"><img id="screen" alt="Device screen"></div>
<script nonce="${n}">
(function () {
  var vscode = acquireVsCodeApi();
  var img = document.getElementById('screen');
  var stateEl = document.getElementById('state');
  var sizeEl = document.getElementById('size');
  var fpsEl = document.getElementById('fps');
  var button = document.getElementById('reconnect');
  var current = 0;
  img.addEventListener('load', function () { vscode.postMessage({ type: 'shown', frame: current }); });
  img.addEventListener('error', function () { vscode.postMessage({ type: 'shown', frame: current }); });
  button.addEventListener('click', function () { vscode.postMessage({ type: 'reconnect' }); });
  window.addEventListener('message', function (event) {
    var m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'frame') {
      current = m.frame;
      var mime = m.format === 'png' ? 'image/png' : 'image/jpeg';
      img.src = 'data:' + mime + ';base64,' + m.data;
      if (m.screen) sizeEl.textContent = m.screen[0] + 'x' + m.screen[1];
    } else if (m.type === 'state') {
      stateEl.textContent = m.reason ? m.state + ': ' + m.reason : m.state;
      if (typeof m.fps === 'number') fpsEl.textContent = m.fps.toFixed(1) + ' fps';
      if (m.screen) sizeEl.textContent = m.screen[0] + 'x' + m.screen[1];
      button.classList.toggle('visible', m.state === 'disconnected');
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>
`;
}
