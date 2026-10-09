import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SshForward } from '../../src/agent/sshForward';
import type { Output } from '../../src/core/output';
import type { SfdkDeviceInfo } from '../../src/core/types';
import { fixturesRoot, waitFor, withScenario } from './helpers';

/** The TCP variant of the SSH forward against the fake `ssh` (test/fixtures/bin/ssh, first on PATH). */

const output = { log: () => undefined } as unknown as Output;
const token = new vscode.CancellationTokenSource().token;

function device(): SfdkDeviceInfo {
  return {
    index: 0,
    name: 'Sailfish OS Emulator 5.1.0.11',
    kind: 'emulator',
    origin: 'autodetected',
    user: 'defaultuser',
    host: '127.0.0.1',
    port: 2223,
    privateKey: path.join(fixturesRoot(), 'ssh', 'fake_key'),
    flags: [],
    extra: [],
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function logged(key: string, event?: string): { argv?: string[] }[] {
  const p = process.env.SFDK_FAKE_LOG;
  if (!p || !fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { key: string; event?: string; argv?: string[] })
    .filter((e) => e.key === key && e.event === event);
}

suite('SSH forward, TCP variant', () => {
  let storageDir: string;

  setup(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcpfwd-'));
  });
  teardown(() => fs.rmSync(storageDir, { recursive: true, force: true }));

  test('opens a loopback forward, accepts a connection, and close stops ssh', async function () {
    this.timeout(30000);
    await withScenario('agent-forward', async () => {
      const port = await freePort();
      const r = await SshForward.openTcp(device(), port, { storageDir, token, output });
      assert.ok(r.ok, JSON.stringify(r));
      const spec = `127.0.0.1:${port}:127.0.0.1:${port}`;
      const argv = logged('ssh_forward')[0]?.argv ?? [];
      assert.strictEqual(argv[argv.indexOf('-L') + 1], spec);
      const sock = await r.forward.connect();
      assert.ok(!sock.destroyed);
      await r.forward.close();
      await waitFor(() => logged('ssh_forward', 'killed').length === 1, 5000);
      await assert.rejects(r.forward.connect());
    });
  });

  test('a busy local port fails as local-bind', async function () {
    this.timeout(30000);
    await withScenario('agent-forward', async () => {
      const busy = net.createServer();
      await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
      try {
        const r = await SshForward.openTcp(device(), (busy.address() as net.AddressInfo).port, { storageDir, token, output });
        assert.ok(!r.ok);
        assert.strictEqual(r.cls, 'local-bind');
      } finally {
        busy.close();
      }
    });
  });
});
