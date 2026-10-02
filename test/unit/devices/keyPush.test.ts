import * as assert from 'assert';
import {
  ASKPASS_PASSWORD_ENV,
  ASKPASS_SCRIPT,
  buildKeyPushInvocation,
  classifyKeyPushFailure,
} from '../../../src/devices/keyPush';

describe('keyPush (FR-7.8 in-app key push)', () => {
  const base = { pubKeyPath: '/k/Jolla-Phone.pub', host: '192.168.2.16', port: 22, user: 'defaultuser', askpassPath: '/k/askpass.sh' };

  it('builds an ssh-copy-id argv with the target after "--" and no password anywhere in argv', () => {
    const inv = buildKeyPushInvocation(base);
    assert.strictEqual(inv.cmd, 'ssh-copy-id');
    assert.deepStrictEqual(inv.args.slice(-2), ['--', 'defaultuser@192.168.2.16']);
    assert.ok(inv.args.includes('StrictHostKeyChecking=accept-new'));
    assert.ok(inv.args.includes('NumberOfPasswordPrompts=1'));
    assert.deepStrictEqual(inv.args.slice(0, 4), ['-i', '/k/Jolla-Phone.pub', '-p', '22']);
    assert.ok(!(ASKPASS_PASSWORD_ENV in inv.env), 'the password env is only added at spawn time');
  });

  it('forces askpass and falls back to DISPLAY=:0 when none is set', () => {
    assert.deepStrictEqual(buildKeyPushInvocation(base).env, { SSH_ASKPASS: '/k/askpass.sh', SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' });
    assert.strictEqual(buildKeyPushInvocation({ ...base, display: ':1' }).env.DISPLAY, ':1');
  });

  it('R25: an option-like host stays a positional after "--"', () => {
    const inv = buildKeyPushInvocation({ ...base, host: '-oProxyCommand=evil' });
    assert.strictEqual(inv.args[inv.args.length - 2], '--');
  });

  it('the askpass helper prints only the password variable', () => {
    assert.ok(ASKPASS_SCRIPT.startsWith('#!/bin/sh\n'));
    assert.ok(ASKPASS_SCRIPT.includes(`"$${ASKPASS_PASSWORD_ENV}"`));
  });

  it('classifies real ssh-copy-id failures', () => {
    assert.strictEqual(classifyKeyPushFailure('defaultuser@192.168.2.16: Permission denied (publickey,password).'), 'auth');
    assert.strictEqual(classifyKeyPushFailure('ssh: connect to host 192.168.2.16 port 22: No route to host'), 'unreachable');
    assert.strictEqual(classifyKeyPushFailure('ssh: connect to host 192.168.2.16 port 22: Connection refused'), 'unreachable');
    assert.strictEqual(classifyKeyPushFailure('ssh_askpass: exec(/k/askpass.sh): No such file or directory'), 'other');
  });
});
