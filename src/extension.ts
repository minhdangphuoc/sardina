import * as vscode from 'vscode';
import { createServices } from './core/services';
import { activateOutput } from './core/output';
import { activateSettings } from './settings/index';
import { activateContextKeys } from './core/contextKeys';
import { activateSdk } from './sfdk/discovery';
import { activateProjects } from './project/detect';
import { activateTargets } from './targets/selectTarget';
import { activateWizard } from './wizard/newProject';
import { activateTasks } from './tasks/commands';
import { activateSigning } from './tasks/signing';
import { activateBuildConfigStatusBar } from './tasks/statusBar';
import { activateDebug } from './debug/debugOnDevice';
import { watchDeviceChange } from './devices/switchCleanup';
import { activateDevices } from './devices/commands';
import { activateBuildView } from './build/buildView';
import { activateDeviceAgent } from './agent/deviceAgent';
import { activateMonitor } from './monitor/index';
import { FORWARD_TIMING, MIRROR_TIMING } from './agent/mirror';
import { activateQtQml } from './qtqml/silence';
import { activateQmlFeatures } from './qml';
import { activateWalkthrough } from './walkthrough/index';
import { getShownMessages } from './ui/prompts';
import { getLastTargetList, resetLastTargetListForTests } from './targets/targetListCache';
import { checkExternalToolsOnce } from './core/externalTools';
import { migrateFromSailfish } from './core/migration';
import { OFFLINE_GUARD } from './devices/offlineGuard';

export function activate(ctx: vscode.ExtensionContext) {
  const activationStart = performance.now();
  const services = createServices();

  // Fixed activation order (all synchronous; sfdk probing itself must never
  // be awaited here — NFR-1).
  activateOutput(ctx, services);
  activateSettings(ctx, services);
  activateContextKeys(ctx, services);
  activateSdk(ctx, services);
  activateProjects(ctx, services);
  const targetStatusBar = activateTargets(ctx, services);
  activateWizard(ctx, services);
  activateTasks(ctx, services);
  activateSigning(ctx, services);
  activateDebug(ctx, services);
  const buildConfigStatusBar = activateBuildConfigStatusBar(ctx, services);
  const devicesProvider = activateDevices(ctx, services);
  ctx.subscriptions.push(buildConfigStatusBar.watchDevices(devicesProvider));
  const buildView = activateBuildView(ctx, services, devicesProvider);
  activateDeviceAgent(ctx, services);
  activateMonitor(ctx, services);
  watchDeviceChange(ctx, services);
  activateQtQml(ctx, services);
  const qmlFeatures = activateQmlFeatures(ctx, services);
  activateWalkthrough(ctx, services);

  // NFR-1: never awaited here — fire-and-forget, once-per-install checks.
  void migrateFromSailfish(ctx, services);
  void checkExternalToolsOnce(ctx, services);

  const activationMs = performance.now() - activationStart;

  return {
    __test: {
      getContextKeys: () => services.contextKeys,
      getServices: () => services,
      getActivationMs: () => activationMs,
      getShownMessages,
      getDevicesProvider: () => devicesProvider,
      getBuildView: () => buildView,
      getTargetStatusBar: () => targetStatusBar,
      getLastTargetList,
      resetLastTargetListForTests,
      /** The mirror's mutable keepalive and forward timings (tests shorten them; no behaviour change). */
      mirrorTiming: MIRROR_TIMING,
      forwardTiming: FORWARD_TIMING,
      /** The offline guard's TCP probe (tests point it at a fake answer for fixture devices). */
      offlineGuard: OFFLINE_GUARD,
      qml: qmlFeatures,
    },
  };
}

export function deactivate(): void {
  // Individual disposables are owned by ctx.subscriptions and disposed by
  // VS Code; nothing extra to tear down here.
}
