import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { XML } from './devicesXmlConstants';

/**
 * FR-7.2: probes for the real libsfdk devices.xml, never the unrelated legacy
 * `~/SailfishOS/vmshare/devices.xml` VirtualBox NIC file (a past source of confusion —
 * see the Phase 2 plan). A directory is accepted as confirmation if it holds a sibling
 * `emulators.xml` or `buildengines.xml` (both real sfdkconstants.h file names).
 */
export function candidateDevicesXmlPaths(homeDir: string, sdkRoot: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const candidates = [
    path.join(homeDir, '.config', 'SailfishSDK', 'libsfdk', XML.fileName),
    path.join(homeDir, 'Library', 'Preferences', 'SailfishSDK', 'libsfdk', XML.fileName),
  ];
  if (sdkRoot) {
    candidates.push(path.join(sdkRoot, 'settings', 'SailfishSDK', 'libsfdk', XML.fileName));
  }
  if (env.XDG_CONFIG_HOME) {
    candidates.push(path.join(env.XDG_CONFIG_HOME, 'SailfishSDK', 'libsfdk', XML.fileName));
  }
  return candidates;
}

function looksLikeSfdkSettingsDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'emulators.xml')) || fs.existsSync(path.join(dir, 'buildengines.xml'));
}

export interface ResolvedDevicesXmlPath {
  path: string;
  existed: boolean;
  confirmed: boolean;
}

/**
 * FR-7.2 probe order: explicit setting first, then the candidate paths. Returns the first
 * candidate whose file already exists; if none exist, returns the first candidate whose
 * directory looks like a real sfdk settings dir (sibling emulators.xml/buildengines.xml);
 * otherwise returns the first candidate with `confirmed: false` so the caller can ask the
 * user before creating a brand new file there.
 */
export function resolveDevicesXmlPath(
  settingOverride: string | undefined,
  homeDir: string = os.homedir(),
  sdkRoot: string | undefined = undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDevicesXmlPath {
  if (settingOverride) {
    return { path: settingOverride, existed: fs.existsSync(settingOverride), confirmed: true };
  }
  const candidates = candidateDevicesXmlPaths(homeDir, sdkRoot, env);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { path: candidate, existed: true, confirmed: true };
    }
  }
  for (const candidate of candidates) {
    if (looksLikeSfdkSettingsDir(path.dirname(candidate))) {
      return { path: candidate, existed: false, confirmed: true };
    }
  }
  return { path: candidates[0], existed: false, confirmed: false };
}
