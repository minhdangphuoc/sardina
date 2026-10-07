import type { Reachability } from '../devices/reachability';
import { BUILD_TYPES, deployMethodLabel, type BuildType, type DeployMethod } from '../tasks/buildConfig';
import { lastBuildText, type BuildSnapshot } from './buildStateCore';

/** Rows of the Build view as plain data; the tree provider only turns them into TreeItems. No `vscode` import. */

export interface BuildRow {
  id: 'project' | 'target' | 'device' | 'type' | 'deploy' | 'signing' | 'last';
  label: string;
  description: string;
  /** Codicon id without `$(…)`. */
  icon: string;
  tooltip?: string;
  /** Theme colour id for the icon. */
  color?: string;
  /** Command run on click. */
  command?: string;
}

export interface BuildViewInput {
  projectName: string;
  /** The project's .pro file name, when the folder has one. */
  proFile?: string;
  target: string;
  device: string;
  /** undefined until the Devices view loaded its lists. */
  registeredDevices?: ReadonlyMap<string, Reachability>;
  buildType: BuildType;
  deployMethod: DeployMethod;
  sign: boolean;
  snapshot: BuildSnapshot;
  now: number;
}

export function deviceRowState(
  device: string,
  registered: ReadonlyMap<string, Reachability> | undefined,
): 'none' | 'unknown' | 'unregistered' | 'offline' | 'online' {
  if (!device) return 'none';
  if (!registered) return 'unknown';
  const state = registered.get(device);
  if (state === undefined) return 'unregistered';
  return state === 'online' ? 'online' : state === 'offline' ? 'offline' : 'unknown';
}

export function buildRows(input: BuildViewInput): BuildRow[] {
  const deviceState = deviceRowState(input.device, input.registeredDevices);
  const deviceDescription: Record<typeof deviceState, string> = {
    none: 'not selected',
    unknown: input.device,
    unregistered: `${input.device} · not registered`,
    offline: `${input.device} · ○ offline`,
    online: `${input.device} · ● connected`,
  };
  const snap = input.snapshot;
  const lastIcon = snap.phase === 'running' ? 'sync~spin' : snap.phase === 'succeeded' ? 'pass' : snap.phase === 'failed' ? (snap.cancelled ? 'stop-circle' : 'error') : 'circle-outline';
  const lastColor = snap.phase === 'succeeded' ? 'testing.iconPassed' : snap.phase === 'failed' && !snap.cancelled ? 'testing.iconFailed' : undefined;
  return [
    {
      id: 'project',
      label: input.projectName,
      description: input.proFile ?? '',
      icon: 'folder',
    },
    {
      id: 'target',
      label: 'Target',
      description: input.target || 'not selected',
      icon: 'circuit-board',
      tooltip: 'Build target (click to change)',
      command: 'sailfish.selectTarget',
    },
    {
      id: 'device',
      label: 'Device',
      description: deviceDescription[deviceState],
      icon: deviceState === 'unregistered' ? 'warning' : 'device-mobile',
      color: deviceState === 'online' ? 'testing.iconPassed' : deviceState === 'offline' ? 'disabledForeground' : undefined,
      tooltip:
        deviceState === 'unregistered'
          ? `"${input.device}" is not registered with the SDK (missing from sfdk device list). Click to pick another device.`
          : deviceState === 'offline'
            ? `"${input.device}" is registered but not reachable (unplugged, asleep, or another network). Click to change.`
            : 'Deploy device (click to change)',
      command: 'sailfish.device.setDefault',
    },
    {
      id: 'type',
      label: 'Type',
      description: BUILD_TYPES.find((c) => c.value === input.buildType)?.label ?? input.buildType,
      icon: 'gear',
      tooltip: 'Build type (click to change)',
      command: 'sailfish.selectBuildType',
    },
    {
      id: 'deploy',
      label: 'Deploy',
      description: deployMethodLabel(input.deployMethod),
      icon: 'cloud-upload',
      tooltip: 'Deploy method (click to change)',
      command: 'sailfish.selectDeployMethod',
    },
    {
      id: 'signing',
      label: 'Signing',
      description: input.sign ? 'on' : 'off',
      icon: input.sign ? 'lock' : 'unlock',
      tooltip: 'Package signing (click to set up)',
      command: 'sailfish.setupSigning',
    },
    {
      id: 'last',
      label: 'Last build',
      description: lastBuildText(snap, input.now),
      icon: lastIcon,
      color: lastColor,
      tooltip: 'Open the build log',
      command: 'sailfish.showBuildLog',
    },
  ];
}
