import type { SemverLike } from '../core/types';

/** Extracts the first `MAJOR.MINOR.PATCH`-shaped substring from arbitrary sfdk output. */
const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;

export function parseSemverLike(text: string): SemverLike | undefined {
  const match = VERSION_RE.exec(text);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: match[0],
  };
}

/** Returns -1, 0 or 1 as `a` is less than, equal to, or greater than `b`. */
export function compareSemverLike(a: SemverLike, b: SemverLike): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}
