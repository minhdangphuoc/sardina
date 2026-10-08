import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { hostKeyAlias } from '../../src/agent/sshForwardCore';
import { extensionApi, fixturesRoot, stubMessages, stubSaveDialog, waitFor, waitForContext, withScenario, clearFakeLog, type MessageStubs } from './helpers';

/**
 * Mirror over the SSH forward (device-agent/PLAN-mirror-forward.md section 4, tests 1..17): the fake sfdk answers
 * ping/device list/host-key reads, the fake `ssh` (test/fixtures/bin/ssh, first on PATH) plays the forward and the
 * daemon behind it. State is observed through the fake log and through the `mirror "<device>": <status>` lines the
 * session writes to the output channel. Only discovered when TEST_MODE != 'bare'.
 */

const DEVICE = 'Xperia 10 - Dual SIM (ARM)';
const EMULATOR = 'Sailfish OS Emulator 4.4.0.58';
const TITLE = `Mirror: ${DEVICE}`;
const SFDK_MIRROR = 'device_exec.sailfish-devagent.mirror';
const SOCKET = '/run/user/100000/sailfish-devagent/agent.sock';
const PINNED_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFake0';
const OTHER_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIOtherOtherOtherOtherOtherOtherOtherOtherOt0';

interface LogEntry {
  ts: number;
  key: string;
  event?: string;
  argv?: string[];
  line?: string;
  seq?: number;
  frame?: number;
  input?: { type: string; active?: boolean; x?: number; y?: number; key?: string; pressed?: boolean };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readLog(): LogEntry[] {
  const p = process.env.SFDK_FAKE_LOG;
  if (!p || !fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LogEntry);
}

/** Invocations of one key (no `event` field), or events of one key when `event` is given. */
function entries(key: string, event?: string): LogEntry[] {
  return readLog().filter((e) => e.key === key && (event === undefined ? e.event === undefined : e.event === event));
}

const spawns = (): LogEntry[] => entries('ssh_forward');
const sfdkMirrors = (): LogEntry[] => entries(SFDK_MIRROR);
const requests = (): LogEntry[] => entries('ssh_forward.request', 'request');
const acks = (): number[] => entries('ssh_forward.ack', 'ack').map((e) => e.frame as number);
const keepalives = (): LogEntry[] => entries('ssh_forward.keepalive', 'keepalive');
const inputs = (): LogEntry[] => entries('ssh_forward.input', 'input');
const killed = (): LogEntry[] => entries('ssh_forward', 'killed');
const closed = (): LogEntry[] => entries('ssh_forward.closed', 'closed');
const keyframeRequests = (): LogEntry[] => entries('ssh_forward.keyframe', 'keyframe');
const sfdkKeys = (): string[] => readLog().filter((e) => e.event === undefined).map((e) => e.key);

function argvOf(e: LogEntry): string[] {
  return e.argv ?? [];
}

function optionValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The `-L <local>:<remote>` left side. */
function localSocket(e: LogEntry): string {
  const spec = optionValue(argvOf(e), '-L') ?? '';
  return spec.slice(0, spec.indexOf(':'));
}

function knownHostsFromArgv(e: LogEntry): string | undefined {
  const o = argvOf(e).find((a) => a.startsWith('UserKnownHostsFile='));
  // buildForwardArgs double-quotes the path (ssh splits -o values on whitespace and honours quotes).
  return o?.slice('UserKnownHostsFile='.length).replace(/^"(.*)"$/, '$1');
}

/** The extension's known-hosts file: from the last forward's argv, else the newest test user-data dir. */
function knownHostsFile(): string {
  const last = spawns().map(knownHostsFromArgv).filter((p): p is string => !!p).pop();
  if (last) return last;
  const tmp = os.tmpdir();
  const dirs = fs
    .readdirSync(tmp)
    .filter((n) => n.startsWith('sailfish-tools-userdata-'))
    .map((n) => path.join(tmp, n, 'User', 'globalStorage', 'sailfish-tools-dev.sailfish-tools', 'ssh'))
    .filter((d) => fs.existsSync(path.dirname(d)));
  dirs.sort((a, b) => fs.statSync(path.dirname(b)).mtimeMs - fs.statSync(path.dirname(a)).mtimeMs);
  assert.ok(dirs[0], 'cannot locate the extension global storage');
  return path.join(dirs[0], 'known_hosts');
}

function resetKnownHosts(): void {
  try {
    fs.rmSync(knownHostsFile(), { force: true });
  } catch {
    // no storage directory yet: nothing was pinned
  }
}

function mirrorTabs(label = TITLE): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === label);
}

/** The private directory of section 1.3: XDG_RUNTIME_DIR/sailfish-tools when it is a private directory of ours, else tmpdir. */
function privateDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) {
    try {
      const st = fs.statSync(xdg);
      if (st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o777) === 0o700) {
        return path.join(xdg, 'sailfish-tools');
      }
    } catch {
      // fall through
    }
  }
  return os.tmpdir();
}

interface Timing {
  keepaliveIntervalMs: number;
}

/** The mutable keepalive timing the extension exposes through `__test` (MIRROR_TIMING in mirrorCore.ts). */
function mirrorTiming(): Timing {
  const t = (extensionApi().__test as unknown as { mirrorTiming?: Timing }).mirrorTiming;
  assert.ok(t && typeof t.keepaliveIntervalMs === 'number', '__test.mirrorTiming is missing');
  return t;
}

interface LogSpy {
  messages: string[];
}

function spyOutput(sandbox: sinon.SinonSandbox): LogSpy {
  const services = extensionApi().__test.getServices() as { output: { log: (level: string, msg: string) => void } };
  const spy: LogSpy = { messages: [] };
  const original = services.output.log.bind(services.output);
  sandbox.stub(services.output, 'log').callsFake((level: string, msg: string) => {
    spy.messages.push(msg);
    original(level, msg);
  });
  return spy;
}

function hasStatus(spy: LogSpy, text: string): boolean {
  return spy.messages.some((m) => m.includes('mirror "') && m.includes(text));
}

/** waitFor, failing with the mirror's log lines and the fake's upstream events (for the video tests). */
async function waitOrDump(spy: LogSpy, cond: () => boolean, ms: number): Promise<void> {
  try {
    await waitFor(cond, ms);
  } catch (err) {
    const lines = spy.messages.filter((m) => m.includes('mirror "')).slice(-30);
    const events = readLog().filter((e) => e.key.startsWith('ssh_forward.')).map((e) => `${e.event ?? ''} ${e.line ?? e.frame ?? ''}`);
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${lines.join('\n')}\n${events.slice(-20).join('\n')}`);
  }
}

function emulatorItem(): unknown {
  return {
    device: {
      index: 0,
      name: EMULATOR,
      kind: 'emulator',
      origin: 'autodetected',
      user: 'defaultuser',
      host: '127.0.0.1',
      port: 2223,
      privateKey: path.join(fixturesRoot(), 'ssh', 'fake_key'),
      flags: [],
      extra: [],
    },
  };
}

/** Hides the mirror panel by opening a text document in its column. */
async function hidePanel(): Promise<void> {
  const column = mirrorTabs()[0]?.group.viewColumn;
  assert.ok(column !== undefined, 'no mirror tab');
  const doc = await vscode.workspace.openTextDocument({ content: 'x' });
  await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
}

async function showPanel(): Promise<void> {
  await vscode.commands.executeCommand('sailfish.agent.mirror');
}

async function sendTestInput(message: Record<string, unknown>): Promise<void> {
  await vscode.commands.executeCommand('sailfish._test.mirrorInput', DEVICE, message);
}

async function setTestFocus(focused: boolean): Promise<void> {
  await vscode.commands.executeCommand('sailfish._test.mirrorFocus', DEVICE, focused);
}

async function waitLive(): Promise<void> {
  await waitFor(() => requests().length >= 1, 8000);
}

suite('screen mirror over the SSH forward (F6)', () => {
  let sandbox: sinon.SinonSandbox;
  let messages: MessageStubs;
  let log: LogSpy;

  suiteSetup(async function () {
    this.timeout(15000);
    await waitForContext('sailfish.sdkAvailable', true, 10000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.workspace.getConfiguration('sailfish', folder?.uri).update('device', DEVICE, vscode.ConfigurationTarget.WorkspaceFolder);
  });

  suiteTeardown(async function () {
    this.timeout(15000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.workspace.getConfiguration('sailfish', folder?.uri).update('device', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  });

  setup(() => {
    sandbox = sinon.createSandbox();
    log = spyOutput(sandbox);
    messages = stubMessages();
    try {
      fs.rmSync(path.join(path.dirname(process.env.SFDK_FAKE_LOG ?? '/nonexistent/x'), 'ssh-rekey.marker'), { force: true });
    } catch {
      // ignore
    }
  });

  teardown(async function () {
    this.timeout(20000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(500);
    sandbox.restore();
    resetKnownHosts();
    clearFakeLog();
  });

  test('I1 forward used: ping, host-key read, ssh -N with the pinned argv, binary request, acks, no sfdk mirror', async function () {
    this.timeout(30000);
    await withScenario('agent-forward', async () => {
      resetKnownHosts();
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitFor(() => acks().length >= 3, 8000);
      const keys = sfdkKeys();
      const ping = keys.indexOf('device_exec.sailfish-devagent.ping');
      const cat = keys.indexOf('device_exec.cat');
      assert.ok(ping >= 0 && cat > ping, JSON.stringify(keys));
      assert.ok(readLog().findIndex((e) => e.key === 'ssh_forward' && !e.event) > readLog().findIndex((e) => e.key === 'device_exec.cat'));
      const catEntry = readLog().find((e) => e.key === 'device_exec.cat');
      assert.ok(argvOf(catEntry as LogEntry).includes('/etc/ssh/ssh_host_ed25519_key.pub'), JSON.stringify(catEntry));
      assert.strictEqual(spawns().length, 1);
      const argv = argvOf(spawns()[0]);
      for (const o of ['-N', 'StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes', 'BatchMode=yes', 'IdentitiesOnly=yes', '--']) {
        assert.ok(argv.includes(o), `${o} missing from ${JSON.stringify(argv)}`);
      }
      assert.strictEqual(optionValue(argv, '-F'), 'none');
      assert.strictEqual(optionValue(argv, '-i'), path.join(fixturesRoot(), 'ssh', 'fake_key'));
      assert.strictEqual(optionValue(argv, '-p'), '22');
      assert.strictEqual(argv[argv.indexOf('--') + 1], 'defaultuser@192.168.2.15');
      assert.ok((optionValue(argv, '-L') ?? '').endsWith(`:${SOCKET}`), JSON.stringify(argv));
      const known = fs.readFileSync(knownHostsFile(), 'utf8');
      assert.ok(known.includes(`${hostKeyAlias(DEVICE)} ssh-ed25519 ${PINNED_KEY}`), known);
      assert.ok(known.includes('sailfish-Xperia-10-Dual-SIM-ARM ssh-ed25519 '), known);
      assert.ok((requests()[0].line ?? '').includes('"encoding":"binary"'), JSON.stringify(requests()));
      assert.deepStrictEqual([1, 2, 3].filter((n) => acks().includes(n)), [1, 2, 3]);
      assert.strictEqual(sfdkMirrors().length, 0, JSON.stringify(sfdkKeys()));
      assert.ok(!messages.calls.some((m) => m.kind === 'error' || m.kind === 'warning'), JSON.stringify(messages.calls));
      assert.strictEqual(mirrorTabs().length, 1);
    });
  });

  test('I2 private socket: mode 0600 in a 0700 directory owned by the user', async function () {
    this.timeout(30000);
    await withScenario('agent-forward', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitLive();
      const sock = localSocket(spawns()[0]);
      const st = fs.lstatSync(sock);
      assert.ok(st.isSocket(), sock);
      assert.strictEqual(st.mode & 0o777, 0o600);
      const dir = fs.lstatSync(path.dirname(sock));
      assert.ok(dir.isDirectory() && !dir.isSymbolicLink());
      assert.strictEqual(dir.mode & 0o777, 0o700);
      assert.strictEqual(dir.uid, process.getuid?.());
    });
  });

  test('I3 close: the connection closes, ssh gets SIGTERM, socket and directory are removed', async function () {
    this.timeout(30000);
    await withScenario('agent-forward', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitLive();
      const sock = localSocket(spawns()[0]);
      await showPanel();
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await waitFor(() => closed().length >= 1 && killed().length >= 1, 5000);
      await waitFor(() => !fs.existsSync(path.dirname(sock)), 5000);
      assert.ok(!fs.existsSync(sock));
    });
  });

  test('I4 hide and show: the connection closes, ssh is reused, closing then kills it', async function () {
    this.timeout(40000);
    await withScenario('agent-forward', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitLive();
      await hidePanel();
      await waitFor(() => closed().length >= 1, 5000);
      await sleep(3000);
      assert.strictEqual(killed().length, 0, 'ssh must be kept for idle reuse');
      await showPanel();
      await waitFor(() => requests().length >= 2, 5000);
      assert.strictEqual(spawns().length, 1, 'no second ssh spawn on re-show');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await waitFor(() => killed().length >= 1, 5000);
    });
  });

  test('I5 auth fallback: ssh fails with a permission error, the mirror runs through sfdk', async function () {
    this.timeout(30000);
    await withScenario('agent-forward-auth', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitFor(() => sfdkMirrors().length >= 1, 8000);
      assert.strictEqual(spawns().length, 1);
      const all = readLog();
      assert.ok(all.findIndex((e) => e.key === 'ssh_forward' && !e.event) < all.findIndex((e) => e.key === SFDK_MIRROR && !e.event));
      assert.ok(log.messages.some((m) => m.includes('ssh forward unavailable (auth')), JSON.stringify(log.messages));
      assert.ok(!messages.calls.some((m) => m.kind === 'error' || m.kind === 'warning'), JSON.stringify(messages.calls));
    });
  });

  test('I6 direct-path mismatch: one warning without Trust New Key, falls back, pins nothing new, warns once', async function () {
    this.timeout(40000);
    await withScenario('agent-forward-hostkey', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitFor(() => sfdkMirrors().length >= 1, 10000);
      assert.strictEqual(entries('device_exec.cat').length, 2, JSON.stringify(sfdkKeys()));
      const warnings = messages.calls.filter((m) => m.kind === 'warning');
      assert.strictEqual(warnings.length, 1, JSON.stringify(messages.calls));
      assert.ok(warnings[0].message.includes('does not match'), warnings[0].message);
      assert.ok(!warnings[0].items.includes('Trust New Key'), JSON.stringify(warnings[0]));
      const known = fs.readFileSync(knownHostsFile(), 'utf8');
      assert.ok(known.includes(PINNED_KEY) && known.trim().split('\n').length === 1, known);
      // Reopen in the same session: no second warning.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await sleep(500);
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitFor(() => sfdkMirrors().length >= 2, 10000);
      assert.strictEqual(messages.calls.filter((m) => m.kind === 'warning').length, 1, JSON.stringify(messages.calls));
      assert.strictEqual(fs.readFileSync(knownHostsFile(), 'utf8'), known);
    });
  });

  test('I7 remote refused: falls back to sfdk', async function () {
    this.timeout(30000);
    await withScenario('agent-forward-refused', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitFor(() => sfdkMirrors().length >= 1, 8000);
      assert.ok(!messages.calls.some((m) => m.kind === 'error'), JSON.stringify(messages.calls));
    });
  });

  test('I8 old agent: no ssh, the mirror runs through sfdk without a lease', async function () {
    this.timeout(30000);
    await withScenario('agent-new', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitFor(() => sfdkMirrors().length >= 1, 8000);
      assert.strictEqual(spawns().length, 0, JSON.stringify(readLog()));
      // The 1.1.0 client exits 2 on an unknown option: the request stays as in extension 0.1.6 (plan O14).
      assert.ok(!argvOf(sfdkMirrors()[0]).includes('--lease'), JSON.stringify(sfdkMirrors()[0]));
    });
  });

  test('I9 key missing: the default scenario key does not exist, no ssh, the mirror runs through sfdk', async function () {
    this.timeout(30000);
    // default's ping reports 1.0.0 (no mirror), so agent-forward-nokey pairs a 1.2.0 ping with default's device list.
    await withScenario('agent-forward-nokey', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitFor(() => sfdkMirrors().length >= 1, 8000);
      assert.strictEqual(spawns().length, 0, JSON.stringify(readLog()));
    });
  });

  test('I10 corrupt binary stream: disconnected, no sfdk fallback', async function () {
    this.timeout(30000);
    await withScenario('agent-forward-corrupt', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitFor(() => hasStatus(log, 'disconnected'), 8000);
      await sleep(1500);
      assert.strictEqual(sfdkMirrors().length, 0, JSON.stringify(sfdkKeys()));
      assert.strictEqual(spawns().length, 1);
    });
  });

  test('I11 orphan sweep: a dead host directory goes, a live host directory stays', async function () {
    this.timeout(30000);
    const base = privateDir();
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const dead = path.join(base, 'mirror-999999999-x');
    const live = path.join(base, `mirror-${process.pid}-keepme`);
    for (const d of [dead, live]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dead, 'ssh.pid'), '999999998\n');
    try {
      await withScenario('agent-forward', async () => {
        await vscode.commands.executeCommand('sailfish.agent.mirror');
        await waitLive();
        await waitFor(() => !fs.existsSync(dead), 5000);
        assert.ok(fs.existsSync(live), 'the live host directory must stay');
      });
    } finally {
      fs.rmSync(dead, { recursive: true, force: true });
      fs.rmSync(live, { recursive: true, force: true });
    }
  });

  test('I12 keepalive while visible: the request asks for a lease, keepalives arrive with increasing seq', async function () {
    const timing = mirrorTiming();
    this.timeout(30000);
    const prev = timing.keepaliveIntervalMs;
    timing.keepaliveIntervalMs = 500;
    try {
      await withScenario('agent-forward', async () => {
        await vscode.commands.executeCommand('sailfish.agent.mirror');
        await waitLive();
        assert.ok((requests()[0].line ?? '').includes('"lease":60'), JSON.stringify(requests()));
        await waitFor(() => keepalives().length >= 3, 3000);
        const seqs = keepalives().map((k) => k.seq as number);
        for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], JSON.stringify(seqs));
      });
    } finally {
      timing.keepaliveIntervalMs = prev;
    }
  });

  test('I13 no keepalive while hidden, keepalives resume when shown', async function () {
    const timing = mirrorTiming();
    this.timeout(40000);
    const prev = timing.keepaliveIntervalMs;
    timing.keepaliveIntervalMs = 300;
    try {
      await withScenario('agent-forward', async () => {
        await vscode.commands.executeCommand('sailfish.agent.mirror');
        await waitLive();
        await waitFor(() => keepalives().length >= 1, 3000);
        await hidePanel();
        const atHide = keepalives().length;
        await sleep(1400);
        assert.strictEqual(keepalives().length, atHide, 'no keepalive while hidden');
        await showPanel();
        await waitFor(() => keepalives().length > atHide, 1000 + 2000);
      });
    } finally {
      timing.keepaliveIntervalMs = prev;
    }
  });

  test('I14 lease expiry is shown: disconnected, no sfdk fallback, no automatic retry', async function () {
    this.timeout(30000);
    await withScenario('agent-forward-lease', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitLive();
      await waitFor(() => hasStatus(log, 'disconnected'), 6000);
      assert.ok(log.messages.some((m) => m.includes('lease expired')), JSON.stringify(log.messages));
      await sleep(3000);
      assert.strictEqual(sfdkMirrors().length, 0, JSON.stringify(sfdkKeys()));
      assert.strictEqual(requests().length, 1, 'no automatic retry');
    });
  });

  test('I15 keepalive on the sfdk fallback: --lease 60 and stdin lines while visible', async function () {
    const timing = mirrorTiming();
    this.timeout(40000);
    const prev = timing.keepaliveIntervalMs;
    timing.keepaliveIntervalMs = 500;
    try {
      // A 1.2.0 agent whose forward is ineligible (missing key): only agents from 1.2.0 get a lease through sfdk.
      await withScenario('agent-forward-sfdk-lease', async () => {
        await vscode.commands.executeCommand('sailfish.agent.mirror');
        await waitFor(() => sfdkMirrors().length >= 1, 8000);
        assert.strictEqual(spawns().length, 0, JSON.stringify(readLog()));
        const argv = argvOf(sfdkMirrors()[0]);
        const at = argv.indexOf('--lease');
        assert.ok(at >= 0 && argv[at + 1] === '60', JSON.stringify(argv));
        const stdinLines = (): string[] => entries(SFDK_MIRROR, 'stdin').map((e) => e.line ?? '');
        await waitFor(() => stdinLines().filter((l) => /^\{"keepalive":\d+\}$/.test(l)).length >= 2, 3000);
        await hidePanel();
        await sleep(2200); // grace period plus one interval
        const atHide = stdinLines().length;
        await sleep(1500);
        assert.strictEqual(stdinLines().length, atHide, 'no keepalive while hidden');
      });
    } finally {
      timing.keepaliveIntervalMs = prev;
    }
  });

  test('I16 emulator re-pin: a changed key that the SDK confirms is pinned, ssh is retried, no popup', async function () {
    this.timeout(40000);
    await withScenario('agent-forward-emu-rekey', async () => {
      const alias = hostKeyAlias(EMULATOR);
      // Learn the storage path from a first, successful run is not possible here: use the located file.
      const file = knownHostsFile();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${alias} ssh-ed25519 ${OTHER_KEY}\n`, { mode: 0o600 });
      await vscode.commands.executeCommand('sailfish.agent.mirror', emulatorItem());
      await waitFor(() => acks().length >= 1, 15000);
      assert.strictEqual(spawns().length, 2, JSON.stringify(readLog().map((e) => e.key)));
      const known = fs.readFileSync(file, 'utf8');
      assert.ok(known.includes(`${alias} ssh-ed25519 ${PINNED_KEY}`) && !known.includes(OTHER_KEY), known);
      assert.ok(!messages.calls.some((m) => m.kind === 'warning' || m.kind === 'error'), JSON.stringify(messages.calls));
      assert.strictEqual(sfdkMirrors().length, 0);
    });
  });

  test('I17 no secrets in logs: no private key text, long base64 runs, keepalives or acks', async function () {
    this.timeout(60000);
    const timing = mirrorTiming();
    const prev = timing.keepaliveIntervalMs;
    timing.keepaliveIntervalMs = 500;
    try {
      await withScenario('agent-forward', async () => {
        await vscode.commands.executeCommand('sailfish.agent.mirror');
        await waitFor(() => acks().length >= 3, 8000);
        await sleep(1200);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await sleep(500);
      });
      await withScenario('agent-forward-auth', async () => {
        await vscode.commands.executeCommand('sailfish.agent.mirror');
        await waitFor(() => sfdkMirrors().length >= 1, 8000);
      });
    } finally {
      timing.keepaliveIntervalMs = prev;
    }
    for (const m of log.messages) {
      assert.ok(!m.includes('PRIVATE KEY'), m);
      assert.ok(!/[A-Za-z0-9+/=]{200,}/.test(m), m.slice(0, 120));
      assert.ok(!m.includes('"keepalive"') && !m.includes('"ack"'), m);
    }
  });

  test('I18 vp8: agent 1.6.0 and a page with WebCodecs get video; the page decodes it without asking for a key frame', async function () {
    this.timeout(30000);
    await withScenario('agent-forward-vp8', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitOrDump(log, () => hasStatus(log, 'video: decoding 90x200'), 10000);
      const req = requests()[0].line ?? '';
      for (const f of ['"encoding":"vp8"', '"fps":30', '"width":720', '"bitrate":2000', '"adapt":true']) assert.ok(req.includes(f), req);
      assert.ok(hasStatus(log, 'the panel decodes vp8'));
      assert.ok(hasStatus(log, 'live (ssh), vp8'));
      await waitFor(() => acks().includes(10), 5000);
      assert.deepStrictEqual(keyframeRequests(), [], 'a stream that starts with a key frame needs no request');
      assert.ok(!acks().includes(100), 'the PNG record is only for a JPEG request');
      assert.strictEqual(sfdkMirrors().length, 0);
    });
  });

  test('I19 vp8 gap: deltas without a key frame are skipped and one key frame is asked for, then the stream decodes', async function () {
    this.timeout(30000);
    await withScenario('agent-forward-vp8-gap', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitOrDump(log, () => keyframeRequests().length >= 1, 10000);
      assert.ok(hasStatus(log, 'video: key frame requested (no key frame yet'));
      await waitOrDump(log, () => hasStatus(log, 'video: decoding 90x200'), 8000);
      assert.strictEqual(keyframeRequests().length, 1, 'one request for the gap, not one per delta');
    });
  });

  test('I20 vp8 that does not decode: after three decode errors the panel reconnects with JPEG', async function () {
    this.timeout(40000);
    await withScenario('agent-forward-vp8-broken', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitOrDump(log, () => requests().length >= 2, 15000);
      assert.ok((requests()[0].line ?? '').includes('"encoding":"vp8"'), JSON.stringify(requests()));
      assert.ok((requests()[1].line ?? '').includes('"encoding":"binary"'), JSON.stringify(requests()));
      assert.ok(hasStatus(log, 'video does not decode in this panel (decode error'), JSON.stringify(log.messages.filter((m) => m.includes('video'))));
      await waitFor(() => acks().includes(100), 8000);
      assert.ok(hasStatus(log, 'live (ssh), png'));
      assert.strictEqual(spawns().length, 1, 'the same ssh forward carries the JPEG stream');
    });
  });

  test('I21 input focus lease: 1.7 opts in, renews only while focused, and clears immediately when hidden', async function () {
    this.timeout(30000);
    await withScenario('agent-forward-input', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitLive();
      await setTestFocus(true);
      await waitFor(() => inputs().some((e) => e.input?.type === 'active' && e.input.active === true), 8000);
      assert.ok((requests()[0].line ?? '').includes('"input":true'), requests()[0].line);
      await hidePanel();
      await waitFor(() => inputs().some((e) => e.input?.type === 'active' && e.input.active === false), 3000);
      const hiddenAt = inputs().length;
      await sleep(1500);
      // Only renewals count: the hide grace and the stream end each send another safety-off (active:false).
      const after = inputs().slice(hiddenAt).map((e) => e.input);
      assert.ok(after.every((i) => i?.type === 'active' && i.active === false), `the active lease must not renew while hidden: ${JSON.stringify(after)}`);
    });
  });

  test('I26 live contact: a focused 1.9 panel sends diagonal down, move and fail-open up', async function () {
    this.timeout(30000);
    await withScenario('agent-forward-input-live', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitLive();
      await setTestFocus(true);
      await waitFor(() => inputs().some((e) => e.input?.type === 'active' && e.input.active === true), 8000);
      await sendTestInput({ type: 'input', action: 'down', frame: 1, screen: [720, 1600], x: 0.25, y: 0.2 });
      await sendTestInput({ type: 'input', action: 'move', frame: 1, screen: [720, 1600], x: 0.75, y: 0.8 });
      for (let i = 0; i < 25; i++) {
        await sendTestInput({ type: 'input', action: 'unknown', frame: 1, screen: [720, 1600], sequence: i });
      }
      await sendTestInput({ type: 'input', action: 'up', frame: 1, screen: [720, 1600] });
      await waitFor(() => inputs().some((e) => e.input?.type === 'up'), 3000);
      const contact = inputs().filter((e) => ['down', 'move', 'up'].includes(e.input?.type ?? '')).map((e) => e.input);
      assert.deepStrictEqual(contact, [
        { type: 'down', x: 180, y: 320 },
        { type: 'move', x: 539, y: 1279 },
        { type: 'up' },
      ]);
    });
  });

  test('I27 keypad: a user-created layout reloads on save and a pointer key press reaches the phone', async function () {
    this.timeout(30000);
    const posted: unknown[] = [];
    const layoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-keypad-'));
    const layoutPath = path.join(layoutDir, 'my-callback.json');
    const saveDialog = stubSaveDialog(vscode.Uri.file(layoutPath));
    const createPanel = vscode.window.createWebviewPanel.bind(vscode.window);
    sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((...args: Parameters<typeof vscode.window.createWebviewPanel>) => {
      const panel = createPanel(...args);
      const post = panel.webview.postMessage.bind(panel.webview);
      sandbox.stub(panel.webview, 'postMessage').callsFake((message: unknown) => {
        posted.push(message);
        return post(message);
      });
      return panel;
    });
    await withScenario('agent-forward-keypad', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitLive();
      type Posted = { type?: string; strip?: { action?: string }; layout?: { model: string; rows: Array<Array<{ key: string; label: string; style?: string } | null>> } | null };
      const keypadPosts = (): Posted[] => (posted as Posted[]).filter((m) => m?.type === 'keypad');
      await waitFor(() => (posted as Posted[]).some((m) => m.type === 'state' && m.strip?.action === 'keypad'), 8000);
      assert.strictEqual(keypadPosts().some((m) => m.layout), false, 'no layout is applied by default');
      await vscode.commands.executeCommand('sailfish.agent.editKeypadLayout');
      assert.strictEqual(saveDialog.callCount, 1);
      const saveOptions = saveDialog.firstCall.args[0] as vscode.SaveDialogOptions;
      assert.ok(saveOptions.defaultUri?.fsPath.endsWith(path.join('.sailfish', 'keypads', 'commodore-callback.json')));
      assert.ok(fs.existsSync(layoutPath), 'the starter layout was written to the chosen location');
      await waitFor(() => keypadPosts().some((m) => m.layout), 8000);

      const changed = JSON.parse(fs.readFileSync(layoutPath, 'utf8')) as { rows: Array<Array<{ key?: string; label?: string } | string | null>> };
      changed.rows = [[{ key: '5', label: 'Five' }]];
      await vscode.workspace.fs.writeFile(vscode.Uri.file(layoutPath), Buffer.from(`${JSON.stringify(changed, null, 2)}\n`));
      await waitFor(() => keypadPosts().some((m) => m.layout?.rows.flat().some((cell) => cell?.label === 'Five')), 8000);
      const layout = keypadPosts().filter((m) => m.layout).at(-1)?.layout;
      assert.strictEqual(layout?.model, 'Commodore Callback');
      const keys = (layout?.rows ?? []).flat().filter((c) => c !== null).map((c) => c.key);
      assert.deepStrictEqual(keys, ['5']);
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await setTestFocus(true);
      await waitFor(() => inputs().some((e) => e.input?.type === 'active' && e.input.active === true), 8000);
      await sendTestInput({ type: 'input', action: 'key', key: 'F23', pressed: true });
      await sendTestInput({ type: 'input', action: 'key', key: '5', pressed: true });
      await sendTestInput({ type: 'input', action: 'key', key: '5', pressed: false });
      await waitFor(() => inputs().some((e) => e.input?.type === 'key' && e.input.pressed === false), 3000);
      const keyEvents = inputs().filter((e) => e.input?.type === 'key').map((e) => e.input);
      assert.deepStrictEqual(keyEvents, [
        { type: 'key', key: '5', pressed: true },
        { type: 'key', key: '5', pressed: false },
      ]);
      await vscode.commands.executeCommand('sailfish.agent.resetKeypadLayout');
      await waitFor(() => keypadPosts().at(-1)?.layout === null, 8000);
      assert.ok(fs.existsSync(layoutPath), 'reset forgets the layout without deleting it');
    });
    fs.rmSync(layoutDir, { recursive: true, force: true });
  });

  test('I28 touch indicator fallback: agent 1.10.4 reports the mirror path, a contact record draws the marker, details say in mirror', async function () {
    this.timeout(30000);
    const posted: unknown[] = [];
    const createPanel = vscode.window.createWebviewPanel.bind(vscode.window);
    sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((...args: Parameters<typeof vscode.window.createWebviewPanel>) => {
      const panel = createPanel(...args);
      const post = panel.webview.postMessage.bind(panel.webview);
      sandbox.stub(panel.webview, 'postMessage').callsFake((message: unknown) => {
        posted.push(message);
        return post(message);
      });
      return panel;
    });
    type Posted = { type?: string; path?: string; x?: number; y?: number; down?: boolean; screen?: number[]; details?: Array<{ label: string; value: string }> };
    const of = (type: string): Posted[] => (posted as Posted[]).filter((m) => m?.type === type);
    const touchRow = (): string | undefined => of('state').at(-1)?.details?.find((r) => r.label === 'Touch indicator')?.value;
    await withScenario('agent-forward-touch-mirror', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitLive();
      assert.ok((requests()[0].line ?? '').includes('"phoneState":true'), requests()[0].line);
      assert.ok(!of('contact').length, 'no marker before control is active');
      await setTestFocus(true);
      await waitFor(() => of('touchIndicator').some((m) => m.path === 'mirror'), 8000);
      await waitFor(() => touchRow() === 'in mirror', 3000);
      await sendTestInput({ type: 'input', action: 'down', frame: 1, screen: [720, 1600], x: 0.25, y: 0.2 });
      await waitFor(() => of('contact').length > 0, 3000);
      assert.deepStrictEqual(of('contact')[0], { type: 'contact', x: 180, y: 320, down: true, screen: [720, 1600] });
      await sendTestInput({ type: 'input', action: 'up', frame: 1, screen: [720, 1600] });
      await setTestFocus(false);
      await waitFor(() => of('touchIndicator').at(-1)?.path === 'off', 3000);
      await waitFor(() => touchRow() === 'off', 3000);
    });
  });

  test('I29 idle streaming off: the request carries idle:pause', async function () {
    this.timeout(30000);
    const config = vscode.workspace.getConfiguration('sailfish');
    await config.update('mirror.idleStreaming', false, vscode.ConfigurationTarget.Global);
    try {
      await withScenario('agent-forward-touch-mirror', async () => {
        await vscode.commands.executeCommand('sailfish.agent.mirror');
        await waitLive();
        assert.ok((requests()[0].line ?? '').includes('"idle":"pause"'), requests()[0].line);
      });
    } finally {
      await config.update('mirror.idleStreaming', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('I22 control off on the phone: the strip says so, no active:true is ever sent, Device Agent Status names it', async function () {
    this.timeout(30000);
    await withScenario('agent-settings-control-off', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitFor(() => hasStatus(log, 'control off (disabled on the phone)'), 8000);
      assert.ok((requests()[0].line ?? '').includes('"phoneState":true'), requests()[0].line);
      await sleep(1500);
      assert.ok(!inputs().some((e) => e.input?.type === 'active' && e.input.active === true), JSON.stringify(inputs()));
      messages.calls.length = 0;
      await vscode.commands.executeCommand('sailfish.agent.status');
      assert.ok(messages.calls.some((m) => m.message.includes('turned off control')), JSON.stringify(messages.calls));
    });
  });

  test('I23 screen view off on the phone: the strip reads disconnected with the reason, no retry, no sfdk fallback', async function () {
    this.timeout(30000);
    await withScenario('agent-settings-view-off', async () => {
      await vscode.commands.executeCommand('sailfish.agent.mirror');
      await waitFor(
        () => hasStatus(log, 'disconnected: screen view is disabled on the phone (Settings › System › Developer agent)'),
        8000,
      );
      await sleep(1500);
      assert.strictEqual(requests().length, 1, 'no automatic retry');
      assert.strictEqual(sfdkMirrors().length, 0, JSON.stringify(sfdkKeys()));
    });
  });
});
