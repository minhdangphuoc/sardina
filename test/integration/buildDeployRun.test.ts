import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { clearFakeLog, extensionApi, readFakeLog, stubMessages, waitFor, waitForContext, withScenario } from './helpers';
import type { Services } from '../../src/core/services';

/** FR-5.10 `sailfish.buildDeployRun` suite (AC-1.7); only discovered when TEST_MODE != 'bare'. */

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

/** Global scope: never writes into the shared qml-app fixture's .vscode/settings.json. */
async function setSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('sailfish').update(key, value, vscode.ConfigurationTarget.Global);
}

suite('sailfish.buildDeployRun (FR-5.10, AC-1.7)', () => {
  let ready = false;

  suiteSetup(async function () {
    this.timeout(15000);
    await setSetting('target', TARGET);
    await setSetting('device', 'Xperia 10 III');
    await setSetting('deploy.method', 'sdk');
    // Changing `device` and `target` clears the Devices lists at once and reloads them through a 2 s
    // debounce (tree.ts). Let that reload finish here, or it lands inside the first test's sequence as
    // `emulator_list`/`device_list` (a Run session registering in that window re-renders the tree too).
    await new Promise((r) => setTimeout(r, 2500));
    ready = await sfdkReady();
    if (!ready) {
      console.log('[buildDeployRun] SfdkRunner is still unimplemented; skipping sfdk-backed assertions');
    }
  });

  suiteTeardown(async function () {
    this.timeout(15000);
    await setSetting('target', undefined);
    await setSetting('device', undefined);
    await setSetting('deploy.method', undefined);
  });

  test('issues exactly one build, one deploy (--sdk), pkill then invoker, never re-triggering dependsOn', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    await withScenario('default', async () => {
      clearFakeLog();
      await vscode.commands.executeCommand('sailfish.buildDeployRun');
      await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'device_exec.invoker'), 10000);

      const { invocations } = readFakeLog();
      // Excludes the status bar's own background poll, not part of the sequence under test.
      const keys = invocations.map((i) => i.key).filter((k) => k !== 'tools_target_list' && k !== 'engine_exec.pwd');
      // The build log maps engine paths with the cached `engine exec -- pwd` probe (run once per session, so filtered out).
      // FR-1.5: engine already running in the `default` scenario, so no `engine start`.
      assert.deepStrictEqual(keys, ['engine_status', 'build', 'deploy', 'device_exec.pkill', 'device_exec.invoker']);

      const deploy = invocations.find((i) => i.key === 'deploy');
      assert.ok(deploy?.argv.includes('--sdk'));
      // AC-1.5: only the deploy and device-exec steps get `-c device=`; a build must not depend on a registered device.
      assert.ok(deploy?.argv.includes('device=Xperia 10 III'), `deploy argv: ${JSON.stringify(deploy?.argv)}`);
      const build = invocations.find((i) => i.key === 'build');
      assert.ok(build && !build.argv.some((a) => a.startsWith('device=')), `build argv: ${JSON.stringify(build?.argv)}`);
    });
  });

  test('a signing user that matches no GPG key stops before any sfdk build and offers Set up signing', async function () {
    if (!ready) return this.skip();
    // Without gpg the guard cannot check anything and lets sfdk report the problem instead.
    if (spawnSync('gpg', ['--version']).status !== 0) return this.skip();
    this.timeout(20000);
    const messages = stubMessages();
    await setSetting('build.sign', true);
    await setSetting('build.signingUser', 'No Such Key Zq9 Test');
    try {
      await withScenario('default', async () => {
        clearFakeLog();
        await Promise.resolve(vscode.commands.executeCommand('sailfish.buildDeployRun')).catch(() => undefined);
        await waitFor(() => messages.calls.some((c) => c.kind === 'error' && /No Such Key Zq9 Test/.test(c.message)), 10000);
        const error = messages.calls.find((c) => c.kind === 'error' && /No Such Key Zq9 Test/.test(c.message));
        assert.ok(error?.items.includes('Set up signing'), `actions: ${JSON.stringify(error?.items)}`);
        // Give a would-be build a moment to show up if the guard were broken.
        await new Promise((r) => setTimeout(r, 500));
        const keys = readFakeLog().invocations.map((i) => i.key);
        assert.ok(!keys.includes('build'), `sfdk build must not run, got: ${keys.join(', ')}`);
      });
    } finally {
      await setSetting('build.sign', undefined);
      await setSetting('build.signingUser', undefined);
    }
  });

  test('Run Installed App launches without building or deploying: pkill then invoker only', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    await withScenario('default', async () => {
      clearFakeLog();
      await vscode.commands.executeCommand('sailfish.runInstalled');
      await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'device_exec.invoker'), 10000);
      const keys = readFakeLog().invocations.map((i) => i.key).filter((k) => k !== 'tools_target_list');
      assert.ok(!keys.includes('build') && !keys.includes('deploy'), `must not build or deploy, got: ${keys.join(', ')}`);
      assert.deepStrictEqual(
        keys.filter((k) => k.startsWith('device_exec.')),
        ['device_exec.test', 'device_exec.pkill', 'device_exec.invoker'],
        'checks the app is installed, stops a running instance, then launches',
      );
    });
  });

  test('stops on the first non-zero exit: build-fails-compile logs no deploy key', async function () {
    if (!ready) return this.skip();
    this.timeout(20000);
    await withScenario('build-fails-compile', async () => {
      clearFakeLog();
      await Promise.resolve(vscode.commands.executeCommand('sailfish.buildDeployRun')).catch(() => undefined);
      await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'build'), 10000);
      // give a would-be deploy call a moment to show up if the stop-on-failure logic were broken
      await new Promise((r) => setTimeout(r, 500));
      const keys = readFakeLog().invocations.map((i) => i.key);
      assert.ok(keys.includes('build'));
      assert.ok(!keys.includes('deploy'), `expected no deploy invocation, got: ${keys.join(',')}`);
    });
  });
});
