import * as vscode from 'vscode';
import { failureTail } from './failureTail';
import { spawn } from 'node:child_process';
import type { Services } from '../core/services';
import { parseEngineStatus } from './parsers/engineStatus';

export interface SfdkRunOptions {
  args: string[];
  cwd?: string;
  target?: string;
  device?: string;
  token?: vscode.CancellationToken;
  timeoutMs?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  ensureEngine?: boolean;
}

export interface SfdkResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  argv: string[];
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_LIST_TIMEOUT_MS = 60 * 1000;
/** For an app launch: `invoker` stays in the foreground for the app's lifetime, so only cancellation ends it. */
export const NO_TIMEOUT = 0;

const LONG_RUNNING_COMMANDS = new Set(['build', 'deploy', 'qmake', 'make', 'package', 'check', 'build-shell']);
/**
 * Real sfdk 3.13.5 deadlocks when `emulator list` runs alongside `tools target list`
 * (both query the SDK maintenance tool), so these families run one at a time.
 */
const SERIALIZED_FAMILIES = new Set(['tools', 'emulator']);
const SIGKILL_GRACE_MS = 5000;

/** The sfdk subcommand, skipping leading `-c key=value` session options. */
function commandName(args: string[]): string {
  let i = 0;
  while (args[i] === '-c') {
    i += 2;
  }
  return args[i] ?? '';
}

function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r?\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}

/** The ONLY spawn site for sfdk (NFR-20: argv arrays, shell:false); handles --no-pager, -c target=/device=, LC_ALL=C, SIGTERM/SIGKILL cancellation, streaming, and the FR-1.5 engine ensure. */
export class SfdkRunner {
  private serialQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly services: Services) {}

  async run(opts: SfdkRunOptions): Promise<SfdkResult> {
    const cwd = opts.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (opts.ensureEngine) {
      const engineFailure = await this.ensureEngineRunning(cwd, opts.token);
      if (engineFailure) {
        return engineFailure;
      }
    }
    const args = this.buildArgv(opts);
    if (!SERIALIZED_FAMILIES.has(commandName(opts.args))) {
      return this.execRaw(args, opts, cwd);
    }
    const result = this.serialQueue.then(() => this.execRaw(args, opts, cwd));
    this.serialQueue = result.catch(() => undefined);
    return result;
  }

  private buildArgv(opts: SfdkRunOptions): string[] {
    const args: string[] = ['--no-pager'];
    if (opts.target) {
      args.push('-c', `target=${opts.target}`);
    }
    if (opts.device) {
      args.push('-c', `device=${opts.device}`);
    }
    args.push(...opts.args);
    return args;
  }

  /** FR-1.5: engine status/start (with progress); returns the failed/cancelled result so `run()` aborts, or `undefined` once the engine is up. */
  private async ensureEngineRunning(cwd: string | undefined, token?: vscode.CancellationToken): Promise<SfdkResult | undefined> {
    const status = await this.execRaw(['--no-pager', 'engine', 'status'], { args: [] }, cwd);
    const parsed = parseEngineStatus(status.stdout);
    if (parsed.ok && parsed.value === 'running') {
      return undefined;
    }
    const started = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Sailfish: starting the build engine…' },
      () => this.execRaw(['--no-pager', 'engine', 'start'], { args: [], token }, cwd),
    );
    if (started.cancelled || started.exitCode !== 0) {
      this.services.output.log('error', `sfdk engine start failed: ${started.stderr.trim() || started.stdout.trim() || `exit ${started.exitCode}`}`);
      return started;
    }
    return undefined;
  }

  private sfdkPath(): string | undefined {
    return this.services.sdk.current()?.sfdkPath;
  }

  private execRaw(argv: string[], opts: Pick<SfdkRunOptions, 'token' | 'timeoutMs' | 'onLine' | 'args'>, cwd?: string): Promise<SfdkResult> {
    const bin = this.sfdkPath();
    if (!bin) {
      return Promise.resolve({
        stdout: '',
        stderr: 'Sailfish SDK not found; commands are disabled until an SDK is configured.',
        exitCode: -1,
        argv: ['sfdk', ...argv],
        durationMs: 0,
        timedOut: false,
        cancelled: false,
      });
    }
    const timeoutMs =
      opts.timeoutMs ?? (LONG_RUNNING_COMMANDS.has(commandName(opts.args)) ? DEFAULT_BUILD_TIMEOUT_MS : DEFAULT_LIST_TIMEOUT_MS);

    return new Promise((resolve) => {
      const start = Date.now();
      let stdout = '';
      let stderr = '';
      let stdoutRest = '';
      let stderrRest = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, argv, { cwd, shell: false, env });
      } catch (err) {
        resolve({
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: -1,
          argv: [bin, ...argv],
          durationMs: Date.now() - start,
          timedOut: false,
          cancelled: false,
        });
        return;
      }

      const emit = (chunk: string, stream: 'stdout' | 'stderr') => {
        const buffered = (stream === 'stdout' ? stdoutRest : stderrRest) + chunk;
        const { lines, rest } = splitLines(buffered);
        if (stream === 'stdout') {
          stdoutRest = rest;
        } else {
          stderrRest = rest;
        }
        for (const line of lines) {
          opts.onLine?.(line, stream);
        }
      };

      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        stdout += text;
        emit(text, 'stdout');
      });
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        stderr += text;
        emit(text, 'stderr');
      });

      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const escalateKill = () => {
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // process may already be gone
          }
        }, SIGKILL_GRACE_MS);
      };

      const timeoutTimer =
        timeoutMs === NO_TIMEOUT
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              try {
                child.kill('SIGTERM');
              } catch {
                // ignore
              }
              escalateKill();
            }, timeoutMs);

      let cancelSub: vscode.Disposable | undefined;
      if (opts.token) {
        cancelSub = opts.token.onCancellationRequested(() => {
          cancelled = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
          escalateKill();
        });
      }

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        cancelSub?.dispose();
      };

      const flushRest = () => {
        if (stdoutRest) {
          opts.onLine?.(stdoutRest, 'stdout');
          stdoutRest = '';
        }
        if (stderrRest) {
          opts.onLine?.(stderrRest, 'stderr');
          stderrRest = '';
        }
      };

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        flushRest();
        const result: SfdkResult = {
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          signal: signal ?? undefined,
          argv: [bin, ...argv],
          durationMs: Date.now() - start,
          timedOut,
          cancelled,
        };
        this.services.output.logInvocation(result.argv, result.exitCode, result.durationMs);
        if (stdout) this.services.output.log('debug', `stdout:\n${stdout}`);
        if (stderr) this.services.output.log('debug', `stderr:\n${stderr}`);
        if (result.exitCode !== 0 && !result.cancelled) {
          // Show why it failed even at the default log level; sfdk prints some errors (e.g. "Fatal: … is not a known device") on stdout.
          const tail = failureTail(stderr) ?? failureTail(stdout);
          if (tail) this.services.output.log('warn', `${tail}`);
        }
        resolve(result);
      };

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        flushRest();
        resolve({
          stdout,
          stderr: stderr || err.message,
          exitCode: -1,
          argv: [bin, ...argv],
          durationMs: Date.now() - start,
          timedOut,
          cancelled,
        });
      });
      child.on('close', finish);
    });
  }
}

/** Generic argv-array child-process runner (shell:false, never throws); used by SdkLocator and the VM-name probe. */
export function spawnCapture(
  bin: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<SfdkResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: opts?.cwd, shell: false, env: opts?.env ?? process.env });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: -1,
        argv: [bin, ...args],
        durationMs: Date.now() - start,
        timedOut: false,
        cancelled: false,
      });
      return;
    }

    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : undefined;

    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? -1,
        signal: signal ?? undefined,
        argv: [bin, ...args],
        durationMs: Date.now() - start,
        timedOut,
        cancelled: false,
      });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr || err.message,
        exitCode: -1,
        argv: [bin, ...args],
        durationMs: Date.now() - start,
        timedOut,
        cancelled: false,
      });
    });
    child.on('close', finish);
  });
}
