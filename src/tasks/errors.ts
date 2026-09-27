/** M1.17 stderr -> notification mapping, pure and unit-tested. Task D. */

export interface MappedError {
  message: string;
  actionLabel?: string;
}

/** Deploy-time stderr mapping (FR-5.4/M1.17). Never surfaces a password prompt. */
export function mapDeployError(stderr: string): MappedError | undefined {
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
