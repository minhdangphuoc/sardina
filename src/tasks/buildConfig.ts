/**
 * Labels for the build-type and deploy-method status bar selectors, named after
 * Qt Creator's build and deploy configurations where one exists. No `vscode`
 * import so this can be unit-tested directly under plain mocha.
 */

import { DEBUG_GLOBAL_CFLAGS } from './argv';

export type BuildType = 'release' | 'debug';
export type DeployMethod = 'sdk' | 'pkcon' | 'rsync' | 'zypper' | 'zypper-dup' | 'manual';

export interface Choice<T extends string> {
  value: T;
  label: string;
  description: string;
}

export const BUILD_TYPES: ReadonlyArray<Choice<BuildType>> = [
  { value: 'release', label: 'Release', description: 'sfdk build' },
  { value: 'debug', label: 'Debug', description: 'sfdk build --enable-debug · unoptimised (-O0)' },
];

export const DEPLOY_METHODS: ReadonlyArray<Choice<DeployMethod>> = [
  { value: 'sdk', label: 'Deploy as RPM package', description: 'deploy --sdk · needs Developer Mode' },
  { value: 'rsync', label: 'Deploy by copying binaries', description: 'deploy --rsync · to /opt/sdk/<name>, no RPM install' },
  { value: 'manual', label: 'Copy RPM for manual install', description: 'deploy --manual · to ~/RPMS on the device' },
  { value: 'pkcon', label: 'Install RPM with pkcon', description: 'deploy --pkcon' },
  { value: 'zypper', label: 'Install RPM with zypper', description: 'deploy --zypper · needs zypper and root' },
  { value: 'zypper-dup', label: 'Install RPM with zypper dup', description: 'deploy --zypper-dup · needs zypper and root' },
];

/** Short status bar text for a deploy method; the full label goes in the tooltip. */
const DEPLOY_SHORT: Record<DeployMethod, string> = {
  sdk: 'RPM',
  rsync: 'Copy binaries',
  manual: 'Manual RPM',
  pkcon: 'pkcon',
  zypper: 'zypper',
  'zypper-dup': 'zypper dup',
};

export function buildTypeText(type: BuildType): string {
  return `$(gear) ${BUILD_TYPES.find((c) => c.value === type)?.label ?? type}`;
}

export function deployMethodText(method: DeployMethod): string {
  return `$(cloud-upload) ${DEPLOY_SHORT[method] ?? method}`;
}

export function deployMethodLabel(method: DeployMethod): string {
  return DEPLOY_METHODS.find((c) => c.value === method)?.label ?? method;
}

export function deviceText(device: string): string {
  return device ? `$(device-mobile) ${device}` : '$(device-mobile) No device';
}

/** `--manual` only copies the RPM to the device, so there is nothing installed to launch afterwards. */
export function deployInstallsApp(method: DeployMethod): boolean {
  return method !== 'manual';
}

const TARGET_ARCH_RE = /-(aarch64|armv7hl|i486)(?:\.|$)/;

/** `SailfishOS-5.1.0.11-aarch64` (or sfdk's `.sfdk/target` form `…-aarch64.default`) -> `aarch64`. */
export function targetArch(target: string): string | undefined {
  return TARGET_ARCH_RE.exec(target.trim())?.[1];
}

const CPPDBG_ARCH: Record<string, string> = { i486: 'x86', armv7hl: 'arm', aarch64: 'arm64' };

/** cppdbg's `targetArchitecture` for a target name; undefined when the architecture is unknown. */
export function cppdbgArchitecture(target: string | undefined): string | undefined {
  const arch = target ? targetArch(target) : undefined;
  return arch ? CPPDBG_ARCH[arch] : undefined;
}

/** `.sfdk/target` holds the last build's target as `<target>.<suffix>`; strips the suffix. */
export function lastBuildTarget(sfdkTargetFile: string): string | undefined {
  const line = sfdkTargetFile.trim().split(/\r?\n/)[0];
  if (!line) return undefined;
  const arch = targetArch(line);
  return arch ? line.slice(0, line.indexOf(`-${arch}`) + arch.length + 1) : undefined;
}

/**
 * The previous build target when its architecture differs from `nextTarget`'s, i.e. when the
 * in-source build output would be reused for the wrong architecture; undefined otherwise.
 */
export function staleBuildTarget(sfdkTargetFile: string | undefined, nextTarget: string): string | undefined {
  const previous = sfdkTargetFile === undefined ? undefined : lastBuildTarget(sfdkTargetFile);
  const before = previous && targetArch(previous);
  const after = targetArch(nextTarget);
  return before && after && before !== after ? previous : undefined;
}

/** Marks a Release build's flags: the platform's own `%__global_cflags` has it, the Debug one drops it. */
const RELEASE_FLAGS_MARK = '-Wp,-D_FORTIFY_SOURCE=2';

/**
 * The build type an in-source qmake Makefile was generated for, read from its `CXXFLAGS` line;
 * undefined when the flags match neither (no Makefile line, or flags the project set itself).
 */
export function makefileBuildType(makefile: string): BuildType | undefined {
  const flags = /^CXXFLAGS[ \t]*=(.*)$/m.exec(makefile)?.[1];
  if (flags === undefined) return undefined;
  if (flags.includes(DEBUG_GLOBAL_CFLAGS)) return 'debug';
  if (flags.includes(RELEASE_FLAGS_MARK)) return 'release';
  return undefined;
}

/**
 * True when the objects of the previous in-source qmake build were compiled for the other build
 * type. qmake's Makefiles do not make objects depend on the flags, so `sfdk build` would reuse them.
 */
export function staleBuildType(makefile: string | undefined, nextType: BuildType): boolean {
  if (makefile === undefined) return false;
  if (lacksQmlDebug(makefile)) return true;
  const previous = makefileBuildType(makefile);
  return previous !== undefined && previous !== nextType;
}

/** Older Debug builds lacked `-DQT_QML_DEBUG`; their objects would be reused without QML debugging. */
const DEBUG_FLAGS_WITHOUT_QML = DEBUG_GLOBAL_CFLAGS.replace(' -DQT_QML_DEBUG', '');

function lacksQmlDebug(makefile: string): boolean {
  const flags = /^CXXFLAGS[ \t]*=(.*)$/m.exec(makefile)?.[1] ?? '';
  return flags.includes(DEBUG_FLAGS_WITHOUT_QML) && !flags.includes(DEBUG_GLOBAL_CFLAGS);
}

/** Marker prefix for the device item: debug session -> `$(debug)`, other sessions -> `$(pulse)`. */
export function sessionMarker(sessions: ReadonlyArray<{ kind: string }>): string {
  if (sessions.some((s) => s.kind === 'debug')) return '$(debug) ';
  return sessions.length > 0 ? '$(pulse) ' : '';
}

/** Device item text with the session marker replacing the device icon, e.g. `$(debug) Jolla Phone`. */
export function deviceTextWithSessions(device: string, sessions: ReadonlyArray<{ kind: string }>): string {
  const marker = sessionMarker(sessions);
  return marker ? `${marker}${device || 'No device'}` : deviceText(device);
}

/** Tooltip line listing the active sessions and how to stop them; empty when none. */
export function sessionTooltip(device: string, sessions: ReadonlyArray<{ label: string }>): string {
  if (sessions.length === 0) return '';
  const labels = [...new Set(sessions.map((s) => s.label))].join(', ');
  return `Active on "${device}": ${labels}.\nTo stop them, run "Sardina: Stop Sessions on Device" (or use the stop button in the Devices view).`;
}

/** The Debug action button text: `$(debug-alt) Debugging…` while a debug session runs on the selected device. */
export function debugActionText(sessions: ReadonlyArray<{ kind: string }>): string {
  return sessions.some((s) => s.kind === 'debug') ? '$(debug-alt) Debugging…' : '$(debug-alt) Debug';
}
