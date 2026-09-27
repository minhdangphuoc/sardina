import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { extractVmNameFromShowOutput, matchVboxVmName, parseVboxVmNames } from '../../../src/devices/vmCorrelationCore';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCENARIOS = path.join(REPO_ROOT, 'test', 'fixtures', 'sfdk', 'scenarios');

function fixture(scenario: string, name: string): string {
  return fs.readFileSync(path.join(SCENARIOS, scenario, name), 'utf8');
}

describe('extractVmNameFromShowOutput (FR-6.8 step 1)', () => {
  it('finds the first key/value line whose key contains "vm"', () => {
    const raw = fixture('default', 'emulator_show.stdout');
    assert.strictEqual(extractVmNameFromShowOutput(raw), 'Sailfish_OS_Emulator_4.4.0.58');
  });

  it('returns undefined when no key contains "vm"', () => {
    assert.strictEqual(extractVmNameFromShowOutput('name: foo\nindex: 0\n'), undefined);
  });

  it('never throws on garbage input', () => {
    assert.doesNotThrow(() => extractVmNameFromShowOutput('\u0000not: key/value\nat: all---'));
  });

  it('FR-6.8: an exact "vm-name" key wins over an earlier "vm-type" key that merely contains "vm"', () => {
    const raw = 'vm-type: VirtualBox\nvm-name: Sailfish_OS_Emulator_4.4.0.58\n';
    assert.strictEqual(extractVmNameFromShowOutput(raw), 'Sailfish_OS_Emulator_4.4.0.58');
  });
});

describe('parseVboxVmNames + matchVboxVmName (FR-6.8 step 2)', () => {
  const vboxOutput = '"Sailfish_OS_Emulator_4.4.0.58" {11111111-2222-3333-4444-555555555555}\n"Other VM" {66666666-7777-8888-9999-000000000000}\n';

  it('parses quoted VM names from `VBoxManage list vms`', () => {
    assert.deepStrictEqual(parseVboxVmNames(vboxOutput), ['Sailfish_OS_Emulator_4.4.0.58', 'Other VM']);
  });

  it('exact match wins first', () => {
    const names = parseVboxVmNames(vboxOutput);
    assert.strictEqual(matchVboxVmName(names, 'Sailfish_OS_Emulator_4.4.0.58'), 'Sailfish_OS_Emulator_4.4.0.58');
  });

  it('falls back to substring match either direction', () => {
    assert.strictEqual(matchVboxVmName(['Sailfish_OS_Emulator_4.4.0.58_clone'], 'Sailfish_OS_Emulator_4.4.0.58'), 'Sailfish_OS_Emulator_4.4.0.58_clone');
  });

  it('falls back to a match on the version token alone', () => {
    assert.strictEqual(matchVboxVmName(['some-renamed-vm-4.4.0.58'], 'Sailfish OS Emulator 4.4.0.58'), 'some-renamed-vm-4.4.0.58');
  });

  it('returns undefined when nothing matches (e.g. VBoxManage absent)', () => {
    assert.strictEqual(matchVboxVmName([], 'Sailfish OS Emulator 4.4.0.58'), undefined);
    assert.strictEqual(matchVboxVmName(['totally-unrelated'], 'Sailfish OS Emulator 4.4.0.58'), undefined);
  });

  it('FR-6.8: an empty VM name never matches via the reverse-substring check', () => {
    assert.strictEqual(matchVboxVmName(['', 'Other VM'], 'Sailfish OS Emulator 4.4.0.58'), undefined);
  });
});
