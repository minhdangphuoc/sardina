import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Services } from '../core/services';
import { spawnCapture } from '../sfdk/runner';
import { sanitizeForFilename } from '../devices/deviceWizard';
import { buildKeyParams, parseSecretKeys, signingUserFor, validateKeyEmail, validateKeyName, validatePassphrase } from './signingCore';

const CREATE_KEY = 'Create a new key';

function signingDir(ctx: vscode.ExtensionContext): string {
  const dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'signing').fsPath;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Writes the passphrase to a private file in the extension's storage, the form sfdk's `package.signing-passphrase-file` needs. */
function savePassphrase(ctx: vscode.ExtensionContext, keyName: string, passphrase: string): string {
  const file = path.join(signingDir(ctx), `${sanitizeForFilename(keyName)}.pass`);
  fs.writeFileSync(file, `${passphrase}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

async function listKeys(): Promise<{ missing: boolean; keys: ReturnType<typeof parseSecretKeys> }> {
  const listed = await spawnCapture('gpg', ['--list-secret-keys', '--with-colons'], { timeoutMs: 15000 });
  return { missing: listed.exitCode === -1, keys: parseSecretKeys(listed.stdout) };
}

/**
 * Signs a throwaway file with the key. An empty passphrase must not unlock a protected key (pinentry
 * is disabled), so "the key has none" and "the passphrase is wrong" both fail here, before a build does.
 * Caveat: gpg-agent may still have the passphrase cached from earlier use.
 */
async function verifyKey(ctx: vscode.ExtensionContext, keyName: string, passphrase: string): Promise<{ ok: boolean; detail: string }> {
  const dir = signingDir(ctx);
  const probe = path.join(dir, 'probe.txt');
  const out = path.join(dir, 'probe.sig');
  const passFile = path.join(dir, 'probe.pass');
  try {
    fs.writeFileSync(probe, 'sardina signing probe\n');
    const args = ['--batch', '--yes', '--pinentry-mode', passphrase === '' ? 'error' : 'loopback'];
    if (passphrase !== '') {
      fs.writeFileSync(passFile, `${passphrase}\n`, { mode: 0o600 });
      args.push('--passphrase-file', passFile);
    }
    args.push('--local-user', keyName, '--output', out, '--detach-sign', probe);
    const result = await spawnCapture('gpg', args, { timeoutMs: 30000 });
    return { ok: result.exitCode === 0, detail: result.stderr.trim().split('\n').pop() ?? '' };
  } finally {
    for (const f of [probe, out, passFile]) fs.rmSync(f, { force: true });
  }
}

interface CreatedKey {
  name: string;
  /** What to save as `signingUser`: the new key's fingerprint, so a similarly named key cannot be picked up instead. */
  signingUser: string;
  passphrase: string;
}

/** Asks for the key's name, email and passphrase in VS Code input boxes, then runs `gpg --batch --generate-key`. */
async function createKey(ctx: vscode.ExtensionContext, services: Services): Promise<CreatedKey | undefined> {
  const name = await services.prompts.showInputBox({
    title: 'Create a signing key (1/3): name',
    prompt: 'Your full name. This is what sfdk uses to find the key.',
    validateInput: validateKeyName,
    ignoreFocusOut: true,
  });
  if (name === undefined) return undefined;
  const email = await services.prompts.showInputBox({
    title: 'Create a signing key (2/3): email',
    prompt: 'Optional. Leave empty to create the key without an email address.',
    validateInput: validateKeyEmail,
    ignoreFocusOut: true,
  });
  if (email === undefined) return undefined;
  const passphrase = await services.prompts.showInputBox({
    title: 'Create a signing key (3/3): passphrase',
    prompt: 'Leave empty for a key without a passphrase. Otherwise it is saved in a private file, because sfdk reads it from a file.',
    password: true,
    validateInput: validatePassphrase,
    ignoreFocusOut: true,
  });
  if (passphrase === undefined) return undefined;

  // The parameter file holds the passphrase, so it is private and removed straight after gpg is done.
  const paramsFile = path.join(signingDir(ctx), 'keygen.params');
  let created: string | undefined;
  try {
    fs.writeFileSync(paramsFile, buildKeyParams(name, email, passphrase), { mode: 0o600 });
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Sardina: generating the signing key (this can take a minute)…' },
      () => spawnCapture('gpg', ['--batch', '--status-fd', '1', '--generate-key', paramsFile], { timeoutMs: 5 * 60 * 1000 }),
    );
    if (result.exitCode !== 0) {
      services.output.log('error', `gpg key generation failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
      void services.prompts.showErrorMessage(`Sardina: gpg could not create the key: ${result.stderr.trim().split('\n').pop() ?? `exit ${result.exitCode}`}`);
      return undefined;
    }
    created = /\[GNUPG:\] KEY_CREATED \w ([0-9A-Fa-f]{40})/.exec(result.stdout)?.[1];
  } finally {
    fs.rmSync(paramsFile, { force: true });
  }
  return { name: name.trim(), signingUser: created ?? name.trim(), passphrase };
}

/** `Sardina: Set Up Package Signing`: picks (or creates) a GPG key and fills in the sardina.build.sign* settings for the active project. */
async function setupSigning(ctx: vscode.ExtensionContext, services: Services): Promise<void> {
  const project = await services.projects.resolveActive();
  if (!project) {
    void services.prompts.showWarningMessage('Sardina: open an SFOS project first; the signing settings are saved per project folder.');
    return;
  }

  const { missing, keys } = await listKeys();
  if (missing) {
    void services.prompts.showWarningMessage('Sardina: gpg was not found. Install GnuPG (for example `sudo apt install gnupg`), then run this command again.');
    return;
  }

  let keyName: string | undefined;
  let keyRef: string | undefined; // what sfdk and gpg are told to use: the fingerprint when there is one
  let passphrase: string | undefined; // undefined: not asked yet / keep the current setting
  const items = [
    ...keys.map((k) => ({ label: k.name, description: [k.userId === k.name ? undefined : k.userId, k.fingerprint.slice(-16)].filter(Boolean).join(' · ') || undefined, key: k, create: false })),
    { label: `$(add) ${CREATE_KEY}…`, description: undefined, key: undefined, create: true },
  ];
  const picked = keys.length === 0 ? items[0] : await services.prompts.showQuickPick(items, { title: 'Select the key to sign packages with', placeHolder: 'GPG key' });
  if (!picked) return;
  if (picked.create) {
    const created = await createKey(ctx, services);
    if (!created) return;
    keyName = created.name;
    keyRef = created.signingUser;
    passphrase = created.passphrase;
  } else {
    keyName = picked.label;
    keyRef = picked.key ? signingUserFor(picked.key) : picked.label;
    passphrase = await services.prompts.showInputBox({
      title: 'Key passphrase',
      prompt:
        'Saved in a private file (mode 600) because sfdk reads it from a file. Leave empty ONLY if the key has no passphrase. Press Escape to keep the current setting.',
      password: true,
      validateInput: validatePassphrase,
      ignoreFocusOut: true,
    });
  }

  if (passphrase !== undefined) {
    const check = await verifyKey(ctx, keyRef, passphrase);
    if (!check.ok) {
      services.output.log('warn', `gpg could not sign with "${keyName}": ${check.detail}`);
      void services.prompts.showErrorMessage(
        passphrase === ''
          ? `Sardina: "${keyName}" is protected by a passphrase, but none was entered. Run the command again and enter it. Nothing was saved.`
          : `Sardina: gpg could not sign with "${keyName}" and that passphrase (${check.detail || 'wrong passphrase?'}). Nothing was saved.`,
      );
      return;
    }
  }

  const config = vscode.workspace.getConfiguration('sardina', project.folder.uri);
  const target = vscode.ConfigurationTarget.WorkspaceFolder;
  await config.update('build.signingUser', keyRef, target);
  if (passphrase !== undefined) {
    const file = passphrase === '' ? '' : savePassphrase(ctx, keyName, passphrase);
    await config.update('build.signingPassphraseFile', file, target);
  }
  await config.update('build.sign', true, target);

  void services.prompts.showInformationMessage(
    `Sardina: packages will be signed with "${keyName}" (${keyRef.slice(-16)}). To verify one, import the public key once: ` +
      `gpg --export --armor ${keyRef} | rpm --import /dev/stdin, then run rpm -K on the RPM.`,
  );
}

export function activateSigning(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push(vscode.commands.registerCommand('sardina.setupSigning', () => setupSigning(ctx, services)));
}
