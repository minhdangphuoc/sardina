import * as path from 'path';

/** Where a build target keeps its QML modules; 64-bit targets use `lib64`. */
const ROOT_CANDIDATES = [path.join('usr', 'lib64', 'qt5', 'qml'), path.join('usr', 'lib', 'qt5', 'qml')];

export function importRootFor(sdkRoot: string, targetName: string, exists: (dir: string) => boolean): string | undefined {
  const targetDir = path.join(sdkRoot, 'mersdk', 'targets', targetName);
  return ROOT_CANDIDATES.map((c) => path.join(targetDir, c)).find(exists);
}

/** Qt's lookup order for a module directory: `Name.major.minor`, `Name.major`, then `Name`. */
export function moduleDirCandidates(root: string, module: string, major: number, minor: number): string[] {
  const base = path.join(root, ...module.split('.'));
  if (major < 0) return [base];
  const versioned = minor < 0 ? [] : [`${base}.${major}.${minor}`];
  return [...versioned, `${base}.${major}`, base];
}
