import * as assert from 'assert';
import { MIRROR_DEFAULTS } from '../../../src/agent/mirrorCore';
import {
  MIRROR_MAX_FRAME_BYTES,
  MirrorRecordParser,
  ackLine,
  mirrorRequestLine,
  type MirrorEvent,
} from '../../../src/agent/mirrorWire';

const STATUS = '{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60,"encoding":"binary","window":2}\n';

function record(header: object | string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.from(typeof header === 'string' ? header : JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length, 0);
  return Buffer.concat([len, h, payload]);
}

function image(frame: number, payload: Buffer, extra: object = {}): Buffer {
  return record(
    { frame, ts: 1000 + frame, screen: [720, 1600], size: [360, 800], format: 'jpeg', bytes: payload.length, ...extra },
    payload,
  );
}

const P1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const P2 = Buffer.from('second-payload-bytes');
const P3 = Buffer.alloc(300, 7);

function stream(): Buffer {
  return Buffer.concat([
    Buffer.from(STATUS),
    image(1, P1, { cms: 20, ems: 5 }),
    record({ frame: 2, ts: 1002, same: true }),
    image(3, P2),
    record({ frame: 4, ts: 1004, error: 'cannot decode frame' }),
    image(5, P3),
    record({ pong: 2, ts: 5555 }),
  ]);
}

function feed(chunks: Buffer[]): { events: MirrorEvent[]; parser: MirrorRecordParser } {
  const parser = new MirrorRecordParser();
  const events: MirrorEvent[] = [];
  for (const c of chunks) events.push(...parser.push(c));
  return { events, parser };
}

function split(buf: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = [];
  let pos = 0;
  let i = 0;
  while (pos < buf.length) {
    const n = Math.max(1, sizes[i++ % sizes.length]);
    out.push(buf.subarray(pos, pos + n));
    pos += n;
  }
  return out;
}

/** Deterministic pseudo-random sizes (mulberry32). */
function seeded(seed: number, count: number, max: number): number[] {
  let a = seed;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out.push(1 + (((t ^ (t >>> 14)) >>> 0) % max));
  }
  return out;
}

describe('mirrorWire.MirrorRecordParser', () => {
  const whole = feed([stream()]);

  it('reads the status line and every record when fed whole', () => {
    assert.strictEqual(whole.parser.failed, undefined);
    assert.deepStrictEqual(
      whole.events.map((e) => e.kind),
      ['status', 'frame', 'same', 'frame', 'soft-error', 'frame', 'pong'],
    );
    assert.deepStrictEqual(whole.events[0], {
      kind: 'status', ok: true, fps: 4, width: 360, quality: 60, encoding: 'binary', window: 2,
    });
    assert.deepStrictEqual(whole.events[2], { kind: 'same', frame: 2, ts: 1002 });
    assert.deepStrictEqual(whole.events[4], { kind: 'soft-error', frame: 4, ts: 1004, error: 'cannot decode frame' });
    assert.deepStrictEqual(whole.events[6], { kind: 'pong', seq: 2, ts: 5555 });
  });

  it('keeps the payload bytes and image fields', () => {
    const f = whole.events[1];
    assert.ok(f.kind === 'frame');
    assert.deepStrictEqual(f.payload, P1);
    assert.deepStrictEqual([f.frame, f.ts, f.screen, f.size, f.format, f.cms, f.ems], [1, 1001, [720, 1600], [360, 800], 'jpeg', 20, 5]);
    assert.ok(!('bytes' in f));
    const payloads = whole.events.filter((e) => e.kind === 'frame').map((e) => (e.kind === 'frame' ? e.payload : null));
    assert.deepStrictEqual(payloads, [P1, P2, P3]);
  });

  it('gives the same events one byte at a time', () => {
    const r = feed(split(stream(), [1]));
    assert.strictEqual(r.parser.failed, undefined);
    assert.deepStrictEqual(r.events, whole.events);
  });

  it('gives the same events for seeded random splits', () => {
    for (const seed of [1, 2, 3, 42, 2024]) {
      const r = feed(split(stream(), seeded(seed, 64, 40)));
      assert.strictEqual(r.parser.failed, undefined, `seed ${seed}`);
      assert.deepStrictEqual(r.events, whole.events, `seed ${seed}`);
    }
  });

  it('formats acks and the request line', () => {
    assert.strictEqual(ackLine(12), '{"ack":12}\n');
    const line = mirrorRequestLine({ ...MIRROR_DEFAULTS, lease: 60 }, 'binary');
    assert.ok(line.endsWith('\n') && line.length < 4096);
    assert.deepStrictEqual(JSON.parse(line), {
      cmd: 'mirror', fps: 4, width: 360, quality: 60, encoding: 'binary', lease: 60,
    });
    assert.deepStrictEqual(JSON.parse(mirrorRequestLine({ ...MIRROR_DEFAULTS, lease: 60, adapt: true }, 'binary')), {
      cmd: 'mirror', fps: 4, width: 360, quality: 60, encoding: 'binary', lease: 60, adapt: true,
    });
    assert.deepStrictEqual(JSON.parse(mirrorRequestLine({ ...MIRROR_DEFAULTS, lease: 60, input: true }, 'binary')), {
      cmd: 'mirror', fps: 4, width: 360, quality: 60, encoding: 'binary', lease: 60, input: true,
    });
  });

  it('delivers the adaptive-quality header fields with the frame', () => {
    const { events, parser } = feed([
      Buffer.from(STATUS.replace('"window":2', '"window":2,"adapt":true')),
      image(1, P1, { q: 45, rtt: 80, ticks: 12, skips: 2 }),
    ]);
    assert.strictEqual(parser.failed, undefined);
    assert.ok(events[0].kind === 'status' && events[0].adapt === true);
    const f = events[1];
    assert.ok(f.kind === 'frame');
    assert.deepStrictEqual([f.q, f.rtt, f.ticks, f.skips], [45, 80, 12, 2]);
  });

  for (const h of [0, 1, 4097]) {
    it(`fails on a header length of ${h}`, () => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(h, 0);
      const { events, parser } = feed([Buffer.from(STATUS), len, Buffer.alloc(8, 0x20)]);
      assert.deepStrictEqual(events.map((e) => e.kind), ['status']);
      assert.strictEqual(parser.failed, 'corrupt stream');
    });
  }

  for (const bytes of [0, MIRROR_MAX_FRAME_BYTES + 1]) {
    it(`fails on bytes = ${bytes}`, () => {
      const rec = record({ frame: 1, ts: 1, screen: [1, 1], size: [1, 1], format: 'png', bytes });
      const { events, parser } = feed([Buffer.from(STATUS), rec]);
      assert.deepStrictEqual(events.map((e) => e.kind), ['status']);
      assert.strictEqual(parser.failed, 'corrupt stream');
    });
  }

  it('fails on a header with data instead of bytes', () => {
    const rec = record({ frame: 1, ts: 1, screen: [1, 1], size: [1, 1], format: 'png', data: 'AAAA' });
    assert.strictEqual(feed([Buffer.from(STATUS), rec]).parser.failed, 'corrupt stream');
  });

  it('fails on a header that is not a JSON object', () => {
    assert.strictEqual(feed([Buffer.from(STATUS), record('[1,2]')]).parser.failed, 'corrupt stream');
    assert.strictEqual(feed([Buffer.from(STATUS), record('not json')]).parser.failed, 'corrupt stream');
  });

  it('fails on a status line over 4096 bytes', () => {
    const { events, parser } = feed([Buffer.from('{"ok":true,"pad":"' + 'x'.repeat(5000)), Buffer.from('"}\n')]);
    assert.deepStrictEqual(events, []);
    assert.strictEqual(parser.failed, 'corrupt stream');
  });

  it('fails on a status line that is not a status', () => {
    assert.strictEqual(feed([Buffer.from('garbage\n')]).parser.failed, 'corrupt stream');
    assert.strictEqual(feed([Buffer.from('{"frame":1,"ts":2,"same":true}\n')]).parser.failed, 'corrupt stream');
  });

  it('fails on a text-mode status', () => {
    const { events, parser } = feed([
      Buffer.from('{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60}\n'),
    ]);
    assert.deepStrictEqual(events, []);
    assert.strictEqual(parser.failed, 'unexpected text stream');
  });

  it('returns a fatal first line as an event, then nothing', () => {
    const parser = new MirrorRecordParser();
    const events = parser.push(Buffer.from('{"ok":false,"error":"developer mode is off"}\n'));
    assert.deepStrictEqual(events, [{ kind: 'fatal', error: 'developer mode is off' }]);
    assert.ok(parser.failed);
    assert.deepStrictEqual(parser.push(Buffer.from(STATUS)), []);
  });

  it('returns a replaced record mid-stream as a fatal event', () => {
    const { events } = feed([
      Buffer.from(STATUS),
      image(1, P1),
      record({ ok: false, error: 'replaced' }),
      image(2, P2),
    ]);
    assert.deepStrictEqual(events.map((e) => e.kind), ['status', 'frame', 'fatal']);
    assert.deepStrictEqual(events[2], { kind: 'fatal', error: 'replaced' });
  });

  it('returns a lease expired record as fatal', () => {
    const { events } = feed([Buffer.from(STATUS), record({ ok: false, error: 'lease expired' })]);
    assert.deepStrictEqual(events[1], { kind: 'fatal', error: 'lease expired' });
  });

  it('returns nothing after a failure', () => {
    const parser = new MirrorRecordParser();
    parser.push(Buffer.from('garbage\n'));
    assert.ok(parser.failed);
    assert.deepStrictEqual(parser.push(stream()), []);
    assert.deepStrictEqual(parser.push(Buffer.from(STATUS)), []);
  });

  it('allocates one buffer for a 10 MB payload fed in 64 KB chunks', () => {
    const size = 10 * 1000 * 1000;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4096) payload[i] = i / 4096 % 251;
    const input = Buffer.concat([Buffer.from(STATUS), image(1, payload)]);
    const real = Buffer.allocUnsafe.bind(Buffer);
    const sizes: number[] = [];
    Buffer.allocUnsafe = (n: number) => {
      sizes.push(n);
      return real(n);
    };
    let events: MirrorEvent[];
    try {
      events = feed(split(input, [64 * 1024])).events;
    } finally {
      Buffer.allocUnsafe = (n: number) => real(n);
    }
    assert.deepStrictEqual(sizes.filter((n) => n >= 1_000_000), [size]);
    const f = events.find((e) => e.kind === 'frame');
    assert.ok(f && f.kind === 'frame');
    assert.ok(f.payload.equals(payload));
  });
});
