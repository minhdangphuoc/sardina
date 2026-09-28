import * as assert from 'assert';
import { buildNewDeviceEntry, removeDeviceByIndex, sanitizeForFilename } from '../../../src/devices/deviceWizard';
import type { DevicesXmlDocument, DeviceEntry } from '../../../src/devices/devicesXml';
import { ARCHITECTURE, AUTHENTICATION_TYPE, HOST_KEY_CHECKING, MACHINE_TYPE } from '../../../src/devices/devicesXmlConstants';

const EMPTY: DevicesXmlDocument = { otherEntries: [], devices: [] };

function device(overrides: Partial<DeviceEntry> = {}): DeviceEntry {
  return {
    index: 0,
    id: '{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}',
    name: 'existing',
    autodetected: false,
    architecture: 0,
    wordWidth: 32,
    machineType: 0,
    unknownKeys: {},
    ...overrides,
  };
}

describe('buildNewDeviceEntry (FR-7.1/7.5)', () => {
  it('builds a hardware device with the specific-key auth type and correct defaults', () => {
    const entry = buildNewDeviceEntry(
      { name: 'Xperia 10 IV', host: '192.168.2.15', port: 22, user: 'defaultuser', architecture: 'armv7hl', privateKeyFile: '/k' },
      EMPTY,
    );
    assert.strictEqual(entry.index, 0);
    assert.strictEqual(entry.name, 'Xperia 10 IV');
    assert.strictEqual(entry.autodetected, false);
    assert.strictEqual(entry.machineType, MACHINE_TYPE.hardware);
    assert.strictEqual(entry.architecture, ARCHITECTURE.arm);
    assert.strictEqual(entry.wordWidth, 32);
    assert.strictEqual(entry.authenticationType, AUTHENTICATION_TYPE.specificKey);
    assert.strictEqual(entry.hostKeyChecking, HOST_KEY_CHECKING.allowNoMatch);
    assert.strictEqual(entry.timeout, 0);
    assert.strictEqual(entry.privateKeyFile, '/k');
    assert.match(entry.freePorts!, /^\d+-\d+$/);
  });

  it('defaults to braced UUID style when the document has no existing devices', () => {
    const entry = buildNewDeviceEntry(
      { name: 'x', host: 'h', port: 22, user: 'u', architecture: 'aarch64', privateKeyFile: '/k' },
      EMPTY,
    );
    assert.match(entry.id, /^\{[0-9a-f-]{36}\}$/);
  });

  it('follows the existing plain-UUID style when every existing device uses it', () => {
    const doc: DevicesXmlDocument = { otherEntries: [], devices: [device({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })] };
    const entry = buildNewDeviceEntry({ name: 'x', host: 'h', port: 22, user: 'u', architecture: 'i486', privateKeyFile: '/k' }, doc);
    assert.match(entry.id, /^[0-9a-f-]{36}$/);
    assert.ok(!entry.id.startsWith('{'));
  });

  it('assigns the next contiguous index after existing devices', () => {
    const doc: DevicesXmlDocument = { otherEntries: [], devices: [device({ index: 0 }), device({ index: 1 })] };
    const entry = buildNewDeviceEntry({ name: 'x', host: 'h', port: 22, user: 'u', architecture: 'armv7hl', privateKeyFile: '/k' }, doc);
    assert.strictEqual(entry.index, 2);
  });
});

describe('removeDeviceByIndex (FR-7.9)', () => {
  it('removes the target device and renumbers the rest contiguously', () => {
    const doc: DevicesXmlDocument = {
      otherEntries: [],
      devices: [device({ index: 0, name: 'a' }), device({ index: 1, name: 'b' }), device({ index: 2, name: 'c' })],
    };
    const result = removeDeviceByIndex(doc, 1);
    assert.strictEqual(result.devices.length, 2);
    assert.deepStrictEqual(
      result.devices.map((d) => [d.index, d.name]),
      [
        [0, 'a'],
        [1, 'c'],
      ],
    );
  });

  it('is a no-op shape (still renumbers) when the index is not found', () => {
    const doc: DevicesXmlDocument = { otherEntries: [], devices: [device({ index: 0 }), device({ index: 1 })] };
    const result = removeDeviceByIndex(doc, 5);
    assert.strictEqual(result.devices.length, 2);
  });
});

describe('sanitizeForFilename (FR-7.8)', () => {
  it('keeps safe characters and collapses everything else to a single dash', () => {
    assert.strictEqual(sanitizeForFilename('Xperia 10 IV'), 'Xperia-10-IV');
  });

  it('strips leading/trailing dashes produced by sanitization', () => {
    assert.strictEqual(sanitizeForFilename('  weird!!name??  '), 'weird-name');
  });

  it('never returns an empty string', () => {
    assert.strictEqual(sanitizeForFilename('!!!'), 'device');
    assert.strictEqual(sanitizeForFilename(''), 'device');
  });

  it('rejects shell-metacharacter/injection-corpus input into a safe filename', () => {
    const corpus = ['; rm -rf /', '$(id)', '`id`', '../../etc/passwd', 'a/b\\c'];
    for (const name of corpus) {
      const safe = sanitizeForFilename(name);
      assert.doesNotMatch(safe, /[;$`/\\]/);
    }
  });
});
