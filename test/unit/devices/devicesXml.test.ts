import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bumpUserSettingsVersion,
  parseDevicesXml,
  serializeDevicesXml,
  writeDevicesXmlFile,
  readDevicesXmlFile,
  type DevicesXmlDocument,
} from '../../../src/devices/devicesXml';

// Compiled to out/test/unit/devices/*.js; fixtures live only under the repo's test/fixtures.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
/** The real file sfdk wrote on SDK 3.13.5: emulator (Device.0) + Jolla Phone (2026) (Device.1). */
const SAMPLE_XML = fs.readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'sfdk', 'captured', '3.13.5', 'libsfdk_devices.xml'), 'utf8');

describe('parseDevicesXml (FR-7.3)', () => {
  it('parses the real nested layout: an emulator and a hardware device with all known fields', () => {
    const doc = parseDevicesXml(SAMPLE_XML);
    assert.deepStrictEqual(doc.devices.map((d) => [d.index, d.name]), [[0, 'Sailfish OS Emulator 5.1.0.11'], [1, 'Jolla Phone 2026']]);
    const emulator = doc.devices[0];
    assert.strictEqual(emulator.autodetected, true);
    assert.strictEqual(emulator.machineType, 1);
    assert.strictEqual(emulator.architecture, 1);
    assert.deepStrictEqual(emulator.unknownKeys.EmulatorUri, { type: 'QString', raw: 'sfdkvm:VirtualBox#SailfishOS-5.1.0.11' });
    const phone = doc.devices[1];
    assert.strictEqual(phone.autodetected, false);
    assert.strictEqual(phone.machineType, 0);
    assert.strictEqual(phone.architecture, 0);
    assert.strictEqual(phone.wordWidth, 64);
    assert.strictEqual(phone.host, '192.168.2.16');
    assert.strictEqual(phone.port, 22);
    assert.strictEqual(phone.userName, 'defaultuser');
    assert.strictEqual(phone.authenticationType, 1);
    assert.ok(phone.privateKeyFile?.endsWith('/SailfishOS/vmshare/ssh/private_keys/jolla-phone-2026'));
    assert.match(phone.id, /^\{[0-9a-f-]{36}\}$/);
    assert.deepStrictEqual(phone.unknownKeys, {});
  });

  it('keeps Sfdk.UserSettings.Version as an opaque entry and drops Devices.Count', () => {
    const doc = parseDevicesXml(SAMPLE_XML);
    assert.deepStrictEqual(doc.otherEntries.map((e) => e.variable), ['Sfdk.UserSettings.Version']);
  });

  it('writes the real file back byte-identical apart from the "Written by" comment', () => {
    const roundTrip = serializeDevicesXml(parseDevicesXml(SAMPLE_XML), '2026-10-02T00:00:00.000Z');
    const strip = (xml: string) => xml.split('\n').filter((l) => !l.startsWith('<!--')).join('\n');
    assert.strictEqual(strip(roundTrip), strip(SAMPLE_XML));
  });

  it('returns an empty document (never throws) on garbage input', () => {
    const doc = parseDevicesXml('not xml at all');
    assert.deepStrictEqual(doc, { otherEntries: [], devices: [] });
  });

  it('unescapes XML entities in values', () => {
    const doc = parseDevicesXml(SAMPLE_XML.replace('>Jolla Phone 2026<', '>Jolla &amp; Co &lt;IV&gt;<'));
    assert.strictEqual(doc.devices[1].name, 'Jolla & Co <IV>');
  });

  it('bumps Sfdk.UserSettings.Version by one, as libsfdk does on every save', () => {
    const version = (doc: DevicesXmlDocument) => Number(/<value type="int">(\d+)</.exec(doc.otherEntries[0].xml)?.[1]);
    const doc = parseDevicesXml(SAMPLE_XML);
    assert.strictEqual(version(bumpUserSettingsVersion(doc)), version(doc) + 1);
    assert.deepStrictEqual(bumpUserSettingsVersion({ otherEntries: [], devices: [] }), { otherEntries: [], devices: [] });
  });

  it('never yields the old flat Device.N.Key layout as devices', () => {
    const flat = '<qtcreator><data><variable>Device.0.Name</variable><value type="QString">X</value></data></qtcreator>';
    assert.deepStrictEqual(parseDevicesXml(flat).devices, []);
  });
});

describe('serializeDevicesXml (FR-7.3/7.5)', () => {
  it('round-trips a parsed document back into an equivalent one', () => {
    const parsed = parseDevicesXml(SAMPLE_XML);
    const serialized = serializeDevicesXml(parsed, '2026-09-28T00:00:00.000Z');
    const reparsed = parseDevicesXml(serialized);
    assert.deepStrictEqual(reparsed, parsed);
  });

  it('emits Devices.Count matching the actual device count, and a settings version for a new file', () => {
    const doc: DevicesXmlDocument = { otherEntries: [], devices: [] };
    const serialized = serializeDevicesXml(doc, '2026-09-28T00:00:00.000Z');
    const reparsed = parseDevicesXml(serialized);
    assert.match(serialized, /<variable>Devices\.Count<\/variable>\s*<value type="int">0<\/value>/);
    assert.match(serialized, /<variable>Sfdk\.UserSettings\.Version<\/variable>\s*<value type="int">7<\/value>/);
    assert.strictEqual(reparsed.devices.length, 0);
  });

  it('renumbers devices contiguously as Device.0..n-1', () => {
    const doc = parseDevicesXml(SAMPLE_XML);
    doc.devices = [doc.devices[1]];
    const serialized = serializeDevicesXml(doc, '2026-09-28T00:00:00.000Z');
    assert.match(serialized, /<variable>Device\.0<\/variable>\s*<valuemap type="QVariantMap">[\s\S]*?Jolla Phone 2026/);
    assert.ok(!serialized.includes('<variable>Device.1</variable>'));
  });

  it('escapes XML-special characters in values', () => {
    const doc = parseDevicesXml(SAMPLE_XML);
    doc.devices[0].name = 'A & B <C> "D"';
    const serialized = serializeDevicesXml(doc, '2026-09-28T00:00:00.000Z');
    const reparsed = parseDevicesXml(serialized);
    assert.strictEqual(reparsed.devices[0].name, 'A & B <C> "D"');
  });

  it('is valid, parseable XML with the correct doctype and root', () => {
    const doc = parseDevicesXml(SAMPLE_XML);
    const serialized = serializeDevicesXml(doc, '2026-09-28T00:00:00.000Z');
    assert.match(serialized, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(serialized, /<!DOCTYPE QtCreatorSfdkDevices>/);
    assert.match(serialized, /<qtcreator>[\s\S]*<\/qtcreator>/);
  });
});

describe('writeDevicesXmlFile (FR-7.5: atomic write + backup)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-xml-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the file and its directory when neither exists yet, with no backup', () => {
    const filePath = path.join(tmpDir, 'libsfdk', 'devices.xml');
    const result = writeDevicesXmlFile(filePath, { otherEntries: [], devices: [] }, '2026-09-28T00-00-00.000Z');
    assert.strictEqual(result.backupPath, null);
    assert.ok(fs.existsSync(filePath));
  });

  it('backs up the previous file before overwriting, and the temp file never lingers', () => {
    const filePath = path.join(tmpDir, 'devices.xml');
    writeDevicesXmlFile(filePath, { otherEntries: [], devices: [] }, '2026-01-01T00-00-00.000Z');
    const result = writeDevicesXmlFile(filePath, parseDevicesXml(SAMPLE_XML), '2026-09-28T00-00-00.000Z');
    assert.ok(result.backupPath && fs.existsSync(result.backupPath));
    assert.ok(!fs.existsSync(`${filePath}.tmp`));
    const reread = readDevicesXmlFile(filePath);
    assert.strictEqual(reread.devices.length, 2);
  });

  it('keeps only the last 5 backups', () => {
    const filePath = path.join(tmpDir, 'devices.xml');
    for (let i = 0; i < 7; i++) {
      writeDevicesXmlFile(filePath, { otherEntries: [], devices: [] }, `2026-01-0${(i % 9) + 1}T00-00-0${i}.000Z`);
    }
    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.bak-'));
    assert.strictEqual(backups.length, 5);
  });
});

describe('readDevicesXmlFile', () => {
  it('returns an empty document (never throws) when the file does not exist', () => {
    const doc = readDevicesXmlFile('/nonexistent/path/devices.xml');
    assert.deepStrictEqual(doc, { otherEntries: [], devices: [] });
  });
});
