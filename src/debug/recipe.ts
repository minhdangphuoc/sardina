/**
 * Parses `sfdk debug --dry-run` output into what the extension needs to drive a debug
 * session itself: the gdbserver command for the device and GDB's init commands. Letting
 * sfdk compute these keeps sysroot/substitute-path/remote address correct per SDK and
 * target. No `vscode` import so this can be unit-tested directly under plain mocha.
 *
 * Captured from SDK 3.13.5 (stdout):
 *   gdbserver --multi --once :10000
 *   /home/u/SailfishOS/bin/gdb \
 *   	--init-eval-command 'set sysroot …' \
 *   	--init-eval-command 'target extended-remote tcp:192.168.2.16:10000' \
 *   	--init-eval-command 'file /home/u/proj/app' …
 */

import * as path from 'node:path';

export interface DebugRecipe {
  /** argv to run on the device, e.g. ['gdbserver', '--multi', '--once', ':10000']. */
  gdbserver: string[];
  /** Host GDB executable. */
  gdbPath: string;
  /** GDB commands in order, unquoted. */
  initCommands: string[];
  /** The local binary from `file <path>`, which carries the debug symbols. */
  program: string | undefined;
}

export interface IsolatedDebugRecipeOptions {
  sdkRoot: string;
  sysroot: string;
  localProgram: string;
  remoteProgram: string;
  port: number;
}

/**
 * The SDK normally prints this recipe itself. When its shared target hierarchy is malformed by
 * another build, `sfdk debug --dry-run` refuses to do that even though the selected target's
 * sysroot is intact. This equivalent recipe uses Sardina's private loopback SSH tunnel instead of
 * the device's externally reachable address, so debugger preparation no longer has to repair or
 * mutate shared SDK state.
 */
export function isolatedDebugRecipe(options: IsolatedDebugRecipeOptions): DebugRecipe {
  const quote = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`;
  return {
    gdbserver: ['gdbserver', '--multi', '--once', `:${options.port}`],
    gdbPath: path.join(options.sdkRoot, 'bin', process.platform === 'win32' ? 'gdb.exe' : 'gdb'),
    initCommands: [
      `set sysroot ${quote(options.sysroot)}`,
      `set substitute-path /usr/src ${quote(path.join(options.sysroot, 'usr', 'src'))}`,
      `target extended-remote tcp:127.0.0.1:${options.port}`,
      // Unlike `file`, GDB's remote exec-file setting keeps quote characters literally.
      `set remote exec-file ${options.remoteProgram}`,
      `file ${quote(options.localProgram)}`,
      'set args',
    ],
    program: options.localProgram,
  };
}

/** Candidate sysroots in preference order, normalizing accidental `.default.default` nesting. */
export function targetSysrootCandidates(sdkRoot: string, target: string): string[] {
  const root = path.join(sdkRoot, 'mersdk', 'targets');
  const normalized = target.replace(/(?:\.default)+$/, '');
  const names = normalized === target
    ? [`${target}.default`, target]
    : [`${normalized}.default`, target];
  return [...new Set(names)].map((name) => path.join(root, name));
}

/** POSIX-shell word splitting for sfdk's printed command lines: '…', "…", \x and line continuations. */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1];
      i++;
      if (next === '\n' || next === undefined) continue; // line continuation
      current += next;
      inWord = true;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      current += text.slice(i + 1, stop);
      i = stop;
      inWord = true;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) i++;
        current += text[i];
        i++;
      }
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else {
      current += c;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

export function parseDebugRecipe(stdout: string): DebugRecipe | undefined {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  const serverIndex = lines.findIndex((l) => /^\s*gdbserver(\s|$)/.test(l));
  if (serverIndex === -1) return undefined;
  const gdbserver = shellWords(lines[serverIndex]);
  const gdbWords = shellWords(lines.slice(serverIndex + 1).join('\n'));
  const [gdbPath, ...rest] = gdbWords;
  if (!gdbPath) return undefined;

  const initCommands: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--init-eval-command' && i + 1 < rest.length) {
      initCommands.push(rest[++i]);
    }
  }
  if (!initCommands.some((c) => c.startsWith('target '))) return undefined;
  const fileCommand = initCommands.find((c) => c.startsWith('file '));
  return { gdbserver, gdbPath, initCommands, program: fileCommand?.slice('file '.length).trim() };
}
