import type * as vscode from 'vscode';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Output } from '../core/output';
import type { Services } from '../core/services';
import type { SfdkDeviceInfo } from '../core/types';
import { attachEmulatorEndpoints, deviceFromItem, parseDeviceList, sfdkDeviceName } from '../devices/listParsing';
import {
  AGENT_SOCKET_RE,
  boundStderrTail,
  buildForwardArgs,
  classifySshFailure,
  expandHomePath,
  type ForwardSpec,
  hostKeyAlias,
  isSafeLocalSocketPath,
  knownHostsLines,
  parseHostKeyLines,
  parseSessionDirName,
  sessionDirName,
  type SshFailureClass,
} from './sshForwardCore';

/**
 * The direct SSH forward to the device agent (plan section 1.3): the `ssh -N` process lifecycle,
 * readiness, cleanup, stale-session cleanup, and host-key pinning through the SDK connection.
 * No `vscode` runtime import (types only), so it is unit-tested under plain mocha; the argv is
 * built by the pure `buildForwardArgs` and spawned with `shell: false`.
 */

const READY_TIMEOUT_MS = 15_000;
const POLL_MS = 50;
const TERM_GRACE_MS = 2_000;
const HOST_KEY_TIMEOUT_MS = 30_000;
const DEVICE_LIST_TIMEOUT_MS = 60_000;
const HOST_KEY_FILES = [
  '/etc/ssh/ssh_host_ed25519_key.pub',
  '/etc/ssh/ssh_host_ecdsa_key.pub',
  '/etc/ssh/ssh_host_rsa_key.pub',
];
const SSH_PID_FILE = 'ssh.pid';
const SOCKET_FILE = 'agent.sock';
const SOCKET_PATH_STATE_PREFIX = 'sailfish.mirror.socketPath.';

export interface ForwardExit {
  code: number | null;
  stderrTail: string;
}

export interface SshForwardCommonOptions {
  /** The extension's `globalStorageUri.fsPath`; holds `ssh/known_hosts`. */
  storageDir: string;
  token: vscode.CancellationToken;
  output: Output;
  readyTimeoutMs?: number;
}

export interface SshForwardOpenOptions extends SshForwardCommonOptions {
  device: SfdkDeviceInfo;
  remoteSocket: string;
}

/** What `start` needs from a forward kind: the `-L` spec, where to probe, and what identifies the process. */
interface ForwardPlan {
  forward: ForwardSpec;
  target: net.NetConnectOpts;
  marker: string;
}

export type SshForwardOpenResult =
  | { ok: true; forward: SshForward }
  | { ok: false; cls: SshFailureClass; detail: string };

function failOpen(output: Output, cls: SshFailureClass, detail: string): SshForwardOpenResult {
  output.log('info', `mirror forward: ${cls}: ${detail}`);
  return { ok: false, cls, detail };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * `$XDG_RUNTIME_DIR/sailfish-tools` when `XDG_RUNTIME_DIR` is a directory owned by the user with
 * mode 0700, else `os.tmpdir()`. Pure of side effects (the directory is created by `open`).
 */
export function privateDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const uid = currentUid();
  if (xdg && path.isAbsolute(xdg) && uid !== undefined) {
    try {
      const st = fs.statSync(xdg);
      if (st.isDirectory() && st.uid === uid && (st.mode & 0o777) === 0o700) {
        return path.join(xdg, 'sailfish-tools');
      }
    } catch {
      // fall through to the temp directory
    }
  }
  return os.tmpdir();
}

/** A real directory (not a symlink), owned by this user, not accessible to group or others. */
function isPrivateOwnDir(st: fs.Stats, uid: number): boolean {
  return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0;
}

async function createSessionDir(base: string): Promise<{ dir: string } | { error: string }> {
  const uid = currentUid();
  if (uid === undefined) {
    return { error: 'no POSIX user id on this platform' };
  }
  try {
    if (base !== os.tmpdir()) {
      await fsp.mkdir(base, { recursive: true, mode: 0o700 });
      const baseStat = await fsp.lstat(base);
      if (!isPrivateOwnDir(baseStat, uid)) {
        return { error: `${base} is not a private directory owned by this user` };
      }
    }
    const dir = await fsp.mkdtemp(path.join(base, sessionDirName(process.pid, '')));
    const st = await fsp.lstat(dir);
    if (!isPrivateOwnDir(st, uid)) {
      await fsp.rm(dir, { recursive: true, force: true });
      return { error: `${dir} is not a private directory owned by this user` };
    }
    return { dir };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The readiness connection is handed out only while younger than this (the agent's request timeout is 5 s). */
export const FIRST_SOCKET_MAX_AGE_MS = 4000;

export class SshForward {
  readonly exited: Promise<ForwardExit>;
  /** The unix forward's local socket; empty for a TCP forward. */
  get localSocket(): string {
    return 'path' in this.target ? this.target.path : '';
  }

  private exitInfo: (ForwardExit & { spawnErrorCode?: string }) | undefined;
  private stderrTail = '';
  private spawnErrorCode: string | undefined;
  private firstSocket: net.Socket | undefined;
  private firstSocketAt = 0;
  private readonly sockets = new Set<net.Socket>();
  private closing: Promise<void> | undefined;
  private closed = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly sessionDir: string,
    private readonly target: net.NetConnectOpts,
  ) {
    this.exited = new Promise<ForwardExit>((resolve) => {
      const finish = (code: number | null): void => {
        if (this.exitInfo) {
          return;
        }
        this.exitInfo = { code, stderrTail: this.stderrTail, spawnErrorCode: this.spawnErrorCode };
        resolve({ code, stderrTail: this.stderrTail });
      };
      child.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail = boundStderrTail(this.stderrTail + chunk.toString('utf8'));
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        this.spawnErrorCode = err.code;
        this.stderrTail = boundStderrTail(`${this.stderrTail}${err.message}\n`);
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }

  /**
   * Spawns `ssh -N -L <session dir>/agent.sock:<remoteSocket>` and returns once the local
   * listener accepts a connection (that first connection is handed out by the first `connect()`).
   * Every failure leaves no ssh process and no session directory behind.
   */
  static async open(o: SshForwardOpenOptions): Promise<SshForwardOpenResult> {
    if (!AGENT_SOCKET_RE.test(o.remoteSocket)) {
      return failOpen(o.output, 'other', 'the remote socket path is not the agent socket');
    }
    return SshForward.start(o.device, o, (dir) => {
      const local = path.join(dir, SOCKET_FILE);
      if (!isSafeLocalSocketPath(local)) {
        return { error: `the local socket path is unusable (characters or length): ${local}` };
      }
      return { forward: { kind: 'unix', local, remote: o.remoteSocket }, target: { path: local }, marker: local };
    });
  }

  /**
   * The same hardened forward for `127.0.0.1:<port>` on both ends (a debugger port). A port that is
   * busy on this computer fails as `local-bind`.
   */
  static async openTcp(device: SfdkDeviceInfo, port: number, o: SshForwardCommonOptions): Promise<SshForwardOpenResult> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return failOpen(o.output, 'other', `${port} is not a valid port`);
    }
    // A listener already there would pass the readiness probe before ssh fails to bind.
    const occupant = await tryConnect({ host: '127.0.0.1', port });
    if (occupant) {
      occupant.destroy();
      return failOpen(o.output, 'local-bind', `port ${port} is in use on this computer`);
    }
    return SshForward.start(device, o, () => ({
      forward: { kind: 'tcp', port },
      target: { host: '127.0.0.1', port },
      marker: `127.0.0.1:${port}:127.0.0.1:${port}`,
    }));
  }

  private static async start(
    d: SfdkDeviceInfo,
    o: SshForwardCommonOptions,
    plan: (sessionDir: string) => ForwardPlan | { error: string },
  ): Promise<SshForwardOpenResult> {
    const fail = (cls: SshFailureClass, detail: string): SshForwardOpenResult => failOpen(o.output, cls, detail);
    if (!d.host || !d.user || d.port === undefined || !d.privateKey) {
      return fail('other', 'the device endpoint (host, port, user, key) is not fully known');
    }
    const privateKey = expandHomePath(d.privateKey, os.homedir());
    try {
      await fsp.access(privateKey, fs.constants.R_OK);
    } catch {
      return fail('key', `the private key ${privateKey} is not readable`);
    }

    const knownHostsFile = await ensureKnownHostsFile(o.storageDir).catch(() => undefined);
    if (!knownHostsFile) {
      return fail('other', 'could not create the known-hosts file');
    }
    // buildForwardArgs double-quotes the path (spaces are fine); a double quote cannot be expressed.
    if (knownHostsFile.includes('"')) {
      return fail('other', `the known-hosts path contains a double quote: ${knownHostsFile}`);
    }

    const base = privateDir();
    await sweepOrphans(base).catch(() => 0);
    const session = await createSessionDir(base);
    if ('error' in session) {
      return fail('local-bind', session.error);
    }
    const planned = plan(session.dir);
    if ('error' in planned) {
      await fsp.rm(session.dir, { recursive: true, force: true }).catch(() => undefined);
      return fail('local-bind', planned.error);
    }

    const args = buildForwardArgs({
      host: d.host,
      port: d.port,
      user: d.user,
      privateKey,
      forward: planned.forward,
      knownHostsFile,
      hostKeyAlias: hostKeyAlias(sfdkDeviceName(d)),
    });
    let child: ChildProcess;
    try {
      child = spawn('ssh', args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      await fsp.rm(session.dir, { recursive: true, force: true }).catch(() => undefined);
      const code = (err as NodeJS.ErrnoException).code;
      return fail(classifySshFailure('', { spawnErrorCode: code }), err instanceof Error ? err.message : String(err));
    }
    const forward = new SshForward(child, session.dir, planned.target);
    if (child.pid !== undefined) {
      try {
        fs.writeFileSync(path.join(session.dir, SSH_PID_FILE), `${child.pid}\n${planned.marker}\n`, { mode: 0o600 });
      } catch {
        // the sweep then only removes the directory
      }
    }
    o.output.log('debug', `mirror forward: ssh ${args.join(' ')}`);

    const deadline = Date.now() + (o.readyTimeoutMs ?? READY_TIMEOUT_MS);
    for (;;) {
      if (forward.exitInfo) {
        const { stderrTail, spawnErrorCode, code } = forward.exitInfo;
        await forward.close();
        const cls = classifySshFailure(stderrTail, { spawnErrorCode });
        return fail(cls, stderrTail.trim() || `ssh exited with code ${code}`);
      }
      if (o.token.isCancellationRequested) {
        await forward.close();
        return fail('other', 'cancelled');
      }
      if (Date.now() > deadline) {
        const tail = forward.stderrTail;
        await forward.close();
        return fail(classifySshFailure(tail, { timedOut: true }), tail.trim() || 'the forward did not come up in time');
      }
      const sock = await tryConnect(planned.target);
      if (sock) {
        forward.firstSocket = sock;
        forward.firstSocketAt = Date.now();
        forward.sockets.add(sock);
        sock.once('close', () => forward.sockets.delete(sock));
        return { ok: true, forward };
      }
      await sleep(POLL_MS);
    }
  }

  /** A connection to the agent through the forward; the first call returns the readiness connection. */
  connect(): Promise<net.Socket> {
    if (this.closed || this.closing) {
      return Promise.reject(new Error('the forward is closed'));
    }
    if (this.firstSocket) {
      const sock = this.firstSocket;
      this.firstSocket = undefined;
      // The agent closes a connection that sends no request within 5 s: an old probe socket is not reused.
      if (!sock.destroyed && Date.now() - this.firstSocketAt <= FIRST_SOCKET_MAX_AGE_MS) {
        return Promise.resolve(sock);
      }
      sock.destroy();
    }
    return new Promise<net.Socket>((resolve, reject) => {
      const sock = net.connect(this.target);
      const onError = (err: Error): void => {
        sock.destroy();
        reject(err);
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.off('error', onError);
        this.sockets.add(sock);
        sock.once('close', () => this.sockets.delete(sock));
        resolve(sock);
      });
    });
  }

  /** Idempotent: SIGTERM, SIGKILL after 2 s, then the socket is unlinked and the directory removed. */
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.destroySockets();
    if (!this.exitInfo) {
      this.child.kill('SIGTERM');
      await Promise.race([this.exited, sleep(TERM_GRACE_MS)]);
      if (!this.exitInfo) {
        this.child.kill('SIGKILL');
        await Promise.race([this.exited, sleep(TERM_GRACE_MS)]);
      }
    }
    await fsp.rm(this.sessionDir, { recursive: true, force: true }).catch(() => undefined);
    this.closed = true;
  }

  /** For deactivate: no waiting. SIGTERM, then a synchronous SIGKILL, then the directory is removed. */
  closeSync(): void {
    this.destroySockets();
    if (!this.exitInfo) {
      this.child.kill('SIGTERM');
      this.child.kill('SIGKILL');
    }
    try {
      fs.rmSync(this.sessionDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    this.closed = true;
  }

  private destroySockets(): void {
    this.firstSocket = undefined;
    for (const sock of this.sockets) {
      sock.destroy();
    }
    this.sockets.clear();
  }
}

function tryConnect(target: net.NetConnectOpts): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const sock = net.connect(target);
    sock.once('connect', () => {
      sock.removeAllListeners('error');
      resolve(sock);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(undefined);
    });
  });
}

/* ------------------------------------------------------------------ stale sessions */

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function psCommand(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5_000 }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

/** The command line of `pid`: `/proc/<pid>/cmdline` on Linux, `ps` elsewhere; undefined when unreadable. */
async function commandLineOf(pid: number): Promise<string | undefined> {
  try {
    return (await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').join(' ');
  } catch {
    return process.platform === 'linux' ? undefined : psCommand(pid);
  }
}

/**
 * Removes the sessions of dead extension hosts in `dir` (`mirror-<pid>-*`): kills the `ssh` named in
 * `ssh.pid` after checking that its command line contains the directory's socket path, then removes
 * the directory. Directories of live extension hosts, of other users and non-directories are left
 * alone. Returns the number of directories removed.
 */
export async function sweepOrphans(dir: string): Promise<number> {
  const uid = currentUid();
  if (uid === undefined) {
    return 0;
  }
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const parsed = parseSessionDirName(name);
    if (!parsed || !pidIsDead(parsed.pid)) {
      continue;
    }
    const full = path.join(dir, name);
    try {
      const st = await fsp.lstat(full);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) {
        continue;
      }
      await killRecordedSsh(full);
      await fsp.rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      // another window may be sweeping the same directory
    }
  }
  return removed;
}

async function killRecordedSsh(sessionDir: string): Promise<void> {
  let pid: number;
  let marker: string;
  try {
    const [pidLine, markerLine] = (await fsp.readFile(path.join(sessionDir, SSH_PID_FILE), 'utf8')).split('\n');
    pid = Number(pidLine.trim());
    marker = markerLine || path.join(sessionDir, SOCKET_FILE);
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 1 || pidIsDead(pid)) {
    return;
  }
  const cmdline = await commandLineOf(pid);
  if (!cmdline || !cmdline.includes(marker)) {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    await sleep(200);
    if (!pidIsDead(pid)) {
      await sleep(TERM_GRACE_MS);
      if (!pidIsDead(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // already gone
  }
}

/* ------------------------------------------------------------------ host keys */

type HostKey = { type: string; key: string };

/** `<storageDir>/ssh/known_hosts`, created with mode 0600 (its directory 0700). Never `~/.ssh`. */
export async function ensureKnownHostsFile(storageDir: string): Promise<string> {
  const sshDir = path.join(storageDir, 'ssh');
  await fsp.mkdir(sshDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(sshDir, 0o700);
  const file = path.join(sshDir, 'known_hosts');
  const handle = await fsp.open(file, 'a', 0o600);
  await handle.close();
  return file;
}

let knownHostsLock: Promise<unknown> = Promise.resolve();

function withKnownHostsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = knownHostsLock.then(fn, fn);
  knownHostsLock = run.catch(() => undefined);
  return run;
}

async function readKnownHosts(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

/** The keys pinned for `alias` in `file`. */
export async function readPinnedKeys(file: string, alias: string): Promise<HostKey[]> {
  const keys: HostKey[] = [];
  for (const line of (await readKnownHosts(file)).split('\n')) {
    const [a, type, key] = line.split(' ');
    if (a === alias && type && key) {
      keys.push({ type, key });
    }
  }
  return keys;
}

/** The device's public host keys as the SDK's own `device exec` channel sees them. */
async function readDeviceHostKeys(services: Services, device: string): Promise<HostKey[]> {
  const result = await services.runner.run({
    args: ['device', 'exec', '--', 'cat', ...HOST_KEY_FILES],
    device,
    timeoutMs: HOST_KEY_TIMEOUT_MS,
  });
  // A non-zero exit is fine when some line is valid (e.g. no RSA key file on the device).
  const seen = new Set<string>();
  return parseHostKeyLines(result.stdout).filter((k) => {
    const id = `${k.type} ${k.key}`;
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

/**
 * Pins the device's host keys, read through `sfdk device exec`, as the only keys of `alias`
 * (temporary file plus rename). `no-host-key` when the device returned no valid line; nothing is
 * written then.
 */
export async function pinHostKeys(
  services: Services,
  device: string,
  knownHostsFile: string,
  alias: string,
): Promise<'pinned' | 'no-host-key'> {
  const keys = await readDeviceHostKeys(services, device);
  if (keys.length === 0) {
    return 'no-host-key';
  }
  await withKnownHostsLock(async () => {
    const kept = (await readKnownHosts(knownHostsFile))
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith(`${alias} `))
      .map((line) => `${line}\n`)
      .join('');
    const tmp = `${knownHostsFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, kept + knownHostsLines(alias, keys), { mode: 0o600 });
    await fsp.rename(tmp, knownHostsFile);
  });
  return 'pinned';
}

/**
 * After ssh reported a host-key failure: reads the keys through the SDK again and compares them
 * with the pinned ones. `device-changed`: the SDK sees different keys (reflash, recreated VM);
 * `path-mismatch`: the SDK still sees a pinned key, so the direct path answered with another one.
 * Nothing is written.
 */
export async function recheckHostKey(
  services: Services,
  device: string,
  knownHostsFile: string,
  alias: string,
): Promise<'device-changed' | 'path-mismatch' | 'no-host-key'> {
  const sdkKeys = await readDeviceHostKeys(services, device);
  if (sdkKeys.length === 0) {
    return 'no-host-key';
  }
  const pinned = new Set((await readPinnedKeys(knownHostsFile, alias)).map((k) => `${k.type} ${k.key}`));
  return sdkKeys.some((k) => pinned.has(`${k.type} ${k.key}`)) ? 'path-mismatch' : 'device-changed';
}

/* ------------------------------------------------------------------ socket path cache */

function socketPathStateKey(device: string): string {
  return `${SOCKET_PATH_STATE_PREFIX}${hostKeyAlias(device)}`;
}

/** The last agent socket path seen for `device` (validated on read), for the parallel warm start. */
export function cachedSocketPath(ctx: vscode.ExtensionContext, device: string): string | undefined {
  const value = ctx.globalState.get<unknown>(socketPathStateKey(device));
  return typeof value === 'string' && AGENT_SOCKET_RE.test(value) ? value : undefined;
}

export function rememberSocketPath(ctx: vscode.ExtensionContext, device: string, socketPath: string): Thenable<void> {
  return AGENT_SOCKET_RE.test(socketPath)
    ? ctx.globalState.update(socketPathStateKey(device), socketPath)
    : Promise.resolve();
}

/* ------------------------------------------------------------------ endpoint */

/**
 * The device with its ssh endpoint (host, port, user, key). From a Devices/Emulators view item that
 * already has one it is returned as is; otherwise (palette with the `sailfish.device` setting, or an
 * emulator row without an endpoint) `sfdk device list` is run and matched by `sfdkDeviceName`.
 */
export async function resolveDeviceEndpoint(
  services: Services,
  item: unknown,
  name: string,
): Promise<SfdkDeviceInfo | undefined> {
  const fromItem = deviceFromItem(item);
  if (fromItem?.host !== undefined) {
    return fromItem;
  }
  const wanted = fromItem ? sfdkDeviceName(fromItem) : name;
  const result = await services.runner.run({ args: ['device', 'list'], timeoutMs: DEVICE_LIST_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    services.output.log('info', `mirror forward: could not list devices: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    return undefined;
  }
  const parsed = parseDeviceList(result.stdout);
  if (!parsed.ok) {
    services.output.log('info', `mirror forward: could not parse the device list: ${parsed.reason}`);
    return undefined;
  }
  let found = parsed.value.find((d) => sfdkDeviceName(d) === wanted);
  if (!found && fromItem?.kind === 'emulator') {
    found = attachEmulatorEndpoints([fromItem], parsed.value)[0];
  }
  return found?.host !== undefined ? found : undefined;
}
