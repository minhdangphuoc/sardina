import * as vscode from 'vscode';
import type { Services } from '../core/services';
import { debugMonitorArgs, debugMonitorMessage, parseDebugMonitorEvent, type DebugMonitorEvent, type DebugMonitorMode } from './debugMonitorCore';

export interface DebugMonitorHandle {
  stop(): void;
  done: Promise<void>;
}

/** Required, read-only observer. Agent 1.13.2+ verifies socket ownership through its SSH client. */
export async function startDebugMonitor(
  services: Services,
  app: { device?: string; target?: string; cwd: string; binary: string },
  mode: DebugMonitorMode,
  port: number,
  token: vscode.CancellationToken,
  onEvent: (event: DebugMonitorEvent) => void,
): Promise<DebugMonitorHandle> {
  const cancellation = new vscode.CancellationTokenSource();
  const registration = token.onCancellationRequested(() => cancellation.cancel());
  let ready = false;
  let resolveReady!: () => void;
  const prepared = new Promise<void>((resolve) => { resolveReady = resolve; });
  let previous = '';
  let args: string[];
  try { args = debugMonitorArgs(mode, app.binary, port); } catch {
    registration.dispose(); cancellation.dispose();
    throw new Error('Debugger Monitoring Agent rejected the selected app or port');
  }
  const done = services.runner.run({
    args, device: app.device, target: app.target, cwd: app.cwd, token: cancellation.token,
    timeoutMs: 0, collectOutput: false,
    onLine: (line, stream) => {
      if (stream !== 'stdout') return;
      const event = parseDebugMonitorEvent(line, mode, port);
      if (!event) return;
      if (event.event === 'ready') { ready = true; resolveReady(); }
      const message = debugMonitorMessage(event);
      if (message !== previous) services.output.log('info', `Debugger Monitoring Agent [${app.device}]: ${message}`);
      previous = message;
      onEvent(event);
    },
  }).then(() => { resolveReady(); }).catch((err: unknown) => {
    services.output.log('debug', `Debugger Monitoring Agent unavailable: ${err instanceof Error ? err.message : String(err)}`);
    resolveReady();
  }).finally(() => { registration.dispose(); });
  const timer = setTimeout(resolveReady, 4000);
  await prepared;
  clearTimeout(timer);
  if (!ready || token.isCancellationRequested) {
    cancellation.cancel(); cancellation.dispose();
    throw new Error(token.isCancellationRequested
      ? 'debugger preparation was cancelled'
      : 'Debugger Monitoring Agent did not connect. Check the installed device agent and try again');
  }
  return { done, stop: () => { cancellation.cancel(); cancellation.dispose(); } };
}
