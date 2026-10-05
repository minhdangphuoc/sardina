# Sailfish device agent: Phase 1 plan

A small developer agent installed on the phone, so VS Code can do things that need more than a
plain SSH session (screenshots, system logs) without asking for the developer-mode password every
time. The same idea as Android's `adbd` or Xcode's `debugserver`: the user grants permission once,
at install time, and the agent only serves while Developer Mode is on.

Phase 1 delivers: install / uninstall / status from VS Code, **screenshot to the PC**, and **live
device logs**. Later phases reuse the same channel for input (tap, swipe, type), screen mirroring,
and UI testing with an element tree.

## Goals

- One click in VS Code takes a phone screenshot and saves it on the PC.
- Device logs (`journalctl`) stream into a VS Code panel.
- After a one-time install, no password prompts.
- Nothing new is exposed on the network.

## Non-goals (Phase 1)

- Input injection, screen mirroring, element tree / UI tests (Phases 2 and 3).
- Harbour (store) distribution. This is a developer-only package, like `adbd`.
- Windows hosts (the extension does not support them yet).

## Facts checked on the real phone (Jolla Phone, Sailfish OS, 2026-10-05)

| Fact | Result | Consequence |
|---|---|---|
| Lipstick screenshot API | `org.nemomobile.lipstick` `/org/nemomobile/lipstick/screenshot` `saveScreenshot(s path)` on the session bus | The agent calls this. |
| Who may call it | Denied for `defaultuser`: "PID … is not in privileged group" | The agent needs group `privileged`. |
| Group `privileged` | Exists, gid 995; `defaultuser` is not a member | Given to the agent's service only (as its primary group). |
| Journal access | `defaultuser` gets "insufficient permissions"; `/run/log/journal` is group `systemd-journal` (gid 190) | The agent also gets `systemd-journal`. |
| Developer Mode marker | Package `jolla-developer-mode` (0.6.25), which ships `/usr/bin/devel-su` | The agent serves only while it is installed. |
| systemd | 238 | `SupplementaryGroups=` is supported. |
| Qt on the phone | 5.6.3, with `libQt5Core`, `libQt5DBus`, `libQt5Network` | Agent is plain Qt, no Silica. |
| Session bus | `/run/user/100000/dbus/user_bus_socket` (uid 100000 = `defaultuser`) | The service sets `DBUS_SESSION_BUS_ADDRESS`. |
| Tools | `rpm`, `base64`, `curl`; no `ip`, `nslookup`, `wget`, `timeout`, `nc` (BusyBox) | Never rely on the missing ones. |

## Architecture

```
VS Code extension ──(existing SSH: sfdk device exec)──▶ phone
                                                         │
                         sailfish-devagent --request X   │  client mode, runs as defaultuser
                                                         ▼
                 /run/user/100000/sailfish-devagent/agent.sock  (mode 0600, owner defaultuser)
                                                         │
                                                         ▼
               sailfish-devagent (daemon, systemd system service)
               User=defaultuser  Group=privileged  SupplementaryGroups=systemd-journal
                    │                          │
                    ▼                          ▼
        lipstick saveScreenshot        journalctl --follow
        (into ~/sailfish-devagent/, then moved to the runtime dir)
```

- **One binary, two modes.** `sailfish-devagent --daemon` is the service. `sailfish-devagent
  --request <cmd>` is the client: it connects to the socket, forwards the request, and copies the
  reply to stdout. The phone has no `nc -U`, so the extension calls this client through
  `sfdk device exec`.
- **No network listener.** Only a Unix socket that only `defaultuser` can open. The way in is the
  SSH login VS Code already has, so the agent adds no new way into the phone.
- **Runs as `defaultuser`, not root.** It gets two extra groups (`privileged`, `systemd-journal`).
  systemd also gives it `defaultuser`'s normal groups, including `input` (see the Security model).

## Security model

1. **Install is the consent step.** It needs `devel-su` (the developer-mode password) once, and the
   VS Code dialog says plainly what the agent can do: take screenshots and read system logs.
2. **Developer Mode gate.** On every request the agent checks that `jolla-developer-mode` is
   installed (`/usr/bin/devel-su` exists) and refuses otherwise. Turning Developer Mode off disables
   it without uninstalling.
3. **Least privilege.** User `defaultuser` plus **two extra** groups, `privileged` (primary, via
   `Group=`) and `systemd-journal` (supplementary). No root, no capabilities. The process also gets
   `defaultuser`'s normal supplementary groups from systemd, including `input`, so as installed it
   **could write to input devices**; Phase 1 has no command that does. (T7 measured `Groups: 39 63
   100 190 985 986 987 988 989 990 991 995 999 1000`.) Only `Group=privileged` +
   `SupplementaryGroups=systemd-journal` is proven to pass Lipstick's check; whether
   `SupplementaryGroups=privileged` alone would pass is unproven.
4. **Local only.** Unix socket, mode 0600, in the user's runtime directory. No TCP or UDP.
5. **Visible.** A notification when the agent starts ("Developer agent is running"), and
   `Sailfish: Device Agent Status` in VS Code.
6. **Removable.** `Sailfish: Uninstall Device Agent` removes the package, the unit and the socket.
7. **Fixed request set.** The protocol accepts only known commands with validated arguments.
   Nothing is passed to a shell.

## Protocol

One request per connection, one JSON line in, then the reply:

| Request | Reply |
|---|---|
| `{"cmd":"ping"}` | `{"ok":true,"version":"1.0.0","developerMode":true}` |
| `{"cmd":"screenshot"}` | `{"ok":true,"path":"/run/user/100000/sailfish-devagent/shot-<ts>.png"}` |
| `{"cmd":"logs","lines":100}` | Raw `journalctl` lines, streamed until the client disconnects. |
| anything else | `{"ok":false,"error":"unknown command"}` |

The screenshot ends up in the agent's own runtime folder. Lipstick refuses paths outside the home
directory and paths with a hidden component, so it writes into `~/sailfish-devagent/` first; the
agent moves the file to the runtime folder and removes that staging folder. The extension then fetches it with
`sfdk device exec -- base64 <path>` over a connection **without** a terminal (a terminal would turn
`\n` into `\r\n`), and deletes it. The extension checks the returned path against
`^/run/user/[0-9]+/sailfish-devagent/shot-[0-9]+\.png$` before using it.

## Components

### On the phone: `device-agent/`

| File | Contents |
|---|---|
| `src/main.cpp` | Mode switch: `--daemon` / `--request`. |
| `src/agent.{h,cpp}` | `QLocalServer`, request parsing, Developer Mode gate, dispatch. |
| `src/screenshot.{h,cpp}` | Calls lipstick over `QDBus`, waits for the file, returns its path. |
| `src/logs.{h,cpp}` | Runs `journalctl --follow -n N -o short-precise` in a `QProcess` and streams it; kills it when the client disconnects. |
| `src/client.{h,cpp}` | Connects, sends the request, copies the reply to stdout, sets the exit code. |
| `sailfish-devagent.service` | `User=defaultuser`, `Group=privileged`, `SupplementaryGroups=systemd-journal`, `Environment=DBUS_SESSION_BUS_ADDRESS=…`, `RuntimeDirectory` handling, `Restart=on-failure`, `After=user@100000.service`. |
| `sailfish-devagent.pro` | qmake, `QT = core dbus network`, no Silica. |
| `rpm/sailfish-devagent.spec` | Installs the binary and unit. `%post`: `systemctl daemon-reload`, `enable --now`. `%preun`: `disable --now`. |

Built with `sfdk build` for `aarch64`, `armv7hl` and `i486` (emulator). The RPMs are signed with the
signing key configured in the extension when there is one.

### In VS Code

| Command | What it does |
|---|---|
| `Sailfish: Install Device Agent` | Copies the RPM for the device's architecture to the phone, then one password prompt: `devel-su rpm -U` (the unit starts from `%post`). Then `ping` to confirm. |
| `Sailfish: Uninstall Device Agent` | One password prompt: `devel-su rpm -e sailfish-devagent`. |
| `Sailfish: Device Agent Status` | `ping`: installed, version, Developer Mode on or off, running. |
| `Sailfish: Take Device Screenshot` | `screenshot` → fetch as base64 → delete it on the phone → a **save-file dialog** (default name `<device>-<YYYYMMDD-HHMMSS>.png`, default folder = the last folder used, else the project, else home) → open it, with **Reveal in folder**. Cancelling the dialog saves nothing (the phone copy is still deleted). |
| `Sailfish: Show Device Logs` | Streams `logs` into a "Sailfish Device Log" output channel; stopping the command or closing the channel ends it. |

- When the agent is missing, Screenshot and Logs offer **Install Device Agent**.
- No new setting: the save dialog replaces the planned `sailfish.screenshot.folder`; the last folder is remembered per machine in `ExtensionContext.globalState` (key `sailfish.agent.lastScreenshotFolder`).
- The Devices view gets a camera button on the selected device.
- The VSIX ships the prebuilt RPMs in `media/agent/<arch>/`.

### Getting the RPM onto the phone

Checked in Milestone 2 (see the implementation log): piping base64 through `sfdk device exec` stdin
works and needs no key path, no host-key handling and no second channel, so that is the transport.
`scp` is not used.

## Building and CI

- Local: `sfdk -c target=SailfishOS-5.1.0.11-<arch> build` in `device-agent/`, once per
  architecture.
- CI: GitHub's runners have no Sailfish SDK. Options:
  1. commit the three prebuilt RPMs and rebuild them by hand when the agent changes, or
  2. build them in CI with the Sailfish SDK Docker image.

  Phase 1 uses option 1; option 2 is a follow-up.

## Testing

| Level | What |
|---|---|
| Unit (mocha) | Path validation, file naming, reply parsing, architecture → RPM mapping. |
| Integration (fake sfdk) | New fixtures for `device_exec.sailfish-devagent`: screenshot saves a PNG; missing agent offers Install; Developer Mode off shows a clear message. |
| On the phone, no password | Agent binary runs in `--request` mode and reports "agent not running". |
| On the phone, needs the password once | Install → ping → screenshot → logs → uninstall. This also proves the `devel-su` (`-t -t`) path that 0.1.4 changed and has never run on hardware. |

## Milestones

1. **Agent source and RPM** builds with `sfdk` for `aarch64`; `--request ping` runs on the phone
   without the daemon and reports that it is not running.
2. **Install path:** RPM copy to the phone checked, without installing.
3. **Extension commands and settings**, with unit and integration tests.
4. **On-phone test** of install, screenshot, logs and uninstall, with you entering the password.
5. **Packaging:** RPMs inside the VSIX, README section, CHANGELOG, version bump.

## Risks and open questions

- **Input devices are writable by the agent.** The agent process has group `input` (999) from
  `defaultuser`'s normal groups, so as installed it could write to `/dev/input/event*`. On the
  emulator one KEY_POWER event written that way powered the VM off. Phase 1 has no such command;
  Phase 2 input would be a deliberate change (see the Phase 2 note).
- **Not proven on the emulator:** the `devel-su -t -t` install path (the first real-phone install
  proves it), the refusal of `logs` while Developer Mode is off (only `screenshot` was seen
  refused), and the `SupplementaryGroups=privileged`-only variant.
- **Lipstick's group check (answered in T7 on the emulator).** `Group=privileged` (primary group)
  passes it. Whether `SupplementaryGroups=privileged` alone would also pass was **not tested**
  (the drop-in test was not permitted), so the unit keeps `Group=privileged`. Lipstick also
  requires the screenshot path to be under the home directory with no hidden part, so the agent
  stages the file in `~/sailfish-devagent/` and moves it to its runtime directory.
- **Session bus timing.** The service must start after the user session's bus exists
  (`After=user@100000.service`), and retry while it doesn't.
- **uid 100000 is hard-coded.** True for current Sailfish phones; the unit could look it up instead.
- **`devel-su` from VS Code is still unproven** on hardware (the 0.1.4 `-t -t` change). Milestone 4
  depends on it.
- **Package signing.** The phone's "Allow untrusted software" setting may be required, as for apps.
- **Screen off or locked.** Screenshots of a dark or locked screen; the reply should say so when
  lipstick reports it.

## Later phases (for context)

- **Phase 2:** tap, swipe, text and key input (`/dev/uinput` is root-only; the agent already has
  group `input` for evdev nodes, see the Phase 2 note); a clickable screen mirror in a VS Code panel.
- **Phase 3:** an element tree of the running app (QML object names, text, geometry) through a Qt
  plugin loaded into debug builds, and a test API to find elements by name, tap them, assert text
  and take screenshots from test scripts in VS Code.

## Implementation log

Written by the planning agent on 2026-10-05. Section A is what exists in the tree now and how much
of it was verified; section B is the task breakdown for the remaining work; section C lists the
decisions that need the reviewer. The rules of the brief still apply: real phones ("Jolla Phone",
"Flip Phone") are read-only (no install, copy, delete, `devel-su`, `rpm -U/-i/-e`, or password);
the emulator is for anything that needs root; no commits, tags or pushes; no attribution lines
or mentions of the tooling anywhere; never revert or overwrite existing uncommitted work.

Design change (from the user, included below): **Take Device Screenshot shows a save-file dialog**
instead of writing into a fixed `screenshots/` folder; the last folder is remembered per machine
in `globalState`; cancelling saves nothing but still deletes the phone copy; the
`sailfish.screenshot.folder` setting is dropped (not in `package.json`, `defaults.ts` or the schema test).

### A. What exists now (state and verification)

Nothing in `src/` has been type-checked, linted, built or run: no `npm` command was executed at
all. Treat every TypeScript item below as "written, uncompiled". The C++ agent compiled and ran.

| File | State | Verified |
|---|---|---|
| `device-agent/sailfish-devagent.pro` | complete | qmake/i486 build OK (see below). `QT = core dbus network`, `CONFIG += c++11 console`, `DEFINES += AGENT_VERSION="1.0.0"`, installs `/usr/bin/sailfish-devagent` and `/usr/lib/systemd/system/sailfish-devagent.service`. |
| `device-agent/rpm/sailfish-devagent.spec` | complete | Builds; `%post` enables and starts the unit, `%preun` (on erase) disables and stops it, `%postun` daemon-reloads. `rpm -U` and `rpm -e` as root on the emulator both exit 0. |
| `device-agent/sailfish-devagent.service` | complete, **one line differs from the plan** | `User=defaultuser`, **`Group=privileged`** (primary), `SupplementaryGroups=systemd-journal`, `After=user@100000.service`, `Restart=on-failure`, `NoNewPrivileges=yes`, `PrivateTmp=yes`. The plan said `SupplementaryGroups=privileged systemd-journal`; lipstick's check is believed to read the owner group of `/proc/<pid>` (the effective gid), which a supplementary group does not change. Same two groups, same user: the security model is unchanged. The actual lipstick call is **not yet tested** (task T7 decides). |
| `device-agent/src/paths.{h,cpp}` | complete | uid-derived paths: `/run/user/<uid>/sailfish-devagent/agent.sock`, bus `unix:path=/run/user/<uid>/dbus/user_bus_socket`, gate = `/usr/bin/devel-su` exists. Observed on the emulator: socket created at that path. |
| `device-agent/src/agent.{h,cpp}` | complete | Daemon: `QLocalServer` with `UserAccessOption` (socket `srwx------`, dir `drwx------`), retries every 2 s while `/run/user/<uid>` is missing, one JSON line per connection (4 KiB max, 5 s timeout), `ping` always answers, `screenshot`/`logs` refused with `{"ok":false,"error":"developer mode is off"}` when `/usr/bin/devel-su` is missing, unknown `cmd` → `{"ok":false,"error":"unknown command"}`. Start notification via `org.freedesktop.Notifications` on the session bus (best effort, **not verified visually**). `stop()` removes socket and directory (verified: dir gone after `rpm -e`). |
| `device-agent/src/screenshot.{h,cpp}` | complete; **T7 changed it**: lipstick writes into `~/sailfish-devagent/` (lipstick refuses paths outside home or with hidden parts), and the agent moves the file to the runtime dir; proven on the emulator (see T7 results). The text that follows describes the pre-T7 draft. | Fresh `QDBusConnection::connectToBus(<session address>)` per request, blocking `saveScreenshot(path)` call on `org.nemomobile.lipstick` `/org/nemomobile/lipstick/screenshot`, then polls every 100 ms (max 10 s) until the file exists, is non-empty and its size is stable; reply `{"ok":true,"path":"/run/user/<uid>/sailfish-devagent/shot-<msecs>.png"}` or `{"ok":false,"error":"lipstick refused: <name>: <msg>"}`. |
| `device-agent/src/logs.{h,cpp}` | complete, **untested** | `journalctl --no-pager -o short-precise -n <N> -f` (N clamped 1..10000, default 100), merged output copied raw to the socket; killed when the client disconnects. |
| `device-agent/src/client.{h,cpp}` | complete, partly tested | `--request ping|screenshot|logs [--lines N]`; connects (3 s timeout), prints the reply, exit 0 ok / 1 reply not ok / 2 usage / 3 "agent not running" (prints `{"ok":false,"error":"agent not running"}`). For `logs`, also exits when **stdin hits EOF** (so a dead ssh ends the stream; note: `</dev/null` ends it immediately). Verified: ping exit 0, refused screenshot exit 1, bogus request exit 2. **Exit 3 (daemon stopped) not yet exercised.** |
| `device-agent/src/main.cpp` | complete | `--daemon` (self-pipe SIGTERM/SIGINT → `Agent::stop()`, SIGPIPE ignored), `--request`, `--version` (prints 1.0.0, verified). |
| `device-agent/RPMS/sailfish-devagent-1.0.0-1.i486.rpm` | built, untracked | 36504 bytes, sha256 `89f7d9e0205db19c620bd63d029bebda43e5f9a1a22098e8018e398657da60cf`. Built with `cd device-agent && ~/SailfishOS/bin/sfdk -c target=SailfishOS-5.1.0.11-i486 -c no-fix-version build`. **Without `-c no-fix-version` sfdk stamps the extension repo's git tag** (`0.1.2+main.<date>.<hash>`) as the RPM version. `armv7hl` and `aarch64` are **not built yet**. |
| `device-agent/` build droppings (untracked) | present | In-source build left `*.o`, `Makefile`, `moc_*.cpp`, `moc_*.o`, `sailfish-devagent` (binary), `documentation.list`, `RPMS/`, `.sfdk/{spec,target}` in `device-agent/`. Not ignored anywhere yet (decision D4). |
| `src/agent/agentCore.ts` | complete draft, uncompiled | Pure helpers: `archFromOutput`, `pickAgentRpm`, `parseAgentReply`, `classifyPing` → `AgentProbe`, `SCREENSHOT_PATH_RE`/`isScreenshotPath`, `isPng`, `decodeBase64Output`, `sanitizeDeviceName`, `screenshotFileName`, `COPY_SCRIPT`, `INSTALL_SCRIPT`, `UNINSTALL_SCRIPT`, `installConsentDetail`, `describeProbe`. No tests yet. |
| `src/agent/deviceAgent.ts` | complete draft, uncompiled, never run | Commands `sailfish.agent.install/uninstall/status/screenshot/logs`, `activateDeviceAgent(ctx, services)`. Save dialog via `services.prompts.showSaveDialog`, last folder in `globalState['sailfish.agent.lastScreenshotFolder']`, phone copy deleted in a `finally`. Known rough spots for T0: `shot.stderr.trim() ?? …` should be `||`; `detectArch` passes `'%{ARCH}\\n'` as an argv element through `sfdk device exec` (the remote shell re-parses it; must be checked on the emulator, see D6); the logs stream keeps the whole stdout in `SfdkResult.stdout` (acceptable for Phase 1, note it). |
| `src/sfdk/runner.ts` | edited (additive), uncompiled | `SfdkRunOptions.stdin?: string \| Buffer`: written with `child.stdin.end(data)` (EPIPE ignored). Existing calls unchanged (stdin stays an open pipe). |
| `src/ui/prompts.ts` | edited (additive), uncompiled | `showSaveDialog: vscode.window.showSaveDialog` added to `prompts`; doc comment mentions `stubSaveDialog` (helper not written yet). |
| `src/devices/devicePackages.ts` | edited, uncompiled | New `runAsRootOnDevice(services, device, { title, prompt, progressTitle, script, timeoutMs? })` (the `-t -t` + password-feed logic moved there unchanged); `installOnDevice` now delegates to it. **Behaviour change:** the password box is now `services.prompts.showInputBox` instead of `vscode.window.showInputBox` (same UI; now stubbable per CONVENTIONS). |
| `src/devices/commands.ts` | edited (one word) | `deviceFrom` is now `export`ed. |
| `src/extension.ts` | edited (additive) | imports and calls `activateDeviceAgent(ctx, services)` after `activateDevices`. |
| `device-agent/PLAN.md` | edited | Screenshot row, settings line and "Getting the RPM onto the phone" updated; this log. |

Not touched yet: `package.json` (no commands, menus, version), `CHANGELOG.md`, `.vscodeignore`,
`.gitignore`, `media/agent/`, fake-sfdk dispatcher and fixtures, any test, `CONVENTIONS.md`,
`eslint.config.mjs`, `device-agent/README.md`, the extension `README.md`.

Verified on the emulator (VM `SailfishOS-5.1.0.11`, device name `Sailfish OS Emulator 5.1.0.11`,
all commands with `timeout -s KILL … </dev/null`):

- Start: `~/SailfishOS/bin/sfdk emulator start SailfishOS-5.1.0.11` (takes ~1 min; the `sfdk emulator` family uses the VM name, `device exec` the quoted device name). Stopped again at the end with `sfdk emulator stop SailfishOS-5.1.0.11`.
- Root without a password: `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2223 -i ~/SailfishOS/vmshare/ssh/private_keys/sdk root@127.0.0.1 id` → `uid=0(root)`. (`UserKnownHostsFile=/dev/null` keeps `~/.ssh/known_hosts` untouched.)
- Facts: `uname -m` = `i686`; `privileged` gid 995, `systemd-journal` gid 190; `/usr/lib/systemd/system` exists, `/lib/systemd/system` does not; `/run/user/100000/dbus/user_bus_socket` exists; `base64`, `md5sum`, `sha256sum`, `journalctl`, `dbus-send` present; systemd 238. The emulator initially had **no** `jolla-developer-mode`.
- Transport (Milestone 2): `base64 < RPM | sfdk device exec "Sailfish OS Emulator 5.1.0.11" -- sh -c 'f=$1; n=$2; base64 -d > "$f" && [ "$(wc -c < "$f")" -eq "$n" ]' sh /tmp/sailfish-devagent.rpm 36504` → exit 0, `sha256sum` on the device identical. scp was not tried and is not needed.
- Install as root (not via devel-su): `rpm -U /tmp/sailfish-devagent.rpm` → exit 0 (unsigned RPM accepted), `systemctl is-enabled` = enabled, `is-active` = active, journal line `sailfish-devagent 1.0.0: listening on /run/user/100000/sailfish-devagent/agent.sock`, `/proc/<pid>/status`: `Uid: 100000`, `Gid: 995`, `Groups:` includes `190` and `995`; `ls -ld /proc/<pid>` → group `privileged`; `/run/user/100000/sailfish-devagent` `drwx------ defaultuser privileged`, `agent.sock` `srwx------`.
- Client as `defaultuser` through `sfdk device exec … -- sailfish-devagent --request ping` → `{"developerMode":false,"ok":true,"version":"1.0.0"}` exit 0; `--request screenshot` → `{"error":"developer mode is off","ok":false}` exit 1 (gate proven); `--request bogus` → exit 2; `--version` → `1.0.0`.
- Uninstall: `rpm -e sailfish-devagent` → exit 0; afterwards `is-active` = inactive, unit file and binary gone, `/run/user/100000/sailfish-devagent` gone, `/tmp/sailfish-devagent.rpm` removed by hand.
- Left on the emulator on purpose (needed by T7): `jolla-developer-mode-0.6.25-1.6.1.jolla.i486` (+ `-preload`, `jolla-settings-system-developermode`) installed as root with `pkcon refresh; pkcon install -y jolla-developer-mode` (the VM has internet); `/usr/bin/devel-su` (setuid root) now exists. The agent package is **not** installed any more. Emulator is stopped.

Not verified anywhere: lipstick screenshot (with `Group=privileged`, and the plan's
`SupplementaryGroups`-only question; both later answered or left open in T7), logs streaming and what stops it, the start notification,
the `devel-su -t -t` path, `--request ping` with the daemon stopped (exit 3), the real phones
(nothing was run on them), `armv7hl`/`aarch64` builds, every TypeScript file, every test.

### B. Remaining tasks

Owners: **coding** = write code/tests exactly as specified; **decision** = decide, debug, run the
emulator. Commands needing node: prefix with
a Node.js 22 install on `PATH`.
Every `sfdk` call: `timeout -s KILL <secs> ~/SailfishOS/bin/sfdk … </dev/null`. The shell is zsh.

Parallel groups: **G1** = T0 alone (everything in `src/` depends on it compiling). **G2** (after T0,
all parallel): T1, T2, T3, T6, T7, T10. **G3**: T4 (after T1, T2), T5 (after T6). **G4**: T8 (after
T7), T9 (after everything).

- [x] **T0 done (2026-10-05):** verified with `npm run check:types`, `npm run lint`, `npm run build` and `npm run check:manifest` (all exit 0, manifest OK) and `npm run test:unit` (321 passing). D6: `uname -m` only, D6 mapping, "unsupported architecture" error; D8: `SfdkRunOptions.collectOutput` (default true), `false` for the log stream; `??`→`||` fixes; save-error message. No device used.

**T0 — Make the drafted TypeScript compile and lint (decision).** Files: `src/agent/agentCore.ts`,
`src/agent/deviceAgent.ts`, `src/sfdk/runner.ts`, `src/ui/prompts.ts`, `src/devices/devicePackages.ts`,
`src/devices/commands.ts`, `src/extension.ts`. Fix the rough spots listed in section A; keep the
public shapes (`AgentProbe`, `AgentReply`, `runAsRootOnDevice`, `SfdkRunOptions.stdin`, `prompts.showSaveDialog`).
Also decide D6 (the `rpm -q --qf %{ARCH} rpm` argv) and D7. Acceptance:
`npm run check:types` and `npm run lint` exit 0; `npm run build` exits 0; `npm run check:manifest`
fails **only** with "command registered in src/** but not declared in package.json" for the five
`sailfish.agent.*` ids (T1 removes that).

**T1 [DONE: package.json parses, version 0.1.5 count=1, check:manifest OK] — Manifest, version, changelog, activation list (coding).** Files: `package.json`,
`CHANGELOG.md`, `test/integration/activation.test.ts`. Depends on nothing (can start before T0
finishes). Add to `contributes.commands` (category `Sailfish`, enablement
`sailfish.sdkAvailable && sailfish.platformSupported`):

| command | title | icon |
|---|---|---|
| `sailfish.agent.install` | Install Device Agent | `$(cloud-download)` |
| `sailfish.agent.uninstall` | Uninstall Device Agent | |
| `sailfish.agent.status` | Device Agent Status | |
| `sailfish.agent.screenshot` | Take Device Screenshot | `$(device-camera)` |
| `sailfish.agent.logs` | Show Device Logs | `$(output)` |

Add to `contributes.menus["view/item/context"]`: `sailfish.agent.screenshot` with `group: "inline"`
for `view == sailfish.devices && viewItem == hardware-device` and for
`view == sailfish.emulators && viewItem =~ /^emulator(\\.running)?$/`; non-inline entries for
`sailfish.agent.logs`, `sailfish.agent.status`, `sailfish.agent.install`, `sailfish.agent.uninstall`
with the same two `when` clauses (emulator variant `/^emulator(\\.(running|stopped))?$/`), group
`2_agent`. No `activationEvents` change (the schema test asserts the exact list), no settings.
Set `"version": "0.1.5"` in `package.json` and `package-lock.json` (top two occurrences only). Add
`## v0.1.5` above `## v0.1.4` in `CHANGELOG.md` with four bullets: device agent (what it is, what it
can do, install/uninstall/status, runs as defaultuser + two extra groups, local socket, Developer Mode
gate); Take Device Screenshot (save dialog, remembers the folder, Reveal in folder, camera button
in the Devices view); Show Device Logs (`Sailfish Device Log` output channel, stop via the
notification); `Install on device` / tool install now reads the password through the prompts seam
(no user-visible change). Add the five ids to the `expected` list in `activation.test.ts`.
Acceptance: `npm run check:manifest` → `check-manifest: OK` (after T0); `npm run test:unit` → the
settings schema tests still pass; `grep -c '"version": "0.1.5"' package.json` = 1.

**T2 — Fake sfdk: `--request` keys, fixtures, scenarios (coding).** [x] DONE: `npm run test:unit` 321 passing; fake sfdk ping/screenshot/logs/base64 and agent-missing (127), agent-devmode-off (1), agent-not-running (3) verified by direct run; base64 fetch decodes to a 69-byte PNG (`89 50 4e 47 0d 0a 1a 0a`). Files: `test/fixtures/bin/sfdk.js`,
`test/fixtures/bin/_fake-core.js`, `test/unit/fake/dispatcher.test.ts`, `CONVENTIONS.md` (key
table row), fixture files below. Change `dottedExecKey(prefix, argv)`: when the token after the
command is `--request` and another token follows, return `<prefix>.<basename>.<request>`
(e.g. `device exec X -- sailfish-devagent --request ping` → `device_exec.sailfish-devagent.ping`).
Change `candidateKeys(key)` to return every dotted prefix, longest first
(`a.b.c` → `['a.b.c','a.b','a']`); search order stays "each candidate: scenario dir, then default
dir", so scenario overrides must use the full key. Fixtures in `test/fixtures/sfdk/scenarios/default/`:
`device_exec.sailfish-devagent.ping.stdout` = `{"ok":true,"version":"1.0.0","developerMode":true}`;
`device_exec.sailfish-devagent.screenshot.stdout` = `{"ok":true,"path":"/run/user/100000/sailfish-devagent/shot-1759660000000.png"}`;
`device_exec.sailfish-devagent.logs.stdout` = three `short-precise` journal lines, plus
`device_exec.sailfish-devagent.logs.stream` containing `10`; `device_exec.base64.stdout` = base64
of a 1×1 PNG (generate with node: `require('zlib')` is not needed, embed a known 67-byte PNG);
`device_exec.rm.stdout` empty; `device_exec.rpm.stdout` = `aarch64`; `device_exec.devel-su.stdout`
= `Password: ` + newline (exit 0 by default). Do **not** add `device_exec.sh.*` (the `sh -c`
fallback to `device_exec.stdout`, exit 0, is relied on by the gdbserver check). New scenarios, each
with a one-line `PROVENANCE.md`: `agent-missing/`: `device_exec.sailfish-devagent.{ping,screenshot,logs}.stderr`
= `sh: sailfish-devagent: not found`, matching `.exit` = `127`, plus `device_exec.devel-su.stdout`
copied from default; `agent-devmode-off/`: `…ping.stdout` = `{"ok":true,"version":"1.0.0","developerMode":false}`,
`…screenshot.stdout` and `…logs.stdout` = `{"ok":false,"error":"developer mode is off"}` with `.exit` = `1`;
`agent-not-running/`: `…ping.stdout` = `{"ok":false,"error":"agent not running"}`, `.exit` = `3`.
Add keyFn/candidateKeys cases to `dispatcher.test.ts`. Acceptance: `npm run test:unit` green;
`SFDK_FAKE_SCENARIO=agent-missing test/fixtures/bin/sfdk device exec X -- sailfish-devagent --request ping; echo $?`
prints the stderr line and `127`; `test/fixtures/bin/sfdk device exec -- base64 /x | base64 -d | head -c 8 | od -An -tx1`
prints `89 50 4e 47 0d 0a 1a 0a`.

**T3 [DONE: test/unit/agent/agentCore.test.ts, 38 tests, unit suite 359 passing; eslint allowDefaultProject entry added] — Unit tests for `agentCore.ts` (coding).** Files: `test/unit/agent/agentCore.test.ts` (new),
`eslint.config.mjs` (add `'test/unit/agent/*.ts'` to `allowDefaultProject`). Depends on T0. Cases:
`archFromOutput` for `aarch64`, `armv7hl`, `armv7l`, `i686`, `x86_64`, the existing
`Linux Xperia10 4.14.150 #1 SMP aarch64 GNU/Linux` fixture text, and `hello` → undefined;
`pickAgentRpm('i486', [...])` picks the newest matching name and ignores other arches;
`parseAgentReply` (valid, trailing noise lines, invalid JSON → undefined, missing `ok` → undefined);
`classifyPing` for exit 0 ok, exit 3, exit 127, "not found" on stderr, and an unreachable detail;
`isScreenshotPath` accepts `/run/user/100000/sailfish-devagent/shot-1.png` and rejects `..`,
other dirs, `.jpg`, a trailing newline; `isPng`/`decodeBase64Output` on a wrapped base64 PNG;
`sanitizeDeviceName('Xperia 10 - Dual SIM (ARM)') === 'Xperia-10-Dual-SIM-ARM'`, `'Xperia 10 III – 日本語'`
→ no spaces or non-ASCII, `''` → `'device'`; `screenshotFileName('Jolla Phone', new Date(2026, 9, 5, 13, 42, 7))`
=== `Jolla-Phone-20261005-134207.png`; `COPY_SCRIPT`/`INSTALL_SCRIPT`/`UNINSTALL_SCRIPT` contain no
`$(`…`)` of user data and reference `/tmp/sailfish-devagent.rpm` / `sailfish-devagent`. Acceptance:
`npm run test:unit` green, `npm run lint` clean.

**T4 [DONE: 8 cases in test/integration/agent.test.ts + stubSaveDialog helper; integration 105 passing (97 + 8); lint and check:types clean] — Integration tests (coding).** Files: `test/integration/helpers.ts` (add
`stubSaveDialog(uri: vscode.Uri | undefined): sinon.SinonStub` next to `stubOpenDialog`, stubbing
`livePrompts().showSaveDialog`), `test/integration/agent.test.ts` (new). Depends on T0, T1, T2.
Setup like `devices.test.ts`: `suiteSetup` waits for `sailfish.sdkAvailable`; set
`sailfish.device` = `Xperia 10 - Dual SIM (ARM)` on `workspaceFolders[0]` (ConfigurationTarget.WorkspaceFolder)
and reset it in `suiteTeardown`; always `stubMessages()` first and `clearFakeLog()` before the
command. Tests (all `TEST_MODE=full`):
1. status: `executeCommand('sailfish.agent.status')` → one information message containing `1.0.0` and `running`; fake log keys contain `device_exec.sailfish-devagent.ping`.
2. screenshot saved: `stubSaveDialog(Uri.file(<mkdtemp>/shot.png))` → file exists, first 8 bytes are the PNG magic; keys in order contain `…ping`, `…screenshot`, `device_exec.base64`, `device_exec.rm`; the `rm` invocation argv contains `/run/user/100000/sailfish-devagent/shot-1759660000000.png`; an information message contains `saved to` with item `Reveal in folder`; the dialog stub was called with `defaultUri` ending in `.png` whose basename starts with `Xperia-10-Dual-SIM-ARM-`.
3. screenshot cancelled: `stubSaveDialog(undefined)` → no file written in the temp dir, `device_exec.rm` still invoked, no error message.
4. `withScenario('agent-missing')`, screenshot, `chosenAction` undefined → a warning message with item `Install Device Agent`, no `device_exec.devel-su` invocation.
5. `withScenario('agent-missing')`, `messages.chosenAction = 'Install Device Agent'`, `stubInputBox('secret')` → keys contain `device_exec.rpm` then a `sh` invocation whose argv contains `/tmp/sailfish-devagent.rpm` and whose logged `stdin` is non-empty only if the fake has a `.stdin-echo` file (do not assert stdin content), then `device_exec.devel-su` whose argv contains `-t`, `-t`, `devel-su`, `sh`, `-c` and the string `rpm -U`, then `…ping`; final message is an error containing `not installed` (the scenario never changes).
6. `withScenario('agent-devmode-off')`, screenshot → an error message containing `Developer Mode is off`; no `device_exec.base64`.
7. logs: `executeCommand('sailfish.agent.logs')` → within 5 s a `device_exec.sailfish-devagent.logs` invocation with argv containing `--lines`, `200`; wait until the fake exits; no error message.
8. uninstall: `stubInputBox('secret')` → a `device_exec.devel-su` invocation whose argv contains `rpm -e sailfish-devagent`; information message contains `removed`.
Acceptance: `npm run build && TEST_MODE=full npm run test:integration` passes with the previous
97 tests + the new ones (currently 97 pass on this tree before these changes; re-count after).

**T5 [DONE: `.vscodeignore` excludes `device-agent/**`; `vsce ls` lists the three RPMs and no `device-agent/` file; `device-agent/README.md` and a "Part 9: Device agent" section plus 4 troubleshooting rows in `README.md`] — Packaging files and docs (coding).** Files: `.vscodeignore` (add `device-agent/**`; `media/**`
stays included), `.gitignore` (per D4), `media/agent/{aarch64,armv7hl,i486}/` (RPMs from T6),
`device-agent/README.md` (new: what the agent is, the protocol table, how to build each arch with
`sfdk -c target=SailfishOS-5.1.0.11-<arch> -c no-fix-version build` and `sfdk make -- distclean`
between architectures, where to put the RPMs, how to test on the emulator incl. root ssh and
`pkcon install jolla-developer-mode`), extension `README.md` (one "Device agent" section: install,
screenshot, logs, uninstall, what it can do, Developer Mode gate). Depends on T6 for the RPM files.
Acceptance: `npm run check:proprietary` OK; `npx vsce ls --no-dependencies | grep media/agent` lists
three `.rpm` files and no `device-agent/`.

**T6 [DONE: `device-agent/build.sh` builds aarch64/armv7hl/i486 into `media/agent/<arch>/`; `rpm -qp` in engine prints `sailfish-devagent 1.0.0-1 <arch>`, binaries verified as aarch64/ARM/i386 ELF; `.gitignore` covers in-source outputs] — Build `armv7hl` and `aarch64` RPMs (decision, or coding following this exactly).** In
`device-agent/`: for each arch in `armv7hl aarch64 i486`: `timeout -s KILL 600 ~/SailfishOS/bin/sfdk -c target=SailfishOS-5.1.0.11-<arch> make -- distclean </dev/null || true`
(ignore errors when there is no Makefile), then
`timeout -s KILL 600 ~/SailfishOS/bin/sfdk -c target=SailfishOS-5.1.0.11-<arch> -c no-fix-version build </dev/null`,
then copy `RPMS/sailfish-devagent-1.0.0-1.<arch>.rpm` to `media/agent/<arch>/`. Rebuild i486 last
so the tree's leftover objects are i486 (or clean them per D4). Acceptance:
`ls media/agent/*/` shows exactly one RPM per arch; for each,
`timeout -s KILL 120 ~/SailfishOS/bin/sfdk engine exec -- rpm -qp --qf '%{ARCH} %{VERSION}-%{RELEASE}\n' <absolute path under $HOME> </dev/null`
prints `<arch> 1.0.0-1`; and `sfdk engine exec -- rpm -qpl <rpm>` lists `/usr/bin/sailfish-devagent`
and `/usr/lib/systemd/system/sailfish-devagent.service`.

**T7 [DONE with gaps, 2026-10-05: screenshot (after an agent fix), logs, stream cancel, daemon-stopped exit 3, start notification and uninstall proven; devel-su `-t -t` install, the `SupplementaryGroups`-only variant and the gate re-test NOT run (not permitted); see "T7 results" below] — Milestone 4 on the emulator (decision).** Depends on the i486 RPM (exists) and on
`jolla-developer-mode` (already installed on the emulator). Start the VM, then:
1. Copy the RPM with the T-transport command above; install with `rpm -U` over root ssh (and, to prove the 0.1.4 `-t -t` path: set a root password first with `echo 'root:<pw>' | chpasswd` over root ssh — the VM is disposable — then run `printf '<pw>\n' | timeout -s KILL 120 ~/SailfishOS/bin/sfdk device exec "Sailfish OS Emulator 5.1.0.11" -t -t -- devel-su sh -c 'rpm -U --replacepkgs --oldpackage /tmp/sailfish-devagent.rpm'`; expected: a `Password:` prompt in the output and exit 0; if `devel-su` needs a different account/password on the emulator, record what it needs).
2. `--request ping` → `developerMode:true`.
3. **Screenshot:** `--request screenshot` → `{"ok":true,"path":…}`; then `sfdk device exec … -- base64 <path> | base64 -d > shot.png` on the PC and check `file shot.png` says PNG with the emulator's resolution; then `rm -f` on the device. If lipstick replies `AccessDenied … not in privileged group`, record it: the primary-group approach failed. Then answer the plan's open question: add a drop-in `/etc/systemd/system/sailfish-devagent.service.d/test.conf` with `[Service]`, `Group=`, `SupplementaryGroups=privileged systemd-journal`, `systemctl daemon-reload && systemctl restart sailfish-devagent`, retry the screenshot, record the result, remove the drop-in and restart. Update the unit file and the Architecture section of this plan with whichever variant works.
4. **Logs:** `sleep 8 | timeout -s KILL 30 ~/SailfishOS/bin/sfdk device exec "…" -- sailfish-devagent --request logs --lines 5` → at least 5 journal lines, the stream ends when `sleep` closes stdin; check on the device that no `journalctl` child is left (`pgrep -a journalctl`). Then test the VS Code cancel path: start the same without `sleep` (stdin a pipe kept open, e.g. from a `node` script using `spawn` like `SfdkRunner`), send `SIGTERM` then `SIGKILL` 5 s later to the `sfdk` process, and verify `pgrep -a journalctl` on the device is empty within ~10 s. If not, decide D7.
5. Gate: `mv /usr/bin/devel-su /usr/bin/devel-su.off` (root ssh) → `--request screenshot` refused, `ping` says `developerMode:false`; move it back.
6. Daemon stopped: `systemctl stop sailfish-devagent` → `--request ping` prints `{"ok":false,"error":"agent not running"}` and exits 3 (Milestone 1's "not running" case); `systemctl start`.
7. Notification: right after `systemctl restart sailfish-devagent`, take a screenshot within ~3 s and look for the "Developer agent is running" banner (best effort).
8. `rpm -e sailfish-devagent` → inactive, files and `/run/user/100000/sailfish-devagent` gone. Stop the emulator. Record every result here.

**T7 results (emulator `Sailfish OS Emulator 5.1.0.11`, 2026-10-05).** Root = `ssh -p 2223 -i ~/SailfishOS/vmshare/ssh/private_keys/sdk root@127.0.0.1` (with `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`); client calls = `timeout -s KILL 60 ~/SailfishOS/bin/sfdk device exec "Sailfish OS Emulator 5.1.0.11" -- sailfish-devagent --request <cmd> </dev/null`.

1. **Copy + install.** Copy with the base64 transport → exit 0, device sha256 identical to the PC's. `rpm -U` as root → exit 0, unit enabled + active, `/proc/<pid>/status` `Uid 100000`, `Gid 995`, `Groups: 39 63 100 190 985 986 987 988 989 990 991 995 999 1000` (systemd also adds defaultuser's normal groups, including `input` 999), socket `srwx------ defaultuser privileged`. **`devel-su -t -t` path: NOT run.** `/etc/pam.d/devel-su` is `pam_unix.so try_first_pass` + `pam_wheel.so group=sailfish-system use_uid` (defaultuser is in `sailfish-system`); root's and defaultuser's shadow entries have no password (`!`/`!!`), so a password would have to be set first. Setting it was not permitted in this session, so the 0.1.4 `-t -t` path is still unproven.
2. **ping** → `{"developerMode":true,"ok":true,"version":"1.0.0"}`, exit 0.
3. **Screenshot / D3.** With `Group=privileged` the first try returned `lipstick refused: org.freedesktop.DBus.Error.Failed: File path for screenshot not accepted: path must be under home directory`. So the group check **passed**: the same call via `dbus-send` as plain defaultuser gets `AccessDenied: PID … is not in privileged group` for both a home path and a `/run/user` path, so lipstick checks the group before the path. (`ls -ld /proc/<lipstick pid>` shows lipstick itself runs with primary group `privileged`.) A `~/.cache/…` path was then refused with `path includes hidden part or '..'`. **Agent fix** (`src/paths.{h,cpp}`: `screenshotStagingDir()` = `<home>/sailfish-devagent`; `src/screenshot.{h,cpp}`: lipstick writes there, the agent `QFile::rename`s it (copy + remove across filesystems) to `/run/user/<uid>/sailfish-devagent/shot-<ms>.png` and `rmdir`s the staging folder). The protocol, the reply path and the extension's `SCREENSHOT_PATH_RE` are unchanged. Rebuilt with `device-agent/build.sh` (exit 0): sha256 aarch64 `8d881cd4…3c54` (36413 B), armv7hl `74c74451…dfaff` (34749 B), i486 `f320be08…cbd85` (37907 B). After that: `--request screenshot` → `{"ok":true,"path":"/run/user/100000/sailfish-devagent/shot-1791199286074.png"}`, exit 0; `sfdk device exec … -- base64 <path> | base64 -d > shot.png` → `PNG image data, 720 x 1600, 8-bit/color RGBA` (lipstick's `QT_QPA_EGLFS_WIDTH/HEIGHT` = 720×1600, VM video mode 360×800 at `QT_QPA_EGLFS_SCALE=2`), and the image shows the real home screen; `rm -f <path>` exit 0; afterwards the runtime dir holds only `agent.sock` and `~/sailfish-devagent` is gone. **The `SupplementaryGroups=privileged systemd-journal` drop-in test was NOT run** (not permitted), so per D3 the unit keeps `Group=privileged` and was not changed.
4. **Logs.** `sleep 8 | timeout -s KILL 30 sfdk device exec … --request logs --lines 5` → exit 0 after 9 s, 29 lines (header + 5 backlog + new lines), `pgrep -a journalctl` on the device afterwards: nothing. **Cancel path** (node `spawn` with stdin a pipe left open, like `SfdkRunner`; SIGTERM at 6 s, SIGKILL at 11 s): sfdk exited **on SIGTERM itself** (exit 120 within 25 ms, so here `sfdk device exec` does not ignore SIGTERM). A device-side watcher (`pgrep journalctl` every 1 s) showed pid 2036 at 11:22:52 and none from 11:22:53 on, i.e. **gone within ~1 s**. **D7 holds as decided: no `-t -t` needed.**
5. **Gate re-test: NOT run** (moving `/usr/bin/devel-su` was not permitted). The gate was proven earlier in section A (screenshot refused while `jolla-developer-mode` was absent); the refusal of `logs` was never exercised.
6. **Daemon stopped.** `systemctl stop sailfish-devagent` → runtime dir removed; `--request ping` → `{"ok":false,"error":"agent not running"}`, **exit 3**; `systemctl start` → ping exit 0 again.
7. **Notification.** The first screenshot, taken ~3 s after `systemctl restart`, shows the banner with title **"Developer agent is running"** and body "VS Code can take screen…" (cut off). Proven.
8. **Uninstall.** (The emulator had been powered off and restarted in between, see the Phase 2 note; the agent came back up by itself at boot, `is-active` = active.) `rpm -e sailfish-devagent` → exit 0, `inactive`, `/usr/bin/sailfish-devagent`, the unit file, `/run/user/100000/sailfish-devagent` and `~/sailfish-devagent` all gone; `/tmp/sailfish-devagent.rpm` removed; client ping afterwards → `sailfish-devagent: not found`, exit 127. `jolla-developer-mode` left installed. No drop-in or password was left on the VM. The emulator was left running (the user had started it).

**Phase 2 input feasibility (emulator, 2026-10-05; investigation only, nothing added to the agent).**

- `/dev/uinput` = `crw------- root root` (misc 223 present): **not usable** by defaultuser or the agent.
- `/dev/input/event0..5` = `crw-rw---- root input`; defaultuser is in `input` (999), and so is the agent process (it gets defaultuser's normal groups, see T7 step 1). Devices: event0 Power Button, event1 Sleep Button, event2 Video Bus, event3 AT keyboard, event4 PS/2 mouse (relative), event5 "VirtualBox mouse integration" (ABS X/Y + BTN_LEFT). **The emulator has no touchscreen.** Lipstick runs with `LIPSTICK_OPTIONS=-plugin VBoxTouch`, `QT_QPA_EVDEV_MOUSE_PARAMETERS=/dev/nomouse` and opens event0–event4 but **not** event5: emulator "touch" is the VBoxTouch plugin (button from the PS/2 mouse, position from the VirtualBox host pointer), so a tap at chosen coordinates **cannot** be injected on the emulator by writing to evdev.
- Proven: as defaultuser over `sfdk device exec`, writing `struct input_event` records (i386, 16 bytes) to an evdev node succeeds (`cat … > /dev/input/event5` → exit 0, but no visible effect, since lipstick does not read event5) and **reaches the system**: one KEY_POWER press+release written to event0 powered the VM off within seconds (VM state `poweroff` at 14:26:34). logind has `HandlePowerKey=ignore`, so mce or dsme acted on it; the journal is volatile, so which one is not known. The test bytes were written to `/tmp/t7-*.bin` and removed (the VM rebooted anyway); no permissions were changed.
- Not proven: a tap or swipe that a UI receives, and anything on real phones (not checked: real phones were off limits in this task).
- **Decision for Phase 2:** (a) on phones, write to the touchscreen's own evdev node (`root:input 0660` expected, to be confirmed read-only with `ls -l /dev/input /dev/uinput` + `/proc/bus/input/devices` on a phone; T8-style). This needs no new privilege, but it only works if the compositor reads that node directly, and it injects in the panel's raw coordinate space (read the ABS ranges with `EVIOCGABS`). (b) Or a uinput virtual device. That needs `/dev/uinput` access, i.e. a udev rule (`KERNEL=="uinput", GROUP="input", MODE="0660"`) shipped by the agent RPM, or `SupplementaryGroups=` plus a static-node rule. Either is a **security-model change** (it would allow any `input`-group process to create input devices) and needs the user's decision. (c) On the emulator, taps need a different route (e.g. host-side `VBoxManage`, or a test-only path through the VBoxTouch plugin). Also note: the agent process already has group `input` today because systemd applies defaultuser's normal groups; the security model text ("defaultuser plus two groups") is accurate only if it counts just the *extra* groups.

**T8 — Read-only check on a real phone (decision, optional).** Nothing may be copied to the phones, so
Milestone 1's "runs on the phone" can only be the emulator (T7 step 6). On a phone, only read-only
facts may be confirmed, e.g. `sfdk -c 'device=Jolla Phone' device exec -- rpm -q --qf '%{ARCH}\n' rpm`
to confirm the architecture detection output format (expected `aarch64` or `armv7hl`), and
`sh -c 'command -v base64 sha256sum'`. No password, no install.

**T9 — Final gate and VSIX (coding, last).** `npm run check:types && npm run lint && npm run test:unit && npm run test:fuzz && npm run check:manifest && npm run check:proprietary && npm run build && TEST_MODE=full npm run test:integration`,
then `npx vsce package --no-dependencies --out ~/Downloads/sailfish-tools-0.1.5.vsix`,
`unzip -p ~/Downloads/sailfish-tools-0.1.5.vsix extension/package.json | grep -m1 '"version"'` → `0.1.5`,
`unzip -l ~/Downloads/sailfish-tools-0.1.5.vsix | grep -E 'media/agent/.*\.rpm'` → three lines,
`unzip -l … | grep -c device-agent/` → 0. Tick the items in this log with the counts.

**T10 [DONE, 2026-10-05: PLAN, device-agent/README and README Part 9 corrected to the T7 facts; CONVENTIONS needed no change] — Plan and conventions text (coding).** Update the Architecture diagram line
`User=defaultuser  SupplementaryGroups=privileged systemd-journal` to the unit variant T7 proves,
and the "Risks" bullet about it; add the `device exec … --request` row to the CONVENTIONS key
table (T2 does the table row; T10 does the prose). Depends on T7's result.

### C. Decisions for the reviewer

- **D1 RPM transport.** base64 over `sfdk device exec` stdin is proven on the emulator (exit 0, identical sha256) and needs no key path, no `~` expansion, no host-key policy. Recommendation: keep it, drop scp. The draft uses the new `SfdkRunOptions.stdin`; alternative is a direct `spawn` like `devicePackages.ts`. Pick one.
- **D2 Root on the emulator.** Root ssh with the SDK key works (`root@127.0.0.1:2223`, no password). For the `devel-su` path, a root password must be set on the VM first (`chpasswd`); confirm what `devel-su` on the emulator authenticates against before relying on it.
- **D3 lipstick group check.** The unit now uses `Group=privileged` (primary) because lipstick is believed to check the owner group of `/proc/<pid>`; the plan said `SupplementaryGroups`. T7 step 3 tests both. Either way the security model is unchanged (defaultuser + the same two extra groups), but the plan text must say which one. **Outcome (T7):** `Group=privileged` + `SupplementaryGroups=systemd-journal` passes; the other variant was not tested.
- **D4 Build artifacts.** The in-source `sfdk build` leaves `*.o`, `Makefile`, `moc_*`, the binary, `documentation.list`, `RPMS/` and `.sfdk/` in `device-agent/`. Options: `.gitignore` entries (`device-agent/*.o`, `device-agent/Makefile`, `device-agent/moc_*`, `device-agent/sailfish-devagent`, `device-agent/documentation.list`, `device-agent/RPMS/`, `device-agent/.sfdk/`), and/or `sfdk -c output-dir=<scratch>` for the RPMs, and/or a `device-agent/build.sh` that `distclean`s between architectures. `.vscodeignore` gets `device-agent/**` regardless. Delete the current droppings once ignored.
- **D5 Prebuilt RPMs in git.** Plan option 1: commit the three RPMs under `media/agent/<arch>/` (~37 KB each) and rebuild by hand when the agent changes. Confirm, and decide whether to sign them (`rpm -U` as root accepted the unsigned i486 RPM; `sfdk config --show` shows no signing user configured).
- **D6 Architecture probe argv.** `deviceAgent.ts` runs `['device','exec','--','rpm','-q','--qf','%{ARCH}\\n','rpm']`; `sfdk device exec` hands the words to a remote shell, so `{`/`}`/`\n` may be re-parsed. Test on the emulator what `sfdk device exec "…" -- rpm -q --qf '%{ARCH}' rpm` prints (expected `i486`) and adjust the argv and the `device_exec.rpm` fixture to match. `uname -m` is the fallback (fixture reuses the existing `device_exec.uname.stdout`, which `archFromOutput` already handles).
- **D7 Stopping the log stream.** `SfdkRunner` sends SIGTERM then SIGKILL after 5 s (T7: `sfdk device exec` exits on SIGTERM; keep `timeout -s KILL` as a general safety habit); the client exits on stdin EOF or on a failed stdout write. T7 step 4 verifies that `journalctl` dies on the device. If it does not, options: run `logs` with `-t -t` (pty → SIGHUP; `\r\n` is already handled by `splitLines`), or make the daemon kill streams that go quiet after a disconnect detection timeout.
- **D8 Log stream memory.** `SfdkRunner` keeps the whole stdout of the stream and logs it at debug level at the end; fine for Phase 1, but an hours-long stream grows unbounded. Decide whether to add a `collectOutput: false` option now or note it as a follow-up.
- **D9 `installOnDevice` prompt seam.** The refactor moved the password box to `services.prompts.showInputBox` (required by CONVENTIONS, makes T4 possible). Confirm this is acceptable as a side change in 0.1.5 (CHANGELOG bullet in T1).

### D. Decisions (2026-10-05)

- **D1 → base64 over stdin, through `SfdkRunOptions.stdin`.** Drop scp. `SfdkRunner` is the sanctioned spawn point (CONVENTIONS), so no new direct `spawn`.
- **D2 → root ssh with the SDK key for setup only; prove `devel-su` honestly.** Use `root@127.0.0.1:2223` with the SDK key to prepare and inspect the emulator. For the `devel-su -t -t` install path, first read `/etc/pam.d/devel-su` (and what `devel-su` checks) on the emulator, then set only the password that path actually authenticates against. The emulator is a disposable test VM, so this is allowed there and nowhere else. Record what was set.
- **D3 → test both, prefer `SupplementaryGroups`.** If both variants pass lipstick, ship `SupplementaryGroups=privileged systemd-journal` (as planned). If only `Group=privileged` passes, keep it and update the plan text and unit comment with the evidence. If neither passes, STOP and report: the fallback (`devel-su -p` per screenshot) changes the user experience and needs the user.
- **D4 → `.gitignore` + `device-agent/build.sh`.** Ignore the in-source build outputs listed in D4. `build.sh` builds each arch with `sfdk -c target=SailfishOS-5.1.0.11-<arch> -c no-fix-version build`, runs `sfdk make -- distclean` (or removes outputs) between arches, and copies each RPM to `media/agent/<arch>/`. `.vscodeignore` gets `device-agent/**`. Delete the current droppings.
- **D5 → ship prebuilt unsigned RPMs in `media/agent/<arch>/`.** They are installed with `rpm -U` as root, which accepts unsigned packages. Signing is a follow-up. (Committing is the user's call; nothing is committed now.)
- **D6 (revised after T0) → userland arch from `rpm -q rpm`, `uname -m` as fallback.** `uname -m` is the kernel's architecture; phones with a 64-bit kernel and a 32-bit armv7hl userland would get the wrong RPM. `rpm -q rpm` (no format string, so nothing for the remote shell to re-parse) prints e.g. `rpm-4.16.1.3-1.6.1.jolla.aarch64`; the suffix is the userland arch. Fixture: `device_exec.rpm.stdout`. The original D6 text follows. **Originally: use `uname -m`, not `rpm --qf`.** Avoids remote-shell re-parsing of `%{…}`. Map `aarch64`→`aarch64`, `armv7l`/`armv7hl`→`armv7hl`, `i486`/`i586`/`i686`→`i486`; anything else is a clear "unsupported architecture" error. The fixture reuses `device_exec.uname.stdout`.
- **D7 → accept client-exits-on-broken-pipe if T7 shows `journalctl` gone within ~5 s of stopping (or at the next log line).** If it lingers, run `logs` with `-t -t` so the pty hangup ends it; `\r\n` is already handled.
- **D8 → add `collectOutput?: boolean` (default `true`) to `SfdkRunOptions` now** and pass `false` for the log stream: lines still go to `onLine`, nothing accumulates. Unbounded memory in a long-running stream is a real bug, not a follow-up.
- **D9 → accepted.** `installOnDevice` asks through `services.prompts`. Add a CHANGELOG bullet in T1.
