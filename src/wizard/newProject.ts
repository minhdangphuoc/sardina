import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Services } from '../core/services';
import type { SfdkResult } from '../sfdk/runner';
import { parseInitList } from './parseInitList';
import { checkProjectName } from './validation';

const SHOW_OUTPUT_ACTION = 'Show Output';
const SEE_OUTPUT_ACTION = 'See sfdk output';
const DEFAULT_TEMPLATE = 'qtquick2app';
const TEMPLATE_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateTemplateType(value: string): string | undefined {
  return TEMPLATE_TYPE_RE.test(value) ? undefined : 'Template type must not be empty or option-like';
}

/** FR-3.1 step 3: `^[a-z][a-z0-9-]*$`, plus a `harbour-` recommendation that never blocks. */
export function validateProjectName(name: string): string | vscode.InputBoxValidationMessage | undefined {
  const check = checkProjectName(name);
  if (!check.ok) {
    return check.error;
  }
  if (check.warning) {
    return { message: check.warning, severity: vscode.InputBoxValidationSeverity.Warning };
  }
  return undefined;
}

function notifyError(services: Services, message: string): void {
  void services.prompts.showErrorMessage(message, SHOW_OUTPUT_ACTION).then((choice) => {
    if (choice === SHOW_OUTPUT_ACTION) {
      void vscode.commands.executeCommand('sardina.showOutput');
    }
  });
}

/** Defensive: never let a runner rejection escape as an unhandled promise. */
async function fetch(services: Services, args: string[], cwd?: string, token?: vscode.CancellationToken): Promise<SfdkResult> {
  try {
    return await services.runner.run({ args, cwd, ensureEngine: false, token });
  } catch (err) {
    return {
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
      argv: ['sfdk', ...args],
      durationMs: 0,
      timedOut: false,
      cancelled: false,
    };
  }
}

interface TemplateQuickPickItem extends vscode.QuickPickItem {
  type: string;
}

/** FR-3.1 step 1: QuickPick from `sfdk init -l`, falling back to a free-text InputBox on parse failure. */
async function pickTemplateType(services: Services): Promise<string | undefined> {
  const result = await fetch(services, ['init', '-l'], undefined);
  if (result.exitCode === 0) {
    const parsed = parseInitList(result.stdout);
    if (parsed.ok && parsed.value.length > 0) {
      const validTypes = new Set(parsed.value.map((t) => t.type));
      const items: TemplateQuickPickItem[] = parsed.value.map((t) => ({
        label: t.type,
        description: t.description,
        type: t.type,
      }));
      const picked = await services.prompts.showQuickPick(items, { placeHolder: 'Select a project template' });
      if (!picked) {
        return undefined;
      }
      // R25 defense in depth: only a type sfdk actually listed may reach `init -t`.
      if (!validTypes.has(picked.type)) {
        notifyError(services, `Sardina: "${picked.type}" is not a known sfdk template type`);
        return undefined;
      }
      return picked.type;
    }
  }

  const choice = await services.prompts.showWarningMessage(
    'Sardina: could not list template types from sfdk; enter one manually.',
    SEE_OUTPUT_ACTION,
  );
  if (choice === SEE_OUTPUT_ACTION) {
    void vscode.commands.executeCommand('sardina.showOutput');
  }
  const typed = await services.prompts.showInputBox({
    prompt: 'Project template type',
    value: DEFAULT_TEMPLATE,
    validateInput: validateTemplateType,
  });
  if (typed === undefined) {
    return undefined;
  }
  if (validateTemplateType(typed) !== undefined) {
    notifyError(services, `Sardina: "${typed}" is not a valid template type`);
    return undefined;
  }
  return typed;
}

/** FR-3.1 step 2: builder is only asked about when the template is known to support both, or support is unknown (init -l does not report this per-type, so it is always shown). */
async function pickBuilder(services: Services): Promise<'qmake' | 'cmake' | undefined> {
  const picked = await services.prompts.showQuickPick(
    [
      { label: 'qmake', builder: 'qmake' as const },
      { label: 'cmake', builder: 'cmake' as const },
    ],
    { placeHolder: 'Select a build system' },
  );
  return picked?.builder;
}

async function pickName(services: Services): Promise<string | undefined> {
  return services.prompts.showInputBox({
    prompt: 'Project name',
    validateInput: validateProjectName,
  });
}

async function pickParentFolder(services: Services): Promise<vscode.Uri | undefined> {
  const uris = await services.prompts.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Select parent folder',
  });
  return uris?.[0];
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function confirmForce(services: Services, dir: string): Promise<boolean> {
  const choice = await services.prompts.showWarningMessage(
    `Sardina: "${dir}" is not empty. Force sfdk to initialize into it anyway?`,
    'Force',
    'Cancel',
  );
  return choice === 'Force';
}

type OpenChoice = 'Open in current window' | 'Open in new window' | 'Add to workspace';
const OPEN_CURRENT: OpenChoice = 'Open in current window';
const OPEN_NEW: OpenChoice = 'Open in new window';
const OPEN_ADD: OpenChoice = 'Add to workspace';

/** FR-3.3 */
async function offerOpen(services: Services, targetUri: vscode.Uri): Promise<void> {
  const choice = await services.prompts.showInformationMessage(
    `Sardina: project created at ${targetUri.fsPath}`,
    OPEN_CURRENT,
    OPEN_NEW,
    OPEN_ADD,
  );
  if (choice === OPEN_CURRENT) {
    await vscode.commands.executeCommand('vscode.openFolder', targetUri, false);
  } else if (choice === OPEN_NEW) {
    await vscode.commands.executeCommand('vscode.openFolder', targetUri, true);
  } else if (choice === OPEN_ADD) {
    const count = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(count, 0, { uri: targetUri });
  }
}

/** FR-3.2: create `<parent>/<name>`, then run `sfdk init ... <name>` with cwd set to it, under cancellable progress. */
async function runInit(
  services: Services,
  opts: { type: string; builder: 'qmake' | 'cmake' | undefined; name: string; targetDir: string },
): Promise<void> {
  const targetUri = vscode.Uri.file(opts.targetDir);
  try {
    await fs.mkdir(opts.targetDir, { recursive: true });
  } catch (err) {
    notifyError(services, `Sardina: could not create "${opts.targetDir}": ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let force = false;
  if (await isNonEmptyDir(opts.targetDir)) {
    force = await confirmForce(services, opts.targetDir);
    if (!force) {
      return;
    }
  }

  const args = ['init', '-t', opts.type];
  if (opts.builder) {
    args.push('-b', opts.builder);
  }
  if (force) {
    args.push('--force');
  }
  args.push(opts.name);

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Sardina: creating project "${opts.name}"…`, cancellable: true },
    (_progress, token) => fetch(services, args, opts.targetDir, token),
  );

  if (result.cancelled) {
    return;
  }
  if (result.exitCode !== 0) {
    const firstLine = (result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`).split(/\r?\n/)[0];
    notifyError(services, `Sardina: project creation failed: ${firstLine}`);
    return;
  }

  await offerOpen(services, targetUri);
}

/** FR-3 new-project wizard: escape at any step returns without side effects; no sfdk init/mkdir before step 4 completes (AC-1.3). */
async function runWizard(services: Services): Promise<void> {
  const type = await pickTemplateType(services);
  if (!type) {
    return;
  }

  const builder = await pickBuilder(services);
  // Escape cancels the wizard here too (FR-3.4), not "no preference".
  if (builder === undefined) {
    return;
  }

  const name = await pickName(services);
  if (!name) {
    return;
  }
  // Re-validate server-side; a stubbed InputBox in tests skips validateInput (R25).
  const nameCheck = checkProjectName(name);
  if (!nameCheck.ok) {
    notifyError(services, `Sardina: "${name}" is not a valid project name`);
    return;
  }

  const parentUri = await pickParentFolder(services);
  if (!parentUri) {
    return;
  }

  const targetDir = path.join(parentUri.fsPath, name);
  await runInit(services, { type, builder, name, targetDir });
}

export function activateWizard(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sardina.newProject', () => runWizard(services)),
  );
}
