import * as assert from 'assert';
import * as vscode from 'vscode';
import { clearFakeLog, readFakeLog, stubMessages, waitFor, waitForContext, withScenario, type FakeInvocation } from './helpers';

/**
 * Screen mirror integration suite (device-agent/PLAN-phase2a-mirror.md M5): sardina.agent.mirror against the
 * fake sfdk. The default scenario's agent reports 1.0.0, so the live-stream tests use `agent-new` (ping 1.1.0;
 * the mirror stream itself comes from default/ and hangs until killed). Only discovered when TEST_MODE != 'bare'.
 */

const DEVICE = 'Xperia 10 - Dual SIM (ARM)';
const TITLE = `Mirror: ${DEVICE}`;
const MIRROR = 'device_exec.sailfish-devagent.mirror';

function mirrorRuns(): FakeInvocation[] {
  return readFakeLog().invocations.filter((i) => i.key === MIRROR);
}

function keys(): string[] {
  return readFakeLog().invocations.map((i) => i.key);
}

function mirrorTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === TITLE);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

suite('screen mirror (M5)', () => {
  suiteSetup(async function () {
    this.timeout(15000);
    await waitForContext('sardina.sdkAvailable', true, 10000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.workspace.getConfiguration('sardina', folder?.uri).update('device', DEVICE, vscode.ConfigurationTarget.WorkspaceFolder);
  });

  suiteTeardown(async function () {
    this.timeout(15000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.workspace.getConfiguration('sardina', folder?.uri).update('device', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  });

  teardown(async function () {
    this.timeout(15000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // Let the stopped stream's kill land before the log is wiped.
    await sleep(300);
    clearFakeLog();
  });

  test('open: probes the agent, starts the mirror request with the default options, opens one titled tab', async function () {
    this.timeout(20000);
    await withScenario('agent-new', async () => {
      const messages = stubMessages();
      await vscode.commands.executeCommand('sardina.agent.mirror');
      await waitFor(() => mirrorRuns().length > 0, 5000);
      const log = keys();
      assert.ok(log.indexOf('device_exec.sailfish-devagent.ping') >= 0 && log.indexOf('device_exec.sailfish-devagent.ping') < log.indexOf(MIRROR), JSON.stringify(log));
      const argv = mirrorRuns()[0].argv;
      const at = argv.indexOf('--fps');
      assert.ok(at >= 0, JSON.stringify(argv));
      assert.deepStrictEqual(argv.slice(at, at + 6), ['--fps', '4', '--width', '360', '--quality', '60'], JSON.stringify(argv));
      assert.strictEqual(mirrorTabs().length, 1, JSON.stringify(vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label))));
      assert.ok(!messages.calls.some((m) => m.kind === 'error'), JSON.stringify(messages.calls));
    });
  });

  test('reveal, not duplicate: a second command run keeps one tab and starts no second stream', async function () {
    this.timeout(20000);
    await withScenario('agent-new', async () => {
      stubMessages();
      await vscode.commands.executeCommand('sardina.agent.mirror');
      await waitFor(() => mirrorRuns().length === 1, 5000);
      await vscode.commands.executeCommand('sardina.agent.mirror');
      await sleep(2000);
      assert.strictEqual(mirrorTabs().length, 1);
      assert.strictEqual(mirrorRuns().length, 1, JSON.stringify(keys()));
    });
  });

  test('close stops the stream: the fake sees SIGTERM', async function () {
    this.timeout(20000);
    await withScenario('agent-new', async () => {
      stubMessages();
      await vscode.commands.executeCommand('sardina.agent.mirror');
      await waitFor(() => mirrorRuns().length === 1, 5000);
      await vscode.commands.executeCommand('sardina.agent.mirror'); // reveals it, making it the active editor
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await waitFor(() => readFakeLog().killed.some((k) => k.key === MIRROR), 8000);
      assert.strictEqual(mirrorTabs().length, 0);
    });
  });

  test('hidden pauses the stream, visible resumes it', async function () {
    this.timeout(30000);
    await withScenario('agent-new', async () => {
      stubMessages();
      await vscode.commands.executeCommand('sardina.agent.mirror');
      await waitFor(() => mirrorRuns().length === 1, 5000);
      const column = mirrorTabs()[0]?.group.viewColumn;
      assert.ok(column !== undefined, 'no mirror tab');
      const doc = await vscode.workspace.openTextDocument({ content: 'x' });
      await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
      await waitFor(() => readFakeLog().killed.some((k) => k.key === MIRROR), 5000);
      await vscode.commands.executeCommand('sardina.agent.mirror'); // reveals the panel
      await waitFor(() => mirrorRuns().length >= 2, 5000);
    });
  });

  test('old agent: warns with the needed version and an install action, starts no stream', async function () {
    this.timeout(20000);
    await withScenario('agent-old', async () => {
      const messages = stubMessages();
      await vscode.commands.executeCommand('sardina.agent.mirror');
      const warning = messages.calls.find((m) => m.kind === 'warning');
      assert.ok(warning && warning.message.includes('1.1.0'), JSON.stringify(messages.calls));
      assert.ok(warning.items.includes('Install Device Agent'), JSON.stringify(warning));
      assert.strictEqual(mirrorRuns().length, 0, JSON.stringify(keys()));
      assert.strictEqual(mirrorTabs().length, 0);
    });
  });

  test('Developer Mode off: clear error, no stream', async function () {
    this.timeout(20000);
    await withScenario('agent-devmode-off', async () => {
      const messages = stubMessages();
      await vscode.commands.executeCommand('sardina.agent.mirror');
      const error = messages.calls.find((m) => m.kind === 'error');
      assert.ok(error?.message.includes('Developer Mode is off'), JSON.stringify(messages.calls));
      assert.strictEqual(mirrorRuns().length, 0, JSON.stringify(keys()));
    });
  });

  test('missing agent: offers the install, installs nothing unasked', async function () {
    this.timeout(20000);
    await withScenario('agent-missing', async () => {
      const messages = stubMessages();
      await vscode.commands.executeCommand('sardina.agent.mirror');
      const warning = messages.calls.find((m) => m.kind === 'warning');
      assert.ok(warning?.items.includes('Install Device Agent'), JSON.stringify(messages.calls));
      assert.ok(!keys().includes('device_exec.devel-su'), JSON.stringify(keys()));
      assert.strictEqual(mirrorRuns().length, 0);
    });
  });
});
