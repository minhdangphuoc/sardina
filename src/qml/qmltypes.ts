import { type ModuleRef, parseVersion } from './types';

export interface CppParam {
  name: string;
  type: string;
}
export interface CppProperty {
  name: string;
  type: string;
  isReadonly: boolean;
  isPointer: boolean;
  isList: boolean;
}
export interface CppCallable {
  name: string;
  params: CppParam[];
}
export interface CppEnum {
  name: string;
  values: string[];
}
export interface CppExport {
  module: string;
  name: string;
  major: number;
  minor: number;
}
export interface CppComponent {
  name: string;
  prototype?: string;
  exports: CppExport[];
  defaultProperty?: string;
  attachedType?: string;
  isSingleton: boolean;
  isCreatable: boolean;
  properties: CppProperty[];
  signals: CppCallable[];
  methods: CppCallable[];
  enums: CppEnum[];
}
export interface CppModule {
  dependencies: ModuleRef[];
  components: CppComponent[];
}

type Value = string | string[];
interface Block {
  type: string;
  props: Map<string, Value>;
  children: Block[];
}

type Token = { kind: 'punct' | 'string' | 'word'; text: string };

const MAX_DEPTH = 12;
const PUNCT = '{}[]:;,';

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        s += text[j] ?? '';
        j++;
      }
      tokens.push({ kind: 'string', text: s });
      i = j + 1;
    } else if (PUNCT.includes(c)) {
      tokens.push({ kind: 'punct', text: c });
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let j = i;
      while (j < text.length && !PUNCT.includes(text[j]) && !/\s/.test(text[j]) && text[j] !== '"') j++;
      tokens.push({ kind: 'word', text: text.slice(i, Math.max(j, i + 1)) });
      i = Math.max(j, i + 1);
    }
  }
  return tokens;
}

class BlockParser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parseTop(): Block {
    const top: Block = { type: '', props: new Map(), children: [] };
    this.parseBody(top, 0);
    return top;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private isPunct(token: Token | undefined, ch: string): boolean {
    return token?.kind === 'punct' && token.text === ch;
  }

  /** Reads members until the closing brace (or the end of input); unknown tokens are skipped. */
  private parseBody(block: Block, depth: number): void {
    for (let t = this.peek(); t; t = this.peek()) {
      if (this.isPunct(t, '}')) {
        this.pos++;
        if (depth > 0) return;
      } else if (t.kind === 'word' && this.isPunct(this.peek(1), '{')) {
        this.pos += 2;
        this.parseChild(block, t.text, depth);
      } else if ((t.kind === 'word' || t.kind === 'string') && this.isPunct(this.peek(1), ':')) {
        this.pos += 2;
        block.props.set(t.text, this.parseValue());
      } else {
        this.pos++;
      }
    }
  }

  private parseChild(parent: Block, type: string, depth: number): void {
    if (depth >= MAX_DEPTH) {
      this.skipBlock();
      return;
    }
    const child: Block = { type, props: new Map(), children: [] };
    parent.children.push(child);
    this.parseBody(child, depth + 1);
  }

  private skipBlock(): void {
    for (let open = 1; open > 0 && this.peek(); this.pos++) {
      if (this.isPunct(this.peek(), '{')) open++;
      else if (this.isPunct(this.peek(), '}')) open--;
    }
  }

  private parseValue(): Value {
    const t = this.peek();
    if (!t) return '';
    if (this.isPunct(t, '[')) return this.parseList(']', false);
    if (this.isPunct(t, '{')) return this.parseList('}', true);
    if (t.kind === 'punct') return '';
    this.pos++;
    return t.text;
  }

  /** A list of scalars, or (keysOnly) the keys of a `"name": value` map. */
  private parseList(close: string, keysOnly: boolean): string[] {
    this.pos++;
    const items: string[] = [];
    for (let t = this.peek(); t && !this.isPunct(t, close); t = this.peek()) {
      this.pos++;
      if (t.kind === 'punct') continue;
      const isKey = this.isPunct(this.peek(), ':');
      if (keysOnly && isKey) items.push(t.text);
      else if (!keysOnly) items.push(t.text);
      if (isKey) this.pos++;
    }
    this.pos++;
    return items;
  }
}

function str(block: Block, key: string): string | undefined {
  const v = block.props.get(key);
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function list(block: Block, key: string): string[] {
  const v = block.props.get(key);
  return Array.isArray(v) ? v : [];
}

function flag(block: Block, key: string, fallback: boolean): boolean {
  const v = str(block, key);
  return v === undefined ? fallback : v === 'true';
}

function callable(block: Block): CppCallable {
  const params = block.children
    .filter((c) => c.type === 'Parameter')
    .map((c) => ({ name: str(c, 'name') ?? '', type: str(c, 'type') ?? '' }));
  return { name: str(block, 'name') ?? '', params };
}

/** `"QtQuick/Item 2.1"` -> module QtQuick, name Item, version 2.1. */
function parseExport(text: string): CppExport | undefined {
  const m = /^(?:(.+)\/)?(\S+)\s+(\S+)$/.exec(text.trim());
  if (!m) return undefined;
  return { module: m[1] ?? '', name: m[2], ...parseVersion(m[3]) };
}

function component(block: Block): CppComponent {
  const exports = list(block, 'exports')
    .map(parseExport)
    .filter((e): e is CppExport => e !== undefined);
  const of = (type: string): Block[] => block.children.filter((c) => c.type === type);
  return {
    name: str(block, 'name') ?? '',
    prototype: str(block, 'prototype'),
    exports,
    defaultProperty: str(block, 'defaultProperty'),
    attachedType: str(block, 'attachedType'),
    isSingleton: flag(block, 'isSingleton', false),
    isCreatable: flag(block, 'isCreatable', true),
    properties: of('Property').map((p) => ({
      name: str(p, 'name') ?? '',
      type: str(p, 'type') ?? '',
      isReadonly: flag(p, 'isReadonly', false),
      isPointer: flag(p, 'isPointer', false),
      isList: flag(p, 'isList', false),
    })),
    signals: of('Signal').map(callable),
    methods: of('Method').map(callable),
    enums: of('Enum').map((e) => ({ name: str(e, 'name') ?? '', values: list(e, 'values') })),
  };
}

function moduleRef(text: string): ModuleRef | undefined {
  const [module, version] = text.trim().split(/\s+/);
  return module ? { module, ...parseVersion(version) } : undefined;
}

/** Parses a plugin type description (`*.qmltypes`). Never throws; unknown keys are ignored. */
export function parseQmltypes(text: string): CppModule {
  const result: CppModule = { dependencies: [], components: [] };
  try {
    const top = new BlockParser(tokenize(text)).parseTop();
    for (const mod of top.children.filter((c) => c.type === 'Module')) {
      result.dependencies.push(...list(mod, 'dependencies').map(moduleRef).filter((r): r is ModuleRef => !!r));
      result.components.push(...mod.children.filter((c) => c.type === 'Component').map(component));
    }
  } catch {
    // A malformed file yields whatever was collected before the failure.
  }
  return result;
}
