import * as assert from 'assert';
import {
  archFromOutput,
  archFromRpmQuery,
  classifyConnection,
  describeOsRelease,
  parseIpAddrOutput,
  parseOsRelease,
  parseSshConnection,
} from '../../../src/monitor/overview';

const EMULATOR_OS = [
  'NAME="Sailfish OS"',
  'VERSION="5.0.0.62 (Tampere)"',
  'ID=sailfishos',
  'VERSION_ID=5.0.0.62',
  'PRETTY_NAME="Sailfish OS 5.0.0.62 (Tampere)"',
  'SAILFISH_FLAVOUR=release',
  'HOME_URL="https://sailfishos.org/"',
].join('\n');

describe('parseOsRelease', () => {
  it('reads a full os-release', () => {
    const os = parseOsRelease(EMULATOR_OS);
    assert.deepStrictEqual(os, {
      versionId: '5.0.0.62',
      version: '5.0.0.62 (Tampere)',
      prettyName: 'Sailfish OS 5.0.0.62 (Tampere)',
      flavour: 'release',
    });
    assert.strictEqual(describeOsRelease(os), 'Sailfish OS 5.0.0.62 (Tampere) · flavour release');
  });
  it('reads a minimal one and builds the name from NAME and VERSION', () => {
    assert.deepStrictEqual(parseOsRelease('VERSION_ID=4.6.0.15\n'), { versionId: '4.6.0.15' });
    assert.strictEqual(describeOsRelease({ versionId: '4.6.0.15' }), 'version 4.6.0.15');
    assert.strictEqual(parseOsRelease("NAME='Sailfish OS'\nVERSION=4.6").prettyName, 'Sailfish OS 4.6');
  });
  it('ignores comments, junk and lowercase keys and handles CRLF', () => {
    const os = parseOsRelease('# c\r\nfoo bar\r\nlower=1\r\nVERSION_ID="1.2"\r\n=x\r\n');
    assert.deepStrictEqual(os, { versionId: '1.2' });
    assert.deepStrictEqual(parseOsRelease(''), {});
    assert.strictEqual(describeOsRelease({}), 'unknown');
  });
  it('unescapes quotes and caps a field', () => {
    assert.strictEqual(parseOsRelease('PRETTY_NAME="a \\"b\\""').prettyName, 'a "b"');
    assert.strictEqual(parseOsRelease(`VERSION_ID=${'9'.repeat(1000)}`).versionId?.length, 200);
  });
});

describe('connection', () => {
  const IP = [
    '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
    '5: rndis0    inet 192.168.2.15/24 brd 192.168.2.255 scope global rndis0\\       valid_lft forever',
    '7: wlan0    inet 192.168.1.40/24 brd 192.168.1.255 scope global wlan0\\       valid_lft forever',
    '9: eth0    inet 10.0.2.15/24 brd 10.0.2.255 scope global eth0\\       valid_lft forever',
    '11: tun0@NONE    inet 10.8.0.2/24 scope global tun0',
  ].join('\n');

  it('parses SSH_CONNECTION', () => {
    assert.strictEqual(parseSshConnection('192.168.2.1 51234 192.168.2.15 22\n'), '192.168.2.15');
    assert.strictEqual(parseSshConnection('fe80::1 1 fe80::2 22'), undefined);
    assert.strictEqual(parseSshConnection('1 2 3'), undefined);
    assert.strictEqual(parseSshConnection('a b 999.1.1.1 22'), undefined);
  });
  it('maps addresses to interfaces', () => {
    const m = parseIpAddrOutput(IP);
    assert.strictEqual(m.get('192.168.2.15'), 'rndis0');
    assert.strictEqual(m.get('10.8.0.2'), 'tun0');
    assert.strictEqual(m.size, 5);
  });
  it('classifies USB, Wi-Fi, emulator NAT, other and unknown', () => {
    assert.deepStrictEqual(classifyConnection('192.168.2.1 1 192.168.2.15 22', IP), {
      kind: 'usb',
      address: '192.168.2.15',
      iface: 'rndis0',
      label: 'USB',
    });
    assert.strictEqual(classifyConnection('192.168.1.2 1 192.168.1.40 22', IP).kind, 'wifi');
    assert.strictEqual(classifyConnection('10.0.2.2 1 10.0.2.15 22', IP).label, 'emulator (VirtualBox NAT)');
    assert.strictEqual(classifyConnection('10.0.2.2 1 10.0.2.15 22', '').kind, 'emulator');
    assert.deepStrictEqual(classifyConnection('1.1.1.1 1 10.8.0.2 22', IP), { kind: 'other', address: '10.8.0.2', iface: 'tun0', label: 'tun0' });
    assert.strictEqual(classifyConnection('1.1.1.1 1 172.16.0.5 22', IP).kind, 'unknown');
    assert.deepStrictEqual(classifyConnection('', ''), { kind: 'unknown', label: 'unknown' });
    assert.strictEqual(classifyConnection('x y z', IP).kind, 'unknown');
  });
  it('reuses the architecture parsers', () => {
    assert.strictEqual(archFromRpmQuery('rpm-4.16.1.3-1.6.1.jolla.armv7hl\n'), 'armv7hl');
    assert.strictEqual(archFromOutput('aarch64\n'), 'aarch64');
  });
});
