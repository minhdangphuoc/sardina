# hang
reconstructed: synthesized. `build.hang` / `device_exec.hang` are marker
files (content ignored); output falls back to `default/build.stdout` and
`default/device_exec.stdout`, after which the fake keeps its event loop
alive (non-unref'd) until SIGTERM/SIGINT, to exercise SfdkRunner
cancellation/timeout kill paths.
