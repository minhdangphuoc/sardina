import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import type { Services } from '../core/services';
import { DEVICE_TOOL_PACKAGES, installOutcomeMessage, installScript } from './devicePackagesCore';

export { DEVICE_TOOL_PACKAGES } from './devicePackagesCore';


export const INSTALL_ON_DEVICE = 'Install on device';

const PASSWORD_PROMPT_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 2000;

/**
 * Installs packages on `device` without a terminal: asks for the developer-mode password in an
 * input box, then runs `devel-su` through `device exec -t` (which gives the remote side a pty even
 * though our stdin is a pipe) and feeds the password when `devel-su` prompts. The password is
 * never put in argv or the environment. The device downloads from Jolla's repositories, so it
 * needs internet access; package lists are refreshed first (stale lists make pkcon exit 4).
 * Resolves with the exit code; undefined if cancelled or spawning failed.
 */
export async function installOnDevice(services: Services, device: string, packages: readonly string[]): Promise<number | undefined> {
  const password = await vscode.window.showInputBox({
    title: `Install ${packages.join(', ')} on "${device}"`,
    prompt: "Developer-mode password of the device (Settings → Developer tools). The device needs internet access.",
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return undefined;

  const sfdkPath = services.sdk.current()?.sfdkPath ?? 'sfdk';
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Installing ${packages.join(', ')} on "${device}"…`, cancellable: true },
    (_progress, token) =>
      new Promise<number | undefined>((resolve) => {
        const child = spawn(sfdkPath, ['device', 'exec', device, '-t', '--', 'devel-su', 'sh', '-c', installScript(packages)], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        let sentPassword = false;
        const sendPassword = (): void => {
          if (sentPassword) return;
          sentPassword = true;
          child.stdin.write(`${password}\n`);
        };
        const onData = (chunk: Buffer): void => {
          output += chunk.toString();
          if (/password:/i.test(output)) sendPassword();
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.stdin.on('error', () => undefined);
        const promptTimer = setTimeout(sendPassword, PASSWORD_PROMPT_TIMEOUT_MS);
        const killTimer = setTimeout(() => child.kill('SIGTERM'), INSTALL_TIMEOUT_MS);
        const cancel = token.onCancellationRequested(() => child.kill('SIGTERM'));
        const finish = (code: number | undefined): void => {
          clearTimeout(promptTimer);
          clearTimeout(killTimer);
          cancel.dispose();
          if (code !== 0) {
            services.output.log('warn', `install on ${device} failed (exit ${code}): ${output.slice(-OUTPUT_TAIL_CHARS)}`);
          }
          resolve(code);
        };
        child.on('error', () => finish(undefined));
        child.on('close', (code) => finish(code ?? undefined));
      }),
  );
}

/** "Sailfish: Install Deploy & Debug Tools on Device": for a right-clicked device, else the selected deploy device. */
export function installDeviceTools(services: Services) {
  return async (item?: unknown): Promise<void> => {
    const fromItem =
      item && typeof item === 'object' && 'device' in item ? (item as { device?: { name?: string } }).device?.name : undefined;
    const device = fromItem ?? services.settings.get('device', vscode.workspace.workspaceFolders?.[0]?.uri);
    if (!device) {
      void services.prompts.showWarningMessage('Sailfish: select a device first (status bar or Devices view).');
      return;
    }
    const exitCode = await installOnDevice(services, device, DEVICE_TOOL_PACKAGES);
    const outcome = installOutcomeMessage(device, DEVICE_TOOL_PACKAGES, exitCode);
    void (outcome.ok ? services.prompts.showInformationMessage(outcome.message) : services.prompts.showErrorMessage(outcome.message));
  };
}
