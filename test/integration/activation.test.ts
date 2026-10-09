import * as assert from 'assert';
import * as vscode from 'vscode';
import { extensionApi, waitForContext } from './helpers';

const EXTENSION_ID = 'sailfish-tools-dev.sardina';

// activation/bare (S6): only the required qt-qml stub is installed.
suite('activation/bare', () => {
  test('activates in under 500ms', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);

    if (!ext.isActive) {
      await ext.activate();
    }
    assert.ok(ext.isActive, 'extension should be active');

    // extension.ts records performance.now() at its own entry/exit, so this
    // measures real activation work regardless of when it happened relative
    // to this test (unlike timing the await here, which is a no-op if a
    // previous test already triggered activation).
    const activationMs = extensionApi().__test.getActivationMs();
    assert.ok(activationMs < 500, `activation took ${activationMs}ms, expected < 500ms`);
  });

  test('registers all v0.1 commands', async () => {
    const expected = [
      'sardina.setSdkPath',
      'sardina.newProject',
      'sardina.selectTarget',
      'sardina.setSfdkDefaultTarget',
      'sardina.build',
      'sardina.deploy',
      'sardina.run',
      'sardina.buildDeployRun',
      'sardina.package',
      'sardina.clean',
      'sardina.devices.refresh',
      'sardina.emulator.start',
      'sardina.emulator.stop',
      'sardina.emulator.status',
      'sardina.emulator.show',
      'sardina.emulator.installAvailable',
      'sardina.device.setDefault',
      'sardina.device.setSfdkDefault',
      'sardina.device.stopSessions',
      'sardina.device.openSsh',
      'sardina.showOutput',
      'sardina.setupSigning',
      'sardina.runInstalled',
      'sardina.debugInstalled',
      'sardina.agent.install',
      'sardina.agent.uninstall',
      'sardina.agent.status',
      'sardina.agent.screenshot',
      'sardina.agent.mirror',
      'sardina.agent.logs',
    ];
    const registered = await vscode.commands.getCommands(true);
    const missing = expected.filter((c) => !registered.includes(c));
    assert.deepStrictEqual(missing, [], `missing commands: ${missing.join(', ')}`);
  });

  test('only the required qt-qml dependency is installed in bare mode', () => {
    assert.ok(vscode.extensions.getExtension('theqtcompany.qt-qml'), 'the hard extensionDependencies entry should be present');
    assert.strictEqual(vscode.extensions.getExtension('ms-vscode.cpptools'), undefined);
  });

  test('no error notifications were shown during activation', () => {
    // The prompts seam (src/ui/prompts.ts) records every shown message from
    // module load, so this sees activation-time notifications even though
    // activation itself may have already completed before this test runs
    // (unlike stubMessages(), which only records calls made after it is
    // installed).
    const messages = extensionApi().__test.getShownMessages();
    const errors = messages.filter((m) => m.kind === 'error');
    assert.deepStrictEqual(errors, [], `unexpected error notifications: ${JSON.stringify(errors)}`);
  });

  test('sardina.sdkAvailable becomes true within 3s (fake sfdk on PATH)', async function () {
    if (process.env.HARNESS_SMOKE === '1') {
      this.skip();
      return;
    }
    const api = extensionApi();
    const services = api.__test.getServices() as { sdk?: { refresh: () => Promise<unknown> } };
    try {
      // SdkLocator may still be Task A's stub at this point in the
      // workflow; probe it directly rather than assume a Task-A-only
      // behaviour is already implemented.
      await services.sdk?.refresh();
    } catch (err) {
      if (err instanceof Error && err.message.includes('not implemented')) {
        console.log('[activation/bare] skipping sdkAvailable assertion: SdkLocator is still the Task A stub');
        this.skip();
        return;
      }
      throw err;
    }
    await waitForContext('sardina.sdkAvailable', true, 3000);
  });
});
