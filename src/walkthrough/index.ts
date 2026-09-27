import * as vscode from 'vscode';
import type { Services } from '../core/services';

/** FR-15 walkthrough steps and media live in package.json (contributes.walkthroughs); nothing to wire up here. */
export function activateWalkthrough(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push({ dispose: () => undefined });
  void services.output;
}
