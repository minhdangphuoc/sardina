/**
 * Registry of activity tied to one device (debug session + gdbserver, app terminal, log stream,
 * screen mirror). Changing the selected device stops what runs on the old one, so nothing keeps
 * a stale connection or an app running on a device the user has moved away from. Pure: no vscode
 * import, so it is unit tested directly.
 */

export type DeviceSessionKind = 'debug' | 'app' | 'logs' | 'mirror' | 'monitor';

/** Optional facts about a session, merged in as they become known (the PID once the app runs). */
export interface DeviceSessionMeta {
  app?: string;
  binary?: string;
  pid?: number;
  mode?: 'run' | 'debug';
}

/** What notices and descriptions need from a session. */
export interface DeviceSessionLabel {
  kind: DeviceSessionKind;
  label: string;
}

export interface DeviceSessionInfo extends DeviceSessionLabel {
  /** Unique within the registry, never reused. */
  id: number;
  /** `Date.now()` at registration. */
  startedAt: number;
  meta?: DeviceSessionMeta;
}

export interface StopFailure extends DeviceSessionLabel {
  reason: string;
}

export interface StopAllResult {
  stopped: DeviceSessionLabel[];
  failed: StopFailure[];
}

export interface DeviceSessionHandle {
  dispose(): void;
  /** Merges `meta` into the session's metadata and notifies listeners; no-op once the session ended. */
  update(meta: DeviceSessionMeta): void;
}

export const STOP_TIMEOUT_MS = 10_000;

interface Entry extends DeviceSessionInfo {
  device: string;
  stop: () => Promise<void>;
}

export class DeviceSessions {
  private readonly entries = new Set<Entry>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  /** Calls `listener` whenever a session registers or ends (disposed or stopped). */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  private fire(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // a faulty listener must not break session bookkeeping
      }
    }
  }

  /** Registers a running session; dispose the result when it ends by itself. `stop` must end it cleanly. */
  register(
    device: string,
    kind: DeviceSessionKind,
    label: string,
    stop: () => Promise<void>,
    meta?: DeviceSessionMeta,
  ): DeviceSessionHandle {
    const entry: Entry = { device, kind, label, stop, id: this.nextId++, startedAt: Date.now() };
    if (meta) entry.meta = { ...meta };
    this.entries.add(entry);
    this.fire();
    return {
      dispose: () => {
        if (this.entries.delete(entry)) this.fire();
      },
      update: (next) => {
        if (!this.entries.has(entry)) return;
        entry.meta = { ...entry.meta, ...next };
        this.fire();
      },
    };
  }

  activeFor(device: string): DeviceSessionInfo[] {
    return [...this.entries]
      .filter((e) => e.device === device)
      .map((e) => {
        const info: DeviceSessionInfo = { id: e.id, kind: e.kind, label: e.label, startedAt: e.startedAt };
        if (e.meta) info.meta = { ...e.meta };
        return info;
      });
  }

  /** Devices that have at least one session. */
  devices(): string[] {
    return [...new Set([...this.entries].map((e) => e.device))];
  }

  /** Stops every session of `device` in parallel; a stop that throws or exceeds `timeoutMs` is reported, never rethrown. */
  async stopAll(device: string, timeoutMs: number = STOP_TIMEOUT_MS): Promise<StopAllResult> {
    return this.stopEntries([...this.entries].filter((e) => e.device === device), timeoutMs);
  }

  /** Stops only session `id` of `device` (same timeout and report rules as `stopAll`); an unknown id is a no-op. */
  async stopOne(device: string, id: number, timeoutMs: number = STOP_TIMEOUT_MS): Promise<StopAllResult> {
    return this.stopEntries([...this.entries].filter((e) => e.device === device && e.id === id), timeoutMs);
  }

  private async stopEntries(mine: Entry[], timeoutMs: number): Promise<StopAllResult> {
    for (const e of mine) this.entries.delete(e);
    if (mine.length > 0) this.fire();
    const outcomes = await Promise.all(mine.map((e) => stopWithTimeout(e, timeoutMs)));
    const result: StopAllResult = { stopped: [], failed: [] };
    mine.forEach((e, i) => {
      const reason = outcomes[i];
      if (reason === undefined) result.stopped.push({ kind: e.kind, label: e.label });
      else result.failed.push({ kind: e.kind, label: e.label, reason });
    });
    return result;
  }
}

async function stopWithTimeout(entry: Entry, timeoutMs: number): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`did not stop within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    });
    const done = entry.stop().then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    return await Promise.race([done, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Distinct labels in registration order: "debugging, cameragallery, device logs". */
export function listLabels(items: readonly DeviceSessionLabel[]): string {
  return [...new Set(items.map((i) => i.label))].join(', ');
}

/** Tree description part for a device with sessions: `debugging · device logs`; empty when none. */
export function sessionDescription(items: readonly DeviceSessionLabel[]): string {
  return [...new Set(items.map((i) => i.label))].join(' · ');
}

/** `+sessions` marks a tree item's contextValue so the inline stop button shows only for devices with sessions. */
export const SESSIONS_CONTEXT_SUFFIX = '+sessions';

function stopParts(device: string, result: StopAllResult): string[] {
  const parts: string[] = [];
  if (result.stopped.length > 0) parts.push(`Stopped on "${device}": ${listLabels(result.stopped)}.`);
  if (result.failed.length > 0) {
    parts.push(`Could not stop cleanly on "${device}": ${result.failed.map((f) => `${f.label} (${f.reason})`).join(', ')}.`);
  }
  return parts;
}

/** The non-modal notice after a switch, e.g. `Stopped on "A": debugging, device logs. Now using "B".` */
export function switchNotice(oldDevice: string, newDevice: string | undefined, result: StopAllResult): string {
  const parts = stopParts(oldDevice, result);
  parts.push(newDevice ? `Now using "${newDevice}".` : 'No device selected.');
  return `Sailfish: ${parts.join(' ')}`;
}

/** The notice after "Stop Sessions on Device"; says so when nothing was running. */
export function stopNotice(device: string, result: StopAllResult): string {
  const parts = stopParts(device, result);
  return `Sailfish: ${parts.length > 0 ? parts.join(' ') : `Nothing is running on "${device}".`}`;
}

/** The singleton every feature registers with. */
export const deviceSessions = new DeviceSessions();
