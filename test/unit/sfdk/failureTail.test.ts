import * as assert from 'assert';
import { failureTail } from '../../../src/sfdk/failureTail';

describe('failureTail', () => {
  it('keeps the last 15 non-empty lines, e.g. the real rsync deploy failure', () => {
    const real = 'bash: rsync: not found\nrsync: connection unexpectedly closed (0 bytes received so far) [sender]\n\n';
    assert.strictEqual(failureTail(real), 'bash: rsync: not found\nrsync: connection unexpectedly closed (0 bytes received so far) [sender]');
    const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    assert.strictEqual(failureTail(many)?.split('\n')[0], 'line 5');
  });

  it('is undefined for empty output, so the caller can fall back to stdout', () => {
    assert.strictEqual(failureTail(''), undefined);
    assert.strictEqual(failureTail('\n  \n'), undefined);
    assert.strictEqual(failureTail(undefined), undefined);
  });
});
