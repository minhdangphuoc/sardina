/**
 * Pure parts of the screen mirror (no `vscode` import, unit-tested under plain mocha): request
 * arguments, the agent version gate, parsing of the streamed JSON lines, the latest-frame gate that
 * bounds memory, the fps meter and the webview page.
 */

import { AGENT_BINARY, AGENT_PACKAGE, clientName } from './agentCore';
import { MIRROR_CONTACT_TIMING, MIRROR_INPUT_MIN_AGENT_VERSION } from './mirrorInput';

export const MIRROR_DEFAULTS = { fps: 4, width: 360, quality: 60 } as const;
/**
 * The VP8 request (agent 1.6.0, `"encoding":"vp8"`): up to 60 fps at 720 px wide (or the screen's
 * width when narrower) and a target of 2000 kbit/s; adaptive quality lowers bitrate and width. The
 * phone caps the rate: agent 1.10.7 at its Frame rate limit (30 unless set to 60 on the phone),
 * older agents at 30. The status line says what the stream got.
 */
export const MIRROR_VIDEO_DEFAULTS = { fps: 60, width: 720, quality: MIRROR_DEFAULTS.quality, bitrate: 2000 } as const;
/** The codec the page decodes with WebCodecs; the only video codec the agent offers. */
export const VIDEO_CODEC = 'vp8';
export const MIRROR_MIN_AGENT_VERSION = '1.1.0';
/** The first agent that answers `ping` with `socket` and `mirrorEncodings`, so the ssh forward can be used. */
export const MIRROR_FORWARD_MIN_AGENT_VERSION = '1.2.0';
/** The first agent that knows the request fields `phoneState` and `client` and the in-stream `settings` message. */
export const MIRROR_PHONE_STATE_MIN_AGENT_VERSION = '1.9.0';
/** A binary record's payload is 1..this many bytes; the largest frame is a native-size PNG. */
export const MIRROR_MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** The mirror lease asked of the agent; the keepalive runs every `MIRROR_TIMING.keepaliveIntervalMs`. */
export const LEASE_SECONDS = 60;
/**
 * Mutable so tests can shorten the intervals. `statsFirstMs`/`statsIntervalMs`: the full strip
 * (fps, bitrate, latency, sizes) is logged this long after the stream goes live, then this often.
 */
export const MIRROR_TIMING = { keepaliveIntervalMs: 20_000, statsFirstMs: 10_000, statsIntervalMs: 60_000 };
const MAX_ERROR_CHARS = 300;
const MAX_DIMENSION = 10000;
const MAX_MS = 60000;
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

export function agentSupportsForward(version: string): boolean {
  return compareVersions(version, MIRROR_FORWARD_MIN_AGENT_VERSION) >= 0;
}

/** The agent reports the phone's own settings in the stream (opt-in with `phoneState`). */
export function agentSupportsPhoneState(version: string): boolean {
  return compareVersions(version, MIRROR_PHONE_STATE_MIN_AGENT_VERSION) >= 0;
}

/** Input is opt-in only when both the 1.7 protocol version and both gesture capabilities are explicit. */
export function agentSupportsInput(probe: { version: string; mirrorInput?: string[] }): boolean {
  return (
    compareVersions(probe.version, MIRROR_INPUT_MIN_AGENT_VERSION) >= 0 &&
    probe.mirrorInput?.includes('tap') === true &&
    probe.mirrorInput.includes('swipe')
  );
}

/** The agent offers VP8 video (agent 1.6.0 lists `vp8` in `mirrorEncodings`). */
export function agentSupportsVideo(probe: { mirrorEncodings?: string[] }): boolean {
  return probe.mirrorEncodings?.includes(VIDEO_CODEC) === true;
}

/**
 * The codecs a page reported in its `ready` message (`{type:'ready', codecs:['vp8']}`): only known
 * names are kept; anything malformed reads as none, so the mirror uses JPEG.
 */
export function pageCodecs(m: unknown): string[] {
  const codecs = (m as { codecs?: unknown } | null)?.codecs;
  if (!Array.isArray(codecs)) return [];
  return codecs.filter((c): c is string => c === VIDEO_CODEC).slice(0, 1);
}

/** What a newer agent adds, for the update notices. */
export const AGENT_UPDATE_BENEFITS = 'ssh forward, native capture, adaptive quality, VP8 video, interactive control, steady frame rate';

/**
 * The newest agent version among RPM file names (`sailfish-devagent-<version>-<release>.<arch>.rpm`),
 * i.e. the agent this extension bundles; undefined when no name matches.
 */
export function bundledAgentVersion(fileNames: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const f of fileNames) {
    const m = new RegExp(`^${AGENT_PACKAGE}-(\\d+(?:\\.\\d+)*)-[^-]+\\.[^.-]+\\.rpm$`).exec(f);
    if (m && (best === undefined || compareVersions(m[1], best) > 0)) best = m[1];
  }
  return best;
}

/** True when the running agent is older than the bundled one (an unparsable running version is not). */
export function agentUpdateAvailable(running: string, bundled: string | undefined): boolean {
  return bundled !== undefined && /^\d+(\.\d+)*$/.test(running.trim()) && compareVersions(running, bundled) < 0;
}

export function agentUpdateNotice(device: string, running: string, bundled: string): string {
  return `Sailfish: the device agent on "${device}" is ${running}; this extension includes ${bundled} (faster mirror: ${AGENT_UPDATE_BENEFITS}).`;
}

/** The strip's reason for the sfdk path when the agent is too old for the forward. */
export function staleAgentReason(running: string): string {
  return `agent ${running} — update for the fast mirror`;
}

/** The words after `sfdk device exec --`. `--lease N` is appended only when `lease` is given. */
export function mirrorRequestArgs(
  o: MirrorOptions & { lease?: number; input?: boolean; phoneState?: boolean; client?: string },
): string[] {
  const args = [
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
  if (o.lease !== undefined) args.push('--lease', String(o.lease));
  if (o.input) args.push('--input');
  if (o.phoneState) args.push('--phone-state');
  // The words go through a remote shell, which would split a space: none is sent.
  const client = o.client === undefined ? '' : clientName(o.client).replace(/ /g, '-');
  if (client) args.push('--client', client);
  return args;
}

/**
 * Agent 1.9.0, requests with `phoneState`: the phone's `control`/`touchIndicator` switches right after
 * the status and on every change, with the input fields the status line has (only when input was asked).
 */
export interface PhoneSettingsLine {
  kind: 'settings';
  control?: boolean;
  touchIndicator?: boolean;
  idleMode?: boolean;
  /** Agent 1.10.7: the phone's frame rate limit (30 or 60). */
  maxFps?: 30 | 60;
  touchIndicatorPath?: TouchIndicatorPath;
  input?: boolean;
  inputLease?: number;
  inputError?: string;
}

export type TouchIndicatorPath = 'phone' | 'mirror' | 'off';

export interface ContactLine {
  kind: 'contact';
  x: number;
  y: number;
  down: boolean;
}

export type MirrorLine =
  | {
      kind: 'status';
      ok: true;
      fps: number;
      width: number;
      quality: number;
      encoding?: string;
      window?: number;
      lease?: number;
      /** Agent 1.4.0, binary streams that asked for it: image headers carry the adaptive-quality fields. */
      adapt?: boolean;
      /** Agent 1.6.0, `"encoding":"vp8"`: the target bitrate in kbit/s. */
      bitrate?: number;
      /** Agent 1.7.0 accepted the request's input opt-in; absent/false is strictly view-only. */
      input?: boolean;
      /** Seconds before the device drops input-active state without another active message. */
      inputLease?: number;
      /** A bounded reason when input was requested but could not be enabled. */
      inputError?: string;
    }
  | { kind: 'fatal'; error: string }
  | PhoneSettingsLine
  | ContactLine
  | {
      kind: 'frame';
      frame: number;
      ts: number;
      screen: [number, number];
      size: [number, number];
      format: 'jpeg' | 'png';
      data: string;
      cms?: number;
      ems?: number;
    } & AdaptFields
  | { kind: 'same'; frame: number; ts: number }
  | { kind: 'soft-error'; frame: number; ts: number; error: string }
  | { kind: 'pong'; seq: number; ts: number };

/**
 * Image-header fields of an adaptive stream (agent 1.4.0): the JPEG quality the frame was encoded
 * with, the round trip in ms of the latest acknowledged image and that image's frame number, and
 * the cumulative tick counters (`skips`: ticks skipped because of the link). All optional.
 */
export interface AdaptFields {
  q?: number;
  rtt?: number;
  rttFrame?: number;
  ticks?: number;
  skips?: number;
  /** Agent 1.5.0+: how the frame was captured; absent when not reported. */
  capture?: 'native' | 'screenshot';
  /** Agent 1.6.0, VP8 frames of an adaptive stream: the target bitrate the frame was encoded at, kbit/s. */
  kbps?: number;
}

/**
 * The fields of a VP8 record (agent 1.6.0): `key` marks a key frame, `pts` is the frame's time in
 * ms on the stream's monotonic clock (the decoder's timestamp), `cvms` the scale-and-convert part
 * of `ems`. Required for `format: 'vp8'`, absent otherwise.
 */
export interface VideoFields {
  key?: boolean;
  pts?: number;
  cvms?: number;
  /** Agent 1.8.0: the agent's frame slot in ms (its paced frame interval). */
  pace?: number;
  /** Agent 1.8.0: the unchanged last picture encoded again on an idle screen (it sharpens). */
  refresh?: boolean;
  /** Agent 1.10.7: where the phone spent the time of a captured frame (absent on re-encodes). */
  stages?: FrameStages;
}

/**
 * The stage times of one captured VP8 frame (agent 1.10.7), ms: `hold` the request was held for the
 * pace or the link after the previous frame arrived, `wait` for the compositor's render, `readback`
 * its screen readback and delivery, `convert`, `encode`, and `send` the socket write of the frame
 * before. A missing one was not measured.
 */
export interface FrameStages {
  hold?: number;
  wait?: number;
  readback?: number;
  convert?: number;
  encode?: number;
  send?: number;
}

const STAGE_FIELDS: readonly [keyof FrameStages, string][] = [
  ['hold', 'hms'], ['wait', 'wms'], ['readback', 'rbms'], ['convert', 'cnms'], ['encode', 'enms'], ['send', 'sdms'],
];

function parseStages(o: Record<string, unknown>): FrameStages | undefined {
  const st: FrameStages = {};
  let any = false;
  for (const [name, field] of STAGE_FIELDS) {
    const v = clampMs(o[field]);
    if (v !== undefined) {
      st[name] = v;
      any = true;
    }
  }
  return any ? st : undefined;
}

export type MirrorFormat = 'jpeg' | 'png' | 'vp8';

/** The header of a binary image record: the fields of a text frame, with `bytes` instead of `data`. */
export interface MirrorRecordHeader extends AdaptFields, VideoFields {
  kind: 'frame';
  frame: number;
  ts: number;
  screen: [number, number];
  size: [number, number];
  format: MirrorFormat;
  bytes: number;
  cms?: number;
  ems?: number;
}

/** A `MirrorLine` without `status` (a record never carries one), or an image header. */
export type MirrorRecordHeaderOrLine = Exclude<MirrorLine, { kind: 'status' | 'frame' }> | MirrorRecordHeader;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isDimension(v: unknown): v is number {
  return isNum(v) && Number.isInteger(v) && v >= 1 && v <= MAX_DIMENSION;
}

function pair(v: unknown): [number, number] | undefined {
  if (Array.isArray(v) && v.length === 2 && isDimension(v[0]) && isDimension(v[1])) return [v[0], v[1]];
  return undefined;
}

function clampMs(v: unknown): number | undefined {
  if (!isNum(v)) return undefined;
  return Math.min(MAX_MS, Math.max(0, v));
}

function counter(v: unknown): number | undefined {
  return isNum(v) && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : undefined;
}

/** Copies the valid adaptive-quality fields of `o` onto `h`; invalid ones are dropped, not fatal. */
function adaptFields(o: Record<string, unknown>, h: AdaptFields): void {
  if (isNum(o.q) && Number.isInteger(o.q) && o.q >= 1 && o.q <= 100) h.q = o.q;
  const rtt = clampMs(o.rtt);
  const rttFrame = counter(o.rttFrame);
  if (rtt !== undefined) {
    h.rtt = rtt;
    if (rttFrame !== undefined && rttFrame >= 1) h.rttFrame = rttFrame;
  }
  if (isNum(o.kbps) && Number.isInteger(o.kbps) && o.kbps >= 1 && o.kbps <= 100_000) h.kbps = o.kbps;
  const ticks = counter(o.ticks);
  const skips = counter(o.skips);
  if (ticks !== undefined && skips !== undefined && skips <= ticks) {
    h.ticks = ticks;
    h.skips = skips;
  }
  if (o.capture === 'native' || o.capture === 'screenshot') {
    h.capture = o.capture; // agents before 1.10.5 may still say screenshot: input stays off for it
  }
}

function truncate(s: string): string {
  return s.length > MAX_ERROR_CHARS ? s.slice(0, MAX_ERROR_CHARS) : s;
}

function parseSettings(o: Record<string, unknown>): PhoneSettingsLine | undefined {
  const inner = o.settings;
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined;
  const v = inner as Record<string, unknown>;
  const m: PhoneSettingsLine = { kind: 'settings' };
  if (typeof v.control === 'boolean') m.control = v.control;
  if (typeof v.touchIndicator === 'boolean') m.touchIndicator = v.touchIndicator;
  if (typeof v.idleMode === 'boolean') m.idleMode = v.idleMode;
  if (v.maxFps === 30 || v.maxFps === 60) m.maxFps = v.maxFps;
  if (v.touchIndicatorPath === 'phone' || v.touchIndicatorPath === 'mirror' || v.touchIndicatorPath === 'off') {
    m.touchIndicatorPath = v.touchIndicatorPath;
  }
  if (o.input === true) {
    // Input on needs a valid lease; without one it stays off (fail closed).
    const ok = isNum(o.inputLease) && Number.isInteger(o.inputLease) && o.inputLease >= 1 && o.inputLease <= 30;
    m.input = ok;
    if (ok) m.inputLease = o.inputLease as number;
  } else if (o.input === false) {
    m.input = false;
    if (typeof o.inputError === 'string') m.inputError = truncate(o.inputError.replace(/[\u0000-\u001f\u007f]/g, ' '));
  }
  return m;
}

function parseContact(o: Record<string, unknown>): ContactLine | undefined {
  const inner = o.contact;
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined;
  const v = inner as Record<string, unknown>;
  if (!isNum(v.x) || !Number.isInteger(v.x) || !isNum(v.y) || !Number.isInteger(v.y) || typeof v.down !== 'boolean') return undefined;
  const x = v.x;
  const y = v.y;
  if (x < 0 || y < 0 || x > MAX_DIMENSION || y > MAX_DIMENSION) return undefined;
  return { kind: 'contact', x, y, down: v.down };
}

/**
 * Validates one parsed header object. `line` is a text-mode stream line (a frame carries `data`,
 * and the status line is allowed); `record` is a binary record header (a frame carries `bytes`
 * of 1..MIRROR_MAX_FRAME_BYTES and there is no status). Everything else is shared.
 */
export function parseMirrorHeader(o: Record<string, unknown>, mode: 'line'): MirrorLine | undefined;
export function parseMirrorHeader(o: Record<string, unknown>, mode: 'record'): MirrorRecordHeaderOrLine | undefined;
export function parseMirrorHeader(
  o: Record<string, unknown>,
  mode: 'line' | 'record',
): MirrorLine | MirrorRecordHeader | undefined;
export function parseMirrorHeader(
  o: Record<string, unknown>,
  mode: 'line' | 'record',
): MirrorLine | MirrorRecordHeader | undefined {
  if (typeof o.ok === 'boolean') {
    if (!o.ok) return typeof o.error === 'string' ? { kind: 'fatal', error: truncate(o.error) } : undefined;
    if (mode === 'record') return undefined;
    if (o.stream === 'mirror' && isNum(o.fps) && isNum(o.width) && isNum(o.quality)) {
      const status: MirrorLine = { kind: 'status', ok: true, fps: o.fps, width: o.width, quality: o.quality };
      if (typeof o.encoding === 'string') status.encoding = o.encoding;
      if (isNum(o.window)) status.window = o.window;
      if (isNum(o.lease)) status.lease = o.lease;
      if (o.adapt === true) status.adapt = true;
      if (isNum(o.bitrate) && Number.isInteger(o.bitrate) && o.bitrate >= 1 && o.bitrate <= 100_000) status.bitrate = o.bitrate;
      if (o.input === true && isNum(o.inputLease) && Number.isInteger(o.inputLease) && o.inputLease >= 1 && o.inputLease <= 30) {
        status.input = true;
        status.inputLease = o.inputLease;
      } else if (o.input === false) {
        status.input = false;
        if (typeof o.inputError === 'string') status.inputError = truncate(o.inputError.replace(/[\u0000-\u001f\u007f]/g, ' '));
      }
      return status;
    }
    return undefined;
  }
  if ('settings' in o) return parseSettings(o);
  if ('contact' in o) return parseContact(o);
  if (isNum(o.pong)) {
    if (!Number.isInteger(o.pong) || o.pong < 0 || !isNum(o.ts)) return undefined;
    return { kind: 'pong', seq: o.pong, ts: o.ts };
  }
  if (!isNum(o.frame) || !isNum(o.ts)) return undefined;
  if (o.same === true) return { kind: 'same', frame: o.frame, ts: o.ts };
  if (typeof o.error === 'string') {
    return { kind: 'soft-error', frame: o.frame, ts: o.ts, error: truncate(o.error) };
  }
  const screen = pair(o.screen);
  const size = pair(o.size);
  if (!screen || !size) return undefined;
  // VP8 travels only in binary records: a text line never carries video.
  if (o.format !== 'jpeg' && o.format !== 'png' && !(o.format === 'vp8' && mode === 'record')) return undefined;
  const cms = clampMs(o.cms);
  const ems = clampMs(o.ems);
  if (o.format === 'vp8' && (typeof o.key !== 'boolean' || counter(o.pts) === undefined)) return undefined;
  if (mode === 'record') {
    if (!isNum(o.bytes) || !Number.isInteger(o.bytes) || o.bytes < 1 || o.bytes > MIRROR_MAX_FRAME_BYTES) {
      return undefined;
    }
    const h: MirrorRecordHeader = {
      kind: 'frame', frame: o.frame, ts: o.ts, screen, size, format: o.format, bytes: o.bytes,
    };
    if (cms !== undefined) h.cms = cms;
    if (ems !== undefined) h.ems = ems;
    adaptFields(o, h);
    if (o.format === 'vp8') {
      h.key = o.key as boolean;
      h.pts = o.pts as number;
      const cvms = clampMs(o.cvms);
      if (cvms !== undefined) h.cvms = cvms;
      // Agent 1.8.0; a malformed value is dropped without failing the frame.
      if (isNum(o.pace) && Number.isInteger(o.pace) && o.pace >= 1 && o.pace <= 60000) h.pace = o.pace;
      if (o.refresh === true) h.refresh = true;
      const stages = parseStages(o);
      if (stages) h.stages = stages;
    }
    return h;
  }
  if (typeof o.data !== 'string' || !BASE64_RE.test(o.data)) return undefined;
  const f: Extract<MirrorLine, { kind: 'frame' }> = { kind: 'frame', frame: o.frame, ts: o.ts, screen, size, format: o.format as 'jpeg' | 'png', data: o.data };
  if (cms !== undefined) f.cms = cms;
  if (ems !== undefined) f.ems = ems;
  adaptFields(o, f);
  return f;
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
  // Like every header, a settings message is at most 4 KiB (only frames are large).
  if (('settings' in o || 'contact' in o) && text.length > 4096) return undefined;
  return parseMirrorHeader(o, 'line');
}

/** The upstream keepalive line; the agent only logs `seq` and renews the lease. */
export function keepaliveLine(seq: number): string {
  return `{"keepalive":${seq}}\n`;
}

export interface KeepaliveTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * Decides when keepalives go out: from the moment the stream is `streaming` (status line parsed)
 * and the panel is `visible`, one at once and then one per `MIRROR_TIMING.keepaliveIntervalMs`;
 * never otherwise. `seq` grows by one per send for the lifetime of the schedule.
 */
export class KeepaliveSchedule {
  private handle: unknown;
  private running = false;
  private disposed = false;
  private seq = 0;

  constructor(
    private readonly send: (seq: number) => void,
    private readonly timers: KeepaliveTimers = {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
  ) {}

  update(s: { streaming: boolean; visible: boolean }): void {
    if (this.disposed) return;
    const on = s.streaming && s.visible;
    if (on === this.running) return;
    this.running = on;
    if (on) {
      this.tick();
      this.handle = this.timers.setInterval(() => this.tick(), MIRROR_TIMING.keepaliveIntervalMs);
    } else {
      this.stop();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    this.stop();
  }

  private tick(): void {
    this.send(++this.seq);
  }

  private stop(): void {
    if (this.handle !== undefined) this.timers.clearInterval(this.handle);
    this.handle = undefined;
  }
}

/**
 * Estimates device clock minus PC clock from keepalive round trips (NTP style:
 * offset = deviceTs - (sentAt + rtt / 2)). Queueing behind frames on a slow link only ever adds
 * delay (and unevenly, so the midpoint assumption breaks), so the offset comes from the sample
 * with the smallest round trip among the last 8; on a tie the newest wins. A single sample is used as is.
 */
export class ClockOffset {
  private readonly samples: { rtt: number; offset: number }[] = [];
  private static readonly KEEP = 8;

  addPong(sentAt: number, deviceTs: number, receivedAt: number): void {
    const rtt = Math.max(0, receivedAt - sentAt);
    this.samples.push({ rtt, offset: deviceTs - (sentAt + rtt / 2) });
    if (this.samples.length > ClockOffset.KEEP) this.samples.shift();
  }

  get offsetMs(): number | undefined {
    let best: { rtt: number; offset: number } | undefined;
    for (const s of this.samples) if (best === undefined || s.rtt <= best.rtt) best = s;
    return best?.offset;
  }
}

/** PC receive time minus the frame's capture time on the PC clock (never negative). */
export function latencyMs(frameTs: number, receivedAt: number, offset: number): number {
  return Math.max(0, receivedAt - (frameTs - offset));
}

export interface MirrorStatus {
  state: string;
  transport?: 'ssh' | 'sfdk';
  fallbackReason?: string;
  /** The capture path the agent reported on the last frame; undefined when not reported. */
  capture?: 'native' | 'screenshot';
  reason?: string;
  fps?: number;
  latencyMs?: number;
  frameMs?: number;
  dropped?: number;
  /**
   * The last image's size and JPEG quality; `reduced` while adaptive quality is below the top level,
   * `reducedFor` the causes when the controller named them (the link when absent).
   */
  image?: { width: number; height: number; quality?: number; reduced?: boolean; reducedFor?: readonly ('link' | 'cpu')[] };
  /** The stream's codec (`jpeg`, `png`, `vp8`), shown after the transport. */
  codec?: string;
  /** Received payload, kbit/s over the last 3 s. */
  kbps?: number;
  /** VP8: the size and target bitrate of the last frame; `reduced` and `reducedFor` as for `image`. */
  video?: { width: number; height: number; targetKbps?: number; reduced?: boolean; reducedFor?: readonly ('link' | 'cpu')[] };
  /** The screen has not changed for a while (the agent reports it): shown instead of the frame rate. */
  idle?: boolean;
  /** The phone's idle mode switch, once the agent reported it (1.10.6); off: the stream never goes idle. */
  idleMode?: boolean;
  /** The phone's frame rate limit, once the agent reported it (1.10.7). */
  maxFps?: number;
  /** Medians of the latest captured frames' stage times (agent 1.10.7). */
  stages?: FrameStages;
  /** Captured (not re-encoded) frames per second, from the frames that carry stage times. */
  capturedFps?: number;
  /** The phone has turned control off (Settings page); shown as a part of the live strip. */
  controlOffReason?: string;
  touchIndicatorPath?: TouchIndicatorPath;
  /** The frame rate the stream asked for (the status line's `fps`): the pace in the details. */
  paceFps?: number;
  /** A frame the phone could not produce (its error text); shown in the details. */
  softError?: string;
  /** The agent reported a keypad, but this workspace has no user-selected layout for its model. */
  keypadLayoutMissing?: boolean;
}

/** No screen change for this long, with the agent saying the screen is unchanged: the strip says idle. */
export const MIRROR_IDLE_MS = 1000;

/**
 * Whether the screen is idle: the latest sign from the agent is an unchanged screen (`same`, or an
 * agent 1.8.0 refresh) and no changed frame came for MIRROR_IDLE_MS. A stalled stream sends
 * neither, so it never reads as idle.
 */
export function screenIdle(lastChangeAt: number | undefined, lastSameAt: number | undefined, now: number): boolean {
  if (lastSameAt === undefined) return false;
  if (lastChangeAt !== undefined && lastChangeAt >= lastSameAt) return false;
  return lastChangeAt === undefined || now - lastChangeAt >= MIRROR_IDLE_MS;
}

/** ` (reduced for …)`, naming the causes of an adaptive reduction. */
function reducedText(reduced: boolean | undefined, causes: readonly ('link' | 'cpu')[] | undefined): string {
  if (!reduced) return '';
  const link = causes === undefined || causes.length === 0 || causes.includes('link');
  const cpu = causes !== undefined && causes.includes('cpu');
  return ` (reduced for ${link && cpu ? 'the link and the phone CPU' : cpu ? 'the phone CPU' : 'the link'})`;
}

/** The agent ends the stream with this when the phone's idle mode changes; the session then connects again once. */
export const MIRROR_RESTART_REASON = 'restarting: idle mode changed on the phone';
/** Agent 1.10.7: the same for a change of the phone's frame rate limit. */
export const MIRROR_FPS_RESTART_REASON = 'restarting: frame rate limit changed on the phone';

/** A reason the agent ends the stream with on purpose, to be connected again at once. */
export function isRestartReason(reason: string): boolean {
  return reason === MIRROR_RESTART_REASON || reason === MIRROR_FPS_RESTART_REASON;
}

const REASON_TEXT: Record<string, string> = {
  'screen view disabled on the phone': 'screen view is disabled on the phone (Settings › System › Developer agent)',
  'stopped from the phone': 'stopped from the phone (Settings › System › Developer agent)',
  [MIRROR_RESTART_REASON]: 'mirroring is restarting (idle mode changed on the phone)',
  [MIRROR_FPS_RESTART_REASON]: 'mirroring is restarting (frame rate limit changed on the phone)',
  'lease expired': 'the device stopped the mirror because VS Code did not renew it in time (lease expired)',
};

/**
 * The log text, written on each state change (the strip itself shows `stripParts`). Live: `live (ssh), 4.0 fps, latency 85 ms,
 * phone 32 ms, image 360x792 q60, 2 dropped` (`image 270x594 q45 (reduced for the link)` while
 * adaptive quality has stepped down, `(reduced for the phone CPU)` when the phone could not encode
 * in time; `idle (no screen changes)` instead of the frame rate while the screen is still); over sfdk the transport reads `live (sfdk: <reason>)` and the latency
 * is `—`. Other states read `<state>` or `<state>: <reason>`; an agent error is cut to 300 chars.
 */
export function hasReasonText(reason: string): boolean {
  return Object.prototype.hasOwnProperty.call(REASON_TEXT, reason);
}

export function logText(s: MirrorStatus): string {
  if (s.state === 'live') {
    const transport = s.transport === undefined ? '' : ` (${s.transport}${s.transport === 'sfdk' && s.fallbackReason ? `: ${s.fallbackReason}` : ''})`;
    const parts = [`live${transport}`];
    if (s.codec !== undefined) parts.push(s.codec);
    if (s.idle) parts.push('idle (no screen changes)');
    else if (s.fps !== undefined) parts.push(`${s.fps.toFixed(1)} fps`);
    if (s.kbps !== undefined) parts.push(`${Math.round(s.kbps)} kbit/s`);
    parts.push(`latency ${s.latencyMs === undefined ? '—' : `${Math.round(s.latencyMs)} ms`}`);
    if (s.frameMs !== undefined) parts.push(`phone ${Math.round(s.frameMs)} ms`);
    if (s.image) {
      const q = s.image.quality === undefined ? '' : ` q${s.image.quality}`;
      parts.push(`image ${s.image.width}x${s.image.height}${q}${reducedText(s.image.reduced, s.image.reducedFor)}`);
    }
    if (s.video) {
      const target = s.video.targetKbps === undefined ? '' : ` at ${s.video.targetKbps} kbit/s`;
      parts.push(`video ${s.video.width}x${s.video.height}${target}${reducedText(s.video.reduced, s.video.reducedFor)}`);
    }
    if (s.dropped !== undefined && s.dropped > 0) parts.push(`${s.dropped} dropped`);
    if (s.capture === 'native') parts.push('capture native');
    if (s.controlOffReason) parts.push(`control off (${s.controlOffReason})`);
    return parts.join(', ');
  }
  if (s.state === 'pausing') return 'paused';
  if (s.reason) {
    const reason = truncate(s.reason);
    return `${s.state}: ${REASON_TEXT[reason] ?? reason}`;
  }
  return s.state;
}

/** The strip's colour: live green, waiting grey, down red. */
export type StripDot = 'live' | 'wait' | 'down';
export type StripAction = 'update' | 'reconnect' | 'keypad';

export interface StripParts {
  dot: StripDot;
  label: string;
  /** `30 fps`, or `idle`; live only. */
  fps?: string;
  /** At most one: the most important thing the user may want to act on. */
  warning?: string;
  action?: StripAction;
}

/** The control state of the strip's right side: the pill says "Control" (active) or "Control off on phone" (off). */
export type ControlState = 'active' | 'off' | 'none';

export const CONTROL_PILL_TEXT: Record<Exclude<ControlState, 'none'>, string> = {
  active: 'Control',
  off: 'Control off on phone',
};

/** Whether the sfdk path's reason is the outdated agent (see `staleAgentReason`). */
export function isStaleAgentReason(reason: string | undefined): boolean {
  return reason !== undefined && /^agent \S+ — update for the fast mirror$/.test(reason);
}

/**
 * Control for the strip: off when the phone turned it off, active while the page has input on
 * (`inputActive`, the page's own control flag), otherwise none (view only).
 */
export function controlState(s: MirrorStatus, inputActive: boolean): ControlState {
  if (s.state === 'live' && s.controlOffReason) return 'off';
  return s.state === 'live' && inputActive ? 'active' : 'none';
}

function reasonOf(s: MirrorStatus): string | undefined {
  if (!s.reason) return undefined;
  const reason = truncate(s.reason);
  return REASON_TEXT[reason] ?? reason;
}

function reducedCauses(r: { reduced?: boolean; reducedFor?: readonly ('link' | 'cpu')[] } | undefined): 'cpu' | 'link' | undefined {
  if (!r?.reduced) return undefined;
  if (r.reducedFor?.includes('cpu')) return 'cpu';
  return 'link';
}

/** The single strip warning, by priority: a missing keypad layout, slow path, phone CPU, link, capture, drops, phone error. */
function stripWarning(s: MirrorStatus): { text: string; action?: StripAction } | undefined {
  if (s.keypadLayoutMissing) return { text: 'Keypad detected', action: 'keypad' };
  if (s.transport === 'sfdk') return isStaleAgentReason(s.fallbackReason) ? { text: 'Slow path', action: 'update' } : { text: 'Slow path' };
  const causes = [reducedCauses(s.video), reducedCauses(s.image)];
  if (causes.includes('cpu')) return { text: 'Reduced for phone' };
  if (causes.includes('link')) return { text: 'Reduced for link' };
  if (s.dropped !== undefined && s.dropped > 0) return { text: `${s.dropped} dropped` };
  if (s.softError) return { text: 'Phone error' };
  return undefined;
}

/** What the strip shows on its left: state dot, label, frame rate, at most one warning, and an action when one helps. */
export function stripParts(s: MirrorStatus): StripParts {
  if (s.state === 'live') {
    const parts: StripParts = { dot: 'live', label: 'Live' };
    if (s.idle) parts.fps = 'idle';
    else if (s.fps !== undefined) parts.fps = `${Math.round(s.fps)} fps`;
    const w = stripWarning(s);
    if (w) {
      parts.warning = w.text;
      if (w.action) parts.action = w.action;
    }
    return parts;
  }
  if (s.state === 'paused' || s.state === 'pausing') return { dot: 'wait', label: 'Paused' };
  if (s.state === 'disconnected' || s.state === 'ended') {
    const reason = reasonOf(s);
    return { dot: 'down', label: reason ? `Disconnected: ${reason}` : 'Disconnected', action: 'reconnect' };
  }
  const reason = reasonOf(s);
  return { dot: 'wait', label: reason ? `Connecting… ${reason}` : 'Connecting…' };
}

export interface DetailRow {
  label: string;
  value: string;
}

function reducedNote(r: { reduced?: boolean; reducedFor?: readonly ('link' | 'cpu')[] } | undefined): string {
  if (!r?.reduced) return '';
  const link = r.reducedFor === undefined || r.reducedFor.length === 0 || r.reducedFor.includes('link');
  const cpu = r.reducedFor !== undefined && r.reducedFor.includes('cpu');
  return ` (reduced for ${link && cpu ? 'the link and the phone CPU' : cpu ? 'the phone CPU' : 'the link'})`;
}

/**
 * The details behind the strip's info button: every number the old one-line strip showed.
 * Rows without a value yet are left out (Latency always shows, as `—`, while live).
 */
export function detailRows(s: MirrorStatus, inputActive = false): DetailRow[] {
  const rows: DetailRow[] = [];
  if (s.state !== 'live') {
    const reason = reasonOf(s);
    rows.push({ label: 'State', value: reason ? `${s.state}: ${reason}` : s.state });
    if (s.transport === 'sfdk') rows.push({ label: 'Transport', value: `SDK connection${s.fallbackReason ? ` (${s.fallbackReason})` : ''}` });
    return rows;
  }
  if (s.transport === 'ssh') rows.push({ label: 'Transport', value: 'SSH forward' });
  else if (s.transport === 'sfdk') rows.push({ label: 'Transport', value: `SDK connection${s.fallbackReason ? ` (${s.fallbackReason})` : ''}` });
  if (s.video) {
    const target = s.video.targetKbps === undefined ? '' : ` · ${s.video.targetKbps} kbit/s`;
    rows.push({ label: 'Video', value: `${(s.codec ?? 'vp8').toUpperCase()} · ${s.video.width}×${s.video.height}${target}${reducedNote(s.video)}` });
  } else if (s.image) {
    const q = s.image.quality === undefined ? '' : ` · q${s.image.quality}`;
    rows.push({ label: 'Image', value: `${(s.codec ?? 'jpeg').toUpperCase()} · ${s.image.width}×${s.image.height}${q}${reducedNote(s.image)}` });
  } else if (s.codec !== undefined) {
    rows.push({ label: 'Video', value: s.codec.toUpperCase() });
  }
  if (s.kbps !== undefined) rows.push({ label: 'Received', value: `${Math.round(s.kbps)} kbit/s` });
  const rate = s.idle ? 'idle (no screen changes)' : s.fps !== undefined ? `${s.fps.toFixed(1)} fps` : undefined;
  if (rate !== undefined || s.paceFps !== undefined) {
    const pace = s.paceFps === undefined ? '' : rate === undefined ? `phone paces ${s.paceFps}` : ` (phone paces ${s.paceFps})`;
    rows.push({ label: 'Frame rate', value: `${rate ?? ''}${pace}` });
  }
  rows.push({ label: 'Latency', value: s.latencyMs === undefined ? '—' : `${Math.round(s.latencyMs)} ms` });
  if (s.frameMs !== undefined) rows.push({ label: 'Phone time', value: `${Math.round(s.frameMs)} ms per frame` });
  const stages = stagesText(s.stages);
  if (stages !== undefined) rows.push({ label: 'Stages', value: stages });
  if (s.capturedFps !== undefined) rows.push({ label: 'Captured', value: `${s.capturedFps.toFixed(1)} fps` });
  if (s.capture === 'native') rows.push({ label: 'Capture', value: 'native recorder' });
  if (s.dropped !== undefined) rows.push({ label: 'Dropped', value: String(s.dropped) });
  if (s.idleMode !== undefined) rows.push({ label: 'Idle mode', value: s.idleMode ? 'on' : 'off' });
  if (s.maxFps !== undefined) rows.push({ label: 'Frame rate limit', value: String(s.maxFps) });
  if (s.keypadLayoutMissing) rows.push({ label: 'Keypad', value: 'detected · Create layout' });
  const control = controlState(s, inputActive);
  rows.push({ label: 'Control', value: control === 'off' ? `off (${s.controlOffReason})` : control === 'active' ? 'on' : 'view only' });
  rows.push({
    label: 'Touch indicator',
    value: s.touchIndicatorPath === 'phone' ? 'on phone' : s.touchIndicatorPath === 'mirror' ? 'in mirror' : 'off',
  });
  if (s.softError) rows.push({ label: 'Phone error', value: s.softError });
  return rows;
}

const STAGE_WORDS: readonly [keyof FrameStages, string][] = [
  ['hold', 'hold'], ['wait', 'capture'], ['readback', 'readback'], ['convert', 'convert'], ['encode', 'encode'], ['send', 'send'],
];

/** `hold 17 · capture 30 · readback 25 · convert 6 · encode 9 · send 1 ms`; undefined without stages. */
export function stagesText(st: FrameStages | undefined): string | undefined {
  if (!st) return undefined;
  const parts = STAGE_WORDS.filter(([k]) => st[k] !== undefined).map(([k, word]) => `${word} ${Math.round(st[k] as number)}`);
  return parts.length ? `${parts.join(' · ')} ms` : undefined;
}

/**
 * The latest captured frames' stage times (agent 1.10.7): per-stage medians over the last
 * STAGE_WINDOW_MS (at most STAGE_SAMPLES frames) and the rate of captured frames, which leaves out
 * the re-encodes an idle screen gets.
 */
export class StageMeter {
  static readonly WINDOW_MS = 3000;
  static readonly SAMPLES = 120;
  private samples: { at: number; st: FrameStages }[] = [];

  add(at: number, st: FrameStages): void {
    this.samples.push({ at, st });
    if (this.samples.length > StageMeter.SAMPLES) this.samples.shift();
  }

  clear(): void {
    this.samples = [];
  }

  private recent(now: number): { at: number; st: FrameStages }[] {
    return this.samples.filter((x) => now - x.at <= StageMeter.WINDOW_MS && x.at <= now);
  }

  stages(now: number): FrameStages | undefined {
    const recent = this.recent(now);
    if (!recent.length) return undefined;
    const out: FrameStages = {};
    for (const [k] of STAGE_FIELDS) {
      const xs = recent.map((x) => x.st[k]).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
      if (xs.length) out[k] = xs[Math.floor(xs.length / 2)];
    }
    return out;
  }

  /** Captured frames per second over the window; undefined with fewer than two. */
  fps(now: number): number | undefined {
    const recent = this.recent(now);
    if (recent.length < 2) return undefined;
    const span = recent[recent.length - 1].at - recent[0].at;
    return span > 0 ? ((recent.length - 1) * 1000) / span : undefined;
  }
}

/** The one-line form of the strip (label · fps · warning · control) for the tooltip and the aria-label. */
export function statusText(s: MirrorStatus, inputActive = false): string {
  const p = stripParts(s);
  const parts = [p.label];
  if (p.fps) parts.push(p.fps);
  if (p.warning) parts.push(p.warning);
  if (p.action === 'keypad') parts.push('Create layout');
  const c = controlState(s, inputActive);
  if (c !== 'none') parts.push(CONTROL_PILL_TEXT[c]);
  return parts.join(' · ');
}

/** The details as `Label: value` lines, for Copy details. */
export function detailsCopyText(rows: readonly DetailRow[]): string {
  return rows.map((r) => `${r.label}: ${r.value}`).join('\n');
}

export function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/**
 * A VP8 frame of the announced kind: bit 0 of the frame tag is 0 for a key frame, which also
 * carries the start code 9d 01 2a after the 3-byte tag and a non-zero 14-bit width and height.
 */
export function isVp8(buf: Uint8Array, key: boolean): boolean {
  if (buf.length < 3 || (buf[0] & 1) !== (key ? 0 : 1)) return false;
  if (!key) return true;
  if (buf.length < 10 || buf[3] !== 0x9d || buf[4] !== 0x01 || buf[5] !== 0x2a) return false;
  const w = (buf[6] | (buf[7] << 8)) & 0x3fff;
  const h = (buf[8] | (buf[9] << 8)) & 0x3fff;
  return w > 0 && h > 0;
}

/**
 * When to ask the agent for a VP8 key frame (`{"keyframe":true}` upstream). A request goes out at
 * once unless one is still outstanding: sent less than `minGapMs` ago with no key frame received
 * since. The page asks on every delta it cannot decode, so this keeps that to one line per gap.
 */
export class KeyframeRequests {
  private sentAt: number | undefined;
  count = 0;

  constructor(private readonly minGapMs = 1000) {}

  /** True when a request should be sent now (and records it). */
  want(now: number): boolean {
    if (this.sentAt !== undefined && now - this.sentAt < this.minGapMs) return false;
    this.sentAt = now;
    this.count++;
    return true;
  }

  /** A key frame arrived: the outstanding request, if any, is answered. */
  keyReceived(): void {
    this.sentAt = undefined;
  }
}

/** Received payload bytes over the last 3 seconds, as kbit/s. */
export class ByteRate {
  private readonly samples: { at: number; bytes: number }[] = [];
  private static readonly WINDOW_MS = 3000;

  add(nowMs: number, bytes: number): void {
    this.samples.push({ at: nowMs, bytes });
    this.trim(nowMs);
  }

  kbps(nowMs: number): number {
    this.trim(nowMs);
    const bytes = this.samples.reduce((a, s) => a + s.bytes, 0);
    return (bytes * 8) / ByteRate.WINDOW_MS;
  }

  private trim(nowMs: number): void {
    while (this.samples.length > 0 && this.samples[0].at <= nowMs - ByteRate.WINDOW_MS) this.samples.shift();
  }
}

/**
 * Decode trouble that makes the panel give up on video: this many decode errors within the window
 * reconnects the stream with JPEG for the rest of the panel's life.
 */
export const VIDEO_FAILURE = { errors: 3, windowMs: 20_000 };

/** Counts decode errors and says when they are too many (see `VIDEO_FAILURE`). */
export class DecodeErrors {
  private readonly at: number[] = [];

  /** Records one error; true when the limit is reached. */
  add(nowMs: number): boolean {
    this.at.push(nowMs);
    while (this.at.length > 0 && this.at[0] <= nowMs - VIDEO_FAILURE.windowMs) this.at.shift();
    return this.at.length >= VIDEO_FAILURE.errors;
  }
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

/**
 * Frames per second over the last 3 seconds. A frame counts while it is inside the window by
 * arrival time and, when the phone's capture time `ts` is given, also by capture time relative to
 * the newest frame, so frames that queued up during a stall and arrive at once do not read as a
 * burst.
 */
export class FpsMeter {
  private readonly stamps: { at: number; ts: number }[] = [];
  private static readonly WINDOW_MS = 3000;
  /** A gap this long between frames ends a run of screen activity (see `rate`). */
  static readonly GAP_MS = 1500;
  /** The time constant of the strip's smoothing, ms. */
  static readonly SMOOTH_MS = 1000;
  private activeSince: number | undefined;
  private shown: { at: number; fps: number } | undefined;

  tick(nowMs: number, captureTs?: number): void {
    const last = this.stamps[this.stamps.length - 1];
    if (!last || nowMs - last.at >= FpsMeter.GAP_MS) {
      // The screen starts changing again: the rate is measured from here, not from 3 s back.
      this.activeSince = nowMs;
      this.shown = undefined;
    }
    this.stamps.push({ at: nowMs, ts: captureTs ?? nowMs });
    this.trim(nowMs);
  }

  fps(nowMs: number): number {
    this.trim(nowMs);
    return this.stamps.length / (FpsMeter.WINDOW_MS / 1000);
  }

  /**
   * The rate for the strip (extension 0.1.7): frames over the last 3 s, or over the time since
   * the screen started changing when that is shorter (at least 1 s), smoothed with a 1 s time
   * constant so the reading does not jump with every frame that enters or leaves the window.
   */
  rate(nowMs: number): number {
    this.trim(nowMs);
    if (this.stamps.length === 0) {
      this.shown = undefined;
      return 0;
    }
    const span = Math.min(FpsMeter.WINDOW_MS, Math.max(1000, nowMs - (this.activeSince ?? nowMs)));
    const raw = (this.stamps.length * 1000) / span;
    if (this.shown === undefined) {
      this.shown = { at: nowMs, fps: raw };
    } else {
      const k = 1 - Math.exp(-Math.max(0, nowMs - this.shown.at) / FpsMeter.SMOOTH_MS);
      this.shown = { at: nowMs, fps: this.shown.fps + k * (raw - this.shown.fps) };
    }
    return this.shown.fps;
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - FpsMeter.WINDOW_MS;
    const newest = this.stamps.length > 0 ? this.stamps[this.stamps.length - 1].ts : 0;
    const tsCutoff = newest - FpsMeter.WINDOW_MS;
    while (this.stamps.length > 0 && (this.stamps[0].at <= cutoff || this.stamps[0].ts <= tsCutoff)) this.stamps.shift();
  }
}

/**
 * Remembers when keepalives were sent. A keepalive sent more than 1.5 intervals after the one
 * before it (an overdue timer firing on resume after a stall) is late: the device's lease had
 * already run out, so `lastTimelyAt` skips it and keeps the last one that went out on time.
 */
export class KeepaliveTrace {
  private last: number | undefined;
  private timely: number | undefined;

  record(nowMs: number): void {
    if (this.last === undefined || nowMs - this.last <= MIRROR_TIMING.keepaliveIntervalMs * 1.5) this.timely = nowMs;
    this.last = nowMs;
  }

  /** Milliseconds since the last on-time keepalive, or undefined when none was sent. */
  ageMs(nowMs: number): number | undefined {
    return this.timely === undefined ? undefined : nowMs - this.timely;
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

/**
 * The self-contained mirror page: an image (JPEG/PNG frames) or a canvas (VP8 frames decoded with
 * WebCodecs), a status strip and a Reconnect button. Pointer input is normalized against the
 * currently displayed image/canvas rectangle; the extension host validates and maps it. On load it reports whether it can
 * decode VP8 (`{type:'ready', codecs:['vp8']}`, or `[]`); a VP8 frame it cannot decode (no key frame
 * yet, a decoder error, a decoder that fell behind) is skipped and answered with
 * `{type:'keyframe', reason}`, and each frame it has consumed with `{type:'shown', frame}`.
 */
export function mirrorHtml(nonce: string, device: string): string {
  const n = escapeHtml(nonce);
  const d = escapeHtml(device);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'nonce-${n}'; script-src 'nonce-${n}'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mirror: ${d}</title>
<style nonce="${n}">
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  [hidden] { display: none !important; }
  #strip { display: flex; gap: 10px; align-items: center; min-height: 36px; padding: 0 8px 0 14px; font-size: 12px; border-top: 1px solid var(--vscode-panel-border); }
  #strip .grow { flex: 1; }
  #strip .sep { color: var(--vscode-descriptionForeground); }
  #dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--vscode-descriptionForeground); }
  #dot.live { background: var(--vscode-testing-iconPassed); }
  #dot.down { background: var(--vscode-errorForeground); }
  #label { font-weight: 600; }
  #fps { font-variant-numeric: tabular-nums; }
  #warning { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-editorWarning-foreground); }
  .act { height: 24px; padding: 0 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 2px; font: inherit; cursor: pointer; }
  .act:hover { background: var(--vscode-button-hoverBackground); }
  .act.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .act.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #control { padding: 2px 10px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  #control.off { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
  .icon { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--vscode-foreground); border: 1px solid transparent; border-radius: 4px; cursor: pointer; padding: 0; }
  .icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  #info[aria-expanded="true"] { background: var(--vscode-toolbar-activeBackground); border-color: var(--vscode-focusBorder); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  #details { position: fixed; right: 16px; bottom: 44px; width: 320px; max-width: calc(100% - 32px); box-sizing: border-box; padding: 12px 16px; background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 6px; box-shadow: 0 8px 24px var(--vscode-widget-shadow); display: flex; flex-direction: column; gap: 10px; }
  #details .head { display: flex; align-items: center; justify-content: space-between; font-weight: 600; }
  #details .grid { display: grid; grid-template-columns: 96px minmax(0, 1fr); row-gap: 7px; column-gap: 12px; font-size: 12px; }
  #details .grid .k { color: var(--vscode-descriptionForeground); }
  #details .grid .v { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  #details .foot { display: flex; justify-content: flex-end; }
  #stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  #screen, #video { display: block; max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
  #touch { position: absolute; z-index: 1; box-sizing: border-box; border-style: solid; border-color: rgba(255, 255, 255, 0.9); border-radius: 50%; background: rgba(255, 70, 45, 0.57); pointer-events: none; transform: translate(-50%, -50%); }
  #stage.control { cursor: crosshair; touch-action: none; }
  #screen.hidden, #video.hidden { display: none; }
  #keypad { flex: none; width: min(420px, calc(100% - 16px)); margin: 0 auto; padding: 8px 0; display: flex; flex-direction: column; gap: 5px; }
  .keypad-row { display: grid; gap: 5px; }
  .keypad-key, .keypad-space { min-width: 0; height: 30px; }
  .keypad-key { border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); font: 600 12px var(--vscode-font-family); cursor: pointer; touch-action: none; }
  .keypad-key:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .keypad-key.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .keypad-key.call { color: var(--vscode-testing-iconPassed); }
  .keypad-key:disabled { opacity: 0.45; cursor: default; }
</style>
</head>
<body>
<div id="stage"><img id="screen" alt="Device screen" draggable="false"><canvas id="video" class="hidden" aria-label="Device screen"></canvas><span id="touch" hidden></span></div>
<div id="keypad" aria-label="Device keypad" hidden></div>
<div id="strip" role="status" aria-live="polite" title="">
  <span id="dot"></span>
  <span id="label">Connecting…</span>
  <span id="fpsSep" class="sep" hidden>·</span><span id="fps" hidden></span>
  <span id="warnSep" class="sep" hidden>·</span>
  <span id="warning" hidden><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 2 L14.5 13.5 H1.5 Z"></path><path d="M8 6.5 V9.5"></path><path d="M8 11.5 V11.6"></path></svg><span id="warningText"></span></span>
  <span class="grow"></span>
  <button id="keypadLayout" class="act" type="button" hidden>Create layout</button>
  <button id="update" class="act" type="button" hidden>Update agent</button>
  <button id="reconnect" class="act" type="button" hidden>Reconnect</button>
  <span id="control" hidden></span>
  <button id="info" class="icon" type="button" aria-label="Mirror details" aria-expanded="false" aria-controls="details" hidden><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 7 V11.5"></path><path d="M8 4.6 V4.7"></path></svg></button>
</div>
<div id="details" role="dialog" aria-label="Mirror details" hidden>
  <div class="head"><span>Mirror details</span><button id="detailsClose" class="icon" type="button" aria-label="Close details"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3.5 3.5 L12.5 12.5"></path><path d="M12.5 3.5 L3.5 12.5"></path></svg></button></div>
  <div id="detailsGrid" class="grid"></div>
  <div class="foot"><button id="copyDetails" class="act secondary" type="button">Copy details</button></div>
</div>
<script nonce="${n}">
(function () {
  var vscode = acquireVsCodeApi();
  var img = document.getElementById('screen');
  var canvas = document.getElementById('video');
  var stage = document.getElementById('stage');
  var touchEl = document.getElementById('touch');
  var keypadEl = document.getElementById('keypad');
  var paint = canvas.getContext('2d');
  var stripEl = document.getElementById('strip');
  var dotEl = document.getElementById('dot');
  var labelEl = document.getElementById('label');
  var fpsEl = document.getElementById('fps');
  var fpsSep = document.getElementById('fpsSep');
  var warnEl = document.getElementById('warning');
  var warnText = document.getElementById('warningText');
  var warnSep = document.getElementById('warnSep');
  var button = document.getElementById('reconnect');
  var keypadLayoutButton = document.getElementById('keypadLayout');
  var updateButton = document.getElementById('update');
  var controlEl = document.getElementById('control');
  var infoButton = document.getElementById('info');
  var detailsEl = document.getElementById('details');
  var detailsGrid = document.getElementById('detailsGrid');
  var detailsClose = document.getElementById('detailsClose');
  var copyButton = document.getElementById('copyDetails');
  var controlOff = false;
  var detailRows = [];
  var current = 0;
  var loadingFrame = 0;
  var loadingScreen = null;
  var displayedFrame = 0;
  var displayedScreen = null;
  var control = false;
  var liveContacts = false;
  var pointer = null;
  var keypadHeld = null;
  var touchPath = 'off';
  var lastContact = null;
  var touchTimer = null;
  var shownUrl = null;
  var loadingUrl = null;
  var decoder = null;
  var decoderSize = '';
  var needKey = true;
  var reported = '';
  var videoPending = new Map();
  function settled(ok) {
    var frame = loadingFrame;
    if (ok) {
      if (shownUrl && shownUrl !== loadingUrl) URL.revokeObjectURL(shownUrl);
      shownUrl = loadingUrl;
      displayedFrame = loadingFrame;
      displayedScreen = loadingScreen;
    } else {
      if (loadingUrl && loadingUrl !== shownUrl) URL.revokeObjectURL(loadingUrl);
      loadingUrl = shownUrl;
      loadingFrame = 0;
      loadingScreen = null;
    }
    vscode.postMessage({ type: 'shown', frame: frame });
  }
  function showVideo(on) {
    canvas.classList.toggle('hidden', !on);
    img.classList.toggle('hidden', on);
  }
  function closeDecoder(ackPending) {
    if (decoder && decoder.state !== 'closed') {
      try { decoder.close(); } catch (e) { /* already closed */ }
    }
    decoder = null;
    decoderSize = '';
    needKey = true;
    if (ackPending) videoPending.forEach(function (meta) { vscode.postMessage({ type: 'shown', frame: meta.frame }); });
    videoPending.clear();
  }
  function wantKey(reason) {
    needKey = true;
    vscode.postMessage({ type: 'keyframe', reason: reason });
  }
  function draw(frame) {
    var meta = videoPending.get(frame.timestamp);
    videoPending.delete(frame.timestamp);
    try {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      paint.drawImage(frame, 0, 0);
      showVideo(true);
      if (meta) {
        displayedFrame = meta.frame;
        displayedScreen = meta.screen;
      }
      var size = frame.displayWidth + 'x' + frame.displayHeight;
      if (reported !== size) {
        reported = size;
        vscode.postMessage({ type: 'decoding', width: frame.displayWidth, height: frame.displayHeight });
      }
    } finally {
      if (meta) vscode.postMessage({ type: 'shown', frame: meta.frame });
      frame.close();
    }
  }
  function onDecodeError(e) {
    closeDecoder(true);
    wantKey('decode error: ' + String(e && e.message || e).slice(0, 120));
  }
  function decodeVideo(m) {
    if (needKey && !m.key) {
      vscode.postMessage({ type: 'shown', frame: m.frame });
      wantKey('no key frame yet');
      return;
    }
    var size = m.size[0] + 'x' + m.size[1];
    if (m.key && (!decoder || decoder.state === 'closed' || decoderSize !== size)) {
      closeDecoder(true);
      try {
        decoder = new VideoDecoder({ output: draw, error: onDecodeError });
        decoder.configure({ codec: 'vp8', codedWidth: m.size[0], codedHeight: m.size[1], optimizeForLatency: true });
        decoderSize = size;
      } catch (e) {
        vscode.postMessage({ type: 'shown', frame: m.frame });
        onDecodeError(e);
        return;
      }
    }
    if (decoder.decodeQueueSize > 8) {
      closeDecoder(true);
      vscode.postMessage({ type: 'shown', frame: m.frame });
      wantKey('the decoder fell behind');
      return;
    }
    try {
      var timestamp = m.pts * 1000;
      videoPending.set(timestamp, { frame: m.frame, screen: m.screen });
      decoder.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: timestamp, data: m.bytes }));
      needKey = false;
    } catch (e) {
      videoPending.delete(timestamp);
      vscode.postMessage({ type: 'shown', frame: m.frame });
      onDecodeError(e);
    }
  }
  function codecs() {
    return new Promise(function (resolve) {
      if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
        resolve([]);
        return;
      }
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve([]); } }, 1000);
      VideoDecoder.isConfigSupported({ codec: 'vp8' }).then(function (r) {
        if (!done) { done = true; clearTimeout(timer); resolve(r && r.supported ? ['vp8'] : []); }
      }, function () {
        if (!done) { done = true; clearTimeout(timer); resolve([]); }
      });
    });
  }
  img.addEventListener('load', function () { settled(true); });
  img.addEventListener('error', function () { settled(false); });
  button.addEventListener('click', function () { vscode.postMessage({ type: 'reconnect' }); });
  keypadLayoutButton.addEventListener('click', function () { vscode.postMessage({ type: 'editKeypadLayout' }); });
  updateButton.addEventListener('click', function () { vscode.postMessage({ type: 'updateAgent' }); });
  function renderControl() {
    var text = controlOff ? 'Control off on phone' : control ? 'Control' : '';
    controlEl.hidden = text === '';
    controlEl.classList.toggle('off', controlOff);
    controlEl.textContent = text;
  }
  function renderDetails() {
    detailsGrid.textContent = '';
    detailRows.forEach(function (row) {
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = row.label;
      var v = document.createElement('span');
      v.className = 'v';
      v.textContent = row.value;
      detailsGrid.appendChild(k);
      detailsGrid.appendChild(v);
    });
  }
  function setDetails(open, refocus) {
    var show = open && detailRows.length > 0;
    if (show) renderDetails();
    detailsEl.hidden = !show;
    infoButton.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) detailsClose.focus();
    else if (refocus) infoButton.focus();
  }
  function detailsOpen() { return !detailsEl.hidden; }
  infoButton.addEventListener('click', function () { setDetails(!detailsOpen(), true); });
  detailsClose.addEventListener('click', function () { setDetails(false, true); });
  copyButton.addEventListener('click', function () { vscode.postMessage({ type: 'copyDetails' }); });
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && detailsOpen()) setDetails(false, true);
  });
  window.addEventListener('click', function (event) {
    if (!detailsOpen()) return;
    var target = event.target;
    if (target && (detailsEl.contains(target) || infoButton.contains(target))) return;
    setDetails(false, false);
  });
  function renderStrip(strip, details, controlState, tooltip) {
    labelEl.textContent = strip.label;
    dotEl.className = strip.dot === 'live' || strip.dot === 'down' ? strip.dot : '';
    var hasFps = typeof strip.fps === 'string';
    fpsEl.hidden = !hasFps;
    fpsSep.hidden = !hasFps;
    fpsEl.textContent = hasFps ? strip.fps : '';
    var hasWarn = typeof strip.warning === 'string';
    warnEl.hidden = !hasWarn;
    warnSep.hidden = !hasWarn;
    warnText.textContent = hasWarn ? strip.warning : '';
    keypadLayoutButton.hidden = strip.action !== 'keypad';
    updateButton.hidden = strip.action !== 'update';
    button.hidden = strip.action !== 'reconnect';
    controlOff = controlState === 'off';
    renderControl();
    detailRows = details;
    infoButton.hidden = details.length === 0;
    if (details.length === 0) setDetails(false, false);
    else if (detailsOpen()) renderDetails();
    stripEl.title = tooltip;
    stripEl.setAttribute('aria-label', tooltip);
  }
  function rows(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    list.slice(0, 20).forEach(function (r) {
      if (r && typeof r.label === 'string' && typeof r.value === 'string') out.push({ label: r.label, value: r.value });
    });
    return out;
  }
  function surface() { return canvas.classList.contains('hidden') ? img : canvas; }
  function hideTouch() {
    if (touchTimer) clearTimeout(touchTimer);
    touchTimer = null;
    lastContact = null;
    touchEl.hidden = true;
    touchEl.style.opacity = '0';
  }
  function renderTouch() {
    if (touchPath !== 'mirror' || !control || !lastContact || !displayedScreen) { hideTouch(); return; }
    var rect = surface().getBoundingClientRect();
    var stageRect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || displayedScreen[0] < 2 || displayedScreen[1] < 2) { hideTouch(); return; }
    var radius = Math.max(12, Math.min(rect.width, rect.height) / 36);
    var outline = Math.max(2, radius / 7);
    touchEl.style.width = (radius * 2) + 'px';
    touchEl.style.height = (radius * 2) + 'px';
    touchEl.style.borderWidth = outline + 'px';
    touchEl.style.left = (rect.left - stageRect.left + lastContact.x * (rect.width - 1) / (displayedScreen[0] - 1)) + 'px';
    touchEl.style.top = (rect.top - stageRect.top + lastContact.y * (rect.height - 1) / (displayedScreen[1] - 1)) + 'px';
    touchEl.style.background = lastContact.down ? 'rgba(255, 70, 45, 0.57)' : 'rgba(255, 70, 45, 0.31)';
    touchEl.style.transition = lastContact.down ? 'none' : 'opacity 400ms linear';
    touchEl.style.opacity = lastContact.down ? '1' : '0';
    touchEl.hidden = false;
    if (!lastContact.down) touchTimer = setTimeout(function () { touchEl.hidden = true; touchTimer = null; }, 400);
  }
  function point(event, rect) {
    if (rect.width <= 0 || rect.height <= 0) return null;
    var x = (event.clientX - rect.left) / rect.width;
    var y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: x, y: y };
  }
  function postContact(action, held, p) {
    var message = { type: 'input', action: action, frame: held.frame, screen: held.screen };
    if (p) { message.x = p.x; message.y = p.y; }
    vscode.postMessage(message);
  }
  function cancelPointer() {
    var held = pointer;
    if (held && held.live) postContact('up', held);
    pointer = null;
  }
  function postKey(key, pressed) {
    vscode.postMessage({ type: 'input', action: 'key', key: key, pressed: pressed });
  }
  function cancelKey() {
    var held = keypadHeld;
    if (held) postKey(held.key, false);
    keypadHeld = null;
  }
  function renderKeypad(layout) {
    while (keypadEl.firstChild) keypadEl.removeChild(keypadEl.firstChild);
    if (!layout || !Array.isArray(layout.rows)) { keypadEl.hidden = true; return; }
    layout.rows.forEach(function (cells) {
      if (!Array.isArray(cells) || cells.length === 0) return;
      var row = document.createElement('div');
      row.className = 'keypad-row';
      row.style.gridTemplateColumns = 'repeat(' + cells.length + ', minmax(0, 1fr))';
      cells.forEach(function (cell) {
        if (!cell) {
          var space = document.createElement('span');
          space.className = 'keypad-space';
          row.appendChild(space);
          return;
        }
        var key = cell.key;
        var keyButton = document.createElement('button');
        keyButton.type = 'button';
        keyButton.className = 'keypad-key' + (cell.style ? ' ' + cell.style : '');
        keyButton.textContent = cell.label;
        keyButton.setAttribute('aria-label', key);
        keyButton.disabled = !control;
        keyButton.addEventListener('pointerdown', function (event) {
          if (keypadHeld || !control || !document.hasFocus() || event.button !== 0) return;
          keypadHeld = { key: key, id: event.pointerId };
          try { keyButton.setPointerCapture(event.pointerId); } catch (e) { keypadHeld = null; return; }
          postKey(key, true);
          event.preventDefault();
        });
        function release(event) {
          if (!keypadHeld || keypadHeld.id !== event.pointerId || keypadHeld.key !== key) return;
          postKey(key, false);
          keypadHeld = null;
          event.preventDefault();
        }
        keyButton.addEventListener('pointerup', release);
        keyButton.addEventListener('pointercancel', release);
        keyButton.addEventListener('lostpointercapture', release);
        keyButton.addEventListener('contextmenu', function (event) { event.preventDefault(); });
        row.appendChild(keyButton);
      });
      keypadEl.appendChild(row);
    });
    keypadEl.hidden = keypadEl.childElementCount === 0;
  }
  stage.addEventListener('pointerdown', function (event) {
    if (pointer || !control || !document.hasFocus() || event.button !== 0 || !displayedFrame || !displayedScreen) return;
    var p = point(event, surface().getBoundingClientRect());
    if (!p) return;
    var now = performance.now();
    pointer = { id: event.pointerId, frame: displayedFrame, screen: displayedScreen, x: p.x, y: p.y, lastX: p.x, lastY: p.y, cx: event.clientX, cy: event.clientY, at: now, lastMoveAt: now, live: liveContacts };
    try { stage.setPointerCapture(event.pointerId); } catch (e) { pointer = null; return; }
    if (pointer.live) postContact('down', pointer, p);
    event.preventDefault();
  });
  stage.addEventListener('pointermove', function (event) {
    var held = pointer;
    if (!held || held.id !== event.pointerId || !held.live || !control || !document.hasFocus()) return;
    var now = performance.now();
    if (now - held.lastMoveAt < ${MIRROR_CONTACT_TIMING.moveIntervalMs}) return;
    var p = point(event, surface().getBoundingClientRect());
    if (!p || (p.x === held.lastX && p.y === held.lastY)) return;
    held.lastMoveAt = now;
    held.lastX = p.x;
    held.lastY = p.y;
    postContact('move', held, p);
    event.preventDefault();
  });
  stage.addEventListener('pointerup', function (event) {
    var start = pointer;
    if (!start || start.id !== event.pointerId) return;
    var p = point(event, surface().getBoundingClientRect());
    if (start.live) {
      if (p && (p.x !== start.lastX || p.y !== start.lastY)) postContact('move', start, p);
      cancelPointer();
      event.preventDefault();
      return;
    }
    pointer = null;
    if (!control || !document.hasFocus() || !p || !displayedScreen || displayedScreen[0] !== start.screen[0] || displayedScreen[1] !== start.screen[1]) return;
    var dx = event.clientX - start.cx;
    var dy = event.clientY - start.cy;
    if (dx * dx + dy * dy <= 36) {
      vscode.postMessage({ type: 'input', action: 'tap', frame: start.frame, screen: start.screen, x: p.x, y: p.y });
    } else {
      vscode.postMessage({ type: 'input', action: 'swipe', frame: start.frame, screen: start.screen, x1: start.x, y1: start.y, x2: p.x, y2: p.y, duration: performance.now() - start.at });
    }
    event.preventDefault();
  });
  stage.addEventListener('pointercancel', cancelPointer);
  stage.addEventListener('lostpointercapture', cancelPointer);
  stage.addEventListener('contextmenu', function (event) { if (control) event.preventDefault(); });
  window.addEventListener('focus', function () { vscode.postMessage({ type: 'focus', focused: true }); });
  window.addEventListener('blur', function () { cancelPointer(); cancelKey(); vscode.postMessage({ type: 'focus', focused: false }); });
  window.addEventListener('message', function (event) {
    var m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'frame' && m.format === 'vp8') {
      current = m.frame;
      if (decoder || typeof VideoDecoder === 'function') decodeVideo(m);
      else vscode.postMessage({ type: 'shown', frame: current });
    } else if (m.type === 'frame') {
      current = m.frame;
      loadingFrame = m.frame;
      loadingScreen = m.screen;
      if (decoder) closeDecoder(true);
      showVideo(false);
      var mime = m.format === 'png' ? 'image/png' : 'image/jpeg';
      if (loadingUrl && loadingUrl !== shownUrl) URL.revokeObjectURL(loadingUrl);
      loadingUrl = URL.createObjectURL(new Blob([m.bytes], { type: mime }));
      img.src = loadingUrl;
    } else if (m.type === 'reset') {
      closeDecoder(true);
      cancelPointer();
      cancelKey();
      hideTouch();
    } else if (m.type === 'control') {
      control = m.enabled === true;
      liveContacts = m.liveContacts === true;
      if (!control) { cancelPointer(); cancelKey(); hideTouch(); }
      stage.classList.toggle('control', control);
      Array.prototype.forEach.call(keypadEl.querySelectorAll('button'), function (keyButton) { keyButton.disabled = !control; });
      renderControl();
    } else if (m.type === 'keypad') {
      cancelKey();
      renderKeypad(m.layout);
    } else if (m.type === 'touchIndicator') {
      touchPath = m.path === 'mirror' ? 'mirror' : m.path === 'phone' ? 'phone' : 'off';
      if (touchPath !== 'mirror') hideTouch();
    } else if (m.type === 'contact') {
      if (touchPath === 'mirror' && control && Array.isArray(m.screen) && m.screen.length === 2 &&
          displayedScreen && m.screen[0] === displayedScreen[0] && m.screen[1] === displayedScreen[1] &&
          Number.isInteger(m.x) && Number.isInteger(m.y) && typeof m.down === 'boolean') {
        if (touchTimer) clearTimeout(touchTimer);
        touchTimer = null;
        lastContact = { x: m.x, y: m.y, down: m.down };
        renderTouch();
      }
    } else if (m.type === 'state') {
      var s = m.strip;
      if (s && typeof s === 'object' && typeof s.label === 'string') {
        renderStrip(s, rows(m.details), m.control, typeof m.text === 'string' ? m.text : s.label);
      } else {
        renderStrip({ dot: 'wait', label: typeof m.text === 'string' ? m.text : String(m.state) }, [], 'none', typeof m.text === 'string' ? m.text : '');
      }
      if (m.state !== 'live') hideTouch();
    }
  });
  window.addEventListener('resize', function () { if (lastContact) renderTouch(); });
  codecs().then(function (list) { vscode.postMessage({ type: 'ready', codecs: list, focused: document.hasFocus() }); });
})();
</script>
</body>
</html>
`;
}
