import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { deviceSessions } from '../core/deviceSessions';
import type { Services } from '../core/services';
import type { SfdkDeviceInfo } from '../core/types';
import {
  ByteRate,
  ClockOffset,
  DecodeErrors,
  FpsMeter,
  KeyframeRequests,
  KeepaliveSchedule,
  KeepaliveTrace,
  LatestFrame,
  MIRROR_MIN_AGENT_VERSION,
  MIRROR_TIMING,
  agentSupportsForward,
  agentSupportsInput,
  agentSupportsMirror,
  agentSupportsVideo,
  isJpeg,
  isVp8,
  latencyMs,
  mirrorHtml,
  pageCodecs,
  screenIdle,
  staleAgentReason,
  isStaleAgentReason,
  statusText,
  logText,
  stripParts,
  detailRows,
  detailsCopyText,
  controlState,
  hasReasonText,
  agentSupportsPhoneState,
  VIDEO_CODEC,
  type MirrorFormat,
  type MirrorStatus,
  type TouchIndicatorPath,
} from './mirrorCore';
import {
  FORWARD_FIRST_BYTE_MS,
  FORWARD_IDLE_MS,
  FORWARD_READY_TIMEOUT_MS,
  FORWARD_TIMING,
  ForwardTransport,
  MIRROR_VIDEO,
  SFDK_STDIN_KEEPALIVE,
  SfdkExecTransport,
  sfdkFallbackLease,
  type FrameEvent,
  type MirrorEnd,
  type MirrorSink,
  type MirrorTransport,
} from './mirrorTransport';
import { describeAgentRefusal, type AgentProbe, isPng } from './agentCore';
import { ensureAgent, installAgentOn, offerAgentUpdate, onAgentInstall, probe, requireDevice } from './deviceAgent';
import { cachedSocketPath, privateDir, readPinnedKeys, resolveDeviceEndpoint, sweepOrphans } from './sshForward';
import { forwardEligibility, hostKeyAlias } from './sshForwardCore';
import { scaledHeight, type AdaptCause, type AdaptDecision } from './mirrorAdapt';
import { LogRateLimiter, parseDecodingSize, sanitizeLogText } from './mirrorLog';
import { InputFocusSchedule, InputRateLimiter, captureAllowsInput, mapGesture, parseWebviewFocus, parseWebviewGesture, parseWebviewKey, phoneInputAccepted, supportsKeypad, supportsLiveContacts } from './mirrorInput';
import { KeypadLayouts } from './keypadLayout';
import type { KeypadInfo, KeypadLayout } from './keypadLayoutCore';

export { FORWARD_FIRST_BYTE_MS, FORWARD_IDLE_MS, FORWARD_READY_TIMEOUT_MS, FORWARD_TIMING, MIRROR_TIMING, SFDK_STDIN_KEEPALIVE };

/**
 * The screen mirror panel: one WebviewPanel per device, fed by one stream that exists only
 * while the panel is visible. The stream runs over an ssh socket forward (binary records) when the
 * agent and the device endpoint allow it, and over `sfdk device exec` (base64 lines) otherwise; see
 * mirrorTransport.ts. Frames are held to the latest one (see LatestFrame), so memory stays bounded.
 */

const INSTALL_AGENT = 'Install Device Agent';
const VIEW_TYPE = 'sailfish.mirror';
/** The agent's reason when the phone's "control" switch is off, and the strip's words for it. */
const CONTROL_OFF_WIRE = 'control disabled on the phone';
const CONTROL_OFF_TEXT = 'disabled on the phone';
/** A quick switch to another tab does not tear the stream down. */
export const HIDE_GRACE_MS = 1500;
const MAX_CORRUPT_IN_A_ROW = 10;
const STATE_TICK_MS = 1000;
const LATENCY_WINDOW_MS = 3000;
const MAX_PENDING_PINGS = 8;
/** How long a run waits for the page to report its codecs before it streams JPEG. */
const CODECS_WAIT_MS = 3000;
/**
 * VP8 frames posted to the page and not yet consumed. Video frames cannot be dropped one by one
 * (the next delta needs them), so past this the panel skips to the next key frame and asks for one.
 */
const MAX_VIDEO_IN_FLIGHT = 30;

type SessionState = 'idle' | 'connecting' | 'live' | 'pausing' | 'paused' | 'disconnected' | 'disposed';
type RunningProbe = Extract<AgentProbe, { state: 'running' }>;

interface FrameMessage {
  type: 'frame';
  frame: number;
  format: MirrorFormat;
  bytes: Uint8Array;
  screen: [number, number];
  size: [number, number];
  /** VP8 only. */
  key?: boolean;
  pts?: number;
}

/** A plain Uint8Array over exactly the frame's bytes (a pooled Buffer would clone its whole pool when posted). */
function toBytes(buf: Buffer): Uint8Array {
  return buf.buffer.byteLength === buf.length ? new Uint8Array(buf.buffer, buf.byteOffset, buf.length) : Uint8Array.from(buf);
}

export interface MirrorSessionOptions {
  /** The agent's ping answer, cached for the panel's lifetime (re-show and Reconnect skip the ping). */
  probe: RunningProbe;
  /** The ssh forward transport, or undefined where it cannot be used (Windows). */
  forward?: ForwardTransport;
  /** The device's ssh endpoint, resolved at most once. */
  getEndpoint: () => Promise<SfdkDeviceInfo | undefined>;
  /** The strip's Update agent action: runs the install flow for this device. */
  updateAgent?: () => Promise<unknown>;
  keypadLayouts: KeypadLayouts;
  keypadContextChanged: () => void;
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
  /** Set by `fail`: the run was ended on purpose and the panel shows this as the disconnect reason. */
  private failReason: string | undefined;
  /** The forward failed before the stream was live: not tried again until the panel is reopened (plan O4). */
  private forwardFailed = false;
  private transport: MirrorTransport | undefined;
  private transportKind: 'ssh' | 'sfdk' | undefined;
  private fallbackReason: string | undefined;
  private capture: 'native' | 'screenshot' | undefined;
  /** The phone has turned control off (status or `settings` message); undefined otherwise. */
  private controlOffReason: string | undefined;
  private leaseActive = false;
  private frameMs: number | undefined;
  /** The last image's size and quality, for the strip. */
  private image: { width: number; height: number; quality?: number } | undefined;
  /** The stream's requested quality (status line): the quality of frames whose header has no `q`. */
  private statusQuality: number | undefined;
  /** The stream's requested width (status line; 0 = native). */
  private statusWidth: number | undefined;
  private clock = new ClockOffset();
  private latencies: { at: number; ms: number }[] = [];
  /** The codecs the page reported (`ready`); undefined until it has. */
  private codecs: string[] | undefined;
  private codecWaiters: (() => void)[] = [];
  /** Video failed to decode in this panel: JPEG from now on. */
  private videoOff = false;
  private readonly decodeErrors = new DecodeErrors();
  private keyframes = new KeyframeRequests();
  private byteRate = new ByteRate();
  /** The format of the last frame (or `vp8` from the status line). */
  private codec: MirrorFormat | undefined;
  /** The stream's target bitrate (status line, VP8). */
  private statusBitrate: number | undefined;
  /** The stream's requested frame rate (status line). */
  private statusFps: number | undefined;
  /** The last VP8 frame's size and target bitrate, for the strip. */
  private video: { width: number; height: number; targetKbps?: number } | undefined;
  /** When the last image that showed a screen change arrived, and the last sign of an unchanged screen. */
  private lastChangeAt: number | undefined;
  private lastSameAt: number | undefined;
  /** The causes of the adaptive reductions in effect (the controller's last decision). */
  private adaptLimits: AdaptCause[] | undefined;
  private videoInFlight = 0;
  /** Skipping VP8 frames until the next key frame (the page fell behind). */
  private videoSkipping = false;
  private videoDropped = 0;
  private decodingSize: string | undefined;
  /** When the next full strip goes to the log (see MIRROR_TIMING.statsFirstMs). */
  private statsAt: number | undefined;
  private readonly pingSent = new Map<number, number>();
  private readonly keepaliveTrace = new KeepaliveTrace();
  private lastLoggedStatus: string | undefined;
  private readonly keepalive: KeepaliveSchedule;
  private readonly inputFocus: InputFocusSchedule;
  private readonly inputRate = new InputRateLimiter();
  private readonly copyRate = new LogRateLimiter(3, 2000);
  private readonly inputFocusRate = new InputRateLimiter();
  private readonly webviewLogRate = new LogRateLimiter();
  private inputAccepted = false;
  /** False until a valid frame explicitly reports fixed-panel native capture. */
  private inputCaptureSafe = false;
  private webviewFocused = false;
  private controlPosted: boolean | undefined;
  private phoneTouchIndicator = false;
  private touchIndicatorPath: TouchIndicatorPath = 'off';
  private touchIndicatorPathReported = false;
  private touchIndicatorPosted: TouchIndicatorPath | undefined;
  private keypadLayout: KeypadLayout | undefined;
  private keypadConfigured = false;
  /** An agent install is running (see agentInstalling). */
  private agentUpdating = false;
  /** The stream ended during that install and waits for it. */
  private waitingForAgent = false;
  private registration: { dispose(): void } | undefined;
  private forwardDisposal: Promise<void> | undefined;

  constructor(
    readonly device: string,
    readonly panel: vscode.WebviewPanel,
    private readonly services: Services,
    private readonly opts: MirrorSessionOptions,
    private readonly onGone: (s: MirrorSession) => void,
  ) {
    this.keepalive = new KeepaliveSchedule((seq) => this.sendKeepalive(seq));
    this.inputFocus = new InputFocusSchedule((active) => this.transport?.inputActive(active));
    this.registration = deviceSessions.register(this.device, 'mirror', 'screen mirror', () => this.stopForDeviceSwitch());
    panel.onDidDispose(() => this.dispose());
    panel.onDidChangeViewState(() => {
      if (this.state === 'disposed') return;
      if (!this.panel.visible || !this.panel.active) this.webviewFocused = false;
      if (this.panel.visible) this.onVisible();
      else this.onHidden();
      this.syncInput();
      this.opts.keypadContextChanged();
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
    this.transport?.inputActive(false);
    this.inputFocus.dispose();
    this.keepalive.dispose();
    this.cts?.cancel();
    this.lastFrame = undefined;
    this.registration?.dispose();
    this.registration = undefined;
    this.forwardDisposal ??= this.opts.forward?.dispose() ?? Promise.resolve();
    this.onGone(this);
    this.panel.dispose();
    this.opts.keypadContextChanged();
  }

  private async stopForDeviceSwitch(): Promise<void> {
    this.dispose();
    await this.run;
    await this.forwardDisposal;
  }

  /**
   * The agent is being installed over the running one (agent update): its restart ends the stream,
   * which then waits for `agentInstalled` instead of showing a disconnect.
   */
  agentInstalling(): void {
    if (this.state === 'disposed') return;
    this.agentUpdating = true;
  }

  /** The install announced by `agentInstalling` ended: connect to the new agent, or show why not. */
  agentInstalled(next: AgentProbe | undefined): void {
    if (this.state === 'disposed') return;
    const waiting = this.waitingForAgent;
    this.agentUpdating = false;
    this.waitingForAgent = false;
    if (next?.state === 'running') {
      this.agentUpgraded(next);
      return;
    }
    if (waiting && this.state === 'connecting') {
      this.state = 'disconnected';
      this.reason = 'the agent update did not finish';
      this.log(`stream ended: ${this.reason}`);
      this.postState();
    }
  }

  /** The agent was upgraded while the panel is open: use the new probe and connect again (the forward may be used now). */
  agentUpgraded(next: RunningProbe): void {
    if (this.state === 'disposed') return;
    this.agentUpdating = false;
    this.waitingForAgent = false;
    this.opts.probe = next;
    this.forwardFailed = false;
    void this.refreshKeypad();
    // The previous run is cancelled first (begin() then waits for it); a hidden panel only starts on its next show.
    this.transport?.inputActive(false);
    this.cts?.cancel();
    if (this.panel.visible) {
      this.clearHideTimer();
      this.begin();
      return;
    }
    this.gen++;
    this.clearHideTimer();
    this.clearStateTimer();
    this.state = 'paused';
    this.syncKeepalive();
    this.syncInput();
  }

  /** For deactivate: also kills the ssh process synchronously. */
  disposeNow(): void {
    this.dispose();
    this.opts.forward?.closeSync();
  }

  /** Full integration-suite seam: injects the same untrusted message shape a focused page sends. */
  inputForTest(message: unknown): void {
    if (process.env.TEST_MODE === 'full') this.onMessage(message);
  }

  keypadInfo(): KeypadInfo | undefined {
    // The keypad is shown only with the `key` capability, so an agent without the key path never gets presses.
    return supportsKeypad(this.opts.probe.mirrorInput) ? this.opts.probe.keypad : undefined;
  }

  async refreshKeypad(): Promise<void> {
    const info = this.keypadInfo();
    const resolved = info ? await this.opts.keypadLayouts.resolve(info) : { configured: false };
    if (this.state === 'disposed') return;
    this.keypadConfigured = resolved.configured;
    this.keypadLayout = resolved.layout;
    this.postKeypad();
    this.postState();
    this.opts.keypadContextChanged();
  }

  /** Full integration-suite seam: focus is otherwise owned by Electron and cannot be made deterministic. */
  focusForTest(focused: boolean): void {
    if (process.env.TEST_MODE !== 'full' || this.state === 'disposed') return;
    this.webviewFocused = focused;
    this.syncInput();
  }

  /** S11 hook for the transport's live phone-settings event. */
  onPhoneSettings(settings: { input?: boolean; inputLease?: number }): void {
    if (settings.input === undefined) return;
    this.inputAccepted = phoneInputAccepted(agentSupportsInput(this.opts.probe), settings.input, settings.inputLease);
    this.syncInput();
  }

  private onVisible(): void {
    // A disconnected panel stays so until the user presses Reconnect (no automatic retry).
    if (this.state === 'paused' || this.state === 'pausing' || this.state === 'idle') this.start();
    this.syncKeepalive();
    this.syncInput();
  }

  private onHidden(): void {
    // Keepalives stop at once, even inside the grace, before the connection is closed.
    this.syncKeepalive();
    this.syncInput();
    if (this.state !== 'connecting' && this.state !== 'live') return;
    this.state = 'pausing';
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined;
      if (this.state !== 'pausing') return;
      this.log('hidden, stopping the stream');
      this.state = 'paused';
      this.clearStateTimer();
      this.transport?.inputActive(false);
      this.cts?.cancel();
      this.syncKeepalive();
      this.syncInput();
    }, HIDE_GRACE_MS);
  }

  private onMessage(m: unknown): void {
    if (this.state === 'disposed' || typeof m !== 'object' || m === null) return;
    const type = (m as { type?: unknown }).type;
    if (type === 'ready') {
      this.controlPosted = undefined; // a reloaded page has not received the previous control state
      this.touchIndicatorPosted = undefined;
      const readyFocused = (m as { focused?: unknown }).focused === true;
      this.webviewFocused = readyFocused && this.inputFocusRate.allow(Date.now());
      const first = this.codecs === undefined;
      this.codecs = pageCodecs(m);
      if (first) this.log(`the panel decodes ${this.codecs.length > 0 ? this.codecs.join(', ') : 'no video codec'}`);
      for (const w of this.codecWaiters.splice(0)) w();
      // A (re)loaded page has nothing in flight and no image: start the gate over and show what we have.
      this.gate = new LatestFrame<FrameMessage>();
      this.videoInFlight = 0;
      this.decodingSize = undefined;
      this.postState();
      if (this.lastFrame) {
        const f = this.gate.offer(this.lastFrame);
        if (f) this.post(f);
      }
      // A new page has no decoder state: the stream continues from a key frame.
      if (this.codec === 'vp8' && this.gotStatus) {
        this.videoSkipping = true;
        this.requestKeyframe('the panel was reloaded');
      }
      this.syncInput();
      this.postKeypad();
    } else if (type === 'shown') {
      if (this.codec === 'vp8') {
        this.videoInFlight = Math.max(0, this.videoInFlight - 1);
        return;
      }
      const next = this.gate.acked();
      if (next) this.post(next);
    } else if (type === 'keyframe') {
      const reason = typeof (m as { reason?: unknown }).reason === 'string' ? sanitizeLogText((m as { reason: string }).reason) : 'requested';
      if (reason.startsWith('decode error') && this.decodeErrors.add(Date.now()) && !this.videoOff) {
        this.videoOff = true;
        this.services.output.log('warn', `mirror "${this.device}": video does not decode in this panel (${reason}); reconnecting with JPEG`);
        this.cts?.cancel();
        this.begin();
        return;
      }
      this.requestKeyframe(reason);
    } else if (type === 'decoding') {
      const o = m as { width?: unknown; height?: unknown };
      const size = parseDecodingSize(o.width, o.height);
      if (size !== undefined && size !== this.decodingSize) {
        this.decodingSize = size;
        if (this.webviewLogRate.allow(Date.now())) this.log(`video: decoding ${size}`);
      }
    } else if (type === 'focus') {
      const focused = parseWebviewFocus(m);
      if (focused === undefined || (focused && !this.inputFocusRate.allow(Date.now()))) return;
      this.webviewFocused = focused;
      this.syncInput();
    } else if (type === 'input') {
      const key = parseWebviewKey(m);
      const gesture = key ? undefined : parseWebviewGesture(m);
      // A valid release is fail-open. Everything else, including malformed messages that merely
      // claim to be a release, consumes the bounded gesture budget before it can be acted on.
      if (gesture?.type !== 'up' && key?.pressed !== false && !this.inputRate.allow(Date.now())) return;
      if ((!gesture && !key) || !this.inputOn()) return;
      if (key) {
        const keypad = this.keypadInfo();
        if (keypad?.keys.includes(key.key)) this.transport?.input(key);
        return;
      }
      if (!gesture) return;
      if (gesture.type === 'up') {
        this.transport?.input({ type: 'up' });
        return;
      }
      if (!this.screen || gesture.screen[0] !== this.screen[0] || gesture.screen[1] !== this.screen[1]) return;
      const input = mapGesture(gesture, gesture.screen);
      if (input) this.transport?.input(input);
    } else if (type === 'reconnect') {
      if (this.state === 'disconnected') this.begin();
    } else if (type === 'updateAgent') {
      // Offered by the strip only over the sfdk path with an outdated agent; the install flow asks for consent itself.
      if (this.state === 'live' && this.transportKind === 'sfdk' && isStaleAgentReason(this.fallbackReason)) void this.opts.updateAgent?.()?.catch(() => undefined);
    } else if (type === 'editKeypadLayout') {
      const info = this.keypadInfo();
      if (info) void this.opts.keypadLayouts.edit(info).then((changed) => changed ? this.refreshKeypad() : undefined);
    } else if (type === 'copyDetails') {
      // The host builds the text from its own state: the page sends nothing to copy.
      if (this.state === 'live' && this.copyRate.allow(Date.now())) {
        void Promise.resolve(vscode.env.clipboard.writeText(detailsCopyText(detailRows(this.status(Date.now()), this.controlPosted === true)))).catch(() => undefined);
      }
    }
  }

  private requestKeyframe(reason: string): void {
    if (!this.transport?.requestKeyframe || !this.keyframes.want(Date.now())) return;
    const n = this.keyframes.count;
    if ((n <= 3 || n % 20 === 0) && this.webviewLogRate.allow(Date.now())) this.log(`video: key frame requested (${reason}; ${n} this stream)`);
    this.transport.requestKeyframe();
  }

  /** The page's codecs, waiting at most CODECS_WAIT_MS for its first report. */
  private pageDecodes(codec: string, token: vscode.CancellationToken): Promise<boolean> {
    if (this.codecs !== undefined) return Promise.resolve(this.codecs.includes(codec));
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sub.dispose();
        resolve(this.codecs?.includes(codec) ?? false);
      };
      const timer = setTimeout(finish, CODECS_WAIT_MS);
      const sub = token.onCancellationRequested(finish);
      this.codecWaiters.push(finish);
    });
  }

  /** Whether this run asks for VP8: the agent offers it, the page decodes it and it has not failed here. */
  private async wantVideo(token: vscode.CancellationToken): Promise<boolean> {
    if (!MIRROR_VIDEO || this.videoOff || !agentSupportsVideo(this.opts.probe)) return false;
    const ok = await this.pageDecodes(VIDEO_CODEC, token);
    if (!ok) this.log('video not used: the panel cannot decode VP8; using JPEG');
    return ok;
  }

  private begin(): void {
    // Explicit safety-off before replacing a run. This is intentionally sent even if host focus
    // bookkeeping already says off; false bypasses the agent's rate limit.
    this.transport?.inputActive(false);
    const gen = ++this.gen;
    const previous = this.run;
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    this.state = 'connecting';
    this.reason = this.lastFrame ? 'reconnecting' : undefined;
    this.gotStatus = false;
    this.corrupt = 0;
    this.softError = undefined;
    this.failReason = undefined;
    this.leaseActive = false;
    this.inputAccepted = false;
    this.inputCaptureSafe = false;
    this.phoneTouchIndicator = false;
    this.touchIndicatorPath = 'off';
    this.touchIndicatorPathReported = false;
    this.inputFocus.update(false);
    this.postControl(false);
    this.frameMs = undefined;
    this.lastChangeAt = undefined;
    this.lastSameAt = undefined;
    this.adaptLimits = undefined;
    this.image = undefined;
    this.statusQuality = undefined;
    this.statusWidth = undefined;
    this.clock = new ClockOffset();
    this.latencies = [];
    this.pingSent.clear();
    this.gate = new LatestFrame<FrameMessage>();
    this.keyframes = new KeyframeRequests();
    this.byteRate = new ByteRate();
    this.codec = undefined;
    this.statusBitrate = undefined;
    this.statusFps = undefined;
    this.video = undefined;
    this.videoInFlight = 0;
    this.videoSkipping = false;
    this.videoDropped = 0;
    this.statsAt = undefined;
    this.postState();
    this.clearStateTimer();
    this.stateTimer = setInterval(() => this.postState(), STATE_TICK_MS);
    this.log('starting the stream');

    const current = (async (): Promise<void> => {
      if (previous) await previous;
      if (gen !== this.gen || cts.token.isCancellationRequested) return;
      let end: MirrorEnd = { cancelled: false };
      let error: string | undefined;
      try {
        end = await this.runTransports(gen, cts.token);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        cts.dispose();
      }
      if (gen !== this.gen || this.state === 'disposed') return;
      this.clearStateTimer();
      this.inputAccepted = false;
      this.syncInput();
      this.transport = undefined;
      this.gotStatus = false;
      this.syncKeepalive();
      const cancelled = 'cancelled' in end && end.cancelled;
      if (this.failReason === undefined && cancelled) return; // we stopped it: hidden (paused) or closed
      if (this.agentUpdating) {
        // The update restarted the agent: connect again once it answers (agentInstalled), without a
        // disconnect the user would answer with Reconnect while the update reconnects as well.
        this.waitingForAgent = true;
        this.state = 'connecting';
        this.reason = 'the agent is being updated';
        this.log(`stream ended: ${this.reason}; connecting again when it is back`);
        this.postState();
        return;
      }
      this.state = 'disconnected';
      this.reason = this.failReason ?? error ?? ('reason' in end ? end.reason : undefined) ?? 'the stream ended';
      this.log(`stream ended: ${this.reason}`);
      this.postState();
    })();
    this.run = current;
  }

  /** The ssh forward when it can be used, with the sfdk transport as the fallback for anything before the stream is live. */
  private async runTransports(gen: number, token: vscode.CancellationToken): Promise<MirrorEnd> {
    if (!this.forwardFailed) this.fallbackReason = undefined; // after a failure it keeps naming the class
    const forward = this.opts.forward;
    if (forward && !this.forwardFailed) {
      const unavailable = await this.forwardUnavailable(forward);
      if (unavailable === undefined) {
        forward.setVideo(await this.wantVideo(token));
        forward.setInput(agentSupportsInput(this.opts.probe));
        forward.setIdlePause(!this.services.settings.get('mirror.idleStreaming'));
        forward.setPhoneState(agentSupportsPhoneState(this.opts.probe.version), os.hostname());
        if (token.isCancellationRequested || gen !== this.gen) return { cancelled: true };
        const end = await this.runOne(forward, gen, token);
        if (!('setupFailed' in end)) return end;
        if (token.isCancellationRequested || gen !== this.gen) return { cancelled: true };
        this.forwardFailed = true;
        this.fallbackReason = `ssh forward unavailable — ${end.setupFailed}`;
        this.log(`ssh forward unavailable (${end.setupFailed}: ${end.detail}); using sfdk device exec`);
      } else {
        this.fallbackReason = unavailable;
        this.log(`ssh forward not used (${unavailable}); using sfdk device exec`);
      }
    }
    if (token.isCancellationRequested || gen !== this.gen) return { cancelled: true };
    return this.runOne(
      new SfdkExecTransport(
        this.services,
        this.device,
        sfdkFallbackLease(this.opts.probe.version),
        agentSupportsInput(this.opts.probe),
        agentSupportsPhoneState(this.opts.probe.version) ? { phoneState: true, client: os.hostname() } : {},
      ),
      gen,
      token,
    );
  }

  /** Why the forward cannot be used for this panel, or undefined when it can (the target socket is then set). */
  private async forwardUnavailable(forward: ForwardTransport): Promise<string | undefined> {
    if (!agentSupportsForward(this.opts.probe.version)) return staleAgentReason(this.opts.probe.version);
    const endpoint = await this.opts.getEndpoint();
    if (!endpoint) return 'the device endpoint (host, port, user, key) is not known';
    const eligibility = forwardEligibility(endpoint, this.opts.probe, process.platform);
    if (!eligibility.ok) return eligibility.reason;
    forward.setTarget(eligibility.remoteSocket);
    return undefined;
  }

  private runOne(transport: MirrorTransport, gen: number, token: vscode.CancellationToken): Promise<MirrorEnd> {
    this.transport = transport;
    this.transportKind = transport.kind;
    return transport.run(this.makeSink(gen), token);
  }

  private makeSink(gen: number): MirrorSink {
    const live = (): boolean => gen === this.gen && this.state !== 'disposed' && this.failReason === undefined;
    return {
      status: (s) => {
        if (!live()) return;
        this.corrupt = 0;
        this.gotStatus = true;
        // Over ssh the lease is always on; over sfdk only when the agent reports one.
        this.leaseActive = this.transportKind === 'ssh' || s.lease !== undefined;
        this.statusQuality = s.quality;
        this.statusWidth = s.width;
        this.statusBitrate = s.bitrate;
        this.statusFps = s.fps;
        this.inputAccepted = phoneInputAccepted(agentSupportsInput(this.opts.probe), s.input, s.inputLease);
        if (agentSupportsInput(this.opts.probe) && !this.inputAccepted && s.inputError) {
          this.services.output.log('warn', `mirror "${this.device}": control unavailable: ${s.inputError}`);
        }
        this.controlOffReason = s.input === false && s.inputError === CONTROL_OFF_WIRE ? CONTROL_OFF_TEXT : undefined;
        if (s.encoding === 'vp8') {
          this.codec = 'vp8';
          this.videoInFlight = 0;
          this.videoSkipping = false;
          this.send({ type: 'reset' }); // a new stream starts with a key frame
          this.log(`video: vp8, ${s.fps} fps, ${s.width > 0 ? `width ${s.width}` : 'native width'}, ${s.bitrate ?? '?'} kbit/s`);
        }
        if (s.adapt) this.log('adaptive quality on');
        this.markLive();
        this.syncKeepalive();
        this.syncInput();
      },
      settings: (s) => {
        if (!live()) return;
        this.corrupt = 0;
        const off = s.control === false || (s.input === false && s.inputError === CONTROL_OFF_WIRE);
        const on = s.control === true || s.input === true;
        const before = this.controlOffReason !== undefined;
        if (off) this.controlOffReason = CONTROL_OFF_TEXT;
        else if (on) this.controlOffReason = undefined;
        if ((this.controlOffReason !== undefined) !== before) {
          this.services.output.log('info', `mirror "${this.device}": control ${off ? 'turned off on the phone' : 'turned on again on the phone'}`);
        }
        if (s.touchIndicator !== undefined) this.phoneTouchIndicator = s.touchIndicator;
        if (s.touchIndicatorPath !== undefined) {
          this.touchIndicatorPath = s.touchIndicatorPath;
          this.touchIndicatorPathReported = true;
        }
        this.onPhoneSettings(s);
        this.postTouchIndicator();
        this.postState();
      },
      contact: (contact) => {
        if (!live() || !this.inputOn() || !this.screen) return;
        if (contact.x >= this.screen[0] || contact.y >= this.screen[1]) return;
        this.touchIndicatorPath = 'mirror';
        this.touchIndicatorPathReported = true;
        this.postTouchIndicator();
        this.send({ type: 'contact', x: contact.x, y: contact.y, down: contact.down, screen: this.screen });
        this.postState();
      },
      frame: (f) => {
        if (live()) this.onFrame(f);
      },
      same: () => {
        if (!live()) return;
        this.corrupt = 0;
        // An unchanged screen (agent 1.8.0 also says so once a second while idle): not a frame.
        this.lastSameAt = Date.now();
        this.softError = undefined;
        this.gotStatus = true;
        this.markLive();
      },
      softError: (f) => {
        if (!live()) return;
        this.corrupt = 0;
        this.gotStatus = true;
        this.softError = f.error;
        this.markLive();
      },
      pong: (seq, deviceTs) => {
        if (!live()) return;
        this.corrupt = 0;
        const sent = this.pingSent.get(seq);
        if (sent === undefined) return;
        this.pingSent.delete(seq);
        this.clock.addPong(sent, deviceTs, Date.now());
      },
      fatal: (error) => {
        // The strip words the phone's own refusals itself (`REASON_TEXT`); other reasons get the plain-language text.
        if (live()) this.fail(hasReasonText(error) ? error : describeAgentRefusal(error));
      },
      corrupt: () => {
        if (live()) this.onCorrupt();
      },
      adapted: (d) => {
        if (live()) this.onAdapted(d);
      },
    };
  }

  private onAdapted(d: AdaptDecision): void {
    const screen = this.screen;
    const size = screen ? `${d.width}x${scaledHeight(d.width, screen[0], screen[1])}` : `width ${d.width}`;
    const level = this.codec === 'vp8' ? `${d.quality} kbit/s` : `q${d.quality}`;
    this.adaptLimits = d.limits;
    const cause = d.cause === 'cpu' ? 'the phone CPU' : 'the link';
    this.log(`adaptive quality ${d.direction} to ${size} ${level} for ${cause} (level ${d.level + 1} of ${d.levels}: ${d.reason})`);
  }

  /** The shown image is below what the stream asked for (adaptive quality stepped down). */
  private imageReduced(image: { width: number; quality?: number }): boolean {
    const screenWidth = this.screen?.[0];
    const ceiling = this.statusWidth && screenWidth ? Math.min(this.statusWidth, screenWidth) : (this.statusWidth || screenWidth);
    return (
      (image.quality !== undefined && this.statusQuality !== undefined && image.quality < this.statusQuality) ||
      (ceiling !== undefined && image.width < ceiling)
    );
  }

  /** The VP8 frames are below what the stream asked for: a smaller width (sides are even) or bitrate. */
  private videoReduced(v: { width: number; targetKbps?: number }): boolean {
    const screenWidth = this.screen?.[0];
    const ceiling = this.statusWidth && screenWidth ? Math.min(this.statusWidth, screenWidth) : (this.statusWidth || screenWidth);
    return (
      (v.targetKbps !== undefined && this.statusBitrate !== undefined && v.targetKbps < this.statusBitrate) ||
      (ceiling !== undefined && v.width < ceiling - (ceiling % 2))
    );
  }

  private onCorrupt(): void {
    if (++this.corrupt >= MAX_CORRUPT_IN_A_ROW) this.fail('corrupt stream');
  }

  private onFrame(f: FrameEvent): void {
    // The image magic is checked before anything is displayed (plan S10).
    const video = f.format === 'vp8';
    const valid = video ? isVp8(f.payload, f.key === true) : f.format === 'png' ? isPng(f.payload) : isJpeg(f.payload);
    if (!valid) {
      this.onCorrupt();
      if (video) {
        // The frames after it build on it: skip to the next key frame.
        this.videoSkipping = true;
        this.requestKeyframe('a frame failed the format check');
      }
      return;
    }
    this.corrupt = 0;
    const now = Date.now();
    if (f.refresh) {
      this.lastSameAt = now; // the idle screen sharpened: shown, but not a screen change
    } else {
      this.meter.tick(now, f.ts);
      this.lastChangeAt = now;
    }
    this.byteRate.add(now, f.payload.length);
    this.softError = undefined;
    this.screen = f.screen;
    this.codec = f.format;
    if (video) {
      this.image = undefined;
      this.video = { width: f.size[0], height: f.size[1], targetKbps: f.kbps ?? this.statusBitrate };
    } else {
      this.video = undefined;
      this.image = { width: f.size[0], height: f.size[1], quality: f.format === 'jpeg' ? (f.q ?? this.statusQuality) : undefined };
    }
    const inputCaptureSafe = captureAllowsInput(f.capture);
    if (inputCaptureSafe !== this.inputCaptureSafe) {
      this.inputCaptureSafe = inputCaptureSafe;
      this.syncInput(); // screenshot fallback revokes the device lease and page control immediately
    }
    if (f.capture !== this.capture) {
      this.capture = f.capture;
      if (f.capture) this.log(`capture path: ${f.capture}`);
    }
    if (f.cms !== undefined || f.ems !== undefined) this.frameMs = (f.cms ?? 0) + (f.ems ?? 0);
    const offset = this.clock.offsetMs;
    if (this.transportKind === 'ssh' && offset !== undefined) {
      this.latencies.push({ at: now, ms: latencyMs(f.ts, now, offset) });
    }
    const msg: FrameMessage = {
      type: 'frame',
      frame: f.frame,
      format: f.format,
      bytes: toBytes(f.payload),
      screen: f.screen,
      size: f.size,
    };
    if (video) {
      msg.key = f.key;
      msg.pts = f.pts;
      this.postVideo(msg);
    } else {
      this.lastFrame = msg;
      const next = this.gate.offer(msg);
      if (next) this.post(next);
    }
    this.gotStatus = true;
    this.markLive();
  }

  /**
   * Every VP8 frame goes to the page in order (a delta needs the frames before it). When the page
   * falls behind, frames are skipped up to the next key frame, which is asked for at once.
   */
  private postVideo(msg: FrameMessage): void {
    // A delta is useless without the frames before it; a re-shown panel has no image to keep either.
    this.lastFrame = undefined;
    if (msg.key) {
      this.keyframes.keyReceived();
      this.videoSkipping = false;
    }
    if (!this.videoSkipping && this.videoInFlight >= MAX_VIDEO_IN_FLIGHT) {
      this.videoSkipping = true;
      this.requestKeyframe('the panel fell behind');
    }
    if (this.videoSkipping) {
      this.videoDropped++;
      return;
    }
    this.videoInFlight++;
    this.post(msg);
  }

  /** Ends the stream on purpose and shows `reason` as the disconnect reason once the run has ended. */
  private fail(reason: string): void {
    if (this.failReason !== undefined) return;
    if (reason === 'lease expired') {
      const ageMs = this.keepaliveTrace.ageMs(Date.now());
      const age = ageMs === undefined ? 'no keepalive was sent' : `last on-time keepalive ${Math.round(ageMs / 1000)} s ago`;
      this.services.output.log('warn', `mirror "${this.device}": the device ended the stream: lease expired (${age}); the extension host may have stalled or the upstream is broken`);
    }
    this.failReason = reason;
    this.state = 'disconnected';
    this.reason = reason;
    this.clearStateTimer();
    this.syncKeepalive();
    this.syncInput();
    this.transport?.inputActive(false);
    this.cts?.cancel();
    this.postState();
  }

  private markLive(): void {
    // 'pausing' keeps streaming until the grace ends; the state stays so the pause is not undone.
    if (this.state === 'connecting' || this.state === 'live') {
      this.state = 'live';
      this.gotStatus = true;
      this.reason = undefined;
      this.postState();
    }
  }

  /** Keepalives run while the stream is up with a lease, the state is active and the panel is visible. */
  private syncKeepalive(): void {
    const active = this.state === 'connecting' || this.state === 'live' || this.state === 'pausing';
    this.keepalive.update({ streaming: this.gotStatus && this.leaseActive && active, visible: this.panel.visible });
  }

  private sendKeepalive(seq: number): void {
    const now = Date.now();
    this.keepaliveTrace.record(now);
    this.pingSent.set(seq, now);
    if (this.pingSent.size > MAX_PENDING_PINGS) {
      const oldest = this.pingSent.keys().next().value;
      if (oldest !== undefined) this.pingSent.delete(oldest);
    }
    this.transport?.keepalive(seq);
  }

  private inputOn(): boolean {
    return (
      this.inputAccepted &&
      this.inputCaptureSafe &&
      this.state === 'live' &&
      this.panel.visible &&
      this.panel.active &&
      this.webviewFocused
    );
  }

  /** The host and device both gate input; closing any focus/visibility gate sends false at once. */
  private syncInput(): void {
    const on = this.inputOn();
    this.inputFocus.update(on);
    this.postControl(on);
    this.postTouchIndicator();
  }

  private postControl(enabled: boolean): void {
    if (this.controlPosted === enabled) return;
    this.controlPosted = enabled;
    this.send({ type: 'control', enabled, liveContacts: supportsLiveContacts(this.opts.probe.mirrorInput) });
  }

  private effectiveTouchIndicatorPath(): TouchIndicatorPath {
    if (this.state !== 'live' || this.controlPosted !== true) return 'off';
    if (this.touchIndicatorPathReported) return this.touchIndicatorPath;
    return this.phoneTouchIndicator ? 'phone' : 'off';
  }

  private postTouchIndicator(): void {
    const path = this.effectiveTouchIndicatorPath();
    if (this.touchIndicatorPosted === path) return;
    this.touchIndicatorPosted = path;
    this.send({ type: 'touchIndicator', path });
  }

  private postKeypad(): void {
    this.send({ type: 'keypad', layout: this.keypadLayout ?? null });
  }

  private medianLatency(now: number): number | undefined {
    this.latencies = this.latencies.filter((l) => now - l.at <= LATENCY_WINDOW_MS);
    if (this.latencies.length === 0) return undefined;
    const sorted = this.latencies.map((l) => l.ms).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private status(now: number): MirrorStatus {
    const live = this.state === 'live';
    return {
      state: this.state,
      transport: this.transportKind,
      fallbackReason: this.fallbackReason,
      capture: live ? this.capture : undefined,
      reason: this.reason,
      controlOffReason: live ? this.controlOffReason : undefined,
      touchIndicatorPath: live ? this.effectiveTouchIndicatorPath() : 'off',
      paceFps: live ? this.statusFps : undefined,
      softError: live ? this.softError : undefined,
      fps: live ? this.meter.rate(now) : undefined,
      idle: live && screenIdle(this.lastChangeAt, this.lastSameAt, now),
      latencyMs: live ? this.medianLatency(now) : undefined,
      frameMs: live ? this.frameMs : undefined,
      dropped: live ? this.gate.dropped + this.videoDropped : undefined,
      image: live && this.image ? { ...this.image, reduced: this.imageReduced(this.image), reducedFor: this.adaptLimits } : undefined,
      codec: live ? this.codec : undefined,
      kbps: live && this.codec !== undefined ? this.byteRate.kbps(now) : undefined,
      video: live && this.video ? { ...this.video, reduced: this.videoReduced(this.video), reducedFor: this.adaptLimits } : undefined,
      keypadLayoutMissing: live && this.keypadInfo() !== undefined && !this.keypadConfigured,
    };
  }

  private postState(): void {
    if (this.state === 'disposed') return;
    const now = Date.now();
    const status = this.status(now);
    const active = this.controlPosted === true;
    // The log keeps the long form (transport, codec, rates, sizes, capture path) the strip no longer shows.
    const text = logText(status) + (this.state === 'live' && this.softError ? ` (${this.softError})` : '');
    // Every state change is logged, minus the numbers that change every second.
    const coarse = logText({ ...status, idle: undefined, fps: undefined, latencyMs: undefined, frameMs: undefined, dropped: undefined, image: undefined, kbps: undefined, video: undefined, softError: undefined });
    if (coarse !== this.lastLoggedStatus) {
      this.lastLoggedStatus = coarse;
      this.log(coarse);
    }
    if (this.state === 'live') {
      this.statsAt ??= now + MIRROR_TIMING.statsFirstMs;
      if (now >= this.statsAt) {
        this.statsAt = now + MIRROR_TIMING.statsIntervalMs;
        this.log(text);
      }
    }
    this.send({
      type: 'state',
      state: this.state,
      text: statusText(status, active),
      strip: stripParts(status),
      details: this.state === 'live' ? detailRows(status, active) : [],
      control: controlState(status, false),
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

function openMirror(
  ctx: vscode.ExtensionContext,
  services: Services,
  sessions: Map<string, MirrorSession>,
  keypadLayouts: KeypadLayouts,
  keypadContextChanged: () => void,
) {
  return async (item?: unknown): Promise<void> => {
    const device = requireDevice(services, item);
    if (!device) return;
    const existing = sessions.get(device);
    if (existing) {
      existing.panel.reveal(undefined, false);
      return;
    }

    let endpoint: Promise<SfdkDeviceInfo | undefined> | undefined;
    const getEndpoint = (): Promise<SfdkDeviceInfo | undefined> =>
      (endpoint ??= resolveDeviceEndpoint(services, item, device).catch(() => undefined));
    const forward =
      process.platform === 'linux' || process.platform === 'darwin'
        ? new ForwardTransport({ services, device, getEndpoint, storageDir: ctx.globalStorageUri.fsPath, ctx })
        : undefined;
    let handedOver = false;
    try {
      // Warm open: a cached socket path and a pinned host key let ssh start while the agent is probed.
      const cached = forward ? cachedSocketPath(ctx, device) : undefined;
      if (forward && cached) {
        const known = path.join(ctx.globalStorageUri.fsPath, 'ssh', 'known_hosts');
        if ((await readPinnedKeys(known, hostKeyAlias(device)).catch(() => [])).length > 0) forward.prefetch(cached);
      }

      let state = await probe(services, device);
      if (!(state.state === 'running' && state.developerMode)) {
        if (!(await ensureAgent(ctx, services, device, 'screenView'))) return;
        state = await probe(services, device);
      }
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
      const session = new MirrorSession(
        device,
        panel,
        services,
        { probe: state, forward, getEndpoint, updateAgent: () => installAgentOn(ctx, services, device), keypadLayouts, keypadContextChanged },
        (s) => {
          if (sessions.get(s.device) === s) sessions.delete(s.device);
          keypadContextChanged();
        },
      );
      handedOver = true;
      sessions.set(device, session);
      void session.refreshKeypad();
      keypadContextChanged();
      session.start();
      // The install reports to the session through onAgentInstall (activateMirror).
      void offerAgentUpdate(ctx, services, device, state).catch(() => undefined);
    } finally {
      if (!handedOver) void forward?.dispose();
    }
  };
}

export function activateMirror(ctx: vscode.ExtensionContext, services: Services): void {
  const sessions = new Map<string, MirrorSession>();
  const keypadLayouts = new KeypadLayouts(ctx, services);
  const keypadContextChanged = (): void => {
    const active = [...sessions.values()].find((session) => session.panel.active && session.keypadInfo() !== undefined);
    const info = active?.keypadInfo();
    void vscode.commands.executeCommand('setContext', 'sailfish.mirrorKeypad', info !== undefined);
    void vscode.commands.executeCommand('setContext', 'sailfish.mirrorKeypadLayout', info !== undefined && keypadLayouts.configured(info.model));
  };
  const activeKeypadSession = (): MirrorSession | undefined =>
    [...sessions.values()].find((session) => session.panel.active && session.keypadInfo() !== undefined);
  const refreshModel = async (model: string): Promise<void> => {
    await Promise.all([...sessions.values()].filter((session) => session.keypadInfo()?.model === model).map((session) => session.refreshKeypad()));
  };
  // Directories (and ssh processes) left by extension hosts that died without cleaning up.
  void sweepOrphans(privateDir()).catch(() => 0);
  keypadContextChanged();
  if (process.env.TEST_MODE === 'full') {
    ctx.subscriptions.push(
      vscode.commands.registerCommand('sailfish._test.mirrorInput', (device: unknown, message: unknown) => {
        if (typeof device === 'string') sessions.get(device)?.inputForTest(message);
      }),
      vscode.commands.registerCommand('sailfish._test.mirrorFocus', (device: unknown, focused: unknown) => {
        if (typeof device === 'string' && typeof focused === 'boolean') sessions.get(device)?.focusForTest(focused);
      }),
    );
  }
  ctx.subscriptions.push(
    keypadLayouts,
    keypadLayouts.onDidChange((model) => { void refreshModel(model); }),
    vscode.commands.registerCommand('sailfish.agent.mirror', openMirror(ctx, services, sessions, keypadLayouts, keypadContextChanged)),
    vscode.commands.registerCommand('sailfish.agent.editKeypadLayout', async () => {
      const session = activeKeypadSession();
      const info = session?.keypadInfo();
      if (info && await keypadLayouts.edit(info)) await refreshModel(info.model);
    }),
    vscode.commands.registerCommand('sailfish.agent.resetKeypadLayout', async () => {
      const session = activeKeypadSession();
      const info = session?.keypadInfo();
      if (info && await keypadLayouts.reset(info)) await refreshModel(info.model);
    }),
    // Any install over a running agent (the update offer, Install Device Agent) restarts it.
    onAgentInstall((e) => {
      const session = sessions.get(e.device);
      if (!session) return;
      if (e.phase === 'installing') session.agentInstalling();
      else session.agentInstalled(e.probe);
    }),
    {
      dispose: () => {
        for (const s of [...sessions.values()]) s.disposeNow();
      },
    },
  );
}
