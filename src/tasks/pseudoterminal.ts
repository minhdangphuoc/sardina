import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Services } from '../core/services';
import type { ProjectDescriptor } from '../core/types';
import type { SailfishTaskDefinitionLike } from './argv';
import { buildArgs, checkArgs, cleanArgs, deployArgs, isValidAppName, packageArgs, runArgs } from './argv';
import { chooseLauncher } from './launcher';
import { PathMapCache, mapEngineLine, normalizeSeverity, prefixSpecLine } from './pathMap';
import { mapBuildError, mapDeployError, type MappedError } from './errors';
import { runNotificationAction } from './notify';
import { NO_TIMEOUT } from '../sfdk/runner';
import { deployInstallsApp } from './buildConfig';

const SHOW_OUTPUT_ACTION = 'Show output';

/** One `sfdk engine exec -- pwd` probe cache per extension-host session (FR-5.9). */
const sessionPathMapCache = new PathMapCache();

interface Step {
  argv: string[];
  ignoreFailure?: boolean;
  ensureEngine?: boolean;
  /** AC-1.5: `-c device=` is only meaningful for deploy and device-exec steps, never plain build/check/package/clean. */
  usesDevice?: boolean;
  /** FR-5.6: retried when the primary argv fails (clean's make-clean -> build-shell rm -rf). */
  fallbackArgv?: string[];
  /** M1.23: marks the run task's actual app-launch step, as opposed to its pkill pre-step. */
  isLaunch?: boolean;
}

function specRelativePath(project: ProjectDescriptor): string {
  return path.relative(project.folder.uri.fsPath, project.specPath).split(path.sep).join('/');
}

/** Computes the sfdk invocations a task issues (FR-5.3..5.6); since the Task API has no `dependsOn`, deploy/run prepend their own prerequisite steps here. */
function stepsFor(project: ProjectDescriptor, def: SailfishTaskDefinitionLike, services: Services): Step[] {
  const folderUri = project.folder.uri;
  switch (def.command) {
    case 'build': {
      const extraArgs = def.extraArgs ?? services.settings.get('build.extraArgs', folderUri);
      return [
        {
          argv: buildArgs(
            { ...def, extraArgs },
            {
              runHarbourCheck: services.settings.get('build.runHarbourCheck', folderUri),
              jobs: services.settings.get('build.jobs', folderUri),
              buildType: services.settings.get('build.type', folderUri),
            },
          ),
          ensureEngine: true,
        },
      ];
    }
    case 'deploy':
      return [
        ...stepsFor(project, { command: 'build' }, services),
        { argv: deployArgs(def, { method: services.settings.get('deploy.method', folderUri) }), usesDevice: true },
      ];
    case 'run': {
      const launcherTokens = chooseLauncher(project, {
        mode: services.settings.get('run.launcher', folderUri),
        customCommand: services.settings.get('run.customCommand', folderUri),
      });
      const { pkillArgs, launchArgs } = runArgs(project.appBinaryPath, launcherTokens, {
        killBeforeLaunch: services.settings.get('run.killBeforeLaunch', folderUri),
      });
      const steps: Step[] = [...stepsFor(project, { command: 'deploy' }, services)];
      if (!deployInstallsApp(services.settings.get('deploy.method', folderUri))) {
        // A manual deploy only copies the RPM to ~/RPMS; there is nothing installed to launch.
        return steps;
      }
      if (pkillArgs) {
        steps.push({ argv: pkillArgs, ignoreFailure: true, usesDevice: true });
      }
      steps.push({ argv: launchArgs, usesDevice: true, isLaunch: true });
      return steps;
    }
    case 'package':
      return [{ argv: packageArgs(def), ensureEngine: true }];
    case 'check':
      return [{ argv: checkArgs(), ensureEngine: true }];
    case 'clean': {
      const hasNativeBuildDir = project.buildSystem === 'qmake' || project.buildSystem === 'cmake';
      const step: Step = { argv: cleanArgs(hasNativeBuildDir), ensureEngine: true };
      if (hasNativeBuildDir) {
        step.fallbackArgv = cleanArgs(false);
      }
      return [step];
    }
    default:
      return [];
  }
}

const DIAGNOSTIC_LINE_RE = /^(fatal error|error|warning|note|ERROR|WARNING|INFO)\b/;

/** FR-5.7/FR-5.9 Pseudoterminal: streams sfdk output, rewrites engine-side paths, prefixes diagnostic lines with the spec path, maps `fatal error` -> `error`. */
export class SailfishPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  private readonly cts = new vscode.CancellationTokenSource();
  private launchStarted = false;
  private finished = false;
  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;

  constructor(
    private readonly services: Services,
    private readonly project: ProjectDescriptor,
    private readonly def: SailfishTaskDefinitionLike,
  ) {}

  private write(text: string): void {
    this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
  }

  private emitLine(line: string, engineMapping: string | null, prefixSpec: boolean): void {
    let out = normalizeSeverity(line);
    if (engineMapping) {
      out = mapEngineLine(out, engineMapping, this.project.folder.uri.fsPath);
    }
    if (prefixSpec && DIAGNOSTIC_LINE_RE.test(out)) {
      out = prefixSpecLine(out, specRelativePath(this.project));
    }
    this.write(`${out}\n`);
  }

  open(): void {
    // First line within 1s of task start (FR-5.7).
    this.write(`$ sfdk ${this.def.command}\n`);
    void this.run();
  }

  private async run(): Promise<void> {
    const folder = this.project.folder;
    const target = this.def.target || this.services.settings.get('target', folder.uri) || undefined;
    const device = this.def.device || this.services.settings.get('device', folder.uri) || undefined;
    const prefixSpec = this.def.command === 'build' || this.def.command === 'check';

    let engineMapping: string | null = null;
    if (prefixSpec) {
      engineMapping = await sessionPathMapCache.ensure(this.services, folder);
    }

    let steps: Step[];
    try {
      steps = stepsFor(this.project, this.def, this.services);
    } catch (err) {
      this.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      this.finished = true;
      this.closeEmitter.fire(1);
      return;
    }

    let step: Step;
    const runInvocation = (argv: string[]) =>
      this.services.runner.run({
        args: argv,
        target,
        device: step.usesDevice ? device : undefined,
        cwd: folder.uri.fsPath,
        token: this.cts.token,
        timeoutMs: step.isLaunch ? NO_TIMEOUT : undefined,
        ensureEngine: step.ensureEngine,
        onLine: (line, stream) => {
          this.emitLine(line, engineMapping, prefixSpec);
          if (stream !== 'stderr') {
            return;
          }
          const mapped =
            this.def.command === 'deploy'
              ? mapDeployError(line)
              : this.def.command === 'build'
                ? mapBuildError(line)
                : undefined;
          if (mapped) {
            void this.notifyMappedError(mapped);
          }
        },
      });

    let exitCode = 0;
    for (step of steps) {
      if (this.cts.token.isCancellationRequested) {
        exitCode = 1;
        break;
      }
      this.write(`$ sfdk ${step.argv.join(' ')}\n`);
      if (step.isLaunch) {
        this.launchStarted = true;
      }
      try {
        let result = await runInvocation(step.argv);
        if (result.exitCode !== 0 && step.fallbackArgv) {
          this.write(`$ sfdk ${step.fallbackArgv.join(' ')}\n`);
          result = await runInvocation(step.fallbackArgv);
        }
        if (result.exitCode !== 0 && !step.ignoreFailure) {
          if (this.def.command === 'clean') {
            void this.notifyCleanFailed();
          }
          exitCode = result.exitCode;
          break;
        }
      } catch (err) {
        this.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!step.ignoreFailure) {
          if (this.def.command === 'clean') {
            void this.notifyCleanFailed();
          }
          exitCode = 1;
          break;
        }
      }
    }
    this.finished = true;
    this.closeEmitter.fire(exitCode);
  }

  close(): void {
    this.cts.cancel();
    if (this.def.command === 'run' && this.launchStarted && !this.finished) {
      void this.killRemoteRun();
    }
  }

  /** M1.23: best-effort remote kill on stop, mirroring the run task's own pkill (FR-5.5); never kills a launch that already finished. */
  private async killRemoteRun(): Promise<void> {
    const name = path.basename(this.project.appBinaryPath);
    if (!isValidAppName(name)) {
      return;
    }
    const folder = this.project.folder;
    const device = this.def.device || this.services.settings.get('device', folder.uri) || undefined;
    try {
      await this.services.runner.run({
        args: ['device', 'exec', '--', 'pkill', '-f', this.project.appBinaryPath],
        device,
        cwd: folder.uri.fsPath,
      });
    } catch {
      // best-effort only
    }
  }

  /** R34/M1.17: every mapped error notification offers at least "Show output", plus its own action when relevant. */
  private async notifyMappedError(mapped: MappedError): Promise<void> {
    const actions = mapped.actionLabel ? [mapped.actionLabel, SHOW_OUTPUT_ACTION] : [SHOW_OUTPUT_ACTION];
    const choice = await this.services.prompts.showErrorMessage(mapped.message, ...actions);
    await runNotificationAction(this.services, choice);
  }

  /** FR-5.6: clean is non-critical, so a failed fallback only warns with manual instructions. */
  private async notifyCleanFailed(): Promise<void> {
    const choice = await this.services.prompts.showWarningMessage(
      'Sailfish: automatic clean failed. Manual clean: remove RPMS/BUILD/BUILDROOT under the sfdk output dir, or run "sfdk make -- clean" yourself.',
      SHOW_OUTPUT_ACTION,
    );
    await runNotificationAction(this.services, choice);
  }
}
