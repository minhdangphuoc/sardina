import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { extensionApi, fixturesRoot, readFakeLog, clearFakeLog, stubMessages, waitFor, waitForContext, withScenario } from './helpers';
import type { Services } from '../../src/core/services';

/**
 * Task A integration suite (FR-1.1/1.2/1.4/1.7, M1.1-M1.4). Only discovered
 * when TEST_MODE != 'bare'.
 */

function services(): Services {
  return extensionApi().__test.getServices() as unknown as Services;
}

async function setSdkPathSetting(value: string | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('sailfish').update('sdkPath', value, vscode.ConfigurationTarget.Global);
}

/** A second, independent fake SDK root (its own bin/sfdk shim to the same fake binary). */
function makeAltSdkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sailfish-alt-sdk-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(root, 'sdk-release'), '3.13.5\n', 'utf8');
  const realFake = path.join(fixturesRoot(), 'bin', 'sfdk');
  const shim = path.join(bin, 'sfdk');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${realFake}" "$@"\n`, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(shim, 0o755);
  return root;
}

suite('sdk discovery & version gating (FR-1.1/1.2/1.4/1.7, M1.1-M1.4)', () => {
  teardown(async function () {
    this.timeout(15000);
    await setSdkPathSetting(undefined);
    await services().sdk.refresh();
  });

  test('M1.1: explicit sailfish.sdkPath wins over PATH/env discovery', async function () {
    this.timeout(15000);
    const altRoot = makeAltSdkRoot();
    await setSdkPathSetting(altRoot);
    await services().sdk.refresh();
    const info = services().sdk.current();
    assert.ok(info, 'expected sdk info once discovered');
    assert.strictEqual(info?.source, 'setting');
    assert.strictEqual(fs.realpathSync(info.root), fs.realpathSync(altRoot));

    await setSdkPathSetting(undefined);
    await services().sdk.refresh();
    const fallback = services().sdk.current();
    assert.ok(fallback, 'expected sdk info from env/PATH fallback');
    assert.notStrictEqual(fallback?.source, 'setting');
  });

  test('M1.2: no SDK found shows exactly one guidance notification and sailfish.sdkAvailable=false', async function () {
    this.timeout(15000);
    const messages = stubMessages();
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailfish-empty-sdk-'));
    const prevPath = process.env.PATH;
    const prevRoot = process.env.SAILFISH_SDK_ROOT;
    await setSdkPathSetting(emptyDir);
    process.env.PATH = '';
    delete process.env.SAILFISH_SDK_ROOT;
    try {
      await services().sdk.refresh();
      await waitForContext('sailfish.sdkAvailable', false, 5000);
      const warnings = messages.calls.filter((c) => c.kind === 'warning');
      assert.strictEqual(warnings.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnings)}`);
      // A second refresh while still not found must not show a second warning.
      await services().sdk.refresh();
      assert.strictEqual(messages.calls.filter((c) => c.kind === 'warning').length, 1);
    } finally {
      process.env.PATH = prevPath;
      process.env.SAILFISH_SDK_ROOT = prevRoot;
    }
  });

  test('M1.3/R8: version-too-old keeps the SDK available (degrade, do not disable everything)', async function () {
    this.timeout(15000);
    await withScenario('version-too-old', async () => {
      await services().sdk.refresh();
      const info = services().sdk.current();
      assert.ok(info, 'expected sdk info even with a too-old version');
      assert.strictEqual(info?.version, '3.2.1');
      assert.strictEqual(services().contextKeys.get('sailfish.sdkAvailable'), true);
    });
  });

  test('M1.3/R8: version-garbage is treated as unknown, not a hard failure', async function () {
    this.timeout(15000);
    await withScenario('version-garbage', async () => {
      await services().sdk.refresh();
      const info = services().sdk.current();
      assert.ok(info, 'expected sdk info even with an unparseable version');
      assert.strictEqual(info?.version, 'unknown');
      assert.strictEqual(services().contextKeys.get('sailfish.sdkAvailable'), true);
    });
  });

  test('M1.3: version-unknown-format extracts a leading MAJOR.MINOR.PATCH prefix', async function () {
    this.timeout(15000);
    await withScenario('version-unknown-format', async () => {
      await services().sdk.refresh();
      const info = services().sdk.current();
      assert.strictEqual(info?.version, '4.0.0');
    });
  });

  test('M1.4: changing sailfish.sdkPath re-runs the version probe (a second --version in the fake log)', async function () {
    this.timeout(15000);
    await services().sdk.refresh();
    const root = services().sdk.current()?.root;
    assert.ok(root, 'expected sdk to already be discovered');
    clearFakeLog();
    await setSdkPathSetting(root);
    await waitFor(() => readFakeLog().invocations.filter((i) => i.argv.includes('--version')).length >= 1, 8000);
  });
});
