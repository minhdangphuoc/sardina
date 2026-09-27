import type { ParseResult, TargetDescriptor } from '../core/types';

const ARCH_RE = /-(armv7hl|aarch64|i486)$/;
const VERSION_RE = /-(\d+(?:\.\d+){1,3})-/;
const LINE_RE = /^(\S+)\s+(.+)$/;

/**
 * Pure parsing for `sfdk tools target list` output (FR-16.3/FR-4.2). No
 * `vscode` import so this can be unit-tested directly under plain mocha.
 * Interim local implementation: see the note in ../wizard/parseInitList.ts —
 * this matches the FR-16.1 `ParseResult<T>` contract Task A's eventual
 * canonical `allParsers` entry uses.
 */
export function parseTargetList(raw: string): ParseResult<TargetDescriptor[]> {
  const lines = raw.split(/\r?\n/);
  const warnings: string[] = [];
  const value: TargetDescriptor[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const match = LINE_RE.exec(line);
    if (!match) {
      warnings.push(`unparsed target-list line: ${JSON.stringify(rawLine)}`);
      continue;
    }
    const [, name, flagsRaw] = match;
    const flags = flagsRaw
      .trim()
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const archMatch = ARCH_RE.exec(name);
    const versionMatch = VERSION_RE.exec(name);
    value.push({
      name,
      tooling: '',
      arch: archMatch ? (archMatch[1] as TargetDescriptor['arch']) : 'unknown',
      version: versionMatch?.[1],
      flags,
      isSnapshot: flags.includes('snapshot'),
      isDefault: flags.includes('default'),
    });
  }

  const hadNonBlankInput = lines.some((l) => l.trim().length > 0);
  if (value.length === 0 && hadNonBlankInput) {
    return { ok: false, reason: 'could not parse any target from sfdk tools target list output', raw };
  }

  return { ok: true, value, warnings };
}
