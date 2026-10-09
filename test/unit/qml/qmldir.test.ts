import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseQmldir } from '../../../src/qml/qmldir';

const root = path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'qmltypes', 'root');
const load = (rel: string) => parseQmldir(fs.readFileSync(path.join(root, rel), 'utf8'));

describe('qml/qmldir', () => {
  it('reads module, plugin, typeinfo and depends', () => {
    const d = load('Fixture/Widgets/qmldir');
    assert.strictEqual(d.module, 'Fixture.Widgets');
    assert.deepStrictEqual(d.plugins, ['fixturewidgetsplugin']);
    assert.deepStrictEqual(d.typeinfo, ['plugins.qmltypes']);
    assert.deepStrictEqual(d.depends, [{ module: 'QtQuick', major: 2, minor: 0 }]);
  });

  it('reads components, singletons, internals and JS files', () => {
    const d = load('Fixture/Widgets/qmldir');
    const by = (name: string) => d.entries.filter((e) => e.name === name);
    assert.deepStrictEqual(by('Panel'), [{ name: 'Panel', major: 1, minor: 0, file: 'Panel.qml', singleton: false, internal: false }]);
    assert.deepStrictEqual(by('Knob').map((e) => e.minor), [0, 1]);
    assert.ok(by('Palette')[0].singleton);
    assert.ok(by('Hidden')[0].internal);
    assert.strictEqual(by('Helpers')[0].file, 'helpers.js');
  });

  it('accepts a file without a module line', () => {
    const d = load('Fixture/Widgets/private/qmldir');
    assert.strictEqual(d.module, undefined);
    assert.strictEqual(d.entries.length, 1);
  });

  it('skips comments, CRLF and malformed lines', () => {
    const d = parseQmldir('# note\r\nmodule A.B # tail\r\nBroken\r\nOdd x Y.qml\r\nsingleton S\r\nOk 2.1 Ok.qml\r\n');
    assert.strictEqual(d.module, 'A.B');
    assert.deepStrictEqual(d.entries.map((e) => `${e.name} ${e.major}.${e.minor}`), ['Ok 2.1']);
  });

  it('never throws on garbage', () => {
    assert.deepStrictEqual(parseQmldir('').entries, []);
    assert.doesNotThrow(() => parseQmldir('\0\u{1F600}{}[]'.repeat(1000)));
  });
});
