import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { patchQtQmlBundle, resolveQt5FrameValue } from './qt-qml-1.16-qt5-compat.mjs';

test('Qt 5 V8 backtrace references resolve to their script and function names', () => {
  const refs = [
    { handle: 41, type: 'function', name: 'onClicked' },
    { handle: 42, type: 'script', name: 'qrc:/pages/SettingsPage.qml' },
  ];
  assert.equal(resolveQt5FrameValue({ ref: 42 }, refs), 'qrc:/pages/SettingsPage.qml');
  assert.equal(resolveQt5FrameValue({ ref: 41 }, refs), 'onClicked');
  assert.equal(resolveQt5FrameValue('file:///pages/SettingsPage.qml', refs), 'file:///pages/SettingsPage.qml');
  assert.equal(resolveQt5FrameValue({ ref: 99 }, refs), undefined);
  assert.equal(resolveQt5FrameValue({ ref: 42 }, [{ handle: 42, name: {} }]), undefined);
});

test('repair resolves Qt 5 refs and preserves frames without physical source files', () => {
  const original = 'let n=new Cs(Cre),s=(await new Promise(f=>{this.runCommand(n,d=>{t.handleResponse(d,f)})})).body,a=new ix.FileFinder;'
    + 's.frames.map(async f=>{let d=await a.findFile(f.script);if(!d){let p=`Cannot find physical path for: "${f.script}". Use "buildDirs" to set the build directories in "launch.json".`;throw new Error(p)}let g=Ore.default.parse(d);return new qf.StackFrame(f.index,f.func,new qf.Source(g.base,d),f.line+1)})';
  const patched = patchQtQmlBundle(original);
  assert.match(patched, /j\(f\.script,v\.refs\)/);
  assert.match(patched, /j\(f\.func,v\.refs\)/);
  assert.match(patched, /a\.checkProjectFiles\(x\)/);
  assert.match(patched, /d\?new qf\.Source\(g\.base,d\):void 0/);
  assert.doesNotMatch(patched, /throw new Error\(p\)/);
  assert.throws(() => patchQtQmlBundle(patched), /layout changed/);
  assert.doesNotThrow(() => new Script(`async function backtrace(r){${patched};}`));
});

test('optional scope workaround omits Qt 5 paused-frame scope queries', () => {
  const original = 'let n=new Cs(Cre),s=(await new Promise(f=>{this.runCommand(n,d=>{t.handleResponse(d,f)})})).body,a=new ix.FileFinder;'
    + 'let d=await a.findFile(f.script);if(!d){let p=`Cannot find physical path for: "${f.script}". Use "buildDirs" to set the build directories in "launch.json".`;throw new Error(p)}let g=Ore.default.parse(d);return new qf.StackFrame(f.index,f.func,new qf.Source(g.base,d),f.line+1)'
    + 'async handleFrame(r,n){let i=n.body,o=[];for(let s of i.scopes){let a=await this.scope(s.index,r);a&&o.push(a)}return o}';
  const patched = patchQtQmlBundle(original, true);
  assert.match(patched, /async handleFrame\(r,n\)\{return\[\]\}/);
  assert.doesNotMatch(patched, /await this\.scope\(s\.index,r\)/);
  assert.match(patchQtQmlBundle(original), /await this\.scope\(s\.index,r\)/);
});

test('installed 1.16.0 bundle contains exactly the expected repair sites when available', async (context) => {
  const path = process.env.QT_QML_BUNDLE_FOR_TEST;
  if (!path) return context.skip('set QT_QML_BUNDLE_FOR_TEST to verify the installed bundle');
  const source = await readFile(path, 'utf8');
  assert.doesNotThrow(() => new Script(patchQtQmlBundle(source)));
  assert.doesNotThrow(() => new Script(patchQtQmlBundle(source, true)));
});
