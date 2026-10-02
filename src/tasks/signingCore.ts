/** Parsing for `gpg --list-secret-keys --with-colons`. No `vscode` import so it can be unit-tested directly. */

export interface SigningKey {
  /** The name as sfdk wants it for `package.signing.user`: the user ID without its comment or email. */
  name: string;
  /** The full user ID, for display. */
  userId: string;
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

/** Secret keys' usable user IDs, without duplicates; revoked and expired ones are skipped. */
export function parseSecretKeys(colonOutput: string): SigningKey[] {
  const keys: SigningKey[] = [];
  const seen = new Set<string>();
  for (const line of colonOutput.split(/\r?\n/)) {
    const fields = line.split(':');
    if (fields[0] !== 'uid') continue;
    const validity = fields[1] ?? '';
    if (validity === 'r' || validity === 'e') continue;
    const userId = unescapeField(fields[9] ?? '').trim();
    const name = nameFromUserId(userId);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    keys.push({ name, userId });
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
