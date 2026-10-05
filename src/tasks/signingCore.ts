/** Parsing for `gpg --list-secret-keys --with-colons`. No `vscode` import so it can be unit-tested directly. */

export interface SigningKey {
  /** The name as sfdk wants it for `package.signing-user`: the user ID without its comment or email. */
  name: string;
  /** The full user ID, for display. */
  userId: string;
  /** The primary key's fingerprint, unambiguous where names overlap ("Jane Doe" also matches "Jane Doe Dev"); empty if gpg gave none. */
  fingerprint: string;
}

/** `\x3a` is how --with-colons escapes a literal colon (and `\x5c` a backslash) inside a field. */
function unescapeField(field: string): string {
  return field.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** `Jane Doe (work) <jane@example.com>` -> `Jane Doe`. */
export function nameFromUserId(userId: string): string {
  return userId
    .replace(/\s*<[^>]*>\s*$/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

/** The value to hand to sfdk's `package.signing-user`: the fingerprint when known, since gpg matches names as substrings. */
export function signingUserFor(key: SigningKey): string {
  return key.fingerprint || key.name;
}

/** `gpg --list-secret-keys --with-colons` -> one entry per key (its first usable user ID); revoked and expired user IDs are skipped. */
export function parseSecretKeys(colonOutput: string): SigningKey[] {
  const keys: SigningKey[] = [];
  const seen = new Set<string>();
  let fingerprint = '';
  let expectFingerprint = false;
  for (const line of colonOutput.split(/\r?\n/)) {
    const fields = line.split(':');
    if (fields[0] === 'sec') {
      fingerprint = '';
      expectFingerprint = true; // the primary key's `fpr` line follows; subkeys' (after `ssb`) are not wanted
    } else if (fields[0] === 'ssb') {
      expectFingerprint = false;
    } else if (fields[0] === 'fpr' && expectFingerprint) {
      fingerprint = fields[9] ?? '';
      expectFingerprint = false;
    } else if (fields[0] === 'uid') {
      const validity = fields[1] ?? '';
      if (validity === 'r' || validity === 'e') continue;
      const userId = unescapeField(fields[9] ?? '').trim();
      const name = nameFromUserId(userId);
      const id = fingerprint || name;
      if (!name || seen.has(id)) continue;
      seen.add(id);
      keys.push({ name, userId, fingerprint });
    }
  }
  return keys;
}

function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** gpg refuses real names shorter than 5 characters; control characters would break the parameter file's line format. */
export function validateKeyName(name: string): string | undefined {
  if (hasControlChars(name)) return 'The name cannot contain control characters.';
  if (name.trim().length < 5) return 'gpg needs a name of at least 5 characters.';
  return undefined;
}

/** The email is optional; when given it must look like one. */
export function validateKeyEmail(email: string): string | undefined {
  if (email === '') return undefined;
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) ? undefined : 'Enter an email address, or leave this empty.';
}

export function validatePassphrase(passphrase: string): string | undefined {
  return hasControlChars(passphrase) ? 'The passphrase cannot contain control characters or line breaks.' : undefined;
}

/**
 * The parameter file for `gpg --batch --generate-key`. An empty passphrase means an unprotected key.
 * Callers must have passed the three values through the validators above: a newline here would inject parameters.
 */
export function buildKeyParams(name: string, email: string, passphrase: string): string {
  const lines = [
    'Key-Type: RSA',
    'Key-Length: 3072',
    'Key-Usage: sign',
    `Name-Real: ${name.trim()}`,
    ...(email ? [`Name-Email: ${email}`] : []),
    'Expire-Date: 0',
    passphrase === '' ? '%no-protection' : `Passphrase: ${passphrase}`,
    '%commit',
  ];
  return `${lines.join('\n')}\n`;
}

/** Hex key IDs and fingerprints (optionally `0x`-prefixed). gpg matches these exactly, so they need no resolving. */
export function looksLikeKeyId(value: string): boolean {
  return /^(0x)?([0-9A-Fa-f]{8}|[0-9A-Fa-f]{16}|[0-9A-Fa-f]{32}|[0-9A-Fa-f]{40})$/.test(value.trim());
}

export type SigningDecision =
  | { kind: 'use'; user: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; keys: SigningKey[] };

/**
 * What to pass sfdk as `package.signing-user`, given the configured value and the secret keys gpg says match it.
 * gpg matches names as substrings, so `Jane Doe` also matches `Jane Doe Dev`; sfdk then exports every match
 * into one file and the build engine cannot import it. Exactly one match is pinned to its fingerprint; zero
 * or several are reported instead of being handed to sfdk.
 */
export function decideSigningUser(configured: string, matches: SigningKey[]): SigningDecision {
  if (looksLikeKeyId(configured)) return { kind: 'use', user: configured };
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'use', user: signingUserFor(matches[0]) };
  return { kind: 'ambiguous', keys: matches };
}

export function signingProblemMessage(configured: string, decision: Exclude<SigningDecision, { kind: 'use' }>): string {
  if (decision.kind === 'none') {
    return (
      `no GPG secret key matches the signing user "${configured}". ` +
      'Run "Sailfish: Set Up Package Signing" to pick or create a key, or turn off sailfish.build.sign.'
    );
  }
  const list = decision.keys.map((k) => `${k.name} (…${k.fingerprint.slice(-8)})`).join(', ');
  return (
    `the signing user "${configured}" matches ${decision.keys.length} GPG keys: ${list}. sfdk needs exactly one. ` +
    'Run "Sailfish: Set Up Package Signing" to select one by its fingerprint.'
  );
}
