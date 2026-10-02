import * as assert from 'node:assert';
import { buildKeyParams, nameFromUserId, parseSecretKeys, validateKeyEmail, validateKeyName, validatePassphrase } from '../../../src/tasks/signingCore';

describe('signingCore', () => {
  it('strips the email and comment from a user ID', () => {
    assert.strictEqual(nameFromUserId('Jane Doe <jane@example.com>'), 'Jane Doe');
    assert.strictEqual(nameFromUserId('Jane Doe (work) <jane@example.com>'), 'Jane Doe');
    assert.strictEqual(nameFromUserId('Jane Doe'), 'Jane Doe');
  });

  it('lists the user IDs of secret keys', () => {
    const out = [
      'sec:u:3072:1:AAAA:1700000000:::u:::scESC:::+:::23::0:',
      'fpr:::::::::0123456789ABCDEF0123456789ABCDEF01234567:',
      'uid:u::::1700000000::HASH::Jane Doe (work) <jane@example.com>::::::::::0:',
      'ssb:u:3072:1:BBBB:1700000000::::::e:::+:::23:',
    ].join('\n');
    assert.deepStrictEqual(parseSecretKeys(out), [{ name: 'Jane Doe', userId: 'Jane Doe (work) <jane@example.com>' }]);
  });

  it('skips revoked and expired user IDs and duplicates', () => {
    const out = [
      'uid:r::::1700000000::H1::Old Name <old@example.com>:',
      'uid:e::::1700000000::H2::Expired One <e@example.com>:',
      'uid:u::::1700000000::H3::Jane Doe <jane@example.com>:',
      'uid:u::::1700000000::H4::Jane Doe <jane@other.org>:',
    ].join('\n');
    assert.deepStrictEqual(
      parseSecretKeys(out).map((k) => k.name),
      ['Jane Doe'],
    );
  });

  it('decodes escaped colons and returns nothing for empty output', () => {
    assert.strictEqual(parseSecretKeys('uid:u::::1::H::A\\x3aB <a@b.c>:')[0]?.name, 'A:B');
    assert.deepStrictEqual(parseSecretKeys(''), []);
  });

  it('validates the key name, email and passphrase', () => {
    assert.ok(validateKeyName('Jan'));
    assert.ok(validateKeyName('Jane\nDoe'));
    assert.strictEqual(validateKeyName('Jane Doe'), undefined);
    assert.strictEqual(validateKeyEmail(''), undefined);
    assert.strictEqual(validateKeyEmail('jane@example.com'), undefined);
    assert.ok(validateKeyEmail('not an email'));
    assert.strictEqual(validatePassphrase('s3cret phrase'), undefined);
    assert.ok(validatePassphrase('a\nPassphrase: b'));
  });

  it('builds the gpg parameter file', () => {
    assert.strictEqual(
      buildKeyParams('Jane Doe', 'jane@example.com', 'pw'),
      'Key-Type: RSA\nKey-Length: 3072\nKey-Usage: sign\nName-Real: Jane Doe\nName-Email: jane@example.com\nExpire-Date: 0\nPassphrase: pw\n%commit\n',
    );
    const open = buildKeyParams('Jane Doe', '', '');
    assert.ok(open.includes('%no-protection') && !open.includes('Name-Email') && !open.includes('Passphrase:'));
  });
});
