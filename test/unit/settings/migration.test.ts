import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyOldStorage, remapStoragePath, scopesToCopy } from '../../../src/core/migrationCore';

const ALL = ['globalValue', 'workspaceValue', 'workspaceFolderValue'] as const;

describe('scopesToCopy', () => {
  it('copies a scope only where the old value is set and the new one is not', () => {
    const copied = scopesToCopy(
      { globalValue: 'a', workspaceValue: 'b', workspaceFolderValue: 'c' },
      { workspaceValue: 'kept' },
      ALL,
    );
    assert.deepStrictEqual(copied, [
      { scope: 'globalValue', value: 'a' },
      { scope: 'workspaceFolderValue', value: 'c' },
    ]);
  });

  it('keeps falsy old values and ignores scopes not asked for', () => {
    const copied = scopesToCopy({ globalValue: false, workspaceValue: 0 }, {}, ['globalValue']);
    assert.deepStrictEqual(copied, [{ scope: 'globalValue', value: false }]);
  });

  it('copies nothing when the old setting is unset', () => {
    assert.deepStrictEqual(scopesToCopy(undefined, undefined, ALL), []);
  });
});

describe('storage migration', () => {
  let tmp: string;
  let oldDir: string;
  let newDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sardina-migrate-'));
    oldDir = path.join(tmp, 'old');
    newDir = path.join(tmp, 'new');
    fs.mkdirSync(path.join(oldDir, 'ssh'), { recursive: true });
    fs.mkdirSync(path.join(oldDir, 'signing'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'ssh', 'known_hosts'), 'host key\n');
    fs.writeFileSync(path.join(oldDir, 'signing', 'k.pass'), 'secret\n', { mode: 0o600 });
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('copies the known folders and keeps file modes', () => {
    assert.deepStrictEqual(copyOldStorage(oldDir, newDir), ['ssh', 'signing']);
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'ssh', 'known_hosts'), 'utf8'), 'host key\n');
    assert.strictEqual(fs.statSync(path.join(newDir, 'signing', 'k.pass')).mode & 0o777, 0o600);
  });

  it('does not overwrite a folder the new storage already has', () => {
    fs.mkdirSync(path.join(newDir, 'ssh'), { recursive: true });
    fs.writeFileSync(path.join(newDir, 'ssh', 'known_hosts'), 'newer\n');
    assert.deepStrictEqual(copyOldStorage(oldDir, newDir), ['signing']);
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'ssh', 'known_hosts'), 'utf8'), 'newer\n');
  });

  it('does nothing when the old storage does not exist', () => {
    assert.deepStrictEqual(copyOldStorage(path.join(tmp, 'missing'), newDir), []);
    assert.strictEqual(fs.existsSync(newDir), false);
  });

  it('remaps a path into the old storage only when the copy exists', () => {
    const oldFile = path.join(oldDir, 'signing', 'k.pass');
    assert.strictEqual(remapStoragePath(oldFile, oldDir, newDir), oldFile);
    copyOldStorage(oldDir, newDir);
    assert.strictEqual(remapStoragePath(oldFile, oldDir, newDir), path.join(newDir, 'signing', 'k.pass'));
    assert.strictEqual(remapStoragePath('/elsewhere/k.pass', oldDir, newDir), '/elsewhere/k.pass');
    assert.strictEqual(remapStoragePath(7, oldDir, newDir), 7);
  });
});
