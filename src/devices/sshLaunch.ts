import type { SfdkDeviceInfo } from '../core/types';
import { sfdkDeviceName } from './listParsing';

/** Pure argv builder for FR-6.6 (`sardina.device.openSsh`); no `vscode` import so it's unit-testable under plain mocha. */
export interface TerminalLaunch {
  shellPath: string;
  shellArgs: string[];
}

/** `ssh -p <port> -i <privateKey> -- <user>@<host>` when known, else `<sfdkPath> device exec <name> -t`; `--` guards a `-`-prefixed user/host. */
export function buildSshLaunch(device: SfdkDeviceInfo, sfdkPath: string): TerminalLaunch {
  if (
    device.privateKey &&
    device.host &&
    device.port !== undefined &&
    device.user &&
    !device.user.startsWith('-') &&
    !device.host.startsWith('-')
  ) {
    return {
      shellPath: 'ssh',
      shellArgs: ['-p', String(device.port), '-i', device.privateKey, '--', `${device.user}@${device.host}`],
    };
  }
  return { shellPath: sfdkPath, shellArgs: ['device', 'exec', sfdkDeviceName(device), '-t'] };
}
