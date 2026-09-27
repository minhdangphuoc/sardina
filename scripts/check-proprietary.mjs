#!/usr/bin/env node
// NFR-15 / validation §6.5: no proprietary SDK-derived data in the repo.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const problems = [];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

// 1. No .qmltypes/qmldir file outside test/fixtures/qmltypes/.
const allFiles = walk(root);
const allowedQmltypesDir = path.join(root, 'test', 'fixtures', 'qmltypes');
for (const file of allFiles) {
  if (path.basename(file) === 'qmldir' || file.endsWith('.qmltypes')) {
    if (!file.startsWith(allowedQmltypesDir)) {
      problems.push(`disallowed qmltypes/qmldir file outside test/fixtures/qmltypes/: ${path.relative(root, file)}`);
    }
  }
}

// 2. src/, snippets/, data/, media/, dist/ must not contain the two banned strings.
const BANNED = ['Copyright (C) Jolla', 'import QtQuick.tooling'];
const scanDirs = ['src', 'snippets', 'data', 'media', 'dist'].map((d) => path.join(root, d));
for (const dir of scanDirs) {
  if (!existsSync(dir)) continue;
  for (const file of walk(dir)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const banned of BANNED) {
      if (text.includes(banned)) {
        const lineNo = text.slice(0, text.indexOf(banned)).split('\n').length;
        problems.push(`${path.relative(root, file)}:${lineNo}: contains banned string "${banned}"`);
      }
    }
  }
}

// 3. src/** or dist/** must not contain a definition-shaped structure (object with
//    properties/signals/methods/enums keys) nested under a denylist Silica type name.
//    Bare names in snippets/silica.code-snippets (and its dist copy) are allowed.
const DENYLIST_TYPES = [
  'SilicaFlickable',
  'SilicaListView',
  'PageHeader',
  'PullDownMenu',
  'PushUpMenu',
  'Theme',
  'ApplicationWindow',
];
const DEFINITION_SHAPE_KEYS = ['properties', 'signals', 'methods', 'enums'];
const codeDirs = ['src', 'dist'].map((d) => path.join(root, d));
for (const dir of codeDirs) {
  if (!existsSync(dir)) continue;
  for (const file of walk(dir)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const typeName of DENYLIST_TYPES) {
      const typeIdx = text.indexOf(typeName);
      if (typeIdx === -1) continue;
      const window = text.slice(typeIdx, typeIdx + 2000);
      if (DEFINITION_SHAPE_KEYS.some((k) => window.includes(`"${k}"`) || window.includes(`${k}:`))) {
        const lineNo = text.slice(0, typeIdx).split('\n').length;
        problems.push(
          `${path.relative(root, file)}:${lineNo}: possible proprietary definition shape near "${typeName}"`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`check-proprietary: ${problems.length} problem(s) found:\n`);
  for (const p of problems) {
    console.error(` - ${p}`);
  }
  process.exit(1);
} else {
  console.log('check-proprietary: OK');
}
