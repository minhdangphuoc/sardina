import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Services } from './services';
import {
  OLD_EXTENSION_ID,
  OLD_SECTION,
  copyOldStorage,
  remapStoragePath,
  scopesToCopy,
  type Inspected,
  type SettingScope,
} from './migrationCore';

const NEW_SECTION = 'sardina';
const STORAGE_DONE_KEY = 'sardina.migration.storageDone';
const GLOBAL_DONE_KEY = 'sardina.migration.globalSettingsDone';
const WORKSPACE_DONE_KEY = 'sardina.migration.workspaceSettingsDone';

/** The contributed setting names without the section, e.g. `build.type`. */
function contributedKeys(ctx: vscode.ExtensionContext): string[] {
  const properties = (ctx.extension.packageJSON as { contributes?: { configuration?: { properties?: object } } })
    .contributes?.configuration?.properties;
  return Object.keys(properties ?? {}).map((key) => key.slice(NEW_SECTION.length + 1));
}

function migrateStorage(ctx: vscode.ExtensionContext, services: Services): void {
  if (ctx.globalState.get<boolean>(STORAGE_DONE_KEY)) {
    return;
  }
  const newDir = ctx.globalStorageUri.fsPath;
  const oldDir = path.join(path.dirname(newDir), OLD_EXTENSION_ID);
  const copied = copyOldStorage(oldDir, newDir);
  if (copied.length > 0) {
    services.output.log('info', `Copied ${copied.join(', ')} from the previous extension's storage.`);
  }
  void ctx.globalState.update(STORAGE_DONE_KEY, true);
}

async function copySetting(
  key: string,
  scope: SettingScope,
  value: unknown,
  folder: vscode.WorkspaceFolder | undefined,
): Promise<void> {
  const target = {
    globalValue: vscode.ConfigurationTarget.Global,
    workspaceValue: vscode.ConfigurationTarget.Workspace,
    workspaceFolderValue: vscode.ConfigurationTarget.WorkspaceFolder,
  }[scope];
  await vscode.workspace.getConfiguration(NEW_SECTION, folder?.uri).update(key, value, target);
}

async function migrateScopes(
  ctx: vscode.ExtensionContext,
  scopes: readonly SettingScope[],
  folder: vscode.WorkspaceFolder | undefined,
): Promise<string[]> {
  const config = vscode.workspace.getConfiguration(undefined, folder?.uri);
  const oldDir = path.join(path.dirname(ctx.globalStorageUri.fsPath), OLD_EXTENSION_ID);
  const done: string[] = [];
  for (const key of contributedKeys(ctx)) {
    const oldValues = config.inspect(`${OLD_SECTION}.${key}`) as Inspected | undefined;
    const newValues = config.inspect(`${NEW_SECTION}.${key}`) as Inspected | undefined;
    for (const { scope, value } of scopesToCopy(oldValues, newValues, scopes)) {
      await copySetting(key, scope, remapStoragePath(value, oldDir, ctx.globalStorageUri.fsPath), folder);
      done.push(`${key} (${scope.replace('Value', '')})`);
    }
  }
  return done;
}

/** Copies `sailfish.*` settings that `sardina.*` lacks, per scope, leaving the old values in place. */
async function migrateSettings(ctx: vscode.ExtensionContext, services: Services): Promise<void> {
  const done: string[] = [];
  if (!ctx.globalState.get<boolean>(GLOBAL_DONE_KEY)) {
    done.push(...(await migrateScopes(ctx, ['globalValue'], undefined)));
    await ctx.globalState.update(GLOBAL_DONE_KEY, true);
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && !ctx.workspaceState.get<boolean>(WORKSPACE_DONE_KEY)) {
    done.push(...(await migrateScopes(ctx, ['workspaceValue'], undefined)));
    // A single-folder workspace keeps its settings at workspace scope.
    if (vscode.workspace.workspaceFile) {
      for (const folder of folders) {
        done.push(...(await migrateScopes(ctx, ['workspaceFolderValue'], folder)));
      }
    }
    await ctx.workspaceState.update(WORKSPACE_DONE_KEY, true);
  }
  if (done.length > 0) {
    services.output.log('info', `Copied settings from ${OLD_SECTION}.* to ${NEW_SECTION}.*: ${done.join(', ')}.`);
  }
}

/** Fire-and-forget at activation: brings data of the extension's former id over, once. */
export async function migrateFromSailfish(ctx: vscode.ExtensionContext, services: Services): Promise<void> {
  try {
    migrateStorage(ctx, services);
    await migrateSettings(ctx, services);
  } catch (error) {
    services.output.log('warn', `Migration from the previous extension failed: ${String(error)}`);
  }
}
