import * as vscode from 'vscode';

export const OUTPUT_CHANNEL_NAME = 'Sardina';

export type LogLevel = 'info' | 'debug' | 'warn' | 'error';

/** The extension's single "Sardina" OutputChannel (FR-1.6). */
export class Output {
  readonly channel: vscode.OutputChannel;
  private debugEnabled = false;

  constructor(channel?: vscode.OutputChannel) {
    this.channel = channel ?? vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  }

  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  log(level: LogLevel, msg: string): void {
    if (level === 'debug' && !this.debugEnabled) {
      return;
    }
    const ts = new Date().toISOString();
    this.channel.appendLine(`[${ts}] [${level}] ${msg}`);
  }

  logInvocation(argv: string[], exitCode: number, durationMs: number): void {
    this.log('info', `$ ${argv.join(' ')} (exit ${exitCode}, ${durationMs}ms)`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

interface OutputServices {
  output: Output;
  settings: { get(key: 'logLevel'): 'info' | 'debug'; onDidChange(key: 'logLevel', listener: () => void): vscode.Disposable };
}

export function activateOutput(ctx: vscode.ExtensionContext, services: OutputServices): void {
  ctx.subscriptions.push(services.output);
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sardina.showOutput', () => {
      services.output.show();
    }),
  );

  const applyLogLevel = (): void => {
    services.output.setDebugEnabled(services.settings.get('logLevel') === 'debug');
  };
  applyLogLevel();
  ctx.subscriptions.push(services.settings.onDidChange('logLevel', applyLogLevel));
}
