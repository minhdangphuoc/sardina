/**
 * Pure view models of the Device Monitor panel: the connection line, the state of each action and
 * the App message. Only type imports from modules that need `vscode`, so mocha runs it directly.
 */

import { phoneRefusal, type AgentProbe } from '../agent/agentCore';
import type { DeviceSessionInfo } from '../core/deviceSessions';
import type { DeviceOverview } from './deviceProbe';
import type { ActionName, ActionState, AppStatsView, ConnectionState } from './protocol';

export interface HeaderInput {
  /** Undefined while the probe runs. */
  overview?: DeviceOverview;
  /** Undefined while the first ping runs. */
  agent?: AgentProbe;
}

/** `Connecting…` until something answered, `Offline` when the ping could not reach the device. */
export function connectionState(i: HeaderInput): ConnectionState {
  if (i.agent?.state === 'unreachable') return 'offline';
  return i.agent || i.overview ? 'connected' : 'connecting';
}

/** `Wi‑Fi · aarch64 · OS 5.1.0.11 · agent 1.10.0`; parts that are not known yet are left out. */
export function headerLine(i: HeaderInput): string {
  const parts: string[] = [];
  const ov = i.overview;
  if (ov && ov.connection.kind !== 'unknown') parts.push(ov.connection.label);
  if (ov && 'arch' in ov.arch) parts.push(ov.arch.arch);
  if (ov?.os) {
    const v = ov.os.versionId ?? ov.os.prettyName;
    if (v) parts.push(`OS ${v}`);
  }
  const a = i.agent;
  if (a?.state === 'running') {
    parts.push(`agent ${a.version}`);
    if (!a.developerMode) parts.push('Developer Mode off');
  } else if (a?.state === 'not-installed') parts.push('agent not installed');
  else if (a?.state === 'not-running') parts.push('agent not running');
  return parts.join(' · ');
}

export interface ActionInput {
  /** The monitor's device is the selected one (restart goes through the project's commands). */
  selected: boolean;
  binaryKnown: boolean;
  agent: AgentProbe | undefined;
}

const NEEDS_AGENT = 'needs the device agent';

/** Enabled flag and reason for each button (§6). */
export function actionStates(i: ActionInput): Partial<Record<ActionName, ActionState>> {
  const agentOk = i.agent?.state === 'running' && i.agent.developerMode;
  const agentReason = (): string | undefined => {
    if (!i.agent) return 'checking the device agent…';
    if (i.agent.state !== 'running') return NEEDS_AGENT;
    if (!i.agent.developerMode) return 'Developer Mode is off';
    return undefined;
  };
  const state = (enabled: boolean, reason: string | undefined): ActionState => (enabled ? { enabled } : { enabled, reason: reason ?? 'not available' });
  const shotRefusal = i.agent ? phoneRefusal(i.agent, 'screenView') : undefined;
  return {
    restartApp: state(i.selected && i.binaryKnown, !i.binaryKnown ? 'no app known yet' : 'only for the selected device'),
    stopApp: state(i.binaryKnown, 'no app known yet'),
    runApp: state(i.selected && i.binaryKnown, !i.binaryKnown ? 'no app known yet' : 'only for the selected device'),
    screenshot: state(agentOk && !shotRefusal, shotRefusal ?? agentReason()),
    openMirror: state(agentOk && !shotRefusal, shotRefusal ?? agentReason()),
    showLogs: { enabled: true },
  };
}

export interface StatsLike {
  pid: number;
  state?: string;
  threads?: number;
  rssKb?: number;
  uptimeSec?: number;
}

/** One stats sample as the page shows it; `pid` 0 gives `pid` undefined so the page says "not running". */
export function statsView(sample: StatsLike, cpu: number | undefined, sysCpu: number | undefined): AppStatsView {
  const v: AppStatsView = {};
  if (sample.pid > 0) v.pid = sample.pid;
  if (sample.state !== undefined) v.state = sample.state;
  if (cpu !== undefined) v.cpu = cpu;
  if (sysCpu !== undefined) v.sysCpu = sysCpu;
  if (sample.rssKb !== undefined) v.rssKb = sample.rssKb;
  if (sample.threads !== undefined) v.threads = sample.threads;
  if (sample.uptimeSec !== undefined) v.uptimeSec = sample.uptimeSec;
  return v;
}

export interface AppRef {
  name: string;
  binary?: string;
  mode?: 'run' | 'debug';
}

/**
 * "The app" of a device (§3.5): the newest `app` or `debug` registry entry that knows its binary,
 * else the active project's binary when the monitor's device is the selected one.
 */
export function pickApp(list: readonly DeviceSessionInfo[], fallback: { name: string; binary: string } | undefined): AppRef | undefined {
  for (let k = list.length - 1; k >= 0; k--) {
    const s = list[k];
    if ((s.kind === 'app' || s.kind === 'debug') && s.meta?.binary) {
      const ref: AppRef = { name: s.meta.app ?? s.meta.binary.split('/').pop() ?? s.label, binary: s.meta.binary };
      if (s.meta.mode) ref.mode = s.meta.mode;
      return ref;
    }
  }
  return fallback ? { name: fallback.name, binary: fallback.binary } : undefined;
}
