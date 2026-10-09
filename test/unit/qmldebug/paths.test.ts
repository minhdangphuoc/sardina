import * as assert from 'assert';
import { hasQmlDebugEnabler } from '../../../src/qmldebug/paths';

describe('hasQmlDebugEnabler', () => {
  it('is true for a positive match count', () => {
    assert.strictEqual(hasQmlDebugEnabler('1\n'), true);
    assert.strictEqual(hasQmlDebugEnabler(' 3 \r\n'), true);
  });

  it('is false for zero, empty or unexpected output', () => {
    for (const out of ['0\n', '', '\n', 'grep: /usr/bin/x: No such file or directory\n', '1\n0\n', '-1']) {
      assert.strictEqual(hasQmlDebugEnabler(out), false, JSON.stringify(out));
    }
  });
});
