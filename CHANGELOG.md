# Changelog

## v0.1.6

- `Mirror Device Screen` (a phone button on a device or emulator in the Devices view): opens a live, view-only picture of the device screen in an editor tab. It updates a few frames per second, pauses while the tab is hidden, and needs device agent 1.1.0; if the installed agent is older, it offers to upgrade it.
- Device agent 1.1.0 adds a `mirror` request that streams screen frames. `ping`, `screenshot` and `logs` are unchanged.

## v0.1.5

- A **device agent**: a small helper (`sailfish-devagent`) that `Install Device Agent` puts on a device or emulator, and that lets VS Code do things sfdk cannot. `Uninstall Device Agent` removes it and `Device Agent Status` shows whether it is installed and running. It runs as `defaultuser` with the `privileged` and `systemd-journal` groups, listens on a local socket only, and works only while Developer Mode is on.
- `Take Device Screenshot` (a camera button on a device or emulator in the Devices view): takes a screenshot of the device screen and asks where to save it with a save dialog, remembers the folder, and offers Reveal in folder.
- `Show Device Logs` streams the device's journal into the `Sailfish Device Log` output channel. Stop the stream from the notification.
- `Install on device` and the tools install now read the password through the extension's prompt layer. No change you can see.

## v0.1.4

- A **Deploy** button in the status bar (build and deploy, without launching), next to Build, Run and Debug.
- `Sailfish: Run Installed App` and `Sailfish: Debug Installed App` launch or debug the app already on the device, without building or deploying again. If the app is not installed there, they offer to build and deploy first.
- Fix installing tools on the device (`Install on device`, `Install Deploy & Debug Tools on Device`): `devel-su` now gets a terminal. A single `-t` gave it none when VS Code starts sfdk, which ended in "Remote process crashed".

## v0.1.3

- Detect the app's native binary when `%files` lists the bare `%{_bindir}` directory (the stock Sailfish app template) or `%{_bindir}/*`, not only `%{_bindir}/<name>`. Run and Debug had launched such C++ apps with `sailfish-qml`, which fails with "sailfish-qml: not found".
- The gdbserver install hint now includes `pkcon refresh`.
- Fix command names showing as "Sailfish: Sailfish: …" in the Command Palette: command titles no longer repeat the `Sailfish` category prefix.

## v0.1.2

- Warn when a project path contains whitespace (including a trailing space in a folder name), which breaks sfdk's build engine with a confusing "Cannot find real …" error. The warning shows in the task terminal, and as a notification for Run and Debug.
- Signed builds resolve `sailfish.build.signingUser` before calling sfdk: a name matching one GPG key is pinned to its fingerprint, and a name matching none or several keys stops with a clear message, instead of failing inside the build engine's key import. gpg matches names as substrings, so `Jane Doe` also matches `Jane Doe Dev`.
- `Sailfish: Set Up Package Signing` command: pick a GPG key, or create one from VS Code input boxes for name, email and passphrase, and fill in the `sailfish.build.sign*` settings for the project.

## v0.1.1

- Optional RPM signing: `sailfish.build.sign` adds `--sign` to the build, deploy, run and package tasks, with `sailfish.build.signingUser` and `sailfish.build.signingPassphraseFile` passed to sfdk as session options.
- Require Node.js 22 or newer to build from source, drop `--allow-missing-repository` from the packaging command, and add the `repository` field to `package.json`.
- Update the CI workflow's actions to versions that run on Node.js 24.

## v0.1.0

- Detect the Sailfish SDK via `sailfish.sdkPath`, `SAILFISH_SDK_ROOT`, `~/SailfishOS` or `PATH`, gate on `sfdk --version`, and re-probe when `sailfish.sdkPath` changes.
- Detect Sailfish projects (`rpm/*.spec` + qmake/CMake) across single- and multi-root workspaces and keep them in sync with file changes.
- `Sailfish: New Project` wizard (`sfdk init`), Sailfish build-target selection and status bar, and `sfdk config --global` commands to set sfdk's own defaults.
- Build/deploy/run/package/check/clean tasks (task type `sailfish`) with streamed output, a build engine auto-start, and problem matchers for gcc/qmake/rpmbuild/rpmvalidator output.
- Devices & Emulators tree view (`sfdk device`/`emulator list`), start/stop/install commands, an SSH terminal command, and VirtualBox VM correlation for emulators.
- Devices & Emulators view gains an "SDK" group: SDK location/version, sfdk path, build engine state (with start/stop; refresh to see changes made elsewhere) and installed build targets, plus an install prompt when no SDK is found.
- Disable the Qt QML extension's `qmlls` language server per Sailfish project folder, since it requires Qt 6.8+ while Sailfish targets ship Qt 5.6 (`sailfish.qtqml.silenceQmlls`).
- Add 21 Silica QML snippets (`sfpage`, `sfdialog`, `sflistview`, `sfflickable`, `sfpulldown`, `sfpushup`, `sfcover`, `sfremorseitem`, `sfremorsepopup`, `sfbutton`, `sftextfield`, `sfswitch`, `sfslider`, `sfcombobox`, `sfsectionheader`, `sfdetailitem`, `sfbusy`, `sfviewplaceholder`, `sfappwindow`, `sfattached`, `sfnotification`).
- Add a "Get started with Sailfish OS" walkthrough covering SDK setup, project creation, target selection, the emulator and build/deploy/run.
