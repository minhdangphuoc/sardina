import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Services } from '../core/services';
import {
  type Completion,
  type CompletionKind,
  type FeatureEnv,
  completionsAt,
  diagnose,
  hoverAt,
} from './features';
import { fsIndexIO } from './fsIO';
import { importRootFor } from './importRoot';
import { parseQmlOutline, toComponentOutline } from './qmlOutline';
import { TypeIndex } from './typeIndex';

const SELECTOR: vscode.DocumentSelector = { language: 'qml', scheme: 'file' };
const DIAGNOSTIC_DELAY_MS = 300;

const ITEM_KINDS: Record<CompletionKind, vscode.CompletionItemKind> = {
  type: vscode.CompletionItemKind.Class,
  property: vscode.CompletionItemKind.Property,
  signal: vscode.CompletionItemKind.Event,
  method: vscode.CompletionItemKind.Method,
  enum: vscode.CompletionItemKind.EnumMember,
  module: vscode.CompletionItemKind.Module,
  version: vscode.CompletionItemKind.Value,
  keyword: vscode.CompletionItemKind.Keyword,
  id: vscode.CompletionItemKind.Variable,
};

export interface QmlFeaturesTestApi {
  /** Replaces the import root taken from the build target. */
  setImportRootForTests(root: string | undefined): void;
}

/** Import root of the folder's build target; without a chosen target, the first installed one. */
function targetImportRoot(services: Services, folder: vscode.WorkspaceFolder): string | undefined {
  const sdkRoot = services.sdk.current()?.root;
  if (!sdkRoot) return undefined;
  const chosen = services.settings.get('target', folder.uri);
  const installed = chosen ? [chosen] : listTargets(sdkRoot);
  for (const target of installed) {
    const root = importRootFor(sdkRoot, target, fs.existsSync);
    if (root) return root;
  }
  return undefined;
}

function listTargets(sdkRoot: string): string[] {
  try {
    return fs.readdirSync(path.join(sdkRoot, 'mersdk', 'targets')).sort();
  } catch {
    return [];
  }
}

function toItem(c: Completion): vscode.CompletionItem {
  const item = new vscode.CompletionItem(c.label, ITEM_KINDS[c.kind]);
  item.detail = c.detail;
  return item;
}

class QmlFeatures {
  private readonly indexes = new Map<string, TypeIndex>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('sardina-qml');
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private testRoot: string | undefined;

  constructor(private readonly services: Services) {}

  setImportRootForTests(root: string | undefined): void {
    this.testRoot = root;
    this.reset();
  }

  /** Drops what was read from the old target and checks every open file again. */
  reset(): void {
    this.indexes.clear();
    for (const doc of vscode.workspace.textDocuments) this.refreshDiagnostics(doc);
  }

  register(ctx: vscode.ExtensionContext): void {
    const subs = ctx.subscriptions;
    subs.push(this.diagnostics);
    subs.push(vscode.languages.registerCompletionItemProvider(SELECTOR, { provideCompletionItems: (d, p, _t, c) => this.complete(d, p, c) }, '.', ' '));
    subs.push(vscode.languages.registerHoverProvider(SELECTOR, { provideHover: (d, p) => this.hover(d, p) }));
    subs.push(vscode.workspace.onDidOpenTextDocument((d) => this.refreshDiagnostics(d)));
    subs.push(vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)));
    subs.push(vscode.workspace.onDidCloseTextDocument((d) => this.diagnostics.delete(d.uri)));
    subs.push(this.services.sdk.onDidChange(() => this.reset()));
    subs.push(this.services.projects.onDidChange(() => this.reset()));
    subs.push(this.services.settings.onDidChange('target', () => this.reset()));
    subs.push(this.services.settings.onDidChange('qml.languageFeatures', () => this.reset()));
    subs.push({ dispose: () => this.timers.forEach(clearTimeout) });
    this.reset();
  }

  private indexFor(doc: vscode.TextDocument): TypeIndex | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder || !this.services.projects.forFolder(folder)) return undefined;
    if (!this.services.settings.get('qml.languageFeatures', doc.uri)) return undefined;
    const root = this.testRoot ?? targetImportRoot(this.services, folder);
    if (!root) return undefined;
    let index = this.indexes.get(root);
    if (!index) {
      index = new TypeIndex(fsIndexIO, root, { parseComponent: (t) => toComponentOutline(parseQmlOutline(t)) });
      this.indexes.set(root, index);
      this.services.output.log('debug', `QML import root: ${root}`);
    }
    return index;
  }

  private envFor(doc: vscode.TextDocument): FeatureEnv | undefined {
    const index = this.indexFor(doc);
    if (!index) return undefined;
    const text = doc.getText();
    return { index, text, outline: parseQmlOutline(text), dir: path.dirname(doc.uri.fsPath) };
  }

  private async complete(doc: vscode.TextDocument, pos: vscode.Position, ctx: vscode.CompletionContext): Promise<vscode.CompletionItem[]> {
    const spaceOutsideImport = ctx.triggerCharacter === ' ' && !/^\s*import\s/.test(doc.lineAt(pos.line).text);
    const env = spaceOutsideImport ? undefined : this.envFor(doc);
    return env ? (await completionsAt(env, doc.offsetAt(pos))).map(toItem) : [];
  }

  private async hover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const env = this.envFor(doc);
    const found = env && (await hoverAt(env, doc.offsetAt(pos)));
    if (!found) return undefined;
    const range = new vscode.Range(doc.positionAt(found.start), doc.positionAt(found.end));
    return new vscode.Hover(new vscode.MarkdownString(found.markdown), range);
  }

  private schedule(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => this.refreshDiagnostics(doc), DIAGNOSTIC_DELAY_MS));
  }

  private refreshDiagnostics(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'qml' || doc.uri.scheme !== 'file') return;
    const env = this.envFor(doc);
    if (!env) {
      this.diagnostics.delete(doc.uri);
      return;
    }
    const version = doc.version;
    diagnose(env).then(
      (problems) => {
        if (doc.version !== version) return;
        this.diagnostics.set(
          doc.uri,
          problems.map((p) => new vscode.Diagnostic(new vscode.Range(doc.positionAt(p.start), doc.positionAt(p.end)), p.message, vscode.DiagnosticSeverity.Error)),
        );
      },
      (err: unknown) => this.services.output.log('warn', `QML diagnostics failed: ${String(err)}`),
    );
  }
}

/** Completion, hover and diagnostics for QML in Sailfish OS projects, read from the build target. */
export function activateQmlFeatures(ctx: vscode.ExtensionContext, services: Services): QmlFeaturesTestApi {
  const features = new QmlFeatures(services);
  features.register(ctx);
  return { setImportRootForTests: (root) => features.setImportRootForTests(root) };
}
