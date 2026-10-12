import * as assert from 'assert';
import { QML_DEBUG_DEFAULT_PORT, QML_DEBUG_SERVICES, hasQmlDebugAdapter, qmlDebugPort, qmlDebuggerArgument } from '../../../src/qmldebug/core';

describe('QML debug launch values', () => {
  it('starts a loopback-only, blocking QML/JavaScript debug server', () => {
    assert.strictEqual(
      qmlDebuggerArgument(3768),
      `-qmljsdebugger=host:127.0.0.1,port:3768,block,services:${QML_DEBUG_SERVICES}`,
    );
  });

  it('uses the default port for an invalid runtime configuration value', () => {
    assert.strictEqual(qmlDebugPort(3768), 3768);
    assert.strictEqual(qmlDebugPort(0), QML_DEBUG_DEFAULT_PORT);
    assert.strictEqual(qmlDebugPort(65_536), QML_DEBUG_DEFAULT_PORT);
    assert.strictEqual(qmlDebugPort(1.5), QML_DEBUG_DEFAULT_PORT);
  });

  it('detects the Qt QML debug adapter contribution', () => {
    assert.strictEqual(hasQmlDebugAdapter({ contributes: { debuggers: [{ type: 'qml' }] } }), true);
    assert.strictEqual(hasQmlDebugAdapter({ contributes: { debuggers: [{ type: 'cppdbg' }] } }), false);
    assert.strictEqual(hasQmlDebugAdapter(undefined), false);
  });
});
