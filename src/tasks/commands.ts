import * as vscode from 'vscode';
import type { Services } from '../core/services';
import type { ProjectDescriptor } from '../core/types';
import { activateTasks as registerTaskProvider, SAILFISH_TASK_TYPE, type SailfishTaskDefinition } from './provider';
import { buildArgs, deployArgs, runArgs } from './argv';
import { chooseLauncher } from './launcher';
import { mapBuildError, mapDeployError, type MappedError } from './errors';
import { runNotificationAction } from './notify';
import { launchInAppTerminal } from './appTerminal';
import { deployInstallsApp, deployMethodLabel } from './buildConfig';
import { ensureBuildMatchesTargetArch } from './archGuard';
import { whitespacePathWarning } from './pathGuard';
import { resolveSigningUser } from './signingGuard';

async function ensureTarget(services: Services, folder: vscode.WorkspaceFolder): Promise<boolean> {
  const target = services.settings.get('target', folder.uri);
  if (target) {
    return true;
  }
  await vscode.commands.executeCommand('sailfish.selectTarget');
  return Boolean(services.settings.get('target', folder.uri));
}

/** Guards against reusing another architecture's in-source build output (archGuard.ts). */
function ensureArchClean(services: Services, folder: vscode.WorkspaceFolder): Promise<boolean> {
  const target = services.settings.get('target', folder.uri);
  return target ? ensureBuildMatchesTargetArch(services, folder, target) : Promise.resolve(true);
}

async function activeProjectOrWarn(services: Services): Promise<ProjectDescriptor | undefined> {
  const project = await services.projects.resolveActive();
  if (!project) {
    void services.prompts.showWarningMessage('Sailfish: no Sailfish project found in this workspace.');
  }
  return project;
}

function findTask(tasks: vscode.Task[], command: string, project: ProjectDescriptor): vscode.Task | undefined {
  return tasks.find((t) => {
    const def = t.definition as Partial<SailfishTaskDefinition>;
    const scope = t.scope as vscode.WorkspaceFolder | undefined;
    return (
      def.type === SAILFISH_TASK_TYPE &&
      def.command === command &&
      scope?.uri.toString() === project.folder.uri.toString()
    );
  });
}

/** FR-5.10: build/deploy/run/package go through `tasks.executeTask` (so `dependsOn` chains run). */
function makeExecuteTaskCommand(services: Services, command: 'build' | 'deploy' | 'run' | 'package') {
  return async (): Promise<void> => {
    const project = await activeProjectOrWarn(services);
    if (!project) {
      return;
    }
    if (!(await ensureTarget(services, project.folder))) {
      return;
    }
    if (command !== 'package' && !(await ensureArchClean(services, project.folder))) {
      return;
    }
    const tasks = await vscode.tasks.fetchTasks({ type: SAILFISH_TASK_TYPE });
    const task = findTask(tasks, command, project);
    if (!task) {
      const SHOW_OUTPUT = 'Show output';
      void services.prompts.showErrorMessage(`Sailfish: could not find the "${command}" task`, SHOW_OUTPUT).then((choice) => {
        if (choice === SHOW_OUTPUT) {
          services.output.show();
        }
      });
      return;
    }
    await vscode.tasks.executeTask(task);
  };
}

/** Fire-and-forget: a command's own completion must never block on the user dismissing a notification (NFR-1-adjacent). */
function reportFailure(services: Services, stage: string, mapped: MappedError | undefined): void {
  const message = mapped?.message ?? `Sailfish: ${stage} failed`;
  const actions = mapped?.actionLabel ? [mapped.actionLabel, 'Show output'] : ['Show output'];
  void services.prompts.showErrorMessage(message, ...actions).then((chosen) => void runNotificationAction(services, chosen));
}

/** FR-5.10 exception: build -> deploy -> run via SfdkRunner directly, one invocation each, stopping on the first non-zero exit. */
/** What Run and Debug need once the app is built and installed on the device. */
export interface DeployedApp {
  project: ProjectDescriptor;
  target: string | undefined;
  device: string | undefined;
  cwd: string;
  /** `pkill` for a running instance (unless run.killBeforeLaunch is off) and the launch command. */
  pkillArgs: string[] | undefined;
  launchArgs: string[];
}

/**
 * Shared by Run and Debug: project/target/arch checks, then build and deploy (one invocation each,
 * stopping on the first non-zero exit) under a progress notification, then `then` with the
 * progress still showing. A manual deploy stops before `then`, since nothing is installed.
 */
export async function buildDeployThen(
  services: Services,
  title: string,
  then: (app: DeployedApp, progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<void>,
  resolvedProject?: ProjectDescriptor,
): Promise<void> {
  const project = resolvedProject ?? (await activeProjectOrWarn(services));
  if (!project) {
    return;
  }
  if (!(await ensureTarget(services, project.folder))) {
    return;
  }
  if (!(await ensureArchClean(services, project.folder))) {
    return;
  }

  const folderUri = project.folder.uri;
  const cwd = folderUri.fsPath;
  const pathWarning = whitespacePathWarning(cwd);
  if (pathWarning) {
    services.output.log('warn', pathWarning);
    void services.prompts.showWarningMessage(`Sailfish: ${pathWarning}`);
  }
  const signing = await resolveSigningUser(services, folderUri);
  if (!signing.ok) {
    reportFailure(services, 'build', { message: `Sailfish: ${signing.message}`, actionLabel: 'Set up signing' });
    return;
  }
  const target = services.settings.get('target', folderUri) || undefined;
  const device = services.settings.get('device', folderUri) || undefined;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      progress.report({ message: 'building…' });
      const buildResult = await services.runner.run({
        args: buildArgs(
          { command: 'build', extraArgs: services.settings.get('build.extraArgs', folderUri) },
          {
            runHarbourCheck: services.settings.get('build.runHarbourCheck', folderUri),
            jobs: services.settings.get('build.jobs', folderUri),
            buildType: services.settings.get('build.type', folderUri),
            sign: services.settings.get('build.sign', folderUri),
            signingUser: signing.user,
            signingPassphraseFile: services.settings.get('build.signingPassphraseFile', folderUri),
          },
        ),
        target,
        // No `device`: building needs none (AC-1.5), and a device that is no longer registered would fail it.
        cwd,
        token,
        ensureEngine: true,
      });
      if (buildResult.exitCode !== 0) {
        reportFailure(services, 'build', mapBuildError(buildResult.stderr));
        return;
      }
      if (token.isCancellationRequested) {
        return;
      }

      progress.report({ message: 'deploying…' });
      const deployResult = await services.runner.run({
        args: deployArgs({ command: 'deploy' }, { method: services.settings.get('deploy.method', folderUri) }),
        target,
        device,
        cwd,
        token,
      });
      if (deployResult.exitCode !== 0) {
        reportFailure(services, 'deploy', mapDeployError(deployResult.stderr));
        return;
      }
      if (token.isCancellationRequested) {
        return;
      }
      const method = services.settings.get('deploy.method', folderUri);
      if (!deployInstallsApp(method)) {
        void services.prompts.showInformationMessage(
          `Sailfish: ${deployMethodLabel(method)} done — the RPM is in ~/RPMS on the device; install it there to run it.`,
        );
        return;
      }

      await then({ project, target, device, cwd, ...launchPlan(services, project) }, progress, token);
    },
  );
}

/** The `pkill` (unless run.killBeforeLaunch is off) and launch argv for the project's app, per the launcher settings. */
function launchPlan(services: Services, project: ProjectDescriptor): Pick<DeployedApp, 'pkillArgs' | 'launchArgs'> {
  const folderUri = project.folder.uri;
  const launcherTokens = chooseLauncher(project, {
    mode: services.settings.get('run.launcher', folderUri),
    customCommand: services.settings.get('run.customCommand', folderUri),
  });
  const { pkillArgs, launchArgs } = runArgs(project.appBinaryPath, launcherTokens, {
    killBeforeLaunch: services.settings.get('run.killBeforeLaunch', folderUri),
  });
  return { pkillArgs, launchArgs };
}

/** true/false when the device answered; undefined when it could not be asked (unreachable, no device…). */
async function appIsInstalled(services: Services, project: ProjectDescriptor, device: string, cwd: string): Promise<boolean | undefined> {
  const result = await services.runner.run({ args: ['device', 'exec', '--', 'test', '-e', project.appBinaryPath], device, cwd, timeoutMs: 30_000 });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return undefined;
}

/**
 * Shared by Run Installed App and Debug Installed App: like buildDeployThen without the build and
 * deploy steps, for an app already on the device. When the device says the app is missing, offers
 * `fullCommand` (the matching build-deploy-launch command) instead.
 */
export async function installedAppThen(
  services: Services,
  title: string,
  fullCommand: 'sailfish.buildDeployRun' | 'sailfish.debugOnDevice',
  then: (app: DeployedApp, progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<void>,
  resolvedProject?: ProjectDescriptor,
): Promise<void> {
  const project = resolvedProject ?? (await activeProjectOrWarn(services));
  if (!project) {
    return;
  }
  const folderUri = project.folder.uri;
  const cwd = folderUri.fsPath;
  const target = services.settings.get('target', folderUri) || undefined;
  const device = services.settings.get('device', folderUri) || undefined;
  if (!device) {
    reportFailure(services, 'launch', { message: 'No device selected — pick a default device or emulator', actionLabel: 'Select device' });
    return;
  }
  if (!deployInstallsApp(services.settings.get('deploy.method', folderUri))) {
    void services.prompts.showInformationMessage(
      'Sailfish: the deploy method only copies the RPM to the device, so there is no installed app to launch. Pick another deploy method.',
    );
    return;
  }

  const BUILD_AND_DEPLOY = 'Build & Deploy first';
  if ((await appIsInstalled(services, project, device, cwd)) === false) {
    const choice = await services.prompts.showWarningMessage(
      `Sailfish: ${project.name} is not installed on "${device}" (${project.appBinaryPath} is missing).`,
      BUILD_AND_DEPLOY,
    );
    if (choice === BUILD_AND_DEPLOY) await vscode.commands.executeCommand(fullCommand);
    return;
  }

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (progress, token) =>
    then({ project, target, device, cwd, ...launchPlan(services, project) }, progress, token),
  );
}

/** Stops a running instance (unless disabled), then launches the app in its own terminal. */
async function launchApp(
  services: Services,
  app: DeployedApp,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken,
): Promise<void> {
  progress.report({ message: 'launching…' });
  if (app.pkillArgs) {
    await services.runner.run({ args: app.pkillArgs, target: app.target, device: app.device, cwd: app.cwd, token });
  }
  // The app outlives this progress notification: its output and stop control live in a terminal.
  launchInAppTerminal(services, {
    appName: app.project.name,
    launchArgs: app.launchArgs,
    target: app.target,
    device: app.device,
    cwd: app.cwd,
  });
}

/** FR-5.10 exception: build -> deploy -> run via SfdkRunner directly. */
function buildDeployRun(services: Services): Promise<void> {
  return buildDeployThen(services, 'Sailfish: Build, Deploy & Run', (app, progress, token) => launchApp(services, app, progress, token));
}

/** Launches the app already on the device, without building or deploying. */
function runInstalled(services: Services): Promise<void> {
  return installedAppThen(services, 'Sailfish: Run Installed App', 'sailfish.buildDeployRun', (app, progress, token) =>
    launchApp(services, app, progress, token),
  );
}

/** FR-5.6 clean: non-critical, fails soft with manual instructions. */
async function clean(services: Services): Promise<void> {
  const project = await activeProjectOrWarn(services);
  if (!project) {
    return;
  }
  try {
    const tasks = await vscode.tasks.fetchTasks({ type: SAILFISH_TASK_TYPE });
    const task = findTask(tasks, 'clean', project);
    if (!task) {
      throw new Error('clean task not found');
    }
    await vscode.tasks.executeTask(task);
  } catch (err) {
    void services.prompts.showWarningMessage(
      `Sailfish: automatic clean could not run (${err instanceof Error ? err.message : String(err)}). ` +
        'Manual clean: remove the sfdk build output (RPMS/BUILD/BUILDROOT under the sfdk output dir) or run "sfdk make -- clean" yourself.',
    );
  }
}

/** Registers the TaskProvider (provider.ts) and the FR-5.10 commands. */
export function activateTasks(ctx: vscode.ExtensionContext, services: Services): void {
  registerTaskProvider(ctx, services);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('sailfish.build', makeExecuteTaskCommand(services, 'build')),
    vscode.commands.registerCommand('sailfish.deploy', makeExecuteTaskCommand(services, 'deploy')),
    vscode.commands.registerCommand('sailfish.run', makeExecuteTaskCommand(services, 'run')),
    vscode.commands.registerCommand('sailfish.buildDeployRun', () => buildDeployRun(services)),
    vscode.commands.registerCommand('sailfish.runInstalled', () => runInstalled(services)),
    vscode.commands.registerCommand('sailfish.package', makeExecuteTaskCommand(services, 'package')),
    vscode.commands.registerCommand('sailfish.clean', () => clean(services)),
  );
}
