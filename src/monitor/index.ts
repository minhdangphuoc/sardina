import * as vscode from 'vscode';
import type { Services } from '../core/services';
import type { SfdkDeviceInfo } from '../core/types';
import { deviceFromItem } from '../devices/listParsing';
import { requireDevice } from '../agent/deviceAgent';
import { MonitorPanel, isSectionId, type MonitorOpenOptions, type MonitorView } from './monitorPanel';

export type { MonitorView } from './monitorPanel';

/**
 * What `sailfish.monitor.open` accepts: nothing (the selected device), a Devices-view item, or
 * `{device, preserveFocus?, reveal?}` from other commands (Debug, Show Device Logs).
 */
function parseArgument(arg: unknown): { device?: string; info?: SfdkDeviceInfo; opts: MonitorOpenOptions } {
  const opts: MonitorOpenOptions = {};
  if (typeof arg === 'object' && arg !== null) {
    const a = arg as Record<string, unknown>;
    if (a.preserveFocus === true) opts.preserveFocus = true;
    if (isSectionId(a.reveal)) opts.reveal = a.reveal;
    if (typeof a.device === 'string' && a.device.length > 0) return { device: a.device, opts };
  }
  const info = deviceFromItem(arg);
  return { info, opts };
}

/**
 * The Device Monitor: one tab per device, opened by `sailfish.monitor.open` (Command Palette, the
 * Devices view, the status bar tooltip, Debug and Show Device Logs). Returns the open panels.
 */
export function activateMonitor(ctx: vscode.ExtensionContext, services: Services): Map<string, MonitorPanel> {
  const panels = new Map<string, MonitorPanel>();

  const open = (device: string, info: SfdkDeviceInfo | undefined, opts: MonitorOpenOptions): MonitorPanel => {
    const existing = panels.get(device);
    if (existing) {
      existing.reveal(opts);
      return existing;
    }
    const panel = new MonitorPanel(
      ctx,
      services,
      device,
      info,
      opts,
      () => panels.size,
      (p) => {
        if (panels.get(p.device) === p) panels.delete(p.device);
      },
    );
    panels.set(device, panel);
    return panel;
  };

  const openCommand = (arg?: unknown): void => {
    const parsed = parseArgument(arg);
    const device = parsed.device ?? requireDevice(services, arg);
    if (!device) return;
    open(device, parsed.info, parsed.opts);
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('sailfish.monitor.open', openCommand),
    {
      dispose: () => {
        for (const p of [...panels.values()]) p.dispose();
      },
    },
  );

  if (process.env.TEST_MODE === 'full') {
    ctx.subscriptions.push(
      vscode.commands.registerCommand('sailfish._test.monitor', async (device: unknown, op: unknown, message?: unknown): Promise<MonitorView | string | undefined> => {
        if (typeof device !== 'string') return undefined;
        if (op === 'open') return open(device, undefined, { preserveFocus: true }).view();
        const panel = panels.get(device);
        if (!panel) return undefined;
        if (op === 'view') return panel.view();
        if (op === 'html') return panel.html();
        if (op === 'send') return panel.sendForTest(message);
        return undefined;
      }),
    );
  }
  return panels;
}
