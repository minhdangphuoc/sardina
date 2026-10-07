import * as assert from 'assert';
import { mirrorHtml } from '../../../src/agent/mirrorCore';
import {
  InputFocusSchedule,
  InputRateLimiter,
  MAX_SWIPE_MS,
  MIN_SWIPE_MS,
  MIRROR_INPUT_RATE,
  MIRROR_INPUT_TIMING,
  captureAllowsInput,
  inputLine,
  mapGesture,
  parseWebviewFocus,
  parseWebviewGesture,
  phoneInputAccepted,
  supportsLiveContacts,
} from '../../../src/agent/mirrorInput';

describe('mirrorInput webview validation and mapping', () => {
  const screen: [number, number] = [720, 1600];

  it('accepts only exact tap and swipe messages', () => {
    assert.deepStrictEqual(parseWebviewGesture({ type: 'input', action: 'tap', frame: 4, screen, x: 0.25, y: 0.75 }), {
      type: 'tap', frame: 4, screen, x: 0.25, y: 0.75,
    });
    assert.deepStrictEqual(
      parseWebviewGesture({ type: 'input', action: 'swipe', frame: 5, screen, x1: 0, y1: 1, x2: 1, y2: 0, duration: 321.4 }),
      { type: 'swipe', frame: 5, screen, x1: 0, y1: 1, x2: 1, y2: 0, duration: 321 },
    );
    assert.strictEqual(parseWebviewGesture({ type: 'input', action: 'tap', frame: 1, screen, x: 0, y: 0, extra: true }), undefined);
  });

  it('strictly parses and maps live down, diagonal move and coordinate-free release', () => {
    const down = parseWebviewGesture({ type: 'input', action: 'down', frame: 7, screen, x: 0.125, y: 0.25 });
    const move = parseWebviewGesture({ type: 'input', action: 'move', frame: 7, screen, x: 0.875, y: 0.75 });
    const up = parseWebviewGesture({ type: 'input', action: 'up', frame: 7, screen });
    assert.deepStrictEqual(down, { type: 'down', frame: 7, screen, x: 0.125, y: 0.25 });
    assert.deepStrictEqual(move, { type: 'move', frame: 7, screen, x: 0.875, y: 0.75 });
    assert.deepStrictEqual(up, { type: 'up', frame: 7, screen });
    assert.ok(down && move && up);
    assert.deepStrictEqual(mapGesture(down, screen), { type: 'down', x: 90, y: 400 });
    assert.deepStrictEqual(mapGesture(move, screen), { type: 'move', x: 629, y: 1199 });
    assert.deepStrictEqual(mapGesture(up, screen), { type: 'up' });
    assert.deepStrictEqual(mapGesture(up, [0, 0]), { type: 'up' }, 'release never depends on current screen geometry');
    assert.strictEqual(parseWebviewGesture({ type: 'input', action: 'up', frame: 7, screen, x: 1 }), undefined);
  });

  it('keeps both axes of diagonal paths independent from edge to edge', () => {
    const cases = [
      { x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.8 },
      { x1: 0.9, y1: 0.2, x2: 0.1, y2: 0.8 },
    ];
    for (const c of cases) {
      const gesture = parseWebviewGesture({ type: 'input', action: 'swipe', frame: 8, screen, ...c, duration: 600 });
      assert.ok(gesture && gesture.type === 'swipe');
      const mapped = mapGesture(gesture, screen);
      assert.ok(mapped && mapped.type === 'swipe');
      assert.notStrictEqual(mapped.x1, mapped.x2, 'x changes');
      assert.notStrictEqual(mapped.y1, mapped.y2, 'y changes');
      assert.deepStrictEqual(mapped, {
        type: 'swipe',
        x1: Math.round(c.x1 * 719), y1: Math.round(c.y1 * 1599),
        x2: Math.round(c.x2 * 719), y2: Math.round(c.y2 * 1599),
        duration: 600,
      });
    }
  });

  it('requires all three advertised capabilities before using live contacts', () => {
    assert.strictEqual(supportsLiveContacts(undefined), false);
    assert.strictEqual(supportsLiveContacts(['tap', 'swipe']), false);
    assert.strictEqual(supportsLiveContacts(['tap', 'swipe', 'down', 'move']), false);
    assert.strictEqual(supportsLiveContacts(['tap', 'swipe', 'down', 'move', 'up']), true);
  });

  it('wires live contacts into the page while retaining the release-time fallback', () => {
    const html = mirrorHtml('nonce', 'phone');
    assert.ok(html.includes("stage.addEventListener('pointermove'"));
    assert.ok(html.includes("postContact('down', pointer, p)"));
    assert.ok(html.includes("postContact('move', held, p)"));
    assert.ok(html.includes("postContact('up', held)"));
    assert.ok(html.includes('now - held.lastMoveAt < 75'));
    assert.ok(html.includes("action: 'tap'"));
    assert.ok(html.includes("action: 'swipe'"));
    const cancel = html.slice(html.indexOf('function cancelPointer()'), html.indexOf("stage.addEventListener('pointerdown'"));
    assert.ok(cancel.indexOf("postContact('up', held)") < cancel.indexOf('pointer = null'));
  });

  it('accepts only an exact boolean focus signal', () => {
    assert.strictEqual(parseWebviewFocus({ type: 'focus', focused: true }), true);
    assert.strictEqual(parseWebviewFocus({ type: 'focus', focused: false }), false);
    assert.strictEqual(parseWebviewFocus({ type: 'focus', focused: 1 }), undefined);
    assert.strictEqual(parseWebviewFocus({ type: 'focus', focused: true, extra: true }), undefined);
  });

  it('rejects malformed, non-finite, out-of-picture and dangerous action messages', () => {
    const bad: unknown[] = [
      null, [], { type: 'input' },
      { type: 'input', action: 'tap', frame: -1, screen, x: 0, y: 0 },
      { type: 'input', action: 'tap', frame: 1.5, screen, x: 0, y: 0 },
      { type: 'input', action: 'tap', frame: 1, screen: [720], x: 0, y: 0 },
      { type: 'input', action: 'tap', frame: 1, screen: [720, 0], x: 0, y: 0 },
      { type: 'input', action: 'tap', frame: 1, screen, x: -0.01, y: 0 },
      { type: 'input', action: 'tap', frame: 1, screen, x: 0, y: 1.01 },
      { type: 'input', action: 'tap', frame: 1, screen, x: Number.NaN, y: 0 },
      { type: 'input', action: 'down', frame: 1, screen, x: 0, y: Number.NaN },
      { type: 'input', action: 'move', frame: 1, screen, x: 1.01, y: 0 },
      { type: 'input', action: 'swipe', frame: 1, screen, x1: 0, y1: 0, x2: 1, y2: Infinity, duration: 100 },
      { type: 'input', action: 'swipe', frame: 1, screen, x1: 0, y1: 0, x2: 1, y2: 1, duration: '100' },
      { type: 'input', action: 'key', frame: 1, key: 'power' },
      { type: 'input', action: 'power', frame: 1 },
    ];
    for (const m of bad) assert.strictEqual(parseWebviewGesture(m), undefined, JSON.stringify(m));
  });

  it('clamps swipe duration and maps against real screen dimensions in either rotation', () => {
    const short = parseWebviewGesture({ type: 'input', action: 'swipe', frame: 1, screen, x1: 0, y1: 0, x2: 1, y2: 1, duration: -999 });
    const long = parseWebviewGesture({ type: 'input', action: 'swipe', frame: 1, screen, x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5, duration: 99999 });
    assert.ok(short && short.type === 'swipe' && short.duration === MIN_SWIPE_MS);
    assert.ok(long && long.type === 'swipe' && long.duration === MAX_SWIPE_MS);
    assert.deepStrictEqual(mapGesture({ type: 'tap', frame: 1, screen, x: 0.5, y: 0.5 }, [720, 1600]), { type: 'tap', x: 360, y: 800 });
    assert.deepStrictEqual(mapGesture({ type: 'tap', frame: 2, screen: [1600, 720], x: 0.5, y: 0.5 }, [1600, 720]), { type: 'tap', x: 800, y: 360 });
    assert.deepStrictEqual(mapGesture(short, [720, 1600]), {
      type: 'swipe', x1: 0, y1: 0, x2: 719, y2: 1599, duration: MIN_SWIPE_MS,
    });
  });

  it('rejects invalid screen headers and emits only the fixed upstream shapes', () => {
    assert.strictEqual(mapGesture({ type: 'tap', frame: 1, screen, x: 0, y: 0 }, [0, 1600]), undefined);
    assert.strictEqual(mapGesture({ type: 'tap', frame: 1, screen, x: 0, y: 0 }, [720, 10001]), undefined);
    assert.strictEqual(inputLine({ type: 'tap', x: 2, y: 3 }), '{"input":{"type":"tap","x":2,"y":3}}\n');
    assert.strictEqual(
      inputLine({ type: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, duration: 50 }),
      '{"input":{"type":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"duration":50}}\n',
    );
    assert.strictEqual(inputLine({ type: 'active', active: false }), '{"input":{"type":"active","active":false}}\n');
    assert.strictEqual(inputLine({ type: 'down', x: 2, y: 3 }), '{"input":{"type":"down","x":2,"y":3}}\n');
    assert.strictEqual(inputLine({ type: 'move', x: 4, y: 5 }), '{"input":{"type":"move","x":4,"y":5}}\n');
    assert.strictEqual(inputLine({ type: 'up' }), '{"input":{"type":"up"}}\n');
  });
});

describe('mirrorInput focus lease and rate limit', () => {
  interface Timer { fn: () => void; ms: number; cleared: boolean }
  function focusSchedule() {
    const timers: Timer[] = [];
    const sent: boolean[] = [];
    const schedule = new InputFocusSchedule((active) => sent.push(active), {
      setInterval: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearInterval: (h) => { (h as Timer).cleared = true; },
    });
    return { schedule, sent, timers, active: () => timers.filter((t) => !t.cleared) };
  }

  it('renews every second and sends false immediately on blur/hide', () => {
    const f = focusSchedule();
    f.schedule.update(true);
    assert.deepStrictEqual(f.sent, [true]);
    assert.strictEqual(f.active()[0].ms, MIRROR_INPUT_TIMING.activeIntervalMs);
    f.active()[0].fn();
    assert.deepStrictEqual(f.sent, [true, true]);
    f.schedule.update(false);
    assert.deepStrictEqual(f.sent, [true, true, false]);
    assert.strictEqual(f.active().length, 0);
  });

  it('keeps the focus lease alive throughout one- and three-second held contacts', () => {
    for (const heldMs of [1000, 3000]) {
      const f = focusSchedule();
      f.schedule.update(true);
      for (let elapsed = MIRROR_INPUT_TIMING.activeIntervalMs; elapsed <= heldMs; elapsed += MIRROR_INPUT_TIMING.activeIntervalMs) {
        f.active()[0].fn();
      }
      assert.deepStrictEqual(f.sent, new Array(heldMs / MIRROR_INPUT_TIMING.activeIntervalMs + 1).fill(true));
      assert.strictEqual(f.active().length, 1, `${heldMs} ms hold keeps its renewal timer`);
    }
  });

  it('always sends the safety-off on dispose and never restarts', () => {
    const f = focusSchedule();
    f.schedule.dispose();
    assert.deepStrictEqual(f.sent, [false]);
    f.schedule.update(true);
    assert.deepStrictEqual(f.sent, [false]);
    const g = focusSchedule();
    g.schedule.update(true);
    g.schedule.dispose();
    assert.deepStrictEqual(g.sent, [true, false]);
  });

  it('stops focus renewal on phone input:false and restarts only after a complete input:true state', () => {
    const f = focusSchedule();
    let accepted = phoneInputAccepted(true, true, 3);
    f.schedule.update(accepted);
    assert.deepStrictEqual(f.sent, [true]);
    accepted = phoneInputAccepted(true, false, undefined);
    f.schedule.update(accepted);
    assert.deepStrictEqual(f.sent, [true, false]);
    assert.strictEqual(f.active().length, 0, 'no renewal survives the phone refusal');
    assert.strictEqual(phoneInputAccepted(true, true, undefined), false, 'input:true without its lease stays off');
    accepted = phoneInputAccepted(true, true, 3);
    f.schedule.update(accepted);
    assert.deepStrictEqual(f.sent, [true, false, true]);
    assert.strictEqual(f.active().length, 1);
  });

  it('allows at most the configured number of gesture attempts per rolling second', () => {
    const r = new InputRateLimiter();
    for (let i = 0; i < MIRROR_INPUT_RATE.maxPerSecond; i++) assert.strictEqual(r.allow(i), true);
    assert.strictEqual(r.allow(999), false);
    assert.strictEqual(r.allow(1000), true);
  });

  it('allows control only for frames explicitly reported as native capture', () => {
    assert.strictEqual(captureAllowsInput('native'), true);
    assert.strictEqual(captureAllowsInput('screenshot'), false);
    assert.strictEqual(captureAllowsInput(undefined), false, 'older/unreported capture stays view-only');
  });
});
