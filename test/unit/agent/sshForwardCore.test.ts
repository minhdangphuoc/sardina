import * as assert from 'assert';
import type { SfdkDeviceInfo } from '../../../src/core/types';
import {
  AGENT_SOCKET_RE,
  boundStderrTail,
  buildForwardArgs,
  classifySshFailure,
  expandHomePath,
  forwardEligibility,
  hostKeyAlias,
  isSafeLocalSocketPath,
  knownHostsLines,
  parseHostKeyLines,
  parseSessionDirName,
  sessionDirName,
} from '../../../src/agent/sshForwardCore';

const SOCK = '/run/user/100000/sailfish-devagent/agent.sock';
const device = (over: Partial<SfdkDeviceInfo> = {}): SfdkDeviceInfo => ({
  index: 0,
  name: 'Xperia',
  kind: 'hardware-device',
  origin: 'user-defined',
  host: '192.168.1.5',
  port: 22,
  user: 'defaultuser',
  privateKey: '/home/u/.ssh/key',
  flags: [],
  extra: [],
  ...over,
});
const probe = { state: 'running', version: '1.2.0', socket: SOCK, mirrorEncodings: ['text', 'binary'] };
const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIGabc+/123';

describe('sshForwardCore', () => {
  it('buildForwardArgs gives the section 1.3 argv in order', () => {
    const args = buildForwardArgs({
      host: 'h',
      port: 2223,
      user: 'u',
      privateKey: '/k',
      localSocket: '/run/user/1/sailfish-tools/mirror-1-abc/agent.sock',
      remoteSocket: SOCK,
      knownHostsFile: '/g/ssh/known_hosts',
      hostKeyAlias: 'sailfish-x',
    });
    assert.deepStrictEqual(args, [
      '-N', '-T', '-F', 'none',
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
      '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StreamLocalBindMask=0177', '-o', 'StreamLocalBindUnlink=yes',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
      '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
      '-o', 'UserKnownHostsFile="/g/ssh/known_hosts"',
      '-o', 'HostKeyAlias=sailfish-x',
      '-o', 'LogLevel=ERROR',
      '-i', '/k', '-p', '2223',
      '-L', `/run/user/1/sailfish-tools/mirror-1-abc/agent.sock:${SOCK}`,
      '--', 'u@h',
    ]);
  });

  it('buildForwardArgs quotes a known-hosts path with spaces and rejects a double quote', () => {
    const base = {
      host: 'h', port: 22, user: 'u', privateKey: '/k', localSocket: '/t/agent.sock', remoteSocket: SOCK,
      hostKeyAlias: 'sailfish-x',
    };
    const args = buildForwardArgs({ ...base, knownHostsFile: '/Users/me/Library/Application Support/x/ssh/known_hosts' });
    assert.ok(args.includes('UserKnownHostsFile="/Users/me/Library/Application Support/x/ssh/known_hosts"'));
    assert.throws(() => buildForwardArgs({ ...base, knownHostsFile: '/a"b/known_hosts' }), /double quote/);
  });

  it('isSafeLocalSocketPath rejects colon, space and over-long paths', () => {
    assert.ok(isSafeLocalSocketPath('/run/user/1000/sailfish-tools/mirror-1-abc/agent.sock'));
    assert.ok(!isSafeLocalSocketPath('/tmp/a:b/agent.sock'));
    assert.ok(!isSafeLocalSocketPath('/tmp/a b/agent.sock'));
    assert.ok(!isSafeLocalSocketPath(`/tmp/${'a'.repeat(100)}/agent.sock`));
    assert.ok(!isSafeLocalSocketPath(''));
  });

  it('AGENT_SOCKET_RE accepts the agent socket and rejects look-alikes', () => {
    assert.ok(AGENT_SOCKET_RE.test(SOCK));
    assert.ok(!AGENT_SOCKET_RE.test('/run/user/1/sailfish-devagent/../agent.sock'));
    assert.ok(!AGENT_SOCKET_RE.test('/run/user/1/other/agent.sock'));
    assert.ok(!AGENT_SOCKET_RE.test(`${SOCK}\n`));
    assert.ok(!AGENT_SOCKET_RE.test('/run/user//sailfish-devagent/agent.sock'));
  });

  // Verbatim OpenSSH 9.6 stderr from the plan's F0 results; lines end in \r\n (a few in \n only).
  describe('classifySshFailure (F0 verbatim texts)', () => {
    const BAR = '@'.repeat(59);
    const KEY_PATH = '/tmp/f0/key';
    const lines = (...l: string[]): string => l.join('\r\n') + '\r\n';
    const fixtures: [string, string][] = [
      ['auth', lines('defaultuser@127.0.0.1: Permission denied (publickey).')],
      ['auth', 'Received disconnect from host port 22:2: Too many authentication failures\r\n'],
      [
        'key',
        lines(
          BAR,
          '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @',
          BAR,
          `Permissions 0644 for '${KEY_PATH}' are too open.`,
          'It is required that your private key files are NOT accessible by others.',
          'This private key will be ignored.',
          `Load key "${KEY_PATH}": bad permissions`,
          'defaultuser@127.0.0.1: Permission denied (publickey).',
        ),
      ],
      ['key', lines(`Load key "${KEY_PATH}": error in libcrypto`, 'defaultuser@127.0.0.1: Permission denied (publickey).')],
      [
        'key',
        `Warning: Identity file ${KEY_PATH} not accessible: No such file or directory.\n` +
          'defaultuser@127.0.0.1: Permission denied (publickey).\r\n',
      ],
      [
        'host-key-changed',
        lines(
          BAR,
          '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
          BAR,
          'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
          'Someone could be eavesdropping on you right now (man-in-the-middle attack)!',
          'It is also possible that a host key has just been changed.',
        ) +
          'The fingerprint for the ED25519 key sent by the remote host is\n' +
          lines(
            'SHA256:7iFgrRvVsDk2+2OiEwVlI8QNwI5O6eD13pGeYMx6TXU.',
            'Please contact your system administrator.',
            'Add correct host key in /tmp/f0/kh to get rid of this message.',
            'Offending ED25519 key in /tmp/f0/kh:1',
            '  remove with:',
            "  ssh-keygen -f '/tmp/f0/kh' -R 'sailfish-emu'",
            'Host key for sailfish-emu has changed and you have requested strict checking.',
            'Host key verification failed.',
          ),
      ],
      ['host-key-changed', 'Host key verification failed.\r\n'],
      [
        'not-pinned',
        lines('No ED25519 host key is known for sailfish-emu and you have requested strict checking.', 'Host key verification failed.'),
      ],
      ['unreachable', lines('ssh: connect to host 127.0.0.1 port 2299: Connection refused')],
      ['unreachable', lines('ssh: connect to host 192.0.2.1 port 22: Connection timed out')],
      ['unreachable', lines('ssh: Could not resolve hostname sailfish-f0.invalid: Name or service not known')],
      ['unreachable', lines('ssh: connect to host 10.0.0.1 port 22: No route to host')],
      ['unreachable', lines('ssh: connect to host 10.0.0.1 port 22: Network is unreachable')],
      [
        'local-bind',
        lines('unix_listener: cannot bind to path /tmp/f0/nodir/a.sock: No such file or directory', 'Could not request local forwarding.'),
      ],
      [
        'local-bind',
        lines('unix_listener: cannot bind to path /tmp/f0/ro/a.sock: Permission denied', 'Could not request local forwarding.'),
      ],
      ['local-bind', "Bad local forwarding specification '/tmp/f0/" + 'x'.repeat(100) + ".sock:/run/user/100000/sailfish-devagent/agent.sock'\n"],
      ['remote-refused', lines('channel 1: open failed: connect failed: open failed')],
      ['remote-refused', lines('channel 2: open failed: administratively prohibited: open failed')],
      ['other', 'something unexpected'],
      ['other', ''],
    ];
    for (const [cls, text] of fixtures) {
      it(`${cls}: ${text.split('\n')[0].slice(0, 90)}`, () => {
        assert.strictEqual(classifySshFailure(text), cls);
      });
    }
    it('options: ENOENT, timeout, closed before first byte', () => {
      assert.strictEqual(classifySshFailure('', { spawnErrorCode: 'ENOENT' }), 'no-ssh');
      assert.strictEqual(classifySshFailure('', { timedOut: true }), 'timeout');
      assert.strictEqual(classifySshFailure('', { closedBeforeFirstByte: true }), 'remote-refused');
      assert.strictEqual(classifySshFailure('', { spawnErrorCode: 'EACCES' }), 'other');
    });
    it('only the last 8 KiB of stderr count', () => {
      const long = 'Permission denied (publickey)\n' + 'x'.repeat(9000);
      assert.strictEqual(boundStderrTail(long).length, 8192);
      assert.strictEqual(classifySshFailure(long), 'other');
    });
  });

  describe('forwardEligibility', () => {
    it('eligible', () => {
      assert.deepStrictEqual(forwardEligibility(device(), probe, 'linux'), { ok: true, remoteSocket: SOCK });
      assert.strictEqual(forwardEligibility(device(), probe, 'darwin').ok, true);
    });
    it('agent 1.1.0, missing socket, bad socket, no binary encoding, not running', () => {
      assert.strictEqual(forwardEligibility(device(), { ...probe, version: '1.1.0' }, 'linux').ok, false);
      assert.strictEqual(forwardEligibility(device(), { ...probe, socket: undefined }, 'linux').ok, false);
      assert.strictEqual(forwardEligibility(device(), { ...probe, socket: '/tmp/x;rm' }, 'linux').ok, false);
      assert.strictEqual(forwardEligibility(device(), { ...probe, mirrorEncodings: ['text'] }, 'linux').ok, false);
      assert.strictEqual(forwardEligibility(device(), { state: 'not-running' }, 'linux').ok, false);
      assert.strictEqual(forwardEligibility(device(), { ...probe, version: '2.0.0' }, 'linux').ok, true);
    });
    it('Windows is ineligible', () => {
      assert.strictEqual(forwardEligibility(device(), probe, 'win32').ok, false);
    });
    it('missing endpoint fields, leading dash, bad port', () => {
      for (const over of [{ host: undefined }, { user: undefined }, { port: undefined }, { privateKey: undefined }]) {
        assert.strictEqual(forwardEligibility(device(over), probe, 'linux').ok, false);
      }
      assert.strictEqual(forwardEligibility(device({ user: '-oProxyCommand=x' }), probe, 'linux').ok, false);
      assert.strictEqual(forwardEligibility(device({ host: '-x' }), probe, 'linux').ok, false);
      assert.strictEqual(forwardEligibility(device({ port: 0 }), probe, 'linux').ok, false);
      assert.strictEqual(forwardEligibility(device({ port: 70000 }), probe, 'linux').ok, false);
      assert.strictEqual(forwardEligibility(device({ port: 65535 }), probe, 'linux').ok, true);
    });
  });

  it('sessionDirName and parseSessionDirName round-trip', () => {
    assert.strictEqual(sessionDirName(4242, 'aB3xYz'), 'mirror-4242-aB3xYz');
    assert.deepStrictEqual(parseSessionDirName(sessionDirName(4242, 'aB3xYz')), { pid: 4242 });
    assert.strictEqual(parseSessionDirName('mirror-x-abc'), undefined);
    assert.strictEqual(parseSessionDirName('other-1-abc'), undefined);
    assert.strictEqual(parseSessionDirName('mirror-1-a/../b'), undefined);
  });

  it('expandHomePath makes the ~/ form that sfdk device list prints absolute', () => {
    assert.strictEqual(expandHomePath('~/SailfishOS/vmshare/ssh/private_keys/sdk', '/home/u'), '/home/u/SailfishOS/vmshare/ssh/private_keys/sdk');
    assert.strictEqual(expandHomePath('~/k', '/home/u/'), '/home/u/k');
    assert.strictEqual(expandHomePath('~', '/home/u'), '/home/u');
    assert.strictEqual(expandHomePath('/abs/k', '/home/u'), '/abs/k');
    assert.strictEqual(expandHomePath('~other/k', '/home/u'), '~other/k');
    assert.strictEqual(expandHomePath('rel/~/k', '/home/u'), 'rel/~/k');
  });

  it('hostKeyAlias is ASCII without spaces', () => {
    const a = hostKeyAlias('Xperia 10 III – 日本語');
    assert.match(a, /^sailfish-[A-Za-z0-9._-]+$/);
    assert.strictEqual(hostKeyAlias('Xperia 10'), 'sailfish-Xperia-10');
  });

  describe('host keys', () => {
    it('accepts ed25519, ecdsa and rsa lines and drops comments', () => {
      const out = [
        `ssh-ed25519 ${ED} root@host`,
        'ecdsa-sha2-nistp256 AAAAE2VjZHNh+/== ',
        'ssh-rsa AAAAB3NzaC1yc2E=',
        '',
      ].join('\n');
      assert.deepStrictEqual(parseHostKeyLines(out), [
        { type: 'ssh-ed25519', key: ED },
        { type: 'ecdsa-sha2-nistp256', key: 'AAAAE2VjZHNh+/==' },
        { type: 'ssh-rsa', key: 'AAAAB3NzaC1yc2E=' },
      ]);
    });
    it('rejects injection, long lines, unknown types, CR inside, and cat errors', () => {
      assert.deepStrictEqual(parseHostKeyLines(`ssh-ed25519 ${ED} $(reboot)`), []);
      assert.deepStrictEqual(parseHostKeyLines(`ssh-ed25519 ${ED} \`id\``), []);
      assert.deepStrictEqual(parseHostKeyLines(`ssh-ed25519 ${ED} ${'a'.repeat(3072)}`), []);
      assert.deepStrictEqual(parseHostKeyLines(`ssh-dss ${ED}`), []);
      assert.deepStrictEqual(parseHostKeyLines(`ssh-ed25519 ${ED}\rx`), []);
      assert.deepStrictEqual(parseHostKeyLines(`ssh-ed25519 ${ED}\x00`), []);
      assert.deepStrictEqual(parseHostKeyLines('cat: /etc/ssh/ssh_host_rsa_key.pub: No such file or directory\n'), []);
    });
    it('tolerates CRLF line endings', () => {
      assert.strictEqual(parseHostKeyLines(`ssh-ed25519 ${ED}\r\n`).length, 1);
    });
    it('knownHostsLines format', () => {
      assert.strictEqual(
        knownHostsLines('sailfish-x', [{ type: 'ssh-ed25519', key: ED }, { type: 'ssh-rsa', key: 'AAAA' }]),
        `sailfish-x ssh-ed25519 ${ED}\nsailfish-x ssh-rsa AAAA\n`,
      );
      assert.strictEqual(knownHostsLines('a', []), '');
    });
  });
});
