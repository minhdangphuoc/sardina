import * as vscode from 'vscode';
import type { Services } from '../core/services';
import { compareVersions, installedModules } from '../agent/agentCore';
import { bundledAgentVersionOf, installAgentOn, probe, UPDATE_AGENT } from '../agent/deviceAgent';
import { DEBUG_MONITOR_MIN_AGENT_VERSION } from './debugMonitorCore';

/** Both debuggers require the bundled monitor before any build, deploy, or app launch. */
export async function ensureDebugMonitorAgent(
  ctx: vscode.ExtensionContext,
  services: Services,
  folder: vscode.WorkspaceFolder,
): Promise<boolean> {
  const device = services.settings.get('device', folder.uri);
  if (!device) {
    void services.prompts.showErrorMessage('Sardina: select a device before starting the debugger.');
    return false;
  }
  const bundled = await bundledAgentVersionOf(ctx);
  if (!bundled || compareVersions(bundled, DEBUG_MONITOR_MIN_AGENT_VERSION) < 0) {
    void services.prompts.showErrorMessage(`Sardina: this extension does not ship device agent ${DEBUG_MONITOR_MIN_AGENT_VERSION} or newer, required for debugging. Update Sardina.`);
    return false;
  }
  let state = await probe(services, device);
  if (state.state === 'running' && !state.developerMode) {
    void services.prompts.showErrorMessage(`Sardina: turn on Developer Mode on "${device}" before debugging.`);
    return false;
  }
  if (state.state === 'running' && compareVersions(state.version, bundled) >= 0) return true;
  if (state.state === 'unreachable') {
    void services.prompts.showErrorMessage(`Sardina: could not reach the device agent on "${device}": ${state.detail}`);
    return false;
  }
  const missing = state.state !== 'running';
  const action = missing ? 'Install Device Agent' : UPDATE_AGENT;
  const choice = await services.prompts.showWarningMessage(
    missing
      ? `Sardina: debugging on "${device}" requires device agent ${bundled}. Install it before starting?`
      : `Sardina: debugging on "${device}" requires device agent ${bundled}; installed version is ${state.state === 'running' ? state.version : 'unknown'}. Update it before starting?`,
    { modal: true, detail: 'The device agent verifies the selected app and debugger listener. The install or update asks for your Developer Mode password.' },
    action,
  );
  if (choice !== action) return false;
  const installed = state.state === 'running'
    ? await installAgentOn(ctx, services, device, ['core', ...installedModules(state)], true)
    : await installAgentOn(ctx, services, device, ['core'], true);
  if (!installed) return false;
  state = await probe(services, device);
  if (state.state === 'running' && state.developerMode && compareVersions(state.version, bundled) >= 0) return true;
  void services.prompts.showErrorMessage(`Sardina: device agent ${bundled} is still unavailable on "${device}". Check Device Agent Status before debugging.`);
  return false;
}
