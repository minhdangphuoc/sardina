/** M1.17 stderr -> notification mapping, pure and unit-tested. Task D. */

export interface MappedError {
  message: string;
  actionLabel?: string;
}

/** Deploy-time stderr mapping (FR-5.4/M1.17). Never surfaces a password prompt. */
export function mapDeployError(stderr: string): MappedError | undefined {
  if (/\b(rsync|sdk-deploy-rpm): (command )?not found/i.test(stderr)) {
    return {
      message: 'The device is missing rsync or sdk-deploy-rpm, which deploying needs. Install them on the device (it needs internet access)',
      actionLabel: 'Install on device',
    };
  }
  if (/installing untrusted software disabled/i.test(stderr)) {
    return {
      message:
        'The device refuses unsigned packages. On the device, open Settings → Developer tools and turn on "Allow installing untrusted software" (it needs Developer Mode), then deploy again',
    };
  }
  if (/User aborted/i.test(stderr)) {
    return { message: 'The installation was declined or not confirmed on the device' };
  }
  if (/required configuration option 'device' is not set/i.test(stderr)) {
    return { message: 'No device selected — pick a default device or emulator', actionLabel: 'Select device' };
  }
  if (/no route to host|unable to connect|connection timed out|connect to host/i.test(stderr)) {
    return { message: 'Device unreachable', actionLabel: 'Open Devices view' };
  }
  if (/permission denied \(publickey/i.test(stderr)) {
    return { message: "SSH authentication failed — check the device's SSH key" };
  }
  if (/no rpm packages? found|no package found to deploy/i.test(stderr)) {
    return { message: 'Build first', actionLabel: 'Build' };
  }
  return undefined;
}

/** Build-time stderr mapping (FR-5.3/M1.17). */
export function mapBuildError(stderr: string): MappedError | undefined {
  if (/Failed to import GPG key from file|Failed to share GnuPG key/i.test(stderr) && !/passphrase/i.test(stderr)) {
    return {
      message:
        'sfdk could not hand the signing key to the build engine. This usually means several keys match the configured name. Run "Sardina: Set Up Package Signing" to select the key by its fingerprint',
      actionLabel: 'Set up signing',
    };
  }
  if (/passphrase protected and no passphrase was specified/i.test(stderr)) {
    return {
      message:
        'The signing key is protected by a passphrase, but none is set. Run "Sardina: Set Up Package Signing" and enter it, or turn off sardina.build.sign',
      actionLabel: 'Set up signing',
    };
  }
  if (/no build target|no default target|no such target|target .* not found/i.test(stderr)) {
    return { message: stderr.trim(), actionLabel: 'Select target' };
  }
  const missing = missingInstallPaths(stderr);
  if (missing.length > 0) {
    const shown = missing.slice(0, 3).join(', ');
    const list = missing.length > 3 ? `${shown} and ${missing.length - 3} more` : shown;
    return {
      message: `Packaging failed: the spec lists ${list} in %files, but the build did not install it. Check the %files section and the INSTALLS in the .pro`,
    };
  }
  return undefined;
}

const MISSING_RE = /^\s*(?:error: )?(File|Directory) not found(?: by glob)?:\s*(\S*?\/installroot)?(\/\S+)/;

/** Paths rpmbuild could not find in the install root; a directory is dropped when a file below it is also missing. */
function missingInstallPaths(stderr: string): string[] {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = MISSING_RE.exec(line);
    if (!m) {
      continue;
    }
    const list = m[1] === 'Directory' ? dirs : files;
    if (!list.includes(m[3])) {
      list.push(m[3]);
    }
  }
  const keptDirs = dirs.filter((d) => !files.some((f) => f.startsWith(d.replace(/\/+$/, '') + '/')));
  return [...keptDirs, ...files];
}
