import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  addWorkspaceFolder,
  copyFixtureWorkspace,
  extensionApi,
  fixturesRoot,
  replaceDirContents,
  waitFor,
  waitForContext,
} from './helpers';
import type { Services } from '../../src/core/services';
import type { ProjectDescriptor } from '../../src/core/types';

/**
 * FR-2.2/2.3/2.4/2.5 + FR-14.3 + M1.6/M1.7/AC-1.1: exercises the live qml-app workspace end to end.
 * Tests needing a second project reuse a single extra workspace folder added once in `suiteSetup`,
 * whose content is swapped via `replaceDirContents`; the extension's own workspace-wide FileSystemWatcher
 * picks up the change, since this test host only reliably accepts one `updateWorkspaceFolders` call.
 */
suite('project detection', () => {
  let extraDir: string;
  let extraFolder: vscode.WorkspaceFolder;
  let services: Services;

  suiteSetup(async function () {
    this.timeout(15000);
    services = extensionApi().__test.getServices() as unknown as Services;
    extraDir = copyFixtureWorkspace('not-sailfish', 'sf-extra-');
    extraFolder = await addWorkspaceFolder(extraDir);
    await waitForContext('sardina.projectCount', 1, 8000);
  });

  suiteTeardown(() => {
    fs.rmSync(extraDir, { recursive: true, force: true });
  });

  test('isProject=true, projectCount=1, descriptor matches harbour-demo (AC-1.1)', async () => {
    await waitForContext('sardina.isProject', true, 5000);
    await waitForContext('sardina.projectCount', 1, 5000);

    const projects = services.projects.projects();
    assert.strictEqual(projects.length, 1);
    const [project] = projects;
    assert.strictEqual(project.name, 'harbour-demo');
    assert.strictEqual(project.buildSystem, 'qmake');
    assert.strictEqual(project.hasNativeBinary, true);
  });

  test('detection flips defined -> undefined -> defined on a temp copy when rpm/*.spec is deleted and recreated (R1)', async function () {
    this.timeout(30000);
    replaceDirContents(extraDir, 'qml-app');
    const specPath = path.join(extraDir, 'rpm', 'harbour-demo.spec');
    const originalContent = fs.readFileSync(specPath, 'utf8');

    try {
      await waitForContext('sardina.projectCount', 2, 8000);
      await waitFor(() => services.projects.forFolder(extraFolder) !== undefined, 8000);

      fs.unlinkSync(specPath);
      await waitFor(() => services.projects.forFolder(extraFolder) === undefined, 8000);

      fs.writeFileSync(specPath, originalContent, 'utf8');
      await waitFor(() => services.projects.forFolder(extraFolder) !== undefined, 8000);
    } finally {
      replaceDirContents(extraDir, 'not-sailfish');
      await waitForContext('sardina.projectCount', 1, 8000);
    }
  });

  test('activationEvents contains no "*" (M1.7)', () => {
    const pkgPath = path.resolve(fixturesRoot(), '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { activationEvents?: string[] };
    assert.ok(pkg.activationEvents && pkg.activationEvents.length > 0);
    assert.ok(!pkg.activationEvents.includes('*'), 'activationEvents must not contain the "*" wildcard');
  });

  test('resolveActive resolves the single project with no active editor requirement', async () => {
    const active = await services.projects.resolveActive();
    assert.ok(active);
    assert.strictEqual(active?.name, 'harbour-demo');
  });

  test('resolveActive: QuickPick when >1 project and no active editor, active editor\'s folder otherwise (FR-2.5)', async function () {
    this.timeout(20000);
    replaceDirContents(extraDir, 'cmake-app');

    // Patches services.prompts directly (the object src/project/active.ts reads from), since a fresh
    // import here would resolve to a separate compiled copy and the real showQuickPick would hang.
    const originalShowQuickPick = services.prompts.showQuickPick;
    try {
      await waitForContext('sardina.projectCount', 2, 8000);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');

      const cmakeProject = services.projects.forFolder(extraFolder);
      assert.ok(cmakeProject, 'expected the extra folder to be detected as harbour-cmake-demo');
      assert.strictEqual(cmakeProject?.name, 'harbour-cmake-demo');

      let quickPickCalls = 0;
      interface ProjectQuickPickItem extends vscode.QuickPickItem {
        project: ProjectDescriptor;
      }
      services.prompts.showQuickPick = ((items: readonly ProjectQuickPickItem[]) => {
        quickPickCalls++;
        return Promise.resolve(items[1]);
      }) as unknown as typeof services.prompts.showQuickPick;

      const picked = await services.projects.resolveActive();
      assert.strictEqual(quickPickCalls, 1, 'expected the QuickPick to be shown when >1 project exists');
      assert.strictEqual(picked?.name, cmakeProject?.name);

      services.prompts.showQuickPick = () => {
        throw new Error('QuickPick must not be shown when the active editor resolves a project');
      };

      // realpath-resolved to match addWorkspaceFolder's own resolution (macOS: /var/... vs /private/var/...).
      const mainCpp = path.join(fs.realpathSync(extraDir), 'src', 'main.cpp');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mainCpp));
      await vscode.window.showTextDocument(doc);

      const activeResolved = await services.projects.resolveActive();
      assert.strictEqual(activeResolved?.name, 'harbour-cmake-demo');
    } finally {
      services.prompts.showQuickPick = originalShowQuickPick;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      replaceDirContents(extraDir, 'not-sailfish');
      await waitForContext('sardina.projectCount', 1, 8000);
    }
  });

  test('hasTarget/hasDevice reflect sardina.target/sardina.device and refresh on change (FR-2.3)', async function () {
    this.timeout(15000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected the qml-app root workspace folder');
    // Global scope: never writes into the shared qml-app fixture's .vscode/settings.json.
    const config = vscode.workspace.getConfiguration('sardina', folder.uri);

    try {
      await config.update('target', 'SailfishOS-4.4.0.58-aarch64', vscode.ConfigurationTarget.Global);
      await waitForContext('sardina.hasTarget', true, 8000);

      await config.update('target', undefined, vscode.ConfigurationTarget.Global);
      await waitForContext('sardina.hasTarget', false, 8000);

      await config.update('device', 'MyDevice', vscode.ConfigurationTarget.Global);
      await waitForContext('sardina.hasDevice', true, 8000);

      await config.update('device', undefined, vscode.ConfigurationTarget.Global);
      await waitForContext('sardina.hasDevice', false, 8000);
    } finally {
      await config.update('target', undefined, vscode.ConfigurationTarget.Global);
      await config.update('device', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('a real configuration change dispatches to its own key listener only (FR-14.3, M1.4)', async function () {
    this.timeout(15000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);

    let sdkPathCalls = 0;
    let targetCalls = 0;
    const disposables = [
      services.settings.onDidChange('sdkPath', () => sdkPathCalls++),
      services.settings.onDidChange('target', () => targetCalls++),
    ];

    // Global scope: this test is about per-key dispatch, not scope.
    const globalConfig = vscode.workspace.getConfiguration('sardina');

    try {
      await globalConfig.update('sdkPath', '/tmp/fake-sdk', vscode.ConfigurationTarget.Global);
      await waitFor(() => sdkPathCalls >= 1, 8000);
      assert.strictEqual(targetCalls, 0, 'sdkPath change must not fire the target listener');

      await globalConfig.update('target', 'SailfishOS-4.4.0.58-aarch64', vscode.ConfigurationTarget.Global);
      await waitFor(() => targetCalls >= 1, 8000);
      assert.strictEqual(sdkPathCalls, 1, 'target change must not fire the sdkPath listener again');
    } finally {
      for (const d of disposables) {
        d.dispose();
      }
      await globalConfig.update('sdkPath', undefined, vscode.ConfigurationTarget.Global);
      await globalConfig.update('target', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('R1-fixture-mutation: this suite leaves no sardina.* keys behind in the shared qml-app fixture', async function () {
    this.timeout(10000);
    const settingsPath = path.join(fixturesRoot(), 'workspaces', 'qml-app', '.vscode', 'settings.json');
    await waitFor(() => {
      if (!fs.existsSync(settingsPath)) {
        return true;
      }
      const content = fs.readFileSync(settingsPath, 'utf8');
      return !/"sardina\./.test(content);
    }, 8000);
  });
});
