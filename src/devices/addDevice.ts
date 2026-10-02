import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { Services } from '../core/services';
import { resolveDevicesXmlPath } from './devicesXmlLocation';
import { readDevicesXmlFile, writeDevicesXmlFile, serializeDevicesXml } from './devicesXml';
import { buildNewDeviceEntry, removeDeviceByIndex, sanitizeForFilename, type NewDeviceAnswers } from './deviceWizard';
import { qtCreatorRunning, sfdkRunning } from './concurrencyGuard';
import { addEngineDevice, editEngineDevicesFile, engineHasDevice, findSharedConfigDir, removeEngineDevice } from './engineDevices';
import { parseDeviceRecords } from './listParsing';
import type { SfdkArch } from './devicesXmlConstants';
import { missingTools, installHint } from '../core/externalTools';
import { shQuote } from './shQuote';
import { ASKPASS_PASSWORD_ENV, ASKPASS_SCRIPT, buildKeyPushInvocation, classifyKeyPushFailure } from './keyPush';

const GENERATE_KEY = 'Generate new key (recommended)';
const USE_EXISTING_KEY = 'Use existing private key';
const WRITE_ANYWAY = 'Write anyway';
const CANCEL = 'Cancel';
const CONTINUE = 'Continue';
const USE_TERMINAL = 'Use terminal instead';
const KEY_PUSH_TIMEOUT_MS = 60_000;
const MAX_PASSWORD_ATTEMPTS = 3;
const CONFIRM_CREATE = 'Create devices.xml here';
const OPEN_QTC_INSTEAD = 'Register in Qt Creator instead';
const REVEAL_XML = 'Show attempted XML';
const QTC_DOCS_URL = 'https://docs.sailfishos.org/Tools/Sailfish_SDK/';

function execFileP(cmd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, (error, _stdout, stderr) => resolve({ ok: !error, stderr: stderr?.toString() ?? '' }));
  });
}

/** The build engine reads device keys only from its shared folder, so keys live in `<SharedConfig>/ssh/private_keys`. */
function engineKeyDir(sharedConfigDir: string): string {
  return path.join(sharedConfigDir, 'ssh', 'private_keys');
}

const QT_CREATOR_RUNNING_MESSAGE =
  'Sailfish: close Qt Creator first. While it runs it keeps its own copy of the SDK device list and rewrites the file, ' +
  'which would undo this change. Then run the command again.';

async function generateKey(dir: string, deviceName: string): Promise<string | null> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
 * terminal and lets the user type their own password there, matching the pattern already
 * validated end-to-end against real hardware for `connectWlan.ts` — the extension never
 * reads or holds the device password in memory either way, which is a stronger guarantee
 * than an in-memory ssh2 password (zeroed-after-use is still a window where it exists in
 * the process). No new dependency, no native-binding bundling risk.
 *
 * `ssh-copy-id` is run as a COMMAND typed into a real default-shell terminal, never as the
 * terminal's own `shellPath` — `ssh-copy-id` is a shell script that spawns its own `ssh`
 * subprocess internally, and VS Code's pty does not reliably negotiate a controlling
 * terminal when a script (rather than a real interactive binary like plain `ssh`) is made
 * the terminal's primary process; that previously caused an immediate, promptless launch
 * failure. Every interpolated value is single-quoted (shQuote) since host/user/port ultimately
 * come from user input and this command is typed into a real shell, unlike the rest of the
 * codebase's argv-array/`shell:false` spawns.
 */
function openKeyPushTerminal(keyPath: string, host: string, port: number, user: string): void {
  const terminal = vscode.window.createTerminal({ name: `SSH key push: ${user}@${host}` });
  terminal.show();
  const cmd = ['ssh-copy-id', '-i', shQuote(`${keyPath}.pub`), '-p', shQuote(String(port)), '--', shQuote(`${user}@${host}`)].join(' ');
  terminal.sendText(cmd, true);
}

function writeAskpassHelper(ctx: vscode.ExtensionContext): string {
  const dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'ssh').fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const helper = path.join(dir, 'askpass.sh');
  fs.writeFileSync(helper, ASKPASS_SCRIPT, { mode: 0o700 });
  fs.chmodSync(helper, 0o700);
  return helper;
}

function runKeyPush(
  invocation: { cmd: string; args: string[]; env: Record<string, string> },
  password: string,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      invocation.cmd,
      invocation.args,
      { env: { ...process.env, ...invocation.env, [ASKPASS_PASSWORD_ENV]: password }, timeout: KEY_PUSH_TIMEOUT_MS },
      (error, _stdout, stderr) => resolve({ ok: !error, stderr: stderr?.toString() ?? '' }),
    );
  });
}

/**
 * FR-7.8: asks for the Developer Mode password in a masked input box and pushes the key in the
 * background via SSH_ASKPASS (see keyPush.ts). Wrong passwords re-prompt; anything unexpected
 * offers the interactive terminal fallback. Returns whether the key is now installed.
 */
async function pushKeyInApp(
  services: Services,
  ctx: vscode.ExtensionContext,
  keyPath: string,
  host: string,
  port: number,
  user: string,
): Promise<boolean> {
  const invocation = buildKeyPushInvocation({
    pubKeyPath: `${keyPath}.pub`,
    host,
    port,
    user,
    askpassPath: writeAskpassHelper(ctx),
    display: process.env.DISPLAY,
  });
  let prompt = `Developer Mode password for ${user}@${host} (Settings → Developer tools on the device)`;
  for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt++) {
    const password = await services.prompts.showInputBox({ prompt, password: true, ignoreFocusOut: true });
    if (password === undefined) return false;

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Sailfish: installing SSH key on ${host}…` },
      () => runKeyPush(invocation, password),
    );
    if (result.ok) {
      services.output.log('info', `devices: SSH key installed on ${user}@${host}:${port}`);
      return true;
    }

    const failure = classifyKeyPushFailure(result.stderr);
    services.output.log('warn', `devices: ssh-copy-id to ${user}@${host}:${port} failed (${failure}): ${result.stderr.trim()}`);
    if (failure === 'auth') {
      prompt = `Wrong password for ${user}@${host}, try again (attempt ${attempt + 1} of ${MAX_PASSWORD_ATTEMPTS})`;
      continue;
    }
    if (failure === 'unreachable') {
      void services.prompts.showErrorMessage(
        `Sailfish: cannot reach ${host}:${port}. Check the USB/WLAN connection and that Developer Mode is on.`,
      );
      return false;
    }
    return pushKeyInTerminal(services, keyPath, host, port, user, `Sailfish: installing the SSH key failed: ${result.stderr.trim().split(/\r?\n/).pop() ?? ''}`);
  }
  void services.prompts.showErrorMessage(`Sailfish: wrong password ${MAX_PASSWORD_ATTEMPTS} times; the device was not added.`);
  return false;
}

/** Fallback when the background push fails for a reason other than a wrong password or an unreachable device. */
async function pushKeyInTerminal(
  services: Services,
  keyPath: string,
  host: string,
  port: number,
  user: string,
  reason: string,
): Promise<boolean> {
  const choice = await services.prompts.showWarningMessage(reason, USE_TERMINAL, CANCEL);
  if (choice !== USE_TERMINAL) return false;
  openKeyPushTerminal(keyPath, host, port, user);
  const proceed = await services.prompts.showInformationMessage(
    `Type the device's Developer Mode password in the opened terminal to finish the key push, then come back here.`,
    { modal: true },
    CONTINUE,
  );
  return proceed === CONTINUE;
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
    if (await qtCreatorRunning()) {
      void services.prompts.showErrorMessage(QT_CREATOR_RUNNING_MESSAGE);
      return;
    }
    const resolved = resolveDevicesXmlPath(services.settings.get('devicesXmlPath'));
    const sharedConfig = findSharedConfigDir(path.dirname(resolved.path), services.sdk.current()?.root);
    if (!sharedConfig) {
      void services.prompts.showErrorMessage(
        "Sailfish: could not find the build engine's shared folder (SharedConfig in buildengines.xml, usually ~/SailfishOS/vmshare). Is the SDK installed?",
      );
      return;
    }

    const existingNames = new Set(readDevicesXmlFile(resolved.path).devices.map((d) => d.name));
    const name = await services.prompts.showInputBox({
      prompt: 'Device name',
      placeHolder: 'Jolla Phone',
      validateInput: (v) =>
        !v.trim() ? 'Enter a name' : existingNames.has(v) ? `"${v}" is already registered; remove it first or pick another name` : undefined,
    });
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
      const missing = await missingTools(['ssh-keygen', 'ssh-copy-id']);
      if (missing.length > 0) {
        const hints = missing.map((tool) => `• ${installHint(tool, process.platform)}`).join('\n');
        void services.prompts.showErrorMessage(`Sailfish: missing required tool(s):\n${hints}`);
        return;
      }
      privateKeyFile = await generateKey(engineKeyDir(sharedConfig), name);
      if (!privateKeyFile) {
        void services.prompts.showErrorMessage('Sailfish: ssh-keygen failed unexpectedly.');
        return;
      }
      if (!(await pushKeyInApp(services, ctx, privateKeyFile, host, Number(portStr), user))) return;
    } else {
      const uris = await services.prompts.showOpenDialog({ canSelectFiles: true, canSelectMany: false, openLabel: 'Select private key' });
      if (!uris?.[0]) return;
      // Copy it where the build engine can read it.
      const copy = path.join(engineKeyDir(sharedConfig), sanitizeForFilename(name));
      fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
      fs.copyFileSync(uris[0].fsPath, copy);
      fs.chmodSync(copy, 0o600);
      privateKeyFile = copy;
    }

    if (!resolved.confirmed) {
      const confirm = await services.prompts.showWarningMessage(
        `Sailfish: no existing SDK devices.xml found. Create one at ${resolved.path}?`,
        CONFIRM_CREATE,
        CANCEL,
      );
      if (confirm !== CONFIRM_CREATE) return;
    }

    if (await qtCreatorRunning()) {
      void services.prompts.showErrorMessage(QT_CREATOR_RUNNING_MESSAGE);
      return;
    }
    if (await sfdkRunning()) {
      const choice = await services.prompts.showWarningMessage(
        'Sailfish: an sfdk command is running and may rewrite the SDK device list.',
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
    const engineBackup = editEngineDevicesFile(sharedConfig, (xml) =>
      addEngineDevice(xml, {
        name,
        host,
        port: Number(portStr),
        user,
        keyPath: path.relative(sharedConfig, privateKeyFile),
      }),
    );

    const verified = await verifyDeviceRegistered(services, name);
    if (verified === false) {
      if (writeResult.backupPath) {
        fs.copyFileSync(writeResult.backupPath, resolved.path);
      }
      if (engineBackup) {
        fs.copyFileSync(engineBackup, path.join(sharedConfig, 'devices.xml'));
      }
      showFallbackDialog(services, serializeDevicesXml(doc, nowIso));
      return;
    }

    if (!engineHasDevice(sharedConfig, name)) {
      void services.prompts.showWarningMessage(
        `Sailfish: "${name}" could not be added to the build engine's device list (${path.join(sharedConfig, 'devices.xml')}), so deploying to it may fail with "not a known device".`,
      );
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

    if (await qtCreatorRunning()) {
      void services.prompts.showErrorMessage(QT_CREATOR_RUNNING_MESSAGE);
      return;
    }
    if (await sfdkRunning()) {
      const choice = await services.prompts.showWarningMessage(
        'Sailfish: an sfdk command is running and may rewrite the SDK device list.',
        WRITE_ANYWAY,
        CANCEL,
      );
      if (choice !== WRITE_ANYWAY) return;
    }

    const updated = removeDeviceByIndex(doc, picked.index);
    writeDevicesXmlFile(resolved.path, updated, new Date().toISOString());
    const sharedConfig = findSharedConfigDir(path.dirname(resolved.path), services.sdk.current()?.root);
    if (sharedConfig) {
      editEngineDevicesFile(sharedConfig, (xml) => removeEngineDevice(xml, picked.label));
    }
    void services.prompts.showInformationMessage(`Sailfish: removed "${picked.label}".`);
    void vscode.commands.executeCommand('sailfish.devices.refresh');
  };
}
