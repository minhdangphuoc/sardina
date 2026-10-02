import * as assert from 'assert';
import {
  BUILD_TYPES,
  DEPLOY_METHODS,
  buildTypeText,
  deployInstallsApp,
  deployMethodLabel,
  deployMethodText,
  deviceText,
  lastBuildTarget,
  staleBuildTarget,
  targetArch,
} from '../../../src/tasks/buildConfig';
import { buildArgs } from '../../../src/tasks/argv';

describe('buildConfig status bar selectors', () => {
  it('offers every sfdk deploy method exactly once, Qt Creator-named first', () => {
    assert.deepStrictEqual(
      DEPLOY_METHODS.map((m) => m.value).sort(),
      ['manual', 'pkcon', 'rsync', 'sdk', 'zypper', 'zypper-dup'],
    );
    assert.strictEqual(DEPLOY_METHODS[0].label, 'Deploy as RPM package');
    assert.strictEqual(deployMethodLabel('rsync'), 'Deploy by copying binaries');
  });

  it('renders compact status bar text', () => {
    assert.strictEqual(buildTypeText('debug'), '$(gear) Debug');
    assert.strictEqual(deployMethodText('sdk'), '$(cloud-upload) RPM');
    assert.strictEqual(deviceText('Jolla Phone 2026'), '$(device-mobile) Jolla Phone 2026');
    assert.strictEqual(deviceText(''), '$(device-mobile) No device');
    assert.deepStrictEqual(BUILD_TYPES.map((b) => b.value), ['release', 'debug']);
  });

  it('only a manual deploy leaves nothing installed to launch', () => {
    assert.strictEqual(deployInstallsApp('manual'), false);
    for (const m of ['sdk', 'rsync', 'pkcon', 'zypper', 'zypper-dup'] as const) assert.strictEqual(deployInstallsApp(m), true);
  });

  it('build type Debug adds -d; a task definition\'s own debug flag wins', () => {
    const s = { runHarbourCheck: false, jobs: 0 };
    assert.deepStrictEqual(buildArgs({ command: 'build' }, { ...s, buildType: 'debug' }), ['build', '--no-check', '-d']);
    assert.deepStrictEqual(buildArgs({ command: 'build' }, { ...s, buildType: 'release' }), ['build', '--no-check']);
    assert.deepStrictEqual(buildArgs({ command: 'build', debug: false }, { ...s, buildType: 'debug' }), ['build', '--no-check']);
  });

  it('reads the architecture from target names and sfdk\'s .sfdk/target', () => {
    assert.strictEqual(targetArch('SailfishOS-5.1.0.11-aarch64'), 'aarch64');
    assert.strictEqual(targetArch('SailfishOS-5.1.0.11-i486.default'), 'i486');
    assert.strictEqual(targetArch('SailfishOS-5.1.0.11EA-armv7hl'), 'armv7hl');
    assert.strictEqual(targetArch('SailfishOS-5.1.0.11'), undefined);
    assert.strictEqual(lastBuildTarget('SailfishOS-5.1.0.11-aarch64.default\n'), 'SailfishOS-5.1.0.11-aarch64');
  });

  it('flags stale build output only when the architecture changes', () => {
    const builtForEmulator = 'SailfishOS-5.1.0.11-i486.default\n';
    assert.strictEqual(staleBuildTarget(builtForEmulator, 'SailfishOS-5.1.0.11-aarch64'), 'SailfishOS-5.1.0.11-i486');
    assert.strictEqual(staleBuildTarget(builtForEmulator, 'SailfishOS-5.0.0.62-i486'), undefined, 'same arch, other version');
    assert.strictEqual(staleBuildTarget(undefined, 'SailfishOS-5.1.0.11-aarch64'), undefined, 'never built');
    assert.strictEqual(staleBuildTarget('', 'SailfishOS-5.1.0.11-aarch64'), undefined);
  });
});
