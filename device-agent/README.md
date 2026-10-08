# sailfish-devagent

A small developer agent for Sailfish OS devices, in the same spirit as Android's `adbd`. The user
grants permission once, when installing it; after that VS Code can take screenshots, read the
system log, and show and control a live view of the screen, without asking for the developer-mode
password each time. It only serves while Developer Mode is on.

It is plain Qt (`core`, `dbus`, `network`, `gui`), with no Silica. One binary has two modes:

- `sailfish-devagent --daemon` is the systemd service.
- `sailfish-devagent --request <cmd>` is the client. It connects to the daemon's socket, sends the
  request and copies the reply to stdout. The extension runs it through `sfdk device exec`.

## Building the RPMs

Needs the Sailfish SDK with the `SailfishOS-5.1.0.11` targets for `aarch64`, `armv7hl` and `i486`.

Since 1.3.0 the build also needs `wayland-client` (`pkgconfig(wayland-client)`) and the
`wayland-scanner` tool (`wayland-devel`), both listed as `BuildRequires` in the spec; the RPM requires
`libwayland-client.so.0`. The `.pro` runs `wayland-scanner` over `protocol/lipstick-recorder.xml` to
generate the client code. That file is Lipstick's private screen recorder protocol, copied unchanged
from the lipstick tree (<https://github.com/sailfishos/lipstick>, `protocol/lipstick-recorder.xml`,
last changed in commit `5483b9da7f9a`, 2020-04-15). It carries its own MIT-style permission notice
(Copyright 2014 Jolla Ltd.), which must stay with the file; a comment at the top gives the source.
`wayland-scanner` prints "XML failed validation against built-in DTD" for it (a misspelt
`description` attribute upstream); this is harmless. The generated files are not committed and
`build.sh` removes them between architectures.

Since 1.6.0 the build also needs `libvpx-devel` (`pkgconfig(vpx)`) for VP8. It is listed as a
`BuildRequires`; RPM dependency generation adds the matching runtime library.

```sh
device-agent/build.sh
```

For each architecture the script runs `sfdk -c target=SailfishOS-5.1.0.11-<arch> -c no-fix-version
build` (without `no-fix-version`, sfdk stamps the repository's git tag as the package version),
cleans the tree between architectures, and copies the result to
`media/agent/<arch>/sailfish-devagent-<version>-<release>.<arch>.rpm`. Set `SFDK` to use an sfdk
other than `~/SailfishOS/bin/sfdk`. The RPMs are unsigned and are shipped inside the VSIX; rebuild
them by hand whenever the agent changes.

### Building in Docker (no SDK, no VirtualBox)

```sh
device-agent/build.sh --docker [--arch aarch64,armv7hl,i486] [--out DIR] [--no-install] [--privileged]
```

Builds each architecture out of tree in the community Sailfish platform SDK image, pinned by
digest in `docker/IMAGE` (`--image REF` overrides it). It needs `docker` (or `podman`, or set
`DOCKER`; podman is untested) and a user who may talk to the daemon; the SDK and its VMs are not
used, and the working tree stays clean. The first run pulls about 4.7 GB (about 5 GB on disk).
Each build also downloads two missing build dependencies (libvpx-devel, wayland-devel, about
130 KiB) from Jolla's repositories, so it needs network access. A build takes about 40 s per
architecture (all three in about 2 minutes on a ThinkPad T14s).

- The sources are copied (without build leftovers) to `$XDG_CACHE_HOME/sailfish-devagent/build/<arch>/src`
  (`--out` changes the base directory) and mounted read-only. Inside the container, as the image
  user `mersdk`, they are copied to `$HOME/build` and built with
  `mb2 -X -t SailfishOS-5.1.0.11-<arch> build` (not under `/tmp`: sb2 maps `/tmp` to the
  target's own). RPMs, the full `build.log` and `rpmlint.txt` land in `<out>/<arch>/out/`, owned
  by the host user.
- Without `--no-install` they are also copied to `media/agent/<arch>/` of the current checkout,
  as the default build does. A result whose release is not `1` is rejected.
- `rpmlint` is the check mb2 runs after every build (the sfdk build prints the same findings).
  The script fails on any error not listed in `docker/rpmlint-baseline.txt` and reports new
  warnings.
- The container needs no extra privileges, and runs with none by default (`--no-privileged` is
  accepted and means the same). `--privileged` is optional and not recommended: it lifts the
  container's AppArmor profile, and on hosts whose AppArmor confines `unix_chkpwd` (Ubuntu 24.04
  and later) every `sudo` inside the container then fails, so mb2 cannot install the build
  dependencies. `SAILFISH_DOCKER_RUN_ARGS` adds extra `docker run` arguments.
- The result matches the sfdk build: same version and release (1.10.3-1), file list, owners and
  modes, requirements, provides and scriptlets (checked for i486 on 2026-10-07).
- Without Docker the script stops with an installation hint. Plain `device-agent/build.sh` (or
  `--sdk`) is unchanged and still uses sfdk and the SDK build engine.

## Security model

- Runs as `defaultuser`, not root, with two **extra** groups: `privileged` (set as the primary group
  with `Group=`, so lipstick accepts its screenshot call and lets it bind the screen recorder) and `systemd-journal` (to read the
  journal). systemd also gives the process `defaultuser`'s normal groups, including `input`.
  Agent 1.7.0 uses that existing access only for the fixed tap/swipe mirror protocol described
  below; it never grabs the touchscreen, so physical input keeps working.
  The `SupplementaryGroups=privileged`-only variant has not been tested.
- Listens on a Unix socket only (`/run/user/100000/sailfish-devagent/agent.sock`, mode 0600, owned
  by `defaultuser`). There is no TCP or UDP listener; the only way in is the SSH login VS Code
  already has.
- The faster mirror (extension 0.1.7) uses an SSH port forward, which is a channel inside that same
  SSH login: `sshd` opens the agent socket on the phone as `defaultuser`, so nothing new listens on
  the phone. On the PC, the forward uses only the device's registered key, no `~/.ssh/config`, and a
  private socket (mode 0600 in a 0700 directory) that is removed when the panel closes.
- Host keys are pinned: the extension keeps its own known-hosts file, fills it from the keys the SDK
  connection reports (not trust on first use), runs ssh with `StrictHostKeyChecking=yes`, and refuses
  a changed key. An emulator is re-pinned automatically; a phone needs the user's **Trust New Key**.
- A mirror stream is a lease: it ends by itself 60 s after the last keepalive from VS Code (sent
  every 20 s while the panel is visible), so a hung or disconnected PC cannot leave the screen
  streaming.
- Remote input has a separate 3 s focus lease. It is opt-in per mirror, accepts only bounded taps
  and one-finger swipes, and has a rolling rate limit. VS Code renews it once a second only while the
  mirror panel and its window are focused and the current frame reports native capture; blur, hide,
  close, capture fallback and stream cleanup cancel any contact and stop renewal. Since 1.10.3 a
  phone with a hardware keypad also accepts press and release of one whitelisted keypad key
  (0-9 * # OK UP DOWN LEFT RIGHT MENU BACK CALL F21 F22 F23) under the same lease, switch, rate
  limit and indicator. There is no text, power, volume or arbitrary key code input.
- While a stream runs, the agent keeps one notification on the phone ("Screen is being viewed from
  VS Code"). Remote input remains disabled until an asynchronous notification call confirms the
  change to "Screen is being controlled from VS Code"; failure therefore leaves the stream
  view-only. That security-significant transition also shows a banner. It is closed about 10 s after the
  stream ends. A viewing banner is shown only when no stream has run for 5 minutes. The start notice
  ("Developer agent is running") is one entry while the daemon runs; it shows a banner once per
  installation (`/var/lib/sailfish-devagent/notice-shown`), the daemon closes it (and any stream
  entry) when it stops, and later starts post it again silently. Removing the package closes any
  entry left by a daemon that did not stop cleanly.
- On every request, valid stream keepalive and input activation it checks that Developer Mode is on
  (`jolla-developer-mode` installed, `/usr/bin/devel-su` present). A failed renewal ends the stream.
- Accepts a fixed set of commands with validated arguments. Nothing is passed to a shell.
- Removable: `rpm -e sailfish-devagent` (or **Uninstall Device Agent** in VS Code) leaves nothing
  behind. On erase (not on an upgrade, which keeps the settings) `%preun` stops and disables the
  service, whose SIGTERM handler closes its notifications and removes the socket directory and any
  staged screenshot, then closes the agent's notifications as `defaultuser`; `%postun` removes
  `/var/lib/sailfish-devagent`, the RPM copy in `/tmp`, a socket directory or staged screenshots a
  crashed daemon left, the `multi-user.target.wants` link and the unit's failed state, and closes a
  running Settings app (`pkill -u defaultuser -x jolla-settings`, never lipstick) so it drops the
  entry. `%post` closes it too, so a new or changed page shows the next time Settings opens. VS
  Code repeats the root steps for agents whose scriptlets predate them (1.10.0), then removes what
  the device user may remove (`~/.cache/sailfish-tools` included), closes leftover notifications
  over the session bus and checks read-only that nothing is left. The journal keeps the agent's past
  log lines; they rotate out like any other service's.

## Protocol

One request per connection: one JSON line in, then the reply. Current version: **1.8.1**. 1.1.0
added `mirror`; 1.2.0 added the binary mirror encoding, acks and the lease (see
`PLAN-mirror-forward.md`, §1.2); 1.3.0 changes only how mirror frames are captured (below), not the
protocol; 1.4.0 adds opt-in adaptive quality to binary mirror streams; 1.5.0 adds the `capture` and
`captureReason` fields; 1.6.0 adds VP8 video; 1.7.0 adds opt-in tap/swipe input; 1.8.0 paces VP8
frames and reports an idle screen (optional header fields only); 1.8.1 corrects the pacing rule; 1.10.0 adds JSON log output with cursor resume and the `stats` stream
(for the Device Monitor); 1.10.1 changes only the package's uninstall cleanup, not the protocol; 1.10.2 makes
an explicit `"lease":0` mean no lease for text mirror streams and ends log and stats streams when
Developer Mode goes off; 1.10.3 reports a hardware keypad in `ping` and accepts the `key` input. All additions are
capability-gated; older extensions continue to use the older view-only requests.

| Request | Reply |
|---|---|
| `{"cmd":"ping"}` | `{"ok":true,"version":"1.8.1","developerMode":true,"socket":"/run/user/100000/sailfish-devagent/agent.sock","mirrorEncodings":["text","binary","vp8"],"mirrorInput":["tap","swipe"],"logFormats":["text","json"],"stats":true}` (`mirrorInput` since 1.7.0; absence means view-only; `logFormats` and `stats` since 1.10.0, absence means text logs only and no stats stream). Since 1.10.3, a phone with a hardware keypad (an input device with `KEY_NUMERIC_STAR` and `KEY_PHONE`) and a model name in `/etc/hw-release` also gets `"key"` in `mirrorInput` and `"keypad":{"model":"Commodore Callback","keys":["0",…,"CALL","F21"]}` (the whitelisted keys that device really has); otherwise both are absent |
| `{"cmd":"screenshot"}` | `{"ok":true,"path":"/run/user/100000/sailfish-devagent/shot-<ts>.png"}` |
| `{"cmd":"logs","lines":100}` | Raw `journalctl` lines (`short-precise`), streamed until the client disconnects. Optional (1.10.0): `"format":"json"` streams `journalctl -o json` (one object per line, `__CURSOR` included) with a fixed `--output-fields` list when the installed `journalctl` accepts it (probed once at daemon start); `"after":"<cursor>"` resumes after that cursor (`--after-cursor`, else the last `lines`) and is ignored unless it matches `^[A-Za-z0-9;=:._-]{1,512}$`. Any other `format` is text. A phone-side stop ends the stream with `{"ok":false,"error":…}`. Reserved for later: `"filter":{"priority":0..7,"identifiers":[…],"pids":[…]}`. |
| `{"cmd":"stats","exe":"/usr/bin/harbour-demo","interval":1000}` | 1.10.0. Streamed: first `{"ok":true,"stream":"stats","interval":1000}`, then per interval `{"ts":…,"pid":4321,"state":"S","cpu":12.4,"rssKb":48216,"threads":9,"started":…,"sys":{"cpu":31.0,"load1":0.82,"memAvailableKb":812000}}` (`pid` 0 and no process fields when the app is not running; `cpu` is percent of one core and absent on the first sample of a pid), and `{"event":"start"|"exit","pid":…,"ts":…}` at pid transitions. The process is the lowest pid whose first command line argument equals `exe` (fallback: `comm` equals the base name cut to 15 characters). `exe` must match `^/[A-Za-z0-9._+/-]{1,255}$` without `..` (else `{"ok":false,"error":"invalid exe"}`); `interval` is clamped to 250..10000 ms (default 1000). Gated by Developer Mode only (reads `/proc`, no phone setting, no indicator); counted as `monitorStreams` in the Settings service status. |
| `{"cmd":"mirror","fps":4,"width":360,"quality":60}` | Streamed events (below). Optional fields: `"encoding":"binary"|"vp8"`, `"lease":<seconds>`, `"adapt":true`, `"bitrate":<kbit/s>`, `"input":true`. JPEG fps is 1..10; VP8 fps is 1..30. `width` is 0 (native) or 90..2160 and `quality` is 1..100. Values are clamped and the status echoes what is in effect. |
| anything else | `{"ok":false,"error":"unknown command"}` |

### Mirror stream

Lines, in order:

- First line, once: `{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60}` (effective values).
- Frame: `{"frame":12,"ts":…,"screen":[w,h],"size":[w,h],"format":"jpeg"|"png","data":"<base64>","capture":"native"}`
  (`capture` and `captureReason` since 1.5.0, see "Capture path" below).
- Unchanged screen: `{"frame":13,"ts":…,"same":true}`.
- Soft error: `{"frame":14,"ts":…,"error":"…"}`. The stream continues and the agent retries more
  slowly until a capture succeeds (for example while the screen is off).
- Fatal error, then the connection closes: `{"ok":false,"error":"developer mode is off"}`, also
  `"replaced"`, `"malformed request"`, `"session bus not available: …"`.

Binary encoding (1.2.0): a `mirror` request with `"encoding":"binary"` (the default is `"text"`, the
format above, which is what `--request mirror` and `sfdk device exec` use) still gets a text status
line first, so refusals look the same:
`{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60,"encoding":"binary","window":2,"lease":60}`.
After it come records until the connection closes: a 4-byte big-endian header length (2..4096), a JSON
header, and, for an image, exactly `bytes` raw image bytes (1..16 MiB, no base64). Image headers hold
`frame`, `ts`, `screen`, `size`, `format`, `bytes`, plus `cms` (capture time, ms) and `ems` (agent
time to scale and encode, ms). `{"frame":N,"ts":…,"same":true}`, `{"frame":N,"ts":…,"error":"…"}` and
the fatal `{"ok":false,"error":"replaced"}` or `"lease expired"` are records with a header and no
payload.

VP8 encoding (1.6.0): `"encoding":"vp8"` uses the same binary record framing, acknowledgements,
lease and adaptive controller. The status carries `"encoding":"vp8"`, `"window":4` and the target
`"bitrate"`. Frame headers use `"format":"vp8"`, plus `"key":true|false`, monotonic `"pts"`,
`"bytes"`, screen/encoded sizes and timing. The first frame, a requested key frame and a size
change are key frames (1.6.0 and 1.7.0 also sent one every 10 s; 1.8.0 does not, the link is
reliable and the client asks for one when it needs it). Encoded frames are never dropped; when the
link is behind, raw captures are dropped and the next capture is taken when the ack window has room.
`{"keyframe":true}` asks for recovery after a decoder reset. Text/sfdk fallback remains JPEG.

Frame pacing and the idle screen (1.8.0, VP8 only; older clients ignore the new fields): frames are
requested on a steady grid of slots anchored on their arrival, half a slot early, so the frame
interval stays even instead of following the compositor's timing. The slot is 1, 1.5, 2, 3 or 4
frame intervals (30, 20, 15, 10 or 7.5 fps at 30 fps; `src/pacer.h`, 1.8.1). It grows by one step
when the median convert + encode time of the last delta frames (at least 8, at most 15) stays over
110 % of the slot for 2 s, and shrinks by one step when it stays under 85 % of the shorter slot for
2 s; every 10 s at a longer slot it tries the shorter one while the median is under 125 % of it. The
samples start over after each change and the first second after the encoder opens does not count.
(1.8.0 grew at 85 %, jumped to the longest slot that fitted at once, and shrank only under 60 %.) Every VP8 header carries `"pace":<slot ms>`. When no new
frame came for 300 ms, the last picture is encoded again up to twice (`"refresh":true`, a normal
delta frame: the encoder sharpens what is shown), and then `{"frame":N,"ts":T,"same":true}` goes
out once a second while the screen stays still. Neither asks the compositor for a repaint.
Encoder settings: fixed real-time speed -6, single token partition, static threshold 100, half the
cores for libvpx (at most 3) and for the conversion (at most 4), rate-control buffer 200/300/500 ms.

Capture path (1.5.0): every image frame, binary header or text line, carries `"capture":"native"`
(the compositor recorder) or `"capture":"screenshot"` (the lipstick `saveScreenshot` fallback). A
screenshot frame also carries `"captureReason":"<reason>"`, plain text of at most 120 characters,
for example `"recorder unavailable: wayland connect failed"`; native frames omit it. The mirror's
journal line on start and on every switch states the path and reason (`mirror: capture path native`
or `mirror: capture path screenshot (<reason>)`). `same` and `error` records are unchanged. Older
extensions ignore the unknown fields; the rest of the protocol is byte for byte as in 1.4.0.

Upstream, the client sends JSON lines (at most 256 bytes; unknown or malformed lines are ignored):

- `{"ack":N}` (binary only): the client has received frame `N`. The agent sends at most `window`
  unacknowledged frames (2 for JPEG/PNG, 4 for VP8) and skips a capture while bytes are unsent or
  the window is full, so the frame rate follows what the link sustains and lag stays bounded.
- `{"keepalive":N}`: renews the lease. The agent answers `{"pong":N,"ts":<device ms>}` (a record in
  binary, a line in text), which the extension uses to estimate latency.
- `{"set":{"width":W,"quality":Q}}`: adaptive quality, below.
- `{"keyframe":true}`: asks a VP8 stream for a key frame; ignored by image streams.
- `{"input":{"type":"active","active":true|false}}`: renews or clears the 3 s input-focus
  lease. It does not renew the 60 s stream lease.
- `{"input":{"type":"tap","x":X,"y":Y}}` and
  `{"input":{"type":"swipe","x1":X1,"y1":Y1,"x2":X2,"y2":Y2,"duration":MS}}`: one-finger
  gestures in the current frame's real `screen` coordinates. Swipe duration is 50..2000 ms. They
  are ignored unless the request opted in, the status accepted input, the frame uses native capture,
  the controlled indicator is visible and the focus lease is active.
- `{"input":{"type":"key","key":K,"pressed":true|false}}` (1.10.3, only when `ping` lists `key`):
  press or release of one whitelisted keypad key the device has. A press passes the same checks as
  a gesture; a release is accepted at once, like `up`, so a key is never left held down.

Lease: in binary mode the lease is always on (`"lease":<seconds>`, clamped to 10..300, default 60).
In text mode it is on only when the request has a positive `lease` (`--request mirror --lease N`,
which also forwards stdin lines to the socket, so keepalives can travel over `sfdk device exec`);
`"lease":0` means no lease. If no valid
keepalive arrives within the lease, the agent sends the fatal `"lease expired"`, closes the stream
and cleans up. Without a lease, a text stream is byte for byte as in 1.1.0.

There is one mirror per agent: a new `mirror` request replaces the running one, and the older
connection receives `"replaced"` and is closed. The stream ends when the client disconnects.
Adaptive quality (1.4.0, binary streams only; VP8 bitrate support in 1.6.0): a `mirror` request with `"adapt":true` gets
`"adapt":true` in its status line. Each image header then also carries `q` (the JPEG quality it was
encoded with; omitted for PNG), `ticks` and `skips` (cumulative: ticks of the frame timer, and those
skipped because bytes were still unsent or the ack window was full) and, after the first ack, `rtt`
and `rttFrame` (the time in ms from writing that image to receiving its ack). The client may send
`{"set":{"width":W,"quality":Q}}` lines upstream for JPEG, or
`{"set":{"width":W,"bitrate":K}}` for VP8. The agent applies them from the next frame, clamped
to the requested ceilings, and sends the next frame even if the screen
is unchanged. The frame rate is never changed. The client decides (the VS Code extension runs the
controller); without `"adapt"` the stream is byte for byte as in 1.3.0, and `set` lines are ignored.

Interactive input (1.7.0) is requested with `"input":true` (or client option `--input`). A successful
status adds `"input":true,"inputLease":3`; refusal adds `"input":false,"inputError":"…"` and the
stream continues view-only. The agent discovers a writable direct touchscreen under
`/dev/input/event*`, validates its evdev capabilities and axis ranges, and maps native recorder
pixels directly to the touchscreen's fixed panel axes. It refuses input for screenshot fallback
because Lipstick rotates saved screenshots by a top-window angle it does not expose. It also refuses
a detectable swapped-axis transform instead of guessing. Type B multitouch injection selects a free
slot so it does not collide with a real finger; legacy ABS axes use their own ranges. Release is
coordinate-independent, including lease expiry and cleanup. The rolling input limit is 20 message
attempts per second, with immediate `active:false` as an unlimited safety-off. This path is built and
unit/integration-fixture tested, but injection and rotation still require confirmation on a real
phone; the emulator follows the host pointer and is not conclusive.

From 1.3.0, mirror frames come from
Lipstick's private Wayland recorder interface (`lipstick_recorder`, protocol file in `protocol/`,
copied from the lipstick tree): one Wayland connection and one shared buffer per stream, a frame in
about 20–40 ms on the emulator, and no "Screenshot captured." notice per frame. The agent connects to
`/run/display/wayland-0` (or `$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY` when set); lipstick lets only
clients whose primary group is `privileged` bind the recorder. If the recorder is missing or
refused (an older lipstick, another frame format), the stream falls back to the same lipstick call
as `screenshot`, which posts a notice per frame; the journal says which path a stream uses
(`mirror: native capture 720x1600` or `mirror: native capture unavailable (…)`). Without a JPEG
writer, native frames are sent as PNG at the requested width.

Known limitations: the JPEG image plugin package for Sailfish is not identified, so
the RPM has no `Requires:` for it. If the JPEG writer is missing on the device, the agent sends
unscaled PNG frames (`"format":"png"`, `size` equal to `screen`), which are much larger. Frame
rate, CPU cost and transfer speed have been measured on the emulator only (native capture: about 4
frames per second at the default rate, a frame in about 20–40 ms); nothing is measured on a phone
yet, including whether the service can bind the recorder there.

Lipstick only writes screenshots under the user's home directory and rejects hidden path
components, so the agent stages the file in `~/sailfish-devagent/` and moves it to its runtime
folder (`/run/user/<uid>/sailfish-devagent/shot-<ms>.png`, the path in the reply). The extension fetches it with
`sfdk device exec -- base64 <path>` over a connection without a terminal, then deletes it.

## What is not verified yet

- Agent 1.10.0 `logs` JSON output and `stats` run only against fixtures and the unit tests
  (`make -C device-agent/tools test`); nothing has run on the emulator or a phone.
- `journalctl --output-fields` is probed at daemon start; whether the systemd of Sailfish OS 5.1
  accepts it is not confirmed.
- The `stats` process match (first command line argument equal to `exe`, `comm` fallback) is not
  checked for apps started through `invoker` on a device.
