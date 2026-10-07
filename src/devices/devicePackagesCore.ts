/** Pure parts of devicePackages.ts (no `vscode` import, unit-testable under plain mocha). */

/** What the SDK needs on a device: rsync (every deploy method copies with it), sdk-deploy-rpm (--sdk installs) and gdbserver (debugging). */
export const DEVICE_TOOL_PACKAGES = ['rsync', 'sdk-deploy-rpm', 'gdb-gdbserver'] as const;

/** Each tool the SDK needs, the command that proves it is present, and the package that provides it. */
const TOOL_CHECKS = [
  { command: 'rsync', pkg: 'rsync' },
  { command: 'sdk-deploy-rpm', pkg: 'sdk-deploy-rpm' },
  { command: 'gdbserver', pkg: 'gdb-gdbserver' },
] as const;

const CHECK_MARK = 'sfdev-tool';

/** Read-only (no root) script for `device exec -- sh -c`: reports `sfdev-tool:<command>:ok|missing` for each tool. Fixed text. */
export const CHECK_TOOLS_SCRIPT = `for c in ${TOOL_CHECKS.map((t) => t.command).join(' ')}; do if command -v "$c" >/dev/null 2>&1; then echo "${CHECK_MARK}:$c:ok"; else echo "${CHECK_MARK}:$c:missing"; fi; done`;

/**
 * Parses CHECK_TOOLS_SCRIPT's output into the packages that are missing, in DEVICE_TOOL_PACKAGES order.
 * Undefined ("could not check") unless every tool was reported exactly as ok or missing. Package names
 * come from the constants above, never from the output.
 */
export function parseToolCheck(output: string): string[] | undefined {
  const seen = new Map<string, boolean>();
  for (const line of output.split(/\r?\n/)) {
    const m = new RegExp(`^${CHECK_MARK}:([^:]+):(ok|missing)\\s*$`).exec(line);
    if (m) seen.set(m[1], m[2] === 'ok');
  }
  const missing: string[] = [];
  for (const t of TOOL_CHECKS) {
    const present = seen.get(t.command);
    if (present === undefined) return undefined;
    if (!present) missing.push(t.pkg);
  }
  return missing;
}

/** What to install: the missing packages, or all of them when the check could not tell. */
export function packagesToInstall(missing: readonly string[] | undefined): readonly string[] {
  return missing ?? DEVICE_TOOL_PACKAGES;
}

/** A step and optional percent read from a line of `pkcon` output; undefined when the line says neither. */
export function parseInstallProgress(line: string): { step: string; percent?: number } | undefined {
  const stepMatch = /(refresh|download|install|resolv|dependenc|updat|query|wait|finish)/i.exec(line);
  const pct = /(\d{1,3})\s*%/.exec(line);
  const percent = pct && Number(pct[1]) <= 100 ? Number(pct[1]) : undefined;
  if (!stepMatch && percent === undefined) return undefined;
  const word = stepMatch?.[1].toLowerCase();
  const step =
    word === undefined ? '' : word.startsWith('refresh') ? 'refreshing' : word.startsWith('download') ? 'downloading' : word.startsWith('install') ? 'installing' : word;
  return percent === undefined ? { step } : { step, percent };
}

/** One root shell: refresh the package lists, then install. Package names are fixed constants, never user input. */
export function installScript(packages: readonly string[]): string {
  return `pkcon refresh && pkcon install -y ${packages.join(' ')}`;
}

/** What to tell the user after the install finishes. */
export function installOutcomeMessage(device: string, packages: readonly string[], exitCode: number | undefined): { ok: boolean; message: string } {
  if (exitCode === 0) {
    return { ok: true, message: `Sailfish: installed ${packages.join(', ')} on "${device}".` };
  }
  return {
    ok: false,
    message:
      `Sailfish: installing ${packages.join(', ')} on "${device}" failed${exitCode === undefined ? '' : ` (exit ${exitCode})`}. ` +
      'Check that the device has internet access (Wi-Fi or mobile data), that you typed the developer-mode password, ' +
      "and the Sailfish OS output channel for which package was not found.",
  };
}

