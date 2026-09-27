# emulator-vbox-missing
reconstructed: synthesized VBoxManage-absent transcript, for Task E's
VirtualBox-correlation fail-soft path (VBoxManage probe never throws).
`emulator_list` also fails here (VBoxManage COM error, exit 1) for M1.24: the
Emulators root must render "Could not list" with VirtualBox guidance while
`device_list`/`build` still fall back to `default/`'s success fixtures.
`emulator_install` fails here (exit 1) for S12's failure-notification case.
