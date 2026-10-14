/** Pure parts of devicePackages.ts (no `vscode` import, unit-testable under plain mocha). */

export const QML_DEBUG_SERVER_PACKAGE = 'qt5-qtdeclarative-plugin-qmlinspector';

/** Read-only check used before starting a package transaction. */
export const CHECK_PACKAGE_MANAGER_SCRIPT =
  'if pidof pkcon >/dev/null 2>&1; then echo sfdev-package-manager:busy; else echo sfdev-package-manager:idle; fi';

/** What Sardina needs on a device for deployment plus C++ and QML/JavaScript debugging. */
export const DEVICE_TOOL_PACKAGES = ['rsync', 'sdk-deploy-rpm', 'gdb-gdbserver', QML_DEBUG_SERVER_PACKAGE] as const;

/** Each tool Sardina needs and the package that provides it. RPM ownership is the canonical check:
 * binaries/plugins can live outside the login shell's PATH or move between Sailfish releases. */
const TOOL_CHECKS = [
  { id: 'rsync', pkg: 'rsync' },
  { id: 'sdk-deploy-rpm', pkg: 'sdk-deploy-rpm' },
  { id: 'gdbserver', pkg: 'gdb-gdbserver' },
  { id: 'qml-debug-server', pkg: QML_DEBUG_SERVER_PACKAGE },
] as const;

const CHECK_MARK = 'sfdev-tool';

/** Read-only (no root) script for `device exec -- sh -c`. Every command is fixed source text. */
export const CHECK_TOOLS_SCRIPT = TOOL_CHECKS.map(
  (tool) => `if /usr/bin/rpm -q ${tool.pkg} >/dev/null 2>&1; then echo "${CHECK_MARK}:${tool.id}:ok"; else echo "${CHECK_MARK}:${tool.id}:missing"; fi`,
).join('; ');

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
    const present = seen.get(t.id);
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
  const stepMatch = /(refresh|download|install|remov|resolv|dependenc|updat|query|wait|finish)/i.exec(line);
  const pct = /(?:^Percentage:\s*|\b)(\d{1,3})(?:\s*%|\s*$)/i.exec(line);
  const percent = pct && Number(pct[1]) <= 100 ? Number(pct[1]) : undefined;
  if (!stepMatch && percent === undefined) return undefined;
  const word = stepMatch?.[1].toLowerCase();
  const step =
    word === undefined ? '' : word.startsWith('refresh') ? 'refreshing' : word.startsWith('download') ? 'downloading' : word.startsWith('install') ? 'installing' : word;
  return percent === undefined ? { step } : { step, percent };
}

/** Keep terminal-style package-manager progress readable and bounded before logging it. */
export function cleanRootShellOutput(raw: string): string {
  const withoutAnsi = raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const compact = withoutAnsi.replace(/[ \t]+/g, ' ').trim();
  return compact.length <= 2000 ? compact : `${compact.slice(0, 1999)}…`;
}

/**
 * Installs from the existing metadata first. Exit 4 is what pkcon reports for stale metadata, so
 * only then refresh and retry. Package names are fixed constants, never user input.
 */
export function installScript(packages: readonly string[]): string {
  if (!packages.length || packages.some((pkg) => !(DEVICE_TOOL_PACKAGES as readonly string[]).includes(pkg))) {
    throw new Error('Invalid device tool package selection');
  }
  const install = `pkcon --plain install -y ${packages.join(' ')}`;
  return `${install} || { status=$?; [ "$status" -eq 4 ] || exit "$status"; pkcon --plain refresh && ${install}; }`;
}

/** Only the fixed deployment/debug package allow-list can enter a privileged removal command. */
export function removeToolsScript(packages: readonly string[]): string {
  if (!packages.length || packages.some((pkg) => !(DEVICE_TOOL_PACKAGES as readonly string[]).includes(pkg))) {
    throw new Error('Invalid device tool package selection');
  }
  return `pkcon --plain remove -y ${[...new Set(packages)].join(' ')}`;
}

/** A monotonic, stage-weighted notification bar. PackageKit restarts percentages for queries,
 * downloads and individual packages; a package's 100% must not finish the entire operation. */
export class DevicePackageProgress {
  private phase: 'preparing' | 'downloading' | 'installing' | 'removing' = 'preparing';
  private completed = 0;
  private readonly items = new Map<string, number>();

  constructor(private readonly packages: readonly string[]) {}

  update(step: string | undefined, percentage?: number, pkg?: string): number {
    if (step) {
      if (/download/i.test(step)) this.phase = 'downloading';
      else if (/install|reinstall|updat/i.test(step)) this.phase = 'installing';
      else if (/remov/i.test(step)) this.phase = 'removing';
      else if (/quer|resolv|dependenc|refresh|prepar/i.test(step)) this.phase = 'preparing';
    }
    if (percentage === undefined || !Number.isFinite(percentage) || percentage <= 0 || percentage > 100) return 0;
    let percent = percentage;
    if (pkg) {
      if (!this.packages.includes(pkg)) return 0;
      const key = `${this.phase}:${pkg}`;
      this.items.set(key, Math.max(this.items.get(key) ?? 0, percent));
      percent = this.packages.reduce((sum, item) => sum + (this.items.get(`${this.phase}:${item}`) ?? 0), 0) / this.packages.length;
    }
    const [start, weight] = this.phase === 'downloading' ? [10, 45]
      : this.phase === 'installing' ? [55, 40]
      : this.phase === 'removing' ? [10, 85] : [0, 10];
    const next = Math.max(this.completed, Math.min(95, start + weight * percent / 100));
    const increment = next - this.completed;
    this.completed = next;
    return increment;
  }

  complete(): number {
    const increment = 100 - this.completed;
    this.completed = 100;
    return increment;
  }
}

export type PackageManagerState = 'idle' | 'busy' | 'unknown';

/** Parses only Sardina's fixed marker; diagnostic noise cannot become a false idle result. */
export function packageManagerState(output: string, exitCode: number): PackageManagerState {
  if (exitCode !== 0) return 'unknown';
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes('sfdev-package-manager:busy')) return 'busy';
  if (lines.includes('sfdev-package-manager:idle')) return 'idle';
  return 'unknown';
}

/**
 * Gives the remote process group its own deadline. The host watches the same limit, but this
 * watchdog remains effective if VS Code reloads or the detached sfdk process is orphaned.
 */
export function rootShellScript(script: string, overallMs: number): string {
  const seconds = Math.max(1, Math.ceil(overallMs / 1000));
  return (
    `sardina_parent=$$; ` +
    `(sleep ${seconds}; kill -INT -"$sardina_parent") & sardina_watchdog=$!; ` +
    `trap 'kill "$sardina_watchdog" 2>/dev/null || true' EXIT; ` +
    `trap 'exit 124' HUP INT TERM; ` +
    `${script}; sardina_status=$?; exit "$sardina_status"`
  );
}

/** What to tell the user after the install finishes. */
export function installOutcomeMessage(device: string, packages: readonly string[], exitCode: number | undefined): { ok: boolean; message: string } {
  if (exitCode === 0) {
    return { ok: true, message: `Sardina: installed ${packages.join(', ')} on "${device}".` };
  }
  return {
    ok: false,
    message:
      `Sardina: installing ${packages.join(', ')} on "${device}" failed${exitCode === undefined ? '' : ` (exit ${exitCode})`}. ` +
      'Check that the device has internet access (Wi-Fi or mobile data), that you typed the developer-mode password, ' +
      "and the Sardina output channel for which package was not found.",
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
  return `Sardina: could not check the tools on "${device}": ${detail}. Nothing was installed; see the Sardina output channel.`;
}

/** The message for a device whose SSH port does not answer; for an emulator, that it is not running. */
export function offlineMessage(device: string, emulator = false): string {
  return emulator
    ? `Sardina: the emulator "${device}" is not running — start it (Devices view) and try again.`
    : `Sardina: "${device}" is offline — connect it (USB or Wi-Fi, Developer Mode on) and try again.`;
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

export type PackageMonitorEvent =
  | { event: 'ready' }
  | { event: 'transaction' }
  | { event: 'package'; package: string; phase: string; summary?: string }
  | { event: 'progress'; package: string; percentage: number }
  | { event: 'status'; phase?: string; package?: string; percentage?: number }
  | { event: 'error'; code: string; details: string }
  | { event: 'finished'; exit: string; installed: string[]; missing: string[] }
  | { event: 'stalled'; seconds: number; installed: string[]; missing: string[] };

/** Fixed argv for the unprivileged agent's read-only PackageKit transaction stream. */
export function packageMonitorArgs(packages: readonly string[]): string[] {
  return ['device', 'exec', '--', 'sailfish-devagent', '--request', 'packages', ...packages.flatMap((pkg) => ['--package', pkg])];
}

/** Accept only the small event vocabulary emitted by agent 1.12.0; arbitrary JSON never reaches UI text. */
export function parsePackageMonitorEvent(line: string, requested: readonly string[]): PackageMonitorEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok === true && record.stream === 'packages' && record.event === 'ready') return { event: 'ready' };
  if (record.event === 'transaction') return { event: 'transaction' };
  const allowed = new Set(requested);
  const pkg = typeof record.package === 'string' && allowed.has(record.package) ? record.package : undefined;
  const percentage = typeof record.percentage === 'number' && Number.isInteger(record.percentage) && record.percentage >= 0 && record.percentage <= 100
    ? record.percentage
    : undefined;
  const stringArray = (item: unknown): string[] | undefined =>
    Array.isArray(item) && item.every((entry) => typeof entry === 'string' && allowed.has(entry)) ? [...new Set(item)] : undefined;
  if (record.event === 'package' && pkg && typeof record.phase === 'string') {
    return { event: 'package', package: pkg, phase: record.phase.slice(0, 64), ...(typeof record.summary === 'string' ? { summary: record.summary.slice(0, 200) } : {}) };
  }
  if (record.event === 'progress' && pkg && percentage !== undefined) return { event: 'progress', package: pkg, percentage };
  if (record.event === 'status') {
    const phase = typeof record.phase === 'string' ? record.phase.slice(0, 64) : undefined;
    if (!phase && !pkg && percentage === undefined) return undefined;
    return { event: 'status', ...(phase ? { phase } : {}), ...(pkg ? { package: pkg } : {}), ...(percentage !== undefined ? { percentage } : {}) };
  }
  if (record.event === 'error' && typeof record.code === 'string' && typeof record.details === 'string') {
    return { event: 'error', code: record.code.slice(0, 64), details: record.details.slice(0, 500) };
  }
  if (record.event === 'finished' || record.event === 'stalled') {
    const installed = stringArray(record.installed);
    const missing = stringArray(record.missing);
    if (!installed || !missing) return undefined;
    if (record.event === 'finished' && typeof record.exit === 'string') {
      return { event: 'finished', exit: record.exit.slice(0, 64), installed, missing };
    }
    if (record.event === 'stalled' && typeof record.seconds === 'number' && record.seconds >= 1 && record.seconds <= 3600) {
      return { event: 'stalled', seconds: Math.round(record.seconds), installed, missing };
    }
  }
  return undefined;
}

export function packageMonitorMessage(event: PackageMonitorEvent): string | undefined {
  switch (event.event) {
    case 'ready':
      return 'watching PackageKit…';
    case 'transaction':
      return 'PackageKit transaction started…';
    case 'package':
      return `${event.phase} ${event.package}…`;
    case 'progress':
      return `${event.package}: ${event.percentage}%`;
    case 'status': {
      const subject = [event.phase, event.package].filter(Boolean).join(' ');
      return `${subject || 'PackageKit'}${event.percentage === undefined ? '…' : `: ${event.percentage}%`}`;
    }
    case 'error':
      return `PackageKit error: ${event.code}`;
    case 'finished':
      return `PackageKit ${event.exit}`;
    case 'stalled':
      return event.missing.length === 0
        ? 'packages installed; closing the stalled PackageKit client…'
        : `PackageKit has made no progress for ${event.seconds} s…`;
  }
}

/** UI receives every progress event; the output channel keeps milestones instead of every percent. */
export function packageMonitorLogMessage(event: PackageMonitorEvent, complete: boolean): string | undefined {
  if (event.event === 'progress' || event.event === 'transaction') return undefined;
  if (event.event === 'status' && (!event.phase || event.percentage !== undefined || event.phase === 'finished')) return undefined;
  if (event.event === 'finished' && !complete && event.exit === 'succeeded') return undefined;
  if (event.event === 'error') return `PackageKit error ${event.code}: ${cleanRootShellOutput(event.details)}`;
  return packageMonitorMessage(event);
}

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

  /** Bytes without a newline are still activity (pkcon redraws one terminal line in place). */
  onActivity(now: number): void {
    this.lastOutput = now;
    if (this.phaseValue === 'password') this.phaseValue = 'running';
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
      return `Sardina: "${device}" did not answer within ${s(limits.promptMs)} — it may be offline or asleep. Connect it (USB or Wi-Fi, Developer Mode on) and try again.`;
    case 'dropped':
      return `Sardina: the connection to "${device}" dropped — the device stopped responding. Check the USB cable or Wi-Fi and try again.`;
    case 'stalled':
      return `Sardina: "${device}" stopped responding (no output for ${s(limits.stallMs)}). Check the connection and try again; see the Sardina output for the last lines.`;
    case 'timeout':
      return `Sardina: the command on "${device}" did not finish within ${s(limits.overallMs)} and was stopped. See the Sardina output for the last lines.`;
    case 'password-rejected':
      return `Sardina: "${device}" did not accept the password. Use the developer-mode password (Settings → Developer tools) and try again.`;
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
