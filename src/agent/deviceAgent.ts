import { deviceSessions } from '../core/deviceSessions';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Services } from '../core/services';
import { NO_TIMEOUT, type SfdkResult } from '../sfdk/runner';
import { deviceFrom } from '../devices/commands';
import { runAsRootOnDevice } from '../devices/devicePackages';
import { sfdkDeviceName } from '../devices/listParsing';
import {
  AGENT_ARCHES,
  AGENT_BINARY,
  AGENT_PACKAGE,
  AGENT_REMOTE_RPM,
  COPY_SCRIPT,
  INSTALL_SCRIPT,
  UNINSTALL_SCRIPT,
  archFromOutput,
  archFromRpmQuery,
  classifyPing,
  clientName,
  decodeBase64Output,
  describeAgentRefusal,
  describeProbe,
  installConsentDetail,
  isPng,
  isScreenshotPath,
  parseAgentReply,
  phoneRefusal,
  pickAgentRpm,
  screenshotFileName,
  type AgentArch,
  type AgentProbe,
} from './agentCore';
import { agentUpdateNotice, agentUpdateAvailable, bundledAgentVersion } from './mirrorCore';
import { activateMirror } from './mirror';

/**
 * The on-device developer agent (device-agent/): install, uninstall, status, screenshots and
 * live logs. Every request goes through `sfdk device exec -- sailfish-devagent --request <cmd>`,
 * i.e. the SSH login the SDK already has; the agent itself listens on a local socket only.
 */

const INSTALL_AGENT = 'Install Device Agent';
export const UPDATE_AGENT = 'Update Device Agent';
/** Devices already told about an update in this session. */
const updateOffered = new Set<string>();
const REVEAL = 'Reveal in folder';
const STOP = 'Stop';
const LOG_CHANNEL_NAME = 'Sailfish Device Log';
const LAST_FOLDER_KEY = 'sailfish.agent.lastScreenshotFolder';
const LOG_LINES = 200;
const REQUEST_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;
const COPY_TIMEOUT_MS = 120_000;
const ROOT_TIMEOUT_MS = 5 * 60 * 1000;

/** `--client <host>` for the agent's log request (shown on the phone as "VS Code on <host>"); nothing when the name is empty. */
function clientArgs(): string[] {
  // `sfdk device exec` hands its words to a remote shell, which would split a space: none is sent.
  const name = clientName(os.hostname()).replace(/ /g, '-');
  return name ? ['--client', name] : [];
}

/** The device from a Devices-view item, else the workspace's `sailfish.device`. */
function resolveDevice(services: Services, item: unknown): string | undefined {
  const fromItem = deviceFrom(item);
  if (fromItem) return sfdkDeviceName(fromItem);
  return services.settings.get('device', vscode.workspace.workspaceFolders?.[0]?.uri) || undefined;
}

export function requireDevice(services: Services, item: unknown): string | undefined {
  const device = resolveDevice(services, item);
  if (!device) {
    void services.prompts.showWarningMessage('Sailfish: select a device first (status bar or Devices view).');
  }
  return device;
}

function request(services: Services, device: string, cmd: 'ping' | 'screenshot', token?: vscode.CancellationToken): Promise<SfdkResult> {
  return services.runner.run({
    args: ['device', 'exec', '--', AGENT_BINARY, '--request', cmd],
    device,
    timeoutMs: REQUEST_TIMEOUT_MS,
    token,
  });
}

export async function probe(services: Services, device: string, token?: vscode.CancellationToken): Promise<AgentProbe> {
  return classifyPing(await request(services, device, 'ping', token));
}

/** The agent version shipped in `media/agent/*`, from the RPM file names; undefined when none ship. */
export async function bundledAgentVersionOf(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  const names: string[] = [];
  for (const arch of AGENT_ARCHES) {
    try {
      names.push(...(await fs.readdir(path.join(ctx.extensionPath, 'media', 'agent', arch))));
    } catch {
      // an architecture without a directory ships nothing
    }
  }
  return bundledAgentVersion(names);
}

/** The bundled version when the running agent is older than it, else undefined. */
export async function newerBundledAgent(ctx: vscode.ExtensionContext, probeState: AgentProbe): Promise<string | undefined> {
  if (probeState.state !== 'running') return undefined;
  const bundled = await bundledAgentVersionOf(ctx);
  return agentUpdateAvailable(probeState.version, bundled) ? bundled : undefined;
}

/**
 * Agent installs and updates, for open streams (the mirror): `installing` just before the root step,
 * which restarts the agent and so ends its streams; `done` afterwards, with the agent's ping answer,
 * or without one when the install was cancelled or failed.
 */
export type AgentInstallEvent =
  | { device: string; phase: 'installing' }
  | { device: string; phase: 'done'; probe?: AgentProbe };
const installEvents = new vscode.EventEmitter<AgentInstallEvent>();
export const onAgentInstall = installEvents.event;

/**
 * Non-modal "update available" notification, once per device per session. The action
 * runs the install flow (which reports through `onAgentInstall`). Not awaited by callers that must not block.
 */
export async function offerAgentUpdate(
  ctx: vscode.ExtensionContext,
  services: Services,
  device: string,
  probeState: AgentProbe,
): Promise<void> {
  if (probeState.state !== 'running') return;
  if (updateOffered.has(device)) return;
  const bundled = await newerBundledAgent(ctx, probeState);
  if (!bundled) return;
  updateOffered.add(device);
  const choice = await services.prompts.showInformationMessage(agentUpdateNotice(device, probeState.version, bundled), UPDATE_AGENT);
  if (choice !== UPDATE_AGENT) return;
  await installAgentOn(ctx, services, device);
}

/**
 * True when the agent is running with Developer Mode on. Otherwise explains, offers the install
 * when the agent is missing, and returns false.
 */
export async function ensureAgent(
  ctx: vscode.ExtensionContext,
  services: Services,
  device: string,
  need?: 'screenView' | 'logs',
): Promise<boolean> {
  const state = await probe(services, device);
  if (state.state === 'running' && state.developerMode) {
    // The phone's own settings win: say so before asking for something it will refuse.
    const refusal = need ? phoneRefusal(state, need) : undefined;
    if (refusal) {
      void services.prompts.showErrorMessage(`Sailfish: "${device}": ${refusal}`);
      return false;
    }
    return true;
  }
  if (state.state === 'not-installed' || state.state === 'not-running') {
    const choice = await services.prompts.showWarningMessage(
      `${describeProbe(device, state)} Screenshots and device logs need it.`,
      INSTALL_AGENT,
    );
    if (choice === INSTALL_AGENT) {
      return installAgentOn(ctx, services, device);
    }
    return false;
  }
  void services.prompts.showErrorMessage(
    state.state === 'running'
      ? `Sailfish: Developer Mode is off on "${device}", so the device agent refuses screenshots and logs. Turn it on in Settings → Developer tools.`
      : describeProbe(device, state),
  );
  return false;
}

/** The agent RPM architecture from `uname -m`; an error message when it cannot be told or is not supported. */
async function detectArch(
  services: Services,
  device: string,
  token: vscode.CancellationToken,
): Promise<{ arch: AgentArch } | { error: string }> {
  // The installed rpm package's arch is the userland's; uname -m (the kernel's) is only the fallback.
  const rpmQuery = await services.runner.run({ args: ['device', 'exec', '--', 'rpm', '-q', 'rpm'], device, timeoutMs: REQUEST_TIMEOUT_MS, token });
  const fromRpm = rpmQuery.exitCode === 0 ? archFromRpmQuery(rpmQuery.stdout) : undefined;
  if (fromRpm) return { arch: fromRpm };
  const uname = await services.runner.run({ args: ['device', 'exec', '--', 'uname', '-m'], device, timeoutMs: REQUEST_TIMEOUT_MS, token });
  if (uname.exitCode !== 0) {
    return { error: `Sailfish: could not tell the architecture of "${device}" (see the Sailfish OS output).` };
  }
  const arch = archFromOutput(uname.stdout);
  if (!arch) {
    const machine = uname.stdout.trim().split(/\r?\n/)[0] || 'unknown';
    return {
      error: `Sailfish: the device agent does not support the architecture of "${device}" (${machine}); supported: ${AGENT_ARCHES.join(', ')}.`,
    };
  }
  return { arch };
}

/** Copies the RPM as base64 over the `device exec` stdin (no scp, no second channel) and checks its size on the device. */
async function copyRpm(services: Services, device: string, rpmPath: string, token: vscode.CancellationToken): Promise<boolean> {
  const bytes = await fs.readFile(rpmPath);
  const result = await services.runner.run({
    args: ['device', 'exec', '--', 'sh', '-c', COPY_SCRIPT, 'sh', AGENT_REMOTE_RPM, String(bytes.length)],
    device,
    stdin: bytes.toString('base64'),
    timeoutMs: COPY_TIMEOUT_MS,
    token,
  });
  return result.exitCode === 0;
}

/**
 * The install itself: consent, architecture, copy, `devel-su rpm -U` (one password prompt), then a ping.
 * The root step and its outcome are announced through `onAgentInstall`.
 */
export async function installAgentOn(ctx: vscode.ExtensionContext, services: Services, device: string): Promise<boolean> {
  const consent = await services.prompts.showWarningMessage(
    `Sailfish: install the device agent on "${device}"?`,
    { modal: true, detail: installConsentDetail(device) },
    INSTALL_AGENT,
  );
  if (consent !== INSTALL_AGENT) return false;

  const prepared = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Sailfish: preparing the device agent for "${device}"…`, cancellable: true },
    async (progress, token): Promise<boolean> => {
      progress.report({ message: 'checking the architecture…' });
      const detected = await detectArch(services, device, token);
      if (token.isCancellationRequested) return false;
      if ('error' in detected) {
        void services.prompts.showErrorMessage(detected.error);
        return false;
      }
      const { arch } = detected;
      const dir = path.join(ctx.extensionPath, 'media', 'agent', arch);
      let files: string[] = [];
      try {
        files = await fs.readdir(dir);
      } catch {
        files = [];
      }
      const rpm = pickAgentRpm(arch, files);
      if (!rpm) {
        void services.prompts.showErrorMessage(`Sailfish: this extension build ships no ${AGENT_PACKAGE} RPM for ${arch} (expected in ${dir}).`);
        return false;
      }
      progress.report({ message: `copying ${rpm}…` });
      if (!(await copyRpm(services, device, path.join(dir, rpm), token))) {
        if (!token.isCancellationRequested) {
          void services.prompts.showErrorMessage(`Sailfish: copying ${rpm} to "${device}" failed (see the Sailfish OS output).`);
        }
        return false;
      }
      return true;
    },
  );
  if (!prepared) return false;

  installEvents.fire({ device, phase: 'installing' });
  const exitCode = await runAsRootOnDevice(services, device, {
    title: `Install the device agent on "${device}"`,
    prompt: 'Developer-mode password of the device (Settings → Developer tools).',
    progressTitle: `Sailfish: installing the device agent on "${device}"…`,
    script: INSTALL_SCRIPT,
    timeoutMs: ROOT_TIMEOUT_MS,
  });
  if (exitCode !== 0) installEvents.fire({ device, phase: 'done' });
  if (exitCode === undefined) return false;
  if (exitCode !== 0) {
    void services.prompts.showErrorMessage(
      `Sailfish: installing the device agent on "${device}" failed (exit ${exitCode}). Check the password, and the Sailfish OS output channel for rpm's message.`,
    );
    return false;
  }

  const state = await probe(services, device);
  installEvents.fire({ device, phase: 'done', probe: state });
  if (state.state === 'running') {
    void services.prompts.showInformationMessage(describeProbe(device, state));
    return state.developerMode;
  }
  void services.prompts.showErrorMessage(`${describeProbe(device, state)} The package was installed, but the service did not answer.`);
  return false;
}

function installAgent(ctx: vscode.ExtensionContext, services: Services) {
  return async (item?: unknown): Promise<void> => {
    const device = requireDevice(services, item);
    if (!device) return;
    await installAgentOn(ctx, services, device);
  };
}

function uninstallAgent(services: Services) {
  return async (item?: unknown): Promise<void> => {
    const device = requireDevice(services, item);
    if (!device) return;
    const exitCode = await runAsRootOnDevice(services, device, {
      title: `Uninstall the device agent from "${device}"`,
      prompt: 'Developer-mode password of the device (Settings → Developer tools).',
      progressTitle: `Sailfish: uninstalling the device agent from "${device}"…`,
      script: UNINSTALL_SCRIPT,
      timeoutMs: ROOT_TIMEOUT_MS,
    });
    if (exitCode === undefined) return;
    if (exitCode === 0) {
      void services.prompts.showInformationMessage(`Sailfish: the device agent was removed from "${device}".`);
    } else {
      void services.prompts.showErrorMessage(
        `Sailfish: removing the device agent from "${device}" failed (exit ${exitCode}). Check the password, and the Sailfish OS output channel for rpm's message.`,
      );
    }
  };
}

function agentStatus(ctx: vscode.ExtensionContext, services: Services) {
  return async (item?: unknown): Promise<void> => {
    const device = requireDevice(services, item);
    if (!device) return;
    const state = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Sailfish: asking the device agent on "${device}"…`, cancellable: true },
      (_progress, token) => probe(services, device, token),
    );
    const bundled = await newerBundledAgent(ctx, state);
    if (state.state === 'running' && bundled) {
      updateOffered.add(device);
      const message = `${describeProbe(device, state)} ${agentUpdateNotice(device, state.version, bundled).replace(/^Sailfish: /, 'Update available: ')}`;
      void services.prompts.showInformationMessage(message, UPDATE_AGENT).then((choice) => {
        if (choice === UPDATE_AGENT) void installAgentOn(ctx, services, device);
      });
      return;
    }
    const message = describeProbe(device, state);
    void (state.state === 'running' ? services.prompts.showInformationMessage(message) : services.prompts.showWarningMessage(message));
  };
}

/** Asks the agent for a screenshot, fetches it as base64 (no pty: a terminal would mangle the bytes) and deletes it on the device. */
async function captureScreenshot(services: Services, device: string, token: vscode.CancellationToken): Promise<Buffer | undefined> {
  const shot = await request(services, device, 'screenshot', token);
  const reply = parseAgentReply(shot.stdout);
  if (shot.exitCode !== 0 || !reply?.ok || !reply.path) {
    if (!token.isCancellationRequested) {
      void services.prompts.showErrorMessage(`Sailfish: the device agent could not take a screenshot: ${reply?.error ? describeAgentRefusal(reply.error) : shot.stderr.trim() || `exit ${shot.exitCode}`}`);
    }
    return undefined;
  }
  if (!isScreenshotPath(reply.path)) {
    services.output.log('error', `device agent returned an unexpected screenshot path: ${reply.path}`);
    void services.prompts.showErrorMessage('Sailfish: the device agent returned an unexpected screenshot path (see the Sailfish OS output).');
    return undefined;
  }
  try {
    const fetched = await services.runner.run({ args: ['device', 'exec', '--', 'base64', reply.path], device, timeoutMs: FETCH_TIMEOUT_MS, token });
    if (fetched.exitCode !== 0) {
      if (!token.isCancellationRequested) {
        void services.prompts.showErrorMessage(`Sailfish: fetching the screenshot from "${device}" failed (see the Sailfish OS output).`);
      }
      return undefined;
    }
    const png = decodeBase64Output(fetched.stdout);
    if (!isPng(png)) {
      void services.prompts.showErrorMessage(`Sailfish: the screenshot fetched from "${device}" is not a PNG file.`);
      return undefined;
    }
    return png;
  } finally {
    // Always, even after a cancel or a bad transfer: the phone must not accumulate screenshots.
    await services.runner.run({ args: ['device', 'exec', '--', 'rm', '-f', reply.path], device, timeoutMs: REQUEST_TIMEOUT_MS });
  }
}

function defaultScreenshotFolder(ctx: vscode.ExtensionContext): string {
  const remembered = ctx.globalState.get<string>(LAST_FOLDER_KEY);
  if (remembered) return remembered;
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

function takeScreenshot(ctx: vscode.ExtensionContext, services: Services) {
  return async (item?: unknown): Promise<void> => {
    const device = requireDevice(services, item);
    if (!device) return;
    if (!(await ensureAgent(ctx, services, device, 'screenView'))) return;

    const png = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Sailfish: taking a screenshot of "${device}"…`, cancellable: true },
      (_progress, token) => captureScreenshot(services, device, token),
    );
    if (!png) return;

    const defaultUri = vscode.Uri.file(path.join(defaultScreenshotFolder(ctx), screenshotFileName(device, new Date())));
    const target = await services.prompts.showSaveDialog({
      defaultUri,
      filters: { 'PNG image': ['png'] },
      saveLabel: 'Save screenshot',
      title: 'Save device screenshot',
    });
    if (!target) return;

    try {
      await fs.writeFile(target.fsPath, png);
    } catch (err) {
      void services.prompts.showErrorMessage(
        `Sailfish: could not save the screenshot to ${target.fsPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    await ctx.globalState.update(LAST_FOLDER_KEY, path.dirname(target.fsPath));
    await vscode.commands.executeCommand('vscode.open', target);
    void services.prompts.showInformationMessage(`Sailfish: screenshot saved to ${target.fsPath}`, REVEAL).then((choice) => {
      if (choice === REVEAL) void vscode.commands.executeCommand('revealFileInOS', target);
    });
  };
}

interface LogSession {
  device: string;
  cts: vscode.CancellationTokenSource;
}

/** Streams `journalctl -f` from the agent into an output channel until stopped (notification "Cancel", or "Stop"). */
function showLogs(ctx: vscode.ExtensionContext, services: Services) {
  let channel: vscode.OutputChannel | undefined;
  let session: LogSession | undefined;
  const getChannel = (): vscode.OutputChannel => {
    if (!channel) {
      channel = vscode.window.createOutputChannel(LOG_CHANNEL_NAME);
      ctx.subscriptions.push(channel);
    }
    return channel;
  };

  return async (item?: unknown): Promise<void> => {
    if (session) {
      getChannel().show(true);
      const current = session;
      const choice = await services.prompts.showInformationMessage(`Sailfish: device logs are already streaming from "${current.device}".`, STOP);
      if (choice === STOP) current.cts.cancel();
      return;
    }
    const device = requireDevice(services, item);
    if (!device) return;
    if (!(await ensureAgent(ctx, services, device, 'logs'))) return;

    const out = getChannel();
    out.clear();
    out.appendLine(`[streaming journalctl from "${device}"; cancel the notification to stop]`);
    out.show(true);
    const cts = new vscode.CancellationTokenSource();
    session = { device, cts };
    const registration = deviceSessions.register(device, 'logs', 'device logs', () => {
      cts.cancel();
      return Promise.resolve();
    });
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Sailfish: streaming device logs from "${device}"`, cancellable: true },
      async (_progress, token) => {
        token.onCancellationRequested(() => cts.cancel());
        // The stream is endless, so the runner keeps no output (collectOutput: false); only the
        // last line of each stream is kept, for the error message when it ends badly.
        let lastStdout = '';
        let lastStderr = '';
        try {
          const result = await services.runner.run({
            args: ['device', 'exec', '--', AGENT_BINARY, '--request', 'logs', '--lines', String(LOG_LINES), ...clientArgs()],
            device,
            timeoutMs: NO_TIMEOUT,
            token: cts.token,
            collectOutput: false,
            onLine: (line, stream) => {
              if (stream === 'stdout') {
                out.appendLine(line);
                if (line.trim()) lastStdout = line;
              } else if (line.trim()) {
                lastStderr = line.trim();
              }
            },
          });
          if (result.cancelled) {
            out.appendLine('[stopped]');
          } else {
            out.appendLine(`[log stream ended (exit ${result.exitCode})]`);
            // The agent ends a stream with {"ok":false,"error":…} when the phone stops or forbids it
            // (also with exit 0 when it ends a running stream), so the last line is looked at first.
            const reply = parseAgentReply(lastStdout);
            if (reply && !reply.ok && reply.error) {
              out.appendLine(`[${describeAgentRefusal(reply.error)}]`);
              void services.prompts.showErrorMessage(`Sailfish: device logs from "${device}" stopped: ${describeAgentRefusal(reply.error)}`);
            } else if (result.exitCode !== 0) {
              void services.prompts.showErrorMessage(`Sailfish: device logs from "${device}" stopped: ${lastStderr || `exit ${result.exitCode}`}`);
            }
          }
        } finally {
          registration.dispose();
          session = undefined;
          cts.dispose();
        }
      },
    );
  };
}

export function activateDeviceAgent(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sailfish.agent.install', installAgent(ctx, services)),
    vscode.commands.registerCommand('sailfish.agent.uninstall', uninstallAgent(services)),
    vscode.commands.registerCommand('sailfish.agent.status', agentStatus(ctx, services)),
    vscode.commands.registerCommand('sailfish.agent.screenshot', takeScreenshot(ctx, services)),
    vscode.commands.registerCommand('sailfish.agent.logs', showLogs(ctx, services)),
  );
  activateMirror(ctx, services);
}
