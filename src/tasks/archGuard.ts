import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Services } from '../core/services';
import { cleanArgs } from './argv';
import { staleBuildTarget, targetArch } from './buildConfig';

const CLEAN = 'Clean';
const CLEAN_AND_BUILD = 'Clean & Build';
const NOT_NOW = 'Not now';
const ALWAYS = 'Always clean automatically';

function readSfdkTarget(folder: vscode.WorkspaceFolder): string | undefined {
  try {
    return fs.readFileSync(path.join(folder.uri.fsPath, '.sfdk', 'target'), 'utf8');
  } catch {
    return undefined; // never built with sfdk here
  }
}

/** Cleans with the previous target (its Makefile and objects are for that arch) and drops RPMS so no stale-arch package is deployed. */
async function cleanStaleOutput(services: Services, folder: vscode.WorkspaceFolder, previousTarget: string): Promise<boolean> {
  const cwd = folder.uri.fsPath;
  const project = services.projects.forFolder(folder);
  const nativeBuildDir = project?.buildSystem === 'qmake' || project?.buildSystem === 'cmake';
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Sailfish: cleaning ${targetArch(previousTarget)} build output…` },
    () =>
      services.runner.run({
        args: nativeBuildDir ? ['make', '--', 'distclean'] : cleanArgs(false),
        target: previousTarget,
        cwd,
        ensureEngine: true,
      }),
  );
  fs.rmSync(path.join(cwd, 'RPMS'), { recursive: true, force: true });
  if (result.exitCode !== 0) {
    services.output.log('warn', `clean before arch change failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`);
    void services.prompts.showWarningMessage(
      'Sailfish: could not fully clean the previous build. Run "Sailfish: Clean" or delete the build files, then try again.',
    );
    return false;
  }
  return true;
}

async function rememberAlways(folder: vscode.WorkspaceFolder): Promise<void> {
  await vscode.workspace
    .getConfiguration('sailfish', folder.uri)
    .update('build.cleanOnArchChange', true, vscode.ConfigurationTarget.WorkspaceFolder);
}

/** After Select Target: offers to clean when the new target's architecture differs from the last build's. */
export async function offerCleanOnTargetChange(services: Services, folder: vscode.WorkspaceFolder, newTarget: string): Promise<void> {
  const previous = staleBuildTarget(readSfdkTarget(folder), newTarget);
  if (!previous) return;
  if (services.settings.get('build.cleanOnArchChange', folder.uri)) {
    await cleanStaleOutput(services, folder, previous);
    return;
  }
  const choice = await services.prompts.showWarningMessage(
    `Sailfish: target architecture changed (${targetArch(previous)} → ${targetArch(newTarget)}). ` +
      `The existing build output is for ${targetArch(previous)}; building on top of it produces a broken package. Clean now?`,
    CLEAN,
    NOT_NOW,
    ALWAYS,
  );
  if (choice === ALWAYS) await rememberAlways(folder);
  if (choice === CLEAN || choice === ALWAYS) await cleanStaleOutput(services, folder, previous);
}

/**
 * Before build/deploy/run: returns false to abort when the in-source build output is for another
 * architecture and the user doesn't want it cleaned; cleans first otherwise.
 */
export async function ensureBuildMatchesTargetArch(services: Services, folder: vscode.WorkspaceFolder, target: string): Promise<boolean> {
  const previous = staleBuildTarget(readSfdkTarget(folder), target);
  if (!previous) return true;
  if (!services.settings.get('build.cleanOnArchChange', folder.uri)) {
    const choice = await services.prompts.showWarningMessage(
      `Sailfish: the build output is for ${targetArch(previous)} but the target is ${targetArch(target)}. Clean it first?`,
      { modal: true },
      CLEAN_AND_BUILD,
      ALWAYS,
    );
    if (choice === undefined) return false;
    if (choice === ALWAYS) await rememberAlways(folder);
  }
  // A failed clean leaves old-architecture output behind: building on it makes the broken package this guard exists to prevent.
  return cleanStaleOutput(services, folder, previous);
}
