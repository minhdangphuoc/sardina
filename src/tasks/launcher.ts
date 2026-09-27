import type { ProjectDescriptor } from '../core/types';
import type { SailfishSettings } from '../settings/index';
import { isValidAppName } from './argv';

export type LauncherMode = SailfishSettings['run.launcher'];

export interface LauncherSettings {
  mode: LauncherMode;
  customCommand: string;
}

/**
 * Quote-aware, shell-free tokenizer for `sailfish.run.customCommand`
 * (NFR-20: never passed through a shell). Splits on whitespace, honouring
 * single and double quotes (no escape handling beyond that — deliberately
 * simple).
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let inToken = false;

  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * FR-5.5: resolves the remote launch argv (before `device exec --`).
 * `auto` picks invoker-silica when the project has a native binary (FR-2.4),
 * else sailfish-qml.
 */
export function chooseLauncher(project: ProjectDescriptor, settings: LauncherSettings): string[] {
  if (!isValidAppName(project.name)) {
    throw new Error(`invalid application name for launch: ${project.name}`);
  }

  switch (settings.mode) {
    case 'invoker-silica':
      return ['invoker', '--type=silica-qt5', project.appBinaryPath];
    case 'sailfish-qml':
      return ['sailfish-qml', project.name];
    case 'custom': {
      const resolved = settings.customCommand.split('${appName}').join(project.name);
      return tokenize(resolved);
    }
    case 'auto':
    default:
      return project.hasNativeBinary
        ? ['invoker', '--type=silica-qt5', project.appBinaryPath]
        : ['sailfish-qml', project.name];
  }
}
