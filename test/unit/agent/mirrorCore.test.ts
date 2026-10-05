import * as assert from 'assert';
import {
  FpsMeter,
  LatestFrame,
  MIRROR_DEFAULTS,
  MIRROR_MIN_AGENT_VERSION,
  agentSupportsMirror,
  compareVersions,
  isJpeg,
  mirrorHtml,
  mirrorRequestArgs,
  parseMirrorLine,
} from '../../../src/agent/mirrorCore';

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
});

describe('mirrorCore.mirrorHtml', () => {
  const html = mirrorHtml('abc123', 'Xperia <10> & "co"');
  it('has the CSP meta with the nonce', () => {
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-abc123'; script-src 'nonce-abc123'">/);
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
