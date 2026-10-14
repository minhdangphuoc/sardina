import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Services } from '../core/services';
import { deviceSessions } from '../core/deviceSessions';
import { NO_TIMEOUT } from '../sfdk/runner';
import { buildDeployThen, installedAppThen, type DeployedApp } from '../tasks/commands';
import { cppdbgArchitecture } from '../tasks/buildConfig';
import { isolatedDebugRecipe, parseDebugRecipe, targetSysrootCandidates, type DebugRecipe } from './recipe';
import { DebugLifecycle, SESSION_ID_FIELD, gdbserverExitsAfterSession, gdbserverPkillArgs, isRestartRequest, withConnectRetry } from './debugSessionCore';
import { INSTALL_ON_DEVICE, checkDeviceToolsGuarded, installOnDevice } from '../devices/devicePackages';
import { ensureKnownHostsFile, pinHostKeys, readPinnedKeys, resolveDeviceEndpoint, SshForward } from '../agent/sshForward';
import { hostKeyAlias } from '../agent/sshForwardCore';
import { sfdkDeviceName } from '../devices/listParsing';
import { startDebugMonitor } from './debugMonitor';
import { debugMonitorMessage } from './debugMonitorCore';
import { ensureDebugMonitorAgent } from './ensureDebugMonitor';

const CPPTOOLS_ID = 'ms-vscode.cpptools';
const INSTALL_CPPTOOLS = 'Install C/C++ extension';
const SWITCH_TO_DEBUG = 'Switch to Debug';
const DEBUG_ANYWAY = 'Debug anyway';
const LISTEN_TIMEOUT_MS = 30_000;
const GDBSERVER_INSTALL_HINT = 'devel-su sh -c "pkcon refresh && pkcon install -y gdb-gdbserver"';
const GDBSERVER_PACKAGE = 'gdb-gdbserver';
const RUN_WITHOUT_DEBUGGER = 'Run without debugger';
const DEBUG_PORT = 10_000;

/** C++ debugging goes through the C/C++ extension's `cppdbg` debugger driving the SDK's GDB. */
async function ensureCppTools(services: Services): Promise<boolean> {
  if (vscode.extensions.getExtension(CPPTOOLS_ID)) return true;
  const choice = await services.prompts.showInformationMessage(
    'Sardina: debugging on the device uses the C/C++ extension (ms-vscode.cpptools) as the debugger UI. Install it?',
    INSTALL_CPPTOOLS,
  );
  if (choice !== INSTALL_CPPTOOLS) return false;
  await vscode.commands.executeCommand('workbench.extensions.installExtension', CPPTOOLS_ID);
  return vscode.extensions.getExtension(CPPTOOLS_ID) !== undefined;
}

/** Breakpoints need debug info; offer to switch a Release build type first. */
export async function ensureDebugBuild(services: Services, folder: vscode.WorkspaceFolder): Promise<boolean> {
  if (services.settings.get('build.type', folder.uri) === 'debug') return true;
  const choice = await services.prompts.showWarningMessage(
    'Sardina: the build type is Release, so breakpoints and variables may not work. Switch to Debug?',
    { modal: true },
    SWITCH_TO_DEBUG,
    DEBUG_ANYWAY,
  );
  if (choice === undefined) return false;
  if (choice === SWITCH_TO_DEBUG) {
    await vscode.workspace.getConfiguration('sardina', folder.uri).update('build.type', 'debug', vscode.ConfigurationTarget.WorkspaceFolder);
  }
  return true;
}

/**
 * true/false when the device answered; 'stop' when it is offline (the user was told, with Retry)
 * or the check was cancelled; undefined when the check ran but could not tell (later steps report it).
 */
async function deviceHasGdbserver(services: Services, device: string, cwd: string | undefined): Promise<boolean | 'stop' | undefined> {
  const outcome = await checkDeviceToolsGuarded(services, device, cwd);
  if (outcome.kind === 'checked') return !outcome.missing.includes(GDBSERVER_PACKAGE);
  if (outcome.kind === 'unreachable' || outcome.kind === 'cancelled') return 'stop';
  return undefined;
}

type GdbserverCheck = 'ready' | 'run-instead' | 'cancel';

/** Before building: warn when the device has no gdbserver, and offer to install it or run without the debugger. */
async function ensureGdbserver(services: Services, folder: vscode.WorkspaceFolder): Promise<GdbserverCheck> {
  const device = services.settings.get('device', folder.uri);
  if (!device) return 'ready'; // buildDeployThen reports the missing device itself
  const cwd = folder.uri.fsPath;
  const has = await deviceHasGdbserver(services, device, cwd);
  if (has === 'stop') return 'cancel';
  if (has !== false) return 'ready'; // unknown: later steps report it

  const choice = await services.prompts.showWarningMessage(
    `Sardina: gdbserver is not installed on "${device}", so the debugger can't attach.`,
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
  if ((await installOnDevice(services, device, [GDBSERVER_PACKAGE])) === undefined) return 'cancel';
  const after = await deviceHasGdbserver(services, device, cwd);
  if (after === true) return 'ready';
  if (after === 'stop') return 'cancel';
  void services.prompts.showErrorMessage(
    `Sardina: gdbserver is still missing on "${device}". The device downloads it from Jolla's repositories, ` +
      `so it needs internet access (Wi-Fi or mobile data; the USB link alone is not enough), and the password must be ` +
      `the developer-mode one. Then try again, or run on the device: ${GDBSERVER_INSTALL_HINT}`,
  );
  return 'cancel';
}

/** One gdbserver run on the device: resolves once it listens; `done` settles when it exits. */
interface GdbserverRun {
  stop(): void;
  done: Promise<void>;
  finished: boolean;
}

/**
 * The debug terminal: runs gdbserver on the device and shows the debugged app's output. A restart
 * runs gdbserver again in the same terminal (sfdk's `--once` makes it exit when GDB disconnects).
 */
class GdbserverTerminal {
  private readonly write = new vscode.EventEmitter<string>();
  private readonly close = new vscode.EventEmitter<number | void>();
  private readonly opened: Promise<void>;
  private terminal: vscode.Terminal | undefined;
  private current: GdbserverRun | undefined;
  private closed = false;

  constructor(private readonly services: Services, private readonly app: DeployedApp, private readonly recipe: DebugRecipe) {
    let markOpened: () => void = () => undefined;
    this.opened = new Promise((resolve) => (markOpened = resolve));
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.write.event,
      onDidClose: this.close.event,
      open: () => {
        this.write.fire(`Debugging ${app.project.name}${app.device ? ` on ${app.device}` : ''}: app output appears here.\r\n\r\n`);
        markOpened();
      },
      close: () => {
        this.closed = true;
        this.current?.stop();
      },
    };
    this.terminal = vscode.window.createTerminal({ name: `${app.project.name} (debug)`, pty, iconPath: new vscode.ThemeIcon('debug-alt') });
    this.terminal.show(true);
  }

  print(text: string): void {
    this.write.fire(`${text}\r\n`);
  }

  /** Waits (up to `ms`) for the current gdbserver to exit by itself, then stops it. */
  async settlePrevious(ms: number): Promise<void> {
    const run = this.current;
    if (!run) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      run.done.then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
    ]);
    clearTimeout(timer);
    if (!exited) {
      run.stop();
      await this.killOnDevice();
    }
  }

  /** Stops the local run and, as a backstop, gdbserver on the device (cancelling sfdk alone may not end it there). */
  async stop(): Promise<void> {
    const run = this.current;
    if (!run || run.finished) return;
    run.stop();
    await this.killOnDevice();
  }

  private async killOnDevice(): Promise<void> {
    try {
      await this.services.runner.run({
        args: gdbserverPkillArgs(this.recipe.gdbserver),
        target: this.app.target,
        device: this.app.device,
        cwd: this.app.cwd,
        timeoutMs: 30_000,
      });
    } catch {
      // best effort: gdbserver normally exits by itself once GDB disconnects (--once)
    }
  }

  /** Starts gdbserver; resolves once it listens, rejects with a readable reason. */
  async start(token?: vscode.CancellationToken): Promise<void> {
    await this.opened;
    if (this.closed) throw new Error('the debug terminal was closed');
    const { services, app, recipe } = this;
    const cts = new vscode.CancellationTokenSource();
    token?.onCancellationRequested(() => cts.cancel());
    let markDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (markDone = resolve));
    const run: GdbserverRun = { stop: () => cts.cancel(), done, finished: false };
    this.current = run;
    let agentListening = false;
    let signalListening = (): void => undefined;
    let agentStatus = '';
    let monitor: Awaited<ReturnType<typeof startDebugMonitor>>;
    try {
      monitor = await startDebugMonitor(services, {
        device: app.device, target: app.target, cwd: app.cwd, binary: app.project.appBinaryPath,
      }, 'cpp', DEBUG_PORT, cts.token, (event) => {
        agentStatus = debugMonitorMessage(event);
        if (event.event === 'status' && event.state === 'server-listening') {
          agentListening = true;
          signalListening();
        }
      });
    } catch (error) {
      cts.cancel();
      run.finished = true;
      markDone();
      throw error;
    }
    return new Promise((resolve, reject) => {
      let listening = false;
      const stderrTail: string[] = [];
      const timer = setTimeout(() => {
        if (!listening) {
          cts.cancel();
          reject(new Error(agentStatus || `gdbserver did not start listening within ${LISTEN_TIMEOUT_MS / 1000}s`));
        }
      }, LISTEN_TIMEOUT_MS);
      signalListening = (): void => {
        if (listening) return;
        listening = true;
        clearTimeout(timer);
        resolve();
      };
      void monitor.done.then(() => {
        if (!listening && !cts.token.isCancellationRequested) {
          clearTimeout(timer);
          cts.cancel();
          reject(new Error('Debugger Monitoring Agent disconnected before gdbserver opened its listener'));
        }
      });
      void services.runner
        .run({
          args: ['device', 'exec', '--', ...recipe.gdbserver],
          target: app.target,
          device: app.device,
          cwd: app.cwd,
          token: cts.token,
          timeoutMs: NO_TIMEOUT,
          stdin: '',
          onLine: (line, stream) => {
            this.write.fire(`${line}\r\n`);
            if (stream === 'stderr') stderrTail.push(line);
          },
        })
        .then((result) => {
          monitor.stop();
          run.finished = true;
          markDone();
          if (!this.closed) this.write.fire(`\r\n[gdbserver ${result.cancelled ? 'stopped' : `exited with code ${result.exitCode}`}]\r\n`);
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
      if (agentListening) signalListening();
    });
  }
}

function cppdbgConfiguration(services: Services, app: DeployedApp, recipe: DebugRecipe, sessionId: string): vscode.DebugConfiguration {
  // cpptools refuses to launch without it ("Specified argument was out of the range of valid values (Parameter 'arch')").
  const targetArchitecture = cppdbgArchitecture(app.target);
  if (!targetArchitecture) services.output.log('warn', `Debug: unknown architecture for target "${app.target}"; cppdbg targetArchitecture not set.`);
  return {
    type: 'cppdbg',
    request: 'launch',
    name: `Sardina: ${app.project.name}${app.device ? ` on ${app.device}` : ''}`,
    program: recipe.program,
    cwd: app.cwd,
    ...(targetArchitecture ? { targetArchitecture } : {}),
    MIMode: 'gdb',
    miDebuggerPath: recipe.gdbPath,
    // sfdk's own GDB setup (sysroot, source mapping, extended-remote, remote exec-file, file, args),
    // in place of cppdbg's default local launch; exec-run then starts the app on the device.
    // With connect retries, so that after Restart the new GDB waits for gdbserver to start again.
    customLaunchSetupCommands: withConnectRetry(recipe.initCommands).map((text) => ({ text, ignoreFailures: false })),
    launchCompleteCommand: 'exec-run',
    stopAtEntry: false,
    // Restart relaunches this same configuration; the id ties the new session to this run.
    [SESSION_ID_FIELD]: sessionId,
  };
}

/** Opens the Device Monitor beside the editor (focus stays put) when the setting allows it. */
async function openMonitorForDebug(services: Services, folder: vscode.WorkspaceFolder): Promise<void> {
  if (!services.settings.get('debug.openDeviceMonitor', folder.uri)) return;
  const device = services.settings.get('device', folder.uri);
  if (!device) return; // the build step reports the missing device
  await vscode.commands.executeCommand('sardina.monitor.open', { device, preserveFocus: true });
}

/** "Sardina: Debug on Device": build, deploy, start the app under gdbserver and attach VS Code's debugger. */
export async function debugOnDevice(ctx: vscode.ExtensionContext, services: Services, storageDir?: string): Promise<void> {
  if (!(await ensureCppTools(services))) return;
  const project = await services.projects.resolveActive();
  if (!project) {
    void services.prompts.showWarningMessage('Sardina: no Sailfish OS project found in this workspace.');
    return;
  }
  if (!(await ensureDebugMonitorAgent(ctx, services, project.folder))) return;
  const gdbserver = await ensureGdbserver(services, project.folder);
  if (gdbserver === 'run-instead') {
    await vscode.commands.executeCommand('sardina.buildDeployRun');
    return;
  }
  if (gdbserver === 'cancel') return;
  if (!(await ensureDebugBuild(services, project.folder))) return;
  await openMonitorForDebug(services, project.folder);

  await buildDeployThen(services, 'Sardina: Debug on Device', (app, progress, token) => attachDebugger(services, app, progress, token, storageDir), project);
}

/** "Sardina: Debug Installed App": the app already on the device, under the debugger, without building or deploying. */
export async function debugInstalled(ctx: vscode.ExtensionContext, services: Services, storageDir?: string): Promise<void> {
  if (!(await ensureCppTools(services))) return;
  const project = await services.projects.resolveActive();
  if (!project) {
    void services.prompts.showWarningMessage('Sardina: no Sailfish OS project found in this workspace.');
    return;
  }
  if (!(await ensureDebugMonitorAgent(ctx, services, project.folder))) return;
  const gdbserver = await ensureGdbserver(services, project.folder);
  if (gdbserver === 'run-instead') {
    await vscode.commands.executeCommand('sardina.runInstalled');
    return;
  }
  if (gdbserver === 'cancel') return;
  // No Release-to-Debug offer here: nothing is rebuilt, so switching the build type would not help this session.
  await openMonitorForDebug(services, project.folder);
  await installedAppThen(services, 'Sardina: Debug Installed App', 'sardina.debugOnDevice', (app, progress, token) =>
    attachDebugger(services, app, progress, token, storageDir), project);
}

async function prepareIsolatedRecipe(
  services: Services,
  app: DeployedApp,
  storageDir: string | undefined,
  token: vscode.CancellationToken,
): Promise<{ recipe: DebugRecipe; forward: SshForward } | undefined> {
  if (!storageDir || !app.device || !app.target) return undefined;
  const sdk = services.sdk.current() ?? (await services.sdk.refresh());
  if (!sdk) return undefined;

  const sysroot = targetSysrootCandidates(sdk.root, app.target).find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory());
  const localProgram = path.join(app.cwd, path.basename(app.project.appBinaryPath));
  const gdbPath = path.join(sdk.root, 'bin', process.platform === 'win32' ? 'gdb.exe' : 'gdb');
  if (!sysroot || !fs.statSync(gdbPath, { throwIfNoEntry: false })?.isFile() || !fs.statSync(localProgram, { throwIfNoEntry: false })?.isFile()) {
    services.output.log('error', `Debug isolation prerequisites are missing (sysroot=${sysroot ?? 'not found'}, gdb=${gdbPath}, program=${localProgram}).`);
    return undefined;
  }

  const endpoint = await resolveDeviceEndpoint(services, undefined, app.device);
  if (!endpoint) return undefined;
  const name = sfdkDeviceName(endpoint);
  const knownHosts = await ensureKnownHostsFile(storageDir);
  const alias = hostKeyAlias(name);
  if ((await readPinnedKeys(knownHosts, alias)).length === 0 && (await pinHostKeys(services, name, knownHosts, alias)) === 'no-host-key') {
    services.output.log('error', `Debug isolation failed: "${name}" returned no usable SSH host key through the SDK connection.`);
    return undefined;
  }
  const open = () => SshForward.openTcp(
      endpoint,
      DEBUG_PORT,
      { storageDir, token, output: services.output },
      // gdbserver starts after the tunnel; probing now would report a false remote failure.
      { probeRemote: false },
    );
  let opened = await open();
  if (!opened.ok && opened.cls === 'not-pinned' && (await pinHostKeys(services, name, knownHosts, alias)) === 'pinned') {
    opened = await open();
  }
  if (!opened.ok) {
    services.output.log('error', `Debug isolation tunnel failed: ${opened.detail}`);
    return undefined;
  }
  return {
    recipe: isolatedDebugRecipe({
      sdkRoot: sdk.root,
      sysroot,
      localProgram,
      remoteProgram: app.project.appBinaryPath,
      port: DEBUG_PORT,
    }),
    forward: opened.forward,
  };
}

/** Starts the installed app under gdbserver and attaches VS Code's debugger to it. */
async function attachDebugger(
  services: Services,
  app: DeployedApp,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken,
  storageDir?: string,
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
  let recipe = dryRun.exitCode === 0 ? parseDebugRecipe(dryRun.stdout) : undefined;
  let isolatedForward: SshForward | undefined;
  if (!recipe || !recipe.program) {
    if (token.isCancellationRequested) return;
    services.output.log(
      'warn',
      `sfdk debug --dry-run could not prepare a usable recipe (exit ${dryRun.exitCode}); trying Sardina's isolated debugger tunnel.`,
    );
    let isolated: Awaited<ReturnType<typeof prepareIsolatedRecipe>> = undefined;
    try {
      isolated = await prepareIsolatedRecipe(services, app, storageDir, token);
    } catch (err) {
      services.output.log('error', `Debug isolation setup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    recipe = isolated?.recipe;
    isolatedForward = isolated?.forward;
  }
  if (!recipe || !recipe.program) {
    services.output.log('error', `sfdk debug --dry-run gave no usable GDB setup (exit ${dryRun.exitCode}): ${dryRun.stdout}${dryRun.stderr}`);
    void services.prompts.showErrorMessage('Sardina: could not prepare the debugger (see the Sardina output).');
    return;
  }

  const terminal = new GdbserverTerminal(services, app, recipe);
  try {
    await terminal.start(token);
  } catch (err) {
    await isolatedForward?.close();
    void services.prompts.showErrorMessage(`Sardina: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const config = cppdbgConfiguration(services, app, recipe, sessionId);
  const ours = (session: vscode.DebugSession): boolean =>
    session.configuration[SESSION_ID_FIELD] === undefined
      ? session.configuration.name === config.name
      : session.configuration[SESSION_ID_FIELD] === sessionId;
  let debugSession: vscode.DebugSession | undefined;
  const subs: vscode.Disposable[] = [];

  const lifecycle = new DebugLifecycle({
    relaunchGdbserver: async () => {
      if (!gdbserverExitsAfterSession(recipe.gdbserver)) return true; // still listening for the new GDB
      terminal.print('\r\n[Restart: starting the app again under gdbserver; nothing is rebuilt or deployed]');
      services.output.log('info', `Debug: restarting ${app.project.name}${app.device ? ` on ${app.device}` : ''}.`);
      await terminal.settlePrevious(3_000);
      if (app.pkillArgs) {
        // Before gdbserver listens, so the new GDB (still retrying its connect) cannot have started the app yet.
        await services.runner.run({ args: app.pkillArgs, target: app.target, device: app.device, cwd: app.cwd, timeoutMs: 30_000 });
      }
      try {
        await terminal.start();
        return true;
      } catch (err) {
        void services.prompts.showErrorMessage(`Sardina: restart failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    },
    cleanup: (reason) => {
      services.output.log('info', `Debug: session for ${app.project.name} ended (${reason}).`);
      liveLifecycles.delete(sessionId);
      for (const s of subs) s.dispose();
      registration?.dispose();
      void terminal.stop();
      void isolatedForward?.close();
    },
    stopSession: () => {
      if (debugSession) void Promise.resolve(vscode.debug.stopDebugging(debugSession)).catch(() => undefined);
    },
    setTimer: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  });
  liveLifecycles.set(sessionId, { lifecycle, owns: ours });
  subs.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (!ours(session)) return;
      debugSession = session;
      lifecycle.sessionStarted();
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (ours(session)) lifecycle.sessionTerminated();
    }),
  );
  // Declared after the lifecycle that uses it: nothing can end the run before this line runs.
  const registration = app.device
    ? deviceSessions.register(app.device, 'debug', 'debugging', async () => {
        // Ends the debug session first (GDB kills the app), then gdbserver.
        if (debugSession) await vscode.debug.stopDebugging(debugSession);
        lifecycle.stop();
      }, { app: app.project.name, binary: app.project.appBinaryPath, mode: 'debug' })
    : undefined;

  let started = false;
  try {
    started = await vscode.debug.startDebugging(app.project.folder, config);
  } catch (err) {
    services.output.log('error', `startDebugging failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!started) {
    lifecycle.stop();
    void services.prompts.showErrorMessage('Sardina: VS Code could not start the debug session.');
  }
}

/** Debug runs in progress, by their session id, so the adapter tracker can route DAP messages to them. */
const liveLifecycles = new Map<string, { lifecycle: DebugLifecycle; owns: (session: vscode.DebugSession) => boolean }>();

function lifecycleFor(session: vscode.DebugSession): DebugLifecycle | undefined {
  const id: unknown = session.configuration[SESSION_ID_FIELD];
  if (typeof id === 'string') return liveLifecycles.get(id)?.lifecycle;
  for (const entry of liveLifecycles.values()) if (entry.owns(session)) return entry.lifecycle;
  return undefined;
}

/**
 * Sees the DAP traffic of our cppdbg sessions: a new adapter for one of our runs is a (re)start,
 * and a disconnect/terminate with `restart: true` is VS Code's Restart, not Stop.
 */
const restartTracker: vscode.DebugAdapterTrackerFactory = {
  createDebugAdapterTracker(session) {
    const lifecycle = lifecycleFor(session);
    if (!lifecycle) return undefined;
    lifecycle.sessionStarted();
    return {
      onWillReceiveMessage: (message: unknown) => {
        if (isRestartRequest(message)) lifecycle.noteRestartRequested();
      },
    };
  },
};

export function activateDebug(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sardina.debugOnDevice', () => debugOnDevice(ctx, services, ctx.globalStorageUri.fsPath)),
    vscode.commands.registerCommand('sardina.debugInstalled', () => debugInstalled(ctx, services, ctx.globalStorageUri.fsPath)),
    vscode.debug.registerDebugAdapterTrackerFactory('cppdbg', restartTracker),
  );
}
