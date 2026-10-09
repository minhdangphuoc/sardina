import { type ModuleRef, parseVersion } from './types';

export interface QmlDirEntry {
  name: string;
  /** -1 for `internal` entries, which carry no version. */
  major: number;
  minor: number;
  file: string;
  singleton: boolean;
  internal: boolean;
}

export interface QmlDir {
  module?: string;
  plugins: string[];
  typeinfo: string[];
  depends: ModuleRef[];
  entries: QmlDirEntry[];
}

function entry(words: string[], singleton: boolean): QmlDirEntry | undefined {
  const [name, version, file] = words;
  if (!name || !version || !file) return undefined;
  return { name, ...parseVersion(version), file, singleton, internal: false };
}

/** Parses a `qmldir` file. Never throws; unknown or malformed lines are skipped. */
export function parseQmldir(text: string): QmlDir {
  const dir: QmlDir = { plugins: [], typeinfo: [], depends: [], entries: [] };
  try {
    for (const raw of text.split(/\r?\n/)) {
      const words = raw.replace(/#.*/, '').trim().split(/\s+/);
      const [keyword, ...args] = words;
      if (!keyword) continue;
      if (keyword === 'module' && args[0]) dir.module = args[0];
      else if (keyword === 'plugin' && args[0]) dir.plugins.push(args[0]);
      else if (keyword === 'typeinfo' && args[0]) dir.typeinfo.push(args[0]);
      else if (keyword === 'depends' && args[0]) dir.depends.push({ module: args[0], ...parseVersion(args[1]) });
      else if (keyword === 'internal' && args[0] && args[1]) {
        dir.entries.push({ name: args[0], major: -1, minor: -1, file: args[1], singleton: false, internal: true });
      } else if (keyword === 'singleton') pushEntry(dir, entry(args, true));
      else if (/^[A-Za-z_]\w*$/.test(keyword) && /^\d/.test(args[0] ?? '')) pushEntry(dir, entry(words, false));
    }
  } catch {
    // Keep whatever was parsed so far.
  }
  return dir;
}

function pushEntry(dir: QmlDir, e: QmlDirEntry | undefined): void {
  if (e) dir.entries.push(e);
}
