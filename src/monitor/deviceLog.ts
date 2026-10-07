import * as vscode from 'vscode';
import type { Services } from '../core/services';
import { deviceSessions, type DeviceSessions } from '../core/deviceSessions';
import { chooseLogFormat, clampLogLines, JournalLogSource, type LogEnd } from './logSource';
import { formatEntryLine, type JournalEntry } from './logModel';
import type { AgentProbe } from '../agent/agentCore';

export const LOG_CHANNEL_NAME = 'Sailfish Device Log';
export const STOP_DEVICE_LOG = 'Stop';
/** Lines kept for the test seam only (TEST_MODE=full). */
const TEST_LINES_MAX = 5000;

type Listener = (device: string, entries: JournalEntry[]) => void;
const listeners = new Set<Listener>();

/** Entries of the running device log stream; the Device Monitor reads crash markers from them. */
export function onDeviceLogEntries(listener: Listener): vscode.Disposable {
  listeners.add(listener);
  return new vscode.Disposable(() => void listeners.delete(listener));
}

interface Running {
  device: string;
  src: JournalLogSource;
  finish: () => void;
}

/**
 * The one device log view: the journal of a device streamed into the "Sailfish Device Log" output
 * channel (JSON with a cursor when the agent supports it, text otherwise). One stream at a time;
 * the registry entry ('logs', 'device logs') lets a device switch stop it.
 */
export class DeviceLog {
  private channel: vscode.OutputChannel | undefined;
  private running: Running | undefined;
  private readonly testLines: string[] = [];

  constructor(
    private readonly ctx: Pick<vscode.ExtensionContext, 'subscriptions'>,
    private readonly services: Services,
    private readonly clientArgs: () => string[],
  ) {}

  private getChannel(): vscode.OutputChannel {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel(LOG_CHANNEL_NAME);
      this.ctx.subscriptions.push(this.channel);
    }
    return this.channel;
  }

  private line(text: string): void {
    this.getChannel().appendLine(text);
    if (process.env.TEST_MODE === 'full') {
      this.testLines.push(text);
      if (this.testLines.length > TEST_LINES_MAX) this.testLines.shift();
    }
  }

  get device(): string | undefined {
    return this.running?.device;
  }

  /** What `sailfish._test.deviceLog` returns. */
  view(): { device?: string; running: boolean; lines: string[] } {
    return { ...(this.running ? { device: this.running.device } : {}), running: this.running !== undefined, lines: [...this.testLines] };
  }

  /** Streams `device`'s journal into the channel and reveals it; a stream already running there is only revealed, with a Stop offer. */
  async show(device: string, agent: AgentProbe): Promise<void> {
    if (this.running?.device === device) {
      this.getChannel().show(true);
      const choice = await this.services.prompts.showInformationMessage(`Sailfish: device logs are already streaming from "${device}".`, STOP_DEVICE_LOG);
      if (choice === STOP_DEVICE_LOG) this.stop();
      return;
    }
    this.stop();
    this.start(device, agent);
  }

  /** Ends the running stream, if any. */
  stop(): void {
    const r = this.running;
    if (!r) return;
    r.src.dispose();
    this.ended(r, '[stopped]');
  }

  private ended(r: Running, text: string | undefined): void {
    if (this.running !== r) return;
    this.running = undefined;
    if (text) this.line(text);
    r.finish();
  }

  private start(device: string, agent: AgentProbe): void {
    const format = chooseLogFormat(agent.state === 'running' ? agent.logFormats : undefined);
    let finish = (): void => undefined;
    const done = new Promise<void>((resolve) => (finish = resolve));
    // A device switch stops the registry entry, which disposes the source without an `onEnd`.
    const sessions = {
      register: (d: string, kind: Parameters<DeviceSessions['register']>[1], label: string, stop: () => Promise<void>, meta?: Parameters<DeviceSessions['register']>[4]) =>
        deviceSessions.register(
          d,
          kind,
          label,
          async () => {
            const r = this.running;
            if (r && r.src === src) this.ended(r, '[stopped]');
            await stop();
          },
          meta,
        ),
    } as unknown as DeviceSessions;
    const src = new JournalLogSource(this.services, {
      device,
      format,
      logLines: clampLogLines(this.services.settings.get('monitor.logLines')),
      clientArgs: this.clientArgs(),
      sessions,
    });
    const r: Running = { device, src, finish };
    this.running = r;
    const out = this.getChannel();
    out.clear();
    this.testLines.length = 0;
    this.line(`[streaming the journal of "${device}"; cancel the notification to stop]`);
    out.show(true);
    src.onEntries((batch) => {
      if (this.running !== r) return;
      for (const e of batch) this.line(formatEntryLine(e));
      for (const l of [...listeners]) l(device, batch);
    });
    src.onEnd((end) => this.onEnd(r, end));
    void src.start();
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Sailfish: streaming device logs from "${device}"`, cancellable: true },
      async (_progress, token) => {
        token.onCancellationRequested(() => {
          if (this.running === r) this.stop();
        });
        await done;
      },
    );
  }

  private onEnd(r: Running, end: LogEnd): void {
    r.src.dispose();
    if (end.reason === 'stopped') {
      this.ended(r, '[stopped]');
      return;
    }
    const text = end.text || 'the log stream ended';
    this.ended(r, `[${text}]`);
    if (end.reason === 'refused' || end.reason === 'error') {
      void this.services.prompts.showErrorMessage(`Sailfish: device logs from "${r.device}" stopped: ${text}`);
    }
  }
}

let current: DeviceLog | undefined;

export function activateDeviceLog(ctx: vscode.ExtensionContext, services: Services, clientArgs: () => string[]): DeviceLog {
  const log = new DeviceLog(ctx, services, clientArgs);
  current = log;
  ctx.subscriptions.push(
    { dispose: () => log.stop() },
  );
  if (process.env.TEST_MODE === 'full') {
    ctx.subscriptions.push(vscode.commands.registerCommand('sailfish._test.deviceLog', () => log.view()));
  }
  return log;
}

export function deviceLog(): DeviceLog {
  if (!current) throw new Error('device log is not active');
  return current;
}
