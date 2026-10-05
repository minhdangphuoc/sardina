import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { Services } from '../core/services';
import { NO_TIMEOUT } from '../sfdk/runner';
import {
  FpsMeter,
  LatestFrame,
  MIRROR_DEFAULTS,
  MIRROR_MIN_AGENT_VERSION,
  agentSupportsMirror,
  mirrorHtml,
  mirrorRequestArgs,
  parseMirrorLine,
} from './mirrorCore';
import { ensureAgent, installAgentOn, probe, requireDevice } from './deviceAgent';

/**
 * The screen mirror panel (view only): one WebviewPanel per device, fed by one long-lived
 * `sfdk device exec -- sailfish-devagent --request mirror` run that exists only while the panel is
 * visible. Frames are held to the latest one (see LatestFrame), so memory stays bounded.
 */

const INSTALL_AGENT = 'Install Device Agent';
const VIEW_TYPE = 'sailfish.mirror';
/** A quick switch to another tab does not tear the stream down. */
export const HIDE_GRACE_MS = 1500;
const MAX_CORRUPT_IN_A_ROW = 10;
const STATE_TICK_MS = 1000;

type SessionState = 'idle' | 'connecting' | 'live' | 'pausing' | 'paused' | 'disconnected' | 'disposed';

interface FrameMessage {
  type: 'frame';
  frame: number;
  format: 'jpeg' | 'png';
  data: string;
  screen: [number, number];
  size: [number, number];
}

export class MirrorSession {
  private state: SessionState = 'idle';
  private reason: string | undefined;
  private gen = 0;
  private cts: vscode.CancellationTokenSource | undefined;
  /** The current or last run; awaited before a new one starts so two streams never overlap. */
  private run: Promise<void> | undefined;
  private hideTimer: NodeJS.Timeout | undefined;
  private stateTimer: NodeJS.Timeout | undefined;
  private gate = new LatestFrame<FrameMessage>();
  private lastFrame: FrameMessage | undefined;
  private screen: [number, number] | undefined;
  private readonly meter = new FpsMeter();
  private gotStatus = false;
  private corrupt = 0;
  private softError: string | undefined;
  private lastStderr = '';
  /** Set by `fail`: the run was ended on purpose and the panel shows this as the disconnect reason. */
  private failReason: string | undefined;

  constructor(
    readonly device: string,
    readonly panel: vscode.WebviewPanel,
    private readonly services: Services,
    private readonly onGone: (s: MirrorSession) => void,
  ) {
    panel.onDidDispose(() => this.dispose());
    panel.onDidChangeViewState(() => {
      if (this.state === 'disposed') return;
      if (this.panel.visible) this.onVisible();
      else this.onHidden();
    });
    panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m));
  }

  /** Starts the stream unless one is running; also cancels a pending pause. */
  start(): void {
    if (this.state === 'disposed') return;
    this.clearHideTimer();
    if (this.state === 'pausing') {
      this.state = this.gotStatus ? 'live' : 'connecting';
      this.postState();
      return;
    }
    if (this.state === 'connecting' || this.state === 'live') return;
    this.begin();
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.log('closed');
    this.state = 'disposed';
    this.gen++;
    this.clearHideTimer();
    this.clearStateTimer();
    this.cts?.cancel();
    this.lastFrame = undefined;
    this.onGone(this);
    this.panel.dispose();
  }

  private onVisible(): void {
    // A disconnected panel stays so until the user presses Reconnect (no automatic retry).
    if (this.state === 'paused' || this.state === 'pausing' || this.state === 'idle') this.start();
  }

  private onHidden(): void {
    if (this.state !== 'connecting' && this.state !== 'live') return;
    this.state = 'pausing';
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined;
      if (this.state !== 'pausing') return;
      this.log('hidden, stopping the stream');
      this.state = 'paused';
      this.clearStateTimer();
      this.cts?.cancel();
    }, HIDE_GRACE_MS);
  }

  private onMessage(m: unknown): void {
    if (this.state === 'disposed' || typeof m !== 'object' || m === null) return;
    const type = (m as { type?: unknown }).type;
    if (type === 'ready') {
      // A (re)loaded page has nothing in flight and no image: start the gate over and show what we have.
      this.gate = new LatestFrame<FrameMessage>();
      this.postState();
      if (this.lastFrame) {
        const f = this.gate.offer(this.lastFrame);
        if (f) this.post(f);
      }
    } else if (type === 'shown') {
      const next = this.gate.acked();
      if (next) this.post(next);
    } else if (type === 'reconnect') {
      if (this.state === 'disconnected') this.begin();
    }
  }

  private begin(): void {
    const gen = ++this.gen;
    const previous = this.run;
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    this.state = 'connecting';
    this.reason = this.lastFrame ? 'reconnecting' : undefined;
    this.gotStatus = false;
    this.corrupt = 0;
    this.softError = undefined;
    this.lastStderr = '';
    this.failReason = undefined;
    this.gate = new LatestFrame<FrameMessage>();
    this.postState();
    this.clearStateTimer();
    this.stateTimer = setInterval(() => this.postState(), STATE_TICK_MS);
    this.log('starting the stream');

    const current = (async (): Promise<void> => {
      if (previous) await previous;
      if (gen !== this.gen || cts.token.isCancellationRequested) return;
      let exitCode = -1;
      let cancelled = false;
      try {
        const result = await this.services.runner.run({
          args: ['device', 'exec', '--', ...mirrorRequestArgs(MIRROR_DEFAULTS)],
          device: this.device,
          timeoutMs: NO_TIMEOUT,
          token: cts.token,
          collectOutput: false,
          onLine: (line, stream) => {
            if (gen !== this.gen) return;
            if (stream === 'stdout') this.onLine(line);
            else if (line.trim()) this.lastStderr = line.trim();
          },
        });
        exitCode = result.exitCode;
        cancelled = result.cancelled;
      } catch (err) {
        this.lastStderr = err instanceof Error ? err.message : String(err);
      } finally {
        cts.dispose();
      }
      if (gen !== this.gen || this.state === 'disposed') return;
      this.clearStateTimer();
      if (this.failReason === undefined && cancelled) return; // we stopped it: hidden (paused) or closed
      this.state = 'disconnected';
      this.reason = this.failReason ?? (this.lastStderr || `exit ${exitCode}`);
      this.log(`stream ended: ${this.reason}`);
      this.postState();
    })();
    this.run = current;
  }

  /** Ends the stream on purpose and shows `reason` as the disconnect reason once the run has ended. */
  private fail(reason: string): void {
    if (this.failReason !== undefined) return;
    this.failReason = reason;
    this.cts?.cancel();
    this.state = 'disconnected';
    this.reason = reason;
    this.clearStateTimer();
    this.postState();
  }

  private onLine(line: string): void {
    if (this.state === 'disposed' || this.failReason !== undefined) return;
    if (!line.trim()) return;
    const parsed = parseMirrorLine(line);
    if (!parsed) {
      if (++this.corrupt >= MAX_CORRUPT_IN_A_ROW) this.fail('corrupt stream');
      return;
    }
    this.corrupt = 0;
    switch (parsed.kind) {
      case 'fatal':
        this.fail(parsed.error);
        return;
      case 'status':
        this.gotStatus = true;
        this.markLive();
        return;
      case 'soft-error':
        this.gotStatus = true;
        this.softError = parsed.error;
        this.markLive();
        return;
      case 'same':
        this.meter.tick(Date.now());
        this.softError = undefined;
        this.markLive();
        return;
      case 'frame': {
        this.meter.tick(Date.now());
        this.softError = undefined;
        this.screen = parsed.screen;
        const msg: FrameMessage = {
          type: 'frame',
          frame: parsed.frame,
          format: parsed.format,
          data: parsed.data,
          screen: parsed.screen,
          size: parsed.size,
        };
        this.lastFrame = msg;
        const now = this.gate.offer(msg);
        if (now) this.post(now);
        this.markLive();
        return;
      }
    }
  }

  private markLive(): void {
    // 'pausing' keeps streaming until the grace ends; the state stays so the pause is not undone.
    if (this.state === 'connecting' || this.state === 'live') {
      this.state = 'live';
      this.gotStatus = true;
      this.reason = this.softError;
      this.postState();
    }
  }

  private postState(): void {
    if (this.state === 'disposed') return;
    this.send({
      type: 'state',
      state: this.state,
      reason: this.reason,
      fps: this.state === 'live' ? this.meter.fps(Date.now()) : undefined,
      screen: this.screen,
    });
  }

  private post(f: FrameMessage): void {
    this.send(f);
  }

  private send(message: unknown): void {
    if (this.state === 'disposed') return;
    void Promise.resolve(this.panel.webview.postMessage(message)).catch(() => undefined);
  }

  private clearHideTimer(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  }

  private clearStateTimer(): void {
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.stateTimer = undefined;
  }

  private log(what: string): void {
    this.services.output.log('info', `mirror "${this.device}": ${what}`);
  }
}

function openMirror(ctx: vscode.ExtensionContext, services: Services, sessions: Map<string, MirrorSession>) {
  return async (item?: unknown): Promise<void> => {
    const device = requireDevice(services, item);
    if (!device) return;
    const existing = sessions.get(device);
    if (existing) {
      existing.panel.reveal(undefined, false);
      return;
    }
    if (!(await ensureAgent(ctx, services, device))) return;

    let state = await probe(services, device);
    if (state.state !== 'running') return;
    if (!agentSupportsMirror(state.version)) {
      const choice = await services.prompts.showWarningMessage(
        `Sailfish: the device agent on "${device}" is ${state.version}; the screen mirror needs ${MIRROR_MIN_AGENT_VERSION}.`,
        INSTALL_AGENT,
      );
      if (choice !== INSTALL_AGENT) return;
      if (!(await installAgentOn(ctx, services, device))) return;
      state = await probe(services, device);
      if (state.state !== 'running' || !agentSupportsMirror(state.version)) return;
    }

    // Another invocation may have opened the panel while we were asking.
    const raced = sessions.get(device);
    if (raced) {
      raced.panel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Mirror: ${device}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: false },
    );
    panel.webview.html = mirrorHtml(randomBytes(16).toString('hex'), device);
    const session = new MirrorSession(device, panel, services, (s) => {
      if (sessions.get(s.device) === s) sessions.delete(s.device);
    });
    sessions.set(device, session);
    session.start();
  };
}

export function activateMirror(ctx: vscode.ExtensionContext, services: Services): void {
  const sessions = new Map<string, MirrorSession>();
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sailfish.agent.mirror', openMirror(ctx, services, sessions)),
    {
      dispose: () => {
        for (const s of [...sessions.values()]) s.dispose();
      },
    },
  );
}
