#!/usr/bin/env node
// Local compatibility repair for the Qt QML 1.16.0 debugger's Qt 5 V8 frames.
// The installed extension is modified only by an explicit invocation of this script.
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const KNOWN_ORIGINAL_SHA256 = 'fcefa3a944828167b5ea87e222a1d88a685496c7047fd056d1c3357b12bd55d6';
const KNOWN_FIRST_REPAIR_SHA256 = 'e6bd74d6e7c8ea186c101fb246bfe26d3c707ad28412932c2863435fcceb9419';
const KNOWN_SECOND_REPAIR_SHA256 = '4a954cce2c52887b60ad3909002b1980c2524027af9ccccc4a87adef1f56a186';
const BACKUP_NAME = 'extension.js.sardina-qt5-original';
const ORIGINAL_RESPONSE = 'let n=new Cs(Cre),s=(await new Promise(f=>{this.runCommand(n,d=>{t.handleResponse(d,f)})})).body,a=new ix.FileFinder;';
const ORIGINAL_FRAME = 'let d=await a.findFile(f.script);if(!d){let p=`Cannot find physical path for: "${f.script}". Use "buildDirs" to set the build directories in "launch.json".`;throw new Error(p)}let g=Ore.default.parse(d);return new qf.StackFrame(f.index,f.func,new qf.Source(g.base,d),f.line+1)';
const ORIGINAL_SCOPES = 'async handleFrame(r,n){let i=n.body,o=[];for(let s of i.scopes){let a=await this.scope(s.index,r);a&&o.push(a)}return o}';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function resolveQt5FrameValue(value, refs) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || !Number.isInteger(value.ref) || !Array.isArray(refs)) return undefined;
  const match = refs.find((candidate) => candidate?.handle === value.ref);
  return typeof match?.name === 'string' ? match.name : undefined;
}

function replaceExactlyOnce(source, original, replacement) {
  const first = source.indexOf(original);
  if (first < 0 || source.indexOf(original, first + original.length) >= 0) {
    throw new Error(`Qt QML bundle layout changed; expected one occurrence of ${original.slice(0, 48)}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + original.length);
}

export function patchQtQmlBundle(source, skipScopes = false) {
  const response = `let n=new Cs(Cre),v=await new Promise(f=>{this.runCommand(n,d=>{t.handleResponse(d,f)})}),s=v.body,j=${resolveQt5FrameValue.toString()},a=new ix.FileFinder;`;
  let patched = replaceExactlyOnce(source, ORIGINAL_RESPONSE, response);
  patched = replaceExactlyOnce(patched, ORIGINAL_FRAME,
    'let x=j(f.script,v.refs),d;if(x){try{d=await a.findFile(x)}catch{}if(!d)try{d=await a.checkProjectFiles(x)}catch{}}let g=d?Ore.default.parse(d):void 0;return new qf.StackFrame(f.index,j(f.func,v.refs)??"<anonymous>",d?new qf.Source(g.base,d):void 0,f.line+1)');
  if (skipScopes) {
    // Qt 5.6's paused-frame scope query appears to terminate this camera app. Keep
    // breakpoints and stack frames while omitting locals until this is diagnosed.
    patched = replaceExactlyOnce(patched, ORIGINAL_SCOPES, 'async handleFrame(r,n){return[]}');
  }
  return patched;
}

export async function applyQtQmlCompatibility(bundlePath, action) {
  const target = resolve(bundlePath);
  if (basename(target) !== 'extension.js' || basename(dirname(target)) !== 'out') {
    throw new Error('Expected an explicit path to Qt QML out/extension.js');
  }
  const manifest = JSON.parse(await readFile(join(dirname(dirname(target)), 'package.json'), 'utf8'));
  if (manifest.publisher !== 'theqtcompany' || manifest.name !== 'qt-qml' || manifest.version !== '1.16.0') {
    throw new Error('This repair supports only theqtcompany.qt-qml 1.16.0');
  }
  const backup = join(dirname(target), BACKUP_NAME);
  const current = await readFile(target);
  const skipScopes = action === '--skip-scopes';
  if (action === '--restore') {
    const original = await readFile(backup);
    if (sha256(original) !== KNOWN_ORIGINAL_SHA256 ||
        ![KNOWN_FIRST_REPAIR_SHA256, KNOWN_SECOND_REPAIR_SHA256,
          sha256(patchQtQmlBundle(original.toString('utf8'), true))].includes(sha256(current))) {
      throw new Error('Refusing to restore: installed bundle or backup differs from the verified repair');
    }
    const temporary = `${target}.sardina-restore-${process.pid}`;
    await writeFile(temporary, original, { mode: (await stat(target)).mode });
    await rename(temporary, target);
    return 'Restored the verified original Qt QML adapter bundle.';
  }
  const savedOriginal = await readFile(backup).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (savedOriginal && sha256(savedOriginal) !== KNOWN_ORIGINAL_SHA256) {
    throw new Error('Existing Qt QML backup differs from the verified original; no changes made');
  }
  const original = savedOriginal ?? current;
  if (sha256(current) !== KNOWN_ORIGINAL_SHA256 && !savedOriginal) {
    throw new Error('Cannot upgrade an existing repair without its verified original backup');
  }
  const allowedHashes = [KNOWN_ORIGINAL_SHA256, KNOWN_FIRST_REPAIR_SHA256, KNOWN_SECOND_REPAIR_SHA256,
    sha256(patchQtQmlBundle(original.toString('utf8'), true))];
  if (!allowedHashes.includes(sha256(current))) {
    throw new Error('Installed Qt QML bundle does not match the verified 1.16.0 build; no changes made');
  }
  const patched = patchQtQmlBundle(original.toString('utf8'), skipScopes);
  if (sha256(current) === sha256(patched)) {
    return 'Qt QML adapter already contains this repair.';
  }
  if (!savedOriginal) {
    await writeFile(backup, current, { flag: 'wx', mode: 0o600 });
  }
  const temporary = `${target}.sardina-repair-${process.pid}`;
  await writeFile(temporary, patched, { mode: (await stat(target)).mode });
  await rename(temporary, target);
  return `Patched Qt QML adapter${skipScopes ? ' with paused-frame scopes disabled' : ''}. Original saved at ${backup}.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , bundlePath, action] = process.argv;
  if (!bundlePath || (action !== undefined && action !== '--restore' && action !== '--skip-scopes')) {
    console.error('Usage: node scripts/qt-qml-1.16-qt5-compat.mjs /absolute/path/to/qt-qml/out/extension.js [--skip-scopes|--restore]');
    process.exitCode = 2;
  } else {
    applyQtQmlCompatibility(bundlePath, action).then(
      (message) => console.log(message),
      (error) => { console.error(error.message); process.exitCode = 1; },
    );
  }
}
