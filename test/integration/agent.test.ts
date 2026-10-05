import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  clearFakeLog,
  readFakeLog,
  stubInputBox,
  stubMessages,
  stubSaveDialog,
  waitFor,
  waitForContext,
  withScenario,
  type FakeInvocation,
} from './helpers';

/**
 * Device agent integration suite (device-agent/PLAN.md T4): the sailfish.agent.* commands against the
 * fake sfdk (scenarios default, agent-missing, agent-devmode-off). Only discovered when TEST_MODE != 'bare'.
 */

const DEVICE = 'Xperia 10 - Dual SIM (ARM)';
const REMOTE_SHOT = '/run/user/100000/sailfish-devagent/shot-1759660000000.png';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function keys(): string[] {
  return readFakeLog().invocations.map((i) => i.key);
}

function find(key: string): FakeInvocation | undefined {
  return readFakeLog().invocations.find((i) => i.key === key);
}

function assertInOrder(actual: string[], expected: string[]): void {
  let from = 0;
  for (const key of expected) {
    const at = actual.indexOf(key, from);
    assert.ok(at >= 0, `expected ${key} (in order) in ${JSON.stringify(actual)}`);
    from = at + 1;
  }
}

suite('device agent (T4)', () => {
  let tmpDirs: string[] = [];

  suiteSetup(async function () {
    this.timeout(15000);
    await waitForContext('sailfish.sdkAvailable', true, 10000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.workspace.getConfiguration('sailfish', folder?.uri).update('device', DEVICE, vscode.ConfigurationTarget.WorkspaceFolder);
  });

  suiteTeardown(async function () {
    this.timeout(15000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.workspace.getConfiguration('sailfish', folder?.uri).update('device', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  });

  teardown(async () => {
    // The command opens the saved PNG in an editor; close it before the file disappears.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-agent-'));
    tmpDirs.push(dir);
    return dir;
  }

  test('status: reports the running agent and its version', async () => {
    const messages = stubMessages();
    clearFakeLog();
    await vscode.commands.executeCommand('sailfish.agent.status');
    assert.strictEqual(messages.calls.length, 1, JSON.stringify(messages.calls));
    assert.strictEqual(messages.calls[0].kind, 'information');
    assert.ok(messages.calls[0].message.includes('1.0.0') && messages.calls[0].message.includes('running'), messages.calls[0].message);
    assert.ok(keys().includes('device_exec.sailfish-devagent.ping'), JSON.stringify(keys()));
  });

  test('screenshot: saved to the chosen file, phone copy removed', async () => {
    const messages = stubMessages();
    const dir = tmpDir();
    const target = path.join(dir, 'shot.png');
    const dialog = stubSaveDialog(vscode.Uri.file(target));
    clearFakeLog();
    await vscode.commands.executeCommand('sailfish.agent.screenshot');

    const data = fs.readFileSync(target);
    assert.ok(data.subarray(0, 8).equals(PNG_MAGIC), 'saved file is not a PNG');
    assertInOrder(keys(), [
      'device_exec.sailfish-devagent.ping',
      'device_exec.sailfish-devagent.screenshot',
      'device_exec.base64',
      'device_exec.rm',
    ]);
    assert.ok(find('device_exec.rm')?.argv.includes(REMOTE_SHOT), JSON.stringify(find('device_exec.rm')?.argv));

    assert.strictEqual(dialog.callCount, 1);
    const defaultUri = (dialog.firstCall.args[0] as vscode.SaveDialogOptions).defaultUri;
    assert.ok(defaultUri, 'no defaultUri');
    assert.ok(defaultUri.fsPath.endsWith('.png'));
    assert.ok(path.basename(defaultUri.fsPath).startsWith('Xperia-10-Dual-SIM-ARM-'), defaultUri.fsPath);

    await waitFor(() => messages.calls.some((m) => m.message.includes('saved to')), 3000);
    const saved = messages.calls.find((m) => m.message.includes('saved to'));
    assert.strictEqual(saved?.kind, 'information');
    assert.deepStrictEqual(saved?.items, ['Reveal in folder']);
    assert.ok(!messages.calls.some((m) => m.kind === 'error'), JSON.stringify(messages.calls));
  });

  test('screenshot: cancelled save dialog writes nothing but still removes the phone copy', async () => {
    const messages = stubMessages();
    const dir = tmpDir();
    stubSaveDialog(undefined);
    clearFakeLog();
    await vscode.commands.executeCommand('sailfish.agent.screenshot');

    assert.deepStrictEqual(fs.readdirSync(dir), []);
    assert.ok(keys().includes('device_exec.rm'), JSON.stringify(keys()));
    assert.ok(find('device_exec.rm')?.argv.includes(REMOTE_SHOT));
    assert.ok(!messages.calls.some((m) => m.kind === 'error'), JSON.stringify(messages.calls));
  });

  test('screenshot: missing agent offers "Install Device Agent" and installs nothing unasked', async () => {
    await withScenario('agent-missing', async () => {
      const messages = stubMessages();
      stubSaveDialog(undefined);
      await vscode.commands.executeCommand('sailfish.agent.screenshot');
      const warning = messages.calls.find((m) => m.kind === 'warning');
      assert.ok(warning, JSON.stringify(messages.calls));
      assert.ok(warning.items.includes('Install Device Agent'), JSON.stringify(warning));
      assert.ok(!keys().includes('device_exec.devel-su'), JSON.stringify(keys()));
    });
  });

  test('install: architecture, copy, devel-su rpm -U, then a ping (scenario never changes, so it ends in an error)', async function () {
    this.timeout(30000);
    await withScenario('agent-missing', async () => {
      const messages = stubMessages();
      messages.chosenAction = 'Install Device Agent';
      stubInputBox('secret');
      await vscode.commands.executeCommand('sailfish.agent.screenshot');

      const log = keys();
      assertInOrder(log, [
        'device_exec.sailfish-devagent.ping',
        'device_exec.rpm',
        'device_exec.sh',
        'device_exec.devel-su',
        'device_exec.sailfish-devagent.ping',
      ]);
      const copy = find('device_exec.sh');
      assert.ok(copy?.argv.includes('/tmp/sailfish-devagent.rpm'), JSON.stringify(copy?.argv));
      const root = find('device_exec.devel-su');
      assert.ok(root, 'no devel-su invocation');
      assert.strictEqual(root.argv.filter((a) => a === '-t').length, 2, JSON.stringify(root.argv));
      for (const word of ['devel-su', 'sh', '-c']) assert.ok(root.argv.includes(word), `${word} missing from ${JSON.stringify(root.argv)}`);
      assert.ok(root.argv.some((a) => a.includes('rpm -U')), JSON.stringify(root.argv));

      const last = messages.calls[messages.calls.length - 1];
      assert.strictEqual(last.kind, 'error', JSON.stringify(messages.calls));
      assert.ok(last.message.includes('not installed'), last.message);
    });
  });

  test('screenshot: Developer Mode off gives a clear error and fetches nothing', async () => {
    await withScenario('agent-devmode-off', async () => {
      const messages = stubMessages();
      await vscode.commands.executeCommand('sailfish.agent.screenshot');
      const error = messages.calls.find((m) => m.kind === 'error');
      assert.ok(error?.message.includes('Developer Mode is off'), JSON.stringify(messages.calls));
      assert.ok(!keys().includes('device_exec.base64'), JSON.stringify(keys()));
    });
  });

  test('logs: streams from the agent with --lines 200 and ends cleanly', async function () {
    this.timeout(20000);
    const messages = stubMessages();
    clearFakeLog();
    await vscode.commands.executeCommand('sailfish.agent.logs');
    await waitFor(() => keys().includes('device_exec.sailfish-devagent.logs'), 5000);
    const logs = find('device_exec.sailfish-devagent.logs');
    const at = logs?.argv.indexOf('--lines') ?? -1;
    assert.ok(at >= 0 && logs?.argv[at + 1] === '200', JSON.stringify(logs?.argv));
    // The fake stream ends on its own; give it time to finish and surface any error.
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!messages.calls.some((m) => m.kind === 'error'), JSON.stringify(messages.calls));
  });

  test('uninstall: devel-su rpm -e, then a "removed" message', async () => {
    const messages = stubMessages();
    stubInputBox('secret');
    clearFakeLog();
    await vscode.commands.executeCommand('sailfish.agent.uninstall');
    const root = find('device_exec.devel-su');
    assert.ok(root, JSON.stringify(keys()));
    assert.ok(root.argv.some((a) => a.includes('rpm -e sailfish-devagent')), JSON.stringify(root.argv));
    assert.ok(messages.calls.some((m) => m.kind === 'information' && m.message.includes('removed')), JSON.stringify(messages.calls));
  });
});
