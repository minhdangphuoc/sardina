import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import type { prompts as PromptsModule } from '../../src/ui/prompts';
import type { ActionName, AppStatsView, BannerAction, ConnectionState, HostMessage } from '../../src/monitor/protocol';
import type { ActionState } from '../../src/monitor/panelModel';

/**
 * Integration test helpers (validation §6.3). All UI-prompt stubbing goes
 * through `src/ui/prompts.ts`'s exported `prompts` object (never
 * `vscode.window.*` directly — production code doesn't call it directly
 * either). Every stub function here is auto-restored by the root `teardown`
 * registered in test/integration/index.ts via `restoreAllStubs`.
 *
 * R1/AC-1.3: this file must stub the SAME `prompts` object instance the
 * running extension calls into, not a second one. `import { prompts } from
 * '../../src/ui/prompts'` would resolve to this test file's own tsc-compiled
 * copy of that module (out/src/ui/prompts.js) — a completely different
 * object from the one esbuild bundled into dist/extension.js, which is what
 * the extension host actually loads (package.json "main"). Stubbing that
 * import's copy is a silent no-op: production code keeps calling the real
 * `vscode.window.*`. `livePrompts()` instead reaches into the already-active
 * extension's own exports (`__test.getServices().prompts`), so the stub
 * lands on the exact object `services.prompts.showQuickPick` etc. resolve
 * to at call time.
 */

const EXTENSION_ID = 'sailfish-tools-dev.sardina';

let activeSandbox: sinon.SinonSandbox | undefined;

function sandbox(): sinon.SinonSandbox {
  if (!activeSandbox) {
    activeSandbox = sinon.createSandbox();
  }
  return activeSandbox;
}

function livePrompts(): typeof PromptsModule {
  return (extensionApi().__test.getServices() as { prompts: typeof PromptsModule }).prompts;
}

/** Restores every stub created via the stub* helpers below. Call in a root `teardown`. */
export function restoreAllStubs(): void {
  activeSandbox?.restore();
  activeSandbox = undefined;
}

/**
 * Example: `await withScenario('build-fails-compile', async () => { ... })`
 * runs `fn` with `SFDK_FAKE_SCENARIO` set to `name` and the fake invocation
 * log truncated first, restoring the previous scenario env var afterwards.
 */
export async function withScenario<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.SFDK_FAKE_SCENARIO;
  process.env.SFDK_FAKE_SCENARIO = name;
  clearFakeLog();
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.SFDK_FAKE_SCENARIO;
    } else {
      process.env.SFDK_FAKE_SCENARIO = prev;
    }
  }
}

export interface FakeInvocation {
  ts: number;
  bin: string;
  argv: string[];
  cwd: string;
  scenario: string;
  key: string;
  env: { LC_ALL: string | null; LANG: string | null; SFDK_FAKE_SCENARIO: string | null };
  stdin: string;
}

export interface FakeKilledEvent {
  ts: number;
  event: 'killed';
  signal: string;
  key: string;
}

/** Example: `const { invocations } = readFakeLog();` after running a command that spawns sfdk. */
export function readFakeLog(): { invocations: FakeInvocation[]; killed: FakeKilledEvent[] } {
  const logPath = process.env.SFDK_FAKE_LOG;
  if (!logPath || !fs.existsSync(logPath)) {
    return { invocations: [], killed: [] };
  }
  const lines = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const invocations: FakeInvocation[] = [];
  const killed: FakeKilledEvent[] = [];
  for (const line of lines) {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.event === 'killed') {
      killed.push(obj as unknown as FakeKilledEvent);
    } else {
      invocations.push(obj as unknown as FakeInvocation);
    }
  }
  return { invocations, killed };
}

/** Example: `clearFakeLog();` before an action whose invocations you're about to assert on. */
export function clearFakeLog(): void {
  const logPath = process.env.SFDK_FAKE_LOG;
  if (logPath && fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '', 'utf8');
  }
}

/** Example: `stubQuickPick('SailfishOS-4.4.0.58-aarch64')` or `stubQuickPick((items) => items[0])`. */
export function stubQuickPick<T extends vscode.QuickPickItem | string>(
  pickOrFn: T | ((items: readonly T[]) => T | undefined),
): sinon.SinonStub {
  const fake = async (items: unknown): Promise<unknown> => {
    const resolved: readonly T[] = Array.isArray(items) ? items : await (items as Promise<readonly T[]>);
    if (typeof pickOrFn === 'function') {
      return pickOrFn(resolved);
    }
    return pickOrFn;
  };
  return sandbox()
    .stub(livePrompts(), 'showQuickPick')
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument --
       vscode.window.showQuickPick's overloaded signature can't unify with a single generic test fake */
    .callsFake(fake as any);
}

/** Example: `stubInputBox('harbour-myapp')` or `stubInputBox((opts) => opts.value ?? 'x')`. */
export function stubInputBox(
  valueOrFn: string | undefined | ((opts: vscode.InputBoxOptions | undefined) => string | undefined),
): sinon.SinonStub {
  return sandbox()
    .stub(livePrompts(), 'showInputBox')
    .callsFake((opts?: vscode.InputBoxOptions) => {
      if (typeof valueOrFn === 'function') {
        return Promise.resolve(valueOrFn(opts));
      }
      return Promise.resolve(valueOrFn);
    });
}

/** Example: `stubOpenDialog([vscode.Uri.file('/tmp/project')])`. */
export function stubOpenDialog(uris: vscode.Uri[] | undefined): sinon.SinonStub {
  return sandbox().stub(livePrompts(), 'showOpenDialog').resolves(uris);
}

/** Example: `stubSaveDialog(vscode.Uri.file('/tmp/shot.png'))`; `undefined` simulates a cancelled dialog. */
export function stubSaveDialog(uri: vscode.Uri | undefined): sinon.SinonStub {
  return sandbox().stub(livePrompts(), 'showSaveDialog').resolves(uri);
}

export interface RecordedMessage {
  kind: 'information' | 'warning' | 'error';
  message: string;
  items: string[];
}

export interface MessageStubs {
  calls: RecordedMessage[];
  /** The action (string) to return when a message with actions is shown; undefined = dismissed. */
  chosenAction: string | undefined;
}

/**
 * Example: `const messages = stubMessages(); await doSomething(); assert(messages.calls.length === 0);`
 * Records every showInformation/Warning/ErrorMessage call and returns
 * `messages.chosenAction` (settable) as the resolved action.
 */
export function stubMessages(): MessageStubs {
  const state: MessageStubs = { calls: [], chosenAction: undefined };
  const record = (kind: RecordedMessage['kind']) =>
    (message: string, ...rest: unknown[]): Promise<string | undefined> => {
      const items = rest.filter((r): r is string => typeof r === 'string');
      state.calls.push({ kind, message, items });
      return Promise.resolve(state.chosenAction);
    };
  const sb = sandbox();
  sb.stub(livePrompts(), 'showInformationMessage').callsFake(record('information') as never);
  sb.stub(livePrompts(), 'showWarningMessage').callsFake(record('warning') as never);
  sb.stub(livePrompts(), 'showErrorMessage').callsFake(record('error') as never);
  return state;
}

/** Example: `await waitFor(() => someArray.length > 0, 2000);` */
export async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Example: `await waitForContext('sardina.sdkAvailable', true, 3000);` */
export async function waitForContext(key: string, value: unknown, timeoutMs: number): Promise<void> {
  const api = extensionApi();
  await waitFor(() => {
    const snapshot = api.__test.getContextKeys().snapshot();
    return snapshot[key] === value;
  }, timeoutMs);
}

export interface ShownMessage {
  kind: 'information' | 'warning' | 'error';
  message: string;
}

export interface ExtensionExports {
  __test: {
    getContextKeys: () => { snapshot: () => Record<string, unknown> };
    getServices: () => Record<string, unknown>;
    getActivationMs: () => number;
    getShownMessages: () => ShownMessage[];
  };
}

/** Example: `const api = extensionApi(); api.__test.getServices();` */
export function extensionApi(): ExtensionExports {
  const ext = vscode.extensions.getExtension<ExtensionExports>(EXTENSION_ID);
  if (!ext) {
    throw new Error(`extension ${EXTENSION_ID} not found`);
  }
  return ext.exports;
}

/** Example: `path.join(fixturesRoot(), 'workspaces', 'cmake-app')`. */
export function fixturesRoot(): string {
  // Compiled to out/test/integration/*.js; falls back here only outside the
  // normal test/runTest.ts launch path, which always sets FIXTURES_ROOT.
  return process.env.FIXTURES_ROOT ?? path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures');
}

/** Example: `path.join(tmpHome(), 'fake-invocations.jsonl')`. */
export function tmpHome(): string {
  const h = process.env.TMP_HOME;
  if (!h) {
    throw new Error('TMP_HOME is not set (expected to be set by test/runTest.ts)');
  }
  return h;
}

/**
 * Recursively copies a fixture workspace directory into a fresh temp
 * directory (fs.mkdtemp), so a test can mutate it (delete/recreate a spec,
 * add it as a workspace folder) without touching the shared fixture under
 * test/fixtures, which other concurrently-running integration hosts read.
 * Example: `const tmp = copyFixtureWorkspace('qml-app', 'sf-watch-');`
 */
export function copyFixtureWorkspace(fixtureName: string, tmpPrefix: string): string {
  const src = path.join(fixturesRoot(), 'workspaces', fixtureName);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

/**
 * Adds `folderPath` as a new workspace folder and returns its
 * `vscode.WorkspaceFolder` once `vscode.workspace.workspaceFolders` reflects
 * it. Pair with `removeWorkspaceFolder` in a `finally`.
 */
export async function addWorkspaceFolder(folderPath: string): Promise<vscode.WorkspaceFolder> {
  // Resolve symlinks (e.g. macOS /var -> /private/var) so the returned
  // WorkspaceFolder's own uri.fsPath matches what vscode.workspace reports,
  // rather than the pre-mkdtemp-resolution path this test started from.
  const realPath = fs.realpathSync(folderPath);
  const uri = vscode.Uri.file(realPath);
  const start = vscode.workspace.workspaceFolders?.length ?? 0;

  let ok = false;
  for (let attempt = 0; attempt < 5 && !ok; attempt++) {
    ok = vscode.workspace.updateWorkspaceFolders(start, 0, { uri });
    if (!ok) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!ok) {
    throw new Error(`updateWorkspaceFolders failed to add ${folderPath}`);
  }
  await waitFor(() => (vscode.workspace.workspaceFolders?.length ?? 0) > start, 8000);
  const folder = vscode.workspace.workspaceFolders?.[start];
  if (!folder) {
    throw new Error(`workspace folder for ${folderPath} did not appear`);
  }
  return folder;
}

/**
 * Replaces everything under `dir` with a copy of fixture `fixtureName`, for
 * tests that reuse a single already-added temp workspace folder as
 * different fixture shapes in turn (avoids repeated
 * `updateWorkspaceFolders` calls, which this VS Code test host only accepts
 * a limited number of times per session once past the initial
 * folder-mode -> multi-root transition).
 */
export function replaceDirContents(dir: string, fixtureName: string): void {
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  const src = path.join(fixturesRoot(), 'workspaces', fixtureName);
  fs.cpSync(src, dir, { recursive: true });
}

/** Removes a workspace folder previously added via `addWorkspaceFolder`. */
export async function removeWorkspaceFolder(folder: vscode.WorkspaceFolder): Promise<void> {
  const before = vscode.workspace.workspaceFolders?.length ?? 0;
  const idx = vscode.workspace.workspaceFolders?.findIndex((f) => f.uri.toString() === folder.uri.toString());
  if (idx === undefined || idx === -1) {
    return;
  }
  vscode.workspace.updateWorkspaceFolders(idx, 1);
  await waitFor(() => (vscode.workspace.workspaceFolders?.length ?? 0) < before, 8000);
}

type AppMessage = Extract<HostMessage, { type: 'app' }>;

/** What `sardina._test.monitor(device, 'view')` returns: the host's view model of one Device Monitor panel. */
export interface MonitorView {
  device: string;
  state: ConnectionState;
  /** The connection line: `Wi‑Fi · aarch64 · OS 5.1.0.11 · agent 1.10.0`. */
  line: string;
  app: { app?: AppMessage['app']; mode?: 'run' | 'debug'; stats: AppStatsView | null; counters: AppMessage['counters'] };
  actions: Partial<Record<ActionName, ActionState>>;
  banner?: { text: string; actions: BannerAction[] };
  panels: number;
}

/** Example: `const view = await monitorView('My Phone'); assert.strictEqual(view.state, 'connected');` (TEST_MODE=full seam). */
export async function monitorView(device: string): Promise<MonitorView> {
  return await vscode.commands.executeCommand<MonitorView>('sardina._test.monitor', device, 'view');
}

export interface DeviceLogView {
  device?: string;
  running: boolean;
  /** Lines written to the "Sardina Device Log" output channel. */
  lines: string[];
}

/** Example: `const log = await deviceLogView(); assert.ok(log.lines.some((l) => l.includes('stopped')));` (TEST_MODE=full seam). */
export async function deviceLogView(): Promise<DeviceLogView> {
  return await vscode.commands.executeCommand<DeviceLogView>('sardina._test.deviceLog');
}

/**
 * Makes the offline guard's TCP probe (tools check, Debug on Device, root shells) answer `online`
 * for every device, since fixture devices sit at addresses nothing listens on. Returns the undo.
 * Example: `const restore = forceDeviceReachability(true); try { … } finally { restore(); }`
 */
export function forceDeviceReachability(online: boolean): () => void {
  const guard = (extensionApi().__test as unknown as { offlineGuard?: { isReachable: (...args: unknown[]) => Promise<boolean> } }).offlineGuard;
  if (!guard) throw new Error('__test.offlineGuard is missing');
  const previous = guard.isReachable;
  guard.isReachable = () => Promise.resolve(online);
  return () => {
    guard.isReachable = previous;
  };
}
