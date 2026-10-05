# sailfish-devagent

A small developer agent for Sailfish OS devices, in the same spirit as Android's `adbd`. The user
grants permission once, when installing it; after that VS Code can take screenshots and read the
system log, and show a live view of the screen, without asking for the developer-mode password each time. It only serves while Developer
Mode is on.

It is plain Qt (`core`, `dbus`, `network`), with no Silica. One binary has two modes:

- `sailfish-devagent --daemon` is the systemd service.
- `sailfish-devagent --request <cmd>` is the client. It connects to the daemon's socket, sends the
  request and copies the reply to stdout. The extension runs it through `sfdk device exec`.

## Building the RPMs

Needs the Sailfish SDK with the `SailfishOS-5.1.0.11` targets for `aarch64`, `armv7hl` and `i486`.

```sh
device-agent/build.sh
```

For each architecture the script runs `sfdk -c target=SailfishOS-5.1.0.11-<arch> -c no-fix-version
build` (without `no-fix-version`, sfdk stamps the repository's git tag as the package version),
cleans the tree between architectures, and copies the result to
`media/agent/<arch>/sailfish-devagent-<version>-<release>.<arch>.rpm`. Set `SFDK` to use an sfdk
other than `~/SailfishOS/bin/sfdk`. The RPMs are unsigned and are shipped inside the VSIX; rebuild
them by hand whenever the agent changes.

## Security model

- Runs as `defaultuser`, not root, with two **extra** groups: `privileged` (set as the primary group
  with `Group=`, so lipstick accepts its screenshot call) and `systemd-journal` (to read the
  journal). systemd also gives the process `defaultuser`'s normal groups, including `input`, so as
  installed it could write to input devices; Phase 1 has no command that does.
  The `SupplementaryGroups=privileged`-only variant has not been tested.
- Listens on a Unix socket only (`/run/user/100000/sailfish-devagent/agent.sock`, mode 0600, owned
  by `defaultuser`). There is no TCP or UDP listener; the only way in is the SSH login VS Code
  already has.
- On every request it checks that Developer Mode is on (`jolla-developer-mode` installed,
  `/usr/bin/devel-su` present) and refuses otherwise.
- Accepts a fixed set of commands with validated arguments. Nothing is passed to a shell.
- Removable: `rpm -e sailfish-devagent` (or **Uninstall Device Agent** in VS Code) removes the
  package, the unit and the socket.

## Protocol

One request per connection: one JSON line in, then the reply. Current version: **1.1.0**, which
adds `mirror`. `ping`, `screenshot` and `logs` are unchanged from 1.0.0.

| Request | Reply |
|---|---|
| `{"cmd":"ping"}` | `{"ok":true,"version":"1.0.0","developerMode":true}` |
| `{"cmd":"screenshot"}` | `{"ok":true,"path":"/run/user/100000/sailfish-devagent/shot-<ts>.png"}` |
| `{"cmd":"logs","lines":100}` | Raw `journalctl` lines, streamed until the client disconnects. |
| `{"cmd":"mirror","fps":4,"width":360,"quality":60}` | Streamed, one JSON line per event (below). `fps` 1..10, `width` 0 (native) or 90..2160, `quality` 1..100; out-of-range values are clamped, not refused, and the first line echoes the values in effect. |
| anything else | `{"ok":false,"error":"unknown command"}` |

### Mirror stream

Lines, in order:

- First line, once: `{"ok":true,"stream":"mirror","fps":4,"width":360,"quality":60}` (effective values).
- Frame: `{"frame":12,"ts":…,"screen":[w,h],"size":[w,h],"format":"jpeg"|"png","data":"<base64>"}`.
- Unchanged screen: `{"frame":13,"ts":…,"same":true}`.
- Soft error: `{"frame":14,"ts":…,"error":"…"}`. The stream continues and the agent retries more
  slowly until a capture succeeds (for example while the screen is off).
- Fatal error, then the connection closes: `{"ok":false,"error":"developer mode is off"}`, also
  `"replaced"`, `"malformed request"`, `"session bus not available: …"`.

There is one mirror per agent: a new `mirror` request replaces the running one, and the older
connection receives `"replaced"` and is closed. The stream ends when the client disconnects.
View only: the agent accepts no input in this version. Frames are captured with the same lipstick
call as `screenshot`.

Known limitations (not measured): the JPEG image plugin package for Sailfish is not identified, so
the RPM has no `Requires:` for it. If the JPEG writer is missing on the device, the agent sends
unscaled PNG frames (`"format":"png"`, `size` equal to `screen`), which are much larger. Frame
rate, CPU cost and transfer speed have not been measured on any device.

Lipstick only writes screenshots under the user's home directory and rejects hidden path
components, so the agent stages the file in `~/sailfish-devagent/` and moves it to its runtime
folder (`/run/user/<uid>/sailfish-devagent/shot-<ms>.png`, the path in the reply). The extension fetches it with
`sfdk device exec -- base64 <path>` over a connection without a terminal, then deletes it.
