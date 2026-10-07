/**
 * What the Build view shows about builds: idle, running (with the current stage) or the last result.
 * Both the build task and Run/Debug/Deploy report here. No `vscode` import so it runs under plain mocha.
 */

export type BuildPhase = 'idle' | 'running' | 'succeeded' | 'failed';

export interface BuildSnapshot {
  phase: BuildPhase;
  /** Start of the running build, or of the last finished one. */
  startedAt?: number;
  /** Set once a build finished. */
  endedAt?: number;
  /** The stage of the running build ("building", "deploying"…). */
  stage?: string;
  /** The last build was stopped by the user. */
  cancelled?: boolean;
}

interface ActiveRun {
  id: number;
  startedAt: number;
  stage: string;
  cancel?: () => void;
}

export class BuildState {
  private readonly listeners = new Set<() => void>();
  private readonly active = new Map<number, ActiveRun>();
  private nextId = 1;
  private last: BuildSnapshot = { phase: 'idle' };

  /** Calls `listener` after every change; returns a disposer. */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /** Starts a run (a build task or a Run/Debug/Deploy sequence); `cancel` stops it. Returns its id. */
  start(stage: string, now = Date.now(), cancel?: () => void): number {
    const id = this.nextId++;
    this.active.set(id, { id, startedAt: now, stage, cancel });
    this.fire();
    return id;
  }

  setStage(id: number, stage: string): void {
    const run = this.active.get(id);
    if (!run || run.stage === stage) return;
    run.stage = stage;
    this.fire();
  }

  /** Ends a run. The view shows the result of the run that ended last. */
  end(id: number, ok: boolean, now = Date.now(), cancelled = false): void {
    const run = this.active.get(id);
    if (!run) return;
    this.active.delete(id);
    this.last = { phase: ok ? 'succeeded' : 'failed', startedAt: run.startedAt, endedAt: now, cancelled };
    this.fire();
  }

  get running(): boolean {
    return this.active.size > 0;
  }

  /** Asks every running build to stop; each ends itself through `end`. */
  stopAll(): number {
    const runs = [...this.active.values()];
    for (const run of runs) run.cancel?.();
    return runs.length;
  }

  snapshot(): BuildSnapshot {
    if (this.active.size === 0) return this.last;
    // The run that started first is the one the user is waiting for.
    const first = [...this.active.values()][0];
    return { phase: 'running', startedAt: first.startedAt, stage: first.stage };
  }

  private fire(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The one shared instance: the build task, buildDeployThen and the Build view all use it. */
export const buildState = new BuildState();

/** The stage name shown while an sfdk step runs, from its first argument. */
export function stageForArgv(argv: readonly string[]): string {
  switch (argv[0]) {
    case 'build':
      return 'building';
    case 'deploy':
      return 'deploying';
    case 'package':
      return 'packaging';
    case 'check':
      return 'validating';
    case 'device':
      return 'launching';
    default:
      return argv[0] ?? 'working';
  }
}

/** `m:ss` for a duration in ms (rounded down). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** `HH:MM` local time. */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** `Ns` for a duration, one decimal below 10 s. */
export function formatSeconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** `just now`, `N min ago`, `N h ago`, `N d ago`. */
export function formatAgo(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

/** The "Last build" row text. */
export function lastBuildText(snap: BuildSnapshot, now: number): string {
  switch (snap.phase) {
    case 'idle':
      return 'idle';
    case 'running':
      return `⟳ Building… ${formatElapsed(now - (snap.startedAt ?? now))}${snap.stage ? ` · ${snap.stage}` : ''}`;
    case 'succeeded':
      return `✓ succeeded ${formatClock(snap.endedAt ?? now)} · ${formatSeconds((snap.endedAt ?? now) - (snap.startedAt ?? now))}`;
    case 'failed': {
      const took = formatSeconds((snap.endedAt ?? now) - (snap.startedAt ?? now));
      return snap.cancelled
        ? `■ stopped ${formatAgo(now - (snap.endedAt ?? now))} · ${took}`
        : `✗ failed ${formatAgo(now - (snap.endedAt ?? now))} · ${took}`;
    }
  }
}
