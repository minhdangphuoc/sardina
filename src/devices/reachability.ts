import * as net from 'node:net';

/** How long a device's SSH port gets to accept a TCP connection before it counts as offline. */
export const PROBE_TIMEOUT_MS = 1500;

/**
 * True when `host:port` accepts a TCP connection within `timeoutMs`. Used for the Devices view's
 * connected/offline state; only opens and closes a socket (no SSH handshake, no sfdk call).
 */
export function isReachable(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

export type Reachability = 'online' | 'offline' | 'unknown';

/** Device-list key for a host/port pair, so devices sharing an endpoint share one probe. */
export function endpointKey(host: string | undefined, port: number | undefined): string | undefined {
  return host && port ? `${host}:${port}` : undefined;
}
