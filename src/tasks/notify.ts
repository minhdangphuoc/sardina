import * as vscode from 'vscode';
import type { Services } from '../core/services';
import { buildLog } from './buildLog';

/** M1.17/R34: wires up every action button offered on a build/deploy/run error notification. */
/** `outputTarget: 'build'` makes "Show output" open the "Sardina Build" channel instead of the main one. */
export async function runNotificationAction(
  services: Services,
  choice: string | undefined,
  outputTarget: 'main' | 'build' = 'main',
): Promise<void> {
  if (choice === 'Show output' || choice === 'Show Output') {
    if (outputTarget === 'build') {
      buildLog.show();
    } else {
      services.output.show();
    }
  } else if (choice === 'Select target') {
    await vscode.commands.executeCommand('sardina.selectTarget');
  } else if (choice === 'Open Devices view') {
    await vscode.commands.executeCommand('sardina.devices.focus');
  } else if (choice === 'Install on device') {
    await vscode.commands.executeCommand('sardina.device.installTools');
  } else if (choice === 'Select device') {
    await vscode.commands.executeCommand('sardina.device.setDefault');
  } else if (choice === 'Set up signing') {
    await vscode.commands.executeCommand('sardina.setupSigning');
  } else if (choice === 'Clean & Rebuild') {
    await vscode.commands.executeCommand('sardina.rebuild');
  } else if (choice === 'Build') {
    await vscode.commands.executeCommand('sardina.build');
  }
}
