import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDevicesXmlPath, candidateDevicesXmlPaths } from '../../../src/devices/devicesXmlLocation';

describe('candidateDevicesXmlPaths (FR-7.2)', () => {
  it('probes the Linux/macOS ~/.config path first, then the macOS Preferences path', () => {
    const candidates = candidateDevicesXmlPaths('/Users/x', undefined, {});
    assert.strictEqual(candidates[0], '/Users/x/.config/SailfishSDK/libsfdk/devices.xml');
    assert.strictEqual(candidates[1], '/Users/x/Library/Preferences/SailfishSDK/libsfdk/devices.xml');
  });

  it('includes the SDK-root-relative path only when an sdkRoot is given', () => {
    assert.strictEqual(candidateDevicesXmlPaths('/h', undefined, {}).length, 2);
    const withSdk = candidateDevicesXmlPaths('/h', '/opt/SailfishOS-SDK', {});
    assert.ok(withSdk.includes('/opt/SailfishOS-SDK/settings/SailfishSDK/libsfdk/devices.xml'));
  });

  it('includes XDG_CONFIG_HOME only when set', () => {
    const withXdg = candidateDevicesXmlPaths('/h', undefined, { XDG_CONFIG_HOME: '/xdg' });
    assert.ok(withXdg.includes('/xdg/SailfishSDK/libsfdk/devices.xml'));
  });
});

describe('resolveDevicesXmlPath (FR-7.2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-xml-location-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('an explicit setting override always wins, regardless of whether it exists', () => {
    const result = resolveDevicesXmlPath('/custom/devices.xml', tmpDir, undefined, {});
    assert.strictEqual(result.path, '/custom/devices.xml');
    assert.strictEqual(result.confirmed, true);
    assert.strictEqual(result.existed, false);
  });

  it('finds an existing devices.xml at the first real candidate path', () => {
    const dir = path.join(tmpDir, '.config', 'SailfishSDK', 'libsfdk');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'devices.xml'), '<qtcreator></qtcreator>');
    const result = resolveDevicesXmlPath(undefined, tmpDir, undefined, {});
    assert.strictEqual(result.path, path.join(dir, 'devices.xml'));
    assert.strictEqual(result.existed, true);
    assert.strictEqual(result.confirmed, true);
  });

  it('confirms a directory with no devices.xml yet if a sibling emulators.xml exists', () => {
    const dir = path.join(tmpDir, '.config', 'SailfishSDK', 'libsfdk');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'emulators.xml'), '<qtcreator></qtcreator>');
    const result = resolveDevicesXmlPath(undefined, tmpDir, undefined, {});
    assert.strictEqual(result.existed, false);
    assert.strictEqual(result.confirmed, true);
  });

  it('is unconfirmed when nothing exists anywhere (caller must ask the user before creating)', () => {
    const result = resolveDevicesXmlPath(undefined, tmpDir, undefined, {});
    assert.strictEqual(result.confirmed, false);
    assert.strictEqual(result.existed, false);
  });
});
