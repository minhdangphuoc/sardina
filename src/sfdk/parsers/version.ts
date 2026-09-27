import type { ParseResult, SemverLike } from '../../core/types';
import { parseSemverLike } from '../version';

/**
 * ParseResult<T> wrapper around parseSemverLike for `sfdk --version` /
 * `<sdkRoot>/sdk-release` content (FR-1.2/FR-16.1).
 */
export function parseVersionOutput(raw: string): ParseResult<SemverLike> {
  const parsed = parseSemverLike(raw);
  if (!parsed) {
    return { ok: false, reason: 'could not extract a MAJOR.MINOR.PATCH version from sfdk output', raw };
  }
  return { ok: true, value: parsed, warnings: [] };
}
