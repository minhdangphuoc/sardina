import * as assert from 'assert';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { detectProjectAt, type DetectIO } from '../../../src/project/detectCore';

// Compiled to out/test/unit/project/*.js (tsc rootDir mirrors the source
// tree); fixtures are plain files under the repo, never compiled into out/.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WORKSPACES = path.join(REPO_ROOT, 'test', 'fixtures', 'workspaces');

/** Real-filesystem `DetectIO` (M1.6): mirrors what the vscode.workspace adapter in detect.ts does. */
function fsIO(): DetectIO {
  return {
    async findSpecFiles(folderPath: string): Promise<string[]> {
      const specDir = path.join(folderPath, 'rpm');
      let entries: string[];
      try {
        entries = await fsp.readdir(specDir);
      } catch {
        return [];
      }
      return entries
        .filter((e) => e.endsWith('.spec'))
        .slice(0, 10)
        .map((e) => path.join(specDir, e));
    },
    readFile: (specPath: string) => fsp.readFile(specPath, 'utf8'),
    hasCMakeLists: (folderPath: string) => Promise.resolve(fs.existsSync(path.join(folderPath, 'CMakeLists.txt'))),
    async hasProFile(folderPath: string): Promise<boolean> {
      let entries: string[];
      try {
        entries = await fsp.readdir(folderPath);
      } catch {
        return false;
      }
      return entries.some((e) => e.endsWith('.pro'));
    },
  };
}

describe('detectProjectAt (FR-2.2, M1.6)', () => {
  it('qml-app: detected via *.pro, buildSystem qmake, native binary', async () => {
    const project = await detectProjectAt(path.join(WORKSPACES, 'qml-app'), fsIO());
    assert.ok(project, 'expected qml-app to be detected as a Sailfish project');
    assert.strictEqual(project?.name, 'harbour-demo');
    assert.strictEqual(project?.buildSystem, 'qmake');
    assert.strictEqual(project?.hasNativeBinary, true);
    assert.strictEqual(project?.appBinaryPath, '/usr/bin/harbour-demo');
  });

  it('cmake-app: detected via CMakeLists.txt, buildSystem cmake', async () => {
    const project = await detectProjectAt(path.join(WORKSPACES, 'cmake-app'), fsIO());
    assert.ok(project);
    assert.strictEqual(project?.name, 'harbour-cmake-demo');
    assert.strictEqual(project?.buildSystem, 'cmake');
  });

  it('pure-qml-app: detected, isPureQml true, no native binary', async () => {
    const project = await detectProjectAt(path.join(WORKSPACES, 'pure-qml-app'), fsIO());
    assert.ok(project);
    assert.strictEqual(project?.isPureQml, true);
    assert.strictEqual(project?.hasNativeBinary, false);
  });

  it('not-sailfish: no rpm/*.spec -> undefined', async () => {
    const project = await detectProjectAt(path.join(WORKSPACES, 'not-sailfish'), fsIO());
    assert.strictEqual(project, undefined);
  });

  it('multi-root: each root folder detects independently', async () => {
    const qml = await detectProjectAt(path.join(WORKSPACES, 'qml-app'), fsIO());
    const cmake = await detectProjectAt(path.join(WORKSPACES, 'cmake-app'), fsIO());
    assert.ok(qml && cmake);
    assert.notStrictEqual(qml?.name, cmake?.name);
  });

  it('weird paths: unicode/space/dollar-sign folder names still detect', async () => {
    const folder = path.join(WORKSPACES, 'weird paths', "it's $weird café");
    const project = await detectProjectAt(folder, fsIO());
    assert.ok(project, 'expected the weird-paths fixture to be detected');
    assert.strictEqual(project?.name, 'harbour-weird');
  });

  /** In-memory io for the two FR-2.2 branches no on-disk fixture isolates. */
  function memoryIO(spec: string, opts: { hasCMakeLists: boolean; hasProFile: boolean }): DetectIO {
    return {
      findSpecFiles: () => Promise.resolve(['/mem/rpm/x.spec']),
      readFile: () => Promise.resolve(spec),
      hasCMakeLists: () => Promise.resolve(opts.hasCMakeLists),
      hasProFile: () => Promise.resolve(opts.hasProFile),
    };
  }

  it('a harbour-prefixed spec with neither *.pro nor CMakeLists.txt is still a project (FR-2.2 OR-branch)', async () => {
    const project = await detectProjectAt(
      '/mem',
      memoryIO('Name: harbour-no-build-file\n', { hasCMakeLists: false, hasProFile: false }),
    );
    assert.ok(project);
    assert.strictEqual(project?.name, 'harbour-no-build-file');
  });

  it('a non-harbour spec with neither *.pro nor CMakeLists.txt is NOT a project', async () => {
    const project = await detectProjectAt(
      '/mem',
      memoryIO('Name: some-other-app\n', { hasCMakeLists: false, hasProFile: false }),
    );
    assert.strictEqual(project, undefined);
  });
});
