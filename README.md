# Sailfish OS Tools

A VS Code extension for building, deploying, running and managing Sailfish OS
applications: SDK detection, build targets, devices/emulators, build/deploy/run
tasks, project scaffolding and a getting-started walkthrough.

## Before you start: the words used below

| Term | Meaning |
|---|---|
| **Sailfish SDK** | Jolla's toolkit for building Sailfish OS apps. It installs into `~/SailfishOS`. |
| **`sfdk`** | The SDK's command-line tool. This extension runs it for you; you can also run it in a terminal. |
| **Build engine** | A small virtual machine (VirtualBox) or container (Docker) where the SDK compiles your app. It starts automatically when needed. |
| **Build target** | The Sailfish OS version and processor type you compile for, e.g. `SailfishOS-5.1.0.11-aarch64`. |
| **Architecture** | The processor type at the end of a target name: `aarch64` (64-bit ARM phones), `armv7hl` (32-bit ARM phones) or `i486` (the emulator). |
| **Emulator** | A Sailfish OS phone running as a VirtualBox virtual machine on your computer. |
| **Device** | A real phone (or the emulator) that the SDK installs your app on. |
| **RPM** | The package format Sailfish OS installs apps from; a build produces `.rpm` files in your project's `RPMS/` folder. |
| **SDK workspace** | The folder the build engine can see, by default your home directory. Your projects must be inside it. |

## Requirements

| What | Version | Notes |
|---|---|---|
| Computer | Linux or macOS | **Windows is not supported yet.** The `sailfish.experimental.enableWindows` setting only removes the Windows block and looks for the SDK in `C:\SailfishOS`; nothing else is implemented or tested, so leave it off. |
| Free disk space | about 15 GB | For the SDK with its default components. |
| Memory | 4 GB or more | Recommended by the SDK. |
| [VirtualBox](https://www.virtualbox.org/wiki/Downloads) | 6.1 or newer | **Install before the SDK.** Needed for the emulator, and for the build engine unless you choose Docker. Tested with 7.2.20. |
| [Sailfish SDK](https://docs.sailfishos.org/Tools/Sailfish_SDK/Installation/) | 3.10 or newer | Tested with **3.13.5**. Older versions are not blocked; a warning is written to the Sailfish OS output channel. |
| [VS Code](https://code.visualstudio.com/) | 1.94 or newer | |
| [Qt QML](https://marketplace.visualstudio.com/items?itemName=theqtcompany.qt-qml) extension | any | Required: VS Code installs it together with this extension (needs internet access to the Marketplace; VSCodium users install it from Open VSX first). |
| git and [Node.js](https://nodejs.org/) | Node.js 22 or newer | Only to build this extension from source. CI builds with Node.js 22; some build tools in `package-lock.json` require it. Tested with 22.23.3. |
| OpenSSH client | 8.4 or newer | `ssh`, `ssh-keygen` and `ssh-copy-id`, used when adding a phone. The extension checks for them once when it starts and shows a notice if any are missing. |

## Setup

Each part ends with a check. Don't continue until the check passes.

### Part 1: Install VirtualBox

1. Install VirtualBox 6.1 or newer from <https://www.virtualbox.org/wiki/Downloads>
   (Linux: the package for your distribution; Ubuntu and elementary OS can use
   Oracle's `.deb`).
2. **Check:** in a terminal, `VBoxManage --version` prints a version such as
   `7.2.20r175154`.

### Part 2: Install the Sailfish SDK

1. Download the Linux installer from
   <https://docs.sailfishos.org/Tools/Sailfish_SDK/#latest-sdk-release>. The
   file is named like `SailfishSDK-3.13.5-linux64-online.run`.
2. Make it executable and start it as your normal user (not root):

   ```sh
   chmod +x ~/Downloads/SailfishSDK-3.13.5-linux64-online.run
   ~/Downloads/SailfishSDK-3.13.5-linux64-online.run
   ```

3. In the installer:
   - Keep the installation folder `~/SailfishOS`. The extension finds the SDK
     there without any configuration.
   - Choose **VirtualBox** as the build engine type (or Docker if you prefer;
     the emulator still uses VirtualBox).
   - Keep the default workspace (your home directory) unless your projects
     live elsewhere.
   - Keep the default components. Installation downloads several GB and can
     take a while.
4. When the installer finishes, it opens the SDK's IDE (**Qt Creator**).
   **Close it.** While it is open, it can overwrite the SDK's device list (see
   Part 7).
5. Make `sfdk` available as a plain command (this is the SDK documentation's
   recommended way):

   ```sh
   mkdir -p ~/.local/bin
   ln -s ~/SailfishOS/bin/sfdk ~/.local/bin/sfdk
   ```

   Open a new terminal afterwards. If `sfdk` is still not found, add
   `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc` or `~/.zshrc`.
6. **Check:**

   ```sh
   sfdk --version              # first line: SDK_RELEASE=3.13.5
   sfdk tools target list      # e.g. SailfishOS-5.1.0.11-aarch64, -armv7hl, -i486
   ```

   The first command that needs the build engine starts its virtual machine,
   which takes a minute.

If you installed the SDK somewhere other than `~/SailfishOS`, set the
`sailfish.sdkPath` setting in VS Code, or the `SAILFISH_SDK_ROOT` environment
variable, to that folder. The extension looks in this order: `sailfish.sdkPath`,
`SAILFISH_SDK_ROOT`, `~/SailfishOS`, then `sfdk` on `PATH`.

### Part 3: Install VS Code and this extension

The extension is not on the Marketplace yet, so you build it from source.

1. Install VS Code from <https://code.visualstudio.com/>, git, and Node.js
   (22 or newer). **Check:** `code --version`, `git --version` and
   `node --version` each print a version.
2. Build and install the extension:

   ```sh
   git clone https://github.com/minhdangphuoc/sailfish-dev-extension.git
   cd sailfish-dev-extension
   npm ci                                         # install build tools
   npm run build                                  # compile into dist/
   npx vsce package                               # creates sailfish-tools-0.1.0.vsix
   code --install-extension sailfish-tools-0.1.0.vsix
   ```

   The last command also installs the Qt QML extension.
3. **Check:** `code --list-extensions | grep -iE 'sailfish|qt-qml'` lists
   `sailfish-tools-dev.sailfish-tools` and `theqtcompany.qt-qml`.

To update later: `git pull`, then repeat the last four commands.

### Part 4: Create or open a project

1. Projects must be inside the SDK workspace (your home directory by
   default). Outside it, every `sfdk` command fails with "The command needs to
   be used under Sailfish SDK workspace".
2. Create a project, either:
   - in VS Code: **Ctrl+Shift+P** (**Cmd+Shift+P** on macOS) →
     **Sailfish: New Project**, or
   - in a terminal:

     ```sh
     mkdir -p ~/Projects/harbour-myapp && cd ~/Projects/harbour-myapp
     sfdk init -t qtquick2app
     ```

   App names start with `harbour-` by Sailfish convention.
3. Open the folder in VS Code (**File → Open Folder**) and click **Yes, I
   trust the authors** when asked. In Restricted Mode the extension stays
   disabled.
4. **Check:** a Sailfish fish icon appears in the left activity bar, and the
   status bar along the bottom shows the Sailfish items below. The extension
   only treats a folder as a Sailfish project if it contains `rpm/*.spec`.

### Part 5: The status bar

From left to right:

| Item | What it is | Click to |
|---|---|---|
| `SailfishOS-5.1.0.11-aarch64` | Build target | Pick a target. Its architecture must match the device: `i486` for the emulator, `aarch64` or `armv7hl` for a phone. |
| 📱 `Jolla Phone 2026` | Deploy device | Pick the device. Shows ⚠ if that device is not registered with the SDK. |
| ⚙ `Release` | Build type | Switch between Release and Debug (`sfdk build --enable-debug`). |
| ☁ `RPM` | Deploy method | Pick how the app gets onto the device (see below). |
| 🔧 | Build button | Build the project. |
| ▶ `Run` | Run button | Build, install on the device and start the app (**Ctrl+Alt+R**, **Cmd+Alt+R** on macOS). |
| 🐞 `Debug` | Debug button | Build, install and start the app under the debugger (see Part 8). |

Deploy methods:

| Choice | What happens |
|---|---|
| **Deploy as RPM package** (default) | Copies the RPM to the device and installs it. Needs Developer Mode. |
| **Deploy by copying binaries** | Copies the built files to `/opt/sdk/<name>` without installing an RPM. |
| **Copy RPM for manual install** | Copies the RPM to `~/RPMS` on the device; you install it yourself. **Run** stops after copying. |
| Install RPM with pkcon / zypper / zypper dup | Alternative installers; zypper needs zypper and root on the device. |

When you press **Run**, the progress notification closes once the app has
started. The app then runs in its own terminal (named after the app) that
shows its output; press **Ctrl+C** there, or close that terminal, to stop it.

**Changing architecture:** projects build in place, so building for a new
architecture on top of the old build produces a broken package. When you pick
a target with a different architecture, the extension asks to clean the build
first; answer **Clean**. Set `sailfish.build.cleanOnArchChange` to `true` to
clean without asking.

**OS versions:** a target may be older than the phone's Sailfish OS; this is
normal. As of SDK 3.13.5 (October 2026) the newest targets are 5.1.0.11, and
their apps run on Sailfish OS 5.2 phones.

### Part 6: Run on the emulator

1. Click the Sailfish fish icon in the activity bar. Under **Emulators**,
   right-click `SailfishOS-5.1.0.11` → **Start**. A phone-shaped window opens;
   wait until its home screen appears.
2. In the status bar, pick an `…-i486` target and the device
   `Sailfish OS Emulator 5.1.0.11`.
3. Press ▶ **Run**.
4. **Check:** your app opens in the emulator window.

#### The SDK group

Below **Devices**, the same view has an **SDK** group showing what is installed
on your computer: the SDK version and location, the `sfdk` path, the build
engine (with start/stop buttons) and the installed build targets, with a ✓ on
the one you selected. The group does not update by itself when something
changes outside VS Code (for example the engine starting during a build); click
the view's **Refresh** button to see it. If no SDK is found, the group shows a
**Sailfish SDK not found** item; click it to open the install guide.

### Part 7: Run on a phone

1. **Turn on developer mode.** On the phone: **Settings → Developer tools**.
   Turn on **Developer mode** and **Remote connection**, and set a password.
   Note the password and the **USB IP address** shown on that page.
2. **Connect by USB.** Use a USB cable that carries data (not a charge-only
   cable), plugged into the computer itself rather than a dock if possible.
   The phone appears as a network adapter.
   **Check:** `ping <USB IP address>` gets replies. The address is often
   `192.168.2.15`, but some phones use another one (a Jolla Phone (2026) used
   `192.168.2.16`). If the connection keeps dropping, try another cable or
   port.
3. **Install the deploy and debug helpers on the phone.** The SDK copies apps
   with `rsync`, installs them with `sdk-deploy-rpm`, and debugs them with
   `gdbserver`; some phones lack all three. The phone downloads them from
   Jolla's repositories, so **turn on Wi-Fi or mobile data on the phone first**
   (the USB link alone has no internet). `devel-su` asks for the
   developer-mode password and needs a real terminal, so run this in the
   phone's **Terminal** app:

   ```sh
   devel-su sh -c 'pkcon refresh && pkcon install rsync sdk-deploy-rpm gdb-gdbserver'
   ```

   or from a terminal on your computer (enter the developer-mode password
   twice: once for SSH, once for `devel-su`):

   ```sh
   ssh -t defaultuser@<USB IP address> "devel-su sh -c 'pkcon refresh && pkcon install -y rsync sdk-deploy-rpm gdb-gdbserver'"
   ```

   `pkcon refresh` updates the phone's package lists first; without it, a
   phone with outdated lists reports the packages as not found.
   You can also do this from VS Code: right-click the phone in the Sailfish
   view → **Sailfish: Install Deploy & Debug Tools on Device**.

   **Check:** `pkcon` ends with `Finished` and no error. If you skip
   `gdb-gdbserver` here, the 🐞 **Debug** button offers to install it later.

4. **Allow apps from outside the store.** On the phone: **Settings →
   Untrusted software** → turn on **Allow untrusted software**. Otherwise the
   phone refuses to install your app.
5. **Register the phone with the SDK.** Close Qt Creator first: while it
   runs it rewrites the SDK's device list and would undo this. Then, in
   VS Code: **Ctrl+Shift+P** → **Sailfish: Add Device**, and answer:

   | Prompt | Answer |
   |---|---|
   | Device name | Any name, e.g. `Jolla Phone` |
   | Host | The USB IP address from step 1 |
   | SSH port | `22` |
   | Username | `defaultuser` |
   | Device architecture | `aarch64` for 64-bit phones such as the Jolla Phone (2026), `armv7hl` for 32-bit ones. If unsure, pick one and check below. |
   | Authentication | **Generate new key (recommended)** |
   | Developer Mode password | The password from step 1 |

   The extension creates an SSH key for the phone, installs it there, and
   registers the phone with the SDK and its build engine. A message confirms
   "registered and confirmed via `sfdk device list`".
   **Check:**

   ```sh
   sfdk device list                                # shows your phone as "hardware-device"
   sfdk device exec "<phone name>" -- uname -m     # prints aarch64 or armv7hl
   ```

   If `uname -m` prints a different architecture than you chose, run
   **Sailfish: Remove Device** and add the phone again with the right one.

6. **Run your app.** In VS Code, in the Sailfish view, click **Sailfish:
   Refresh Devices**. In the status bar, pick the phone and a target with the
   architecture `uname -m` printed. Press ▶ **Run**, and confirm the
   installation on the phone when it asks.
7. **Check:** your app opens on the phone.

### Part 8: Debug on the device

1. Install `gdb-gdbserver` on the phone (Part 7, step 3).
2. Set the build type to **Debug** in the status bar (⚙), so breakpoints and
   variables work.
3. Set breakpoints in your C++ code: click left of a line number.
4. Press 🐞 **Debug** in the status bar. The first time, accept installing the
   **C/C++** extension (`ms-vscode.cpptools`), which provides the debugger
   view. If `gdbserver` is missing on the device, choose **Install on device**
   and type the developer-mode password in the terminal that opens.
5. The app starts on the device and stops at your breakpoints. Use the Run and
   Debug view to step through code and inspect variables and the call stack.
   The app's output appears in the terminal named "<app> (debug)". Stopping
   the debug session stops the app.

QML/JavaScript debugging is not supported yet.

## Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| `The command needs to be used under Sailfish SDK workspace` | The project is outside the SDK workspace. | Move the project into your home directory, or change the workspace in Qt Creator's options. |
| Phone missing from the Sailfish view, ⚠ on the device in the status bar | The phone is not in `sfdk device list`, e.g. because a running Qt Creator rewrote the list. | Close Qt Creator and register the phone again (Part 7, step 5). |
| `Fatal: '<name>' is not a known device` | The build engine keeps its own device list (`~/SailfishOS/vmshare/devices.xml`), and this device is missing from it. | Remove the device and add it again with **Sailfish: Add Device**, which updates both lists. |
| `bash: rsync: not found` | `rsync` and `sdk-deploy-rpm` are missing on the phone. | Part 7, step 3. |
| `pkcon` install fails, or exits with code 5, while downloading | The phone has no internet access; the USB link alone does not provide it. | Turn on Wi-Fi or mobile data on the phone and install again. |
| `pkcon` install exits with code 4 (packages not found) | The phone's package lists are out of date. | Run `pkcon refresh` first (Part 7, step 3 does), or use **Install Deploy & Debug Tools on Device**. |
| 🐞 Debug says gdbserver is not installed | `gdb-gdbserver` is missing on the phone. | Choose **Install on device** (the phone needs internet), or Part 7, step 3. |
| `Installing untrusted software disabled` | The phone only accepts store apps. | Part 7, step 4. |
| `nothing provides 'libQt5Core.so.5'` | The package contains files built for another architecture, e.g. the emulator build packaged for a phone. | **Ctrl+Shift+P → Sailfish: Clean**, then build again. |
| `The required configuration option 'device' is not set` | No deploy device selected. | Click the device item in the status bar. |
| Qt Creator keeps asking for the device password | The device is set to password login. | In Qt Creator's device settings, choose key-based authentication. |
| Add Device says to close Qt Creator | Qt Creator is running. | Close it and run the command again. |
| `Auth failed: Authentication token manipulation error` from `devel-su` | It ran without an interactive terminal. | Run it in a terminal window (Part 7, step 3). |
| Phone not visible at all (`lsusb` does not list it) | Cable or port problem. | Try another data cable or USB port. |

## Known issues

- Close Qt Creator before **Sailfish: Add Device** or **Remove Device**; the
  extension refuses to change the device list while it runs, because Qt
  Creator would overwrite the change.
- As of SDK 3.13.5 there is no Sailfish OS 5.2 build target; use 5.1.0.11.

## What this is not (yet)

- **Silica IntelliSense is not implemented in v0.1.** Rich completion, hover and
  diagnostics for Sailfish Silica QML APIs is planned for v0.2; it will read
  the build target already installed locally on your machine, and Silica's
  own type/property/API data is never bundled with this extension. v0.1
  instead disables Qt QML's `qmlls` language server
  (`qt-qml.qmlls.enabled`) per Sailfish project folder, because qmlls requires
  Qt 6.8+ while Sailfish OS build targets ship Qt 5.6, so qmlls only produces
  spurious diagnostics against Silica QML (`sailfish.qtqml.silenceQmlls`).

## Telemetry

**None.** This extension does not collect, transmit or report any usage data,
crash data or telemetry of any kind.

## Publisher

The `publisher` field in `package.json` (`sailfish-tools-dev`) is a
**placeholder**. The repository owner should set this to their real Marketplace
publisher id before any public release.

## Development

```sh
npm ci
npm run build        # bundle dist/extension.js with esbuild
npm run check:types
npm run lint
npm run test         # unit, fuzz and integration tests (opens a VS Code test window)
```

To try changes without packaging, run `npm run build` (or `npm run build:watch`),
then `code --extensionDevelopmentPath=$PWD <your-project>`. There is no
`.vscode/launch.json` in the repository, so **F5** does not work out of the box.

See `CONVENTIONS.md` for the full module layout, stub APIs, naming
reconciliation and how tests stub UI prompts and the fake `sfdk` binary.

## License

GPL-3.0-or-later — see `LICENSE`.
