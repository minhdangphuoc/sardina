# Captured: Sailfish SDK 3.13.5 (SailfishOS-5.1.0.11 emulator), Linux, VirtualBox engine

Captured verbatim from a real `sfdk --no-pager` with `LC_ALL=C` and the
emulator running, on 2026-10-02. Unlike `../../scenarios/*`, nothing here
is reconstructed.

- emulator_list.stdout: `sfdk emulator list`, a `<name>  <flags>` table
  (not the `#N "Name"` records `device list` prints)
- emulator_list_a.stdout: `sfdk emulator list -a`
- device_list.stdout: `sfdk device list`. An earlier run, right after the
  emulator first started, also printed a `[D] SOFT ASSERT:
  "!m_deviceModels.isEmpty()"` debug line ahead of the records.
- debug_dry_run_args.stdout: `sfdk -c target=SailfishOS-5.1.0.11-aarch64
  -c "device=Jolla Phone 2026" debug --dry-run --args
  /usr/bin/harbour-vscsmoke "it's a" b` (all on stdout; the argument shows
  sfdk's shell quoting)
- libsfdk_devices.xml: `~/.config/SailfishSDK/libsfdk/devices.xml` as last
  written by sfdk, with the 5.1.0.11 emulator (Device.0, autodetected, has
  `EmulatorUri`) and the Jolla Phone (2026) (Device.1, user-defined). Nested
  layout: `<data><variable>Device.N</variable><valuemap>` with keys sorted.
- engine_devices.xml: the build engine's own device list,
  `~/SailfishOS/vmshare/devices.xml`; the phone's `type="real"` entry was
  added by hand in the same format Qt Creator's device dialog writes.
