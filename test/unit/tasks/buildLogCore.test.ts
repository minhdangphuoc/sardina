import * as assert from 'node:assert';
import { describe, it } from 'mocha';
import { BUILD_LOG_CHANNEL_NAME, formatStepFooter, formatStepHeader, mapBuildLogLine } from '../../../src/tasks/buildLogCore';

describe('buildLogCore', () => {
  it('names the channel', () => {
    assert.strictEqual(BUILD_LOG_CHANNEL_NAME, 'Sardina Build');
  });

  it('formats the step header with the command line and time', () => {
    assert.strictEqual(
      formatStepHeader(['build', '--no-check'], new Date('2026-10-07T12:00:00Z')),
      '$ sfdk build --no-check  (2026-10-07T12:00:00.000Z)',
    );
  });

  it('formats the footer with exit code and seconds', () => {
    assert.strictEqual(formatStepFooter('build', 0, 12345), 'build finished (exit 0, 12.3s)');
    assert.strictEqual(formatStepFooter('deploy', 2, 400), 'deploy finished (exit 2, 0.4s)');
  });

  it('formats a cancelled step without an exit code', () => {
    assert.strictEqual(formatStepFooter('build', 143, 2000, true), 'build cancelled (2.0s)');
  });

  it('rewrites engine paths to host paths and normalises severity', () => {
    assert.strictEqual(
      mapBuildLogLine('/home/mersdk/share/ws/src/main.cpp:3:1: fatal error: x.h: No such file', '/home/mersdk/share/ws', '/home/me/ws'),
      '/home/me/ws/src/main.cpp:3:1: error: x.h: No such file',
    );
  });

  it('leaves paths alone without a mapping', () => {
    assert.strictEqual(mapBuildLogLine('/a/b: warning: c', null, '/home/me/ws'), '/a/b: warning: c');
  });
});
