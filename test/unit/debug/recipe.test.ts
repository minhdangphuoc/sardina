import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseDebugRecipe, shellWords } from '../../../src/debug/recipe';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const captured = (name: string) =>
  fs.readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'sfdk', 'captured', '3.13.5', name), 'utf8');

describe('sfdk debug --dry-run recipe', () => {
  it('splits shell words with quotes, escapes and line continuations', () => {
    assert.deepStrictEqual(shellWords(`gdb \\\n\t--x 'a b' "c d" e\\ f`), ['gdb', '--x', 'a b', 'c d', 'e f']);
    assert.deepStrictEqual(shellWords(`'set args '\\''it'\\''\\'\\'''\\''s a'\\'' b'`), [`set args 'it'\\''s a' b`]);
  });

  it('parses the real SDK 3.13.5 output for the phone', () => {
    const recipe = parseDebugRecipe(captured('debug_dry_run_args.stdout'));
    assert.ok(recipe);
    if (!recipe) return;
    assert.deepStrictEqual(recipe.gdbserver, ['gdbserver', '--multi', '--once', ':10000']);
    assert.ok(recipe.gdbPath.endsWith('/SailfishOS/bin/gdb'));
    assert.ok(recipe.initCommands.includes('target extended-remote tcp:192.168.2.16:10000'));
    assert.ok(recipe.initCommands.includes('set remote exec-file /usr/bin/harbour-vscsmoke'));
    assert.ok(recipe.initCommands.some((c) => c.startsWith('set sysroot ') && c.endsWith('SailfishOS-5.1.0.11-aarch64.default')));
    assert.ok(recipe.program?.endsWith('/harbour-vscsmoke/harbour-vscsmoke'));
    assert.strictEqual(recipe.initCommands[recipe.initCommands.length - 1], `set args 'it'\\''s a' b`);
  });

  it('rejects output without gdbserver or a target command', () => {
    assert.strictEqual(parseDebugRecipe(''), undefined);
    assert.strictEqual(parseDebugRecipe('Fatal: no device'), undefined);
    assert.strictEqual(parseDebugRecipe("gdbserver --once :1\n/gdb --init-eval-command 'file /x'"), undefined);
  });
});
