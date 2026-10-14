/** Values shared by the QML/JavaScript debug launcher and its tests. */

export const QML_DEBUG_DEFAULT_PORT = 3768;
export const QML_DEBUG_SERVICES = 'DebugMessages,QmlDebugger,V8Debugger,QmlInspector';
const QML_DEBUG_LAUNCH_SCRIPT =
  `port=$1; shift; exec "$@" "-qmljsdebugger=port:$port,host:127.0.0.1,block,services:${QML_DEBUG_SERVICES}"`;

/** Qt receives this as one argv item; it binds only the device loopback interface. */
export function qmlDebuggerArgument(port: number): string {
  return `-qmljsdebugger=port:${port},host:127.0.0.1,block,services:${QML_DEBUG_SERVICES}`;
}

/** A settings value is still untrusted at runtime, even though the schema constrains it. */
export function qmlDebugPort(value: number): number {
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : QML_DEBUG_DEFAULT_PORT;
}

/** qt-qml 1.16 advertises number|string but its adapter parses only the string form. */
export function qmlDebugAdapterPort(port: number): string {
  return String(port);
}

/**
 * SFDK 3.13.5 drops a single-dash application argument from `device exec` while constructing its
 * SSH command. Pass only the plain port through SFDK and construct that fixed argument remotely;
 * the launch command itself remains positional and is executed without evaluation by the shell.
 */
export function qmlDebugLaunchArgs(launchArgs: readonly string[], port: number, nativeBinary?: string): string[] {
  const separator = launchArgs.indexOf('--');
  if (separator === -1 || launchArgs[0] !== 'device' || launchArgs[1] !== 'exec') {
    throw new Error('QML debugging requires a device exec launch command');
  }
  const configuredLauncher = launchArgs.slice(separator + 1);
  // Sailfish OS 4.4+ makes invoker enforce Sailjail's desktop Exec template. Appending the Qt
  // debugger option no longer matches that template and invoker exits 1 before Qt starts. Native
  // debugger launches already require Developer Mode, so run the installed PIE directly just as
  // gdbserver does; ordinary Run continues to use the configured, sandboxed launcher unchanged.
  const launcher = nativeBinary && configuredLauncher[0]?.split('/').pop() === 'invoker'
    ? [nativeBinary]
    : configuredLauncher;
  return [
    ...launchArgs.slice(0, separator + 1),
    'sh',
    '-c',
    QML_DEBUG_LAUNCH_SCRIPT,
    'sh',
    String(port),
    ...launcher,
  ];
}

/** Feature-detect the adapter rather than coupling to a qt-qml release number. */
export function hasQmlDebugAdapter(packageJson: unknown): boolean {
  if (typeof packageJson !== 'object' || packageJson === null) return false;
  const contributes = (packageJson as { contributes?: unknown }).contributes;
  if (typeof contributes !== 'object' || contributes === null) return false;
  const debuggers = (contributes as { debuggers?: unknown }).debuggers;
  return Array.isArray(debuggers) && debuggers.some((entry) => typeof entry === 'object' && entry !== null && (entry as { type?: unknown }).type === 'qml');
}
