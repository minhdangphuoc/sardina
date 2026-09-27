import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  formatDeviceDescription,
  formatDeviceLabel,
  isDefaultDevice,
  parseDeviceList,
  parseEmulatorList,
} from '../../../src/devices/listParsing';

// Compiled to out/test/unit/devices/*.js; fixtures live only under the
// repo's test/fixtures (never compiled into out/).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCENARIOS = path.join(REPO_ROOT, 'test', 'fixtures', 'sfdk', 'scenarios');

function fixture(scenario: string, name: string): string {
  return fs.readFileSync(path.join(SCENARIOS, scenario, name), 'utf8');
}

describe('parseDeviceList / parseEmulatorList (FR-16.4, AC-1.8)', () => {
  it('default device_list.stdout: 3 entries, exact labels/descriptions', () => {
    const result = parseDeviceList(fixture('default', 'device_list.stdout'));
    assert.ok(result.ok, 'expected ok:true');
    if (!result.ok) return;
    assert.strictEqual(result.value.length, 3);

    const emulator = result.value[0];
    assert.strictEqual(emulator.index, 0);
    assert.strictEqual(emulator.name, 'Sailfish OS Emulator 4.4.0.58');
    assert.strictEqual(emulator.kind, 'emulator');
    assert.strictEqual(emulator.origin, 'autodetected');
    assert.strictEqual(emulator.user, 'defaultuser');
    assert.strictEqual(emulator.host, '127.0.0.1');
    assert.strictEqual(emulator.port, 2223);
    assert.strictEqual(emulator.privateKey, '/Users/mersdk/.ssh/sdk');
    assert.strictEqual(formatDeviceLabel(emulator, false), '"Sailfish OS Emulator 4.4.0.58"');
    assert.strictEqual(formatDeviceDescription(emulator), 'emulator autodetected defaultuser@127.0.0.1:2223');

    const hw = result.value[1];
    assert.strictEqual(hw.kind, 'hardware-device');
    assert.strictEqual(hw.origin, 'user-defined');
    assert.strictEqual(hw.name, 'Xperia 10 - Dual SIM (ARM)');

    const unicode = result.value[2];
    assert.strictEqual(unicode.name, 'Xperia 10 III – 日本語');
  });

  it('$(check) suffix is applied only when isDefault is true', () => {
    const result = parseDeviceList(fixture('default', 'device_list.stdout'));
    assert.ok(result.ok);
    if (!result.ok) return;
    const device = result.value[0];
    assert.strictEqual(formatDeviceLabel(device, true), '"Sailfish OS Emulator 4.4.0.58" $(check)');
    assert.strictEqual(isDefaultDevice(device, device.name), true);
    assert.strictEqual(isDefaultDevice(device, 'something-else'), false);
  });

  it('default emulator_list.stdout: installed entries plus an "available" superset entry', () => {
    const result = parseEmulatorList(fixture('default', 'emulator_list.stdout'));
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.value.length, 3);
    const installed = result.value.filter((d) => !d.flags.includes('available'));
    const available = result.value.filter((d) => d.flags.includes('available'));
    assert.strictEqual(installed.length, 2);
    assert.strictEqual(available.length, 1);
    assert.strictEqual(available[0].name, 'Sailfish OS Emulator 4.5.0.24');
  });

  it('device-list-empty (R6): ok:true, empty value, no warnings — explicit empty state, not an error', () => {
    const result = parseDeviceList(fixture('device-list-empty', 'device_list.stdout'));
    assert.deepStrictEqual(result, { ok: true, value: [], warnings: [] });
  });

  it('device-list-malformed (fail-soft ok:false path, per PROVENANCE.md): no record parses, never throws', () => {
    const result = parseDeviceList(fixture('device-list-malformed', 'device_list.stdout'));
    assert.strictEqual(result.ok, false, 'every record in this fixture is deliberately unparseable');
    if (result.ok) return;
    assert.ok(result.reason.length > 0);
    assert.strictEqual(result.raw, fixture('device-list-malformed', 'device_list.stdout'));
  });

  it('R6: a partially-malformed list keeps the valid entries and surfaces one warning per bad record', () => {
    const raw =
      '#0 "Good Emulator"\n    emulator autodetected defaultuser@127.0.0.1:2223\n    private-key: /Users/mersdk/.ssh/sdk\n\n#garbled "Bad Entry"\n    hardware-device user-defined defaultuser@192.168.2.15\n';
    const result = parseDeviceList(raw);
    assert.ok(result.ok, 'at least one valid record must keep the whole parse ok:true');
    if (!result.ok) return;
    assert.strictEqual(result.value.length, 1);
    assert.strictEqual(result.value[0].name, 'Good Emulator');
    assert.ok(result.warnings.length >= 1, 'expected a warning for the unparseable second record');
  });

  it('AC-1.9 localized device_list.stdout.de: preamble surfaced as a warning, records still parsed (private-key line is untranslated)', () => {
    const result = parseDeviceList(fixture('localized', 'device_list.stdout.de'));
    assert.ok(result.ok, 'device records all carry a recognised private-key line, so this must stay ok:true');
    if (!result.ok) return;
    assert.strictEqual(result.value.length, 3);
    assert.strictEqual(result.value[1].name, 'Xperia 10 - Dual SIM (ARM)');
    assert.ok(
      result.warnings.some((w) => w.includes('Geräteliste')),
      'the "Geräteliste:" preamble line must be surfaced as a warning, not dropped silently',
    );
  });

  it('AC-1.9 localized emulator_list.stdout.de: unrecognised German detail keys and no private-key line -> ok:false ("Could not list")', () => {
    const result = parseEmulatorList(fixture('localized', 'emulator_list.stdout.de'));
    assert.strictEqual(
      result.ok,
      false,
      'every record has an unrecognised "privater-schluessel:"/"status: läuft nicht" key and no recognised private-key line: this is the non-C-locale signature and must fail soft to "Could not list", not silently drop the private key',
    );
    if (result.ok) return;
    assert.ok(result.reason.length > 0);
  });

  it('empty string input never throws and is a clean empty state', () => {
    assert.deepStrictEqual(parseDeviceList(''), { ok: true, value: [], warnings: [] });
    assert.deepStrictEqual(parseDeviceList('   \n  \n'), { ok: true, value: [], warnings: [] });
  });
});
