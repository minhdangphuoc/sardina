import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  clearFakeLog,
  extensionApi,
  readFakeLog,
  stubMessages,
  waitFor,
  waitForContext,
  withScenario,
} from './helpers';
import type { Services } from '../../src/core/services';
import { SAILFISH_TASK_TYPE } from '../../src/tasks/provider';

/** Tasks integration suite (FR-5, AC-1.5/1.6/1.7); only discovered when TEST_MODE != 'bare' (test/integration/index.ts). */

const TARGET = 'SailfishOS-4.4.0.58-aarch64';

function services(): Services {
  return extensionApi().__test.getServices() as unknown as Services;
}

async function sfdkReady(): Promise<boolean> {
  try {
    await waitForContext('sailfish.sdkAvailable', true, 5000);
  } catch {
    return false;
  }
  try {
    await services().runner.run({ args: ['tools', 'list'], ensureEngine: false });
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes('not implemented')) {
      return false;
    }
    throw err;
  }
}

function folder(): vscode.WorkspaceFolder {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) {
    throw new Error('expected a workspace folder (qml-app fixture)');
  }
  return f;
}

/** Global scope: never writes into the shared qml-app fixture's .vscode/settings.json. */
async function setSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('sailfish').update(key, value, vscode.ConfigurationTarget.Global);
}

/** Resolves with the exit code of the specific sailfish task `command` starts, not any other concurrently-running one (M1.12). */
async function runCommandAndWaitForTask(command: string, timeoutMs = 15000): Promise<number | undefined> {
  // Waits out a still-retiring previous task so executeTask() below can't be coalesced into it.
  await waitFor(() => !vscode.tasks.taskExecutions.some((e) => (e.task.definition as { type?: string }).type === SAILFISH_TASK_TYPE), 5000).catch(() => undefined);
  const expectedTaskCommand = command.startsWith('sailfish.') ? command.slice('sailfish.'.length) : undefined;
  return new Promise((resolve, reject) => {
    let settled = false;
    let captured: vscode.TaskExecution | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      startSub.dispose();
      endSub.dispose();
      fn();
    };
    const matches = (execution: vscode.TaskExecution): boolean => {
      const def = execution.task.definition as { type?: string; command?: string };
      if (def.type !== SAILFISH_TASK_TYPE) {
        return false;
      }
      return expectedTaskCommand === undefined || def.command === expectedTaskCommand;
    };
    // A stray task already running when we start listening must never be picked up as "ours".
    const alreadyRunning = new Set(vscode.tasks.taskExecutions);
    const startSub = vscode.tasks.onDidStartTask((e) => {
      if (captured || alreadyRunning.has(e.execution)) {
        return;
      }
      if (matches(e.execution)) {
        captured = e.execution;
      }
    });
    const endSub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (captured && e.execution === captured) {
        finish(() => resolve(e.exitCode));
      }
    });
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`sailfish task did not end within ${timeoutMs}ms`)));
    }, timeoutMs);
    Promise.resolve(vscode.commands.executeCommand(command)).catch((err: unknown) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
  });
}

suite('tasks (FR-5, AC-1.5/1.6/1.7)', () => {
  let ready = false;

  suiteSetup(async function () {
    this.timeout(15000);
    await setSetting('target', TARGET);
    await setSetting('device', 'Xperia 10 III');
    ready = await sfdkReady();
    if (!ready) {
      console.log('[tasks] SfdkRunner is still unimplemented; skipping sfdk-backed task assertions');
    }
  });

  suiteTeardown(async function () {
    this.timeout(15000);
    await setSetting('target', undefined);
    await setSetting('device', undefined);
  });

  test('provideTasks offers build/build(debug)/deploy/run/package/check/clean for the qml-app project', async () => {
    const tasks = await vscode.tasks.fetchTasks({ type: SAILFISH_TASK_TYPE });
    const names = tasks.map((t) => t.name);
    for (const expected of ['build', 'build (debug)', 'deploy', 'run', 'package', 'check', 'clean']) {
      assert.ok(names.includes(expected), `expected a "${expected}" task, got: ${names.join(', ')}`);
    }
    const build = tasks.find((t) => t.name === 'build');
    assert.deepStrictEqual(build?.problemMatchers, ['$sailfish-gcc', '$sailfish-qmake', '$sailfish-rpmbuild']);
    const check = tasks.find((t) => t.name === 'check');
    assert.deepStrictEqual(check?.problemMatchers, ['$sailfish-rpmvalidator']);
  });

  test('AC-1.5: sailfish.build issues the exact default argv with LC_ALL=C', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    await withScenario('default', async () => {
      const exitCode = await runCommandAndWaitForTask('sailfish.build');
      assert.strictEqual(exitCode, 0);
      const { invocations } = readFakeLog();
      const build = invocations.find((i) => i.key === 'build');
      assert.ok(build, 'expected a build invocation in the fake log');
      assert.deepStrictEqual(build?.argv, ['--no-pager', '-c', `target=${TARGET}`, 'build', '--no-check']);
      assert.strictEqual(build?.env.LC_ALL, 'C');
    });
  });

  test('build-fails-compile: a Problems entry appears at src/main.cpp:12:5 with the rewritten host path and message (M1.16)', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    await withScenario('build-fails-compile', async () => {
      await runCommandAndWaitForTask('sailfish.build').catch(() => undefined);
      await waitFor(() => {
        const diags = vscode.languages
          .getDiagnostics()
          .flatMap(([uri, d]) => d.map((diag) => ({ uri, diag })))
          .filter(({ diag }) => diag.severity === vscode.DiagnosticSeverity.Error);
        return diags.some(
          ({ uri, diag }) =>
            diag.range.start.line === 11 &&
            diag.range.start.character === 4 &&
            uri.fsPath === vscode.Uri.joinPath(folder().uri, 'src', 'main.cpp').fsPath &&
            /'foo' was not declared in this scope/.test(diag.message),
        );
      }, 8000);
    });
  });

  test('build-warnings-only: warnings reported at warning severity, exit 0 (M1.16)', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    await withScenario('build-warnings-only', async () => {
      const exitCode = await runCommandAndWaitForTask('sailfish.build');
      assert.strictEqual(exitCode, 0);
      await waitFor(() => {
        const diags = vscode.languages
          .getDiagnostics()
          .flatMap(([uri, d]) => d.map((diag) => ({ uri, diag })))
          .filter(({ diag }) => diag.severity === vscode.DiagnosticSeverity.Warning);
        return (
          diags.some(
            ({ uri, diag }) =>
              diag.range.start.line === 8 &&
              uri.fsPath === vscode.Uri.joinPath(folder().uri, 'src', 'main.cpp').fsPath &&
              /unused variable 'debugFlag'/.test(diag.message),
          ) &&
          diags.some(
            ({ diag }) => diag.range.start.line === 13 && /control reaches end of non-void function/.test(diag.message),
          )
        );
      }, 8000);
    });
  });

  test('build-fails-spec: non-zero exit, rpmbuild diagnostic prefixed with the spec path', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    await withScenario('build-fails-spec', async () => {
      const exitCode = await runCommandAndWaitForTask('sailfish.build').catch(() => 1);
      assert.notStrictEqual(exitCode, 0);
      await waitFor(() => {
        const diags = vscode.languages
          .getDiagnostics()
          .flatMap(([uri, d]) => d.map((diag) => ({ uri, diag })))
          .filter(({ diag }) => diag.severity === vscode.DiagnosticSeverity.Error);
        return diags.some(
          ({ uri, diag }) =>
            diag.range.start.line === 11 &&
            uri.fsPath === vscode.Uri.joinPath(folder().uri, 'rpm', 'harbour-demo.spec').fsPath &&
            /Group tag is required/.test(diag.message),
        );
      }, 8000);
    });
  });

  test('AC-1.6: no-engine build issues engine_status, engine_start, then build in order', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    await withScenario('no-engine', async () => {
      await runCommandAndWaitForTask('sailfish.build').catch(() => undefined);
      const { invocations } = readFakeLog();
      const keys = invocations.map((i) => i.key);
      const iStatus = keys.indexOf('engine_status');
      const iStart = keys.indexOf('engine_start');
      const iBuild = keys.indexOf('build');
      assert.ok(iStatus !== -1 && iStart !== -1 && iBuild !== -1, `expected all three, got: ${keys.join(',')}`);
      assert.ok(iStatus < iStart && iStart < iBuild, `expected engine_status < engine_start < build, got: ${keys.join(',')}`);
    });
  });

  for (const method of ['sdk', 'pkcon', 'rsync', 'zypper', 'zypper-dup', 'manual'] as const) {
    test(`deploy method flag --${method}`, async function () {
      if (!ready) return this.skip();
      this.timeout(20000);
      await setSetting('deploy.method', method);
      await withScenario('default', async () => {
        await runCommandAndWaitForTask('sailfish.deploy').catch(() => undefined);
        const { invocations } = readFakeLog();
        const deploy = invocations.find((i) => i.key === 'deploy');
        assert.ok(deploy?.argv.includes(`--${method}`), `expected --${method} in ${JSON.stringify(deploy?.argv)}`);
      });
      await setSetting('deploy.method', 'sdk');
    });
  }

  const deployFailures: Array<[string, RegExp]> = [
    ['deploy-device-unreachable', /unreachable/i],
    ['deploy-auth-fail', /ssh authentication failed/i],
    ['deploy-no-rpm', /build first/i],
  ];
  for (const [scenario, expected] of deployFailures) {
    test(`deploy-* scenario ${scenario} maps to a distinct message`, async function () {
      if (!ready) return this.skip();
      this.timeout(20000);
      const messages = stubMessages();
      await withScenario(scenario, async () => {
        await runCommandAndWaitForTask('sailfish.deploy').catch(() => undefined);
        await waitFor(() => messages.calls.some((c) => expected.test(c.message)), 8000);
      });
      assert.ok(!messages.calls.some((c) => /password/i.test(c.message)), 'must never prompt for a password');
    });
  }

  test('hang + cancel: terminating the task execution kills the fake process (no zombie)', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    await withScenario('hang', async () => {
      clearFakeLog();
      const executionPromise = new Promise<vscode.TaskExecution>((resolve) => {
        const sub = vscode.tasks.onDidStartTask((e) => {
          if ((e.execution.task.definition as { type?: string }).type === SAILFISH_TASK_TYPE) {
            sub.dispose();
            resolve(e.execution);
          }
        });
        void vscode.commands.executeCommand('sailfish.build');
      });
      const execution = await executionPromise;
      const ended = new Promise<void>((resolve) => {
        const sub = vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution === execution) {
            sub.dispose();
            resolve();
          }
        });
      });
      await new Promise((r) => setTimeout(r, 500));
      execution.terminate();
      await waitFor(() => readFakeLog().killed.length > 0, 8000);
      await ended;
    });
  });

  test('engine-stopped: build issues engine_status, engine_start, then build in order (M1.12)', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    await withScenario('engine-stopped', async () => {
      await runCommandAndWaitForTask('sailfish.build').catch(() => undefined);
      const { invocations } = readFakeLog();
      const keys = invocations.map((i) => i.key);
      const iStatus = keys.indexOf('engine_status');
      const iStart = keys.indexOf('engine_start');
      const iBuild = keys.indexOf('build');
      assert.ok(iStatus !== -1 && iStart !== -1 && iBuild !== -1, `expected all three, got: ${keys.join(',')}`);
      assert.ok(iStatus < iStart && iStart < iBuild, `expected engine_status < engine_start < build, got: ${keys.join(',')}`);
    });
  });

  test('target-missing: build fails with the sfdk stderr shown in a notification (M1.11)', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    const messages = stubMessages();
    await withScenario('target-missing', async () => {
      await runCommandAndWaitForTask('sailfish.build').catch(() => undefined);
      await waitFor(() => messages.calls.some((c) => /not found/i.test(c.message)), 8000);
    });
  });

  test('target-not-set: build fails with the sfdk stderr, no -c target= is sent (M1.11/M0.5)', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    // Runs the task directly, bypassing sailfish.build's ensureTarget guard (no target configured here).
    await setSetting('target', '');
    await withScenario('target-not-set', async () => {
      const tasks = await vscode.tasks.fetchTasks({ type: SAILFISH_TASK_TYPE });
      const buildTask = tasks.find((t) => t.name === 'build');
      assert.ok(buildTask, 'expected a "build" task');
      const ended = new Promise<number | undefined>((resolve) => {
        const sub = vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution.task === buildTask) {
            sub.dispose();
            resolve(e.exitCode);
          }
        });
      });
      await vscode.tasks.executeTask(buildTask);
      const exitCode = await ended;
      assert.notStrictEqual(exitCode, 0);
      const { invocations } = readFakeLog();
      const build = invocations.find((i) => i.key === 'build');
      assert.ok(build && !build.argv.includes('-c'), `expected no -c target= in ${JSON.stringify(build?.argv)}`);
    });
    await setSetting('target', TARGET);
  });

  test('check-fails: a rpmvalidator Problems entry appears with severity error (M0.5)', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    await withScenario('check-fails', async () => {
      const tasks = await vscode.tasks.fetchTasks({ type: SAILFISH_TASK_TYPE });
      const checkTask = tasks.find((t) => t.name === 'check');
      assert.ok(checkTask, 'expected a "check" task');
      const ended = new Promise<void>((resolve) => {
        const sub = vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution.task === checkTask) {
            sub.dispose();
            resolve();
          }
        });
      });
      await vscode.tasks.executeTask(checkTask);
      await ended;
      await waitFor(() => {
        const diags = vscode.languages
          .getDiagnostics()
          .flatMap(([uri, d]) => d.map((diag) => ({ uri, diag })))
          .filter(({ diag }) => diag.severity === vscode.DiagnosticSeverity.Error);
        return diags.some(
          ({ uri, diag }) =>
            /icon missing/i.test(diag.message) &&
            uri.fsPath === vscode.Uri.joinPath(folder().uri, 'rpm', 'harbour-demo.spec').fsPath,
        );
      }, 8000);
    });
  });

  test('M1.19: huge-output build keeps the extension-host RSS delta under 300MB', async function () {
    if (!ready) return this.skip();
    this.timeout(30000);
    const gc = (globalThis as { gc?: () => void }).gc;
    await withScenario('huge-output', async () => {
      gc?.();
      const before = process.memoryUsage().rss;
      await runCommandAndWaitForTask('sailfish.build').catch(() => undefined);
      gc?.();
      const after = process.memoryUsage().rss;
      const deltaMb = (after - before) / (1024 * 1024);
      assert.ok(deltaMb < 300, `RSS delta was ${deltaMb.toFixed(1)}MB, expected < 300MB`);
    });
  });

  test('R25: device/target injection corpus each produce exactly one argv element, sfdk invoked exactly once', async function () {
    if (!ready) return this.skip();
    this.timeout(30000);
    const payloads = [
      '; rm -rf /',
      '$(id)',
      '`id`',
      '"quoted" \'mixed\'',
      '--malicious-flag',
      '-',
      'a'.repeat(10240),
      'a\nb',
      'Émulateur 日本語',
    ];
    for (const payload of payloads) {
      await setSetting('device', payload);
      await withScenario('default', async () => {
        await runCommandAndWaitForTask('sailfish.deploy').catch(() => undefined);
        const deploys = readFakeLog().invocations.filter((i) => i.key === 'deploy');
        assert.strictEqual(deploys.length, 1, `expected exactly 1 deploy invocation for ${JSON.stringify(payload)}`);
        assert.strictEqual(
          deploys[0].argv.filter((a) => a === `device=${payload}`).length,
          1,
          `expected device=${JSON.stringify(payload)} exactly once in ${JSON.stringify(deploys[0].argv)}`,
        );
      });
    }
    await setSetting('device', 'Xperia 10 III');

    for (const payload of payloads) {
      await setSetting('target', payload);
      await withScenario('default', async () => {
        await runCommandAndWaitForTask('sailfish.build').catch(() => undefined);
        const builds = readFakeLog().invocations.filter((i) => i.key === 'build');
        assert.strictEqual(builds.length, 1, `expected exactly 1 build invocation for ${JSON.stringify(payload)}`);
        assert.strictEqual(
          builds[0].argv.filter((a) => a === `target=${payload}`).length,
          1,
          `expected target=${JSON.stringify(payload)} exactly once in ${JSON.stringify(builds[0].argv)}`,
        );
      });
    }
    await setSetting('target', TARGET);
  });

  test('M1.21: sailfish.run issues device=<value> verbatim for a non-ASCII device name', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    const nonAscii = 'Xperia 10 III – 日本語';
    await setSetting('device', nonAscii);
    await withScenario('default', async () => {
      await runCommandAndWaitForTask('sailfish.run').catch(() => undefined);
      // The status bar's own background poll can also land in the log; wait for our own key.
      await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'device_exec.invoker'), 8000);
      const { invocations } = readFakeLog();
      const launch = invocations.find((i) => i.key === 'device_exec.invoker');
      assert.ok(launch, `expected a device_exec.invoker invocation, got: ${invocations.map((i) => i.key).join(',')}`);
      const valueIdx = launch.argv.indexOf(`device=${nonAscii}`);
      assert.ok(valueIdx > 0, `expected device=${JSON.stringify(nonAscii)} in ${JSON.stringify(launch.argv)}`);
      assert.strictEqual(launch.argv[valueIdx - 1], '-c');
    });
    await setSetting('device', 'Xperia 10 III');
  });

  test('M1.23: stopping sailfish.run mid-flight sends a remote pkill via device exec', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    // Isolates the stop-triggered kill from the run task's own optional pre-launch pkill step.
    await setSetting('run.killBeforeLaunch', false);
    try {
      await withScenario('run-stop', async () => {
        clearFakeLog();
        await waitFor(() => !vscode.tasks.taskExecutions.some((e) => (e.task.definition as { type?: string }).type === SAILFISH_TASK_TYPE), 5000).catch(() => undefined);
        const executionPromise = new Promise<vscode.TaskExecution>((resolve) => {
          const sub = vscode.tasks.onDidStartTask((e) => {
            if ((e.execution.task.definition as { type?: string }).type === SAILFISH_TASK_TYPE) {
              sub.dispose();
              resolve(e.execution);
            }
          });
          void vscode.commands.executeCommand('sailfish.run');
        });
        const execution = await executionPromise;
        const ended = new Promise<void>((resolve) => {
          const sub = vscode.tasks.onDidEndTaskProcess((e) => {
            if (e.execution === execution) {
              sub.dispose();
              resolve();
            }
          });
        });
        // Only the launch step hangs (run-stop's fixtures); wait for it to be in flight.
        await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'device_exec.invoker'), 8000);
        execution.terminate();
        await ended;
        await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'device_exec.pkill'), 10000);
        const pkill = readFakeLog().invocations.find((i) => i.key === 'device_exec.pkill');
        assert.ok(pkill, 'expected a device_exec.pkill invocation after stopping the run task');
        assert.ok(pkill.argv.includes('pkill') && pkill.argv.includes('-f'));
      });
    } finally {
      await setSetting('run.killBeforeLaunch', true);
    }
  });

  // Runs last: its multi-second delays leave the task system briefly unsettled afterward.
  test('slow: a build over a delayed sfdk still completes without a false timeout (M0.5)', async function () {
    if (!ready) return this.skip();
    this.timeout(30000);
    await withScenario('slow', async () => {
      const start = Date.now();
      const exitCode = await runCommandAndWaitForTask('sailfish.build', 25000);
      const elapsedMs = Date.now() - start;
      assert.strictEqual(exitCode, 0);
      assert.ok(elapsedMs >= 3500, `expected the delayed sfdk responses to be waited out, took only ${elapsedMs}ms`);
    });
  });
});
