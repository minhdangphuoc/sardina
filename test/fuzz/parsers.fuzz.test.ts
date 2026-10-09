import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { allParsers } from '../../src/sfdk/parsers/index';
import type { ParseResult } from '../../src/core/types';
import { formatEntryLine, parseJournalJsonLine, parseShortPreciseLine } from '../../src/monitor/logModel';
import { parseAppStatsOutput, parseProcStat, parseStatsStreamLine } from '../../src/monitor/appStats';
import { validatePageMessage } from '../../src/monitor/protocol';
import { parseQmlOutline } from '../../src/qml/qmlOutline';
import { classifyConnection, parseIpAddrOutput, parseOsRelease } from '../../src/monitor/overview';

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

/**
 * Device Monitor parsers (PLAN-device-monitor §9.1). They are not sfdk parsers and have no
 * fixtures files: each gets inline seed samples, mutated like the sfdk parsers, and must never
 * throw or take 500 ms.
 */
const monitorSeeds: Record<string, string[]> = {
  json: [
    '{"__REALTIME_TIMESTAMP":"1733500000123456","MESSAGE":"qml: hi\\nat foo (file:///usr/share/a/x.qml:3:4)","PRIORITY":"4","_PID":"12","SYSLOG_IDENTIFIER":"a","__CURSOR":"s=1;i=2"}',
    '{"__REALTIME_TIMESTAMP":"1","MESSAGE":[104,105,255],"COREDUMP_SIGNAL":"11"}',
    '{"ok":false,"error":"stopped from the phone"}',
  ],
  text: ['Oct 05 13:42:01.123456 host harbour-demo[4321]: qml: hello', 'Oct  5 13:42:01 host kernel: usb 1-1: new device'],
  stat: [
    '4321 (my (app)) S 1 2 3 4 5 6 7 8 9 10 120 30 0 0 20 0 9 0 1000 123456 789 18446744073709551615',
    'pid 4321\n4321 (a) S 1 2 3 4 5 6 7 8 9 10 1 2 0 0 20 0 3 0 100 1 2 3\n--\nVmRSS:\t10 kB\nThreads:\t3\n--\n100.5 200.1\ncpu  1 2 3 4 5 6 7 8\n',
    'pid 0\ncpu  1 2 3 4 5 6 7 8\n',
  ],
  stream: ['{"ts":1733500000123,"pid":4321,"state":"S","cpu":12.4,"rssKb":48216,"started":1733499990000,"sys":{"cpu":31}}', '{"event":"exit","pid":4321,"ts":5}'],
  os: ['NAME="Sailfish OS"\nVERSION_ID=5.0.0.62\nPRETTY_NAME="Sailfish OS 5.0.0.62"\nSAILFISH_FLAVOUR=release\n'],
  page: [
    '{"type":"resume","what":"all"}',
    '{"type":"ui.visible","on":true}',
  ],
  qml: [
    'import QtQuick 2.0\nimport "../lib" as L\nItem {\n  id: root\n  property int a: 1\n  signal s(int x)\n  function f(p) { return `${p}}` + "}" }\n  width: /[}]/.test(a) ? 1 : 2\n  Rectangle { anchors.fill: parent; Behavior on x { NumberAnimation {} } }\n}\n',
  ],
  net: ['192.168.2.1 51234 192.168.2.15 22\n5: rndis0    inet 192.168.2.15/24 brd 192.168.2.255 scope global rndis0\n7: wlan0    inet 10.0.2.15/24 scope global wlan0'],
};

const monitorTargets: { name: string; seeds: string[]; run: (input: string) => unknown }[] = [
  { name: 'parseJournalJsonLine', seeds: monitorSeeds.json, run: (s) => parseJournalJsonLine(s, 0) },
  { name: 'parseShortPreciseLine', seeds: monitorSeeds.text, run: (s) => parseShortPreciseLine(s, 0) },
  { name: 'formatEntryLine', seeds: monitorSeeds.json, run: (s) => formatEntryLine(parseJournalJsonLine(s, 0)) },
  { name: 'parseProcStat', seeds: monitorSeeds.stat, run: (s) => parseProcStat(s) },
  { name: 'parseAppStatsOutput', seeds: monitorSeeds.stat, run: (s) => parseAppStatsOutput(s, 0) },
  { name: 'parseStatsStreamLine', seeds: monitorSeeds.stream, run: (s) => parseStatsStreamLine(s, 0) },
  {
    name: 'validatePageMessage',
    seeds: monitorSeeds.page,
    run: (s) => {
      let raw: unknown;
      try {
        raw = JSON.parse(s);
      } catch {
        raw = s;
      }
      return validatePageMessage(raw);
    },
  },
  { name: 'parseQmlOutline', seeds: monitorSeeds.qml, run: (s) => parseQmlOutline(s) },
  { name: 'parseOsRelease', seeds: monitorSeeds.os, run: (s) => parseOsRelease(s) },
  { name: 'classifyConnection', seeds: monitorSeeds.net, run: (s) => classifyConnection(s.split('\n')[0], s) && parseIpAddrOutput(s) },
];

describe('monitor parsers fuzz', () => {
  for (const target of monitorTargets) {
    it(`fuzzes ${target.name} (${FUZZ_ITER} iterations per seed, seed ${FUZZ_SEED})`, function () {
      this.timeout(60000);
      const rand = mulberry32(FUZZ_SEED ^ hashString(target.name));
      for (const base of target.seeds) {
        for (let i = 0; i < FUZZ_ITER; i++) {
          const mutation = mutations[randInt(rand, mutations.length)];
          const mutated = mutation.fn(base, rand);
          const start = Date.now();
          try {
            target.run(mutated);
          } catch (err) {
            assert.fail(
              `${target.name} threw on mutation "${mutation.name}" (seed=${FUZZ_SEED}, iter=${i}): ${err instanceof Error ? err.stack : String(err)}`,
            );
          }
          const elapsed = Date.now() - start;
          assert.ok(elapsed < 500, `${target.name} took ${elapsed}ms on mutation "${mutation.name}" (seed=${FUZZ_SEED}, iter=${i})`);
        }
      }
    });
  }
});
