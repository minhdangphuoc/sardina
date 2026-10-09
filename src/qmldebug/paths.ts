/**
 * Output of `grep -c -a QQmlDebuggingEnabler <binary>`: the match count. A binary built with
 * QT_QML_DEBUG references the enabler's (undefined, dynamic) symbol, so one match is enough.
 */
export function hasQmlDebugEnabler(stdout: string): boolean {
  const count = /^\s*(\d+)\s*$/.exec(stdout);
  return count !== null && Number(count[1]) > 0;
}
