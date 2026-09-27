import type { ParseResult } from '../core/types';

/** One entry of `sfdk init -l|--list-types` output. */
export interface InitTemplateType {
  type: string;
  description: string;
}

/** Parses `sfdk init -l` output (FR-16.5); registered in allParsers. */
// Identifier-shaped token (`qtquick2app`, `cpp-qmake`); anything else is unparsed.
const TYPE_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

export function parseInitList(raw: string): ParseResult<InitTemplateType[]> {
  const lines = raw.split(/\r?\n/);
  const warnings: string[] = [];
  const value: InitTemplateType[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const match = /^(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match || !TYPE_RE.test(match[1])) {
      warnings.push(`unparsed init-list line: ${JSON.stringify(rawLine)}`);
      continue;
    }
    const [, type, description] = match;
    value.push({ type, description: (description ?? '').trim() });
  }

  const hadNonBlankInput = lines.some((l) => l.trim().length > 0);
  if (value.length === 0 && hadNonBlankInput) {
    return { ok: false, reason: 'could not parse any template type from sfdk init -l output', raw };
  }

  return { ok: true, value, warnings };
}
