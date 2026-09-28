import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDevicesXml, serializeDevicesXml, writeDevicesXmlFile, readDevicesXmlFile, type DevicesXmlDocument } from '../../../src/devices/devicesXml';

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE QtCreatorSfdkDevices>
<!-- Written by Qt Creator 4.15.1, 2026-01-01T00:00:00. -->
<qtcreator>
    <data>
        <variable>Version</variable>
        <value type="int">1</value>
    </data>
    <data>
        <variable>Devices.Count</variable>
        <value type="int">1</value>
    </data>
    <data>
        <variable>Device.0.Id</variable>
        <value type="QString">{11111111-1111-1111-1111-111111111111}</value>
    </data>
    <data>
        <variable>Device.0.Name</variable>
        <value type="QString">Xperia 10 IV</value>
    </data>
    <data>
        <variable>Device.0.Autodetected</variable>
        <value type="bool">false</value>
    </data>
    <data>
        <variable>Device.0.Architecture</variable>
        <value type="int">0</value>
    </data>
    <data>
        <variable>Device.0.WordWidth</variable>
        <value type="int">64</value>
    </data>
    <data>
        <variable>Device.0.MachineType</variable>
        <value type="int">0</value>
    </data>
    <data>
        <variable>Device.0.Host</variable>
        <value type="QString">192.168.2.15</value>
    </data>
    <data>
        <variable>Device.0.Port</variable>
        <value type="int">22</value>
    </data>
    <data>
        <variable>Device.0.UserName</variable>
        <value type="QString">defaultuser</value>
    </data>
    <data>
        <variable>Device.0.AuthenticationType</variable>
        <value type="int">1</value>
    </data>
    <data>
        <variable>Device.0.PrivateKeyFile</variable>
        <value type="QString">/Users/mersdk/.ssh/sdk_hw</value>
    </data>
    <data>
        <variable>Device.0.Timeout</variable>
        <value type="int">0</value>
    </data>
    <data>
        <variable>Device.0.HostKeyChecking</variable>
        <value type="int">2</value>
    </data>
    <data>
        <variable>Device.0.FreePorts</variable>
        <value type="QString">10000-10009</value>
    </data>
    <data>
        <variable>Device.0.QmlLivePorts</variable>
        <value type="QString">10234-10243</value>
    </data>
    <data>
        <variable>DeviceModel.0.Name</variable>
        <value type="QString">Xperia 10 IV</value>
    </data>
</qtcreator>
`;

describe('parseDevicesXml (FR-7.3)', () => {
  it('parses a real-shaped file into a device with all known fields', () => {
    const doc = parseDevicesXml(SAMPLE_XML);
    assert.strictEqual(doc.devices.length, 1);
    const d = doc.devices[0];
    assert.strictEqual(d.id, '{11111111-1111-1111-1111-111111111111}');
    assert.strictEqual(d.name, 'Xperia 10 IV');
    assert.strictEqual(d.autodetected, false);
    assert.strictEqual(d.architecture, 0);
    assert.strictEqual(d.wordWidth, 64);
    assert.strictEqual(d.machineType, 0);
    assert.strictEqual(d.host, '192.168.2.15');
    assert.strictEqual(d.port, 22);
    assert.strictEqual(d.userName, 'defaultuser');
    assert.strictEqual(d.authenticationType, 1);
    assert.strictEqual(d.privateKeyFile, '/Users/mersdk/.ssh/sdk_hw');
    assert.strictEqual(d.timeout, 0);
    assert.strictEqual(d.hostKeyChecking, 2);
    assert.strictEqual(d.freePorts, '10000-10009');
    assert.strictEqual(d.qmlLivePorts, '10234-10243');
  });

  it('preserves Version and DeviceModel.* as opaque otherEntries, in order, and drops Devices.Count', () => {
    const doc = parseDevicesXml(SAMPLE_XML);
    const variables = doc.otherEntries.map((e) => e.variable);
    assert.deepStrictEqual(variables, ['Version', 'DeviceModel.0.Name']);
    assert.strictEqual(doc.otherEntries[0].type, 'int');
    assert.strictEqual(doc.otherEntries[0].raw, '1');
  });

  it('an unknown Device.<N>.* field is preserved verbatim, not dropped', () => {
    const xml = SAMPLE_XML.replace(
      '<data>\n        <variable>Device.0.QmlLivePorts</variable>',
      '<data>\n        <variable>Device.0.SomeFutureKey</variable>\n        <value type="QString">mystery</value>\n    </data>\n    <data>\n        <variable>Device.0.QmlLivePorts</variable>',
    );
    const doc = parseDevicesXml(xml);
    assert.deepStrictEqual(doc.devices[0].unknownKeys.SomeFutureKey, { type: 'QString', raw: 'mystery' });
  });

  it('returns an empty document (never throws) on garbage input', () => {
    const doc = parseDevicesXml('not xml at all');
    assert.deepStrictEqual(doc, { otherEntries: [], devices: [] });
  });

  it('unescapes XML entities in values', () => {
    const xml = SAMPLE_XML.replace('Xperia 10 IV</value>\n    </data>\n    <data>\n        <variable>Device.0.Autodetected', 'Xperia &amp; Co &lt;IV&gt;</value>\n    </data>\n    <data>\n        <variable>Device.0.Autodetected');
    const doc = parseDevicesXml(xml);
    assert.strictEqual(doc.devices[0].name, 'Xperia & Co <IV>');
  });
});

describe('serializeDevicesXml (FR-7.3/7.5)', () => {
  it('round-trips a parsed document back into an equivalent one', () => {
    const parsed = parseDevicesXml(SAMPLE_XML);
    const serialized = serializeDevicesXml(parsed, '2026-09-28T00:00:00.000Z');
    const reparsed = parseDevicesXml(serialized);
    assert.deepStrictEqual(reparsed, parsed);
  });

  it('emits Devices.Count matching the actual device count', () => {
    const doc: DevicesXmlDocument = { otherEntries: [], devices: [] };
    const serialized = serializeDevicesXml(doc, '2026-09-28T00:00:00.000Z');
    const reparsed = parseDevicesXml(serialized);
    assert.match(serialized, /<variable>Devices\.Count<\/variable>\s*<value type="int">0<\/value>/);
    assert.strictEqual(reparsed.devices.length, 0);
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
    assert.strictEqual(reread.devices.length, 1);
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
