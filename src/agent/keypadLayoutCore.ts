export const KEYPAD_KEYS = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#',
  'OK', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'MENU', 'BACK', 'CALL', 'F21', 'F22', 'F23',
] as const;

export type KeypadKey = (typeof KEYPAD_KEYS)[number];
export type KeypadStyle = 'primary' | 'call';

export interface KeypadInfo {
  model: string;
  keys: KeypadKey[];
}

export interface KeypadCell {
  key: KeypadKey;
  label: string;
  style?: KeypadStyle;
}

export interface KeypadLayout {
  model: string;
  rows: Array<Array<KeypadCell | null>>;
}

export interface ParsedKeypadLayout {
  value?: unknown;
  error?: string;
}

export interface KeypadLayoutValidation {
  layout?: KeypadLayout;
  errors: string[];
  warnings: string[];
}

const keySet = new Set<string>(KEYPAD_KEYS);
const styles = new Set<string>(['primary', 'call']);

export function isKeypadKey(value: unknown): value is KeypadKey {
  return typeof value === 'string' && keySet.has(value);
}

export function parseKeypadInfo(value: unknown): KeypadInfo | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.model !== 'string' || raw.model.trim().length < 1 || raw.model.length > 128 || !Array.isArray(raw.keys)) return undefined;
  const keys: KeypadKey[] = [];
  for (const key of raw.keys) {
    if (!isKeypadKey(key) || keys.includes(key)) return undefined;
    keys.push(key);
  }
  return keys.length > 0 ? { model: raw.model.trim(), keys } : undefined;
}

export function parseKeypadLayout(text: string): ParsedKeypadLayout {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (err) {
    return { error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function cellAt(value: unknown, available: ReadonlySet<KeypadKey>, at: string, warnings: string[], errors: string[]): KeypadCell | null {
  if (value === null) return null;
  let key: unknown;
  let label: unknown;
  let style: unknown;
  if (typeof value === 'string') {
    key = value;
    label = value;
  } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (!exactKeys(raw, ['key', 'label', 'style'])) {
      errors.push(`${at}: unknown cell field`);
      return null;
    }
    key = raw.key;
    label = raw.label ?? raw.key;
    style = raw.style;
  } else {
    errors.push(`${at}: expected null, a key name, or a key cell`);
    return null;
  }
  if (!isKeypadKey(key)) {
    warnings.push(`${at}: unknown key ${JSON.stringify(key)} was dropped`);
    return null;
  }
  if (!available.has(key)) {
    warnings.push(`${at}: ${key} is not exposed by this device and was dropped`);
    return null;
  }
  if (typeof label !== 'string' || label.length < 1 || label.length > 16 || /[\u0000-\u001f\u007f]/.test(label)) {
    errors.push(`${at}: label must be 1–16 printable characters`);
    return null;
  }
  if (style !== undefined && (typeof style !== 'string' || !styles.has(style))) {
    errors.push(`${at}: style must be "primary" or "call"`);
    return null;
  }
  return { key, label, ...(style === undefined ? {} : { style: style as KeypadStyle }) };
}

export function validateKeypadLayout(value: unknown, deviceKeys: readonly KeypadKey[], expectedModel?: string): KeypadLayoutValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { errors: ['Layout must be a JSON object'], warnings };
  }
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, ['model', 'rows'])) errors.push('Layout has unknown top-level fields');
  if (typeof raw.model !== 'string' || raw.model.trim().length < 1 || raw.model.length > 128) {
    errors.push('model must be a non-empty string of at most 128 characters');
  } else if (expectedModel !== undefined && raw.model.trim() !== expectedModel) {
    errors.push(`model must be ${JSON.stringify(expectedModel)}`);
  }
  if (!Array.isArray(raw.rows) || raw.rows.length < 1 || raw.rows.length > 20) {
    errors.push('rows must contain 1–20 rows');
  }
  if (!Array.isArray(raw.rows) || typeof raw.model !== 'string') return { errors, warnings };

  const available = new Set(deviceKeys);
  const rows: Array<Array<KeypadCell | null>> = [];
  raw.rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 20) {
      errors.push(`rows[${rowIndex}] must contain 1–20 cells`);
      return;
    }
    const cells = row.map((cell, cellIndex) => cellAt(cell, available, `rows[${rowIndex}][${cellIndex}]`, warnings, errors));
    if (cells.some((cell) => cell !== null)) rows.push(cells);
  });
  if (rows.length === 0) errors.push('Layout has no keys exposed by this device');
  return errors.length > 0 ? { errors, warnings } : { layout: { model: raw.model.trim(), rows }, errors, warnings };
}

function cell(key: KeypadKey, available: ReadonlySet<KeypadKey>, label: string = key, style?: KeypadStyle): KeypadCell | null {
  return available.has(key) ? { key, label, ...(style === undefined ? {} : { style }) } : null;
}

export function buildDefaultKeypadLayout(info: KeypadInfo): KeypadLayout {
  const available = new Set(info.keys);
  const candidates: Array<Array<KeypadCell | null>> = [
    [cell('MENU', available), cell('UP', available, '▲'), cell('BACK', available)],
    [cell('LEFT', available, '◀'), cell('OK', available, 'OK', 'primary'), cell('RIGHT', available, '▶')],
    [cell('CALL', available, 'CALL', 'call'), cell('DOWN', available, '▼'), null],
    [cell('1', available), cell('2', available), cell('3', available)],
    [cell('4', available), cell('5', available), cell('6', available)],
    [cell('7', available), cell('8', available), cell('9', available)],
    [cell('*', available), cell('0', available), cell('#', available)],
    [cell('F21', available), cell('F22', available), cell('F23', available)],
  ];
  return { model: info.model, rows: candidates.filter((row) => row.some((entry) => entry !== null)) };
}

export function keypadLayoutFileName(model: string): string {
  const slug = model.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug.slice(0, 64) || 'keypad'}.json`;
}

export interface ResolvedKeypadLayout {
  configured: boolean;
  /** The remembered file is gone or unreadable; it stays remembered so a restored file is picked up. */
  missing?: boolean;
  layout?: KeypadLayout;
}

export type KeypadHint = 'create' | 'missing';

/** The strip hint for a model; undefined until the layout was resolved, and once the user dismissed it. */
export function keypadHint(resolved: ResolvedKeypadLayout | undefined, dismissed: boolean): KeypadHint | undefined {
  if (!resolved || dismissed) return undefined;
  if (!resolved.configured) return 'create';
  return resolved.missing ? 'missing' : undefined;
}

/** Reports each distinct error once; a clean result re-arms it, so the same mistake made again is reported again. */
export class ErrorReporter {
  private last: string | undefined;

  shouldReport(error: string | undefined): boolean {
    if (error === undefined) {
      this.last = undefined;
      return false;
    }
    if (error === this.last) return false;
    this.last = error;
    return true;
  }
}

/** One shared resource per key, released when its last owner lets go. */
export class SharedResources {
  private readonly byKey = new Map<string, { owners: Set<string>; release: () => void }>();
  private readonly keyOf = new Map<string, string>();

  acquire(owner: string, key: string, create: () => () => void): void {
    if (this.keyOf.get(owner) === key) return;
    this.release(owner);
    let entry = this.byKey.get(key);
    if (!entry) {
      entry = { owners: new Set(), release: create() };
      this.byKey.set(key, entry);
    }
    entry.owners.add(owner);
    this.keyOf.set(owner, key);
  }

  release(owner: string): void {
    const key = this.keyOf.get(owner);
    if (key === undefined) return;
    this.keyOf.delete(owner);
    const entry = this.byKey.get(key);
    if (!entry) return;
    entry.owners.delete(owner);
    if (entry.owners.size > 0) return;
    entry.release();
    this.byKey.delete(key);
  }

  owners(key: string): string[] {
    return [...(this.byKey.get(key)?.owners ?? [])];
  }

  dispose(): void {
    for (const entry of this.byKey.values()) entry.release();
    this.byKey.clear();
    this.keyOf.clear();
  }
}
