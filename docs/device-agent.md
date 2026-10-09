# Device agent


The device agent is a small service you install on a device once. After that,
VS Code can take screenshots, show the system log and mirror the screen without
asking for the developer-mode password each time. It works on phones and on the
emulator. This extension includes agent **1.11.1**, a small core plus modules
you choose: `logs`, `stats`, `screenshot`, `mirror` and `input` (control, needs
`mirror`).

1. **Before you start:** the phone is registered ([Part 7](setup.md#part-7-run-on-a-phone)) and Developer Mode is
   on.
2. **Install the agent.** **Ctrl+Shift+P** → **Sailfish: Install Device
   Agent** (also in the device's right-click menu). Tick the modules you want
   (all are ticked on a new phone; on a phone that has the agent, the installed
   ones), read the dialog, which lists only what those modules can do, confirm,
   and enter the developer-mode password once.
   **Check:** **Sailfish: Device Agent Status** reports agent 1.11.1 running
   with the installed modules, and which are not installed.
3. **Take a screenshot.** **Sailfish: Take Device Screenshot**, or the camera
   button on the device in the Devices view. Choose where to save
   the PNG (the dialog remembers the folder). The picture opens in VS Code, and
   the notice offers **Reveal in folder**. If you cancel the dialog, nothing is
   saved.
4. **Read the logs.** **Sailfish: Show Device Logs** streams the device's system
   log into the **Sailfish Device Log** output channel (JSON with levels and
   tags with agent 1.10.0 or newer, plain text lines with older agents; ANSI
   colours are removed). Stop the stream with **Cancel** on the progress
   notification, or choose **Stop** when you run the command again. Changing
   the selected device also stops it.
5. **Mirror the screen.** **Sailfish: Mirror Device Screen**, or the mirror
   button on the device, opens the screen in a tab beside the editor.
   **Check:** the tab shows the current screen and follows what you do on the
   phone. If it says **Disconnected**, press **Reconnect**.
6. **Control the phone** (agent 1.7.0 or newer). Click the picture to tap and drag to swipe. A
   `Control` pill appears at the right of the strip while control is active
   (nothing while the mirror is view only; `Control off on phone` when the
   phone turned it off). Control works only
   while the mirror tab and the VS Code window have focus; switching away stops
   it at once. Only taps and one-finger swipes exist on the screen: no text or
   power button. On a phone with a hardware keypad (agent 1.10.3 or newer, for
   example the Commodore Callback) the strip shows `Keypad detected` with
   **Create layout**: it saves a starter layout built from the phone's keys
   (default `.sailfish/keypads/<model>.json`) and opens it. The keypad then
   appears under the picture; click its buttons to press the phone's keys (your
   PC keyboard is not forwarded). Saving the file reloads the keypad; a broken
   edit shows one error and keeps the last good layout. Picking an existing
   valid layout file uses it as is. If the file goes missing the strip says
   `Keypad layout missing` with **Edit**. The strip hint goes away once you use
   it. **Sailfish: Edit Keypad Layout** opens the file again, **Sailfish: Reset
   Keypad Layout** forgets it (the file is kept).
   While control is active, a circle in the mirror marks where you touch. The
   phone itself shows nothing, unless its switch **Show remote touches as a
   cursor** is on: the input module then creates a virtual mouse (through
   `/dev/uinput`) and moves the phone's own pointer to each touch. It never
   presses a button; it is removed when control ends. Without access to
   `/dev/uinput` there is no cursor.
7. **Remove the agent or one module.** **Sailfish: Uninstall Device Agent**
   asks what to remove: **Device agent and all modules** or one installed
   module (removing `mirror` also removes `input`). A module removal stops only
   that module's sessions and erases only its package. Removing everything first stops the mirror, device logs and app monitor of that device,
   then removes the package, its service, socket, settings and notifications,
   the extension's leftovers in the device user's home (`~/.cache/sailfish-tools`,
   staged screenshots, an RPM copy), and checks that nothing is left; one
   notification says what was removed and anything that is still there. A
   running Settings app is closed so the Developer agent entry disappears. The
   notification asks whether to restart the home screen: **Restart Home Screen**
   asks again first (running apps close; no root, no password).
   The same action is in the Devices view's right-click menu and the Command
   Palette. The SDK
   tools (`rsync`, `sdk-deploy-rpm`, `gdb-gdbserver`) are not touched.

If the agent or the module a command needs is missing, **Take Device
Screenshot**, **Show Device Logs** and **Mirror Device Screen** offer to install
just that (one prompt, one password). A mirror without the `input` module is
view only; the strip says `Control needs the input module` with **Install**.

**Updating the agent.** When the device has an older agent than this
extension includes, the mirror still opens, and VS Code shows a notice once per
device per session with **Update Device Agent**. **Device Agent Status** shows
the same. Updating installs the core and the modules the device has (an agent before
1.11.0 gets all of them) and asks for the password once. It restarts the agent: a running
log stream ends, and an open mirror shows `connecting: the agent is being
updated` and reconnects by itself. The mirror needs agent 1.1.0, the SSH
forward 1.2.0, VP8 video 1.6.0 and control 1.7.0.

**How the mirror works.** When the device's key is registered, VS Code opens an
SSH port forward to the agent and receives VP8 video, which the tab decodes
itself; if this VS Code build cannot decode VP8, it uses JPEG images instead.
The video aims for up to 30 frames per second at 720 pixels wide and
2000 kbit/s. If the forward cannot be set up, the mirror uses the slower
connection through the SDK. The phone captures the screen with Lipstick's own
recorder, so no "Screenshot captured." notices appear. The mirror never takes
screenshots: if the recorder cannot be used (agent 1.10.5), the stream ends
with `native screen capture unavailable: <reason>`, the strip says
**Disconnected** with **Reconnect**, and the **Sailfish OS** output has the reason.
Hiding the tab pauses the stream after a moment; closing it stops the stream.

**The status strip** below the picture is one line, for example `● Live · 30
fps`: a coloured dot (green live, grey waiting, red disconnected), the state,
the frame rate (`idle` while the screen is still; never with the phone's **Idle mode**
switch off, agent 1.10.6, which keeps sending frames), at most one warning, and on
the right an action button, the control pill and an ⓘ button. Everything else
is behind ⓘ.

| Strip | Meaning |
|---|---|
| `Live · 30 fps` | Streaming; the frame rate you actually get, smoothed over about a second. When the phone cannot encode 30 frames a second, it steps down to a steady 20, 15, 10 or 7.5 and back up when it can. |
| `Slow path` | The mirror uses the SDK connection instead of the fast SSH forward. The details give the reason, e.g. `ssh forward unavailable — auth`. With an outdated agent an **Update agent** button appears. |
| `Reduced for phone` | The phone could not encode fast enough, so only the size went down. |
| `Reduced for link` | A slow link made the mirror lower bitrate and size. Both reductions go back by themselves, which takes about half a minute; the level changes only while the picture changes. |
| `N dropped` | Frames skipped because VS Code was still drawing the previous one. |
| `Control needs the input module` | The phone has the mirror module but not `input`; **Install** adds it. |
| `Control` / `Control off on phone` | Control is active; or the phone's Settings page turned it off. |
| `Paused`, `Connecting…`, `Disconnected: <reason>` | The tab is hidden, starting, or ended (press **Reconnect**). |

Only one warning shows at a time, in the order above. The ⓘ button opens
**Mirror details** (close it with ×, Escape or a click outside): Transport
(`SSH forward` or `SDK connection`), Video or Image (codec, size, target kbit/s
or JPEG quality, and why it was reduced), Received kbit/s, Frame rate, Latency
(phone to your screen), Phone time (per frame), Stages and Captured (agent
1.10.7: where the phone spends each captured frame, e.g. `hold 0 · capture 12 ·
readback 25 · convert 6 · encode 9 · send 1 ms`, and how many new screen
pictures per second it captured), Capture, Dropped, Idle mode, Frame rate limit
and Control.
**Copy details** puts them on the clipboard for a bug report.

**The lease.** While the tab is visible, VS Code renews the mirror every 20
seconds. If the phone hears nothing for 60 seconds (VS Code hung, the computer
slept, the network dropped), it stops streaming by itself and the tab shows
`Disconnected` with **Reconnect**.

**On the phone,** one notification says "Screen is being viewed from VS Code"
while the mirror runs, and "Screen is being controlled from VS Code" while
control is active. It goes away shortly after the stream stops. A separate
notice says the developer agent is running.


## How the device agent stays safe

- **Installed only with your consent.** The install dialog explains what the
  agent does, and installing, updating and removing each need the
  developer-mode password. **Uninstall Device Agent** removes it completely.
- **Developer Mode gate.** The agent checks on every request, every mirror
  renewal and every start of control that Developer Mode is on. Turn it off and
  the agent refuses everything and ends a running mirror at its next renewal;
  turn it on and it works again without reinstalling.
- **No network listener.** The agent listens only on a private Unix socket on
  the phone (mode 0600, owned by `defaultuser`). VS Code reaches it only through
  the SSH login it already has. The fast mirror's port forward is a channel
  inside that login, using only the device's registered key; the socket on your
  computer is private to your user and removed when the tab closes.
- **Pinned host keys.** VS Code keeps its own list of device host keys, filled
  from the SDK connection, and refuses a key that changed. An emulator is
  re-trusted automatically; for a phone VS Code warns and offers **Trust New
  Key**, and uses the SDK connection until then.
- **Lease.** A mirror ends by itself 60 seconds after the last renewal, so a
  hung or disconnected computer cannot leave the screen streaming.
- **Visible on the phone.** A notification is shown while the screen is viewed,
  and control stays off until the phone has confirmed the "being controlled"
  notification.
- **Control only while focused.** Control has its own 3-second lease, renewed
  only while the mirror tab and its window have focus; losing focus, hiding or
  closing the tab stops it at once. Only bounded taps and one-finger swipes are
  accepted, rate-limited on both sides. There is no key, text, power-button or
  arbitrary input command.
- **Limited rights.** The agent runs as the normal phone user `defaultuser`,
  not root, with two extra groups: `privileged` (for screen capture) and
  `systemd-journal` (for the log). It accepts a fixed set of requests with
  checked arguments and passes nothing to a shell. It cannot run commands,
  change settings or read your files.

Details: [`device-agent/README.md`](../device-agent/README.md).

## What is not verified yet

The device agent is new. These parts are built and tested on the emulator and
with test fixtures, but not yet confirmed on a real phone:

- Tap and swipe control: injection on a phone's touchscreen, all screen
  rotations, and the change of the on-phone notification to "being
  controlled". (The emulator follows the computer's mouse, so it does not prove
  this.)
- Mirror speed on a phone with agent 1.8.x: whether it holds 30 or 20 frames a
  second at 720 pixels wide. Frame rates and timings have only been measured on
  the emulator.
- Long sessions on a phone (memory over 10 minutes or more), and behaviour when
  the phone's screen turns off during a mirror.
- The Device Monitor on a phone: the journal fields an app started by
  `invoker` writes (which decide crash detection), `journalctl --output-fields`
  on the phone's systemd, and app stats on a phone. It is tested with fixtures
  only, not on the emulator or a phone.
- The monitor's four-theme check: the page has not been looked at in every
  VS Code colour theme (light, dark, high contrast light and dark).
- If the phone lacks the JPEG image plugin, the agent sends larger PNG frames
  on the JPEG path; which package provides that plugin is not known yet.

