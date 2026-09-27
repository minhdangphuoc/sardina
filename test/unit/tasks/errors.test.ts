import * as assert from 'assert';
import { mapBuildError, mapDeployError } from '../../../src/tasks/errors';

describe('errors.mapDeployError (M1.17)', () => {
  it('maps "No route to host" to Device unreachable + action', () => {
    const mapped = mapDeployError('ssh: connect to host 10.0.0.1 port 22: No route to host');
    assert.strictEqual(mapped?.message, 'Device unreachable');
    assert.strictEqual(mapped?.actionLabel, 'Open Devices view');
  });

  it('matches the fixture deploy-device-unreachable stderr text', () => {
    const mapped = mapDeployError('sfdk: unable to connect to device at 192.168.2.15:22: Connection timed out');
    assert.strictEqual(mapped?.message, 'Device unreachable');
  });

  it('matches the fixture deploy-no-rpm stderr text', () => {
    const mapped = mapDeployError("sfdk: no package found to deploy; run 'sfdk package' first");
    assert.strictEqual(mapped?.message, 'Build first');
  });

  it('maps SSH publickey failure without ever mentioning a password prompt', () => {
    const mapped = mapDeployError('Permission denied (publickey).');
    assert.ok(mapped?.message.includes('SSH authentication failed'));
    assert.ok(!/password/i.test(mapped?.message ?? ''));
  });

  it('maps "No RPM packages found" to Build first + action', () => {
    const mapped = mapDeployError('error: No RPM packages found in project directory');
    assert.strictEqual(mapped?.message, 'Build first');
    assert.strictEqual(mapped?.actionLabel, 'Build');
  });

  it('returns undefined for unrecognised stderr', () => {
    assert.strictEqual(mapDeployError('some other failure'), undefined);
  });
});

describe('errors.mapBuildError (M1.17)', () => {
  it('maps "No build target selected" with the raw text + Select target action', () => {
    const mapped = mapBuildError('No build target selected');
    assert.strictEqual(mapped?.message, 'No build target selected');
    assert.strictEqual(mapped?.actionLabel, 'Select target');
  });

  it('maps "No such target"', () => {
    const mapped = mapBuildError('error: No such target: bogus');
    assert.strictEqual(mapped?.actionLabel, 'Select target');
  });

  it('matches the fixture target-not-set stderr text', () => {
    const mapped = mapBuildError(
      "sfdk: no build target specified and no default target is set; run 'sfdk config target=<name>' or pass -c target=<name>",
    );
    assert.strictEqual(mapped?.actionLabel, 'Select target');
  });

  it('matches the fixture target-missing stderr text', () => {
    const mapped = mapBuildError(
      "sfdk: target 'SailfishOS-4.4.0.58-aarch64' not found; run 'sfdk tools target list' to see installed targets",
    );
    assert.strictEqual(mapped?.actionLabel, 'Select target');
  });

  it('returns undefined for unrecognised stderr', () => {
    assert.strictEqual(mapBuildError('compile error at line 1'), undefined);
  });
});
