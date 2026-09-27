# run-stop
reconstructed: synthesized. `device_exec.invoker.hang` is a marker file
(content ignored) scoped to the exact `device_exec.invoker` key only (not
the `device_exec` base key `hang/` uses) so only the run task's launch step
hangs — its own pre-launch pkill step and the stop-triggered remote pkill
both still resolve instantly from `default/`'s fixtures. All other output
falls back to `default/`. Used to exercise M1.23 (stopping a run task sends
a remote pkill) without the multi-second waits `slow/` would add.
