import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectDescriptor } from '../core/types';
import { cleanArgs } from './argv';
import { staleBuildType, type BuildType } from './buildConfig';

/**
 * `sfdk make -- clean` when the project's in-source qmake objects were compiled for the other build
 * type (Release objects are `-O2`, Debug ones `-O0`), so switching the type rebuilds them;
 * undefined when nothing needs cleaning or there is no qmake Makefile.
 */
export function buildTypeCleanArgv(project: ProjectDescriptor, nextType: BuildType): string[] | undefined {
  if (project.buildSystem !== 'qmake') return undefined;
  let makefile: string;
  try {
    makefile = fs.readFileSync(path.join(project.folder.uri.fsPath, 'Makefile'), 'utf8');
  } catch {
    return undefined; // not built yet
  }
  return staleBuildType(makefile, nextType) ? cleanArgs(true) : undefined;
}
