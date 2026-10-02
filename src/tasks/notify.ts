import * as vscode from 'vscode';
import type { Services } from '../core/services';

/** M1.17/R34: wires up every action button offered on a build/deploy/run error notification. */
export async function runNotificationAction(services: Services, choice: string | undefined): Promise<void> {
  if (choice === 'Show output' || choice === 'Show Output') {
    services.output.show();
  } else if (choice === 'Select target') {
    await vscode.commands.executeCommand('sailfish.selectTarget');
  } else if (choice === 'Open Devices view') {
    await vscode.commands.executeCommand('sailfish.devices.focus');
  } else if (choice === 'Install on device') {
    await vscode.commands.executeCommand('sailfish.device.installTools');
  } else if (choice === 'Select device') {
    await vscode.commands.executeCommand('sailfish.device.setDefault');
  } else if (choice === 'Build') {
    await vscode.commands.executeCommand('sailfish.build');
  }
}
