# Troubleshooting


**Build and deploy**

| What you see | Cause | Fix |
|---|---|---|
| `The command needs to be used under Sailfish SDK workspace` | The project is outside the SDK workspace. | Move it into your home directory, or change the workspace in Qt Creator's options. |
| `Cannot find real …` from the build engine | The project path contains a space. | Rename the folders so the path has no spaces. |
| `nothing provides 'libQt5Core.so.5'` | The package holds files built for another architecture. | **Sardina: Clean**, then build again. |
| `The required configuration option 'device' is not set` | No deploy device selected. | Click the device item in the status bar. |
| `Installing untrusted software disabled`, or the install is refused as untrusted | The phone accepts only store apps. | [Part 7](setup.md#part-7-run-on-a-phone), step 3. |
| `bash: rsync: not found` | `rsync` and `sdk-deploy-rpm` are missing on the phone. | [Part 7](setup.md#part-7-run-on-a-phone), step 5. |
| Tools install fails, or `pkcon` exits with code 5 while downloading | The phone has no internet; the USB link does not provide it. | Turn on Wi-Fi or mobile data on the phone and try again. |
| `"<device>" is offline — connect it …` when installing tools or debugging | The phone's SSH port does not answer: unplugged, asleep, Developer Mode off, or on another Wi-Fi network. Nothing was installed. | Connect it (USB or Wi-Fi), wake it, check that its address in **Devices** is current, then **Retry**. |
| `pkcon` exits with code 4 (packages not found) | The phone's package lists are out of date. | Run `pkcon refresh` first; **Install Deploy & Debug Tools on Device** does this. |
| 🐞 Debug says gdbserver is not installed | `gdb-gdbserver` is missing on the phone. | Choose **Install on device** (the phone needs internet), or [Part 7](setup.md#part-7-run-on-a-phone), step 5. |
| `Auth failed: Authentication token manipulation error` from `devel-su` | It ran without a terminal. | Run it in the phone's Terminal app, or use the VS Code command. |
| Signing setup says nothing was saved | The passphrase is wrong, or the key has one and none was entered. | Run **Set Up Package Signing** again with the right passphrase. |
| A signed build stops because the signing user matches no key or several keys | `sardina.build.signingUser` holds a name that is missing or ambiguous. | Run **Set Up Package Signing**, which saves the fingerprint. |

**Devices**

| What you see | Cause | Fix |
|---|---|---|
| Phone missing from the Devices view, ⚠ on the device in the status bar | The phone is not in `sfdk device list`, e.g. because Qt Creator rewrote the list. | Close Qt Creator and register the phone again ([Part 7](setup.md#part-7-run-on-a-phone), step 4). |
| `Fatal: '<name>' is not a known device` | The build engine's own device list (`~/SailfishOS/vmshare/devices.xml`) lacks this device. | Remove the device and add it again with **Add Device**, which updates both lists. |
| Add Device says to close Qt Creator | Qt Creator is running. | Close it and run the command again. |
| Qt Creator keeps asking for the device password | The device is set to password login there. | In Qt Creator's device settings, choose key-based authentication. |
| Phone not visible at all (`lsusb` does not list it) | Cable or port problem. | Try another data cable or USB port. |

**Device agent and mirror**

| What you see | Cause | Fix |
|---|---|---|
| `Developer Mode is off` for a screenshot or logs | The agent refuses while Developer Mode is off. | On the phone: **Settings → Developer tools** → turn on **Developer mode**. |
| The Logs section says `Logs need the device agent` | The device agent is not installed or not running, so there is no log source. | **Install Device Agent** from the button in the Logs section. |
| The agent is not installed or not running | It was never installed, was removed, or the device just restarted. | **Install Device Agent**, then **Device Agent Status**. |
| A notice offers **Update Device Agent** | The device has an older agent than this extension includes. | Choose **Update Device Agent** (one password prompt). |
| Screenshot is black or fails, or the mirror stays blank or shows an error | The screen is off or locked. | Wake and unlock the phone; the mirror recovers by itself. |
| Strip says `Slow path` and the details say `SDK connection (ssh forward unavailable — <reason>)` | The fast forward could not be set up (`auth`: key not accepted; `unreachable`; `no-host-key`; `remote-refused`). The mirror uses the SDK connection. | It works as it is. For the fast path, check the device's key in `sfdk device list`, that `ssh` is installed and that the phone answers. The **Sardina** output has the full reason. The forward is tried again when you reopen the tab. |
| Warning that the device's SSH host key changed | The phone was reflashed or reset, or something else answers at its address. | If you changed the phone, choose **Trust New Key**. If not, check what is at that address. |
| Mirror says `Disconnected: replaced` | Another mirror of the same device started, e.g. in another window. The agent serves one at a time. | Press **Reconnect**, or close the other mirror. |
| Mirror says `Disconnected: … (lease expired)` | The phone got no renewal for 60 seconds (VS Code busy, computer asleep, network down). | Press **Reconnect**. |
| Mirror says `Disconnected` after the phone or network changed | The connection broke, e.g. the phone slept or left the Wi-Fi. | Wake the phone, then press **Reconnect**. |
| Mirror shows no `Control` pill | The agent is older than 1.7.0, the tab or window does not have focus, or the agent could not open the touchscreen. | Update the agent, click into the mirror tab, and check the **Sardina** output for an input error. Viewing still works. |
| Strip says `Disconnected: native screen capture unavailable: …` | Lipstick's screen recorder cannot be used on this phone. | The **Sardina** output has the reason. Press **Reconnect** once the phone is unlocked and awake; update the agent if it is older than 1.10.5. |
| Strip says `Reduced for link` | The link is too slow for full quality. | Move closer to the access point, use USB or a 5 GHz network, or ignore it; it recovers by itself. |
| Strip says `Reduced for phone` | The phone could not encode the full-size picture in time. | Close busy apps on the phone, or ignore it; it recovers by itself. |
| The phone gets hot, slow or freezes after a while | VS Code **Remote-SSH** is connected to the phone: its server and file search (`~/.vscode-server`, `rg --follow`) keep the CPU busy. This extension does not need it. | Close the remote window on the phone and remove `~/.vscode-server` there. |

## Known issues

- Close Qt Creator before **Add Device** or **Remove Device**. The extension
  refuses to change the device list while Qt Creator runs, because Qt Creator
  would overwrite the change.
- As of SDK 3.13.5 there is no Sailfish OS 5.2 build target; use 5.1.0.11.
- The device agent's open points are listed in
  [What is not verified yet](device-agent.md#what-is-not-verified-yet).

## What this is not (yet)

- **No Silica IntelliSense.** Completion, hover and diagnostics for Sailfish
  Silica QML are planned for a later version; they will read the build target
  installed on your machine, and Silica's own API data will never be bundled
  with this extension. For now the extension turns off the Qt QML extension's
  `qmlls` language server (`qt-qml.qmlls.enabled`) in each Sailfish OS project
  folder: `qmlls` needs Qt 6.8 or newer while Sailfish OS targets ship Qt 5.6,
  so it only reports false errors against Silica QML. Set
  `sardina.qtqml.silenceQmlls` to `false` to keep it on.
- **No QML or JavaScript debugging**, only C++.
- **Windows: N/A.** macOS is untested.
- **No profiling yet.** Recording CPU, memory and QML profiles (Perfetto, perf, the QML profiler, heaptrack, Valgrind) from the Device Monitor is planned for a later version.

