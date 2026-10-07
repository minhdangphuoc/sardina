import * as assert from 'node:assert';
import { describe, it } from 'mocha';
import {
  BuildState,
  formatAgo,
  formatClock,
  formatElapsed,
  formatSeconds,
  lastBuildText,
  stageForArgv,
} from '../../../src/build/buildStateCore';

describe('BuildState', () => {
  it('starts idle', () => {
    const s = new BuildState();
    assert.deepStrictEqual(s.snapshot(), { phase: 'idle' });
    assert.strictEqual(s.running, false);
  });

  it('tracks a run, its stage and a successful end, and fires on each change', () => {
    const s = new BuildState();
    let fired = 0;
    const sub = s.onDidChange(() => fired++);
    const id = s.start('building', 1000);
    assert.deepStrictEqual(s.snapshot(), { phase: 'running', startedAt: 1000, stage: 'building' });
    s.setStage(id, 'deploying');
    s.setStage(id, 'deploying'); // no change, no event
    assert.strictEqual(s.snapshot().stage, 'deploying');
    s.end(id, true, 6000);
    assert.deepStrictEqual(s.snapshot(), { phase: 'succeeded', startedAt: 1000, endedAt: 6000, cancelled: false });
    assert.strictEqual(fired, 3);
    sub.dispose();
    s.start('x');
    assert.strictEqual(fired, 3);
  });

  it('records a failure and a cancellation', () => {
    const s = new BuildState();
    s.end(s.start('b', 0), false, 10);
    assert.strictEqual(s.snapshot().phase, 'failed');
    s.end(s.start('b', 0), false, 10, true);
    assert.strictEqual(s.snapshot().cancelled, true);
  });

  it('ignores unknown or repeated ends', () => {
    const s = new BuildState();
    const id = s.start('b', 0);
    s.end(id, true, 5);
    s.end(id, false, 9);
    s.end(99, false, 9);
    assert.strictEqual(s.snapshot().phase, 'succeeded');
  });

  it('stays running until the last of several runs ended, and stopAll cancels every run', () => {
    const s = new BuildState();
    const cancelled: number[] = [];
    const a = s.start('a', 1, () => cancelled.push(1));
    const b = s.start('b', 2, () => cancelled.push(2));
    s.end(a, true, 3);
    assert.strictEqual(s.snapshot().phase, 'running');
    assert.strictEqual(s.stopAll(), 1);
    assert.deepStrictEqual(cancelled, [2]);
    s.end(b, false, 4, true);
    assert.strictEqual(s.running, false);
  });
});

describe('build state formatting', () => {
  it('formats elapsed time as m:ss', () => {
    assert.strictEqual(formatElapsed(0), '0:00');
    assert.strictEqual(formatElapsed(75_400), '1:15');
    assert.strictEqual(formatElapsed(-5), '0:00');
  });

  it('formats seconds with one decimal below ten', () => {
    assert.strictEqual(formatSeconds(4210), '4.2s');
    assert.strictEqual(formatSeconds(47_400), '47s');
  });

  it('formats a clock time', () => {
    const t = new Date(2026, 9, 7, 9, 5).getTime();
    assert.strictEqual(formatClock(t), '09:05');
  });

  it('formats ago', () => {
    assert.strictEqual(formatAgo(10_000), 'just now');
    assert.strictEqual(formatAgo(5 * 60_000), '5 min ago');
    assert.strictEqual(formatAgo(3 * 3_600_000), '3 h ago');
    assert.strictEqual(formatAgo(50 * 3_600_000), '2 d ago');
  });

  it('maps sfdk steps to stage names', () => {
    assert.strictEqual(stageForArgv(['build', '-j4']), 'building');
    assert.strictEqual(stageForArgv(['deploy', '--sdk']), 'deploying');
    assert.strictEqual(stageForArgv(['package']), 'packaging');
    assert.strictEqual(stageForArgv(['device', 'exec']), 'launching');
    assert.strictEqual(stageForArgv([]), 'working');
  });

  it('renders the Last build row for every phase', () => {
    const end = new Date(2026, 9, 7, 14, 3).getTime();
    assert.strictEqual(lastBuildText({ phase: 'idle' }, 0), 'idle');
    assert.strictEqual(lastBuildText({ phase: 'running', startedAt: 1000, stage: 'deploying' }, 76_000), '⟳ Building… 1:15 · deploying');
    assert.strictEqual(lastBuildText({ phase: 'succeeded', startedAt: end - 47_000, endedAt: end }, end + 1), '✓ succeeded 14:03 · 47s');
    assert.strictEqual(lastBuildText({ phase: 'failed', startedAt: end - 4000, endedAt: end }, end + 120_000), '✗ failed 2 min ago · 4.0s');
    assert.strictEqual(lastBuildText({ phase: 'failed', startedAt: end - 4000, endedAt: end, cancelled: true }, end + 120_000), '■ stopped 2 min ago · 4.0s');
  });
});
