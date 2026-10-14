import * as assert from 'assert';
import { DEBUG_MONITOR_MIN_AGENT_VERSION, debugMonitorArgs, debugMonitorMessage, parseDebugMonitorEvent, qmlDebugStartupStallMessage } from '../../../src/debug/debugMonitorCore';

describe('Debugger Monitoring Agent protocol', () => {
  it('requires the credential-aware monitor version', () => {
    assert.strictEqual(DEBUG_MONITOR_MIN_AGENT_VERSION, '1.13.2');
  });
  const status = (override: Record<string, unknown> = {}) => JSON.stringify({
    event: 'status', mode: 'qml', state: 'server-listening', pid: 123, serverPid: 123,
    qmlArgument: true, listening: true, port: 3768, ...override,
  });

  it('builds fixed commands for both debugger modes and rejects paths/ports outside the contract', () => {
    assert.deepStrictEqual(debugMonitorArgs('qml', '/usr/bin/cameragallery', 3768), [
      'device', 'exec', '--', 'sailfish-devagent', '--request', 'debugmonitor', '--mode', 'qml',
      '--exe', '/usr/bin/cameragallery', '--port', '3768',
    ]);
    assert.strictEqual(debugMonitorArgs('cpp', '/usr/bin/app', 10000).at(-1), '10000');
    for (const exe of ['/bin/sh', '/usr/bin/../app', '/usr/bin/app; touch x', '/usr/bin/a/b']) assert.throws(() => debugMonitorArgs('qml', exe, 3768));
    for (const port of [0, 1023, 65536, 1.5, Number.NaN]) assert.throws(() => debugMonitorArgs('qml', '/usr/bin/app', port));
  });

  it('accepts listener ownership only for the requested mode and port with valid PID evidence', () => {
    const ready = parseDebugMonitorEvent(status(), 'qml', 3768);
    assert.ok(ready);
    assert.strictEqual(ready && debugMonitorMessage(ready), 'debug server PID 123 owns the listener on port 3768');
    assert.strictEqual(parseDebugMonitorEvent(status({ mode: 'cpp' }), 'qml', 3768), undefined);
    assert.strictEqual(parseDebugMonitorEvent(status({ port: 4000 }), 'qml', 3768), undefined);
    for (const override of [{ serverPid: 0 }, { serverPid: -1 }, { pid: 1.5 }, { qmlArgument: false }, { listening: false }, { state: 'unknown' }]) {
      assert.strictEqual(parseDebugMonitorEvent(status(override), 'qml', 3768), undefined);
    }
    assert.ok(parseDebugMonitorEvent(status({ mode: 'cpp', port: 10000, qmlArgument: false, pid: 0 }), 'cpp', 10000));
    assert.strictEqual(parseDebugMonitorEvent('not JSON', 'qml', 3768), undefined);
  });

  it('explains process/argument failures instead of relying on a delay', () => {
    const missing = parseDebugMonitorEvent(status({ state: 'missing-qml-argument', qmlArgument: false, listening: false, serverPid: 0 }), 'qml', 3768);
    assert.ok(missing);
    assert.match(missing && debugMonitorMessage(missing) || '', /without the requested QML debug argument/);
    const exited = parseDebugMonitorEvent(status({ state: 'app-exited', pid: 0, serverPid: 0, listening: false }), 'qml', 3768);
    assert.strictEqual(exited && debugMonitorMessage(exited), 'application process exited');
    assert.deepStrictEqual(parseDebugMonitorEvent('{"ok":true,"stream":"debugmonitor","event":"ready"}', 'qml', 3768), { event: 'ready' });
    const running = parseDebugMonitorEvent(status({ state: 'app-running', listening: false, serverPid: 0 }), 'qml', 3768);
    assert.match(qmlDebugStartupStallMessage(running, 3768), /received its QML debug argument but did not open port 3768/);
    const unowned = parseDebugMonitorEvent(status({ state: 'port-listening-unowned', listening: false, serverPid: 0 }), 'qml', 3768);
    assert.match(unowned && debugMonitorMessage(unowned) || '', /port 3768 is listening/);
    assert.match(qmlDebugStartupStallMessage(unowned, 3768), /could not verify that the selected application owns it/);
  });
});
