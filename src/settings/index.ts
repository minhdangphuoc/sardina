import * as vscode from 'vscode';
import { ConfigDispatcher } from './dispatcher';
import { DEFAULTS, type SardinaSettings } from './defaults';

export type { SardinaSettings } from './defaults';
export { DEFAULTS } from './defaults';

const SECTION = 'sardina';

type Listener = () => void;

/**
 * Single place that calls `vscode.workspace.getConfiguration('sardina')`.
 * All other modules read settings through this class (FR-14). The listener
 * fan-out itself lives in `ConfigDispatcher` (vscode-free, unit-tested).
 */
export class Settings {
  private readonly dispatcher = new ConfigDispatcher();
  private disposable: vscode.Disposable | undefined;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) {
        return;
      }
      this.dispatcher.fireWildcard();
      for (const key of this.dispatcher.keys()) {
        if (e.affectsConfiguration(`${SECTION}.${key}`)) {
          this.dispatcher.fireKey(key);
        }
      }
    });
  }

  get<K extends keyof SardinaSettings>(key: K, scope?: vscode.ConfigurationScope): SardinaSettings[K] {
    const config = vscode.workspace.getConfiguration(SECTION, scope);
    return config.get<SardinaSettings[K]>(key, DEFAULTS[key]);
  }

  onDidChange(key: keyof SardinaSettings | '*', listener: Listener): vscode.Disposable {
    return this.dispatcher.on(key, listener);
  }

  dispose(): void {
    this.disposable?.dispose();
    this.dispatcher.clear();
  }
}

export function activateSettings(ctx: vscode.ExtensionContext, services: { settings: Settings }): void {
  ctx.subscriptions.push(services.settings);
}
