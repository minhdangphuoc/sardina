import * as assert from 'assert';
import * as vm from 'node:vm';
import * as fs from 'fs';
import * as path from 'path';
import {
  agentUpdateAvailable,
  agentUpdateNotice,
  bundledAgentVersion,
  staleAgentReason,
  ClockOffset,
  FpsMeter,
  KeepaliveTrace,
  KeepaliveSchedule,
  LEASE_SECONDS,
  LatestFrame,
  MIRROR_DEFAULTS,
  MIRROR_FORWARD_MIN_AGENT_VERSION,
  MIRROR_MIN_AGENT_VERSION,
  MIRROR_TIMING,
  agentSupportsForward,
  agentSupportsInput,
  agentSupportsMirror,
  agentSupportsPhoneState,
  compareVersions,
  isJpeg,
  keepaliveLine,
  latencyMs,
  mirrorHtml,
  mirrorRequestArgs,
  parseMirrorHeader,
  parseMirrorLine,
  screenIdle,
  logText,
  statusText,
  stripParts,
  detailRows,
  detailsCopyText,
  controlState,
  isStaleAgentReason,
  type MirrorStatus,
  MIRROR_RESTART_REASON,
  hasReasonText,
} from '../../../src/agent/mirrorCore';
import { MirrorRecordParser, mirrorRequestLine } from '../../../src/agent/mirrorWire';

describe('mirrorCore versions', () => {
  it('compares dotted numbers', () => {
    assert.strictEqual(compareVersions('1.0.0', '1.1.0'), -1);
    assert.strictEqual(compareVersions('1.1.0', '1.1.0'), 0);
    assert.strictEqual(compareVersions('1.10.0', '1.9.9'), 1);
    assert.strictEqual(compareVersions('1.1', '1.1.0'), 0);
    assert.strictEqual(compareVersions('2', '1.9.9'), 1);
  });
  it('treats non-numeric parts as 0', () => {
    assert.strictEqual(compareVersions('1.x.0', '1.0.0'), 0);
    assert.strictEqual(compareVersions('1.1.beta', '1.1.0'), 0);
  });
  it('gates mirror on 1.1.0', () => {
    assert.strictEqual(MIRROR_MIN_AGENT_VERSION, '1.1.0');
    assert.strictEqual(agentSupportsMirror('1.0.0'), false);
    assert.strictEqual(agentSupportsMirror('1.1.0'), true);
    assert.strictEqual(agentSupportsMirror('1.2.3'), true);
    assert.strictEqual(agentSupportsMirror(''), false);
  });
});

describe('mirrorCore.mirrorRequestArgs', () => {
  it('builds the agent argv', () => {
    assert.deepStrictEqual(mirrorRequestArgs(MIRROR_DEFAULTS), [
      'sailfish-devagent', '--request', 'mirror', '--fps', '4', '--width', '360', '--quality', '60',
    ]);
    assert.deepStrictEqual(mirrorRequestArgs({ fps: 2, width: 0, quality: 80 }).slice(3), [
      '--fps', '2', '--width', '0', '--quality', '80',
    ]);
  });
});

describe('mirrorCore.parseMirrorLine', () => {
  it('parses the status line', () => {
    assert.deepStrictEqual(parseMirrorLine('{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60}'), {
      kind: 'status', ok: true, fps: 4, width: 360, quality: 60,
    });
  });
  it('parses fatal lines', () => {
    assert.deepStrictEqual(parseMirrorLine('{"ok":false,"error":"replaced"}'), { kind: 'fatal', error: 'replaced' });
    assert.strictEqual(parseMirrorLine('{"ok":false}'), undefined);
  });
  it('parses frames', () => {
    const line = '{"frame":12,"ts":1791199286074,"screen":[720,1600],"size":[360,800],"format":"jpeg","data":"/9j/4AAQ=="}';
    assert.deepStrictEqual(parseMirrorLine(line + '\r'), {
      kind: 'frame', frame: 12, ts: 1791199286074, screen: [720, 1600], size: [360, 800], format: 'jpeg', data: '/9j/4AAQ==',
    });
  });
  it('parses same and soft-error lines', () => {
    assert.deepStrictEqual(parseMirrorLine('{"frame":13,"ts":5,"same":true}'), { kind: 'same', frame: 13, ts: 5 });
    assert.deepStrictEqual(parseMirrorLine('{"frame":14,"ts":6,"error":"cannot decode frame"}'), {
      kind: 'soft-error', frame: 14, ts: 6, error: 'cannot decode frame',
    });
  });
  it('rejects bad lines', () => {
    assert.strictEqual(parseMirrorLine(''), undefined);
    assert.strictEqual(parseMirrorLine('not json'), undefined);
    assert.strictEqual(parseMirrorLine('[1]'), undefined);
    assert.strictEqual(parseMirrorLine('{"frame":1}'), undefined);
    assert.strictEqual(parseMirrorLine('{"ok":true,"stream":"logs","fps":1,"width":1,"quality":1}'), undefined);
    assert.strictEqual(parseMirrorLine('{"frame":1,"ts":1,"screen":[1,1],"size":[1,1],"format":"gif","data":"AAAA"}'), undefined);
    assert.strictEqual(parseMirrorLine('{"frame":1,"ts":1,"screen":[1],"size":[1,1],"format":"png","data":"AAAA"}'), undefined);
  });
  it('rejects data outside the base64 charset', () => {
    assert.strictEqual(parseMirrorLine('{"frame":1,"ts":1,"screen":[1,1],"size":[1,1],"format":"png","data":"AA AA"}'), undefined);
    assert.strictEqual(parseMirrorLine('{"frame":1,"ts":1,"screen":[1,1],"size":[1,1],"format":"png","data":"<b>"}'), undefined);
    assert.strictEqual(parseMirrorLine('{"frame":1,"ts":1,"screen":[1,1],"size":[1,1],"format":"png","data":""}'), undefined);
  });
  it('rejects a line over 4 MB', () => {
    const data = 'A'.repeat(4 * 1024 * 1024 + 1);
    const line = `{"frame":1,"ts":1,"screen":[1,1],"size":[1,1],"format":"png","data":"${data}"}`;
    assert.strictEqual(parseMirrorLine(line), undefined);
  });
});

describe('mirrorCore.isJpeg', () => {
  it('checks the magic bytes', () => {
    assert.strictEqual(isJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true);
    assert.strictEqual(isJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
    assert.strictEqual(isJpeg(Buffer.from([0xff, 0xd8])), false);
  });
});

describe('mirrorCore.LatestFrame', () => {
  it('posts the first frame at once', () => {
    const g = new LatestFrame<number>();
    assert.strictEqual(g.offer(1), 1);
    assert.strictEqual(g.dropped, 0);
  });
  it('keeps only the newest pending frame and counts drops', () => {
    const g = new LatestFrame<number>();
    assert.strictEqual(g.offer(1), 1);
    assert.strictEqual(g.offer(2), undefined);
    assert.strictEqual(g.offer(3), undefined);
    assert.strictEqual(g.offer(4), undefined);
    assert.strictEqual(g.dropped, 2);
    assert.strictEqual(g.acked(), 4);
    assert.strictEqual(g.acked(), undefined);
  });
  it('keeps the pending frame in flight until acked', () => {
    const g = new LatestFrame<number>();
    g.offer(1);
    g.offer(2);
    assert.strictEqual(g.acked(), 2);
    assert.strictEqual(g.offer(3), undefined);
    assert.strictEqual(g.acked(), 3);
    assert.strictEqual(g.acked(), undefined);
    assert.strictEqual(g.offer(4), 4);
  });
});

describe('mirrorCore.FpsMeter', () => {
  it('counts frames in the last 3 seconds', () => {
    const m = new FpsMeter();
    assert.strictEqual(m.fps(0), 0);
    for (let t = 1000; t <= 3000; t += 250) m.tick(t);
    assert.strictEqual(m.fps(3000), 9 / 3);
    assert.strictEqual(m.fps(4100), 8 / 3);
    assert.strictEqual(m.fps(10000), 0);
  });
  it('does not spike when frames queued during a stall arrive at once', () => {
    const m = new FpsMeter();
    // 4 fps on the phone for 20 s, all delivered in the same millisecond after a stall.
    for (let i = 0; i < 80; i++) m.tick(50_000, 30_000 + i * 250);
    assert.ok(m.fps(50_000) <= 4.5, `fps ${m.fps(50_000)}`);
  });
  it('rate: a steady but jittery 30 fps reads steady (within 1 fps after the first second)', () => {
    const m = new FpsMeter();
    // Intervals of 17, 33 and 50 ms (whole display frames), 30 fps on average.
    const gaps = [33, 17, 50, 33, 33, 50, 17, 33];
    let t = 1000;
    const readings: number[] = [];
    for (let i = 0; i < 300; i++) {
      t += gaps[i % gaps.length];
      m.tick(t);
      if (i % 8 === 0 && t > 2500) readings.push(m.rate(t));
    }
    for (const r of readings) assert.ok(Math.abs(r - 30) <= 1, `rate ${r.toFixed(2)}`);
  });
  it('rate: a new run of activity is measured from its start, not diluted by the idle seconds before', () => {
    const m = new FpsMeter();
    for (let t = 0; t <= 1500; t += 33) m.tick(10_000 + t);
    const r = m.rate(11_500);
    assert.ok(r > 25 && r <= 31, `rate ${r.toFixed(2)}`);
    assert.strictEqual(m.fps(11_500) < 20, true, 'the raw 3 s count would read about 15');
  });
  it('rate: no frames reads 0', () => {
    const m = new FpsMeter();
    assert.strictEqual(m.rate(0), 0);
    m.tick(1000);
    assert.strictEqual(m.rate(10_000), 0);
  });
});

describe('mirrorCore.screenIdle', () => {
  it('is idle only when the agent said the screen is unchanged after the last change, for a second', () => {
    assert.strictEqual(screenIdle(undefined, undefined, 5000), false, 'nothing yet');
    assert.strictEqual(screenIdle(1000, undefined, 9000), false, 'no word from the agent: a stall is not idle');
    assert.strictEqual(screenIdle(1000, 1300, 1500), false, 'under a second since the change');
    assert.strictEqual(screenIdle(1000, 1300, 2000), true);
    assert.strictEqual(screenIdle(2500, 1300, 4000), false, 'a change came after the same');
    assert.strictEqual(screenIdle(undefined, 300, 400), true, 'a static screen from the start');
  });
});

describe('mirrorCore status strip', () => {
  const live: MirrorStatus = { state: 'live', transport: 'ssh', codec: 'vp8', fps: 29.6, kbps: 25.4, latencyMs: 24.6, frameMs: 19.2, dropped: 0, capture: 'native', paceFps: 30, video: { width: 720, height: 1584, targetKbps: 2000 } };

  it('normal: Live, 30 fps, no warning', () => {
    assert.deepStrictEqual(stripParts(live), { dot: 'live', label: 'Live', fps: '30 fps' });
    assert.strictEqual(statusText(live), 'Live · 30 fps');
    assert.strictEqual(statusText(live, true), 'Live · 30 fps · Control');
  });
  it('idle: the frame rate reads idle', () => {
    assert.deepStrictEqual(stripParts({ ...live, fps: 0.3, idle: true }), { dot: 'live', label: 'Live', fps: 'idle' });
  });
  it('weak link: reduced for link; slow phone: reduced for phone', () => {
    assert.strictEqual(stripParts({ ...live, fps: 12, video: { ...live.video!, reduced: true, reducedFor: ['link'] } }).warning, 'Reduced for link');
    assert.strictEqual(stripParts({ ...live, video: { ...live.video!, reduced: true } }).warning, 'Reduced for link');
    assert.strictEqual(stripParts({ ...live, fps: 15, video: { ...live.video!, reduced: true, reducedFor: ['cpu'] } }).warning, 'Reduced for phone');
    assert.strictEqual(stripParts({ state: 'live', image: { width: 270, height: 594, reduced: true, reducedFor: ['link'] } }).warning, 'Reduced for link');
    assert.strictEqual(stripParts({ ...live, video: { ...live.video!, reduced: false, reducedFor: ['cpu'] } }).warning, undefined);
  });
  it('offers a layout when a keypad is detected without one', () => {
    assert.deepStrictEqual(stripParts({ ...live, keypadHint: 'create' }), {
      dot: 'live', label: 'Live', fps: '30 fps', warning: 'Keypad detected', action: 'keypad',
    });
    assert.strictEqual(statusText({ ...live, keypadHint: 'create' }), 'Live · 30 fps · Keypad detected · Create layout');
  });
  it('offers Edit when the chosen layout file is missing, below every real warning', () => {
    assert.deepStrictEqual(stripParts({ ...live, keypadHint: 'missing' }), {
      dot: 'live', label: 'Live', fps: '30 fps', warning: 'Keypad layout missing', action: 'keypadEdit',
    });
    assert.strictEqual(stripParts({ ...live, keypadHint: 'create', softError: 'boom' }).warning, 'Phone error');
    assert.strictEqual(stripParts({ ...live, keypadHint: 'create', transport: 'sfdk' }).warning, 'Slow path');
  });
  it('hints at the missing input module last, below every other warning', () => {
    assert.deepStrictEqual(stripParts({ ...live, inputModuleMissing: true }), {
      dot: 'live', label: 'Live', fps: '30 fps', warning: 'Control needs the input module', action: 'installInput',
    });
    assert.strictEqual(statusText({ ...live, inputModuleMissing: true }), 'Live · 30 fps · Control needs the input module · Install');
    assert.strictEqual(stripParts({ ...live, inputModuleMissing: true, softError: 'boom' }).warning, 'Phone error');
  });
  it('old agent: Slow path with the update action; other sfdk reasons have no action', () => {
    const old: MirrorStatus = { state: 'live', transport: 'sfdk', fallbackReason: 'agent 1.1.0 — update for the fast mirror', fps: 4 };
    assert.deepStrictEqual(stripParts(old), { dot: 'live', label: 'Live', fps: '4 fps', warning: 'Slow path', action: 'update' });
    assert.deepStrictEqual(stripParts({ ...old, fallbackReason: 'ssh forward unavailable — auth' }), { dot: 'live', label: 'Live', fps: '4 fps', warning: 'Slow path' });
    assert.strictEqual(isStaleAgentReason('agent 1.1.0 — update for the fast mirror'), true);
    assert.strictEqual(isStaleAgentReason('auth'), false);
  });
  it('control: active, off on the phone, none', () => {
    assert.strictEqual(controlState(live, true), 'active');
    assert.strictEqual(controlState(live, false), 'none');
    assert.strictEqual(controlState({ ...live, controlOffReason: 'disabled on the phone' }, true), 'off');
    assert.strictEqual(controlState({ state: 'paused' }, true), 'none');
    assert.strictEqual(statusText({ ...live, controlOffReason: 'disabled on the phone' }), 'Live · 30 fps · Control off on phone');
  });
  it('paused and connecting', () => {
    assert.deepStrictEqual(stripParts({ state: 'paused' }), { dot: 'wait', label: 'Paused' });
    assert.deepStrictEqual(stripParts({ state: 'pausing' }), { dot: 'wait', label: 'Paused' });
    assert.deepStrictEqual(stripParts({ state: 'connecting' }), { dot: 'wait', label: 'Connecting…' });
    assert.strictEqual(stripParts({ state: 'connecting', reason: 'agent is being updated' }).label, 'Connecting… agent is being updated');
    assert.strictEqual(statusText({ state: 'paused' }), 'Paused');
  });
  it('disconnected: the reason text and the Reconnect action', () => {
    assert.deepStrictEqual(stripParts({ state: 'disconnected' }), { dot: 'down', label: 'Disconnected', action: 'reconnect' });
    assert.deepStrictEqual(stripParts({ state: 'disconnected', reason: 'lease expired' }), {
      dot: 'down',
      label: 'Disconnected: the device stopped the mirror because VS Code did not renew it in time (lease expired)',
      action: 'reconnect',
    });
    assert.strictEqual(stripParts({ state: 'ended', reason: 'x' }).action, 'reconnect');
    assert.strictEqual(stripParts({ state: 'disconnected', reason: 'x'.repeat(500) }).label, `Disconnected: ${'x'.repeat(300)}`);
  });
  it('shows at most one warning, by priority', () => {
    const all: MirrorStatus = {
      state: 'live', transport: 'sfdk', fallbackReason: 'agent 1.1.0 — update for the fast mirror', capture: 'native', dropped: 3, softError: 'oops',
      video: { width: 1, height: 1, reduced: true, reducedFor: ['cpu', 'link'] },
    };
    const warning = (s: MirrorStatus): string | undefined => stripParts(s).warning;
    assert.strictEqual(warning(all), 'Slow path');
    all.transport = 'ssh';
    assert.strictEqual(warning(all), 'Reduced for phone');
    all.video = { width: 1, height: 1, reduced: true, reducedFor: ['link'] };
    assert.strictEqual(warning(all), 'Reduced for link');
    all.video = undefined;
    assert.strictEqual(warning(all), '3 dropped');
    all.dropped = 0;
    assert.strictEqual(warning(all), 'Phone error');
    all.softError = undefined;
    assert.strictEqual(warning(all), undefined);
  });
});

describe('mirrorCore detailRows', () => {
  const rows = (s: MirrorStatus, active = false): Record<string, string> => Object.fromEntries(detailRows(s, active).map((r) => [r.label, r.value]));

  it('shows the phone idle mode only once the agent reported it', () => {
    assert.strictEqual(rows({ state: 'live' })['Idle mode'], undefined);
    assert.strictEqual(rows({ state: 'live', idleMode: true })['Idle mode'], 'on');
    assert.strictEqual(rows({ state: 'live', idleMode: false })['Idle mode'], 'off');
  });

  it('lists every field of a live VP8 stream', () => {
    assert.deepStrictEqual(
      rows({ state: 'live', transport: 'ssh', codec: 'vp8', fps: 29.84, paceFps: 30, kbps: 25.4, latencyMs: 24.6, frameMs: 19.2, dropped: 0, capture: 'native', touchIndicatorPath: 'phone', video: { width: 720, height: 1584, targetKbps: 2000 } }, true),
      {
        Transport: 'SSH forward',
        Video: 'VP8 · 720×1584 · 2000 kbit/s',
        Received: '25 kbit/s',
        'Frame rate': '29.8 fps (phone paces 30)',
        Latency: '25 ms',
        'Phone time': '19 ms per frame',
        Capture: 'native recorder',
        Dropped: '0',
        Control: 'on',
        'Touch indicator': 'on phone',
      },
    );
  });
  it('names the image, the reductions, the sfdk fallback, the capture path, idle and control off', () => {
    const r = rows({
      state: 'live', transport: 'sfdk', fallbackReason: 'auth', codec: 'jpeg', idle: true, dropped: 2, capture: 'native',
      controlOffReason: 'disabled on the phone', softError: 'frame failed',
      image: { width: 270, height: 594, quality: 45, reduced: true, reducedFor: ['link', 'cpu'] },
    });
    assert.strictEqual(r.Transport, 'SDK connection (auth)');
    assert.strictEqual(r.Image, 'JPEG · 270×594 · q45 (reduced for the link and the phone CPU)');
    assert.strictEqual(r['Frame rate'], 'idle (no screen changes)');
    assert.strictEqual(r.Latency, '—');
    assert.strictEqual(r.Capture, 'native recorder');
    assert.strictEqual(r.Dropped, '2');
    assert.strictEqual(r.Control, 'off (disabled on the phone)');
    assert.strictEqual(r['Touch indicator'], 'off');
    assert.strictEqual(r['Phone error'], 'frame failed');
    assert.strictEqual(rows({ state: 'live', keypadHint: 'create' }).Keypad, 'detected · Create layout');
    assert.strictEqual(rows({ state: 'live', video: { width: 540, height: 1200, targetKbps: 800, reduced: true, reducedFor: ['cpu'] } }).Video, 'VP8 · 540×1200 · 800 kbit/s (reduced for the phone CPU)');
  });
  it('carries every value the log text can show', () => {
    const s: MirrorStatus = { state: 'live', transport: 'ssh', codec: 'vp8', fps: 24.7, kbps: 851.2, latencyMs: 41, frameMs: 18, dropped: 4, capture: 'native', video: { width: 720, height: 1600, targetKbps: 2000 } };
    const text = detailsCopyText(detailRows(s));
    for (const v of ['851 kbit/s', '24.7 fps', '41 ms', '18 ms', '720×1600', '2000 kbit/s', 'native recorder', '4']) assert.ok(text.includes(v), v);
    assert.ok(text.startsWith('Transport: SSH forward\nVideo: VP8'));
  });
  it('is a single State row when not live', () => {
    assert.deepStrictEqual(detailRows({ state: 'paused' }), [{ label: 'State', value: 'paused' }]);
  });
});

describe('mirrorCore.mirrorHtml', () => {
  const html = mirrorHtml('abc123', 'Xperia <10> & "co"');
  it('has the CSP meta with the nonce', () => {
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'nonce-abc123'; script-src 'nonce-abc123'">/);
  });
  it('puts the nonce on every script and style', () => {
    const tags = html.match(/<(script|style)\b[^>]*>/g) ?? [];
    assert.ok(tags.length >= 2);
    for (const t of tags) assert.ok(t.includes('nonce="abc123"'), t);
  });
  it('escapes the device name', () => {
    assert.ok(!html.includes('Xperia <10>'));
    assert.ok(html.includes('Xperia &lt;10&gt; &amp; &quot;co&quot;'));
  });
  it('has no inline event handlers or style attributes', () => {
    assert.ok(!/\son[a-z]+\s*=/i.test(html));
    assert.ok(!/\sstyle\s*=/i.test(html));
  });
});

describe('mirrorCore forward gate and lease', () => {
  it('gates the forward on 1.2.0', () => {
    assert.strictEqual(MIRROR_FORWARD_MIN_AGENT_VERSION, '1.2.0');
    assert.strictEqual(agentSupportsForward('1.1.0'), false);
    assert.strictEqual(agentSupportsForward('1.2.0'), true);
    assert.strictEqual(agentSupportsForward('1.10.0'), true);
    assert.strictEqual(agentSupportsForward(''), false);
  });
  it('gates input on both agent 1.7.0 and explicit tap/swipe capabilities', () => {
    assert.strictEqual(agentSupportsInput({ version: '1.6.0', mirrorInput: ['tap', 'swipe'] }), false);
    assert.strictEqual(agentSupportsInput({ version: '1.7.0' }), false);
    assert.strictEqual(agentSupportsInput({ version: '1.7.0', mirrorInput: ['tap'] }), false);
    assert.strictEqual(agentSupportsInput({ version: '1.7.0', mirrorInput: ['swipe'] }), false);
    assert.strictEqual(agentSupportsInput({ version: '1.7.0', mirrorInput: ['swipe', 'tap'] }), true);
  });
  it('formats the keepalive line', () => {
    assert.strictEqual(keepaliveLine(3), '{"keepalive":3}\n');
    assert.strictEqual(LEASE_SECONDS, 60);
  });
  it('appends --lease only when given', () => {
    const withLease = mirrorRequestArgs({ ...MIRROR_DEFAULTS, lease: 60 });
    assert.deepStrictEqual(withLease.slice(-2), ['--lease', '60']);
    assert.deepStrictEqual(withLease.slice(0, -2), mirrorRequestArgs(MIRROR_DEFAULTS));
  });
  it('appends --input only on an explicitly input-capable fallback', () => {
    assert.ok(!mirrorRequestArgs({ ...MIRROR_DEFAULTS, lease: 60 }).includes('--input'));
    assert.deepStrictEqual(mirrorRequestArgs({ ...MIRROR_DEFAULTS, lease: 60, input: true }).slice(-3), ['--lease', '60', '--input']);
    assert.deepStrictEqual(mirrorRequestArgs({ ...MIRROR_DEFAULTS, input: true }).slice(-1), ['--input']);
  });
  it('parses the lease expiry as fatal in both encodings', () => {
    const text = parseMirrorLine('{"ok":false,"error":"lease expired"}');
    assert.deepStrictEqual(text, { kind: 'fatal', error: 'lease expired' });
    assert.deepStrictEqual(parseMirrorHeader({ ok: false, error: 'lease expired' }, 'record'), text);
  });
});

describe('mirrorCore.KeepaliveSchedule', () => {
  interface Timer { fn: () => void; ms: number; cleared: boolean }
  function setup() {
    const timers: Timer[] = [];
    const sent: number[] = [];
    const fake = {
      setInterval: (fn: () => void, ms: number) => {
        const t: Timer = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearInterval: (h: unknown) => {
        (h as Timer).cleared = true;
      },
    };
    const schedule = new KeepaliveSchedule((seq) => sent.push(seq), fake);
    const active = () => timers.filter((t) => !t.cleared);
    return { timers, sent, schedule, active };
  }

  it('sends nothing before the status line', () => {
    const { sent, schedule, active } = setup();
    schedule.update({ streaming: false, visible: true });
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(active().length, 0);
  });
  it('sends at once, then on every interval', () => {
    const { sent, schedule, active } = setup();
    schedule.update({ streaming: true, visible: true });
    assert.deepStrictEqual(sent, [1]);
    assert.strictEqual(active().length, 1);
    assert.strictEqual(active()[0].ms, 20_000);
    active()[0].fn();
    active()[0].fn();
    assert.deepStrictEqual(sent, [1, 2, 3]);
    schedule.update({ streaming: true, visible: true });
    assert.deepStrictEqual(sent, [1, 2, 3]);
  });
  it('reads the interval from MIRROR_TIMING', () => {
    const saved = MIRROR_TIMING.keepaliveIntervalMs;
    MIRROR_TIMING.keepaliveIntervalMs = 500;
    try {
      const { schedule, active } = setup();
      schedule.update({ streaming: true, visible: true });
      assert.strictEqual(active()[0].ms, 500);
    } finally {
      MIRROR_TIMING.keepaliveIntervalMs = saved;
    }
  });
  it('stops when hidden and sends at once when visible again', () => {
    const { sent, schedule, active } = setup();
    schedule.update({ streaming: true, visible: true });
    schedule.update({ streaming: true, visible: false });
    assert.strictEqual(active().length, 0);
    assert.deepStrictEqual(sent, [1]);
    schedule.update({ streaming: true, visible: true });
    assert.deepStrictEqual(sent, [1, 2]);
    assert.strictEqual(active().length, 1);
  });
  it('stops on dispose and when streaming ends', () => {
    const a = setup();
    a.schedule.update({ streaming: true, visible: true });
    a.schedule.update({ streaming: false, visible: true });
    assert.strictEqual(a.active().length, 0);
    const b = setup();
    b.schedule.update({ streaming: true, visible: true });
    b.schedule.dispose();
    assert.strictEqual(b.active().length, 0);
    b.schedule.update({ streaming: true, visible: true });
    assert.deepStrictEqual(b.sent, [1]);
    assert.strictEqual(b.active().length, 0);
  });
  it('increases seq strictly across restarts', () => {
    const { sent, schedule } = setup();
    for (let i = 0; i < 3; i++) {
      schedule.update({ streaming: true, visible: true });
      schedule.update({ streaming: true, visible: false });
    }
    assert.deepStrictEqual(sent, [1, 2, 3]);
  });
});

describe('mirrorCore.ClockOffset and latencyMs', () => {
  it('has no offset before a pong', () => {
    assert.strictEqual(new ClockOffset().offsetMs, undefined);
  });
  it('computes the NTP-style offset', () => {
    const c = new ClockOffset();
    // sent 1000, received 1100 (rtt 100): device clock read 1050 + 5000 at the midpoint.
    c.addPong(1000, 6050, 1100);
    assert.strictEqual(c.offsetMs, 5000);
  });
  it('uses the sample with the smallest round trip', () => {
    const c = new ClockOffset();
    c.addPong(0, 5300, 400); // rtt 400, offset 5100
    c.addPong(1000, 6050, 1100); // rtt 100, offset 5000
    c.addPong(2000, 7400, 2600); // rtt 600, offset 5100
    assert.strictEqual(c.offsetMs, 5000);
  });
  it('prefers the newest of equal round trips and handles a single sample', () => {
    const c = new ClockOffset();
    c.addPong(0, 5050, 100);
    assert.strictEqual(c.offsetMs, 5000);
    c.addPong(1000, 6070, 1100);
    assert.strictEqual(c.offsetMs, 5020);
  });
  it('forgets samples older than the last 8', () => {
    const c = new ClockOffset();
    c.addPong(0, 5005, 10); // rtt 10, offset 5000
    for (let i = 1; i <= 7; i++) c.addPong(i * 1000, i * 1000 + 5000 + 100, i * 1000 + 200);
    assert.strictEqual(c.offsetMs, 5000);
    c.addPong(8000, 13100, 8200); // pushes out the rtt-10 sample
    assert.strictEqual(c.offsetMs, 5000); // rtt 200 samples, offset 5000 again
    const d = new ClockOffset();
    d.addPong(0, 9005, 10); // stale, wrong offset 9000
    for (let i = 1; i <= 8; i++) d.addPong(i * 1000, i * 1000 + 5100, i * 1000 + 200);
    assert.strictEqual(d.offsetMs, 5000);
  });
  it('is not skewed by pongs queued behind frames during a slow spell', () => {
    // Device is 5000 ahead; healthy link rtt 40, so latency of a frame is 80 ms.
    const c = new ClockOffset();
    for (let i = 0; i < 3; i++) c.addPong(i * 1000, i * 1000 + 5020, i * 1000 + 40);
    // Slow spell: the pong is answered at once but the reply queues for ~3 s behind frames.
    for (let i = 3; i < 8; i++) c.addPong(i * 1000, i * 1000 + 5020, i * 1000 + 3000);
    assert.strictEqual(c.offsetMs, 5000);
    // The old median of the last 5 would have given 5000 - 1480 = 3520 and latency 0.
    assert.strictEqual(latencyMs(10000, 5080, c.offsetMs as number), 80);
  });
  it('computes latency from the offset', () => {
    // frame stamped 10000 on the device clock, device is 5000 ahead: 5000 on the PC clock.
    assert.strictEqual(latencyMs(10000, 5080, 5000), 80);
    assert.strictEqual(latencyMs(10000, 4000, 5000), 0);
  });
});

describe('mirrorCore.logText (the long log form)', () => {
  it('shows live over ssh', () => {
    assert.strictEqual(
      logText({ state: 'live', transport: 'ssh', fps: 3.96, latencyMs: 84.6, frameMs: 31.2, dropped: 2 }),
      'live (ssh), 4.0 fps, latency 85 ms, phone 31 ms, 2 dropped',
    );
  });
  it('shows live over sfdk with the reason and no latency', () => {
    assert.strictEqual(
      logText({ state: 'live', transport: 'sfdk', fallbackReason: 'auth', fps: 2, dropped: 0 }),
      'live (sfdk: auth), 2.0 fps, latency —',
    );
    assert.strictEqual(logText({ state: 'live', transport: 'sfdk' }), 'live (sfdk), latency —');
  });
  it('shows the image size and quality, and when adaptive quality has reduced them', () => {
    assert.strictEqual(
      logText({ state: 'live', transport: 'ssh', fps: 4, latencyMs: 40, image: { width: 360, height: 793, quality: 60 } }),
      'live (ssh), 4.0 fps, latency 40 ms, image 360x793 q60',
    );
    assert.strictEqual(
      logText({ state: 'live', transport: 'ssh', fps: 4, image: { width: 270, height: 594, quality: 45, reduced: true }, dropped: 1 }),
      'live (ssh), 4.0 fps, latency —, image 270x594 q45 (reduced for the link), 1 dropped',
    );
    assert.strictEqual(logText({ state: 'live', image: { width: 720, height: 1600 } }), 'live, latency —, image 720x1600');
  });
  it('shows connecting and paused', () => {
    assert.strictEqual(logText({ state: 'connecting' }), 'connecting');
    assert.strictEqual(logText({ state: 'paused' }), 'paused');
    assert.strictEqual(logText({ state: 'pausing' }), 'paused');
  });
  it('shows each disconnect reason', () => {
    assert.strictEqual(logText({ state: 'disconnected' }), 'disconnected');
    assert.strictEqual(logText({ state: 'disconnected', reason: 'replaced' }), 'disconnected: replaced');
    assert.strictEqual(
      logText({ state: 'disconnected', reason: 'lease expired' }),
      'disconnected: the device stopped the mirror because VS Code did not renew it in time (lease expired)',
    );
    assert.strictEqual(
      logText({ state: 'disconnected', reason: 'ssh: connection lost' }),
      'disconnected: ssh: connection lost',
    );
    const long = 'x'.repeat(500);
    assert.strictEqual(logText({ state: 'disconnected', reason: long }), `disconnected: ${'x'.repeat(300)}`);
  });
});

describe('mirrorCore.parseMirrorHeader', () => {
  const base = { frame: 1, ts: 2, screen: [720, 1600], size: [360, 800], format: 'jpeg' };
  it('accepts a text frame and a record header', () => {
    assert.deepStrictEqual(parseMirrorHeader({ ...base, data: 'AAAA' }, 'line'), {
      kind: 'frame', frame: 1, ts: 2, screen: [720, 1600], size: [360, 800], format: 'jpeg', data: 'AAAA',
    });
    assert.deepStrictEqual(parseMirrorHeader({ ...base, bytes: 10, cms: 12, ems: 3 }, 'record'), {
      kind: 'frame', frame: 1, ts: 2, screen: [720, 1600], size: [360, 800], format: 'jpeg', bytes: 10, cms: 12, ems: 3,
    });
  });
  it('accepts input only with a valid focus lease and bounds a refusal reason', () => {
    const baseStatus = { ok: true, stream: 'mirror', fps: 4, width: 360, quality: 60 };
    assert.deepStrictEqual(parseMirrorHeader({ ...baseStatus, input: true, inputLease: 3 }, 'line'), {
      kind: 'status', ok: true, fps: 4, width: 360, quality: 60, input: true, inputLease: 3,
    });
    assert.deepStrictEqual(parseMirrorHeader({ ...baseStatus, input: false, inputError: 'input group unavailable' }, 'line'), {
      kind: 'status', ok: true, fps: 4, width: 360, quality: 60, input: false, inputError: 'input group unavailable',
    });
    assert.deepStrictEqual(parseMirrorHeader({ ...baseStatus, input: true, inputLease: 0 }, 'line'), {
      kind: 'status', ok: true, fps: 4, width: 360, quality: 60,
    });
    const long = parseMirrorHeader({ ...baseStatus, input: false, inputError: 'x'.repeat(500) }, 'line');
    assert.ok(long && long.kind === 'status' && long.inputError?.length === 300);
  });
  it('requires data in line mode and bytes in record mode', () => {
    assert.strictEqual(parseMirrorHeader({ ...base, bytes: 10 }, 'line'), undefined);
    assert.strictEqual(parseMirrorHeader({ ...base, data: 'AAAA' }, 'record'), undefined);
    assert.strictEqual(parseMirrorHeader({ ...base, bytes: 0 }, 'record'), undefined);
    assert.strictEqual(parseMirrorHeader({ ...base, bytes: 16 * 1024 * 1024 + 1 }, 'record'), undefined);
    assert.ok(parseMirrorHeader({ ...base, bytes: 16 * 1024 * 1024 }, 'record'));
  });
  it('rejects screen and size outside 1..10000', () => {
    for (const bad of [[0, 10], [10, 10001], [1.5, 10], [-1, 10]]) {
      assert.strictEqual(parseMirrorHeader({ ...base, screen: bad, bytes: 1 }, 'record'), undefined, String(bad));
      assert.strictEqual(parseMirrorHeader({ ...base, size: bad, bytes: 1 }, 'record'), undefined, String(bad));
    }
    assert.ok(parseMirrorHeader({ ...base, screen: [1, 10000], bytes: 1 }, 'record'));
  });
  it('clamps cms and ems to 0..60000', () => {
    const h = parseMirrorHeader({ ...base, bytes: 1, cms: -5, ems: 99999 }, 'record');
    assert.ok(h && h.kind === 'frame' && 'cms' in h);
    assert.strictEqual(h.cms, 0);
    assert.strictEqual(h.ems, 60000);
  });
  it('truncates errors to 300 characters', () => {
    const long = 'e'.repeat(400);
    assert.deepStrictEqual(parseMirrorHeader({ ok: false, error: long }, 'record'), { kind: 'fatal', error: 'e'.repeat(300) });
    assert.deepStrictEqual(parseMirrorHeader({ frame: 1, ts: 2, error: long }, 'line'), {
      kind: 'soft-error', frame: 1, ts: 2, error: 'e'.repeat(300),
    });
  });
  it('parses same, soft-error and pong in both modes', () => {
    for (const mode of ['line', 'record'] as const) {
      assert.deepStrictEqual(parseMirrorHeader({ frame: 3, ts: 4, same: true }, mode), { kind: 'same', frame: 3, ts: 4 });
      assert.deepStrictEqual(parseMirrorHeader({ pong: 7, ts: 99 }, mode), { kind: 'pong', seq: 7, ts: 99 });
    }
    assert.strictEqual(parseMirrorHeader({ pong: -1, ts: 99 }, 'line'), undefined);
    assert.strictEqual(parseMirrorHeader({ pong: 1 }, 'line'), undefined);
    assert.deepStrictEqual(parseMirrorLine('{"pong":2,"ts":5}'), { kind: 'pong', seq: 2, ts: 5 });
  });
  it('accepts the status line only in line mode and passes encoding, window and lease', () => {
    const o = { ok: true, stream: 'mirror', fps: 4, width: 360, quality: 60, encoding: 'binary', window: 2, lease: 60 };
    assert.deepStrictEqual(parseMirrorHeader(o, 'line'), {
      kind: 'status', ok: true, fps: 4, width: 360, quality: 60, encoding: 'binary', window: 2, lease: 60,
    });
    assert.strictEqual(parseMirrorHeader(o, 'record'), undefined);
  });
  it('passes adapt on the status line only when it is true', () => {
    const o = { ok: true, stream: 'mirror', fps: 4, width: 360, quality: 60, encoding: 'binary', window: 2 };
    assert.deepStrictEqual(parseMirrorHeader({ ...o, adapt: true }, 'line'), {
      kind: 'status', ok: true, fps: 4, width: 360, quality: 60, encoding: 'binary', window: 2, adapt: true,
    });
    const h = parseMirrorHeader({ ...o, adapt: 'yes' }, 'line');
    assert.ok(h && h.kind === 'status' && h.adapt === undefined);
  });
  it('passes the adaptive-quality fields of an image header (agent 1.4.0)', () => {
    assert.deepStrictEqual(parseMirrorHeader({ ...base, bytes: 10, q: 45, rtt: 120, rttFrame: 9, ticks: 40, skips: 3 }, 'record'), {
      kind: 'frame', frame: 1, ts: 2, screen: [720, 1600], size: [360, 800], format: 'jpeg', bytes: 10,
      q: 45, rtt: 120, rttFrame: 9, ticks: 40, skips: 3,
    });
    // rttFrame only together with rtt.
    const h = parseMirrorHeader({ ...base, bytes: 10, rttFrame: 9 }, 'record');
    assert.ok(h && h.kind === 'frame' && !('rttFrame' in h));
  });
  it('drops invalid adaptive-quality fields without failing the frame', () => {
    for (const bad of [{ q: 0 }, { q: 101 }, { q: 4.5 }, { q: '60' }, { ticks: 3 }, { ticks: 3, skips: 4 }, { ticks: -1, skips: 0 }, { ticks: 1.5, skips: 0 }]) {
      const h = parseMirrorHeader({ ...base, bytes: 10, ...bad }, 'record');
      assert.ok(h && h.kind === 'frame', JSON.stringify(bad));
      assert.ok(!('q' in h) && !('ticks' in h) && !('skips' in h), JSON.stringify(bad));
    }
    const h = parseMirrorHeader({ ...base, bytes: 10, rtt: 99999 }, 'record');
    assert.ok(h && h.kind === 'frame' && h.rtt === 60000);
  });
});

describe('mirrorCore.mirrorHtml (blob frames)', () => {
  const html = mirrorHtml('n', 'dev');

  type PageEvent = Record<string, unknown>;
  type PageListener = (event: PageEvent) => void;
  class FakeElement {
    constructor(readonly tagName = '') {}
    readonly listeners = new Map<string, PageListener[]>();
    readonly classes = new Set<string>();
    readonly classList = {
      toggle: (name: string, on: boolean) => on ? this.classes.add(name) : this.classes.delete(name),
      contains: (name: string) => this.classes.has(name),
    };
    textContent = '';
    hidden = false;
    className = '';
    title = '';
    children: FakeElement[] = [];
    readonly attributes = new Map<string, string>();
    focused = 0;
    width = 0;
    height = 0;
    src = '';
    type = '';
    disabled = false;
    readonly style: Record<string, string> = {};

    get firstChild(): FakeElement | undefined { return this.children[0]; }
    get childElementCount(): number { return this.children.length; }

    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    appendChild(child: FakeElement): void { this.children.push(child); }
    removeChild(child: FakeElement): void { this.children = this.children.filter((entry) => entry !== child); }
    querySelectorAll(selector: string): FakeElement[] {
      return this.children.flatMap((child) => [
        ...(selector === 'button' && child.tagName === 'button' ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    contains(other: unknown): boolean { return other === this; }
    focus(): void { this.focused++; }
    addEventListener(name: string, listener: PageListener): void {
      const list = this.listeners.get(name) ?? [];
      list.push(listener);
      this.listeners.set(name, list);
    }
    dispatch(name: string, event: PageEvent = {}): void {
      for (const listener of this.listeners.get(name) ?? []) listener(event);
    }
    getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
      return { left: 0, top: 0, width: 100, height: 200 };
    }
    getContext(): { drawImage: () => void } { return { drawImage: () => undefined }; }
    setPointerCapture(): void { /* test seam */ }
  }

  function page(videoDecoder?: unknown): {
    elements: Record<string, FakeElement>;
    messages: Record<string, unknown>[];
    send(message: object): void;
    window(name: string, event: PageEvent): void;
  } {
    const elements = Object.fromEntries(['screen', 'video', 'stage', 'touch', 'keypad', 'strip', 'dot', 'label', 'fps', 'fpsSep', 'warning', 'warningText', 'warnSep', 'reconnect', 'keypadLayout', 'update', 'control', 'info', 'details', 'detailsGrid', 'detailsClose', 'copyDetails'].map((id) => [id, new FakeElement()])) as Record<string, FakeElement>;
    elements.video.classes.add('hidden');
    elements.details.hidden = true;
    const messages: Record<string, unknown>[] = [];
    const windowListeners = new Map<string, PageListener[]>();
    const pageWindow = {
      addEventListener: (name: string, listener: PageListener) => {
        const list = windowListeners.get(name) ?? [];
        list.push(listener);
        windowListeners.set(name, list);
      },
    };
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(script);
    vm.runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => messages.push(message) }),
      document: { getElementById: (id: string) => elements[id], hasFocus: () => true, createElement: (tag: string) => new FakeElement(tag) },
      window: pageWindow,
      URL: { createObjectURL: () => `blob:${messages.length}`, revokeObjectURL: () => undefined },
      Blob: class {},
      VideoDecoder: videoDecoder,
      EncodedVideoChunk: class { constructor(readonly init: object) {} },
      performance: { now: () => 100 },
      setTimeout,
      clearTimeout,
      Promise,
      Map,
    });
    return {
      elements,
      messages,
      send: (message: object) => {
        for (const listener of windowListeners.get('message') ?? []) listener({ data: message });
      },
      window: (name: string, event: PageEvent) => {
        for (const listener of windowListeners.get(name) ?? []) listener(event);
      },
    };
  }
  it('allows blob images only', () => {
    assert.ok(html.includes("img-src blob:"));
    // No data: URLs (the page's `data:` property of an EncodedVideoChunk is not one).
    assert.ok(!/["'(]data:/.test(html));
    assert.ok(!/img-src[^;"]*data:/.test(html));
  });
  it('shows frames through Blob URLs and revokes them', () => {
    assert.ok(html.includes('createObjectURL'));
    assert.ok(html.includes('revokeObjectURL'));
    assert.ok(html.includes('m.bytes'));
    assert.ok(!html.includes('base64'));
  });
  it('maps pointer gestures from the visible image or canvas rectangle without unsafe DOM writes', () => {
    assert.ok(html.includes("stage.addEventListener('pointerdown'"));
    assert.ok(html.includes("stage.addEventListener('pointerup'"));
    assert.ok(html.includes('surface().getBoundingClientRect()'));
    assert.ok(html.includes("action: 'tap'"));
    assert.ok(html.includes("action: 'swipe'"));
    assert.ok(html.includes("type: 'focus', focused: false"));
    assert.ok(html.includes('document.hasFocus()'));
    assert.ok(!html.includes('innerHTML'));
  });
  it('does not use a failed JPEG for input mapping, but includes the loaded frame screen in a gesture', () => {
    const p = page();
    p.send({ type: 'control', enabled: true });
    p.send({ type: 'frame', frame: 1, format: 'jpeg', screen: [720, 1600], bytes: new Uint8Array([1]) });
    p.elements.screen.dispatch('error');
    const pointer = { button: 0, pointerId: 1, clientX: 50, clientY: 100, preventDefault: () => undefined };
    p.elements.stage.dispatch('pointerdown', pointer);
    p.elements.stage.dispatch('pointerup', pointer);
    assert.strictEqual(p.messages.some((m) => m.type === 'input'), false);

    p.send({ type: 'frame', frame: 2, format: 'jpeg', screen: [720, 1600], bytes: new Uint8Array([2]) });
    p.elements.screen.dispatch('load');
    p.elements.stage.dispatch('pointerdown', pointer);
    p.elements.stage.dispatch('pointerup', pointer);
    const input = p.messages.find((m) => m.type === 'input');
    assert.deepStrictEqual(input?.screen, [720, 1600]);
    assert.strictEqual(input?.frame, 2);
  });
  it('exposes keypad buttons without forwarding the physical keyboard or power', () => {
    assert.ok(html.includes("action: 'key'"));
    assert.ok(!html.includes('keyup'));
    assert.ok(!html.includes('power'));
    const p = page();
    p.send({ type: 'control', enabled: true });
    p.send({ type: 'keypad', layout: { rows: [[{ key: 'OK', label: 'OK', style: 'primary' }]] } });
    assert.strictEqual(p.elements.keypad.hidden, false);
    const button = p.elements.keypad.querySelectorAll('button')[0];
    const event = { button: 0, pointerId: 4, preventDefault: () => undefined };
    button.dispatch('pointerdown', event);
    button.dispatch('pointerup', event);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.messages.slice(-2))), [
      { type: 'input', action: 'key', key: 'OK', pressed: true },
      { type: 'input', action: 'key', key: 'OK', pressed: false },
    ]);
    // The only physical key handler closes the details popover on Escape and posts nothing.
    assert.strictEqual(html.match(/keydown/g)?.length, 1);
    assert.ok(html.includes("window.addEventListener('keydown', function (event) {\n    if (event.key === 'Escape' && detailsOpen()) setDetails(false, true);"));
  });

  it('draws fallback contacts over the displayed screen and hides them with the control gate', () => {
    const p = page();
    p.send({ type: 'control', enabled: true });
    p.send({ type: 'frame', frame: 2, format: 'jpeg', screen: [720, 1600], bytes: new Uint8Array([2]) });
    p.elements.screen.dispatch('load');
    p.send({ type: 'touchIndicator', path: 'mirror' });
    p.send({ type: 'contact', x: 360, y: 800, down: true, screen: [720, 1600] });
    assert.strictEqual(p.elements.touch.hidden, false);
    assert.strictEqual(p.elements.touch.style.opacity, '1');
    assert.ok(Number.parseFloat(p.elements.touch.style.left) > 49);
    assert.ok(Number.parseFloat(p.elements.touch.style.top) > 99);
    p.send({ type: 'contact', x: 360, y: 800, down: false, screen: [720, 1600] });
    assert.strictEqual(p.elements.touch.style.opacity, '0');
    p.send({ type: 'control', enabled: false });
    assert.strictEqual(p.elements.touch.hidden, true);
  });

  describe('status strip and details popover', () => {
    const live = {
      type: 'state',
      state: 'live',
      text: 'Live · 30 fps · Control',
      strip: { dot: 'live', label: 'Live', fps: '30 fps', warning: 'Reduced for link' },
      details: [{ label: 'Transport', value: 'SSH forward' }, { label: 'Latency', value: '25 ms' }],
      control: 'none',
    };
    it('renders dot, label, fps, one warning and the tooltip from a state message', () => {
      const p = page();
      p.send(live);
      const e = p.elements;
      assert.strictEqual(e.label.textContent, 'Live');
      assert.strictEqual(e.dot.className, 'live');
      assert.strictEqual(e.fps.textContent, '30 fps');
      assert.strictEqual(e.fps.hidden, false);
      assert.strictEqual(e.warningText.textContent, 'Reduced for link');
      assert.strictEqual(e.warning.hidden, false);
      assert.strictEqual(e.info.hidden, false);
      assert.strictEqual(e.strip.title, 'Live · 30 fps · Control');
      assert.strictEqual(e.reconnect.hidden, true);
      assert.strictEqual(e.update.hidden, true);
    });
    it('shows Reconnect when disconnected, Update agent on the slow path, and hides info without details', () => {
      const p = page();
      p.send({ type: 'state', state: 'disconnected', text: 'x', strip: { dot: 'down', label: 'Disconnected: replaced', action: 'reconnect' }, details: [], control: 'none' });
      assert.strictEqual(p.elements.reconnect.hidden, false);
      assert.strictEqual(p.elements.info.hidden, true);
      assert.strictEqual(p.elements.dot.className, 'down');
      assert.strictEqual(p.elements.fps.hidden, true);
      p.elements.reconnect.dispatch('click');
      assert.strictEqual(p.messages.filter((m) => m.type === 'reconnect').length, 1);
      p.send({ type: 'state', state: 'live', text: 'x', strip: { dot: 'live', label: 'Live', warning: 'Slow path', action: 'update' }, details: [], control: 'none' });
      assert.strictEqual(p.elements.update.hidden, false);
      assert.strictEqual(p.elements.reconnect.hidden, true);
      p.elements.update.dispatch('click');
      assert.ok(p.messages.some((m) => m.type === 'updateAgent'));
    });
    it('shows the keypad layout action and sends the edit request', () => {
      const p = page();
      p.send({ type: 'state', state: 'live', text: 'Live · Keypad detected', strip: { dot: 'live', label: 'Live', warning: 'Keypad detected', action: 'keypad' }, details: [{ label: 'Keypad', value: 'detected · Create layout' }], control: 'none' });
      assert.strictEqual(p.elements.keypadLayout.hidden, false);
      assert.strictEqual(p.elements.update.hidden, true);
      assert.strictEqual(p.elements.reconnect.hidden, true);
      p.elements.keypadLayout.dispatch('click');
      assert.ok(p.messages.some((m) => m.type === 'editKeypadLayout'));
      p.send(live);
      assert.strictEqual(p.elements.keypadLayout.hidden, true);
    });
    it('shows the control pill: active from the control message, off from the state message', () => {
      const p = page();
      p.send(live);
      assert.strictEqual(p.elements.control.hidden, true);
      p.send({ type: 'control', enabled: true });
      assert.strictEqual(p.elements.control.hidden, false);
      assert.strictEqual(p.elements.control.textContent, 'Control');
      p.send({ ...live, control: 'off' });
      assert.strictEqual(p.elements.control.textContent, 'Control off on phone');
      assert.ok(p.elements.control.classes.has('off'));
    });
    it('opens the popover from the info button, lists the rows, and closes by button, Escape and an outside click', () => {
      const p = page();
      p.send(live);
      const e = p.elements;
      assert.strictEqual(e.details.hidden, true);
      e.info.dispatch('click');
      assert.strictEqual(e.details.hidden, false);
      assert.strictEqual(e.info.attributes.get('aria-expanded'), 'true');
      assert.deepStrictEqual(e.detailsGrid.children.map((c) => c.textContent), ['Transport', 'SSH forward', 'Latency', '25 ms']);
      assert.strictEqual(e.detailsClose.focused, 1);
      e.detailsClose.dispatch('click');
      assert.strictEqual(e.details.hidden, true);
      assert.strictEqual(e.info.attributes.get('aria-expanded'), 'false');
      e.info.dispatch('click');
      p.window('keydown', { key: 'a' });
      assert.strictEqual(e.details.hidden, false);
      p.window('keydown', { key: 'Escape' });
      assert.strictEqual(e.details.hidden, true);
      e.info.dispatch('click');
      p.window('click', { target: e.details });
      assert.strictEqual(e.details.hidden, false);
      p.window('click', { target: e.stage });
      assert.strictEqual(e.details.hidden, true);
    });
    it('asks the host to copy the details and sends no text itself', () => {
      const p = page();
      p.send(live);
      p.elements.copyDetails.dispatch('click');
      assert.deepStrictEqual(p.messages.filter((m) => m.type === 'copyDetails').map((m) => Object.keys(m)), [['type']]);
    });
    it('keeps the CSP clean: no inline handlers, styles or HTML writes', () => {
      assert.ok(!/\son[a-z]+\s*=/i.test(html));
      assert.ok(!/\sstyle\s*=/i.test(html));
      assert.ok(!html.includes('innerHTML'));
      assert.ok(html.includes('aria-label="Mirror details"'));
      assert.ok(html.includes('aria-expanded="false"'));
    });
  });
});

describe('mirrorCore.KeepaliveTrace', () => {
  it('reports the time since the last keepalive that went out on time, not an overdue one after a stall', () => {
    const t = new KeepaliveTrace();
    assert.strictEqual(t.ageMs(0), undefined);
    t.record(1000);
    t.record(21_000);
    // The host stalled for 70 s; the overdue timer fires on resume.
    t.record(91_000);
    assert.strictEqual(t.ageMs(91_000), 70_000);
  });
  it('reads 0 right after a keepalive sent on schedule', () => {
    const t = new KeepaliveTrace();
    t.record(1000);
    t.record(21_000);
    assert.strictEqual(t.ageMs(21_000), 0);
  });
});

describe('bundled agent version', () => {
  it('takes the newest version among the RPM file names', () => {
    assert.strictEqual(
      bundledAgentVersion(['sailfish-devagent-1.4.0-1.aarch64.rpm', 'sailfish-devagent-1.10.0-1.aarch64.rpm', 'sailfish-devagent-1.9.2-3.i486.rpm', 'readme.txt']),
      '1.10.0',
    );
    assert.strictEqual(bundledAgentVersion(['other-1.0.0-1.i486.rpm']), undefined);
    assert.strictEqual(bundledAgentVersion(['sailfish-devagent-logs-1.11.0-1.i486.rpm', 'sailfish-devagent-input-1.11.0-1.i486.rpm']), undefined, 'module RPMs are not the agent');
    assert.strictEqual(bundledAgentVersion([]), undefined);
  });

  it('matches the RPMs actually shipped in media/agent', () => {
    const root = path.join(__dirname, '..', '..', '..', '..', 'media', 'agent');
    const versions = ['aarch64', 'armv7hl', 'i486'].map((a) => bundledAgentVersion(fs.readdirSync(path.join(root, a))));
    assert.ok(versions[0], 'an RPM ships');
    assert.deepStrictEqual(new Set(versions).size, 1, 'all architectures ship the same version');
  });

  it('flags only an older, parsable running version', () => {
    assert.strictEqual(agentUpdateAvailable('1.1.0', '1.4.0'), true);
    assert.strictEqual(agentUpdateAvailable('1.4.0', '1.4.0'), false);
    assert.strictEqual(agentUpdateAvailable('1.5.0', '1.4.0'), false);
    assert.strictEqual(agentUpdateAvailable('?', '1.4.0'), false);
    assert.strictEqual(agentUpdateAvailable('1.1.0', undefined), false);
  });

  it('words the notice and the strip reason', () => {
    assert.ok(agentUpdateNotice('phone', '1.1.0', '1.4.0').startsWith('Sailfish: the device agent on "phone" is 1.1.0; this extension includes 1.4.0 (faster mirror:'));
    assert.strictEqual(staleAgentReason('1.1.0'), 'agent 1.1.0 — update for the fast mirror');
    assert.strictEqual(
      logText({ state: 'live', transport: 'sfdk', fallbackReason: staleAgentReason('1.1.0') }).split(',')[0],
      'live (sfdk: agent 1.1.0 — update for the fast mirror)',
    );
  });
});

describe('capture path fields', () => {
  const base = { frame: 1, ts: 1, screen: [100, 200], size: [50, 100], format: 'jpeg', bytes: 10 };
  it('parses capture in records and lines and drops a reason', () => {
    const r = parseMirrorHeader({ ...base, capture: 'screenshot', captureReason: 'x' }, 'record');
    assert.ok(r && r.kind === 'frame');
    assert.strictEqual((r as { capture?: string }).capture, 'screenshot'); // agents before 1.10.5
    assert.strictEqual('captureReason' in r, false);
    const l = parseMirrorHeader({ ...base, bytes: undefined, data: 'AAAA', capture: 'native' }, 'line');
    assert.ok(l && l.kind === 'frame');
    assert.strictEqual((l as { capture?: string }).capture, 'native');
  });
  it('ignores unknown capture values', () => {
    const u = parseMirrorHeader({ ...base, capture: 'other' }, 'record') as { capture?: string };
    assert.strictEqual(u.capture, undefined);
    const n = parseMirrorHeader({ ...base, capture: 5 }, 'record') as { capture?: string };
    assert.strictEqual(n.capture, undefined);
  });
  it('shows the capture path in the strip only when reported', () => {
    assert.ok(logText({ state: 'live', capture: 'native' }).endsWith(', capture native'));
    assert.ok(!logText({ state: 'live', capture: 'screenshot' }).includes('screenshot'));
    assert.ok(!logText({ state: 'live' }).includes('capture'));
  });
});

describe('phone settings (agent 1.9.0)', () => {
  const record = (o: object): Buffer => {
    const h = Buffer.from(JSON.stringify(o));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(h.length);
    return Buffer.concat([len, h]);
  };
  const status = Buffer.from('{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60,"encoding":"binary"}\n');

  it('parses idleMode from the settings line and ignores a wrong type', () => {
    assert.deepStrictEqual(parseMirrorLine('{"settings":{"control":true,"idleMode":false}}'), { kind: 'settings', control: true, idleMode: false });
    assert.deepStrictEqual(parseMirrorLine('{"settings":{"idleMode":"no"}}'), { kind: 'settings' });
  });

  it('words the idle mode restart', () => {
    assert.strictEqual(MIRROR_RESTART_REASON, 'restarting: idle mode changed on the phone');
    assert.deepStrictEqual(parseMirrorLine(`{"ok":false,"error":"${MIRROR_RESTART_REASON}"}`), { kind: 'fatal', error: MIRROR_RESTART_REASON });
    assert.strictEqual(hasReasonText(MIRROR_RESTART_REASON), true);
    assert.deepStrictEqual(stripParts({ state: 'connecting', reason: 'mirroring is restarting' }), { dot: 'wait', label: 'Connecting… mirroring is restarting' });
  });

  it('parses a settings line without and with the input fields', () => {
    assert.deepStrictEqual(parseMirrorLine('{"settings":{"control":false,"touchIndicator":true,"touchIndicatorPath":"mirror"}}'), {
      kind: 'settings', control: false, touchIndicator: true, touchIndicatorPath: 'mirror',
    });
    assert.deepStrictEqual(
      parseMirrorLine('{"settings":{"control":false},"input":false,"inputError":"control disabled on the phone"}'),
      { kind: 'settings', control: false, input: false, inputError: 'control disabled on the phone' },
    );
    assert.deepStrictEqual(parseMirrorLine('{"settings":{"control":true},"input":true,"inputLease":3}'), {
      kind: 'settings', control: true, input: true, inputLease: 3,
    });
  });

  it('parses bounded fallback contacts and rejects malformed ones', () => {
    assert.deepStrictEqual(parseMirrorLine('{"contact":{"x":719,"y":1599,"down":true}}'), {
      kind: 'contact', x: 719, y: 1599, down: true,
    });
    for (const bad of [
      '{"contact":{"x":-1,"y":0,"down":true}}',
      '{"contact":{"x":1.5,"y":0,"down":true}}',
      '{"contact":{"x":0,"y":0,"down":"yes"}}',
      '{"contact":[]}',
    ]) assert.strictEqual(parseMirrorLine(bad), undefined, bad);
    assert.deepStrictEqual(parseMirrorHeader({ settings: { touchIndicatorPath: 'elsewhere' } }, 'record'), { kind: 'settings' });
  });

  it('keeps input off without a valid lease, drops wrong types and sanitizes the reason', () => {
    assert.deepStrictEqual(parseMirrorHeader({ settings: { control: 'no' }, input: true }, 'record'), { kind: 'settings', input: false });
    assert.deepStrictEqual(parseMirrorHeader({ settings: {}, input: true, inputLease: 99 }, 'record'), { kind: 'settings', input: false });
    const r = parseMirrorHeader({ settings: {}, input: false, inputError: `a\nb\u0000${'x'.repeat(400)}` }, 'record');
    assert.ok(r && r.kind === 'settings' && r.inputError !== undefined && !/[\u0000-\u001f]/.test(r.inputError) && r.inputError.length <= 300);
    assert.strictEqual(parseMirrorHeader({ settings: [] }, 'record'), undefined);
    assert.strictEqual(parseMirrorHeader({ settings: 3 }, 'line'), undefined);
  });

  it('delivers a settings record after the status and rejects an oversized object', () => {
    const p = new MirrorRecordParser();
    const events = p.push(Buffer.concat([
      status,
      record({ settings: { control: false }, input: false, inputError: 'control disabled on the phone' }),
      record({ contact: { x: 4, y: 5, down: false } }),
    ]));
    assert.deepStrictEqual(events.map((e) => e.kind), ['status', 'settings', 'contact']);
    const big = new MirrorRecordParser();
    big.push(Buffer.concat([status, record({ settings: { control: false }, pad: 'x'.repeat(5000) })]));
    assert.ok(big.failed);
    assert.strictEqual(parseMirrorLine(`{"settings":{"control":false},"pad":"${'x'.repeat(5000)}"}`), undefined);
  });

  it('shows the control-off part in the live strip only when asked', () => {
    assert.strictEqual(
      logText({ state: 'live', transport: 'ssh', controlOffReason: 'disabled on the phone' }),
      'live (ssh), latency —, control off (disabled on the phone)',
    );
    assert.ok(!logText({ state: 'live', transport: 'ssh' }).includes('control'));
  });

  it('words the two new fatal reasons', () => {
    assert.strictEqual(
      logText({ state: 'disconnected', reason: 'screen view disabled on the phone' }),
      'disconnected: screen view is disabled on the phone (Settings › System › Developer agent)',
    );
    assert.strictEqual(
      logText({ state: 'disconnected', reason: 'stopped from the phone' }),
      'disconnected: stopped from the phone (Settings › System › Developer agent)',
    );
  });

  it('adds phoneState and client to the request line and argv only when asked', () => {
    const o = { ...MIRROR_DEFAULTS, lease: 60, input: true };
    assert.deepStrictEqual((JSON.parse(mirrorRequestLine(o, 'binary')) as { phoneState?: boolean }).phoneState, undefined);
    assert.strictEqual('client' in JSON.parse(mirrorRequestLine(o, 'binary')), false);
    const on = JSON.parse(mirrorRequestLine({ ...o, phoneState: true, client: 'my host (1).local' }, 'vp8')) as { phoneState?: boolean; client?: string };
    assert.strictEqual(on.phoneState, true);
    assert.strictEqual(on.client, 'my host 1.local');
    assert.strictEqual('client' in JSON.parse(mirrorRequestLine({ ...o, client: '()' }, 'binary')), false);
    assert.ok(!mirrorRequestArgs(o).includes('--phone-state') && !mirrorRequestArgs(o).includes('--client'));
    assert.deepStrictEqual(mirrorRequestArgs({ ...o, phoneState: true, client: 'my host (1).local' }).slice(-3), [
      '--phone-state', '--client', 'my-host-1.local',
    ]);
  });

  it('gates phone state on agent 1.9.0', () => {
    assert.strictEqual(agentSupportsPhoneState('1.8.1'), false);
    assert.strictEqual(agentSupportsPhoneState('1.9.0'), true);
  });
});
