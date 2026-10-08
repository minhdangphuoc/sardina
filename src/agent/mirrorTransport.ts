import type * as vscode from 'vscode';
import type * as net from 'node:net';
import type { Services } from '../core/services';
import type { SfdkDeviceInfo } from '../core/types';
import { sfdkDeviceName } from '../devices/listParsing';
import {
  LEASE_SECONDS,
  MIRROR_DEFAULTS,
  MIRROR_VIDEO_DEFAULTS,
  agentSupportsForward,
  keepaliveLine,
  mirrorRequestArgs,
  parseMirrorLine,
  type MirrorLine,
} from './mirrorCore';
import { MirrorRecordParser, ackLine, keyframeLine, mirrorRequestLine, type MirrorEvent } from './mirrorWire';
import { AdaptiveQuality, setLine, type AdaptDecision } from './mirrorAdapt';
import {
  SshForward,
  ensureKnownHostsFile,
  pinHostKeys,
  readPinnedKeys,
  recheckHostKey,
  rememberSocketPath,
  type SshForwardOpenResult,
} from './sshForward';
import { hostKeyAlias, type SshFailureClass } from './sshForwardCore';
import { inputLine, type MirrorInput } from './mirrorInput';

/**
 * The two ways the mirror stream reaches the agent (plan section 1.5): `ForwardTransport` (an
 * `ssh -N` socket forward, binary records) and `SfdkExecTransport` (`sfdk device exec`, the
 * fallback, base64 text lines). Both deliver parsed events to a `MirrorSink`; `MirrorSession`
 * owns state, frames, keepalive timing and the choice between them. No runtime `vscode` import,
 * so both are unit-tested under plain mocha.
 */

/** How long a hidden panel keeps its ssh process before it is closed (plan O5). */
export const FORWARD_IDLE_MS = 60_000;
/** How long `SshForward.open` waits for the local listener (plan 1.3, "Readiness"). */
export const FORWARD_READY_TIMEOUT_MS = 15_000;
/** Mutable so tests can shorten the timings; the transport reads these, not the constants. */
export const FORWARD_TIMING = { idleMs: FORWARD_IDLE_MS, readyTimeoutMs: FORWARD_READY_TIMEOUT_MS };
/** The agent must answer the request line within this time (plan 1.3). */
export const FORWARD_FIRST_BYTE_MS = 5_000;
/**
 * Whether the sfdk fallback asks for a lease (`--lease 60`) and sends keepalive lines on the
 * `sfdk device exec` stdin (plan O14). On since F0.9 showed that `sfdk device exec` passes small
 * stdin writes through promptly; with it off the fallback behaves exactly as extension 0.1.6 did and
 * the lease covers only the ssh forward.
 */
export const SFDK_STDIN_KEEPALIVE: boolean = true;
/**
 * Whether the ssh forward asks for adaptive quality (agent 1.4.0; plan "Adaptive quality"). Older
 * agents ignore the request field. The sfdk fallback never adapts: text streams carry no acks.
 */
export const MIRROR_ADAPTIVE: boolean = true;
/**
 * Whether the ssh forward asks for VP8 video when the agent offers it (1.6.0) and the page can
 * decode it (plan "VP8 video"). Off, or for an older agent or a page without WebCodecs VP8, the
 * stream is JPEG as before.
 */
export const MIRROR_VIDEO: boolean = true;

/**
 * Whether the sfdk fallback to an agent of `agentVersion` asks for a lease. Only agents from 1.2.0
 * know `--lease` (the 1.1.0 client exits 2 on an unknown option), so older agents keep the 0.1.6
 * request (plan O14).
 */
export function sfdkFallbackLease(agentVersion: string): boolean {
  return SFDK_STDIN_KEEPALIVE && agentSupportsForward(agentVersion);
}

export type StatusLine = Extract<MirrorLine, { kind: 'status' }>;
export type PhoneSettingsLine = Extract<MirrorLine, { kind: 'settings' }>;
export type FrameEvent = Extract<MirrorEvent, { kind: 'frame' }>;

export interface MirrorSink {
  status(s: StatusLine): void;
  frame(f: FrameEvent): void;
  same(f: { frame: number; ts: number }): void;
  softError(f: { frame: number; ts: number; error: string }): void;
  pong(seq: number, deviceTs: number): void;
  contact?(contact: { x: number; y: number; down: boolean }): void;
  /** The agent ended the stream (`replaced`, `lease expired`, `developer mode is off`, ...) or the framing is broken. */
  fatal(error: string): void;
  /** One unparseable line of the text stream (the session counts them). */
  corrupt(): void;
  /**
   * The phone's own settings changed (agent 1.9.0, `phoneState` streams). The transport delivers it
   * so that the session's immediate `active:false` is written before the transport stops writing input
   * (and, for `input:true`, after it starts again).
   */
  settings?(s: PhoneSettingsLine): void;
  /** Adaptive quality chose a new width and quality and asked the agent for it (ssh forward only). */
  adapted?(d: AdaptDecision): void;
}

/** A failure before the stream is live: the session falls back to sfdk. */
export type SetupFailure = SshFailureClass | 'no-host-key';

export type MirrorEnd =
  | { cancelled: boolean; reason?: string }
  | { setupFailed: SetupFailure; detail: string };

export interface MirrorTransport {
  readonly kind: 'ssh' | 'sfdk';
  /** Resolves when the stream has ended; events are delivered through `sink`. */
  run(sink: MirrorSink, token: vscode.CancellationToken): Promise<MirrorEnd>;
  /** Sends one keepalive; does nothing when the transport cannot (the lease then runs out on the device). */
  keepalive(seq: number): void;
  /** Asks a VP8 stream for a key frame; does nothing on other streams and transports. */
  requestKeyframe?(): void;
  /** Renews or clears the agent's short input-focus lease; ignored until the status accepted input. */
  inputActive(active: boolean): void;
  /** Sends one already validated and mapped gesture; false means the transport refused it. */
  input(input: MirrorInput): boolean;
  /** Releases what outlives a run (the ssh process during the idle time). Idempotent. */
  dispose(): Promise<void>;
}

/* ------------------------------------------------------------------ sfdk device exec */

/** The runner call of extension 0.1.6, moved: text lines through `sfdk device exec`. */
export class SfdkExecTransport implements MirrorTransport {
  readonly kind = 'sfdk';
  private write: ((data: string) => void) | undefined;
  private inputAccepted = false;

  constructor(
    private readonly services: Services,
    private readonly device: string,
    /** From `sfdkFallbackLease`: off by default, so no caller sends `--lease` to an agent that rejects it. */
    private readonly lease: boolean = false,
    /** Only true after a 1.7.0 ping explicitly advertised tap and swipe. */
    private readonly inputRequested: boolean = false,
    /** Agent 1.9.0 only (an older `sailfish-devagent` client rejects the options): `--phone-state` and `--client`. */
    private readonly phone: { phoneState?: boolean; client?: string } = {},
  ) {}

  async run(sink: MirrorSink, token: vscode.CancellationToken): Promise<MirrorEnd> {
    let lastStderr = '';
    let result;
    try {
      result = await this.services.runner.run({
        args: ['device', 'exec', '--', ...mirrorRequestArgs({ ...MIRROR_DEFAULTS, ...(this.lease ? { lease: LEASE_SECONDS } : {}), input: this.inputRequested, ...this.phone })],
        device: this.device,
        timeoutMs: 0, // NO_TIMEOUT: only cancellation ends the stream
        token,
        collectOutput: false,
        onStdin: this.lease || this.inputRequested ? (write) => (this.write = write) : undefined,
        onLine: (line, stream) => {
          if (stream === 'stdout') this.onLine(line, sink);
          else if (line.trim()) lastStderr = line.trim();
        },
      });
    } catch (err) {
      return { cancelled: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      this.inputActive(false);
      this.inputAccepted = false;
      this.write = undefined;
    }
    return { cancelled: result.cancelled, reason: lastStderr || `exit ${result.exitCode}` };
  }

  keepalive(seq: number): void {
    this.write?.(keepaliveLine(seq));
  }

  inputActive(active: boolean): void {
    if (this.inputAccepted) this.write?.(inputLine({ type: 'active', active }));
  }

  input(input: MirrorInput): boolean {
    if (!this.inputAccepted || !this.write) return false;
    this.write(inputLine(input));
    return true;
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  /** `active:true` may be written once the phone allows input again; `active:false` goes out first when it stops. */
  private onSettings(s: PhoneSettingsLine, sink: MirrorSink): void {
    if (s.input === true && this.inputRequested) this.inputAccepted = true;
    sink.settings?.(s);
    if (s.input === false) this.inputAccepted = false;
  }

  private onLine(line: string, sink: MirrorSink): void {
    if (!line.trim()) return;
    const parsed = parseMirrorLine(line);
    if (!parsed) {
      sink.corrupt();
      return;
    }
    switch (parsed.kind) {
      case 'status':
        this.inputAccepted = this.inputRequested && parsed.input === true;
        sink.status(parsed);
        return;
      case 'fatal':
        sink.fatal(parsed.error);
        return;
      case 'settings':
        this.onSettings(parsed, sink);
        return;
      case 'soft-error':
        sink.softError(parsed);
        return;
      case 'same':
        sink.same(parsed);
        return;
      case 'pong':
        sink.pong(parsed.seq, parsed.ts);
        return;
      case 'contact':
        sink.contact?.(parsed);
        return;
      case 'frame': {
        const { data, ...rest } = parsed;
        sink.frame({ ...rest, payload: Buffer.from(data, 'base64') });
        return;
      }
    }
  }
}

/* ------------------------------------------------------------------ ssh forward */

interface Warned {
  has(key: string): boolean;
  add(key: string): unknown;
}
/** The host-key warnings are shown once per device per extension-host session (plan 1.3). */
const warnedHostKeys: Warned = new Set<string>();

type OpenOutcome =
  | { ok: true; forward: SshForward }
  | { ok: false; cls: SetupFailure; detail: string };

export interface ForwardTransportOptions {
  services: Services;
  /** The device's sfdk name; the alias and the socket-path cache are keyed by the endpoint's `sfdkDeviceName`. */
  device: string;
  /** The device's ssh endpoint (host, port, user, key); resolved lazily and at most once by the caller. */
  getEndpoint: () => Promise<SfdkDeviceInfo | undefined>;
  /** `ExtensionContext.globalStorageUri.fsPath`: holds `ssh/known_hosts`. */
  storageDir: string;
  /** For `globalState`, the per-device socket-path cache. */
  ctx: vscode.ExtensionContext;
}

/** The setup-failure detail for a connection the agent timed out before our request was read. */
const REQUEST_TIMEOUT_DETAIL = 'the agent closed the idle connection (request timeout)';

export class ForwardTransport implements MirrorTransport {
  readonly kind = 'ssh';
  private target: string | undefined;
  private forward: SshForward | undefined;
  private forwardSocket: string | undefined;
  private opening: Promise<OpenOutcome> | undefined;
  private epoch = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private sock: net.Socket | undefined;
  private running = false;
  private disposed = false;
  private forwardLost = false;
  /** Ask for VP8 on the next run (set by the session from the agent's and the page's support). */
  private video = false;
  /** The running stream is VP8. */
  private streamVideo = false;
  /** Ask for and accept gestures on the next run only when ping advertised both supported types. */
  private inputRequested = false;
  private inputAccepted = false;
  private phoneState = false;
  private client: string | undefined;
  /** Cancelled on dispose; `SshForward.open` only reads `isCancellationRequested`. */
  private readonly lifeToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };

  constructor(private readonly o: ForwardTransportOptions) {}

  /** The agent socket to forward to (from `ping`); must be set before `run`. */
  setTarget(remoteSocket: string): void {
    this.target = remoteSocket;
  }

  /** Whether the next run asks for VP8 video; the agent and the page must both support it. */
  setVideo(on: boolean): void {
    this.video = on;
  }

  setInput(on: boolean): void {
    this.inputRequested = on;
  }

  /** Ask for the in-stream `settings` message and name this client (agent 1.9.0 and later; older agents ignore both). */
  setPhoneState(on: boolean, client?: string): void {
    this.phoneState = on;
    this.client = on ? client : undefined;
  }

  /** Starts the forward before the probe has answered (warm open with a cached socket path). */
  prefetch(remoteSocket: string): void {
    this.target = remoteSocket;
    void this.acquire(remoteSocket);
  }

  async run(sink: MirrorSink, token: vscode.CancellationToken): Promise<MirrorEnd> {
    this.running = true;
    this.clearIdle();
    try {
      return await this.runInner(sink, token);
    } finally {
      this.inputActive(false);
      this.running = false;
      this.sock = undefined;
      if (!this.disposed && this.forward) this.scheduleIdle();
    }
  }

  keepalive(seq: number): void {
    const sock = this.sock;
    if (sock && !sock.destroyed && sock.writable) sock.write(keepaliveLine(seq));
  }

  inputActive(active: boolean): void {
    if (this.inputAccepted) this.writeInput(inputLine({ type: 'active', active }));
  }

  input(input: MirrorInput): boolean {
    if (!this.inputAccepted) return false;
    return this.writeInput(inputLine(input));
  }

  private writeInput(line: string): boolean {
    const sock = this.sock;
    if (!sock || sock.destroyed || !sock.writable) return false;
    sock.write(line);
    return true;
  }

  requestKeyframe(): void {
    const sock = this.sock;
    if (this.streamVideo && sock && !sock.destroyed && sock.writable) sock.write(keyframeLine());
  }

  async dispose(): Promise<void> {
    this.inputActive(false);
    this.disposed = true;
    this.lifeToken.isCancellationRequested = true;
    this.clearIdle();
    this.sock?.destroy();
    const forward = this.forward;
    this.forward = undefined;
    this.opening = undefined;
    await forward?.close();
  }

  /** For deactivate: no waiting. */
  closeSync(): void {
    this.inputActive(false);
    this.disposed = true;
    this.lifeToken.isCancellationRequested = true;
    this.clearIdle();
    this.sock?.destroy();
    this.forward?.closeSync();
    this.forward = undefined;
  }

  /* -------------------------------------------------------------- lifecycle */

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.running) return;
      const forward = this.forward;
      this.forward = undefined;
      this.opening = undefined;
      this.forwardSocket = undefined;
      this.o.services.output.log('info', `mirror "${this.o.device}": closing the idle ssh forward`);
      void forward?.close();
    }, FORWARD_TIMING.idleMs);
    this.idleTimer.unref();
  }

  /** The (possibly already running) open of the forward to `remoteSocket`; a different path replaces it. */
  private acquire(remoteSocket: string): Promise<OpenOutcome> {
    if (this.opening && this.forwardSocket === remoteSocket) return this.opening;
    const old = this.forward;
    this.forward = undefined;
    void old?.close();
    this.forwardSocket = remoteSocket;
    const epoch = ++this.epoch;
    const opening = this.openForward(remoteSocket).then(async (outcome): Promise<OpenOutcome> => {
      if (!outcome.ok) return outcome;
      if (this.disposed || this.epoch !== epoch) {
        await outcome.forward.close();
        return { ok: false, cls: 'other', detail: 'cancelled' };
      }
      this.forward = outcome.forward;
      this.forwardLost = false;
      void outcome.forward.exited.then(() => {
        if (this.forward !== outcome.forward) return;
        this.forward = undefined;
        this.opening = undefined;
        this.forwardSocket = undefined;
        this.forwardLost = true;
        this.clearIdle();
      });
      if (!this.running) this.scheduleIdle();
      return outcome;
    });
    this.opening = opening;
    return opening;
  }

  private async openForward(remoteSocket: string): Promise<OpenOutcome> {
    const { services } = this.o;
    const fail = (cls: SetupFailure, detail: string): OpenOutcome => ({ ok: false, cls, detail });
    const endpoint = await this.o.getEndpoint();
    if (!endpoint) return fail('other', 'the device endpoint (host, port, user, key) is not known');
    const name = sfdkDeviceName(endpoint);
    const alias = hostKeyAlias(name);
    let knownHosts: string;
    try {
      knownHosts = await ensureKnownHostsFile(this.o.storageDir);
    } catch (err) {
      return fail('other', `could not create the known-hosts file: ${err instanceof Error ? err.message : String(err)}`);
    }

    if ((await readPinnedKeys(knownHosts, alias)).length === 0) {
      // First contact: the keys are read through the SDK connection, never trusted on first use.
      if ((await pinHostKeys(services, name, knownHosts, alias)) === 'no-host-key') {
        return fail('no-host-key', 'the device returned no usable SSH host key through the SDK connection');
      }
      services.output.log('info', `mirror "${name}": pinned the SSH host keys read through the SDK connection`);
    }

    let result = await this.openOnce(endpoint, remoteSocket);
    if (!result.ok && result.cls === 'not-pinned') {
      // The pin was missing or lost (ssh found no key for the alias): pin through the SDK, retry once.
      if ((await pinHostKeys(services, name, knownHosts, alias)) === 'no-host-key') {
        return fail('no-host-key', 'ssh found no pinned host key and the device returned none through the SDK connection');
      }
      services.output.log('info', `mirror "${name}": ssh had no pinned host key; pinned the keys read through the SDK connection and retrying`);
      result = await this.openOnce(endpoint, remoteSocket);
    }
    if (!result.ok && result.cls === 'host-key-changed') {
      result = await this.onHostKeyChanged(endpoint, name, knownHosts, alias, remoteSocket, result.detail);
    }
    if (result.ok) {
      void rememberSocketPath(this.o.ctx, name, remoteSocket);
    }
    return result;
  }

  private async openOnce(endpoint: SfdkDeviceInfo, remoteSocket: string): Promise<OpenOutcome> {
    const r: SshForwardOpenResult = await SshForward.open({
      device: endpoint,
      remoteSocket,
      storageDir: this.o.storageDir,
      token: this.lifeToken,
      output: this.o.services.output,
      readyTimeoutMs: FORWARD_TIMING.readyTimeoutMs,
    });
    return r.ok ? { ok: true, forward: r.forward } : { ok: false, cls: r.cls, detail: r.detail };
  }

  /** ssh refused the pinned host key: re-check through the SDK and decide (plan 1.3). */
  private async onHostKeyChanged(
    endpoint: SfdkDeviceInfo,
    name: string,
    knownHosts: string,
    alias: string,
    remoteSocket: string,
    detail: string,
  ): Promise<OpenOutcome> {
    const { services } = this.o;
    const unavailable: OpenOutcome = { ok: false, cls: 'host-key-changed', detail };
    const verdict = await recheckHostKey(services, name, knownHosts, alias);
    if (verdict === 'device-changed') {
      if (endpoint.kind === 'emulator') {
        if ((await pinHostKeys(services, name, knownHosts, alias)) === 'pinned') {
          services.output.log('info', `mirror "${name}": the emulator's SSH host key changed; pinned the new key and retrying`);
          return this.openOnce(endpoint, remoteSocket);
        }
        return unavailable;
      }
      this.warnOnce(
        `${alias}:changed`,
        `Sailfish: the SSH host key of "${name}" has changed (the SDK sees the new key too). The mirror uses the SDK connection until you trust the new key.`,
        ['Trust New Key'],
        async () => {
          await pinHostKeys(services, name, knownHosts, alias);
          services.output.log('info', `mirror "${name}": pinned the new SSH host key on request`);
        },
      );
      return unavailable;
    }
    if (verdict === 'path-mismatch') {
      this.warnOnce(
        `${alias}:mismatch`,
        `Sailfish: the SSH host key of "${name}" on the direct connection does not match the key seen through the SDK; the mirror uses the SDK connection.`,
        [],
      );
    }
    return unavailable;
  }

  private warnOnce(key: string, message: string, items: string[], onChoice?: () => Promise<void>): void {
    if (warnedHostKeys.has(key)) return;
    warnedHostKeys.add(key);
    void Promise.resolve(this.o.services.prompts.showWarningMessage(message, ...items)).then((choice) => {
      if (choice !== undefined && onChoice) return onChoice();
      return undefined;
    });
  }

  /* -------------------------------------------------------------- one run */

  private async runInner(sink: MirrorSink, token: vscode.CancellationToken): Promise<MirrorEnd> {
    const target = this.target;
    if (!target) return { setupFailed: 'other', detail: 'no agent socket path' };
    if (token.isCancellationRequested) return { cancelled: true };

    let cancelNow: () => void = () => undefined;
    const cancelled = new Promise<'cancelled'>((resolve) => {
      cancelNow = () => resolve('cancelled');
    });
    const sub = token.onCancellationRequested(() => cancelNow());
    try {
      let timeoutRetried = false;
      for (let round = 0; ; round++) {
        let sock: net.Socket | undefined;
        let failure: { cls: SetupFailure; detail: string } | undefined;
        for (let attempt = 0; attempt < 2 && !sock; attempt++) {
          const outcome = await Promise.race([this.acquire(target), cancelled]);
          if (outcome === 'cancelled' || token.isCancellationRequested) return { cancelled: true };
          if (!outcome.ok) return { setupFailed: outcome.cls, detail: outcome.detail };
          try {
            sock = await outcome.forward.connect();
          } catch (err) {
            failure = { cls: 'other', detail: err instanceof Error ? err.message : String(err) };
            // A forward that died between runs: forget it and open a new one once.
            if (this.forward === outcome.forward) {
              this.forward = undefined;
              this.opening = undefined;
              this.forwardSocket = undefined;
            }
            void outcome.forward.close();
          }
        }
        if (!sock) return { setupFailed: failure?.cls ?? 'other', detail: failure?.detail ?? 'could not connect' };
        this.forwardLost = false;
        const end = await this.stream(sock, sink, token);
        // The agent closed an idle connection before our request arrived: one fresh connection, then the normal fallback.
        if ('setupFailed' in end && end.detail === REQUEST_TIMEOUT_DETAIL && !timeoutRetried && !token.isCancellationRequested) {
          timeoutRetried = true;
          continue;
        }
        return end;
      }
    } finally {
      sub.dispose();
    }
  }

  private stream(sock: net.Socket, sink: MirrorSink, token: vscode.CancellationToken): Promise<MirrorEnd> {
    this.sock = sock;
    this.streamVideo = false;
    this.inputAccepted = false;
    const video = this.video;
    const input = this.inputRequested;
    const phone = {
      ...(this.phoneState ? { phoneState: true } : {}),
      ...(this.client ? { client: this.client } : {}),
    };
    return new Promise<MirrorEnd>((resolve) => {
      const parser = new MirrorRecordParser();
      let gotStatus = false;
      let fatal: string | undefined;
      let adapt: AdaptiveQuality | undefined;
      let settled = false;
      let first: NodeJS.Timeout | undefined;

      const finish = (end: MirrorEnd): void => {
        if (settled) return;
        settled = true;
        if (first) clearTimeout(first);
        cancelSub.dispose();
        if (this.inputAccepted && !sock.destroyed && sock.writable) {
          sock.write(inputLine({ type: 'active', active: false }));
        }
        this.inputAccepted = false;
        sock.destroy();
        resolve(end);
      };
      const cancelSub = token.onCancellationRequested(() => finish({ cancelled: true }));

      first = setTimeout(() => finish({ setupFailed: 'timeout', detail: 'the agent did not answer the mirror request' }), FORWARD_FIRST_BYTE_MS);

      const handle = (ev: MirrorEvent): void => {
        switch (ev.kind) {
          case 'status':
            gotStatus = true;
            if (first) clearTimeout(first);
            first = undefined;
            this.streamVideo = ev.encoding === 'vp8';
            this.inputAccepted = input && ev.input === true;
            if (ev.adapt) {
              adapt = this.streamVideo
                ? new AdaptiveQuality({ fps: ev.fps, width: ev.width, quality: ev.bitrate ?? MIRROR_VIDEO_DEFAULTS.bitrate, codec: 'vp8', window: ev.window })
                : new AdaptiveQuality({ fps: ev.fps, width: ev.width, quality: ev.quality });
            }
            sink.status(ev);
            return;
          case 'frame': {
            sink.frame(ev);
            if (sock.destroyed || !sock.writable) return;
            sock.write(ackLine(ev.frame));
            const d = adapt?.onFrame({
              at: Date.now(),
              frame: ev.frame,
              bytes: ev.payload.length,
              width: ev.size[0],
              screenWidth: ev.screen[0],
              screenHeight: ev.screen[1],
              q: ev.format === 'vp8' ? ev.kbps : ev.q,
              rtt: ev.rtt,
              rttFrame: ev.rttFrame,
              ticks: ev.ticks,
              skips: ev.skips,
              ems: ev.ems,
              cvms: ev.cvms,
              key: ev.key,
              refresh: ev.refresh,
            });
            if (d) {
              sock.write(setLine(d, this.streamVideo ? 'vp8' : 'jpeg'));
              sink.adapted?.(d);
            }
            return;
          }
          case 'same':
            sink.same(ev);
            return;
          case 'soft-error':
            sink.softError(ev);
            return;
          case 'pong':
            sink.pong(ev.seq, ev.ts);
            return;
          case 'contact':
            sink.contact?.(ev);
            return;
          case 'settings':
            // Order matters: `input:false` reaches the session first (it writes `active:false`), then writes stop.
            if (ev.input === true && input) this.inputAccepted = true;
            sink.settings?.(ev);
            if (ev.input === false) this.inputAccepted = false;
            return;
          case 'fatal':
            if (!gotStatus && ev.error.trim().toLowerCase() === 'request timeout') {
              // A stale connection the agent already timed out: a retryable setup failure, not a fatal stream error.
              finish({ setupFailed: 'timeout', detail: REQUEST_TIMEOUT_DETAIL });
              return;
            }
            fatal = ev.error;
            if (first) clearTimeout(first);
            first = undefined;
            sink.fatal(ev.error);
            finish({ cancelled: false, reason: ev.error }); // the daemon closes after a fatal reply
            return;
        }
      };

      sock.on('data', (chunk: Buffer) => {
        if (settled) return;
        for (const ev of parser.push(chunk)) handle(ev);
        if (parser.failed && fatal === undefined && !settled) {
          if (gotStatus) {
            sink.fatal(parser.failed);
            finish({ cancelled: false, reason: parser.failed });
          } else {
            finish({ setupFailed: 'other', detail: parser.failed });
          }
        }
      });
      sock.on('error', () => undefined); // 'close' follows
      sock.on('close', () => {
        if (fatal !== undefined) finish({ cancelled: false, reason: fatal });
        else if (!gotStatus) finish({ setupFailed: 'remote-refused', detail: 'the connection closed before the agent answered' });
        else finish({ cancelled: false, reason: this.forwardLost ? 'ssh: connection lost' : 'connection closed' });
      });

      sock.write(
        video
          ? mirrorRequestLine({ ...MIRROR_VIDEO_DEFAULTS, lease: LEASE_SECONDS, adapt: MIRROR_ADAPTIVE, input, ...phone }, 'vp8')
          : mirrorRequestLine({ ...MIRROR_DEFAULTS, lease: LEASE_SECONDS, adapt: MIRROR_ADAPTIVE, input, ...phone }, 'binary'),
      );
    });
  }
}
