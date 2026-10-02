import * as vscode from 'vscode';
import type { Services } from '../core/services';
import type { SfdkResult } from '../sfdk/runner';
import type { TargetDescriptor } from '../core/types';
import { parseTargetList } from './parseTargetList';
import { setLastTargetList } from './targetListCache';
import { TargetStatusBar } from './statusBar';
import { offerCleanOnTargetChange } from '../tasks/archGuard';

const SHOW_OUTPUT_ACTION = 'Show Output';
const OPEN_DOCS_ACTION = 'Open SDK docs';
const SDK_DOCS_URL = 'https://sailfishos.org/develop/';

/** R34: every error/warning notification offers an action. */
function notifyError(services: Services, message: string): void {
  void services.prompts.showErrorMessage(message, SHOW_OUTPUT_ACTION).then((choice) => {
    if (choice === SHOW_OUTPUT_ACTION) {
      void vscode.commands.executeCommand('sailfish.showOutput');
    }
  });
}

function notifyWarning(services: Services, message: string): void {
  void services.prompts.showWarningMessage(message, SHOW_OUTPUT_ACTION).then((choice) => {
    if (choice === SHOW_OUTPUT_ACTION) {
      void vscode.commands.executeCommand('sailfish.showOutput');
    }
  });
}

/** Defensive: never let a runner rejection escape as an unhandled promise. */
async function fetch(services: Services, args: string[], token?: vscode.CancellationToken): Promise<SfdkResult> {
  try {
    return await services.runner.run({ args, ensureEngine: false, token });
  } catch (err) {
    return {
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
      argv: ['sfdk', ...args],
      durationMs: 0,
      timedOut: false,
      cancelled: false,
    };
  }
}

/** R33: cancellable progress around the list fetch. */
async function fetchTargetsWithProgress(services: Services): Promise<SfdkResult> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Sailfish: listing targets…', cancellable: true },
    (_progress, token) => fetch(services, ['tools', 'target', 'list'], token),
  );
}

export interface TargetListOutcome {
  targets: TargetDescriptor[] | undefined;
  parseFailed: boolean;
  fetchFailed: boolean;
  raw: SfdkResult;
}

/** Fetches + parses the target list, caching a successful result for statusBar.ts's FR-4.5 check. */
export async function loadTargets(services: Services): Promise<TargetListOutcome> {
  const raw = await fetchTargetsWithProgress(services);
  if (raw.exitCode !== 0) {
    return { targets: undefined, parseFailed: false, fetchFailed: true, raw };
  }
  const parsed = parseTargetList(raw.stdout);
  if (!parsed.ok) {
    return { targets: undefined, parseFailed: true, fetchFailed: false, raw };
  }
  setLastTargetList(parsed.value);
  return { targets: parsed.value, parseFailed: false, fetchFailed: false, raw };
}

function visibleTargets(services: Services, targets: TargetDescriptor[]): TargetDescriptor[] {
  const showSnapshots = services.settings.get('showSnapshotTargets');
  return showSnapshots ? targets : targets.filter((t) => !t.isSnapshot);
}

interface TargetQuickPickItem extends vscode.QuickPickItem {
  target: TargetDescriptor;
}

function toQuickPickItem(target: TargetDescriptor): TargetQuickPickItem {
  return {
    label: target.name,
    description: target.arch,
    detail: target.flags.join(','),
    target,
  };
}

async function currentFolder(services: Services): Promise<vscode.WorkspaceFolder | undefined> {
  const active = await services.projects.resolveActive();
  return active?.folder ?? vscode.workspace.workspaceFolders?.[0];
}

/** FR-4.2/FR-4.3: populate a QuickPick from `sfdk tools target list`, persist the pick to sailfish.target. */
async function selectTarget(services: Services, statusBar: TargetStatusBar | undefined): Promise<void> {
  const outcome = await loadTargets(services);
  if (outcome.fetchFailed) {
    notifyWarning(services, 'Sailfish: could not list sfdk targets');
    return;
  }
  if (outcome.parseFailed || !outcome.targets) {
    notifyWarning(services, 'Sailfish: could not parse target list');
    return;
  }

  const shown = visibleTargets(services, outcome.targets);
  if (shown.length === 0) {
    const choice = await services.prompts.showInformationMessage(
      'Sailfish: no Sailfish targets found. Install one via the Sailfish SDK Maintenance Tool.',
      OPEN_DOCS_ACTION,
    );
    if (choice === OPEN_DOCS_ACTION) {
      void vscode.env.openExternal(vscode.Uri.parse(SDK_DOCS_URL));
    }
    return;
  }

  const picked = await services.prompts.showQuickPick(shown.map(toQuickPickItem), {
    placeHolder: 'Select a Sailfish build target',
  });
  if (!picked) {
    return;
  }

  const folder = await currentFolder(services);
  if (!folder) {
    notifyWarning(services, 'Sailfish: no workspace folder to save the selected target to');
    return;
  }
  const config = vscode.workspace.getConfiguration('sailfish', folder.uri);
  await config.update('target', picked.target.name, vscode.ConfigurationTarget.WorkspaceFolder);
  await services.contextKeys.set('sailfish.hasTarget', true);
  statusBar?.refresh();
  void offerCleanOnTargetChange(services, folder, picked.target.name);
}

/** FR-4.4: only ever called on explicit user action, never implicitly from selectTarget. */
async function setSfdkDefaultTarget(services: Services): Promise<void> {
  const outcome = await loadTargets(services);
  if (outcome.fetchFailed) {
    notifyWarning(services, 'Sailfish: could not list sfdk targets');
    return;
  }
  if (outcome.parseFailed || !outcome.targets) {
    notifyWarning(services, 'Sailfish: could not parse target list');
    return;
  }
  const shown = visibleTargets(services, outcome.targets);
  if (shown.length === 0) {
    const choice = await services.prompts.showInformationMessage(
      'Sailfish: no Sailfish targets found. Install one via the Sailfish SDK Maintenance Tool.',
      OPEN_DOCS_ACTION,
    );
    if (choice === OPEN_DOCS_ACTION) {
      void vscode.env.openExternal(vscode.Uri.parse(SDK_DOCS_URL));
    }
    return;
  }

  const picked = await services.prompts.showQuickPick(shown.map(toQuickPickItem), {
    placeHolder: 'Select the sfdk default build target',
  });
  if (!picked) {
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Sailfish: setting default target…', cancellable: true },
    (_progress, token) => fetch(services, ['config', '--global', `target=${picked.target.name}`], token),
  );
  if (result.exitCode !== 0 && !result.cancelled) {
    const firstLine = (result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`).split(/\r?\n/)[0];
    notifyError(services, `Sailfish: setting the sfdk default target failed: ${firstLine}`);
  }
}

/** FR-4 target selection commands. */
export function activateTargets(ctx: vscode.ExtensionContext, services: Services): TargetStatusBar {
  const statusBar = new TargetStatusBar(services);
  ctx.subscriptions.push(statusBar);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('sailfish.selectTarget', () => selectTarget(services, statusBar)),
    vscode.commands.registerCommand('sailfish.setSfdkDefaultTarget', () => setSfdkDefaultTarget(services)),
    services.projects.onDidChange(() => statusBar.refresh()),
    services.sdk.onDidChange(() => statusBar.refetch()),
    services.settings.onDidChange('target', () => statusBar.refetch()),
    services.settings.onDidChange('showSnapshotTargets', () => statusBar.refresh()),
    vscode.window.onDidChangeActiveTextEditor(() => statusBar.refresh()),
  );

  statusBar.refresh();
  return statusBar;
}
