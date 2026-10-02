/** Pure parts of devicePackages.ts (no `vscode` import, unit-testable under plain mocha). */

/** What the SDK needs on a device: rsync (every deploy method copies with it), sdk-deploy-rpm (--sdk installs) and gdbserver (debugging). */
export const DEVICE_TOOL_PACKAGES = ['rsync', 'sdk-deploy-rpm', 'gdb-gdbserver'] as const;

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

