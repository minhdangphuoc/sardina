#!/usr/bin/env node
// Structural validation of package.json against the source tree (validation §6.6).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const problems = [];

function walk(dir, exts, out = []) {
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
      walk(full, exts, out);
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const srcFiles = walk(path.join(root, 'src'), ['.ts']);
const srcText = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

// 1. Required top-level fields.
for (const field of ['name', 'displayName', 'publisher', 'version', 'license', 'engines', 'main', 'categories']) {
  if (!(field in pkg)) {
    problems.push(`missing top-level field: ${field}`);
  }
}

// 2. engines.vscode matches @types/vscode major.minor.
const enginesVscode = pkg.engines?.vscode ?? '';
const typesVscode = pkg.devDependencies?.['@types/vscode'] ?? '';
const engineMM = /(\d+)\.(\d+)/.exec(enginesVscode);
const typesMM = /(\d+)\.(\d+)/.exec(typesVscode);
if (!engineMM || !typesMM || engineMM[1] !== typesMM[1] || engineMM[2] !== typesMM[2]) {
  problems.push(
    `engines.vscode (${enginesVscode}) major.minor does not match @types/vscode (${typesVscode})`,
  );
}

// 3. activationEvents has no wildcard.
for (const ev of pkg.activationEvents ?? []) {
  if (ev === '*') {
    problems.push('activationEvents contains "*"');
  }
}

// 4. contributes.commands[].command <-> registerCommand('<id>' in src/**, both directions.
const declaredCommands = new Set((pkg.contributes?.commands ?? []).map((c) => c.command));
const registerRe = /registerCommand\(\s*['"]([^'"]+)['"]/g;
const registeredCommands = new Set();
let m;
while ((m = registerRe.exec(srcText))) {
  registeredCommands.add(m[1]);
}
for (const cmd of declaredCommands) {
  if (!registeredCommands.has(cmd)) {
    problems.push(`command declared in package.json but not registered in src/**: ${cmd}`);
  }
}
for (const cmd of registeredCommands) {
  if (cmd.startsWith('sardina._test.')) continue;
  if (!declaredCommands.has(cmd)) {
    problems.push(`command registered in src/** but not declared in package.json: ${cmd}`);
  }
}

// 5. Every configuration key starts with sardina. and is read in src/** (get('<suffix>' or a constants table entry).
const configProps = pkg.contributes?.configuration?.properties ?? {};
for (const key of Object.keys(configProps)) {
  if (!key.startsWith('sardina.')) {
    problems.push(`configuration key does not start with "sardina.": ${key}`);
    continue;
  }
  const suffix = key.slice('sardina.'.length);
  if (!srcText.includes(suffix)) {
    problems.push(`configuration key not read anywhere in src/**: ${key} (expected literal "${suffix}")`);
  }
}

// 6. extensionDependencies has no debug extension ids.
const DEBUG_EXTENSION_MARKERS = ['debug', 'ms-vscode.cpptools'];
for (const dep of pkg.extensionDependencies ?? []) {
  if (DEBUG_EXTENSION_MARKERS.some((marker) => dep.toLowerCase().includes(marker))) {
    problems.push(`extensionDependencies contains a debug extension id: ${dep}`);
  }
}

// 7. taskDefinitions/problemMatchers reference only declared ids (no cross-references needed structurally, but sanity-check shape).
for (const td of pkg.contributes?.taskDefinitions ?? []) {
  if (!td.type || !td.required || !td.properties) {
    problems.push(`taskDefinition missing type/required/properties: ${JSON.stringify(td)}`);
  }
}

// 8. views/menus reference only declared view ids.
const declaredViewIds = new Set();
for (const views of Object.values(pkg.contributes?.views ?? {})) {
  for (const v of views) declaredViewIds.add(v.id);
}
const viewsContainerIds = new Set((pkg.contributes?.viewsContainers?.activitybar ?? []).map((c) => c.id));
for (const [menuKey, entries] of Object.entries(pkg.contributes?.menus ?? {})) {
  for (const entry of entries) {
    if (!declaredCommands.has(entry.command)) {
      problems.push(`menu "${menuKey}" references undeclared command: ${entry.command}`);
    }
    const whenViewMatch = /view == ([\w.]+)/.exec(entry.when ?? '');
    if (whenViewMatch && !declaredViewIds.has(whenViewMatch[1])) {
      problems.push(`menu "${menuKey}" references undeclared view id: ${whenViewMatch[1]}`);
    }
  }
}
for (const view of declaredViewIds) {
  // views map key must correspond to a views container id (activitybar or built-in containers).
  void view;
}
if (pkg.contributes?.views) {
  for (const containerKey of Object.keys(pkg.contributes.views)) {
    const builtIn = ['explorer', 'debug', 'scm', 'test'];
    if (!viewsContainerIds.has(containerKey) && !builtIn.includes(containerKey)) {
      problems.push(`views container key not declared in viewsContainers: ${containerKey}`);
    }
  }
}

// 9. The Device Monitor page bundle must exist once the extension has been built (dist/ present).
if (existsSync(path.join(root, 'dist', 'extension.js'))) {
  for (const f of ['media/monitor/monitor.js', 'media/monitor/monitor.css']) {
    if (!existsSync(path.join(root, f))) {
      problems.push(`monitor page bundle missing after build: ${f}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-manifest: ${problems.length} problem(s) found:\n`);
  for (const p of problems) {
    console.error(` - ${p}`);
  }
  process.exit(1);
} else {
  console.log('check-manifest: OK');
}
