import * as assert from 'assert';
import { getLastTargetList, resetLastTargetListForTests, setLastTargetList } from '../../../src/targets/targetListCache';
import type { TargetDescriptor } from '../../../src/core/types';

function target(name: string): TargetDescriptor {
  return { name, tooling: '', arch: 'unknown', flags: [], isSnapshot: false, isDefault: false };
}

describe('targetListCache', () => {
  afterEach(() => resetLastTargetListForTests());

  it('starts undefined (never fetched)', () => {
    assert.strictEqual(getLastTargetList(), undefined);
  });

  it('reflects the most recent setLastTargetList call', () => {
    setLastTargetList([target('a')]);
    setLastTargetList([target('a'), target('b')]);
    assert.strictEqual(getLastTargetList()?.length, 2);
  });
});
