import * as vscode from 'vscode';
import type { Services } from '../core/services';
import { getLastTargetList, setLastTargetList } from './targetListCache';
import { parseTargetList } from './parseTargetList';
import { computeStatusBarState } from './statusBarCore';

export type { StatusBarState } from './statusBarCore';
export { computeStatusBarState } from './statusBarCore';

/** The workspace folder whose `sardina.target` this status bar reflects (mirrors contextKeys.ts's scopeFolder). */
export function scopeFolder(services: Services): vscode.WorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (folder && services.projects.forFolder(folder)) {
      return folder;
    }
  }
  const projects = services.projects.projects();
  return projects.length === 1 ? projects[0].folder : undefined;
}

/** FR-4.1 status bar item; also populates targetListCache itself so FR-4.5's warning shows before selectTarget.ts's own fetches run. */
export class TargetStatusBar {
  private readonly item: vscode.StatusBarItem;
  private fetchFailed = false;
  private fetchedOnce = false;
  private fetching = false;

  constructor(private readonly services: Services) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'sardina.selectTarget';
  }

  refresh(): void {
    const isProject = this.services.contextKeys.get('sardina.isProject') === true;
    const sdkAvailable = this.services.contextKeys.get('sardina.sdkAvailable') === true;
    const folder = scopeFolder(this.services);
    const target = this.services.settings.get('target', folder?.uri);
    const knownTargetNames = getLastTargetList()?.map((t) => t.name);

    const state = computeStatusBarState({ isProject, sdkAvailable, target, knownTargetNames });
    if (this.fetchFailed) {
      this.item.text = state.text.startsWith('$(warning)') ? state.text : `$(warning) ${state.text}`;
      this.item.tooltip = state.tooltip ?? 'Could not list sfdk targets';
    } else {
      this.item.text = state.text;
      this.item.tooltip = state.tooltip;
    }
    if (state.visible) {
      this.item.show();
      if (sdkAvailable && !this.fetchedOnce && !this.fetching) {
        this.fetchedOnce = true;
        void this.fetchTargetList();
      }
    } else {
      this.item.hide();
    }
  }

  /** M1.13: force a re-fetch of `tools target list` (SDK/target changed) then refresh the display. */
  refetch(): void {
    this.fetchedOnce = false;
    this.refresh();
  }

  /** M1.13/FR-4.5: fetched once the bar becomes visible (and again on refetch), so an unparseable/failing list still renders the bar with a $(warning) rather than crashing or staying blank. */
  private async fetchTargetList(): Promise<void> {
    this.fetching = true;
    try {
      const result = await this.services.runner.run({ args: ['tools', 'target', 'list'], ensureEngine: false });
      if (result.exitCode !== 0) {
        this.fetchFailed = true;
        return;
      }
      const parsed = parseTargetList(result.stdout);
      if (!parsed.ok) {
        this.fetchFailed = true;
        return;
      }
      this.fetchFailed = false;
      setLastTargetList(parsed.value);
    } catch {
      this.fetchFailed = true;
    } finally {
      this.fetching = false;
      this.refresh();
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
