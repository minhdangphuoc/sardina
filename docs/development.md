# Development


Node.js 22 or newer is required.

```sh
npm ci
npm run build          # bundle dist/extension.js with esbuild
npm run check:types
npm run lint
npm run test:unit
npm run test:fuzz
npm run test           # unit, fuzz and integration tests (opens a VS Code test window)
npm run verify         # everything above, plus manifest checks and a packaging dry run
```

To try changes without packaging, run `npm run build` (or `npm run build:watch`)
and then `code --extensionDevelopmentPath=$PWD <your-project>`. There is no
`.vscode/launch.json`, so **F5** does not work out of the box.

The device agent is a separate Qt program in `device-agent/`.
`sh device-agent/build.sh` builds its RPMs for all three architectures with the
SDK and copies them to `media/agent/`; see
[`device-agent/README.md`](../device-agent/README.md) for its build needs and
protocol.

`make -C device-agent/tools emulator-test` is an opt-in end-to-end test on the
SDK emulator (VirtualBox VM `SailfishOS-5.1.0.11`, or `VM=<name>`; `HEADLESS=1`
for no window). It takes a snapshot, starts the VM, installs the RPMs from
`media/agent/i486`, stress-tests the phone's touch indicator (sessions, killed
sessions, clipboard changes, rotation, lock and display off, keyboard, taps and
swipes) and then removes one module and the whole agent, printing PASS or FAIL
per case. It always restores and deletes the snapshot and powers the VM off. It
needs Docker (to build two small helpers), `npm ci` and the SDK's SSH key in
`~/SailfishOS/vmshare`. It is not part of `npm run verify` or CI.

See [`CONVENTIONS.md`](../CONVENTIONS.md) for the module layout, stub APIs, and how tests stub UI
prompts and use the fake `sfdk` binary.

