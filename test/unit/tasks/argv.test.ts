import * as assert from 'assert';
import {
  DEBUG_GLOBAL_CFLAGS,
  buildArgs,
  checkArgs,
  cleanArgs,
  deployArgs,
  isValidAppName,
  packageArgs,
  runArgs,
} from '../../../src/tasks/argv';

describe('argv.buildArgs (FR-5.3)', () => {
  it('default: --no-check when runHarbourCheck is false', () => {
    const argv = buildArgs({ command: 'build' }, { runHarbourCheck: false, jobs: 0 });
    assert.deepStrictEqual(argv, ['build', '--no-check']);
  });

  it('runHarbourCheck true: no --no-check by default', () => {
    const argv = buildArgs({ command: 'build' }, { runHarbourCheck: true, jobs: 0 });
    assert.deepStrictEqual(argv, ['build']);
  });

  it('def.noCheck explicitly overrides the settings default', () => {
    assert.deepStrictEqual(buildArgs({ command: 'build', noCheck: false }, { runHarbourCheck: false, jobs: 0 }), [
      'build',
    ]);
    assert.deepStrictEqual(buildArgs({ command: 'build', noCheck: true }, { runHarbourCheck: true, jobs: 0 }), [
      'build',
      '--no-check',
    ]);
  });

  it('debug:true adds -d and an unoptimised %__global_cflags for rpmbuild', () => {
    const argv = buildArgs({ command: 'build', debug: true, noCheck: false }, { runHarbourCheck: true, jobs: 0 });
    assert.deepStrictEqual(argv, ['build', '-d', '--', '--define', `__global_cflags ${DEBUG_GLOBAL_CFLAGS}`]);
    assert.match(DEBUG_GLOBAL_CFLAGS, /^-O0 -g /);
    assert.doesNotMatch(DEBUG_GLOBAL_CFLAGS, /-O[1-3s]|_FORTIFY_SOURCE/);
    assert.match(DEBUG_GLOBAL_CFLAGS, / -DQT_QML_DEBUG$/);
  });

  it('debug: the user\'s extraArgs follow the debug define, so their own define wins', () => {
    const argv = buildArgs(
      { command: 'build', debug: true, noCheck: false, jobs: 2, extraArgs: ['--define', '__global_cflags -Og -g'] },
      { runHarbourCheck: true, jobs: 0 },
    );
    assert.deepStrictEqual(argv, [
      'build',
      '-d',
      '-j',
      '2',
      '--',
      '--define',
      `__global_cflags ${DEBUG_GLOBAL_CFLAGS}`,
      '--define',
      '__global_cflags -Og -g',
    ]);
  });

  it('release: no define and no -- without extraArgs', () => {
    const argv = buildArgs({ command: 'build', debug: false, noCheck: false }, { runHarbourCheck: true, jobs: 0 });
    assert.deepStrictEqual(argv, ['build']);
  });

  it('prepare:true adds --prepare before --no-check', () => {
    const argv = buildArgs({ command: 'build', prepare: true }, { runHarbourCheck: false, jobs: 0 });
    assert.deepStrictEqual(argv, ['build', '--prepare', '--no-check']);
  });

  it('jobs from settings when > 0 and def.jobs is unset', () => {
    const argv = buildArgs({ command: 'build', noCheck: false }, { runHarbourCheck: true, jobs: 4 });
    assert.deepStrictEqual(argv, ['build', '-j', '4']);
  });

  it('def.jobs overrides settings jobs', () => {
    const argv = buildArgs({ command: 'build', noCheck: false, jobs: 8 }, { runHarbourCheck: true, jobs: 4 });
    assert.deepStrictEqual(argv, ['build', '-j', '8']);
  });

  it('extraArgs appended after --', () => {
    const argv = buildArgs(
      { command: 'build', noCheck: false, extraArgs: ['--define', 'x 1'] },
      { runHarbourCheck: true, jobs: 0 },
    );
    assert.deepStrictEqual(argv, ['build', '--', '--define', 'x 1']);
  });

  it('sign adds --sign and the signing -c options before the command', () => {
    const argv = buildArgs(
      { command: 'build' },
      { runHarbourCheck: true, jobs: 0, sign: true, signingUser: 'Jane Doe', signingPassphraseFile: '/home/jane/pass.txt' },
    );
    assert.deepStrictEqual(argv, [
      '-c',
      'package.signing-user=Jane Doe',
      '-c',
      'package.signing-passphrase-file=/home/jane/pass.txt',
      'build',
      '--sign',
    ]);
  });

  it('sign with no user or passphrase file leaves them to sfdk config', () => {
    const argv = buildArgs({ command: 'build' }, { runHarbourCheck: true, jobs: 0, sign: true });
    assert.deepStrictEqual(argv, ['build', '--sign']);
  });

  it('signing user and passphrase file are ignored while sign is off', () => {
    const argv = buildArgs(
      { command: 'build' },
      { runHarbourCheck: true, jobs: 0, sign: false, signingUser: 'Jane Doe', signingPassphraseFile: '/p' },
    );
    assert.deepStrictEqual(argv, ['build']);
  });

  it('never emits -c target=/-c device= (SfdkRunner options do that)', () => {
    const argv = buildArgs(
      { command: 'build', target: 'SailfishOS-4.4.0.58-aarch64', device: 'Emulator' },
      { runHarbourCheck: false, jobs: 0 },
    );
    assert.ok(!argv.includes('-c'));
  });
});

describe('argv.deployArgs (FR-5.4)', () => {
  it('default method from settings', () => {
    assert.deepStrictEqual(deployArgs({ command: 'deploy' }, { method: 'sdk' }), ['deploy', '--sdk']);
  });

  for (const method of ['sdk', 'pkcon', 'rsync', 'zypper', 'zypper-dup', 'manual'] as const) {
    it(`--${method} for deployMethod ${method}`, () => {
      assert.deepStrictEqual(deployArgs({ command: 'deploy', deployMethod: method }, { method: 'sdk' }), [
        'deploy',
        `--${method}`,
      ]);
    });
  }

  it('debug:true adds --debug', () => {
    assert.deepStrictEqual(deployArgs({ command: 'deploy', debug: true }, { method: 'pkcon' }), [
      'deploy',
      '--pkcon',
      '--debug',
    ]);
  });
});

describe('argv.packageArgs (FR-5.6)', () => {
  it('sign adds --sign and the signing -c options before the command', () => {
    assert.deepStrictEqual(
      packageArgs({ command: 'package' }, { sign: true, signingUser: 'Jane Doe', signingPassphraseFile: '/home/jane/p.txt' }),
      ['-c', 'package.signing-user=Jane Doe', '-c', 'package.signing-passphrase-file=/home/jane/p.txt', 'package', '--sign'],
    );
    assert.deepStrictEqual(packageArgs({ command: 'package' }, { sign: false, signingUser: 'Jane Doe' }), ['package']);
  });

  it('bare package', () => {
    assert.deepStrictEqual(packageArgs({ command: 'package' }), ['package']);
  });

  it('noCheck adds --no-check', () => {
    assert.deepStrictEqual(packageArgs({ command: 'package', noCheck: true }), ['package', '--no-check']);
  });
});

describe('argv.checkArgs / cleanArgs (FR-5.6)', () => {
  it('check is thin', () => {
    assert.deepStrictEqual(checkArgs(), ['check']);
  });

  it('clean prefers make -- clean when a native build dir is detected', () => {
    assert.deepStrictEqual(cleanArgs(true), ['make', '--', 'clean']);
  });

  it('clean falls back to build-shell rm -rf otherwise', () => {
    assert.deepStrictEqual(cleanArgs(false), ['build-shell', '--', 'rm', '-rf', 'RPMS', 'BUILD', 'BUILDROOT']);
  });
});

describe('argv.isValidAppName (NFR-20)', () => {
  it('accepts alnum, dot, underscore, dash', () => {
    assert.strictEqual(isValidAppName('harbour-demo'), true);
    assert.strictEqual(isValidAppName('harbour.demo_2'), true);
  });

  it('rejects shell metacharacters and injection payloads', () => {
    for (const bad of ['harbour-demo; rm -rf /', 'harbour demo', '$(reboot)', '`id`', 'a\nb', '../etc/passwd']) {
      assert.strictEqual(isValidAppName(bad), false, bad);
    }
  });
});

describe('argv.runArgs (FR-5.5)', () => {
  it('includes a pkill step by default (killBeforeLaunch true)', () => {
    const result = runArgs('/usr/bin/harbour-demo', ['sailfish-qml', 'harbour-demo'], { killBeforeLaunch: true });
    assert.deepStrictEqual(result.pkillArgs, ['device', 'exec', '--', 'pkill', '-f', '/usr/bin/harbour-demo']);
    assert.deepStrictEqual(result.launchArgs, ['device', 'exec', '--', 'sailfish-qml', 'harbour-demo']);
  });

  it('omits the pkill step when killBeforeLaunch is false', () => {
    const result = runArgs('/usr/bin/harbour-demo', ['sailfish-qml', 'harbour-demo'], { killBeforeLaunch: false });
    assert.strictEqual(result.pkillArgs, undefined);
  });

  it('omits the pkill step when the binary name fails NFR-20 validation (R25)', () => {
    const result = runArgs('/usr/bin/harbour-demo; rm -rf /', ['sailfish-qml', 'x'], { killBeforeLaunch: true });
    assert.strictEqual(result.pkillArgs, undefined);
  });
});
