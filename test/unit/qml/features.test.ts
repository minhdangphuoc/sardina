import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type FeatureEnv, completionsAt, diagnose, hoverAt } from '../../../src/qml/features';
import { fsIndexIO } from '../../../src/qml/fsIO';
import { parseQmlOutline, toComponentOutline } from '../../../src/qml/qmlOutline';
import { TypeIndex } from '../../../src/qml/typeIndex';

const root = path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'qmltypes', 'root');
const HEAD = 'import QtQuick 2.0\nimport Sailfish.Silica 1.0\n';
const CARET = '|';

function newIndex(): TypeIndex {
  return new TypeIndex(fsIndexIO, root, { parseComponent: (t) => toComponentOutline(parseQmlOutline(t)) });
}

/** `text` holds one `|` marking the cursor; returns the environment and the cursor offset. */
function envAt(index: TypeIndex, text: string, dir?: string): { env: FeatureEnv; offset: number } {
  const offset = text.indexOf(CARET);
  const clean = offset < 0 ? text : text.replace(CARET, '');
  return { env: { index, text: clean, outline: parseQmlOutline(clean), dir }, offset };
}

async function labels(text: string): Promise<string[]> {
  const { env, offset } = envAt(newIndex(), text);
  return (await completionsAt(env, offset)).map((c) => c.label);
}

async function problems(text: string, dir?: string): Promise<string[]> {
  const { env } = envAt(newIndex(), text, dir);
  return (await diagnose(env)).map((p) => p.message);
}

describe('qml/features completion', () => {
  it('offers types at top level and in a body', async () => {
    const top = await labels(`${HEAD}|`);
    assert.ok(top.includes('Page') && top.includes('Rectangle'));
    assert.ok(!top.includes('Palette'), 'singletons cannot be nested');
    assert.ok(!top.includes('Animation'), 'not creatable');
    assert.ok((await labels(`${HEAD}Page {\n  |\n}`)).includes('Label'));
  });

  it('offers members of the type chain, handlers and id in a body', async () => {
    const found = await labels(`${HEAD}Page {\n  |\n}`);
    for (const want of ['allowedOrientations', 'onOpened', 'onStatusChanged', 'width', 'onWidthChanged', 'anchors', 'id']) {
      assert.ok(found.includes(want), want);
    }
  });

  it('offers declared members and their handlers', async () => {
    const found = await labels(`${HEAD}Page {\n  property int mine\n  signal ping()\n  |\n}`);
    assert.ok(found.includes('mine') && found.includes('onMineChanged') && found.includes('onPing'));
  });

  it('offers the group type members for a group object', async () => {
    const found = await labels(`${HEAD}Page {\n  anchors {\n    |\n  }\n}`);
    assert.ok(found.includes('margins') && found.includes('fill') && !found.includes('allowedOrientations'));
  });

  it('completes after an id, a singleton, an enum container, a group property and Qt', async () => {
    assert.ok((await labels(`${HEAD}Page {\n  Label { id: lbl }\n  width: lbl.|\n}`)).includes('text'));
    assert.ok((await labels(`${HEAD}Page { width: Palette.| }`)).includes('paddingLarge'));
    assert.ok((await labels(`${HEAD}Page { width: Text.| }`)).includes('AlignLeft'));
    assert.ok((await labels(`${HEAD}Page { anchors.| }`)).includes('margins'));
    assert.ok((await labels(`${HEAD}Page { width: Qt.| }`)).includes('rgba'));
    assert.ok((await labels(`${HEAD}Page { width: parent.| }`)).length === 0);
  });

  it('completes attached properties after a type name', async () => {
    assert.ok((await labels(`${HEAD}Page { width: ListView.| }`)).includes('isCurrentItem'));
  });

  it('completes types after a qualifier', async () => {
    const found = await labels('import QtQuick 2.0 as Q\nQ.|');
    assert.ok(found.includes('Item'));
  });

  it('completes module names and versions in an import line', async () => {
    const modules = await labels('import Sail|');
    assert.ok(modules.includes('Sailfish.Silica') && modules.includes('QtQuick'));
    assert.deepStrictEqual(await labels('import QtQuick |'), ['2.0', '2.1']);
  });

  it('is silent inside strings and comments', async () => {
    assert.deepStrictEqual(await labels(`${HEAD}Page {\n  // note |\n}`), []);
  });

  it('offers ids, members and singletons in a value', async () => {
    const found = await labels(`${HEAD}Page {\n  Label { id: lbl }\n  width: |\n}`);
    assert.ok(found.includes('lbl') && found.includes('height') && found.includes('Palette'));
  });
});

describe('qml/features hover', () => {
  async function hover(text: string): Promise<string | undefined> {
    const { env, offset } = envAt(newIndex(), text);
    return (await hoverAt(env, offset))?.markdown;
  }

  it('shows the chain of a type', async () => {
    const md = await hover(`${HEAD}Pa|ge {}`);
    assert.ok(md?.includes('Page') && md.includes('QML component') && md.includes('Sailfish.Silica 1.0'));
    assert.ok((await hover(`${HEAD}Te|xt {}`))?.includes('Text \u2192 FxItem'));
  });

  it('shows a member with its owner', async () => {
    const md = await hover(`${HEAD}Page {\n  wid|th: 3\n}`);
    assert.ok(md?.includes('property double width') && md.includes('Item'));
    assert.ok((await hover(`${HEAD}Page {\n  property int mi|ne: 1\n}`))?.includes('property int mine'));
  });

  it('shows the type of an id', async () => {
    const md = await hover(`${HEAD}Page {\n  Label { id: lbl }\n  width: lb|l.x\n}`);
    assert.ok(md?.includes('id: lbl') && md.includes('Label'));
  });

  it('shows nothing for unknown names', async () => {
    assert.strictEqual(await hover(`${HEAD}Page {\n  wi|dth2: 3\n}`), undefined);
  });
});

describe('qml/features diagnostics', () => {
  it('reports an unknown type', async () => {
    assert.deepStrictEqual(await problems(`${HEAD}Page {\n  Lable {}\n}`), ['Unknown type "Lable"']);
  });

  it('reports an unknown property of a resolved chain', async () => {
    assert.deepStrictEqual(await problems(`${HEAD}Page {\n  colour: "red"\n}`), ['Unknown property "colour" on "Page"']);
  });

  it('accepts a valid file', async () => {
    const text = `${HEAD}Page {
  id: page
  property int mine: 1
  allowedOrientations: 2
  anchors.fill: parent
  anchors { margins: 3 }
  onOpened: console.log(mine)
  Component.onCompleted: {}
  Label { text: "x"; color: "red" }
  Rectangle { ColorAnimation on color { to: "red" } }
  Connections { target: page; anything: 1 }
}`;
    assert.deepStrictEqual(await problems(text), []);
  });

  it('stays silent when an import does not resolve', async () => {
    assert.deepStrictEqual(await problems('import harbour.demo.Foo 1.0\nimport QtQuick 2.0\nLable {}'), []);
    assert.deepStrictEqual(await problems(`${HEAD}import "nowhere"\nLable {}`, root), []);
  });

  it('stays silent when the file is not clean', async () => {
    assert.deepStrictEqual(await problems(`${HEAD}Page {\n  Lable {}\n`), []);
  });

  it('stays silent for the body of a partial chain', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-qml-partial-'));
    try {
      fs.writeFileSync(path.join(dir, 'Broken.qml'), 'import QtQuick 2.0\nMystery {}\n');
      assert.deepStrictEqual(await problems('import QtQuick 2.0\nBroken { anything: 1 }', dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays silent for a plugin module without type information, and reads an unnamed plugins.qmltypes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-qml-root-'));
    try {
      fs.cpSync(root, tmp, { recursive: true });
      fs.mkdirSync(path.join(tmp, 'Opaque'));
      fs.writeFileSync(path.join(tmp, 'Opaque', 'qmldir'), 'module Opaque\nplugin opaqueplugin\n');
      const index = new TypeIndex(fsIndexIO, tmp, { parseComponent: (t) => toComponentOutline(parseQmlOutline(t)) });
      const text = 'import QtQuick 2.0\nimport Opaque 1.0\nItem { Anything {} }';
      assert.deepStrictEqual(await diagnose({ index, text, outline: parseQmlOutline(text) }), []);
      fs.copyFileSync(path.join(root, 'QtQuick.2', 'plugins.qmltypes'), path.join(tmp, 'Opaque', 'plugins.qmltypes'));
      const described = new TypeIndex(fsIndexIO, tmp, { parseComponent: (t) => toComponentOutline(parseQmlOutline(t)) });
      assert.strictEqual((await diagnose({ index: described, text, outline: parseQmlOutline(text) })).length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not report underscore handlers', async () => {
    assert.deepStrictEqual(await problems(`${HEAD}Page {\n  on_FooChanged: 1\n}`), []);
  });

  it('resolves types of the same directory and directory imports', async () => {
    const dir = path.join(root, 'Fixture', 'Widgets');
    assert.deepStrictEqual(await problems('import QtQuick 2.0\nPanel { padding: 1 }', dir), []);
    assert.deepStrictEqual(await problems('import QtQuick 2.0\nimport "private"\nSecret {}', dir), []);
    assert.deepStrictEqual(await problems('import QtQuick 2.0\nNoSuch {}', dir), ['Unknown type "NoSuch"']);
  });
});
