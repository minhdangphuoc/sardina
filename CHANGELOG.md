# Changelog

## v0.1.0 — Unreleased

- Detect the Sailfish SDK via `sailfish.sdkPath`, `SAILFISH_SDK_ROOT`, `~/SailfishOS` or `PATH`, gate on `sfdk --version`, and re-probe when `sailfish.sdkPath` changes.
- Detect Sailfish projects (`rpm/*.spec` + qmake/CMake) across single- and multi-root workspaces and keep them in sync with file changes.
- `Sailfish: New Project` wizard (`sfdk init`), Sailfish build-target selection and status bar, and `sfdk config --global` commands to set sfdk's own defaults.
- Build/deploy/run/package/check/clean tasks (task type `sailfish`) with streamed output, a build engine auto-start, and problem matchers for gcc/qmake/rpmbuild/rpmvalidator output.
- Devices & Emulators tree view (`sfdk device`/`emulator list`), start/stop/install commands, an SSH terminal command, and VirtualBox VM correlation for emulators.
- Devices & Emulators view gains an "SDK" group: SDK location/version, sfdk path, build engine state (with start/stop; refresh to see changes made elsewhere) and installed build targets, plus an install prompt when no SDK is found.
- Disable the Qt QML extension's `qmlls` language server per Sailfish project folder, since it requires Qt 6.8+ while Sailfish targets ship Qt 5.6 (`sailfish.qtqml.silenceQmlls`).
- Add 21 Silica QML snippets (`sfpage`, `sfdialog`, `sflistview`, `sfflickable`, `sfpulldown`, `sfpushup`, `sfcover`, `sfremorseitem`, `sfremorsepopup`, `sfbutton`, `sftextfield`, `sfswitch`, `sfslider`, `sfcombobox`, `sfsectionheader`, `sfdetailitem`, `sfbusy`, `sfviewplaceholder`, `sfappwindow`, `sfattached`, `sfnotification`).
- Add a "Get started with Sailfish OS" walkthrough covering SDK setup, project creation, target selection, the emulator and build/deploy/run.
