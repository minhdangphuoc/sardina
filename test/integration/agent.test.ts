import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  clearFakeLog,
  deviceLogView,
  forceDeviceReachability,
  readFakeLog,
  stubInputBox,
  stubMessages,
  stubSaveDialog,
  waitFor,
  waitForContext,
  withScenario,
  type DeviceLogView,
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

async function waitForLog(predicate: (v: DeviceLogView) => boolean, timeoutMs: number): Promise<DeviceLogView> {
  let last: DeviceLogView | undefined;
  await waitFor(() => {
    void deviceLogView().then((v) => (last = v));
    return last !== undefined && predicate(last);
  }, timeoutMs);
  return last as DeviceLogView;
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
  let restoreReachability: (() => void) | undefined;

  suiteSetup(async function () {
    this.timeout(15000);
    await waitForContext('sailfish.sdkAvailable', true, 10000);
    // The fixture device's address does not answer; the root-shell offline guard must let it through.
    restoreReachability = forceDeviceReachability(true);
    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.workspace.getConfiguration('sailfish', folder?.uri).update('device', DEVICE, vscode.ConfigurationTarget.WorkspaceFolder);
  });

  suiteTeardown(async function () {
    this.timeout(15000);
    restoreReachability?.();
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
      assert.deepStrictEqual(copy?.argv.slice(-3, -1), ['sh', 'sailfish-devagent.rpm'], JSON.stringify(copy?.argv));
      assert.ok(copy?.argv.some((a) => a.includes('$HOME/.cache/sailfish-tools')), JSON.stringify(copy?.argv));
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

  test('logs: the stream asks for 500 lines and a client, json only when the agent offers it, into the output channel', async function () {
    this.timeout(30000);
    const messages = stubMessages();
    // A stream still running is stopped through the "already streaming" offer.
    const stopStream = async (): Promise<void> => {
      if (!(await deviceLogView()).running) return;
      messages.chosenAction = 'Stop';
      await vscode.commands.executeCommand('sailfish.agent.logs');
      await waitForLog((v) => !v.running, 8000);
      messages.chosenAction = undefined;
    };
    clearFakeLog();
    await vscode.commands.executeCommand('sailfish.agent.logs');
    await waitFor(() => keys().includes('device_exec.sailfish-devagent.logs'), 8000);
    const logs = find('device_exec.sailfish-devagent.logs');
    assert.ok(logs, JSON.stringify(keys()));
    const at = logs.argv.indexOf('--lines');
    assert.ok(at >= 0 && logs.argv[at + 1] === '500', JSON.stringify(logs.argv));
    assert.ok(logs.argv.includes('--client'), JSON.stringify(logs.argv));
    // The default scenario's ping has no logFormats, so no --format json.
    assert.ok(!logs.argv.includes('--format'), JSON.stringify(logs.argv));
    assert.ok((await deviceLogView()).lines[0]?.includes('streaming'), JSON.stringify(await deviceLogView()));
    await stopStream();
    await withScenario('monitor-agent', async () => {
      await vscode.commands.executeCommand('sailfish.agent.logs');
      await waitFor(() => keys().includes('device_exec.sailfish-devagent.logs'), 8000);
      const argv = find('device_exec.sailfish-devagent.logs')?.argv ?? [];
      assert.ok(argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'json', JSON.stringify(argv));
      const log = await waitForLog((v) => v.lines.some((l) => l.includes('harbour-demo:')), 10000);
      assert.ok(log.lines.some((l) => /^\d\d:\d\d:\d\d\.\d{3} [A-Z]/.test(l)), JSON.stringify(log.lines.slice(0, 5)));
      assert.ok(!log.lines.some((l) => l.includes('\u001b')), 'ANSI stripped');
      await stopStream();
    });
    assert.ok(!messages.calls.some((m) => m.kind === 'error'), JSON.stringify(messages.calls));
  });

  test('screenshot: screen view off on the phone is refused with the Settings place and fetches nothing', async () => {
    await withScenario('agent-settings-view-off', async () => {
      const messages = stubMessages();
      await vscode.commands.executeCommand('sailfish.agent.screenshot');
      const error = messages.calls.find((m) => m.kind === 'error');
      assert.ok(error?.message.includes('Screen view is turned off on the phone'), JSON.stringify(messages.calls));
      assert.ok(error);
      assert.ok(error.message.includes('Settings → System → Developer agent'), error.message);
      assert.ok(!keys().includes('device_exec.base64'), JSON.stringify(keys()));
    });
  });

  test('I24 logs: logs off on the phone is refused before streaming', async () => {
    await withScenario('agent-settings-logs-off', async () => {
      const messages = stubMessages();
      await vscode.commands.executeCommand('sailfish.agent.logs');
      const error = messages.calls.find((m) => m.kind === 'error');
      assert.ok(error?.message.includes('System logs are turned off on the phone'), JSON.stringify(messages.calls));
      assert.ok(!keys().includes('device_exec.sailfish-devagent.logs'), JSON.stringify(keys()));
      assert.strictEqual((await deviceLogView()).running, false);
    });
  });

  test('I25 logs: a stream the phone stops reports "stopped from the phone" although the exit code is 0', async function () {
    this.timeout(20000);
    await withScenario('agent-settings-stopped', async () => {
      const messages = stubMessages();
      await vscode.commands.executeCommand('sailfish.agent.logs');
      await waitFor(() => messages.calls.some((m) => m.kind === 'error'), 8000);
      const error = messages.calls.find((m) => m.kind === 'error');
      assert.ok(error?.message.includes('stopped from the phone'), JSON.stringify(messages.calls));
      const log = await deviceLogView();
      assert.ok(log.lines.some((l) => l.includes('stopped from the phone')), JSON.stringify(log));
      assert.strictEqual(log.running, false);
    });
  });

  test('uninstall: devel-su rpm -e, then the user-level cleanup with fixed args, then one "removed" message', async () => {
    await withScenario('agent-uninstall', async () => {
      const messages = stubMessages();
      stubInputBox('secret');
      await vscode.commands.executeCommand('sailfish.agent.uninstall');
      assertInOrder(keys(), ['device_exec.devel-su', 'device_exec.sh']);
      const root = find('device_exec.devel-su');
      assert.ok(root, JSON.stringify(keys()));
      assert.ok(root.argv.some((a) => a.includes('rpm -e sailfish-devagent')), JSON.stringify(root.argv));
      const clean = find('device_exec.sh');
      assert.ok(clean, JSON.stringify(keys()));
      assert.deepStrictEqual(clean.argv.slice(-3), ['sh', '/tmp/sailfish-devagent.rpm', '/run/user'], JSON.stringify(clean.argv));
      assert.ok(clean.argv.some((a) => a.includes('sfdev-clean:done')), 'the fixed cleanup script');
      const last = messages.calls[messages.calls.length - 1];
      assert.strictEqual(last.kind, 'information', JSON.stringify(messages.calls));
      assert.ok(last.message.includes('removed from'), last.message);
      assert.ok(last.message.includes('Also removed 2 leftover items and 1 notification. Nothing of the agent is left.'), last.message);
      assert.deepStrictEqual(last.items, ['Restart Phone Session…']);
    });
  });

  test('uninstall: a leftover the user cannot remove is named in a warning; the session restart is never run unasked', async () => {
    await withScenario('agent-uninstall-left', async () => {
      const messages = stubMessages();
      stubInputBox('secret');
      await vscode.commands.executeCommand('sailfish.agent.uninstall');
      const last = messages.calls[messages.calls.length - 1];
      assert.strictEqual(last.kind, 'warning', JSON.stringify(messages.calls));
      assert.ok(last.message.includes('Still on the device: /var/lib/sailfish-devagent'), last.message);
      assert.strictEqual(readFakeLog().invocations.filter((i) => i.key === 'device_exec.devel-su').length, 1, JSON.stringify(keys()));
    });
  });

  test('uninstall: password prompt cancelled runs nothing on the device', async () => {
    await withScenario('agent-uninstall', async () => {
      stubMessages();
      stubInputBox(undefined);
      await vscode.commands.executeCommand('sailfish.agent.uninstall');
      assert.ok(!keys().includes('device_exec.devel-su'), JSON.stringify(keys()));
      assert.ok(!keys().includes('device_exec.sh'), JSON.stringify(keys()));
    });
  });

  test('install: password prompt cancelled removes the copied RPM (and its empty folder) as the user', async function () {
    this.timeout(30000);
    await withScenario('agent-missing', async () => {
      const messages = stubMessages();
      messages.chosenAction = 'Install Device Agent';
      stubInputBox(undefined);
      await vscode.commands.executeCommand('sailfish.agent.install');
      assert.ok(!keys().includes('device_exec.devel-su'), JSON.stringify(keys()));
      const sh = readFakeLog().invocations.filter((i) => i.key === 'device_exec.sh');
      assert.strictEqual(sh.length, 2, JSON.stringify(keys()));
      assert.deepStrictEqual(sh[1].argv.slice(-2), ['sh', 'sailfish-devagent.rpm'], JSON.stringify(sh[1].argv));
      assert.ok(sh[1].argv.some((a) => a.includes('rm -f "$d/$1"')), JSON.stringify(sh[1].argv));
    });
  });
});
