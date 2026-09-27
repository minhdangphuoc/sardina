# Sailfish OS Tools

A VS Code extension for building, deploying, running and managing Sailfish OS
applications: SDK detection, build targets, devices/emulators, build/deploy/run
tasks, project scaffolding and a getting-started walkthrough.

## Requirements

- Sailfish SDK **3.10+**. Developed and tested against SDK **3.13.x**.
- [Qt QML](https://marketplace.visualstudio.com/items?itemName=theqtcompany.qt-qml)
  extension recommended for QML language support (this extension will suggest
  installing it, once, if it's missing). It is not a hard dependency: this
  extension still activates and works without it.
- macOS or Linux. **Windows support is deferred** (tracked for a later release);
  the `sailfish.experimental.enableWindows` setting exists only as a placeholder
  for that future work and does nothing in v0.1.

## What this is not (yet)

- **Silica IntelliSense is not implemented in v0.1.** Rich completion, hover and
  diagnostics for Sailfish Silica QML APIs is planned for v0.2; it will read
  the build target already installed locally on your machine, and Silica's
  own type/property/API data is never bundled with this extension. v0.1
  instead disables Qt QML's `qmlls` language server
  (`qt-qml.qmlls.enabled`) per Sailfish project folder, because qmlls requires
  Qt 6.8+ while Sailfish OS build targets ship Qt 5.6, so qmlls only produces
  spurious diagnostics against Silica QML (`sailfish.qtqml.silenceQmlls`).

## Telemetry

**None.** This extension does not collect, transmit or report any usage data,
crash data or telemetry of any kind.

## Publisher

The `publisher` field in `package.json` (`sailfish-tools-dev`) is a
**placeholder**. The repository owner should set this to their real Marketplace
publisher id before any public release.

## Development

```sh
npm install
npm run build        # bundle dist/extension.js with esbuild
npm run check:types
npm run lint
npm run test
```

See `CONVENTIONS.md` for the full module layout, stub APIs, naming
reconciliation and how tests stub UI prompts and the fake `sfdk` binary.

## License

MIT — see `LICENSE`.
