import type * as vscode from 'vscode';
import type { Services } from '../core/services';

/** Rewrites an `<enginePath>/` line prefix to the host path. */
export function mapEngineLine(line: string, enginePath: string, hostPath: string): string {
  const prefix = enginePath.endsWith('/') ? enginePath : `${enginePath}/`;
  if (!line.startsWith(prefix)) {
    return line;
  }
  const hostPrefix = hostPath.endsWith('/') ? hostPath.slice(0, -1) : hostPath;
  return `${hostPrefix}/${line.slice(prefix.length)}`;
}

/** §4.5 note: gcc's `fatal error` severity is normalised to `error` before emission. */
export function normalizeSeverity(line: string): string {
  return line.replace(/\bfatal error\b/g, 'error');
}

/** §4.5: prefixes rpmbuild/check output with the spec path so the matchers get a file capture. */
export function prefixSpecLine(line: string, specPathRelativeToWorkspace: string): string {
  return `${specPathRelativeToWorkspace}: ${line}`;
}

/** FR-5.9: caches the engine-side workspace path per folder via `sfdk engine exec -- pwd`; a failed probe (`null`) is not cached, so it retries. */
export class PathMapCache {
  private readonly cache = new Map<string, string>();

  has(folder: vscode.WorkspaceFolder): boolean {
    return this.cache.has(folder.uri.toString());
  }

  async ensure(
    services: Services,
    folder: vscode.WorkspaceFolder,
    onEngineLine?: (line: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<string | null> {
    const key = folder.uri.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const enginePath = await probeEnginePath(services, folder, onEngineLine);
    if (enginePath !== null) {
      this.cache.set(key, enginePath);
    }
    return enginePath;
  }

  clear(): void {
    this.cache.clear();
  }
}

async function probeEnginePath(
  services: Services,
  folder: vscode.WorkspaceFolder,
  onEngineLine?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<string | null> {
  try {
    const result = await services.runner.run({
      args: ['engine', 'exec', '--', 'pwd'],
      cwd: folder.uri.fsPath,
      ensureEngine: true,
      onEngineLine,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const firstLine = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return firstLine ?? null;
  } catch {
    return null;
  }
}
