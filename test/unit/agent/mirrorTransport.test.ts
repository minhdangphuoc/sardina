import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { Services } from '../../../src/core/services';
import type { SfdkDeviceInfo } from '../../../src/core/types';
import {
  FORWARD_TIMING,
  ForwardTransport,
  SFDK_STDIN_KEEPALIVE,
  SfdkExecTransport,
  sfdkFallbackLease,
  type FrameEvent,
  type MirrorEnd,
  type MirrorSink,
} from '../../../src/agent/mirrorTransport';
import { ensureKnownHostsFile, readPinnedKeys } from '../../../src/agent/sshForward';
import { ADAPT_TUNING, type AdaptDecision } from '../../../src/agent/mirrorAdapt';

const savedAdapt = { ...ADAPT_TUNING };

const SOCK = '/run/user/100000/sailfish-devagent/agent.sock';
const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

function makeToken(): { token: vscode.CancellationToken; cancel: () => void } {
  const listeners: (() => void)[] = [];
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (fn: () => void) => {
      listeners.push(fn);
      return { dispose: () => undefined };
    },
  };
  return {
    token: token as unknown as vscode.CancellationToken,
    cancel: () => {
      token.isCancellationRequested = true;
      for (const l of listeners) l();
    },
  };
}

interface Events {
  names: string[];
  frames: FrameEvent[];
  fatals: string[];
  corrupt: number;
  pongs: [number, number][];
  sink: MirrorSink;
}

function makeSink(): Events {
  const e: Events = {
    names: [],
    frames: [],
    fatals: [],
    corrupt: 0,
    pongs: [],
    sink: {
      status: () => e.names.push('status'),
      frame: (f) => {
        e.names.push('frame');
        e.frames.push(f);
      },
      same: () => e.names.push('same'),
      softError: () => e.names.push('softError'),
      pong: (seq, ts) => {
        e.names.push('pong');
        e.pongs.push([seq, ts]);
      },
      fatal: (error) => {
        e.names.push('fatal');
        e.fatals.push(error);
      },
      corrupt: () => {
        e.corrupt++;
      },
    },
  };
  return e;
}

describe('SfdkExecTransport', () => {
  function services(lines: string[], seen: { opts?: Record<string, unknown>; write?: (d: string) => void }, exit = 0): Services {
    return {
      runner: {
        run: (opts: Record<string, unknown> & { onLine: (l: string, s: string) => void; onStdin?: (w: (d: string) => void) => void }) => {
          seen.opts = opts;
          opts.onStdin?.((d) => seen.write?.(d));
          for (const l of lines) opts.onLine(l, 'stdout');
          opts.onLine('some stderr', 'stderr');
          return Promise.resolve({ exitCode: exit, cancelled: false });
        },
      },
    } as unknown as Services;
  }

  it('decodes base64 frames to bytes and forwards every line kind', async () => {
    const lines = [
      '{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60}',
      `{"frame":1,"ts":5,"screen":[720,1600],"size":[360,800],"format":"jpeg","data":"${JPEG_BASE64}"}`,
      '{"frame":2,"ts":6,"same":true}',
      '{"frame":3,"ts":7,"error":"capture failed"}',
      'not json',
      '{"pong":4,"ts":99}',
      '{"ok":false,"error":"replaced"}',
    ];
    const seen: { opts?: Record<string, unknown> } = {};
    const e = makeSink();
    const end = await new SfdkExecTransport(services(lines, seen), 'Xperia').run(e.sink, makeToken().token);
    assert.deepStrictEqual(e.names, ['status', 'frame', 'same', 'softError', 'pong', 'fatal']);
    assert.deepStrictEqual([...e.frames[0].payload], [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    assert.strictEqual(e.corrupt, 1);
    assert.deepStrictEqual(e.pongs, [[4, 99]]);
    assert.deepStrictEqual(e.fatals, ['replaced']);
    assert.deepStrictEqual(end, { cancelled: false, reason: 'some stderr' });
    assert.strictEqual(seen.opts?.device, 'Xperia');
    assert.strictEqual(seen.opts?.collectOutput, false);
  });

  it('sfdkFallbackLease: on for agents from 1.2.0 only (the 1.1.0 client rejects --lease)', () => {
    assert.strictEqual(SFDK_STDIN_KEEPALIVE, true);
    assert.strictEqual(sfdkFallbackLease('1.1.0'), false);
    assert.strictEqual(sfdkFallbackLease('1.0.0'), false);
    assert.strictEqual(sfdkFallbackLease('1.2.0'), true);
    assert.strictEqual(sfdkFallbackLease('1.10.0'), true);
    assert.strictEqual(sfdkFallbackLease(''), false);
  });

  it('asks for no lease and has no stdin writer by default', async () => {
    const seen: { opts?: Record<string, unknown> } = {};
    await new SfdkExecTransport(services([], seen), 'X').run(makeSink().sink, makeToken().token);
    assert.ok(!(seen.opts?.args as string[]).includes('--lease'));
    assert.strictEqual(seen.opts?.onStdin, undefined);
  });

  it('with the lease on: --lease 60 and keepalive lines go to the child stdin', async () => {
    const written: string[] = [];
    const seen: { opts?: Record<string, unknown>; write?: (d: string) => void } = { write: (d) => written.push(d) };
    const t = new SfdkExecTransport(services([], seen), 'X', true);
    const args: string[] = [];
    await t.run(makeSink().sink, makeToken().token);
    args.push(...(seen.opts?.args as string[]));
    assert.deepStrictEqual(args.slice(-2), ['--lease', '60']);
    // The writer is dropped once the run has ended: nothing is written afterwards.
    t.keepalive(1);
    assert.deepStrictEqual(written, []);
  });

  it('writes keepalives while the run is live', async () => {
    const written: string[] = [];
    let release: () => void = () => undefined;
    const s = {
      runner: {
        run: (opts: { onStdin?: (w: (d: string) => void) => void }) => {
          opts.onStdin?.((d) => written.push(d));
          return new Promise((resolve) => {
            release = () => resolve({ exitCode: 0, cancelled: true });
          });
        },
      },
    } as unknown as Services;
    const t = new SfdkExecTransport(s, 'X', true);
    const running = t.run(makeSink().sink, makeToken().token);
    t.keepalive(3);
    release();
    await running;
    assert.deepStrictEqual(written, ['{"keepalive":3}\n']);
  });

  it('opts an advertised sfdk fallback into input and writes only accepted input shapes', async () => {
    const written: string[] = [];
    let release: () => void = () => undefined;
    let args: string[] = [];
    const s = {
      runner: {
        run: (opts: { args: string[]; onStdin?: (w: (d: string) => void) => void; onLine: (line: string, stream: string) => void }) => {
          args = opts.args;
          opts.onStdin?.((d) => written.push(d));
          opts.onLine('{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60,"lease":60,"input":true,"inputLease":3}', 'stdout');
          return new Promise((resolve) => { release = () => resolve({ exitCode: 0, cancelled: true }); });
        },
      },
    } as unknown as Services;
    const t = new SfdkExecTransport(s, 'X', true, true);
    const running = t.run(makeSink().sink, makeToken().token);
    t.inputActive(true);
    assert.strictEqual(t.input({ type: 'tap', x: 7, y: 8 }), true);
    t.inputActive(false);
    assert.ok(args.includes('--input'), JSON.stringify(args));
    assert.deepStrictEqual(written, [
      '{"input":{"type":"active","active":true}}\n',
      '{"input":{"type":"tap","x":7,"y":8}}\n',
      '{"input":{"type":"active","active":false}}\n',
    ]);
    release();
    await running;
    assert.strictEqual(t.input({ type: 'tap', x: 1, y: 1 }), false);
  });

  it('phone settings: active:false goes out before input stops, and input resumes on input:true', async () => {
    const written: string[] = [];
    let feed: (line: string) => void = () => undefined;
    let release: () => void = () => undefined;
    const s = {
      runner: {
        run: (opts: { onStdin?: (w: (d: string) => void) => void; onLine: (line: string, stream: string) => void }) => {
          opts.onStdin?.((d) => written.push(d));
          feed = (line) => opts.onLine(line, 'stdout');
          feed('{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60,"lease":60,"input":true,"inputLease":3}');
          return new Promise((resolve) => { release = () => resolve({ exitCode: 0, cancelled: true }); });
        },
      },
    } as unknown as Services;
    const t = new SfdkExecTransport(s, 'X', true, true);
    const e = makeSink();
    const seen: (boolean | undefined)[] = [];
    // Like the session: release control at once when the phone stops it, re-activate when it allows it again.
    e.sink.settings = (p) => {
      seen.push(p.input);
      if (p.input !== undefined) t.inputActive(p.input);
    };
    const running = t.run(e.sink, makeToken().token);
    t.inputActive(true);
    feed('{"settings":{"control":false},"input":false,"inputError":"control disabled on the phone"}');
    assert.strictEqual(t.input({ type: 'tap', x: 1, y: 1 }), false);
    t.inputActive(true);
    feed('{"settings":{"control":true},"input":true,"inputLease":3}');
    assert.deepStrictEqual(seen, [false, true]);
    assert.deepStrictEqual(written, [
      '{"input":{"type":"active","active":true}}\n',
      '{"input":{"type":"active","active":false}}\n',
      '{"input":{"type":"active","active":true}}\n',
    ]);
    release();
    await running;
  });
});

/* ---------------------------------------------------------------- ForwardTransport */

const FAKE_SSH = `
const net = require('net');
const fs = require('fs');
const args = process.argv.slice(2);
const E = process.env;
if (E.FAKE_SPAWN_LOG) fs.appendFileSync(E.FAKE_SPAWN_LOG, 'spawn\\n');
if (E.FAKE_FAIL_ONCE && !fs.existsSync(E.FAKE_FAIL_ONCE)) {
  fs.writeFileSync(E.FAKE_FAIL_ONCE, '1');
  process.stderr.write(E.FAKE_FAIL_TEXT || 'REMOTE HOST IDENTIFICATION HAS CHANGED!\\n');
  process.exit(255);
}
if (E.FAKE_FAIL_TEXT && !E.FAKE_FAIL_ONCE) { process.stderr.write(E.FAKE_FAIL_TEXT + '\\n'); process.exit(255); }
const spec = args[args.indexOf('-L') + 1];
const local = spec.slice(0, spec.lastIndexOf(':/run/'));
const rec = (h, p) => { const j = Buffer.from(JSON.stringify(h)); const l = Buffer.alloc(4); l.writeUInt32BE(j.length); return Buffer.concat([l, j, p || Buffer.alloc(0)]); };
const STATUS = '{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60,"encoding":"binary","window":2,"lease":60' + (E.FAKE_INPUT ? ',"input":true,"inputLease":3' : '') + '}\\n';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
net.createServer((c) => {
  let buf = '';
  let first = true;
  c.on('error', () => {});
  c.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      fs.appendFileSync(E.FAKE_LOG, line + '\\n');
      if (!first) continue;
      first = false;
      let mode = E.FAKE_MODE || 'serve';
      if (mode === 'timeout-once' || mode === 'timeout-always') {
        // The agent closes a connection that sent no request in 5 s: that reply, then a close.
        const n = fs.existsSync(E.FAKE_LOG + '.t') ? 1 : 0;
        fs.writeFileSync(E.FAKE_LOG + '.t', '1');
        if (mode === 'timeout-always' || n === 0) { c.write('{"ok":false,"error":"request timeout"}\\n'); c.end(); continue; }
        mode = 'serve';
      }
      if (mode === 'close') c.destroy();
      else if (mode === 'fatal') c.write('{"ok":false,"error":"developer mode is off"}\\n');
      else if (mode === 'corrupt') c.write(STATUS), c.write(Buffer.from([0, 0, 0, 0]));
      else if (mode === 'adapt') {
        // An adaptive stream on a slow link: every image reports a 900 ms ack round trip.
        c.write(STATUS.replace('"window":2', '"window":2,"adapt":true'));
        for (let f = 1; f <= 12; f++) {
          c.write(rec({ frame: f, ts: f * 250, screen: [1032, 2272], size: [360, 793], format: 'jpeg', bytes: JPEG.length, q: 60, rtt: 900, ticks: f, skips: 0 }, JPEG));
        }
      }
      else if (mode === 'vp8') {
        // Agent 1.6.0 video: a key frame, then deltas whose encode time is over the frame interval.
        c.write('{"ok":true,"stream":"mirror","fps":30,"width":720,"quality":60,"encoding":"vp8","window":4,"bitrate":2000,"adapt":true,"lease":60}\\n');
        const KEY = Buffer.from([0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0xd0, 0x02, 0x40, 0x06]);
        const DELTA = Buffer.from([0x51, 0x02, 0x00]);
        for (let f = 1; f <= 12; f++) {
          const p = f === 1 ? KEY : DELTA;
          c.write(rec({ frame: f, ts: f * 33, screen: [720, 1600], size: [720, 1600], format: 'vp8', key: f === 1, pts: f * 33, bytes: p.length, ems: 40, cvms: 4, kbps: 2000, rtt: 20, rttFrame: f > 1 ? f - 1 : undefined, ticks: f, skips: 0 }, p));
        }
      }
      else if (mode === 'serve') {
        c.write(STATUS);
        c.write(rec({ frame: 1, ts: 10, screen: [720, 1600], size: [360, 800], format: 'jpeg', bytes: JPEG.length, cms: 20, ems: 5 }, JPEG));
        c.write(rec({ frame: 2, ts: 11, same: true }));
      }
    }
  });
}).listen(local);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

describe('ForwardTransport', () => {
  let work: string;
  let savedPath: string | undefined;
  let savedXdg: string | undefined;
  const savedTiming = { ...FORWARD_TIMING };
  const env: Record<string, string> = {};
  let warnings: { message: string; items: string[] }[];
  let transports: ForwardTransport[];
  let n = 0;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sfwd-mt-'));
    fs.writeFileSync(path.join(work, 'ssh'), `#!${process.execPath}\n${FAKE_SSH}`, { mode: 0o755 });
    savedPath = process.env.PATH;
    savedXdg = process.env.XDG_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    process.env.PATH = `${work}${path.delimiter}${savedPath ?? ''}`;
    for (const k of ['FAKE_LOG', 'FAKE_SPAWN_LOG', 'FAKE_MODE', 'FAKE_FAIL_ONCE', 'FAKE_FAIL_TEXT', 'FAKE_INPUT']) delete process.env[k];
    env.FAKE_LOG = path.join(work, 'log');
    fs.writeFileSync(env.FAKE_LOG, '');
    process.env.FAKE_LOG = env.FAKE_LOG;
    process.env.FAKE_SPAWN_LOG = path.join(work, 'spawns');
    fs.writeFileSync(process.env.FAKE_SPAWN_LOG, '');
    warnings = [];
    transports = [];
  });

  afterEach(async () => {
    for (const t of transports) await t.dispose();
    Object.assign(FORWARD_TIMING, savedTiming);
    process.env.PATH = savedPath;
    if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedXdg;
    for (const k of ['FAKE_LOG', 'FAKE_SPAWN_LOG', 'FAKE_MODE', 'FAKE_FAIL_ONCE', 'FAKE_FAIL_TEXT', 'FAKE_INPUT']) delete process.env[k];
    fs.rmSync(work, { recursive: true, force: true });
  });

  const spawns = (): number => fs.readFileSync(process.env.FAKE_SPAWN_LOG ?? '', 'utf8').split('\n').filter(Boolean).length;
  const received = (): string[] => fs.readFileSync(env.FAKE_LOG, 'utf8').split('\n').filter(Boolean);
  const sessionDirs = (): string[] => fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith(`mirror-${process.pid}-`));

  function setup(over: { kind?: SfdkDeviceInfo['kind']; sdkKeys?: string[]; preKey?: string } = {}) {
    const name = `Phone ${++n}`;
    const key = path.join(work, 'key');
    fs.writeFileSync(key, 'k', { mode: 0o600 });
    const endpoint: SfdkDeviceInfo = {
      index: 0, name, kind: over.kind ?? 'hardware-device', origin: 'user-defined',
      host: '192.168.1.5', port: 22, user: 'defaultuser', privateKey: key, flags: [], extra: [],
    };
    const calls: string[][] = [];
    const sdk = over.sdkKeys ?? [KEY_A];
    const services = {
      output: { log: () => undefined },
      prompts: {
        showWarningMessage: (message: string, ...items: string[]) => {
          warnings.push({ message, items });
          return Promise.resolve(undefined);
        },
      },
      runner: {
        run: (opts: { args: string[] }) => {
          calls.push(opts.args);
          const stdout = sdk.map((k) => `ssh-ed25519 ${k} root@x`).join('\n') + '\n';
          return Promise.resolve({ stdout, stderr: '', exitCode: 0 });
        },
      },
    } as unknown as Services;
    const remembered: string[] = [];
    const ctx = {
      globalState: {
        get: () => undefined,
        update: (_k: string, v: string) => {
          remembered.push(v);
          return Promise.resolve();
        },
      },
    } as unknown as vscode.ExtensionContext;
    const storageDir = path.join(work, 'storage');
    const t = new ForwardTransport({ services, device: name, getEndpoint: () => Promise.resolve(endpoint), storageDir, ctx });
    transports.push(t);
    t.setTarget(SOCK);
    return { t, calls, remembered, name, storageDir };
  }

  it('streams records, acks image records, sends keepalives, pins the host key once and reuses the forward', async () => {
    const { t, calls, remembered, name, storageDir } = setup();
    FORWARD_TIMING.idleMs = 300;
    const e = makeSink();
    const c = makeToken();
    const run = t.run(e.sink, c.token);
    await waitFor(() => e.names.includes('same'));
    assert.deepStrictEqual(e.names, ['status', 'frame', 'same']);
    assert.deepStrictEqual([...e.frames[0].payload], [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    assert.strictEqual(e.frames[0].cms, 20);
    t.keepalive(7);
    await waitFor(() => received().includes('{"ack":1}') && received().includes('{"keepalive":7}'));
    const req = JSON.parse(received()[0]) as Record<string, unknown>;
    assert.deepStrictEqual(req, { cmd: 'mirror', fps: 4, width: 360, quality: 60, encoding: 'binary', lease: 60, adapt: true });
    c.cancel();
    assert.deepStrictEqual(await run, { cancelled: true });

    // First contact: the keys were read through sfdk and pinned under the device's alias.
    assert.strictEqual(calls.length, 1);
    const pinned = await readPinnedKeys(path.join(storageDir, 'ssh', 'known_hosts'), `sailfish-Phone-${name.split(' ')[1]}`);
    assert.deepStrictEqual(pinned, [{ type: 'ssh-ed25519', key: KEY_A }]);
    assert.deepStrictEqual(remembered, [SOCK]);

    // Second run: same ssh process, no second host-key read.
    const e2 = makeSink();
    const c2 = makeToken();
    const run2 = t.run(e2.sink, c2.token);
    await waitFor(() => e2.names.includes('same'));
    c2.cancel();
    await run2;
    assert.strictEqual(spawns(), 1);
    assert.strictEqual(calls.length, 1);

    // Idle: the ssh process and its directory go away.
    await waitFor(() => sessionDirs().length === 0);
  });

  it('sends focus and gestures only after an opted-in stream accepts input', async () => {
    process.env.FAKE_INPUT = '1';
    const { t } = setup();
    t.setInput(true);
    const e = makeSink();
    const c = makeToken();
    const run = t.run(e.sink, c.token);
    await waitFor(() => e.names.includes('same'));
    assert.strictEqual(t.input({ type: 'tap', x: 100, y: 200 }), true);
    t.inputActive(true);
    assert.strictEqual(t.input({ type: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, duration: 50 }), true);
    t.inputActive(false);
    await waitFor(() => received().some((line) => line.includes('"type":"swipe"')));
    assert.ok(received()[0].includes('"input":true'), received()[0]);
    assert.deepStrictEqual(received().slice(-4).map((line): unknown => JSON.parse(line) as unknown), [
      { input: { type: 'tap', x: 100, y: 200 } },
      { input: { type: 'active', active: true } },
      { input: { type: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, duration: 50 } },
      { input: { type: 'active', active: false } },
    ]);
    c.cancel();
    await run;
  });

  it('never sends input when the status does not explicitly accept it', async () => {
    const { t } = setup();
    t.setInput(true);
    const e = makeSink();
    const c = makeToken();
    const run = t.run(e.sink, c.token);
    await waitFor(() => e.names.includes('same'));
    assert.strictEqual(t.input({ type: 'tap', x: 1, y: 2 }), false);
    t.inputActive(true);
    assert.ok(!received().slice(1).some((line) => line.includes('"input"')));
    c.cancel();
    await run;
  });

  it('adaptive stream: a slow link makes the transport send a set line and report the decision', async () => {
    const { t } = setup();
    process.env.FAKE_MODE = 'adapt';
    ADAPT_TUNING.downHoldMs = 0; // the fake writes all frames at once
    try {
      const e = makeSink();
      const decisions: AdaptDecision[] = [];
      e.sink.adapted = (d) => decisions.push(d);
      const c = makeToken();
      const run = t.run(e.sink, c.token);
      await waitFor(() => received().includes('{"set":{"width":360,"quality":45}}'));
      assert.deepStrictEqual(decisions.map((d) => [d.direction, d.level, d.width, d.quality]), [['down', 1, 360, 45]]);
      // Acks still go out for every image, before the set line of the frame that decided.
      assert.ok(received().indexOf('{"ack":3}') < received().indexOf('{"set":{"width":360,"quality":45}}'));
      assert.strictEqual(received().filter((l) => l.startsWith('{"set"')).length, 1);
      c.cancel();
      await run;
    } finally {
      ADAPT_TUNING.downHoldMs = savedAdapt.downHoldMs;
    }
  });

  it('vp8: asks for video when told to, delivers key and delta frames, sends key frame requests and bitrate set lines', async () => {
    const { t } = setup();
    process.env.FAKE_MODE = 'vp8';
    ADAPT_TUNING.downHoldMs = 0; // the fake writes all frames at once
    ADAPT_TUNING.cpuDownHoldMs = 0;
    try {
      t.setVideo(true);
      const e = makeSink();
      const decisions: AdaptDecision[] = [];
      e.sink.adapted = (d) => decisions.push(d);
      const c = makeToken();
      const run = t.run(e.sink, c.token);
      await waitFor(() => e.frames.length === 12);
      assert.deepStrictEqual(JSON.parse(received()[0]) as unknown, {
        cmd: 'mirror', fps: 30, width: 720, quality: 60, encoding: 'vp8', bitrate: 2000, lease: 60, adapt: true,
      });
      assert.deepStrictEqual(e.frames.map((f) => [f.format, f.key, f.pts]).slice(0, 2), [['vp8', true, 33], ['vp8', false, 66]]);
      t.requestKeyframe();
      await waitFor(() => received().includes('{"keyframe":true}') && received().includes('{"ack":12}'));
      // Encoding at 40 ms per frame cannot hold 30 fps: one step to a smaller width for the phone
      // CPU; the bitrate stays, the link has room.
      assert.deepStrictEqual(decisions.map((d) => [d.direction, d.width, d.quality, d.cause]), [['down', 540, 2000, 'cpu']]);
      assert.ok(received().includes('{"set":{"width":540,"bitrate":2000}}'));
      c.cancel();
      await run;
    } finally {
      ADAPT_TUNING.downHoldMs = savedAdapt.downHoldMs;
      ADAPT_TUNING.cpuDownHoldMs = savedAdapt.cpuDownHoldMs;
    }
  });

  it('a JPEG stream ignores key frame requests (nothing is written)', async () => {
    const { t } = setup();
    t.setVideo(false);
    const e = makeSink();
    const c = makeToken();
    const run = t.run(e.sink, c.token);
    await waitFor(() => e.names.includes('same') && received().includes('{"ack":1}'));
    t.requestKeyframe();
    t.keepalive(1);
    await waitFor(() => received().includes('{"keepalive":1}'));
    assert.ok(!received().some((l) => l.includes('keyframe')));
    assert.strictEqual((JSON.parse(received()[0]) as { encoding: string }).encoding, 'binary');
    c.cancel();
    await run;
  });

  it('a non-adaptive stream (older agent) never gets a set line', async () => {
    const { t } = setup();
    const e = makeSink();
    const c = makeToken();
    const run = t.run(e.sink, c.token);
    await waitFor(() => e.names.includes('same') && received().includes('{"ack":1}'));
    c.cancel();
    await run;
    assert.ok(!received().some((l) => l.includes('"set"')));
  });

  it('a fatal first line is delivered as fatal, not as a setup failure', async () => {
    process.env.FAKE_MODE = 'fatal';
    const { t } = setup();
    const e = makeSink();
    const end = await t.run(e.sink, makeToken().token);
    assert.deepStrictEqual(e.fatals, ['developer mode is off']);
    assert.deepStrictEqual(end, { cancelled: false, reason: 'developer mode is off' });
  });

  it('a request timeout before the status line retries once on a fresh connection', async () => {
    process.env.FAKE_MODE = 'timeout-once';
    const { t } = setup();
    const e = makeSink();
    const c = makeToken();
    const run = t.run(e.sink, c.token);
    await waitFor(() => e.names.includes('same'));
    assert.deepStrictEqual(e.fatals, []);
    c.cancel();
    assert.deepStrictEqual(await run, { cancelled: true });
  });

  it('a repeated request timeout is a setup failure (fallback), never a fatal stream error', async () => {
    process.env.FAKE_MODE = 'timeout-always';
    const { t } = setup();
    const e = makeSink();
    const end: MirrorEnd = await t.run(e.sink, makeToken().token);
    assert.deepStrictEqual(e.fatals, []);
    assert.ok('setupFailed' in end || 'cancelled' in end, JSON.stringify(end));
  });

  it('a broken record after the status line is a fatal corrupt stream, not a setup failure', async () => {
    process.env.FAKE_MODE = 'corrupt';
    const { t } = setup();
    const e = makeSink();
    const end = await t.run(e.sink, makeToken().token);
    assert.deepStrictEqual(e.names, ['status', 'fatal']);
    assert.deepStrictEqual(end, { cancelled: false, reason: 'corrupt stream' });
  });

  it('closing before the first byte is remote-refused', async () => {
    process.env.FAKE_MODE = 'close';
    const { t } = setup();
    const end: MirrorEnd = await t.run(makeSink().sink, makeToken().token);
    assert.ok('setupFailed' in end && end.setupFailed === 'remote-refused', JSON.stringify(end));
  });

  it('an ssh authentication failure is a setup failure of class auth', async () => {
    process.env.FAKE_FAIL_TEXT = 'defaultuser@192.168.1.5: Permission denied (publickey).';
    const { t } = setup();
    const end: MirrorEnd = await t.run(makeSink().sink, makeToken().token);
    assert.ok('setupFailed' in end && end.setupFailed === 'auth', JSON.stringify(end));
    assert.deepStrictEqual(sessionDirs(), []);
  });

  it('no usable host key through sfdk is a setup failure (no-host-key) and ssh is never spawned', async () => {
    const { t } = setup({ sdkKeys: [] });
    const end: MirrorEnd = await t.run(makeSink().sink, makeToken().token);
    assert.ok('setupFailed' in end && end.setupFailed === 'no-host-key', JSON.stringify(end));
    assert.strictEqual(spawns(), 0);
  });

  it('host key mismatch on the direct path: one warning without an action, fallback', async () => {
    process.env.FAKE_FAIL_TEXT = 'REMOTE HOST IDENTIFICATION HAS CHANGED!';
    const { t, name, storageDir } = setup({ sdkKeys: [KEY_A] });
    const kh = await ensureKnownHostsFile(storageDir);
    fs.writeFileSync(kh, `sailfish-Phone-${name.split(' ')[1]} ssh-ed25519 ${KEY_A}\n`);
    const end: MirrorEnd = await t.run(makeSink().sink, makeToken().token);
    assert.ok('setupFailed' in end && end.setupFailed === 'host-key-changed', JSON.stringify(end));
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0].message, /does not match/);
    assert.deepStrictEqual(warnings[0].items, []);
    assert.strictEqual(fs.readFileSync(kh, 'utf8'), `sailfish-Phone-${name.split(' ')[1]} ssh-ed25519 ${KEY_A}\n`);
  });

  it('a changed key on a phone offers Trust New Key and falls back', async () => {
    process.env.FAKE_FAIL_TEXT = 'Host key verification failed.';
    const { t, name, storageDir } = setup({ sdkKeys: [KEY_B] });
    const kh = await ensureKnownHostsFile(storageDir);
    fs.writeFileSync(kh, `sailfish-Phone-${name.split(' ')[1]} ssh-ed25519 ${KEY_A}\n`);
    const end: MirrorEnd = await t.run(makeSink().sink, makeToken().token);
    assert.ok('setupFailed' in end && end.setupFailed === 'host-key-changed', JSON.stringify(end));
    assert.deepStrictEqual(warnings.map((w) => w.items), [['Trust New Key']]);
  });

  it('a missing pin (not-pinned) is pinned through sfdk and the forward retried once', async () => {
    process.env.FAKE_FAIL_ONCE = path.join(work, 'failed-once');
    process.env.FAKE_FAIL_TEXT = 'No ED25519 host key is known for sailfish-emu and you have requested strict checking.\\r\\nHost key verification failed.';
    const { t, name, storageDir } = setup({ sdkKeys: [KEY_A] });
    const kh = await ensureKnownHostsFile(storageDir);
    const alias = `sailfish-Phone-${name.split(' ')[1]}`;
    // the pin exists when the first attempt starts, so only ssh's own report triggers the repair
    fs.writeFileSync(kh, `${alias} ssh-ed25519 ${KEY_B}\n`);
    const e = makeSink();
    const c = makeToken();
    const run = t.run(e.sink, c.token);
    await waitFor(() => e.names.includes('same'));
    c.cancel();
    await run;
    assert.strictEqual(spawns(), 2);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(await readPinnedKeys(kh, alias), [{ type: 'ssh-ed25519', key: KEY_A }]);
  });

  it('not-pinned with no key through sfdk falls back as no-host-key after one attempt', async () => {
    process.env.FAKE_FAIL_TEXT = 'No ED25519 host key is known for sailfish-emu and you have requested strict checking.';
    const { t, name, storageDir } = setup({ sdkKeys: [] });
    const kh = await ensureKnownHostsFile(storageDir);
    fs.writeFileSync(kh, `sailfish-Phone-${name.split(' ')[1]} ssh-ed25519 ${KEY_A}\n`);
    const end: MirrorEnd = await t.run(makeSink().sink, makeToken().token);
    assert.ok('setupFailed' in end && end.setupFailed === 'no-host-key', JSON.stringify(end));
    assert.strictEqual(spawns(), 1);
  });

  it('a changed key on an emulator is re-pinned and the forward retried once', async () => {
    process.env.FAKE_FAIL_ONCE = path.join(work, 'failed-once');
    const { t, name, storageDir } = setup({ kind: 'emulator', sdkKeys: [KEY_B] });
    const kh = await ensureKnownHostsFile(storageDir);
    fs.writeFileSync(kh, `sailfish-Phone-${name.split(' ')[1]} ssh-ed25519 ${KEY_A}\n`);
    const e = makeSink();
    const c = makeToken();
    const run = t.run(e.sink, c.token);
    await waitFor(() => e.names.includes('same'));
    c.cancel();
    await run;
    assert.strictEqual(spawns(), 2);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(await readPinnedKeys(kh, `sailfish-Phone-${name.split(' ')[1]}`), [{ type: 'ssh-ed25519', key: KEY_B }]);
  });
});
