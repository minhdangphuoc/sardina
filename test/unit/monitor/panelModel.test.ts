import * as assert from 'assert';
import { actionStates, connectionState, headerLine, pickApp, statsView } from '../../../src/monitor/panelModel';
import type { AgentProbe } from '../../../src/agent/agentCore';
import type { DeviceSessionInfo } from '../../../src/core/deviceSessions';

const running = (extra: Partial<Extract<AgentProbe, { state: 'running' }>> = {}): AgentProbe => ({ state: 'running', version: '1.10.0', developerMode: true, ...extra });

describe('monitor panel model', () => {
  describe('connection line', () => {
    const overview = { arch: { arch: 'aarch64' as const }, os: { versionId: '5.1.0.11' }, connection: { kind: 'wifi' as const, address: '10.0.0.1', label: 'Wi‑Fi' } };
    it('is connecting until something answered, then connected', () => {
      assert.strictEqual(connectionState({}), 'connecting');
      assert.strictEqual(headerLine({}), '');
      assert.strictEqual(connectionState({ overview }), 'connected');
      assert.strictEqual(connectionState({ agent: { state: 'not-installed' } }), 'connected');
    });
    it('is offline when the ping cannot reach the device', () => {
      assert.strictEqual(connectionState({ agent: { state: 'unreachable', detail: 'x' } }), 'offline');
    });
    it('joins connection, architecture, OS and agent', () => {
      assert.strictEqual(headerLine({ overview, agent: running() }), 'Wi‑Fi · aarch64 · OS 5.1.0.11 · agent 1.10.0');
    });
    it('leaves out what is unknown and says what is wrong with the agent', () => {
      const unknown = { ...overview, connection: { kind: 'unknown' as const, label: 'unknown' }, os: undefined };
      assert.strictEqual(headerLine({ overview: unknown, agent: { state: 'not-installed' } }), 'aarch64 · agent not installed');
      assert.strictEqual(headerLine({ agent: { state: 'not-running' } }), 'agent not running');
      assert.strictEqual(headerLine({ agent: running({ developerMode: false }) }), 'agent 1.10.0 · Developer Mode off');
    });
  });

  describe('actionStates', () => {
    it('disables restart for another device and without an app', () => {
      assert.strictEqual(actionStates({ selected: false, binaryKnown: true, agent: running() }).restartApp?.enabled, false);
      assert.strictEqual(actionStates({ selected: true, binaryKnown: false, agent: running() }).restartApp?.reason, 'no app known yet');
      assert.strictEqual(actionStates({ selected: true, binaryKnown: true, agent: running() }).restartApp?.enabled, true);
      assert.strictEqual(actionStates({ selected: false, binaryKnown: true, agent: running() }).runApp?.enabled, false);
      assert.strictEqual(actionStates({ selected: true, binaryKnown: true, agent: running() }).runApp?.enabled, true);
    });
    it('needs the agent for screenshot and mirror, and respects the phone switch', () => {
      const none = actionStates({ selected: true, binaryKnown: true, agent: { state: 'not-installed' } });
      assert.strictEqual(none.screenshot?.enabled, false);
      assert.strictEqual(none.screenshot?.reason, 'needs the device agent');
      const off = actionStates({ selected: true, binaryKnown: true, agent: running({ settings: { screenView: false } }) });
      assert.strictEqual(off.openMirror?.enabled, false);
      assert.ok(off.openMirror?.reason?.includes('screen view'));
      assert.strictEqual(off.stopApp?.enabled, true);
      assert.strictEqual(off.showLogs?.enabled, true);
    });
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
});
