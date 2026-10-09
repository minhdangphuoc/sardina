import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Services } from '../core/services';
import type { SfdkResult } from '../sfdk/runner';
import { deviceFrom } from '../devices/commands';
import { runAsRootOnDevice } from '../devices/devicePackages';
import { ensureDeviceOnline } from '../devices/offlineGuard';
import { sfdkDeviceName } from '../devices/listParsing';
import {
  AGENT_ARCHES,
  AGENT_BINARY,
  AGENT_COPY_NAMES,
  AGENT_MODULES,
  AGENT_PACKAGE,
  COPY_SCRIPT,
  INSTALL_SCRIPT,
  REMOVE_COPY_SCRIPT,
  archFromOutput,
  archFromRpmQuery,
  classifyPing,
  clientName,
  decodeBase64Output,
  describeAgentRefusal,
  describeProbe,
  hasModule,
  installConsentDetail,
  installedModules,
  MODULE_PICK_DETAIL,
  isPng,
  isScreenshotPath,
  parseAgentReply,
  phoneRefusal,
  pickAgentRpms,
  screenshotFileName,
  withRequiredModules,
  type AgentArch,
  type AgentModule,
  type AgentNeed,
  type AgentPart,
  type AgentProbe,
} from './agentCore';
import { agentUpdateNotice, agentUpdateAvailable, bundledAgentVersion } from './mirrorCore';
import { activateMirror } from './mirror';
import { activateDeviceLog, deviceLog } from '../monitor/deviceLog';
import {
  AGENT_SESSION_KINDS,
  CLEANUP_ARGS,
  CLEANUP_SCRIPT,
  RESTART_HOME_SCREEN_ARGV,
  restartHomeScreenAsk,
  restartHomeScreenConfirm,
  UNINSTALL_SCRIPT,
  modulesToErase,
  parseCleanupReport,
  sessionKindsOf,
  uninstallModulesScript,
  uninstallSummary,
} from './uninstallCore';
import { deviceSessions, listLabels, type DeviceSessionKind } from '../core/deviceSessions';

/**
 * The on-device developer agent (device-agent/): install, uninstall, status, screenshots and
 * live logs. Every request goes through `sfdk device exec -- sailfish-devagent --request <cmd>`,
 * i.e. the SSH login the SDK already has; the agent itself listens on a local socket only.
 */

const INSTALL_AGENT = 'Install Device Agent';
const REMOVE_ALL = 'Device agent and all modules';
type RunningProbe = Extract<AgentProbe, { state: 'running' }>;

/** What features need from the agent, for `ensureAgentProbe`. */
export const NEED = {
  screenshot: { module: 'screenshot', setting: 'screenView', feature: 'Screenshots' },
  mirror: { module: 'mirror', setting: 'screenView', feature: 'The screen mirror' },
  logs: { module: 'logs', setting: 'logs', feature: 'Device logs' },
} as const satisfies Record<string, AgentNeed>;
export const UPDATE_AGENT = 'Update Device Agent';
/** Devices already told about an update in this session. */
const updateOffered = new Set<string>();
const REVEAL = 'Reveal in folder';
/** Offered after an install or removal, never run without a confirmation (restartHomeScreen). */
const RESTART_HOME_SCREEN = 'Restart Home Screen';
const LAST_FOLDER_KEY = 'sardina.agent.lastScreenshotFolder';
const REQUEST_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;
const COPY_TIMEOUT_MS = 120_000;
const ROOT_TIMEOUT_MS = 5 * 60 * 1000;

/** `--client <host>` for the agent's log request (shown on the phone as "VS Code on <host>"); nothing when the name is empty. */
export function clientArgs(): string[] {
  // `sfdk device exec` hands its words to a remote shell, which would split a space: none is sent.
  const name = clientName(os.hostname()).replace(/ /g, '-');
  return name ? ['--client', name] : [];
}

/** The device from a Devices-view item, else the workspace's `sardina.device`. */
function resolveDevice(services: Services, item: unknown): string | undefined {
  const fromItem = deviceFrom(item);
  if (fromItem) return sfdkDeviceName(fromItem);
  return services.settings.get('device', vscode.workspace.workspaceFolders?.[0]?.uri) || undefined;
}

export function requireDevice(services: Services, item: unknown): string | undefined {
  const device = resolveDevice(services, item);
  if (!device) {
    void services.prompts.showWarningMessage('Sardina: select a device first (status bar or Devices view).');
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
  await updateAgentOn(ctx, services, device, probeState);
}

/**
 * The agent's probe when it is running with Developer Mode on, has the module `need` names and the
 * phone allows it. Otherwise explains, offers the install of what is missing (one prompt, one
 * password) and returns undefined. `known` is a ping the caller already made.
 */
export async function ensureAgentProbe(
  ctx: vscode.ExtensionContext,
  services: Services,
  device: string,
  need: AgentNeed,
  known?: AgentProbe,
): Promise<AgentProbe | undefined> {
  const state = known ?? (await probe(services, device));
  if (state.state === 'running' && state.developerMode) {
    if (!hasModule(state, need.module)) {
      return offerInstall(ctx, services, device, need, `Sardina: ${need.feature} needs the ${need.module} module of the device agent on "${device}".`, [need.module], false);
    }
    // The phone's own settings win: say so before asking for something it will refuse.
    const refusal = need.setting ? phoneRefusal(state, need.setting) : undefined;
    if (refusal) {
      void services.prompts.showErrorMessage(`Sardina: "${device}": ${refusal}`);
      return undefined;
    }
    return state;
  }
  if (state.state === 'not-installed' || state.state === 'not-running') {
    const message = `${describeProbe(device, state)} ${need.feature} needs it with the ${need.module} module.`;
    return offerInstall(ctx, services, device, need, message, [need.module], true);
  }
  void services.prompts.showErrorMessage(
    state.state === 'running'
      ? `Sardina: Developer Mode is off on "${device}", so the device agent refuses requests. Turn it on in Settings → Developer tools.`
      : describeProbe(device, state),
  );
  return undefined;
}

/** The prompt is the consent step: it names what the added modules can do. Returns the agent's new probe when it has the module. */
async function offerInstall(
  ctx: vscode.ExtensionContext,
  services: Services,
  device: string,
  need: AgentNeed,
  message: string,
  modules: readonly AgentModule[],
  withCore: boolean,
): Promise<AgentProbe | undefined> {
  const choice = await services.prompts.showWarningMessage(
    message,
    { modal: true, detail: installConsentDetail(device, modules) },
    INSTALL_AGENT,
  );
  if (choice !== INSTALL_AGENT) return undefined;
  const parts: AgentPart[] = withCore ? ['core', ...modules] : [...modules];
  if (!(await installAgentOn(ctx, services, device, parts, true))) return undefined;
  const after = await probe(services, device);
  return hasModule(after, need.module) ? after : undefined;
}

/** True when `ensureAgentProbe` found a usable agent. */
export async function ensureAgent(ctx: vscode.ExtensionContext, services: Services, device: string, need: AgentNeed): Promise<boolean> {
  return (await ensureAgentProbe(ctx, services, device, need)) !== undefined;
}

/** The agent RPM architecture from `uname -m`; an error message when it cannot be told or is not supported. */
export async function detectArch(
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
    return { error: `Sardina: could not tell the architecture of "${device}" (see the Sardina output).` };
  }
  const arch = archFromOutput(uname.stdout);
  if (!arch) {
    const machine = uname.stdout.trim().split(/\r?\n/)[0] || 'unknown';
    return {
      error: `Sardina: the device agent does not support the architecture of "${device}" (${machine}); supported: ${AGENT_ARCHES.join(', ')}.`,
    };
  }
  return { arch };
}

/** Copies the RPM as base64 over the `device exec` stdin (no scp, no second channel) into `~/.cache/sailfish-tools` and checks its size on the device. */
async function copyRpm(services: Services, device: string, rpmPath: string, copyName: string, token: vscode.CancellationToken): Promise<boolean> {
  const bytes = await fs.readFile(rpmPath);
  const result = await services.runner.run({
    args: ['device', 'exec', '--', 'sh', '-c', COPY_SCRIPT, 'sh', copyName, String(bytes.length)],
    device,
    stdin: bytes.toString('base64'),
    timeoutMs: COPY_TIMEOUT_MS,
    token,
  });
  return result.exitCode === 0;
}

function removeCopies(services: Services, device: string): Promise<SfdkResult> {
  return services.runner.run({ args: ['device', 'exec', '--', 'sh', '-c', REMOVE_COPY_SCRIPT, 'sh', ...AGENT_COPY_NAMES], device, timeoutMs: REQUEST_TIMEOUT_MS });
}

/** The update: the core and the modules already there (a 1.10.x agent has them all). */
export function updateAgentOn(ctx: vscode.ExtensionContext, services: Services, device: string, state: RunningProbe): Promise<boolean> {
  return installAgentOn(ctx, services, device, ['core', ...installedModules(state)]);
}

/**
 * The install itself: consent (unless the caller asked it already), architecture, copy of the RPMs
 * of `parts`, `devel-su rpm -U` (one password prompt), then a ping. The root step and its outcome
 * are announced through `onAgentInstall`.
 */
export async function installAgentOn(
  ctx: vscode.ExtensionContext,
  services: Services,
  device: string,
  parts: readonly AgentPart[],
  consented = false,
): Promise<boolean> {
  if (!consented) {
    const modules = AGENT_MODULES.filter((m) => parts.includes(m));
    const consent = await services.prompts.showWarningMessage(
      `Sardina: install the device agent on "${device}"?`,
      { modal: true, detail: installConsentDetail(device, modules) },
      INSTALL_AGENT,
    );
    if (consent !== INSTALL_AGENT) return false;
  }

  const prepared = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Sardina: preparing the device agent for "${device}"…`, cancellable: true },
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
      const rpms = pickAgentRpms(arch, files, parts);
      if (!rpms) {
        void services.prompts.showErrorMessage(`Sardina: this extension build ships no ${AGENT_PACKAGE} RPMs for ${arch} (expected in ${dir}).`);
        return false;
      }
      // A copy left by an install that never finished would be installed with the new ones.
      await removeCopies(services, device);
      for (const rpm of rpms) {
        progress.report({ message: `copying ${rpm.file}…` });
        if (!(await copyRpm(services, device, path.join(dir, rpm.file), rpm.copyName, token))) {
          if (!token.isCancellationRequested) {
            void services.prompts.showErrorMessage(`Sardina: copying ${rpm.file} to "${device}" failed (see the Sardina output).`);
          }
          return false;
        }
      }
      return true;
    },
  );
  if (!prepared) return false;

  installEvents.fire({ device, phase: 'installing' });
  const exitCode = await runAsRootOnDevice(services, device, {
    title: `Install the device agent on "${device}"`,
    prompt: 'Developer-mode password of the device (Settings → Developer tools).',
    progressTitle: `Sardina: install the device agent on "${device}"`,
    script: INSTALL_SCRIPT,
    timeoutMs: ROOT_TIMEOUT_MS,
  });
  if (exitCode !== 0) installEvents.fire({ device, phase: 'done' });
  if (exitCode === undefined) {
    // The root step never ran (password prompt cancelled, device offline): the copy is the user's, remove it with its folder.
    await removeCopies(services, device);
    return false;
  }
  if (exitCode !== 0) {
    void services.prompts.showErrorMessage(
      `Sardina: installing the device agent on "${device}" failed (exit ${exitCode}). Check the password, and the Sardina output channel for rpm's message.`,
    );
    return false;
  }

  const state = await probe(services, device);
  installEvents.fire({ device, phase: 'done', probe: state });
  if (state.state === 'running') {
    void services.prompts.showInformationMessage(`${describeProbe(device, state)} ${restartHomeScreenAsk(device, false)}`, RESTART_HOME_SCREEN).then((choice) => {
      if (choice === RESTART_HOME_SCREEN) void restartHomeScreen(services, device);
    });
    return state.developerMode;
  }
  void services.prompts.showErrorMessage(`${describeProbe(device, state)} The package was installed, but the service did not answer.`);
  return false;
}

function installAgent(ctx: vscode.ExtensionContext, services: Services) {
  return async (item?: unknown): Promise<void> => {
    const device = requireDevice(services, item);
    if (!device) return;
    const state = await probe(services, device);
    // Fresh phone: everything is offered; with an agent, what it has.
    const have = state.state === 'running' ? installedModules(state) : AGENT_MODULES;
    const picked = await services.prompts.showQuickPick(
      AGENT_MODULES.map((m) => ({ label: m, description: MODULE_PICK_DETAIL[m], picked: have.includes(m) })),
      { canPickMany: true, title: 'Install Device Agent', placeHolder: 'Modules to install' },
    );
    if (!picked || picked.length === 0) return;
    const modules = withRequiredModules(picked.map((p) => p.label));
    await installAgentOn(ctx, services, device, ['core', ...modules]);
  };
}

/** Stops the device's sessions that use the agent (mirror, logs, app monitor); debug and app sessions keep running. */
async function stopAgentSessions(services: Services, device: string, kinds: readonly DeviceSessionKind[] = AGENT_SESSION_KINDS): Promise<void> {
  const ids = deviceSessions
    .activeFor(device)
    .filter((s) => kinds.includes(s.kind))
    .map((s) => s.id);
  if (ids.length === 0) return;
  const results = await Promise.all(ids.map((id) => deviceSessions.stopOne(device, id)));
  const stopped = results.flatMap((r) => r.stopped);
  const failed = results.flatMap((r) => r.failed);
  if (stopped.length > 0) services.output.log('info', `uninstall: stopped on "${device}": ${listLabels(stopped)}`);
  for (const f of failed) services.output.log('warn', `uninstall: could not stop ${f.label} on "${device}": ${f.reason}`);
}

/**
 * After `rpm -e`: removes what the device user may remove and checks that nothing else is left
 * (CLEANUP_SCRIPT, fixed text, paths as positional arguments), then one notification sums it up.
 */
async function cleanUpAfterUninstall(services: Services, device: string): Promise<void> {
  const result = await services.runner.run({
    args: ['device', 'exec', '--', 'sh', '-c', CLEANUP_SCRIPT, 'sh', ...CLEANUP_ARGS],
    device,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const report = parseCleanupReport(result.stdout);
  for (const p of report.removed) services.output.log('info', `uninstall: removed ${p} on "${device}"`);
  for (const id of report.closed) services.output.log('info', `uninstall: closed notification ${id} on "${device}"`);
  for (const p of report.left) services.output.log('warn', `uninstall: still on "${device}": ${p}`);
  for (const p of report.unchecked) services.output.log('warn', `uninstall: could not check ${p} on "${device}"`);
  if (!report.complete) services.output.log('warn', `uninstall: the check on "${device}" did not finish (exit ${result.exitCode})`);
  const summary = uninstallSummary(device, report);
  const message = `${summary.message} ${restartHomeScreenAsk(device, true)}`;
  const shown =
    summary.level === 'information'
      ? services.prompts.showInformationMessage(message, RESTART_HOME_SCREEN)
      : services.prompts.showWarningMessage(message, RESTART_HOME_SCREEN);
  void shown.then((choice) => {
    if (choice === RESTART_HOME_SCREEN) void restartHomeScreen(services, device);
  });
}

/**
 * Only on the person's confirmed request (also from the Devices view): restarts lipstick as the
 * normal SSH user, e.g. when Settings still shows a stale Developer agent entry. Not an agent power.
 */
async function restartHomeScreen(services: Services, device: string): Promise<void> {
  const confirm = await services.prompts.showWarningMessage(
    `Sardina: ${restartHomeScreenConfirm(device)}`,
    { modal: true },
    RESTART_HOME_SCREEN,
  );
  if (confirm !== RESTART_HOME_SCREEN) return;
  const result = await services.runner.run({
    args: ['device', 'exec', '--', ...RESTART_HOME_SCREEN_ARGV],
    device,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (result.exitCode === 0) void services.prompts.showInformationMessage(`Sardina: the home screen on "${device}" was restarted.`);
  else void services.prompts.showErrorMessage(`Sardina: restarting the home screen on "${device}" failed (exit ${result.exitCode}).`);
}

function restartHomeScreenCommand(services: Services) {
  return async (item?: unknown): Promise<void> => {
    const device = requireDevice(services, item);
    if (!device || !(await ensureDeviceOnline(services, device))) return;
    await restartHomeScreen(services, device);
  };
}

/** The modules to remove: undefined means everything. With a modular agent running the owner picks; otherwise everything is all there is to remove. */
async function pickRemoval(services: Services, device: string): Promise<{ modules?: AgentModule[] } | undefined> {
  const state = await probe(services, device);
  if (state.state !== 'running' || state.modules === undefined || state.modules.length === 0) return {};
  const installed = state.modules;
  const picked = await services.prompts.showQuickPick(
    [
      { label: REMOVE_ALL, modules: undefined as AgentModule[] | undefined },
      ...installed.map((m) => ({ label: `${m} module`, description: MODULE_PICK_DETAIL[m], modules: modulesToErase(m, installed) })),
    ],
    { title: 'Uninstall Device Agent', placeHolder: 'What to remove' },
  );
  return picked ? { modules: picked.modules } : undefined;
}

function uninstallAgent(services: Services) {
  return async (item?: unknown): Promise<void> => {
    const device = requireDevice(services, item);
    if (!device) return;
    const removal = await pickRemoval(services, device);
    if (!removal) return;
    const { modules } = removal;
    // Streams end before the package goes; a running one would otherwise see its socket vanish.
    await stopAgentSessions(services, device, modules ? sessionKindsOf(modules) : AGENT_SESSION_KINDS);
    const what = modules ? `the ${modules.join(', ')} module${modules.length === 1 ? '' : 's'}` : 'the device agent';
    const exitCode = await runAsRootOnDevice(services, device, {
      title: `Uninstall ${what} from "${device}"`,
      prompt: 'Developer-mode password of the device (Settings → Developer tools).',
      progressTitle: `Sardina: remove ${what} from "${device}"`,
      script: modules ? uninstallModulesScript(modules) : UNINSTALL_SCRIPT,
      timeoutMs: ROOT_TIMEOUT_MS,
    });
    if (exitCode === undefined) return;
    if (exitCode !== 0) {
      void services.prompts.showErrorMessage(
        `Sardina: removing ${what} from "${device}" failed (exit ${exitCode}). Check the password, and the Sardina output channel for rpm's message.`,
      );
    } else if (modules) {
      void services.prompts.showInformationMessage(`Sardina: removed ${what} from "${device}".`);
    } else {
      await cleanUpAfterUninstall(services, device);
    }
  };
}

function agentStatus(ctx: vscode.ExtensionContext, services: Services) {
  return async (item?: unknown): Promise<void> => {
    const device = requireDevice(services, item);
    if (!device) return;
    const state = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Sardina: asking the device agent on "${device}"…`, cancellable: true },
      (_progress, token) => probe(services, device, token),
    );
    const bundled = await newerBundledAgent(ctx, state);
    if (state.state === 'running' && bundled) {
      updateOffered.add(device);
      const message = `${describeProbe(device, state)} ${agentUpdateNotice(device, state.version, bundled).replace(/^Sardina: /, 'Update available: ')}`;
      void services.prompts.showInformationMessage(message, UPDATE_AGENT).then((choice) => {
        if (choice === UPDATE_AGENT) void updateAgentOn(ctx, services, device, state);
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
      void services.prompts.showErrorMessage(`Sardina: the device agent could not take a screenshot: ${reply?.error ? describeAgentRefusal(reply.error) : shot.stderr.trim() || `exit ${shot.exitCode}`}`);
    }
    return undefined;
  }
  if (!isScreenshotPath(reply.path)) {
    services.output.log('error', `device agent returned an unexpected screenshot path: ${reply.path}`);
    void services.prompts.showErrorMessage('Sardina: the device agent returned an unexpected screenshot path (see the Sardina output).');
    return undefined;
  }
  try {
    const fetched = await services.runner.run({ args: ['device', 'exec', '--', 'base64', reply.path], device, timeoutMs: FETCH_TIMEOUT_MS, token });
    if (fetched.exitCode !== 0) {
      if (!token.isCancellationRequested) {
        void services.prompts.showErrorMessage(`Sardina: fetching the screenshot from "${device}" failed (see the Sardina output).`);
      }
      return undefined;
    }
    const png = decodeBase64Output(fetched.stdout);
    if (!isPng(png)) {
      void services.prompts.showErrorMessage(`Sardina: the screenshot fetched from "${device}" is not a PNG file.`);
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
    if (!(await ensureAgent(ctx, services, device, NEED.screenshot))) return;

    const png = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Sardina: taking a screenshot of "${device}"…`, cancellable: true },
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
        `Sardina: could not save the screenshot to ${target.fsPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    await ctx.globalState.update(LAST_FOLDER_KEY, path.dirname(target.fsPath));
    await vscode.commands.executeCommand('vscode.open', target);
    void services.prompts.showInformationMessage(`Sardina: screenshot saved to ${target.fsPath}`, REVEAL).then((choice) => {
      if (choice === REVEAL) void vscode.commands.executeCommand('revealFileInOS', target);
    });
  };
}

/** Show Device Logs: streams the device journal into the "Sardina Device Log" output channel until stopped. */
function showLogs(ctx: vscode.ExtensionContext, services: Services) {
  return async (item?: unknown): Promise<void> => {
    const device = requireDevice(services, item);
    if (!device) return;
    const agent = await ensureAgentProbe(ctx, services, device, NEED.logs);
    if (agent) await deviceLog().show(device, agent);
  };
}

export function activateDeviceAgent(ctx: vscode.ExtensionContext, services: Services): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sardina.agent.install', installAgent(ctx, services)),
    vscode.commands.registerCommand('sardina.agent.uninstall', uninstallAgent(services)),
    vscode.commands.registerCommand('sardina.agent.status', agentStatus(ctx, services)),
    vscode.commands.registerCommand('sardina.agent.screenshot', takeScreenshot(ctx, services)),
    vscode.commands.registerCommand('sardina.agent.logs', showLogs(ctx, services)),
    vscode.commands.registerCommand('sardina.device.restartHomeScreen', restartHomeScreenCommand(services)),
  );
  activateDeviceLog(ctx, services, clientArgs);
  activateMirror(ctx, services);
}
