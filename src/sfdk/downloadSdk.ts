import * as https from 'node:https';

export type Variant = 'online' | 'offline';

interface PlatformTarget {
  suffix: string;
  ext: string;
}

/** No download server exists for Windows/other; caller shows the generic install docs link instead. */
export function platformTarget(platform: NodeJS.Platform): PlatformTarget | null {
  if (platform === 'darwin') {
    return { suffix: 'mac', ext: 'dmg' };
  }
  if (platform === 'linux') {
    return { suffix: 'linux64', ext: 'run' };
  }
  if (platform === 'win32') {
    return { suffix: 'windows', ext: 'exe' };
  }
  return null;
}

/** releases.sailfishos.org has no version-list API; scrape the current version out of the docs page's own download links. */
export function parseLatestVersion(html: string): string | null {
  const match = /SailfishSDK-(\d+\.\d+\.\d+)-/.exec(html);
  return match ? match[1] : null;
}

export interface InstallerVersion {
  version: string;
  deprecated: boolean;
}

/** Releases before 3.0 only ship offline installers. */
export function hasOnlineInstaller(version: string): boolean {
  return Number(version.split('.')[0]) >= 3;
}

export function buildDownloadUrl(
  version: string,
  target: PlatformTarget,
  variant: Variant,
  deprecated = false,
): string {
  const dir = deprecated ? `${version}.deprecated` : version;
  return `https://releases.sailfishos.org/sdk/installers/${dir}/SailfishSDK-${version}-${target.suffix}-${variant}.${target.ext}`;
}

const INSTALLERS_INDEX = 'https://releases.sailfishos.org/sdk/installers/';

/**
 * Live releases first, then deprecated ones, each newest first. Only `X.Y.Z/` and `X.Y.Z.deprecated/`
 * directories qualify: older date-style and two-part names use a different installer file naming.
 */
export function parseInstallerVersions(html: string): InstallerVersion[] {
  const found = new Map<string, InstallerVersion>();
  for (const m of html.matchAll(/href="(\d+\.\d+\.\d+)(\.deprecated)?\/"/g)) {
    found.set(m[1] + (m[2] ?? ''), { version: m[1], deprecated: m[2] !== undefined });
  }
  const key = (v: string): number[] => v.split('.').map(Number);
  return [...found.values()].sort((a, b) => {
    if (a.deprecated !== b.deprecated) return a.deprecated ? 1 : -1;
    const [ka, kb] = [key(a.version), key(b.version)];
    for (let i = 0; i < 3; i++) {
      if (ka[i] !== kb[i]) return kb[i] - ka[i];
    }
    return 0;
  });
}

/** Fail-soft: an empty list means "couldn't tell" and the caller falls back to the latest version only. */
export async function listInstallerVersions(): Promise<InstallerVersion[]> {
  try {
    return parseInstallerVersions(await fetchText(INSTALLERS_INDEX));
  } catch {
    return [];
  }
}

const DOCS_PAGE = 'https://docs.sailfishos.org/Tools/Sailfish_SDK/';
const FETCH_TIMEOUT_MS = 8000;

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/** Fail-soft: null on any network/parse failure (no SDK installed, offline, page changed) — caller falls back to the generic install docs link. */
export async function resolveDownloadUrl(
  platform: NodeJS.Platform,
  variant: Variant,
  chosen?: InstallerVersion,
): Promise<string | null> {
  const target = platformTarget(platform);
  if (!target) {
    return null;
  }
  if (chosen) {
    return buildDownloadUrl(chosen.version, target, variant, chosen.deprecated);
  }
  let html: string;
  try {
    html = await fetchText(DOCS_PAGE);
  } catch {
    return null;
  }
  const version = parseLatestVersion(html);
  if (!version) {
    return null;
  }
  return buildDownloadUrl(version, target, variant);
}
