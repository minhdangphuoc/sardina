'use strict';
/*
 * Fake sfdk CLI entry (validation-instructions §1.2). Dispatches on a "fake
 * key" derived from argv, reading recorded output from
 * test/fixtures/sfdk/scenarios/<scenario>/<key>.{stdout,stderr,exit,...}.
 *
 * `keyFn` is exported (alongside `_fake-core.js`'s `stripGlobalOptions`) for
 * test/unit/fake/dispatcher.test.ts. The CLI entry point itself is guarded
 * by `require.main === module` so requiring this file for its exports never
 * runs the dispatcher.
 */

const fs = require('fs');
const path = require('path');
const core = require('./_fake-core');

const FAMILY_COMMANDS = new Set(['tools', 'emulator', 'device', 'engine']);
const BARE_COMMANDS = new Set(['build', 'deploy', 'qmake', 'make', 'package', 'check', 'build-shell']);

/**
 * Compute the fake dispatch key for a (already global-option-stripped) argv.
 * See CONVENTIONS.md "Fake sfdk key table" for the full rule table.
 * @param {string[]} argv
 * @returns {string}
 */
function keyFn(argv) {
  if (argv.includes('--version')) {
    return 'version';
  }

  const a0 = argv[0];

  if (a0 === 'init') {
    if (argv.includes('-l') || argv.includes('--list-types')) {
      return 'init_list';
    }
    return 'init_template';
  }

  if (a0 === 'config') {
    if (argv.includes('--show')) {
      return 'config_show';
    }
    if (argv.includes('--global')) {
      return 'config_set_global';
    }
    return 'config_set';
  }

  // Check `tools target list` BEFORE the generic family rule.
  if (a0 === 'tools' && argv[1] === 'target' && argv[2] === 'list') {
    return 'tools_target_list';
  }
  if (a0 === 'tools' && argv[1] === 'list') {
    return 'tools_list';
  }

  if (a0 === 'device' && argv[1] === 'exec') {
    return dottedExecKey('device_exec', argv);
  }
  if (a0 === 'engine' && argv[1] === 'exec') {
    return dottedExecKey('engine_exec', argv);
  }

  if (a0 === 'emulator' && argv[1] === 'show') {
    return 'emulator_show';
  }

  if (FAMILY_COMMANDS.has(a0) && argv[1]) {
    return `${a0}_${argv[1]}`;
  }

  if (BARE_COMMANDS.has(a0)) {
    return a0;
  }

  return 'unknown';
}

/**
 * `device exec [name] -- <cmd...>` -> `<prefix>.<basename of cmd[0]>`,
 * falling back to the bare prefix when there is no `--` or nothing follows
 * it.
 */
function dottedExecKey(prefix, argv) {
  const dashIdx = argv.indexOf('--');
  if (dashIdx !== -1 && argv.length > dashIdx + 1) {
    const cmd = argv[dashIdx + 1];
    const base = cmd.split('/').pop();
    if (base) {
      return `${prefix}.${base}`;
    }
  }
  return prefix;
}

async function main(rawArgv) {
  const logPath = process.env.SFDK_FAKE_LOG || '';
  const cwd = process.cwd();
  const scenarioRaw = process.env.SFDK_FAKE_SCENARIO || 'default';
  const scenario = core.resolveScenarioAlias(scenarioRaw);
  const stripped = core.stripGlobalOptions(rawArgv);
  const key = keyFn(stripped);

  const localizedActive =
    scenario === 'localized' &&
    (process.env.LC_ALL !== 'C' || process.env.SFDK_FAKE_FORCE_LOCALIZED === '1');

  const hasStdinEcho = core.resolveFile(scenario, key, 'stdin-echo') !== null;
  let stdin = '';
  if (hasStdinEcho) {
    stdin = await core.readStdinBounded(200, 4096);
  }

  // Install the hang scenario's SIGTERM/SIGINT handler before logging the
  // invocation, so a caller that kills us the instant it sees the log line
  // can never race ahead of the handler.
  const hangPath = core.resolveFile(scenario, key, 'hang');
  if (hangPath) {
    const interval = setInterval(() => {}, 1 << 30);
    const onSignal = (signal) => {
      core.logEvent(logPath, { event: 'killed', signal, key });
      clearInterval(interval);
      process.exit(0);
    };
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGINT', () => onSignal('SIGINT'));
  }

  core.logInvocation(logPath, rawArgv, cwd, scenario, key, stdin);

  const stdoutPath = core.resolveStdout(scenario, key, localizedActive);
  const stderrPath = core.resolveFile(scenario, key, 'stderr');

  if (!stdoutPath && !stderrPath) {
    process.stderr.write(`sfdk: unrecognized command (fake key "${key}", scenario "${scenario}")\n`);
    core.appendUnrecorded(rawArgv, cwd, scenario, key);
    process.exitCode = 2;
    return;
  }

  const delayMsRaw = core.resolveFile(scenario, key, 'delay-ms') ?? core.resolveFile(scenario, '_all', 'delay-ms');
  if (delayMsRaw) {
    const ms = parseInt(fs.readFileSync(delayMsRaw, 'utf8').trim(), 10);
    if (Number.isFinite(ms) && ms > 0) {
      await core.sleep(ms);
    }
  }

  const stdoutText = core.readFileIfExists(stdoutPath) ?? '';
  const stderrText = core.readFileIfExists(stderrPath) ?? '';

  const streamPath = core.resolveFile(scenario, key, 'stream');
  if (streamPath && stdoutText) {
    const raw = fs.readFileSync(streamPath, 'utf8').trim();
    const perLineDelay = raw === '' ? 20 : parseInt(raw, 10) || 0;
    await writeStreamed(stdoutText, perLineDelay);
  } else if (stdoutText) {
    process.stdout.write(stdoutText);
  }

  if (stderrText) {
    process.stderr.write(stderrText);
  }

  if (hangPath) {
    return; // handler already installed above; do not exit until killed
  }

  if (key === 'init_template' && process.env.SFDK_FAKE_INIT_TOUCH === '1') {
    touchInitFiles(cwd, stripped);
  }

  const exitPath = core.resolveFile(scenario, key, 'exit');
  const exitCode = exitPath ? parseInt(fs.readFileSync(exitPath, 'utf8').trim(), 10) || 0 : 0;
  process.exitCode = exitCode;
}

async function writeStreamed(text, perLineDelay) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    const chunk = isLast ? lines[i] : lines[i] + '\n';
    if (chunk) {
      process.stdout.write(chunk);
    }
    if (!isLast && perLineDelay > 0) {
      await core.sleep(perLineDelay);
    }
  }
}

const INIT_OPTIONS_WITH_VALUE = new Set(['-t', '--type', '-b', '--builder']);

/**
 * Project name for `init_template`: the last positional token, skipping the
 * values of `-t`/`--type`/`-b`/`--builder` (those are option arguments, not
 * the project name) and any other `-`-prefixed token.
 * @param {string[]} strippedArgv
 * @returns {string}
 */
function computeInitName(strippedArgv) {
  const rest = strippedArgv.slice(1);
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (INIT_OPTIONS_WITH_VALUE.has(tok)) {
      i++;
      continue;
    }
    if (tok.startsWith('-')) {
      continue;
    }
    positionals.push(tok);
  }
  return positionals[positionals.length - 1] || 'app';
}

/** `init_template` side effect: create `<name>.pro` and `rpm/<name>.spec` directly in cwd. */
function touchInitFiles(cwd, strippedArgv) {
  const name = computeInitName(strippedArgv);
  try {
    fs.writeFileSync(path.join(cwd, `${name}.pro`), `TARGET = ${name}\n`, 'utf8');
    fs.mkdirSync(path.join(cwd, 'rpm'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'rpm', `${name}.spec`), `Name: ${name}\nVersion: 0.1\n`, 'utf8');
  } catch {
    // best-effort only
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { keyFn, dottedExecKey, computeInitName };
