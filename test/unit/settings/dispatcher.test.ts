import * as assert from 'assert';
import { ConfigDispatcher } from '../../../src/settings/dispatcher';

/**
 * FR-14.3: `Settings.onDidChange` fans out to per-key and `'*'` listeners.
 * This exercises the vscode-free `ConfigDispatcher` that backs it directly,
 * since `Settings` itself needs a real `vscode.workspace` (integration-only).
 */
describe('ConfigDispatcher (FR-14.3)', () => {
  it('fires a per-key listener when that key changes', () => {
    const dispatcher = new ConfigDispatcher();
    let calls = 0;
    dispatcher.on('target', () => calls++);
    dispatcher.fireKey('target');
    assert.strictEqual(calls, 1);
  });

  it('does not fire a listener registered for a different key', () => {
    const dispatcher = new ConfigDispatcher();
    let calls = 0;
    dispatcher.on('device', () => calls++);
    dispatcher.fireKey('target');
    assert.strictEqual(calls, 0);
  });

  it('fires "*" listeners independently of fireKey', () => {
    const dispatcher = new ConfigDispatcher();
    let wildcardCalls = 0;
    let targetCalls = 0;
    dispatcher.on('*', () => wildcardCalls++);
    dispatcher.on('target', () => targetCalls++);

    dispatcher.fireWildcard();
    assert.strictEqual(wildcardCalls, 1);
    assert.strictEqual(targetCalls, 0);

    dispatcher.fireKey('target');
    assert.strictEqual(wildcardCalls, 1);
    assert.strictEqual(targetCalls, 1);
  });

  it('keys() lists only specific keys with listeners, never "*"', () => {
    const dispatcher = new ConfigDispatcher();
    dispatcher.on('target', () => undefined);
    dispatcher.on('sdkPath', () => undefined);
    dispatcher.on('*', () => undefined);
    assert.deepStrictEqual(new Set(dispatcher.keys()), new Set(['target', 'sdkPath']));
  });

  it('dispose() on the returned handle stops future notifications', () => {
    const dispatcher = new ConfigDispatcher();
    let calls = 0;
    const handle = dispatcher.on('target', () => calls++);
    handle.dispose();
    dispatcher.fireKey('target');
    assert.strictEqual(calls, 0);
  });

  it('supports multiple listeners on the same key', () => {
    const dispatcher = new ConfigDispatcher();
    let a = 0;
    let b = 0;
    dispatcher.on('target', () => a++);
    dispatcher.on('target', () => b++);
    dispatcher.fireKey('target');
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 1);
  });
});
