import * as assert from 'assert';
import { DEVICE_TOOL_PACKAGES, installOutcomeMessage, installScript } from '../../../src/devices/devicePackagesCore';

describe('device tool install', () => {
  it('refreshes the package lists before installing, in one root shell', () => {
    assert.strictEqual(installScript(DEVICE_TOOL_PACKAGES), 'pkcon refresh && pkcon install -y rsync sdk-deploy-rpm gdb-gdbserver');
  });

  it('reports success only for exit 0, and explains failures', () => {
    assert.deepStrictEqual(installOutcomeMessage('Flip Phone', ['rsync'], 0), { ok: true, message: 'Sailfish: installed rsync on "Flip Phone".' });
    const failed = installOutcomeMessage('Flip Phone', ['rsync'], 4);
    assert.strictEqual(failed.ok, false);
    assert.match(failed.message, /failed \(exit 4\)/);
    assert.match(failed.message, /internet access/);
    assert.strictEqual(installOutcomeMessage('X', ['rsync'], undefined).ok, false);
  });
});
