import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The build engine's own device list, `<SharedConfig>/devices.xml` (by default
 * `~/SailfishOS/vmshare/devices.xml`). Deploy runs inside the engine and reads this file, not
 * libsfdk's devices.xml; without an entry here it fails with "Fatal: '<name>' is not a known
 * device". Only Qt Creator's device dialog updates it on its own, so Add/Remove Device edit it
 * too. Captured format (SDK 3.13.5):
 *   <devices>
 *     <host name="…"/><engine …>…</engine>
 *     <device name="Sailfish OS Emulator 5.1.0.11" type="vbox">…</device>
 *     <device name="Jolla Phone 2026" type="real">
 *       <ip>192.168.2.16</ip><sshport>22</sshport>
 *       <sshkeypath>ssh/private_keys/jolla-phone-2026</sshkeypath><username>defaultuser</username>
 *     </device>
 *   </devices>
 * Edits are textual so every other entry stays byte-identical.
 */

export interface EngineDevice {
  name: string;
  host: string;
  port: number;
  user: string;
  /** Key path relative to the shared config folder, e.g. `ssh/private_keys/jolla-phone-2026`. */
  keyPath: string;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function deviceBlockRe(name: string): RegExp {
  const escaped = escapeXml(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`[ \\t]*<device name="${escaped}"[^>]*?(?:/>|>[\\s\\S]*?</device>)[ \\t]*\\r?\\n?`);
}

export function hasEngineDevice(xml: string, name: string): boolean {
  return deviceBlockRe(name).test(xml);
}

/** Adds (or replaces) a `type="real"` device before `</devices>`; undefined if the file has no `</devices>`. */
export function addEngineDevice(xml: string, device: EngineDevice): string | undefined {
  // Never replace a same-named entry of another type (e.g. the build engine's emulator).
  const existing = deviceBlockRe(device.name).exec(xml)?.[0];
  if (existing && !/\btype="real"/.test(existing.split('>')[0])) return undefined;
  const base = removeEngineDevice(xml, device.name);
  const close = base.lastIndexOf('</devices>');
  if (close === -1) return undefined;
  const block =
    `    <device name="${escapeXml(device.name)}" type="real">\n` +
    `        <ip>${escapeXml(device.host)}</ip>\n` +
    `        <sshport>${device.port}</sshport>\n` +
    `        <sshkeypath>${escapeXml(device.keyPath)}</sshkeypath>\n` +
    `        <username>${escapeXml(device.user)}</username>\n` +
    `    </device>\n`;
  return base.slice(0, close) + block + base.slice(close);
}

export function removeEngineDevice(xml: string, name: string): string {
  return xml.replace(deviceBlockRe(name), '');
}

/** `SharedConfig` from libsfdk's buildengines.xml (sibling of devices.xml), else `<sdkRoot>/vmshare`. */
export function findSharedConfigDir(libsfdkDir: string, sdkRoot: string | undefined): string | undefined {
  try {
    const engines = fs.readFileSync(path.join(libsfdkDir, 'buildengines.xml'), 'utf8');
    const match = /<value type="QString" key="SharedConfig">([^<]+)<\/value>/.exec(engines);
    if (match && fs.existsSync(match[1])) return match[1];
  } catch {
    // fall through
  }
  const fallback = sdkRoot ? path.join(sdkRoot, 'vmshare') : undefined;
  return fallback && fs.existsSync(fallback) ? fallback : undefined;
}

/** Whether `<sharedConfig>/devices.xml` currently lists `name`; false when the file is missing or unreadable. */
export function engineHasDevice(sharedConfigDir: string, name: string): boolean {
  try {
    return hasEngineDevice(fs.readFileSync(path.join(sharedConfigDir, 'devices.xml'), 'utf8'), name);
  } catch {
    return false;
  }
}

/** Applies `edit` to `<sharedConfig>/devices.xml` with a .bak copy; returns the backup path, or undefined if nothing was written. */
export function editEngineDevicesFile(sharedConfigDir: string, edit: (xml: string) => string | undefined): string | undefined {
  const file = path.join(sharedConfigDir, 'devices.xml');
  if (!fs.existsSync(file)) return undefined;
  const before = fs.readFileSync(file, 'utf8');
  const after = edit(before);
  if (after === undefined || after === before) return undefined;
  const backup = `${file}.bak-sailfish-tools`;
  fs.copyFileSync(file, backup);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, after, 'utf8');
  fs.renameSync(tmp, file);
  return backup;
}
