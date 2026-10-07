import * as vscode from 'vscode';
import type { Services } from '../core/services';
import { deviceSessions, stopNotice, switchNotice } from '../core/deviceSessions';

const SHOW_OUTPUT = 'Show output';

/**
 * Stops everything tied to `oldDevice` (debug session and gdbserver, app terminals, log stream,
 * mirror panels) and tells the user, without a prompt. A stop that fails or hangs is reported but
 * never blocks the switch. No-op when nothing runs on the old device.
 */
export async function cleanUpBeforeSwitch(services: Services, oldDevice: string | undefined, newDevice: string | undefined): Promise<void> {
  if (!oldDevice || oldDevice === newDevice) return;
  const running = deviceSessions.activeFor(oldDevice);
  if (running.length === 0) return;
  services.output.log('info', `device changed from "${oldDevice}" to "${newDevice ?? '(none)'}": stopping ${running.map((s) => s.label).join(', ')}`);
  const result = await stopAndLog(services, oldDevice);
  notify(services, switchNotice(oldDevice, newDevice, result));
}

/** "Stop Sessions on Device": stops everything registered for `device` and shows the same kind of notice as a switch. */
export async function stopDeviceSessions(services: Services, device: string): Promise<void> {
  const running = deviceSessions.activeFor(device);
  if (running.length > 0) services.output.log('info', `stopping ${running.map((s) => s.label).join(', ')} on "${device}"`);
  const result = await stopAndLog(services, device);
  notify(services, stopNotice(device, result));
}

async function stopAndLog(services: Services, device: string): ReturnType<typeof deviceSessions.stopAll> {
  const result = await deviceSessions.stopAll(device);
  for (const s of result.stopped) services.output.log('info', `stopped ${s.label} on "${device}"`);
  for (const f of result.failed) services.output.log('warn', `could not stop ${f.label} on "${device}": ${f.reason}`);
  return result;
}

function notify(services: Services, message: string): void {
  void services.prompts.showInformationMessage(message, SHOW_OUTPUT).then((choice) => {
    if (choice === SHOW_OUTPUT) services.output.show();
  });
}

/** `sailfish.device` edited directly (settings.json, Settings UI): the change cannot be intercepted, so clean up right after it. */
export function watchDeviceChange(ctx: vscode.ExtensionContext, services: Services): void {
  const current = (): string | undefined => services.settings.get('device', vscode.workspace.workspaceFolders?.[0]?.uri) || undefined;
  let last = current();
  ctx.subscriptions.push(
    services.settings.onDidChange('device', () => {
      const next = current();
      const previous = last;
      last = next;
      void cleanUpBeforeSwitch(services, previous, next);
    }),
  );
}
