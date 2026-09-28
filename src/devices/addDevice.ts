import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { Services } from '../core/services';
import { resolveDevicesXmlPath } from './devicesXmlLocation';
import { readDevicesXmlFile, writeDevicesXmlFile, serializeDevicesXml } from './devicesXml';
import { buildNewDeviceEntry, removeDeviceByIndex, sanitizeForFilename, type NewDeviceAnswers } from './deviceWizard';
import { conflictingProcessesRunning } from './concurrencyGuard';
import { parseDeviceRecords } from './listParsing';
import type { SfdkArch } from './devicesXmlConstants';

const GENERATE_KEY = 'Generate new key (recommended)';
const USE_EXISTING_KEY = 'Use existing private key';
const WRITE_ANYWAY = 'Write anyway';
const CANCEL = 'Cancel';
const CONTINUE = 'Continue';
const CONFIRM_CREATE = 'Create devices.xml here';
const OPEN_QTC_INSTEAD = 'Register in Qt Creator instead';
const REVEAL_XML = 'Show attempted XML';
const QTC_DOCS_URL = 'https://docs.sailfishos.org/Tools/Sailfish_SDK/';

function execFileP(cmd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, (error, _stdout, stderr) => resolve({ ok: !error, stderr: stderr?.toString() ?? '' }));
  });
}

async function generateKey(ctx: vscode.ExtensionContext, deviceName: string): Promise<string | null> {
  const dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'ssh').fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, sanitizeForFilename(deviceName));
  if (fs.existsSync(keyPath)) {
    fs.rmSync(keyPath);
    fs.rmSync(`${keyPath}.pub`, { force: true });
  }
  let result = await execFileP('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath]);
  if (!result.ok) {
    result = await execFileP('ssh-keygen', ['-t', 'rsa', '-b', '4096', '-N', '', '-f', keyPath]);
  }
  return result.ok ? keyPath : null;
}

/**
 * FR-7.8, deviation from the TRD's ssh2-based silent push: this opens a real interactive
 * terminal running `ssh-copy-id` and lets the user type their own password there, matching
 * the pattern already validated end-to-end against real hardware for `connectWlan.ts` —
 * the extension never reads or holds the device password in memory either way, which is a
 * stronger guarantee than an in-memory ssh2 password (zeroed-after-use is still a window
 * where it exists in the process). No new dependency, no native-binding bundling risk.
 */
function openKeyPushTerminal(keyPath: string, host: string, port: number, user: string): void {
  const terminal = vscode.window.createTerminal({
    name: `SSH key push: ${user}@${host}`,
    shellPath: 'ssh-copy-id',
    shellArgs: ['-i', `${keyPath}.pub`, '-p', String(port), '--', `${user}@${host}`],
  });
  terminal.show();
}

async function verifyDeviceRegistered(services: Services, deviceName: string): Promise<boolean | null> {
  if (!services.sdk.current()) {
    return null; // no real SDK here to verify against; caller treats this as "unverifiable", not a failure
  }
  const result = await services.runner.run({ args: ['device', 'list'], timeoutMs: 60000 });
  const parsed = parseDeviceRecords(result.stdout);
  if (!parsed.ok) {
    return null;
  }
  return parsed.value.some((d) => d.name === deviceName);
}

function showFallbackDialog(services: Services, attemptedXml: string): void {
  void services.prompts
    .showWarningMessage(
      'Sailfish: the device did not appear in `sfdk device list` after writing devices.xml. Register it in Qt Creator instead (Tools → Options → Devices → Add → Sailfish OS Device).',
      OPEN_QTC_INSTEAD,
      REVEAL_XML,
    )
    .then(async (choice) => {
      if (choice === OPEN_QTC_INSTEAD) {
        void vscode.env.openExternal(vscode.Uri.parse(QTC_DOCS_URL));
      } else if (choice === REVEAL_XML) {
        const doc = await vscode.workspace.openTextDocument({ content: attemptedXml, language: 'xml' });
        await vscode.window.showTextDocument(doc);
      }
    });
}

async function pickArchitecture(services: Services): Promise<SfdkArch | undefined> {
  const choice = await services.prompts.showQuickPick(
    [
      { label: 'armv7hl', description: '32-bit ARM' },
      { label: 'aarch64', description: '64-bit ARM' },
      { label: 'i486', description: '32-bit x86 (emulator-class hardware)' },
    ],
    { placeHolder: 'Device architecture' },
  );
  return choice?.label as SfdkArch | undefined;
}

/** "Sailfish: Add Device" (FR-7.1). */
export function addDevice(services: Services, ctx: vscode.ExtensionContext) {
  return async (): Promise<void> => {
    const name = await services.prompts.showInputBox({ prompt: 'Device name', placeHolder: 'Xperia 10 IV' });
    if (!name) return;
    const host = await services.prompts.showInputBox({ prompt: 'Host (IP or hostname)', placeHolder: '192.168.50.125' });
    if (!host) return;
    const portStr = await services.prompts.showInputBox({
      prompt: 'SSH port',
      value: '22',
      validateInput: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? undefined : 'Enter a port 1-65535'),
    });
    if (!portStr) return;
    const user = await services.prompts.showInputBox({
      prompt: "Username (defaultuser on Sailfish OS >= 3.4.0; hint: use 'nemo' on older releases)",
      value: 'defaultuser',
    });
    if (!user) return;
    const architecture = await pickArchitecture(services);
    if (!architecture) return;

    const authChoice = await services.prompts.showQuickPick([GENERATE_KEY, USE_EXISTING_KEY], { placeHolder: 'Authentication' });
    if (!authChoice) return;

    let privateKeyFile: string | null = null;
    if (authChoice === GENERATE_KEY) {
      privateKeyFile = await generateKey(ctx, name);
      if (!privateKeyFile) {
        void services.prompts.showErrorMessage('Sailfish: ssh-keygen failed — is OpenSSH installed?');
        return;
      }
      openKeyPushTerminal(privateKeyFile, host, Number(portStr), user);
      const proceed = await services.prompts.showInformationMessage(
        `Type the device's Developer Mode password in the opened terminal to finish the key push, then come back here.`,
        CONTINUE,
        CANCEL,
      );
      if (proceed !== CONTINUE) return;
    } else {
      const uris = await services.prompts.showOpenDialog({ canSelectFiles: true, canSelectMany: false, openLabel: 'Select private key' });
      if (!uris?.[0]) return;
      privateKeyFile = uris[0].fsPath;
    }

    const resolved = resolveDevicesXmlPath(services.settings.get('devicesXmlPath'));
    if (!resolved.confirmed) {
      const confirm = await services.prompts.showWarningMessage(
        `Sailfish: no existing SDK devices.xml found. Create one at ${resolved.path}?`,
        CONFIRM_CREATE,
        CANCEL,
      );
      if (confirm !== CONFIRM_CREATE) return;
    }

    if (await conflictingProcessesRunning()) {
      const choice = await services.prompts.showWarningMessage(
        'Sailfish: Qt Creator or sfdk appears to be running and may overwrite this file.',
        WRITE_ANYWAY,
        CANCEL,
      );
      if (choice !== WRITE_ANYWAY) return;
    }

    const doc = readDevicesXmlFile(resolved.path);
    const answers: NewDeviceAnswers = { name, host, port: Number(portStr), user, architecture, privateKeyFile };
    const entry = buildNewDeviceEntry(answers, doc);
    doc.devices.push(entry);

    const nowIso = new Date().toISOString();
    const writeResult = writeDevicesXmlFile(resolved.path, doc, nowIso);

    const verified = await verifyDeviceRegistered(services, name);
    if (verified === false) {
      if (writeResult.backupPath) {
        fs.copyFileSync(writeResult.backupPath, resolved.path);
      }
      showFallbackDialog(services, serializeDevicesXml(doc, nowIso));
      return;
    }

    void services.prompts.showInformationMessage(
      verified === true
        ? `Sailfish: "${name}" registered and confirmed via \`sfdk device list\`.`
        : `Sailfish: "${name}" written to ${resolved.path} (no SDK available here to confirm via \`sfdk device list\`).`,
    );
    void vscode.commands.executeCommand('sailfish.devices.refresh');
  };
}

/** "Sailfish: Remove Device" (FR-7.9) — refuses autodetected (emulator) entries. */
export function removeDevice(services: Services) {
  return async (): Promise<void> => {
    const resolved = resolveDevicesXmlPath(services.settings.get('devicesXmlPath'));
    const doc = readDevicesXmlFile(resolved.path);
    const hardware = doc.devices.filter((d) => !d.autodetected);
    if (hardware.length === 0) {
      void services.prompts.showInformationMessage('Sailfish: no registered hardware devices to remove.');
      return;
    }
    const picked = await services.prompts.showQuickPick(
      hardware.map((d) => ({ label: d.name, description: d.host, index: d.index })),
      { placeHolder: 'Remove which device?' },
    );
    if (!picked) return;
    const confirm = await services.prompts.showWarningMessage(`Sailfish: remove "${picked.label}"?`, 'Remove', CANCEL);
    if (confirm !== 'Remove') return;

    if (await conflictingProcessesRunning()) {
      const choice = await services.prompts.showWarningMessage(
        'Sailfish: Qt Creator or sfdk appears to be running and may overwrite this file.',
        WRITE_ANYWAY,
        CANCEL,
      );
      if (choice !== WRITE_ANYWAY) return;
    }

    const updated = removeDeviceByIndex(doc, picked.index);
    writeDevicesXmlFile(resolved.path, updated, new Date().toISOString());
    void services.prompts.showInformationMessage(`Sailfish: removed "${picked.label}".`);
    void vscode.commands.executeCommand('sailfish.devices.refresh');
  };
}
