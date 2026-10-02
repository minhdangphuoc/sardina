import { execFile } from 'node:child_process';

function pgrep(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pgrep', args, (error) => resolve(!error)); // pgrep exits 1 (an "error" to execFile) when nothing matches
  });
}

/**
 * FR-7.6: a running Qt Creator keeps its own in-memory device list and rewrites devices.xml from it,
 * which silently drops devices added by anyone else (observed with SDK 3.13.5), so callers refuse.
 */
export function qtCreatorRunning(): Promise<boolean> {
  return pgrep(['-x', 'qtcreator']);
}

/** FR-7.6: a long-lived sfdk (e.g. a running app's `device exec`) is only worth a warning. */
export function sfdkRunning(): Promise<boolean> {
  return pgrep(['-f', 'bin/sfdk']);
}
