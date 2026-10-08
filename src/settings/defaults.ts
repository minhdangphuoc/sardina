/**
 * Every §4.6 v0.1 configuration key, typed, plus its default value. Kept
 * free of any `vscode` import so unit tests (which run outside a VS Code
 * host) can assert package.json's schema against it directly.
 */
export interface SailfishSettings {
  sdkPath: string;
  devicesXmlPath: string;
  target: string;
  device: string;
  showSnapshotTargets: boolean;
  'build.jobs': number;
  'build.runHarbourCheck': boolean;
  'build.revealLog': boolean;
  'build.extraArgs': string[];
  'build.type': 'release' | 'debug';
  'build.cleanOnArchChange': boolean;
  'build.sign': boolean;
  'build.signingUser': string;
  'build.signingPassphraseFile': string;
  'deploy.method': 'sdk' | 'pkcon' | 'rsync' | 'zypper' | 'zypper-dup' | 'manual';
  'run.launcher': 'auto' | 'invoker-silica' | 'sailfish-qml' | 'custom';
  'run.customCommand': string;
  'run.killBeforeLaunch': boolean;
  'debug.openDeviceMonitor': boolean;
  'monitor.pollIntervalSeconds': number;
  'monitor.logLines': number;
  'qtqml.silenceQmlls': boolean;
  logLevel: 'info' | 'debug';
  'experimental.enableWindows': boolean;
  'experimental.msys2Shell': string;
}

export const DEFAULTS: SailfishSettings = {
  sdkPath: '',
  devicesXmlPath: '',
  target: '',
  device: '',
  showSnapshotTargets: false,
  'build.jobs': 0,
  'build.runHarbourCheck': false,
  'build.revealLog': true,
  'build.extraArgs': [],
  'build.type': 'release',
  'build.cleanOnArchChange': false,
  'build.sign': false,
  'build.signingUser': '',
  'build.signingPassphraseFile': '',
  'deploy.method': 'sdk',
  'run.launcher': 'auto',
  'run.customCommand': '',
  'run.killBeforeLaunch': true,
  'debug.openDeviceMonitor': true,
  'monitor.pollIntervalSeconds': 5,
  'monitor.logLines': 500,
  'qtqml.silenceQmlls': true,
  logLevel: 'info',
  'experimental.enableWindows': false,
  'experimental.msys2Shell': 'C:\\msys64\\msys2_shell.cmd',
};
