import * as assert from 'assert';
import {
  ADAPT_TUNING,
  AdaptiveQuality,
  adaptLevels,
  scaledHeight,
  setLine,
  type AdaptDecision,
  type AdaptLevel,
} from '../../../src/agent/mirrorAdapt';

const PHONE: [number, number] = [1032, 2272];
const EMULATOR: [number, number] = [720, 1600];
const START = { fps: 4, width: 360, quality: 60 };

interface Link {
  /** Ack round trip for an image of `bytes`. */
  rtt: (bytes: number) => number;
  /** Share of ticks skipped because of the link, for images of `bytes`. */
  skip: (bytes: number) => number;
}

/**
 * Mean image bytes at a level: proportional to the pixels and the quality (360x800 q60 is about
 * 27 KB, as measured on the emulator's home screen).
 */
function bytesFor(l: AdaptLevel, screen: [number, number]): number {
  return Math.round((l.width * scaledHeight(l.width, screen[0], screen[1]) * l.quality) / 640);
}

/**
 * A link of `kbps` KiB/s and `baseMs` latency carrying a 4 fps stream with the agent's 2-frame ack
 * window: while it keeps up, a round trip is the latency plus one image's transfer; when the
 * stream wants more than the link carries, the window stays full (two images queued) and the
 * agent skips the ticks the link cannot take.
 */
function linkOf(kbps: number, baseMs = 20): Link {
  const rate = (kbps * 1024) / 1000; // bytes per ms
  const over = (bytes: number): boolean => bytes * START.fps > rate * 1000;
  return {
    rtt: (bytes) => baseMs + ((over(bytes) ? 2 : 1) * bytes) / rate,
    skip: (bytes) => (over(bytes) ? 1 - (rate * 1000) / (bytes * START.fps) : 0),
  };
}

/** The KiB/s at which images of `level` take `intervals` frame intervals to transfer (base 20 ms). */
function kbpsFor(level: AdaptLevel, intervals: number, screen: [number, number] = PHONE): number {
  return (bytesFor(level, screen) / (intervals * 250)) * (1000 / 1024);
}

const L = adaptLevels(START, PHONE[0]);

/** Deterministic +-15 % content variation of the image size. */
function jitter(i: number): number {
  return 1 + 0.15 * Math.sin(i * 2.399);
}

/**
 * Drives `c` like the transport does: one tick per frame interval; skipped ticks send nothing; every
 * other tick delivers an image at the level the agent was last asked for (after `lagFrames` frames
 * at the previous level, as frames already in flight). Returns the decisions with their times.
 */
class Sim {
  t = 0;
  ticks = 0;
  skips = 0;
  private skipAcc = 0;
  private n = 0;
  private frame = 0;
  /** The latest acknowledged image: its header round trip goes out with the next image, as the agent does. */
  private acked: { frame: number; rtt: number } | undefined;
  agent: AdaptLevel;
  private lag: AdaptLevel[] = [];
  readonly decisions: { at: number; d: AdaptDecision }[] = [];

  constructor(
    readonly c: AdaptiveQuality,
    readonly screen: [number, number] = PHONE,
    readonly lagFrames = 1,
  ) {
    this.agent = adaptLevels(START, screen[0])[0];
  }

  run(seconds: number, link: Link): void {
    const interval = 1000 / START.fps;
    const end = this.t + seconds * 1000;
    while (this.t < end) {
      this.t += interval;
      this.ticks++;
      const level = this.lag.length > 0 ? (this.lag[0]) : this.agent;
      const bytes = Math.round(bytesFor(level, this.screen) * jitter(++this.n));
      this.skipAcc += link.skip(bytes);
      if (this.skipAcc >= 1) {
        this.skipAcc -= 1;
        this.skips++;
        continue;
      }
      this.lag.shift();
      const frame = ++this.frame;
      const d = this.c.onFrame({
        at: this.t,
        frame,
        bytes,
        width: level.width,
        screenWidth: this.screen[0],
        screenHeight: this.screen[1],
        q: level.quality,
        rtt: this.acked?.rtt,
        rttFrame: this.acked?.frame,
        ticks: this.ticks,
        skips: this.skips,
      });
      this.acked = { frame, rtt: link.rtt(bytes) };
      if (d) {
        this.decisions.push({ at: this.t, d });
        this.lag = Array(this.lagFrames).fill(this.agent) as AdaptLevel[];
        this.agent = { width: d.width, quality: d.quality };
      }
    }
  }

  levels(): number[] {
    return this.decisions.map((x) => x.d.level);
  }
}

describe('mirrorAdapt levels', () => {
  it('works from the real screen width and keeps the aspect ratio (phone 1032x2272)', () => {
    const l = adaptLevels(START, PHONE[0]);
    assert.deepStrictEqual(l, [
      { width: 360, quality: 60 },
      { width: 360, quality: 45 },
      { width: 270, quality: 45 },
      { width: 270, quality: 30 },
      { width: 180, quality: 30 },
    ]);
    assert.deepStrictEqual(l.map((x) => scaledHeight(x.width, PHONE[0], PHONE[1])), [793, 793, 594, 594, 396]);
    assert.deepStrictEqual(l.map((x) => scaledHeight(x.width, EMULATOR[0], EMULATOR[1])), [800, 800, 600, 600, 400]);
  });

  it('a native request starts at the screen width', () => {
    assert.deepStrictEqual(adaptLevels({ ...START, width: 0 }, PHONE[0]).map((x) => x.width), [1032, 1032, 774, 774, 516]);
    assert.deepStrictEqual(adaptLevels({ ...START, width: 4000 }, EMULATOR[0]).map((x) => x.width), [720, 720, 540, 540, 360]);
  });

  it('a small screen keeps a minimum width and drops duplicate steps', () => {
    const l = adaptLevels({ fps: 4, width: 360, quality: 12 }, 160);
    assert.deepStrictEqual(l, [
      { width: 160, quality: 12 },
      { width: 160, quality: 10 },
      { width: 120, quality: 10 },
    ]);
  });

  it('setLine is one upstream line well under the agent limit', () => {
    const line = setLine({ width: 270, quality: 45 });
    assert.strictEqual(line, '{"set":{"width":270,"quality":45}}\n');
    assert.ok(line.length < 256);
  });
});

describe('AdaptiveQuality', () => {
  const saved = { ...ADAPT_TUNING };
  afterEach(() => Object.assign(ADAPT_TUNING, saved));

  it('stays at the top level on a good link (no decisions)', () => {
    const sim = new Sim(new AdaptiveQuality(START));
    sim.run(60, linkOf(4000));
    assert.deepStrictEqual(sim.decisions, []);
    assert.strictEqual(sim.c.level, 0);
  });

  it('steps down one level at a time on a slow link, no faster than the down hold, to the bottom', () => {
    const sim = new Sim(new AdaptiveQuality(START));
    // 10 KiB/s: even the bottom level (180x396 q30, ~3.3 KB) wants 13 KB/s at 4 fps.
    sim.run(30, linkOf(10));
    assert.deepStrictEqual(sim.levels(), [1, 2, 3, 4]);
    for (let i = 1; i < sim.decisions.length; i++) {
      assert.ok(sim.decisions[i].at - sim.decisions[i - 1].at >= ADAPT_TUNING.downHoldMs);
    }
    assert.ok(sim.decisions.every((x) => x.d.direction === 'down' && x.d.levels === 5));
    assert.match(sim.decisions[0].d.reason, /rtt \d+ ms/);
    assert.strictEqual(sim.c.level, 4);
  });

  it('stops stepping down at the first level the link carries, and stays there', () => {
    const sim = new Sim(new AdaptiveQuality(START));
    // Level 2 (270x594 q45) takes 0.8 frame intervals; level 1 would take 1.4 and fill the window.
    sim.run(60, linkOf(kbpsFor(L[2], 0.8)));
    assert.deepStrictEqual(sim.levels(), [1, 2]);
    assert.strictEqual(sim.c.level, 2);
  });

  it('steps down on skipped ticks alone (window full) even with a modest round trip', () => {
    const sim = new Sim(new AdaptiveQuality(START));
    sim.run(5, { rtt: () => 100, skip: () => 0.5 });
    assert.ok(sim.decisions.length >= 1);
    assert.strictEqual(sim.decisions[0].d.direction, 'down');
    assert.match(sim.decisions[0].d.reason, /50% ticks skipped/);
  });

  it('frames still in flight at the old level do not count for the new one', () => {
    const sim = new Sim(new AdaptiveQuality(START), PHONE, 3);
    sim.run(3, linkOf(40));
    // Without the filter the three late frames at level 0 would push a second step at once.
    assert.deepStrictEqual(sim.levels(), [1]);
  });

  it('a link so slow that images come seconds apart still steps down', () => {
    const sim = new Sim(new AdaptiveQuality(START));
    sim.run(30, { rtt: () => 1500, skip: () => 0.85 });
    assert.ok(sim.c.level >= 2, `level ${sim.c.level}`);
  });

  it('recovers: steps back up one level at a time after the up hold, never faster', () => {
    const sim = new Sim(new AdaptiveQuality(START));
    sim.run(20, linkOf(10));
    assert.strictEqual(sim.c.level, 4);
    const downAt = sim.t;
    sim.run(60, linkOf(4000));
    const ups = sim.decisions.filter((x) => x.d.direction === 'up');
    assert.deepStrictEqual(ups.map((x) => x.d.level), [3, 2, 1, 0]);
    assert.ok(ups[0].at - downAt >= ADAPT_TUNING.upHoldMs);
    for (let i = 1; i < ups.length; i++) assert.ok(ups[i].at - ups[i - 1].at >= ADAPT_TUNING.upHoldMs);
    assert.deepStrictEqual(sim.c.setting, { width: 360, quality: 60 });
    assert.match(ups[0].d.reason, /projected rtt \d+ ms/);
  });

  it('holds in the band between the thresholds (no oscillation)', () => {
    const c = new AdaptiveQuality(START);
    const sim = new Sim(c);
    // Level 1 takes 0.9 intervals: level 0 (4/3 of the bytes) is over the step-down threshold
    // (1.2), and level 1 is under it but its projection up is over the step-up one (0.7).
    sim.run(55, linkOf(kbpsFor(L[1], 0.9)));
    assert.deepStrictEqual(sim.levels(), [1]);
  });

  it('does not chase latency: round trips that do not shrink with the size stop the steps down', () => {
    const c = new AdaptiveQuality(START);
    const sim = new Sim(c);
    // 400 ms whatever the size (1.6 intervals, inside the 2-frame window: a few skips), with a
    // few ms of noise as on the emulator.
    let i = 0;
    sim.run(130, { rtt: () => 400 + 3 * Math.sin(++i * 1.7), skip: () => 0.08 });
    const downs = sim.decisions.filter((x) => x.d.direction === 'down');
    assert.ok(downs.length <= 2, `${downs.length} steps down`);
    assert.ok(downs.every((x) => x.at < 10_000));
    // Then the probe brings it back, one level a minute, without bouncing.
    assert.ok(c.level <= 1, `level ${c.level}`);
  });

  it('probes one level up after a minute without congestion (latency that does not depend on size)', () => {
    const c = new AdaptiveQuality(START);
    const sim = new Sim(c);
    sim.run(5, { rtt: () => 400, skip: () => 0 });
    const n = sim.decisions.length;
    assert.ok(n >= 1);
    const level = c.level;
    sim.run(70, { rtt: () => 200, skip: () => 0 });
    const ups = sim.decisions.slice(n);
    assert.strictEqual(ups.length, 1);
    assert.strictEqual(ups[0].d.level, level - 1);
    assert.match(ups[0].d.reason, /probe after 60 s without congestion/);
    assert.ok(ups[0].at - sim.decisions[n - 1].at >= ADAPT_TUNING.probeMs);
  });

  it('does not step up when the next level would not fit (headroom from the measured bytes)', () => {
    const c = new AdaptiveQuality(START);
    const sim = new Sim(c);
    sim.run(30, linkOf(10));
    assert.strictEqual(c.level, 4);
    // Level 4 now takes 0.35 intervals: a low round trip, but level 3 is 2.25 times the bytes
    // (measured on the way down), so it would take 0.79 intervals; the controller stays.
    sim.run(60, linkOf(kbpsFor(L[4], 0.35)));
    assert.strictEqual(c.level, 4);
    // With level 4 at 0.25 intervals, level 3 projects to about 0.6: one step up, and no further
    // (level 2 would be 1.5 times level 3).
    const n = sim.decisions.length;
    sim.run(60, linkOf(kbpsFor(L[4], 0.25)));
    assert.deepStrictEqual(sim.levels().slice(n), [3]);
  });

  it('a step up that has to be undone soon doubles the up hold (bounded)', () => {
    const c = new AdaptiveQuality(START);
    const sim = new Sim(c);
    // A link that keeps changing: 12 s good, 4 s bad. Each step up taken in a good spell is
    // undone in the next bad one, so the controller waits longer and longer before stepping up.
    const good = linkOf(kbpsFor(L[0], 0.3));
    const bad = linkOf(kbpsFor(L[4], 2));
    const holds: number[] = [];
    for (let i = 0; i < 20; i++) {
      sim.run(4, bad);
      sim.run(12, good);
      holds.push(c.upHoldMs);
    }
    const ups = sim.decisions.filter((x) => x.d.direction === 'up').length;
    assert.strictEqual(holds[1], 2 * ADAPT_TUNING.upHoldMs, `holds ${holds.join(',')}`);
    assert.ok(Math.max(...holds) <= ADAPT_TUNING.maxUpHoldMs);
    // At most about one try a minute (after a calm minute the hold returns to its base), against
    // 20 good spells: the level does not follow the link up and down.
    assert.ok(ups <= 6, `${ups} steps up in 20 good spells`);
    assert.ok(sim.decisions.length <= 14, `${sim.decisions.length} decisions`);
  });

  it('the up hold returns to its base after a calm minute', () => {
    const c = new AdaptiveQuality(START);
    const sim = new Sim(c);
    sim.run(20, linkOf(10));
    sim.run(12, linkOf(4000)); // one step up
    sim.run(4, linkOf(10)); // bounce
    assert.ok(c.upHoldMs > ADAPT_TUNING.upHoldMs);
    sim.run(90, linkOf(4000));
    assert.strictEqual(c.upHoldMs, ADAPT_TUNING.upHoldMs);
    assert.strictEqual(c.level, 0);
  });

  it('a static screen (no images) gives no decisions and no stale step up afterwards', () => {
    const c = new AdaptiveQuality(START);
    const sim = new Sim(c);
    sim.run(20, linkOf(10));
    const n = sim.decisions.length;
    sim.t += 60_000; // a minute without images
    sim.run(1, linkOf(4000));
    assert.strictEqual(sim.decisions.length, n);
  });

  it('frames without the adaptive fields never trigger anything (older agent)', () => {
    const c = new AdaptiveQuality(START);
    for (let i = 1; i <= 100; i++) {
      assert.strictEqual(c.onFrame({ at: i * 250, bytes: 30000, width: 360, screenWidth: 720, screenHeight: 1600 }), undefined);
    }
  });

  it('a change of screen size returns to the top level', () => {
    const c = new AdaptiveQuality(START);
    const sim = new Sim(c, EMULATOR);
    sim.run(10, linkOf(30));
    assert.ok(c.level > 0);
    const d = c.onFrame({ at: sim.t + 250, bytes: 1000, width: 270, screenWidth: 1600, screenHeight: 720 });
    assert.deepStrictEqual(d && { level: d.level, width: d.width, quality: d.quality }, { level: 0, width: 360, quality: 60 });
  });
});
