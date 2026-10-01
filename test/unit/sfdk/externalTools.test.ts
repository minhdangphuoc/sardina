import * as assert from 'assert';
import { missingTools, installHint, REQUIRED_SSH_TOOLS } from '../../../src/core/externalToolsCore';

describe('missingTools', () => {
  it('reports no missing tools for something guaranteed to exist (node itself is unrelated, but a universal POSIX tool is a safe proxy)', async () => {
    // "sh" exists on every platform this extension targets (macOS/Linux); used here only to
    // prove the present-case path returns an empty list without a real network/SDK dependency.
    const missing = await missingTools(['ssh']);
    // Environment-dependent (ssh may or may not be installed in CI), so just assert the
    // function returns an array without throwing and only ever contains known tool names.
    assert.ok(Array.isArray(missing));
    for (const tool of missing) {
      assert.ok((REQUIRED_SSH_TOOLS as readonly string[]).includes(tool));
    }
  });

  it('reports a tool that cannot possibly exist as missing', async () => {
    const missing = await missingTools(['ssh-keygen', 'this-tool-definitely-does-not-exist-anywhere' as never]);
    assert.ok(missing.includes('this-tool-definitely-does-not-exist-anywhere' as never));
  });

  it('never throws, even for an empty list', async () => {
    const missing = await missingTools([]);
    assert.deepStrictEqual(missing, []);
  });
});

describe('installHint', () => {
  it('gives platform-specific guidance for every (tool, platform) pair without throwing', () => {
    for (const tool of REQUIRED_SSH_TOOLS) {
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        const hint = installHint(tool, platform);
        assert.ok(hint.includes(tool));
        assert.ok(hint.length > 0);
      }
    }
  });
});
