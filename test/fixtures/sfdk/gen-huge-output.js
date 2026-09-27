#!/usr/bin/env node
'use strict';
/*
 * Generates the `huge-output` scenario's build.stdout (200k short lines,
 * kept well under 5MB so it is checked in directly rather than gitignored /
 * regenerated in a pretest step; see CONVENTIONS.md / validation §1.5).
 * Run manually if the file needs regenerating: `node gen-huge-output.js`.
 */
const fs = require('fs');
const path = require('path');

const outPath = path.join(__dirname, 'scenarios', 'huge-output', 'build.stdout');
const N = 200000;
const chunks = [];
for (let i = 1; i <= N; i++) {
  chunks.push(`cc f${i}`);
}
chunks.push(`Wrote: /home/mersdk/share/qml-app/RPMS/aarch64/harbour-demo-0.1-1.aarch64.rpm`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, chunks.join('\n') + '\n', 'utf8');
// eslint-disable-next-line no-console
console.log(`wrote ${outPath} (${fs.statSync(outPath).size} bytes, ${N + 1} lines)`);
