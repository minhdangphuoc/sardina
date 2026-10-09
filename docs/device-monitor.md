# Device Monitor


The Device Monitor is one narrow tab per device that shows whether the phone
or emulator is reachable and how your app is doing. It is a single column, so
it fits beside the editor.

1. **Open it.** **Ctrl+Shift+P** → **Sardina: Open Device Monitor**, or use
   the device's context menu in the Devices view, or the link in the device's
   status bar tooltip. Pressing **Debug** opens it beside the editor without
   taking focus; turn that off with `sardina.debug.openDeviceMonitor`.
   Opening a second time shows the tab that is already open.
2. **What it shows.**
   - **Connection:** a dot with **Connected** or **Offline**, then
     `Wi-Fi · aarch64 · OS 5.1.0.11 · agent 1.10.0` (connection, architecture,
     OS version, agent version).
   - **App:** the launched app's name, process id and mode, CPU and memory with
     a small line graph each, and `up m:ss · restarts N · crashes N`, live
     while it runs. With agent 1.10.0 it updates every second; without it,
     every 5 seconds through `sfdk`. When the app is not running the card says
     `<app> not running`.
   - **Actions** are icon buttons in the tab's title bar, not in the page:
     Restart app and Stop app (only while the app runs), Screenshot, Mirror and
     Show logs, which streams the device log into the **Sardina Device Log**
     output channel ([device agent](device-agent.md), step 4). They act on the monitor's device. The
     monitor has no log view and no session list of its own; the status bar
     tooltip and the Devices view list what runs on the device.
3. **Settings.** `sardina.monitor.pollIntervalSeconds` (5, the poll interval
   without a stats stream) and `sardina.monitor.logLines` (500, the initial
   tail of Show Device Logs).
4. **The phone decides.** If the phone turned system logs off in Settings →
   System → Developer agent, Show logs says so. Changing the selected device
   stops the monitor's stats stream and the log stream; the tab stays open and
   offers **Resume**. An unreachable device shows **Offline** with **Retry**.

