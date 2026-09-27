/**
 * Pure project-name validation (FR-3.1 step 3). No `vscode` import so this
 * can be unit-tested directly under plain mocha; newProject.ts adapts the
 * result into a `vscode.InputBoxValidationMessage`.
 */
export type NameCheck = { ok: true; warning?: string } | { ok: false; error: string };

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export function checkProjectName(name: string): NameCheck {
  if (!NAME_RE.test(name)) {
    return { ok: false, error: 'Project name must match ^[a-z][a-z0-9-]*$' };
  }
  if (!name.startsWith('harbour-')) {
    return { ok: true, warning: 'Sailfish Harbour packages are conventionally named "harbour-<name>"' };
  }
  return { ok: true };
}
