import * as assert from 'assert';
import { shouldProbe, splitBySession, UNFOCUSED_LIMIT_MS } from '../../../src/devices/probeScheduleCore';

describe('reachability probe schedule', () => {
  const now = 1_000_000;
  it('never probes while the Devices view is hidden', () => {
    assert.strictEqual(shouldProbe({ viewVisible: false, unfocusedSince: undefined, now }), false);
  });
  it('probes while visible and focused', () => {
    assert.strictEqual(shouldProbe({ viewVisible: true, unfocusedSince: undefined, now }), true);
  });
  it('keeps probing for 5 minutes after focus is lost, then stops', () => {
    assert.strictEqual(shouldProbe({ viewVisible: true, unfocusedSince: now - UNFOCUSED_LIMIT_MS, now }), true);
    assert.strictEqual(shouldProbe({ viewVisible: true, unfocusedSince: now - UNFOCUSED_LIMIT_MS - 1, now }), false);
  });
  it('skips endpoints with a session and reports them online', () => {
    const r = splitBySession([
      { key: 'a:22', hasSession: true },
      { key: 'b:22', hasSession: false },
      { key: 'a:22', hasSession: false },
    ]);
    assert.deepStrictEqual(r, { probe: ['b:22'], online: ['a:22'] });
  });
});
