import * as vscode from 'vscode';
import type { SardinaContextKey } from './types';
import type { Services } from './services';

const ALL_KEYS: SardinaContextKey[] = [
  'sardina.isProject',
  'sardina.projectCount',
  'sardina.sdkAvailable',
  'sardina.platformSupported',
  'sardina.hasTarget',
  'sardina.hasDevice',
];

/**
 * Wraps `vscode.commands.executeCommand('setContext', ...)` and keeps a local
 * snapshot so other modules (and tests, via the test seam) can read the
 * current value without needing VS Code's own context-key introspection.
 */
export class ContextKeys {
  private readonly values = new Map<string, boolean | number>();

  async set(key: SardinaContextKey, value: boolean | number): Promise<void> {
    this.values.set(key, value);
    await vscode.commands.executeCommand('setContext', key, value);
  }

  get(key: SardinaContextKey): boolean | number | undefined {
    return this.values.get(key);
  }

  snapshot(): Record<string, boolean | number> {
    return Object.fromEntries(this.values.entries());
  }
}

/**
 * The workspace folder `sardina.target`/`sardina.device` (resource scope)
 * should be evaluated for: the active editor's project folder, else the
 * single SFOS project. Unlike FR-2.5's resolveActiveProject this never
 * prompts — background context refresh must not pop a QuickPick.
 */
function scopeFolder(services: Services): vscode.WorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (folder && services.projects.forFolder(folder)) {
      return folder;
    }
  }
  const projects = services.projects.projects();
  return projects.length === 1 ? projects[0].folder : undefined;
}

async function refreshProjectKeys(services: Services): Promise<void> {
  const projects = services.projects.projects();
  await services.contextKeys.set('sardina.isProject', projects.length > 0);
  await services.contextKeys.set('sardina.projectCount', projects.length);
}

async function refreshTargetDeviceKeys(services: Services): Promise<void> {
  const folder = scopeFolder(services);
  const target = services.settings.get('target', folder?.uri);
  const device = services.settings.get('device', folder?.uri);
  await services.contextKeys.set('sardina.hasTarget', typeof target === 'string' && target.length > 0);
  await services.contextKeys.set('sardina.hasDevice', typeof device === 'string' && device.length > 0);
}

export function activateContextKeys(ctx: vscode.ExtensionContext, services: Services): void {
  for (const key of ALL_KEYS) {
    const initial = key === 'sardina.projectCount' ? 0 : false;
    void services.contextKeys.set(key, initial);
  }

  void refreshProjectKeys(services);
  void refreshTargetDeviceKeys(services);

  ctx.subscriptions.push(
    services.projects.onDidChange(() => {
      void refreshProjectKeys(services);
      void refreshTargetDeviceKeys(services);
    }),
    services.settings.onDidChange('target', () => void refreshTargetDeviceKeys(services)),
    services.settings.onDidChange('device', () => void refreshTargetDeviceKeys(services)),
    vscode.window.onDidChangeActiveTextEditor(() => void refreshTargetDeviceKeys(services)),
  );
}
