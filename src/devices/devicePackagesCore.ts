/** Pure parts of devicePackages.ts (no `vscode` import, unit-testable under plain mocha). */

/** What the SDK needs on a device: rsync (every deploy method copies with it), sdk-deploy-rpm (--sdk installs) and gdbserver (debugging). */
export const DEVICE_TOOL_PACKAGES = ['rsync', 'sdk-deploy-rpm', 'gdb-gdbserver'] as const;

/** Each tool the SDK needs, the command that proves it is present, and the package that provides it. */
const TOOL_CHECKS = [
  { command: 'rsync', pkg: 'rsync' },
  { command: 'sdk-deploy-rpm', pkg: 'sdk-deploy-rpm' },
  { command: 'gdbserver', pkg: 'gdb-gdbserver' },
] as const;

const CHECK_MARK = 'sfdev-tool';

/** Read-only (no root) script for `device exec -- sh -c`: reports `sfdev-tool:<command>:ok|missing` for each tool. Fixed text. */
export const CHECK_TOOLS_SCRIPT = `for c in ${TOOL_CHECKS.map((t) => t.command).join(' ')}; do if command -v "$c" >/dev/null 2>&1; then echo "${CHECK_MARK}:$c:ok"; else echo "${CHECK_MARK}:$c:missing"; fi; done`;

/**
 * Parses CHECK_TOOLS_SCRIPT's output into the packages that are missing, in DEVICE_TOOL_PACKAGES order.
 * Undefined ("could not check") unless every tool was reported exactly as ok or missing. Package names
 * come from the constants above, never from the output.
 */
export function parseToolCheck(output: string): string[] | undefined {
  const seen = new Map<string, boolean>();
  for (const line of output.split(/\r?\n/)) {
    const m = new RegExp(`^${CHECK_MARK}:([^:]+):(ok|missing)\\s*$`).exec(line);
    if (m) seen.set(m[1], m[2] === 'ok');
  }
  const missing: string[] = [];
  for (const t of TOOL_CHECKS) {
    const present = seen.get(t.command);
    if (present === undefined) return undefined;
    if (!present) missing.push(t.pkg);
  }
  return missing;
}

/** What to install: the missing packages, or all of them when the check could not tell. */
export function packagesToInstall(missing: readonly string[] | undefined): readonly string[] {
  return missing ?? DEVICE_TOOL_PACKAGES;
}

/** A step and optional percent read from a line of `pkcon` output; undefined when the line says neither. */
export function parseInstallProgress(line: string): { step: string; percent?: number } | undefined {
  const stepMatch = /(refresh|download|install|resolv|dependenc|updat|query|wait|finish)/i.exec(line);
  const pct = /(\d{1,3})\s*%/.exec(line);
  const percent = pct && Number(pct[1]) <= 100 ? Number(pct[1]) : undefined;
  if (!stepMatch && percent === undefined) return undefined;
  const word = stepMatch?.[1].toLowerCase();
  const step =
    word === undefined ? '' : word.startsWith('refresh') ? 'refreshing' : word.startsWith('download') ? 'downloading' : word.startsWith('install') ? 'installing' : word;
  return percent === undefined ? { step } : { step, percent };
}

/** One root shell: refresh the package lists, then install. Package names are fixed constants, never user input. */
export function installScript(packages: readonly string[]): string {
  return `pkcon refresh && pkcon install -y ${packages.join(' ')}`;
}

/** What to tell the user after the install finishes. */
export function installOutcomeMessage(device: string, packages: readonly string[], exitCode: number | undefined): { ok: boolean; message: string } {
  if (exitCode === 0) {
    return { ok: true, message: `Sailfish: installed ${packages.join(', ')} on "${device}".` };
  }
  return {
    ok: false,
    message:
      `Sailfish: installing ${packages.join(', ')} on "${device}" failed${exitCode === undefined ? '' : ` (exit ${exitCode})`}. ` +
      'Check that the device has internet access (Wi-Fi or mobile data), that you typed the developer-mode password, ' +
      "and the Sailfish OS output channel for which package was not found.",
  };
}


/** How long the read-only tool check may take; a reachable device answers in a few seconds. */
export const TOOL_CHECK_TIMEOUT_MS = 20_000;

/**
 * What the read-only tool check found. `unreachable` and `failed` mean the check could not run
 * (nothing is known about the device, so nothing must be installed); `unparseable` means it ran
 * but its output was not understood (the only case where installing everything is still right).
 */
export type ToolCheckOutcome =
  | { kind: 'checked'; missing: string[] }
  | { kind: 'unparseable' }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'cancelled' };

/** The fields of an sfdk run the classification needs (a subset of SfdkResult). */
export interface ToolCheckRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

/** ssh/sfdk wording for "could not reach the device" or "the connection dropped". */
const CONNECTION_FAILURE_RE =
  /unable to connect|connection (?:timed out|refused|closed|reset)|no route to host|network is unreachable|host is (?:down|unreachable)|could not resolve|name or service not known|operation timed out|timeout, server|not responding|broken pipe|kex_exchange_identification|ssh_exchange_identification|client_loop:/i;
/** Reached the device but was not let in: not "offline", and saying so would mislead. */
const AUTH_FAILURE_RE = /permission denied|authentication fail|host key verification failed/i;
/** ssh's exit status for a connection-level error. */
const SSH_ERROR_EXIT = 255;

/**
 * Lines only the local ssh client (or sfdk) prints when the session to the device dies (not the
 * "Connection to <host> closed." every normal `-tt` session ends with). Anchored
 * at the line start, so a remote program's own network errors (pkcon failing a download with
 * "Connection reset by peer") do not count.
 */
const SESSION_DROP_RE =
  /^(?:Connection to \S+ closed by remote host|client_loop: |Timeout, server \S+ not responding|packet_write_wait: |ssh: connect to host |sfdk: unable to connect)/i;

/** True when a line of local sfdk/ssh output says the session to the device failed or dropped. */
export function isSessionDrop(line: string): boolean {
  return SESSION_DROP_RE.test(line.trim());
}

/** The last non-empty lines of a failed run, for messages and the log. */
function detailOf(run: ToolCheckRun): string {
  const text = `${run.stderr}\n${run.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return text.slice(-3).join(' ') || `exit ${run.exitCode}`;
}

/** Sorts a finished tool-check run into ToolCheckOutcome (see there). */
export function classifyToolCheck(run: ToolCheckRun): ToolCheckOutcome {
  if (run.cancelled) return { kind: 'cancelled' };
  const missing = parseToolCheck(run.stdout);
  if (missing !== undefined) return { kind: 'checked', missing };
  if (run.timedOut) return { kind: 'unreachable', detail: `no answer within ${Math.round(TOOL_CHECK_TIMEOUT_MS / 1000)} s` };
  if (run.exitCode === 0) return { kind: 'unparseable' };
  const both = `${run.stderr}\n${run.stdout}`;
  if (AUTH_FAILURE_RE.test(both)) return { kind: 'failed', detail: detailOf(run) };
  if (run.exitCode === SSH_ERROR_EXIT || CONNECTION_FAILURE_RE.test(both)) return { kind: 'unreachable', detail: detailOf(run) };
  return { kind: 'failed', detail: detailOf(run) };
}

/**
 * What "Install Deploy & Debug Tools" does after the check: install what is missing, install all
 * only when a check that ran printed something unparseable, and never install when the check could
 * not run. A `stop` with a message is an error to show; without one the user was already told
 * (offline prompt) or cancelled.
 */
export type InstallPlan =
  | { action: 'install'; packages: readonly string[] }
  | { action: 'none' }
  | { action: 'stop'; message?: string };

export function installPlan(outcome: ToolCheckOutcome): InstallPlan {
  switch (outcome.kind) {
    case 'checked':
      return outcome.missing.length === 0 ? { action: 'none' } : { action: 'install', packages: outcome.missing };
    case 'unparseable':
      return { action: 'install', packages: packagesToInstall(undefined) };
    case 'failed':
      return { action: 'stop', message: outcome.detail };
    case 'unreachable':
    case 'cancelled':
      return { action: 'stop' };
  }
}

/** The error for a tool check that reached sfdk but did not run (login refused, sfdk error). */
export function toolCheckFailureMessage(device: string, detail: string): string {
  return `Sailfish: could not check the tools on "${device}": ${detail}. Nothing was installed; see the Sailfish OS output channel.`;
}

/** The message for a device whose SSH port does not answer; for an emulator, that it is not running. */
export function offlineMessage(device: string, emulator = false): string {
  return emulator
    ? `Sailfish: the emulator "${device}" is not running — start it (Devices view) and try again.`
    : `Sailfish: "${device}" is offline — connect it (USB or Wi-Fi, Developer Mode on) and try again.`;
}

export const OPEN_DEVICES_VIEW = 'Open Devices view';
export const RETRY = 'Retry';

/** Limits for a root shell on the device (runAsRootOnDevice). */
export interface RootShellLimits {
  /** From the spawn until `devel-su` asks for the password: covers connecting to the device. */
  promptMs: number;
  /** After the password: longest silence before the device counts as no longer responding. */
  stallMs: number;
  /** The whole run. */
  overallMs: number;
}

export const DEFAULT_ROOT_SHELL_LIMITS: RootShellLimits = {
  promptMs: 30_000,
  // pkcon prints its progress bar several times a second while it works; minutes of silence mean the link is gone.
  stallMs: 3 * 60_000,
  overallMs: 10 * 60_000,
};

export type RootShellPhase = 'connecting' | 'password' | 'running';
export type RootShellAbort = 'no-prompt' | 'stalled' | 'timeout' | 'dropped' | 'password-rejected';

/**
 * Watches a root shell: which phase it is in, and whether it must be stopped. Pure (the caller
 * passes the clock), so the timing rules are unit-testable.
 */
export class RootShellWatch {
  private phaseValue: RootShellPhase = 'connecting';
  private lastOutput: number;
  private prompts = 0;
  private abortValue: RootShellAbort | undefined;

  constructor(
    private readonly limits: RootShellLimits,
    private readonly start: number,
  ) {
    this.lastOutput = start;
  }

  get phase(): RootShellPhase {
    return this.phaseValue;
  }

  get aborted(): RootShellAbort | undefined {
    return this.abortValue;
  }

  /**
   * Feed one cleaned line (or partial line) of output. Returns 'send-password' the first time
   * devel-su prompts; a second prompt means the password was not accepted.
   */
  onOutput(text: string, now: number): 'send-password' | undefined {
    this.lastOutput = now;
    if (/password:/i.test(text)) {
      this.prompts += 1;
      if (this.prompts === 1) {
        this.phaseValue = 'password';
        return 'send-password';
      }
      this.abortValue ??= 'password-rejected';
      return undefined;
    }
    if (isSessionDrop(text)) {
      this.abortValue ??= 'dropped';
      return undefined;
    }
    if (this.phaseValue === 'password' && text.trim()) this.phaseValue = 'running';
    return undefined;
  }

  /** Called periodically: sets and returns the reason to stop, if any. */
  check(now: number): RootShellAbort | undefined {
    if (this.abortValue) return this.abortValue;
    if (now - this.start >= this.limits.overallMs) this.abortValue = 'timeout';
    else if (this.phaseValue === 'connecting' && now - this.start >= this.limits.promptMs) this.abortValue = 'no-prompt';
    else if (this.phaseValue !== 'connecting' && now - this.lastOutput >= this.limits.stallMs) this.abortValue = 'stalled';
    return this.abortValue;
  }
}

/** What to tell the user when the watch stopped a root shell. */
export function rootShellAbortMessage(device: string, reason: RootShellAbort, limits: RootShellLimits): string {
  const s = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`);
  switch (reason) {
    case 'no-prompt':
      return `Sailfish: "${device}" did not answer within ${s(limits.promptMs)} — it may be offline or asleep. Connect it (USB or Wi-Fi, Developer Mode on) and try again.`;
    case 'dropped':
      return `Sailfish: the connection to "${device}" dropped — the device stopped responding. Check the USB cable or Wi-Fi and try again.`;
    case 'stalled':
      return `Sailfish: "${device}" stopped responding (no output for ${s(limits.stallMs)}). Check the connection and try again; see the Sailfish OS output for the last lines.`;
    case 'timeout':
      return `Sailfish: the command on "${device}" did not finish within ${s(limits.overallMs)} and was stopped. See the Sailfish OS output for the last lines.`;
    case 'password-rejected':
      return `Sailfish: "${device}" did not accept the password. Use the developer-mode password (Settings → Developer tools) and try again.`;
  }
}

/** The progress notification's message for a phase; `step` is the latest parseInstallProgress result. */
export function rootShellProgressMessage(device: string, phase: RootShellPhase, working: string, step?: { step: string; percent?: number }): string {
  if (phase === 'connecting') return `connecting to "${device}"…`;
  if (phase === 'password') return 'checking the developer-mode password…';
  if (!step) return working;
  const label = step.step === 'refreshing' ? 'refreshing repositories' : step.step || working.replace(/…$/, '');
  return step.percent === undefined ? `${label}…` : `${label} ${step.percent}%`;
}
