import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { Services } from '../core/services';
import type { SfdkDeviceInfo } from '../core/types';
import { deviceSessions } from '../core/deviceSessions';
import { sfdkDeviceName } from '../devices/listParsing';
import type { Reachability } from '../devices/reachability';
import { scopeFolder } from '../targets/statusBar';
import { buildRows, type BuildRow } from './buildViewCore';
import { buildState } from './buildStateCore';

/** The first `*.pro` in the project folder (the one named after the folder wins). */
export function findProFile(folderPath: string, folderName: string): string | undefined {
  try {
    const pros = fs.readdirSync(folderPath).filter((f) => f.endsWith('.pro')).sort();
    return pros.find((f) => f === `${folderName}.pro`) ?? pros[0];
  } catch {
    return undefined;
  }
}

class BuildRowItem extends vscode.TreeItem {
  constructor(public readonly row: BuildRow) {
    super(row.label, vscode.TreeItemCollapsibleState.None);
    this.id = row.id;
    this.description = row.description;
    this.tooltip = row.tooltip;
    this.contextValue = `build-${row.id}`;
    this.iconPath = new vscode.ThemeIcon(row.icon, row.color ? new vscode.ThemeColor(row.color) : undefined);
    if (row.command) this.command = { command: row.command, title: row.label };
  }
}

/** The "Build" view: the state a build uses (target, device, type, deploy, signing) and the last build's result. */
export class BuildTreeDataProvider implements vscode.TreeDataProvider<BuildRowItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private registeredDevices: Map<string, Reachability> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly services: Services) {
    const refresh = (): void => this.emitter.fire();
    this.subscriptions = [
      services.projects.onDidChange(refresh),
      deviceSessions.onDidChange(refresh),
      vscode.window.onDidChangeActiveTextEditor(refresh),
      buildState.onDidChange(() => {
        this.syncTicker();
        refresh();
      }),
      ...(['target', 'device', 'build.type', 'deploy.method', 'build.sign'] as const).map((key) => services.settings.onDidChange(key, refresh)),
    ];
  }

  /** The elapsed time of a running build is re-rendered once a second. */
  private syncTicker(): void {
    if (buildState.running && !this.ticker) {
      this.ticker = setInterval(() => this.emitter.fire(), 1000);
    } else if (!buildState.running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  /** Re-checks the selected device whenever the Devices view reloads its lists (same source as the status bar). */
  watchDevices(devices: {
    listInstalledForPick(): Promise<SfdkDeviceInfo[]>;
    reachabilityOf(device: SfdkDeviceInfo): Reachability;
    onDidReloadLists: vscode.Event<unknown>;
  }): vscode.Disposable {
    const load = async (): Promise<void> => {
      const installed = await devices.listInstalledForPick();
      this.registeredDevices = new Map(installed.map((d) => [sfdkDeviceName(d), devices.reachabilityOf(d)]));
      this.emitter.fire();
    };
    void load();
    return devices.onDidReloadLists(() => void load());
  }

  getTreeItem(element: BuildRowItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BuildRowItem): BuildRowItem[] {
    if (element) return [];
    const folder = scopeFolder(this.services);
    if (!folder) return [];
    const uri = folder.uri;
    const settings = this.services.settings;
    return buildRows({
      projectName: folder.name,
      proFile: findProFile(uri.fsPath, folder.name),
      target: settings.get('target', uri),
      device: settings.get('device', uri),
      registeredDevices: this.registeredDevices,
      buildType: settings.get('build.type', uri),
      deployMethod: settings.get('deploy.method', uri),
      sign: settings.get('build.sign', uri),
      snapshot: buildState.snapshot(),
      now: Date.now(),
    }).map((row) => new BuildRowItem(row));
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.emitter.dispose();
    for (const sub of this.subscriptions) sub.dispose();
  }
}

/** Registers the `sardina.build` view; `devices` feeds the device row's reachability. */
export function activateBuildView(
  ctx: vscode.ExtensionContext,
  services: Services,
  devices: Parameters<BuildTreeDataProvider['watchDevices']>[0],
): BuildTreeDataProvider {
  const provider = new BuildTreeDataProvider(services);
  ctx.subscriptions.push(provider, provider.watchDevices(devices), vscode.window.registerTreeDataProvider('sardina.build', provider));
  return provider;
}
