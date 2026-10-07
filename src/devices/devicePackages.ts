import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Services } from '../core/services';
import {
  CHECK_TOOLS_SCRIPT,
  DEFAULT_ROOT_SHELL_LIMITS,
  TOOL_CHECK_TIMEOUT_MS,
  RootShellWatch,
  classifyToolCheck,
  installOutcomeMessage,
  installPlan,
  installScript,
  parseInstallProgress,
  rootShellAbortMessage,
  rootShellProgressMessage,
  toolCheckFailureMessage,
  type RootShellLimits,
  type ToolCheckOutcome,
} from './devicePackagesCore';
import { ensureDeviceOnline, reportOffline } from './offlineGuard';

export { DEVICE_TOOL_PACKAGES } from './devicePackagesCore';

/**
 * Which tool packages the device lacks, via a read-only exec (no root). Tells "the check could not
 * run" (device unreachable, sfdk error) apart from "the check ran" (see ToolCheckOutcome).
 */
export async function checkDeviceTools(
  services: Services,
  device: string,
  cwd?: string,
  token?: vscode.CancellationToken,
): Promise<ToolCheckOutcome> {
  const result = await services.runner.run({
    args: ['device', 'exec', '--', 'sh', '-c', CHECK_TOOLS_SCRIPT],
    device,
    cwd,
    token,
    timeoutMs: TOOL_CHECK_TIMEOUT_MS,
  });
  const outcome = classifyToolCheck(result);
  if (outcome.kind !== 'checked') services.output.log('warn', `tool check on "${device}": ${outcome.kind}${'detail' in outcome ? ` (${outcome.detail})` : ''}`);
  return outcome;
}

/**
 * The reachability probe, then the tool check, under one cancellable notification. Shows the
 * offline message (with Retry) when the device cannot be reached, so callers only see
 * 'checked', 'unparseable', 'failed' or 'cancelled' — or 'unreachable' when the user gave up.
 */
export async function checkDeviceToolsGuarded(services: Services, device: string, cwd?: string): Promise<ToolCheckOutcome> {
  for (;;) {
    if (!(await ensureDeviceOnline(services, device))) return { kind: 'unreachable', detail: 'offline' };
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Sailfish', cancellable: true },
      (progress, token) => {
        progress.report({ message: `checking deploy and debug tools on "${device}"…` });
        return checkDeviceTools(services, device, cwd, token);
      },
    );
    if (outcome.kind !== 'unreachable') return outcome;
    if (!(await reportOffline(services, device, outcome.detail))) return outcome;
  }
}

export const INSTALL_ON_DEVICE = 'Install on device';

const OUTPUT_TAIL_CHARS = 2000;
/** After SIGTERM, how long sfdk (and the ssh it runs) get before SIGKILL. */
const KILL_GRACE_MS = 3000;
/** After the process exited, how long to wait for its pipes to close (a leftover ssh can hold them open). */
const CLOSE_GRACE_MS = 1000;
const WATCH_INTERVAL_MS = 1000;

/**
 * Installs packages on `device` without a terminal: asks for the developer-mode password in an
 * input box, then runs `devel-su` through `device exec -t -t` and feeds the password when `devel-su`
 * prompts. The device downloads from Jolla's repositories, so it needs internet access; package
 * lists are refreshed first (stale lists make pkcon exit 4).
 * Resolves with the exit code; undefined if cancelled, or when it failed and the user was already told why.
 */
export function installOnDevice(services: Services, device: string, packages: readonly string[]): Promise<number | undefined> {
  return runAsRootOnDevice(services, device, {
    title: `Install ${packages.join(', ')} on "${device}"`,
    prompt: 'Developer-mode password of the device (Settings → Developer tools). The device needs internet access.',
    progressTitle: `Sailfish: install ${packages.join(', ')} on "${device}"`,
    workingMessage: `installing ${packages.join(', ')}…`,
    script: installScript(packages),
    streamOutput: true,
  });
}

export interface RootShellOptions {
  /** Title of the password input box. */
  title: string;
  /** Prompt of the password input box. */
  prompt: string;
  /** Title of the progress notification while the script runs; the message says the phase (connecting, password, step). */
  progressTitle: string;
  /** The progress message once the script runs and no step was parsed yet; default "working…". */
  workingMessage?: string;
  /** The script `devel-su sh -c <script>` runs; fixed text, never user or device data. */
  script: string;
  /** Overall limit; default 10 min. */
  timeoutMs?: number;
  /** Log the script's output lines to the output channel and show the current step in the progress notification. */
  streamOutput?: boolean;
}

/** Signals sfdk and everything it started (its own process group, see the spawn), falling back to the child alone. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Runs a fixed script as root on `device` without a terminal: asks for the developer-mode password
 * in an input box, then runs `devel-su` through `device exec -t -t` and feeds the password when
 * `devel-su` prompts. `-t` follows ssh: with our stdin a pipe, a single `-t` allocates no pty on
 * the device; the doubled form forces one, as `ssh -tt` does, so `devel-su` gets a terminal. The
 * password is never put in argv or the environment.
 *
 * The notification says what it waits for (connecting, checking the password, the current step).
 * The run is stopped when the device does not prompt within 30 s, stays silent for 3 min after the
 * password, the ssh session drops, the password is refused, or the overall limit passes; the user
 * is then told why. Cancel and every stop kill sfdk's whole process group (SIGTERM, then SIGKILL),
 * and the notification closes even if a leftover process keeps the pipes open.
 * When the device's SSH port does not answer, the user is told it is offline (with Retry) before
 * any password is asked for.
 * Resolves with the exit code; undefined if cancelled, or when it failed and the user was already told why.
 */
export async function runAsRootOnDevice(services: Services, device: string, opts: RootShellOptions): Promise<number | undefined> {
  // Do not ask for a password a device that cannot be reached would never get to check.
  if (!(await ensureDeviceOnline(services, device))) return undefined;
  const password = await services.prompts.showInputBox({
    title: opts.title,
    prompt: opts.prompt,
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return undefined;

  const limits: RootShellLimits = { ...DEFAULT_ROOT_SHELL_LIMITS, overallMs: opts.timeoutMs ?? DEFAULT_ROOT_SHELL_LIMITS.overallMs };
  const working = opts.workingMessage ?? 'working…';
  const sfdkPath = services.sdk.current()?.sfdkPath ?? 'sfdk';
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: opts.progressTitle, cancellable: true },
    (progress, token) =>
      new Promise<number | undefined>((resolve) => {
        const watch = new RootShellWatch(limits, Date.now());
        let lastStep: { step: string; percent?: number } | undefined;
        let shown = '';
        const show = (): void => {
          const message = rootShellProgressMessage(device, watch.phase, working, lastStep);
          if (message !== shown) progress.report({ message });
          shown = message;
        };
        show();

        let child: ChildProcess;
        try {
          // Own process group (detached), so a kill reaches the ssh sfdk runs as well (killTree).
          child = spawn(sfdkPath, ['device', 'exec', device, '-t', '-t', '--', 'devel-su', 'sh', '-c', opts.script], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
          });
        } catch (err) {
          void services.prompts.showErrorMessage(`Sailfish: could not start sfdk: ${err instanceof Error ? err.message : String(err)}`);
          resolve(undefined);
          return;
        }
        let output = '';
        let pending = '';
        let settled = false;
        let cancelled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let closeTimer: ReturnType<typeof setTimeout> | undefined;

        const stop = (): void => {
          if (killTimer) return;
          killTree(child, 'SIGTERM');
          killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
        };
        const sendPassword = (): void => {
          if (!child.stdin || child.stdin.destroyed) return;
          child.stdin.write(`${password}\n`);
        };
        const onLine = (raw: string): void => {
          const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
          if (!line) return;
          if (watch.onOutput(line, Date.now()) === 'send-password') sendPassword();
          if (watch.aborted) stop();
          if (/password:/i.test(line)) return show();
          if (opts.streamOutput) {
            services.output.log('info', `[${device}] ${line}`);
            lastStep = parseInstallProgress(line) ?? lastStep;
          }
          show();
        };
        const onData = (chunk: Buffer): void => {
          const text = chunk.toString();
          output += text;
          if (output.length > 4 * OUTPUT_TAIL_CHARS) output = output.slice(-2 * OUTPUT_TAIL_CHARS);
          pending += text;
          const lines = pending.split(/[\r\n]+/);
          pending = lines.pop() ?? '';
          for (const line of lines) onLine(line);
          // devel-su's "Password:" prompt has no newline after it.
          if (/password:\s*$/i.test(pending)) {
            onLine(pending);
            pending = '';
          }
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.stdin?.on('error', () => undefined);

        const watchTimer = setInterval(() => {
          if (watch.check(Date.now())) stop();
        }, WATCH_INTERVAL_MS);
        const cancel = token.onCancellationRequested(() => {
          cancelled = true;
          stop();
        });

        const finish = (code: number | undefined): void => {
          if (settled) return;
          settled = true;
          clearInterval(watchTimer);
          if (killTimer) clearTimeout(killTimer);
          if (closeTimer) clearTimeout(closeTimer);
          cancel.dispose();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
          if (pending.trim()) onLine(pending);
          const reason = watch.aborted;
          if (code !== 0 || reason) {
            services.output.log('warn', `root shell on ${device} ${cancelled ? 'cancelled' : `failed (${reason ?? `exit ${code}`})`}: ${output.slice(-OUTPUT_TAIL_CHARS)}`);
          }
          if (cancelled) return resolve(undefined);
          if (reason) {
            void services.prompts.showErrorMessage(rootShellAbortMessage(device, reason, limits));
            return resolve(undefined);
          }
          resolve(code);
        };
        child.on('error', (err) => {
          void services.prompts.showErrorMessage(`Sailfish: could not run sfdk: ${err.message}`);
          cancelled = true; // already reported
          finish(undefined);
        });
        // 'close' waits for the pipes; a leftover ssh holding them must not keep the notification open.
        child.on('exit', (code) => {
          closeTimer = setTimeout(() => finish(code ?? undefined), CLOSE_GRACE_MS);
        });
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
    const check = await checkDeviceToolsGuarded(services, device, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    const plan = installPlan(check);
    if (plan.action === 'stop') {
      if (plan.message) void services.prompts.showErrorMessage(toolCheckFailureMessage(device, plan.message));
      return;
    }
    if (plan.action === 'none') {
      void services.prompts.showInformationMessage(`All deploy and debug tools are already installed on "${device}".`);
      return;
    }
    const packages = plan.packages;
    if (check.kind === 'checked') void services.prompts.showInformationMessage(`Sailfish: missing on "${device}": ${packages.join(', ')}. Installing only these.`);
    const exitCode = await installOnDevice(services, device, packages);
    // undefined: cancelled, or a stop the user was already told about (offline, dropped, timeout).
    if (exitCode === undefined) return;
    const outcome = installOutcomeMessage(device, packages, exitCode);
    void (outcome.ok ? services.prompts.showInformationMessage(outcome.message) : services.prompts.showErrorMessage(outcome.message));
  };
}
