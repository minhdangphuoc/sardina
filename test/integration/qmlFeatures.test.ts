import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { extensionApi, fixturesRoot, waitFor, waitForContext } from './helpers';

const TEXT = 'import QtQuick 2.0\nimport Sailfish.Silica 1.0\n\nPage {\n  \n  Lable {}\n}\n';
const BODY = new vscode.Position(4, 2);

interface QmlApi {
  setImportRootForTests(root: string | undefined): void;
}

function qmlApi(): QmlApi {
  return (extensionApi().__test as unknown as { qml: QmlApi }).qml;
}

suite('QML language features', () => {
  let doc: vscode.TextDocument;
  let original: string;

  suiteSetup(async function () {
    this.timeout(20000);
    await waitForContext('sailfish.projectCount', 1, 10000);
    qmlApi().setImportRootForTests(path.join(fixturesRoot(), 'qmltypes', 'root'));
    const file = path.join(fixturesRoot(), 'workspaces', 'qml-app', 'qml', 'harbour-demo.qml');
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    original = doc.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), TEXT);
    await vscode.workspace.applyEdit(edit);
  });

  suiteTeardown(async () => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), original);
    await vscode.workspace.applyEdit(edit);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    qmlApi().setImportRootForTests(undefined);
  });

  const diagnostics = (): vscode.Diagnostic[] => vscode.languages.getDiagnostics(doc.uri);

  test('completion offers a Silica stand-in type and members of the type', async () => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, BODY);
    const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(labels.includes('Label'), 'Label');
    assert.ok(labels.includes('allowedOrientations'), 'allowedOrientations');
  });

  test('hover on a type shows where it comes from', async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(3, 1));
    const text = hovers.flatMap((h) => h.contents).map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
    assert.ok(text.includes('Sailfish.Silica'), text);
  });

  test('an unknown type is reported and turning the setting off clears it', async function () {
    this.timeout(15000);
    await waitFor(() => diagnostics().some((d) => d.message.includes('Lable')), 5000);
    assert.deepStrictEqual(diagnostics().map((d) => d.message), ['Unknown type "Lable"']);
    const config = vscode.workspace.getConfiguration('sailfish', doc.uri);
    await config.update('qml.languageFeatures', false, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => diagnostics().length === 0, 5000);
    } finally {
      await config.update('qml.languageFeatures', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
