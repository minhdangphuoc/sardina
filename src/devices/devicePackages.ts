import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Services } from '../core/services';
import {
  CHECK_PACKAGE_MANAGER_SCRIPT,
  CHECK_TOOLS_SCRIPT,
  DEFAULT_ROOT_SHELL_LIMITS,
  DEVICE_TOOL_PACKAGES,
  DevicePackageProgress,
  QML_DEBUG_SERVER_PACKAGE,
  TOOL_CHECK_TIMEOUT_MS,
  RootShellWatch,
  classifyToolCheck,
  cleanRootShellOutput,
  installOutcomeMessage,
  installPlan,
  installScript,
  packageManagerState,
  packageMonitorArgs,
  packageMonitorMessage,
  packageMonitorLogMessage,
  parseInstallProgress,
  parsePackageMonitorEvent,
  rootShellAbortMessage,
  rootShellProgressMessage,
  rootShellScript,
  removeToolsScript,
  toolCheckFailureMessage,
  type RootShellLimits,
  type PackageMonitorEvent,
  type ToolCheckOutcome,
} from './devicePackagesCore';
import { ensureDeviceOnline, reportOffline } from './offlineGuard';

export { DEVICE_TOOL_PACKAGES, QML_DEBUG_SERVER_PACKAGE };

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
      { location: vscode.ProgressLocation.Notification, title: 'Sardina', cancellable: true },
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
/** Let Ctrl+C cross the remote PTY before terminating local sfdk. */
const REMOTE_INTERRUPT_GRACE_MS = 500;
/** After the process exited, how long to wait for its pipes to close (a leftover ssh can hold them open). */
const CLOSE_GRACE_MS = 1000;
const WATCH_INTERVAL_MS = 1000;
const PACKAGE_MANAGER_CHECK_TIMEOUT_MS = 10_000;
/** One privileged operation per device in this extension host. */
const activeRootShellDevices = new Set<string>();

interface PackageMonitorHandle {
  dispose(): void;
}

/** Starts agent 1.12.0's read-only PackageKit observer. Older/missing agents silently fall back to pkcon text. */
async function startPackageMonitor(
  services: Services,
  device: string,
  packages: readonly string[],
  onEvent: (event: PackageMonitorEvent) => void,
): Promise<PackageMonitorHandle | undefined> {
  const cancellation = new vscode.CancellationTokenSource();
  let ready = false;
  let settleReady: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => {
    settleReady = resolve;
  });
  void services.runner
    .run({
      args: packageMonitorArgs(packages),
      device,
      token: cancellation.token,
      timeoutMs: 0,
      collectOutput: false,
      onLine: (line, stream) => {
        if (stream !== 'stdout') return;
        const event = parsePackageMonitorEvent(line, packages);
        if (!event) return;
        if (event.event === 'ready') {
          ready = true;
          settleReady?.();
        }
        onEvent(event);
      },
    })
    .then((result) => {
      if (!ready && !result.cancelled) services.output.log('debug', `package monitor unavailable on "${device}" (exit ${result.exitCode})`);
      settleReady?.();
    }).catch((error: unknown) => {
      services.output.log('debug', `package monitor unavailable on "${device}": ${error instanceof Error ? error.message : String(error)}`);
      settleReady?.();
    });
  const timer = setTimeout(() => settleReady?.(), 4000);
  await readyPromise;
  clearTimeout(timer);
  if (!ready) {
    cancellation.cancel();
    cancellation.dispose();
    return undefined;
  }
  return {
    dispose: () => {
      cancellation.cancel();
      cancellation.dispose();
    },
  };
}

/**
 * Installs packages on `device` without a terminal: asks for the developer-mode password in an
 * input box, then runs `devel-su` through `device exec -t -t` and feeds the password when `devel-su`
 * prompts. The device downloads from Jolla's repositories, so it needs internet access; package
 * The existing package metadata is tried first; if pkcon reports stale metadata, it is refreshed
 * and the install is retried.
 * Resolves with the exit code; undefined if cancelled, or when it failed and the user was already told why.
 */
export async function installOnDevice(services: Services, device: string, packages: readonly string[]): Promise<number | undefined> {
  const manager = await services.runner.run({
    args: ['device', 'exec', '--', 'sh', '-c', CHECK_PACKAGE_MANAGER_SCRIPT],
    device,
    timeoutMs: PACKAGE_MANAGER_CHECK_TIMEOUT_MS,
  });
  const managerState = packageManagerState(`${manager.stdout}\n${manager.stderr}`, manager.exitCode);
  if (managerState === 'busy') {
    void services.prompts.showWarningMessage(
      `Sardina: a package installation is already running on "${device}". Wait for it to finish; ` +
        'if it has been stuck for several minutes, reboot the device once before retrying.',
    );
    return undefined;
  }
  if (managerState === 'unknown') {
    void services.prompts.showErrorMessage(`Sardina: could not verify PackageKit availability on "${device}". Nothing was installed; see the Sardina output.`);
    return undefined;
  }
  return runAsRootOnDevice(services, device, {
    title: `Install ${packages.join(', ')} on "${device}"`,
    prompt: 'Developer-mode password of the device (Settings → Developer tools). The device needs internet access.',
    progressTitle: `Sardina: install ${packages.join(', ')} on "${device}"`,
    workingMessage: `installing ${packages.join(', ')}…`,
    script: installScript(packages),
    streamOutput: true,
    packageMonitor: packages,
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
  /** Fixed package names for the agent's optional read-only PackageKit observer. */
  packageMonitor?: readonly string[];
  packageOperation?: 'install' | 'remove';
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
  if (activeRootShellDevices.has(device)) {
    void services.prompts.showWarningMessage(
      `Sardina: another privileged operation is already running on "${device}". Wait for it to finish or cancel its notification.`,
    );
    return undefined;
  }
  activeRootShellDevices.add(device);
  try {
    return await runAsRootOnDeviceExclusive(services, device, opts);
  } finally {
    activeRootShellDevices.delete(device);
  }
}

async function runAsRootOnDeviceExclusive(services: Services, device: string, opts: RootShellOptions): Promise<number | undefined> {
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
  const guardedScript = rootShellScript(opts.script, limits.overallMs);
  let monitorText: string | undefined;
  let refreshMonitor = (): void => undefined;
  let stopVerifiedInstall = (): void => undefined;
  let verifiedComplete = false;
  let lastMonitorLog: string | undefined;
  const bar = new DevicePackageProgress(opts.packageMonitor ?? []);
  let pendingIncrement = 0;
  const monitor = opts.packageMonitor
    ? await startPackageMonitor(services, device, opts.packageMonitor, (event) => {
        monitorText = packageMonitorMessage(event) ?? monitorText;
        if (event.event === 'package' || event.event === 'status') {
          pendingIncrement += bar.update(event.phase, event.event === 'status' ? event.percentage : undefined, event.package);
        } else if (event.event === 'progress') {
          pendingIncrement += bar.update(undefined, event.percentage, event.package);
        }
        const done = (event.event === 'stalled' || event.event === 'finished') &&
          (opts.packageOperation === 'remove' ? event.installed.length === 0 : event.missing.length === 0);
        const logMessage = event.event === 'stalled' && opts.packageOperation === 'remove'
          ? (done ? 'tools removed; closing the stalled PackageKit client…' : 'waiting for PackageKit removal progress…')
          : packageMonitorLogMessage(event, done);
        if (logMessage && logMessage !== lastMonitorLog) {
          services.output.log(event.event === 'error' ? 'warn' : 'info', `[${device}] ${logMessage}`);
          lastMonitorLog = logMessage;
        }
        if (event.event === 'stalled' && done) {
          verifiedComplete = true;
          stopVerifiedInstall();
        }
        if (event.event === 'stalled' && opts.packageOperation === 'remove') {
          monitorText = done ? 'tools removed; closing the stalled PackageKit client…' : 'waiting for PackageKit removal progress…';
        }
        refreshMonitor();
      })
    : undefined;
  if (opts.streamOutput) {
    services.output.log('info', `[${device}] package ${opts.packageOperation === 'remove' ? 'removal' : 'installation'} output begins`);
    services.output.show();
  }
  try {
    return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `$(loading~spin) ${opts.progressTitle}`, cancellable: true },
    (progress, token) =>
      new Promise<number | undefined>((resolve) => {
        const watch = new RootShellWatch(limits, Date.now());
        let lastStep: { step: string; percent?: number } | undefined;
        let shown = '';
        const show = (): void => {
          const message = monitorText ?? rootShellProgressMessage(device, watch.phase, working, lastStep);
          if (message !== shown || pendingIncrement > 0) {
            progress.report({ message, ...(pendingIncrement > 0 ? { increment: pendingIncrement } : {}) });
            pendingIncrement = 0;
          }
          shown = message;
        };
        refreshMonitor = show;
        show();

        let child: ChildProcess;
        try {
          // Own process group (detached), so a kill reaches the ssh sfdk runs as well (killTree).
          child = spawn(sfdkPath, ['device', 'exec', device, '-t', '-t', '--', 'devel-su', 'sh', '-c', guardedScript], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
          });
        } catch (err) {
          void services.prompts.showErrorMessage(`Sardina: could not start sfdk: ${err instanceof Error ? err.message : String(err)}`);
          resolve(undefined);
          return;
        }
        let output = '';
        let pending = '';
        let settled = false;
        let cancelled = false;
        let termTimer: ReturnType<typeof setTimeout> | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let closeTimer: ReturnType<typeof setTimeout> | undefined;

        const stop = (): void => {
          if (termTimer || killTimer) return;
          // The remote command runs as root, so sfdk's default-user `kill` cannot stop it. Ctrl+C
          // through the allocated PTY reaches its foreground process group regardless of owner.
          try {
            child.stdin?.write('\x03');
          } catch {
            // The local process may already have closed its input.
          }
          termTimer = setTimeout(() => {
            killTree(child, 'SIGTERM');
            killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
          }, REMOTE_INTERRUPT_GRACE_MS);
        };
        stopVerifiedInstall = stop;
        if (verifiedComplete) stop();
        const sendPassword = (): void => {
          if (!child.stdin || child.stdin.destroyed) return;
          child.stdin.write(`${password}\n`);
        };
        const onLine = (raw: string): void => {
          const line = cleanRootShellOutput(raw);
          if (!line) return;
          if (watch.onOutput(line, Date.now()) === 'send-password') sendPassword();
          if (watch.aborted) stop();
          if (/password:/i.test(line)) return show();
          if (opts.streamOutput) {
            if (!monitor || !/^Percentage:/i.test(line)) services.output.log('info', `[${device}] ${line}`);
            const parsed = parseInstallProgress(line);
            if (parsed) {
              lastStep = { ...parsed, step: parsed.step || lastStep?.step || '' };
              // Prefer the observer when present; pkcon text is the fallback for old/absent agents.
              if (!monitor) pendingIncrement += bar.update(lastStep.step, parsed.percent);
            }
          }
          show();
        };
        const onData = (chunk: Buffer): void => {
          const text = chunk.toString();
          watch.onActivity(Date.now());
          output += text;
          if (output.length > 4 * OUTPUT_TAIL_CHARS) output = output.slice(-2 * OUTPUT_TAIL_CHARS);
          pending += text;
          if (pending.length > 4 * OUTPUT_TAIL_CHARS) pending = pending.slice(-2 * OUTPUT_TAIL_CHARS);
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
          if (termTimer) clearTimeout(termTimer);
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
          if (verifiedComplete || code === 0) progress.report({ increment: bar.complete(), message: opts.packageOperation === 'remove' ? 'tools removed' : 'completed' });
          resolve(verifiedComplete ? 0 : code);
        };
        child.on('error', (err) => {
          void services.prompts.showErrorMessage(`Sardina: could not run sfdk: ${err.message}`);
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
  } finally {
    monitor?.dispose();
  }
}

/** "Sardina: Install Deploy & Debug Tools on Device": for a right-clicked device, else the selected deploy device. */
export function installDeviceTools(services: Services) {
  return async (item?: unknown): Promise<void> => {
    const fromItem =
      item && typeof item === 'object' && 'device' in item ? (item as { device?: { name?: string } }).device?.name : undefined;
    const device = fromItem ?? services.settings.get('device', vscode.workspace.workspaceFolders?.[0]?.uri);
    if (!device) {
      void services.prompts.showWarningMessage('Sardina: select a device first (status bar or Devices view).');
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
    if (check.kind === 'checked') void services.prompts.showInformationMessage(`Sardina: missing on "${device}": ${packages.join(', ')}. Installing only these.`);
    const exitCode = await installOnDevice(services, device, packages);
    // undefined: cancelled, or a stop the user was already told about (offline, dropped, timeout).
    if (exitCode === undefined) return;
    const outcome = installOutcomeMessage(device, packages, exitCode);
    void (outcome.ok ? services.prompts.showInformationMessage(outcome.message) : services.prompts.showErrorMessage(outcome.message));
  };
}

/** Explicit cleanup of the installed deployment/debug tools after one confirmation. */
export function removeDeviceTools(services: Services) {
  return async (item?: unknown): Promise<void> => {
    const fromItem = item && typeof item === 'object' && 'device' in item
      ? (item as { device?: { name?: string } }).device?.name : undefined;
    const device = fromItem ?? services.settings.get('device', vscode.workspace.workspaceFolders?.[0]?.uri);
    if (!device) {
      void services.prompts.showWarningMessage('Sardina: select a device first (status bar or Devices view).');
      return;
    }
    const check = await checkDeviceToolsGuarded(services, device);
    if (check.kind !== 'checked') {
      if (check.kind !== 'cancelled') void services.prompts.showErrorMessage('Sardina: could not verify installed device tools. Nothing was removed; see the Sardina output.');
      return;
    }
    const installed = DEVICE_TOOL_PACKAGES.filter((pkg) => !check.missing.includes(pkg));
    if (!installed.length) {
      void services.prompts.showInformationMessage(`Sardina: no deploy or debug tools are installed on "${device}".`);
      return;
    }
    const packages = installed;
    const choice = await services.prompts.showWarningMessage(`Remove ${packages.join(', ')} from "${device}"?`, {
      modal: true,
      detail: 'Removing these shared tools disables the corresponding deploy or debugging features. PackageKit may also remove dependent packages. The device agent is not selected for removal.',
    }, 'Remove tools');
    if (choice !== 'Remove tools') return;
    const manager = await services.runner.run({
      args: ['device', 'exec', '--', 'sh', '-c', CHECK_PACKAGE_MANAGER_SCRIPT], device, timeoutMs: PACKAGE_MANAGER_CHECK_TIMEOUT_MS,
    });
    const managerState = packageManagerState(`${manager.stdout}\n${manager.stderr}`, manager.exitCode);
    if (managerState === 'busy') {
      void services.prompts.showWarningMessage(`Sardina: a package operation is already running on "${device}". Wait for it to finish or cancel it before removing tools.`);
      return;
    }
    if (managerState === 'unknown') {
      void services.prompts.showErrorMessage(`Sardina: could not verify PackageKit availability on "${device}". Nothing was removed; see the Sardina output.`);
      return;
    }
    const code = await runAsRootOnDevice(services, device, {
      title: `Remove tools from "${device}"`,
      prompt: 'Developer-mode password of the device (Settings → Developer tools).',
      progressTitle: `Sardina: removing tools from "${device}"`, workingMessage: `removing ${packages.join(', ')}…`,
      script: removeToolsScript(packages), streamOutput: true, packageMonitor: packages, packageOperation: 'remove',
    });
    if (code === undefined) return;
    const after = await checkDeviceToolsGuarded(services, device);
    if (after.kind === 'checked' && packages.every((pkg) => after.missing.includes(pkg))) {
      void services.prompts.showInformationMessage(`Sardina: removed ${packages.join(', ')} from "${device}".`);
    } else {
      void services.prompts.showErrorMessage(`Sardina: could not verify removal of all selected tools on "${device}" (exit ${code}). See the Sardina output.`);
    }
  };
}
