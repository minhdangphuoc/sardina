export interface TerminalLaunch {
  shellPath: string;
  shellArgs: string[];
}

/** Rejects an option-like host/user before it reaches `ssh` as an argv element (same guard as sshLaunch.ts). */
function isUnsafe(value: string): boolean {
  return value.startsWith('-');
}

export function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) {
    return false;
  }
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

/**
 * Pure argv builder for "Sailfish: Connect to Device (WLAN)": `ssh -p <port> -- <user>@<host>`.
 * No password handling anywhere — the user types it into the opened terminal themselves.
 * Returns null on an option-like host/user (R25) or an out-of-range port.
 */
export function buildWlanSshLaunch(host: string, port: string, user: string): TerminalLaunch | null {
  if (!host || !user || isUnsafe(host) || isUnsafe(user) || !isValidPort(port)) {
    return null;
  }
  return { shellPath: 'ssh', shellArgs: ['-p', port, '--', `${user}@${host}`] };
}
