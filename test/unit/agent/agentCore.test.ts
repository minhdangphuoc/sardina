import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AGENT_BINARY,
  AGENT_PACKAGE,
  AGENT_RPM_NAME,
  LEGACY_REMOTE_RPM,
  REMOVE_COPY_SCRIPT,
  COPY_SCRIPT,
  INSTALL_SCRIPT,
  archFromOutput,
  archFromRpmQuery,
  classifyPing,
  clientName,
  describeAgentRefusal,
  describePhoneSettings,
  parsePhoneSettings,
  phoneRefusal,
  decodeBase64Output,
  describeProbe,
  installConsentDetail,
  isPng,
  isScreenshotPath,
  parseAgentReply,
  pickAgentRpm,
  sanitizeDeviceName,
  screenshotFileName,
} from '../../../src/agent/agentCore';

describe('agentCore.archFromRpmQuery', () => {
  it('maps the rpm package suffix', () => {
    assert.strictEqual(archFromRpmQuery('rpm-4.16.1.3-1.6.1.jolla.aarch64'), 'aarch64');
    assert.strictEqual(archFromRpmQuery('rpm-4.16.1.3-1.6.1.jolla.armv7hl\n'), 'armv7hl');
    assert.strictEqual(archFromRpmQuery('rpm-4.16.1.3-1.6.1.jolla.i486'), 'i486');
  });
  it('uses the last line of multi-line output', () => {
    assert.strictEqual(archFromRpmQuery('warning: something\r\nrpm-4.16.1.3-1.6.1.jolla.armv7hl\r\n'), 'armv7hl');
  });
  it('garbage gives undefined', () => {
    assert.strictEqual(archFromRpmQuery('garbage'), undefined);
    assert.strictEqual(archFromRpmQuery(''), undefined);
    assert.strictEqual(archFromRpmQuery('package rpm is not installed'), undefined);
  });
});

describe('agentCore.archFromOutput (D6)', () => {
  it('maps uname machine names', () => {
    assert.strictEqual(archFromOutput('aarch64'), 'aarch64');
    assert.strictEqual(archFromOutput('armv7l'), 'armv7hl');
    assert.strictEqual(archFromOutput('armv7hl'), 'armv7hl');
    assert.strictEqual(archFromOutput('i486'), 'i486');
    assert.strictEqual(archFromOutput('i586'), 'i486');
    assert.strictEqual(archFromOutput('i686\n'), 'i486');
  });
  it('rejects unsupported architectures', () => {
    assert.strictEqual(archFromOutput('x86_64'), undefined);
    assert.strictEqual(archFromOutput('arm64'), undefined);
    assert.strictEqual(archFromOutput('hello'), undefined);
  });
  it('finds the arch in a full uname line', () => {
    assert.strictEqual(archFromOutput('Linux Xperia10 4.14.150 #1 SMP aarch64 GNU/Linux'), 'aarch64');
  });
});

describe('agentCore.pickAgentRpm', () => {
  const files = [
    'sailfish-devagent-1.0.0-1.i486.rpm',
    'sailfish-devagent-1.0.1-1.i486.rpm',
    'sailfish-devagent-1.0.5-1.aarch64.rpm',
    'sailfish-devagent-1.0.0-1.armv7hl.rpm',
    'other-9.9.9-1.i486.rpm',
    'README.md',
  ];
  it('picks the newest (last sorted) matching name', () => {
    assert.strictEqual(pickAgentRpm('i486', files), 'sailfish-devagent-1.0.1-1.i486.rpm');
  });
  it('ignores other arches and packages', () => {
    assert.strictEqual(pickAgentRpm('aarch64', files), 'sailfish-devagent-1.0.5-1.aarch64.rpm');
    assert.strictEqual(pickAgentRpm('armv7hl', files), 'sailfish-devagent-1.0.0-1.armv7hl.rpm');
  });
  it('undefined when nothing matches', () => {
    assert.strictEqual(pickAgentRpm('aarch64', ['other-1.aarch64.rpm', 'sailfish-devagent-1.i486.rpm']), undefined);
    assert.strictEqual(pickAgentRpm('i486', []), undefined);
  });
});

describe('agentCore.parseAgentReply', () => {
  it('parses a valid reply', () => {
    assert.deepStrictEqual(parseAgentReply('{"ok":true,"version":"1.0.0","developerMode":true}'), {
      ok: true,
      version: '1.0.0',
      developerMode: true,
      path: undefined,
      error: undefined,
    });
  });
  it('parses path and error fields', () => {
    const r = parseAgentReply('{"ok":false,"error":"nope","path":"/x"}');
    assert.strictEqual(r?.ok, false);
    assert.strictEqual(r?.error, 'nope');
    assert.strictEqual(r?.path, '/x');
  });
  it('ignores leading and trailing noise lines', () => {
    const r = parseAgentReply('Welcome\r\n  {"ok":true,"version":"2"}  \r\nbye\n');
    assert.strictEqual(r?.ok, true);
    assert.strictEqual(r?.version, '2');
  });
  it('drops fields of the wrong type', () => {
    const r = parseAgentReply('{"ok":true,"version":3,"developerMode":"yes"}');
    assert.strictEqual(r?.version, undefined);
    assert.strictEqual(r?.developerMode, undefined);
  });
  it('invalid JSON, missing ok, or no JSON gives undefined', () => {
    assert.strictEqual(parseAgentReply('{not json'), undefined);
    assert.strictEqual(parseAgentReply('{"version":"1"}'), undefined);
    assert.strictEqual(parseAgentReply('{"ok":"true"}'), undefined);
    assert.strictEqual(parseAgentReply('plain text'), undefined);
    assert.strictEqual(parseAgentReply(''), undefined);
  });
});

describe('agentCore.classifyPing', () => {
  it('passes the 1.2.0 socket and mirrorEncodings through', () => {
    const stdout =
      '{"ok":true,"version":"1.2.0","developerMode":true,"socket":"/run/user/100000/sailfish-devagent/agent.sock","mirrorEncodings":["text","binary"]}\n';
    assert.deepStrictEqual(classifyPing({ exitCode: 0, stdout, stderr: '' }), {
      state: 'running',
      version: '1.2.0',
      developerMode: true,
      socket: '/run/user/100000/sailfish-devagent/agent.sock',
      mirrorEncodings: ['text', 'binary'],
    });
  });
  it('passes the 1.7.0 mirrorInput capability through', () => {
    const stdout =
      '{"ok":true,"version":"1.7.0","developerMode":true,"socket":"/run/user/100000/sailfish-devagent/agent.sock","mirrorEncodings":["text","binary","vp8"],"mirrorInput":["tap","swipe"]}\n';
    const p = classifyPing({ exitCode: 0, stdout, stderr: '' });
    assert.ok(p.state === 'running');
    assert.deepStrictEqual(p.mirrorInput, ['tap', 'swipe']);
  });
  it('a 1.1.0 ping has no socket or mirrorEncodings keys at all', () => {
    const p = classifyPing({ exitCode: 0, stdout: '{"ok":true,"version":"1.1.0","developerMode":true}', stderr: '' });
    assert.deepStrictEqual(p, { state: 'running', version: '1.1.0', developerMode: true });
    assert.ok(!('socket' in p) && !('mirrorEncodings' in p));
  });
  it('drops socket and mirrorEncodings of the wrong type', () => {
    const p = classifyPing({
      exitCode: 0,
      stdout: '{"ok":true,"version":"1.2.0","developerMode":true,"socket":7,"mirrorEncodings":["text",3]}',
      stderr: '',
    });
    assert.deepStrictEqual(p, { state: 'running', version: '1.2.0', developerMode: true });
  });
  it('drops mirrorInput unless every item is a string', () => {
    const p = classifyPing({ exitCode: 0, stdout: '{"ok":true,"version":"1.7.0","developerMode":true,"mirrorInput":["tap",3]}', stderr: '' });
    assert.deepStrictEqual(p, { state: 'running', version: '1.7.0', developerMode: true });
  });
  it('passes the 1.10.0 logFormats and stats capabilities through and drops wrong types', () => {
    const ok = classifyPing({ exitCode: 0, stdout: '{"ok":true,"version":"1.10.0","developerMode":true,"logFormats":["text","json"],"stats":true}', stderr: '' });
    assert.ok(ok.state === 'running');
    assert.deepStrictEqual(ok.logFormats, ['text', 'json']);
    assert.strictEqual(ok.stats, true);
    const bad = classifyPing({ exitCode: 0, stdout: '{"ok":true,"version":"1.10.0","developerMode":true,"logFormats":["text",1],"stats":"yes"}', stderr: '' });
    assert.deepStrictEqual(bad, { state: 'running', version: '1.10.0', developerMode: true });
  });
  it('keeps unknown fields out of the probe', () => {
    const p = classifyPing({ exitCode: 0, stdout: '{"ok":true,"version":"1.3.0","developerMode":false,"future":1}', stderr: '' });
    assert.deepStrictEqual(p, { state: 'running', version: '1.3.0', developerMode: false });
  });
  it('exit 0 with ok reply is running', () => {
    assert.deepStrictEqual(
      classifyPing({ exitCode: 0, stdout: '{"ok":true,"version":"1.0.0","developerMode":true}\n', stderr: '' }),
      { state: 'running', version: '1.0.0', developerMode: true },
    );
  });
  it('defaults missing version and developerMode', () => {
    assert.deepStrictEqual(classifyPing({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }), {
      state: 'running',
      version: '?',
      developerMode: false,
    });
  });
  it('developer mode off is still running', () => {
    const p = classifyPing({ exitCode: 0, stdout: '{"ok":true,"version":"1","developerMode":false}', stderr: '' });
    assert.deepStrictEqual(p, { state: 'running', version: '1', developerMode: false });
  });
  it('exit 3 is not-running', () => {
    assert.deepStrictEqual(classifyPing({ exitCode: 3, stdout: '', stderr: '' }), { state: 'not-running' });
  });
  it('"agent not running" error is not-running whatever the exit code', () => {
    assert.deepStrictEqual(
      classifyPing({ exitCode: 1, stdout: '{"ok":false,"error":"agent not running"}', stderr: '' }),
      { state: 'not-running' },
    );
  });
  it('exit 127 is not-installed', () => {
    assert.deepStrictEqual(classifyPing({ exitCode: 127, stdout: '', stderr: '' }), { state: 'not-installed' });
  });
  it('"not found" on stderr is not-installed', () => {
    assert.deepStrictEqual(
      classifyPing({ exitCode: 1, stdout: '', stderr: 'sh: sailfish-devagent: command not found' }),
      { state: 'not-installed' },
    );
    assert.deepStrictEqual(
      classifyPing({ exitCode: 1, stdout: '', stderr: 'bash: sailfish-devagent: No such file or directory' }),
      { state: 'not-installed' },
    );
  });
  it('anything else is unreachable with the first stderr line', () => {
    assert.deepStrictEqual(
      classifyPing({ exitCode: 255, stdout: '', stderr: 'ssh: connect to host: Connection refused\nmore' }),
      { state: 'unreachable', detail: 'ssh: connect to host: Connection refused' },
    );
  });
  it('unreachable falls back to stdout, then exit code', () => {
    assert.deepStrictEqual(classifyPing({ exitCode: 1, stdout: 'odd output', stderr: '' }), {
      state: 'unreachable',
      detail: 'odd output',
    });
    assert.deepStrictEqual(classifyPing({ exitCode: 2, stdout: '', stderr: '' }), {
      state: 'unreachable',
      detail: 'exit 2',
    });
  });
  it('exit 0 with ok:false is not running', () => {
    const p = classifyPing({ exitCode: 0, stdout: '{"ok":false,"error":"boom"}', stderr: '' });
    assert.strictEqual(p.state, 'unreachable');
  });
});

describe('agentCore.isScreenshotPath', () => {
  it('accepts the agent screenshot path', () => {
    assert.strictEqual(isScreenshotPath('/run/user/100000/sailfish-devagent/shot-1.png'), true);
    assert.strictEqual(isScreenshotPath('/run/user/0/sailfish-devagent/shot-1700000000123.png'), true);
  });
  it('rejects traversal, other dirs, extensions and trailing text', () => {
    const bad = [
      '/run/user/100000/sailfish-devagent/../../../etc/passwd',
      '/run/user/100000/sailfish-devagent/shot-1.png/../x.png',
      '/run/user/100000/sailfish-devagent/../shot-1.png',
      '/run/user/100000/other/shot-1.png',
      '/tmp/sailfish-devagent/shot-1.png',
      '/run/user/abc/sailfish-devagent/shot-1.png',
      '/run/user//sailfish-devagent/shot-1.png',
      '/run/user/100000/sailfish-devagent/shot-1.jpg',
      '/run/user/100000/sailfish-devagent/shot-.png',
      '/run/user/100000/sailfish-devagent/shot-1.png\n',
      '/run/user/100000/sailfish-devagent/shot-1.png ',
      '/run/user/100000/sailfish-devagent/shot-1.png; rm -rf /',
      '/run/user/100000/sailfish-devagent/shot-1.png$(id)',
      '/run/user/100000/sailfish-devagent/shot-`id`.png',
      '/run/user/100000/sailfish-devagent/shot-1;id.png',
      '/run/user/100000/sailfish-devagent/shot-1|cat.png',
      '/run/user/100000/sailfish-devagent/shot-1&.png',
      'x/run/user/100000/sailfish-devagent/shot-1.png',
      '',
    ];
    for (const p of bad) assert.strictEqual(isScreenshotPath(p), false, JSON.stringify(p));
  });
});

describe('agentCore.isPng / decodeBase64Output', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(61, 7)]);
  it('recognises the PNG signature', () => {
    assert.strictEqual(isPng(png), true);
    assert.strictEqual(isPng(Buffer.from('GIF89a......')), false);
    assert.strictEqual(isPng(png.subarray(0, 7)), false);
    assert.strictEqual(isPng(Buffer.alloc(0)), false);
  });
  it('decodes wrapped base64 output', () => {
    const b64 = png.toString('base64');
    const wrapped = (b64.match(/.{1,16}/g) ?? []).join('\r\n') + '\n';
    const out = decodeBase64Output(wrapped);
    assert.ok(out.equals(png));
    assert.strictEqual(isPng(out), true);
  });
  it('empty output decodes to an empty buffer', () => {
    assert.strictEqual(decodeBase64Output('\n').length, 0);
  });
});

describe('agentCore file naming', () => {
  it('sanitizeDeviceName', () => {
    assert.strictEqual(sanitizeDeviceName('Xperia 10 - Dual SIM (ARM)'), 'Xperia-10-Dual-SIM-ARM');
    assert.strictEqual(sanitizeDeviceName(''), 'device');
    assert.strictEqual(sanitizeDeviceName('  ...  '), 'device');
    assert.strictEqual(sanitizeDeviceName('../../etc/passwd'), 'etc-passwd');
    assert.strictEqual(sanitizeDeviceName('a/b\\c:d'), 'a-b-c-d');
  });
  it('sanitizeDeviceName strips non-ASCII and spaces', () => {
    const s = sanitizeDeviceName('Xperia 10 III – 日本語');
    assert.match(s, /^[A-Za-z0-9._-]+$/);
    assert.strictEqual(s, 'Xperia-10-III');
    assert.strictEqual(sanitizeDeviceName('日本語'), 'device');
  });
  it('screenshotFileName', () => {
    assert.strictEqual(
      screenshotFileName('Jolla Phone', new Date(2026, 9, 5, 13, 42, 7)),
      'Jolla-Phone-20261005-134207.png',
    );
    assert.strictEqual(screenshotFileName('X', new Date(2026, 0, 2, 3, 4, 5)), 'X-20260102-030405.png');
  });
});

describe('agentCore scripts and messages', () => {
  it('constants', () => {
    assert.strictEqual(AGENT_PACKAGE, 'sailfish-devagent');
    assert.strictEqual(AGENT_BINARY, 'sailfish-devagent');
    assert.strictEqual(AGENT_RPM_NAME, 'sailfish-devagent.rpm');
    assert.strictEqual(LEGACY_REMOTE_RPM, '/tmp/sailfish-devagent.rpm');
  });
  it('COPY_SCRIPT takes positional arguments only and writes only into ~/.cache/sailfish-tools', () => {
    assert.ok(COPY_SCRIPT.includes('base64 -d'));
    assert.ok(COPY_SCRIPT.includes('"$f"'));
    assert.ok(COPY_SCRIPT.includes('$n'));
    assert.ok(COPY_SCRIPT.includes('d=$HOME/.cache/sailfish-tools; f=$d/$1;'));
    assert.ok(COPY_SCRIPT.includes('chmod 700 "$d"'));
    assert.ok(!/\$\(\s*(?!wc -c)/.test(COPY_SCRIPT), 'only the fixed wc -c substitution');
    assert.ok(!COPY_SCRIPT.includes('`'));
    assert.ok(!COPY_SCRIPT.includes('/tmp'));
  });
  it('COPY_SCRIPT and REMOVE_COPY_SCRIPT under sh: private folder, refuse a path, remove the copy and the empty folder', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sfdev-copy-'));
    try {
      const env = { ...process.env, HOME: home };
      execFileSync('sh', ['-c', COPY_SCRIPT, 'sh', AGENT_RPM_NAME, '3'], { env, input: Buffer.from('abc').toString('base64') });
      const dir = path.join(home, '.cache', 'sailfish-tools');
      assert.strictEqual(fs.readFileSync(path.join(dir, AGENT_RPM_NAME), 'utf8'), 'abc');
      assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
      assert.throws(() => execFileSync('sh', ['-c', COPY_SCRIPT, 'sh', '../x', '3'], { env, input: 'YWJj', stdio: 'pipe' }));
      assert.ok(!fs.existsSync(path.join(home, '.cache', 'x')));
      execFileSync('sh', ['-c', REMOVE_COPY_SCRIPT, 'sh', AGENT_RPM_NAME], { env });
      assert.ok(!fs.existsSync(dir), 'the empty private folder goes too');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it('INSTALL_SCRIPT installs from the private folder of defaultuser and always removes the copy', () => {
    assert.ok(INSTALL_SCRIPT.startsWith('f=$(getent passwd defaultuser | cut -d: -f6)/.cache/sailfish-tools/sailfish-devagent.rpm;'));
    assert.ok(INSTALL_SCRIPT.includes('rpm -U --replacepkgs --oldpackage "$f" || r=$?; rm -f "$f";'));
    assert.ok(!INSTALL_SCRIPT.includes('/tmp'));
    assert.ok(!INSTALL_SCRIPT.includes('`'));
  });
  it('installConsentDetail names the device and package', () => {
    const t = installConsentDetail('My Phone');
    assert.ok(t.includes('"My Phone"'));
    assert.ok(t.includes('sailfish-devagent'));
    assert.ok(/Developer Mode/.test(t));
    assert.ok(t.includes('taps and swipes'));
    assert.ok(t.includes('loses focus'));
  });
  it('describeProbe covers every state', () => {
    assert.match(describeProbe('D', { state: 'running', version: '1.0.0', developerMode: true }), /1\.0\.0 is running.*Developer Mode is on/);
    assert.match(describeProbe('D', { state: 'running', version: '1.0.0', developerMode: false }), /Developer Mode is off/);
    assert.match(describeProbe('D', { state: 'not-running' }), /installed on "D" but not running/);
    assert.match(describeProbe('D', { state: 'not-installed' }), /not installed on "D"/);
    assert.match(describeProbe('D', { state: 'unreachable', detail: 'boom' }), /could not reach.*boom/);
  });
});

describe('agentCore phone settings (agent 1.9.0)', () => {
  const ALL_ON = '"screenView":true,"control":true,"logs":true,"indicator":"normal","muteNotifications":false,"touchIndicator":false';
  const ping = (extra: string): string => `{"ok":true,"version":"1.9.0","developerMode":true${extra}}`;

  it('parseAgentReply keeps a valid settings object and settingsPage', () => {
    const reply = parseAgentReply(ping(`,"settingsPage":true,"settings":{${ALL_ON}}`));
    assert.strictEqual(reply?.settingsPage, true);
    assert.deepStrictEqual(reply?.settings, {
      screenView: true,
      control: true,
      logs: true,
      indicator: 'normal',
      muteNotifications: false,
      touchIndicator: false,
    });
  });
  it('drops unknown keys, wrong types and a fourth indicator value', () => {
    assert.deepStrictEqual(parsePhoneSettings({ control: 'no', screenView: false, extra: true, indicator: 'loud' }), { screenView: false });
    assert.deepStrictEqual(parsePhoneSettings({ indicator: 'minimal' }), { indicator: 'minimal' });
    assert.strictEqual(parsePhoneSettings('x'), undefined);
    assert.strictEqual(parsePhoneSettings(null), undefined);
    assert.strictEqual(parsePhoneSettings([true]), undefined);
    assert.strictEqual(parseAgentReply(ping(',"settings":3'))?.settings, undefined);
  });
  it('a 1.8 reply has neither field', () => {
    const reply = parseAgentReply(ping(''));
    assert.strictEqual(reply?.settings, undefined);
    assert.strictEqual(reply?.settingsPage, undefined);
  });
  it('classifyPing copies settings and settingsPage to running', () => {
    const probe = classifyPing({ exitCode: 0, stderr: '', stdout: ping(`,"settingsPage":true,"settings":{"control":false}`) });
    assert.deepStrictEqual(probe, {
      state: 'running',
      version: '1.9.0',
      developerMode: true,
      settings: { control: false },
      settingsPage: true,
    });
  });

  it('describeProbe: unchanged without settings, then none, one and three permissions off', () => {
    const base = { state: 'running', version: '1.9.0', developerMode: true } as const;
    assert.strictEqual(describeProbe('d', base), 'Sailfish: device agent 1.9.0 is running on "d"; Developer Mode is on.');
    assert.match(describeProbe('d', { ...base, settings: { screenView: true, control: true, logs: true } }), /On the phone: the phone allows screen view, control and logs\.$/);
    assert.match(describeProbe('d', { ...base, settings: { control: false } }), /the phone has turned off control \(Settings → System → Developer agent\)\.$/);
    assert.match(describeProbe('d', { ...base, settings: { screenView: false, control: false, logs: false } }), /turned off screen view, control, logs /);
  });
  it('describePhoneSettings adds indicator, mute and touch indicator', () => {
    const text = describePhoneSettings({ screenView: true, indicator: 'minimal', muteNotifications: true, touchIndicator: true });
    assert.match(text, /session indicator minimal; agent notifications muted; touch indicator on\.$/);
    assert.strictEqual(describePhoneSettings(undefined), '');
    assert.strictEqual(describePhoneSettings({ indicator: 'normal' }), '');
  });

  it('describeAgentRefusal has texts for the new reasons and passes others through', () => {
    assert.match(describeAgentRefusal('screen view disabled on the phone'), /Screen view is turned off on the phone/);
    assert.match(describeAgentRefusal('logs disabled on the phone'), /System logs are turned off on the phone/);
    assert.match(describeAgentRefusal('stopped from the phone'), /stopped from the phone/);
    assert.match(describeAgentRefusal('developer mode is off'), /Developer Mode is off/);
    assert.strictEqual(describeAgentRefusal('something else'), 'something else');
  });
  it('phoneRefusal only for a running agent whose phone setting is false', () => {
    const base = { state: 'running', version: '1.9.0', developerMode: true } as const;
    assert.match(phoneRefusal({ ...base, settings: { screenView: false } }, 'screenView') ?? '', /Screen view is turned off/);
    assert.match(phoneRefusal({ ...base, settings: { logs: false } }, 'logs') ?? '', /logs are turned off/i);
    assert.strictEqual(phoneRefusal({ ...base, settings: { logs: false } }, 'screenView'), undefined);
    assert.strictEqual(phoneRefusal(base, 'logs'), undefined);
    assert.strictEqual(phoneRefusal({ state: 'not-running' }, 'logs'), undefined);
  });

  it('clientName strips to the agent alphabet and cuts at 64', () => {
    assert.strictEqual(clientName('my host (1).local'), 'my host 1.local');
    assert.strictEqual(clientName('a$b;`c'), 'abc');
    assert.strictEqual(clientName('(){}'), '');
    assert.strictEqual(clientName('x'.repeat(100)).length, 64);
  });
});
