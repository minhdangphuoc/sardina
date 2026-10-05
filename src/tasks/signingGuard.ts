import type { Uri } from 'vscode';
import type { Services } from '../core/services';
import { spawnCapture } from '../sfdk/runner';
import { decideSigningUser, looksLikeKeyId, parseSecretKeys, signingProblemMessage } from './signingCore';

export type SigningResolution = { ok: true; user: string } | { ok: false; message: string };

/**
 * Before a signed build: turns the configured `sailfish.build.signingUser` into the value sfdk should get.
 * A name matching exactly one secret key becomes that key's fingerprint; a name matching none or several is
 * reported here, where it can be explained, instead of failing inside the build engine's key import.
 * Anything that cannot be checked (signing off, no value, a key ID, gpg missing or hanging) passes through unchanged.
 */
export async function resolveSigningUser(services: Services, folderUri: Uri): Promise<SigningResolution> {
  const configured = services.settings.get('build.signingUser', folderUri);
  if (!services.settings.get('build.sign', folderUri) || configured === '' || looksLikeKeyId(configured)) {
    return { ok: true, user: configured };
  }
  const listed = await spawnCapture('gpg', ['--list-secret-keys', '--with-colons', '--', configured], { timeoutMs: 15000 });
  if (listed.exitCode === -1 || listed.timedOut) {
    return { ok: true, user: configured };
  }
  const decision = decideSigningUser(configured, parseSecretKeys(listed.stdout));
  if (decision.kind === 'use') {
    if (decision.user !== configured) {
      services.output.log('info', `signing user "${configured}" resolved to key ${decision.user}`);
    }
    return { ok: true, user: decision.user };
  }
  const message = signingProblemMessage(configured, decision);
  services.output.log('warn', message);
  return { ok: false, message };
}
