/**
 * Pure parts of "Uninstall Device Agent" (no `vscode` import, unit-tested under plain mocha): the
 * fixed root script, the fixed user-level cleanup and check script, its report parser and the one
 * notification that sums it up. Nothing from the device or the user is put into a script: the
 * cleanup script's paths arrive as positional arguments, and the report only selects among fixed
 * texts here.
 */

import { AGENT_BINARY, AGENT_PACKAGE, DEVICE_TOOLS_DIR, DEVICE_USER, LEGACY_REMOTE_RPM } from './agentCore';
import type { DeviceSessionKind } from '../core/deviceSessions';

/** Device sessions that talk to the agent; they are stopped before it is removed. Debug and app sessions are not. */
export const AGENT_SESSION_KINDS: readonly DeviceSessionKind[] = ['mirror', 'logs', 'monitor'];

/** The agent's D-Bus name on the session bus (the Settings page's service, agent 1.9.0). */
export const AGENT_DBUS_NAME = 'io.github.minhdangphuoc.SailfishDevAgent';

/** The Settings app's process name; closed after an install or removal so it reloads its entries. */
export const SETTINGS_APP = 'jolla-settings';

/** The user's own lipstick unit: restarting it needs neither root nor a password. Fixed argv. */
export const RESTART_HOME_SCREEN_ARGV = ['systemctl', '--user', 'restart', 'lipstick'];

/** The non-modal question after an install, upgrade or removal; ignoring it changes nothing. */
export function restartHomeScreenAsk(device: string, removed: boolean): string {
  return removed
    ? `Restart the home screen on "${device}" to finish removing the agent? Until then its Settings entry and notifications may still be shown.`
    : `Restart the home screen on "${device}" to finish? Until then the Developer agent entry may not appear in Settings and old notifications may stay.`;
}

export function restartHomeScreenConfirm(device: string): string {
  return `Restart the home screen on "${device}"? Running apps will close.`;
}

/** The link `systemctl enable` made for agents up to 1.10.0; 1.10.1 ships its wants link in the package instead. */
const LEGACY_WANTS_LINK = `/etc/systemd/system/multi-user.target.wants/${AGENT_PACKAGE}.service`;

/** Base of the per-user runtime directories on the device (`/run/user/<uid>`). */
export const DEVICE_RUNTIME_BASE = '/run/user';

/**
 * Root (devel-su) script. The package's own scriptlets stop the service, close its notifications and
 * remove its settings; this repeats the parts that need root for agents whose scriptlets predate
 * them (1.10.0 and older left the `systemctl enable` link in /etc, the failed state and the /tmp RPM copy
 * of older extensions), and
 * succeeds when the package is already gone. Fixed text on one line (it goes through a pty): devel-su
 * gets no positional arguments.
 */
export const UNINSTALL_SCRIPT = [
  `if rpm -q ${AGENT_PACKAGE} >/dev/null 2>&1; then rpm -e ${AGENT_PACKAGE} || exit $?; fi`,
  `rm -f ${LEGACY_REMOTE_RPM}`,
  `[ -L ${LEGACY_WANTS_LINK} ] && rm -f ${LEGACY_WANTS_LINK}`,
  `rm -rf /var/lib/${AGENT_PACKAGE}`,
  `systemctl daemon-reload >/dev/null 2>&1`,
  `systemctl reset-failed ${AGENT_PACKAGE}.service >/dev/null 2>&1`,
  // A running Settings app keeps showing the removed entry: close only it (never lipstick).
  `pkill -u ${DEVICE_USER} -x ${SETTINGS_APP} >/dev/null 2>&1`,
  `exit 0`,
].join('; ');

const MARK = 'sfdev-clean';

/** Root-owned paths the package installs or creates; after the uninstall none may exist. */
const ROOT_PATHS = [
  `/usr/bin/${AGENT_BINARY}`,
  `/usr/lib/systemd/system/${AGENT_PACKAGE}.service`,
  `/usr/lib/systemd/system/multi-user.target.wants/${AGENT_PACKAGE}.service`,
  LEGACY_WANTS_LINK,
  `/usr/share/jolla-settings/entries/${AGENT_PACKAGE}.json`,
  `/usr/share/${AGENT_PACKAGE}`,
  `/var/lib/${AGENT_PACKAGE}`,
];

/**
 * Run as the device user over `device exec -- sh -c CLEANUP_SCRIPT sh <rpm copy> <runtime base>`
 * after the root step. Removes what the user may remove (the RPM copy of an install cancelled at
 * the password prompt, a socket directory or staged screenshots of a daemon that did not stop
 * cleanly, `~/.cache/sailfish-tools`), closes notifications lipstick still lists for the agent, and
 * checks read-only that nothing root-owned is left. Each finding is one `sfdev-clean:<what>:<path>`
 * line; `sfdev-clean:done` ends a complete run. BusyBox sh compatible.
 */
export const CLEANUP_SCRIPT = [
  `f=$1; r=$2; u=$(id -u); h=$HOME; b="$r/$u/dbus/user_bus_socket"`,
  `gone() { { [ -e "$1" ] || [ -L "$1" ]; } || return 0; rm -rf "$1" 2>/dev/null; if [ -e "$1" ] || [ -L "$1" ]; then echo "${MARK}:left:$1"; else echo "${MARK}:removed:$1"; fi; }`,
  `gone "$f"`,
  `gone "$r/$u/${AGENT_PACKAGE}"`,
  `[ -n "$h" ] && gone "$h/${DEVICE_TOOLS_DIR}"`,
  `s="$h/${AGENT_PACKAGE}"`,
  `if [ -n "$h" ] && [ -d "$s" ] && [ ! -L "$s" ]; then`,
  `  for p in "$s"/shot-*.png; do [ -e "$p" ] && rm -f "$p" && echo "${MARK}:removed:$p"; done`,
  `  rmdir "$s" 2>/dev/null && echo "${MARK}:removed:$s" || echo "${MARK}:left:$s"`,
  `fi`,
  `ds() { dbus-send --bus="unix:path=$b" --print-reply --reply-timeout=3000 "$@"; }`,
  `if command -v dbus-send >/dev/null 2>&1 && [ -S "$b" ]; then`,
  `  if out=$(ds --dest=org.freedesktop.Notifications /org/freedesktop/Notifications org.freedesktop.Notifications.GetNotifications string: 2>/dev/null); then`,
  `    for id in $(printf '%s\\n' "$out" | awk '/^ *struct \\{$/ { s = 1; next } s == 1 { s = 0; g = ($0 ~ /^ *string "${AGENT_PACKAGE}"$/); next } g && $1 == "uint32" { print $2; g = 0 }'); do`,
  `      case $id in *[!0-9]*|'') continue ;; esac`,
  `      if ds --dest=org.freedesktop.Notifications /org/freedesktop/Notifications org.freedesktop.Notifications.CloseNotification uint32:$id >/dev/null 2>&1; then echo "${MARK}:closed:$id"; else echo "${MARK}:left:notification $id"; fi`,
  `    done`,
  `  else echo "${MARK}:unchecked:notifications"; fi`,
  `  ds --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:${AGENT_DBUS_NAME} 2>/dev/null | grep -q 'boolean true' && echo "${MARK}:left:D-Bus name ${AGENT_DBUS_NAME}"`,
  `else echo "${MARK}:unchecked:notifications"; fi`,
  `rpm -q ${AGENT_PACKAGE} >/dev/null 2>&1 && echo "${MARK}:left:package ${AGENT_PACKAGE}"`,
  `for p in ${ROOT_PATHS.join(' ')}; do { [ -e "$p" ] || [ -L "$p" ]; } && echo "${MARK}:left:$p"; done`,
  `pidof ${AGENT_BINARY} >/dev/null 2>&1 && echo "${MARK}:left:running process ${AGENT_BINARY}"`,
  `echo "${MARK}:done"`,
].join('\n');

/** The positional arguments for CLEANUP_SCRIPT (after `sh -c CLEANUP_SCRIPT sh`). */
export const CLEANUP_ARGS: readonly string[] = [LEGACY_REMOTE_RPM, DEVICE_RUNTIME_BASE];

export interface CleanupReport {
  /** Paths the cleanup removed. */
  removed: string[];
  /** Notification ids it closed. */
  closed: number[];
  /** What is still on the device. */
  left: string[];
  /** What could not be checked (no dbus-send, no session bus). */
  unchecked: string[];
  /** False when the script did not run to its end (connection lost, not a POSIX shell). */
  complete: boolean;
}

const LINE_RE = new RegExp(`^${MARK}:(removed|closed|left|unchecked):(.{1,300})$`);
const MAX_ITEMS = 50;

/** CLEANUP_SCRIPT's output → report; other lines (a login banner, a shell warning) are ignored. */
export function parseCleanupReport(stdout: string): CleanupReport {
  const report: CleanupReport = { removed: [], closed: [], left: [], unchecked: [], complete: false };
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === `${MARK}:done`) {
      report.complete = true;
      continue;
    }
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, what, value] = m;
    if (what === 'closed') {
      if (/^[0-9]{1,10}$/.test(value) && report.closed.length < MAX_ITEMS) report.closed.push(Number(value));
      continue;
    }
    const list = what === 'removed' ? report.removed : what === 'left' ? report.left : report.unchecked;
    if (list.length < MAX_ITEMS && !list.includes(value)) list.push(value);
  }
  return report;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function listed(items: readonly string[], max = 3): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** The one notification after a successful root step: what was cleaned up and anything still there. */
export function uninstallSummary(device: string, report: CleanupReport): { level: 'information' | 'warning'; message: string } {
  const parts = [`Sailfish: the device agent was removed from "${device}".`];
  const extra: string[] = [];
  if (report.removed.length > 0) extra.push(plural(report.removed.length, 'leftover item'));
  if (report.closed.length > 0) extra.push(plural(report.closed.length, 'notification'));
  if (extra.length > 0) parts.push(`Also removed ${extra.join(' and ')}.`);
  if (report.left.length > 0) {
    parts.push(`Still on the device: ${listed(report.left)} (see the Sailfish OS output; root-owned items need "devel-su").`);
  }
  if (!report.complete) {
    parts.push('The final check did not finish, so leftovers could not be verified.');
  } else if (report.unchecked.length > 0) {
    parts.push(`Could not check: ${listed(report.unchecked)}.`);
  } else if (report.left.length === 0) {
    parts.push('Nothing of the agent is left.');
  }
  const level = report.left.length > 0 || !report.complete ? 'warning' : 'information';
  return { level, message: parts.join(' ') };
}
