/** Pure argv builders per FR-5.3..5.6. */

export interface SailfishTaskDefinitionLike {
  command: 'build' | 'deploy' | 'run' | 'package' | 'check' | 'clean' | 'matrix-build' | 'logs';
  target?: string;
  device?: string;
  debug?: boolean;
  prepare?: boolean;
  noCheck?: boolean;
  jobs?: number;
  extraArgs?: string[];
  deployMethod?: 'sdk' | 'pkcon' | 'rsync' | 'zypper' | 'zypper-dup' | 'manual';
  targets?: string[];
}

export interface SigningSettings {
  /** `sailfish.build.sign`: adds `--sign`; the user and passphrase file go in as session `-c` options. */
  sign?: boolean;
  signingUser?: string;
  signingPassphraseFile?: string;
}

/** Leading `-c` options naming the key; empty values are left to `sfdk config`. Only when signing. */
function signingConfigArgs(settings: SigningSettings): string[] {
  const args: string[] = [];
  if (settings.sign) {
    if (settings.signingUser) {
      args.push('-c', `package.signing-user=${settings.signingUser}`);
    }
    if (settings.signingPassphraseFile) {
      args.push('-c', `package.signing-passphrase-file=${settings.signingPassphraseFile}`);
    }
  }
  return args;
}

export interface BuildArgvSettings extends SigningSettings {
  runHarbourCheck: boolean;
  jobs: number;
  /** The `sailfish.build.type` selector; a task definition's own `debug` wins. */
  buildType?: 'release' | 'debug';
}

/**
 * The generic part of the platform's `%optflags` for a Debug build. `sfdk build -d` alone only keeps
 * the debuginfo packages: `%optflags` still starts with `-O2 -g`, and `%qmake5` (and `%cmake`) pass
 * it to the compiler. Redefining `%__global_cflags` keeps the per-architecture part of `%optflags`
 * (`-march`, `-mfloat-abi=hard`, ...) and drops `-O2` and `-D_FORTIFY_SOURCE=2`, which glibc warns
 * about without optimisation. Verified with the 5.1.0.11 targets.
 * `-DQT_QML_DEBUG` is all `CONFIG+=qml_debug` does: it compiles in the QML debugging support, which
 * opens nothing unless the app is started with `-qmljsdebugger`.
 */
export const DEBUG_GLOBAL_CFLAGS = '-O0 -g -pipe -Wall -fexceptions -fstack-protector --param=ssp-buffer-size=4 -Wformat -Wformat-security -DQT_QML_DEBUG';

/** rpmbuild arguments (after `sfdk build --`) that make a Debug build unoptimised. */
export const DEBUG_RPMBUILD_ARGS: readonly string[] = ['--define', `__global_cflags ${DEBUG_GLOBAL_CFLAGS}`];

/** FR-5.3. `-c target=`/`-c device=` are passed to SfdkRunner as options, not included here. */
export function buildArgs(def: SailfishTaskDefinitionLike, settings: BuildArgvSettings): string[] {
  const args: string[] = signingConfigArgs(settings);
  args.push('build');
  if (settings.sign) {
    args.push('--sign');
  }
  if (def.prepare) {
    args.push('--prepare');
  }
  const noCheck = def.noCheck ?? !settings.runHarbourCheck;
  if (noCheck) {
    args.push('--no-check');
  }
  const debug = def.debug ?? settings.buildType === 'debug';
  if (debug) {
    args.push('-d');
  }
  const jobs = def.jobs !== undefined && def.jobs > 0 ? def.jobs : settings.jobs > 0 ? settings.jobs : undefined;
  if (jobs !== undefined) {
    args.push('-j', String(jobs));
  }
  // The user's own rpmbuild arguments come last, so their own `--define '__global_cflags …'` wins.
  const rpmbuildArgs = [...(debug ? DEBUG_RPMBUILD_ARGS : []), ...(def.extraArgs ?? [])];
  if (rpmbuildArgs.length > 0) {
    args.push('--', ...rpmbuildArgs);
  }
  return args;
}

export interface DeployArgvSettings {
  method: NonNullable<SailfishTaskDefinitionLike['deployMethod']>;
}

/** FR-5.4. */
export function deployArgs(def: SailfishTaskDefinitionLike, settings: DeployArgvSettings): string[] {
  const method = def.deployMethod ?? settings.method;
  const args: string[] = ['deploy', `--${method}`];
  if (def.debug) {
    args.push('--debug');
  }
  return args;
}

/** FR-5.6 package. */
export function packageArgs(def: SailfishTaskDefinitionLike, settings: SigningSettings = {}): string[] {
  const args: string[] = [...signingConfigArgs(settings), 'package'];
  if (settings.sign) {
    args.push('--sign');
  }
  if (def.noCheck) {
    args.push('--no-check');
  }
  return args;
}

/** FR-5.6 check (thin FR-10 stand-in for v0.1). */
export function checkArgs(): string[] {
  return ['check'];
}

/** FR-5.6 clean: prefers `sfdk make -- clean`, else falls back to `sfdk build-shell -- rm -rf ...`. */
export function cleanArgs(hasNativeBuildDir: boolean): string[] {
  return hasNativeBuildDir
    ? ['make', '--', 'clean']
    : ['build-shell', '--', 'rm', '-rf', 'RPMS', 'BUILD', 'BUILDROOT'];
}

const APP_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** NFR-20: app-name validation before use in `pkill -f`/launcher argv. */
export function isValidAppName(name: string): boolean {
  return APP_NAME_RE.test(name);
}

export interface RunArgvSettings {
  killBeforeLaunch: boolean;
}

export interface RunArgv {
  /** `device exec -- pkill -f <appBinaryPath>`, omitted when disabled or the app name is invalid. */
  pkillArgs?: string[];
  launchArgs: string[];
}

/** FR-5.5: `device exec [--] <launcher...>`, optionally preceded by a pkill. */
export function runArgs(appBinaryPath: string, launcherTokens: string[], settings: RunArgvSettings): RunArgv {
  const launchArgs = ['device', 'exec', '--', ...launcherTokens];
  const name = appBinaryPath.split('/').pop() ?? '';
  if (settings.killBeforeLaunch && isValidAppName(name)) {
    return { pkillArgs: ['device', 'exec', '--', 'pkill', '-f', appBinaryPath], launchArgs };
  }
  return { launchArgs };
}
