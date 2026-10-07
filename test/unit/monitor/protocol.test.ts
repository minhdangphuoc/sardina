import * as assert from 'assert';
import { asHostMessage, parsePageMessage, validatePageMessage, type SaveFilter } from '../../../src/monitor/protocol';

const FILTER: SaveFilter = { minLevel: 'warning', tags: ['a'], mine: true, query: 'x', deriveLevels: false };

describe('validatePageMessage', () => {
  it('accepts every message with exact fields', () => {
    const ok: unknown[] = [
      { type: 'ready' },
      { type: 'log.ack', upTo: 0 },
      { type: 'log.ack', upTo: 12345 },
      { type: 'log.pause', on: true },
      { type: 'log.clear' },
      { type: 'log.save', filteredOnly: false, format: 'jsonl' },
      { type: 'log.save', filteredOnly: true, format: 'log', filter: FILTER },
      { type: 'openSource', file: '/usr/share/a/x.qml', line: 3 },
      { type: 'openSource', file: 'qrc:/x.qml', line: 3, col: 7 },
      { type: 'action', name: 'restartApp' },
      { type: 'action', name: 'installAgent' },
      { type: 'session.stop', id: 4 },
      { type: 'ui.visible', on: false },
      { type: 'resume', what: 'logs' },
    ];
    for (const raw of ok) assert.deepStrictEqual(validatePageMessage(raw), raw, JSON.stringify(raw));
  });

  it('drops unknown fields', () => {
    assert.deepStrictEqual(validatePageMessage({ type: 'ready', extra: 1, __proto__: { x: 1 } }), { type: 'ready' });
    assert.deepStrictEqual(validatePageMessage({ type: 'action', name: 'stopApp', cmd: 'rm -rf /' }), { type: 'action', name: 'stopApp' });
    const m = validatePageMessage({ type: 'log.save', filteredOnly: false, format: 'log', filter: FILTER });
    assert.deepStrictEqual(m, { type: 'log.save', filteredOnly: false, format: 'log' });
  });

  it('rejects wrong types and ranges', () => {
    const bad: unknown[] = [
      { type: 'log.ack', upTo: -1 },
      { type: 'log.ack', upTo: 1.5 },
      { type: 'log.ack', upTo: '3' },
      { type: 'log.ack', upTo: Infinity },
      { type: 'log.ack', upTo: NaN },
      { type: 'log.ack', upTo: Number.MAX_SAFE_INTEGER + 2 },
      { type: 'log.pause', on: 'yes' },
      { type: 'log.pause' },
      { type: 'ui.visible', on: 1 },
      { type: 'log.save', filteredOnly: false, format: 'csv' },
      { type: 'log.save', filteredOnly: 'no', format: 'log' },
      { type: 'log.save', filteredOnly: true, format: 'log' },
      { type: 'log.save', filteredOnly: true, format: 'log', filter: { ...FILTER, minLevel: 'trace' } },
      { type: 'log.save', filteredOnly: true, format: 'log', filter: { ...FILTER, tags: 'a' } },
      { type: 'log.save', filteredOnly: true, format: 'log', filter: { ...FILTER, tags: [1] } },
      { type: 'log.save', filteredOnly: true, format: 'log', filter: { ...FILTER, tags: new Array<string>(65).fill('t') } },
      { type: 'openSource', file: '', line: 1 },
      { type: 'openSource', file: '\u0000\n', line: 1 },
      { type: 'openSource', file: 'a.qml', line: 0 },
      { type: 'openSource', file: 'a.qml', line: 10_000_001 },
      { type: 'openSource', file: 'a.qml', line: 1, col: 0 },
      { type: 'openSource', file: 'a.qml', line: 1, col: 'x' },
      { type: 'openSource', file: 5, line: 1 },
      { type: 'action', name: 'format' },
      { type: 'action' },
      { type: 'session.stop', id: 0 },
      { type: 'session.stop', id: -3 },
      { type: 'resume', what: 'everything' },
    ];
    for (const raw of bad) assert.strictEqual(validatePageMessage(raw), undefined, JSON.stringify(raw));
  });

  it('rejects a path longer than 512 instead of cutting it, and strips control characters from short ones', () => {
    assert.strictEqual(validatePageMessage({ type: 'openSource', file: `/${'a'.repeat(512)}`, line: 1 }), undefined);
    assert.deepStrictEqual(validatePageMessage({ type: 'openSource', file: '/a/b\u0000.qml\n', line: 2 }), { type: 'openSource', file: '/a/b.qml', line: 2 });
    const m = validatePageMessage({ type: 'log.save', filteredOnly: true, format: 'log', filter: { ...FILTER, query: `q${'x'.repeat(600)}` } });
    assert.ok(m && m.type === 'log.save' && m.filter && m.filter.query.length === 512);
  });

  it('ignores non-objects and arrays', () => {
    for (const raw of [undefined, null, 0, 'ready', true, [], [{ type: 'ready' }], () => 1]) assert.strictEqual(validatePageMessage(raw), undefined);
  });

  it('tells an unknown type from a bad shape', () => {
    assert.deepStrictEqual(parsePageMessage({ type: 'nope' }), { ok: false, reason: 'unknown-type' });
    assert.deepStrictEqual(parsePageMessage({ type: 7 }), { ok: false, reason: 'unknown-type' });
    assert.deepStrictEqual(parsePageMessage({}), { ok: false, reason: 'unknown-type' });
    assert.deepStrictEqual(parsePageMessage({ type: 'log.ack', upTo: 'x' }), { ok: false, reason: 'invalid' });
    assert.deepStrictEqual(parsePageMessage(null), { ok: false, reason: 'invalid' });
  });

  it('does not treat Object.prototype names as types', () => {
    for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.strictEqual(validatePageMessage({ type: t }), undefined);
  });
});

describe('asHostMessage', () => {
  it('passes well-formed messages and rejects malformed ones', () => {
    assert.ok(asHostMessage({ type: 'log.clear' }));
    assert.ok(asHostMessage({ type: 'log.append', entries: [], dropped: 0, upTo: 0 }));
    assert.ok(asHostMessage({ type: 'log.state', status: 'live' }));
    assert.ok(asHostMessage({ type: 'init', device: 'd', settings: {} }));
    assert.strictEqual(asHostMessage({ type: 'log.append', entries: 'x', dropped: 0, upTo: 0 }), undefined);
    assert.strictEqual(asHostMessage({ type: 'log.state', status: 'weird' }), undefined);
    assert.strictEqual(asHostMessage({ type: 'sessions', list: null }), undefined);
    assert.strictEqual(asHostMessage({ type: 'nope' }), undefined);
    assert.strictEqual(asHostMessage('x'), undefined);
    assert.strictEqual(asHostMessage(null), undefined);
  });
});
