Hand-written from PLAN-device-monitor §9.2, then corrected against the emulator recordings in
`recorded/` (M-11, Sailfish OS 5.1.0.11, agent 1.10.0; see `recorded/PROVENANCE.md`):

- `…logs.stdout`: no status line before the JSON entries; every line has `_BOOT_ID`. The app's
  lines (pid 4321) look like `recorded/journal-json-app.jsonl`: `_TRANSPORT` `journal`,
  `SYSLOG_IDENTIFIER` an empty string, no `SYSLOG_PID`, `_EXE` the booster
  (`/usr/libexec/mapplauncherd/booster-silica-qt5`), the `[D|W|C] func:line - ` message prefix,
  `CODE_FILE` a `file://` URL for QML lines and `unknown` for C++ ones. Priorities as recorded:
  console.log 7, qWarning / console.warn / ReferenceError 4, console.error 2. The ReferenceError
  names `qml/harbour-demo.qml:12`. The other processes' lines and the coredump line are unchanged.
- `…stats.stdout`: the status line with the recorded key order, a `start` event before the first
  sample, no `cpu` in the first sample of a pid and no `sys.cpu` on the very first tick, `started`
  earlier than the `start` event (it is the booster's start for an invoker app), an `exit` event
  followed by a `pid:0` tick, then `start` of pid 4322.
