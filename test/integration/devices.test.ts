import * as assert from 'assert';
import * as vscode from 'vscode';
import { clearFakeLog, extensionApi, forceDeviceReachability, readFakeLog, restoreAllStubs, stubMessages, stubQuickPick, waitFor, waitForContext, withScenario } from './helpers';
import { DeviceTreeItem, type DevicesTreeDataProvider } from '../../src/devices/tree';
import type { Services } from '../../src/core/services';
import type { SfdkDeviceInfo } from '../../src/core/types';

/**
 * Devices integration suite (FR-6.2/6.4-6.8, AC-1.8/1.9, R6/R25/M1.21); only discovered when TEST_MODE != 'bare'.
 * Tree-item assertions use structural checks (contextValue / a `.device` field), never `instanceof` against a
 * class imported here, since the running extension loads a separate compiled copy of src/devices/tree.
 */

interface ExtensionApiWithDevices {
  __test: {
    getServices: () => Services;
    getDevicesProvider: () => DevicesTreeDataProvider;
  };
}

function api(): ExtensionApiWithDevices {
  return extensionApi() as unknown as ExtensionApiWithDevices;
}

function provider(): DevicesTreeDataProvider {
  return api().__test.getDevicesProvider();
}

function services(): Services {
  return api().__test.getServices();
}

async function sfdkReady(): Promise<boolean> {
  try {
    await waitForContext('sardina.sdkAvailable', true, 5000);
  } catch {
    return false;
  }
  try {
    await services().runner.run({ args: ['emulator', 'list'], ensureEngine: false });
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes('not implemented')) {
      return false;
    }
    throw err;
  }
}

function deviceOf(item: vscode.TreeItem | undefined): SfdkDeviceInfo | undefined {
  const device = (item as { device?: unknown } | undefined)?.device;
  if (device && typeof device === 'object' && typeof (device as SfdkDeviceInfo).name === 'string') {
    return device as SfdkDeviceInfo;
  }
  return undefined;
}

function isListErrorItem(item: vscode.TreeItem): boolean {
  return item.contextValue === 'devices-list-error';
}

function isEmptyStateItem(item: vscode.TreeItem): boolean {
  return item.contextValue === 'devices-empty';
}


function fakeDevice(overrides: Partial<SfdkDeviceInfo> & Pick<SfdkDeviceInfo, 'name'>): SfdkDeviceInfo {
  return { index: 0, kind: 'hardware-device', origin: 'user-defined', flags: [], extra: [], ...overrides };
}

/** Waits for the real onDidChangeTreeData fire, since only that UI notification (not the cache clear) is debounced (FR-6.7). */
function refreshAndWait(p: DevicesTreeDataProvider): Promise<void> {
  return new Promise((resolve) => {
    const sub = p.onDidChangeTreeData(() => {
      sub.dispose();
      resolve();
    });
    p.refresh();
  });
}

suite('devices (FR-6, AC-1.8/1.9)', () => {
  let ready = false;

  suiteSetup(async function () {
    ready = await sfdkReady();
    if (!ready) {
      console.log('[devices] SfdkRunner is still unimplemented; skipping sfdk-backed device assertions');
    }
  });

  suiteTeardown(async function () {
    // Safety net: setDefault tests restore this themselves, but guarantee it never leaks past the suite.
    this.timeout(15000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.workspace.getConfiguration('sardina', folder?.uri).update('device', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  });

  test('FR-6.7: a list failure never yields an empty root (holds even against the current SfdkRunner stub)', async () => {
    await refreshAndWait(provider());
    const roots = await provider().getChildren();
    assert.ok(roots && roots.length === 3, 'expected Emulators, Devices and SDK roots');

    const emulatorsChildren = await provider().getChildren(roots[0]);
    assert.ok(emulatorsChildren && emulatorsChildren.length >= 1, 'root must never render with zero children unexplained');
    if (!ready) {
      assert.ok(
        emulatorsChildren.some((c) => isListErrorItem(c)),
        'expected a "Could not list" child while SfdkRunner is unimplemented',
      );
    }
  });

  test('the Devices view has the two groups Emulators and Devices as roots (emulators are merged into it)', async () => {
    await refreshAndWait(provider());
    const roots = (await provider().section('devices').getChildren(undefined)) ?? [];
    assert.deepStrictEqual(
      roots.map((r) => r.label),
      ['Emulators', 'Devices'],
    );
  });

  test('SDK root lists location, sfdk, build engine and build targets from the fake sfdk', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    await withScenario('default', async () => {
      const p = provider();
      await refreshAndWait(p);
      const roots = (await p.getChildren()) ?? [];
      const sdkRoot = roots[2];
      assert.strictEqual(sdkRoot.label, 'SDK');
      assert.strictEqual(sdkRoot.contextValue, 'devices-root-sdk');
      const children = (await p.getChildren(sdkRoot)) ?? [];
      assert.deepStrictEqual(
        children.map((c) => c.label),
        ['Build engine', 'Build targets'],
      );
      assert.strictEqual(children[0].contextValue, 'sdk-engine.running');
      const targets = (await p.getChildren(children[1])) ?? [];
      assert.ok(targets.length > 0 && targets.every((t) => t.contextValue === 'sdk-target'));
    });
  });

  test('AC-1.8: Emulators/Devices roots render exact labels/descriptions from the fake sfdk', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    await withScenario('default', async () => {
      const p = provider();
      await refreshAndWait(p);
      const roots = await p.getChildren();
      assert.ok(roots);
      const [emulatorsRoot, devicesRoot] = roots;

      const emulatorChildren = await p.getChildren(emulatorsRoot);
      assert.ok(emulatorChildren);
      const installed = emulatorChildren.filter((c) => deviceOf(c));
      assert.strictEqual(installed.length, 2, 'the "available" superset entry must not appear at the top level');
      // The default fixture carries no `default` flag and sardina.device is unset, so no "✓ default" yet.
      // The state marker depends on whether anything answers on the emulator's SSH port, so it is optional.
      assert.strictEqual(installed[0].label, '"Sailfish OS Emulator 4.4.0.58"');
      assert.match(
        String(installed[0].description),
        /^(?:(?:● running|○ stopped) · )?emulator autodetected defaultuser@127\.0\.0\.1:2223$/,
      );
      const tooltip = installed[0].tooltip;
      assert.ok(typeof tooltip === 'string' && tooltip.includes('private-key: /Users/mersdk/.ssh/sdk'));
      assert.match(String(installed[0].contextValue), /^emulator(\.(running|stopped))?$/);

      assert.ok(
        !emulatorChildren.some((c) => c.contextValue === 'devices-root-available' || c.label === 'Available to install'),
        'the Emulators group has no "Available to install" child',
      );

      const deviceChildren = await p.getChildren(devicesRoot);
      assert.ok(deviceChildren);
      const hw = deviceChildren.find((c) => deviceOf(c)?.kind === 'hardware-device');
      assert.ok(hw);
      assert.strictEqual(hw.label, '"Xperia 10 - Dual SIM (ARM)"');
      assert.match(
        String(hw.description),
        /^(?:(?:● connected|○ offline) · )?hardware-device user-defined defaultuser@192\.168\.2\.15:22$/,
      );
      assert.strictEqual(hw.contextValue, 'hardware-device');
    });
  });

  test('AC-1.8: "✓ default" appears in the description once sardina.device matches the emulator name', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    // FR-2.3-fixture-mutation: Global scope, so this test never writes into
    // the shared qml-app fixture's .vscode/settings.json.
    const config = vscode.workspace.getConfiguration('sardina', folder?.uri);
    await withScenario('default', async () => {
      await config.update('device', 'Sailfish OS Emulator 4.4.0.58', vscode.ConfigurationTarget.Global);
      try {
        const p = provider();
        await refreshAndWait(p);
        const emulatorChildren = await p.getChildren((await p.getChildren())![0]);
        const target = emulatorChildren!.find((c) => deviceOf(c));
        assert.strictEqual(target!.label, '"Sailfish OS Emulator 4.4.0.58"');
        assert.match(String(target!.description), /^(?:(?:● running|○ stopped) · )?✓ default · emulator autodetected /);
        const others = emulatorChildren!.filter((c) => deviceOf(c) && c !== target);
        assert.ok(others.every((c) => !String(c.description).includes('✓ default')), 'only the matching emulator is marked default');
      } finally {
        await config.update('device', undefined, vscode.ConfigurationTarget.Global);
      }
    });
  });

  test('AC-1.8: emulator.start issues a single verbatim argv element and refreshes the tree', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(30000);
    await withScenario('default', async () => {
      clearFakeLog();
      const p = provider();
      await refreshAndWait(p);
      const emulatorChildren = await p.getChildren((await p.getChildren())![0]);
      const target = emulatorChildren!.find((c) => deviceOf(c))!;
      // The fake emulator's endpoint is 127.0.0.1:2223, the real Sailfish OS emulator's SSH port. When that
      // emulator runs on this machine, the reachability probe marks the fake one running and start is
      // (correctly) skipped as "already running". Drop the endpoint so this checks argv and refresh only.
      const startItem = { device: { ...deviceOf(target)!, host: undefined, port: undefined } };

      let changeFired = false;
      const changeSub = p.onDidChangeTreeData(() => {
        changeFired = true;
      });

      await vscode.commands.executeCommand('sardina.emulator.start', startItem);
      await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'emulator_start'), 5000);

      const afterStart = readFakeLog();
      const start = afterStart.invocations.find((i) => i.key === 'emulator_start');
      assert.ok(start);
      assert.deepStrictEqual(start.argv.filter((a) => a !== '--no-pager'), [
        'emulator',
        'start',
        'Sailfish OS Emulator 4.4.0.58',
      ]);
      assert.strictEqual(
        start.argv.filter((a) => a === 'Sailfish OS Emulator 4.4.0.58').length,
        1,
        'the device name must appear exactly once, as a single argv element',
      );

      // FR-6.7: start must trigger onDidChangeTreeData; the debounce can push it up to ~2s beyond refreshAndWait's own fetch.
      await waitFor(() => changeFired, 9000);
      const rootsAfter = await p.getChildren();
      await p.getChildren(rootsAfter![0]);
      await p.getChildren(rootsAfter![1]);

      await waitFor(() => readFakeLog().invocations.filter((i) => i.key === 'emulator_list').length >= 2, 5000);
      await waitFor(() => readFakeLog().invocations.filter((i) => i.key === 'device_list').length >= 2, 5000);
      assert.ok(changeFired, 'expected provider.onDidChangeTreeData to fire after a refresh');
      changeSub.dispose();
    });
  });

  test('AC-1.9: localized device list (SFDK_FAKE_FORCE_LOCALIZED=1) still parses (recognised private-key line, only the preamble is unknown)', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    const prevForce = process.env.SFDK_FAKE_FORCE_LOCALIZED;
    process.env.SFDK_FAKE_FORCE_LOCALIZED = '1';
    try {
      await withScenario('localized', async () => {
        const p = provider();
        await refreshAndWait(p);
        const roots = await p.getChildren();
        const devicesChildren = await p.getChildren(roots![1]);
        assert.ok(devicesChildren && devicesChildren.length > 0);
        assert.ok(!devicesChildren.some((c) => isListErrorItem(c)), 'the Devices root has a recognised private-key line and must still parse');
      });
    } finally {
      if (prevForce === undefined) delete process.env.SFDK_FAKE_FORCE_LOCALIZED;
      else process.env.SFDK_FAKE_FORCE_LOCALIZED = prevForce;
    }
  });

  test('AC-1.9: localized emulator list (SFDK_FAKE_FORCE_LOCALIZED=1) renders "Could not list", not silently-empty private keys', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    const prevForce = process.env.SFDK_FAKE_FORCE_LOCALIZED;
    process.env.SFDK_FAKE_FORCE_LOCALIZED = '1';
    try {
      await withScenario('localized', async () => {
        const p = provider();
        await refreshAndWait(p);
        const roots = await p.getChildren();
        const emulatorsChildren = await p.getChildren(roots![0]);
        assert.ok(emulatorsChildren);
        assert.ok(
          emulatorsChildren.some((c) => isListErrorItem(c)),
          'every record only carries the unrecognised German "privater-schluessel:"/"status: läuft nicht" keys and no private-key line; this must render "Could not list", never silently render with private-key: (none)',
        );
      });
    } finally {
      if (prevForce === undefined) delete process.env.SFDK_FAKE_FORCE_LOCALIZED;
      else process.env.SFDK_FAKE_FORCE_LOCALIZED = prevForce;
    }
  });

  test('R6: device-list-empty renders an explicit empty state, not an error', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    await withScenario('device-list-empty', async () => {
      const p = provider();
      await refreshAndWait(p);
      const roots = await p.getChildren();
      const devicesChildren = await p.getChildren(roots![1]);
      assert.ok(devicesChildren && devicesChildren.length === 1);
      assert.ok(isEmptyStateItem(devicesChildren[0]));
    });
  });

  test('R6: device-list-malformed renders "Could not list" (fail-soft ok:false, per its PROVENANCE.md)', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    await withScenario('device-list-malformed', async () => {
      const p = provider();
      await refreshAndWait(p);
      const roots = await p.getChildren();
      const devicesChildren = await p.getChildren(roots![1]);
      assert.ok(devicesChildren && devicesChildren.some((c) => isListErrorItem(c)));
    });
  });

  test('emulator-vbox-missing: VBoxManage absence never throws through correlateVm', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    const { correlateVm } = await import('../../src/devices/vmCorrelation');
    await withScenario('emulator-vbox-missing', async () => {
      const device = fakeDevice({ name: 'Sailfish OS Emulator 4.4.0.58', kind: 'emulator', origin: 'autodetected' });
      await assert.doesNotReject(() => correlateVm(services(), device));
    });
  });

  test('M1.24: emulator-vbox-missing renders "Could not list" with guidance under Emulators, while build still works', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    await withScenario('emulator-vbox-missing', async () => {
      const p = provider();
      await refreshAndWait(p);
      const roots = await p.getChildren();
      const emulatorsChildren = await p.getChildren(roots![0]);
      assert.ok(emulatorsChildren);
      const errorItem = emulatorsChildren.find((c) => isListErrorItem(c));
      assert.ok(errorItem, 'expected a "Could not list" node under Emulators when VBoxManage/emulator list fails');
      assert.ok(
        typeof errorItem.tooltip === 'string' && /virtualbox not found/i.test(errorItem.tooltip),
        'expected actionable VirtualBox guidance in the tooltip',
      );

      // Devices still lists fine (its fixtures are untouched by this scenario).
      const devicesChildren = await p.getChildren(roots![1]);
      assert.ok(devicesChildren && devicesChildren.some((c) => deviceOf(c)));

      const build = await services().runner.run({ args: ['build'], ensureEngine: false });
      assert.strictEqual(build.exitCode, 0, 'build must still succeed under emulator-vbox-missing');
    });
  });

  test('FR-6.4/R34: a failed emulator start shows an error notification with a "Show Output" action', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    await withScenario('emulator-vbox-missing', async () => {
      const messages = stubMessages();
      const item = new DeviceTreeItem(
        fakeDevice({ name: 'Sailfish OS Emulator 4.4.0.58', kind: 'emulator', origin: 'autodetected' }),
        false,
      );
      await vscode.commands.executeCommand('sardina.emulator.start', item);
      await waitFor(() => messages.calls.some((c) => c.kind === 'error'), 5000);
      const error = messages.calls.find((c) => c.kind === 'error');
      assert.ok(error, 'expected an error notification for the failed start');
      assert.ok(error.items.includes('Show Output'), 'R34: every error notification must offer an action');
    });
  });

  test('S12: emulator.installAvailable (title button) picks and installs, with argv ["emulator","install",<name>]', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    await withScenario('default', async () => {
      clearFakeLog();
      const p = provider();
      await refreshAndWait(p);
      const emulatorChildren = await p.getChildren((await p.getChildren())![0]);
      assert.ok(!emulatorChildren!.some((c) => c.contextValue === 'devices-root-available'));
      const picks: string[][] = [];
      stubQuickPick((items: readonly string[]) => {
        picks.push([...items]);
        return items.find((n) => n === 'Sailfish OS Emulator 4.5.0.24');
      });

      await vscode.commands.executeCommand('sardina.emulator.installAvailable');
      await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'emulator_install'), 5000);
      assert.ok(picks[0]?.includes('Sailfish OS Emulator 4.5.0.24'), 'the picker lists the available emulators');
      const install = readFakeLog().invocations.find((i) => i.key === 'emulator_install');
      assert.deepStrictEqual(install!.argv.filter((a) => a !== '--no-pager'), [
        'emulator',
        'install',
        'Sailfish OS Emulator 4.5.0.24',
      ]);
    });
  });

  test('S12: a failed emulator install shows an error notification', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    await withScenario('emulator-vbox-missing', async () => {
      const messages = stubMessages();
      const item = new DeviceTreeItem(fakeDevice({ name: 'Sailfish OS Emulator 4.5.0.24', kind: 'emulator', origin: 'autodetected' }), false);
      await vscode.commands.executeCommand('sardina.emulator.installAvailable', item);
      await waitFor(() => messages.calls.some((c) => c.kind === 'error'), 5000);
      const error = messages.calls.find((c) => c.kind === 'error');
      assert.ok(error);
      assert.ok(error.items.includes('Show Output'));
    });
  });

  // writeDefaultDeviceSetting always targets workspaceFolders[0] (out-of-scope to redirect); each entry restores immediately to minimize exposure.
  test('R25: injection corpus through device.setDefault writes the name verbatim, with zero sfdk config invocations', async () => {
    const corpus = ['; rm -rf /', '$(id)', '`id`', '"quoted"', "'quoted'", '--malicious-flag', '-', '\n', 'a'.repeat(10240)];
    const folder = vscode.workspace.workspaceFolders?.[0];
    try {
      for (const name of corpus) {
        clearFakeLog();
        const item = new DeviceTreeItem(fakeDevice({ name }), false);
        await vscode.commands.executeCommand('sardina.device.setDefault', item);
        const configured = vscode.workspace.getConfiguration('sardina', folder?.uri).get<string>('device');
        assert.strictEqual(configured, name, `expected verbatim device name for corpus entry ${JSON.stringify(name)}`);
        const { invocations } = readFakeLog();
        assert.strictEqual(
          invocations.filter((i) => i.key.startsWith('config_set')).length,
          0,
          'device.setDefault must never call sfdk config',
        );
        await vscode.workspace.getConfiguration('sardina', folder?.uri).update('device', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      }
    } finally {
      await vscode.workspace.getConfiguration('sardina', folder?.uri).update('device', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });

  test('R25: injection corpus through emulator.start reaches sfdk as exactly 1 argv element; option-like names are rejected', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    const corpus = [
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
    await withScenario('default', async () => {
      for (const name of corpus) {
        clearFakeLog();
        restoreAllStubs();
        const messages = stubMessages();
        const item = new DeviceTreeItem(fakeDevice({ name, kind: 'emulator', origin: 'autodetected' }), false);
        await vscode.commands.executeCommand('sardina.emulator.start', item);

        if (name.startsWith('-')) {
          await waitFor(() => messages.calls.some((c) => c.kind === 'error'), 5000);
          assert.strictEqual(
            readFakeLog().invocations.length,
            0,
            `option-like name ${JSON.stringify(name)} must be rejected before it reaches sfdk`,
          );
          const error = messages.calls.find((c) => c.kind === 'error');
          assert.ok(error && error.items.includes('Show Output'));
          continue;
        }

        await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'emulator_start'), 5000);
        // Filters out the tree's own background list refresh (provider.refresh(), FR-6.7), not under test here.
        const starts = readFakeLog().invocations.filter((i) => i.key === 'emulator_start');
        assert.strictEqual(starts.length, 1, `expected exactly 1 emulator_start invocation for ${JSON.stringify(name)}`);
        assert.strictEqual(
          starts[0].argv.filter((a) => a === name).length,
          1,
          `expected ${JSON.stringify(name)} to appear exactly once as one argv element`,
        );
      }
    });
  });

  test('R25: injection corpus through device.setSfdkDefault reaches sfdk as `device=<value>`, verbatim', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    const corpus = [
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
    const folder = vscode.workspace.workspaceFolders?.[0];
    try {
      await withScenario('default', async () => {
        for (const name of corpus) {
          clearFakeLog();
          const item = new DeviceTreeItem(fakeDevice({ name, kind: 'emulator', origin: 'autodetected' }), false);
          await vscode.commands.executeCommand('sardina.device.setSfdkDefault', item);
          await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'config_set_global'), 5000);
          // Filters out the tree's own background list refresh (provider.refresh(), FR-6.7), not under test here.
          const configSets = readFakeLog().invocations.filter((i) => i.key === 'config_set_global');
          assert.strictEqual(configSets.length, 1, `expected exactly 1 config_set_global invocation for ${JSON.stringify(name)}`);
          assert.strictEqual(
            configSets[0].argv.filter((a) => a === `device=${name}`).length,
            1,
            `expected device=${JSON.stringify(name)} to appear exactly once as one argv element`,
          );
          await vscode.workspace.getConfiguration('sardina', folder?.uri).update('device', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        }
      });
    } finally {
      await vscode.workspace.getConfiguration('sardina', folder?.uri).update('device', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });

  test('M1.21: non-ASCII device name survives setDefault verbatim', async () => {
    const name = 'Xperia 10 III – 日本語';
    const folder = vscode.workspace.workspaceFolders?.[0];
    try {
      const item = new DeviceTreeItem(fakeDevice({ name }), false);
      await vscode.commands.executeCommand('sardina.device.setDefault', item);
      const configured = vscode.workspace.getConfiguration('sardina', folder?.uri).get<string>('device');
      assert.strictEqual(configured, name);
    } finally {
      await vscode.workspace.getConfiguration('sardina', folder?.uri).update('device', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });

  test('R25/M1.24: setSfdkDefault issues the config argv exactly once, verbatim', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    try {
      await withScenario('default', async () => {
        clearFakeLog();
        const name = '日本語 café $(id)';
        const item = new DeviceTreeItem(fakeDevice({ name, kind: 'emulator', origin: 'autodetected' }), false);
        await vscode.commands.executeCommand('sardina.device.setSfdkDefault', item);
        await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'config_set_global'), 5000);
        const { invocations } = readFakeLog();
        const configSets = invocations.filter((i) => i.key === 'config_set_global');
        assert.strictEqual(configSets.length, 1);
        assert.strictEqual(configSets[0].argv.filter((a) => a === `device=${name}`).length, 1);
      });
    } finally {
      await vscode.workspace.getConfiguration('sardina', folder?.uri).update('device', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });

  test('installTools on an offline device says so (Open Devices view / Retry) and never runs the check or an install', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(20000);
    const restoreReachability = forceDeviceReachability(false);
    try {
      await withScenario('default', async () => {
        clearFakeLog();
        const messages = stubMessages();
        const name = 'Xperia 10 - Dual SIM (ARM)';
        await vscode.commands.executeCommand('sardina.device.installTools', { device: { name } });
        const warning = messages.calls.find((c) => c.kind === 'warning');
        assert.ok(warning, JSON.stringify(messages.calls));
        assert.strictEqual(warning.message, `Sardina: "${name}" is offline — connect it (USB or Wi-Fi, Developer Mode on) and try again.`);
        assert.deepStrictEqual(warning.items, ['Open Devices view', 'Retry']);
        const execs = readFakeLog().invocations.filter((i) => i.key.startsWith('device_exec'));
        assert.deepStrictEqual(execs.map((i) => i.key), [], 'no check, no devel-su');
        assert.ok(!messages.calls.some((c) => /Installing only these|installed/.test(c.message)), JSON.stringify(messages.calls));
      });
    } finally {
      restoreReachability();
      restoreAllStubs();
    }
  });
});
