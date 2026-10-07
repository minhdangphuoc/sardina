import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInside, type CleanFs, type CleanPlan, type EntryKind } from './cleanCore';

/** Node fs for the clean scan: `lstat`, so a symlink is reported as such and never followed. */
export const nodeCleanFs: CleanFs = {
  list(dir: string): string[] {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
  kind(p: string): EntryKind {
    try {
      const st = fs.lstatSync(p);
      return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'none';
    } catch {
      return 'none';
    }
  },
  readHead(file: string, bytes: number): string {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString('utf8');
    } catch {
      return '';
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  },
};

export interface CleanResult {
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}

/** Deletes the plan's entries; refuses any path that is not inside `root` or that has become a symlink. */
export function applyCleanPlan(root: string, plan: CleanPlan, onDeleted?: (rel: string) => void): CleanResult {
  const resolvedRoot = path.resolve(root);
  const result: CleanResult = { deleted: [], failed: [] };
  for (const entry of plan.entries) {
    const abs = path.resolve(resolvedRoot, entry.path);
    if (abs === resolvedRoot || !isInside(resolvedRoot, abs) || entry.path.split('/')[0] === '.git') {
      result.failed.push({ path: entry.path, error: 'outside the project folder' });
      continue;
    }
    try {
      if (nodeCleanFs.kind(abs) === 'symlink') throw new Error('is a symlink');
      fs.rmSync(abs, { recursive: entry.kind === 'dir', force: true });
      result.deleted.push(entry.path);
      onDeleted?.(entry.path);
    } catch (err) {
      result.failed.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
