# Sailfish device agent: Phase 2a plan (screen mirror, view only)

A VS Code panel that shows the selected phone's screen, refreshed a few times per second while the
panel is visible. It uses the Phase 1 agent's screenshot path (lipstick's `saveScreenshot`) and
the SSH login the extension already has. **View only**: no tap, swipe, key or text input in this
phase. Phase 2b (input) and Phase 3 (element tree, UI tests; see
`reports/Sailfish QML UI test framework.md`) build on the same stream.

Written on 2026-10-05 against the tree after Phase 1 (`PLAN.md`, agent 1.0.0, extension 0.1.5).
Nothing here has been built or run. Same rules as Phase 1: real phones are read-only unless the
user says otherwise (see D5), the emulator is for anything that needs root, no commits.

## Status (2026-10-05)

Implemented: agent 1.1.0 (`mirror` request), the extension side, docs (M7), RPMs for all three
architectures. **Unproven**, so treat the design as untested:

- M0 did not complete: frame rate, CPU cost on the phone and transfer speed are not measured on any
  device. The defaults (4 fps, width 360, quality 60) are unverified guesses.
- M6 is not done: the mirror has not been run end to end on the emulator or a phone.
- The package that provides Qt's JPEG image plugin on Sailfish is not known, so the RPM spec has no
  `Requires:` for it. When the JPEG writer is missing on the device, the agent sends unscaled PNG
  frames instead, which are larger and slower.

## Goals

- `Mirror Device Screen` opens a panel showing the device screen, updated a few times per second.
- The phone does no work while the panel is hidden or closed, and nothing is left behind on it.
- Memory on the PC stays bounded no matter how long the panel is open.
- The Phase 1 requests (`ping`, `screenshot`, `logs`) and their replies are unchanged, so agent
  1.0.0 and 1.1.0 coexist with extension 0.1.5 and 0.1.6 in every combination (the extension
  checks the version before asking for a mirror).

## Non-goals (Phase 2a)

- Input of any kind, clickable mirror, coordinate mapping (Phase 2b; this plan only keeps the
  protocol ready for it).
- Audio, recording to a file, more than one mirror per device, a sidebar view (see D9).
- Frame rates that need a different capture path than lipstick's `saveScreenshot` (there is none
  available to a non-root process: no screencopy protocol in lipstick, `/dev/fb0` is not readable
  or not meaningful on hwcomposer phones).

## 1. Design

### 1.1 How a frame is produced

Facts (lipstick source, `src/screenshotservice.cpp`, master): `saveScreenshot(path)` calls
`compositor->grabWindow()` on the compositor's GUI thread (a GL read-back of the full screen,
720×1600 RGBA on the emulator and the Xperia 10 family), rotates the image to the topmost window's
orientation, then **encodes and writes it on a thread-pool thread with `QImage::save(path)` and no
explicit format, so the format comes from the file suffix**. The caller check ("not in privileged
group") and the path check ("must be under home directory", "hidden part or '..'") are in the D-Bus
adaptor, whose source is not in the open lipstick repository (it is in the closed
`lipstick-jolla-home`), so whether a `.jpg` suffix passes those checks can only be tested (M0.3).

Consequences:

- Every frame costs lipstick one `grabWindow()` (blocks the compositor for the read-back; a few
  to a few tens of ms on old GPUs) plus one encode on a worker thread (PNG at 720×1600 RGBA is the
  expensive part: an estimated 100–400 ms on a 2013-class phone, far less on an Xperia 10), plus
  the file write. This bounds the frame rate; nothing in the agent can make it faster, only
  cheaper (JPEG instead of PNG, see 1.3).
- The agent reads the file back, (optionally) scales and re-encodes it, base64s it and writes it to
  the socket. For the agent the per-frame work is a PNG decode (~30–80 ms on old hardware), a scale
  and a JPEG encode (both cheap at 360×800), unless lipstick already wrote a small JPEG.
- The staging folder `~/sailfish-devagent/` from Phase 1 is reused. Mirror frames are written as
  `mirror-<seq>.png` (or `.jpg`), read into memory and **deleted at once**; they never go through
  the runtime directory and the extension never runs `base64` or `rm` for them.

### 1.2 Streaming vs repeated screenshot requests

| | Repeated `screenshot` requests (Phase 1 path, 3 `sfdk device exec` per frame) | One `mirror` request, frames streamed on one connection (recommended) |
|---|---|---|
| Per frame on the PC | 3 ssh sessions (`--request screenshot`, `base64`, `rm`): 0.3–1.5 s each over WLAN | none; one long-lived `sfdk device exec` like `logs` |
| Frame rate | well under 1 fps | bounded by lipstick's encode and the link, not by ssh |
| Agent change | none | one new request + one new class, Phase 1 requests untouched |
| Phone residue on a PC crash | a stray `shot-*.png` in the runtime dir until the next `stop()` | nothing (the frame file is deleted before the line is written; the stream dies with the ssh session, proven for `logs` in T7 step 4) |
| Pause when hidden | stop issuing requests | kill the `sfdk` process (SIGTERM, proven to end the remote client within ~1 s in T7) |
| Memory on the PC | one PNG at a time | one frame line at a time with `collectOutput: false` |
| Later phases | no path to input | the same connection carries input in 2b (client stdin → socket, the stdin side already exists in the client) |

Recommendation: **one `mirror` request that streams frames as JSON lines** over the existing
client/socket/ssh path, exactly like `logs` but with structured lines. The extension reads it
through `SfdkRunner` with `collectOutput: false` and `onLine`, parses each line and keeps only the
newest frame.

Push with drop (recommended) vs pull: in a pull scheme the PC asks for each frame by writing a byte
to the client's stdin, which gives perfect rate control but needs a new `SfdkRunner` option for
writing to stdin over time, and whether `sfdk device exec` forwards small stdin writes promptly is
unproven. In the push scheme the daemon runs a timer at the requested rate and **skips a tick when
the previous capture is still running or when the socket still has unwritten bytes**
(`QLocalSocket::bytesToWrite() > 0`). The client's stdout write blocks when the ssh channel is
full, which stops it reading the socket, which makes the daemon's write buffer grow, which makes
the daemon skip frames: back-pressure end to end without a control channel. Recommended for 2a;
Phase 2b adds the stdin channel for input anyway and can switch to pull then if measurements say
so (D2).

### 1.3 Frame format and size

The panel is a view, usually 300–500 px wide; a 720×1600 frame is wasted on it and costs 3–10× the
bytes. Options, with estimates to be replaced by M0 numbers:

| Option | Bytes per frame (base64) | Phone CPU | Needs |
|---|---|---|---|
| A. PNG as lipstick writes it, no agent processing | 300 KB–1.5 MB (×1.33) | lipstick PNG encode only | nothing new |
| B. Agent decodes PNG, scales to width 360, JPEG quality 60 (recommended) | 20–60 KB (×1.33) | lipstick PNG encode + agent decode/scale/encode | `QT += gui` (`libQt5Gui`, JPEG plugin) |
| C. Lipstick writes JPEG directly (`.jpg` suffix), agent only scales (or not even that) | 60–200 KB full size, 20–60 KB scaled | lipstick JPEG encode (much cheaper than PNG) | the adaptor's path check must accept `.jpg` (M0.3) |

Recommendation: **B as the baseline, C if M0.3 proves lipstick accepts `.jpg`** (then the agent
skips the PNG decode and only scales; the protocol is the same). The agent gains `QT += gui`; the
phone has `libQt5Gui` (lipstick is Qt Quick) and the JPEG image-format plugin (the gallery needs
it); M0.2 confirms both and the package name for a `Requires:`. `QImage` works under a
`QCoreApplication` (no display, no `QGuiApplication`); image-format plugins load through the
normal plugin loader. Fallback if `libQt5Gui` or the JPEG plugin turns out to be missing: A, with
the format field set to `png`, at a lower frame rate.

Parameters in the request (all validated and clamped in the daemon): `width` (frame width in px,
0 = native, default 360, clamped 90..2160), `quality` (JPEG 1..100, default 60), `fps` (1..10,
default 4). The height follows the aspect ratio. Rotated frames (landscape apps) simply arrive as
1600×720 scaled to width; the panel fits whatever arrives.

Unchanged-screen suppression: before decoding, the agent hashes the raw file (`QCryptographicHash::Md5`,
~5–10 ms per MB on old hardware); if the hash equals the previous frame's, it sends a short
`{"frame":N,"same":true}` line instead of the image and skips decode/scale/encode. A phone idling on
a static screen then costs lipstick's capture and encode only, and the link almost nothing.

### 1.4 Target frame rate

Request 4 fps (250 ms ticks) and let the skip rule deliver what the phone can: expected 3–4 fps on
an Xperia 10 II/III, 1–2 fps on a Jolla Phone, 4 fps on the emulator. The panel shows the measured
rate so the user sees what they get. 4 is the default because above it lipstick's `grabWindow()`
on the GUI thread starts to visibly stutter the phone's own UI (M0.5 measures this); M0 numbers
can move the default (D1).

### 1.5 Pausing and stopping

- **Hidden** (`WebviewPanel.onDidChangeViewState` with `visible === false`, e.g. another editor
  tab in front): after a 1.5 s grace (quick tab switches do not reconnect) the extension cancels
  the run's `CancellationToken`; `SfdkRunner` sends SIGTERM (then SIGKILL after 5 s), `sfdk`
  exits, the ssh session closes, the client sees stdin EOF / stdout EPIPE and aborts the socket,
  the daemon's `MirrorStream` gets `disconnected` and stops its timer, deletes a pending frame
  file and `rmdir`s the staging folder. Same mechanism as `logs`, proven in T7 (gone within ~1 s).
- **Visible again**: a new `sfdk device exec … --request mirror` run (one ssh session setup,
  0.3–1.5 s). Until the first new frame arrives the panel shows the last frame it had, with a
  "reconnecting" badge. The extension keeps that one last frame (bounded).
- **Closed** (`onDidDispose`): cancel immediately, forget the frame.
- **Stream ends by itself** (device rebooted, WLAN dropped, Developer Mode turned off, agent
  stopped): the panel shows the reason and a Reconnect button; no automatic retry loop in 2a (D3).
- **VS Code exits**: the extension host dies, the child `sfdk` gets SIGHUP/EPIPE, same chain as
  above. Worst case the daemon stops when the ssh session is gone, which needs no cooperation from
  the PC.

`retainContextWhenHidden` stays `false` (the default): a hidden webview is cheap, and on re-show
the script posts `ready` and the extension re-sends the last frame.

### 1.6 Security model

Unchanged. The mirror is the Phase 1 screenshot capability repeated; it needs no new group, file,
port or rule, and it is gated by Developer Mode like `screenshot`. The daemon keeps **one mirror
per daemon**: a new `mirror` request ends a running one (`{"ok":false,"error":"replaced"}` on the
old connection), so two panels or a stale PC cannot double the load on the phone (D4). The
install consent text and the start notification should mention the live view (D10).

## 2. Protocol additions (existing requests unchanged)

`ping`, `screenshot` and `logs`, their arguments, replies, exit codes and the `SCREENSHOT_PATH_RE`
stay byte-for-byte as in `PLAN.md`. `ping` reports `"version":"1.1.0"`; the extension requires
`>= 1.1.0` for `mirror`.

New request, streamed, one JSON object per line, `\n` terminated, ASCII only (base64 and JSON):

```
{"cmd":"mirror","fps":4,"width":360,"quality":60}
```

| Line | When |
|---|---|
| `{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60}` | First line, once, with the values actually in effect after clamping. |
| `{"ok":false,"error":"developer mode is off"}` then disconnect | Developer Mode gate, as for `screenshot`. Also `"session bus not available: …"`, `"replaced"` (a newer mirror took over), `"malformed request"`. Fatal: the connection closes after it. |
| `{"frame":12,"ts":1791199286074,"screen":[720,1600],"size":[360,800],"format":"jpeg","data":"<base64>"}` | A frame. `screen` is lipstick's image size (after its rotation), `size` the sent image's size, `format` `jpeg` or `png`, `data` the whole file as one base64 string without line breaks. `ts` is the device's `QDateTime::currentMSecsSinceEpoch()` when the capture started. |
| `{"frame":13,"ts":…,"same":true}` | The screen did not change since the previous frame (file hash identical). |
| `{"frame":14,"ts":…,"error":"lipstick did not write the screenshot (is the screen on?)"}` | A soft error: the stream continues; the daemon retries at a slower pace (every 2 s) until a capture succeeds. Other soft errors: `"lipstick refused: …"`, `"cannot decode frame"`. |
| (connection closes) | The client went away (stdin EOF / stdout EPIPE) or the daemon stops. |

Frame numbers are consecutive per stream, including `same` and soft-error lines. Lines are at
most ~2 MB (a native-size PNG; the daemon refuses `width` above 2160 and the extension drops a
line longer than 4 MB as corrupt).

Client (`sailfish-devagent --request mirror [--fps N] [--width N] [--quality N]`): streaming like
`logs` (exits on stdin EOF or a failed stdout write), but it checks the **first line** and exits 1
if it is not `ok`. Exit codes stay 0/1/2/3. Agent 1.0.0 prints `unknown request "mirror"` and exits
2; the extension never gets there because it checks `ping`'s version first.

Daemon limits: `fps` 1..10, `width` 0 (native) or 90..2160, `quality` 1..100; anything else is
clamped, not refused, and the first line reports the effective values. The `mirror` branch in
`Agent::dispatch` is added next to the `logs` branch; the `cmd != screenshot && cmd != logs`
check becomes a set lookup so the three existing branches do not change.

Reserved for 2b, not implemented now: lines from the client to the daemon on the same connection
(`{"input":"tap","x":…,"y":…}`), which is why the frame carries both `screen` and `size` (the
scale factor the panel will need for coordinates) and why the client's stdin path is kept.

## 3. VS Code side

### 3.1 Command and panel

- Command `sailfish.agent.mirror`, title `Mirror Device Screen`, category `Sailfish`, icon
  `$(device-mobile)`, same enablement and menus as `sailfish.agent.screenshot` (inline on
  `hardware-device` and running emulators in the Devices/Emulators views, next to the camera),
  device resolved like the other agent commands (`resolveDevice`).
- One `WebviewPanel` per device, `viewType` `sailfish.mirror`, title `Mirror: <device>`, opened
  `ViewColumn.Beside`, `enableScripts: true`, `localResourceRoots: []` (the page is self-contained,
  no media files), `retainContextWhenHidden: false`. Running the command again for the same device
  reveals the existing panel. Panels live in a `Map<string, MirrorSession>` owned by the module.
- Before opening: `ensureAgent` as today (offers Install when missing), then the version check:
  `probe.version < 1.1.0` → warning "the device agent on … is 1.0.0; the screen mirror needs 1.1.0"
  with the item `Install Device Agent` (the existing install path upgrades: `rpm -U --replacepkgs
  --oldpackage`).
- Page content: a `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-N'; script-src 'nonce-N'">`,
  one `<img>` (`max-width:100%; max-height:100vh; object-fit:contain`, letterboxed on the editor
  background colour), a status strip (device, `screen` size, measured fps, state: connecting /
  live / paused / disconnected: reason) and a Reconnect button that is only shown when
  disconnected. The webview script posts `{type:'ready'}` on load, `{type:'shown',frame}` after
  each `img.onload`, `{type:'reconnect'}` from the button. It never sends anything else (no input
  in this phase).

### 3.2 Getting frames from `SfdkRunner` with bounded memory

```ts
services.runner.run({
  args: ['device', 'exec', '--', AGENT_BINARY, '--request', 'mirror', '--fps', '4', '--width', '360', '--quality', '60'],
  device, timeoutMs: NO_TIMEOUT, token: cts.token, collectOutput: false,
  onLine: (line, stream) => { if (stream === 'stdout') session.onLine(line); else session.lastStderr = line; },
});
```

- `collectOutput: false` means `SfdkResult.stdout/stderr` stay empty; `onLine` gets each complete
  line. A frame line (20–80 KB base64 at width 360) arrives in a few 64 KB chunks that the runner
  joins in `stdoutRest` until the `\n`; this is bounded by the longest line. No runner change is
  needed. (The runner's chunk-wise `toString('utf8')` is safe because the stream is ASCII.)
- `session.onLine` parses the line with `parseMirrorLine` (pure, in `mirrorCore.ts`), handles the
  first `status` line (not ok → show the error, mark disconnected), and hands frames to a
  `LatestFrame` gate: **at most one frame in flight to the webview and at most one pending; a
  newer pending frame replaces the older one** (dropped, counted). The gate releases the pending
  frame when the webview acks `shown`. So the session holds at most two frame strings plus the
  last frame kept for re-show, i.e. a few hundred KB, however long the panel is open.
- `same` lines only bump the counters (and the "live" badge); soft errors show in the status strip.
- When `run()` resolves: if `result.cancelled` it was us (hidden or closed), nothing to show;
  otherwise show "disconnected: <agent error from the last line | lastStderr | exit N>" with
  Reconnect.

### 3.3 Stopping cleanly

`MirrorSession` state: `idle | connecting | live | pausing | paused | disconnected | disposed`.

- `onDidChangeViewState`: visible → `start()` if not running (also clears a pending pause timer);
  hidden → arm the 1.5 s pause timer → `cts.cancel()`; the runner's SIGTERM/SIGKILL does the rest.
- `onDidDispose`: `cts.cancel()`, clear timers, delete from the map, drop the frame.
- Each `start()` creates a fresh `CancellationTokenSource`; the previous run's promise is awaited
  (it resolves when `sfdk` closes, usually within 100 ms of SIGTERM) before a new run starts, so
  two streams for one panel never overlap and the daemon's "replaced" rule is not triggered by
  our own reconnect.
- `ctx.subscriptions` gets a disposable that disposes every open panel on deactivate.
- The `Sailfish OS` output channel logs each start/stop with the reason at `info` level (the
  runner already logs the invocation and the exit code; the long frame lines are never logged
  because `collectOutput` is false).

### 3.4 Files

| File | Contents |
|---|---|
| `src/agent/mirrorCore.ts` (new, pure) | `MIRROR_DEFAULTS`, `MIRROR_MIN_AGENT_VERSION`, `compareVersions`, `agentSupportsMirror`, `mirrorRequestArgs`, `parseMirrorLine` (+ `MirrorLine` union), `isJpeg`, `LatestFrame` gate, `FpsMeter`, `mirrorHtml(nonce, device)`. |
| `src/agent/mirror.ts` (new) | `MirrorSession`, the panel map, `activateMirror(ctx, services)` registering `sailfish.agent.mirror`; uses `ensureAgent`/`probe` from `deviceAgent.ts` (exported, additive). |
| `src/agent/deviceAgent.ts` | export `ensureAgent`, `probe`, `requireDevice`; call `activateMirror` from `activateDeviceAgent` (additive). |
| `package.json`, `CHANGELOG.md`, `test/integration/activation.test.ts` | command, menus, `## v0.1.6`, expected id list. |
| `test/unit/agent/mirrorCore.test.ts`, `test/integration/mirror.test.ts`, fixtures | see M2, M5. |
| `device-agent/src/capture.{h,cpp}` (new), `mirror.{h,cpp}` (new), `screenshot.cpp`, `agent.cpp`, `client.cpp`, `main.cpp`, `sailfish-devagent.pro`, `rpm/sailfish-devagent.spec` | see M1. |
| `device-agent/README.md`, `README.md` Part 9 | protocol table row, user docs. |

No new setting (D7). No new media files (the page is inline), so `.vscodeignore` is unchanged.

## 4. Risks, and what to measure on a device first

Measure on the emulator first (root available, disposable), then on a phone if D5 allows. The
numbers decide D1 (defaults) and whether option C is possible.

| # | Risk | Measure | Threshold / consequence |
|---|---|---|---|
| R1 | Capture time: `grabWindow` + PNG encode at 720×1600 is too slow for a usable rate on old phones | M0.1: wall time of 10 consecutive `--request screenshot` calls on the device (centiseconds from `/proc/uptime`), and the PNG size | > 500 ms per frame → prefer option C or a lower default fps; the plan assumes 100–400 ms |
| R2 | Lipstick refuses a `.jpg` path | M0.3 | accepted → option C (lipstick encodes JPEG, the agent only scales); refused → option B |
| R3 | `libQt5Gui` or the JPEG plugin missing on some phone | M0.2 (`ls /usr/lib/libQt5Gui.so.5 /usr/lib/qt5/plugins/imageformats/`, `rpm -qf` of the plugin) | missing → option A (`png`, native size) as a fallback branch in the agent, chosen at runtime by `QImageWriter::supportedImageFormats()` |
| R4 | Phone CPU and UI stutter while mirroring (`grabWindow` blocks the compositor) | M0.5: `top -b -n 3 -d 2` on the device and a visual check of a scrolling list while a 4 fps stream runs (needs M1) | > ~40 % of one core on an Xperia 10 or visible stutter → default fps 2–3 |
| R5 | Link throughput and session latency over WLAN/USB | M0.4: `time sfdk device exec … -- true` (setup latency) and `time sfdk device exec … -- sh -c 'head -c 3000000 /dev/zero \| base64' > /dev/null` (bytes/s) | < 300 KB/s → width 360 and quality 50; setup latency sets the hide grace |
| R6 | Flash wear: each frame is a file write under `$HOME` (1 MB PNG at 4 fps = 4 MB/s) | M0.6: `cat /sys/block/mmcblk0/stat` (or the home partition's device) before and after 60 s of mirroring; also whether a symlinked `~/sailfish-devagent` → `/run/user/100000/…` (tmpfs) passes the path check | if writes reach the flash, use the tmpfs symlink (if accepted) or option C; the file is deleted within ~100 ms, so delayed allocation should drop most of it |
| R7 | `sfdk device exec` buffers stdout so frames arrive late or in bursts | M0.7 (needs M1): on the PC `sfdk device exec … --request mirror --fps 2 \| while read -r l; do date +%T.%N; done` — lines ~500 ms apart, not grouped | grouping → run the stream with `-t -t` (pty) as D7 of Phase 1 considered, but then base64 must tolerate `\r\n` (it does, `splitLines` strips them) |
| R8 | Screen off / lock screen: lipstick does not write (Phase 1 saw the 10 s timeout) | M0.8: mirror with the display off | soft-error line, 2 s retry; the agent's per-capture timeout drops from 10 s to 3 s for mirror frames |
| R9 | Two mirrors (two VS Code windows, a stale PC) double the load | design: one per daemon, "replaced" | M6 checks the second connection gets `replaced` and the first stops |
| R10 | A frame line is split by `\r\n` or mangled | no pty, same as the `base64` fetch in Phase 1 | `parseMirrorLine` returns undefined for a bad line; the session counts and ignores it, and shows "disconnected: corrupt stream" after 10 in a row |

## 5. Tasks

Owners: **coding** = write code and tests exactly as specified; **decision** = decide, measure,
debug, run the emulator. Commands needing node: node 22 is not on the login PATH; prefix with
`export PATH=<node-22 bin dir>:$PATH` (the same directory PLAN.md section B uses). Every `sfdk`
call: `timeout -s KILL <secs> ~/SailfishOS/bin/sfdk … </dev/null`.
Emulator: VM `SailfishOS-5.1.0.11`, device name `Sailfish OS Emulator 5.1.0.11`, root over
`ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2223 -i ~/SailfishOS/vmshare/ssh/private_keys/sdk root@127.0.0.1`.
`jolla-developer-mode` is installed on it; the agent is not (install the 1.0.0 i486 RPM from
`media/agent/i486/` for M0, the 1.1.0 one for M6).

Parallel groups: **G1** (all parallel, nothing depends on code that does not exist yet): M0, M1,
M2, M3. **G2**: M4 (after M2, M3). **G3**: M5 (after M4), M6 (after M1, M4; uses M0's numbers).
**G4**: M7 (after M6), M8 (after everything).

**M0 — Measurements on the emulator, then a phone if allowed (decision).** Depends on nothing (agent
1.0.0 RPM exists). Install 1.0.0 on the emulator as in T7 step 1 (`rpm -U` over root ssh). Then:
1. Capture time and size: over root ssh, `su defaultuser -s /bin/sh -c 's=$(cut -d" " -f1 /proc/uptime); for i in 1 2 3 4 5 6 7 8 9 10; do sailfish-devagent --request screenshot >/dev/null; done; e=$(cut -d" " -f1 /proc/uptime); echo "$s $e"; ls -l /run/user/100000/sailfish-devagent/'`
   → record (e−s)/10 s per frame and the PNG sizes; then `rm -f /run/user/100000/sailfish-devagent/shot-*.png`. (`su` as root on the emulator only; on a phone the same loop runs through `sfdk device exec` as defaultuser, no root.)
2. Qt pieces: `ls -l /usr/lib/libQt5Gui.so.5 /usr/lib/qt5/plugins/imageformats/` and `rpm -qf /usr/lib/qt5/plugins/imageformats/libqjpeg.so` (record the package name for the spec's `Requires:`).
3. JPEG suffix: as root, `systemd-run --uid=100000 --gid=995 --setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/100000/dbus/user_bus_socket --wait dbus-send --session --print-reply --dest=org.nemomobile.lipstick /org/nemomobile/lipstick/screenshot org.nemomobile.lipstick.saveScreenshot string:/home/defaultuser/sailfish-devagent/m0.jpg`
   (the primary gid 995 is what passed lipstick's check in T7; `mkdir -p /home/defaultuser/sailfish-devagent && chown defaultuser:privileged` it first). Record the reply, then `file /home/defaultuser/sailfish-devagent/m0.jpg` and its size; try `.png` the same way for a size comparison; remove the folder.
4. Link: `time timeout -s KILL 60 ~/SailfishOS/bin/sfdk device exec "Sailfish OS Emulator 5.1.0.11" -- true </dev/null` three times, and `time timeout -s KILL 120 ~/SailfishOS/bin/sfdk device exec "Sailfish OS Emulator 5.1.0.11" -- sh -c 'head -c 3000000 /dev/zero | base64' </dev/null >/dev/null`.
5. CPU baseline: `top -b -n 2 -d 2 | head -15` on the device while the loop of step 1 runs (the stream itself is measured in M6).
6. Flash: `cat /sys/block/*/stat` before and after step 1 (which device holds `/home`: `df /home`). Symlink test: `ln -s /run/user/100000/sailfish-devagent /home/defaultuser/sailfish-devagent` as defaultuser, then one `--request screenshot`; record whether lipstick accepts it; remove the link.
7. and 8. need M1's agent (recorded in M6).
Acceptance: a "M0 results" subsection in this file with every number, the emulator restored (agent removed with `rpm -e sailfish-devagent`, no symlink, no `m0.*` files), and D1 answered with the numbers. Phone: only if D5 says yes; then steps 1, 2, 4, 5 through `sfdk -c 'device=…' device exec`, no root, and the agent is uninstalled afterwards unless the user wants it kept.

**M1 [DONE: build.sh exit 0 for aarch64/armv7hl/i486, each RPM reports sailfish-devagent 1.1.0-1; emulator acceptance not run (M6)] — Agent 1.1.0: `mirror` request (coding).** Files: `device-agent/src/capture.{h,cpp}` (new),
`device-agent/src/mirror.{h,cpp}` (new), `device-agent/src/screenshot.{h,cpp}`, `src/agent.{h,cpp}`,
`src/client.cpp`, `src/main.cpp` (usage text), `sailfish-devagent.pro`, `rpm/sailfish-devagent.spec`.
Depends on nothing (M0's numbers only change constants). Interfaces:
- `class Capture : public QObject { Capture(const QString &stagingPath, int timeoutMs, QObject *parent); void start(); signals: void finished(const QString &error); }` — the D-Bus call plus the poll-until-stable loop moved out of `Screenshot` unchanged (`POLL_MS` 100; timeout as given: 10 000 for `screenshot`, 3000 for mirror). `Screenshot` keeps its public shape (`take()`, `finished(QJsonObject)`) and its reply text, and now uses `Capture` plus the existing move.
- `class MirrorStream : public QObject { MirrorStream(QLocalSocket *socket, int fps, int width, int quality); }` owned by the socket like `LogStream`: writes the first `ok` line, runs a `QTimer` at `1000/fps` ms; on tick skips when a capture is running or `m_socket->bytesToWrite() > 0` (counts drops, logged to stderr every 100 drops), otherwise `Capture`s `<staging>/mirror-<seq>.<ext>` (`ext` = `jpg` when `Paths::lipstickWritesJpeg()`, a compile-time constant set after M0.3, default `png`); on success reads the file, deletes it, Md5s the bytes → `same` line if equal to the previous hash; else `QImage::fromData`, `scaledToWidth(width, Qt::SmoothTransformation)` when `width > 0 && width < image.width()`, `save(&buffer, "JPEG", quality)` (if `QImageWriter::supportedImageFormats()` lacks `jpeg`, send the raw file bytes with `"format":"png"` and no scaling), `toBase64()`, one line, `flush()`. Soft errors become `{"frame":N,"ts":…,"error":…}` lines and switch the timer to 2000 ms until the next success. `disconnected` → stop the timer, delete a pending `mirror-*` file, `rmdir` the staging folder if empty.
- `Agent`: `m_mirror` (a `QPointer<MirrorStream>`); a new `mirror` request deletes the current one after writing `{"ok":false,"error":"replaced"}` to its socket and disconnecting it. Argument clamping as in section 2.
- Client: `mirror` joins the allowed set; `--fps`, `--width`, `--quality` parsed like `--lines`; `streaming` true; the first line is checked for `ok` unless `cmd == logs`.
- `.pro`: `QT = core dbus network gui`, `AGENT_VERSION = 1.1.0`; spec: `Version: 1.1.0`, `BuildRequires: pkgconfig(Qt5Gui)`, `Requires: <jpeg plugin package from M0.2>` (omit if M0.2 finds none), `%description` mentions the live view.
Acceptance (emulator, after `device-agent/build.sh` exits 0 and `rpm -U` of the i486 RPM over root ssh):
`timeout -s KILL 60 ~/SailfishOS/bin/sfdk device exec "Sailfish OS Emulator 5.1.0.11" -- sailfish-devagent --request ping </dev/null` → `"version":"1.1.0"`;
`timeout -s KILL 60 ~/SailfishOS/bin/sfdk device exec "Sailfish OS Emulator 5.1.0.11" -- sailfish-devagent --request mirror --fps 2 --width 360 </dev/null | head -n 4 > /tmp/m1.txt; sed -n 1p /tmp/m1.txt` → `{"ok":true,"stream":"mirror","fps":2,"width":360,"quality":60}`;
`sed -n 2p /tmp/m1.txt | sed 's/.*"data":"//; s/".*//' | base64 -d | file -` → `JPEG image data … 360x800` (or `PNG` if the fallback branch is active, which M0.2 must have predicted);
`--request screenshot` still returns `{"ok":true,"path":"/run/user/100000/sailfish-devagent/shot-<ms>.png"}` and `--request logs --lines 3` still streams journal lines;
after `head` exits, within 5 s `ls /home/defaultuser/sailfish-devagent` fails (folder gone) and `journalctl -u sailfish-devagent -n 3` shows a "mirror stopped" line; `--request mirror --fps 99 --width 10 --quality 0 | head -n 1` → the line reports `"fps":10,"width":90,"quality":1`.

**M2 — `mirrorCore.ts` and unit tests (coding) — DONE.** Files: `src/agent/mirrorCore.ts` (new),
`test/unit/agent/mirrorCore.test.ts` (new). Depends on nothing (the protocol in section 2 is the
spec). Exports: `MIRROR_DEFAULTS = { fps: 4, width: 360, quality: 60 }`, `MIRROR_MIN_AGENT_VERSION = '1.1.0'`,
`compareVersions(a, b): -1|0|1` (numeric dotted; missing parts are 0; a non-numeric part compares as 0),
`agentSupportsMirror(version: string): boolean`, `mirrorRequestArgs(o: MirrorOptions): string[]`
(→ `['sailfish-devagent','--request','mirror','--fps','4','--width','360','--quality','60']`),
`type MirrorLine = {kind:'status', ok:true, fps, width, quality} | {kind:'fatal', error} | {kind:'frame', frame, ts, screen:[w,h], size:[w,h], format:'jpeg'|'png', data} | {kind:'same', frame, ts} | {kind:'soft-error', frame, ts, error}`,
`parseMirrorLine(line: string): MirrorLine | undefined` (undefined for non-JSON, missing fields,
`data` not base64 charset, a line over 4 MB), `isJpeg(buf: Buffer)` (`ff d8 ff`), `class LatestFrame { offer(f): F | undefined; acked(): F | undefined; readonly dropped: number }`
(offer returns the frame to post now if nothing is in flight, else stores it as pending and returns
undefined, replacing an older pending one and incrementing `dropped`; `acked` returns the pending
frame to post next, if any, and marks it in flight), `class FpsMeter { tick(nowMs): void; fps(nowMs): number }`
(frames in the last 3 s / 3), `mirrorHtml(nonce: string, device: string): string` (the page from 3.1;
the test asserts the CSP meta, that `nonce` appears on every `<script>`/`<style>`, that the device
name is HTML-escaped, and that there is no `on*=` handler). Add `'test/unit/agent/*.ts'` to eslint's
`allowDefaultProject` if the existing entry does not already cover it (it does, from T3).
Acceptance: `npm run check:types`, `npm run lint`, `npm run test:unit` exit 0 (previous count 359 + the new tests).

**M3 — Manifest, changelog, activation list (coding). DONE.** Files: `package.json`, `CHANGELOG.md`,
`test/integration/activation.test.ts`. Depends on nothing (can start before M4; `check:manifest`
fails on the undeclared/unregistered mismatch until M4 lands, as in Phase 1's T0/T1). Add to
`contributes.commands`: `sailfish.agent.mirror`, title `Mirror Device Screen`, category `Sailfish`,
icon `$(device-mobile)`, enablement `sailfish.sdkAvailable && sailfish.platformSupported`. Menus
(`view/item/context`): `group: "inline"` for `view == sailfish.devices && viewItem == hardware-device`
and `view == sailfish.emulators && viewItem =~ /^emulator(\\.running)?$/` (same two clauses as the
screenshot button), placed after `sailfish.agent.screenshot`. No `activationEvents` change, no
settings. `"version": "0.1.6"` in `package.json` and `package-lock.json` (top two occurrences). `## v0.1.6`
above `## v0.1.5` in `CHANGELOG.md`: one bullet for `Mirror Device Screen` (what it shows, view
only, a few frames per second, pauses when hidden, needs agent 1.1.0 and offers the upgrade) and one
for agent 1.1.0 (`mirror` request; `ping`/`screenshot`/`logs` unchanged). Add `sailfish.agent.mirror`
to the `expected` list in `activation.test.ts`.
Acceptance: `grep -c '"version": "0.1.6"' package.json` = 1; `npm run test:unit` (schema test) green;
after M4, `npm run check:manifest` → `check-manifest: OK`.

**M4 — Panel and session: `mirror.ts` (coding). DONE.** Files: `src/agent/mirror.ts` (new),
`src/agent/deviceAgent.ts` (export `ensureAgent`, `probe`, `requireDevice`; call `activateMirror(ctx, services)`
at the end of `activateDeviceAgent`). Depends on M2, M3. Implements sections 3.1–3.3 exactly:
`MirrorSession` with the state machine, the 1.5 s hide grace (`HIDE_GRACE_MS`), the `LatestFrame`
gate driven by `shown` acks, `ready` → re-send the last frame, `reconnect` → `start()`, the
"replaced"/fatal first line → disconnected with the reason, the 10-corrupt-lines rule, one panel
per device, dispose on deactivate. All messages through `services.prompts`. `postMessage` payloads:
`{type:'frame', frame, format, data, screen, size}`, `{type:'state', state, reason?, fps?, screen?}`.
Acceptance: `npm run check:types && npm run lint && npm run build && npm run check:manifest` exit 0;
in the Extension Development Host against the fake sfdk (`SFDK_FAKE_SCENARIO` unset, fixtures from
M5): the command opens `Mirror: Xperia 10 - Dual SIM (ARM)` showing the fixture's 1×1 image scaled
up, and the status strip reads `live`.

**M5 — Fake sfdk fixtures and integration tests (coding). DONE (7 tests, plus an `agent-new` scenario: default ping stays 1.0.0 for the status test, so the live-stream tests use ping 1.1.0 from `agent-new`).** Files:
`test/fixtures/sfdk/scenarios/default/device_exec.sailfish-devagent.mirror.stdout` (line 1 the `ok`
status line with fps 4 / width 360 / quality 60; lines 2–4 three frames `frame` 1..3 with
`"screen":[720,1600],"size":[1,1],"format":"png"` and `data` = the base64 of the 1×1 PNG already in
`device_exec.base64.stdout`, joined to one string; line 5 `{"frame":4,"ts":1791199287074,"same":true}`),
`….mirror.stream` = `50`, `….mirror.hang` (empty; the fake then stays alive until SIGTERM and logs a
`killed` event, which is how "stops cleanly" is asserted), scenario `agent-old/` (`PROVENANCE.md`,
`device_exec.sailfish-devagent.ping.stdout` = `{"ok":true,"version":"1.0.0","developerMode":true}`,
`….mirror.stderr` = `sailfish-devagent: unknown request "mirror"`, `….mirror.exit` = `2`),
`test/integration/mirror.test.ts` (new; setup like `agent.test.ts`, `TEST_MODE=full`, device
`Xperia 10 - Dual SIM (ARM)`), `CONVENTIONS.md` (one line in the fake key table noting `.hang` +
`.stream` together make a live stream). Tests:
1. open: `executeCommand('sailfish.agent.mirror')` → within 5 s the fake log has `device_exec.sailfish-devagent.ping` then `device_exec.sailfish-devagent.mirror` with argv containing `--fps`, `4`, `--width`, `360`, `--quality`, `60`; `vscode.window.tabGroups.all` has a tab labelled `Mirror: Xperia 10 - Dual SIM (ARM)`; no error message.
2. reveal, not duplicate: run the command again → still exactly one such tab; no second `…mirror` invocation within 2 s (the stream is still running; the fake `hang`s).
3. close stops the stream: `workbench.action.closeActiveEditor` on that tab (make it active first with the command, which reveals it) → within 8 s `readFakeLog().killed` contains an event with `key === 'device_exec.sailfish-devagent.mirror'`.
4. hidden pauses, visible resumes: open the mirror, then `vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: 'x' }), { viewColumn: <the mirror's column>, preview: false })` → within 5 s a `killed` event; run the mirror command again (reveals the panel) → within 5 s a second `…mirror` invocation. Close everything.
5. old agent: `withScenario('agent-old')` → a warning message containing `1.1.0` with item `Install Device Agent`; no `…mirror` invocation.
6. `withScenario('agent-devmode-off')` → error message containing `Developer Mode is off`, no `…mirror` invocation.
7. `withScenario('agent-missing')`, `chosenAction` undefined → warning with `Install Device Agent`, no `device_exec.devel-su`.
`teardown`: close all editors, `clearFakeLog()`. Acceptance: `npm run build && TEST_MODE=full npm run test:integration` passes with 105 + 7 tests; `npm run lint` clean; `test/fixtures/sfdk/unrecorded.log` gains no `mirror` line.

**M6 — End to end on the emulator (decision).** Depends on M1, M4 (and M0 for the comparison). Install
the 1.1.0 i486 RPM (`rpm -U --replacepkgs --oldpackage` over root ssh), then in the Extension
Development Host with the real sfdk and device `Sailfish OS Emulator 5.1.0.11`:
1. Open the mirror; record the fps shown after 10 s, and `top -b -n 3 -d 2 | head -15` on the device meanwhile (R4). Scroll the app grid on the emulator and note whether the panel follows and whether the emulator UI stutters.
2. Hide (open a file in the same column) → `pgrep -a sfdk` on the PC shows no `device exec … mirror` within 3 s; on the device `journalctl -u sailfish-devagent -n 2` shows "mirror stopped" and `ls /home/defaultuser/sailfish-devagent` fails. Show again → frames resume; close → same checks as hide.
3. `Take Device Screenshot` while mirroring → the PNG saves normally; the mirror keeps running.
4. Replaced: with the panel live, run `timeout -s KILL 30 ~/SailfishOS/bin/sfdk device exec "Sailfish OS Emulator 5.1.0.11" -- sailfish-devagent --request mirror </dev/null | head -n 2` on the PC → the panel shows `disconnected: replaced` with Reconnect; Reconnect → live again (and the shell stream ends).
5. Screen off (`mcetool --blank-screen` if present, else the VM's power key via `VBoxManage controlvm "SailfishOS-5.1.0.11" keyboardputscancode …`, or just lock it from the UI) → the strip shows the soft error, and recovers when the screen is on again (R8).
6. R7: the `date +%T.%N` loop from the risks table, 2 fps, 10 lines → spacing ~500 ms.
7. Kill VS Code's extension host (`Developer: Restart Extension Host`) with the panel live → within 10 s the device shows no mirror running (step 2's checks).
8. `rpm -e sailfish-devagent`; the emulator may stay running. Record every result in an "M6 results" subsection here; anything that fails goes back to M1/M4 with the evidence.

**M7 — Docs, RPM rebuild, plan text (coding).** *Docs part done (device-agent/README.md, README.md Part 9); the RPMs were already built.* Depends on M6. Files: `device-agent/README.md`
(protocol table: the `mirror` row and the line types, `QT += gui`, the version), `README.md`
Part 9 (a "Mirror Device Screen" paragraph: what it shows, view only, pauses when hidden, needs
agent 1.1.0, the upgrade prompt; one troubleshooting row for "mirror says disconnected: replaced"),
`device-agent/PLAN.md` ("Later phases": point Phase 2 mirror at this file), `media/agent/<arch>/`
(rebuild all three with `device-agent/build.sh`; remove the 1.0.0 RPMs; `pickAgentRpm` picks the
newest by name, so the 1.1.0 files must sort after 1.0.0, which they do). Acceptance:
`ls media/agent/*/` shows exactly one `sailfish-devagent-1.1.0-1.<arch>.rpm` per arch;
`timeout -s KILL 120 ~/SailfishOS/bin/sfdk engine exec -- rpm -qp --qf '%{ARCH} %{VERSION}-%{RELEASE}\n' <abs path> </dev/null` → `<arch> 1.1.0-1` for each;
`npm run check:proprietary` OK; `npx vsce ls --no-dependencies | grep media/agent` lists three `.rpm` files.

**M8 — Final gate and VSIX (coding, last).**
`npm run check:types && npm run lint && npm run test:unit && npm run test:fuzz && npm run check:manifest && npm run check:proprietary && npm run build && TEST_MODE=full npm run test:integration`,
then `npx vsce package --no-dependencies --out ~/Downloads/sailfish-tools-0.1.6.vsix`,
`unzip -p ~/Downloads/sailfish-tools-0.1.6.vsix extension/package.json | grep -m1 '"version"'` → `0.1.6`,
`unzip -l ~/Downloads/sailfish-tools-0.1.6.vsix | grep -E 'media/agent/.*1\.1\.0.*\.rpm'` → three lines,
`unzip -l … | grep -c device-agent/` → 0. Tick the tasks in this file with the counts.

## 6. Open decisions for review

- **D1 Frame defaults after M0.** Plan: `fps` 4, `width` 360, `quality` 60, JPEG. Lower the fps if
  M0.1 shows > 300 ms per capture on the emulator (phones are faster than the VM's software GL, so
  the emulator number is a pessimistic bound) or if M6 step 1 shows stutter; raise `width` to 540
  if the link (M0.4) gives > 1 MB/s and the capture is cheap.
- **D2 Push with drop (recommended) or pull via stdin ticks.** Push needs no runner change and
  gets back-pressure for free; pull needs `SfdkRunOptions` to grow a writable stdin and proof that
  `sfdk device exec` forwards small writes promptly. Pull becomes attractive in 2b, when stdin
  carries input anyway.
- **D3 Reconnect policy.** Plan: no automatic retry; a Reconnect button and the reason. Alternative:
  up to 3 automatic retries 2 s apart, then the button. Automatic retries hide a device that is
  rebooting but also keep hammering a phone whose Developer Mode was just switched off.
- **D4 One mirror per daemon with "replaced" (recommended), or allow several, or refuse the second.**
  Refusing makes the panel's own reconnect race with the dying previous session (the daemon sees
  the disconnect ~1 s after SIGTERM); allowing several doubles the phone load silently.
- **D5 Measuring on a real phone requires installing the agent there** (one password prompt,
  `rpm -U`), which Phase 1's brief forbade. The emulator's numbers are a pessimistic bound for
  capture time (software GL) and useless for the link (loopback). Ask the user whether one phone
  may get the agent now; otherwise ship with the emulator's numbers and the fps shown in the panel.
- **D6 Upgrade UX.** Plan: the existing `Install Device Agent` flow upgrades (it already passes
  `--replacepkgs --oldpackage`), with a warning that names both versions. Alternative: a separate
  "Upgrade Device Agent" title for the same command when a lower version is installed.
- **D7 No new settings (recommended).** `width`/`quality`/`fps` stay constants in `mirrorCore.ts`;
  a settings key would need the schema test and README updates and nobody has asked for it. If a
  knob is wanted later, a "Full resolution" toggle in the panel is better than a setting.
- **D8 Staging in tmpfs via a symlink** (`~/sailfish-devagent` → runtime dir) if M0.6 shows
  lipstick accepts it: avoids flash writes entirely. It changes Phase 1's `screenshot` path too
  (the move becomes a rename within tmpfs), which is harmless but must be re-tested (T7 step 3).
- **D9 Editor-area `WebviewPanel` (recommended, the user asked for a panel) or a `WebviewView` in
  the Sailfish sidebar container.** The sidebar suits a 9:20 phone shape and stays visible while
  editing, but it is narrow, it shares the container with the SDK/Emulators/Devices trees, and
  hide/show semantics differ (`WebviewView.onDidChangeVisibility`). Could be a 2b follow-up.
- **D10 Consent and notification text.** `installConsentDetail` and the start notification say
  "take screenshots and read system logs"; the mirror is screenshots repeated. Recommendation:
  add "including a live view of the screen" to both (agent 1.1.0 and extension 0.1.6), so the
  consent step stays an honest description.
- **D11 Release shape.** Ship 2a as extension 0.1.6 with agent 1.1.0, or hold it until 2b (input)
  so the agent's version and the consent text change once. The plan assumes a separate 0.1.6.

## Decisions (2026-10-05)

- **D1 → start with fps 4, width 360, JPEG q60**; revisit only if M0's numbers show the phone or link cannot sustain it.
- **D2 → push with drop** (as recommended): the daemon skips a tick while a capture is in flight or output is unsent.
- **D3 → reconnect by button only.** No automatic retries.
- **D4 → one mirror per daemon; the older connection gets "replaced".**
- **D5 → no real-phone install for measurements yet.** Measure on the emulator now. The real-phone numbers come from the user's Phase 1 install test, which installs the agent with their consent; M0 lists what to measure then.
- **D6 → upgrade through the existing Install flow** (it already upgrades with `rpm -U`).
- **D7 → no new settings.**
- **D8 → no tmpfs symlink now.** Keep the Phase 1 staging path unchanged; revisit only if M0 shows flash writes per frame are a real problem.
- **D9 → editor WebviewPanel.**
- **D10 → yes**: the consent text and the start notification mention the live screen view.
- **D11 → ship 2a as 0.1.6** after 0.1.5 has passed the real-phone test; do not hold for 2b.
