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

export function buildDownloadUrl(version: string, target: PlatformTarget, variant: Variant): string {
  return `https://releases.sailfishos.org/sdk/installers/${version}/SailfishSDK-${version}-${target.suffix}-${variant}.${target.ext}`;
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
export async function resolveDownloadUrl(platform: NodeJS.Platform, variant: Variant): Promise<string | null> {
  const target = platformTarget(platform);
  if (!target) {
    return null;
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
