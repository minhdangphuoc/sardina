import * as vscode from 'vscode';
import type { Services } from '../core/services';
import { NO_TIMEOUT } from '../sfdk/runner';

export interface AppLaunch {
  appName: string;
  launchArgs: string[];
  target?: string;
  device?: string;
  cwd: string;
}

/**
 * Qt Creator's "Application Output" equivalent: runs the launch step in its own terminal so the
 * Build, Deploy & Run progress can end once the app is up. `invoker` stays attached for the app's
 * lifetime, streaming its output here; Ctrl+C or closing the terminal stops it.
 */
export function launchInAppTerminal(services: Services, launch: AppLaunch): void {
  const cts = new vscode.CancellationTokenSource();
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number | void>();
  let finished = false;

  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: () => {
      write.fire(`Launching ${launch.appName}${launch.device ? ` on ${launch.device}` : ''} (Ctrl+C stops it)\r\n\r\n`);
      void services.runner
        .run({
          args: launch.launchArgs,
          target: launch.target,
          device: launch.device,
          cwd: launch.cwd,
          token: cts.token,
          timeoutMs: NO_TIMEOUT,
          onLine: (line) => write.fire(`${line}\r\n`),
        })
        .then((result) => {
          finished = true;
          const how = result.cancelled ? 'stopped' : `exited with code ${result.exitCode}`;
          write.fire(`\r\n[${launch.appName} ${how}] Press any key to close this terminal.\r\n`);
        });
    },
    close: () => cts.cancel(),
    handleInput: (data) => {
      if (finished) {
        close.fire();
      } else if (data === '\x03') {
        write.fire('^C\r\n');
        cts.cancel();
      }
    },
  };

  const terminal = vscode.window.createTerminal({
    name: `${launch.appName}${launch.device ? ` (${launch.device})` : ''}`,
    pty,
    iconPath: new vscode.ThemeIcon('play'),
  });
  terminal.show(true);
}
