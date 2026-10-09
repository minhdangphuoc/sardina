import * as vscode from 'vscode';
import { BUILD_LOG_CHANNEL_NAME } from './buildLogCore';

/** The "Sardina Build" channel: created on first use, cleared at the start of each build. */
export class BuildLog implements vscode.Disposable {
  private channel: vscode.OutputChannel | undefined;

  private get ch(): vscode.OutputChannel {
    this.channel ??= vscode.window.createOutputChannel(BUILD_LOG_CHANNEL_NAME);
    return this.channel;
  }

  /** Clears the previous build's lines; reveals the channel without taking focus when `reveal` is set. */
  begin(reveal: boolean): void {
    this.ch.clear();
    if (reveal) {
      this.ch.show(true);
    }
  }

  appendLine(line: string): void {
    this.ch.appendLine(line);
  }

  show(): void {
    this.ch.show(true);
  }

  dispose(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }
}

export const buildLog = new BuildLog();
