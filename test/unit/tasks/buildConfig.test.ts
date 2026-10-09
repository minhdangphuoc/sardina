import * as assert from 'assert';
import {
  BUILD_TYPES,
  DEPLOY_METHODS,
  buildTypeText,
  cppdbgArchitecture,
  deployInstallsApp,
  deployMethodLabel,
  debugActionText,
  deployMethodText,
  deviceTextWithSessions,
  sessionTooltip,
  deviceText,
  lastBuildTarget,
  makefileBuildType,
  staleBuildTarget,
  staleBuildType,
  targetArch,
} from '../../../src/tasks/buildConfig';
import { DEBUG_RPMBUILD_ARGS, buildArgs } from '../../../src/tasks/argv';

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
    assert.deepStrictEqual(buildArgs({ command: 'build' }, { ...s, buildType: 'debug' }), ['build', '--no-check', '-d', '--', ...DEBUG_RPMBUILD_ARGS]);
    assert.deepStrictEqual(buildArgs({ command: 'build' }, { ...s, buildType: 'release' }), ['build', '--no-check']);
    assert.deepStrictEqual(buildArgs({ command: 'build', debug: false }, { ...s, buildType: 'debug' }), ['build', '--no-check']);
  });

  // CXXFLAGS lines as qmake wrote them for the i486 target (sfdk build -d, without and with the debug define).
  const releaseMakefile =
    'CC            = gcc\nCXXFLAGS      = -pipe -O2 -g -pipe -Wall -Wp,-D_FORTIFY_SOURCE=2 -fexceptions -fstack-protector --param=ssp-buffer-size=4 -Wformat -Wformat-security -m32 -msse -msse2 -march=i686 -mfpmath=sse -mtune=generic -fno-omit-frame-pointer -fasynchronous-unwind-tables -fPIC -fvisibility=hidden -fvisibility-inlines-hidden -Wall -W -D_REENTRANT -fPIC $(DEFINES)\n';
  const debugMakefile =
    'CC            = gcc\nCXXFLAGS      = -pipe -O0 -g -pipe -Wall -fexceptions -fstack-protector --param=ssp-buffer-size=4 -Wformat -Wformat-security -DQT_QML_DEBUG -m32 -msse -msse2 -march=i686 -mfpmath=sse -mtune=generic -fno-omit-frame-pointer -fasynchronous-unwind-tables -fPIC -fvisibility=hidden -fvisibility-inlines-hidden -Wall -W -D_REENTRANT -fPIC $(DEFINES)\n';

  it('reads the build type a qmake Makefile was generated for', () => {
    assert.strictEqual(makefileBuildType(releaseMakefile), 'release');
    assert.strictEqual(makefileBuildType(debugMakefile), 'debug');
    assert.strictEqual(makefileBuildType('CXXFLAGS = -O3 $(DEFINES)\n'), undefined, 'flags the project set itself');
    assert.strictEqual(makefileBuildType('all:\n\tcc -O2 x.c\n'), undefined, 'hand-written Makefile');
  });

  it('flags stale objects only when the build type changes', () => {
    assert.strictEqual(staleBuildType(releaseMakefile, 'debug'), true);
    assert.strictEqual(staleBuildType(debugMakefile, 'release'), true);
    assert.strictEqual(staleBuildType(releaseMakefile, 'release'), false);
    assert.strictEqual(staleBuildType(debugMakefile, 'debug'), false);
    assert.strictEqual(staleBuildType(undefined, 'debug'), false, 'never built');
    assert.strictEqual(staleBuildType('CXXFLAGS = -O3\n', 'release'), false, 'unknown flags never force a clean');
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

describe('device sessions in the status bar', () => {
  it('marks debug and other sessions on the device item', () => {
    assert.strictEqual(deviceTextWithSessions('Jolla Phone', [{ kind: 'logs' }, { kind: 'debug' }]), '$(debug) Jolla Phone');
    assert.strictEqual(deviceTextWithSessions('Jolla Phone', [{ kind: 'mirror' }]), '$(pulse) Jolla Phone');
    assert.strictEqual(deviceTextWithSessions('Jolla Phone', []), '$(device-mobile) Jolla Phone');
  });

  it('lists sessions and the way to stop them in the tooltip', () => {
    assert.strictEqual(sessionTooltip('A', []), '');
    const t = sessionTooltip('A', [{ label: 'debugging' }, { label: 'device logs' }]);
    assert.match(t, /Active on "A": debugging, device logs\./);
    assert.match(t, /Stop Sessions on Device/);
  });

  it('switches the Debug action text while debugging', () => {
    assert.strictEqual(debugActionText([{ kind: 'debug' }]), '$(debug-alt) Debugging…');
    assert.strictEqual(debugActionText([{ kind: 'app' }]), '$(debug-alt) Debug');
  });
});

describe('cppdbgArchitecture', () => {
  it('maps the target architecture to a cppdbg targetArchitecture', () => {
    assert.strictEqual(cppdbgArchitecture('SailfishOS-5.1.0.11-i486'), 'x86');
    assert.strictEqual(cppdbgArchitecture('SailfishOS-5.1.0.11-armv7hl'), 'arm');
    assert.strictEqual(cppdbgArchitecture('SailfishOS-5.1.0.11-aarch64.default'), 'arm64');
  });

  it('is undefined for an unknown or missing target', () => {
    assert.strictEqual(cppdbgArchitecture('SailfishOS-5.1.0.11-mips'), undefined);
    assert.strictEqual(cppdbgArchitecture(undefined), undefined);
  });
});
