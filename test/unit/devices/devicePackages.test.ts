import * as assert from 'assert';
import {
  CHECK_TOOLS_SCRIPT,
  DEVICE_TOOL_PACKAGES,
  installOutcomeMessage,
  installScript,
  packagesToInstall,
  parseInstallProgress,
  parseToolCheck,
} from '../../../src/devices/devicePackagesCore';

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

  it('installs only the given packages', () => {
    assert.strictEqual(installScript(['gdb-gdbserver']), 'pkcon refresh && pkcon install -y gdb-gdbserver');
  });
});

describe('device tool check', () => {
  const out = (r: string, s: string, g: string): string => `sfdev-tool:rsync:${r}\nsfdev-tool:sdk-deploy-rpm:${s}\nsfdev-tool:gdbserver:${g}\n`;

  it('checks with fixed read-only text that names every tool', () => {
    for (const c of ['rsync', 'sdk-deploy-rpm', 'gdbserver']) assert.ok(CHECK_TOOLS_SCRIPT.includes(c));
    assert.ok(!/pkcon|devel-su/.test(CHECK_TOOLS_SCRIPT));
  });

  it('maps missing tools to packages (gdbserver -> gdb-gdbserver)', () => {
    assert.deepStrictEqual(parseToolCheck(out('ok', 'ok', 'ok')), []);
    assert.deepStrictEqual(parseToolCheck(out('ok', 'ok', 'missing')), ['gdb-gdbserver']);
    assert.deepStrictEqual(parseToolCheck(out('missing', 'ok', 'missing')), ['rsync', 'gdb-gdbserver']);
    assert.deepStrictEqual(parseToolCheck(out('missing', 'missing', 'missing').replace(/\n/g, '\r\n')), [...DEVICE_TOOL_PACKAGES]);
  });

  it('treats unknown, partial or garbled output as "could not check"', () => {
    assert.strictEqual(parseToolCheck(''), undefined);
    assert.strictEqual(parseToolCheck('/usr/bin/rsync\n'), undefined);
    assert.strictEqual(parseToolCheck('sfdev-tool:rsync:ok\nsfdev-tool:gdbserver:ok\n'), undefined);
    assert.strictEqual(parseToolCheck(out('ok', 'maybe', 'ok')), undefined);
  });

  it('never takes package names from the output', () => {
    assert.deepStrictEqual(parseToolCheck(out('ok', 'ok', 'missing') + 'sfdev-tool:evil; rm -rf /:missing\n'), ['gdb-gdbserver']);
  });

  it('installs everything when the check could not tell, else only what is missing', () => {
    assert.deepStrictEqual(packagesToInstall(undefined), [...DEVICE_TOOL_PACKAGES]);
    assert.deepStrictEqual(packagesToInstall(['gdb-gdbserver']), ['gdb-gdbserver']);
  });

  it('reads the step and percent from pkcon lines', () => {
    assert.deepStrictEqual(parseInstallProgress('Refreshing cache  [=====     ] (45%)'), { step: 'refreshing', percent: 45 });
    assert.deepStrictEqual(parseInstallProgress('Downloading  gdb-gdbserver'), { step: 'downloading' });
    assert.deepStrictEqual(parseInstallProgress('Installing 100%'), { step: 'installing', percent: 100 });
    assert.strictEqual(parseInstallProgress('Transaction: install'.replace('install', 'x')), undefined);
  });
});
