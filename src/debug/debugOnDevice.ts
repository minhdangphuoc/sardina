import * as vscode from 'vscode';
import type { Services } from '../core/services';
import { NO_TIMEOUT } from '../sfdk/runner';
import { buildDeployThen, installedAppThen, type DeployedApp } from '../tasks/commands';
import { parseDebugRecipe, type DebugRecipe } from './recipe';
import { INSTALL_ON_DEVICE, installOnDevice } from '../devices/devicePackages';

const CPPTOOLS_ID = 'ms-vscode.cpptools';
const INSTALL_CPPTOOLS = 'Install C/C++ extension';
const SWITCH_TO_DEBUG = 'Switch to Debug';
const DEBUG_ANYWAY = 'Debug anyway';
const LISTEN_TIMEOUT_MS = 30_000;
const GDBSERVER_INSTALL_HINT = 'devel-su sh -c "pkcon refresh && pkcon install -y gdb-gdbserver"';
const RUN_WITHOUT_DEBUGGER = 'Run without debugger';

/** C++ debugging goes through the C/C++ extension's `cppdbg` debugger driving the SDK's GDB. */
async function ensureCppTools(services: Services): Promise<boolean> {
  if (vscode.extensions.getExtension(CPPTOOLS_ID)) return true;
  const choice = await services.prompts.showInformationMessage(
    'Sailfish: debugging on the device uses the C/C++ extension (ms-vscode.cpptools) as the debugger UI. Install it?',
    INSTALL_CPPTOOLS,
  );
  if (choice !== INSTALL_CPPTOOLS) return false;
  await vscode.commands.executeCommand('workbench.extensions.installExtension', CPPTOOLS_ID);
  return vscode.extensions.getExtension(CPPTOOLS_ID) !== undefined;
}

/** Breakpoints need debug info; offer to switch a Release build type first. */
async function ensureDebugBuild(services: Services, folder: vscode.WorkspaceFolder): Promise<boolean> {
  if (services.settings.get('build.type', folder.uri) === 'debug') return true;
  const choice = await services.prompts.showWarningMessage(
    'Sailfish: the build type is Release, so breakpoints and variables may not work. Switch to Debug?',
    { modal: true },
    SWITCH_TO_DEBUG,
    DEBUG_ANYWAY,
  );
  if (choice === undefined) return false;
  if (choice === SWITCH_TO_DEBUG) {
    await vscode.workspace.getConfiguration('sailfish', folder.uri).update('build.type', 'debug', vscode.ConfigurationTarget.WorkspaceFolder);
  }
  return true;
}

/** true/false when the device answered; undefined when it could not be asked (unreachable, no device…). */
async function deviceHasGdbserver(services: Services, device: string, cwd: string | undefined): Promise<boolean | undefined> {
  const result = await services.runner.run({
    args: ['device', 'exec', '--', 'sh', '-c', 'command -v gdbserver'],
    device,
    cwd,
    timeoutMs: 30_000,
  });
  if (result.exitCode === 0 && result.stdout.trim()) return true;
  // sh's `command -v` exits 1 (or 127 on some shells) with no output when the command is missing.
  if ((result.exitCode === 1 || result.exitCode === 127) && !result.stdout.trim()) return false;
  return undefined;
}

type GdbserverCheck = 'ready' | 'run-instead' | 'cancel';

/** Before building: warn when the device has no gdbserver, and offer to install it or run without the debugger. */
async function ensureGdbserver(services: Services, folder: vscode.WorkspaceFolder): Promise<GdbserverCheck> {
  const device = services.settings.get('device', folder.uri);
  if (!device) return 'ready'; // buildDeployThen reports the missing device itself
  const cwd = folder.uri.fsPath;
  if ((await deviceHasGdbserver(services, device, cwd)) !== false) return 'ready'; // unknown: later steps report it

  const choice = await services.prompts.showWarningMessage(
    `Sailfish: gdbserver is not installed on "${device}", so the debugger can't attach.`,
    {
      modal: true,
      detail: `"Install on device" runs \`${GDBSERVER_INSTALL_HINT}\` on the device; you will be asked for its developer-mode password, and debugging continues once it finishes.`,
    },
    INSTALL_ON_DEVICE,
    RUN_WITHOUT_DEBUGGER,
  );
  if (choice === RUN_WITHOUT_DEBUGGER) return 'run-instead';
  if (choice !== INSTALL_ON_DEVICE) return 'cancel';

  // undefined: the password box was cancelled (or sfdk couldn't start) — not a failed install.
  if ((await installOnDevice(services, device, ['gdb-gdbserver'])) === undefined) return 'cancel';
  if (await deviceHasGdbserver(services, device, cwd)) return 'ready';
  void services.prompts.showErrorMessage(
    `Sailfish: gdbserver is still missing on "${device}". The device downloads it from Jolla's repositories, ` +
      `so it needs internet access (Wi-Fi or mobile data; the USB link alone is not enough), and the password must be ` +
      `the developer-mode one. Then try again, or run on the device: ${GDBSERVER_INSTALL_HINT}`,
  );
  return 'cancel';
}

/**
 * Runs gdbserver on the device in a terminal that also shows the debugged app's output; resolves
 * once gdbserver listens, or rejects with a readable reason. Returns a stop function.
 */
function startGdbserver(services: Services, app: DeployedApp, recipe: DebugRecipe, token: vscode.CancellationToken): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const cts = new vscode.CancellationTokenSource();
    token.onCancellationRequested(() => cts.cancel());
    const write = new vscode.EventEmitter<string>();
    const close = new vscode.EventEmitter<number | void>();
    let listening = false;
    const stderrTail: string[] = [];
    const timer = setTimeout(() => {
      if (!listening) {
        cts.cancel();
        reject(new Error(`gdbserver did not start listening within ${LISTEN_TIMEOUT_MS / 1000}s`));
      }
    }, LISTEN_TIMEOUT_MS);

    const pty: vscode.Pseudoterminal = {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: () => {
        write.fire(`Debugging ${app.project.name}${app.device ? ` on ${app.device}` : ''}: app output appears here.\r\n\r\n`);
        void services.runner
          .run({
            args: ['device', 'exec', '--', ...recipe.gdbserver],
            target: app.target,
            device: app.device,
            cwd: app.cwd,
            token: cts.token,
            timeoutMs: NO_TIMEOUT,
            onLine: (line, stream) => {
              write.fire(`${line}\r\n`);
              if (stream === 'stderr') stderrTail.push(line);
              if (!listening && /Listening on port/i.test(line)) {
                listening = true;
                clearTimeout(timer);
                resolve(() => cts.cancel());
              }
            },
          })
          .then((result) => {
            write.fire(`\r\n[gdbserver ${result.cancelled ? 'stopped' : `exited with code ${result.exitCode}`}]\r\n`);
            if (!listening) {
              clearTimeout(timer);
              const output = `${stderrTail.join('\n')}\n${result.stdout}`;
              reject(
                new Error(
                  /gdbserver: (command )?not found|No such file/i.test(output) || result.exitCode === 127
                    ? `gdbserver is not installed on the device. Install it there with: ${GDBSERVER_INSTALL_HINT}`
                    : `gdbserver exited (code ${result.exitCode}): ${output.trim().split('\n').pop() ?? ''}`,
                ),
              );
            }
          });
      },
      close: () => cts.cancel(),
    };
    vscode.window.createTerminal({ name: `${app.project.name} (debug)`, pty, iconPath: new vscode.ThemeIcon('debug-alt') }).show(true);
  });
}

function cppdbgConfiguration(app: DeployedApp, recipe: DebugRecipe): vscode.DebugConfiguration {
  return {
    type: 'cppdbg',
    request: 'launch',
    name: `Sailfish: ${app.project.name}${app.device ? ` on ${app.device}` : ''}`,
    program: recipe.program,
    cwd: app.cwd,
    MIMode: 'gdb',
    miDebuggerPath: recipe.gdbPath,
    // sfdk's own GDB setup (sysroot, source mapping, extended-remote, remote exec-file, file, args),
    // in place of cppdbg's default local launch; exec-run then starts the app on the device.
    customLaunchSetupCommands: recipe.initCommands.map((text) => ({ text, ignoreFailures: false })),
    launchCompleteCommand: 'exec-run',
    stopAtEntry: false,
  };
}

/** "Sailfish: Debug on Device": build, deploy, start the app under gdbserver and attach VS Code's debugger. */
export async function debugOnDevice(services: Services): Promise<void> {
  if (!(await ensureCppTools(services))) return;
  const project = await services.projects.resolveActive();
  if (!project) {
    void services.prompts.showWarningMessage('Sailfish: no Sailfish project found in this workspace.');
    return;
  }
  const gdbserver = await ensureGdbserver(services, project.folder);
  if (gdbserver === 'run-instead') {
    await vscode.commands.executeCommand('sailfish.buildDeployRun');
    return;
  }
  if (gdbserver === 'cancel') return;
  if (!(await ensureDebugBuild(services, project.folder))) return;

  await buildDeployThen(services, 'Sailfish: Debug on Device', (app, progress, token) => attachDebugger(services, app, progress, token), project);
}

/** "Sailfish: Debug Installed App": the app already on the device, under the debugger, without building or deploying. */
export async function debugInstalled(services: Services): Promise<void> {
  if (!(await ensureCppTools(services))) return;
  const project = await services.projects.resolveActive();
  if (!project) {
    void services.prompts.showWarningMessage('Sailfish: no Sailfish project found in this workspace.');
    return;
  }
  const gdbserver = await ensureGdbserver(services, project.folder);
  if (gdbserver === 'run-instead') {
    await vscode.commands.executeCommand('sailfish.runInstalled');
    return;
  }
  if (gdbserver === 'cancel') return;
  // No Release-to-Debug offer here: nothing is rebuilt, so switching the build type would not help this session.
  await installedAppThen(services, 'Sailfish: Debug Installed App', 'sailfish.debugOnDevice', (app, progress, token) =>
    attachDebugger(services, app, progress, token), project);
}

/** Starts the installed app under gdbserver and attaches VS Code's debugger to it. */
async function attachDebugger(
  services: Services,
  app: DeployedApp,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken,
): Promise<void> {
  progress.report({ message: 'starting debugger…' });
  if (app.pkillArgs) {
    await services.runner.run({ args: app.pkillArgs, target: app.target, device: app.device, cwd: app.cwd, token });
  }
  const remoteExe = app.project.appBinaryPath;
  const dryRun = await services.runner.run({
    args: ['debug', '--dry-run', remoteExe],
    target: app.target,
    device: app.device,
    cwd: app.cwd,
    token,
  });
  const recipe = dryRun.exitCode === 0 ? parseDebugRecipe(dryRun.stdout) : undefined;
  if (!recipe || !recipe.program) {
    services.output.log('error', `sfdk debug --dry-run gave no usable GDB setup (exit ${dryRun.exitCode}): ${dryRun.stdout}${dryRun.stderr}`);
    void services.prompts.showErrorMessage('Sailfish: could not prepare the debugger (see the Sailfish OS output).');
    return;
  }

  let stopGdbserver: () => void;
  try {
    stopGdbserver = await startGdbserver(services, app, recipe, token);
  } catch (err) {
    void services.prompts.showErrorMessage(`Sailfish: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const config = cppdbgConfiguration(app, recipe);
  const started = await vscode.debug.startDebugging(app.project.folder, config);
  if (!started) {
    stopGdbserver();
    void services.prompts.showErrorMessage('Sailfish: VS Code could not start the debug session.');
    return;
  }
  const sub = vscode.debug.onDidTerminateDebugSession((session) => {
    if (session.configuration.name === config.name) {
      stopGdbserver();
      sub.dispose();
    }
  });
}

export function activateDebug(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sailfish.debugOnDevice', () => debugOnDevice(services)),
    vscode.commands.registerCommand('sailfish.debugInstalled', () => debugInstalled(services)),
  );
}
