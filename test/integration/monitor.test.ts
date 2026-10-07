import * as assert from 'assert';
import * as vscode from 'vscode';
import { APP_STATS_SCRIPT } from '../../src/monitor/appStats';
import type { PageMessage } from '../../src/monitor/protocol';
import {
  clearFakeLog,
  forceDeviceReachability,
  monitorView,
  readFakeLog,
  stubMessages,
  waitFor,
  waitForContext,
  withScenario,
  type FakeInvocation,
  type MonitorView,
} from './helpers';

/**
 * Device Monitor integration suite (PLAN-device-monitor §9.3, I-M1..I-M10) against the monitor-* fake sfdk
 * scenarios and the `sailfish._test.monitor` seam (registered only when TEST_MODE === 'full').
 * Only discovered when TEST_MODE != 'bare'.
 */

const DEVICE = 'Xperia 10 - Dual SIM (ARM)';
const OTHER_DEVICE = 'Sailfish OS Emulator 4.4.0.58';
const APP_BINARY = '/usr/bin/harbour-demo';
const TITLE = `Device Monitor: ${DEVICE}`;

function keys(): string[] {
  return readFakeLog().invocations.map((i) => i.key);
}

function all(key: string): FakeInvocation[] {
  return readFakeLog().invocations.filter((i) => i.key === key);
}

function assertInOrder(actual: string[], expected: string[]): void {
  let from = 0;
  for (const key of expected) {
    const at = actual.indexOf(key, from);
    assert.ok(at >= 0, `expected ${key} (in order) in ${JSON.stringify(actual)}`);
    from = at + 1;
  }
}

function monitorTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === TITLE);
}

async function openMonitor(): Promise<void> {
  await vscode.commands.executeCommand('sailfish.monitor.open');
  await waitFor(() => monitorTabs().length === 1, 8000);
}

async function send(message: PageMessage | Record<string, unknown>): Promise<MonitorView> {
  return await vscode.commands.executeCommand<MonitorView>('sailfish._test.monitor', DEVICE, 'send', message);
}

async function html(): Promise<string> {
  return await vscode.commands.executeCommand<string>('sailfish._test.monitor', DEVICE, 'html');
}

async function viewWhen(predicate: (v: MonitorView) => boolean, timeoutMs: number): Promise<MonitorView> {
  let last: MonitorView | undefined;
  await waitFor(() => {
    void monitorView(DEVICE).then((v) => (last = v));
    return last !== undefined && predicate(last);
  }, timeoutMs);
  return last as MonitorView;
}

async function setSetting(key: string, value: unknown, target = vscode.ConfigurationTarget.Global): Promise<void> {
  const folder = target === vscode.ConfigurationTarget.WorkspaceFolder ? vscode.workspace.workspaceFolders?.[0]?.uri : undefined;
  await vscode.workspace.getConfiguration('sailfish', folder).update(key, value, target);
}

suite('Device Monitor (I-M1..I-M10)', () => {
  suiteSetup(async function () {
    this.timeout(15000);
    await waitForContext('sailfish.sdkAvailable', true, 10000);
    await setSetting('device', DEVICE, vscode.ConfigurationTarget.WorkspaceFolder);
  });

  suiteTeardown(async function () {
    this.timeout(15000);
    await setSetting('device', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await setSetting('monitor.pollIntervalSeconds', undefined);
    await setSetting('debug.openDeviceMonitor', undefined);
  });

  teardown(async function () {
    this.timeout(15000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => monitorTabs().length === 0, 5000).catch(() => undefined);
    await setSetting('device', DEVICE, vscode.ConfigurationTarget.WorkspaceFolder);
  });

  test('I-M1 open: one tab per device, a second call reveals it, ping before the logs and stats streams', async function () {
    this.timeout(30000);
    await withScenario('monitor-agent', async () => {
      await openMonitor();
      await vscode.commands.executeCommand('sailfish.monitor.open');
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(monitorTabs().length, 1, 'a second open reveals the existing tab');
      await waitFor(() => keys().includes('device_exec.sailfish-devagent.stats') && keys().includes('device_exec.sailfish-devagent.logs'), 10000);
      // The probe decides both formats, so ping comes first; the two streams start together and either may spawn first.
      assertInOrder(keys(), ['device_exec.sailfish-devagent.ping', 'device_exec.sailfish-devagent.logs']);
      assertInOrder(keys(), ['device_exec.sailfish-devagent.ping', 'device_exec.sailfish-devagent.stats']);
      const logs = all('device_exec.sailfish-devagent.logs')[0];
      const argv = logs.argv;
      const pair = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
      assert.ok(argv.includes('--format') && pair('--format') === 'json', JSON.stringify(argv));
      assert.strictEqual(pair('--lines'), '500', JSON.stringify(argv));
      assert.ok(argv.includes('--client'), JSON.stringify(argv));
      const stats = all('device_exec.sailfish-devagent.stats')[0].argv;
      assert.strictEqual(stats[stats.indexOf('--exe') + 1], APP_BINARY, JSON.stringify(stats));
      assert.strictEqual(stats[stats.indexOf('--interval') + 1], '1000', JSON.stringify(stats));
    });
  });

  test('I-M2 debug: opens the tab beside and keeps the editor focused; off means no tab', async function () {
    this.timeout(40000);
    if (!vscode.extensions.getExtension('ms-vscode.cpptools')) return this.skip();
    // The fixture device's address does not answer; let Debug on Device's offline guard pass.
    const restoreReachability = forceDeviceReachability(true);
    try {
      await withScenario('monitor-agent', async () => {
        stubMessages();
        const before = vscode.window.activeTextEditor?.document.uri.toString();
        await setSetting('debug.openDeviceMonitor', true);
        void vscode.commands.executeCommand('sailfish.debugOnDevice');
        await waitFor(() => monitorTabs().length === 1, 20000);
        const tab = monitorTabs()[0];
        const group = vscode.window.tabGroups.all.find((g) => g.tabs.includes(tab));
        assert.ok(group && !group.isActive, 'the monitor opens beside the active editor group');
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), before, 'the editor keeps focus');

        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await waitFor(() => monitorTabs().length === 0, 5000);
        await setSetting('debug.openDeviceMonitor', false);
        void vscode.commands.executeCommand('sailfish.debugOnDevice');
        await new Promise((r) => setTimeout(r, 3000));
        assert.strictEqual(monitorTabs().length, 0, 'no monitor tab with the setting off');
      });
    } finally {
      restoreReachability();
    }
  });

  test('I-M3 sessions: device logs and app monitor listed; stopping one ends only that one', async function () {
    this.timeout(30000);
    await withScenario('monitor-agent', async () => {
      await openMonitor();
      const view = await viewWhen((v) => v.sessions.some((s) => s.label.includes('device logs')) && v.sessions.some((s) => s.label.includes('app monitor')), 10000);
      const logsSession = view.sessions.find((s) => s.label.includes('device logs'));
      assert.ok(logsSession, JSON.stringify(view.sessions));
      // A session is registered before its process starts; stop it only once both fakes run (and log a kill).
      await waitFor(() => keys().includes('device_exec.sailfish-devagent.logs') && keys().includes('device_exec.sailfish-devagent.stats'), 10000);
      clearFakeLog();
      await send({ type: 'session.stop', id: logsSession.id });
      await waitFor(() => readFakeLog().killed.length >= 1, 8000);
      await new Promise((r) => setTimeout(r, 500));
      const killed = readFakeLog().killed;
      assert.strictEqual(killed.length, 1, JSON.stringify(killed));
      assert.ok(killed[0].key.includes('logs'), JSON.stringify(killed));
      const after = await monitorView(DEVICE);
      assert.ok(after.sessions.some((s) => s.label.includes('app monitor')), JSON.stringify(after.sessions));
      assert.ok(!after.sessions.some((s) => s.label.includes('device logs')), JSON.stringify(after.sessions));
    });
  });

  test('I-M4 device switch: both streams stop, the tab stays with the switch banner, resume continues after the cursor', async function () {
    this.timeout(40000);
    await withScenario('monitor-agent', async () => {
      await openMonitor();
      await viewWhen((v) => v.log.status === 'live' && v.log.entries.length > 0 && v.log.cursor !== undefined, 10000);
      await waitFor(() => keys().includes('device_exec.sailfish-devagent.stats'), 10000);
      clearFakeLog();
      await setSetting('device', OTHER_DEVICE, vscode.ConfigurationTarget.WorkspaceFolder);
      await waitFor(() => readFakeLog().killed.length >= 2, 10000);
      assert.strictEqual(monitorTabs().length, 1, 'the tab stays open');
      const view = await viewWhen((v) => v.banner !== undefined, 8000);
      // The streams are stopped now, so the buffer's last journal entry is the one to resume after.
      const cursor = view.log.entries.filter((e) => e.cursor !== undefined).pop()?.cursor;
      assert.ok(cursor, 'the last entry has a cursor');
      assert.strictEqual(view.log.cursor, cursor, 'the view keeps the cursor of the stopped stream');
      assert.ok(view.banner?.actions.some((a) => a.resume !== undefined), JSON.stringify(view.banner));
      assert.ok(/device logs, app monitor/.test(view.banner?.text ?? '') || view.sessions.length === 0, JSON.stringify(view.banner));
      await setSetting('device', DEVICE, vscode.ConfigurationTarget.WorkspaceFolder);
      clearFakeLog();
      await send({ type: 'resume', what: 'all' });
      await waitFor(() => all('device_exec.sailfish-devagent.logs').length >= 1, 10000);
      const argv = all('device_exec.sailfish-devagent.logs')[0].argv;
      assert.strictEqual(argv[argv.indexOf('--after') + 1], cursor, JSON.stringify(argv));
    });
  });

  test('I-M5 logs: levels and tags in the buffer, openSource opens the file at the line, pause and resume keep the count', async function () {
    this.timeout(40000);
    await withScenario('monitor-agent', async () => {
      await openMonitor();
      // All 40 fixture lines (markers from the stats stream do not count).
      const view = await viewWhen((v) => v.log.entries.filter((e) => e.source === 'json').length >= 40, 12000);
      assert.strictEqual(view.log.status, 'live');
      assert.strictEqual(view.log.format, 'json');
      assert.ok(view.log.entries.some((e) => e.tag === 'harbour-demo' && e.priority === 4), 'a warning of the app');
      assert.ok(view.log.entries.some((e) => e.tag === 'lipstick' && e.priority === 6), 'an info line');
      // Error is journal priority 3 to 0 (§5.2); console.error arrives as 2 (T4-2 recording).
      assert.ok(view.log.entries.some((e) => e.tag === 'harbour-demo' && e.priority !== undefined && e.priority <= 3), 'an error line');

      // The fixture's ReferenceError points at qml/harbour-demo.qml:12 (PLAN §9.2 names FirstPage.qml).
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder);
      await send({ type: 'openSource', file: '/usr/share/harbour-demo/qml/harbour-demo.qml', line: 12, col: 5 });
      await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('qml/harbour-demo.qml') === true, 8000);
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, 'an editor is active');
      assert.ok(editor.document.uri.fsPath.startsWith(folder.uri.fsPath), editor.document.uri.fsPath);
      assert.strictEqual(editor.selection.active.line, 11);

      await send({ type: 'log.pause', on: true });
      const paused = await monitorView(DEVICE);
      assert.strictEqual(paused.log.status, 'paused');
      const count = paused.log.entries.length;
      await send({ type: 'log.pause', on: false });
      const resumed = await viewWhen((v) => v.log.status === 'live', 8000);
      assert.ok(resumed.log.entries.length >= count, `${resumed.log.entries.length} < ${count}`);
      const ids = new Set(resumed.log.entries.map((e) => e.id));
      assert.strictEqual(ids.size, resumed.log.entries.length, 'no entry delivered twice');
    });
  });

  test('I-M6 app stats: the fixture PID, then the PID change counts one restart', async function () {
    this.timeout(40000);
    await withScenario('monitor-agent', async () => {
      await openMonitor();
      await viewWhen((v) => v.app.stats?.pid === 4321, 12000);
      const view = await viewWhen((v) => v.app.stats?.pid === 4322, 15000);
      assert.strictEqual(view.app.counters.restarts, 1, JSON.stringify(view.app.counters));
    });
  });

  test('I-M7 old agent: no --format, stats by polling with the script at the poll interval', async function () {
    this.timeout(40000);
    await setSetting('monitor.pollIntervalSeconds', 2);
    await withScenario('monitor-agent-old', async () => {
      await openMonitor();
      await waitFor(() => all('device_exec.sh').length >= 2, 15000);
      const logs = all('device_exec.sailfish-devagent.logs')[0];
      assert.ok(logs && !logs.argv.includes('--format'), JSON.stringify(logs?.argv));
      const sh = all('device_exec.sh');
      for (const call of sh) {
        // The first `-c` is sfdk's own `-c device=…`; the script follows `sh -c`.
        const at = call.argv.indexOf('sh') + 1;
        assert.strictEqual(call.argv[at], '-c', JSON.stringify(call.argv));
        assert.ok(call.argv[at + 1] === APP_STATS_SCRIPT, JSON.stringify(call.argv));
        assert.deepStrictEqual(call.argv.slice(at + 2), ['sh', APP_BINARY]);
      }
      const gap = sh[1].ts - sh[0].ts;
      assert.ok(gap >= 1500 && gap < 6000, `poll gap ${gap} ms`);
      const view = await monitorView(DEVICE);
      assert.ok(/polling/.test(view.app.source), view.app.source);
    });
  });

  test('I-M8 logs off: the Allow system logs text, no further logs request, Retry re-runs ping', async function () {
    this.timeout(30000);
    await withScenario('monitor-logs-off', async () => {
      await openMonitor();
      const view = await viewWhen((v) => v.log.status === 'off', 10000);
      assert.ok(/Allow system logs/.test(view.log.reason ?? ''), JSON.stringify(view.log));
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(all('device_exec.sailfish-devagent.logs').length <= 1, JSON.stringify(keys()));
      const pings = all('device_exec.sailfish-devagent.ping').length;
      await send({ type: 'resume', what: 'logs' });
      await waitFor(() => all('device_exec.sailfish-devagent.ping').length > pings, 8000);
    });
  });

  test('I-M9 no agent: not installed, install text, screenshot and mirror disabled, Stop app still runs pkill', async function () {
    this.timeout(30000);
    await withScenario('monitor-no-agent', async () => {
      await openMonitor();
      const view = await viewWhen((v) => v.log.status === 'needsAgent', 10000);
      assert.ok(view.overview.some((r) => /not installed/i.test(r.value)), JSON.stringify(view.overview));
      // §8: `Logs need the device agent on "<device>".` plus the Install Device Agent button (the page shows it for needsAgent).
      assert.strictEqual(view.log.reason, `Logs need the device agent on "${DEVICE}".`, JSON.stringify(view.log));
      assert.strictEqual(view.actions.installAgent?.enabled, true, JSON.stringify(view.actions));
      assert.strictEqual(view.actions.screenshot?.enabled, false, JSON.stringify(view.actions));
      assert.strictEqual(view.actions.openMirror?.enabled, false, JSON.stringify(view.actions));
      clearFakeLog();
      await send({ type: 'action', name: 'stopApp' });
      await waitFor(() => keys().includes('device_exec.pkill'), 8000);
    });
  });

  test('I-M10 CSP: the panel HTML has default-src none and the nonce on the script tag', async function () {
    this.timeout(30000);
    await withScenario('monitor-agent', async () => {
      await openMonitor();
      const page = await html();
      assert.ok(page.includes("default-src 'none'"), page.slice(0, 600));
      const nonce = /script-src[^;"]*'nonce-([A-Za-z0-9+/=_-]+)'/.exec(page)?.[1];
      assert.ok(nonce, 'the CSP carries a script nonce');
      assert.ok(new RegExp(`<script[^>]*nonce="${nonce}"`).test(page), 'the script tag carries the nonce');
      assert.ok(!/<script(?![^>]*nonce=)/.test(page), 'every script tag has a nonce');
    });
  });
});
