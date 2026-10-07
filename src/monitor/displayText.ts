/**
 * Text hygiene shared by the host and the Device Monitor page: ANSI stripping (host side),
 * control-character glyphs (page side) and field sanitising for page messages. Pure; no DOM.
 */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Removes ANSI escape sequences (CSI and OSC) such as colour codes. */
export function stripAnsi(s: string): string {
  return s.indexOf('\u001b') === -1 ? s : s.replace(ANSI, '');
}

/**
 * Makes control characters visible instead of letting them act: C0 controls become the Unicode
 * "control pictures" (U+2400 + code, `␀` for NUL), DEL becomes `␡`, C1 controls and line/paragraph
 * separators become `�`. Tabs become four spaces; `\n` and `\r` are kept when `keepNewlines`.
 */
export function controlGlyphs(s: string, keepNewlines = false): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code === 9) return '    ';
    if (keepNewlines && (code === 10 || code === 13)) return c;
    if (code < 0x20) return String.fromCharCode(0x2400 + code);
    if (code === 0x7f) return '␡';
    return '�';
  });
}

export const FIELD_MAX = 512;

/** Control characters removed and the length capped; used for every string a page message carries. */
export function sanitizeField(s: string, max: number = FIELD_MAX): string {
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
  return clean.length > max ? clean.slice(0, max) : clean;
}
