import type * as vscode from 'vscode';

/** TRD §4.1 */
export interface ProjectDescriptor {
  folder: vscode.WorkspaceFolder;
  specPath: string;
  name: string;
  version?: string;
  release?: string;
  summary?: string;
  buildSystem: 'qmake' | 'cmake' | 'unknown';
  hasNativeBinary: boolean;
  isPureQml: boolean;
  appBinaryPath: string;
  buildRequires: string[];
  detectedAt: number;
}

/** TRD §4.3 */
export interface TargetDescriptor {
  name: string;
  tooling: string;
  arch: 'armv7hl' | 'aarch64' | 'i486' | 'unknown';
  version?: string;
  flags: string[];
  isSnapshot: boolean;
  isDefault: boolean;
  sysrootPath?: string;
}

/** TRD §4.2 */
export interface SfdkDeviceInfo {
  index: number;
  name: string;
  kind: 'emulator' | 'hardware-device' | 'unknown';
  origin: 'autodetected' | 'user-defined' | 'unknown';
  user?: string;
  host?: string;
  port?: number;
  privateKey?: string;
  flags: string[];
  extra: string[];
  vmName?: string;
  /** For an `emulator list` row: the joined `device list` entry's name, which `-c device=` and `device exec` expect. */
  deviceName?: string;
}

/** TRD FR-16.1 */
export type ParseResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; reason: string; raw: string };

/** A comparable, loosely-parsed semantic version (major.minor.patch, tolerant of extra text). */
export interface SemverLike {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

/** Where the SDK was located from, per FR-1.1. */
export type SdkSource = 'setting' | 'env' | 'home' | 'path';

export interface SdkInfo {
  root: string;
  sfdkPath: string;
  version: string;
  source: SdkSource;
}

/** Context keys set via ContextKeys (src/core/contextKeys.ts). */
export type SailfishContextKey =
  | 'sailfish.isProject'
  | 'sailfish.projectCount'
  | 'sailfish.sdkAvailable'
  | 'sailfish.platformSupported'
  | 'sailfish.hasTarget'
  | 'sailfish.hasDevice'
  | 'sailfish.building';
