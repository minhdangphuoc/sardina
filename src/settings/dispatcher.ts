export type Listener = () => void;

/**
 * vscode-free listener registry backing `Settings.onDidChange` (FR-14.3), so
 * the fan-out to per-key and `'*'` listeners has a unit test that does not
 * need a real `vscode.workspace.onDidChangeConfiguration`.
 */
export class ConfigDispatcher {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(key: string, listener: Listener): { dispose(): void } {
    const set = this.listeners.get(key) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(key, set);
    return {
      dispose: () => {
        set.delete(listener);
      },
    };
  }

  /** The specific (non-`'*'`) keys that currently have at least one listener. */
  keys(): string[] {
    return [...this.listeners.keys()].filter((k) => k !== '*');
  }

  fireWildcard(): void {
    for (const l of this.listeners.get('*') ?? []) l();
  }

  fireKey(key: string): void {
    for (const l of this.listeners.get(key) ?? []) l();
  }

  clear(): void {
    this.listeners.clear();
  }
}
