import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  abbreviateHome,
  engineItemState,
  sdkRootState,
  sdkSourceLabel,
  targetItemState,
  visibleTargets,
} from '../../../src/devices/sdkTreeCore';
import { parseEngineStatus } from '../../../src/sfdk/parsers/engineStatus';
import { parseTargetList } from '../../../src/targets/parseTargetList';

const fixtures = path.join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'sfdk');
const read = (...p: string[]): string => fs.readFileSync(path.join(fixtures, ...p), 'utf8');

describe('sdkTreeCore', () => {
  it('sdkRootState: missing, known and unknown version', () => {
    const missing = sdkRootState(undefined);
    assert.strictEqual(missing.description, 'not found');
    assert.strictEqual(missing.contextValue, 'devices-root-sdk.missing');

    const info = { version: '3.13.5', source: 'env' as const, root: '/sdk', sfdkPath: '/sdk/bin/sfdk' };
    const found = sdkRootState(info);
    assert.strictEqual(found.description, '3.13.5 · /sdk');
    assert.strictEqual(found.contextValue, 'devices-root-sdk');
    assert.ok(found.tooltip.includes('SAILFISH_SDK_ROOT'));
    assert.strictEqual(sdkRootState({ ...info, version: 'unknown' }).description, 'version unknown · /sdk');
  });

  it('sdkSourceLabel covers every source', () => {
    assert.strictEqual(sdkSourceLabel('setting'), 'sardina.sdkPath setting');
    assert.strictEqual(sdkSourceLabel('env'), 'SAILFISH_SDK_ROOT');
    assert.strictEqual(sdkSourceLabel('home'), '~/SailfishOS');
    assert.strictEqual(sdkSourceLabel('path'), 'PATH');
  });

  it('abbreviateHome respects the path boundary', () => {
    assert.strictEqual(abbreviateHome('/home/u/SailfishOS', '/home/u'), '~/SailfishOS');
    assert.strictEqual(abbreviateHome('/opt/sdk', '/home/u'), '/opt/sdk');
    assert.strictEqual(abbreviateHome('/home/user2/x', '/home/user'), '/home/user2/x');
  });

  it('engineItemState from real parser fixtures and failures', () => {
    const running = engineItemState(parseEngineStatus(read('parsers', 'engine-status', 'running.txt')) as never);
    assert.strictEqual(running.description, '● running');
    assert.strictEqual(running.contextValue, 'sdk-engine.running');
    const stopped = engineItemState(parseEngineStatus(read('parsers', 'engine-status', 'stopped.txt')) as never);
    assert.strictEqual(stopped.description, '○ stopped');
    assert.strictEqual(stopped.contextValue, 'sdk-engine.stopped');
    const failed = engineItemState({ ok: false, detail: 'boom' });
    assert.strictEqual(failed.description, 'unknown');
    assert.strictEqual(failed.contextValue, 'sdk-engine');
    assert.ok(failed.tooltip.includes('boom'));
  });

  it('targetItemState marks only the configured target', () => {
    const parsed = parseTargetList(read('parsers', 'target-list', 'well-formed.txt'));
    assert.ok(parsed.ok);
    const [first, second] = parsed.value;
    assert.strictEqual(targetItemState(first, undefined).description, '');
    assert.strictEqual(targetItemState(first, first.name).description, '✓ selected');
    assert.ok(!targetItemState(second, first.name).description.includes('selected'));
    assert.ok(targetItemState(first, undefined).tooltip.includes('arch: aarch64'));
  });

  it('visibleTargets drops snapshots unless enabled', () => {
    const parsed = parseTargetList(read('scenarios', 'targets-with-snapshot', 'tools_target_list.stdout'));
    assert.ok(parsed.ok);
    const all = parsed.value;
    assert.ok(all.some((t) => t.isSnapshot));
    assert.ok(visibleTargets(all, false).every((t) => !t.isSnapshot));
    assert.strictEqual(visibleTargets(all, true).length, all.length);
  });
});
