import * as assert from 'assert';
import { PathMapCache, mapEngineLine, normalizeSeverity, prefixSpecLine } from '../../../src/tasks/pathMap';

describe('pathMap.mapEngineLine (FR-5.9)', () => {
  it('rewrites a line starting with <enginePath>/ to the host path', () => {
    const line = '/home/mersdk/share/harbour-demo/src/main.cpp:12:5: error: x';
    const out = mapEngineLine(line, '/home/mersdk/share/harbour-demo', '/Users/me/harbour-demo');
    assert.strictEqual(out, '/Users/me/harbour-demo/src/main.cpp:12:5: error: x');
  });

  it('leaves lines that do not start with the engine path unchanged', () => {
    const line = 'note: something unrelated';
    assert.strictEqual(mapEngineLine(line, '/home/mersdk/share/harbour-demo', '/Users/me/harbour-demo'), line);
  });

  it('handles a trailing slash on either path', () => {
    const out = mapEngineLine(
      '/home/mersdk/share/harbour-demo/x.cpp:1: note',
      '/home/mersdk/share/harbour-demo/',
      '/Users/me/harbour-demo/',
    );
    assert.strictEqual(out, '/Users/me/harbour-demo/x.cpp:1: note');
  });
});

describe('pathMap.normalizeSeverity (§4.5 note)', () => {
  it('maps fatal error to error', () => {
    assert.strictEqual(normalizeSeverity('x.cpp:1:1: fatal error: y not found'), 'x.cpp:1:1: error: y not found');
  });

  it('leaves plain error/warning/note alone', () => {
    assert.strictEqual(normalizeSeverity('x.cpp:1:1: warning: y'), 'x.cpp:1:1: warning: y');
  });
});

describe('pathMap.prefixSpecLine (§4.5 note)', () => {
  it('prepends the workspace-relative spec path', () => {
    assert.strictEqual(
      prefixSpecLine('error: line 12: bad thing', 'rpm/harbour-demo.spec'),
      'rpm/harbour-demo.spec: error: line 12: bad thing',
    );
  });
});

describe('pathMap.PathMapCache (FR-5.9)', () => {
  const folder = { uri: { toString: () => 'file:///ws', fsPath: '/ws' } } as never;

  it('caches a successful probe per workspace folder, calling the runner only once', async () => {
    let calls = 0;
    const services = {
      runner: {
        run: () => {
          calls++;
          return Promise.resolve({
            stdout: '/home/mersdk/share/ws\n',
            stderr: '',
            exitCode: 0,
            argv: [],
            durationMs: 1,
            timedOut: false,
            cancelled: false,
          });
        },
      },
    } as never;
    const cache = new PathMapCache();
    const first = await cache.ensure(services, folder);
    const second = await cache.ensure(services, folder);
    assert.strictEqual(first, '/home/mersdk/share/ws');
    assert.strictEqual(second, '/home/mersdk/share/ws');
    assert.strictEqual(calls, 1);
  });

  it('caches a failed probe as null and never rewrites', async () => {
    const services = {
      runner: {
        run: () =>
          Promise.resolve({ stdout: '', stderr: 'no engine', exitCode: 1, argv: [], durationMs: 1, timedOut: false, cancelled: false }),
      },
    } as never;
    const cache = new PathMapCache();
    assert.strictEqual(await cache.ensure(services, folder), null);
  });

  it('caches a thrown probe as null instead of throwing', async () => {
    const services = {
      runner: {
        run: () => {
          throw new Error('not implemented: Task A');
        },
      },
    } as never;
    const cache = new PathMapCache();
    assert.strictEqual(await cache.ensure(services, folder), null);
  });
});
