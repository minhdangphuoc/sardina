import * as vscode from 'vscode';
import type { Services } from '../core/services';
import {
  buildDefaultKeypadLayout,
  keypadLayoutFileName,
  parseKeypadLayout,
  validateKeypadLayout,
  type KeypadInfo,
  type KeypadLayout,
} from './keypadLayoutCore';

export interface ResolvedKeypadLayout {
  configured: boolean;
  layout?: KeypadLayout;
}

interface LayoutWatch {
  uri: vscode.Uri;
  disposables: vscode.Disposable[];
}

const STATE_PREFIX = 'sailfish.keypadLayout.';

export class KeypadLayouts implements vscode.Disposable {
  private readonly logged = new Set<string>();
  private readonly changed = new vscode.EventEmitter<string>();
  private readonly watches = new Map<string, LayoutWatch>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly services: Services,
  ) {}

  configured(model: string): boolean {
    return this.layoutUri(model) !== undefined;
  }

  async resolve(info: KeypadInfo): Promise<ResolvedKeypadLayout> {
    const uri = this.layoutUri(info.model);
    if (!uri) return { configured: false };
    this.watch(info.model, uri);
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      return { configured: true, layout: this.validated(text, info, uri.fsPath) };
    } catch (err) {
      if (this.notFound(err)) {
        await this.forget(info.model);
        return { configured: false };
      }
      this.logOnce(`${uri.toString()}:read:${this.message(err)}`, `keypad layout ${uri.fsPath}: ${this.message(err)}; keypad hidden`);
      return { configured: true };
    }
  }

  /** Opens the remembered layout, or creates a starter when this model has none. */
  async edit(info: KeypadInfo): Promise<boolean> {
    const uri = this.layoutUri(info.model);
    if (!uri) return this.create(info);
    try {
      await vscode.workspace.fs.stat(uri);
      await this.open(uri);
      return false;
    } catch (err) {
      if (this.notFound(err)) {
        await this.forget(info.model);
        return this.create(info);
      }
      await this.services.prompts.showErrorMessage(`Sailfish: keypad layout could not be opened: ${this.message(err)}`);
      return false;
    }
  }

  /** Forgets the association without deleting the user's file. */
  async reset(info: KeypadInfo): Promise<boolean> {
    if (!this.configured(info.model)) return false;
    await this.forget(info.model);
    await this.services.prompts.showInformationMessage(`Sailfish: keypad layout reset for ${info.model}; the file was not deleted`);
    return true;
  }

  dispose(): void {
    for (const watch of this.watches.values()) this.disposeWatch(watch);
    this.watches.clear();
    this.changed.dispose();
  }

  private async create(info: KeypadInfo): Promise<boolean> {
    const dir = this.defaultDir();
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch (err) {
      await this.services.prompts.showErrorMessage(`Sailfish: keypad layout could not be created: ${this.message(err)}`);
      return false;
    }
    const uri = await this.services.prompts.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(dir, keypadLayoutFileName(info.model)),
      filters: { 'Keypad layout': ['json'] },
      saveLabel: 'Create Keypad Layout',
    });
    if (!uri) return false;
    const starter = `${JSON.stringify(buildDefaultKeypadLayout(info), null, 2)}\n`;
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(starter, 'utf8'));
      await this.ctx.workspaceState.update(this.stateKey(info.model), uri.toString());
      this.watch(info.model, uri);
    } catch (err) {
      await this.services.prompts.showErrorMessage(`Sailfish: keypad layout could not be created: ${this.message(err)}`);
      return false;
    }
    try {
      await this.open(uri);
    } catch (err) {
      await this.services.prompts.showErrorMessage(`Sailfish: keypad layout was created but could not be opened: ${this.message(err)}`);
    }
    return true;
  }

  private async open(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async forget(model: string): Promise<void> {
    await this.ctx.workspaceState.update(this.stateKey(model), undefined);
    const watch = this.watches.get(model);
    if (watch) this.disposeWatch(watch);
    this.watches.delete(model);
  }

  private stateKey(model: string): string {
    return `${STATE_PREFIX}${model}`;
  }

  private layoutUri(model: string): vscode.Uri | undefined {
    const raw = this.ctx.workspaceState.get<string>(this.stateKey(model));
    if (!raw) return undefined;
    try {
      return vscode.Uri.parse(raw, true);
    } catch {
      return undefined;
    }
  }

  private defaultDir(): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    return root
      ? vscode.Uri.joinPath(root, '.sailfish', 'keypads')
      : vscode.Uri.joinPath(this.ctx.globalStorageUri, 'keypads');
  }

  private validated(text: string, info: KeypadInfo, source: string): KeypadLayout | undefined {
    const parsed = parseKeypadLayout(text);
    if (parsed.error) {
      this.logOnce(`${source}:parse:${parsed.error}`, `keypad layout ${source}: ${parsed.error}; keypad hidden`);
      return undefined;
    }
    const checked = validateKeypadLayout(parsed.value, info.keys, info.model);
    this.logWarnings(source, checked.warnings);
    if (!checked.layout) {
      this.logOnce(`${source}:invalid:${checked.errors.join('|')}`, `keypad layout ${source}: ${checked.errors.join('; ')}; keypad hidden`);
    }
    return checked.layout;
  }

  private watch(model: string, uri: vscode.Uri): void {
    const current = this.watches.get(model);
    if (current?.uri.toString() === uri.toString()) return;
    if (current) this.disposeWatch(current);
    const slash = uri.path.lastIndexOf('/');
    const dir = uri.with({ path: slash > 0 ? uri.path.slice(0, slash) : '/', query: '', fragment: '' });
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '*'));
    const changed = (candidate: vscode.Uri): void => {
      if (candidate.toString() === uri.toString()) this.changed.fire(model);
    };
    this.watches.set(model, {
      uri,
      disposables: [watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed)],
    });
  }

  private disposeWatch(watch: LayoutWatch): void {
    for (const disposable of watch.disposables) disposable.dispose();
  }

  private logWarnings(source: string, warnings: readonly string[]): void {
    for (const warning of warnings) this.logOnce(`${source}:${warning}`, `keypad layout ${source}: ${warning}`);
  }

  private logOnce(key: string, message: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.services.output.log('warn', message);
  }

  private message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private notFound(err: unknown): boolean {
    return err instanceof vscode.FileSystemError && err.code === 'FileNotFound';
  }
}
