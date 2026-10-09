import * as os from 'node:os';
import * as vscode from 'vscode';
import type { ParseResult, SdkInfo, SfdkDeviceInfo, TargetDescriptor } from '../core/types';
import type { Services } from '../core/services';
import type { SfdkResult } from '../sfdk/runner';
import {
  attachEmulatorEndpoints,
  formatDeviceDescription,
  formatDeviceLabel,
  formatDeviceTooltip,
  isDefaultDevice,
  parseDeviceList,
  parseEmulatorList,
  sfdkDeviceName,
} from './listParsing';
import { deviceSessions, SESSIONS_CONTEXT_SUFFIX, sessionDescription, type DeviceSessionInfo } from '../core/deviceSessions';
import { RefreshDebouncer } from './refreshDebouncer';
import { REACHABILITY_POLL_MS, shouldProbe, splitBySession, type ProbeCandidate } from './probeScheduleCore';
import { endpointKey, isReachable, type Reachability } from './reachability';
import { parseEngineStatus, type EngineRunningStatus } from '../sfdk/parsers/engineStatus';
import { parseTargetList } from '../targets/parseTargetList';
import { scopeFolder } from '../targets/statusBar';
import {
  engineItemState,
  type EngineOutcome,
  sdkRootState,
  targetItemState,
  visibleTargets,
} from './sdkTreeCore';

/** How often the connected/offline state is re-checked while the view exists (TCP only, no sfdk). */

/** Devices & Emulators tree view (`sardina.devices`, FR-6.2/FR-6.7). */

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

export class DeviceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly device: SfdkDeviceInfo,
    isDefault: boolean,
    reachability: Reachability = 'unknown',
    sessions: readonly DeviceSessionInfo[] = [],
  ) {
    super(formatDeviceLabel(device), vscode.TreeItemCollapsibleState.None);
    const hardware = device.kind === 'hardware-device';
    const state =
      reachability === 'online' ? (hardware ? '● connected' : '● running') : reachability === 'offline' ? (hardware ? '○ offline' : '○ stopped') : undefined;
    // Tree labels can't render $(icon) codes, so state and default are marked in the description.
    this.description = [state, isDefault ? '✓ default' : undefined, sessionDescription(sessions) || undefined, formatDeviceDescription(device)].filter(Boolean).join(' · ');
    this.tooltip =
      formatDeviceTooltip(device) +
      (reachability === 'online'
        ? `\n${hardware ? 'Connected' : 'Running'}: its SSH port answers.`
        : reachability === 'offline'
          ? `\n${hardware ? 'Offline: registered, but its SSH port does not answer (unplugged, asleep, or another network).' : 'Stopped.'}`
          : '');
    // `emulator.running` / `emulator.stopped` drive which of Start/Stop is offered inline (package.json menus).
    const emulatorState = reachability === 'online' ? '.running' : reachability === 'offline' ? '.stopped' : '';
    this.contextValue =
      `${hardware ? 'hardware-device' : `emulator${emulatorState}`}${sessions.length > 0 ? SESSIONS_CONTEXT_SUFFIX : ''}`;
    const color =
      reachability === 'online'
        ? new vscode.ThemeColor('testing.iconPassed')
        : reachability === 'offline'
          ? new vscode.ThemeColor('disabledForeground')
          : undefined;
    this.iconPath = new vscode.ThemeIcon(hardware ? 'device-mobile' : 'vm', color);
  }
}

/** FR-6.7: rendered instead of an empty root whenever a list call fails or doesn't parse. */
export class ListErrorItem extends vscode.TreeItem {
  constructor(detail: string) {
    super('Could not list (click for details)', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'devices-list-error';
    this.tooltip = detail;
    this.iconPath = new vscode.ThemeIcon('warning');
    this.command = { command: 'sardina.showOutput', title: 'Sardina: Show Output' };
  }
}

/** R6: an explicit empty state, distinct from ListErrorItem, for a successful-but-empty list. */
export class EmptyStateItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'devices-empty';
  }
}

export type DevicesSection = 'sdk' | 'devices';

export class SdkRootItem extends vscode.TreeItem {
  constructor() {
    super('SDK', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'devices-root-sdk';
  }

  /** The root is a cached singleton, so its state is re-applied from the current SDK each time it is listed. */
  apply(info: SdkInfo | undefined): this {
    const state = sdkRootState(info, os.homedir());
    this.description = state.description;
    this.tooltip = state.tooltip;
    this.contextValue = state.contextValue;
    return this;
  }
}

export class SdkNotFoundItem extends vscode.TreeItem {
  constructor() {
    super('SFOS SDK not found', vscode.TreeItemCollapsibleState.None);
    this.description = 'click to install';
    this.contextValue = 'sdk-not-found';
    this.iconPath = new vscode.ThemeIcon('warning');
    this.command = { command: 'sardina.sdk.install', title: 'Sardina: Install SDK' };
  }
}

export class SdkEngineItem extends vscode.TreeItem {
  constructor(outcome: EngineOutcome) {
    super('Build engine', vscode.TreeItemCollapsibleState.None);
    const state = engineItemState(outcome);
    this.description = state.description;
    this.tooltip = state.tooltip;
    this.contextValue = state.contextValue;
    this.iconPath =
      state.state === 'running'
        ? new vscode.ThemeIcon('server', new vscode.ThemeColor('testing.iconPassed'))
        : state.state === 'stopped'
          ? new vscode.ThemeIcon('server', new vscode.ThemeColor('disabledForeground'))
          : new vscode.ThemeIcon('warning');
  }
}

export class SdkTargetsRootItem extends vscode.TreeItem {
  constructor() {
    super('Build targets', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'sdk-targets-root';
  }
}

export class SdkTargetItem extends vscode.TreeItem {
  constructor(target: TargetDescriptor, configuredTarget: string | undefined) {
    super(target.name, vscode.TreeItemCollapsibleState.None);
    const state = targetItemState(target, configuredTarget);
    this.description = state.description;
    this.tooltip = state.tooltip;
    this.iconPath = new vscode.ThemeIcon('circuit-board');
    this.contextValue = 'sdk-target';
  }
}

export type DeviceOrRootItem =
  | EmulatorsRootItem
  | DevicesRootItem
  | DeviceTreeItem
  | ListErrorItem
  | EmptyStateItem
  | SdkRootItem
  | SdkNotFoundItem
  | SdkEngineItem
  | SdkTargetsRootItem
  | SdkTargetItem;

type ListOutcome<T = SfdkDeviceInfo[]> = { ok: true; value: T; warnings: string[] } | { ok: false; detail: string };
type SdkLoad = { engine: ListOutcome<EngineRunningStatus>; targets: ListOutcome<TargetDescriptor[]> };

function toOutcome<T = SfdkDeviceInfo[]>(
  settled: PromiseSettledResult<SfdkResult>,
  parse: (raw: string) => ParseResult<T>,
  services: Services,
): ListOutcome<T> {
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

/** Emulators already appear under their own root (joined via attachEmulatorEndpoints), so "Devices" lists hardware only. */
function onlyHardware(outcome: ListOutcome): ListOutcome {
  return outcome.ok ? { ...outcome, value: outcome.value.filter((d) => d.kind === 'hardware-device') } : outcome;
}

export class DevicesTreeDataProvider implements vscode.TreeDataProvider<DeviceOrRootItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<DeviceOrRootItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Fires only after the device lists were invalidated or their reachability changed, never for session-only re-renders. */
  private readonly listsEmitter = new vscode.EventEmitter<void>();
  readonly onDidReloadLists = this.listsEmitter.event;

  private readonly emulatorsRoot = new EmulatorsRootItem();
  private readonly devicesRoot = new DevicesRootItem();

  private cache: Promise<{ emulators: ListOutcome; devices: ListOutcome }> | undefined;
  private availableCache: Promise<ListOutcome> | undefined;
  private sdkCache: Promise<SdkLoad> | undefined;
  private readonly sdkRoot = new SdkRootItem();
  private readonly sdkTargetsRoot = new SdkTargetsRootItem();

  private readonly debouncer = new RefreshDebouncer(2000, () => this.doRefresh());
  private readonly settingsSubscriptions: vscode.Disposable[];

  /** Last probe result per `host:port`; filled asynchronously after each list load. */
  private readonly reachability = new Map<string, Reachability>();
  private readonly pollTimer = setInterval(() => void this.probeReachability(), REACHABILITY_POLL_MS);
  private viewVisible = false;
  private unfocusedSince: number | undefined;

  constructor(private readonly services: Services) {
    this.settingsSubscriptions = [
      services.settings.onDidChange('device', () => this.refresh()),
      services.settings.onDidChange('target', () => this.refresh()),
      services.settings.onDidChange('showSnapshotTargets', () => this.refresh()),
      services.sdk.onDidChange(() => this.refresh()),
      // Session labels live in the description: re-render at once, no `sfdk` list reload.
      deviceSessions.onDidChange(() => this.emitter.fire()),
      vscode.window.onDidChangeWindowState((state) => {
        this.unfocusedSince = state.focused ? undefined : Date.now();
        if (state.focused) void this.probeReachability();
      }),
    ];
    this.unfocusedSince = vscode.window.state.focused ? undefined : Date.now();
  }

  /** Probing runs only while the Devices view shows; becoming visible probes at once. */
  setViewVisible(visible: boolean): void {
    this.viewVisible = visible;
    if (visible) void this.probeReachability();
  }

  getTreeItem(element: DeviceOrRootItem): vscode.TreeItem {
    return element;
  }

  /** One sidebar pane per section: SDK lists its children directly; Devices has the two groups Emulators and Devices as roots. */
  section(which: DevicesSection): vscode.TreeDataProvider<DeviceOrRootItem> {
    return {
      onDidChangeTreeData: this.onDidChangeTreeData,
      getTreeItem: (element) => element,
      getChildren: (element) => {
        if (element) return this.getChildren(element);
        const sdk = this.services.sdk.current();
        if (which === 'sdk') return this.getChildren(this.sdkRoot.apply(sdk) ?? this.sdkRoot);
        if (!sdk) return [];
        return [this.emulatorsRoot, this.devicesRoot];
      },
    };
  }

  getChildren(element?: DeviceOrRootItem): vscode.ProviderResult<DeviceOrRootItem[]> {
    if (!element) {
      const sdk = this.services.sdk.current();
      this.sdkRoot.apply(sdk);
      // Without an SDK the emulator/device lists could only render "Could not list".
      return sdk ? [this.emulatorsRoot, this.devicesRoot, this.sdkRoot] : [this.sdkRoot];
    }
    if (element === this.sdkRoot) {
      return this.renderSdk();
    }
    if (element === this.sdkTargetsRoot) {
      return this.loadSdk().then(({ targets }) => this.renderTargets(targets));
    }
    if (element === this.emulatorsRoot) {
      return this.loadEmulators().then((outcome) => this.renderEmulators(outcome));
    }
    if (element === this.devicesRoot) {
      return this.loadDevices().then((outcome) => this.renderList(onlyHardware(outcome), 'No devices found.'));
    }
    return [];
  }

  /** R6: cache clears immediately on every call; only the onDidChangeTreeData notification is debounced (FR-6.7). */
  refresh(): void {
    this.cache = undefined;
    this.availableCache = undefined;
    this.sdkCache = undefined;
    this.debouncer.trigger();
  }

  reachabilityOf(device: SfdkDeviceInfo): Reachability {
    const key = endpointKey(device.host, device.port);
    return (key && this.reachability.get(key)) || 'unknown';
  }

  /** Probes listed endpoints without a live session; redraws only when a state changed (the list cache is reused, so no sfdk runs). */
  private async probeReachability(): Promise<void> {
    if (!this.cache || !shouldProbe({ viewVisible: this.viewVisible, unfocusedSince: this.unfocusedSince, now: Date.now() })) return;
    const { emulators, devices } = await this.cache;
    const listed = [...(emulators.ok ? emulators.value : []), ...(devices.ok ? devices.value : [])];
    const endpoints = new Map<string, { host: string; port: number }>();
    const candidates: ProbeCandidate[] = [];
    for (const d of listed) {
      const key = endpointKey(d.host, d.port);
      if (!key || !d.host || !d.port || d.flags.includes('available')) continue;
      endpoints.set(key, { host: d.host, port: d.port });
      candidates.push({ key, hasSession: deviceSessions.activeFor(sfdkDeviceName(d)).length > 0 });
    }
    const { probe, online } = splitBySession(candidates);
    let changed = false;
    const record = (key: string, state: Reachability): void => {
      if (this.reachability.get(key) === state) return;
      this.reachability.set(key, state);
      changed = true;
    };
    for (const key of online) record(key, 'online');
    await Promise.all(
      probe.map(async (key) => {
        const { host, port } = endpoints.get(key)!;
        record(key, (await isReachable(host, port)) ? 'online' : 'offline');
      }),
    );
    if (changed) {
      this.emitter.fire();
      this.listsEmitter.fire();
    }
  }

  dispose(): void {
    clearInterval(this.pollTimer);
    this.debouncer.dispose();
    this.emitter.dispose();
    this.listsEmitter.dispose();
    for (const sub of this.settingsSubscriptions) sub.dispose();
  }

  private doRefresh(): void {
    this.emitter.fire();
    this.listsEmitter.fire();
  }

  /** Both root lists load together via Promise.allSettled (NFR-3). */
  private ensureLoaded(): Promise<{ emulators: ListOutcome; devices: ListOutcome }> {
    if (!this.cache) {
      this.cache = Promise.allSettled([this.fetch(['emulator', 'list']), this.fetch(['device', 'list'])]).then(
        ([emulatorSettled, deviceSettled]) => {
          const emulators = toOutcome(emulatorSettled, parseEmulatorList, this.services);
          const devices = toOutcome(deviceSettled, parseDeviceList, this.services);
          return {
            emulators:
              emulators.ok && devices.ok
                ? { ...emulators, value: attachEmulatorEndpoints(emulators.value, devices.value) }
                : emulators,
            devices,
          };
        },
      );
      void this.cache.then(() => this.probeReachability());
    }
    return this.cache;
  }

  private async loadEmulators(): Promise<ListOutcome> {
    return (await this.ensureLoaded()).emulators;
  }

  private async loadDevices(): Promise<ListOutcome> {
    return (await this.ensureLoaded()).devices;
  }

  private loadSdk(): Promise<SdkLoad> {
    if (!this.sdkCache) {
      this.sdkCache = Promise.allSettled([this.fetch(['engine', 'status']), this.fetch(['tools', 'target', 'list'])]).then(
        ([engineSettled, targetsSettled]) => ({
          engine: toOutcome(engineSettled, parseEngineStatus, this.services),
          targets: toOutcome(targetsSettled, parseTargetList, this.services),
        }),
      );
    }
    return this.sdkCache;
  }

  private async renderSdk(): Promise<DeviceOrRootItem[]> {
    const sdk = this.services.sdk.current();
    if (!sdk) {
      return [new SdkNotFoundItem()];
    }
    const { engine } = await this.loadSdk();
    return [
      new SdkEngineItem(engine),
      this.sdkTargetsRoot,
    ];
  }

  private renderTargets(outcome: ListOutcome<TargetDescriptor[]>): DeviceOrRootItem[] {
    if (!outcome.ok) {
      return [new ListErrorItem(outcome.detail)];
    }
    const targets = visibleTargets(outcome.value, this.services.settings.get('showSnapshotTargets'));
    this.sdkTargetsRoot.description = String(targets.length);
    if (targets.length === 0) {
      return [new EmptyStateItem('No build targets installed.')];
    }
    const configured = this.services.settings.get('target', scopeFolder(this.services)?.uri) || undefined;
    return targets.map((t) => new SdkTargetItem(t, configured));
  }

  /** FR-6.3: lets the title button / Command Palette installAvailable offer a QuickPick without a tree item. */
  async listAvailableForPick(): Promise<SfdkDeviceInfo[]> {
    const outcome = await this.loadAvailable();
    return outcome.ok ? outcome.value.filter((d) => d.flags.includes('available')) : [];
  }

  /** FR-6.5: lets the Command Palette's setDefault/setSfdkDefault offer a QuickPick without a tree item. */
  async listInstalledForPick(): Promise<SfdkDeviceInfo[]> {
    const { emulators, devices } = await this.ensureLoaded();
    const hardware = onlyHardware(devices);
    return [
      ...(emulators.ok ? emulators.value.filter((d) => !d.flags.includes('available')) : []),
      ...(hardware.ok ? hardware.value : []),
    ];
  }

  /** Lazy: only fetched when the Install available Emulator picker opens. */
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
    return installed.length === 0
      ? [new EmptyStateItem('No emulators installed.')]
      : installed.map((d) => new DeviceTreeItem(d, isDefaultDevice(d, defaultName), this.reachabilityOf(d), deviceSessions.activeFor(sfdkDeviceName(d))));
  }

  private renderList(outcome: ListOutcome, emptyLabel: string): DeviceOrRootItem[] {
    if (!outcome.ok) {
      return [new ListErrorItem(outcome.detail)];
    }
    if (outcome.value.length === 0) {
      return [new EmptyStateItem(emptyLabel)];
    }
    const defaultName = this.defaultDeviceName();
    return outcome.value.map((d) => new DeviceTreeItem(d, isDefaultDevice(d, defaultName), this.reachabilityOf(d), deviceSessions.activeFor(sfdkDeviceName(d))));
  }
}
