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
  if (/no build target|no default target|no such target|target .* not found/i.test(stderr)) {
    return { message: stderr.trim(), actionLabel: 'Select target' };
  }
  return undefined;
}
