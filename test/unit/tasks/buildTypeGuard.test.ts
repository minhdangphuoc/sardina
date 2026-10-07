import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProjectDescriptor } from '../../../src/core/types';
import { DEBUG_GLOBAL_CFLAGS } from '../../../src/tasks/argv';
import { buildTypeCleanArgv } from '../../../src/tasks/buildTypeGuard';

describe('buildTypeGuard.buildTypeCleanArgv', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-buildtype-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const project = (buildSystem: ProjectDescriptor['buildSystem']): ProjectDescriptor =>
    ({ folder: { uri: { fsPath: dir } }, buildSystem }) as unknown as ProjectDescriptor;
  const writeMakefile = (flags: string): void =>
    fs.writeFileSync(path.join(dir, 'Makefile'), `CXXFLAGS      = -pipe ${flags} -m32 -fPIC $(DEFINES)\n`);

  it('cleans with make when a qmake build switches type', () => {
    writeMakefile('-O2 -g -pipe -Wall -Wp,-D_FORTIFY_SOURCE=2 -fexceptions');
    assert.deepStrictEqual(buildTypeCleanArgv(project('qmake'), 'debug'), ['make', '--', 'clean']);
    assert.strictEqual(buildTypeCleanArgv(project('qmake'), 'release'), undefined);
    writeMakefile(DEBUG_GLOBAL_CFLAGS);
    assert.deepStrictEqual(buildTypeCleanArgv(project('qmake'), 'release'), ['make', '--', 'clean']);
    assert.strictEqual(buildTypeCleanArgv(project('qmake'), 'debug'), undefined);
  });

  it('does nothing before the first build or for other build systems', () => {
    assert.strictEqual(buildTypeCleanArgv(project('qmake'), 'debug'), undefined);
    writeMakefile('-O2 -g -pipe -Wall -Wp,-D_FORTIFY_SOURCE=2');
    assert.strictEqual(buildTypeCleanArgv(project('cmake'), 'debug'), undefined, 'CMake rebuilds on changed flags itself');
    assert.strictEqual(buildTypeCleanArgv(project('unknown'), 'debug'), undefined);
  });
});
