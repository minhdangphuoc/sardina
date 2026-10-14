import * as assert from 'assert';
import {
  CHECK_PACKAGE_MANAGER_SCRIPT,
  CHECK_TOOLS_SCRIPT,
  DEVICE_TOOL_PACKAGES,
  DevicePackageProgress,
  cleanRootShellOutput,
  installOutcomeMessage,
  installScript,
  packageManagerState,
  packageMonitorArgs,
  packageMonitorMessage,
  packageMonitorLogMessage,
  removeToolsScript,
  packagesToInstall,
  parseInstallProgress,
  parsePackageMonitorEvent,
  parseToolCheck,
} from '../../../src/devices/devicePackagesCore';

describe('device tool install', () => {
  it('installs from cached metadata first and refreshes only for pkcon exit 4', () => {
    assert.strictEqual(
      installScript(DEVICE_TOOL_PACKAGES),
      'pkcon --plain install -y rsync sdk-deploy-rpm gdb-gdbserver qt5-qtdeclarative-plugin-qmlinspector || { status=$?; [ "$status" -eq 4 ] || exit "$status"; pkcon --plain refresh && pkcon --plain install -y rsync sdk-deploy-rpm gdb-gdbserver qt5-qtdeclarative-plugin-qmlinspector; }',
    );
  });

  it('reports success only for exit 0, and explains failures', () => {
    assert.deepStrictEqual(installOutcomeMessage('Flip Phone', ['rsync'], 0), { ok: true, message: 'Sardina: installed rsync on "Flip Phone".' });
    const failed = installOutcomeMessage('Flip Phone', ['rsync'], 4);
    assert.strictEqual(failed.ok, false);
    assert.match(failed.message, /failed \(exit 4\)/);
    assert.match(failed.message, /internet access/);
    assert.strictEqual(installOutcomeMessage('X', ['rsync'], undefined).ok, false);
  });

  it('installs only the given packages', () => {
    assert.strictEqual(
      installScript(['gdb-gdbserver']),
      'pkcon --plain install -y gdb-gdbserver || { status=$?; [ "$status" -eq 4 ] || exit "$status"; pkcon --plain refresh && pkcon --plain install -y gdb-gdbserver; }',
    );
  });

  it('detects an existing package transaction with a fixed read-only marker', () => {
    assert.match(CHECK_PACKAGE_MANAGER_SCRIPT, /pidof pkcon/);
    assert.ok(!/kill|pkill/.test(CHECK_PACKAGE_MANAGER_SCRIPT));
    assert.strictEqual(packageManagerState('sfdev-package-manager:idle\n', 0), 'idle');
    assert.strictEqual(packageManagerState('noise\nsfdev-package-manager:busy\n', 0), 'busy');
    assert.strictEqual(packageManagerState('sfdev-package-manager:idle\n', 1), 'unknown');
    assert.strictEqual(packageManagerState('noise', 0), 'unknown');
  });

});

describe('device tool check', () => {
  const out = (r: string, s: string, g: string, q = 'ok'): string =>
    `sfdev-tool:rsync:${r}\nsfdev-tool:sdk-deploy-rpm:${s}\nsfdev-tool:gdbserver:${g}\nsfdev-tool:qml-debug-server:${q}\n`;

  it('checks every package through the fixed RPM path instead of assuming binary or plugin locations', () => {
    for (const pkg of DEVICE_TOOL_PACKAGES) assert.ok(CHECK_TOOLS_SCRIPT.includes(`/usr/bin/rpm -q ${pkg}`));
    assert.ok(!/command -v|libqmldbg_server/.test(CHECK_TOOLS_SCRIPT));
    assert.ok(!/pkcon|devel-su/.test(CHECK_TOOLS_SCRIPT));
  });

  it('maps missing tools to packages (gdbserver -> gdb-gdbserver)', () => {
    assert.deepStrictEqual(parseToolCheck(out('ok', 'ok', 'ok')), []);
    assert.deepStrictEqual(parseToolCheck(out('ok', 'ok', 'missing')), ['gdb-gdbserver']);
    assert.deepStrictEqual(parseToolCheck(out('ok', 'ok', 'ok', 'missing')), ['qt5-qtdeclarative-plugin-qmlinspector']);
    assert.deepStrictEqual(parseToolCheck(out('missing', 'ok', 'missing')), ['rsync', 'gdb-gdbserver']);
    assert.deepStrictEqual(parseToolCheck(out('missing', 'missing', 'missing', 'missing').replace(/\n/g, '\r\n')), [...DEVICE_TOOL_PACKAGES]);
  });

  it('treats unknown, partial or garbled output as "could not check"', () => {
    assert.strictEqual(parseToolCheck(''), undefined);
    assert.strictEqual(parseToolCheck('/usr/bin/rsync\n'), undefined);
    assert.strictEqual(parseToolCheck('sfdev-tool:rsync:ok\nsfdev-tool:gdbserver:ok\nsfdev-tool:qml-debug-server:ok\n'), undefined);
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
    assert.deepStrictEqual(parseInstallProgress('Percentage: 50'), { step: '', percent: 50 });
    assert.deepStrictEqual(parseInstallProgress('Status: Removing packages'), { step: 'remov' });
  });

  it('bounds and cleans terminal redraw output before logging it', () => {
    const line = `Refreshing cache\x1b7\0\x1b8 [${' '.repeat(20_000)}] (45%)`;
    const clean = cleanRootShellOutput(line);
    assert.strictEqual(clean, 'Refreshing cache [ ] (45%)');
    assert.ok(clean.length <= 2000);
  });

  it('builds and parses the agent PackageKit progress stream', () => {
    const requested = ['gdb-gdbserver', 'qt5-qtdeclarative-plugin-qmlinspector'];
    assert.deepStrictEqual(packageMonitorArgs(requested), [
      'device',
      'exec',
      '--',
      'sailfish-devagent',
      '--request',
      'packages',
      '--package',
      'gdb-gdbserver',
      '--package',
      'qt5-qtdeclarative-plugin-qmlinspector',
    ]);
    assert.deepStrictEqual(
      parsePackageMonitorEvent('{"ok":true,"stream":"packages","event":"ready"}', requested),
      { event: 'ready' },
    );
    assert.deepStrictEqual(
      parsePackageMonitorEvent('{"event":"progress","package":"gdb-gdbserver","percentage":42}', requested),
      { event: 'progress', package: 'gdb-gdbserver', percentage: 42 },
    );
    const stalled = parsePackageMonitorEvent(
      '{"event":"stalled","seconds":60,"installed":["gdb-gdbserver","qt5-qtdeclarative-plugin-qmlinspector"],"missing":[]}',
      requested,
    );
    assert.deepStrictEqual(stalled, { event: 'stalled', seconds: 60, installed: requested, missing: [] });
    assert.strictEqual(stalled && packageMonitorMessage(stalled), 'packages installed; closing the stalled PackageKit client…');
  });

  it('rejects malformed, out-of-range and unrequested agent package events', () => {
    const requested = ['gdb-gdbserver'];
    assert.strictEqual(parsePackageMonitorEvent('not json', requested), undefined);
    assert.strictEqual(parsePackageMonitorEvent('{"event":"progress","package":"evil","percentage":10}', requested), undefined);
    assert.strictEqual(parsePackageMonitorEvent('{"event":"progress","package":"gdb-gdbserver","percentage":101}', requested), undefined);
    assert.strictEqual(
      parsePackageMonitorEvent('{"event":"stalled","seconds":60,"installed":["evil"],"missing":[]}', requested),
      undefined,
    );
  });
});

describe('package notification progress and removal', () => {
  it('averages per-package percentages and reserves completion until confirmed', () => {
    const bar = new DevicePackageProgress(['gdb-gdbserver', 'rsync']);
    let total = bar.update('querying packages', 100);
    assert.strictEqual(total, 10);
    total += bar.update('downloading', 100, 'gdb-gdbserver');
    assert.strictEqual(total, 32.5);
    total += bar.update('downloading', 100, 'rsync');
    assert.strictEqual(total, 55);
    total += bar.update('installing', 100, 'gdb-gdbserver');
    assert.strictEqual(total, 75);
    total += bar.update('installing', 100, 'rsync');
    assert.strictEqual(total, 95);
    total += bar.complete();
    assert.strictEqual(total, 100);
    assert.strictEqual(bar.complete(), 0);
  });

  it('does not jump backwards or complete on query/percentage resets', () => {
    const bar = new DevicePackageProgress(['rsync']);
    assert.strictEqual(bar.update('installing', 0), 0);
    assert.strictEqual(bar.update('downloading', 50), 32.5);
    assert.strictEqual(bar.update('querying', 100), 0);
    assert.strictEqual(bar.update('downloading', 0), 0);
    assert.strictEqual(bar.update('downloading', 101), 0);
    assert.strictEqual(bar.update('downloading', Number.NaN), 0);
    assert.strictEqual(bar.update('downloading', 100, 'unrequested'), 0);
  });

  it('tracks removal through the same bar and rejects arbitrary package names', () => {
    const bar = new DevicePackageProgress(['rsync']);
    assert.strictEqual(bar.update('removing', 50), 52.5);
    assert.strictEqual(bar.update('removing', 100), 42.5);
    assert.strictEqual(bar.complete(), 5);
    assert.strictEqual(removeToolsScript(['gdb-gdbserver', 'gdb-gdbserver']), 'pkcon --plain remove -y gdb-gdbserver');
    assert.throws(() => installScript([]));
    assert.throws(() => installScript(['arbitrary; command']));
    assert.throws(() => installScript(['sailfish-devagent']));
    assert.throws(() => removeToolsScript([]));
    assert.throws(() => removeToolsScript(['arbitrary; command']));
    assert.throws(() => removeToolsScript(['sailfish-devagent']));
  });

  it('keeps errors and milestones but omits per-package percentages and preliminary success', () => {
    assert.strictEqual(packageMonitorLogMessage({ event: 'status', package: 'rsync', phase: 'installing', percentage: 42 }, false), undefined);
    assert.strictEqual(packageMonitorLogMessage({ event: 'progress', package: 'rsync', percentage: 42 }, false), undefined);
    assert.strictEqual(packageMonitorLogMessage({ event: 'finished', exit: 'succeeded', installed: [], missing: ['rsync'] }, false), undefined);
    assert.strictEqual(packageMonitorLogMessage({ event: 'finished', exit: 'succeeded', installed: ['rsync'], missing: [] }, true), 'PackageKit succeeded');
    assert.strictEqual(packageMonitorLogMessage({ event: 'error', code: '1', details: 'Failed to obtain authentication.' }, false), 'PackageKit error 1: Failed to obtain authentication.');
    assert.strictEqual(packageMonitorLogMessage({ event: 'package', package: 'rsync', phase: 'downloading' }, false), 'downloading rsync…');
  });
});
