# Sailfish OS Tools

Build, run and debug Sailfish OS apps from VS Code, on the emulator or on a
phone, with one click.

> **Independent project.** This is a personal hobby project. It is not
> affiliated with, endorsed by or made for Jolla or any other company.
> Sailfish OS is a trademark of Jolla; the name is used here only to say which
> platform the extension works with.

## What you get

- Finds your Sailfish SDK and shows its build targets, build engine and devices
  in the sidebar.
- **Build**, **Deploy**, **Run** and **Debug** buttons in the status bar.
- C++ debugging on the device with `gdbserver`.
- Emulator control, and **Add Device** for phones in a few prompts.
- Package signing set-up with your GPG key.
- Screenshots, a live system log and a screen mirror you can tap and swipe,
  through an optional helper on the phone (the device agent).
- A Device Monitor tab per device: connection, app stats and crash detection.
- Silica QML snippets and VS Code tasks for build, package and validate.
- No telemetry of any kind.

More in [Features](docs/features.md).

## Quick start

1. Install [VirtualBox](https://www.virtualbox.org/wiki/Downloads) first, then
   the [Sailfish SDK](https://docs.sailfishos.org/Tools/Sailfish_SDK/Installation/)
   (3.10 or newer; about 15 GB, 4 GB of memory). VS Code 1.94 or newer, Linux
   or macOS.
2. Install the extension from its `.vsix` file (see [Setup](docs/setup.md),
   Part 3).
3. Open a Sailfish project folder, or run **New Project**.
4. Pick a build target and a device in the status bar.
5. Click **Run** (Ctrl+Alt+R) or **Debug**.

## Documentation

- [Features](docs/features.md): everything the extension does.
- [Setup](docs/setup.md): step by step, from VirtualBox to signing.
- [Device agent](docs/device-agent.md): screenshots, logs, screen mirror, and
  how it stays safe.
- [Device Monitor](docs/device-monitor.md): the per-device tab.
- [Troubleshooting](docs/troubleshooting.md): common errors and known issues.
- [Architecture](docs/architecture.md): how the extension is built.
- [Development](docs/development.md): build from source and run the tests.
- [Changelog](CHANGELOG.md)

## Status

Version 0.1.11. Linux and macOS; Windows is not supported. Not on the
Marketplace yet.

## Not there yet

- Silica QML IntelliSense, planned for 0.1.12.
- QML and JavaScript debugging, planned for 0.1.13 (only C++ today).
- Profiling (CPU, memory, QML), planned for a later version.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

## Publisher

The `publisher` id (`sailfish-tools-dev`) is a placeholder and does not stand
for Jolla or any company.
