import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { allParsers } from '../../src/sfdk/parsers/index';
import type { ParseResult } from '../../src/core/types';

/**
 * Fuzz harness (validation §6.4). For every registered parser, loads every
 * fixture under its `fixtureDir`, applies each mutation N times with a
 * seeded PRNG, and asserts the parser never throws, resolves in < 500ms,
 * and returns a well-shaped ParseResult. With zero parsers registered (the
 * scaffold's default) this suite passes trivially.
 */

const FUZZ_ITER = Number(process.env.FUZZ_ITER ?? 200);
const FUZZ_SEED = Number(process.env.FUZZ_SEED ?? 1337);

// Small, seeded PRNG (mulberry32) so failures are reproducible via FUZZ_SEED.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Mutation = (input: string, rand: () => number) => string;

function randInt(rand: () => number, max: number): number {
  return Math.floor(rand() * max);
}

function toLines(s: string): string[] {
  return s.split('\n');
}

const mutations: { name: string; fn: Mutation }[] = [
  {
    name: 'truncate-random-byte',
    fn: (input, rand) => {
      if (input.length === 0) return input;
      return input.slice(0, randInt(rand, input.length + 1));
    },
  },
  {
    name: 'delete-line',
    fn: (input, rand) => {
      const lines = toLines(input);
      if (lines.length <= 1) return input;
      lines.splice(randInt(rand, lines.length), 1);
      return lines.join('\n');
    },
  },
  {
    name: 'duplicate-line',
    fn: (input, rand) => {
      const lines = toLines(input);
      if (lines.length === 0) return input;
      const idx = randInt(rand, lines.length);
      lines.splice(idx, 0, lines[idx]);
      return lines.join('\n');
    },
  },
  {
    name: 'insert-random-bytes',
    fn: (input, rand) => {
      const bytes: number[] = [];
      const n = 1 + randInt(rand, 8);
      for (let i = 0; i < n; i++) {
        const choice = randInt(rand, 4);
        if (choice === 0) bytes.push(0); // NUL
        else if (choice === 1) bytes.push(13); // \r
        else if (choice === 2) bytes.push(0xff); // invalid UTF-8 lead byte
        else bytes.push(randInt(rand, 256));
      }
      const garbage = Buffer.from(bytes).toString('latin1');
      const pos = randInt(rand, input.length + 1);
      return input.slice(0, pos) + garbage + input.slice(pos);
    },
  },
  {
    name: 'swap-newlines',
    fn: (input, rand) => (rand() < 0.5 ? input.replace(/\n/g, '\r\n') : input.replace(/\r\n/g, '\n')),
  },
  {
    name: 'shuffle-lines',
    fn: (input, rand) => {
      const lines = toLines(input);
      for (let i = lines.length - 1; i > 0; i--) {
        const j = randInt(rand, i + 1);
        [lines[i], lines[j]] = [lines[j], lines[i]];
      }
      return lines.join('\n');
    },
  },
  {
    name: 'whitespace-to-tabs',
    fn: (input) => input.replace(/ {2,}/g, '\t'),
  },
  {
    name: 'prepend-garbage',
    fn: (input, rand) => {
      const bytes = Array.from({ length: 1024 }, () => randInt(rand, 256));
      return Buffer.from(bytes).toString('latin1') + input;
    },
  },
  { name: 'empty-string', fn: () => '' },
  { name: 'single-newline', fn: () => '\n' },
  { name: 'one-mib-of-A', fn: () => 'A'.repeat(1024 * 1024) },
];

function isWellShaped(result: unknown): result is ParseResult<unknown> {
  if (typeof result !== 'object' || result === null) return false;
  const r = result as Record<string, unknown>;
  if (r.ok === true) {
    return 'value' in r && Array.isArray(r.warnings);
  }
  if (r.ok === false) {
    return typeof r.reason === 'string' && typeof r.raw === 'string';
  }
  return false;
}

describe('parsers.fuzz', () => {
  if (allParsers.length === 0) {
    it('no parsers registered yet — passes trivially', () => {
      assert.ok(true);
    });
    return;
  }

  for (const entry of allParsers) {
    describe(entry.name, () => {
      // Compiled to out/test/fuzz/*.js; fixtures live only under the repo's
      // test/fixtures (never compiled/copied into out/).
      const repoRoot = path.resolve(__dirname, '..', '..', '..');
      const fixtureDir = path.resolve(repoRoot, 'test', 'fixtures', 'sfdk', 'parsers', entry.fixtureDir);
      let fixtureFiles: string[] = [];
      try {
        fixtureFiles = fs
          .readdirSync(fixtureDir)
          .filter((f) => f.endsWith('.txt'))
          .map((f) => path.join(fixtureDir, f));
      } catch {
        fixtureFiles = [];
      }

      it(`has fixtures under ${entry.fixtureDir}`, () => {
        assert.ok(fixtureFiles.length > 0, `expected at least one .txt fixture in ${fixtureDir}`);
      });

      for (const file of fixtureFiles) {
        it(`fuzzes ${path.basename(file)} (${FUZZ_ITER} iterations, seed ${FUZZ_SEED})`, function () {
          this.timeout(30000);
          const base = fs.readFileSync(file, 'utf8');
          const rand = mulberry32(FUZZ_SEED ^ hashString(file));

          for (let i = 0; i < FUZZ_ITER; i++) {
            const mutation = mutations[randInt(rand, mutations.length)];
            const mutated = mutation.fn(base, rand);
            const start = Date.now();
            let result: unknown;
            try {
              result = entry.parse(mutated);
            } catch (err) {
              assert.fail(
                `parser "${entry.name}" threw on mutation "${mutation.name}" of ${file} ` +
                  `(seed=${FUZZ_SEED}, iter=${i}): ${err instanceof Error ? err.stack : String(err)}`,
              );
            }
            const elapsed = Date.now() - start;
            assert.ok(
              elapsed < 500,
              `parser "${entry.name}" took ${elapsed}ms on mutation "${mutation.name}" (seed=${FUZZ_SEED}, iter=${i})`,
            );
            assert.ok(
              isWellShaped(result),
              `parser "${entry.name}" returned a malformed ParseResult on mutation "${mutation.name}" ` +
                `(seed=${FUZZ_SEED}, iter=${i}): ${JSON.stringify(result)}`,
            );
          }
        });
      }
    });
  }
});

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
