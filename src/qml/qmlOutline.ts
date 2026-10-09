/**
 * Tolerant one-pass outline of a `.qml` file: imports, object tree, members, ids.
 * Pure and never throws; broken input yields a partial outline with `clean === false`.
 */
import type { OutlineImport, QmlComponentOutline } from "./types";

export interface Pos {
  offset: number;
  line: number;
  col: number;
}

export interface Range {
  start: Pos;
  end: Pos;
}

export interface QmlImport {
  kind: "module" | "dir" | "js";
  module?: string;
  version?: string;
  qualifier?: string;
  path?: string;
  range: Range;
}

export interface QmlMember {
  kind: "property" | "alias" | "signal" | "method" | "binding";
  /** Dotted for bindings such as `anchors.fill`. */
  name: string;
  /** Property type as written. */
  type?: string;
  params?: string[];
  readonly?: boolean;
  isDefault?: boolean;
  range: Range;
  /** Offset just after the `:` of a binding or initialised property. */
  valueStart?: number;
}

export interface QmlObject {
  /** As written, possibly qualified (`Q.Type`); lower-case for group properties (`anchors {`). */
  typeName: string;
  /** Property of `Type on prop {`. */
  onProperty?: string;
  /** Property this object is assigned to (`delegate: Item {`). */
  assignedTo?: string;
  id?: string;
  range: Range;
  /** Between the braces. */
  body: Range;
  members: QmlMember[];
  children: QmlObject[];
}

export interface QmlId {
  id: string;
  typeName: string;
  range: Range;
}

export interface QmlOutline {
  imports: QmlImport[];
  root?: QmlObject;
  ids: QmlId[];
  /** False when braces, strings or comments did not balance. */
  clean: boolean;
  /** Strings, comments and regex literals. */
  opaque: { start: number; end: number; closed: boolean }[];
}

export type QmlContext =
  | { kind: "import"; prefix: string }
  | { kind: "afterDot"; target: string; partial: string; object?: QmlObject }
  | { kind: "body"; object: QmlObject; partial: string }
  | { kind: "value"; object: QmlObject; member: QmlMember }
  | { kind: "top" }
  | { kind: "none" };

interface Tok {
  k: "id" | "num" | "str" | "p";
  s: number;
  e: number;
  v: string;
}

interface Scan {
  end: number;
  closed: boolean;
}

interface Header {
  typeName: string;
  open: number;
  onProp?: string;
}

const MAX_DEPTH = 100;
const DECL_KEYWORDS = [
  "property",
  "signal",
  "function",
  "readonly",
  "default",
  "required",
  "enum",
];
const REGEX_AFTER = [
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "else",
  "do",
  "instanceof",
];

export function parseQmlOutline(text: string): QmlOutline {
  try {
    return new Parser(text).run();
  } catch {
    return { imports: [], ids: [], clean: false, opaque: [] };
  }
}

export function toComponentOutline(outline: QmlOutline): QmlComponentOutline {
  const members: QmlComponentOutline["members"] = [];
  for (const m of outline.root?.members ?? []) {
    if (m.kind === "binding") continue;
    members.push({ kind: m.kind, name: m.name, ...(m.type ? { type: m.type } : {}) });
  }
  const imports = outline.imports.map(toOutlineImport);
  return { rootType: outline.root?.typeName ?? "", imports, members };
}

export function toOutlineImport(i: QmlImport): OutlineImport {
  return {
    kind: i.kind,
    target: (i.kind === "module" ? i.module : i.path) ?? "",
    ...(i.version !== undefined ? { version: i.version } : {}),
    ...(i.qualifier !== undefined ? { as: i.qualifier } : {}),
  };
}

/** Innermost object whose body contains the offset. */
export function findObjectAt(
  outline: QmlOutline,
  offset: number,
): QmlObject | undefined {
  let found: QmlObject | undefined;
  let level: QmlObject[] = outline.root ? [outline.root] : [];
  while (level.length > 0) {
    const next = level.find(
      (o) => offset >= o.body.start.offset && offset <= o.body.end.offset,
    );
    if (!next) break;
    found = next;
    level = next.children;
  }
  return found;
}

export function contextAt(
  outline: QmlOutline,
  text: string,
  offset: number,
): QmlContext {
  if (
    outline.opaque.some(
      (o) =>
        o.start < offset && (offset < o.end || (!o.closed && offset <= o.end)),
    )
  )
    return { kind: "none" };
  const prefix = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);
  const imp = /^\s*import\s(.*)$/.exec(prefix);
  if (imp) return { kind: "import", prefix: imp[1] };
  const object = findObjectAt(outline, offset);
  const dot = /((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\.([\w$]*)$/.exec(
    prefix,
  );
  if (dot) return { kind: "afterDot", target: dot[1], partial: dot[2], object };
  if (!object) return { kind: "top" };
  const member = object.members.find((m) => inValue(m, text, offset));
  if (member) return { kind: "value", object, member };
  return { kind: "body", object, partial: /[\w$]*$/.exec(prefix)![0] };
}

function inValue(m: QmlMember, text: string, offset: number): boolean {
  if (m.valueStart === undefined || offset < m.valueStart) return false;
  const end = m.range.end.offset;
  return (
    offset <= end ||
    (end === m.valueStart && !text.slice(m.valueStart, offset).includes("\n"))
  );
}

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127;
}

function isIdentPart(c: string): boolean {
  return /[\w$]/.test(c) || c.charCodeAt(0) > 127;
}

function isUpper(typeName: string): boolean {
  const last = typeName.slice(typeName.lastIndexOf(".") + 1);
  return /^[A-Z]/.test(last);
}

class Lexer {
  readonly toks: Tok[] = [];
  readonly opaque: QmlOutline["opaque"] = [];
  clean = true;

  constructor(private readonly text: string) {
    this.run();
  }

  private run(): void {
    const { text } = this;
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (/\s/.test(c)) i++;
      else if (c === "/" && text[i + 1] === "/") i = this.lineComment(i);
      else if (c === "/" && text[i + 1] === "*") i = this.blockComment(i);
      else if (c === '"' || c === "'") i = this.literal(i, this.string(i, c));
      else if (c === "`") i = this.literal(i, this.template(i));
      else if (c === "/" && this.regexAllowed()) i = this.regex(i);
      else if (isIdentStart(c)) i = this.word(i, "id", isIdentPart);
      else if (/\d/.test(c)) i = this.word(i, "num", (ch) => /[\w.]/.test(ch));
      else {
        this.toks.push({ k: "p", s: i, e: i + 1, v: c });
        i++;
      }
    }
  }

  private word(i: number, k: Tok["k"], part: (c: string) => boolean): number {
    let j = i + 1;
    while (j < this.text.length && part(this.text[j])) j++;
    this.toks.push({ k, s: i, e: j, v: this.text.slice(i, j) });
    return j;
  }

  private lineComment(i: number): number {
    const nl = this.text.indexOf("\n", i);
    const end = nl < 0 ? this.text.length : nl;
    this.opaque.push({ start: i, end, closed: false });
    return end;
  }

  private blockComment(i: number): number {
    const close = this.text.indexOf("*/", i + 2);
    if (close < 0) {
      this.clean = false;
      this.opaque.push({ start: i, end: this.text.length, closed: false });
      return this.text.length;
    }
    this.opaque.push({ start: i, end: close + 2, closed: true });
    return close + 2;
  }

  private literal(i: number, scan: Scan): number {
    if (!scan.closed) this.clean = false;
    this.push(i, scan.end, "str", scan.closed);
    return scan.end;
  }

  private push(s: number, e: number, k: Tok["k"], closed: boolean): void {
    this.toks.push({ k, s, e, v: this.text.slice(s, e) });
    this.opaque.push({ start: s, end: e, closed });
  }

  private string(i: number, quote: string): Scan {
    const { text } = this;
    let j = i + 1;
    while (j < text.length && text[j] !== "\n") {
      if (text[j] === "\\") j += 2;
      else if (text[j] === quote) return { end: j + 1, closed: true };
      else j++;
    }
    return { end: Math.min(j, text.length), closed: false };
  }

  private template(i: number): Scan {
    const { text } = this;
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === "\\") j += 2;
      else if (text[j] === "`") return { end: j + 1, closed: true };
      else if (text[j] === "$" && text[j + 1] === "{")
        j = this.templateExpr(j + 2);
      else j++;
    }
    return { end: text.length, closed: false };
  }

  private templateExpr(from: number): number {
    const { text } = this;
    let depth = 1;
    let j = from;
    while (j < text.length) {
      const c = text[j];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return j + 1;
      if (c === '"' || c === "'") j = this.string(j, c).end;
      else if (c === "`") j = this.template(j).end;
      else j++;
    }
    return text.length;
  }

  private regexAllowed(): boolean {
    const prev = this.toks[this.toks.length - 1];
    if (!prev) return true;
    if (prev.k === "p") return !")]}".includes(prev.v);
    return prev.k === "id" && REGEX_AFTER.includes(prev.v);
  }

  /** A `/` that does not close on its line is plain division. */
  private regex(i: number): number {
    const { text } = this;
    let inClass = false;
    for (let j = i + 1; j < text.length && text[j] !== "\n"; j++) {
      const c = text[j];
      if (c === "\\") j++;
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        let end = j + 1;
        while (end < text.length && /[a-z]/.test(text[end])) end++;
        this.push(i, end, "str", true);
        return end;
      }
    }
    this.toks.push({ k: "p", s: i, e: i + 1, v: "/" });
    return i + 1;
  }
}

class Parser {
  private readonly lexer: Lexer;
  private readonly toks: Tok[];
  private readonly lineStarts: number[] = [0];
  private readonly ids: QmlId[] = [];
  private i = 0;
  private clean: boolean;

  constructor(private readonly text: string) {
    for (let j = 0; j < text.length; j++)
      if (text[j] === "\n") this.lineStarts.push(j + 1);
    this.lexer = new Lexer(text);
    this.toks = this.lexer.toks;
    this.clean = this.lexer.clean;
  }

  run(): QmlOutline {
    const imports = this.parseImports();
    const root = this.parseRoot();
    this.ids.sort((a, b) => a.range.start.offset - b.range.start.offset);
    return {
      imports,
      root,
      ids: this.ids,
      clean: this.clean,
      opaque: this.lexer.opaque,
    };
  }

  private pos(offset: number): Pos {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { offset, line: lo, col: offset - this.lineStarts[lo] };
  }

  private range(start: number, end: number): Range {
    return { start: this.pos(start), end: this.pos(end) };
  }

  private line(offset: number): number {
    return this.pos(offset).line;
  }

  private isP(t: Tok | undefined, v: string): boolean {
    return t !== undefined && t.k === "p" && t.v === v;
  }

  private isId(t: Tok | undefined, v: string): boolean {
    return t !== undefined && t.k === "id" && t.v === v;
  }

  private parseImports(): QmlImport[] {
    const imports: QmlImport[] = [];
    for (;;) {
      const t = this.toks[this.i];
      if (this.isId(t, "import")) {
        const imp = this.parseImport(t);
        if (imp) imports.push(imp);
      } else if (this.isId(t, "pragma")) {
        this.sameLine(t);
      } else {
        return imports;
      }
    }
  }

  /** Tokens after `first` on its line, consuming them. */
  private sameLine(first: Tok): Tok[] {
    const line = this.line(first.s);
    const out: Tok[] = [];
    this.i++;
    while (
      this.i < this.toks.length &&
      this.line(this.toks[this.i].s) === line &&
      !this.isP(this.toks[this.i], ";")
    ) {
      out.push(this.toks[this.i++]);
    }
    if (this.isP(this.toks[this.i], ";")) this.i++;
    return out;
  }

  private parseImport(first: Tok): QmlImport | undefined {
    const rest = this.sameLine(first);
    if (rest.length === 0) return undefined;
    const end = rest[rest.length - 1].e;
    const range = this.range(first.s, end);
    const as = rest.findIndex((t) => this.isId(t, "as"));
    const qualifier = as >= 0 ? rest[as + 1]?.v : undefined;
    const head = as >= 0 ? rest.slice(0, as) : rest;
    if (head[0]?.k === "str") {
      const path = head[0].v.replace(/^["'`]|["'`]$/g, "");
      return {
        kind: path.endsWith(".js") ? "js" : "dir",
        path,
        qualifier,
        range,
      };
    }
    let module = "";
    let k = 0;
    while (head[k]?.k === "id" || this.isP(head[k], ".")) module += head[k++].v;
    const version = head[k]?.k === "num" ? head[k].v : undefined;
    return { kind: "module", module, version, qualifier, range };
  }

  private parseRoot(): QmlObject | undefined {
    while (this.i < this.toks.length) {
      const h = this.headerAt(this.i);
      if (h) return this.parseObject(h, this.i, 0);
      this.i++;
    }
    return undefined;
  }

  private headerAt(idx: number): Header | null {
    const first = this.toks[idx];
    if (first?.k !== "id") return null;
    const [typeName, j] = this.dotted(idx);
    if (this.isP(this.toks[j], "{")) return { typeName, open: j };
    if (this.isId(this.toks[j], "on") && this.toks[j + 1]?.k === "id") {
      const [onProp, k] = this.dotted(j + 1);
      if (this.isP(this.toks[k], "{")) return { typeName, open: k, onProp };
    }
    return null;
  }

  /** `a.b.c` starting at idx, on one line; returns the text and the next token index. */
  private dotted(idx: number): [string, number] {
    let name = this.toks[idx].v;
    let j = idx + 1;
    while (
      this.isP(this.toks[j], ".") &&
      this.toks[j + 1]?.k === "id" &&
      this.line(this.toks[j + 1].s) === this.line(this.toks[j].s)
    ) {
      name += "." + this.toks[j + 1].v;
      j += 2;
    }
    return [name, j];
  }

  private parseObject(
    h: Header,
    startIdx: number,
    depth: number,
    assignedTo?: string,
  ): QmlObject {
    const start = this.toks[startIdx].s;
    const open = this.toks[h.open];
    const obj: QmlObject = {
      typeName: h.typeName,
      onProperty: h.onProp,
      assignedTo,
      range: this.range(start, open.e),
      body: this.range(open.e, open.e),
      members: [],
      children: [],
    };
    let bodyEnd = open.e;
    let end = open.e;
    this.i = h.open;
    if (depth >= MAX_DEPTH) {
      end = bodyEnd = this.skipBalanced();
    } else {
      this.i = h.open + 1;
      const closed = this.parseBody(obj, depth);
      if (closed) {
        bodyEnd = closed.s;
        end = closed.e;
      } else {
        this.clean = false;
        bodyEnd = end = this.text.length;
      }
    }
    obj.range = this.range(start, end);
    obj.body = this.range(open.e, bodyEnd);
    if (obj.id !== undefined)
      this.ids.push({ id: obj.id, typeName: obj.typeName, range: obj.range });
    return obj;
  }

  /** Returns the closing brace, or undefined when the file ends first. */
  private parseBody(obj: QmlObject, depth: number): Tok | undefined {
    for (;;) {
      const t = this.toks[this.i];
      if (!t) return undefined;
      if (this.isP(t, "}")) {
        this.i++;
        return t;
      }
      const before = this.i;
      if (this.isP(t, "{")) this.skipBalanced();
      else if (this.isP(t, ")") || this.isP(t, "]")) this.clean = false;
      else this.parseMember(obj, depth);
      if (this.i === before) this.i++;
    }
  }

  private parseMember(obj: QmlObject, depth: number): void {
    const t = this.toks[this.i];
    if (t.k !== "id") return;
    const modifiers = this.readModifiers();
    const kw = this.toks[this.i];
    const next = this.toks[this.i + 1];
    if (kw.v === "property" && next?.k === "id")
      return this.parseProperty(obj, t.s, modifiers, depth);
    if (kw.v === "signal" && next?.k === "id")
      return this.parseSignal(obj, t.s);
    if (kw.v === "function" && next?.k === "id")
      return this.parseFunction(obj, t.s);
    if (kw.v === "enum" && next?.k === "id") {
      this.i += 2;
      if (this.isP(this.toks[this.i], "{")) this.skipBalanced();
      return;
    }
    const h = this.headerAt(this.i);
    if (h) {
      obj.children.push(this.parseObject(h, this.i, depth + 1));
      return;
    }
    const [name, j] = this.dotted(this.i);
    if (this.isP(this.toks[j], ":")) this.parseBinding(obj, name, j, depth);
  }

  private readModifiers(): { readonly: boolean; isDefault: boolean } {
    const flags = { readonly: false, isDefault: false };
    for (;;) {
      const t = this.toks[this.i];
      const next = this.toks[this.i + 1];
      if (
        t?.k !== "id" ||
        next?.k !== "id" ||
        !["default", "readonly", "required"].includes(t.v)
      )
        return flags;
      if (t.v === "readonly") flags.readonly = true;
      if (t.v === "default") flags.isDefault = true;
      this.i++;
    }
  }

  private parseProperty(
    obj: QmlObject,
    start: number,
    flags: { readonly: boolean; isDefault: boolean },
    depth: number,
  ): void {
    this.i++;
    const kindTok = this.toks[this.i];
    const alias =
      this.isId(kindTok, "alias") && this.toks[this.i + 1]?.k === "id";
    let type: string | undefined;
    if (alias) {
      this.i++;
    } else {
      type = this.parseTypeRef();
    }
    const nameTok = this.toks[this.i];
    if (nameTok?.k !== "id") return;
    this.i++;
    const member: QmlMember = {
      kind: alias ? "alias" : "property",
      name: nameTok.v,
      type,
      ...(flags.readonly ? { readonly: true } : {}),
      ...(flags.isDefault ? { isDefault: true } : {}),
      range: this.range(start, nameTok.e),
    };
    obj.members.push(member);
    if (this.isP(this.toks[this.i], ":"))
      this.parseValue(obj, member, nameTok.v, start, depth);
  }

  private parseTypeRef(): string | undefined {
    const t = this.toks[this.i];
    if (t?.k !== "id") return undefined;
    let [type, j] = this.dotted(this.i);
    if (this.isP(this.toks[j], "<")) {
      let level = 0;
      for (; j < this.toks.length; j++) {
        const v = this.toks[j];
        if (this.isP(v, "<")) level++;
        if (this.isP(v, ">") && --level === 0) {
          j++;
          break;
        }
        if (this.isP(v, "{") || this.isP(v, "}")) break;
      }
      type = this.text.slice(t.s, this.toks[j - 1].e).replace(/\s+/g, "");
    }
    this.i = j;
    return type;
  }

  private parseSignal(obj: QmlObject, start: number): void {
    this.i++;
    const nameTok = this.toks[this.i++];
    const params = this.parseParams();
    obj.members.push({
      kind: "signal",
      name: nameTok.v,
      params,
      range: this.range(start, this.lastEnd(nameTok.e)),
    });
  }

  private parseFunction(obj: QmlObject, start: number): void {
    this.i++;
    const nameTok = this.toks[this.i++];
    const params = this.parseParams();
    let end = this.lastEnd(nameTok.e);
    while (
      this.i < this.toks.length &&
      !this.isP(this.toks[this.i], "{") &&
      !this.isP(this.toks[this.i], "}")
    ) {
      this.i++;
    }
    if (this.isP(this.toks[this.i], "{")) end = this.skipBalanced();
    obj.members.push({
      kind: "method",
      name: nameTok.v,
      params,
      range: this.range(start, end),
    });
  }

  private lastEnd(fallback: number): number {
    return this.i > 0 ? Math.max(fallback, this.toks[this.i - 1].e) : fallback;
  }

  /** Names of `(a, int b, list<int> c)`; the last identifier of each segment. */
  private parseParams(): string[] {
    const names: string[] = [];
    if (!this.isP(this.toks[this.i], "(")) return names;
    let depth = 0;
    let current: string | undefined;
    let skipping = false;
    for (; this.i < this.toks.length; this.i++) {
      const t = this.toks[this.i];
      if (this.isP(t, "(")) depth++;
      else if (this.isP(t, ")") && --depth === 0) {
        this.i++;
        break;
      } else if (this.isP(t, "{") || this.isP(t, "}")) break;
      else if (this.isP(t, ",") && depth === 1) {
        if (current !== undefined) names.push(current);
        current = undefined;
        skipping = false;
      } else if (this.isP(t, "=")) skipping = true;
      else if (t.k === "id" && depth === 1 && !skipping) current = t.v;
    }
    if (current !== undefined) names.push(current);
    return names;
  }

  private parseBinding(
    obj: QmlObject,
    name: string,
    colonIdx: number,
    depth: number,
  ): void {
    const start = this.toks[this.i].s;
    const nameEnd = this.toks[colonIdx - 1].e;
    const member: QmlMember = {
      kind: "binding",
      name,
      range: this.range(start, nameEnd),
    };
    obj.members.push(member);
    this.i = colonIdx;
    this.parseValue(obj, member, name, start, depth);
    const first = this.toks[colonIdx + 1];
    if (name === "id" && first?.k === "id" && first.s < member.range.end.offset)
      obj.id = first.v;
  }

  /** At the `:`. Fills the member's value range and adds nested objects as children. */
  private parseValue(
    obj: QmlObject,
    member: QmlMember,
    name: string,
    start: number,
    depth: number,
  ): void {
    const colon = this.toks[this.i++];
    member.valueStart = colon.e;
    const h = this.headerAt(this.i);
    let end = colon.e;
    if (h && isUpper(h.typeName)) {
      const child = this.parseObject(h, this.i, depth + 1, name);
      obj.children.push(child);
      end = child.range.end.offset;
    } else {
      end = this.skipExpression(obj, depth, colon.e, name);
    }
    member.range = this.range(start, end);
  }

  /** Consumes one binding value; returns its end offset. */
  private skipExpression(
    obj: QmlObject,
    depth: number,
    from: number,
    name: string,
  ): number {
    let end = from;
    let braces = 0;
    let parens = 0;
    for (; this.i < this.toks.length;) {
      const t = this.toks[this.i];
      const prev = this.toks[this.i - 1];
      const top = braces === 0 && parens === 0;
      if (top && this.isP(t, ";")) {
        this.i++;
        return end;
      }
      if (top && this.endsStatement(prev, t)) return end;
      if (this.isP(t, "}") && braces === 0) {
        if (parens > 0) this.clean = false;
        return end;
      }
      const h = braces === 0 ? this.headerAt(this.i) : null;
      if (h && isUpper(h.typeName)) {
        const child = this.parseObject(h, this.i, depth + 1, name);
        obj.children.push(child);
        end = child.range.end.offset;
        continue;
      }
      if (this.isP(t, "{")) braces++;
      else if (this.isP(t, "}")) braces--;
      else if (this.isP(t, "(") || this.isP(t, "[")) parens++;
      else if (this.isP(t, ")") || this.isP(t, "]")) {
        if (parens > 0) parens--;
        else this.clean = false;
      }
      end = t.e;
      this.i++;
    }
    if (braces > 0) this.clean = false;
    return end;
  }

  /** A new line that starts the next member, unless the expression visibly continues (a trailing `.` is a half-typed access). */
  private endsStatement(prev: Tok, t: Tok): boolean {
    if (this.line(t.s) <= this.line(prev.e - 1)) return false;
    if (prev.k === "p" && !").]}".includes(prev.v)) return false;
    return this.startsMember(this.i);
  }

  private startsMember(idx: number): boolean {
    const t = this.toks[idx];
    if (t?.k !== "id") return false;
    if (DECL_KEYWORDS.includes(t.v) && this.toks[idx + 1]?.k === "id")
      return true;
    if (this.headerAt(idx)) return true;
    return this.isP(this.toks[this.dotted(idx)[1]], ":");
  }

  /** At a `{`; consumes through its match and returns the end offset. */
  private skipBalanced(): number {
    let level = 0;
    let end = this.toks[this.i]?.s ?? this.text.length;
    while (this.i < this.toks.length) {
      const t = this.toks[this.i++];
      end = t.e;
      if (this.isP(t, "{")) level++;
      else if (this.isP(t, "}") && --level === 0) return end;
    }
    this.clean = false;
    return this.text.length;
  }
}
