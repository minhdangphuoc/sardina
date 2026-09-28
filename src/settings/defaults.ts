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
  'build.extraArgs': string[];
  'deploy.method': 'sdk' | 'pkcon' | 'rsync' | 'zypper' | 'zypper-dup' | 'manual';
  'run.launcher': 'auto' | 'invoker-silica' | 'sailfish-qml' | 'custom';
  'run.customCommand': string;
  'run.killBeforeLaunch': boolean;
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
  'build.extraArgs': [],
  'deploy.method': 'sdk',
  'run.launcher': 'auto',
  'run.customCommand': '',
  'run.killBeforeLaunch': true,
  'qtqml.silenceQmlls': true,
  logLevel: 'info',
  'experimental.enableWindows': false,
  'experimental.msys2Shell': 'C:\\msys64\\msys2_shell.cmd',
};
