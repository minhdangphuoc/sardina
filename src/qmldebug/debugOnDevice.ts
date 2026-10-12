import * as vscode from 'vscode';
import type { Services } from '../core/services';
import { deviceSessions } from '../core/deviceSessions';
import { QT_QML_EXTENSION_ID } from '../qtqml/keys';
import { ensureDebugBuild } from '../debug/debugOnDevice';
import { buildDeployThen, installedAppThen, type DeployedApp } from '../tasks/commands';
import { launchInAppTerminal } from '../tasks/appTerminal';
import { resolveDeviceEndpoint, SshForward } from '../agent/sshForward';
import { hasQmlDebugEnabler } from './paths';
import { hasQmlDebugAdapter, qmlDebugPort, qmlDebuggerArgument } from './core';

const QML_SESSION_FIELD = 'sardinaQmlDebugSessionId';
const START_DELAY_MS = 500;

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
  launchInAppTerminal(services, {
    appName: app.project.name,
    binary: app.project.appBinaryPath,
    launchArgs: [...app.launchArgs, qmlDebuggerArgument(port)],
    target: app.target,
    device: app.device,
    cwd: app.cwd,
  });

  // Qt creates the debug server during application startup. The short wait avoids an attach racing
  // that initialization; the adapter reports a normal, actionable error if tooling is unavailable.
  await new Promise<void>((resolve) => setTimeout(resolve, START_DELAY_MS));
  if (token.isCancellationRequested) {
    await forward.close();
    return;
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const config: vscode.DebugConfiguration = {
    type: 'qml',
    request: 'attach',
    name: `Sardina: QML/JS ${app.project.name} on ${app.device}`,
    host: '127.0.0.1',
    port,
    [QML_SESSION_FIELD]: id,
  };
  let session: vscode.DebugSession | undefined;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    sessionRegistration?.dispose();
    deviceRegistration?.dispose();
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
  if (!project || !(await ensureDebugBuild(services, project.folder))) return;
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
  if (!project) return;
  await installedAppThen(services, 'Sardina: QML/JavaScript Debug Installed App', 'sardina.debugQmlOnDevice', (app, progress, token) =>
    attachQmlDebugger(ctx, services, app, progress, token), project);
}

export function activateQmlDebug(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sardina.debugQmlOnDevice', () => debugQmlOnDevice(ctx, services)),
    vscode.commands.registerCommand('sardina.debugQmlInstalled', () => debugQmlInstalled(ctx, services)),
  );
}
