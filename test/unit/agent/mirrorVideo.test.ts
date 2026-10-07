import * as assert from 'assert';
import {
  ByteRate,
  DecodeErrors,
  KeyframeRequests,
  MIRROR_VIDEO_DEFAULTS,
  VIDEO_FAILURE,
  agentSupportsVideo,
  isVp8,
  mirrorHtml,
  pageCodecs,
  parseMirrorHeader,
  parseMirrorLine,
  logText,
} from '../../../src/agent/mirrorCore';
import { MIRROR_DEFAULTS } from '../../../src/agent/mirrorCore';
import { MirrorRecordParser, keyframeLine, mirrorRequestLine, type MirrorEvent } from '../../../src/agent/mirrorWire';
import { ADAPT_TUNING, AdaptiveQuality, adaptLevels, setLine, videoSteps, type AdaptDecision } from '../../../src/agent/mirrorAdapt';

/** A VP8 key frame's first bytes: tag (bit 0 clear), start code, 14-bit width 720 and height 1600. */
const KEY = Buffer.from([0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0xd0, 0x02, 0x40, 0x06, 0x00, 0x11]);
/** A VP8 inter frame: bit 0 of the tag set. */
const DELTA = Buffer.from([0x51, 0x02, 0x00, 0x22, 0x33]);

function record(header: object, payload: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length, 0);
  return Buffer.concat([len, h, payload]);
}

const VP8_STATUS = '{"ok":true,"stream":"mirror","fps":30,"width":720,"quality":60,"encoding":"vp8","window":4,"bitrate":2000,"adapt":true,"lease":60}\n';

function vp8Header(frame: number, key: boolean, bytes: number, extra: object = {}): object {
  return { frame, ts: 1000 + frame, screen: [720, 1600], size: [720, 1600], format: 'vp8', key, pts: frame * 33, bytes, ems: 9, cvms: 3, capture: 'native', ...extra };
}

describe('mirror video: wire format (agent 1.6.0)', () => {
  it('parses the vp8 status line with its bitrate and window', () => {
    const s = parseMirrorLine(VP8_STATUS);
    assert.deepStrictEqual(s, { kind: 'status', ok: true, fps: 30, width: 720, quality: 60, encoding: 'vp8', window: 4, lease: 60, adapt: true, bitrate: 2000 });
  });

  it('parses a vp8 record header: key, pts, cvms and kbps', () => {
    const h = parseMirrorHeader(vp8Header(3, true, 12, { kbps: 1200, ticks: 5, skips: 1 }) as Record<string, unknown>, 'record');
    assert.ok(h && h.kind === 'frame');
    assert.strictEqual(h.format, 'vp8');
    assert.strictEqual(h.key, true);
    assert.strictEqual(h.pts, 99);
    assert.strictEqual(h.cvms, 3);
    assert.strictEqual(h.kbps, 1200);
    assert.strictEqual(h.ems, 9);
    assert.strictEqual(h.capture, 'native');
  });

  it('agent 1.8.0: reads pace and refresh, drops malformed ones without failing the frame', () => {
    const h = parseMirrorHeader(vp8Header(4, false, 12, { pace: 50, refresh: true }) as Record<string, unknown>, 'record');
    assert.ok(h && h.kind === 'frame');
    assert.strictEqual(h.pace, 50);
    assert.strictEqual(h.refresh, true);
    for (const bad of [{ pace: 0 }, { pace: 33.3 }, { pace: '50' }, { pace: 1e9 }, { refresh: 'yes' }]) {
      const b = parseMirrorHeader(vp8Header(5, false, 12, bad) as Record<string, unknown>, 'record');
      assert.ok(b && b.kind === 'frame', JSON.stringify(bad));
      assert.strictEqual(b.pace, undefined, JSON.stringify(bad));
      assert.strictEqual(b.refresh, undefined, JSON.stringify(bad));
    }
    // An agent before 1.8.0 sends neither.
    const old = parseMirrorHeader(vp8Header(6, false, 12) as Record<string, unknown>, 'record');
    assert.ok(old && old.kind === 'frame' && old.pace === undefined && old.refresh === undefined);
  });

  it('refuses a vp8 header without a boolean key or an integer pts', () => {
    for (const bad of [{ key: undefined }, { key: 1 }, { pts: -1 }, { pts: 1.5 }, { pts: 'x' }]) {
      const o = { ...vp8Header(1, true, 12), ...bad } as Record<string, unknown>;
      if ('key' in bad && bad.key === undefined) delete o.key;
      assert.strictEqual(parseMirrorHeader(o, 'record'), undefined, JSON.stringify(bad));
    }
  });

  it('never accepts vp8 on a text line (the sfdk fallback is JPEG only)', () => {
    const line = JSON.stringify({ ...vp8Header(1, true, 12), data: 'AAAA' });
    assert.strictEqual(parseMirrorLine(line), undefined);
  });

  it('drops an invalid kbps without failing the frame', () => {
    const h = parseMirrorHeader(vp8Header(2, false, 5, { kbps: 0 }) as Record<string, unknown>, 'record');
    assert.ok(h && h.kind === 'frame' && h.kbps === undefined);
  });

  it('the record parser reads a vp8 stream: status, a key frame, a delta, same', () => {
    const parser = new MirrorRecordParser();
    const events: MirrorEvent[] = parser.push(
      Buffer.concat([
        Buffer.from(VP8_STATUS),
        record(vp8Header(1, true, KEY.length), KEY),
        record(vp8Header(2, false, DELTA.length), DELTA),
        record({ frame: 3, ts: 1003, same: true }),
      ]),
    );
    assert.strictEqual(parser.failed, undefined);
    assert.deepStrictEqual(events.map((e) => e.kind), ['status', 'frame', 'frame', 'same']);
    const f = events[1];
    assert.ok(f.kind === 'frame' && f.key === true && f.pts === 33 && f.payload.equals(KEY));
  });

  it('the vp8 request carries fps, width, bitrate and adapt; the JPEG request is unchanged', () => {
    assert.strictEqual(
      mirrorRequestLine({ ...MIRROR_VIDEO_DEFAULTS, lease: 60, adapt: true }, 'vp8'),
      '{"cmd":"mirror","fps":30,"width":720,"quality":60,"encoding":"vp8","bitrate":2000,"lease":60,"adapt":true}\n',
    );
    // A bitrate never leaks into the JPEG request.
    assert.strictEqual(
      mirrorRequestLine({ ...MIRROR_DEFAULTS, lease: 60, adapt: true, bitrate: 900 }, 'binary'),
      '{"cmd":"mirror","fps":4,"width":360,"quality":60,"encoding":"binary","lease":60,"adapt":true}\n',
    );
    assert.strictEqual(keyframeLine(), '{"keyframe":true}\n');
    assert.ok(keyframeLine().length <= 256);
  });
});

describe('mirror video: support checks', () => {
  it('the agent offers vp8 only when it lists it', () => {
    assert.strictEqual(agentSupportsVideo({ mirrorEncodings: ['text', 'binary', 'vp8'] }), true);
    assert.strictEqual(agentSupportsVideo({ mirrorEncodings: ['text', 'binary'] }), false);
    assert.strictEqual(agentSupportsVideo({}), false);
  });

  it('page codecs: only known names; anything malformed is none', () => {
    assert.deepStrictEqual(pageCodecs({ type: 'ready', codecs: ['vp8'] }), ['vp8']);
    assert.deepStrictEqual(pageCodecs({ type: 'ready', codecs: ['vp8', 'h264', 'vp8'] }), ['vp8']);
    assert.deepStrictEqual(pageCodecs({ type: 'ready', codecs: ['h264'] }), []);
    assert.deepStrictEqual(pageCodecs({ type: 'ready', codecs: 'vp8' }), []);
    assert.deepStrictEqual(pageCodecs({ type: 'ready' }), []);
    assert.deepStrictEqual(pageCodecs(null), []);
  });

  it('isVp8 checks the frame tag and a key frame start code and size', () => {
    assert.strictEqual(isVp8(KEY, true), true);
    assert.strictEqual(isVp8(DELTA, false), true);
    assert.strictEqual(isVp8(KEY, false), false, 'a key frame announced as delta');
    assert.strictEqual(isVp8(DELTA, true), false, 'a delta announced as key');
    const noStart = Buffer.from(KEY);
    noStart[4] = 0;
    assert.strictEqual(isVp8(noStart, true), false);
    const zeroWidth = Buffer.from(KEY);
    zeroWidth[6] = 0;
    zeroWidth[7] = 0;
    assert.strictEqual(isVp8(zeroWidth, true), false);
    assert.strictEqual(isVp8(Buffer.from([0x50]), true), false);
    assert.strictEqual(isVp8(Buffer.from([0xff, 0xd8, 0xff]), true), false, 'a JPEG is not VP8');
  });
});

describe('mirror video: key frame requests, bitrate, decode errors', () => {
  it('one request per gap: no second request until a key frame arrives or the gap passes', () => {
    const k = new KeyframeRequests(1000);
    assert.strictEqual(k.want(0), true);
    assert.strictEqual(k.want(10), false);
    assert.strictEqual(k.want(999), false);
    assert.strictEqual(k.want(1000), true, 'the key frame did not come: ask again');
    k.keyReceived();
    assert.strictEqual(k.want(1001), true, 'answered: a new gap asks at once');
    assert.strictEqual(k.count, 3);
  });

  it('ByteRate is kbit/s over the last 3 s', () => {
    const r = new ByteRate();
    r.add(0, 3000);
    r.add(1000, 3000);
    r.add(2000, 3000);
    assert.strictEqual(r.kbps(2000), 24); // 9000 bytes * 8 / 3000 ms
    assert.strictEqual(r.kbps(3500), 16); // the first sample left the window
    assert.strictEqual(r.kbps(10_000), 0);
  });

  it('DecodeErrors gives up after VIDEO_FAILURE.errors errors inside the window only', () => {
    const d = new DecodeErrors();
    assert.strictEqual(d.add(0), false);
    assert.strictEqual(d.add(VIDEO_FAILURE.windowMs + 1), false, 'the first one has expired');
    assert.strictEqual(d.add(VIDEO_FAILURE.windowMs + 2), false);
    assert.strictEqual(d.add(VIDEO_FAILURE.windowMs + 3), true);
  });
});

describe('mirror video: strip', () => {
  it('shows codec, fps, bitrate and the video size with its target', () => {
    assert.strictEqual(
      logText({ state: 'live', transport: 'ssh', codec: 'vp8', fps: 29.84, kbps: 851.2, latencyMs: 41, frameMs: 18, video: { width: 720, height: 1600, targetKbps: 2000 } }),
      'live (ssh), vp8, 29.8 fps, 851 kbit/s, latency 41 ms, phone 18 ms, video 720x1600 at 2000 kbit/s',
    );
    assert.strictEqual(
      logText({ state: 'live', transport: 'ssh', codec: 'vp8', fps: 30, kbps: 400, video: { width: 540, height: 1200, targetKbps: 800, reduced: true } }),
      'live (ssh), vp8, 30.0 fps, 400 kbit/s, latency —, video 540x1200 at 800 kbit/s (reduced for the link)',
    );
  });

  it('names the cause of a reduction: the link, the phone CPU or both', () => {
    const v = { width: 540, height: 1200, targetKbps: 2000, reduced: true };
    assert.strictEqual(
      logText({ state: 'live', transport: 'ssh', codec: 'vp8', fps: 24.7, video: { ...v, reducedFor: ['cpu'] } }),
      'live (ssh), vp8, 24.7 fps, latency —, video 540x1200 at 2000 kbit/s (reduced for the phone CPU)',
    );
    assert.ok(logText({ state: 'live', video: { ...v, reducedFor: ['link', 'cpu'] } }).endsWith('(reduced for the link and the phone CPU)'));
    assert.ok(logText({ state: 'live', video: { ...v, reducedFor: ['link'] } }).endsWith('(reduced for the link)'));
    assert.ok(logText({ state: 'live', video: { ...v, reducedFor: [] } }).endsWith('(reduced for the link)'), 'an older decision without causes');
    assert.ok(!logText({ state: 'live', video: { ...v, reduced: false, reducedFor: ['cpu'] } }).includes('reduced'));
  });

  it('shows idle instead of a misleading low frame rate on a still screen', () => {
    assert.strictEqual(
      logText({ state: 'live', transport: 'ssh', codec: 'vp8', fps: 0.3, idle: true, kbps: 2, video: { width: 720, height: 1600, targetKbps: 2000 } }),
      'live (ssh), vp8, idle (no screen changes), 2 kbit/s, latency —, video 720x1600 at 2000 kbit/s',
    );
  });

  it('a JPEG stream names its codec and bitrate too', () => {
    assert.strictEqual(
      logText({ state: 'live', transport: 'ssh', codec: 'jpeg', fps: 4, kbps: 1000, latencyMs: 30, image: { width: 360, height: 800, quality: 60 } }),
      'live (ssh), jpeg, 4.0 fps, 1000 kbit/s, latency 30 ms, image 360x800 q60',
    );
  });
});

describe('mirror video: page', () => {
  const html = mirrorHtml('n0nce', 'dev');
  const script = html.slice(html.indexOf('<script'), html.indexOf('</script>'));

  it('keeps the CSP: nothing added for video', () => {
    assert.ok(html.includes(`content="default-src 'none'; img-src blob:; style-src 'nonce-n0nce'; script-src 'nonce-n0nce'"`));
    assert.ok(!/(media-src|worker-src|connect-src|unsafe-)/.test(html));
  });

  it('decodes VP8 with WebCodecs onto a canvas and reports its codecs first', () => {
    assert.ok(html.includes('<canvas id="video"'));
    assert.ok(script.includes('new VideoDecoder('));
    assert.ok(script.includes("isConfigSupported({ codec: 'vp8' })"));
    assert.ok(script.includes('new EncodedVideoChunk('));
    assert.ok(script.includes("type: 'ready', codecs: list"));
    assert.ok(script.includes('frame.close()'), 'every VideoFrame is closed');
  });

  it('asks for a key frame when it cannot decode and acknowledges every frame', () => {
    assert.ok(script.includes("type: 'keyframe'"));
    assert.ok(script.includes("wantKey('no key frame yet')"));
    assert.ok(script.includes("wantKey('decode error: '"));
    assert.ok(script.includes("wantKey('the decoder fell behind')"));
    assert.ok(script.includes("type: 'shown', frame: current"));
  });

  it('allows pointer gestures only: no keyboard or unsafe DOM writes', () => {
    assert.ok(script.includes("addEventListener('pointerdown'"));
    assert.ok(script.includes("addEventListener('pointerup'"));
    // The only key handler closes the details popover on Escape.
    assert.ok(!/addEventListener\('(key(?!down')|mouse|touch|wheel)/.test(script));
    assert.strictEqual(script.match(/keydown/g)?.length, 1);
    assert.ok(!script.includes('keyup'));
    assert.ok(!script.includes('innerHTML'));
    assert.ok(!/\son[a-z]+=/.test(html));
  });
});

describe('mirror video: adaptive control', () => {
  const START = { fps: 30, width: 720, quality: 2000, codec: 'vp8' as const, window: 4 };
  const saved = { ...ADAPT_TUNING };
  afterEach(() => Object.assign(ADAPT_TUNING, saved));

  it('two axes: bitrates for the link, widths for the CPU; widths are even', () => {
    assert.deepStrictEqual(videoSteps(START, 720), { widths: [720, 540, 360], bitrates: [2000, 1200, 800, 500, 300] });
    // The phone: a 720 request on a 1032-wide screen; a native request stays even at every step.
    assert.deepStrictEqual(videoSteps(START, 1032).widths, [720, 540, 360]);
    for (const w of videoSteps({ ...START, width: 0 }, 1033).widths) assert.strictEqual(w % 2, 0, String(w));
    // The bitrate never goes under its floor.
    assert.ok(videoSteps({ ...START, quality: 500 }, 720).bitrates.every((q) => q >= ADAPT_TUNING.minBitrate));
    // The link's path: every bitrate at full width, then the widths at the lowest bitrate.
    assert.deepStrictEqual(adaptLevels(START, 720).map((l) => [l.width, l.quality]), [
      [720, 2000], [720, 1200], [720, 800], [720, 500], [720, 300], [540, 300], [360, 300],
    ]);
  });

  it('the set line carries bitrate for video', () => {
    assert.strictEqual(setLine({ width: 540, quality: 800 }, 'vp8'), '{"set":{"width":540,"bitrate":800}}\n');
    assert.strictEqual(setLine({ width: 270, quality: 45 }), '{"set":{"width":270,"quality":45}}\n');
  });

  interface Feed { rtt?: number; ems?: number; cvms?: number; skips?: number; key?: boolean; refresh?: boolean }

  /** The agent's cumulative tick counters per controller (they never go back). */
  const counters = new WeakMap<AdaptiveQuality, { ticks: number; skips: number }>();

  /** Feeds 30 fps frames at the controller's current level from `from` ms; returns its decisions. */
  function run(c: AdaptiveQuality, ms: number, frame: (i: number, t: number, level: { width: number; quality: number }) => Feed, from = 0): AdaptDecision[] {
    const out: AdaptDecision[] = [];
    const n = counters.get(c) ?? { ticks: 0, skips: 0 };
    counters.set(c, n);
    for (let i = Math.round(from / 33) + 1, t = from; t <= from + ms; i++, t += 33) {
      const level = c.setting ?? { width: 720, quality: 2000 };
      const f = frame(i, t, level);
      const ticks = ++n.ticks;
      const skips = (n.skips += f.skips ?? 0);
      const d = c.onFrame({
        at: t, frame: i, bytes: Math.round(level.quality * 4), width: level.width, screenWidth: 720, screenHeight: 1600,
        q: level.quality, rtt: f.rtt, rttFrame: f.rtt === undefined ? undefined : i - 1, ticks, skips, ems: f.ems, cvms: f.cvms,
        key: f.key, refresh: f.refresh,
      });
      if (d) out.push(d);
    }
    return out;
  }

  /** Encode time that grows with the pixels: `at720` ms at 720 wide. */
  const encodeAt = (at720: number) => (w: number): number => Math.round(at720 * (w / 720) ** 2);

  it('a good link at 30 fps stays at the top (the round trip is judged against the 4-frame window)', () => {
    // 60 ms round trips are 1.8 frame intervals, but under 1.2 x (33 ms x 4 / 2).
    const d = run(new AdaptiveQuality(START), 20_000, () => ({ rtt: 60, ems: 12 }));
    assert.deepStrictEqual(d, []);
  });

  it('an encoder that keeps up keeps the width, even close to the frame interval', () => {
    const d = run(new AdaptiveQuality(START), 30_000, () => ({ rtt: 5, ems: 32, cvms: 6 }));
    assert.deepStrictEqual(d, []);
  });

  it('an encoder that cannot keep up gets a smaller width for the phone CPU; the bitrate stays', () => {
    const c = new AdaptiveQuality(START);
    const d = run(c, 5000, (_i, _t, l) => ({ rtt: 3, ems: encodeAt(45)(l.width), cvms: 9 }));
    assert.strictEqual(d.length, 1, JSON.stringify(d));
    assert.strictEqual(d[0].direction, 'down');
    assert.strictEqual(d[0].cause, 'cpu');
    assert.deepStrictEqual(d[0].limits, ['cpu']);
    assert.deepStrictEqual([d[0].width, d[0].quality], [540, 2000], 'width only');
    assert.ok(/^phone CPU: encode 45 ms per frame \(convert 9 ms\) for a 33 ms frame interval/.test(d[0].reason), d[0].reason);
    assert.strictEqual(c.setting?.width, 540);
  });

  it('waits out the CPU hold: one second of slow frames is a spike, not a reason', () => {
    const d = run(new AdaptiveQuality(START), 30_000, (_i, t) => ({ rtt: 3, ems: t % 5000 < 1000 ? 60 : 15 }));
    assert.deepStrictEqual(d, []);
  });

  it('key frames and idle refreshes do not count as encode time', () => {
    const d = run(new AdaptiveQuality(START), 20_000, (i) => (i % 3 === 0 ? { rtt: 3, ems: 90, key: true } : i % 3 === 1 ? { rtt: 3, ems: 80, refresh: true } : { rtt: 3, ems: 15 }));
    assert.deepStrictEqual(d, []);
  });

  it('does not flap: a width the encoder could not sustain does not come back', () => {
    ADAPT_TUNING.upHoldMs = 500;
    ADAPT_TUNING.probeMs = 1_000_000;
    // 36 ms at 720 is over the interval; at 540 it is about 20 ms, and 720 projected from there is 36 again.
    const d = run(new AdaptiveQuality(START), 60_000, (_i, _t, l) => ({ rtt: 3, ems: encodeAt(36)(l.width) }));
    assert.deepStrictEqual(d.map((x) => [x.direction, x.cause, x.width]), [['down', 'cpu', 540]]);
  });

  it('gives a width back to the CPU once it fits with room, after the hold', () => {
    ADAPT_TUNING.upHoldMs = 6000;
    const c = new AdaptiveQuality(START);
    const slow = run(c, 4000, (_i, _t, l) => ({ rtt: 3, ems: encodeAt(45)(l.width) }));
    assert.deepStrictEqual(slow.map((x) => x.width), [540]);
    const at = 4000;
    // The phone is idle again: 720 would take 15 ms, under 0.7 x 33 ms.
    const back = run(c, 20_000, (_i, _t, l) => ({ rtt: 3, ems: encodeAt(15)(l.width) }), at);
    assert.deepStrictEqual(back.map((x) => [x.direction, x.cause, x.width, x.quality]), [['up', 'cpu', 720, 2000]]);
    assert.deepStrictEqual(back[0].limits, []);
  });

  it('skipped captures on a slow link lower the bitrate first and keep the width', () => {
    const d = run(new AdaptiveQuality(START), 3000, () => ({ rtt: 30, ems: 10, skips: 1 }));
    assert.ok(d.length >= 1);
    assert.deepStrictEqual([d[0].width, d[0].quality, d[0].cause], [720, 1200, 'link']);
    assert.deepStrictEqual(d[0].limits, ['link']);
  });

  it('a slow link and a slow CPU are both named in the limits', () => {
    const c = new AdaptiveQuality(START);
    run(c, 5000, (_i, _t, l) => ({ rtt: 3, ems: encodeAt(45)(l.width) }));
    assert.strictEqual(c.setting?.width, 540);
    const d = run(c, 3000, (_i, _t, l) => ({ rtt: 3, ems: encodeAt(45)(l.width), skips: 1 }), 5000);
    assert.ok(d.length >= 1);
    assert.deepStrictEqual([d[0].width, d[0].quality, d[0].cause], [540, 1200, 'link']);
    assert.deepStrictEqual(d[0].limits, ['link', 'cpu']);
  });
});
