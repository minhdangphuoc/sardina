import * as vscode from 'vscode';
import type { Services } from '../core/services';
import { buildState } from '../build/buildStateCore';
import { applyCleanPlan, nodeCleanFs } from './cleanFs';
import { confirmationMessage, scanProject } from './cleanCore';

const DELETE = 'Delete';

/**
 * Deep clean of everything a build generated in the project folder: qmake Makefiles, objects, moc/rcc output
 * and the sfdk output dirs. Host-side; the folder is shared with the engine. Returns false when nothing was cleaned
 * (cancelled, nothing to do, or a build is running).
 */
export async function cleanProjectBuild(services: Services): Promise<boolean> {
  const project = await services.projects.resolveActive();
  if (!project) {
    void services.prompts.showWarningMessage('Sailfish: no Sailfish project found in this workspace.');
    return false;
  }
  if (buildState.running) {
    void services.prompts.showWarningMessage('Sailfish: a build is running. Stop it before cleaning.');
    return false;
  }
  const root = project.folder.uri.fsPath;
  const plan = scanProject(root, nodeCleanFs);
  if (plan.entries.length === 0) {
    void services.prompts.showInformationMessage(`Sailfish: nothing to clean in ${project.folder.name}.`);
    return true;
  }
  const choice = await services.prompts.showWarningMessage(confirmationMessage(project.folder.name, plan), { modal: true }, DELETE);
  if (choice !== DELETE) {
    return false;
  }
  const result = applyCleanPlan(root, plan, (rel) => services.output.log('info', `clean: deleted ${rel}`));
  for (const f of result.failed) {
    services.output.log('warn', `clean: could not delete ${f.path}: ${f.error}`);
  }
  if (result.failed.length > 0) {
    void services.prompts.showWarningMessage(
      `Sailfish: cleaned ${result.deleted.length} items; ${result.failed.length} could not be deleted (see the Sailfish OS output).`,
    );
    return false;
  }
  void services.prompts.showInformationMessage(`Sailfish: cleaned ${result.deleted.length} generated items in ${project.folder.name}.`);
  return true;
}

/** Clean Project Build, then Build. */
export async function rebuild(services: Services): Promise<void> {
  if (await cleanProjectBuild(services)) {
    await vscode.commands.executeCommand('sailfish.build');
  }
}
