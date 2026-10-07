import * as assert from 'assert';
import { mapBuildError, mapDeployError } from '../../../src/tasks/errors';

describe('errors.mapDeployError (M1.17)', () => {
  it('maps real "bash: rsync: not found" (deploy exit 12) to an Install on device action', () => {
    const mapped = mapDeployError('bash: rsync: not found\nrsync: connection unexpectedly closed (0 bytes received so far) [sender]');
    assert.strictEqual(mapped?.actionLabel, 'Install on device');
  });

  it('maps real "Installing untrusted software disabled" to guidance about the device setting', () => {
    const mapped = mapDeployError('Installing harbour-x-0-1.aarch64.rpm\nInstalling untrusted software disabled\nInstallation failed');
    assert.match(mapped?.message ?? '', /untrusted software/);
  });

  it('maps real sfdk 3.13.5 "device is not set" (exit 120) to a Select device action', () => {
    const mapped = mapDeployError("The required configuration option 'device' is not set\nUsage: sfdk deploy {--pkcon|--rsync|--sdk}");
    assert.strictEqual(mapped?.actionLabel, 'Select device');
  });

  it('maps "No route to host" to Device unreachable + action', () => {
    const mapped = mapDeployError('ssh: connect to host 10.0.0.1 port 22: No route to host');
    assert.strictEqual(mapped?.message, 'Device unreachable');
    assert.strictEqual(mapped?.actionLabel, 'Open Devices view');
  });

  it('matches the fixture deploy-device-unreachable stderr text', () => {
    const mapped = mapDeployError('sfdk: unable to connect to device at 192.168.2.15:22: Connection timed out');
    assert.strictEqual(mapped?.message, 'Device unreachable');
  });

  it('matches the fixture deploy-no-rpm stderr text', () => {
    const mapped = mapDeployError("sfdk: no package found to deploy; run 'sfdk package' first");
    assert.strictEqual(mapped?.message, 'Build first');
  });

  it('maps SSH publickey failure without ever mentioning a password prompt', () => {
    const mapped = mapDeployError('Permission denied (publickey).');
    assert.ok(mapped?.message.includes('SSH authentication failed'));
    assert.ok(!/password/i.test(mapped?.message ?? ''));
  });

  it('maps "No RPM packages found" to Build first + action', () => {
    const mapped = mapDeployError('error: No RPM packages found in project directory');
    assert.strictEqual(mapped?.message, 'Build first');
    assert.strictEqual(mapped?.actionLabel, 'Build');
  });

  it('returns undefined for unrecognised stderr', () => {
    assert.strictEqual(mapDeployError('some other failure'), undefined);
  });
});

describe('errors.mapBuildError (M1.17)', () => {
  it('maps a key hand-off failure (overlapping key names) to a Set up signing action', () => {
    const mapped = mapBuildError(
      "gpg: key 223D0BA9: already in secret keyring\nFatal: Cannot sign packages: Internal error: Failed to import GPG key from file '/etc/mersdk/share/gnupg/Minh Dang.key'.",
    );
    assert.strictEqual(mapped?.actionLabel, 'Set up signing');
    assert.match(mapped?.message ?? '', /fingerprint/);
  });

  it('maps the passphrase-protected signing key failure to a Set up signing action', () => {
    const mapped = mapBuildError(
      'Pre-run routine failed: Failed to share GnuPG key with the build engine: The selected GPG key is passphrase protected and no passphrase was specified.',
    );
    assert.strictEqual(mapped?.actionLabel, 'Set up signing');
    assert.match(mapped?.message ?? '', /passphrase/);
  });

  it('maps "No build target selected" with the raw text + Select target action', () => {
    const mapped = mapBuildError('No build target selected');
    assert.strictEqual(mapped?.message, 'No build target selected');
    assert.strictEqual(mapped?.actionLabel, 'Select target');
  });

  it('maps "No such target"', () => {
    const mapped = mapBuildError('error: No such target: bogus');
    assert.strictEqual(mapped?.actionLabel, 'Select target');
  });

  it('matches the fixture target-not-set stderr text', () => {
    const mapped = mapBuildError(
      "sfdk: no build target specified and no default target is set; run 'sfdk config target=<name>' or pass -c target=<name>",
    );
    assert.strictEqual(mapped?.actionLabel, 'Select target');
  });

  it('matches the fixture target-missing stderr text', () => {
    const mapped = mapBuildError(
      "sfdk: target 'SailfishOS-4.4.0.58-aarch64' not found; run 'sfdk tools target list' to see installed targets",
    );
    assert.strictEqual(mapped?.actionLabel, 'Select target');
  });

  it('maps a declined on-device installation', () => {
    const mapped = mapDeployError('User aborted\nInstallation failed');
    assert.match(mapped?.message ?? '', /^The installation was declined or not confirmed on the device$/);
  });

  it('returns undefined for unrecognised stderr', () => {
    assert.strictEqual(mapBuildError('compile error at line 1'), undefined);
  });

  it('names the missing file when rpmbuild fails on %files', () => {
    const mapped = mapBuildError(
      'RPM build errors:\n    Directory not found: /home/deploy/installroot/usr/libexec/droid-hybris\n    File not found: /home/deploy/installroot/usr/libexec/droid-hybris/system/lib64/libsfoscamera2.so',
    );
    assert.strictEqual(
      mapped?.message,
      'Packaging failed: the spec lists /usr/libexec/droid-hybris/system/lib64/libsfoscamera2.so in %files, but the build did not install it. Check the %files section and the INSTALLS in the .pro',
    );
  });

  it('keeps a missing directory when no file below it is reported', () => {
    const mapped = mapBuildError('error: Directory not found: /x/installroot/usr/share/app');
    assert.match(mapped?.message ?? '', /lists \/usr\/share\/app in %files/);
  });

  it('maps the by-glob form and caps the list at three paths', () => {
    const mapped = mapBuildError(
      [1, 2, 3, 4, 5].map((n) => `error: File not found by glob: /b/installroot/usr/share/a/f${n}.png`).join('\n'),
    );
    assert.match(mapped?.message ?? '', /lists \/usr\/share\/a\/f1\.png, \/usr\/share\/a\/f2\.png, \/usr\/share\/a\/f3\.png and 2 more in %files/);
  });

  it('does not match a non-matching line', () => {
    assert.strictEqual(mapBuildError('File not found in cache, retrying'), undefined);
  });
});
