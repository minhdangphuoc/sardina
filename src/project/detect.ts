import * as vscode from 'vscode';
import type { ProjectDescriptor } from '../core/types';
import type { Services } from '../core/services';
import { detectProjectAt, type DetectIO } from './detectCore';
import { resolveActiveProject } from './active';

const SPEC_GLOB = 'rpm/*.spec';
/** Also matches the `rpm` directory itself: creating or deleting it with its specs inside only reports the directory. */
const SPEC_WATCH_GLOB = '{rpm,rpm/*.spec}';
const SPEC_EXCLUDE = '**/node_modules/**';
const SPEC_MAX_RESULTS = 10;

/** Adapts `DetectIO` (vscode-free) to `vscode.workspace` for one folder (FR-2.2). */
function ioFor(folder: vscode.WorkspaceFolder): DetectIO {
  return {
    async findSpecFiles(): Promise<string[]> {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, SPEC_GLOB),
        SPEC_EXCLUDE,
        SPEC_MAX_RESULTS,
      );
      return uris.map((u) => u.fsPath);
    },
    async readFile(specPath: string): Promise<string> {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(specPath));
      return Buffer.from(bytes).toString('utf8');
    },
    async hasCMakeLists(): Promise<boolean> {
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, 'CMakeLists.txt'),
        SPEC_EXCLUDE,
        1,
      );
      return found.length > 0;
    },
    async hasProFile(): Promise<boolean> {
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '*.pro'), SPEC_EXCLUDE, 1);
      return found.length > 0;
    },
  };
}

async function detectFolder(folder: vscode.WorkspaceFolder): Promise<ProjectDescriptor | undefined> {
  const detected = await detectProjectAt(folder.uri.fsPath, ioFor(folder));
  if (!detected) {
    return undefined;
  }
  return {
    folder,
    specPath: detected.specPath,
    name: detected.name,
    version: detected.version,
    release: detected.release,
    summary: detected.summary,
    buildSystem: detected.buildSystem,
    hasNativeBinary: detected.hasNativeBinary,
    isPureQml: detected.isPureQml,
    appBinaryPath: detected.appBinaryPath,
    buildRequires: detected.buildRequires,
    detectedAt: Date.now(),
  };
}

/** FR-2.2 project detection (rpm/*.spec discovery) + FileSystemWatcher; refresh() is never awaited from activateProjects (NFR-1). */
export class ProjectRegistry {
  private list: ProjectDescriptor[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private generation = 0;
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly pollTimer: ReturnType<typeof setInterval>;

  constructor(private readonly services: Services) {
    this.reconcileWatchers();
    this.pollTimer = setInterval(() => this.reconcileWatchers(), 1000);
  }

  projects(): ProjectDescriptor[] {
    return this.list;
  }

  forFolder(folder: vscode.WorkspaceFolder): ProjectDescriptor | undefined {
    return this.list.find((p) => p.folder.uri.toString() === folder.uri.toString());
  }

  resolveActive(): Promise<ProjectDescriptor | undefined> {
    return resolveActiveProject(this);
  }

  /** FR-2.3-watcher: keeps one watcher per folder (polled, since some hosts never fire onDidChangeWorkspaceFolders); refreshes only when the folder set changed. */
  private reconcileWatchers(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const current = new Set(folders.map((f) => f.uri.toString()));
    let changed = false;
    for (const [key, watcher] of this.watchers) {
      if (!current.has(key)) {
        watcher.dispose();
        this.watchers.delete(key);
        changed = true;
      }
    }
    for (const folder of folders) {
      const key = folder.uri.toString();
      if (this.watchers.has(key)) {
        continue;
      }
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, SPEC_WATCH_GLOB));
      watcher.onDidCreate(() => void this.refresh());
      watcher.onDidChange(() => void this.refresh());
      watcher.onDidDelete(() => void this.refresh());
      this.watchers.set(key, watcher);
      changed = true;
    }
    if (changed) {
      void this.refresh();
    }
  }

  async refresh(): Promise<void> {
    const gen = ++this.generation;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const results = await Promise.all(folders.map((folder) => detectFolder(folder)));
    if (gen !== this.generation) {
      // A later refresh() is in flight or done; this result is stale.
      return;
    }
    this.list = results.filter((p): p is ProjectDescriptor => p !== undefined);
    this.emitter.fire();
  }

  dispose(): void {
    clearInterval(this.pollTimer);
    this.emitter.dispose();
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
  }
}

export function activateProjects(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push(services.projects);

  void services.projects.refresh();

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void services.projects.refresh()),
  );
}
