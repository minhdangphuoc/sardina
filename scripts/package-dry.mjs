#!/usr/bin/env node
// validation §6.7: `vsce package` dry run, no shell interpolation.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vsce = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');

function run(args) {
  return spawnSync(vsce, args, { cwd: root, shell: false, encoding: 'utf8' });
}

console.log('package-dry: running `vsce ls --tree`...');
const ls = run(['ls', '--tree']);
console.log(ls.stdout);
if (ls.stderr) console.error(ls.stderr);
if (ls.status !== 0) {
  console.error(`package-dry: vsce ls exited with status ${ls.status}`);
  process.exit(ls.status ?? 1);
}

const tmp = mkdtempSync(path.join(tmpdir(), 'sardina-vsix-'));
const vsixPath = path.join(tmp, 'sardina.vsix');

let exitCode = 0;
try {
  console.log('package-dry: running `vsce package --no-dependencies`...');
  const pkg = run(['package', '--no-dependencies', '--out', vsixPath]);
  const lines = (pkg.stdout + '\n' + pkg.stderr).split('\n');
  if (pkg.status !== 0) {
    console.error(lines.join('\n'));
    console.error(`package-dry: vsce package exited with status ${pkg.status}`);
    exitCode = pkg.status ?? 1;
  } else {
    console.log(lines.slice(-20).join('\n'));

    if (!existsSync(vsixPath)) {
      console.error(`package-dry: expected VSIX not found at ${vsixPath}`);
      exitCode = 1;
    } else {
      const size = statSync(vsixPath).size;
      if (size === 0) {
        console.error('package-dry: VSIX is empty');
        exitCode = 1;
      } else if (size > 2 * 1024 * 1024) {
        console.error(`package-dry: VSIX is ${size} bytes, exceeds the 2 MB budget`);
        exitCode = 1;
      } else {
        console.log(`package-dry: VSIX size OK (${size} bytes)`);
      }

      const unzip = spawnSync('unzip', ['-l', vsixPath], { shell: false, encoding: 'utf8' });
      if (unzip.status !== 0) {
        console.error('package-dry: failed to list VSIX contents with unzip');
        console.error(unzip.stderr);
        exitCode = 1;
      } else {
        const disallowed = ['test/', 'src/', '.map', '.qmltypes', 'qmldir', '.env'];
        const offending = unzip.stdout
          .split('\n')
          .filter((line) => disallowed.some((pattern) => line.includes(pattern)));
        if (offending.length > 0) {
          console.error('package-dry: VSIX contains disallowed entries:');
          console.error(offending.join('\n'));
          exitCode = 1;
        } else {
          console.log('package-dry: VSIX contents OK');
        }
      }
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(exitCode);
