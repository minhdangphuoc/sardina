import * as assert from 'assert';
import { platformTarget, parseLatestVersion, buildDownloadUrl } from '../../../src/sfdk/downloadSdk';

describe('platformTarget ("Sailfish: Download SDK")', () => {
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
