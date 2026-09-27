/**
 * Pure string-parsing helpers for FR-6.8 VM correlation. No `vscode` import
 * so this can be unit-tested directly under plain mocha.
 */

const EXACT_VM_KEYS = new Set(['vm-name', 'vm_name', 'vmname']);

/**
 * `sfdk emulator show` is key/value (FR-16.7). An exact `vm-name`/`vm_name`/
 * `vmname` key wins over any other key merely containing "vm" (e.g.
 * `vm-type: VirtualBox`), which would otherwise be matched first.
 */
export function extractVmNameFromShowOutput(raw: string): string | undefined {
  let fallback: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (EXACT_VM_KEYS.has(key)) {
      return m[2];
    }
    if (fallback === undefined && key.includes('vm')) {
      fallback = m[2];
    }
  }
  return fallback;
}

/** `VBoxManage list vms` prints `"<name>" {<uuid>}` per line. */
export function parseVboxVmNames(raw: string): string[] {
  const names: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^"([^"]*)"/.exec(line.trim());
    if (m) names.push(m[1]);
  }
  return names;
}

/** Exact match, then substring match either way (skipping empty/very short names), then a match on the version token alone. */
export function matchVboxVmName(vmNames: string[], displayName: string): string | undefined {
  if (vmNames.includes(displayName)) {
    return displayName;
  }
  const substr = vmNames.find(
    (n) => n.length >= 3 && displayName.length >= 3 && (n.includes(displayName) || displayName.includes(n)),
  );
  if (substr) {
    return substr;
  }
  const versionMatch = /(\d+(?:\.\d+){1,3})/.exec(displayName);
  if (versionMatch) {
    return vmNames.find((n) => n.includes(versionMatch[1]));
  }
  return undefined;
}
