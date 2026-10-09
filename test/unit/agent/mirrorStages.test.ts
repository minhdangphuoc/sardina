import * as assert from 'assert';
import {
  detailRows,
  isRestartReason,
  paceFpsOf,
  hasReasonText,
  MIRROR_FPS_RESTART_REASON,
  MIRROR_RESTART_REASON,
  parseMirrorHeader,
  parseMirrorLine,
  StageMeter,
  stagesText,
  type MirrorRecordHeader,
  type MirrorStatus,
} from '../../../src/agent/mirrorCore';
import { parsePhoneSettings } from '../../../src/agent/agentCore';
import { MirrorRecordParser } from '../../../src/agent/mirrorWire';

const VP8 = { frame: 7, ts: 1000, screen: [720, 1584], size: [720, 1584], format: 'vp8', key: false, pts: 5, bytes: 100, ems: 15, cvms: 6 };

describe('mirror stage times (agent 1.10.7)', () => {
  it('parses the stage fields of a VP8 header', () => {
    const h = parseMirrorHeader({ ...VP8, hms: 17, wms: 30, rbms: 25, cnms: 6, enms: 9, sdms: 1 }, 'record') as MirrorRecordHeader;
    assert.deepStrictEqual(h.stages, { hold: 17, wait: 30, readback: 25, convert: 6, encode: 9, send: 1 });
  });

  it('an older agent sends none: no stages; a malformed one is dropped, the frame is kept', () => {
    assert.strictEqual((parseMirrorHeader(VP8, 'record') as MirrorRecordHeader).stages, undefined);
    const h = parseMirrorHeader({ ...VP8, wms: 'x', rbms: 25, enms: -4 }, 'record') as MirrorRecordHeader;
    assert.strictEqual(h.kind, 'frame');
    assert.deepStrictEqual(h.stages, { readback: 25, encode: 0 });
  });

  it('JPEG frames never carry stages', () => {
    const h = parseMirrorHeader({ ...VP8, format: 'jpeg', key: undefined, pts: undefined, wms: 30 }, 'record') as MirrorRecordHeader;
    assert.strictEqual(h.stages, undefined);
  });

  it('words the row and leaves out what was not measured', () => {
    assert.strictEqual(stagesText({ hold: 17.4, wait: 30, readback: 25, convert: 6, encode: 9.6, send: 1 }), 'hold 17 · capture 30 · readback 25 · convert 6 · encode 10 · send 1 ms');
    assert.strictEqual(stagesText({ wait: 40, convert: 6, encode: 9 }), 'capture 40 · convert 6 · encode 9 ms');
    assert.strictEqual(stagesText({}), undefined);
    assert.strictEqual(stagesText(undefined), undefined);
  });

  it('StageMeter: medians over the last 3 s and the captured frame rate', () => {
    const m = new StageMeter();
    assert.strictEqual(m.stages(0), undefined);
    assert.strictEqual(m.fps(0), undefined);
    for (let i = 0; i < 20; i++) m.add(i * 50, { wait: i % 2 ? 30 : 50, encode: 9, readback: i === 3 ? 500 : 20 });
    assert.deepStrictEqual(m.stages(950), { wait: 50, readback: 20, encode: 9 });
    assert.ok(Math.abs((m.fps(950) as number) - 20) < 1e-9);
    // Old samples fall out of the window.
    assert.strictEqual(m.stages(10_000), undefined);
    m.clear();
    assert.strictEqual(m.stages(950), undefined);
  });

  it('details: Stages, Captured and Frame rate limit rows only when known', () => {
    const rows = (s: MirrorStatus): Record<string, string> => Object.fromEntries(detailRows(s).map((r) => [r.label, r.value]));
    const none = rows({ state: 'live', fps: 30 });
    assert.strictEqual(none.Stages, undefined);
    assert.strictEqual(none.Captured, undefined);
    assert.strictEqual(none['Frame rate limit'], undefined);
    const r = rows({ state: 'live', fps: 30, maxFps: 60, capturedFps: 18.04, stages: { wait: 40, convert: 6, encode: 9, send: 1 } });
    assert.strictEqual(r.Stages, 'capture 40 · convert 6 · encode 9 · send 1 ms');
    assert.strictEqual(r.Captured, '18.0 fps');
    assert.strictEqual(r['Frame rate limit'], '60');
    const labels = detailRows({ state: 'live', frameMs: 15, stages: { wait: 1 }, maxFps: 30, idleMode: true }).map((x) => x.label);
    assert.ok(labels.indexOf('Stages') === labels.indexOf('Phone time') + 1, labels.join());
  });
});

describe('frame rate limit (agent 1.10.7)', () => {
  it('reads maxFps from the settings line: 30 or 60 only', () => {
    assert.deepStrictEqual(parseMirrorLine('{"settings":{"idleMode":true,"maxFps":60}}'), { kind: 'settings', idleMode: true, maxFps: 60 });
    assert.deepStrictEqual(parseMirrorLine('{"settings":{"maxFps":30}}'), { kind: 'settings', maxFps: 30 });
    for (const bad of ['45', '"60"', '0', 'true']) {
      assert.deepStrictEqual(parseMirrorLine(`{"settings":{"maxFps":${bad}}}`), { kind: 'settings' }, bad);
    }
  });

  it('reads maxFps from ping settings: 30 or 60 only', () => {
    assert.deepStrictEqual(parsePhoneSettings({ maxFps: 60 }), { maxFps: 60 });
    assert.deepStrictEqual(parsePhoneSettings({ maxFps: 120 }), {});
    assert.deepStrictEqual(parsePhoneSettings({ maxFps: '30' }), {});
  });

  it('a frame rate limit change restarts the mirror like the idle mode', () => {
    assert.strictEqual(MIRROR_FPS_RESTART_REASON, 'restarting: frame rate limit changed on the phone');
    assert.ok(isRestartReason(MIRROR_FPS_RESTART_REASON));
    assert.ok(isRestartReason(MIRROR_RESTART_REASON));
    assert.ok(!isRestartReason('restarting: something else'));
    assert.ok(!isRestartReason('lease expired'));
    assert.ok(hasReasonText(MIRROR_FPS_RESTART_REASON));
    assert.deepStrictEqual(parseMirrorLine(`{"ok":false,"error":"${MIRROR_FPS_RESTART_REASON}"}`), { kind: 'fatal', error: MIRROR_FPS_RESTART_REASON });
  });
});

describe('the pace the phone keeps (header pace, agent 1.10.7)', () => {
  it('maps the whole-ms slot to the pacer step, at most the stream rate', () => {
    assert.strictEqual(paceFpsOf(17, 60), 60);
    assert.strictEqual(paceFpsOf(22, 60), 45);
    assert.strictEqual(paceFpsOf(33, 60), 30);
    assert.strictEqual(paceFpsOf(50, 30), 20);
    assert.strictEqual(paceFpsOf(133, 30), 7.5);
    assert.strictEqual(paceFpsOf(33, 30), 30);
  });

  it('keeps the stream rate before a header or for a slot that is no step', () => {
    assert.strictEqual(paceFpsOf(undefined, 60), 60);
    assert.strictEqual(paceFpsOf(0, 30), 30);
    assert.strictEqual(paceFpsOf(40, 25), 25);
    assert.strictEqual(paceFpsOf(undefined, undefined), undefined);
  });
});

describe('stage fields in the real 1.10.7 record shape', () => {
  it('a full VP8 header as the agent writes it yields stages through the record parser', () => {
    const header = '{"frame":42,"ts":1760000000000,"screen":[720,1584],"size":[720,1584],"format":"vp8","key":false,"pts":12345,"bytes":3,"ems":21,"cvms":6,"capture":"native","pace":17,"hms":0,"wms":6,"rbms":17,"cnms":6,"enms":15,"sdms":0,"kbps":2000,"ticks":100,"skips":0,"rtt":5,"rttFrame":41}';
    const status = Buffer.from('{"ok":true,"stream":"mirror","fps":60,"width":720,"quality":60,"encoding":"vp8","window":8,"bitrate":2000,"adapt":true,"lease":60}\n');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(Buffer.byteLength(header));
    const events: unknown[] = [];
    const parser = new MirrorRecordParser();
    for (const ev of [...parser.push(status), ...parser.push(Buffer.concat([len, Buffer.from(header), Buffer.from([1, 2, 3])]))]) events.push(ev);
    const frame = events.find((e) => (e as { kind?: string }).kind === 'frame') as MirrorRecordHeader | undefined;
    assert.ok(frame, JSON.stringify(events));
    assert.deepStrictEqual(frame.stages, { hold: 0, wait: 6, readback: 17, convert: 6, encode: 15, send: 0 });
    assert.strictEqual(frame.pace, 17);
  });
});
