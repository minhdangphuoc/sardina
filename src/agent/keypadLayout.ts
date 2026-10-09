import * as vscode from 'vscode';
import type { Services } from '../core/services';
import {
  buildDefaultKeypadLayout,
  keypadLayoutFileName,
  parseKeypadLayout,
  validateKeypadLayout,
  ErrorReporter,
  SharedResources,
  type KeypadInfo,
  type KeypadLayout,
  type ResolvedKeypadLayout,
} from './keypadLayoutCore';

const STATE_PREFIX = 'sailfish.keypadLayout.';
const DISMISSED_PREFIX = 'sailfish.keypadHintDismissed.';
const OVERWRITE = 'Overwrite';

export class KeypadLayouts implements vscode.Disposable {
  private readonly logged = new Set<string>();
  private readonly changed = new vscode.EventEmitter<string>();
  private readonly watches = new SharedResources();
  private readonly lastValid = new Map<string, KeypadLayout>();
  private readonly reporters = new Map<string, ErrorReporter>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly services: Services,
  ) {}

  configured(model: string): boolean {
    return this.layoutUri(model) !== undefined;
  }

  hintDismissed(model: string): boolean {
    return this.ctx.workspaceState.get<boolean>(`${DISMISSED_PREFIX}${model}`) === true;
  }

  async resolve(info: KeypadInfo): Promise<ResolvedKeypadLayout> {
    const uri = this.layoutUri(info.model);
    if (!uri) return { configured: false };
    this.watch(info.model, uri);
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      return { configured: true, layout: this.accept(info, uri.fsPath, this.validated(text, info, uri.fsPath)) };
    } catch (err) {
      if (this.notFound(err)) {
        this.lastValid.delete(info.model);
        this.reporter(info.model).shouldReport(undefined);
        return { configured: true, missing: true };
      }
      return { configured: true, layout: this.accept(info, uri.fsPath, { error: this.message(err) }) };
    }
  }

  /** Opens the remembered layout, or creates a starter when this model has none. */
  async edit(info: KeypadInfo): Promise<boolean> {
    await this.ctx.workspaceState.update(`${DISMISSED_PREFIX}${info.model}`, true);
    const uri = this.layoutUri(info.model);
    if (!uri) return this.create(info);
    try {
      await vscode.workspace.fs.stat(uri);
      await this.open(uri);
      return false;
    } catch (err) {
      if (this.notFound(err)) return this.create(info);
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
    this.watches.dispose();
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
    try {
      const existing = await this.existing(uri, info);
      if (existing === 'invalid' && !await this.confirmOverwrite(uri)) return false;
      await this.remember(info.model, uri);
      if (existing !== 'valid') {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(buildDefaultKeypadLayout(info), null, 2)}\n`, 'utf8'));
      }
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

  /** A picked file that already holds a valid layout is adopted as is. */
  private async existing(uri: vscode.Uri, info: KeypadInfo): Promise<'absent' | 'valid' | 'invalid'> {
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch (err) {
      if (this.notFound(err)) return 'absent';
      throw err;
    }
    return this.validated(text, info, uri.fsPath).layout ? 'valid' : 'invalid';
  }

  private async confirmOverwrite(uri: vscode.Uri): Promise<boolean> {
    const choice = await this.services.prompts.showWarningMessage(
      `Sailfish: ${uri.fsPath} is not a valid keypad layout. Overwrite it with a starter?`,
      { modal: true },
      OVERWRITE,
    );
    return choice === OVERWRITE;
  }

  /** Watches before the first write so the save is never missed. */
  private async remember(model: string, uri: vscode.Uri): Promise<void> {
    this.watch(model, uri);
    await this.ctx.workspaceState.update(this.stateKey(model), uri.toString());
  }

  private async open(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async forget(model: string): Promise<void> {
    await this.ctx.workspaceState.update(this.stateKey(model), undefined);
    this.watches.release(model);
    this.lastValid.delete(model);
    this.reporter(model).shouldReport(undefined);
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

  private validated(text: string, info: KeypadInfo, source: string): { layout?: KeypadLayout; error?: string } {
    const parsed = parseKeypadLayout(text);
    if (parsed.error) return { error: parsed.error };
    const checked = validateKeypadLayout(parsed.value, info.keys, info.model);
    this.logWarnings(source, checked.warnings);
    return checked.layout ? { layout: checked.layout } : { error: checked.errors.join('; ') };
  }

  /** A broken edit keeps the last valid layout on screen and is reported once. */
  private accept(info: KeypadInfo, source: string, result: { layout?: KeypadLayout; error?: string }): KeypadLayout | undefined {
    const { model } = info;
    if (this.reporter(model).shouldReport(result.error)) {
      this.services.output.log('warn', `keypad layout ${source}: ${result.error}`);
      void this.services.prompts.showErrorMessage(`Sailfish: keypad layout ${source} is invalid: ${result.error}`);
    }
    if (result.layout) this.lastValid.set(model, result.layout);
    return result.layout ?? this.lastValid.get(model);
  }

  private reporter(model: string): ErrorReporter {
    let reporter = this.reporters.get(model);
    if (!reporter) {
      reporter = new ErrorReporter();
      this.reporters.set(model, reporter);
    }
    return reporter;
  }

  private watch(model: string, uri: vscode.Uri): void {
    const key = uri.toString();
    this.watches.acquire(model, key, () => {
      const slash = uri.path.lastIndexOf('/');
      const dir = uri.with({ path: slash > 0 ? uri.path.slice(0, slash) : '/', query: '', fragment: '' });
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, uri.path.slice(slash + 1)));
      const fire = (): void => { for (const owner of this.watches.owners(key)) this.changed.fire(owner); };
      const subscriptions = [watcher, watcher.onDidChange(fire), watcher.onDidCreate(fire), watcher.onDidDelete(fire)];
      return () => { for (const d of subscriptions) d.dispose(); };
    });
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
