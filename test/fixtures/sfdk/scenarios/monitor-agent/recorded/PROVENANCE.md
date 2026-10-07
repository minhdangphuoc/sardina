# Recorded on the SDK emulator (M-11, 2026-10-07)

Raw recordings from "SailfishOS-5.1.0.11" (Sailfish OS 5.1.0.11 Pispala, i486, systemd 238,
BusyBox procps) with `sailfish-devagent-1.10.0-1.i486.rpm` (built from `wt/a1`) and a
`harbour-demo` build that logs one line of each kind (`qDebug`, `qWarning`, `console.log`,
`console.warn`, `console.error`, and a `ReferenceError` at `qml/harbour-demo.qml:15`).
The app was started as `defaultuser` with
`invoker --type=silica-qt5 /usr/bin/harbour-demo` and `XDG_RUNTIME_DIR=/run/user/100000
WAYLAND_DISPLAY=../../display/wayland-0`. All commands ran over
`ssh -p 2223 … 127.0.0.1`. These files are evidence, not replay keys: the replay fixtures in
the parent directory were not changed. A trailing `rc=N` line is the shell's exit code.

| File | Command (user) |
|---|---|
| `os-release.txt` | `cat /etc/os-release` (defaultuser) |
| `ssh-connection.txt` | `printenv SSH_CONNECTION` (defaultuser) |
| `ip-o-4-addr.txt` | `/usr/sbin/ip -o -4 addr` (defaultuser; `ip` is not on defaultuser's `PATH`) |
| `rpm-q-rpm.txt` | `rpm -q rpm` |
| `journalctl-version.txt` | `journalctl --version` |
| `output-fields-check.txt` | `journalctl --no-pager --output-fields=MESSAGE -n 0` (root; accepted, rc 0). As plain defaultuser without `systemd-journal` the journal cannot be read at all |
| `journal-json-n50.jsonl` | `journalctl --no-pager -o json -n 50` (root) right after the app started; contains the six app lines |
| `journal-json-app.jsonl` | `journalctl --no-pager -o json _COMM=harbour-demo -n 50` (root): the app's six lines only |
| `pgrep-cmdline.txt` | busybox `pgrep -x -f /usr/bin/harbour-demo` (finds nothing), `/proc/<pid>/cmdline` of the app, its `invoker` and the probing shell |
| `agent-logs-json-lines5.txt` | `sleep 4 \| sailfish-devagent --request logs --format json --lines 5` |
| `agent-logs-json-after.txt` | same with `--after <cursor of line 3 of the previous file>` |
| `agent-logs-json-bad-cursor.txt` | same with `--after 's=bogus;i=1;b=x'` |
| `agent-logs-json-logs-off.txt` | JSON stream, then `SetBool logs false` over D-Bus: ends with the refusal line |
| `stats-stream.jsonl` | `sleep 16 \| sailfish-devagent --request stats --exe /usr/bin/harbour-demo --interval 1000`, app killed at ts …000354 and relaunched at …004534 |
| `t4-5-top.txt` | byte counts and busybox `top -b -n 3 -d 3` during a `logger` loop (~32 lines/s), a JSON log stream and a 1 s stats stream |

The client ends a stream when its stdin reaches EOF, so every stream request was fed by
`sleep N |`.
