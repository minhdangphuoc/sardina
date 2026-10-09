import * as assert from 'assert';
import * as path from 'path';
import { importRootFor, moduleDirCandidates } from '../../../src/qml/importRoot';

describe('qml/importRoot', () => {
  const target = path.join('/sdk', 'mersdk', 'targets', 'T');
  const lib64 = path.join(target, 'usr', 'lib64', 'qt5', 'qml');
  const lib = path.join(target, 'usr', 'lib', 'qt5', 'qml');

  it('prefers lib64, falls back to lib, else undefined', () => {
    assert.strictEqual(importRootFor('/sdk', 'T', () => true), lib64);
    assert.strictEqual(importRootFor('/sdk', 'T', (d) => d === lib), lib);
    assert.strictEqual(importRootFor('/sdk', 'T', () => false), undefined);
  });

  it('lists versioned module directories in Qt order', () => {
    assert.deepStrictEqual(moduleDirCandidates('/r', 'QtQuick', 2, 6), ['/r/QtQuick.2.6', '/r/QtQuick.2', '/r/QtQuick']);
    assert.deepStrictEqual(moduleDirCandidates('/r', 'Sailfish.Silica', 1, 0), [
      '/r/Sailfish/Silica.1.0',
      '/r/Sailfish/Silica.1',
      '/r/Sailfish/Silica',
    ]);
    assert.deepStrictEqual(moduleDirCandidates('/r', 'A.B', -1, -1), ['/r/A/B']);
  });
});
