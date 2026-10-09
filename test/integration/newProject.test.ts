import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  clearFakeLog,
  extensionApi,
  readFakeLog,
  restoreAllStubs,
  stubInputBox,
  stubMessages,
  stubOpenDialog,
  stubQuickPick,
  waitFor,
  waitForContext,
  withScenario,
} from './helpers';
import type { Services } from '../../src/core/services';

/** newProject wizard integration suite (FR-3, AC-1.3, R25/R33/M1.8/M1.9); only discovered when TEST_MODE != 'bare'. */

function services(): Services {
  return extensionApi().__test.getServices() as unknown as Services;
}

async function sfdkReady(): Promise<boolean> {
  try {
    await waitForContext('sardina.sdkAvailable', true, 5000);
  } catch {
    return false;
  }
  try {
    await services().runner.run({ args: ['init', '-l'], ensureEngine: false });
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes('not implemented')) {
      return false;
    }
    throw err;
  }
}

interface WizardPickItem extends vscode.QuickPickItem {
  type?: string;
  builder?: 'qmake' | 'cmake';
}

/** Stubs step 1 (type) + step 2 (builder), the two steps every test in this suite needs answered the same way. */
function stubTypeAndBuilder(type: string, builder: 'qmake' | 'cmake'): void {
  let call = 0;
  stubQuickPick((items: readonly WizardPickItem[]) => {
    call++;
    if (call === 1) {
      return items.find((i) => i.type === type);
    }
    return items.find((i) => i.builder === builder);
  });
}

suite('newProject wizard (FR-3, AC-1.3)', () => {
  let ready = false;
  let tmpParent: string;

  suiteSetup(async function () {
    this.timeout(15000);
    ready = await sfdkReady();
    if (!ready) {
      console.log('[newProject] SfdkRunner is still unimplemented; skipping sfdk-backed wizard assertions');
    }
  });

  setup(() => {
    tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-newproject-'));
  });

  teardown(() => {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  });

  test('AC-1.3: happy path issues exact argv with cwd = <parent>/<name>, offers the 3-way open choice', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(20000);
    await withScenario('default', async () => {
      clearFakeLog();
      stubTypeAndBuilder('qtquick2app', 'qmake');
      stubInputBox('harbour-demo');
      stubOpenDialog([vscode.Uri.file(tmpParent)]);
      const messages = stubMessages();

      await vscode.commands.executeCommand('sardina.newProject');
      await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'init_template'), 8000);

      const init = readFakeLog().invocations.find((i) => i.key === 'init_template');
      assert.ok(init);
      assert.deepStrictEqual(init.argv.filter((a) => a !== '--no-pager'), [
        'init',
        '-t',
        'qtquick2app',
        '-b',
        'qmake',
        'harbour-demo',
      ]);
      assert.strictEqual(
        fs.realpathSync(init.cwd),
        fs.realpathSync(path.join(tmpParent, 'harbour-demo')),
        'cwd must be the created <parent>/<name> directory (the one explicit cwd override, FR-3.2)',
      );

      await waitFor(() => messages.calls.some((c) => c.kind === 'information' && c.items.length === 3), 5000);
      const offer = messages.calls.find((c) => c.kind === 'information' && c.items.length === 3);
      assert.ok(offer);
      assert.deepStrictEqual(offer.items.sort(), ['Add to workspace', 'Open in current window', 'Open in new window'].sort());
    });
  });

  test('AC-1.3: cancel at step 3 (name) causes zero further sfdk invocations and no directory on disk', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(20000);
    await withScenario('default', async () => {
      clearFakeLog();
      stubTypeAndBuilder('qtquick2app', 'qmake');
      stubInputBox(undefined);
      const openDialog = stubOpenDialog([vscode.Uri.file(tmpParent)]);

      await vscode.commands.executeCommand('sardina.newProject');
      // Step 1's `init -l` listing call always lands first; wait for it, then
      // clear the log so the assertion below only covers invocations from
      // the cancel point on (no further `init` call once step 3 is cancelled).
      await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'init_list'), 8000);
      clearFakeLog();
      await new Promise((r) => setTimeout(r, 300));

      assert.strictEqual(readFakeLog().invocations.length, 0, 'no sfdk invocation after cancelling at the name step');
      assert.strictEqual(openDialog.called, false, 'step 4 (folder dialog) must never be reached after an earlier cancel');
      assert.deepStrictEqual(fs.readdirSync(tmpParent), [], 'nothing must be created on disk before step 4 completes');
    });
  });

  test('AC-1.3/M1.8: SFDK_FAKE_INIT_TOUCH=1 creates files directly in <parent>/<name>, not nested', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(20000);
    const prevTouch = process.env.SFDK_FAKE_INIT_TOUCH;
    process.env.SFDK_FAKE_INIT_TOUCH = '1';
    try {
      await withScenario('default', async () => {
        clearFakeLog();
        stubTypeAndBuilder('qtquick2app', 'qmake');
        stubInputBox('harbour-touch');
        stubOpenDialog([vscode.Uri.file(tmpParent)]);
        stubMessages();

        await vscode.commands.executeCommand('sardina.newProject');
        await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'init_template'), 8000);
        const projectDir = path.join(tmpParent, 'harbour-touch');
        await waitFor(() => fs.existsSync(path.join(projectDir, 'harbour-touch.pro')), 5000);
        await waitFor(() => fs.existsSync(path.join(projectDir, 'rpm', 'harbour-touch.spec')), 5000);
        assert.strictEqual(
          fs.existsSync(path.join(tmpParent, 'rpm')),
          false,
          'FR-3.2: files must land in <parent>/<name>, never directly in <parent>',
        );
      });
    } finally {
      if (prevTouch === undefined) delete process.env.SFDK_FAKE_INIT_TOUCH;
      else process.env.SFDK_FAKE_INIT_TOUCH = prevTouch;
    }
  });

  test('FR-3.2: a non-empty target directory needs confirmation before --force is added', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(20000);
    await withScenario('default', async () => {
      const projectDir = path.join(tmpParent, 'harbour-existing');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'stale.txt'), 'x');
      clearFakeLog();

      stubTypeAndBuilder('qtquick2app', 'qmake');
      stubInputBox('harbour-existing');
      stubOpenDialog([vscode.Uri.file(tmpParent)]);
      const messages = stubMessages();
      messages.chosenAction = 'Force';

      await vscode.commands.executeCommand('sardina.newProject');
      await waitFor(() => readFakeLog().invocations.some((i) => i.key === 'init_template'), 8000);

      const init = readFakeLog().invocations.find((i) => i.key === 'init_template');
      assert.ok(init!.argv.includes('--force'), 'expected --force once the user confirms the non-empty folder');
      assert.ok(
        messages.calls.some((c) => c.kind === 'warning' && /not empty/i.test(c.message)),
        'expected a confirmation prompt for the non-empty folder',
      );
    });
  });

  test('FR-3.2: declining the non-empty-folder confirmation aborts with no sfdk init call', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(20000);
    await withScenario('default', async () => {
      const projectDir = path.join(tmpParent, 'harbour-existing2');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'stale.txt'), 'x');
      clearFakeLog();

      stubTypeAndBuilder('qtquick2app', 'qmake');
      stubInputBox('harbour-existing2');
      stubOpenDialog([vscode.Uri.file(tmpParent)]);
      const messages = stubMessages();
      messages.chosenAction = 'Cancel';

      await vscode.commands.executeCommand('sardina.newProject');
      await new Promise((r) => setTimeout(r, 300));

      assert.strictEqual(
        readFakeLog().invocations.filter((i) => i.key === 'init_template').length,
        0,
        'declining the force confirmation must not call sfdk init',
      );
    });
  });

  test('FR-3.1/M1.9: a parse failure of "init -l" falls back to a free-text InputBox pre-filled "qtquick2app" with a "See sfdk output" warning first', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(20000);
    await withScenario('init-list-malformed', async () => {
      // No QuickPick stub: parseInitList must find zero valid entries in
      // this scenario's init_list.stdout, so pickTemplateType never shows
      // one, going straight to the InputBox fallback.
      let sawPrefilled = false;
      const inputBox = stubInputBox((opts) => {
        sawPrefilled = opts?.value === 'qtquick2app';
        return undefined; // cancel here; this test only asserts the fallback UX itself
      });
      const messages = stubMessages();

      await vscode.commands.executeCommand('sardina.newProject');
      await waitFor(() => inputBox.called, 5000);

      assert.ok(sawPrefilled, 'expected the free-text InputBox pre-filled with "qtquick2app"');
      assert.ok(
        messages.calls.some((c) => c.kind === 'warning' && c.items.includes('See sfdk output')),
        'expected a warning with a "See sfdk output" action before the free-text fallback',
      );
    });
  });

  test('R25: injection corpus on the project name is rejected by validation, with zero sfdk init calls', async function () {
    if (!ready) {
      this.skip();
      return;
    }
    this.timeout(30000);
    const corpus = [
      '; rm -rf /',
      '$(id)',
      '`id`',
      '"quoted"',
      "'quoted'",
      '--malicious-flag',
      '-',
      'Harbour-Demo',
      '1demo',
      'demo_app',
      'demo app',
      '',
      'a\nb',
      '日本語',
    ];
    await withScenario('default', async () => {
      for (const name of corpus) {
        clearFakeLog();
        restoreAllStubs();
        stubTypeAndBuilder('qtquick2app', 'qmake');
        stubInputBox(name);
        stubOpenDialog([vscode.Uri.file(tmpParent)]);
        const messages = stubMessages();

        await vscode.commands.executeCommand('sardina.newProject');
        await new Promise((r) => setTimeout(r, 200));

        assert.strictEqual(
          readFakeLog().invocations.filter((i) => i.key === 'init_template').length,
          0,
          `expected corpus entry ${JSON.stringify(name)} to never reach sfdk init`,
        );
        void messages;
      }
    });
  });
});
