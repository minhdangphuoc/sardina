/**
 * Adaptive quality for the binary mirror (agent 1.4.0, plan "Adaptive quality"). Pure and without
 * imports, so it is unit-tested under plain mocha and `device-agent/tools/mirror-probe.mjs` can load
 * the same file with Node's type stripping (keep to erasable TypeScript syntax: no enums,
 * namespaces or parameter properties).
 *
 * The agent measures, the extension decides. Each image header of an adaptive stream reports the
 * JPEG quality it was encoded with (`q`), the round trip of the latest acknowledged image from the
 * moment the agent wrote it until the ack came back (`rtt`), and the cumulative tick counters
 * (`ticks`, and `skips`: ticks skipped because bytes were still unsent or the ack window was full).
 * From these this controller picks a level of a fixed ladder of width and quality; the frame rate
 * is never changed. Steps down are quick, steps up slow and checked against the measured headroom,
 * and a step up that has to be undone soon doubles the wait before the next one (hysteresis).
 *
 * VP8 video (agent 1.6.0, `codec: 'vp8'`; `quality` then holds kbit/s and frames report it as `q`):
 * two causes are told apart, each with its own axis (extension 0.1.7). The link (skipped ticks,
 * round trips judged against the deeper ack window) lowers the target bitrate first and the width
 * only once the bitrate is at its floor. The phone's CPU (the median convert + encode time `ems`
 * of delta frames reaching the frame interval for `cpuDownHoldMs`) lowers only the width, since a
 * lower bitrate does not make encoding faster; while the encoder keeps up, the width is kept. A
 * width given up for the CPU comes back only when the encode time projected for it (scaled by the
 * pixels) stays well under the interval, and a step back that has to be undone soon doubles that
 * wait, as for the link. Agent 1.8.0 paces its frames to what the CPU sustains, so the frame
 * rate there is steady either way; the controller itself never changes it.
 */

export interface AdaptStart {
  /** The stream's frame rate (status line). */
  fps: number;
  /** The requested width (status line); 0 means native. The ladder never goes above it. */
  width: number;
  /** The requested JPEG quality (status line), or for VP8 the requested bitrate in kbit/s. */
  quality: number;
  /** `vp8` for a video stream; JPEG otherwise. */
  codec?: 'jpeg' | 'vp8';
  /** The ack window (status line); round trips are judged in frame intervals times window / 2. */
  window?: number;
}

export interface AdaptFrame {
  /** PC receive time, ms. */
  at: number;
  /** Payload size in bytes. */
  bytes: number;
  /** `size[0]` of the image. */
  width: number;
  /** `screen[0]`: the device's native width. */
  screenWidth: number;
  /** `screen[1]`. */
  screenHeight: number;
  /** The image's frame number; with `rttFrame`, pairs a round trip with the size of its image. */
  frame?: number;
  q?: number;
  rtt?: number;
  /** The frame whose ack gave `rtt` (an earlier image). */
  rttFrame?: number;
  ticks?: number;
  skips?: number;
  /** The phone's time to scale and encode this frame, ms (used for VP8). */
  ems?: number;
  /** VP8: the scale-and-convert part of `ems`, ms (for the log). */
  cvms?: number;
  /** VP8: a key frame (its encode time says nothing about delta frames). */
  key?: boolean;
  /** VP8, agent 1.8.0: a refresh of an idle screen (not a sign of activity or of the link). */
  refresh?: boolean;
}

/** Why a stream is below what it asked for. */
export type AdaptCause = 'link' | 'cpu';

export interface AdaptLevel {
  width: number;
  quality: number;
}

export interface AdaptDecision extends AdaptLevel {
  level: number;
  levels: number;
  direction: 'down' | 'up';
  /** For the log: which measurements led here. */
  reason: string;
  /** What this step answers: the link or the phone's CPU (a screen change counts as the link). */
  cause: AdaptCause;
  /** The causes of the reductions in effect after this step (empty at the top). */
  limits: AdaptCause[];
}

/** Mutable so tests (and a phone test) can change the tuning; the controller reads these at each call. */
export const ADAPT_TUNING = {
  /** Measurements older than this are forgotten (but the last `minSamples` images are kept). */
  windowMs: 3000,
  /** Image samples needed at the current level before a decision on the round trip (a skip rate needs two). */
  minSamples: 3,
  /** Time at a level before another step down (the queue from the old level drains first). */
  downHoldMs: 1500,
  /** Time the link must look good before a step up; doubles after a bounce, up to `maxUpHoldMs`. */
  upHoldMs: 6000,
  maxUpHoldMs: 60000,
  /** A step down this soon after a step up is a bounce. */
  bounceMs: 15000,
  /** After this long without a step down, the up hold returns to `upHoldMs`. */
  calmMs: 60000,
  /** A skip rate is measured over at least this many ticks (one skip in four is noise, not 25 %). */
  minSkipTicks: 8,
  /** Step down when this share of ticks (or more) was skipped because of the link. */
  downSkipRate: 0.2,
  /** ... or when the median ack round trip, less its latency part (see `baseRtt`), reaches this many frame intervals. */
  downRttIntervals: 1.2,
  /** Step up only while at most this share of ticks was skipped ... */
  upSkipRate: 0.05,
  /** ... and the round trip projected for the next level stays under this many frame intervals. */
  upRttIntervals: 0.7,
  /** Bytes of the next level over this one when not measured yet. */
  defaultCostRatio: 1.6,
  /** Images of this long (all levels) are used to split the round trip into base and transfer. */
  fitWindowMs: 10000,
  /** ... when there are this many with a round trip ... */
  fitMinSamples: 6,
  /** ... and the largest is at least this many times the smallest ... */
  fitMinSpread: 1.2,
  /** ... and the line explains at least this share of the variance (R squared). */
  fitMinR2: 0.5,
  /** Sizes at least this many times apart whose round trips differ by less than ... */
  flatMinSpread: 1.5,
  /** ... this many frame intervals (from the fitted line) mean the round trip is latency. */
  flatRttIntervals: 0.1,
  /**
   * How long a base round trip found from the images stays in use when they no longer tell; each
   * use renews it while the round trips stay at or above it.
   */
  baseMemoryMs: 60000,
  /**
   * A reduced level steps up anyway after this long under both step-down thresholds, even when
   * the projection says no (a link with high latency but room to spare would otherwise stay
   * reduced). A bounce then doubles the up hold as for any step up.
   */
  probeMs: 60000,
  minWidth: 120,
  minQuality: 10,
  /** VP8: the lowest target bitrate, kbit/s. */
  minBitrate: 150,
  /** VP8: a smaller width for the CPU when the median encode time of delta frames reaches this many frame intervals ... */
  downEncodeIntervals: 1.0,
  /** ... for this long (spikes of a busy phone do not count) ... */
  cpuDownHoldMs: 2000,
  /** ... measured over at least this many delta frames. */
  minEncodeSamples: 10,
  /** VP8: a width given up for the CPU comes back while the encode time projected for it stays under this many frame intervals. */
  upEncodeIntervals: 0.7,
};

/** Fractions of the requested width and quality, best first. Width and quality alternate. */
export const ADAPT_LADDER: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, 0.75],
  [0.75, 0.75],
  [0.75, 0.5],
  [0.5, 0.5],
];

/** VP8: fractions of the requested width (the CPU's axis, and the link's last resort), best first. */
export const VIDEO_WIDTHS: readonly number[] = [1, 0.75, 0.5];

/** VP8: fractions of the requested bitrate (the link's axis), best first. */
export const VIDEO_BITRATES: readonly number[] = [1, 0.6, 0.4, 0.25, 0.15];

/** The ladder for a device of `screenWidth`: duplicate steps (small screens) are dropped. JPEG only. */
export function adaptLevels(start: AdaptStart, screenWidth: number): AdaptLevel[] {
  if (start.codec === 'vp8') {
    // The link's path through the two VP8 axes: every bitrate at full width, then the widths.
    const { widths, bitrates } = videoSteps(start, screenWidth);
    return [
      ...bitrates.map((quality) => ({ width: widths[0], quality })),
      ...widths.slice(1).map((width) => ({ width, quality: bitrates[bitrates.length - 1] })),
    ];
  }
  const ceiling = start.width > 0 ? Math.min(start.width, screenWidth) : screenWidth;
  const levels: AdaptLevel[] = [];
  for (const [fw, fq] of ADAPT_LADDER) {
    const width = Math.min(ceiling, Math.max(ADAPT_TUNING.minWidth, Math.round(ceiling * fw)));
    const quality = Math.min(start.quality, Math.max(ADAPT_TUNING.minQuality, Math.round(start.quality * fq)));
    const last = levels[levels.length - 1];
    if (!last || last.width !== width || last.quality !== quality) levels.push({ width, quality });
  }
  return levels;
}

/** VP8: the widths (even, as I420 needs) and bitrates of a device of `screenWidth`, best first, without duplicates. */
export function videoSteps(start: AdaptStart, screenWidth: number): { widths: number[]; bitrates: number[] } {
  const even = (w: number): number => w - (w % 2);
  const ceiling = even(start.width > 0 ? Math.min(start.width, screenWidth) : screenWidth);
  const widths: number[] = [];
  for (const f of VIDEO_WIDTHS) {
    const w = even(Math.min(ceiling, Math.max(ADAPT_TUNING.minWidth, Math.round(ceiling * f))));
    if (widths[widths.length - 1] !== w) widths.push(w);
  }
  const bitrates: number[] = [];
  for (const f of VIDEO_BITRATES) {
    const q = Math.min(start.quality, Math.max(ADAPT_TUNING.minBitrate, Math.round(start.quality * f)));
    if (bitrates[bitrates.length - 1] !== q) bitrates.push(q);
  }
  return { widths, bitrates };
}

/** Image height for `width` at the screen's aspect ratio (as the agent's `scaledToWidth`). */
export function scaledHeight(width: number, screenWidth: number, screenHeight: number): number {
  return Math.max(1, Math.round((screenHeight * width) / screenWidth));
}

interface Sample {
  at: number;
  bytes: number;
  rtt?: number;
  ticks?: number;
  skips?: number;
  /** Only for VP8 delta frames. */
  ems?: number;
  cvms?: number;
}

export interface AdaptMeasure {
  samples: number;
  /** Share of ticks skipped because of the link, or undefined without tick counters. */
  skipRate?: number;
  rttMs?: number;
  baseRttMs?: number;
  bytesPerSec: number;
  /** VP8: the median convert + encode time of delta frames on the phone, ms. */
  encodeMs?: number;
  /** VP8: the median convert part of it, ms. */
  convertMs?: number;
  /** VP8: how many delta frames `encodeMs` is the median of. */
  encodeSamples: number;
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Holds before a step up, doubled after a bounce (a step down soon after a step up). */
class UpHold {
  ms = ADAPT_TUNING.upHoldMs;
  lastUpAt: number | undefined;
  lastDownAt: number | undefined;

  up(now: number): void {
    this.lastUpAt = now;
  }

  down(now: number): void {
    if (this.lastUpAt !== undefined && now - this.lastUpAt < ADAPT_TUNING.bounceMs) {
      this.ms = Math.min(ADAPT_TUNING.maxUpHoldMs, this.ms * 2);
    }
    this.lastDownAt = now;
  }

  calm(now: number): void {
    if (this.lastDownAt !== undefined && now - this.lastDownAt >= ADAPT_TUNING.calmMs) this.ms = ADAPT_TUNING.upHoldMs;
  }
}

export class AdaptiveQuality {
  private readonly start: AdaptStart;
  /** The time a round trip is judged against: the frame interval, times window / 2 (1 for JPEG's window of 2). */
  private readonly interval: number;
  /**
   * The frame interval the encode time is judged against: that of the stream's rate, but at most
   * 30 fps. Above 30 (agent 1.10.7, the phone's 60 fps limit) the agent's pacer gives up frame rate
   * (60, 45, 30) before the width has to go.
   */
  private readonly frameInterval: number;
  private readonly video: boolean;
  /** JPEG: the ladder. */
  private levels: AdaptLevel[] = [];
  private current = 0;
  /** VP8: the two axes, and the width steps taken for the CPU and for the link (the larger applies). */
  private widths: number[] = [];
  private bitrates: number[] = [];
  private wCpu = 0;
  private wLink = 0;
  private rate = 0;
  private screenWidth = 0;
  private levelSince: number | undefined;
  private samples: Sample[] = [];
  /** Round trips paired with the size of their image over the last `fitWindowMs`, of any level. */
  private history: { at: number; bytes: number; rtt: number; frame: number }[] = [];
  /** Sizes of the latest images by frame number, to pair them with a later `rttFrame`. */
  private readonly sizes = new Map<number, number>();
  private goodSince: number | undefined;
  /** Since when there has been no sign of congestion (for the probe). */
  private steadySince: number | undefined;
  /** VP8: since when the encoder has not kept up, and since when a wider picture would fit. */
  private cpuBadSince: number | undefined;
  private cpuGoodSince: number | undefined;
  /** The last base round trip the images could tell (see `baseRtt`). */
  private knownBase: { at: number; ms: number } | undefined;
  private lastEval: number | undefined;
  private readonly linkHold = new UpHold();
  private readonly cpuHold = new UpHold();
  /** Mean image bytes per level (exponential average), for the cost of a step up. */
  private readonly bytesAt = new Map<string, number>();

  constructor(start: AdaptStart) {
    this.start = start;
    this.video = start.codec === 'vp8';
    const fps = Math.max(1, start.fps);
    this.frameInterval = 1000 / Math.min(fps, 30);
    this.interval = ((1000 / fps) * Math.max(1, start.window ?? 2)) / 2;
  }

  /** 0 at the top; for VP8 the sum of the steps on both axes. */
  get level(): number {
    return this.video ? this.widthIndex + this.rate : this.current;
  }

  get levelCount(): number {
    if (!this.video) return this.levels.length;
    return this.widths.length === 0 ? 0 : this.widths.length + this.bitrates.length - 1;
  }

  /** The current width and quality, once the screen is known. */
  get setting(): AdaptLevel | undefined {
    if (!this.video) return this.levels[this.current];
    if (this.widths.length === 0) return undefined;
    return { width: this.widths[this.widthIndex], quality: this.bitrates[this.rate] };
  }

  /** The hold before the next step up for the link (grows after bounces). */
  get upHoldMs(): number {
    return this.linkHold.ms;
  }

  /** VP8: the hold before a width given up for the CPU comes back. */
  get cpuUpHoldMs(): number {
    return this.cpuHold.ms;
  }

  private get widthIndex(): number {
    return Math.max(this.wCpu, this.wLink);
  }

  private get levelKey(): string {
    return this.video ? `${this.widthIndex}:${this.rate}` : String(this.current);
  }

  /** Feeds one received image; returns a new level to ask the agent for, or undefined. */
  onFrame(f: AdaptFrame): AdaptDecision | undefined {
    if (this.screenWidth !== f.screenWidth) {
      // First frame, or the screen changed (rotation, another device): start over at the top.
      this.screenWidth = f.screenWidth;
      const was = this.level;
      if (this.video) {
        const steps = videoSteps(this.start, f.screenWidth);
        this.widths = steps.widths;
        this.bitrates = steps.bitrates;
        this.wCpu = 0;
        this.wLink = 0;
        this.rate = 0;
      } else {
        this.levels = adaptLevels(this.start, f.screenWidth);
        this.current = 0;
      }
      this.reset(f.at);
      if (was !== 0) return this.decision('up', 'link', 'screen size changed');
    }
    if (f.frame !== undefined) {
      this.sizes.set(f.frame, f.bytes);
      if (this.sizes.size > 32) this.sizes.delete(this.sizes.keys().next().value as number);
    }
    if (f.rtt !== undefined && f.rttFrame !== undefined) {
      const bytes = this.sizes.get(f.rttFrame);
      const last = this.history[this.history.length - 1];
      // The same ack is reported again when no newer one came in between: count it once.
      if (bytes !== undefined && (!last || last.frame !== f.rttFrame)) {
        this.history.push({ at: f.at, bytes, rtt: f.rtt, frame: f.rttFrame });
      }
      const cut = f.at - ADAPT_TUNING.fitWindowMs;
      while (this.history.length > 0 && this.history[0].at < cut) this.history.shift();
    }
    // A refresh of an idle screen is neither activity nor a measure of the link.
    if (f.refresh) return undefined;
    const want = this.setting;
    // Frames encoded before the agent applied the current level say nothing about it.
    if (!want || f.width !== want.width || (f.q !== undefined && f.q !== want.quality)) return undefined;
    const delta = this.video && f.key !== true;
    this.samples.push({
      at: f.at, bytes: f.bytes, rtt: f.rtt, ticks: f.ticks, skips: f.skips,
      ems: delta ? f.ems : undefined, cvms: delta ? f.cvms : undefined,
    });
    const prev = this.bytesAt.get(this.levelKey);
    this.bytesAt.set(this.levelKey, prev === undefined ? f.bytes : prev * 0.8 + f.bytes * 0.2);
    return this.video ? this.evaluateVideo(f.at) : this.evaluate(f.at);
  }

  /** The measurements over the window at the current level (exposed for the log and tests). */
  measure(now: number): AdaptMeasure {
    // The window, but never fewer than `minSamples` images: on a link so slow that images come
    // seconds apart the controller must still see enough of them to step down.
    const cut = now - ADAPT_TUNING.windowMs;
    const keepFrom = Math.max(0, this.samples.length - ADAPT_TUNING.minSamples);
    this.samples = this.samples.filter((s, i) => s.at > cut || i >= keepFrom);
    const s = this.samples;
    const counted = s.filter((x) => x.ticks !== undefined && x.skips !== undefined);
    let skipRate: number | undefined;
    if (counted.length >= 2) {
      const first = counted[0];
      const last = counted[counted.length - 1];
      const ticks = (last.ticks ?? 0) - (first.ticks ?? 0);
      const skips = (last.skips ?? 0) - (first.skips ?? 0);
      if (ticks >= ADAPT_TUNING.minSkipTicks) skipRate = Math.min(1, Math.max(0, skips / ticks));
    }
    const rttMs = median(s.filter((x) => x.rtt !== undefined).map((x) => x.rtt as number));
    const baseRttMs = this.baseRtt(now);
    const span = s.length > 1 ? Math.max(s[s.length - 1].at - s[0].at, this.interval) : ADAPT_TUNING.windowMs;
    const bytes = s.slice(1).reduce((a, x) => a + x.bytes, 0);
    const encodes = this.video ? s.filter((x) => x.ems !== undefined).map((x) => x.ems as number) : [];
    const encodeMs = median(encodes);
    const convertMs = this.video ? median(s.filter((x) => x.cvms !== undefined).map((x) => x.cvms as number)) : undefined;
    return {
      samples: s.length, skipRate, rttMs, baseRttMs, bytesPerSec: s.length > 1 ? (bytes * 1000) / span : 0,
      encodeMs, convertMs, encodeSamples: encodes.length,
    };
  }

  /** The link's signals: skipped ticks, and the round trip less its size-independent part. */
  private linkBad(m: AdaptMeasure): boolean {
    const enough = m.samples >= ADAPT_TUNING.minSamples;
    const skipBad = m.skipRate !== undefined && m.skipRate >= ADAPT_TUNING.downSkipRate;
    // The round trip counts minus its size-independent part: smaller images cannot cut latency.
    const transfer = m.rttMs === undefined ? undefined : m.rttMs - Math.min(m.baseRttMs ?? 0, m.rttMs);
    const rttBad = enough && transfer !== undefined && transfer >= ADAPT_TUNING.downRttIntervals * this.interval;
    return skipBad || rttBad;
  }

  /** No sign of congestion and room for the next level up on the link. */
  private linkGood(m: AdaptMeasure): { ok: boolean; projected: number | undefined } {
    const skipOk = m.skipRate === undefined || m.skipRate <= ADAPT_TUNING.upSkipRate;
    const projected = this.projectedRtt(m);
    return { ok: skipOk && projected !== undefined && projected < ADAPT_TUNING.upRttIntervals * this.interval, projected };
  }

  private noImagesFor(now: number): void {
    if (this.lastEval !== undefined && now - this.lastEval > ADAPT_TUNING.windowMs) {
      // No images for a while (a static screen): what was seen before says nothing about now.
      this.goodSince = undefined;
      this.steadySince = undefined;
      this.cpuBadSince = undefined;
      this.cpuGoodSince = undefined;
    }
    this.lastEval = now;
  }

  /** JPEG: one ladder of width and quality. */
  private evaluate(now: number): AdaptDecision | undefined {
    this.noImagesFor(now);
    this.linkHold.calm(now);
    const m = this.measure(now);
    // Two images give a skip rate (the counters are cumulative), which is all a link that
    // delivers one image every few seconds can offer; the round trip needs `minSamples`.
    if (m.samples < 2) return undefined;
    const enough = m.samples >= ADAPT_TUNING.minSamples;
    const atLevel = now - (this.levelSince ?? now);
    if (this.linkBad(m)) {
      this.goodSince = undefined;
      this.steadySince = undefined;
      if (this.current >= this.levels.length - 1 || atLevel < ADAPT_TUNING.downHoldMs) return undefined;
      this.linkHold.down(now);
      this.current++;
      this.reset(now);
      return this.decision('down', 'link', this.describe(m));
    }
    if (this.current === 0 || !enough) return undefined;
    return this.linkUp(now, m, atLevel, () => this.current--);
  }

  /** The link's step up (shared by both codecs); `apply` takes the step. */
  private linkUp(now: number, m: AdaptMeasure, atLevel: number, apply: () => void, encodeOk = true): AdaptDecision | undefined {
    // Under both step-down thresholds: no sign of congestion (the probe's condition).
    this.steadySince ??= now;
    const good = this.linkGood(m);
    if (good.ok && encodeOk) this.goodSince ??= now;
    else this.goodSince = undefined;
    const hold = this.linkHold.ms;
    let reason: string | undefined;
    if (this.goodSince !== undefined && now - this.goodSince >= hold && atLevel >= hold) {
      reason = `${this.describe(m)}, projected rtt ${Math.round(good.projected ?? 0)} ms`;
    } else {
      const probeHold = Math.max(ADAPT_TUNING.probeMs, hold);
      if (this.steadySince !== undefined && encodeOk && now - this.steadySince >= probeHold && atLevel >= probeHold) {
        reason = `${this.describe(m)}, probe after ${Math.round(probeHold / 1000)} s without congestion`;
      }
    }
    if (reason === undefined) return undefined;
    this.linkHold.up(now);
    apply();
    this.reset(now);
    return this.decision('up', 'link', reason);
  }

  /** VP8: the link on bitrate (then width), the CPU on width; the link is judged first. */
  private evaluateVideo(now: number): AdaptDecision | undefined {
    this.noImagesFor(now);
    this.linkHold.calm(now);
    this.cpuHold.calm(now);
    const m = this.measure(now);
    if (m.samples < 2) return undefined;
    const enough = m.samples >= ADAPT_TUNING.minSamples;
    const atLevel = now - (this.levelSince ?? now);
    const lastWidth = this.widths.length - 1;

    if (this.linkBad(m)) {
      this.goodSince = undefined;
      this.steadySince = undefined;
      if (atLevel < ADAPT_TUNING.downHoldMs) return undefined;
      if (this.rate < this.bitrates.length - 1) this.rate++;
      else if (this.widthIndex < lastWidth) this.wLink = this.widthIndex + 1;
      else return undefined;
      this.linkHold.down(now);
      this.reset(now);
      return this.decision('down', 'link', this.describe(m));
    }

    const measured = m.encodeMs !== undefined && m.encodeSamples >= ADAPT_TUNING.minEncodeSamples;
    const encodeMs = m.encodeMs ?? 0;
    if (measured && encodeMs >= ADAPT_TUNING.downEncodeIntervals * this.frameInterval) {
      // The encoder does not keep up: fewer pixels, the bitrate stays (the link has room).
      this.cpuGoodSince = undefined;
      this.cpuBadSince ??= now;
      if (now - this.cpuBadSince >= ADAPT_TUNING.cpuDownHoldMs && atLevel >= ADAPT_TUNING.downHoldMs && this.widthIndex < lastWidth) {
        this.cpuHold.down(now);
        this.wCpu = this.widthIndex + 1;
        this.reset(now);
        return this.decision('down', 'cpu', this.describeCpu(m));
      }
      return undefined;
    }
    this.cpuBadSince = undefined;

    // A width given up for the CPU comes back when the encode time projected for it fits.
    if (this.wCpu > this.wLink && measured) {
      const projected = this.projectedEncode(encodeMs, this.widthIndex - 1);
      if (projected < ADAPT_TUNING.upEncodeIntervals * this.frameInterval) {
        this.cpuGoodSince ??= now;
        const hold = this.cpuHold.ms;
        if (now - this.cpuGoodSince >= hold && atLevel >= hold) {
          this.cpuHold.up(now);
          this.wCpu--;
          this.reset(now);
          return this.decision('up', 'cpu', `${this.describeCpu(m)}, projected ${Math.round(projected)} ms at ${this.widths[this.widthIndex]} wide`);
        }
      } else {
        this.cpuGoodSince = undefined;
      }
    }

    if ((this.rate === 0 && this.wLink === 0) || !enough) return undefined;
    // A link step up that widens the picture must also fit the encoder.
    const widens = this.rate === 0 && this.wLink > this.wCpu;
    const encodeOk = !widens || !measured || this.projectedEncode(encodeMs, this.widthIndex - 1) < ADAPT_TUNING.upEncodeIntervals * this.frameInterval;
    return this.linkUp(now, m, atLevel, () => {
      if (this.rate > 0) this.rate--;
      else this.wLink--;
    }, encodeOk);
  }

  /**
   * The part of the round trip that does not depend on the image size (network latency, the
   * PC's processing): the intercept of a least-squares line of round trip over bytes for the
   * recent images, clamped to 0..smallest round trip. Image sizes vary with the content and the
   * level, which is what makes the split possible. Without enough spread in the sizes, or when
   * the line does not fit (the link changed inside the window, noise), it is 0: the whole round
   * trip counts as transfer time, the cautious side for a step up; the probe covers the rest.
   * When sizes differ widely but the round trip stays flat, the round trip is latency: the base
   * is the smallest round trip, so a slow but wide link does not push the level down.
   */
  private baseRtt(now: number): number | undefined {
    const h = this.history;
    if (h.length === 0) return undefined;
    const minRtt = Math.min(...h.map((x) => x.rtt));
    const fitted = this.fitBase(minRtt);
    if (fitted !== undefined) {
      this.knownBase = { at: now, ms: fitted };
      return fitted;
    }
    // Once the split was possible it stays valid for a while (the spread in sizes that allowed it
    // leaves the window after a level change), as long as the round trip has not dropped under it.
    const k = this.knownBase;
    // While it is still a floor (a few ms of noise do not count as a drop) it stays in use.
    if (k && now - k.at <= ADAPT_TUNING.baseMemoryMs && k.ms <= minRtt * 1.1 + 10) {
      k.at = now;
      return Math.min(k.ms, minRtt);
    }
    return 0;
  }

  /** The base from the recent images, or undefined when they cannot tell. */
  private fitBase(minRtt: number): number | undefined {
    const h = this.history;
    if (h.length < ADAPT_TUNING.fitMinSamples) return undefined;
    const minBytes = Math.min(...h.map((x) => x.bytes));
    const maxBytes = Math.max(...h.map((x) => x.bytes));
    if (minBytes <= 0 || maxBytes < minBytes * ADAPT_TUNING.fitMinSpread) return undefined;
    const n = h.length;
    const mx = h.reduce((a, x) => a + x.bytes, 0) / n;
    const my = h.reduce((a, x) => a + x.rtt, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const x of h) {
      sxy += (x.bytes - mx) * (x.rtt - my);
      sxx += (x.bytes - mx) * (x.bytes - mx);
      syy += (x.rtt - my) * (x.rtt - my);
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    // Sizes that differ a lot with round trips that do not: latency, not the link's capacity.
    if (maxBytes >= minBytes * ADAPT_TUNING.flatMinSpread && slope * (maxBytes - minBytes) < ADAPT_TUNING.flatRttIntervals * this.interval) {
      return minRtt;
    }
    if (sxx <= 0 || syy <= 0 || sxy <= 0) return undefined;
    if ((sxy * sxy) / (sxx * syy) < ADAPT_TUNING.fitMinR2) return undefined;
    return Math.min(minRtt, Math.max(0, my - slope * mx));
  }

  /** The key of the level one link step up (VP8: bitrate first, then a width the link gave up). */
  private linkUpKey(): string | undefined {
    if (!this.video) return this.current > 0 ? String(this.current - 1) : undefined;
    if (this.rate > 0) return `${this.widthIndex}:${this.rate - 1}`;
    if (this.wLink > 0) return `${Math.max(this.wCpu, this.wLink - 1)}:0`;
    return undefined;
  }

  /**
   * The round trip expected one level up: the base round trip plus the transfer part scaled by
   * the bytes of the next level over this one (measured when that level was seen, else a default).
   */
  private projectedRtt(m: AdaptMeasure): number | undefined {
    if (m.rttMs === undefined) return undefined;
    const base = Math.min(m.baseRttMs ?? 0, m.rttMs);
    const here = this.bytesAt.get(this.levelKey);
    const upKey = this.linkUpKey();
    const next = upKey === undefined ? undefined : this.bytesAt.get(upKey);
    const ratio = here !== undefined && next !== undefined && here > 0 ? Math.min(4, Math.max(1, next / here)) : ADAPT_TUNING.defaultCostRatio;
    return base + (m.rttMs - base) * ratio;
  }

  /** VP8: the encode time expected at width step `index`: it grows with the pixels. */
  private projectedEncode(encodeMs: number, index: number): number {
    const ratio = this.widths[Math.max(0, index)] / Math.max(1, this.widths[this.widthIndex]);
    return encodeMs * ratio * ratio;
  }

  private describe(m: AdaptMeasure): string {
    const parts: string[] = [];
    if (m.rttMs !== undefined) parts.push(`rtt ${Math.round(m.rttMs)} ms`);
    if (m.encodeMs !== undefined) parts.push(`encode ${Math.round(m.encodeMs)} ms`);
    if (m.skipRate !== undefined) parts.push(`${Math.round(m.skipRate * 100)}% ticks skipped`);
    parts.push(`${Math.round(m.bytesPerSec / 1024)} KiB/s`);
    return parts.join(', ');
  }

  private describeCpu(m: AdaptMeasure): string {
    const convert = m.convertMs === undefined ? '' : ` (convert ${Math.round(m.convertMs)} ms)`;
    return `phone CPU: encode ${Math.round(m.encodeMs ?? 0)} ms per frame${convert} for a ${Math.round(this.frameInterval)} ms frame interval, ${this.describe({ ...m, encodeMs: undefined })}`;
  }

  private reset(now: number): void {
    this.samples = [];
    this.goodSince = undefined;
    this.steadySince = undefined;
    this.cpuBadSince = undefined;
    this.cpuGoodSince = undefined;
    this.levelSince = now;
  }

  private limits(): AdaptCause[] {
    if (!this.video) return this.current > 0 ? ['link'] : [];
    const out: AdaptCause[] = [];
    if (this.rate > 0 || this.wLink > this.wCpu) out.push('link');
    if (this.wCpu > 0) out.push('cpu');
    return out;
  }

  private decision(direction: 'down' | 'up', cause: AdaptCause, reason: string): AdaptDecision {
    const l = this.setting as AdaptLevel;
    return { ...l, level: this.level, levels: this.levelCount, direction, reason, cause, limits: this.limits() };
  }
}

/** The upstream line that sets width and quality (JPEG) or width and bitrate (VP8) on an adaptive stream. */
export function setLine(l: AdaptLevel, codec: 'jpeg' | 'vp8' = 'jpeg'): string {
  const field = codec === 'vp8' ? 'bitrate' : 'quality';
  return `{"set":{"width":${Math.round(l.width)},"${field}":${Math.round(l.quality)}}}\n`;
}
