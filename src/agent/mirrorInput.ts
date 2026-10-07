/**
 * Pure validation, coordinate mapping and rate limiting for mirror input. Webview coordinates are
 * normalized against the pixels actually displayed; only this module turns them into the current
 * frame's integer screen coordinates.
 */

export const MIRROR_INPUT_MIN_AGENT_VERSION = '1.7.0';
export const MIRROR_CONTACT_INPUT_MIN_AGENT_VERSION = '1.9.0';
export const MIRROR_INPUT_TIMING = { activeIntervalMs: 1000 };
export const MIRROR_INPUT_RATE = { maxPerSecond: 20 };
/** Leave budget for down/up and the focus heartbeat while a drag is moving. */
export const MIRROR_CONTACT_TIMING = { moveIntervalMs: 75 };
export const MIN_SWIPE_MS = 50;
export const MAX_SWIPE_MS = 2000;

/** Input coordinates are safe only for frames explicitly reported in fixed panel coordinates. */
export function captureAllowsInput(capture: unknown): capture is 'native' {
  return capture === 'native';
}

export type MirrorInput =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; duration: number }
  | { type: 'down'; x: number; y: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'up' };

export type WebviewGesture =
  | { type: 'tap'; frame: number; screen: [number, number]; x: number; y: number }
  | { type: 'swipe'; frame: number; screen: [number, number]; x1: number; y1: number; x2: number; y2: number; duration: number }
  | { type: 'down'; frame: number; screen: [number, number]; x: number; y: number }
  | { type: 'move'; frame: number; screen: [number, number]; x: number; y: number }
  | { type: 'up'; frame: number; screen: [number, number] };

/** Live contacts are opt-in so extension 0.1.8 remains compatible with agents 1.7/1.8. */
export function supportsLiveContacts(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes('down') === true && capabilities.includes('move') && capabilities.includes('up');
}

/** The stream/status settings fields enable input only as one complete, capability-gated pair. */
export function phoneInputAccepted(capable: boolean, input: unknown, inputLease: unknown): boolean {
  return capable && input === true && Number.isInteger(inputLease) && (inputLease as number) >= 1 && (inputLease as number) <= 30;
}

function finiteRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(o).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

/** Strictly parses one untrusted webview gesture. Unknown fields and non-finite numbers are refused. */
export function parseWebviewGesture(message: unknown): WebviewGesture | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  const o = message as Record<string, unknown>;
  if (o.type !== 'input' || !Number.isInteger(o.frame) || (o.frame as number) < 0) return undefined;
  if (!Array.isArray(o.screen) || o.screen.length !== 2 || !o.screen.every((v) => Number.isInteger(v) && v >= 1 && v <= 10000)) return undefined;
  const screen: [number, number] = [o.screen[0] as number, o.screen[1] as number];
  if (o.action === 'up') {
    return exactKeys(o, ['type', 'action', 'frame', 'screen']) ? { type: 'up', frame: o.frame as number, screen } : undefined;
  }
  if (o.action === 'tap') {
    if (!exactKeys(o, ['type', 'action', 'frame', 'screen', 'x', 'y']) || !finiteRatio(o.x) || !finiteRatio(o.y)) return undefined;
    return { type: 'tap', frame: o.frame as number, screen, x: o.x, y: o.y };
  }
  if (o.action === 'down' || o.action === 'move') {
    if (!exactKeys(o, ['type', 'action', 'frame', 'screen', 'x', 'y']) || !finiteRatio(o.x) || !finiteRatio(o.y)) return undefined;
    return { type: o.action, frame: o.frame as number, screen, x: o.x, y: o.y };
  }
  if (o.action === 'swipe') {
    if (!exactKeys(o, ['type', 'action', 'frame', 'screen', 'x1', 'y1', 'x2', 'y2', 'duration'])) return undefined;
    if (!finiteRatio(o.x1) || !finiteRatio(o.y1) || !finiteRatio(o.x2) || !finiteRatio(o.y2)) return undefined;
    if (typeof o.duration !== 'number' || !Number.isFinite(o.duration)) return undefined;
    return {
      type: 'swipe', frame: o.frame as number, screen,
      x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2,
      duration: Math.max(MIN_SWIPE_MS, Math.min(MAX_SWIPE_MS, Math.round(o.duration))),
    };
  }
  return undefined;
}

/** Strict focus signal parser; false is never inferred from malformed data. */
export function parseWebviewFocus(message: unknown): boolean | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  const o = message as Record<string, unknown>;
  return exactKeys(o, ['type', 'focused']) && o.type === 'focus' && typeof o.focused === 'boolean' ? o.focused : undefined;
}

function pixel(ratio: number, length: number): number {
  return Math.round(ratio * (length - 1));
}

/** Maps normalized displayed-image coordinates to the real screen orientation reported by that frame. */
export function mapGesture(gesture: WebviewGesture, screen: readonly [number, number]): MirrorInput | undefined {
  if (gesture.type === 'up') return { type: 'up' };
  const [width, height] = screen;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 10000 || height > 10000) return undefined;
  if (gesture.type === 'tap') return { type: 'tap', x: pixel(gesture.x, width), y: pixel(gesture.y, height) };
  if (gesture.type === 'down' || gesture.type === 'move') {
    return { type: gesture.type, x: pixel(gesture.x, width), y: pixel(gesture.y, height) };
  }
  return {
    type: 'swipe',
    x1: pixel(gesture.x1, width), y1: pixel(gesture.y1, height),
    x2: pixel(gesture.x2, width), y2: pixel(gesture.y2, height),
    duration: gesture.duration,
  };
}

/** Serializes the fixed upstream input vocabulary; callers gate it on advertised capabilities. */
export function inputLine(input: MirrorInput | { type: 'active'; active: boolean }): string {
  return `${JSON.stringify({ input })}\n`;
}

export interface InputFocusTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Renewable input-focus lease. It sends false immediately whenever its gate closes. */
export class InputFocusSchedule {
  private handle: unknown;
  private running = false;
  private disposed = false;

  constructor(
    private readonly send: (active: boolean) => void,
    private readonly timers: InputFocusTimers = {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
  ) {}

  update(on: boolean): void {
    if (this.disposed || on === this.running) return;
    this.running = on;
    if (on) {
      this.send(true);
      this.handle = this.timers.setInterval(() => this.send(true), MIRROR_INPUT_TIMING.activeIntervalMs);
    } else {
      this.stop(true);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // The stream may still hold an activation lease even if host state was already reset. The
    // device treats false as an unlimited safety-off, so always put it on the upstream path.
    this.stop(true);
    this.running = false;
  }

  private stop(sendInactive: boolean): void {
    if (this.handle !== undefined) this.timers.clearInterval(this.handle);
    this.handle = undefined;
    if (sendInactive) this.send(false);
  }
}

/** A rolling one-second window; every gesture attempt consumes a slot before it is acted on. */
export class InputRateLimiter {
  private readonly times: number[] = [];

  allow(now: number): boolean {
    while (this.times.length > 0 && now - this.times[0] >= 1000) this.times.shift();
    if (this.times.length >= MIRROR_INPUT_RATE.maxPerSecond) return false;
    this.times.push(now);
    return true;
  }
}
