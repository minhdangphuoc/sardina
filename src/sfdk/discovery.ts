import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SdkInfo, SdkSource } from '../core/types';
import type { Services } from '../core/services';
import { spawnCapture } from './runner';
import { compareSemverLike, parseSemverLike } from './version';
import { hasOnlineInstaller, listInstallerVersions, resolveDownloadUrl, type InstallerVersion, type Variant } from './downloadSdk';

export type { SdkInfo };

const MIN_VERSION = { major: 3, minor: 10, patch: 0, raw: '3.10.0' };
const SET_SDK_PATH_ACTION = 'Set SDK path';
const DOWNLOAD_ACTION = 'Download SDK';
const INSTALL_ACTION = 'Install instructions';
const DONT_SHOW_ACTION = "Don't show again";
const INSTALL_URL = 'https://docs.sailfishos.org/Tools/Sailfish_SDK/Installation/';
const WINDOWS_MESSAGE = 'Sardina does not support Windows yet (sfdk requires MSYS2)';
const VERSION_PROBE_TIMEOUT_MS = 15000;

interface SdkCandidate {
  root: string;
  sfdkPath: string;
  source: SdkSource;
}

function sfdkBinName(): string {
  return process.platform === 'win32' ? 'sfdk.exe' : 'sfdk';
}

function isExecutableFile(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateFromRoot(root: string, source: SdkSource): SdkCandidate | undefined {
  const sfdkPath = path.join(root, 'bin', sfdkBinName());
  return isExecutableFile(sfdkPath) ? { root, sfdkPath, source } : undefined;
}

function findOnPath(): SdkCandidate | undefined {
  const pathEnv = process.env.PATH ?? '';
  const bin = sfdkBinName();
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidatePath = path.join(dir, bin);
    if (isExecutableFile(candidatePath)) {
      return { root: path.dirname(dir), sfdkPath: candidatePath, source: 'path' };
    }
  }
  return undefined;
}

/** FR-1.1: setting > env `SAILFISH_SDK_ROOT` > `~/SailfishOS` > PATH (+ Windows-only extra probe). */
function findSdkCandidate(services: Services): SdkCandidate | undefined {
  const setting = services.settings.get('sdkPath');
  if (setting) {
    const fromSetting = candidateFromRoot(setting, 'setting');
    if (fromSetting) return fromSetting;
  }
  const env = process.env.SAILFISH_SDK_ROOT;
  if (env) {
    const fromEnv = candidateFromRoot(env, 'env');
    if (fromEnv) return fromEnv;
  }
  const fromHome = candidateFromRoot(path.join(os.homedir(), 'SailfishOS'), 'home');
  if (fromHome) return fromHome;

  const fromPath = findOnPath();
  if (fromPath) return fromPath;

  if (process.platform === 'win32' && services.settings.get('experimental.enableWindows')) {
    const fromWindows = candidateFromRoot('C:\\SailfishOS', 'path');
    if (fromWindows) return fromWindows;
  }
  return undefined;
}

/**
 * Locates and version-gates the SFOS SDK per FR-1.1 (setting > env > home >
 * PATH), FR-1.2 (version gate) and FR-1.7 (Windows gate).
 */
export class SdkLocator {
  private info: SdkInfo | undefined;
  private readonly emitter = new vscode.EventEmitter<SdkInfo | undefined>();
  readonly onDidChange = this.emitter.event;
  private notFoundWarned = false;
  private windowsWarned = false;

  constructor(private readonly services: Services) {}

  current(): SdkInfo | undefined {
    return this.info;
  }

  private setInfo(info: SdkInfo | undefined): void {
    this.info = info;
    this.emitter.fire(info);
  }

  private warnNotFound(): void {
    if (this.notFoundWarned) {
      return;
    }
    this.notFoundWarned = true;
    void this.services.prompts
      .showWarningMessage(
        'Sardina: could not find the SFOS SDK. Set the SDK path to enable Sardina commands.',
        DOWNLOAD_ACTION,
        SET_SDK_PATH_ACTION,
        INSTALL_ACTION,
        DONT_SHOW_ACTION,
      )
      .then((choice) => {
        if (choice === SET_SDK_PATH_ACTION) {
          void vscode.commands.executeCommand('sardina.setSdkPath');
        } else if (choice === DOWNLOAD_ACTION) {
          void vscode.commands.executeCommand('sardina.downloadSdk');
        } else if (choice === INSTALL_ACTION) {
          void vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
        }
      });
  }

  async refresh(): Promise<SdkInfo | undefined> {
    if (process.platform === 'win32' && !this.services.settings.get('experimental.enableWindows')) {
      if (!this.windowsWarned) {
        this.windowsWarned = true;
        void this.services.prompts.showInformationMessage(WINDOWS_MESSAGE);
      }
      await this.services.contextKeys.set('sardina.platformSupported', false);
      await this.services.contextKeys.set('sardina.sdkAvailable', false);
      this.setInfo(undefined);
      return undefined;
    }
    await this.services.contextKeys.set('sardina.platformSupported', true);

    const candidate = findSdkCandidate(this.services);
    if (!candidate) {
      await this.services.contextKeys.set('sardina.sdkAvailable', false);
      this.setInfo(undefined);
      this.warnNotFound();
      return undefined;
    }

    const result = await spawnCapture(candidate.sfdkPath, ['--version', '--no-pager'], {
      cwd: candidate.root,
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    this.services.output.logInvocation(result.argv, result.exitCode, result.durationMs);

    if (result.exitCode !== 0) {
      await this.services.contextKeys.set('sardina.sdkAvailable', false);
      this.setInfo(undefined);
      this.warnNotFound();
      return undefined;
    }

    this.notFoundWarned = false;
    const parsed = parseSemverLike(result.stdout);
    const version = parsed?.raw ?? 'unknown';
    if (parsed && compareSemverLike(parsed, MIN_VERSION) < 0) {
      this.services.output.log(
        'warn',
        `SFOS SDK ${version} is older than the minimum supported version ${MIN_VERSION.raw}; some features may not work as expected.`,
      );
    } else if (!parsed) {
      this.services.output.log(
        'warn',
        'Could not determine the SFOS SDK version from sfdk --version output; skipping the version gate.',
      );
    }

    const info: SdkInfo = { root: candidate.root, sfdkPath: candidate.sfdkPath, version, source: candidate.source };
    await this.services.contextKeys.set('sardina.sdkAvailable', true);
    this.setInfo(info);
    return info;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

async function pickSdkPath(services: Services): Promise<void> {
  const current = services.sdk.current()?.root ?? services.settings.get('sdkPath');
  const uris = await services.prompts.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Select SFOS SDK root',
    defaultUri: current ? vscode.Uri.file(current) : undefined,
  });
  const picked = uris?.[0];
  if (!picked) {
    return;
  }
  await vscode.workspace.getConfiguration('sardina').update('sdkPath', picked.fsPath, vscode.ConfigurationTarget.Global);
}

const ONLINE_VARIANT = 'Online installer (recommended: small download, fetches the rest during install)';
const OFFLINE_VARIANT = 'Offline installer (large download, nothing more to fetch during install)';

/**
 * "Sardina: Download SDK" — opens the platform-specific installer download in the
 * browser. Never downloads or executes anything itself; the user runs the fetched
 * installer. The version list comes from the releases directory listing (deprecated
 * releases hidden, newest first and preselected); if it can't be read, the newest
 * version is scraped from the docs page instead and no version question is asked.
 */
async function downloadSdk(services: Services): Promise<void> {
  const versions = await listInstallerVersions();
  let chosen: InstallerVersion | undefined;
  if (versions.length > 1) {
    // Order: the latest release, other current releases, then deprecated ones (each newest first).
    const items: (vscode.QuickPickItem & { entry?: InstallerVersion })[] = [];
    versions.forEach((entry, i) => {
      if (entry.deprecated && !items.some((it) => it.kind === vscode.QuickPickItemKind.Separator)) {
        items.push({ label: 'Deprecated', kind: vscode.QuickPickItemKind.Separator });
      }
      const notes = [
        i === 0 ? 'latest' : undefined,
        hasOnlineInstaller(entry.version) ? undefined : 'offline installer only',
      ].filter(Boolean);
      items.push({ label: entry.version, description: notes.join(' · ') || undefined, entry });
    });
    const picked = await services.prompts.showQuickPick(items, {
      placeHolder: 'Which SDK version? (the latest is recommended)',
    });
    if (!picked?.entry) {
      return;
    }
    chosen = picked.entry;
  } else if (versions.length === 1) {
    chosen = versions[0];
  }
  const version = chosen?.version;
  let variant: Variant = 'offline';
  if (!chosen || hasOnlineInstaller(chosen.version)) {
    const variantChoice = await services.prompts.showQuickPick([ONLINE_VARIANT, OFFLINE_VARIANT], {
      placeHolder: version ? `Which installer for SDK ${version}?` : 'Which SDK installer?',
    });
    if (!variantChoice) {
      return;
    }
    variant = variantChoice === ONLINE_VARIANT ? 'online' : 'offline';
  }
  const url = await resolveDownloadUrl(process.platform, variant, chosen);
  if (!url) {
    void services.prompts.showWarningMessage(
      "Sardina: couldn't determine the direct download link (offline, or the page changed) — opening the install docs instead.",
    );
    void vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
    return;
  }
  void vscode.env.openExternal(vscode.Uri.parse(url));
  if (services.sdk.current()) {
    void services.prompts
      .showInformationMessage(
        `Sardina: the installer is downloading in your browser. This window keeps using the SDK at ${services.sdk.current()?.root}; once the new one is installed, choose it with "${SET_SDK_PATH_ACTION}".`,
        SET_SDK_PATH_ACTION,
      )
      .then((choice) => {
        if (choice === SET_SDK_PATH_ACTION) {
          void vscode.commands.executeCommand('sardina.setSdkPath');
        }
      });
  }
}

export function activateSdk(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push(services.sdk);
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sardina.setSdkPath', () => pickSdkPath(services)),
    vscode.commands.registerCommand('sardina.downloadSdk', () => downloadSdk(services)),
    vscode.commands.registerCommand('sardina.sdk.install', () => {
      const category = `${ctx.extension.id}#sardina.gettingStarted`;
      return vscode.commands.executeCommand('workbench.action.openWalkthrough', { category, step: `${category}#installSdk` }, false);
    }),
    services.settings.onDidChange('sdkPath', () => void services.sdk.refresh()),
  );
  // NFR-1: activation never awaits sfdk probing.
  void services.sdk.refresh();
}
