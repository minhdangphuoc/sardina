import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseQmltypes } from '../../../src/qml/qmltypes';

const root = path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'qmltypes', 'root');
const load = (rel: string) => parseQmltypes(fs.readFileSync(path.join(root, rel), 'utf8'));

describe('qml/qmltypes', () => {
  const quick = load('QtQuick.2/plugins.qmltypes');
  const item = quick.components.find((c) => c.name === 'FxItem');

  it('reads components with prototype, exports and default property', () => {
    assert.ok(item);
    assert.strictEqual(item.prototype, 'QObject');
    assert.strictEqual(item.defaultProperty, 'data');
    assert.deepStrictEqual(
      item.exports.map((e) => `${e.module}/${e.name} ${e.major}.${e.minor}`),
      ['QtQuick/Item 2.0', 'QtQuick/Item 2.1'],
    );
  });

  it('reads property flags', () => {
    const anchors = item?.properties.find((p) => p.name === 'anchors');
    assert.deepStrictEqual(anchors, { name: 'anchors', type: 'FxAnchors', isReadonly: true, isPointer: true, isList: false });
    assert.ok(item?.properties.find((p) => p.name === 'children')?.isList);
  });

  it('keeps overloaded methods and signal parameters', () => {
    assert.strictEqual(item?.methods.filter((m) => m.name === 'forceActiveFocus').length, 2);
    const changed = item?.signals.find((s) => s.name === 'childrenRectChanged');
    assert.deepStrictEqual(changed?.params, [{ name: 'rect', type: 'QRectF' }]);
  });

  it('reads enum value names', () => {
    const text = quick.components.find((c) => c.name === 'FxText');
    assert.deepStrictEqual(text?.enums, [{ name: 'Align', values: ['AlignLeft', 'AlignRight', 'AlignHCenter'] }]);
  });

  it('reads attached types and creatable/singleton flags', () => {
    assert.strictEqual(quick.components.find((c) => c.name === 'FxListView')?.attachedType, 'FxListViewAttached');
    assert.strictEqual(quick.components.find((c) => c.name === 'FxKeyEvent')?.isCreatable, false);
    const theme = load('Fixture/Widgets/plugins.qmltypes').components.find((c) => c.name === 'WidgetTheme');
    assert.ok(theme?.isSingleton);
    assert.strictEqual(theme?.isCreatable, false);
    assert.ok(item?.isCreatable && !item.isSingleton);
  });

  it('reads dependencies', () => {
    assert.deepStrictEqual(load('Fixture/Widgets/plugins.qmltypes').dependencies, [{ module: 'QtQuick', major: 2, minor: 0 }]);
    assert.deepStrictEqual(quick.dependencies, []);
  });

  it('ignores unknown keys, comments and nested blocks', () => {
    const m = parseQmltypes('Module { Future { x: [1, 2] } Component { name: "A" /* c */ // d\n Weird { a: { "k": 1 } } } }');
    assert.deepStrictEqual(m.components.map((c) => c.name), ['A']);
  });

  it('returns what it could read from truncated and garbage input', () => {
    assert.deepStrictEqual(parseQmltypes('').components, []);
    assert.deepStrictEqual(parseQmltypes('}}}{{{ ]] : ;;').components, []);
    const cut = parseQmltypes('Module { Component { name: "A" Property { name: "p"; type: "int"');
    assert.strictEqual(cut.components[0]?.properties[0]?.name, 'p');
  });

  it('survives deeply nested blocks', () => {
    assert.doesNotThrow(() => parseQmltypes('A {'.repeat(100000)));
  });
});
