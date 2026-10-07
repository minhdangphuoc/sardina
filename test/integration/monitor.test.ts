import * as assert from 'assert';
import * as vscode from 'vscode';
import { APP_STATS_SCRIPT } from '../../src/monitor/appStats';
import type { PageMessage } from '../../src/monitor/protocol';
import {
  clearFakeLog,
  deviceLogView,
  forceDeviceReachability,
  monitorView,
  readFakeLog,
  stubMessages,
  waitFor,
  waitForContext,
  withScenario,
  type DeviceLogView,
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
const TITLE = `Monitor: ${DEVICE}`;

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

async function waitForLog(predicate: (v: DeviceLogView) => boolean, timeoutMs: number): Promise<DeviceLogView> {
  let last: DeviceLogView | undefined;
  await waitFor(() => {
    void deviceLogView().then((v) => (last = v));
    return last !== undefined && predicate(last);
  }, timeoutMs);
  return last as DeviceLogView;
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

  test('I-M1 open: one tab per device, a second call reveals it, ping before the stats stream, no log stream', async function () {
    this.timeout(30000);
    await withScenario('monitor-agent', async () => {
      await openMonitor();
      await vscode.commands.executeCommand('sailfish.monitor.open');
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(monitorTabs().length, 1, 'a second open reveals the existing tab');
      await waitFor(() => keys().includes('device_exec.sailfish-devagent.stats'), 10000);
      assert.ok(!keys().includes('device_exec.sailfish-devagent.logs'), 'the monitor does not stream the journal');
      assertInOrder(keys(), ['device_exec.sailfish-devagent.ping', 'device_exec.sailfish-devagent.stats']);
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

  test('I-M3 show logs: the action streams the journal into the output channel and a device switch stops it', async function () {
    this.timeout(40000);
    await withScenario('monitor-agent', async () => {
      stubMessages();
      await openMonitor();
      await send({ type: 'action', name: 'showLogs' });
      await waitFor(() => keys().includes('device_exec.sailfish-devagent.logs'), 10000);
      const argv = all('device_exec.sailfish-devagent.logs')[0].argv;
      assert.strictEqual(argv[argv.indexOf('--format') + 1], 'json', JSON.stringify(argv));
      assert.strictEqual(argv[argv.indexOf('--lines') + 1], '500', JSON.stringify(argv));
      assert.ok(argv.includes('--client'), JSON.stringify(argv));
      const log = await waitForLog((v) => v.running && v.lines.some((l) => / W .*harbour-demo/.test(l)), 12000);
      assert.strictEqual(log.device, DEVICE);
      assert.ok(log.lines.some((l) => /^\d\d:\d\d:\d\d\.\d{3} W .*harbour-demo/.test(l)), JSON.stringify(log.lines.slice(0, 8)));
      assert.ok(!log.lines.some((l) => l.includes('\u001b')), 'ANSI sequences are stripped');
      clearFakeLog();
      await setSetting('device', OTHER_DEVICE, vscode.ConfigurationTarget.WorkspaceFolder);
      await waitFor(() => readFakeLog().killed.some((k) => k.key.includes('logs')), 10000);
      const after = await waitForLog((v) => !v.running, 8000);
      assert.strictEqual(after.lines[after.lines.length - 1], '[stopped]');
    });
  });

  test('I-M4 device switch: the stats stream stops, the tab stays with the switch banner, resume starts it again', async function () {
    this.timeout(40000);
    await withScenario('monitor-agent', async () => {
      await openMonitor();
      await waitFor(() => keys().includes('device_exec.sailfish-devagent.stats'), 10000);
      clearFakeLog();
      await setSetting('device', OTHER_DEVICE, vscode.ConfigurationTarget.WorkspaceFolder);
      await waitFor(() => readFakeLog().killed.length >= 1, 10000);
      assert.strictEqual(monitorTabs().length, 1, 'the tab stays open');
      const view = await viewWhen((v) => v.banner !== undefined, 8000);
      assert.ok(view.banner?.actions.some((a) => a.resume !== undefined), JSON.stringify(view.banner));
      await setSetting('device', DEVICE, vscode.ConfigurationTarget.WorkspaceFolder);
      clearFakeLog();
      await send({ type: 'resume', what: 'all' });
      await waitFor(() => all('device_exec.sailfish-devagent.stats').length >= 1, 10000);
    });
  });

  test('I-M5 page: one narrow column with the connection line, the app card and the five actions, and nothing else', async function () {
    this.timeout(30000);
    await withScenario('monitor-agent', async () => {
      await openMonitor();
      await viewWhen((v) => v.state === 'connected' && v.line.includes('agent 1.10.0'), 10000);
      const page = await html();
      for (const a of ['restartApp', 'stopApp', 'screenshot', 'openMirror', 'showLogs']) assert.ok(page.includes(`id="act-${a}"`), a);
      assert.ok(!/log-grid|sessions-list|<section id="sec-/.test(page), 'no log viewer and no sessions list in the page');
      // The agent never serves a journal stream to the monitor itself.
      await new Promise((r) => setTimeout(r, 1000));
      assert.ok(!keys().includes('device_exec.sailfish-devagent.logs'), JSON.stringify(keys()));
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

  test('I-M7 old agent: stats by polling with the script at the poll interval', async function () {
    this.timeout(40000);
    await setSetting('monitor.pollIntervalSeconds', 2);
    await withScenario('monitor-agent-old', async () => {
      await openMonitor();
      await waitFor(() => all('device_exec.sh').length >= 2, 15000);
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
    });
  });

  test('I-M8 logs off on the phone: Show logs gives the Allow system logs text and requests no stream', async function () {
    this.timeout(30000);
    await withScenario('monitor-logs-off', async () => {
      const messages = stubMessages();
      await openMonitor();
      await send({ type: 'action', name: 'showLogs' });
      await waitFor(() => messages.calls.some((m) => m.kind === 'error'), 10000);
      assert.ok(messages.calls.some((m) => /Allow system logs/.test(m.message)), JSON.stringify(messages.calls));
      assert.ok(!keys().includes('device_exec.sailfish-devagent.logs'), JSON.stringify(keys()));
      assert.strictEqual((await deviceLogView()).running, false);
    });
  });

  test('I-M9 no agent: not installed in the line, screenshot and mirror disabled, Stop app still runs pkill', async function () {
    this.timeout(30000);
    await withScenario('monitor-no-agent', async () => {
      await openMonitor();
      const view = await viewWhen((v) => v.line.includes('agent not installed'), 10000);
      assert.strictEqual(view.state, 'connected');
      assert.strictEqual(view.actions.screenshot?.enabled, false, JSON.stringify(view.actions));
      assert.strictEqual(view.actions.openMirror?.enabled, false, JSON.stringify(view.actions));
      assert.strictEqual(view.actions.showLogs?.enabled, true, JSON.stringify(view.actions));
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
