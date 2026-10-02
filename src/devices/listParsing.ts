import type { ParseResult, SfdkDeviceInfo } from '../core/types';

/**
 * Pure parsing for `sfdk device list` / `sfdk emulator list` output
 * (FR-16.4 emulatorList / deviceList). No `vscode` import so this can be
 * unit-tested directly under plain mocha (see test/unit/devices).
 */

const HEADER_RE = /^#(\d+)\s+"([^"]*)"\s*$/;
const META_RE = /^(\S+)\s+(\S+)\s+(\S+)@(\S+):(\d+)\s*(.*)$/;
const KIND_VALUES: ReadonlyArray<SfdkDeviceInfo['kind']> = ['emulator', 'hardware-device'];
const ORIGIN_VALUES: ReadonlyArray<SfdkDeviceInfo['origin']> = ['autodetected', 'user-defined'];

/** Splits raw output into per-record line groups, each starting at a `#...` header line. */
function splitRecords(raw: string): string[][] {
  const lines = raw.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (/^#\S/.test(line)) starts.push(i);
  });
  const blocks: string[][] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    blocks.push(
      lines
        .slice(start, end)
        .map((l) => l)
        .filter((l) => l.trim().length > 0),
    );
  }
  return blocks;
}

/** AC-1.9: non-blank lines before the first `#...` header (e.g. a localized "Geräteliste:" banner) are surfaced as warnings, never dropped silently. */
function preambleWarnings(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const firstHeader = lines.findIndex((l) => /^#\S/.test(l));
  const preamble = firstHeader === -1 ? lines : lines.slice(0, firstHeader);
  return preamble
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `Ignoring unrecognized preamble line: ${JSON.stringify(l)}`);
}

/** Detail-line keys the parser understands; anything else is an unrecognised `<key>:` line (AC-1.9). */
const KNOWN_DETAIL_KEY_RE = /^(private-key|flags?|status):/i;
const DETAIL_KEY_RE = /^([^\s:]+):\s*(.*)$/;

/**
 * Parses `#N "Name"` / `<kind> <origin> <user>@<host>:<port>` records
 * (private-key:/flags: lines optional). Never throws: a record that doesn't
 * match the expected shape is dropped with a warning rather than failing
 * the whole parse (R6 — valid entries are kept alongside a warning).
 */
export function parseDeviceRecords(raw: string): ParseResult<SfdkDeviceInfo[]> {
  if (raw.trim().length === 0) {
    return { ok: true, value: [], warnings: [] };
  }

  const warnings: string[] = [...preambleWarnings(raw)];
  const value: SfdkDeviceInfo[] = [];
  /** AC-1.9: per successfully-parsed record, whether it had a recognised private-key line and/or an unknown detail key. */
  const recordSignatures: { hasPrivateKey: boolean; hasUnknownKey: boolean }[] = [];

  for (const block of splitRecords(raw)) {
    const [headerLine, ...rest] = block;
    const header = headerLine ? HEADER_RE.exec(headerLine) : null;
    if (!header) {
      warnings.push(`Could not parse device record header: ${JSON.stringify(headerLine ?? '')}`);
      continue;
    }

    const metaLine = rest[0];
    const meta = metaLine ? META_RE.exec(metaLine.trim()) : null;
    if (!meta) {
      warnings.push(`Could not parse device record body for "${header[2]}"`);
      continue;
    }

    const kindToken = meta[1];
    const originToken = meta[2];
    const flags: string[] = [];
    const trailing = meta[6]?.trim();
    if (trailing) {
      flags.push(...trailing.split(/[\s,]+/).filter(Boolean));
    }

    const extra: string[] = [];
    let privateKey: string | undefined;
    let hasUnknownKey = false;
    for (const line of rest.slice(1)) {
      const trimmed = line.trim();
      const pk = /^private-key:\s*(.+)$/.exec(trimmed);
      if (pk) {
        privateKey = pk[1];
        continue;
      }
      const flagsLine = /^flags?:\s*(.+)$/i.exec(trimmed);
      if (flagsLine) {
        flags.push(...flagsLine[1].split(/[\s,]+/).filter(Boolean));
        continue;
      }
      if (!trimmed) {
        continue;
      }
      const detailKey = DETAIL_KEY_RE.exec(trimmed);
      if (detailKey && !KNOWN_DETAIL_KEY_RE.test(trimmed)) {
        hasUnknownKey = true;
        warnings.push(`Unrecognized detail line for "${header[2]}": ${JSON.stringify(trimmed)}`);
      }
      extra.push(trimmed);
    }
    recordSignatures.push({ hasPrivateKey: privateKey !== undefined, hasUnknownKey });

    value.push({
      index: Number(header[1]),
      name: header[2],
      kind: (KIND_VALUES as readonly string[]).includes(kindToken) ? (kindToken as SfdkDeviceInfo['kind']) : 'unknown',
      origin: (ORIGIN_VALUES as readonly string[]).includes(originToken)
        ? (originToken as SfdkDeviceInfo['origin'])
        : 'unknown',
      user: meta[3],
      host: meta[4],
      port: Number(meta[5]),
      privateKey,
      flags,
      extra,
    });
  }

  if (value.length === 0 && warnings.length > 0) {
    return { ok: false, reason: warnings.join('; '), raw };
  }
  if (recordSignatures.length > 0 && recordSignatures.every((r) => !r.hasPrivateKey && r.hasUnknownKey)) {
    return {
      ok: false,
      reason: `sfdk output looks localized (non-C locale): unrecognized detail keys and no private-key line found; ${warnings.join('; ')}`,
      raw,
    };
  }
  return { ok: true, value, warnings };
}

export const parseDeviceList = parseDeviceRecords;

const EMULATOR_ROW_RE = /^(\S+)(?:\s+(\S+))?\s*$/;
const EMULATOR_NAME_PREFIX = 'SailfishOS-';

/**
 * Parses the `<name>  <flag,flag,...>` table that `sfdk emulator list [-a]`
 * prints (captured from SDK 3.13.5, see test/fixtures/sfdk/captured). Rows
 * not starting with the `SailfishOS-` emulator name prefix (e.g. a
 * `[D] SOFT ASSERT` debug line) are surfaced as warnings, never parsed.
 */
function parseEmulatorTable(raw: string): ParseResult<SfdkDeviceInfo[]> {
  const warnings: string[] = [];
  const value: SfdkDeviceInfo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = EMULATOR_ROW_RE.exec(trimmed);
    if (!row || !row[1].startsWith(EMULATOR_NAME_PREFIX)) {
      warnings.push(`Ignoring unrecognized emulator list line: ${JSON.stringify(trimmed)}`);
      continue;
    }
    // `default` here is sfdk's default emulator, not the default deploy device isDefaultDevice() marks.
    const flags = (row[2] ?? '').split(',').filter(Boolean).map((f) => (f === 'default' ? 'default-emulator' : f));
    value.push({
      index: value.length,
      name: row[1],
      kind: 'emulator',
      origin: flags.includes('sdk-provided') ? 'autodetected' : 'unknown',
      flags,
      extra: [],
    });
  }
  if (value.length === 0 && warnings.length > 0) {
    return { ok: false, reason: warnings.join('; '), raw };
  }
  return { ok: true, value, warnings };
}

/** `sfdk emulator list` is a name/flags table; `#N "Name"` records are still accepted for older output. */
export function parseEmulatorList(raw: string): ParseResult<SfdkDeviceInfo[]> {
  return /^#\d+\s+"/m.test(raw) ? parseDeviceRecords(raw) : parseEmulatorTable(raw);
}

/** `SailfishOS-5.1.0.11` -> `5.1.0.11`; `Sailfish OS Emulator 5.1.0.11` -> `5.1.0.11`. */
function emulatorVersionToken(name: string): string {
  return name.startsWith(EMULATOR_NAME_PREFIX)
    ? name.slice(EMULATOR_NAME_PREFIX.length)
    : (name.trim().split(/\s+/).pop() ?? '');
}

/**
 * Joins each `emulator list` row to the one `device list` entry of kind
 * `emulator` carrying the same version token, copying its ssh endpoint.
 * Ambiguous or missing matches are left unjoined rather than guessed.
 */
export function attachEmulatorEndpoints(emulators: SfdkDeviceInfo[], devices: SfdkDeviceInfo[]): SfdkDeviceInfo[] {
  const emulatorDevices = devices.filter((d) => d.kind === 'emulator');
  return emulators.map((emu) => {
    if (emu.host !== undefined) return emu;
    const version = emulatorVersionToken(emu.name);
    const matches = emulatorDevices.filter((d) => emulatorVersionToken(d.name) === version);
    if (matches.length !== 1) return emu;
    const [dev] = matches;
    return { ...emu, user: dev.user, host: dev.host, port: dev.port, privateKey: dev.privateKey, deviceName: dev.name };
  });
}

/** The name sfdk's device options (`-c device=`, `device exec`) address this entry by. */
export function sfdkDeviceName(device: SfdkDeviceInfo): string {
  return device.deviceName ?? device.name;
}

/** FR-6.2: default = status flag `default`, or an exact match on `sailfish.device`. */
export function isDefaultDevice(device: SfdkDeviceInfo, defaultDeviceName: string | undefined): boolean {
  return device.flags.includes('default') || (!!defaultDeviceName && sfdkDeviceName(device) === defaultDeviceName);
}

export function formatDeviceLabel(device: SfdkDeviceInfo): string {
  return `"${device.name}"`;
}

export function formatDeviceDescription(device: SfdkDeviceInfo): string {
  if (device.host === undefined) {
    return device.flags.join(', ');
  }
  return `${device.kind} ${device.origin} ${device.user ?? '?'}@${device.host ?? '?'}:${device.port ?? '?'}`;
}

export function formatDeviceTooltip(device: SfdkDeviceInfo): string {
  const lines = [
    device.name,
    `${device.kind} / ${device.origin}`,
    `${device.user ?? '?'}@${device.host ?? '?'}:${device.port ?? '?'}`,
    `private-key: ${device.privateKey ?? '(none)'}`,
  ];
  if (device.flags.length > 0) {
    lines.push(`flags: ${device.flags.join(', ')}`);
  }
  return lines.join('\n');
}
