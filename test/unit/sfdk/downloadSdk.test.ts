import * as assert from 'assert';
import { platformTarget, parseLatestVersion, buildDownloadUrl, parseInstallerVersions, hasOnlineInstaller } from '../../../src/sfdk/downloadSdk';

describe('platformTarget ("Sardina: Download SDK")', () => {
  it('maps darwin/linux/win32 to the right installer suffix and extension', () => {
    assert.deepStrictEqual(platformTarget('darwin'), { suffix: 'mac', ext: 'dmg' });
    assert.deepStrictEqual(platformTarget('linux'), { suffix: 'linux64', ext: 'run' });
    assert.deepStrictEqual(platformTarget('win32'), { suffix: 'windows', ext: 'exe' });
  });

  it('returns null for an unsupported platform', () => {
    assert.strictEqual(platformTarget('freebsd'), null);
  });
});

describe('parseLatestVersion', () => {
  it('extracts the version from a real docs-page-shaped link', () => {
    const html = '<a href="https://releases.sailfishos.org/sdk/installers/3.13.5/SailfishSDK-3.13.5-mac-online.dmg">Download</a>';
    assert.strictEqual(parseLatestVersion(html), '3.13.5');
  });

  it('returns null when the page has no matching link (format changed)', () => {
    assert.strictEqual(parseLatestVersion('<html>nothing here</html>'), null);
  });
});

describe('buildDownloadUrl', () => {
  it('builds the exact releases.sailfishos.org URL shape', () => {
    const url = buildDownloadUrl('3.13.5', { suffix: 'mac', ext: 'dmg' }, 'online');
    assert.strictEqual(url, 'https://releases.sailfishos.org/sdk/installers/3.13.5/SailfishSDK-3.13.5-mac-online.dmg');
  });

  it('builds the offline variant for linux', () => {
    const url = buildDownloadUrl('3.13.5', { suffix: 'linux64', ext: 'run' }, 'offline');
    assert.strictEqual(url, 'https://releases.sailfishos.org/sdk/installers/3.13.5/SailfishSDK-3.13.5-linux64-offline.run');
  });
});

describe('parseInstallerVersions', () => {
  it('orders live releases first, then deprecated, each newest first; skips unusable names', () => {
    const html = [
      '<a href="1609.deprecated/">', '<a href="2.1.deprecated/">', '<a href="3.10.4.deprecated/">',
      '<a href="3.2.10.deprecated/">', '<a href="3.12.5/">', '<a href="3.13.5/">', '<a href="3.13.10/">', '<a href="latest/">',
    ].join('\n');
    assert.deepStrictEqual(parseInstallerVersions(html), [
      { version: '3.13.10', deprecated: false },
      { version: '3.13.5', deprecated: false },
      { version: '3.12.5', deprecated: false },
      { version: '3.10.4', deprecated: true },
      { version: '3.2.10', deprecated: true },
    ]);
  });

  it('returns an empty list when the index has no versions', () => {
    assert.deepStrictEqual(parseInstallerVersions('<html></html>'), []);
  });
});

describe('deprecated releases', () => {
  it('builds the URL inside the .deprecated directory but keeps the plain version in the file name', () => {
    const url = buildDownloadUrl('3.10.4', { suffix: 'linux64', ext: 'run' }, 'online', true);
    assert.strictEqual(url, 'https://releases.sailfishos.org/sdk/installers/3.10.4.deprecated/SailfishSDK-3.10.4-linux64-online.run');
  });

  it('only 3.x and later ship an online installer', () => {
    assert.strictEqual(hasOnlineInstaller('3.0.7'), true);
    assert.strictEqual(hasOnlineInstaller('2.4.0'), false);
  });
});
