import * as vscode from 'vscode';
import type { Services } from '../core/services';
import type { SfdkDeviceInfo } from '../core/types';
import { sfdkDeviceName } from './listParsing';
import { isReachable, type Reachability } from './reachability';
import { OPEN_DEVICES_VIEW, RETRY, offlineMessage } from './devicePackagesCore';

/** The Devices view's lists and last probe results; set once the view is created (activateDevices). */
export interface DeviceDirectory {
  listInstalledForPick(): Promise<SfdkDeviceInfo[]>;
  reachabilityOf(device: SfdkDeviceInfo): Reachability;
}

let directory: DeviceDirectory | undefined;

export function setDeviceDirectory(dir: DeviceDirectory | undefined): void {
  directory = dir;
}

/**
 * The guard's TCP probe, mutable so integration tests can stand in for a device the fake sfdk lists
 * at an address nothing listens on (exposed as `__test.offlineGuard`; no behaviour change otherwise).
 */
export const OFFLINE_GUARD: { isReachable: (host: string, port: number, timeoutMs: number) => Promise<boolean> } = { isReachable };

/** Longer than the view's 1.5 s poll: a Wi-Fi phone in power save can take a moment to answer ARP. */
const GUARD_PROBE_TIMEOUT_MS = 3000;
/** The device list is normally cached; never let a slow `sfdk device list` hold the command up for long. */
const LOOKUP_TIMEOUT_MS = 10_000;

async function findDevice(device: string): Promise<SfdkDeviceInfo | undefined> {
  if (!directory) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS);
  });
  try {
    const list = await Promise.race([directory.listInstalledForPick().catch(() => undefined), timeout]);
    return list?.find((d) => sfdkDeviceName(d) === device);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 'offline' when the device's SSH port does not accept a TCP connection now; 'unknown' when the
 * device or its endpoint is not in the Devices view's list (the sfdk call that follows then
 * reports whatever is wrong). A fresh probe decides: the view's last state can be up to 15 s old.
 */
export async function probeDevice(services: Services, device: string): Promise<Reachability> {
  const info = await findDevice(device);
  if (!info?.host || !info.port) return 'unknown';
  const last = directory?.reachabilityOf(info) ?? 'unknown';
  const online = await OFFLINE_GUARD.isReachable(info.host, info.port, GUARD_PROBE_TIMEOUT_MS);
  services.output.log('info', `reachability of "${device}" (${info.host}:${info.port}): ${online ? 'online' : 'offline'} (Devices view last saw: ${last})`);
  return online ? 'online' : 'offline';
}

/**
 * Tells the user `device` is offline, with "Open Devices view" and "Retry". Resolves true when
 * the user chose Retry, so the caller can run its check again.
 */
export async function reportOffline(services: Services, device: string, detail?: string): Promise<boolean> {
  if (detail) services.output.log('warn', `"${device}" could not be reached: ${detail}`);
  const emulator = (await findDevice(device))?.kind === 'emulator';
  const choice = await services.prompts.showWarningMessage(offlineMessage(device, emulator), OPEN_DEVICES_VIEW, RETRY);
  if (choice === OPEN_DEVICES_VIEW) {
    await vscode.commands.executeCommand('sailfish.devices.focus');
    return false;
  }
  return choice === RETRY;
}

/**
 * Before anything that talks to `device`: true when it may be reachable, false when it is offline
 * and the user did not get it back with Retry. Shows "connecting to <device>…" while probing.
 */
export async function ensureDeviceOnline(services: Services, device: string): Promise<boolean> {
  for (;;) {
    const state = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Sailfish', cancellable: false },
      (progress) => {
        progress.report({ message: `connecting to "${device}"…` });
        return probeDevice(services, device);
      },
    );
    if (state !== 'offline') return true;
    if (!(await reportOffline(services, device))) return false;
  }
}
