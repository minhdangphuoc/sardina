import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import type { Services } from '../core/services';
import {
  CHECK_TOOLS_SCRIPT,
  installOutcomeMessage,
  installScript,
  packagesToInstall,
  parseInstallProgress,
  parseToolCheck,
} from './devicePackagesCore';

export { DEVICE_TOOL_PACKAGES } from './devicePackagesCore';


/** Which of the tool packages the device lacks, via a read-only exec (no root); undefined when it could not be checked. */
export async function checkDeviceTools(services: Services, device: string, cwd?: string): Promise<string[] | undefined> {
  const result = await services.runner.run({
    args: ['device', 'exec', '--', 'sh', '-c', CHECK_TOOLS_SCRIPT],
    device,
    cwd,
    timeoutMs: 30_000,
  });
  return result.exitCode === 0 ? parseToolCheck(result.stdout) : undefined;
}

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
    streamOutput: true,
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
  /** Log the script's output lines to the output channel and show the current step in the progress notification. */
  streamOutput?: boolean;
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
    (progress, token) =>
      new Promise<number | undefined>((resolve) => {
        const child = spawn(sfdkPath, ['device', 'exec', device, '-t', '-t', '--', 'devel-su', 'sh', '-c', opts.script], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        let pending = '';
        let sentPassword = false;
        const sendPassword = (): void => {
          if (sentPassword) return;
          sentPassword = true;
          child.stdin.write(`${password}\n`);
        };
        const onData = (chunk: Buffer): void => {
          const text = chunk.toString();
          output += text;
          if (/password:/i.test(output)) sendPassword();
          if (!opts.streamOutput) return;
          pending += text;
          const lines = pending.split(/[\r\n]+/);
          pending = lines.pop() ?? '';
          for (const raw of lines) {
            const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
            if (!line || /password:/i.test(line)) continue;
            services.output.log('info', `[${device}] ${line}`);
            const p = parseInstallProgress(line);
            if (p) progress.report({ message: p.percent === undefined ? p.step : `${p.step} ${p.percent}%` });
          }
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
    const missing = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking deploy and debug tools on "${device}"…` },
      () => checkDeviceTools(services, device, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
    );
    if (missing?.length === 0) {
      void services.prompts.showInformationMessage(`All deploy and debug tools are already installed on "${device}".`);
      return;
    }
    const packages = packagesToInstall(missing);
    if (missing) void services.prompts.showInformationMessage(`Sailfish: missing on "${device}": ${packages.join(', ')}. Installing only these.`);
    const exitCode = await installOnDevice(services, device, packages);
    const outcome = installOutcomeMessage(device, packages, exitCode);
    void (outcome.ok ? services.prompts.showInformationMessage(outcome.message) : services.prompts.showErrorMessage(outcome.message));
  };
}
