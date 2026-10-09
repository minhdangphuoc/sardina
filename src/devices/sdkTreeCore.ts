import * as path from 'node:path';
import type { SdkInfo, SdkSource, TargetDescriptor } from '../core/types';

/** Pure state for the "SDK" root of the Devices & Emulators view. No `vscode` import so it runs under plain mocha. */

export function sdkSourceLabel(source: SdkSource): string {
  switch (source) {
    case 'setting':
      return 'sardina.sdkPath setting';
    case 'env':
      return 'SAILFISH_SDK_ROOT';
    case 'home':
      return '~/SailfishOS';
    case 'path':
      return 'PATH';
  }
}

export function abbreviateHome(p: string, home: string): string {
  if (!home) return p;
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${path.sep}${p.slice(home.length + 1)}` : p;
}

export function sdkRootState(
  info: SdkInfo | undefined,
  home = '',
): {
  description: string;
  tooltip: string;
  contextValue: 'devices-root-sdk' | 'devices-root-sdk.missing';
} {
  if (!info) {
    return {
      description: 'not found',
      tooltip: 'Sailfish SDK not found. Install it, or point sardina.sdkPath at an existing installation.',
      contextValue: 'devices-root-sdk.missing',
    };
  }
  const known = info.version !== 'unknown';
  return {
    description: `${known ? info.version : 'version unknown'} · ${abbreviateHome(info.root, home)}`,
    tooltip: `Sailfish SDK${known ? ` ${info.version}` : ''}\n${info.root}\nsfdk: ${info.sfdkPath}\nFound via: ${sdkSourceLabel(info.source)}`,
    contextValue: 'devices-root-sdk',
  };
}

export type EngineOutcome = { ok: true; value: 'running' | 'stopped' } | { ok: false; detail: string };

export function engineItemState(outcome: EngineOutcome): {
  description: string;
  tooltip: string;
  contextValue: 'sdk-engine' | 'sdk-engine.running' | 'sdk-engine.stopped';
  state: 'running' | 'stopped' | 'unknown';
} {
  if (!outcome.ok) {
    return {
      description: 'unknown',
      tooltip: `${outcome.detail}\nClick Refresh to retry.`,
      contextValue: 'sdk-engine',
      state: 'unknown',
    };
  }
  return outcome.value === 'running'
    ? {
        description: '● running',
        tooltip: 'The Sailfish SDK build engine is running.',
        contextValue: 'sdk-engine.running',
        state: 'running',
      }
    : {
        description: '○ stopped',
        tooltip: 'The Sailfish SDK build engine is stopped.',
        contextValue: 'sdk-engine.stopped',
        state: 'stopped',
      };
}

export function visibleTargets(targets: TargetDescriptor[], showSnapshots: boolean): TargetDescriptor[] {
  return showSnapshots ? targets : targets.filter((t) => !t.isSnapshot);
}

export function targetItemState(
  target: TargetDescriptor,
  configuredTarget: string | undefined,
): { description: string; tooltip: string } {
  const flags = target.flags.join(',');
  return {
    description: target.name === configuredTarget ? '✓ selected' : '',
    tooltip: [
      `arch: ${target.arch}`,
      target.version ? `version: ${target.version}` : undefined,
      `flags: ${flags}`,
      target.isSnapshot ? 'snapshot' : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
