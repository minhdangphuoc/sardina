import { parseSpec, type SpecSummary } from './specParser';

/**
 * vscode-free detection core (FR-2.2/FR-2.4), so unit tests can exercise it
 * against plain fixture directories with an injected `io` (M1.6) without a
 * real `vscode.workspace`. `detect.ts` adapts this to `vscode.workspace`.
 */
export interface DetectIO {
  /** Absolute paths of `rpm/*.spec` under `folderPath` (FR-2.2: `findFiles`, excl. node_modules, max 10). */
  findSpecFiles(folderPath: string): Promise<string[]>;
  readFile(specPath: string): Promise<string>;
  hasCMakeLists(folderPath: string): Promise<boolean>;
  hasProFile(folderPath: string): Promise<boolean>;
}

export interface DetectedProject extends SpecSummary {
  specPath: string;
  appBinaryPath: string;
}

/** Detects a single folder per FR-2.2, returning `undefined` when it is not a Sailfish OS project. */
export async function detectProjectAt(folderPath: string, io: DetectIO): Promise<DetectedProject | undefined> {
  const specs = await io.findSpecFiles(folderPath);
  if (specs.length === 0) {
    return undefined;
  }
  const specPath = specs[0];
  const [hasCMakeLists, hasProFile] = await Promise.all([
    io.hasCMakeLists(folderPath),
    io.hasProFile(folderPath),
  ]);

  let text: string;
  try {
    text = await io.readFile(specPath);
  } catch {
    text = '';
  }
  const info = parseSpec(text, { hasCMakeLists, hasProFile });

  const nameHasHarbourPrefix = info.name.startsWith('harbour-');
  if (!(hasCMakeLists || hasProFile || nameHasHarbourPrefix)) {
    return undefined;
  }

  return {
    ...info,
    specPath,
    appBinaryPath: `/usr/bin/${info.name}`,
  };
}
