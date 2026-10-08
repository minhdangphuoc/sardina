import * as assert from 'assert';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AGENT_DBUS_NAME,
  AGENT_SESSION_KINDS,
  CLEANUP_ARGS,
  CLEANUP_SCRIPT,
  RESTART_SESSION_CONFIRM,
  RESTART_SESSION_SCRIPT,
  UNINSTALL_SCRIPT,
  parseCleanupReport,
  uninstallSummary,
  type CleanupReport,
} from '../../../src/agent/uninstallCore';

const report = (r: Partial<CleanupReport> = {}): CleanupReport => ({ removed: [], closed: [], left: [], unchecked: [], complete: true, ...r });

describe('uninstallCore scripts', () => {
  it('UNINSTALL_SCRIPT is one fixed line: rpm -e only when installed, then root-owned leftovers', () => {
    assert.ok(!UNINSTALL_SCRIPT.includes('\n'));
    assert.ok(UNINSTALL_SCRIPT.startsWith('if rpm -q sailfish-devagent >/dev/null 2>&1; then rpm -e sailfish-devagent || exit $?; fi;'));
    assert.ok(UNINSTALL_SCRIPT.includes('rm -rf /var/lib/sailfish-devagent'));
    assert.ok(UNINSTALL_SCRIPT.includes('rm -f /tmp/sailfish-devagent.rpm;'), 'the copy of extensions before 0.1.9');
    assert.ok(
      UNINSTALL_SCRIPT.includes('[ -L /etc/systemd/system/multi-user.target.wants/sailfish-devagent.service ] && rm -f /etc/systemd/system/multi-user.target.wants/sailfish-devagent.service'),
      'only the enable link agents up to 1.10.0 made',
    );
    assert.ok(UNINSTALL_SCRIPT.includes('systemctl reset-failed sailfish-devagent.service'));
    assert.ok(UNINSTALL_SCRIPT.includes('pkill -u defaultuser -x jolla-settings'), 'closes only the Settings app');
    assert.ok(!/lipstick|user@/.test(UNINSTALL_SCRIPT), 'never restarts the session by itself');
    assert.ok(UNINSTALL_SCRIPT.endsWith('exit 0'));
    assert.ok(!UNINSTALL_SCRIPT.includes('$('), 'no command substitution');
    assert.ok(!UNINSTALL_SCRIPT.includes('`'));
    // Every rm names one of the agent's own fixed paths.
    for (const m of UNINSTALL_SCRIPT.matchAll(/rm -r?f ([^;]+)/g)) {
      for (const p of m[1].trim().split(/\s+/)) assert.ok(p.includes('sailfish-devagent'), p);
    }
  });

  it('CLEANUP_SCRIPT takes its paths as positional arguments and removes nothing outside them', () => {
    assert.deepStrictEqual(CLEANUP_ARGS, ['/tmp/sailfish-devagent.rpm', '/run/user']);
    assert.ok(!CLEANUP_SCRIPT.includes('/tmp/'), 'the legacy RPM copy is $1');
    // Every removal names an argument or a sailfish-devagent / sailfish-tools path.
    for (const m of CLEANUP_SCRIPT.matchAll(/(?:gone|rm -f|rmdir) ("[^"]+"|\S+)/g)) {
      assert.ok(/^"\$1"$|^"\$(p|f)"$|sailfish-devagent|sailfish-tools|^"\$s"$|^"\$d/.test(m[1]) || m[1].startsWith('"$h/') || m[1].startsWith('"$r/'), m[1]);
    }
    assert.ok(!CLEANUP_SCRIPT.includes('`'));
    assert.ok(!/devel-su|sudo|runuser/.test(CLEANUP_SCRIPT), 'runs with the login user only');
    assert.ok(CLEANUP_SCRIPT.includes(AGENT_DBUS_NAME));
    assert.ok(CLEANUP_SCRIPT.trimEnd().endsWith('echo "sfdev-clean:done"'));
  });

  it('the session restart is a separate fixed script behind a confirmation text', () => {
    assert.strictEqual(RESTART_SESSION_SCRIPT, 'systemctl restart user@$(id -u defaultuser).service');
    assert.strictEqual(RESTART_SESSION_CONFIRM, "Restart the phone's user session? Running apps will close.");
  });

  it('stops only the sessions that use the agent', () => {
    assert.deepStrictEqual([...AGENT_SESSION_KINDS], ['mirror', 'logs', 'monitor']);
  });
});

/** Runs CLEANUP_SCRIPT with sh, a fake HOME and runtime base, and stub rpm/pidof/dbus-send first on PATH. */
describe('CLEANUP_SCRIPT under sh', function () {
  this.timeout(20000);
  let dir: string;
  let home: string;
  let run: string;
  let rpmCopy: string;
  let calls: string;
  let server: net.Server | undefined;
  const uid = os.userInfo().uid;

  const NOTIFICATIONS = [
    'method return time=1 sender=:1.5 -> destination=:1.9 serial=4 reply_serial=2',
    '   array [',
    '      struct {',
    '         string "sailfish-devagent"',
    '         uint32 12',
    '         string "icon-m-developer-mode"',
    '         string "Developer agent is running"',
    '         string "VS Code can take screenshots"',
    '         array [',
    '         ]',
    '         array [',
    '            dict entry(',
    '               string "x-nemo-preview-body"',
    '               variant                   string ""',
    '            )',
    '         ]',
    '         int32 -1',
    '      }',
    '      struct {',
    '         string "messaging"',
    '         uint32 7',
    '         string "icon"',
    '         string "sailfish-devagent"',
    '         string "body"',
    '         array [',
    '         ]',
    '         array [',
    '         ]',
    '         int32 -1',
    '      }',
    '      struct {',
    '         string "sailfish-devagent"',
    '         uint32 15',
    '         string "icon-m-developer-mode"',
    '         string "Screen is being viewed from VS Code"',
    '         string "Developer agent mirror is active."',
    '         array [',
    '         ]',
    '         array [',
    '         ]',
    '         int32 0',
    '      }',
    '   ]',
  ].join('\n');

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfdev-clean-'));
    home = path.join(dir, 'home');
    run = path.join(dir, 'run');
    rpmCopy = path.join(dir, 'sailfish-devagent.rpm');
    calls = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    const stub = (name: string, body: string): void => {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    stub('rpm', 'exit 1');
    stub('pidof', 'exit 1');
    fs.writeFileSync(path.join(dir, 'notifications.txt'), `${NOTIFICATIONS}\n`);
    stub(
      'dbus-send',
      [
        `echo "$*" >> '${calls}'`,
        'case "$*" in',
        `  *GetNotifications*) cat '${path.join(dir, 'notifications.txt')}' ;;`,
        '  *NameHasOwner*) echo "method return"; echo "   boolean false" ;;',
        '  *uint32:15*) exit 1 ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    );
    process.env.SFDEV_TEST_PATH = `${bin}:${process.env.PATH ?? ''}`;
    fs.mkdirSync(path.join(run, String(uid), 'dbus'), { recursive: true });
    server = net.createServer();
    await new Promise<void>((resolve) => server?.listen(path.join(run, String(uid), 'dbus', 'user_bus_socket'), resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runScript(): string {
    return execFileSync('sh', ['-c', CLEANUP_SCRIPT, 'sh', rpmCopy, run], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: process.env.SFDEV_TEST_PATH },
    });
  }

  it('removes the user-level leftovers, closes only the agent notifications and reports a failed close', () => {
    fs.writeFileSync(rpmCopy, 'rpm');
    fs.mkdirSync(path.join(run, String(uid), 'sailfish-devagent'));
    fs.writeFileSync(path.join(run, String(uid), 'sailfish-devagent', 'shot-1.png'), 'x');
    fs.mkdirSync(path.join(home, 'sailfish-devagent'));
    fs.writeFileSync(path.join(home, 'sailfish-devagent', 'shot-2.png'), 'x');
    fs.mkdirSync(path.join(home, '.cache', 'sailfish-tools', 'profile'), { recursive: true });

    const r = parseCleanupReport(runScript());
    assert.ok(r.complete);
    assert.deepStrictEqual(r.removed.sort(), [
      rpmCopy,
      path.join(home, '.cache', 'sailfish-tools'),
      path.join(home, 'sailfish-devagent'),
      path.join(home, 'sailfish-devagent', 'shot-2.png'),
      path.join(run, String(uid), 'sailfish-devagent'),
    ].sort());
    assert.deepStrictEqual(r.closed, [12]);
    assert.deepStrictEqual(r.left, ['notification 15']);
    assert.deepStrictEqual(r.unchecked, []);
    for (const p of [rpmCopy, path.join(home, 'sailfish-devagent'), path.join(run, String(uid), 'sailfish-devagent')]) {
      assert.ok(!fs.existsSync(p), p);
    }
    const log = fs.readFileSync(calls, 'utf8');
    assert.ok(!log.includes('uint32:7'), 'another app\'s notification is left alone');
    assert.ok(log.includes(`--bus=unix:path=${run}/${uid}/dbus/user_bus_socket`), log);
  });

  it('keeps the person\'s own files in the staging folder and does not follow a symlinked one', () => {
    fs.mkdirSync(path.join(home, 'sailfish-devagent'));
    fs.writeFileSync(path.join(home, 'sailfish-devagent', 'shot-3.png'), 'x');
    fs.writeFileSync(path.join(home, 'sailfish-devagent', 'notes.txt'), 'mine');
    let r = parseCleanupReport(runScript());
    assert.ok(fs.existsSync(path.join(home, 'sailfish-devagent', 'notes.txt')));
    assert.ok(!fs.existsSync(path.join(home, 'sailfish-devagent', 'shot-3.png')));
    assert.deepStrictEqual(r.left.filter((l) => l.startsWith('/')), [path.join(home, 'sailfish-devagent')]);

    fs.rmSync(path.join(home, 'sailfish-devagent'), { recursive: true });
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'shot-4.png'), 'x');
    fs.symlinkSync(elsewhere, path.join(home, 'sailfish-devagent'));
    r = parseCleanupReport(runScript());
    assert.ok(fs.existsSync(path.join(elsewhere, 'shot-4.png')));
    assert.ok(!r.removed.some((p) => p.includes('shot-4')), JSON.stringify(r));
  });

  it('says what it could not check when there is no session bus, and nothing when all is clean', () => {
    fs.rmSync(path.join(run, String(uid), 'dbus'), { recursive: true, force: true });
    const r = parseCleanupReport(runScript());
    assert.ok(r.complete);
    assert.deepStrictEqual(r, report({ unchecked: ['notifications'] }));
  });
});

describe('parseCleanupReport', () => {
  it('reads marked lines only, ignores noise and bad ids, and needs the done line', () => {
    const r = parseCleanupReport(
      [
        'Last login: today',
        'sfdev-clean:removed:/tmp/sailfish-devagent.rpm',
        'sfdev-clean:closed:12',
        'sfdev-clean:closed:12x',
        'sfdev-clean:left:/var/lib/sailfish-devagent\r',
        'sfdev-clean:left:/var/lib/sailfish-devagent',
        'sfdev-clean:unchecked:notifications',
        'sfdev-clean:bogus:x',
      ].join('\n'),
    );
    assert.deepStrictEqual(r, {
      removed: ['/tmp/sailfish-devagent.rpm'],
      closed: [12],
      left: ['/var/lib/sailfish-devagent'],
      unchecked: ['notifications'],
      complete: false,
    });
    assert.strictEqual(parseCleanupReport('sfdev-clean:done\n').complete, true);
  });
});

describe('uninstallSummary', () => {
  it('clean: one information line', () => {
    const s = uninstallSummary('Jolla', report());
    assert.strictEqual(s.level, 'information');
    assert.strictEqual(s.message, 'Sailfish: the device agent was removed from "Jolla". Nothing of the agent is left.');
  });
  it('counts what it removed and closed', () => {
    const s = uninstallSummary('Jolla', report({ removed: ['/a', '/b'], closed: [3] }));
    assert.strictEqual(s.message, 'Sailfish: the device agent was removed from "Jolla". Also removed 2 leftover items and 1 notification. Nothing of the agent is left.');
  });
  it('warns about leftovers, unchecked parts and an unfinished check', () => {
    let s = uninstallSummary('Jolla', report({ left: ['/var/lib/sailfish-devagent', '/a', '/b', '/c'] }));
    assert.strictEqual(s.level, 'warning');
    assert.ok(s.message.includes('Still on the device: /var/lib/sailfish-devagent, /a, /b and 1 more'), s.message);
    s = uninstallSummary('Jolla', report({ unchecked: ['notifications'] }));
    assert.strictEqual(s.level, 'information');
    assert.ok(s.message.endsWith('Could not check: notifications.'), s.message);
    s = uninstallSummary('Jolla', report({ complete: false }));
    assert.strictEqual(s.level, 'warning');
    assert.ok(s.message.includes('could not be verified'), s.message);
  });
});
