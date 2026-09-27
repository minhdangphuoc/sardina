import * as vscode from 'vscode';
import type { Services } from '../core/services';
import {
  QT_QML_DO_NOT_ASK_KEY,
  QT_QML_ENABLED_KEY,
  QT_QML_EXTENSION_ID,
  QT_QML_MISSING_NOTICE_FLAG,
  QT_QML_SECTION,
  QT_QML_SILENCE_SETTING,
} from './keys';

const MISSING_QT_QML_MESSAGE =
  'The qt-qml extension was not found, so Sailfish OS QML projects will not silence the qmlls language ' +
  'server (which is unusable against Qt 5.6 Sailfish targets). Install theqtcompany.qt-qml (Open VSX) or, ' +
  'for syntax highlighting only, bbenoist.QML (Marketplace).';

/** True unless `qmlls.enabled` is explicitly `false` at workspace/folder scope; a global-scope `false` does not count (FR-8.1). */
function qmllsEnabledOrUnset(config: vscode.WorkspaceConfiguration): boolean {
  const inspected = config.inspect<boolean>(QT_QML_ENABLED_KEY);
  const scoped = inspected?.workspaceFolderValue ?? inspected?.workspaceValue;
  return scoped !== false;
}

/** §2.2: feature-detect the two FR-8.1 keys instead of assuming a fixed qt-qml schema, so a newer/older qt-qml never hard-fails activation. */
function hasQmllsSilenceKeys(config: vscode.WorkspaceConfiguration): boolean {
  const enabled = config.inspect<boolean>(QT_QML_ENABLED_KEY);
  const doNotAsk = config.inspect<boolean>(QT_QML_DO_NOT_ASK_KEY);
  return enabled?.defaultValue !== undefined && doNotAsk?.defaultValue !== undefined;
}

async function showMissingQtQmlNoticeOnce(ctx: vscode.ExtensionContext, services: Services): Promise<void> {
  if (ctx.globalState.get<boolean>(QT_QML_MISSING_NOTICE_FLAG) === true) {
    return;
  }
  await ctx.globalState.update(QT_QML_MISSING_NOTICE_FLAG, true);
  void services.prompts.showInformationMessage(MISSING_QT_QML_MESSAGE);
}

/** FR-8.1: silences qmlls for one Sailfish folder; only writes WorkspaceFolder scope, never `qmlls.additionalImportPaths` (FR-8.8). */
async function silenceFolder(
  folder: vscode.WorkspaceFolder,
  ctx: vscode.ExtensionContext,
  services: Services,
  silencedFolders: Set<string>,
  warnedFolders: Set<string>,
): Promise<void> {
  if (!services.settings.get('qtqml.silenceQmlls', folder.uri)) {
    return;
  }

  const folderKey = folder.uri.toString();

  if (vscode.extensions.getExtension(QT_QML_EXTENSION_ID) === undefined) {
    if (!warnedFolders.has(folderKey)) {
      warnedFolders.add(folderKey);
      services.output.log('warn', `qt-qml extension not found; qmlls left untouched for folder "${folder.name}"`);
    }
    await showMissingQtQmlNoticeOnce(ctx, services);
    return;
  }

  if (silencedFolders.has(folderKey)) {
    return;
  }

  const config = vscode.workspace.getConfiguration(QT_QML_SECTION, folder.uri);
  if (!hasQmllsSilenceKeys(config)) {
    if (!warnedFolders.has(folderKey)) {
      warnedFolders.add(folderKey);
      services.output.log('warn', `qt-qml is missing the qmlls silencing settings keys; qmlls left untouched for folder "${folder.name}"`);
    }
    return;
  }
  if (!qmllsEnabledOrUnset(config)) {
    return;
  }

  try {
    await config.update(QT_QML_ENABLED_KEY, false, vscode.ConfigurationTarget.WorkspaceFolder);
    await config.update(QT_QML_DO_NOT_ASK_KEY, true, vscode.ConfigurationTarget.WorkspaceFolder);
  } catch (err) {
    services.output.log('warn', `failed to silence qmlls for folder "${folder.name}": ${String(err)}`);
    return;
  }

  silencedFolders.add(folderKey);
  services.output.log('info', `qmlls disabled for Sailfish project folder "${folder.name}" (${QT_QML_SILENCE_SETTING})`);
}

async function silenceAll(
  ctx: vscode.ExtensionContext,
  services: Services,
  silencedFolders: Set<string>,
  warnedFolders: Set<string>,
): Promise<void> {
  for (const project of services.projects.projects()) {
    await silenceFolder(project.folder, ctx, services, silencedFolders, warnedFolders);
  }
}

/** FR-8.1: on activation and on ProjectRegistry changes, disables qmlls per Sailfish folder (qt-qml needs Qt >= 6.8, Sailfish ships 5.6). */
export function activateQtQml(ctx: vscode.ExtensionContext, services: Services): void {
  const silencedFolders = new Set<string>();
  const warnedFolders = new Set<string>();

  const run = (): void => {
    silenceAll(ctx, services, silencedFolders, warnedFolders).catch((err: unknown) => {
      services.output.log('warn', `qt-qml silencing pass failed: ${String(err)}`);
    });
  };

  run();

  ctx.subscriptions.push(services.projects.onDidChange(run));
}
