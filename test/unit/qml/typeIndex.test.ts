import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { type IndexIO, type Scope, TypeIndex } from '../../../src/qml/typeIndex';
import type { OutlineImport, QmlComponentOutline } from '../../../src/qml/types';

const fixtureRoot = path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'qmltypes', 'root');
const ROOT = '/qml';

class MemoryIO implements IndexIO {
  files = new Map<string, { text: string; mtimeMs: number }>();
  reads: string[] = [];

  constructor() {
    const load = (dir: string, virtual: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const v = path.posix.join(virtual, e.name);
        if (e.isDirectory()) load(path.join(dir, e.name), v);
        else this.files.set(v, { text: fs.readFileSync(path.join(dir, e.name), 'utf8'), mtimeMs: 1 });
      }
    };
    load(fixtureRoot, ROOT);
  }

  readFile(file: string): Promise<string | undefined> {
    this.reads.push(file);
    return Promise.resolve(this.files.get(file)?.text);
  }
  readdir(dir: string): Promise<string[] | undefined> {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const names = new Set<string>();
    for (const f of this.files.keys()) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]);
    return Promise.resolve(names.size ? [...names] : undefined);
  }
  async stat(file: string): Promise<{ mtimeMs: number; isDirectory: boolean } | undefined> {
    const f = this.files.get(file);
    if (f) return { mtimeMs: f.mtimeMs, isDirectory: false };
    return (await this.readdir(file)) ? { mtimeMs: 0, isDirectory: true } : undefined;
  }
  touch(file: string, text?: string): void {
    const f = this.files.get(file);
    assert.ok(f);
    this.files.set(file, { text: text ?? f.text, mtimeMs: f.mtimeMs + 1 });
  }
}

/** Stand-in for the outline parser: imports, first object type and `property <type> <name>` lines. */
function stubOutline(text: string): QmlComponentOutline {
  const imports: OutlineImport[] = [];
  for (const m of text.matchAll(/^import\s+(?:"([^"]+)"|([\w.]+)\s+([\d.]+))(?:\s+as\s+(\w+))?/gm)) {
    imports.push(m[1] ? { kind: 'dir', target: m[1], as: m[4] } : { kind: 'module', target: m[2], version: m[3], as: m[4] });
  }
  const rootType = /^([A-Z][\w.]*)\s*\{/m.exec(text)?.[1] ?? '';
  const members = [...text.matchAll(/^\s*property\s+(\w+)\s+(\w+)/gm)].map((m) => ({ kind: 'property' as const, name: m[2], type: m[1] }));
  return { rootType, imports, members };
}

const quick = (extra: OutlineImport[] = []): Scope => ({
  imports: [{ kind: 'module', target: 'QtQuick', version: '2.0' }, ...extra],
});
const widgets: OutlineImport = { kind: 'module', target: 'Fixture.Widgets', version: '1.0' };
const silica: OutlineImport = { kind: 'module', target: 'Sailfish.Silica', version: '1.0' };

describe('qml/typeIndex', () => {
  let io: MemoryIO;
  let clock: number;
  let index: TypeIndex;
  beforeEach(() => {
    io = new MemoryIO();
    clock = 0;
    index = new TypeIndex(io, ROOT, { parseComponent: stubOutline, now: () => clock });
  });

  it('loads lazily: nothing is read before a scope asks', async () => {
    assert.strictEqual(io.reads.length, 0);
    await index.resolveType(quick(), 'Item');
    assert.ok(io.reads.some((f) => f.endsWith('QtQuick.2/plugins.qmltypes')));
    assert.ok(!io.reads.some((f) => f.includes('Fixture') || f.includes('Sailfish')));
  });

  it('resolves exports by version and rejects names above the imported version', async () => {
    assert.strictEqual((await index.resolveType(quick(), 'Item'))?.cpp?.name, 'FxItem');
    const t21 = await index.resolveType({ imports: [{ kind: 'module', target: 'QtQuick', version: '2.1' }] }, 'Text');
    assert.strictEqual(t21?.minor, 1);
    assert.strictEqual(await index.resolveType(quick(), 'Nope'), undefined);
    assert.strictEqual(await index.resolveType({ imports: [{ kind: 'module', target: 'QtQuick', version: '1.0' }] }, 'Item'), undefined);
  });

  it('treats QtQuick as importing QtQml, and always loads builtins', async () => {
    assert.strictEqual((await index.resolveType(quick(), 'Timer'))?.module, 'QtQml');
    const text = await index.resolveType(quick(), 'Text');
    assert.ok(text);
    const chain = await index.chainOf(text);
    assert.deepStrictEqual(chain.items.map((t) => t.cpp?.name), ['FxText', 'FxItem', 'QObject']);
    assert.strictEqual(chain.partial, false);
    assert.ok((await index.enumsOf(text)).items.some((e) => e.name === 'Align'));
    assert.ok(io.reads.includes(`${ROOT}/builtins.qmltypes`));
  });

  it('follows qmldir files into QML components and their root types', async () => {
    const knob = await index.resolveType(quick([widgets]), 'Knob');
    assert.ok(knob?.file?.endsWith('Knob.qml'));
    assert.deepStrictEqual((await index.chainOf(knob!)).items.map((t) => t.name), ['Knob', 'Rectangle', 'FxItem', 'QObject']);
    const members = (await index.membersOf(knob!)).items;
    assert.ok(members.some((m) => m.name === 'value' && m.owner === 'Knob'));
    assert.ok(members.some((m) => m.name === 'color' && m.owner === 'Rectangle'));
    assert.ok(members.some((m) => m.name === 'objectName' && m.owner === 'QObject'));
  });

  it('lets the most derived member win and keeps one of each name', async () => {
    const rect = await index.resolveType(quick(), 'Rectangle');
    const names = (await index.membersOf(rect!)).items.filter((m) => m.kind === 'method' && m.name === 'forceActiveFocus');
    assert.strictEqual(names.length, 1);
  });

  it('resolves C++ prototypes across dependencies of the imported module', async () => {
    const label = await index.resolveType({ imports: [silica] }, 'Label');
    const chain = await index.chainOf(label!);
    assert.deepStrictEqual(chain.items.map((t) => t.name), ['Label', 'StandinText', 'FxText', 'FxItem', 'QObject']);
    assert.strictEqual(chain.partial, false);
  });

  it('hides internal entries and honours import qualifiers', async () => {
    assert.strictEqual(await index.resolveType(quick([widgets]), 'Hidden'), undefined);
    const qualified: OutlineImport = { ...widgets, as: 'Fw' };
    const scope = quick([qualified]);
    assert.strictEqual(await index.resolveType(scope, 'Knob'), undefined);
    assert.ok(await index.resolveType(scope, 'Fw.Knob'));
    assert.strictEqual(await index.resolveType(scope, 'Other.Knob'), undefined);
  });

  it('lists singletons from qmldir and type descriptions', async () => {
    const names = (await index.singletonsIn(quick([widgets, silica]))).map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['Palette', 'Palette', 'Theme']);
  });

  it('resolves same-directory and directory-import types', async () => {
    const dir = `${ROOT}/Fixture/Widgets`;
    const scope: Scope = { dir, imports: [...quick().imports, { kind: 'dir', target: 'private' }] };
    assert.ok((await index.resolveType(scope, 'Knob'))?.file?.endsWith('Knob.qml'));
    assert.ok((await index.resolveType(scope, 'Secret'))?.file?.endsWith('private/Secret.qml'));
    assert.strictEqual(await index.resolveType({ imports: quick().imports }, 'Secret'), undefined);
  });

  it('gives a partial chain when a prototype or root type is missing', async () => {
    io.touch(`${ROOT}/Fixture/Widgets/Knob.qml`, 'import QtQuick 2.0\nMissingBase {}\n');
    const knob = await index.resolveType(quick([widgets]), 'Knob');
    const chain = await index.chainOf(knob!);
    assert.deepStrictEqual(chain.items.map((t) => t.name), ['Knob']);
    assert.strictEqual(chain.partial, true);
    assert.strictEqual((await index.membersOf(knob!)).partial, true);
  });

  it('answers a missing module with nothing', async () => {
    assert.strictEqual(await index.resolveType({ imports: [{ kind: 'module', target: 'No.Such', version: '1.0' }] }, 'X'), undefined);
  });

  it('re-stats at most every 10 s and rereads changed files', async () => {
    const scope = quick([widgets]);
    const qmldir = `${ROOT}/Fixture/Widgets/qmldir`;
    await index.resolveType(scope, 'Panel');
    io.touch(qmldir, `${io.files.get(qmldir)!.text}Extra 1.0 Extra.qml\n`);
    clock = 9_999;
    assert.strictEqual(await index.resolveType(scope, 'Extra'), undefined);
    clock = 10_000;
    assert.ok(await index.resolveType(scope, 'Extra'));
  });

  it('does not reread unchanged files after the re-check interval', async () => {
    await index.resolveType(quick(), 'Item');
    const before = io.reads.length;
    clock = 60_000;
    await index.resolveType(quick(), 'Item');
    assert.strictEqual(io.reads.length, before);
  });

  it('reparses a changed component file', async () => {
    const scope = quick([widgets]);
    const knob = await index.resolveType(scope, 'Knob');
    assert.ok((await index.membersOf(knob!)).items.some((m) => m.name === 'value'));
    io.touch(`${ROOT}/Fixture/Widgets/Knob.qml`, 'import QtQuick 2.0\nItem {\n  property int other\n}\n');
    clock = 10_000;
    assert.ok((await index.membersOf(knob!)).items.some((m) => m.name === 'other'));
  });

  it('survives a throwing component parser', async () => {
    const bad = new TypeIndex(io, ROOT, { parseComponent: () => { throw new Error('x'); }, now: () => clock });
    const knob = await bad.resolveType(quick([widgets]), 'Knob');
    assert.deepStrictEqual((await bad.chainOf(knob!)).items.map((t) => t.name), ['Knob']);
  });

  it('breaks root-type cycles', async () => {
    io.touch(`${ROOT}/Fixture/Widgets/Knob.qml`, 'import Fixture.Widgets 1.0\nPanel {}\n');
    io.touch(`${ROOT}/Fixture/Widgets/Panel.qml`, 'import Fixture.Widgets 1.0\nKnob {}\n');
    const knob = await index.resolveType(quick([widgets]), 'Knob');
    const chain = await index.chainOf(knob!);
    assert.strictEqual(chain.partial, true);
    assert.strictEqual(chain.items.length, 2);
  });

  it('lists modules under the root and their versions', async () => {
    const names = (await index.modules()).map((m) => m.name).sort();
    assert.deepStrictEqual(names, ['Fixture.Widgets', 'QtQml', 'QtQuick', 'Sailfish.Silica', 'Sailfish.Silica.private']);
    assert.deepStrictEqual(await index.versionsOf('QtQuick'), ['2.0', '2.1']);
    assert.deepStrictEqual(await index.versionsOf('No.Such'), []);
  });

  it('finds C++ types by C++ name', async () => {
    await index.resolveType(quick(), 'Item');
    assert.strictEqual(index.cppType('FxAnchors')?.cpp?.name, 'FxAnchors');
    assert.strictEqual(index.cppType('Nope'), undefined);
  });
});
