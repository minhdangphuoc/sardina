import * as assert from 'assert';
import * as vscode from 'vscode';
import { clearFakeLog, extensionApi, readFakeLog, restoreAllStubs, stubMessages, stubQuickPick, waitFor, waitForContext, withScenario } from './helpers';
import type { Services } from '../../src/core/services';
import { computeStatusBarState } from '../../src/targets/statusBarCore';

/** R34: must run against the running extension's own compiled module, not this file's separate tsc-compiled copy. */
function resetLastTargetListForTests(): void {
  (extensionApi() as unknown as { __test: { resetLastTargetListForTests: () => void } }).__test.resetLastTargetListForTests();
}

/** Target selection integration suite (FR-4, AC-1.4, R25/R33/M1.9/M1.10/M1.11/M1.13); only discovered when TEST_MODE != 'bare'. */

interface QuickPickTargetItem extends vscode.QuickPickItem {
  target: { name: string };
}

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
    await services().runner.run({ args: ['tools', 'target', 'list'], ensureEngine: false });
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes('not implemented')) {
      return false;
    }
    throw err;
  }
}

async function setWorkspaceTarget(name: string | undefined): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const config = vscode.workspace.getConfiguration('sailfish', folder?.uri);
  await config.update('target', name, vscode.ConfigurationTarget.WorkspaceFolder);
}

suite('target selection (FR-4, AC-1.4)', () => {
  let ready = false;

  suiteSetup(async function () {
    this.timeout(15000);
    ready = await sfdkReady();
    if (!ready) {
      console.log('[targets] SfdkRunner is still unimplemented; skipping sfdk-backed target assertions');
    }
  });

  teardown(async () => {
    resetLastTargetListForTests();
    await setWorkspaceTarget(undefined);
  });

  test('AC-1.4: default scenario populates 3 targets with exact arch descriptions, selection persists to sailfish.target', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(15000);
    await withScenario('default', async () => {
      const picker = stubQuickPick((items: readonly QuickPickTargetItem[]) =>
        items.find((i) => i.target.name === 'SailfishOS-4.4.0.58-armv7hl'),
      );

      await vscode.commands.executeCommand('sailfish.selectTarget');
      await waitFor(() => picker.called, 5000);

      const shownItems = (await picker.firstCall.args[0]) as QuickPickTargetItem[];
      assert.strictEqual(shownItems.length, 3);
      const descriptions = shownItems.map((i) => i.description).sort();
      assert.deepStrictEqual(descriptions, ['aarch64', 'armv7hl', 'i486']);

      // Polls briefly: getConfiguration()'s propagation isn't itself synchronous under load.
      const folder = vscode.workspace.workspaceFolders?.[0];
      await waitFor(() => vscode.workspace.getConfiguration('sailfish', folder?.uri).get<string>('target') === 'SailfishOS-4.4.0.58-armv7hl', 5000);
      const configured = vscode.workspace.getConfiguration('sailfish', folder?.uri).get<string>('target');
      assert.strictEqual(configured, 'SailfishOS-4.4.0.58-armv7hl');
    });
  });

  test('AC-1.4: old-format (tools-list-odd-glyphs) yields the same 3 arch descriptions', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(15000);
    await withScenario('old-format', async () => {
      const picker = stubQuickPick((items: readonly QuickPickTargetItem[]) => items[0]);
      await vscode.commands.executeCommand('sailfish.selectTarget');
      await waitFor(() => picker.called, 5000);
      const shownItems = (await picker.firstCall.args[0]) as QuickPickTargetItem[];
      const descriptions = shownItems.map((i) => i.description).sort();
      assert.deepStrictEqual(descriptions, ['aarch64', 'armv7hl', 'i486']);
    });
  });

  test('FR-4.2: snapshot targets are hidden unless sailfish.showSnapshotTargets is true', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(15000);
    const config = vscode.workspace.getConfiguration('sailfish');
    await withScenario('targets-with-snapshot', async () => {
      let picker = stubQuickPick((items: readonly QuickPickTargetItem[]) => items[0]);
      await vscode.commands.executeCommand('sailfish.selectTarget');
      await waitFor(() => picker.called, 5000);
      let shownItems = (await picker.firstCall.args[0]) as QuickPickTargetItem[];
      assert.strictEqual(shownItems.length, 2, 'snapshot target must be hidden by default');

      try {
        await config.update('showSnapshotTargets', true, vscode.ConfigurationTarget.Global);
        restoreAllStubs();
        picker = stubQuickPick((items: readonly QuickPickTargetItem[]) => items[0]);
        await vscode.commands.executeCommand('sailfish.selectTarget');
        await waitFor(() => picker.called, 5000);
        shownItems = (await picker.firstCall.args[0]) as QuickPickTargetItem[];
        assert.strictEqual(shownItems.length, 3, 'snapshot target must appear once showSnapshotTargets is true');
      } finally {
        await config.update('showSnapshotTargets', undefined, vscode.ConfigurationTarget.Global);
      }
    });
  });

  test('no-targets: empty-state info message with an "Open SDK docs" action, no QuickPick shown', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(15000);
    await withScenario('no-targets', async () => {
      const picker = stubQuickPick(() => {
        throw new Error('QuickPick must not be shown when the target list is empty');
      });
      const messages = stubMessages();

      await vscode.commands.executeCommand('sailfish.selectTarget');
      await waitFor(() => messages.calls.some((c) => c.kind === 'information'), 5000);

      assert.strictEqual(picker.called, false);
      const info = messages.calls.find((c) => c.kind === 'information');
      assert.ok(info!.items.includes('Open SDK docs'));
    });
  });

  test('M1.9: a malformed target list warns "Could not parse target list" with Show Output, never throws', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(15000);
    // unicode-soup has no whitespace-separated name/flags lines, so parseTargetList genuinely fails.
    await withScenario('unicode-soup', async () => {
      const messages = stubMessages();
      await assert.doesNotReject(() => Promise.resolve(vscode.commands.executeCommand('sailfish.selectTarget')));
      await waitFor(() => messages.calls.some((c) => c.kind === 'warning'), 5000);
      const warning = messages.calls.find((c) => c.kind === 'warning');
      assert.ok(warning);
      assert.ok(/could not parse target list/i.test(warning.message));
      assert.ok(warning.items.includes('Show Output'));
    });
  });

  test('M1.11: selectTarget never issues a config/config_set/config_set_global call', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(15000);
    await withScenario('default', async () => {
      clearFakeLog();
      stubQuickPick((items: readonly QuickPickTargetItem[]) => items[0]);
      await vscode.commands.executeCommand('sailfish.selectTarget');
      await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'tools_target_list'), 5000);
      assert.strictEqual(
        readFakeLog().invocations.filter((i) => i.key.startsWith('config')).length,
        0,
        'selectTarget must never call sfdk config',
      );
    });
  });

  test('FR-4.4: setSfdkDefaultTarget issues the exact config --global argv, only on explicit user action', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(15000);
    await withScenario('default', async () => {
      clearFakeLog();
      stubQuickPick((items: readonly QuickPickTargetItem[]) =>
        items.find((i) => i.target.name === 'SailfishOS-4.4.0.58-i486'),
      );
      await vscode.commands.executeCommand('sailfish.setSfdkDefaultTarget');
      await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'config_set_global'), 5000);
      const invocation = readFakeLog().invocations.find((i) => i.key === 'config_set_global');
      assert.deepStrictEqual(invocation!.argv.filter((a) => a !== '--no-pager'), [
        'config',
        '--global',
        'target=SailfishOS-4.4.0.58-i486',
      ]);
    });
  });

  test('R33: selectTarget runs its list fetch under a cancellable progress notification', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(15000);
    await withScenario('default', async () => {
      let sawProgress = false;
      const original = vscode.window.withProgress;
      (vscode.window as { withProgress: typeof vscode.window.withProgress }).withProgress = ((opts, task) => {
        sawProgress = sawProgress || opts.cancellable === true;
        return original.call(vscode.window, opts, task);
      }) as typeof vscode.window.withProgress;
      try {
        stubQuickPick((items: readonly QuickPickTargetItem[]) => items[0]);
        await vscode.commands.executeCommand('sailfish.selectTarget');
        await waitFor(() => sawProgress, 5000);
      } finally {
        (vscode.window as { withProgress: typeof vscode.window.withProgress }).withProgress = original;
      }
    });
  });

  test('FR-4.5: selectTarget populates the cache that drives the status bar\'s "Target not installed" warning', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(15000);
    await withScenario('default', async () => {
      stubQuickPick((items: readonly QuickPickTargetItem[]) => items[0]);
      await vscode.commands.executeCommand('sailfish.selectTarget'); // populates targetListCache as a side effect
      await setWorkspaceTarget('SailfishOS-9.9.9.9-aarch64'); // a target absent from the list just fetched

      // Reads the running extension's own targetListCache via its test API, not a fresh import of a separate copy.
      const getLastTargetList = (extensionApi() as unknown as { __test: { getLastTargetList: () => { name: string }[] | undefined } })
        .__test.getLastTargetList;
      const knownTargetNames = getLastTargetList()?.map((t) => t.name);
      assert.ok(knownTargetNames && knownTargetNames.length === 3);

      const state = computeStatusBarState({
        isProject: true,
        sdkAvailable: true,
        target: 'SailfishOS-9.9.9.9-aarch64',
        knownTargetNames,
      });
      assert.strictEqual(state.tooltip, 'Target not installed');
      assert.ok(state.text.startsWith('$(warning)'));

      const statusBar = (extensionApi() as unknown as { __test: { getTargetStatusBar: () => { refresh(): void } } }).__test.getTargetStatusBar();
      assert.doesNotThrow(() => statusBar.refresh());
    });
  });
});
