import * as fs from 'node:fs';
import * as path from 'node:path';
import { XML } from './devicesXmlConstants';

/** One flat `<data><variable>K</variable><value type="T">V</value></data>` entry, in file order. */
interface RawEntry {
  variable: string;
  type: string;
  raw: string;
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
  /** Any Device.<N>.* key not in the known set above, preserved verbatim (type + raw text). */
  unknownKeys: Record<string, { type: string; raw: string }>;
}

export interface DevicesXmlDocument {
  /** Every non-`Device.*`/`Devices.Count` entry (e.g. `DeviceModel.*`, `Version`), in original order. */
  otherEntries: RawEntry[];
  devices: DeviceEntry[];
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

const DATA_BLOCK_RE = /<data>\s*<variable>([\s\S]*?)<\/variable>\s*<value type="([^"]*)"(?:\s+key="[^"]*")?>([\s\S]*?)<\/value>\s*<\/data>/g;

/** Fail-soft: an empty document (no file, or unparseable content) is a valid "no devices yet" state, never a throw. */
export function parseDevicesXml(xml: string): DevicesXmlDocument {
  const doc: DevicesXmlDocument = { otherEntries: [], devices: [] };
  const byIndex = new Map<number, DeviceEntry>();

  for (const match of xml.matchAll(DATA_BLOCK_RE)) {
    const variable = unescapeXml(match[1]);
    const type = match[2];
    const raw = unescapeXml(match[3]);

    if (variable === XML.countKey) {
      continue; // recomputed from devices.length on write
    }
    const deviceMatch = /^Device\.(\d+)\.(.+)$/.exec(variable);
    if (!deviceMatch) {
      doc.otherEntries.push({ variable, type, raw });
      continue;
    }
    const index = Number(deviceMatch[1]);
    const field = deviceMatch[2];
    let device = byIndex.get(index);
    if (!device) {
      device = { index, id: '', name: '', autodetected: false, architecture: 0, wordWidth: 32, machineType: 0, unknownKeys: {} };
      byIndex.set(index, device);
      doc.devices.push(device);
    }
    applyField(device, field, type, raw);
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

function writeEntry(variable: string, type: string, value: string): string {
  return `    <data>\n        <variable>${escapeXml(variable)}</variable>\n        <value type="${type}">${escapeXml(value)}</value>\n    </data>\n`;
}

function deviceEntries(device: DeviceEntry): string {
  const k = XML.keys;
  const prefix = `${XML.dataKeyPrefix}${device.index}.`;
  let out = '';
  out += writeEntry(`${prefix}${k.id}`, 'QString', device.id);
  out += writeEntry(`${prefix}${k.name}`, 'QString', device.name);
  out += writeEntry(`${prefix}${k.autodetected}`, 'bool', String(device.autodetected));
  out += writeEntry(`${prefix}${k.architecture}`, 'int', String(device.architecture));
  out += writeEntry(`${prefix}${k.wordWidth}`, 'int', String(device.wordWidth));
  out += writeEntry(`${prefix}${k.machineType}`, 'int', String(device.machineType));
  if (device.host !== undefined) out += writeEntry(`${prefix}${k.host}`, 'QString', device.host);
  if (device.port !== undefined) out += writeEntry(`${prefix}${k.port}`, 'int', String(device.port));
  if (device.userName !== undefined) out += writeEntry(`${prefix}${k.userName}`, 'QString', device.userName);
  if (device.authenticationType !== undefined)
    out += writeEntry(`${prefix}${k.authenticationType}`, 'int', String(device.authenticationType));
  if (device.privateKeyFile !== undefined) out += writeEntry(`${prefix}${k.privateKeyFile}`, 'QString', device.privateKeyFile);
  if (device.timeout !== undefined) out += writeEntry(`${prefix}${k.timeout}`, 'int', String(device.timeout));
  if (device.hostKeyChecking !== undefined)
    out += writeEntry(`${prefix}${k.hostKeyChecking}`, 'int', String(device.hostKeyChecking));
  if (device.freePorts !== undefined) out += writeEntry(`${prefix}${k.freePorts}`, 'QString', device.freePorts);
  if (device.qmlLivePorts !== undefined) out += writeEntry(`${prefix}${k.qmlLivePorts}`, 'QString', device.qmlLivePorts);
  for (const [field, { type, raw }] of Object.entries(device.unknownKeys)) {
    out += writeEntry(`${prefix}${field}`, type, raw);
  }
  return out;
}

/**
 * Serializes per the real writer (src/libs/utils/persistentsettings.cpp): XML decl, a
 * `<!DOCTYPE QtCreatorSfdkDevices>` DTD, a comment, `<qtcreator>` root, one `<data>` per
 * flat key. Byte-identical parity with a real Qt-Creator-written file is not attempted —
 * Qt Creator's own writer embeds a fresh app-name/version/timestamp comment on every save,
 * so even its own output isn't byte-stable across writes; this only needs to be valid,
 * correctly-keyed XML that Qt Creator/sfdk can read back.
 */
export function serializeDevicesXml(doc: DevicesXmlDocument, writtenAtIso: string): string {
  let body = '';
  for (const entry of doc.otherEntries) {
    body += writeEntry(entry.variable, entry.type, entry.raw);
  }
  body += writeEntry(XML.countKey, 'int', String(doc.devices.length));
  for (const device of doc.devices) {
    body += deviceEntries(device);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE ${XML.docType}>\n` +
    `<!-- Written by sailfish-tools, ${writtenAtIso}. -->\n` +
    `<qtcreator>\n${body}</qtcreator>\n`
  );
}

export interface DevicesXmlWriteResult {
  path: string;
  backupPath: string | null;
}

const MAX_BACKUPS = 5;

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
  fs.writeFileSync(tmpPath, serializeDevicesXml(doc, nowIso), 'utf8');
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
