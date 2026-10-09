import * as vscode from 'vscode';
import type { Services } from './services';
import { missingTools, installHint, REQUIRED_SSH_TOOLS } from './externalToolsCore';

export type { SshToolName } from './externalToolsCore';
export { missingTools, installHint, REQUIRED_SSH_TOOLS } from './externalToolsCore';

const DISMISSED_KEY = 'sardina.externalToolsNoticeDismissed';
const DONT_SHOW_AGAIN = "Don't show again";

/**
 * NFR-1: fire-and-forget at activation (never awaited there) — checks once per install
 * (persisted in globalState) whether the OpenSSH client tools `connectWlan`/`addDevice`
 * need are on PATH, and shows a single actionable notice naming exactly what's missing
 * and how to install it, rather than letting a feature fail cryptically when first used.
 */
export async function checkExternalToolsOnce(ctx: vscode.ExtensionContext, services: Services): Promise<void> {
  if (ctx.globalState.get<boolean>(DISMISSED_KEY)) {
    return;
  }
  const missing = await missingTools(REQUIRED_SSH_TOOLS);
  if (missing.length === 0) {
    return;
  }
  const hints = missing.map((tool) => `• ${installHint(tool, process.platform)}`).join('\n');
  const choice = await services.prompts.showWarningMessage(
    `Sardina: some tools used by device commands (Connect to Device, Add Device) are missing:\n${hints}`,
    DONT_SHOW_AGAIN,
  );
  if (choice === DONT_SHOW_AGAIN) {
    await ctx.globalState.update(DISMISSED_KEY, true);
  }
}
