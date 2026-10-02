/**
 * Whitespace anywhere in a project path (a space inside a folder name, or a trailing one) breaks
 * the build engine's mb2 wrappers, which split the path into words and then fail with
 * "Cannot find real <first word>". No `vscode` import so it can be unit-tested directly.
 */

export function hasWhitespace(fsPath: string): boolean {
  return /\s/.test(fsPath);
}

/** The warning to show for `fsPath`, or undefined when the path is fine. */
export function whitespacePathWarning(fsPath: string): string | undefined {
  if (!hasWhitespace(fsPath)) return undefined;
  return (
    `the project path "${fsPath}" contains whitespace (a space in a folder name, possibly a trailing one). ` +
    `sfdk's build engine cannot handle that, and the build is likely to fail with "Cannot find real …". ` +
    `Rename or move the folder so the path has no spaces.`
  );
}
