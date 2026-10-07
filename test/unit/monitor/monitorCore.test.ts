import * as assert from 'assert';
import { ActionGuard, PageMessageGate, monitorCsp, monitorHtml } from '../../../src/monitor/monitorCore';

const OPTS = {
  nonce: 'abc123',
  cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
  device: 'Jolla "Phone" <1>',
  scriptUri: 'https://x.test/monitor.js',
  styleUri: 'https://x.test/monitor.css',
};
const html = monitorHtml(OPTS);

describe('monitorHtml', () => {
  it('has the exact CSP with the nonce', () => {
    const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
    assert.ok(m);
    assert.strictEqual(
      m[1],
      "default-src 'none'; style-src https://file+.vscode-resource.vscode-cdn.net 'nonce-abc123'; script-src 'nonce-abc123'; img-src https://file+.vscode-resource.vscode-cdn.net data:; font-src https://file+.vscode-resource.vscode-cdn.net",
    );
    assert.strictEqual(m[1], monitorCsp('abc123', OPTS.cspSource));
    assert.ok(!/unsafe-inline|unsafe-eval|https?:\/\/\*/.test(m[1]));
  });

  it('puts the nonce on every script and has no script without it', () => {
    const tags = html.match(/<script\b[^>]*>/g) ?? [];
    assert.strictEqual(tags.length, 1);
    for (const t of tags) assert.ok(t.includes('nonce="abc123"') && t.includes('src="https://x.test/monitor.js"'), t);
    assert.ok(!/<script[^>]*>[^<]+<\/script>/.test(html), 'no inline script');
  });

  it('has no inline style, style attribute, event handler or javascript: URL', () => {
    assert.ok(!/<style\b/i.test(html));
    assert.ok(!/\sstyle\s*=/i.test(html));
    assert.ok(!/\son[a-z]+\s*=/i.test(html));
    assert.ok(!/javascript:/i.test(html));
    assert.ok(!/<iframe|<object|<embed|<form/i.test(html));
  });

  it('escapes the device name in the title and the header', () => {
    assert.ok(html.includes('<title>Monitor: Jolla &quot;Phone&quot; &lt;1&gt;</title>'));
    assert.ok(html.includes('<span id="device">Jolla &quot;Phone&quot; &lt;1&gt;</span>'));
    assert.ok(!html.includes('<1>'));
  });

  it('escapes the nonce, URIs and csp source against attribute injection', () => {
    const evil = monitorHtml({ ...OPTS, nonce: 'a"b', scriptUri: 'x" onload="1', styleUri: 'y"><script>', cspSource: 'z"; script-src *' });
    assert.ok(!/onload="1/.test(evil));
    assert.ok(!evil.includes('"><script>'));
    assert.ok(!evil.includes('"; script-src *'));
  });

  it('is a static skeleton with only the connection line and the App card', () => {
    for (const id of ['dot', 'state', 'line', 'app-card', 'app-running', 'app-idle', 'app-name', 'app-meta', 'cpu-value', 'mem-value', 'app-counters', 'banner']) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
    for (const id of ['cpu', 'rss']) {
      for (const part of ['line', 'area', 'dot']) assert.ok(html.includes(`id="spark-${id}-${part}"`), `${id} ${part}`);
    }
    assert.ok(!/<button|act-|data-action/.test(html), 'the actions live in the editor title bar, not in the page');
    assert.ok(!/log-grid|sessions-list|<section id="sec-/.test(html));
    assert.ok(!/<table|<svg[^>]*><rect/.test(html), 'line sparklines, no bar charts');
  });

  it('is accessible by construction: live regions, labelled sparklines, language', () => {
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(/<h1 class="sr-only">/.test(html));
    assert.ok(html.includes('id="banner" class="banner" role="status"'));
        assert.strictEqual((html.match(/role="img" aria-labelledby/g) ?? []).length, 2);
  });

  it('loads the stylesheet from the webview origin, with no other external resource', () => {
    const urls = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(urls.sort(), ['https://x.test/monitor.css', 'https://x.test/monitor.js']);
  });
});

describe('PageMessageGate', () => {
  it('passes valid messages and counts malformed ones', () => {
    const g = new PageMessageGate();
    assert.deepStrictEqual(g.accept({ type: 'ready' }, 0), { message: { type: 'ready' } });
    assert.deepStrictEqual(g.accept({ type: 'resume', what: 'nope' }, 1), {});
    assert.strictEqual(g.invalid, 1);
  });
  it('warns once after five unknown types within ten seconds, then starts over', () => {
    const g = new PageMessageGate();
    for (let i = 0; i < 4; i++) assert.deepStrictEqual(g.accept({ type: 'zzz' }, i * 1000), {});
    const w = g.accept({ type: 'zzz' }, 4000);
    assert.ok(w.warning && /5 unknown messages/.test(w.warning));
    for (let i = 0; i < 4; i++) assert.strictEqual(g.accept({ type: 'zzz' }, 5000 + i).warning, undefined);
    assert.ok(g.accept({ type: 'zzz' }, 5100).warning);
  });
  it('does not warn when the unknown messages are spread over time', () => {
    const g = new PageMessageGate();
    for (let i = 0; i < 20; i++) assert.strictEqual(g.accept({ type: 'zzz' }, i * 3000).warning, undefined);
  });
});

describe('ActionGuard', () => {
  it('allows one in flight per action', () => {
    const g = new ActionGuard();
    assert.strictEqual(g.tryStart('restartApp'), true);
    assert.strictEqual(g.tryStart('restartApp'), false);
    assert.strictEqual(g.tryStart('stopApp'), true);
    g.finish('restartApp');
    assert.strictEqual(g.isRunning('restartApp'), false);
    assert.strictEqual(g.tryStart('restartApp'), true);
  });
});
