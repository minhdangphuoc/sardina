import * as vscode from 'vscode';
import type { Services } from '../core/services';
import type { ProjectDescriptor } from '../core/types';
import { SailfishPseudoterminal } from './pseudoterminal';
import type { SailfishTaskDefinitionLike } from './argv';

export const SAILFISH_TASK_TYPE = 'sailfish';

export interface SailfishTaskDefinition extends vscode.TaskDefinition, SailfishTaskDefinitionLike {}

function makeTask(
  services: Services,
  project: ProjectDescriptor,
  def: SailfishTaskDefinitionLike,
  label: string,
): vscode.Task {
  const definition: SailfishTaskDefinition = { type: SAILFISH_TASK_TYPE, ...def };
  return new vscode.Task(
    definition,
    project.folder,
    label,
    SAILFISH_TASK_TYPE,
    new vscode.CustomExecution(
      () => Promise.resolve(new SailfishPseudoterminal(services, project, definition)),
    ),
  );
}

/** FR-5.8: groups + problem matchers per task command. */
function applyGroupAndMatchers(task: vscode.Task, command: SailfishTaskDefinitionLike['command']): void {
  if (command === 'build') {
    task.group = vscode.TaskGroup.Build;
    task.problemMatchers = ['$sailfish-gcc', '$sailfish-qmake', '$sailfish-rpmbuild'];
  } else if (command === 'check') {
    task.problemMatchers = ['$sailfish-rpmvalidator'];
  } else if (command === 'clean') {
    task.group = vscode.TaskGroup.Clean;
  } else if (command === 'package') {
    task.group = vscode.TaskGroup.Build;
  }
}

/** FR-5.2: the fixed task list offered for each Sailfish project. */
function tasksForProject(services: Services, project: ProjectDescriptor): vscode.Task[] {
  const build = makeTask(services, project, { command: 'build' }, 'build');
  applyGroupAndMatchers(build, 'build');

  const buildDebug = makeTask(services, project, { command: 'build', debug: true }, 'build (debug)');
  applyGroupAndMatchers(buildDebug, 'build');

  // FR-5.4/5.5: no vscode.Task dependsOn API, so deploy/run's prerequisite is extra steps in pseudoterminal.ts#stepsFor.
  const deploy = makeTask(services, project, { command: 'deploy' }, 'deploy');
  applyGroupAndMatchers(deploy, 'deploy');

  const run = makeTask(services, project, { command: 'run' }, 'run');
  applyGroupAndMatchers(run, 'run');

  const pkg = makeTask(services, project, { command: 'package' }, 'package');
  applyGroupAndMatchers(pkg, 'package');

  const check = makeTask(services, project, { command: 'check' }, 'check');
  applyGroupAndMatchers(check, 'check');

  const clean = makeTask(services, project, { command: 'clean' }, 'clean');
  applyGroupAndMatchers(clean, 'clean');

  return [build, buildDebug, deploy, run, pkg, check, clean];
}

/** FR-5.1 TaskProvider for task type "sailfish". */
export class SailfishTaskProvider implements vscode.TaskProvider {
  constructor(private readonly services: Services) {}

  provideTasks(): vscode.Task[] {
    return this.services.projects.projects().flatMap((project) => tasksForProject(this.services, project));
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as Partial<SailfishTaskDefinition>;
    if (def.type !== SAILFISH_TASK_TYPE || !def.command) {
      return undefined;
    }
    // task.scope is a WorkspaceFolder object, or a numeric TaskScope for workspace-/global-scoped tasks.
    const folder = typeof task.scope === 'object' ? task.scope : undefined;
    const projects = this.services.projects.projects();
    const project = (folder && this.services.projects.forFolder(folder)) ?? projects[0];
    if (!project) {
      return undefined;
    }
    const full: SailfishTaskDefinitionLike = { ...def, command: def.command };
    const resolved = makeTask(this.services, project, full, task.name || def.command);
    applyGroupAndMatchers(resolved, def.command);
    return resolved;
  }
}

export function activateTasks(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push(
    vscode.tasks.registerTaskProvider(SAILFISH_TASK_TYPE, new SailfishTaskProvider(services)),
  );
}
