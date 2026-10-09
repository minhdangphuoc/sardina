import * as assert from 'assert';
import { DeviceSessions, listLabels, sessionDescription, stopNotice, switchNotice } from '../../../src/core/deviceSessions';

const ok = (): Promise<void> => Promise.resolve();
const done = (fn: () => unknown): Promise<void> => {
  fn();
  return Promise.resolve();
};

describe('DeviceSessions', () => {
  it('registers, lists per device and unregisters on dispose', () => {
    const r = new DeviceSessions();
    const a = r.register('A', 'logs', 'device logs', ok);
    r.register('B', 'app', 'gallery', ok);
    assert.deepStrictEqual(
      r.activeFor('A').map(({ kind, label }) => ({ kind, label })),
      [{ kind: 'logs', label: 'device logs' }],
    );
    assert.deepStrictEqual(r.devices().sort(), ['A', 'B']);
    a.dispose();
    assert.deepStrictEqual(r.activeFor('A'), []);
    assert.strictEqual(r.activeFor('B').length, 1);
  });

  it('stopAll stops only that device and empties it', async () => {
    const r = new DeviceSessions();
    const stops: string[] = [];
    r.register('A', 'debug', 'debugging', () => done(() => stops.push('debug')));
    r.register('A', 'app', 'gallery', () => done(() => stops.push('app')));
    r.register('B', 'logs', 'device logs', () => done(() => stops.push('logs')));
    const res = await r.stopAll('A');
    assert.deepStrictEqual(stops.sort(), ['app', 'debug']);
    assert.strictEqual(res.stopped.length, 2);
    assert.strictEqual(res.failed.length, 0);
    assert.deepStrictEqual(r.activeFor('A'), []);
    assert.strictEqual(r.activeFor('B').length, 1);
  });

  it('reports a failing or hanging stop and still stops the rest', async () => {
    const r = new DeviceSessions();
    let ran = false;
    r.register('A', 'logs', 'device logs', () => Promise.reject(new Error('boom')));
    r.register('A', 'mirror', 'screen mirror', () => new Promise<void>(() => undefined));
    r.register('A', 'app', 'gallery', () => done(() => (ran = true)));
    const res = await r.stopAll('A', 20);
    assert.ok(ran);
    assert.deepStrictEqual(res.stopped, [{ kind: 'app', label: 'gallery' }]);
    assert.deepStrictEqual(res.failed.map((f) => [f.label, f.reason]), [
      ['device logs', 'boom'],
      ['screen mirror', 'did not stop within 0s'],
    ]);
  });

  it('stopAll on an idle device is a no-op', async () => {
    assert.deepStrictEqual(await new DeviceSessions().stopAll('A'), { stopped: [], failed: [] });
  });
});

describe('switch notice', () => {
  it('lists distinct labels', () => {
    assert.strictEqual(listLabels([{ kind: 'app', label: 'x' }, { kind: 'app', label: 'x' }, { kind: 'logs', label: 'device logs' }]), 'x, device logs');
  });
  it('names what was stopped and the new device', () => {
    const msg = switchNotice('Old', 'New', {
      stopped: [{ kind: 'debug', label: 'debugging' }, { kind: 'app', label: 'cameragallery' }, { kind: 'logs', label: 'device logs' }],
      failed: [],
    });
    assert.strictEqual(msg, 'Sardina: Stopped on "Old": debugging, cameragallery, device logs. Now using "New".');
  });
  it('names failures and an empty selection', () => {
    const msg = switchNotice('Old', undefined, { stopped: [], failed: [{ kind: 'mirror', label: 'screen mirror', reason: 'did not stop within 10s' }] });
    assert.strictEqual(msg, 'Sardina: Could not stop cleanly on "Old": screen mirror (did not stop within 10s). No device selected.');
  });
});

describe('DeviceSessions change events and builders', () => {
  it('fires on register, dispose (once) and stopAll', async () => {
    const r = new DeviceSessions();
    let n = 0;
    const sub = r.onDidChange(() => n++);
    const a = r.register('A', 'debug', 'debugging', ok);
    assert.strictEqual(n, 1);
    a.dispose();
    a.dispose();
    assert.strictEqual(n, 2);
    r.register('A', 'logs', 'device logs', ok);
    await r.stopAll('A');
    await r.stopAll('A');
    assert.strictEqual(n, 4);
    sub.dispose();
    r.register('A', 'app', 'x', ok);
    assert.strictEqual(n, 4);
  });

  it('a throwing listener does not break registration', () => {
    const r = new DeviceSessions();
    r.onDidChange(() => {
      throw new Error('boom');
    });
    r.register('A', 'app', 'x', ok);
    assert.strictEqual(r.activeFor('A').length, 1);
  });

  it('builds the tree description and the stop notice', () => {
    assert.strictEqual(sessionDescription([{ kind: 'debug', label: 'debugging' }, { kind: 'logs', label: 'device logs' }, { kind: 'app', label: 'debugging' }]), 'debugging · device logs');
    assert.strictEqual(sessionDescription([]), '');
    assert.strictEqual(stopNotice('A', { stopped: [], failed: [] }), 'Sardina: Nothing is running on "A".');
    assert.strictEqual(
      stopNotice('A', { stopped: [{ kind: 'debug', label: 'debugging' }], failed: [] }),
      'Sardina: Stopped on "A": debugging.',
    );
  });
});

describe('DeviceSessions ids, stopOne and metadata', () => {
  it('gives every session a unique id that is not reused', () => {
    const r = new DeviceSessions();
    const a = r.register('A', 'app', 'x', ok);
    r.register('A', 'logs', 'device logs', ok);
    a.dispose();
    r.register('A', 'monitor', 'app monitor', ok);
    const ids = r.activeFor('A').map((i) => i.id);
    assert.strictEqual(new Set(ids).size, 2);
    assert.ok(ids.every((id) => id > 1));
    assert.ok(r.activeFor('A').every((i) => typeof i.startedAt === 'number'));
  });

  it('stopOne stops only that entry', async () => {
    const r = new DeviceSessions();
    const stops: string[] = [];
    r.register('A', 'app', 'gallery', () => done(() => stops.push('app')));
    r.register('A', 'logs', 'device logs', () => done(() => stops.push('logs')));
    r.register('B', 'logs', 'device logs', () => done(() => stops.push('b')));
    const logs = r.activeFor('A').find((i) => i.kind === 'logs');
    assert.ok(logs);
    const res = await r.stopOne('A', logs.id);
    assert.deepStrictEqual(stops, ['logs']);
    assert.deepStrictEqual(res, { stopped: [{ kind: 'logs', label: 'device logs' }], failed: [] });
    assert.deepStrictEqual(r.activeFor('A').map((i) => i.kind), ['app']);
    assert.strictEqual(r.activeFor('B').length, 1);
  });

  it('stopOne ignores an unknown id or another device', async () => {
    const r = new DeviceSessions();
    r.register('A', 'app', 'x', ok);
    const id = r.activeFor('A')[0].id;
    assert.deepStrictEqual(await r.stopOne('A', 9999), { stopped: [], failed: [] });
    assert.deepStrictEqual(await r.stopOne('B', id), { stopped: [], failed: [] });
    assert.strictEqual(r.activeFor('A').length, 1);
  });

  it('stopOne reports a hanging or failing stop and leaves the others', async () => {
    const r = new DeviceSessions();
    r.register('A', 'mirror', 'screen mirror', () => new Promise<void>(() => undefined));
    r.register('A', 'logs', 'device logs', () => Promise.reject(new Error('boom')));
    r.register('A', 'app', 'x', ok);
    const [mirror, logs] = r.activeFor('A');
    const h = await r.stopOne('A', mirror.id, 20);
    assert.deepStrictEqual(h.failed.map((f) => f.reason), ['did not stop within 0s']);
    const f = await r.stopOne('A', logs.id);
    assert.deepStrictEqual(f.failed.map((x) => x.reason), ['boom']);
    assert.deepStrictEqual(r.activeFor('A').map((i) => i.kind), ['app']);
  });

  it('keeps registration metadata and update merges it and fires once', () => {
    const r = new DeviceSessions();
    let n = 0;
    r.onDidChange(() => n++);
    const h = r.register('A', 'app', 'gallery', ok, { app: 'gallery', binary: '/usr/bin/gallery', mode: 'run' });
    assert.strictEqual(n, 1);
    h.update({ pid: 42 });
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(r.activeFor('A')[0].meta, { app: 'gallery', binary: '/usr/bin/gallery', mode: 'run', pid: 42 });
    h.update({ mode: 'debug' });
    assert.strictEqual(r.activeFor('A')[0].meta?.mode, 'debug');
    assert.strictEqual(r.activeFor('A')[0].meta?.pid, 42);
  });

  it('metadata is absent when never given, copies are returned, update after dispose is silent', () => {
    const r = new DeviceSessions();
    let n = 0;
    r.onDidChange(() => n++);
    const h = r.register('A', 'debug', 'debugging', ok);
    assert.strictEqual(r.activeFor('A')[0].meta, undefined);
    h.update({ pid: 1 });
    const copy = r.activeFor('A')[0];
    if (copy.meta) copy.meta.pid = 99;
    assert.strictEqual(r.activeFor('A')[0].meta?.pid, 1);
    h.dispose();
    const before = n;
    h.update({ pid: 2 });
    assert.strictEqual(n, before);
  });

  it('describes the monitor kind like any other', () => {
    const r = new DeviceSessions();
    r.register('A', 'logs', 'device logs', ok);
    r.register('A', 'monitor', 'app monitor', ok);
    assert.strictEqual(sessionDescription(r.activeFor('A')), 'device logs · app monitor');
    assert.strictEqual(
      switchNotice('A', 'B', { stopped: r.activeFor('A'), failed: [] }),
      'Sardina: Stopped on "A": device logs, app monitor. Now using "B".',
    );
  });
});
