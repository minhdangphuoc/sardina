import * as assert from 'assert';
import { asHostMessage, parsePageMessage, validatePageMessage } from '../../../src/monitor/protocol';

describe('validatePageMessage', () => {
  it('accepts every message with exact fields', () => {
    const ok: unknown[] = [
      { type: 'ready' },
      { type: 'ui.visible', on: false },
      { type: 'resume', what: 'app' },
      { type: 'resume', what: 'all' },
    ];
    for (const raw of ok) assert.deepStrictEqual(validatePageMessage(raw), raw, JSON.stringify(raw));
  });

  it('drops unknown fields', () => {
    assert.deepStrictEqual(validatePageMessage({ type: 'ready', extra: 1, __proto__: { x: 1 } }), { type: 'ready' });
    assert.deepStrictEqual(validatePageMessage({ type: 'resume', what: 'app', cmd: 'rm -rf /' }), { type: 'resume', what: 'app' });
  });

  it('rejects wrong types and removed messages', () => {
    const bad: unknown[] = [
      { type: 'ui.visible', on: 1 },
      { type: 'ui.visible' },
      { type: 'action', name: 'stopApp' },
      { type: 'resume', what: 'everything' },
      { type: 'resume', what: 'logs' },
      { type: 'log.ack', upTo: 3 },
      { type: 'session.stop', id: 4 },
      { type: 'openSource', file: 'a.qml', line: 1 },
    ];
    for (const raw of bad) assert.strictEqual(validatePageMessage(raw), undefined, JSON.stringify(raw));
  });

  it('ignores non-objects and arrays', () => {
    for (const raw of [undefined, null, 0, 'ready', true, [], [{ type: 'ready' }], () => 1]) assert.strictEqual(validatePageMessage(raw), undefined);
  });

  it('tells an unknown type from a bad shape', () => {
    assert.deepStrictEqual(parsePageMessage({ type: 'nope' }), { ok: false, reason: 'unknown-type' });
    assert.deepStrictEqual(parsePageMessage({ type: 7 }), { ok: false, reason: 'unknown-type' });
    assert.deepStrictEqual(parsePageMessage({}), { ok: false, reason: 'unknown-type' });
    assert.deepStrictEqual(parsePageMessage({ type: 'resume', what: 'x' }), { ok: false, reason: 'invalid' });
    assert.deepStrictEqual(parsePageMessage(null), { ok: false, reason: 'invalid' });
  });

  it('does not treat Object.prototype names as types', () => {
    for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.strictEqual(validatePageMessage({ type: t }), undefined);
  });
});

describe('asHostMessage', () => {
  it('passes well-formed messages and rejects malformed ones', () => {
    assert.ok(asHostMessage({ type: 'banner.clear' }));
    assert.ok(asHostMessage({ type: 'init', device: 'd' }));
    assert.ok(asHostMessage({ type: 'overview', state: 'offline', line: '' }));
    assert.ok(asHostMessage({ type: 'app', stats: null, counters: { restarts: 0, crashes: 0 } }));
    assert.strictEqual(asHostMessage({ type: 'overview', state: 'weird', line: '' }), undefined);
    assert.strictEqual(asHostMessage({ type: 'overview', rows: [] }), undefined);
    assert.strictEqual(asHostMessage({ type: 'app', stats: null }), undefined);
    assert.strictEqual(asHostMessage({ type: 'log.append', entries: [], dropped: 0, upTo: 0 }), undefined);
    assert.strictEqual(asHostMessage({ type: 'nope' }), undefined);
    assert.strictEqual(asHostMessage('x'), undefined);
    assert.strictEqual(asHostMessage(null), undefined);
  });
});
