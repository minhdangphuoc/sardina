import * as fs from 'node:fs/promises';
import type { IndexIO } from './typeIndex';

const orUndefined = async <T>(read: () => Promise<T>): Promise<T | undefined> => read().catch(() => undefined);

export const fsIndexIO: IndexIO = {
  readFile: (file) => orUndefined(() => fs.readFile(file, 'utf8')),
  readdir: (dir) => orUndefined(() => fs.readdir(dir)),
  async stat(file) {
    const s = await orUndefined(() => fs.stat(file));
    return s && { mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
  },
};
