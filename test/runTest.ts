import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runTests, downloadAndUnzipVSCode } from '@vscode/test-electron';

// Integration launcher (validation §6.3): fake sfdk SDK root + isolated extensions dir holding the qt-qml stub.

// This file compiles to out/test/runTest.js (tsc's rootDir mirrors the
// source tree), so the repo root is two levels up from __dirname, and the
// fixtures directory lives at <repoRoot>/test/fixtures (fixtures are plain
// JS/data, never compiled/copied into out/).
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_ROOT = path.join(REPO_ROOT, 'test', 'fixtures');
const FIXTURES_BIN = path.join(FIXTURES_ROOT, 'bin');

function parseGrepArg(argv: string[]): string | undefined {
  const idx = argv.indexOf('--grep');
  if (idx !== -1 && argv[idx + 1]) {
    return argv[idx + 1];
  }
  const inline = argv.find((a) => a.startsWith('--grep='));
  if (inline) {
    return inline.slice('--grep='.length);
  }
  return undefined;
}

async function main(): Promise<void> {
  const mode = process.env.TEST_MODE ?? 'bare';
  const grep = parseGrepArg(process.argv.slice(2)) ?? process.env.TEST_GREP;

  const extensionDevelopmentPath = REPO_ROOT;
  const extensionTestsPath = path.join(REPO_ROOT, 'out', 'test', 'integration', 'index');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sailfish-tools-test-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailfish-tools-userdata-'));

  const sdkRoot = path.join(tmpHome, 'sdk');
  const sdkBin = path.join(sdkRoot, 'bin');
  fs.mkdirSync(sdkBin, { recursive: true });
  fs.writeFileSync(path.join(sdkRoot, 'sdk-release'), '3.13.5\n', 'utf8');

  const sfdkShimPath = path.join(sdkBin, 'sfdk');
  const realFakeSfdk = path.join(FIXTURES_BIN, 'sfdk');
  fs.writeFileSync(
    sfdkShimPath,
    `#!/bin/sh\nexec "${realFakeSfdk}" "$@"\n`,
    { encoding: 'utf8', mode: 0o755 },
  );
  fs.chmodSync(sfdkShimPath, 0o755);

  const fakeLogPath = path.join(tmpHome, 'fake-invocations.jsonl');

  // Hard qt-qml dependency (TRD §2.2) must resolve in every mode; see CONVENTIONS.md.
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailfish-tools-extdir-'));
  fs.cpSync(path.join(FIXTURES_ROOT, 'stub-qtqml'), path.join(extensionsDir, 'theqtcompany.qt-qml-1.19.0'), {
    recursive: true,
  });

  const launchArgs = [
    path.join(FIXTURES_ROOT, 'workspaces', 'qml-app'),
    '--disable-gpu',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--password-store=basic',
    '--use-mock-keychain',
    '--use-inmemory-secretstorage',
  ];

  const extensionTestsEnv: Record<string, string> = {
    PATH: `${sdkBin}${path.delimiter}${FIXTURES_BIN}${path.delimiter}${process.env.PATH ?? ''}`,
    SAILFISH_SDK_ROOT: sdkRoot,
    SFDK_FAKE_SCENARIO: process.env.SFDK_FAKE_SCENARIO ?? 'default',
    SFDK_FAKE_LOG: fakeLogPath,
    TEST_MODE: mode,
    FIXTURES_ROOT,
    TMP_HOME: tmpHome,
  };
  if (grep) {
    extensionTestsEnv.TEST_GREP = grep;
  }
  if (process.env.HARNESS_SMOKE) {
    extensionTestsEnv.HARNESS_SMOKE = process.env.HARNESS_SMOKE;
  }

  console.log(`SFDK_FAKE_LOG=${fakeLogPath}`);
  console.log(`MODE=${mode}`);

  try {
    let vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
    if (!fs.existsSync(vscodeExecutablePath) && process.platform === 'darwin') {
      vscodeExecutablePath = path.join(path.dirname(vscodeExecutablePath), 'Code');
    }
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs,
      extensionTestsEnv,
    });
  } catch (err) {
    console.error('Failed to run integration tests:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
