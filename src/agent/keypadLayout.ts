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

export class KeypadLayouts {
  private readonly logged = new Set<string>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly services: Services,
  ) {}

  async resolve(info: KeypadInfo): Promise<KeypadLayout> {
    const override = this.overrideUri(info.model);
    const userText = await this.read(override);
    if (userText !== undefined) return this.validated(userText, info, override.fsPath) ?? buildDefaultKeypadLayout(info);

    const bundled = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'keypads', keypadLayoutFileName(info.model));
    const bundledText = await this.read(bundled);
    if (bundledText !== undefined) return this.validated(bundledText, info, bundled.fsPath) ?? buildDefaultKeypadLayout(info);
    return buildDefaultKeypadLayout(info);
  }

  async importLayout(info: KeypadInfo): Promise<boolean> {
    const picked = await this.services.prompts.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'Keypad layout': ['json'] },
      openLabel: 'Import Keypad Layout',
    });
    const source = picked?.[0];
    if (!source) return false;
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8');
    } catch (err) {
      await this.services.prompts.showErrorMessage(`Sailfish: keypad layout not imported: ${this.message(err)}`);
      return false;
    }
    const parsed = parseKeypadLayout(text);
    const checked = parsed.error ? { errors: [parsed.error], warnings: [] } : validateKeypadLayout(parsed.value, info.keys, info.model);
    if (!checked.layout) {
      await this.services.prompts.showErrorMessage(`Sailfish: keypad layout not imported: ${checked.errors.join('; ')}`);
      return false;
    }
    this.logWarnings(source.fsPath, checked.warnings);
    const target = this.overrideUri(info.model);
    try {
      await vscode.workspace.fs.createDirectory(this.overrideDir());
      await vscode.workspace.fs.writeFile(target, Buffer.from(`${JSON.stringify(checked.layout, null, 2)}\n`, 'utf8'));
    } catch (err) {
      await this.services.prompts.showErrorMessage(`Sailfish: keypad layout not imported: ${this.message(err)}`);
      return false;
    }
    await this.services.prompts.showInformationMessage(`Sailfish: keypad layout imported for ${info.model}`);
    return true;
  }

  async reset(info: KeypadInfo): Promise<boolean> {
    const target = this.overrideUri(info.model);
    try {
      await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false });
    } catch (err) {
      if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) {
        await this.services.prompts.showErrorMessage(`Sailfish: keypad layout was not reset: ${this.message(err)}`);
        return false;
      }
    }
    await this.services.prompts.showInformationMessage(`Sailfish: keypad layout reset for ${info.model}`);
    return true;
  }

  private overrideUri(model: string): vscode.Uri {
    return vscode.Uri.joinPath(this.overrideDir(), keypadLayoutFileName(model));
  }

  private overrideDir(): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    return root
      ? vscode.Uri.joinPath(root, '.sailfish', 'keypads')
      : vscode.Uri.joinPath(this.ctx.globalStorageUri, 'keypads');
  }

  private async read(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return undefined;
      this.logOnce(`${uri.toString()}:read`, `keypad layout ${uri.fsPath}: ${this.message(err)}; using the default layout`);
      return undefined;
    }
  }

  private validated(text: string, info: KeypadInfo, source: string): KeypadLayout | undefined {
    const parsed = parseKeypadLayout(text);
    if (parsed.error) {
      this.logOnce(`${source}:parse:${parsed.error}`, `keypad layout ${source}: ${parsed.error}; using the default layout`);
      return undefined;
    }
    const checked = validateKeypadLayout(parsed.value, info.keys, info.model);
    this.logWarnings(source, checked.warnings);
    if (!checked.layout) {
      this.logOnce(`${source}:invalid:${checked.errors.join('|')}`, `keypad layout ${source}: ${checked.errors.join('; ')}; using the default layout`);
    }
    return checked.layout;
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
}
