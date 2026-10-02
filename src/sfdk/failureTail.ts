/** How much of a failed command's output is always logged (the full output stays at debug level). */
const FAILURE_TAIL_LINES = 15;

/** The last non-empty lines of a failed command's output, for the always-visible log. */
export function failureTail(text: string | undefined): string | undefined {
  const lines = (text ?? '').split(/\r?\n/).filter((l) => l.trim());
  return lines.length ? lines.slice(-FAILURE_TAIL_LINES).join('\n') : undefined;
}
