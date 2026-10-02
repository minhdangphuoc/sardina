/**
 * Pure helpers for pushing a generated public key to a device without a terminal
 * (FR-7.8). The password reaches `ssh` only through an SSH_ASKPASS helper that
 * prints it from the child's environment: never argv, never a file, never logged.
 * No `vscode` import so this can be unit-tested directly under plain mocha.
 */

/** Env var the askpass helper prints; only ever set on the ssh-copy-id child. */
export const ASKPASS_PASSWORD_ENV = 'SAILFISH_SSH_PASSWORD';

export const ASKPASS_SCRIPT = `#!/bin/sh\nprintf '%s\\n' "$${ASKPASS_PASSWORD_ENV}"\n`;

export interface KeyPushInvocation {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

export function buildKeyPushInvocation(opts: {
  pubKeyPath: string;
  host: string;
  port: number;
  user: string;
  askpassPath: string;
  display?: string;
}): KeyPushInvocation {
  return {
    cmd: 'ssh-copy-id',
    args: [
      '-i',
      opts.pubKeyPath,
      '-p',
      String(opts.port),
      // No tty to answer the host-key prompt; first contact is trusted, as typing "yes" would be.
      '-o',
      'StrictHostKeyChecking=accept-new',
      // One askpass call per attempt, so a wrong password fails fast instead of looping.
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'ConnectTimeout=10',
      '--',
      `${opts.user}@${opts.host}`,
    ],
    env: {
      SSH_ASKPASS: opts.askpassPath,
      SSH_ASKPASS_REQUIRE: 'force',
      // OpenSSH < 8.4 ignores SSH_ASKPASS_REQUIRE and only uses askpass when DISPLAY is set.
      DISPLAY: opts.display || ':0',
    },
  };
}

export type KeyPushFailure = 'auth' | 'unreachable' | 'other';

export function classifyKeyPushFailure(stderr: string): KeyPushFailure {
  if (/permission denied|authentication failed|too many authentication failures/i.test(stderr)) {
    return 'auth';
  }
  if (/no route to host|connection refused|connection timed out|could not resolve hostname|network is unreachable|operation timed out/i.test(stderr)) {
    return 'unreachable';
  }
  return 'other';
}
