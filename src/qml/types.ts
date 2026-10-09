/** A module import such as `QtQuick 2.6`; `minor` is -1 when the version is missing. */
export interface ModuleRef {
  module: string;
  major: number;
  minor: number;
}

export function parseVersion(text: string | undefined): { major: number; minor: number } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text ?? '');
  return m ? { major: Number(m[1]), minor: m[2] === undefined ? 0 : Number(m[2]) } : { major: -1, minor: -1 };
}

export interface OutlineImport {
  kind: 'module' | 'dir' | 'js';
  /** Module name, directory path or JS file path, as written. */
  target: string;
  version?: string;
  /** Qualifier after `as`. */
  as?: string;
}

export interface OutlineMember {
  kind: 'property' | 'alias' | 'signal' | 'method';
  name: string;
  /** Declared type of a property; absent for aliases, signals and methods. */
  type?: string;
}

/**
 * What the type index needs from one QML component file: the type of its root object, its
 * imports (the scope that resolves `rootType`) and the members the root object declares.
 * Implemented by the QML outline parser; the index never sees anything else of a file.
 */
export interface QmlComponentOutline {
  rootType: string;
  imports: OutlineImport[];
  members: OutlineMember[];
}
