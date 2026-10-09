import * as assert from 'assert';
import {
  DEFAULT_ROOT_SHELL_LIMITS,
  DEVICE_TOOL_PACKAGES,
  RootShellWatch,
  classifyToolCheck,
  installPlan,
  isSessionDrop,
  offlineMessage,
  rootShellAbortMessage,
  rootShellProgressMessage,
  type ToolCheckRun,
} from '../../../src/devices/devicePackagesCore';

const ALL_OK = 'sfdev-tool:rsync:ok\nsfdev-tool:sdk-deploy-rpm:ok\nsfdev-tool:gdbserver:ok\n';
const GDB_MISSING = 'sfdev-tool:rsync:ok\nsfdev-tool:sdk-deploy-rpm:ok\nsfdev-tool:gdbserver:missing\n';

function run(over: Partial<ToolCheckRun>): ToolCheckRun {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, ...over };
}

describe('tool check classification', () => {
  it('reports what the check found when it ran', () => {
    assert.deepStrictEqual(classifyToolCheck(run({ stdout: ALL_OK })), { kind: 'checked', missing: [] });
    assert.deepStrictEqual(classifyToolCheck(run({ stdout: GDB_MISSING })), { kind: 'checked', missing: ['gdb-gdbserver'] });
  });

  it('treats ssh exit 255, connection errors and a timeout as unreachable, never as "missing"', () => {
    assert.strictEqual(classifyToolCheck(run({ exitCode: 255, stderr: '' })).kind, 'unreachable');
    assert.strictEqual(
      classifyToolCheck(run({ exitCode: 1, stderr: 'ssh: connect to host 192.168.1.40 port 22: No route to host' })).kind,
      'unreachable',
    );
    assert.strictEqual(classifyToolCheck(run({ exitCode: 1, stderr: 'Connection refused' })).kind, 'unreachable');
    assert.strictEqual(classifyToolCheck(run({ exitCode: -1, timedOut: true })).kind, 'unreachable');
  });

  it('tells a refused login apart from an offline device', () => {
    const outcome = classifyToolCheck(run({ exitCode: 255, stderr: 'defaultuser@192.168.2.15: Permission denied (publickey).' }));
    assert.strictEqual(outcome.kind, 'failed');
  });

  it('reports a cancel as cancelled, and a clean exit with unknown output as unparseable', () => {
    assert.deepStrictEqual(classifyToolCheck(run({ exitCode: -1, cancelled: true })), { kind: 'cancelled' });
    assert.deepStrictEqual(classifyToolCheck(run({ stdout: 'something else' })), { kind: 'unparseable' });
  });

  it('other sfdk errors are failures, not unreachable', () => {
    assert.strictEqual(classifyToolCheck(run({ exitCode: 1, stdout: 'Fatal: "X" is not a known device' })).kind, 'failed');
  });
});

describe('install plan after the tool check', () => {
  it('installs only what is missing, nothing when all are present', () => {
    assert.deepStrictEqual(installPlan({ kind: 'checked', missing: ['rsync'] }), { action: 'install', packages: ['rsync'] });
    assert.deepStrictEqual(installPlan({ kind: 'checked', missing: [] }), { action: 'none' });
  });

  it('installs everything only for unparseable output of a check that ran', () => {
    assert.deepStrictEqual(installPlan({ kind: 'unparseable' }), { action: 'install', packages: DEVICE_TOOL_PACKAGES });
  });

  it('never installs when the check could not run', () => {
    assert.deepStrictEqual(installPlan({ kind: 'unreachable', detail: 'exit 255' }), { action: 'stop' });
    assert.deepStrictEqual(installPlan({ kind: 'cancelled' }), { action: 'stop' });
    assert.deepStrictEqual(installPlan({ kind: 'failed', detail: 'Permission denied' }), { action: 'stop', message: 'Permission denied' });
  });
});

describe('offline message', () => {
  it('names the device and what to do', () => {
    assert.strictEqual(
      offlineMessage('Flip WLAN'),
      'Sardina: "Flip WLAN" is offline — connect it (USB or Wi-Fi, Developer Mode on) and try again.',
    );
    assert.match(offlineMessage('Sailfish OS Emulator 5.1.0.11', true), /emulator .* is not running/);
  });
});

describe('root shell watch', () => {
  const limits = { promptMs: 30_000, stallMs: 180_000, overallMs: 600_000 };

  it('stops when the device never prompts for the password', () => {
    const w = new RootShellWatch(limits, 0);
    assert.strictEqual(w.check(29_000), undefined);
    assert.strictEqual(w.phase, 'connecting');
    assert.strictEqual(w.check(30_000), 'no-prompt');
  });

  it('sends the password once and moves to running on the next output', () => {
    const w = new RootShellWatch(limits, 0);
    assert.strictEqual(w.onOutput('Password:', 1000), 'send-password');
    assert.strictEqual(w.phase, 'password');
    assert.strictEqual(w.onOutput('Refreshing cache', 2000), undefined);
    assert.strictEqual(w.phase, 'running');
    assert.strictEqual(w.check(60_000), undefined);
  });

  it('stops on a second password prompt (refused password)', () => {
    const w = new RootShellWatch(limits, 0);
    w.onOutput('Password:', 1000);
    assert.strictEqual(w.onOutput('Password:', 4000), undefined);
    assert.strictEqual(w.aborted, 'password-rejected');
  });

  it('stops after a long silence and at the overall limit', () => {
    const stalled = new RootShellWatch(limits, 0);
    stalled.onOutput('Password:', 1000);
    assert.strictEqual(stalled.check(1000 + 180_000), 'stalled');
    const slow = new RootShellWatch(limits, 0);
    slow.onOutput('Password:', 1000);
    for (let t = 2000; t < 600_000; t += 60_000) slow.onOutput('Downloading 10%', t);
    assert.strictEqual(slow.check(599_000), undefined);
    assert.strictEqual(slow.check(600_000), 'timeout');
  });

  it('stops when the local ssh reports a dropped session, not on remote network errors', () => {
    const w = new RootShellWatch(limits, 0);
    w.onOutput('Password:', 1000);
    w.onOutput('Fatal error: Connection reset by peer', 2000);
    assert.strictEqual(w.aborted, undefined);
    w.onOutput('client_loop: send disconnect: Broken pipe', 3000);
    assert.strictEqual(w.aborted, 'dropped');
  });

  it('recognises only local session drops', () => {
    assert.ok(isSessionDrop('Connection to 192.168.2.15 closed by remote host.'));
    assert.ok(isSessionDrop('Timeout, server 192.168.2.15 not responding.'));
    assert.ok(!isSessionDrop('Connection to 192.168.2.15 closed.'));
    assert.ok(!isSessionDrop('Error: Connection reset by peer'));
  });
});

describe('root shell messages', () => {
  it('says what it waits for, phase by phase', () => {
    assert.strictEqual(rootShellProgressMessage('Flip WLAN', 'connecting', 'installing rsync…'), 'connecting to "Flip WLAN"…');
    assert.strictEqual(rootShellProgressMessage('Flip WLAN', 'password', 'installing rsync…'), 'checking the developer-mode password…');
    assert.strictEqual(rootShellProgressMessage('Flip WLAN', 'running', 'installing rsync…'), 'installing rsync…');
    assert.strictEqual(
      rootShellProgressMessage('Flip WLAN', 'running', 'installing rsync…', { step: 'refreshing', percent: 40 }),
      'refreshing repositories 40%',
    );
    assert.strictEqual(rootShellProgressMessage('Flip WLAN', 'running', 'x…', { step: 'downloading' }), 'downloading…');
  });

  it('explains each stop', () => {
    assert.match(rootShellAbortMessage('Flip WLAN', 'no-prompt', DEFAULT_ROOT_SHELL_LIMITS), /did not answer within 30 s/);
    assert.match(rootShellAbortMessage('Flip WLAN', 'timeout', DEFAULT_ROOT_SHELL_LIMITS), /within 10 min/);
    assert.match(rootShellAbortMessage('Flip WLAN', 'stalled', DEFAULT_ROOT_SHELL_LIMITS), /no output for 3 min/);
    assert.match(rootShellAbortMessage('Flip WLAN', 'dropped', DEFAULT_ROOT_SHELL_LIMITS), /connection to "Flip WLAN" dropped/);
    assert.match(rootShellAbortMessage('Flip WLAN', 'password-rejected', DEFAULT_ROOT_SHELL_LIMITS), /did not accept the password/);
  });
});
