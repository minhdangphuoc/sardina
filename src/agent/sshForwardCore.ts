import type { SfdkDeviceInfo } from '../core/types';
import { sanitizeDeviceName } from './agentCore';

/**
 * Pure helpers for the direct SSH forward to the device agent (no `vscode`, no I/O).
 * Everything that reaches `ssh` goes through argv arrays; nothing here builds a shell string.
 */

/** The only phone-supplied path that may reach `-L`. */
export const AGENT_SOCKET_RE = /^\/run\/user\/[0-9]+\/sailfish-devagent\/agent\.sock$/;

/** sun_path is 104 bytes on macOS and 108 on Linux; stay below both. */
export const MAX_SOCKET_PATH_BYTES = 100;

/** Local socket path: a `:` would break `-L` parsing, so only a conservative character set is allowed. */
export function isSafeLocalSocketPath(p: string): boolean {
  return /^[A-Za-z0-9/._-]+$/.test(p) && Buffer.byteLength(p, 'utf8') <= MAX_SOCKET_PATH_BYTES;
}

/**
 * `sfdk device list` prints a key under the home directory as `~/…` (ssh expands that itself, Node's
 * fs does not), so the path is made absolute before the readability check and the argv.
 */
export function expandHomePath(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${p.slice(2)}`;
  return p;
}

export function hostKeyAlias(deviceName: string): string {
  return `sailfish-${sanitizeDeviceName(deviceName)}`;
}

export interface ForwardArgsInput {
  host: string;
  port: number;
  user: string;
  privateKey: string;
  localSocket: string;
  remoteSocket: string;
  knownHostsFile: string;
  hostKeyAlias: string;
}

/**
 * The exact `ssh` argv of the plan's section 1.3 (the binary itself is not part of it).
 * `UserKnownHostsFile` is double-quoted because ssh splits `-o Name=value` on whitespace and honours
 * quotes (a macOS "Application Support" path); a path with a double quote throws.
 */
export function buildForwardArgs(o: ForwardArgsInput): string[] {
  if (o.knownHostsFile.includes('"')) {
    throw new Error('the known-hosts path contains a double quote');
  }
  return [
    '-N',
    '-T',
    '-F',
    'none',
    ...opts([
      'BatchMode=yes',
      'IdentitiesOnly=yes',
      'IdentityAgent=none',
      'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no',
      'ExitOnForwardFailure=yes',
      'StreamLocalBindMask=0177',
      'StreamLocalBindUnlink=yes',
      'ControlMaster=no',
      'ControlPath=none',
      'ForwardAgent=no',
      'ForwardX11=no',
      'PermitLocalCommand=no',
      'ConnectTimeout=10',
      'ServerAliveInterval=5',
      'ServerAliveCountMax=3',
      'StrictHostKeyChecking=yes',
      'UpdateHostKeys=no',
      `UserKnownHostsFile="${o.knownHostsFile}"`,
      `HostKeyAlias=${o.hostKeyAlias}`,
      'LogLevel=ERROR',
    ]),
    '-i',
    o.privateKey,
    '-p',
    String(o.port),
    '-L',
    `${o.localSocket}:${o.remoteSocket}`,
    '--',
    `${o.user}@${o.host}`,
  ];
}

function opts(values: string[]): string[] {
  return values.flatMap((v) => ['-o', v]);
}

export type SshFailureClass =
  | 'no-ssh'
  | 'auth'
  | 'key'
  | 'host-key-changed'
  | 'not-pinned'
  | 'unreachable'
  | 'local-bind'
  | 'remote-refused'
  | 'timeout'
  | 'other';

export const MAX_STDERR_TAIL_BYTES = 8 * 1024;

/** Keeps only the last 8 KiB of ssh's stderr. */
export function boundStderrTail(text: string): string {
  return text.length > MAX_STDERR_TAIL_BYTES ? text.slice(text.length - MAX_STDERR_TAIL_BYTES) : text;
}

/*
 * Patterns from the verbatim OpenSSH 9.6 stderr recorded in the plan's F0 results (lines end in
 * `\r\n`; match substrings only). `key` is tested before `auth`: every key failure also prints
 * "Permission denied (publickey)". `open failed` is not printed at LogLevel=ERROR, so a refused
 * remote socket is detected by the connection closing before the first byte.
 */
const NOT_PINNED_RE = /host key is known for [^\n]* and you have requested strict checking/i;
const HOST_KEY_CHANGED_RE = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for [^\n]* has changed|Host key verification failed/i;
const KEY_RE = /UNPROTECTED PRIVATE KEY FILE|Load key\b[^\n]*:|Identity file [^\n]* not accessible|no such identity/i;
const AUTH_RE = /Permission denied \(publickey|Too many authentication failures/i;
const LOCAL_BIND_RE = /unix_listener: cannot bind|Bad local forwarding specification|Could not request local forwarding|\bbind: /i;
const REMOTE_REFUSED_RE = /open failed|administratively prohibited/i;
const UNREACHABLE_RE =
  /Connection refused|Connection timed out|No route to host|Could not resolve hostname|Network is unreachable/i;

export function classifySshFailure(
  stderrTail: string,
  opts: { spawnErrorCode?: string; closedBeforeFirstByte?: boolean; timedOut?: boolean } = {},
): SshFailureClass {
  if (opts.spawnErrorCode === 'ENOENT') {
    return 'no-ssh';
  }
  if (opts.timedOut) {
    return 'timeout';
  }
  const tail = boundStderrTail(stderrTail);
  // Before the changed-key test: it is followed by "Host key verification failed." too.
  if (NOT_PINNED_RE.test(tail)) {
    return 'not-pinned';
  }
  if (HOST_KEY_CHANGED_RE.test(tail)) {
    return 'host-key-changed';
  }
  if (KEY_RE.test(tail)) {
    return 'key';
  }
  if (AUTH_RE.test(tail)) {
    return 'auth';
  }
  if (LOCAL_BIND_RE.test(tail)) {
    return 'local-bind';
  }
  // Before `unreachable`: "open failed: connect failed: Connection refused" is the phone refusing the channel.
  if (REMOTE_REFUSED_RE.test(tail)) {
    return 'remote-refused';
  }
  if (UNREACHABLE_RE.test(tail)) {
    return 'unreachable';
  }
  if (opts.closedBeforeFirstByte) {
    return 'remote-refused';
  }
  return 'other';
}

/** The probe fields the eligibility check reads (`AgentProbe` is assignable to it). */
export interface ForwardProbe {
  state: string;
  version?: string;
  socket?: string;
  mirrorEncodings?: string[];
}

function atLeast(version: string | undefined, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) {
    return false;
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > major || (a === major && b >= minor);
}

/** Pure part of the eligibility rules; the key-file `access` check is the caller's. */
export function forwardEligibility(
  d: SfdkDeviceInfo,
  probe: ForwardProbe,
  platform: NodeJS.Platform,
): { ok: true; remoteSocket: string } | { ok: false; reason: string } {
  if (platform !== 'linux' && platform !== 'darwin') {
    return { ok: false, reason: `unsupported platform ${platform}` };
  }
  if (probe.state !== 'running') {
    return { ok: false, reason: 'the agent is not running' };
  }
  if (!atLeast(probe.version, 1, 2)) {
    return { ok: false, reason: `agent ${probe.version ?? 'unknown'} is older than 1.2.0` };
  }
  if (!probe.mirrorEncodings?.includes('binary')) {
    return { ok: false, reason: 'the agent does not offer the binary mirror encoding' };
  }
  if (!probe.socket || !AGENT_SOCKET_RE.test(probe.socket)) {
    return { ok: false, reason: 'the agent reported no usable socket path' };
  }
  if (!d.host || !d.user || d.port === undefined || !d.privateKey) {
    return { ok: false, reason: 'the device endpoint (host, port, user, key) is not fully known' };
  }
  if (d.user.startsWith('-') || d.host.startsWith('-')) {
    return { ok: false, reason: 'the device user or host starts with "-"' };
  }
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
    return { ok: false, reason: `invalid port ${d.port}` };
  }
  return { ok: true, remoteSocket: probe.socket };
}

const SESSION_DIR_RE = /^mirror-([0-9]+)-([A-Za-z0-9]+)$/;

export function sessionDirName(pid: number, suffix: string): string {
  return `mirror-${pid}-${suffix}`;
}

export function parseSessionDirName(name: string): { pid: number } | undefined {
  const m = SESSION_DIR_RE.exec(name);
  if (!m) {
    return undefined;
  }
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? { pid } : undefined;
}

const HOST_KEY_LINE_RE = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([A-Za-z0-9+/]+={0,3})( [ -~]*)?$/;
const MAX_HOST_KEY_LINE = 2048;

/** Valid `.pub` lines from `cat` output; the comment is dropped, anything suspicious is skipped. */
export function parseHostKeyLines(stdout: string): { type: string; key: string }[] {
  const keys: { type: string; key: string }[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length > MAX_HOST_KEY_LINE || line.includes('$(') || line.includes('`')) {
      continue;
    }
    const m = HOST_KEY_LINE_RE.exec(line);
    if (m) {
      keys.push({ type: m[1], key: m[2] });
    }
  }
  return keys;
}

/** known_hosts content: `<alias> <type> <base64>` per key, newline-terminated. */
export function knownHostsLines(alias: string, keys: { type: string; key: string }[]): string {
  return keys.map((k) => `${alias} ${k.type} ${k.key}\n`).join('');
}
