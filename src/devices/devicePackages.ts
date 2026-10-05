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
 * input box, then runs `devel-su` through `device exec -t -t` and feeds the password when `devel-su`
 * prompts. The device downloads from Jolla's repositories, so it needs internet access; package
 * lists are refreshed first (stale lists make pkcon exit 4).
 * Resolves with the exit code; undefined if cancelled or spawning failed.
 */
export function installOnDevice(services: Services, device: string, packages: readonly string[]): Promise<number | undefined> {
  return runAsRootOnDevice(services, device, {
    title: `Install ${packages.join(', ')} on "${device}"`,
    prompt: 'Developer-mode password of the device (Settings → Developer tools). The device needs internet access.',
    progressTitle: `Installing ${packages.join(', ')} on "${device}"…`,
    script: installScript(packages),
  });
}

export interface RootShellOptions {
  /** Title of the password input box. */
  title: string;
  /** Prompt of the password input box. */
  prompt: string;
  /** Title of the progress notification while the script runs. */
  progressTitle: string;
  /** The script `devel-su sh -c <script>` runs; fixed text, never user or device data. */
  script: string;
  timeoutMs?: number;
}

/**
 * Runs a fixed script as root on `device` without a terminal: asks for the developer-mode password
 * in an input box, then runs `devel-su` through `device exec -t -t` and feeds the password when
 * `devel-su` prompts. `-t` follows ssh: with our stdin a pipe, a single `-t` allocates no pty on
 * the device; the doubled form forces one, as `ssh -tt` does, so `devel-su` gets a terminal. The
 * password is never put in argv or the environment.
 * Resolves with the exit code; undefined if cancelled or spawning failed.
 */
export async function runAsRootOnDevice(services: Services, device: string, opts: RootShellOptions): Promise<number | undefined> {
  const password = await services.prompts.showInputBox({
    title: opts.title,
    prompt: opts.prompt,
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return undefined;

  const sfdkPath = services.sdk.current()?.sfdkPath ?? 'sfdk';
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: opts.progressTitle, cancellable: true },
    (_progress, token) =>
      new Promise<number | undefined>((resolve) => {
        const child = spawn(sfdkPath, ['device', 'exec', device, '-t', '-t', '--', 'devel-su', 'sh', '-c', opts.script], {
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
        // No password prompt seen: never feed the secret blindly to whatever is reading stdin.
        const promptTimer = setTimeout(() => {
          if (!sentPassword) child.kill('SIGTERM');
        }, PASSWORD_PROMPT_TIMEOUT_MS);
        const killTimer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? INSTALL_TIMEOUT_MS);
        const cancel = token.onCancellationRequested(() => child.kill('SIGTERM'));
        const finish = (code: number | undefined): void => {
          clearTimeout(promptTimer);
          clearTimeout(killTimer);
          cancel.dispose();
          if (code !== 0) {
            services.output.log('warn', `root shell on ${device} failed (exit ${code}): ${output.slice(-OUTPUT_TAIL_CHARS)}`);
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
