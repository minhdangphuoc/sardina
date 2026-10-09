import * as fs from 'node:fs';
import * as path from 'node:path';

export const OLD_SECTION = 'sailfish';
/** Extension id before the rename; its globalStorage folder sits next to ours. */
export const OLD_EXTENSION_ID = 'sailfish-tools-dev.sailfish-tools';
/** Storage subfolders worth keeping: pinned host keys, signing passphrases, keypad layouts. */
const STORAGE_FOLDERS = ['ssh', 'signing', 'keypads'];

export type SettingScope = 'globalValue' | 'workspaceValue' | 'workspaceFolderValue';

export interface Inspected {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** Scopes where the old setting is set and the new one is not. */
export function scopesToCopy(
  oldValues: Inspected | undefined,
  newValues: Inspected | undefined,
  scopes: readonly SettingScope[],
): Array<{ scope: SettingScope; value: unknown }> {
  return scopes
    .filter((scope) => oldValues?.[scope] !== undefined && newValues?.[scope] === undefined)
    .map((scope) => ({ scope, value: oldValues?.[scope] }));
}

/** Points a path into the old storage folder at the copied file, if the copy exists. */
export function remapStoragePath(value: unknown, oldDir: string, newDir: string): unknown {
  if (typeof value !== 'string' || !value.startsWith(oldDir + path.sep)) {
    return value;
  }
  const moved = path.join(newDir, value.slice(oldDir.length + 1));
  return fs.existsSync(moved) ? moved : value;
}

/** Copies the old storage folders that the new folder lacks; returns their names. */
export function copyOldStorage(oldDir: string, newDir: string): string[] {
  const copied: string[] = [];
  for (const name of STORAGE_FOLDERS) {
    const from = path.join(oldDir, name);
    const to = path.join(newDir, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.mkdirSync(newDir, { recursive: true });
      fs.cpSync(from, to, { recursive: true });
      copied.push(name);
    }
  }
  return copied;
}
