import type { Services } from '../core/services';
import type { SfdkDeviceInfo } from '../core/types';
import { spawnCapture } from '../sfdk/runner';
import { extractVmNameFromShowOutput, matchVboxVmName, parseVboxVmNames } from './vmCorrelationCore';

export { extractVmNameFromShowOutput, matchVboxVmName, parseVboxVmNames };

/**
 * FR-6.8: best-effort VirtualBox VM name correlation for an emulator.
 * `sfdk emulator show` first (key containing "vm"), then `VBoxManage list
 * vms` (spawnCapture never throws; ENOENT -> exitCode -1), then exact,
 * then substring/version match, else `undefined`. Never throws.
 */
export async function correlateVm(
  services: Services,
  device: SfdkDeviceInfo,
  /** Reuses a caller's own `emulator show` stdout (already exit-0-checked) so it is never invoked twice. */
  knownShowOutput?: string,
): Promise<string | undefined> {
  try {
    if (device.vmName) {
      return device.vmName;
    }

    try {
      let stdout = knownShowOutput;
      if (stdout === undefined) {
        const shown = await services.runner.run({ args: ['emulator', 'show', device.name], ensureEngine: false });
        stdout = shown.exitCode === 0 ? shown.stdout : undefined;
      }
      const vm = stdout ? extractVmNameFromShowOutput(stdout) : undefined;
      if (vm) {
        return vm;
      }
    } catch {
      // fall through to the VBoxManage probe below
    }

    const vbox = await spawnCapture('VBoxManage', ['list', 'vms'], { timeoutMs: 5000 });
    if (vbox.exitCode !== 0) {
      return undefined;
    }
    return matchVboxVmName(parseVboxVmNames(vbox.stdout), device.name);
  } catch {
    return undefined;
  }
}
