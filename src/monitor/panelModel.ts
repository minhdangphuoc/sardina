/**
 * Pure view models of the Device Monitor panel (PLAN-device-monitor §3, §4, §6): overview rows,
 * session rows, the state of each action, the Logs section's state before a stream starts, and
 * the App message. Only type imports from modules that need `vscode`, so mocha runs it directly.
 */

import { describeOsRelease } from './overview';
import { describeProbe, phoneRefusal, type AgentProbe } from '../agent/agentCore';
import type { DeviceSessionInfo } from '../core/deviceSessions';
import type { SfdkDeviceInfo } from '../core/types';
import type { DeviceOverview } from './deviceProbe';
import type { ActionName, ActionState, AppStatsView, LogStatus, OverviewRow, SessionRow } from './protocol';
import type { StatsMode } from './statsSource';

export interface OverviewInput {
  deviceName: string;
  /** The Devices view item when the panel was opened from it. */
  info?: SfdkDeviceInfo;
  /** Undefined while the probe runs. */
  overview?: DeviceOverview;
  /** Undefined while the first ping runs. */
  agent?: AgentProbe;
  target?: string;
  buildType?: string;
  deployMethod?: string;
  binary?: string;
  debugging: boolean;
}

function endpoint(info: SfdkDeviceInfo): string {
  const host = info.host ? `${info.user ? `${info.user}@` : ''}${info.host}${info.port ? `:${info.port}` : ''}` : '';
  return [info.kind === 'emulator' ? 'emulator' : info.kind === 'hardware-device' ? 'phone' : 'device', host, info.origin !== 'unknown' ? info.origin : '']
    .filter(Boolean)
    .join(' · ');
}

export function agentRowText(device: string, agent: AgentProbe | undefined): string {
  if (!agent) return 'checking…';
  switch (agent.state) {
    case 'running': {
      const mode = agent.developerMode ? 'Developer Mode on' : 'Developer Mode off';
      return `${agent.version} · ${mode}`;
    }
    case 'not-running':
      return 'not running';
    case 'not-installed':
      return 'not installed';
    case 'unreachable':
      return describeProbe(device, agent).replace(/^Sailfish: /, '');
  }
}

/** The Overview section's rows; every value is plain text. */
export function overviewRows(i: OverviewInput): OverviewRow[] {
  const rows: OverviewRow[] = [{ label: 'Device', value: i.info ? `${i.deviceName} (${endpoint(i.info)})` : i.deviceName }];
  const ov = i.overview;
  rows.push({ label: 'Architecture', value: !ov ? 'checking…' : 'arch' in ov.arch ? ov.arch.arch : ov.arch.error });
  rows.push({ label: 'OS version', value: !ov ? 'checking…' : ov.os ? describeOsRelease(ov.os) : 'unknown' });
  rows.push({ label: 'Connection', value: !ov ? 'checking…' : ov.connection.address ? `${ov.connection.label} (${ov.connection.address})` : ov.connection.label });
  rows.push({ label: 'Device agent', value: agentRowText(i.deviceName, i.agent) });
  if (i.agent?.state === 'running' && i.agent.settings) {
    const off = (['screenView', 'control', 'logs'] as const).filter((k) => i.agent?.state === 'running' && i.agent.settings?.[k] === false);
    if (off.length > 0) rows.push({ label: 'Phone settings', value: `off: ${off.map((k) => (k === 'screenView' ? 'screen view' : k)).join(', ')}` });
  }
  const target = [i.target ? `target ${i.target}` : '', i.buildType ? `${i.buildType} build` : '', i.deployMethod ? `deploy ${i.deployMethod}` : '']
    .filter(Boolean)
    .join(' · ');
  rows.push({ label: 'Debug target', value: [target || 'no project', i.binary, i.debugging ? 'attached (cppdbg)' : ''].filter(Boolean).join(' · ') });
  return rows;
}

/** Registry entries as the Sessions section lists them; the monitor's own streams say "(this tab)" (D14). */
export function sessionRows(list: readonly DeviceSessionInfo[]): SessionRow[] {
  return list.map((s) => {
    const row: SessionRow = {
      id: s.id,
      kind: s.kind,
      label: s.kind === 'logs' ? `${s.label} (this tab)` : s.kind === 'monitor' ? `${s.label} (this tab)` : s.label,
      startedAt: s.startedAt,
    };
    if (s.meta?.app !== undefined) row.app = s.meta.app;
    if (s.meta?.pid !== undefined) row.pid = s.meta.pid;
    if (s.meta?.mode !== undefined) row.mode = s.meta.mode;
    return row;
  });
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
    screenshot: state(agentOk && !shotRefusal, shotRefusal ?? agentReason()),
    openMirror: state(agentOk && !shotRefusal, shotRefusal ?? agentReason()),
    refresh: { enabled: true },
    installAgent: state(i.agent !== undefined && (i.agent.state === 'not-installed' || i.agent.state === 'not-running'), 'the agent is installed'),
  };
}

export interface LogStart {
  /** True when the stream may start. */
  start: boolean;
  status: LogStatus;
  reason?: string;
}

/** What the Logs section shows, or whether it may start, for the agent's state (§4 table, §8 texts). */
export function logStartDecision(device: string, agent: AgentProbe | undefined): LogStart {
  if (!agent) return { start: false, status: 'starting' };
  switch (agent.state) {
    case 'not-installed':
    case 'not-running':
      return { start: false, status: 'needsAgent', reason: `Logs need the device agent on "${device}".` };
    case 'unreachable':
      return { start: false, status: 'stopped', reason: agent.detail };
    case 'running': {
      if (!agent.developerMode) {
        return { start: false, status: 'needsAgent', reason: `Developer Mode is off on "${device}", so the device agent refuses logs.` };
      }
      const refusal = phoneRefusal(agent, 'logs');
      if (refusal) return { start: false, status: 'off', reason: refusal };
      return { start: true, status: 'starting' };
    }
  }
}

/** The notice for a text-only log stream (agent 1.1.0 to 1.9.0). */
export function oldAgentLogNotice(agent: AgentProbe | undefined): string | undefined {
  if (agent?.state !== 'running' || agent.logFormats?.includes('json')) return undefined;
  return `Agent ${agent.version}: plain-text log; update the agent for levels, tags and filters.`;
}

/** `agent 1 s`, `polling every 5 s`, `paused (tab hidden)`. */
export function statsSourceText(mode: StatsMode, intervalSec: number, visible: boolean): string {
  if (!visible && mode === 'poll') return 'paused (tab hidden)';
  if (mode === 'stream') return 'agent 1 s';
  return `polling every ${intervalSec} s through sfdk; install device agent 1.10.0 for 1 s updates`;
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

export interface SourceCandidate {
  /** Path relative to the project folder, when the device path says where it was installed from. */
  rel?: string;
  /** File name to search for in the workspace. */
  base: string;
}

const SAFE_BASE_RE = /^[A-Za-z0-9._+-]{1,128}$/;

/**
 * Where a device path from a log line may live in the workspace (§5.4): `/usr/share/<project>/…`
 * maps under the project folder, `qrc:/…` and anything else by file name. Undefined when the path
 * cannot be searched for safely (`..` segments, characters a glob would interpret).
 */
export function sourceCandidate(file: string, projectName: string | undefined): SourceCandidate | undefined {
  const cleaned = file.replace(/^qrc:\//, '/');
  const parts = cleaned.split('/').filter((p) => p.length > 0);
  if (parts.length === 0 || parts.some((p) => p === '..' || p === '.')) return undefined;
  const base = parts[parts.length - 1];
  if (!SAFE_BASE_RE.test(base)) return undefined;
  const prefix = projectName ? ['usr', 'share', projectName] : undefined;
  if (prefix && parts.length > 3 && prefix.every((p, i) => parts[i] === p)) {
    const rel = parts.slice(3);
    if (rel.every((p) => SAFE_BASE_RE.test(p))) return { rel: rel.join('/'), base };
  }
  return { base };
}
