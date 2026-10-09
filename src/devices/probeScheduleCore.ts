/** Every probe makes the phone's sshd fork and can wake it, so probe rarely and only while someone looks. */
export const REACHABILITY_POLL_MS = 60_000;
/** A window left unfocused this long stops probing until it is focused again. */
export const UNFOCUSED_LIMIT_MS = 5 * 60_000;

export interface ProbeGate {
  viewVisible: boolean;
  /** When the window lost focus; undefined while focused. */
  unfocusedSince: number | undefined;
  now: number;
}

export function shouldProbe({ viewVisible, unfocusedSince, now }: ProbeGate): boolean {
  if (!viewVisible) return false;
  return unfocusedSince === undefined || now - unfocusedSince <= UNFOCUSED_LIMIT_MS;
}

export interface ProbeCandidate {
  key: string;
  hasSession: boolean;
}

/** Endpoints to probe: a device with a live session is known to be online. */
export function splitBySession(candidates: ProbeCandidate[]): { probe: string[]; online: string[] } {
  const online = new Set(candidates.filter((c) => c.hasSession).map((c) => c.key));
  const probe = new Set(candidates.map((c) => c.key).filter((k) => !online.has(k)));
  return { probe: [...probe], online: [...online] };
}
