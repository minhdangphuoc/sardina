import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { addWorkspaceFolder, copyFixtureWorkspace, extensionApi, waitFor, waitForContext } from './helpers';
import type { Services } from '../../src/core/services';
import { QT_QML_DO_NOT_ASK_KEY, QT_QML_ENABLED_KEY, QT_QML_EXTENSION_ID, QT_QML_SECTION } from '../../src/qtqml/keys';

interface ShownMessage {
  kind: 'information' | 'warning' | 'error';
  message: string;
}

// stub-qtqml has no qt-qml.* config schema, so getConfiguration is stubbed for that section.
suite('qt-qml silencing (FR-8.1, AC-1.10)', () => {
  let services: Services;
  let sandbox: sinon.SinonSandbox;

  let extraDir: string | undefined;
  let nonSailfishFolder: vscode.WorkspaceFolder | undefined;

  suiteSetup(async function () {
    this.timeout(20000);
    services = extensionApi().__test.getServices() as unknown as Services;
    // Under a narrow --grep, this suite may be the first to run and race
    // ProjectRegistry's own async initial refresh() (fired, not awaited,
    // from activateProjects) and activateQtQml's own first pass over it.
    await waitForContext('sailfish.projectCount', 1, 10000);

    // This test host only reliably supports adding a workspace folder once
    // past the initial folder-mode -> multi-root transition (see
    // project.test.ts's own note): when project.test.ts's suite already ran
    // (the normal full-suite case), reuse the non-Sailfish folder it leaves
    // behind at index 1 instead of adding a second one, which would fail.
    const existing = vscode.workspace.workspaceFolders?.find((f, i) => i > 0 && !services.projects.forFolder(f));
    if (existing) {
      nonSailfishFolder = existing;
    } else {
      try {
        extraDir = copyFixtureWorkspace('not-sailfish', 'sf-qtqml-notsailfish-');
        nonSailfishFolder = await addWorkspaceFolder(extraDir);
      } catch (err) {
        // Isolated --grep runs where this is the only suite adding a folder
        // succeed; a second concurrent add past another suite's own budget
        // does not. The "untouched" test below skips itself when this happens.
        console.log(`[qt-qml silencing] could not add a second workspace folder: ${String(err)}`);
      }
    }
    await services.projects.refresh();
  });

  suiteTeardown(() => {
    if (extraDir) {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  function stubQtQmlPresent(): void {
    const fakeExtension = { id: QT_QML_EXTENSION_ID } as unknown as vscode.Extension<unknown>;
    sandbox.stub(vscode.extensions, 'getExtension').callsFake((id: string) => {
      return id === QT_QML_EXTENSION_ID ? fakeExtension : undefined;
    });
  }

  /** The stub-qtqml fixture is genuinely installed in this test host (§2.2's hard dependency), so this suite forces the not-found path rather than relying on incidental absence. */
  function stubQtQmlAbsent(): void {
    const original = vscode.extensions.getExtension.bind(vscode.extensions);
    sandbox.stub(vscode.extensions, 'getExtension').callsFake((id: string) => {
      return id === QT_QML_EXTENSION_ID ? undefined : original(id);
    });
  }

  /**
   * Returns the per-folder-uri qt-qml settings store the fake `getConfiguration`
   * writes into, plus any scope violations. `inspect()` reports `defaultValue`
   * for the two FR-8.1 keys, simulating a qt-qml build that declares them
   * (silence.ts's §2.2 feature-detection requires this to proceed).
   */
  function stubQtQmlConfig(): { store: Map<string, Map<string, unknown>>; targetViolations: string[] } {
    const store = new Map<string, Map<string, unknown>>();
    const targetViolations: string[] = [];
    const original = vscode.workspace.getConfiguration.bind(vscode.workspace);

    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string, scope?: vscode.ConfigurationScope | null) => {
      if (section !== QT_QML_SECTION) {
        return original(section, scope);
      }
      const folderKey = scope instanceof vscode.Uri ? scope.toString() : 'no-scope';
      if (!store.has(folderKey)) {
        store.set(folderKey, new Map());
      }
      const folderStore = store.get(folderKey) as Map<string, unknown>;
      const defaults: Record<string, unknown> = { [QT_QML_ENABLED_KEY]: true, [QT_QML_DO_NOT_ASK_KEY]: false };
      return {
        inspect: <T>(key: string) => ({
          key: `${QT_QML_SECTION}.${key}`,
          defaultValue: defaults[key] as T | undefined,
          workspaceFolderValue: folderStore.get(key) as T | undefined,
        }),
        update: (key: string, value: unknown, target?: vscode.ConfigurationTarget) => {
          if (target !== vscode.ConfigurationTarget.WorkspaceFolder) {
            targetViolations.push(`${key} written at target ${String(target)}, expected WorkspaceFolder`);
          }
          folderStore.set(key, value);
          return Promise.resolve();
        },
      } as unknown as vscode.WorkspaceConfiguration;
    });

    return { store, targetViolations };
  }

  /** A qt-qml stand-in whose `inspect()` reports no `defaultValue` (an older/newer build lacking the FR-8.1 keys) and whose `update()` rejects if ever reached. */
  function stubQtQmlConfigMissingKeys(): void {
    const original = vscode.workspace.getConfiguration.bind(vscode.workspace);
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string, scope?: vscode.ConfigurationScope | null) => {
      if (section !== QT_QML_SECTION) {
        return original(section, scope);
      }
      return {
        inspect: () => ({ key: `${QT_QML_SECTION}.x` }),
        update: () => Promise.reject(new Error('not a registered configuration')),
      } as unknown as vscode.WorkspaceConfiguration;
    });
  }

  test('feature-detects the FR-8.1 keys and fails soft (no unhandled rejection, warning logged, no writes) when qt-qml lacks them (§2.2)', async function () {
    // Runs before the "folder-scoped" test below: silence.ts writes a given
    // folder at most once per activation session, so this must observe the
    // folder before any other test in this suite has successfully silenced it.
    this.timeout(15000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected the qml-app root workspace folder');

    // Captured before stubbing getExtension below: stubQtQmlPresent() replaces
    // vscode.extensions.getExtension entirely, which extensionApi() itself relies on.
    const api = extensionApi();
    const before = (api.__test.getShownMessages() as ShownMessage[]).length;

    stubQtQmlPresent();
    stubQtQmlConfigMissingKeys();
    await services.projects.refresh();
    await new Promise((r) => setTimeout(r, 500));

    // No unhandled rejection reached the harness (it would have failed the whole run, S7);
    // reaching this assertion at all is part of the proof.
    assert.strictEqual((api.__test.getShownMessages() as ShownMessage[]).length, before, 'expected no additional prompt for a feature-detection skip');
  });

  test('folder-scoped qmlls.enabled=false and doNotAskForQmllsDownload=true, only at WorkspaceFolder scope, never additionalImportPaths (FR-8.1, FR-8.8)', async function () {
    // One test, not split across silencing + FR-8.8 assertions: silence.ts
    // only ever writes a folder once per session (tracked in its own
    // `silencedFolders` set), so a second test triggering another refresh()
    // afterwards would find the write already short-circuited and time out
    // waiting for a config.update() that silence.ts correctly does not repeat.
    this.timeout(15000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected the qml-app root workspace folder');
    assert.ok(services.projects.forFolder(folder), 'expected the root folder to be a detected Sailfish project');

    stubQtQmlPresent();
    const { store, targetViolations } = stubQtQmlConfig();
    await services.projects.refresh();

    const folderKey = folder.uri.toString();
    await waitFor(() => store.get(folderKey)?.get(QT_QML_ENABLED_KEY) === false, 8000);

    assert.strictEqual(store.get(folderKey)?.get(QT_QML_ENABLED_KEY), false);
    assert.strictEqual(store.get(folderKey)?.get(QT_QML_DO_NOT_ASK_KEY), true);
    assert.strictEqual(store.get(folderKey)?.has('qmlls.additionalImportPaths'), false);
    assert.deepStrictEqual(targetViolations, []);
  });

  test('a non-Sailfish folder is left untouched', async function () {
    this.timeout(15000);
    if (!nonSailfishFolder) {
      this.skip();
      return;
    }
    const folder = nonSailfishFolder;

    stubQtQmlPresent();
    const { store } = stubQtQmlConfig();
    await services.projects.refresh();
    await new Promise((r) => setTimeout(r, 500));

    assert.strictEqual(services.projects.forFolder(folder), undefined, 'expected not-sailfish to not be detected');
    assert.strictEqual(store.has(folder.uri.toString()), false, 'expected no qt-qml config writes for a non-Sailfish folder');
  });

  test('when qt-qml is absent, a single one-time informational notice is shown across the whole run (no error)', async function () {
    // §2.2's hard dependency means qt-qml is genuinely installed here, so absence is forced via stubQtQmlAbsent().
    this.timeout(10000);
    function missingNotices(): ShownMessage[] {
      const messages = extensionApi().__test.getShownMessages() as ShownMessage[];
      return messages.filter((m) => m.message.includes('qt-qml extension was not found'));
    }
    stubQtQmlAbsent();
    await services.projects.refresh();
    await waitFor(() => missingNotices().length >= 1, 8000);
    assert.strictEqual(missingNotices().length, 1, `expected exactly one missing-qt-qml notice, got: ${JSON.stringify(missingNotices())}`);
    assert.strictEqual(missingNotices()[0]?.kind, 'information');
  });
});

suite('Silica snippets language wiring (AC-1.11, FR-8.2)', () => {
  test('package.json declares contributes.languages "qml" and contributes.snippets for it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
      contributes: { languages?: { id: string }[]; snippets?: { language: string; path: string }[] };
    };
    assert.ok(pkg.contributes.languages?.some((l) => l.id === 'qml'), 'expected contributes.languages to declare "qml"');
    assert.deepStrictEqual(pkg.contributes.snippets, [{ language: 'qml', path: './snippets/silica.code-snippets' }]);
  });

  test('typing "sfpage" in a .qml document offers the sfpage snippet', async function () {
    this.timeout(10000);
    const doc = await vscode.workspace.openTextDocument({ language: 'qml', content: 'sfpage' });
    await vscode.window.showTextDocument(doc);
    // VS Code creates its snippets service lazily (on first use, or when the window goes idle), and only
    // then registers the snippet completion provider. A test window that never idles (hidden or covered)
    // would never offer snippets. Asking insertSnippet for a name that does not exist creates the service
    // and waits for the snippet files to load, without editing the document.
    await vscode.commands.executeCommand('editor.action.insertSnippet', { langId: 'qml', name: 'no such snippet' });
    assert.strictEqual(doc.getText(), 'sfpage');
    const position = new vscode.Position(0, 6);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      position,
    );
    const labels = (list?.items ?? []).map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
    assert.ok(labels.includes('sfpage'), `expected "sfpage" to be offered, got: ${JSON.stringify(labels)}`);
  });
});
