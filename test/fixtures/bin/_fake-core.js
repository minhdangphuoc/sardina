'use strict';
/*
 * Shared helpers for the fake sfdk binary (validation-instructions §1.2).
 * This file is pure Node (no vscode, no TypeScript) so it can run both as
 * the CLI entry's dependency and be `require()`d directly from unit tests
 * (test/unit/fake/dispatcher.test.ts).
 */

const fs = require('fs');
const path = require('path');

const FIXTURES_SFDK_ROOT = path.join(__dirname, '..', 'sfdk');
const SCENARIOS_ROOT = path.join(FIXTURES_SFDK_ROOT, 'scenarios');
const UNRECORDED_LOG = path.join(FIXTURES_SFDK_ROOT, 'unrecorded.log');

const SCENARIO_ALIASES = {
  happy: 'default',
  'build-error': 'build-fails-compile',
  'old-format': 'tools-list-odd-glyphs',
};

/**
 * Strip the global options the extension is expected to prepend to every
 * invocation, so `sfdk --no-pager -c target=X -c device=Y build --no-check`
 * and `sfdk build --no-check` resolve to the same fake key.
 * @param {string[]} argv
 * @returns {string[]}
 */
function stripGlobalOptions(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-pager' || a === '-q' || a === '--quiet') {
      continue;
    }
    if (a === '-c' || a === '--config') {
      // consumes the following token, whether or not it itself contains '='
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Resolve a scenario name through the documented aliases. */
function resolveScenarioAlias(name) {
  const raw = name || 'default';
  return Object.prototype.hasOwnProperty.call(SCENARIO_ALIASES, raw) ? SCENARIO_ALIASES[raw] : raw;
}

function candidateKeys(key) {
  return key.includes('.') ? [key, key.split('.')[0]] : [key];
}

/** Directories to search, in order, for a resolved scenario name. */
function dirsFor(scenario) {
  const scenarioDir = path.join(SCENARIOS_ROOT, scenario);
  if (scenario === 'default') {
    return [scenarioDir];
  }
  return [scenarioDir, path.join(SCENARIOS_ROOT, 'default')];
}

/**
 * Find `<candidateKey>.<ext>` under the scenario dir then the default dir,
 * trying the full key before falling back to its base key (the part before
 * the first '.').
 */
function resolveFile(scenario, key, ext) {
  for (const k of candidateKeys(key)) {
    for (const dir of dirsFor(scenario)) {
      const p = path.join(dir, `${k}.${ext}`);
      if (fs.existsSync(p)) {
        return p;
      }
    }
  }
  return null;
}

/**
 * Like resolveFile but for stdout specifically: when `localizedActive`, a
 * `<key>.stdout.de` file in the scenario dir itself is preferred (no
 * fallback to default for the .de variant — the German text only exists in
 * the `localized` scenario).
 */
function resolveStdout(scenario, key, localizedActive) {
  if (localizedActive) {
    const scenarioDir = path.join(SCENARIOS_ROOT, scenario);
    for (const k of candidateKeys(key)) {
      const p = path.join(scenarioDir, `${k}.stdout.de`);
      if (fs.existsSync(p)) {
        return p;
      }
    }
  }
  return resolveFile(scenario, key, 'stdout');
}

function readFileIfExists(p) {
  return p ? fs.readFileSync(p, 'utf8') : null;
}

function appendJsonLine(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
  } catch {
    // never let logging crash the fake
  }
}

function logInvocation(logPath, rawArgv, cwd, scenario, key, stdin) {
  if (!logPath) return;
  appendJsonLine(logPath, {
    ts: Date.now(),
    bin: 'sfdk',
    argv: rawArgv,
    cwd,
    scenario,
    key,
    env: {
      LC_ALL: process.env.LC_ALL ?? null,
      LANG: process.env.LANG ?? null,
      SFDK_FAKE_SCENARIO: process.env.SFDK_FAKE_SCENARIO ?? null,
    },
    stdin: stdin ?? '',
  });
}

function logEvent(logPath, obj) {
  if (!logPath) return;
  appendJsonLine(logPath, { ts: Date.now(), ...obj });
}

function appendUnrecorded(rawArgv, cwd, scenario, key) {
  appendJsonLine(UNRECORDED_LOG, {
    ts: Date.now(),
    bin: 'sfdk',
    argv: rawArgv,
    cwd,
    scenario,
    key,
  });
}

/** Read stdin asynchronously, bounded to timeoutMs / maxBytes. Never blocks. */
function readStdinBounded(timeoutMs, maxBytes) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        process.stdin.removeAllListeners('error');
        process.stdin.pause();
      } catch {
        // ignore
      }
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
        if (Buffer.byteLength(data, 'utf8') >= maxBytes) {
          clearTimeout(timer);
          finish();
        }
      });
      process.stdin.on('end', () => {
        clearTimeout(timer);
        finish();
      });
      process.stdin.on('error', () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      finish();
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  FIXTURES_SFDK_ROOT,
  SCENARIOS_ROOT,
  UNRECORDED_LOG,
  SCENARIO_ALIASES,
  stripGlobalOptions,
  resolveScenarioAlias,
  candidateKeys,
  dirsFor,
  resolveFile,
  resolveStdout,
  readFileIfExists,
  appendJsonLine,
  logInvocation,
  logEvent,
  appendUnrecorded,
  readStdinBounded,
  sleep,
};
