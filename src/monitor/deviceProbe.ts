/**
 * The Device Monitor's overview probe: architecture, OS version and connection kind from four plain
 * commands over `sfdk device exec` (argv arrays, nothing expanded by a remote shell), run
 * sequentially with 30 s timeouts and cached per device until `refresh`.
 */

import type * as vscode from 'vscode';
import type { Services } from '../core/services';
import { detectArch } from '../agent/deviceAgent';
import type { AgentArch } from '../agent/agentCore';
import { classifyConnection, parseOsRelease, type ConnectionInfo, type OsRelease } from './overview';

export const PROBE_TIMEOUT_MS = 30_000;

export interface DeviceOverview {
  /** Architecture, or the reason it could not be told. */
  arch: { arch: AgentArch } | { error: string };
  /** Undefined when `/etc/os-release` could not be read. */
  os?: OsRelease;
  connection: ConnectionInfo;
}

type Services_ = Pick<Services, 'runner'>;

const cache = new Map<string, DeviceOverview>();

const NEVER_CANCELLED = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as vscode.CancellationToken;

async function exec(services: Services_, device: string, words: string[], token: vscode.CancellationToken): Promise<string | undefined> {
  const r = await services.runner.run({ args: ['device', 'exec', '--', ...words], device, timeoutMs: PROBE_TIMEOUT_MS, token });
  return r.exitCode === 0 ? r.stdout : undefined;
}

/** Runs the probe (or returns the cached result unless `refresh`). Never throws for a failing command. */
export async function probeOverview(
  services: Services_,
  device: string,
  opts: { refresh?: boolean; token?: vscode.CancellationToken } = {},
): Promise<DeviceOverview> {
  const hit = opts.refresh ? undefined : cache.get(device);
  if (hit) return hit;
  const token = opts.token ?? NEVER_CANCELLED;
  const arch = await detectArch(services as Services, device, token);
  const osText = await exec(services, device, ['cat', '/etc/os-release'], token);
  const ssh = await exec(services, device, ['printenv', 'SSH_CONNECTION'], token);
  const ip = ssh === undefined ? undefined : await exec(services, device, ['ip', '-o', '-4', 'addr'], token);
  const overview: DeviceOverview = {
    arch,
    connection: classifyConnection(ssh ?? '', ip ?? ''),
  };
  if (osText !== undefined) overview.os = parseOsRelease(osText);
  // A cancelled probe is not cached: the next call should ask again.
  if (!token.isCancellationRequested) cache.set(device, overview);
  return overview;
}

/** Forgets the cached overview of `device` (all devices without an argument). */
export function clearOverviewCache(device?: string): void {
  if (device === undefined) cache.clear();
  else cache.delete(device);
}
