# Setup

## Words used below

| Term | Meaning |
|---|---|
| **Sailfish SDK** | Jolla's toolkit for building Sailfish OS apps. It installs into `~/SailfishOS`. |
| **`sfdk`** | The SDK's command-line tool. The extension runs it for you; you can also run it in a terminal. |
| **Build engine** | A virtual machine (VirtualBox) or container (Docker) where the SDK compiles your app. It starts by itself when needed. |
| **Build target** | The Sailfish OS version and processor type you compile for, e.g. `SailfishOS-5.1.0.11-aarch64`. |
| **Architecture** | The end of a target name: `aarch64` (64-bit ARM phones), `armv7hl` (32-bit ARM phones) or `i486` (the emulator). |
| **Emulator** | A Sailfish OS phone running as a VirtualBox virtual machine on your computer. |
| **Device** | A phone or the emulator that the SDK installs your app on. |
| **RPM** | The package format Sailfish OS installs apps from. A build puts `.rpm` files in the project's `RPMS/` folder. |
| **SDK workspace** | The folder the build engine can see, by default your home directory. Projects must be inside it. |
| **Device agent** | `sailfish-devagent`, a small service this extension can install on a device for screenshots, logs and the mirror. |

## Requirements

| What | Version | Notes |
|---|---|---|
| Computer | Linux or macOS | **Windows is not supported.** The `sailfish.experimental.enableWindows` setting only lifts the Windows block and looks for the SDK in `C:\SailfishOS`; nothing else is implemented or tested, so leave it off. |
| Free disk space | about 15 GB | For the SDK with its default components. |
| Memory | 4 GB or more | Recommended by the SDK. |
| [VirtualBox](https://www.virtualbox.org/wiki/Downloads) | 6.1 or newer | **Install before the SDK.** Needed for the emulator, and for the build engine unless you choose Docker. Tested with 7.2.20. |
| [Sailfish SDK](https://docs.sailfishos.org/Tools/Sailfish_SDK/Installation/) | 3.10 or newer | Tested with **3.13.5**. Older versions are not blocked; a warning goes to the **Sailfish OS** output channel. |
| [VS Code](https://code.visualstudio.com/) | 1.94 or newer | |
| [Qt QML](https://marketplace.visualstudio.com/items?itemName=theqtcompany.qt-qml) extension | any | Installed together with this extension (needs access to the Marketplace; VSCodium users install it from Open VSX first). |
| OpenSSH client | 8.4 or newer | `ssh`, `ssh-keygen` and `ssh-copy-id`, for **Add Device** and the fast screen mirror. The extension checks for them at start and shows a notice if any is missing. |
| GnuPG | any | Only for package signing. |
| git and [Node.js](https://nodejs.org/) | Node.js 22 or newer | Only to build the extension from source. Tested with 22.23.3. |

## Setup

Each part ends with a **Check:**. Do not go on until it passes. Parts 1 to 6
get you running on the emulator; Parts 7 to 10 add a phone, debugging, signing
and the device agent.

### Part 1: Install VirtualBox

1. Install VirtualBox 6.1 or newer from
   <https://www.virtualbox.org/wiki/Downloads> (on Linux, the package for your
   distribution; Ubuntu and elementary OS can use Oracle's `.deb`).
2. **Check:** `VBoxManage --version` prints a version such as `7.2.20r175154`.

### Part 2: Install the Sailfish SDK

1. Download the Linux installer from
   <https://docs.sailfishos.org/Tools/Sailfish_SDK/#latest-sdk-release>, named
   like `SailfishSDK-3.13.5-linux64-online.run`.
2. Start it as your normal user (not root):

   ```sh
   chmod +x ~/Downloads/SailfishSDK-3.13.5-linux64-online.run
   ~/Downloads/SailfishSDK-3.13.5-linux64-online.run
   ```

3. In the installer, keep the folder `~/SailfishOS`, choose **VirtualBox** as
   the build engine (or Docker; the emulator still uses VirtualBox), keep the
   default workspace (your home directory) and the default components. It
   downloads several GB.
4. When it finishes it opens **Qt Creator**. **Close it.** While Qt Creator
   runs it can overwrite the SDK's device list (see [Part 7](#part-7-run-on-a-phone)).
5. Make `sfdk` a plain command, as the SDK documentation recommends:

   ```sh
   mkdir -p ~/.local/bin
   ln -s ~/SailfishOS/bin/sfdk ~/.local/bin/sfdk
   ```

   Open a new terminal. If `sfdk` is still not found, add
   `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc` or `~/.zshrc`.
6. **Check:**

   ```sh
   sfdk --version              # first line: SDK_RELEASE=3.13.5
   sfdk tools target list      # e.g. SailfishOS-5.1.0.11-aarch64, -armv7hl, -i486
   ```

   The first command that needs the build engine starts it, which takes a
   minute.

If the SDK is somewhere other than `~/SailfishOS`, set `sailfish.sdkPath` in
VS Code, or the `SAILFISH_SDK_ROOT` environment variable, to that folder.

### Part 3: Install VS Code and this extension

1. Install VS Code, git and Node.js 22 or newer. **Check:** `code --version`,
   `git --version` and `node --version` each print a version.
2. Build and install the extension:

   ```sh
   git clone https://github.com/minhdangphuoc/vscode-sailfish.git
   cd vscode-sailfish
   npm ci                                         # install build tools
   npm run build                                  # compile into dist/
   npx vsce package                               # creates sailfish-tools-<version>.vsix
   code --install-extension sailfish-tools-*.vsix
   ```

   The last command also installs the Qt QML extension. The package includes
   the device agent RPMs for `aarch64`, `armv7hl` and `i486`.
3. **Check:** `code --list-extensions | grep -iE 'sailfish|qt-qml'` lists
   `sailfish-tools-dev.sailfish-tools` and `theqtcompany.qt-qml`.

To update later: `git pull`, then repeat the last four commands.

### Part 4: Create or open a project

1. Projects must be inside the SDK workspace (your home directory by default).
   Outside it, every `sfdk` command fails with "The command needs to be used
   under Sailfish SDK workspace". The path must not contain spaces either; the
   extension warns if it does.
2. Create a project, either in VS Code with **Ctrl+Shift+P** (**Cmd+Shift+P**
   on macOS) → **Sailfish: New Project**, or in a terminal:

   ```sh
   mkdir -p ~/Projects/harbour-myapp && cd ~/Projects/harbour-myapp
   sfdk init -t qtquick2app
   ```

   App names start with `harbour-` by Sailfish convention.
3. Open the folder in VS Code (**File → Open Folder**) and choose **Yes, I
   trust the authors**. In Restricted Mode the extension stays off.
4. **Check:** a Sailfish icon appears in the activity bar on the left, and the
   status bar shows the items in Part 5. A folder counts as a Sailfish project
   only if it contains `rpm/*.spec`.

### Part 5: The status bar

From left to right:

| Item | What it is | Click to |
|---|---|---|
| `SailfishOS-5.1.0.11-aarch64` | Build target | Pick a target. Its architecture must match the device: `i486` for the emulator, `aarch64` or `armv7hl` for a phone. |
| 📱 `Jolla Phone` | Deploy device | Pick the device. Shows ⚠ if the SDK does not know the device, and `(offline)` if it does not answer. |
| ⚙ `Release` | Build type | Switch between Release and Debug (`sfdk build --enable-debug`, compiled without optimisation). |
| ☁ `RPM` | Deploy method | Pick how the app gets onto the device (below). |
| 🔧 | Build | Build the project. |
| 📦 `Deploy` | Deploy | Build and install on the device, without starting the app. |
| ▶ `Run` | Run | Build, install and start the app (**Ctrl+Alt+R**, **Cmd+Alt+R** on macOS). |
| 🐞 `Debug` | Debug | Build, install and start the app under the debugger (Part 8). |

To start or debug what is already installed without building again, use
**Sailfish: Run Installed App** or **Sailfish: Debug Installed App** from the
Command Palette.

Deploy methods:

| Choice | What happens |
|---|---|
| **Deploy as RPM package** (default) | Copies the RPM to the device and installs it. Needs Developer Mode. |
| **Deploy by copying binaries** | Copies the built files to `/opt/sdk/<name>` without installing an RPM. |
| **Copy RPM for manual install** | Copies the RPM to `~/RPMS` on the device for you to install. **Run** stops after copying. |
| Install RPM with pkcon / zypper / zypper dup | Other installers; zypper needs zypper and root on the device. |

When you press **Run**, the progress notification closes once the app has
started. The app runs in its own terminal, named after the app, which shows its
output. Press **Ctrl+C** there, or close the terminal, to stop it.

**Changing architecture:** projects build in place, so building for another
architecture on top of the old build gives a broken package. When you pick a
target with a different architecture, the extension asks to clean first;
answer **Clean**. Set `sailfish.build.cleanOnArchChange` to `true` to clean
without asking.

**OS versions:** a target may be older than the phone's Sailfish OS; this is
normal. As of SDK 3.13.5 the newest targets are 5.1.0.11, and their apps run on
Sailfish OS 5.2 phones.

### Part 6: Run on the emulator

1. Click the Sailfish icon in the activity bar. In the **Devices** view under **Emulators**, start
   `SailfishOS-5.1.0.11` with its start button. A phone-shaped window opens;
   wait for the home screen.
2. In the status bar, pick an `…-i486` target and the device
   `Sailfish OS Emulator 5.1.0.11`.
3. Press ▶ **Run**.
4. **Check:** your app opens in the emulator window.

The **SDK** view in the same sidebar shows the SDK version and location, the
`sfdk` path, the build engine (with start and stop buttons) and the installed
targets, with ✓ on the selected one. It does not update by itself when
something changes outside VS Code, such as the engine starting during a build;
press the view's **Refresh** button. If no SDK is found, it shows **Sailfish
SDK not found**; click it to open the install guide.

### Part 7: Run on a phone

1. **Turn on Developer Mode.** On the phone: **Settings → Developer tools**.
   Turn on **Developer mode** and **Remote connection**, and set a password.
   Note the password and the **USB IP address** shown there.
2. **Connect by USB** with a cable that carries data, plugged into the computer
   itself rather than a dock if you can. The phone appears as a network
   adapter. **Check:** `ping <USB IP address>` gets replies. The address is
   often `192.168.2.15`, but not always (a Jolla Phone (2026) used
   `192.168.2.16`). If the link keeps dropping, try another cable or port.
3. **Allow apps from outside the store.** On the phone: **Settings → Untrusted
   software** → turn on **Allow untrusted software**. Otherwise the phone
   refuses to install your app.
4. **Register the phone.** Close Qt Creator first; while it runs it rewrites
   the SDK's device list and would undo this. Then **Ctrl+Shift+P** →
   **Sailfish: Add Device**, and answer:

   | Prompt | Answer |
   |---|---|
   | Device name | Any name, e.g. `Jolla Phone` |
   | Host | The USB IP address from step 1 |
   | SSH port | `22` |
   | Username | `defaultuser` |
   | Device architecture | `aarch64` for 64-bit phones such as the Jolla Phone (2026), `armv7hl` for 32-bit ones. If unsure, pick one and check below. |
   | Authentication | **Generate new key (recommended)** |
   | Developer Mode password | The password from step 1 |

   The extension creates an SSH key, installs it on the phone, and registers
   the phone with the SDK and its build engine. A message confirms
   "registered and confirmed via `sfdk device list`". **Check:**

   ```sh
   sfdk device list                                # shows your phone as "hardware-device"
   sfdk device exec "<phone name>" -- uname -m     # prints aarch64 or armv7hl
   ```

   If `uname -m` prints another architecture than you chose, run
   **Sailfish: Remove Device** and add the phone again.
5. **Install the deploy and debug tools.** The SDK copies apps with `rsync`,
   installs them with `sdk-deploy-rpm` and debugs them with `gdbserver`; some
   phones have none of them. The phone downloads them from Jolla's
   repositories, so **turn on Wi-Fi or mobile data on the phone first** (the
   USB link has no internet). In the **Devices** view, right-click the phone →
   **Install Deploy & Debug Tools on Device**, and enter the developer-mode
   password when asked. To do it by hand instead, run this in the phone's
   **Terminal** app (`devel-su` needs a real terminal):

   ```sh
   devel-su sh -c 'pkcon refresh && pkcon install rsync sdk-deploy-rpm gdb-gdbserver'
   ```

   **Check:** the install reports success (by hand: `pkcon` ends with
   `Finished` and no error).
6. **Run your app.** In the status bar, pick the phone and a target with the
   architecture `uname -m` printed. Press ▶ **Run**, and confirm the install on
   the phone if it asks.
7. **Check:** your app opens on the phone.

**Open SSH to Device** (right-click the phone) and **Connect to Device (WLAN)**
open an SSH terminal to a device; you type the password there yourself.

### Part 8: Debug on the device

1. Set the build type to **Debug** (⚙ in the status bar) so breakpoints and
   variables work.
2. Set breakpoints in your C++ code by clicking left of a line number.
3. Press 🐞 **Debug**. The first time, accept installing the **C/C++**
   extension (`ms-vscode.cpptools`), which provides the debugger view. If
   `gdbserver` is missing on the device, choose **Install on device** and enter
   the developer-mode password (the phone needs internet).
4. The app starts on the device and stops at your breakpoints. Use the Run and
   Debug view to step and inspect variables and the call stack. The app's
   output is in the terminal "<app> (debug)". Stopping the debug session stops
   the app.

Tips:

- A Debug build is compiled without optimisation (`-O0 -g`), so breakpoints
  stay on their lines and local variables show their current values. `sfdk
  build -d` alone only keeps the debug info packages and still compiles with
  `-O2`, because the `%qmake5` macro passes the platform's `%optflags` to the
  compiler. The extension therefore adds
  `-- --define '__global_cflags -O0 -g …'` for Debug, which replaces only the
  generic part of `%optflags` and keeps the architecture flags; it also leaves
  out `-D_FORTIFY_SOURCE=2`, which needs optimisation. You do not need to change
  your `.pro` or `.spec`. Release builds are unchanged. Your own
  `sailfish.build.extraArgs` come after this define, so a define of your own
  wins. `Q_ASSERT` stays disabled (`QT_NO_DEBUG` is still defined), as in an
  `sfdk build -d`. CMake projects get the same flags through `%cmake`.
- Debug builds also enable QML debugging support (`-DQT_QML_DEBUG`); nothing
  opens unless the app is started with `-qmljsdebugger`.
- qmake does not rebuild objects when only the flags change. When you switch
  between Release and Debug, the next Build, Deploy, Run or Debug first runs
  `sfdk make -- clean` if the project's `Makefile` was generated for the other
  type, so a Release package never contains unoptimised objects and a Debug
  build never reuses optimised ones. A build started outside the extension
  (`sfdk` in a terminal) is not checked.
- The debugged app is started by `gdbserver` over SSH, outside the Sailjail
  sandbox, so sandbox permission problems do not reproduce under the debugger.
- **Restart** (🔄 in the debug toolbar, **Ctrl+Shift+F5**) stops the app and
  starts the same installed build again under the debugger; breakpoints stay.
  It does not build or deploy, so code changes are not picked up. To run
  changed code, stop the session and press 🐞 **Debug** again.

**Debug Installed App** starts the app already on the device under the
debugger, without building or deploying again. QML and JavaScript debugging are not supported yet.

### Part 9: Sign packages (optional)

Signing is off by default. To turn it on for a project:

1. Install GnuPG (for example `sudo apt install gnupg`).
2. **Ctrl+Shift+P** → **Sailfish: Set Up Package Signing**. Pick a key from
   the list (each shows the end of its fingerprint), or choose **Create a new
   key** and enter a name, an optional email and a passphrase.
3. For an existing key, enter its passphrase. The extension signs a test file
   with the key and passphrase first; if that fails, nothing is saved.
4. It then sets, for this project folder, `sailfish.build.sign` to `true`,
   `sailfish.build.signingUser` to the key's **fingerprint**, and
   `sailfish.build.signingPassphraseFile` to a private file (mode 600) in the
   extension's storage, because `sfdk` reads the passphrase from a file. The
   passphrase is never stored in settings.
5. **Check:** the confirmation names the key and the end of its fingerprint.
   Build, deploy, run and package now pass `--sign` to `sfdk`. To verify an
   RPM, import the public key once and run `rpm -K`:

   ```sh
   gpg --export --armor <fingerprint> | rpm --import /dev/stdin
   rpm -K RPMS/<package>.rpm
   ```

If you set `sailfish.build.signingUser` to a name by hand, the extension looks
it up before building: a name matching exactly one key is used by its
fingerprint, and a name matching none or several keys stops the build with a
clear message (gpg matches names as substrings, so `Jane Doe` also matches
`Jane Doe Dev`).

