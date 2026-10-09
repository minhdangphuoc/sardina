/**
 * Pure parts of a device debug session's lifecycle, kept free of `vscode` so they are unit
 * tested directly: telling VS Code's Restart apart from Stop, the GDB setup that lets a
 * restarted session wait for a fresh gdbserver, and the state machine that decides whether a
 * session end is final (clean up) or a restart (start gdbserver again and adopt the new session).
 *
 * Why Restart needs this: the C/C++ extension's adapter does not support the DAP `restart`
 * request, so VS Code restarts a `cppdbg` launch by disconnecting the session (`restart: true`),
 * then launching the same resolved configuration again 300 ms later, without running our
 * command (no build, no deploy, no new gdbserver). sfdk's gdbserver runs with `--once`, so it
 * exits when the first GDB disconnects; the extension now starts it again in that gap.
 */

/** Seconds GDB keeps retrying `target extended-remote` while gdbserver (re)starts on the device. */
export const GDB_CONNECT_TIMEOUT_S = 30;
/** How long to wait, after a restart's disconnect, for VS Code to launch the new session. */
export const RESTART_ADOPT_TIMEOUT_MS = 20_000;

/** Configuration field that ties every launch of one "Debug on Device" run together, across restarts. */
export const SESSION_ID_FIELD = 'sardinaSessionId';

/**
 * True for the DAP request VS Code sends when Restart (or an adapter-requested restart) ends a
 * session: `disconnect` or `terminate` with `restart: true`. Stop sends the same requests with
 * `restart: false`.
 */
export function isRestartRequest(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as { type?: unknown; command?: unknown; arguments?: unknown };
  if (m.type !== 'request' || (m.command !== 'disconnect' && m.command !== 'terminate')) return false;
  const args = m.arguments as { restart?: unknown } | undefined;
  return typeof args === 'object' && args !== null && args.restart === true;
}

/**
 * sfdk's GDB init commands with TCP connect retries enabled before the first `target` command, so
 * a restarted session's `target extended-remote` waits for the new gdbserver instead of failing
 * with "Connection refused". GDB retries ECONNREFUSED while `tcp auto-retry` is on, up to
 * `tcp connect-timeout` seconds.
 */
export function withConnectRetry(initCommands: readonly string[], timeoutSeconds = GDB_CONNECT_TIMEOUT_S): string[] {
  const at = initCommands.findIndex((c) => c.startsWith('target '));
  if (at === -1) return [...initCommands];
  return [
    ...initCommands.slice(0, at),
    'set tcp auto-retry on',
    `set tcp connect-timeout ${timeoutSeconds}`,
    ...initCommands.slice(at),
  ];
}

/**
 * True when gdbserver exits once its first GDB disconnects (`--once`, which sfdk uses), so a
 * restart has to start it again. Without `--once` the same gdbserver keeps listening.
 */
export function gdbserverExitsAfterSession(gdbserverArgv: readonly string[]): boolean {
  return gdbserverArgv.includes('--once');
}

function escapeEre(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * `pkill -f` for exactly this gdbserver command line (anchored, so it never matches the remote
 * shell that runs pkill). A backstop for a gdbserver that no GDB ever connected to: cancelling
 * the local `sfdk device exec` does not reliably end the process on the device.
 */
export function gdbserverPkillArgs(gdbserverArgv: readonly string[]): string[] {
  const [exe, ...rest] = gdbserverArgv;
  const base = exe.split('/').pop() ?? exe;
  const pattern = `^([^ ]*/)?${escapeEre(base)}${rest.map((a) => ` ${escapeEre(a)}`).join('')}$`;
  return ['device', 'exec', '--', 'pkill', '-f', pattern];
}

export type LifecycleState = 'running' | 'restarting' | 'ended';

export interface LifecycleEffects {
  /** Restart: kill what is left of the app, then start gdbserver again; resolves false when it failed. */
  relaunchGdbserver(): Promise<boolean>;
  /** Final cleanup: drop the device-session registration and make sure gdbserver is gone. Called once. */
  cleanup(reason: 'ended' | 'restart-timeout' | 'relaunch-failed' | 'stopped'): void;
  /** Ends the restarted debug session when gdbserver could not be started again for it. */
  stopSession(): void;
  setTimer(ms: number, fn: () => void): () => void;
}

/**
 * One "Debug on Device" run, from the first launch until the user stops it (or it ends by
 * itself), across any number of restarts. Inputs are the events VS Code gives an extension;
 * outputs are the effects above.
 */
export class DebugLifecycle {
  private current: LifecycleState = 'running';
  private restartRequested = false;
  private cancelTimer: (() => void) | undefined;
  private relaunches = 0;

  constructor(private readonly effects: LifecycleEffects, private readonly adoptTimeoutMs = RESTART_ADOPT_TIMEOUT_MS) {}

  get state(): LifecycleState {
    return this.current;
  }

  /** The adapter is about to receive a disconnect/terminate with `restart: true`. */
  noteRestartRequested(): void {
    if (this.current === 'running') this.restartRequested = true;
  }

  /** VS Code ended the session (onDidTerminateDebugSession). */
  sessionTerminated(): void {
    if (this.current === 'ended') return;
    if (this.current === 'restarting') {
      // The relaunch itself failed (VS Code reports it as a plain end).
      this.end('ended');
      return;
    }
    if (!this.restartRequested) {
      this.end('ended');
      return;
    }
    this.restartRequested = false;
    this.current = 'restarting';
    const attempt = ++this.relaunches;
    this.cancelTimer = this.effects.setTimer(this.adoptTimeoutMs, () => {
      if (this.current === 'restarting' && this.relaunches === attempt) this.end('restart-timeout');
    });
    void this.effects.relaunchGdbserver().then(
      (ok) => {
        if (!ok && this.relaunches === attempt) this.failRelaunch();
      },
      () => {
        if (this.relaunches === attempt) this.failRelaunch();
      },
    );
  }

  /** A debug adapter (or session) with this run's id started: the first launch, or a restart. */
  sessionStarted(): void {
    if (this.current === 'restarting') {
      this.current = 'running';
      this.clearTimer();
    }
  }

  /** The user (or a device switch) stops the whole run. */
  stop(): void {
    if (this.current !== 'ended') this.end('stopped');
  }

  private failRelaunch(): void {
    if (this.current === 'ended') return;
    const adopted = this.current === 'running';
    this.end('relaunch-failed');
    // A restarted session without gdbserver would only wait for its connect timeout. (Not yet
    // adopted: VS Code has not launched it yet; its GDB then gives up after the connect timeout.)
    if (adopted) this.effects.stopSession();
  }

  private end(reason: 'ended' | 'restart-timeout' | 'relaunch-failed' | 'stopped'): void {
    this.current = 'ended';
    this.restartRequested = false;
    this.clearTimer();
    this.effects.cleanup(reason);
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
}
