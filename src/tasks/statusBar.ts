import * as vscode from 'vscode';
import { deviceSessions } from '../core/deviceSessions';
import type { Services } from '../core/services';
import type { SfdkDeviceInfo } from '../core/types';
import { sfdkDeviceName } from '../devices/listParsing';
import type { Reachability } from '../devices/reachability';
import { scopeFolder } from '../targets/statusBar';
import {
  BUILD_TYPES,
  DEBUG_LANGUAGES,
  DEPLOY_METHODS,
  buildTypeText,
  debugLanguageCommand,
  debugLanguageText,
  deployMethodLabel,
  deployMethodText,
  debugActionText,
  deviceTextWithSessions,
  sessionTooltip,
  type BuildType,
  type DebugLanguage,
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
  private readonly debugLanguage = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 92);
  private readonly debugAction = actionItem(91, '$(debug-alt) Debug', 'sardina.debugSelected', 'Sardina: Build, Deploy & Debug using the selected language');
  private readonly actions = [
    actionItem(95, '$(tools)', 'sardina.build', 'Sardina: Build'),
    actionItem(94, '$(package) Deploy', 'sardina.deploy', 'Sardina: Build & Deploy to the device, without launching'),
    actionItem(93, '$(play) Run', 'sardina.buildDeployRun', 'Sardina: Build, Deploy & Run (Ctrl+Alt+R). To launch without rebuilding: "Sardina: Run Installed App"'),
    this.debugLanguage,
    this.debugAction,
  ];

  /** Names `-c device=` accepts -> connected/offline, from the Devices view's last list load; undefined until loaded. */
  private registeredDevices: Map<string, Reachability> | undefined;

  constructor(private readonly services: Services) {
    this.device.command = 'sardina.device.setDefault';
    this.buildType.command = 'sardina.selectBuildType';
    this.deployMethod.command = 'sardina.selectDeployMethod';
    this.debugLanguage.command = 'sardina.selectDebugLanguage';
  }

  refresh(): void {
    const items = [this.device, this.buildType, this.deployMethod, ...this.actions];
    if (this.services.contextKeys.get('sardina.isProject') !== true) {
      for (const item of items) item.hide();
      return;
    }
    const folderUri = scopeFolder(this.services)?.uri;
    const device = this.services.settings.get('device', folderUri);
    const buildType = this.services.settings.get('build.type', folderUri);
    const method = this.services.settings.get('deploy.method', folderUri);
    const debugLanguage = this.services.settings.get('debug.language', folderUri);

    const unregistered = !!device && this.registeredDevices !== undefined && !this.registeredDevices.has(device);
    const offline = !!device && this.registeredDevices?.get(device) === 'offline';
    const sessions = device ? deviceSessions.activeFor(device) : [];
    const debugging = sessions.some((x) => x.kind === 'debug');
    const base = deviceTextWithSessions(device, sessions);
    this.device.text = unregistered ? `$(warning) ${device}` : offline ? `${base} (offline)` : base;
    const baseTooltip = unregistered
      ? `Sardina: "${device}" is not registered with the SDK (missing from \`sfdk device list\`). Click to pick another device.`
      : offline
        ? `Sardina: "${device}" is registered but not reachable (unplugged, asleep, or another network). Click to change.`
        : device
        ? `Sardina: deploy device "${device}" (click to change)`
        : 'Sardina: select a deploy device';
    const stopHint = sessionTooltip(device, sessions);
    this.device.tooltip = deviceTooltip(baseTooltip, stopHint, !!device && !unregistered);
    this.device.backgroundColor = unregistered || debugging ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.debugAction.text = debugActionText(sessions);
    this.buildType.text = buildTypeText(buildType);
    this.buildType.tooltip = 'Sardina: build configuration (click to change)';
    this.deployMethod.text = deployMethodText(method);
    this.deployMethod.tooltip = `Sardina: ${deployMethodLabel(method)} (click to change)`;
    this.debugLanguage.text = debugLanguageText(debugLanguage);
    this.debugLanguage.tooltip = `Sardina: ${debugLanguage === 'qml' ? 'QML/JavaScript' : 'C++'} debugger (click to change)`;
    this.debugAction.tooltip = `Sardina: Build, Deploy & Debug using ${debugLanguage === 'qml' ? 'QML/JavaScript' : 'C++'}`;
    for (const item of items) item.show();
  }

  /** Re-checks the selected device against the SDK whenever the Devices view reloads its lists (not on session-only re-renders, which must not run sfdk). */
  watchDevices(devices: {
    listInstalledForPick(): Promise<SfdkDeviceInfo[]>;
    reachabilityOf(device: SfdkDeviceInfo): Reachability;
    onDidReloadLists: vscode.Event<unknown>;
  }): vscode.Disposable {
    const load = async (): Promise<void> => {
      const installed = await devices.listInstalledForPick();
      this.registeredDevices = new Map(installed.map((d) => [sfdkDeviceName(d), devices.reachabilityOf(d)]));
      this.refresh();
    };
    void load();
    return devices.onDidReloadLists(() => void load());
  }

  dispose(): void {
    for (const item of [this.device, this.buildType, this.deployMethod, ...this.actions]) item.dispose();
  }
}

/** The device item's tooltip: the existing text, plus a link to the Device Monitor (a trusted command link) for a registered device. */
function deviceTooltip(base: string, stopHint: string | undefined, withMonitorLink: boolean): string | vscode.MarkdownString {
  const text = stopHint ? `${base}\n\n${stopHint}` : base;
  if (!withMonitorLink) return text;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['sardina.monitor.open'] };
  md.appendText(text);
  md.appendMarkdown('\n\n[Open Device Monitor](command:sardina.monitor.open)');
  return md;
}

function actionItem(priority: number, text: string, command: string, tooltip: string): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
  item.text = text;
  item.command = command;
  item.tooltip = tooltip;
  return item;
}

/** Saves a selector choice next to `sardina.target`: the active project's folder settings. */
async function saveFolderSetting(services: Services, key: 'build.type' | 'deploy.method' | 'debug.language', value: string): Promise<void> {
  const folder = scopeFolder(services) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void services.prompts.showWarningMessage('Sardina: no workspace folder to save the setting to');
    return;
  }
  await vscode.workspace.getConfiguration('sardina', folder.uri).update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
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
    vscode.commands.registerCommand('sardina.selectBuildType', async () => {
      const current = services.settings.get('build.type', scopeFolder(services)?.uri);
      const value = await pick<BuildType>(services, BUILD_TYPES, current, 'Select the build type');
      if (value) await saveFolderSetting(services, 'build.type', value);
    }),
    vscode.commands.registerCommand('sardina.selectDeployMethod', async () => {
      const current = services.settings.get('deploy.method', scopeFolder(services)?.uri);
      const value = await pick<DeployMethod>(services, DEPLOY_METHODS, current, 'Select how to deploy to the device');
      if (value) await saveFolderSetting(services, 'deploy.method', value);
    }),
    vscode.commands.registerCommand('sardina.selectDebugLanguage', async () => {
      const current = services.settings.get('debug.language', scopeFolder(services)?.uri);
      const value = await pick<DebugLanguage>(services, DEBUG_LANGUAGES, current, 'Select the toolbar debugger');
      if (value) await saveFolderSetting(services, 'debug.language', value);
    }),
    vscode.commands.registerCommand('sardina.debugSelected', () => {
      const language = services.settings.get('debug.language', scopeFolder(services)?.uri);
      return vscode.commands.executeCommand(debugLanguageCommand(language));
    }),
    vscode.commands.registerCommand('sardina.debugSelectedInstalled', () => {
      const language = services.settings.get('debug.language', scopeFolder(services)?.uri);
      return vscode.commands.executeCommand(language === 'qml' ? 'sardina.debugQmlInstalled' : 'sardina.debugInstalled');
    }),
    services.projects.onDidChange(() => statusBar.refresh()),
    deviceSessions.onDidChange(() => statusBar.refresh()),
    services.settings.onDidChange('device', () => statusBar.refresh()),
    services.settings.onDidChange('build.type', () => statusBar.refresh()),
    services.settings.onDidChange('deploy.method', () => statusBar.refresh()),
    services.settings.onDidChange('debug.language', () => statusBar.refresh()),
    vscode.window.onDidChangeActiveTextEditor(() => statusBar.refresh()),
  );
  statusBar.refresh();
  return statusBar;
}
