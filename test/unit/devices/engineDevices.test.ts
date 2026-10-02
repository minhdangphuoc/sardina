import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addEngineDevice,
  editEngineDevicesFile,
  findSharedConfigDir,
  hasEngineDevice,
  removeEngineDevice,
} from '../../../src/devices/engineDevices';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
/** The build engine's real device list (SDK 3.13.5): emulator (type="vbox") + phone (type="real"). */
const ENGINE_XML = fs.readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'sfdk', 'captured', '3.13.5', 'engine_devices.xml'), 'utf8');
const PHONE = 'Jolla Phone 2026';

describe('engine device list (vmshare/devices.xml)', () => {
  it('finds the phone and the emulator in the captured file', () => {
    assert.ok(hasEngineDevice(ENGINE_XML, PHONE));
    assert.ok(hasEngineDevice(ENGINE_XML, 'Sailfish OS Emulator 5.1.0.11'));
    assert.ok(!hasEngineDevice(ENGINE_XML, 'Jolla Phone'));
  });

  it('removing then re-adding the phone reproduces the captured file exactly', () => {
    const withoutPhone = removeEngineDevice(ENGINE_XML, PHONE);
    assert.ok(!hasEngineDevice(withoutPhone, PHONE));
    assert.ok(hasEngineDevice(withoutPhone, 'Sailfish OS Emulator 5.1.0.11'), 'other devices untouched');
    const readded = addEngineDevice(withoutPhone, {
      name: PHONE,
      host: '192.168.2.16',
      port: 22,
      user: 'defaultuser',
      keyPath: 'ssh/private_keys/jolla-phone-2026',
    });
    assert.strictEqual(readded, ENGINE_XML);
  });

  it('adding an existing name replaces it instead of duplicating', () => {
    const updated = addEngineDevice(ENGINE_XML, { name: PHONE, host: '10.0.0.5', port: 2222, user: 'defaultuser', keyPath: 'k' });
    assert.ok(updated);
    assert.strictEqual(updated?.match(/Jolla Phone 2026/g)?.length, 1);
    assert.ok(updated?.includes('<ip>10.0.0.5</ip>'));
  });

  it('escapes names and refuses a file without </devices>', () => {
    const updated = addEngineDevice('<devices>\n</devices>\n', { name: 'A & "B"', host: 'h', port: 22, user: 'u', keyPath: 'k' });
    assert.ok(updated?.includes('<device name="A &amp; &quot;B&quot;" type="real">'));
    assert.ok(updated && hasEngineDevice(updated, 'A & "B"'));
    assert.strictEqual(addEngineDevice('garbage', { name: 'x', host: 'h', port: 22, user: 'u', keyPath: 'k' }), undefined);
  });

  describe('files', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-devices-'));
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('reads SharedConfig from buildengines.xml, falling back to <sdkRoot>/vmshare', () => {
      const shared = path.join(tmp, 'shared');
      fs.mkdirSync(shared);
      fs.writeFileSync(path.join(tmp, 'buildengines.xml'), `<value type="QString" key="SharedConfig">${shared}</value>`);
      assert.strictEqual(findSharedConfigDir(tmp, undefined), shared);
      fs.rmSync(path.join(tmp, 'buildengines.xml'));
      fs.mkdirSync(path.join(tmp, 'sdk', 'vmshare'), { recursive: true });
      assert.strictEqual(findSharedConfigDir(tmp, path.join(tmp, 'sdk')), path.join(tmp, 'sdk', 'vmshare'));
      assert.strictEqual(findSharedConfigDir(tmp, undefined), undefined);
    });

    it('edits with a backup, and writes nothing when the edit changes nothing', () => {
      fs.writeFileSync(path.join(tmp, 'devices.xml'), ENGINE_XML);
      assert.strictEqual(editEngineDevicesFile(tmp, (xml) => xml), undefined);
      const backup = editEngineDevicesFile(tmp, (xml) => removeEngineDevice(xml, PHONE));
      assert.ok(backup && fs.readFileSync(backup, 'utf8') === ENGINE_XML);
      assert.ok(!hasEngineDevice(fs.readFileSync(path.join(tmp, 'devices.xml'), 'utf8'), PHONE));
    });
  });
});
