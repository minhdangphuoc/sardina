# Features


## SDK and build targets

- Finds the Sailfish SDK on its own (`sailfish.sdkPath`, `SAILFISH_SDK_ROOT`,
  `~/SailfishOS`, then `sfdk` on `PATH`). **Set SDK Path**, **Download SDK**
  and **Install SDK** help when it is missing.
- An **SDK** view: SDK version and location, the `sfdk` path, the build engine
  with start and stop buttons, and the installed build targets.
- Pick the build target from the status bar (**Select Target**). **Set sfdk
  Default Target** and **Set sfdk Default Device** change `sfdk`'s own defaults.
- **New Project** creates a project with `sfdk init`. A getting-started
  walkthrough covers the first steps.

## Build, deploy, run and debug

- Status bar buttons: **Build**, **Deploy** (build and install, without
  starting), **Run** (build, install and start; **Ctrl+Alt+R**) and **Debug**.
- **Run Installed App** and **Debug Installed App** start the app that is
  already on the device, without building again. If it is not installed, they
  offer to build and deploy first.
- Release or Debug build type, six deploy methods, and a warning before
  building for another architecture on top of an old build.
- C++ debugging on the device through `gdbserver` and the C/C++ extension.
  Debug builds are unoptimised (`-O0 -g`), **Restart** (Ctrl+Shift+F5) starts
  `gdbserver` again without building, and Debug opens the Device Monitor beside
  the editor.
- Run, Debug and Deploy stream their build log live into the **Sailfish OS
  Build** channel, and a running app, log stream or mirror shows in the status
  bar and the Devices view; changing the device stops what ran on the old one.
- VS Code tasks of type `sailfish` (build, build (debug), deploy, run,
  package, check, clean) with problem matchers for gcc, qmake, rpmbuild and the
  Harbour validator.

## Package signing

- **Set Up Package Signing** picks one of your GPG keys, or creates one, checks
  that the passphrase works, and turns on signing for the project. It saves the
  key's fingerprint, so a key with a similar name cannot be used by mistake.

## Build view

- The **Build** view at the top of the Sailfish sidebar shows the project's
  target, device (connected or offline), build type, deploy method, signing and
  the last build (running with its stage and time, or succeeded / failed). Click a
  row to change it; the title bar has Build (Stop while a build runs) and the
  build log, and the ⋯ menu has Clean Project Build, Rebuild, Package, Validate
  RPM, Run / Debug Installed App and Set Up Package Signing.
- **Clean Project Build** deletes what an in-source build generated in the
  project folder (qmake Makefiles, object files, moc/qrc output, `RPMS`,
  `BUILD`, `BUILDROOT`) after a confirmation that lists what goes. Hand-written
  Makefiles, symlinks and `.git` are never touched. **Rebuild** cleans, then builds.

## Devices and emulators

- One **Devices** view with two groups, **Emulators** and **Devices**: start,
  stop and show emulators, install more emulators, open an SSH terminal to a
  device.
- **Add Device** registers a phone in a few prompts: it creates an SSH key,
  copies it to the phone and registers the phone with the SDK and the build
  engine. **Remove Device** undoes it.
- **Install Deploy & Debug Tools on Device** installs `rsync`,
  `sdk-deploy-rpm` and `gdb-gdbserver` on the phone.

## Device agent: screenshots, logs, screen mirror and control

- **Take Device Screenshot** saves a PNG where you choose and opens it.
- **Show Device Logs** streams the phone's system log into the **Sailfish
  Device Log** output channel (also reachable from the Device Monitor).
- A **Device Monitor** tab per device: connection, live app stats and actions
  ([Device Monitor](device-monitor.md)).
- **Mirror Device Screen** shows the phone's screen live in an editor tab, as
  VP8 video over an SSH forward when possible. A one-line status strip and an
  ⓘ **Mirror details** popover show the transport, codec and frame rate. With agent 1.7.0 or newer you
  can click to tap and drag to swipe while the panel has focus.
- The phone's own **Settings → System → Developer agent** page decides what
  VS Code may do (screen view, control, logs, indicator, the mirror's idle mode
  and frame rate limit of 30 or 60 fps); it wins over VS Code.
- The agent is installed once, with your consent and the developer-mode
  password, and works only while Developer Mode is on. See
  [How the device agent stays safe](device-agent.md#how-the-device-agent-stays-safe).

## QML editing

- 21 Silica QML snippets (`sfpage`, `sfdialog`, `sflistview`, `sfpulldown`,
  `sfcover` and more).
- Completion, hover and error checks for QML in Sailfish projects, read from
  the selected build target (`sailfish.target`; without one, the first
  installed target): types, properties, `on...` handlers, `id.`, singletons
  such as `Theme.`, enum values, attached properties and `import` lines.
  An unknown type or property is an error, but only when the file parses
  cleanly and every `import` resolves; otherwise there is nothing to report.
  Turn it off with `sailfish.qml.languageFeatures`.
- Turns off the Qt QML extension's `qmlls` language server in Sailfish
  projects, where it only reports false errors (see
  [What this is not (yet)](troubleshooting.md#what-this-is-not-yet)).

