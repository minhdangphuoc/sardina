import * as assert from 'node:assert';
import { describe, it } from 'mocha';
import { buildRows, deviceRowState, type BuildViewInput } from '../../../src/build/buildViewCore';

const base: BuildViewInput = {
  projectName: 'RAWfish',
  proFile: 'RAWfish.pro',
  target: 'SailfishOS-4.6-aarch64',
  device: 'Jolla Phone',
  buildType: 'release',
  deployMethod: 'sdk',
  sign: false,
  snapshot: { phase: 'idle' },
  now: 0,
};

describe('buildRows', () => {
  it('has the seven rows with their click commands', () => {
    const rows = buildRows(base);
    assert.deepStrictEqual(
      rows.map((r) => [r.id, r.command]),
      [
        ['project', undefined],
        ['target', 'sailfish.selectTarget'],
        ['device', 'sailfish.device.setDefault'],
        ['type', 'sailfish.selectBuildType'],
        ['deploy', 'sailfish.selectDeployMethod'],
        ['signing', 'sailfish.setupSigning'],
        ['last', 'sailfish.showBuildLog'],
      ],
    );
    assert.strictEqual(rows[0].label, 'RAWfish');
    assert.strictEqual(rows[0].description, 'RAWfish.pro');
    assert.strictEqual(rows[1].description, 'SailfishOS-4.6-aarch64');
    assert.strictEqual(rows[3].description, 'Release');
    assert.strictEqual(rows[4].description, 'Deploy as RPM package');
    assert.strictEqual(rows[5].description, 'off');
    assert.strictEqual(rows[6].description, 'idle');
  });

  it('says what is missing', () => {
    const rows = buildRows({ ...base, target: '', device: '', proFile: undefined });
    assert.strictEqual(rows[1].description, 'not selected');
    assert.strictEqual(rows[2].description, 'not selected');
    assert.strictEqual(rows[0].description, '');
  });

  it('shows the device reachability from the registered map', () => {
    const online = buildRows({ ...base, registeredDevices: new Map([['Jolla Phone', 'online']]) });
    assert.strictEqual(online[2].description, 'Jolla Phone · ● connected');
    const offline = buildRows({ ...base, registeredDevices: new Map([['Jolla Phone', 'offline']]) });
    assert.strictEqual(offline[2].description, 'Jolla Phone · ○ offline');
    const gone = buildRows({ ...base, registeredDevices: new Map() });
    assert.strictEqual(gone[2].description, 'Jolla Phone · not registered');
    assert.strictEqual(gone[2].icon, 'warning');
    assert.strictEqual(buildRows(base)[2].description, 'Jolla Phone');
  });

  it('classifies the device state', () => {
    assert.strictEqual(deviceRowState('', undefined), 'none');
    assert.strictEqual(deviceRowState('x', undefined), 'unknown');
    assert.strictEqual(deviceRowState('x', new Map([['x', 'unknown']])), 'unknown');
  });

  it('shows signing on and the last build result', () => {
    const rows = buildRows({ ...base, sign: true, snapshot: { phase: 'running', startedAt: 0, stage: 'building' }, now: 5000 });
    assert.strictEqual(rows[5].description, 'on');
    assert.strictEqual(rows[6].description, '⟳ Building… 0:05 · building');
    assert.strictEqual(rows[6].icon, 'sync~spin');
  });
});
