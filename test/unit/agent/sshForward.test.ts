import * as assert from 'assert';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Output } from '../../../src/core/output';
import type { Services } from '../../../src/core/services';
import type { SfdkDeviceInfo } from '../../../src/core/types';
import {
  SshForward,
  cachedSocketPath,
  ensureKnownHostsFile,
  pinHostKeys,
  privateDir,
  readPinnedKeys,
  recheckHostKey,
  rememberSocketPath,
  resolveDeviceEndpoint,
  sweepOrphans,
} from '../../../src/agent/sshForward';

const SOCK = '/run/user/100000/sailfish-devagent/agent.sock';
const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const output = { log: () => undefined } as unknown as Output;
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };

function device(over: Partial<SfdkDeviceInfo> = {}): SfdkDeviceInfo {
  return {
    index: 0,
    name: 'Xperia',
    kind: 'hardware-device',
    origin: 'user-defined',
    host: '192.168.1.5',
    port: 22,
    user: 'defaultuser',
    privateKey: '',
    flags: [],
    extra: [],
    ...over,
  };
}

function tmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sfwd-${label}-`));
}

/** A runner whose `run` returns canned results and records the argv. */
function fakeServices(replies: { stdout?: string; stderr?: string; exitCode?: number }[]): { services: Services; calls: string[][] } {
  const calls: string[][] = [];
  const services = {
    output,
    runner: {
      run: (opts: { args: string[] }) => {
        calls.push(opts.args);
        const r = replies.shift() ?? {};
        return Promise.resolve({ stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0, argv: [], durationMs: 0, timedOut: false, cancelled: false });
      },
    },
  } as unknown as Services;
  return { services, calls };
}

/** Installs a fake `ssh` (a node script) first on PATH; returns a restore function. */
function installFakeSsh(dir: string, body: string): () => void {
  const script = path.join(dir, 'ssh');
  fs.writeFileSync(script, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
  return () => {
    process.env.PATH = oldPath;
  };
}

const LISTENING_SSH = `
const net = require('net');
const args = process.argv.slice(2);
const spec = args[args.indexOf('-L') + 1];
const local = spec.slice(0, spec.lastIndexOf(':/run/'));
const server = net.createServer((c) => { c.on('data', (d) => c.write(d)); });
server.listen(local);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

describe('sshForward key pinning', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp('pin');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('ensureKnownHostsFile creates 0600 file in a 0700 directory', async () => {
    const file = await ensureKnownHostsFile(dir);
    assert.strictEqual(file, path.join(dir, 'ssh', 'known_hosts'));
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  });

  it('pins the validated keys and replaces only the alias lines', async () => {
    const file = await ensureKnownHostsFile(dir);
    fs.writeFileSync(file, `other ssh-ed25519 ${KEY_B}\nsailfish-Xperia ssh-ed25519 ${KEY_B}\n`);
    const stdout = `ssh-ed25519 ${KEY_A} root@host\nnot a key\nssh-rsa AAAA$(evil) x\n`;
    const { services, calls } = fakeServices([{ stdout, exitCode: 1 }]);
    assert.strictEqual(await pinHostKeys(services, 'Xperia', file, 'sailfish-Xperia'), 'pinned');
    assert.deepStrictEqual(calls[0], [
      'device',
      'exec',
      '--',
      'cat',
      '/etc/ssh/ssh_host_ed25519_key.pub',
      '/etc/ssh/ssh_host_ecdsa_key.pub',
      '/etc/ssh/ssh_host_rsa_key.pub',
    ]);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), `other ssh-ed25519 ${KEY_B}\nsailfish-Xperia ssh-ed25519 ${KEY_A}\n`);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['known_hosts']);
  });

  it('writes nothing when the device returns no valid key', async () => {
    const file = await ensureKnownHostsFile(dir);
    const { services } = fakeServices([{ stdout: 'cat: no such file\n', exitCode: 1 }]);
    assert.strictEqual(await pinHostKeys(services, 'Xperia', file, 'sailfish-Xperia'), 'no-host-key');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '');
  });

  it('recheckHostKey tells a changed device from a mismatching path', async () => {
    const file = await ensureKnownHostsFile(dir);
    fs.writeFileSync(file, `sailfish-Xperia ssh-ed25519 ${KEY_A}\n`);
    assert.deepStrictEqual(await readPinnedKeys(file, 'sailfish-Xperia'), [{ type: 'ssh-ed25519', key: KEY_A }]);
    assert.strictEqual(
      await recheckHostKey(fakeServices([{ stdout: `ssh-ed25519 ${KEY_B}\n` }]).services, 'Xperia', file, 'sailfish-Xperia'),
      'device-changed',
    );
    assert.strictEqual(
      await recheckHostKey(fakeServices([{ stdout: `ssh-ed25519 ${KEY_A}\n` }]).services, 'Xperia', file, 'sailfish-Xperia'),
      'path-mismatch',
    );
    assert.strictEqual(await recheckHostKey(fakeServices([{ stdout: '' }]).services, 'Xperia', file, 'sailfish-Xperia'), 'no-host-key');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), `sailfish-Xperia ssh-ed25519 ${KEY_A}\n`);
  });
});

describe('sshForward socket path cache', () => {
  function ctx(): { ctx: never; store: Map<string, unknown> } {
    const store = new Map<string, unknown>();
    const c = {
      globalState: {
        get: (k: string) => store.get(k),
        update: (k: string, v: unknown) => {
          store.set(k, v);
          return Promise.resolve();
        },
      },
    };
    return { ctx: c as never, store };
  }

  it('stores per alias and validates on read', async () => {
    const { ctx: c, store } = ctx();
    assert.strictEqual(cachedSocketPath(c, 'Xperia 10'), undefined);
    await rememberSocketPath(c, 'Xperia 10', SOCK);
    assert.deepStrictEqual([...store.keys()], ['sailfish.mirror.socketPath.sailfish-Xperia-10']);
    assert.strictEqual(cachedSocketPath(c, 'Xperia 10'), SOCK);
    store.set('sailfish.mirror.socketPath.sailfish-Xperia-10', '/tmp/evil:/x');
    assert.strictEqual(cachedSocketPath(c, 'Xperia 10'), undefined);
  });

  it('refuses to remember an invalid path', async () => {
    const { ctx: c, store } = ctx();
    await rememberSocketPath(c, 'Xperia', '/etc/passwd');
    assert.strictEqual(store.size, 0);
  });
});

describe('sshForward.privateDir', () => {
  const saved = process.env.XDG_RUNTIME_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved;
  });

  it('uses $XDG_RUNTIME_DIR/sailfish-tools only when it is 0700 and ours', () => {
    const xdg = tmp('xdg');
    try {
      process.env.XDG_RUNTIME_DIR = xdg;
      fs.chmodSync(xdg, 0o700);
      assert.strictEqual(privateDir(), path.join(xdg, 'sailfish-tools'));
      fs.chmodSync(xdg, 0o755);
      assert.strictEqual(privateDir(), os.tmpdir());
      process.env.XDG_RUNTIME_DIR = path.join(xdg, 'missing');
      assert.strictEqual(privateDir(), os.tmpdir());
      delete process.env.XDG_RUNTIME_DIR;
      assert.strictEqual(privateDir(), os.tmpdir());
    } finally {
      fs.rmSync(xdg, { recursive: true, force: true });
    }
  });
});

describe('sshForward.sweepOrphans', () => {
  it('removes dead sessions only, and kills nothing it cannot verify', async () => {
    const base = tmp('sweep');
    try {
      const deadPid = 2 ** 22 + 12345; // above the default pid_max on this host class; checked below
      let dead = deadPid;
      while (true) {
        try {
          process.kill(dead, 0);
          dead++;
        } catch {
          break;
        }
      }
      const deadDir = path.join(base, `mirror-${dead}-abc123`);
      const liveDir = path.join(base, `mirror-${process.pid}-abc123`);
      const other = path.join(base, 'unrelated');
      for (const d of [deadDir, liveDir, other]) fs.mkdirSync(d, { mode: 0o700 });
      // ssh.pid points at this live test process, whose command line does not hold the socket path
      fs.writeFileSync(path.join(deadDir, 'ssh.pid'), `${process.pid}\n`);
      // ssh never unlinks its listener socket; the sweep must leave no socket file behind
      const stale = net.createServer();
      await new Promise<void>((resolve) => stale.listen(path.join(deadDir, 'agent.sock'), resolve));
      assert.ok(fs.existsSync(path.join(deadDir, 'agent.sock')));
      assert.strictEqual(await sweepOrphans(base), 1);
      assert.ok(!fs.existsSync(path.join(deadDir, 'agent.sock')));
      stale.close();
      assert.ok(!fs.existsSync(deadDir));
      assert.ok(fs.existsSync(liveDir));
      assert.ok(fs.existsSync(other));
      assert.strictEqual(await sweepOrphans(path.join(base, 'nope')), 0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('kills an ssh whose command line names the session socket', async function () {
    if (process.platform !== 'linux') this.skip();
    const base = tmp('sweep2');
    try {
      let dead = 2 ** 22 + 777;
      while (fs.existsSync(`/proc/${dead}`)) dead++;
      const dir = path.join(base, `mirror-${dead}-zzz999`);
      fs.mkdirSync(dir, { mode: 0o700 });
      // a harmless sleeper that carries the socket path as an argument
      const { spawn } = await import('node:child_process');
      const child = spawn('sleep', ['30', path.join(dir, 'agent.sock')], { stdio: 'ignore' });
      const gone = new Promise<void>((resolve) => child.on('exit', () => resolve()));
      fs.writeFileSync(path.join(dir, 'ssh.pid'), `${child.pid}\n`);
      assert.strictEqual(await sweepOrphans(base), 1);
      await gone;
      assert.ok(!fs.existsSync(dir));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('sshForward.resolveDeviceEndpoint', () => {
  const LIST = [
    '#0 "Xperia 10"',
    '  autodetected hardware-device defaultuser@192.168.1.5:22',
    '  private-key: /home/u/.ssh/xperia',
    '',
  ].join('\n');

  it('returns the item as is when it already has an endpoint', async () => {
    const { services, calls } = fakeServices([]);
    const d = device({ name: 'Xperia 10' });
    assert.strictEqual(await resolveDeviceEndpoint(services, { device: d }, 'Xperia 10'), d);
    assert.strictEqual(calls.length, 0);
  });

  it('lists devices through the runner when there is no item', async () => {
    const { services, calls } = fakeServices([{ stdout: LIST }]);
    const found = await resolveDeviceEndpoint(services, undefined, 'Xperia 10');
    assert.deepStrictEqual(calls, [['device', 'list']]);
    assert.strictEqual(found?.host, '192.168.1.5');
    assert.strictEqual(found?.user, 'defaultuser');
  });

  it('is undefined when the device is not listed or sfdk fails', async () => {
    assert.strictEqual(await resolveDeviceEndpoint(fakeServices([{ stdout: LIST }]).services, undefined, 'Other'), undefined);
    assert.strictEqual(await resolveDeviceEndpoint(fakeServices([{ exitCode: 1, stderr: 'boom' }]).services, undefined, 'Xperia 10'), undefined);
  });
});

describe('SshForward.open', () => {
  let work: string;
  let restore: (() => void) | undefined;
  const saved = process.env.XDG_RUNTIME_DIR;

  beforeEach(() => {
    work = tmp('fwd');
    delete process.env.XDG_RUNTIME_DIR; // sessions go to os.tmpdir(), swept by the afterEach check
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved;
    fs.rmSync(work, { recursive: true, force: true });
  });

  function sessionDirs(): string[] {
    return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`mirror-${process.pid}-`));
  }

  function opts(over: Partial<Parameters<typeof SshForward.open>[0]> = {}): Parameters<typeof SshForward.open>[0] {
    const key = path.join(work, 'key');
    fs.writeFileSync(key, 'k', { mode: 0o600 });
    return { device: device({ privateKey: key }), remoteSocket: SOCK, storageDir: path.join(work, 'storage'), token, output, ...over };
  }

  it('opens, hands out connections, and close leaves no process or directory', async () => {
    restore = installFakeSsh(work, LISTENING_SSH);
    const r = await SshForward.open(opts());
    assert.ok(r.ok, JSON.stringify(r));
    const f = r.forward;
    try {
      assert.ok(fs.existsSync(f.localSocket));
      assert.strictEqual(fs.readFileSync(path.join(path.dirname(f.localSocket), 'ssh.pid'), 'utf8').trim().length > 0, true);
      const echo = async (s: net.Socket): Promise<string> =>
        new Promise((resolve) => {
          s.once('data', (d) => resolve(d.toString()));
          s.write('ping');
        });
      const first = await f.connect();
      assert.strictEqual(await echo(first), 'ping');
      const second = await f.connect();
      assert.notStrictEqual(second, first);
      assert.strictEqual(await echo(second), 'ping');
    } finally {
      await f.close();
    }
    await f.close(); // idempotent
    assert.ok(!fs.existsSync(f.localSocket), 'the socket file is removed by close()');
    assert.ok((await f.exited).code === 0 || (await f.exited).code === null);
    assert.deepStrictEqual(sessionDirs(), []);
    await assert.rejects(f.connect());
  });

  it('does not hand out a readiness connection older than 4 s', async () => {
    restore = installFakeSsh(work, LISTENING_SSH);
    const r = await SshForward.open(opts());
    assert.ok(r.ok, JSON.stringify(r));
    const f = r.forward;
    try {
      const priv = f as unknown as { firstSocket: net.Socket | undefined; firstSocketAt: number };
      const probe = priv.firstSocket;
      assert.ok(probe);
      priv.firstSocketAt = Date.now() - 5000;
      const sock = await f.connect();
      assert.notStrictEqual(sock, probe);
      assert.ok(probe.destroyed);
    } finally {
      await f.close();
    }
  });

  it('expands a ~/ key path from `sfdk device list` before the check and in the argv', async () => {
    const LOG_ARGS = `require('fs').writeFileSync(process.env.SFWD_ARGS, JSON.stringify(process.argv.slice(2)));\n${LISTENING_SSH}`;
    restore = installFakeSsh(work, LOG_ARGS);
    const savedHome = process.env.HOME;
    process.env.HOME = work; // os.homedir() reads $HOME on Linux and macOS
    process.env.SFWD_ARGS = path.join(work, 'args.json');
    try {
      fs.writeFileSync(path.join(work, 'key'), 'k', { mode: 0o600 });
      const r = await SshForward.open(opts({ device: device({ privateKey: '~/key' }) }));
      assert.ok(r.ok, JSON.stringify(r));
      await r.forward.close();
      const args = JSON.parse(fs.readFileSync(process.env.SFWD_ARGS, 'utf8')) as string[];
      assert.strictEqual(args[args.indexOf('-i') + 1], path.join(work, 'key'));
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      delete process.env.SFWD_ARGS;
    }
  });

  it('closeSync kills ssh and removes the directory', async () => {
    restore = installFakeSsh(work, LISTENING_SSH);
    const r = await SshForward.open(opts());
    assert.ok(r.ok);
    assert.ok(fs.existsSync(r.forward.localSocket));
    r.forward.closeSync();
    await r.forward.exited;
    assert.ok(!fs.existsSync(r.forward.localSocket), 'the socket file is removed by closeSync()');
    assert.deepStrictEqual(sessionDirs(), []);
  });

  it('classifies an ssh that exits with an auth error and cleans up', async () => {
    restore = installFakeSsh(work, `console.error('defaultuser@h: Permission denied (publickey).'); process.exit(255);`);
    const r = await SshForward.open(opts());
    assert.ok(!r.ok);
    assert.strictEqual(r.cls, 'auth');
    assert.match(r.detail, /Permission denied/);
    assert.deepStrictEqual(sessionDirs(), []);
  });

  it('reports a host key change as host-key-changed', async () => {
    restore = installFakeSsh(work, `console.error('@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @'); process.exit(255);`);
    const r = await SshForward.open(opts());
    assert.ok(!r.ok && r.cls === 'host-key-changed');
  });

  it('reports a missing pin as not-pinned, not as a changed key', async () => {
    restore = installFakeSsh(
      work,
      `process.stderr.write('No ED25519 host key is known for sailfish-emu and you have requested strict checking.\\r\\nHost key verification failed.\\r\\n'); process.exit(255);`,
    );
    const r = await SshForward.open(opts());
    assert.ok(!r.ok && r.cls === 'not-pinned', JSON.stringify(r));
  });

  it('times out when the listener never appears, terminating ssh', async () => {
    restore = installFakeSsh(work, `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`);
    const r = await SshForward.open(opts({ readyTimeoutMs: 300 }));
    assert.ok(!r.ok);
    assert.strictEqual(r.cls, 'timeout');
    assert.deepStrictEqual(sessionDirs(), []);
  });

  it('reports no-ssh when ssh is not on PATH', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = path.join(work, 'empty');
    try {
      const r = await SshForward.open(opts());
      assert.ok(!r.ok);
      assert.strictEqual(r.cls, 'no-ssh');
    } finally {
      process.env.PATH = oldPath;
    }
    assert.deepStrictEqual(sessionDirs(), []);
  });

  it('stops when the token is cancelled', async () => {
    restore = installFakeSsh(work, `setInterval(() => {}, 1000);`);
    const r = await SshForward.open(opts({ token: { ...token, isCancellationRequested: true } }));
    assert.ok(!r.ok);
    assert.match(r.detail, /cancelled/);
    assert.deepStrictEqual(sessionDirs(), []);
  });

  it('refuses bad inputs before spawning anything', async () => {
    restore = installFakeSsh(work, `require('fs').writeFileSync(${JSON.stringify(path.join(work, 'spawned'))}, '1');`);
    const noKey = await SshForward.open(opts({ device: device({ privateKey: path.join(work, 'missing') }) }));
    assert.ok(!noKey.ok && noKey.cls === 'key');
    const badSock = await SshForward.open(opts({ remoteSocket: '/tmp/evil.sock' }));
    assert.ok(!badSock.ok);
    const noHost = await SshForward.open(opts({ device: device({ host: undefined }) }));
    assert.ok(!noHost.ok);
    const quoted = await SshForward.open(opts({ storageDir: path.join(work, 'has"quote') }));
    assert.ok(!quoted.ok);
    assert.ok(!fs.existsSync(path.join(work, 'spawned')));
  });

  it('accepts a storage path with spaces and passes the known-hosts path double-quoted', async () => {
    const argvFile = path.join(work, 'argv.json');
    restore = installFakeSsh(
      work,
      `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n${LISTENING_SSH}`,
    );
    const storageDir = path.join(work, 'Application Support');
    const r = await SshForward.open(opts({ storageDir }));
    assert.ok(r.ok, JSON.stringify(r));
    try {
      const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as string[];
      assert.ok(argv.includes(`UserKnownHostsFile="${path.join(storageDir, 'ssh', 'known_hosts')}"`), JSON.stringify(argv));
    } finally {
      await r.forward.close();
    }
  });
});
