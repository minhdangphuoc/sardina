import * as assert from 'assert';
import { execSync } from 'node:child_process';
import { shQuote } from '../../../src/devices/shQuote';

describe('shQuote (FR-7.8 key-push terminal command)', () => {
  it('wraps a plain value in single quotes', () => {
    assert.strictEqual(shQuote('hello'), "'hello'");
  });

  it('escapes an embedded single quote the standard POSIX way', () => {
    assert.strictEqual(shQuote("it's"), "'it'\\''s'");
  });

  it('round-trips a shell-metacharacter injection corpus through a real shell unchanged', () => {
    const corpus = ['; rm -rf /', '$(id)', '`id`', '"quoted"', "'; echo pwned; '", 'a && b', 'a | b', '$HOME', 'a\nb'];
    for (const value of corpus) {
      const out = execSync(`printf '%s' ${shQuote(value)}`, { encoding: 'utf8' });
      assert.strictEqual(out, value, `value survived verbatim through a real shell: ${JSON.stringify(value)}`);
    }
  });
});
