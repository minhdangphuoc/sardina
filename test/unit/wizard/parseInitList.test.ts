import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseInitList } from '../../../src/wizard/parseInitList';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCENARIOS = path.join(REPO_ROOT, 'test', 'fixtures', 'sfdk', 'scenarios');
const PARSER_FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures', 'sfdk', 'parsers', 'init-list');

function scenarioFixture(scenario: string, name: string): string {
  return fs.readFileSync(path.join(SCENARIOS, scenario, name), 'utf8');
}

function parserFixture(name: string): string {
  return fs.readFileSync(path.join(PARSER_FIXTURES, name), 'utf8');
}

describe('parseInitList (FR-16.5, FR-3.1 step 1)', () => {
  it('default init_list.stdout: 3 entries, exact type/description', () => {
    const result = parseInitList(scenarioFixture('default', 'init_list.stdout'));
    assert.ok(result.ok, 'expected ok:true');
    if (!result.ok) return;
    assert.strictEqual(result.value.length, 3);
    assert.deepStrictEqual(result.value[0], {
      type: 'qtquick2app',
      description: 'Qt Quick 2 application (Silica, recommended)',
    });
    assert.strictEqual(result.value[1].type, 'minimalapp');
    assert.strictEqual(result.value[2].type, 'cpp-qmake');
    assert.deepStrictEqual(result.warnings, []);
  });

  it('well-formed fixture matches the default scenario 1:1', () => {
    const result = parseInitList(parserFixture('well-formed.txt'));
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.value.length, 3);
  });

  it('M1.9: malformed fixture tolerates garbage lines, blank lines and tabs, still returning the 3 valid entries with warnings', () => {
    const result = parseInitList(parserFixture('malformed.txt'));
    assert.ok(result.ok, 'must fail soft (ok:true) when at least one line parses');
    if (!result.ok) return;
    assert.strictEqual(result.value.length, 3);
    assert.ok(result.value.some((t) => t.type === 'minimalapp'), 'tab-separated line must still parse');
    assert.ok(result.warnings.length >= 2, 'expected warnings for the "!!!"/"###" garbage lines');
  });

  it('M1.9: an all-garbage fixture returns ok:false, never throws', () => {
    assert.doesNotThrow(() => parseInitList(parserFixture('all-garbage.txt')));
    const result = parseInitList(parserFixture('all-garbage.txt'));
    assert.strictEqual(result.ok, false);
  });

  it('empty output is an empty list, not an error (distinguishes "no types" from "malformed")', () => {
    const result = parseInitList('');
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepStrictEqual(result.value, []);
  });

  it('never throws on adversarial input', () => {
    const inputs = ['\0\0\0', 'a'.repeat(100000), '日本語 café', '\r\n\r\n', '-t --list-types'];
    for (const input of inputs) {
      assert.doesNotThrow(() => parseInitList(input));
    }
  });
});
