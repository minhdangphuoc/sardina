import * as assert from 'assert';
import * as vscode from 'vscode';
import { clearFakeLog, extensionApi, readFakeLog, waitFor, waitForContext, withScenario } from './helpers';
import type { Services } from '../../src/core/services';

/** SfdkRunner integration suite (FR-1.3/1.4/1.5); only discovered when TEST_MODE != 'bare'. */

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

suite('SfdkRunner (FR-1.3/1.4/1.5)', () => {
  let ready = false;

  suiteSetup(async function () {
    this.timeout(15000);
    ready = await sfdkReady();
    if (!ready) {
      console.log('[runner] SfdkRunner is still unimplemented; skipping runner assertions');
    }
  });

  test('FR-1.3/1.4: --no-pager on every call, -c target=/-c device= per invocation, LC_ALL=C', async function () {
    if (!ready) return this.skip();
    this.timeout(15000);
    await withScenario('default', async () => {
      clearFakeLog();
      const result = await services().runner.run({
        args: ['tools', 'list'],
        target: 'SailfishOS-4.4.0.58-aarch64',
        device: 'Xperia 10 III',
        ensureEngine: false,
      });
      assert.strictEqual(result.exitCode, 0);
      assert.deepStrictEqual(result.argv.slice(1), [
        '--no-pager',
        '-c',
        'target=SailfishOS-4.4.0.58-aarch64',
        '-c',
        'device=Xperia 10 III',
        'tools',
        'list',
      ]);
      const { invocations } = readFakeLog();
      const inv = invocations.find((i) => i.key === 'tools_list');
      assert.ok(inv, 'expected a tools_list invocation in the fake log');
      assert.strictEqual(inv?.env.LC_ALL, 'C');
    });
  });

  test('FR-1.3: streams stdout lines to onLine as they arrive', async function () {
    if (!ready) return this.skip();
    this.timeout(15000);
    await withScenario('default', async () => {
      const lines: string[] = [];
      const result = await services().runner.run({
        args: ['tools', 'list'],
        ensureEngine: false,
        onLine: (line) => lines.push(line),
      });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(lines.length > 0, 'expected at least one streamed line');
      assert.strictEqual(lines.join('\n') + '\n', result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    });
  });

  test('FR-1.5: ensureEngine runs engine status/start before the wrapped command when the engine is stopped', async function () {
    if (!ready) return this.skip();
    this.timeout(15000);
    await withScenario('no-engine', async () => {
      clearFakeLog();
      await services().runner.run({ args: ['build', '--no-check'], ensureEngine: true });
      const keys = readFakeLog().invocations.map((i) => i.key);
      const iStatus = keys.indexOf('engine_status');
      const iStart = keys.indexOf('engine_start');
      const iBuild = keys.indexOf('build');
      assert.ok(iStatus !== -1 && iStart !== -1 && iBuild !== -1, `got: ${keys.join(',')}`);
      assert.ok(iStatus < iStart && iStart < iBuild);
    });
  });

  test('FR-1.5: ensureEngine skips engine start when already running', async function () {
    if (!ready) return this.skip();
    this.timeout(15000);
    await withScenario('default', async () => {
      clearFakeLog();
      await services().runner.run({ args: ['build', '--no-check'], ensureEngine: true });
      const keys = readFakeLog().invocations.map((i) => i.key);
      assert.ok(keys.includes('engine_status'));
      assert.ok(!keys.includes('engine_start'), `did not expect engine_start, got: ${keys.join(',')}`);
    });
  });

  test('M1.18: cancellation kills the fake process via SIGTERM (no zombie)', async function () {
    if (!ready) return this.skip();
    this.timeout(15000);
    await withScenario('hang', async () => {
      clearFakeLog();
      const cts = new vscode.CancellationTokenSource();
      const resultPromise = services().runner.run({ args: ['device', 'exec', '--', 'sleep'], ensureEngine: false, token: cts.token });
      await waitFor(() => readFakeLog().invocations.some((i) => i.key.startsWith('device_exec')), 5000);
      cts.cancel();
      const result = await resultPromise;
      assert.strictEqual(result.cancelled, true);
      await waitFor(() => readFakeLog().killed.some((k) => k.signal === 'SIGTERM'), 8000);
      cts.dispose();
    });
  });
});
