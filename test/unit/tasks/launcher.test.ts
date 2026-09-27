import * as assert from 'assert';
import { chooseLauncher, tokenize } from '../../../src/tasks/launcher';
import type { ProjectDescriptor } from '../../../src/core/types';

function project(overrides: Partial<ProjectDescriptor> = {}): ProjectDescriptor {
  return {
    // WorkspaceFolder is irrelevant to launcher logic in this unit test.
    folder: {} as unknown as ProjectDescriptor['folder'],
    specPath: '/ws/rpm/harbour-demo.spec',
    name: 'harbour-demo',
    buildSystem: 'qmake',
    hasNativeBinary: true,
    isPureQml: false,
    appBinaryPath: '/usr/bin/harbour-demo',
    buildRequires: [],
    detectedAt: 0,
    ...overrides,
  };
}

describe('launcher.tokenize', () => {
  it('splits on whitespace', () => {
    assert.deepStrictEqual(tokenize('invoker --type=silica-qt5 /usr/bin/x'), [
      'invoker',
      '--type=silica-qt5',
      '/usr/bin/x',
    ]);
  });

  it('honours single and double quotes', () => {
    assert.deepStrictEqual(tokenize(`ssh device "run me" 'a b'`), ['ssh', 'device', 'run me', 'a b']);
  });

  it('collapses repeated whitespace and trims', () => {
    assert.deepStrictEqual(tokenize('  a   b  '), ['a', 'b']);
  });
});

describe('launcher.chooseLauncher (FR-5.5)', () => {
  it('auto + native binary -> invoker --type=silica-qt5', () => {
    const argv = chooseLauncher(project({ hasNativeBinary: true }), { mode: 'auto', customCommand: '' });
    assert.deepStrictEqual(argv, ['invoker', '--type=silica-qt5', '/usr/bin/harbour-demo']);
  });

  it('auto + pure QML -> sailfish-qml <Name>', () => {
    const argv = chooseLauncher(project({ hasNativeBinary: false, isPureQml: true }), {
      mode: 'auto',
      customCommand: '',
    });
    assert.deepStrictEqual(argv, ['sailfish-qml', 'harbour-demo']);
  });

  it('invoker-silica forces invoker regardless of hasNativeBinary', () => {
    const argv = chooseLauncher(project({ hasNativeBinary: false }), { mode: 'invoker-silica', customCommand: '' });
    assert.deepStrictEqual(argv, ['invoker', '--type=silica-qt5', '/usr/bin/harbour-demo']);
  });

  it('sailfish-qml forces sailfish-qml regardless of hasNativeBinary', () => {
    const argv = chooseLauncher(project({ hasNativeBinary: true }), { mode: 'sailfish-qml', customCommand: '' });
    assert.deepStrictEqual(argv, ['sailfish-qml', 'harbour-demo']);
  });

  it('custom substitutes ${appName} and tokenizes without a shell', () => {
    const argv = chooseLauncher(project(), {
      mode: 'custom',
      customCommand: 'ssh -p 2223 device "invoker ${appName}"',
    });
    assert.deepStrictEqual(argv, ['ssh', '-p', '2223', 'device', 'invoker harbour-demo']);
  });

  it('rejects an invalid application name (NFR-20)', () => {
    assert.throws(() =>
      chooseLauncher(project({ name: 'harbour-demo; rm -rf /' }), { mode: 'auto', customCommand: '' }),
    );
  });
});
