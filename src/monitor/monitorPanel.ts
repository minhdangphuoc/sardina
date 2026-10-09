import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { Services } from '../core/services';
import type { ProjectDescriptor, SfdkDeviceInfo } from '../core/types';
import { deviceSessions, type DeviceSessionInfo, type DeviceSessions } from '../core/deviceSessions';
import { AppStatsSource, chooseStatsMode, isValidExe, pollIntervalMs, type StatsMode } from './statsSource';
import { clearOverviewCache, probeOverview, type DeviceOverview } from './deviceProbe';
import { APP_PID_HISTORY_MAX, AppCounter, type AppCounters } from './appStats';
import { coredumpEvent, type AppIdentity } from './logModel';
import { ActionGuard, PageMessageGate, monitorHtml } from './monitorCore';
import { actionStates, connectionState, headerLine, pickApp, statsView, type ActionState, type AppRef } from './panelModel';
import type { ActionName, AppStatsView, BannerAction, ConnectionState, HostMessage, PageMessage, ResumeTarget } from './protocol';
import { onAgentInstall, probe } from '../agent/deviceAgent';
import type { AgentProbe } from '../agent/agentCore';
import { onAppExit } from '../tasks/appTerminal';
import { relaunchInstalled } from '../tasks/commands';
import { onDeviceLogEntries } from './deviceLog';
import { BoundedSet } from '../core/bounded';

export const VIEW_TYPE = 'sailfish.deviceMonitor';
export const APP_RUNNING_KEY = 'sailfish.monitor.appRunning';

export interface MonitorOpenOptions {
  preserveFocus?: boolean;
}

/** What `sailfish._test.monitor` returns (TEST_MODE=full): the panel's current view model. */
export interface MonitorView {
  device: string;
  state: ConnectionState;
  line: string;
  app: { app?: { name: string; binary?: string }; mode?: 'run' | 'debug'; stats: AppStatsView | null; counters: AppCounters };
  actions: Partial<Record<ActionName, ActionState>>;
  banner?: { text: string; actions: BannerAction[] };
  panels: number;
}

/** A tree-item-shaped device for the existing agent commands (`deviceFrom` reads `{device}`). */
function deviceItem(name: string, info: SfdkDeviceInfo | undefined): { device: SfdkDeviceInfo } {
  return { device: info ?? { index: -1, name, kind: 'unknown', origin: 'unknown', flags: [], extra: [], deviceName: name } };
}

export class MonitorPanel {
  readonly panel: vscode.WebviewPanel;
  private readonly subs: vscode.Disposable[] = [];
  private readonly gate = new PageMessageGate();
  private readonly actionGuard = new ActionGuard();
  private pageReady = false;
  private disposed = false;
  private visible = true;

  private agent: AgentProbe | undefined;
  private overview: DeviceOverview | undefined;
  private project: ProjectDescriptor | undefined;

  private statsSrc: AppStatsSource | undefined;
  private statsMode: StatsMode = 'poll';
  private lastStats: AppStatsView | null = null;
  private app: AppRef | undefined;
  private pids = new BoundedSet<number>(APP_PID_HISTORY_MAX);
  private counter = new AppCounter();
  private banner: { text: string; actions: BannerAction[] } | undefined;
  private offlineBanner = false;

  constructor(
    ctx: vscode.ExtensionContext,
    private readonly services: Services,
    readonly device: string,
    private readonly info: SfdkDeviceInfo | undefined,
    opts: MonitorOpenOptions,
    private readonly panelCount: () => number,
    private readonly onDisposed: (p: MonitorPanel) => void,
  ) {
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'monitor');
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Monitor: ${device}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: opts.preserveFocus === true },
      { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: false },
    );
    this.panel.webview.html = monitorHtml({
      nonce: randomBytes(16).toString('hex'),
      cspSource: this.panel.webview.cspSource,
      device,
      scriptUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'monitor.js')).toString(),
      styleUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'monitor.css')).toString(),
    });
    this.subs.push(
      this.panel.webview.onDidReceiveMessage((raw: unknown) => void this.onRaw(raw)),
      this.panel.onDidChangeViewState(() => {
        this.setVisible(this.panel.visible);
        this.updateContext();
      }),
      this.panel.onDidDispose(() => this.dispose()),
      deviceSessions.onDidChange(() => this.onSessionsChanged()),
      onAgentInstall((e) => {
        if (e.device !== this.device) return;
        if (e.phase === 'installing') this.agentInstalling();
        else void this.agentInstalled(e.probe);
      }),
      onAppExit((e) => {
        if (e.device === this.device) this.appExited(e.cancelled ? {} : { code: e.code });
      }),
      onDeviceLogEntries((device, batch) => {
        if (device !== this.device) return;
        const identity = this.appIdentity();
        if (!identity) return;
        let crashed = false;
        for (const e of batch) {
          const ev = coredumpEvent(e, identity);
          if (ev && ev.type === 'exited' && this.counter.exited(e.coredumpPid, ev.exit)) crashed = true;
        }
        if (crashed) this.postApp();
      }),
      this.services.projects.onDidChange(() => void this.loadProject().then(() => this.refreshApp())),
      this.services.settings.onDidChange('device', () => this.onSelectedDeviceChanged()),
    );
    void this.start();
  }

  // --- opening and state ---

  /** Second open: reveal the tab. */
  reveal(opts: MonitorOpenOptions): void {
    this.panel.reveal(undefined, opts.preserveFocus === true);
  }

  private selectedDevice(): string | undefined {
    return this.services.settings.get('device', vscode.workspace.workspaceFolders?.[0]?.uri) || undefined;
  }

  private async loadProject(): Promise<void> {
    this.project = await this.services.projects.resolveActive().catch(() => undefined);
  }

  private async start(): Promise<void> {
    await this.loadProject();
    this.refreshApp();
    void this.probeOverviewNow(false);
    await this.refreshAgent();
    if (this.disposed) return;
    this.refreshApp(true);
  }

  private async refreshAgent(): Promise<void> {
    try {
      this.agent = await probe(this.services, this.device);
    } catch (err) {
      this.agent = { state: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
    }
    this.updateOfflineBanner();
    this.postOverview();
    this.postActions();
  }

  /** An unreachable device gets a banner with Retry (the probe runs again); it goes away once the device answers. */
  private updateOfflineBanner(): void {
    if (this.agent?.state === 'unreachable') {
      this.offlineBanner = true;
      this.setBanner(`"${this.device}" is offline.`, [{ label: 'Retry', resume: 'all' }]);
    } else if (this.offlineBanner) {
      this.offlineBanner = false;
      this.clearBanner();
    }
  }

  private async probeOverviewNow(refresh: boolean): Promise<void> {
    try {
      this.overview = await probeOverview(this.services, this.device, { refresh });
    } catch (err) {
      this.services.output.log('warn', `device monitor overview: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!this.disposed) this.postOverview();
  }

  // --- messages to the page ---

  private post(m: HostMessage): void {
    if (this.disposed || !this.pageReady) return;
    void this.panel.webview.postMessage(m);
  }

  private overviewMessage(): Extract<HostMessage, { type: 'overview' }> {
    const input = { overview: this.overview, agent: this.agent };
    return { type: 'overview', state: connectionState(input), line: headerLine(input) };
  }

  private postOverview(): void {
    this.post(this.overviewMessage());
  }

  private actionsNow(): Partial<Record<ActionName, ActionState>> {
    return actionStates({ selected: this.selectedDevice() === this.device, binaryKnown: this.app?.binary !== undefined, agent: this.agent });
  }

  /** The editor title bar shows Restart and Stop only while the app runs; the key follows the active monitor tab. */
  private updateContext(): void {
    if (this.disposed || !this.panel.active) return;
    const running = this.lastStats?.pid !== undefined && this.lastStats.pid > 0;
    void vscode.commands.executeCommand('setContext', APP_RUNNING_KEY, running);
  }

  private postActions(): void {
    this.updateContext();
  }

  private appIdentity(): AppIdentity | undefined {
    return this.app ? { name: this.app.name, binary: this.app.binary, pids: this.pids } : undefined;
  }

  private appMessage(): Extract<HostMessage, { type: 'app' }> {
    const m: Extract<HostMessage, { type: 'app' }> = { type: 'app', stats: this.lastStats, counters: this.counter.value };
    if (this.app) {
      m.app = this.app.binary ? { name: this.app.name, binary: this.app.binary } : { name: this.app.name };
      if (this.app.mode) m.mode = this.app.mode;
    }
    return m;
  }

  private postApp(): void {
    this.updateContext();
    this.post(this.appMessage());
  }

  /** Feedback for a title bar command: a plain message, since the page has no room for it. */
  private notice(text: string): void {
    void this.services.prompts.showInformationMessage(`Sailfish: ${text}`);
  }

  private setBanner(text: string, actions: BannerAction[]): void {
    this.banner = { text, actions };
    this.post({ type: 'banner', text, actions });
  }

  private clearBanner(): void {
    if (!this.banner) return;
    this.banner = undefined;
    this.post({ type: 'banner.clear' });
  }

  /** The page is up (first show or re-created after being hidden): everything is sent again. */
  private onReady(): void {
    this.pageReady = true;
    this.post({ type: 'init', device: this.device });
    this.postOverview();
    this.postApp();
    this.updateContext();
    if (this.banner) this.post({ type: 'banner', text: this.banner.text, actions: this.banner.actions });
  }

  // --- visibility ---

  private setVisible(on: boolean): void {
    if (this.visible === on) return;
    this.visible = on;
    this.statsSrc?.setVisible(on);
    if (!on) this.pageReady = false;
  }

  // --- app and stats ---

  private sessionsProxy(onStop: () => void): DeviceSessions {
    return {
      register: (device: string, kind: Parameters<DeviceSessions['register']>[1], label: string, stop: () => Promise<void>, meta?: Parameters<DeviceSessions['register']>[4]) =>
        deviceSessions.register(
          device,
          kind,
          label,
          async () => {
            onStop();
            await stop();
          },
          meta,
        ),
    } as unknown as DeviceSessions;
  }

  private announceStopped(): void {
    if (this.disposed) return;
    const selected = this.selectedDevice();
    if (selected !== this.device) {
      this.setBanner(`Streams stopped: "${this.device}" is no longer the selected device.`, [{ label: 'Resume', resume: 'all' }]);
    } else {
      this.setBanner('The app monitor was stopped.', [{ label: 'Resume', resume: 'app' }]);
    }
  }

  private onSelectedDeviceChanged(): void {
    this.postActions();
    const selected = this.selectedDevice();
    if (selected !== this.device && !this.statsSrc) {
      this.setBanner(`Streams stopped: "${this.device}" is no longer the selected device.`, [{ label: 'Resume', resume: 'all' }]);
    }
    void this.loadProject().then(() => this.refreshApp());
  }

  /** The app follows the registry; the stats stream starts, restarts or stops when it or the agent's stats capability changes. */
  private refreshApp(force = false): void {
    if (this.disposed) return;
    const sessions = deviceSessions.activeFor(this.device);
    const fallback = this.selectedDevice() === this.device && this.project ? { name: this.project.name, binary: this.project.appBinaryPath } : undefined;
    const next = pickApp(sessions, fallback);
    const changed = next?.binary !== this.app?.binary || next?.name !== this.app?.name || next?.mode !== this.app?.mode;
    const identityChanged = next?.binary !== this.app?.binary || next?.name !== this.app?.name;
    const modeNow: StatsMode = chooseStatsMode(this.agent?.state === 'running' && this.agent.developerMode ? this.agent.stats : undefined);
    this.app = next;
    if (identityChanged) {
      this.pids = new BoundedSet(APP_PID_HISTORY_MAX);
      this.counter = new AppCounter();
      this.lastStats = null;
    }
    const needsRestart = force || identityChanged || (this.statsSrc !== undefined && this.statsMode !== modeNow);
    if (needsRestart) {
      this.statsSrc?.dispose();
      this.statsSrc = undefined;
      this.statsMode = modeNow;
      if (next?.binary && isValidExe(next.binary) && this.agent !== undefined) this.startStats(next);
    }
    if (changed || needsRestart) {
      this.postApp();
      this.postActions();
    }
  }

  /**
   * Samples and `start` events arrive only while this monitor's own `app monitor` session is registered, so every
   * PID change it sees happens "while a session is registered" and counts as a restart, also for an
   * app relaunched on the phone with no Run or Debug session in VS Code.
   */
  private startStats(app: AppRef): void {
    const src = new AppStatsSource(this.services, {
      device: this.device,
      mode: this.statsMode,
      binary: app.binary,
      intervalMs: pollIntervalMs(this.services.settings.get('monitor.pollIntervalSeconds')),
      app: app.name,
      sessions: this.sessionsProxy(() => {
        if (this.statsSrc === src) this.statsSrc = undefined;
        this.announceStopped();
      }),
    });
    this.statsSrc = src;
    src.onSample((u) => {
      this.lastStats = statsView(u.sample, u.cpu, u.sysCpu);
      if (u.sample.pid > 0) {
        this.pids.add(u.sample.pid);
        this.counter.pidSeen(u.sample.pid, true);
      }
      this.postApp();
    });
    src.onProcess((t) => {
      if (t.type === 'start') {
        this.pids.add(t.pid);
        this.counter.pidSeen(t.pid, true);
      } else {
        this.lastStats = { ...(this.lastStats ?? {}), pid: undefined, cpu: undefined };
      }
      this.postApp();
    });
    src.onEnd((end) => {
      if (this.statsSrc === src) this.statsSrc = undefined;
      src.dispose();
      this.postApp();
      this.setBanner(`The app monitor stopped: ${end.text}`, [{ label: 'Resume', resume: 'app' }]);
    });
    src.start();
  }

  private appExited(exit: { code?: number; signal?: string }): void {
    this.counter.exited(undefined, exit);
    this.postApp();
  }

  private onSessionsChanged(): void {
    if (this.disposed) return;
    this.refreshApp();
  }

  // --- agent install ---

  private agentInstalling(): void {
    this.statsSrc?.dispose();
    this.statsSrc = undefined;
    this.setBanner('The device agent is being updated.', []);
  }

  private async agentInstalled(result: AgentProbe | undefined): Promise<void> {
    if (result) {
      this.agent = result;
      this.postOverview();
      this.postActions();
    } else await this.refreshAgent();
    this.clearBanner();
    clearOverviewCache(this.device);
    void this.probeOverviewNow(true);
    this.refreshApp(true);
  }

  // --- page messages ---

  private async onRaw(raw: unknown): Promise<void> {
    const r = this.gate.accept(raw, Date.now());
    if (r.warning) this.services.output.log('warn', r.warning);
    if (r.message) await this.handle(r.message);
  }

  private async handle(m: PageMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.onReady();
        return;
      case 'ui.visible':
        this.statsSrc?.setVisible(m.on);
        return;
      case 'resume':
        await this.resume(m.what);
        return;
    }
  }

  /** The probe runs again on Resume and Retry, so a phone-side change (agent started, device back) is picked up. */
  private async resume(what: ResumeTarget): Promise<void> {
    this.clearBanner();
    if (what === 'all') {
      clearOverviewCache(this.device);
      void this.probeOverviewNow(true);
    }
    await this.refreshAgent();
    if (this.disposed) return;
    this.refreshApp(true);
  }

  private async stopSession(id: number): Promise<void> {
    const result = await deviceSessions.stopOne(this.device, id);
    for (const f of result.failed) this.notice(`Could not stop ${f.label}: ${f.reason}`);
  }

  /** Runs one of the title bar actions for this panel's device. */
  async runAction(name: ActionName): Promise<void> {
    const state = this.actionsNow()[name];
    if (state && !state.enabled) {
      this.notice(state.reason ?? 'That action is not available now.');
      return;
    }
    if (!this.actionGuard.tryStart(name)) return;
    try {
      const item = deviceItem(this.device, this.info);
      switch (name) {
        case 'screenshot':
          await vscode.commands.executeCommand('sailfish.agent.screenshot', item);
          return;
        case 'openMirror':
          await vscode.commands.executeCommand('sailfish.agent.mirror', item);
          return;
        case 'showLogs':
          await vscode.commands.executeCommand('sailfish.agent.logs', item);
          return;
        case 'stopApp':
          await this.stopApp();
          return;
        case 'restartApp':
          await this.restartApp();
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.services.output.log('warn', `device monitor action ${name}: ${text}`);
      this.notice(`${name} failed: ${text}`);
    } finally {
      this.actionGuard.finish(name);
    }
  }

  private appSessions(): DeviceSessionInfo[] {
    return deviceSessions.activeFor(this.device).filter((s) => s.kind === 'app' || s.kind === 'debug');
  }

  private async stopApp(): Promise<void> {
    const sessions = this.appSessions();
    if (sessions.length > 0) {
      for (const s of sessions) await this.stopSession(s.id);
      return;
    }
    const binary = this.app?.binary;
    if (!binary || !isValidExe(binary)) return;
    const r = await this.services.runner.run({ args: ['device', 'exec', '--', 'pkill', '-f', binary], device: this.device, timeoutMs: 30_000 });
    // pkill exits 1 when nothing matched
    this.notice(r.exitCode === 0 ? `Stopped ${this.app?.name ?? binary}.` : `${this.app?.name ?? binary} was not running.`);
  }

  private async restartApp(): Promise<void> {
    const debugging = deviceSessions.activeFor(this.device).find((s) => s.kind === 'debug');
    for (const s of this.appSessions()) await this.stopSession(s.id);
    if (debugging) await vscode.commands.executeCommand('sailfish.debugInstalled');
    else await relaunchInstalled(this.services);
  }

  // --- test seam and teardown ---

  view(): MonitorView {
    const input = { overview: this.overview, agent: this.agent };
    const v: MonitorView = {
      device: this.device,
      state: connectionState(input),
      line: headerLine(input),
      app: { stats: this.lastStats, counters: this.counter.value },
      actions: this.actionsNow(),
      panels: this.panelCount(),
    };
    if (this.app) {
      v.app.app = this.app.binary ? { name: this.app.name, binary: this.app.binary } : { name: this.app.name };
      if (this.app.mode) v.app.mode = this.app.mode;
    }
    if (this.banner) v.banner = this.banner;
    return v;
  }

  html(): string {
    return this.panel.webview.html;
  }

  /** TEST_MODE=full: a page message through the same validation as a real one; returns the view afterwards. */
  async sendForTest(message: unknown): Promise<MonitorView> {
    await this.onRaw(message);
    return this.view();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.statsSrc?.dispose();
    this.statsSrc = undefined;
    for (const s of this.subs) s.dispose();
    this.onDisposed(this);
    this.panel.dispose();
  }
}
