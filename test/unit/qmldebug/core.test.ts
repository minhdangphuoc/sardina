import * as assert from 'assert';
import { QML_DEBUG_DEFAULT_PORT, QML_DEBUG_SERVICES, hasQmlDebugAdapter, qmlDebugAdapterPort, qmlDebugLaunchArgs, qmlDebugPort, qmlDebuggerArgument } from '../../../src/qmldebug/core';

describe('QML debug launch values', () => {
  it('starts a loopback-only, blocking QML/JavaScript debug server', () => {
    assert.strictEqual(
      qmlDebuggerArgument(3768),
      `-qmljsdebugger=port:3768,host:127.0.0.1,block,services:${QML_DEBUG_SERVICES}`,
    );
  });

  it('uses the default port for an invalid runtime configuration value', () => {
    assert.strictEqual(qmlDebugPort(3768), 3768);
    assert.strictEqual(qmlDebugPort(0), QML_DEBUG_DEFAULT_PORT);
    assert.strictEqual(qmlDebugPort(65_536), QML_DEBUG_DEFAULT_PORT);
    assert.strictEqual(qmlDebugPort(1.5), QML_DEBUG_DEFAULT_PORT);
  });

  it('passes the adapter port as a string for qt-qml 1.16 compatibility', () => {
    assert.strictEqual(qmlDebugAdapterPort(3768), '3768');
  });

  it('constructs the single-dash debugger argument on the device so SFDK cannot drop it', () => {
    assert.deepStrictEqual(
      qmlDebugLaunchArgs(['device', 'exec', '--', 'invoker', '--type=silica-qt5', '/usr/bin/app'], 3768),
      [
        'device', 'exec', '--', 'sh', '-c',
        `port=$1; shift; exec "$@" "-qmljsdebugger=port:$port,host:127.0.0.1,block,services:${QML_DEBUG_SERVICES}"`,
        'sh', '3768', 'invoker', '--type=silica-qt5', '/usr/bin/app',
      ],
    );
    assert.throws(() => qmlDebugLaunchArgs(['invoker', '/usr/bin/app'], 3768));
  });

  it('bypasses Sailjail-enforcing invoker for a native debugger launch only', () => {
    const launch = ['device', 'exec', '--', 'invoker', '--type=silica-qt5', '/usr/bin/app'];
    const result = qmlDebugLaunchArgs(launch, 3768, '/usr/bin/app');
    assert.deepStrictEqual(result.slice(-1), ['/usr/bin/app']);
    assert.ok(!result.includes('invoker'));

    const custom = ['device', 'exec', '--', '/opt/debug-wrapper', '/usr/bin/app'];
    assert.deepStrictEqual(qmlDebugLaunchArgs(custom, 3768, '/usr/bin/app').slice(-2), ['/opt/debug-wrapper', '/usr/bin/app']);
  });

  it('detects the Qt QML debug adapter contribution', () => {
    assert.strictEqual(hasQmlDebugAdapter({ contributes: { debuggers: [{ type: 'qml' }] } }), true);
    assert.strictEqual(hasQmlDebugAdapter({ contributes: { debuggers: [{ type: 'cppdbg' }] } }), false);
    assert.strictEqual(hasQmlDebugAdapter(undefined), false);
  });

});
