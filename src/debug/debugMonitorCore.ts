export type DebugMonitorMode = 'cpp' | 'qml';
export const DEBUG_MONITOR_MIN_AGENT_VERSION = '1.13.2';
export const DEBUG_MONITOR_STATES = ['waiting', 'app-running', 'server-starting', 'server-listening', 'port-listening-unowned', 'missing-qml-argument', 'app-exited', 'server-exited'] as const;
export type DebugMonitorState = typeof DEBUG_MONITOR_STATES[number];
export type DebugMonitorEvent = { event: 'ready' } | {
  event: 'status'; mode: DebugMonitorMode; state: DebugMonitorState; pid: number; serverPid: number;
  qmlArgument: boolean; listening: boolean; port: number;
};

export function debugMonitorArgs(mode: DebugMonitorMode, binary: string, port: number): string[] {
  if (!/^\/usr\/bin\/[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(binary) || binary.includes('..')
    || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid debugger monitor target');
  return ['device', 'exec', '--', 'sailfish-devagent', '--request', 'debugmonitor', '--mode', mode, '--exe', binary, '--port', String(port)];
}

export function parseDebugMonitorEvent(line: string, mode: DebugMonitorMode, port: number): DebugMonitorEvent | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  if (r.ok === true && r.stream === 'debugmonitor' && r.event === 'ready') return { event: 'ready' };
  const pid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0x7fffffff;
  if (r.event !== 'status' || r.mode !== mode || r.port !== port
    || !DEBUG_MONITOR_STATES.some((state) => state === r.state) || !pid(r.pid) || !pid(r.serverPid)
    || typeof r.listening !== 'boolean' || typeof r.qmlArgument !== 'boolean') return undefined;
  if (r.state === 'server-listening' && (!r.listening || r.serverPid === 0 || (mode === 'qml' && !r.qmlArgument))) return undefined;
  return { event: 'status', mode, port, state: r.state as DebugMonitorState, pid: r.pid,
    serverPid: r.serverPid, qmlArgument: r.qmlArgument, listening: r.listening };
}

export function debugMonitorMessage(event: DebugMonitorEvent): string {
  if (event.event === 'ready') return 'Debugger Monitoring Agent connected';
  switch (event.state) {
    case 'waiting': return 'waiting for the application/debug server process…';
    case 'app-running': return `application PID ${event.pid} is running; waiting for its debug server…`;
    case 'server-starting': return `debug server PID ${event.serverPid} is starting…`;
    case 'server-listening': return `debug server PID ${event.serverPid} owns the listener on port ${event.port}`;
    case 'port-listening-unowned': return `port ${event.port} is listening, but the selected application does not own a verified listener`;
    case 'missing-qml-argument': return `application PID ${event.pid} is running without the requested QML debug argument`;
    case 'app-exited': return 'application process exited';
    case 'server-exited': return 'debug server process exited';
  }
}

export function qmlDebugStartupStallMessage(event: DebugMonitorEvent | undefined, port: number): string {
  if (event?.event === 'status' && event.state === 'port-listening-unowned') {
    return `port ${port} is listening, but the agent could not verify that the selected application owns it`;
  }
  if (event?.event === 'status' && event.state === 'app-running' && event.qmlArgument) {
    return `the application received its QML debug argument but did not open port ${port} within 60 seconds`;
  }
  return `Debugger Monitoring Agent reports no startup progress: ${event ? debugMonitorMessage(event) : 'waiting for the application process'}`;
}
