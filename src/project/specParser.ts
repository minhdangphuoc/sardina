export interface SpecSummary {
  name: string;
  version?: string;
  release?: string;
  summary?: string;
  buildRequires: string[];
  hasNativeBinary: boolean;
  isPureQml: boolean;
  buildSystem: 'qmake' | 'cmake' | 'unknown';
}

export interface SpecContext {
  hasCMakeLists: boolean;
  hasProFile: boolean;
}

const FIELD_RE = /^(Name|Version|Release|Summary)\s*:\s*(.*)$/i;
const BUILD_REQUIRES_RE = /^BuildRequires\s*:\s*(.*)$/i;
const REQUIRES_RE = /^Requires\s*:\s*(.*)$/i;
// Section-start keywords only; %files file-attribute directives (%defattr, %doc, ...) must NOT end the section.
const SECTION_RE = /^%(description|prep|build|install|files|post|postun|pre|preun|changelog|check|clean|package)\b/;
// FR-2.4: preamble fields come only from before any of these section keywords.
const PREAMBLE_END_RE = SECTION_RE;
// The main package's `%files`, with only `-f <list>` option flags and no subpackage name or `-n`.
const MAIN_FILES_RE = /^%files(\s+-f\s+\S+)*$/;

const VERSION_OPERATOR_RE = /^(<=|>=|<|>|=)$/;

/** A `Requires:` line may list entries separated by commas or whitespace, each with an optional version operator + version. */
function bareRequireNames(line: string): string[] {
  const tokens = line.split(/[\s,]+/).filter((t) => t.length > 0);
  const names: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (VERSION_OPERATOR_RE.test(tokens[i])) {
      i++;
      continue;
    }
    names.push(tokens[i]);
  }
  return names;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `%{_bindir}/<name>` appears in `%files` as its own whitespace-delimited token, not as a substring of a longer path. */
function hasBindirEntry(filesText: string, name: string): boolean {
  const token = escapeRegExp(`%{_bindir}/${name}`);
  return new RegExp(`(^|\\s)${token}(\\s|$)`, 'm').test(filesText);
}

/** Expands `%{name}`/`%{version}` from already-parsed fields; other macros are left verbatim (FR-2.4). */
function expandMacros(text: string, fields: { name?: string; version?: string }): string {
  let out = text;
  if (fields.name !== undefined) {
    out = out.replace(/%\{name\}/g, fields.name);
  }
  if (fields.version !== undefined) {
    out = out.replace(/%\{version\}/g, fields.version);
  }
  return out;
}

/** Pure parser (FR-2.4); never throws (§0.2 rule 2) — unparseable/empty input yields a summary with an empty name. */
export function parseSpec(text: string, ctx: SpecContext): SpecSummary {
  try {
    const lines = text.split(/\r?\n/);
    let name: string | undefined;
    let version: string | undefined;
    let release: string | undefined;
    let summary: string | undefined;
    const buildRequires: string[] = [];
    const requires: string[] = [];
    let inFiles = false;
    let inPreamble = true;
    let filesText = '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      // Any other section, including a subpackage's own `%files`, ends the main section without starting a new one.
      if (inFiles && SECTION_RE.test(line)) {
        inFiles = false;
      }
      if (MAIN_FILES_RE.test(line)) {
        inFiles = true;
        inPreamble = false;
        continue;
      }
      if (inFiles) {
        filesText += `${rawLine}\n`;
      }
      if (inPreamble && PREAMBLE_END_RE.test(line)) {
        inPreamble = false;
      }
      if (!inPreamble) {
        continue;
      }

      const fieldMatch = FIELD_RE.exec(rawLine);
      if (fieldMatch) {
        const [, key, rawValue] = fieldMatch;
        const value = expandMacros(rawValue.trim(), { name, version });
        switch (key.toLowerCase()) {
          case 'name':
            name = value;
            break;
          case 'version':
            version = value;
            break;
          case 'release':
            release = value;
            break;
          case 'summary':
            summary = value;
            break;
        }
        continue;
      }

      const buildRequiresMatch = BUILD_REQUIRES_RE.exec(rawLine);
      if (buildRequiresMatch) {
        buildRequires.push(expandMacros(buildRequiresMatch[1].trim(), { name, version }));
        continue;
      }

      const requiresMatch = REQUIRES_RE.exec(rawLine);
      if (requiresMatch) {
        requires.push(...bareRequireNames(expandMacros(requiresMatch[1].trim(), { name, version })));
      }
    }

    const expandedFiles = expandMacros(filesText, { name, version });
    const hasNativeBinary = name !== undefined && hasBindirEntry(expandedFiles, name);
    const isPureQml =
      !hasNativeBinary && requires.some((r) => r === 'sailfish-qml' || r === 'sailfishsilica-qt5');

    const buildSystem: SpecSummary['buildSystem'] = ctx.hasCMakeLists
      ? 'cmake'
      : ctx.hasProFile
        ? 'qmake'
        : 'unknown';

    return {
      name: name ?? '',
      version,
      release,
      summary,
      buildRequires,
      hasNativeBinary,
      isPureQml,
      buildSystem,
    };
  } catch {
    return {
      name: '',
      buildRequires: [],
      hasNativeBinary: false,
      isPureQml: false,
      buildSystem: ctx.hasCMakeLists ? 'cmake' : ctx.hasProFile ? 'qmake' : 'unknown',
    };
  }
}
