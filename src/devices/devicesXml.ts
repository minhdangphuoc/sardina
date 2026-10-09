import * as fs from 'node:fs';
import * as path from 'node:path';
import { XML } from './devicesXmlConstants';

/** A top-level `<data>` block other than a device or `Devices.Count`, kept verbatim. */
interface RawEntry {
  variable: string;
  xml: string;
}

export interface DeviceEntry {
  index: number;
  id: string;
  name: string;
  autodetected: boolean;
  architecture: number;
  wordWidth: number;
  machineType: number;
  host?: string;
  port?: number;
  userName?: string;
  authenticationType?: number;
  privateKeyFile?: string;
  timeout?: number;
  hostKeyChecking?: number;
  freePorts?: string;
  qmlLivePorts?: string;
  /** Any valuemap key not in the known set above (e.g. an emulator's `EmulatorUri`), preserved (type + raw text). */
  unknownKeys: Record<string, { type: string; raw: string }>;
}

export interface DevicesXmlDocument {
  /** Every top-level entry other than `Device.<N>`/`Devices.Count` (e.g. `Sfdk.UserSettings.Version`), in original order. */
  otherEntries: RawEntry[];
  devices: DeviceEntry[];
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * libsfdk's real layout (captured from SDK 3.13.5, test/fixtures/sfdk/captured/3.13.5):
 *   <data><variable>Device.0</variable>
 *     <valuemap type="QVariantMap"><value type="int" key="Architecture">1</value>…</valuemap></data>
 *   <data><variable>Devices.Count</variable><value type="int">1</value></data>
 *   <data><variable>Sfdk.UserSettings.Version</variable><value type="int">7</value></data>
 * Valuemaps hold no nested <data>, so a lazy match to the next </data> is one block.
 */
const DATA_BLOCK_RE = /<data>\s*<variable>([\s\S]*?)<\/variable>([\s\S]*?)<\/data>/g;
const MAP_VALUE_RE = /<value type="([^"]*)" key="([^"]*)"(?:\s*\/>|>([\s\S]*?)<\/value>)/g;
const DEVICE_VARIABLE_RE = /^Device\.(\d+)$/;
const USER_SETTINGS_VERSION = { variable: 'Sfdk.UserSettings.Version', value: 7 };

/** Fail-soft: an empty document (no file, or unparseable content) is a valid "no devices yet" state, never a throw. */
export function parseDevicesXml(xml: string): DevicesXmlDocument {
  const doc: DevicesXmlDocument = { otherEntries: [], devices: [] };
  for (const match of xml.matchAll(DATA_BLOCK_RE)) {
    const variable = unescapeXml(match[1].trim());
    if (variable === XML.countKey) {
      continue; // recomputed from devices.length on write
    }
    const deviceMatch = DEVICE_VARIABLE_RE.exec(variable);
    if (!deviceMatch) {
      doc.otherEntries.push({ variable, xml: match[0] });
      continue;
    }
    const device: DeviceEntry = {
      index: Number(deviceMatch[1]),
      id: '',
      name: '',
      autodetected: false,
      architecture: 0,
      wordWidth: 32,
      machineType: 0,
      unknownKeys: {},
    };
    for (const value of match[2].matchAll(MAP_VALUE_RE)) {
      applyField(device, unescapeXml(value[2]), value[1], unescapeXml(value[3] ?? ''));
    }
    doc.devices.push(device);
  }
  doc.devices.sort((a, b) => a.index - b.index);
  return doc;
}

function applyField(device: DeviceEntry, field: string, type: string, raw: string): void {
  const k = XML.keys;
  switch (field) {
    case k.id:
      device.id = raw;
      return;
    case k.name:
      device.name = raw;
      return;
    case k.autodetected:
      device.autodetected = raw === 'true';
      return;
    case k.architecture:
      device.architecture = Number(raw);
      return;
    case k.wordWidth:
      device.wordWidth = Number(raw);
      return;
    case k.machineType:
      device.machineType = Number(raw);
      return;
    case k.host:
      device.host = raw;
      return;
    case k.port:
      device.port = Number(raw);
      return;
    case k.userName:
      device.userName = raw;
      return;
    case k.authenticationType:
      device.authenticationType = Number(raw);
      return;
    case k.privateKeyFile:
      device.privateKeyFile = raw;
      return;
    case k.timeout:
      device.timeout = Number(raw);
      return;
    case k.hostKeyChecking:
      device.hostKeyChecking = Number(raw);
      return;
    case k.freePorts:
      device.freePorts = raw;
      return;
    case k.qmlLivePorts:
      device.qmlLivePorts = raw;
      return;
    default:
      device.unknownKeys[field] = { type, raw };
  }
}

/** All of a device's keys as (key, type, raw), sorted by key as Qt's QVariantMap writes them. */
function deviceValues(device: DeviceEntry): Array<[string, string, string]> {
  const k = XML.keys;
  const values: Array<[string, string, string]> = [
    [k.id, 'QString', device.id],
    [k.name, 'QString', device.name],
    [k.autodetected, 'bool', String(device.autodetected)],
    [k.architecture, 'int', String(device.architecture)],
    [k.wordWidth, 'int', String(device.wordWidth)],
    [k.machineType, 'int', String(device.machineType)],
  ];
  const optional: Array<[string, string, string | number | undefined]> = [
    [k.host, 'QString', device.host],
    [k.port, 'int', device.port],
    [k.userName, 'QString', device.userName],
    [k.authenticationType, 'int', device.authenticationType],
    [k.privateKeyFile, 'QString', device.privateKeyFile],
    [k.timeout, 'int', device.timeout],
    [k.hostKeyChecking, 'int', device.hostKeyChecking],
    [k.freePorts, 'QString', device.freePorts],
    [k.qmlLivePorts, 'QString', device.qmlLivePorts],
  ];
  for (const [key, type, value] of optional) {
    if (value !== undefined) values.push([key, type, String(value)]);
  }
  for (const [key, { type, raw }] of Object.entries(device.unknownKeys)) {
    values.push([key, type, raw]);
  }
  return values.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function deviceBlock(device: DeviceEntry, index: number): string {
  const values = deviceValues(device)
    .map(([key, type, raw]) => `   <value type="${type}" key="${escapeXml(key)}">${escapeXml(raw)}</value>\n`)
    .join('');
  return (
    ` <data>\n  <variable>${XML.dataKeyPrefix}${index}</variable>\n` +
    `  <valuemap type="QVariantMap">\n${values}  </valuemap>\n </data>\n`
  );
}

function scalarBlock(variable: string, type: string, value: string): string {
  return ` <data>\n  <variable>${escapeXml(variable)}</variable>\n  <value type="${type}">${escapeXml(value)}</value>\n </data>\n`;
}

/**
 * Serializes in libsfdk's layout and order: devices (renumbered 0..n-1), `Devices.Count`, then
 * the other entries verbatim (adding `Sfdk.UserSettings.Version` for a new file). The comment
 * line differs from sfdk's own; sfdk rewrites and normalizes the file on its next save anyway.
 */
export function serializeDevicesXml(doc: DevicesXmlDocument, writtenAtIso: string): string {
  let body = doc.devices.map((device, i) => deviceBlock(device, i)).join('');
  body += scalarBlock(XML.countKey, 'int', String(doc.devices.length));
  const others = doc.otherEntries.length
    ? doc.otherEntries
    : [{ variable: USER_SETTINGS_VERSION.variable, xml: scalarBlock(USER_SETTINGS_VERSION.variable, 'int', String(USER_SETTINGS_VERSION.value)).trim() }];
  for (const entry of others) {
    body += ` ${entry.xml.trim()}\n`;
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE ${XML.docType}>\n` +
    `<!-- Written by Sardina, ${writtenAtIso}. -->\n` +
    `<qtcreator>\n${body}</qtcreator>\n`
  );
}

export interface DevicesXmlWriteResult {
  path: string;
  backupPath: string | null;
}

const MAX_BACKUPS = 5;

/**
 * libsfdk increments `Sfdk.UserSettings.Version` on every save (observed 7 → 10 → 11 on SDK 3.13.5);
 * bumping it too marks the file as newer than any running sfdk's in-memory copy.
 */
export function bumpUserSettingsVersion(doc: DevicesXmlDocument): DevicesXmlDocument {
  const otherEntries = doc.otherEntries.map((entry) => {
    if (entry.variable !== USER_SETTINGS_VERSION.variable) return entry;
    const xml = entry.xml.replace(/(<value type="int">)(\d+)(<\/value>)/, (_m, open: string, n: string, close: string) => `${open}${Number(n) + 1}${close}`);
    return { ...entry, xml };
  });
  return { ...doc, otherEntries };
}

/** FR-7.5: read-modify-write with a timestamped backup (kept to the last 5) and an atomic rename. */
export function writeDevicesXmlFile(filePath: string, doc: DevicesXmlDocument, nowIso: string): DevicesXmlWriteResult {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let backupPath: string | null = null;
  if (fs.existsSync(filePath)) {
    const stamp = nowIso.replace(/[:.]/g, '-');
    backupPath = `${filePath}.bak-${stamp}`;
    fs.copyFileSync(filePath, backupPath);
    pruneOldBackups(filePath, dir);
  }

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, serializeDevicesXml(bumpUserSettingsVersion(doc), nowIso), 'utf8');
  fs.renameSync(tmpPath, filePath);
  return { path: filePath, backupPath };
}

function pruneOldBackups(filePath: string, dir: string): void {
  const base = path.basename(filePath);
  const prefix = `${base}.bak-`;
  const backups = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .sort()
    .reverse();
  for (const stale of backups.slice(MAX_BACKUPS)) {
    fs.rmSync(path.join(dir, stale), { force: true });
  }
}

export function readDevicesXmlFile(filePath: string): DevicesXmlDocument {
  if (!fs.existsSync(filePath)) {
    return { otherEntries: [], devices: [] };
  }
  return parseDevicesXml(fs.readFileSync(filePath, 'utf8'));
}
