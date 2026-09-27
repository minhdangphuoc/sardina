import * as assert from 'assert';
import { checkProjectName } from '../../../src/wizard/validation';

describe('checkProjectName (FR-3.1 step 3)', () => {
  it('accepts a well-formed harbour- name with no warning', () => {
    const result = checkProjectName('harbour-demo');
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.warning, undefined);
    }
  });

  it('rejects names not matching ^[a-z][a-z0-9-]*$', () => {
    for (const bad of ['Harbour-Demo', '1demo', '', '-demo', 'demo_app', 'demo app', 'demo!', '--force']) {
      const result = checkProjectName(bad);
      assert.strictEqual(result.ok, false, `expected a blocking error for ${JSON.stringify(bad)}`);
    }
  });

  it('accepts a valid name missing "harbour-" but returns a non-blocking warning', () => {
    const result = checkProjectName('myapp');
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.ok(result.warning && result.warning.length > 0);
    }
  });

  it('R25: option-like and shell-metacharacter names are all rejected, never accepted as-is', () => {
    const corpus = ['; rm -rf /', '$(id)', '`id`', '"quoted"', "'quoted'", '--malicious-flag', '-', 'a\nb', '日本語'];
    for (const name of corpus) {
      const result = checkProjectName(name);
      assert.strictEqual(result.ok, false, `expected corpus entry ${JSON.stringify(name)} to be rejected`);
    }
  });

  it('never throws on adversarial input', () => {
    for (const input of ['a'.repeat(100000), '\0\0\0', '日本語 café\n\r']) {
      assert.doesNotThrow(() => checkProjectName(input));
    }
  });
});
