import * as assert from 'assert';
import {
  DebugLifecycle,
  gdbserverExitsAfterSession,
  gdbserverPkillArgs,
  isRestartRequest,
  withConnectRetry,
  type LifecycleEffects,
} from '../../../src/debug/debugSessionCore';

interface Harness {
  lifecycle: DebugLifecycle;
  log: string[];
  timers: Array<{ ms: number; fn: () => void; cancelled: boolean }>;
  /** Settles the pending relaunch with `ok`. */
  finishRelaunch(ok: boolean | Error): Promise<void>;
}

function harness(): Harness {
  const log: string[] = [];
  const timers: Harness['timers'] = [];
  const pending: Array<(v: boolean | Error) => void> = [];
  const effects: LifecycleEffects = {
    relaunchGdbserver: () => {
      log.push('relaunch');
      return new Promise<boolean>((resolve, reject) => pending.push((v) => (v instanceof Error ? reject(v) : resolve(v))));
    },
    cleanup: (reason) => log.push(`cleanup:${reason}`),
    stopSession: () => log.push('stopSession'),
    setTimer: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => (t.cancelled = true);
    },
  };
  return {
    lifecycle: new DebugLifecycle(effects, 1000),
    log,
    timers,
    finishRelaunch: async (ok) => {
      const settle = pending.shift();
      assert.ok(settle, 'no relaunch pending');
      settle(ok);
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe('debug session restart (pure core)', () => {
  it('recognizes only disconnect/terminate requests with restart: true', () => {
    assert.strictEqual(isRestartRequest({ type: 'request', command: 'disconnect', arguments: { restart: true, terminateDebuggee: true } }), true);
    assert.strictEqual(isRestartRequest({ type: 'request', command: 'terminate', arguments: { restart: true } }), true);
    assert.strictEqual(isRestartRequest({ type: 'request', command: 'disconnect', arguments: { restart: false, terminateDebuggee: true } }), false);
    assert.strictEqual(isRestartRequest({ type: 'request', command: 'disconnect' }), false);
    assert.strictEqual(isRestartRequest({ type: 'request', command: 'restart', arguments: { restart: true } }), false);
    assert.strictEqual(isRestartRequest({ type: 'response', command: 'disconnect', arguments: { restart: true } }), false);
    assert.strictEqual(isRestartRequest(undefined), false);
    assert.strictEqual(isRestartRequest('disconnect'), false);
  });

  it('enables GDB connect retries right before the target command', () => {
    const cmds = ['set sysroot /x', 'target extended-remote tcp:192.168.2.16:10000', 'file /p/app'];
    assert.deepStrictEqual(withConnectRetry(cmds, 30), [
      'set sysroot /x',
      'set tcp auto-retry on',
      'set tcp connect-timeout 30',
      'target extended-remote tcp:192.168.2.16:10000',
      'file /p/app',
    ]);
    assert.deepStrictEqual(withConnectRetry(['file /p/app']), ['file /p/app']);
  });

  it('builds an anchored pkill for exactly the gdbserver command line', () => {
    const args = gdbserverPkillArgs(['gdbserver', '--multi', '--once', ':10000']);
    assert.deepStrictEqual(args.slice(0, 5), ['device', 'exec', '--', 'pkill', '-f']);
    const re = new RegExp(args[5]);
    assert.ok(re.test('gdbserver --multi --once :10000'));
    assert.ok(re.test('/usr/bin/gdbserver --multi --once :10000'));
    assert.ok(!re.test('gdbserver --multi --once :100001'));
    assert.ok(!re.test("bash -c pkill -f '^gdbserver --multi --once :10000$'"));
    assert.strictEqual(gdbserverPkillArgs(['gdbserver', '--x', 'a.b'])[5], '^([^ ]*/)?gdbserver --x a\\.b$');
  });

  it('knows whether gdbserver exits after its GDB disconnects', () => {
    assert.strictEqual(gdbserverExitsAfterSession(['gdbserver', '--multi', '--once', ':10000']), true);
    assert.strictEqual(gdbserverExitsAfterSession(['gdbserver', '--multi', ':10000']), false);
  });

  it('Stop: a plain session end cleans up at once', () => {
    const h = harness();
    h.lifecycle.sessionStarted(); // first launch's adapter
    h.lifecycle.sessionTerminated();
    assert.deepStrictEqual(h.log, ['cleanup:ended']);
    assert.strictEqual(h.lifecycle.state, 'ended');
    h.lifecycle.sessionTerminated();
    h.lifecycle.stop();
    assert.deepStrictEqual(h.log, ['cleanup:ended'], 'cleanup runs once');
  });

  it('Restart: relaunches gdbserver, adopts the new session, then Stop cleans up', async () => {
    const h = harness();
    h.lifecycle.noteRestartRequested();
    h.lifecycle.sessionTerminated();
    assert.strictEqual(h.lifecycle.state, 'restarting');
    assert.deepStrictEqual(h.log, ['relaunch']);
    h.lifecycle.sessionStarted(); // VS Code launched the same configuration again
    assert.strictEqual(h.lifecycle.state, 'running');
    assert.strictEqual(h.timers[0].cancelled, true);
    await h.finishRelaunch(true);
    assert.deepStrictEqual(h.log, ['relaunch']);

    // A second restart works the same way.
    h.lifecycle.noteRestartRequested();
    h.lifecycle.sessionTerminated();
    h.lifecycle.sessionStarted();
    await h.finishRelaunch(true);
    assert.deepStrictEqual(h.log, ['relaunch', 'relaunch']);

    // Then Stop (restart: false) ends it for good.
    h.lifecycle.sessionTerminated();
    assert.deepStrictEqual(h.log, ['relaunch', 'relaunch', 'cleanup:ended']);
  });

  it('a restart flag is consumed: the following plain end is final', async () => {
    const h = harness();
    h.lifecycle.noteRestartRequested();
    h.lifecycle.sessionTerminated();
    h.lifecycle.sessionStarted();
    await h.finishRelaunch(true);
    h.lifecycle.sessionTerminated();
    assert.deepStrictEqual(h.log, ['relaunch', 'cleanup:ended']);
  });

  it('cleans up when VS Code does not launch the restarted session in time', () => {
    const h = harness();
    h.lifecycle.noteRestartRequested();
    h.lifecycle.sessionTerminated();
    assert.strictEqual(h.timers[0].ms, 1000);
    h.timers[0].fn();
    assert.deepStrictEqual(h.log, ['relaunch', 'cleanup:restart-timeout']);
    h.lifecycle.sessionStarted();
    assert.strictEqual(h.lifecycle.state, 'ended');
  });

  it('cleans up when the restarted session fails to launch', () => {
    const h = harness();
    h.lifecycle.noteRestartRequested();
    h.lifecycle.sessionTerminated();
    h.lifecycle.sessionTerminated(); // VS Code ends a session whose relaunch failed
    assert.deepStrictEqual(h.log, ['relaunch', 'cleanup:ended']);
  });

  it('stops the restarted session when gdbserver cannot be started again', async () => {
    const h = harness();
    h.lifecycle.noteRestartRequested();
    h.lifecycle.sessionTerminated();
    h.lifecycle.sessionStarted();
    await h.finishRelaunch(false);
    assert.deepStrictEqual(h.log, ['relaunch', 'cleanup:relaunch-failed', 'stopSession']);
    h.lifecycle.sessionTerminated();
    assert.deepStrictEqual(h.log, ['relaunch', 'cleanup:relaunch-failed', 'stopSession']);
  });

  it('treats a throwing relaunch like a failed one', async () => {
    const h = harness();
    h.lifecycle.noteRestartRequested();
    h.lifecycle.sessionTerminated();
    await h.finishRelaunch(new Error('boom'));
    assert.deepStrictEqual(h.log, ['relaunch', 'cleanup:relaunch-failed']);
  });

  it('ignores a stale relaunch result after the run already ended', async () => {
    const h = harness();
    h.lifecycle.noteRestartRequested();
    h.lifecycle.sessionTerminated();
    h.lifecycle.stop(); // device switch while restarting
    await h.finishRelaunch(false);
    assert.deepStrictEqual(h.log, ['relaunch', 'cleanup:stopped']);
  });

  it('a device switch (stop) during a running session cleans up once', () => {
    const h = harness();
    h.lifecycle.stop();
    h.lifecycle.sessionTerminated();
    h.lifecycle.noteRestartRequested();
    assert.deepStrictEqual(h.log, ['cleanup:stopped']);
  });
});
