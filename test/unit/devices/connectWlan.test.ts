import * as assert from 'assert';
import { buildWlanSshLaunch, isValidPort } from '../../../src/devices/connectWlan';

describe('buildWlanSshLaunch ("Sardina: Connect to Device (WLAN)")', () => {
  it('builds ssh -p <port> -- <user>@<host>', () => {
    const launch = buildWlanSshLaunch('192.168.50.125', '22', 'nemo');
    assert.deepStrictEqual(launch, { shellPath: 'ssh', shellArgs: ['-p', '22', '--', 'nemo@192.168.50.125'] });
  });

  it('rejects an option-like host or user (R25)', () => {
    assert.strictEqual(buildWlanSshLaunch('-oProxyCommand=evil', '22', 'nemo'), null);
    assert.strictEqual(buildWlanSshLaunch('192.168.50.125', '22', '-oProxyCommand=evil'), null);
  });

  it('rejects an empty host or user', () => {
    assert.strictEqual(buildWlanSshLaunch('', '22', 'nemo'), null);
    assert.strictEqual(buildWlanSshLaunch('192.168.50.125', '22', ''), null);
  });

  it('rejects an out-of-range or non-numeric port', () => {
    assert.strictEqual(buildWlanSshLaunch('192.168.50.125', '0', 'nemo'), null);
    assert.strictEqual(buildWlanSshLaunch('192.168.50.125', '65536', 'nemo'), null);
    assert.strictEqual(buildWlanSshLaunch('192.168.50.125', 'abc', 'nemo'), null);
  });

  it('the host and user always survive as single argv elements, verbatim (R25 injection corpus)', () => {
    const corpus = ['; rm -rf /', '$(id)', '`id`', '"quoted"', "'quoted'", 'a'.repeat(10240), '日本語'];
    for (const value of corpus) {
      const launch = buildWlanSshLaunch(value, '22', value);
      assert.ok(launch);
      assert.strictEqual(launch.shellArgs.length, 4);
      assert.strictEqual(launch.shellArgs[3], `${value}@${value}`);
    }
  });
});

describe('isValidPort', () => {
  it('accepts 1-65535', () => {
    assert.strictEqual(isValidPort('1'), true);
    assert.strictEqual(isValidPort('22'), true);
    assert.strictEqual(isValidPort('65535'), true);
  });

  it('rejects 0, out-of-range, and non-numeric input', () => {
    assert.strictEqual(isValidPort('0'), false);
    assert.strictEqual(isValidPort('65536'), false);
    assert.strictEqual(isValidPort('-1'), false);
    assert.strictEqual(isValidPort('22a'), false);
    assert.strictEqual(isValidPort(''), false);
  });
});
