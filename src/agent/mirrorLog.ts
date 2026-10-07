/** Bounds for text from the webview before it reaches the Output channel (the page is untrusted). */

export const LOG_TEXT_MAX = 120;
const MAX_DIMENSION = 16384;

/** Control characters removed (line breaks included) and the length capped. */
export function sanitizeLogText(text: string, max = LOG_TEXT_MAX): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** `WxH` for two small positive integers, otherwise undefined. */
export function parseDecodingSize(width: unknown, height: unknown): string | undefined {
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_DIMENSION;
  return ok(width) && ok(height) ? `${width}x${height}` : undefined;
}

/** At most `max` events per window; the rest are dropped. */
export class LogRateLimiter {
  private readonly times: number[] = [];

  constructor(
    private readonly max = 5,
    private readonly windowMs = 10_000,
  ) {}

  allow(now: number): boolean {
    while (this.times.length > 0 && now - this.times[0] >= this.windowMs) this.times.shift();
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}
