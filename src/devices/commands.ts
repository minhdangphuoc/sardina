import * as vscode from 'vscode';
import * as os from 'node:os';
import type { Services } from '../core/services';
import type { SfdkDeviceInfo } from '../core/types';
import type { SfdkResult } from '../sfdk/runner';
import { DevicesTreeDataProvider } from './tree';
import { sdkRootState } from './sdkTreeCore';
import { correlateVm } from './vmCorrelation';
import { buildSshLaunch } from './sshLaunch';
import { buildWlanSshLaunch, isValidPort } from './connectWlan';
import { addDevice, removeDevice } from './addDevice';
import { sfdkDeviceName } from './listParsing';
import { installDeviceTools } from './devicePackages';

/** Structural check, not `instanceof DeviceTreeItem`: the item may come from a different copy of the `tree` module. */
function deviceFrom(item: unknown): SfdkDeviceInfo | undefined {
  if (!item || typeof item !== 'object' || !('device' in item)) {
    return undefined;
  }
  const device = item.device;
  if (
    device &&
    typeof device === 'object' &&
    typeof (device as SfdkDeviceInfo).name === 'string' &&
    typeof (device as SfdkDeviceInfo).kind === 'string'
  ) {
    return device as SfdkDeviceInfo;
  }
  return undefined;
}

const SHOW_OUTPUT_ACTION = 'Show Output';

/** R34: every error notification offers at least one action. */
function notifyError(services: Services, message: string): void {
  void services.prompts.showErrorMessage(message, SHOW_OUTPUT_ACTION).then((choice) => {
    if (choice === SHOW_OUTPUT_ACTION) {
      void vscode.commands.executeCommand('sailfish.showOutput');
    }
  });
}

/** R33: long emulator operations run under a cancellable progress notification. */
async function runWithProgress<T>(
  title: string,
  services: Services,
  fn: (token: vscode.CancellationToken) => Promise<T>,
): Promise<T | undefined> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token) => {
      try {
        return await fn(token);
      } catch (err) {
        services.output.log('error', `${title} failed: ${err instanceof Error ? err.message : String(err)}`);
        notifyError(services, `Sailfish: ${title} failed`);
        return undefined;
      }
    },
  );
}

/** FR-6.4/R34: a non-zero, non-cancelled sfdk exit gets its own actionable notification (start/stop/install/config --global previously only logged this). */
function notifyIfFailed(services: Services, title: string, result: SfdkResult): void {
  if (result.cancelled || result.exitCode === 0) {
    return;
  }
  const firstLine = (result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`).split(/\r?\n/)[0];
  notifyError(services, `Sailfish: ${title} failed: ${firstLine}`);
}

/** R25: names reach `sfdk <family> <verb> <name>` as one positional argv element with no validation upstream; reject anything option-like before it gets there. */
function isUnsafeName(name: string): boolean {
  return name.startsWith('-');
}

function rejectUnsafeName(services: Services, name: string): boolean {
  if (!isUnsafeName(name)) {
    return false;
  }
  notifyError(services, `Sailfish: "${name}" looks like an option, not a device/emulator name; refusing to run sfdk`);
  return true;
}

function runEmulatorVerb(services: Services, provider: DevicesTreeDataProvider, verb: 'start' | 'stop' | 'status') {
  return async (item: unknown): Promise<void> => {
    const device = deviceFrom(item);
    if (!device) {
      void services.prompts.showWarningMessage('Sailfish: select an emulator in the Devices view first.');
      return;
    }
    if (rejectUnsafeName(services, device.name)) {
      return;
    }
    const state = provider.reachabilityOf(device);
    if ((verb === 'start' && state === 'online') || (verb === 'stop' && state === 'offline')) {
      void services.prompts.showInformationMessage(
        `Sailfish: emulator ${device.name} is already ${verb === 'start' ? 'running' : 'stopped'}.`,
      );
      return;
    }
    const result = await runWithProgress(`Sailfish: emulator ${verb} ${device.name}`, services, (token) =>
      services.runner.run({ args: ['emulator', verb, device.name], ensureEngine: false, token }),
    );
    if (result) {
      if (verb === 'status') {
        void services.prompts.showInformationMessage(
          result.stdout.trim() || result.stderr.trim() || `Sailfish: emulator ${verb} finished (exit ${result.exitCode})`,
        );
      } else {
        notifyIfFailed(services, `emulator ${verb} ${device.name}`, result);
      }
    }
    provider.refresh();
  };
}

function runEngineVerb(services: Services, provider: DevicesTreeDataProvider, verb: 'start' | 'stop') {
  return async (): Promise<void> => {
    const result = await runWithProgress(`Sailfish: engine ${verb}`, services, (token) =>
      services.runner.run({ args: ['engine', verb], ensureEngine: false, token }),
    );
    if (result) {
      notifyIfFailed(services, `engine ${verb}`, result);
    }
    provider.refresh();
  };
}

function showEmulator(services: Services) {
  return async (item: unknown): Promise<void> => {
    const device = deviceFrom(item);
    if (!device) {
      void services.prompts.showWarningMessage('Sailfish: select an emulator in the Devices view first.');
      return;
    }
    if (rejectUnsafeName(services, device.name)) {
      return;
    }
    const result = await runWithProgress(`Sailfish: emulator show ${device.name}`, services, (token) =>
      services.runner.run({ args: ['emulator', 'show', device.name], ensureEngine: false, token }),
    );
    if (!result) {
      return;
    }
    services.output.log('info', result.stdout);
    const vmName = await correlateVm(services, device, result.exitCode === 0 ? result.stdout : undefined);
    if (vmName) {
      services.output.log('info', `devices: correlated VirtualBox VM "${vmName}" for "${device.name}"`);
    }
    void services.prompts.showInformationMessage(
      result.stdout.trim() || result.stderr.trim() || `Sailfish: emulator show ${device.name} (exit ${result.exitCode})`,
    );
  };
}

/** FR-6.3: invoked from a root's context menu (no tree item carries a device), so pick one from `emulator list -a`. */
async function pickAvailableDevice(services: Services, provider: DevicesTreeDataProvider): Promise<SfdkDeviceInfo | undefined> {
  const available = await provider.listAvailableForPick();
  if (available.length === 0) {
    void services.prompts.showInformationMessage('Sailfish: no emulators available to install.');
    return undefined;
  }
  const picked = await services.prompts.showQuickPick(
    available.map((d) => d.name),
    { placeHolder: 'Select an emulator to install' },
  );
  return available.find((d) => d.name === picked);
}

function installAvailable(services: Services, provider: DevicesTreeDataProvider) {
  return async (item: unknown): Promise<void> => {
    const device = deviceFrom(item) ?? (await pickAvailableDevice(services, provider));
    if (!device) {
      return;
    }
    if (rejectUnsafeName(services, device.name)) {
      return;
    }
    const result = await runWithProgress(`Sailfish: install emulator ${device.name}`, services, (token) =>
      services.runner.run({ args: ['emulator', 'install', device.name], ensureEngine: false, token }),
    );
    if (result) {
      notifyIfFailed(services, `install emulator ${device.name}`, result);
    }
    provider.refresh();
  };
}

/** FR-6.5: workspace-folder setting only, no sfdk config call. */
async function writeDefaultDeviceSetting(services: Services, name: string): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void services.prompts.showWarningMessage('Sailfish: no workspace folder to save the default device to');
    return false;
  }
  const config = vscode.workspace.getConfiguration('sailfish', folder.uri);
  await config.update('device', name, vscode.ConfigurationTarget.WorkspaceFolder);
  await services.contextKeys.set('sailfish.hasDevice', true);
  return true;
}

/** FR-6.5: lets the Command Palette invocation (no tree item) pick from the installed devices/emulators. */
async function pickInstalledDevice(services: Services, provider: DevicesTreeDataProvider): Promise<SfdkDeviceInfo | undefined> {
  const installed = await provider.listInstalledForPick();
  if (installed.length === 0) {
    void services.prompts.showInformationMessage('Sailfish: no devices or emulators found.');
    return undefined;
  }
  const items = installed.map((d) => `${d.name} (${d.kind})`);
  const picked = await services.prompts.showQuickPick(items, { placeHolder: 'Select a device or emulator' });
  return installed.find((d) => `${d.name} (${d.kind})` === picked);
}

function setDefault(services: Services, provider: DevicesTreeDataProvider) {
  return async (item: unknown): Promise<void> => {
    const device = deviceFrom(item) ?? (await pickInstalledDevice(services, provider));
    if (!device) {
      return;
    }
    if (await writeDefaultDeviceSetting(services, sfdkDeviceName(device))) {
      provider.refresh();
    }
  };
}

function setSfdkDefault(services: Services, provider: DevicesTreeDataProvider) {
  return async (item: unknown): Promise<void> => {
    const device = deviceFrom(item) ?? (await pickInstalledDevice(services, provider));
    if (!device) {
      return;
    }
    const name = sfdkDeviceName(device);
    if (!(await writeDefaultDeviceSetting(services, name))) {
      return;
    }
    const result = await runWithProgress(`Sailfish: set sfdk default device ${name}`, services, (token) =>
      services.runner.run({ args: ['config', '--global', `device=${name}`], ensureEngine: false, token }),
    );
    provider.refresh();
    if (result) {
      notifyIfFailed(services, `set sfdk default device ${name}`, result);
    }
  };
}

function openSsh(services: Services) {
  return (item: unknown): void => {
    const device = deviceFrom(item);
    if (!device) {
      void services.prompts.showWarningMessage('Sailfish: select a device in the Devices view first.');
      return;
    }
    if (rejectUnsafeName(services, device.name)) {
      return;
    }
    const sfdkPath = services.sdk.current()?.sfdkPath;
    if (!sfdkPath) {
      notifyError(services, 'Sailfish SDK not found; commands are disabled until an SDK is configured.');
      return;
    }
    const launch = buildSshLaunch(device, sfdkPath);
    const terminal = vscode.window.createTerminal({
      name: `SSH: ${device.name}`,
      shellPath: launch.shellPath,
      shellArgs: launch.shellArgs,
    });
    terminal.show();
  };
}

const CUSTOM_USERNAME = 'Custom username…';

/**
 * "Sailfish: Connect to Device (WLAN)" — opens a real interactive `ssh` terminal to a
 * device by IP, independent of sfdk/devices.xml (no device needs to be registered first).
 * No password is ever read or handled here: the user types it into the opened terminal.
 */
function connectWlan(services: Services) {
  return async (): Promise<void> => {
    const host = await services.prompts.showInputBox({
      prompt: 'Device IP address or hostname (WLAN)',
      placeHolder: '192.168.50.125',
      validateInput: (v) => (v.trim().length === 0 ? 'Required' : v.startsWith('-') ? 'Must not start with "-"' : undefined),
    });
    if (!host) {
      return;
    }
    const port = await services.prompts.showInputBox({
      prompt: 'SSH port',
      value: '22',
      validateInput: (v) => (isValidPort(v) ? undefined : 'Enter a port number between 1 and 65535'),
    });
    if (!port) {
      return;
    }
    const usernameChoice = await services.prompts.showQuickPick(['nemo', 'defaultuser', CUSTOM_USERNAME], {
      placeHolder: 'Device username (nemo on Sailfish OS < 3.4.0, defaultuser on newer)',
    });
    if (!usernameChoice) {
      return;
    }
    const user =
      usernameChoice === CUSTOM_USERNAME
        ? await services.prompts.showInputBox({
            prompt: 'Custom username',
            validateInput: (v) => (v.trim().length === 0 ? 'Required' : v.startsWith('-') ? 'Must not start with "-"' : undefined),
          })
        : usernameChoice;
    if (!user) {
      return;
    }
    const launch = buildWlanSshLaunch(host, port, user);
    if (!launch) {
      notifyError(services, `Sailfish: could not build an ssh command for ${user}@${host}:${port}`);
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: `SSH: ${user}@${host}`,
      shellPath: launch.shellPath,
      shellArgs: launch.shellArgs,
    });
    terminal.show();
    void services.prompts.showInformationMessage(
      `Connecting to ${user}@${host}:${port} — type the device's Developer Mode remote-connection password in the terminal.`,
    );
  };
}

/** Registers the sailfish.devices view and its commands (FR-6.2..FR-6.8). */
export function activateDevices(ctx: vscode.ExtensionContext, services: Services): DevicesTreeDataProvider {
  const provider = new DevicesTreeDataProvider(services);
  const sdkView = vscode.window.createTreeView('sailfish.sdk', { treeDataProvider: provider.section('sdk') });
  const syncSdkDescription = (): void => {
    const info = services.sdk.current();
    sdkView.description = info ? sdkRootState(info, os.homedir()).description : undefined;
  };
  syncSdkDescription();
  ctx.subscriptions.push(
    sdkView,
    services.sdk.onDidChange(syncSdkDescription),
    vscode.window.registerTreeDataProvider('sailfish.emulators', provider.section('emulators')),
    vscode.window.registerTreeDataProvider('sailfish.devices', provider.section('devices')),
  );
  ctx.subscriptions.push(provider);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('sailfish.devices.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('sailfish.emulator.start', runEmulatorVerb(services, provider, 'start')),
    vscode.commands.registerCommand('sailfish.emulator.stop', runEmulatorVerb(services, provider, 'stop')),
    vscode.commands.registerCommand('sailfish.emulator.status', runEmulatorVerb(services, provider, 'status')),
    vscode.commands.registerCommand('sailfish.engine.start', runEngineVerb(services, provider, 'start')),
    vscode.commands.registerCommand('sailfish.engine.stop', runEngineVerb(services, provider, 'stop')),
    vscode.commands.registerCommand('sailfish.emulator.show', showEmulator(services)),
    vscode.commands.registerCommand('sailfish.emulator.installAvailable', installAvailable(services, provider)),
    vscode.commands.registerCommand('sailfish.device.setDefault', setDefault(services, provider)),
    vscode.commands.registerCommand('sailfish.device.setSfdkDefault', setSfdkDefault(services, provider)),
    vscode.commands.registerCommand('sailfish.device.openSsh', openSsh(services)),
    vscode.commands.registerCommand('sailfish.device.connectWlan', connectWlan(services)),
    vscode.commands.registerCommand('sailfish.device.add', addDevice(services, ctx)),
    vscode.commands.registerCommand('sailfish.device.remove', removeDevice(services)),
    vscode.commands.registerCommand('sailfish.device.installTools', installDeviceTools(services)),
  );

  return provider;
}
