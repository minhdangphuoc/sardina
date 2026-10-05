import * as vscode from 'vscode';
import type { Services } from '../core/services';
import type { SfdkDeviceInfo } from '../core/types';
import { sfdkDeviceName } from '../devices/listParsing';
import type { Reachability } from '../devices/reachability';
import { scopeFolder } from '../targets/statusBar';
import {
  BUILD_TYPES,
  DEPLOY_METHODS,
  buildTypeText,
  deployMethodLabel,
  deployMethodText,
  deviceText,
  type BuildType,
  type DeployMethod,
} from './buildConfig';

/**
 * Device, build type and deploy method selectors, shown to the right of the target
 * item (priority 100) in the same order as Qt Creator's kit / build / deploy selectors,
 * followed by Build / Deploy / Run / Debug action buttons.
 */
export class BuildConfigStatusBar {
  private readonly device = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private readonly buildType = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  private readonly deployMethod = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  private readonly actions = [
    actionItem(95, '$(tools)', 'sailfish.build', 'Sailfish: Build'),
    actionItem(94, '$(package) Deploy', 'sailfish.deploy', 'Sailfish: Build & Deploy to the device, without launching'),
    actionItem(93, '$(play) Run', 'sailfish.buildDeployRun', 'Sailfish: Build, Deploy & Run (Ctrl+Alt+R). To launch without rebuilding: "Sailfish: Run Installed App"'),
    actionItem(92, '$(debug-alt) Debug', 'sailfish.debugOnDevice', 'Sailfish: Build, Deploy & Debug on the device. To debug without rebuilding: "Sailfish: Debug Installed App"'),
  ];

  /** Names `-c device=` accepts -> connected/offline, from the Devices view's last list load; undefined until loaded. */
  private registeredDevices: Map<string, Reachability> | undefined;

  constructor(private readonly services: Services) {
    this.device.command = 'sailfish.device.setDefault';
    this.buildType.command = 'sailfish.selectBuildType';
    this.deployMethod.command = 'sailfish.selectDeployMethod';
  }

  refresh(): void {
    const items = [this.device, this.buildType, this.deployMethod, ...this.actions];
    if (this.services.contextKeys.get('sailfish.isProject') !== true) {
      for (const item of items) item.hide();
      return;
    }
    const folderUri = scopeFolder(this.services)?.uri;
    const device = this.services.settings.get('device', folderUri);
    const buildType = this.services.settings.get('build.type', folderUri);
    const method = this.services.settings.get('deploy.method', folderUri);

    const unregistered = !!device && this.registeredDevices !== undefined && !this.registeredDevices.has(device);
    const offline = !!device && this.registeredDevices?.get(device) === 'offline';
    this.device.text = unregistered ? `$(warning) ${device}` : offline ? `${deviceText(device)} (offline)` : deviceText(device);
    this.device.tooltip = unregistered
      ? `Sailfish: "${device}" is not registered with the SDK (missing from \`sfdk device list\`). Click to pick another device.`
      : offline
        ? `Sailfish: "${device}" is registered but not reachable (unplugged, asleep, or another network). Click to change.`
        : device
        ? `Sailfish: deploy device "${device}" (click to change)`
        : 'Sailfish: select a deploy device';
    this.device.backgroundColor = unregistered ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.buildType.text = buildTypeText(buildType);
    this.buildType.tooltip = 'Sailfish: build type (click to change)';
    this.deployMethod.text = deployMethodText(method);
    this.deployMethod.tooltip = `Sailfish: ${deployMethodLabel(method)} (click to change)`;
    for (const item of items) item.show();
  }

  /** Re-checks the selected device against the SDK whenever the Devices view reloads its lists. */
  watchDevices(devices: {
    listInstalledForPick(): Promise<SfdkDeviceInfo[]>;
    reachabilityOf(device: SfdkDeviceInfo): Reachability;
    onDidChangeTreeData: vscode.Event<unknown>;
  }): vscode.Disposable {
    const load = async (): Promise<void> => {
      const installed = await devices.listInstalledForPick();
      this.registeredDevices = new Map(installed.map((d) => [sfdkDeviceName(d), devices.reachabilityOf(d)]));
      this.refresh();
    };
    void load();
    return devices.onDidChangeTreeData(() => void load());
  }

  dispose(): void {
    for (const item of [this.device, this.buildType, this.deployMethod, ...this.actions]) item.dispose();
  }
}

function actionItem(priority: number, text: string, command: string, tooltip: string): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
  item.text = text;
  item.command = command;
  item.tooltip = tooltip;
  return item;
}

/** Saves a selector choice next to `sailfish.target`: the active project's folder settings. */
async function saveFolderSetting(services: Services, key: 'build.type' | 'deploy.method', value: string): Promise<void> {
  const folder = scopeFolder(services) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void services.prompts.showWarningMessage('Sailfish: no workspace folder to save the setting to');
    return;
  }
  await vscode.workspace.getConfiguration('sailfish', folder.uri).update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
}

async function pick<T extends string>(
  services: Services,
  choices: ReadonlyArray<{ value: T; label: string; description: string }>,
  current: T,
  placeHolder: string,
): Promise<T | undefined> {
  const items = choices.map((c) => ({
    label: c.value === current ? `$(check) ${c.label}` : c.label,
    description: c.description,
    value: c.value,
  }));
  const picked = await services.prompts.showQuickPick(items, { placeHolder });
  return picked?.value;
}

export function activateBuildConfigStatusBar(ctx: vscode.ExtensionContext, services: Services): BuildConfigStatusBar {
  const statusBar = new BuildConfigStatusBar(services);
  ctx.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand('sailfish.selectBuildType', async () => {
      const current = services.settings.get('build.type', scopeFolder(services)?.uri);
      const value = await pick<BuildType>(services, BUILD_TYPES, current, 'Select the build type');
      if (value) await saveFolderSetting(services, 'build.type', value);
    }),
    vscode.commands.registerCommand('sailfish.selectDeployMethod', async () => {
      const current = services.settings.get('deploy.method', scopeFolder(services)?.uri);
      const value = await pick<DeployMethod>(services, DEPLOY_METHODS, current, 'Select how to deploy to the device');
      if (value) await saveFolderSetting(services, 'deploy.method', value);
    }),
    services.projects.onDidChange(() => statusBar.refresh()),
    services.settings.onDidChange('device', () => statusBar.refresh()),
    services.settings.onDidChange('build.type', () => statusBar.refresh()),
    services.settings.onDidChange('deploy.method', () => statusBar.refresh()),
    vscode.window.onDidChangeActiveTextEditor(() => statusBar.refresh()),
  );
  statusBar.refresh();
  return statusBar;
}
