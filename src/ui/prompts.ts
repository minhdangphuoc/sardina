import * as vscode from 'vscode';
import { pushBounded } from '../core/bounded';

/**
 * Test seam: every UI prompt in src/ goes through this object instead of
 * calling `vscode.window.*` directly, so integration tests can sinon-stub
 * these properties (see test/integration/helpers.ts: stubQuickPick,
 * stubInputBox, stubOpenDialog, stubSaveDialog, stubMessages). These are plain function
 * references (not bound methods), which is safe because `vscode.window`'s
 * prompt functions do not depend on `this`.
 */
export interface ShownMessage {
  kind: 'information' | 'warning' | 'error';
  message: string;
}

const shownMessages: ShownMessage[] = [];
export const SHOWN_MESSAGE_LIMIT = 1000;

/**
 * Wraps a `showXMessage` function so every call (including ones made during
 * activation, before any test has a chance to sinon-stub `prompts`) is
 * recorded into `shownMessages` first during integration tests. This is installed at module load,
 * so `getShownMessages()` sees activation-time notifications too (S6), without retaining messages
 * in a production extension host.
 */
function recordingWrapper<F extends (message: string, ...rest: never[]) => unknown>(
  kind: ShownMessage['kind'],
  fn: F,
): F {
  const wrapped = (message: string, ...rest: unknown[]): unknown => {
    if (process.env.TEST_MODE !== undefined) pushBounded(shownMessages, { kind, message }, SHOWN_MESSAGE_LIMIT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call -- vscode's showXMessage overloads can't be expressed generically here; args are forwarded unchanged.
    return (fn as any)(message, ...rest);
  };
  return wrapped as unknown as F;
}

export const prompts = {
  showQuickPick: vscode.window.showQuickPick,
  showInputBox: vscode.window.showInputBox,
  showOpenDialog: vscode.window.showOpenDialog,
  showSaveDialog: vscode.window.showSaveDialog,
  showInformationMessage: recordingWrapper('information', vscode.window.showInformationMessage),
  showWarningMessage: recordingWrapper('warning', vscode.window.showWarningMessage),
  showErrorMessage: recordingWrapper('error', vscode.window.showErrorMessage),
};

/** Every message shown via `prompts` since the extension host started (S6). */
export function getShownMessages(): ShownMessage[] {
  return shownMessages.slice();
}

/** Test-only: clears the recorded message buffer. */
export function clearShownMessages(): void {
  shownMessages.length = 0;
}
