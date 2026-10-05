/**
 * Pure parts of the device agent client (no `vscode` import, unit-tested under plain mocha):
 * reply parsing, screenshot path validation, file naming, architecture → RPM mapping and the
 * fixed scripts the install/uninstall commands run on the device.
 */

export const AGENT_PACKAGE = 'sailfish-devagent';
export const AGENT_BINARY = 'sailfish-devagent';
/** Where the RPM lands on the device before `rpm -U`; a fixed path, never user input. */
export const AGENT_REMOTE_RPM = '/tmp/sailfish-devagent.rpm';

export type AgentArch = 'aarch64' | 'armv7hl' | 'i486';
export const AGENT_ARCHES: readonly AgentArch[] = ['aarch64', 'armv7hl', 'i486'];

/**
 * The RPM architecture for a device from `uname -m` (or `uname -a`) output: `aarch64` → aarch64,
 * `armv7l`/`armv7hl` → armv7hl, `i486`/`i586`/`i686` → i486 (the emulator). Anything else is
 * unsupported (undefined). `uname` rather than `rpm --qf %{ARCH}`: `sfdk device exec` hands its
 * words to a remote shell, which could re-parse `%{…}`.
 */
export function archFromOutput(output: string): AgentArch | undefined {
  for (const token of output.trim().split(/\s+/)) {
    if (token === 'aarch64') return 'aarch64';
    if (token === 'armv7l' || token === 'armv7hl') return 'armv7hl';
    if (token === 'i486' || token === 'i586' || token === 'i686') return 'i486';
  }
  return undefined;
}

/**
 * The userland architecture from `rpm -q rpm` (e.g. `rpm-4.16.1.3-1.6.1.jolla.armv7hl`): the suffix of
 * the installed package's name. Preferred over `uname -m`, which reports the kernel: some phones run a
 * 64-bit kernel with a 32-bit armv7hl userland, and the RPM must match the userland.
 */
export function archFromRpmQuery(output: string): AgentArch | undefined {
  const line = output.trim().split(/\r?\n/).pop() ?? '';
  return archFromOutput(line.slice(line.lastIndexOf('.') + 1));
}

/** Picks the agent RPM for `arch` among the files shipped in `media/agent/<arch>/`. */
export function pickAgentRpm(arch: AgentArch, fileNames: readonly string[]): string | undefined {
  const candidates = fileNames.filter((f) => f.startsWith(`${AGENT_PACKAGE}-`) && f.endsWith(`.${arch}.rpm`)).sort();
  return candidates[candidates.length - 1];
}

export interface AgentReply {
  ok: boolean;
  version?: string;
  developerMode?: boolean;
  path?: string;
  error?: string;
}

/** The first JSON object line of the agent's stdout; undefined when there is none. */
export function parseAgentReply(stdout: string): AgentReply | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.ok !== 'boolean') return undefined;
      return {
        ok: parsed.ok,
        version: typeof parsed.version === 'string' ? parsed.version : undefined,
        developerMode: typeof parsed.developerMode === 'boolean' ? parsed.developerMode : undefined,
        path: typeof parsed.path === 'string' ? parsed.path : undefined,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export type AgentProbe =
  | { state: 'running'; version: string; developerMode: boolean }
  | { state: 'not-running' }
  | { state: 'not-installed' }
  | { state: 'unreachable'; detail: string };

/** Classifies `sailfish-devagent --request ping` (client exit codes: 0 ok, 3 no daemon; 127 = no binary). */
export function classifyPing(result: { exitCode: number; stdout: string; stderr: string }): AgentProbe {
  const reply = parseAgentReply(result.stdout);
  if (result.exitCode === 0 && reply?.ok) {
    return { state: 'running', version: reply.version ?? '?', developerMode: reply.developerMode ?? false };
  }
  if (result.exitCode === 3 || reply?.error === 'agent not running') {
    return { state: 'not-running' };
  }
  if (result.exitCode === 127 || /sailfish-devagent: (command )?not found|No such file/i.test(`${result.stderr}\n${result.stdout}`)) {
    return { state: 'not-installed' };
  }
  const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`).split(/\r?\n/)[0];
  return { state: 'unreachable', detail };
}

/** The agent writes screenshots only here; anything else in a reply is refused. */
export const SCREENSHOT_PATH_RE = /^\/run\/user\/[0-9]+\/sailfish-devagent\/shot-[0-9]+\.png$/;

export function isScreenshotPath(path: string): boolean {
  return SCREENSHOT_PATH_RE.test(path);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(data: Buffer): boolean {
  return data.length >= PNG_MAGIC.length && data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

/** `base64 <file>` output (wrapped lines) → bytes. */
export function decodeBase64Output(stdout: string): Buffer {
  return Buffer.from(stdout.replace(/\s+/g, ''), 'base64');
}

/** A device name as a file-name component: `Xperia 10 - Dual SIM (ARM)` → `Xperia-10-Dual-SIM-ARM`. */
export function sanitizeDeviceName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'device';
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `<device>-<YYYYMMDD-HHMMSS>.png`, local time. */
export function screenshotFileName(device: string, date: Date): string {
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${sanitizeDeviceName(device)}-${stamp}.png`;
}

/**
 * Copies stdin (base64) to `$1` and checks its size against `$2`; both arrive as positional argv
 * elements, so nothing is interpolated into the script. BusyBox sh only.
 */
export const COPY_SCRIPT = 'f=$1; n=$2; base64 -d > "$f" && [ "$(wc -c < "$f")" -eq "$n" ]';

/** Root (devel-su) scripts; the RPM path and package name are constants. */
export const INSTALL_SCRIPT = `r=0; rpm -U --replacepkgs --oldpackage ${AGENT_REMOTE_RPM} || r=$?; rm -f ${AGENT_REMOTE_RPM}; exit $r`;
export const UNINSTALL_SCRIPT = `rpm -e ${AGENT_PACKAGE}`;

/** What the consent dialog says the agent can do (the security model's "install is the consent step"). */
export function installConsentDetail(device: string): string {
  return (
    `The agent is a small service (${AGENT_PACKAGE}) that lets VS Code take screenshots and read the system log of "${device}" ` +
    'without asking for the password each time. It runs as defaultuser with the "privileged" and "systemd-journal" groups only, ' +
    'answers only on a local socket (nothing new is opened on the network) and only while Developer Mode is on. ' +
    'You will be asked for the device\'s developer-mode password once. "Uninstall Device Agent" removes it again.'
  );
}

/** One line for the status notification. */
export function describeProbe(device: string, probe: AgentProbe): string {
  switch (probe.state) {
    case 'running':
      return `Sailfish: device agent ${probe.version} is running on "${device}"; Developer Mode is ${probe.developerMode ? 'on' : 'off, so screenshots and logs are refused'}.`;
    case 'not-running':
      return `Sailfish: the device agent is installed on "${device}" but not running (try "Install Device Agent" again, or on the device: systemctl status sailfish-devagent).`;
    case 'not-installed':
      return `Sailfish: the device agent is not installed on "${device}".`;
    case 'unreachable':
      return `Sailfish: could not reach the device agent on "${device}": ${probe.detail}`;
  }
}
