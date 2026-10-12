/** Values shared by the QML/JavaScript debug launcher and its tests. */

export const QML_DEBUG_DEFAULT_PORT = 3768;
export const QML_DEBUG_SERVICES = 'DebugMessages,QmlDebugger,V8Debugger,QmlInspector';

/** Qt receives this as one argv item; it binds only the device loopback interface. */
export function qmlDebuggerArgument(port: number): string {
  return `-qmljsdebugger=host:127.0.0.1,port:${port},block,services:${QML_DEBUG_SERVICES}`;
}

/** A settings value is still untrusted at runtime, even though the schema constrains it. */
export function qmlDebugPort(value: number): number {
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : QML_DEBUG_DEFAULT_PORT;
}

/** Feature-detect the adapter rather than coupling to a qt-qml release number. */
export function hasQmlDebugAdapter(packageJson: unknown): boolean {
  if (typeof packageJson !== 'object' || packageJson === null) return false;
  const contributes = (packageJson as { contributes?: unknown }).contributes;
  if (typeof contributes !== 'object' || contributes === null) return false;
  const debuggers = (contributes as { debuggers?: unknown }).debuggers;
  return Array.isArray(debuggers) && debuggers.some((entry) => typeof entry === 'object' && entry !== null && (entry as { type?: unknown }).type === 'qml');
}
