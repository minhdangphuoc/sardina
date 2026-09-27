import * as vscode from 'vscode';
import type { ParseResult, SfdkDeviceInfo } from '../core/types';
import type { Services } from '../core/services';
import type { SfdkResult } from '../sfdk/runner';
import {
  formatDeviceDescription,
  formatDeviceLabel,
  formatDeviceTooltip,
  isDefaultDevice,
  parseDeviceList,
  parseEmulatorList,
} from './listParsing';
import { RefreshDebouncer } from './refreshDebouncer';

/** Devices & Emulators tree view (`sailfish.devices`, FR-6.2/FR-6.7). */

export class EmulatorsRootItem extends vscode.TreeItem {
  constructor() {
    super('Emulators', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'devices-root-emulators';
  }
}

export class DevicesRootItem extends vscode.TreeItem {
  constructor() {
    super('Devices', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'devices-root-devices';
  }
}

export class AvailableRootItem extends vscode.TreeItem {
  constructor() {
    super('Available to install', vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'devices-root-available';
  }
}

export class DeviceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly device: SfdkDeviceInfo,
    isDefault: boolean,
    /** FR-6.3: an "Available to install" child gets 'emulator-available' so it offers install, not start/stop/status. */
    contextValueOverride?: string,
  ) {
    super(formatDeviceLabel(device, isDefault), vscode.TreeItemCollapsibleState.None);
    this.description = formatDeviceDescription(device);
    this.tooltip = formatDeviceTooltip(device);
    this.contextValue = contextValueOverride ?? (device.kind === 'hardware-device' ? 'hardware-device' : 'emulator');
    this.iconPath = new vscode.ThemeIcon(device.kind === 'hardware-device' ? 'device-mobile' : 'vm');
  }
}

/** FR-6.7: rendered instead of an empty root whenever a list call fails or doesn't parse. */
export class ListErrorItem extends vscode.TreeItem {
  constructor(detail: string) {
    super('Could not list (click for details)', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'devices-list-error';
    this.tooltip = detail;
    this.iconPath = new vscode.ThemeIcon('warning');
    this.command = { command: 'sailfish.showOutput', title: 'Sailfish: Show Output' };
  }
}

/** R6: an explicit empty state, distinct from ListErrorItem, for a successful-but-empty list. */
export class EmptyStateItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'devices-empty';
  }
}

export type DeviceOrRootItem =
  | EmulatorsRootItem
  | DevicesRootItem
  | AvailableRootItem
  | DeviceTreeItem
  | ListErrorItem
  | EmptyStateItem;

type ListOutcome = { ok: true; value: SfdkDeviceInfo[]; warnings: string[] } | { ok: false; detail: string };

function toOutcome(
  settled: PromiseSettledResult<SfdkResult>,
  parse: (raw: string) => ParseResult<SfdkDeviceInfo[]>,
  services: Services,
): ListOutcome {
  if (settled.status === 'rejected') {
    return { ok: false, detail: String(settled.reason) };
  }
  const result = settled.value;
  if (result.exitCode !== 0) {
    return { ok: false, detail: result.stderr.trim() || result.stdout.trim() || `sfdk exited ${result.exitCode}` };
  }
  const parsed = parse(result.stdout);
  if (!parsed.ok) {
    return { ok: false, detail: parsed.reason };
  }
  for (const warning of parsed.warnings) {
    services.output.log('warn', `devices: ${warning}`);
  }
  return { ok: true, value: parsed.value, warnings: parsed.warnings };
}

export class DevicesTreeDataProvider implements vscode.TreeDataProvider<DeviceOrRootItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<DeviceOrRootItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly emulatorsRoot = new EmulatorsRootItem();
  private readonly devicesRoot = new DevicesRootItem();
  private readonly availableRoot = new AvailableRootItem();

  private cache: Promise<{ emulators: ListOutcome; devices: ListOutcome }> | undefined;
  private availableCache: Promise<ListOutcome> | undefined;

  private readonly debouncer = new RefreshDebouncer(2000, () => this.doRefresh());
  private readonly settingsSubscriptions: vscode.Disposable[];

  constructor(private readonly services: Services) {
    this.settingsSubscriptions = [
      services.settings.onDidChange('device', () => this.refresh()),
      services.settings.onDidChange('target', () => this.refresh()),
    ];
  }

  getTreeItem(element: DeviceOrRootItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DeviceOrRootItem): vscode.ProviderResult<DeviceOrRootItem[]> {
    if (!element) {
      return [this.emulatorsRoot, this.devicesRoot];
    }
    if (element === this.emulatorsRoot) {
      return this.loadEmulators().then((outcome) => this.renderEmulators(outcome));
    }
    if (element === this.devicesRoot) {
      return this.loadDevices().then((outcome) => this.renderList(outcome, 'No devices found.'));
    }
    if (element === this.availableRoot) {
      return this.loadAvailable().then((outcome) => this.renderAvailable(outcome));
    }
    return [];
  }

  /** R6: cache clears immediately on every call; only the onDidChangeTreeData notification is debounced (FR-6.7). */
  refresh(): void {
    this.cache = undefined;
    this.availableCache = undefined;
    this.debouncer.trigger();
  }

  dispose(): void {
    this.debouncer.dispose();
    this.emitter.dispose();
    for (const sub of this.settingsSubscriptions) sub.dispose();
  }

  private doRefresh(): void {
    this.emitter.fire();
  }

  /** Both root lists load together via Promise.allSettled (NFR-3). */
  private ensureLoaded(): Promise<{ emulators: ListOutcome; devices: ListOutcome }> {
    if (!this.cache) {
      this.cache = Promise.allSettled([this.fetch(['emulator', 'list']), this.fetch(['device', 'list'])]).then(
        ([emulatorSettled, deviceSettled]) => ({
          emulators: toOutcome(emulatorSettled, parseEmulatorList, this.services),
          devices: toOutcome(deviceSettled, parseDeviceList, this.services),
        }),
      );
    }
    return this.cache;
  }

  private async loadEmulators(): Promise<ListOutcome> {
    return (await this.ensureLoaded()).emulators;
  }

  private async loadDevices(): Promise<ListOutcome> {
    return (await this.ensureLoaded()).devices;
  }

  /** FR-6.3: lets the root's context-menu installAvailable action offer a QuickPick without an already-expanded tree item. */
  async listAvailableForPick(): Promise<SfdkDeviceInfo[]> {
    const outcome = await this.loadAvailable();
    return outcome.ok ? outcome.value.filter((d) => d.flags.includes('available')) : [];
  }

  /** FR-6.5: lets the Command Palette's setDefault/setSfdkDefault offer a QuickPick without a tree item. */
  async listInstalledForPick(): Promise<SfdkDeviceInfo[]> {
    const { emulators, devices } = await this.ensureLoaded();
    return [...(emulators.ok ? emulators.value : []), ...(devices.ok ? devices.value : [])];
  }

  /** Lazy: only fetched once the "Available to install" node is expanded. */
  private loadAvailable(): Promise<ListOutcome> {
    if (!this.availableCache) {
      this.availableCache = this.fetch(['emulator', 'list', '-a']).then((result) =>
        toOutcome({ status: 'fulfilled', value: result }, parseEmulatorList, this.services),
      );
    }
    return this.availableCache;
  }

  /** Defensive: never let a runner rejection escape as an unhandled promise. */
  private async fetch(args: string[]): Promise<SfdkResult> {
    try {
      return await this.services.runner.run({ args, ensureEngine: false });
    } catch (err) {
      return {
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: -1,
        argv: ['sfdk', ...args],
        durationMs: 0,
        timedOut: false,
        cancelled: false,
      };
    }
  }

  private defaultDeviceName(): string | undefined {
    const name = this.services.settings.get('device');
    return name || undefined;
  }

  /** M1.24: a VBoxManage-flavoured list failure gets an actionable hint appended to the tooltip. */
  private static withGuidance(detail: string): string {
    return /virtualbox/i.test(detail)
      ? `${detail}\n\nVirtualBox not found - install VirtualBox or check PATH`
      : detail;
  }

  private renderEmulators(outcome: ListOutcome): DeviceOrRootItem[] {
    if (!outcome.ok) {
      return [new ListErrorItem(DevicesTreeDataProvider.withGuidance(outcome.detail))];
    }
    const defaultName = this.defaultDeviceName();
    const installed = outcome.value.filter((d) => !d.flags.includes('available'));
    const items: DeviceOrRootItem[] =
      installed.length === 0
        ? [new EmptyStateItem('No emulators installed.')]
        : installed.map((d) => new DeviceTreeItem(d, isDefaultDevice(d, defaultName)));
    items.push(this.availableRoot);
    return items;
  }

  private renderList(outcome: ListOutcome, emptyLabel: string): DeviceOrRootItem[] {
    if (!outcome.ok) {
      return [new ListErrorItem(outcome.detail)];
    }
    if (outcome.value.length === 0) {
      return [new EmptyStateItem(emptyLabel)];
    }
    const defaultName = this.defaultDeviceName();
    return outcome.value.map((d) => new DeviceTreeItem(d, isDefaultDevice(d, defaultName)));
  }

  private renderAvailable(outcome: ListOutcome): DeviceOrRootItem[] {
    if (!outcome.ok) {
      return [new ListErrorItem(outcome.detail)];
    }
    const available = outcome.value.filter((d) => d.flags.includes('available'));
    if (available.length === 0) {
      return [new EmptyStateItem('No emulators available to install.')];
    }
    return available.map((d) => new DeviceTreeItem(d, false, 'emulator-available'));
  }
}
