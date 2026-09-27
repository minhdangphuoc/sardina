# default scenario

All-success baseline (`happy` is an alias of this scenario). Every file here
is `reconstructed: synthesized from TRD [V] grammar (FR-16.3 flat target
list, FR-16.4 `#N "Name"` device/emulator entries, FR-16.6 engine/emulator
"running" status text)`. No file in this directory was copied from real SDK
output or documentation; shapes are hand-written to match the grammar the
TRD verified against a live sfdk, not the literal bytes.

- version.stdout: reconstructed: FR-17.3 (`sdk-release` contains `3.13.5`)
- tools_list.stdout: reconstructed: FR-16.3 note (tree of toolings; NOT used by parsers)
- tools_target_list.stdout: reconstructed: FR-16.3 sample line
- init_list.stdout: reconstructed: FR-16.5 [U] shape
- init_template.stdout: reconstructed: synthesized
- config_show.stdout, config_set.stdout, config_set_global.stdout: reconstructed: FR-16.7 [U] shape
- engine_status.stdout, emulator_status.stdout: reconstructed: FR-16.6 [U] ("running" token)
- engine_start.stdout, engine_stop.stdout: reconstructed: synthesized
- engine_exec.pwd.stdout: reconstructed: synthesized (engine-side path convention from build-fails-compile)
- qmake.stdout, make.stdout, build.stdout, deploy.stdout, package.stdout, build-shell.stdout: reconstructed: synthesized
- check.stdout: reconstructed: synthesized `$sailfish-rpmvalidator` INFO-line shape (TRD §4.5), added for Task D's FR-5.6 `check` task (S12)
- emulator_list.stdout, device_list.stdout: reconstructed: FR-16.4 [V] entry grammar
  (emulator_list.stdout is a superset: entry #2 carries `flags: available` since
  the fake maps `emulator list` and `emulator list -a` to the same key — Task E's
  tree filters on that flag instead of on the argv)
- emulator_show.stdout: reconstructed: FR-16.7 [U] key/value shape
- emulator_install.stdout: reconstructed: synthesized (FR-6.4 installAvailable)
- device_exec*.stdout: reconstructed: synthesized
