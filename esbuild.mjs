import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, watchFile } from 'node:fs';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
};

/** @type {import('esbuild').BuildOptions} */
const monitorOptions = {
  entryPoints: ['src/monitor/webview/main.ts'],
  bundle: true,
  outfile: 'media/monitor/monitor.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: false,
  minify: false,
};

const cssFrom = 'src/monitor/webview/monitor.css';
const cssTo = 'media/monitor/monitor.css';
function copyCss() {
  mkdirSync('media/monitor', { recursive: true });
  copyFileSync(cssFrom, cssTo);
}

if (watch) {
  const ctx = await esbuild.context(options);
  const monitorCtx = await esbuild.context(monitorOptions);
  copyCss();
  watchFile(cssFrom, { interval: 300 }, copyCss);
  await ctx.watch();
  await monitorCtx.watch();
  console.log('esbuild: watching for changes...');
} else {
  await esbuild.build(options);
  await esbuild.build(monitorOptions);
  copyCss();
  console.log('esbuild: build complete');
}
