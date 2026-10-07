import * as assert from 'assert';
import {
  actionStates,
  logStartDecision,
  oldAgentLogNotice,
  overviewRows,
  pickApp,
  sessionRows,
  sourceCandidate,
  statsSourceText,
  statsView,
} from '../../../src/monitor/panelModel';
import type { AgentProbe } from '../../../src/agent/agentCore';
import type { DeviceSessionInfo } from '../../../src/core/deviceSessions';

const running = (extra: Partial<Extract<AgentProbe, { state: 'running' }>> = {}): AgentProbe => ({ state: 'running', version: '1.10.0', developerMode: true, ...extra });

describe('monitor panel model', () => {
  describe('overviewRows', () => {
    it('shows placeholders while probing and the agent state', () => {
      const rows = overviewRows({ deviceName: 'Phone', debugging: false });
      assert.strictEqual(rows.find((r) => r.label === 'Architecture')?.value, 'checking…');
      assert.strictEqual(rows.find((r) => r.label === 'Device agent')?.value, 'checking…');
    });
    it('fills architecture, OS, connection, agent and debug target', () => {
      const rows = overviewRows({
        deviceName: 'Phone',
        overview: { arch: { arch: 'aarch64' }, os: { versionId: '5.0.0.62', prettyName: 'Sailfish OS 5.0.0.62' }, connection: { kind: 'usb', address: '10.0.0.1', label: 'USB' } },
        agent: running({ settings: { logs: false } }),
        target: 'T-aarch64',
        buildType: 'debug',
        binary: '/usr/bin/harbour-x',
        debugging: true,
      });
      const get = (l: string): string | undefined => rows.find((r) => r.label === l)?.value;
      assert.strictEqual(get('Architecture'), 'aarch64');
      assert.strictEqual(get('OS version'), 'Sailfish OS 5.0.0.62');
      assert.strictEqual(get('Connection'), 'USB (10.0.0.1)');
      assert.strictEqual(get('Device agent'), '1.10.0 · Developer Mode on');
      assert.strictEqual(get('Phone settings'), 'off: logs');
      assert.ok(get('Debug target')?.includes('attached (cppdbg)'));
    });
    it('says what is wrong without the agent', () => {
      const get = (a: AgentProbe): string | undefined => overviewRows({ deviceName: 'P', agent: a, debugging: false }).find((r) => r.label === 'Device agent')?.value;
      assert.strictEqual(get({ state: 'not-installed' }), 'not installed');
      assert.strictEqual(get({ state: 'not-running' }), 'not running');
    });
  });

  describe('sessionRows', () => {
    it('labels the monitor streams as this tab and carries the app meta', () => {
      const list: DeviceSessionInfo[] = [
        { id: 1, kind: 'logs', label: 'device logs', startedAt: 5 },
        { id: 2, kind: 'monitor', label: 'app monitor', startedAt: 6 },
        { id: 3, kind: 'app', label: 'harbour-x', startedAt: 7, meta: { app: 'harbour-x', pid: 4, mode: 'run' } },
      ];
      const rows = sessionRows(list);
      assert.strictEqual(rows[0].label, 'device logs (this tab)');
      assert.strictEqual(rows[1].label, 'app monitor (this tab)');
      assert.deepStrictEqual(rows[2], { id: 3, kind: 'app', label: 'harbour-x', startedAt: 7, app: 'harbour-x', pid: 4, mode: 'run' });
    });
  });

  describe('actionStates', () => {
    it('disables restart for another device and without an app', () => {
      assert.strictEqual(actionStates({ selected: false, binaryKnown: true, agent: running() }).restartApp?.enabled, false);
      assert.strictEqual(actionStates({ selected: true, binaryKnown: false, agent: running() }).restartApp?.reason, 'no app known yet');
      assert.strictEqual(actionStates({ selected: true, binaryKnown: true, agent: running() }).restartApp?.enabled, true);
    });
    it('needs the agent for screenshot and mirror, and respects the phone switch', () => {
      const none = actionStates({ selected: true, binaryKnown: true, agent: { state: 'not-installed' } });
      assert.strictEqual(none.screenshot?.enabled, false);
      assert.strictEqual(none.screenshot?.reason, 'needs the device agent');
      assert.strictEqual(none.installAgent?.enabled, true);
      const off = actionStates({ selected: true, binaryKnown: true, agent: running({ settings: { screenView: false } }) });
      assert.strictEqual(off.openMirror?.enabled, false);
      assert.ok(off.openMirror?.reason?.includes('screen view'));
      assert.strictEqual(off.stopApp?.enabled, true);
      assert.strictEqual(off.refresh?.enabled, true);
    });
  });

  describe('logStartDecision', () => {
    it('waits for the probe, then starts, or explains', () => {
      assert.deepStrictEqual(logStartDecision('P', undefined), { start: false, status: 'starting' });
      assert.deepStrictEqual(logStartDecision('P', running()), { start: true, status: 'starting' });
      const none = logStartDecision('P', { state: 'not-installed' });
      assert.strictEqual(none.status, 'needsAgent');
      assert.strictEqual(none.reason, 'Logs need the device agent on "P".');
      assert.strictEqual(logStartDecision('P', running({ developerMode: false })).status, 'needsAgent');
      const off = logStartDecision('P', running({ settings: { logs: false } }));
      assert.strictEqual(off.status, 'off');
      assert.ok(off.reason?.includes('System logs are turned off'));
    });
  });

  it('oldAgentLogNotice only for agents without json logs', () => {
    assert.strictEqual(oldAgentLogNotice(running({ version: '1.9.0' })), 'Agent 1.9.0: plain-text log; update the agent for levels, tags and filters.');
    assert.strictEqual(oldAgentLogNotice(running({ logFormats: ['text', 'json'] })), undefined);
    assert.strictEqual(oldAgentLogNotice({ state: 'not-running' }), undefined);
  });

  it('statsSourceText names the source', () => {
    assert.strictEqual(statsSourceText('stream', 5, true), 'agent 1 s');
    assert.ok(statsSourceText('poll', 5, true).startsWith('polling every 5 s'));
    assert.strictEqual(statsSourceText('poll', 5, false), 'paused (tab hidden)');
  });

  it('statsView leaves pid out for a stopped app', () => {
    assert.deepStrictEqual(statsView({ pid: 0 }, undefined, undefined), {});
    assert.deepStrictEqual(statsView({ pid: 7, state: 'S', rssKb: 100 }, 1.5, 20), { pid: 7, state: 'S', cpu: 1.5, sysCpu: 20, rssKb: 100 });
  });

  describe('pickApp', () => {
    it('takes the newest app or debug entry with a binary, else the project', () => {
      const list: DeviceSessionInfo[] = [
        { id: 1, kind: 'app', label: 'old', startedAt: 1, meta: { app: 'old', binary: '/usr/bin/old', mode: 'run' } },
        { id: 2, kind: 'logs', label: 'device logs', startedAt: 2 },
        { id: 3, kind: 'debug', label: 'debugging', startedAt: 3, meta: { app: 'new', binary: '/usr/bin/new', mode: 'debug' } },
      ];
      assert.deepStrictEqual(pickApp(list, undefined), { name: 'new', binary: '/usr/bin/new', mode: 'debug' });
      assert.deepStrictEqual(pickApp([], { name: 'p', binary: '/usr/bin/p' }), { name: 'p', binary: '/usr/bin/p' });
      assert.strictEqual(pickApp([], undefined), undefined);
    });
  });

  describe('sourceCandidate', () => {
    it('maps the install prefix under the project and falls back to the file name', () => {
      assert.deepStrictEqual(sourceCandidate('/usr/share/harbour-x/qml/pages/First.qml', 'harbour-x'), { rel: 'qml/pages/First.qml', base: 'First.qml' });
      assert.deepStrictEqual(sourceCandidate('qrc:/qml/Main.qml', 'harbour-x'), { base: 'Main.qml' });
      assert.deepStrictEqual(sourceCandidate('/usr/share/other/a.qml', 'harbour-x'), { base: 'a.qml' });
    });
    it('refuses traversal and glob characters', () => {
      assert.strictEqual(sourceCandidate('/usr/share/harbour-x/../../etc/passwd', 'harbour-x'), undefined);
      assert.strictEqual(sourceCandidate('/tmp/a{b,c}.qml', undefined), undefined);
      assert.strictEqual(sourceCandidate('/', undefined), undefined);
    });
  });
});
