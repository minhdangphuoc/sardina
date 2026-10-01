/** Single-quotes a value for a POSIX shell, escaping embedded single quotes the standard way. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
