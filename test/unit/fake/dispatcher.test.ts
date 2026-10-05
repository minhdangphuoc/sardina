import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

interface FakeLogEntry {
  bin: string;
  argv: string[];
  cwd: string;
  scenario: string;
  key: string;
}

// Plain Node modules (no vscode dependency), required by absolute path since
// this file is compiled to out/test/unit/fake/*.js (tsc's rootDir mirrors
// the source tree) while the fixtures themselves are plain JS that is never
// compiled/copied into out/ — they live only under the repo's test/fixtures.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURES_BIN = path.resolve(REPO_ROOT, 'test', 'fixtures', 'bin');
const FIXTURES_SFDK = path.resolve(REPO_ROOT, 'test', 'fixtures', 'sfdk');
const FAKE_SFDK_JS = path.join(FIXTURES_BIN, 'sfdk.js');
const FAKE_CORE_JS = path.join(FIXTURES_BIN, '_fake-core.js');

// eslint-disable-next-line @typescript-eslint/no-require-imports -- test fixtures are plain JS, not compiled TS
const sfdk = require(FAKE_SFDK_JS) as {
  keyFn: (argv: string[]) => string;
  computeInitName: (strippedArgv: string[]) => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- test fixtures are plain JS, not compiled TS
const core = require(FAKE_CORE_JS) as {
  stripGlobalOptions: (argv: string[]) => string[];
  candidateKeys: (key: string) => string[];
};

describe('fake sfdk: keyFn', () => {
  it('--version anywhere -> version', () => {
    assert.strictEqual(sfdk.keyFn(['--version']), 'version');
    assert.strictEqual(sfdk.keyFn(['build', '--version']), 'version');
  });

  it('init -l / --list-types -> init_list', () => {
    assert.strictEqual(sfdk.keyFn(['init', '-l']), 'init_list');
    assert.strictEqual(sfdk.keyFn(['init', '--list-types']), 'init_list');
  });

  it('init otherwise -> init_template', () => {
    assert.strictEqual(sfdk.keyFn(['init', 'harbour-demo']), 'init_template');
  });

  it('config --show -> config_show', () => {
    assert.strictEqual(sfdk.keyFn(['config', '--show']), 'config_show');
  });

  it('config --global ... -> config_set_global', () => {
    assert.strictEqual(sfdk.keyFn(['config', '--global', 'target=X']), 'config_set_global');
  });

  it('config ... -> config_set', () => {
    assert.strictEqual(sfdk.keyFn(['config', 'target=X']), 'config_set');
  });

  it('tools target list -> tools_target_list (M1.10: checked before the family rule)', () => {
    assert.strictEqual(sfdk.keyFn(['tools', 'target', 'list']), 'tools_target_list');
  });

  it('tools list -> tools_list (distinct from tools target list)', () => {
    assert.strictEqual(sfdk.keyFn(['tools', 'list']), 'tools_list');
    assert.notStrictEqual(sfdk.keyFn(['tools', 'list']), sfdk.keyFn(['tools', 'target', 'list']));
  });

  it('device exec [name] -- <cmd...> -> device_exec.<basename>', () => {
    assert.strictEqual(sfdk.keyFn(['device', 'exec', '--', 'pkill', 'harbour-demo']), 'device_exec.pkill');
    assert.strictEqual(
      sfdk.keyFn(['device', 'exec', 'MyDevice', '--', '/usr/bin/invoker', '-o']),
      'device_exec.invoker',
    );
  });

  it('device exec -- <cmd> --request <req> -> device_exec.<basename>.<req>', () => {
    assert.strictEqual(
      sfdk.keyFn(['device', 'exec', 'X', '--', 'sailfish-devagent', '--request', 'ping']),
      'device_exec.sailfish-devagent.ping',
    );
    assert.strictEqual(
      sfdk.keyFn(['device', 'exec', '--', '/usr/bin/sailfish-devagent', '--request', 'logs']),
      'device_exec.sailfish-devagent.logs',
    );
    // --request with nothing after it, or not directly after the command: no request level.
    assert.strictEqual(
      sfdk.keyFn(['device', 'exec', '--', 'sailfish-devagent', '--request']),
      'device_exec.sailfish-devagent',
    );
    assert.strictEqual(
      sfdk.keyFn(['device', 'exec', '--', 'sailfish-devagent', '--status']),
      'device_exec.sailfish-devagent',
    );
  });

  it('candidateKeys returns every dotted prefix, longest first', () => {
    assert.deepStrictEqual(core.candidateKeys('a.b.c'), ['a.b.c', 'a.b', 'a']);
    assert.deepStrictEqual(core.candidateKeys('device_exec.pkill'), ['device_exec.pkill', 'device_exec']);
    assert.deepStrictEqual(core.candidateKeys('version'), ['version']);
  });

  it('device exec with no -- falls back to device_exec', () => {
    assert.strictEqual(sfdk.keyFn(['device', 'exec']), 'device_exec');
    assert.strictEqual(sfdk.keyFn(['device', 'exec', 'MyDevice']), 'device_exec');
  });

  it('engine exec -- <cmd> -> engine_exec.<cmd> (dotted)', () => {
    assert.strictEqual(sfdk.keyFn(['engine', 'exec', '--', 'pwd']), 'engine_exec.pwd');
  });

  it('engine exec with no -- falls back to engine_exec', () => {
    assert.strictEqual(sfdk.keyFn(['engine', 'exec']), 'engine_exec');
  });

  it('emulator show <name> -> emulator_show', () => {
    assert.strictEqual(sfdk.keyFn(['emulator', 'show', 'Sailfish OS Emulator 4.4.0.58']), 'emulator_show');
  });

  it('other tools|emulator|device|engine <sub> -> <a>_<b>', () => {
    assert.strictEqual(sfdk.keyFn(['emulator', 'list']), 'emulator_list');
    assert.strictEqual(sfdk.keyFn(['device', 'list']), 'device_list');
    assert.strictEqual(sfdk.keyFn(['engine', 'status']), 'engine_status');
    assert.strictEqual(sfdk.keyFn(['emulator', 'start']), 'emulator_start');
  });

  it('build|deploy|qmake|make|package|check|build-shell -> that word', () => {
    for (const w of ['build', 'deploy', 'qmake', 'make', 'package', 'check', 'build-shell']) {
      assert.strictEqual(sfdk.keyFn([w]), w);
    }
  });

  it('anything else -> unknown', () => {
    assert.strictEqual(sfdk.keyFn(['frobnicate']), 'unknown');
    assert.strictEqual(sfdk.keyFn([]), 'unknown');
  });
});

describe('fake sfdk: computeInitName (FAKE-INIT)', () => {
  it('skips the value of -t/-b and uses the last positional (TRD AC-1.3 argv)', () => {
    assert.strictEqual(
      sfdk.computeInitName(['init', '-t', 'qtquick2app', '-b', 'qmake', 'harbour-demo']),
      'harbour-demo',
    );
  });

  it('skips the value of --type/--builder', () => {
    assert.strictEqual(
      sfdk.computeInitName(['init', '--type', 'qtquick2app', '--builder', 'qmake', 'harbour-demo']),
      'harbour-demo',
    );
  });

  it('falls back to "app" when no positional name is given', () => {
    assert.strictEqual(sfdk.computeInitName(['init', '-t', 'qtquick2app']), 'app');
  });

  it('uses the only positional when there are no options', () => {
    assert.strictEqual(sfdk.computeInitName(['init', 'harbour-demo']), 'harbour-demo');
  });
});

describe('fake sfdk: stripGlobalOptions', () => {
  it('resolves -c target=X -c device=Y to the same argv as no globals', () => {
    const withGlobals = core.stripGlobalOptions([
      '--no-pager',
      '-c',
      'target=X',
      '-c',
      'device=Y',
      'build',
      '--no-check',
    ]);
    const bare = core.stripGlobalOptions(['build', '--no-check']);
    assert.deepStrictEqual(withGlobals, bare);
    assert.deepStrictEqual(withGlobals, ['build', '--no-check']);
  });

  it('strips --quiet / -q', () => {
    assert.deepStrictEqual(core.stripGlobalOptions(['--quiet', 'build']), ['build']);
    assert.deepStrictEqual(core.stripGlobalOptions(['-q', 'build']), ['build']);
  });

  it('strips --config <value>', () => {
    assert.deepStrictEqual(core.stripGlobalOptions(['--config', 'target=X', 'build']), ['build']);
  });

  it('leaves an argv with no global options untouched', () => {
    assert.deepStrictEqual(core.stripGlobalOptions(['tools', 'target', 'list']), ['tools', 'target', 'list']);
  });
});

describe('fake sfdk: aliases (resolveScenarioAlias)', () => {
  it('happy -> default, build-error -> build-fails-compile, old-format -> tools-list-odd-glyphs', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- test fixtures are plain JS
    const c = require(FAKE_CORE_JS) as { resolveScenarioAlias: (s: string) => string };
    assert.strictEqual(c.resolveScenarioAlias('happy'), 'default');
    assert.strictEqual(c.resolveScenarioAlias('build-error'), 'build-fails-compile');
    assert.strictEqual(c.resolveScenarioAlias('old-format'), 'tools-list-odd-glyphs');
    assert.strictEqual(c.resolveScenarioAlias('no-targets'), 'no-targets');
  });
});

function runFake(
  argv: string[],
  env: Record<string, string | undefined>,
  cwd?: string,
): { stdout: string; stderr: string; status: number | null } {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
  }
  const result = spawnSync(process.execPath, [FAKE_SFDK_JS, ...argv], {
    env: merged,
    cwd,
    encoding: 'utf8',
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe('fake sfdk: spawned process behaviour', () => {
  it('logs a JSON invocation line to SFDK_FAKE_LOG', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfdk-fake-log-'));
    const logPath = path.join(tmp, 'log.jsonl');
    const res = runFake(['tools', 'target', 'list'], { SFDK_FAKE_LOG: logPath, SFDK_FAKE_SCENARIO: 'default' });
    assert.strictEqual(res.status, 0);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const entry = JSON.parse(lines[0]) as FakeLogEntry;
    assert.strictEqual(entry.bin, 'sfdk');
    assert.deepStrictEqual(entry.argv, ['tools', 'target', 'list']);
    assert.strictEqual(entry.key, 'tools_target_list');
    assert.strictEqual(entry.scenario, 'default');
  });

  it('exits 2 and appends to unrecorded.log for an unknown key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfdk-fake-log-'));
    const logPath = path.join(tmp, 'log.jsonl');
    const unrecordedPath = path.join(FIXTURES_SFDK, 'unrecorded.log');
    const before = fs.existsSync(unrecordedPath) ? fs.readFileSync(unrecordedPath, 'utf8') : '';

    const res = runFake(['this-is-not-a-real-subcommand'], {
      SFDK_FAKE_LOG: logPath,
      SFDK_FAKE_SCENARIO: 'default',
    });

    assert.strictEqual(res.status, 2);
    assert.match(res.stderr, /unrecognized command \(fake key "unknown", scenario "default"\)/);

    const after = fs.readFileSync(unrecordedPath, 'utf8');
    assert.ok(after.length > before.length, 'unrecorded.log should have grown');
    const newLines = after.slice(before.length).trim().split('\n').filter(Boolean);
    assert.ok(newLines.length >= 1);
    const entry = JSON.parse(newLines[newLines.length - 1]) as FakeLogEntry;
    assert.strictEqual(entry.key, 'unknown');

    // Clean up so repeated test runs don't grow this fixture file forever.
    fs.writeFileSync(unrecordedPath, before, 'utf8');
  });

  it('returns German output for `localized` scenario when LC_ALL is unset', () => {
    const res = runFake(['tools', 'target', 'list'], {
      SFDK_FAKE_SCENARIO: 'localized',
      LC_ALL: undefined,
      LANG: 'en_US.UTF-8',
    });
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /Ziel/);
  });

  it('returns English output for `localized` scenario when LC_ALL=C', () => {
    const res = runFake(['tools', 'target', 'list'], {
      SFDK_FAKE_SCENARIO: 'localized',
      LC_ALL: 'C',
    });
    assert.strictEqual(res.status, 0);
    assert.doesNotMatch(res.stdout, /Ziel/);
    assert.match(res.stdout, /SailfishOS-4\.4\.0\.58-aarch64/);
  });
});
