import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseTargetList } from '../../../src/targets/parseTargetList';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCENARIOS = path.join(REPO_ROOT, 'test', 'fixtures', 'sfdk', 'scenarios');

function fixture(scenario: string, name: string): string {
  return fs.readFileSync(path.join(SCENARIOS, scenario, name), 'utf8');
}

describe('parseTargetList (FR-16.3, FR-4.2)', () => {
  it('default tools_target_list.stdout: 3 targets, exact arch/flags', () => {
    const result = parseTargetList(fixture('default', 'tools_target_list.stdout'));
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.value.length, 3);

    const aarch64 = result.value[0];
    assert.strictEqual(aarch64.name, 'SailfishOS-4.4.0.58-aarch64');
    assert.strictEqual(aarch64.arch, 'aarch64');
    assert.strictEqual(aarch64.version, '4.4.0.58');
    assert.deepStrictEqual(aarch64.flags, ['sdk-provided', 'latest']);
    assert.strictEqual(aarch64.isSnapshot, false);

    assert.strictEqual(result.value[1].arch, 'armv7hl');
    assert.strictEqual(result.value[2].arch, 'i486');
    assert.deepStrictEqual(result.value[2].flags, ['sdk-provided', 'latest', 'early-access']);
  });

  it('old-format (tools-list-odd-glyphs) fixture: tabs and trailing whitespace still parse to the same arch set', () => {
    const result = parseTargetList(fixture('tools-list-odd-glyphs', 'tools_target_list.stdout'));
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepStrictEqual(
      result.value.map((t) => t.arch).sort(),
      ['aarch64', 'armv7hl', 'i486'],
    );
  });

  it('snapshot target: isSnapshot true, flags include "snapshot"', () => {
    const result = parseTargetList(fixture('targets-with-snapshot', 'tools_target_list.stdout'));
    assert.ok(result.ok);
    if (!result.ok) return;
    const snapshot = result.value.find((t) => t.flags.includes('snapshot'));
    assert.ok(snapshot);
    assert.strictEqual(snapshot?.isSnapshot, true);
  });

  it('no-targets: empty stdout is an empty list, not an error', () => {
    const result = parseTargetList(fixture('no-targets', 'tools_target_list.stdout'));
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepStrictEqual(result.value, []);
  });

  it('a name with no recognised arch suffix parses with arch "unknown", never throws', () => {
    const result = parseTargetList('some-custom-target                 sdk-provided\n');
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.value[0].arch, 'unknown');
  });

  it('garbage input returns ok:false, never throws', () => {
    assert.doesNotThrow(() => parseTargetList('\0\0\0\n###\n'));
    const result = parseTargetList('\0\0\0\n###\n');
    assert.strictEqual(result.ok, false);
  });

  it('never throws on adversarial input', () => {
    for (const input of ['\0\0\0', 'a'.repeat(100000), '日本語 café', '\r\n\r\n']) {
      assert.doesNotThrow(() => parseTargetList(input));
    }
  });
});
