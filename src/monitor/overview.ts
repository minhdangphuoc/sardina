/**
 * Pure parsers for the Device Monitor's Overview section: `/etc/os-release`, the SSH connection
 * kind from `SSH_CONNECTION` and `ip -o -4 addr`. No `vscode` import. The architecture parsers are
 * the existing ones in `src/agent/agentCore.ts`, re-exported here so the monitor has one import.
 */

export { archFromOutput, archFromRpmQuery } from '../agent/agentCore';

export interface OsRelease {
  /** `VERSION_ID`, e.g. `5.0.0.62`. */
  versionId?: string;
  /** `PRETTY_NAME`, else `NAME` + `VERSION`. */
  prettyName?: string;
  /** `VERSION`, e.g. `5.0.0.62 (Tampere)`. */
  version?: string;
  flavour?: string;
}

const MAX_FIELD = 200;

function unquote(v: string): string {
  const t = v.trim();
  const q = t[0];
  if ((q === '"' || q === "'") && t.length >= 2 && t.endsWith(q)) {
    return t.slice(1, -1).replace(/\\(["'\\$`])/g, '$1');
  }
  return t;
}

/** `/etc/os-release` (shell-style KEY=value lines). Unknown keys and malformed lines are ignored. */
export function parseOsRelease(text: string): OsRelease {
  const kv = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    kv.set(key, unquote(line.slice(eq + 1)).slice(0, MAX_FIELD));
  }
  const out: OsRelease = {};
  const versionId = kv.get('VERSION_ID');
  if (versionId) out.versionId = versionId;
  const version = kv.get('VERSION');
  if (version) out.version = version;
  const pretty = kv.get('PRETTY_NAME') || [kv.get('NAME'), version].filter(Boolean).join(' ');
  if (pretty) out.prettyName = pretty;
  const flavour = kv.get('SAILFISH_FLAVOUR');
  if (flavour) out.flavour = flavour;
  return out;
}

/** One line for the Overview row: `Sailfish OS 5.0.0.62 (Tampere) · flavour hotfix`. */
export function describeOsRelease(os: OsRelease): string {
  const base = os.prettyName ?? (os.versionId ? `version ${os.versionId}` : '');
  if (!base) return 'unknown';
  return os.flavour ? `${base} · flavour ${os.flavour}` : base;
}

export type ConnectionKind = 'usb' | 'wifi' | 'emulator' | 'other' | 'unknown';

export interface ConnectionInfo {
  kind: ConnectionKind;
  /** The server address of the SSH session. */
  address?: string;
  /** Interface that carries the address. */
  iface?: string;
  /** Human text: `USB`, `Wi‑Fi`, `emulator (VirtualBox NAT)`, the interface name or `unknown`. */
  label: string;
}

/** `SSH_CONNECTION` is `client_ip client_port server_ip server_port`; returns the server ip. */
export function parseSshConnection(text: string): string | undefined {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) return undefined;
  const ip = parts[2];
  return isIpv4(ip) ? ip : undefined;
}

function isIpv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return m !== null && m.slice(1).every((p) => Number(p) <= 255);
}

/** `ip -o -4 addr` lines (`2: wlan0    inet 192.168.2.15/24 brd … scope global wlan0`) as address to interface. */
export function parseIpAddrOutput(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\d+:\s+(\S+?)(?:@\S+)?\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d+)?\b/.exec(line);
    if (m && isIpv4(m[2])) map.set(m[2], m[1]);
  }
  return map;
}

/**
 * Names the connection from the SSH server address and the device's addresses. A `10.0.2.x`
 * address (VirtualBox NAT) is the emulator whatever the interface is called.
 */
export function classifyConnection(sshConnection: string, ipAddr: string): ConnectionInfo {
  const address = parseSshConnection(sshConnection);
  if (!address) return { kind: 'unknown', label: 'unknown' };
  const iface = parseIpAddrOutput(ipAddr).get(address);
  const base = iface ? { address, iface } : { address };
  if (/^10\.0\.2\.\d{1,3}$/.test(address)) return { kind: 'emulator', ...base, label: 'emulator (VirtualBox NAT)' };
  if (iface && /^(rndis|usb)\d*$/.test(iface)) return { kind: 'usb', ...base, label: 'USB' };
  if (iface && /^wlan\d*$/.test(iface)) return { kind: 'wifi', ...base, label: 'Wi‑Fi' };
  if (iface) return { kind: 'other', ...base, label: iface };
  return { kind: 'unknown', ...base, label: 'unknown' };
}
