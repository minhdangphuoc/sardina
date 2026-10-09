import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';
import { restoreAllStubs } from './helpers';

/**
 * Integration test entry point, loaded by test/runTest.ts as
 * `extensionTestsPath` (compiled to out/test/integration/index.js). Installs
 * process-wide unhandledRejection/uncaughtException guards BEFORE requiring
 * any test file (S7), then registers suites by TEST_MODE.
 */

interface UnexpectedError {
  kind: 'unhandledRejection' | 'uncaughtException';
  error: unknown;
}

const unexpectedErrors: UnexpectedError[] = [];

process.on('unhandledRejection', (reason) => {
  unexpectedErrors.push({ kind: 'unhandledRejection', error: reason });
});
process.on('uncaughtException', (err) => {
  unexpectedErrors.push({ kind: 'uncaughtException', error: err });
});

/**
 * R1-fixture-mutation: several suites write `sardina.target`/`sardina.device`/
 * `sardina.deploy.method` to the shared `qml-app` fixture's WorkspaceFolder
 * scope (it is the extension host's actual open folder, not a per-test
 * copy). Cleaning up here — before AND after the whole run — guarantees the
 * committed fixture never accumulates test state even if an individual
 * test's own `finally` cleanup is skipped by a timeout or crash.
 */
function qmlAppVscodeDir(): string | undefined {
  const fixturesRoot = process.env.FIXTURES_ROOT;
  return fixturesRoot ? path.join(fixturesRoot, 'workspaces', 'qml-app', '.vscode') : undefined;
}

function cleanQmlAppFixture(): void {
  const dir = qmlAppVscodeDir();
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    timeout: 20000,
    color: true,
    grep: process.env.TEST_GREP || undefined,
  });

  const testsRoot = __dirname;
  const mode = process.env.TEST_MODE ?? 'bare';

  // "bare" mode: activation smoke suite only (nothing else installed).
  const files: string[] = [];
  const activationTest = path.join(testsRoot, 'activation.test.js');
  if (fs.existsSync(activationTest)) {
    files.push(activationTest);
  }

  if (mode !== 'bare') {
    // Other modes may register additional suites (per-task test files under
    // test/integration/*.test.ts) as they land; discover any *.test.js next
    // to this file besides activation.test.js, which is always included.
    for (const entry of fs.readdirSync(testsRoot)) {
      if (entry.endsWith('.test.js') && entry !== 'activation.test.js') {
        files.push(path.join(testsRoot, entry));
      }
    }
  }

  for (const f of files) {
    mocha.addFile(f);
  }

  // Root-level teardown for stub cleanup, since helpers.ts stubs are shared
  // across suites via a module-level sandbox.
  mocha.suite.afterEach(function (this: Mocha.Context) {
    restoreAllStubs();
  });

  cleanQmlAppFixture();
  mocha.suite.afterAll(cleanQmlAppFixture);

  await new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (unexpectedErrors.length > 0) {
          const details = unexpectedErrors
            .map((e) => `[${e.kind}] ${e.error instanceof Error ? e.error.stack : String(e.error)}`)
            .join('\n');
          reject(new Error(`${unexpectedErrors.length} unhandled rejection(s)/exception(s):\n${details}`));
          return;
        }
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
