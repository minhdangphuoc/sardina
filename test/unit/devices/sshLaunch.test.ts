import * as assert from 'assert';
import { buildSshLaunch } from '../../../src/devices/sshLaunch';
import type { SfdkDeviceInfo } from '../../../src/core/types';

function device(overrides: Partial<SfdkDeviceInfo> = {}): SfdkDeviceInfo {
  return {
    index: 1,
    name: 'Xperia 10 - Dual SIM (ARM)',
    kind: 'hardware-device',
    origin: 'user-defined',
    user: 'defaultuser',
    host: '192.168.2.15',
    port: 22,
    privateKey: '/Users/mersdk/.ssh/sdk_hw',
    flags: [],
    extra: [],
    ...overrides,
  };
}

describe('buildSshLaunch (FR-6.6)', () => {
  it('builds ssh -p/-i/--/user@host when a private key is present', () => {
    const launch = buildSshLaunch(device(), '/opt/sfdk/bin/sfdk');
    assert.strictEqual(launch.shellPath, 'ssh');
    assert.deepStrictEqual(launch.shellArgs, [
      '-p',
      '22',
      '-i',
      '/Users/mersdk/.ssh/sdk_hw',
      '--',
      'defaultuser@192.168.2.15',
    ]);
  });

  it('falls back to device exec when user or host starts with "-" (FR-6.6: `sfdk device list`\'s \\S+ user/host could otherwise be parsed as an ssh option)', () => {
    const launch = buildSshLaunch(device({ user: '-oProxyCommand=evil' }), 'sfdk');
    assert.strictEqual(launch.shellPath, 'sfdk');
    assert.deepStrictEqual(launch.shellArgs, ['device', 'exec', 'Xperia 10 - Dual SIM (ARM)', '-t']);
  });

  it('falls back to `sfdk device exec <name> -t` when the private key is absent', () => {
    const launch = buildSshLaunch(device({ privateKey: undefined }), '/opt/sfdk/bin/sfdk');
    assert.strictEqual(launch.shellPath, '/opt/sfdk/bin/sfdk');
    assert.deepStrictEqual(launch.shellArgs, ['device', 'exec', 'Xperia 10 - Dual SIM (ARM)', '-t']);
  });

  it('falls back when host or user is missing even with a private key', () => {
    const launch = buildSshLaunch(device({ host: undefined }), 'sfdk');
    assert.strictEqual(launch.shellPath, 'sfdk');
  });

  it('the device name is always a single argv element, verbatim (R25 injection corpus)', () => {
    const corpus = ['; rm -rf /', '$(id)', '`id`', '"quoted"', "'quoted'", '--malicious-flag', '-', 'a'.repeat(10240), '\n', '日本語 café'];
    for (const name of corpus) {
      const launch = buildSshLaunch(device({ privateKey: undefined, name }), 'sfdk');
      assert.strictEqual(launch.shellArgs.length, 4);
      assert.strictEqual(launch.shellArgs[2], name, `expected name to survive verbatim as one argv element: ${JSON.stringify(name)}`);
    }
  });
});
