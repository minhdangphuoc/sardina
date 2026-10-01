import { execFile } from 'node:child_process';

export type SshToolName = 'ssh' | 'ssh-keygen' | 'ssh-copy-id';

export const REQUIRED_SSH_TOOLS: SshToolName[] = ['ssh', 'ssh-keygen', 'ssh-copy-id'];

function which(tool: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(finder, [tool], (error) => resolve(!error));
  });
}

/** Checks which of the given tools are missing from PATH; never throws. */
export async function missingTools(tools: readonly SshToolName[]): Promise<SshToolName[]> {
  const checks = await Promise.all(tools.map(async (tool) => ({ tool, present: await which(tool) })));
  return checks.filter((c) => !c.present).map((c) => c.tool);
}

/** Per-platform guidance for a missing OpenSSH client tool, shown in the activation notice. */
export function installHint(tool: SshToolName, platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return tool === 'ssh-copy-id'
      ? `${tool}: usually ships with macOS; if missing, \`brew install ssh-copy-id\` or reinstall the Xcode Command Line Tools (\`xcode-select --install\`).`
      : `${tool}: ships with macOS's built-in OpenSSH client; reinstall via \`xcode-select --install\` if missing.`;
  }
  if (platform === 'linux') {
    return `${tool}: install the \`openssh-client\` package (e.g. \`sudo apt install openssh-client\` / \`sudo dnf install openssh-clients\`).`;
  }
  return `${tool}: install OpenSSH (Settings → Optional Features on Windows 10/11, or via Git for Windows).`;
}
