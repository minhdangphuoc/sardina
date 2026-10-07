import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Services } from '../core/services';
import type { ProjectDescriptor, SfdkDeviceInfo } from '../core/types';
import { deviceSessions, type DeviceSessionInfo, type DeviceSessions } from '../core/deviceSessions';
import { chooseLogFormat, clampLogLines, JournalLogSource, type LogEnd, type LogFormat } from './logSource';
import { AppStatsSource, chooseStatsMode, isValidExe, pollIntervalMs, type StatsMode } from './statsSource';
import { clearOverviewCache, probeOverview, type DeviceOverview } from './deviceProbe';
import { AppCounter, type ExitInfo } from './appStats';
import {
  LogBuffer,
  MAX_ENTRIES_LIMIT,
  coredumpEvent,
  entryVisible,
  formatEntryLine,
  markerEntry,
  type AppIdentity,
  type JournalEntry,
  type ProcessEvent,
} from './logModel';
import { ActionGuard, PageMessageGate, monitorHtml, toLogFilters } from './monitorCore';
import {
  actionStates,
  logStartDecision,
  oldAgentLogNotice,
  overviewRows,
  pickApp,
  sessionRows,
  sourceCandidate,
  statsSourceText,
  statsView,
  type AppRef,
} from './panelModel';
import {
  MAX_BATCH_ENTRIES,
  type ActionName,
  type ActionState,
  type AppIdentityWire,
  type AppStatsView,
  type BannerAction,
  type HostMessage,
  type LogStatus,
  type OverviewRow,
  type PageMessage,
  type ResumeTarget,
  type SectionId,
  type SessionRow,
} from './protocol';
import type { AppCounters } from './appStats';
import { clientArgs, onAgentInstall, probe } from '../agent/deviceAgent';
import type { AgentProbe } from '../agent/agentCore';
import { onAppExit } from '../tasks/appTerminal';
import { relaunchInstalled } from '../tasks/commands';

export const VIEW_TYPE = 'sailfish.deviceMonitor';
/** The log stream keeps running into the host buffer for this long while the tab is hidden (D12). */
export const HIDDEN_LOG_PAUSE_MS = 10 * 60 * 1000;
/** A batch the page never acknowledged is given up after this long, so the stream cannot stall. */
const ACK_TIMEOUT_MS = 10_000;
/** The process marker of the stats stream and of the terminal's exit line are one event within this window. */
const EXIT_DEDUPE_MS = 3000;
const SECTIONS_WITH_FOCUS: readonly SectionId[] = ['overview', 'sessions', 'app', 'logs', 'actions'];

export interface MonitorOpenOptions {
  preserveFocus?: boolean;
  reveal?: SectionId;
}

export function isSectionId(v: unknown): v is SectionId {
  return typeof v === 'string' && (SECTIONS_WITH_FOCUS as readonly string[]).includes(v);
}

/** What `sailfish._test.monitor` returns (TEST_MODE=full): the panel's current view model. */
export interface MonitorView {
  device: string;
  overview: OverviewRow[];
  sessions: SessionRow[];
  app: { app?: { name: string; binary?: string }; stats: AppStatsView | null; counters: AppCounters; source: string };
  log: { status: LogStatus; reason?: string; format?: LogFormat; entries: JournalEntry[]; cursor?: string };
  actions: Partial<Record<ActionName, ActionState>>;
  banner?: { text: string; actions: BannerAction[] };
  panels: number;
}

/** A tree-item-shaped device for the existing agent commands (`deviceFrom` reads `{device}`). */
function deviceItem(name: string, info: SfdkDeviceInfo | undefined): { device: SfdkDeviceInfo } {
  return { device: info ?? { index: -1, name, kind: 'unknown', origin: 'unknown', flags: [], extra: [], deviceName: name } };
}

function stamp(d: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

export class MonitorPanel {
  readonly panel: vscode.WebviewPanel;
  private readonly subs: vscode.Disposable[] = [];
  private readonly gate = new PageMessageGate();
  private readonly actionGuard = new ActionGuard();
  private buf: LogBuffer;
  private pageReady = false;
  private sentUpTo = 0;
  private inFlight = false;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private agent: AgentProbe | undefined;
  private overview: DeviceOverview | undefined;
  private project: ProjectDescriptor | undefined;

  private logSrc: JournalLogSource | undefined;
  private logFormat: LogFormat | undefined;
  /** The last journal cursor delivered (JSON mode); kept across stopped streams so Resume continues after it (§4.1, D5). */
  private lastLogCursor: string | undefined;
  private logStatus: LogStatus = 'starting';
  private logReason: string | undefined;
  private logPaused = false;
  private pausedForHidden = false;
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private visible = true;

  private statsSrc: AppStatsSource | undefined;
  private statsMode: StatsMode = 'poll';
  private statsText = 'no app known';
  private lastStats: AppStatsView | null = null;
  private app: AppRef | undefined;
  private pids = new Set<number>();
  private counter = new AppCounter();
  private lastExitMarker = 0;
  private banner: { text: string; actions: BannerAction[] } | undefined;
  private revealOnInit: SectionId | undefined;

  constructor(
    ctx: vscode.ExtensionContext,
    private readonly services: Services,
    readonly device: string,
    private readonly info: SfdkDeviceInfo | undefined,
    opts: MonitorOpenOptions,
    private readonly panelCount: () => number,
    private readonly onDisposed: (p: MonitorPanel) => void,
  ) {
    this.buf = new LogBuffer(this.bufferLines());
    this.revealOnInit = opts.reveal;
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'monitor');
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Device Monitor: ${device}`,
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
      this.panel.onDidChangeViewState(() => this.setVisible(this.panel.visible)),
      this.panel.onDidDispose(() => this.dispose()),
      deviceSessions.onDidChange(() => this.onSessionsChanged()),
      onAgentInstall((e) => {
        if (e.device !== this.device) return;
        if (e.phase === 'installing') this.agentInstalling();
        else void this.agentInstalled(e.probe);
      }),
      onAppExit((e) => {
        if (e.device === this.device) this.appExited(e.app, e.cancelled ? {} : { code: e.code });
      }),
      this.services.projects.onDidChange(() => void this.loadProject().then(() => this.refreshApp())),
      this.services.settings.onDidChange('device', () => this.onSelectedDeviceChanged()),
    );
    void this.start();
  }

  // --- opening and state ---

  /** Second open: reveal the tab and, when asked, expand a section. */
  reveal(opts: MonitorOpenOptions): void {
    this.panel.reveal(undefined, opts.preserveFocus === true);
    if (opts.reveal) {
      this.revealOnInit = opts.reveal;
      if (this.pageReady) this.sendInit();
    }
  }

  private bufferLines(): number {
    const n = this.services.settings.get('monitor.logBufferLines');
    return typeof n === 'number' && Number.isFinite(n) ? Math.max(1000, Math.min(MAX_ENTRIES_LIMIT, Math.floor(n))) : 10_000;
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
    this.startLogs();
    this.refreshApp(true);
  }

  private async refreshAgent(): Promise<void> {
    try {
      this.agent = await probe(this.services, this.device);
    } catch (err) {
      this.agent = { state: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
    }
    this.postOverview();
    this.postActions();
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

  private overviewRowsNow(): OverviewRow[] {
    const folderUri = this.project?.folder.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const sessions = deviceSessions.activeFor(this.device);
    return overviewRows({
      deviceName: this.device,
      info: this.info,
      overview: this.overview,
      agent: this.agent,
      target: this.services.settings.get('target', folderUri) || undefined,
      buildType: this.services.settings.get('build.type', folderUri),
      deployMethod: this.services.settings.get('deploy.method', folderUri),
      binary: this.app?.binary,
      debugging: sessions.some((s) => s.kind === 'debug'),
    });
  }

  private postOverview(): void {
    this.post({ type: 'overview', rows: this.overviewRowsNow() });
  }

  private postSessions(): void {
    this.post({ type: 'sessions', list: sessionRows(deviceSessions.activeFor(this.device)) });
  }

  private actionsNow(): Partial<Record<ActionName, ActionState>> {
    return actionStates({ selected: this.selectedDevice() === this.device, binaryKnown: this.app?.binary !== undefined, agent: this.agent });
  }

  private postActions(): void {
    this.post({ type: 'actions', actions: this.actionsNow() });
  }

  private identity(): AppIdentityWire | undefined {
    if (!this.app) return undefined;
    return { name: this.app.name, binary: this.app.binary, pids: [...this.pids] };
  }

  private appIdentity(): AppIdentity | undefined {
    return this.app ? { name: this.app.name, binary: this.app.binary, pids: this.pids } : undefined;
  }

  private appMessage(): Extract<HostMessage, { type: 'app' }> {
    const m: Extract<HostMessage, { type: 'app' }> = { type: 'app', stats: this.lastStats, counters: this.counter.value, source: this.statsText };
    if (this.app) m.app = this.app.binary ? { name: this.app.name, binary: this.app.binary } : { name: this.app.name };
    const id = this.identity();
    if (id) m.identity = id;
    return m;
  }

  private postApp(): void {
    this.post(this.appMessage());
  }

  private logStateMessage(): HostMessage {
    const m: Extract<HostMessage, { type: 'log.state' }> = { type: 'log.state', status: this.logPaused && this.logStatus === 'live' ? 'paused' : this.logStatus };
    if (this.logReason !== undefined) m.reason = this.logReason;
    if (this.logFormat) m.format = this.logFormat;
    return m;
  }

  private setLog(status: LogStatus, reason?: string): void {
    this.logStatus = status;
    this.logReason = reason;
    this.post(this.logStateMessage());
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

  private sendInit(): void {
    const reveal = this.revealOnInit;
    this.revealOnInit = undefined;
    this.post({
      type: 'init',
      device: this.device,
      settings: { maxEntries: this.buf.maxEntries, deriveLevels: false, groupStackFrames: true, ...(reveal ? { reveal } : {}) },
    });
  }

  /** The page is up (first show or re-created after being hidden): everything is sent again, the log with acks. */
  private onReady(): void {
    this.pageReady = true;
    this.sentUpTo = 0;
    this.inFlight = false;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.sendInit();
    this.postOverview();
    this.postSessions();
    this.postApp();
    this.postActions();
    if (this.banner) this.post({ type: 'banner', text: this.banner.text, actions: this.banner.actions });
    this.post(this.logStateMessage());
    const notice = oldAgentLogNotice(this.agent);
    if (notice && this.logFormat === 'text') this.post({ type: 'notice', text: notice });
    this.pump();
  }

  /** Posts the next batch of the log buffer once the page acknowledged the previous one (§5.5). */
  private pump(): void {
    if (this.disposed || !this.pageReady || !this.panel.visible || this.inFlight) return;
    const slice = this.buf.since(this.sentUpTo, MAX_BATCH_ENTRIES);
    if (slice.entries.length === 0 && slice.dropped === 0) return;
    const last = slice.entries.length > 0 ? slice.entries[slice.entries.length - 1].id : this.buf.lastId;
    this.sentUpTo = last;
    this.inFlight = true;
    this.ackTimer = setTimeout(() => {
      this.inFlight = false;
      this.pump();
    }, ACK_TIMEOUT_MS);
    this.post({ type: 'log.append', entries: slice.entries, dropped: slice.dropped, upTo: last });
  }

  private onAck(upTo: number): void {
    if (upTo < this.sentUpTo) return;
    this.inFlight = false;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.pump();
  }

  // --- visibility ---

  private setVisible(on: boolean): void {
    if (this.visible === on) return;
    this.visible = on;
    this.statsSrc?.setVisible(on);
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = undefined;
    if (!on) {
      this.pageReady = false;
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = undefined;
        if (this.logSrc?.running) {
          this.logSrc.pause();
          this.pausedForHidden = true;
          this.setLog('paused', 'paused while the tab was hidden');
        }
      }, HIDDEN_LOG_PAUSE_MS);
    } else if (this.pausedForHidden) {
      this.pausedForHidden = false;
      void this.logSrc?.resume().then((ok) => {
        if (ok) this.setLog('live');
      });
    }
  }

  // --- logs ---

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

  private startLogs(): void {
    this.logSrc?.dispose();
    this.logSrc = undefined;
    this.pausedForHidden = false;
    const decision = logStartDecision(this.device, this.agent);
    if (!decision.start) {
      this.logFormat = undefined;
      this.setLog(decision.status, decision.reason);
      return;
    }
    const running = this.agent?.state === 'running' ? this.agent : undefined;
    const format = chooseLogFormat(running?.logFormats);
    this.logFormat = format;
    const src = new JournalLogSource(this.services, {
      device: this.device,
      format,
      logLines: clampLogLines(this.services.settings.get('monitor.logLines')),
      clientArgs: clientArgs(),
      after: format === 'json' ? this.lastLogCursor : undefined,
      sessions: this.sessionsProxy(() => {
        if (this.logSrc === src) this.logSrc = undefined;
        this.setLog('stopped', 'stopped');
        this.announceStopped('logs');
      }),
    });
    this.logSrc = src;
    src.onEntries((batch) => this.onEntries(batch));
    src.onEnd((end) => this.onLogEnd(src, end));
    this.setLog('starting');
    void src.start().then((ok) => {
      if (this.logSrc !== src || this.disposed) return;
      if (ok) this.setLog('live');
    });
    const notice = oldAgentLogNotice(this.agent);
    if (notice && format === 'text') this.post({ type: 'notice', text: notice });
  }

  private onLogEnd(src: JournalLogSource, end: LogEnd): void {
    if (this.logSrc === src) this.logSrc = undefined;
    src.dispose();
    // Only the logs switch is "off"; a stop from the phone ("Stop all sessions now") is a stopped stream with Resume.
    const status: LogStatus = end.reason === 'refused' && end.agentError !== 'stopped from the phone' ? 'off' : 'stopped';
    this.setLog(status, end.text);
  }

  private onEntries(batch: JournalEntry[]): void {
    const identity = this.appIdentity();
    for (const e of batch) {
      this.buf.push(e);
      if (e.cursor && e.source === 'json') this.lastLogCursor = e.cursor;
      const ev = identity ? coredumpEvent(e, identity) : undefined;
      if (ev && ev.type === 'exited') {
        if (this.counter.exited(e.coredumpPid, ev.exit)) this.postApp();
        this.pushMarker(ev);
      }
    }
    this.pump();
  }

  private pushMarker(ev: ProcessEvent): void {
    this.buf.push(markerEntry(ev, Date.now()));
    this.pump();
  }

  // --- app and stats ---

  private stopOwnStreams(): void {
    this.logSrc?.dispose();
    this.logSrc = undefined;
    this.statsSrc?.dispose();
    this.statsSrc = undefined;
  }

  private announceStopped(what: 'logs' | 'app'): void {
    if (this.disposed) return;
    const selected = this.selectedDevice();
    if (selected !== this.device) {
      this.setBanner(`Streams stopped: "${this.device}" is no longer the selected device.`, [{ label: 'Resume', resume: 'all' }]);
    } else {
      this.setBanner(what === 'logs' ? 'The log stream was stopped.' : 'The app monitor was stopped.', [{ label: 'Resume', resume: what }]);
    }
  }

  private onSelectedDeviceChanged(): void {
    this.postActions();
    const selected = this.selectedDevice();
    if (selected !== this.device && !this.logSrc?.running && !this.statsSrc) {
      this.setBanner(`Streams stopped: "${this.device}" is no longer the selected device.`, [{ label: 'Resume', resume: 'all' }]);
    }
    void this.loadProject().then(() => this.refreshApp());
  }

  /** The app follows the registry (§3.5); streams start, restart or stop when it or the agent's stats capability changes. */
  private refreshApp(force = false): void {
    if (this.disposed) return;
    const sessions = deviceSessions.activeFor(this.device);
    const fallback = this.selectedDevice() === this.device && this.project ? { name: this.project.name, binary: this.project.appBinaryPath } : undefined;
    const next = pickApp(sessions, fallback);
    const changed = next?.binary !== this.app?.binary || next?.name !== this.app?.name;
    const modeNow: StatsMode = chooseStatsMode(this.agent?.state === 'running' && this.agent.developerMode ? this.agent.stats : undefined);
    this.app = next;
    if (changed) {
      this.pids = new Set();
      this.counter = new AppCounter();
      this.lastStats = null;
    }
    const needsRestart = force || changed || (this.statsSrc !== undefined && this.statsMode !== modeNow);
    if (needsRestart) {
      this.statsSrc?.dispose();
      this.statsSrc = undefined;
      this.statsMode = modeNow;
      if (next?.binary && isValidExe(next.binary) && this.agent !== undefined) this.startStats(next);
    }
    if (!next) this.statsText = 'no app known';
    if (changed || needsRestart) {
      this.postApp();
      this.postOverview();
      this.postActions();
    }
  }

  private intervalSec(): number {
    return pollIntervalMs(this.services.settings.get('monitor.pollIntervalSeconds')) / 1000;
  }

  /**
   * Samples and `start` events arrive only while this monitor's own `app monitor` session is registered, so every
   * PID change it sees happens "while a session is registered" (§4.3) and counts as a restart (I-M6), also for an
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
        this.statsText = 'paused';
        this.postApp();
        this.announceStopped('app');
      }),
    });
    this.statsSrc = src;
    this.statsText = statsSourceText(this.statsMode, this.intervalSec(), this.visible);
    src.onSample((u) => {
      this.lastStats = statsView(u.sample, u.cpu, u.sysCpu);
      if (u.sample.pid > 0) {
        this.pids.add(u.sample.pid);
        this.counter.pidSeen(u.sample.pid, true);
      }
      this.statsText = statsSourceText(this.statsMode, this.intervalSec(), this.visible);
      this.postApp();
    });
    src.onProcess((t) => {
      const name = this.app?.name ?? 'app';
      if (t.type === 'start') {
        this.pids.add(t.pid);
        this.counter.pidSeen(t.pid, true);
        this.pushMarker({ type: 'started', app: name, pid: t.pid, mode: this.app?.mode });
      } else {
        this.lastStats = { ...(this.lastStats ?? {}), pid: undefined, cpu: undefined };
        this.markExit(name, {});
      }
      this.postApp();
    });
    src.onEnd((end) => {
      if (this.statsSrc === src) this.statsSrc = undefined;
      src.dispose();
      this.statsText = `stopped: ${end.text}`;
      this.postApp();
      this.setBanner(`The app monitor stopped: ${end.text}`, [{ label: 'Resume', resume: 'app' }]);
    });
    src.start();
  }

  /** One exit marker per exit even when the stats stream and the terminal both report it. */
  private markExit(app: string, exit: ExitInfo): void {
    const now = Date.now();
    if (now - this.lastExitMarker < EXIT_DEDUPE_MS) return;
    this.lastExitMarker = now;
    this.pushMarker({ type: 'exited', app, exit });
  }

  private appExited(app: string, exit: ExitInfo): void {
    this.counter.exited(undefined, exit);
    this.markExit(app, exit);
    this.postApp();
  }

  private onSessionsChanged(): void {
    if (this.disposed) return;
    this.postSessions();
    this.refreshApp();
    this.postOverview();
  }

  // --- agent install ---

  private agentInstalling(): void {
    this.logSrc?.pause();
    this.statsSrc?.dispose();
    this.statsSrc = undefined;
    this.setBanner('The device agent is being updated.', []);
  }

  private async agentInstalled(result: AgentProbe | undefined): Promise<void> {
    const before = this.logFormat;
    if (result) {
      this.agent = result;
      this.postOverview();
      this.postActions();
    } else await this.refreshAgent();
    this.clearBanner();
    clearOverviewCache(this.device);
    void this.probeOverviewNow(true);
    const running = this.agent?.state === 'running' ? this.agent : undefined;
    const old = this.logSrc;
    if (old && running && chooseLogFormat(running.logFormats) === before) {
      void old.resume().then((ok) => {
        if (ok) this.setLog('live');
      });
    } else this.startLogs();
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
      case 'log.ack':
        this.onAck(m.upTo);
        return;
      case 'log.pause':
        this.logPaused = m.on;
        return;
      case 'log.clear':
        this.buf.clear();
        this.sentUpTo = this.buf.lastId;
        return;
      case 'log.save':
        await this.saveLog(m);
        return;
      case 'openSource':
        await this.openSource(m.file, m.line, m.col);
        return;
      case 'action':
        await this.runAction(m.name);
        return;
      case 'session.stop':
        await this.stopSession(m.id);
        return;
      case 'ui.visible':
        this.statsSrc?.setVisible(m.on);
        return;
      case 'resume':
        await this.resume(m.what);
        return;
    }
  }

  /** The probe runs again on Resume (§4), so a phone-side change (logs switched back on, agent started) is picked up. */
  private async resume(what: ResumeTarget): Promise<void> {
    this.clearBanner();
    await this.refreshAgent();
    if (this.disposed) return;
    if (what === 'logs' || what === 'all') this.startLogs();
    if (what === 'app' || what === 'all') this.refreshApp(true);
  }

  private async stopSession(id: number): Promise<void> {
    const result = await deviceSessions.stopOne(this.device, id);
    for (const f of result.failed) this.post({ type: 'notice', text: `Could not stop ${f.label}: ${f.reason}` });
  }

  private async runAction(name: ActionName): Promise<void> {
    const state = this.actionsNow()[name];
    if (state && !state.enabled) {
      this.post({ type: 'notice', text: state.reason ?? 'That action is not available now.' });
      return;
    }
    if (!this.actionGuard.tryStart(name)) return;
    try {
      const item = deviceItem(this.device, this.info);
      switch (name) {
        case 'refresh':
          clearOverviewCache(this.device);
          await Promise.all([this.refreshAgent(), this.probeOverviewNow(true)]);
          return;
        case 'installAgent':
          await vscode.commands.executeCommand('sailfish.agent.install', item);
          return;
        case 'screenshot':
          await vscode.commands.executeCommand('sailfish.agent.screenshot', item);
          return;
        case 'openMirror':
          await vscode.commands.executeCommand('sailfish.agent.mirror', item);
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
      this.post({ type: 'notice', text: `${name} failed: ${text}` });
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
    this.post({ type: 'notice', text: r.exitCode === 0 ? `Stopped ${this.app?.name ?? binary}.` : `${this.app?.name ?? binary} was not running.` });
  }

  private async restartApp(): Promise<void> {
    const debugging = deviceSessions.activeFor(this.device).find((s) => s.kind === 'debug');
    for (const s of this.appSessions()) await this.stopSession(s.id);
    if (debugging) await vscode.commands.executeCommand('sailfish.debugInstalled');
    else await relaunchInstalled(this.services);
  }

  private async saveLog(m: Extract<PageMessage, { type: 'log.save' }>): Promise<void> {
    let entries = this.buf.all();
    if (m.filteredOnly && m.filter) {
      const filters = toLogFilters(m.filter, this.identity());
      entries = entries.filter((e) => entryVisible(e, filters));
    }
    const derive = m.filter?.deriveLevels === true;
    const text = m.format === 'jsonl' ? entries.map((e) => JSON.stringify(e)).join('\n') : entries.map((e) => formatEntryLine(e, derive)).join('\n');
    const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');
    const name = `${safe(this.device)}-${safe(this.app?.name ?? 'device')}-${stamp(new Date())}.${m.format}`;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const target = await this.services.prompts.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(folder, name)),
      filters: m.format === 'jsonl' ? { 'JSON lines': ['jsonl'] } : { 'Log file': ['log'] },
      saveLabel: 'Save log',
      title: 'Save device log',
    });
    if (!target) return;
    try {
      await fs.writeFile(target.fsPath, text.length > 0 ? `${text}\n` : '');
      this.post({ type: 'notice', text: `saved ${entries.length} lines to ${target.fsPath}` });
    } catch (err) {
      void this.services.prompts.showErrorMessage(`Sailfish: could not save the log to ${target.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Opens a log line's source reference: only files inside a workspace folder, never a path the page names directly (§5.4). */
  private async openSource(file: string, line: number, col: number | undefined): Promise<void> {
    const cand = sourceCandidate(file, this.project?.name);
    if (!cand) {
      this.post({ type: 'notice', text: `not found in the workspace: ${file}` });
      return;
    }
    let uri: vscode.Uri | undefined;
    if (cand.rel && this.project) {
      const direct = vscode.Uri.joinPath(this.project.folder.uri, ...cand.rel.split('/'));
      if (await vscode.workspace.fs.stat(direct).then(() => true, () => false)) uri = direct;
    }
    if (!uri) {
      const hits = await vscode.workspace.findFiles(`**/${cand.base}`, '**/node_modules/**', 10);
      if (hits.length === 1) uri = hits[0];
      else if (hits.length > 1) {
        const picked = await this.services.prompts.showQuickPick(
          hits.map((h) => ({ label: vscode.workspace.asRelativePath(h), uri: h })),
          { placeHolder: `Which ${cand.base}?` },
        );
        uri = picked?.uri;
        if (!uri) return;
      }
    }
    if (!uri) {
      this.post({ type: 'notice', text: `not found in the workspace: ${file}` });
      return;
    }
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, (col ?? 1) - 1));
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), preserveFocus: false });
  }

  // --- test seam and teardown ---

  view(): MonitorView {
    const v: MonitorView = {
      device: this.device,
      overview: this.overviewRowsNow(),
      sessions: sessionRows(deviceSessions.activeFor(this.device)),
      app: { stats: this.lastStats, counters: this.counter.value, source: this.statsText },
      log: {
        status: this.logPaused && this.logStatus === 'live' ? 'paused' : this.logStatus,
        entries: this.buf.all(),
      },
      actions: this.actionsNow(),
      panels: this.panelCount(),
    };
    if (this.app) v.app.app = this.app.binary ? { name: this.app.name, binary: this.app.binary } : { name: this.app.name };
    if (this.logReason !== undefined) v.log.reason = this.logReason;
    if (this.logFormat) v.log.format = this.logFormat;
    const cursor = this.logSrc?.lastCursor ?? this.lastLogCursor;
    if (cursor) v.log.cursor = cursor;
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
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.stopOwnStreams();
    for (const s of this.subs) s.dispose();
    this.onDisposed(this);
    this.panel.dispose();
  }
}
