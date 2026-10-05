import * as assert from 'node:assert';
import { buildKeyParams, decideSigningUser, looksLikeKeyId, nameFromUserId, parseSecretKeys, signingProblemMessage, signingUserFor, validateKeyEmail, validateKeyName, validatePassphrase } from '../../../src/tasks/signingCore';

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
    assert.deepStrictEqual(parseSecretKeys(out), [
      { name: 'Jane Doe', userId: 'Jane Doe (work) <jane@example.com>', fingerprint: '0123456789ABCDEF0123456789ABCDEF01234567' },
    ]);
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

  it('keeps two keys with overlapping names apart by fingerprint, using the primary key\'s fingerprint', () => {
    const out = [
      'sec:u:3072:1:AAAA:1700000000:::u:::scESC:::+:::23::0:',
      'fpr:::::::::E067F7A78B1D3DCB1C0A4DDBC961D80E223D0BA9:',
      'uid:u::::1700000000::H1::Minh Dang Dev:',
      'ssb:u:3072:1:BBBB:1700000000::::::e:::+:::23:',
      'fpr:::::::::1111111111111111111111111111111111111111:',
      'sec:u:3072:1:CCCC:1700000001:::u:::scESC:::+:::23::0:',
      'fpr:::::::::CF32678AC48A0467CD93BA5617C0B1A925805484:',
      'uid:u::::1700000001::H2::Minh Dang <minh.dang@jolla.com>:',
    ].join('\n');
    const keys = parseSecretKeys(out);
    assert.deepStrictEqual(
      keys.map((k) => [k.name, k.fingerprint]),
      [
        ['Minh Dang Dev', 'E067F7A78B1D3DCB1C0A4DDBC961D80E223D0BA9'],
        ['Minh Dang', 'CF32678AC48A0467CD93BA5617C0B1A925805484'],
      ],
    );
  });

  it('signingUserFor prefers the fingerprint and falls back to the name', () => {
    assert.strictEqual(signingUserFor({ name: 'Jane Doe', userId: 'Jane Doe', fingerprint: 'ABCD' }), 'ABCD');
    assert.strictEqual(signingUserFor({ name: 'Jane Doe', userId: 'Jane Doe', fingerprint: '' }), 'Jane Doe');
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

  describe('decideSigningUser', () => {
    const dev = { name: 'Minh Dang Dev', userId: 'Minh Dang Dev', fingerprint: 'E067F7A78B1D3DCB1C0A4DDBC961D80E223D0BA9' };
    const main = { name: 'Minh Dang', userId: 'Minh Dang <m@x.org>', fingerprint: 'CF32678AC48A0467CD93BA5617C0B1A925805484' };

    it('recognises key IDs and fingerprints', () => {
      assert.ok(looksLikeKeyId('CF32678AC48A0467CD93BA5617C0B1A925805484'));
      assert.ok(looksLikeKeyId('0x17C0B1A925805484'));
      assert.ok(looksLikeKeyId('25805484'));
      assert.ok(!looksLikeKeyId('Minh Dang'));
      assert.ok(!looksLikeKeyId('Jane'));
    });

    it('passes a key ID through without needing any matches', () => {
      assert.deepStrictEqual(decideSigningUser('17C0B1A925805484', []), { kind: 'use', user: '17C0B1A925805484' });
    });

    it('pins a name that matches exactly one key to its fingerprint', () => {
      assert.deepStrictEqual(decideSigningUser('Minh Dang Dev', [dev]), { kind: 'use', user: dev.fingerprint });
    });

    it('reports a name that matches several keys, and names them', () => {
      const decision = decideSigningUser('Minh Dang', [dev, main]);
      assert.strictEqual(decision.kind, 'ambiguous');
      if (decision.kind !== 'ambiguous') return;
      const message = signingProblemMessage('Minh Dang', decision);
      assert.match(message, /matches 2 GPG keys/);
      assert.match(message, /Minh Dang Dev \(…223D0BA9\)/);
      assert.match(message, /Minh Dang \(…25805484\)/);
      assert.match(message, /Set Up Package Signing/);
    });

    it('reports a name that matches no key', () => {
      const decision = decideSigningUser('Nobody Here', []);
      assert.strictEqual(decision.kind, 'none');
      if (decision.kind !== 'none') return;
      assert.match(signingProblemMessage('Nobody Here', decision), /no GPG secret key matches the signing user "Nobody Here"/);
    });
  });
});
