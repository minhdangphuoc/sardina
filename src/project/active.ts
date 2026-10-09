import * as vscode from 'vscode';
import type { ProjectDescriptor } from '../core/types';
import type { ProjectRegistry } from './detect';
import { prompts } from '../ui/prompts';

/**
 * FR-2.5: resolves the "active" project for commands that need exactly one —
 * (a) the active editor's workspace folder, (b) the single SFOS project,
 * (c) a QuickPick when there is more than one, (d) undefined otherwise.
 */
export async function resolveActiveProject(registry: ProjectRegistry): Promise<ProjectDescriptor | undefined> {
  const projects = registry.projects();
  if (projects.length === 0) {
    return undefined;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeFolder) {
      const project = registry.forFolder(activeFolder);
      if (project) {
        return project;
      }
    }
  }

  if (projects.length === 1) {
    return projects[0];
  }

  const picked = await prompts.showQuickPick(
    projects.map((p) => ({ label: p.name, description: p.folder.name, project: p })),
    { placeHolder: 'Select the SFOS project' },
  );
  return picked?.project;
}
