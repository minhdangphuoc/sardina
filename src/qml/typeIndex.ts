import * as path from 'path';
import { moduleDirCandidates } from './importRoot';
import { parseQmldir, type QmlDir } from './qmldir';
import { type CppComponent, type CppModule, parseQmltypes } from './qmltypes';
import { type ModuleRef, type OutlineImport, type QmlComponentOutline, parseVersion } from './types';

export interface IndexIO {
  readFile(file: string): Promise<string | undefined>;
  readdir(dir: string): Promise<string[] | undefined>;
  stat(file: string): Promise<{ mtimeMs: number; isDirectory: boolean } | undefined>;
}

/** The imports of one file and its directory: everything that decides which type names are visible. */
export interface Scope {
  imports: OutlineImport[];
  dir?: string;
}

export interface IndexedType {
  /** The QML name; the C++ name for a type without export. */
  name: string;
  module?: string;
  major: number;
  minor: number;
  singleton: boolean;
  creatable: boolean;
  cpp?: CppComponent;
  /** Component file of a QML type. */
  file?: string;
}

export interface Member {
  kind: 'property' | 'signal' | 'method';
  name: string;
  type?: string;
  isReadonly?: boolean;
  isPointer?: boolean;
  owner: string;
}

export interface Chain<T> {
  items: T[];
  /** A link could not be resolved, so `items` may be incomplete. */
  partial: boolean;
}

export interface TypeIndexOptions {
  parseComponent: (text: string) => QmlComponentOutline;
  now?: () => number;
}

const RECHECK_MS = 10_000;
const MAX_CHAIN = 32;
const MAX_WALK_DEPTH = 6;
const IMPLIED_QML: ModuleRef = { module: 'QtQml', major: 2, minor: 0 };

interface ModuleRecord {
  dir: string;
  cpp: CppModule;
  qmldir: QmlDir;
  files: string[];
  signature: string;
  types: Map<string, IndexedType[]>;
}

interface Cached<T> {
  value?: T;
  checkedAt: number;
  signature?: string;
}

const isVisible = (t: IndexedType, imp: OutlineImport): boolean => {
  const { major, minor } = parseVersion(imp.version);
  return major < 0 || (t.major === major && t.minor <= minor);
};

const refKey = (r: ModuleRef): string => `${r.module}@${r.major}.${r.minor}`;

/**
 * Lazy view of a QML import root. A module is read when a scope first imports it, together with
 * what its prototypes need; files are re-checked at most every 10 s and reread when they change.
 */
export class TypeIndex {
  private readonly now: () => number;
  private readonly dirOfRef = new Map<string, Cached<string>>();
  private readonly records = new Map<string, Cached<ModuleRecord>>();
  private readonly dirs = new Map<string, Cached<Map<string, IndexedType>>>();
  private readonly components = new Map<string, Cached<QmlComponentOutline>>();
  private builtins: Cached<ModuleRecord> | undefined;
  private moduleList: Promise<{ name: string; dir: string }[]> | undefined;

  constructor(
    private readonly io: IndexIO,
    private readonly root: string,
    private readonly options: TypeIndexOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Visible type `name` (optionally `Qualifier.Name`) in `scope`. */
  async resolveType(scope: Scope, name: string): Promise<IndexedType | undefined> {
    const dot = name.lastIndexOf('.');
    const qualifier = dot < 0 ? undefined : name.slice(0, dot);
    const bare = name.slice(dot + 1);
    if (qualifier === undefined && scope.dir) {
      const local = (await this.dirTypes(scope.dir)).get(bare);
      if (local) return local;
    }
    for (const imp of this.effectiveImports(scope)) {
      if (imp.as !== qualifier || imp.kind === 'js') continue;
      const found = await this.typesOfImport(imp, scope, bare);
      if (found) return found;
    }
    return undefined;
  }

  /** Types visible in `scope` under `qualifier` (none for unqualified), the nearest declaration of a name winning. */
  async typesIn(scope: Scope, qualifier?: string): Promise<IndexedType[]> {
    const found = new Map<string, IndexedType>();
    if (qualifier === undefined && scope.dir) {
      for (const [name, t] of await this.dirTypes(scope.dir)) found.set(name, t);
    }
    for (const imp of this.effectiveImports(scope)) {
      if (imp.as !== qualifier || imp.kind === 'js') continue;
      for (const t of await this.typesOfImportAll(imp, scope)) if (!found.has(t.name)) found.set(t.name, t);
    }
    return [...found.values()];
  }

  /** Whether an import points at something that exists: a loadable module, a directory or a script. */
  async importResolves(imp: OutlineImport, scope: Scope): Promise<boolean> {
    if (imp.kind === 'module') return !!(await this.ensureLoaded(this.refOf(imp), new Set()));
    if (!scope.dir) return false;
    return !!(await this.io.stat(path.join(scope.dir, imp.target)));
  }

  async chainOf(type: IndexedType): Promise<Chain<IndexedType>> {
    const items: IndexedType[] = [];
    const seen = new Set<string>();
    let current: IndexedType | undefined = type;
    while (current && items.length < MAX_CHAIN) {
      const key = current.file ?? `cpp:${current.cpp?.name ?? current.name}`;
      if (seen.has(key)) return { items, partial: true };
      seen.add(key);
      items.push(current);
      const next = await this.parentOf(current);
      if (next === 'end') return { items, partial: false };
      if (!next) return { items, partial: true };
      current = next;
    }
    return { items, partial: true };
  }

  /** Own and inherited members, the most derived declaration of a name winning. */
  async membersOf(type: IndexedType): Promise<Chain<Member>> {
    const chain = await this.chainOf(type);
    const items = new Map<string, Member>();
    for (const t of chain.items) {
      for (const m of await this.ownMembers(t)) {
        const key = `${m.kind}:${m.name}`;
        if (!items.has(key)) items.set(key, m);
      }
    }
    return { items: [...items.values()], partial: chain.partial };
  }

  async enumsOf(type: IndexedType): Promise<Chain<{ name: string; values: string[]; owner: string }>> {
    const chain = await this.chainOf(type);
    const items = chain.items.flatMap((t) => (t.cpp?.enums ?? []).map((e) => ({ ...e, owner: t.name })));
    return { items, partial: chain.partial };
  }

  /** A C++ type by its C++ name, e.g. a property type or an `attachedType`. */
  cppType(cppName: string): IndexedType | undefined {
    for (const record of this.loadedRecords()) {
      const cpp = record.cpp.components.find((c) => c.name === cppName);
      if (cpp) return { name: cpp.name, major: -1, minor: -1, singleton: cpp.isSingleton, creatable: cpp.isCreatable, cpp };
    }
    return undefined;
  }

  async singletonsIn(scope: Scope): Promise<IndexedType[]> {
    const result: IndexedType[] = [];
    for (const imp of this.effectiveImports(scope)) {
      if (imp.kind !== 'module' || imp.as) continue;
      const record = await this.ensureLoaded(this.refOf(imp), new Set());
      for (const types of record?.types.values() ?? []) {
        result.push(...types.filter((t) => t.singleton && isVisible(t, imp)));
      }
    }
    return result;
  }

  /** Versions (`major.minor`, ascending) a module exports. */
  async versionsOf(module: string): Promise<string[]> {
    const found = (await this.modules()).find((m) => m.name === module);
    const record = found && (await this.readRecord(found.dir, module));
    const versions = new Set<string>();
    for (const types of record?.types.values() ?? []) for (const t of types) versions.add(`${t.major}.${t.minor}`);
    return [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  /** Module names found under the import root; scanned once. */
  modules(): Promise<{ name: string; dir: string }[]> {
    this.moduleList ??= this.scanModules();
    return this.moduleList;
  }

  private effectiveImports(scope: Scope): OutlineImport[] {
    const implied = scope.imports
      .filter((i) => i.kind === 'module' && i.target === 'QtQuick')
      .map((i): OutlineImport => ({ kind: 'module', target: IMPLIED_QML.module, version: '2.0', as: i.as }));
    return [...scope.imports, ...implied];
  }

  private refOf(imp: OutlineImport): ModuleRef {
    return { module: imp.target, ...parseVersion(imp.version) };
  }

  private async typesOfImport(imp: OutlineImport, scope: Scope, name: string): Promise<IndexedType | undefined> {
    if (imp.kind === 'dir') {
      return scope.dir ? (await this.dirTypes(path.join(scope.dir, imp.target))).get(name) : undefined;
    }
    const record = await this.ensureLoaded(this.refOf(imp), new Set());
    const candidates = (record?.types.get(name) ?? []).filter((t) => isVisible(t, imp));
    return candidates.sort((a, b) => b.major - a.major || b.minor - a.minor)[0];
  }

  private async typesOfImportAll(imp: OutlineImport, scope: Scope): Promise<IndexedType[]> {
    if (imp.kind === 'dir') {
      return scope.dir ? [...(await this.dirTypes(path.join(scope.dir, imp.target))).values()] : [];
    }
    const record = await this.ensureLoaded(this.refOf(imp), new Set());
    const best = new Map<string, IndexedType>();
    for (const list of record?.types.values() ?? []) {
      for (const t of list.filter((x) => isVisible(x, imp))) {
        const old = best.get(t.name);
        if (!old || t.major > old.major || (t.major === old.major && t.minor > old.minor)) best.set(t.name, t);
      }
    }
    return [...best.values()];
  }

  private async parentOf(type: IndexedType): Promise<IndexedType | undefined | 'end'> {
    if (type.cpp) {
      if (!type.cpp.prototype) return 'end';
      await this.loadBuiltins();
      return this.cppType(type.cpp.prototype);
    }
    const outline = type.file ? await this.outlineOf(type.file) : undefined;
    if (!outline || !type.file) return undefined;
    return this.resolveType({ imports: outline.imports, dir: path.dirname(type.file) }, outline.rootType);
  }

  private async ownMembers(type: IndexedType): Promise<Member[]> {
    if (type.cpp) {
      const owner = type.name;
      return [
        ...type.cpp.properties.map((p): Member => ({ kind: 'property', name: p.name, type: p.type, isReadonly: p.isReadonly, isPointer: p.isPointer, owner })),
        ...type.cpp.signals.map((s): Member => ({ kind: 'signal', name: s.name, owner })),
        ...type.cpp.methods.map((m): Member => ({ kind: 'method', name: m.name, owner })),
      ];
    }
    const outline = type.file ? await this.outlineOf(type.file) : undefined;
    return (outline?.members ?? []).map((m): Member => ({
      kind: m.kind === 'alias' ? 'property' : m.kind,
      name: m.name,
      type: m.type,
      owner: type.name,
    }));
  }

  private loadedRecords(): ModuleRecord[] {
    const records = [...this.records.values()].map((c) => c.value).filter((r): r is ModuleRecord => !!r);
    return this.builtins?.value ? [...records, this.builtins.value] : records;
  }

  private async loadBuiltins(): Promise<void> {
    this.builtins = await this.refreshRecord(this.builtins, () => this.readRecord(this.root, undefined, 'builtins.qmltypes'));
  }

  /** Loads a module and what its prototypes need: its declared dependencies, QtQml for QtQuick, builtins. */
  private async ensureLoaded(ref: ModuleRef, seen: Set<string>): Promise<ModuleRecord | undefined> {
    await this.loadBuiltins();
    const key = refKey(ref);
    const record = seen.has(key) ? undefined : await this.loadRecord(ref, key);
    seen.add(key);
    if (!record) return undefined;
    const deps = [...record.cpp.dependencies, ...record.qmldir.depends];
    if (ref.module === 'QtQuick') deps.push(IMPLIED_QML);
    for (const dep of deps) if (!seen.has(refKey(dep))) await this.ensureLoaded(dep, seen);
    return record;
  }

  private async loadRecord(ref: ModuleRef, key: string): Promise<ModuleRecord | undefined> {
    const dir = await this.refresh(this.dirOfRef.get(key), () => this.findModuleDir(ref));
    this.dirOfRef.set(key, dir);
    if (!dir.value) return undefined;
    const record = await this.refreshRecord(this.records.get(dir.value), () => this.readRecord(dir.value!, ref.module));
    this.records.set(dir.value, record);
    return record.value;
  }

  private async findModuleDir(ref: ModuleRef): Promise<string | undefined> {
    for (const dir of moduleDirCandidates(this.root, ref.module, ref.major, ref.minor)) {
      if (await this.io.stat(path.join(dir, 'qmldir'))) return dir;
    }
    return undefined;
  }

  /** Keeps `cached` for 10 s, then reads again with `read`. */
  private async refresh<T>(cached: Cached<T> | undefined, read: () => Promise<T | undefined>): Promise<Cached<T>> {
    const now = this.now();
    if (cached && now - cached.checkedAt < RECHECK_MS) return cached;
    return { value: await read(), checkedAt: now };
  }

  /** Like `refresh`, but keeps the record when none of its files changed. */
  private async refreshRecord(
    cached: Cached<ModuleRecord> | undefined,
    read: () => Promise<ModuleRecord>,
  ): Promise<Cached<ModuleRecord>> {
    const old = cached?.value;
    if (cached && this.now() - cached.checkedAt < RECHECK_MS) return cached;
    if (old && (await this.signatureOf(old.files)) === old.signature) return { value: old, checkedAt: this.now() };
    return { value: await read(), checkedAt: this.now() };
  }

  private async signatureOf(files: string[]): Promise<string> {
    const stats = await Promise.all(files.map((f) => this.io.stat(f)));
    return stats.map((s) => s?.mtimeMs ?? 0).join(',');
  }

  private async readRecord(dir: string, module: string | undefined, fixedTypeinfo?: string): Promise<ModuleRecord> {
    const qmldirFile = path.join(dir, 'qmldir');
    const qmldir = module ? parseQmldir((await this.io.readFile(qmldirFile)) ?? '') : parseQmldir('');
    const infoFiles = (fixedTypeinfo ? [fixedTypeinfo] : qmldir.typeinfo).map((f) => path.join(dir, f));
    const cpp: CppModule = { dependencies: [], components: [] };
    for (const file of infoFiles) {
      const parsed = parseQmltypes((await this.io.readFile(file)) ?? '');
      cpp.dependencies.push(...parsed.dependencies);
      cpp.components.push(...parsed.components);
    }
    const files = module ? [qmldirFile, ...infoFiles] : infoFiles;
    return {
      dir,
      cpp,
      qmldir,
      files,
      signature: await this.signatureOf(files),
      types: module ? typeTable(dir, module, qmldir, cpp) : new Map<string, IndexedType[]>(),
    };
  }

  private async outlineOf(file: string): Promise<QmlComponentOutline | undefined> {
    const cached = this.components.get(file);
    const now = this.now();
    if (cached && now - cached.checkedAt < RECHECK_MS) return cached.value;
    const signature = await this.signatureOf([file]);
    if (cached && cached.signature === signature) {
      cached.checkedAt = now;
      return cached.value;
    }
    const text = await this.io.readFile(file);
    const value = text === undefined ? undefined : this.safeParse(text);
    this.components.set(file, { value, checkedAt: now, signature });
    return value;
  }

  private safeParse(text: string): QmlComponentOutline | undefined {
    try {
      return this.options.parseComponent(text);
    } catch {
      return undefined;
    }
  }

  /** Types a directory provides: its `qmldir` entries, or else every capitalised `.qml` file. */
  private async dirTypes(dir: string): Promise<Map<string, IndexedType>> {
    const cached = this.dirs.get(dir);
    const now = this.now();
    if (cached?.value && now - cached.checkedAt < RECHECK_MS) return cached.value;
    const types = new Map<string, IndexedType>();
    const qmldirText = await this.io.readFile(path.join(dir, 'qmldir'));
    if (qmldirText !== undefined) {
      for (const [name, list] of typeTable(dir, undefined, parseQmldir(qmldirText), { dependencies: [], components: [] })) {
        types.set(name, list[list.length - 1]);
      }
    }
    for (const file of (await this.io.readdir(dir)) ?? []) {
      const name = file.slice(0, -'.qml'.length);
      if (file.endsWith('.qml') && /^[A-Z]/.test(file) && !types.has(name)) {
        types.set(name, qmlType(name, undefined, path.join(dir, file), 0, 0, false));
      }
    }
    this.dirs.set(dir, { value: types, checkedAt: now });
    return types;
  }

  private scanModules(): Promise<{ name: string; dir: string }[]> {
    const found = new Map<string, string>();
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const entry of (await this.io.readdir(dir)) ?? []) {
        const full = path.join(dir, entry);
        if (entry === 'qmldir') {
          const name = parseQmldir((await this.io.readFile(full)) ?? '').module;
          if (name && !found.has(name)) found.set(name, dir);
        } else if (depth < MAX_WALK_DEPTH && (await this.io.stat(full))?.isDirectory) {
          await walk(full, depth + 1);
        }
      }
    };
    return walk(this.root, 0).then(() => [...found].map(([name, dir]) => ({ name, dir })));
  }
}

function qmlType(name: string, module: string | undefined, file: string, major: number, minor: number, singleton: boolean): IndexedType {
  return { name, module, major, minor, singleton, creatable: !singleton, file };
}

/** QML components from `qmldir` plus the exports of the module's own type description. */
function typeTable(dir: string, module: string | undefined, qmldir: QmlDir, cpp: CppModule): Map<string, IndexedType[]> {
  const table = new Map<string, IndexedType[]>();
  const add = (t: IndexedType): void => {
    table.set(t.name, [...(table.get(t.name) ?? []), t]);
  };
  for (const e of qmldir.entries) {
    if (e.internal || !e.file.endsWith('.qml')) continue;
    add(qmlType(e.name, module, path.join(dir, e.file), e.major, e.minor, e.singleton));
  }
  for (const c of cpp.components) {
    for (const x of c.exports.filter((x) => x.module === module)) {
      add({ name: x.name, module, major: x.major, minor: x.minor, singleton: c.isSingleton, creatable: c.isCreatable, cpp: c });
    }
  }
  return table;
}
