import { randomUUID } from 'node:crypto';
import {
  AUTHENTICATION_TYPE,
  DEFAULT_FREE_PORTS,
  DEFAULT_QML_LIVE_PORTS,
  DEFAULT_TIMEOUT_SECONDS,
  HOST_KEY_CHECKING,
  MACHINE_TYPE,
  architectureFields,
  type SfdkArch,
} from './devicesXmlConstants';
import type { DeviceEntry, DevicesXmlDocument } from './devicesXml';

export interface NewDeviceAnswers {
  name: string;
  host: string;
  port: number;
  user: string;
  architecture: SfdkArch;
  privateKeyFile: string;
}

/** FR-7.5: braced `{uuid}` if any existing device already uses that style, else Qt Creator's own default — braced. */
function idStyle(doc: DevicesXmlDocument): 'braced' | 'plain' {
  const plain = doc.devices.some((d) => d.id && !d.id.startsWith('{'));
  const braced = doc.devices.some((d) => d.id.startsWith('{'));
  if (plain && !braced) {
    return 'plain';
  }
  return 'braced';
}

function nextIndex(doc: DevicesXmlDocument): number {
  return doc.devices.reduce((max, d) => Math.max(max, d.index + 1), 0);
}

/** FR-7.1/FR-7.5: builds the new device's DeviceEntry (index, Id, and every field) — the caller appends it and writes. */
export function buildNewDeviceEntry(answers: NewDeviceAnswers, doc: DevicesXmlDocument): DeviceEntry {
  const uuid = randomUUID();
  const id = idStyle(doc) === 'braced' ? `{${uuid}}` : uuid;
  const { architecture, wordWidth } = architectureFields(answers.architecture);
  return {
    index: nextIndex(doc),
    id,
    name: answers.name,
    autodetected: false,
    architecture,
    wordWidth,
    machineType: MACHINE_TYPE.hardware,
    host: answers.host,
    port: answers.port,
    userName: answers.user,
    authenticationType: AUTHENTICATION_TYPE.specificKey,
    privateKeyFile: answers.privateKeyFile,
    timeout: DEFAULT_TIMEOUT_SECONDS,
    hostKeyChecking: HOST_KEY_CHECKING.allowNoMatch,
    freePorts: DEFAULT_FREE_PORTS,
    qmlLivePorts: DEFAULT_QML_LIVE_PORTS,
    unknownKeys: {},
  };
}

/** FR-7.9: renumbers Device.<N>.* contiguously after a remove. */
export function removeDeviceByIndex(doc: DevicesXmlDocument, index: number): DevicesXmlDocument {
  const remaining = doc.devices.filter((d) => d.index !== index).sort((a, b) => a.index - b.index);
  const renumbered = remaining.map((d, i) => ({ ...d, index: i }));
  return { otherEntries: doc.otherEntries, devices: renumbered };
}

/** Sanitizes a device name into a safe filename component for the generated key (FR-7.8). */
export function sanitizeForFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'device';
}
