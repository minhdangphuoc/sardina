import * as assert from 'assert';
import { architectureFields, ARCHITECTURE } from '../../../src/devices/devicesXmlConstants';

describe('architectureFields (FR-7.4, cited from src/libs/sfdk/device.h)', () => {
  it('armv7hl is Arm/32', () => {
    assert.deepStrictEqual(architectureFields('armv7hl'), { architecture: ARCHITECTURE.arm, wordWidth: 32 });
  });

  it('aarch64 is Arm/64 (same Architecture enum value as armv7hl; WordWidth is what differs)', () => {
    assert.deepStrictEqual(architectureFields('aarch64'), { architecture: ARCHITECTURE.arm, wordWidth: 64 });
  });

  it('i486 is X86/32', () => {
    assert.deepStrictEqual(architectureFields('i486'), { architecture: ARCHITECTURE.x86, wordWidth: 32 });
  });
});
