/**
 * Pure parts of the device agent client (no `vscode` import, unit-tested under plain mocha):
 * reply parsing, screenshot path validation, file naming, architecture → RPM mapping and the
 * fixed scripts the install/uninstall commands run on the device.
 */

import { parseKeypadInfo, type KeypadInfo } from './keypadLayoutCore';

export const AGENT_PACKAGE = 'sailfish-devagent';
export const AGENT_BINARY = 'sailfish-devagent';
/** The device user the agent runs as (its unit's `User=`) and the SSH login. */
export const DEVICE_USER = 'defaultuser';
/**
 * The extension's own folder on the device, relative to the device user's home. Everything the
 * extension writes there (outside the agent's package) goes into it, mode 0700.
 */
export const DEVICE_TOOLS_DIR = '.cache/sailfish-tools';
/** The core RPM's file name in DEVICE_TOOLS_DIR before `rpm -U`; a fixed name, never user input. */
export const AGENT_RPM_NAME = 'sailfish-devagent.rpm';
/** Agent 1.11.0: the feature modules, each its own package `sailfish-devagent-<module>`. */
export const AGENT_MODULES = ['logs', 'stats', 'screenshot', 'mirror', 'input'] as const;
export type AgentModule = (typeof AGENT_MODULES)[number];
/** The core first, then every module package. */
export const AGENT_PACKAGES: readonly string[] = [AGENT_PACKAGE, ...AGENT_MODULES.map((m) => `${AGENT_PACKAGE}-${m}`)];
/** The first agent that reports `modules`; older agents are monolithic: every module is there. */
export const MODULES_MIN_AGENT_VERSION = '1.11.0';
/** Where extensions before 0.1.9 copied the RPM; only ever removed now. */
export const LEGACY_REMOTE_RPM = '/tmp/sailfish-devagent.rpm';

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

/** Numeric dotted comparison; missing parts are 0 and a non-numeric part compares as 0. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.trim().split('.');
  const pb = b.trim().split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = versionPart(pa[i]);
    const y = versionPart(pb[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function versionPart(s: string | undefined): number {
  return s === undefined || !/^\d+$/.test(s) ? 0 : Number(s);
}

const RPM_NAME = /^sailfish-devagent(?:-(logs|stats|screenshot|mirror|input))?-(\d+(?:\.\d+)*)-(\d+)\.([a-z0-9_]+)\.rpm$/;

/** Picks the core agent RPM for `arch` among the files shipped in `media/agent/<arch>/` (module RPMs never match). */
export function pickAgentRpm(arch: AgentArch, fileNames: readonly string[]): string | undefined {
  const candidates = fileNames.filter((f) => {
    const m = RPM_NAME.exec(f);
    return m !== null && m[1] === undefined && m[4] === arch;
  });
  return candidates.sort()[candidates.length - 1];
}

/** One RPM to install and the fixed name its copy gets on the device. */
export interface AgentRpm {
  file: string;
  copyName: string;
}

/** What an install puts on the device: the core and/or a module package. */
export type AgentPart = 'core' | AgentModule;

/** Input only works inside a mirror stream, so picking it brings the mirror along. */
export function withRequiredModules(modules: readonly AgentModule[]): AgentModule[] {
  const wanted = new Set(modules);
  if (wanted.has('input')) wanted.add('mirror');
  return AGENT_MODULES.filter((m) => wanted.has(m));
}

/** The RPMs for `parts` and `arch` of one bundled version (the core's); undefined when the core or a part is not shipped. */
export function pickAgentRpms(arch: AgentArch, fileNames: readonly string[], parts: readonly AgentPart[]): AgentRpm[] | undefined {
  const core = pickAgentRpm(arch, fileNames);
  const coreMatch = core === undefined ? null : RPM_NAME.exec(core);
  if (core === undefined || coreMatch === null) return undefined;
  const rpms: AgentRpm[] = [];
  for (const part of ['core', ...AGENT_MODULES] as const) {
    if (!parts.includes(part)) continue;
    const suffix = part === 'core' ? '' : `-${part}`;
    const file = part === 'core' ? core : `${AGENT_PACKAGE}${suffix}-${coreMatch[2]}-${coreMatch[3]}.${arch}.rpm`;
    if (!fileNames.includes(file)) return undefined;
    rpms.push({ file, copyName: `${AGENT_PACKAGE}${suffix}.rpm` });
  }
  return rpms;
}

/** Every copy name an install may leave in the tools folder. */
export const AGENT_COPY_NAMES: readonly string[] = AGENT_PACKAGES.map((p) => `${p}.rpm`);

export interface AgentReply {
  ok: boolean;
  version?: string;
  developerMode?: boolean;
  path?: string;
  error?: string;
  /** Agent 1.2.0+: the agent's local socket path (unvalidated here). Absent on 1.1.0 replies. */
  socket?: string;
  /** Agent 1.2.0+: the mirror encodings the agent offers. Absent on 1.1.0 replies. */
  mirrorEncodings?: string[];
  /** Agent 1.7.0+: mirror gestures the daemon can inject. Absent means view-only. */
  mirrorInput?: string[];
  /** Whitelisted physical keypad keys exposed by this phone. */
  keypad?: KeypadInfo;
  /** Agent 1.9.0+: the phone's own settings (Settings → System → Developer agent). Absent on older agents. */
  settings?: PhoneSettings;
  /** Agent 1.9.0+: true when the agent installed its Settings page. */
  settingsPage?: boolean;
  /** Agent 1.10.0+: log formats the `logs` request accepts (`text`, `json`). */
  logFormats?: string[];
  /** Agent 1.10.0+: true when the agent offers the `stats` stream. */
  stats?: boolean;
  /** Agent 1.11.0+: the installed modules. Absent on older agents, which have every feature. */
  modules?: AgentModule[];
}

export const INDICATOR_LEVELS = ['normal', 'quiet', 'minimal'] as const;
export type IndicatorLevel = (typeof INDICATOR_LEVELS)[number];

/** What the phone allows; a key is present only when the agent reported it with the right type. */
export interface PhoneSettings {
  screenView?: boolean;
  control?: boolean;
  logs?: boolean;
  indicator?: IndicatorLevel;
  muteNotifications?: boolean;
  touchIndicator?: boolean;
  /** Agent 1.10.6: whether the mirror goes idle while the screen is still. */
  idleMode?: boolean;
  /** Agent 1.10.7: the mirror's frame rate limit, 30 or 60. */
  maxFps?: 30 | 60;
}

const PHONE_BOOLEAN_KEYS = ['screenView', 'control', 'logs', 'muteNotifications', 'touchIndicator', 'idleMode'] as const;

/** Keeps only the known keys with the right types; undefined when the value is not an object. */
export function parsePhoneSettings(value: unknown): PhoneSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: PhoneSettings = {};
  for (const key of PHONE_BOOLEAN_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  if (typeof raw.indicator === 'string' && (INDICATOR_LEVELS as readonly string[]).includes(raw.indicator)) {
    out.indicator = raw.indicator as IndicatorLevel;
  }
  if (raw.maxFps === 30 || raw.maxFps === 60) out.maxFps = raw.maxFps;
  return out;
}

/** The first JSON object line of the agent's stdout; undefined when there is none. */
export function parseAgentReply(stdout: string): AgentReply | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.ok !== 'boolean') return undefined;
      const reply: AgentReply = {
        ok: parsed.ok,
        version: typeof parsed.version === 'string' ? parsed.version : undefined,
        developerMode: typeof parsed.developerMode === 'boolean' ? parsed.developerMode : undefined,
        path: typeof parsed.path === 'string' ? parsed.path : undefined,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
      };
      // Added only when present, so a 1.1.0 reply parses to exactly what it did before.
      if (typeof parsed.socket === 'string') reply.socket = parsed.socket;
      if (Array.isArray(parsed.mirrorEncodings) && parsed.mirrorEncodings.every((e) => typeof e === 'string')) {
        reply.mirrorEncodings = parsed.mirrorEncodings;
      }
      if (Array.isArray(parsed.mirrorInput) && parsed.mirrorInput.every((e) => typeof e === 'string')) {
        reply.mirrorInput = parsed.mirrorInput;
      }
      const keypad = parseKeypadInfo(parsed.keypad);
      if (keypad !== undefined) reply.keypad = keypad;
      const settings = parsePhoneSettings(parsed.settings);
      if (settings !== undefined) reply.settings = settings;
      if (typeof parsed.settingsPage === 'boolean') reply.settingsPage = parsed.settingsPage;
      if (Array.isArray(parsed.logFormats) && parsed.logFormats.every((e) => typeof e === 'string')) reply.logFormats = parsed.logFormats;
      if (typeof parsed.stats === 'boolean') reply.stats = parsed.stats;
      if (Array.isArray(parsed.modules)) reply.modules = AGENT_MODULES.filter((m) => (parsed.modules as unknown[]).includes(m));
      return reply;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export type AgentProbe =
  | { state: 'running'; version: string; developerMode: boolean; socket?: string; mirrorEncodings?: string[]; mirrorInput?: string[]; keypad?: KeypadInfo; settings?: PhoneSettings; settingsPage?: boolean; logFormats?: string[]; stats?: boolean; modules?: AgentModule[] }
  | { state: 'not-running' }
  | { state: 'not-installed' }
  | { state: 'unreachable'; detail: string };

type RunningProbe = Extract<AgentProbe, { state: 'running' }>;

/** The installed modules; a 1.10.x agent without `modules` is monolithic and counts as having all. */
export function installedModules(probe: RunningProbe): readonly AgentModule[] {
  if (probe.modules !== undefined) return probe.modules;
  return compareVersions(probe.version, MODULES_MIN_AGENT_VERSION) < 0 ? AGENT_MODULES : [];
}

export function hasModule(probe: AgentProbe, module: AgentModule): boolean {
  return probe.state === 'running' && installedModules(probe).includes(module);
}

/** Classifies `sailfish-devagent --request ping` (client exit codes: 0 ok, 3 no daemon; 127 = no binary). */
export function classifyPing(result: { exitCode: number; stdout: string; stderr: string }): AgentProbe {
  const reply = parseAgentReply(result.stdout);
  if (result.exitCode === 0 && reply?.ok) {
    const running: AgentProbe = { state: 'running', version: reply.version ?? '?', developerMode: reply.developerMode ?? false };
    if (reply.socket !== undefined) running.socket = reply.socket;
    if (reply.mirrorEncodings !== undefined) running.mirrorEncodings = reply.mirrorEncodings;
    if (reply.mirrorInput !== undefined) running.mirrorInput = reply.mirrorInput;
    if (reply.keypad !== undefined) running.keypad = reply.keypad;
    if (reply.settings !== undefined) running.settings = reply.settings;
    if (reply.settingsPage !== undefined) running.settingsPage = reply.settingsPage;
    if (reply.logFormats !== undefined) running.logFormats = reply.logFormats;
    if (reply.stats !== undefined) running.stats = reply.stats;
    if (reply.modules !== undefined) running.modules = reply.modules;
    return running;
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
 * Copies stdin (base64) to `$1` (a plain file name) in the extension's private folder
 * `~/.cache/sailfish-tools` (0700, so no other user can swap the file before root installs it) and
 * checks its size against `$2`; both arrive as positional argv elements, so nothing is
 * interpolated into the script. BusyBox sh only.
 */
export const COPY_SCRIPT =
  `case $1 in */*|'') exit 2 ;; esac; d=$HOME/${DEVICE_TOOLS_DIR}; f=$d/$1; n=$2; ` +
  'mkdir -p "$d" && chmod 700 "$d" && base64 -d > "$f" && [ "$(wc -c < "$f")" -eq "$n" ]';

/** Removes the copies named in the arguments (plain file names) and the private folder when it is then empty: an install that never reached rpm. */
export const REMOVE_COPY_SCRIPT = `d=$HOME/${DEVICE_TOOLS_DIR}; for n in "$@"; do case $n in */*|'') exit 2 ;; esac; rm -f "$d/$n"; done; rmdir "$d" 2>/dev/null; exit 0`;

/**
 * Root (devel-su) script; the device user, folder and file names are constants. All copied RPMs
 * (the core and its modules) go in one transaction; the copies are removed whatever rpm says, and
 * the private folder too when that leaves it empty.
 */
export const INSTALL_SCRIPT =
  `d=$(getent passwd ${DEVICE_USER} | cut -d: -f6)/${DEVICE_TOOLS_DIR}; r=0; ` +
  `rpm -U --replacepkgs --oldpackage "$d"/${AGENT_PACKAGE}*.rpm || r=$?; rm -f "$d"/${AGENT_PACKAGE}*.rpm; rmdir "$d" 2>/dev/null; exit $r`;
// The uninstall scripts live in uninstallCore.ts.

const MODULE_ABILITY: Readonly<Record<AgentModule, string>> = {
  logs: 'read the system log of the device without asking for the password each time',
  stats: 'read the CPU and memory use of apps',
  screenshot: 'take screenshots',
  mirror: 'mirror the screen',
  input: 'send taps, swipes and key presses from a focused mirror panel',
};

/** One line per module for the install pick. */
export const MODULE_PICK_DETAIL: Readonly<Record<AgentModule, string>> = {
  logs: 'Show Device Logs',
  stats: 'App CPU and memory in the Device Monitor',
  screenshot: 'Take Device Screenshot',
  mirror: 'Mirror the screen',
  input: 'Control the phone from the mirror (needs mirror)',
};

/** What the consent dialog says the agent can do with `modules` (the security model's "install is the consent step"). */
export function installConsentDetail(device: string, modules: readonly AgentModule[]): string {
  const can = modules.map((m) => MODULE_ABILITY[m]).join(', ');
  const touch = modules.includes('input') ? ', whose normal groups include access to the touchscreen,' : '';
  const stops = modules.includes('input') ? ', and input stops when the mirror loses focus' : '';
  return (
    `The agent is a small service (${AGENT_PACKAGE}) that lets VS Code ${can || 'connect'} on "${device}". ` +
    `It runs as defaultuser${touch} with "privileged" as its primary group` +
    `${modules.includes('logs') ? ' and "systemd-journal" added' : ''}. It answers only on a local socket ` +
    `(nothing new is opened on the network) and only while Developer Mode is on${stops}. ` +
    'You will be asked for the device\'s developer-mode password once. "Uninstall Device Agent" removes it again.'
  );
}

const SETTINGS_PLACE = 'Settings → System → Developer agent';

/** The wire reasons the agent gives when the phone's settings (or its owner) refuse or end something. */
const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  'screen view disabled on the phone': `Screen view is turned off on the phone. Turn on "Allow screen view" in ${SETTINGS_PLACE} on the phone.`,
  'logs disabled on the phone': `System logs are turned off on the phone. Turn on "Allow system logs" in ${SETTINGS_PLACE} on the phone.`,
  'stopped from the phone': 'The session was stopped from the phone ("Stop all sessions now" in the Developer agent settings).',
  'control disabled on the phone': `Control is turned off on the phone. Turn on "Allow control from VS Code" in ${SETTINGS_PLACE} on the phone.`,
  'developer mode is off': 'Developer Mode is off on the phone. Turn it on in Settings → Developer tools.',
};

const MODULE_NOT_INSTALLED = /^(logs|stats|screenshot|mirror|input) module not installed$/;

/** A user-facing text for an agent error string; unknown errors are returned as they are. */
export function describeAgentRefusal(error: string): string {
  const module = MODULE_NOT_INSTALLED.exec(error)?.[1];
  if (module) return `The ${module} module of the device agent is not installed. Run "Install Device Agent" and pick it.`;
  return REFUSAL_TEXT[error] ?? error;
}

/** The permissions that are off on the phone, as words. */
function permissionsOff(settings: PhoneSettings): string[] {
  const off: string[] = [];
  if (settings.screenView === false) off.push('screen view');
  if (settings.control === false) off.push('control');
  if (settings.logs === false) off.push('logs');
  return off;
}

/** The phone's own settings as one sentence ("" when the agent did not report any). */
export function describePhoneSettings(settings: PhoneSettings | undefined): string {
  if (!settings) return '';
  const off = permissionsOff(settings);
  const known = settings.screenView !== undefined || settings.control !== undefined || settings.logs !== undefined;
  const parts: string[] = [];
  if (off.length > 0) {
    parts.push(`the phone has turned off ${off.join(', ')} (${SETTINGS_PLACE})`);
  } else if (known) {
    parts.push('the phone allows screen view, control and logs');
  }
  if (settings.indicator !== undefined && settings.indicator !== 'normal') parts.push(`session indicator ${settings.indicator}`);
  if (settings.muteNotifications === true) parts.push('agent notifications muted');
  if (settings.touchIndicator === true) parts.push('touch indicator on');
  return parts.length > 0 ? ` On the phone: ${parts.join('; ')}.` : '';
}

/** The text for a request the phone's settings would refuse, or undefined when it is allowed or unknown. */
export function phoneRefusal(probe: AgentProbe, need: 'screenView' | 'logs'): string | undefined {
  if (probe.state !== 'running' || probe.settings?.[need] !== false) return undefined;
  return describeAgentRefusal(need === 'screenView' ? 'screen view disabled on the phone' : 'logs disabled on the phone');
}

/**
 * The client name sent as `client` (`--client`): the host name cut to the agent's alphabet
 * `[A-Za-z0-9 ._-]` and 64 characters, like the agent does. Empty means unknown.
 */
export function clientName(host: string): string {
  return host.replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 64).trim();
}

/** What a feature needs from the agent: its module, the phone switch that may refuse it, and its name for prompts. */
export interface AgentNeed {
  module: AgentModule;
  setting?: 'screenView' | 'logs';
  feature: string;
}

/** " with logs (not installed: …)"; nothing for a 1.10.x agent, which has every feature in one piece. */
function describeModules(probe: RunningProbe): string {
  if (probe.modules === undefined) return '';
  const have = probe.modules;
  const missing = AGENT_MODULES.filter((m) => !have.includes(m));
  return missing.length === 0 ? ` with ${have.join(', ')}` : ` with ${have.join(', ') || 'no modules'} (not installed: ${missing.join(', ')})`;
}

/** One line for the status notification. */
export function describeProbe(device: string, probe: AgentProbe): string {
  switch (probe.state) {
    case 'running':
      return `Sardina: device agent ${probe.version} is running on "${device}"${describeModules(probe)}; Developer Mode is ${probe.developerMode ? 'on' : 'off, so screenshots and logs are refused'}.${describePhoneSettings(probe.settings)}`;
    case 'not-running':
      return `Sardina: the device agent is installed on "${device}" but not running (try "Install Device Agent" again, or on the device: systemctl status sailfish-devagent).`;
    case 'not-installed':
      return `Sardina: the device agent is not installed on "${device}".`;
    case 'unreachable':
      return `Sardina: could not reach the device agent on "${device}": ${probe.detail}`;
  }
}
