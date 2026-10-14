import * as vscode from 'vscode';
import type { Services } from '../core/services';
import { deviceSessions } from '../core/deviceSessions';
import { QT_QML_EXTENSION_ID } from '../qtqml/keys';
import { ensureDebugBuild } from '../debug/debugOnDevice';
import { startDebugMonitor } from '../debug/debugMonitor';
import { ensureDebugMonitorAgent } from '../debug/ensureDebugMonitor';
import { debugMonitorMessage, qmlDebugStartupStallMessage, type DebugMonitorEvent } from '../debug/debugMonitorCore';
import { INSTALL_ON_DEVICE, QML_DEBUG_SERVER_PACKAGE, checkDeviceToolsGuarded, installOnDevice } from '../devices/devicePackages';
import { buildDeployThen, installedAppThen, type DeployedApp } from '../tasks/commands';
import { launchInAppTerminal } from '../tasks/appTerminal';
import { resolveDeviceEndpoint, SshForward } from '../agent/sshForward';
import { hasQmlDebugEnabler } from './paths';
import { hasQmlDebugAdapter, qmlDebugAdapterPort, qmlDebugLaunchArgs, qmlDebugPort } from './core';

const QML_SESSION_FIELD = 'sardinaQmlDebugSessionId';
const DEBUG_MONITOR_STALL_MS = 60_000;
const QML_DEBUG_SERVER_INSTALL_HINT = `pkcon install ${QML_DEBUG_SERVER_PACKAGE}`;

/** The official Qt QML extension owns the adapter. Sardina owns only the remote launch and private tunnel. */
function qtQmlDebuggerIsAvailable(): boolean {
  const extension = vscode.extensions.getExtension(QT_QML_EXTENSION_ID);
  return extension !== undefined && hasQmlDebugAdapter(extension.packageJSON);
}

async function activeProjectOrWarn(services: Services) {
  const project = await services.projects.resolveActive();
  if (!project) void services.prompts.showWarningMessage('Sardina: no Sailfish OS project found in this workspace.');
  return project;
}

/** Qt loads its QML debug transport from a separate Sailfish package; offer the existing consent flow when absent. */
async function ensureQmlDebugServer(services: Services, appFolder: vscode.WorkspaceFolder): Promise<boolean> {
  const device = services.settings.get('device', appFolder.uri);
  if (!device) return true; // the build/deploy command reports the missing selection
  const check = await checkDeviceToolsGuarded(services, device, appFolder.uri.fsPath);
  if (check.kind === 'unreachable' || check.kind === 'cancelled') return false;
  if (check.kind !== 'checked') {
    void services.prompts.showErrorMessage(
      `Sardina: could not verify the QML debugging tools on "${device}". Nothing was installed; see the Sardina output channel.`,
    );
    return false;
  }
  if (!check.missing.includes(QML_DEBUG_SERVER_PACKAGE)) return true;

  const choice = await services.prompts.showWarningMessage(
    `Sardina: the QML/JavaScript debug server is not installed on "${device}".`,
    {
      modal: true,
      detail:
        `“Install on device” runs \`${QML_DEBUG_SERVER_INSTALL_HINT}\` through Developer Mode. ` +
        'You will be asked for the device password, and debugging continues after the package is available.',
    },
    INSTALL_ON_DEVICE,
  );
  if (choice !== INSTALL_ON_DEVICE) return false;
  if ((await installOnDevice(services, device, [QML_DEBUG_SERVER_PACKAGE])) === undefined) return false;

  const after = await checkDeviceToolsGuarded(services, device, appFolder.uri.fsPath);
  if (after.kind === 'checked' && !after.missing.includes(QML_DEBUG_SERVER_PACKAGE)) return true;
  void services.prompts.showErrorMessage(
    `Sardina: ${QML_DEBUG_SERVER_PACKAGE} is still missing on "${device}". The device needs internet access to Jolla's repositories. ` +
      `Then try again, or run on the device: ${QML_DEBUG_SERVER_INSTALL_HINT}`,
  );
  return false;
}

async function nativeBuildSupportsQmlDebug(services: Services, app: DeployedApp, token: vscode.CancellationToken): Promise<boolean> {
  if (!app.project.hasNativeBinary) return true;
  const result = await services.runner.run({
    args: ['device', 'exec', '--', 'grep', '-c', '-a', 'QQmlDebuggingEnabler', app.project.appBinaryPath],
    target: app.target,
    device: app.device,
    cwd: app.cwd,
    token,
    timeoutMs: 30_000,
  });
  if (result.exitCode === 0 && hasQmlDebugEnabler(result.stdout)) return true;
  void services.prompts.showErrorMessage(
    'Sardina: this installed app was not built with QML debugging. Select Debug and use “QML/JavaScript Debug on Device” to rebuild and deploy it.',
  );
  return false;
}

/** Start the app under Qt's QML/JS server, forward its loopback-only port, and attach qt-qml's DAP adapter. */
async function attachQmlDebugger(
  ctx: vscode.ExtensionContext,
  services: Services,
  app: DeployedApp,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken,
): Promise<void> {
  if (!app.device) {
    void services.prompts.showErrorMessage('Sardina: select a device before starting QML/JavaScript debugging.');
    return;
  }
  if (!(await nativeBuildSupportsQmlDebug(services, app, token))) return;

  const port = qmlDebugPort(services.settings.get('qmlDebug.port', app.project.folder.uri));
  progress.report({ message: 'preparing the private QML debug tunnel…' });
  const endpoint = await resolveDeviceEndpoint(services, undefined, app.device);
  if (!endpoint) {
    void services.prompts.showErrorMessage(`Sardina: could not obtain the SSH endpoint for "${app.device}".`);
    return;
  }
  const opened = await SshForward.openTcp(
    endpoint,
    port,
    { storageDir: ctx.globalStorageUri.fsPath, token, output: services.output },
    { probeRemote: false },
  );
  if (!opened.ok) {
    void services.prompts.showErrorMessage(`Sardina: could not create the private QML debug tunnel (${opened.detail}).`);
    return;
  }
  const forward = opened.forward;

  if (app.pkillArgs) await services.runner.run({ args: app.pkillArgs, target: app.target, device: app.device, cwd: app.cwd, token });
  // The QML server binds the device's loopback only. `block` holds the process here until qt-qml
  // attaches through the pinned SSH forward, so breakpoints can be set before user code runs.
  type LaunchOutcome = { kind: 'ready' } | { kind: 'exit'; code?: number } | { kind: 'monitor-error'; detail: string };
  let settleLaunch!: (outcome: LaunchOutcome) => void;
  const launchOutcome = new Promise<LaunchOutcome>((resolve) => {
    settleLaunch = resolve;
  });
  let launchSettled = false;
  const settleLaunchOnce = (outcome: LaunchOutcome): void => {
    if (launchSettled) return;
    launchSettled = true;
    settleLaunch(outcome);
  };
  let launchIssued = false;
  let lastMonitorEvent: DebugMonitorEvent | undefined;
  let sawDebugApp = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let monitor: Awaited<ReturnType<typeof startDebugMonitor>>;
  try {
    monitor = await startDebugMonitor(services, {
      device: app.device, target: app.target, cwd: app.cwd, binary: app.project.appBinaryPath,
    }, 'qml', port, token, (event) => {
      lastMonitorEvent = event;
      if (!launchIssued || event.event !== 'status' || launchSettled) return;
      progress.report({ message: debugMonitorMessage(event) });
      if (event.qmlArgument && event.pid > 0) sawDebugApp = true;
      if (event.state === 'server-listening') settleLaunchOnce({ kind: 'ready' });
      else if (event.state === 'app-exited' && sawDebugApp) settleLaunchOnce({ kind: 'monitor-error', detail: 'the monitored QML application process exited before its server was ready' });
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => settleLaunchOnce({ kind: 'monitor-error', detail: qmlDebugStartupStallMessage(event, port) }), DEBUG_MONITOR_STALL_MS);
    });
  } catch (error) {
    await forward.close();
    if (!token.isCancellationRequested) void services.prompts.showErrorMessage(`Sardina: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const appLaunch = launchInAppTerminal(services, {
    appName: app.project.name,
    binary: app.project.appBinaryPath,
    launchArgs: qmlDebugLaunchArgs(app.launchArgs, port, app.project.hasNativeBinary ? app.project.appBinaryPath : undefined),
    target: app.target,
    device: app.device,
    cwd: app.cwd,
    closeStdin: true,
    onLine: (line) => {
      if (line.trim()) services.output.log('info', `QML app [${app.device}]: ${line.slice(0, 2000)}`);
    },
    onExit: (exit) => settleLaunchOnce({ kind: 'exit', code: exit.code }),
  });
  launchIssued = true;

  stallTimer = setTimeout(() => settleLaunchOnce({ kind: 'monitor-error', detail: qmlDebugStartupStallMessage(lastMonitorEvent, port) }), DEBUG_MONITOR_STALL_MS);
  void monitor.done.then(() => {
    if (!launchSettled && !token.isCancellationRequested) settleLaunchOnce({ kind: 'monitor-error', detail: 'Debugger Monitoring Agent disconnected during startup' });
  });
  const cancelRegistration = token.onCancellationRequested(() => settleLaunchOnce({ kind: 'monitor-error', detail: 'debugger preparation was cancelled' }));
  const outcome = await launchOutcome;
  clearTimeout(stallTimer);
  cancelRegistration.dispose();
  if (token.isCancellationRequested) {
    monitor.stop();
    appLaunch.stop();
    await forward.close();
    return;
  }
  if (outcome.kind !== 'ready') {
    monitor.stop();
    appLaunch.stop();
    await forward.close();
    const detail = outcome.kind === 'monitor-error' ? outcome.detail
      : `the application exited with code ${outcome.code ?? 'unknown'}`;
    void services.prompts.showErrorMessage(`Sardina: could not start QML/JavaScript debugging: ${detail}. See the app terminal for its output.`);
    return;
  }
  services.output.log('info', `QML debug listener verified on "${app.device}" at 127.0.0.1:${port}; attaching Qt QML adapter.`);

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const config: vscode.DebugConfiguration = {
    type: 'qml',
    request: 'attach',
    name: `Sardina: QML/JS ${app.project.name} on ${app.device}`,
    host: '127.0.0.1',
    port: qmlDebugAdapterPort(port),
    [QML_SESSION_FIELD]: id,
  };
  let session: vscode.DebugSession | undefined;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    monitor.stop();
    sessionRegistration?.dispose();
    deviceRegistration?.dispose();
    appLaunch.stop();
    void forward.close();
  };
  const owns = (candidate: vscode.DebugSession): boolean => candidate.configuration[QML_SESSION_FIELD] === id;
  const sessionRegistration = vscode.debug.onDidTerminateDebugSession((candidate) => {
    if (owns(candidate)) cleanup();
  });
  const deviceRegistration = deviceSessions.register(app.device, 'debug', 'QML/JS debugging', async () => {
    if (session) await vscode.debug.stopDebugging(session);
    cleanup();
  }, { app: app.project.name, binary: app.project.appBinaryPath, mode: 'debug' });
  const startRegistration = vscode.debug.onDidStartDebugSession((candidate) => {
    if (owns(candidate)) session = candidate;
  });
  try {
    progress.report({ message: 'attaching the QML/JavaScript debugger…' });
    if (!(await vscode.debug.startDebugging(app.project.folder, config))) {
      cleanup();
      void services.prompts.showErrorMessage('Sardina: the Qt QML debugger could not attach. Check the app output for QML tooling errors.');
    }
  } catch (err) {
    cleanup();
    services.output.log('error', `QML debug attach failed: ${err instanceof Error ? err.message : String(err)}`);
    void services.prompts.showErrorMessage('Sardina: the Qt QML debugger could not attach (see the Sardina output).');
  } finally {
    startRegistration.dispose();
  }
}

/** Build, deploy, and attach the QML/JavaScript debugger. */
export async function debugQmlOnDevice(ctx: vscode.ExtensionContext, services: Services): Promise<void> {
  if (!qtQmlDebuggerIsAvailable()) {
    void services.prompts.showErrorMessage('Sardina: QML/JavaScript debugging requires a current Qt QML extension with its QML debugger. Update theqtcompany.qt-qml and try again.');
    return;
  }
  const project = await activeProjectOrWarn(services);
  if (!project || !(await ensureDebugMonitorAgent(ctx, services, project.folder))
    || !(await ensureDebugBuild(services, project.folder)) || !(await ensureQmlDebugServer(services, project.folder))) return;
  await buildDeployThen(services, 'Sardina: QML/JavaScript Debug on Device', (app, progress, token) =>
    attachQmlDebugger(ctx, services, app, progress, token), project);
}

/** Attach to an already installed Debug build without rebuilding or deploying. */
export async function debugQmlInstalled(ctx: vscode.ExtensionContext, services: Services): Promise<void> {
  if (!qtQmlDebuggerIsAvailable()) {
    void services.prompts.showErrorMessage('Sardina: QML/JavaScript debugging requires a current Qt QML extension with its QML debugger. Update theqtcompany.qt-qml and try again.');
    return;
  }
  const project = await activeProjectOrWarn(services);
  if (!project || !(await ensureDebugMonitorAgent(ctx, services, project.folder)) || !(await ensureQmlDebugServer(services, project.folder))) return;
  await installedAppThen(services, 'Sardina: QML/JavaScript Debug Installed App', 'sardina.debugQmlOnDevice', (app, progress, token) =>
    attachQmlDebugger(ctx, services, app, progress, token), project);
}

export function activateQmlDebug(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sardina.debugQmlOnDevice', () => debugQmlOnDevice(ctx, services)),
    vscode.commands.registerCommand('sardina.debugQmlInstalled', () => debugQmlInstalled(ctx, services)),
  );
}
