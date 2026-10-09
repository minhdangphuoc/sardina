import {
  type QmlContext,
  type QmlMember,
  type QmlObject,
  type QmlOutline,
  contextAt,
  findObjectAt,
  toOutlineImport,
} from './qmlOutline';
import type { IndexedType, Member, Scope, TypeIndex } from './typeIndex';

/** Everything a feature needs about one open file. Offsets are character offsets into `text`. */
export interface FeatureEnv {
  index: TypeIndex;
  text: string;
  outline: QmlOutline;
  /** Directory of the file; enables same-directory types and directory imports. */
  dir?: string;
}

export type CompletionKind = 'type' | 'property' | 'signal' | 'method' | 'enum' | 'module' | 'version' | 'keyword' | 'id';

export interface Completion {
  label: string;
  kind: CompletionKind;
  detail?: string;
}

export interface Span {
  start: number;
  end: number;
}

export interface HoverResult extends Span {
  markdown: string;
}

export interface Problem extends Span {
  message: string;
}

/** Objects whose bodies hold arbitrary names, so unknown properties are never reported there. */
const DYNAMIC_BODIES = new Set([
  'Connections',
  'PropertyChanges',
  'ListElement',
  'Binding',
  'Component',
  'AnchorChanges',
  'ParentChange',
  'StateChangeScript',
]);

const scopeOf = (env: FeatureEnv): Scope => ({ imports: env.outline.imports.map(toOutlineImport), dir: env.dir });
const lastSegment = (name: string): string => name.slice(name.lastIndexOf('.') + 1);
const capitalise = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);
const isGroupName = (typeName: string): boolean => /^[a-z]/.test(lastSegment(typeName));
const typeNameSpan = (o: QmlObject): Span => ({ start: o.range.start.offset, end: o.range.start.offset + o.typeName.length });

type ObjectPath = QmlObject[];

function flatten(objects: QmlObject[], parents: ObjectPath = []): ObjectPath[] {
  return objects.flatMap((o) => [[...parents, o], ...flatten(o.children, [...parents, o])]);
}

const allPaths = (outline: QmlOutline): ObjectPath[] => flatten(outline.root ? [outline.root] : []);

function pathTo(outline: QmlOutline, target: QmlObject | undefined): ObjectPath {
  return allPaths(outline).find((p) => p[p.length - 1] === target) ?? [];
}

/** A property or id type name: C++ names first, then QML types visible in the file. */
async function resolveTypeName(env: FeatureEnv, name: string): Promise<IndexedType | undefined> {
  return env.index.cppType(name) ?? env.index.resolveType(scopeOf(env), name);
}

/** The type of an object; a group object such as `anchors {` takes the type of that property. */
async function typeOfObject(env: FeatureEnv, path: ObjectPath): Promise<IndexedType | undefined> {
  const obj = path[path.length - 1];
  if (!obj) return undefined;
  if (!isGroupName(obj.typeName)) return env.index.resolveType(scopeOf(env), obj.typeName);
  const parent = await typeOfObject(env, path.slice(0, -1));
  return parent && propertyType(env, parent, obj.typeName);
}

async function propertyType(env: FeatureEnv, owner: IndexedType, name: string): Promise<IndexedType | undefined> {
  const found = (await env.index.membersOf(owner)).items.find((m) => m.kind === 'property' && m.name === name);
  return found?.type ? resolveTypeName(env, found.type) : undefined;
}

function describeType(t: IndexedType): string {
  if (t.module) return t.major < 0 ? t.module : `${t.module} ${t.major}.${t.minor}`;
  return t.file ? 'QML component' : 'C++ type';
}

function handlersOf(member: Member): string[] {
  if (member.kind === 'signal') return [`on${capitalise(member.name)}`];
  return member.kind === 'property' ? [`on${capitalise(member.name)}Changed`] : [];
}

function memberCompletion(m: Member): Completion {
  const detail = [m.type, m.owner].filter(Boolean).join(' - ');
  return { label: m.name, kind: m.kind, detail };
}

function declaredMember(m: QmlMember): Member {
  return { kind: m.kind === 'alias' ? 'property' : (m.kind as Member['kind']), name: m.name, type: m.type, owner: 'this file' };
}

function typeCompletions(types: IndexedType[]): Completion[] {
  return types
    .filter((t) => t.creatable && !t.singleton)
    .map((t) => ({ label: t.name, kind: 'type', detail: describeType(t) }));
}

function addUnique(into: Map<string, Completion>, items: Completion[]): void {
  for (const c of items) if (!into.has(c.label)) into.set(c.label, c);
}

async function bodyCompletions(env: FeatureEnv, obj: QmlObject, partial: string): Promise<Completion[]> {
  const path = pathTo(env.outline, obj);
  const type = await typeOfObject(env, path);
  const found = new Map<string, Completion>();
  const declared = obj.members.filter((m) => m.kind !== 'binding').map(declaredMember);
  const members = [...declared, ...(type ? (await env.index.membersOf(type)).items : [])];
  addUnique(found, members.map(memberCompletion));
  addUnique(found, members.flatMap(handlersOf).map((label) => ({ label, kind: 'signal' as const, detail: 'handler' })));
  addUnique(found, [{ label: 'id', kind: 'keyword' }]);
  if (partial === '' || /^[A-Z]/.test(partial)) {
    addUnique(found, typeCompletions(await env.index.typesIn(scopeOf(env))));
  }
  return [...found.values()];
}

async function memberCompletions(env: FeatureEnv, type: IndexedType): Promise<Completion[]> {
  const found = new Map<string, Completion>();
  addUnique(found, (await env.index.membersOf(type)).items.map(memberCompletion));
  const enums = await env.index.enumsOf(type);
  addUnique(found, enums.items.flatMap((e) => e.values.map((v): Completion => ({ label: v, kind: 'enum', detail: e.name }))));
  const attached = type.cpp?.attachedType ? env.index.cppType(type.cpp.attachedType) : undefined;
  if (attached) {
    addUnique(found, (await env.index.membersOf(attached)).items.map((m) => ({ ...memberCompletion(m), detail: 'attached' })));
  }
  return [...found.values()];
}

/** Where `a.b.` leads: a type name, an id, `parent`, `Qt`, or a member of the enclosing object. */
async function headType(env: FeatureEnv, name: string, path: ObjectPath): Promise<IndexedType | undefined> {
  const id = env.outline.ids.find((i) => i.id === name);
  if (id) return env.index.resolveType(scopeOf(env), id.typeName);
  if (name === 'parent') return typeOfObject(env, path.slice(0, -1));
  const type = await typeOfObject(env, path);
  const member = type && (await propertyType(env, type, name));
  return member ?? env.index.cppType(name);
}

async function targetType(env: FeatureEnv, target: string, path: ObjectPath): Promise<IndexedType | undefined> {
  const whole = await env.index.resolveType(scopeOf(env), target);
  if (whole) return whole;
  const [first, ...rest] = target.split('.');
  let current = await headType(env, first, path);
  for (const name of rest) current = current && (await propertyType(env, current, name));
  return current;
}

async function dotCompletions(env: FeatureEnv, target: string, object: QmlObject | undefined): Promise<Completion[]> {
  const scope = scopeOf(env);
  if (scope.imports.some((i) => i.as === target && i.kind === 'module')) {
    return typeCompletions(await env.index.typesIn(scope, target));
  }
  const type = await targetType(env, target, pathTo(env.outline, object));
  return type ? memberCompletions(env, type) : [];
}

async function valueCompletions(env: FeatureEnv, obj: QmlObject): Promise<Completion[]> {
  const type = await typeOfObject(env, pathTo(env.outline, obj));
  const found = new Map<string, Completion>();
  addUnique(found, env.outline.ids.map((i) => ({ label: i.id, kind: 'id', detail: i.typeName })));
  addUnique(found, [{ label: 'parent', kind: 'keyword' }]);
  const members = type ? (await env.index.membersOf(type)).items : [];
  addUnique(found, members.filter((m) => m.kind !== 'signal').map(memberCompletion));
  const singletons = await env.index.singletonsIn(scopeOf(env));
  addUnique(found, singletons.map((t) => ({ label: t.name, kind: 'type' as const, detail: describeType(t) })));
  return [...found.values()];
}

async function importCompletions(env: FeatureEnv, prefix: string): Promise<Completion[]> {
  const version = /^([\w.]+)\s+[\d.]*$/.exec(prefix);
  if (version) {
    const versions = await env.index.versionsOf(version[1]);
    return versions.map((v) => ({ label: v, kind: 'version' as const }));
  }
  if (!/^[\w.]*$/.test(prefix)) return [];
  const modules = await env.index.modules();
  return modules.map((m) => ({ label: m.name, kind: 'module' as const }));
}

export async function completionsAt(env: FeatureEnv, offset: number): Promise<Completion[]> {
  const ctx: QmlContext = contextAt(env.outline, env.text, offset);
  switch (ctx.kind) {
    case 'import':
      return importCompletions(env, ctx.prefix);
    case 'afterDot':
      return dotCompletions(env, ctx.target, ctx.object);
    case 'body':
      return bodyCompletions(env, ctx.object, ctx.partial);
    case 'value':
      return valueCompletions(env, ctx.object);
    case 'top':
      return typeCompletions(await env.index.typesIn(scopeOf(env)));
    default:
      return [];
  }
}

function wordAt(text: string, offset: number): Span | undefined {
  const isWord = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);
  let start = offset;
  let end = offset;
  while (isWord(text[start - 1])) start--;
  while (isWord(text[end])) end++;
  return start === end ? undefined : { start, end };
}

const within = (s: Span, offset: number): boolean => offset >= s.start && offset <= s.end;
const fence = (code: string): string => `\`\`\`qml\n${code}\n\`\`\``;

async function typeHover(env: FeatureEnv, type: IndexedType, span: Span): Promise<HoverResult> {
  const chain = await env.index.chainOf(type);
  const names = chain.items.map((t) => t.name).join(' → ');
  const source = type.file ? `QML component in \`${type.file}\`` : 'C++ type';
  return { ...span, markdown: `${fence(type.name)}\n${describeType(type)}\n\n${names}${chain.partial ? ' → …' : ''}\n\n${source}` };
}

function memberDeclaration(m: Member): string {
  return m.kind === 'property' ? `property ${m.type ?? 'var'} ${m.name}` : `${m.kind} ${m.name}`;
}

function nameSpanOf(text: string, member: { name: string; range: { start: { offset: number } } }): Span {
  const start = text.indexOf(member.name, member.range.start.offset);
  return { start, end: start + member.name.length };
}

async function lookupMember(env: FeatureEnv, type: IndexedType, name: string): Promise<Member | undefined> {
  const members = (await env.index.membersOf(type)).items;
  const direct = members.find((m) => m.name === name);
  if (direct) return direct;
  return members.flatMap((m) => handlersOf(m).map((h) => ({ h, m }))).find((x) => x.h === name)?.m;
}

async function memberHover(env: FeatureEnv, path: ObjectPath, offset: number): Promise<HoverResult | undefined> {
  const obj = path[path.length - 1];
  const member = obj.members.find((m) => within(nameSpanOf(env.text, m), offset));
  if (!member) return undefined;
  const span = nameSpanOf(env.text, member);
  if (member.kind !== 'binding') {
    const decl = member.kind === 'alias' ? `property alias ${member.name}` : `${member.kind} ${member.name}`;
    return { ...span, markdown: fence(member.type ? `property ${member.type} ${member.name}` : decl) };
  }
  const type = await typeOfObject(env, path);
  const found = type && (await lookupMember(env, type, member.name));
  return found ? { ...span, markdown: `${fence(memberDeclaration(found))}\n${found.owner}` } : undefined;
}

export async function hoverAt(env: FeatureEnv, offset: number): Promise<HoverResult | undefined> {
  if (contextAt(env.outline, env.text, offset).kind === 'none') return undefined;
  const paths = allPaths(env.outline);
  const named = paths.find((p) => within(typeNameSpan(p[p.length - 1]), offset));
  if (named) {
    const type = await env.index.resolveType(scopeOf(env), named[named.length - 1].typeName);
    return type && typeHover(env, type, typeNameSpan(named[named.length - 1]));
  }
  const word = wordAt(env.text, offset);
  const id = word && env.outline.ids.find((i) => i.id === env.text.slice(word.start, word.end));
  if (word && id) return { ...word, markdown: `${fence(`id: ${id.id}`)}\n${id.typeName}` };
  const object = findObjectAt(env.outline, offset);
  return object ? memberHover(env, pathTo(env.outline, object), offset) : undefined;
}

async function importsResolve(env: FeatureEnv): Promise<boolean> {
  const scope = scopeOf(env);
  const results = await Promise.all(scope.imports.map((i) => env.index.importResolves(i, scope)));
  return results.every(Boolean);
}

async function unknownProperties(env: FeatureEnv, path: ObjectPath, type: IndexedType): Promise<Problem[]> {
  const obj = path[path.length - 1];
  if (DYNAMIC_BODIES.has(lastSegment(obj.typeName))) return [];
  const members = await env.index.membersOf(type);
  if (members.partial) return [];
  const known = new Set([...members.items.map((m) => m.name), ...obj.members.filter((m) => m.kind !== 'binding').map((m) => m.name)]);
  return obj.members
    .filter((m) => m.kind === 'binding' && !m.name.includes('.') && m.name !== 'id' && !/^on[A-Z]/.test(m.name) && !known.has(m.name))
    .map((m) => ({ ...nameSpanOf(env.text, m), message: `Unknown property "${m.name}" on "${obj.typeName}"` }));
}

async function problemsOf(env: FeatureEnv, path: ObjectPath): Promise<Problem[]> {
  const obj = path[path.length - 1];
  if (isGroupName(obj.typeName)) return [];
  const type = await env.index.resolveType(scopeOf(env), obj.typeName);
  if (!type) return [{ ...typeNameSpan(obj), message: `Unknown type "${obj.typeName}"` }];
  return unknownProperties(env, path, type);
}

/** Reports only what is certain: nothing unless the file parsed cleanly and every import resolved. */
export async function diagnose(env: FeatureEnv): Promise<Problem[]> {
  if (!env.outline.clean || !env.outline.root || !(await importsResolve(env))) return [];
  const problems: Problem[] = [];
  for (const path of allPaths(env.outline)) problems.push(...(await problemsOf(env, path)));
  return problems;
}
